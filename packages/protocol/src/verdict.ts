import { H, hashJson } from "./hash.ts";
import { bootstrapRatio, median, orientedRatio, relDiff } from "./stats.ts";
import type {
  Calibration,
  CandidateView,
  Hex,
  MetricEffect,
  Recipe,
  RejectReason,
  RevealedReplay,
  ReplayResult,
} from "./types.ts";

// The acceptance rule, SPEC sections 10.1 and 10.2. Pure and deterministic: anyone holding the
// recipe, calibration, candidate and revealed replays recomputes the same verdict and digest.

export interface JudgeConfig {
  quorum: number;
  det_tolerance: number;
  bootstrap_resamples: number;
}

export const DEFAULT_JUDGE: JudgeConfig = { quorum: 2, det_tolerance: 0.001, bootstrap_resamples: 10_000 };

export interface Judgement {
  outcome: "accepted" | "rejected" | "disputed" | "pending";
  reason?: RejectReason;
  detail?: string;
  effect?: MetricEffect | { fixed: string[] };
  /** Replays the outcome was computed from. */
  counted: Hex[];
  /** Replays excluded because their own environment failed (base did not reproduce calibration). */
  env_failed: Hex[];
  /** Replays that disagree with the resolved majority on a deterministic field (slashable). */
  minority: Hex[];
  /** Deterministic fields on which counted replays disagreed. */
  disputed_fields: string[];
  digest: Hex;
}

const sortedUniq = (xs: string[]) => [...new Set(xs)].sort();
const setEq = (a: string[], b: string[]) => {
  const x = sortedUniq(a);
  const y = sortedUniq(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/** Base reproduces calibration: otherwise the replay environment is broken (SPEC 9.3). */
function envOk(r: ReplayResult, calib: Calibration, excluded: Set<string>): boolean {
  if (r.build.base !== "ok") return false;
  const basePass = r.tests.base_pass.filter((t) => !excluded.has(t));
  return setEq(basePass, calib.stable);
}

type FieldValue = string;

/** Non-finite numbers have no canonical JSON; hash them as tagged strings so judging never throws. */
function finiteOnly<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "number" && !Number.isFinite(x) ? `__nonfinite:${String(x)}` : x)));
}

/** Fields whose honest value depends on the replay seed. */
const SEED_DEPENDENT = new Set(["equivalence"]);

/**
 * Deterministic fields of one replay. Numeric deterministic metrics are compared with tolerance
 * separately (see metricClusters), everything else is compared by exact string value.
 */
function exactFields(r: ReplayResult, recipe: Recipe, calib: Calibration): Record<string, FieldValue> {
  const relevant = new Set([...calib.stable, ...calib.known_failures]);
  const f: Record<string, FieldValue> = {
    apply: r.apply,
    guard: r.guard,
    build_cand: r.build.cand,
  };
  if (r.apply === "ok" && r.guard === "ok" && r.build.cand === "ok") {
    f.tests_cand = sortedUniq(r.tests.cand_pass.filter((t) => relevant.has(t))).join("\n");
    if (recipe.build.reproducible && r.build.cand_digest) f.cand_digest = r.build.cand_digest;
    if (recipe.equivalence && r.equivalence)
      f.equivalence = r.equivalence.base_digest === r.equivalence.cand_digest ? "same" : "changed";
  }
  return f;
}

function agree(a: number, b: number, tol: number): boolean {
  return relDiff(a, b) <= tol;
}

/** Resolves a field by strict majority, with the reference runner breaking exact ties. */
function majority<T>(
  items: { id: Hex; ref: boolean; v: T }[],
  same: (a: T, b: T) => boolean,
): { winners: Set<Hex> } | null {
  const groups: { v: T; ids: Hex[]; ref: boolean }[] = [];
  for (const it of items) {
    const g = groups.find((g) => same(g.v, it.v));
    if (g) {
      g.ids.push(it.id);
      g.ref ||= it.ref;
    } else groups.push({ v: it.v, ids: [it.id], ref: it.ref });
  }
  if (groups.length === 1) return { winners: new Set(groups[0]!.ids) };
  groups.sort((a, b) => b.ids.length - a.ids.length);
  const top = groups[0]!;
  const second = groups[1]!;
  if (top.ids.length > items.length / 2) return { winners: new Set(top.ids) };
  if (top.ids.length === second.ids.length) {
    const tied = groups.filter((g) => g.ids.length === top.ids.length);
    const withRef = tied.filter((g) => g.ref);
    if (items.length >= 3 && withRef.length === 1) return { winners: new Set(withRef[0]!.ids) };
  }
  return null;
}

