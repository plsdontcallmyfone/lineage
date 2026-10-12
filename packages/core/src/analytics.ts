import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Core } from "./core.ts";
import { deploymentsOf } from "./deployments.ts";
import { bad, notFound } from "./errors.ts";
import { genGithubOf } from "./gen-github.ts";
import { hiddenOf } from "./hidden.ts";
import { gainOf, providerOf, WINDOWS as BASE_WINDOWS } from "./leaderboard.ts";
import { learningsOf } from "./learnings.ts";
import { prepayOf } from "./prepay.ts";
import { revenueOf } from "./revenue.ts";
import { runtimeSpendOf } from "./runtime-spend.ts";
import { sessionsOf } from "./sessions.ts";
import { socialOf } from "./social.ts";
import { viewersOf } from "./viewers.ts";

// Read-only aggregates for the Projects, Generations and Analytics pages
// (docs/plans/PAGES-PROJECTS-GENERATIONS-ANALYTICS.md). Nothing here is a new claim: every figure is a
// count, sum, median or ratio of records Core already serves one by one.
//
// Sealing (SPEC 10.7, 17.3, 17.8). Only records that are public on their own are read:
//  - accepted generations (final by definition) and their counted replays' revealed results,
//  - provenance of final candidates (the generations' own),
//  - published learnings episodes (an attempt becomes one only once nothing in it can name the author
//    of an open candidate, learnings.ts), for every cost, attempt and model figure,
//  - replays of final candidates only, for verifier agreement and throughput,
//  - live sessions as GET /v1/sessions lists them (a live session's agent is public by design),
//  - candidate counts per lineage, which GET /v1/lineages/:id already serves (candidate_counts).
// About an open candidate nothing is served but that count.
//
// Hidden launches (hidden.ts) are left out of agent rows, model rows, spend and the explorer unless the
// query asks for them (hidden=1). units state (a project's metric values, its generation timeline)
// is the lineage's, whoever authored it; a hidden author's generation is kept there with its author
// withheld (author_hidden) unless hidden=1.

/** A model row reports an acceptance rate from this many attempts, and per accepted figures from this many accepted. */
export const MIN_ATTEMPTS_FOR_RATE = 5;
export const MIN_ACCEPTED_FOR_MEANS = 3;
/** The analytics windows: the leaderboard's plus 30 d (plan section 6). */
const WINDOWS: Record<string, number | null> = { ...BASE_WINDOWS, "30d": 30 * 86_400_000 };
const CACHE_MS = 10_000;
const HEX64 = /^[0-9a-f]{64}$/;
const AGENT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DAY = 86_400_000;
/** The worker's stop note on its outcome line (packages/worker/src/worker.ts): why the model loop ended and its model calls. */
export const STOP_NOTE = /\[stop: ([^;\]]{1,40}); model calls: (\d{1,5})\]/;
const HOUR = 3_600_000;

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const parse = <T = any>(s: string | null | undefined): T | null => {
  if (s === null || s === undefined) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};
const norm = (u: string) => u.trim().toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
/** The page key of a repository: owner/name for GitHub, the repo id otherwise. */
export function repoKey(url: string, repoId: string): string {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? m[1]! : repoId;
}
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

interface LineageInfo {
  lineage_id: string;
  repo_id: string;
  repo: string;
  recipe_name: string | null;
  class: string | null;
  status: string;
  height: number;
  created_at: number;
  metrics: { name: string; kind: string | null; direction: "lower" | "higher" }[];
  baseline: Record<string, number>;
}

interface GenRow {
  gen_id: string;
  lineage_id: string;
  height: number;
  kind: string | null;
  target: string | null;
  effect: string | null;
  author: string | null;
  accepted_at: number;
  reverted_by: string | null;
  candidate_id: string | null;
  audit_status: string | null;
  epoch: number;
}

interface Episode {
  seq: number;
  agent: string;
  lineage_id: string;
  outcome: string;
  provider: string | null;
  model: string | null;
  harness: string | null;
  usd: number | null;
  sandbox_s: number | null;
  ratio: number | null;
  fixed: number;
  started_at: number;
  ended_at: number | null;
  worker_outcome: string | null;
  reason: string | null;
  class: string | null;
  // expansion (section 5): tokens, candidate times, task and actions of the published episode
  input_tokens: number | null;
  cache_read: number | null;
  cache_write: number | null;
  committed_at: number | null;
  finalized_at: number | null;
  parent_gen_id: string | null;
  target: string | null;
  reads: number;
  searches: number;
  lists: number;
  edits: number;
  evals: number;
  tool_calls: number;
  /** why the model loop ended and its model calls, from the worker's outcome line (newer workers only) */
  stop: string | null;
  calls: number | null;
  published_at: number;
}

type Cached<T> = { at: number; v: T };

const instances = new WeakMap<Core, Analytics>();
export function analyticsOf(core: Core): Analytics {
  let a = instances.get(core);
  if (!a) instances.set(core, (a = new Analytics(core)));
  return a;
}

export class Analytics {
  private cache = new Map<string, Cached<unknown>>();
  /** Published episodes never change: their extracted figures are kept, read past the last seq only. */
  private episodes: Episode[] = [];
  private episodesSeq = 0;
  private names = new Map<string, { name: string | null; at: number }>();

  constructor(private readonly core: Core) {}

  private get db() {
    return this.core.db;
  }

  private memo<T>(key: string, fn: () => T): T {
    const now = this.core.now();
    const hit = this.cache.get(key) as Cached<T> | undefined;
    if (hit && now - hit.at < CACHE_MS && now >= hit.at) return hit.v;
    const v = fn();
    this.cache.set(key, { at: now, v });
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
    return v;
  }

  // ------------------------------------------------------------------------------------------- shared

  private hiddenSet(include: boolean): Set<string> {
    const out = new Set<string>();
    // a revealed shadow (canary) identity is left out like on the agents page; an unrevealed one is indistinguishable
    for (const r of this.db.query<{ agent_id: string }, []>("SELECT agent_id FROM agents WHERE shadow = 1").all()) {
      const v = this.core.agentView(r.agent_id) as { shadow?: boolean };
      if (v.shadow) out.add(r.agent_id);
    }
    if (!include) for (const a of hiddenOf(this.core).agents().keys()) out.add(a);
    return out;
  }

  private testLaunches(): Set<string> {
    return new Set(hiddenOf(this.core).agents().keys());
  }

  nameOf(agent: string): string | null {
    const now = this.core.now();
    const hit = this.names.get(agent);
    if (hit && now - hit.at < 60_000) return hit.name;
    const r = this.db.query<{ doc: string }, [string]>("SELECT doc FROM souls WHERE agent = ? ORDER BY seq DESC LIMIT 1").get(agent);
    const name = parse<{ persona?: { name?: string } }>(r?.doc)?.persona?.name ?? null;
    this.names.set(agent, { name, at: now });
    return name;
  }

  private lineages(): LineageInfo[] {
    return this.memo("lineages", () =>
      this.db
        .query<{ lineage_id: string; repo_id: string; repo: string; json: string; status: string; height: number; created_at: number; cal: string }, []>(
          `SELECT l.lineage_id, l.repo_id, rp.url AS repo, r.json, l.status, l.height, l.created_at, c.json AS cal
           FROM lineages l JOIN recipes r ON r.recipe_id = l.recipe_id JOIN repos rp ON rp.repo_id = l.repo_id JOIN calibrations c ON c.calib_id = l.calib_id
           ORDER BY l.created_at, l.lineage_id`,
        )
        .all()
        .map((l) => {
          const recipe = parse<any>(l.json) ?? {};
          const cal = parse<any>(l.cal) ?? {};
          const baseline: Record<string, number> = {};
          for (const [k, v] of Object.entries<any>(cal.metrics ?? {})) if (typeof v?.base_value === "number" && v.enabled !== false) baseline[k] = v.base_value;
          return {
            lineage_id: l.lineage_id, repo_id: l.repo_id, repo: l.repo, recipe_name: recipe.name ?? null, class: recipe.class ?? null, status: l.status, height: l.height, created_at: l.created_at,
            metrics: (Array.isArray(recipe.metrics) ? recipe.metrics : []).map((m: any) => ({ name: String(m.name), kind: m.kind ?? null, direction: m.direction === "higher" ? "higher" : "lower" })),
            baseline,
          } satisfies LineageInfo;
        }),
    );
  }

  private gens(): GenRow[] {
    return this.memo("gens", () =>
      this.db
        .query<GenRow, []>(
          `SELECT gen_id, lineage_id, height, kind, target, effect, author, accepted_at, reverted_by, candidate_id, audit_status, epoch
           FROM generations WHERE entry_type = 'patch' AND author IS NOT NULL ORDER BY accepted_at, height`,
        )
        .all(),
    );
  }

  /** Model of each accepted generation from its provenance record (public: the candidate is final). */
  private models(): Map<string, { model: string | null; provider: string | null; runtime: string }> {
    return this.memo("models", () => {
      const out = new Map<string, { model: string | null; provider: string | null; runtime: string }>();
      const has = this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provenance'").get();
      if (!has) return out;
      const rows = this.db
        .query<{ gen_id: string; record: string; runtime: string }, []>(
          "SELECT c.gen_id, p.record, p.runtime FROM provenance p JOIN candidates c ON c.commit_id = p.commit_id WHERE c.gen_id IS NOT NULL AND c.status = 'accepted'",
        )
        .all();
      for (const r of rows) {
        const rec = parse<{ models?: string[]; provider?: string; proposer?: { name?: string } }>(r.record);
        if (!rec) continue;
        const model = rec.proposer?.name === "scripted" ? "scripted" : (rec.models?.[0] ?? null);
        out.set(r.gen_id, { model, provider: rec.provider ?? (model === "scripted" ? "scripted" : providerOf(model)), runtime: r.runtime });
      }
      return out;
    });
  }

  /** Median of each metric over a candidate's counted replays (candidate side and parent side). */
  private measured(): Map<string, Record<string, { cand: number | null; base: number | null; replays: number }>> {
    return this.memo("measured", () => {
      const out = new Map<string, Record<string, { cand: number | null; base: number | null; replays: number }>>();
      const rows = this.db
        .query<{ candidate_id: string; result: string | null }, []>(
          `SELECT r.candidate_id, r.result FROM replays r JOIN generations g ON g.candidate_id = r.candidate_id
           WHERE g.entry_type = 'patch' AND r.kind = 'replay' AND r.role = 'counted' AND r.status = 'revealed'`,
        )
        .all();
      const acc = new Map<string, Record<string, { cand: number[]; base: number[] }>>();
      for (const r of rows) {
        const res = parse<{ metrics?: Record<string, { base?: number[]; cand?: number[] }> }>(r.result);
        const m = acc.get(r.candidate_id) ?? acc.set(r.candidate_id, {}).get(r.candidate_id)!;
        for (const [k, v] of Object.entries(res?.metrics ?? {})) {
          const c = median((v.cand ?? []).filter(Number.isFinite));
          const b = median((v.base ?? []).filter(Number.isFinite));
          const slot = (m[k] ??= { cand: [], base: [] });
          if (c !== null) slot.cand.push(c);
          if (b !== null) slot.base.push(b);
        }
      }
      for (const [cid, m] of acc) {
        const o: Record<string, { cand: number | null; base: number | null; replays: number }> = {};
        for (const [k, v] of Object.entries(m)) o[k] = { cand: median(v.cand), base: median(v.base), replays: v.cand.length };
        out.set(cid, o);
      }
      return out;
    });
  }

  private liveSessions(include: boolean) {
    const off = this.hiddenSet(include);
    return this.core.tx(() => sessionsOf(this.core).list({ state: "live", limit: 500 }, null)).filter((s: any) => !s.agent || !off.has(s.agent)) as any[];
  }

  private openCounts(): Map<string, number> {
    // the same rows GET /v1/lineages/:id counts in candidate_counts
    const rows = this.db
      .query<{ lineage_id: string; n: number }, []>("SELECT lineage_id, COUNT(*) AS n FROM candidates WHERE status NOT IN ('accepted', 'rejected', 'expired') GROUP BY lineage_id")
      .all();
    return new Map(rows.map((r) => [r.lineage_id, r.n]));
  }

  // ------------------------------------------------------------------------------------------ projects

  /** Per metric of a lineage: baseline, measured value at each unreverted generation, best, latest. */
  private series(l: LineageInfo, gens: GenRow[]) {
    const meas = this.measured();
    const kept = gens.filter((g) => !g.reverted_by && g.candidate_id).sort((a, b) => a.height - b.height);
    return l.metrics.map((m) => {
      const points = kept
        .map((g) => {
          const v = meas.get(g.candidate_id!)?.[m.name];
          const eff = parse<{ metric?: string }>(g.effect);
          return v && v.cand !== null ? { height: g.height, gen_id: g.gen_id, value: v.cand, parent: v.base, replays: v.replays, at: g.accepted_at, targeted: eff?.metric === m.name } : null;
        })
        .filter((p): p is NonNullable<typeof p> => !!p);
      const baseline = l.baseline[m.name] ?? null;
      const better = (a: number, b: number) => (m.direction === "higher" ? a > b : a < b);
      let best: (typeof points)[number] | null = null;
      for (const p of points) if (!best || better(p.value, best.value)) best = p;
      const latest = points[points.length - 1] ?? null;
      const change = (v: number | null | undefined) =>
        baseline !== null && baseline !== 0 && v !== null && v !== undefined ? r4(((m.direction === "higher" ? v - baseline : baseline - v) / Math.abs(baseline)) * 100) : null;
      return {
        name: m.name,
        kind: m.kind,
        direction: m.direction,
        baseline,
        baseline_source: baseline === null ? null : "calibration",
        best: best ? { value: best.value, height: best.height, gen_id: best.gen_id, at: best.at } : null,
        latest: latest ? { value: latest.value, height: latest.height, gen_id: latest.gen_id, at: latest.at } : null,
        improvement_pct: best && baseline !== null && better(best.value, baseline) ? change(best.value) : best ? 0 : null,
        latest_change_pct: change(latest?.value),
        points,
      };
    });
  }

