import { afterEach, describe, expect, test } from "bun:test";
import { MORE_UNITS_DEFAULTS, duplicateUnit, headroomError, newTargets, parseMoreUnitsSettings, pathsOverlap } from "../src/more-units.ts";
import { calibCommitment, mergeCalibrations, overlayDigestOf } from "../src/recipe-proposals.ts";
import { recipeId, sha256Hex, type Calibration, type Recipe } from "../src/protocol.ts";
import { DEPS, expectOk, makeAuthor, testConfig, type Agent, type Env } from "./helpers.ts";
import { R2, w6env } from "./w6.ts";

// More units per repository (docs/plans/AGENT-EFFICIENCY.md 8.2): a proposal for a repository that
// already has a unit is refused before any verifier is drawn when it duplicates one or the repository
// is at its limit, and its calibration must show headroom.

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

const VG = "valgrind --tool=cachegrind --cache-sim=no --cachegrind-out-file=/dev/null";
const BENCH = new TextEncoder().encode("print('bench heavy')\n");
const OVERLAY = { "lineage_bench2.py": sha256Hex(BENCH) };
const heavy = (name: string, mode: string, fixed = true): Recipe["metrics"][number] => ({
  name, kind: "perf", direction: "lower", deterministic: true, parser: "cachegrind-ir", min_effect: 0.01,
  command: `${VG} bench2 ${mode} $LINEAGE_SEED`,
  ...(fixed ? { fixed_command: `${VG} bench2 ${mode} $LINEAGE_SEED --inputs-only` } : {}),
});

/** A second unit for R2's repository at R2's commit. */
function second(over: Partial<Recipe> = {}): Recipe {
  return {
    ...R2,
    name: "fx-2",
    metrics: [heavy("encode_long_ir", "encode-long"), heavy("decode_long_ir", "decode-long")],
    patch: { ...R2.patch, protected_paths: ["lineage_bench2.py", "tests/**"] },
    overlay_digest: overlayDigestOf(OVERLAY),
    ...over,
  };
}

const calib = (r: Recipe, seed: string, metrics: Calibration["metrics"]): Calibration => ({ recipe_id: recipeId(r), snapshot_id: "", runs: 3, stable: ["a", "b"], known_failures: [], quarantined: [], metrics, median_eval_seconds: 12, seed });

async function propose(a: Agent, r: Recipe) {
  await expectOk(a.c.putBlob(OVERLAY["lineage_bench2.py"], BENCH));
  return a.c.post("/v1/recipe-proposals", { recipe: r, recipe_id: recipeId(r), overlay: OVERLAY, note: "long inputs" });
}

async function calibrateAll(e: Env, make: (seed: string) => Calibration) {
  const made: { v: Agent; id: string; res: { calibration: Calibration; deps_digest: string } }[] = [];
  for (const v of e.verifiers) for (const a of await expectOk<any[]>(v.c.get("/v1/recipe-proposals/assignments", true))) made.push({ v, id: a.replay_id, res: { calibration: make(a.seed), deps_digest: DEPS } });
  for (const [i, m] of made.entries()) await expectOk(m.v.c.post(`/v1/recipe-proposals/replays/${m.id}/commit`, { commitment: calibCommitment(m.res, `s${i}`) }));
  for (const [i, m] of made.entries()) await expectOk(m.v.c.post(`/v1/recipe-proposals/replays/${m.id}/reveal`, { ...m.res, salt: `s${i}` }));
  return made.length;
}

