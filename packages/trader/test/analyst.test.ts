import { describe, expect, test } from "bun:test";
import { mergeTradingConfig, TRADING_DEFAULTS } from "../../core/src/scores.ts";
import type { ModelEntry } from "../../core/src/model-registry.ts";
import { PROVIDERS } from "../../worker/src/proposers/providers.ts";
import { anthropicDecisionModel, openaiDecisionModel, systemPrompt, universe, userPrompt, type AnalysisInput } from "../src/analyst.ts";
import type { Book, Market, TokenView } from "../src/policy.ts";

// The analysis input (public data only) and the agent's model as routed: per-round cost cap, metering
// at registry rates, and usage a provider leaves out charged as the whole allowance.

const L = 1_000_000n;
const M = (i: number | string) => `Tok${i}x`.padEnd(40, "z");
const tok = (i: number, over: Partial<TokenView> = {}): TokenView => ({ mint: M(i), agent: `A${i}`, parties: [`L${i}`], price: 0.05, decimals: 6, change_24h: 0.1, venue: "sim", ...over });
const book: Book = { agent: "ME", mint: M("ME"), parties: ["LME"], line: 1000n * L, sol: 10n ** 9n, positions: {}, day: { start: 0, equity: 1000n * L, funded: 0n }, peak: 1000n * L, halted: null, blackout: false };
const cfg = mergeTradingConfig(TRADING_DEFAULTS, {});

function input(tokens: TokenView[]): AnalysisInput {
  const market: Market = { tokens, scores: new Map(tokens.map((t, i) => [t.agent, { now: 0.9 - i * 0.1, ref: null }])), lineDecimals: 6 };
  return { agent: "ME", temperament: "aggressive", temp: cfg.temperaments.aggressive, cfg, book, market, info: new Map(), components: new Map(), gens: [{ agent: "A1", at: 0, recipe_name: "minbpe", height: 3, kind: "perf", target: "encode_ir", gain_pct: 12.5 }], realized: 0n, persona: { name: "Wren", tagline: "a patient optimiser", register: "dry", values: ["measure twice"] }, now: Date.UTC(2026, 9, 10) };
}

describe("analysis input", () => {
  test("lists only tokens it may trade: never its own, a same-party agent's or an excluded agent's", () => {
    const i = input([tok(1), { ...tok(2), agent: "ME", mint: M("ME") }, tok(3, { parties: ["LME"] }), tok(4, { excluded: true }), tok(5)]);
    expect(universe(i).map((t) => t.mint)).toEqual([M(1), M(5)]);
    const u = userPrompt(i);
    expect(u).toContain(M(1));
    for (const m of [M("ME"), M(3), M(4)]) expect(u).not.toContain(m);
    expect(u).toContain("generation 3");
    const s = systemPrompt(i);
    expect(s).toContain("Wren");
    expect(s).toContain(cfg.temperaments.aggressive.prompt);
    expect(s).toContain("at most 3% per trade");
    expect(s + u).not.toMatch(/—/);
  });
});

const sonnet: ModelEntry = { id: "claude-sonnet-5-5", provider: "anthropic", name: "Sonnet", status: "verified", rate: { input: 2, output: 10, cached_input: 0.2, cache_write: 2.5 } };
const ds: ModelEntry = { id: "deepseek-chat", provider: "deepseek", name: "DeepSeek", status: "verified", rate: { input: 0.3, output: 1.2 } };

describe("the agent's model, per-round cap and metering", () => {
  test("anthropic: the output allowance follows the cap; usage priced at registry rates", async () => {
    let asked: any = null;
    const m = anthropicDecisionModel(sonnet, { messages: { create: async (p: any) => ((asked = p), { model: "claude-sonnet-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "{}" }], usage: { input_tokens: 2000, output_tokens: 500 } }) } });
    const r = await m.complete({ system: "s".repeat(3000), user: "u".repeat(3000), maxUsd: 0.05 });
    expect(asked.max_tokens).toBeLessThanOrEqual(2000);
    expect(asked.max_tokens).toBeGreaterThanOrEqual(300);
    expect(r.usage.usd).toBeCloseTo((2000 * 2 + 500 * 10) / 1e6, 9);
    expect(r.text).toBe("{}");
  });
  test("a cap too small for one call makes no call", async () => {
    let called = false;
    const m = anthropicDecisionModel(sonnet, { messages: { create: async () => ((called = true), {}) } });
    const r = await m.complete({ system: "s", user: "u", maxUsd: 0.001 });
    expect(called).toBe(false);
    expect(r.text).toBeNull();
  });
  test("openai-compatible: missing usage is charged as the whole allowance, never as zero", async () => {
    const f = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }), { status: 200 })) as unknown as typeof fetch;
    const r = await openaiDecisionModel(ds, PROVIDERS.deepseek!, "k", f).complete({ system: "s", user: "u", maxUsd: 0.05 });
    expect(r.usage.usd).toBeGreaterThan(0);
    const g = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 100 } }), { status: 200 })) as unknown as typeof fetch;
    const r2 = await openaiDecisionModel(ds, PROVIDERS.deepseek!, "k", g).complete({ system: "s", user: "u", maxUsd: 0.05 });
    expect(r2.usage.usd).toBeCloseTo((1000 * 0.3 + 100 * 1.2) / 1e6, 9);
  });
});

describe("analysis model override (owner 2026-10-10: a cheaper model for trading)", () => {
  test("the trading config's analysis_model replaces the soul's model; null keeps the soul's", async () => {
    const { routedDecisionModel } = await import("../src/analyst.ts");
    const reg = JSON.parse(await Bun.file(new URL("../../../config/models.json", import.meta.url)).text());
    const registry = { get: async () => reg };
    const soul = { model: { provider: "anthropic", id: "claude-opus-5-5" } };
    const fetchSoul = (async () => Response.json({ doc: soul })) as unknown as typeof fetch;
    const fake = () => ({ messages: { create: async () => ({}) } });
    const keys = { anthropic: "test-key" };
    const over = await routedDecisionModel({ core: "http://core.test", agent: "A", keys, registry, override: { provider: "anthropic", id: "claude-sonnet-5-5" }, anthropic: fake, fetch: fetchSoul });
    expect(over.model?.id).toBe("anthropic/claude-sonnet-5-5");
    expect(mergeTradingConfig({}).analysis_model).toEqual({ provider: "anthropic", id: "claude-sonnet-5-5" });
    expect(mergeTradingConfig({ analysis_model: null }).analysis_model).toBeNull();
    expect(() => mergeTradingConfig({ analysis_model: { provider: "Bad Provider", id: "x" } })).toThrow(/analysis_model/);
  });
});