  private projectRows(include: boolean, all: boolean) {
    const ls = this.lineages().filter((l) => all || (l.status === "active" && /^https?:\/\//.test(l.repo)));
    const gens = this.gens();
    const tests = this.testLaunches();
    const off = this.hiddenSet(include);
    const open = this.openCounts();
    const live = this.liveSessions(include);
    const byRepo = new Map<string, LineageInfo[]>();
    for (const l of ls) (byRepo.get(norm(l.repo)) ?? byRepo.set(norm(l.repo), []).get(norm(l.repo))!).push(l);
    const out = [...byRepo.values()].map((lins) => {
      const first = lins[0]!;
      const ids = new Set(lins.map((l) => l.lineage_id));
      const gs = gens.filter((g) => ids.has(g.lineage_id));
      const kept = gs.filter((g) => !g.reverted_by);
      const sessions = live.filter((s) => ids.has(s.lineage_id));
      const agents = [...new Map(sessions.filter((s) => s.agent).map((s) => [s.agent as string, s])).values()].map((s) => ({
        agent: s.agent as string, name: this.nameOf(s.agent), session_id: s.session_id as string, lineage_id: s.lineage_id as string, started_at: s.started_at as number, desktop: !!s.desktop,
      }));
      return {
        key: repoKey(first.repo, first.repo_id),
        repo: first.repo,
        repo_id: first.repo_id,
        github: /^https:\/\/github\.com\//i.test(first.repo),
        classes: [...new Set(lins.map((l) => l.class).filter((c): c is string => !!c))].sort(),
        lineages: lins.map((l) => {
          const lg = gs.filter((g) => g.lineage_id === l.lineage_id);
          return {
            lineage_id: l.lineage_id, recipe_name: l.recipe_name, class: l.class, status: l.status, height: l.height, created_at: l.created_at,
            open_candidates: open.get(l.lineage_id) ?? 0,
            accepted: lg.filter((g) => !g.reverted_by).length,
            metrics: this.series(l, lg).map(({ points, ...m }) => ({ ...m, measured_generations: points.length })),
          };
        }),
        accepted: kept.length,
        accepted_by_test_launches: kept.filter((g) => tests.has(g.author!)).length,
        reverted: gs.length - kept.length,
        authors: [...new Set(kept.map((g) => g.author!).filter((a) => !off.has(a)))].length,
        last_improvement_at: kept.length ? Math.max(...kept.map((g) => g.accepted_at)) : null,
        open_candidates: lins.reduce((n, l) => n + (open.get(l.lineage_id) ?? 0), 0),
        live_agents: agents,
        live_sessions: sessions.length,
      };
    });
    // live work first, then the newest improvement, then the newest lineage
    const score = (p: (typeof out)[number]) => (p.live_sessions ? 1e15 : 0) + (p.last_improvement_at ?? 0);
    return out.sort((a, b) => score(b) - score(a) || a.repo.localeCompare(b.repo));
  }

  /** GET /v1/analytics/projects?hidden=1&all=1 */
  projects(q: { hidden?: boolean; all?: boolean }) {
    return this.memo(`projects:${q.hidden ? 1 : 0}:${q.all ? 1 : 0}`, () => ({
      now: this.core.now(),
      hidden_included: !!q.hidden,
      all: !!q.all,
      projects: this.projectRows(!!q.hidden, !!q.all),
    }));
  }

  /** GET /v1/analytics/project?repo=<owner/name | repo id | url>&hidden=1 */
  project(q: { repo?: string; hidden?: boolean }) {
    if (!q.repo || q.repo.length > 300) throw bad("bad_query", "repo= is required: owner/name, a repo id or the repository URL");
    const want = q.repo.trim();
    const ls = this.lineages();
    const lins = ls.filter((l) => l.repo_id === want || norm(l.repo) === norm(want) || repoKey(l.repo, l.repo_id).toLowerCase() === want.toLowerCase());
    if (!lins.length) throw notFound("project");
    const include = !!q.hidden;
    return this.memo(`project:${lins[0]!.repo_id}:${include ? 1 : 0}`, () => {
      const row = this.projectRows(include, true).find((p) => p.repo_id === lins[0]!.repo_id)!;
      const off = this.hiddenSet(include);
      const gens = this.gens();
      const gh = genGithubOf(this.core);
      const models = this.models();
      const sessions = (lineage: string) =>
        (this.core.tx(() => sessionsOf(this.core).list({ lineage, limit: 30 }, null)) as any[])
          .filter((s) => !s.agent || !off.has(s.agent))
          .map((s) => ({ session_id: s.session_id, state: s.state, agent: s.agent, name: s.agent ? this.nameOf(s.agent) : null, started_at: s.started_at, last_at: s.last_at, ended_at: s.ended_at, desktop: !!s.desktop, events: s.events, height: s.height }));
      return {
        now: this.core.now(),
        hidden_included: include,
        ...row,
        lineages: lins.map((l) => {
          const lg = gens.filter((g) => g.lineage_id === l.lineage_id);
          const summary = row.lineages.find((x) => x.lineage_id === l.lineage_id)!;
          return {
            ...summary,
            metrics: this.series(l, lg),
            timeline: [...lg]
              .sort((a, b) => b.height - a.height)
              .map((g) => {
                const eff = parse<any>(g.effect);
                const x = gainOf(eff);
                const hid = off.has(g.author!);
                const m = models.get(g.gen_id);
                return {
                  gen_id: g.gen_id, height: g.height, kind: g.kind, target: parse(g.target), metric: eff?.metric ?? null, effect: eff, gain_pct: r4(x.pct), fixed: x.fixed,
                  author: hid ? null : g.author, author_name: hid ? null : this.nameOf(g.author!), author_hidden: hid,
                  model: hid ? null : (m?.model ?? null), provider: hid ? null : (m?.provider ?? null),
                  accepted_at: g.accepted_at, reverted_by: g.reverted_by, audit_status: g.audit_status, github: gh.view(g.gen_id),
                };
              }),
            sessions: sessions(l.lineage_id),
          };
        }),
      };
    });
  }

  // --------------------------------------------------------------------------------------- generations

  /** GET /v1/analytics/generations?repo=&lineage=&agent=&metric=&class=&kind=&model=&provider=&from=&to=&sort=&dir=&page=&limit=&hidden=1 */
  generations(q: { repo?: string; lineage?: string; agent?: string; metric?: string; class?: string; kind?: string; model?: string; provider?: string; from?: string; to?: string; sort?: string; dir?: string; page?: number; limit?: number; hidden?: boolean }) {
    const sort = q.sort ?? "time";
    if (!["time", "effect"].includes(sort)) throw bad("bad_query", "sort: time or effect");
    const dir = q.dir ?? "desc";
    if (!["asc", "desc"].includes(dir)) throw bad("bad_query", "dir: asc or desc");
    if (q.lineage !== undefined && !HEX64.test(q.lineage)) throw bad("bad_query", "lineage must be 64 hex");
    if (q.agent !== undefined && !AGENT.test(q.agent)) throw bad("bad_query", "agent must be an agent id");
    const when = (s: string | undefined, end: boolean): number | null => {
      if (s === undefined || s === "") return null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const t = Date.parse(`${s}T00:00:00Z`);
        if (!Number.isFinite(t)) throw bad("bad_query", "from/to: YYYY-MM-DD (UTC) or unix ms");
        return end ? t + DAY : t;
      }
      if (/^\d{1,15}$/.test(s)) return Number(s);
      throw bad("bad_query", "from/to: YYYY-MM-DD (UTC) or unix ms");
    };
    const from = when(q.from, false);
    const to = when(q.to, true);
    const limit = Math.max(1, Math.min(q.limit ?? 50, 200));
    const page = Math.max(1, q.page ?? 1);
    const include = !!q.hidden;
    const off = this.hiddenSet(include);
    const ls = new Map(this.lineages().map((l) => [l.lineage_id, l]));
    const models = this.models();
    const all = this.gens()
      .filter((g) => !off.has(g.author!))
      .map((g) => {
        const l = ls.get(g.lineage_id)!;
        const eff = parse<any>(g.effect);
        const x = gainOf(eff);
        const m = models.get(g.gen_id);
        return { g, l, eff, x, model: m?.model ?? null, provider: m?.provider ?? null, metric: (eff?.metric as string | undefined) ?? null };
      })
      .filter((r) => !!r.l);
    const rows = all.filter(
      (r) =>
        (!q.repo || repoKey(r.l.repo, r.l.repo_id).toLowerCase() === q.repo.toLowerCase() || r.l.repo_id === q.repo || norm(r.l.repo) === norm(q.repo)) &&
        (!q.lineage || r.g.lineage_id === q.lineage) &&
        (!q.agent || r.g.author === q.agent) &&
        (!q.metric || r.metric === q.metric || (q.metric === "fix" && r.x.fixed > 0)) &&
        (!q.class || r.l.class === q.class) &&
        (!q.kind || r.g.kind === q.kind) &&
        (!q.model || (q.model === "none" ? r.model === null : r.model === q.model)) &&
        (!q.provider || (q.provider === "none" ? r.provider === null : r.provider === q.provider)) &&
        (from === null || r.g.accepted_at >= from) &&
        (to === null || r.g.accepted_at < to),
    );
    const key = (r: (typeof rows)[number]) => (sort === "effect" ? r.x.pct + r.x.fixed * 1e-6 : r.g.accepted_at);
    rows.sort((a, b) => (dir === "desc" ? key(b) - key(a) : key(a) - key(b)) || b.g.accepted_at - a.g.accepted_at || (a.g.gen_id < b.g.gen_id ? -1 : 1));
    const gh = genGithubOf(this.core);
    const tests = this.testLaunches();
    const slice = rows.slice((page - 1) * limit, page * limit).map((r) => ({
      gen_id: r.g.gen_id,
      lineage_id: r.g.lineage_id,
      recipe_name: r.l.recipe_name,
      repo: r.l.repo,
      repo_key: repoKey(r.l.repo, r.l.repo_id),
      class: r.l.class,
      height: r.g.height,
      kind: r.g.kind,
      target: parse(r.g.target),
      metric: r.metric,
      effect: r.eff,
      gain_pct: r4(r.x.pct),
      fixed: r.x.fixed,
      author: r.g.author,
      author_name: this.nameOf(r.g.author!),
      test_launch: tests.has(r.g.author!),
      model: r.model,
      provider: r.provider,
      accepted_at: r.g.accepted_at,
      epoch: r.g.epoch,
      reverted_by: r.g.reverted_by,
      audit_status: r.g.audit_status,
      github: gh.view(r.g.gen_id),
    }));
    const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort();
    return {
      now: this.core.now(),
      hidden_included: include,
      sort,
      dir,
      page,
      limit,
      total: rows.length,
      pages: Math.max(1, Math.ceil(rows.length / limit)),
      rows: slice,
      facets: {
        projects: [...new Map(all.map((r) => [repoKey(r.l.repo, r.l.repo_id), { key: repoKey(r.l.repo, r.l.repo_id), repo: r.l.repo }])).values()].sort((a, b) => a.key.localeCompare(b.key)),
        agents: [...new Map(all.map((r) => [r.g.author!, { agent: r.g.author!, name: this.nameOf(r.g.author!) }])).values()].sort((a, b) => (a.name ?? a.agent).localeCompare(b.name ?? b.agent)),
        metrics: uniq(all.map((r) => r.metric)),
        classes: uniq(all.map((r) => r.l.class)),
        kinds: uniq(all.map((r) => r.g.kind)),
        models: uniq(all.map((r) => r.model)),
        providers: uniq(all.map((r) => r.provider)),
      },
    };
  }

  // ------------------------------------------------------------------------------------------ overview

  private loadEpisodes(): Episode[] {
    learningsOf(this.core).sweep();
    const rows = this.db
      .query<
        {
          seq: number; agent: string; lineage_id: string; outcome: string; provider: string | null; model: string | null; harness: string | null; usd: number | null; sandbox_s: number | null;
          ratio: number | null; fixed: number | null; started_at: number; ended_at: number | null; worker_outcome: string | null; reason: string | null; class: string | null;
          input_tokens: number | null; cache_read: number | null; cache_write: number | null; committed_at: number | null; finalized_at: number | null; parent_gen_id: string | null;
          target: unknown; published_at: number; reads: number; searches: number; lists: number; edits: number; evals: number; tool_calls: number;
        },
        [number]
      >(
        `SELECT seq, agent, lineage_id, outcome, provider,
           json_extract(json, '$.model.models[0]') AS model, json_extract(json, '$.model.harness.name') AS harness,
           json_extract(json, '$.cost.usd') AS usd, json_extract(json, '$.cost.sandbox_s') AS sandbox_s,
           json_extract(json, '$.effect.ratio') AS ratio, json_array_length(json_extract(json, '$.effect.fixed')) AS fixed,
           json_extract(json, '$.times.started_at') AS started_at, json_extract(json, '$.times.ended_at') AS ended_at,
           json_extract(json, '$.worker_outcome') AS worker_outcome, json_extract(json, '$.verdict.reason') AS reason,
           json_extract(json, '$.task.recipe.class') AS class,
           json_extract(json, '$.cost.input_tokens') AS input_tokens, json_extract(json, '$.cost.cache_read_tokens') AS cache_read,
           json_extract(json, '$.cost.cache_write_tokens') AS cache_write,
           json_extract(json, '$.candidate.committed_at') AS committed_at, json_extract(json, '$.candidate.finalized_at') AS finalized_at,
           json_extract(json, '$.task.parent_gen_id') AS parent_gen_id, json_extract(json, '$.task.target.target') AS target, published_at,
           (SELECT COUNT(*) FROM json_each(learnings_episodes.json, '$.actions') a WHERE json_extract(a.value, '$.kind') = 'read') AS reads,
           (SELECT COUNT(*) FROM json_each(learnings_episodes.json, '$.actions') a WHERE json_extract(a.value, '$.kind') = 'search') AS searches,
           (SELECT COUNT(*) FROM json_each(learnings_episodes.json, '$.actions') a WHERE json_extract(a.value, '$.kind') = 'list') AS lists,
           (SELECT COUNT(*) FROM json_each(learnings_episodes.json, '$.actions') a WHERE json_extract(a.value, '$.kind') IN ('edit', 'write', 'patch')) AS edits,
           (SELECT COUNT(*) FROM json_each(learnings_episodes.json, '$.actions') a WHERE json_extract(a.value, '$.kind') = 'evaluate') AS evals,
           (SELECT COUNT(*) FROM json_each(learnings_episodes.json, '$.actions') a WHERE json_extract(a.value, '$.kind') IN ('read', 'search', 'list', 'edit', 'write', 'patch', 'evaluate', 'submit', 'give_up')) AS tool_calls
         FROM learnings_episodes WHERE seq > ? ORDER BY seq`,
      )
      .all(this.episodesSeq);
    for (const r of rows) {
      const stop = r.worker_outcome ? STOP_NOTE.exec(r.worker_outcome) : null;
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      this.episodes.push({
        ...r, fixed: r.fixed ?? 0, usd: n(r.usd), sandbox_s: n(r.sandbox_s), ratio: n(r.ratio),
        input_tokens: n(r.input_tokens), cache_read: n(r.cache_read), cache_write: n(r.cache_write), committed_at: n(r.committed_at), finalized_at: n(r.finalized_at),
        target: r.target === null || r.target === undefined ? null : typeof r.target === "string" ? r.target : JSON.stringify(r.target),
        stop: stop ? stop[1]!.trim() : null, calls: stop ? Number(stop[2]) : null,
      });
      this.episodesSeq = r.seq;
    }
    return this.episodes;
  }

  /** Model label of an episode: the attested or reported model, "scripted" for a scripted author, else what ran is not reported. */
  private modelKey(e: Episode): { provider: string | null; model: string } {
    if (e.model) return { provider: e.provider ?? providerOf(e.model), model: e.model };
    if (e.harness === "scripted") return { provider: "scripted", model: "scripted" };
    return { provider: e.provider, model: `not reported (${e.harness ?? "unknown"} harness)` };
  }

  private group(eps: Episode[], key: (e: Episode) => string, extra: (k: string, es: Episode[]) => Record<string, unknown> = () => ({})) {
    const m = new Map<string, Episode[]>();
    for (const e of eps) (m.get(key(e)) ?? m.set(key(e), []).get(key(e))!).push(e);
    return [...m.entries()].map(([k, es]) => ({ key: k, ...this.costOf(es), ...extra(k, es) })).sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || b.attempts - a.attempts);
  }

  private costOf(es: Episode[]) {
    const priced = es.filter((e) => e.usd !== null);
    const usd = priced.reduce((s, e) => s + e.usd!, 0);
    const acc = es.filter((e) => e.outcome === "accepted");
    const gain = acc.reduce((s, e) => s + (e.ratio !== null && e.ratio < 1 ? (1 - e.ratio) * 100 : 0), 0);
    const pricedAcc = priced.filter((e) => e.outcome === "accepted");
    const pricedGain = pricedAcc.reduce((s, e) => s + (e.ratio !== null && e.ratio < 1 ? (1 - e.ratio) * 100 : 0), 0);
    return {
      attempts: es.length,
      priced: priced.length,
      // null when no attempt carries a cost record: unknown, not zero
      usd: priced.length ? r6(usd) : null,
      accepted: acc.length,
      gain_pct: r4(gain),
      // per accepted and per point of gain use priced attempts only, so an unpriced attempt never lowers a cost
      usd_per_accepted: pricedAcc.length ? r6(usd / pricedAcc.length) : null,
      usd_per_gain_pct: pricedGain > 0 ? r6(usd / pricedGain) : null,
      sandbox_s: es.reduce((s, e) => s + (e.sandbox_s ?? 0), 0),
    };
  }

  private release() {
    // the deploy kit runs Core from /opt/lineage/releases/<sha> (scripts/deploy/remote.sh): the release
    // directories are the deploy history, and the current one is where this file is
    try {
      const root = join(import.meta.dir, "../../..");
      if (basename(dirname(root)) !== "releases") return null;
      const dir = dirname(root);
      const list = readdirSync(dir)
        .filter((n) => /^[0-9a-f]{7,40}$/.test(n))
        .map((n) => ({ commit: n, at: Math.round(statSync(join(dir, n)).mtimeMs) }))
        .sort((a, b) => b.at - a.at)
        .slice(0, 30);
      return { current: basename(root), releases: list };
    } catch {
      return null;
    }
  }

