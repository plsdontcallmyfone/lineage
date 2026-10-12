// The wizard's credits at the coin's live market price (wallet/credits-rate.ts, owner 2026-10-12):
// the deposit from the page's one USD reading, and the refusals (no reading, a stale one, outside
// Core's band). The prices are test inputs, not market figures.
import { describe, expect, test } from "bun:test";
import { creditsAtPrice, parsePrepayConfig } from "../../../packages/chain/src/browser/index.ts";
import { setUsdReading, usdReading, usdReadingAge } from "../src/usd.ts";
import { creditsFor, currentRate, marketMode, RateBlocked, rateLine, rereadRate, REREAD_MS } from "../wallet/credits-rate.ts";

const BASE = { min_usd: "10", default_usd: "10", line_per_usd: "20", rate_status: "live", compute_price_line_per_usd: "20",
  compute_price_line_per_sandbox_s: "0.002", sandbox_reserve_s: 600, attempt_max_usd: 0.5, since: 0 };
const CONFIG = parsePrepayConfig(BASE);
const MARKET = parsePrepayConfig({ ...BASE, rate_source: "market", rate_min_usd: 0.000001, rate_max_usd: 0.00001, rate_max_age_s: 120 });
const reading = (usd: number, age_s: number) => setUsdReading({ ok: true, usd, read_at: 1_791_800_000 - age_s, age_s, sol_usd: 200, pair: "SOL", venue: "curve" });
const blocked = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RateBlocked);
    return (e as Error).message;
  }
  throw new Error("not refused");
};

describe("launch credits: the deposit", () => {
  test("the configured rate is the old arithmetic and ignores the reading", () => {
    reading(0.000003003, 5);
    expect(marketMode(CONFIG)).toBe(false);
    expect(creditsFor(CONFIG, "10", 6, "UNITS")).toEqual({ base: 200_000_000n, rate: null });
    setUsdReading({ ok: false, reason: "down" });
    expect(creditsFor(CONFIG, "12.50", 6, "UNITS").base).toBe(250_000_000n);
  });
  test("the market rate: ceil(usd / the reading's price), with the reading it used", () => {
    reading(0.000003003, 12);
    expect(marketMode(MARKET)).toBe(true);
    const r = creditsFor(MARKET, "10", 6, "UNITS");
    expect(r.base).toBe(creditsAtPrice("10", 0.000003003, 6));
    expect(r.rate).toMatchObject({ ok: true, usd: 0.000003003, read_at: 1_791_800_000 - 12, age_s: 12 });
    expect(Number(r.base) / 1e6 * 0.000003003).toBeGreaterThanOrEqual(10 - 1e-9);
    // more credits typed in: more coin at the same reading
    expect(creditsFor(MARKET, "25", 6, "UNITS").base).toBe(creditsAtPrice("25", 0.000003003, 6));
    // the price triples: a third of the coin
    reading(0.000009009, 3);
    expect(Number(r.base) / Number(creditsFor(MARKET, "10", 6, "UNITS").base)).toBeCloseTo(3, 9);
  });
  test("the line shown in Funding and Review, in the page's dollar format", () => {
    expect(rateLine({ usd: "10", base: 3_330_003_330_004n, rate: { usd: 0.000003003, age_s: 12.4 }, symbol: "UNITS", amount: "3,330,003.330004" }))
      .toBe("$10.00 of credits = 3,330,003.330004 UNITS at $0.000003003, read 12 s ago");
  });
});

describe("launch credits: refusals at the market rate", () => {
  test("no reading: one plain sentence with the indexer's reason", () => {
    setUsdReading({ ok: false, reason: "the market indexer answered HTTP 502" });
    expect(blocked(() => creditsFor(MARKET, "10", 6, "UNITS"))).toBe("Launch disabled: the UNITS price could not be read (the market indexer answered HTTP 502).");
    expect(currentRate(MARKET, "UNITS").ok).toBe(false);
  });
  test("a stale reading: usable at rate_max_age_s, refused past it", () => {
    reading(0.000003, 119);
    expect(creditsFor(MARKET, "10", 6, "UNITS").base).toBe(creditsAtPrice("10", 0.000003, 6));
    reading(0.000003, 121);
    expect(blocked(() => creditsFor(MARKET, "10", 6, "UNITS"))).toBe("Launch disabled: the UNITS price was read 121 s ago and a launch needs one read in the last 120 s.");
  });
  test("a reading ages while the page holds it", () => {
    reading(0.000003, 100);
    const real = Date.now;
    try {
      const t0 = real();
      Date.now = () => t0 + 30_000;
      expect(usdReadingAge()!).toBeGreaterThanOrEqual(130);
      expect(blocked(() => creditsFor(MARKET, "10", 6, "UNITS"))).toMatch(/was read 13\d s ago/);
    } finally {
      Date.now = real;
    }
  });
  test("outside the band, either side", () => {
    reading(0.0000100001, 5);
    expect(blocked(() => creditsFor(MARKET, "10", 6, "UNITS"))).toBe("Launch disabled: the UNITS price, 0.0000100001 USD, is outside the range a launch accepts (0.000001 to 0.00001 USD).");
    reading(0.0000009, 5);
    expect(blocked(() => creditsFor(MARKET, "10", 6, "UNITS"))).toMatch(/outside the range a launch accepts/);
    reading(0.00001, 5);
    expect(creditsFor(MARKET, "10", 6, "UNITS").base).toBe(1_000_000_000_000n);
  });
});

describe("launch credits: the price is asked again before the build", () => {
  test("a reading held longer than a few seconds is fetched again from /market/quote-usd; a fresh one is not", async () => {
    const asked: string[] = [];
    const f = (async (u: string | URL | Request) => {
      asked.push(String(u));
      return Response.json({ ok: true, usd: 0.000004, read_at: 1_791_800_100, age_s: 2, sol_usd: 200, pair: "SOL", venue: "curve" });
    }) as unknown as typeof fetch;
    reading(0.000003, 10);
    await rereadRate("", f);
    expect(asked).toEqual([]); // set just now
    const real = Date.now;
    try {
      const t0 = real();
      Date.now = () => t0 + REREAD_MS + 1;
      await rereadRate("", f);
    } finally {
      Date.now = real;
    }
    expect(asked).toEqual(["/market/quote-usd"]);
    expect(usdReading()).toMatchObject({ ok: true, usd: 0.000004 });
    expect(creditsFor(MARKET, "10", 6, "UNITS").base).toBe(2_500_000_000_000n);
  });
});
