import type { Database } from "bun:sqlite";
import {
  accountDisc,
  ata,
  bountyPdas,
  curveMigrated,
  curveQuoteMint,
  decodeAgentLaunch,
  decodeBondingCurve,
  decodePool,
  decodePumpPool,
  hexToBytes,
  LAUNCH_PROGRAM_ID,
  launchPdas,
  openBountyPdas,
  poolPdas,
  PUMP,
  pumpPdas,
  REGISTRY_PROGRAM_ID,
  registryPdas,
  BOUNTY_PROGRAM_ID,
  RpcError,
  seededAddress,
  toAddress,
  type Address,
  type Rpc,
} from "@units/chain";
import { readTokenAccount } from "./accounts.ts";
import { decodeBurns, walletMoves, type Burn } from "./burns.ts";
import type { RawTx } from "./decode.ts";
import { usdNear, type QuoteUsdReading } from "./usd.ts";

// Supply (owner 2026-10-13: "a dashboard that show token supply and dev burns and stuff"): what the
// quote coin's supply is, what was burned and by whom, where the rest sits, what the developer wallet
// did with its own coins, and the same supply figures for every agent coin. All of it from chain reads.
//
// Three reads, each bounded:
//
//   snapshot   every pass (about every 5 minutes): the mint (supply, mint authority), the coin's pump.fun
//              bonding curve (the supply it was created with), every token account of the mint in one
//              getProgramAccounts call (owner and amount only), and the program accounts that say which
//              of those are compute vaults, pool vaults and escrows. About 8 calls.
//
//   wallet     the developer wallet's token accounts of the coin, each followed through its own
//              signature list with a cursor (the pattern of Indexer.syncSource): balance after each
//              transaction, what it bought, sold, sent, received and burned.
//
//   burns      the coin's mint has every trade in its signature list (23,340 signatures on its first
//              day), so reading all of it costs one getTransaction per trade, for ever. It is read only
//              when the chain says a burn is missing: the mint cannot be minted again, so
//
//                  created supply - supply now = everything ever burned
//
//              and while that equals the sum of the burn instructions already stored, nothing is fetched
//              (one getSignaturesForAddress with limit 1 moves the cursor to the head). When it does not,
//              the mint's signatures are read from the head backwards, one transaction at a time, until
//              the two agree again or the list down to the last agreed point is exhausted. Every
//              signature is fetched at most once: what is still unread is kept as ranges
//              (supply_ranges), so a restart resumes where it stopped. An agent coin is handled the same
//              way, with the head its own mint source already holds.
//
// Dollars follow the rule at the top of api.ts: a burn or a wallet movement at the reading stored for its
// own time, a balance now at the current reading, and no reading means no dollar figure.

export const SUPPLY_SCHEMA = `
CREATE TABLE IF NOT EXISTS burns (
  sig TEXT NOT NULL, idx INTEGER NOT NULL, mint TEXT NOT NULL, slot INTEGER NOT NULL, time INTEGER, account TEXT NOT NULL, authority TEXT NOT NULL,
  amount_raw TEXT NOT NULL, checked INTEGER NOT NULL, via TEXT, payer TEXT NOT NULL, PRIMARY KEY (sig, idx)
);
CREATE INDEX IF NOT EXISTS burns_mint ON burns (mint, slot);
CREATE TABLE IF NOT EXISTS supply_scan (
  mint TEXT PRIMARY KEY, top_sig TEXT, top_slot INTEGER, initial_raw TEXT, supply_raw TEXT, unmatched_raw TEXT, checked_at INTEGER,
  fetched INTEGER NOT NULL DEFAULT 0, pages INTEGER NOT NULL DEFAULT 0, last_error TEXT
);
CREATE TABLE IF NOT EXISTS supply_ranges (id INTEGER PRIMARY KEY AUTOINCREMENT, mint TEXT NOT NULL, before_sig TEXT NOT NULL, until_sig TEXT);
CREATE TABLE IF NOT EXISTS watch_accounts (
  account TEXT PRIMARY KEY, mint TEXT NOT NULL, owner TEXT NOT NULL, newest_sig TEXT, newest_slot INTEGER, txs INTEGER NOT NULL DEFAULT 0,
  fetched INTEGER NOT NULL DEFAULT 0, last_ok_at INTEGER, last_error TEXT
);
CREATE TABLE IF NOT EXISTS wallet_moves (
  sig TEXT NOT NULL, account TEXT NOT NULL, kind TEXT NOT NULL, mint TEXT NOT NULL, owner TEXT NOT NULL, slot INTEGER NOT NULL, time INTEGER,
  amount_raw TEXT NOT NULL, PRIMARY KEY (sig, account, kind)
);
CREATE TABLE IF NOT EXISTS wallet_balances (
  sig TEXT NOT NULL, account TEXT NOT NULL, mint TEXT NOT NULL, owner TEXT NOT NULL, slot INTEGER NOT NULL, time INTEGER, balance_raw TEXT NOT NULL,
  PRIMARY KEY (sig, account)
);
CREATE INDEX IF NOT EXISTS wallet_balances_owner ON wallet_balances (owner, mint, slot);
CREATE TABLE IF NOT EXISTS supply_coins (mint TEXT PRIMARY KEY, initial_raw TEXT, curve_raw TEXT, pool_raw TEXT, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS supply_state (k TEXT PRIMARY KEY, v TEXT NOT NULL, at INTEGER NOT NULL);
`;
const ready = new WeakSet<Database>();
export function ensureSupplySchema(db: Database) {
  if (ready.has(db)) return;
  db.exec(SUPPLY_SCHEMA);
  ready.add(db);
}

/** The seed of the fee keeper's burn account (packages/fee-keeper/src/plans.ts BURN_SEED): seededAddress(creator, seed, token program). */
export const KEEPER_BURN_SEED = "units-fee-keeper-burn";

// ---------------------------------------------------------------------------------------------------
// where the supply sits (pure)

export type Category = "liquidity_pool" | "compute_vaults" | "verifier_bonds" | "protocol_accounts" | "bounty_escrows" | "claims_and_pools" | "creator_fees"
  | "developer_wallet" | "wallets";
export const CATEGORIES: { key: Category; label: string; what: string }[] = [
  { key: "liquidity_pool", label: "Liquidity pool", what: "the coin side of its trading pool on PumpSwap (and of its pump.fun curve before that)" },
  { key: "wallets", label: "Held by wallets", what: "every other token account: holders' wallets, exchanges, other programs" },
  { key: "developer_wallet", label: "Developer wallet", what: "the token accounts of the project's developer wallet" },
  { key: "compute_vaults", label: "Agents' compute vaults", what: "what agents hold to pay for their model and sandbox use" },
  { key: "creator_fees", label: "Creator fees not collected yet", what: "trading fees of agent coins waiting to be split between the agent and the protocol" },
  { key: "verifier_bonds", label: "Verifier bonds", what: "bonds verifiers and agents posted with the registry" },
  { key: "protocol_accounts", label: "Protocol treasury and rewards", what: "the registry's treasury, reserve, reward pool, payable and challenge accounts" },
  { key: "bounty_escrows", label: "Bounty escrows", what: "rewards of open bounties, and the bounty program's fee account" },
  { key: "claims_and_pools", label: "Claim escrows and pool vaults", what: "fees routed to a repository's owner or to an agent pool, not claimed or spent yet" },
];

