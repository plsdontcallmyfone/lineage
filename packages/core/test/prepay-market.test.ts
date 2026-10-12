// Prepaid credits at the coin's live market price (prepay.rate_source "market", owner 2026-10-12):
// Core's current figures come from its latest copy of the indexer's reading; a landed launch is judged
// at the readings Core held around its own time, with the tolerance; without a reading it is pending,
// never underfunded on a guess. The prices here are test inputs, not market figures.
import { afterEach, describe, expect, test } from "bun:test";
import { creditsAtPrice, parsePrepayConfig } from "@units/chain";
import { generateAgentKey } from "@units/protocol";
import { prepayOf } from "../src/prepay.ts";
import { revenueOf, USD_MAX_AGE_S } from "../src/revenue.ts";
import { bare } from "./helpers.ts";

const PREPAY = { min_usd: "10", default_usd: "10", line_per_usd: "20", rate_status: "live", compute_price_line_per_usd: "20",
  compute_price_line_per_sandbox_s: "0.002", sandbox_reserve_s: 600, attempt_max_usd: 0.5, since: 0,
  rate_source: "market", rate_min_usd: 0.000001, rate_max_usd: 0.00002, rate_tolerance_bps: 1000, rate_window_s: 300 };
const envs: ReturnType<typeof bare>[] = [];
afterEach(() => {
  while (envs.length) envs.pop()!.close();
});
const env = (over: Record<string, unknown> = {}) => {
  const e = bare({ prepay: { ...PREPAY, ...over } });
  envs.push(e);
  return e;
};
type Env = ReturnType<typeof env>;
const nowS = (e: Env) => Math.floor(e.clock.now() / 1000);
/** One indexer sync as Core records it: the indexer's current reading, read `ago` seconds before now. */
const sync = (e: Env, usd: number | null, ago = 0) =>
  revenueOf(e.core).recordIndexer({ quote: "UNITS", quote_mint: null, quote_decimals: e.cfg.token_decimals, cranks: [], tokens: [],
    usd: usd === null ? null : { quote_usd: usd, sol_usd: null, read_at: nowS(e) - ago }, usd_reason: usd === null ? "the indexer gave no USD price" : null });
const launchBody = (deposit?: string) => ({ agent: generateAgentKey().id, mint: generateAgentKey().id, launcher: generateAgentKey().id,
  target_repo: "https://github.com/karpathy/minbpe", hosted: true, identity_mode: "app", ...(deposit === undefined ? {} : { deposit }) });
const landed = (e: Env, agent: string, deposit: bigint, at: number) =>
  e.core.tx(() => prepayOf(e.core).record(agent, { mint: "m", launchedAt: at, signature: "sig", deposit, woke: true, source: "chain" }));
const view = (e: Env, agent: string) => prepayOf(e.core).view(agent) as any;

