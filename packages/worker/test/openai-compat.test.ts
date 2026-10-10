import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRegistry, rateFor, usdFor, type ModelEntry, type ModelRegistry } from "../../core/src/model-registry.ts";
import { FUNCTION_TOOLS, normaliseUsage, OpenAICompatProposer, ProviderError } from "../src/proposers/openai-compat.ts";
import { availabilityOf, loadProviderKeys, PROVIDERS, type ProviderSpec } from "../src/proposers/providers.ts";
import type { ProposeContext } from "../src/proposers/types.ts";
import { TOOLS } from "../src/proposers/anthropic.ts";

// Adapter tests (plan M) against recorded-shape responses of each provider's OpenAI-compatible API:
// tool calls run through the shared ToolBox, errors surface with the provider's message, and every
// response is metered at the registry price into the runtime's meter.

const REG: ModelRegistry = JSON.parse(readFileSync(join(import.meta.dir, "../../../config/models.json"), "utf8"));

function ctx() {
  const tree = mkdtempSync(join(tmpdir(), "oc-test-"));
  mkdirSync(join(tree, "src"));
  mkdirSync(join(tree, "tests"));
  writeFileSync(join(tree, "src/lib.rs"), "pub fn encode() {}\n");
  writeFileSync(join(tree, "tests/basic.rs"), "#[test] fn t() {}\n");
  const logs: string[] = [];
  const metered: { usd: number; model: string; input_tokens: number; output_tokens: number; cache_read_tokens: number }[] = [];
  const harness: unknown[] = [];
  const c = {
    loaded: { recipe: { repo: "https://example.invalid/r", commit: "abc", metrics: [], patch: { allowed_paths: ["src/**"], protected_paths: ["tests/**"], max_files: 2, max_lines: 50 }, equivalence: null } },
    deps: {},
    calibration: { recipe_id: "", snapshot_id: "", runs: 1, stable: [], known_failures: [], quarantined: [], metrics: {}, median_eval_seconds: 1 },
    parentPatches: [],
    findings: [],
    tree,
    seed: "5eed",
    log: (m: string) => logs.push(m),
    meter: { model: (u: any) => metered.push(u), sandbox: () => {}, harness: (h: unknown) => harness.push(h) },
  } as unknown as ProposeContext;
  return { c, tree, logs, metered, harness, done: () => rmSync(tree, { recursive: true, force: true }) };
}

const model = (provider: string, id?: string): ModelEntry => {
  const m = REG.models.find((x) => x.provider === provider && (!id || x.id === id) && x.status === "verified");
  if (!m) throw new Error(`no ${provider} model in config/models.json`);
  return m;
};

/** A provider that answers from a queue of (status, body) and records requests. */
function fakeApi(replies: [number, unknown][]) {
  const requests: any[] = [];
  const f = (async (url: string, init: RequestInit) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(String(init.body)) });
    const [status, body] = replies.shift() ?? [500, { error: { message: "no more replies" } }];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, requests };
}

const call = (id: string, name: string, args: unknown, extra: Record<string, unknown> = {}) => ({ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) }, ...extra });
const reply = (calls: unknown[], usage: Record<string, unknown>, extra: Record<string, unknown> = {}, model = "m") => [
  200,
  { id: "x", model, choices: [{ index: 0, finish_reason: calls.length ? "tool_calls" : "stop", message: { role: "assistant", content: calls.length ? null : "done", tool_calls: calls.length ? calls : undefined, ...extra } }], usage },
] as [number, unknown];

const noSleep = async () => {};

