import { describe, expect, test } from "bun:test";
import {
  guardConfigAt,
  guardConfigDigest,
  guardRuleFor,
  judge,
  type Calibration,
  type CandidateView,
  type GuardConfigVersion,
  type GuardRule,
  type Recipe,
  type ReplayResult,
  type RevealedReplay,
} from "../src/index.ts";

// SPEC 10.1 rule 6: non-target metrics may not worsen beyond their guard limit.

const recipe: Recipe = {
  class: "rust",
  requires: { arch: "arm64" },
  name: "gx",
  repo: "https://example.com/gx",
  commit: "abc",
  image: "img@sha256:00",
  workdir: "/work/src",
  prepare: [],
  build: { commands: ["make"], reproducible: true },
  test: { command: "t", parser: "tap", exclude: [], timeout_s: 60 },
  metrics: [
    { name: "ir", kind: "perf", direction: "lower", deterministic: true, command: "c", parser: "p", min_effect: 0.01 },
    { name: "size", kind: "slim", direction: "lower", deterministic: true, command: "c", parser: "p", min_effect: 0.005 },
    { name: "tput", kind: "perf", direction: "higher", deterministic: true, command: "c", parser: "p", min_effect: 0.01 },
    { name: "ns", kind: "perf", direction: "lower", deterministic: false, command: "c", parser: "p", min_effect: 0.03, rounds: 15 },
  ],
  patch: { allowed_paths: ["src/**"], protected_paths: [], max_files: 5, max_lines: 200 },
  limits: { cpus: 2, memory_mb: 1024, pids: 128, wall_s: 600, disk_mb: 1024 },
};

const calib: Calibration = {
  recipe_id: "rid",
  snapshot_id: "s",
  runs: 5,
  stable: ["t1"],
  known_failures: ["bug1"],
  quarantined: [],
  metrics: { ir: { enabled: true, cv: 0 }, size: { enabled: true, cv: 0 }, tput: { enabled: true, cv: 0 }, ns: { enabled: true, cv: 0.01 } },
  median_eval_seconds: 60,
};

const perf: CandidateView = { candidate_id: "c1", author: "author", kind: "perf", target: "ir" };
const flat = (v: number) => Array(15).fill(v);

function res(m: { ir?: number; size?: number; tput?: number; ns?: number[] } = {}, drop: string[] = []): ReplayResult {
  const metrics: ReplayResult["metrics"] = {
    ir: { base: [1000], cand: [m.ir ?? 900], deterministic: true },
    size: { base: [1000], cand: [m.size ?? 1000], deterministic: true },
    tput: { base: [500], cand: [m.tput ?? 500], deterministic: true },
    ns: { base: flat(100), cand: m.ns ?? flat(100), deterministic: false },
  };
  for (const d of drop) delete metrics[d];
  return {
    apply: "ok",
    guard: "ok",
    build: { base: "ok", cand: "ok", base_digest: "bd", cand_digest: "cd" },
    tests: { base_pass: ["t1"], cand_pass: ["t1"], cand_fail: ["bug1"] },
    equivalence: null,
    metrics,
    env: { image_digest: "img", cpu_model: "x", cores: 2, worker_version: "0" },
    transcript_digest: "t",
  };
}
const two = (r: ReplayResult): RevealedReplay[] => [
  { replay_id: "a", replayer: "w-a", seed: "s", result: r },
  { replay_id: "b", replayer: "w-b", seed: "s", result: r },
];

function version(over: Partial<Omit<GuardConfigVersion, "digest">> = {}): GuardConfigVersion {
  const v = { version: 1, effective_from_ms: 1000, default_max_regression: 0.01, kinds: ["perf", "slim"] as GuardConfigVersion["kinds"], overrides: {}, ...over };
  return { ...v, digest: guardConfigDigest(v) };
}
const rule = (over: Partial<Omit<GuardConfigVersion, "digest">> = {}): GuardRule => guardRuleFor(version(over), "rid")!;
const cfg = (g: GuardRule | null) => ({ quorum: 2, det_tolerance: 0.001, bootstrap_resamples: 2000, guard_limits: g });

