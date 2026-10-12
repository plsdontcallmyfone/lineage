import type { Database } from "bun:sqlite";
import { sha256Hex } from "@units/protocol";

// Purged launches (packages/core/src/purge.ts, owner 2026-10-12: "dont just hide remove it"). Core
// deletes a launch for good and serves GET /v1/purged: sha256 digests of the agent id and of the coin
// mint (lowercase hex of the base58 text), never an id in clear. The launch still exists on chain, so
// discovery would import it again within a minute; this file is what keeps it out.
//
//  - purged_mints and purged_agents hold the digests only. The list only grows: a digest stays when a
//    later answer of Core lacks it, and when Core cannot be read at all.
//  - dropPurged hashes every mint and agent the indexer holds and deletes every row of a listed one:
//    every table that has a `mint` column (tokens, sources, seen, trades, fee_cranks, events,
//    token_accounts, holders, sweeps, hidden_mints, and any table added later), every row of a table
//    with an `agent` column (tokens, core_agents, hidden_mints), and the entries of the pump.fun watch
//    (meta `pump_alerts`) that name it. It runs on every Core pass and is idempotent.
//  - isPurgedMint guards the write points (storeDecoded, discovery), so a pass of the indexer that was
//    already reading the chain for the coin when it was purged writes nothing for it afterwards.

export const PURGED_SCHEMA = `
CREATE TABLE IF NOT EXISTS purged_mints (mint_sha256 TEXT PRIMARY KEY, agent_sha256 TEXT, purged_at INTEGER);
CREATE TABLE IF NOT EXISTS purged_agents (agent_sha256 TEXT PRIMARY KEY, purged_at INTEGER);
`;

const HEX = /^[0-9a-f]{64}$/;
const ready = new WeakSet<Database>();

export function ensurePurgedSchema(db: Database) {
  if (ready.has(db)) return;
  db.exec(PURGED_SCHEMA);
  ready.add(db);
}

/** The digest a purged agent or mint is listed under: sha256 of its base58 text (Core's purgeDigest). */
export const purgeDigest = (id: string) => sha256Hex(id);

export interface PurgedSets { mints: Set<string>; agents: Set<string> }

export function purgedSets(db: Database): PurgedSets {
  ensurePurgedSchema(db);
  return {
    mints: new Set((db.query("SELECT mint_sha256 AS d FROM purged_mints").all() as { d: string }[]).map((r) => r.d)),
    agents: new Set((db.query("SELECT agent_sha256 AS d FROM purged_agents").all() as { d: string }[]).map((r) => r.d)),
  };
}

/** True for a launch on the list, by its mint or by its agent. */
export function isPurgedLaunch(p: PurgedSets, mint: string, agent?: string | null): boolean {
  if (p.mints.size && p.mints.has(purgeDigest(mint))) return true;
  return !!agent && p.agents.size > 0 && p.agents.has(purgeDigest(agent));
}

/** True for a purged coin: nothing may be written for it. One primary-key read. */
export function isPurgedMint(db: Database, mint: string): boolean {
  ensurePurgedSchema(db);
  return !!db.query("SELECT 1 FROM purged_mints WHERE mint_sha256 = ?").get(purgeDigest(mint));
}

/**
 * Adds the entries of a GET /v1/purged answer to the list (never removes one). Returns the number of
 * new digests; an answer of another shape adds nothing.
 */
export function recordPurged(db: Database, answer: unknown): number {
  ensurePurgedSchema(db);
  const list = (answer as { purged?: unknown } | null)?.purged;
  if (!Array.isArray(list)) return 0;
  const m = db.prepare("INSERT OR IGNORE INTO purged_mints (mint_sha256, agent_sha256, purged_at) VALUES (?,?,?)");
  const a = db.prepare("INSERT OR IGNORE INTO purged_agents (agent_sha256, purged_at) VALUES (?,?)");
  let n = 0;
  for (const x of list as { agent_sha256?: unknown; mint_sha256?: unknown; purged_at?: unknown }[]) {
    if (!x || typeof x !== "object") continue;
    const agent = typeof x.agent_sha256 === "string" && HEX.test(x.agent_sha256) ? x.agent_sha256 : null;
    const mint = typeof x.mint_sha256 === "string" && HEX.test(x.mint_sha256) ? x.mint_sha256 : null;
    const at = typeof x.purged_at === "number" && Number.isFinite(x.purged_at) ? Math.floor(x.purged_at) : null;
    if (agent) n += a.run(agent, at).changes;
    if (mint) n += m.run(mint, agent, at).changes;
  }
  return n;
}

export interface Dropped {
  /** the clear ids that were matched; for the caller's in-memory state only, never logged or stored */
  mints: string[];
  agents: string[];
  /** rows deleted, all tables together */
  rows: number;
}