export function judge(
  recipe: Recipe,
  calib: Calibration,
  cand: CandidateView,
  replays: RevealedReplay[],
  cfg: JudgeConfig = DEFAULT_JUDGE,
): Judgement {
  const excluded = new Set(recipe.test.exclude ?? []);
  const env_failed: Hex[] = [];
  let counted: RevealedReplay[] = [];
  for (const r of [...replays].sort((a, b) => (a.replay_id < b.replay_id ? -1 : 1))) {
    if (r.replayer === cand.author) continue; // never count the author (SPEC 10.1 rule 2)
    if (envOk(r.result, calib, excluded)) counted.push(r);
    else env_failed.push(r.replay_id);
  }

  const digestOf = (j: Omit<Judgement, "digest">): Hex =>
    H(
      "verdict",
      hashJson({
        candidate: cand,
        calib_stable: sortedUniq(calib.stable),
        replays: [...replays]
          .sort((a, b) => (a.replay_id < b.replay_id ? -1 : 1))
          .map((r) => ({ id: r.replay_id, by: r.replayer, seed: r.seed, result: hashJson(finiteOnly(r.result)) })),
        outcome: finiteOnly(j),
      }),
    );
  const finish = (j: Omit<Judgement, "digest" | "env_failed">): Judgement => {
    const full = { ...j, env_failed };
    return { ...full, digest: digestOf(full) };
  };

  if (counted.length < cfg.quorum) {
    return finish({
      outcome: "pending",
      reason: "insufficient_replays",
      detail: `${counted.length} of ${cfg.quorum} valid replays`,
      counted: counted.map((r) => r.replay_id),
      minority: [],
      disputed_fields: [],
    });
  }

  // 1. Deterministic agreement (SPEC 10.2).
  const disputed_fields: string[] = [];
  let winners = new Set(counted.map((r) => r.replay_id));
  const fieldsById = new Map(counted.map((r) => [r.replay_id, exactFields(r.result, recipe, calib)]));
  const allFieldNames = sortedUniq(counted.flatMap((r) => Object.keys(fieldsById.get(r.replay_id)!)));
  let unresolved = false;
  // Seed-independent fields are compared across every counted replay. Seed-dependent ones
  // (equivalence and deterministic metric values) only among replays that ran the same seed:
  // honest replays of different inputs legitimately differ (SPEC 10.2, 10.3).
  const bySeed = new Map<string, RevealedReplay[]>();
  for (const r of counted) bySeed.set(r.seed, [...(bySeed.get(r.seed) ?? []), r]);
  const groups = [...bySeed.values()].filter((g) => g.length >= 2);
  const resolve = <T>(name: string, items: { id: Hex; ref: boolean; v: T }[], same: (a: T, b: T) => boolean) => {
    if (items.length < 2) return;
    const m = majority(items, same);
    if (m && m.winners.size === items.length) return;
    if (!disputed_fields.includes(name)) disputed_fields.push(name);
    if (!m) unresolved = true;
    else winners = new Set([...winners].filter((id) => m.winners.has(id) || !items.some((i) => i.id === id)));
  };
  for (const name of allFieldNames) {
    const value = (r: RevealedReplay) => ({ id: r.replay_id, ref: !!r.reference, v: fieldsById.get(r.replay_id)![name] ?? "<absent>" });
    if (SEED_DEPENDENT.has(name)) for (const g of groups) resolve(name, g.map(value), (a, b) => a === b);
    else resolve(name, counted.map(value), (a, b) => a === b);
  }
  for (const metric of recipe.metrics.filter((m) => m.deterministic)) {
    const tol = metric.tolerance ?? cfg.det_tolerance;
    const same = (a: readonly [number, number], b: readonly [number, number]) =>
      agree(a[0], b[0], tol) && (Number.isNaN(a[1]) ? Number.isNaN(b[1]) : agree(a[1], b[1], tol));
    for (const g of groups) {
      const items = g
        .filter((r) => r.result.metrics[metric.name])
        .map((r) => {
          const s = r.result.metrics[metric.name]!;
          return { id: r.replay_id, ref: !!r.reference, v: [median(s.base), s.cand.length ? median(s.cand) : NaN] as const };
        });
      resolve(`metric:${metric.name}`, items, same);
    }
  }

  if (unresolved || (disputed_fields.length > 0 && counted.length < 3)) {
    return finish({
      outcome: "disputed",
      detail: `disagreement on ${disputed_fields.join(", ")}`,
      counted: counted.map((r) => r.replay_id),
      minority: [],
      disputed_fields,
    });
  }
  const minority = counted.filter((r) => !winners.has(r.replay_id)).map((r) => r.replay_id);
  counted = counted.filter((r) => winners.has(r.replay_id));
  const countedIds = counted.map((r) => r.replay_id);
  if (counted.length < cfg.quorum) {
    return finish({ outcome: "disputed", detail: "majority below quorum", counted: countedIds, minority, disputed_fields });
  }
  const reject = (reason: RejectReason, detail: string): Judgement =>
    finish({ outcome: "rejected", reason, detail, counted: countedIds, minority, disputed_fields });

  // 2. Acceptance rules on the agreeing set (SPEC 10.1 rules 3 to 5).
  const r0 = counted[0]!.result;
  if (r0.guard !== "ok") return reject("guard", r0.guard);
  if (r0.apply !== "ok") return reject("apply_conflict", "patch does not apply to parent");
  if (r0.build.cand !== "ok") return reject("build_fail", "candidate build failed");
  // a test that is reported both passing and failing (duplicate or forged output) counts as failing
  const candFail = new Set(r0.tests.cand_fail);
  const candPass = new Set(r0.tests.cand_pass.filter((t) => !candFail.has(t)));
  const broken = calib.stable.filter((t) => !candPass.has(t));
  if (broken.length) return reject("tests_fail", `${broken.length} stable tests fail: ${broken.slice(0, 10).join(", ")}`);

  if (cand.kind === "fix") {
    const targets = Array.isArray(cand.target) ? cand.target : [cand.target];
    const known = new Set(calib.known_failures);
    const invalid = targets.filter((t) => !known.has(t));
    if (targets.length === 0 || invalid.length) return reject("fix_target_not_fixed", `not known failures: ${invalid.join(", ") || "(none given)"}`);
    const still = targets.filter((t) => !candPass.has(t));
    if (still.length) return reject("fix_target_not_fixed", `still failing: ${still.join(", ")}`);
    return finish({ outcome: "accepted", effect: { fixed: sortedUniq(targets) }, counted: countedIds, minority, disputed_fields });
  }

  if (recipe.equivalence) {
    const eq = r0.equivalence;
    if (!eq) return reject("equivalence_changed", "equivalence harness produced no output");
    if (eq.base_digest !== eq.cand_digest) return reject("equivalence_changed", "candidate output differs from parent on seeded inputs");
  }

  const metricName = Array.isArray(cand.target) ? cand.target[0] : cand.target;
  const metric = recipe.metrics.find((m) => m.name === metricName);
  if (!metric || metric.kind !== cand.kind) return reject("metric_disabled", `no ${cand.kind} metric named ${metricName}`);
  if (calib.metrics[metric.name] && !calib.metrics[metric.name]!.enabled)
    return reject("metric_disabled", calib.metrics[metric.name]!.reason ?? "disabled by calibration");

  const threshold = 1 - metric.min_effect;
  const per: MetricEffect["per_replay"] = [];
  for (const r of counted) {
    const s = r.result.metrics[metric.name];
    if (!s || s.base.length === 0 || s.cand.length === 0) return reject("no_improvement", `replay ${r.replay_id} has no samples for ${metric.name}`);
    // every metric here is a count, a size or a duration: only finite positive samples are measurements
    if (![...s.base, ...s.cand].every((v) => typeof v === "number" && Number.isFinite(v) && v > 0))
      return reject("no_improvement", `replay ${r.replay_id} reported a non-positive or non-finite sample for ${metric.name}`);
    const minSamples = metric.deterministic ? 1 : Math.max(5, metric.rounds ?? 5);
    if (s.base.length < minSamples || s.cand.length < minSamples)
      return reject("no_improvement", `replay ${r.replay_id} has ${Math.min(s.base.length, s.cand.length)} samples for ${metric.name}, ${minSamples} required`);
    if (metric.deterministic) {
      const ratio = orientedRatio(median(s.base), median(s.cand), metric.direction);
      per.push({ replay_id: r.replay_id, ratio, ci_low: ratio, ci_high: ratio, pass: ratio <= threshold });
    } else {
      const ci = bootstrapRatio(s.base, s.cand, metric.direction, H("bootstrap", r.seed, metric.name), cfg.bootstrap_resamples);
      per.push({ replay_id: r.replay_id, ratio: ci.ratio, ci_low: ci.ci_low, ci_high: ci.ci_high, pass: ci.ci_high < threshold });
    }
  }
  const effect: MetricEffect = {
    metric: metric.name,
    ratio: Math.max(...per.map((p) => p.ratio)),
    ci_low: Math.min(...per.map((p) => p.ci_low)),
    ci_high: Math.max(...per.map((p) => p.ci_high)),
    per_replay: per,
  };
  const passes = per.filter((p) => p.pass).length;
  if (passes === per.length) return finish({ outcome: "accepted", effect, counted: countedIds, minority, disputed_fields });
  if (passes === 0 || metric.deterministic)
    return finish({ outcome: "rejected", reason: "no_improvement", detail: `worst ratio ${effect.ratio.toFixed(4)} vs required ${threshold.toFixed(4)}`, effect, counted: countedIds, minority, disputed_fields });
  return finish({ outcome: "rejected", reason: "noisy_split", detail: `${passes} of ${per.length} replays show the improvement`, effect, counted: countedIds, minority, disputed_fields });
}
