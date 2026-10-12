// The launch credits at the coin's live market price (prepay.rate_source "market", owner 2026-10-12):
// the config fields, the deposit arithmetic, the tolerance and the reading rule Core and the wizard
// share. Prices here are test inputs, not market figures.
import { describe, expect, test } from "bun:test";
import * as c from "../src/index.ts";

const BASE = { min_usd: "10", default_usd: "10", line_per_usd: "333000", rate_status: "live", compute_price_line_per_usd: "333000",
  compute_price_line_per_sandbox_s: "0.5", sandbox_reserve_s: 600, attempt_max_usd: 0.5, since: 0 };
const MARKET = { ...BASE, rate_source: "market", rate_min_usd: 0.0000003, rate_max_usd: 0.00003 };

describe("prepay rate_source", () => {
  test("absent or config: parsed exactly as before, with no rate field", () => {
    const p = c.parsePrepayConfig(BASE);
    expect(Object.keys(p).filter((k) => k.startsWith("rate_") && k !== "rate_status")).toEqual([]);
    expect(c.parsePrepayConfig({ ...BASE, rate_source: "config", rate_max_age_s: 5 })).toEqual(p);
    expect(c.marketRate(p)).toBeNull();
    expect(c.requiredCredits(p, 6)).toBe(3_330_000_000_000n);
    expect(() => c.parsePrepayConfig({ ...BASE, rate_source: "oracle" })).toThrow(/rate_source/);
  });
  test("market: the band is required, the rest defaults to 120 s, 1000 bps and 300 s", () => {
    const p = c.parsePrepayConfig(MARKET);
    expect(p).toMatchObject({ rate_source: "market", rate_max_age_s: 120, rate_min_usd: 0.0000003, rate_max_usd: 0.00003, rate_tolerance_bps: 1000, rate_window_s: 300, line_per_usd: "333000" });
    expect(c.marketRate(p)).toEqual({ maxAgeS: 120, minUsd: 0.0000003, maxUsd: 0.00003, toleranceBps: 1000, windowS: 300 });
    expect(c.parsePrepayConfig({ ...MARKET, rate_max_age_s: 60, rate_tolerance_bps: 500, rate_window_s: 600 })).toMatchObject({ rate_max_age_s: 60, rate_tolerance_bps: 500, rate_window_s: 600 });
    expect(() => c.parsePrepayConfig({ ...BASE, rate_source: "market" })).toThrow(/rate_min_usd and rate_max_usd/);
    expect(() => c.parsePrepayConfig({ ...MARKET, rate_min_usd: "0.0000003" })).toThrow(/rate_min_usd/);
    expect(() => c.parsePrepayConfig({ ...MARKET, rate_max_usd: 0.0000001 })).toThrow(/rate_min_usd < rate_max_usd/);
    expect(() => c.parsePrepayConfig({ ...MARKET, rate_tolerance_bps: 10_000 })).toThrow(/rate_tolerance_bps/);
    expect(() => c.parsePrepayConfig({ ...MARKET, rate_max_age_s: 0 })).toThrow(/rate_max_age_s/);
    expect(() => c.parsePrepayConfig({ ...MARKET, rate_window_s: 1.5 })).toThrow(/rate_window_s/);
    // the static rate is never the deposit in market mode
    expect(() => c.requiredCredits(p, 6)).toThrow(/live price/);
  });
  test("market: what Core serves parses too (line_per_usd current or null, the file's value beside it)", () => {
    expect(c.parsePrepayConfig({ ...MARKET, line_per_usd: null, line_per_usd_config: "333000", min_base_units: null, rate: { ok: false } }).line_per_usd).toBe("333000");
    expect(c.parsePrepayConfig({ ...MARKET, line_per_usd: "111000.5", line_per_usd_config: "333000" }).line_per_usd).toBe("333000");
    expect(() => c.parsePrepayConfig({ ...MARKET, line_per_usd: null })).toThrow(/line_per_usd/);
    expect(() => c.parsePrepayConfig({ ...BASE, line_per_usd: null, line_per_usd_config: "333000" })).toThrow(/line_per_usd/);
  });
});

