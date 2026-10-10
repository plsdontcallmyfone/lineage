import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  accountDisc,
  ata,
  decodeAgentLaunch,
  decodeBondingCurve,
  decodeLaunchConfig,
  decodePumpGlobal,
  decodePumpPool,
  LAUNCH_PROGRAM_ID,
  launchPdas,
  PUMP,
  pumpPdas,
  RpcError,
  Rpc,
  toAddress,
  TOKEN_2022_PROGRAM,
  type Address,
  type PumpGlobal,
} from "@lineage/chain";
import { readMint, readTokenAccount } from "./accounts.ts";
import { pumpAlerts, type PumpBaseline, type PumpWatch } from "./alerts.ts";
import { storeDecoded } from "./db.ts";
import { decodeTx, type RawTx, type TokenCtx } from "./decode.ts";

// Ingest (pump.fun only, owner decisions 2026-10-10). Discovery: every AgentLaunch account of
// units_launch (getProgramAccounts). Sources of a pump.fun launch: its bonding curve, its canonical
// PumpSwap pool once pump.fun migrated it, its mint (transfers and account changes outside the venue,
// for holder balances) and its AgentLaunch account (units_launch instructions such as the fee crank
// and the graduation record). Records the Meteora venue wrote (devnet history) are kept as read-only
// rows: their stored trades stay, nothing new is ingested for them. Each source is backfilled and then
// polled with getSignaturesForAddress (`until` the newest signature already ingested, paged with
// `before`); each new signature is fetched once with getTransaction, decoded and stored keyed by
// signature. The cursor only moves past a signature once it is stored, so a crash or restart resumes
// where it stopped and re-reading is harmless.

export interface IndexerOpts {
  launchProgram?: Address;
  /** Seconds between holder list refreshes per token (getProgramAccounts on the token program). */
  holdersEveryS?: number;
  /** Poll interval of an active source, seconds (default 15). */
  pollEveryS?: number;
  /** Longest poll interval of a quiet source, seconds (default 300). */
  maxIdleS?: number;
  /** Seconds between discovery passes. */
  discoverEveryS?: number;
  log?: (msg: string) => void;
  now?: () => number;
}

interface TokenRow {
  mint: string;
  agent: string;
  venue: string;
  /** pump.fun: the bonding curve (the first layout's column name). */
  dbc_pool: string;
  dbc_base_vault: string;
  dbc_quote_vault: string;
  /** pump.fun: the canonical PumpSwap pool and its vaults once it exists. */
  damm_pool: string | null;
  damm_base_vault: string | null;
  damm_quote_vault: string | null;
  decimals: number;
  holders_at: number | null;
}

export class Indexer {
  lineMint: Address | null = null;
  lineTokenProgram: Address = TOKEN_2022_PROGRAM;
  lineDecimals = 6;
  lastCycleAt: number | null = null;
  lastCycleMs: number | null = null;
  headSlot: number | null = null;
  lastDiscoverAt = 0;
  private readonly launchProgram: Address;
  private readonly log: (m: string) => void;
  private readonly now: () => number;
  private dirtyHolders = new Set<string>();
  /** Per source: when it is next due and its current idle interval (seconds). */
  private schedule = new Map<string, { next: number; idle: number }>();
  /** The RPC refused getProgramAccounts on the token program once: count holders from indexed transactions from then on. */
  private gpaRefused = false;

