// A signed commit under the agent's GitHub account (identity plan I4, SPEC 14.8): fork the target
// repository under the account, branch the agent's lineage branch at a base commit, commit with the
// agent's SSH signing key (committer email = the account's noreply address, which GitHub counts as
// verified), push with the stored token, then ask GitHub whether it shows the commit as Verified.
// The token reaches git only through environment configuration (never argv, never a URL), and the
// working copy is removed afterwards.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GitHub, redactTokens, type Fetch } from "./api.ts";
import type { AgentCredential } from "./credentials.ts";

export interface SignedCommitOptions {
  cred: AgentCredential;
  /** "owner/repo" of the target */
  upstream: string;
  /** the agent's lineage branch, e.g. "lineage/minbpe-3f2a91c0" */
  branch: string;
  /** commit the branch starts from (the recipe's pinned commit); default: the fork's default branch head */
  baseCommit?: string;
  files: Record<string, string>;
  message: string;
  apiBase?: string;
  /** git remote host base, https://github.com by default (tests use a local bare repo path) */
  gitBase?: string;
  fetch?: Fetch;
  log?: (m: string) => void;
  /** seconds to wait for GitHub to finish creating the fork */
  forkWaitS?: number;
}

export interface SignedCommitResult {
  fork: string;
  branch: string;
  sha: string;
  verified: boolean;
  reason: string;
  html_url: string;
}

const noreply = (c: AgentCredential) => `${c.github_id}+${c.login}@users.noreply.github.com`;

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env } });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${redactTokens(r.stderr || r.stdout)}`);
  return r.stdout.trim();
}

/** Environment that adds the Authorization header for github.com without putting the token in argv or URLs. */
function authEnv(token: string, gitBase: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `http.${gitBase}/.extraheader`, GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` };
}

export async function signedCommit(o: SignedCommitOptions): Promise<SignedCommitResult> {
  const log = o.log ?? (() => {});
  const gh = new GitHub({ token: o.cred.token, base: o.apiBase, fetch: o.fetch });
  const gitBase = (o.gitBase ?? "https://github.com").replace(/\/$/, "");
  const [owner, repo] = o.upstream.split("/");
  if (!owner || !repo) throw new Error(`upstream must be owner/repo, got ${o.upstream}`);

  // fork (idempotent: GitHub answers 202 with the existing fork)
  const existing = await gh.get<{ full_name: string; fork: boolean; parent?: { full_name: string } } | null>(`/repos/${o.cred.login}/${repo}`, [404]);
  let forkName = `${o.cred.login}/${repo}`;
  if (!existing || (existing as any).message) {
    const f = await gh.request<{ full_name: string }>("POST", `/repos/${owner}/${repo}/forks`, { default_branch_only: true });
    forkName = f.data.full_name;
    log(`github: forked ${o.upstream} to ${forkName}`);
    const deadline = Date.now() + (o.forkWaitS ?? 120) * 1000;
    for (;;) {
      const r = await gh.get<any>(`/repos/${forkName}`, [404]);
      if (r && !r.message && r.size !== undefined) {
        const br = await gh.get<any[]>(`/repos/${forkName}/branches`, [404]);
        if (Array.isArray(br) && br.length) break;
      }
      if (Date.now() > deadline) throw new Error(`fork ${forkName} not ready after ${o.forkWaitS ?? 120} s`);
      await Bun.sleep(3000);
    }
  } else if (existing.parent && existing.parent.full_name.toLowerCase() !== o.upstream.toLowerCase()) {
    throw new Error(`${forkName} exists and is not a fork of ${o.upstream}`);
  }

  const work = mkdtempSync(join(tmpdir(), "lineage-souls-commit-"));
  try {
    const env = authEnv(o.cred.token, gitBase);
    const remote = `${gitBase}/${forkName}.git`;
    git(work, ["init", "-q"]);
    git(work, ["remote", "add", "origin", remote]);
    let base = o.baseCommit;
    if (base) {
      // fetch the pinned commit from the upstream (a fork shares its objects)
      git(work, ["fetch", "-q", "--depth", "1", `${gitBase}/${o.upstream}.git`, base], env);
    } else {
      git(work, ["fetch", "-q", "--depth", "1", "origin", "HEAD"], env);
      base = git(work, ["rev-parse", "FETCH_HEAD"]);
    }
    git(work, ["checkout", "-q", "-b", o.branch, base]);
    for (const [path, body] of Object.entries(o.files)) {
      const full = join(work, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, body);
      git(work, ["add", "--", path]);
    }
    const ident = ["-c", `user.name=${o.cred.login}`, "-c", `user.email=${noreply(o.cred)}`, "-c", "gpg.format=ssh", "-c", `user.signingkey=${o.cred.ssh_private_key_path}`, "-c", "commit.gpgsign=true"];
    const msgFile = join(work, ".git", "LINEAGE_MSG");
    writeFileSync(msgFile, o.message);
    git(work, [...ident, "commit", "-q", "-S", "-F", msgFile]);
    const sha = git(work, ["rev-parse", "HEAD"]);
    git(work, ["push", "-q", "--force", "origin", `HEAD:refs/heads/${o.branch}`], env);
    log(`github: pushed ${sha.slice(0, 12)} to ${forkName}:${o.branch}`);

    // GitHub records verification at push time; poll briefly in case the API lags the push
    let v = { verified: false, reason: "unknown" };
    let url = "";
    for (let i = 0; i < 10; i++) {
      const c = await gh.get<any>(`/repos/${forkName}/commits/${sha}`, [404, 422]);
      if (c?.commit?.verification) {
        v = { verified: !!c.commit.verification.verified, reason: String(c.commit.verification.reason) };
        url = c.html_url ?? "";
        if (v.verified || v.reason !== "unknown") break;
      }
      await Bun.sleep(2000);
    }
    return { fork: forkName, branch: o.branch, sha, verified: v.verified, reason: v.reason, html_url: url };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Commit trailers that tie a mirror commit to the lineage record (identity plan 2.3.2). */
export function lineageTrailers(t: { agent: string; lineage?: string | null; gen?: string | null; soul?: string | null }): string {
  return [`Agent: ${t.agent}`, t.lineage ? `Lineage-Lineage: ${t.lineage}` : null, t.gen ? `Lineage-Gen: ${t.gen}` : null, t.soul ? `Lineage-Soul: ${t.soul}` : null].filter(Boolean).join("\n");
}
