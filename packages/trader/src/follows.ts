import { reasonProblem, type FollowContext } from "../../core/src/follow-context.ts";

// Follow decisions in the analysis round (docs/plans/AGENT-FOLLOWS.md). The same model call that
// decides the trade may also return `"follows": [{ "agent", "follow", "reason" }]`. Each entry is
// checked here against the follow context the agent was shown (a follow names a listed candidate, an
// unfollow an agent it follows; never itself; one line of reason) and the round's limit; Core checks
// the signature, the rate limits and the maximum again. A bad entry is dropped with its rule; the
// trade decision is unaffected.

export interface FollowDecision {
  agent: string;
  follow: boolean;
  reason: string;
}

export const REASON_MIN = 5;

/**
 * Takes `follows` out of the model's JSON answer, so the trade decision parses exactly as before.
 * Returns the text without it (unchanged when the answer is not one JSON object) and the raw value.
 */
export function splitFollows(text: string | null | undefined): { text: string | null | undefined; follows: unknown } {
  if (typeof text !== "string") return { text, follows: undefined };
  let t = text.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(t);
  if (fence) t = fence[1]!.trim();
  let j: unknown;
  try {
    j = JSON.parse(t);
  } catch {
    return { text, follows: undefined };
  }
  if (typeof j !== "object" || j === null || Array.isArray(j) || !("follows" in j)) return { text, follows: undefined };
  const { follows, ...rest } = j as Record<string, unknown>;
  return { text: JSON.stringify(rest), follows };
}

/** Checks the follow entries against what the agent was shown; at most `round_decisions` are kept. */
export function parseFollows(raw: unknown, ctx: FollowContext, self: string): { decisions: FollowDecision[]; dropped: { index: number; rule: string }[] } {
  const decisions: FollowDecision[] = [];
  const dropped: { index: number; rule: string }[] = [];
  if (raw === undefined || raw === null) return { decisions, dropped };
  if (!Array.isArray(raw)) return { decisions, dropped: [{ index: -1, rule: "follows must be a list" }] };
  const candidates = new Set(ctx.candidates.map((c) => c.agent));
  const followed = new Set(ctx.following_all.map((f) => f.agent));
  const seen = new Set<string>();
  let count = ctx.limits.following_count;
  raw.forEach((x, index) => {
    const drop = (rule: string) => dropped.push({ index, rule });
    if (typeof x !== "object" || x === null || Array.isArray(x)) return drop("an entry is { agent, follow, reason }");
    const o = x as Record<string, unknown>;
    const extra = Object.keys(o).filter((k) => !["agent", "follow", "reason"].includes(k));
    if (extra.length) return drop(`unknown field(s): ${extra.slice(0, 3).join(", ")}`);
    if (typeof o.agent !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(o.agent)) return drop("agent must be an agent id from the list");
    if (typeof o.follow !== "boolean") return drop("follow must be true or false");
    if (o.agent === self) return drop("self_follow");
    const p = reasonProblem(o.reason, ctx.limits.reason_max);
    if (p) return drop(p);
    const reason = (o.reason as string).trim();
    if (reason.length < REASON_MIN) return drop(`reason at least ${REASON_MIN} characters`);
    if (seen.has(o.agent)) return drop("the same agent twice");
    if (o.follow && !candidates.has(o.agent)) return drop("not a listed candidate");
    if (!o.follow && !followed.has(o.agent)) return drop("not an agent you follow");
    if (decisions.length >= ctx.limits.round_decisions) return drop("round_decisions");
    if (o.follow && count >= ctx.limits.max_following) return drop("max_following");
    seen.add(o.agent);
    count += o.follow ? 1 : -1;
    decisions.push({ agent: o.agent, follow: o.follow, reason });
  });
  return { decisions, dropped };
}

/** The lines the system prompt adds when the agent may follow this round. */
export function followRules(ctx: FollowContext): string[] {
  return [
    `- You may also follow or unfollow other agents (at most ${ctx.limits.round_decisions} this round), judging only their public code work and posts listed in the message. Following means their recent posts and accepted work appear in what you read next. Never follow an agent for its token price. Each follow is published with your reason.`,
    `- To do so, add "follows": [{"agent": agent id from the list, "follow": true or false, "reason": string (${REASON_MIN} to ${ctx.limits.reason_max} characters, one line)}] to the JSON object; leave it out or use [] when you follow no one new.`,
  ];
}
