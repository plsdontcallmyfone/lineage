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
  session_id TEXT, session_state TEXT, session_at INTEGER, synced_at INTEGER NOT NULL);
`;

const PROVIDER: Record<string, string> = { anthropic: "Anthropic", scripted: "scripted" };

interface Gen { entry_type: string; author: string | null; reverted_by?: string | null }
interface Session { session_id: string; agent: string | null; state: string; class: string | null; lineage_id: string; repo: string | null; proposer: string;
  started_at: number; last_at: number | null }

/** One pass over Core. Returns the number of agents written; throws when Core does not answer. */
export async function syncCore(db: Database, get: FetchJson, now = Math.floor(Date.now() / 1000), opts: { modelCache?: Map<string, { model: string | null; at: number }> } = {}) {
  db.exec(CORE_SCHEMA);
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

  const ins = db.prepare(`INSERT INTO core_agents (agent, class, lineage_id, repo, model, provider, generations, session_id, session_state, session_at, synced_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (agent) DO UPDATE SET class = excluded.class, lineage_id = excluded.lineage_id, repo = excluded.repo,
    model = excluded.model, provider = excluded.provider, generations = excluded.generations, session_id = excluded.session_id,
    session_state = excluded.session_state, session_at = excluded.session_at, synced_at = excluded.synced_at`);
  const rows: unknown[][] = [];
  for (const a of agents) {
    const repo = norm(tokRepo.get(a.agent_id) ?? a.target_repo);
    let gens = 0;
    let best: { v: (typeof views)[number]; n: number } | null = null;
    for (const v of views) {
      const n = v.generations.filter((g) => g.entry_type === "patch" && g.author === a.agent_id && !g.reverted_by).length;
      gens += n;
      if (n > 0 || (repo && norm(v.repo) === repo)) if (!best || n > best.n) best = { v, n };
    }
    const s = latest.get(a.agent_id) ?? null;
    const lineage = best?.v ?? (s ? views.find((v) => v.lineage_id === s.lineage_id) ?? null : null);
    const cls = lineage?.recipe?.class ?? s?.class ?? null;
    let model: string | null = null;
    if (s?.proposer === "anthropic") model = await modelOf(a.agent_id, get, now, opts.modelCache);
    else if (s?.proposer === "scripted") model = "scripted";
    rows.push([a.agent_id, cls, lineage?.lineage_id ?? null, lineage?.repo ?? (a.target_repo || null), model, s ? (PROVIDER[s.proposer] ?? s.proposer) : null, gens,
      s?.session_id ?? null, s?.state ?? null, s ? (s.last_at ?? s.started_at) : null, now]);
  }
  db.transaction(() => {
    db.query("DELETE FROM core_agents").run();
    for (const r of rows) ins.run(...(r as [string]));
    db.query("INSERT OR REPLACE INTO meta (k, v) VALUES ('core_synced_at', ?)").run(String(now));
  })();
  return rows.length;
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
