import { describe, expect, test } from "bun:test";
import {
  extraTrees,
  measuredSplit,
  Rng,
  shapleyValues,
  sharesBps,
  subCommitment,
  subsetKey,
  subsetMasks,
  type Calibration,
  type Recipe,
  type SplitReport,
} from "../src/index.ts";

// Measured split (SPEC 12.6, plan C5): exact Shapley values, their axioms, and the split outcome.

/** Shapley by its definition: average marginal contribution over all n! orders (brute force). */
function byPermutations(n: number, v: number[]): number[] {
  const phi = new Array<number>(n).fill(0);
  let count = 0;
  const perm = (rest: number[], order: number[]) => {
    if (!rest.length) {
      count++;
      let s = 0;
      for (const i of order) {
        phi[i]! += v[s | (1 << i)]! - v[s]!;
        s |= 1 << i;
      }
      return;
    }
    for (let k = 0; k < rest.length; k++) perm([...rest.slice(0, k), ...rest.slice(k + 1)], [...order, rest[k]!]);
  };
  perm([...Array(n).keys()], []);
  return phi.map((x) => x / count);
}

function randomGame(seed: string, n: number): number[] {
  const r = new Rng(seed);
  const v = Array.from({ length: 1 << n }, () => r.next() * 2 - 0.5);
  v[0] = 0;
  return v;
}

/** Relabels players by `p` (new index p[i] for old player i) and returns the relabelled game. */
function permuteGame(n: number, v: number[], p: number[]): number[] {
  const out = new Array<number>(1 << n).fill(0);
  for (let s = 0; s < 1 << n; s++) {
    let t = 0;
    for (let i = 0; i < n; i++) if (s & (1 << i)) t |= 1 << p[i]!;
    out[t] = v[s]!;
  }
  return out;
}

describe("shapleyValues (exact)", () => {
  test("n = 2 matches the closed form phi_a = (v(a) + v(ab) - v(b)) / 2", () => {
    const v = [0, 0.1, 0.05, 0.2]; // v(a) = 0.1, v(b) = 0.05, v(ab) = 0.2
    const [a, b] = shapleyValues(2, v);
    expect(a).toBeCloseTo((0.1 + 0.2 - 0.05) / 2, 15);
    expect(b).toBeCloseTo((0.05 + 0.2 - 0.1) / 2, 15);
  });

  test("glove game: one left glove and two right gloves give 2/3, 1/6, 1/6", () => {
    // player 0 holds the left glove; a pair is worth 1
    const v = new Array<number>(8).fill(0);
    for (let s = 0; s < 8; s++) v[s] = s & 1 && s & 6 ? 1 : 0;
    const phi = shapleyValues(3, v);
    expect(phi[0]).toBeCloseTo(2 / 3, 15);
    expect(phi[1]).toBeCloseTo(1 / 6, 15);
    expect(phi[2]).toBeCloseTo(1 / 6, 15);
  });

  test("additive game: each player gets exactly its own value", () => {
    const own = [0.07, 0.11, 0.02, 0.3];
    const v = Array.from({ length: 16 }, (_, s) => own.reduce((a, x, i) => a + (s & (1 << i) ? x : 0), 0));
    const phi = shapleyValues(4, v);
    own.forEach((x, i) => expect(phi[i]).toBeCloseTo(x, 14));
  });

  test("equals the average over all n! orders (brute force) for random games, n = 1 to 6", () => {
    for (let n = 1; n <= 6; n++)
      for (let k = 0; k < 5; k++) {
        const v = randomGame(`g${n}-${k}`, n);
        const a = shapleyValues(n, v);
        const b = byPermutations(n, v);
        a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, 12));
      }
  });

  test("efficiency: values sum to v(all) - v(empty)", () => {
    for (let n = 1; n <= 8; n++) {
      const v = randomGame(`eff${n}`, n);
      const sum = shapleyValues(n, v).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(v[(1 << n) - 1]! - v[0]!, 12);
    }
  });

  test("permutation invariance: relabelling players relabels their values", () => {
    const perms = [
      [1, 0, 2, 3],
      [3, 2, 1, 0],
      [2, 0, 3, 1],
      [0, 3, 1, 2],
    ];
    for (const [k, p] of perms.entries()) {
      const v = randomGame(`perm${k}`, 4);
      const phi = shapleyValues(4, v);
      const phiP = shapleyValues(4, permuteGame(4, v, p));
      for (let i = 0; i < 4; i++) expect(phiP[p[i]!]).toBeCloseTo(phi[i]!, 12);
    }
  });

  test("symmetric players get equal values; a null player gets zero", () => {
    // players 0 and 1 interchangeable, player 2 adds nothing anywhere
    const base = (s: number) => [0, 0.3, 0.3, 0.5][s & 3]!;
    const v = Array.from({ length: 8 }, (_, s) => base(s));
    const phi = shapleyValues(3, v);
    expect(phi[0]).toBeCloseTo(phi[1]!, 15);
    expect(phi[2]).toBe(0);
  });

  test("linearity: values of v + w are the sums of values", () => {
    const v = randomGame("lin-v", 3);
    const w = randomGame("lin-w", 3);
    const a = shapleyValues(3, v.map((x, i) => x + w[i]!));
    const b = shapleyValues(3, v);
    const c = shapleyValues(3, w);
    a.forEach((x, i) => expect(x).toBeCloseTo(b[i]! + c[i]!, 12));
  });

  test("rejects a value table of the wrong size", () => {
    expect(() => shapleyValues(2, [0, 1, 2])).toThrow();
    expect(() => shapleyValues(0, [0])).toThrow();
  });
});

