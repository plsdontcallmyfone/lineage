import { sha256Hex, type CandidateKind } from "@units/protocol";
import type { IntentView, PlannedTarget } from "./proposers/types.ts";
import type { SharedData } from "./shared-findings.ts";

// Target spread (agent productivity lane, docs/plans/AGENT-EFFICIENCY.md section 5). A hosted agent's
// repository is fixed at launch, and several agents share one unit, so on the site they kept editing
// the same function of the same metric: cross-agent stale conflicts, and the same dead ends tried
// again. A model proposer has no plan step and filed no intent, so no agent could see what another
// was on. Before each attempt the worker now picks one of the unit's enabled metric targets from
// counts only (no model call), tells the model which one and why, and files an advisory intent for
// it (SPEC 12.1), which is what the other agents' pick reads. The model may still choose another
// target; nothing is locked.

export interface SpreadPick {
  planned: PlannedTarget;
  /** one paragraph for the opening message: the target and the counts behind the pick */
  line: string;
  /** the same counts, for the log */
  why: { others: number; own_fruitless: number; tip_failed: number; no_candidate: number };
}

export interface SpreadInput {
  /** the recipe's enabled metric targets, in recipe order */
  targets: { kind: CandidateKind; name: string }[];
  /** live intents on the unit (the worker's own included) */
  intents: IntentView[];
  self: string;
  /** the unit's current tip */
  tip: string;
  /** Core's shared items for the unit (final episodes only), or null */
  shared: SharedData | null;
  /** this agent's attempts on the current tip that ended without a candidate, by "kind:name" */
  fruitless?: ReadonlyMap<string, number>;
}

const key = (kind: string, name: string) => `${kind}:${name}`;

/**
 * The target with the fewest other agents on it, then the fewest of this agent's own fruitless
 * attempts on this tip, then the fewest candidates that already failed on this tip, then the fewest
 * attempts by anyone that ended without a candidate. Ties are broken by an order that differs per
 * agent and tip (a digest), so agents that see the same counts still spread out. Null with no target.
 */
export function pickTarget(o: SpreadInput): SpreadPick | null {
  if (!o.targets.length) return null;
  const rows = o.targets.map((t) => {
    const k = key(t.kind, t.name);
    const others = new Set(o.intents.filter((i) => i.agent !== o.self && i.status === "open" && !Array.isArray(i.target) && key(i.kind, i.target) === k).map((i) => i.agent)).size;
    const items = (o.shared?.items ?? []).filter((it) => it && it.target === k);
    const tipFailed = items.filter((it) => it.kind === "failed" && it.on_tip).length;
    const noCandidate = items.filter((it) => it.kind === "no_candidate").reduce((a, it) => a + (Number.isSafeInteger(it.count) ? it.count : 0), 0);
    const own = o.fruitless?.get(k) ?? 0;
    const tie = sha256Hex(new TextEncoder().encode(`${o.self}\n${o.tip}\n${k}`));
    return { t, k, others, own, tipFailed, noCandidate, tie };
  });
  rows.sort((a, b) => a.others - b.others || a.own - b.own || a.tipFailed - b.tipFailed || a.noCandidate - b.noCandidate || a.tie.localeCompare(b.tie));
  const r = rows[0]!;
  const n = (c: number, one: string, many: string) => `${c} ${c === 1 ? one : many}`;
  const facts = [
    r.others === 0 ? "no other agent has an open intent on it" : `${n(r.others, "other agent has", "other agents have")} an open intent on it, the fewest of this unit's targets`,
    `${n(r.tipFailed, "candidate", "candidates")} on it already failed on the current tip`,
    ...(r.own ? [`${n(r.own, "attempt", "attempts")} of yours on this tip ended without a candidate`] : []),
  ];
  const line =
    `Suggested target for this attempt: ${r.t.kind} ${r.t.name} (${facts.join("; ")}). ` +
    (o.targets.length > 1 ? "Agents on this unit are pointed at different targets so that their changes do not collide. " : "") +
    "It is a suggestion from counts, not a rule: take another target only if the code shows a clearly larger gain there.";
  return { planned: { kind: r.t.kind, target: r.t.name }, line, why: { others: r.others, own_fruitless: r.own, tip_failed: r.tipFailed, no_candidate: r.noCandidate } };
}

// Unit choice (recipes headroom lane, docs/plans/AGENT-EFFICIENCY.md section 6). A repository can have
// several active units (the same commit under different recipes: other workloads, other targets). The
// worker used to take them in Core's order and return to the first whenever it yielded a candidate, so
// a second unit only saw the attempts the first one wasted. With target spread on, each attempt starts
// by ranking the agent's units from the same public counts as the target pick.

export interface UnitInput {
  unit: string;
  /** the unit's enabled metric targets */
  targets: { kind: CandidateKind; name: string }[];
  /** live intents on the unit */
  intents: IntentView[];
  /** Core's shared items for the unit, or null */
  shared: SharedData | null;
  /** this agent's attempts on the unit's current tip that ended without a candidate, all targets */
  ownFruitless: number;
}

export interface UnitRank {
  unit: string;
  targets: number;
  /** targets no other agent holds an open intent on */
  free_targets: number;
  /** other agents with an open intent on the unit */
  others: number;
  own_fruitless: number;
  /** candidates that failed on the tip plus attempts by anyone that ended without a candidate */
  misses: number;
}

/**
 * The units in the order to try them. First the units that still have a target no other agent is on;
 * then the fewest misses per target, counting this agent's own fruitless attempts on the tip (which
 * it knows at once) and the misses by anyone that Core has published (a saturated unit sinks); then
 * the fewest other agents per target. Per target, because a unit with five targets has room for more
 * work than one with two. Ties by a
 * digest of agent and unit, so agents that see the same counts do not all take the same unit. Units
 * without an enabled target go last.
 */
export function rankUnits(self: string, units: UnitInput[]): UnitRank[] {
  const rows = units.map((u) => {
    const keys = new Set(u.targets.map((t) => key(t.kind, t.name)));
    const open = u.intents.filter((i) => i.agent !== self && i.status === "open");
    const taken = new Set(open.filter((i) => !Array.isArray(i.target) && keys.has(key(i.kind, i.target))).map((i) => key(i.kind, i.target as string)));
    const items = (u.shared?.items ?? []).filter((it) => it && keys.has(String(it.target)));
    const misses =
      items.filter((it) => it.kind === "failed" && it.on_tip).length +
      items.filter((it) => it.kind === "no_candidate").reduce((a, it) => a + (Number.isSafeInteger(it.count) ? it.count : 0), 0);
    const n = u.targets.length;
    const rank: UnitRank = { unit: u.unit, targets: n, free_targets: n - taken.size, others: new Set(open.map((i) => i.agent)).size, own_fruitless: u.ownFruitless, misses };
    return { rank, n, tie: sha256Hex(new TextEncoder().encode(`${self}\n${u.unit}`)) };
  });
  // a / a.n against b / b.n without division
  const per = (a: number, an: number, b: number, bn: number) => a * bn - b * an;
  rows.sort(
    (a, b) =>
      Number(a.n === 0) - Number(b.n === 0) ||
      Number(a.rank.free_targets === 0) - Number(b.rank.free_targets === 0) ||
      per(a.rank.own_fruitless + a.rank.misses, a.n, b.rank.own_fruitless + b.rank.misses, b.n) ||
      per(a.rank.others, a.n, b.rank.others, b.n) ||
      a.tie.localeCompare(b.tie),
  );
  return rows.map((r) => r.rank);
}
