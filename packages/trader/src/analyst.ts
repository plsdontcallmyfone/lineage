import Anthropic from "@anthropic-ai/sdk";
import { rateFor, usdFor, type ModelEntry, type TokenUsage } from "../../core/src/model-registry.ts";
import type { TemperamentParams, TradingConfig } from "../../core/src/scores.ts";
import type { ProviderSpec } from "../../worker/src/proposers/providers.ts";
import { normaliseUsage } from "../../worker/src/proposers/openai-compat.ts";
import { resolveRoute, RegistrySource, soulModel } from "../../runtime/src/providers.ts";
import { equityOf, valueOf, type Book, type Market, type ModelDecision, type TokenView } from "./policy.ts";

// The agent's own analysis (plan T, owner amendment 2026-10-10). Each round the agent's model (the
// one its soul names, through the runtime's provider routing: Anthropic natively, other providers
// through OpenAI-compatible chat completions) reads public data only and returns a thesis and one
// structured decision. The model decides; it never enforces: its output is checked by the engine
// (policy.ts parseDecision, enforceDecision), and an invalid or out-of-limit decision is refused.
//
// Public data only (author-blind, SPEC 10.7): the market as the indexer serves it, the published
// project scores, other agents' final accepted generations from the public feed, their repositories
// and recipes, and the agent's own treasury and positions. Never an open candidate, a sealed session
// or anything about its own pending work.

/** Model usage in the shape the runtime meters (souls Usage). */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  usd: number;
  calls: number;
  models: string[];
}
export const emptyUsage = (): Usage => ({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, usd: 0, calls: 0, models: [] });

export interface DecisionModel {
  /** provider/model, for the record */
  readonly id: string;
  /** one completion, its cost bounded by `maxUsd` (the output allowance is sized from it) */
  complete(o: { system: string; user: string; maxUsd: number }): Promise<{ text: string | null; usage: Usage; error?: string }>;
}

/** Extra public market figures the analysis shows per token (from the indexer). */
export interface MarketInfo {
  symbol: string | null;
  phase: string | null;
  volume_24h: number | null;
  trades_24h: number | null;
  holders: number | null;
  curve_progress: number | null;
  repo_url: string | null;
  class: string | null;
  lineage_id: string | null;
}

export interface PublicGen {
  agent: string;
  at: number;
  recipe_name: string | null;
  height: number;
  kind: string;
  target: unknown;
  gain_pct: number;
}

export interface AnalysisInput {
  agent: string;
  temperament: string;
  temp: TemperamentParams;
  cfg: TradingConfig;
  book: Book;
  market: Market;
  info: Map<string, MarketInfo>;
  /** published score components per agent (GET /v1/scores) */
  components: Map<string, Record<string, { raw: number | null }>>;
  gens: PublicGen[];
  /** realized P&L so far in base units (public trade records) */
  realized: bigint;
  /** the agent's persona from its public soul, if any */
  persona: { name: string; tagline: string; register: string; values: string[] } | null;
  now: number;
}

const n4 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : Number(x.toPrecision(4)).toString());
const line = (base: bigint, dec: number) => (Number(base) / 10 ** dec).toFixed(2);

/** The tokens the agent may consider: tradable, not its own, not a same-party agent's, not excluded; best project scores first. */
export function universe(i: AnalysisInput): TokenView[] {
  const mine = new Set(i.book.parties);
  return i.market.tokens
    .filter((t) => t.venue && t.price !== null && t.agent !== i.agent && t.mint !== i.book.mint && !t.excluded && !t.parties.some((p) => mine.has(p)))
    .sort((a, b) => (i.market.scores.get(b.agent)?.now ?? 0) - (i.market.scores.get(a.agent)?.now ?? 0) || (a.mint < b.mint ? -1 : 1))
    .slice(0, i.cfg.analysis_tokens);
}

export function systemPrompt(i: AnalysisInput): string {
  const p = i.persona;
  return [
    p ? `You are ${p.name}, ${p.tagline}. Voice: ${p.register}. Values: ${p.values.slice(0, 5).join(", ")}.` : "You are a hosted Lineage agent.",
    "Lineage agents improve real open-source code; each has a token that trades on devnet in TEST tLINE. You also manage a trading treasury and trade other agents' tokens actively, in both directions: back agents whose public work is strong and getting stronger, take profit on positions that have run up, and trim or exit positions whose project score or recent accepted work has weakened, rotating into stronger ones. Holding is fine when nothing has changed, but do not only buy.",
    `Temperament: ${i.temp.prompt}`,
    "Rules you must follow:",
    "- Use only the facts in the message. Never invent numbers, events or people. Never mention anyone's unfinished or pending work.",
    "- Decide one thing this round: buy one token, sell part or all of one position, or hold.",
    `- A buy is sized in percent of your treasury equity; yours may be at most ${i.temp.size_bps / 100}% per trade (the engine refuses anything larger; it never resizes). A sell is sized in percent of that position.`,
    "- The engine also refuses trades that break a limit listed in the message; a refused decision is published with the rule that refused it.",
    "- Your thesis and reason are published after the round. Write them plainly, in your voice, without em dashes.",
    'Answer with exactly one JSON object and nothing else: {"thesis": string (20 to 1200 characters), "action": "buy" | "sell" | "hold", "token": mint address from the list or null for hold, "size_pct": number (above 0 and at most 100 with two decimals at most; 0 for hold), "reason": string (5 to 280 characters)}.',
  ].join("\n");
}

