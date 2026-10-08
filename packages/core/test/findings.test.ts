import { afterEach, describe, expect, test } from "bun:test";
import { findingsOf, hotspotTarget, judgeReproduction, patchFiles, profileCommitment, profileTool, type Profile } from "../src/findings.ts";
import { sha256Hex } from "../src/protocol.ts";
import { RECIPE, candidate, diff, expectOk, makeAuthor, result, runReplays, submit, type Agent, type Env } from "./helpers.ts";
import { R2, w6env } from "./w6.ts";

// Hotspot findings (SPEC 12.8): filed from a profile, counted only after another qualified worker
// reproduces the numbers, resolved by an accepted perf generation that changes the hotspot's file.

const PROFILE: Profile = {
  total: 1_000_000,
  functions: [
    { fn: "fx::encode::encode_into", file: null, self: 700_000 },
    { fn: "alloc::raw_vec::finish_grow", file: null, self: 200_000 },
    { fn: "memcpy", file: "string/memcpy.S", self: 100_000 },
  ],
};

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

async function fileClaim(e: Env, finder: Agent, over: Record<string, unknown> = {}) {
  const tip = (await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`))).tip;
  return finder.c.post("/v1/findings/hotspots", {
    lineage_id: e.lineage,
    tip,
    metric: "ir",
    tool: "callgrind",
    seed: "0123456789abcdef",
    target: { function: "fx::encode::encode_into", file: "src/encode.rs" },
    profile: PROFILE,
    note: "the per-digit loop dominates",
    ...over,
  });
}

async function reproduce(e: Env, got: Profile) {
  for (const v of e.verifiers) {
    for (const a of await expectOk<any[]>(v.c.get("/v1/findings/assignments", true))) {
      const salt = "5a17";
      await expectOk(v.c.post(`/v1/findings/replays/${a.replay_id}/commit`, { commitment: profileCommitment(got, salt) }));
      return expectOk(v.c.post(`/v1/findings/replays/${a.replay_id}/reveal`, { result: got, salt }));
    }
  }
  throw new Error("nobody was assigned");
}

describe("hotspot findings (SPEC 12.8)", () => {
  test("pure helpers: profile tool, reproduction verdict, target text, patch files", () => {
    expect(profileTool(R2, "ir")).toBe("callgrind");
    expect(profileTool(R2, "ns")).toBeNull(); // noisy
    expect(profileTool(RECIPE, "ir")).toBeNull(); // not a valgrind metric
    expect(profileTool({ ...R2, class: "solana", metrics: [{ ...R2.metrics[0]!, command: "harness cu", parser: "number" }] }, "ir")).toBe("cu");
    const claim = { function: "fx::encode::encode_into", file: "src/encode.rs", profile: PROFILE };
    expect(judgeReproduction(claim, PROFILE, 0.001).ok).toBe(true);
    const drift = { ...PROFILE, functions: [{ ...PROFILE.functions[0]!, self: 700_300 }, ...PROFILE.functions.slice(1)], total: 1_000_300 };
    expect(judgeReproduction(claim, drift, 0.001).ok).toBe(true); // within det_tolerance
    const off = { ...PROFILE, functions: [{ ...PROFILE.functions[0]!, self: 600_000 }, ...PROFILE.functions.slice(1)] };
    expect(judgeReproduction(claim, off, 0.001)).toMatchObject({ ok: false });
    expect(judgeReproduction(claim, { total: 1_000_000, functions: [PROFILE.functions[1]!] }, 0.001).reason).toContain("does not list");
    expect(hotspotTarget("ir", "callgrind", "f", "/work/src/src/a.rs", 250, 1000)).toBe("ir: f in src/a.rs (25.0% of self Ir, 250 of 1000)");
    expect(patchFiles(diff("x", "src/encode.rs"))).toEqual(["src/encode.rs"]);
  });

  test("a claim is drawn to another qualified verifier, sealed until decided, and becomes a finding when reproduced", async () => {
    const e = (env = await w6env());
    const finder = e.verifiers[0]!;
    const claim = await expectOk(fileClaim(e, finder));
    expect(claim.status).toBe("reproducing");
    // the finder is never its own replayer; exactly one replay (SPEC 12)
    expect(await expectOk<any[]>(finder.c.get("/v1/findings/assignments", true))).toEqual([]);
    const asg = (await Promise.all(e.verifiers.slice(1).map((v) => expectOk<any[]>(v.c.get("/v1/findings/assignments", true))))).flat();
    expect(asg).toHaveLength(1);
    // the assignment names metric, tip and seed, never the claimed function or numbers
    expect(asg[0]).toMatchObject({ kind: "profile", metric: "ir", tool: "callgrind", seed: "0123456789abcdef", tip: e.gen0 });
    expect(JSON.stringify(asg[0])).not.toContain("encode_into");
    const pub = await expectOk(e.anon.get(`/v1/findings/hotspots/${claim.claim_id}`));
    expect(pub.profile).toBeNull();
    expect(pub.replays[0].replayer).toBeNull();
    // no finding yet
    expect((await expectOk<any[]>(e.anon.get(`/v1/findings?lineage=${e.lineage}`))).some((f) => f.kind === "hotspot")).toBe(false);

    const r = await reproduce(e, PROFILE);
    expect(r.claim).toBe("verified");
    const done = await expectOk(e.anon.get(`/v1/findings/hotspots/${claim.claim_id}`));
    expect(done.status).toBe("verified");
    expect(done.profile).toEqual(PROFILE);
    const f = (await expectOk<any[]>(e.anon.get(`/v1/findings?lineage=${e.lineage}`))).find((x) => x.kind === "hotspot");
    expect(f).toMatchObject({ finder: finder.id, finding_id: done.finding_id, target: "ir: fx::encode::encode_into in src/encode.rs (70.0% of self Ir, 700000 of 1000000)" });
  });

  test("a profile that does not reproduce fails the claim and files nothing", async () => {
    const e = (env = await w6env());
    const claim = await expectOk(fileClaim(e, e.verifiers[0]!));
    const r = await reproduce(e, { ...PROFILE, functions: [{ ...PROFILE.functions[0]!, self: 650_000 }, ...PROFILE.functions.slice(1)] });
    expect(r.claim).toBe("failed");
    const v = await expectOk(e.anon.get(`/v1/findings/hotspots/${claim.claim_id}`));
    expect(v.reason).toContain("self cost");
    expect((await expectOk<any[]>(e.anon.get(`/v1/findings?lineage=${e.lineage}`))).some((f) => f.kind === "hotspot")).toBe(false);
  });

  test("validation: patchable file, hotspot share, current tip, deterministic profiled metric, commitment", async () => {
    const e = (env = await w6env());
    const fin = e.verifiers[0]!;
    expect((await fileClaim(e, fin, { target: { function: "fx::encode::encode_into", file: "tests/t.rs" } })).body.error).toBe("bad_target");
    expect((await fileClaim(e, fin, { target: { function: "nope", file: "src/a.rs" } })).body.error).toBe("bad_target");
    const tiny = { total: 1_000_000, functions: [{ fn: "fx::tiny", file: null, self: 5_000 }] };
    expect((await fileClaim(e, fin, { target: { function: "fx::tiny", file: "src/a.rs" }, profile: tiny })).body.error).toBe("not_a_hotspot");
    expect((await fileClaim(e, fin, { tip: "f".repeat(64) })).body.error).toBe("stale_tip");
    expect((await fileClaim(e, fin, { metric: "ns", tool: "callgrind" })).body.error).toBe("bad_metric");
    expect((await fileClaim(e, fin, { tool: "cu" })).body.error).toBe("bad_tool");
    const ok = await expectOk(fileClaim(e, fin));
    expect((await fileClaim(e, fin)).body.error).toBe("claim_exists");
    const all = (await Promise.all(e.verifiers.map(async (x) => ({ x, a: await expectOk<any[]>(x.c.get("/v1/findings/assignments", true)) })))).find((y) => y.a.length)!;
    await expectOk(all.x.c.post(`/v1/findings/replays/${all.a[0].replay_id}/commit`, { commitment: profileCommitment(PROFILE, "s1") }));
    expect((await all.x.c.post(`/v1/findings/replays/${all.a[0].replay_id}/reveal`, { result: PROFILE, salt: "s2" })).body.error).toBe("commitment_mismatch");
    const v = e.verifiers.find((x) => x.id !== all.x.id)!;
    expect((await v.c.post(`/v1/findings/replays/${all.a[0].replay_id}/reveal`, { result: PROFILE, salt: "s1" })).status).toBeGreaterThanOrEqual(403);
    expect(ok.claim_id).toBeDefined();
  });

  test("a missed window is redrawn to another verifier", async () => {
    const e = (env = await w6env());
    const claim = await expectOk(fileClaim(e, e.verifiers[0]!));
    const first = (await Promise.all(e.verifiers.map(async (x) => ({ x, a: await expectOk<any[]>(x.c.get("/v1/findings/assignments", true)) })))).find((y) => y.a.length)!;
    e.clock.advance(3 * 3600 * 1000);
    const again = (await Promise.all(e.verifiers.map(async (x) => ({ x, a: await expectOk<any[]>(x.c.get("/v1/findings/assignments", true)) })))).find((y) => y.a.length);
    expect(again).toBeDefined();
    expect(again!.x.id).not.toBe(first.x.id);
    expect(again!.x.id).not.toBe(e.verifiers[0]!.id);
    const v = await expectOk(e.anon.get(`/v1/findings/hotspots/${claim.claim_id}`));
    expect(v.replays.map((r: any) => r.status).sort()).toEqual(["assigned", "expired"]);
  });

  test("an accepted perf generation that changes the hotspot's file resolves it and credits the finder", async () => {
    const e = (env = await w6env(4));
    const finder = e.verifiers[0]!;
    const claim = await expectOk(fileClaim(e, finder));
    await reproduce(e, PROFILE);
    const author = await makeAuthor(e);
    // a patch elsewhere does not resolve it
    const other = await submit(e, author, diff("o", "src/other.rs"));
    await runReplays(e, other.candidate_id, () => result({}, 900));
    expect((await candidate(e, other.candidate_id)).status).toBe("accepted");
    expect((await expectOk(e.anon.get(`/v1/findings/hotspots/${claim.claim_id}`))).status).toBe("verified");
    const c = await submit(e, author, diff("h", "src/encode.rs"));
    await runReplays(e, c.candidate_id, () => result({}, 900));
    const v = await candidate(e, c.candidate_id);
    expect(v.status).toBe("accepted");
    const cl = await expectOk(e.anon.get(`/v1/findings/hotspots/${claim.claim_id}`));
    expect(cl.status).toBe("resolved");
    expect(cl.resolved_by).toBe(v.gen_id);
    const resolved = await expectOk<any[]>(e.anon.get(`/v1/findings?lineage=${e.lineage}&status=resolved`));
    expect(resolved.find((f) => f.finding_id === cl.finding_id)?.resolved_by).toBe(v.gen_id);
    const units = e.core.db.query<{ amount: number }, [string, string]>("SELECT * FROM units WHERE agent_id = ? AND kind = 'finder' AND ref = ?").all(finder.id, v.gen_id);
    expect(units).toHaveLength(1);
    expect(findingsOf(e.core).list(e.lineage).length).toBe(1);
    expect(sha256Hex("x")).toHaveLength(64);
  });
});
