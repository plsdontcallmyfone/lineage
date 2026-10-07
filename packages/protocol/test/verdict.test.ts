import { describe, expect, test } from "bun:test";
import { judge, Rng, type Calibration, type CandidateView, type Recipe, type ReplayResult, type RevealedReplay } from "../src/index.ts";

const recipe: Recipe = {
  name: "fx",
  repo: "https://example.com/fx",
  commit: "abc",
  image: "img@sha256:00",
  workdir: "/work/src",
  prepare: [],
  build: { commands: ["make"], reproducible: true },
  test: { command: "t", parser: "tap", exclude: ["net_test"], timeout_s: 60 },
  equivalence: { command: "e", output: "stdout-digest" },
  metrics: [
    { name: "ir", kind: "perf", direction: "lower", deterministic: true, command: "c", parser: "p", min_effect: 0.01 },
    { name: "ns", kind: "perf", direction: "lower", deterministic: false, command: "c", parser: "p", min_effect: 0.03, rounds: 15 },
    { name: "size", kind: "slim", direction: "lower", deterministic: true, command: "c", parser: "p", min_effect: 0.005 },
  ],
  patch: { allowed_paths: ["src/**"], protected_paths: [], max_files: 5, max_lines: 200 },
  limits: { cpus: 2, memory_mb: 1024, pids: 128, wall_s: 600, disk_mb: 1024 },
};

const calib: Calibration = {
  recipe_id: "r",
  snapshot_id: "s",
  runs: 5,
  stable: ["t1", "t2", "t3"],
  known_failures: ["bug1", "bug2"],
  quarantined: ["flaky"],
  metrics: { ir: { enabled: true, cv: 0 }, ns: { enabled: true, cv: 0.02 }, size: { enabled: false, cv: 0, reason: "test" } },
  median_eval_seconds: 120,
};

const perf: CandidateView = { candidate_id: "c1", author: "author", kind: "perf", target: "ir" };

function noisy(seed: string, n: number, mu: number, sd: number): number[] {
  const r = new Rng(seed);
  return Array.from({ length: n }, () => mu + sd * (r.next() + r.next() + r.next() - 1.5) * 2);
}

function good(over: Partial<ReplayResult> = {}, irCand = 900): ReplayResult {
  return {
    apply: "ok",
    guard: "ok",
    build: { base: "ok", cand: "ok", base_digest: "bd", cand_digest: "cd" },
    tests: { base_pass: ["t1", "t2", "t3", "net_test"], cand_pass: ["t1", "t2", "t3"], cand_fail: ["bug1", "bug2"] },
    equivalence: { base_digest: "e1", cand_digest: "e1" },
    metrics: {
      ir: { base: [1000], cand: [irCand], deterministic: true },
      ns: { base: noisy("b", 15, 100, 3), cand: noisy("c", 15, 85, 3), deterministic: false },
    },
    env: { image_digest: "img", cpu_model: "x", cores: 2, worker_version: "0" },
    transcript_digest: "t",
    ...over,
  };
}

const rep = (id: string, result: ReplayResult, replayer = `w-${id}`, reference = false): RevealedReplay => ({
  replay_id: id,
  replayer,
  seed: `seed-${id}`,
  result,
  reference,
});