export interface Holding { account: string; owner: string; amountRaw: bigint }
/** The accounts and authorities that decide a token account's category; every entry comes from a chain read or a program address. */
export interface Known {
  poolVaults: ReadonlySet<string>;
  computeVaults: ReadonlySet<string>;
  agentPoolVaults: ReadonlySet<string>;
  launchBountyVaults: ReadonlySet<string>;
  /** owners (PDAs) of the creator fee accounts: ["pump_creator", agent] of every launch */
  creatorPdas: ReadonlySet<string>;
  launchAuthority: string;
  registryAuthority: string;
  bondVault: string;
  bountyAuthority: string;
  developerWallet: string | null;
}

export function categoryOf(h: { account: string; owner: string }, k: Known): Category {
  if (k.poolVaults.has(h.account)) return "liquidity_pool";
  if (k.computeVaults.has(h.account)) return "compute_vaults";
  if (h.account === k.bondVault) return "verifier_bonds";
  if (h.owner === k.registryAuthority) return "protocol_accounts";
  if (h.owner === k.bountyAuthority || k.launchBountyVaults.has(h.account)) return "bounty_escrows";
  if (k.agentPoolVaults.has(h.account) || h.owner === k.launchAuthority) return "claims_and_pools";
  if (k.creatorPdas.has(h.owner)) return "creator_fees";
  if (k.developerWallet && h.owner === k.developerWallet) return "developer_wallet";
  return "wallets";
}

export interface BreakdownRow { key: Category; accounts: number; amountRaw: bigint }
/**
 * The supply by where it sits. Every labelled category is the sum of its token accounts; "wallets" is
 * the supply minus those, so the rows add up to the supply read from the mint. `driftRaw` is that figure
 * minus the sum of the wallets' own accounts: zero when the mint and the accounts were read in the same
 * state (a burn or a transfer landing between the two reads shows here for one pass).
 */
export function breakdown(supplyRaw: bigint, holdings: Holding[], k: Known): { rows: BreakdownRow[]; driftRaw: bigint; accountsRaw: bigint } {
  const rows = new Map<Category, BreakdownRow>(CATEGORIES.map((c) => [c.key, { key: c.key, accounts: 0, amountRaw: 0n }]));
  let all = 0n;
  for (const h of holdings) {
    all += h.amountRaw;
    if (h.amountRaw === 0n) continue;
    const r = rows.get(categoryOf(h, k))!;
    r.accounts++;
    r.amountRaw += h.amountRaw;
  }
  const w = rows.get("wallets")!;
  const labelled = [...rows.values()].filter((r) => r.key !== "wallets").reduce((n, r) => n + r.amountRaw, 0n);
  const byAccounts = w.amountRaw;
  w.amountRaw = supplyRaw - labelled;
  return { rows: [...rows.values()], driftRaw: w.amountRaw - byAccounts, accountsRaw: all };
}

/**
 * The two burn figures: what the mint lost (created supply minus supply now) and the sum of the burn
 * instructions stored. They agree when equal; `unmatchedRaw` is the first minus the second.
 */
export function burnAgreement(initialRaw: bigint, supplyRaw: bigint, indexedRaw: bigint): { burnedRaw: bigint; indexedRaw: bigint; unmatchedRaw: bigint; agree: boolean } {
  const burnedRaw = initialRaw - supplyRaw;
  return { burnedRaw, indexedRaw, unmatchedRaw: burnedRaw - indexedRaw, agree: burnedRaw === indexedRaw };
}

// ---------------------------------------------------------------------------------------------------
// storage

