// GitHub operations of the mirror and the PR bot, all under the agent's own token (SPEC 13.9: create
// fork, push branches to its forks, open PRs on opted-in repositories). There is deliberately no
// call that comments on, reviews, reopens or edits an issue or pull request.

import { GitHub, type Fetch } from "../../souls/src/github/api.ts";
import { authEnv, git } from "./git.ts";

export interface GitHubTarget {
  apiBase?: string;
  /** git host base, https://github.com by default; tests use a local directory of bare repositories */
  gitBase?: string;
  fetch?: Fetch;
  /** seconds to wait for a new fork */
  forkWaitS?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function client(token: string, t: GitHubTarget): GitHub {
  return new GitHub({ token, base: t.apiBase, fetch: t.fetch });
}

export const gitBaseOf = (t: GitHubTarget) => (t.gitBase ?? "https://github.com").replace(/\/$/, "");
export const gitUrl = (t: GitHubTarget, fullName: string) => `${gitBaseOf(t)}/${fullName}.git`;

/**
 * The fork of `upstream` under `owner` (the token's account, or an organization it may create
 * repositories in), created when missing. A same-named repository under `owner` that is not a fork
 * of `upstream` (two upstreams named base58) leaves the name to it: the fork is then
 * `<upstream owner>-<repo>` (docs/plans/GITHUB-ORG.md 3).
 */
export async function ensureFork(gh: GitHub, owner: string, upstream: string, t: GitHubTarget, o: { organization?: boolean } = {}): Promise<{ fork: string; created: boolean }> {
  const [upOwner, repo] = upstream.split("/") as [string, string];
  // an upstream that moved (ethereum/pyrlp is now ApeWorX/pyrlp; GitHub redirects the old name) is
  // the parent of its forks under its current name
  const names = new Set([upstream.toLowerCase()]);
  const up = await gh.get<any>(`/repos/${upstream}`, [404]);
  if (up?.full_name) names.add(String(up.full_name).toLowerCase());
  const forkOf = (r: any) => !!r?.fork && (!r.parent || names.has(String(r.parent.full_name ?? "").toLowerCase()) || names.has(String(r.source?.full_name ?? "").toLowerCase()));
  let name = repo;
  for (const candidate of [repo, `${upOwner}-${repo}`]) {
    name = candidate;
    const existing = await gh.get<any>(`/repos/${owner}/${candidate}`, [404]);
    if (!existing || existing.message || !existing.full_name) break;
    if (names.has(existing.full_name.toLowerCase())) throw new Error(`${upstream} belongs to the agent's own account; it has no fork of it`);
    if (forkOf(existing)) return { fork: existing.full_name, created: false };
    if (candidate !== repo) throw new Error(`${existing.full_name} exists and is not a fork of ${upstream}`);
  }
  const body: Record<string, unknown> = { default_branch_only: true };
  if (o.organization) body.organization = owner;
  if (name !== repo) body.name = name;
  const f = await gh.request<{ full_name: string }>("POST", `/repos/${upstream}/forks`, body);
  const fork = f.data.full_name;
  const sleep = t.sleep ?? ((ms: number) => Bun.sleep(ms));
  const deadline = Date.now() + (t.forkWaitS ?? 120) * 1000;
  for (;;) {
    const r = await gh.get<any>(`/repos/${fork}`, [404]);
    if (r && !r.message && r.size !== undefined) {
      const br = await gh.get<any[]>(`/repos/${fork}/branches`, [404]);
      if (Array.isArray(br) && br.length) break;
    }
    if (Date.now() > deadline) throw new Error(`fork ${fork} not ready after ${t.forkWaitS ?? 120} s`);
    await sleep(3000);
  }
  return { fork, created: true };
}

/** Head commit of a branch, or null when the branch does not exist. */
export async function branchHead(gh: GitHub, repo: string, branch: string): Promise<string | null> {
  const r = await gh.get<any>(`/repos/${repo}/git/ref/heads/${branch}`, [404]);
  if (!r || r.message || !r.object) return null;
  return String(r.object.sha);
}

/** Force-pushes `sha` to `branch` of `repo` from the local working repository (GitHub is a mirror). */
export function push(dir: string, token: string, t: GitHubTarget, repo: string, sha: string, branch: string) {
  git(dir, ["push", "-q", "--force", gitUrl(t, repo), `${sha}:refs/heads/${branch}`], { env: authEnv(token, gitBaseOf(t)) });
}

export async function deleteBranch(gh: GitHub, repo: string, branch: string) {
  await gh.request("DELETE", `/repos/${repo}/git/refs/heads/${branch}`, undefined, { okStatuses: [404, 422] });
}

/** GitHub's signature verification of a commit (polls briefly: the API can lag a push). */
export async function verification(gh: GitHub, repo: string, sha: string, t: GitHubTarget, tries = 8): Promise<{ verified: boolean; reason: string; html_url: string }> {
  const sleep = t.sleep ?? ((ms: number) => Bun.sleep(ms));
  let last = { verified: false, reason: "unknown", html_url: "" };
  for (let i = 0; i < tries; i++) {
    const c = await gh.get<any>(`/repos/${repo}/commits/${sha}`, [404, 422]);
    if (c?.commit?.verification) {
      last = { verified: !!c.commit.verification.verified, reason: String(c.commit.verification.reason), html_url: c.html_url ?? "" };
      if (last.verified || last.reason !== "unknown") return last;
    }
    await sleep(1500);
  }
  return last;
}
