import { sha256Hex } from "@lineage/protocol";
import { wrapUpNotice } from "./budget.ts";
import type { Proposal, ProposeContext, Proposer } from "./types.ts";
import { clip } from "../session.ts";
import { openingMessage, systemPrompt, ToolBox, TOOLS } from "./anthropic.ts";
import { rateFor, usdFor, type ModelEntry, type TokenUsage } from "../../../core/src/model-registry.ts";
import type { ProviderSpec } from "./providers.ts";

// OpenAI-compatible authoring loop (plan M): chat completions with function tools, for every
// provider that speaks that dialect (OpenAI, Google's OpenAI compatibility layer, DeepSeek, Alibaba
// Model Studio international, Moonshot, Zhipu Z.ai, MiniMax). The tool set, the system prompt and the
// path-confined ToolBox are the Anthropic proposer's, so a candidate means the same thing whichever
// model wrote it; only the wire format differs. Every response is metered at the model registry's
// price (peak clock and input tiers included) against the attempt's hard cap.

export const OPENAI_PROPOSER_VERSION = "openai-compat/1";

/** The Anthropic tool set as OpenAI function tools (same names, descriptions and JSON schemas). */
export const FUNCTION_TOOLS = TOOLS.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description ?? "", parameters: t.input_schema } }));

/** Which harness produced a candidate: tool set and prompt template, plus this adapter's version. */
export const OPENAI_HARNESS_DIGEST = sha256Hex(new TextEncoder().encode(JSON.stringify({ v: OPENAI_PROPOSER_VERSION, tools: FUNCTION_TOOLS, prompt: systemPrompt.toString() })));

export interface OpenAICompatOptions {
  provider: ProviderSpec;
  apiKey: string;
  /** registry entry of the model (its id is what is requested, its rates what is charged) */
  model: ModelEntry;
  max_usd: number;
  max_turns?: number;
  max_evals?: number;
  /** output allowance per response */
  max_tokens?: number;
  fetch?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/** An error the provider answered with (HTTP status and its message; never the request). */
export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(`${provider}: HTTP ${status}${code ? ` ${code}` : ""}: ${message}`);
  }
  get retryable() {
    return this.status === 429 || this.status >= 500;
  }
}

interface ToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
  [k: string]: unknown;
}
interface ChatMessage {
  role: string;
  content: string | null;
  tool_calls?: ToolCall[];
  reasoning_content?: string | null;
  [k: string]: unknown;
}
interface ChatResponse {
  model?: string;
  choices?: { message?: ChatMessage; finish_reason?: string | null }[];
  usage?: Record<string, unknown> | null;
  error?: { message?: string; code?: string | number; type?: string };
  base_resp?: { status_code?: number; status_msg?: string };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

/**
 * Normalises a chat completions usage object. Cached prompt tokens are read from whichever field the
 * provider uses (prompt_tokens_details.cached_tokens, prompt_cache_hit_tokens, cached_tokens). Output
 * is the larger of completion_tokens and total - prompt, so reasoning tokens a provider leaves out of
 * completion_tokens are still charged. `bad` when the counts are missing or not numbers.
 */
export function normaliseUsage(u: Record<string, unknown> | null | undefined): { usage: TokenUsage; bad: boolean; prompt: number } {
  const prompt = num(u?.prompt_tokens);
  const completion = num(u?.completion_tokens);
  const total = num(u?.total_tokens);
  if (prompt === null || completion === null) return { usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, bad: true, prompt: 0 };
  const details = (u?.prompt_tokens_details ?? null) as Record<string, unknown> | null;
  const cached = Math.min(prompt, num(details?.cached_tokens) ?? num(u?.prompt_cache_hit_tokens) ?? num(u?.cached_tokens) ?? 0);
  // explicit cache writes (OpenAI, Moonshot: cache_write_tokens; Alibaba: cache_creation_input_tokens) are part of the prompt
  const written = Math.min(prompt - cached, num(details?.cache_write_tokens) ?? num(details?.cache_creation_input_tokens) ?? num(u?.cache_write_tokens) ?? 0);
  const output = Math.max(completion, total !== null ? total - prompt : 0);
  return { usage: { input_tokens: prompt - cached - written, output_tokens: output, cache_read_tokens: cached, cache_write_tokens: written }, bad: false, prompt };
}

/** The provider's error message, from the OpenAI shape or MiniMax's base_resp. */
function errorOf(status: number, body: unknown): { code: string | null; message: string } {
  const b = body as ChatResponse | null;
  if (b?.error) return { code: b.error.code !== undefined ? String(b.error.code) : (b.error.type ?? null), message: String(b.error.message ?? "error") };
  if (b?.base_resp && b.base_resp.status_code) return { code: String(b.base_resp.status_code), message: String(b.base_resp.status_msg ?? "error") };
  return { code: null, message: typeof body === "string" ? body.slice(0, 300) : `HTTP ${status}` };
}

export class OpenAICompatProposer implements Proposer {
  readonly name: string;
  private o: Required<Omit<OpenAICompatOptions, "fetch" | "now" | "sleep">> & Pick<OpenAICompatOptions, "fetch" | "now" | "sleep">;

