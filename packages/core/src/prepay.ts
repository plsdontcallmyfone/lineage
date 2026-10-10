import { base58Decode } from "@lineage/protocol";
import { ChainReader, ixDisc, LAUNCH_PROGRAM_ID, launchPdas, parsePrepayConfig, usdToBase, type AgentLaunch, type PrepayConfig, type Rpc } from "@lineage/chain";
import type { Core } from "./core.ts";
import { bad } from "./errors.ts";
import { ACC } from "./ledger.ts";

// Prepaid credits at launch (plan C, owner decision 2026-10-09). A launch carries a deposit into the
// agent's compute vault and the permissionless refresh_awake in the same transaction, so the agent
// starts working at once. The minimum is `prepay.min_usd` in the network config (admin-editable,
// converted at `prepay.line_per_usd`, a TEST rate on devnet). lineage_launch does not enforce it
// (no program change), so the wallet and Core do:
//   - simulated mode: POST /v1/admin/launches with `deposit` below the minimum is refused;
//   - chain mode: for every launch created at or after `prepay.since` Core reads the launch
//     transaction once, records its deposit, and an agent whose deposit fell short stays asleep in
//     Core until its compute vault holds at least the minimum (its effective wake threshold is
//     max(wake_threshold, minimum)). Core refuses an asleep agent's commits, and hosted workers check
//     Core before any model spend.

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
const FRONTING_KEYS = ["credits_usd", "initial_buy_bps", "initial_buy_slippage_bps"] as const;

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
}

const instances = new WeakMap<Core, Prepay>();
export function prepayOf(core: Core): Prepay {
  let p = instances.get(core);
  if (!p) instances.set(core, (p = new Prepay(core)));
  return p;
}

const REFRESH = ixDisc("refresh_awake");

export class Prepay {
  private readonly c: Internals;
  /** launch transactions that could not be read yet (retried next sync) */
  private misses = new Map<string, number>();
  constructor(core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(SCHEMA);
    // the initial buy a launch delivered to the agent key (launch fronting); added after plan C
    const cols = this.c.db.query<{ name: string }, []>("PRAGMA table_info(prepay)").all().map((r) => r.name);
    if (!cols.includes("initial_buy")) this.c.db.exec("ALTER TABLE prepay ADD COLUMN initial_buy TEXT");
    if (!cols.includes("supply")) this.c.db.exec("ALTER TABLE prepay ADD COLUMN supply TEXT");
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
    (this.c.cfg as { prepay?: PrepayConfig | null }).prepay = parsePrepayConfig(next);
  }

  /** GET /v1/launch-fronting: the three things a launcher fronts, as configured now. */
  frontingView() {
    const p = this.config();
    if (!p) return { configured: false };
    const row = this.c.db.query<{ patch: string; updated_at: number }, []>("SELECT patch, updated_at FROM prepay_admin WHERE id = 1").get();
    return {
      configured: true,
      token_creation: "paid by the launcher: rent and network fees, shown exactly from the launch simulation",
      credits_usd: p.min_usd,
      credits_required: true,
      credits_base_units: this.minBase()!.toString(),
      line_per_usd: p.line_per_usd,
      rate_status: p.rate_status,
      initial_buy_bps: p.initial_buy_bps,
      initial_buy_slippage_bps: p.initial_buy_slippage_bps,
      admin_patch: row ? JSON.parse(row.patch) : null,
      updated_at: row?.updated_at ?? null,
    };
  }

