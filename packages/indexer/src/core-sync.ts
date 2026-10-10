import type { Database } from "bun:sqlite";

// What the token directory (/explorer, docs/plans/FRONTEND-EMBED.md amendment 2) needs from Core
// for each agent token: the target class of the lineage the agent works on, its verified (accepted,
// not reverted) generation count, its latest public authoring session (for the screen thumbnail and
// the WORKING state) and the model that authors for it. Read from Core's public API only, so the
// author-blind rules (SPEC 10.7, 17.3) apply unchanged: a sealed session names no agent and is
// simply not attributed. Stored in core_agents and joined into /market/tokens.

export type FetchJson = (path: string) => Promise<unknown>;

export const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS core_agents (agent TEXT PRIMARY KEY, class TEXT, lineage_id TEXT, repo TEXT, model TEXT, provider TEXT, generations INTEGER,
  session_id TEXT, session_state TEXT, session_at INTEGER, synced_at INTEGER NOT NULL,
  name TEXT, tagline TEXT, avatar TEXT, session_file TEXT, last_gen TEXT, last_lineage TEXT, last_metric TEXT, last_ratio REAL, last_fixed INTEGER, last_at INTEGER);
CREATE TABLE IF NOT EXISTS hidden_mints (mint TEXT PRIMARY KEY, agent TEXT, reason TEXT NOT NULL, added_at INTEGER);
`;

/** Creates the Core tables, rebuilding core_agents (a cache of Core, refilled every pass) when an older layout lacks a column. */
export function ensureCoreSchema(db: Database) {
  const cols = new Set((db.query("PRAGMA table_info(core_agents)").all() as { name: string }[]).map((c) => c.name));
  if (cols.size && !cols.has("last_at")) db.exec("DROP TABLE core_agents");
  db.exec(CORE_SCHEMA);
}

const PROVIDER: Record<string, string> = { anthropic: "Anthropic", scripted: "scripted" };

interface Gen { gen_id?: string; entry_type: string; author: string | null; reverted_by?: string | null; accepted_at?: number | null;
  effect?: { metric?: string; ratio?: number; fixed?: unknown[] } | null }
interface Session { session_id: string; agent: string | null; state: string; class: string | null; lineage_id: string; repo: string | null; proposer: string;
  started_at: number; last_at: number | null }

/** One pass over Core. Returns the number of agents written; throws when Core does not answer. */
export async function syncCore(db: Database, get: FetchJson, now = Math.floor(Date.now() / 1000), opts: { modelCache?: Map<string, { model: string | null; at: number }> } = {}) {
  ensureCoreSchema(db);
  // hidden launches (APP-CONSOLIDATION amendment 2): an older Core without the list keeps the last one read
  const hidden = (await get("/v1/hidden").catch(() => null)) as { hidden?: { mint: string; agent: string | null; reason: string; added_at: number }[] } | null;
  const agents = (await get("/v1/agents")) as { agent_id: string; mint: string | null; target_repo: string | null; kind: string }[];
  const lineages = (await get("/v1/lineages")) as { lineage_id: string; repo: string; status: string }[];
  const views = await Promise.all(lineages.map((l) => get(`/v1/lineages/${l.lineage_id}`) as Promise<{ lineage_id: string; repo: string;
    recipe: { class?: string } | null; generations: Gen[] }>));
  const sessions = ((await get("/v1/sessions?limit=500").catch(() => [])) as Session[] | { sessions: Session[] });
  const sess = Array.isArray(sessions) ? sessions : sessions.sessions ?? [];

  const tokRepo = new Map((db.query("SELECT agent, repo_url FROM tokens").all() as { agent: string; repo_url: string | null }[]).map((r) => [r.agent, r.repo_url]));
  const norm = (u: string | null | undefined) => (u ?? "").toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
  const latest = new Map<string, Session>();
  for (const s of sess) {
    if (!s.agent) continue;
    const cur = latest.get(s.agent);
    if (!cur || (s.last_at ?? s.started_at) > (cur.last_at ?? cur.started_at)) latest.set(s.agent, s);
  }

  const ins = db.prepare(`INSERT OR REPLACE INTO core_agents (agent, class, lineage_id, repo, model, provider, generations, session_id, session_state, session_at, synced_at,
    name, tagline, avatar, session_file, last_gen, last_lineage, last_metric, last_ratio, last_fixed, last_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const rows: unknown[][] = [];
  for (const a of agents) {
    const repo = norm(tokRepo.get(a.agent_id) ?? a.target_repo);
    let gens = 0;
    let best: { v: (typeof views)[number]; n: number } | null = null;
    // the agent's latest verified (accepted, unreverted) improvement, for "what it is building"
    let last: { g: Gen; lineage: string } | null = null;
    for (const v of views) {
      const mine = v.generations.filter((g) => g.entry_type === "patch" && g.author === a.agent_id && !g.reverted_by);
      const n = mine.length;
      gens += n;
      if (n > 0 || (repo && norm(v.repo) === repo)) if (!best || n > best.n) best = { v, n };
      for (const g of mine) if (!last || (g.accepted_at ?? 0) > (last.g.accepted_at ?? 0)) last = { g, lineage: v.lineage_id };
    }
    const s = latest.get(a.agent_id) ?? null;
    const lineage = best?.v ?? (s ? views.find((v) => v.lineage_id === s.lineage_id) ?? null : null);
    const cls = lineage?.recipe?.class ?? s?.class ?? null;
    let model: string | null = null;
    if (s?.proposer === "anthropic") model = await modelOf(a.agent_id, get, now, opts.modelCache);
    else if (s?.proposer === "scripted") model = "scripted";
    // launched agents: name, tagline and avatar from the agent's public profile (soul and launcher media)
    const prof = a.mint ? ((await get(`/v1/agents/${a.agent_id}/profile`).catch(() => null)) as
      { soul?: { name?: string | null; tagline?: string | null } | null; media?: { avatar?: { url?: string } | null } | null } | null) : null;
    // a running session: the file it last touched (public events only; Core seals edit text, not paths of reads)
    const file = s?.state === "live" ? await liveFile(s.session_id, get) : null;
    const e = last?.g.effect ?? null;
    rows.push([a.agent_id, cls, lineage?.lineage_id ?? null, lineage?.repo ?? (a.target_repo || null), model, s ? (PROVIDER[s.proposer] ?? s.proposer) : null, gens,
      s?.session_id ?? null, s?.state ?? null, s ? (s.last_at ?? s.started_at) : null, now,
      prof?.soul?.name ?? null, prof?.soul?.tagline ?? null, prof?.media?.avatar?.url ?? null, file,
      last?.g.gen_id ?? null, last?.lineage ?? null, e?.metric ?? null, typeof e?.ratio === "number" ? e.ratio : null,
      Array.isArray(e?.fixed) ? e!.fixed!.length : null, last?.g.accepted_at ?? null]);
  }
  db.transaction(() => {
    db.query("DELETE FROM core_agents").run();
    for (const r of rows) ins.run(...(r as [string]));
    if (hidden && Array.isArray(hidden.hidden)) {
      db.query("DELETE FROM hidden_mints").run();
      const h = db.prepare("INSERT OR REPLACE INTO hidden_mints (mint, agent, reason, added_at) VALUES (?,?,?,?)");
      for (const x of hidden.hidden) h.run(x.mint, x.agent ?? null, x.reason, x.added_at ?? null);
    }
    db.query("INSERT OR REPLACE INTO meta (k, v) VALUES ('core_synced_at', ?)").run(String(now));
  })();
  return rows.length;
}

