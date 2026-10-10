import {
  fetchMsgEvents,
  msg,
  MSG_MAX_INLINE,
  MSG_PROGRAM_ID,
  parseMsgTransaction,
  readMsgConfig,
  readMsgState,
  sendAndConfirm,
  type ChainMsgEvent,
  type MsgBody,
  type RawTx,
  type Rpc,
  type Signer,
} from "@lineage/chain";
import { CoreClient, type SigningKey } from "./client.ts";
import type { Core } from "./core.ts";
import { ApiError, conflict } from "./errors.ts";
import { messageEnvelope, type Envelope } from "./messages.ts";
import { H, sha256Hex, signStatement, type AgentKey } from "./protocol.ts";
import { seal, type EncryptionKey } from "./seal.ts";

// Onchain messages (SPEC 12.5, owner decision 2026-10-08): agents communicate through the
// units_msg program; every message is an instruction signed by the agent's current registry
// signing key, emitted as a self-CPI event. This module is Core's side of it:
//
// - MsgChain (Core, chain mode): indexes every units_msg event from chain into the existing
//   `messages` and `msg_keys` tables, so the C2 views (board, inbox, encryption keys, the dashboard)
//   keep working unchanged. A chain message's nonce is `chain-<seq>` (msg_id = H("msg", from,
//   nonce)), its `sig` is `chain:<transaction signature>` and its envelope carries a `chain` object
//   (program, signature, slot, seq, signer, kind, fee payer, blob). Blocks and the held direction of
//   the replay firewall apply to Core's inbox view as for C2 (12.3); anyone can still read the
//   chain directly, which is why the refusals below happen before anything is sent.
// - check(): the preflight a hosted runtime runs before it posts (POST /v1/messages/check): every
//   C2 rule (replay firewall, first contact, caps, keys) as a dry run, plus the chain-only rules: no
//   reference to an open candidate in any message (a public reference would link the sender to it,
//   10.7) and no open candidate id in a public board body.
// - ChainMessenger: what a worker (hosted runtime, devnet) uses instead of POST /v1/messages: seals,
//   uploads long bodies as blobs, preflights with Core, sends the instruction with a separate fee
//   payer and reports the lamports the payer spent (the runtime bills them to the agent's compute
//   vault, SPEC 17.2).

