import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Core } from "./core.ts";
import { ApiError, bad } from "./errors.ts";
import { sha256Hex } from "./protocol.ts";

// Purge (owner 2026-10-12: "dont just hide remove it"): deletes a launch and everything it produced
// from Core's database for good, and puts the units it built on back to their starting point.
//
// What goes: the agent's record, keys and soul, its candidates and commits, the generations of every
// unit it built, the replays, audits, disputes and verdict draws of that work (the verifiers' rows for
// it and the units they were due for it included), sessions and their events, journal, learnings,
// intents, posts, follows and reactions by or on it, spend, usage and vault records, its ledger
// transactions, its hidden and retired entries, and every event that names any of these. A unit
// whose whole chain was built by purged agents returns to generation 0: tip = gen0, height 0. Its
// recipe, calibration, snapshot and the verifiers' qualifications are not touched, so nothing is
// measured again. A unit whose chain mixes purged and kept authors is never rewritten: the purge
// refuses.
//
// How it stays safe:
//  - one transaction; `plan` runs the same code and rolls it back, so the plan's counts are the run's;
//  - every table of the database is classified below (RULES). A table this file does not know, or a
//    table that must not change, that mentions a purged id makes the purge refuse;
//  - after the deletions every cell of every table is read again: one remaining mention of a purged
//    agent, mint, candidate, commit, generation, session or replay id rolls the whole thing back;
//  - the ledger must reconcile afterwards (whole transactions are removed, balances recomputed);
//  - a real run refuses without a consistent copy of the database taken first (VACUUM INTO, the
//    mechanism of scripts/deploy/backup.sh), named pre-purge-<time>.db;
//  - it refuses while the agent has a candidate open, a replay of its work assigned, or a session
//    live (unless `force`, which the deployment switch uses: the earlier registry is gone anyway).
//
// What keeps a purged launch from coming back: purged_agents, a list of sha256 digests of the agent
// id and of the coin mint (no row names either in clear). Core's chain sync skips a launch whose
// digest is listed, so an AgentLaunch that still exists on chain is never imported again; the hosted
// runtime and the market indexer read GET /v1/purged and drop what matches.
//
// What a purge cannot remove: the coin and the launch records on chain.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS purged_agents (
  agent_sha256 TEXT PRIMARY KEY,    -- sha256 of the agent id (base58 text)
  mint_sha256 TEXT,                 -- sha256 of its coin mint (base58 text)
  purged_at INTEGER NOT NULL,
  purged_by_sha256 TEXT NOT NULL,   -- sha256 of the admin key that ran it, or of "chain:switch"
  note TEXT
);`;

const AGENT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HEX64 = /[0-9a-f]{64}/g;
const OPEN_CANDIDATE = ["committed", "waiting", "queued", "replaying", "disputed"];
const LIVE_SESSION_MS = 10 * 60_000;

/** The digest a purged agent or mint is listed under (GET /v1/purged). */
export const purgeDigest = (id: string) => sha256Hex(new TextEncoder().encode(id));

type Rule =
  /** delete every row that mentions a purged id */
  | "rows"
  /** must not change: a mention of a purged id refuses the purge */
  | "keep"
  /** handled by its own code below */
  | "special";

/**
 * Every table Core creates, and what a purge does with it. `rows`: a row that names a purged agent,
 * mint, candidate, commit, generation, session, replay, audit, intent, entry or message id is
 * deleted. `keep`: network state that no launch owns; it is left as it is, and the purge refuses if
 * one of its rows names a purged id. `special`: see the function named in the comment.
 */
export const RULES: Record<string, Rule> = {
  // the agent itself
  agents: "rows", agent_keys: "rows", agent_previous_tokens: "rows", retired_agents: "rows", hidden_mints: "rows", nonces: "rows",
  links: "rows", tweet_launches: "rows", prepay: "rows", bonds: "rows", strikes: "rows", slashes: "rows", claims: "rows",
  souls: "rows", soul_chain: "rows", coin_images: "rows", msg_keys: "rows", msg_blocks: "rows",
  // its work, and the verifiers' rows about that work
  candidates: "rows", candidate_deferrals: "rows", generations: "rows", gen_github: "rows", provenance: "rows", series: "rows",
  splits: "rows", split_reports: "rows", teams: "rows", team_members: "rows", ports: "rows",
  replays: "rows", audits: "rows", disputes: "rows", assignment_rounds: "rows", beacon_uses: "rows", slot_beacons: "rows",
  canary_queue: "rows", units: "rows", usage: "rows", records: "rows", record_marks: "rows", contributions: "rows", bounty_results: "rows",
  upstream_prs: "rows", upstream_merges: "rows", challenges: "rows", bounties: "rows", open_bounties: "rows",
  findings: "rows", hotspot_claims: "rows", profile_replays: "rows",
  // what it did and said
  sessions: "rows", session_events: "rows", activity: "rows", heartbeat_log: "rows", intents: "rows", journal: "rows",
  learnings_episodes: "rows", learnings_reports: "rows", learnings_skipped: "rows", learnings_repos: "rows",
  messages: "rows", shadow_board: "rows", shadow_plans: "rows",
  social_follows: "rows", social_agent_follows: "rows", social_reactions: "rows", social_media: "rows", social_hidden: "rows",
  social_hide_log: "rows", social_writes: "rows",
  // spend, revenue and viewers
  runtime_spend: "rows", runtime_spend_samples: "rows", runtime_spend_daily: "rows", viewer_samples: "rows", viewer_hourly: "rows",
  revenue_cranks: "rows", revenue_identity: "rows", revenue_tokens: "rows",
  pool_mirror: "rows", pool_actions: "rows", pool_milestones: "rows", pool_settlements: "rows", fee_claim_attestations: "rows",
  // swarms (swarms.ts): a seat's session link, heartbeat and the runtime's statement about it
  swarm_sessions: "rows", swarm_heartbeats: "rows", swarm_seat_state: "rows",
  // reports a service sends again on its next pass (one row holds every agent)
  runtime_spend_global: "rows", findings_dump: "rows", model_availability: "rows",
  // the event log: an event that names anything purged goes
  events: "rows",
  // special
  lineages: "special", // resetUnits: tip = gen0, height 0
  heartbeats: "special", // a purged agent's row goes; a verifier's row only loses the job fields that name purged work
  soul_library: "special", // used_by of a purged agent is cleared
  ledger_entries: "special", // purgeLedger: whole transactions go, balances are recomputed, reconcile must pass
  balances: "special",
  chain_slashes: "special", // rows of deleted slashes
  slash_reversals: "special",
  purged_agents: "special", // the digests written by this purge
  // network state no launch owns
  repos: "keep", recipes: "keep", snapshots: "keep", calibrations: "keep", qualifications: "keep", canaries: "keep",
  epochs: "keep", chain_epochs: "keep", chain_deployments: "keep", meta: "keep", schema_migrations: "keep", guard_configs: "keep",
  model_registry: "keep", msg_chain_cursor: "keep", prepay_admin: "keep", prepay_rates: "keep", social_config: "keep",
  recipe_proposals: "keep", calib_replays: "keep", upstream_repos: "keep", upstream_seen: "keep", revenue_sources: "keep",
  swarm_settings: "keep", // the admin's swarm settings (swarms.ts): no launch owns them
  pool_kv: "keep", fee_claim_kv: "keep", fee_claim_states: "keep", fee_claim_users: "keep",
  fee_claim_repos: "keep", fee_claim_repo_names: "keep", fee_claim_bound: "keep", // GitHub repositories by numeric id and the ids bound to them: no launch owns them
  shadows: "keep", shadow_keys: "keep", shadow_msg_keys: "keep", shadow_souls: "keep",
};

export interface PurgeReport {
  plan: boolean;
  agents: number;
  already_purged: number;
  /** rows deleted (or changed) per table; a table that lost nothing is not listed */
  tables: Record<string, { action: string; rows: number }>;
  units_reset: { lineage_id: string; height_before: number; generations_removed: number }[];
  ledger: { transactions_removed: number; accounts_recomputed: number };
  blobs_removed: number;
  backup: string | null;
  scanned: { tables: number; rows: number };
}

class Refused extends ApiError {
  constructor(message: string, readonly detail?: unknown) {
    super(409, "purge_refused", message);
  }
}
class Rollback extends Error {
  constructor(readonly report: PurgeReport) {
    super("plan");
  }
}

interface Internals {
  db: Core["db"];
  blobs: Core["blobs"];
  ledger: Core["ledger"];
  now(): number;
  tx<T>(fn: () => T): T;
  emitEvent(type: string, data: unknown): void;
  depth: number;
}

const instances = new WeakMap<Core, Purge>();
export function purgeOf(core: Core): Purge {
  let p = instances.get(core);
  if (!p) instances.set(core, (p = new Purge(core)));
  return p;
}

/** Called after a purge committed: modules that cache rows drop what they hold. */
const afterPurge = new Set<(core: Core) => void>();
export function onPurge(fn: (core: Core) => void) {
  afterPurge.add(fn);
}

export class Purge {
  private readonly c: Internals;
  private digests: { agents: Set<string>; mints: Set<string> } | null = null;
  constructor(private readonly core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(SCHEMA);
  }

  // ------------------------------------------------------------------------------------------ the list

  private listed() {
    if (this.digests) return this.digests;
    this.c.db.exec(SCHEMA);
    const rows = this.c.db.query<{ agent_sha256: string; mint_sha256: string | null }, []>("SELECT agent_sha256, mint_sha256 FROM purged_agents").all();
    return (this.digests = { agents: new Set(rows.map((r) => r.agent_sha256)), mints: new Set(rows.map((r) => r.mint_sha256).filter((m): m is string => !!m)) });
  }

  /** True for an agent that was purged: nothing may import or register it again. */
  isPurged(agent: string): boolean {
    const l = this.listed();
    return l.agents.size > 0 && l.agents.has(purgeDigest(agent));
  }
  isPurgedMint(mint: string): boolean {
    const l = this.listed();
    return l.mints.size > 0 && l.mints.has(purgeDigest(mint));
  }

  /** GET /v1/purged: digests only. A reader hashes the id it holds and compares. */
  list() {
    this.c.db.exec(SCHEMA);
    const purged = this.c.db.query<{ agent_sha256: string; mint_sha256: string | null; purged_at: number }, []>("SELECT agent_sha256, mint_sha256, purged_at FROM purged_agents ORDER BY purged_at, agent_sha256").all();
    return { digest: "sha256 of the base58 text", purged, count: purged.length };
  }

  // ------------------------------------------------------------------------------------------- the run

  /**
   * POST /v1/admin/purge { agents: [id], plan?: true, force?: true, backup_dir?: path }.
   * `plan` deletes nothing and returns the counts a run would. A run takes the database copy first.
   */
  route(by: string, body: unknown): PurgeReport {
    const b = (body ?? {}) as { agents?: unknown; plan?: unknown; force?: unknown; backup_dir?: unknown; note?: unknown };
    if (!Array.isArray(b.agents) || !b.agents.length || b.agents.length > 500) throw bad("bad_purge", "agents: 1 to 500 agent ids");
    for (const [i, a] of b.agents.entries()) if (typeof a !== "string" || !AGENT.test(a)) throw bad("bad_purge", `agents[${i}]: a base58 agent id`);
    const agents = [...new Set(b.agents as string[])];
    if (b.backup_dir !== undefined && typeof b.backup_dir !== "string") throw bad("bad_purge", "backup_dir: a directory path");
    const note = typeof b.note === "string" ? b.note.slice(0, 200) : null;
    if (b.plan === true) return this.plan(agents, { force: b.force === true });
    // nothing left to delete (every agent is purged already, or unknown: 404): no copy is taken
    if (!agents.some((a) => this.c.db.query("SELECT 1 FROM agents WHERE agent_id = ?").get(a))) return { ...this.plan(agents, { force: b.force === true }), plan: false };
    if (this.c.depth > 0) throw new Refused("a purge copies the database first and cannot start inside a transaction");
    const backup = this.copyDatabase(typeof b.backup_dir === "string" ? b.backup_dir : undefined);
    return this.run(agents, { by, force: b.force === true, backup, note });
  }

  /** The same code as a run, rolled back: what would go, or the refusal a run would meet. */
  plan(agents: string[], opts: { force?: boolean } = {}): PurgeReport {
    try {
      this.c.tx(() => {
        throw new Rollback(this.inner(agents, { by: "plan", force: !!opts.force, backup: null, note: null, plan: true }).report);
      });
    } catch (e) {
      this.digests = null;
      if (e instanceof Rollback) return e.report;
      throw e;
    }
    throw new Error("unreachable");
  }

  /**
   * Deletes for good. `backup` is the path of the copy taken before (route() takes it; the deployment
   * switch passes the copy the go-live kit took, or runs inside its own transaction with `inTx`).
   */
  run(agents: string[], opts: { by: string; force?: boolean; backup: string | null; note?: string | null; inTx?: boolean }): PurgeReport {
    if (!opts.inTx && (!opts.backup || !existsSync(opts.backup) || statSync(opts.backup).size === 0)) throw new Refused("no copy of the database was taken before the purge");
    let out: { report: PurgeReport; blobs: string[] };
    try {
      out = this.c.tx(() => this.inner(agents, { by: opts.by, force: !!opts.force, backup: opts.backup, note: opts.note ?? null, plan: false }));
    } finally {
      this.digests = null;
    }
    // a switch calls this inside its own transaction: the caller finishes (Purge.finish) after it commits
    if (!opts.inTx) this.finish(out);
    else this.pending.push(out);
    return out.report;
  }

  private pending: { report: PurgeReport; blobs: string[] }[] = [];
  /** After the transaction of an `inTx` run committed (or rolled back: `committed` false). */
  settle(committed: boolean) {
    const ps = this.pending;
    this.pending = [];
    this.digests = null;
    if (committed) for (const p of ps) this.finish(p);
  }

  private finish(out: { report: PurgeReport; blobs: string[] }) {
    for (const fn of afterPurge) fn(this.core);
    // files of the blob store that only purged rows named
    for (const sha of out.blobs) {
      try {
        unlinkSync(this.c.blobs.path(sha));
        out.report.blobs_removed++;
      } catch {}
    }
  }

  /** VACUUM INTO: one read transaction, consistent while Core serves (scripts/deploy/backup.sh). */
  copyDatabase(dir?: string): string {
    const file = this.c.db.filename;
    if (!file || file === ":memory:") throw new Refused("this Core has no database file to copy");
    const out = dir ?? join(dirname(file), "purge-backups");
    mkdirSync(out, { recursive: true, mode: 0o700 });
    const path = join(out, `pre-purge-${new Date(this.c.now()).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${process.pid}.db`);
    if (existsSync(path)) throw new Refused(`a copy named ${path} exists already`);
    if (path.includes("'")) throw new Refused("the copy's path may not hold a quote");
    this.c.db.exec(`VACUUM INTO '${path}'`);
    // the copy must open and hold the same agents table
    const copy = new Database(path, { readonly: true });
    try {
      const n = copy.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM agents").get()!.c;
      const here = this.c.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM agents").get()!.c;
      if (n !== here) throw new Refused(`the copy holds ${n} agents, the database ${here}`);
    } finally {
      copy.close();
    }
    return path;
  }

  // ------------------------------------------------------------------------------------------- inside

  private has(table: string): boolean {
    return !!this.c.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  }
  private col<T = string>(sql: string, ...args: (string | number)[]): T[] {
    return (this.c.db.query(sql).values(...args) as unknown[][]).map((r) => r[0] as T);
  }
  /** `sql` holds one `(?)` list placeholder, filled in chunks. */
  private inList<T = string>(sql: string, ids: Iterable<string>): T[] {
    const all = [...ids];
    const out: T[] = [];
    for (let i = 0; i < all.length; i += 400) {
      const part = all.slice(i, i + 400);
      out.push(...this.col<T>(sql.replace("(?)", `(${part.map(() => "?").join(",")})`), ...part));
    }
    return out;
  }

  private inner(agentsIn: string[], o: { by: string; force: boolean; backup: string | null; note: string | null; plan: boolean }): { report: PurgeReport; blobs: string[] } {
    const db = this.c.db;
    db.exec(SCHEMA);
    const now = this.c.now();
    const report: PurgeReport = { plan: o.plan, agents: 0, already_purged: 0, tables: {}, units_reset: [], ledger: { transactions_removed: 0, accounts_recomputed: 0 }, blobs_removed: 0, backup: o.backup, scanned: { tables: 0, rows: 0 } };

    // ---- who
    const agents: string[] = [];
    for (const a of agentsIn) {
      const row = db.query<{ kind: string; shadow: number }, [string]>("SELECT kind, shadow FROM agents WHERE agent_id = ?").get(a);
      if (!row) {
        if (this.isPurged(a)) {
          report.already_purged++;
          continue;
        }
        throw new ApiError(404, "not_found", `no agent ${a}`);
      }
      if (row.kind !== "launched" || row.shadow) throw new Refused(`${a} is not a launched agent (kind ${row.kind}): a purge removes launches only`);
      agents.push(a);
    }
    report.agents = agents.length;
    if (!agents.length) return { report, blobs: [] };
    const A = new Set(agents);

    // ---- nothing in flight
    if (!o.force) {
      const open = this.inList<string>(`SELECT commit_id FROM candidates WHERE status IN (${OPEN_CANDIDATE.map((s) => `'${s}'`).join(",")}) AND author IN (?)`, A);
      if (open.length) throw new Refused(`${open.length} candidate(s) of the agent are still open: wait for their verdicts`);
      const replays = this.inList<string>("SELECT r.replay_id FROM replays r JOIN candidates c ON c.candidate_id = r.candidate_id WHERE r.status IN ('assigned','committed') AND c.author IN (?)", A);
      if (replays.length) throw new Refused(`${replays.length} replay(s) of the agent's work are in flight`);
      if (this.has("sessions")) {
        const live = this.inList<string>(`SELECT session_id FROM sessions WHERE ended_at IS NULL AND last_at > ${now - LIVE_SESSION_MS} AND agent_id IN (?)`, A);
        if (live.length) throw new Refused(`${live.length} session(s) of the agent are live: stop its runtime first`);
      }
    }

    // ---- the ids that must not remain anywhere
    const clear = new Set<string>(agents); // base58 text: matched as a substring
    const hex = new Set<string>(); // 64 hex ids: matched as tokens
    const addHex = (xs: (string | null)[]) => {
      for (const x of xs) if (typeof x === "string" && /^[0-9a-f]{64}$/.test(x)) hex.add(x);
    };
    const mintOf = new Map<string, string>();
    for (const a of agents) {
      const m = db.query<{ mint: string | null }, [string]>("SELECT mint FROM agents WHERE agent_id = ?").get(a)?.mint;
      if (m && AGENT.test(m) && m !== a) mintOf.set(a, m);
    }
    const mintSources: [string, string, string][] = [["hidden_mints", "mint", "agent"], ["agent_previous_tokens", "mint", "agent_id"], ["prepay", "mint", "agent_id"], ["revenue_tokens", "mint", "agent"], ["retired_agents", "mint", "agent_id"]];
    for (const [t, m, a] of mintSources) if (this.has(t)) for (const x of this.inList<string | null>(`SELECT ${m} FROM ${t} WHERE ${a} IN (?)`, A)) if (x && AGENT.test(x) && !A.has(x)) clear.add(x);
    for (const m of mintOf.values()) clear.add(m);

    const commits = this.inList<string>("SELECT commit_id FROM candidates WHERE author IN (?)", A);
    const candIds = new Set(this.inList<string | null>("SELECT candidate_id FROM candidates WHERE author IN (?)", A).filter((x): x is string => !!x));

    // units the agent built: reset only when no kept author has a generation on them
    const lineages = this.inList<string>("SELECT DISTINCT lineage_id FROM generations WHERE entry_type = 'patch' AND author IN (?)", A);
    const gens = new Set<string>();
    for (const l of lineages) {
      const kept = db.query<{ author: string | null; n: number }, [string]>("SELECT author, COUNT(*) AS n FROM generations WHERE lineage_id = ? AND entry_type = 'patch' GROUP BY author").all(l).filter((r) => !r.author || !A.has(r.author));
      if (kept.length)
        throw new Refused(`unit ${l} mixes generations of the purged agent with ${kept.reduce((n, r) => n + r.n, 0)} generation(s) of ${kept.length} other author(s): its chain is not rewritten`, { lineage_id: l });
      const lin = db.query<{ gen0: string; height: number }, [string]>("SELECT gen0, height FROM lineages WHERE lineage_id = ?").get(l)!;
      const removed = this.col<string>("SELECT gen_id FROM generations WHERE lineage_id = ? AND gen_id != ?", l, lin.gen0);
      for (const g of removed) gens.add(g);
      report.units_reset.push({ lineage_id: l, height_before: lin.height, generations_removed: removed.length });
    }
    // canaries Core injected on top of a purged generation are part of that work
    if (gens.size) {
      for (const col of ["parent_gen_id", "eval_parent_gen_id"]) {
        commits.push(...this.inList<string>(`SELECT commit_id FROM candidates WHERE is_canary = 1 AND ${col} IN (?)`, gens));
        for (const x of this.inList<string | null>(`SELECT candidate_id FROM candidates WHERE is_canary = 1 AND ${col} IN (?)`, gens)) if (x) candIds.add(x);
      }
    }
    addHex(commits);
    addHex([...candIds]);
    addHex([...gens]);
    const audits = new Set<string>([...this.inList<string>("SELECT audit_id FROM audits WHERE candidate_id IN (?)", candIds), ...this.inList<string>("SELECT audit_id FROM audits WHERE gen_id IN (?)", gens)]);
    addHex([...audits]);
    addHex(this.inList<string>("SELECT replay_id FROM replays WHERE candidate_id IN (?)", candIds));
    addHex(this.inList<string>("SELECT replay_id FROM replays WHERE audit_id IN (?)", audits));
    const own: [string, string, string][] = [
      ["sessions", "session_id", "agent_id"], ["intents", "intent_id", "agent"], ["journal", "entry_id", "agent"], ["learnings_episodes", "episode_id", "agent"],
      ["messages", "msg_id", "from_agent"], ["messages", "msg_id", "to_agent"], ["souls", "digest", "agent"], ["hotspot_claims", "claim_id", "finder"], ["findings", "finding_id", "finder"],
    ];
    for (const [t, id, a] of own) if (this.has(t)) addHex(this.inList<string | null>(`SELECT ${id} FROM ${t} WHERE ${a} IN (?)`, A));
    const slashIds = this.inList<number>("SELECT id FROM slashes WHERE agent_id IN (?)", A);

    const needles = [...clear];
    const mentions = (v: unknown): boolean => {
      if (typeof v !== "string" || v.length < 32) return false;
      for (const n of needles) if (v.includes(n)) return true;
      if (v.length >= 64 && hex.size) {
        HEX64.lastIndex = 0;
        for (let m = HEX64.exec(v); m; m = HEX64.exec(v)) if (hex.has(m[0])) return true;
      }
      return false;
    };
    // blob files the deleted rows name (a sha256 that is a file of the store)
    const blobSeen = new Set<string>();
    const noteBlobs = (v: unknown) => {
      if (typeof v !== "string" || v.length < 64) return;
      for (const m of v.match(HEX64) ?? []) if (!blobSeen.has(m) && !hex.has(m) && this.c.blobs.has(m)) blobSeen.add(m);
    };
    const count = (t: string, action: string, n: number) => {
      if (!n) return;
      const cur = report.tables[t];
      report.tables[t] = { action: cur ? cur.action : action, rows: (cur?.rows ?? 0) + n };
    };

    const tables = this.col<string>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const unknown = tables.filter((t) => !RULES[t]);

    // ---- the big keyed tables first, by their key (the row walk below then finds nothing left in them)
    if (this.has("session_events") && this.has("sessions")) {
      const sids = this.inList<string>("SELECT session_id FROM sessions WHERE agent_id IN (?)", A);
      for (let i = 0; i < sids.length; i += 400) {
        const part = sids.slice(i, i + 400);
        const ph = part.map(() => "?").join(",");
        for (const r of db.query<{ pub: string | null; sealed: string | null }, string[]>(`SELECT pub, sealed FROM session_events WHERE session_id IN (${ph})`).iterate(...part)) {
          noteBlobs(r.pub);
          noteBlobs(r.sealed);
        }
        count("session_events", "rows deleted", db.query(`DELETE FROM session_events WHERE session_id IN (${ph})`).run(...part).changes);
      }
    }

    // ---- units back to generation 0 (before their generations go: lineages.tip references generations)
    for (const u of report.units_reset) db.query("UPDATE lineages SET tip = gen0, height = 0 WHERE lineage_id = ?").run(u.lineage_id);
    count("lineages", "tip = gen0, height 0", report.units_reset.length);

    // ---- the ledger: every transaction that touches a purged account or names a purged id
    this.purgeLedger(mentions, report, count);

    // ---- rows
    const walk = (t: string, onHit: (rowid: number, row: Record<string, unknown>) => void) => {
      for (const row of db.query<Record<string, unknown>, []>(`SELECT rowid AS __rowid, * FROM "${t}"`).iterate()) {
        for (const k in row) {
          if (k !== "__rowid" && mentions(row[k])) {
            onHit(row.__rowid as number, row);
            break;
          }
        }
      }
    };
    const delRows = (t: string, ids: number[]) => {
      let n = 0;
      for (let i = 0; i < ids.length; i += 400) {
        const part = ids.slice(i, i + 400);
        n += db.query(`DELETE FROM "${t}" WHERE rowid IN (${part.map(() => "?").join(",")})`).run(...part).changes;
      }
      return n;
    };
    // children before parents (generations reference lineages and are referenced by nothing enforced; candidates are free)
    const order = [...tables.filter((t) => t !== "generations" && t !== "agents"), "generations", "agents"].filter((t) => tables.includes(t));
    for (const t of order) {
      const rule = RULES[t];
      if (rule !== "rows") continue;
      const ids: number[] = [];
      walk(t, (rowid, row) => {
        ids.push(rowid);
        for (const k in row) noteBlobs(row[k]);
      });
      // generations of one unit: newest first, so no row is deleted while a later one still points at it
      if (t === "generations" && ids.length) {
        const byHeight = new Map(db.query<{ rowid: number; height: number }, []>("SELECT rowid, height FROM generations").all().map((r) => [r.rowid, r.height]));
        ids.sort((a, b) => (byHeight.get(b) ?? 0) - (byHeight.get(a) ?? 0));
        let n = 0;
        for (const id of ids) n += db.query("DELETE FROM generations WHERE rowid = ?").run(id).changes;
        count(t, "rows deleted", n);
      } else count(t, "rows deleted", delRows(t, ids));
    }

    // ---- special tables
    if (this.has("heartbeats")) {
      const cols = new Set(this.col<string>("SELECT name FROM pragma_table_info('heartbeats')"));
      const job = ["job", "phase", "replay_id", "lineage_id", "gen_id", "container_started_at", "job_started_at"].filter((c) => cols.has(c));
      const del: number[] = [];
      const clearJob: number[] = [];
      walk("heartbeats", (rowid, row) => (A.has(row.agent_id as string) ? del : clearJob).push(rowid));
      count("heartbeats", "rows deleted", delRows("heartbeats", del));
      for (const id of clearJob) db.query(`UPDATE heartbeats SET ${job.map((c) => `${c} = NULL`).join(", ")} WHERE rowid = ?`).run(id);
      count("heartbeats", "job fields cleared", clearJob.length);
    }
    if (this.has("soul_library")) count("soul_library", "used_by cleared", this.inList<number>("UPDATE soul_library SET used_by = NULL WHERE used_by IN (?) RETURNING id", A).length);
    for (const [t, c] of [["chain_slashes", "slash_id"], ["slash_reversals", "slash_row"]] as const) {
      if (!this.has(t) || !slashIds.length) continue;
      let n = 0;
      for (const id of slashIds) n += db.query(`DELETE FROM ${t} WHERE ${c} = ?`).run(id).changes;
      count(t, "rows deleted", n);
    }

    // ---- the list that keeps the launch from being imported again
    const by = purgeDigest(o.by);
    for (const a of agents) {
      const m = mintOf.get(a);
      db.query("INSERT OR REPLACE INTO purged_agents (agent_sha256, mint_sha256, purged_at, purged_by_sha256, note) VALUES (?, ?, ?, ?, ?)").run(purgeDigest(a), m ? purgeDigest(m) : null, now, by, o.note);
    }
    count("purged_agents", "digests written", agents.length);
    this.digests = null;

    // ---- proof: read every cell of every table again
    const left: { table: string; rows: number; rule: string }[] = [];
    const blobsKept = new Set<string>();
    for (const t of tables) {
      let hits = 0;
      let rows = 0;
      for (const row of db.query<Record<string, unknown>, []>(`SELECT * FROM "${t}"`).iterate()) {
        rows++;
        let hit = false;
        for (const k in row) {
          const v = row[k];
          if (!hit && mentions(v)) hit = true;
          if (blobSeen.size && typeof v === "string" && v.length >= 64) for (const m of v.match(HEX64) ?? []) if (blobSeen.has(m)) blobsKept.add(m);
        }
        if (hit) hits++;
      }
      report.scanned.tables++;
      report.scanned.rows += rows;
      if (hits) left.push({ table: t, rows: hits, rule: RULES[t] ?? "unknown table" });
    }
    if (left.length) {
      const what = left.map((l) => `${l.table} (${l.rows} row${l.rows === 1 ? "" : "s"}, ${l.rule})`).join(", ");
      const epoch = left.some((l) => l.table === "epochs") ? " An epoch that closed with this agent's work in it carries a root computed over that work: it cannot be purged from a closed epoch." : "";
      const mixed = left.some((l) => l.table === "candidates" || l.table === "generations") ? " Another author's candidate or generation was built on a purged generation." : "";
      throw new Refused(`rows that name the purged launch would remain: ${what}.${epoch}${mixed} Nothing was changed.`, { left, unknown_tables: unknown });
    }
    const rec = this.c.ledger.reconcile();
    if (!rec.ok) throw new Refused(`the ledger would not reconcile after the purge: ${rec.errors.slice(0, 3).join("; ")}. Nothing was changed.`);
    if (db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM pragma_foreign_key_check").get()!.n) throw new Refused("a foreign key would dangle after the purge. Nothing was changed.");

    this.c.emitEvent("purge.done", { agents: agents.length, units_reset: report.units_reset.map((u) => u.lineage_id), at: now });
    return { report, blobs: [...blobSeen].filter((b) => !blobsKept.has(b)) };
  }

  /** Whole transactions go (both rows), balances of every account they touched are the sum of what is left. */
  private purgeLedger(mentions: (v: unknown) => boolean, report: PurgeReport, count: (t: string, action: string, n: number) => void) {
    const db = this.c.db;
    const txs = new Set<number>();
    for (const e of db.query<{ tx: number; account: string; ref: string | null }, []>("SELECT tx, account, ref FROM ledger_entries").iterate()) if (mentions(e.account) || mentions(e.ref)) txs.add(e.tx);
    const accounts = new Set<string>();
    let rows = 0;
    for (const tx of txs) {
      for (const a of this.col<string>("SELECT account FROM ledger_entries WHERE tx = ?", tx)) accounts.add(a);
      rows += db.query("DELETE FROM ledger_entries WHERE tx = ?").run(tx).changes;
    }
    for (const a of this.col<string>("SELECT account FROM balances")) if (mentions(a)) accounts.add(a);
    let gone = 0;
    for (const a of accounts) {
      const deltas = this.col<string>("SELECT delta FROM ledger_entries WHERE account = ?", a);
      if (!deltas.length || mentions(a)) {
        gone += db.query("DELETE FROM balances WHERE account = ?").run(a).changes;
        continue;
      }
      const sum = deltas.reduce((s, d) => s + BigInt(d), 0n);
      db.query("INSERT INTO balances (account, amount) VALUES (?, ?) ON CONFLICT(account) DO UPDATE SET amount = excluded.amount").run(a, sum.toString());
    }
    count("ledger_entries", "whole transactions deleted", rows);
    count("balances", "accounts deleted", gone);
    report.ledger = { transactions_removed: txs.size, accounts_recomputed: accounts.size };
  }
}
