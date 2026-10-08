import { afterEach, describe, expect, test } from "bun:test";
import { calibCommitment, checkProposedRecipe, mergeCalibrations, overlayDigestOf } from "../src/recipe-proposals.ts";
import { recipeId, sha256Hex, type Calibration, type Recipe } from "../src/protocol.ts";
import { CAPS, expectOk, makeAuthor, makeVerifier, qualifyResult, type Agent, type Env } from "./helpers.ts";
import { IMG, R2, w6env } from "./w6.ts";

// Agent-proposed recipes (SPEC 6.2): a proposal becomes a lineage only after calibration replays
// by verifiers qualified for its class agree.

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

const BENCH = new TextEncoder().encode("print('bench')\n");
const EQUIV = new TextEncoder().encode("print('equiv')\n");
const OVERLAY = { "lineage_bench.py": sha256Hex(BENCH), "lineage_equiv.py": sha256Hex(EQUIV) };

function proposed(over: Partial<Recipe> = {}): Recipe {
  const r: Recipe = {
    ...R2,
    name: "fy",
    repo: "https://github.com/example/fy",
    commit: "fedcba9876543210fedcba9876543210fedcba98",
    patch: { ...R2.patch, protected_paths: ["lineage_bench.py", "lineage_equiv.py", "tests/**"].sort() },
    overlay_digest: overlayDigestOf(OVERLAY),
    ...over,
  };
  return r;
}

function calib(r: Recipe, seed: string, over: Partial<Calibration> = {}): Calibration {
  return {
    recipe_id: recipeId(r),
    snapshot_id: "",
    runs: 3,
    stable: ["a", "b"],
    known_failures: [],
    quarantined: [],
    metrics: { ir: { enabled: true, cv: 0, base_value: 5000 }, ns: { enabled: true, cv: 0.01, base_value: 10 }, size: { enabled: true, cv: 0, base_value: 99 } },
    median_eval_seconds: 12,
    seed,
    ...over,
  };
}

async function upload(a: Agent) {
  await expectOk(a.c.putBlob(OVERLAY["lineage_bench.py"], BENCH));
  await expectOk(a.c.putBlob(OVERLAY["lineage_equiv.py"], EQUIV));
}

async function propose(e: Env, a: Agent, r = proposed()) {
  await upload(a);
  return a.c.post("/v1/recipe-proposals", { recipe: r, recipe_id: recipeId(r), overlay: OVERLAY, note: "seeded encode workload" });
}

async function drawn(e: Env) {
  const out: { v: Agent; a: any }[] = [];
  for (const v of e.verifiers) for (const a of await expectOk<any[]>(v.c.get("/v1/recipe-proposals/assignments", true))) out.push({ v, a });
  return out;
}

async function runAll(e: Env, make: (i: number, a: any) => { calibration: Calibration; deps_digest: string }) {
  const ds = await drawn(e);
  const made = ds.map((d, i) => ({ ...d, res: make(i, d.a), salt: `s${i}` }));
  for (const m of made) await expectOk(m.v.c.post(`/v1/recipe-proposals/replays/${m.a.replay_id}/commit`, { commitment: calibCommitment(m.res, m.salt) }));
  const outs = [];
  for (const m of made) outs.push(await expectOk(m.v.c.post(`/v1/recipe-proposals/replays/${m.a.replay_id}/reveal`, { ...m.res, salt: m.salt })));
  return { ds, outs };
}

