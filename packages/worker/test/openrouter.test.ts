import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRegistry, routeEntry, routeFeeFactor, type ModelRegistry } from "../../core/src/model-registry.ts";
import { OpenAICompatProposer, ProviderError } from "../src/proposers/openai-compat.ts";
import { availabilityOf, loadProviderKeys, PROVIDERS } from "../src/proposers/providers.ts";
import type { ProposeContext } from "../src/proposers/types.ts";
import { openrouterRequestExtra } from "../../runtime/src/providers.ts";

// OpenRouter as a route (plan MODELS-AND-SELF-FUNDING): the OpenAI-compatible adapter against
// OpenRouter's documented response shapes (fixtures/openrouter-chat.json), metering usage.cost times
// the funding fee, echoing reasoning_details, and surfacing 402 and a 200 that holds only an error.

const REG: ModelRegistry = JSON.parse(readFileSync(join(import.meta.dir, "../../../config/models.json"), "utf8"));
const FX = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/openrouter-chat.json"), "utf8"));
const MODELS = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/openrouter-models.json"), "utf8"));
const noSleep = async () => {};

function ctx() {
  const tree = mkdtempSync(join(tmpdir(), "or-test-"));
  mkdirSync(join(tree, "src"));
  writeFileSync(join(tree, "src/lib.rs"), "pub fn encode() {}\n");
  const logs: string[] = [];
  const metered: any[] = [];
  const upstream: string[] = [];
  const c = {
    loaded: { recipe: { repo: "https://example.invalid/r", commit: "abc", metrics: [], patch: { allowed_paths: ["src/**"], protected_paths: [], max_files: 2, max_lines: 50 }, equivalence: null } },
    deps: {},
    calibration: { recipe_id: "", snapshot_id: "", runs: 1, stable: [], known_failures: [], quarantined: [], metrics: {}, median_eval_seconds: 1 },
    parentPatches: [],
    findings: [],
    tree,
    seed: "5eed",
    log: (m: string) => logs.push(m),
    meter: { model: (u: any) => metered.push(u), sandbox: () => {}, harness: () => {}, upstream: (n: string) => upstream.push(n) },
  } as unknown as ProposeContext;
  return { c, logs, metered, upstream, done: () => rmSync(tree, { recursive: true, force: true }) };
}

function fakeApi(replies: [number, unknown, Record<string, string>?][]) {
  const requests: any[] = [];
  const f = (async (url: string, init: RequestInit) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(String(init.body)) });
    const [status, body, headers] = replies.shift() ?? [500, { error: { message: "no more replies" } }];
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...(headers ?? {}) } });
  }) as unknown as typeof fetch;
  return { f, requests };
}

const gpt55 = REG.models.find((m) => m.provider === "openai" && m.id === "gpt-5.5")!;

