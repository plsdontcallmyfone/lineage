import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey } from "@lineage/protocol";
import { canonicalizeDiff, patchHash } from "../../protocol/src/diff.ts";
import { verifyGeneration } from "../../mirror/src/verify.ts";
import { keypair, MockGitHub } from "../../mirror/test/mockgh.ts";
import { cycleOnce, type GithubRecord } from "../src/cycle.ts";
import { publisherPublic, setPublisher } from "../src/publisher.ts";
import { IdentityService } from "../src/service.ts";
import { EncryptedStore, ensureKeyFile } from "../src/store.ts";

// Generations on GitHub (docs/plans/GENERATIONS-ON-GITHUB.md): the identity cycle records every
// accepted generation in Core (its Verified commit, or awaiting a publisher for app-identity agents),
// a publisher account then publishes the queued ones, and verify-generation checks each commit
// against Core: trailers, diff, parent, signature. GitHub is mocked (real SSH signatures, local bare
// repositories); Core is a fake that keeps the records the cycle sends.

const tmp = mkdtempSync(join(tmpdir(), "lineage-gen-gh-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const H = (c: string) => c.repeat(64);
const LIN = H("a");
const LIN2 = H("b");
const G0 = H("0");
const G1 = H("1");
const G2 = H("2");
const G5 = H("5");
const A = generateAgentKey().id; // own account
const B = generateAgentKey().id; // app identity

const LIB = ["def a():", "    return slow_a()", "", "def b():", "    return slow_b()", "", "def c():", "    return 3", ""].join("\n");
// one line of context: git re-diffs with three, so the verifier falls back to the tree comparison
const P1 = "diff --git a/src/lib.py b/src/lib.py\n--- a/src/lib.py\n+++ b/src/lib.py\n@@ -1,3 +1,3 @@\n def a():\n-    return slow_a()\n+    return fast_a()\n \n";
const P2 = "diff --git a/src/lib.py b/src/lib.py\n--- a/src/lib.py\n+++ b/src/lib.py\n@@ -3,4 +3,4 @@\n \n def b():\n-    return slow_b()\n+    return fast_b()\n \n";
const P5 = "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-fx\n+fx, faster\n";
const ph = (p: string) => patchHash(canonicalizeDiff(p));

const gh = new MockGitHub(join(tmp, "host"));
const base = gh.createRepo("up/fx", { "src/lib.py": LIB, "README.md": "fx\n" });
const records = new Map<string, any>(); // what the fake Core recorded
const posts: GithubRecord[][] = [];

function gen(id: string, lineage: string, height: number, parent: string, author: string, patch: string) {
  return {
    gen_id: id, lineage_id: lineage, parent_gen_id: parent, height, entry_type: "patch", candidate_id: H(String(height + 6)), patch_hash: ph(patch), patch,
    kind: "perf", target: "ir", effect: { metric: "ir", ratio: 0.9, ci_low: 0.9, ci_high: 0.9 }, verdict_digest: H("d"), replay_ids: [H("8")],
    author, team: null, accepted_at: Date.UTC(2026, 9, 8, 10, height), epoch: 1, reverts: null, reverted_by: null,
  };
}
const gens = [gen(G1, LIN, 1, G0, A, P1), gen(G2, LIN, 2, G1, B, P2), gen(G5, LIN2, 1, G0, B, P5)];
const genesis = (lin: string) => ({ gen_id: G0, parent_gen_id: null, height: 0, entry_type: "genesis", candidate_id: null, author: null, accepted_at: 0, reverts: null, lineage_id: lin });
function lineage(id: string) {
  const gs = gens.filter((g) => g.lineage_id === id);
  return { lineage_id: id, repo: "https://github.com/up/fx", snapshot: { commit_sha: base }, recipe: { name: id === LIN ? "fx" : "fxdoc" }, status: "active", tip: gs[gs.length - 1]!.gen_id, height: gs.length, generations: [genesis(id), ...gs] };
}
let tamper: string | null = null;
const coreFetch = async (url: string): Promise<Response> => {
  const u = new URL(url);
  const p = u.pathname;
  const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s });
  if (p === "/v1/lineages") return json([LIN, LIN2].map((id) => ({ lineage_id: id, repo: "https://github.com/up/fx", recipe_name: lineage(id).recipe.name, status: "active", height: lineage(id).height, tip: lineage(id).tip })));
  const l = /^\/v1\/lineages\/([0-9a-f]{64})$/.exec(p);
  if (l) return json(lineage(l[1]!));
  const g = /^\/v1\/generations\/([0-9a-f]{64})$/.exec(p);
  if (g) {
    if (g[1] === G0) return json({ ...genesis(LIN), github: null });
    const v = gens.find((x) => x.gen_id === g[1]);
    if (!v) return json({ error: "not_found" }, 404);
    const r = records.get(v.gen_id);
    const github = !r ? { status: "pending" } : r.status ? { status: r.status } : { url: `https://github.com/${r.repo}/commit/${r.sha}`, commit: r.sha, repo: r.repo, branch: r.branch, verified: true, published_at: 1 };
    return json({ ...v, patch_hash: tamper === v.gen_id ? H("e") : v.patch_hash, github });
  }
  if (/\/soul$/.test(p)) return json({ error: "not_found" }, 404);
  return json({ error: "not_found" }, 404);
};
const postCore = async (_path: string, body: any) => {
  posts.push(body.records);
  for (const r of body.records) if (!(r.status && records.get(r.gen_id)?.sha)) records.set(r.gen_id, r);
  return { status: 200, body: { results: body.records.map((r: any) => ({ gen_id: r.gen_id, result: "recorded", detail: null })) } };
};