describe("agent-proposed recipes (SPEC 6.2)", () => {
  test("pure: structural checks and calibration agreement", () => {
    expect(() => checkProposedRecipe(proposed())).not.toThrow();
    expect(() => checkProposedRecipe(proposed({ commit: "abc" }))).toThrow();
    expect(() => checkProposedRecipe(proposed({ limits: { ...R2.limits, cpus: 64 } }))).toThrow();
    expect(() => checkProposedRecipe(proposed({ metrics: [R2.metrics[1]!] }))).toThrow(); // no deterministic metric
    const r = proposed();
    const id = recipeId(r);
    const s = "7".repeat(64);
    const a = { replayer: "a", deps_digest: "d", calibration: calib(r, s) };
    const b = { replayer: "b", deps_digest: "d", calibration: calib(r, s, { metrics: { ...calib(r, s).metrics, ir: { enabled: true, cv: 0, base_value: 5003 }, ns: { enabled: false, cv: 0.2, base_value: 11 } } }) };
    const m = mergeCalibrations(r, id, s, [a, b], 0.001);
    expect(m.ok).toBe(true);
    if (m.ok) {
      expect(m.calibration.metrics.ir!.enabled).toBe(true);
      expect(m.calibration.metrics.ns!.enabled).toBe(false); // a noise split disables the noisy metric
      expect(m.calibration.runs).toBe(6);
    }
    expect(mergeCalibrations(r, id, s, [a, { ...b, calibration: calib(r, s, { stable: ["a"] }) }], 0.001)).toMatchObject({ ok: false, reason: "stable test sets differ" });
    expect(mergeCalibrations(r, id, s, [a, { ...b, deps_digest: "e" }], 0.001)).toMatchObject({ ok: false });
    expect(mergeCalibrations(r, id, s, [a, { ...b, calibration: calib(r, s, { metrics: { ...calib(r, s).metrics, ir: { enabled: true, cv: 0, base_value: 6000 } } }) }], 0.001)).toMatchObject({ ok: false });
  });

  test("calibration replays by class-qualified verifiers agree: the recipe becomes an active lineage", async () => {
    const e = (env = await w6env(4));
    const proposer = await makeAuthor(e, { repo: "https://github.com/example/fy" });
    const p = await expectOk(propose(e, proposer));
    expect(p.status).toBe("calibrating");
    const { ds, outs } = await runAll(e, (_i, a) => {
      expect(a.recipe_id).toBe(recipeId(proposed()));
      expect(a.overlay).toEqual(OVERLAY);
      return { calibration: calib(proposed(), a.seed), deps_digest: "d".repeat(64) };
    });
    expect(ds).toHaveLength(2);
    expect(new Set(ds.map((d) => d.a.seed)).size).toBe(1); // one shared seed
    expect(outs.at(-1).proposal).toBe("accepted");
    const view = await expectOk(e.anon.get(`/v1/recipe-proposals/${p.proposal_id}`));
    expect(view.status).toBe("accepted");
    const l = await expectOk(e.anon.get(`/v1/lineages/${view.lineage_id}`));
    expect(l.status).toBe("active");
    expect(l.recipe_id).toBe(recipeId(proposed()));
    expect(l.calibration.stable).toEqual(["a", "b"]);
    expect(l.calibration.runs).toBe(6);
    // the launched agent targeting the repository becomes active, and verifiers get qualifications for the new lineage
    expect((await expectOk(e.anon.get(`/v1/agents/${proposer.id}`))).lifecycle).toBe("active");
    await expectOk(e.admin.c.post("/v1/admin/tick"));
    const q = (await expectOk<any[]>(e.verifiers[0]!.c.get("/v1/assignments", true))).filter((x) => x.kind === "qualify");
    expect(q.map((x) => x.lineage.lineage_id)).toContain(view.lineage_id);
  });

  test("disagreeing calibrations reject the proposal and create nothing", async () => {
    const e = (env = await w6env(3));
    const proposer = e.verifiers[0]!;
    const p = await expectOk(propose(e, proposer));
    const { ds } = await runAll(e, (i, a) => ({ calibration: calib(proposed(), a.seed, { stable: i ? ["a"] : ["a", "b"] }), deps_digest: "d".repeat(64) }));
    expect(ds.map((d) => d.v.id)).not.toContain(proposer.id); // the proposer never calibrates its own recipe
    const view = await expectOk(e.anon.get(`/v1/recipe-proposals/${p.proposal_id}`));
    expect(view.status).toBe("rejected");
    expect(view.reason).toBe("stable test sets differ");
    expect((await expectOk<any[]>(e.anon.get("/v1/lineages"))).length).toBe(1);
  });

  test("submission rules: vetted image, overlay digest and protection, uniqueness; waits for enough qualified verifiers; reveal opens after every commit", async () => {
    const e = (env = await w6env(1));
    const a = e.verifiers[0]!;
    expect((await propose(e, a, proposed({ image: `lineage/other@sha256:${"b".repeat(64)}` }))).body.error).toBe("unvetted_image");
    expect((await propose(e, a, proposed({ overlay_digest: "0".repeat(64) }))).body.error).toBe("overlay_mismatch");
    expect((await propose(e, a, proposed({ patch: { ...R2.patch, protected_paths: ["tests/**"] } }))).body.error).toBe("overlay_unprotected");
    expect((await a.c.post("/v1/recipe-proposals", { recipe: proposed(), overlay: { "lineage_bench.py": "c".repeat(64) } })).body.error).toBe("missing_blob");
    expect((await propose(e, a, proposed({ name: R2.name }))).body.error).toBe("name_taken");
    // one other qualified verifier: not enough for two calibration replays, so it waits
    const p = await expectOk(propose(e, a));
    expect(p.status).toBe("waiting");
    expect((await propose(e, a)).body.error).toBe("proposal_exists");
    // a verifier with capabilities but no passed qualification does not count
    await makeVerifier(e, { qualify: false });
    expect((await expectOk(e.anon.get(`/v1/recipe-proposals/${p.proposal_id}`))).status).toBe("waiting");
    const v2 = await makeVerifier(e);
    const v3 = await makeVerifier(e);
    e.verifiers.push(v2, v3);
    expect((await expectOk(e.anon.get(`/v1/recipe-proposals/${p.proposal_id}`))).status).toBe("waiting");
    await expectOk(e.anon.get("/v1/recipe-proposals")); // listing fills
    const ds = await drawn(e);
    expect(ds).toHaveLength(2);
    const res = { calibration: calib(proposed(), ds[0]!.a.seed), deps_digest: "d".repeat(64) };
    await expectOk(ds[0]!.v.c.post(`/v1/recipe-proposals/replays/${ds[0]!.a.replay_id}/commit`, { commitment: calibCommitment(res, "x") }));
    expect((await ds[0]!.v.c.post(`/v1/recipe-proposals/replays/${ds[0]!.a.replay_id}/reveal`, { ...res, salt: "x" })).body.error).toBe("reveal_not_open");
    expect(IMG).toContain("sha256");
    expect(qualifyResult().build.base).toBe("ok");
    expect(CAPS.arch).toBe("arm64");
  });
});
