// The encrypted reserve and credential store, adapted to the interfaces the souls provisioning code
// (packages/souls/src/github) and the mirror publisher (packages/mirror) already use:
//   ReservePool            a souls `Pool` whose accounts are the encrypted "reserve" records (the
//                          small reserve push-reserve.ts sends from the operator's machine), so
//                          provisionAccount assigns from the server reserve, one account at a time;
//   EncryptedCredentialStore  a souls `CredentialStore` over "cred" records. The SSH signing key is
//                          kept inside the encrypted record; git needs it as a file, so `get`
//                          materialises it under the service's runtime directory (tmpfs on the site,
//                          mode 700, file mode 600) and `cleanup` removes it after each cycle.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentCredential, CredentialStore } from "../../souls/src/github/credentials.ts";
import { EXCLUDED_LOGINS, Pool, type PoolAccount, type PoolFile } from "../../souls/src/github/pool.ts";
import type { ClaimRecord, CredRecord, ReserveRecord } from "./records.ts";
import type { EncryptedStore } from "./store.ts";

export class ReservePool extends Pool {
  constructor(private readonly store: EncryptedStore) {
    super("<encrypted reserve>");
  }

  override read(): PoolFile {
    return { version: 1, accounts: this.store.list("reserve").map((l) => this.store.get<ReserveRecord>("reserve", l)!).filter(Boolean) };
  }

  override write(f: PoolFile) {
    for (const a of f.accounts) this.store.put("reserve", a.login, a);
  }

  add(login: string, token: string, now = new Date()): "added" | "present" {
    if (this.store.has("reserve", login)) return "present";
    const r: ReserveRecord = { login, token, status: "available", assigned_agent: null, pushed_at: now.toISOString() };
    this.store.put("reserve", login, r);
    return "added";
  }

  // ---- one account, one agent, ever (owner direction 2026-10-12)
  //
  // The binding of an account to an agent is its claim record (kind "claim", id = login), made with
  // EncryptedStore.create: the name appears in one step and only for the first caller, in any number of
  // processes, and it is on the disk before provisioning reads or writes anything on GitHub. Nothing in
  // the service deletes a claim: a provisioning that fails halfway, a rejected token, a launch that
  // never completes all leave the account bound to that agent, and a restart resumes with the same
  // account for the same agent. Only `release` (an operator command with a confirmation) frees one.
  // Reserve records from before the claim existed carry the binding in assigned_agent: it counts the same.

  private claimOf(login: string): ClaimRecord | null {
    return this.store.get<ClaimRecord>("claim", login);
  }

  /** The agent an account is bound to (its claim, else the record's assigned_agent), or null when it is free. */
  boundTo(a: PoolAccount): string | null {
    return this.claimOf(a.login)?.agent ?? a.assigned_agent ?? null;
  }

  override candidates(exclude: string[] = EXCLUDED_LOGINS): PoolAccount[] {
    return super.candidates(exclude).filter((a) => !this.store.has("claim", a.login));
  }

  /** The live account bound to this agent, if any: also one claimed just before a crash, whose record still says available. */
  override assignedTo(agent: string): PoolAccount | null {
    const mine = this.read().accounts.filter((a) => ["assigned", "assigning", "available"].includes(a.status) && this.boundTo(a) === agent);
    const rank = (a: PoolAccount) => (a.status === "assigned" ? 0 : a.status === "assigning" ? 1 : 2);
    return mine.sort((x, y) => rank(x) - rank(y) || (x.login < y.login ? -1 : 1))[0] ?? null;
  }

  override claim(login: string, agent: string, now = new Date()): boolean {
    const rec = this.store.get<ReserveRecord>("reserve", login);
    if (!rec) return false;
    if (rec.assigned_agent && rec.assigned_agent !== agent) return false;
    const made = this.store.create("claim", login, { v: 1, login, agent, at: now.toISOString() } satisfies ClaimRecord);
    if (!made && this.claimOf(login)?.agent !== agent) return false;
    if (rec.status === "available" || rec.assigned_agent !== agent) {
      if (rec.status !== "available" && rec.status !== "assigning" && rec.status !== "assigned") return made; // unusable: bound, never used
      this.store.put("reserve", login, { ...rec, status: rec.status === "assigned" ? "assigned" : "assigning", assigned_agent: agent, assigned_at: rec.assigned_at ?? now.toISOString() });
    }
    return true;
  }

