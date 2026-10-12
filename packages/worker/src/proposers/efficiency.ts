// Attempt efficiency settings for the authoring loops (docs/plans/AGENT-EFFICIENCY.md). Every
// setting is off by default, so a proposer without them behaves exactly as before; the hosted
// runtime passes them from its config (`efficiency` in runtime.json, written by site-config.ts).
// None of them changes the model, the tools the model sees, the rules in the prompt, what gets
// sealed, or how a candidate is judged.

export interface EfficiencyOptions {
  /**
   * How the per-attempt spend cap is held.
   * - "projected" (default, the rule since the audit): before each call, stop if the spend so far
   *   plus the last call's cost would pass the cap. One long thinking turn (0.2 to 0.3 USD on the
   *   site) then ends the attempt even when the cheap evaluate-and-submit turns would have fit.
   * - "bounded": each call's max_tokens is set so that its worst-case cost (input at the cache
   *   write rate for the new part, output at max_tokens) fits in what is left of the cap; the
   *   attempt stops only when that allowance falls below min_turn_tokens, or when a response is cut
   *   at the allowance. The cap still holds per call, by construction rather than by projection.
   */
  cap_mode?: "projected" | "bounded";
  /** bounded: the smallest output allowance worth a call (default 4096 tokens). */
  min_turn_tokens?: number;
  /** Log every attempt's token breakdown (in, out, cache read, cache write, calls) when it ends. Default true. */
  log_usage?: boolean;
  /**
   * Seconds after the last model call at which, while a tool is still running, the last request is
   * re-sent with max_tokens 0 to keep its 5 minute cache entry alive (bills a cache read, no output).
   * Off when absent or 0. On the site a self-evaluation took up to 6 minutes with five agents at once,
   * and the next turn wrote the whole prefix again.
   */
  keep_alive_s?: number;
  /**
   * Pacing (agent productivity lane, docs/plans/AGENT-EFFICIENCY.md section 5; needs cap_mode
   * "bounded"). On the site 150 of 263 model sessions in a day ended without an edit, and
   * the one self-evaluation that came back accepted was never submitted because the cap ended the
   * attempt first. With `pace` on: the opening message states the attempt's budget, every tool result
   * ends with one line saying what is left, the wrap-up comes in two steps (a nudge to edit and
   * evaluate at half the budget when nothing was evaluated yet, the final notice at 80%), and
   * `submit_reserve_usd` of the cap is kept back until an evaluation was accepted, so the submit
   * call that follows it always fits.
   */
  pace?: boolean;
  /** pace: USD of the attempt's cap kept for the submit call after an accepted evaluation (default 0.06). */
  submit_reserve_usd?: number;
}

export const DEFAULT_MIN_TURN_TOKENS = 4096;
/** pace: kept for the submit call (a cache read of the prefix, the evaluation result written, about 2000 output tokens). */
export const DEFAULT_SUBMIT_RESERVE_USD = 0.06;
/** pace: the smallest allowance worth the submit call once an evaluation was accepted. */
export const SUBMIT_MIN_TURN_TOKENS = 512;
/** The largest output allowance the loops ask for (the streaming default for agentic work). */
export const MAX_TURN_TOKENS = 64000;
/** Characters per token assumed for text the model has not seen yet. Code runs about 3 to 4; 2 over-counts on purpose. */
const CHARS_PER_TOKEN = 2;

export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
}

/**
 * The output allowance for the next call under cap_mode "bounded": what is left of the cap after
 * the call's worst-case input cost, in output tokens, at most MAX_TURN_TOKENS. `prefixTokens` is
 * the input the last call sent (cached by the automatic breakpoint unless `cold`); `outTokens` the
 * last call's output and `newChars` what was appended since, both written to the cache by this call.
 * Returns 0 when nothing is left.
 */
export function turnAllowance(o: {
  room: number;
  prefixTokens: number;
  outTokens?: number;
  newChars: number;
  cold: boolean;
  prices: { input: number; output: number; cache_read: number; cache_write: number };
}): number {
  const p = o.prices;
  const write = Math.max(p.cache_write, p.input);
  const inputUsd = (o.prefixTokens * (o.cold ? write : Math.max(p.cache_read, 0)) + ((o.outTokens ?? 0) + estimateTokens(o.newChars)) * write) / 1e6;
  const left = o.room - inputUsd;
  if (!(left > 0) || !(p.output > 0)) return 0;
  return Math.max(0, Math.min(MAX_TURN_TOKENS, Math.floor((left * 1e6) / p.output)));
}

