import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Core } from "./core.ts";
import { bad, conflict, forbidden, notFound } from "./errors.ts";
import { sessionsOf } from "./sessions.ts";
import { hiddenOf } from "./hidden.ts";
import { loadNetworkProfile } from "../../chain/src/profile-node.ts";

// Agent learnings (docs/plans/AGENT-LEARNINGS.md, SPEC 17.8). Every finished authoring attempt becomes
// one episode: the session's events (sealed contents included), the candidate with its replays and
// verdict, the journal entry, provenance and the worker's own report, plus a reward derived only from
// measured facts. Episodes are training data, so they follow the strictest sealing rule Core has:
//
// - an episode is published only when its session's gate is open for everyone (17.3: the candidate
//   is final, or the attempt ended without one, or it was abandoned), and
// - every candidate the agent had committed (as author or team member) by the time its session ended,
//   its journal entry was written or its worker report arrived is final (the journal rule, 17.6): the
//   notes, journal and report text could mention any open candidate of the agent (10.7).
//
// Until then nothing about it is public: no row, no count, no gap in the cursor, no event. `seq` is
// assigned at publication. Every aggregate (stats, lessons, the GitHub repositories) reads published
// episodes only. Episodes are built once and never changed.

export const LEARNINGS_SCHEMA_ID = "lineage-episode/1";