const tablesWith = (db: Database, column: string) =>
  (db.query("SELECT m.name AS name FROM sqlite_master m JOIN pragma_table_info(m.name) p ON p.name = ? WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name")
    .all(column) as { name: string }[]).map((r) => r.name);

/**
 * Deletes every row of every purged launch the database holds. Call it inside a transaction.
 * `deep` also reads the distinct mints of every table with a mint column (rows whose token row is
 * already gone); without it only tokens, hidden_mints and core_agents are matched.
 */
export function dropPurged(db: Database, opts: { deep?: boolean } = {}): Dropped {
  const p = purgedSets(db);
  const out: Dropped = { mints: [], agents: [], rows: 0 };
  if (!p.mints.size && !p.agents.size) return out;
  const memo = new Map<string, string>();
  const dig = (id: string) => {
    let d = memo.get(id);
    if (!d) memo.set(id, (d = purgeDigest(id)));
    return d;
  };
  const has = (t: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const mints = new Set<string>();
  const agents = new Set<string>();
  /** the listed purge time of an agent digest, for a mint digest this database derives itself */
  const at = (agentDigest: string) => (db.query("SELECT purged_at AS t FROM purged_agents WHERE agent_sha256 = ?").get(agentDigest) as { t: number | null } | null)?.t ?? null;
  const derive = db.prepare("INSERT OR IGNORE INTO purged_mints (mint_sha256, agent_sha256, purged_at) VALUES (?,?,?)");

  const mintTables = tablesWith(db, "mint");
  const agentTables = tablesWith(db, "agent");
  // tables that carry both ids: a row is matched by either (a launch Core listed without a mint is matched by its agent)
  for (const t of mintTables.filter((x) => agentTables.includes(x))) {
    for (const r of db.query(`SELECT DISTINCT mint, agent FROM "${t}"`).all() as { mint: string | null; agent: string | null }[]) {
      const byMint = typeof r.mint === "string" && p.mints.has(dig(r.mint));
      const byAgent = typeof r.agent === "string" && p.agents.has(dig(r.agent));
      if (!byMint && !byAgent) continue;
      if (typeof r.mint === "string") {
        mints.add(r.mint);
        // the mint of a launch matched by its agent goes on the list too (digest only), so the write guards know it
        if (!byMint && typeof r.agent === "string") derive.run(dig(r.mint), dig(r.agent), at(dig(r.agent)));
      }
      if (typeof r.agent === "string") agents.add(r.agent);
    }
  }
  for (const t of agentTables.filter((x) => !mintTables.includes(x))) {
    for (const r of db.query(`SELECT DISTINCT agent FROM "${t}"`).all() as { agent: string | null }[])
      if (typeof r.agent === "string" && p.agents.has(dig(r.agent))) agents.add(r.agent);
  }
  if (opts.deep) {
    const listed = purgedSets(db).mints; // with the digests derived above
    for (const t of mintTables.filter((x) => !agentTables.includes(x))) {
      for (const r of db.query(`SELECT DISTINCT mint FROM "${t}"`).all() as { mint: string | null }[])
        if (typeof r.mint === "string" && !mints.has(r.mint) && listed.has(dig(r.mint))) mints.add(r.mint);
    }
  }

  for (const t of mintTables) for (const m of mints) out.rows += db.query(`DELETE FROM "${t}" WHERE mint = ?`).run(m).changes;
  for (const t of agentTables) for (const a of agents) out.rows += db.query(`DELETE FROM "${t}" WHERE agent = ?`).run(a).changes;

  // the pump.fun watch (indexer.ts refreshState): { checked_at, baseline, alerts: [{ kind, subject, detail }] }, subject = the mint
  if (has("meta")) {
    const rec = db.query("SELECT v FROM meta WHERE k = 'pump_alerts'").get() as { v: string } | null;
    if (rec) {
      let v: { alerts?: unknown } | null = null;
      try {
        v = JSON.parse(rec.v) as { alerts?: unknown };
      } catch {
        v = null;
      }
      if (v && Array.isArray(v.alerts)) {
        const clear = [...mints, ...agents];
        const kept = (v.alerts as { subject?: unknown }[]).filter((a) => {
          if (a && typeof a.subject === "string" && p.mints.has(dig(a.subject))) return false;
          const text = JSON.stringify(a);
          return !clear.some((id) => text.includes(id));
        });
        if (kept.length !== v.alerts.length) {
          db.query("UPDATE meta SET v = ? WHERE k = 'pump_alerts'").run(JSON.stringify({ ...v, alerts: kept }));
          out.rows += v.alerts.length - kept.length;
        }
      }
    }
  }
  out.mints = [...mints];
  out.agents = [...agents];
  return out;
}
