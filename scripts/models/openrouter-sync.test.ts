import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkRegistry, type ModelRegistry } from "../../packages/core/src/model-registry.ts";
import { claudeRouteId, routeFrom, syncRegistry, type ListedModel } from "./openrouter-sync.ts";

// The registry's OpenRouter routes are rewritten from OpenRouter's listing; after a sync the
// registry validates, and a missing id or a model without tools fails the run.

const REG: ModelRegistry = JSON.parse(readFileSync(join(import.meta.dir, "../../config/models.json"), "utf8"));
const per = (usdPerM: number) => (usdPerM / 1e6).toFixed(12).replace(/0+$/, "");

/** A listing that says what the registry says (OpenRouter's shape: USD per token as strings, overrides for tiers and clock). */
function listingOf(reg: ModelRegistry): ListedModel[] {
  return reg.models.flatMap((m) => {
    const o = m.routes?.openrouter;
    if (!o) return [];
    const p = (r: typeof o.rate) => ({ prompt: per(r.input), completion: per(r.output), ...(r.cached_input != null ? { input_cache_read: per(r.cached_input) } : {}), ...(r.cache_write != null ? { input_cache_write: per(r.cache_write) } : {}) });
    const overrides = [
      ...(o.tiers ?? []).slice(1).map((t, i) => ({ min_prompt_tokens: o.tiers![i]!.up_to_input_tokens, ...p(t.rate) })),
      ...(o.peak?.windows ?? []).map((w) => ({ utc_days: w.days.map((d) => ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][d]!), utc_start: Number(w.start.replace(":", "")), utc_end: Number(w.end.replace(":", "")), ...p(o.peak!.rate) })),
    ];
    return [{ id: o.id, pricing: { ...p(o.rate), ...(overrides.length ? { overrides } : {}) }, supported_parameters: ["tools", "max_tokens"] }];
  });
}

describe("openrouter-sync", () => {
  test("a listing equal to the registry changes nothing, and the registry validates after the sync", () => {
    const res = syncRegistry(REG, listingOf(REG), "2026-10-12");
    expect(res.errors).toEqual([]);
    expect(res.changes).toEqual([]);
    expect(checkRegistry(res.registry)).toEqual([]);
    expect(res.registry).toEqual(REG);
    // every model with a route is reported with the id sent to OpenRouter
    expect(res.routes.length).toBe(REG.models.filter((m) => m.routes?.openrouter).length);
    expect(res.routes).toContainEqual({ provider: "anthropic", id: "claude-opus-5-5", openrouter: "anthropic/claude-opus-5.5" });
  });

  test("a changed price, a new tier and a peak window are written; read_on moves; the result validates", () => {
    const listed = listingOf(REG);
    const k = listed.find((m) => m.id === "moonshotai/kimi-k3")!;
    k.pricing = { prompt: "0.000001", completion: "0.000012", input_cache_read: "0.0000002", overrides: [{ min_prompt_tokens: 200000, prompt: "0.000002", completion: "0.000024" }, { utc_days: ["monday"], utc_start: 100, utc_end: 400, prompt: "0.000003", completion: "0.000036" }, { utc_days: ["sunday"], utc_start: 0, utc_end: 0, prompt: "0.000001", completion: "0.000012", input_cache_read: "0.0000002" }] };
    const res = syncRegistry(REG, listed, "2026-11-01");
    expect(res.errors).toEqual([]);
    expect(res.changes.length).toBe(1);
    expect(res.changes[0]).toMatch(/^moonshot\/kimi-k3: /);
    const o = res.registry.models.find((m) => m.id === "kimi-k3")!.routes!.openrouter!;
    expect(o.rate).toEqual({ input: 1, output: 12, cached_input: 0.2 });
    expect(o.tiers).toEqual([{ up_to_input_tokens: 200000, rate: { input: 1, output: 12, cached_input: 0.2 } }, { up_to_input_tokens: 100_000_000, rate: { input: 2, output: 24 } }]);
    expect(o.peak).toEqual({ rate: { input: 3, output: 36 }, windows: [{ days: [1], start: "01:00", end: "04:00" }] });
    expect(res.registry.routing!.openrouter!.read_on).toBe("2026-11-01");
    expect(checkRegistry(res.registry)).toEqual([]);
    expect(REG.routing!.openrouter!.read_on).not.toBe("2026-11-01"); // the input is not edited
  });

  test("a Claude model without a route gets OpenRouter's id and listed price; never an invented one", () => {
    expect(claudeRouteId("claude-opus-5-5")).toBe("anthropic/claude-opus-5.5");
    expect(claudeRouteId("claude-haiku-4-5")).toBe("anthropic/claude-haiku-4.5");
    expect(claudeRouteId("claude-opus-5")).toBe("anthropic/claude-opus-5");
    const bare = structuredClone(REG);
    for (const m of bare.models) if (m.provider === "anthropic") delete m.routes;
    const res = syncRegistry(bare, listingOf(REG), "2026-10-12");
    expect(res.errors).toEqual([]);
    expect(res.changes.length).toBe(6);
    expect(res.registry.models.find((m) => m.id === "claude-opus-5-5")!.routes!.openrouter).toEqual(REG.models.find((m) => m.id === "claude-opus-5-5")!.routes!.openrouter!);
    // not listed: an error, no route
    const missing = syncRegistry(bare, listingOf(REG).filter((m) => m.id !== "anthropic/claude-fable-5.1"), "2026-10-12");
    expect(missing.errors.join()).toMatch(/anthropic\/claude-fable-5-1: OpenRouter does not list anthropic\/claude-fable-5\.1/);
  });

  test("a route whose id is gone, or that lost tool support, or lists no price, fails", () => {
    const gone = syncRegistry(REG, listingOf(REG).filter((m) => m.id !== "openai/gpt-5.5"), "2026-10-12");
    expect(gone.errors.join()).toMatch(/openai\/gpt-5\.5: OpenRouter does not list openai\/gpt-5\.5/);
    const noTools = listingOf(REG);
    noTools.find((m) => m.id === "openai/gpt-5.5")!.supported_parameters = ["max_tokens"];
    expect(syncRegistry(REG, noTools, "2026-10-12").errors.join()).toMatch(/no tool support/);
    expect(routeFrom({ id: "x/y", pricing: { prompt: "0", completion: "0.000001" }, supported_parameters: ["tools"] }, null)).toEqual({ error: "x/y: no prompt or completion price listed" });
  });
});
