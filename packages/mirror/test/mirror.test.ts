import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_IDENTITY, type CommitIdentity, type Identities } from "../src/chain.ts";
import { CoreReader } from "../src/coreapi.ts";
import { noreplyEmail } from "../src/git.ts";
import { client, deleteBranch } from "../src/github.ts";
import { commitMessage, lineageBranch } from "../src/message.ts";
import { mirrorOnce } from "../src/mirror.ts";
import { keypair, MockGitHub } from "./mockgh.ts";

const H = (c: string) => c.repeat(64);
const LIN = H("a");
const G0 = H("0");
const G1 = H("1");
const G2 = H("2");
const G3 = H("3");
const AGENT_A = "AgentAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // has an account
const AGENT_B = "AgentBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; // no account

const LIB = ["def a():", "    return slow_a()", "", "def b():", "    return slow_b()", "", "def c():", "    return 3", ""].join("\n");
const P1 = "diff --git a/src/lib.py b/src/lib.py\n--- a/src/lib.py\n+++ b/src/lib.py\n@@ -1,3 +1,3 @@\n def a():\n-    return slow_a()\n+    return fast_a()\n \n";
const P2 = "diff --git a/src/lib.py b/src/lib.py\n--- a/src/lib.py\n+++ b/src/lib.py\n@@ -3,4 +3,4 @@\n \n def b():\n-    return slow_b()\n+    return fast_b()\n \n";

let root: string;
let gh: MockGitHub;
let base: string;
let ids: Identities;
let withRevert = false;

function gen(id: string, height: number, o: Partial<any> = {}) {
  return {
    gen_id: id, lineage_id: LIN, parent_gen_id: height ? [G0, G1, G2][height - 1] : null, height, entry_type: "patch", candidate_id: H(String(height + 4)), patch_hash: H("f"), patch: null,
    kind: "perf", target: "ir", effect: { metric: "ir", ratio: 0.9, ci_low: 0.9, ci_high: 0.9 }, verdict_digest: H("d"), replay_ids: [H("8"), H("9")],
    author: AGENT_A, team: null, accepted_at: Date.UTC(2026, 9, 8, 10, height), epoch: 1, reverts: null, reverted_by: null, ...o,
  };
}

function coreViews() {
  const g1 = gen(G1, 1, { patch: P1, reverted_by: withRevert ? G3 : null });
  const g2 = gen(G2, 2, { patch: P2, author: AGENT_B, target: "ir" });
  const g3 = gen(G3, 3, { entry_type: "revert", candidate_id: null, patch: null, kind: null, target: null, effect: null, replay_ids: null, reverts: G1 });
  const gens = withRevert ? [g1, g2, g3] : [g1, g2];
  const tip = gens[gens.length - 1]!.gen_id;
  const lineage = {
    lineage_id: LIN, repo: "https://github.com/up/fx", snapshot: { commit_sha: base }, recipe: { name: "fx" }, status: "active", tip, height: gens.length,
    generations: [{ gen_id: G0, parent_gen_id: null, height: 0, entry_type: "genesis", candidate_id: null, author: null, accepted_at: 0, reverts: null }, ...gens],
  };
  return { gens, lineage, tip };
}

const fakeCore = async (url: string): Promise<Response> => {
  const p = new URL(url).pathname + new URL(url).search;
  const v = coreViews();
  const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s });
  if (p === "/v1/lineages") return json([{ lineage_id: LIN, repo: v.lineage.repo, recipe_name: "fx", status: "active", height: v.lineage.height, tip: v.tip }]);
  if (p === `/v1/lineages/${LIN}`) return json(v.lineage);
  if (p.startsWith(`/v1/lineages/${LIN}/tree?gen=${G3}`)) return json({ lineage_id: LIN, gen_id: G3, repo: v.lineage.repo, commit: base, patches: [{ gen_id: G2, height: 2, patch_hash: H("f"), patch: P2 }] });
  const g = /^\/v1\/generations\/([0-9a-f]{64})$/.exec(p);
  if (g) return json(v.gens.find((x) => x.gen_id === g[1]) ?? { error: "not_found" }, v.gens.some((x) => x.gen_id === g[1]) ? 200 : 404);
  if (p === `/v1/agents/${AGENT_A}/soul`) return json({ versions: [{ seq: 1, digest: H("5"), stored_at: 0 }] });
  if (p === `/v1/souls/${H("5")}`) return json({ doc: { persona: { name: "Quill", tagline: "measures twice" } } });
  return json({ error: "not_found" }, 404);
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "lineage-mirror-test-"));
  gh = new MockGitHub(join(root, "host"));
  base = gh.createRepo("up/fx", { "src/lib.py": LIB, "README.md": "fx\n" });
  const k = keypair(root, "agent-a");
  gh.users.push({ login: "quillbot", id: 4242, token: "tok-a", signingKey: k.publicKey });
  const a: CommitIdentity = { kind: "account", name: "quillbot", email: noreplyEmail(4242, "quillbot"), signingKey: k.privatePath, login: "quillbot", token: "tok-a" };
  ids = { forAgent: (x) => (x === AGENT_A ? a : null), app: () => APP_IDENTITY };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const opts = () => ({ core: new CoreReader("http://core.mock", fakeCore), identities: ids, apiBase: gh.api, gitBase: gh.root, fetch: gh.fetch, site: "https://site.mock", sleep: async () => {} });
