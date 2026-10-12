import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { bytesToHex, sha256, type Address } from "./codec.ts";
import { evaluate, lookupTablesOf, type FirewallContext, type Verdict } from "./firewall.ts";
import { FirewallRefusal, installAuthorizer } from "./guard.ts";
import type { Rpc } from "./rpc.ts";
import { ALT_PROGRAM, decodeLookupTable } from "./v0.ts";

// The firewall as a running thing (docs/plans/AGENT-WALLET-SAFETY.md section 3.1): for each
// (guarded key, message) it reads the lookup tables the message names from chain itself, takes the
// key's identity from the callback the runtime gave it, evaluates the pure policy (firewall.ts) and
// appends the decision to firewall.jsonl. A refusal throws FirewallRefusal; only a return lets
// guard.ts issue the signing ticket.
//
// Agents do not trade (owner decision 2026-10-12): the policy allows no swap, so there are no
// trading limits to read, no Core check and no day ledger of value here any more. Nothing an agent
// key may sign moves value.

export interface FirewallIdentity {
  /** the agent this treasury key signs for */
  agent: Address;
}

export interface AgentFirewallOptions {
  rpc: Rpc;
  /** the agent a guarded key belongs to, from the runtime's own state (never from a transaction) */
  identity(key: Address): FirewallIdentity | null;
  /** where the decision log lives (mode 700) */
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
  /** always "0": nothing an agent key may sign carries value (kept so older rows and newer ones read alike) */
  value: string;
  message_sha256: string;
}

const U64_MAX = (1n << 64n) - 1n;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

export class AgentFirewall {
  private now: () => number;
  private log: (m: string) => void;
  private logFile: string;
  /** one decision at a time */
  private chain: Promise<unknown> = Promise.resolve();
  /** counts since start, by rule ("allowed" for allows) */
  readonly counts: Record<string, number> = {};

  constructor(private o: AgentFirewallOptions) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => {});
    mkdirSync(o.dir, { recursive: true, mode: 0o700 });
    this.logFile = join(o.dir, "firewall.jsonl");
  }

  /** Makes this firewall the one every guarded key in this process answers to. */
  install(): this {
    installAuthorizer((key, message) => this.authorize(key, message).then(() => undefined));
    return this;
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

  /** The context for (key, message): the key's agent from the runtime, the message's lookup tables from chain. */
  async context(key: Address, message: Uint8Array): Promise<FirewallContext> {
    const id = this.o.identity(key);
    const tables = new Map<Address, Address[]>();
    let named: Address[] = [];
    try {
      named = lookupTablesOf(message);
    } catch {
      // the policy parses again and refuses with the reason
    }
    for (const t of named) {
      const a = await this.table(t);
      if (a) tables.set(t, a);
    }
    return { key, agent: id?.agent ?? null, tables };
  }

  /**
   * Decides one signature. Resolves with the verdict when allowed; throws FirewallRefusal otherwise.
   * Either way the decision is logged.
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
        // the chain could not be read: nothing is signed
        v = { ok: false, rule: "context_unavailable", detail: (e as Error).message.slice(0, 200) };
      }
      const row: FirewallLogRow = { at: this.now(), key, agent, ok: v.ok, kind: v.ok ? v.kind : null, rule: v.ok ? null : v.rule, detail: v.ok ? v.summary : v.detail, value: "0", message_sha256: hash };
      this.record(row);
      if (!v.ok) {
        this.log(`firewall: REFUSED ${key.slice(0, 8)} ${v.rule}: ${v.detail}`);
        throw new FirewallRefusal(v.rule, v.detail, key);
      }
      this.log(`firewall: allowed ${key.slice(0, 8)} ${v.summary}`);
      return v;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }
}
