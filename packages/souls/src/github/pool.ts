// The purchasable GitHub account pool (SPEC 13.9): ~/.config/lineage/github-pool.json, mode 600,
// tokens only. Assignment takes the next usable account in file order, one at a time; every change is
// written atomically and the file stays mode 600. Tokens are never printed: `publicView` is the only
// shape that leaves this module for logs.

import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_POOL = join(homedir(), ".config/lineage/github-pool.json");

/** Accounts never assigned: they hold collaborator access to repositories that are not theirs (owner decision 2026-10-08). */
export const EXCLUDED_LOGINS = ["ver1t0l3", "nkvps35u"];

export interface PoolAccount {
  login: string;
  token: string;
  /** available | assigning | assigned | token_invalid | excluded */
  status: string;
  assigned_agent: string | null;
  imported_at?: string;
  assigned_at?: string;
  note?: string;
  [k: string]: unknown;
}

export interface PoolFile {
  version: number;
  note?: string;
  accounts: PoolAccount[];
}

export class Pool {
  constructor(readonly path: string = DEFAULT_POOL) {}

  read(): PoolFile {
    if (!existsSync(this.path)) throw new Error(`pool file ${this.path} does not exist`);
    const mode = statSync(this.path).mode & 0o777;
    if (mode & 0o077) throw new Error(`pool file ${this.path} is mode ${mode.toString(8)}; it must be 600 (tokens)`);
    const f = JSON.parse(readFileSync(this.path, "utf8")) as PoolFile;
    if (!Array.isArray(f.accounts)) throw new Error("pool file has no accounts list");
    return f;
  }

  write(f: PoolFile) {
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(f, null, 2) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }

  /** Accounts that may be tried, in file order: available, not excluded by login. */
  candidates(exclude: string[] = EXCLUDED_LOGINS): PoolAccount[] {
    return this.read().accounts.filter((a) => a.status === "available" && !a.assigned_agent && !exclude.includes(a.login));
  }

  /** The account already assigned to this agent, if any (assignment is idempotent per agent). */
  assignedTo(agent: string): PoolAccount | null {
    return this.read().accounts.find((a) => a.assigned_agent === agent && (a.status === "assigned" || a.status === "assigning")) ?? null;
  }

  /** Changes one account's fields (by login) and writes the file. */
  update(login: string, change: Partial<PoolAccount>) {
    const f = this.read();
    const a = f.accounts.find((x) => x.login === login);
    if (!a) throw new Error(`no account ${login} in the pool`);
    Object.assign(a, change);
    this.write(f);
  }

  /** Counts per status, for logs. */
  summary(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const a of this.read().accounts) out[a.status] = (out[a.status] ?? 0) + 1;
    return out;
  }
}

export function publicView(a: PoolAccount): { login: string; status: string; assigned_agent: string | null } {
  return { login: a.login, status: a.status, assigned_agent: a.assigned_agent };
}
