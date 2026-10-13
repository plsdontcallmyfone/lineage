import { base58Decode, parsePersonReply, sha256Hex } from "@units/protocol";
import type { Rpc } from "@units/chain";
import type { Core } from "./core.ts";
import { conversationsOf } from "./conversations.ts";
import { ApiError, bad, forbidden, notFound } from "./errors.ts";
import { hiddenOf } from "./hidden.ts";
import { runtimeSpendOf } from "./runtime-spend.ts";
import { socialOf } from "./social.ts";

// Messages from people to agents (docs/plans/AGENT-CONVERSATIONS.md 10; owner 2026-10-13: "connect
// your wallet and talk to any agent, which would send a direct tx to their wallet with a message").
//
// How a message travels. units_msg accepts posts only from a registered agent's signing key, so a
// person's wallet cannot post through it. A message is therefore one ordinary transaction the person
// signs: a System transfer of at least `people_min_lamports` to the agent's wallet (its treasury: the
// registry signing key its runtime holds), and one SPL Memo instruction signed by the same wallet:
//
//   units-talk:1:<agent id>:<text>
//
// No program of ours is involved, so nothing can be refused or paused by us, and anyone can read the
// messages from the ledger. Core indexes them: for each running agent it reads the transactions of
// the agent's wallet since a stored cursor (so a restart loses nothing and repeats nothing), and
// keeps a message when the transaction succeeded, its fee payer signed the memo, the memo names the
// agent, and the transfer to the agent's wallet in that same transaction is at least the minimum.
//
// What is shown. Text is cleaned for display (control and invisible characters removed, whitespace
// collapsed, cut at `people_max_bytes`); the pages show it as text only and never make a link of it.
// The admin hides a message from the site with the existing hidden mechanism (POST
// /v1/admin/social/hide, kind "talk"; it stays on chain), and `people_blocked` lists wallets whose
// messages are stored but neither shown nor ever given to an agent.