describe("market rate: what Core serves", () => {
  test("no reading: no minimum and no rate are served, with the reason; the runtime's four published prices are the file's", async () => {
    const e = env();
    const p = prepayOf(e.core);
    expect(p.minBase()).toBeNull();
    expect(p.frontingView()).toMatchObject({ credits_usd: "10", credits_base_units: null, line_per_usd: null, rate_source: "market", line_per_usd_config: "20", rate: { source: "market", ok: false, usd_per_token: null } });
    const served = ((await (await fetch(`${e.base}/v1/config`)).json()) as any).network.prepay;
    expect(served).toMatchObject({ line_per_usd: null, line_per_usd_config: "20", min_base_units: null, rate: { ok: false },
      compute_price_line_per_usd: "20", compute_price_line_per_sandbox_s: "0.002", sandbox_reserve_s: 600, attempt_max_usd: 0.5 });
    expect(typeof served.rate.reason).toBe("string");
    // the wizard parses what Core serves, with or without a current rate
    expect(parsePrepayConfig(served)).toMatchObject({ rate_source: "market", line_per_usd: "20", rate_max_age_s: 120 });
  });

  test("a reading: the minimum and line_per_usd follow it; stale or outside the band, there is none again", async () => {
    const e = env();
    const p = prepayOf(e.core);
    sync(e, 0.000004, 20);
    const want = creditsAtPrice("10", 0.000004, e.cfg.token_decimals);
    expect(want).toBe(2_500_000n * 10n ** BigInt(e.cfg.token_decimals));
    expect(p.minBase()).toBe(want);
    expect(p.frontingView()).toMatchObject({ credits_base_units: want.toString(), line_per_usd: "250000", rate: { ok: true, usd_per_token: 0.000004, read_at: nowS(e) - 20, age_s: 20, max_age_s: USD_MAX_AGE_S, reason: null } });
    const served = ((await (await fetch(`${e.base}/v1/config`)).json()) as any).network.prepay;
    expect(served).toMatchObject({ line_per_usd: "250000", line_per_usd_config: "20", min_base_units: want.toString(), compute_price_line_per_usd: "20", compute_price_line_per_sandbox_s: "0.002" });
    expect(parsePrepayConfig(served).line_per_usd).toBe("20");
    // the price triples: the next sync serves a third of the coins
    e.clock.advance(60_000);
    sync(e, 0.000012);
    expect(p.minBase()).toBe(creditsAtPrice("10", 0.000012, e.cfg.token_decimals));
    // outside the band
    e.clock.advance(60_000);
    sync(e, 0.5);
    expect(p.minBase()).toBeNull();
    expect(p.rate()).toMatchObject({ ok: false, usd_per_token: 0.5 });
    expect(p.rate()!.reason).toMatch(/outside the range/);
    // a sync without a price keeps the last reading while it is fresh, and says why once it is not
    // too old
    e.clock.advance(60_000);
    sync(e, 0.000012);
    expect(p.rate()!.ok).toBe(true);
    e.clock.advance((USD_MAX_AGE_S + 1) * 1000);
    expect(p.minBase()).toBeNull();
    expect(p.rate()!.ok).toBe(false);
  });

  test("the configured rate (no rate_source) serves no rate fields at all", async () => {
    const { rate_source: _s, rate_min_usd: _a, rate_max_usd: _b, rate_tolerance_bps: _t, rate_window_s: _w, ...cfg } = PREPAY;
    const e = bare({ prepay: cfg });
    envs.push(e);
    sync(e, 0.000004);
    const served = ((await (await fetch(`${e.base}/v1/config`)).json()) as any).network.prepay;
    expect(Object.keys(served).filter((k) => /rate_(source|max|min|tol|win)|^rate$|line_per_usd_config|min_base_units/.test(k))).toEqual([]);
    expect(served.line_per_usd).toBe("20");
    expect(prepayOf(e.core).rate()).toBeNull();
    expect(prepayOf(e.core).minBase()).toBe(200n * 10n ** BigInt(e.cfg.token_decimals));
    expect(Object.keys(prepayOf(e.core).frontingView())).not.toContain("rate");
    expect(e.core.db.query("SELECT COUNT(*) AS n FROM prepay_rates").get()).toEqual({ n: 0 });
  });
});