describe("model registry (config/models.json)", () => {
  test("validates, has a priced default, and keeps the Stags caveats", () => {
    expect(checkRegistry(REG)).toEqual([]);
    const ds = REG.models.filter((m) => m.provider === "deepseek");
    expect(ds.length).toBeGreaterThan(0);
    const meta = REG.models.find((m) => m.provider === "meta")!;
    expect(meta.status).toBe("no_price");
    expect(meta.rate).toBeNull();
    for (const m of REG.models.filter((x) => x.provider === "minimax")) expect(m.note ?? "").toMatch(/discount|list/i);
    for (const p of REG.providers) expect(p.read_on).toMatch(/^2026-/);
  });

  test("refuses a zero price and an unknown provider", () => {
    const bad = structuredClone(REG);
    bad.models[0]!.rate!.input = 0;
    expect(checkRegistry(bad).join(";")).toMatch(/positive/);
    const bad2 = structuredClone(REG);
    bad2.models[0]!.provider = "nobody";
    expect(checkRegistry(bad2).join(";")).toMatch(/not a listed provider/);
  });

  test("peak windows pick the other rate by the UTC clock; tiers by prompt size", () => {
    const m: ModelEntry = {
      id: "x", provider: "deepseek", name: "x", status: "verified",
      rate: { input: 1, output: 2 },
      peak: { rate: { input: 2, output: 4 }, windows: [{ days: [1, 2, 3, 4, 5], start: "01:00", end: "04:00" }] },
    };
    expect(rateFor(m, new Date("2026-10-07T02:30:00Z"), 10)!.input).toBe(2); // Wednesday, inside
    expect(rateFor(m, new Date("2026-10-07T04:00:00Z"), 10)!.input).toBe(1); // end is exclusive
    expect(rateFor(m, new Date("2026-10-04T02:30:00Z"), 10)!.input).toBe(1); // Sunday
    const t: ModelEntry = { id: "y", provider: "alibaba", name: "y", status: "verified", rate: { input: 1, output: 2 }, tiers: [{ up_to_input_tokens: 1000, rate: { input: 1, output: 2 } }, { up_to_input_tokens: 5000, rate: { input: 3, output: 6 } }] };
    expect(rateFor(t, new Date(), 999)!.input).toBe(1);
    expect(rateFor(t, new Date(), 1001)!.input).toBe(3);
    expect(rateFor(t, new Date(), 99999)!.input).toBe(3);
    expect(usdFor({ input: 2, output: 10, cached_input: 0.5 }, { input_tokens: 1e6, output_tokens: 1e5, cache_read_tokens: 2e6, cache_write_tokens: 0 })).toBeCloseTo(2 + 1 + 1, 9);
  });
});

describe("usage normalisation", () => {
  test("reads each provider's cached-token field and charges reasoning left out of completion_tokens", () => {
    // OpenAI, Google, Alibaba, Zhipu, MiniMax: prompt_tokens_details.cached_tokens
    expect(normaliseUsage({ prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, prompt_tokens_details: { cached_tokens: 600 } }).usage).toEqual({ input_tokens: 400, output_tokens: 200, cache_read_tokens: 600, cache_write_tokens: 0 });
    // DeepSeek: prompt_cache_hit_tokens / prompt_cache_miss_tokens
    expect(normaliseUsage({ prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100 }).usage.cache_read_tokens).toBe(900);
    // Moonshot: cached_tokens at the top level
    expect(normaliseUsage({ prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, cached_tokens: 300 }).usage.input_tokens).toBe(700);
    // a total above prompt + completion (thinking counted only in the total) is charged as output
    expect(normaliseUsage({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 400 }).usage.output_tokens).toBe(300);
    expect(normaliseUsage(null).bad).toBe(true);
    expect(normaliseUsage({ prompt_tokens: -1, completion_tokens: 3 }).bad).toBe(true);
  });
});