  /** POST /v1/admin/launch-fronting { credits_usd?, initial_buy_bps?, initial_buy_slippage_bps? } */
  setFronting(body: unknown) {
    const p = this.config();
    if (!p) throw bad("no_prepay_config", "this Core has no prepay block in its network config");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("bad_fronting", "a JSON object expected");
    const b = body as Record<string, unknown>;
    const extra = Object.keys(b).filter((k) => !(FRONTING_KEYS as readonly string[]).includes(k));
    if (extra.length) throw bad("bad_fronting", `unknown field(s): ${extra.join(", ")}`);
    if (b.credits_usd !== undefined && (typeof b.credits_usd !== "string" || !/^\d+(\.\d{1,2})?$/.test(b.credits_usd) || Number(b.credits_usd) <= 0))
      throw bad("bad_fronting", "credits_usd must be a positive dollar amount as a string, such as \"10\"");
    for (const k of ["initial_buy_bps", "initial_buy_slippage_bps"] as const)
      if (b[k] !== undefined && (!Number.isInteger(b[k]) || (b[k] as number) < 0 || (b[k] as number) > 10_000)) throw bad("bad_fronting", `${k} must be an integer 0 to 10000`);
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

  /** The minimum deposit in base units, or null without a prepay config. */
  minBase(): bigint | null {
    const p = this.config();
    return p ? usdToBase(p.min_usd, p.line_per_usd, this.c.cfg.token_decimals) : null;
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
      config: p ? { ...p, min_base_units: this.minBase()!.toString() } : null,
      checked: !!r,
      deposit: r?.deposit ?? null,
      min: r?.min ?? null,
      ok: r ? !!r.ok : null,
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
    const m = this.minBase();
    if (m !== null && deposit < m) {
      throw bad("deposit_below_minimum", `deposit ${deposit} is below the minimum ${m} base units (prepay.min_usd ${this.config()!.min_usd} USD at ${this.config()!.line_per_usd} $LINE per USD)`);
    }
  }

  /** Records a launch's deposit; an underfunded agent that is awake below the minimum is put to sleep. Inside the caller's transaction. */
  record(agent: string, o: { mint: string | null; launchedAt: number | null; signature: string | null; deposit: bigint; woke: boolean; source: "chain" | "sim"; initialBuy?: bigint | null; supply?: bigint | null }) {
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

  /**
   * Chain mode: reads the launch transaction of every launch created at or after `since` that has no
   * record yet (oldest signature of its AgentLaunch account), and records the compute vault's balance
   * after it (the vault is created by that transaction, so this is the deposit) and whether it ran
   * refresh_awake. Returns how many it recorded.
   */
  async syncChain(rpc: Rpc, launches: AgentLaunch[], tx: <T>(fn: () => T) => T, log: (m: string) => void = () => {}): Promise<number> {
    const p = this.config();
    if (!p) return 0;
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

interface TxJson {
  transaction: { message: { accountKeys: string[]; instructions: { programIdIndex: number; accounts: number[]; data: string }[] } };
  meta: { err: unknown; postTokenBalances?: { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }[]; loadedAddresses?: { writable: string[]; readonly: string[] } } | null;
}

/** The deposit and refresh_awake of one launch, read from its transaction (legacy or v0). */
export async function readLaunchDeposit(rpc: Rpc, l: AgentLaunch): Promise<{ signature: string; deposit: bigint; woke: boolean; initialBuy: bigint } | null> {
  const sigs = await rpc.call<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [launchPdas.agentLaunch(l.mint), { limit: 1000, commitment: "confirmed" }]);
  const ok = sigs.filter((s) => !s.err);
  if (!ok.length) return null;
  const signature = ok[ok.length - 1]!.signature;
  const t = await rpc.call<TxJson | null>("getTransaction", [signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
  if (!t?.meta || t.meta.err) return null;
  const keys = [...t.transaction.message.accountKeys, ...(t.meta.loadedAddresses?.writable ?? []), ...(t.meta.loadedAddresses?.readonly ?? [])];
  const vault = launchPdas.computeVault(l.agent);
  const vi = keys.indexOf(vault);
  const bal = (t.meta.postTokenBalances ?? []).find((b) => b.accountIndex === vi);
  const deposit = bal ? BigInt(bal.uiTokenAmount.amount) : 0n;
  const agentLaunch = launchPdas.agentLaunch(l.mint);
  const woke = t.transaction.message.instructions.some((ix) => {
    if (keys[ix.programIdIndex] !== LAUNCH_PROGRAM_ID) return false;
    const d = base58Decode(ix.data);
    return d.length === 8 && REFRESH.every((b, i) => d[i] === b) && keys[ix.accounts[1]!] === agentLaunch;
  });
  // launch fronting: the agent's own token the launch transaction left with the agent key (venue-agnostic: any
  // token account of the agent's mint owned by the agent key, after the transaction)
  const initialBuy = (t.meta.postTokenBalances ?? []).filter((b) => b.mint === l.mint && b.owner === l.agent).reduce((n, b) => n + BigInt(b.uiTokenAmount.amount), 0n);
  return { signature, deposit, woke, initialBuy };
}