const branch = lineageBranch("fx", LIN);
const head = (repo: string) => spawnSync("git", ["rev-parse", `refs/heads/${branch}`], { cwd: gh.bare(repo), encoding: "utf8" }).stdout.trim();
const show = (repo: string, rev: string) => spawnSync("git", ["show", `${rev}`], { cwd: gh.bare(repo), encoding: "utf8" }).stdout;

describe("mirror publisher (W1)", () => {
  test("publishes every accepted generation as one signed commit on the author's fork, fallback recorded", async () => {
    const r = await mirrorOnce(opts());
    expect(r.lineages[0]!.status).toBe("built");
    expect(r.lineages[0]!.pushes).toEqual([expect.objectContaining({ login: "quillbot", fork: "quillbot/fx", branch, action: "pushed" })]);
    const [g1, g2] = r.generations;
    expect(g1).toMatchObject({ gen_id: G1, identity: "account", status: "published", signed: true, verified: true, verification_reason: "valid", fork: "quillbot/fx" });
    expect(g2).toMatchObject({ gen_id: G2, identity: "app", status: "fallback", signed: false });
    expect(g2!.detail).toContain("no GitHub account");
    // the branch is the whole chain: snapshot, then gen 1 (signed by A), then gen 2 (app fallback)
    expect(head("quillbot/fx")).toBe(g2!.sha!);
    const log = spawnSync("git", ["log", "--format=%H %an %G?", `${base}..${branch}`], { cwd: gh.bare("quillbot/fx"), encoding: "utf8" }).stdout.trim().split("\n");
    expect(log.length).toBe(2);
    expect(show("quillbot/fx", g1!.sha!)).toContain("+    return fast_a()");
    const msg = spawnSync("git", ["log", "-1", "--format=%B", g1!.sha!], { cwd: gh.bare("quillbot/fx"), encoding: "utf8" }).stdout;
    expect(msg).toContain(`Lineage-Generation: ${G1}`);
    expect(msg).toContain(`Lineage-Agent: ${AGENT_A}`);
    expect(msg).toContain("Quill: measures twice");
    expect(msg).toContain(`https://site.mock/generations/${G1}`);
    expect(msg).toContain("ratio 0.900000");
    // the mirror never writes anything but forks and pushes
    expect(gh.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`)).toEqual(["POST /repos/up/fx/forks"]);
  });

  test("idempotent: a second cycle pushes nothing and rebuilds the same commits", async () => {
    const before = head("quillbot/fx");
    const r = await mirrorOnce(opts());
    expect(r.lineages[0]!.pushes[0]!.action).toBe("unchanged");
    expect(r.generations.map((g) => g.sha)).toContain(before);
    expect(head("quillbot/fx")).toBe(before);
  });

  test("deleting the branch and rerunning rebuilds it identically", async () => {
    const before = head("quillbot/fx");
    await deleteBranch(client("tok-a", { apiBase: gh.api, fetch: gh.fetch }), "quillbot/fx", branch);
    expect(head("quillbot/fx")).not.toBe(before);
    const r = await mirrorOnce(opts());
    expect(r.lineages[0]!.pushes[0]).toMatchObject({ action: "pushed", detail: "new branch" });
    expect(head("quillbot/fx")).toBe(before);
    expect(r.generations[0]!.verified).toBe(true);
  });

  test("a revert becomes a revert commit whose tree drops only the reverted change", async () => {
    withRevert = true;
    try {
      const r = await mirrorOnce(opts());
      const g3 = r.generations.find((g) => g.gen_id === G3)!;
      expect(g3).toMatchObject({ entry_type: "revert", identity: "account", status: "published", verified: true });
      expect(head("quillbot/fx")).toBe(g3.sha!);
      const lib = spawnSync("git", ["show", `${g3.sha}:src/lib.py`], { cwd: gh.bare("quillbot/fx"), encoding: "utf8" }).stdout;
      expect(lib).toContain("return slow_a()");
      expect(lib).toContain("return fast_b()");
      const msg = spawnSync("git", ["log", "-1", "--format=%B", g3.sha!], { cwd: gh.bare("quillbot/fx"), encoding: "utf8" }).stdout;
      expect(msg).toContain(`Lineage-Reverts: ${G1}`);
      expect(msg.split("\n")[0]).toStartWith("Revert lineage gen 1");
    } finally {
      withRevert = false;
    }
  });

  test("dry run builds the chain and never writes to GitHub", async () => {
    const n = gh.calls.length;
    const r = await mirrorOnce({ ...opts(), dryRun: true });
    expect(r.generations.every((g) => g.status === "dry_run" && g.sha)).toBe(true);
    expect(gh.calls.slice(n).length).toBe(0);
  });

  test("a lineage whose authors have no account publishes nothing and records fallbacks", async () => {
    const noAccounts: Identities = { forAgent: () => null, app: () => APP_IDENTITY };
    const n = gh.calls.length;
    const r = await mirrorOnce({ ...opts(), identities: noAccounts });
    expect(r.lineages[0]!.pushes).toEqual([]);
    expect(r.generations.every((g) => g.status === "fallback" && !g.signed)).toBe(true);
    expect(gh.calls.slice(n).length).toBe(0);
  });

  test("commit messages are a pure function of accepted fields", () => {
    const g = gen(G1, 1, { patch: P1 }) as any;
    const a = commitMessage({ gen: g, lineage_id: LIN, recipe: "fx", site: "https://s", soul: null, identity: "account" });
    expect(commitMessage({ gen: { ...g, reverted_by: H("e"), needs_revalidation: true }, lineage_id: LIN, recipe: "fx", site: "https://s", soul: null, identity: "account" })).toBe(a);
    expect(a).not.toContain("—");
  });
});
