// Commit messages of mirror commits (SPEC 16, identity plan 2.3.2). Built only from fields that are
// fixed once a generation is accepted (and the soul version stored at acceptance), so a rebuild of
// the same generation always yields the same message, hence the same signed commit.

import type { GenerationView, SoulAt } from "./coreapi.ts";
import { brandNeutralTrailers } from "../../protocol/src/trailers.ts";

export interface MessageInput {
  gen: GenerationView;
  lineage_id: string;
  recipe: string;
  /** public site base for links, e.g. https://example.org (no trailing slash) */
  site: string;
  soul: SoulAt | null;
  /** for a revert entry: the generation it reverts */
  reverted?: GenerationView | null;
  /** "account" (the agent's own GitHub account) or "app" (fallback identity) */
  identity: "account" | "app";
}

const fmt = (x: number) => x.toFixed(6);
const short = (h: string) => h.slice(0, 12);
const targetText = (t: string | string[] | null) => (t === null ? "none" : Array.isArray(t) ? t.join(", ") : t);

function effectLines(g: GenerationView): string[] {
  const e = g.effect;
  const n = g.replay_ids?.length ?? 0;
  if (!e) return [`Measured effect: none recorded (${n} counted replays).`];
  const pct = (1 - e.ratio) * 100;
  return [
    `Measured effect: ${e.metric} ratio ${fmt(e.ratio)} (candidate / parent), interval ${fmt(e.ci_low)} to ${fmt(e.ci_high)}, ${pct >= 0 ? `${pct.toFixed(2)}% lower` : `${(-pct).toFixed(2)}% higher`}, over ${n} counted replays.`,
  ];
}

export function commitMessage(m: MessageInput): string {
  const g = m.gen;
  const lines: string[] = [];
  if (g.entry_type === "revert") {
    const r = m.reverted;
    lines.push(`Revert lineage gen ${r?.height ?? "?"} on ${m.recipe}: ${r?.kind ?? "change"} ${targetText(r?.target ?? null)}`);
    lines.push("");
    lines.push(`An audit reverted generation ${g.reverts} (verdict ${g.verdict_digest ?? "unknown"}). This commit restores the tree Core serves without it (SPEC 11.3).`);
  } else {
    const e = g.effect;
    const head = e ? `${e.metric} ratio ${e.ratio.toFixed(4)}` : targetText(g.target);
    lines.push(`${g.kind ?? "change"} ${targetText(g.target)} on ${m.recipe}: ${head} (lineage gen ${g.height})`);
    lines.push("");
    if (m.soul) lines.push(`${m.soul.name}: ${m.soul.tagline}`, "");
    lines.push(...effectLines(g));
    if (g.replay_ids?.length) lines.push(`Replays: ${g.replay_ids.map(short).join(", ")}`);
  }
  lines.push(`Generation: ${m.site}/generations/${g.gen_id}`);
  if (g.candidate_id) lines.push(`Candidate and replay transcripts: ${m.site}/candidates/${g.candidate_id}`);
  if (m.identity === "app") lines.push("", "Published under the Lineage app identity: the authoring agent has no GitHub account of its own.");
  lines.push("");
  // trailers (docs/plans/GENERATIONS-ON-GITHUB.md 2): what verify-generation and Core check
  const trailers = [`Lineage-Generation: ${g.gen_id}`, `Lineage-Lineage: ${m.lineage_id}`, `Lineage-Height: ${g.height}`];
  if (g.patch_hash) trailers.push(`Lineage-Patch-Sha256: ${g.patch_hash}`);
  if (g.verdict_digest) trailers.push(`Lineage-Verdict: ${g.verdict_digest}`);
  trailers.push(`Lineage-Agent: ${g.author ?? "none"}`, `Lineage-Url: ${m.site}/generations/${g.gen_id}`);
  if (g.reverts) trailers.push(`Lineage-Reverts: ${g.reverts}`);
  if (g.team?.members?.length) trailers.push(`Lineage-Team: ${g.team.members.map((x) => x.agent).join(", ")}`);
  if (m.soul) trailers.push(`Lineage-Soul: ${m.soul.digest}`);
  trailers.push(`Lineage-Identity: ${m.identity}`);
  lines.push(...trailers);
  return lines.join("\n") + "\n";
}

/** Branch of a lineage on an agent's fork: lineage/<recipe>-<first 8 hex of the lineage id>. */
export function lineageBranch(recipe: string, lineageId: string): string {
  const safe = recipe.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "recipe";
  return `lineage/${safe}-${lineageId.slice(0, 8)}`;
}

/** Branch of the one upstream PR of a generation, on the agent's fork. */
export function prBranch(genId: string): string {
  return `lineage/pr-${genId.slice(0, 12)}`;
}

/** The `Lineage-*` trailers of a commit message (last paragraph, `Key: value` lines). */
export function parseTrailers(message: string): Record<string, string> {
  const paras = message.replace(/\r/g, "").trimEnd().split(/\n\s*\n/);
  const out: Record<string, string> = {};
  for (const line of (paras[paras.length - 1] ?? "").split("\n")) {
    const m = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line.trim());
    if (m && !(m[1]! in out)) out[m[1]!] = m[2]!.trim();
  }
  return brandNeutralTrailers(out);
}
