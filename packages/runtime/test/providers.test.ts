import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRegistry } from "../../core/src/model-registry.ts";
import { OPENAI_HARNESS_DIGEST } from "../../worker/src/proposers/openai-compat.ts";
import { HARNESS_DIGEST } from "../../worker/src/proposers/anthropic.ts";
import { PROVIDERS } from "../../worker/src/proposers/providers.ts";
import type { ProposeContext } from "../../worker/src/proposers/types.ts";
import Anthropic from "@anthropic-ai/sdk";
import { ProviderError } from "../../worker/src/proposers/openai-compat.ts";
import { anthropicBaseOf, anthropicPrices, RegistrySource, resolveRoute, retryInFlight, routedError, RoutedProposer } from "../src/providers.ts";
import { provenanceRecord } from "../src/provenance.ts";
import { fakeClient } from "./fake.ts";

// Provider routing (plan M): the agent's signed profile picks the model, the runtime runs exactly
// that one or none, meters it at the registry price, and provenance attests harness and provider.

const REG: ModelRegistry = JSON.parse(readFileSync(join(import.meta.dir, "../../../config/models.json"), "utf8"));
const ds = REG.models.find((m) => m.provider === "deepseek" && m.status === "verified")!;

function ctx() {
  const tree = mkdtempSync(join(tmpdir(), "route-"));
  mkdirSync(join(tree, "src"));
  writeFileSync(join(tree, "src/lib.rs"), "fn a() {}\n");
  const logs: string[] = [];
  const metered: any[] = [];
  let harness: any = null;
  const c = {
    loaded: { recipe: { repo: "r", commit: "c", metrics: [], patch: { allowed_paths: ["src/**"], protected_paths: [], max_files: 1, max_lines: 10 }, equivalence: null } },
    deps: {},
    calibration: { stable: [], known_failures: [], metrics: {} },
    parentPatches: [],
    findings: [],
    tree,
    seed: "s",
    log: (m: string) => logs.push(m),
    meter: { model: (u: any) => metered.push(u), sandbox: () => {}, harness: (h: any) => (harness = h) },
  } as unknown as ProposeContext;
  return { c, logs, metered, harness: () => harness, done: () => rmSync(tree, { recursive: true, force: true }) };
}