  constructor(opts: OpenAICompatOptions) {
    if (opts.model.provider !== opts.provider.id) throw new Error(`model ${opts.model.id} belongs to ${opts.model.provider}, not ${opts.provider.id}`);
    if (opts.model.status !== "verified" || !opts.model.rate) throw new Error(`model ${opts.model.id} has no registry price; it cannot be metered`);
    this.name = `openai-compat:${opts.provider.id}`;
    this.o = { max_turns: 40, max_evals: 4, max_tokens: opts.provider.max_tokens ?? 32000, ...opts };
  }

  private async call(body: Record<string, unknown>): Promise<ChatResponse> {
    const f = this.o.fetch ?? fetch;
    const p = this.o.provider;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    let last: ProviderError | null = null;
    for (let i = 0; i < 3; i++) {
      if (i) await sleep(1000 * 3 ** (i - 1));
      const r = await f(`${p.base_url.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.o.apiKey}` },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      let j: unknown = text;
      try {
        j = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      // MiniMax reports some errors as HTTP 200 with base_resp.status_code != 0
      const br = (j as ChatResponse | null)?.base_resp;
      if (r.ok && !(br && br.status_code)) return j as ChatResponse;
      const e = errorOf(r.status, j);
      last = new ProviderError(p.id, r.ok ? 400 : r.status, e.code, e.message);
      if (!last.retryable) throw last;
    }
    throw last!;
  }

  async propose(ctx: ProposeContext): Promise<Proposal | null> {
    const o = this.o;
    const p = o.provider;
    const cap = Math.min(o.max_usd, ctx.maxUsd ?? Infinity);
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, usd: 0 };
    let lastTurnUsd = 0;
    let warned = false;
    const tag = `${p.id}`;
    try {
      ctx.meter?.harness?.({ name: "openai-compat", version: OPENAI_PROPOSER_VERSION, digest: OPENAI_HARNESS_DIGEST, provider: p.id });
    } catch {
      /* ignore */
    }
    const meter = (raw: Record<string, unknown> | null | undefined, model: string) => {
      const n = normaliseUsage(raw);
      const rate = rateFor(o.model, (o.now ?? (() => new Date()))(), n.prompt)!;
      let usd = usdFor(rate, n.usage);
      // a response without usable counts is charged the rest of the cap, so the attempt stops (as audit A2, OFF-K4)
      if (n.bad) usd = Math.max(usd, cap - usage.usd, 0);
      usage.input_tokens += n.usage.input_tokens;
      usage.output_tokens += n.usage.output_tokens;
      usage.cache_read_tokens += n.usage.cache_read_tokens;
      usage.cache_write_tokens += n.usage.cache_write_tokens;
      usage.usd += usd;
      lastTurnUsd = usd;
      try {
        ctx.meter?.model({ ...n.usage, usd, model });
      } catch {
        /* metering must not change what the model sees */
      }
    };
    const tools = new ToolBox(ctx, o.max_evals);
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt(ctx) },
      { role: "user", content: openingMessage(ctx) },
    ];

