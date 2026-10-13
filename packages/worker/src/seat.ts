import type { CandidateKind } from "@units/protocol";
import type { PlannedTarget } from "./proposers/types.ts";
import { pickTarget, type SpreadInput } from "./target-spread.ts";

// A swarm's seat, as the worker sees it (docs/plans/SWARMS.md 2 and 3). A swarm is one agent whose
// work is done by several seats: each seat is a Worker of the same agent key with its own model. The
// hosted runtime keeps the swarm's ledger (packages/runtime/src/swarm.ts) and hands every seat its
// unit and target through these hooks, so inside a swarm placement is a rule, not a suggestion:
//
//   place     before an attempt: the unit and target this seat works on now, and the swarm's open
//             candidates on that unit to build on (one stack per unit), or why it waits;
//   retarget  the model came back with a change on another target: allowed only when no other seat
//             holds that target;
//   commit    commits are serialized per unit: inside it the worker reads the stack as it is at that
//             moment, checks that its change applies on the tip plus that stack, and commits with
//             `depends_on` the newest candidate of the stack, so no seat's candidate can be made
//             stale by another seat's;
//   ended     the attempt is over: without a candidate the target is free again, with one it stays
//             this seat's until that candidate is final.
//
// A Worker without these hooks is a solo agent and none of this code runs.

export interface SeatTarget {
  kind: CandidateKind;
  name: string;
  /** the counts behind its place in the order (target-spread.ts), for the opening message */
  facts: string;
}

export interface SeatUnitInput {
  unit: string;
  /** the unit's tip when it was read */
  tip: string;
  /** the unit's enabled metric targets, best first by the counts of target spread */
  targets: SeatTarget[];
  /** commit ids of the swarm's candidates Core lists as open on this unit, and when that was read (ms) */
  open: string[];
  read_at: number;
}

export interface SeatStack {
  /** the newest open candidate of the swarm on the unit: what a new one depends on */
  commit_id: string;
  /** the patches of the swarm's open candidates on the unit, oldest first */
  patches: string[];
}

export interface SeatPlacement {
  unit: string;
  planned: PlannedTarget;
  stack: SeatStack | null;
  /** the lead's two-line brief for this seat, when its planning call gave one */
  brief: string | null;
}

export interface SeatCommitIo {
  /** the swarm's stack on the unit now, given the open candidates Core lists (read at `readAt`) */
  stack(open: string[], readAt: number): SeatStack | null;
  /** this seat's candidate was committed and revealed: it joins the unit's stack */
  committed(commitId: string, patch: string): void;
}

export interface SeatHooks {
  seat: number;
  name: string;
  role: "lead" | "builder";
  /** the fixed paragraph of the seat's role (packages/souls ROLE_PARAGRAPHS) */
  rolePrompt: string;
  /** the key of this seat's own desktop (packages/desktop: the agent id for seat 1) */
  desktopKey: string;
  place(units: SeatUnitInput[], maxOpen: number): { ok: true; p: SeatPlacement } | { ok: false; why: string };
  retarget(unit: string, kind: CandidateKind, target: string | string[]): boolean;
  commit<T>(unit: string, f: (io: SeatCommitIo) => Promise<T>): Promise<T>;
  ended(commitId: string | null): void;
}

/**
 * A unit's targets in the order target spread would pick them (the pick, then the pick among the
 * rest, and so on), each with the counts behind it. pickTarget itself is not changed.
 */
export function rankTargets(o: SpreadInput): SeatTarget[] {
  const out: SeatTarget[] = [];
  let rest = [...o.targets];
  while (rest.length) {
    const p = pickTarget({ ...o, targets: rest });
    if (!p) break;
    const name = p.planned.target as string;
    const n = (c: number, one: string, many: string) => `${c} ${c === 1 ? one : many}`;
    out.push({
      kind: p.planned.kind,
      name,
      facts: `${n(p.why.others, "other agent has", "other agents have")} an open intent on it; ${n(p.why.tip_failed, "candidate", "candidates")} on it already failed on the current tip`,
    });
    rest = rest.filter((t) => !(t.kind === p.planned.kind && t.name === name));
  }
  return out;
}

/** The assignment paragraph of a seat's opening message: its target is fixed for the attempt. */
export function seatLine(p: SeatPlacement, facts: string | null): string {
  const t = Array.isArray(p.planned.target) ? p.planned.target.join(", ") : p.planned.target;
  return (
    `Your target for this attempt: ${p.planned.kind} ${t}. It is assigned to you: the other targets of this repository belong to the other agents of your group, so work on this one only.` +
    (facts ? ` (${facts}.)` : "") +
    (p.stack ? ` Your repository copy already holds ${p.stack.patches.length === 1 ? "one change" : `${p.stack.patches.length} changes`} of your group on this unit that ${p.stack.patches.length === 1 ? "is" : "are"} still being verified; build on ${p.stack.patches.length === 1 ? "it" : "them"}.` : "") +
    (p.brief ? `\nFrom your group's lead: ${p.brief}` : "")
  );
}
