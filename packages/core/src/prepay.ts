import { ChainReader, checkMarketRate, creditsAtPrice, ixDisc, LAUNCH_PROGRAM_ID, launchBundleTxs, launchPdas, linePerUsdAt, marketRate, parsePrepayConfig, usdToBase, type AgentLaunch, type PrepayConfig, type Rpc } from "@units/chain";
import type { Core } from "./core.ts";
import { bad } from "./errors.ts";
import { ACC } from "./ledger.ts";
import { USD_MAX_AGE_S } from "./revenue.ts";

// Prepaid credits at launch (plan C, owner decision 2026-10-09). A launch carries a deposit into the
// agent's compute vault and the permissionless refresh_awake in the same transaction, so the agent
// starts working at once. The minimum is `prepay.min_usd` in the network config (admin-editable,
// converted at `prepay.line_per_usd`, a TEST rate on devnet). units_launch does not enforce it
// (no program change), so the wallet and Core do:
//   - simulated mode: POST /v1/admin/launches with `deposit` below the minimum is refused;
//   - chain mode: for every launch created at or after `prepay.since` Core reads the launch
//     transaction once, records its deposit, and an agent whose deposit fell short stays asleep in
//     Core until its compute vault holds at least the minimum (its effective wake threshold is
//     max(wake_threshold, minimum)). Core refuses an asleep agent's commits, and hosted workers check
//     Core before any model spend.
//
// The rate (owner 2026-10-12). `prepay.rate_source` absent or "config": the static `line_per_usd`, as
// above. "market" (the official deployment, where $UNITS is a pump.fun coin whose price moves): the
// minimum is `min_usd` at the coin's live market price, the indexer's reading (GET /market/quote-usd)
// that Core copies on each indexer sync (revenue.ts). Core keeps those readings in `prepay_rates` for a
// day. A landed launch's deposit carries `min_usd` when deposit x price >= min_usd x (1 - tolerance)
// at SOME price Core holds within `rate_window_s` of the launch's time (the highest one decides: it
// asks the least), each price held inside the band [rate_min_usd, rate_max_usd]. With no reading for
// that window the launch is recorded ok and PENDING, never underfunded on a guess, and checked again
// when a reading for its time arrives (the next sync, or the indexer's stored sample for that time,
// GET /market/quote-usd?at=). The row keeps what the decision used (price, when it was read, the
// minimum at that price, tolerance, window), and the wake rule of an underfunded agent uses the row's
// stored minimum, never a later price.