/** Core (registry + soul) and a provider on one fake fetch. */
function fakeCore(model: unknown) {
  return (async (url: string) => {
    if (url.endsWith("/v1/models")) return Response.json({ registry: REG });
    if (url.includes("/soul")) return model ? Response.json({ doc: { model } }) : new Response("{}", { status: 404 });
    return new Response("?", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("resolveRoute", () => {
  test("default without a choice; refuses unknown, unpriced and keyless instead of substituting", () => {
    const keys = { anthropic: "a", deepseek: "d" };
    const def = resolveRoute(REG, null, keys);
    expect(def.ok && def.model.id).toBe(REG.default.id);
    const r = resolveRoute(REG, { provider: "deepseek", id: ds.id }, keys);
    expect(r.ok && r.provider.base_url).toBe(PROVIDERS.deepseek!.base_url);
    expect(resolveRoute(REG, { provider: "deepseek", id: "nope" }, keys)).toMatchObject({ ok: false, why: expect.stringMatching(/not in the model registry/) });
    const meta = REG.models.find((m) => m.provider === "meta")!;
    expect(resolveRoute(REG, { provider: "meta", id: meta.id }, { meta: "x" })).toMatchObject({ ok: false, why: expect.stringMatching(/no first-party/) });
    const oa = REG.models.find((m) => m.provider === "openai")!;
    expect(resolveRoute(REG, { provider: "openai", id: oa.id }, keys)).toMatchObject({ ok: false, why: expect.stringMatching(/no key on the hosted runtime \(neither openai nor OpenRouter\)/) });
    expect(resolveRoute(null, null, keys).ok).toBe(false);
    const off = REG.models.find((m) => m.enabled === false)!;
    expect(resolveRoute(REG, { provider: off.provider, id: off.id }, { [off.provider]: "k" })).toMatchObject({ ok: false, why: expect.stringMatching(/not offered/i) });
  });

  test("Anthropic prices come from the registry, cache writes at 1.25x input when not listed", () => {
    const m = REG.models.find((x) => x.provider === "anthropic" && x.id === REG.default.id)!;
    const p = anthropicPrices(m);
    expect(p.input).toBe(m.rate!.input);
    expect(p.cache_write).toBe(m.rate!.cache_write ?? m.rate!.input * 1.25);
  });

  test("a registry from Core that does not validate is not used", async () => {
    const broken = structuredClone(REG) as any;
    broken.models[0].rate.input = 0;
    const logs: string[] = [];
    const src = new RegistrySource({ core: "http://core", fetch: (async () => Response.json({ registry: broken })) as never, log: (m) => logs.push(m) });
    const got = await src.get();
    expect(got!.models[0]!.rate!.input).toBeGreaterThan(0); // the local copy
    expect(logs.join()).toMatch(/does not validate/);
  });
});

describe("RoutedProposer", () => {
  test("a soul that picked DeepSeek runs DeepSeek with its key, metered at the registry rate; provenance attests it", async () => {
    const { c, metered, harness, done } = ctx();
    try {
      const sent: any[] = [];
      const providerFetch = (async (url: string, init: RequestInit) => {
        sent.push({ url, auth: (init.headers as any).authorization, body: JSON.parse(String(init.body)) });
        return Response.json({ model: ds.id, choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "g", type: "function", function: { name: "give_up", arguments: '{"reason":"t"}' } }] } }], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } });
      }) as unknown as typeof fetch;
      const opts = { core: "http://core", keys: { deepseek: "sk-ds", anthropic: "sk-a" }, attempt_max_usd: 1, effort: "low" as const, max_turns: 3, max_evals: 1, fetch: fakeCore({ provider: "deepseek", id: ds.id }), providerFetch };
      const p = new RoutedProposer("AGENT", opts, new RegistrySource(opts));
      expect(await p.propose(c)).toBeNull();
      expect(sent[0].url).toBe(`${PROVIDERS.deepseek!.base_url}/chat/completions`);
      expect(sent[0].auth).toBe("Bearer sk-ds");
      expect(sent[0].body.model).toBe(ds.id);
      expect(metered[0].usd).toBeGreaterThan(0);
      expect(metered[0].model).toBe(ds.id);
      const h = harness();
      expect(h).toMatchObject({ name: "openai-compat", provider: "deepseek", digest: OPENAI_HARNESS_DIGEST });
      const rec = provenanceRecord({ commit_id: "c".repeat(64), agent: "AGENT", recipe_id: "r".repeat(64), lineage_id: "l".repeat(64), amount: 1n, price: { line_per_usd: "1", line_per_sandbox_s: "0" }, requestedModel: "x",
        totals: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, usd: 0.1, sandbox_s: 0, models: [ds.id], started_at: 1, finished_at: 2, proposer: h } });
      expect(rec).toMatchObject({ proposer: { name: "openai-compat", version: "openai-compat/1" }, provider: "deepseek", harness_digest: OPENAI_HARNESS_DIGEST, models: [ds.id] });
    } finally {
      done();
    }
  });

  test("without a soul choice the default (Anthropic) runs natively; a keyless pick does not run at all", async () => {
    const { c, logs, metered, harness, done } = ctx();
    try {
      const { client } = fakeClient([{ tools: [{ name: "give_up", input: { reason: "t" } }], usage: { input_tokens: 1000, output_tokens: 100 }, model: REG.default.id }]);
      const opts = { core: "http://core", keys: { anthropic: "sk-a" }, attempt_max_usd: 1, effort: "low" as const, max_turns: 3, max_evals: 1, fetch: fakeCore(null), anthropicClient: client };
      expect(await new RoutedProposer("A", opts, new RegistrySource(opts)).propose(c)).toBeNull();
      const m = REG.models.find((x) => x.provider === "anthropic" && x.id === REG.default.id)!;
      expect(metered[0].usd).toBeCloseTo((1000 * m.rate!.input + 100 * m.rate!.output) / 1e6, 12);
      expect(harness()).toMatchObject({ name: "anthropic", provider: "anthropic", digest: HARNESS_DIGEST });
      // a dated snapshot id in the response is the requested model, priced at its registry rate (not the ceiling)
      const haiku = REG.models.find((x) => x.id === "claude-haiku-4-5")!;
      const snap = fakeClient([{ tools: [{ name: "give_up", input: { reason: "t" } }], usage: { input_tokens: 1000, output_tokens: 100 }, model: "claude-haiku-4-5-20251001" }]);
      const oh = { ...opts, fetch: fakeCore({ provider: "anthropic", id: "claude-haiku-4-5" }), anthropicClient: snap.client };
      metered.length = 0;
      await new RoutedProposer("A", oh, new RegistrySource(oh)).propose(c);
      expect(metered[0].usd).toBeCloseTo((1000 * haiku.rate!.input + 100 * haiku.rate!.output) / 1e6, 12);
      metered.length = 0;
      const o2 = { ...opts, fetch: fakeCore({ provider: "deepseek", id: ds.id }) };
      expect(await new RoutedProposer("A", o2, new RegistrySource(o2)).propose(c)).toBeNull();
      expect(metered.length).toBe(0);
      expect(logs.join("\n")).toMatch(/no key on the hosted runtime.*not authoring/);
    } finally {
      done();
    }
  });
});

