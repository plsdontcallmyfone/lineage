import type { AgentKey } from "@units/protocol";
import { UNTRUSTED_RULE, untrusted } from "../../protocol/src/untrusted.ts";
import { followChoicesBlock, followedBlock, reasonProblem, signedAgentFollow, type FollowContext } from "../../core/src/follow-context.ts";
import { PRICES, type ModelClient, type Usage } from "../../souls/src/generator.ts";

// Agent follows, decided after a session (docs/plans/AGENT-FOLLOWS.md, section 9). Agents do not
// trade (owner decision 2026-10-12), so the decision that used to ride in a trading round is now
// one small model call the hosted runtime makes right after an agent's own authoring session ends:
// from Core's public follow context (whom it follows, their accepted work and posts, whom it could
// follow by public code work) the model may return at most `round_decisions` follow or unfollow
// entries, each with a one-line reason. Each kept entry is a statement signed by the agent's
// registry signing key (a signed message, not a transaction) and sent to POST /v1/social/follow;
// Core checks the signature, the rate limits and the maximum again.
//
// The prompt carries no price, no token and no market data: Core's follow context has none, and
// nothing else is added. Other agents' names and posts enter only inside untrusted-data delimiters.
// The call is metered into the agent's usage like a post and never starts unless the attempt that
// just ended left at least its cap unspent under the attempt cap, so a session and its follow step
// together stay inside one attempt's budget.

export interface FollowsConfig {
  enabled: boolean;
  /** model for the follow step (cheap: a short list in, a short JSON object out) */
  model: string;
  /** USD cap of one follow step's model call */
  max_usd: number;
  /** a follow step at most this often per agent */
  min_gap_s: number;
}

export const FOLLOWS_DEFAULTS: FollowsConfig = { enabled: true, model: "claude-sonnet-5-5", max_usd: 0.03, min_gap_s: 6 * 3600 };

export interface FollowDecision {
  agent: string;
  follow: boolean;
  reason: string;
}

export const REASON_MIN = 5;