function service() {
  const d = join(tmp, "svc");
  const key = join(d, "key", "master.key");
  ensureKeyFile(key);
  const store = new EncryptedStore(join(d, "data"), key);
  const svc = new IdentityService({
    store, runDir: join(d, "run"), site: "https://site.mock", since: 0, apiBase: gh.api, fetch: gh.fetch,
    chain: { launches: async () => [], agentLaunch: async () => null, agent: async () => null }, soul: async () => null,
  });
  const k = keypair(tmp, "agent-a");
  gh.users.push({ login: "quillbot", id: 4242, token: "tok-a", signingKey: k.publicKey });
  svc.creds.put({ v: 1, agent: A, login: "quillbot", github_id: 4242, token: "tok-a", ssh_private_key_path: k.privatePath, ssh_public_key: k.publicKey, ssh_signing_key_id: 1, assigned_at: "2026-10-10T00:00:00Z" });
  return svc;
}

const svc = service();
const cycle = () => cycleOnce({ log: process.env.DBG ? (m: string) => console.log(m) : undefined, svc, core: "http://core.mock", site: "https://site.mock", apiBase: gh.api, gitBase: gh.root, fetch: gh.fetch, postCore, coreFetch });
const verify = (genId: string) => verifyGeneration({ core: "http://core.mock", genId, coreFetch, fetch: gh.fetch, apiBase: gh.api, gitBase: gh.root });

describe("generations on GitHub", () => {
  test("without a publisher: the account generation is published and recorded, app generations await a publisher", async () => {
    {
      const s = await cycle();
      expect(s.error).toBeNull();
      expect(s.publisher).toBeNull();
      expect(s.recorded).toBe(1);
      expect(s.awaiting).toBe(2);
      expect(records.get(G1)).toMatchObject({ repo: "quillbot/fx", identity: "account", login: "quillbot" });
      expect(records.get(G2)).toEqual({ gen_id: G2, status: "awaiting publisher" });
      expect(records.get(G5)).toEqual({ gen_id: G5, status: "awaiting publisher" });
      // the app-only lineage was not built (no fork for it, nothing pushed)
      expect(s.lineages.map((l) => l.lineage_id)).toEqual([LIN]);
      const msg = (await (await gh.fetch(`${gh.api}/repos/quillbot/fx/commits/${records.get(G1).sha}`)).json()).commit.message as string;
      for (const t of [`Lineage-Generation: ${G1}`, `Lineage-Lineage: ${LIN}`, "Lineage-Height: 1", `Lineage-Patch-Sha256: ${ph(P1)}`, `Lineage-Verdict: ${H("d")}`, `Lineage-Agent: ${A}`, `Lineage-Url: https://site.mock/generations/${G1}`]) expect(msg).toContain(t);

      // verify-generation: every check passes for the account generation (tree fallback: P1 has one line of context)
      const v = await verify(G1);
      expect(v.checks.map((c) => [c.name, c.ok])).toEqual([["published", true], ["trailers", true], ["parent", true], ["diff", true], ["signature", true]]);
      expect(v.checks.find((c) => c.name === "diff")!.detail).toContain("same tree");
      expect(v.ok).toBe(true);
      // the awaiting one has nothing to verify yet
      const w = await verify(G2);
      expect(w.ok).toBe(false);
      expect(w.checks[0]!.detail).toContain("awaiting publisher");
      // a Core whose patch_hash differs from the commit's trailer fails
      tamper = G1;
      const t = await verify(G1);
      tamper = null;
      expect(t.ok).toBe(false);
      expect(t.checks.find((c) => c.name === "trailers")!.ok).toBe(false);

      // unchanged lineages are not rebuilt or re-sent
      const n = posts.length;
      const again = await cycle();
      expect(again.skipped_unchanged).toBe(2);
      expect(posts.length).toBe(n);
    }
  }, 60_000);

  test("the publisher may not be a reserved or agent account; once set, queued generations are published Verified", async () => {
    {
      gh.users.push({ login: "ds56vmr2", id: 5600, token: "tok-reserved", signingKey: "" }, { login: "lineagepub", id: 7700, token: "tok-pub", signingKey: "" });
      await expect(setPublisher(svc, "tok-reserved")).rejects.toThrow("may not be the publisher");
      await expect(setPublisher(svc, "tok-a")).rejects.toThrow("may not be the publisher");
      const p = await setPublisher(svc, "tok-pub");
      expect(p).toMatchObject({ configured: true, login: "lineagepub" });
      expect(JSON.stringify(publisherPublic(svc))).not.toContain("tok-pub");
      expect(gh.users.find((u) => u.login === "lineagepub")!.signingKey).toStartWith("ssh-ed25519 ");

      const s = await cycle();
      expect(s.error).toBeNull();
      expect(s.publisher).toBe("lineagepub");
      expect(s.awaiting).toBe(0);
      expect(records.get(G2)).toMatchObject({ repo: "lineagepub/fx", identity: "app", login: "lineagepub" });
      expect(records.get(G5)).toMatchObject({ repo: "lineagepub/fx", identity: "app" });
      // the account generation keeps its commit (the chain is deterministic); G2's parent is G1's commit
      for (const id of [G1, G2, G5]) {
        const v = await verify(id);
        expect([id, v.ok, v.checks.filter((c) => c.ok !== true).map((c) => `${c.name}: ${c.detail}`)]).toEqual([id, true, []]);
      }
      const v2 = await verify(G2);
      expect(v2.checks.find((c) => c.name === "parent")!.detail).toContain("generation 1's recorded commit");
      expect(v2.checks.find((c) => c.name === "diff")!.detail).toContain("same tree");
      // a patch whose hunks are what git emits: the diff itself has Core's patch_hash
      expect((await verify(G5)).checks.find((c) => c.name === "diff")!.detail).toContain("Core's patch_hash");
    }
  }, 60_000);
});
