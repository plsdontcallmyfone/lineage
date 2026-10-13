import { parseTalk, type Talk } from "@units/protocol";
import type { Conversations, ConversationSettings } from "./conversations.ts";
import { ApiError, bad, conflict, forbidden } from "./errors.ts";

// The limits of agent conversations (docs/plans/AGENT-CONVERSATIONS.md 4): urging without spam.
// Core counts from its own message table, so the limits hold across runtime restarts and for every
// sender that goes through Core's check (the simulated mode's POST /v1/messages and the chain
// preflight POST /v1/messages/check). A self-hosted agent that posts straight to units_msg is bound
// only by the program's own per-agent caps (the plan lists that under "needs a program change").
//
//   rate        per agent per hour and per day, per repository per hour and per day, a minimum gap
//   relevance   an addressee works on the same repository, touched the same unit, or addressed the sender
//   ping-pong   a thread holds at most `reply_depth` messages; an agent writes in one thread at most
//               once per `thread_cooldown_s`; one agent addresses another at most `pair_per_day` a day

const HOUR = 3_600_000;
const DAY = 86_400_000;

interface Sent {
  from: string;
  at: number;
  thread: string | null;
  msg_id: string;
  talk: Talk;
}

/** Conversation messages of the last day, newest first (of one sender, or of the given senders). */
function sent(c: Conversations, senders: string[], since: number): Sent[] {
  if (!senders.length) return [];
  return c.db
    .query<{ msg_id: string; from_agent: string; thread: string | null; envelope: string; received_at: number }, (string | number)[]>(
      `SELECT msg_id, from_agent, thread, envelope, received_at FROM messages WHERE board IS NOT NULL AND shadow = 0 AND received_at >= ? AND from_agent IN (${senders.map(() => "?").join(",")}) ORDER BY received_at DESC LIMIT 2000`,
    )
    .all(since, ...senders)
    .map((r) => ({ from: r.from_agent, at: r.received_at, thread: r.thread, msg_id: r.msg_id, talk: parseTalk((JSON.parse(r.envelope) as { body?: string | null }).body ?? null) }))
    .filter((r): r is Sent => !!r.talk);
}

function repoOf(c: Conversations, agent: string): string | null {
  return c.db.query<{ target_repo_id: string | null }, [string]>("SELECT target_repo_id FROM agents WHERE agent_id = ? AND kind = 'launched'").get(agent)?.target_repo_id ?? null;
}

function repoAgents(c: Conversations, repo: string | null): string[] {
  return repo ? c.db.query<{ agent_id: string }, [string]>("SELECT agent_id FROM agents WHERE kind = 'launched' AND target_repo_id = ?").all(repo).map((r) => r.agent_id) : [];
}

export interface Budget {
  ok: boolean;
  /** why not, in words */
  why: string | null;
  /** when the limit that holds it lets go (ms), when known */
  next_at: number | null;
  agent: { hour: number; day: number };
  repository: { hour: number; day: number };
}

/** What the rate limits leave `agent` now. */
export function budgetOf(c: Conversations, agent: string, s: ConversationSettings = c.settings()): Budget {
  const now = c.core.now();
  const mine = sent(c, [agent], now - DAY);
  const repo = sent(c, repoAgents(c, repoOf(c, agent)), now - DAY);
  const inHour = (l: Sent[]) => l.filter((m) => m.at > now - HOUR);
  const b: Budget = { ok: true, why: null, next_at: null, agent: { hour: inHour(mine).length, day: mine.length }, repository: { hour: inHour(repo).length, day: repo.length } };
  const stop = (why: string, next: number | null) => Object.assign(b, { ok: false, why, next_at: next });
  const oldest = (l: Sent[]) => (l.length ? l[l.length - 1]!.at : now);
  if (mine.length >= (s.per_agent_day as number)) return stop(`${s.per_agent_day} messages a day per agent`, oldest(mine) + DAY);
  if (inHour(mine).length >= (s.per_agent_hour as number)) return stop(`${s.per_agent_hour} messages an hour per agent`, oldest(inHour(mine)) + HOUR);
  if (mine.length && now - mine[0]!.at < (s.min_gap_s as number) * 1000) return stop(`${s.min_gap_s} s between two messages of one agent`, mine[0]!.at + (s.min_gap_s as number) * 1000);
  if (repo.length >= (s.per_repo_day as number)) return stop(`${s.per_repo_day} messages a day per repository`, oldest(repo) + DAY);
  if (inHour(repo).length >= (s.per_repo_hour as number)) return stop(`${s.per_repo_hour} messages an hour per repository`, oldest(inHour(repo)) + HOUR);
  return b;
}

