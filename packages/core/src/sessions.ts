import { randomBytes } from "node:crypto";
import type { Core } from "./core.ts";
import { ApiError, bad, forbidden, notFound } from "./errors.ts";
import { validPath } from "./live.ts";

// Authoring sessions (SPEC 17.3): what an authoring agent did during one attempt, tool call by tool
// call, stored for replay and shown by the live agent panel. One rule decides everything here, the
// gate:
//
// - Navigation (list, read, search), run phases and the line ranges of edits are public in real
//   time, like the activity stream (17.1) they mirror.
// - Edit contents (the before and after text of an edit or patch hunk), evaluation output, the
//   agent's own notes and its submit are sealed. They are served only once the attempt's candidate
//   is final, or once the attempt ended without a candidate. A candidate's patch is public after
//   reveal, so sealed edits that typed in under a named agent would link the agent to an open
//   candidate (author-blind replay, SPEC 10.7); before reveal they would let anyone commit a copy
//   first. Nothing sealed ever enters the event log.
// - Identity follows 10.7: a session in progress names its agent (as its activity already does);
//   once its candidate is committed and until that candidate is final, the public view names no
//   agent and no candidate, unless the agent holds a public intent on that lineage, and a listing
//   by agent leaves it out.
//
// Core finds the attempt's candidate itself (the agent's first candidate on the lineage committed
// at or after the session start and before its end), so a worker cannot open its gate early by
// claiming it committed nothing. The commit_id a worker reports at the end is checked against it.

export const SESSION_KINDS = new Set(["list", "read", "search", "edit", "write", "patch", "evaluate", "phase", "result", "note", "submit", "give_up"]);
const PHASES = new Set(["prepare", "build", "test", "equivalence", "metrics"]);
/** Fields that are public in real time. */
const PUBLIC_KEYS = new Set(["kind", "at", "path", "start_line", "end_line", "query", "matches", "count", "phase", "target", "label", "content_sha256", "eval_kind", "lines_before", "lines_after"]);
/** Fields that stay sealed until the gate opens. */
const SEALED_KEYS = new Set(["before", "after", "output", "steps", "outcome", "text", "reason", "truncated"]);
/** Whole events that are private until the gate opens (a submit would time a commit to an agent). */
const PRIVATE_KINDS = new Set(["submit"]);
const HEX64 = /^[0-9a-f]{64}$/;
const TERMINAL = new Set(["accepted", "rejected", "expired"]);

export const SESSION_LIMITS = {
  batch: 200,
  events_per_session: 5000,
  sealed_bytes_per_event: 96 * 1024,
  sealed_bytes_per_session: 6 * 1024 * 1024,
  live_sessions_per_agent: 4,
  /** an unended session with no event for this long is abandoned; its edits open after this much silence */
  abandon_ms: 24 * 3600 * 1000,
};

export const SESSIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    lineage_id TEXT NOT NULL,
    gen_id TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    proposer TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    last_at INTEGER NOT NULL,
    ended_at INTEGER,
    reported_commit TEXT,                -- the commit_id the worker reported at the end (checked, private)
    events INTEGER NOT NULL DEFAULT 0,
    sealed_bytes INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS sessions_lineage ON sessions(lineage_id, started_at);
  CREATE INDEX IF NOT EXISTS sessions_agent ON sessions(agent_id, started_at);
  CREATE TABLE IF NOT EXISTS session_events (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    at INTEGER NOT NULL,
    pub TEXT NOT NULL,                   -- JSON, public in real time
    sealed TEXT,                         -- JSON, served only once the gate is open
    private INTEGER NOT NULL DEFAULT 0,  -- the whole event waits for the gate
    PRIMARY KEY (session_id, seq)
  );