describe("OpenRouter route in the registry", () => {
  test("the seed validates; route prices equal OpenRouter's listed prices as read 2026-10-10 (per token there, per 1M here)", () => {
    expect(checkRegistry(REG)).toEqual([]);
    expect(REG.routing?.openrouter).toMatchObject({ read_on: "2026-10-10", funding_fee_bps: 550 });
    for (const m of MODELS.data) {
      const entry = REG.models.find((x) => x.routes?.openrouter?.id === m.id)!;
      expect(entry).toBeTruthy();
      const r = entry.routes!.openrouter!.rate;
      expect(r.input).toBeCloseTo(Number(m.pricing.prompt) * 1e6, 6);
      expect(r.output).toBeCloseTo(Number(m.pricing.completion) * 1e6, 6);
      if (m.pricing.input_cache_read) expect(r.cached_input!).toBeCloseTo(Number(m.pricing.input_cache_read) * 1e6, 6);
      expect(m.supported_parameters).toContain("tools");
    }
    // Anthropic models never carry an OpenRouter route: they stay direct
    expect(REG.models.filter((m) => m.provider === "anthropic" && m.routes?.openrouter)).toEqual([]);
  });

  test("providers.env: OPENROUTER_API_KEY makes openrouter available; the management key is not a provider", () => {
    const d = mkdtempSync(join(tmpdir(), "or-env-"));
    try {
      const p = join(d, "providers.env");
      writeFileSync(p, "OPENROUTER_API_KEY=sk-or-fixture\nOPENROUTER_MANAGEMENT_KEY=sk-or-mgmt\n", { mode: 0o600 });
      const keys = loadProviderKeys({ path: p, modelEnv: join(d, "none.env"), create: false });
      expect(keys.openrouter).toBe("sk-or-fixture");
      expect(keys["openrouter-management"]).toBe("sk-or-mgmt");
      const avail = availabilityOf(keys);
      expect(avail.openrouter).toBe(true);
      expect(Object.keys(avail)).not.toContain("openrouter-management");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("OpenAICompatProposer on the OpenRouter route", () => {
  test("tool loop: OpenRouter id requested with max_price and require_parameters, app headers sent, reasoning_details echoed, usage.cost x fee metered, upstream hosts reported", async () => {
    const { c, metered, upstream, done } = ctx();
    try {
      const entry = routeEntry(REG, gpt55, "openrouter");
      const fee = routeFeeFactor(REG, "openrouter");
      expect(fee).toBeCloseTo(1.055, 12);
      const api = fakeApi([[200, FX.tool_turn], [200, FX.give_up_turn]]);
      const p = new OpenAICompatProposer({ provider: PROVIDERS.openrouter!, apiKey: "sk-or-fixture", model: entry, max_usd: 1, fetch: api.f, sleep: noSleep, fee_factor: fee, request_extra: openrouterRequestExtra(entry) });
      expect(await p.propose(c)).toBeNull(); // gave up
      expect(api.requests.length).toBe(2);
      const [first, second] = api.requests;
      expect(first.url).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(first.headers).toMatchObject({ authorization: "Bearer sk-or-fixture", "X-OpenRouter-Title": "Lineage" });
      expect(first.body.model).toBe("openai/gpt-5.5");
      // the highest listed tier is the ceiling: never a host priced above OpenRouter's listed rate
      const tiers = entry.tiers!.map((t) => t.rate);
      expect(first.body.provider).toEqual({ max_price: { prompt: Math.max(...tiers.map((r) => r.input)), completion: Math.max(...tiers.map((r) => r.output)) }, require_parameters: true });
      expect(first.body.tool_choice).toBe("auto");
      const back = second.body.messages.find((m: any) => m.role === "assistant");
      expect(back.reasoning_details).toEqual(FX.tool_turn.choices[0].message.reasoning_details);
      expect(back.tool_calls[0].id).toBe("call_fixture_1");
      // metered at the charged cost times the funding fee, not at a rate times tokens
      expect(metered.map((m) => m.usd)).toEqual([0.0084 * fee, 0.0079 * fee]);
      expect(metered[1].cache_read_tokens).toBe(1024);
      expect(upstream).toEqual(["OpenAI", "Azure"]);
    } finally {
      done();
    }
  });

  test("without usage.cost the listed route rate times tokens is metered, still times the fee", async () => {
    const { c, metered, done } = ctx();
    try {
      const entry = routeEntry(REG, gpt55, "openrouter");
      const turn = structuredClone(FX.give_up_turn);
      delete turn.usage.cost;
      const api = fakeApi([[200, turn]]);
      await new OpenAICompatProposer({ provider: PROVIDERS.openrouter!, apiKey: "k", model: entry, max_usd: 1, fetch: api.f, sleep: noSleep, fee_factor: 1.055 }).propose(c);
      const r = entry.tiers![0]!.rate;
      expect(metered[0].usd).toBeCloseTo(((1400 - 1024) * r.input + 30 * r.output + 1024 * r.cached_input!) / 1e6 * 1.055, 12);
    } finally {
      done();
    }
  });

  test("402 without Retry-After is not retried and marks no credits; with Retry-After (in-flight budget) it is retried; a 200 holding only an error is that error", async () => {
    const { c, done } = ctx();
    try {
      const entry = routeEntry(REG, gpt55, "openrouter");
      const broke = fakeApi([[402, FX.no_credits_402]]);
      const e = await new OpenAICompatProposer({ provider: PROVIDERS.openrouter!, apiKey: "k", model: entry, max_usd: 1, fetch: broke.f, sleep: noSleep }).propose(c).catch((x) => x);
      expect(e).toBeInstanceOf(ProviderError);
      expect(e.status).toBe(402);
      expect(e.noCredits).toBe(true);
      expect(broke.requests.length).toBe(1);
      const busy = fakeApi([[402, FX.no_credits_402, { "retry-after": "1" }], [200, FX.give_up_turn]]);
      expect(await new OpenAICompatProposer({ provider: PROVIDERS.openrouter!, apiKey: "k", model: entry, max_usd: 1, fetch: busy.f, sleep: noSleep }).propose(c)).toBeNull();
      expect(busy.requests.length).toBe(2);
      const bad = fakeApi([[200, FX.error_in_200], [200, FX.error_in_200], [200, FX.error_in_200]]);
      const e2 = await new OpenAICompatProposer({ provider: PROVIDERS.openrouter!, apiKey: "k", model: entry, max_usd: 1, fetch: bad.f, sleep: noSleep }).propose(c).catch((x) => x);
      expect(e2).toBeInstanceOf(ProviderError);
      expect(e2.status).toBe(502);
      expect(e2.message).toContain("Provider returned error");
      expect(bad.requests.length).toBe(3); // a 502 is retried twice
    } finally {
      done();
    }
  });
});
