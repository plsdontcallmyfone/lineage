import { createHash } from "node:crypto";
import type { Core } from "./core.ts";
import { bad } from "./errors.ts";
import { hiddenOf } from "./hidden.ts";
import { learningsOf } from "./learnings.ts";

// Shared findings (docs/plans/AGENT-LEARNINGS.md 12). One view over every listed agent's published
// episodes (docs/plans/AGENT-LEARNINGS.md), organised by unit (lineage) and target, with lessons
// distilled deterministically from measured facts: what was accepted with what effect, what failed
// and why (the verdict's reason and what the replays measured), what ended without a candidate.
//
// Two readers use it:
// - the organisation dump units-agents/findings (packages/identity/src/findings-dump.ts), via
//   GET /v1/learnings/units, next to the episodes themselves (GET /v1/learnings/episodes);
// - the worker, via GET /v1/learnings/shared?lineage=&target=: the top relevant items for its unit
//   and target before each attempt (packages/worker/src/shared-findings.ts).
//
// Sealing: everything here is read from published episodes only (learnings.ts: an episode exists
// once its candidate is final and every candidate its agent had open by then is final too), and an
// item is kept only when its own candidate is final. Hidden test launches are left out, as in every
// listing. Nothing here is a model's output except the quoted `idea` lines (the agent's own submit
// rationale, published with its final episode), which are labelled as claimed.

export const SHARED_SCHEMA_ID = "units-findings/1";

export const SHARED_LIMITS = {
  /** characters of an agent's own description of its idea (its submit rationale) */
  idea_chars: 180,
  /** files listed per item */
  files: 6,
  /** worked and failed items kept per target in the unit view (the newest) */
  per_target: 25,
  /** items served to a worker by default and at most */
  items_default: 12,
  items_max: 40,
};

const FINAL = new Set(["accepted", "rejected", "expired"]);
const OUTCOMES = new Set(["accepted", "rejected", "expired", "no_candidate", "abandoned"]);
const HEX64 = /^[0-9a-f]{64}$/;
const AGENT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EM_DASH = /\u2014/g;
const HAS_EM_DASH = /\u2014/;
const CTRL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

const clean = (s: string) => s.replace(EM_DASH, "-").replace(CTRL, " ");

/** "kind:target" (a list target joined with commas), or "none"; the same key the per-agent lessons use. */
export function targetKey(t: { kind?: unknown; target?: unknown } | null | undefined): string {
  if (!t || typeof t.kind !== "string") return "none";
  const name = Array.isArray(t.target) ? t.target.map(String).join(",") : String(t.target ?? "");
  return `${t.kind}:${name}`;
}

