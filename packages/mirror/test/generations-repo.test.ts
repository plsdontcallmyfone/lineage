// The app identity's one consolidated repository (docs/plans/GITHUB-ORG.md 6): new app-identity
// generations go to units-agents/generations, created empty (not a fork) on first use, one branch per
// unit, with the upstream history each commit's parent needs; accounts keep their own forks.
// verify-generation explains a generation whose repository was deleted on purpose.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommitIdentity, Identities } from "../src/chain.ts";
import { CoreReader } from "../src/coreapi.ts";
import { noreplyEmail } from "../src/git.ts";
import { lineageBranch } from "../src/message.ts";
import { mirrorOnce } from "../src/mirror.ts";
import { verifyGeneration } from "../src/verify.ts";
import { keypair, MockGitHub } from "./mockgh.ts";

const H = (c: string) => c.repeat(64);
const LIN = H("a");
const LIN2 = H("c");
const G0 = H("0");
const G1 = H("1");
const G2 = H("2");
const AGENT = "AgentBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; // no account: app identity
const P1 = "diff --git a/lib.py b/lib.py\n--- a/lib.py\n+++ b/lib.py\n@@ -1,2 +1,2 @@\n def a():\n-    return 2\n+    return 1\n";
const P2 = "diff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-b\n+bb\n";

let root: string;
let gh: MockGitHub;
let base1: string;
let base2: string;
let ids: Identities;
let removed = false;

const gen = (id: string, lin: string, patch: string) => ({
  gen_id: id, lineage_id: lin, parent_gen_id: G0, height: 1, entry_type: "patch", candidate_id: H("7"), patch_hash: H("f"), patch,
  kind: "perf", target: "ir", effect: { metric: "ir", ratio: 0.9, ci_low: 0.9, ci_high: 0.9 }, verdict_digest: H("d"), replay_ids: [H("8")],
  author: AGENT, team: null, accepted_at: Date.UTC(2026, 9, 11, 10), epoch: 1, reverts: null, reverted_by: null,
});
const lineage = (lin: string) => {
  const two = lin === LIN;
  return {
    lineage_id: lin, repo: two ? "https://github.com/up/deep" : "https://github.com/other/deep", snapshot: { commit_sha: two ? base1 : base2 }, recipe: { name: two ? "deep" : "deep2" }, status: "active", tip: two ? G1 : G2, height: 1,
    generations: [{ gen_id: G0, parent_gen_id: null, height: 0, entry_type: "genesis", candidate_id: null, author: null, accepted_at: 0, reverts: null }, two ? gen(G1, LIN, P1) : gen(G2, LIN2, P2)],
  };
};
const fakeCore = async (url: string): Promise<Response> => {
  const p = new URL(url).pathname;
  const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s });
  if (p === "/v1/lineages") return json([LIN, LIN2].map((l) => ({ lineage_id: l, repo: lineage(l).repo, recipe_name: lineage(l).recipe.name, status: "active", height: 1, tip: lineage(l).tip })));
  const l = /^\/v1\/lineages\/([0-9a-f]{64})$/.exec(p);
  if (l) return json(lineage(l[1]!));
  if (p === `/v1/generations/${G1}`)
    return json({ ...gen(G1, LIN, P1), github: removed ? { status: "removed", reason: "test data, repository deleted 2026-10-11", removed_at: 1, repo: "units-agents/deep", former_commit: "e".repeat(40) } : { status: "pending" } });
  if (p === `/v1/generations/${G2}`) return json(gen(G2, LIN2, P2));
  return json({ error: "not_found" }, 404);
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "units-genrepo-"));
  gh = new MockGitHub(join(root, "host"));
  // several upstream commits: a depth-1 working copy is shallow, and the new repository has none of them
  gh.createRepo("up/deep", { "lib.py": "def a():\n    return 3\n" });
  gh.commitUpstream("up/deep", { "lib.py": "def a():\n    return 2\n" }, "second");
  base1 = spawnSync("git", ["rev-parse", "main"], { cwd: gh.bare("up/deep"), encoding: "utf8" }).stdout.trim();
  gh.createRepo("other/deep", { "b.txt": "x\n" });
  base2 = gh.commitUpstream("other/deep", { "b.txt": "b\n" }, "second");
  const k = keypair(root, "pub");
  gh.users.push({ login: "pub", id: 77, token: "tok-pub", signingKey: k.publicKey });
  const app: CommitIdentity = { kind: "app", name: "pub", email: noreplyEmail(77, "pub"), signingKey: k.privatePath, login: "pub", token: "tok-pub", owner: "units-agents", repo: "units-agents/generations" };
  ids = { forAgent: () => null, app: () => app };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const opts = () => ({ core: new CoreReader("http://core.mock", fakeCore), identities: ids, apiBase: gh.api, gitBase: gh.root, fetch: gh.fetch, site: "https://site.mock", sleep: async () => {} });
const git = (repo: string, args: string[]) => spawnSync("git", args, { cwd: gh.bare(repo), encoding: "utf8" });

test("app generations of two upstreams publish into one created repository, with history, no fork", async () => {
  const r = await mirrorOnce(opts());
  expect(r.lineages.map((l) => l.status)).toEqual(["built", "built"]);
  expect(r.lineages.flatMap((l) => l.pushes).map((p) => [p.fork, p.action])).toEqual([["units-agents/generations", "pushed"], ["units-agents/generations", "pushed"]]);
  const writes = gh.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`);
  expect(writes).toEqual(["POST /orgs/units-agents/repos"]);
  expect(gh.forks.size).toBe(0);
  for (const g of r.generations) expect(g).toMatchObject({ identity: "app", status: "fallback", fork: "units-agents/generations", verified: true });
  // unrelated histories side by side, each branch's parent chain intact down to its upstream root
  for (const [lin, recipe, b] of [[LIN, "deep", base1], [LIN2, "deep2", base2]] as const) {
    const branch = lineageBranch(recipe, lin);
    const tip = git("units-agents/generations", ["rev-parse", `refs/heads/${branch}`]).stdout.trim();
    expect(git("units-agents/generations", ["rev-parse", `${tip}^1`]).stdout.trim()).toBe(b);
    expect(git("units-agents/generations", ["rev-list", "--count", tip]).stdout.trim()).toBe("3");
  }
  // a second cycle reuses the repository and pushes nothing
  const again = await mirrorOnce(opts());
  expect(again.lineages.flatMap((l) => l.pushes).map((p) => p.action)).toEqual(["unchanged", "unchanged"]);
  expect(gh.calls.filter((c) => c.method !== "GET").length).toBe(1);
});

test("verify-generation explains a removed repository instead of failing", async () => {
  removed = true;
  const v = await verifyGeneration({ core: "http://core.mock", genId: G1, coreFetch: fakeCore, fetch: gh.fetch, apiBase: gh.api, gitBase: gh.root });
  removed = false;
  expect(v.ok).toBe(true);
  expect(v.removed).toEqual({ reason: "test data, repository deleted 2026-10-11", repo: "units-agents/deep", former_commit: "e".repeat(40) });
  expect(v.checks).toEqual([{ name: "published", ok: null, detail: expect.stringContaining("removed: test data, repository deleted 2026-10-11") }]);
});
