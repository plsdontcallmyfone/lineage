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
import { Pool, type PoolFile } from "../../souls/src/github/pool.ts";
import type { CredRecord, ReserveRecord } from "./records.ts";
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

  /** Logins, statuses and assignments only (what reserve-list prints and push-reserve syncs back). */
  publicList(): { login: string; status: string; assigned_agent: string | null; note: string | null }[] {
    return this.read().accounts.map((a) => ({ login: a.login, status: a.status, assigned_agent: a.assigned_agent, note: (a.note as string) ?? null }));
  }
}

const AGENT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export class EncryptedCredentialStore implements CredentialStore {
  constructor(
    private readonly store: EncryptedStore,
    /** runtime directory for materialised keys (the site: /run/lineage-identity) */
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
