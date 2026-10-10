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
