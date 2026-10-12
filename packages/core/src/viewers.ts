import type { Core } from "./core.ts";
import { hiddenOf } from "./hidden.ts";

// Live stream viewers (docs/plans/PAGES-PROJECTS-GENERATIONS-ANALYTICS.md 6.4, owner decision
// 2026-10-11). The site's gate counts the distinct viewers of each agent desktop stream for its caps
// (scripts/deploy/gate.ts) and serves the counts, and only the counts, to loopback callers at
// GET /gate/viewers. Core samples that once a minute, keeps the minute samples for 48 h and the hourly
// peaks for the charts, and serves them: GET /v1/viewers (now) and the analytics dashboard.
//
// What is kept and served: how many distinct viewers a live session had, per session and in total.
// Never an address or any other identifier of a viewer, and never the caps or their headroom.
// A session is tied to its agent from Core's own session row (a live session's agent is public,
// GET /v1/sessions); sessions of hidden launches are left out unless the query says hidden=1, and a
// stream whose session Core does not know counts only in the all-sessions total.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS viewer_samples (
  at INTEGER NOT NULL,          -- the minute of the sample
  session_id TEXT NOT NULL,     -- '' is the sample's own row (all sessions); a session row only when it had viewers
  agent TEXT NOT NULL,          -- '' when Core does not know the session
  viewers INTEGER NOT NULL,
  listed INTEGER NOT NULL,      -- on the '' row: viewers of listed (not hidden) agents' sessions
  PRIMARY KEY (at, session_id)
);
CREATE TABLE IF NOT EXISTS viewer_hourly (
  hour INTEGER NOT NULL,
  agent TEXT NOT NULL,          -- '' all sessions, '*' listed agents' sessions, else one agent
  peak INTEGER NOT NULL,
  samples INTEGER NOT NULL,
  PRIMARY KEY (hour, agent)
);`;

const MINUTE = 60_000;
const HOUR = 3_600_000;
const KEEP_SAMPLES_MS = 48 * HOUR;
const HEX64 = /^[0-9a-f]{64}$/;
/** A reading older than this is not "now" (the sampler runs once a minute). */
export const VIEWERS_FRESH_MS = 3 * MINUTE;

interface Internals {
  db: Core["db"];
  now(): number;
}

export interface GateViewers {
  total: number;
  sessions: Record<string, number>;
}

/** The gate's answer, counts only: anything else in it is dropped here. */
export function parseGateViewers(v: unknown): GateViewers | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const s = (v as { sessions?: unknown }).sessions;
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  const sessions: Record<string, number> = {};
  let total = 0;
  for (const [k, n] of Object.entries(s as Record<string, unknown>)) {
    if (!HEX64.test(k) || typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 1_000_000) continue;
    if (n > 0) (sessions[k] = n), (total += n);
    if (Object.keys(sessions).length >= 2000) break;
  }
  return { total, sessions };
}

const instances = new WeakMap<Core, Viewers>();
export function viewersOf(core: Core): Viewers {
  let m = instances.get(core);
  if (!m) instances.set(core, (m = new Viewers(core)));
  return m;
}

export class Viewers {
  private readonly c: Internals;
  constructor(private readonly core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(SCHEMA);
  }

  /** One sample of the gate's counts (the sampler calls this once a minute; a minute is written once). */
  record(g: GateViewers) {
    const now = this.c.now();
    const at = Math.floor(now / MINUTE) * MINUTE;
    const hour = Math.floor(now / HOUR) * HOUR;
    const db = this.c.db;
    if (db.query("SELECT 1 FROM viewer_samples WHERE at = ? AND session_id = ''").get(at)) return { ok: true, at, recorded: false };
    const hidden = hiddenOf(this.core).agents();
    const agentOf = db.query<{ agent_id: string }, [string]>("SELECT agent_id FROM sessions WHERE session_id = ?");
    const perAgent = new Map<string, number>();
    let listed = 0;
    const put = db.query("INSERT OR REPLACE INTO viewer_samples (at, session_id, agent, viewers, listed) VALUES (?, ?, ?, ?, 0)");
    for (const [sid, n] of Object.entries(g.sessions)) {
      const agent = agentOf.get(sid)?.agent_id ?? "";
      put.run(at, sid, agent, n);
      if (!agent) continue;
      perAgent.set(agent, (perAgent.get(agent) ?? 0) + n);
      if (!hidden.has(agent)) listed += n;
    }
    db.query("INSERT INTO viewer_samples (at, session_id, agent, viewers, listed) VALUES (?, '', '', ?, ?)").run(at, g.total, listed);
    const peak = db.query("INSERT INTO viewer_hourly (hour, agent, peak, samples) VALUES (?, ?, ?, 1) ON CONFLICT (hour, agent) DO UPDATE SET peak = MAX(peak, excluded.peak), samples = samples + 1");
    peak.run(hour, "", g.total);
    peak.run(hour, "*", listed);
    for (const [agent, n] of perAgent) peak.run(hour, agent, n);
    db.query("DELETE FROM viewer_samples WHERE at < ?").run(at - KEEP_SAMPLES_MS);
    return { ok: true, at, recorded: true };
  }

  /** Reads the gate once and records the sample; a gate that does not answer leaves no sample (a gap, not a zero). */
  async sample(gateUrl: string, fetchImpl: typeof fetch = fetch) {
    try {
      const r = await fetchImpl(`${gateUrl.replace(/\/+$/, "")}/gate/viewers`, { signal: AbortSignal.timeout(5_000) });
      if (!r.ok) return { ok: false, error: `gate ${r.status}` };
      const g = parseGateViewers(await r.json());
      if (!g) return { ok: false, error: "gate answer not understood" };
      return this.record(g);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** The newest sample if it is fresh: viewers per session of listed agents (every known session with hidden). */
  now(includeHidden: boolean) {
    const db = this.c.db;
    const head = db.query<{ at: number; viewers: number; listed: number }, []>("SELECT at, viewers, listed FROM viewer_samples WHERE session_id = '' ORDER BY at DESC LIMIT 1").get();
    if (!head || this.c.now() - head.at > VIEWERS_FRESH_MS) return null;
    const hidden = hiddenOf(this.core).agents();
    const rows = db
      .query<{ session_id: string; agent: string; viewers: number }, [number]>("SELECT session_id, agent, viewers FROM viewer_samples WHERE at = ? AND session_id != '' ORDER BY viewers DESC, session_id")
      .all(head.at)
      .filter((r) => r.agent && (includeHidden || !hidden.has(r.agent)));
    return { at: head.at, total: includeHidden ? head.viewers : rows.reduce((s, r) => s + r.viewers, 0), sessions: rows.map((r) => ({ session_id: r.session_id, agent: r.agent, viewers: r.viewers })) };
  }

  /** Hourly peaks from `from` on: all known sessions with hidden, listed agents' sessions otherwise. */
  hourly(from: number, includeHidden: boolean): { hour: number; peak: number; samples: number }[] {
    return this.c.db
      .query<{ hour: number; peak: number; samples: number }, [string, number]>("SELECT hour, peak, samples FROM viewer_hourly WHERE agent = ? AND hour >= ? ORDER BY hour")
      .all(includeHidden ? "" : "*", Math.floor(from / HOUR) * HOUR);
  }

  /** When the first sample was taken (null before the sampler ever ran). */
  since(): number | null {
    return this.c.db.query<{ h: number | null }, []>("SELECT MIN(hour) AS h FROM viewer_hourly WHERE agent = ''").get()?.h ?? null;
  }

  /** GET /v1/viewers?hidden=1 */
  view(includeHidden: boolean) {
    const n = this.now(includeHidden);
    return { now: this.c.now(), sampled_at: n?.at ?? null, total: n?.total ?? null, sessions: n?.sessions ?? [], since: this.since(), source: "distinct viewers of each live desktop stream as the site's gate counts them, sampled once a minute; counts only" };
  }
}