export function userPrompt(i: AnalysisInput): string {
  const dec = i.market.lineDecimals;
  const eq = equityOf(i.book, i.market);
  const cfg = i.cfg;
  const out: string[] = [];
  out.push(`Time: ${new Date(i.now).toISOString()}`);
  out.push(`Your treasury: ${line(i.book.line, dec)} tLINE cash, equity ${line(eq, dec)} tLINE, realized P&L so far ${line(i.realized, dec)} tLINE.`);
  const pos = Object.values(i.book.positions).filter((p) => p.qty > 0n);
  if (pos.length) {
    out.push("Your positions:");
    for (const p of pos) {
      const t = i.market.tokens.find((x) => x.mint === p.mint);
      const mark = t ? valueOf(p.qty, t.price, t.decimals, dec) : 0n;
      const sym = i.info.get(p.mint)?.symbol ?? p.mint.slice(0, 6);
      out.push(`- ${sym} ${p.mint}: value ${line(mark, dec)} tLINE, cost ${line(p.cost, dec)} tLINE, ${p.cost > 0n ? `${n4((Number(mark - p.cost) / Number(p.cost)) * 100)}%` : "n/a"} since bought; last ${p.last_side} ${Math.round((i.now - p.last_at) / 60000)} min ago`);
    }
  } else out.push("Your positions: none.");
  out.push(
    `Limits the engine enforces: per trade at most ${cfg.max_trade_bps / 100}% of equity (and your temperament's ${i.temp.size_bps / 100}%); per token at most ${cfg.max_position_bps / 100}% of equity; at most ${cfg.max_open_positions} open positions; ${cfg.cooldown_s / 60} min between trades in the same token; ${cfg.min_hold_s / 60} min before the opposite side in the same token; stop-loss ${cfg.stop_loss_bps / 100}% and take-profit ${cfg.take_profit_bps / 100}% run automatically; slippage at most ${cfg.max_slippage_bps / 100}% and price impact at most ${cfg.max_impact_bps / 100}%; minimum trade ${line(BigInt(cfg.min_trade_line), dec)} tLINE.`,
  );
  out.push("Tokens you may trade (public data; project score 0 to 1 from final accepted work):");
  const gensBy = new Map<string, PublicGen[]>();
  for (const g of i.gens) (gensBy.get(g.agent) ?? gensBy.set(g.agent, []).get(g.agent)!).push(g);
  for (const t of universe(i)) {
    const info = i.info.get(t.mint);
    const sc = i.market.scores.get(t.agent);
    const comp = i.components.get(t.agent);
    const gs = (gensBy.get(t.agent) ?? []).slice(0, 2);
    out.push(
      [
        `- ${info?.symbol ?? "?"} ${t.mint} (agent ${t.agent.slice(0, 8)}, ${info?.repo_url ?? "repo n/a"}${info?.class ? `, ${info.class}` : ""})`,
        `  score ${n4(sc?.now)}${sc?.ref !== null && sc?.ref !== undefined ? ` (was ${n4(sc.ref)})` : ""}; accepted generations ${comp?.accepted_generations?.raw ?? "n/a"}; verified gain 7 d ${n4(comp?.verified_gain_7d?.raw)}; acceptance rate ${n4(comp?.acceptance_rate?.raw)}; sessions 24 h ${comp?.sessions_24h?.raw ?? "n/a"}`,
        `  price ${n4(t.price)} tLINE; 24 h change ${t.change_24h === null ? "n/a" : `${n4(t.change_24h * 100)}%`}; 24 h volume ${n4(info?.volume_24h)} tLINE in ${info?.trades_24h ?? "n/a"} trades; holders ${info?.holders ?? "n/a"}; ${info?.phase === "graduated" ? "graduated (DAMM v2)" : `curve progress ${n4((info?.curve_progress ?? 0) * 100)}%`}`,
        ...gs.map((g) => `  accepted ${Math.round((i.now - g.at) / 3600000)} h ago: ${g.recipe_name ?? "lineage"} generation ${g.height}, ${g.kind} on ${typeof g.target === "string" ? g.target : JSON.stringify(g.target)}, gain ${n4(g.gain_pct)}%`),
      ].join("\n"),
    );
  }
  out.push("Decide now. One JSON object only.");
  return out.join("\n");
}

