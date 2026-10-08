import type { Core } from "./core.ts";
import { ApiError, bad, conflict, forbidden, notFound } from "./errors.ts";
import { canonicalJson, H, Rng, signStatement, verifyStatement, type AgentKey, type Calibration, type Recipe } from "./protocol.ts";

// Collaboration and author-blind replay (docs/plans/IDENTITY-AND-COLLABORATION.md 2.7, 3.3, 3.6;
// SPEC 10.7, 12.1, 12.2). Everything here runs inside a Core transaction, reads time only from
// Core's clock and draws randomness from the epoch secret, like the rest of Core.
//
// - Author-blind replay (SPEC 10.7): while a candidate is not final, no public view, list or event
//   names its author or team. Only the author, its team members and the admin see them. The
//   candidate id hashes an author tag H("author-tag", author, salt) instead of the author, so a
//   replayer that holds the patch cannot recompute the id for each known agent and find the author;
//   the salt is published once the candidate is final, when anyone can recompute the id.
// - Shadow parity: every public signal that stays visible during replay is produced for shadows
//   too. Shadows keep their secret keys here (Core only), so they can sign what real agents sign.
//
// Tables are created here with CREATE TABLE IF NOT EXISTS, outside the numbered migrations in
// store.ts, so this module never competes with another lane for a migration number.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shadow_keys (
  agent_id TEXT PRIMARY KEY,
  secret TEXT NOT NULL                  -- hex, 64 bytes (Solana keypair layout); Core only
);
CREATE TABLE IF NOT EXISTS intents (
  intent_id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  lineage_id TEXT NOT NULL,
  tip TEXT NOT NULL,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,                 -- canonical JSON (metric name, or sorted test ids for fix)
  finding_id TEXT,
  note TEXT,
  ttl_s INTEGER NOT NULL,
  sig TEXT NOT NULL,                    -- signStatement(agent, "intent", statement)
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL,                 -- private: open | committed | withdrawn | expired | stale
  candidate TEXT,                       -- commit_id it led to (private until that candidate is final)
  public_status TEXT NOT NULL,          -- what everyone sees: open | stale | expired | withdrawn | committed
  closed_at INTEGER,                    -- public close time
  shadow INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS intents_lineage ON intents(lineage_id, public_status);
CREATE INDEX IF NOT EXISTS intents_agent ON intents(agent, created_at);
CREATE TABLE IF NOT EXISTS shadow_plans (
  queue_id INTEGER PRIMARY KEY,         -- canary_queue.id
  shadow_id TEXT NOT NULL,
  intent_at INTEGER,                    -- when the shadow files its intent (null: none)
  ttl_s INTEGER,
  intent_id TEXT
);
`;

const TERMINAL = new Set(["accepted", "rejected", "expired"]);

const OPEN_SQL = "'committed','queued','replaying','disputed'";
const INTENT_KINDS = new Set(["perf", "fix", "slim"]);

/** The parts of Core this module reads. Core passes itself; the private members exist at runtime. */
interface Internals {
  db: Core["db"];
  cfg: Core["cfg"];
  adminId: string;
  now(): number;
  tx<T>(fn: () => T): T;
  currentEpoch(): { n: number; secret: string };
  emitEvent(type: string, data: unknown): void;
  recipeOf(id: string): Recipe;
  effectiveCalibration(calib_id: string, gen: string): Calibration;
  identity?: { signingKey?(agent: string): string | null };
}

interface IntentRow {
  intent_id: string;
  agent: string;
  lineage_id: string;
  tip: string;
  kind: string;
  target: string;
  finding_id: string | null;
  note: string | null;
  ttl_s: number;
  sig: string;
  created_at: number;
  expires_at: number;
  status: string;
  candidate: string | null;
  public_status: string;
  closed_at: number | null;
  shadow: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Same normalisation as candidate targets: a metric name, or sorted unique test ids for fix. */
export function intentTarget(kind: string, t: unknown): string | string[] {
  if (kind === "fix") {
    const arr = typeof t === "string" ? [t] : t;
    if (!Array.isArray(arr) || arr.length === 0 || !arr.every((x) => typeof x === "string" && x.length > 0)) throw bad("bad_target", "fix target is a non-empty list of test ids");
    return [...new Set(arr as string[])].sort();
  }
  if (typeof t !== "string" || !t) throw bad("bad_target", `${kind} target is a metric name`);
  return t;
}

/** The statement an intent's `sig` covers: signStatement(key, "intent", intentStatement(...)). */
export function intentStatement(p: { agent: string; lineage_id: string; tip: string; kind: string; target: string | string[]; finding_id?: string | null; note?: string | null; ttl_s: number }) {
  return { v: 1, agent: p.agent, lineage_id: p.lineage_id, tip: p.tip, kind: p.kind, target: p.target, finding_id: p.finding_id ?? null, note: p.note ?? null, ttl_s: p.ttl_s };
}

export interface CandidateLike {
  commit_id: string;
  author: string;
  status: string;
}

export class Collab {
  private readonly c: Internals;

  constructor(core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(SCHEMA);
  }

  private get db() {
    return this.c.db;
  }

  // ---------------------------------------------------------------------------------------------
  // Author-blind replay (SPEC 10.7)

  /** What the candidate id hashes in place of the author (SPEC 4). */
  authorTag(author: string, salt: string): string {
    return H("author-tag", author, salt);
  }

  /** The agents a candidate belongs to: its author plus, for a team candidate, every member. */
  parties(c: CandidateLike): string[] {
    return [c.author];
  }

  /** True when `viewer` may not see who authored `c`: it is open and the viewer is not a party or the admin. */
  blind(c: CandidateLike, viewer?: string | null): boolean {
    if (TERMINAL.has(c.status)) return false;
    if (!viewer) return true;
    if (viewer === this.c.adminId) return false;
    return !this.parties(c).includes(viewer);
  }

  /** SQL condition (on table `candidates`) for rows whose author a viewer may see. */
  visibleAuthorSql(viewer?: string | null): { sql: string; args: string[] } {
    const final = `status IN ('accepted','rejected','expired')`;
    if (viewer && viewer === this.c.adminId) return { sql: "1", args: [] };
    if (!viewer) return { sql: final, args: [] };
    return { sql: `(${final} OR author = ?)`, args: [viewer] };
  }

  /** An assignment round names its subject's exclusions and draw; public only once the subject is final. */
  subjectFinal(subject: string): boolean {
    const c = this.db.query<{ status: string }, [string]>("SELECT status FROM candidates WHERE candidate_id = ?").get(subject);
    if (c) return TERMINAL.has(c.status);
    const a = this.db.query<{ status: string }, [string]>("SELECT status FROM audits WHERE audit_id = ?").get(subject);
    if (a) return a.status !== "pending";
    return true;
  }

  // ---------------------------------------------------------------------------------------------
  // Shadow keys (shadow parity)

  rememberShadowKey(k: AgentKey) {
    this.db.query("INSERT OR IGNORE INTO shadow_keys (agent_id, secret) VALUES (?, ?)").run(k.id, Buffer.from(k.secret).toString("hex"));
  }

  shadowKey(id: string): AgentKey | null {
    const r = this.db.query<{ secret: string }, [string]>("SELECT secret FROM shadow_keys WHERE agent_id = ?").get(id);
    return r ? { id, secret: Uint8Array.from(Buffer.from(r.secret, "hex")) } : null;
  }

  /** Called from Hardening.tick(): intent expiry and staleness, shadow intents that are due. */
  tick() {
    this.fileDueShadowIntents();
    this.advanceIntents();
  }

  // ---------------------------------------------------------------------------------------------
  // Intents (SPEC 12.1): advisory, public, capped, short-lived; no locks and no priority

  private signerOf(agent: string): string {
    return this.c.identity?.signingKey?.(agent) ?? agent;
  }

  fileIntent(agent: string, body: unknown) {
    return this.c.tx(() => this.fileIntentInner(agent, body, false));
  }

  private fileIntentInner(agent: string, body: unknown, shadow: boolean) {
    const a = this.db.query<{ kind: string; lifecycle: string }, [string]>("SELECT kind, lifecycle FROM agents WHERE agent_id = ?").get(agent);
    if (!a) throw forbidden("not_registered", `agent ${agent} is not registered`);
    if (a.kind !== "launched") throw forbidden("not_an_author", "only launched agents author, so only they file intents");
    if (!isObj(body)) throw bad("bad_body", "object expected");
    const l = this.db
      .query<{ lineage_id: string; tip: string; status: string; recipe_id: string; calib_id: string }, [string]>("SELECT lineage_id, tip, status, recipe_id, calib_id FROM lineages WHERE lineage_id = ?")
      .get(String(body.lineage_id ?? ""));
    if (!l) throw notFound("lineage");
    if (l.status !== "active") throw forbidden("lineage_inactive", "lineage is not active");
    if (body.tip !== l.tip) throw conflict("stale_tip", `tip is ${l.tip}; an intent names the current tip`);
    const kind = String(body.kind ?? "");
    if (!INTENT_KINDS.has(kind)) throw bad("bad_kind", "kind is perf, fix or slim");
    const target = intentTarget(kind, body.target);
    const recipe = this.c.recipeOf(l.recipe_id);
    const calib = this.c.effectiveCalibration(l.calib_id, l.tip);
    if (kind === "fix") {
      const known = new Set(calib.known_failures);
      if (!(target as string[]).every((t) => known.has(t))) throw bad("bad_target", "a fix intent names known failures of the tip");
    } else {
      const m = recipe.metrics.find((x) => x.name === target);
      if (!m || m.kind !== kind || !calib.metrics[m.name]?.enabled) throw bad("bad_target", `${target} is not an enabled ${kind} metric of this lineage`);
    }
    let finding: string | null = null;
    if (body.finding_id !== undefined && body.finding_id !== null) {
      finding = String(body.finding_id);
      if (!this.db.query("SELECT 1 FROM findings WHERE finding_id = ? AND lineage_id = ? AND status = 'open'").get(finding, l.lineage_id)) throw bad("bad_finding", "finding_id is not an open finding of this lineage");
    }
    let note: string | null = null;
    if (body.note !== undefined && body.note !== null) {
      if (typeof body.note !== "string" || body.note.length > 280) throw bad("bad_note", "note is a string of at most 280 characters");
      note = body.note;
    }
    const ttl = body.ttl_s;
    if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 1 || ttl > this.c.cfg.intent_max_ttl_s) throw bad("bad_ttl", `ttl_s is an integer from 1 to intent_max_ttl_s (${this.c.cfg.intent_max_ttl_s})`);
    const stmt = intentStatement({ agent, lineage_id: l.lineage_id, tip: l.tip, kind, target, finding_id: finding, note, ttl_s: ttl });
    if (typeof body.sig !== "string" || !verifyStatement(this.signerOf(agent), body.sig, "intent", stmt)) throw forbidden("bad_signature", "sig must be signStatement(key, \"intent\", statement)");
    const now = this.c.now();
    // an intent counts against the cap until it publicly ends, even after it led to a commit
    const live = this.db.query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM intents WHERE agent = ? AND public_status = 'open'").get(agent)!.c;
    if (live >= this.c.cfg.max_intents_per_agent) throw new ApiError(429, "too_many_intents", `max_intents_per_agent is ${this.c.cfg.max_intents_per_agent}`);
    const hour = this.db.query<{ c: number }, [string, number]>("SELECT COUNT(*) AS c FROM intents WHERE agent = ? AND created_at > ?").get(agent, now - 3_600_000)!.c;
    if (hour >= this.c.cfg.intent_rate_per_hour) throw new ApiError(429, "intent_rate", `at most intent_rate_per_hour (${this.c.cfg.intent_rate_per_hour}) intents per agent per hour`);
    const id = H("intent", agent, l.lineage_id, l.tip, kind, canonicalJson(target), String(now));
    if (this.db.query("SELECT 1 FROM intents WHERE intent_id = ?").get(id)) throw conflict("duplicate_intent", "same intent filed in the same millisecond");
    this.db
      .query(
        `INSERT INTO intents (intent_id, agent, lineage_id, tip, kind, target, finding_id, note, ttl_s, sig, created_at, expires_at, status, public_status, shadow)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 'open', ?)`,
      )
      .run(id, agent, l.lineage_id, l.tip, kind, canonicalJson(target), finding, note, ttl, body.sig, now, now + ttl * 1000, shadow ? 1 : 0);
    this.c.emitEvent("intent.opened", { intent_id: id, agent, lineage_id: l.lineage_id, tip: l.tip, kind, target, finding_id: finding, expires_at: now + ttl * 1000 });
    return this.intentView(this.intentRow(id)!, agent);
  }

  private intentRow(id: string): IntentRow | null {
    return this.db.query<IntentRow, [string]>("SELECT * FROM intents WHERE intent_id = ?").get(id);
  }

  withdrawIntent(agent: string, id: string) {
    return this.c.tx(() => {
      const r = this.intentRow(id);
      if (!r) throw notFound("intent");
      if (r.agent !== agent) throw forbidden("not_owner", "only the agent that filed an intent may withdraw it");
      if (r.public_status !== "open") throw conflict("not_open", `intent is ${r.public_status}`);
      const now = this.c.now();
      if (r.status === "open") this.db.query("UPDATE intents SET status = 'withdrawn' WHERE intent_id = ?").run(id);
      this.db.query("UPDATE intents SET public_status = 'withdrawn', closed_at = ? WHERE intent_id = ?").run(now, id);
      this.c.emitEvent("intent.closed", { intent_id: id, agent, lineage_id: r.lineage_id, reason: "withdrawn" });
      return this.intentView(this.intentRow(id)!, agent);
    });
  }

  /**
   * At commit: the author's (and team members') open intents on the same lineage, kind and target
   * now point at the candidate. The link stays private until the candidate is final: publicly the
   * intent runs on unchanged (open until its TTL or a tip move), so its end cannot time the commit.
   */
  onCommit(agents: string[], lineage: string, kind: string, target: unknown, commitId: string) {
    const t = canonicalJson(target);
    for (const a of agents)
      this.db
        .query("UPDATE intents SET status = 'committed', candidate = ? WHERE agent = ? AND lineage_id = ? AND kind = ? AND target = ? AND status = 'open'")
        .run(commitId, a, lineage, kind, t);
  }

  /**
   * Public intent state machine, the same for every intent whether or not it led to a commit:
   * open, then stale when its tip is no longer the lineage tip, expired when its TTL passes; an
   * intent that led to a candidate shows `committed` (with the candidate) once that candidate is
   * final. Each public transition emits `intent.closed`.
   */
  private advanceIntents() {
    const now = this.c.now();
    const rows = this.db
      .query<IntentRow & { ltip: string }, []>("SELECT i.*, l.tip AS ltip FROM intents i JOIN lineages l ON l.lineage_id = i.lineage_id WHERE i.public_status IN ('open','stale','expired') ORDER BY i.created_at, i.intent_id")
      .all();
    for (const r of rows) {
      let next = r.public_status;
      const cand = r.candidate
        ? this.db.query<{ status: string; candidate_id: string | null; gen_id: string | null }, [string]>("SELECT status, candidate_id, gen_id FROM candidates WHERE commit_id = ?").get(r.candidate)
        : null;
      if (cand && TERMINAL.has(cand.status)) next = "committed";
      else if (r.public_status === "open" && now >= r.expires_at) next = "expired";
      else if (r.public_status === "open" && r.ltip !== r.tip) next = "stale";
      if (next === r.public_status) continue;
      if (r.status === "open" && (next === "expired" || next === "stale")) this.db.query("UPDATE intents SET status = ? WHERE intent_id = ?").run(next, r.intent_id);
      this.db.query("UPDATE intents SET public_status = ?, closed_at = COALESCE(closed_at, ?) WHERE intent_id = ?").run(next, now, r.intent_id);
      this.c.emitEvent("intent.closed", {
        intent_id: r.intent_id,
        agent: r.agent,
        lineage_id: r.lineage_id,
        reason: next,
        ...(next === "committed" ? { candidate_id: cand!.candidate_id, commit_id: r.candidate, outcome: cand!.status, gen_id: cand!.gen_id } : {}),
      });
    }
  }

  /** Public view; the agent itself (and the admin) also sees the private status and the candidate it led to. */
  intentView(r: IntentRow, viewer?: string | null) {
    const full = !!viewer && (viewer === r.agent || viewer === this.c.adminId);
    const showLink = full || r.public_status === "committed";
    const cand = showLink && r.candidate ? this.db.query<{ candidate_id: string | null; status: string; gen_id: string | null }, [string]>("SELECT candidate_id, status, gen_id FROM candidates WHERE commit_id = ?").get(r.candidate) : null;
    return {
      intent_id: r.intent_id,
      agent: r.agent,
      lineage_id: r.lineage_id,
      tip: r.tip,
      kind: r.kind,
      target: JSON.parse(r.target),
      finding_id: r.finding_id,
      note: r.note,
      ttl_s: r.ttl_s,
      sig: r.sig,
      created_at: r.created_at,
      expires_at: r.expires_at,
      status: full ? r.status : r.public_status,
      closed_at: r.closed_at,
      candidate: cand ? { commit_id: r.candidate, candidate_id: cand.candidate_id, status: cand.status, gen_id: cand.gen_id } : null,
    };
  }

  listIntents(q: { lineage?: string; agent?: string; target?: string; status?: string; limit?: number }, viewer?: string | null) {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.lineage) (where.push("lineage_id = ?"), args.push(q.lineage));
    if (q.agent) (where.push("agent = ?"), args.push(q.agent));
    const status = q.status ?? "open";
    if (status !== "all") (where.push("public_status = ?"), args.push(status));
    args.push(Math.max(1, Math.min(q.limit ?? 200, 1000)));
    const rows = this.db.query<IntentRow, (string | number)[]>(`SELECT * FROM intents ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, intent_id LIMIT ?`).all(...args);
    return rows
      .filter((r) => !q.target || JSON.parse(r.target) === q.target || (Array.isArray(JSON.parse(r.target)) && (JSON.parse(r.target) as string[]).includes(q.target)))
      .map((r) => this.intentView(r, viewer));
  }

  /** Intent record of an agent (SPEC 12.1): spam is visible without punishing honest abandoned work. */
  intentStats(agent: string) {
    const one = (sql: string) => this.db.query<{ c: number }, [string]>(sql).get(agent)!.c;
    return {
      filed: one("SELECT COUNT(*) AS c FROM intents WHERE agent = ?"),
      open: one("SELECT COUNT(*) AS c FROM intents WHERE agent = ? AND public_status = 'open'"),
      led_to_candidate: one("SELECT COUNT(*) AS c FROM intents WHERE agent = ? AND public_status = 'committed'"),
      led_to_generation: one(
        "SELECT COUNT(*) AS c FROM intents i JOIN candidates c ON c.commit_id = i.candidate WHERE i.agent = ? AND i.public_status = 'committed' AND c.status = 'accepted'",
      ),
      withdrawn: one("SELECT COUNT(*) AS c FROM intents WHERE agent = ? AND public_status = 'withdrawn'"),
      expired: one("SELECT COUNT(*) AS c FROM intents WHERE agent = ? AND public_status IN ('expired','stale')"),
    };
  }

  /**
   * GET /v1/lineages/:id/workboard: live intents, every target with who holds an intent on it, and
   * the last `workboard_window_s` of public activity per file (no submits, SPEC 10.7).
   */
  workboard(lineageId: string) {
    const l = this.db.query<{ lineage_id: string; tip: string; height: number; recipe_id: string; calib_id: string }, [string]>("SELECT * FROM lineages WHERE lineage_id = ?").get(lineageId);
    if (!l) throw notFound("lineage");
    const now = this.c.now();
    const intents = this.listIntents({ lineage: lineageId, status: "open" });
    const recipe = this.c.recipeOf(l.recipe_id);
    const calib = this.c.effectiveCalibration(l.calib_id, l.tip);
    const targets: { kind: string; target: string | string[]; holders: string[] }[] = [];
    for (const m of recipe.metrics) if (calib.metrics[m.name]?.enabled) targets.push({ kind: m.kind, target: m.name, holders: [] });
    for (const t of calib.known_failures) targets.push({ kind: "fix", target: [t], holders: [] });
    for (const i of intents) {
      const key = canonicalJson(i.target);
      const hit = targets.find((t) => t.kind === i.kind && (canonicalJson(t.target) === key || (Array.isArray(i.target) && Array.isArray(t.target) && (i.target as string[]).includes(t.target[0]!))));
      if (hit && !hit.holders.includes(i.agent)) hit.holders.push(i.agent);
    }
    const since = now - this.c.cfg.workboard_window_s * 1000;
    const rows = this.db
      .query<{ path: string; agent_id: string; kind: string; n: number; last: number }, [string, number]>(
        `SELECT path, agent_id, kind, COUNT(*) AS n, MAX(received_at) AS last FROM activity
         WHERE lineage_id = ? AND received_at > ? AND path IS NOT NULL AND kind IN ('read','edit') GROUP BY path, agent_id, kind ORDER BY last DESC`,
      )
      .all(lineageId, since);
    const files = new Map<string, { path: string; last_at: number; agents: Map<string, { agent: string; reads: number; edits: number; last_at: number }> }>();
    for (const r of rows) {
      const f = files.get(r.path) ?? { path: r.path, last_at: 0, agents: new Map() };
      const a = f.agents.get(r.agent_id) ?? { agent: r.agent_id, reads: 0, edits: 0, last_at: 0 };
      if (r.kind === "read") a.reads += r.n;
      else a.edits += r.n;
      a.last_at = Math.max(a.last_at, r.last);
      f.last_at = Math.max(f.last_at, r.last);
      f.agents.set(r.agent_id, a);
      files.set(r.path, f);
    }
    return {
      lineage_id: lineageId,
      tip: l.tip,
      height: l.height,
      now,
      window_s: this.c.cfg.workboard_window_s,
      intents,
      targets,
      files: [...files.values()].sort((x, y) => y.last_at - x.last_at).map((f) => ({ path: f.path, last_at: f.last_at, agents: [...f.agents.values()].sort((x, y) => y.last_at - x.last_at) })),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Shadow intents (shadow parity, SPEC 10.7)

  /**
   * Called when a canary is queued (Hardening.scheduleCanary). With the probability that a real
   * candidate of this lineage was preceded by its author's intent on the same target, a shadow is
   * picked now and files an intent on the canary's target before the canary is committed, with the
   * lead time and TTL drawn from real intents of the lineage.
   */
  planShadowIntent(q: { id: number; lineage_id: string; kind: string; target: string; inject_at: number }, rng: Rng, shadows: string[]) {
    const real = this.db
      .query<{ commit_id: string; committed_at: number }, [string]>(`SELECT commit_id, committed_at FROM candidates WHERE lineage_id = ? AND is_canary = 0 ORDER BY committed_at DESC LIMIT 50`)
      .all(q.lineage_id);
    if (!real.length || !shadows.length) return;
    const led = this.db
      .query<{ gap: number; ttl_s: number }, [string]>(
        `SELECT c.committed_at - i.created_at AS gap, i.ttl_s FROM intents i JOIN candidates c ON c.commit_id = i.candidate
         WHERE i.lineage_id = ? AND i.shadow = 0 AND c.is_canary = 0 ORDER BY c.committed_at DESC LIMIT 50`,
      )
      .all(q.lineage_id);
    const withIntent = new Set(
      this.db
        .query<{ candidate: string }, [string]>("SELECT DISTINCT candidate FROM intents WHERE lineage_id = ? AND shadow = 0 AND candidate IS NOT NULL")
        .all(q.lineage_id)
        .map((r) => r.candidate),
    );
    const rate = real.filter((r) => withIntent.has(r.commit_id)).length / real.length;
    const shadow = shadows[rng.int(shadows.length)]!;
    if (rng.next() >= rate || !led.length) {
      this.db.query("INSERT OR REPLACE INTO shadow_plans (queue_id, shadow_id) VALUES (?, ?)").run(q.id, shadow);
      return;
    }
    const pick = led[rng.int(led.length)]!;
    const now = this.c.now();
    let at = q.inject_at - Math.max(1000, pick.gap);
    if (at < now + 1000) at = now + 1000;
    // the canary waits for its intent: it is committed a real-looking gap after it
    const inject = Math.max(q.inject_at, at + Math.max(1000, Math.min(pick.gap, 60_000)));
    if (inject !== q.inject_at) this.db.query("UPDATE canary_queue SET inject_at = ? WHERE id = ?").run(inject, q.id);
    const ttl = Math.min(this.c.cfg.intent_max_ttl_s, Math.max(pick.ttl_s, Math.ceil((inject - at) / 1000) + 1));
    this.db.query("INSERT OR REPLACE INTO shadow_plans (queue_id, shadow_id, intent_at, ttl_s) VALUES (?, ?, ?, ?)").run(q.id, shadow, at, ttl);
  }

  /** The shadow planned for a queued canary, if it is still usable. */
  plannedShadow(queueId: number, usable: string[]): string | null {
    const p = this.db.query<{ shadow_id: string }, [number]>("SELECT shadow_id FROM shadow_plans WHERE queue_id = ?").get(queueId);
    return p && usable.includes(p.shadow_id) ? p.shadow_id : null;
  }

  private fileDueShadowIntents() {
    const now = this.c.now();
    const due = this.db
      .query<{ queue_id: number; shadow_id: string; ttl_s: number; lineage_id: string; canary_id: string; status: string }, [number]>(
        `SELECT p.queue_id, p.shadow_id, p.ttl_s, q.lineage_id, q.canary_id, q.status FROM shadow_plans p JOIN canary_queue q ON q.id = p.queue_id
         WHERE p.intent_at IS NOT NULL AND p.intent_at <= ? AND p.intent_id IS NULL ORDER BY p.intent_at, p.queue_id`,
      )
      .all(now);
    for (const d of due) {
      const key = this.shadowKey(d.shadow_id);
      const canary = this.db.query<{ kind: string; target: string }, [string]>("SELECT kind, target FROM canaries WHERE canary_id = ?").get(d.canary_id);
      const l = this.db.query<{ tip: string }, [string]>("SELECT tip FROM lineages WHERE lineage_id = ?").get(d.lineage_id);
      if (!key || !canary || !l || d.status !== "pending") {
        this.db.query("UPDATE shadow_plans SET intent_id = '' WHERE queue_id = ?").run(d.queue_id);
        continue;
      }
      const target = JSON.parse(canary.target);
      const ttl = Math.max(1, Math.min(d.ttl_s, this.c.cfg.intent_max_ttl_s));
      const stmt = intentStatement({ agent: key.id, lineage_id: d.lineage_id, tip: l.tip, kind: canary.kind, target: intentTarget(canary.kind, target), ttl_s: ttl });
      try {
        const v = this.fileIntentInner(key.id, { lineage_id: d.lineage_id, tip: l.tip, kind: canary.kind, target, ttl_s: ttl, sig: signStatement(key, "intent", stmt) }, true);
        this.db.query("UPDATE shadow_plans SET intent_id = ? WHERE queue_id = ?").run(v.intent_id, d.queue_id);
      } catch {
        // refused like a real intent would be (cap, rate, target no longer valid): the canary goes ahead without one
        this.db.query("UPDATE shadow_plans SET intent_id = '' WHERE queue_id = ?").run(d.queue_id);
      }
    }
  }
}
