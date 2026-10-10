import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey } from "@lineage/protocol";
import type { ModelRegistry } from "../../core/src/model-registry.ts";
import { parseConfig, Runtime, type Backend } from "../src/index.ts";
import { FixedPrice, JupiterPrice, perUsdOf, type PriceSource } from "../src/price.ts";
import { OpenRouterBalance } from "../src/provider-balance.ts";
import { resolveRoute } from "../src/providers.ts";
import type { ClosedEpoch } from "../src/state.ts";

// Plan MODELS-AND-SELF-FUNDING: the agent's own vault pays with no platform cap; the global cap
// counts only subsidized spend; every reserve comes out of the vault first; the price must be fresh;
// OpenRouter-routed attempts wait for its balance; runway is vault over recent burn.

const REG: ModelRegistry = JSON.parse(readFileSync(join(import.meta.dir, "../../../config/models.json"), "utf8"));
const FX = JSON.parse(readFileSync(join(import.meta.dir, "../../worker/test/fixtures/openrouter-chat.json"), "utf8"));

const tmp: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "lineage-selffund-"));
  tmp.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

const backend: Backend = {
  mode: "sim",
  init: async () => ({ decimals: 6, sleepThreshold: 0n, wakeThreshold: 0n, maxDebitPerEpoch: null }),
  discover: async () => [],
  signingKey: async () => null,
  vault: async () => ({ balance: 0n, awake: false }),
  bindRequest: async () => ({}),
  nextEpoch: async (n) => ({ epoch: n, earliestS: 0 }),
  post: async () => {},
  refreshAwake: async () => false,
};

const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);
const USD = 1_000_000n; // compute_price_line_per_usd "1" at 6 decimals: 1 USD = 10^6 base units

interface Internals {
  vaults: Map<string, { balance: bigint; awake: boolean }>;
  routes: Map<string, { at: number; r: { via: "direct" | "openrouter" | null; model: { provider: string; id: string } | null; why: string | null } }>;
  attempts: Map<string, { agent: string; maxUsd: number; via?: string | null; totals: { usd: number; sandbox_s: number } }>;
  state: { agents: Record<string, unknown>; window?: { start: number; window_s: number; usd: number }; closed: ClosedEpoch[]; subsidized_usd_total?: number; open: { usage: Record<string, unknown> } };
  postRoom(agent: string, reserve?: number): number;
  epochs(force?: boolean): Promise<void>;
  usageOf(agent: string): { usd: number; sandbox_s: number };
}

async function setup(o: { over?: Record<string, unknown>; balance?: bigint; price?: PriceSource; providerBalance?: OpenRouterBalance; clock?: { t: number } } = {}) {
  const clock = o.clock ?? { t: T0 };
  const cfg = parseConfig({ mode: "sim", core: "http://127.0.0.1:9", runtime_key: "k", state_dir: scratch(), compute_price_line_per_usd: "1", compute_price_line_per_sandbox_s: "0", attempt_max_usd: 0.5, sandbox_reserve_s: 0, min_attempt_usd: 0.05, global_max_usd: 10, global_window_s: 86400, ...(o.over ?? {}) });
  const rt = new Runtime(cfg, { backend, runtimeKey: generateAgentKey(), proposer: () => ({ name: "none", propose: async () => null }), log: () => {}, telemetry: false, now: () => clock.t, price: o.price, providerBalance: o.providerBalance });
  await rt.start();
  const r = rt as unknown as Internals;
  const agent = generateAgentKey().id;
  r.vaults.set(agent, { balance: o.balance ?? 100n * USD, awake: true });
  r.state.agents[agent] = { key_id: "x", key_file: "x", status: "bound", discovered_at: 0, bound_at: 0, mint: null, target_repo: null, candidates: 0 };
  return { rt, r, agent, cfg, clock };
}

