import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateId, canonicalizeDiff, judge, patchHash, type Calibration, type Recipe, type ReplayResult, type RevealedReplay } from "../src/index.ts";

// Regression tests for the adversarial review (2026-10-07).

const recipe = {
  name: "h",
  class: "rust",
  requires: { arch: "arm64" },
  repo: "https://example.com/h",
  commit: "a".repeat(40),
  image: "i@sha256:" + "0".repeat(64),
  workdir: "/work/src",
  prepare: [],
  build: { commands: ["b"] },
  test: { command: "t", parser: "tap", timeout_s: 60 },
  metrics: [
    { name: "ir", kind: "perf", direction: "lower", deterministic: true, command: "c", parser: "number", min_effect: 0.01 },
    { name: "ns", kind: "perf", direction: "lower", deterministic: false, command: "c", parser: "number", min_effect: 0.03, rounds: 12 },
  ],
  patch: { allowed_paths: ["src/**"], protected_paths: [], max_files: 5, max_lines: 200 },
  limits: { cpus: 1, memory_mb: 512, pids: 64, wall_s: 60, disk_mb: 100 },
} as Recipe;
const calib: Calibration = { recipe_id: "r", snapshot_id: "s", runs: 3, stable: ["t1", "t2"], known_failures: ["bug"], quarantined: [], metrics: { ir: { enabled: true, cv: 0 }, ns: { enabled: true, cv: 0.01 } }, median_eval_seconds: 5 };

function result(over: Partial<ReplayResult>): ReplayResult {
  return {
    apply: "ok",
    guard: "ok",
    build: { base: "ok", cand: "ok" },
    tests: { base_pass: ["t1", "t2"], cand_pass: ["t1", "t2"], cand_fail: ["bug"] },
    equivalence: null,
    metrics: { ir: { base: [1000], cand: [900], deterministic: true } },
    env: { image_digest: "", cpu_model: "", cores: 1, worker_version: "" },
    transcript_digest: "t",
    ...over,
  };
}
const two = (r: ReplayResult): RevealedReplay[] => [
  { replay_id: "a", replayer: "va", seed: "s", result: r },
  { replay_id: "b", replayer: "vb", seed: "s", result: r },
];
const perf = (target: string) => ({ candidate_id: "c", author: "au", kind: "perf" as const, target });

describe("judge input hardening", () => {
  test("a test reported both passing and failing is failing", () => {
    const r = result({ tests: { base_pass: ["t1", "t2"], cand_pass: ["t1", "t2"], cand_fail: ["t2"] } });
    expect(judge(recipe, calib, perf("ir"), two(r)).reason).toBe("tests_fail");
    const fix = result({ tests: { base_pass: ["t1", "t2"], cand_pass: ["t1", "t2", "bug"], cand_fail: ["bug"] } });
    expect(judge(recipe, calib, { candidate_id: "c", author: "au", kind: "fix", target: ["bug"] }, two(fix)).reason).toBe("fix_target_not_fixed");
  });

  test("negative, zero and non-finite samples are never measurements", () => {
    for (const bad of [-5, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = result({ metrics: { ir: { base: [1000], cand: [bad], deterministic: true } } });
      const j = judge(recipe, calib, perf("ir"), two(r));
      expect(j.outcome).not.toBe("accepted");
    }
  });

  test("a noisy metric needs its declared rounds of samples on both sides", () => {
    const one = result({ metrics: { ns: { base: [100], cand: [10], deterministic: false } } });
    expect(judge(recipe, calib, perf("ns"), two(one)).reason).toBe("no_improvement");
    const enough = result({
      metrics: { ns: { base: Array.from({ length: 12 }, (_, i) => 100 + (i % 3)), cand: Array.from({ length: 12 }, (_, i) => 80 + (i % 3)), deterministic: false } },
    });
    expect(judge(recipe, calib, perf("ns"), two(enough)).outcome).toBe("accepted");
  });
});

describe("identifier hardening", () => {
  test("fix target lists cannot collide through a comma", () => {
    const base = { lineage_id: "l", parent_gen_id: "g", patch_hash: "p", author: "a", kind: "fix" as const };
    expect(candidateId({ ...base, target: ["a,b"] })).not.toBe(candidateId({ ...base, target: ["a", "b"] }));
    expect(candidateId({ ...base, target: ["b", "a"] })).toBe(candidateId({ ...base, target: ["a", "b"] }));
  });
});

describe("CRLF files", () => {
  function git(dir: string, ...args: string[]) {
    const p = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], { cwd: dir });
    if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    return p.stdout.toString();
  }
  test("a patch to a CRLF file keeps its CRs, applies, and hashes differently from the LF variant", () => {
    const dir = mkdtempSync(join(tmpdir(), "lineage-crlf-"));
    try {
      writeFileSync(join(dir, "a.txt"), "one\r\ntwo\r\nthree\r\n");
      git(dir, "init", "-q");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "b");
      writeFileSync(join(dir, "a.txt"), "one\r\nTWO\r\nthree\r\n");
      const crlf = canonicalizeDiff(git(dir, "diff", "--no-color", "-U3"));
      expect(crlf).toContain("+TWO\r");
      git(dir, "checkout", "-q", "--", "a.txt");
      writeFileSync(join(dir, "p.diff"), crlf);
      git(dir, "apply", "--check", "p.diff");
      const lf = crlf.replace(/\r/g, "");
      expect(patchHash(crlf)).not.toBe(patchHash(lf));
      expect(readFileSync(join(dir, "a.txt"), "utf8")).toContain("two\r\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
