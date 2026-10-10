// Verifies one accepted generation against its public GitHub commit (docs/plans/GENERATIONS-ON-GITHUB.md 5).
// Reads the generation from Core, the commit from GitHub's public REST API and the git objects with a
// plain `git fetch`, then checks:
//   1. trailers name the generation, lineage, height, Core's patch_hash, verdict digest and author;
//   2. the commit's change is Core's patch: `git diff parent commit` canonicalised has Core's
//      patch_hash, or (git re-diffs with its own context) Core's patch applied to the parent gives
//      the commit's tree; a revert entry's tree is the snapshot plus Core's patch series for it;
//   3. its first parent is the parent generation's recorded commit (the snapshot commit at height 1);
//   4. GitHub reports the signature Verified.
// Used by scripts/identity/verify-generation.ts; no credentials are needed (public repositories).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeDiff, patchHash } from "../../protocol/src/diff.ts";
import { apply } from "./chain.ts";
import { git } from "./git.ts";
import { parseTrailers } from "./message.ts";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface VerifyOptions {
  core: string;
  genId: string;
  /** GitHub REST base (default https://api.github.com) */
  apiBase?: string;
  /** git host base (default https://github.com; tests use a directory of bare repositories) */
  gitBase?: string;
  /** fetch for the GitHub API (tests) */
  fetch?: Fetch;
  /** fetch for Core (tests) */
  coreFetch?: Fetch;
  /** optional GitHub token, only to raise the API rate limit */
  token?: string | null;
}

export interface Check {
  name: string;
  /** true pass, false fail, null warning (passes with a caveat) */
  ok: boolean | null;
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  gen_id: string;
  repo: string | null;
  commit: string | null;
  url: string | null;
  checks: Check[];
}

async function getJson(f: Fetch, url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const r = await f(url, { headers: { accept: "application/json", ...headers } });
  let body: any = null;
  try {
    body = await r.json();
  } catch {
    body = null;
  }
  return { status: r.status, body };
}

