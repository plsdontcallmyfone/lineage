// GitHub provisioning for a launched agent in identity mode `purchased` (SPEC 13.9, 14.8; identity
// plan 2.3.2). Per account, at assignment time only (never in bulk):
//   1. take the next usable pool account: the token answers, it is not excluded, and it has no
//      collaborator or organisation access to repositories it does not own;
//   2. clean the previous owner's traces: unstar every starred repository, delete the account's own
//      gists, remove SSH signing keys it already had, clear name, bio, company, blog and location;
//   3. set the display name and bio from the soul (bio at most 160 characters, with the agent's
//      Lineage profile link when one exists); the avatar stays GitHub's default identicon;
//   4. make an agent-bound SSH signing key and register it (POST /user/ssh_signing_keys), so the
//      agent's commits show Verified;
//   5. store the token and the key in the runtime-only credential store; only the login is public.
// Dry run: reads only (the account check), records every write it would make, touches neither the
// pool file nor the credential store, and generates no key.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { githubBio } from "../prompt.ts";
import type { SoulDoc } from "../schema.ts";
import { GitHub, GitHubError, type Fetch } from "./api.ts";
import type { AgentCredential, CredentialStore } from "./credentials.ts";
import { EXCLUDED_LOGINS, Pool, type PoolAccount } from "./pool.ts";

export interface ProvisionOptions {
  agent: string;
  soul: SoulDoc;
  pool: Pool;
  store: CredentialStore;
  /** the agent's public Lineage profile page, when the site is deployed */
  profileUrl: string | null;
  dryRun?: boolean;
  apiBase?: string;
  fetch?: Fetch;
  exclude?: string[];
  /** generates the OpenSSH key pair; tests pass a fake */
  keygen?: (dir: string, comment: string) => { privatePath: string; publicKey: string };
  log?: (m: string) => void;
  now?: () => Date;
}

export interface ProvisionResult {
  agent: string;
  login: string;
  github_id: number;
  dry_run: boolean;
  skipped: { login: string; reason: string }[];
  cleaned: { unstarred: number; gists_deleted: number; signing_keys_removed: number; profile_cleared: boolean };
  profile: { name: string; bio: string; blog: string };
  ssh_signing_key: string | null;
  ssh_signing_key_id: number | null;
  writes: { method: string; path: string }[];
}

export function sshKeygen(dir: string, comment: string): { privatePath: string; publicKey: string } {
  const privatePath = join(dir, "git-signing-ed25519");
  if (existsSync(privatePath)) rmSync(privatePath);
  if (existsSync(`${privatePath}.pub`)) rmSync(`${privatePath}.pub`);
  const r = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", privatePath], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ssh-keygen failed: ${r.stderr}`);
  return { privatePath, publicKey: readFileSync(`${privatePath}.pub`, "utf8").trim() };
}

/** Why an account cannot be assigned, or null when it can (reads only). */
async function vet(gh: GitHub, a: PoolAccount): Promise<{ reason: string; status?: string } | { user: { login: string; id: number } }> {
  let user: { login: string; id: number };
  try {
    user = await gh.get("/user");
  } catch (e) {
    if (e instanceof GitHubError && (e.status === 401 || e.status === 403)) return { reason: `token rejected (${e.status})`, status: "token_invalid" };
    throw e;
  }
  if (user.login.toLowerCase() !== a.login.toLowerCase()) return { reason: `token belongs to ${user.login}, not ${a.login}`, status: "token_invalid" };
  const repos = await gh.paged<{ full_name: string; owner: { login: string } }>("/user/repos?affiliation=collaborator,organization_member", 5);
  const foreign = repos.filter((r) => r.owner.login.toLowerCase() !== a.login.toLowerCase());
  if (foreign.length) return { reason: `has access to ${foreign.length} repositories it does not own`, status: "excluded" };
  const orgs = await gh.get<unknown[]>("/user/orgs");
  if (Array.isArray(orgs) && orgs.length) return { reason: `member of ${orgs.length} organisations`, status: "excluded" };
  return { user };
}

