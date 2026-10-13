import { swarmSeats, type SoulDoc, type SwarmSeat } from "@units/souls/doc";
import { parseSwarmSettings, type SwarmSettings } from "./config.ts";
import type { Core } from "./core.ts";
import { ApiError, bad, conflict, notFound } from "./errors.ts";
import { featureOn, requireFeature } from "./features.ts";
import { hiddenOf } from "./hidden.ts";
import { modelsOf } from "./models.ts";
import { canonicalJson } from "./protocol.ts";
import { purgeOf } from "./purge.ts";
import { runtimeSpendOf } from "./runtime-spend.ts";

// Swarms: one coin, several agents (docs/plans/SWARMS.md, option A; owner approval 2026-10-13).
//
// A swarm is ONE registered agent. Its members are seats declared in the agent's signed soul
// (`swarm` block, packages/souls/src/swarm.ts); the soul's digest is what the launch already commits
// on chain with set_profile, so nothing here needs a program. To Core a seat is not an agent: it is a
// number carried beside the swarm's agent id. Every seat signs with the agent's one key, so the seat
// number is the hosted runtime's statement (header `x-units-seat`), trusted exactly like the model
// attribution of a provenance record.
//
// Behind the feature flag `swarms` (features.ts), off by default. While it is off: a soul with a
// swarm block is refused as an unknown field (as before this module existed), the seat header is
// ignored, every per-agent limit is what it was, and none of the routes below exists.
//
// What gets a seat dimension when the flag is on and the agent's soul declares seats:
//   sessions in progress per agent   max(4, seats)                       (sessions.ts)
//   open intents, intents per hour   the per-agent setting times seats   (collab.ts)
//   activity events per minute       the per-agent setting times seats   (live.ts)
//   heartbeats                       one row per agent and seat: seat 1 keeps the agent's own row,
//                                    seats 2 and up have theirs here
//   max_open_candidates_per_agent    unchanged: it is what bounds a swarm on one unit
//
// Author-blind replay (SPEC 10.7) is kept: a candidate's seat is stored only in its provenance record
// (hosted.ts), which Core publishes once the candidate is final; ids and commitments hash the swarm's
// agent id as before. What is public per seat while it works is what a solo agent already shows:
// that it is in a session on a unit, and the target it filed an intent for. A seat's last result is
// its newest FINAL candidate; an attempt that ended without a candidate is not shown per seat, since
// that would tell a viewer which sessions led to a commit.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS swarm_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  body TEXT NOT NULL,                  -- the admin's patch over the network config's swarm block
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS swarm_sessions (
  session_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  seat INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS swarm_sessions_agent ON swarm_sessions(agent_id, seat);
CREATE TABLE IF NOT EXISTS swarm_heartbeats (
  agent_id TEXT NOT NULL,
  seat INTEGER NOT NULL,
  at INTEGER NOT NULL,
  job TEXT NOT NULL,                   -- author | idle (a seat never replays)
  phase TEXT,
  lineage_id TEXT,
  gen_id TEXT,
  job_started_at INTEGER,
  beats INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (agent_id, seat)
);
CREATE TABLE IF NOT EXISTS swarm_seat_state (
  agent_id TEXT NOT NULL,
  seat INTEGER NOT NULL,
  body TEXT NOT NULL,                  -- the hosted runtime's statement about the seat (reportSeats)
  reported_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, seat)
);`;

interface Internals {
  db: Core["db"];
  cfg: Core["cfg"];
  now(): number;
  emitEvent(type: string, data: unknown): void;
}

const HEX64 = /^[0-9a-f]{64}$/;
const AGENT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const FINAL = ["accepted", "rejected", "expired"];
const PHASES = new Set(["prepare", "build", "test", "equivalence", "metrics", "commit", "reveal", "propose"]);
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const fin = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown, max = 300): string | null => (typeof v === "string" && v.length <= max && !/—/.test(v) ? v : null);

const instances = new WeakMap<Core, Swarms>();
/** Cores whose flag is off but which hold a soul version with a swarm block from when it was on (the block is then carried over unchanged). */
const allowOff = new WeakSet<Core>();
export function swarmsCarryOver(core: Core): Swarms {
  allowOff.add(core);
  return swarmsOf(core);
}
export function swarmsOf(core: Core): Swarms {
  let m = instances.get(core);
  // no instance (and no table) on a Core whose flag is off, unless a stored soul already carries a block (souls.ts asks first)
  if (!m && !featureOn(core, "swarms") && !allowOff.has(core)) throw new ApiError(404, "feature_off", "swarms is switched off");
  if (!m) instances.set(core, (m = new Swarms(core)));
  return m;
}

/** How many seats `agent`'s limits scale with: 1 unless the flag is on and its soul declares more. */
export function seatScale(core: Core, agent: string): number {
  if (!featureOn(core, "swarms")) return 1;
  return swarmsOf(core).seats(agent);
}

export class Swarms {
  private readonly c: Internals;
  private cache = new Map<string, { digest: string; seats: SwarmSeat[] | null }>();
  constructor(private readonly core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(SCHEMA);
  }

  on(): boolean {
    return featureOn(this.core, "swarms");
  }

  // ---------------------------------------------------------------------------------------------
  // settings

  /** The settings in force: the network config's `swarm` block with the admin's edits over it. */
  settings(): SwarmSettings {
    const base = this.c.cfg.swarm ?? parseSwarmSettings(undefined);
    const row = this.c.db.query<{ body: string }, []>("SELECT body FROM swarm_settings WHERE id = 1").get();
    if (!row) return base;
    try {
      return parseSwarmSettings(JSON.parse(row.body), base);
    } catch {
      return base;
    }
  }

  /** POST /v1/admin/swarms/config: a patch of the settings (a field set to its config value again by sending that value). */
  setConfig(body: unknown) {
    requireFeature(this.core, "swarms");
    if (!isObj(body)) throw bad("bad_swarm_settings", "an object of settings to change");
    const prev = this.c.db.query<{ body: string }, []>("SELECT body FROM swarm_settings WHERE id = 1").get();
    const patch = { ...(prev ? (JSON.parse(prev.body) as Record<string, unknown>) : {}), ...body };
    try {
      parseSwarmSettings(patch, this.c.cfg.swarm);
    } catch (e) {
      throw bad("bad_swarm_settings", (e as Error).message);
    }
    this.c.db.query("INSERT OR REPLACE INTO swarm_settings (id, body, updated_at) VALUES (1, ?, ?)").run(JSON.stringify(patch), this.c.now());
    this.c.emitEvent("swarm.settings", { changed: Object.keys(body) });
    return this.config();
  }

  /**
   * GET /v1/swarms/config: what the launch form and the hosted runtime need. `min_usd_per_seat` is the
   * network's own prepaid credits minimum (prepay.min_usd): a swarm's launch carries it once per seat.
   * `seats_free` is the hosted runtime's last report of its desktop room (null when it never said).
   */
  config() {
    requireFeature(this.core, "swarms");
    const s = this.settings();
    const prepay = (this.c.cfg as { prepay?: { min_usd?: string; attempt_max_usd?: number } | null }).prepay ?? null;
    const g = runtimeSpendOf(this.core).global();
    const e2b = (g?.body as { desktops?: { e2b?: { running: number | null; max: number | null } | null } | null } | undefined)?.desktops?.e2b ?? null;
    const free = e2b && typeof e2b.max === "number" && typeof e2b.running === "number" ? Math.max(0, e2b.max - e2b.running) : null;
    return {
      enabled: true,
      settings: s,
      min_usd_per_seat: prepay?.min_usd ?? null,
      seat_reserve_usd: prepay?.attempt_max_usd ?? null,
      capacity: { seats_free: free, reported_at: g?.reported_at ?? null },
      // the largest size the form offers now: the setting, lowered to the screens the runtime says are free
      max_now: free === null ? s.max_members : Math.max(1, Math.min(s.max_members, free)),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // the roster

  private latestSoul(agent: string): { digest: string; doc: string } | null {
    return this.c.db.query<{ digest: string; doc: string }, [string]>("SELECT digest, doc FROM souls WHERE agent = ? ORDER BY seq DESC LIMIT 1").get(agent) ?? null;
  }

  /** The seats the agent's current soul declares, or null: a solo agent, or the flag is off. */
  roster(agent: string): SwarmSeat[] | null {
    if (!this.on()) return null;
    let head: { digest: string } | null;
    try {
      head = this.c.db.query<{ digest: string }, [string]>("SELECT digest FROM souls WHERE agent = ? ORDER BY seq DESC LIMIT 1").get(agent) ?? null;
    } catch {
      return null; // no souls table yet (a Core that never stored one)
    }
    if (!head) return null;
    const hit = this.cache.get(agent);
    if (hit && hit.digest === head.digest) return hit.seats;
    const row = this.latestSoul(agent)!;
    let seats: SwarmSeat[] | null = null;
    try {
      seats = swarmSeats(JSON.parse(row.doc));
    } catch {
      seats = null;
    }
    if (seats && seats.length < 2) seats = null; // a block of one seat is a solo agent
    if (this.cache.size > 5000) this.cache.clear();
    this.cache.set(agent, { digest: row.digest, seats });
    return seats;
  }

  seats(agent: string): number {
    return this.roster(agent)?.length ?? 1;
  }

  /**
   * The seat a signed request speaks for (header `x-units-seat`), or null: flag off, no header, a solo
   * agent, or not a declared seat. Never an error: an unknown seat is treated as no seat, so a
   * request is handled exactly as a solo agent's.
   */
  seatOf(agent: string | null, raw: string | null): number | null {
    if (!agent || !raw || !this.on()) return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) return null;
    const r = this.roster(agent);
    return r && n <= r.length ? n : null;
  }

  /**
   * The swarm rules of a soul version about to be stored (Souls.put), beyond its shape:
   *  - flag off: the block is an unknown field, unless it is carried unchanged from the version before;
   *  - at most `max_members` seats, every seat's model a priced entry of the registry;
   *  - after the first version the block does not change: a memory fold signed by the runtime key
   *    carries it over as it is (roster changes by the owner's wallet statement are a later phase).
   */
  checkSoul(doc: SoulDoc, prev: SoulDoc | null) {
    const next = doc.swarm ?? null;
    const before = prev?.swarm ?? null;
    if (prev) {
      if ((next ? canonicalJson(next) : "") !== (before ? canonicalJson(before) : ""))
        throw conflict("swarm_roster_fixed", "the swarm block of a launched agent does not change with a new soul version");
      return;
    }
    if (!next) return;
    if (!this.on()) throw new ApiError(400, "bad_soul", "soul.swarm: unknown field");
    const s = this.settings();
    if (next.members.length > s.max_members) throw new ApiError(400, "bad_soul", `soul.swarm.members: at most ${s.max_members} seats (swarm.max_members)`);
    for (const m of next.members) {
      const err = modelsOf(this.core).checkChoice(m.model);
      if (err) throw new ApiError(400, "bad_soul", `soul.swarm.members[${m.seat - 1}].model: ${err}`);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // seats' own rows

  /** POST /v1/heartbeat for seats 2 and up (seat 1 keeps the agent's own row in live.ts). */
  heartbeat(agent: string, seat: number, body: unknown) {
    return this.core.tx(() => {
      if (!isObj(body)) throw bad("bad_heartbeat", "body must be an object");
      const b = body;
      if (b.job !== "author" && b.job !== "idle") throw bad("bad_heartbeat", "a seat's job is author or idle");
      if (b.phase !== undefined && b.phase !== null && (typeof b.phase !== "string" || !PHASES.has(b.phase))) throw bad("bad_heartbeat", "unknown phase");
      const now = this.c.now();
      let lineage: string | null = null;
      let gen: string | null = null;
      if (b.job === "author") {
        if (typeof b.lineage_id !== "string" || !HEX64.test(b.lineage_id) || !this.c.db.query("SELECT 1 FROM lineages WHERE lineage_id = ?").get(b.lineage_id)) throw bad("bad_heartbeat", "author needs a known lineage_id");
        if (typeof b.gen_id !== "string" || !this.c.db.query("SELECT 1 FROM generations WHERE gen_id = ? AND lineage_id = ?").get(b.gen_id, b.lineage_id)) throw bad("bad_heartbeat", "author needs a gen_id of that lineage");
        lineage = b.lineage_id;
        gen = b.gen_id;
      }
      const started = fin(b.job_started_at);
      if (started !== null && (started < 0 || started > now + 60_000)) throw bad("bad_heartbeat", "job_started_at must be a unix ms timestamp, not in the future");
      const prev = this.c.db.query<{ at: number }, [string, number]>("SELECT at FROM swarm_heartbeats WHERE agent_id = ? AND seat = ?").get(agent, seat);
      if (prev && now - prev.at < 1000) throw new ApiError(429, "too_frequent", "at most one heartbeat per second");
      this.c.db
        .query(
          `INSERT INTO swarm_heartbeats (agent_id, seat, at, job, phase, lineage_id, gen_id, job_started_at, beats) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
           ON CONFLICT(agent_id, seat) DO UPDATE SET at = excluded.at, job = excluded.job, phase = excluded.phase, lineage_id = excluded.lineage_id, gen_id = excluded.gen_id,
             job_started_at = excluded.job_started_at, beats = swarm_heartbeats.beats + 1`,
        )
        .run(agent, seat, now, b.job, b.job === "idle" ? null : ((b.phase as string | undefined) ?? null), lineage, gen, started === null ? null : Math.round(started));
      return { agent_id: agent, seat, at: now, job: b.job };
    });
  }

  /** A session a seat started (after sessions.ts stored it). */
  noteSession(sessionId: string, agent: string, seat: number) {
    this.c.db.query("INSERT OR IGNORE INTO swarm_sessions (session_id, agent_id, seat) VALUES (?, ?, ?)").run(sessionId, agent, seat);
  }

  /** The seat of a session, or null (a solo agent's session). Public like the session itself. */
  sessionSeat(sessionId: string): number | null {
    if (!this.on()) return null;
    return this.c.db.query<{ seat: number }, [string]>("SELECT seat FROM swarm_sessions WHERE session_id = ?").get(sessionId)?.seat ?? null;
  }

  /**
   * The seat part of the runtime's spend report (POST /v1/admin/runtime/spend, `agents[id].seats`): per
   * seat its state in words, the unit and target of the attempt it is in (what its intent already
   * says), its model and route, its own screen, and its share of the swarm's spend over closed usage
   * epochs. The runtime's own statement; nothing is derived here and null stays null.
   */
  reportSeats(body: unknown) {
    if (!this.on() || !isObj(body) || !isObj(body.agents)) return;
    const now = this.c.now();
    const purge = purgeOf(this.core);
    const put = this.c.db.query("INSERT OR REPLACE INTO swarm_seat_state (agent_id, seat, body, reported_at) VALUES (?, ?, ?, ?)");
    for (const [agent, a] of Object.entries(body.agents)) {
      if (!AGENT.test(agent) || !isObj(a) || !Array.isArray(a.seats) || purge.isPurged(agent)) continue;
      const roster = this.roster(agent);
      if (!roster) continue;
      for (const raw of a.seats.slice(0, 16)) {
        if (!isObj(raw)) continue;
        const seat = raw.seat;
        if (typeof seat !== "number" || !Number.isInteger(seat) || seat < 1 || seat > roster.length) continue;
        const d = isObj(raw.desktop) ? raw.desktop : null;
        const sp = isObj(raw.spend) ? raw.spend : null;
        const m = isObj(raw.model) && typeof raw.model.provider === "string" && typeof raw.model.id === "string" && raw.model.provider.length <= 32 && raw.model.id.length <= 100 ? { provider: raw.model.provider, id: raw.model.id } : null;
        const row = {
          state: raw.state === "working" || raw.state === "waiting" || raw.state === "paused" || raw.state === "asleep" ? raw.state : "waiting",
          why: text(raw.why),
          since: fin(raw.since),
          unit: typeof raw.unit === "string" && HEX64.test(raw.unit) ? raw.unit : null,
          target: text(raw.target, 120),
          model: m,
          via: raw.via === "direct" || raw.via === "openrouter" ? raw.via : null,
          desktop: d && (d.state === "starting" || d.state === "running" || d.state === "paused" || d.state === "none")
            ? { state: d.state, why: text(d.why), since: fin(d.since), stream: typeof d.stream === "string" && HEX64.test(d.stream) ? d.stream : null, charged: d.charged === true }
            : null,
          spend: sp ? { usd: fin(sp.usd), sandbox_s: fin(sp.sandbox_s), desktop_s: fin(sp.desktop_s), desktop_usd: fin(sp.desktop_usd), attempts: fin(sp.attempts), epochs: fin(sp.epochs) } : null,
        };
        put.run(agent, seat, JSON.stringify(row), now);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // views

  /** A seat's newest final candidate, from the provenance records that name it (published only once final). */
  private lastResults(agent: string): Map<number, Record<string, unknown>> {
    const out = new Map<number, Record<string, unknown>>();
    const rows = this.c.db
      .query<{ seat: number | null; commit_id: string; candidate_id: string | null; status: string; reason: string | null; kind: string; target: string; lineage_id: string; finalized_at: number | null; gen_id: string | null; verdict: string | null }, [string]>(
        `SELECT json_extract(p.record, '$.seat') AS seat, c.commit_id, c.candidate_id, c.status, c.reason, c.kind, c.target, c.lineage_id, c.finalized_at, c.gen_id, c.verdict
         FROM provenance p JOIN candidates c ON c.commit_id = p.commit_id
         WHERE p.agent = ? AND c.status IN (${FINAL.map((s) => `'${s}'`).join(",")}) ORDER BY c.finalized_at DESC LIMIT 400`,
      )
      .all(agent);
    for (const r of rows) {
      const seat = typeof r.seat === "number" && Number.isInteger(r.seat) ? r.seat : 1;
      if (out.has(seat)) continue;
      let ratio: number | null = null;
      try {
        const e = r.verdict ? (JSON.parse(r.verdict) as { effect?: { ratio?: unknown } }).effect : null;
        ratio = e && typeof e.ratio === "number" && Number.isFinite(e.ratio) ? e.ratio : null;
      } catch {
        ratio = null;
      }
      let target: unknown = r.target;
      try {
        target = JSON.parse(r.target);
      } catch {
        /* stored as text */
      }
      out.set(seat, { commit_id: r.commit_id, candidate_id: r.candidate_id, status: r.status, reason: r.reason, kind: r.kind, target, lineage_id: r.lineage_id, finalized_at: r.finalized_at, gen_id: r.gen_id, ratio });
    }
    return out;
  }

  /** How many final candidates each seat has, and how many of them were accepted (from provenance, final only). */
  private totals(agent: string): Map<number, { final: number; accepted: number }> {
    const out = new Map<number, { final: number; accepted: number }>();
    const rows = this.c.db
      .query<{ seat: number | null; status: string; n: number }, [string]>(
        `SELECT json_extract(p.record, '$.seat') AS seat, c.status, COUNT(*) AS n FROM provenance p JOIN candidates c ON c.commit_id = p.commit_id
         WHERE p.agent = ? AND c.status IN (${FINAL.map((s) => `'${s}'`).join(",")}) GROUP BY 1, 2`,
      )
      .all(agent);
    for (const r of rows) {
      const seat = typeof r.seat === "number" && Number.isInteger(r.seat) ? r.seat : 1;
      const t = out.get(seat) ?? { final: 0, accepted: 0 };
      t.final += r.n;
      if (r.status === "accepted") t.accepted += r.n;
      out.set(seat, t);
    }
    return out;
  }

  /** The swarm's accepted changes, newest first, each with the seat and model its provenance record names (final candidates only). */
  private record(agent: string, roster: SwarmSeat[], limit = 50) {
    const rows = this.c.db
      .query<{ record: string; commit_id: string; candidate_id: string | null; kind: string; target: string; lineage_id: string; finalized_at: number | null; gen_id: string | null; verdict: string | null }, [string, number]>(
        `SELECT p.record, c.commit_id, c.candidate_id, c.kind, c.target, c.lineage_id, c.finalized_at, c.gen_id, c.verdict
         FROM provenance p JOIN candidates c ON c.commit_id = p.commit_id WHERE p.agent = ? AND c.status = 'accepted' ORDER BY c.finalized_at DESC LIMIT ?`,
      )
      .all(agent, limit);
    return rows.map((r) => {
      const rec = JSON.parse(r.record) as { seat?: number; models?: string[]; route?: { model?: { provider?: string; id?: string } } };
      const seat = typeof rec.seat === "number" && Number.isInteger(rec.seat) ? rec.seat : 1;
      let ratio: number | null = null;
      let target: unknown = r.target;
      try {
        const e = r.verdict ? (JSON.parse(r.verdict) as { effect?: { ratio?: unknown } }).effect : null;
        ratio = e && typeof e.ratio === "number" && Number.isFinite(e.ratio) ? e.ratio : null;
        target = JSON.parse(r.target);
      } catch {
        /* as stored */
      }
      return { commit_id: r.commit_id, candidate_id: r.candidate_id, gen_id: r.gen_id, lineage_id: r.lineage_id, kind: r.kind, target, finalized_at: r.finalized_at, ratio, seat, name: roster.find((m) => m.seat === seat)?.name ?? null, model: rec.route?.model?.id ?? rec.models?.[0] ?? null };
    });
  }

  /**
   * GET /v1/agents/:id/swarm: the coin page's seat list. `seats` is null for a solo agent. Per seat:
   * what the soul declares (name, role, model), the runtime's last statement about it, its live
   * session (public like any session), its newest final candidate, and its counts of final work.
   */
  view(agent: string) {
    requireFeature(this.core, "swarms");
    if (!this.c.db.query("SELECT 1 FROM agents WHERE agent_id = ? AND kind = 'launched'").get(agent)) throw notFound("agent");
    const roster = this.roster(agent);
    if (!roster) return { agent, size: 1, seats: null };
    const now = this.c.now();
    const awakeMs = 3 * this.c.cfg.heartbeat_s * 1000;
    const states = new Map(this.c.db.query<{ seat: number; body: string; reported_at: number }, [string]>("SELECT seat, body, reported_at FROM swarm_seat_state WHERE agent_id = ?").all(agent).map((r) => [r.seat, r]));
    const beats = new Map(this.c.db.query<{ seat: number; at: number; job: string; phase: string | null; lineage_id: string | null }, [string]>("SELECT seat, at, job, phase, lineage_id FROM swarm_heartbeats WHERE agent_id = ?").all(agent).map((r) => [r.seat, r]));
    const own = this.c.db.query<{ at: number; job: string; phase: string | null; lineage_id: string | null }, [string]>("SELECT at, job, phase, lineage_id FROM heartbeats WHERE agent_id = ?").get(agent);
    if (own) beats.set(1, { seat: 1, ...own });
    const live = this.c.db
      .query<{ seat: number; session_id: string; lineage_id: string; started_at: number }, [string, number]>(
        `SELECT w.seat, s.session_id, s.lineage_id, s.started_at FROM swarm_sessions w JOIN sessions s ON s.session_id = w.session_id
         WHERE w.agent_id = ? AND s.ended_at IS NULL AND s.last_at > ? ORDER BY s.started_at`,
      )
      .all(agent, now - 10 * 60_000);
    const sessions = new Map(live.map((r) => [r.seat, { session_id: r.session_id, lineage_id: r.lineage_id, started_at: r.started_at }]));
    const last = this.lastResults(agent);
    const totals = this.totals(agent);
    return {
      agent,
      size: roster.length,
      lead: roster.find((m) => m.role === "lead")?.seat ?? 1,
      record: this.record(agent, roster),
      seats: roster.map((m) => {
        const st = states.get(m.seat);
        const hb = beats.get(m.seat);
        return {
          seat: m.seat,
          name: m.name,
          role: m.role,
          model: m.model,
          runtime: st ? { ...(JSON.parse(st.body) as Record<string, unknown>), reported_at: st.reported_at } : null,
          heartbeat: hb ? { at: hb.at, awake: now - hb.at <= awakeMs, job: hb.job, phase: hb.phase, lineage_id: hb.lineage_id } : null,
          session: sessions.get(m.seat) ?? null,
          last: last.get(m.seat) ?? null,
          totals: totals.get(m.seat) ?? { final: 0, accepted: 0 },
        };
      }),
    };
  }

  /**
   * GET /v1/swarms: every launched agent whose soul declares seats, for the Explorer's badge: its
   * size, its lead, and the seat that is working now by the runtime's report (null: none). Hidden
   * launches are left out unless `hidden`.
   */
  list(withHidden = false) {
    requireFeature(this.core, "swarms");
    const off = withHidden ? new Map<string, unknown>() : hiddenOf(this.core).agents();
    let rows: { agent: string }[] = [];
    try {
      rows = this.c.db
        .query<{ agent: string }, []>("SELECT DISTINCT s.agent AS agent FROM souls s JOIN agents a ON a.agent_id = s.agent WHERE a.kind = 'launched' AND a.shadow = 0 AND s.doc LIKE '%\"swarm\":%' ORDER BY s.agent")
        .all();
    } catch {
      rows = [];
    }
    const out: { agent: string; size: number; lead: number; working: number | null; stream: string | null }[] = [];
    for (const r of rows) {
      if (off.has(r.agent)) continue;
      const roster = this.roster(r.agent);
      if (!roster) continue;
      const lead = roster.find((m) => m.role === "lead")?.seat ?? 1;
      const states = this.c.db.query<{ seat: number; body: string }, [string]>("SELECT seat, body FROM swarm_seat_state WHERE agent_id = ? ORDER BY seat").all(r.agent).map((x) => ({ seat: x.seat, ...(JSON.parse(x.body) as { state?: string; desktop?: { stream?: string | null } | null }) }));
      const working = states.find((x) => x.state === "working")?.seat ?? null;
      const shown = states.find((x) => x.seat === (working ?? lead));
      out.push({ agent: r.agent, size: roster.length, lead, working, stream: shown?.desktop?.stream ?? null });
    }
    return { swarms: out };
  }

  /** The seat a provenance record names must be one the author's soul declares (hosted.ts). Null when fine. */
  checkProvenanceSeat(author: string, seat: unknown): string | null {
    if (seat === undefined) return null;
    if (typeof seat !== "number" || !Number.isInteger(seat) || seat < 1 || seat > 16) return "record.seat must be a seat number";
    if (!this.on()) return "record.seat: swarms are switched off";
    const roster = this.roster(author);
    if (!roster || seat > roster.length) return "record.seat is not a seat the author's soul declares";
    return null;
  }
}
