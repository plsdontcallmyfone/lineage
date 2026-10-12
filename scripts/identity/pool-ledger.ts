// The owner's ledger of GitHub pool accounts (owner direction 2026-10-12: an account is given to
// exactly one agent, ever, on any instance). It lives OUTSIDE the repository, beside the pool file:
// ~/.config/units/github-pool-ledger.json, mode 600. It holds logins, instance names, times and agent
// ids; never a token.
//
// One entry per account that was ever sent anywhere or used by anything:
//   instance      where it went ("devnet", "mainnet"), or null when it was used up locally
//   state         "shipping"  written BEFORE a transfer starts (a crash mid-transfer leaves it: the
//                             account counts as gone to that instance)
//                 "shipped"   the instance's reserve confirmed it
//                 "consumed"  used or unusable for another reason (`reason` says which)
//   assigned_agent  the agent it was given to, where that is known (sync reads it from the server)
// An account with an entry is never sent to a different instance. Sending it again to the SAME
// instance is allowed while it has no agent (the server's reserve-add leaves an account it already
// has untouched), which makes a re-run after a crash safe.
//
// ship-pool.ts and push-reserve.ts both go through this file.

import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { EXCLUDED_LOGINS, type Pool, type PoolAccount } from "../../packages/souls/src/github/pool.ts";

export const DEFAULT_LEDGER = join(homedir(), ".config/units/github-pool-ledger.json");

export interface LedgerEntry {
  login: string;
  instance: string | null;
  state: "shipping" | "shipped" | "consumed";
  host: string | null;
  shipped_at: string | null;
  assigned_agent: string | null;
  reason: string;
  updated_at: string;
}
export interface LedgerFile {
  version: 1;
  note: string;
  accounts: Record<string, LedgerEntry>;
}

const key = (login: string) => login.toLowerCase();

export class Ledger {
  constructor(readonly path: string = DEFAULT_LEDGER) {}

  read(): LedgerFile {
    if (!existsSync(this.path)) return { version: 1, note: "GitHub pool ledger: where every account went. Logins only, no tokens. scripts/identity/pool-ledger.ts", accounts: {} };
    const mode = statSync(this.path).mode & 0o777;
    if (mode & 0o077) throw new Error(`ledger ${this.path} is mode ${mode.toString(8)}; it must be 600`);
    const f = JSON.parse(readFileSync(this.path, "utf8")) as LedgerFile;
    if (f.version !== 1 || !f.accounts || typeof f.accounts !== "object") throw new Error(`ledger ${this.path} is not a version 1 ledger`);
    return f;
  }