`;

interface SessionRow {
  session_id: string;
  agent_id: string;
  lineage_id: string;
  gen_id: string;
  commit_sha: string;
  proposer: string;
  started_at: number;
  last_at: number;
  ended_at: number | null;
  reported_commit: string | null;
  events: number;
  sealed_bytes: number;
  desktop: number;
  recording_sha: string | null;
  recording_bytes: number | null;
}

interface EventRow {
  session_id: string;
  seq: number;
  kind: string;
  at: number;
  pub: string;
  sealed: string | null;
  private: number;
}

interface CandLink {
  commit_id: string;
  candidate_id: string | null;
  status: string;
  reason: string | null;
  gen_id: string | null;
  author: string;
  committed_at: number;
  revealed_at: number | null;
  finalized_at: number | null;
  kind: string;
  target: string;
  verdict: string | null;
}

export type SessionState = "live" | "sealed" | "final" | "ended" | "abandoned";

export interface Gate {
  state: SessionState;
  /** sealed fields and private events may be served to everyone */
  open: boolean;
  /** the public view may name the agent */
  agentPublic: boolean;
  candidate: CandLink | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

const instances = new WeakMap<Core, Sessions>();
export function sessionsOf(core: Core): Sessions {
  let s = instances.get(core);
  if (!s) instances.set(core, (s = new Sessions(core)));
  return s;
}

export class Sessions {
  constructor(private core: Core) {
    core.db.exec(SESSIONS_SCHEMA);
    // agent desktops (SPEC 17.7): the session ran on a live desktop; its recording once the gate opened
    const cols = new Set(core.db.query<{ name: string }, []>("PRAGMA table_info(sessions)").all().map((c) => c.name));
    if (!cols.has("desktop")) core.db.exec("ALTER TABLE sessions ADD COLUMN desktop INTEGER NOT NULL DEFAULT 0");
    if (!cols.has("recording_sha")) core.db.exec("ALTER TABLE sessions ADD COLUMN recording_sha TEXT");
    if (!cols.has("recording_bytes")) core.db.exec("ALTER TABLE sessions ADD COLUMN recording_bytes INTEGER");
  }

  private get db() {
    return this.core.db;
  }

  private row(id: string): SessionRow | null {
    return this.db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE session_id = ?").get(id);
  }

  private mustOwn(agent: string, id: string): SessionRow {
    const s = this.row(id);
    if (!s) throw notFound("session");
    if (s.agent_id !== agent) throw forbidden("not_owner", "only the session's agent may write to it");
    return s;
  }

  // ---------------------------------------------------------------------------------------------
  // writes (agent-signed)

  /** POST /v1/sessions { lineage_id, gen_id, commit, proposer, desktop? } */
  start(agent: string, body: unknown) {
    return this.core.tx(() => {
      const a = this.db.query<{ kind: string }, [string]>("SELECT kind FROM agents WHERE agent_id = ?").get(agent);
      if (!a) throw forbidden("not_registered", "only registered agents record sessions");
      if (a.kind !== "launched") throw forbidden("not_an_author", "only launched agents author");
      if (!isObj(body)) throw bad("bad_session", "body must be an object");
      for (const k of Object.keys(body)) if (!["lineage_id", "gen_id", "commit", "proposer", "desktop"].includes(k)) throw bad("bad_session", `unknown field ${k}`);
      const { lineage_id, gen_id, commit, proposer } = body;
      if (body.desktop !== undefined && typeof body.desktop !== "boolean") throw bad("bad_session", "desktop must be a boolean");
      if (typeof lineage_id !== "string" || !HEX64.test(lineage_id)) throw bad("bad_session", "lineage_id must be 64 hex");
      if (typeof gen_id !== "string" || !HEX64.test(gen_id)) throw bad("bad_session", "gen_id must be 64 hex");
      const l = this.db
        .query<{ commit: string }, [string]>("SELECT s.commit_sha AS \"commit\" FROM lineages l JOIN snapshots s ON s.snapshot_id = l.snapshot_id WHERE l.lineage_id = ?")
        .get(lineage_id);
      if (!l) throw bad("bad_session", "unknown lineage");
      if (!this.db.query("SELECT 1 FROM generations WHERE gen_id = ? AND lineage_id = ?").get(gen_id, lineage_id)) throw bad("bad_session", "unknown generation for this lineage");
      if (commit !== l.commit) throw bad("bad_session", "commit is not this lineage's snapshot commit");
      if (typeof proposer !== "string" || !/^[a-z0-9_./-]{1,40}$/.test(proposer)) throw bad("bad_session", "proposer must be a short name");
      const now = this.core.now();
      const live = this.db
        .query<{ c: number }, [string, number]>("SELECT COUNT(*) AS c FROM sessions WHERE agent_id = ? AND ended_at IS NULL AND last_at > ?")
        .get(agent, now - 3600_000)!.c;
      if (live >= SESSION_LIMITS.live_sessions_per_agent) throw new ApiError(429, "too_many_sessions", `at most ${SESSION_LIMITS.live_sessions_per_agent} sessions in progress per agent; end one first`);
      const id = randomBytes(32).toString("hex");
      this.db
        .query("INSERT INTO sessions (session_id, agent_id, lineage_id, gen_id, commit_sha, proposer, started_at, last_at, desktop) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, agent, lineage_id, gen_id, commit, proposer, now, now, body.desktop === true ? 1 : 0);
      this.core.emitEvent("session.started", { session_id: id, agent, lineage_id, gen_id, proposer });
      return { session_id: id, started_at: now };
    });
  }

  /** POST /v1/sessions/:id/events { events: [...] } */
  append(agent: string, id: string, body: unknown) {
    return this.core.tx(() => {
      const s = this.mustOwn(agent, id);
      if (s.ended_at !== null) throw new ApiError(409, "session_ended", "this session has ended");
      if (!isObj(body) || !Array.isArray(body.events)) throw bad("bad_events", "body must be { events: [...] }");
      const events = body.events as unknown[];
      if (events.length === 0) throw bad("bad_events", "events is empty");
      if (events.length > SESSION_LIMITS.batch) throw new ApiError(413, "too_many_events", `at most ${SESSION_LIMITS.batch} events per request`);
      if (s.events + events.length > SESSION_LIMITS.events_per_session) throw new ApiError(413, "session_full", `at most ${SESSION_LIMITS.events_per_session} events per session`);
      const now = this.core.now();
      let seq = s.events;
      let bytes = s.sealed_bytes;
      const rows: { seq: number; kind: string; at: number; pub: Record<string, unknown>; sealed: Record<string, unknown> | null; priv: boolean }[] = [];
      events.forEach((raw, index) => {
        const err = (m: string) => {
          throw bad("bad_events", `#${index}: ${m}`);
        };
        if (!isObj(raw)) return err("not an object");
        const kind = raw.kind;
        if (typeof kind !== "string" || !SESSION_KINDS.has(kind)) return err(`kind must be one of ${[...SESSION_KINDS].join(", ")}`);
        const pub: Record<string, unknown> = { kind };
        const sealed: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(raw)) {
          if (k === "kind") continue;
          if (PUBLIC_KEYS.has(k)) pub[k] = v;
          else if (SEALED_KEYS.has(k)) sealed[k] = v;
          else return err(`unknown field ${k}`);
        }
        // public fields
        let at = now;
        if (pub.at !== undefined) {
          if (typeof pub.at !== "number" || !Number.isFinite(pub.at) || Math.abs(now - pub.at) > this.core.nonceWindowMs || pub.at < s.started_at - 5000) return err("at is outside the accepted window");
          at = Math.round(pub.at);
        }
        pub.at = at;
        const needsPath = ["read", "edit", "write", "patch"].includes(kind);
        if (needsPath && pub.path === undefined) return err(`${kind} needs a path`);
        if (pub.path !== undefined && !(kind === "list" && pub.path === ".") && !validPath(pub.path)) return err("path must be a relative path inside the tree");
        if (pub.start_line !== undefined || pub.end_line !== undefined) {
          if (pub.path === undefined) return err("a line range needs a path");
          if (!isInt(pub.start_line, 1, 10_000_000) || !isInt(pub.end_line, 1, 10_000_000) || (pub.end_line as number) < (pub.start_line as number)) return err("start_line and end_line must be integers with 1 <= start <= end");
        }
        if ((kind === "edit" || kind === "patch") && pub.start_line === undefined) return err(`${kind} needs a line range`);
        if (kind === "search" && (typeof pub.query !== "string" || pub.query.length === 0 || pub.query.length > 500)) return err("search needs a query of 1 to 500 characters");
        if (kind !== "search" && pub.query !== undefined) return err("query is only for search");
        for (const k of ["matches", "count", "lines_before", "lines_after"]) if (pub[k] !== undefined && !isInt(pub[k], 0, 10_000_000)) return err(`${k} must be a non-negative integer`);
        if (kind === "phase" && (typeof pub.phase !== "string" || !PHASES.has(pub.phase))) return err(`phase must be one of ${[...PHASES].join(", ")}`);
        if (kind !== "phase" && pub.phase !== undefined) return err("phase is only for phase events");
        for (const k of ["target", "label", "eval_kind"]) if (pub[k] !== undefined && (typeof pub[k] !== "string" || (pub[k] as string).length === 0 || (pub[k] as string).length > 200)) return err(`${k} must be a string of 1 to 200 characters`);
        if (pub.content_sha256 !== undefined && (kind !== "read" || typeof pub.content_sha256 !== "string" || !HEX64.test(pub.content_sha256))) return err("content_sha256 is a 64 hex digest, only for read");
        // sealed fields: only where they mean something, and bounded
        const allowed: Record<string, string[]> = {
          edit: ["before", "after", "truncated"],
          write: ["before", "after", "truncated"],
          patch: ["before", "after", "truncated"],
          result: ["output", "steps", "outcome", "truncated"],
          note: ["text", "truncated"],
          give_up: ["reason"],
          submit: ["reason"],
        };
        for (const k of Object.keys(sealed)) if (!(allowed[kind] ?? []).includes(k)) return err(`${k} is not a field of ${kind}`);
        for (const k of ["before", "after", "output", "outcome", "text", "reason"]) if (sealed[k] !== undefined && typeof sealed[k] !== "string") return err(`${k} must be a string`);
        if (sealed.truncated !== undefined && typeof sealed.truncated !== "boolean") return err("truncated must be a boolean");
        if (sealed.steps !== undefined) {
          if (!Array.isArray(sealed.steps) || sealed.steps.length > 64) return err("steps must be an array of at most 64 steps");
          for (const st of sealed.steps) {
            if (!isObj(st)) return err("each step must be an object");
            for (const [k, v] of Object.entries(st)) {
              if (!["step", "side", "exit", "duration_ms", "timed_out", "tail"].includes(k)) return err(`unknown step field ${k}`);
              if ((k === "exit" || k === "duration_ms") && !(typeof v === "number" && Number.isFinite(v))) return err(`step ${k} must be a number`);
              if (k === "timed_out" && typeof v !== "boolean") return err("step timed_out must be a boolean");
              if ((k === "step" || k === "side" || k === "tail") && typeof v !== "string") return err(`step ${k} must be a string`);
            }
          }
        }
        const size = Object.keys(sealed).length ? JSON.stringify(sealed).length : 0;
        if (size > SESSION_LIMITS.sealed_bytes_per_event) return err(`sealed fields exceed ${SESSION_LIMITS.sealed_bytes_per_event} bytes; truncate them`);
        bytes += size;
        if (bytes > SESSION_LIMITS.sealed_bytes_per_session) throw new ApiError(413, "session_full", `sealed content exceeds ${SESSION_LIMITS.sealed_bytes_per_session} bytes per session`);
        rows.push({ seq: ++seq, kind, at, pub, sealed: size ? sealed : null, priv: PRIVATE_KINDS.has(kind) });
      });
      const ins = this.db.query("INSERT INTO session_events (session_id, seq, kind, at, pub, sealed, private) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const r of rows) ins.run(id, r.seq, r.kind, r.at, JSON.stringify(r.pub), r.sealed ? JSON.stringify(r.sealed) : null, r.priv ? 1 : 0);
      this.db.query("UPDATE sessions SET events = ?, sealed_bytes = ?, last_at = ? WHERE session_id = ?").run(seq, bytes, now, id);
      // the stream carries the withheld form only: sealed content never enters the event log
      const shown = rows.filter((r) => !r.priv).map((r) => this.eventPublic({ seq: r.seq, kind: r.kind, at: r.at, pub: JSON.stringify(r.pub), sealed: r.sealed ? "{}" : null, private: 0, session_id: id }, false));
      if (shown.length) this.core.emitEvent("session.events", { session_id: id, lineage_id: s.lineage_id, events: shown });
      return { accepted: rows.length, last_seq: seq };
    });
  }

  /** POST /v1/sessions/:id/end { commit_id?: string | null } */
  end(agent: string, id: string, body: unknown) {
    return this.core.tx(() => {
      const s = this.mustOwn(agent, id);
      if (s.ended_at !== null) return this.view(id, agent);
      const b = isObj(body) ? body : {};
      for (const k of Object.keys(b)) if (k !== "commit_id") throw bad("bad_end", `unknown field ${k}`);
      let reported: string | null = null;
      if (b.commit_id !== undefined && b.commit_id !== null) {
        if (typeof b.commit_id !== "string" || !HEX64.test(b.commit_id)) throw bad("bad_end", "commit_id must be 64 hex");
        const c = this.db.query<{ author: string; lineage_id: string; committed_at: number }, [string]>("SELECT author, lineage_id, committed_at FROM candidates WHERE commit_id = ?").get(b.commit_id);
        if (!c || c.author !== agent || c.lineage_id !== s.lineage_id || c.committed_at < s.started_at) throw bad("bad_end", "commit_id is not this agent's candidate on this lineage from this session");
        reported = b.commit_id;
      }
      const now = this.core.now();
      this.db.query("UPDATE sessions SET ended_at = ?, reported_commit = ? WHERE session_id = ?").run(now, reported, id);
      // no agent and no outcome: the end of a session must not time a commit to an agent (10.7)
      this.core.emitEvent("session.ended", { session_id: id, lineage_id: s.lineage_id });
      return this.view(id, agent);
    });
  }

  /**
   * POST /v1/sessions/:id/recording { sha256, bytes }: the desktop recording (SPEC 17.7), an MP4 the
   * agent uploaded to the blob store. Unredacted, so it is accepted only once the gate is open for
   * everyone (candidate final, or ended without one, or abandoned); a party's own full view does not
   * count. Set once.
   */
  recording(agent: string, id: string, body: unknown) {
    return this.core.tx(() => {
      const s = this.mustOwn(agent, id);
      if (!s.desktop) throw bad("no_desktop", "this session did not run on a desktop");
      if (!isObj(body)) throw bad("bad_recording", "body must be { sha256, bytes }");
      for (const k of Object.keys(body)) if (k !== "sha256" && k !== "bytes") throw bad("bad_recording", `unknown field ${k}`);
      const { sha256, bytes } = body;
      if (typeof sha256 !== "string" || !HEX64.test(sha256)) throw bad("bad_recording", "sha256 must be 64 hex");
      if (!isInt(bytes, 1, this.core.maxBlobBytes)) throw bad("bad_recording", "bytes must be a positive integer within the blob limit");
      if (!this.gate(s).open) throw new ApiError(409, "sealed", "the recording is published only once the session's gate is open");
      if (s.recording_sha) {
        if (s.recording_sha === sha256) return this.view(id, agent);
        throw new ApiError(409, "recording_set", "this session already has a recording");
      }
      const blob = this.core.blobs.get(sha256);
      if (!blob) throw bad("missing_blob", "upload the recording (PUT /v1/blobs/:sha256) first");
      if (blob.length !== bytes) throw bad("bad_recording", "bytes does not match the blob");
      // an MP4 starts with a box whose type is ftyp
      if (blob.length < 12 || new TextDecoder().decode(blob.subarray(4, 8)) !== "ftyp") throw bad("bad_recording", "the blob is not an MP4 file");
      this.db.query("UPDATE sessions SET recording_sha = ?, recording_bytes = ? WHERE session_id = ?").run(sha256, bytes, id);
      this.core.emitEvent("session.recording", { session_id: id, lineage_id: s.lineage_id });
      return this.view(id, agent);
    });
  }

  // ---------------------------------------------------------------------------------------------
  // the gate

  /** The attempt's candidate: the reported one, else the agent's first on the lineage inside the session's window. */
  private candidateOf(s: SessionRow): CandLink | null {
    const cols = "commit_id, candidate_id, status, reason, gen_id, author, committed_at, revealed_at, finalized_at, kind, target, verdict";
    if (s.reported_commit) return this.db.query<CandLink, [string]>(`SELECT ${cols} FROM candidates WHERE commit_id = ?`).get(s.reported_commit);
    // a later session of the same agent on the same lineage bounds this one's window
    const next = this.db
      .query<{ t: number }, [string, string, number, string]>("SELECT MIN(started_at) AS t FROM sessions WHERE agent_id = ? AND lineage_id = ? AND started_at >= ? AND session_id != ?")
      .get(s.agent_id, s.lineage_id, s.started_at, s.session_id)?.t;
    const upper = Math.min(next ?? Number.MAX_SAFE_INTEGER, s.ended_at ?? Number.MAX_SAFE_INTEGER);
    return this.db
      .query<CandLink, [string, string, number, number]>(
        `SELECT ${cols} FROM candidates WHERE author = ? AND lineage_id = ? AND committed_at >= ? AND committed_at <= ? AND is_canary = 0 ORDER BY committed_at, commit_id LIMIT 1`,
      )
      .get(s.agent_id, s.lineage_id, s.started_at, upper);
  }

  private hasPublicIntent(s: SessionRow): boolean {
    return !!this.db
      // only an intent that still publicly links the agent to this lineage's work (open, or shown as
      // committed); a withdrawn, stale or expired one named the agent of every later sealed session on
      // the lineage (audit A2, OFF-06)
      .query("SELECT 1 FROM intents WHERE agent = ? AND lineage_id = ? AND created_at <= ? AND public_status IN ('open', 'committed') LIMIT 1")
      .get(s.agent_id, s.lineage_id, s.ended_at ?? this.core.now());
  }

  gate(s: SessionRow): Gate {
    const c = this.candidateOf(s);
    if (c) {
      const final = TERMINAL.has(c.status);
      return { state: final ? "final" : "sealed", open: final, agentPublic: final || this.hasPublicIntent(s), candidate: c };
    }
    if (s.ended_at !== null) return { state: "ended", open: true, agentPublic: true, candidate: null };
    const silent = this.core.now() - s.last_at;
    if (silent > SESSION_LIMITS.abandon_ms) return { state: "abandoned", open: true, agentPublic: true, candidate: null };
    return { state: "live", open: false, agentPublic: true, candidate: null };
  }

  /** The viewer sees everything: the session's agent, a party to its candidate, or the admin. */
  private full(s: SessionRow, g: Gate, viewer?: string | null): boolean {
    if (!viewer) return false;
    if (viewer === s.agent_id || viewer === this.core.adminId) return true;
    if (g.candidate) {
      const c = this.db.query<any, [string]>("SELECT * FROM candidates WHERE commit_id = ?").get(g.candidate.commit_id);
      return !!c && !this.core.collab.blind(c, viewer);
    }
    return false;
  }

  private eventPublic(r: EventRow, open: boolean) {
    const pub = JSON.parse(r.pub) as Record<string, unknown>;
    const out: Record<string, unknown> = { seq: r.seq, ...pub };
    if (r.sealed) {
      if (open) Object.assign(out, JSON.parse(r.sealed));
      else out.sealed = true;
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // reads

  private summary(s: SessionRow, g: Gate, full: boolean) {
    const showAgent = full || g.agentPublic;
    const showCand = full || g.state === "final";
    const c = g.candidate;
    const recipe = this.db
      .query<{ name: string; class: string; repo: string; height: number }, [string, string]>(
        `SELECT json_extract(r.json, '$.name') AS name, json_extract(r.json, '$.class') AS class, rp.url AS repo, g.height AS height
         FROM lineages l JOIN recipes r ON r.recipe_id = l.recipe_id JOIN repos rp ON rp.repo_id = l.repo_id JOIN generations g ON g.gen_id = ?
         WHERE l.lineage_id = ?`,
      )
      .get(s.gen_id, s.lineage_id);
    return {
      session_id: s.session_id,
      state: g.state,
      open: g.open || full,
      agent: showAgent ? s.agent_id : null,
      lineage_id: s.lineage_id,
      recipe_name: recipe?.name ?? null,
      class: recipe?.class ?? null,
      repo: recipe?.repo ?? null,
      commit: s.commit_sha,
      gen_id: s.gen_id,
      height: recipe?.height ?? null,
      proposer: s.proposer,
      started_at: s.started_at,
      last_at: s.last_at,
      ended_at: s.ended_at,
      events: s.events,
      desktop: !!s.desktop,
      // set only after the gate opened (recording()); a link to Core's blob store
      recording: s.recording_sha && g.open ? { sha256: s.recording_sha, bytes: s.recording_bytes, url: `/v1/blobs/${s.recording_sha}` } : null,
      candidate:
        c && showCand
          ? {
              commit_id: c.commit_id,
              candidate_id: c.candidate_id,
              status: c.status,
              reason: c.reason,
              kind: c.kind,
              target: JSON.parse(c.target),
              gen_id: c.gen_id,
              committed_at: c.committed_at,
              finalized_at: c.finalized_at,
              verdict: TERMINAL.has(c.status) && c.verdict ? JSON.parse(c.verdict) : null,
            }
          : null,
    };
  }

  /** GET /v1/sessions/:id: the session and its events (sealed content only once the gate is open). */
  view(id: string, viewer?: string | null, opts: { after?: number; limit?: number } = {}) {
    const s = this.row(id);
    if (!s) throw notFound("session");
    const g = this.gate(s);
    const full = this.full(s, g, viewer);
    const open = g.open || full;
    const rows = this.db
      .query<EventRow, [string, number, number]>("SELECT * FROM session_events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?")
      .all(id, Math.max(0, opts.after ?? 0), Math.max(1, Math.min(opts.limit ?? SESSION_LIMITS.events_per_session, SESSION_LIMITS.events_per_session)));
    return {
      ...this.summary(s, g, full),
      event_list: rows.filter((r) => open || !r.private).map((r) => this.eventPublic(r, open)),
    };
  }

  /** GET /v1/sessions?lineage=&agent=&state=&limit=: newest first; by agent only where the agent may be named. */
  list(q: { lineage?: string; agent?: string; state?: string; limit?: number }, viewer?: string | null) {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.lineage) (where.push("lineage_id = ?"), args.push(q.lineage));
    if (q.agent) (where.push("agent_id = ?"), args.push(q.agent));
    const limit = Math.max(1, Math.min(q.limit ?? 50, 500));
    const rows = this.db
      .query<SessionRow, (string | number)[]>(`SELECT * FROM sessions ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY started_at DESC, session_id LIMIT ?`)
      .all(...args, q.agent ? limit * 4 : limit);
    const out = [];
    for (const s of rows) {
      const g = this.gate(s);
      const full = this.full(s, g, viewer);
      if (q.agent && !full && !g.agentPublic) continue;
      if (q.state && g.state !== q.state) continue;
      out.push(this.summary(s, g, full));
      if (out.length >= limit) break;
    }
    return out;
  }
}