// ------------------------------------------------------------------------------------------------
// The model, routed like the agent's authoring (packages/runtime/src/providers.ts)

const CHARS_PER_TOKEN = 3;

function outputAllowance(m: ModelEntry, system: string, user: string, maxUsd: number): { maxTokens: number; rate: NonNullable<ReturnType<typeof rateFor>> } | null {
  const promptTokens = Math.ceil((system.length + user.length) / CHARS_PER_TOKEN);
  const rate = rateFor(m, new Date(), promptTokens);
  if (!rate) return null;
  const inputUsd = (promptTokens * Math.max(rate.input, rate.cache_write ?? 0)) / 1e6;
  const maxTokens = Math.min(2000, Math.floor(((maxUsd - inputUsd) * 1e6) / rate.output));
  return maxTokens >= 300 ? { maxTokens, rate } : null;
}

export function anthropicDecisionModel(m: ModelEntry, client: { messages: { create(p: any): Promise<any> } }): DecisionModel {
  return {
    id: `anthropic/${m.id}`,
    async complete(o) {
      const usage = emptyUsage();
      const a = outputAllowance(m, o.system, o.user, o.maxUsd);
      if (!a) return { text: null, usage, error: "the round's cost cap is too low for one call" };
      const res = await client.messages.create({ model: m.id, max_tokens: a.maxTokens, system: o.system, messages: [{ role: "user", content: o.user }] });
      const u: TokenUsage = { input_tokens: res.usage?.input_tokens ?? 0, output_tokens: res.usage?.output_tokens ?? 0, cache_read_tokens: res.usage?.cache_read_input_tokens ?? 0, cache_write_tokens: res.usage?.cache_creation_input_tokens ?? 0 };
      Object.assign(usage, u, { usd: usdFor(a.rate, u), calls: 1, models: [res.model ?? m.id] });
      if (res.stop_reason !== "end_turn") return { text: null, usage, error: `stopped: ${res.stop_reason}` };
      return { text: (res.content as { type: string; text?: string }[]).filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim(), usage };
    },
  };
}

export function openaiDecisionModel(m: ModelEntry, p: ProviderSpec, key: string, f: typeof fetch = fetch): DecisionModel {
  return {
    id: `${p.id}/${m.id}`,
    async complete(o) {
      const usage = emptyUsage();
      const a = outputAllowance(m, o.system, o.user, o.maxUsd);
      if (!a) return { text: null, usage, error: "the round's cost cap is too low for one call" };
      const r = await f(`${p.base_url.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: m.id, messages: [{ role: "system", content: o.system }, { role: "user", content: o.user }], [p.token_param ?? "max_tokens"]: a.maxTokens, ...(p.extra_body ?? {}) }),
      });
      const j = (await r.json().catch(() => null)) as any;
      if (!r.ok || !j) return { text: null, usage, error: `${p.id}: HTTP ${r.status}` };
      const nu = normaliseUsage(j.usage);
      // usage the provider did not report is charged as the whole allowance, never as zero
      const u: TokenUsage = nu.bad ? { input_tokens: Math.ceil((o.system.length + o.user.length) / CHARS_PER_TOKEN), output_tokens: a.maxTokens, cache_read_tokens: 0, cache_write_tokens: 0 } : nu.usage;
      Object.assign(usage, u, { usd: usdFor(a.rate, u), calls: 1, models: [m.id] });
      const c = j.choices?.[0];
      if (c?.finish_reason && c.finish_reason !== "stop") return { text: null, usage, error: `stopped: ${c.finish_reason}` };
      return { text: typeof c?.message?.content === "string" ? c.message.content.trim() : null, usage };
    },
  };
}

/** The agent's model from its soul, or null with why (a provider without a key is never substituted). */
export async function routedDecisionModel(o: { core: string; agent: string; keys: Record<string, string>; registry: RegistrySource; override?: { provider: string; id: string } | null; anthropic?: (key: string) => { messages: { create(p: any): Promise<any> } }; fetch?: typeof fetch }): Promise<{ model: DecisionModel } | { model: null; why: string }> {
  const choice = o.override ?? (await soulModel(o.core, o.agent, o.fetch));
  const r = resolveRoute(await o.registry.get(), choice as Parameters<typeof resolveRoute>[1], o.keys);
  if (!r.ok) return { model: null, why: r.why };
  if (r.provider.adapter === "anthropic") return { model: anthropicDecisionModel(r.model, o.anthropic ? o.anthropic(r.key) : new Anthropic({ apiKey: r.key, maxRetries: 2 })) };
  return { model: openaiDecisionModel(r.model, r.provider, r.key, o.fetch) };
}

export type { ModelDecision };
