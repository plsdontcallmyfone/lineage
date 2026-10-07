import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// SQLite store, SPEC 18. WAL mode, forward-only numbered migrations. Token amounts are stored as
// decimal TEXT so they never pass through a float.

const MIGRATIONS: string[] = [
  // 1: initial schema
  `
  CREATE TABLE repos (
    repo_id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE recipes (
    recipe_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE snapshots (
    snapshot_id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repos(repo_id),
    commit_sha TEXT NOT NULL,
    deps_digest TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE calibrations (
    calib_id TEXT PRIMARY KEY,
    recipe_id TEXT NOT NULL REFERENCES recipes(recipe_id),
    snapshot_id TEXT NOT NULL REFERENCES snapshots(snapshot_id),
    json TEXT NOT NULL,
    submitted_by TEXT NOT NULL,
    sig TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE lineages (
    lineage_id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    recipe_id TEXT NOT NULL,
    calib_id TEXT NOT NULL,
    gen0 TEXT NOT NULL,
    tip TEXT NOT NULL,
    height INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE generations (
    gen_id TEXT PRIMARY KEY,
    lineage_id TEXT NOT NULL REFERENCES lineages(lineage_id),
    parent_gen_id TEXT,
    height INTEGER NOT NULL,
    entry_type TEXT NOT NULL,            -- genesis | patch | revert
    candidate_id TEXT,
    patch_hash TEXT,
    semantic_hash TEXT,
    patch TEXT,
    kind TEXT,
    target TEXT,                         -- JSON
    effect TEXT,                         -- JSON
    verdict_digest TEXT,
    verdict TEXT,                        -- JSON judgement
    replay_ids TEXT,                     -- JSON
    author TEXT,
    accepted_at INTEGER NOT NULL,
    epoch INTEGER NOT NULL,
    reverts TEXT,                        -- for revert entries: the reverted gen_id
    reverted_by TEXT,                    -- for patch entries: the revert entry that removed it
    needs_revalidation INTEGER NOT NULL DEFAULT 0,
    audit_status TEXT                    -- null | pending | agreed | reverted | inconclusive
  );
  CREATE INDEX generations_lineage ON generations(lineage_id, height);
  CREATE TABLE findings (
    finding_id TEXT PRIMARY KEY,
    lineage_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    tip TEXT NOT NULL,
    finder TEXT,
    status TEXT NOT NULL,                -- open | resolved
    resolved_by TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE agents (
    agent_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,                  -- launched | verifier | shadow (shadow is never exposed)
    operator TEXT,
    registered_at INTEGER NOT NULL,
    mint TEXT UNIQUE,                    -- launched: simulated agent token mint
    launcher TEXT,                       -- launched: launcher wallet
    target_repo TEXT,                    -- launched: canonical target repo URL
    target_repo_id TEXT,
    identity_mode TEXT,                  -- token | purchased | app (SPEC 13.9)
    hosted INTEGER NOT NULL DEFAULT 0,
    lifecycle TEXT NOT NULL DEFAULT 'active',  -- setting_up | active
    awake INTEGER NOT NULL DEFAULT 0,
    reference INTEGER NOT NULL DEFAULT 0,
    shadow INTEGER NOT NULL DEFAULT 0,
    suspended_through_epoch INTEGER NOT NULL DEFAULT -1,
    unbond_amount TEXT NOT NULL DEFAULT '0',
    unbond_ready_at INTEGER
  );
  CREATE TABLE bonds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    action TEXT NOT NULL,                -- bond | unbond_request | unbond_release
    amount TEXT NOT NULL,
    at INTEGER NOT NULL,
    ready_at INTEGER
  );
  CREATE TABLE nonces (
    agent_id TEXT NOT NULL,
    nonce TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (agent_id, nonce)
  );
  CREATE TABLE candidates (
    commit_id TEXT PRIMARY KEY,
    candidate_id TEXT UNIQUE,
    lineage_id TEXT NOT NULL,
    parent_gen_id TEXT NOT NULL,
    eval_parent_gen_id TEXT NOT NULL,
    author TEXT NOT NULL,
    kind TEXT NOT NULL,
    target TEXT NOT NULL,                -- JSON
    claimed_effect REAL,
    commitment TEXT NOT NULL,
    patch TEXT,
    salt TEXT,
    patch_hash TEXT,
    semantic_hash TEXT,
    guard TEXT,                          -- JSON guard result
    status TEXT NOT NULL,
    reason TEXT,
    detail TEXT,
    committed_at INTEGER NOT NULL,
    reveal_deadline INTEGER NOT NULL,
    revealed_at INTEGER,
    finalized_at INTEGER,
    stage INTEGER NOT NULL DEFAULT 0,
    want_replays INTEGER NOT NULL DEFAULT 0,
    want_reference INTEGER NOT NULL DEFAULT 0,
    reassigns INTEGER NOT NULL DEFAULT 0,
    dispute_rounds INTEGER NOT NULL DEFAULT 0,
    rounds INTEGER NOT NULL DEFAULT 0,
    is_canary INTEGER NOT NULL DEFAULT 0,
    canary_id TEXT,
    gen_id TEXT,
    verdict TEXT,                        -- JSON judgement of the final stage
    epoch INTEGER NOT NULL
  );
  CREATE INDEX candidates_lineage ON candidates(lineage_id, status);
  CREATE INDEX candidates_author ON candidates(author, status);
  CREATE TABLE replays (
    replay_id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL,
    grp TEXT NOT NULL,                   -- cand:<candidate_id>:<stage> or audit:<audit_id>
    audit_id TEXT,
    replayer TEXT NOT NULL,
    kind TEXT NOT NULL,                  -- replay | reference | audit | audit_reference
    stage INTEGER NOT NULL,
    round INTEGER NOT NULL,
    eval_parent_gen_id TEXT NOT NULL,
    assignment_seed TEXT NOT NULL,
    seed TEXT NOT NULL,
    status TEXT NOT NULL,                -- assigned | committed | revealed | invalid | abandoned | cancelled
    commitment TEXT,
    result TEXT,
    salt TEXT,
    assigned_at INTEGER NOT NULL,
    commit_deadline INTEGER NOT NULL,
    committed_at INTEGER,
    reveal_open_at INTEGER,
    reveal_deadline INTEGER,
    revealed_at INTEGER,
    role TEXT,                           -- counted | minority | env_failed | canary_pass | canary_fail
    epoch INTEGER NOT NULL
  );
  CREATE INDEX replays_replayer ON replays(replayer, status);
  CREATE INDEX replays_grp ON replays(grp);
  CREATE INDEX replays_candidate ON replays(candidate_id);
  CREATE TABLE assignment_rounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,               -- candidate_id or audit_id
    round INTEGER NOT NULL,
    epoch INTEGER NOT NULL,
    bucket INTEGER NOT NULL,
    beacon TEXT NOT NULL,
    assignment_seed TEXT NOT NULL,
    pool TEXT NOT NULL,                  -- JSON eligible set the draw used
    exclude TEXT NOT NULL,               -- JSON
    count INTEGER NOT NULL,
    chosen TEXT NOT NULL,                -- JSON
    reference TEXT,                      -- reference agent picked in this round, if any
    created_at INTEGER NOT NULL
  );
  CREATE TABLE disputes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id TEXT NOT NULL,
    stage INTEGER NOT NULL,
    fields TEXT NOT NULL,
    opened_at INTEGER NOT NULL,
    resolved_at INTEGER,
    outcome TEXT
  );
  CREATE TABLE canaries (
    canary_id TEXT PRIMARY KEY,
    lineage_id TEXT NOT NULL,
    patch TEXT NOT NULL,
    patch_hash TEXT NOT NULL,
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    expected_reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE audits (
    audit_id TEXT PRIMARY KEY,
    gen_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    status TEXT NOT NULL,                -- pending | agreed | reverted | inconclusive
    want_replays INTEGER NOT NULL DEFAULT 0,
    want_reference INTEGER NOT NULL DEFAULT 0,
    rounds INTEGER NOT NULL DEFAULT 0,
    verdict TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    epoch INTEGER NOT NULL
  );
  CREATE TABLE units (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    epoch INTEGER NOT NULL,
    agent_id TEXT NOT NULL,
    kind TEXT NOT NULL,                  -- replay | author | finder
    ref TEXT NOT NULL,
    units REAL NOT NULL,
    rebate TEXT NOT NULL DEFAULT '0',
    voided INTEGER NOT NULL DEFAULT 0,
    at INTEGER NOT NULL
  );
  CREATE INDEX units_epoch ON units(epoch, agent_id);
  CREATE TABLE strikes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    reason TEXT NOT NULL,
    ref TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE TABLE slashes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    bps INTEGER NOT NULL,
    amount TEXT NOT NULL,
    reason TEXT NOT NULL,
    ref TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE TABLE epochs (
    n INTEGER PRIMARY KEY,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    secret TEXT NOT NULL,
    beacon_commit TEXT NOT NULL,
    status TEXT NOT NULL,                -- open | closed
    closed_at INTEGER,
    pool_amount TEXT,
    rebate_amount TEXT,
    total_units REAL,
    payouts TEXT,                        -- JSON [{agent, amount, units, rebate}]
    root TEXT,
    lineage_root TEXT,
    canaries TEXT                        -- JSON
  );
  CREATE TABLE claims (
    epoch INTEGER NOT NULL,
    agent_id TEXT NOT NULL,
    dest TEXT NOT NULL,
    amount TEXT NOT NULL,
    claimed_at INTEGER NOT NULL,
    PRIMARY KEY (epoch, agent_id, dest)
  );
  CREATE TABLE ledger_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tx INTEGER NOT NULL,
    account TEXT NOT NULL,
    delta TEXT NOT NULL,
    reason TEXT NOT NULL,
    ref TEXT,
    at INTEGER NOT NULL
  );
  CREATE INDEX ledger_account ON ledger_entries(account);
  CREATE TABLE balances (
    account TEXT PRIMARY KEY,
    amount TEXT NOT NULL
  );
  CREATE TABLE usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    amount TEXT NOT NULL,
    model_tokens INTEGER,
    sandbox_seconds INTEGER,
    note TEXT,
    epoch INTEGER NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 2: verifier capabilities and qualifications (SPEC 6.1), audit detail (SPEC 10.6)
  `
  ALTER TABLE agents ADD COLUMN capabilities TEXT;      -- JSON Capabilities, null until declared
  ALTER TABLE agents ADD COLUMN capabilities_at INTEGER;
  CREATE TABLE qualifications (
    qual_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    lineage_id TEXT NOT NULL,
    recipe_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    seed TEXT NOT NULL,                  -- the calibration seed
    status TEXT NOT NULL,                -- assigned | committed | passed | failed | expired | revoked | cancelled
    capabilities TEXT,                   -- JSON capabilities declared when assigned
    commitment TEXT,
    result TEXT,
    salt TEXT,
    reason TEXT,
    assigned_at INTEGER NOT NULL,
    commit_deadline INTEGER NOT NULL,
    committed_at INTEGER,
    reveal_deadline INTEGER,
    revealed_at INTEGER,
    resolved_at INTEGER
  );
  CREATE INDEX qualifications_agent ON qualifications(agent_id, lineage_id, attempt);
  CREATE INDEX qualifications_status ON qualifications(status);
  ALTER TABLE audits ADD COLUMN detail TEXT;
  `,
  // 3: live activity and heartbeats (SPEC 17.1)
  `
  CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    kind TEXT NOT NULL,                  -- read | search | edit | evaluate | propose | submit | give_up
    lineage_id TEXT NOT NULL,
    gen_id TEXT NOT NULL,                -- the parent generation being worked on
    commit_sha TEXT NOT NULL,
    path TEXT,
    start_line INTEGER,
    end_line INTEGER,
    query TEXT,
    target TEXT,                         -- metric name or test id (evaluate, propose, submit)
    content_sha256 TEXT,
    path_checked INTEGER NOT NULL DEFAULT 0,  -- 1 when Core found the path in the generation's file list
    at INTEGER NOT NULL,                 -- the agent's timestamp
    received_at INTEGER NOT NULL
  );
  CREATE INDEX activity_agent ON activity(agent_id, received_at);
  CREATE INDEX activity_lineage ON activity(lineage_id, id);
  CREATE TABLE heartbeats (
    agent_id TEXT PRIMARY KEY,           -- latest heartbeat per machine (agent key)
    at INTEGER NOT NULL,                 -- Core's receive time
    sent_at INTEGER NOT NULL,            -- the worker's timestamp
    caps_digest TEXT,
    job TEXT NOT NULL,                   -- replay | qualify | author | idle
    phase TEXT,
    replay_id TEXT,                      -- private: the replay or qualification being run
    lineage_id TEXT,
    gen_id TEXT,
    container_started_at INTEGER,
    job_started_at INTEGER,
    load TEXT,                           -- JSON { load1, load5, load15, mem_free_mb }
    beats INTEGER NOT NULL DEFAULT 1,
    first_at INTEGER NOT NULL
  );
  `,
  // 4: chain mode (SPEC 14): what was sent to the programs, and the registry's view of each agent
  `
  ALTER TABLE agents ADD COLUMN chain_owner TEXT;       -- registry Agent.owner (chain mode)
  ALTER TABLE agents ADD COLUMN chain_caps TEXT;        -- registry Agent.capabilities digest, hex
  CREATE TABLE chain_epochs (
    n INTEGER PRIMARY KEY,
    signature TEXT,                      -- post_epoch transaction, null until it confirmed
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    posted_at INTEGER
  );
  CREATE TABLE chain_slashes (
    slash_id INTEGER PRIMARY KEY,        -- slashes.id
    signature TEXT,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    posted_at INTEGER
  );
  `,
];

export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: Database): number {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const row = db.query<{ v: number | null }, []>("SELECT MAX(version) AS v FROM schema_migrations").get();
  let v = row?.v ?? 0;
  for (; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, Date.now());
    })();
  }
  return v;
}

export const SCHEMA_VERSION = MIGRATIONS.length;