describe("shares and coalitions", () => {
  test("sharesBps sums to 10000, ignores non-positive values, null when nothing is positive", () => {
    for (const k of [0, 1, 2, 3, 4, 5]) {
      const phi = Array.from({ length: 1 + (k % 4) }, (_, i) => new Rng(`s${k}${i}`).next());
      const s = sharesBps(phi)!;
      expect(s.reduce((a, b) => a + b, 0)).toBe(10_000);
    }
    expect(sharesBps([0.2, -0.1])).toEqual([10_000, 0]);
    expect(sharesBps([1, 1, 1])).toEqual([3334, 3333, 3333]);
    expect(sharesBps([0, -1])).toBeNull();
  });

  test("subset masks and extra trees: 2 for n = 2, 6 for n = 3", () => {
    expect(subsetMasks(2).map(subsetKey)).toEqual(["0", "1"]);
    expect(subsetMasks(3).map(subsetKey)).toEqual(["0", "1", "0+1", "2", "0+2", "1+2"]);
    expect(extraTrees(2)).toBe(2);
    expect(extraTrees(3)).toBe(6);
  });

  test("sub commitment binds hashes, order and salt", () => {
    const a = subCommitment(["h1", "h2"], "s");
    expect(a).not.toBe(subCommitment(["h2", "h1"], "s"));
    expect(a).not.toBe(subCommitment(["h1", "h2"], "t"));
    expect(a).toBe(subCommitment(["h1", "h2"], "s"));
  });
});

describe("measuredSplit", () => {
  const recipe = {
    equivalence: { command: "e", output: "stdout-digest" },
    metrics: [
      { name: "ir", kind: "perf", direction: "lower", deterministic: true, command: "c", parser: "p", min_effect: 0.01 },
      { name: "ns", kind: "perf", direction: "lower", deterministic: false, command: "c", parser: "p", min_effect: 0.03, rounds: 5 },
    ],
  } as unknown as Recipe;
  const calib = { stable: ["t1", "t2"] } as unknown as Calibration;
  const sub = (cand: number, over: object = {}) => ({ apply: "ok" as const, build: "ok" as const, cand_pass: ["t1", "t2"], equivalence: { base_digest: "e", cand_digest: "e" }, metric: { base: [1000], cand: [cand] }, ...over });
  const report = (a: number, b: number, over: Partial<SplitReport> = {}): SplitReport => ({ v: 1, compose: "ok", metric: "ir", subsets: { "0": sub(a), "1": sub(b) }, ...over });
  const effect = { metric: "ir", ratio: 0.8, ci_low: 0.8, ci_high: 0.8, per_replay: [] };
  const base = { recipe, calib, metric: "ir", n: 2, effect, det_tolerance: 0.001 };

  test("independent improvements: shares follow each sub-patch's own gain and sum to the whole gain", () => {
    // a alone saves 15%, b alone 5%, together 20%: additive, so phi = (0.15, 0.05)
    const o = measuredSplit({ ...base, reports: [{ replay_id: "r1", report: report(850, 950) }, { replay_id: "r2", report: report(850, 950) }] });
    expect(o.status).toBe("measured");
    expect(o.phi![0]).toBeCloseTo(0.15, 12);
    expect(o.phi![1]).toBeCloseTo(0.05, 12);
    expect(o.phi![0]! + o.phi![1]!).toBeCloseTo(0.2, 12);
    expect(o.share_bps).toEqual([7500, 2500]);
  });

  test("an unusable coalition tree has value 0", () => {
    const r = report(850, 950, { subsets: { "0": sub(850), "1": sub(950, { cand_pass: ["t1"] }) } });
    const o = measuredSplit({ ...base, reports: [{ replay_id: "r1", report: r }] });
    expect(o.status).toBe("measured");
    expect(o.v![2]).toBe(0);
    // phi_a = (0.15 + 0.2 - 0) / 2, phi_b = (0 + 0.2 - 0.15) / 2
    expect(o.phi![0]).toBeCloseTo(0.175, 12);
    expect(o.phi![1]).toBeCloseTo(0.025, 12);
  });

  test("disagreeing, missing or non-composing reports fall back (never a verdict change)", () => {
    expect(measuredSplit({ ...base, reports: [{ replay_id: "r1", report: report(850, 950) }, { replay_id: "r2", report: report(840, 950) }] }).status).toBe("disagreed");
    expect(measuredSplit({ ...base, reports: [{ replay_id: "r1", report: report(850, 950) }, { replay_id: "r2", report: null }] }).status).toBe("missing");
    expect(measuredSplit({ ...base, reports: [{ replay_id: "r1", report: report(850, 950, { compose: "mismatch" }) }] }).status).toBe("invalid");
    expect(measuredSplit({ ...base, metric: "ns", reports: [{ replay_id: "r1", report: report(850, 950) }] }).status).toBe("not_applicable");
  });

  test("relabelling the members relabels the shares", () => {
    const a = measuredSplit({ ...base, reports: [{ replay_id: "r1", report: report(870, 960) }] });
    const b = measuredSplit({ ...base, reports: [{ replay_id: "r1", report: report(960, 870) }] });
    expect(b.share_bps).toEqual([...a.share_bps!].reverse());
  });
});