export async function verifyGeneration(o: VerifyOptions): Promise<VerifyResult> {
  const core = o.core.replace(/\/$/, "");
  const cf = o.coreFetch ?? ((u, i) => fetch(u, i));
  const gf = o.fetch ?? ((u, i) => fetch(u, i));
  const api = (o.apiBase ?? "https://api.github.com").replace(/\/$/, "");
  const gitBase = (o.gitBase ?? "https://github.com").replace(/\/$/, "");
  const ghHeaders: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "lineage-verify-generation" };
  if (o.token) ghHeaders.authorization = `Bearer ${o.token}`;
  const checks: Check[] = [];
  const res: VerifyResult = { ok: false, gen_id: o.genId, repo: null, commit: null, url: null, checks };
  const add = (name: string, ok: boolean | null, detail: string) => checks.push({ name, ok, detail });

  const gr = await getJson(cf, `${core}/v1/generations/${o.genId}`);
  if (gr.status !== 200) {
    add("generation", false, `Core answered ${gr.status} for the generation`);
    return res;
  }
  const g = gr.body;
  const gh = g.github;
  if (!gh || !gh.commit) {
    add("published", false, gh?.status ? `no commit yet: ${gh.status}` : "this generation has no GitHub commit (gen 0 or not a GitHub repository)");
    return res;
  }
  const repo = String(gh.repo ?? /github\.com\/([^/]+\/[^/]+)\/commit\//.exec(String(gh.url))?.[1] ?? "");
  const sha = String(gh.commit);
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !/^[0-9a-f]{40}$/.test(sha)) {
    add("published", false, "Core's record does not name a repository and a 40 hex commit");
    return res;
  }
  Object.assign(res, { repo, commit: sha, url: gh.url ?? `https://github.com/${repo}/commit/${sha}` });
  add("published", true, `${repo}@${sha.slice(0, 12)}${gh.branch ? ` on ${gh.branch}` : ""}`);

  const lr = await getJson(cf, `${core}/v1/lineages/${g.lineage_id}`);
  if (lr.status !== 200) {
    add("lineage", false, `Core answered ${lr.status} for the lineage`);
    return res;
  }
  const L = lr.body;
  const snapshot = String(L.snapshot?.commit_sha ?? "");

  const cr = await getJson(gf, `${api}/repos/${repo}/commits/${sha}`, ghHeaders);
  if (cr.status !== 200 || !cr.body?.commit) {
    add("github commit", false, `GitHub answered ${cr.status} for ${repo}@${sha.slice(0, 12)}`);
    return res;
  }
  const c = cr.body;

  // 1. trailers
  const t = parseTrailers(String(c.commit.message ?? ""));
  const want: [string, string | null][] = [
    ["Lineage-Generation", g.gen_id],
    ["Lineage-Lineage", g.lineage_id],
    ["Lineage-Height", String(g.height)],
    ["Lineage-Patch-Sha256", g.entry_type === "patch" ? g.patch_hash : null],
    ["Lineage-Verdict", g.verdict_digest ?? null],
    ["Lineage-Agent", g.author ?? "none"],
  ];
  const bad = want.filter(([k, v]) => v !== null && t[k] !== v).map(([k]) => k);
  add("trailers", bad.length === 0, bad.length ? `mismatch: ${bad.join(", ")}` : want.filter(([, v]) => v !== null).map(([k]) => k).join(", ") + " match Core");

  // 3. parent
  const parent = String(c.parents?.[0]?.sha ?? "");
  let expected: string | null = null;
  let parentGen: any = null;
  if (g.parent_gen_id) {
    const pr = await getJson(cf, `${core}/v1/generations/${g.parent_gen_id}`);
    parentGen = pr.status === 200 ? pr.body : null;
  }
  if (!parentGen || parentGen.entry_type === "genesis") expected = snapshot;
  else expected = parentGen.github?.commit ?? null;
  if (!parent) add("parent", false, "GitHub lists no parent for the commit");
  else if (expected) add("parent", parent === expected, parent === expected ? `${parent.slice(0, 12)} is ${parentGen && parentGen.entry_type !== "genesis" ? `generation ${parentGen.height}'s recorded commit` : "the recipe's pinned snapshot commit"}` : `parent ${parent.slice(0, 12)}, expected ${expected.slice(0, 12)}`);
  else {
    const pc = await getJson(gf, `${api}/repos/${repo}/commits/${parent}`, ghHeaders);
    const pt = pc.status === 200 ? parseTrailers(String(pc.body?.commit?.message ?? "")) : {};
    const named = pt["Lineage-Generation"] === g.parent_gen_id;
    add("parent", named ? null : false, named ? `the parent generation has no recorded commit yet (${parentGen?.github?.status ?? "pending"}); parent ${parent.slice(0, 12)} names it in its trailers` : `parent ${parent.slice(0, 12)} does not name generation ${String(g.parent_gen_id).slice(0, 12)}`);
  }

  // 2. the change itself, from the git objects
  const dir = mkdtempSync(join(tmpdir(), "lineage-verify-gen-"));
  try {
    git(dir, ["init", "-q"]);
    const url = `${gitBase}/${repo}.git`;
    const f = git(dir, ["fetch", "-q", "--depth", "2", url, sha], { allowFail: true });
    if (!f.ok) throw new Error(`git fetch of ${sha.slice(0, 12)} failed: ${f.err.split("\n")[0]}`);
    const tree = git(dir, ["rev-parse", `${sha}^{tree}`]).out;
    if (g.entry_type === "patch") {
      const d = git(dir, ["diff", "--no-color", "--no-ext-diff", "--no-renames", `${sha}^1`, sha]).out;
      let same = false;
      try {
        same = patchHash(canonicalizeDiff(d + "\n")) === g.patch_hash;
      } catch {
        same = false;
      }
      if (same) add("diff", true, "git diff of the commit has Core's patch_hash");
      else {
        git(dir, ["checkout", "-q", "--detach", `${sha}^1`]);
        try {
          apply(dir, String(g.patch ?? ""), g.gen_id);
          const got = git(dir, ["write-tree"]).out;
          add("diff", got === tree, got === tree ? "same tree: Core's patch applied to the parent gives the commit's tree (git re-diffs with its own context)" : "Core's patch applied to the parent does not give the commit's tree");
        } catch (e) {
          add("diff", false, `Core's patch does not apply to the parent: ${(e as Error).message}`);
        }
      }
    } else if (g.entry_type === "revert") {
      const tr = await getJson(cf, `${core}/v1/lineages/${g.lineage_id}/tree?gen=${g.gen_id}`);
      const s = git(dir, ["fetch", "-q", url, snapshot], { allowFail: true });
      if (tr.status !== 200 || !s.ok) add("diff", false, "could not read Core's tree or the snapshot commit");
      else {
        git(dir, ["checkout", "-q", "--detach", snapshot]);
        for (const p of tr.body.patches ?? []) apply(dir, p.patch, p.gen_id);
        const got = git(dir, ["write-tree"]).out;
        add("diff", got === tree, got === tree ? "the revert's tree is the snapshot plus Core's patch series" : "the revert's tree differs from Core's patch series");
      }
    }
  } catch (e) {
    add("diff", false, (e as Error).message);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // 4. signature
  const v = c.commit.verification ?? {};
  add("signature", v.verified === true, v.verified === true ? `GitHub: Verified (${v.reason ?? "valid"})` : `GitHub: not verified (${v.reason ?? "unknown"})`);

  res.ok = checks.every((x) => x.ok !== false);
  return res;
}
