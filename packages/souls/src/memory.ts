// Soul memory (SPEC 14.8): what the agent actually did, folded in at epoch close from its final
// reputation records and contribution leaves (SPEC 14.6). Every entry is a pure function of one leaf,
// so Core recomputes each entry and refuses a version whose memory says anything its records do not.
// Records hold only final work, so nothing about an open candidate can reach a soul (SPEC 10.7).

import { canonicalJson } from "@lineage/protocol";
import type { MemoryEntry, SoulDoc, SoulMemory } from "./schema.ts";
import { LIMITS } from "./schema.ts";

/** The leaf shapes of `GET /v1/agents/:id/records` (packages/core/src/records.ts). */
export interface RecordsEpoch {
  epoch: number;
  record_root?: string;
  leaves: RecordsLeaf[];
}
export type RecordsLeaf =
  | { kind: "record"; leaf: string; record: AuthorRec | VerifierRec }
  | { kind: "contribution"; leaf: string; contribution: ContributionRec };

interface AuthorRec {
  role: "author";
  epoch: number;
  agent: string;
  lineage_id: string;
  candidates: { final: number; revealed: number; accepted: number; rejected: number; expired: number };
  rejections: Record<string, number>;
  accepted: { gen_id: string; kind: string; target: unknown; effect: unknown }[];
  reverted: string[];
  audits: Record<string, number>;
}
interface VerifierRec {
  role: "verifier";
  epoch: number;
  agent: string;
  replays: Record<string, number>;
  canaries: { caught: number; accepted: number };
  strikes: Record<string, number>;
  replay_units: number;
}
interface ContributionRec {
  epoch: number;
  gen_id: string;
  lineage_id: string;
  members: { agent: string; role: string; share_bps: number }[];
  finder: string | null;
}

const short = (s: string) => s.slice(0, 8);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const sorted = (m: Record<string, number>) => Object.entries(m).filter(([, v]) => v > 0).sort(([a], [b]) => a.localeCompare(b));
const targetText = (t: unknown) => (Array.isArray(t) ? t.join(",") : String(t));

/** The memory entries one leaf yields for `agent` (zero, one or two). Deterministic. */
export function entriesFromLeaf(agent: string, epoch: number, l: RecordsLeaf): MemoryEntry[] {
  if (l.kind === "record" && l.record.role === "author") {
    const r = l.record;
    const c = r.candidates;
    const reasons = sorted(r.rejections);
    const out: MemoryEntry[] = [];
    const kind: MemoryEntry["kind"] = c.accepted > 0 ? "accepted" : c.rejected > 0 ? "rejected" : "authored";
    const facts: Record<string, string | number> = { final: c.final, accepted: c.accepted, rejected: c.rejected, expired: c.expired };
    if (r.accepted.length) facts.generations = r.accepted.map((g) => g.gen_id).join(",");
    if (reasons.length) facts.reasons = reasons.map(([k, v]) => `${k}:${v}`).join(",");
    const acc = r.accepted.length ? `; accepted ${r.accepted.map((g) => `${g.kind} ${targetText(g.target)}`).join(", ")}` : "";
    const why = reasons.length ? `; rejected for ${reasons.map(([k, v]) => `${k} (${v})`).join(", ")}` : "";
    out.push({ epoch, leaf: l.leaf, kind, lineage_id: r.lineage_id, summary: clip(`Epoch ${epoch}, lineage ${short(r.lineage_id)}: ${plural(c.final, "final candidate")}, ${c.accepted} accepted${acc}${why}.`), facts });
    if (r.reverted.length)
      out.push({ epoch, leaf: l.leaf, kind: "reverted", lineage_id: r.lineage_id, summary: clip(`Epoch ${epoch}: ${plural(r.reverted.length, "generation")} of mine reverted (${r.reverted.map(short).join(", ")}).`), facts: { reverted: r.reverted.join(",") } });
    return out;
  }
  if (l.kind === "record" && l.record.role === "verifier") {
    const r = l.record;
    const counted = r.replays.counted ?? 0;
    const strikes = Object.values(r.strikes).reduce((a, b) => a + b, 0);
    return [{ epoch, leaf: l.leaf, kind: "verified", lineage_id: null, summary: clip(`Epoch ${epoch}: ${plural(counted, "counted replay")}, ${plural(r.canaries.caught, "canary")} caught, ${plural(strikes, "strike")}.`),
      facts: { counted, caught: r.canaries.caught, strikes } }];
  }
  if (l.kind === "contribution") {
    const c = l.contribution;
    const me = c.members.find((m) => m.agent === agent);
    const others = c.members.filter((m) => m.agent !== agent);
    if (me && others.length)
      return [{ epoch, leaf: l.leaf, kind: "team", lineage_id: c.lineage_id, summary: clip(`Epoch ${epoch}: co-authored generation ${short(c.gen_id)} with ${others.map((m) => short(m.agent)).join(", ")}, my share ${me.share_bps / 100}%.`),
        facts: { gen_id: c.gen_id, share_bps: me.share_bps, partners: others.map((m) => m.agent).join(",") } }];
    if (!me && c.finder === agent)
      return [{ epoch, leaf: l.leaf, kind: "team", lineage_id: c.lineage_id, summary: clip(`Epoch ${epoch}: credited as finder of generation ${short(c.gen_id)}.`), facts: { gen_id: c.gen_id, role: "finder" } }];
  }
  return [];
}

