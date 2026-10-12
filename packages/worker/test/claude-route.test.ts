import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRegistry } from "../../core/src/model-registry.ts";
import { claudeRoute } from "../src/proposers/claude-route.ts";

// A Claude call outside the hosted runtime (self-hosted worker with --proposer anthropic, discovery
// and recipe drafting tools, local proof scripts) takes the same route as inside it.

const REG: ModelRegistry = JSON.parse(readFileSync(join(import.meta.dir, "../../../config/models.json"), "utf8"));

describe("claudeRoute", () => {
  test("with the OpenRouter key: its Anthropic Messages endpoint, the model's OpenRouter id and listed price, the fee and the provider preferences", () => {
    const r = claudeRoute("claude-opus-5-5", { registry: REG, keys: { anthropic: "sk-a", openrouter: "sk-or" } })!;
    expect(r).toMatchObject({ via: "openrouter", chosen: "claude-opus-5-5", model: "anthropic/claude-opus-5.5", prices: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 } });
    expect(r.client.baseURL).toBe("https://openrouter.ai/api");
    expect(r.gateway).toEqual({ provider: "openrouter", fee_factor: 1.055, reported_cost: true, request_extra: { provider: { order: ["anthropic"], max_price: { prompt: 4, completion: 20 } } }, model_as: "claude-opus-5-5" });
    const h = claudeRoute("claude-haiku-4-5", { registry: REG, keys: { openrouter: "sk-or" } })!;
    expect(h).toMatchObject({ model: "anthropic/claude-haiku-4.5", gateway: { model_as: "claude-haiku-4-5" } });
  });

  test("without it: Anthropic's own API at the registry price, no gateway; prefer direct does the same with both keys", () => {
    const r = claudeRoute("claude-opus-5-5", { registry: REG, keys: { anthropic: "sk-a" } })!;
    expect(r).toMatchObject({ via: "direct", model: "claude-opus-5-5", gateway: null });
    expect(r.client.baseURL).toBe("https://api.anthropic.com");
    const old = structuredClone(REG);
    old.routing!.prefer = "direct";
    expect(claudeRoute("claude-opus-5-5", { registry: old, keys: { anthropic: "sk-a", openrouter: "sk-or" } })!.via).toBe("direct");
  });

  test("no key, no registry, or a model the registry does not list as Claude: no route (the caller keeps its own client)", () => {
    expect(claudeRoute("claude-opus-5-5", { registry: REG, keys: {} })).toBeNull();
    expect(claudeRoute("claude-opus-5-5", { registry: null, keys: { openrouter: "k" } })).toBeNull();
    expect(claudeRoute("gpt-5.5", { registry: REG, keys: { openrouter: "k" } })).toBeNull();
    expect(claudeRoute("claude-opus-4-8", { registry: REG, keys: { openrouter: "k" } })).toBeNull();
  });
});