  /** Written through to the disk before it replaces the old file: an entry made before a transfer survives a crash. */
  write(f: LedgerFile) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp-${process.pid}`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(f, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
    try {
      const d = openSync(dirname(this.path), "r");
      try {
        fsyncSync(d);
      } finally {
        closeSync(d);
      }
    } catch {
      /* best effort */
    }
  }

  get(login: string): LedgerEntry | null {
    return this.read().accounts[key(login)] ?? null;
  }

  /** Whether an account may be sent to an instance: never when the ledger has it anywhere else or with an agent. */
  eligible(login: string, instance: string): { ok: true; resend: boolean } | { ok: false; why: string } {
    const e = this.get(login);
    if (!e) return { ok: true, resend: false };
    if (e.assigned_agent) return { ok: false, why: `assigned to agent ${e.assigned_agent}${e.instance ? ` on ${e.instance}` : ""}` };
    if (e.state === "consumed") return { ok: false, why: `used up${e.instance ? ` on ${e.instance}` : ""}: ${e.reason}` };
    if (e.instance !== instance) return { ok: false, why: `${e.state === "shipped" ? "shipped" : "sent (unconfirmed)"} to ${e.instance ?? "another place"}${e.shipped_at ? ` ${e.shipped_at}` : ""}` };
    return { ok: true, resend: true };
  }

  private change(fn: (f: LedgerFile) => void) {
    const f = this.read();
    fn(f);
    this.write(f);
  }

  /** BEFORE a transfer: the accounts belong to this instance from here on, whatever happens to the transfer. */
  markShipping(logins: string[], instance: string, host: string | null, now = new Date()) {
    const at = now.toISOString();
    this.change((f) => {
      for (const login of logins) {
        const e = f.accounts[key(login)];
        if (e && (e.instance !== instance || e.assigned_agent || e.state === "consumed")) throw new Error(`ledger: ${login} is not free for ${instance} (${e.state}${e.instance ? ` on ${e.instance}` : ""})`);
        if (e?.state === "shipped") continue;
        f.accounts[key(login)] = { login, instance, state: "shipping", host, shipped_at: e?.shipped_at ?? at, assigned_agent: null, reason: `sent to the ${instance} reserve`, updated_at: at };
      }
    });
  }

  markShipped(logins: string[], instance: string, now = new Date()) {
    this.change((f) => {
      for (const login of logins) {
        const e = f.accounts[key(login)];
        if (!e || e.instance !== instance) throw new Error(`ledger: ${login} was not sent to ${instance}`);
        if (e.state === "shipping") Object.assign(e, { state: "shipped", reason: `in the ${instance} reserve`, updated_at: now.toISOString() });
      }
    });
  }

  /** Records that an account is used: by an agent on an instance, or for a reason. Never loosens an entry. */
  consume(login: string, o: { instance?: string | null; agent?: string | null; reason: string }, now = new Date()): boolean {
    let changed = false;
    this.change((f) => {
      const e = f.accounts[key(login)];
      if (!e) {
        f.accounts[key(login)] = { login, instance: o.instance ?? null, state: "consumed", host: null, shipped_at: null, assigned_agent: o.agent ?? null, reason: o.reason, updated_at: now.toISOString() };
        changed = true;
        return;
      }
      if (o.agent && e.assigned_agent !== o.agent) {
        // the first agent on record stays: a second one is a finding, not an overwrite
        if (e.assigned_agent) e.reason = `${e.reason}; ALSO reported for agent ${o.agent}${o.instance ? ` on ${o.instance}` : ""}`;
        else e.assigned_agent = o.agent;
        e.updated_at = now.toISOString();
        changed = true;
      }
    });
    return changed;
  }

  summary(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of Object.values(this.read().accounts)) {
      const k = `${e.instance ?? "local"}:${e.assigned_agent ? "assigned" : e.state}`;
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  }
}

/**
 * Seeds the ledger from what this machine knows: every pool account that is not plainly available
 * (assigned, pushed to a server reserve, reserved, invalid), the logins excluded by name, and the
 * logins of an exclusions list (one per line; e.g. what a server reports). Existing entries are kept.
 */
export function seed(pool: Pool, ledger: Ledger, o: { exclusions?: string[]; exclusionsInstance?: string | null; now?: Date } = {}): { added: string[] } {
  const added: string[] = [];
  const now = o.now ?? new Date();
  for (const a of pool.read().accounts) {
    if (ledger.get(a.login)) continue;
    const excluded = EXCLUDED_LOGINS.includes(a.login);
    if (a.status === "available" && !a.assigned_agent && !excluded) continue;
    // a server reserve existed only on the devnet site before this ledger
    const server = a.status === "server_reserve" || /reserve/i.test(String(a.note ?? ""));
    ledger.consume(a.login, { instance: server ? "devnet" : null, agent: a.assigned_agent, reason: excluded ? "excluded by login (holds access to repositories that are not its own)" : `local pool status ${a.status} when the ledger was seeded` }, now);
    added.push(a.login);
  }
  for (const login of o.exclusions ?? []) {
    if (ledger.get(login)) continue;
    ledger.consume(login, { instance: o.exclusionsInstance ?? null, reason: "named in an exclusions list when the ledger was seeded" }, now);
    added.push(login);
  }
  return { added };
}

export interface ShipPlan {
  instance: string;
  /** never sent anywhere: go now */
  fresh: PoolAccount[];
  /** written to the ledger for this instance earlier without a confirmation: sent again */
  resend: PoolAccount[];
  refused: { login: string; why: string }[];
  /** how many more would qualify beyond --count */
  held_back: number;
}

/** Which accounts of the local pool may go to an instance. Reads only. */
export function planShip(pool: Pool, ledger: Ledger, instance: string, o: { count?: number | null } = {}): ShipPlan {
  const plan: ShipPlan = { instance, fresh: [], resend: [], refused: [], held_back: 0 };
  for (const a of pool.read().accounts) {
    const e = ledger.get(a.login);
    if (e && e.instance === instance && e.state === "shipping" && !e.assigned_agent) {
      plan.resend.push(a);
      continue;
    }
    if (e && e.instance === instance && e.state === "shipped") continue; // there already: nothing to do
    if (EXCLUDED_LOGINS.includes(a.login)) {
      plan.refused.push({ login: a.login, why: "excluded by login" });
      continue;
    }
    const ok = ledger.eligible(a.login, instance);
    if (!ok.ok) {
      plan.refused.push({ login: a.login, why: ok.why });
      continue;
    }
    if (a.status !== "available" || a.assigned_agent) {
      plan.refused.push({ login: a.login, why: `local pool status ${a.status}${a.assigned_agent ? `, agent ${a.assigned_agent}` : ""}` });
      continue;
    }
    if (o.count != null && plan.fresh.length >= o.count) plan.held_back += 1;
    else plan.fresh.push(a);
  }
  return plan;
}

export interface ShipResult {
  sent: string[];
  added: string[];
  present: string[];
  refused_by_server: string[];
  skipped: { login: string; why: string }[];
}

/**
 * Sends accounts to an instance's reserve. For every account, in this order: the token is checked
 * (read only), the ledger entry is written and synced, the local pool file marks it server_reserve, and
 * only then `transfer` runs. A transfer that throws leaves all of that in place: the accounts count as
 * gone to this instance and only a re-run to the same instance sends them again.
 */
export async function ship(o: {
  pool: Pool;
  ledger: Ledger;
  instance: string;
  host: string | null;
  count?: number | null;
  /** read only: whether the token still answers for its login; false marks the account unusable */
  verify: (a: PoolAccount) => Promise<{ ok: true } | { ok: false; why: string; invalid: boolean }>;
  /** sends {"login","token"} JSON lines to the instance's reserve-add and returns its answer */
  transfer: (lines: string) => Promise<{ added: string[]; present: string[]; refused: string[] }>;
  now?: () => Date;
  log?: (m: string) => void;
}): Promise<ShipResult> {
  const now = o.now ?? (() => new Date());
  const log = o.log ?? (() => {});
  const plan = planShip(o.pool, o.ledger, o.instance, { count: o.count });
  const out: ShipResult = { sent: [], added: [], present: [], refused_by_server: [], skipped: plan.refused };
  const picked: PoolAccount[] = [];
  for (const a of [...plan.resend, ...plan.fresh]) {
    const v = await o.verify(a);
    if (!v.ok) {
      out.skipped.push({ login: a.login, why: v.why });
      if (v.invalid) {
        o.ledger.consume(a.login, { reason: `token rejected by GitHub (${v.why})` }, now());
        if (a.status === "available") o.pool.update(a.login, { status: "token_invalid", note: `ship-pool: ${v.why}` });
      }
      continue;
    }
    picked.push(a);
  }
  if (!picked.length) return out;
  const logins = picked.map((a) => a.login);
  // 1. the ledger, on the disk, before anything leaves this machine
  o.ledger.markShipping(logins, o.instance, o.host, now());
  // 2. the pool file: nothing here hands these accounts to anything else
  for (const a of picked) if (a.status === "available") o.pool.update(a.login, { status: "server_reserve", note: `sent to the ${o.instance} reserve ${now().toISOString()}` });
  out.sent = logins;
  log(`ledger written for ${logins.length} accounts; sending`);
  // 3. the transfer
  const res = await o.transfer(picked.map((a) => JSON.stringify({ login: a.login, token: a.token })).join("\n") + "\n");
  const known = (l: string) => logins.find((x) => key(x) === key(l));
  out.added = res.added.map(known).filter((x): x is string => !!x);
  out.present = res.present.map(known).filter((x): x is string => !!x);
  out.refused_by_server = res.refused.map((l) => known(l) ?? l);
  o.ledger.markShipped([...out.added, ...out.present], o.instance, now());
  return out;
}

/**
 * Copies what an instance's reserve reports (logins, statuses, assignments; no tokens) into the ledger:
 * an assigned account gets its agent, an account the ledger did not know is recorded as that instance's.
 */
export function syncFromServer(ledger: Ledger, instance: string, accounts: { login: string; status: string; assigned_agent: string | null }[], now = new Date()): { recorded: string[] } {
  const recorded: string[] = [];
  for (const s of accounts) {
    const e = ledger.get(s.login);
    if (!e) {
      ledger.consume(s.login, { instance, agent: s.assigned_agent, reason: `found in the ${instance} reserve (${s.status})` }, now);
      recorded.push(s.login);
      continue;
    }
    if (e.instance !== instance && e.instance !== null) {
      // on two instances: recorded loudly, nothing is loosened
      if (ledger.consume(s.login, { instance, agent: s.assigned_agent ?? `(${instance} reserve, ${s.status})`, reason: "" }, now)) recorded.push(s.login);
      continue;
    }
    if (e.state === "shipping") ledger.markShipped([s.login], instance, now);
    if (s.assigned_agent && ledger.consume(s.login, { instance, agent: s.assigned_agent, reason: "" }, now)) recorded.push(s.login);
  }
  return { recorded };
}
