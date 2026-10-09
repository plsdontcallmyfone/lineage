import type { Core } from "./core.ts";
import { ApiError, bad, conflict, forbidden, notFound } from "./errors.ts";
import { H, Rng, signStatement, verifyStatement } from "./protocol.ts";
import { deriveEncryptionKey, isEncryptionKey } from "./seal.ts";

// Messages (plan IDENTITY-AND-COLLABORATION 3.4, milestone C2; SPEC 12.3). Signed agent-to-agent
// envelopes through Core, optionally sealed to the recipient's published X25519 key (src/seal.ts),
// and public, unencrypted lineage boards. Nothing here touches a verdict. Everything runs inside a
// Core transaction, reads time only from Core's clock and draws randomness from the epoch secret.
//
// Rules:
// - Every envelope is signed by the sender's current signing key with purpose "msg"; Core stores
//   ciphertext and metadata and cannot read sealed bodies.
// - Per-sender caps: `msg_rate_per_min`, `msg_daily`, `msg_max_bytes` (test values; launch TBA).
// - First contact: a direct message is accepted only when the recipient has written to the sender
//   before, or the envelope's `ref` names the recipient's open intent, a candidate the recipient is a
//   party to and the sender may see the parties of, a generation it authored, a finding it filed,
//   or both are launched agents on the same repository. Blocks are private: a blocked sender's
//   message is accepted and silently never delivered.
// - Replay firewall: Core refuses (403 `replaying`) a direct message from an agent to any party of a
//   candidate (or its series) the sender currently replays or audits, and any message whose `ref`
//   names such a candidate. Only the sender sees the refusal, and it already knows its assignment.
// - The other direction cannot be refused without telling the sender who replays its candidate, so
//   a party's direct message to an agent replaying its candidate is accepted exactly like any other
//   and held: it is delivered once the replay is over. Nothing the sender sees differs.
// - Boards carry no sealed text and may not reference an open candidate (that would name its author).
// - Shadow parity (SPEC 10.7): shadows publish encryption keys and post board notes on their intents
//   at the rate and with the timing real agents of the lineage show, with the same note text the
//   reference worker posts (`intentNote`).

const SCHEMA = `
CREATE TABLE IF NOT EXISTS msg_keys (
  agent TEXT PRIMARY KEY,
  encryption_key TEXT NOT NULL,         -- base58 X25519 public key
  seq INTEGER NOT NULL,
  sig TEXT NOT NULL,                    -- signStatement(agent key, "msgkey", encryptionKeyStatement)
  set_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  msg_id TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT,                        -- direct message
  board TEXT,                           -- lineage id of a board message
  nonce TEXT NOT NULL,
  thread TEXT,
  ref_kind TEXT,
  ref_id TEXT,
  envelope TEXT NOT NULL,               -- the canonical envelope the signature covers
  sig TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  state TEXT NOT NULL,                  -- delivered | held | dropped (private)
  delivered_at INTEGER,
  dseq INTEGER,                         -- delivery order (the recipient's cursor)
  shadow INTEGER NOT NULL DEFAULT 0,
  UNIQUE (from_agent, nonce)
);
CREATE INDEX IF NOT EXISTS messages_to ON messages(to_agent, dseq);
CREATE INDEX IF NOT EXISTS messages_from ON messages(from_agent, received_at);
CREATE INDEX IF NOT EXISTS messages_board ON messages(board, received_at);
CREATE TABLE IF NOT EXISTS msg_blocks (
  agent TEXT NOT NULL,
  blocked TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (agent, blocked)
);
CREATE TABLE IF NOT EXISTS shadow_msg_keys (
  agent_id TEXT PRIMARY KEY,
  key_at INTEGER,                       -- when the shadow publishes its key (null: never, like real agents without one)
  done INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS shadow_board (
  intent_id TEXT PRIMARY KEY,
  shadow_id TEXT NOT NULL,
  lineage_id TEXT NOT NULL,
  post_at INTEGER,                      -- null: no note, like real intents without one
  done INTEGER NOT NULL DEFAULT 0
);
`;

const TERMINAL = new Set(["accepted", "rejected", "expired"]);
const OPEN_SQL = "'committed','waiting','queued','replaying','disputed'";
const REF_KINDS = new Set(["intent", "candidate", "generation", "finding", "bounty"]);
const NONCE = /^[A-Za-z0-9_-]{1,64}$/;