    for (let turn = 0; turn < o.max_turns; turn++) {
      if (usage.usd >= cap || usage.usd + lastTurnUsd > cap) {
        ctx.log(`${tag}: spend cap reached (${usage.usd.toFixed(4)} USD spent, cap ${cap.toFixed(4)})`);
        return null;
      }
      const body: Record<string, unknown> = {
        model: o.model.id,
        messages,
        tools: FUNCTION_TOOLS,
        tool_choice: "auto",
        [p.token_param ?? "max_tokens"]: o.max_tokens,
        ...(p.extra_body ?? {}),
      };
      const res = await this.call(body);
      meter(res.usage, res.model ?? o.model.id);
      const choice = res.choices?.[0];
      const msg = choice?.message;
      if (!msg) throw new ProviderError(p.id, 502, null, "response has no choices");
      if (choice.finish_reason === "content_filter") {
        ctx.log(`${tag}: refusal (content_filter)`);
        return null;
      }
      const text = typeof msg.content === "string" ? msg.content : "";
      if (text.trim()) tools.session({ kind: "note", text: clip(text.replace(/<think>[\s\S]*?<\/think>/g, "").trim() || text, 8000).text });
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if (calls.length === 0) {
        ctx.log(`${tag}: ended without submit`);
        return null;
      }
      if (choice.finish_reason === "length") throw new Error("tool input truncated at max_tokens");
      // the assistant turn goes back as the provider sent it: tool_calls verbatim (Gemini's thought
      // signatures ride on them), the reasoning only where the provider requires it in a tool loop
      const back: ChatMessage = { role: "assistant", content: msg.content ?? null, tool_calls: calls };
      if (p.echo_reasoning && typeof msg.reasoning_content === "string") back.reasoning_content = msg.reasoning_content;
      messages.push(back);
      let submitted: Proposal | null = null;
      let gaveUp = false;
      for (const call of calls) {
        let input: Record<string, unknown>;
        try {
          const parsed = JSON.parse(call.function?.arguments || "{}");
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
          input = parsed;
        } catch {
          messages.push({ role: "tool", tool_call_id: call.id, content: "error: the arguments were not a valid JSON object; call the tool again" });
          continue;
        }
        const name = call.function?.name;
        let out: string;
        if (name === "submit") {
          const v = tools.validateSubmit(input);
          if (v.ok) {
            submitted = { kind: v.kind, target: v.kind === "fix" ? [v.target] : v.target, rationale: String(input.rationale ?? ""), claimed_effect: v.ratio };
            tools.session({ kind: "submit", reason: clip(String(input.rationale ?? ""), 4000).text });
            out = "submitted";
          } else out = `error: ${v.error}`;
        } else if (name === "give_up") {
          ctx.log(`${tag}: gave up: ${String(input.reason ?? "")}`);
          tools.report({ kind: "give_up" });
          tools.session({ kind: "give_up", reason: clip(String(input.reason ?? ""), 4000).text });
          gaveUp = true;
          out = "ok";
        } else {
          try {
            out = await tools.run(String(name), input);
          } catch (e) {
            out = `error: ${(e as Error).message}`;
          }
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: out });
      }
      if (submitted) return { ...submitted, usage };
      if (gaveUp) return null;
      const notice = warned ? null : wrapUpNotice(usage.usd, cap, lastTurnUsd);
      if (notice) {
        warned = true;
        messages.push({ role: "user", content: notice });
        ctx.log(`${tag}: budget wrap-up notice sent`);
      }
      ctx.log(`${tag}: turn ${turn + 1}, ${usage.usd.toFixed(4)} USD so far`);
    }
    ctx.log(`${tag}: turn limit reached`);
    return null;
  }
}
