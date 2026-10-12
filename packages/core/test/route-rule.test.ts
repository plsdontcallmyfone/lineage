import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkRegistry, openrouterRoute, pickable, routeEntry, routeFeeFactor, routeOf, routePreference, type ModelRegistry } from "../src/model-registry.ts";

// The route rule (owner decision 2026-10-12): every model that has an OpenRouter route runs through
// OpenRouter, Claude included; the model's own provider is used only when the model has no route or
// the OpenRouter key is absent. The registry's routing.prefer is the admin-editable switch.

const REG: ModelRegistry = JSON.parse(readFileSync(join(import.meta.dir, "../../../config/models.json"), "utf8"));
const opus = REG.models.find((m) => m.provider === "anthropic" && m.id === "claude-opus-5-5")!;
const gpt = REG.models.find((m) => m.provider === "openai" && m.id === "gpt-5.5")!;

describe("route rule", () => {
  test("the seed prefers OpenRouter, and so does a registry without the field", () => {
    expect(checkRegistry(REG)).toEqual([]);
    expect(REG.routing?.prefer).toBe("openrouter");
    const absent = structuredClone(REG);
    delete absent.routing!.prefer;
    expect(checkRegistry(absent)).toEqual([]);
    expect(routePreference(absent)).toBe("openrouter");
    const bad = structuredClone(REG) as any;
    bad.routing.prefer = "cheapest";
    expect(checkRegistry(bad).join()).toMatch(/routing\.prefer/);
  });

  test("prefer openrouter: with the key every routed model goes through OpenRouter, Claude included", () => {
    for (const m of [opus, gpt]) {
      expect(routeOf(REG, m, { [m.provider]: true, openrouter: true })).toEqual({ via: "openrouter", why: null });
      expect(routeOf(REG, m, { openrouter: true })).toEqual({ via: "openrouter", why: null });
    }
    // the default model of both networks is Claude, and it routes through OpenRouter
    expect(REG.default).toEqual({ provider: "anthropic", id: "claude-opus-5-5" });
    const e = routeEntry(REG, opus, "openrouter");
    expect(e).toMatchObject({ id: "anthropic/claude-opus-5.5", provider: "openrouter", rate: opus.routes!.openrouter!.rate });
    expect(routeFeeFactor(REG, "openrouter")).toBeCloseTo(1.055, 12);
  });

  test("without the OpenRouter key the model's own provider runs it; with neither key it is unavailable, never substituted", () => {
    expect(routeOf(REG, opus, { anthropic: true })).toEqual({ via: "direct", why: null });
    expect(routeOf(REG, opus, { anthropic: true, openrouter: false })).toEqual({ via: "direct", why: null });
    expect(routeOf(REG, opus, {})).toMatchObject({ via: null, why: expect.stringMatching(/neither anthropic nor OpenRouter/) });
    expect(pickable(REG, opus, { providers: { openai: true }, reported_at: 1, by: "x" })).toMatchObject({ ok: false, via: null });
  });

  test("a model without a route (or with its route switched off) stays on its own provider even with the OpenRouter key", () => {
    const bare = structuredClone(REG);
    const m = bare.models.find((x) => x.id === opus.id)!;
    delete m.routes;
    expect(openrouterRoute(bare, m)).toBeNull();
    expect(routeOf(bare, m, { anthropic: true, openrouter: true })).toEqual({ via: "direct", why: null });
    expect(routeOf(bare, m, { openrouter: true })).toMatchObject({ via: null });
    const off = structuredClone(REG);
    const o = off.models.find((x) => x.id === opus.id)!;
    o.routes!.openrouter!.enabled = false;
    expect(routeOf(off, o, { anthropic: true, openrouter: true })).toEqual({ via: "direct", why: null });
  });

  test('prefer "direct" is the earlier rule: own provider first, OpenRouter as the fallback', () => {
    const old = structuredClone(REG);
    old.routing!.prefer = "direct";
    expect(routeOf(old, opus, { anthropic: true, openrouter: true })).toEqual({ via: "direct", why: null });
    expect(routeOf(old, opus, { openrouter: true })).toEqual({ via: "openrouter", why: null });
  });

  test("every Claude model has its OpenRouter id and a full price (cache read and write) on the route", () => {
    const claude = REG.models.filter((m) => m.provider === "anthropic");
    expect(claude.length).toBe(6);
    for (const m of claude) {
      const o = m.routes!.openrouter!;
      expect(o.id).toMatch(/^anthropic\/claude-/);
      expect(o.rate.cached_input).toBeGreaterThan(0);
      expect(o.rate.cache_write).toBeGreaterThan(o.rate.input);
    }
  });
});