describe("credits at a price", () => {
  test("ceil(usd / price) in base units; never short of the dollar figure", () => {
    expect(c.creditsAtPrice("10", 0.000004, 6)).toBe(2_500_000_000_000n);
    expect(c.creditsAtPrice("10", 0.5, 6)).toBe(20_000_000n);
    expect(c.creditsAtPrice("12.50", 0.5, 6)).toBe(25_000_000n);
    expect(c.creditsAtPrice("1", 3, 0)).toBe(1n); // a third of a coin rounds up
    // 10 / 0.000003003 = 3,330,003.33 coins
    const d = c.creditsAtPrice("10", 0.000003003, 6);
    expect(Number(d) / 1e6).toBeCloseTo(10 / 0.000003003, 3);
    expect(Number(d) * 0.000003003 / 1e6).toBeGreaterThanOrEqual(10 - 1e-9);
    expect(() => c.creditsAtPrice("10", 0, 6)).toThrow(/positive/);
    expect(() => c.creditsAtPrice("10", Number.NaN, 6)).toThrow(/positive/);
    expect(() => c.creditsAtPrice("ten", 1, 6)).toThrow(/decimal/);
  });
  test("tolerance: the smallest deposit worth usd x (1 - tolerance); accepted at the edge, refused one base unit below", () => {
    const floor = c.creditsAtPrice("10", 0.000004, 6, 1000);
    expect(floor).toBe(2_250_000_000_000n); // 9 USD at 0.000004
    expect(c.depositCoversUsd(floor, 0.000004, "10", 6, 1000)).toBe(true);
    expect(c.depositCoversUsd(floor - 1n, 0.000004, "10", 6, 1000)).toBe(false);
    expect(c.depositCoversUsd(c.creditsAtPrice("10", 0.000004, 6), 0.000004, "10", 6, 0)).toBe(true);
    expect(c.depositCoversUsd(c.creditsAtPrice("10", 0.000004, 6) - 1n, 0.000004, "10", 6, 0)).toBe(false);
    // a deposit built at one price, judged after the coin fell 10%: at the edge; after 11%: beyond it
    const built = c.creditsAtPrice("10", 0.000004, 6);
    expect(c.depositCoversUsd(built, 0.0000036, "10", 6, 1000)).toBe(true);
    expect(c.depositCoversUsd(built, 0.00000356, "10", 6, 1000)).toBe(false);
    expect(() => c.creditsAtPrice("10", 1, 6, 10_000)).toThrow(/tolerance/);
  });
  test("whole coins per USD and plain decimals", () => {
    expect(c.linePerUsdAt(0.000004)).toBe("250000");
    expect(c.linePerUsdAt(0.5)).toBe("2");
    expect(c.linePerUsdAt(3)).toBe("0.333333");
    expect(c.linePerUsdAt(0.008)).toBe("125");
    expect(c.plainDec(0.000003003)).toBe("0.000003003");
    expect(c.plainDec(0.0000003)).toBe("0.0000003");
    expect(c.plainDec(12.3456)).toBe("12.35");
    expect(c.plainDec(1200)).toBe("1200");
  });
});

describe("the reading rule (the wizard's and Core's)", () => {
  const p = c.parsePrepayConfig(MARKET);
  const r = (usd: number, age_s: number) => ({ usd, read_at: 1_000 - age_s, age_s });
  test("a fresh reading inside the band is usable", () => {
    expect(c.checkMarketRate(p, r(0.000003, 12))).toEqual({ ok: true, usd: 0.000003, read_at: 988, age_s: 12, max_age_s: 120 });
    expect(c.checkMarketRate(p, r(0.000003, 120)).ok).toBe(true);
    expect(c.checkMarketRate(p, r(0.0000003, 0)).ok).toBe(true);
    expect(c.checkMarketRate(p, r(0.00003, 0)).ok).toBe(true);
  });
  test("missing: refused with the indexer's reason", () => {
    expect(c.checkMarketRate(p, null, { symbol: "UNITS", why: "the market indexer answered HTTP 502" })).toMatchObject({ ok: false, usd: null,
      reason: "the UNITS price could not be read (the market indexer answered HTTP 502)" });
    expect(c.checkMarketRate(p, null)).toMatchObject({ ok: false, reason: "the coin price could not be read" });
    expect(c.checkMarketRate(p, { usd: Number.NaN, read_at: 1, age_s: 1 }).ok).toBe(false);
  });
  test("stale: refused one second past rate_max_age_s (Core passes its own limit)", () => {
    expect(c.checkMarketRate(p, r(0.000003, 121), { symbol: "UNITS" })).toMatchObject({ ok: false, age_s: 121, max_age_s: 120,
      reason: "the UNITS price was read 121 s ago and a launch needs one read in the last 120 s" });
    expect(c.checkMarketRate(p, r(0.000003, 121), { maxAgeS: 420 }).ok).toBe(true);
    expect(c.checkMarketRate(p, r(0.000003, 421), { maxAgeS: 420 }).ok).toBe(false);
  });
  test("outside the band: refused on either side", () => {
    expect(c.checkMarketRate(p, r(0.00003001, 5), { symbol: "UNITS" })).toMatchObject({ ok: false, usd: 0.00003001,
      reason: "the UNITS price, 0.00003001 USD, is outside the range a launch accepts (0.0000003 to 0.00003 USD)" });
    expect(c.checkMarketRate(p, r(0.00000029, 5)).ok).toBe(false);
  });
  test("not for the configured rate", () => {
    expect(() => c.checkMarketRate(c.parsePrepayConfig(BASE), r(1, 1))).toThrow(/not market/);
  });
});