export function storeBurns(db: Database, burns: Burn[]): number {
  ensureSupplySchema(db);
  const ins = db.prepare(`INSERT OR IGNORE INTO burns (sig, idx, mint, slot, time, account, authority, amount_raw, checked, via, payer) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  let n = 0;
  for (const b of burns) n += ins.run(b.sig, b.idx, b.mint, b.slot, b.time, b.account, b.authority, b.amountRaw.toString(), b.checked ? 1 : 0, b.via, b.payer).changes;
  return n;
}
export const indexedBurned = (db: Database, mint: string): bigint =>
  (db.query("SELECT amount_raw AS a FROM burns WHERE mint = ?").all(mint) as { a: string }[]).reduce((n, r) => n + BigInt(r.a), 0n);

interface SigRow { signature: string; slot: number; err: unknown; blockTime?: number | null }
interface Snapshot {
  mint: string; decimals: number; at: number; supply_raw: string; initial_raw: string | null; mint_authority: string | null;
  developer_wallet: string | null; keeper_burn_account: string | null;
  /** the coin's own market accounts that can sign for its vaults: its pump.fun curve and its PumpSwap pool (pump.fun burns from the pool's vault with the pool's authority) */
  market_authorities?: string[];
  /** null when the token accounts could not be listed: `breakdown_reason` says why */
  breakdown: { key: Category; accounts: number; amount_raw: string }[] | null;
  breakdown_reason: string | null;
  drift_raw: string | null; token_accounts: number | null; holders: number | null;
  entities: { kind: Category; owner: string | null; accounts: number; amount_raw: string }[];
  dev_accounts: { account: string; amount_raw: string }[];
}

export interface SupplyOpts {
  /** the project's developer wallet (the programs' admin); null: no wallet section */
  devWallet?: Address | null;
  /** most getTransaction calls one pass may make (default 400): a long history is read over several passes */
  maxFetchPerPass?: number;
  log?: (m: string) => void;
  now?: () => number;
}
export interface QuoteCoin { mint: Address; decimals: number; tokenProgram: Address }

export class SupplyIndexer {
  /** counters since this process started */
  counters = { passes: 0, rpc_calls: 0, transactions: 0, signature_pages: 0, last_pass_at: null as number | null, last_pass_ms: null as number | null, last_error: null as string | null };
  private readonly log: (m: string) => void;
  private readonly now: () => number;
  private readonly maxFetch: number;
  private poolVault: { mint: string; vaults: string[]; authorities: string[] } | null = null;
  private gpaRefused: string | null = null;

  constructor(
    readonly db: Database,
    readonly rpc: Rpc,
    /** one transaction by signature, whatever its version (Indexer.getTx) */
    readonly getTx: (sig: string) => Promise<RawTx | null>,
    readonly quote: () => QuoteCoin | null,
    readonly opts: SupplyOpts = {},
  ) {
    ensureSupplySchema(db);
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.maxFetch = opts.maxFetchPerPass ?? 400;
  }

  private call<T>(method: string, params: unknown[]): Promise<T> {
    this.counters.rpc_calls++;
    return this.rpc.call<T>(method, params);
  }
  private async accounts(addrs: Address[]) {
    this.counters.rpc_calls += Math.ceil(addrs.length / 100);
    return this.rpc.getMultipleAccounts(addrs);
  }
  private async programAccounts(program: Address, name: string) {
    this.counters.rpc_calls++;
    return this.rpc.getProgramAccounts(program, { memcmp: [{ offset: 0, bytes: accountDisc(name) }] });
  }
  private sigs(address: string, o: { before?: string; until?: string | null; limit?: number }): Promise<SigRow[]> {
    this.counters.signature_pages++;
    return this.call<SigRow[]>("getSignaturesForAddress", [address, { limit: o.limit ?? 1000, commitment: "confirmed", ...(o.before ? { before: o.before } : {}), ...(o.until ? { until: o.until } : {}) }]);
  }
  private async tx(sig: string, budget: { left: number }): Promise<RawTx | null> {
    budget.left--;
    this.counters.rpc_calls++;
    this.counters.transactions++;
    return this.getTx(sig);
  }

  /** One pass. `more` is true while a history read stopped at its budget: the caller runs the next pass at once. */
  async pass(): Promise<{ more: boolean }> {
    const q = this.quote();
    if (!q) return { more: false };
    const t0 = Date.now();
    const budget = { left: this.maxFetch };
    let more = false;
    try {
      const snap = await this.snapshot(q);
      if (this.opts.devWallet) more = (await this.syncWallet(q, this.opts.devWallet, snap.devAccounts, budget)) || more;
      if (snap.initialRaw !== null) more = (await this.scanMint(q.mint, snap.initialRaw, snap.supplyRaw, snap.head, () => this.readSupply(q.mint), budget)) || more;
      more = (await this.coins(budget)) || more;
      this.counters.last_error = null;
    } catch (e) {
      this.counters.last_error = String((e as Error).message).slice(0, 200);
      throw e;
    } finally {
      this.counters.passes++;
      this.counters.last_pass_at = this.now();
      this.counters.last_pass_ms = Date.now() - t0;
    }
    return { more };
  }

  private async readSupply(mint: string): Promise<bigint> {
    const [m] = await this.accounts([mint]);
    if (!m) throw new Error("the mint could not be read");
    return mintState(m.data).supply;
  }

  /** The quote coin now: supply, where it sits, its largest holders. Stored as one row (supply_state 'quote'). */
  private async snapshot(q: QuoteCoin): Promise<{ supplyRaw: bigint; initialRaw: bigint | null; head: SigRow | null; devAccounts: string[] }> {
    // the head of the mint's signature list BEFORE the supply: a supply that shows no missing burn then covers every signature up to it
    const head = (await this.sigs(q.mint, { limit: 1 }))[0] ?? null;
    const curveAddr = pumpPdas.bondingCurve(q.mint);
    const [mintA, curveA] = await this.accounts([q.mint, curveAddr]);
    if (!mintA) throw new Error("the quote coin's mint could not be read");
    const mint = mintState(mintA.data);
    const curve = curveA && curveA.owner === PUMP.program ? decodeBondingCurve(curveA.data) : null;
    // the coin side of its market: the curve's own account, and the PumpSwap pool's vault once it migrated (kept once found: the address never changes)
    let liquidity = this.poolVault?.mint === q.mint ? this.poolVault.vaults : null;
    let marketAuthorities = this.poolVault?.mint === q.mint ? this.poolVault.authorities : [curveAddr];
    if (!liquidity) {
      liquidity = [ata(curveAddr, q.mint, q.tokenProgram)];
      if (curve && curveMigrated(curve)) {
        const poolAddr = pumpPdas.pool(q.mint, curveQuoteMint(curve));
        const [poolA] = await this.accounts([poolAddr]);
        if (poolA && poolA.owner === PUMP.amm) {
          liquidity.push(decodePumpPool(poolA.data).poolBaseTokenAccount);
          marketAuthorities = [curveAddr, poolAddr];
          this.poolVault = { mint: q.mint, vaults: liquidity, authorities: marketAuthorities };
        }
      }
    }
    const dev = this.opts.devWallet ?? null;
    const keeperBurn = dev ? seededAddress(dev, KEEPER_BURN_SEED, q.tokenProgram) : null;
    const snap: Snapshot = { mint: q.mint, decimals: mint.decimals, at: this.now(), supply_raw: mint.supply.toString(), initial_raw: curve ? curve.tokenTotalSupply.toString() : null,
      mint_authority: mint.mintAuthority, developer_wallet: dev, keeper_burn_account: keeperBurn, market_authorities: marketAuthorities, breakdown: null, breakdown_reason: null, drift_raw: null, token_accounts: null,
      holders: null, entities: [], dev_accounts: [] };
    const devAccounts = new Set<string>(dev ? [ata(dev, q.mint, q.tokenProgram), keeperBurn!] : []);
    // an RPC that refuses to list a mint's token accounts (public devnet for Token-2022): the supply and the burns are still read
    let rows: { pubkey: string; account: { data: [string, string] } }[] | null = null;
    if (!this.gpaRefused) {
      try {
        rows = await this.call<{ pubkey: string; account: { data: [string, string] } }[]>("getProgramAccounts", [q.tokenProgram, {
          encoding: "base64", commitment: "confirmed", filters: [{ memcmp: { offset: 0, bytes: q.mint } }], dataSlice: { offset: 32, length: 40 } }]);
      } catch (e) {
        // only an RPC-level refusal switches the listing off; a transport failure fails the pass and is tried again
        if (!(e instanceof RpcError) || e.code === undefined) throw e;
        this.gpaRefused = String(e.message).slice(0, 160);
        this.log(`supply: the RPC does not list the coin's token accounts (${this.gpaRefused}); the breakdown and the holders are left out`);
      }
    }
    if (rows) {
      const holdings: Holding[] = [];
      for (const r of rows) {
        const d = new Uint8Array(Buffer.from(r.account.data[0], "base64"));
        if (d.length < 40) continue;
        holdings.push({ account: r.pubkey, owner: toAddress(d.subarray(0, 32)), amountRaw: new DataView(d.buffer, d.byteOffset).getBigUint64(32, true) });
      }
      const [launches, pools, bounties] = await Promise.all([this.programAccounts(LAUNCH_PROGRAM_ID, "AgentLaunch"), this.programAccounts(LAUNCH_PROGRAM_ID, "Pool"),
        this.programAccounts(LAUNCH_PROGRAM_ID, "Bounty")]);
      const agents = launches.map((a) => decodeAgentLaunch(a.data).agent);
      const known: Known = {
        poolVaults: new Set(liquidity), computeVaults: new Set(agents.map((a) => launchPdas.computeVault(a))),
        agentPoolVaults: new Set(pools.map((p) => decodePool(p.data).vault)), launchBountyVaults: new Set(bounties.map((b) => bountyPdas.vault(b.address))),
        creatorPdas: new Set(agents.map((a) => launchPdas.pumpCreator(a))), launchAuthority: launchPdas.authority(), registryAuthority: registryPdas.vaultAuthority(),
        bondVault: registryPdas.bondVault(), bountyAuthority: openBountyPdas.authority(), developerWallet: dev,
      };
      const b = breakdown(mint.supply, holdings, known);
      snap.breakdown = b.rows.map((r) => ({ key: r.key, accounts: r.accounts, amount_raw: r.amountRaw.toString() }));
      snap.drift_raw = b.driftRaw.toString();
      snap.token_accounts = holdings.length;
      // holders as a reader counts them: a wallet (or the developer wallet) once, however many accounts; each program category once
      const ent = new Map<string, { kind: Category; owner: string | null; accounts: number; amount: bigint }>();
      for (const h of holdings) {
        if (h.amountRaw === 0n) continue;
        const kind = categoryOf(h, known);
        const own = kind === "wallets" || kind === "developer_wallet";
        const key = own ? h.owner : kind;
        const e = ent.get(key) ?? ent.set(key, { kind, owner: own ? h.owner : null, accounts: 0, amount: 0n }).get(key)!;
        e.accounts++;
        e.amount += h.amountRaw;
        if (dev && h.owner === dev) devAccounts.add(h.account);
      }
      const sorted = [...ent.values()].sort((x, y) => (y.amount > x.amount ? 1 : y.amount < x.amount ? -1 : 0));
      snap.holders = sorted.filter((e) => e.owner !== null).length;
      snap.entities = sorted.slice(0, 200).map((e) => ({ kind: e.kind, owner: e.owner, accounts: e.accounts, amount_raw: e.amount.toString() }));
      snap.dev_accounts = holdings.filter((h) => dev && h.owner === dev).map((h) => ({ account: h.account, amount_raw: h.amountRaw.toString() }));
    } else {
      snap.breakdown_reason = "the RPC of this instance does not list the coin's token accounts";
      if (dev) {
        const accs = await this.accounts([...devAccounts] as Address[]);
        snap.dev_accounts = [...devAccounts].flatMap((a, i) => (accs[i] ? [{ account: a, amount_raw: readTokenAccount(accs[i]!.data).amount.toString() }] : []));
      }
    }
    this.db.query("INSERT OR REPLACE INTO supply_state (k, v, at) VALUES ('quote', ?, ?)").run(JSON.stringify(snap), snap.at);
    return { supplyRaw: mint.supply, initialRaw: curve ? curve.tokenTotalSupply : null, head, devAccounts: [...devAccounts] };
  }

  /** Follows each token account of the wallet through its own signature list, oldest first, cursor after each stored transaction. */
  private async syncWallet(q: QuoteCoin, owner: Address, accounts: string[], budget: { left: number }): Promise<boolean> {
    const add = this.db.prepare("INSERT OR IGNORE INTO watch_accounts (account, mint, owner) VALUES (?,?,?)");
    for (const a of accounts) add.run(a, q.mint, owner);
    let more = false;
    const mints = new Set([q.mint]);
    for (const w of this.db.query("SELECT account, newest_sig FROM watch_accounts WHERE mint = ? AND owner = ?").all(q.mint, owner) as { account: string; newest_sig: string | null }[]) {
      try {
        const list: SigRow[] = [];
        let before: string | undefined;
        for (;;) {
          const page = await this.sigs(w.account, { before, until: w.newest_sig });
          list.push(...page);
          if (page.length < 1000) break;
          before = page[page.length - 1]!.signature;
        }
        list.reverse();
        let stopped = false;
        for (const s of list) {
          let tx: RawTx | null = null;
          if (s.err == null) {
            if (budget.left <= 0) { stopped = more = true; break; }
            tx = await this.tx(s.signature, budget);
            if (!tx) { stopped = true; break; } // not served yet: resume from here on the next pass
          }
          this.db.transaction(() => {
            if (tx) {
              storeBurns(this.db, decodeBurns(tx, mints));
              const m = walletMoves(tx, w.account as Address, q.mint);
              for (const x of m.moves) this.db.query("INSERT OR IGNORE INTO wallet_moves (sig, account, kind, mint, owner, slot, time, amount_raw) VALUES (?,?,?,?,?,?,?,?)")
                .run(x.sig, x.account, x.kind, q.mint, owner, x.slot, x.time, x.amountRaw.toString());
              if (m.balanceAfterRaw !== null) this.db.query("INSERT OR IGNORE INTO wallet_balances (sig, account, mint, owner, slot, time, balance_raw) VALUES (?,?,?,?,?,?,?)")
                .run(s.signature, w.account, q.mint, owner, tx.slot, tx.blockTime ?? null, m.balanceAfterRaw.toString());
            }
            this.db.query("UPDATE watch_accounts SET newest_sig = ?, newest_slot = ?, txs = txs + 1, fetched = fetched + ? WHERE account = ?").run(s.signature, s.slot, tx ? 1 : 0, w.account);
          })();
        }
        if (!stopped) this.db.query("UPDATE watch_accounts SET last_ok_at = ?, last_error = NULL WHERE account = ?").run(this.now(), w.account);
      } catch (e) {
        this.db.query("UPDATE watch_accounts SET last_error = ? WHERE account = ?").run(String((e as Error).message).slice(0, 200), w.account);
        this.log(`supply: wallet account ${w.account}: ${(e as Error).message}`);
      }
    }
    return more;
  }

  /**
   * Makes the stored burns of `mint` agree with what its supply lost, reading its signature list only
   * while they do not (the file's header). Returns true when a range is left for the next pass.
   */
  async scanMint(mint: string, initialRaw: bigint, supplyRaw: bigint, head: { signature: string; slot: number } | null, readSupply: () => Promise<bigint>,
    budget: { left: number }): Promise<boolean> {
    const db = this.db;
    db.query("INSERT OR IGNORE INTO supply_scan (mint) VALUES (?)").run(mint);
    const note = (supply: bigint, unmatched: bigint) => db.query("UPDATE supply_scan SET initial_raw = ?, supply_raw = ?, unmatched_raw = ?, checked_at = ?, last_error = NULL WHERE mint = ?")
      .run(initialRaw.toString(), supply.toString(), unmatched.toString(), this.now(), mint);
    const gapOf = (supply: bigint) => initialRaw - supply - indexedBurned(db, mint);
    const settle = (supply: bigint, top: { signature: string; slot: number } | null) => db.transaction(() => {
      db.query("DELETE FROM supply_ranges WHERE mint = ?").run(mint);
      if (top) db.query("UPDATE supply_scan SET top_sig = ?, top_slot = ? WHERE mint = ?").run(top.signature, top.slot, mint);
      note(supply, gapOf(supply));
    })();
    let gap = gapOf(supplyRaw);
    // every burn the supply shows is stored: nothing to read, and every signature up to the head is covered
    if (gap <= 0n) { settle(supplyRaw, head); return false; }
    note(supplyRaw, gap);
    const mints = new Set([mint]);
    const state = () => db.query("SELECT top_sig FROM supply_scan WHERE mint = ?").get(mint) as { top_sig: string | null };

    /** Reads one range newest first. "closed": the figures agree; "done": the range is exhausted; "budget": stopped for this pass. */
    const run = async (r: { id: number | null; before: string | null; until: string | null }): Promise<"closed" | "done" | "budget"> => {
      for (;;) {
        const page = await this.sigs(mint, { before: r.before ?? undefined, until: r.until });
        db.query("UPDATE supply_scan SET pages = pages + 1 WHERE mint = ?").run(mint);
        for (const s of page) {
          let tx: RawTx | null = null;
          if (s.err == null) {
            if (budget.left <= 0) return "budget";
            tx = await this.tx(s.signature, budget);
            if (!tx) return "budget"; // not served yet: this range resumes from here on the next pass
          }
          const added = db.transaction(() => {
            const n = tx ? storeBurns(db, decodeBurns(tx, mints)) : 0;
            // the cursor moves with the stored rows: a range first seen is recorded with its newest signature as the new top
            if (r.id === null) {
              r.id = Number(db.query("INSERT INTO supply_ranges (mint, before_sig, until_sig) VALUES (?,?,?)").run(mint, s.signature, r.until).lastInsertRowid);
              db.query("UPDATE supply_scan SET top_sig = ?, top_slot = ? WHERE mint = ?").run(s.signature, s.slot, mint);
            } else db.query("UPDATE supply_ranges SET before_sig = ? WHERE id = ?").run(s.signature, r.id);
            if (tx) db.query("UPDATE supply_scan SET fetched = fetched + 1 WHERE mint = ?").run(mint);
            return n;
          })();
          r.before = s.signature;
          if (added > 0) {
            // a burn was found: the supply is read again, and when nothing is missing any more the rest of the list is not needed
            const supply = await readSupply();
            gap = gapOf(supply);
            if (gap <= 0n) { settle(supply, null); return "closed"; }
            note(supply, gap);
          }
        }
        if (page.length < 1000) {
          if (r.id !== null) db.query("DELETE FROM supply_ranges WHERE id = ?").run(r.id);
          return "done";
        }
      }
    };
    try {
      // what landed since the last pass (or everything, the first time), then the older ranges a previous pass left
      const first = await run({ id: null, before: null, until: state().top_sig });
      if (first === "closed") return false;
      if (first === "budget") return true;
      for (const r of db.query("SELECT id, before_sig, until_sig FROM supply_ranges WHERE mint = ? ORDER BY id DESC").all(mint) as { id: number; before_sig: string; until_sig: string | null }[]) {
        const res = await run({ id: r.id, before: r.before_sig, until: r.until_sig });
        if (res === "closed") return false;
        if (res === "budget") return true;
      }
    } catch (e) {
      db.query("UPDATE supply_scan SET last_error = ? WHERE mint = ?").run(String((e as Error).message).slice(0, 200), mint);
      throw e;
    }
    // the whole list was read and the supply still shows more than the burns found: stated as it is
    if (gap > 0n) this.log(`supply: ${mint}: ${gap} base units left the supply without a burn instruction in the mint's signature list`);
    return false;
  }

  /** Agent coins: the supply each was created with, what its curve and pool hold, and its burns (the same rule as the quote coin). */
  private async coins(budget: { left: number }): Promise<boolean> {
    const toks = this.db.query("SELECT mint, dbc_pool, dbc_base_vault, damm_base_vault, supply FROM tokens WHERE venue = 'pump'").all() as
      { mint: string; dbc_pool: string; dbc_base_vault: string; damm_base_vault: string | null; supply: string | null }[];
    if (!toks.length) return false;
    // the mint source's cursor BEFORE the accounts are read: a supply that shows no missing burn covers every signature up to it
    const heads = new Map((this.db.query("SELECT address, newest_sig, newest_slot FROM sources WHERE kind = 'mint'").all() as { address: string; newest_sig: string | null; newest_slot: number | null }[])
      .map((r) => [r.address, r.newest_sig ? { signature: r.newest_sig, slot: r.newest_slot ?? 0 } : null]));
    const addrs = toks.flatMap((t) => [t.mint, t.dbc_pool, t.dbc_base_vault, ...(t.damm_base_vault ? [t.damm_base_vault] : [])]) as Address[];
    const accs = await this.accounts(addrs);
    const by = new Map(addrs.map((a, i) => [a as string, accs[i] ?? null]));
    const at = this.now();
    let more = false;
    for (const t of toks) {
      const m = by.get(t.mint), c = by.get(t.dbc_pool);
      // the token row went while the accounts were read (purged.ts): nothing is written for it
      if (!m || !this.db.query("SELECT 1 FROM tokens WHERE mint = ?").get(t.mint)) continue;
      const curve = c && c.owner === PUMP.program ? decodeBondingCurve(c.data) : null;
      const amount = (a: string | null) => (a && by.get(a) ? readTokenAccount(by.get(a)!.data).amount.toString() : a ? "0" : null);
      this.db.query("INSERT OR REPLACE INTO supply_coins (mint, initial_raw, curve_raw, pool_raw, at) VALUES (?,?,?,?,?)")
        .run(t.mint, curve ? curve.tokenTotalSupply.toString() : null, amount(t.dbc_base_vault), amount(t.damm_base_vault), at);
      if (!curve) continue;
      try {
        more = (await this.scanMint(t.mint, curve.tokenTotalSupply, mintState(m.data).supply, heads.get(t.mint) ?? null, () => this.readSupply(t.mint), budget)) || more;
      } catch (e) {
        this.log(`supply: ${t.mint}: ${(e as Error).message}`);
      }
    }
    return more;
  }

  status() {
    const scans = this.db.query("SELECT mint, top_slot, unmatched_raw, checked_at, fetched, pages, last_error FROM supply_scan").all() as
      { mint: string; top_slot: number | null; unmatched_raw: string | null; checked_at: number | null; fetched: number; pages: number; last_error: string | null }[];
    const ranges = (this.db.query("SELECT COUNT(*) AS n FROM supply_ranges").get() as { n: number }).n;
    const q = this.quote();
    const own = scans.find((s) => s.mint === q?.mint);
    return { ...this.counters, burns: (this.db.query("SELECT COUNT(*) AS n FROM burns").get() as { n: number }).n, unread_ranges: ranges,
      quote: own ? { unmatched_raw: own.unmatched_raw, checked_at: own.checked_at, transactions_read: own.fetched, last_error: own.last_error } : null,
      coins_unmatched: scans.filter((s) => s.mint !== q?.mint && s.unmatched_raw !== null && s.unmatched_raw !== "0").length };
  }
}