describe("more units: the pure checks", () => {
  test("paths overlap by literal prefix", () => {
    expect(pathsOverlap(["src/**"], ["src/encode.rs"])).toBe(true);
    expect(pathsOverlap(["minbpe/*.py"], ["minbpe/regex.py"])).toBe(true);
    expect(pathsOverlap(["**/*.py"], ["lib/x.py"])).toBe(true);
    expect(pathsOverlap(["crates/a/**"], ["crates/b/**"])).toBe(false);
    expect(pathsOverlap(["src/codec/**"], ["src/hash/**", "benches/**"])).toBe(false);
  });

  test("a duplicate brings no target the existing unit lacks on the same paths", () => {
    // the same targets on the same paths
    expect(duplicateUnit({ ...R2, name: "fx-2" }, [R2])).toMatchObject({ unit: "fx" });
    // renamed targets with the very same commands are the same targets
    const renamed = { ...R2, name: "fx-2", metrics: R2.metrics.map((m) => ({ ...m, name: `${m.name}_b` })) };
    expect(duplicateUnit(renamed, [R2])?.unit).toBe("fx");
    // a new target with its own workload on the same paths: not a duplicate
    expect(duplicateUnit(second(), [R2])).toBeNull();
    expect(newTargets(second(), R2)).toEqual(["encode_long_ir", "decode_long_ir"]);
    // the same targets on another part of the code: not a duplicate
    expect(duplicateUnit({ ...R2, name: "fx-2", patch: { ...R2.patch, allowed_paths: ["other/**"] } }, [R2])).toBeNull();
    // another repository's unit never counts, nor the draft itself
    expect(duplicateUnit({ ...R2, name: "fx-2", repo: "https://github.com/example/other" }, [R2])).toBeNull();
    expect(duplicateUnit(R2, [R2])).toBeNull();
    expect(duplicateUnit({ ...R2, name: "fx-2" }, [R2])!.why).not.toContain(String.fromCharCode(0x2014));
  });

  test("headroom: every instruction-count metric records a small part that is not the library", () => {
    const r = second();
    const ok = { encode_long_ir: { enabled: true, cv: 0, base_value: 1_000_000, fixed_value: 50_000 }, decode_long_ir: { enabled: true, cv: 0, base_value: 2_000_000, fixed_value: 200_000 } };
    expect(headroomError(r, { metrics: ok }, 0.1)).toBeNull();
    expect(headroomError(r, { metrics: { ...ok, decode_long_ir: { ...ok.decode_long_ir, fixed_value: 200_001 } } }, 0.1)).toContain("metric decode_long_ir: 10.0% of it is not the library's own work");
    expect(headroomError(r, { metrics: { ...ok, encode_long_ir: { enabled: true, cv: 0, base_value: 1_000_000 } } }, 0.1)).toContain("gave no value");
    expect(headroomError(second({ metrics: [heavy("encode_long_ir", "encode-long", false)] }), { metrics: ok }, 0.1)).toContain("declares no fixed_command");
    // a size metric needs none, and a disabled metric is not judged
    const size: Recipe["metrics"][number] = { name: "size", kind: "slim", direction: "lower", deterministic: true, command: "wc -c", parser: "bytes", min_effect: 0.005 };
    expect(headroomError({ metrics: [size] }, { metrics: { size: { enabled: true, cv: 0, base_value: 99 } } }, 0.1)).toBeNull();
    expect(headroomError(second({ metrics: [heavy("encode_long_ir", "encode-long", false)] }), { metrics: { encode_long_ir: { enabled: false, cv: 1 } } }, 0.1)).toBeNull();
  });

  test("merged calibrations carry fixed_value when every replay measured it, and refuse replays that disagree on it", () => {
    const r = second();
    const s = "7".repeat(64);
    const m = (f?: number) => ({ encode_long_ir: { enabled: true, cv: 0, base_value: 1_000_000, ...(f ? { fixed_value: f } : {}) }, decode_long_ir: { enabled: true, cv: 0, base_value: 2_000_000, fixed_value: 100_000 } });
    const a = { replayer: "a", deps_digest: "d", calibration: calib(r, s, m(50_000)) };
    const merged = mergeCalibrations(r, recipeId(r), s, [a, { replayer: "b", deps_digest: "d", calibration: calib(r, s, m(50_010)) }], 0.001);
    expect(merged.ok && merged.calibration.metrics.encode_long_ir!.fixed_value).toBe(50_005);
    expect(mergeCalibrations(r, recipeId(r), s, [a, { replayer: "b", deps_digest: "d", calibration: calib(r, s, m(60_000)) }], 0.001)).toMatchObject({ ok: false, reason: "metric encode_long_ir fixed values differ beyond 0.001" });
    const half = mergeCalibrations(r, recipeId(r), s, [a, { replayer: "b", deps_digest: "d", calibration: calib(r, s, m()) }], 0.001);
    expect(half.ok && half.calibration.metrics.encode_long_ir!.fixed_value).toBeUndefined();
  });

  test("settings", () => {
    expect(parseMoreUnitsSettings(undefined)).toEqual(MORE_UNITS_DEFAULTS);
    expect(MORE_UNITS_DEFAULTS).toEqual({ max_per_repo: 3, max_fixed_share: 0.1 });
    expect(() => parseMoreUnitsSettings({ max_per_repo: 0 })).toThrow();
    expect(() => parseMoreUnitsSettings({ nope: 1 })).toThrow("unknown field");
    expect(testConfig({ more_units: { max_per_repo: 5 } }).more_units).toEqual({ max_per_repo: 5, max_fixed_share: 0.1 });
  });
});

