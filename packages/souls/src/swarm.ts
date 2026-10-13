// The soul's optional `swarm` block (docs/plans/SWARMS.md, option A): one registered agent whose
// work is done by several seats. The block is part of the signed soul, so its digest is what the
// launch already commits on chain with `set_profile`; nothing else about a seat exists on chain.
// Pure data and checks: no I/O, safe for the browser and for Core.
//
// A soul without the block is a solo agent, exactly as before. With it, `soul.model` stays and equals
// seat 1's model, so a reader that knows nothing of swarms still reads a valid model.

export const SWARM_V = 1 as const;
/** The validator's hard bound; the size a network offers is its `swarm.max_members` setting (Core). */
export const SWARM_HARD_MAX = 16;

export type SeatRole = "lead" | "builder";

export interface SwarmSeat {
  /** 1 to N, contiguous, in order */
  seat: number;
  name: string;
  role: SeatRole;
  model: { provider: string; id: string };
}

export interface SoulSwarm {
  v: typeof SWARM_V;
  members: SwarmSeat[];
}

const NAME = /^[\p{L}\p{N}][\p{L}\p{N} .'-]*$/u;
const PROVIDER = /^[a-z][a-z0-9-]{1,31}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
const CONTROL = /[\u0000-\u001f\u007f—]/; // control characters and em dashes
export const SEAT_NAME_MAX = 40;

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const modelOk = (m: unknown): m is { provider: string; id: string } =>
  isObj(m) && Object.keys(m).length === 2 && typeof m.provider === "string" && PROVIDER.test(m.provider) && typeof m.id === "string" && MODEL_ID.test(m.id);

/**
 * Structural problems of a `swarm` block; `model` is the soul's own `model` field (it must equal seat
 * 1's). Empty when the block is well formed. The network's size limit and the model registry are
 * Core's checks (packages/core/src/swarms.ts).
 */
export function validateSwarm(s: unknown, model: unknown, path = "soul.swarm"): string[] {
  const errs: string[] = [];
  if (!isObj(s)) return [`${path}: must be an object`];
  for (const k of Object.keys(s)) if (k !== "v" && k !== "members") errs.push(`${path}.${k}: unknown field`);
  if (s.v !== SWARM_V) errs.push(`${path}.v: must be ${SWARM_V}`);
  const ms = s.members;
  if (!Array.isArray(ms)) return [...errs, `${path}.members: must be a list`];
  if (ms.length < 1 || ms.length > SWARM_HARD_MAX) errs.push(`${path}.members: needs 1 to ${SWARM_HARD_MAX} seats, has ${ms.length}`);
  const names = new Set<string>();
  let leads = 0;
  ms.slice(0, SWARM_HARD_MAX).forEach((m, i) => {
    const p = `${path}.members[${i}]`;
    if (!isObj(m)) return void errs.push(`${p}: must be an object`);
    const keys = Object.keys(m);
    for (const k of keys) if (!["seat", "name", "role", "model"].includes(k)) errs.push(`${p}.${k}: unknown field`);
    for (const k of ["seat", "name", "role", "model"]) if (!(k in m)) errs.push(`${p}.${k}: missing`);
    if (m.seat !== i + 1) errs.push(`${p}.seat: must be ${i + 1} (seats are numbered from 1 in order)`);
    if (typeof m.name !== "string" || !m.name.trim() || m.name.length > SEAT_NAME_MAX || CONTROL.test(m.name) || !NAME.test(m.name) || m.name !== m.name.trim())
      errs.push(`${p}.name: 1 to ${SEAT_NAME_MAX} letters, digits, spaces, dots, apostrophes and hyphens`);
    else {
      const k = m.name.toLowerCase();
      if (names.has(k)) errs.push(`${p}.name: used by another seat`);
      names.add(k);
    }
    if (m.role !== "lead" && m.role !== "builder") errs.push(`${p}.role: lead or builder`);
    if (m.role === "lead") leads++;
    if (!modelOk(m.model)) errs.push(`${p}.model: { provider, id } from the model registry`);
  });
  if (leads !== 1) errs.push(`${path}.members: exactly one lead, has ${leads}`);
  const first = isObj(ms[0]) ? ms[0].model : null;
  if (!modelOk(model)) errs.push(`${path}: a soul with a swarm block names its model (seat 1's)`);
  else if (modelOk(first) && (first.provider !== model.provider || first.id !== model.id)) errs.push(`${path}.members[0].model: must equal soul.model`);
  return errs;
}

/** The seats of a soul document: its swarm block's members, or null for a solo agent. */
export function swarmSeats(doc: unknown): SwarmSeat[] | null {
  const s = isObj(doc) ? (doc.swarm as SoulSwarm | undefined) : undefined;
  return s && Array.isArray(s.members) && s.members.length > 0 ? s.members : null;
}

/** One seat of a soul document, or null (no swarm block, or no such seat). */
export function swarmSeat(doc: unknown, seat: number): SwarmSeat | null {
  return swarmSeats(doc)?.find((m) => m.seat === seat) ?? null;
}

/**
 * The seat that leads by default (docs/plans/SWARMS.md 3): the one whose model has the highest
 * output price; ties, and models without a known price, go to the lowest seat number.
 * `outputPrice` returns USD per million output tokens from the model registry, or null.
 */
export function defaultLead(models: { provider: string; id: string }[], outputPrice: (m: { provider: string; id: string }) => number | null): number {
  let best = 1;
  let bestPrice = -Infinity;
  models.forEach((m, i) => {
    const p = outputPrice(m);
    if (typeof p === "number" && Number.isFinite(p) && p > bestPrice) {
      bestPrice = p;
      best = i + 1;
    }
  });
  return best;
}

/** A swarm block from the launch form's seat rows; the lead is `lead` (a seat number). */
export function buildSwarm(rows: { name: string; model: { provider: string; id: string } }[], lead: number): SoulSwarm {
  return { v: SWARM_V, members: rows.map((r, i) => ({ seat: i + 1, name: r.name.trim(), role: i + 1 === lead ? "lead" : "builder", model: { provider: r.model.provider, id: r.model.id } })) };
}

/** Default seat names: the swarm's name with a number ("Wren 1", "Wren 2"), cut to the name limit. */
export function defaultSeatNames(base: string, n: number): string[] {
  const b = (base.trim() || "Agent").replace(/[^\p{L}\p{N} .'-]/gu, "").trim() || "Agent";
  return Array.from({ length: n }, (_, i) => `${b.slice(0, SEAT_NAME_MAX - String(i + 1).length - 1).trim()} ${i + 1}`);
}

/**
 * The fixed paragraph a seat's role adds to its prompt (docs/plans/SWARMS.md 3), versioned with the
 * proposer's prompt version. Everything else in the prompt is identical for every seat.
 */
export const ROLE_PARAGRAPHS: Record<SeatRole, string> = {
  lead: "You are the lead of a group of agents that work on this repository at the same time under one name. Each of you has a different target; yours is the one named below. Work on that target only: another agent has every other one, and a change outside your target can collide with theirs.",
  builder: "You are one of a group of agents that work on this repository at the same time under one name. Each of you has a different target; yours is the one named below, assigned by the group's lead. Work on that target only: another agent has every other one, and a change outside your target can collide with theirs.",
};
