import { describe, expect, test } from "bun:test";
import {
  assignReplayers,
  bootstrapRatio,
  costClass,
  cv,
  effectValue,
  leafHash,
  mannWhitneyP,
  median,
  merkleProof,
  merkleRoot,
  proportionalSplit,
  Rng,
  verifyProof,
} from "../src/index.ts";

function noisy(seed: string, n: number, mu: number, sd: number): number[] {
  const r = new Rng(seed);
  return Array.from({ length: n }, () => {
    // Box-Muller
    const u = Math.max(r.next(), 1e-12);
    const v = r.next();
    return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  });
}

describe("rng", () => {
  test("deterministic per seed and roughly uniform", () => {
    const a = new Rng("x");
    const b = new Rng("x");
    expect(Array.from({ length: 5 }, () => a.nextU32())).toEqual(Array.from({ length: 5 }, () => b.nextU32()));
    const r = new Rng("y");
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 100_000; i++) buckets[r.int(10)]++;
    for (const c of buckets) expect(Math.abs(c - 10_000)).toBeLessThan(500);
  });
});

describe("stats", () => {
  test("median and cv", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(cv([10, 10, 10])).toBe(0);
  });

  test("bootstrap detects a real 10% improvement with 3% noise", () => {
    const base = noisy("b", 15, 100, 3);
    const cand = noisy("c", 15, 90, 3);
    const ci = bootstrapRatio(base, cand, "lower", "seed", 4000);
    expect(ci.ratio).toBeLessThan(0.95);
    expect(ci.ci_high).toBeLessThan(0.97);
    expect(ci.p_value).toBeLessThan(0.01);
  });

  test("bootstrap does not show an improvement where there is none", () => {
    let falsePasses = 0;
    for (let i = 0; i < 40; i++) {
      const base = noisy(`b${i}`, 15, 100, 3);
      const cand = noisy(`c${i}`, 15, 100, 3);
      const ci = bootstrapRatio(base, cand, "lower", `s${i}`, 2000);
      if (ci.ci_high < 0.97) falsePasses++;
    }
    expect(falsePasses).toBe(0);
  });

  test("bootstrap is reproducible from its seed and respects direction", () => {
    const base = noisy("b", 10, 100, 2);
    const cand = noisy("c", 10, 120, 2);
    expect(bootstrapRatio(base, cand, "higher", "k", 1000)).toEqual(bootstrapRatio(base, cand, "higher", "k", 1000));
    expect(bootstrapRatio(base, cand, "higher", "k", 1000).ci_high).toBeLessThan(0.9);
    expect(mannWhitneyP(base, cand, "higher")).toBeLessThan(0.01);
  });
});

describe("economics", () => {
  test("cost class clamps", () => {
    expect(costClass(5)).toBe(1);
    expect(costClass(600)).toBe(10);
    expect(costClass(99999)).toBe(30);
  });

  test("effect value uses the conservative edge and caps", () => {
    const e = { metric: "m", ratio: 0.8, ci_low: 0.78, ci_high: 0.9, per_replay: [] };
    expect(effectValue(e, 0.01, 8)).toBeCloseTo(Math.log2(11));
    expect(effectValue({ ...e, ci_high: 0.01 }, 0.01, 4)).toBe(4);
    expect(effectValue({ fixed: ["a", "b", "c"] }, 0.01, 8)).toBe(2);
  });

  test("proportional split sums exactly to the pool", () => {
    for (const pool of [0n, 1n, 7n, 1_000_000_007n, 123456789012345678n]) {
      const units = new Map([["a", 1], ["b", 2], ["c", 3.3333], ["d", 0]]);
      const out = proportionalSplit(pool, units);
      const sum = [...out.values()].reduce((x, y) => x + y, 0n);
      expect(sum).toBe(pool === 0n ? 0n : pool);
      expect(out.has("d")).toBe(false);
    }
  });

  test("assignment excludes author and operator, is deterministic and bond-weighted", () => {
    const pool = [
      { agent: "A", bond: 100n, operator: "op1" },
      { agent: "B", bond: 100n, operator: "op1" },
      { agent: "C", bond: 100n },
      { agent: "D", bond: 300n },
      { agent: "E", bond: 100n },
    ];
    const s = assignReplayers("seed", pool, 2, { agents: ["A"], operator: "op1" }, 1000n);
    expect(s).toHaveLength(2);
    expect(s).not.toContain("A");
    expect(s).not.toContain("B");
    expect(assignReplayers("seed", pool, 2, { agents: ["A"], operator: "op1" }, 1000n)).toEqual(s);
    const counts: Record<string, number> = {};
    for (let i = 0; i < 6000; i++) {
      const [first] = assignReplayers(`s${i}`, pool, 1, { agents: ["A"], operator: "op1" }, 1000n);
      counts[first!] = (counts[first!] ?? 0) + 1;
    }
    expect(counts.D! / counts.C!).toBeGreaterThan(2.5);
    expect(counts.D! / counts.C!).toBeLessThan(3.5);
    // bond cap flattens weight
    const capped: Record<string, number> = {};
    for (let i = 0; i < 4000; i++) {
      const [first] = assignReplayers(`t${i}`, pool, 1, { agents: ["A"], operator: "op1" }, 100n);
      capped[first!] = (capped[first!] ?? 0) + 1;
    }
    expect(capped.D! / capped.C!).toBeLessThan(1.3);
  });

  test("two replayers of one candidate never share an operator", () => {
    const pool = [
      { agent: "X1", bond: 100n, operator: "x" },
      { agent: "X2", bond: 100n, operator: "x" },
      { agent: "Y", bond: 100n },
    ];
    for (let i = 0; i < 200; i++) {
      const s = assignReplayers(`q${i}`, pool, 2, { agents: [] }, 1000n);
      expect(s.filter((a) => a.startsWith("X")).length).toBeLessThanOrEqual(1);
    }
  });

  test("merkle proofs verify for every leaf and fail for a wrong leaf", () => {
    for (const n of [1, 2, 3, 7, 16, 33]) {
      const leaves = Array.from({ length: n }, (_, i) => leafHash(`leaf${i}`));
      const root = merkleRoot(leaves);
      leaves.forEach((l, i) => expect(verifyProof(l, merkleProof(leaves, i), root)).toBe(true));
      expect(verifyProof(leafHash("nope"), merkleProof(leaves, 0), root)).toBe(n === 0);
    }
  });
});
