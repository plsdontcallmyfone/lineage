import type { Core } from "./core.ts";
import { ApiError, bad, forbidden, notFound } from "./errors.ts";
import type { Recipe } from "./protocol.ts";
import type { TreeSource } from "./trees.ts";

// Live activity and heartbeats, SPEC 17.1. Activity is evidence of effort, never of value: it earns
// nothing and is stored apart from verified work. Two rules keep it honest and keep sealed work
// sealed:
//
// - Every activity event names objects Core already holds (lineage, generation, snapshot commit,
//   and a path in that generation's tree when Core can list it). Unknown fields are refused, so an
//   event can never carry file content or patch text: edits are a path and a line range.
// - A heartbeat for a replay names the replay privately. Until the candidate is final, the public
//   machine view shows the job, phase and target class only: no candidate id, lineage or
//   generation, because any of them would link a replayer to a candidate (README: replayer
//   identities stay hidden until the candidate is final).

export const ACTIVITY_KINDS = new Set(["read", "search", "edit", "evaluate", "propose", "submit", "give_up"]);
export const JOBS = new Set(["replay", "qualify", "author", "idle"]);
export const PHASES = new Set(["prepare", "build", "test", "equivalence", "metrics", "commit", "reveal", "propose"]);
const ACTIVITY_KEYS = new Set(["kind", "lineage_id", "gen_id", "commit", "path", "start_line", "end_line", "query", "target", "content_sha256", "at"]);
const HEARTBEAT_KEYS = new Set(["caps_digest", "job", "phase", "replay_id", "lineage_id", "gen_id", "container_started_at", "job_started_at", "load", "at"]);
const LOAD_KEYS = new Set(["load1", "load5", "load15", "mem_free_mb"]);
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_BATCH = 200;
const FINAL = new Set(["accepted", "rejected", "expired"]);

interface ActivityRow {
  id: number;
  agent_id: string;
  kind: string;
  lineage_id: string;
  gen_id: string;
  commit_sha: string;
  path: string | null;
  start_line: number | null;
  end_line: number | null;
  query: string | null;
  target: string | null;
  content_sha256: string | null;
  path_checked: number;
  at: number;
  received_at: number;
}

interface HeartbeatRow {
  agent_id: string;
  at: number;
  sent_at: number;
  caps_digest: string | null;
  job: string;
  phase: string | null;
  replay_id: string | null;
  lineage_id: string | null;
  gen_id: string | null;
  container_started_at: number | null;
  job_started_at: number | null;
  load: string | null;
  beats: number;
  first_at: number;
}

interface LineageInfo {
  lineage_id: string;
  recipe_id: string;
  snapshot_id: string;
  tip: string;
  height: number;
  status: string;
  commit: string;
  repo: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

export function validPath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0 || p.length > 1024) return false;
  if (p.startsWith("/") || p.includes("\0") || p.includes("\\")) return false;
  return !p.split("/").some((s) => s === ".." || s === "." || s === "" || s === ".git");
}

export class Live {
  private listCache = new Map<string, Set<string> | null>();
  private lastActivityEmit = new Map<string, number>();
  private recipes = new Map<string, Recipe>();

  constructor(
    private core: Core,
    private trees: TreeSource | null,
  ) {}

  private get db() {
    return this.core.db;
  }
  private awakeMs() {
    return 3 * this.core.cfg.heartbeat_s * 1000;
  }

  private recipe(id: string): Recipe {
    let r = this.recipes.get(id);
    if (!r) {
      const row = this.db.query<{ json: string }, [string]>("SELECT json FROM recipes WHERE recipe_id = ?").get(id);
      if (!row) throw notFound("recipe");
      r = JSON.parse(row.json) as Recipe;
      this.recipes.set(id, r);
    }
    return r;
  }

  private lineage(id: string): LineageInfo | null {
    return this.db
      .query<LineageInfo, [string]>(
        `SELECT l.lineage_id, l.recipe_id, l.snapshot_id, l.tip, l.height, l.status, s.commit_sha AS "commit", r.url AS repo
         FROM lineages l JOIN snapshots s ON s.snapshot_id = l.snapshot_id JOIN repos r ON r.repo_id = l.repo_id WHERE l.lineage_id = ?`,
      )
      .get(id);
  }

