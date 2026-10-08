import { canonicalJson, H, hashJson } from "./hash.ts";
import { median, orientedRatio, relDiff } from "./stats.ts";
import type { Calibration, Hex, MetricEffect, Recipe } from "./types.ts";

// Measured split (SPEC 12.6, plan C5). A team commits one sub-patch per member alongside its
// candidate; replayers measure every proper non-empty subset of the sub-patches on the target's
// deterministic metric; author units are divided by the Shapley value of each member's sub-patch.
// Everything here is pure: Core, scripts/verify.ts and anyone holding the revealed replays compute
// the same shares. Acceptance never depends on it (the verdict is computed from `result` alone).

/**
 * Exact Shapley values for an n-player game. `v[mask]` is the value of the coalition whose
 * members are the set bits of `mask` (bit i = player i); `v[0]` is the empty coalition.
 *
 *   phi_i = sum over S not containing i of |S|! (n - |S| - 1)! / n! * (v(S + i) - v(S))
 */
export function shapleyValues(n: number, v: number[]): number[] {
  if (!Number.isInteger(n) || n < 1 || n > 16) throw new Error("shapley: n must be an integer from 1 to 16");
  if (v.length !== 1 << n) throw new Error(`shapley: need 2^n = ${1 << n} coalition values, got ${v.length}`);
  const fact = [1];
  for (let k = 1; k <= n; k++) fact.push(fact[k - 1]! * k);
  const phi = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const bit = 1 << i;
    for (let s = 0; s < 1 << n; s++) {
      if (s & bit) continue;
      const size = popcount(s);
      phi[i]! += ((fact[size]! * fact[n - size - 1]!) / fact[n]!) * (v[s | bit]! - v[s]!);
    }
  }
  return phi;
}

export function popcount(x: number): number {
  let c = 0;
  for (; x; x &= x - 1) c++;
  return c;
}

/** Proper, non-empty coalitions: the subsets a replayer measures beyond base (empty) and the candidate (all). */
export function subsetMasks(n: number): number[] {
  const out: number[] = [];
  for (let s = 1; s < (1 << n) - 1; s++) out.push(s);
  return out;
}

/** Key of a coalition in a split report: the member indexes in order, joined by "+" (e.g. "0+2"). */
export function subsetKey(mask: number): string {
  const idx: number[] = [];
  for (let i = 0; mask >> i; i++) if ((mask >> i) & 1) idx.push(i);
  return idx.join("+");
}

/** Extra trees per replay for an n-member split: every coalition except empty (base) and all (the candidate). */
export const extraTrees = (n: number): number => (1 << n) - 2;

/**
 * Shares in basis points from Shapley values: max(0, phi_i) normalised, largest remainder, ties by
 * member order. Null when no member has a positive value (declared shares apply).
 */
export function sharesBps(phi: number[]): number[] | null {
  const pos = phi.map((p) => (Number.isFinite(p) && p > 0 ? p : 0));
  const sum = pos.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return null;
  const raw = pos.map((p) => (p / sum) * 10_000);
  const out = raw.map((r) => Math.floor(r));
  let left = 10_000 - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k]!.i]!++;
  return out;
}

// ------------------------------------------------------------------ commitments

/** What a team binds at commit time: the hashes of its sub-patches, in member order, under the candidate's salt. */
export const subCommitment = (subPatchHashes: Hex[], salt: string): Hex => H("split-subs", canonicalJson(subPatchHashes), salt);

/** A replayer's commitment to its split report, made together with its result commitment. */
export const splitReportCommitment = (report: unknown, salt: string): Hex => H("commit-split", hashJson(report), salt);

// ------------------------------------------------------------------ replayer reports

/** One measured coalition tree: raw fields only, Core and verify.ts derive the status. */
export interface SubsetMeasure {
  apply: "ok" | "conflict";
  build: "ok" | "fail" | "skipped";
  cand_pass: string[];
  equivalence: { base_digest: Hex; cand_digest: Hex } | null;
  metric: { base: number[]; cand: number[] } | null;
}

export interface SplitReport {
  v: 1;
  /** Whether the sub-patches, applied in member order to the parent, give exactly the candidate's tree. */
  compose: "ok" | "mismatch" | "conflict" | "skipped";
  metric: string;
  /** keyed by subsetKey(mask) for every mask of subsetMasks(n) */
  subsets: Record<string, SubsetMeasure>;
  /** Informational (not compared): seconds spent on the main replay and on the extra trees. */
  cost?: { main_s: number; subsets_s: number };
}

export type SubsetStatus = "ok" | "apply_conflict" | "build_fail" | "tests_fail" | "equivalence_changed" | "no_metric";

/** Status of a coalition tree, from its raw fields (SPEC 12.6: an unusable state has value 0). */
export function subsetStatus(m: SubsetMeasure, recipe: Recipe, calib: Calibration): SubsetStatus {
  if (m.apply !== "ok") return "apply_conflict";
  if (m.build !== "ok") return "build_fail";
  const pass = new Set(m.cand_pass);
  if (!calib.stable.every((t) => pass.has(t))) return "tests_fail";
  if (recipe.equivalence && (!m.equivalence || m.equivalence.base_digest !== m.equivalence.cand_digest)) return "equivalence_changed";
  const ok = (xs: unknown) => Array.isArray(xs) && xs.length > 0 && xs.every((x) => typeof x === "number" && Number.isFinite(x) && x > 0);
  if (!m.metric || !ok(m.metric.base) || !ok(m.metric.cand)) return "no_metric";
  return "ok";
}