  constructor(
    readonly db: Database,
    readonly rpc: Rpc,
    readonly opts: IndexerOpts = {},
  ) {
    this.launchProgram = opts.launchProgram ?? LAUNCH_PROGRAM_ID;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Finds every agent token and registers its sources. */
  async discover(): Promise<number> {
    const cfgAcc = await this.rpc.getAccountInfo(launchPdas.config());
    if (!cfgAcc) throw new Error("units_launch LaunchConfig not found");
    const cfg = decodeLaunchConfig(cfgAcc.data);
    this.lineMint = cfg.lineMint;
    this.lineTokenProgram = cfg.lineTokenProgram;
    const lm = await this.rpc.getAccountInfo(cfg.lineMint);
    if (lm) this.lineDecimals = readMint(lm.data).decimals;
    this.db.query("INSERT OR REPLACE INTO meta (k, v) VALUES ('line_mint', ?), ('line_decimals', ?)").run(cfg.lineMint, String(this.lineDecimals));

    const accs = await this.rpc.getProgramAccounts(this.launchProgram, { memcmp: [{ offset: 0, bytes: accountDisc("AgentLaunch") }] });
    const known = new Set((this.db.query("SELECT mint FROM tokens").all() as { mint: string }[]).map((r) => r.mint));
    const fresh = accs.map((a) => ({ a, l: decodeAgentLaunch(a.data) })).filter((x) => !known.has(x.l.mint));
    if (fresh.length) {
      const mints = await this.rpc.getMultipleAccounts(fresh.map((x) => x.l.mint));
      const ins = this.db.prepare(`INSERT OR IGNORE INTO tokens (mint, agent, launcher, launch_account, name, symbol, uri, decimals, repo_url, hosted,
        identity_mode, created_at, dbc_config, dbc_pool, dbc_base_vault, dbc_quote_vault, compute_vault, venue, pump_creator)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      fresh.forEach(({ a, l }, i) => {
        const mint = mints[i] ? readMint(mints[i]!.data) : null;
        const pump = l.venue === "pump";
        // a Meteora-era record: kept as read-only history, no sources
        ins.run(l.mint, l.agent, l.launcher, a.address, mint?.name ?? null, mint?.symbol ?? null, mint?.uri ?? null, mint?.decimals ?? 6, l.repoUrl,
          l.hosted ? 1 : 0, l.identityMode, Number(l.createdAt), pump ? PUMP.program : "", l.bondingCurve,
          pump ? ata(l.bondingCurve, l.mint, TOKEN_2022_PROGRAM) : "", pump ? ata(l.bondingCurve, cfg.lineMint, cfg.lineTokenProgram) : "",
          launchPdas.computeVault(l.agent), l.venue, pump ? l.pumpCreator : null);
        if (!pump) return;
        this.db.query("INSERT OR IGNORE INTO sources (address, mint, kind) VALUES (?, ?, 'curve'), (?, ?, 'mint'), (?, ?, 'launch')")
          .run(l.bondingCurve, l.mint, l.mint, l.mint, a.address, l.mint);
        this.dirtyHolders.add(l.mint);
      });
      this.log(`discovered ${fresh.length} new agent token(s), ${accs.length} total`);
    }
    this.lastDiscoverAt = this.now();
    return accs.length;
  }

  /** Re-reads every token's chain state in a few getMultipleAccounts calls, and checks pump.fun's watch list. */
  async refreshState(): Promise<void> {
    const toks = this.db.query("SELECT mint, venue, launch_account, dbc_pool, damm_pool, compute_vault, pump_creator FROM tokens").all() as
      { mint: string; venue: string; launch_account: string; dbc_pool: string; damm_pool: string | null; compute_vault: string; pump_creator: string | null }[];
    if (!toks.length || !this.lineMint) return;
    const line = this.lineMint;
    const pools = new Map(toks.filter((t) => t.venue === "pump").map((t) => [t.mint, t.damm_pool ?? pumpPdas.pool(t.mint, line)]));
    const addrs = [...toks.flatMap((t) => [t.launch_account, t.mint, t.compute_vault, ...(t.venue === "pump" ? [t.dbc_pool, pools.get(t.mint)!] : [])]),
      PUMP.global, PUMP.feeConfig, PUMP.ammFeeConfig];
    const accs = await this.rpc.getMultipleAccounts(addrs);
    const by = new Map(addrs.map((a, i) => [a, accs[i] ?? null]));
    const gAcc = by.get(PUMP.global);
    let g: PumpGlobal | null = null;
    try {
      g = gAcc && gAcc.owner === PUMP.program ? decodePumpGlobal(gAcc.data) : null;
    } catch {
      g = null;
    }
    // pool vault balances (base, quote) of every pool that exists
    const poolState = new Map<string, { pool: ReturnType<typeof decodePumpPool>; base: bigint; quote: bigint }>();
    const live: { mint: string; p: ReturnType<typeof decodePumpPool> }[] = [];
    for (const [mint, addr] of pools) {
      const a = by.get(addr);
      if (!a || a.owner !== PUMP.amm) continue;
      try {
        live.push({ mint, p: decodePumpPool(a.data) });
      } catch {
        /* not a pool */
      }
    }
    if (live.length) {
      const vaults = await this.rpc.getMultipleAccounts(live.flatMap((x) => [x.p.poolBaseTokenAccount, x.p.poolQuoteTokenAccount]));
      live.forEach((x, i) => {
        const b = vaults[2 * i], q = vaults[2 * i + 1];
        if (b && q) poolState.set(x.mint, { pool: x.p, base: readTokenAccount(b.data).amount, quote: readTokenAccount(q.data).amount });
      });
    }
    const now = this.now();
    const watch: PumpWatch = { tokens: [], maxCurveDepth: g ? g.maxCurveDepth : null,
      feeConfigSha: by.get(PUMP.feeConfig) ? sha(by.get(PUMP.feeConfig)!.data) : null, ammFeeConfigSha: by.get(PUMP.ammFeeConfig) ? sha(by.get(PUMP.ammFeeConfig)!.data) : null };
    for (const t of toks) {
      const la = by.get(t.launch_account);
      const mintAcc = by.get(t.mint);
      const vault = by.get(t.compute_vault);
      if (!la || !mintAcc) continue;
      const l = decodeAgentLaunch(la.data);
      const mint = readMint(mintAcc.data);
      // compute-side fields change for every record (debits, withdrawals, wake), whatever the venue
      this.db.query(`UPDATE tokens SET name = COALESCE(?, name), symbol = COALESCE(?, symbol), uri = COALESCE(?, uri), decimals = ?, supply = ?, awake = ?,
        fees_claimed = ?, to_compute = ?, to_protocol = ?, debited = ?, withdrawn = ?, compute_balance = ?, state_at = ? WHERE mint = ?`).run(
        mint.name, mint.symbol, mint.uri, mint.decimals, mint.supply.toString(), l.awake ? 1 : 0, l.feesClaimed.toString(), l.toCompute.toString(),
        l.toProtocol.toString(), l.debited.toString(), l.withdrawn.toString(), vault ? readTokenAccount(vault.data).amount.toString() : null, now, t.mint);
      if (t.venue !== "pump") continue;
      const cAcc = by.get(t.dbc_pool);
      if (!cAcc || cAcc.owner !== PUMP.program) continue;
      const c = decodeBondingCurve(cAcc.data);
      const ps = poolState.get(t.mint) ?? null;
      const poolAddr = pools.get(t.mint)!;
      let spot: number | null = null;
      if (ps && ps.base > 0n) spot = Number(ps.quote + ps.pool.virtualQuoteReserves) / 10 ** this.lineDecimals / (Number(ps.base) / 10 ** mint.decimals);
      else if (c.virtualTokenReserves > 0n) spot = Number(c.virtualQuoteReserves) / 10 ** this.lineDecimals / (Number(c.virtualTokenReserves) / 10 ** mint.decimals);
      const graduated = l.graduated || ps !== null;
      const progress = graduated ? 1 : g && g.initialRealTokenReserves > 0n
        ? Number(g.initialRealTokenReserves - c.realTokenReserves) / Number(g.initialRealTokenReserves) : null;
      const start = g && g.initialVirtualTokenReserves > 0n && c.initialVirtualQuoteReserves > 0n
        ? Number(c.initialVirtualQuoteReserves) / 10 ** this.lineDecimals / (Number(g.initialVirtualTokenReserves) / 10 ** mint.decimals) : null;
      const income = (this.db.query("SELECT creator_fee_raw AS c FROM trades WHERE mint = ? AND creator_fee_raw IS NOT NULL").all(t.mint) as { c: string }[])
        .reduce((n, r) => n + BigInt(r.c), 0n);
      this.db.query(`UPDATE tokens SET graduated = ?, migrated = ?, quote_reserve = ?, migration_threshold = NULL, sqrt_start_price = NULL, sqrt_price = NULL,
        start_price = ?, spot_price = ?, progress = ?, damm_pool = ?, damm_base_vault = ?, damm_quote_vault = ?, pump_creator = ?, creator_fee_income = ?
        WHERE mint = ?`).run(graduated ? 1 : 0, ps ? 1 : 0, c.realQuoteReserves.toString(), start, spot, progress, ps ? poolAddr : null,
        ps?.pool.poolBaseTokenAccount ?? null, ps?.pool.poolQuoteTokenAccount ?? null, l.pumpCreator, income.toString(), t.mint);
      if (ps) this.db.query("INSERT OR IGNORE INTO sources (address, mint, kind) VALUES (?, ?, 'pool')").run(poolAddr, t.mint);
      watch.tokens.push({ mint: t.mint, expectedCreator: l.pumpCreator, curveCreator: c.creator, poolCoinCreator: ps ? ps.pool.coinCreator : null });
    }
    // the baseline: what pump.fun looked like the first time this database saw it
    const rec = this.db.query("SELECT v FROM meta WHERE k = 'pump_baseline'").get() as { v: string } | null;
    let baseline: PumpBaseline | null = rec ? JSON.parse(rec.v) : null;
    if (!baseline && watch.maxCurveDepth !== null && watch.feeConfigSha && watch.ammFeeConfigSha) {
      baseline = { maxCurveDepth: watch.maxCurveDepth, feeConfigSha: watch.feeConfigSha, ammFeeConfigSha: watch.ammFeeConfigSha, recordedAt: now };
      this.db.query("INSERT OR REPLACE INTO meta (k, v) VALUES ('pump_baseline', ?)").run(JSON.stringify(baseline));
    }
    const alerts = pumpAlerts(watch, baseline);
    this.db.query("INSERT OR REPLACE INTO meta (k, v) VALUES ('pump_alerts', ?)").run(JSON.stringify({ checked_at: now, baseline, alerts }));
    if (alerts.length) for (const a of alerts) this.log(`ALERT ${a.kind} ${a.subject}: ${a.detail}`);
  }

  private ctx(t: TokenRow): TokenCtx {
    return { mint: t.mint, lineMint: this.lineMint!, curve: t.dbc_pool, pool: t.damm_pool ?? pumpPdas.pool(t.mint, this.lineMint!), baseDecimals: t.decimals,
      quoteDecimals: this.lineDecimals, launchProgram: this.launchProgram };
  }

  /** Backfills or polls one source. Returns the number of transactions ingested. */
  async syncSource(address: string): Promise<number> {
    const src = this.db.query("SELECT * FROM sources WHERE address = ?").get(address) as { mint: string; newest_sig: string | null } | null;
    if (!src) return 0;
    const tok = this.db.query("SELECT * FROM tokens WHERE mint = ?").get(src.mint) as TokenRow | null;
    // Meteora-era rows are read-only history: nothing new is ingested for them
    if (!tok || !this.lineMint || tok.venue !== "pump") return 0;
    this.db.query("UPDATE sources SET last_poll_at = ? WHERE address = ?").run(this.now(), address);
    const sigs: { signature: string; slot: number; err: unknown }[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.rpc.call<{ signature: string; slot: number; err: unknown }[]>("getSignaturesForAddress", [
        address, { limit: 1000, commitment: "confirmed", ...(before ? { before } : {}), ...(src.newest_sig ? { until: src.newest_sig } : {}) },
      ]);
      sigs.push(...page);
      if (page.length < 1000) break;
      before = page[page.length - 1]!.signature;
    }
    sigs.reverse(); // oldest first
    const ctx = this.ctx(tok);
    const isSeen = this.db.prepare("SELECT 1 FROM seen WHERE sig = ? AND mint = ?");
    let n = 0;
    let skipped = false;
    for (const s of sigs) {
      if (!isSeen.get(s.signature, tok.mint)) {
        const tx = await this.rpc.call<RawTx | null>("getTransaction", [s.signature,
          { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
        if (!tx) break; // not served yet: resume from here on the next poll
        // one transaction the decoder cannot read (malformed balances or keys from the RPC) is logged
        // and skipped, never retried forever: it used to throw here and wedge the source (audit A2 OFF-I3)
        let ok = true;
        try {
          const d = decodeTx(tx, ctx);
          this.db.transaction(() => storeDecoded(this.db, tok.mint, d, { base: tok.decimals, quote: this.lineDecimals }))();
          if (d.trades.length) this.dirtyHolders.add(tok.mint);
        } catch (e) {
          ok = false;
          skipped = true;
          console.error(`indexer: skipped undecodable tx ${s.signature} for ${tok.mint}: ${(e as Error).message}`);
          this.db.query("UPDATE sources SET last_error = ? WHERE address = ?").run(`skipped ${s.signature}: ${(e as Error).message}`.slice(0, 300), address);
        }
        if (ok) n++;
      }
      this.db.query("UPDATE sources SET newest_sig = ?, newest_slot = ?, txs = txs + 1 WHERE address = ?").run(s.signature, s.slot, address);
    }
    if (skipped) this.db.query("UPDATE sources SET last_ok_at = ? WHERE address = ?").run(this.now(), address);
    else this.db.query("UPDATE sources SET last_ok_at = ?, last_error = NULL WHERE address = ?").run(this.now(), address);
    return n;
  }

  /** Top holders of one token (pool vaults excluded), from the token program's accounts for the mint. */
  async refreshHolders(mint: string): Promise<number> {
    const tok = this.db.query("SELECT * FROM tokens WHERE mint = ?").get(mint) as TokenRow | null;
    if (!tok) return 0;
    const vaults = new Set([tok.dbc_base_vault, tok.damm_base_vault].filter(Boolean));
    const byOwner = new Map<string, bigint>();
    // Every token account of the mint (getProgramAccounts) when the RPC serves it. Public devnet refuses
    // that for Token-2022 ("excluded from account secondary indexes", and getTokenLargestAccounts is
    // rate limited to uselessness there); then the latest balance of every token account seen in an
    // indexed transaction (the mint itself is a source, so swaps, transfer_checked, burns and account
    // creation are all seen; a legacy plain `transfer`, which does not name the mint, is not).
    let source: "accounts" | "transactions" = "accounts";
    try {
      if (this.gpaRefused) throw new Error("refused before");
      const m = await this.rpc.getAccountInfo(mint);
      if (!m) return 0;
      const rows = await this.rpc.call<{ pubkey: string; account: { data: [string, string] } }[]>("getProgramAccounts", [m.owner, {
        encoding: "base64", commitment: "confirmed", filters: [{ memcmp: { offset: 0, bytes: mint } }], dataSlice: { offset: 32, length: 40 } }]);
      for (const r of rows) {
        if (vaults.has(r.pubkey)) continue;
        const d = new Uint8Array(Buffer.from(r.account.data[0], "base64"));
        if (d.length < 40) continue;
        const amount = new DataView(d.buffer, d.byteOffset).getBigUint64(32, true);
        if (amount > 0n) byOwner.set(toAddress(d.subarray(0, 32)), (byOwner.get(toAddress(d.subarray(0, 32))) ?? 0n) + amount);
      }
    } catch (e) {
      if (!this.gpaRefused) {
        // only an RPC-level refusal switches the method for good; a transport failure is retried next time
        if (!(e instanceof RpcError) || e.code === undefined) throw e;
        this.log(`holders: getProgramAccounts refused (${String(e.message).slice(0, 80)}), using balances from indexed transactions`);
        this.gpaRefused = true;
      }
      byOwner.clear();
      for (const r of this.db.query("SELECT account, owner, amount FROM token_accounts WHERE mint = ?").all(mint) as { account: string; owner: string; amount: string }[]) {
        if (vaults.has(r.account) || r.amount === "0") continue;
        byOwner.set(r.owner, (byOwner.get(r.owner) ?? 0n) + BigInt(r.amount));
      }
      source = "transactions";
    }
    this.db.transaction(() => {
      this.db.query("DELETE FROM holders WHERE mint = ?").run(mint);
      const ins = this.db.prepare("INSERT INTO holders (mint, owner, amount) VALUES (?,?,?)");
      for (const [o, a] of byOwner) ins.run(mint, o, a.toString());
      this.db.query("UPDATE tokens SET holders = ?, holders_source = ?, holders_at = ? WHERE mint = ?").run(byOwner.size, source, this.now(), mint);
    })();
    return byOwner.size;
  }

  /** Makes every source of the token behind `address` (a source address or a mint) due on the next cycle. */
  markDue(address: string): void {
    const row = this.db.query("SELECT mint FROM sources WHERE address = ? OR mint = ? LIMIT 1").get(address, address) as { mint: string } | null;
    if (!row) return;
    for (const r of this.db.query("SELECT address FROM sources WHERE mint = ?").all(row.mint) as { address: string }[]) this.schedule.delete(r.address);
  }

  /** One full pass: discovery (when due), chain state, every source, holders (when due or after trades). */
  async cycle(): Promise<{ txs: number; errors: number }> {
    const t0 = Date.now();
    let txs = 0;
    let errors = 0;
    if (!this.lineMint || this.now() - this.lastDiscoverAt >= (this.opts.discoverEveryS ?? 60)) await this.discover();
    this.headSlot = await this.rpc.getSlot();
    await this.refreshState();
    const sources = this.db.query(`SELECT s.address, s.mint FROM sources s JOIN tokens t ON t.mint = s.mint WHERE t.venue = 'pump'
      ORDER BY s.kind, s.address`).all() as { address: string; mint: string }[];
    const now = this.now();
    for (const s of sources) {
      const sched = this.schedule.get(s.address);
      if (sched && now < sched.next) continue;
      try {
        const n = await this.syncSource(s.address);
        txs += n;
        // a quiet source is polled less often (doubling up to maxIdleS); new activity resets it
        const base = this.opts.pollEveryS ?? 15;
        const idle = n > 0 || !sched ? base : Math.min(this.opts.maxIdleS ?? 300, sched.idle * 2);
        this.schedule.set(s.address, { next: this.now() + idle, idle });
      } catch (e) {
        errors++;
        this.db.query("UPDATE sources SET last_error = ? WHERE address = ?").run(String((e as Error).message).slice(0, 200), s.address);
        this.log(`source ${s.address}: ${(e as Error).message}`);
      }
    }
    if (txs) await this.refreshState();
    const every = this.opts.holdersEveryS ?? 600;
    const toks = this.db.query("SELECT mint, holders_at FROM tokens WHERE venue = 'pump'").all() as { mint: string; holders_at: number | null }[];
    for (const t of toks) {
      if (this.dirtyHolders.has(t.mint) || t.holders_at == null || this.now() - t.holders_at >= every) {
        try {
          await this.refreshHolders(t.mint);
          this.dirtyHolders.delete(t.mint);
        } catch (e) {
          errors++;
          this.log(`holders ${t.mint}: ${(e as Error).message}`);
        }
      }
    }
    this.lastCycleAt = this.now();
    this.lastCycleMs = Date.now() - t0;
    return { txs, errors };
  }
}

const sha = (d: Uint8Array) => createHash("sha256").update(d).digest("hex");