  private genInLineage(gen: string, lineage: string): { height: number } | null {
    return this.db.query<{ height: number }, [string, string]>("SELECT height FROM generations WHERE gen_id = ? AND lineage_id = ?").get(gen, lineage);
  }

  /** File list of the tree at a generation, cached (generations are immutable). */
  private filesAt(l: LineageInfo, gen: string): Set<string> | null {
    if (!this.trees) return null;
    if (this.listCache.has(gen)) return this.listCache.get(gen)!;
    const list = this.trees.listFiles(this.recipe(l.recipe_id), l.commit, this.core.patchSeries(gen).map((p) => p.patch));
    if (list) this.listCache.set(gen, list);
    return list;
  }

  // ---------------------------------------------------------------------------------------------
  // POST /v1/activity

  postActivity(agent: string, body: unknown) {
    return this.core.tx(() => {
      const a = this.db.query<{ shadow: number }, [string]>("SELECT shadow FROM agents WHERE agent_id = ?").get(agent);
      if (!a) throw forbidden("not_registered", "only registered agents may post activity");
      if (!isObj(body) || !Array.isArray(body.events)) throw bad("bad_activity", "body must be { events: [...] }");
      const events = body.events as unknown[];
      if (events.length === 0) throw bad("bad_activity", "events is empty");
      if (events.length > MAX_BATCH) throw new ApiError(413, "too_many_events", `at most ${MAX_BATCH} events per request`);
      const now = this.core.now();
      const used = this.db.query<{ c: number }, [string, number]>("SELECT COUNT(*) AS c FROM activity WHERE agent_id = ? AND received_at > ?").get(agent, now - 60_000)!.c;
      let budget = Math.max(0, this.core.cfg.activity_rate - used);
      const refused: { index: number; error: string }[] = [];
      const accepted: ActivityRow[] = [];
      let rateLimited = 0;
      const ins = this.db.query(
        `INSERT INTO activity (agent_id, kind, lineage_id, gen_id, commit_sha, path, start_line, end_line, query, target, content_sha256, path_checked, at, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      events.forEach((raw, index) => {
        const err = (e: string) => refused.push({ index, error: e });
        if (!isObj(raw)) return err("not an object");
        for (const k of Object.keys(raw)) if (!ACTIVITY_KEYS.has(k)) return err(`unknown field ${k}`);
        const e = raw;
        if (typeof e.kind !== "string" || !ACTIVITY_KINDS.has(e.kind)) return err("kind must be read, search, edit, evaluate, propose, submit or give_up");
        if (typeof e.lineage_id !== "string" || !HEX64.test(e.lineage_id)) return err("lineage_id must be 64 hex");
        if (typeof e.gen_id !== "string" || !HEX64.test(e.gen_id)) return err("gen_id must be 64 hex");
        if (typeof e.commit !== "string" || !/^[0-9a-f]{40,64}$/.test(e.commit)) return err("commit must be a hex sha");
        const l = this.lineage(e.lineage_id);
        if (!l) return err("unknown lineage");
        if (!this.genInLineage(e.gen_id, e.lineage_id)) return err("unknown generation for this lineage");
        if (e.commit !== l.commit) return err("commit is not this lineage's snapshot commit");
        const needsPath = e.kind === "read" || e.kind === "edit";
        if (needsPath && e.path === undefined) return err(`${e.kind} needs a path`);
        if (e.path !== undefined && !validPath(e.path)) return err("path must be a relative path inside the tree");
        if (e.start_line !== undefined || e.end_line !== undefined) {
          if (e.path === undefined) return err("a line range needs a path");
          if (!isInt(e.start_line, 1, 10_000_000) || !isInt(e.end_line, 1, 10_000_000) || (e.end_line as number) < (e.start_line as number)) return err("start_line and end_line must be integers with 1 <= start <= end");
        }
        if (e.kind === "search") {
          if (typeof e.query !== "string" || e.query.length === 0 || e.query.length > 500) return err("search needs a query of 1 to 500 characters");
        } else if (e.query !== undefined) return err("query is only for search");
        if (e.content_sha256 !== undefined) {
          if (e.kind !== "read") return err("content_sha256 is only for read");
          if (typeof e.content_sha256 !== "string" || !HEX64.test(e.content_sha256)) return err("content_sha256 must be 64 hex");
        }
        if (e.target !== undefined) {
          if (!["evaluate", "propose", "submit"].includes(e.kind)) return err("target is only for evaluate, propose and submit");
          if (typeof e.target !== "string" || e.target.length === 0 || e.target.length > 200) return err("target must be a string of 1 to 200 characters");
        }
        let at = now;
        if (e.at !== undefined) {
          if (typeof e.at !== "number" || !Number.isFinite(e.at) || Math.abs(now - e.at) > this.core.nonceWindowMs) return err("at is outside the accepted window");
          at = Math.round(e.at);
        }
        let checked = 0;
        if (e.path !== undefined) {
          const files = this.filesAt(l, e.gen_id);
          if (files) {
            if (!files.has(e.path as string)) return err("path is not in this generation's tree");
            checked = 1;
          }
        }
        if (budget <= 0) {
          rateLimited++;
          return err("rate_limited");
        }
        budget--;
        const r = ins.run(
          agent,
          e.kind,
          e.lineage_id,
          e.gen_id,
          e.commit,
          (e.path as string | undefined) ?? null,
          (e.start_line as number | undefined) ?? null,
          (e.end_line as number | undefined) ?? null,
          (e.query as string | undefined) ?? null,
          (e.target as string | undefined) ?? null,
          (e.content_sha256 as string | undefined) ?? null,
          checked,
          at,
          now,
        );
        accepted.push(this.db.query<ActivityRow, [number]>("SELECT * FROM activity WHERE id = ?").get(Number(r.lastInsertRowid))!);
      });
      if (accepted.length === 0) {
        if (rateLimited > 0 && rateLimited === refused.length) throw new ApiError(429, "rate_limited", `at most ${this.core.cfg.activity_rate} activity events per agent per minute`);
        throw new ApiError(400, "bad_activity", refused.map((r) => `#${r.index}: ${r.error}`).join("; ").slice(0, 1000));
      }
      // SSE is throttled to one activity event per agent per second; /v1/live always has the rest
      const last = this.lastActivityEmit.get(agent) ?? 0;
      if (now - last >= 1000) {
        this.lastActivityEmit.set(agent, now);
        const tail = accepted[accepted.length - 1]!;
        this.core.emitEvent("activity", { agent, lineage_id: tail.lineage_id, count: accepted.length, last: this.activityPublic(tail) });
      }
      return { accepted: accepted.length, refused, ids: accepted.map((r) => r.id) };
    });
  }