describe("guard limits", () => {
  test("a non-target regression within the limit accepts and records each check", () => {
    const j = judge(recipe, calib, perf, two(res({ size: 1009, tput: 497 })), cfg(rule()));
    expect(j.outcome).toBe("accepted");
    expect(j.rule_version).toBe(2);
    expect(j.guard_limits!.config_version).toBe(1);
    const by = Object.fromEntries(j.guard_limits!.checks.map((c) => [c.metric, c]));
    expect(Object.keys(by).sort()).toEqual(["ns", "size", "tput"]);
    expect(by.size).toMatchObject({ limit: 0.01, status: "passed", worst_ratio: 1.009 });
    expect(by.tput!.status).toBe("passed"); // higher is better: 500 / 497 = 1.006
    expect(by.tput!.worst_ratio).toBeCloseTo(500 / 497, 12);
  });

  test("beyond the limit rejects with the metric and its measured change", () => {
    const j = judge(recipe, calib, perf, two(res({ size: 1075 })), cfg(rule()));
    expect(j.outcome).toBe("rejected");
    expect(j.reason).toBe("metric_regression");
    expect(j.detail).toBe("size worsened +7.50% in replay a (guarded, limit 1%)");
    expect(j.effect).toMatchObject({ metric: "ir", ratio: 0.9 }); // the target still improved
    // direction higher: throughput falling 5.5% is a regression of base / cand = 1.0582
    const t = judge(recipe, calib, perf, two(res({ tput: 472.5 })), cfg(rule()));
    expect(t.reason).toBe("metric_regression");
    expect(t.detail).toContain("tput worsened +5.82%");
  });

  test("an improvement or an unchanged metric is never a regression", () => {
    expect(judge(recipe, calib, perf, two(res({ size: 800, tput: 900 })), cfg(rule())).outcome).toBe("accepted");
  });

  test("a noisy guarded metric rejects only when its whole interval is beyond the limit", () => {
    const jitter = (mu: number) => flat(0).map((_, i) => mu + ((i * 7) % 5) - 2);
    const slow = judge(recipe, calib, perf, two(res({ ns: jitter(110) })), cfg(rule()));
    expect(slow.reason).toBe("metric_regression");
    expect(slow.detail).toContain("ns worsened +");
    const near = judge(recipe, calib, perf, two(res({ ns: jitter(101) })), cfg(rule()));
    expect(near.outcome).toBe("accepted"); // a 1% shift inside the noise: ci_low is not above 1.01
  });

  test("unguarded (override null) and calibration-disabled metrics are ignored", () => {
    const g = rule({ overrides: { rid: { size: null } } });
    const j = judge(recipe, calib, perf, two(res({ size: 2000 })), cfg(g));
    expect(j.outcome).toBe("accepted");
    expect(j.guard_limits!.checks.find((c) => c.metric === "size")).toEqual({ metric: "size", limit: null, status: "unguarded" });
    const off: Calibration = { ...calib, metrics: { ...calib.metrics, size: { enabled: false, cv: 0, reason: "noisy" } } };
    const k = judge(recipe, off, perf, two(res({ size: 2000 }, ["size"])), cfg(rule()));
    expect(k.outcome).toBe("accepted");
    expect(k.guard_limits!.checks.find((c) => c.metric === "size")!.status).toBe("disabled");
  });

  test("a per-recipe override sets that metric's limit; other recipes keep the default", () => {
    const loose = rule({ overrides: { rid: { size: 0.1 } } });
    expect(judge(recipe, calib, perf, two(res({ size: 1075 })), cfg(loose)).outcome).toBe("accepted");
    const tight = rule({ overrides: { rid: { size: 0.001 } } });
    expect(judge(recipe, calib, perf, two(res({ size: 1005 })), cfg(tight)).detail).toBe("size worsened +0.50% in replay a (guarded, limit 0.1%)");
    const other = guardRuleFor(version({ overrides: { other: { size: 0.1 } } }), "rid")!;
    expect(judge(recipe, calib, perf, two(res({ size: 1075 })), cfg(other)).reason).toBe("metric_regression");
  });

  test("a guarded metric with no samples rejects", () => {
    const j = judge(recipe, calib, perf, two(res({}, ["size"])), cfg(rule()));
    expect(j.reason).toBe("metric_regression");
    expect(j.detail).toBe("size has no valid samples in replay a (guarded, limit 1%)");
  });

  test("the target failing reports no_improvement, not the guard", () => {
    const j = judge(recipe, calib, perf, two(res({ ir: 1000, size: 1075 })), cfg(rule()));
    expect(j.reason).toBe("no_improvement");
    expect(j.guard_limits!.checks.find((c) => c.metric === "size")!.status).toBe("exceeded");
  });

  test("fix candidates are guarded only when the config lists fix", () => {
    const fix: CandidateView = { candidate_id: "c2", author: "author", kind: "fix", target: ["bug1"] };
    const fixed = res({ size: 1075 });
    fixed.tests = { base_pass: ["t1"], cand_pass: ["t1", "bug1"], cand_fail: [] };
    expect(judge(recipe, calib, fix, two(fixed), cfg(rule())).outcome).toBe("accepted");
    expect(judge(recipe, calib, fix, two(fixed), cfg(rule({ kinds: ["perf", "slim", "fix"] }))).reason).toBe("metric_regression");
  });

  test("rule version 1 (no guard config) is the original rule with an unchanged verdict shape", () => {
    const j = judge(recipe, calib, perf, two(res({ size: 1075 })), cfg(null));
    expect(j.outcome).toBe("accepted");
    expect("rule_version" in j).toBe(false);
    expect("guard_limits" in j).toBe(false);
    const legacy = judge(recipe, calib, perf, two(res({ size: 1075 })), { quorum: 2, det_tolerance: 0.001, bootstrap_resamples: 2000 });
    expect(legacy.digest).toBe(j.digest);
    // the guard config is part of what the digest covers
    const a = judge(recipe, calib, perf, two(res()), cfg(rule()));
    const b = judge(recipe, calib, perf, two(res()), cfg(rule({ default_max_regression: 0.02 })));
    expect(a.digest).not.toBe(b.digest);
  });

  test("the version in force is the latest one effective at or before the commit", () => {
    const v1 = version({ version: 1, effective_from_ms: 1000 });
    const v2 = version({ version: 2, effective_from_ms: 5000, default_max_regression: 0.05 });
    expect(guardConfigAt([v1, v2], 999)).toBeNull();
    expect(guardConfigAt([v1, v2], 1000)!.version).toBe(1);
    expect(guardConfigAt([v1, v2], 4999)!.version).toBe(1);
    expect(guardConfigAt([v2, v1], 5000)!.version).toBe(2);
    expect(v1.digest).toBe(guardConfigDigest({ ...v1, kinds: ["slim", "perf"] }));
  });
});
