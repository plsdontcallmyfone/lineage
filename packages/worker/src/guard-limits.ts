import { guardChangeText, guardConfigAt, guardRuleFor, type GuardConfigVersion, type GuardRule, type Judgement } from "@units/protocol";

// Guard limits in the author's own self-evaluation (SPEC 10.1 rule 6, docs/plans/GUARD-LIMITS.md 7).
// Replays reject a candidate whose non-target metric worsens beyond its limit (`metric_regression`).
// The worker reads the guard config Core publishes (GET /v1/guard-config), picks the version in force
// now (a candidate committed by this attempt is judged with the latest version effective at its
// commit, and an admin edit is never effective before Core's clock), and judges its own measurement
// with the same pure rule. A regression is told to the model with the metric and the measured change,
// and is never submitted.

/** A guarded metric over its limit in the author's own evaluation. */
export interface GuardRegression {
  metric: string;
  /** "exceeded": worsened beyond the limit; "unmeasured": no valid samples, so it cannot show it stayed within */
  status: "exceeded" | "unmeasured";
  /** oriented ratio (above 1 is worse); for a noisy metric the lower 95% bound, the value tested */
  ratio: number | null;
  /** the limit as a fraction (0.01 = 1%) */
  limit: number;
  config_version: number;
}

const pct = (x: number) => `${+(x * 100).toFixed(4)}%`;

/** Measured change in words, e.g. "+5.50%" or "no valid samples". */
export const regressionChange = (r: GuardRegression) => (r.status === "unmeasured" || r.ratio === null ? "no valid samples" : guardChangeText(r.ratio));

/** The first guarded metric the judgement rejected for, or null (no guard rule, or every guarded metric within its limit). */
export function guardRegressionOf(j: Judgement): GuardRegression | null {
  if (j.reason !== "metric_regression" || !j.guard_limits) return null;
  const c = j.guard_limits.checks.find((x) => x.status === "exceeded" || x.status === "unmeasured");
  if (!c || c.limit === null) return null;
  return { metric: c.metric, status: c.status as GuardRegression["status"], ratio: c.worst_ratio ?? null, limit: c.limit, config_version: j.guard_limits.config_version };
}

/** The attempt's outcome line when it ends on a guard regression. */
export function guardOutcome(r: GuardRegression): string {
  return `guard regression on ${r.metric}: measured change ${regressionChange(r)}, limit ${pct(r.limit)} (guard config version ${r.config_version}); not submitted`;
}

/** What the model reads in the evaluate result: the reason, the metric, the measured change and what to do. */
export function guardFeedback(r: GuardRegression): string {
  const what =
    r.status === "unmeasured"
      ? `${r.metric} has no valid samples, so the change cannot show it stayed within the limit of ${pct(r.limit)}`
      : `${r.metric} worsened ${regressionChange(r)} against the parent; the limit is ${pct(r.limit)}`;
  return (
    `guard regression on ${r.metric}: ${what}. Every metric other than the target may worsen by at most its limit ` +
    `(guard config version ${r.config_version}); replays would reject this candidate with metric_regression, so it will not be submitted. ` +
    `Change the patch so ${r.metric} stays within the limit and evaluate again, or give_up.`
  );
}

/** Reads the published guard config history and resolves the rule for a recipe; null when no version is in force (rule version 1). */
export function guardRuleNow(history: GuardConfigVersion[], recipe_id: string, now: number): GuardRule | null {
  return guardRuleFor(guardConfigAt(history, now), recipe_id);
}

type Getter = (path: string) => Promise<{ status: number; body: unknown }>;

/**
 * A reader for the attempt: GET /v1/guard-config on every call (an evaluation takes minutes; the
 * config rarely changes). A Core without the route (404) has no guards. On any other failure the
 * last rule read is kept, and with none the error is thrown: the caller does not submit without
 * knowing the rule.
 */
export function guardRuleReader(get: Getter, recipe_id: string, now: () => number = Date.now): () => Promise<GuardRule | null> {
  let last: { rule: GuardRule | null } | null = null;
  return async () => {
    try {
      const r = await get("/v1/guard-config");
      if (r.status === 404) return (last = { rule: null }).rule;
      if (r.status !== 200) throw new Error(`GET /v1/guard-config: HTTP ${r.status}`);
      const versions = ((r.body as { versions?: GuardConfigVersion[] } | null)?.versions ?? []) as GuardConfigVersion[];
      return (last = { rule: guardRuleNow(versions, recipe_id, now()) }).rule;
    } catch (e) {
      if (last) return last.rule;
      throw e;
    }
  };
}