describe("RoutedProposer journal", () => {
  test("the session's journal entry goes to the model that ran the attempt (it was silently skipped before)", async () => {
    const { c, done } = ctx();
    try {
      const { client } = fakeClient([{ tools: [{ name: "give_up", input: { reason: "t" } }], usage: { input_tokens: 1000, output_tokens: 100 }, model: REG.default.id }]);
      const created: any[] = [];
      (client as any).beta.messages.create = async (req: any) => {
        created.push(req);
        return { model: REG.default.id, stop_reason: "end_turn", content: [{ type: "text", text: "Notes for next time." }], usage: { input_tokens: 200, output_tokens: 50 } };
      };
      const opts = { core: "http://core", keys: { anthropic: "sk-a" }, attempt_max_usd: 1, effort: "low" as const, max_turns: 3, max_evals: 1, fetch: fakeCore(null), anthropicClient: client };
      const p = new RoutedProposer("A", opts, new RegistrySource(opts));
      expect(typeof p.journal).toBe("function");
      expect(await p.journal(c, { system: "s", user: "u" })).toBeNull(); // no attempt ran yet
      await p.propose(c);
      expect(await p.journal(c, { system: "s", user: "u" })).toBe("Notes for next time.");
      expect(created.length).toBe(1);
      expect(created[0].model).toBe(REG.default.id);
    } finally {
      done();
    }
  });
});