/** Characters of a message content the model will read (text, tool results), for the estimate above. */
export function contentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content as Record<string, unknown>[]) {
    if (typeof b?.text === "string") n += b.text.length;
    if (typeof b?.content === "string") n += b.content.length;
    else if (Array.isArray(b?.content)) n += contentChars(b.content);
    if (b?.input !== undefined) n += JSON.stringify(b.input).length;
  }
  return n;
}

/** Hosted runtime config block: the proposer settings plus stacked authoring (worker `series`, SPEC 12.4). */
export interface RuntimeEfficiency extends EfficiencyOptions {
  /**
   * Author the next attempt on top of the agent's own pending candidate (committed with depends_on)
   * instead of on the same parent. On the site 7 of 26 hosted candidates were rejected stale_conflict:
   * the next attempt edited the same code on the parent while the last candidate was still replaying.
   */
  series?: boolean;
  /** Target spread (worker `spread`): agents on one unit are pointed at different metric targets and file advisory intents. */
  spread?: boolean;
  /**
   * USD of each attempt's cap kept back for the journal call (worker journal.ts; default 0.08). On the
   * site the call cost 0.0099 USD at the median and 0.0175 at most in 370 calls (2026-10-11/12), so
   * 0.08 kept about 0.06 of every attempt out of the authoring loop. The reserve also is the first term
   * of the minimum useful attempt (runtime minUsefulUsd).
   */
  journal_reserve_usd?: number;
  /** How long a target-spread intent lives, in seconds (worker spreadIntentTtlS; default 600, Core caps it at intent_max_ttl_s). */
  spread_intent_ttl_s?: number;
}

/** The smallest journal reserve a config may set: under it the journal call's own input estimate leaves no room for an entry. */
export const MIN_JOURNAL_RESERVE_USD = 0.02;

/** Validates a runtime `efficiency` block; returns an error message or null. */
export function efficiencyError(x: unknown): string | null {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return "efficiency must be an object";
  const e = x as Record<string, unknown>;
  for (const k of Object.keys(e)) if (!["cap_mode", "min_turn_tokens", "log_usage", "series", "keep_alive_s", "pace", "submit_reserve_usd", "spread", "journal_reserve_usd", "spread_intent_ttl_s"].includes(k)) return `efficiency.${k} is not a setting`;
  if (e.keep_alive_s !== undefined && !(typeof e.keep_alive_s === "number" && (e.keep_alive_s === 0 || (e.keep_alive_s >= 60 && e.keep_alive_s <= 290)))) return "efficiency.keep_alive_s is 0 (off) or 60 to 290 seconds";
  if (e.cap_mode !== undefined && e.cap_mode !== "projected" && e.cap_mode !== "bounded") return "efficiency.cap_mode is projected or bounded";
  if (e.min_turn_tokens !== undefined && !(Number.isInteger(e.min_turn_tokens) && (e.min_turn_tokens as number) >= 256 && (e.min_turn_tokens as number) <= MAX_TURN_TOKENS)) return `efficiency.min_turn_tokens is a whole number from 256 to ${MAX_TURN_TOKENS}`;
  if (e.submit_reserve_usd !== undefined && !(typeof e.submit_reserve_usd === "number" && e.submit_reserve_usd >= 0 && e.submit_reserve_usd <= 1)) return "efficiency.submit_reserve_usd is 0 to 1 USD";
  if (e.journal_reserve_usd !== undefined && !(typeof e.journal_reserve_usd === "number" && e.journal_reserve_usd >= MIN_JOURNAL_RESERVE_USD && e.journal_reserve_usd <= 1)) return `efficiency.journal_reserve_usd is ${MIN_JOURNAL_RESERVE_USD} to 1 USD`;
  if (e.spread_intent_ttl_s !== undefined && !(Number.isInteger(e.spread_intent_ttl_s) && (e.spread_intent_ttl_s as number) >= 60 && (e.spread_intent_ttl_s as number) <= 86400)) return "efficiency.spread_intent_ttl_s is a whole number of seconds from 60 to 86400";
  if (e.pace === true && e.cap_mode !== "bounded") return "efficiency.pace needs cap_mode bounded";
  for (const k of ["log_usage", "series", "pace", "spread"]) if (e[k] !== undefined && typeof e[k] !== "boolean") return `efficiency.${k} is true or false`;
  return null;
}