function clip(s: string): string {
  return s.length <= LIMITS.summary ? s : s.slice(0, LIMITS.summary - 3) + "...";
}

/** Every entry the agent's records support, oldest first. */
export function deriveEntries(agent: string, epochs: RecordsEpoch[]): MemoryEntry[] {
  return [...epochs].sort((a, b) => a.epoch - b.epoch).flatMap((e) => e.leaves.flatMap((l) => entriesFromLeaf(agent, e.epoch, l)));
}

/** The memory a version should carry after folding in records through `throughEpoch` (newest entries kept). */
export function foldMemory(agent: string, epochs: RecordsEpoch[], throughEpoch: number | null, reflection: string | null = null): SoulMemory {
  const usable = throughEpoch === null ? [] : epochs.filter((e) => e.epoch <= throughEpoch);
  const entries = deriveEntries(agent, usable).slice(-LIMITS.memory_entries);
  return { through_epoch: throughEpoch, entries, reflection };
}

/** True when the doc's memory has something new to say compared with `epochs` (a version is worth signing). */
export function memoryChanged(doc: SoulDoc, next: SoulMemory): boolean {
  return canonicalJson(doc.memory.entries) !== canonicalJson(next.entries) || doc.memory.reflection !== next.reflection;
}

/**
 * Core's check: each entry must be exactly what its leaf yields, the leaf must be the agent's, and
 * `through_epoch` may not run ahead of the newest closed epoch. Returns problems, empty when sound.
 */
export function checkMemory(agent: string, memory: SoulMemory, epochs: RecordsEpoch[], lastClosedEpoch: number | null): string[] {
  const errs: string[] = [];
  if (memory.through_epoch !== null && (lastClosedEpoch === null || memory.through_epoch > lastClosedEpoch)) errs.push(`memory.through_epoch ${memory.through_epoch} is after the last closed epoch`);
  const truth = new Map(deriveEntries(agent, epochs).map((e) => [`${e.leaf}:${e.kind}`, canonicalJson(e)]));
  memory.entries.forEach((e, i) => {
    const want = truth.get(`${e.leaf}:${e.kind}`);
    if (!want) errs.push(`memory.entries[${i}]: no ${e.kind} record leaf ${e.leaf.slice(0, 12)} for this agent`);
    else if (want !== canonicalJson(e)) errs.push(`memory.entries[${i}]: does not match its record leaf`);
    else if (memory.through_epoch === null || e.epoch > memory.through_epoch) errs.push(`memory.entries[${i}]: epoch ${e.epoch} is after through_epoch`);
  });
  return errs;
}
