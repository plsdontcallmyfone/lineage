import { afterEach, describe, expect, test } from "bun:test";
import { genGithubOf, trailersOf } from "../src/gen-github.ts";
import { diff, expectOk, honest, makeAuthor, result, runReplays, setup, submit, type Env } from "./helpers.ts";

// Generations on GitHub (docs/plans/GENERATIONS-ON-GITHUB.md 3): Core records a generation's mirror
// commit only after reading it from (a fake) GitHub: trailers must name the generation and its
// patch_hash, and GitHub's own signature verification is what Core stores.

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);

function fakeGithub(commits: Record<string, { message: string; verified: boolean; reason?: string }>, status = 200) {
  const calls: string[] = [];
  const fn = async (url: string): Promise<Response> => {
    const p = new URL(url).pathname;
    calls.push(p);
    if (status !== 200) return new Response(JSON.stringify({ message: "rate limited" }), { status });
    const m = /^\/repos\/([^/]+\/[^/]+)\/commits\/([0-9a-f]{40})$/.exec(p);
    const c = m ? commits[`${m[1]}@${m[2]}`] : undefined;
    if (!c) return new Response(JSON.stringify({ message: "No commit found" }), { status: 422 });
    return new Response(JSON.stringify({ sha: m![2], html_url: `https://github.com/${m![1]}/commit/${m![2]}`, commit: { message: c.message, verification: { verified: c.verified, reason: c.reason ?? (c.verified ? "valid" : "unsigned") } } }));
  };
  return { fn, calls };
}

const msg = (g: any, over: Record<string, string> = {}) => {
  const t: Record<string, string> = { "Lineage-Generation": g.gen_id, "Lineage-Lineage": g.lineage_id, "Lineage-Height": String(g.height), "Lineage-Patch-Sha256": g.patch_hash, "Lineage-Verdict": g.verdict_digest, "Lineage-Agent": g.author, ...over };
  return `perf ir on fx: ir ratio 0.8889 (lineage gen 1)\n\nbody\n\n${Object.entries(t).map(([k, v]) => `${k}: ${v}`).join("\n")}\n`;
};

describe("generations on GitHub: Core record", () => {
  test("trailer parsing reads the last paragraph only", () => {
    expect(trailersOf("t\n\nLineage-Generation: x in body\n\nLineage-Generation: abc\nLineage-Height: 2\n")).toEqual({ "Lineage-Generation": "abc", "Lineage-Height": "2" });
  });

  test("pending, awaiting publisher, refused on wrong trailers, recorded with GitHub's verification, listed per agent", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("a"));
    await runReplays(e, c.candidate_id, honest(result({}, 800)));
    const genId = (await expectOk(e.anon.get(`/v1/candidates/${c.candidate_id}`))).gen_id as string;
    const g = await expectOk(e.anon.get(`/v1/generations/${genId}`));
    expect(g.github).toEqual({ status: "pending" });
    expect((await expectOk(e.anon.get(`/v1/generations/${e.gen0}`))).github).toBeNull();

    const commits: Record<string, { message: string; verified: boolean }> = {
      [`bot/fx@${SHA}`]: { message: msg(g, { "Lineage-Patch-Sha256": "f".repeat(64) }), verified: true },
      [`bot/fx@${SHA2}`]: { message: msg(g), verified: true },
    };
    const fake = fakeGithub(commits);
    genGithubOf(e.core).configure({ fetch: fake.fn, githubApi: "http://gh.fake" });

    // only the runtime or admin key records
    expect((await author.c.post("/v1/github/generations", { records: [{ gen_id: genId, status: "awaiting publisher" }] })).status).toBe(403);
    const aw = await expectOk(e.admin.c.post("/v1/github/generations", { records: [{ gen_id: genId, status: "awaiting publisher" }] }));
    expect(aw.results[0]).toMatchObject({ result: "recorded", github: { status: "awaiting publisher" } });
    expect((await expectOk(e.anon.get(`/v1/generations/${genId}`))).github).toEqual({ status: "awaiting publisher" });

    // a commit whose patch_hash trailer is not Core's is refused; an unknown commit too
    const bad = await expectOk(e.admin.c.post("/v1/github/generations", { records: [{ gen_id: genId, repo: "bot/fx", branch: "lineage/fx-12345678", sha: SHA, identity: "app" }, { gen_id: genId, repo: "bot/fx", sha: "c".repeat(40) }] }));
    expect(bad.results.map((r: any) => r.result)).toEqual(["refused", "refused"]);
    expect(bad.results[0].detail).toContain("Patch-Sha256");

    const ok = await expectOk(e.admin.c.post("/v1/github/generations", { records: [{ gen_id: genId, repo: "bot/fx", branch: "lineage/fx-12345678", sha: SHA2, identity: "app", login: "bot" }] }));
    expect(ok.results[0].result).toBe("recorded");
    const view = (await expectOk(e.anon.get(`/v1/generations/${genId}`))).github;
    expect(view).toMatchObject({ url: `https://github.com/bot/fx/commit/${SHA2}`, commit: SHA2, verified: true, repo: "bot/fx", branch: "lineage/fx-12345678", identity: "app", login: "bot" });
    expect(typeof view.published_at).toBe("number");

    // a published record is not downgraded to awaiting, and a Verified same sha is not re-read
    const n = fake.calls.length;
    const again = await expectOk(e.admin.c.post("/v1/github/generations", { records: [{ gen_id: genId, repo: "bot/fx", branch: "lineage/fx-12345678", sha: SHA2 }, { gen_id: genId, status: "awaiting publisher" }] }));
    expect(again.results.map((r: any) => r.result)).toEqual(["unchanged", "unchanged"]);
    expect(fake.calls.length).toBe(n);

    const list = await expectOk(e.anon.get(`/v1/github/generations?agent=${author.id}`));
    expect(list.generations).toHaveLength(1);
    expect(list.generations[0]).toMatchObject({ gen_id: genId, recipe: "fx", height: 1, github: { commit: SHA2, verified: true } });
    expect((await e.anon.get("/v1/github/generations")).status).toBe(400);
  });

  test("an unsigned commit is recorded as not verified; a GitHub rate limit asks for a retry", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("a"));
    await runReplays(e, c.candidate_id, honest(result({}, 800)));
    const genId = (await expectOk(e.anon.get(`/v1/candidates/${c.candidate_id}`))).gen_id as string;
    const g = await expectOk(e.anon.get(`/v1/generations/${genId}`));
    genGithubOf(e.core).configure({ fetch: fakeGithub({}, 403).fn, githubApi: "http://gh.fake" });
    const rl = await expectOk(e.admin.c.post("/v1/github/generations", { records: [{ gen_id: genId, repo: "bot/fx", sha: SHA }] }));
    expect(rl.results[0].result).toBe("retry");
    genGithubOf(e.core).configure({ fetch: fakeGithub({ [`bot/fx@${SHA}`]: { message: msg(g), verified: false } }).fn });
    const r = await expectOk(e.admin.c.post("/v1/github/generations", { records: [{ gen_id: genId, repo: "bot/fx", sha: SHA }] }));
    expect(r.results[0]).toMatchObject({ result: "recorded", github: { verified: false, verification_reason: "unsigned" } });
  });
});