  /**
   * Frees an account that was bound to an agent but never finished provisioning (operator command
   * `main.ts reserve-release --login <login> --confirm release-<login>`). Refused for an account whose
   * provisioning completed: an agent's credentials use it.
   */
  release(login: string, confirm: string, credLogins: string[], now = new Date()): { login: string; released_from: string | null } {
    if (confirm !== `release-${login}`) throw new Error(`release needs --confirm release-${login}`);
    const rec = this.store.get<ReserveRecord>("reserve", login);
    if (!rec) throw new Error(`no account ${login} in the reserve`);
    const agent = this.boundTo(rec);
    if (!agent) throw new Error(`${login} is not bound to any agent`);
    if (rec.status === "assigned" || credLogins.some((l) => l.toLowerCase() === login.toLowerCase())) throw new Error(`${login} is assigned to ${agent} and in use by its credentials; it is not released`);
    if (rec.status !== "assigning" && rec.status !== "available") throw new Error(`${login} is ${rec.status}; only an account whose provisioning did not finish is released`);
    this.store.put("reserve", login, { ...rec, status: "available", assigned_agent: null, assigned_at: undefined, note: `released from ${agent} by the operator ${now.toISOString()}` });
    this.store.delete("claim", login);
    return { login, released_from: agent };
  }

  /** Counts only: no login, no token. `available` is what the next launches can still be given. */
  counts(exclude: string[] = EXCLUDED_LOGINS): { total: number; available: number; assigning: number; assigned: number; unusable: number } {
    const c = { total: 0, available: 0, assigning: 0, assigned: 0, unusable: 0 };
    for (const a of this.read().accounts) {
      c.total += 1;
      const bound = this.boundTo(a);
      if (a.status === "assigned") c.assigned += 1;
      else if ((a.status === "assigning" || a.status === "available") && bound) c.assigning += 1;
      else if (a.status === "available" && !exclude.includes(a.login)) c.available += 1;
      else c.unusable += 1;
    }
    return c;
  }

  /** Logins, statuses and assignments only (what reserve-list prints and push-reserve syncs back). */
  publicList(): { login: string; status: string; assigned_agent: string | null; note: string | null }[] {
    return this.read().accounts.map((a) => {
      const bound = this.boundTo(a);
      // an account claimed just before a crash still says available in its record: it is not
      return { login: a.login, status: a.status === "available" && bound ? "assigning" : a.status, assigned_agent: bound, note: (a.note as string) ?? null };
    });
  }
}

const AGENT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export class EncryptedCredentialStore implements CredentialStore {
  constructor(
    private readonly store: EncryptedStore,
    /** runtime directory for materialised keys (the site: /run/units-identity) */
    readonly runDir: string,
  ) {}

  private dir(d: string) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
    chmodSync(d, 0o700);
  }

  keyDir(agent: string): string {
    if (!AGENT.test(agent)) throw new Error("bad agent id");
    this.dir(this.runDir);
    this.dir(join(this.runDir, "keys"));
    const d = join(this.runDir, "keys", agent);
    this.dir(d);
    return d;
  }

  /** Stores a credential; the private key file it names is read into the encrypted record and removed. */
  put(c: AgentCredential & { mode?: "purchased" | "token" }) {
    const priv = readFileSync(c.ssh_private_key_path, "utf8");
    const rec: CredRecord = {
      v: 1, agent: c.agent, mode: c.mode ?? "purchased", login: c.login, github_id: c.github_id, token: c.token,
      ssh_private_key: priv, ssh_public_key: c.ssh_public_key, ssh_signing_key_id: c.ssh_signing_key_id, assigned_at: c.assigned_at,
    };
    this.store.put("cred", c.agent, rec);
    rmSync(c.ssh_private_key_path, { force: true });
    rmSync(`${c.ssh_private_key_path}.pub`, { force: true });
  }

  record(agent: string): CredRecord | null {
    return this.store.get<CredRecord>("cred", agent);
  }

  /** The credential with its signing key materialised as a mode 600 file (for git). */
  get(agent: string): AgentCredential | null {
    const r = this.record(agent);
    if (!r) return null;
    const path = join(this.keyDir(agent), "signing");
    if (!existsSync(path)) {
      writeFileSync(path, r.ssh_private_key, { mode: 0o600 });
      chmodSync(path, 0o600);
    }
    return {
      v: 1, agent: r.agent, login: r.login, github_id: r.github_id, token: r.token, ssh_private_key_path: path,
      ssh_public_key: r.ssh_public_key, ssh_signing_key_id: r.ssh_signing_key_id, assigned_at: r.assigned_at,
    };
  }

  agents(): string[] {
    return this.store.list("cred");
  }

  delete(agent: string) {
    this.store.delete("cred", agent);
    rmSync(join(this.runDir, "keys", agent), { recursive: true, force: true });
  }

  /** Removes every materialised key. */
  cleanup() {
    rmSync(join(this.runDir, "keys"), { recursive: true, force: true });
  }
}
