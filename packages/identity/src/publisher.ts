// The publisher account (docs/plans/GENERATIONS-ON-GITHUB.md 1.1): one Lineage-owned GitHub account
// that signs and pushes the mirror commits of agents on the app identity, so every accepted
// generation gets a Verified public commit. Stored encrypted like an agent credential (record
// "publisher/app"); its SSH signing key is generated here and registered on the account. Never one
// of the agent pool accounts, never the reserved test-repositories maintainer, never a login an
// agent or the reserve uses.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHub, type Fetch } from "../../souls/src/github/api.ts";
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
  /** account or organization that holds the publisher's forks and learnings repository; null: its own
   *  account. Set by `moveToOrg` once the repositories are transferred (docs/plans/GITHUB-ORG.md 3). */
  owner?: string | null;
}

export interface PublisherPublic {
  configured: boolean;
  login: string | null;
  profile_url: string | null;
  ssh_signing_key: string | null;
  set_at: string | null;
  /** where its repositories live (the units-agents organization once moved) */
  owner: string | null;
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
  return { configured: !!r, login: r?.login ?? null, profile_url: r ? `https://github.com/${r.login}` : null, ssh_signing_key: r?.ssh_public_key ?? null, set_at: r?.set_at ?? null, owner: r ? (r.owner ?? r.login) : null };
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
      // the same account set again keeps where its repositories live
      owner: prev && lower(prev.login) === lower(info.login) ? (prev.owner ?? null) : null,
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
  return { kind: "app", name: r.login, email: noreplyEmail(r.github_id, r.login), signingKey: path, login: r.login, token: r.token, owner: r.owner ?? r.login };
}

export interface MoveResult {
  org: string;
  moved: { from: string; to: string }[];
  already: string[];
  skipped: { repo: string; why: string }[];
  failed: { repo: string; why: string }[];
  owner: string | null;
}

/**
 * Moves the publisher's repositories (its mirror forks and lineage-learnings) into the organization by
 * transfer (POST /repos/{owner}/{repo}/transfer {new_owner}), so history, commit ids and Verified
 * signatures stay and GitHub redirects the old URLs; then records the org as the publisher's owner, so
 * the mirror and the learnings publisher use it from the next cycle. Repositories the publisher made
 * by hand (not forks, not lineage-learnings) are left alone. Idempotent.
 */
export async function moveToOrg(svc: IdentityService, org: string, opts: SetOptions & { dryRun?: boolean; waitS?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<MoveResult> {
  const r = publisherRecord(svc);
  if (!r) throw new Error("no publisher account is configured");
  const gh = new GitHub({ token: r.token, base: opts.apiBase ?? svc.o.apiBase, fetch: opts.fetch ?? svc.o.fetch });
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const out: MoveResult = { org, moved: [], already: [], skipped: [], failed: [], owner: r.owner ?? null };
  const role = await gh.request<{ role?: string; state?: string }>("GET", `/user/memberships/orgs/${org}`, undefined, { okStatuses: [404] });
  if (role.status === 404 || role.data?.role !== "admin" || role.data?.state !== "active") throw new Error(`${r.login} is not an active owner of ${org}; the org owner must make it one before the move`);
  // the identity cycle skips while this marker is fresh (cycle.ts), so it never forks beside a repository in transfer
  if (!opts.dryRun) svc.o.store.put("meta", "publisher-move", { at: Date.now() });
  try {
    const repos = await gh.paged<{ name: string; full_name: string; fork: boolean; owner: { login: string } }>(`/users/${r.login}/repos?type=owner`);
    for (const repo of repos) {
      if (lower(repo.owner?.login ?? "") !== lower(r.login)) continue;
      if (!repo.fork && repo.name !== "lineage-learnings") {
        out.skipped.push({ repo: repo.full_name, why: "not a mirror fork or the learnings repository" });
        continue;
      }
      const target = `${org}/${repo.name}`;
      const there = await gh.get<any>(`/repos/${target}`, [404]);
      if (there && !there.message && there.full_name) {
        if (lower(there.full_name) === lower(target) && there.owner?.login && lower(there.owner.login) === lower(org)) {
          out.already.push(target);
          continue;
        }
      }
      if (opts.dryRun) {
        out.moved.push({ from: repo.full_name, to: target });
        continue;
      }
      try {
        await gh.request("POST", `/repos/${repo.full_name}/transfer`, { new_owner: org });
        // the transfer continues asynchronously: wait until the org answers for it
        const deadline = Date.now() + (opts.waitS ?? 60) * 1000;
        for (;;) {
          const t = await gh.get<any>(`/repos/${target}`, [404]);
          if (t && t.owner?.login && lower(t.owner.login) === lower(org)) break;
          if (Date.now() > deadline) throw new Error(`not under ${org} after ${opts.waitS ?? 60} s`);
          await sleep(2000);
        }
        out.moved.push({ from: repo.full_name, to: target });
      } catch (e) {
        out.failed.push({ repo: repo.full_name, why: (e as Error).message.slice(0, 200) });
      }
    }
    if (!opts.dryRun && out.failed.length === 0) {
      svc.o.store.put("publisher", "app", { ...r, owner: org });
      out.owner = org;
    }
    return out;
  } finally {
    if (!opts.dryRun) svc.o.store.delete("meta", "publisher-move");
  }
}
