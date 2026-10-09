import type { Database } from "bun:sqlite";
import { accountDisc, RpcError, toAddress, decodeAgentLaunch, decodeLaunchConfig, LAUNCH_PROGRAM_ID, launchPdas, METEORA, Rpc, type Address } from "@lineage/chain";
import { readDammPool, readDbcConfig, readDbcPool, readMint, readTokenAccount } from "./accounts.ts";
import { storeDecoded } from "./db.ts";
import { decodeTx, sqrtPriceToPrice, type RawTx, type TokenCtx } from "./decode.ts";

// Ingest. Discovery: every AgentLaunch account of lineage_launch (getProgramAccounts). Sources: each
// token's DBC pool, its DAMM v2 pool once Meteora migrated it (graduated, or migrated and not yet
// graduated), its mint (transfers and account changes outside the pools, for holder balances) and its
// AgentLaunch account (lineage_launch instructions that touch no pool, such as repoint_position). Each source is backfilled and then polled with getSignaturesForAddress (`until` the
// newest signature already ingested, paged with `before`); each new signature is fetched once with
// getTransaction, decoded and stored keyed by signature. The cursor only moves past a signature
// once it is stored, so a crash or restart resumes where it stopped and re-reading is harmless.

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
  dbc_pool: string;
  dbc_base_vault: string;
  dbc_quote_vault: string;
  damm_pool: string | null;
  damm_base_vault: string | null;
  damm_quote_vault: string | null;
  decimals: number;
  holders_at: number | null;
}

export class Indexer {
  lineMint: Address | null = null;
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
    if (!cfgAcc) throw new Error("lineage_launch LaunchConfig not found");
    const cfg = decodeLaunchConfig(cfgAcc.data);
    this.lineMint = cfg.lineMint;
    const lm = await this.rpc.getAccountInfo(cfg.lineMint);
    if (lm) this.lineDecimals = readMint(lm.data).decimals;
    this.db.query("INSERT OR REPLACE INTO meta (k, v) VALUES ('line_mint', ?), ('line_decimals', ?)").run(cfg.lineMint, String(this.lineDecimals));