describe("OpenAICompatProposer", () => {
  for (const pid of ["openai", "google", "deepseek", "alibaba", "moonshot", "zhipu", "minimax"]) {
    test(`${pid}: tool calls run in the tree, each response is metered at the registry price, give_up ends it`, async () => {
      const { c, tree, metered, harness, done } = ctx();
      try {
        const m = model(pid);
        const api = fakeApi([
          reply([call("c1", "read_file", { path: "src/lib.rs" }), call("c2", "list_files", { dir: "." })], { prompt_tokens: 2000, completion_tokens: 100, total_tokens: 2100 }, pid === "deepseek" ? { reasoning_content: "thinking" } : {}, `${m.id}-snapshot`),
          reply([call("c3", "edit_file", { path: "src/lib.rs", old_string: "pub fn encode() {}", new_string: "pub fn encode() { }" })], { prompt_tokens: 2500, completion_tokens: 80, total_tokens: 2580 }),
          reply([call("c4", "give_up", { reason: "nothing measurable" })], { prompt_tokens: 3000, completion_tokens: 20, total_tokens: 3020 }),
        ]);
        const spec = PROVIDERS[pid]!;
        const at = new Date("2026-10-04T12:00:00Z"); // a Sunday: off-peak for any clock-priced model
        const p = new OpenAICompatProposer({ provider: spec, apiKey: "sk-test", model: m, max_usd: 1, fetch: api.f, now: () => at, sleep: noSleep });
        expect(await p.propose(c)).toBeNull();
        expect(readFileSync(join(tree, "src/lib.rs"), "utf8")).toBe("pub fn encode() { }\n");
        // wire format
        const r0 = api.requests[0];
        expect(r0.url).toBe(`${spec.base_url}/chat/completions`);
        expect(r0.headers.authorization).toBe("Bearer sk-test");
        expect(r0.body.model).toBe(m.id);
        expect(r0.body.tools.map((t: any) => t.function.name)).toEqual(TOOLS.map((t) => t.name));
        expect(r0.body.messages[0].role).toBe("system");
        expect(r0.body[spec.token_param ?? "max_tokens"]).toBeGreaterThan(0);
        const r1 = api.requests[1];
        const tools = r1.body.messages.filter((x: any) => x.role === "tool");
        expect(tools.map((x: any) => x.tool_call_id)).toEqual(["c1", "c2"]);
        expect(tools[0].content).toContain("pub fn encode");
        const asst = r1.body.messages.find((x: any) => x.role === "assistant");
        expect(asst.tool_calls[0].id).toBe("c1");
        expect("reasoning_content" in asst).toBe(pid === "deepseek" && !!spec.echo_reasoning);
        // metering at the registry rate (tier and clock for this prompt size)
        expect(metered.length).toBe(3);
        const r = rateFor(m, at, 2000)!;
        expect(metered[0]!.usd).toBeCloseTo((2000 * r.input + 100 * r.output) / 1e6, 12);
        expect(metered[0]!.model).toBe(`${m.id}-snapshot`); // the model the API says ran
        expect(harness).toEqual([expect.objectContaining({ name: "openai-compat", provider: pid })]);
      } finally {
        done();
      }
    });
  }

  test("tool errors and bad arguments go back to the model as tool results; submit without an accepted evaluation is refused", async () => {
    const { c, done } = ctx();
    try {
      const api = fakeApi([
        reply([call("a", "read_file", { path: "../../etc/passwd" }), call("b", "write_file", "{not json"), call("c", "write_file", { path: "tests/basic.rs", contents: "x" }), call("d", "submit", { kind: "perf", target: "x", rationale: "r" })], { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }),
        reply([], { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }),
      ]);
      const p = new OpenAICompatProposer({ provider: PROVIDERS.openai!, apiKey: "k", model: model("openai"), max_usd: 1, fetch: api.f, sleep: noSleep });
      expect(await p.propose(c)).toBeNull();
      const tools = api.requests[1].body.messages.filter((x: any) => x.role === "tool").map((x: any) => x.content);
      expect(tools[0]).toMatch(/^error: path outside/);
      expect(tools[1]).toMatch(/not a valid JSON object/);
      expect(tools[2]).toMatch(/protected/);
      expect(tools[3]).toMatch(/did not report accepted/);
    } finally {
      done();
    }
  });

  test("429 and 5xx are retried, 401 and 402 surface the provider's message, MiniMax's HTTP 200 base_resp error is an error", async () => {
    const { c, done } = ctx();
    try {
      const ok = fakeApi([[429, { error: { message: "rate limited", type: "rate_limit" } }], [503, "upstream"], reply([call("g", "give_up", { reason: "x" })], { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })]);
      expect(await new OpenAICompatProposer({ provider: PROVIDERS.deepseek!, apiKey: "k", model: model("deepseek"), max_usd: 1, fetch: ok.f, sleep: noSleep }).propose(c)).toBeNull();
      expect(ok.requests.length).toBe(3);
      const denied = fakeApi([[401, { error: { message: "Incorrect API key provided", code: "invalid_api_key" } }]]);
      const e = await new OpenAICompatProposer({ provider: PROVIDERS.openai!, apiKey: "k", model: model("openai"), max_usd: 1, fetch: denied.f, sleep: noSleep }).propose(c).catch((x) => x);
      expect(e).toBeInstanceOf(ProviderError);
      expect(e.message).toBe("openai: HTTP 401 invalid_api_key: Incorrect API key provided");
      expect(String(e.message)).not.toContain("k\"");
      const broke = fakeApi([[402, { error: { message: "Insufficient Balance" } }]]);
      expect((await new OpenAICompatProposer({ provider: PROVIDERS.deepseek!, apiKey: "k", model: model("deepseek"), max_usd: 1, fetch: broke.f, sleep: noSleep }).propose(c).catch((x) => x)).status).toBe(402);
      const mm = fakeApi([[200, { base_resp: { status_code: 1008, status_msg: "insufficient balance" } }]]);
      const e2 = await new OpenAICompatProposer({ provider: PROVIDERS.minimax!, apiKey: "k", model: model("minimax"), max_usd: 1, fetch: mm.f, sleep: noSleep }).propose(c).catch((x) => x);
      expect(e2.message).toContain("1008: insufficient balance");
      const down = fakeApi([[500, "a"], [500, "b"], [500, "c"]]);
      expect((await new OpenAICompatProposer({ provider: PROVIDERS.zhipu!, apiKey: "k", model: model("zhipu"), max_usd: 1, fetch: down.f, sleep: noSleep }).propose(c).catch((x) => x)).status).toBe(500);
      expect(down.requests.length).toBe(3);
    } finally {
      done();
    }
  });

  test("the cap holds: a turn projected past it is not started; a response without usage is charged the rest of the cap", async () => {
    const { c, logs, metered, done } = ctx();
    try {
      const m = model("openai");
      const big = { prompt_tokens: 400_000, completion_tokens: 0, total_tokens: 400_000 }; // > half of a small cap per turn
      const api = fakeApi([reply([call("a", "list_files", { dir: "." })], big), reply([call("b", "list_files", { dir: "." })], big), reply([call("c", "list_files", { dir: "." })], big)]);
      const cap = (400_000 * m.rate!.input) / 1e6 * 1.5;
      expect(await new OpenAICompatProposer({ provider: PROVIDERS.openai!, apiKey: "k", model: m, max_usd: cap, fetch: api.f, sleep: noSleep }).propose(c)).toBeNull();
      expect(api.requests.length).toBe(1);
      expect(logs.join("\n")).toContain("spend cap reached");
      const none = fakeApi([[200, { model: "m", choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [call("a", "list_files", { dir: "." })] } }] }]]);
      metered.length = 0;
      expect(await new OpenAICompatProposer({ provider: PROVIDERS.openai!, apiKey: "k", model: m, max_usd: 0.5, fetch: none.f, sleep: noSleep }).propose(c)).toBeNull();
      expect(metered[0]!.usd).toBeCloseTo(0.5, 9);
      expect(none.requests.length).toBe(1);
    } finally {
      done();
    }
  });

  test("Gemini: tool_calls go back verbatim (thought signatures ride on them)", async () => {
    const { c, done } = ctx();
    try {
      const sig = { extra_content: { google: { thought_signature: "c2lnbmF0dXJl" } } };
      const api = fakeApi([reply([call("g1", "list_files", { dir: "." }, sig)], { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }), reply([call("g2", "give_up", { reason: "x" })], { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 })]);
      await new OpenAICompatProposer({ provider: PROVIDERS.google!, apiKey: "k", model: model("google"), max_usd: 1, fetch: api.f, sleep: noSleep }).propose(c);
      const asst = api.requests[1].body.messages.find((x: any) => x.role === "assistant");
      expect(asst.tool_calls[0].extra_content).toEqual(sig.extra_content);
    } finally {
      done();
    }
  });

  test("content_filter is a refusal; a model from another provider or without a price is refused at construction", async () => {
    const { c, done } = ctx();
    try {
      const api = fakeApi([[200, { model: "m", choices: [{ finish_reason: "content_filter", message: { role: "assistant", content: "" } }], usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } }]]);
      expect(await new OpenAICompatProposer({ provider: PROVIDERS.alibaba!, apiKey: "k", model: model("alibaba"), max_usd: 1, fetch: api.f, sleep: noSleep }).propose(c)).toBeNull();
      expect(() => new OpenAICompatProposer({ provider: PROVIDERS.openai!, apiKey: "k", model: model("deepseek"), max_usd: 1 })).toThrow(/belongs to deepseek/);
      const meta = REG.models.find((m) => m.provider === "meta")!;
      expect(() => new OpenAICompatProposer({ provider: { ...PROVIDERS.openai!, id: "meta" } as ProviderSpec, apiKey: "k", model: meta, max_usd: 1 })).toThrow(/no registry price/);
    } finally {
      done();
    }
  });

  test("function tools carry the Anthropic tools' schemas unchanged", () => {
    expect(FUNCTION_TOOLS.map((t) => t.function.parameters)).toEqual(TOOLS.map((t) => t.input_schema));
  });
});

describe("provider keys", () => {
  test("providers.env is created with empty placeholders, mode 600; empty values are no key", () => {
    const dir = mkdtempSync(join(tmpdir(), "pk-"));
    try {
      const path = join(dir, "sub/providers.env");
      expect(loadProviderKeys({ path, modelEnv: join(dir, "none.env") })).toEqual({});
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const text = readFileSync(path, "utf8");
      for (const p of Object.values(PROVIDERS)) expect(text).toContain(`${p.key_env}=`);
      writeFileSync(path, text.replace("DEEPSEEK_API_KEY=", "DEEPSEEK_API_KEY=sk-ds"));
      writeFileSync(join(dir, "model.env"), "ANTHROPIC_API_KEY=sk-ant\n");
      const keys = loadProviderKeys({ path, modelEnv: join(dir, "model.env") });
      expect(keys).toEqual({ deepseek: "sk-ds", anthropic: "sk-ant" });
      expect(availabilityOf(keys)).toMatchObject({ anthropic: true, deepseek: true, openai: false, minimax: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