export const LEARNINGS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS learnings_reports (
    session_id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    report TEXT NOT NULL,                -- canonical JSON of the worker report (claimed)
    stored_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS learnings_episodes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL UNIQUE,
    agent TEXT NOT NULL,
    lineage_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    provider TEXT,
    published_at INTEGER NOT NULL,
    json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS learnings_episodes_agent ON learnings_episodes(agent, seq);
  CREATE INDEX IF NOT EXISTS learnings_episodes_lineage ON learnings_episodes(lineage_id, seq);
  CREATE TABLE IF NOT EXISTS learnings_repos (
    agent TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    reported_at INTEGER NOT NULL,
    reported_by TEXT NOT NULL
  );
`;

export const LEARNINGS_LIMITS = {
  report_bytes: 8192,
  /** a worker report is accepted this long after its session ended (the journal write window) */
  report_window_ms: 2 * 3600 * 1000,
  /** with a report but no journal entry, wait this long after the end before publishing */
  report_grace_ms: 15 * 60 * 1000,
  /** with neither, wait the whole write window */
  bare_grace_ms: 2 * 3600 * 1000,
  sweep_every_ms: 30_000,
  sweep_max: 300,
  edit_chars: 20_000,
  output_chars: 8_000,
  note_chars: 4_000,
  patch_chars: 200_000,
  page_json: 200,
  page_jsonl: 1000,
};

const HEX64 = /^[0-9a-f]{64}$/;
const AGENT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const FINAL = ["accepted", "rejected", "expired"];
const DEFAULT_LICENSES = join(import.meta.dir, "../../../config/learnings-licenses.json");

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nat = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const shortStr = (v: unknown, n: number) => typeof v === "string" && v.length > 0 && v.length <= n && !v.includes("\u2014");
const parse = <T = any>(s: string | null | undefined): T | null => {
  if (s === null || s === undefined) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};

export function episodeId(sessionId: string): string {
  return createHash("sha256").update(`lineage-episode-v1|${sessionId}`).digest("hex");
}

function clip(s: string, n: number): { text: string; cut: boolean } {
  return s.length <= n ? { text: s, cut: false } : { text: s.slice(0, n), cut: true };
}

/** A unified hunk from an edit's sealed before and after text and its public line range. */
export function hunk(path: string, start: number | undefined, before: string, after: string): string {
  const b = before === "" ? [] : before.split("\n");
  const a = after === "" ? [] : after.split("\n");
  const s = start ?? 1;
  return [`--- a/${path}`, `+++ b/${path}`, `@@ -${b.length ? s : 0},${b.length} +${a.length ? s : 0},${a.length} @@`, ...b.map((l) => `-${l}`), ...a.map((l) => `+${l}`)].join("\n");
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

// ------------------------------------------------------------------------------------------------
// the worker report (claimed)

export interface WorkerReport {
  v: 1;
  planned: { kind: string; target: string | string[]; note: string | null } | null;
  outcome: string | null;
  usage: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; usd: number } | null;
  sandbox_s: number | null;
  models: string[];
  harness: { name: string; version: string; digest: string; provider: string } | null;
  route: { via: string; model: { provider: string; id: string }; upstream: string[] } | null;
}

/** Checks a worker report's shape; returns the normalised report or throws 400. */
export function checkReport(body: unknown): WorkerReport {
  const err = (m: string) => {
    throw bad("bad_report", m);
  };
  if (!isObj(body)) return err("body must be an object");
  if (JSON.stringify(body).length > LEARNINGS_LIMITS.report_bytes) err(`report exceeds ${LEARNINGS_LIMITS.report_bytes} bytes`);
  const keys = ["v", "planned", "outcome", "usage", "sandbox_s", "models", "harness", "route"];
  for (const k of Object.keys(body)) if (!keys.includes(k)) err(`unknown field ${k}`);
  if (body.v !== 1) err("v must be 1");
  let planned: WorkerReport["planned"] = null;
  if (body.planned !== undefined && body.planned !== null) {
    const p = body.planned;
    if (!isObj(p) || !["perf", "fix", "slim"].includes(p.kind as string)) return err("planned: { kind: perf|fix|slim, target, note }");
    const t = p.target;
    const okT = shortStr(t, 200) || (Array.isArray(t) && t.length > 0 && t.length <= 16 && t.every((x) => shortStr(x, 200)));
    if (!okT) err("planned.target must be a name or a list of names");
    if (p.note !== undefined && p.note !== null && !shortStr(p.note, 500)) err("planned.note must be at most 500 characters");
    planned = { kind: p.kind as string, target: t as string | string[], note: (p.note as string | undefined) ?? null };
  }
  const outcome = body.outcome === undefined || body.outcome === null ? null : shortStr(body.outcome, 400) ? (body.outcome as string) : err("outcome must be at most 400 characters, no em dash");
  let usage: WorkerReport["usage"] = null;
  if (body.usage !== undefined && body.usage !== null) {
    const u = body.usage;
    if (!isObj(u) || !["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"].every((k) => nat(u[k])) || !(typeof u.usd === "number" && Number.isFinite(u.usd) && u.usd >= 0 && u.usd < 10_000)) return err("usage needs four token counts and usd");
    for (const k of Object.keys(u)) if (!["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "usd"].includes(k)) err(`unknown usage field ${k}`);
    usage = { input_tokens: u.input_tokens as number, output_tokens: u.output_tokens as number, cache_read_tokens: u.cache_read_tokens as number, cache_write_tokens: u.cache_write_tokens as number, usd: u.usd as number };
  }
  const sandbox_s = body.sandbox_s === undefined || body.sandbox_s === null ? null : typeof body.sandbox_s === "number" && Number.isFinite(body.sandbox_s) && body.sandbox_s >= 0 && body.sandbox_s < 1e7 ? body.sandbox_s : err("sandbox_s must be a non-negative number");
  const models = body.models === undefined ? [] : Array.isArray(body.models) && body.models.length <= 8 && body.models.every((m) => shortStr(m, 100)) ? (body.models as string[]) : err("models must list at most 8 ids");
  let harness: WorkerReport["harness"] = null;
  if (body.harness !== undefined && body.harness !== null) {
    const h = body.harness;
    if (!isObj(h) || !shortStr(h.name, 64) || !shortStr(h.version, 64) || !(typeof h.digest === "string" && HEX64.test(h.digest)) || !shortStr(h.provider, 40)) return err("harness: { name, version, digest (64 hex), provider }");
    harness = { name: h.name as string, version: h.version as string, digest: h.digest as string, provider: h.provider as string };
  }
  let route: WorkerReport["route"] = null;
  if (body.route !== undefined && body.route !== null) {
    const r = body.route;
    if (!isObj(r) || !shortStr(r.via, 20) || !isObj(r.model) || !shortStr(r.model.provider, 40) || !shortStr(r.model.id, 100)) return err("route: { via, model: { provider, id }, upstream }");
    const up = r.upstream === undefined ? [] : Array.isArray(r.upstream) && r.upstream.length <= 8 && r.upstream.every((x) => shortStr(x, 60)) ? (r.upstream as string[]) : err("route.upstream must list at most 8 names");
    route = { via: r.via as string, model: { provider: r.model.provider as string, id: r.model.id as string }, upstream: up };
  }
  return { v: 1, planned, outcome, usage, sandbox_s, models, harness, route };
}

// ------------------------------------------------------------------------------------------------
// licences (scripts/learnings/licenses.ts reads them from GitHub into config/learnings-licenses.json)

export interface RepoLicense {
  repo: string;
  spdx: string | null;
  name: string | null;
  url: string | null;
  source: string;
  read_on: string;
}

const normRepo = (u: string) => u.trim().replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();

export function loadLicenses(path = process.env.LINEAGE_LEARNINGS_LICENSES ?? DEFAULT_LICENSES): Map<string, RepoLicense> {
  const out = new Map<string, RepoLicense>();
  if (!existsSync(path)) return out;
  const raw = parse<{ repos?: RepoLicense[] }>(readFileSync(path, "utf8"));
  for (const r of raw?.repos ?? []) if (r && typeof r.repo === "string") out.set(normRepo(r.repo), r);
  return out;
}

export function attribution(repo: string, commit: string, lic: RepoLicense | null): string {
  if (lic?.spdx && lic.spdx !== "NOASSERTION") return `Code excerpts from ${repo} at ${commit}, licensed ${lic.spdx}, copyright its authors; see ${lic.url ?? repo}.`;
  return `Code excerpts from ${repo} at ${commit}, copyright its authors; the licence was not determined (see the repository).`;
}

// ------------------------------------------------------------------------------------------------
// reward (docs/plans/AGENT-LEARNINGS.md 3)

export type Outcome = "accepted" | "rejected" | "expired" | "no_candidate" | "abandoned";

export interface Cost {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  usd: number | null;
  sandbox_s: number | null;
  source: "provenance:hosted" | "provenance:self" | "worker_report";
}

export type Effect = { metric: string; ratio: number; ci_low: number | null; ci_high: number | null; gain_pct: number } | { fixed: string[] } | null;

export interface Reward {
  v: 1;
  accepted: 0 | 1;
  effect: number | null;
  fixed_tests: number;
  effect_per_usd: number | null;
  effect_per_sandbox_hour: number | null;
  reverted: boolean;
  inputs: string[];
}

/** The reward of an episode, from its outcome, verdict effect and cost only. */
export function computeReward(outcome: Outcome, effect: Effect, cost: Cost | null, reverted = false): Reward {
  const inputs = ["outcome"];
  let eff: number | null = 0;
  let fixed = 0;
  if (outcome === "accepted") {
    if (effect && "ratio" in effect) {
      eff = 1 - effect.ratio;
      inputs.push("verdict.effect.ratio");
    } else if (effect && "fixed" in effect) {
      eff = null;
      fixed = effect.fixed.length;
      inputs.push("verdict.effect.fixed");
    } else eff = null;
  }
  const perUsd = eff !== null && cost?.usd !== null && cost?.usd !== undefined && cost.usd > 0 ? eff / cost.usd : null;
  if (perUsd !== null) inputs.push(`cost.usd (${cost!.source})`);
  const perHour = eff !== null && cost?.sandbox_s !== null && cost?.sandbox_s !== undefined && cost.sandbox_s > 0 ? eff / (cost.sandbox_s / 3600) : null;
  if (perHour !== null) inputs.push(`cost.sandbox_s (${cost!.source})`);
  if (reverted) inputs.push("generation.reverted_by");
  return { v: 1, accepted: outcome === "accepted" ? 1 : 0, effect: eff, fixed_tests: fixed, effect_per_usd: perUsd, effect_per_sandbox_hour: perHour, reverted, inputs };
}

// ------------------------------------------------------------------------------------------------
// the module

interface Internals {
  db: Core["db"];
  adminId: string;
  runtimeId?: string;
  now(): number;
  tx<T>(fn: () => T): T;
}

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
  desktop: number;
}

const instances = new WeakMap<Core, Learnings>();
export function learningsOf(core: Core): Learnings {
  let l = instances.get(core);
  if (!l) instances.set(core, (l = new Learnings(core)));
  return l;
}

export class Learnings {
  private readonly c: Internals;
  private lastSweep = 0;
  private licenses: Map<string, RepoLicense> | null = null;
  private network: string | null = null;
  constructor(private readonly core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(LEARNINGS_SCHEMA);
  }

  private get db() {
    return this.c.db;
  }

  // ---------------------------------------------------------------------------------------------
  // write: the worker report

  /** POST /v1/sessions/:id/episode (agent-signed): the worker's claimed facts of the attempt. */
  report(agent: string, sessionId: string, body: unknown) {
    return this.c.tx(() => {
      if (!HEX64.test(sessionId)) throw bad("bad_session", "session id must be 64 hex");
      const s = this.db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE session_id = ?").get(sessionId);
      if (!s) throw notFound("session");
      if (s.agent_id !== agent) throw forbidden("not_owner", "only the session's agent reports its episode");
      if (s.ended_at === null) throw conflict("session_open", "end the session before reporting its episode");
      if (this.c.now() - s.ended_at > LEARNINGS_LIMITS.report_window_ms) throw conflict("too_late", "episode reports are sent within 2 hours of the session's end");
      const r = checkReport(body);
      const text = JSON.stringify(r);
      const prev = this.db.query<{ report: string }, [string]>("SELECT report FROM learnings_reports WHERE session_id = ?").get(sessionId);
      if (prev) {
        if (prev.report === text) return { stored: false };
        throw conflict("report_exists", "this session already has an episode report");
      }
      this.db.query("INSERT INTO learnings_reports (session_id, agent, report, stored_at) VALUES (?, ?, ?, ?)").run(sessionId, agent, text, this.c.now());
      // no event: a report must not time anything to an agent (10.7); it shows inside its episode
      return { stored: true };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // the gate

  /** Some candidate of the agent (as author or team member) committed at or before `at` is not final. */
  private hadOpenCandidate(agent: string, at: number): boolean {
    const team = this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'team_members'").get();
    const who = team ? "(author = ?1 OR commit_id IN (SELECT commit_id FROM team_members WHERE agent = ?1))" : "author = ?1";
    return !!this.db.query(`SELECT 1 FROM candidates WHERE ${who} AND committed_at <= ?2 AND is_canary = 0 AND status NOT IN ('accepted', 'rejected', 'expired') LIMIT 1`).get(agent, at);
  }

  /** Whether the session's episode may be published now (and the reference time of the rule). */
  publishable(s: SessionRow): boolean {
    const g = sessionsOf(this.core).gate(s as never);
    if (!g.open) return false;
    const j = this.db.query<{ created_at: number }, [string]>("SELECT created_at FROM journal WHERE session_id = ?").get(s.session_id);
    const r = this.db.query<{ stored_at: number }, [string]>("SELECT stored_at FROM learnings_reports WHERE session_id = ?").get(s.session_id);
    const now = this.c.now();
    if (g.state !== "abandoned") {
      const end = s.ended_at ?? s.last_at;
      // wait for the journal entry and the worker report, which come after the end
      const wait = r && j ? 0 : r ? LEARNINGS_LIMITS.report_grace_ms : LEARNINGS_LIMITS.bare_grace_ms;
      if (now - end < wait) return false;
    }
    const at = Math.max(s.ended_at ?? s.last_at, j?.created_at ?? 0, r?.stored_at ?? 0);
    return !this.hadOpenCandidate(s.agent_id, at);
  }

  /**
   * Publishes every episode that became publishable (at most LEARNINGS_LIMITS.sweep_max per call).
   * Called on reads, at most every sweep_every_ms unless forced. Returns how many were published.
   */
  sweep(o: { force?: boolean; max?: number } = {}): number {
    const now = this.c.now();
    if (!o.force && now - this.lastSweep < LEARNINGS_LIMITS.sweep_every_ms) return 0;
    this.lastSweep = now;
    return this.c.tx(() => {
      const rows = this.db
        .query<SessionRow, []>("SELECT * FROM sessions WHERE session_id NOT IN (SELECT session_id FROM learnings_episodes) ORDER BY started_at, session_id")
        .all();
      let n = 0;
      const ins = this.db.query("INSERT INTO learnings_episodes (episode_id, session_id, agent, lineage_id, outcome, provider, published_at, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      for (const s of rows) {
        if (n >= (o.max ?? LEARNINGS_LIMITS.sweep_max)) break;
        if (!this.publishable(s)) continue;
        const ep = this.build(s, now);
        if (!ep) continue;
        ins.run(ep.episode_id, s.session_id, s.agent_id, s.lineage_id, ep.outcome, ep.model.provider, now, JSON.stringify(ep));
        n++;
      }
      return n;
    });
  }

  // ---------------------------------------------------------------------------------------------
  // building one episode (only ever called for a publishable session)

  private lic(repo: string): RepoLicense | null {
    this.licenses ??= loadLicenses();
    return this.licenses.get(normRepo(repo)) ?? null;
  }

  /** Test hook: licences from a given file. */
  setLicenses(m: Map<string, RepoLicense>) {
    this.licenses = m;
  }

  private net(): string {
    if (this.network === null) {
      try {
        this.network = loadNetworkProfile().network;
      } catch {
        this.network = "unknown";
      }
    }
    return this.network;
  }

  build(s: SessionRow, publishedAt: number): any {
    const db = this.db;
    const g = sessionsOf(this.core).gate(s as never);
    const lin = db
      .query<{ recipe_id: string; json: string; repo: string; commit: string }, [string]>(
        `SELECT l.recipe_id AS recipe_id, r.json AS json, rp.url AS repo, sn.commit_sha AS "commit"
         FROM lineages l JOIN recipes r ON r.recipe_id = l.recipe_id JOIN repos rp ON rp.repo_id = l.repo_id JOIN snapshots sn ON sn.snapshot_id = l.snapshot_id WHERE l.lineage_id = ?`,
      )
      .get(s.lineage_id);
    if (!lin) return null;
    const recipe = parse<any>(lin.json) ?? {};
    const parent = db.query<{ height: number }, [string]>("SELECT height FROM generations WHERE gen_id = ?").get(s.gen_id);
    const ag = db.query<{ kind: string; hosted: number; identity_mode: string | null }, [string]>("SELECT kind, hosted, identity_mode FROM agents WHERE agent_id = ?").get(s.agent_id);
    const soulRow = db
      .query<{ digest: string; seq: number; doc: string; stored_at: number }, [string, number]>("SELECT digest, seq, doc, stored_at FROM souls WHERE agent = ? AND stored_at <= ? ORDER BY seq DESC LIMIT 1")
      .get(s.agent_id, s.started_at);
    const soulDoc = parse<any>(soulRow?.doc);
    const newestSoul = soulRow ? null : parse<any>(db.query<{ doc: string }, [string]>("SELECT doc FROM souls WHERE agent = ? ORDER BY seq LIMIT 1").get(s.agent_id)?.doc);
    const hidden = hiddenOf(this.core).agents().has(s.agent_id);

    // the attempt's candidate (the gate found it) and what replays measured
    const c = g.candidate ? db.query<any, [string]>("SELECT * FROM candidates WHERE commit_id = ?").get(g.candidate.commit_id) : null;
    const verdict = c ? parse<any>(c.verdict) : null;
    const replays = c?.candidate_id
      ? db
          .query<any, [string]>("SELECT replay_id, kind, role, status, replayer, result, stage, round FROM replays WHERE candidate_id = ? AND kind IN ('replay', 'reference') ORDER BY stage, round, replay_id")
          .all(c.candidate_id)
      : [];
    const counted = new Set<string>(Array.isArray(verdict?.counted) ? verdict.counted : []);
    const replayOut = replays.map((r) => {
      const res = parse<any>(r.result);
      const metrics: Record<string, { base: number[]; cand: number[]; ratio: number | null }> = {};
      for (const [k, v] of Object.entries<any>(res?.metrics ?? {})) {
        const b = median(v?.base ?? []);
        const cm = median(v?.cand ?? []);
        metrics[k] = { base: v?.base ?? [], cand: v?.cand ?? [], ratio: b && cm !== null ? cm / b : null };
      }
      const t = res?.tests ?? null;
      return {
        replay_id: r.replay_id, kind: r.kind, role: r.role, status: r.status, replayer: r.replayer, counted: counted.has(r.replay_id),
        apply: res?.apply ?? null, build: res?.build ? { base: res.build.base ?? null, cand: res.build.cand ?? null } : null,
        tests: t ? { base_pass: (t.base_pass ?? []).length, cand_pass: (t.cand_pass ?? []).length, cand_fail: (t.cand_fail ?? []).length } : null,
        equivalence_same: res?.equivalence ? res.equivalence.base_digest === res.equivalence.cand_digest : null,
        metrics, env: res?.env ?? null,
      };
    });
    const baseline: Record<string, { median: number | null; samples: number[] }> = {};
    for (const r of replayOut) if (r.counted) for (const [k, m] of Object.entries(r.metrics)) (baseline[k] ??= { median: null, samples: [] }).samples.push(...m.base);
    for (const b of Object.values(baseline)) b.median = median(b.samples);

    // outcome and effect
    let outcome: Outcome;
    if (c && FINAL.includes(c.status)) outcome = c.status as Outcome;
    else if (g.state === "abandoned") outcome = "abandoned";
    else outcome = "no_candidate";
    let effect: Effect = null;
    const ve = verdict?.effect;
    if (ve && typeof ve.ratio === "number") effect = { metric: String(ve.metric), ratio: ve.ratio, ci_low: ve.ci_low ?? null, ci_high: ve.ci_high ?? null, gain_pct: (1 - ve.ratio) * 100 };
    else if (ve && Array.isArray(ve.fixed)) effect = { fixed: ve.fixed };
    const gen = c?.gen_id ? db.query<{ reverted_by: string | null }, [string]>("SELECT reverted_by FROM generations WHERE gen_id = ?").get(c.gen_id) : null;

    // provenance, worker report, journal
    const prov = c ? db.query<any, [string]>("SELECT runtime, record, digest, sig, signer FROM provenance WHERE commit_id = ?").get(c.commit_id) : null;
    const pr = parse<any>(prov?.record);
    const rep = parse<WorkerReport>(db.query<{ report: string }, [string]>("SELECT report FROM learnings_reports WHERE session_id = ?").get(s.session_id)?.report);
    const jr = db.query<any, [string]>("SELECT entry_id, text, created_at, sig, signer FROM journal WHERE session_id = ?").get(s.session_id);

    let cost: Cost | null = null;
    if (pr?.usage) {
      cost = {
        input_tokens: pr.usage.input_tokens ?? null, output_tokens: pr.usage.output_tokens ?? null, cache_read_tokens: pr.usage.cache_read_tokens ?? null, cache_write_tokens: pr.usage.cache_write_tokens ?? null,
        usd: pr.spend?.usd !== undefined ? Number(pr.spend.usd) : null, sandbox_s: typeof pr.sandbox_s === "number" ? pr.sandbox_s : null,
        source: prov.runtime === "hosted" ? "provenance:hosted" : "provenance:self",
      };
    } else if (rep && (rep.usage || rep.sandbox_s !== null)) {
      cost = {
        input_tokens: rep.usage?.input_tokens ?? null, output_tokens: rep.usage?.output_tokens ?? null, cache_read_tokens: rep.usage?.cache_read_tokens ?? null, cache_write_tokens: rep.usage?.cache_write_tokens ?? null,
        usd: rep.usage?.usd ?? null, sandbox_s: rep.sandbox_s, source: "worker_report",
      };
    }

    // model provenance: attested record first, then the worker's report, then what the harness implies
    let model: any;
    if (pr) {
      const provider = pr.provider ?? (pr.proposer?.name === "anthropic" ? "anthropic" : null);
      model = { provider, models: pr.models ?? [], route: pr.route ?? null, harness: pr.proposer ? { name: pr.proposer.name, version: pr.proposer.version, digest: pr.harness_digest ?? null } : null, source: prov.runtime === "hosted" ? "provenance:hosted" : "provenance:self" };
      if (!pr.provider && provider) model.provider_note = "older record without a provider field; the anthropic harness calls only Anthropic's API";
    } else if (rep && (rep.harness || rep.route || rep.models.length)) {
      model = { provider: rep.route?.model.provider ?? rep.harness?.provider ?? null, models: rep.models, route: rep.route, harness: rep.harness, source: "worker_report" };
    } else {
      model = { provider: s.proposer === "anthropic" ? "anthropic" : null, models: [], route: null, harness: { name: s.proposer, version: null, digest: null }, source: "session.proposer" };
      if (s.proposer === "scripted") model.note = "scripted author: a patch from the recipe's candidate set applied hunk by hunk, no model";
    }

    // actions, hypotheses, plan
    const evs = db.query<{ seq: number; kind: string; at: number; pub: string; sealed: string | null }, [string]>("SELECT seq, kind, at, pub, sealed FROM session_events WHERE session_id = ? ORDER BY seq").all(s.session_id);
    const actions: any[] = [];
    const hypotheses: string[] = [];
    let lastEval: any = null;
    for (const e of evs) {
      const pub = parse<Record<string, unknown>>(e.pub) ?? {};
      const sealed = parse<Record<string, unknown>>(e.sealed) ?? {};
      if (e.kind === "phase") {
        if (lastEval) (lastEval.phases ??= []).push({ phase: pub.phase, at: e.at });
        continue;
      }
      const a: any = { seq: e.seq, ...pub, at: e.at };
      let cut = sealed.truncated === true;
      if (e.kind === "edit" || e.kind === "write" || e.kind === "patch") {
        const b = clip(String(sealed.before ?? ""), LEARNINGS_LIMITS.edit_chars);
        const af = clip(String(sealed.after ?? ""), LEARNINGS_LIMITS.edit_chars);
        cut ||= b.cut || af.cut;
        if (sealed.before !== undefined || sealed.after !== undefined) a.diff = hunk(String(pub.path ?? ""), pub.start_line as number | undefined, b.text, af.text);
      } else if (e.kind === "result") {
        const o = clip(String(sealed.output ?? ""), LEARNINGS_LIMITS.output_chars);
        cut ||= o.cut;
        if (sealed.output !== undefined) a.output = o.text;
        if (sealed.outcome !== undefined) a.outcome = sealed.outcome;
        if (Array.isArray(sealed.steps)) a.steps = (sealed.steps as any[]).map((st) => ({ ...st, tail: typeof st.tail === "string" ? st.tail.slice(-2000) : st.tail }));
      } else if (e.kind === "note") {
        const t = clip(String(sealed.text ?? ""), LEARNINGS_LIMITS.note_chars);
        cut ||= t.cut;
        a.text = t.text;
        if (t.text) hypotheses.push(t.text);
      } else if (e.kind === "submit" || e.kind === "give_up") {
        if (sealed.reason !== undefined) a.reason = clip(String(sealed.reason), LEARNINGS_LIMITS.note_chars).text;
      }
      if (cut) a.truncated = true;
      if (e.kind === "evaluate") lastEval = a;
      else if (e.kind !== "result") lastEval = null;
      actions.push(a);
    }

    const patch = c?.patch ? clip(String(c.patch), LEARNINGS_LIMITS.patch_chars) : null;
    const candidate = c
      ? {
          commit_id: c.commit_id, candidate_id: c.candidate_id, kind: c.kind, target: parse(c.target), claimed_effect: c.claimed_effect, patch: patch?.text ?? null, patch_hash: c.patch_hash, semantic_hash: c.semantic_hash,
          status: c.status, reason: c.reason, committed_at: c.committed_at, revealed_at: c.revealed_at, finalized_at: c.finalized_at, gen_id: c.gen_id, ...(patch?.cut ? { truncated: true } : {}),
        }
      : null;
    const target = c ? { kind: c.kind, target: parse(c.target), source: "candidate" } : rep?.planned ? { kind: rep.planned.kind, target: rep.planned.target, source: "worker_report.planned" } : null;
    const lic = this.lic(lin.repo);
    const episode_id = episodeId(s.session_id);
    return {
      schema: LEARNINGS_SCHEMA_ID,
      episode_id,
      seq: null as number | null,
      network: this.net(),
      session_id: s.session_id,
      agent: {
        id: s.agent_id, name: soulDoc?.persona?.name ?? newestSoul?.persona?.name ?? null, hidden, hosted: !!ag?.hosted, identity_mode: ag?.identity_mode ?? null,
        soul: soulRow ? { digest: soulRow.digest, seq: soulRow.seq, stored_at: soulRow.stored_at, declared_model: soulDoc?.model ?? null } : null,
      },
      model,
      task: {
        recipe: { recipe_id: lin.recipe_id, name: recipe.name ?? null, class: recipe.class ?? null, repo: lin.repo, commit: lin.commit },
        lineage_id: s.lineage_id, parent_gen_id: s.gen_id, parent_height: parent?.height ?? null,
        metrics: (Array.isArray(recipe.metrics) ? recipe.metrics : []).map((m: any) => ({ name: m.name, kind: m.kind, direction: m.direction, deterministic: !!m.deterministic, min_effect: m.min_effect })),
        target,
        baseline: Object.keys(baseline).length ? baseline : null,
      },
      plan: { planned: rep?.planned ?? null, opening_note: hypotheses[0] ?? null, source: rep ? "worker_report + session notes" : "session notes" },
      hypotheses,
      actions,
      candidate,
      replays: replayOut,
      verdict: verdict ? { outcome: verdict.outcome ?? null, reason: verdict.reason ?? null, detail: verdict.detail ?? null, effect: verdict.effect ?? null, digest: verdict.digest ?? null } : null,
      outcome,
      effect,
      cost,
      reward: computeReward(outcome, effect, cost, !!gen?.reverted_by),
      worker_outcome: rep?.outcome ?? null,
      journal: jr ? { entry_id: jr.entry_id, text: jr.text, created_at: jr.created_at, sig: jr.sig, signer: jr.signer } : null,
      provenance: prov ? { runtime: prov.runtime, digest: prov.digest, sig: prov.sig, signer: prov.signer } : null,
      license: lic,
      attribution: attribution(lin.repo, lin.commit, lic),
      times: { started_at: s.started_at, ended_at: s.ended_at, finalized_at: c?.finalized_at ?? null, published_at: publishedAt },
      verify: {
        session: `/v1/sessions/${s.session_id}`,
        candidate: c ? `/v1/candidates/${c.commit_id}` : null,
        generation: c?.gen_id ? `/v1/generations/${c.gen_id}` : null,
        provenance: prov ? `/v1/candidates/${c.commit_id}/provenance` : null,
        journal: jr ? `/v1/agents/${s.agent_id}/journal?lineage=${s.lineage_id}` : null,
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // reads (published episodes only)

  private row(json: string, seq: number) {
    const e = JSON.parse(json);
    e.seq = seq;
    return e;
  }

  /** GET /v1/learnings/episodes */
  list(q: { since?: number; limit?: number; agent?: string; lineage?: string; outcome?: string; provider?: string; hidden?: boolean; jsonl?: boolean }) {
    this.sweep();
    const max = q.jsonl ? LEARNINGS_LIMITS.page_jsonl : LEARNINGS_LIMITS.page_json;
    const limit = Math.max(1, Math.min(q.limit ?? (q.jsonl ? 200 : 50), max));
    if (q.agent !== undefined && !AGENT.test(q.agent)) throw bad("bad_query", "agent must be an agent id");
    if (q.lineage !== undefined && !HEX64.test(q.lineage)) throw bad("bad_query", "lineage must be 64 hex");
    if (q.outcome !== undefined && !["accepted", "rejected", "expired", "no_candidate", "abandoned"].includes(q.outcome)) throw bad("bad_query", "outcome must be accepted, rejected, expired, no_candidate or abandoned");
    const off = q.hidden ? new Map() : hiddenOf(this.core).agents();
    const where = ["seq > ?"];
    const args: (string | number)[] = [q.since ?? 0];
    if (q.agent) (where.push("agent = ?"), args.push(q.agent));
    if (q.lineage) (where.push("lineage_id = ?"), args.push(q.lineage));
    if (q.outcome) (where.push("outcome = ?"), args.push(q.outcome));
    if (q.provider) (where.push(q.provider === "none" ? "provider IS NULL" : "provider = ?"), q.provider === "none" || args.push(q.provider));
    const out: any[] = [];
    let cursor = q.since ?? 0;
    let more = false;
    for (;;) {
      const rows = this.db.query<{ seq: number; agent: string; json: string }, (string | number)[]>(`SELECT seq, agent, json FROM learnings_episodes WHERE ${where.join(" AND ")} ORDER BY seq LIMIT 500`).all(...args.map((a, i) => (i === 0 ? cursor : a)));
      for (const r of rows) {
        if (out.length >= limit) {
          more = true;
          break;
        }
        cursor = r.seq;
        if (off.has(r.agent)) continue;
        out.push(this.row(r.json, r.seq));
      }
      if (more || rows.length < 500) break;
    }
    return { episodes: out, next_since: cursor, more };
  }

  /** GET /v1/learnings/episodes/:id */
  get(id: string) {
    this.sweep();
    if (!HEX64.test(id)) throw bad("bad_query", "episode id must be 64 hex");
    const r = this.db.query<{ seq: number; json: string }, [string, string]>("SELECT seq, json FROM learnings_episodes WHERE episode_id = ? OR session_id = ?").get(id, id);
    if (!r) throw notFound("episode");
    return this.row(r.json, r.seq);
  }

  /** GET /v1/learnings/stats: counts of published episodes (hidden test launches left out unless asked). */
  stats(hidden = false) {
    this.sweep();
    const off = hidden ? new Map() : hiddenOf(this.core).agents();
    const rows = this.db.query<{ agent: string; outcome: string; provider: string | null }, []>("SELECT agent, outcome, provider FROM learnings_episodes").all().filter((r) => !off.has(r.agent));
    const by = (k: "outcome" | "provider") => rows.reduce<Record<string, number>>((m, r) => ((m[r[k] ?? "none"] = (m[r[k] ?? "none"] ?? 0) + 1), m), {});
    const last = this.db.query<{ s: number | null }, []>("SELECT MAX(seq) AS s FROM learnings_episodes").get()?.s ?? 0;
    return { schema: LEARNINGS_SCHEMA_ID, episodes: rows.length, agents: new Set(rows.map((r) => r.agent)).size, by_outcome: by("outcome"), by_provider: by("provider"), last_seq: last };
  }

  /** GET /v1/learnings/agents: agents with published episodes (hidden test launches left out unless asked). */
  agents(hidden = false) {
    this.sweep();
    const off = hidden ? new Map() : hiddenOf(this.core).agents();
    const rows = this.db.query<{ agent: string; n: number; last: number }, []>("SELECT agent, COUNT(*) AS n, MAX(seq) AS last FROM learnings_episodes GROUP BY agent ORDER BY agent").all();
    return { agents: rows.filter((r) => !off.has(r.agent)).map((r) => ({ agent: r.agent, episodes: r.n, last_seq: r.last })) };
  }

  /** GET /v1/learnings/lessons?agent=&lineage= (docs/plans/AGENT-LEARNINGS.md 4) */
  lessons(q: { agent?: string; lineage?: string }) {
    this.sweep();
    if (!q.agent || !AGENT.test(q.agent)) throw bad("bad_query", "agent must be an agent id");
    if (q.lineage !== undefined && !HEX64.test(q.lineage)) throw bad("bad_query", "lineage must be 64 hex");
    const rows = this.db
      .query<{ json: string; seq: number }, (string | number)[]>(`SELECT json, seq FROM learnings_episodes WHERE agent = ?${q.lineage ? " AND lineage_id = ?" : ""} ORDER BY seq`)
      .all(...([q.agent, ...(q.lineage ? [q.lineage] : [])] as string[]));
    return { agent: q.agent, lineages: distill(rows.map((r) => this.row(r.json, r.seq))) };
  }

  // ---------------------------------------------------------------------------------------------
  // publication records (the identity service, runtime key)

  /** POST /v1/learnings/repos { repos: [{ agent, status, repo, url, commit, verified, episodes, last_seq, reason }] } */
  recordRepos(by: string, body: unknown) {
    const b = body as { repos?: unknown };
    if (!isObj(b) || !Array.isArray(b.repos) || b.repos.length > 500) throw bad("bad_repos", "repos: [...] of at most 500");
    const now = this.c.now();
    const put = this.db.query("INSERT OR REPLACE INTO learnings_repos (agent, body, reported_at, reported_by) VALUES (?, ?, ?, ?)");
    let n = 0;
    this.c.tx(() => {
      for (const r of b.repos as unknown[]) {
        if (!isObj(r) || typeof r.agent !== "string" || !AGENT.test(r.agent)) throw bad("bad_repos", "each record needs an agent id");
        if (!["published", "awaiting publisher", "skipped", "failed"].includes(r.status as string)) throw bad("bad_repos", "status: published | awaiting publisher | skipped | failed");
        for (const k of ["repo", "url", "commit", "reason"]) if (r[k] !== undefined && r[k] !== null && !shortStr(r[k], 300)) throw bad("bad_repos", `${k} must be a short string`);
        if (r.url && !/^https:\/\/github\.com\//.test(r.url as string)) throw bad("bad_repos", "url must be a github.com URL");
        for (const k of ["episodes", "last_seq"]) if (r[k] !== undefined && r[k] !== null && !nat(r[k])) throw bad("bad_repos", `${k} must be a count`);
        if (r.verified !== undefined && r.verified !== null && typeof r.verified !== "boolean") throw bad("bad_repos", "verified must be a boolean");
        const rec = { agent: r.agent, status: r.status, repo: r.repo ?? null, url: r.url ?? null, commit: r.commit ?? null, verified: r.verified ?? null, episodes: r.episodes ?? null, last_seq: r.last_seq ?? null, reason: r.reason ?? null };
        put.run(r.agent, JSON.stringify(rec), now, by);
        n++;
      }
    });
    return { recorded: n };
  }

  /** GET /v1/learnings/repos?agent= */
  repos(agent?: string) {
    const rows = agent
      ? this.db.query<{ body: string; reported_at: number }, [string]>("SELECT body, reported_at FROM learnings_repos WHERE agent = ?").all(agent)
      : this.db.query<{ body: string; reported_at: number }, []>("SELECT body, reported_at FROM learnings_repos ORDER BY agent").all();
    return { repos: rows.map((r) => ({ ...JSON.parse(r.body), reported_at: r.reported_at })) };
  }
}

// ------------------------------------------------------------------------------------------------
// lessons (deterministic: no model call, so no number can be invented)

export function distill(episodes: any[]) {
  const byLineage = new Map<string, any[]>();
  for (const e of episodes) byLineage.set(e.task.lineage_id, [...(byLineage.get(e.task.lineage_id) ?? []), e]);
  const out: any[] = [];
  for (const [lineage, eps] of byLineage) {
    const targets = new Map<string, any[]>();
    for (const e of eps) {
      const t = e.task.target ? `${e.task.target.kind}:${Array.isArray(e.task.target.target) ? e.task.target.target.join(",") : e.task.target.target}` : "none";
      targets.set(t, [...(targets.get(t) ?? []), e]);
    }
    const per = [...targets].map(([key, list]) => {
      const outcomes: Record<string, number> = {};
      const reasons: Record<string, number> = {};
      const files = { accepted: new Set<string>(), rejected: new Set<string>() };
      const gains: { episode_id: string; gain_pct: number; ratio: number }[] = [];
      const usd: number[] = [];
      for (const e of list) {
        outcomes[e.outcome] = (outcomes[e.outcome] ?? 0) + 1;
        if (e.outcome === "rejected" || e.outcome === "expired") reasons[e.candidate?.reason ?? e.verdict?.reason ?? "unknown"] = (reasons[e.candidate?.reason ?? e.verdict?.reason ?? "unknown"] ?? 0) + 1;
        if (e.outcome === "accepted" && e.effect && "ratio" in e.effect) gains.push({ episode_id: e.episode_id, gain_pct: e.effect.gain_pct, ratio: e.effect.ratio });
        const paths = new Set<string>((e.candidate?.patch ?? "").split("\n").filter((l: string) => l.startsWith("+++ b/")).map((l: string) => l.slice(6)));
        if (e.outcome === "accepted") for (const p of paths) files.accepted.add(p);
        if (e.outcome === "rejected") for (const p of paths) files.rejected.add(p);
        if (typeof e.cost?.usd === "number") usd.push(e.cost.usd);
      }
      gains.sort((a, b) => b.gain_pct - a.gain_pct);
      return {
        target: key, attempts: list.length, outcomes, rejection_reasons: reasons, accepted_effects: gains, best: gains[0] ?? null,
        files_accepted: [...files.accepted].sort(), files_rejected: [...files.rejected].sort(),
        median_usd: median(usd), usd_known: usd.length,
      };
    });
    const journal = eps
      .filter((e) => e.journal)
      .sort((a, b) => b.journal.created_at - a.journal.created_at)
      .slice(0, 5)
      .map((e) => ({ episode_id: e.episode_id, created_at: e.journal.created_at, outcome: e.outcome, text: e.journal.text }));
    const first = eps[0];
    out.push({ lineage_id: lineage, recipe: first.task.recipe, attempts: eps.length, targets: per, journal, license: first.license, attribution: first.attribution });
  }
  return out;
}

/** The schema endpoint's body (GET /v1/learnings/schema). */
export function schemaDoc() {
  return {
    schema: LEARNINGS_SCHEMA_ID,
    plan: "docs/plans/AGENT-LEARNINGS.md",
    spec: "docs/SPEC.md 17.8",
    episode_id: 'sha256("lineage-episode-v1|" + session_id), hex',
    sealing:
      "An episode is published only when its session's gate is open for everyone (candidate final, ended without one, or abandoned) and every candidate its agent had committed by the session's end, its journal entry or its worker report is final. Nothing about an unpublished episode is served.",
    fields: {
      seq: "publication order; the export cursor",
      network: "devnet | mainnet",
      agent: "{ id, name, hidden, hosted, identity_mode, soul: { digest, seq, stored_at, declared_model } | null }: the soul version in force when the session started",
      model: "{ provider, models, route, harness, source }; source provenance:hosted (attested by the runtime key) | provenance:self (claimed) | worker_report (claimed) | session.proposer (the harness name only)",
      task: "{ recipe: { recipe_id, name, class, repo, commit }, lineage_id, parent_gen_id, parent_height, metrics, target, baseline }; baseline: parent samples from the counted replays",
      plan: "{ planned (worker report), opening_note (the first model note), source }",
      hypotheses: "the model's own notes between tool calls, in order (claimed, unchecked)",
      actions:
        "every session event in order: list, read, search, edit/write/patch (with diff: a unified hunk from the sealed before and after), evaluate (with phases), result (outcome, output, steps), note (text), submit (reason), give_up (reason); truncated marks a trimmed field",
      candidate: "{ commit_id, candidate_id, kind, target, claimed_effect, patch, patch_hash, semantic_hash, status, reason, committed_at, revealed_at, finalized_at, gen_id } | null",
      replays: "[{ replay_id, kind, role, status, replayer, counted, apply, build, tests (counts), equivalence_same, metrics: { name: { base, cand, ratio } }, env }]",
      verdict: "{ outcome, reason, detail, effect, digest } | null, as Core judged it",
      outcome: "accepted | rejected | expired | no_candidate | abandoned",
      effect: "{ metric, ratio, ci_low, ci_high, gain_pct } | { fixed } | null; ratio is new over old oriented so lower is better (worst counted replay), gain_pct = (1 - ratio) x 100",
      cost: "{ input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, usd, sandbox_s, source } | null; never estimated",
      reward: "see reward below",
      worker_outcome: "the worker's own outcome line (claimed) | null",
      journal: "{ entry_id, text, created_at, sig, signer } | null (SPEC 17.6, signed by the agent)",
      provenance: "{ runtime, digest, sig, signer } | null; the full record at verify.provenance",
      license: "{ repo, spdx, name, url, source, read_on } | null: the target repository's licence as GitHub reports it",
      attribution: "attribution line for the code excerpts (reads, diffs, patch)",
      times: "{ started_at, ended_at, finalized_at, published_at } (unix ms)",
      verify: "Core paths that serve each part independently",
    },
    reward: {
      v: 1,
      accepted: "1 when outcome is accepted, else 0",
      effect: "accepted metric candidate: 1 - verdict.effect.ratio; every other outcome: 0; accepted fix: null",
      fixed_tests: "accepted fix: number of tests fixed; else 0",
      effect_per_usd: "effect / cost.usd when effect is a number and cost.usd > 0, else null",
      effect_per_sandbox_hour: "effect / (cost.sandbox_s / 3600) when effect is a number and cost.sandbox_s > 0, else null",
      reverted: "the accepted generation was reverted when the episode was published",
      inputs: "the fields each value came from",
    },
    export: {
      json: "GET /v1/learnings/episodes?since=<seq>&limit=<1..200> -> { episodes, next_since, more }",
      jsonl: "GET /v1/learnings/episodes?since=<seq>&limit=<1..1000>&format=jsonl -> one episode per line; headers x-next-since, x-more, link",
      filters: "agent, lineage, outcome, provider (none for no provider), hidden=1 to include hidden test launches",
    },
  };
}

/** The JSONL response with its cursor headers. */
export function jsonlResponse(page: { episodes: any[]; next_since: number; more: boolean }, url: URL): Response {
  const next = new URL(url.toString());
  next.searchParams.set("since", String(page.next_since));
  const headers: Record<string, string> = {
    "content-type": "application/x-ndjson; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "x-next-since, x-more, link",
    "x-next-since": String(page.next_since),
    "x-more": page.more ? "1" : "0",
  };
  if (page.more) headers.link = `<${next.pathname}${next.search}>; rel="next"`;
  return new Response(page.episodes.map((e) => JSON.stringify(e)).join("\n") + (page.episodes.length ? "\n" : ""), { status: 200, headers });
}