    const accs = await this.rpc.getProgramAccounts(this.launchProgram, { memcmp: [{ offset: 0, bytes: accountDisc("AgentLaunch") }] });
    const known = new Set((this.db.query("SELECT mint FROM tokens").all() as { mint: string }[]).map((r) => r.mint));
    const fresh = accs.map((a) => ({ a, l: decodeAgentLaunch(a.data) })).filter((x) => !known.has(x.l.mint));
    if (fresh.length) {
      const extra = await this.rpc.getMultipleAccounts(fresh.flatMap((x) => [x.l.mint, x.l.dbcPool]));
      const ins = this.db.prepare(`INSERT OR IGNORE INTO tokens (mint, agent, launcher, launch_account, name, symbol, uri, decimals, repo_url, hosted,
        identity_mode, created_at, dbc_config, dbc_pool, dbc_base_vault, dbc_quote_vault, compute_vault) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      fresh.forEach(({ a, l }, i) => {
        const mint = extra[2 * i] ? readMint(extra[2 * i]!.data) : null;
        const pool = extra[2 * i + 1] ? readDbcPool(extra[2 * i + 1]!.data) : null;
        ins.run(l.mint, l.agent, l.launcher, a.address, mint?.name ?? null, mint?.symbol ?? null, mint?.uri ?? null, mint?.decimals ?? 6, l.repoUrl,
          l.hosted ? 1 : 0, l.identityMode, Number(l.createdAt), l.dbcConfig, l.dbcPool, pool?.baseVault ?? launchPdas.dbcVault(l.mint, l.dbcPool),
          pool?.quoteVault ?? launchPdas.dbcVault(cfg.lineMint, l.dbcPool), launchPdas.computeVault(l.agent));
        this.db.query("INSERT OR IGNORE INTO sources (address, mint, kind) VALUES (?, ?, 'dbc'), (?, ?, 'mint'), (?, ?, 'launch')")
          .run(l.dbcPool, l.mint, l.mint, l.mint, a.address, l.mint);
        this.dirtyHolders.add(l.mint);
      });
      this.log(`discovered ${fresh.length} new agent token(s), ${accs.length} total`);
    }
    this.lastDiscoverAt = this.now();
    return accs.length;
  }

  /** Re-reads every token's chain state in a few getMultipleAccounts calls. */
  async refreshState(): Promise<void> {
    const toks = this.db.query("SELECT mint, launch_account, dbc_pool, dbc_config, damm_pool, compute_vault FROM tokens").all() as
      { mint: string; launch_account: string; dbc_pool: string; dbc_config: string; damm_pool: string | null; compute_vault: string }[];
    if (!toks.length) return;
    const configs = [...new Set(toks.map((t) => t.dbc_config))];
    const addrs = [...toks.flatMap((t) => [t.launch_account, t.mint, t.dbc_pool, t.compute_vault]), ...configs];
    const accs = await this.rpc.getMultipleAccounts(addrs);
    const by = new Map(addrs.map((a, i) => [a, accs[i] ?? null]));
    const now = this.now();
    for (const t of toks) {
      const la = by.get(t.launch_account);
      const mintAcc = by.get(t.mint);
      const poolAcc = by.get(t.dbc_pool);
      const cfgAcc = by.get(t.dbc_config);
      const vault = by.get(t.compute_vault);
      if (!la || !mintAcc || !poolAcc) continue;
      const l = decodeAgentLaunch(la.data);
      const mint = readMint(mintAcc.data);
      const pool = readDbcPool(poolAcc.data);
      const cfg = cfgAcc ? readDbcConfig(cfgAcc.data) : null;
      let dammPool = l.graduated ? l.dammPool : t.damm_pool;
      if (!dammPool && pool.isMigrated && this.lineMint) dammPool = launchPdas.dammPool(t.mint, this.lineMint);
      let damm = null;
      if (dammPool) {
        const d = await this.rpc.getAccountInfo(dammPool);
        damm = d && d.owner === METEORA.dammV2Program ? readDammPool(d.data) : null;
        if (!damm) dammPool = null;
      }
      const sqrt = damm && (pool.isMigrated || l.graduated) ? damm.sqrtPrice : pool.sqrtPrice;
      this.db.query(`UPDATE tokens SET name = COALESCE(?, name), symbol = COALESCE(?, symbol), uri = COALESCE(?, uri), decimals = ?, supply = ?,
        graduated = ?, awake = ?, migrated = ?, fees_claimed = ?, to_compute = ?, to_protocol = ?, debited = ?, withdrawn = ?,
        quote_reserve = ?, migration_threshold = ?, sqrt_start_price = ?, start_price = ?, sqrt_price = ?, spot_price = ?, compute_balance = ?,
        damm_pool = ?, damm_base_vault = ?, damm_quote_vault = ?, position = ?, position_nft_account = ?, state_at = ? WHERE mint = ?`).run(
        mint.name, mint.symbol, mint.uri, mint.decimals, mint.supply.toString(), l.graduated ? 1 : 0, l.awake ? 1 : 0, pool.isMigrated ? 1 : 0,
        l.feesClaimed.toString(), l.toCompute.toString(), l.toProtocol.toString(), l.debited.toString(), l.withdrawn.toString(),
        pool.quoteReserve.toString(), cfg?.migrationQuoteThreshold.toString() ?? null, cfg?.sqrtStartPrice.toString() ?? null,
        cfg ? sqrtPriceToPrice(cfg.sqrtStartPrice, mint.decimals, this.lineDecimals) : null, sqrt.toString(),
        sqrtPriceToPrice(sqrt, mint.decimals, this.lineDecimals), vault ? readTokenAccount(vault.data).amount.toString() : null,
        dammPool, damm?.tokenAVault ?? null, damm?.tokenBVault ?? null, l.graduated ? l.position : null, l.graduated ? l.positionNftAccount : null, now,
        t.mint);
      if (dammPool) this.db.query("INSERT OR IGNORE INTO sources (address, mint, kind) VALUES (?, ?, 'damm')").run(dammPool, t.mint);
      // tokens a database from an older layout discovered before these sources existed
      this.db.query("INSERT OR IGNORE INTO sources (address, mint, kind) VALUES (?, ?, 'mint'), (?, ?, 'launch')").run(t.mint, t.mint, t.launch_account, t.mint);
    }
  }

  private ctx(t: TokenRow): TokenCtx {
    return {
      mint: t.mint, lineMint: this.lineMint!, dbcPool: t.dbc_pool, dbcBaseVault: t.dbc_base_vault, dbcQuoteVault: t.dbc_quote_vault,
      dammPool: t.damm_pool, dammBaseVault: t.damm_base_vault, dammQuoteVault: t.damm_quote_vault, baseDecimals: t.decimals, quoteDecimals: this.lineDecimals,
    };
  }

  /** Backfills or polls one source. Returns the number of transactions ingested. */
  async syncSource(address: string): Promise<number> {
    const src = this.db.query("SELECT * FROM sources WHERE address = ?").get(address) as { mint: string; newest_sig: string | null } | null;
    if (!src) return 0;
    const tok = this.db.query("SELECT * FROM tokens WHERE mint = ?").get(src.mint) as TokenRow | null;
    if (!tok || !this.lineMint) return 0;
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
    const sources = this.db.query("SELECT address, mint FROM sources ORDER BY kind, address").all() as { address: string; mint: string }[];
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
    const toks = this.db.query("SELECT mint, holders_at FROM tokens").all() as { mint: string; holders_at: number | null }[];
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