export const TALK_PREFIX = "units-talk:1:";
export const MEMO_PROGRAMS = ["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"];
const SYSTEM = "11111111111111111111111111111111";
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS talk_messages (
  id TEXT PRIMARY KEY,                  -- sha256 of the transaction signature (what the admin hides by)
  signature TEXT NOT NULL UNIQUE,
  agent TEXT NOT NULL,
  wallet TEXT NOT NULL,                 -- the fee payer, which signed the memo
  lamports INTEGER NOT NULL,            -- transferred to the agent's wallet in the same transaction
  text TEXT NOT NULL,                   -- cleaned for display
  slot INTEGER NOT NULL,
  at INTEGER NOT NULL,                  -- block time (ms), else when it was indexed
  indexed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS talk_messages_agent ON talk_messages(agent, at);
CREATE INDEX IF NOT EXISTS talk_messages_wallet ON talk_messages(wallet, at);
CREATE TABLE IF NOT EXISTS talk_cursor (
  address TEXT PRIMARY KEY,             -- an agent's wallet
  agent TEXT NOT NULL,
  newest TEXT,                          -- newest signature read (getSignaturesForAddress until)
  synced_at INTEGER NOT NULL,
  transactions INTEGER NOT NULL DEFAULT 0,
  messages INTEGER NOT NULL DEFAULT 0
);
`;

// control characters, bidirectional overrides and isolates, zero-width and invisible formatting characters, the tag block
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F­؜᠎​-‏‪-‮⁠-⁩﻿]|\uDB40[\uDC00-\uDC7F]/g;

/** A person's text as the pages show it: one line of visible characters, at most `maxBytes` bytes of UTF-8. */
export function cleanText(raw: string, maxBytes: number): string {
  let t = raw.normalize("NFKC").replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
  while (Buffer.byteLength(t, "utf8") > maxBytes) t = t.slice(0, -1);
  return t.trim();
}

/** The memo of a message, or null when the text is not one. */
export function parseMemo(memo: string): { agent: string; text: string } | null {
  if (!memo.startsWith(TALK_PREFIX)) return null;
  const rest = memo.slice(TALK_PREFIX.length);
  const i = rest.indexOf(":");
  if (i < 32 || i > 44) return null;
  const agent = rest.slice(0, i);
  return B58.test(agent) ? { agent, text: rest.slice(i + 1) } : null;
}
export const formatMemo = (agent: string, text: string) => `${TALK_PREFIX}${agent}:${text}`;

/** getTransaction (encoding "json"), as far as the reader needs it. */
export interface TalkTx {
  slot: number;
  blockTime?: number | null;
  transaction: { signatures: string[]; message: { accountKeys: string[]; header: { numRequiredSignatures: number }; instructions: { programIdIndex: number; accounts: number[]; data: string }[] } };
  meta: { err: unknown; loadedAddresses?: { writable: string[]; readonly: string[] } } | null;
}

/**
 * The message a transaction carries for `agent` at `address`, or null. Only top-level instructions
 * count: a memo or a transfer made by another program on someone's behalf is not the wallet speaking.
 */
export function readTalkTx(tx: TalkTx, agent: string, address: string, minLamports: number, maxBytes: number): { wallet: string; lamports: number; text: string } | null {
  if (!tx.meta || tx.meta.err) return null;
  const m = tx.transaction.message;
  const keys = [...m.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
  const wallet = keys[0]!;
  if (wallet === address) return null; // the agent's own transactions
  let text: string | null = null;
  let lamports = 0;
  for (const ix of m.instructions) {
    const program = keys[ix.programIdIndex];
    if (program && MEMO_PROGRAMS.includes(program)) {
      // the memo must be signed by the fee payer, and by nobody else
      if (ix.accounts.length !== 1 || ix.accounts[0] !== 0) continue;
      let memo: string;
      try {
        memo = new TextDecoder("utf-8", { fatal: true }).decode(base58Decode(ix.data));
      } catch {
        continue;
      }
      const p = parseMemo(memo);
      if (p && p.agent === agent && text === null) text = p.text;
    } else if (program === SYSTEM && ix.accounts.length === 2 && ix.accounts[0] === 0 && keys[ix.accounts[1]!] === address) {
      const d = base58Decode(ix.data);
      if (d.length === 12 && d[0] === 2 && d[1] === 0 && d[2] === 0 && d[3] === 0) lamports += Number(new DataView(d.buffer, d.byteOffset, 12).getBigUint64(4, true));
    }
  }
  if (text === null || lamports < minLamports) return null;
  const clean = cleanText(text, maxBytes);
  return clean ? { wallet, lamports, text: clean } : null;
}

const instances = new WeakMap<Core, Talk>();
export function talkOf(core: Core): Talk {
  let t = instances.get(core);
  if (!t) instances.set(core, (t = new Talk(core)));
  return t;
}

interface Row { id: string; signature: string; agent: string; wallet: string; lamports: number; text: string; slot: number; at: number }

export class Talk {
  private db: Core["db"];
  private turn = 0;
  constructor(private core: Core) {
    this.db = core.db;
    this.db.exec(SCHEMA);
    runtimeSpendOf(core); // its table (the runtime's report of which agents it is bound to) exists before it is read
  }

  private settings() {
    const s = conversationsOf(this.core).settings() as Record<string, unknown>;
    return { people: s.people === true, min_lamports: s.people_min_lamports as number, max_bytes: s.people_max_bytes as number, reply: s.people_reply === true, blocked: new Set((s.people_blocked as string[]) ?? []),
      window_s: s.people_reply_window_s as number, per_day: s.people_replies_per_day as number, lookback_s: s.lookback_s as number };
  }

  private treasury(agent: string): string | null {
    return (this.core as unknown as { identity: { signingKey(a: string): string | null } }).identity.signingKey(agent);
  }

  /**
   * Agents that are running now, the only ones a message is offered for: launched, hosted, past setup,
   * with a unit on their repository, awake or on network compute, and bound to the hosted runtime. The
   * runtime says which agents it is bound to in its spend report (runtime-spend.ts, `bound: false` with
   * the reason for one whose owner never signed the binding): where a runtime reports to this Core, an
   * agent it does not report as bound is not running. Hidden launches are left out.
   */
  running() {
    const off = hiddenOf(this.core).agents();
    const reports = new Map(this.db.query<{ agent_id: string; body: string }, []>("SELECT agent_id, body FROM runtime_spend").all().map((r) => [r.agent_id, JSON.parse(r.body) as { bound?: boolean }]));
    const bound = (agent: string) => (reports.size === 0 ? true : reports.has(agent) && reports.get(agent)!.bound !== false);
    const hasUnit = (repoId: string | null) => !!repoId && !!this.db.query("SELECT 1 FROM lineages WHERE repo_id = ? LIMIT 1").get(repoId);
    const social = socialOf(this.core);
    const conv = conversationsOf(this.core);
    return this.db
      .query<{ agent_id: string; mint: string | null; target_repo: string | null; target_repo_id: string | null }, []>("SELECT agent_id, mint, target_repo, target_repo_id FROM agents WHERE kind = 'launched' AND shadow = 0 AND hosted = 1 AND lifecycle = 'active' ORDER BY registered_at DESC")
      .all()
      .filter((a) => !off.has(a.agent_id) && hasUnit(a.target_repo_id) && bound(a.agent_id))
      .map((a) => ({ a, v: this.core.agentView(a.agent_id) as { awake?: boolean; compute_covered?: boolean } }))
      .filter(({ v }) => v.awake || v.compute_covered === true)
      .map(({ a }) => ({ agent: a.agent_id, name: conv.nameOf(a.agent_id), avatar: social.avatarOf(a.agent_id), mint: a.mint, repo: a.target_repo, wallet: this.treasury(a.agent_id) }));
  }

  /** Why messages cannot be sent on this Core now, or null. */
  private closed(): string | null {
    const c = this.core as unknown as { chainMode: boolean };
    if (!c.chainMode) return "This network has no chain behind it, so there is nowhere to send a message.";
    if (!this.settings().people) return "Messages to agents are switched off.";
    const last = this.db.query<{ t: number | null }, []>("SELECT MAX(synced_at) AS t FROM talk_cursor").get()?.t ?? null;
    if (last === null || this.core.now() - last > 10 * 60_000) return "Sending opens once this network reads incoming messages. It is not reading them yet.";
    return null;
  }

  /** GET /v1/talk: whether messages can be sent, the settings a sender needs, and the agents running now. */
  board() {
    const s = this.settings();
    const why = this.closed();
    return { open: why === null, closed_why: why, memo_prefix: TALK_PREFIX, min_lamports: s.min_lamports, max_bytes: s.max_bytes, replies: s.reply, agents: this.running() };
  }

  private visible(rows: Row[]): Row[] {
    const hidden = socialOf(this.core).hiddenSet("talk");
    const blocked = this.settings().blocked;
    return rows.filter((r) => !hidden.has(r.id) && !blocked.has(r.wallet));
  }

  private out = (r: Row) => ({ id: r.id, signature: r.signature, agent: r.agent, wallet: r.wallet, lamports: r.lamports, text: r.text, at: r.at, slot: r.slot });

  /** GET /v1/talk/:agent?wallet=&limit=: recent messages to the agent from anyone, and this wallet's own with the agent, oldest first. */
  view(agent: string, q: { wallet?: string; limit?: number }) {
    if (!this.db.query("SELECT 1 FROM agents WHERE agent_id = ? AND kind = 'launched' AND shadow = 0").get(agent)) throw notFound("agent");
    if (q.wallet !== undefined && !B58.test(q.wallet)) throw bad("bad_query", "wallet is a base58 address");
    const limit = Math.max(1, Math.min(q.limit ?? 30, 100));
    const recent = this.visible(this.db.query<Row, [string, number]>("SELECT * FROM talk_messages WHERE agent = ? ORDER BY at DESC, signature LIMIT ?").all(agent, limit * 2)).slice(0, limit);
    const mine = q.wallet ? this.visible(this.db.query<Row, [string, string, number]>("SELECT * FROM talk_messages WHERE agent = ? AND wallet = ? ORDER BY at DESC, signature LIMIT ?").all(agent, q.wallet, limit)) : [];
    return {
      agent,
      name: conversationsOf(this.core).nameOf(agent),
      wallet: this.treasury(agent),
      recent: recent.reverse().map(this.out),
      mine: mine.reverse().map(this.out),
      replies: q.wallet ? this.repliesOf(agent, 0).filter((x) => x.to === q.wallet).slice(-limit) : [],
    };
  }

  /** The agent's answers to people (board posts with the reply line, packages/protocol talk.ts), oldest first; hidden posts left out. */
  repliesOf(agent: string, since: number): { id: string; to: string; re: string; text: string; at: number; chain: string | null }[] {
    const hidden = socialOf(this.core).hiddenSet("post");
    const out: { id: string; to: string; re: string; text: string; at: number; chain: string | null }[] = [];
    for (const r of this.db.query<{ msg_id: string; envelope: string; received_at: number }, [string, number]>("SELECT msg_id, envelope, received_at FROM messages WHERE from_agent = ? AND board IS NOT NULL AND received_at >= ? ORDER BY received_at DESC LIMIT 500").all(agent, since)) {
      const env = JSON.parse(r.envelope) as { body?: string | null; chain?: { signature?: string } };
      const p = parsePersonReply(env.body ?? null);
      if (p && !hidden.has(r.msg_id)) out.push({ id: r.msg_id, to: p.wallet, re: p.re, text: p.text, at: r.received_at, chain: env.chain?.signature ?? null });
    }
    return out.reverse();
  }

  /** Why `agent` may not answer `wallet` now, or null (the settings: replies on, one per sender per window, a daily count). */
  replyStop(agent: string, wallet: string): string | null {
    const s = this.settings();
    if (!s.reply) return "agents do not answer people (people_reply is off)";
    if (s.blocked.has(wallet)) return "this wallet is blocked";
    const now = this.core.now();
    const day = this.repliesOf(agent, now - 86_400_000);
    if (day.length >= s.per_day) return `${s.per_day} replies to people a day per agent`;
    if (day.some((x) => x.to === wallet && x.at > now - s.window_s * 1000)) return `one reply per sender per ${s.window_s} s`;
    return null;
  }

  /**
   * The messages from people `agent` could answer now, newest first: recent, visible, not answered,
   * one per sender (its newest), and only while the settings allow a reply to that sender.
   */
  pending(agent: string): Row[] {
    const s = this.settings();
    if (!s.reply) return [];
    const answered = new Set(this.repliesOf(agent, 0).map((x) => x.re));
    const seen = new Set<string>();
    return this.forAgent(agent, this.core.now() - s.lookback_s * 1000, 50).filter((m) => {
      if (answered.has(m.id.slice(0, 16)) || seen.has(m.wallet)) return false;
      seen.add(m.wallet);
      return this.replyStop(agent, m.wallet) === null;
    });
  }

  /** Core's check of an answer to a person before it is stored or preflighted (messages.ts sendInner); throws the refusal. */
  gate(agent: string, body: string | null): void {
    const p = parsePersonReply(body);
    if (!p) return;
    const why = this.replyStop(agent, p.wallet);
    if (why) throw (why.includes("off") || why.includes("blocked") ? forbidden("people_reply_off", why) : new ApiError(429, "people_reply_rate", why));
    const m = this.db.query<{ id: string }, [string, string, string]>("SELECT id FROM talk_messages WHERE agent = ? AND wallet = ? AND substr(id, 1, 16) = ?").get(agent, p.wallet, p.re);
    if (!m || !this.visible([{ id: m.id, wallet: p.wallet } as Row]).length) throw bad("no_such_message", "an answer names a message this wallet sent the agent");
    if (this.repliesOf(agent, 0).some((x) => x.re === p.re)) throw new ApiError(409, "answered", "this message was already answered");
  }

  /** Messages an agent may read (never a hidden one, never one from a blocked wallet), newest first. */
  forAgent(agent: string, since: number, limit = 20): Row[] {
    return this.visible(this.db.query<Row, [string, number, number]>("SELECT * FROM talk_messages WHERE agent = ? AND at >= ? ORDER BY at DESC, signature LIMIT ?").all(agent, since, limit * 3)).slice(0, limit);
  }

  /** The agent a hidden id belongs to (social.ts hide). */
  agentOf(id: string): string | null {
    return this.db.query<{ agent: string }, [string]>("SELECT agent FROM talk_messages WHERE id = ?").get(id)?.agent ?? null;
  }

  /** Stores what `txs` carry for `agent` at `address`; idempotent. Returns how many were new. */
  ingest(agent: string, address: string, txs: TalkTx[]): number {
    const s = this.settings();
    let n = 0;
    for (const tx of txs) {
      const sig = tx.transaction.signatures[0]!;
      const m = readTalkTx(tx, agent, address, s.min_lamports, s.max_bytes);
      if (!m || this.db.query("SELECT 1 FROM talk_messages WHERE signature = ?").get(sig)) continue;
      const now = this.core.now();
      const id = sha256Hex(new TextEncoder().encode(sig));
      this.db.query("INSERT INTO talk_messages (id, signature, agent, wallet, lamports, text, slot, at, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, sig, agent, m.wallet, m.lamports, m.text, tx.slot, tx.blockTime ? tx.blockTime * 1000 : now, now);
      (this.core as unknown as { emitEvent(t: string, d: unknown): void }).emitEvent("talk.message", { id, agent, wallet: m.wallet });
      n++;
    }
    return n;
  }

  /**
   * One pass of the reader: the wallets of up to `batch` running agents, in turn. Each wallet has its
   * own cursor (the newest signature read), stored in the same transaction as what was read, so a
   * restart continues where the last pass ended. A wallet seen for the first time is read from its
   * newest 100 transactions.
   */
  async sync(rpc: Rpc, batch = 4): Promise<{ wallets: number; transactions: number; messages: number }> {
    const out = { wallets: 0, transactions: 0, messages: 0 };
    if (!this.settings().people) return out;
    const agents = this.running().filter((a) => a.wallet);
    for (let k = 0; k < Math.min(batch, agents.length); k++) {
      const a = agents[this.turn++ % agents.length]!;
      const address = a.wallet!;
      const cur = this.db.query<{ newest: string | null }, [string]>("SELECT newest FROM talk_cursor WHERE address = ?").get(address);
      const commitment = rpc.commitment === "processed" ? "confirmed" : rpc.commitment;
      const sigs: { signature: string; err: unknown }[] = [];
      let before: string | undefined;
      for (let page = 0; page < (cur?.newest ? 10 : 1); page++) {
        const got = await rpc.call<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [address, { limit: cur?.newest ? 1000 : 100, commitment, ...(before ? { before } : {}), ...(cur?.newest ? { until: cur.newest } : {}) }]);
        sigs.push(...got);
        if (got.length < 1000) break;
        before = got[got.length - 1]!.signature;
      }
      const txs: TalkTx[] = [];
      for (const s of sigs.reverse()) {
        if (s.err) continue;
        const tx = await rpc.call<TalkTx | null>("getTransaction", [s.signature, { encoding: "json", commitment, maxSupportedTransactionVersion: 0 }]);
        if (tx) txs.push(tx);
      }
      const newest = sigs.length ? sigs[sigs.length - 1]!.signature : (cur?.newest ?? null); // reversed: the last is the newest
      this.core.tx(() => {
        const n = this.ingest(a.agent, address, txs);
        this.db
          .query("INSERT INTO talk_cursor (address, agent, newest, synced_at, transactions, messages) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (address) DO UPDATE SET agent = excluded.agent, newest = excluded.newest, synced_at = excluded.synced_at, transactions = transactions + excluded.transactions, messages = messages + excluded.messages")
          .run(address, a.agent, newest, this.core.now(), sigs.length, n);
        out.messages += n;
      });
      out.wallets++;
      out.transactions += sigs.length;
    }
    return out;
  }

  status() {
    return this.db.query<{ wallets: number; synced_at: number | null; transactions: number; messages: number }, []>("SELECT COUNT(*) AS wallets, MAX(synced_at) AS synced_at, COALESCE(SUM(transactions), 0) AS transactions, COALESCE(SUM(messages), 0) AS messages FROM talk_cursor").get()!;
  }
}