  activityPublic(r: ActivityRow) {
    return {
      id: r.id,
      agent: r.agent_id,
      kind: r.kind,
      lineage_id: r.lineage_id,
      gen_id: r.gen_id,
      commit: r.commit_sha,
      path: r.path,
      start_line: r.start_line,
      end_line: r.end_line,
      query: r.query,
      target: r.target,
      content_sha256: r.content_sha256,
      path_checked: !!r.path_checked,
      at: r.at,
      received_at: r.received_at,
    };
  }

  listActivity(q: { lineage?: string; agent?: string; since?: number; limit?: number }) {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.lineage) (where.push("lineage_id = ?"), args.push(q.lineage));
    if (q.agent) (where.push("agent_id = ?"), args.push(q.agent));
    if (q.since) (where.push("id > ?"), args.push(q.since));
    args.push(Math.max(1, Math.min(q.limit ?? 100, 1000)));
    return this.db
      .query<ActivityRow, (string | number)[]>(`SELECT * FROM activity ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`)
      .all(...args)
      .map((r) => this.activityPublic(r));
  }

  // ---------------------------------------------------------------------------------------------
  // POST /v1/heartbeat

  postHeartbeat(agent: string, body: unknown) {
    return this.core.tx(() => {
      const a = this.db.query<{ kind: string }, [string]>("SELECT kind FROM agents WHERE agent_id = ?").get(agent);
      if (!a) throw forbidden("not_registered", "only registered agents may post heartbeats");
      if (!isObj(body)) throw bad("bad_heartbeat", "body must be an object");
      for (const k of Object.keys(body)) if (!HEARTBEAT_KEYS.has(k)) throw bad("bad_heartbeat", `unknown field ${k}`);
      const b = body;
      if (typeof b.job !== "string" || !JOBS.has(b.job)) throw bad("bad_heartbeat", "job must be replay, qualify, author or idle");
      if (b.phase !== undefined && b.phase !== null && (typeof b.phase !== "string" || !PHASES.has(b.phase))) throw bad("bad_heartbeat", `phase must be one of ${[...PHASES].join(", ")}`);
      if (b.caps_digest !== undefined && (typeof b.caps_digest !== "string" || !HEX64.test(b.caps_digest))) throw bad("bad_heartbeat", "caps_digest must be 64 hex");
      const now = this.core.now();
      const ms = (k: string) => {
        const v = b[k];
        if (v === undefined || v === null) return null;
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > now + 60_000) throw bad("bad_heartbeat", `${k} must be a unix ms timestamp, not in the future`);
        return Math.round(v);
      };
      const sentAt = ms("at") ?? now;
      if (Math.abs(now - sentAt) > this.core.nonceWindowMs) throw bad("bad_heartbeat", "at is outside the accepted window");
      let load: Record<string, number> | null = null;
      if (b.load !== undefined && b.load !== null) {
        if (!isObj(b.load)) throw bad("bad_heartbeat", "load must be an object");
        load = {};
        for (const [k, v] of Object.entries(b.load)) {
          if (!LOAD_KEYS.has(k)) throw bad("bad_heartbeat", `unknown load field ${k}`);
          if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw bad("bad_heartbeat", `load.${k} must be a non-negative number`);
          load[k] = Math.round(v * 100) / 100;
        }
      }
      let replayId: string | null = null;
      let lineageId: string | null = null;
      let genId: string | null = null;
      if (b.job === "replay" || b.job === "qualify") {
        if (typeof b.replay_id !== "string" || !HEX64.test(b.replay_id)) throw bad("bad_heartbeat", `${b.job} needs replay_id`);
        replayId = b.replay_id;
        if (b.job === "replay") {
          const r = this.db
            .query<{ eval_parent_gen_id: string; lineage_id: string }, [string, string]>(
              "SELECT r.eval_parent_gen_id, c.lineage_id FROM replays r JOIN candidates c ON c.candidate_id = r.candidate_id WHERE r.replay_id = ? AND r.replayer = ?",
            )
            .get(replayId, agent);
          if (!r) throw notFound("replay assigned to this agent");
          lineageId = r.lineage_id;
          genId = r.eval_parent_gen_id;
        } else {
          const q = this.db.query<{ lineage_id: string }, [string, string]>("SELECT lineage_id FROM qualifications WHERE qual_id = ? AND agent_id = ?").get(replayId, agent);
          if (!q) throw notFound("qualification assigned to this agent");
          lineageId = q.lineage_id;
          genId = this.db.query<{ gen0: string }, [string]>("SELECT gen0 FROM lineages WHERE lineage_id = ?").get(q.lineage_id)!.gen0;
        }
        if (b.lineage_id !== undefined || b.gen_id !== undefined) throw bad("bad_heartbeat", "lineage_id and gen_id are derived from the replay; do not send them");
      } else if (b.job === "author") {
        if (a.kind !== "launched") throw forbidden("not_an_author", "only launched agents author");
        if (typeof b.lineage_id !== "string" || !this.lineage(b.lineage_id)) throw bad("bad_heartbeat", "author needs a known lineage_id");
        if (typeof b.gen_id !== "string" || !this.genInLineage(b.gen_id, b.lineage_id)) throw bad("bad_heartbeat", "author needs a gen_id of that lineage");
        if (b.replay_id !== undefined) throw bad("bad_heartbeat", "replay_id is only for replay and qualify");
        lineageId = b.lineage_id;
        genId = b.gen_id;
      } else if (b.replay_id !== undefined || b.lineage_id !== undefined || b.gen_id !== undefined) {
        throw bad("bad_heartbeat", "an idle heartbeat names no work");
      }
      const prev = this.db.query<HeartbeatRow, [string]>("SELECT * FROM heartbeats WHERE agent_id = ?").get(agent);
      if (prev && now - prev.at < 1000) throw new ApiError(429, "too_frequent", "at most one heartbeat per second");
      const phase = b.job === "idle" ? null : ((b.phase as string | undefined) ?? null);
      const containerAt = ms("container_started_at");
      const jobAt = ms("job_started_at");
      this.db
        .query(
          `INSERT INTO heartbeats (agent_id, at, sent_at, caps_digest, job, phase, replay_id, lineage_id, gen_id, container_started_at, job_started_at, load, beats, first_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
           ON CONFLICT(agent_id) DO UPDATE SET at = excluded.at, sent_at = excluded.sent_at, caps_digest = excluded.caps_digest, job = excluded.job,
             phase = excluded.phase, replay_id = excluded.replay_id, lineage_id = excluded.lineage_id, gen_id = excluded.gen_id,
             container_started_at = excluded.container_started_at, job_started_at = excluded.job_started_at, load = excluded.load, beats = heartbeats.beats + 1`,
        )
        .run(agent, now, sentAt, (b.caps_digest as string | undefined) ?? null, b.job, phase, replayId, lineageId, genId, containerAt, jobAt, load ? JSON.stringify(load) : null, now);
      const changed = !prev || prev.job !== b.job || prev.phase !== phase || prev.replay_id !== replayId || prev.lineage_id !== lineageId || now - prev.at > this.awakeMs();
      const view = this.machineView(agent)!;
      if (changed) this.core.emitEvent("machine.heartbeat", view);
      return view;
    });
  }

  // ---------------------------------------------------------------------------------------------
  // machine views

  private candidateOfReplay(replayId: string) {
    return this.db
      .query<{ candidate_id: string; status: string; gen_id: string | null; is_canary: number; kind: string }, [string]>(
        "SELECT c.candidate_id, c.status, c.gen_id, c.is_canary, r.kind FROM replays r JOIN candidates c ON c.candidate_id = r.candidate_id WHERE r.replay_id = ?",
      )
      .get(replayId);
  }

  machineView(agent: string) {
    const h = this.db.query<HeartbeatRow, [string]>("SELECT * FROM heartbeats WHERE agent_id = ?").get(agent);
    if (!h) return null;
    const a = this.db
      .query<{ kind: string; reference: number; capabilities: string | null; shadow: number }, [string]>("SELECT kind, reference, capabilities, shadow FROM agents WHERE agent_id = ?")
      .get(agent)!;
    const now = this.core.now();
    const caps = a.capabilities ? JSON.parse(a.capabilities) : null;
    let sealed = false;
    let candidateId: string | null = null;
    let outcome: string | null = null;
    let gain: unknown = null;
    let lineageId = h.lineage_id;
    let genId = h.gen_id;
    if (h.job === "replay" && h.replay_id) {
      const c = this.candidateOfReplay(h.replay_id);
      // audits run after acceptance; their subject is final, but the audit itself is open
      const auditOpen =
        c?.kind?.startsWith("audit") &&
        !!this.db.query<{ s: string }, [string]>("SELECT a.status AS s FROM replays r JOIN audits a ON a.audit_id = r.audit_id WHERE r.replay_id = ?").get(h.replay_id)?.s?.match(/^pending$/);
      if (!c || !FINAL.has(c.status) || auditOpen || c.is_canary) {
        sealed = true;
        lineageId = null;
        genId = null;
      } else {
        candidateId = c.candidate_id;
        outcome = c.status;
        if (c.gen_id) {
          const g = this.db.query<{ effect: string | null }, [string]>("SELECT effect FROM generations WHERE gen_id = ?").get(c.gen_id);
          gain = g?.effect ? JSON.parse(g.effect) : null;
        }
      }
    }
    let cls: string | null = null;
    let lineage: LineageInfo | null = null;
    if (h.lineage_id) {
      lineage = this.lineage(h.lineage_id);
      if (lineage) cls = this.recipe(lineage.recipe_id).class;
    }
    const height = !sealed && genId ? (this.db.query<{ height: number }, [string]>("SELECT height FROM generations WHERE gen_id = ?").get(genId)?.height ?? null) : null;
    const recipeName = !sealed && lineage ? this.recipe(lineage.recipe_id).name : null;
    return {
      agent_id: agent,
      kind: a.shadow ? "launched" : a.kind,
      reference: !!a.reference,
      awake: now - h.at < this.awakeMs(),
      last_seen: h.at,
      first_seen: h.first_at,
      beats: h.beats,
      job: h.job,
      phase: h.phase,
      sealed,
      candidate_id: candidateId,
      outcome,
      gain,
      lineage_id: lineageId,
      gen_id: genId,
      height,
      recipe_name: recipeName,
      repo: !sealed && lineage ? lineage.repo : null,
      commit: !sealed && lineage ? lineage.commit : null,
      class: cls,
      container_started_at: h.container_started_at,
      job_started_at: h.job_started_at,
      load: h.load ? JSON.parse(h.load) : null,
      capabilities: caps,
      caps_digest: h.caps_digest,
      caps_match: h.caps_digest && caps ? h.caps_digest === this.core.capsDigest(caps) : null,
    };
  }

  listMachines() {
    return this.db
      .query<{ agent_id: string }, []>("SELECT agent_id FROM heartbeats ORDER BY at DESC")
      .all()
      .map((r) => this.machineView(r.agent_id)!);
  }

  // ---------------------------------------------------------------------------------------------
  // GET /v1/live: channels (active lineages) and machines in one read

  live() {
    const now = this.core.now();
    const machines = this.listMachines();
    const awake = machines.filter((m) => m.awake);
    const lineages = this.db.query<{ lineage_id: string }, []>("SELECT lineage_id FROM lineages WHERE status = 'active' ORDER BY created_at, lineage_id").all();
    const channels = lineages.map(({ lineage_id }) => {
      const l = this.lineage(lineage_id)!;
      const recipe = this.recipe(l.recipe_id);
      const recent = this.listActivity({ lineage: lineage_id, limit: 12 });
      const last = recent[0] ?? null;
      // the last activity that names a file (read or edit), for the code view
      const lastFile =
        recent.find((e) => e.path && (e.kind === "read" || e.kind === "edit")) ??
        (() => {
          const r = this.db
            .query<ActivityRow, [string]>("SELECT * FROM activity WHERE lineage_id = ? AND path IS NOT NULL AND kind IN ('read','edit') ORDER BY id DESC LIMIT 1")
            .get(lineage_id);
          return r ? this.activityPublic(r) : null;
        })();
      const authors = awake.filter((m) => m.job === "author" && m.lineage_id === lineage_id);
      const recentlyActive = !!last && now - last.received_at < this.awakeMs();
      return {
        lineage_id,
        recipe_name: recipe.name,
        class: recipe.class,
        repo: l.repo,
        commit: l.commit,
        tip: l.tip,
        height: l.height,
        status: authors.length || recentlyActive ? "active" : "idle",
        idle_since: authors.length || recentlyActive ? null : (last?.received_at ?? null),
        authors_awake: authors.map((m) => ({ agent_id: m.agent_id, phase: m.phase, job_started_at: m.job_started_at })),
        last,
        last_file: lastFile,
        recent,
        activity_total: this.db.query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM activity WHERE lineage_id = ?").get(lineage_id)!.c,
      };
    });
    const byJob: Record<string, number> = { replay: 0, qualify: 0, author: 0, idle: 0 };
    for (const m of awake) byJob[m.job] = (byJob[m.job] ?? 0) + 1;
    const sum = (f: (c: any) => number) => awake.reduce((s, m) => s + (m.capabilities ? f(m.capabilities) : 0), 0);
    return {
      now,
      heartbeat_s: this.core.cfg.heartbeat_s,
      awake_window_s: 3 * this.core.cfg.heartbeat_s,
      channels,
      machines,
      totals: {
        machines: machines.length,
        awake: awake.length,
        by_job: byJob,
        cpus_awake: sum((c) => c.cpus ?? 0),
        memory_mb_awake: sum((c) => c.memory_mb ?? 0),
        gpus_awake: sum((c) => (Array.isArray(c.gpus) ? c.gpus.length : 0)),
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // GET /v1/lineages/:id/file?gen=&path=

  file(lineageId: string, gen: string | undefined, path: string | undefined) {
    const l = this.lineage(lineageId);
    if (!l) throw notFound("lineage");
    const g = gen ?? l.tip;
    const gh = this.genInLineage(g, lineageId);
    if (!gh) throw notFound("generation");
    if (!validPath(path)) throw bad("bad_path", "path must be a relative path inside the tree");
    if (!this.trees) throw new ApiError(503, "tree_unavailable", "this Core has no tree source");
    const f = this.trees.file(this.recipe(l.recipe_id), l.commit, this.core.patchSeries(g).map((p) => p.patch), path);
    if (!f) throw new ApiError(503, "tree_unavailable", "the snapshot mirror for this repository is not present on the Core host");
    if (!f.exists) throw notFound("file at this generation");
    const MAX = 512 * 1024;
    const truncated = f.text !== null && f.text.length > MAX;
    return {
      lineage_id: lineageId,
      gen_id: g,
      height: gh.height,
      repo: l.repo,
      commit: l.commit,
      path,
      source: f.source,
      sha256: f.sha256,
      lines: f.lines,
      truncated,
      text: truncated ? f.text!.slice(0, MAX) : f.text,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // runway and stats

  /** SPEC 17.1: compute vault / mean debit per hour over the last epoch length. Null unless both exist. */
  runway(agent: string) {
    const balance = this.core.ledger.balance(`agent:${agent}:compute`);
    const windowS = this.core.cfg.epoch_length_s;
    const since = this.core.now() - windowS * 1000;
    const debited = this.db
      .query<{ amount: string }, [string, number]>("SELECT amount FROM usage WHERE agent_id = ? AND at > ?")
      .all(agent, since)
      .reduce((s, r) => s + BigInt(r.amount), 0n);
    if (debited <= 0n) return null;
    const perHour = (Number(debited) * 3600) / windowS;
    return { compute: balance.toString(), debited: debited.toString(), window_s: windowS, per_hour: Math.round(perHour).toString(), hours: Number(balance) / perHour };
  }

  stats() {
    const one = (sql: string) => this.db.query<{ c: number }, []>(sql).get()!.c;
    const machines = this.listMachines();
    const vaults = Object.entries(this.core.ledger.balances("agent:"))
      .filter(([k]) => k.endsWith(":compute"))
      .reduce((s, [, v]) => s + BigInt(v), 0n);
    const debited = this.db
      .query<{ amount: string }, []>("SELECT amount FROM usage")
      .all()
      .reduce((s, r) => s + BigInt(r.amount), 0n);
    return {
      machines: machines.length,
      machines_awake: machines.filter((m) => m.awake).length,
      verified_gains: one("SELECT COUNT(*) AS c FROM generations WHERE entry_type = 'patch' AND reverted_by IS NULL"),
      activity_events: one("SELECT COUNT(*) AS c FROM activity"),
      compute: { vaults: vaults.toString(), debited: debited.toString(), usage_records: one("SELECT COUNT(*) AS c FROM usage") },
    };
  }
}