/** Oriented ratio of a usable coalition tree (below 1 is an improvement), or null. */
export function subsetRatio(m: SubsetMeasure, recipe: Recipe, calib: Calibration, metric: string): number | null {
  if (subsetStatus(m, recipe, calib) !== "ok") return null;
  const spec = recipe.metrics.find((x) => x.name === metric);
  if (!spec) return null;
  return orientedRatio(median(m.metric!.base), median(m.metric!.cand), spec.direction);
}

/** Gain of a coalition: max(0, 1 - ratio); 0 for an unusable tree. */
export const gainOf = (ratio: number | null): number => (ratio === null ? 0 : Math.max(0, 1 - ratio));

export interface SplitOutcome {
  status: "measured" | "disagreed" | "invalid" | "missing" | "no_gain" | "not_applicable";
  detail: string;
  /** coalition gains by mask (index), when measured */
  v: number[] | null;
  phi: number[] | null;
  share_bps: number[] | null;
  /** replay ids whose reports were used */
  used: Hex[];
}

/**
 * The measured split of an accepted candidate (SPEC 12.6). Inputs are public once the candidate is
 * final: the recipe, the calibration in force, the verdict effect, the split's member count and the
 * counted replays' revealed reports. Rules:
 *   - every counted replay must have a report, with compose "ok" and every coalition key present;
 *   - coalitions must agree across reports: same status, and ratios within det_tolerance;
 *   - v(empty) = 0, v(all) = 1 - effect.ratio (the verdict's worst-case ratio), v(S) = 1 - worst ratio of S;
 *   - shares are sharesBps(phi); any failure returns a non-"measured" status and declared shares apply.
 */
export function measuredSplit(p: {
  recipe: Recipe;
  calib: Calibration;
  metric: string;
  n: number;
  effect: MetricEffect | { fixed: string[] } | undefined | null;
  reports: { replay_id: Hex; report: SplitReport | null }[];
  det_tolerance: number;
}): SplitOutcome {
  const none = (status: SplitOutcome["status"], detail: string): SplitOutcome => ({ status, detail, v: null, phi: null, share_bps: null, used: [] });
  const spec = p.recipe.metrics.find((m) => m.name === p.metric);
  if (!spec || !spec.deterministic) return none("not_applicable", `target ${p.metric} is not a deterministic metric`);
  if (!p.effect || !("ratio" in p.effect)) return none("not_applicable", "no metric effect");
  if (!p.reports.length) return none("missing", "no counted replay");
  const masks = subsetMasks(p.n);
  for (const r of p.reports) {
    if (!r.report) return none("missing", `replay ${r.replay_id.slice(0, 10)} revealed no split report`);
    if (r.report.compose !== "ok") return none("invalid", `replay ${r.replay_id.slice(0, 10)}: sub-patches compose ${r.report.compose}`);
    if (r.report.metric !== p.metric) return none("invalid", `replay ${r.replay_id.slice(0, 10)} measured ${r.report.metric}`);
    for (const m of masks) if (!r.report.subsets?.[subsetKey(m)]) return none("missing", `replay ${r.replay_id.slice(0, 10)} lacks coalition ${subsetKey(m)}`);
  }
  const v = new Array<number>(1 << p.n).fill(0);
  v[(1 << p.n) - 1] = gainOf(p.effect.ratio);
  for (const m of masks) {
    const key = subsetKey(m);
    const st = p.reports.map((r) => subsetStatus(r.report!.subsets[key]!, p.recipe, p.calib));
    if (st.some((s) => s !== st[0])) return none("disagreed", `coalition ${key}: statuses ${st.join(", ")}`);
    const ratios = p.reports.map((r) => subsetRatio(r.report!.subsets[key]!, p.recipe, p.calib, p.metric));
    if (ratios[0] === null) {
      v[m] = 0;
      continue;
    }
    const tol = spec.tolerance ?? p.det_tolerance;
    for (const x of ratios) if (relDiff(x!, ratios[0]!) > tol) return none("disagreed", `coalition ${key}: ratios ${ratios.map((r) => r!.toFixed(6)).join(", ")}`);
    v[m] = gainOf(Math.max(...(ratios as number[])));
  }
  const phi = shapleyValues(p.n, v);
  const share_bps = sharesBps(phi);
  if (!share_bps) return { status: "no_gain", detail: "no member has a positive Shapley value", v, phi, share_bps: null, used: p.reports.map((r) => r.replay_id) };
  return { status: "measured", detail: `phi ${phi.map((x) => x.toFixed(6)).join(", ")} of v(all) ${v[(1 << p.n) - 1]!.toFixed(6)}`, v, phi, share_bps, used: p.reports.map((r) => r.replay_id) };
}