/** The path of the newest public event that names a file in a running session, or null. */
async function liveFile(id: string, get: FetchJson): Promise<string | null> {
  try {
    const v = (await get(`/v1/sessions/${id}`)) as { event_list?: { path?: unknown }[] };
    const ev = [...(v.event_list ?? [])].reverse().find((e) => typeof e.path === "string" && e.path);
    return ev ? String(ev.path) : null;
  } catch {
    return null;
  }
}

/** The Claude model id that authored the agent's latest final candidate (its provenance record), cached for 10 minutes. */
async function modelOf(agent: string, get: FetchJson, now: number, cache?: Map<string, { model: string | null; at: number }>): Promise<string | null> {
  const c = cache?.get(agent);
  if (c && now - c.at < 600) return c.model;
  let model: string | null = null;
  try {
    const cands = (await get(`/v1/candidates?author=${agent}&limit=20`)) as { candidate_id: string; status: string }[];
    for (const cd of cands) {
      const p = (await get(`/v1/candidates/${cd.candidate_id}/provenance`).catch(() => null)) as { record?: { models?: unknown[] }; models?: unknown[] } | null;
      const ms = p?.record?.models ?? p?.models;
      const m = Array.isArray(ms) ? ms.map((x) => (typeof x === "string" ? x : (x as { model?: string })?.model)).find((x) => typeof x === "string") : undefined;
      if (m) {
        model = m;
        break;
      }
    }
  } catch {
    /* no record: the model stays unknown */
  }
  cache?.set(agent, { model, at: now });
  return model;
}