/** Supply, decimals and mint authority of an SPL Token or Token-2022 mint (the first 82 bytes are shared). */
export function mintState(d: Uint8Array): { supply: bigint; decimals: number; mintAuthority: string | null } {
  if (d.length < 82) throw new Error("not a mint");
  const v = new DataView(d.buffer, d.byteOffset, d.length);
  return { mintAuthority: v.getUint32(0, true) === 1 ? toAddress(d.subarray(4, 36)) : null, supply: v.getBigUint64(36, true), decimals: d[44]! };
}

// ---------------------------------------------------------------------------------------------------
// the read API: GET /market/supply, /market/supply/burns, /developer, /coins, /holders

export interface SupplyApiOpts { now: () => number; usd: () => QuoteUsdReading; quote: string }
const ui = (raw: string | bigint | null | undefined, decimals: number) => (raw == null ? null : Number(BigInt(raw)) / 10 ** decimals);
const frac = (part: bigint, whole: bigint) => (whole > 0n ? Number((part * 1_000_000_000n) / whole) / 1e9 : null);
const short = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
const repoName = (u: string | null | undefined) => {
  const m = /github\.com\/([^/\s]+\/[^/\s#?]+?)(?:\.git)?\/?$/.exec(u ?? "");
  return m ? m[1]! : null;
};
type BurnRow = { sig: string; idx: number; mint: string; slot: number; time: number | null; account: string; authority: string; amount_raw: string; via: string | null; payer: string };

export function supplyApi(db: Database, opts: SupplyApiOpts) {
  ensureSupplySchema(db);
  const snapshot = () => {
    const r = db.query("SELECT v FROM supply_state WHERE k = 'quote'").get() as { v: string } | null;
    return r ? (JSON.parse(r.v) as Snapshot) : null;
  };
  const rateOf = (u: QuoteUsdReading) => (u.ok ? u.usd : null);
  const inUsd = (v: number | null, rate: number | null) => (v == null || rate == null ? null : v * rate);
  /** who signed a burn, in the page's words; every label is a chain fact (an address match or a program's PDA) */
  const signers = (s: Snapshot | null) => {
    // an agent pool burns with its own authority PDA: ["pool_auth", repo id], named by the repository of a member
    const pools = new Map<string, string>();
    try {
      for (const e of db.query("SELECT e.detail, t.repo_url FROM events e LEFT JOIN tokens t ON t.mint = e.mint WHERE e.kind = 'pool_joined'").all() as { detail: string; repo_url: string | null }[]) {
        const d = JSON.parse(e.detail) as { repo_id?: string };
        if (d.repo_id && /^[0-9a-f]{64}$/.test(d.repo_id)) pools.set(poolPdas.auth(hexToBytes(d.repo_id)), repoName(e.repo_url) ?? `${d.repo_id.slice(0, 8)}`);
      }
    } catch {
      /* a database without the events table */
    }
    return (b: { authority: string; account: string }): { kind: "developer" | "fee_keeper" | "agent_pool" | "liquidity_pool" | "address"; label: string; address: string } => {
      // pump.fun burning from the coin's own pool or curve: the authority is that pool or curve
      if (s?.market_authorities?.includes(b.authority)) return { kind: "liquidity_pool", label: "Liquidity pool (pump.fun)", address: b.authority };
      if (s?.keeper_burn_account && b.account === s.keeper_burn_account) return { kind: "fee_keeper", label: "Fee keeper", address: b.authority };
      if (s?.developer_wallet && b.authority === s.developer_wallet) return { kind: "developer", label: "Developer wallet", address: b.authority };
      const p = pools.get(b.authority);
      if (p) return { kind: "agent_pool", label: `Agent pool ${p}`, address: b.authority };
      return { kind: "address", label: short(b.authority), address: b.authority };
    };
  };
  /** the program a burn ran inside, when one of ours or pump.fun's */
  const viaLabel = (via: string | null) => (via === null ? null : via === REGISTRY_PROGRAM_ID ? "registry program" : via === LAUNCH_PROGRAM_ID ? "launch program" : via === BOUNTY_PROGRAM_ID ? "bounty program"
    : via === PUMP.program || via === PUMP.amm ? "pump.fun" : null);
  const burnsOf = (mint: string) => db.query("SELECT sig, idx, mint, slot, time, account, authority, amount_raw, via, payer FROM burns WHERE mint = ? ORDER BY slot, sig, idx").all(mint) as BurnRow[];
  const scanOf = (mint: string) => db.query("SELECT * FROM supply_scan WHERE mint = ?").get(mint) as
    { top_sig: string | null; initial_raw: string | null; supply_raw: string | null; unmatched_raw: string | null; checked_at: number | null; fetched: number; pages: number; last_error: string | null } | null;
  const rangesOf = (mint: string) => (db.query("SELECT COUNT(*) AS n FROM supply_ranges WHERE mint = ?").get(mint) as { n: number }).n;
  /** dollars of a set of events, each at the reading of its own time; null when one of them has no reading (the sum then has no dollar value) */
  const sumAt = (rows: { time: number | null; amount: number }[], at: (t: number | null) => number | null) => {
    let s: number | null = 0;
    for (const r of rows) {
      const rate = at(r.time);
      if (rate == null) return null;
      s! += r.amount * rate;
    }
    return s;
  };
  const lookup = (rows: { time: number | null }[]) => {
    const ts = rows.map((r) => r.time).filter((x): x is number => x != null);
    return ts.length ? usdNear(db, Math.min(...ts), Math.max(...ts)) : () => null;
  };
  const NOT_READ = "the supply has not been read yet";

  function overview() {
    const s = snapshot();
    const reading = opts.usd();
    if (!s) return { quote: opts.quote, ok: false, reason: NOT_READ, usd: reading };
    const cur = rateOf(reading);
    const d = s.decimals;
    const supply = BigInt(s.supply_raw);
    const initial = s.initial_raw === null ? null : BigInt(s.initial_raw);
    const rows = burnsOf(s.mint);
    const indexed = rows.reduce((n, r) => n + BigInt(r.amount_raw), 0n);
    const ag = initial === null ? null : burnAgreement(initial, supply, indexed);
    const at = lookup(rows);
    const who = signers(s);
    const groups = new Map<string, { kind: string; label: string; address: string | null; raw: bigint; events: { time: number | null; amount: number }[] }>();
    for (const r of rows) {
      const w = who(r);
      const key = w.kind === "address" ? "other" : w.kind === "agent_pool" ? `pool:${w.address}` : w.kind;
      const g = groups.get(key) ?? groups.set(key, { kind: w.kind, label: w.kind === "address" ? "Other wallets" : w.label, address: w.kind === "address" ? null : w.address, raw: 0n, events: [] }).get(key)!;
      g.raw += BigInt(r.amount_raw);
      g.events.push({ time: r.time, amount: ui(r.amount_raw, d)! });
    }
    const dev = groups.get("developer");
    const devBal = s.dev_accounts.reduce((n, a) => n + BigInt(a.amount_raw), 0n);
    const scan = scanOf(s.mint);
    const reading_history = rangesOf(s.mint) > 0;
    const walletEnts = s.entities.filter((e) => e.kind === "wallets" || e.kind === "developer_wallet");
    const top = (xs: typeof s.entities) => xs.slice(0, 10).reduce((n, e) => n + BigInt(e.amount_raw), 0n);
    return {
      quote: opts.quote, ok: true, mint: s.mint, decimals: d, as_of: s.at, usd: reading,
      // the supply the coin was created with, from its pump.fun bonding curve; null when the curve could not be read
      initial_supply: ui(initial, d), initial_supply_raw: s.initial_raw, initial_source: "the coin's pump.fun bonding curve (token_total_supply)",
      supply: ui(supply, d), supply_raw: s.supply_raw, supply_usd: inUsd(ui(supply, d), cur),
      // null: nobody can mint more, so the supply only falls and what it lost is what was burned
      mint_authority: s.mint_authority,
      burned: ag === null ? null : {
        amount: ui(ag.burnedRaw, d), raw: ag.burnedRaw.toString(), share_of_initial: frac(ag.burnedRaw, initial!),
        // the same figure counted the other way: the sum of the stored burn instructions; `agree` when the two are equal
        indexed_raw: indexed.toString(), indexed_events: rows.length, unmatched_raw: ag.unmatchedRaw.toString(), unmatched: ui(ag.unmatchedRaw, d), agree: ag.agree,
        // reading: the mint's history is still being read; unmatched: all of it was read and the supply lost more than the burns found
        state: ag.agree ? "agree" : reading_history || scan === null ? "reading" : "unmatched",
        // dollars at the reading of each burn's own time; null when one of them has no reading on record (never today's price in its place)
        usd_at_burn: sumAt(rows.map((r) => ({ time: r.time, amount: ui(r.amount_raw, d)! })), at),
        first_at: rows.length ? rows[0]!.time : null, last_at: rows.length ? rows[rows.length - 1]!.time : null,
        by_signer: [...groups.values()].sort((a, b) => (b.raw > a.raw ? 1 : -1)).map((g) => ({ kind: g.kind, label: g.label, address: g.address, events: g.events.length, amount: ui(g.raw, d),
          raw: g.raw.toString(), share_of_initial: frac(g.raw, initial!), usd_at_burn: sumAt(g.events, at) })),
      },
      developer: s.developer_wallet ? {
        wallet: s.developer_wallet, balance: ui(devBal, d), balance_raw: devBal.toString(), balance_usd: inUsd(ui(devBal, d), cur), share: frac(devBal, supply),
        burned: { events: dev?.events.length ?? 0, amount: ui(dev?.raw ?? 0n, d), raw: (dev?.raw ?? 0n).toString(), share_of_initial: initial === null ? null : frac(dev?.raw ?? 0n, initial),
          usd_at_burn: dev ? sumAt(dev.events, at) : 0 },
      } : null,
      breakdown: s.breakdown ? CATEGORIES.map((c) => {
        const r = s.breakdown!.find((x) => x.key === c.key)!;
        return { key: c.key, label: c.label, what: c.what, accounts: r.accounts, amount: ui(r.amount_raw, d), amount_raw: r.amount_raw, share: frac(BigInt(r.amount_raw), supply), usd: inUsd(ui(r.amount_raw, d), cur) };
      }) : null,
      breakdown_reason: s.breakdown_reason,
      // the supply minus the labelled accounts, less the sum of the wallets' own accounts: 0 when the mint and the accounts were read in the same state
      drift_raw: s.drift_raw,
      holders: s.breakdown ? { wallets: s.holders, token_accounts: s.token_accounts, top10_share: frac(top(s.entities), supply), top10_wallets_share: frac(top(walletEnts), supply) } : null,
    };
  }

  function burns(q: URLSearchParams) {
    const s = snapshot();
    const reading = opts.usd();
    if (!s) return { quote: opts.quote, ok: false, reason: NOT_READ, usd: reading, events: [], days: [] };
    const asked = q.get("mint");
    const tok = asked && asked !== s.mint ? (db.query("SELECT mint, decimals, symbol FROM tokens WHERE mint = ?").get(asked) as { mint: string; decimals: number; symbol: string | null } | null) : null;
    if (asked && asked !== s.mint && !tok) return null;
    const mint = tok?.mint ?? s.mint, d = tok?.decimals ?? s.decimals;
    const own = mint === s.mint;
    const who = signers(s);
    const all = burnsOf(mint).map((r) => ({ r, w: who(r) }));
    const signer = q.get("signer");
    const picked = all.filter(({ w }) => !signer || signer === "all" || (signer === "developer" ? w.kind === "developer" : signer === "fee_keeper" ? w.kind === "fee_keeper" : signer === "agent_pool" ? w.kind === "agent_pool"
      : signer === "liquidity_pool" ? w.kind === "liquidity_pool" : signer === "other" ? w.kind === "address" : w.address === signer));
    // dollars exist for the quote coin only: an agent coin's burn has no stored dollar price of its own time
    const at = own ? lookup(picked.map((x) => x.r)) : () => null;
    const day = (t: number) => Math.floor(t / 86400) * 86400;
    const days = new Map<number, { t: number; raw: bigint; events: number; usd: number | null }>();
    const events = picked.map(({ r, w }) => {
      const amount = ui(r.amount_raw, d)!;
      const usd = inUsd(amount, at(r.time));
      if (r.time != null) {
        const g = days.get(day(r.time)) ?? days.set(day(r.time), { t: day(r.time), raw: 0n, events: 0, usd: 0 }).get(day(r.time))!;
        g.raw += BigInt(r.amount_raw);
        g.events++;
        g.usd = g.usd === null || usd === null ? null : g.usd + usd;
      }
      return { signature: r.sig, index: r.idx, slot: r.slot, time: r.time, amount, amount_raw: r.amount_raw, usd, usd_basis: usd === null ? null : "at_time",
        signer: w, account: r.account, via: r.via, via_label: viaLabel(r.via), payer: r.payer };
    });
    // every UTC day from the first burn to today, so a day without a burn is a day with nothing burned, and the running total
    const list: { t: number; amount: number; amount_raw: string; usd: number | null; events: number; cumulative: number; cumulative_raw: string }[] = [];
    if (days.size) {
      let cum = 0n;
      const first = Math.min(...days.keys()), last = Math.max(day(opts.now()), ...days.keys());
      for (let t = first; t <= last; t += 86400) {
        const g = days.get(t);
        cum += g?.raw ?? 0n;
        list.push({ t, amount: ui(g?.raw ?? 0n, d)!, amount_raw: (g?.raw ?? 0n).toString(), usd: g ? g.usd : 0, events: g?.events ?? 0, cumulative: ui(cum, d)!, cumulative_raw: cum.toString() });
      }
    }
    const limit = Math.min(500, Math.max(1, Number(q.get("limit")) || 100));
    const total = picked.reduce((n, x) => n + BigInt(x.r.amount_raw), 0n);
    return { quote: opts.quote, ok: true, mint, decimals: d, usd: reading, signer: signer ?? "all", count: events.length, amount: ui(total, d), amount_raw: total.toString(),
      usd_at_burn: own ? sumAt(picked.map((x) => ({ time: x.r.time, amount: ui(x.r.amount_raw, d)! })), at) : null,
      // how many of all the coin's burns each filter holds
      signers: { all: all.length, developer: all.filter((x) => x.w.kind === "developer").length, fee_keeper: all.filter((x) => x.w.kind === "fee_keeper").length,
        agent_pool: all.filter((x) => x.w.kind === "agent_pool").length, liquidity_pool: all.filter((x) => x.w.kind === "liquidity_pool").length, other: all.filter((x) => x.w.kind === "address").length },
      days: list, events: events.reverse().slice(0, limit) };
  }

  function developer(q: URLSearchParams) {
    const s = snapshot();
    const reading = opts.usd();
    if (!s) return { quote: opts.quote, ok: false, reason: NOT_READ, usd: reading };
    if (!s.developer_wallet) return { quote: opts.quote, ok: false, reason: "no developer wallet is set on this instance", usd: reading };
    const d = s.decimals, w = s.developer_wallet, cur = rateOf(reading);
    const bal = s.dev_accounts.reduce((n, a) => n + BigInt(a.amount_raw), 0n);
    const moves = db.query("SELECT sig, account, kind, slot, time, amount_raw FROM wallet_moves WHERE owner = ? AND mint = ? ORDER BY slot, sig").all(w, s.mint) as
      { sig: string; account: string; kind: string; slot: number; time: number | null; amount_raw: string }[];
    const points = db.query("SELECT sig, account, slot, time, balance_raw FROM wallet_balances WHERE owner = ? AND mint = ? ORDER BY slot, sig").all(w, s.mint) as
      { sig: string; account: string; slot: number; time: number | null; balance_raw: string }[];
    const at = lookup(moves);
    // the wallet's balance after each transaction: the last balance seen of each of its token accounts, summed
    const last = new Map<string, bigint>();
    const history = points.map((p) => {
      last.set(p.account, BigInt(p.balance_raw));
      const total = [...last.values()].reduce((n, x) => n + x, 0n);
      return { time: p.time, slot: p.slot, signature: p.sig, balance: ui(total, d), balance_raw: total.toString() };
    });
    const kinds = ["bought", "sold", "sent", "received", "burned"] as const;
    const activity = Object.fromEntries(kinds.map((k) => {
      const rows = moves.filter((m) => m.kind === k);
      const raw = rows.reduce((n, r) => n + BigInt(r.amount_raw), 0n);
      return [k, { count: rows.length, amount: ui(raw, d), amount_raw: raw.toString(), usd_at_time: sumAt(rows.map((r) => ({ time: r.time, amount: ui(r.amount_raw, d)! })), at) }];
    }));
    const synced = db.query("SELECT account, txs, fetched, last_ok_at, last_error, newest_slot FROM watch_accounts WHERE owner = ? AND mint = ?").all(w, s.mint) as
      { account: string; txs: number; fetched: number; last_ok_at: number | null; last_error: string | null; newest_slot: number | null }[];
    const limit = Math.min(500, Math.max(1, Number(q.get("limit")) || 100));
    return { quote: opts.quote, ok: true, wallet: w, mint: s.mint, decimals: d, as_of: s.at, usd: reading,
      balance: ui(bal, d), balance_raw: bal.toString(), balance_usd: inUsd(ui(bal, d), cur), share: frac(bal, BigInt(s.supply_raw)),
      accounts: s.dev_accounts.map((a) => ({ account: a.account, balance: ui(a.amount_raw, d), balance_raw: a.amount_raw, fee_keeper: a.account === s.keeper_burn_account })),
      // false until every token account of the wallet has been read to the head of its signature list
      synced: synced.length > 0 && synced.every((x) => x.last_ok_at !== null), transactions: synced.reduce((n, x) => n + x.txs, 0),
      activity, history,
      moves: moves.slice().reverse().slice(0, limit).map((m) => {
        const amount = ui(m.amount_raw, d)!;
        const usd = inUsd(amount, at(m.time));
        return { signature: m.sig, time: m.time, slot: m.slot, kind: m.kind, amount, amount_raw: m.amount_raw, usd, usd_basis: usd === null ? null : "at_time", account: m.account };
      }) };
  }

  function coins(q: URLSearchParams) {
    const s = snapshot();
    const reading = opts.usd();
    const cur = rateOf(reading);
    const withHidden = q.get("hidden") === "1";
    let hidden = new Set<string>();
    try {
      hidden = new Set((db.query("SELECT mint FROM hidden_mints").all() as { mint: string }[]).map((r) => r.mint));
    } catch {
      /* no Core sync on this database yet */
    }
    const toks = (db.query("SELECT mint, agent, launcher, name, symbol, decimals, supply, spot_price, venue, state_at, holders_at FROM tokens WHERE venue = 'pump' ORDER BY created_at").all() as
      { mint: string; agent: string; launcher: string; name: string | null; symbol: string | null; decimals: number; supply: string | null; spot_price: number | null; state_at: number | null; holders_at: number | null }[])
      .filter((t) => withHidden || !hidden.has(t.mint));
    const names = new Map<string, string | null>();
    try {
      for (const r of db.query("SELECT agent, name FROM core_agents").all() as { agent: string; name: string | null }[]) names.set(r.agent, r.name);
    } catch {
      /* no Core sync on this database yet */
    }
    const rows = toks.map((t) => {
      const d = t.decimals;
      const sc = db.query("SELECT initial_raw, curve_raw, pool_raw, at FROM supply_coins WHERE mint = ?").get(t.mint) as { initial_raw: string | null; curve_raw: string | null; pool_raw: string | null; at: number } | null;
      const supply = t.supply === null ? null : BigInt(t.supply);
      const initial = sc?.initial_raw == null ? null : BigInt(sc.initial_raw);
      const indexed = indexedBurned(db, t.mint);
      const ag = supply !== null && initial !== null ? burnAgreement(initial, supply, indexed) : null;
      const holders = (db.query("SELECT owner, amount FROM holders WHERE mint = ?").all(t.mint) as { owner: string; amount: string }[])
        .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : BigInt(b.amount) < BigInt(a.amount) ? -1 : 0));
      const own = holders.find((h) => h.owner === t.agent);
      const top = holders[0] ?? null;
      const inPool = sc && (sc.curve_raw !== null || sc.pool_raw !== null) ? BigInt(sc.curve_raw ?? "0") + BigInt(sc.pool_raw ?? "0") : null;
      const share = (raw: bigint | null) => (raw === null || supply === null ? null : frac(raw, supply));
      const cap = t.spot_price != null && supply !== null ? t.spot_price * ui(supply, d)! : null;
      return {
        mint: t.mint, agent: t.agent, agent_name: names.get(t.agent) ?? null, name: t.name, symbol: t.symbol, hidden: hidden.has(t.mint), decimals: d,
        supply: ui(supply, d), supply_raw: t.supply, initial_supply: ui(initial, d), initial_supply_raw: sc?.initial_raw ?? null,
        burned: ag ? ui(ag.burnedRaw, d) : null, burned_raw: ag ? ag.burnedRaw.toString() : null, burned_share: ag && initial ? frac(ag.burnedRaw, initial) : null,
        burned_indexed_raw: indexed.toString(), burned_agree: ag ? ag.agree : null,
        // the agent's own token accounts of its coin; null until the holders were read
        agent_amount: t.holders_at === null ? null : ui(own?.amount ?? "0", d), agent_share: t.holders_at === null ? null : share(BigInt(own?.amount ?? "0")),
        pool_amount: ui(inPool, d), pool_share: share(inPool),
        top_holder: top ? { owner: top.owner, label: top.owner === t.agent ? "the agent" : top.owner === t.launcher ? "its launcher" : s?.developer_wallet && top.owner === s.developer_wallet ? "Developer wallet" : short(top.owner),
          amount: ui(top.amount, d), share: share(BigInt(top.amount)) } : null,
        market_cap: cap, market_cap_usd: inUsd(cap, cur), as_of: sc?.at ?? t.state_at,
      };
    });
    const sum = (f: (r: (typeof rows)[number]) => number | null) => rows.reduce<number | null>((n, r) => { const v = f(r); return n === null || v === null ? null : n + v; }, 0);
    return { quote: opts.quote, ok: true, usd: reading, coins: rows,
      totals: { coins: rows.length, supply: sum((r) => r.supply), burned: sum((r) => r.burned), with_burns: rows.filter((r) => (r.burned ?? 0) > 0).length,
        market_cap_usd: sum((r) => r.market_cap_usd) } };
  }

  function holders(q: URLSearchParams) {
    const s = snapshot();
    const reading = opts.usd();
    if (!s) return { quote: opts.quote, ok: false, reason: NOT_READ, usd: reading, top: [] };
    if (!s.breakdown) return { quote: opts.quote, ok: false, reason: s.breakdown_reason ?? "the holders could not be read", usd: reading, top: [] };
    const cur = rateOf(reading), d = s.decimals, supply = BigInt(s.supply_raw);
    const limit = Math.min(200, Math.max(1, Number(q.get("limit")) || 20));
    const label = (e: Snapshot["entities"][number]) => (e.kind === "wallets" ? short(e.owner!) : CATEGORIES.find((c) => c.key === e.kind)!.label);
    const walletEnts = s.entities.filter((e) => e.kind === "wallets" || e.kind === "developer_wallet");
    const top = (xs: typeof s.entities) => frac(xs.slice(0, 10).reduce((n, e) => n + BigInt(e.amount_raw), 0n), supply);
    return { quote: opts.quote, ok: true, mint: s.mint, decimals: d, as_of: s.at, usd: reading, wallets: s.holders, token_accounts: s.token_accounts,
      concentration: { top10_share: top(s.entities), top10_wallets_share: top(walletEnts),
        definition: "top10_share: the ten largest holders of any kind, the liquidity pool and program accounts included; top10_wallets_share: the ten largest wallets only" },
      top: s.entities.slice(0, limit).map((e, i) => ({ rank: i + 1, kind: e.kind, owner: e.owner, label: label(e), accounts: e.accounts, amount: ui(e.amount_raw, d), amount_raw: e.amount_raw,
        share: frac(BigInt(e.amount_raw), supply), usd: inUsd(ui(e.amount_raw, d), cur) })) };
  }

  /** `rest`: the path after /market/supply. null: no such route (or an unknown mint). */
  return function route(rest: string[], q: URLSearchParams): unknown | null {
    if (rest.length === 0) return overview();
    if (rest.length !== 1) return null;
    if (rest[0] === "burns") return burns(q);
    if (rest[0] === "developer") return developer(q);
    if (rest[0] === "coins") return coins(q);
    if (rest[0] === "holders") return holders(q);
    return null;
  };
}
