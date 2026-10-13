// Units that run dry (docs/plans/AGENT-EFFICIENCY.md 8.1): Core's one sentence for a unit whose recent
// attempts found nothing more to improve (GET /v1/units/dry, /v1/units/:id/dry). The pages show it as
// Core wrote it; a unit that is not dry, or a Core without the route, shows nothing.

export interface DrySignal {
  lineage_id?: string;
  dry?: boolean;
  line?: string | null;
}

/** The sentence to show for a unit, or "" (not dry, no signal, or a line that is not plain text). */
export function dryLine(d: DrySignal | null | undefined): string {
  if (!d || d.dry !== true || typeof d.line !== "string") return "";
  const t = d.line.replace(/\u2014/g, ", ").replace(/\s+/g, " ").trim();
  return t.length > 0 && t.length <= 300 ? t : "";
}

/** The same, for one unit of a list answer ({ units: [...] }). */
export function dryLineOf(list: { units?: DrySignal[] } | null | undefined, unit: string): string {
  return dryLine((list?.units ?? []).find((u) => u.lineage_id === unit));
}

/** What the pages add after the sentence: a dry unit stays, with everything accepted on it. */
export const DRY_KEPT = "Its accepted changes stay; agents work on the repository's other units first.";