describe("routing per model (direct, OpenRouter, unavailable)", () => {
  const gpt = { provider: "openai", id: "gpt-5.5" };
  const opus = { provider: "anthropic", id: "claude-opus-5-5" };
  test("direct when the provider's key is here, else OpenRouter, else unavailable; never a substitute", () => {
    const direct = resolveRoute(REG, gpt, { openai: "o", openrouter: "r" });
    expect(direct.ok && direct.via).toBe("direct");
    expect(direct.ok && direct.model.id).toBe("gpt-5.5");
    expect(direct.ok && direct.fee_factor).toBe(1);
    const routed = resolveRoute(REG, gpt, { anthropic: "a", openrouter: "r" });
    expect(routed.ok && routed.via).toBe("openrouter");
    expect(routed.ok && routed.model.id).toBe("openai/gpt-5.5");
    expect(routed.ok && routed.chosen.id).toBe("gpt-5.5"); // the soul's model, not another
    expect(routed.ok && routed.fee_factor).toBeCloseTo(1.055, 12);
    expect(resolveRoute(REG, gpt, { anthropic: "a" })).toMatchObject({ ok: false });
  });
  test("Anthropic stays direct: with only an OpenRouter key an Anthropic model is unavailable", () => {
    expect(resolveRoute(REG, opus, { openrouter: "r" })).toMatchObject({ ok: false });
    const d = resolveRoute(REG, opus, { anthropic: "a", openrouter: "r" });
    expect(d.ok && d.via).toBe("direct");
  });
  test("models the direct API cannot run (no Meta API, GPT-6 Astra without function calling there) run through OpenRouter only", () => {
    const llama = resolveRoute(REG, { provider: "meta", id: "llama-4-maverick" }, { openrouter: "r" });
    expect(llama.ok && llama.model.id).toBe("meta-llama/llama-4-maverick");
    const astra = resolveRoute(REG, { provider: "openai", id: "gpt-6-astra" }, { openai: "o", openrouter: "r" });
    expect(astra.ok && astra.via).toBe("openrouter");
    expect(resolveRoute(REG, { provider: "meta", id: "llama" }, { openrouter: "r" })).toMatchObject({ ok: false });
  });
});

describe("the vault pays, no platform cap", () => {
  test("a full global window does not stop a vault-funded agent (scope subsidized, the default)", async () => {
    const s = await setup();
    s.r.state.window = { start: Date.UTC(2026, 9, 10), window_s: 86400, usd: 50 }; // far past the 10 USD cap
    expect(s.rt.budget(s.agent).usd).toBe(0.5);
    await s.rt.stop({ flush: false });
  });

  test("scope all (the kill switch) blocks at the cap as before", async () => {
    const s = await setup({ over: { global_cap_scope: "all" } });
    s.r.state.window = { start: Date.UTC(2026, 9, 10), window_s: 86400, usd: 10 };
    expect(s.rt.budget(s.agent)).toMatchObject({ usd: null, why: expect.stringMatching(/global runtime cap/) });
    await s.rt.stop({ flush: false });
  });

  test("the reserve never exceeds the vault: attempt cap, then a post's room after the running attempt's reserve", async () => {
    const s = await setup({ balance: 300_000n }); // 0.30 USD
    expect(s.rt.budget(s.agent).usd).toBeCloseTo(0.3, 9);
    // an attempt holds 0.30; a post may use only what is left after it (none)
    s.r.attempts.set(s.agent, { agent: s.agent, maxUsd: 0.3, totals: { usd: 0.1, sandbox_s: 0 } as never });
    s.r.usageOf(s.agent).usd = 0.1; // spent so far, owed in the open epoch
    expect(s.r.postRoom(s.agent)).toBe(0);
    s.r.attempts.delete(s.agent);
    // a hold (an analysis asking for 0.05) is subtracted from the next attempt's cap
    expect(s.r.postRoom(s.agent, 0.05)).toBeCloseTo(0.2, 9);
    expect(s.rt.budget(s.agent).usd).toBeCloseTo(0.15, 9);
    // a vault that cannot cover the minimum attempt does not start one
    s.r.vaults.set(s.agent, { balance: 40_000n, awake: true });
    s.r.usageOf(s.agent).usd = 0;
    expect(s.rt.budget(s.agent)).toMatchObject({ usd: null, why: expect.stringMatching(/compute vault exhausted/) });
    await s.rt.stop({ flush: false });
  });

  test("only what the vaults could not pay counts against the global window (leaf shortfall at epoch close)", async () => {
    const s = await setup({ balance: 1_000_000n }); // 1 USD in the vault
    s.r.usageOf(s.agent).usd = 1.25; // e.g. a last response past the reserve
    await s.r.epochs(true);
    const leaf = s.r.state.closed.at(-1)!.leaves[0]!;
    expect(leaf.cost).toBe("1250000");
    expect(leaf.amount).toBe("1000000");
    expect(s.r.state.subsidized_usd_total).toBeCloseTo(0.25, 9);
    expect(s.rt.capStatus().spent_usd).toBeCloseTo(0.25, 9);
    await s.rt.stop({ flush: false });
  });
});

