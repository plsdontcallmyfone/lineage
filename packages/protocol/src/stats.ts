import { Rng } from "./rng.ts";
import type { Direction, Hex } from "./types.ts";

// Measurement statistics, SPEC section 9.

export function median(xs: number[]): number {
  if (xs.length === 0) throw new Error("median of empty sample");
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Coefficient of variation (sample standard deviation over mean). */
export function cv(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  if (m === 0) return 0;
  const v = xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v) / Math.abs(m);
}

function quantileSorted(s: number[], q: number): number {
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

/**
 * Oriented ratio so that values below 1 are always improvements:
 * cand/base for direction "lower", base/cand for "higher".
 */
export function orientedRatio(base: number, cand: number, direction: Direction): number {
  if (direction === "lower") return base === 0 ? (cand === 0 ? 1 : Infinity) : cand / base;
  return cand === 0 ? (base === 0 ? 1 : Infinity) : base / cand;
}

export interface RatioCI {
  ratio: number;
  ci_low: number;
  ci_high: number;
  p_value: number;
}

/**
 * Ratio of medians with a percentile bootstrap CI. Deterministic for a given seed, so anyone can
 * recompute it from the revealed samples.
 */
export function bootstrapRatio(
  base: number[],
  cand: number[],
  direction: Direction,
  seed: Hex,
  resamples = 10_000,
  confidence = 0.95,
): RatioCI {
  if (base.length === 0 || cand.length === 0) throw new Error("bootstrapRatio: empty sample");
  const ratio = orientedRatio(median(base), median(cand), direction);
  const rng = new Rng(seed);
  const rs = new Float64Array(resamples);
  const bb = new Array<number>(base.length);
  const cc = new Array<number>(cand.length);
  for (let r = 0; r < resamples; r++) {
    for (let i = 0; i < base.length; i++) bb[i] = base[rng.int(base.length)]!;
    for (let i = 0; i < cand.length; i++) cc[i] = cand[rng.int(cand.length)]!;
    rs[r] = orientedRatio(median(bb), median(cc), direction);
  }
  const sorted = Array.from(rs).sort((a, b) => a - b);
  const alpha = (1 - confidence) / 2;
  return {
    ratio,
    ci_low: quantileSorted(sorted, alpha),
    ci_high: quantileSorted(sorted, 1 - alpha),
    p_value: mannWhitneyP(base, cand, direction),
  };
}

/** One-sided Mann-Whitney U p-value (normal approximation, tie-corrected) that cand improves on base. */
export function mannWhitneyP(base: number[], cand: number[], direction: Direction): number {
  const n1 = cand.length;
  const n2 = base.length;
  const all = [...cand.map((v) => ({ v, g: 0 })), ...base.map((v) => ({ v, g: 1 }))].sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(all.length);
  let tieTerm = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j + 1 < all.length && all[j + 1]!.v === all[i]!.v) j++;
    const r = (i + j + 2) / 2;
    for (let k = i; k <= j; k++) ranks[k] = r;
    const t = j - i + 1;
    tieTerm += t ** 3 - t;
    i = j + 1;
  }
  let r1 = 0;
  all.forEach((x, i) => {
    if (x.g === 0) r1 += ranks[i]!;
  });
  const u1 = r1 - (n1 * (n1 + 1)) / 2; // large when cand values are large
  const mu = (n1 * n2) / 2;
  const n = n1 + n2;
  const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - tieTerm / (n * (n - 1))));
  if (sigma === 0) return 0.5;
  // improvement means cand smaller for "lower": small u1
  const z = direction === "lower" ? (u1 - mu + 0.5) / sigma : (mu - u1 + 0.5) / sigma;
  return normalCdf(z);
}

export function normalCdf(z: number): number {
  // Abramowitz and Stegun 7.1.26 via erf
  const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Relative disagreement between two deterministic readings. */
export function relDiff(a: number, b: number): number {
  if (a === b) return 0;
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b));
}
