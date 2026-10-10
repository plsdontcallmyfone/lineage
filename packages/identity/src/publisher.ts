// The publisher account (docs/plans/GENERATIONS-ON-GITHUB.md 1.1): one Lineage-owned GitHub account
// that signs and pushes the mirror commits of agents on the app identity, so every accepted
// generation gets a Verified public commit. Stored encrypted like an agent credential (record
// "publisher/app"); its SSH signing key is generated here and registered on the account. Never one
// of the agent pool accounts, never the reserved test-repositories maintainer, never a login an
// agent or the reserve uses.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fetch } from "../../souls/src/github/api.ts";
import { APP_IDENTITY, type CommitIdentity } from "../../mirror/src/chain.ts";
import { noreplyEmail } from "../../mirror/src/git.ts";
import { registerSigningKey, removeSigningKey, sshKeygen, validateToken, type Keygen } from "./github-token.ts";
import type { IdentityService } from "./service.ts";

/** Logins that may never become the publisher (the reserved upstream maintainer of the test repositories). */
export const RESERVED_LOGINS = ["ds56vmr2"];

export interface PublisherRecord {
  v: 1;
  login: string;
  github_id: number;
  token: string;
  ssh_private_key: string;
  ssh_public_key: string;
  ssh_signing_key_id: number | null;
  scopes: string[] | null;
  set_at: string;
}

export interface PublisherPublic {
  configured: boolean;
  login: string | null;
  profile_url: string | null;
  ssh_signing_key: string | null;
  set_at: string | null;
}

export interface SetOptions {
  apiBase?: string;
  fetch?: Fetch;
  keygen?: Keygen;
  /** extra logins to refuse (e.g. the operator's pool file) */
  refuse?: string[];
  now?: () => Date;
}

const lower = (s: string) => s.toLowerCase();

export function publisherRecord(svc: IdentityService): PublisherRecord | null {
  return svc.o.store.get<PublisherRecord>("publisher", "app");
}

export function publisherPublic(svc: IdentityService): PublisherPublic {
  const r = publisherRecord(svc);
  return { configured: !!r, login: r?.login ?? null, profile_url: r ? `https://github.com/${r.login}` : null, ssh_signing_key: r?.ssh_public_key ?? null, set_at: r?.set_at ?? null };
}

/** Logins the publisher may not be: reserved, every reserve account, every agent's account. */
export function refusedLogins(svc: IdentityService, extra: string[] = []): Set<string> {
  const out = new Set<string>([...RESERVED_LOGINS, ...extra].map(lower));
  for (const a of svc.reserve.publicList()) out.add(lower(a.login));
  for (const a of svc.creds.agents()) {
    const c = svc.creds.record(a);
    if (c?.login) out.add(lower(c.login));
  }
  return out;
}

/** Validates the token, refuses pool, reserve and agent logins, registers a signing key and stores the account. */
export async function setPublisher(svc: IdentityService, token: string, opts: SetOptions = {}): Promise<PublisherPublic> {
  const o = { ...opts, apiBase: opts.apiBase ?? svc.o.apiBase, fetch: opts.fetch ?? svc.o.fetch };
  const info = await validateToken(token, { apiBase: o.apiBase, fetch: o.fetch });
  if (refusedLogins(svc, o.refuse).has(lower(info.login))) throw new Error(`${info.login} may not be the publisher (reserved, a pool or reserve account, or an agent's account)`);
  if (info.scopes && !info.scopes.some((s) => s === "public_repo" || s === "repo")) throw new Error(`the token needs the public_repo scope (has: ${info.scopes.join(", ") || "none"})`);
  const prev = publisherRecord(svc);
  const work = mkdtempSync(join(tmpdir(), "lineage-publisher-"));
  try {
    const k = (o.keygen ?? sshKeygen)(work, `lineage publisher ${info.login}`);
    const id = await registerSigningKey(token, "publisher", k.publicKey, { apiBase: o.apiBase, fetch: o.fetch }).catch((e) => {
      throw new Error(`could not register the signing key (the token needs write:ssh_signing_key): ${(e as Error).message}`);
    });
    const rec: PublisherRecord = {
      v: 1, login: info.login, github_id: info.github_id, token, ssh_private_key: readFileSync(k.privatePath, "utf8"), ssh_public_key: k.publicKey,
      ssh_signing_key_id: id, scopes: info.scopes, set_at: (o.now ?? (() => new Date()))().toISOString(),
    };
    svc.o.store.put("publisher", "app", rec);
    // a replaced publisher of the same account: its old key is removed (registerSigningKey replaced it by title)
    if (prev && lower(prev.login) !== lower(info.login) && prev.ssh_signing_key_id) await removeSigningKey(prev.token, prev.ssh_signing_key_id, { apiBase: o.apiBase, fetch: o.fetch }).catch(() => {});
    return publisherPublic(svc);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function clearPublisher(svc: IdentityService, opts: SetOptions = {}): Promise<PublisherPublic> {
  const o = { ...opts, apiBase: opts.apiBase ?? svc.o.apiBase, fetch: opts.fetch ?? svc.o.fetch };
  const r = publisherRecord(svc);
  if (r?.ssh_signing_key_id) await removeSigningKey(r.token, r.ssh_signing_key_id, { apiBase: o.apiBase, fetch: o.fetch }).catch(() => {});
  svc.o.store.delete("publisher", "app");
  return publisherPublic(svc);
}

/** The app identity for the mirror: the publisher (signing key materialised under the run directory) or the unconfigured fallback. */
export function publisherIdentity(svc: IdentityService): CommitIdentity {
  const r = publisherRecord(svc);
  if (!r) return APP_IDENTITY;
  const dir = join(svc.o.runDir, "keys", "publisher");
  for (const d of [svc.o.runDir, join(svc.o.runDir, "keys"), dir]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
    chmodSync(d, 0o700);
  }
  const path = join(dir, "signing");
  if (!existsSync(path)) writeFileSync(path, r.ssh_private_key, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { kind: "app", name: r.login, email: noreplyEmail(r.github_id, r.login), signingKey: path, login: r.login, token: r.token };
}