export async function provisionAccount(o: ProvisionOptions): Promise<ProvisionResult> {
  const log = o.log ?? (() => {});
  const dry = !!o.dryRun;
  const skipped: ProvisionResult["skipped"] = [];
  const now = o.now ?? (() => new Date());
  const gh = (token: string) => new GitHub({ token, base: o.apiBase, fetch: o.fetch, dryRun: dry, onWrite: (m, p) => log(`github ${dry ? "(dry run) " : ""}${m} ${p}`) });

  // 1. pick: an account already given to this agent wins (re-runs finish an interrupted assignment)
  let acct = o.pool.assignedTo(o.agent);
  let client: GitHub | null = null;
  let user: { login: string; id: number } | null = null;
  if (acct) {
    client = gh(acct.token);
    user = await client.get("/user");
    log(`github: ${acct.login} is already assigned to ${o.agent}; finishing its provisioning`);
  } else {
    for (const a of o.pool.candidates(o.exclude ?? EXCLUDED_LOGINS)) {
      const c = gh(a.token);
      const v = await vet(c, a);
      if ("reason" in v) {
        skipped.push({ login: a.login, reason: v.reason });
        log(`github: skipping ${a.login}: ${v.reason}`);
        if (!dry && v.status) o.pool.update(a.login, { status: v.status, note: v.reason });
        continue;
      }
      acct = a;
      client = c;
      user = v.user;
      break;
    }
    if (!acct || !client || !user) throw new Error("no usable account left in the pool");
    if (!dry) o.pool.update(acct.login, { status: "assigning", assigned_agent: o.agent, assigned_at: now().toISOString() });
    log(`github: assigning ${acct.login} to ${o.agent}${dry ? " (dry run)" : ""}`);
  }
  if (!user) throw new Error("unreachable: no GitHub user");

  // 2. clean the previous owner's traces
  const starred = await client.paged<{ full_name: string }>("/user/starred");
  for (const r of starred) await client.request("DELETE", `/user/starred/${r.full_name}`, undefined, { okStatuses: [404] });
  const gists = (await client.paged<{ id: string; owner?: { login: string } }>("/gists")).filter((g) => !g.owner || g.owner.login.toLowerCase() === acct!.login.toLowerCase());
  for (const g of gists) await client.request("DELETE", `/gists/${g.id}`, undefined, { okStatuses: [404] });
  const oldKeys = await client.paged<{ id: number; key: string }>("/user/ssh_signing_keys");
  const cleared = { name: "", bio: "", company: "", blog: "", location: "", twitter_username: "", hireable: false };
  await client.request("PATCH", "/user", cleared);
  log(`github: cleaned ${acct.login}: ${starred.length} stars, ${gists.length} gists, profile fields cleared`);

  // 3. profile from the soul
  const name = o.soul.persona.name.slice(0, 255);
  const bio = githubBio(o.soul, o.profileUrl);
  const blog = o.profileUrl ?? "";
  await client.request("PATCH", "/user", { name, bio, blog });

  // 4. agent-bound signing key (and remove any signing key the account already had)
  let publicKey: string | null = null;
  let keyId: number | null = null;
  let privatePath = "";
  for (const k of oldKeys) await client.request("DELETE", `/user/ssh_signing_keys/${k.id}`, undefined, { okStatuses: [404] });
  if (!dry) {
    const kp = (o.keygen ?? sshKeygen)(o.store.keyDir(o.agent), `lineage-agent-${o.agent}`);
    publicKey = kp.publicKey;
    privatePath = kp.privatePath;
    const reg = await client.request<{ id: number; key: string }>("POST", "/user/ssh_signing_keys", { title: `lineage agent ${o.agent.slice(0, 12)}`, key: publicKey });
    keyId = reg.data?.id ?? null;
  } else {
    await client.request("POST", "/user/ssh_signing_keys", { title: `lineage agent ${o.agent.slice(0, 12)}`, key: "<generated at assignment>" });
  }

  // 5. runtime-only credential store, then the pool record
  if (!dry) {
    const cred: AgentCredential = {
      v: 1, agent: o.agent, login: acct.login, github_id: user.id, token: acct.token, ssh_private_key_path: privatePath,
      ssh_public_key: publicKey!, ssh_signing_key_id: keyId, assigned_at: now().toISOString(),
    };
    o.store.put(cred);
    o.pool.update(acct.login, { status: "assigned", assigned_agent: o.agent });
  }
  return {
    agent: o.agent, login: acct.login, github_id: user.id, dry_run: dry, skipped,
    cleaned: { unstarred: starred.length, gists_deleted: gists.length, signing_keys_removed: oldKeys.length, profile_cleared: true },
    profile: { name, bio, blog }, ssh_signing_key: publicKey, ssh_signing_key_id: keyId,
    writes: client.writes.map((w) => ({ method: w.method, path: w.path })),
  };
}