describe("more units: Core", () => {
  test("a duplicate of an existing unit is refused before any verifier is drawn", async () => {
    const e = (env = await w6env(3));
    const a = await makeAuthor(e, { repo: R2.repo });
    const dup = { ...R2, name: "fx-2", patch: { ...R2.patch, protected_paths: ["lineage_bench2.py", "tests/**"] }, overlay_digest: overlayDigestOf(OVERLAY) };
    const r = await propose(a, dup);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("duplicate_unit");
    expect(await expectOk<any[]>(e.anon.get("/v1/recipe-proposals"))).toHaveLength(0);
    for (const v of e.verifiers) expect(await expectOk<any[]>(v.c.get("/v1/recipe-proposals/assignments", true))).toHaveLength(0);
  });

  test("an additional unit with new targets is calibrated, and becomes a unit only when the calibration shows headroom", async () => {
    const e = (env = await w6env(3));
    const a = await makeAuthor(e, { repo: R2.repo });
    // no headroom: 30% of encode_long_ir is not the library
    const r = second();
    const p = await expectOk(propose(a, r));
    expect(p.status).toBe("calibrating");
    await calibrateAll(e, (seed) => calib(r, seed, { encode_long_ir: { enabled: true, cv: 0, base_value: 1_000_000, fixed_value: 300_000 }, decode_long_ir: { enabled: true, cv: 0, base_value: 2_000_000, fixed_value: 100_000 } }));
    const rejected = await expectOk(e.anon.get(`/v1/recipe-proposals/${p.proposal_id}`));
    expect(rejected.status).toBe("rejected");
    expect(rejected.reason).toContain("an additional unit must show headroom: metric encode_long_ir: 30.0% of it is not the library's own work");
    expect(await expectOk<any[]>(e.anon.get("/v1/lineages"))).toHaveLength(1);
    // the same draft with a heavier workload (a new recipe: another command) passes
    const r2 = second({ metrics: [heavy("encode_long_ir", "encode-long-x8"), heavy("decode_long_ir", "decode-long")] });
    const p2 = await expectOk(propose(a, r2));
    await calibrateAll(e, (seed) => calib(r2, seed, { encode_long_ir: { enabled: true, cv: 0, base_value: 8_000_000, fixed_value: 300_000 }, decode_long_ir: { enabled: true, cv: 0, base_value: 2_000_000, fixed_value: 100_000 } }));
    const accepted = await expectOk(e.anon.get(`/v1/recipe-proposals/${p2.proposal_id}`));
    expect(accepted.status).toBe("accepted");
    const units = await expectOk<any[]>(e.anon.get("/v1/lineages"));
    expect(units.filter((u) => u.repo === R2.repo && u.status === "active")).toHaveLength(2);
    const view = await expectOk(e.anon.get(`/v1/lineages/${accepted.lineage_id}`));
    expect(view.calibration.metrics.encode_long_ir.fixed_value).toBe(300_000);
    // the dry signal reads the recorded share: 300,000 of 8,000,000 at generation 0
    const dry = await expectOk(e.anon.get(`/v1/units/${accepted.lineage_id}/dry`));
    expect(dry.facts.fixed.encode_long_ir.share).toBeCloseTo(0.0375, 9);
    expect(dry).toMatchObject({ dry: false, fresh: true });
  });

  test("a repository at max_per_repo takes no further proposal; the first unit of a repository is not held to the headroom rule", async () => {
    const e = (env = await w6env(3, { more_units: { max_per_repo: 1 } }));
    const a = await makeAuthor(e, { repo: R2.repo });
    const r = await propose(a, second());
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("too_many_units");
    // a first unit for another repository, without fixed_command, as before this rule
    const other = second({ name: "fy", repo: "https://github.com/example/fy", commit: "fedcba9876543210fedcba9876543210fedcba98", metrics: [heavy("encode_ir", "encode", false)] });
    const p = await expectOk(propose(a, other));
    await calibrateAll(e, (seed) => calib(other, seed, { encode_ir: { enabled: true, cv: 0, base_value: 1000 } }));
    expect((await expectOk(e.anon.get(`/v1/recipe-proposals/${p.proposal_id}`))).status).toBe("accepted");
  });
});