describe("market rate: a landed launch is judged at its own time", () => {
  test("the price moves 3x between two launches: each deposit is 10 USD at its own price, and neither is judged at the other's", () => {
    const e = env();
    const d = e.cfg.token_decimals;
    const p1 = 0.000003, p2 = 0.000009;
    sync(e, p1);
    const t1 = nowS(e) + 30;
    const a = generateAgentKey().id, b = generateAgentKey().id, c = generateAgentKey().id;
    const depA = creditsAtPrice("10", p1, d);
    e.clock.advance(40_000);
    landed(e, a, depA, t1);
    expect(view(e, a)).toMatchObject({ ok: true, pending: false, deposit: depA.toString(), rate: { state: "market", usd_per_token: p1, min_at_price: depA.toString(), tolerance_bps: 1000, window_s: 300, launch_time: t1, from: "sync" } });
    // an hour later the coin is worth three times as much
    e.clock.advance(3_600_000);
    sync(e, p2);
    const t2 = nowS(e) + 10;
    const depB = creditsAtPrice("10", p2, d);
    expect(Number(depA) / Number(depB)).toBeCloseTo(3, 9); // a third of the coins
    e.clock.advance(20_000);
    landed(e, b, depB, t2);
    expect(view(e, b)).toMatchObject({ ok: true, rate: { usd_per_token: p2, min_at_price: depB.toString() } });
    // the first launch keeps its own record: nothing re-prices it
    expect(view(e, a)).toMatchObject({ ok: true, rate: { usd_per_token: p1, min_at_price: depA.toString() } });
    // a launch made at the first price with the second launch's deposit (a third of the coins) was worth 3.33 USD then: underfunded,
    // though the same coins are worth 10 USD today
    landed(e, c, depB, t1);
    const vc = view(e, c);
    expect(vc).toMatchObject({ ok: false, pending: false, rate: { usd_per_token: p1, min_at_price: depA.toString() } });
    // its wake rule is the stored minimum (10 USD less the tolerance at the first price), not today's price
    const floorP1 = creditsAtPrice("10", p1, d, 1000);
    expect(vc.min).toBe(floorP1.toString());
    expect(prepayOf(e.core).wakeThreshold(c, 1n)).toBe(floorP1);
    expect(prepayOf(e.core).minBase()).toBe(depB);
    e.clock.advance(3_600_000);
    sync(e, p2 * 2);
    expect(prepayOf(e.core).wakeThreshold(c, 1n)).toBe(floorP1);
  });

  test("tolerance: accepted exactly at min_usd less 10% at the best price in the window, refused one base unit below", () => {
    const e = env();
    const d = e.cfg.token_decimals;
    sync(e, 0.000004);
    e.clock.advance(60_000);
    sync(e, 0.000005); // the price ticked up after the launch was built
    const at = nowS(e) - 30;
    const floor = creditsAtPrice("10", 0.000005, d, 1000);
    expect(floor).toBe(1_800_000n * 10n ** BigInt(d));
    const a = generateAgentKey().id, b = generateAgentKey().id, c = generateAgentKey().id;
    landed(e, a, floor, at);
    landed(e, b, floor - 1n, at);
    // a launch built at the earlier reading (2,500,000 coins) is of course accepted too
    landed(e, c, creditsAtPrice("10", 0.000004, d), at);
    expect(view(e, a)).toMatchObject({ ok: true, min: floor.toString(), rate: { usd_per_token: 0.000005 } });
    expect(view(e, b)).toMatchObject({ ok: false, min: floor.toString() });
    expect(view(e, c).ok).toBe(true);
  });

  test("window: a reading exactly rate_window_s from the launch counts, one second further does not (pending)", () => {
    const e = env();
    const d = e.cfg.token_decimals;
    sync(e, 0.000004);
    const read = nowS(e);
    const dep = creditsAtPrice("10", 0.000004, d);
    const a = generateAgentKey().id, b = generateAgentKey().id, c = generateAgentKey().id;
    landed(e, a, dep, read + 300);
    landed(e, b, dep, read + 301);
    landed(e, c, dep, read - 300);
    expect(view(e, a)).toMatchObject({ ok: true, pending: false });
    expect(view(e, b)).toMatchObject({ ok: true, pending: true, min: null, rate: { state: "pending", usd_per_token: null, launch_time: read + 301 } });
    expect(view(e, c)).toMatchObject({ ok: true, pending: false });
  });

  test("a reading outside the band prices a launch at the band's edge, never beyond it", () => {
    const e = env();
    const d = e.cfg.token_decimals;
    sync(e, 0.5); // far above rate_max_usd 0.00002
    const a = generateAgentKey().id, b = generateAgentKey().id;
    const floor = creditsAtPrice("10", 0.00002, d, 1000);
    landed(e, a, floor, nowS(e));
    landed(e, b, floor - 1n, nowS(e));
    expect(view(e, a)).toMatchObject({ ok: true, rate: { usd_per_token: 0.00002 } });
    expect(view(e, b).ok).toBe(false);
  });
});