  /** GET /v1/analytics/overview?window=24h|7d|all&hidden=1 */
  overview(q: { window?: string; hidden?: boolean }) {
    const win = q.window ?? "7d";
    const span = WINDOWS[win];
    if (span === undefined) throw bad("bad_query", "window: 24h, 7d, 30d or all");
    const include = !!q.hidden;
    return this.memo(`overview:${win}:${include ? 1 : 0}`, () => {
      const now = this.core.now();
      const since = span === null ? 0 : now - span;
      const off = this.hiddenSet(include);
      const tests = this.testLaunches();

      // network
      const live = this.core.live.live() as any;
      const sessions = this.liveSessions(include);
      const epochs = this.db.query<{ n: number; status: string; end_ms: number; closed_at: number | null }, []>("SELECT n, status, end_ms, closed_at FROM epochs ORDER BY n DESC").all();
      const posted = this.db.query<{ n: number; signature: string | null; error: string | null; posted_at: number | null; attempts: number }, []>("SELECT n, signature, error, posted_at, attempts FROM chain_epochs ORDER BY n DESC").all();
      const chain = this.core.chainMode ? ((this.core.chainView?.() ?? null) as any) : null;
      const spend = runtimeSpendOf(this.core);
      const g = spend.global();
      const waiting = spend
        .all()
        .filter((r) => !off.has(r.agent))
        .map((r) => ({ agent: r.agent, name: this.nameOf(r.agent), reported_at: r.reported_at, ...r.spend }) as { agent: string; name: string | null; reported_at: number } & Record<string, any>);
      const category = (w: string | null) =>
        !w ? null : /vault|asleep|wake/i.test(w) ? "vault" : /provider|balance|openrouter/i.test(w) ? "provider balance" : /desktop|slot/i.test(w) ? "desktop slot" : /cap/i.test(w) ? "platform cap" : "other";

      // costs and models (published episodes only)
      const eps = this.loadEpisodes().filter((e) => !off.has(e.agent) && e.started_at >= since);
      const nothing = eps.filter((e) => e.outcome !== "accepted");
      const reasons = new Map<string, { outcome: string; reason: string; n: number }>();
      for (const e of nothing) {
        const why = e.outcome === "rejected" || e.outcome === "expired" ? (e.reason ?? e.outcome) : e.worker_outcome ? e.worker_outcome.split(/[:;(]/)[0]!.trim().slice(0, 80) : "no worker report";
        const k = `${e.outcome}|${why}`;
        const r = reasons.get(k) ?? reasons.set(k, { outcome: e.outcome, reason: why, n: 0 }).get(k)!;
        r.n++;
      }
      const modelRows = this.group(eps, (e) => JSON.stringify(this.modelKey(e)), (k, es) => {
        const mk = JSON.parse(k) as { provider: string | null; model: string };
        const acc = es.filter((e) => e.outcome === "accepted");
        const gains = acc.filter((e) => e.ratio !== null).map((e) => (1 - e.ratio!) * 100);
        const durs = es.filter((e) => e.ended_at !== null && e.ended_at >= e.started_at).map((e) => (e.ended_at! - e.started_at) / 1000);
        const c = this.costOf(es);
        return {
          provider: mk.provider,
          model: mk.model,
          rate: es.length >= MIN_ATTEMPTS_FOR_RATE ? r4(acc.length / es.length) : null,
          mean_gain_pct: gains.length >= MIN_ACCEPTED_FOR_MEANS ? r4(gains.reduce((s, x) => s + x, 0) / gains.length) : null,
          gain_samples: gains.length,
          gain_per_usd: c.usd !== null && c.usd > 0 && acc.length >= MIN_ACCEPTED_FOR_MEANS ? r6(c.gain_pct / c.usd) : null,
          median_duration_s: durs.length ? Math.round(median(durs)!) : null,
          fixes: acc.reduce((s, e) => s + e.fixed, 0),
        };
      });
      const agentRows = this.group(eps, (e) => e.agent, (a) => ({ agent: a, name: this.nameOf(a), test_launch: tests.has(a) }));
      const providerRows = this.group(eps, (e) => this.modelKey(e).provider ?? "not reported");

      // activity: accepted generations per UTC day (all time) and per hour (last 48 h)
      const gens = this.gens().filter((x) => !off.has(x.author!));
      const daily = new Map<string, { day: string; n: number; test: number }>();
      for (const x of gens) {
        const d = dayOf(x.accepted_at);
        const r = daily.get(d) ?? daily.set(d, { day: d, n: 0, test: 0 }).get(d)!;
        r.n++;
        if (tests.has(x.author!)) r.test++;
      }
      const hourly: { at: number; n: number }[] = [];
      const h0 = Math.floor(now / HOUR) * HOUR - 47 * HOUR;
      for (let i = 0; i < 48; i++) hourly.push({ at: h0 + i * HOUR, n: 0 });
      for (const x of gens) if (x.accepted_at >= h0) hourly[Math.min(47, Math.floor((x.accepted_at - h0) / HOUR))]!.n++;
      const epDaily = new Map<string, { day: string; attempts: number; accepted: number; priced: number; usd: number }>();
      for (const e of this.loadEpisodes().filter((x) => !off.has(x.agent))) {
        const d = dayOf(e.started_at);
        const r = epDaily.get(d) ?? epDaily.set(d, { day: d, attempts: 0, accepted: 0, priced: 0, usd: 0 }).get(d)!;
        r.attempts++;
        if (e.outcome === "accepted") r.accepted++;
        if (e.usd !== null) (r.priced++, (r.usd = r6(r.usd + e.usd)));
      }

      // verification: replays of final candidates only
      const reps = this.db
        .query<{ role: string | null; status: string; revealed_at: number | null; kind: string }, [number]>(
          `SELECT r.role, r.status, r.revealed_at, r.kind FROM replays r JOIN candidates c ON c.candidate_id = r.candidate_id
           WHERE c.status IN ('accepted', 'rejected', 'expired') AND r.kind IN ('replay', 'reference') AND COALESCE(c.finalized_at, c.committed_at) >= ?`,
        )
        .all(since);
      const role = (r: string) => reps.filter((x) => x.role === r).length;
      const counted = role("counted");
      const minority = role("minority");
      const finals = this.db
        .query<{ status: string; n: number }, [number]>("SELECT status, COUNT(*) AS n FROM candidates WHERE status IN ('accepted', 'rejected', 'expired') AND is_canary = 0 AND COALESCE(finalized_at, committed_at) >= ? GROUP BY status")
        .all(since);
      const repDaily = new Map<string, number>();
      for (const x of reps) if (x.revealed_at) repDaily.set(dayOf(x.revealed_at), (repDaily.get(dayOf(x.revealed_at)) ?? 0) + 1);
      const audits = this.db
        .query<{ audit_status: string; n: number }, [number]>("SELECT audit_status, COUNT(*) AS n FROM generations WHERE entry_type = 'patch' AND audit_status IS NOT NULL AND accepted_at >= ? GROUP BY audit_status")
        .all(since);

      return {
        now,
        window: win,
        since,
        hidden_included: include,
        thresholds: { min_attempts_for_rate: MIN_ATTEMPTS_FOR_RATE, min_accepted_for_means: MIN_ACCEPTED_FOR_MEANS },
        network: {
          core: { ok: true, started_at: Math.round(Date.now() - process.uptime() * 1000), mode: this.core.chainMode ? "devnet or mainnet (chain)" : "sim", release: this.release() },
          machines: { total: live.totals?.machines ?? null, awake: live.totals?.awake ?? null, by_job: live.totals?.by_job ?? null, heartbeat_s: live.heartbeat_s },
          sessions: { live: sessions.length, with_desktop: sessions.filter((s) => s.desktop).length, agents: [...new Set(sessions.map((s) => s.agent).filter(Boolean))].length },
          epochs: {
            current: epochs.find((e) => e.status === "open")?.n ?? null,
            closed: epochs.filter((e) => e.status === "closed").length,
            last_closed: epochs.find((e) => e.status === "closed") ?? null,
            posted: posted.filter((p) => p.signature).length,
            last_posted: posted.find((p) => p.signature) ? { n: posted.find((p) => p.signature)!.n, at: posted.find((p) => p.signature)!.posted_at } : null,
            unposted: posted.filter((p) => !p.signature).map((p) => ({ n: p.n, attempts: p.attempts, error: p.error ? p.error.slice(0, 160) : null })),
            chain: chain ? { epochs_posted: chain.epochs_posted ?? null, last_epoch: chain.last_epoch ?? null, read_at: chain.read_at ?? null, paused: chain.paused ?? null } : null,
          },
          runtime: g ? { reported_at: g.reported_at, price: g.body.price ?? null, provider_balance: g.body.provider_balance ?? null, cap: g.body.cap ?? null, desktops: g.body.desktops ?? null } : null,
          waiting: waiting.filter((w) => w.waiting).map((w) => ({ agent: w.agent, name: w.name, waiting: w.waiting, category: category(w.waiting), reported_at: w.reported_at })),
          bound_agents: waiting.length,
          deployments: deploymentsOf(this.core).list().deployments,
        },
        costs: {
          source: "published learnings episodes (cost.usd from hosted provenance or the worker's report); an attempt is counted once its episode is published",
          totals: this.costOf(eps),
          by_agent: agentRows,
          by_provider: providerRows,
          nothing: {
            total: nothing.length,
            by_outcome: nothing.reduce<Record<string, number>>((m, e) => ((m[e.outcome] = (m[e.outcome] ?? 0) + 1), m), {}),
            reasons: [...reasons.values()].sort((a, b) => b.n - a.n).slice(0, 20),
            usd: nothing.some((e) => e.usd !== null) ? r6(nothing.reduce((s, e) => s + (e.usd ?? 0), 0)) : null,
          },
          runway: waiting.map((w) => ({ agent: w.agent, name: w.name, vault_usd: w.vault_usd ?? null, burn_usd_per_h: w.burn_usd_per_h ?? null, runway_h: w.runway_h ?? null, model: w.model ?? null, via: w.via ?? null, reported_at: w.reported_at })),
          daily: [...epDaily.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-90),
        },
        models: { rows: modelRows },
        activity: {
          generations_in_window: gens.filter((x) => x.accepted_at >= since).length,
          generations_total: gens.length,
          daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-90),
          hourly,
        },
        verification: {
          final_candidates: Object.fromEntries(finals.map((f) => [f.status, f.n])),
          replays: { revealed: reps.filter((x) => x.status === "revealed").length, counted, minority, env_failed: role("env_failed"), other: reps.length - counted - minority - role("env_failed") },
          agreement: counted + minority > 0 ? r4(counted / (counted + minority)) : null,
          audits: Object.fromEntries(audits.map((a) => [a.audit_status, a.n])),
          daily: [...repDaily.entries()].map(([day, n]) => ({ day, n })).sort((a, b) => a.day.localeCompare(b.day)).slice(-90),
        },
      };
    });
  }

  // =============================================================================== expansion (plan section 5)
  // Eight sections of the Analytics page, each its own route over the same window. The sealing rule holds:
  // attempts, costs, models and times from published episodes only; replays of final candidates only;
  // hidden launches left out unless hidden=1.

  /** Time buckets of a window: hours over 24 h, days over 7 d, days since the first record (at most 90) over all. */
  private bucketsOf(win: string, now: number, first: number | null) {
    if (win === "24h") return { unit: "hour" as const, size: HOUR, start: Math.floor(now / HOUR) * HOUR - 23 * HOUR, n: 24 };
    if (win === "7d" || win === "30d") {
      const n = win === "7d" ? 7 : 30;
      return { unit: "day" as const, size: DAY, start: Math.floor(now / DAY) * DAY - (n - 1) * DAY, n };
    }
    const today = Math.floor(now / DAY) * DAY;
    const start = Math.max(today - 89 * DAY, Math.floor((first ?? now) / DAY) * DAY);
    return { unit: "day" as const, size: DAY, start, n: Math.round((today - start) / DAY) + 1 };
  }

  private win(q: { window?: string }) {
    const win = q.window ?? "7d";
    const span = WINDOWS[win];
    if (span === undefined) throw bad("bad_query", "window: 24h, 7d, 30d or all");
    const now = this.core.now();
    return { win, now, since: span === null ? 0 : now - span };
  }

  private axis(b: { unit: string; size: number; start: number; n: number }) {
    return { unit: b.unit, t: Array.from({ length: b.n }, (_, i) => b.start + i * b.size) };
  }

  private slot(b: { size: number; start: number; n: number }, t: number): number {
    const i = Math.floor((t - b.start) / b.size);
    return i >= 0 && i < b.n ? i : -1;
  }

  private repoKeyOf(lineage: string): string | null {
    const l = this.lineages().find((x) => x.lineage_id === lineage);
    return l ? repoKey(l.repo, l.repo_id) : null;
  }

  private outcomeOf(e: Episode): string {
    return e.outcome === "no_candidate" && e.stop === "cap reached" ? "cap_reached" : e.outcome;
  }

  // ------------------------------------------------------------------------------------------- ops files

  private readJsonl(path: string, max: number): any[] {
    try {
      if (!existsSync(path)) return [];
      const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
      return lines
        .slice(-max)
        .map((l) => parse<any>(l))
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
    } catch {
      return [];
    }
  }

  private monitorState() {
    const path = process.env.UNITS_MONITOR_STATE ?? "/var/lib/units-monitor/state.json";
    try {
      if (!existsSync(path)) return null;
      const j = JSON.parse(readFileSync(path, "utf8")) as { at?: string; worst?: string; checks?: { id: string; level: string; msg: string }[] };
      const at = j.at ? Date.parse(j.at) : NaN;
      return {
        at: Number.isFinite(at) ? at : null,
        worst: typeof j.worst === "string" ? j.worst : null,
        checks: (Array.isArray(j.checks) ? j.checks : []).filter((c) => c && typeof c.id === "string").map((c) => ({ id: c.id.slice(0, 80), level: String(c.level).slice(0, 8), msg: String(c.msg ?? "").slice(0, 240) })),
      };
    } catch {
      return null;
    }
  }

