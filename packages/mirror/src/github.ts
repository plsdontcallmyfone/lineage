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

/** The account's fork of `upstream` (created when missing). Throws when a same-named repository is not a fork of it. */
export async function ensureFork(gh: GitHub, login: string, upstream: string, t: GitHubTarget): Promise<{ fork: string; created: boolean }> {
  const repo = upstream.split("/")[1]!;
  const existing = await gh.get<any>(`/repos/${login}/${repo}`, [404]);
  if (existing && !existing.message && existing.full_name) {
    if (existing.full_name.toLowerCase() === upstream.toLowerCase()) throw new Error(`${upstream} belongs to the agent's own account; it has no fork of it`);
    if (!existing.fork || (existing.parent && existing.parent.full_name.toLowerCase() !== upstream.toLowerCase() && existing.source?.full_name?.toLowerCase() !== upstream.toLowerCase())) {
      throw new Error(`${existing.full_name} exists and is not a fork of ${upstream}`);
    }
    return { fork: existing.full_name, created: false };
  }
  const f = await gh.request<{ full_name: string }>("POST", `/repos/${upstream}/forks`, { default_branch_only: true });
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
