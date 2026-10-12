import { onPurge } from "./purge.ts";
import { MAINNET_TEST_PROGRAM_IDS } from "@units/chain";
import type { Core } from "./core.ts";
import { bad } from "./errors.ts";
import { hiddenOf } from "./hidden.ts";

// Chain deployments (devnet v2, 2026-10-10; onchain/DEVNET.md "Devnet v2"). Devnet moved to pump.fun
// with a fresh deployment of the three programs at new ids, bound to the pump.fun UNITS. Core keeps
// one database across the switch, so everything off chain (lineages, generations, sessions, souls,
// journals, follows, posts, verifications) carries over unchanged. What changes is what Core mirrors
// from chain, and that is what this module records:
//
//  - chain_deployments: each registry Core has read, first seen and (for the earlier one) retired.
//    Retiring records the last epoch the old registry carries: every epoch closed before the switch
//    (`through_epoch`) stays as it was posted there and leaves the claim mirror and the posting queue;
//    the new registry anchors its epoch numbering at Core's next epoch (post_epoch's first post).
//  - agent_previous_tokens: an agent's earlier token. A relaunch under the same agent key changes the
//    agent's mint (recorded here when the bridge sees it); a relaunch under a new agent key (the
//    earlier key was not kept) is linked by the admin with POST /v1/admin/agent-previous. Either way
//    the profile shows the old token as "previous token (Meteora, devnet history)" and the earlier
//    agent id, whose Core history stays where it is.
//
// Agents mirrored from the retired registry that the new one does not carry hold no compute vault and
// no bond there: the bridge mirrors both as zero (chainAbsentAgent), so they sleep instead of drawing on
// a vault that does not exist.
//
// The switch itself (mainnet test deployment to the official one, 2026-10-12) retires everything the
// earlier registry was the source of truth for, in one transaction, the first time the bridge reads a
// different registry:
//
//  - the epoch open across the switch is closed there and then and stays with the retired registry
//    (`through_epoch` includes it): units earned on the earlier deployment, an accepted generation not
//    yet paid among them, are never part of a root posted on the new one. The next epoch opens at the
//    switch; the new registry anchors its numbering at it (post_epoch's first post takes any number).
//  - slashes decided through that epoch leave the sending queue and the bond and reserve netting.
//  - every launched agent is recorded in retired_agents and its token joins the hidden list, so it
//    leaves the listings while its work stays readable; it sleeps, and earns no units afterwards. An
//    agent the new registry carries (a relaunch, or the same launch read again) is carried: its
//    retired row is dropped.
//  - every mirrored bond and compute vault is set to zero; the same sync then mirrors what the new
//    registry holds, so no balance of the earlier registry counts on the new one.
//
// Lineages, recipes, calibrations and passed qualifications are off chain and are not touched: a
// verifier registered and bonded on the new registry under the same key is eligible again as soon
// as the bridge has read its record.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chain_deployments (
  registry_program TEXT PRIMARY KEY,
  launch_program TEXT NOT NULL,
  line_mint TEXT,
  label TEXT,
  first_seen_at INTEGER NOT NULL,
  retired_at INTEGER,
  through_epoch INTEGER,            -- retired: the last epoch closed while this registry was current
  last_posted_epoch INTEGER,        -- retired: the last epoch Core posted on it
  unposted_epochs TEXT              -- retired: JSON list of closed epochs it never received
);
CREATE TABLE IF NOT EXISTS agent_previous_tokens (
  agent_id TEXT NOT NULL,
  mint TEXT NOT NULL,
  previous_agent_id TEXT NOT NULL,  -- equal to agent_id for a relaunch under the same agent key
  venue TEXT NOT NULL,
  deployment TEXT NOT NULL,
  note TEXT,
  recorded_at INTEGER NOT NULL,
  recorded_by TEXT NOT NULL,
  PRIMARY KEY (agent_id, mint)
);
CREATE TABLE IF NOT EXISTS retired_agents (
  agent_id TEXT PRIMARY KEY,
  mint TEXT,                        -- its token on the retired deployment
  registry_program TEXT NOT NULL,   -- the retired registry it was launched on
  label TEXT,
  retired_at INTEGER NOT NULL
);`;

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface Internals {
  db: Core["db"];
  now(): number;
  emitEvent(type: string, data: unknown): void;
  tx<T>(fn: () => T): T;
  closeEpoch(): { n: number };
  currentEpoch(): { n: number };
  chainAbsentAgents(present: Set<string>): string[];
}

/** An agent launched on a retired deployment that the current registry does not carry. */
export interface RetiredAgent {
  agent_id: string;
  mint: string | null;
  registry_program: string;
  label: string | null;
  retired_at: number;
}

/** Labels of the registries this code knows by id, for a row first recorded without one. */
const KNOWN_LABELS: Record<string, string> = { [MAINNET_TEST_PROGRAM_IDS.registry]: "mainnet test" };
/** What a registry is called where a deployment is named (null: not one of the known ids). */
export const deploymentLabel = (registry: string): string | null => KNOWN_LABELS[registry] ?? null;

export interface DeploymentRow {
  registry_program: string;
  launch_program: string;
  line_mint: string | null;
  label: string | null;
  first_seen_at: number;
  retired_at: number | null;
  through_epoch: number | null;
  last_posted_epoch: number | null;
  unposted_epochs: string | null;
}

export interface PreviousToken {
  mint: string;
  previous_agent_id: string;
  venue: string;
  deployment: string;
  note: string | null;
  recorded_at: number;
}

const instances = new WeakMap<Core, Deployments>();
// rows this module caches may be gone after a purge (purge.ts): start again from the tables
onPurge((core) => instances.delete(core));
export function deploymentsOf(core: Core): Deployments {
  let d = instances.get(core);
  if (!d) instances.set(core, (d = new Deployments(core)));
  return d;
}

/** `added_by` of the hidden entries this module writes at a switch. */
export const RETIRED_BY = "chain:retired";
const retiredReason = (d: { registry_program: string; label: string | null }) =>
  `Retired: launched on the ${d.label ? `${d.label} deployment` : "earlier deployment"} (registry ${d.registry_program}), which this network no longer reads.`;

/** What the earlier devnet deployment is called wherever a previous token is shown. */
export const DEVNET_V1 = { label: "devnet v1", venue: "meteora" };

export class Deployments {
  private readonly c: Internals;
  private through: number | null | undefined;
  private retired: Map<string, RetiredAgent> | undefined;
  private readonly core: Core;
  constructor(core: Core) {
    this.core = core;
    this.c = core as unknown as Internals;
    this.c.db.exec(SCHEMA);
  }

  /**
   * The bridge calls this on every sync with the registry it reads. The first registry seen is
   * recorded; a different one retires every earlier one (once), in one transaction: the open epoch is
   * closed and stays with the retired registry, its launched agents are retired and hidden, and every
   * mirrored bond and vault is zeroed until the new registry's are read (see the top of this file).
   */
  observe(d: { registry_program: string; launch_program: string; line_mint: string | null; label?: string | null }): { switched: DeploymentRow[] } {
    this.c.db.exec(SCHEMA);
    const cur = this.c.db.query<DeploymentRow, [string]>("SELECT * FROM chain_deployments WHERE registry_program = ?").get(d.registry_program);
    if (cur && cur.retired_at === null) return { switched: [] };
    try {
      return this.c.tx(() => this.observeInner(d, cur));
    } finally {
      // read again from the tables: a transaction that rolled back must not leave its view behind
      this.through = undefined;
      this.retired = undefined;
    }
  }

  private observeInner(d: { registry_program: string; launch_program: string; line_mint: string | null; label?: string | null }, cur: DeploymentRow | null): { switched: DeploymentRow[] } {
    const now = this.c.now();
    const open = this.c.db.query<DeploymentRow, [string]>("SELECT * FROM chain_deployments WHERE retired_at IS NULL AND registry_program != ? ORDER BY first_seen_at").all(d.registry_program);
    // the epoch open across the switch holds what was earned on the earlier deployment: closed now, never posted
    const closedOpen = open.length ? this.c.closeEpoch().n : null;
    const closed = this.c.db.query<{ n: number | null }, []>("SELECT MAX(n) AS n FROM epochs WHERE status != 'open'").get()?.n ?? null;
    const posted = this.c.db.query<{ n: number | null }, []>("SELECT MAX(n) AS n FROM chain_epochs WHERE signature IS NOT NULL").get()?.n ?? null;
    const unposted = this.c.db
      .query<{ n: number }, []>("SELECT e.n FROM epochs e LEFT JOIN chain_epochs c ON c.n = e.n WHERE e.status = 'closed' AND c.signature IS NULL ORDER BY e.n")
      .all()
      .map((r) => r.n);
    for (const o of open)
      this.c.db
        .query("UPDATE chain_deployments SET retired_at = ?, through_epoch = ?, last_posted_epoch = ?, unposted_epochs = ?, label = COALESCE(label, ?) WHERE registry_program = ?")
        .run(now, closed, posted, JSON.stringify(unposted), deploymentLabel(o.registry_program), o.registry_program);
    if (cur) this.c.db.query("UPDATE chain_deployments SET retired_at = NULL WHERE registry_program = ?").run(d.registry_program);
    else
      this.c.db
        .query("INSERT INTO chain_deployments (registry_program, launch_program, line_mint, label, first_seen_at) VALUES (?, ?, ?, ?, ?)")
        .run(d.registry_program, d.launch_program, d.line_mint, d.label ?? deploymentLabel(d.registry_program), now);
    this.through = undefined;
    const switched = open.map((o) => this.c.db.query<DeploymentRow, [string]>("SELECT * FROM chain_deployments WHERE registry_program = ?").get(o.registry_program)!);
    const agents = switched.length ? this.retireAgents(switched[switched.length - 1]!, now) : [];
    // no bond and no vault of the earlier registry counts on this one: zero until this registry's are read
    if (switched.length) this.c.chainAbsentAgents(new Set());
    for (const s of switched)
      this.c.emitEvent("chain.deployment_retired", { registry_program: s.registry_program, through_epoch: s.through_epoch, last_posted_epoch: s.last_posted_epoch,
        unposted_epochs: JSON.parse(s.unposted_epochs ?? "[]"), current: d.registry_program, closed_open_epoch: closedOpen, next_epoch: this.c.currentEpoch().n, retired_agents: agents });
    return { switched };
  }

  /** Records every launched agent as retired with `dep` and hides its token; returns their ids. */
  private retireAgents(dep: DeploymentRow, now: number): string[] {
    const rows = this.c.db
      .query<{ agent_id: string; mint: string | null }, []>("SELECT agent_id, mint FROM agents WHERE kind = 'launched' AND shadow = 0 AND agent_id NOT IN (SELECT agent_id FROM retired_agents) ORDER BY agent_id")
      .all();
    if (!rows.length) return [];
    const ins = this.c.db.query("INSERT OR IGNORE INTO retired_agents (agent_id, mint, registry_program, label, retired_at) VALUES (?, ?, ?, ?, ?)");
    for (const r of rows) ins.run(r.agent_id, r.mint, dep.registry_program, dep.label, now);
    this.retired = undefined; // the zeroing that follows puts each of them to sleep (Core.refreshAwake)
    // out of the listings (hidden.ts); a token the admin already hid keeps the admin's reason
    const hidden = hiddenOf(this.core);
    const already = hidden.mints();
    const add = rows.filter((r) => r.mint && B58.test(r.mint) && !already.has(r.mint)).map((r) => ({ mint: r.mint!, reason: retiredReason(dep) }));
    for (let i = 0; i < add.length; i += 500) hidden.edit(RETIRED_BY, { add: add.slice(i, i + 500) });
    return rows.map((r) => r.agent_id);
  }

  private retiredMap(): Map<string, RetiredAgent> {
    if (this.retired) return this.retired;
    this.c.db.exec(SCHEMA);
    return (this.retired = new Map(this.c.db.query<RetiredAgent, []>("SELECT * FROM retired_agents").all().map((r) => [r.agent_id, r])));
  }

  /** True for an agent of a retired deployment the current registry does not carry: it sleeps and earns nothing. */
  isRetired(agent: string): boolean {
    return this.retiredMap().has(agent);
  }

  /** The retired marker an agent's detail carries, or null. */
  retiredOf(agent: string): RetiredAgent | null {
    return this.retiredMap().get(agent) ?? null;
  }

  /** Retired agents and what they authored (kept in the database, left out of the public counts). */
  retiredCounts(): { agents: number; generations: number; candidates: number } {
    const n = this.retiredMap().size;
    if (!n) return { agents: 0, generations: 0, candidates: 0 };
    const one = (sql: string) => this.c.db.query<{ c: number }, []>(sql).get()!.c;
    return {
      agents: n,
      generations: one("SELECT COUNT(*) AS c FROM generations WHERE entry_type = 'patch' AND author IN (SELECT agent_id FROM retired_agents)"),
      candidates: one("SELECT COUNT(*) AS c FROM candidates WHERE author IN (SELECT agent_id FROM retired_agents)"),
    };
  }

  /**
   * The current registry carries `agent` as a launched agent (the bridge read its launch): no longer
   * retired. Its hidden entry goes with it when the token is the same one and this module hid it.
   */
  carried(agent: string, mint: string) {
    const r = this.retiredMap().get(agent);
    if (!r) return false;
    this.c.db.query("DELETE FROM retired_agents WHERE agent_id = ?").run(agent);
    this.retired = undefined;
    if (r.mint === mint && this.c.db.query("SELECT 1 FROM hidden_mints WHERE mint = ? AND added_by = ?").get(mint, RETIRED_BY)) hiddenOf(this.core).edit(RETIRED_BY, { remove: [mint] });
    this.c.emitEvent("agent.carried", { agent, mint, from: r.registry_program });
    return true;
  }

  /**
   * An earlier registry Core read before this module existed (devnet v1 on the site): recorded as
   * retired at `current`'s first sighting, with the epochs closed before then. No-op when known.
   */
  recordEarlier(d: { registry_program: string; launch_program: string; line_mint: string | null; label: string }, current: string): DeploymentRow | null {
    this.c.db.exec(SCHEMA);
    if (this.c.db.query("SELECT 1 FROM chain_deployments WHERE registry_program = ?").get(d.registry_program)) return null;
    const cur = this.c.db.query<DeploymentRow, [string]>("SELECT * FROM chain_deployments WHERE registry_program = ?").get(current);
    if (!cur) return null;
    const at = cur.first_seen_at;
    const closed = this.c.db.query<{ n: number | null }, [number]>("SELECT MAX(n) AS n FROM epochs WHERE status != 'open' AND closed_at <= ?").get(at)?.n ?? null;
    if (closed === null) return null;
    const posted = this.c.db.query<{ n: number | null }, [number]>("SELECT MAX(n) AS n FROM chain_epochs WHERE signature IS NOT NULL AND n <= ?").get(closed)?.n ?? null;
    const unposted = this.c.db
      .query<{ n: number }, [number]>("SELECT e.n FROM epochs e LEFT JOIN chain_epochs c ON c.n = e.n WHERE e.status = 'closed' AND c.signature IS NULL AND e.n <= ? ORDER BY e.n")
      .all(closed)
      .map((r) => r.n);
    this.c.db
      .query("INSERT INTO chain_deployments (registry_program, launch_program, line_mint, label, first_seen_at, retired_at, through_epoch, last_posted_epoch, unposted_epochs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(d.registry_program, d.launch_program, d.line_mint, d.label, at, at, closed, posted, JSON.stringify(unposted));
    this.through = undefined;
    const row = this.c.db.query<DeploymentRow, [string]>("SELECT * FROM chain_deployments WHERE registry_program = ?").get(d.registry_program)!;
    this.c.emitEvent("chain.deployment_retired", { registry_program: d.registry_program, through_epoch: closed, last_posted_epoch: posted, unposted_epochs: unposted, current, backfilled: true });
    return row;
  }

  /**
   * The last epoch any retired registry carries (null when none was retired). Epochs at or before it
   * are history: not posted again, not mirrored for claims, not counted against the current vaults.
   */
  retiredThrough(): number | null {
    if (this.through !== undefined) return this.through;
    this.c.db.exec(SCHEMA);
    const r = this.c.db.query<{ n: number | null }, []>("SELECT MAX(through_epoch) AS n FROM chain_deployments WHERE retired_at IS NOT NULL").get();
    return (this.through = r?.n ?? null);
  }

  list(): { deployments: DeploymentRow[] } {
    this.c.db.exec(SCHEMA);
    return { deployments: this.c.db.query<DeploymentRow, []>("SELECT * FROM chain_deployments ORDER BY first_seen_at").all() };
  }

  /** A relaunch under the same agent key: the bridge saw a new mint for an agent Core knew. */
  recordRelaunch(agent: string, oldMint: string, newMint: string) {
    this.c.db.exec(SCHEMA);
    const retired = this.c.db.query<DeploymentRow, []>("SELECT * FROM chain_deployments WHERE retired_at IS NOT NULL ORDER BY retired_at DESC LIMIT 1").get();
    const label = retired?.label ?? DEVNET_V1.label;
    this.c.db
      .query("INSERT OR IGNORE INTO agent_previous_tokens (agent_id, mint, previous_agent_id, venue, deployment, note, recorded_at, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, 'chain')")
      .run(agent, oldMint, agent, DEVNET_V1.venue, label, `relaunched on pump.fun as ${newMint}`, this.c.now());
    this.c.emitEvent("agent.relaunched", { agent, previous_mint: oldMint, mint: newMint, deployment: label });
  }

  /**
   * POST /v1/admin/agent-previous { agent, previous_agent, previous_mint, venue?, deployment?, note? }:
   * links a relaunch under a new agent key to the earlier agent and its token.
   */
  link(by: string, body: unknown) {
    const b = (body ?? {}) as Record<string, unknown>;
    for (const k of ["agent", "previous_agent", "previous_mint"]) if (typeof b[k] !== "string" || !B58.test(b[k] as string)) throw bad("bad_request", `${k} must be a base58 address`);
    const venue = typeof b.venue === "string" && b.venue ? b.venue.slice(0, 32) : DEVNET_V1.venue;
    const deployment = typeof b.deployment === "string" && b.deployment ? b.deployment.slice(0, 64) : DEVNET_V1.label;
    const note = typeof b.note === "string" ? b.note.slice(0, 280) : null;
    if (b.agent === b.previous_agent) throw bad("bad_request", "a relaunch under the same agent key is recorded by the bridge");
    this.c.db.exec(SCHEMA);
    this.c.db
      .query(`INSERT INTO agent_previous_tokens (agent_id, mint, previous_agent_id, venue, deployment, note, recorded_at, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(agent_id, mint) DO UPDATE SET previous_agent_id = excluded.previous_agent_id, venue = excluded.venue, deployment = excluded.deployment, note = excluded.note`)
      .run(b.agent as string, b.previous_mint as string, b.previous_agent as string, venue, deployment, note, this.c.now(), by);
    this.c.emitEvent("agent.previous_linked", { agent: b.agent, previous_agent: b.previous_agent, previous_mint: b.previous_mint, deployment });
    return { agent: b.agent, previous: this.previousOf(b.agent as string) };
  }

  /** An agent's earlier tokens, newest first. */
  previousOf(agent: string): PreviousToken[] {
    this.c.db.exec(SCHEMA);
    return this.c.db
      .query<PreviousToken, [string]>("SELECT mint, previous_agent_id, venue, deployment, note, recorded_at FROM agent_previous_tokens WHERE agent_id = ? ORDER BY recorded_at DESC")
      .all(agent);
  }

  /** The agent that continues `agent` (a relaunch under a new key), if any. */
  successorOf(agent: string): string | null {
    this.c.db.exec(SCHEMA);
    return this.c.db.query<{ agent_id: string }, [string, string]>("SELECT agent_id FROM agent_previous_tokens WHERE previous_agent_id = ? AND agent_id != ? LIMIT 1").get(agent, agent)?.agent_id ?? null;
  }
}