describe("market rate: no reading for the launch's time", () => {
  test("recorded ok and pending, awake kept; judged when a reading for that time arrives", () => {
    const e = env();
    const d = e.cfg.token_decimals;
    const good = launchBody(), short = launchBody();
    for (const b of [good, short]) {
      e.core.launchAgent(b);
      e.core.agentFees({ agent: b.agent, amount: (e.cfg.wake_threshold * 2n).toString() }, { shadow: true });
      expect(e.core.agentView(b.agent).awake).toBe(true);
    }
    const at = nowS(e);
    landed(e, good.agent, creditsAtPrice("10", 0.000004, d), at);
    landed(e, short.agent, 5n, at);
    expect(view(e, short.agent)).toMatchObject({ checked: true, ok: true, pending: true, min: null });
    expect(e.core.agentView(short.agent).awake).toBe(true); // not put to sleep on a guess
    expect(prepayOf(e.core).wakeThreshold(short.agent, 7n)).toBe(7n);
    expect(prepayOf(e.core).pending().map((x) => x.agent).sort()).toEqual([good.agent, short.agent].sort());
    // an indexer sync with no price changes nothing
    e.clock.advance(60_000);
    sync(e, null);
    expect(view(e, short.agent).pending).toBe(true);
    // the next sync brings a reading inside the window
    e.clock.advance(60_000);
    sync(e, 0.000004, 10);
    expect(view(e, good.agent)).toMatchObject({ ok: true, pending: false, rate: { state: "market", usd_per_token: 0.000004, from: "sync" } });
    expect(view(e, short.agent)).toMatchObject({ ok: false, pending: false, min: creditsAtPrice("10", 0.000004, d, 1000).toString() });
    expect(e.core.agentView(good.agent).awake).toBe(true);
    expect(e.core.agentView(short.agent).awake).toBe(false);
    expect(prepayOf(e.core).pending()).toEqual([]);
  });

  test("Core's readings resume too late for the window: the indexer's stored sample for the launch's time decides", async () => {
    const e = env();
    const d = e.cfg.token_decimals;
    const a = generateAgentKey().id;
    const at = nowS(e);
    const dep = creditsAtPrice("10", 0.000004, d);
    landed(e, a, dep, at);
    e.clock.advance(3_600_000); // Core hears from the indexer again an hour later, at a different price
    const asked: string[] = [];
    const f = (async (u: string | URL | Request) => {
      const url = new URL(String(u));
      asked.push(url.pathname + url.search);
      if (url.pathname === "/market/flows") return Response.json({ quote: "UNITS", quote_mint: null, quote_decimals: d, cranks: [], tokens: [], usd: { ok: true, usd: 0.000016, read_at: nowS(e) - 5 } });
      if (url.pathname === "/market/quote-usd" && url.searchParams.get("at") === String(at)) return Response.json({ ok: true, at, usd: 0.000004, read_at: at - 120 });
      return new Response("no", { status: 404 });
    }) as unknown as typeof fetch;
    await revenueOf(e.core).sample({ indexer: "http://indexer" }, f);
    expect(asked).toEqual(["/market/flows?hidden=1", `/market/quote-usd?at=${at}`]);
    expect(view(e, a)).toMatchObject({ ok: true, pending: false, rate: { state: "market", usd_per_token: 0.000004, read_at: at - 120, from: "sample", min_at_price: dep.toString() } });
    // nothing left to ask about
    asked.length = 0;
    await revenueOf(e.core).sample({ indexer: "http://indexer" }, f);
    expect(asked).toEqual(["/market/flows?hidden=1"]);
  });

  test("the indexer has no sample either: the launch stays ok and pending", async () => {
    const e = env();
    const a = generateAgentKey().id;
    landed(e, a, 5n, nowS(e));
    e.clock.advance(3_600_000);
    const f = (async (u: string | URL | Request) => (new URL(String(u)).pathname === "/market/flows"
      ? Response.json({ quote: "UNITS", quote_mint: null, quote_decimals: 9, cranks: [], tokens: [], usd: { ok: false, reason: "down" } })
      : Response.json({ ok: false, reason: "no USD price is stored for that time" }))) as unknown as typeof fetch;
    await revenueOf(e.core).sample({ indexer: "http://indexer" }, f);
    expect(view(e, a)).toMatchObject({ ok: true, pending: true });
  });

  test("readings are kept a day, then pruned", () => {
    const e = env();
    sync(e, 0.000004);
    e.clock.advance(60_000);
    sync(e, 0.000005);
    expect(e.core.db.query("SELECT COUNT(*) AS n FROM prepay_rates").get()).toEqual({ n: 2 });
    e.clock.advance(86_400_000 + 1_000);
    sync(e, 0.000006);
    expect(e.core.db.query("SELECT usd FROM prepay_rates").all()).toEqual([{ usd: 0.000006 }]);
  });
});

describe("market rate: simulated launch", () => {
  test("the current reading with the same tolerance; refused without a usable reading", () => {
    const e = env();
    const d = e.cfg.token_decimals;
    expect(() => e.core.launchAgent(launchBody("1"))).toThrow(/no usable price for the launch credits/);
    sync(e, 0.000004);
    const floor = creditsAtPrice("10", 0.000004, d, 1000);
    expect(() => e.core.launchAgent(launchBody((floor - 1n).toString()))).toThrow(/below the minimum/);
    const b = launchBody(floor.toString());
    expect((e.core.launchAgent(b) as { awake: boolean }).awake).toBe(true);
    expect(view(e, b.agent)).toMatchObject({ ok: true, pending: false, source: "sim", min: floor.toString(), rate: { usd_per_token: 0.000004 } });
  });
});
