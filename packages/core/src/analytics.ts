import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Core } from "./core.ts";
import { deploymentsOf } from "./deployments.ts";
import { bad, notFound } from "./errors.ts";
import { genGithubOf } from "./gen-github.ts";
import { hiddenOf } from "./hidden.ts";
import { gainOf, providerOf, WINDOWS } from "./leaderboard.ts";
import { learningsOf } from "./learnings.ts";
import { runtimeSpendOf } from "./runtime-spend.ts";
import { sessionsOf } from "./sessions.ts";

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
// query asks for them (hidden=1). Lineage state (a project's metric values, its generation timeline)
// is the lineage's, whoever authored it; a hidden author's generation is kept there with its author
// withheld (author_hidden) unless hidden=1.

/** A model row reports an acceptance rate from this many attempts, and per accepted figures from this many accepted. */
export const MIN_ATTEMPTS_FOR_RATE = 5;
export const MIN_ACCEPTED_FOR_MEANS = 3;
const CACHE_MS = 10_000;
const HEX64 = /^[0-9a-f]{64}$/;
const AGENT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DAY = 86_400_000;
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
        },
        [number]
      >(
        `SELECT seq, agent, lineage_id, outcome, provider,
           json_extract(json, '$.model.models[0]') AS model, json_extract(json, '$.model.harness.name') AS harness,
           json_extract(json, '$.cost.usd') AS usd, json_extract(json, '$.cost.sandbox_s') AS sandbox_s,
           json_extract(json, '$.effect.ratio') AS ratio, json_array_length(json_extract(json, '$.effect.fixed')) AS fixed,
           json_extract(json, '$.times.started_at') AS started_at, json_extract(json, '$.times.ended_at') AS ended_at,
           json_extract(json, '$.worker_outcome') AS worker_outcome, json_extract(json, '$.verdict.reason') AS reason,
           json_extract(json, '$.task.recipe.class') AS class
         FROM learnings_episodes WHERE seq > ? ORDER BY seq`,
      )
      .all(this.episodesSeq);
    for (const r of rows) {
      this.episodes.push({ ...r, fixed: r.fixed ?? 0, usd: typeof r.usd === "number" ? r.usd : null, sandbox_s: typeof r.sandbox_s === "number" ? r.sandbox_s : null, ratio: typeof r.ratio === "number" ? r.ratio : null });
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
    if (span === undefined) throw bad("bad_query", "window: 24h, 7d or all");
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
}