describe("judge", () => {
  test("accepts a deterministic improvement both replays agree on", () => {
    const j = judge(recipe, calib, perf, [rep("a", good()), rep("b", good())]);
    expect(j.outcome).toBe("accepted");
    expect("metric" in j.effect! && j.effect.ratio).toBeCloseTo(0.9);
    expect(j.minority).toEqual([]);
  });

  test("digest is stable and order independent, and changes with any input", () => {
    const a = judge(recipe, calib, perf, [rep("a", good()), rep("b", good())]);
    const b = judge(recipe, calib, perf, [rep("b", good()), rep("a", good())]);
    expect(a.digest).toBe(b.digest);
    const c = judge(recipe, calib, perf, [rep("a", good()), rep("b", good({ transcript_digest: "other" }))]);
    expect(c.digest).not.toBe(a.digest);
  });

  test("pending below quorum; the author never counts", () => {
    expect(judge(recipe, calib, perf, [rep("a", good())]).outcome).toBe("pending");
    expect(judge(recipe, calib, perf, [rep("a", good()), rep("b", good(), "author")]).outcome).toBe("pending");
  });

  test("broken environment is excluded, not blamed", () => {
    const broken = good({ tests: { base_pass: ["t1"], cand_pass: ["t1", "t2", "t3"], cand_fail: [] } });
    const j = judge(recipe, calib, perf, [rep("a", good()), rep("b", broken)]);
    expect(j.outcome).toBe("pending");
    expect(j.env_failed).toEqual(["b"]);
  });

  test("rejections carry the right reason", () => {
    const both = (r: ReplayResult, c: CandidateView = perf) => judge(recipe, calib, c, [rep("a", r), rep("b", r)]);
    expect(both(good({ guard: "PROTECTED_PATH" })).reason).toBe("guard");
    expect(both(good({ apply: "conflict" })).reason).toBe("apply_conflict");
    expect(both(good({ build: { base: "ok", cand: "fail" } })).reason).toBe("build_fail");
    expect(both(good({ tests: { base_pass: ["t1", "t2", "t3"], cand_pass: ["t1", "t2"], cand_fail: ["t3"] } })).reason).toBe("tests_fail");
    expect(both(good({ equivalence: { base_digest: "e1", cand_digest: "e2" } })).reason).toBe("equivalence_changed");
    expect(both(good({}, 995)).reason).toBe("no_improvement");
    expect(both(good({}, 1100)).reason).toBe("no_improvement");
    expect(both(good(), { ...perf, kind: "slim", target: "size" }).reason).toBe("metric_disabled");
    expect(both(good(), { ...perf, target: "nope" }).reason).toBe("metric_disabled");
  });

  test("fix candidates must fix known failures without breaking stable tests", () => {
    const fix: CandidateView = { candidate_id: "f", author: "author", kind: "fix", target: ["bug1"] };
    const fixed = good({ tests: { base_pass: ["t1", "t2", "t3"], cand_pass: ["t1", "t2", "t3", "bug1"], cand_fail: ["bug2"] } });
    const j = judge(recipe, calib, fix, [rep("a", fixed), rep("b", fixed)]);
    expect(j.outcome).toBe("accepted");
    expect(j.effect).toEqual({ fixed: ["bug1"] });
    expect(judge(recipe, calib, { ...fix, target: ["bug2"] }, [rep("a", fixed), rep("b", fixed)]).reason).toBe("fix_target_not_fixed");
    expect(judge(recipe, calib, { ...fix, target: ["t1"] }, [rep("a", fixed), rep("b", fixed)]).reason).toBe("fix_target_not_fixed");
    expect(judge(recipe, calib, { ...fix, target: ["flaky"] }, [rep("a", fixed), rep("b", fixed)]).reason).toBe("fix_target_not_fixed");
  });

  test("noisy metric: accepted with real gain, split when one replay misses it", () => {
    const ns: CandidateView = { ...perf, target: "ns" };
    expect(judge(recipe, calib, ns, [rep("a", good()), rep("b", good())]).outcome).toBe("accepted");
    const flat = good();
    flat.metrics.ns = { base: noisy("b2", 15, 100, 3), cand: noisy("c2", 15, 100, 3), deterministic: false };
    const j = judge(recipe, calib, ns, [rep("a", good()), rep("b", flat)]);
    expect(j.outcome).toBe("rejected");
    expect(j.reason).toBe("noisy_split");
  });

  test("two replays disagreeing on a deterministic field is a dispute", () => {
    const lazy = good({ tests: { base_pass: ["t1", "t2", "t3"], cand_pass: ["t1", "t2"], cand_fail: ["t3"] } });
    const j = judge(recipe, calib, perf, [rep("a", good()), rep("b", lazy)]);
    expect(j.outcome).toBe("disputed");
    expect(j.disputed_fields).toContain("tests_cand");
  });

  test("dispute with a third replay resolves by majority and names the minority", () => {
    const lazy = good({}, 700); // fabricated instruction count
    const j = judge(recipe, calib, perf, [rep("a", good()), rep("b", lazy), rep("c", good())]);
    expect(j.outcome).toBe("accepted");
    expect(j.minority).toEqual(["b"]);
    expect(j.disputed_fields).toEqual(["metric:ir"]);
  });

  test("deterministic metric agreement uses tolerance", () => {
    const j = judge(recipe, calib, perf, [rep("a", good({}, 900)), rep("b", good({}, 900.5))]);
    expect(j.outcome).toBe("accepted");
    expect(j.disputed_fields).toEqual([]);
  });

  test("reference runner breaks a 2 to 2 tie", () => {
    const bad = good({ build: { base: "ok", cand: "ok", base_digest: "bd", cand_digest: "XX" } });
    const j = judge(recipe, calib, perf, [rep("a", good()), rep("b", bad), rep("c", bad), rep("r", good(), "core", true)]);
    expect(j.outcome).toBe("accepted");
    expect(j.minority.sort()).toEqual(["b", "c"]);
  });

  test("a single replay judged alone (canary check) accepts only what it claims", () => {
    const one = { quorum: 1, det_tolerance: 0.001, bootstrap_resamples: 2000 };
    const canaryBreaksTest = good({ tests: { base_pass: ["t1", "t2", "t3"], cand_pass: ["t1", "t2"], cand_fail: ["t3"] } });
    expect(judge(recipe, calib, perf, [rep("h", canaryBreaksTest)], one).outcome).toBe("rejected");
    expect(judge(recipe, calib, perf, [rep("d", good())], one).outcome).toBe("accepted");
  });
});
