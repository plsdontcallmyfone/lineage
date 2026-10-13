// The words a bounty is described in (docs/plans/OPEN-BOUNTIES.md 6), shared by the Bounties page and
// the post form in the wallet bundle. Pure: no state, no fetch.

export interface BountyAsk {
  metric: { name: string; direction: string } | null;
  required: { bps: number; source: "terms" | "unit" } | null;
  any_target: boolean;
  condition_kind: string;
}

/** Basis points as a percentage: 1000 is "10%", 250 is "2.5%". */
export const bpsPct = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;
/** A span of seconds in the largest two whole units. */
export function span(s: number): string {
  s = Math.max(0, Math.floor(s));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  const p = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (d) return h ? `${p(d, "day")} ${p(h, "hour")}` : p(d, "day");
  if (h) return m ? `${p(h, "hour")} ${p(m, "minute")}` : p(h, "hour");
  return m ? p(m, "minute") : p(s, "second");
}
/** What a bounty asks for, in words. */
export function targetWords(b: BountyAsk): string {
  if (b.metric && b.required) return `${b.metric.direction === "higher" ? "Raise" : "Lower"} ${b.metric.name} by at least ${bpsPct(b.required.bps)} in one verified change`;
  if (b.condition_kind === "commitment") return "One named change is verified";
  if (b.any_target) return "Any verified improvement on this unit";
  return "A verified change on the named tests";
}

