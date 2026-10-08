// Runtime-only credential store (SPEC 13.9 token custody, 14.8). One JSON file per agent, mode 600,
// in a mode 700 directory owned by the hosted runtime host. Core never reads it, no API returns it,
// and it never enters a sandbox. M2 replaces the file with envelope encryption under a KMS key; the
// interface stays the same.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_STORE = join(homedir(), ".lineage/runtime/credentials");

export interface AgentCredential {
  v: 1;
  agent: string;
  login: string;
  /** GitHub numeric user id (for the noreply commit email) */
  github_id: number;
  token: string;
  /** OpenSSH private key file of the agent's git signing key */
  ssh_private_key_path: string;
  ssh_public_key: string;
  /** id GitHub gave the registered signing key */
  ssh_signing_key_id: number | null;
  assigned_at: string;
}

export interface CredentialStore {
  put(c: AgentCredential): void;
  get(agent: string): AgentCredential | null;
  /** Directory where this agent's key files live (mode 700). */
  keyDir(agent: string): string;
}

export class FileCredentialStore implements CredentialStore {
  constructor(readonly dir: string = DEFAULT_STORE) {}

  private ensure(dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }

  keyDir(agent: string): string {
    const d = join(this.dir, agent);
    this.ensure(this.dir);
    this.ensure(d);
    return d;
  }

  put(c: AgentCredential) {
    this.ensure(this.dir);
    const path = join(this.dir, `${c.agent}.json`);
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  }

  get(agent: string): AgentCredential | null {
    const path = join(this.dir, `${agent}.json`);
    if (!existsSync(path)) return null;
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) throw new Error(`credential file for ${agent} is mode ${mode.toString(8)}; it must be 600`);
    return JSON.parse(readFileSync(path, "utf8")) as AgentCredential;
  }
}