  /** GET /v1/analytics/ops?window=&hidden=1 */
  ops(q: { window?: string; hidden?: boolean }) {
    const { win, now, since } = this.win(q);
    const include = !!q.hidden;
    return this.memo(`ops:${win}:${include ? 1 : 0}`, () => {
      const off = this.hiddenSet(include);
      const dir = process.env.UNITS_OPS_DIR ?? "/var/lib/units/ops";
      const log = this.readJsonl(join(dir, "deploys.jsonl"), 200);
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      const str = (v: unknown, n = 80) => (typeof v === "string" ? v.slice(0, n) : null);
      const entries = log.map((x) => ({
        kind: str(x.kind, 20), sha: str(x.sha, 40), previous: str(x.previous, 40), started_at: num(x.started_at), public_at: num(x.public_at), ended_at: num(x.ended_at),
        result: str(x.result, 20), failed_unit: str(x.failed_unit, 60),
        probe: x.probe && typeof x.probe === "object" ? { probes: num((x.probe as any).probes), non_200: num((x.probe as any).non_200), longest_gap_ms: num((x.probe as any).longest_gap_ms) } : null,
        snapshot: str(x.snapshot, 120), passed: num(x.passed), failed: num(x.failed),
      }));
      const deploys = entries.filter((e) => e.kind === "deploy" || e.kind === "rollback").reverse();
      const restores = entries.filter((e) => e.kind === "restore_test").reverse();
      const inWin = deploys.filter((d) => (d.started_at ?? 0) >= since);

      // desktop minutes per bucket: sessions that ran on a desktop, start to end (now while live)
      const sess = this.db
        .query<{ agent_id: string; started_at: number; ended_at: number | null; last_at: number }, []>("SELECT agent_id, started_at, ended_at, last_at FROM sessions WHERE desktop = 1")
        .all()
        .filter((s) => !off.has(s.agent_id));
      const eps = this.loadEpisodes().filter((e) => !off.has(e.agent));
      const first = Math.min(...sess.map((s) => s.started_at), ...eps.map((e) => e.started_at), now);
      const b = this.bucketsOf(win, now, first);
      const desk = Array.from({ length: b.n }, () => ({ minutes: 0, sessions: 0 }));
      for (const s of sess) {
        const end = s.ended_at ?? now;
        const i0 = this.slot(b, s.started_at);
        if (i0 >= 0) desk[i0]!.sessions++;
        for (let i = 0; i < b.n; i++) {
          const lo = b.start + i * b.size, hi = lo + b.size;
          const ov = Math.min(end, hi) - Math.max(s.started_at, lo);
          if (ov > 0) desk[i]!.minutes += ov / 60_000;
        }
      }
      // sandbox seconds by class (published episodes, attempt start)
      const classes = [...new Set(eps.map((e) => e.class ?? "unknown"))].sort();
      const sandbox = Array.from({ length: b.n }, () => Object.fromEntries(classes.map((c) => [c, 0])) as Record<string, number>);
      for (const e of eps) {
        const i = this.slot(b, e.started_at);
        if (i >= 0 && e.sandbox_s !== null) sandbox[i]![e.class ?? "unknown"]! += e.sandbox_s;
      }
      runtimeSpendOf(this.core); // its tables
      const daily = this.db.query<{ day: string; key: string; value: number }, []>("SELECT day, key, value FROM runtime_spend_daily WHERE key = 'e2b_usd' ORDER BY day").all();
      const sessionsLive = this.liveSessions(include);
      const g = runtimeSpendOf(this.core).global();
      return {
        now, window: win, since, hidden_included: include,
        axis: this.axis(b),
        monitor: this.monitorState(),
        deploys: {
          source: entries.length ? "ops log (scripts/deploy/remote.sh)" : null,
          log: deploys.slice(0, 30),
          in_window: { deploys: inWin.filter((d) => d.kind === "deploy").length, rolled_back: inWin.filter((d) => d.result === "rolled_back").length, failed: inWin.filter((d) => d.result === "failed").length, rollbacks: inWin.filter((d) => d.kind === "rollback").length, non_200: inWin.reduce((n, d) => n + (d.probe?.non_200 ?? 0), 0), probes: inWin.reduce((n, d) => n + (d.probe?.probes ?? 0), 0), longest_gap_ms: Math.max(0, ...inWin.map((d) => d.probe?.longest_gap_ms ?? 0)) },
          releases: this.release(),
        },
        restore_tests: restores.slice(0, 10),
        live: { sessions: sessionsLive.length, with_desktop: sessionsLive.filter((s) => s.desktop).length, desktops: g?.body.desktops ?? null, reported_at: g?.reported_at ?? null },
        desktop_minutes: desk.map((d) => ({ minutes: Math.round(d.minutes * 10) / 10, sessions: d.sessions })),
        e2b_daily: daily.slice(-90).map((d) => ({ day: d.day, usd: r6(d.value) })),
        sandbox: { classes, series: sandbox.map((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, Math.round(v)]))) },
        viewers: null,
        viewers_note: "the gate keeps its stream viewer counters private (they would tell how close the caps are)",
      };
    });
  }

  // ------------------------------------------------------------------------------------------------ work

  /** GET /v1/analytics/work?window=&hidden=1 */
  work(q: { window?: string; hidden?: boolean }) {
    const { win, now, since } = this.win(q);
    const include = !!q.hidden;
    return this.memo(`work:${win}:${include ? 1 : 0}`, () => {
      const off = this.hiddenSet(include);
      const all = this.loadEpisodes().filter((e) => !off.has(e.agent));
      const gens = this.gens().filter((g) => !off.has(g.author!));
      const b = this.bucketsOf(win, now, all.length ? Math.min(...all.map((e) => e.started_at)) : null);
      const eps = all.filter((e) => this.slot(b, e.started_at) >= 0 && e.started_at >= Math.min(since, b.start));
      const OUT = ["accepted", "rejected", "expired", "no_candidate", "cap_reached", "abandoned"];
      const outcomes = Array.from({ length: b.n }, () => Object.fromEntries(OUT.map((o) => [o, 0])) as Record<string, number>);
      for (const e of eps) outcomes[this.slot(b, e.started_at)]![this.outcomeOf(e)]!++;
      const genSeries = Array.from({ length: b.n }, () => 0);
      for (const g of gens) {
        const i = this.slot(b, g.accepted_at);
        if (i >= 0) genSeries[i]!++;
      }
      // acceptance over time per agent and per project
      const rateRows = (key: (e: Episode) => string | null, label: (k: string) => Record<string, unknown>) => {
        const m = new Map<string, Episode[]>();
        for (const e of eps) {
          const k = key(e);
          if (k) (m.get(k) ?? m.set(k, []).get(k)!).push(e);
        }
        return [...m.entries()]
          .map(([k, es]) => {
            const s = Array.from({ length: b.n }, () => ({ attempts: 0, accepted: 0 }));
            for (const e of es) {
              const x = s[this.slot(b, e.started_at)]!;
              x.attempts++;
              if (e.outcome === "accepted") x.accepted++;
            }
            const acc = es.filter((e) => e.outcome === "accepted").length;
            return { key: k, ...label(k), attempts: es.length, accepted: acc, rate: es.length >= MIN_ATTEMPTS_FOR_RATE ? r4(acc / es.length) : null, series: s };
          })
          .sort((a, b2) => b2.attempts - a.attempts);
      };
      const byAgent = rateRows((e) => e.agent, (a) => ({ agent: a, name: this.nameOf(a) }));
      const byProject = rateRows((e) => this.repoKeyOf(e.lineage_id), () => ({}));
      // times (published candidates of the window)
      const toCommit = eps.filter((e) => e.committed_at !== null && e.committed_at >= e.started_at).map((e) => (e.committed_at! - e.started_at) / 1000);
      const toVerdict = eps.filter((e) => e.committed_at !== null && e.finalized_at !== null && e.finalized_at >= e.committed_at).map((e) => (e.finalized_at! - e.committed_at!) / 1000);
      const timeSeries = Array.from({ length: b.n }, () => ({ commit: [] as number[], verdict: [] as number[] }));
      for (const e of eps) {
        const x = timeSeries[this.slot(b, e.started_at)]!;
        if (e.committed_at !== null && e.committed_at >= e.started_at) x.commit.push((e.committed_at - e.started_at) / 1000);
        if (e.committed_at !== null && e.finalized_at !== null && e.finalized_at >= e.committed_at) x.verdict.push((e.finalized_at - e.committed_at) / 1000);
      }
      const stat = (xs: number[]) => ({ n: xs.length, median: xs.length ? r4(median(xs)!) : null, mean: xs.length ? r4(xs.reduce((s, x) => s + x, 0) / xs.length) : null });
      // tools per attempt
      // model attempts only: a scripted author applies a recipe patch without tool calls
      const modelEps = eps.filter((e) => this.modelKey(e).model !== "scripted");
      const withCalls = modelEps.filter((e) => e.calls !== null);
      const tools = {
        attempts: modelEps.length,
        scripted: eps.length - modelEps.length,
        tool_calls: stat(modelEps.map((e) => e.tool_calls)),
        reads: stat(modelEps.map((e) => e.reads)),
        searches: stat(modelEps.map((e) => e.searches)),
        lists: stat(modelEps.map((e) => e.lists)),
        edits: stat(modelEps.map((e) => e.edits)),
        evals: stat(modelEps.map((e) => e.evals)),
        turns: stat(withCalls.map((e) => e.calls!)),
        stops: Object.entries(withCalls.reduce<Record<string, number>>((m, e) => ((m[e.stop!] = (m[e.stop!] ?? 0) + 1), m), {})).map(([stop, n]) => ({ stop, n })).sort((a, c) => c.n - a.n),
      };
      // lines changed per accepted generation (the accepted candidate's canonical patch)
      const winGens = gens.filter((g) => g.accepted_at >= Math.min(since, b.start) && this.slot(b, g.accepted_at) >= 0 && g.candidate_id);
      const patches = new Map(
        this.db
          .query<{ candidate_id: string; patch: string | null }, []>("SELECT c.candidate_id, c.patch FROM candidates c JOIN generations g ON g.candidate_id = c.candidate_id WHERE c.status = 'accepted' AND g.entry_type = 'patch'")
          .all()
          .map((r) => [r.candidate_id, r.patch]),
      );
      const lines = winGens
        .map((g) => {
          const p = patches.get(g.candidate_id!);
          if (!p) return null;
          let add = 0, del = 0;
          for (const l of p.split("\n")) {
            if (l.startsWith("+") && !l.startsWith("+++")) add++;
            else if (l.startsWith("-") && !l.startsWith("---")) del++;
          }
          return { gen_id: g.gen_id, height: g.height, project: this.repoKeyOf(g.lineage_id), added: add, removed: del, lines: add + del, at: g.accepted_at };
        })
        .filter((x): x is NonNullable<typeof x> => !!x);
      // live-time share per agent per bucket: published attempts plus live sessions
      const live = this.liveSessions(include);
      const spans: { agent: string; a: number; z: number }[] = [
        ...all.map((e) => ({ agent: e.agent, a: e.started_at, z: e.ended_at ?? e.started_at })),
        ...live.filter((s) => s.agent).map((s) => ({ agent: s.agent as string, a: s.started_at as number, z: now })),
      ];
      const share = new Map<string, number[]>();
      for (const s of spans) {
        if (s.z <= b.start) continue;
        const row = share.get(s.agent) ?? share.set(s.agent, Array.from({ length: b.n }, () => 0)).get(s.agent)!;
        for (let i = Math.max(0, this.slot(b, s.a)); i < b.n; i++) {
          const lo = b.start + i * b.size, hi = lo + b.size;
          if (lo >= s.z) break;
          const ov = Math.min(s.z, hi) - Math.max(s.a, lo);
          if (ov > 0) row[i]! += ov / 60_000;
        }
      }
      const shareRows = [...share.entries()]
        .map(([agent, mins]) => ({ agent, name: this.nameOf(agent), minutes: mins.map((m) => Math.round(m * 10) / 10), total: Math.round(mins.reduce((s, m) => s + m, 0)) }))
        .filter((r) => r.total > 0)
        .sort((a, c) => c.total - a.total);
      // cross-agent conflicts per project: final candidates rejected because another generation landed first
      const CONFLICT = ["stale_conflict", "stale", "apply_conflict"];
      const conf = this.db
        .query<{ lineage_id: string; author: string; reason: string | null; t: number }, []>(
          "SELECT lineage_id, author, reason, COALESCE(finalized_at, committed_at) AS t FROM candidates WHERE status IN ('accepted', 'rejected', 'expired') AND is_canary = 0",
        )
        .all()
        .filter((c) => !off.has(c.author) && c.t >= Math.min(since, b.start));
      const confMap = new Map<string, { project: string; final: number; conflicts: number; by_reason: Record<string, number> }>();
      for (const c of conf) {
        const k = this.repoKeyOf(c.lineage_id) ?? c.lineage_id;
        const r = confMap.get(k) ?? confMap.set(k, { project: k, final: 0, conflicts: 0, by_reason: {} }).get(k)!;
        r.final++;
        if (c.reason && CONFLICT.includes(c.reason)) (r.conflicts++, (r.by_reason[c.reason] = (r.by_reason[c.reason] ?? 0) + 1));
      }
      return {
        now, window: win, since, hidden_included: include,
        axis: this.axis(b),
        source: "published learnings episodes (an attempt is counted once its episode is published), accepted generations, final candidates",
        generations: genSeries,
        outcomes: { series: outcomes, totals: OUT.reduce<Record<string, number>>((m, o) => ((m[o] = outcomes.reduce((s, x) => s + x[o]!, 0)), m), {}), stop_recorded: withCalls.length },
        rate: { by_agent: byAgent, by_project: byProject, min_attempts: MIN_ATTEMPTS_FOR_RATE },
        times: { start_to_commit_s: stat(toCommit), commit_to_verdict_s: stat(toVerdict), series: timeSeries.map((x) => ({ commit_s: x.commit.length ? Math.round(median(x.commit)!) : null, verdict_s: x.verdict.length ? Math.round(median(x.verdict)!) : null })) },
        tools,
        lines: { n: lines.length, median: lines.length ? median(lines.map((l) => l.lines)) : null, mean: lines.length ? r4(lines.reduce((s, l) => s + l.lines, 0) / lines.length) : null, rows: lines.sort((a, c) => c.at - a.at).slice(0, 100) },
        live_share: { rows: shareRows.slice(0, 12), others: shareRows.length > 12 ? shareRows.slice(12).reduce((s, r) => s + r.total, 0) : 0 },
        conflicts: [...confMap.values()].filter((r) => r.final > 0).sort((a, c) => c.conflicts - a.conflicts || c.final - a.final),
      };
    });
  }

  // --------------------------------------------------------------------------------------------- results

  /** GET /v1/analytics/results?window=&hidden=1 */
  results(q: { window?: string; hidden?: boolean }) {
    const { win, now, since } = this.win(q);
    const include = !!q.hidden;
    return this.memo(`results:${win}:${include ? 1 : 0}`, () => {
      const off = this.hiddenSet(include);
      const gens = this.gens();
      const ls = this.lineages();
      // per lineage and metric: improvement over the calibration baseline after each generation (all
      // authors: the lineage's state), and the records (each new best)
      const metrics: any[] = [];
      for (const l of ls) {
        const lg = gens.filter((g) => g.lineage_id === l.lineage_id);
        if (!lg.length) continue;
        for (const m of this.series(l, lg)) {
          if (!m.points.length || m.baseline === null || m.baseline === 0) continue;
          let best: number | null = null;
          const better = (a: number, c: number) => (m.direction === "higher" ? a > c : a < c);
          const pts = [...m.points]
            .sort((a, c) => a.at - c.at)
            .map((p) => {
              const rec = best === null ? better(p.value, m.baseline!) : better(p.value, best);
              if (best === null || better(p.value, best)) best = p.value;
              const imp = r4(((m.direction === "higher" ? best! - m.baseline! : m.baseline! - best!) / Math.abs(m.baseline!)) * 100);
              return { at: p.at, height: p.height, gen_id: p.gen_id, value: p.value, best: best!, improvement_pct: imp, record: rec };
            });
          metrics.push({ lineage_id: l.lineage_id, project: repoKey(l.repo, l.repo_id), recipe_name: l.recipe_name, metric: m.name, direction: m.direction, baseline: m.baseline, improvement_pct: pts[pts.length - 1]!.improvement_pct, records: pts.filter((p) => p.record).length, records_in_window: pts.filter((p) => p.record && p.at >= since).length, points: pts });
        }
      }
      metrics.sort((a, c) => c.improvement_pct - a.improvement_pct);
      const row = (g: GenRow) => {
        const eff = parse<any>(g.effect);
        const x = gainOf(eff);
        const l = ls.find((y) => y.lineage_id === g.lineage_id);
        return { gen_id: g.gen_id, height: g.height, project: l ? repoKey(l.repo, l.repo_id) : null, recipe_name: l?.recipe_name ?? null, metric: eff?.metric ?? null, gain_pct: r4(x.pct), fixed: x.fixed, author: g.author, author_name: this.nameOf(g.author!), accepted_at: g.accepted_at, reverted_by: g.reverted_by };
      };
      const listed = gens.filter((g) => !off.has(g.author!));
      const byGain = (xs: GenRow[]) => xs.map(row).filter((r) => r.gain_pct > 0 || r.fixed > 0).sort((a, c) => c.gain_pct - a.gain_pct || c.fixed - a.fixed);
      const week = now - 7 * DAY;
      const perProject = new Map<string, ReturnType<typeof row>>();
      for (const r of byGain(listed.filter((g) => !g.reverted_by))) if (r.project && !perProject.has(r.project)) perProject.set(r.project, r);
      // reverted and challenged generations
      const reverted = gens.filter((g) => g.reverted_by).map((g) => ({ ...row(g), author: off.has(g.author!) ? null : g.author, author_name: off.has(g.author!) ? null : this.nameOf(g.author!) }));
      const chal = this.db
        .query<{ challenge_id: string; kind: string; subject: string; status: string; opened_at: number; resolved_at: number | null; resolution: string | null }, []>("SELECT challenge_id, kind, subject, status, opened_at, resolved_at, resolution FROM challenges ORDER BY opened_at DESC")
        .all();
      const genOfCand = new Map(gens.filter((g) => g.candidate_id).map((g) => [g.candidate_id!, g]));
      const challenged = chal
        .filter((c) => c.kind === "verdict")
        .map((c) => {
          const g = genOfCand.get(c.subject);
          return { challenge_id: c.challenge_id, status: c.status, opened_at: c.opened_at, resolved_at: c.resolved_at, resolution: parse(c.resolution), generation: g ? { gen_id: g.gen_id, height: g.height, project: this.repoKeyOf(g.lineage_id), reverted_by: g.reverted_by } : null };
        });
      return {
        now, window: win, since, hidden_included: include,
        source: "counted replay medians of each unreverted accepted generation against the calibration baseline; verdict effects; challenges",
        metrics,
        wins: { week: byGain(listed.filter((g) => g.accepted_at >= week && !g.reverted_by)).slice(0, 10), window: byGain(listed.filter((g) => g.accepted_at >= since && !g.reverted_by)).slice(0, 10), all_time: byGain(listed.filter((g) => !g.reverted_by)).slice(0, 10), per_project: [...perProject.values()] },
        reverted,
        challenged,
      };
    });
  }

  // ----------------------------------------------------------------------------------------------- spend

  /** GET /v1/analytics/spend?window=&hidden=1 */
  spend(q: { window?: string; hidden?: boolean }) {
    const { win, now, since } = this.win(q);
    const include = !!q.hidden;
    return this.memo(`spend:${win}:${include ? 1 : 0}`, () => {
      const off = this.hiddenSet(include);
      const all = this.loadEpisodes().filter((e) => !off.has(e.agent));
      const b = this.bucketsOf(win, now, all.length ? Math.min(...all.map((e) => e.started_at)) : null);
      const eps = all.filter((e) => this.slot(b, e.started_at) >= 0 && e.started_at >= Math.min(since, b.start));
      const gain = (e: Episode) => (e.outcome === "accepted" && e.ratio !== null && e.ratio < 1 ? (1 - e.ratio) * 100 : 0);
      const series = Array.from({ length: b.n }, () => ({ usd: 0, priced: 0, gain_pct: 0, anthropic_usd: 0, anthropic_priced: 0, read: 0, input: 0, write: 0 }));
      for (const e of eps) {
        const x = series[this.slot(b, e.started_at)]!;
        if (e.usd !== null) {
          x.usd += e.usd;
          x.priced++;
          x.gain_pct += gain(e);
          if (this.modelKey(e).provider === "anthropic") (x.anthropic_usd += e.usd, x.anthropic_priced++);
        }
        if (e.input_tokens !== null && e.cache_read !== null) (x.read += e.cache_read, x.input += e.input_tokens, (x.write += e.cache_write ?? 0));
      }
      const hit = (r: number, i: number, w: number) => (r + i + w > 0 ? r4(r / (r + i + w)) : null);
      const tok = eps.filter((e) => e.input_tokens !== null && e.cache_read !== null);
      const sum = (xs: Episode[], k: "cache_read" | "input_tokens" | "cache_write") => xs.reduce((s, e) => s + (e[k] ?? 0), 0);
      const byModel = new Map<string, Episode[]>();
      for (const e of tok) {
        const k = JSON.stringify(this.modelKey(e));
        (byModel.get(k) ?? byModel.set(k, []).get(k)!).push(e);
      }
      const priced = eps.filter((e) => e.usd !== null);
      const usd = priced.reduce((s, e) => s + e.usd!, 0);
      const nothing = priced.filter((e) => e.outcome !== "accepted").reduce((s, e) => s + e.usd!, 0);
      const g = runtimeSpendOf(this.core).global();
      const or = (g?.body.provider_balance as any)?.openrouter ?? null;
      const samples = this.db
        .query<{ at: number; openrouter_usd: number | null }, [number]>("SELECT at, openrouter_usd FROM runtime_spend_samples WHERE agent = '' AND at >= ? ORDER BY at")
        .all(win === "all" ? 0 : Math.min(since, b.start));
      const orPts = samples.filter((s) => s.openrouter_usd !== null).map((s) => ({ at: s.at, usd: r6(s.openrouter_usd!) }));
      const day = orPts.filter((p) => p.at >= now - DAY);
      return {
        now, window: win, since, hidden_included: include,
        axis: this.axis(b),
        source: "published learnings episodes (cost.usd and token counts as attested by the hosted runtime or reported by the worker); the runtime's spend report",
        totals: { usd: priced.length ? r6(usd) : null, priced: priced.length, attempts: eps.length, nothing_usd: priced.length ? r6(nothing) : null, nothing_share: usd > 0 ? r4(nothing / usd) : null, gain_pct: r4(priced.reduce((s, e) => s + gain(e), 0)), gain_per_usd: usd > 0 ? r6(priced.reduce((s, e) => s + gain(e), 0) / usd) : null },
        series: series.map((x) => ({ usd: x.priced ? r6(x.usd) : null, priced: x.priced, gain_pct: r4(x.gain_pct), gain_per_usd: x.usd > 0 ? r6(x.gain_pct / x.usd) : null, anthropic_usd: x.anthropic_priced ? r6(x.anthropic_usd) : null, cache_hit: hit(x.read, x.input, x.write) })),
        cache: {
          attempts: tok.length,
          hit_rate: hit(sum(tok, "cache_read"), sum(tok, "input_tokens"), sum(tok, "cache_write")),
          read_tokens: sum(tok, "cache_read"), input_tokens: sum(tok, "input_tokens"), write_tokens: sum(tok, "cache_write"),
          by_model: [...byModel.entries()].map(([k, es]) => ({ ...(JSON.parse(k) as object), attempts: es.length, hit_rate: hit(sum(es, "cache_read"), sum(es, "input_tokens"), sum(es, "cache_write")) })).sort((a, c) => c.attempts - a.attempts),
        },
        anthropic: { usd: r6(priced.filter((e) => this.modelKey(e).provider === "anthropic").reduce((s, e) => s + e.usd!, 0)), attempts: priced.filter((e) => this.modelKey(e).provider === "anthropic").length },
        openrouter: {
          now: or ? { usd: typeof or.usd === "number" ? or.usd : null, read_at: or.read_at ?? null, floor_usd: or.floor_usd ?? null, configured: or.configured ?? null, error: or.error ?? null } : null,
          samples: orPts.slice(-500),
          change_24h: day.length >= 2 ? r6(day[day.length - 1]!.usd - day[0]!.usd) : null,
        },
      };
    });
  }

  // ---------------------------------------------------------------------------------------------- models

  /** GET /v1/analytics/models?window=&hidden=1: head-to-head and failure modes (the leaderboard is in the overview). */
  modelsDetail(q: { window?: string; hidden?: boolean }) {
    const { win, now, since } = this.win(q);
    const include = !!q.hidden;
    return this.memo(`models:${win}:${include ? 1 : 0}`, () => {
      const off = this.hiddenSet(include);
      const eps = this.loadEpisodes().filter((e) => !off.has(e.agent) && e.started_at >= since);
      const label = (e: Episode) => this.modelKey(e);
      const groups = new Map<string, Episode[]>();
      for (const e of eps) {
        if (!e.parent_gen_id) continue;
        const k = `${e.lineage_id}|${e.parent_gen_id}|${e.target ?? ""}`;
        (groups.get(k) ?? groups.set(k, []).get(k)!).push(e);
      }
      const heights = new Map(this.db.query<{ gen_id: string; height: number }, []>("SELECT gen_id, height FROM generations").all().map((r) => [r.gen_id, r.height]));
      const h2h = [...groups.entries()]
        .map(([k, es]) => {
          const [lineage, parent, target] = k.split("|") as [string, string, string];
          const ms = new Map<string, Episode[]>();
          for (const e of es) {
            const mk = JSON.stringify(label(e));
            (ms.get(mk) ?? ms.set(mk, []).get(mk)!).push(e);
          }
          if (ms.size < 2) return null;
          return {
            lineage_id: lineage, project: this.repoKeyOf(lineage), parent_gen_id: parent, parent_height: heights.get(parent) ?? null, target: target || null,
            last_at: Math.max(...es.map((e) => e.started_at)),
            models: [...ms.entries()].map(([mk, xs]) => {
              const pr = xs.filter((e) => e.usd !== null);
              const gains = xs.filter((e) => e.outcome === "accepted" && e.ratio !== null).map((e) => r4((1 - e.ratio!) * 100));
              return { ...(JSON.parse(mk) as { provider: string | null; model: string }), attempts: xs.length, accepted: xs.filter((e) => e.outcome === "accepted").length, best_gain_pct: gains.length ? Math.max(...gains) : null, usd: pr.length ? r6(pr.reduce((s, e) => s + e.usd!, 0)) : null, priced: pr.length };
            }).sort((a, c) => c.accepted - a.accepted || (c.best_gain_pct ?? -1) - (a.best_gain_pct ?? -1)),
          };
        })
        .filter((x): x is NonNullable<typeof x> => !!x)
        .sort((a, c) => c.last_at - a.last_at);
      const fm = new Map<string, Episode[]>();
      for (const e of eps) {
        const mk = JSON.stringify(label(e));
        (fm.get(mk) ?? fm.set(mk, []).get(mk)!).push(e);
      }
      const failures = [...fm.entries()]
        .map(([mk, es]) => {
          const bad = es.filter((e) => e.outcome !== "accepted");
          const outcomes = bad.reduce<Record<string, number>>((m, e) => ((m[this.outcomeOf(e)] = (m[this.outcomeOf(e)] ?? 0) + 1), m), {});
          const reasons = new Map<string, number>();
          for (const e of bad) {
            const why = e.outcome === "rejected" || e.outcome === "expired" ? `${e.outcome}: ${(e.reason ?? "no reason").replace(/_/g, " ")}` : e.stop ? `no candidate: ${e.stop}` : e.outcome === "abandoned" ? "abandoned" : "no candidate: stop not recorded";
            reasons.set(why, (reasons.get(why) ?? 0) + 1);
          }
          return { ...(JSON.parse(mk) as { provider: string | null; model: string }), attempts: es.length, failed: bad.length, outcomes, reasons: [...reasons.entries()].map(([reason, n]) => ({ reason, n })).sort((a, c) => c.n - a.n).slice(0, 8) };
        })
        .sort((a, c) => c.attempts - a.attempts);
      return { now, window: win, since, hidden_included: include, source: "published learnings episodes", head_to_head: h2h.slice(0, 40), head_to_head_total: h2h.length, failures };
    });
  }

  // ------------------------------------------------------------------------------------------- verifiers

  /** GET /v1/analytics/verifiers?window=&hidden=1 */
  verifiers(q: { window?: string; hidden?: boolean }) {
    const { win, now, since } = this.win(q);
    const include = !!q.hidden;
    return this.memo(`verifiers:${win}:${include ? 1 : 0}`, () => {
      const off = this.hiddenSet(include);
      const reps = this.db
        .query<{ candidate_id: string; replayer: string; role: string | null; status: string; assigned_at: number; committed_at: number | null; c_committed: number; author: string; t: number }, [number]>(
          `SELECT r.candidate_id, r.replayer, r.role, r.status, r.assigned_at, r.committed_at, c.committed_at AS c_committed, c.author, COALESCE(c.finalized_at, c.committed_at) AS t
           FROM replays r JOIN candidates c ON c.candidate_id = r.candidate_id
           WHERE c.status IN ('accepted', 'rejected', 'expired') AND c.is_canary = 0 AND r.kind IN ('replay', 'reference') AND COALESCE(c.finalized_at, c.committed_at) >= ?`,
        )
        .all(since)
        .filter((r) => !off.has(r.author));
      const per = new Map<string, typeof reps>();
      for (const r of reps) (per.get(r.replayer) ?? per.set(r.replayer, []).get(r.replayer)!).push(r);
      const rows = [...per.entries()]
        .map(([v, rs]) => {
          const counted = rs.filter((r) => r.role === "counted").length;
          const minority = rs.filter((r) => r.role === "minority").length;
          const durs = rs.filter((r) => r.committed_at !== null && r.committed_at >= r.assigned_at).map((r) => (r.committed_at! - r.assigned_at) / 1000);
          return {
            verifier: v, replays: rs.length, revealed: rs.filter((r) => r.status === "revealed").length, counted, minority, env_failed: rs.filter((r) => r.role === "env_failed").length,
            disagreement: counted + minority > 0 ? r4(minority / (counted + minority)) : null,
            mean_replay_s: durs.length ? Math.round(durs.reduce((s, x) => s + x, 0) / durs.length) : null, median_replay_s: durs.length ? Math.round(median(durs)!) : null,
          };
        })
        .sort((a, c) => c.replays - a.replays);
      const firstBy = new Map<string, { c: number; first: number }>();
      for (const r of reps) {
        if (r.committed_at === null) continue;
        const f = firstBy.get(r.candidate_id);
        if (!f || r.committed_at < f.first) firstBy.set(r.candidate_id, { c: r.c_committed, first: r.committed_at });
      }
      const waits = [...firstBy.values()].filter((x) => x.first >= x.c).map((x) => (x.first - x.c) / 1000);
      const ch = this.db
        .query<{ challenge_id: string; kind: string; subject: string; challenger: string; bond: string; status: string; opened_at: number; resolved_at: number | null; resolution: string | null }, []>(
          "SELECT challenge_id, kind, subject, challenger, bond, status, opened_at, resolved_at, resolution FROM challenges ORDER BY opened_at DESC",
        )
        .all();
      const OPEN = ["open", "replaying"];
      const sl = this.db.query<{ agent_id: string; bps: number; amount: string; reason: string; epoch: number; at: number }, []>("SELECT agent_id, bps, amount, reason, epoch, at FROM slashes ORDER BY at DESC").all().filter((s) => !off.has(s.agent_id));
      const bonds = this.db.query<{ account: string; amount: string }, []>("SELECT account, amount FROM balances WHERE account LIKE 'agent:%:bond'").all().filter((b) => !off.has(b.account.split(":")[1]!));
      const big = (xs: string[]) => xs.reduce((s, x) => s + (/^-?\d+$/.test(x) ? BigInt(x) : 0n), 0n).toString();
      return {
        now, window: win, since, hidden_included: include,
        source: "replays of final candidates (replay and reference kinds); challenges, slashes and bond balances as Core records them",
        verifiers: rows,
        replays: reps.length,
        commit_to_first_replay_s: { n: waits.length, median: waits.length ? Math.round(median(waits)!) : null, mean: waits.length ? Math.round(waits.reduce((s, x) => s + x, 0) / waits.length) : null },
        challenges: {
          opened_in_window: ch.filter((c) => c.opened_at >= since).length,
          by_status: ch.filter((c) => c.opened_at >= since).reduce<Record<string, number>>((m, c) => ((m[c.status] = (m[c.status] ?? 0) + 1), m), {}),
          by_kind: ch.filter((c) => c.opened_at >= since).reduce<Record<string, number>>((m, c) => ((m[c.kind] = (m[c.kind] ?? 0) + 1), m), {}),
          open_bonds: big(ch.filter((c) => OPEN.includes(c.status)).map((c) => c.bond)),
          open: ch.filter((c) => OPEN.includes(c.status)).length,
          recent: ch.slice(0, 20).map((c) => ({ challenge_id: c.challenge_id, kind: c.kind, subject: c.subject, challenger: c.challenger, bond: c.bond, status: c.status, opened_at: c.opened_at, resolved_at: c.resolved_at, resolution: parse(c.resolution) })),
        },
        slashes: { total: sl.length, in_window: sl.filter((s) => s.at >= since).length, amount: big(sl.map((s) => s.amount)), recent: sl.slice(0, 20) },
        bonds: { accounts: bonds.filter((b) => b.amount !== "0").length, held: big(bonds.map((b) => b.amount)) },
      };
    });
  }

  // ---------------------------------------------------------------------------------------------- social

  private org: { org: string; members: string[] | null; at: number; error: string | null } | null = null;
  private orgBusy = false;
  /** Replaceable in tests; the org's public members from GitHub (no token needed). */
  orgFetch: ((org: string) => Promise<string[]>) | null =
    process.env.NODE_ENV === "test"
      ? null
      : async (org) => {
          const r = await fetch(`https://api.github.com/orgs/${encodeURIComponent(org)}/public_members?per_page=100`, { headers: { accept: "application/vnd.github+json", "user-agent": "units-core-analytics" }, signal: AbortSignal.timeout(10_000) });
          if (!r.ok) throw new Error(`GitHub ${r.status}`);
          return ((await r.json()) as { login: string }[]).map((m) => m.login);
        };

  private orgMembers() {
    const org = process.env.UNITS_GITHUB_ORG || "units-agents";
    const now = this.core.now();
    if (this.orgFetch && !this.orgBusy && (!this.org || now - this.org.at > 30 * 60_000)) {
      this.orgBusy = true;
      const f = this.orgFetch;
      f(org)
        .then((members) => (this.org = { org, members: members.slice(0, 500), at: this.core.now(), error: null }))
        .catch((e) => (this.org = { org, members: this.org?.members ?? null, at: this.core.now(), error: String((e as Error).message).slice(0, 120) }))
        .finally(() => (this.orgBusy = false));
    }
    return this.org ? { org: this.org.org, members: this.org.members, read_at: this.org.at, error: this.org.error } : { org, members: null, read_at: null, error: null };
  }

  /** GET /v1/analytics/social?window=&hidden=1 */
  social(q: { window?: string; hidden?: boolean }) {
    const { win, now, since } = this.win(q);
    const include = !!q.hidden;
    const org = this.orgMembers();
    return this.memo(`social:${win}:${include ? 1 : 0}:${org.read_at ?? 0}`, () => {
      const off = this.hiddenSet(include);
      socialOf(this.core); // its tables
      genGithubOf(this.core);
      const wf = this.db.query<{ agent: string; stored_at: number }, []>("SELECT agent, stored_at FROM social_follows").all().filter((r) => !off.has(r.agent));
      const af = this.db.query<{ follower: string; target: string; stored_at: number }, []>("SELECT follower, target, stored_at FROM social_agent_follows").all().filter((r) => !off.has(r.follower) && !off.has(r.target));
      const hiddenPosts = socialOf(this.core).hiddenSet("post");
      const posts = this.db
        .query<{ msg_id: string; from_agent: string; received_at: number }, []>("SELECT msg_id, from_agent, received_at FROM messages WHERE board IS NOT NULL AND shadow = 0")
        .all()
        .filter((r) => !off.has(r.from_agent) && !hiddenPosts.has(r.msg_id));
      const gens = new Map(this.gens().map((g) => [g.gen_id, g]));
      const gh = this.db
        .query<{ gen_id: string; status: string; verified: number | null; published_at: number | null; repo: string | null }, []>("SELECT gen_id, status, verified, published_at, repo FROM gen_github")
        .all()
        .filter((r) => {
          const g = gens.get(r.gen_id);
          return !g || !off.has(g.author!);
        });
      const pub = gh.filter((r) => r.status === "published" && r.published_at);
      const eps = this.loadEpisodes().filter((e) => !off.has(e.agent));
      const first = Math.min(now, ...wf.map((r) => r.stored_at), ...af.map((r) => r.stored_at), ...posts.map((r) => r.received_at), ...pub.map((r) => r.published_at!), ...eps.map((e) => e.published_at));
      const b = this.bucketsOf(win, now, first);
      const series = Array.from({ length: b.n }, () => ({ wallet_follows: 0, agent_follows: 0, posts: 0, github: 0, github_verified: 0, episodes: 0, episodes_total: 0 }));
      const put = (t: number, f: (x: (typeof series)[number]) => void) => {
        const i = this.slot(b, t);
        if (i >= 0) f(series[i]!);
      };
      for (const r of wf) put(r.stored_at, (x) => x.wallet_follows++);
      for (const r of af) put(r.stored_at, (x) => x.agent_follows++);
      for (const r of posts) put(r.received_at, (x) => x.posts++);
      for (const r of pub) put(r.published_at!, (x) => (x.github++, r.verified === 1 && x.github_verified++));
      for (const e of eps) put(e.published_at, (x) => x.episodes++);
      let run = eps.filter((e) => e.published_at < b.start).length;
      for (const x of series) x.episodes_total = run += x.episodes;
      const orgRepos = new Set(pub.filter((r) => r.repo?.toLowerCase().startsWith(`${org.org.toLowerCase()}/`)).map((r) => r.repo!));
      return {
        now, window: win, since, hidden_included: include,
        axis: this.axis(b),
        series,
        totals: {
          wallet_follows: wf.length, agent_follows: af.length, posts: posts.length, posts_in_window: posts.filter((p) => p.received_at >= since).length,
          github_published: pub.length, github_verified: pub.filter((r) => r.verified === 1).length, github_awaiting: gh.filter((r) => r.status !== "published").length,
          episodes: eps.length, episodes_in_window: eps.filter((e) => e.published_at >= since).length,
          learnings_repos: this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM learnings_repos").get()!.n,
        },
        org: { ...org, repos_with_generations: orgRepos.size },
      };
    });
  }

  // -------------------------------------------------------------------------------------------- launches

  /** GET /v1/analytics/launches?window=&hidden=1 */
  launches(q: { window?: string; hidden?: boolean }) {
    const { win, now, since } = this.win(q);
    const include = !!q.hidden;
    return this.memo(`launches:${win}:${include ? 1 : 0}`, () => {
      const off = this.hiddenSet(include);
      const tests = this.testLaunches();
      const agents = this.db
        .query<{ agent_id: string; registered_at: number; mint: string | null; identity_mode: string | null; hosted: number }, []>("SELECT agent_id, registered_at, mint, identity_mode, hosted FROM agents WHERE kind = 'launched' AND shadow = 0")
        .all()
        .filter((a) => !off.has(a.agent_id));
      const soulModel = new Map<string, string>();
      for (const r of this.db.query<{ agent: string; doc: string }, []>("SELECT agent, doc FROM souls ORDER BY seq").all()) {
        const m = parse<any>(r.doc)?.model;
        if (m && typeof m.id === "string") soulModel.set(r.agent, `${typeof m.provider === "string" ? `${m.provider}/` : ""}${m.id}`);
      }
      const spend = new Map(runtimeSpendOf(this.core).all().map((r) => [r.agent, r]));
      const modelOf = (a: string) => {
        if (soulModel.has(a)) return { model: soulModel.get(a)!, source: "soul" };
        const m = spend.get(a)?.spend.model;
        if (m && typeof m.id === "string") return { model: `${m.provider}/${m.id}`, source: "runtime" };
        return { model: "not declared", source: null };
      };
      const prepay = new Map(
        this.db
          .query<{ agent_id: string; mint: string | null; launched_at: number | null; deposit: string; initial_buy: string | null; supply: string | null }, []>("SELECT agent_id, mint, launched_at, deposit, initial_buy, supply FROM prepay")
          .all()
          .map((r) => [r.agent_id, r]),
      );
      // the compute vault as Core mirrored it from chain: each change, in order
      const ids = new Set(agents.map((a) => a.agent_id));
      const ledger = this.db
        .query<{ account: string; delta: string; at: number }, []>("SELECT account, delta, at FROM ledger_entries WHERE reason = 'chain_compute' AND account LIKE 'agent:%:compute' ORDER BY id")
        .all()
        .map((r) => ({ agent: r.account.split(":")[1]!, delta: /^-?\d+$/.test(r.delta) ? BigInt(r.delta) : 0n, at: r.at }))
        .filter((r) => ids.has(r.agent));
      const first = Math.min(now, ...agents.map((a) => a.registered_at), ...ledger.map((l) => l.at));
      const b = this.bucketsOf(win, now, first);
      const modes = [...new Set(agents.map((a) => a.identity_mode ?? "not recorded"))].sort();
      const models = [...new Set(agents.map((a) => modelOf(a.agent_id).model))].sort();
      const series = Array.from({ length: b.n }, () => ({ launches: 0, by_mode: Object.fromEntries(modes.map((m) => [m, 0])) as Record<string, number>, by_model: Object.fromEntries(models.map((m) => [m, 0])) as Record<string, number>, fronted: 0n, increases: 0n, increase_count: 0 }));
      for (const a of agents) {
        const i = this.slot(b, a.registered_at);
        if (i < 0) continue;
        const x = series[i]!;
        x.launches++;
        x.by_mode[a.identity_mode ?? "not recorded"]!++;
        x.by_model[modelOf(a.agent_id).model]!++;
      }
      for (const p of prepay.values()) {
        if (!ids.has(p.agent_id) || !p.launched_at) continue;
        const i = this.slot(b, p.launched_at * 1000);
        if (i >= 0 && /^\d+$/.test(p.deposit)) series[i]!.fronted += BigInt(p.deposit);
      }
      const bal = new Map<string, bigint>();
      const before = new Map<string, bigint>();
      const endOfBucket = new Map<string, (bigint | null)[]>();
      for (const l of ledger) {
        const v = (bal.get(l.agent) ?? 0n) + l.delta;
        bal.set(l.agent, v);
        const i = this.slot(b, l.at);
        if (l.delta > 0n && i >= 0) (series[i]!.increases += l.delta, series[i]!.increase_count++);
        const row = endOfBucket.get(l.agent) ?? endOfBucket.set(l.agent, Array.from({ length: b.n }, () => null)).get(l.agent)!;
        if (l.at < b.start) before.set(l.agent, v);
        else if (i >= 0) row[i] = v;
      }
      // a vault before the window opens it; each vault carries forward through buckets without a change
      for (const [a, row] of endOfBucket) {
        if (row[0] === null) row[0] = before.get(a) ?? null;
        for (let i = 1; i < row.length; i++) if (row[i] === null) row[i] = row[i - 1]!;
      }
      const gensBy = new Map<string, number[]>();
      for (const g of this.gens()) {
        if (!ids.has(g.author!)) continue;
        const d = Math.floor(g.accepted_at / DAY) * DAY;
        const r = gensBy.get(g.author!) ?? gensBy.set(g.author!, []).get(g.author!)!;
        r.push(d);
      }
      const rows = agents
        .map((a) => {
          const p = prepay.get(a.agent_id);
          const s = spend.get(a.agent_id)?.spend;
          const days = gensBy.get(a.agent_id) ?? [];
          const per = new Map<number, number>();
          for (const d of days) per.set(d, (per.get(d) ?? 0) + 1);
          return {
            agent: a.agent_id, name: this.nameOf(a.agent_id), mint: a.mint, registered_at: a.registered_at, identity_mode: a.identity_mode, hosted: !!a.hosted, test_launch: tests.has(a.agent_id), ...modelOf(a.agent_id),
            deposit: p?.deposit ?? null, initial_buy: p?.initial_buy ?? null, supply: p?.supply ?? null, launched_at: p?.launched_at ? p.launched_at * 1000 : null,
            vault: bal.has(a.agent_id) ? bal.get(a.agent_id)!.toString() : null, vault_usd: typeof s?.vault_usd === "number" ? s.vault_usd : null,
            vault_series: endOfBucket.get(a.agent_id)?.map((v) => (v === null ? null : v.toString())) ?? null,
            generations: days.length, generations_daily: [...per.entries()].sort((x, y) => x[0] - y[0]).map(([day, n]) => ({ day: dayOf(day), n })),
          };
        })
        .sort((x, y) => y.registered_at - x.registered_at);
      return {
        now, window: win, since, hidden_included: include,
        axis: this.axis(b),
        source: "launched agents, their newest soul, the launch fronting record (prepay) and the compute vault as Core mirrors it from chain (base units of the quote token)",
        modes, models,
        series: series.map((x) => ({ launches: x.launches, by_mode: x.by_mode, by_model: x.by_model, fronted: x.fronted.toString(), increases: x.increases.toString(), increase_count: x.increase_count })),
        totals: { agents: agents.length, in_window: agents.filter((a) => a.registered_at >= since).length, fronted: prepay.size ? [...prepay.values()].filter((p) => ids.has(p.agent_id) && /^\d+$/.test(p.deposit)).reduce((s, p) => s + BigInt(p.deposit), 0n).toString() : "0" },
        agents: rows,
      };
    });
  }

  // ------------------------------------------------------------------------------------------- dashboard

  /**
   * GET /v1/analytics/dashboard?window=24h|7d|30d|all&hidden=1 (plan section 6): everything the
   * Analytics page draws, as bucket aggregates. A window is its buckets (hours over 24 h, UTC days
   * otherwise), so each headline figure equals the sum of its series; `prev` is the same number of
   * buckets before the window (none for "all"). Scripted attempts (a recipe patch applied without a
   * model) are counted apart from model attempts. Sources and the sealing rule are the file's: published
   * episodes, accepted generations, replays of final candidates, live sessions, the runtime's report.
   */
  dashboard(q: { window?: string; hidden?: boolean }) {
    const { win, now } = this.win(q);
    const include = !!q.hidden;
    return this.memo(`dashboard:${win}:${include ? 1 : 0}`, () => {
      const off = this.hiddenSet(include);
      const tests = this.testLaunches();
      const all = this.loadEpisodes().filter((e) => !off.has(e.agent));
      const gensAll = this.gens().filter((g) => !off.has(g.author!));
      let first: number | null = null;
      for (const e of all) if (first === null || e.started_at < first) first = e.started_at;
      for (const g of gensAll) if (first === null || g.accepted_at < first) first = g.accepted_at;
      const b = this.bucketsOf(win, now, first);
      const from = b.start;
      const to = b.start + b.n * b.size;
      const prev = win === "all" ? null : { from: from - b.n * b.size, to: from };
      const inR = (t: number) => t >= from && t < to;
      const inP = (t: number) => !!prev && t >= prev.from && t < prev.to;
      const scripted = (e: Episode) => this.modelKey(e).model === "scripted";
      const gain = (e: Episode) => (e.outcome === "accepted" && e.ratio !== null && e.ratio < 1 ? (1 - e.ratio) * 100 : 0);
      const arr = <T,>(f: () => T) => Array.from({ length: b.n }, f);
      const sum = (xs: number[]) => xs.reduce((s2, x) => s2 + x, 0);

      // attempts by outcome per bucket, model attempts and scripted attempts apart
      const OUT = ["accepted", "rejected", "cap_reached", "no_candidate", "expired", "abandoned"];
      const zero = () => Object.fromEntries(OUT.map((o) => [o, 0])) as Record<string, number>;
      const eps = all.filter((e) => inR(e.started_at));
      const peps = all.filter((e) => inP(e.started_at));
      const mEps = eps.filter((e) => !scripted(e));
      const pmEps = peps.filter((e) => !scripted(e));
      const mSeries = arr(zero), sSeries = arr(zero);
      for (const e of eps) (scripted(e) ? sSeries : mSeries)[this.slot(b, e.started_at)]![this.outcomeOf(e)]!++;
      const totalsOf = (xs: Record<string, number>[]) => OUT.reduce<Record<string, number>>((m, o) => ((m[o] = sum(xs.map((x) => x[o]!))), m), {});
      const rate = (acc: number, n: number) => (n > 0 ? r4(acc / n) : null);
      const accN = (xs: Episode[]) => xs.filter((e) => e.outcome === "accepted").length;

      // spend and cost per accepted improvement per bucket (priced attempts only)
      const sp = arr(() => ({ usd: 0, priced: 0, accepted: 0, gain: 0 }));
      for (const e of eps) {
        if (e.usd === null) continue;
        const x = sp[this.slot(b, e.started_at)]!;
        x.usd += e.usd;
        x.priced++;
        if (e.outcome === "accepted") (x.accepted++, (x.gain += gain(e)));
      }
      let cu = 0, ca = 0;
      const running = sp.map((x) => ((cu += x.usd), (ca += x.accepted), x.priced || cu > 0 ? (ca > 0 ? r6(cu / ca) : null) : null));
      const cost = this.costOf(eps), pcost = this.costOf(peps);

      // verified improvements: accepted generations of the window as events, and what came before it
      const ls = this.lineages();
      const projOf = new Map(ls.map((l) => [l.lineage_id, repoKey(l.repo, l.repo_id)]));
      const genSeries = arr(() => 0);
      const projects = new Map<string, { project: string; first_at: number; before: number; before_gain_pct: number; generations: number; gain_pct: number }>();
      const events: { at: number; project: string; gen_id: string; height: number; metric: string | null; gain_pct: number; fixed: number; agent: string; name: string | null }[] = [];
      let prevGens = 0, prevGain = 0;
      for (const g of gensAll) {
        if (g.reverted_by || g.accepted_at >= to) continue;
        const project = projOf.get(g.lineage_id) ?? g.lineage_id;
        const eff = parse<any>(g.effect);
        const x = gainOf(eff);
        const p = projects.get(project) ?? projects.set(project, { project, first_at: g.accepted_at, before: 0, before_gain_pct: 0, generations: 0, gain_pct: 0 }).get(project)!;
        if (g.accepted_at < from) {
          p.before++;
          p.before_gain_pct += x.pct;
          if (inP(g.accepted_at)) (prevGens++, (prevGain += x.pct));
          continue;
        }
        p.generations++;
        p.gain_pct += x.pct;
        genSeries[this.slot(b, g.accepted_at)]!++;
        events.push({ at: g.accepted_at, project, gen_id: g.gen_id, height: g.height, metric: eff?.metric ?? null, gain_pct: r4(x.pct), fixed: x.fixed, agent: g.author!, name: this.nameOf(g.author!) });
      }
      events.sort((a, c) => a.at - c.at);

      // live time per agent per bucket (model attempts and live sessions), and who was in an attempt
      const live = this.liveSessions(include);
      const liveAgents = new Set(live.map((s) => s.agent as string).filter(Boolean));
      const spans: { agent: string; a: number; z: number }[] = [
        ...all.filter((e) => !scripted(e)).map((e) => ({ agent: e.agent, a: e.started_at, z: Math.max(e.started_at, e.ended_at ?? e.started_at) })),
        ...live.filter((s) => s.agent).map((s) => ({ agent: s.agent as string, a: s.started_at as number, z: now })),
      ];
      const minutes = new Map<string, number[]>();
      const active = arr(() => new Set<string>());
      const prevActive = new Set<string>();
      for (const s of spans) {
        if (prev && s.z >= prev.from && s.a < prev.to) prevActive.add(s.agent);
        if (s.z < from || s.a >= to) continue;
        const row = minutes.get(s.agent) ?? minutes.set(s.agent, arr(() => 0)).get(s.agent)!;
        const i0 = Math.max(0, this.slot(b, Math.max(s.a, from)));
        for (let i = i0; i < b.n; i++) {
          const lo = b.start + i * b.size, hi = lo + b.size;
          if (lo > s.z) break;
          active[i]!.add(s.agent);
          const ov = Math.min(s.z, hi) - Math.max(s.a, lo);
          if (ov > 0) row[i]! += ov / 60_000;
        }
      }
      const activeAll = new Set<string>();
      for (const set of active) for (const a of set) activeAll.add(a);

      // per agent: attempts, spend, generations, live time, runway (the runtime's report)
      const spend = runtimeSpendOf(this.core);
      const reports = new Map(spend.all().filter((r) => !off.has(r.agent)).map((r) => [r.agent, r]));
      const ids = new Set<string>([...eps.map((e) => e.agent), ...minutes.keys(), ...reports.keys(), ...events.map((e) => e.agent)]);
      const agents = [...ids]
        .map((agent) => {
          const mine = eps.filter((e) => e.agent === agent);
          const mm = mine.filter((e) => !scripted(e));
          const c = this.costOf(mine);
          const rp = reports.get(agent)?.spend as Record<string, any> | undefined;
          const mins = minutes.get(agent) ?? arr(() => 0);
          return {
            agent, name: this.nameOf(agent), test_launch: tests.has(agent), live: liveAgents.has(agent),
            attempts: mm.length, scripted: mine.length - mm.length, accepted: accN(mm), rate: mm.length >= MIN_ATTEMPTS_FOR_RATE ? r4(accN(mm) / mm.length) : null,
            usd: c.usd, usd_per_accepted: c.usd_per_accepted, gain_pct: c.gain_pct,
            generations: events.filter((e) => e.agent === agent).length,
            minutes: mins.map((m) => Math.round(m * 10) / 10), live_minutes: Math.round(sum(mins)),
            runway: rp ? { vault_usd: rp.vault_usd ?? null, burn_usd_per_h: rp.burn_usd_per_h ?? null, runway_h: rp.runway_h ?? null, waiting: rp.waiting ?? null, reported_at: reports.get(agent)!.reported_at } : null,
          };
        })
        .sort((a, c) => c.live_minutes - a.live_minutes || c.attempts - a.attempts || a.agent.localeCompare(c.agent));

      // models (model attempts of the window)
      const byModel = new Map<string, Episode[]>();
      for (const e of mEps) {
        const k = JSON.stringify(this.modelKey(e));
        (byModel.get(k) ?? byModel.set(k, []).get(k)!).push(e);
      }
      const models = [...byModel.entries()]
        .map(([k, es]) => {
          const mk = JSON.parse(k) as { provider: string | null; model: string };
          const c = this.costOf(es);
          const durs = es.filter((e) => e.ended_at !== null && e.ended_at >= e.started_at).map((e) => (e.ended_at! - e.started_at) / 1000);
          return {
            provider: mk.provider, model: mk.model, attempts: es.length, accepted: c.accepted, priced: c.priced, usd: c.usd, gain_pct: c.gain_pct,
            rate: es.length >= MIN_ATTEMPTS_FOR_RATE ? r4(c.accepted / es.length) : null,
            gain_per_usd: c.usd !== null && c.usd > 0 && c.accepted >= MIN_ACCEPTED_FOR_MEANS ? r6(c.gain_pct / c.usd) : null,
            usd_per_accepted: c.usd_per_accepted, median_duration_s: durs.length ? Math.round(median(durs)!) : null,
          };
        })
        .sort((a, c) => c.attempts - a.attempts || a.model.localeCompare(c.model));

      // why model attempts ended without a generation
      const reasons = new Map<string, { outcome: string; reason: string; n: number; usd: number; priced: number }>();
      for (const e of mEps) {
        if (e.outcome === "accepted") continue;
        const o = this.outcomeOf(e);
        const why = e.outcome === "rejected" || e.outcome === "expired" ? (e.reason ?? e.outcome) : e.stop ? e.stop : e.worker_outcome ? e.worker_outcome.split(/[:;(\[]/)[0]!.trim().slice(0, 80) || "no candidate" : "no worker report";
        const r = reasons.get(`${o}|${why}`) ?? reasons.set(`${o}|${why}`, { outcome: o, reason: why, n: 0, usd: 0, priced: 0 }).get(`${o}|${why}`)!;
        r.n++;
        if (e.usd !== null) ((r.usd += e.usd), r.priced++);
      }

      // verification: replays of final candidates, by the time the replay was revealed (or committed, or assigned)
      const reps = this.db
        .query<{ candidate_id: string; replayer: string; role: string | null; assigned_at: number; committed_at: number | null; revealed_at: number | null; c_committed: number; author: string }, [number]>(
          `SELECT r.candidate_id, r.replayer, r.role, r.assigned_at, r.committed_at, r.revealed_at, c.committed_at AS c_committed, c.author
           FROM replays r JOIN candidates c ON c.candidate_id = r.candidate_id
           WHERE c.status IN ('accepted', 'rejected', 'expired') AND c.is_canary = 0 AND r.kind IN ('replay', 'reference') AND COALESCE(r.revealed_at, r.committed_at, r.assigned_at) >= ?`,
        )
        .all(prev?.from ?? from)
        .filter((r) => !off.has(r.author))
        .map((r) => ({ ...r, t: r.revealed_at ?? r.committed_at ?? r.assigned_at }));
      const ROLE = ["counted", "minority", "env_failed"];
      const vSeries = arr(() => ({ counted: 0, minority: 0, env_failed: 0, other: 0 }) as Record<string, number>);
      const agree = (xs: { role: string | null }[]) => {
        const c = xs.filter((r) => r.role === "counted").length, m = xs.filter((r) => r.role === "minority").length;
        return c + m > 0 ? r4(c / (c + m)) : null;
      };
      const wReps = reps.filter((r) => inR(r.t));
      for (const r of wReps) vSeries[this.slot(b, r.t)]![r.role && ROLE.includes(r.role) ? r.role : "other"]!++;
      const per = new Map<string, typeof wReps>();
      for (const r of wReps) (per.get(r.replayer) ?? per.set(r.replayer, []).get(r.replayer)!).push(r);
      const firstBy = new Map<string, { c: number; first: number }>();
      for (const r of wReps) {
        if (r.committed_at === null) continue;
        const f = firstBy.get(r.candidate_id);
        if (!f || r.committed_at < f.first) firstBy.set(r.candidate_id, { c: r.c_committed, first: r.committed_at });
      }
      const waits = [...firstBy.values()].filter((x) => x.first >= x.c).map((x) => (x.first - x.c) / 1000);

      // live sessions with their viewers, and viewers over time (hourly peaks of the gate's counts)
      const vw = viewersOf(this.core);
      const vNow = vw.now(include);
      const vBy = new Map((vNow?.sessions ?? []).map((x) => [x.session_id, x.viewers]));
      const hourly = vw.hourly(prev?.from ?? from, include);
      const vPeak = arr(() => null as number | null);
      let prevPeak: number | null = null;
      for (const h of hourly) {
        const i = this.slot(b, h.hour);
        if (i >= 0) vPeak[i] = Math.max(vPeak[i] ?? 0, h.peak);
        else if (inP(h.hour)) prevPeak = Math.max(prevPeak ?? 0, h.peak);
      }
      const peaks = vPeak.filter((x): x is number => x !== null);

      const mTot = totalsOf(mSeries), sTot = totalsOf(sSeries);
      const mAtt = sum(Object.values(mTot));
      return {
        now, window: win, hidden_included: include,
        axis: this.axis(b),
        range: { from, to },
        prev,
        first_record_at: first,
        thresholds: { min_attempts_for_rate: MIN_ATTEMPTS_FOR_RATE, min_accepted_for_means: MIN_ACCEPTED_FOR_MEANS },
        source: "published learnings episodes, accepted generations, replays of final candidates, live sessions, the runtime's spend report, the gate's viewer counts",
        kpis: {
          improvements: { value: events.length, prev: prev ? prevGens : null, series: genSeries, gain_pct: r4(sum(events.map((e) => e.gain_pct))), prev_gain_pct: prev ? r4(prevGain) : null },
          acceptance: { value: rate(mTot.accepted!, mAtt), prev: prev ? rate(accN(pmEps), pmEps.length) : null, series: mSeries.map((x) => rate(x.accepted!, sum(Object.values(x)))), attempts: mAtt, accepted: mTot.accepted!, prev_attempts: prev ? pmEps.length : null },
          spend: { value: cost.usd, prev: prev ? pcost.usd : null, series: sp.map((x) => (x.priced ? r6(x.usd) : null)), priced: cost.priced },
          cost_per_accepted: { value: cost.usd_per_accepted, prev: prev ? pcost.usd_per_accepted : null, series: sp.map((x) => (x.accepted > 0 ? r6(x.usd / x.accepted) : null)), running, accepted: sum(sp.map((x) => x.accepted)) },
          agents: { value: activeAll.size, prev: prev ? prevActive.size : null, series: active.map((x) => x.size), live_now: liveAgents.size },
          viewers: { value: vNow ? vNow.total : null, sampled_at: vNow?.at ?? null, peak: peaks.length ? Math.max(...peaks) : null, prev_peak: prev ? prevPeak : null, series: vPeak, since: vw.since() },
        },
        attempts: { outcomes: OUT, model: mSeries, scripted: sSeries, totals: { model: mTot, scripted: sTot } },
        spend: sp.map((x) => ({ usd: x.priced ? r6(x.usd) : null, priced: x.priced, accepted: x.accepted, gain_pct: r4(x.gain) })),
        improvements: {
          projects: [...projects.values()].sort((a, c) => a.first_at - c.first_at || a.project.localeCompare(c.project)).map((p) => ({ ...p, before_gain_pct: r4(p.before_gain_pct), gain_pct: r4(p.gain_pct) })),
          events: events.slice(-2000),
          wins: [...events].filter((e) => e.gain_pct > 0 || e.fixed > 0).sort((a, c) => c.gain_pct - a.gain_pct || c.fixed - a.fixed).slice(0, 10),
        },
        models,
        agents,
        reasons: [...reasons.values()].map((r) => ({ outcome: r.outcome, reason: r.reason, n: r.n, usd: r.priced ? r6(r.usd) : null })).sort((a, c) => c.n - a.n).slice(0, 12),
        verification: {
          series: vSeries,
          agreement_series: vSeries.map((x) => (x.counted! + x.minority! > 0 ? r4(x.counted! / (x.counted! + x.minority!)) : null)),
          replays: wReps.length,
          prev_replays: prev ? reps.filter((r) => inP(r.t)).length : null,
          agreement: agree(wReps),
          prev_agreement: prev ? agree(reps.filter((r) => inP(r.t))) : null,
          commit_to_first_replay_s: { n: waits.length, median: waits.length ? Math.round(median(waits)!) : null },
          verifiers: [...per.entries()]
            .map(([v, rs]) => {
              const counted = rs.filter((r) => r.role === "counted").length, minority = rs.filter((r) => r.role === "minority").length;
              const durs = rs.filter((r) => r.committed_at !== null && r.committed_at >= r.assigned_at).map((r) => (r.committed_at! - r.assigned_at) / 1000);
              return { verifier: v, replays: rs.length, counted, minority, env_failed: rs.filter((r) => r.role === "env_failed").length, disagreement: counted + minority > 0 ? r4(minority / (counted + minority)) : null, median_replay_s: durs.length ? Math.round(median(durs)!) : null };
            })
            .sort((a, c) => c.replays - a.replays || a.verifier.localeCompare(c.verifier)),
        },
        live: live
          .filter((s) => s.agent)
          .map((s) => ({ session_id: s.session_id as string, agent: s.agent as string, name: this.nameOf(s.agent as string), project: projOf.get(s.lineage_id as string) ?? null, started_at: s.started_at as number, desktop: !!s.desktop, viewers: vNow ? (vBy.get(s.session_id as string) ?? 0) : null }))
          .sort((a, c) => (c.viewers ?? 0) - (a.viewers ?? 0) || a.started_at - c.started_at),
      };
    });
  }

  // ------------------------------------------------------------------------------------------- protocol revenue

  /**
   * GET /v1/analytics/revenue?window=24h|7d|30d|all&hidden=1 (plan section 7): what flowed to
   * protocol-controlled accounts, from records only, in the denomination each was paid in (the quote
   * token, or SOL for units accounts) and in US dollars beside it ("_usd"). Core prices nothing itself:
   * the dollar price is the market indexer's reading (revenue.ts usd()). A creator-fee crank is converted
   * at the price the indexer had stored for its own time where it had one; every other record, and a
   * crank without one, at the current reading. `usd.basis` says which ("at_time", "current", "mixed");
   * with no reading every "_usd" field is null and `usd.reason` says why. Sources with a time per record are
   * bucketed like the dashboard (a window is its buckets, `prev` is the same number of buckets before):
   *   creator_fees     the treasury's share of each crank_pump_fees (the indexer's FeesCranked events)
   *   slashes          bond slashed into the reserve (Core's slashes; in chain mode once sent; a slash
   *                    a challenge reversed is left out)
   *   challenge_bonds  the bond of a failed challenge, kept by the reserve
   *   identity         units account payments in SOL (the identity service's records)
   * The compute sink (debit_compute) has only a running total per token on chain (AgentLaunch.debited):
   * it is served as that total, outside the windowed figures. A launch on the hidden list is left out
   * unless hidden=1. A source Core has no copy of is `available: false`, never a zero.
   */
  revenue(q: { window?: string; hidden?: boolean }) {
    const { win, now } = this.win(q);
    const include = !!q.hidden;
    return this.memo(`revenue:${win}:${include ? 1 : 0}`, () => {
      const rev = revenueOf(this.core);
      const off = this.hiddenSet(include);
      const offMints = include ? new Set<string>() : hiddenOf(this.core).mints();
      const listed = (agent: string, mint?: string | null) => !off.has(agent) && !(mint && offMints.has(mint));
      const idx = rev.source("indexer");
      const idn = rev.source("identity");
      const decRaw = idx?.meta?.quote_decimals;
      const dec = typeof decRaw === "number" ? decRaw : null;
      const big = (v: string | null | undefined) => (v && /^\d+$/.test(v) ? BigInt(v) : 0n);
      const uiQ = (v: bigint) => (dec === null ? null : Number(v) / 10 ** dec);
      const uiSol = (v: bigint) => Number(v) / 1e9;
      const has = (t: string) => !!this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);

      // records with a time (ms) and an amount, per source
      type Ev = { t: number | null; v: bigint; agent: string; rate?: number | null };
      const cranks = rev.cranks().filter((c) => listed(c.agent, c.mint));
      const fees: Ev[] = cranks.map((c) => ({ t: c.time === null ? null : c.time * 1000, v: big(c.to_protocol), agent: c.agent, rate: c.quote_usd }));
      // US dollars: the indexer's reading (revenue.ts); a record with a stored price of its own time uses it, the rest the current one
      const reading = rev.usd();
      const curQ = reading.ok ? reading.quote_usd : null;
      const curSol = reading.ok ? reading.sol_usd : null;
      let usdAtTime = 0, usdCurrent = 0;
      const addUsd = (acc: number | null, v: number | null, rate: number | null) => (acc === null || v === null || rate === null ? null : acc + v * rate);
      const slashRows = this.core.chainMode
        ? this.db
            .query<{ id: number; agent_id: string; amount: string; at: number }, []>(
              "SELECT s.id, s.agent_id, s.amount, COALESCE(c.posted_at, s.at) AS at FROM slashes s JOIN chain_slashes c ON c.slash_id = s.id WHERE c.signature IS NOT NULL ORDER BY s.id",
            )
            .all()
        : this.db.query<{ id: number; agent_id: string; amount: string; at: number }, []>("SELECT id, agent_id, amount, at FROM slashes ORDER BY id").all();
      const reversed = new Set(has("slash_reversals") ? this.db.query<{ slash_row: number }, []>("SELECT slash_row FROM slash_reversals").all().map((r) => r.slash_row) : []);
      const slashes: Ev[] = slashRows.filter((r) => !reversed.has(r.id) && big(r.amount) > 0n && listed(r.agent_id)).map((r) => ({ t: r.at, v: big(r.amount), agent: r.agent_id }));
      const bonds: Ev[] = has("challenges")
        ? this.db
            .query<{ challenger: string; bond: string; opened_at: number; resolved_at: number | null }, []>(
              "SELECT challenger, bond, opened_at, resolved_at FROM challenges WHERE status = 'failed' AND (source != 'chain' OR chain_status = 'failed') ORDER BY opened_at",
            )
            .all()
            .filter((r) => listed(r.challenger))
            .map((r) => ({ t: r.resolved_at ?? r.opened_at, v: big(r.bond), agent: r.challenger }))
        : [];
      const pays = rev.payments().filter((p) => listed(p.agent, p.mint));
      const identity: Ev[] = pays.map((p) => ({ t: p.launched_at * 1000, v: big(p.lamports), agent: p.agent }));

      let first: number | null = null;
      for (const e of [...fees, ...slashes, ...bonds, ...identity]) if (e.t !== null && (first === null || e.t < first)) first = e.t;
      const b = this.bucketsOf(win, now, first);
      const from = b.start;
      const to = b.start + b.n * b.size;
      const prev = win === "all" ? null : { from: from - b.n * b.size, to: from };
      const agg = (evs: Ev[], ui: (v: bigint) => number | null = uiQ, cur: number | null = curQ) => {
        const series = Array.from({ length: b.n }, () => 0n);
        const usd = { series: Array.from({ length: b.n }, (): number | null => 0), value: 0 as number | null, before: 0 as number | null, lifetime: 0 as number | null };
        let value = 0n, before = 0n, lifetime = 0n, records = 0, undated = 0;
        for (const e of evs) {
          lifetime += e.v;
          const rate = e.rate ?? cur;
          if (e.v > 0n) e.rate != null ? usdAtTime++ : usdCurrent++;
          usd.lifetime = addUsd(usd.lifetime, ui(e.v), rate);
          if (e.t === null) {
            undated++;
            continue;
          }
          const i = this.slot(b, e.t);
          if (i >= 0) (series[i]! += e.v), (value += e.v), records++, (usd.series[i] = addUsd(usd.series[i]!, ui(e.v), rate)), (usd.value = addUsd(usd.value, ui(e.v), rate));
          else if (prev && e.t >= prev.from && e.t < prev.to) (before += e.v), (usd.before = addUsd(usd.before, ui(e.v), rate));
        }
        return { series, value, before, lifetime, records, undated, lifetime_records: evs.length, usd };
      };
      const chain = (this.core.chainMode ? this.core.chainView?.() : null) as { line_mint?: string; launch?: { agent_compute_bps?: number; protocol_bps?: number; compute_sink?: string } | null; vault_addresses?: { treasury?: string; reserve?: string } } | null;
      const fronting = prepayOf(this.core).frontingView() as { identity_account_price_lamports?: string | null; identity_account_recipient?: string | null };
      const accounts = {
        treasury: chain?.vault_addresses?.treasury ?? null,
        reserve: chain?.vault_addresses?.reserve ?? null,
        compute_sink: chain?.launch?.compute_sink ?? null,
        identity_recipient: fronting.identity_account_recipient ?? pays[0]?.recipient ?? null,
      };
      const quoteSrc = (id: string, account: string | null, evs: Ev[], available: boolean, as_of: number | null, error: string | null) => {
        const a = agg(evs);
        return {
          id, denom: "quote" as const, account, available, as_of, error,
          value: uiQ(a.value), value_raw: a.value.toString(), prev: prev ? uiQ(a.before) : null, prev_raw: prev ? a.before.toString() : null, records: a.records,
          lifetime: uiQ(a.lifetime), lifetime_raw: a.lifetime.toString(), lifetime_records: a.lifetime_records, undated: a.undated,
          series: a.series.map(uiQ), series_raw: a.series.map(String),
          value_usd: a.usd.value, prev_usd: prev ? a.usd.before : null, lifetime_usd: a.usd.lifetime, series_usd: a.usd.series,
        };
      };
      const feeSrc = quoteSrc("creator_fees", accounts.treasury, fees, !!idx?.ok_at, idx?.ok_at ?? null, idx?.ok_at ? idx.error : (idx?.error ?? "no market indexer configured for this Core (UNITS_INDEXER_URL)"));
      const slashSrc = quoteSrc("slashes", accounts.reserve, slashes, true, now, null);
      const bondSrc = quoteSrc("challenge_bonds", accounts.reserve, bonds, true, now, null);
      const ia = agg(identity, uiSol, curSol);
      const idSrc = {
        id: "identity", denom: "sol" as const, account: accounts.identity_recipient, available: !!idn?.ok_at, as_of: idn?.ok_at ?? null,
        error: idn?.ok_at ? idn.error : (idn?.error ?? "no identity service configured for this Core (UNITS_IDENTITY_URL)"),
        value: uiSol(ia.value), value_raw: ia.value.toString(), prev: prev ? uiSol(ia.before) : null, prev_raw: prev ? ia.before.toString() : null, records: ia.records,
        lifetime: uiSol(ia.lifetime), lifetime_raw: ia.lifetime.toString(), lifetime_records: ia.lifetime_records, undated: 0,
        series: ia.series.map(uiSol), series_raw: ia.series.map(String),
        value_usd: ia.usd.value, prev_usd: prev ? ia.usd.before : null, lifetime_usd: ia.usd.lifetime, series_usd: ia.usd.series,
        price_lamports: fronting.identity_account_price_lamports ?? null,
      };
      const qs = [feeSrc, slashSrc, bondSrc];
      const sumRaw = (k: "value_raw" | "prev_raw" | "lifetime_raw") => qs.reduce((t, x) => t + big(x[k]), 0n);
      const qSeries = Array.from({ length: b.n }, (_, i) => qs.reduce((t, x) => t + big(x.series_raw[i]), 0n));

      // where creator fees went: compute vaults, the treasury, and what a crank routed elsewhere (pool, GitHub)
      type Split = { fees: bigint; to_compute: bigint; to_protocol: bigint; usd: { fees: number | null; to_compute: number | null; to_protocol: number | null; routed: number | null } };
      const blank = (): Split => ({ fees: 0n, to_compute: 0n, to_protocol: 0n, usd: { fees: 0, to_compute: 0, to_protocol: 0, routed: 0 } });
      const routed = (x: { fees: bigint; to_compute: bigint; to_protocol: bigint }) => (x.fees > x.to_compute + x.to_protocol ? x.fees - x.to_compute - x.to_protocol : 0n);
      const put = (x: Split, f: bigint, tc: bigint, tp: bigint, rate: number | null) => {
        x.fees += f;
        x.to_compute += tc;
        x.to_protocol += tp;
        x.usd = { fees: addUsd(x.usd.fees, uiQ(f), rate), to_compute: addUsd(x.usd.to_compute, uiQ(tc), rate), to_protocol: addUsd(x.usd.to_protocol, uiQ(tp), rate),
          routed: addUsd(x.usd.routed, uiQ(routed({ fees: f, to_compute: tc, to_protocol: tp })), rate) };
      };
      const split = Array.from({ length: b.n }, blank);
      const tot = { ...blank(), cranks: 0 };
      const life = { ...blank(), cranks: cranks.length };
      const perToken = new Map<string, Split & { mint: string; agent: string; cranks: number }>();
      for (const c of cranks) {
        const f = big(c.fees), tc = big(c.to_compute), tp = big(c.to_protocol);
        const rate = c.quote_usd ?? curQ;
        put(life, f, tc, tp, rate);
        const i = c.time === null ? -1 : this.slot(b, c.time * 1000);
        if (i < 0) continue;
        put(split[i]!, f, tc, tp, rate);
        put(tot, f, tc, tp, rate);
        tot.cranks++;
        const t = perToken.get(c.mint) ?? perToken.set(c.mint, { ...blank(), mint: c.mint, agent: c.agent, cranks: 0 }).get(c.mint)!;
        t.cranks++;
        put(t, f, tc, tp, rate);
      }
      const part = (x: Split) => ({
        fees: uiQ(x.fees), fees_raw: x.fees.toString(), to_compute: uiQ(x.to_compute), to_compute_raw: x.to_compute.toString(),
        to_protocol: uiQ(x.to_protocol), to_protocol_raw: x.to_protocol.toString(), routed: uiQ(routed(x)), routed_raw: routed(x).toString(),
        fees_usd: x.usd.fees, to_compute_usd: x.usd.to_compute, to_protocol_usd: x.usd.to_protocol, routed_usd: x.usd.routed,
      });
      const tokens = rev.tokens().filter((t) => listed(t.agent, t.mint));
      const symbolOf = new Map(tokens.map((t) => [t.mint, t.symbol]));
      const debited = tokens.filter((t) => big(t.debited) > 0n);
      const debitedTotal = debited.reduce((t, x) => t + big(x.debited), 0n);
      const stateAt = tokens.reduce<number | null>((m, t) => (t.state_at !== null && (m === null || t.state_at > m) ? t.state_at : m), null);
      // the headline in dollars: the quote-coin sources plus units account payments (SOL) where those are recorded
      const plus = (a: number | null, c: number | null) => (a === null || c === null ? null : a + c);
      const usdParts = [feeSrc, slashSrc, bondSrc, ...(idSrc.available ? [idSrc] : [])];
      const usdSum = (k: "value_usd" | "prev_usd" | "lifetime_usd") => usdParts.reduce<number | null>((t, x) => plus(t, x[k]), 0);
      const usdSeries = Array.from({ length: b.n }, (_, i) => usdParts.reduce<number | null>((t, x) => plus(t, x.series_usd[i] ?? null), 0));
      const inUsd = (v: number | null) => (v === null || curQ === null ? null : v * curQ);

      return {
        now, window: win, hidden: include,
        axis: this.axis(b), range: { from, to }, prev, first_record_at: first,
        quote: { symbol: typeof idx?.meta?.quote === "string" ? idx.meta.quote : null, mint: (typeof idx?.meta?.quote_mint === "string" ? idx.meta.quote_mint : null) ?? chain?.line_mint ?? null, decimals: dec },
        split_bps: chain?.launch ? { agent_compute: chain.launch.agent_compute_bps ?? null, protocol: chain.launch.protocol_bps ?? null } : this.core.chainMode ? null : { agent_compute: this.core.cfg.agent_compute_bps, protocol: this.core.cfg.protocol_bps },
        accounts,
        usd: reading.ok
          ? { ok: true, quote_usd: reading.quote_usd, sol_usd: reading.sol_usd, read_at: reading.read_at, source: reading.source, basis: usdCurrent === 0 && usdAtTime > 0 ? "at_time" : usdAtTime === 0 ? "current" : "mixed" }
          : { ok: false, reason: reading.reason, read_at: reading.read_at, basis: null },
        kpi: {
          usd: { value: usdSum("value_usd"), prev: prev ? usdSum("prev_usd") : null, series: usdSeries, lifetime: usdSum("lifetime_usd") },
          quote: { value: uiQ(sumRaw("value_raw")), value_raw: sumRaw("value_raw").toString(), prev: prev ? uiQ(sumRaw("prev_raw")) : null, prev_raw: prev ? sumRaw("prev_raw").toString() : null, series: qSeries.map(uiQ), lifetime: uiQ(sumRaw("lifetime_raw")), lifetime_raw: sumRaw("lifetime_raw").toString(),
            value_usd: qs.reduce<number | null>((t, x) => plus(t, x.value_usd), 0), prev_usd: prev ? qs.reduce<number | null>((t, x) => plus(t, x.prev_usd), 0) : null },
          sol: { available: idSrc.available, value: idSrc.value, value_raw: idSrc.value_raw, prev: idSrc.prev, series: idSrc.series, lifetime: idSrc.lifetime, lifetime_raw: idSrc.lifetime_raw,
            value_usd: idSrc.value_usd, prev_usd: idSrc.prev_usd },
        },
        sources: [feeSrc, slashSrc, bondSrc, idSrc],
        creator_fees: {
          available: feeSrc.available, cranks: tot.cranks, ...part(tot),
          series: split.map(part),
          lifetime: { cranks: life.cranks, ...part(life) },
          tokens: [...perToken.values()]
            .sort((x, y) => (y.to_protocol > x.to_protocol ? 1 : y.to_protocol < x.to_protocol ? -1 : x.mint.localeCompare(y.mint)))
            .slice(0, 12)
            .map((t) => ({ mint: t.mint, agent: t.agent, name: this.nameOf(t.agent), symbol: symbolOf.get(t.mint) ?? null, cranks: t.cranks, ...part(t) })),
        },
        // lifetime only: the chain keeps a running total per token, no record per debit with a time
        compute_sink: {
          available: !!idx?.ok_at, as_of: stateAt === null ? null : stateAt * 1000, account: accounts.compute_sink,
          debited: uiQ(debitedTotal), debited_raw: debitedTotal.toString(), debited_usd: inUsd(uiQ(debitedTotal)), tokens: debited.length,
          by_token: debited
            .sort((x, y) => (big(y.debited) > big(x.debited) ? 1 : big(y.debited) < big(x.debited) ? -1 : x.mint.localeCompare(y.mint)))
            .slice(0, 12)
            .map((t) => ({ mint: t.mint, agent: t.agent, name: this.nameOf(t.agent), symbol: t.symbol, debited: uiQ(big(t.debited)), debited_raw: t.debited, debited_usd: inUsd(uiQ(big(t.debited))) })),
        },
      };
    });
  }
}
