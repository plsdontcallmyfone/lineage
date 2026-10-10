import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRegistry } from "../../core/src/model-registry.ts";
import { OPENAI_HARNESS_DIGEST } from "../../worker/src/proposers/openai-compat.ts";
import { HARNESS_DIGEST } from "../../worker/src/proposers/anthropic.ts";
import { PROVIDERS } from "../../worker/src/proposers/providers.ts";
import type { ProposeContext } from "../../worker/src/proposers/types.ts";
import { anthropicPrices, RegistrySource, resolveRoute, RoutedProposer } from "../src/providers.ts";
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
