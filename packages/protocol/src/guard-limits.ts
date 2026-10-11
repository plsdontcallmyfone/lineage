import { canonicalJson, H } from "./hash.ts";
import type { CandidateKind, Hex } from "./types.ts";

// Guard limits on non-target metrics (SPEC 10.1 rule 6, owner decision 2026-10-11,
// docs/plans/GUARD-LIMITS.md). Recipes are frozen (their bytes feed recipe_id and unit ids), so the
// limits live in a versioned, append-only Core config: a network default plus per-recipe overrides
// keyed by recipe_id. A candidate is judged with the version in force when it was committed; one
// committed before the first version keeps the original rule (rule version 1, no guards).

/** A recorded guard config version, as Core publishes it at GET /v1/guard-config. */
export interface GuardConfigVersion {
  /** 1, 2, ...: a new version for every admin edit; never rewritten. */
  version: number;
  /** Candidates committed at or after this time (ms) are judged with this version, until the next one. */
  effective_from_ms: number;
  /** Max allowed regression of a guarded metric, as a fraction (0.01 = 1%). */
  default_max_regression: number;
  /** Candidate kinds the guards apply to (fix candidates target tests, not a metric). */
  kinds: CandidateKind[];
  /** recipe_id -> metric name -> limit (a fraction) or null (unguarded). */
  overrides: Record<string, Record<string, number | null>>;
  /** H("guard-config", canonical JSON of every field above). */
  digest: Hex;
}

/** The resolved guard rule one candidate is judged with (part of JudgeConfig). */
export interface GuardRule {
  config_version: number;
  config_digest: Hex;
  default_max_regression: number;
  kinds: CandidateKind[];
  /** this recipe's overrides only */
  overrides: Record<string, number | null>;
}

/** One non-target metric's guard outcome, recorded in the verdict. */
export interface GuardCheck {
  metric: string;
  /** the limit applied (a fraction), or null when the metric is unguarded */
  limit: number | null;
  status: "passed" | "exceeded" | "unmeasured" | "unguarded" | "disabled";
  /**
   * Worst oriented ratio over the counted replays (cand / base for direction lower, base / cand for
   * higher; above 1 is worse). For a noisy metric this is the worst lower CI bound, the value tested.
   */
  worst_ratio?: number;
  /** the replay that showed worst_ratio */
  replay_id?: Hex;
}

export interface GuardVerdict {
  config_version: number;
  config_digest: Hex;
  checks: GuardCheck[];
}

/** Current rule version: 1 = target only (before activation), 2 = target plus guard limits. */
export const GUARD_RULE_VERSION = 2;

export function guardConfigDigest(v: Omit<GuardConfigVersion, "digest">): Hex {
  return H(
    "guard-config",
    canonicalJson({
      version: v.version,
      effective_from_ms: v.effective_from_ms,
      default_max_regression: v.default_max_regression,
      kinds: [...v.kinds].sort(),
      overrides: v.overrides,
    }),
  );
}

/** Validates a limit: a finite fraction in [0, 1], or null (unguarded). */
export function validLimit(x: unknown): x is number | null {
  return x === null || (typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1);
}

/** The version in force for a candidate committed at `committed_at_ms`, or null (rule version 1). */
export function guardConfigAt(history: GuardConfigVersion[], committed_at_ms: number): GuardConfigVersion | null {
  let best: GuardConfigVersion | null = null;
  for (const v of history) if (v.effective_from_ms <= committed_at_ms && (!best || v.version > best.version)) best = v;
  return best;
}

export function guardRuleFor(v: GuardConfigVersion | null, recipe_id: string): GuardRule | null {
  if (!v) return null;
  return {
    config_version: v.version,
    config_digest: v.digest,
    default_max_regression: v.default_max_regression,
    kinds: [...v.kinds],
    overrides: { ...(v.overrides[recipe_id] ?? {}) },
  };
}

/** The limit a rule gives a metric: the recipe override when one is set (null = unguarded), else the default. */
export function limitFor(rule: GuardRule, metric: string): number | null {
  return Object.prototype.hasOwnProperty.call(rule.overrides, metric) ? rule.overrides[metric]! : rule.default_max_regression;
}

/** Signed change in the worse direction, for display: 1.055 -> "+5.50%". */
export function guardChangeText(ratio: number): string {
  const pct = (ratio - 1) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}
