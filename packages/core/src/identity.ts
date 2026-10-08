import type { Core } from "./core.ts";
import { ApiError, bad, conflict, forbidden, notFound } from "./errors.ts";
import { base58Decode, verifyStatement } from "./protocol.ts";

// Agent keys (identity plan I1, SPEC 14.1 Agent v2, 17). The agent id is the public key that
// created the agent and never changes; the signing key is the key that currently speaks for it.
// Until the first rotation the signing key is the id itself, so agents that never rotate need no
// row here. In chain mode the registry `Agent.signing_key` is the source of truth (the bridge calls
// `syncChain`); in the simulated M1 mode `POST /v1/agents/:id/keys/rotate` rotates. A revoked key
// (onchain `Pubkey::default()`) is stored as a null signing key: Core refuses every request for the
// agent until a rotation. Rows are never deleted, so "which key was valid at time t" stays answerable
// for signatures Core stored earlier (calibration records, replay commits).

/** The parts of Core this module uses. */
interface Internals {
  db: Core["db"];
  chainMode: boolean;
  now(): number;
  emitEvent(type: string, data: unknown): void;
}

export interface KeyRow {
  agent_id: string;
  seq: number;
  /** null: revoked. */
  signing_key: string | null;
  valid_from: number;
  valid_to: number | null;
  source: "chain" | "ledger";
}

export const IDENTITY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS agent_keys (
    agent_id TEXT NOT NULL,
    seq INTEGER NOT NULL,                -- rotation counter (registry Agent.key_seq in chain mode)
    signing_key TEXT,                    -- null: revoked
    valid_from INTEGER NOT NULL,         -- ms
    valid_to INTEGER,                    -- ms, null while current
    source TEXT NOT NULL,                -- chain | ledger
    PRIMARY KEY (agent_id, seq)
  );