/** A path segment: letters, digits, dot, plus, dash, underscore; long or rewritten names keep a short hash. */
export function slug(s: string, max = 80): string {
  const base = s.replace(/[^A-Za-z0-9._+-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").replace(/-{2,}/g, "-") || "x";
  if (base.length <= max) return base;
  const h = createHash("sha256").update(s).digest("hex").slice(0, 8);
  return `${base.slice(0, max - 9)}-${h}`;
}

/** findings/<unit>: the recipe name and the lineage id's first 8 characters (stable per lineage). */
export function unitSlug(recipeName: string | null | undefined, lineageId: string): string {
  return `${slug(recipeName || "unit", 60)}-${lineageId.slice(0, 8)}`;
}

/** findings/<unit>/<target>: "perf-encode_ir", list targets joined with "+", "none" for no target. */
export function targetSlug(key: string): string {
  if (key === "none") return "none";
  const i = key.indexOf(":");
  return slug(`${key.slice(0, i)}-${key.slice(i + 1).replace(/,/g, "+")}`);
}

/** The files a unified patch changes. */
export function filesOf(patch: string | null | undefined): string[] {
  if (!patch) return [];
  return [...new Set(patch.split("\n").filter((l) => l.startsWith("+++ b/")).map((l) => l.slice(6).trim()))].sort();
}

/** The agent's own description of what it tried (its submit rationale), one line, clipped. Claimed. */
export function ideaOf(ep: any): string | null {
  const sub = (ep.actions ?? []).filter((a: any) => a?.kind === "submit" && typeof a.reason === "string").at(-1);
  const g = (ep.actions ?? []).filter((a: any) => a?.kind === "give_up" && typeof a.reason === "string").at(-1);
  const raw = sub?.reason ?? (ep.candidate ? null : g?.reason) ?? null;
  if (!raw) return null;
  const one = clean(String(raw)).replace(/\s+/g, " ").trim();
  return one.length <= SHARED_LIMITS.idea_chars ? one : `${one.slice(0, SHARED_LIMITS.idea_chars - 3).trimEnd()}...`;
}

/** Sealing filter: a known outcome, and a candidate (when there is one) that is final. */
export function isFinalEpisode(ep: any): boolean {
  if (!ep || !OUTCOMES.has(ep.outcome)) return false;
  if (ep.candidate && !FINAL.has(ep.candidate.status)) return false;
  if (ep.outcome !== "no_candidate" && ep.outcome !== "abandoned" && !ep.candidate) return false;
  return true;
}

export interface Who {
  id: string;
  name: string | null;
}

export interface WorkedItem {
  episode_id: string;
  agent: Who;
  gen_id: string | null;
  height: number | null;
  parent_gen_id: string;
  parent_height: number | null;
  effect: { metric: string; ratio: number; gain_pct: number } | { fixed: number } | null;
  files: string[];
  idea: string | null;
  finalized_at: number | null;
  reverted: boolean;
}

export interface FailedItem {
  episode_id: string;
  agent: Who;
  outcome: "rejected" | "expired";
  /** the candidate's reason (what Core recorded), and the verdict's own reason and detail when they differ */
  reason: string;
  verdict_reason: string | null;
  detail: string | null;
  /** what the counted replays measured, when they did (a rejected candidate keeps its effect) */
  measured: { metric: string; ratio: number; gain_pct: number } | null;
  parent_gen_id: string;
  parent_height: number | null;
  files: string[];
  idea: string | null;
  finalized_at: number | null;
}

export interface TargetFindings {
  key: string;
  slug: string;
  kind: string | null;
  target: string | string[] | null;
  attempts: number;
  outcomes: Record<string, number>;
  agents: Who[];
  worked: WorkedItem[];
  failed: FailedItem[];
  /** attempts that ended without a candidate (gave up, no change, or abandoned), by agent */
  no_candidate: { count: number; agents: Record<string, number>; last_at: number | null };
  best: { episode_id: string; agent: Who; metric: string; ratio: number; gain_pct: number } | null;
  rejection_reasons: Record<string, number>;
  median_usd: number | null;
  usd_known: number;
  lessons: string[];
  last_at: number;
}

export interface UnitFindings {
  lineage_id: string;
  slug: string;
  recipe: { recipe_id?: string; name: string | null; class: string | null; repo: string; commit: string };
  tip: { gen_id: string; height: number } | null;
  attempts: number;
  outcomes: Record<string, number>;
  agents: (Who & { attempts: number; accepted: number })[];
  targets: TargetFindings[];
  license: any;
  attribution: string | null;
  first_seq: number;
  last_seq: number;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const pct = (x: number) => `${x.toFixed(2)}%`;
const who = (a: Who) => `${a.name ?? "agent"} (${a.id.slice(0, 8)})`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** The lessons of one target: plain sentences built only from the counts and measurements above. */
export function lessonsOf(t: Omit<TargetFindings, "lessons">): string[] {
  const out: string[] = [];
  const counts = Object.entries(t.outcomes).map(([k, v]) => `${v} ${k.replace("_", " ")}`).join(", ");
  out.push(`${plural(t.attempts, "attempt")} by ${plural(t.agents.length, "agent")} (${counts}).`);
  if (t.best) out.push(`Best accepted effect: ${pct(t.best.gain_pct)} on ${t.best.metric} (ratio ${t.best.ratio.toFixed(4)}) by ${who(t.best.agent)}.`);
  const fixes = t.worked.filter((w) => w.effect && "fixed" in w.effect);
  if (fixes.length) out.push(`${plural(fixes.length, "accepted fix")} (${fixes.map((w) => `${(w.effect as { fixed: number }).fixed} tests`).join(", ")}).`);
  const files = new Map<string, number>();
  for (const w of t.worked) for (const f of w.files) files.set(f, (files.get(f) ?? 0) + 1);
  if (files.size) out.push(`Accepted changes touched ${[...files].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([f, n]) => `${f} (${n})`).join(", ")}.`);
  const rs = Object.entries(t.rejection_reasons).sort((a, b) => b[1] - a[1]);
  if (rs.length) out.push(`Failed candidates: ${rs.map(([k, v]) => `${k} ${v}`).join(", ")}.`);
  const below = t.failed.filter((f) => f.measured && f.reason === "no_improvement");
  if (below.length) out.push(`Measured but below the minimum effect: ${below.slice(0, 4).map((f) => `${pct(f.measured!.gain_pct)} on ${f.measured!.metric}`).join(", ")}.`);
  const staleMeasured = t.failed.filter((f) => f.measured && f.measured.ratio < 1 && f.reason !== "no_improvement");
  if (staleMeasured.length) out.push(`Measured an improvement but still failed (${[...new Set(staleMeasured.map((f) => f.reason))].join(", ")}): ${staleMeasured.slice(0, 4).map((f) => `${pct(f.measured!.gain_pct)} on ${f.measured!.metric}`).join(", ")}; another candidate landed on the same parent first.`);
  const conflicts = t.failed.filter((f) => ["stale_conflict", "apply_conflict", "dependency_failed", "stale"].includes(f.reason)).length;
  if (conflicts) out.push(`${plural(conflicts, "candidate")} failed because the parent moved under them (stale or conflicting with a newer generation).`);
  if (t.no_candidate.count) out.push(`${plural(t.no_candidate.count, "attempt")} ended without a candidate.`);
  if (t.median_usd !== null && t.usd_known) out.push(`Median model spend per attempt: ${t.median_usd.toFixed(4)} USD over ${plural(t.usd_known, "attempt")} with a recorded cost.`);
  return out;
}

/**
 * Distils published episodes into units and targets. Deterministic: the same episodes give the
 * same output. `heights` maps generation ids to heights, `tips` lineages to their current tip.
 */
export function distillUnits(episodes: any[], o: { heights?: Map<string, number>; tips?: Map<string, { gen_id: string; height: number }> } = {}): UnitFindings[] {
  const byUnit = new Map<string, any[]>();
  for (const e of episodes) {
    if (!isFinalEpisode(e) || !HEX64.test(e?.task?.lineage_id ?? "")) continue;
    byUnit.set(e.task.lineage_id, [...(byUnit.get(e.task.lineage_id) ?? []), e]);
  }
  const units: UnitFindings[] = [];
  for (const [lineage, eps] of byUnit) {
    eps.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const first = eps[0];
    const agentsOf = new Map<string, Who & { attempts: number; accepted: number }>();
    const outcomes: Record<string, number> = {};
    const targets = new Map<string, any[]>();
    for (const e of eps) {
      const a = agentsOf.get(e.agent.id) ?? { id: e.agent.id, name: e.agent.name ?? null, attempts: 0, accepted: 0 };
      a.attempts++;
      if (e.outcome === "accepted") a.accepted++;
      if (!a.name && e.agent.name) a.name = e.agent.name;
      agentsOf.set(e.agent.id, a);
      outcomes[e.outcome] = (outcomes[e.outcome] ?? 0) + 1;
      const k = targetKey(e.task.target);
      targets.set(k, [...(targets.get(k) ?? []), e]);
    }
    const name = (id: string): Who => ({ id, name: agentsOf.get(id)?.name ?? null });
    const per: TargetFindings[] = [];
    for (const [key, list] of targets) {
      const t0 = list.find((e) => e.task.target)?.task.target ?? null;
      const worked: WorkedItem[] = [];
      const failed: FailedItem[] = [];
      const nc = { count: 0, agents: {} as Record<string, number>, last_at: null as number | null };
      const tOutcomes: Record<string, number> = {};
      const reasons: Record<string, number> = {};
      const usd: number[] = [];
      const tAgents = new Set<string>();
      let last = 0;
      for (const e of list) {
        tAgents.add(e.agent.id);
        tOutcomes[e.outcome] = (tOutcomes[e.outcome] ?? 0) + 1;
        if (typeof e.cost?.usd === "number") usd.push(e.cost.usd);
        const at = e.candidate?.finalized_at ?? e.times?.ended_at ?? e.times?.started_at ?? 0;
        last = Math.max(last, at);
        const files = filesOf(e.candidate?.patch).slice(0, SHARED_LIMITS.files);
        if (e.outcome === "accepted") {
          const ef = e.effect && "ratio" in e.effect ? { metric: String(e.effect.metric), ratio: e.effect.ratio, gain_pct: e.effect.gain_pct } : e.effect && "fixed" in e.effect ? { fixed: (e.effect.fixed ?? []).length } : null;
          const gen = e.candidate?.gen_id ?? null;
          worked.push({
            episode_id: e.episode_id, agent: name(e.agent.id), gen_id: gen, height: gen ? (o.heights?.get(gen) ?? null) : null, parent_gen_id: e.task.parent_gen_id, parent_height: e.task.parent_height ?? null,
            effect: ef, files, idea: ideaOf(e), finalized_at: e.candidate?.finalized_at ?? null, reverted: !!e.reward?.reverted,
          });
        } else if (e.outcome === "rejected" || e.outcome === "expired") {
          const reason = String(e.candidate?.reason ?? e.verdict?.reason ?? e.outcome);
          reasons[reason] = (reasons[reason] ?? 0) + 1;
          const ve = e.verdict?.effect;
          failed.push({
            episode_id: e.episode_id, agent: name(e.agent.id), outcome: e.outcome, reason,
            verdict_reason: e.verdict?.reason && e.verdict.reason !== reason ? String(e.verdict.reason) : null,
            detail: typeof e.verdict?.detail === "string" ? clean(e.verdict.detail).slice(0, 200) : null,
            measured: ve && typeof ve.ratio === "number" ? { metric: String(ve.metric), ratio: ve.ratio, gain_pct: (1 - ve.ratio) * 100 } : null,
            parent_gen_id: e.task.parent_gen_id, parent_height: e.task.parent_height ?? null, files, idea: ideaOf(e), finalized_at: e.candidate?.finalized_at ?? null,
          });
        } else {
          nc.count++;
          nc.agents[e.agent.id] = (nc.agents[e.agent.id] ?? 0) + 1;
          nc.last_at = Math.max(nc.last_at ?? 0, at);
        }
      }
      const byNewest = (a: { finalized_at: number | null }, b: { finalized_at: number | null }) => (b.finalized_at ?? 0) - (a.finalized_at ?? 0);
      worked.sort(byNewest);
      failed.sort(byNewest);
      const metricWins = worked.filter((w) => w.effect && "ratio" in w.effect && !w.reverted).sort((a, b) => (b.effect as any).gain_pct - (a.effect as any).gain_pct);
      const b0 = metricWins[0];
      const base = {
        key, slug: targetSlug(key), kind: t0?.kind ?? null, target: t0 ? (t0.target ?? null) : null, attempts: list.length, outcomes: tOutcomes,
        agents: [...tAgents].sort().map(name), worked: worked.slice(0, SHARED_LIMITS.per_target), failed: failed.slice(0, SHARED_LIMITS.per_target), no_candidate: nc,
        best: b0 ? { episode_id: b0.episode_id, agent: b0.agent, metric: (b0.effect as any).metric, ratio: (b0.effect as any).ratio, gain_pct: (b0.effect as any).gain_pct } : null,
        rejection_reasons: reasons, median_usd: median(usd), usd_known: usd.length, last_at: last,
      };
      per.push({ ...base, lessons: lessonsOf(base) });
    }
    per.sort((a, b) => b.attempts - a.attempts || a.key.localeCompare(b.key));
    units.push({
      lineage_id: lineage, slug: unitSlug(first.task.recipe?.name, lineage), recipe: first.task.recipe, tip: o.tips?.get(lineage) ?? null, attempts: eps.length, outcomes,
      agents: [...agentsOf.values()].sort((a, b) => b.attempts - a.attempts || a.id.localeCompare(b.id)), targets: per, license: first.license ?? null, attribution: first.attribution ?? null,
      first_seq: first.seq ?? 0, last_seq: eps.at(-1).seq ?? 0,
    });
  }
  units.sort((a, b) => b.attempts - a.attempts || a.lineage_id.localeCompare(b.lineage_id));
  return units;
}

// ------------------------------------------------------------------------------------------------
// items for a worker (GET /v1/learnings/shared)

export interface SharedItem {
  kind: "accepted" | "failed" | "no_candidate";
  target: string;
  episode_id: string | null;
  agent: Who | null;
  /** accepted: the generation it became; failed: the parent it was built on */
  gen_id: string | null;
  height: number | null;
  parent_height: number | null;
  /** built on the lineage's current tip */
  on_tip: boolean;
  effect: WorkedItem["effect"] | null;
  reason: string | null;
  detail: string | null;
  files: string[];
  idea: string | null;
  count: number;
  at: number | null;
}

/** The items for one unit, most relevant first: the asked target, then the current tip, then the newest. */
export function sharedItems(u: UnitFindings, o: { target?: string | null; limit?: number } = {}): SharedItem[] {
  const tip = u.tip?.gen_id ?? null;
  const items: (SharedItem & { score: number })[] = [];
  for (const t of u.targets) {
    const match = !!o.target && t.key === o.target;
    for (const w of t.worked) {
      items.push({ kind: "accepted", target: t.key, episode_id: w.episode_id, agent: w.agent, gen_id: w.gen_id, height: w.height, parent_height: w.parent_height, on_tip: !!tip && w.gen_id === tip, effect: w.effect, reason: w.reverted ? "reverted later" : null, detail: null, files: w.files, idea: w.idea, count: 1, at: w.finalized_at, score: (match ? 4 : 0) + (tip && w.gen_id === tip ? 2 : 0) });
    }
    for (const f of t.failed) {
      const onTip = !!tip && f.parent_gen_id === tip;
      items.push({ kind: "failed", target: t.key, episode_id: f.episode_id, agent: f.agent, gen_id: f.parent_gen_id, height: f.parent_height, parent_height: f.parent_height, on_tip: onTip, effect: f.measured, reason: f.verdict_reason ? `${f.reason} (${f.verdict_reason})` : f.reason, detail: f.detail, files: f.files, idea: f.idea, count: 1, at: f.finalized_at, score: (match ? 4 : 0) + (onTip ? 3 : 0) });
    }
    if (t.no_candidate.count && t.key !== "none") items.push({ kind: "no_candidate", target: t.key, episode_id: null, agent: null, gen_id: null, height: null, parent_height: null, on_tip: false, effect: null, reason: null, detail: null, files: [], idea: null, count: t.no_candidate.count, at: t.no_candidate.last_at, score: match ? 1 : 0 });
  }
  items.sort((a, b) => b.score - a.score || (b.at ?? 0) - (a.at ?? 0) || (a.episode_id ?? "").localeCompare(b.episode_id ?? ""));
  const n = Math.max(1, Math.min(o.limit ?? SHARED_LIMITS.items_default, SHARED_LIMITS.items_max));
  return items.slice(0, n).map(({ score: _s, ...x }) => x);
}

// ------------------------------------------------------------------------------------------------
// the module

const instances = new WeakMap<Core, SharedFindings>();
export function sharedFindingsOf(core: Core): SharedFindings {
  let s = instances.get(core);
  if (!s) instances.set(core, (s = new SharedFindings(core)));
  return s;
}

export class SharedFindings {
  /** distilled views by query and state (newest seq, hidden list, generations); small, recomputed on change */
  private cache = new Map<string, UnitFindings[]>();
  constructor(private readonly core: Core) {}

  private get db() {
    return (this.core as unknown as { db: Core["db"] }).db;
  }

  /** Published episodes of listed agents (hidden test launches left out), at most `until` when given. */
  private episodes(o: { lineage?: string; until?: number }): any[] {
    const off = hiddenOf(this.core).agents();
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (o.lineage) (where.push("lineage_id = ?"), args.push(o.lineage));
    if (o.until !== undefined) (where.push("seq <= ?"), args.push(o.until));
    const rows = this.db.query<{ seq: number; agent: string; json: string }, (string | number)[]>(`SELECT seq, agent, json FROM learnings_episodes${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY seq`).all(...args);
    const out: any[] = [];
    for (const r of rows) {
      if (off.has(r.agent)) continue;
      const e = JSON.parse(r.json);
      e.seq = r.seq;
      out.push(e);
    }
    return out;
  }

  private context(lineages: string[]) {
    const heights = new Map<string, number>();
    for (const r of this.db.query<{ gen_id: string; height: number }, []>("SELECT gen_id, height FROM generations").all()) heights.set(r.gen_id, r.height);
    const tips = new Map<string, { gen_id: string; height: number }>();
    const q = this.db.query<{ gen_id: string; height: number }, [string]>("SELECT g.gen_id AS gen_id, g.height AS height FROM lineages l JOIN generations g ON g.gen_id = l.tip WHERE l.lineage_id = ?");
    for (const l of lineages) {
      const t = q.get(l);
      if (t) tips.set(l, t);
    }
    return { heights, tips };
  }

  /** GET /v1/learnings/units?lineage=&until= */
  units(q: { lineage?: string; until?: number } = {}) {
    learningsOf(this.core).sweep();
    if (q.lineage !== undefined && !HEX64.test(q.lineage)) throw bad("bad_query", "lineage must be 64 hex");
    if (q.until !== undefined && !(Number.isSafeInteger(q.until) && q.until >= 0)) throw bad("bad_query", "until must be a seq");
    const last = this.db.query<{ s: number | null }, []>("SELECT MAX(seq) AS s FROM learnings_episodes").get()?.s ?? 0;
    const hidden = [...hiddenOf(this.core).agents().keys()].sort().join(",");
    const gens = this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM generations").get()?.n ?? 0;
    const key = `${q.lineage ?? "*"}|${q.until ?? "-"}|${last}|${hidden}|${gens}`;
    let units = this.cache.get(key);
    if (!units) {
      const eps = this.episodes(q);
      const ctx = this.context([...new Set(eps.map((e) => e.task.lineage_id as string))]);
      units = distillUnits(eps, ctx);
      if (this.cache.size >= 64) this.cache.clear();
      this.cache.set(key, units);
    }
    return { schema: SHARED_SCHEMA_ID, last_seq: q.until !== undefined ? Math.min(q.until, last) : last, units };
  }

  /** GET /v1/learnings/shared?lineage=&target=&agent=&limit=: the items a worker reads before an attempt. */
  shared(q: { lineage?: string; target?: string; agent?: string; limit?: number }) {
    if (!q.lineage || !HEX64.test(q.lineage)) throw bad("bad_query", "lineage must be 64 hex");
    if (q.agent !== undefined && !AGENT.test(q.agent)) throw bad("bad_query", "agent must be an agent id");
    if (q.target !== undefined && (q.target.length > 300 || !/^[a-z]+:.+$/.test(q.target))) throw bad("bad_query", "target must be kind:name");
    if (q.limit !== undefined && !(Number.isSafeInteger(q.limit) && q.limit >= 1 && q.limit <= SHARED_LIMITS.items_max)) throw bad("bad_query", `limit must be 1..${SHARED_LIMITS.items_max}`);
    const { units, last_seq } = this.units({ lineage: q.lineage });
    const u = units[0];
    if (!u) return { schema: SHARED_SCHEMA_ID, lineage_id: q.lineage, unit: null, tip: null, last_seq, items: [] };
    return {
      schema: SHARED_SCHEMA_ID, lineage_id: q.lineage, unit: { slug: u.slug, recipe: u.recipe.name, attempts: u.attempts, agents: u.agents.length }, tip: u.tip, last_seq,
      items: sharedItems(u, { target: q.target ?? null, limit: q.limit }),
      source: "published episodes of listed agents (GET /v1/learnings/episodes); outcomes and effects measured by independent replays; idea lines are the agents' own words",
    };
  }
}

// ------------------------------------------------------------------------------------------------
// the dump's publication record (the identity service, runtime key)

export const DUMP_SCHEMA = `
  CREATE TABLE IF NOT EXISTS findings_dump (
    id TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    reported_at INTEGER NOT NULL,
    reported_by TEXT NOT NULL
  );
`;

/** POST /v1/learnings/dump { repo, url, commit, verified, episodes, units, last_seq, status, reason } */
export function recordDump(core: Core, by: string, body: unknown, now: number) {
  const db = (core as unknown as { db: Core["db"] }).db;
  db.exec(DUMP_SCHEMA);
  const b = body as Record<string, unknown>;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw bad("bad_dump", "body must be an object");
  const str = (k: string) => (b[k] === undefined || b[k] === null ? null : typeof b[k] === "string" && (b[k] as string).length <= 300 && !HAS_EM_DASH.test(b[k] as string) ? (b[k] as string) : (() => { throw bad("bad_dump", `${k} must be a short string`); })());
  const num = (k: string) => (b[k] === undefined || b[k] === null ? null : Number.isSafeInteger(b[k]) && (b[k] as number) >= 0 ? (b[k] as number) : (() => { throw bad("bad_dump", `${k} must be a count`); })());
  const status = str("status");
  if (!status || !["published", "failed", "skipped"].includes(status)) throw bad("bad_dump", "status: published | failed | skipped");
  const url = str("url");
  if (url && !/^https:\/\/github\.com\//.test(url)) throw bad("bad_dump", "url must be a github.com URL");
  if (b.verified !== undefined && b.verified !== null && typeof b.verified !== "boolean") throw bad("bad_dump", "verified must be a boolean");
  const rec = { status, repo: str("repo"), url, commit: str("commit"), verified: (b.verified as boolean | undefined) ?? null, episodes: num("episodes"), units: num("units"), agents: num("agents"), last_seq: num("last_seq"), reason: str("reason") };
  db.query("INSERT OR REPLACE INTO findings_dump (id, body, reported_at, reported_by) VALUES ('main', ?, ?, ?)").run(JSON.stringify(rec), now, by);
  return { recorded: 1 };
}

/** GET /v1/learnings/dump */
export function readDump(core: Core) {
  const db = (core as unknown as { db: Core["db"] }).db;
  db.exec(DUMP_SCHEMA);
  const r = db.query<{ body: string; reported_at: number }, []>("SELECT body, reported_at FROM findings_dump WHERE id = 'main'").get();
  return { dump: r ? { ...JSON.parse(r.body), reported_at: r.reported_at } : null };
}