// Owner decision 2026-10-12: Claude runs through OpenRouter like every other model. The native
// proposer talks to OpenRouter's Anthropic Messages endpoint, so caching and metering stay the same code.
describe("Claude through OpenRouter", () => {
  /** A routed Anthropic client: usage in Anthropic's shape, the charged cost only on the stream's message_delta event (as OpenRouter sends it). */
  function routedClient(turns: { usage: Record<string, number>; cost?: number; tools?: { name: string; input: Record<string, unknown> }[]; provider?: string }[]) {
    const requests: any[] = [];
    let i = 0;
    const client = {
      beta: {
        messages: {
          stream: (params: any) => {
            requests.push(params);
            const t = turns[Math.min(i++, turns.length - 1)]!;
            const on: ((e: any) => void)[] = [];
            const content = (t.tools ?? []).map((x, k) => ({ type: "tool_use", id: `tu_${i}_${k}`, name: x.name, input: x.input }));
            return {
              on: (ev: string, f: (e: any) => void) => (ev === "streamEvent" && on.push(f), undefined),
              finalMessage: async () => {
                for (const f of on) f({ type: "message_delta", usage: { ...t.usage, ...(t.cost !== undefined ? { cost: t.cost } : {}) } });
                return { id: `msg_${i}`, type: "message", role: "assistant", model: "anthropic/claude-opus-5.5", provider: t.provider ?? "Anthropic", content, stop_reason: content.length ? "tool_use" : "end_turn", stop_details: null, usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...t.usage } };
              },
            };
          },
          create: async (params: any) => {
            requests.push(params);
            return { model: "anthropic/claude-opus-5.5", content: [{ type: "text", text: "entry" }], stop_reason: "end_turn", usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost: 0.004 } };
          },
        },
      },
    } as unknown as Anthropic;
    return { client, requests };
  }
  const opus = REG.models.find((x) => x.provider === "anthropic" && x.id === "claude-opus-5-5")!;
  const FEE = 1.055;

  test("the default model with both keys runs in the native proposer against OpenRouter: its id, no Anthropic-only fields, cost x fee metered, provenance names the model, the provider and the harness", async () => {
    const { c, logs, metered, harness, done } = ctx();
    const upstream: string[] = [];
    let route: any = null;
    (c.meter as any).upstream = (n: string) => upstream.push(n);
    (c.meter as any).route = (r: any) => (route = r);
    try {
      // 2,000 fresh, 30,000 read from the cache, 1,000 written, 400 out: OpenRouter charged 0.027 credits
      const { client, requests } = routedClient([{ tools: [{ name: "give_up", input: { reason: "t" } }], usage: { input_tokens: 2000, output_tokens: 400, cache_read_input_tokens: 30000, cache_creation_input_tokens: 1000 }, cost: 0.027 }]);
      const opts = { core: "http://core", keys: { anthropic: "sk-a", openrouter: "sk-or" }, attempt_max_usd: 1, effort: "medium" as const, max_turns: 3, max_evals: 1, fetch: fakeCore(null), anthropicClient: client };
      const p = new RoutedProposer("A", opts, new RegistrySource(opts));
      expect(await p.propose(c)).toBeNull();
      expect(logs.join("\n")).toMatch(/model route: anthropic\/claude-opus-5-5 via OpenRouter \(anthropic\/claude-opus-5\.5\)/);
      const req = requests[0];
      expect(req.model).toBe("anthropic/claude-opus-5.5");
      expect(req.betas).toBeUndefined(); // OpenRouter refuses fallbacks: "default" (400)
      expect(req.fallbacks).toBeUndefined();
      expect(req.provider).toEqual({ order: ["anthropic"], max_price: { prompt: 4, completion: 20 } });
      // what keeps attempts affordable goes through unchanged: automatic caching, the static prefix breakpoint, effort
      expect(req.cache_control).toEqual({ type: "ephemeral" });
      expect(req.system[0].cache_control).toEqual({ type: "ephemeral" });
      expect(req.output_config).toEqual({ effort: "medium" });
      expect(req.thinking).toEqual({ type: "adaptive" });
      expect(metered[0]).toMatchObject({ input_tokens: 2000, output_tokens: 400, cache_read_tokens: 30000, cache_write_tokens: 1000, model: "anthropic/claude-opus-5.5" });
      expect(metered[0].usd).toBeCloseTo(0.027 * FEE, 12);
      expect(route).toEqual({ via: "openrouter", model: { provider: "anthropic", id: "claude-opus-5-5" }, requested: "anthropic/claude-opus-5.5" });
      expect(upstream).toEqual(["Anthropic"]);
      const h = harness();
      expect(h).toMatchObject({ name: "anthropic", provider: "openrouter", digest: HARNESS_DIGEST });
      const rec = provenanceRecord({ commit_id: "c".repeat(64), agent: "A", recipe_id: "r".repeat(64), lineage_id: "l".repeat(64), amount: 1n, price: { line_per_usd: "1", line_per_sandbox_s: "0" }, requestedModel: "x",
        totals: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, usd: 0.1, sandbox_s: 0, models: ["anthropic/claude-opus-5.5"], started_at: 1, finished_at: 2, proposer: h, route: { via: "openrouter", model: route.model, upstream } } });
      expect(rec).toMatchObject({ proposer: { name: "anthropic", version: "anthropic/1" }, provider: "openrouter", harness_digest: HARNESS_DIGEST, route: { via: "openrouter", model: { provider: "anthropic", id: "claude-opus-5-5" }, upstream: ["Anthropic"] } });
      // the journal call goes to the same route and is metered at its reported cost x fee
      metered.length = 0;
      expect(await p.journal({ ...c, spent: { usd: 0 } } as ProposeContext, { system: "s", user: "u" })).toBe("entry");
      expect(requests[1].model).toBe("anthropic/claude-opus-5.5");
      expect(requests[1].betas).toBeUndefined();
      expect(metered[0].usd).toBeCloseTo(0.004 * FEE, 12);
    } finally {
      done();
    }
  });

  test("without a reported cost the response is metered at OpenRouter's listed price with cache reads and writes at their own rates, x fee", async () => {
    const { c, metered, done } = ctx();
    try {
      const { client } = routedClient([{ tools: [{ name: "give_up", input: { reason: "t" } }], usage: { input_tokens: 2000, output_tokens: 400, cache_read_input_tokens: 30000, cache_creation_input_tokens: 1000 } }]);
      const opts = { core: "http://core", keys: { openrouter: "sk-or" }, attempt_max_usd: 1, effort: "medium" as const, max_turns: 3, max_evals: 1, fetch: fakeCore(null), anthropicClient: client };
      await new RoutedProposer("A", opts, new RegistrySource(opts)).propose(c);
      const r = opus.routes!.openrouter!.rate;
      const list = (2000 * r.input + 400 * r.output + 30000 * r.cached_input! + 1000 * r.cache_write!) / 1e6;
      expect(list).toBeCloseTo(0.027, 12); // 0.008 + 0.008 + 0.006 + 0.005
      expect(metered[0].usd).toBeCloseTo(list * FEE, 12);
    } finally {
      done();
    }
  });

  test("Haiku 4.5 through OpenRouter still gets no adaptive thinking or effort (its rule follows the model, not the route's id)", async () => {
    const { c, done } = ctx();
    try {
      const { client, requests } = routedClient([{ tools: [{ name: "give_up", input: { reason: "t" } }], usage: { input_tokens: 10, output_tokens: 10 }, cost: 0.0001 }]);
      const opts = { core: "http://core", keys: { openrouter: "sk-or" }, attempt_max_usd: 1, effort: "medium" as const, max_turns: 3, max_evals: 1, fetch: fakeCore({ provider: "anthropic", id: "claude-haiku-4-5" }), anthropicClient: client };
      await new RoutedProposer("A", opts, new RegistrySource(opts)).propose(c);
      expect(requests[0].model).toBe("anthropic/claude-haiku-4.5");
      expect(requests[0].thinking).toBeUndefined();
      expect(requests[0].output_config).toBeUndefined();
    } finally {
      done();
    }
  });

  test("a 402 with Retry-After (OpenRouter's in-flight budget) is waited out and resent, at most twice; a 402 without it is returned at once", async () => {
    const waits: number[] = [];
    const replies = [new Response("{}", { status: 402, headers: { "retry-after": "2" } }), new Response("{}", { status: 402, headers: { "retry-after": "90" } }), new Response('{"ok":true}', { status: 200 })];
    let n = 0;
    const f = retryInFlight((async () => replies[n++]!) as unknown as typeof fetch, async (ms) => void waits.push(ms));
    expect((await f("https://x", { method: "POST", body: "{}" })).status).toBe(200);
    expect(waits).toEqual([2000, 30000]);
    let m = 0;
    const g = retryInFlight((async () => (m++, new Response("{}", { status: 402 }))) as unknown as typeof fetch, async () => {});
    expect((await g("https://x", { method: "POST", body: "{}" })).status).toBe(402);
    expect(m).toBe(1);
    let k = 0;
    const h = retryInFlight((async () => (k++, new Response("{}", { status: 402, headers: { "retry-after": "1" } }))) as unknown as typeof fetch, async () => {});
    expect((await h("https://x", { method: "POST", body: "{}" })).status).toBe(402);
    expect(k).toBe(3);
  });

  test("the SDK base is OpenRouter's documented /api/v1/messages; a 402 becomes the adapter's no-credits error for the balance gate", () => {
    expect(anthropicBaseOf(PROVIDERS.openrouter!)).toBe("https://openrouter.ai/api"); // the SDK appends /v1/messages
    const e = routedError("openrouter", new Anthropic.APIError(402, { error: { message: "Insufficient credits" } }, "Insufficient credits", new Headers())) as ProviderError;
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.provider).toBe("openrouter");
    expect(e.noCredits).toBe(true);
    const other = new Anthropic.APIError(429, {}, "slow down", new Headers());
    expect(routedError("openrouter", other)).toBe(other);
  });
});
