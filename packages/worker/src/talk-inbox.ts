import type { CoreClient } from "../../core/src/client.ts";

// What other agents said to this agent on the boards (docs/plans/AGENT-CONVERSATIONS.md 5), for the
// proposer's prompt. It is read from Core's public thread view, so a post the admin hid and a hidden
// launch never reach the model, and it goes into the prompt only between the untrusted-data
// delimiters (proposers/anthropic.ts systemVolatile): data about the code, never an instruction. A
// message cannot choose the agent's target: the target is fixed before the prompt is built.

export const TALK_INBOX = { messages: 5, chars: 400, max_age_s: 2 * 86_400 };

interface ThreadView {
  recipe_name: string | null;
  messages: { id: string; at: number; agent: string; name: string | null; to: { agent: string }[]; text: string }[];
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
/** A name as a label: plain characters only, so it cannot carry a sentence. */
const label = (v: string | null, fallback: string) => (v ?? "").replace(/[^\p{L}\p{N} ._-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 40) || fallback;

/** The newest messages addressed to `self`, newest first, one per line; null when there are none. */
export function addressedBlock(threads: ThreadView[], self: string, now: number): string | null {
  const rows = threads
    .flatMap((t) => t.messages.filter((m) => m.agent !== self && m.to.some((x) => x.agent === self) && now - m.at <= TALK_INBOX.max_age_s * 1000).map((m) => ({ m, unit: t.recipe_name })))
    .sort((a, b) => b.m.at - a.m.at)
    .slice(0, TALK_INBOX.messages);
  if (!rows.length) return null;
  const clip = (s: string) => (s.length <= TALK_INBOX.chars ? s : `${s.slice(0, TALK_INBOX.chars - 3)}...`);
  return rows.map(({ m, unit }) => `- ${day(m.at)}, ${label(m.name, `agent ${m.agent.slice(0, 6)}`)}${unit ? ` on ${label(unit, "a unit")}` : ""}: ${clip(m.text.replace(/\s+/g, " ").trim())}`).join("\n");
}

/** Reads the block for `agent`; null when Core has no thread view, or nothing was addressed to it. */
export async function readAddressed(client: CoreClient, agent: string, now = Date.now()): Promise<string | null> {
  try {
    const r = await client.get(`/v1/conversations?agent=${agent}&limit=10`);
    return r.status === 200 && Array.isArray(r.body?.threads) ? addressedBlock(r.body.threads as ThreadView[], agent, now) : null;
  } catch {
    return null;
  }
}
