// Budget wrap-up notice for the authoring loops. On the live site attempts kept reaching the
// per-attempt spend cap mid-work and ended with no candidate, so the money bought nothing. Once an
// attempt has used about 70% of its cap (or the next turn alone could take it past the cap), the
// model is told once to submit its best evaluated change now or give up.

export const WRAP_UP_AT = 0.7;

/**
 * `project` false (cap_mode bounded, docs/plans/AGENT-EFFICIENCY.md): only the 70% mark counts. The
 * projection (two more turns as costly as the last) fired right after one long thinking turn and
 * the model gave up with most of the cap unspent (A/B 2026-10-10, minbpe at the site's tip); with
 * bounded calls the cap holds per call, so the notice only has to say the end is near.
 */
export function wrapUpNotice(spent: number, cap: number, lastTurn: number, project = true): string | null {
  if (!(cap > 0) || !Number.isFinite(spent)) return null;
  if (spent < cap * WRAP_UP_AT && (!project || spent + 2 * lastTurn <= cap)) return null;
  const left = Math.max(0, cap - spent);
  return (
    `Budget note: about ${left.toFixed(2)} USD of this attempt's ${cap.toFixed(2)} USD is left, enough for one or two more turns. ` +
    "If you have a change that evaluated as an improvement, submit it now. If not, call give_up with a short reason. Do not start new exploration."
  );
}

// Pacing (efficiency.pace, docs/plans/AGENT-EFFICIENCY.md section 5). The model cannot see its
// spend, and a single thinking turn took most of an attempt on the site, so with pacing on it is
// told the budget at the start, what is left after every tool result, and is nudged twice.

export const PACE_NUDGE_AT = 0.5;
export const PACE_FINAL_AT = 0.8;

/** The budget paragraph of the opening message. */
export function paceIntro(capUsd: number, maxEvals: number): string {
  return (
    `Budget for this attempt: ${capUsd.toFixed(2)} USD of model spend. Everything you read and everything you think counts, and thinking is the larger part: one long reasoning turn can take a third of it. ` +
    "Every tool result ends with a line saying what is left. " +
    "Do not try to work out instruction counts in your head. Pick a target, read its hot path once, make a concrete change early and call evaluate: the measurement costs no model budget while it runs and reports the real ratio of every metric. " +
    `You have ${maxEvals} evaluations. When a change measures an improvement that is real but under the minimum, extend it with a further improvement to the same code path and evaluate again instead of starting over. ` +
    "Submit as soon as an evaluation reports accepted; the budget for that call is kept for you."
  );
}

/** The line appended to every tool result turn. */
export function paceLine(leftUsd: number, capUsd: number, evalsLeft: number): string {
  return `[budget: ${Math.max(0, leftUsd).toFixed(2)} of ${capUsd.toFixed(2)} USD left; ${evalsLeft} evaluation${evalsLeft === 1 ? "" : "s"} left]`;
}

export type PaceStage = "nudge" | "final";

/**
 * The paced wrap-up: at half the budget, when nothing was evaluated yet, a nudge to stop reading and
 * measure; at 80% the final notice, worded for what the attempt holds (an accepted evaluation, an
 * evaluated change that fell short, or nothing measured). Each stage is sent once (`sent`).
 */
export function paceNotice(o: { spent: number; cap: number; evaluated: boolean; accepted: boolean; evalsLeft: number; sent: ReadonlySet<PaceStage> }): { stage: PaceStage; text: string } | null {
  if (!(o.cap > 0) || !Number.isFinite(o.spent)) return null;
  const left = Math.max(0, o.cap - o.spent).toFixed(2);
  if (o.spent >= o.cap * PACE_FINAL_AT && !o.sent.has("final")) {
    const text = o.accepted
      ? `Budget note: ${left} USD is left. Your last evaluation was accepted: call submit now.`
      : o.evaluated && o.evalsLeft > 0
        ? `Budget note: ${left} USD is left, enough for one short turn and one more evaluation. If you know a concrete extension of your change, make it and evaluate now; otherwise call give_up with a short reason. Do not read further.`
        : o.evalsLeft > 0
          ? `Budget note: ${left} USD is left, enough for one short turn. If you have an edit in place, call evaluate now; if you have none, call give_up with a short reason. Do not read further.`
          : `Budget note: ${left} USD is left and no evaluation is left. Call give_up with a short reason.`;
    return { stage: "final", text };
  }
  if (o.spent >= o.cap * PACE_NUDGE_AT && !o.evaluated && !o.sent.has("nudge") && !o.sent.has("final"))
    return { stage: "nudge", text: `Budget note: half of this attempt's budget is spent (${left} USD left) and nothing has been evaluated. Stop reading: make your most promising change now and call evaluate. A measured result is worth more than further analysis.` };
  return null;
}