/** How long after its creation a launch that shows no deposit is read again instead of recorded (its credits transaction may still be landing). */
export const SETTLE_S = 120;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS prepay (
  agent_id TEXT PRIMARY KEY,
  mint TEXT,
  launched_at INTEGER,
  signature TEXT,
  deposit TEXT NOT NULL,
  min TEXT NOT NULL,
  ok INTEGER NOT NULL,
  woke INTEGER NOT NULL,
  source TEXT NOT NULL,
  checked_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS prepay_rates (
  read_at INTEGER PRIMARY KEY,   -- when the indexer read the price (unix seconds)
  usd REAL NOT NULL,             -- USD per whole quote coin
  seen_at INTEGER NOT NULL,      -- when Core received it (unix seconds)
  source TEXT NOT NULL           -- sync: the indexer's current reading at a sync; sample: its stored sample for a launch's time
);
CREATE TABLE IF NOT EXISTS prepay_admin (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  patch TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);`;

// Launch fronting (docs/plans/LAUNCH-FRONTING.md, owner decision 2026-10-10): the launcher fronts the
// token creation cost, the prepaid credits (required: exactly `min_usd`, which equals `default_usd`)
// and an initial buy of `initial_buy_bps` of the supply delivered to the agent's treasury. The admin
// edits the amounts with POST /v1/admin/launch-fronting; the patch is stored here and applied over the
// config file's prepay block, so GET /v1/config serves the effective values.
// "A units account" (owner direction 2026-10-11): its price in lamports and the recipient of the payment are edited the same way.
const FRONTING_KEYS = ["credits_usd", "initial_buy_bps", "initial_buy_slippage_bps", "units_purchase_slippage_bps", "identity_account_price_lamports", "identity_account_recipient"] as const;

interface Internals {
  db: Core["db"];
  cfg: Core["cfg"];
  ledger: Core["ledger"];
  now(): number;
  emitEvent(type: string, data: unknown): void;
  tx<T>(fn: () => T): T;
}

export interface PrepayRow {
  agent_id: string;
  mint: string | null;
  launched_at: number | null;
  signature: string | null;
  deposit: string;
  min: string;
  ok: number;
  woke: number;
  source: "chain" | "sim";
  checked_at: number;
  initial_buy: string | null;
  supply: string | null;
  /** market rate only. market: judged at `rate_usd`; pending: no reading for the launch's time yet (ok until one exists). Null: the configured rate. */
  rate_state: "market" | "pending" | null;
  /** USD per whole coin the decision used (inside the band), and when the indexer read it */
  rate_usd: number | null;
  rate_read_at: number | null;
  /** min_usd in base units at `rate_usd`, before the tolerance (`min` is after it: the smallest accepted deposit) */
  rate_min: string | null;
  rate_tolerance_bps: number | null;
  rate_window_s: number | null;
  /** the launch's time the window was taken around (unix seconds) */
  rate_at: number | null;
  /** sync: one of Core's own readings; sample: the indexer's stored sample for that time; current: Core's current reading (simulated launches) */
  rate_from: string | null;
}

/** The market rate as Core holds it now (GET /v1/config and /v1/launch-fronting `rate`). */
export interface RateView {
  source: "market";
  usd_per_token: number | null;
  read_at: number | null;
  age_s: number | null;
  max_age_s: number;
  ok: boolean;
  reason: string | null;
}
type Reading = { read_at: number; usd: number; from: string };
/** Core keeps its readings this long, and asks the indexer for a pending launch's sample for this long. */
const RATES_KEPT_S = 86_400;

const instances = new WeakMap<Core, Prepay>();
export function prepayOf(core: Core): Prepay {
  let p = instances.get(core);
  if (!p) {
    p = new Prepay(core);
    // first use inside a transaction (a simulated launch): a rollback would take the tables just created with it, so the
    // instance is kept only once they are committed, and the next call makes them again
    if (!(core as unknown as Internals).db.inTransaction) instances.set(core, p);
  }
  return p;
}

const REFRESH = ixDisc("refresh_awake");

export class Prepay {
  private readonly c: Internals;
  /** launch transactions that could not be read yet (retried next sync) */
  private misses = new Map<string, number>();
  /** why the indexer's last sync carried no price (market rate), for `rate().reason` */
  private noReading: string | null = null;
  constructor(core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(SCHEMA);
    // the initial buy a launch delivered to the agent key (launch fronting); added after plan C
    const cols = this.c.db.query<{ name: string }, []>("PRAGMA table_info(prepay)").all().map((r) => r.name);
    if (!cols.includes("initial_buy")) this.c.db.exec("ALTER TABLE prepay ADD COLUMN initial_buy TEXT");
    if (!cols.includes("supply")) this.c.db.exec("ALTER TABLE prepay ADD COLUMN supply TEXT");
    // what a market rate decision used (owner 2026-10-12); null on rows judged at the configured rate
    for (const [name, type] of [["rate_state", "TEXT"], ["rate_usd", "REAL"], ["rate_read_at", "INTEGER"], ["rate_min", "TEXT"], ["rate_tolerance_bps", "INTEGER"], ["rate_window_s", "INTEGER"],
      ["rate_at", "INTEGER"], ["rate_from", "TEXT"]] as const)
      if (!cols.includes(name)) this.c.db.exec(`ALTER TABLE prepay ADD COLUMN ${name} ${type}`);
    this.applyAdmin();
  }

  /** Applies the stored admin patch over the config file's prepay block (in place, so /v1/config serves it). */
  private applyAdmin() {
    const p = this.config();
    if (!p) return;
    const row = this.c.db.query<{ patch: string }, []>("SELECT patch FROM prepay_admin WHERE id = 1").get();
    if (!row) return;
    const patch = JSON.parse(row.patch) as Partial<Record<(typeof FRONTING_KEYS)[number], string | number>>;
    const next = { ...p };
    if (typeof patch.credits_usd === "string") next.min_usd = next.default_usd = patch.credits_usd;
    if (typeof patch.initial_buy_bps === "number") next.initial_buy_bps = patch.initial_buy_bps;
    if (typeof patch.initial_buy_slippage_bps === "number") next.initial_buy_slippage_bps = patch.initial_buy_slippage_bps;
    if (typeof patch.units_purchase_slippage_bps === "number") next.units_purchase_slippage_bps = patch.units_purchase_slippage_bps;
    if (typeof patch.identity_account_price_lamports === "string") next.identity_account_price_lamports = patch.identity_account_price_lamports;
    if (typeof patch.identity_account_recipient === "string") next.identity_account_recipient = patch.identity_account_recipient;
    (this.c.cfg as { prepay?: PrepayConfig | null }).prepay = parsePrepayConfig(next);
  }

  /** GET /v1/launch-fronting: the three things a launcher fronts, as configured now. */
  frontingView() {
    const p = this.config();
    if (!p) return { configured: false };
    const row = this.c.db.query<{ patch: string; updated_at: number }, []>("SELECT patch, updated_at FROM prepay_admin WHERE id = 1").get();
    const rate = this.rate();
    return {
      configured: true,
      token_creation: "paid by the launcher: rent and network fees, shown exactly from the launch simulation",
      credits_usd: p.min_usd,
      credits_required: true,
      // market rate: the current figures from Core's latest reading, null (with rate.reason) when it has none
      credits_base_units: rate ? (this.minBase()?.toString() ?? null) : this.minBase()!.toString(),
      line_per_usd: rate ? (rate.ok ? linePerUsdAt(rate.usd_per_token!) : null) : p.line_per_usd,
      ...(rate ? { rate_source: "market", rate, line_per_usd_config: p.line_per_usd, rate_tolerance_bps: marketRate(p)!.toleranceBps, rate_window_s: marketRate(p)!.windowS } : {}),
      rate_status: p.rate_status,
      initial_buy_bps: p.initial_buy_bps,
      initial_buy_slippage_bps: p.initial_buy_slippage_bps,
      units_purchase_slippage_bps: p.units_purchase_slippage_bps,
      identity_account_price_lamports: p.identity_account_price_lamports,
      identity_account_recipient: p.identity_account_recipient,
      admin_patch: row ? JSON.parse(row.patch) : null,
      updated_at: row?.updated_at ?? null,
    };
  }

  /** POST /v1/admin/launch-fronting { credits_usd?, initial_buy_bps?, initial_buy_slippage_bps?, units_purchase_slippage_bps? } */
  setFronting(body: unknown) {
    const p = this.config();
    if (!p) throw bad("no_prepay_config", "this Core has no prepay block in its network config");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("bad_fronting", "a JSON object expected");
    const b = body as Record<string, unknown>;
    const extra = Object.keys(b).filter((k) => !(FRONTING_KEYS as readonly string[]).includes(k));
    if (extra.length) throw bad("bad_fronting", `unknown field(s): ${extra.join(", ")}`);
    if (b.credits_usd !== undefined && (typeof b.credits_usd !== "string" || !/^\d+(\.\d{1,2})?$/.test(b.credits_usd) || Number(b.credits_usd) <= 0))
      throw bad("bad_fronting", "credits_usd must be a positive dollar amount as a string, such as \"10\"");
    for (const k of ["initial_buy_bps", "initial_buy_slippage_bps", "units_purchase_slippage_bps"] as const)
      if (b[k] !== undefined && (!Number.isInteger(b[k]) || (b[k] as number) < 0 || (b[k] as number) > 10_000)) throw bad("bad_fronting", `${k} must be an integer 0 to 10000`);
    if (b.identity_account_price_lamports !== undefined && (typeof b.identity_account_price_lamports !== "string" || !/^\d{1,19}$/.test(b.identity_account_price_lamports)))
      throw bad("bad_fronting", "identity_account_price_lamports must be a whole number of lamports as a string, such as \"30000000\"");
    if (b.identity_account_recipient !== undefined && (typeof b.identity_account_recipient !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(b.identity_account_recipient)))
      throw bad("bad_fronting", "identity_account_recipient must be a base58 address");
    return this.c.tx(() => {
      const cur = this.c.db.query<{ patch: string }, []>("SELECT patch FROM prepay_admin WHERE id = 1").get();
      const patch = { ...(cur ? JSON.parse(cur.patch) : {}), ...b };
      this.c.db.query("INSERT INTO prepay_admin (id, patch, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET patch = excluded.patch, updated_at = excluded.updated_at")
        .run(JSON.stringify(patch), this.c.now());
      this.applyAdmin();
      this.c.emitEvent("launch.fronting_config", { changed: Object.keys(b) });
      return this.frontingView();
    });
  }

  config(): PrepayConfig | null {
    return (this.c.cfg as { prepay?: PrepayConfig | null }).prepay ?? null;
  }

  /** The minimum deposit in base units, or null without a prepay config. Market rate: at Core's current reading, null when it has no usable one. */
  minBase(): bigint | null {
    const p = this.config();
    if (!p) return null;
    const rate = this.rate();
    if (rate) return rate.ok ? creditsAtPrice(p.min_usd, rate.usd_per_token!, this.c.cfg.token_decimals) : null;
    return usdToBase(p.min_usd, p.line_per_usd, this.c.cfg.token_decimals);
  }

  private nowS(): number {
    return Math.floor(this.c.now() / 1000);
  }

  /**
   * Market rate only (null otherwise): Core's current reading of the coin's USD price, the newest copy
   * of the indexer's GET /market/quote-usd it took at a sync (revenue.ts hands each one to
   * `noteReading`), usable while it is at most USD_MAX_AGE_S old (the limit of every USD figure Core
   * serves) and inside the band. The wizard reads the indexer itself and holds the reading to
   * `rate_max_age_s`; Core's copy is older by its own sampling.
   */
  rate(): RateView | null {
    const p = this.config();
    if (!p || !marketRate(p)) return null;
    const u = this.c.db.query<{ read_at: number; usd: number }, []>("SELECT read_at, usd FROM prepay_rates WHERE source = 'sync' ORDER BY read_at DESC LIMIT 1").get();
    const r = checkMarketRate(p, u ? { usd: u.usd, read_at: u.read_at, age_s: this.nowS() - u.read_at } : null,
      { symbol: "quote coin", why: this.noReading ?? "Core has received no reading from the market indexer yet", maxAgeS: USD_MAX_AGE_S });
    return { source: "market", usd_per_token: r.usd, read_at: r.read_at, age_s: r.age_s, max_age_s: r.max_age_s, ok: r.ok, reason: r.ok ? null : r.reason };
  }

  /** The prepay block as served (GET /v1/config, the prepay view): the file's values, and in market mode the current rate figures over them. */
  servedConfig(): Record<string, unknown> | null {
    const p = this.config();
    if (!p) return null;
    const rate = this.rate();
    if (!rate) return { ...p };
    return { ...p, line_per_usd: rate.ok ? linePerUsdAt(rate.usd_per_token!) : null, line_per_usd_config: p.line_per_usd, min_base_units: this.minBase()?.toString() ?? null, rate };
  }

  /** The network config JSON with the prepay block as served; unchanged at the configured rate. */
  served(network: Record<string, unknown>): Record<string, unknown> {
    if (!this.rate()) return network;
    const extra = this.servedConfig()!;
    // keys other views put on the block (the identity offer) stay; the rate figures go over the file's
    return { ...network, prepay: { ...(network.prepay as Record<string, unknown>), line_per_usd: extra.line_per_usd, line_per_usd_config: extra.line_per_usd_config, min_base_units: extra.min_base_units, rate: extra.rate } };
  }

  /** A reading Core received from the indexer at a sync: kept for the launch window, old ones pruned, pending launches checked again. Inside the caller's transaction. */
  noteReading(u: { quote_usd: number; read_at: number } | null, why: string | null = null) {
    if (!marketRate(this.config())) return;
    const now = this.nowS(), source = "sync";
    this.noReading = u ? null : why;
    if (u && Number.isFinite(u.quote_usd) && u.quote_usd > 0 && Number.isInteger(u.read_at) && u.read_at > 0)
      this.c.db.query("INSERT OR IGNORE INTO prepay_rates (read_at, usd, seen_at, source) VALUES (?, ?, ?, ?)").run(u.read_at, u.quote_usd, now, source);
    this.c.db.query("DELETE FROM prepay_rates WHERE read_at < ?").run(now - RATES_KEPT_S);
    this.recheckPending();
  }

  /** The readings Core holds within `windowS` of `at`. */
  private readingsAround(at: number, windowS: number): Reading[] {
    return this.c.db.query<{ read_at: number; usd: number; source: string }, [number, number]>("SELECT read_at, usd, source FROM prepay_rates WHERE read_at >= ? AND read_at <= ? ORDER BY read_at")
      .all(at - windowS, at + windowS).map((r) => ({ read_at: r.read_at, usd: r.usd, from: r.source }));
  }

  /**
   * The market rate decision for one deposit: among `readings`, each held inside the band, the highest
   * price decides (it asks the least coin, so the deposit is accepted at some reading exactly when it
   * is accepted at that one). Null without a reading: pending.
   */
  private judge(deposit: bigint, readings: Reading[]): { ok: boolean; min: bigint; nominal: bigint; usd: number; read_at: number; from: string } | null {
    const p = this.config()!, m = marketRate(p)!;
    let best: Reading | null = null;
    for (const r of readings) {
      const usd = Math.min(m.maxUsd, Math.max(m.minUsd, r.usd));
      if (!best || usd > best.usd) best = { ...r, usd };
    }
    if (!best) return null;
    const d = this.c.cfg.token_decimals;
    const min = creditsAtPrice(p.min_usd, best.usd, d, m.toleranceBps);
    return { ok: deposit >= min, min, nominal: creditsAtPrice(p.min_usd, best.usd, d), usd: best.usd, read_at: best.read_at, from: best.from };
  }

  /** Launches recorded pending (no reading for their time yet): the agent and the time to price, newest first, within the day Core keeps asking. */
  pending(): { agent: string; at: number }[] {
    return this.c.db.query<{ agent_id: string; rate_at: number }, [number]>("SELECT agent_id, rate_at FROM prepay WHERE rate_state = 'pending' AND rate_at >= ? ORDER BY rate_at DESC LIMIT 50")
      .all(this.nowS() - RATES_KEPT_S).map((r) => ({ agent: r.agent_id, at: r.rate_at }));
  }

  /** Checks every pending launch against the readings Core now holds for its window; `sample` adds the indexer's stored price for one agent's launch time. Inside the caller's transaction. */
  recheckPending(sample?: { agent: string; usd: number; read_at: number }): number {
    const p = this.config(), m = marketRate(p);
    if (!p || !m) return 0;
    let n = 0;
    for (const r of this.c.db.query<PrepayRow, []>("SELECT * FROM prepay WHERE rate_state = 'pending'").all()) {
      const at = r.rate_at ?? r.launched_at ?? r.checked_at;
      const readings = this.readingsAround(at, m.windowS);
      if (sample && sample.agent === r.agent_id) readings.push({ read_at: sample.read_at, usd: sample.usd, from: "sample" });
      const j = this.judge(BigInt(r.deposit), readings);
      if (!j) continue;
      this.c.db.query("UPDATE prepay SET min = ?, ok = ?, checked_at = ?, rate_state = 'market', rate_usd = ?, rate_read_at = ?, rate_min = ?, rate_tolerance_bps = ?, rate_window_s = ?, rate_from = ? WHERE agent_id = ?")
        .run(j.min.toString(), j.ok ? 1 : 0, this.c.now(), j.usd, j.read_at, j.nominal.toString(), m.toleranceBps, m.windowS, j.from, r.agent_id);
      this.c.emitEvent("agent.prepay", { agent: r.agent_id, deposit: r.deposit, min: j.min.toString(), ok: j.ok, woke: !!r.woke, signature: r.signature, initial_buy: r.initial_buy,
        rate: { usd_per_token: j.usd, read_at: j.read_at, was_pending: true } });
      if (!j.ok) this.sleepUnder(r.agent_id, j.min);
      n++;
    }
    return n;
  }

  /** An underfunded agent that is awake below its minimum is put to sleep. */
  private sleepUnder(agent: string, min: bigint) {
    const bal = this.c.ledger.balance(ACC.compute(agent));
    const a = this.c.db.query<{ awake: number }, [string]>("SELECT awake FROM agents WHERE agent_id = ?").get(agent);
    if (a?.awake && bal < min) {
      this.c.db.query("UPDATE agents SET awake = 0 WHERE agent_id = ?").run(agent);
      this.c.emitEvent("agent.asleep", { agent, compute: bal.toString(), reason: "prepay_below_minimum" });
    }
  }

  row(agent: string): PrepayRow | null {
    return this.c.db.query<PrepayRow, [string]>("SELECT * FROM prepay WHERE agent_id = ?").get(agent);
  }

  /** GET /v1/agents/:id/prepay */
  view(agent: string) {
    const p = this.config();
    const r = this.row(agent);
    return {
      agent,
      config: p ? (this.rate() ? this.servedConfig() : { ...p, min_base_units: this.minBase()!.toString() }) : null,
      checked: !!r,
      deposit: r?.deposit ?? null,
      // market rate: the smallest deposit the decision accepted (min_usd at the stored price, less the tolerance); null while pending
      min: r ? (r.rate_state === "pending" ? null : r.min) : null,
      ok: r ? !!r.ok : null,
      // what a market rate decision used; pending: no reading for the launch's time yet, so the launch stands as ok until one exists
      ...(r?.rate_state ? { pending: r.rate_state === "pending", rate: { state: r.rate_state, usd_per_token: r.rate_usd, read_at: r.rate_read_at, min_at_price: r.rate_min, tolerance_bps: r.rate_tolerance_bps,
        window_s: r.rate_window_s, launch_time: r.rate_at, from: r.rate_from } } : {}),
      woke_in_launch_tx: r ? !!r.woke : null,
      signature: r?.signature ?? null,
      source: r?.source ?? null,
      launched_at: r?.launched_at ?? null,
      // launch fronting: the tokens the launch transaction delivered to the agent key (its treasury at launch), and their share of the supply
      initial_buy: r?.initial_buy ?? null,
      initial_buy_bps_of_supply: r?.initial_buy && r.supply && BigInt(r.supply) > 0n ? Number((BigInt(r.initial_buy) * 1_000_000n) / BigInt(r.supply)) / 100 : null,
    };
  }

  /** The wake threshold Core applies to `agent`: raised to the minimum for an underfunded launch. */
  wakeThreshold(agent: string, base: bigint): bigint {
    const r = this.row(agent);
    if (!r || r.ok) return base;
    const m = BigInt(r.min);
    return m > base ? m : base;
  }

  /** Simulated mode: refuses a deposit below the minimum (called before the launch is recorded). */
  checkSimDeposit(deposit: bigint) {
    const rate = this.rate();
    if (rate) {
      // market rate: the current reading, with the same tolerance a landed launch gets
      const p = this.config()!;
      if (!rate.ok) throw bad("no_credits_rate", `no usable price for the launch credits: ${rate.reason}`);
      const floor = creditsAtPrice(p.min_usd, rate.usd_per_token!, this.c.cfg.token_decimals, marketRate(p)!.toleranceBps);
      if (deposit < floor) throw bad("deposit_below_minimum", `deposit ${deposit} is below the minimum ${floor} base units (prepay.min_usd ${p.min_usd} USD at ${rate.usd_per_token} USD per coin, less ${marketRate(p)!.toleranceBps} basis points)`);
      return;
    }
    const m = this.minBase();
    if (m !== null && deposit < m) {
      throw bad("deposit_below_minimum", `deposit ${deposit} is below the minimum ${m} base units (prepay.min_usd ${this.config()!.min_usd} USD at ${this.config()!.line_per_usd} $UNITS per USD)`);
    }
  }

  /** Records a launch's deposit; an underfunded agent that is awake below the minimum is put to sleep. Inside the caller's transaction. */
  record(agent: string, o: { mint: string | null; launchedAt: number | null; signature: string | null; deposit: bigint; woke: boolean; source: "chain" | "sim"; initialBuy?: bigint | null; supply?: bigint | null }) {
    const m = marketRate(this.config());
    if (m) return this.recordAtMarket(agent, o, m);
    const min = this.minBase() ?? 0n;
    const ok = o.deposit >= min;
    this.c.db
      .query("INSERT OR REPLACE INTO prepay (agent_id, mint, launched_at, signature, deposit, min, ok, woke, source, checked_at, initial_buy, supply) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(agent, o.mint, o.launchedAt, o.signature, o.deposit.toString(), min.toString(), ok ? 1 : 0, o.woke ? 1 : 0, o.source, this.c.now(),
        o.initialBuy == null ? null : o.initialBuy.toString(), o.supply == null ? null : o.supply.toString());
    this.c.emitEvent("agent.prepay", { agent, deposit: o.deposit.toString(), min: min.toString(), ok, woke: o.woke, signature: o.signature, initial_buy: o.initialBuy?.toString() ?? null });
    if (!ok) {
      const bal = this.c.ledger.balance(ACC.compute(agent));
      const a = this.c.db.query<{ awake: number }, [string]>("SELECT awake FROM agents WHERE agent_id = ?").get(agent);
      if (a?.awake && bal < min) {
        this.c.db.query("UPDATE agents SET awake = 0 WHERE agent_id = ?").run(agent);
        this.c.emitEvent("agent.asleep", { agent, compute: bal.toString(), reason: "prepay_below_minimum" });
      }
    }
  }

  /** `record` at the market rate: judged at the readings around the launch's time (a simulated launch: also the current one), or recorded pending. */
  private recordAtMarket(agent: string, o: Parameters<Prepay["record"]>[1], m: NonNullable<ReturnType<typeof marketRate>>) {
    const at = o.launchedAt ?? this.nowS();
    const readings = this.readingsAround(at, m.windowS);
    // a simulated launch happens now: Core's current reading prices it, whatever the window
    const cur = o.source === "sim" ? this.rate() : null;
    if (cur?.ok) readings.push({ read_at: cur.read_at!, usd: cur.usd_per_token!, from: "current" });
    const j = this.judge(o.deposit, readings);
    const ok = j ? j.ok : true; // pending: never underfunded on a guess
    this.c.db
      .query(`INSERT OR REPLACE INTO prepay (agent_id, mint, launched_at, signature, deposit, min, ok, woke, source, checked_at, initial_buy, supply,
        rate_state, rate_usd, rate_read_at, rate_min, rate_tolerance_bps, rate_window_s, rate_at, rate_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(agent, o.mint, o.launchedAt, o.signature, o.deposit.toString(), (j?.min ?? 0n).toString(), ok ? 1 : 0, o.woke ? 1 : 0, o.source, this.c.now(),
        o.initialBuy == null ? null : o.initialBuy.toString(), o.supply == null ? null : o.supply.toString(),
        j ? "market" : "pending", j?.usd ?? null, j?.read_at ?? null, j ? j.nominal.toString() : null, m.toleranceBps, m.windowS, at, j?.from ?? null);
    this.c.emitEvent("agent.prepay", { agent, deposit: o.deposit.toString(), min: j ? j.min.toString() : null, ok, woke: o.woke, signature: o.signature, initial_buy: o.initialBuy?.toString() ?? null,
      rate: j ? { usd_per_token: j.usd, read_at: j.read_at } : { pending: true } });
    if (j && !j.ok) this.sleepUnder(agent, j.min);
  }

  /**
   * Chain mode: reads the launch transaction of every launch created at or after `since` that has no
   * record yet (oldest signature of its AgentLaunch account), and records the compute vault's balance
   * after it (the vault is created by that transaction, so this is the deposit) and whether it ran
   * refresh_awake. Returns how many it recorded.
   */
  async syncChain(rpc: Rpc, launches: AgentLaunch[], tx: <T>(fn: () => T) => T, log: (m: string) => void = () => {}): Promise<number> {
    const p = this.config();
    if (!p) return 0;
    if (marketRate(p) && this.pending().length) tx(() => this.recheckPending());
    let n = 0;
    for (const l of launches) {
      if (Number(l.createdAt) < p.since || this.row(l.agent)) continue;
      if (!this.c.db.query("SELECT 1 FROM agents WHERE agent_id = ?").get(l.agent)) continue; // mirrored first
      const tries = this.misses.get(l.agent) ?? 0;
      if (tries >= 5) continue;
      try {
        const got = await readLaunchDeposit(rpc, l);
        if (!got) {
          this.misses.set(l.agent, tries + 1);
          continue;
        }
        // A launch is several transactions (launch + soul, then the credits). When they are sent in order (Jito did not
        // take the bundle) the first lands seconds before the one that carries the deposit: a read in between sees no
        // deposit yet. Seen on the go-live fork proof: such a launch was recorded with deposit 0 for good. A launch
        // younger than two minutes that shows no deposit is read again on the next sync, without counting as a miss.
        if (got.deposit === 0n && this.c.now() / 1000 - Number(l.createdAt) < SETTLE_S) continue;
        const supply = got.initialBuy > 0n ? ((await new ChainReader(rpc).mint(l.mint).catch(() => null))?.supply ?? null) : null;
        tx(() => this.record(l.agent, { mint: l.mint, launchedAt: Number(l.createdAt), signature: got.signature, deposit: got.deposit, woke: got.woke, source: "chain",
          initialBuy: got.initialBuy, supply }));
        this.misses.delete(l.agent);
        n++;
      } catch (e) {
        this.misses.set(l.agent, tries + 1);
        log(`prepay: launch of ${l.agent} not read: ${(e as Error).message}`);
      }
    }
    return n;
  }
}


