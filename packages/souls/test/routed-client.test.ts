import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRegistry } from "../../core/src/model-registry.ts";
import { composeInVoice, generateSoul } from "../src/generator.ts";
import { envProviderKeys, isCreditError, ModelRouteError, routedModelClient, type MessagesSdk } from "../src/routed-client.ts";
import { persona, SEED, soul } from "./fixtures.ts";

// Every small Claude call of the product (soul drafts, posts, the follow step, voice text) follows
// the registry's route rule: OpenRouter first, the model's own provider only without the OpenRouter
// key, metered at what the route charged; a provider without credit is left alone for a while.

const REG: ModelRegistry = JSON.parse(readFileSync(join(import.meta.dir, "../../../config/models.json"), "utf8"));
const sonnet = REG.models.find((m) => m.provider === "anthropic" && m.id === "claude-sonnet-5-5")!;
const FEE = 1.055;

function fakeSdk(reply: (params: any, r: { via: string; provider: { id: string }; key: string }) => any) {
  const calls: { via: string; provider: string; key: string; params: any }[] = [];
  const sdk = (r: { via: string; provider: { id: string }; key: string }): MessagesSdk => ({
    async create(params) {
      calls.push({ via: r.via, provider: r.provider.id, key: r.key, params });
      return reply(params, r);
    },
  });
  return { calls, sdk: sdk as never };
}
const answer = (model: string, usage: Record<string, number>, text = "ok") => ({ model, provider: "Anthropic", stop_reason: "end_turn", content: [{ type: "text", text }], usage });
const REQ = { model: "claude-sonnet-5-5", max_tokens: 1000, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", thinking: { type: "adaptive" }, output_config: { effort: "low" }, system: "s", messages: [{ role: "user", content: "u" }] };

describe("routed model client", () => {
  test("with both keys the call goes to OpenRouter: its id and key, no Anthropic-only fields, Anthropic's endpoint first under the listed price; metered at the reported cost x fee", async () => {
    const f = fakeSdk(() => answer("anthropic/claude-sonnet-5.5", { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost: 0.003 }));
    const routes: any[] = [];
    const c = routedModelClient({ registry: () => REG, keys: { anthropic: "sk-a", openrouter: "sk-or" }, sdk: f.sdk, onRoute: (r) => routes.push(r) });
    const res = await c.create(REQ);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ via: "openrouter", provider: "openrouter", key: "sk-or" });
    const p = f.calls[0]!.params;
    expect(p.model).toBe("anthropic/claude-sonnet-5.5");
    expect(p.betas).toBeUndefined();
    expect(p.fallbacks).toBeUndefined();
    expect(p.provider).toEqual({ order: ["anthropic"], max_price: { prompt: 2, completion: 10 } });
    expect(p.thinking).toEqual({ type: "adaptive" });
    expect(p.output_config).toEqual({ effort: "low" });
    expect(res.model).toBe("claude-sonnet-5-5"); // callers see the registry id
    expect(res.usage.usd).toBeCloseTo(0.003 * FEE, 12);
    expect(routes[0]).toMatchObject({ model: "claude-sonnet-5-5", via: "openrouter", provider: "openrouter", requested: "anthropic/claude-sonnet-5.5", upstream: "Anthropic" });
  });

  test("without a reported cost: OpenRouter's listed price, cache reads and writes at their own rates, x fee", async () => {
    const f = fakeSdk(() => answer("anthropic/claude-sonnet-5.5", { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 400 }));
    const c = routedModelClient({ registry: () => REG, keys: { openrouter: "sk-or" }, sdk: f.sdk });
    const r = sonnet.routes!.openrouter!.rate;
    const list = (1000 * r.input + 200 * r.output + 5000 * r.cached_input! + 400 * r.cache_write!) / 1e6;
    expect((await c.create(REQ)).usage.usd).toBeCloseTo(list * FEE, 12);
  });

  test("without the OpenRouter key the model's own provider runs it, request unchanged, at the registry price with no fee; prefer direct does the same with both keys", async () => {
    const f = fakeSdk(() => answer("claude-sonnet-5-5", { input_tokens: 1000, output_tokens: 200 }));
    const c = routedModelClient({ registry: () => REG, keys: { anthropic: "sk-a" }, sdk: f.sdk });
    const res = await c.create(REQ);
    expect(f.calls[0]).toMatchObject({ via: "direct", provider: "anthropic", key: "sk-a" });
    expect(f.calls[0]!.params).toEqual(REQ);
    expect(res.usage.usd).toBeCloseTo((1000 * sonnet.rate!.input + 200 * sonnet.rate!.output) / 1e6, 12);
    const old = structuredClone(REG);
    old.routing!.prefer = "direct";
    const g = fakeSdk(() => answer("claude-sonnet-5-5", { input_tokens: 1, output_tokens: 1 }));
    await routedModelClient({ registry: () => old, keys: { anthropic: "sk-a", openrouter: "sk-or" }, sdk: g.sdk }).create(REQ);
    expect(g.calls[0]!.via).toBe("direct");
  });

  test("no key, no registry or an unknown model: no call at all", async () => {
    const f = fakeSdk(() => answer("x", {}));
    await expect(routedModelClient({ registry: () => REG, keys: {}, sdk: f.sdk }).create(REQ)).rejects.toThrow(/no key on the hosted runtime/);
    await expect(routedModelClient({ registry: () => null, keys: { openrouter: "k" }, sdk: f.sdk }).create(REQ)).rejects.toThrow(/no model registry/);
    await expect(routedModelClient({ registry: () => REG, keys: { openrouter: "k" }, sdk: f.sdk }).create({ ...REQ, model: "gpt-5.5" })).rejects.toThrow(/not a Claude model/);
    expect(f.calls).toHaveLength(0);
  });

  test("a provider that answers 'no credit' is marked: the next calls fail at once without a request until the mark runs out", async () => {
    let now = 1_000_000;
    let fail = true;
    const f = fakeSdk(() => {
      if (fail) throw Object.assign(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'), { status: 400 });
      return answer("claude-sonnet-5-5", { input_tokens: 1, output_tokens: 1 });
    });
    const marked: string[] = [];
    const c = routedModelClient({ registry: () => REG, keys: { anthropic: "sk-a" }, sdk: f.sdk, now: () => now, cooldown_s: 900, onNoCredits: (p) => marked.push(p) });
    const e1 = await c.create(REQ).catch((e) => e);
    expect(e1).toBeInstanceOf(ModelRouteError);
    expect(e1).toMatchObject({ provider: "anthropic", noCredits: true, retryAfterMs: 900_000 });
    expect(marked).toEqual(["anthropic"]);
    now += 60_000;
    const e2 = await c.create(REQ).catch((e) => e);
    expect(e2).toMatchObject({ noCredits: true, retryAfterMs: 840_000 });
    expect(f.calls).toHaveLength(1); // the second call never left
    expect(c.unavailable("anthropic")).toBe(840_000);
    now += 840_000;
    fail = false;
    expect((await c.create(REQ)).model).toBe("claude-sonnet-5-5");
    expect(f.calls).toHaveLength(2);
    expect(c.unavailable("anthropic")).toBeNull();
  });

  test("what counts as a credit error: 402, or a 4xx about credit or billing; not a 402 with Retry-After, a 429 or a 500", () => {
    expect(isCreditError({ status: 402, message: "Insufficient credits" })).toBe(true);
    expect(isCreditError({ status: 400, message: "Your credit balance is too low to access the Anthropic API" })).toBe(true);
    expect(isCreditError({ status: 403, message: "billing hard limit reached" })).toBe(true);
    expect(isCreditError({ status: 402, message: "in flight", headers: new Headers({ "retry-after": "3" }) })).toBe(false);
    expect(isCreditError({ status: 429, message: "rate limited" })).toBe(false);
    expect(isCreditError({ status: 500, message: "credit balance" })).toBe(false);
    expect(isCreditError(new Error("socket closed"))).toBe(false);
  });

  test("the OpenRouter 402 marks OpenRouter and tells the runtime (balance gate); other errors pass through unmarked", async () => {
    let mode: "credit" | "other" = "other";
    const f = fakeSdk(() => {
      throw mode === "credit" ? Object.assign(new Error("402 Insufficient credits"), { status: 402 }) : Object.assign(new Error("529 overloaded"), { status: 529 });
    });
    const marked: string[] = [];
    const c = routedModelClient({ registry: () => REG, keys: { anthropic: "sk-a", openrouter: "sk-or" }, sdk: f.sdk, onNoCredits: (p) => marked.push(p) });
    await expect(c.create(REQ)).rejects.toThrow(/529 overloaded/);
    expect(c.unavailable("openrouter")).toBeNull();
    mode = "credit";
    await expect(c.create(REQ)).rejects.toMatchObject({ noCredits: true, provider: "openrouter" });
    expect(marked).toEqual(["openrouter"]);
    // no silent switch to Anthropic's own key while OpenRouter is marked: the rule is the registry's
    await expect(c.create(REQ)).rejects.toMatchObject({ noCredits: true, provider: "openrouter" });
    expect(f.calls.map((x) => x.provider)).toEqual(["openrouter", "openrouter"]);
  });

  test("a post in the soul's voice and a soul draft through the routed client are metered at what the route charged", async () => {
    const doc = soul();
    const f = fakeSdk((p) =>
      p.output_config?.format
        ? answer("anthropic/claude-opus-5.5", { input_tokens: 3000, output_tokens: 2500, cost: 0.062 }, JSON.stringify(persona()))
        : answer("anthropic/claude-sonnet-5.5", { input_tokens: 900, output_tokens: 120, cost: 0.003 }, "Merged the buffer reuse. Link: /generations/abc"),
    );
    const client = routedModelClient({ registry: () => REG, keys: { anthropic: "sk-a", openrouter: "sk-or" }, sdk: f.sdk });
    const post = await composeInVoice({ soul: doc, surface: "board", facts: "Link: /generations/abc", client, maxUsd: 0.05, model: "claude-sonnet-5-5" });
    expect(post.text).toContain("/generations/abc");
    expect(post.usage.usd).toBeCloseTo(0.003 * FEE, 12);
    expect(post.usage.models).toEqual(["claude-sonnet-5-5"]);
    const draft = await generateSoul({ seed: SEED, agent: doc.agent, client, maxUsd: 0.4 });
    expect(draft.problems).toEqual([]);
    expect(draft.doc?.origin).toMatchObject({ by: "model", model: "claude-opus-5-5" });
    expect(draft.usage.usd).toBeCloseTo(0.062 * FEE, 12);
    expect(f.calls.map((x) => x.params.model)).toEqual(["anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5"]);
    expect(f.calls.every((x) => x.provider === "openrouter" && x.params.betas === undefined)).toBe(true);
    // structured output and effort go through unchanged
    expect(f.calls[1]!.params.output_config.format.type).toBe("json_schema");
  });

  test("keys for a process that is not the runtime: the environment (a systemd EnvironmentFile) on top of the key files", () => {
    expect(envProviderKeys({ OPENROUTER_API_KEY: "env-or" }, { anthropic: "file-a", openrouter: "file-or" })).toEqual({ anthropic: "file-a", openrouter: "env-or" });
    expect(envProviderKeys({}, {})).toEqual({});
    expect(envProviderKeys({ ANTHROPIC_API_KEY: "env-a" }, {})).toEqual({ anthropic: "env-a" });
  });
});
