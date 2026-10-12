import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bytesToHex, sha256, type Address } from "./codec.ts";
import { evaluate, lookupTablesOf, mintsNamed, parseMessageStrict, swapNamed, type CoreCheck, type FirewallContext, type FirewallLimits, type MintFacts, type Verdict } from "./firewall.ts";
import { FirewallRefusal, installAuthorizer } from "./guard.ts";
import { decodeAgentLaunch, decodeLaunchConfig, launchPdas, type LaunchConfig } from "./launch.ts";
import { ata, TOKEN_2022_PROGRAM } from "./pda.ts";
import { LAUNCH_PROGRAM_ID } from "./programs.ts";
import { decodeBondingCurve, decodePumpPool, PUMP, pumpPdas } from "./pump.ts";
import type { Rpc } from "./rpc.ts";
import { decodeMint, decodeTokenAccount } from "./spl.ts";
import { ALT_PROGRAM, decodeLookupTable } from "./v0.ts";

// The firewall as a running thing (docs/plans/AGENT-WALLET-SAFETY.md section 3.1): for each
// (guarded key, message) it reads the facts the policy needs from chain itself (the launch config,
// the AgentLaunch record, curve and pool of every mint the message names, every lookup table), reads
// the limits and the key's identity from the callbacks the runtime gave it, evaluates the pure
// policy (firewall.ts), charges the day ledger and appends the decision to firewall.jsonl. A refusal
// throws FirewallRefusal; only a return lets guard.ts issue the signing ticket.

export interface FirewallIdentity {
  /** the agent this treasury key signs for */
  agent: Address;
  /** that agent's own token, when known */
  ownMint: Address | null;
}

export interface AgentFirewallOptions {
  rpc: Rpc;
  /** the agent a guarded key belongs to, from the runtime's own state (never from a transaction) */
  identity(key: Address): FirewallIdentity | null;
  /** the trading config's firewall limits; null or a throw: no swap is signed */
  limits(): Promise<FirewallLimits | null>;
  /**
   * Core's answer for one swap (GET /v1/trading/check). An absent callback, null or a throw: Core
   * could not be asked, and no buy is signed.
   */
  coreCheck?(agent: Address, mint: Address, side: "buy" | "sell"): Promise<CoreCheck | null>;
  /** where the day ledger and the decision log live (mode 700) */
  dir: string;
  now?: () => number;
  log?: (m: string) => void;
}

export interface FirewallLogRow {
  at: number;
  key: Address;
  agent: Address | null;
  ok: boolean;
  kind: string | null;
  rule: string | null;
  detail: string;
  value: string;
  message_sha256: string;
}

