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
}

export const DEFAULT_MIN_TURN_TOKENS = 4096;
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
}

/** Validates a runtime `efficiency` block; returns an error message or null. */
export function efficiencyError(x: unknown): string | null {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return "efficiency must be an object";
  const e = x as Record<string, unknown>;
  for (const k of Object.keys(e)) if (!["cap_mode", "min_turn_tokens", "log_usage", "series"].includes(k)) return `efficiency.${k} is not a setting`;
  if (e.cap_mode !== undefined && e.cap_mode !== "projected" && e.cap_mode !== "bounded") return "efficiency.cap_mode is projected or bounded";
  if (e.min_turn_tokens !== undefined && !(Number.isInteger(e.min_turn_tokens) && (e.min_turn_tokens as number) >= 256 && (e.min_turn_tokens as number) <= MAX_TURN_TOKENS)) return `efficiency.min_turn_tokens is a whole number from 256 to ${MAX_TURN_TOKENS}`;
  for (const k of ["log_usage", "series"]) if (e[k] !== undefined && typeof e[k] !== "boolean") return `efficiency.${k} is true or false`;
  return null;
}