/** True when `to` is someone `agent` has reason to address on `board`: same repository, same unit, or it addressed the agent. */
export function relevant(c: Conversations, agent: string, to: string, board: string): boolean {
  if (c.settings().cross_repo === true) return true; // agents on different repositories may talk (the rates still hold)
  const mine = repoOf(c, agent);
  if (mine && mine === repoOf(c, to)) return true;
  const touched = (sql: string) => !!c.db.query(sql).get(to, board);
  if (
    touched("SELECT 1 FROM intents WHERE agent = ? AND lineage_id = ? AND shadow = 0 LIMIT 1") ||
    touched("SELECT 1 FROM generations WHERE author = ? AND lineage_id = ? LIMIT 1") ||
    touched("SELECT 1 FROM candidates WHERE author = ? AND lineage_id = ? AND status IN ('accepted','rejected','expired') AND is_canary = 0 LIMIT 1")
  )
    return true;
  return sent(c, [to], c.core.now() - 7 * DAY).some((m) => m.talk.to.some((x) => x.agent === agent));
}

/** Why `agent` may not write in the thread of `parent` now, or null. */
export function threadStop(c: Conversations, agent: string, parent: string, s: ConversationSettings = c.settings()): string | null {
  if (c.depthOf(parent) >= (s.reply_depth as number)) return `a thread holds at most ${s.reply_depth} messages`;
  const now = c.core.now();
  const root = c.rootOf(parent);
  const recent = sent(c, [agent], now - (s.thread_cooldown_s as number) * 1000).some((m) => m.msg_id === root || (m.thread !== null && c.rootOf(m.thread) === root));
  return recent ? `${s.thread_cooldown_s} s before an agent writes again in the same thread` : null;
}

/** True when `agent` already addressed `to` `pair_per_day` times in the last day. */
export function pairStop(c: Conversations, agent: string, to: string, s: ConversationSettings = c.settings()): boolean {
  return sent(c, [agent], c.core.now() - DAY).filter((m) => m.talk.to.some((x) => x.agent === to)).length >= (s.pair_per_day as number);
}

/**
 * The check a conversation message passes before Core stores it (or answers the chain preflight):
 * throws the refusal. A body that is not a conversation message is not this module's business.
 */
export function gate(c: Conversations, agent: string, env: { body: string | null; thread: string | null }, board: string): void {
  const t = parseTalk(env.body);
  if (!t) return;
  const s = c.settings();
  if (!s.enabled) throw forbidden("conversations_off", "agent conversations are switched off by the admin");
  if (t.to.length > s.max_mentions) throw bad("bad_address", `a message addresses at most ${s.max_mentions} agents`);
  for (const x of t.to) {
    if (x.agent === agent) {
      // a swarm speaks to itself seat to seat, never an agent to itself
      if (x.seat === null || t.seat === null || x.seat === t.seat) throw bad("bad_address", "a message to oneself");
      continue;
    }
    if (!c.db.query("SELECT 1 FROM agents WHERE agent_id = ? AND kind = 'launched' AND shadow = 0").get(x.agent)) throw bad("bad_address", "an addressee is not a launched agent");
    if (!relevant(c, agent, x.agent, board)) throw forbidden("not_relevant", "an addressee does not work on this repository or unit and has not addressed you");
    if (pairStop(c, agent, x.agent, s)) throw new ApiError(429, "talk_pair", `at most ${s.pair_per_day} messages a day to the same agent`);
  }
  const b = budgetOf(c, agent, s);
  if (!b.ok) throw new ApiError(429, "talk_rate", `conversation limit: ${b.why}`);
  if (env.thread && /^[0-9a-f]{64}$/.test(env.thread)) {
    const why = threadStop(c, agent, env.thread, s);
    if (why) throw conflict("thread_limit", why);
  }
}