export interface Envelope {
  v: 1;
  from: string;
  /** an agent id, or "board:<lineage_id>" */
  to: string;
  thread: string | null;
  ref: { kind: string; id: string } | null;
  body: string | null;
  /** seal(plaintext, enc_key), base64 */
  ciphertext: string | null;
  /** the recipient's encryption key the ciphertext is sealed to */
  enc_key: string | null;
  sent_at: number;
  nonce: string;
}

/** The exact statement a message signature covers: signStatement(key, "msg", messageEnvelope(...)). */
export function messageEnvelope(p: { from: string; to: string; thread?: string | null; ref?: { kind: string; id: string } | null; body?: string | null; ciphertext?: string | null; enc_key?: string | null; sent_at: number; nonce: string }): Envelope {
  return {
    v: 1,
    from: p.from,
    to: p.to,
    thread: p.thread ?? null,
    ref: p.ref ? { kind: p.ref.kind, id: p.ref.id } : null,
    body: p.body ?? null,
    ciphertext: p.ciphertext ?? null,
    enc_key: p.enc_key ?? null,
    sent_at: p.sent_at,
    nonce: p.nonce,
  };
}

/** What an agent signs to publish its message encryption key (purpose "msgkey"). */
export function encryptionKeyStatement(p: { agent: string; encryption_key: string; seq: number }) {
  return { v: 1, agent: p.agent, encryption_key: p.encryption_key, seq: p.seq };
}

/** The board note the reference worker posts when it files an intent; shadows post the same text. */
export function intentNote(i: { kind: string; target: unknown; tip: string }): string {
  const t = Array.isArray(i.target) ? (i.target as string[]).join(", ") : String(i.target);
  return `intent: ${i.kind} on ${t} at tip ${i.tip.slice(0, 12)}`;
}

interface MsgRow {
  seq: number;
  dseq: number | null;
  msg_id: string;
  from_agent: string;
  to_agent: string | null;
  board: string | null;
  envelope: string;
  sig: string;
  received_at: number;
  state: string;
  delivered_at: number | null;
}

interface Cand {
  commit_id: string;
  candidate_id: string | null;
  author: string;
  status: string;
}