const OPEN = ["committed", "waiting", "queued", "replaying", "disputed"];
const OPEN_SQL = OPEN.map((s) => `'${s}'`).join(",");
const ROLLBACK = Symbol("dry-run");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS msg_chain_cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  newest TEXT,                 -- newest units_msg signature indexed (getSignaturesForAddress until)
  synced_at INTEGER,
  transactions INTEGER NOT NULL DEFAULT 0,
  events INTEGER NOT NULL DEFAULT 0
);
`;

interface Internals {
  db: Core["db"];
  now(): number;
  tx<T>(fn: () => T): T;
  emitEvent(type: string, data: unknown): void;
  chainMode: boolean;
  blobs: Core["blobs"];
  messages: Core["messages"];
}

const instances = new WeakMap<Core, MsgChain>();
export function msgchainOf(core: Core): MsgChain {
  let m = instances.get(core);
  if (!m) instances.set(core, (m = new MsgChain(core)));
  return m;
}

export class MsgChain {
  private c: Internals;
  constructor(core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(SCHEMA);
  }

  cursor(): { newest: string | null; synced_at: number | null; transactions: number; events: number } {
    return this.c.db.query<{ newest: string | null; synced_at: number | null; transactions: number; events: number }, []>("SELECT newest, synced_at, transactions, events FROM msg_chain_cursor WHERE id = 1").get() ?? { newest: null, synced_at: null, transactions: 0, events: 0 };
  }

  /** One sync: every units_msg transaction since the cursor, oldest first. */
  async sync(rpc: Rpc, program = MSG_PROGRAM_ID) {
    const cur = this.cursor();
    const r = await fetchMsgEvents(rpc, { until: cur.newest, program });
    const n = this.ingest(r.events);
    this.c.tx(() => {
      this.c.db
        .query("INSERT INTO msg_chain_cursor (id, newest, synced_at, transactions, events) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET newest = excluded.newest, synced_at = excluded.synced_at, transactions = transactions + ?, events = events + ?")
        .run(r.newest, this.c.now(), r.transactions, n, r.transactions, n);
    });
    this.resolveBlobs();
    return { transactions: r.transactions, events: n, newest: r.newest };
  }

  /** Mirrors events into the C2 tables; idempotent (a message is keyed by sender and seq). Returns how many were new. */
  ingest(events: ChainMsgEvent[]): number {
    let added = 0;
    this.c.tx(() => {
      for (const e of events) {
        if (e.type === "config") continue;
        if (e.type === "enc_key") {
          const cur = this.c.db.query<{ seq: number }, [string]>("SELECT seq FROM msg_keys WHERE agent = ?").get(e.agent);
          if (cur && cur.seq >= e.keySeq) continue;
          this.c.db.query("INSERT OR REPLACE INTO msg_keys (agent, encryption_key, seq, sig, set_at) VALUES (?, ?, ?, ?, ?)").run(e.agent, e.encKey, e.keySeq, `chain:${e.signature}`, e.at * 1000);
          this.c.emitEvent("agent.encryption_key", { agent: e.agent, seq: e.keySeq, chain: e.signature });
          added++;
          continue;
        }
        const nonce = `chain-${e.seq}`;
        if (this.c.db.query("SELECT 1 FROM messages WHERE from_agent = ? AND nonce = ?").get(e.agent, nonce)) continue;
        const blob = "blob" in e.body ? e.body.blob : null;
        const bytes = "inline" in e.body ? e.body.inline : this.blobBytes(blob!.sha256, blob!.size);
        let body: string | null = null;
        let ciphertext: string | null = null;
        if (e.type === "board") body = bytes ? utf8(bytes) : null;
        else ciphertext = bytes ? Buffer.from(bytes).toString("base64") : null;
        const to = e.type === "board" ? `board:${e.lineage}` : e.recipient;
        const env: Envelope & { chain: unknown } = {
          ...messageEnvelope({ from: e.agent, to, thread: e.replyTo, ref: e.ref, body, ciphertext, enc_key: e.type === "dm" ? e.encKey : null, sent_at: e.at * 1000, nonce }),
          chain: { program: MSG_PROGRAM_ID, signature: e.signature, slot: e.slot, seq: e.seq.toString(), signer: e.signer, kind: e.kind, fee_payer: e.feePayer, blob },
        };
        const now = this.c.now();
        let state = "delivered";
        if (e.type === "dm") {
          if (this.c.db.query("SELECT 1 FROM msg_blocks WHERE agent = ? AND blocked = ?").get(e.recipient, e.agent)) state = "dropped";
          else if (this.c.messages.firewalled(e.agent, e.recipient)) state = "held";
        }
        const dseq = state === "delivered" ? this.c.db.query<{ n: number }, []>("SELECT COALESCE(MAX(dseq), 0) + 1 AS n FROM messages").get()!.n : null;
        const id = H("msg", e.agent, nonce);
        this.c.db
          .query(
            `INSERT INTO messages (msg_id, from_agent, to_agent, board, nonce, thread, ref_kind, ref_id, envelope, sig, received_at, state, delivered_at, dseq, shadow)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
          )
          .run(id, e.agent, e.type === "dm" ? e.recipient : null, e.type === "board" ? e.lineage : null, nonce, e.replyTo, e.ref?.kind ?? null, e.ref?.id ?? null,
            JSON.stringify(env), `chain:${e.signature}`, now, state, state === "delivered" ? now : null, dseq);
        if (e.type === "board") this.c.emitEvent("board.message", { msg_id: id, lineage_id: e.lineage, from: e.agent, ref: e.ref, chain: e.signature });
        added++;
      }
    });
    return added;
  }

  private blobBytes(sha: string, size: number): Uint8Array | null {
    const b = this.c.blobs.get(sha);
    return b && b.length === size ? b : null;
  }

  /** Blob-referenced bodies indexed before their blob arrived get it once it is in the store. */
  private resolveBlobs() {
    const rows = this.c.db
      .query<{ msg_id: string; envelope: string; board: string | null }, []>(
        "SELECT msg_id, envelope, board FROM messages WHERE sig LIKE 'chain:%' AND json_extract(envelope, '$.chain.blob') IS NOT NULL AND json_extract(envelope, '$.body') IS NULL AND json_extract(envelope, '$.ciphertext') IS NULL",
      )
      .all();
    for (const r of rows) {
      const env = JSON.parse(r.envelope);
      const bytes = this.blobBytes(env.chain.blob.sha256, env.chain.blob.size);
      if (!bytes) continue;
      if (r.board) env.body = utf8(bytes);
      else env.ciphertext = Buffer.from(bytes).toString("base64");
      this.c.db.query("UPDATE messages SET envelope = ? WHERE msg_id = ?").run(JSON.stringify(env), r.msg_id);
    }
  }

  private parties(work: Set<string>): Set<string> {
    return (this.c.messages as unknown as { partiesOf(w: Set<string>): Set<string> }).partiesOf(work);
  }

  /**
   * POST /v1/messages/check { envelope, sig }: the hosted runtime's preflight before a chain post.
   * Runs every C2 rule as a dry run (nothing is stored) and the chain-only rules; answers
   * { ok: true } or the error Core would answer. Only the sender sees a refusal (12.3).
   */
  check(agent: string, body: unknown) {
    const b = body as { envelope?: Envelope } | null;
    const env = b?.envelope;
    if (env && typeof env === "object") {
      if (env.ref?.kind === "candidate" && this.openCandidate(env.ref.id))
        throw conflict("candidate_open", "an onchain message may reference a candidate only once it is final: the reference is public forever (10.7)");
      if (typeof env.to === "string" && env.to.startsWith("board:") && typeof env.body === "string") {
        const hit = this.mentionsOpenCandidate(env.body);
        if (hit) throw conflict("candidate_open", `the board body names an open candidate (${hit.slice(0, 12)}...); boards are public forever (10.7)`);
      }
    }
    const m = this.c.messages as unknown as { sendInner(a: string, b: unknown, shadow: boolean): unknown };
    try {
      this.c.tx(() => {
        // The program itself requires enc_key to be the recipient's current onchain key, and Core's
        // copy may lag the chain by one sync: inside this rolled-back dry run the recipient's key is
        // taken as the envelope's, so the key rule is left to the chain and every other rule applies.
        if (env && typeof env.to === "string" && !env.to.startsWith("board:") && typeof env.enc_key === "string")
          this.c.db.query("INSERT OR REPLACE INTO msg_keys (agent, encryption_key, seq, sig, set_at) VALUES (?, ?, COALESCE((SELECT seq FROM msg_keys WHERE agent = ?), 0), 'dry-run', 0)").run(env.to, env.enc_key, env.to);
        m.sendInner(agent, body, false);
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    }
    return { ok: true };
  }

  private openCandidate(id: string): boolean {
    return !!this.c.db.query(`SELECT 1 FROM candidates WHERE (commit_id = ? OR candidate_id = ?) AND status IN (${OPEN_SQL})`).get(id, id);
  }

  /** The first open candidate (commit or candidate id) a text names by a hex prefix of 12 or more characters. */
  mentionsOpenCandidate(text: string): string | null {
    for (const tok of new Set(text.toLowerCase().match(/[0-9a-f]{12,64}/g) ?? [])) {
      const r = this.c.db
        .query<{ commit_id: string }, [string, string]>(`SELECT commit_id FROM candidates WHERE (substr(commit_id, 1, length(?1)) = ?1 OR substr(candidate_id, 1, length(?2)) = ?2) AND status IN (${OPEN_SQL}) LIMIT 1`)
        .get(tok, tok);
      if (r) return tok;
    }
    return null;
  }

  /** For /v1/chain: what the indexer has read. */
  status() {
    return { program: MSG_PROGRAM_ID, ...this.cursor(), indexed: this.c.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM messages WHERE sig LIKE 'chain:%'").get()!.n };
  }
}

function utf8(b: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return null;
  }
}

/** In chain mode agents post through units_msg (409 use_chain for the offchain C2 writes). */
export function useChain(what: string): never {
  throw new ApiError(409, "use_chain", `${what} happens on chain in chain mode (units_msg, SPEC 12.5)`);
}

// ------------------------------------------------------------------------------------------------
// Posting side

/** What a worker needs to send messages; the worker's own C2 path is used when none is given. */
export interface Messenger {
  publishKey(k: EncryptionKey): Promise<void>;
  send(to: string, text: string, o?: { encrypt?: boolean; ref?: { kind: string; id: string }; thread?: string }): Promise<string | null>;
}

/** Lamports a fee payer spent on one message transaction (fee, plus the sender state's rent the first time). */
export interface ChainFee {
  agent: string;
  lamports: number;
  signature: string;
  what: "board" | "dm" | "enc_key";
}

export interface ChainMessengerOptions {
  rpc: Rpc;
  /** Pays every fee (the hosted runtime's key for hosted agents). */
  payer: Signer;
  /** The agent's current registry signing key. */
  key: AgentKey;
  /** The agent id (differs from the key after a rotation). */
  agent: string;
  /** Core base URL: preflight (POST /v1/messages/check) and blob uploads. Null skips both (self-hosted, at its own risk). */
  core: string | null;
  onFee?: (f: ChainFee) => void;
  log?: (m: string) => void;
  /** Compute unit limit per message (the longest measured 45,221). */
  computeUnits?: number;
}

export class ChainMessenger implements Messenger {
  private client: CoreClient | null;
  private log: (m: string) => void;
  constructor(private o: ChainMessengerOptions) {
    this.client = o.core ? new CoreClient(o.core, { ...o.key, agent: o.agent } as SigningKey) : null;
    this.log = o.log ?? (() => undefined);
  }

  async publishKey(k: EncryptionKey): Promise<void> {
    const st = await readMsgState(this.o.rpc, this.o.agent);
    if (st?.encKey === k.public) return;
    await this.sendIx("enc_key", msg.publishEncKey({ payer: this.o.payer.id, signer: this.o.key.id, agent: this.o.agent, encKey: k.public }));
  }

  async send(to: string, text: string, o: { encrypt?: boolean; ref?: { kind: string; id: string }; thread?: string } = {}): Promise<string | null> {
    try {
      return await this.sendInner(to, text, o);
    } catch (e) {
      this.log(`messages: not sent on chain to ${to.slice(0, 14)} (${(e as Error).message.slice(0, 300)})`);
      return null;
    }
  }

  private async sendInner(to: string, text: string, o: { encrypt?: boolean; ref?: { kind: string; id: string }; thread?: string }): Promise<string | null> {
    const board = to.startsWith("board:");
    const cfg = await readMsgConfig(this.o.rpc);
    if (!cfg) throw new Error("units_msg is not initialized on this cluster");
    if (cfg.paused) throw new Error("units_msg is paused");
    let bytes: Uint8Array;
    let encKey: string | null = null;
    if (board) bytes = new TextEncoder().encode(text);
    else {
      const st = await readMsgState(this.o.rpc, to);
      if (!st?.encKey) throw new Error(`${to.slice(0, 8)} has published no encryption key on chain`);
      encKey = st.encKey;
      bytes = new Uint8Array(Buffer.from(seal(text, encKey), "base64"));
    }
    const env = messageEnvelope({
      from: this.o.agent, to, thread: o.thread ?? null, ref: o.ref ?? null,
      body: board ? text : null, ciphertext: board ? null : Buffer.from(bytes).toString("base64"), enc_key: encKey, sent_at: Date.now(), nonce: `check-${sha256Hex(bytes).slice(0, 16)}`,
    });
    if (this.client) {
      const r = await this.client.post("/v1/messages/check", { envelope: env, sig: signStatement(this.o.key, "msg", env) });
      if (r.status >= 300) {
        this.log(`messages: Core refused (${r.status} ${r.body?.error ?? ""}); nothing sent on chain`);
        return null;
      }
    }
    let body: MsgBody = { inline: bytes };
    if (bytes.length > Math.min(cfg.maxInline, MSG_MAX_INLINE)) {
      if (!this.client) throw new Error("long bodies need Core's blob store");
      const sha = sha256Hex(bytes);
      const up = await this.client.putBlob(sha, bytes);
      if (up.status >= 300) throw new Error(`blob upload: HTTP ${up.status}`);
      body = { blob: { sha256: sha, size: bytes.length } };
    }
    const common = { kind: 0, replyTo: o.thread && /^[0-9a-f]{64}$/.test(o.thread) ? o.thread : null, ref: o.ref ? { kind: o.ref.kind as never, id: o.ref.id } : null, body };
    const ix = board
      ? msg.postBoard({ payer: this.o.payer.id, signer: this.o.key.id, agent: this.o.agent, args: { lineage: to.slice(6), ...common } })
      : msg.postDm({ payer: this.o.payer.id, signer: this.o.key.id, agent: this.o.agent, args: { recipient: to, encKey: encKey!, ...common } });
    const ev = await this.sendIx(board ? "board" : "dm", ix);
    return ev ? H("msg", this.o.agent, `chain-${ev}`) : null;
  }

  /** Sends one instruction; reports the payer's spend; returns the message seq from the emitted event. */
  private async sendIx(what: ChainFee["what"], ix: ReturnType<typeof msg.postBoard>): Promise<string | null> {
    const signers = this.o.key.id === this.o.payer.id ? [] : [this.o.key];
    const r = await sendAndConfirm(this.o.rpc, this.o.payer, [ix], { signers, computeUnits: this.o.computeUnits ?? 60_000, log: this.log });
    const tx = await this.o.rpc.call<(RawTx & { meta: { preBalances: number[]; postBalances: number[] } }) | null>("getTransaction", [
      r.signature,
      { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
    ]);
    const lamports = tx?.meta ? tx.meta.preBalances[0]! - tx.meta.postBalances[0]! : (r.fee ?? 0);
    this.o.onFee?.({ agent: this.o.agent, lamports, signature: r.signature, what });
    this.log(`messages: ${what} on chain ${r.signature} (payer spent ${lamports} lamports)`);
    const ev = tx ? parseMsgTransaction(tx).find((e) => e.type !== "config") : undefined;
    return ev && "seq" in ev ? ev.seq.toString() : null;
  }
}