describe("price", () => {
  const mint = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";
  // GET https://api.jup.ag/price/v3?ids=<PYUSD> as read 2026-10-10 18:2x UTC (createdAt and liquidity as answered)
  const recorded = { [mint]: { createdAt: "2024-06-07T17:00:42.369Z", liquidity: 30513181.342671704, usdPrice: 0.9998573802192423, blockId: 455352658, decimals: 6, priceChange24h: 0.014211058472770127 } };
  const feed = (body: unknown, status = 200) => {
    let n = 0;
    const f = (async () => (n++, new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch;
    return { f, calls: () => n };
  };

  test("devnet: the configured TEST rate", () => {
    expect(new FixedPrice("20", 6).current()).toMatchObject({ perUsd: 20_000_000n, status: "test", source: "config" });
  });

  test("mainnet: the quote token's Jupiter price, rounded so a debit never undercounts", async () => {
    const clock = { t: T0 };
    const p = new JupiterPrice({ mint, decimals: 6, min_usd: 0.95, max_usd: 1.05 }, { fetch: feed(recorded).f, now: () => clock.t });
    await p.refresh();
    const q = p.current(clock.t)!;
    expect(q).toMatchObject({ status: "live", source: "jupiter", usd: recorded[mint].usdPrice });
    expect(q.perUsd).toBe(perUsdOf(recorded[mint].usdPrice, 6));
    expect(Number(q.perUsd) * recorded[mint].usdPrice).toBeGreaterThanOrEqual(1e6);
  });

  test("stale, out of band or missing: no price, so no attempt starts and no usage epoch closes", async () => {
    const clock = { t: T0 };
    const ok = new JupiterPrice({ mint, decimals: 6, min_usd: 0.95, max_usd: 1.05, max_age_s: 300, refresh_s: 60 }, { fetch: feed(recorded).f, now: () => clock.t });
    const s = await setup({ price: ok, clock });
    expect(s.rt.budget(s.agent).usd).toBe(0.5);
    // the feed goes down; 6 minutes later the last reading is too old
    (ok as unknown as { deps: { fetch: typeof fetch } }).deps.fetch = feed({}, 503).f;
    clock.t += 6 * 60_000;
    await ok.refresh();
    expect(s.rt.budget(s.agent)).toMatchObject({ usd: null, why: expect.stringMatching(/waiting for a quote price .*s old/) });
    s.r.usageOf(s.agent).usd = 0.2;
    const before = s.r.state.closed.length;
    await s.r.epochs(true);
    expect(s.r.state.closed.length).toBe(before); // stays open, no amount invented
    await s.rt.stop({ flush: false });

    const off = new JupiterPrice({ mint, decimals: 6, min_usd: 0.95, max_usd: 1.05 }, { fetch: feed({ [mint]: { ...recorded[mint], usdPrice: 0.5 } }).f, now: () => T0 });
    await off.refresh();
    expect(off.current(T0)).toBeNull();
    expect(off.why(T0)).toMatch(/outside the sanity band/);
    const none = new JupiterPrice({ mint, decimals: 6, min_usd: 0.95, max_usd: 1.05 }, { fetch: feed({}).f, now: () => T0 });
    await none.refresh();
    expect(none.current(T0)).toBeNull();
    expect(none.why(T0)).toMatch(/no price/);
  });
});

describe("OpenRouter balance gate", () => {
  const api = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  test("reads total_credits - total_usage with the management key, limit_remaining with the inference key, unknown without a limit", async () => {
    const a = new OpenRouterBalance({ keys: { openrouter: "k", "openrouter-management": "m" }, floor_usd: 5, fetch: api(FX.credits) });
    expect((await a.refresh(true)).usd).toBe(3.5);
    const b = new OpenRouterBalance({ keys: { openrouter: "k" }, floor_usd: 5, fetch: api(FX.key_limited) });
    expect(await b.refresh(true)).toMatchObject({ usd: 0.3, source: "key_limit" });
    const c = new OpenRouterBalance({ keys: { openrouter: "k" }, floor_usd: 5, fetch: api(FX.key_unlimited) });
    expect(await c.refresh(true)).toMatchObject({ usd: null, source: "unknown" });
    expect(c.room()).toBeNull();
  });

  test("an OpenRouter-routed attempt waits while the known balance cannot cover its reserve; direct routes do not; a 402 marks it low", async () => {
    const ob = new OpenRouterBalance({ keys: { openrouter: "k" }, floor_usd: 5, fetch: api(FX.key_limited) });
    await ob.refresh(true); // 0.30 USD left
    const s = await setup({ providerBalance: ob });
    s.r.routes.set(s.agent, { at: T0, r: { via: "openrouter", model: { provider: "openai", id: "gpt-5.5" }, why: null } });
    expect(s.rt.budget(s.agent).usd).toBeCloseTo(0.3, 9); // capped at what OpenRouter covers
    s.r.attempts.set("other", { agent: "other", maxUsd: 0.28, via: "openrouter", totals: { usd: 0, sandbox_s: 0 } as never });
    expect(s.rt.budget(s.agent)).toMatchObject({ usd: null, why: expect.stringMatching(/provider balance low/), vault: false });
    s.r.attempts.delete("other");
    s.r.routes.set(s.agent, { at: T0, r: { via: "direct", model: { provider: "openai", id: "gpt-5.5" }, why: null } });
    expect(s.rt.budget(s.agent).usd).toBe(0.5);
    s.r.routes.set(s.agent, { at: T0, r: { via: "openrouter", model: { provider: "openai", id: "gpt-5.5" }, why: null } });
    ob.markNoCredits();
    expect(s.rt.budget(s.agent)).toMatchObject({ usd: null, why: expect.stringMatching(/provider balance low/) });
    expect(s.rt.spendReport().provider_balance.openrouter).toMatchObject({ usd: 0, low: true });
    await s.rt.stop({ flush: false });
  });

  test("unknown balance (a key without a limit): routed attempts run, a 402 then stops the next ones", async () => {
    const ob = new OpenRouterBalance({ keys: { openrouter: "k" }, floor_usd: 5, fetch: api(FX.key_unlimited) });
    await ob.refresh(true);
    const s = await setup({ providerBalance: ob });
    s.r.routes.set(s.agent, { at: T0, r: { via: "openrouter", model: { provider: "openai", id: "gpt-5.5" }, why: null } });
    expect(s.rt.budget(s.agent).usd).toBe(0.5);
    await s.rt.stop({ flush: false });
  });
});

describe("runway", () => {
  test("vault over the burn of closed usage epochs in the last 24 h; none without spend; open usage left out", async () => {
    const s = await setup({ balance: 12n * USD });
    expect(s.rt.spendReport().agents[s.agent]).toMatchObject({ vault: "12000000", vault_usd: 12, burn_per_h: null, runway_h: null });
    // two closed epochs of 1 USD each over the last 4 hours, one from two days ago (ignored), plus open usage (ignored)
    const leaf = (cost: string) => ({ agent: s.agent, amount: cost, cost, model_tokens: 0, sandbox_s: 0, usd: 0, chain_lamports: 0 });
    const ep = (n: number, opened: number, closed: number, cost: string): ClosedEpoch => ({ epoch: n, opened_at: opened, closed_at: closed, leaves: [leaf(cost)], root: null, post: null, debits: {}, done: true });
    s.r.state.closed.push(ep(1, T0 - 50 * 3600_000, T0 - 49 * 3600_000, "5000000"), ep(2, T0 - 4 * 3600_000, T0 - 3 * 3600_000, "1000000"), ep(3, T0 - 2 * 3600_000, T0 - 3600_000, "1000000"));
    s.r.usageOf(s.agent).usd = 3;
    const a = s.rt.spendReport().agents[s.agent]!;
    expect(a.burn_per_h).toBe("500000"); // 2 USD over 4 h
    expect(a.burn_usd_per_h).toBeCloseTo(0.5, 9);
    expect(a.burn_window_s).toBe(4 * 3600);
    expect(a.runway_h).toBeCloseTo(24, 9); // 12 USD / 0.5 USD per hour
    expect(s.rt.spendReport().price).toMatchObject({ source: "config", status: "test", line_per_usd: "1000000" });
    await s.rt.stop({ flush: false });
  });
});

describe("live always (owner direction 2026-10-10)", () => {
  test("slots grow to one per funded agent, never past the ceiling, never below max_concurrent", async () => {
    const s = await setup({ over: { max_concurrent: 1, max_concurrent_ceiling: 3 } });
    const add = (balance: bigint) => {
      const a = generateAgentKey().id;
      s.r.vaults.set(a, { balance, awake: true });
      s.r.state.agents[a] = { key_id: "x", key_file: "x", status: "bound", discovered_at: 0, bound_at: 0, mint: null, target_repo: null, candidates: 0 };
      return a;
    };
    expect(s.rt.slots()).toBe(1); // one funded agent
    add(100n * USD);
    expect(s.rt.slots()).toBe(2);
    add(10n); // cannot pay: no slot for it
    expect(s.rt.slots()).toBe(2);
    add(100n * USD);
    add(100n * USD);
    expect(s.rt.slots()).toBe(3); // the ceiling
    await s.rt.stop({ flush: false });
  });

  test("OpenRouter balance reading: /credits answers the inference key too (as on 2026-10-10)", async () => {
    const ob = new OpenRouterBalance({ keys: { openrouter: "k" }, floor_usd: 5, fetch: (async (u: string) => new Response(JSON.stringify(String(u).endsWith("/credits") ? FX.credits : FX.key_unlimited))) as unknown as typeof fetch });
    expect(await ob.refresh(true)).toMatchObject({ usd: 3.5, source: "credits" });
  });
});