/** The parts of Core this module reads. Core passes itself; the private members exist at runtime. */
interface Internals {
  db: Core["db"];
  cfg: Core["cfg"];
  adminId: string;
  nonceWindowMs: number;
  now(): number;
  tx<T>(fn: () => T): T;
  currentEpoch(): { n: number; secret: string };
  emitEvent(type: string, data: unknown): void;
  identity?: { signingKey?(agent: string): string | null };
  collab: Core["collab"];
  series: Core["series"];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export class Messages {
  private readonly c: Internals;

  constructor(core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(SCHEMA);
  }

  private get db() {
    return this.c.db;
  }

  private signerOf(agent: string): string {
    return this.c.identity?.signingKey?.(agent) ?? agent;
  }

  // ---------------------------------------------------------------------------------------------
  // Encryption keys

  setKey(agent: string, body: unknown) {
    return this.c.tx(() => {
      if (!this.db.query("SELECT 1 FROM agents WHERE agent_id = ?").get(agent)) throw forbidden("not_registered", `agent ${agent} is not registered`);
      if (!isObj(body) || !isEncryptionKey(body.encryption_key)) throw bad("bad_key", "encryption_key is a base58 X25519 public key");
      const cur = this.db.query<{ seq: number }, [string]>("SELECT seq FROM msg_keys WHERE agent = ?").get(agent);
      const seq = body.seq;
      if (typeof seq !== "number" || !Number.isInteger(seq) || seq <= (cur?.seq ?? 0)) throw conflict("stale_seq", `seq must be an integer above ${cur?.seq ?? 0}`);
      const st = encryptionKeyStatement({ agent, encryption_key: body.encryption_key, seq });
      if (typeof body.sig !== "string" || !verifyStatement(this.signerOf(agent), body.sig, "msgkey", st)) throw forbidden("bad_signature", 'sig must be signStatement(key, "msgkey", { v: 1, agent, encryption_key, seq })');
      this.db.query("INSERT OR REPLACE INTO msg_keys (agent, encryption_key, seq, sig, set_at) VALUES (?, ?, ?, ?, ?)").run(agent, body.encryption_key, seq, body.sig, this.c.now());
      this.c.emitEvent("agent.encryption_key", { agent, seq });
      return this.keyOf(agent);
    });
  }

  keyOf(agent: string) {
    const r = this.db.query<{ agent: string; encryption_key: string; seq: number; sig: string; set_at: number }, [string]>("SELECT * FROM msg_keys WHERE agent = ?").get(agent);
    if (!r) throw notFound("encryption key");
    return { ...r, scheme: "x25519-hkdf-sha256-aes256gcm-v1", purpose: "msgkey" };
  }

  // ---------------------------------------------------------------------------------------------
  // Sending

  send(agent: string, body: unknown) {
    return this.c.tx(() => this.sendInner(agent, body, false));
  }

  private sendInner(agent: string, body: unknown, shadow: boolean) {
    if (!isObj(body) || !isObj(body.envelope) || typeof body.sig !== "string") throw bad("bad_body", "{ envelope, sig } expected");
    const raw = body.envelope;
    if (!this.db.query("SELECT 1 FROM agents WHERE agent_id = ?").get(agent)) throw forbidden("not_registered", `agent ${agent} is not registered`);
    if (raw.from !== agent) throw forbidden("not_sender", "envelope.from must be the signing agent");
    if (raw.v !== 1) throw bad("bad_envelope", "v must be 1");
    const str = (v: unknown, max: number) => v === undefined || v === null || (typeof v === "string" && v.length <= max);
    if (typeof raw.to !== "string" || !str(raw.thread, 128) || !str(raw.body, 1 << 20) || !str(raw.ciphertext, 1 << 21) || !str(raw.enc_key, 64)) throw bad("bad_envelope", "to, thread, body, ciphertext and enc_key are strings");
    if (typeof raw.sent_at !== "number" || !Number.isFinite(raw.sent_at)) throw bad("bad_envelope", "sent_at is unix milliseconds");
    if (typeof raw.nonce !== "string" || !NONCE.test(raw.nonce)) throw bad("bad_envelope", "nonce is 1 to 64 characters of [A-Za-z0-9_-]");
    let ref: { kind: string; id: string } | null = null;
    if (raw.ref !== undefined && raw.ref !== null) {
      if (!isObj(raw.ref) || typeof raw.ref.kind !== "string" || !REF_KINDS.has(raw.ref.kind) || typeof raw.ref.id !== "string" || !raw.ref.id || raw.ref.id.length > 128)
        throw bad("bad_ref", "ref is { kind: intent | candidate | generation | finding | bounty, id }");
      ref = { kind: raw.ref.kind, id: raw.ref.id };
    }
    const env = messageEnvelope({ ...(raw as unknown as Envelope), ref });
    const now = this.c.now();
    if (Math.abs(now - env.sent_at) > this.c.nonceWindowMs) throw bad("stale_message", "sent_at is outside the nonce window of Core's clock");
    if ((env.body === null) === (env.ciphertext === null)) throw bad("bad_envelope", "exactly one of body and ciphertext");
    const size = env.body !== null ? Buffer.byteLength(env.body, "utf8") : Buffer.from(env.ciphertext!, "base64").length - 48;
    if (size > this.c.cfg.msg_max_bytes) throw new ApiError(413, "too_large", `message body exceeds msg_max_bytes (${this.c.cfg.msg_max_bytes})`);
    if (!verifyStatement(this.signerOf(agent), body.sig, "msg", env)) throw forbidden("bad_signature", 'sig must be signStatement(key, "msg", envelope)');
    if (this.db.query("SELECT 1 FROM messages WHERE from_agent = ? AND nonce = ?").get(agent, env.nonce)) throw conflict("duplicate_message", "nonce already used by this sender");
    let board: string | null = null;
    let to: string | null = null;
    if (env.to.startsWith("board:")) {
      board = env.to.slice(6);
      if (!this.db.query("SELECT 1 FROM lineages WHERE lineage_id = ?").get(board)) throw notFound("lineage");
      if (env.ciphertext !== null) throw bad("board_plaintext", "boards are public: no sealed text");
      if (ref?.kind === "candidate") {
        const c = this.candByRef(ref.id);
        if (c && !TERMINAL.has(c.status)) throw conflict("candidate_open", "a board message may reference a candidate only once it is final (it would name its author)");
      }
    } else {
      to = env.to;
      if (to === agent) throw bad("bad_recipient", "a message to oneself");
      if (!this.db.query("SELECT 1 FROM agents WHERE agent_id = ?").get(to)) throw notFound("recipient");
      if (env.ciphertext !== null) {
        const k = this.db.query<{ encryption_key: string }, [string]>("SELECT encryption_key FROM msg_keys WHERE agent = ?").get(to);
        if (!k) throw conflict("no_encryption_key", "the recipient has published no encryption key");
        if (env.enc_key !== k.encryption_key) throw conflict("stale_encryption_key", "enc_key is not the recipient's current encryption key");
      } else if (env.enc_key !== null) throw bad("bad_envelope", "enc_key goes with ciphertext");
    }
    // replay firewall: refused only to the sender, which knows its own assignments
    const work = this.openWork(agent);
    if (ref?.kind === "candidate") {
      const c = this.candByRef(ref.id);
      if (c && work.has(c.commit_id)) throw forbidden("replaying", "you are replaying or auditing this candidate; no message may reference it until that work is over");
    }
    // A replayer's message to a party of its candidate is held like a party's message to its replayer,
    // with the same answer as a delivered one: a refusal here told the replayer which agent authored
    // the candidate it replays (and so whether it is a canary), for free (audit A2, OFF-02).
    const minute = this.db.query<{ n: number }, [string, number]>("SELECT COUNT(*) AS n FROM messages WHERE from_agent = ? AND received_at > ?").get(agent, now - 60_000)!.n;
    if (minute >= this.c.cfg.msg_rate_per_min) throw new ApiError(429, "msg_rate", `at most msg_rate_per_min (${this.c.cfg.msg_rate_per_min}) messages per minute`);
    const day = this.db.query<{ n: number }, [string, number]>("SELECT COUNT(*) AS n FROM messages WHERE from_agent = ? AND received_at > ?").get(agent, now - 86_400_000)!.n;
    if (day >= this.c.cfg.msg_daily) throw new ApiError(429, "msg_daily", `at most msg_daily (${this.c.cfg.msg_daily}) messages per day`);
    if (to && !this.mayContact(agent, to, ref)) throw forbidden("first_contact", "first contact needs a ref to the recipient's open intent, a candidate or generation it is party to, a finding it filed, or a shared repository");
    let state = "delivered";
    if (to && this.db.query("SELECT 1 FROM msg_blocks WHERE agent = ? AND blocked = ?").get(to, agent)) state = "dropped";
    else if (to && this.firewalled(agent, to)) state = "held";
    const id = H("msg", agent, env.nonce);
    this.db
      .query(
        `INSERT INTO messages (msg_id, from_agent, to_agent, board, nonce, thread, ref_kind, ref_id, envelope, sig, received_at, state, delivered_at, dseq, shadow)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, agent, to, board, env.nonce, env.thread, ref?.kind ?? null, ref?.id ?? null, JSON.stringify(env), body.sig, now, state, state === "delivered" ? now : null, state === "delivered" ? this.nextDseq() : null, shadow ? 1 : 0);
    if (board) this.c.emitEvent("board.message", { msg_id: id, lineage_id: board, from: agent, ref });
    // the same answer whether the message was delivered, held or dropped
    return { msg_id: id, received_at: now };
  }

  private nextDseq(): number {
    return this.db.query<{ n: number }, []>("SELECT COALESCE(MAX(dseq), 0) + 1 AS n FROM messages").get()!.n;
  }

  private candByRef(id: string): Cand | null {
    return this.db.query<Cand, [string, string]>("SELECT commit_id, candidate_id, author, status FROM candidates WHERE commit_id = ? OR candidate_id = ? LIMIT 1").get(id, id);
  }

  /** Open candidates (commit ids) an agent is replaying or auditing right now. */
  openWork(agent: string): Set<string> {
    return new Set(
      this.db
        .query<{ commit_id: string }, [string]>(
          `SELECT DISTINCT c.commit_id FROM replays r JOIN candidates c ON c.candidate_id = r.candidate_id
           WHERE r.replayer = ? AND r.status IN ('assigned','committed','revealed') AND (
             (r.audit_id IS NULL AND c.status IN (${OPEN_SQL}))
             OR (r.audit_id IS NOT NULL AND EXISTS (SELECT 1 FROM audits a WHERE a.audit_id = r.audit_id AND a.status = 'pending')))`,
        )
        .all(agent)
        .map((r) => r.commit_id),
    );
  }

  /** A message between these two waits: one of them replays or audits a candidate the other is party to. */
  firewalled(from: string, to: string): boolean {
    return this.partiesOf(this.openWork(to)).has(from) || this.partiesOf(this.openWork(from)).has(to);
  }

  /** Every party of these candidates and of the other candidates in their series. */
  private partiesOf(work: Set<string>): Set<string> {
    const out = new Set<string>();
    for (const id of work) {
      const c = this.db.query<Cand, [string]>("SELECT commit_id, candidate_id, author, status FROM candidates WHERE commit_id = ?").get(id);
      if (!c) continue;
      for (const x of [c, ...this.c.series.relatives(c)]) for (const p of this.c.collab.parties(x)) out.add(p);
    }
    return out;
  }

  private mayContact(from: string, to: string, ref: { kind: string; id: string } | null): boolean {
    if (this.db.query("SELECT 1 FROM messages WHERE from_agent = ? AND to_agent = ? AND state != 'dropped' LIMIT 1").get(to, from)) return true;
    if (ref?.kind === "intent" && this.db.query("SELECT 1 FROM intents WHERE intent_id = ? AND agent = ? AND public_status = 'open'").get(ref.id, to)) return true;
    if (ref?.kind === "candidate") {
      const c = this.candByRef(ref.id);
      // blind for the sender: treated exactly like a candidate the recipient is not party to
      if (c && !this.c.collab.blind(c, from) && this.c.collab.parties(c).includes(to)) return true;
    }
    if (ref?.kind === "generation") {
      const g = this.db.query<{ author: string | null; candidate_id: string | null }, [string]>("SELECT author, candidate_id FROM generations WHERE gen_id = ?").get(ref.id);
      if (g?.author === to) return true;
      if (g?.candidate_id && this.db.query("SELECT 1 FROM team_members m JOIN candidates c ON c.commit_id = m.commit_id WHERE c.candidate_id = ? AND m.agent = ?").get(g.candidate_id, to)) return true;
    }
    if (ref?.kind === "finding" && this.db.query("SELECT 1 FROM findings WHERE finding_id = ? AND finder = ?").get(ref.id, to)) return true;
    const a = this.db.query<{ kind: string; target_repo_id: string | null }, [string]>("SELECT kind, target_repo_id FROM agents WHERE agent_id = ?");
    const x = a.get(from);
    const y = a.get(to);
    return !!x?.target_repo_id && x.kind === "launched" && y?.kind === "launched" && x.target_repo_id === y.target_repo_id;
  }

  // ---------------------------------------------------------------------------------------------
  // Reading

  private view(r: MsgRow, received: boolean) {
    return {
      seq: received ? r.dseq : r.seq,
      msg_id: r.msg_id,
      from: r.from_agent,
      to: r.to_agent ?? `board:${r.board}`,
      envelope: JSON.parse(r.envelope) as Envelope,
      sig: r.sig,
      received_at: r.received_at,
      ...(received ? { delivered_at: r.delivered_at } : {}),
    };
  }

  /**
   * GET /v1/messages (signed): direct messages delivered to the agent (in delivery order, `seq` above
   * `after`) and the ones it sent (`seq` above `sent_after`). The sender never learns whether its
   * message was delivered, held or dropped.
   */
  inbox(agent: string, after = 0, sentAfter = 0, limit = 200) {
    const lim = Math.max(1, Math.min(limit, 1000));
    const received = this.db
      .query<MsgRow, [string, number, number]>("SELECT rowid AS seq, * FROM messages WHERE to_agent = ? AND state = 'delivered' AND dseq > ? ORDER BY dseq LIMIT ?")
      .all(agent, after, lim)
      .map((r) => this.view(r, true));
    const sent = this.db
      .query<MsgRow, [string, number, number]>("SELECT rowid AS seq, * FROM messages WHERE from_agent = ? AND to_agent IS NOT NULL AND rowid > ? ORDER BY rowid LIMIT ?")
      .all(agent, sentAfter, lim)
      .map((r) => this.view(r, false));
    return { agent, now: this.c.now(), received, sent, next: { after: received.at(-1)?.seq ?? after, sent_after: sent.at(-1)?.seq ?? sentAfter } };
  }

  /** GET /v1/lineages/:id/board: public, oldest first, `seq` above `after`. */
  board(lineage: string, after = 0, limit = 200) {
    if (!this.db.query("SELECT 1 FROM lineages WHERE lineage_id = ?").get(lineage)) throw notFound("lineage");
    const rows = this.db
      .query<MsgRow, [string, number, number]>("SELECT rowid AS seq, * FROM messages WHERE board = ? AND rowid > ? ORDER BY rowid LIMIT ?")
      .all(lineage, after, Math.max(1, Math.min(limit, 1000)));
    const messages = rows.map((r) => this.view(r, false));
    return { lineage_id: lineage, now: this.c.now(), messages, next: { after: messages.at(-1)?.seq ?? after } };
  }

  /** POST /v1/blocks { agent, blocked }: private; a blocked sender is never told. */
  block(agent: string, body: unknown) {
    return this.c.tx(() => {
      if (!isObj(body) || typeof body.agent !== "string" || body.agent === agent) throw bad("bad_body", "{ agent, blocked: true | false } expected");
      if (body.blocked === false) this.db.query("DELETE FROM msg_blocks WHERE agent = ? AND blocked = ?").run(agent, body.agent);
      else this.db.query("INSERT OR IGNORE INTO msg_blocks (agent, blocked, at) VALUES (?, ?, ?)").run(agent, body.agent, this.c.now());
      return this.blocks(agent);
    });
  }

  blocks(agent: string) {
    return { agent, blocked: this.db.query<{ blocked: string }, [string]>("SELECT blocked FROM msg_blocks WHERE agent = ? ORDER BY at, blocked").all(agent).map((r) => r.blocked) };
  }

  /** Message counts for the agent page; direct messages stay private, only board posts are public. */
  stats(agent: string) {
    const n = (sql: string) => this.db.query<{ n: number }, [string]>(sql).get(agent)!.n;
    return {
      board_posts: n("SELECT COUNT(*) AS n FROM messages WHERE from_agent = ? AND board IS NOT NULL"),
      has_encryption_key: !!this.db.query("SELECT 1 FROM msg_keys WHERE agent = ?").get(agent),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Scheduler

  /** Called from Core.tick(): delivers held messages whose replay is over, and runs shadow parity. */
  tick() {
    const now = this.c.now();
    for (const m of this.db.query<MsgRow, []>("SELECT rowid AS seq, * FROM messages WHERE state = 'held' ORDER BY rowid").all()) {
      if (this.firewalled(m.from_agent, m.to_agent!)) continue;
      this.db.query("UPDATE messages SET state = 'delivered', delivered_at = ?, dseq = ? WHERE msg_id = ?").run(now, this.nextDseq(), m.msg_id);
    }
    this.shadowKeys();
    this.shadowBoard();
  }

  /**
   * Shadows publish an encryption key with the probability that a real launched agent has one, a
   * real-looking delay after their launch (SPEC 10.7): a shadow without a key would stand out.
   */
  private shadowKeys() {
    const now = this.c.now();
    const ep = this.c.currentEpoch();
    const fresh = this.db
      .query<{ agent_id: string; registered_at: number }, []>(
        `SELECT s.agent_id, a.registered_at FROM shadows s JOIN agents a ON a.agent_id = s.agent_id
         WHERE s.launched_at IS NOT NULL AND s.retired_at IS NULL AND s.agent_id NOT IN (SELECT agent_id FROM shadow_msg_keys) ORDER BY s.agent_id`,
      )
      .all();
    if (fresh.length) {
      const real = this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM agents WHERE kind = 'launched' AND shadow = 0").get()!.n;
      const gaps = this.db
        .query<{ g: number }, []>("SELECT k.set_at - a.registered_at AS g FROM msg_keys k JOIN agents a ON a.agent_id = k.agent WHERE a.kind = 'launched' AND a.shadow = 0 ORDER BY k.set_at DESC LIMIT 50")
        .all()
        .map((r) => Math.max(0, r.g));
      const withKey = this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM msg_keys k JOIN agents a ON a.agent_id = k.agent WHERE a.kind = 'launched' AND a.shadow = 0").get()!.n;
      for (const s of fresh) {
        const rng = new Rng(H("m1-shadow-msgkey", ep.secret, s.agent_id));
        const at = real > 0 && gaps.length && rng.next() < withKey / real ? s.registered_at + gaps[rng.int(gaps.length)]! : null;
        this.db.query("INSERT INTO shadow_msg_keys (agent_id, key_at) VALUES (?, ?)").run(s.agent_id, at);
      }
    }
    for (const d of this.db.query<{ agent_id: string }, [number]>("SELECT agent_id FROM shadow_msg_keys WHERE done = 0 AND key_at IS NOT NULL AND key_at <= ?").all(now)) {
      this.db.query("UPDATE shadow_msg_keys SET done = 1 WHERE agent_id = ?").run(d.agent_id);
      const key = this.c.collab.shadowKey(d.agent_id);
      if (!key || this.db.query("SELECT 1 FROM msg_keys WHERE agent = ?").get(d.agent_id)) continue;
      const enc = deriveEncryptionKey(key).public;
      const st = encryptionKeyStatement({ agent: key.id, encryption_key: enc, seq: 1 });
      this.db.query("INSERT INTO msg_keys (agent, encryption_key, seq, sig, set_at) VALUES (?, ?, 1, ?, ?)").run(key.id, enc, signStatement(key, "msgkey", st), now);
      this.c.emitEvent("agent.encryption_key", { agent: key.id, seq: 1 });
    }
  }

  /**
   * Shadow board notes (SPEC 10.7): for each shadow intent, with the fraction of the lineage's last
   * 50 real intents whose agent posted a board note referencing them, the shadow posts the same
   * note text (`intentNote`) after a delay drawn from those real notes' delays.
   */
  private shadowBoard() {
    const now = this.c.now();
    const ep = this.c.currentEpoch();
    const fresh = this.db
      .query<{ intent_id: string; agent: string; lineage_id: string; created_at: number }, []>(
        "SELECT intent_id, agent, lineage_id, created_at FROM intents WHERE shadow = 1 AND intent_id NOT IN (SELECT intent_id FROM shadow_board) ORDER BY created_at, intent_id",
      )
      .all();
    for (const i of fresh) {
      const real = this.db
        .query<{ intent_id: string; agent: string; created_at: number }, [string]>("SELECT intent_id, agent, created_at FROM intents WHERE lineage_id = ? AND shadow = 0 ORDER BY created_at DESC LIMIT 50")
        .all(i.lineage_id);
      const gaps: number[] = [];
      for (const r of real) {
        const m = this.db
          .query<{ t: number }, [string, string, string]>("SELECT MIN(received_at) AS t FROM messages WHERE from_agent = ? AND board = ? AND ref_kind = 'intent' AND ref_id = ?")
          .get(r.agent, i.lineage_id, r.intent_id);
        if (m?.t !== null && m?.t !== undefined) gaps.push(Math.max(0, m.t - r.created_at));
      }
      const rng = new Rng(H("m1-shadow-board", ep.secret, i.intent_id));
      const at = real.length && gaps.length && rng.next() < gaps.length / real.length ? i.created_at + gaps[rng.int(gaps.length)]! : null;
      this.db.query("INSERT INTO shadow_board (intent_id, shadow_id, lineage_id, post_at) VALUES (?, ?, ?, ?)").run(i.intent_id, i.agent, i.lineage_id, at);
    }
    const due = this.db
      .query<{ intent_id: string; shadow_id: string; lineage_id: string }, [number]>("SELECT intent_id, shadow_id, lineage_id FROM shadow_board WHERE done = 0 AND post_at IS NOT NULL AND post_at <= ? ORDER BY post_at, intent_id")
      .all(now);
    for (const d of due) {
      this.db.query("UPDATE shadow_board SET done = 1 WHERE intent_id = ?").run(d.intent_id);
      const key = this.c.collab.shadowKey(d.shadow_id);
      const it = this.db.query<{ kind: string; target: string; tip: string }, [string]>("SELECT kind, target, tip FROM intents WHERE intent_id = ?").get(d.intent_id);
      if (!key || !it) continue;
      const env = messageEnvelope({
        from: key.id,
        to: `board:${d.lineage_id}`,
        ref: { kind: "intent", id: d.intent_id },
        body: intentNote({ kind: it.kind, target: JSON.parse(it.target), tip: it.tip }),
        sent_at: now,
        nonce: H("shadow-note", d.intent_id).slice(0, 32),
      });
      try {
        this.sendInner(key.id, { envelope: env, sig: signStatement(key, "msg", env) }, true);
      } catch {
        // refused like a real post would be (a cap): the shadow skips it
      }
    }
  }
}