/**
 * The deposit and refresh_awake of one launch, read from its transactions (legacy or v0). A launch is
 * up to five transactions approved at once (owner direction 2026-10-11: create + register first, the
 * funding after it), so the launcher's first transactions naming the AgentLaunch are read together:
 * the deposit is the compute vault's balance after the last of them that names it.
 */
export async function readLaunchDeposit(rpc: Rpc, l: AgentLaunch): Promise<{ signature: string; deposit: bigint; woke: boolean; initialBuy: bigint } | null> {
  const txs = await launchBundleTxs(rpc, { mint: l.mint, launcher: l.launcher });
  if (!txs.length) return null;
  const vault = launchPdas.computeVault(l.agent);
  const agentLaunch = launchPdas.agentLaunch(l.mint);
  let deposit = 0n, initialBuy = 0n, woke = false;
  for (const t of txs) {
    const post = t.json.meta?.postTokenBalances ?? [];
    const vi = t.keys.indexOf(vault);
    const bal = vi >= 0 ? post.find((b) => b.accountIndex === vi) : undefined;
    if (bal) deposit = BigInt(bal.uiTokenAmount.amount);
    if (t.instructions.some((ix) => t.keys[ix.programIdIndex] === LAUNCH_PROGRAM_ID && ix.data.length === 8 && REFRESH.every((b, i) => ix.data[i] === b) && t.keys[ix.accounts[1]!] === agentLaunch)) woke = true;
    // launch fronting: the agent's own token the launch left with the agent key (venue-agnostic: any
    // token account of the agent's mint owned by the agent key, after the transaction)
    const held = post.filter((b) => b.mint === l.mint && b.owner === l.agent).reduce((n, b) => n + BigInt(b.uiTokenAmount.amount), 0n);
    if (held > 0n) initialBuy = held;
  }
  return { signature: txs[0]!.signature, deposit, woke, initialBuy };
}