`;

const isKey = (s: unknown): s is string => {
  if (typeof s !== "string") return false;
  try {
    return base58Decode(s).length === 32;
  } catch {
    return false;
  }
};

export class Identity {
  private readonly c: Internals;
  constructor(core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(IDENTITY_SCHEMA);
    const cols = new Set(this.c.db.query<{ name: string }, []>("PRAGMA table_info(agents)").all().map((c) => c.name));
    // registry Agent.owner_since (unix s) and pending_owner, chain mode (two-step public owner transfer)
    if (!cols.has("chain_owner_since")) this.c.db.exec("ALTER TABLE agents ADD COLUMN chain_owner_since INTEGER");
    if (!cols.has("chain_pending_owner")) this.c.db.exec("ALTER TABLE agents ADD COLUMN chain_pending_owner TEXT");
  }

  private current(agent: string): KeyRow | null {
    return this.c.db.query<KeyRow, [string]>("SELECT * FROM agent_keys WHERE agent_id = ? ORDER BY seq DESC LIMIT 1").get(agent);
  }

  /** The key that currently authenticates for `agent`: the id itself until a rotation, null when revoked. */
  signingKey(agent: string): string | null {
    const row = this.current(agent);
    return row ? row.signing_key : agent;
  }

  /** The key that was valid for `agent` at `t` (ms): for checking a signature Core stored earlier. */
  keyAt(agent: string, t: number): string | null {
    const row = this.c.db
      .query<KeyRow, [string, number]>("SELECT * FROM agent_keys WHERE agent_id = ? AND valid_from <= ? ORDER BY seq DESC LIMIT 1")
      .get(agent, t);
    if (row) return row.signing_key;
    const first = this.c.db.query<KeyRow, [string]>("SELECT * FROM agent_keys WHERE agent_id = ? ORDER BY seq LIMIT 1").get(agent);
    return first ? (first.seq === 0 ? first.signing_key : agent) : agent;
  }

  /** Public key history, oldest first (seq 0 is the agent id). */
  history(agent: string) {
    const rows = this.c.db.query<KeyRow, [string]>("SELECT * FROM agent_keys WHERE agent_id = ? ORDER BY seq").all(agent);
    const cur = rows.length ? rows[rows.length - 1]! : null;
    return {
      agent,
      signing_key: cur ? cur.signing_key : agent,
      revoked: !!cur && cur.signing_key === null,
      seq: cur ? cur.seq : 0,
      keys: rows.length ? rows.map(({ agent_id: _, ...r }) => r) : [{ seq: 0, signing_key: agent, valid_from: null, valid_to: null, source: "registration" }],
    };
  }

  /** Records a change of the signing key at `seq` (closing the current row; seq 0 is written first). */
  private record(agent: string, seq: number, key: string | null, at: number, source: KeyRow["source"]) {
    const cur = this.current(agent);
    if (!cur) this.c.db.query("INSERT INTO agent_keys (agent_id, seq, signing_key, valid_from, valid_to, source) VALUES (?, 0, ?, 0, NULL, ?)").run(agent, agent, source);
    this.c.db.query("UPDATE agent_keys SET valid_to = ? WHERE agent_id = ? AND valid_to IS NULL").run(at, agent);
    this.c.db.query("INSERT INTO agent_keys (agent_id, seq, signing_key, valid_from, valid_to, source) VALUES (?, ?, ?, ?, NULL, ?)").run(agent, seq, key, at, source);
    this.c.emitEvent(key === null ? "agent.key_revoked" : "agent.key_rotated", { agent, seq, signing_key: key, source });
  }

  /**
   * Chain mode: mirrors the registry's `signing_key` / `key_seq`. Several rotations between two
   * polls show as one step to the latest key (the seq still jumps by their count).
   */
  syncChain(agent: string, signingKey: string | null, seq: number, changedAt: bigint) {
    const curSeq = this.current(agent)?.seq ?? 0;
    if (seq === curSeq && (seq > 0 || signingKey === agent)) return false;
    if (seq < curSeq) return false; // never move backwards (an older RPC answer)
    const at = changedAt > 0n ? Number(changedAt) * 1000 : this.c.now();
    this.record(agent, seq, signingKey, at, "chain");
    return true;
  }

  /** Chain mode: mirrors the registry owner, `owner_since` and a pending transfer. */
  syncOwner(agent: string, owner: string, ownerSince: bigint, pending: string | null) {
    const row = this.c.db
      .query<{ chain_owner: string | null; chain_owner_since: number | null; chain_pending_owner: string | null }, [string]>(
        "SELECT chain_owner, chain_owner_since, chain_pending_owner FROM agents WHERE agent_id = ?",
      )
      .get(agent);
    if (!row) return;
    const since = Number(ownerSince);
    if (row.chain_owner === owner && row.chain_owner_since === since && row.chain_pending_owner === pending) return;
    this.c.db.query("UPDATE agents SET chain_owner = ?, chain_owner_since = ?, chain_pending_owner = ? WHERE agent_id = ?").run(owner, since, pending, agent);
    if (row.chain_owner && row.chain_owner !== owner) this.c.emitEvent("agent.owner_changed", { agent, old: row.chain_owner, owner, owner_since: since * 1000 });
    else if (pending && pending !== row.chain_pending_owner) this.c.emitEvent("agent.owner_proposed", { agent, owner, proposed: pending });
  }

  /** Who controls the agent and since when (ms): the registry owner in chain mode, the launcher otherwise. */
  controller(agent: string, registeredAt: number): { owner: string | null; since: number; pending_owner: string | null } {
    const a = this.c.db
      .query<{ chain_owner: string | null; chain_owner_since: number | null; chain_pending_owner: string | null; launcher: string | null }, [string]>(
        "SELECT chain_owner, chain_owner_since, chain_pending_owner, launcher FROM agents WHERE agent_id = ?",
      )
      .get(agent);
    return {
      owner: a?.chain_owner ?? a?.launcher ?? null,
      since: a?.chain_owner_since ? a.chain_owner_since * 1000 : registeredAt,
      pending_owner: a?.chain_pending_owner ?? null,
    };
  }

  /** The public identity block of an agent view. */
  view(agent: string, registeredAt: number) {
    const h = this.history(agent);
    const c = this.controller(agent, registeredAt);
    return { signing_key: h.signing_key, revoked: h.revoked, key_seq: h.seq, owner: c.owner, controller_since: c.since, pending_owner: c.pending_owner };
  }

  /**
   * M1 (simulated mode) rotation, signed by the current key (the request) and by the new key:
   * `new_key_sig = signStatement(newKey, "rotate", { agent, new_key, seq })` with `seq` the next
   * sequence number, so a signature cannot be replayed for a later rotation. Chain mode: 409
   * `use_chain` (the owner and the new key sign `rotate_agent_key`).
   */
  rotate(caller: string, agent: string, body: unknown) {
    if (this.c.chainMode) throw conflict("use_chain", "key rotation happens on chain in chain mode (registry rotate_agent_key, signed by the owner and the new key)");
    if (caller !== agent) throw forbidden("not_self", "agents may only act on themselves");
    if (!this.c.db.query("SELECT 1 FROM agents WHERE agent_id = ?").get(agent)) throw notFound("agent");
    const b = (body ?? {}) as { new_key?: unknown; new_key_sig?: unknown };
    if (!isKey(b.new_key)) throw bad("bad_key", "new_key must be a base58 ed25519 public key");
    if (typeof b.new_key_sig !== "string") throw bad("bad_sig", "new_key_sig is required");
    const seq = (this.current(agent)?.seq ?? 0) + 1;
    if (!verifyStatement(b.new_key, b.new_key_sig, "rotate", { agent, new_key: b.new_key, seq }))
      throw new ApiError(403, "bad_new_key_sig", `new_key_sig must be signStatement(new key, "rotate", { agent, new_key, seq: ${seq} })`);
    this.record(agent, seq, b.new_key, this.c.now(), "ledger");
    return this.history(agent);
  }
}
