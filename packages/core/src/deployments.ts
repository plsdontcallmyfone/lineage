import type { Core } from "./core.ts";
import { bad } from "./errors.ts";

// Chain deployments (devnet v2, 2026-10-10; onchain/DEVNET.md "Devnet v2"). Devnet moved to pump.fun
// with a fresh deployment of the three programs at new ids, bound to the pump.fun tLINE. Core keeps
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
);`;

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface Internals {
  db: Core["db"];
  now(): number;
  emitEvent(type: string, data: unknown): void;
}

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
export function deploymentsOf(core: Core): Deployments {
  let d = instances.get(core);
  if (!d) instances.set(core, (d = new Deployments(core)));
  return d;
}

/** What the earlier devnet deployment is called wherever a previous token is shown. */
export const DEVNET_V1 = { label: "devnet v1", venue: "meteora" };

export class Deployments {
  private readonly c: Internals;
  private through: number | null | undefined;
  constructor(core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(SCHEMA);
  }

  /**
   * The bridge calls this on every sync with the registry it reads. The first registry seen is
   * recorded; a different one retires every earlier one (once), closing out its epochs.
   */
  observe(d: { registry_program: string; launch_program: string; line_mint: string | null; label?: string | null }): { switched: DeploymentRow[] } {
    this.c.db.exec(SCHEMA);
    const cur = this.c.db.query<DeploymentRow, [string]>("SELECT * FROM chain_deployments WHERE registry_program = ?").get(d.registry_program);
    if (cur && cur.retired_at === null) return { switched: [] };
    const now = this.c.now();
    const open = this.c.db.query<DeploymentRow, [string]>("SELECT * FROM chain_deployments WHERE retired_at IS NULL AND registry_program != ?").all(d.registry_program);
    const closed = this.c.db.query<{ n: number | null }, []>("SELECT MAX(n) AS n FROM epochs WHERE status != 'open'").get()?.n ?? null;
    const posted = this.c.db.query<{ n: number | null }, []>("SELECT MAX(n) AS n FROM chain_epochs WHERE signature IS NOT NULL").get()?.n ?? null;
    const unposted = this.c.db
      .query<{ n: number }, []>("SELECT e.n FROM epochs e LEFT JOIN chain_epochs c ON c.n = e.n WHERE e.status = 'closed' AND c.signature IS NULL ORDER BY e.n")
      .all()
      .map((r) => r.n);
    for (const o of open)
      this.c.db
        .query("UPDATE chain_deployments SET retired_at = ?, through_epoch = ?, last_posted_epoch = ?, unposted_epochs = ? WHERE registry_program = ?")
        .run(now, closed, posted, JSON.stringify(unposted), o.registry_program);
    if (cur) this.c.db.query("UPDATE chain_deployments SET retired_at = NULL WHERE registry_program = ?").run(d.registry_program);
    else
      this.c.db
        .query("INSERT INTO chain_deployments (registry_program, launch_program, line_mint, label, first_seen_at) VALUES (?, ?, ?, ?, ?)")
        .run(d.registry_program, d.launch_program, d.line_mint, d.label ?? null, now);
    this.through = undefined;
    const switched = open.map((o) => this.c.db.query<DeploymentRow, [string]>("SELECT * FROM chain_deployments WHERE registry_program = ?").get(o.registry_program)!);
    for (const s of switched)
      this.c.emitEvent("chain.deployment_retired", { registry_program: s.registry_program, through_epoch: s.through_epoch, last_posted_epoch: s.last_posted_epoch,
        unposted_epochs: JSON.parse(s.unposted_epochs ?? "[]"), current: d.registry_program });
    return { switched };
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
    return this.c.db.query<{ agent_id: string }, [string]>("SELECT agent_id FROM agent_previous_tokens WHERE previous_agent_id = ? AND agent_id != ? LIMIT 1").get(agent, agent)?.agent_id ?? null;
  }
}
