// One signed commit to the account's profile repository <login>/<login> (GitHub shows its README on the
// account's profile page; docs/plans/GITHUB-GENESIS.md). Creates the repository when missing (public,
// empty), then commits with the agent's SSH signing key under the account's noreply address, so GitHub
// shows Verified, and pushes without force on top of the current head. The token reaches git only
// through environment configuration (commit.ts), and the working copy is removed afterwards.

import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GitHub, type Fetch } from "./api.ts";
import { gitAuthEnv, noreplyEmail, runGit, safeCommitPath } from "./commit.ts";
import type { AgentCredential } from "./credentials.ts";

export interface ProfileRepoState {
  /** the repository had no commit yet */
  empty: boolean;
  /** text of README.md at the head, or null */
  readme: string | null;
  /** text of any other file at the head the caller asks about (by path), or null */
  read(path: string): string | null;
}

export interface ProfileCommitOptions {
  cred: AgentCredential;
  /** the files to write, decided from the current head (README kept or replaced, 2.5) */
  plan: (s: ProfileRepoState) => Record<string, string>;
  /** the commit's tree is exactly the planned files (pool accounts); otherwise they are written over the head's tree */
  replaceTree: boolean;
  message: string;
  /** repository name under the account; the profile repository <login> by default (agent learnings use lineage-learnings) */
  repoName?: string;
  description?: string;
  homepage?: string;
  apiBase?: string;
  /** git remote host base, https://github.com by default (tests use file:// bare repositories) */
  gitBase?: string;
  fetch?: Fetch;
  log?: (m: string) => void;
  /** polls of the commit's verification (2 s apart); tests pass 1 */
  verifyPolls?: number;
}

export interface ProfileCommitResult {
  repo: string;
  created: boolean;
  /** nothing changed: no commit was made; sha is the current head */
  unchanged: boolean;
  sha: string;
  branch: string;
  verified: boolean | null;
  reason: string;
  html_url: string;
  files: string[];
}

export async function profileRepoCommit(o: ProfileCommitOptions): Promise<ProfileCommitResult> {
  const log = o.log ?? (() => {});
  const login = o.cred.login;
  const name = o.repoName ?? login;
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) throw new Error(`bad repository name ${JSON.stringify(name)}`);
  const repo = `${login}/${name}`;
  const gh = new GitHub({ token: o.cred.token, base: o.apiBase, fetch: o.fetch });
  const gitBase = (o.gitBase ?? "https://github.com").replace(/\/$/, "");

  let info = await gh.get<{ full_name: string; fork: boolean; archived: boolean; private: boolean; default_branch?: string; message?: string } | null>(`/repos/${repo}`, [404]);
  let created = false;
  if (!info || info.message) {
    const r = await gh.request<{ full_name: string; default_branch?: string }>("POST", "/user/repos", {
      name, description: o.description ?? "", homepage: o.homepage ?? "", private: false, auto_init: false, has_issues: false, has_wiki: false, has_projects: false,
    });
    info = { full_name: r.data?.full_name ?? repo, fork: false, archived: false, private: false, default_branch: r.data?.default_branch };
    created = true;
    log(`github: created ${repo}`);
  }
  if (info.fork) throw new Error(`${repo} is a fork; the profile repository must be the account's own`);
  if (info.archived) throw new Error(`${repo} is archived`);
  if (info.private) throw new Error(`${repo} is private; a profile README must be public`);

  const work = mkdtempSync(join(tmpdir(), "lineage-profile-repo-"));
  try {
    const env = gitAuthEnv(o.cred.token, gitBase);
    runGit(work, ["init", "-q"]);
    runGit(work, ["remote", "add", "origin", `${gitBase}/${repo}.git`]);
    const head = runGit(work, ["ls-remote", "origin", "HEAD"], env);
    const empty = head.trim() === "";
    let branch = info.default_branch || "main";
    if (!empty) {
      runGit(work, ["fetch", "-q", "--depth", "1", "origin", "HEAD"], env);
      const sym = runGit(work, ["ls-remote", "--symref", "origin", "HEAD"], env).match(/^ref: refs\/heads\/(\S+)\s+HEAD/m);
      if (sym) branch = sym[1]!;
      runGit(work, ["checkout", "-q", "-b", branch, "FETCH_HEAD"]);
    } else {
      runGit(work, ["checkout", "-q", "--orphan", branch]);
    }
    const read = (p: string) => {
      const f = join(work, p);
      return safeCommitPath(p) && existsSync(f) ? readFileSync(f, "utf8") : null;
    };
    const files = o.plan({ empty, readme: read("README.md"), read });
    for (const p of Object.keys(files)) if (!safeCommitPath(p)) throw new Error(`unsafe file path: ${JSON.stringify(p)}`);
    if (o.replaceTree && !empty) runGit(work, ["rm", "-r", "-q", "--ignore-unmatch", "."]);
    for (const [p, body] of Object.entries(files)) {
      const full = join(work, p);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, body);
      runGit(work, ["add", "--", p]);
    }
    const changed = runGit(work, ["status", "--porcelain"]) !== "";
    if (!changed && !empty) {
      const sha = runGit(work, ["rev-parse", "HEAD"]);
      return { repo, created, unchanged: true, sha, branch, verified: null, reason: "unchanged", html_url: `https://github.com/${repo}/commit/${sha}`, files: Object.keys(files) };
    }
    const c = o.cred;
    const ident = ["-c", `user.name=${c.login}`, "-c", `user.email=${noreplyEmail(c)}`, "-c", "gpg.format=ssh", "-c", `user.signingkey=${c.ssh_private_key_path}`, "-c", "commit.gpgsign=true"];
    const msgFile = join(work, ".git", "LINEAGE_MSG");
    writeFileSync(msgFile, o.message);
    runGit(work, [...ident, "commit", "-q", "-S", "-F", msgFile]);
    const sha = runGit(work, ["rev-parse", "HEAD"]);
    runGit(work, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`], env);
    log(`github: pushed ${sha.slice(0, 12)} to ${repo}:${branch}`);

    let v = { verified: false as boolean | null, reason: "unknown" };
    let url = `https://github.com/${repo}/commit/${sha}`;
    const polls = o.verifyPolls ?? 10;
    for (let i = 0; i < polls; i++) {
      const r = await gh.get<any>(`/repos/${repo}/commits/${sha}`, [404, 422]);
      if (r?.commit?.verification) {
        v = { verified: !!r.commit.verification.verified, reason: String(r.commit.verification.reason) };
        url = r.html_url ?? url;
        if (v.verified || v.reason !== "unknown") break;
      }
      if (i + 1 < polls) await Bun.sleep(2000);
    }
    return { repo, created, unchanged: false, sha, branch, verified: v.verified, reason: v.reason, html_url: url, files: Object.keys(files) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