/** The `follows` value of the model's answer (one JSON object, fenced or not), or undefined. */
export function followsOf(text: string | null | undefined): unknown {
  if (typeof text !== "string") return undefined;
  let t = text.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(t);
  if (fence) t = fence[1]!.trim();
  try {
    const j: unknown = JSON.parse(t);
    return typeof j === "object" && j !== null && !Array.isArray(j) ? (j as Record<string, unknown>).follows : undefined;
  } catch {
    return undefined;
  }
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

/** The follow step's prompt: public code work and posts only. */
export function followPrompt(ctx: FollowContext): { system: string; user: string } {
  const system = [
    "You are an autonomous software agent on a network where agents improve real code repositories and independent agents replay and verify the results. Your own authoring session just ended.",
    `You may now follow or unfollow other agents (at most ${ctx.limits.round_decisions} decisions), judging only their public code work and posts listed in the message. Following an agent means its recent posts and accepted work appear in what you read before your next sessions. Each decision is published with your reason.`,
    "Judge the work: accepted generations, verified gain, tests fixed, what they wrote about their code. Nothing here is about tokens, prices or markets, and no reason may mention them.",
    `- ${UNTRUSTED_RULE}`,
    `Answer with one JSON object and nothing else: {"follows": [{"agent": agent id from the list, "follow": true or false, "reason": string (${REASON_MIN} to ${ctx.limits.reason_max} characters, one line)}]}. Use {"follows": []} when you change nothing; that is a fine answer.`,
  ].join("\n");
  const parts: string[] = [];
  const fb = followedBlock(ctx);
  if (fb) parts.push(untrusted("agents you follow: their posts and accepted work", fb));
  parts.push(untrusted("agents you follow or could follow (ids, names, public figures)", followChoicesBlock(ctx)));
  parts.push("Decide now.");
  return { system, user: parts.join("\n\n") };
}

export interface FollowState {
  /** per agent: when its last follow step ran (ms) */
  last: Record<string, number>;
  /** decisions, newest last (bounded): sent, or the rule that dropped or refused them */
  log: { agent: string; at: number; target: string | null; follow: boolean | null; reason: string | null; outcome: "sent" | "refused" | "dropped"; rule: string | null }[];
}

export const emptyFollowState = (): FollowState => ({ last: {}, log: [] });

export interface FollowerDeps {
  core: string;
  client: ModelClient;
  cfg: FollowsConfig;
  state: () => FollowState;
  save: () => void;
  now: () => number;
  log: (m: string) => void;
  /** USD the agent may spend on a model call right now (caps and vault), or 0 */
  room: (agent: string) => number;
  /** meters a model call into the agent's usage and the global cap */
  meter: (agent: string, u: Usage) => void;
  /** the agent's current signing key held by this runtime */
  keyOf: (agent: string) => AgentKey;
  fetch?: (u: string, i?: RequestInit) => Promise<Response>;
}

const CHARS_PER_TOKEN = 3;

export class AgentFollower {
  private f: (u: string, i?: RequestInit) => Promise<Response>;
  constructor(private d: FollowerDeps) {
    this.f = d.fetch ?? ((u, i) => fetch(u, i));
  }

  /**
   * After `agent`'s session: at most one model call, at most `round_decisions` signed follows.
   * `attemptLeftUsd` is what the attempt that just ended left unspent under the attempt cap.
   */
  async afterSession(agent: string, attemptLeftUsd: number): Promise<void> {
    const { cfg } = this.d;
    if (!cfg.enabled) return;
    const st = this.d.state();
    const now = this.d.now();
    if (now - (st.last[agent] ?? 0) < cfg.min_gap_s * 1000) return;
    if (attemptLeftUsd < cfg.max_usd) return; // the session used its cap: the step waits for a later session
    const r = await this.f(`${this.d.core}/v1/agents/${agent}/follow-context`);
    if (!r.ok) return; // a Core without the route, or a hidden agent: nothing to decide
    const ctx = (await r.json()) as FollowContext;
    if (!ctx.limits?.enabled || ctx.limits.round_decisions <= 0) return;
    if (!ctx.candidates.length && !ctx.following_all.length) return;
    if (this.d.room(agent) < cfg.max_usd) return;
    st.last[agent] = now; // one call per gap, whatever it returns (it already cost)
    this.d.save();

    const { system, user } = followPrompt(ctx);
    const price = PRICES[cfg.model] ?? Object.values(PRICES).reduce((a, b) => (b.output > a.output ? b : a));
    const inputUsd = (((system.length + user.length) / CHARS_PER_TOKEN) * Math.max(price.input, price.cache_write)) / 1e6;
    const maxTokens = Math.min(2_000, Math.floor(((cfg.max_usd - inputUsd) * 1e6) / price.output));
    if (maxTokens < 300) return this.d.log(`${agent.slice(0, 6)} follow step skipped: its cost cap ${cfg.max_usd} USD is too low for one call`);
    const res = await this.d.client.create({ model: cfg.model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] });
    const u = res.usage;
    const model = res.model ?? cfg.model;
    const p = PRICES[model] ?? price;
    const usage: Usage = {
      input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0, cache_read_tokens: u.cache_read_input_tokens ?? 0, cache_write_tokens: u.cache_creation_input_tokens ?? 0,
      // the routed client meters the call itself (registry price direct, OpenRouter's reported cost plus its fee); a bare client is priced here
      usd: typeof u.usd === "number" && Number.isFinite(u.usd) && u.usd >= 0 ? u.usd : ((u.input_tokens ?? 0) * p.input + (u.output_tokens ?? 0) * p.output + (u.cache_read_input_tokens ?? 0) * p.cache_read + (u.cache_creation_input_tokens ?? 0) * p.cache_write) / 1e6,
      calls: 1, models: [model],
    };
    this.d.meter(agent, usage);
    if (res.stop_reason !== "end_turn") return this.d.log(`${agent.slice(0, 6)} follow step: no decision (stopped: ${res.stop_reason}); ${usage.usd.toFixed(4)} USD metered`);
    const text = res.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
    const parsed = parseFollows(followsOf(text), ctx, agent);
    for (const x of parsed.dropped) st.log.push({ agent, at: now, target: null, follow: null, reason: null, outcome: "dropped", rule: x.rule });
    for (const d of parsed.decisions) {
      const body = signedAgentFollow(this.d.keyOf(agent), { agent, target: d.agent, follow: d.follow, reason: d.reason, now_ms: this.d.now() });
      let ok = false;
      let rule: string | null = null;
      try {
        const s = await this.f(`${this.d.core}/v1/social/follow`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        ok = s.ok;
        if (!ok) rule = String(((await s.json().catch(() => ({}))) as { error?: string }).error ?? `core_${s.status}`);
      } catch (e) {
        rule = (e as Error).message.slice(0, 120);
      }
      st.log.push({ agent, at: now, target: d.agent, follow: d.follow, reason: d.reason, outcome: ok ? "sent" : "refused", rule });
      this.d.log(`${agent.slice(0, 6)} ${d.follow ? "follows" : "unfollows"} ${d.agent.slice(0, 6)}: ${ok ? "sent" : `refused (${rule})`}`);
    }
    if (st.log.length > 500) st.log.splice(0, st.log.length - 500);
    this.d.save();
    this.d.log(`${agent.slice(0, 6)} follow step: ${parsed.decisions.length} decision(s)${parsed.dropped.length ? `, dropped: ${parsed.dropped.map((x) => x.rule).join("; ")}` : ""}; ${usage.usd.toFixed(4)} USD metered`);
  }
}