const U64_MAX = (1n << 64n) - 1n;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class AgentFirewall {
  private now: () => number;
  private log: (m: string) => void;
  private lc: LaunchConfig | null = null;
  private ledgerFile: string;
  private logFile: string;
  private ledger: Record<Address, { day: string; spent: string }> = {};
  /** one decision at a time: the ledger read, the verdict and the charge are not interleaved */
  private chain: Promise<unknown> = Promise.resolve();
  /** counts since start, by rule ("allowed" for allows) */
  readonly counts: Record<string, number> = {};

  constructor(private o: AgentFirewallOptions) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => {});
    mkdirSync(o.dir, { recursive: true, mode: 0o700 });
    this.ledgerFile = join(o.dir, "firewall-ledger.json");
    this.logFile = join(o.dir, "firewall.jsonl");
    if (existsSync(this.ledgerFile)) {
      try {
        this.ledger = JSON.parse(readFileSync(this.ledgerFile, "utf8"));
      } catch {
        // an unreadable ledger must not reopen the day's budget: every key starts the day as spent
        this.ledger = {};
        this.poisoned = true;
        this.log("firewall: the day ledger is unreadable; swaps are refused until the next UTC day");
      }
    }
  }
  private poisoned = false;
  private poisonedDay = dayOf(Date.now());

  /** Makes this firewall the one every guarded key in this process answers to. */
  install(): this {
    installAuthorizer((key, message) => this.authorize(key, message).then(() => undefined));
    return this;
  }

  /** Quote value already authorized for `key` today. */
  spentToday(key: Address): bigint {
    const day = dayOf(this.now());
    if (this.poisoned && this.poisonedDay === day) return U64_MAX;
    const e = this.ledger[key];
    return e && e.day === day ? BigInt(e.spent) : 0n;
  }

  private charge(key: Address, value: bigint) {
    if (value <= 0n) return;
    const day = dayOf(this.now());
    const cur = this.ledger[key];
    this.ledger[key] = { day, spent: ((cur && cur.day === day ? BigInt(cur.spent) : 0n) + value).toString() };
    const tmp = `${this.ledgerFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.ledger), { mode: 0o600 });
    renameSync(tmp, this.ledgerFile);
  }

  private record(row: FirewallLogRow) {
    this.counts[row.ok ? "allowed" : (row.rule ?? "refused")] = (this.counts[row.ok ? "allowed" : (row.rule ?? "refused")] ?? 0) + 1;
    try {
      if (existsSync(this.logFile) && statSync(this.logFile).size > LOG_ROTATE_BYTES) renameSync(this.logFile, `${this.logFile}.1`);
      appendFileSync(this.logFile, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    } catch (e) {
      this.log(`firewall: decision log not written: ${(e as Error).message}`);
    }
  }

  private async launchConfig(): Promise<LaunchConfig> {
    if (this.lc) return this.lc;
    const a = await this.o.rpc.getAccountInfo(launchPdas.config());
    if (!a || a.owner !== LAUNCH_PROGRAM_ID) throw new Error("units_launch is not initialized on this cluster");
    return (this.lc = decodeLaunchConfig(a.data));
  }

  /** The facts of one mint, read from chain: its launch record, its curve, its canonical pool and the pool's vaults. */
  private async mintFacts(mint: Address, lc: LaunchConfig): Promise<MintFacts> {
    const pool = pumpPdas.pool(mint, lc.lineMint);
    const [la, curve, pl, baseVault, quoteVault, mintAcc] = await this.o.rpc.getMultipleAccounts([
      launchPdas.agentLaunch(mint), pumpPdas.bondingCurve(mint), pool, ata(pool, mint, TOKEN_2022_PROGRAM), ata(pool, lc.lineMint, lc.lineTokenProgram), mint,
    ]);
    const facts: MintFacts = { registered: false, agent: null, createdAt: null, supply: null, liquidity: null, curve: null, pool: null };
    if (!la || la.owner !== LAUNCH_PROGRAM_ID) return facts;
    const launch = decodeAgentLaunch(la.data);
    if (launch.mint !== mint || launch.venue !== "pump") return facts;
    facts.registered = true;
    facts.agent = launch.agent;
    facts.createdAt = launch.createdAt;
    if (mintAcc && mintAcc.owner === TOKEN_2022_PROGRAM) facts.supply = decodeMint(mintAcc.data).supply;
    if (curve && curve.owner === PUMP.program) {
      const c = decodeBondingCurve(curve.data);
      if (!c.complete && c.virtualTokenReserves > 0n && c.virtualQuoteReserves > 0n) {
        facts.curve = { quote: c.virtualQuoteReserves, base: c.virtualTokenReserves };
        facts.liquidity = c.realQuoteReserves;
      }
    }
    if (pl && pl.owner === PUMP.amm && baseVault && quoteVault) {
      const p = decodePumpPool(pl.data);
      const base = decodeTokenAccount(baseVault.data).amount;
      const real = decodeTokenAccount(quoteVault.data).amount;
      const quote = real + p.virtualQuoteReserves;
      if (p.baseMint === mint && p.quoteMint === lc.lineMint && base > 0n && quote > 0n) {
        facts.pool = { quote, base };
        facts.liquidity = real;
      }
    }
    return facts;
  }

  /** A lookup table as the policy accepts it: owned by the table program, frozen, not deactivated. Null otherwise. */
  private async table(address: Address): Promise<Address[] | null> {
    const a = await this.o.rpc.getAccountInfo(address);
    if (!a || a.owner !== ALT_PROGRAM) return null;
    try {
      const t = decodeLookupTable(a.data);
      return t.authority === null && t.deactivationSlot === U64_MAX ? t.addresses : null;
    } catch {
      return null;
    }
  }

  /** The context for (key, message), built from chain and the runtime's callbacks. */
  async context(key: Address, message: Uint8Array): Promise<FirewallContext> {
    const lc = await this.launchConfig();
    const id = this.o.identity(key);
    const tables = new Map<Address, Address[]>();
    let named: Address[] = [];
    try {
      for (const t of lookupTablesOf(message)) {
        const a = await this.table(t);
        if (a) tables.set(t, a);
      }
      named = mintsNamed(parseMessageStrict(message, tables));
    } catch {
      // the policy parses again and refuses with the reason
    }
    const mints = new Map<Address, MintFacts>();
    for (const m of named.slice(0, 4)) mints.set(m, await this.mintFacts(m, lc));
    let limits: FirewallLimits | null = null;
    try {
      limits = await this.o.limits();
    } catch (e) {
      this.log(`firewall: limits not read: ${(e as Error).message}`);
    }
    // the swap this message carries: Core's answer for it, and what the key holds of the two tokens
    let core: CoreCheck | null = null;
    let cash: bigint | null = null;
    let held: bigint | null = null;
    try {
      const sw = swapNamed(parseMessageStrict(message, tables));
      if (sw) {
        const [q, h] = await this.o.rpc.getMultipleAccounts([ata(key, lc.lineMint, lc.lineTokenProgram), ata(key, sw.mint, TOKEN_2022_PROGRAM)]);
        cash = q ? decodeTokenAccount(q.data).amount : 0n;
        held = h ? decodeTokenAccount(h.data).amount : 0n;
        if (id && this.o.coreCheck) core = await this.o.coreCheck(id.agent, sw.mint, sw.side).catch((e) => (this.log(`firewall: Core not asked: ${(e as Error).message}`), null));
      }
    } catch {
      // unparseable: the policy refuses it
    }
    return { key, agent: id?.agent ?? null, ownMint: id?.ownMint ?? null, quoteMint: lc.lineMint, quoteTokenProgram: lc.lineTokenProgram, mints, tables, limits, daySpent: this.spentToday(key), core, cash, held, now: Math.floor(this.now() / 1000) };
  }

  /**
   * Decides one signature. Resolves with the verdict when allowed (the day ledger is charged first);
   * throws FirewallRefusal otherwise. Either way the decision is logged.
   */
  authorize(key: Address, message: Uint8Array): Promise<Extract<Verdict, { ok: true }>> {
    const run = async () => {
      const hash = bytesToHex(sha256(message));
      let v: Verdict;
      let agent: Address | null = null;
      try {
        const c = await this.context(key, message);
        agent = c.agent;
        v = evaluate(message, c);
      } catch (e) {
        // the chain or the config could not be read: nothing is signed
        v = { ok: false, rule: "context_unavailable", detail: (e as Error).message.slice(0, 200) };
      }
      const row: FirewallLogRow = { at: this.now(), key, agent, ok: v.ok, kind: v.ok ? v.kind : null, rule: v.ok ? null : v.rule, detail: v.ok ? v.summary : v.detail, value: v.ok ? v.value.toString() : "0", message_sha256: hash };
      if (!v.ok) {
        this.record(row);
        this.log(`firewall: REFUSED ${key.slice(0, 8)} ${v.rule}: ${v.detail}`);
        throw new FirewallRefusal(v.rule, v.detail, key);
      }
      this.charge(key, v.value);
      this.record(row);
      this.log(`firewall: allowed ${key.slice(0, 8)} ${v.summary}`);
      return v;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }
}
