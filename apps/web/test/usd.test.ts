import { describe, expect, test } from "bun:test";
import { paramCells } from "../src/building.ts";
import { usdAmountFig, usdBasisNote, usdCandles, usdChangeFig, usdPriceFig } from "../src/market.ts";
import { fmtUsd, fmtUsdPrice, loadUsd, quoteToUsd, setUsdReading, solToUsd, USD_NA, usdFig, usdText } from "../src/usd.ts";

// The app's one dollar formatter and the figures built on it (owner 2026-10-12: everything in USD).

describe("dollar formatter", () => {
  test("amounts: whole dollars from $1,000, cents from $1, four significant digits below", () => {
    expect([312_508_385.4, 1234.5, 999.994, 12.345, 1, 0.312508, 0.001234567, 0.00001234, 0].map((n) => fmtUsd(n)))
      .toEqual(["$312,508,385", "$1,235", "$999.99", "$12.35", "$1.00", "$0.3125", "$0.001235", "$0.00001234", "$0"]);
    expect(fmtUsd(-12.5)).toBe("-$12.50");
  });
  test("compact for cards: $1.2M, $312.5M, $4.1K; the full form below $1,000", () => {
    expect([1_234_567, 312_508_385, 4_100, 2_500_000_000, 950, 0.5].map((n) => fmtUsd(n, { compact: true }))).toEqual(["$1.2M", "$312.5M", "$4.1K", "$2.5B", "$950.00", "$0.5"]);
  });
  test("prices keep their significant digits and never use an exponent", () => {
    expect([0.00001234, 0.000000098765, 0.3125084, 1.234, 1234.567].map(fmtUsdPrice)).toEqual(["$0.00001234", "$0.00000009877", "$0.3125", "$1.23", "$1,234.57"]);
  });
  test("no value: the placeholder, with a dollar sign and no dash", () => {
    for (const v of [null, undefined, NaN, Infinity]) expect([fmtUsd(v), fmtUsdPrice(v)]).toEqual([USD_NA, USD_NA]);
    expect(USD_NA).toBe("$ unavailable");
    expect(USD_NA).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("figures", () => {
  test("a figure that exists without a dollar price reads $ unavailable; one that does not exist reads no data yet", () => {
    expect(usdText(null, { exists: true })).toBe(USD_NA);
    expect(usdText(null, { exists: false })).toBe("no data yet");
    expect(usdFig(null, { exists: false }).s).toContain("no data yet");
    expect(usdFig(null, { exists: false }).s).not.toContain("TBA");
    const na = usdFig(null, { field: "price_usd" }).s;
    expect(na).toContain(">$ unavailable<");
    expect(na).toContain('data-f="price_usd"');
    expect(usdFig(1234.5, { field: "market_cap_usd" }).s).toBe('<span class="num" data-v="1234.5" data-f="market_cap_usd" title="$1234.5">$1,235</span>');
  });
  test("market figures show the API's dollar field, never the quote-coin number", () => {
    const seen = (h: string) => h.replace(/<[^>]+>/g, " ");
    expect(seen(usdPriceFig(0.000625, 0.312508, "price_usd").s).trim()).toBe("$0.000625");
    expect(seen(usdAmountFig(625_016.77, 312_508_385, "market_cap_usd", true).s).trim()).toBe("$625K");
    expect(seen(usdAmountFig(625_016.77, 312_508_385).s).trim()).toBe("$625,017");
    // feed down: the quote figures are there, the dollar ones are not
    const cells = seen(paramCells({ price: 0.312508, market_cap: 312_508_385, volume_24h: 0, change_24h: null, price_usd: null, market_cap_usd: null, volume_24h_usd: null, change_24h_usd: null }).s);
    expect(cells.match(/\$ unavailable/g)).toHaveLength(3);
    expect(cells).not.toMatch(/0\.312508|312,508,385|UNITS/);
    const ok = seen(paramCells({ price: 0.312508, market_cap: 312_508_385, volume_24h: 0, change_24h: null, price_usd: 0.000625, market_cap_usd: 625_016.77, volume_24h_usd: 0, change_24h_usd: null }).s);
    expect(ok).toMatch(/Price\s+\$0\.000625\s+Market cap\s+\$625K\s+24h volume\s+\$0\s+24h change\s+no data yet/);
    // a token with no price at all yet
    expect(seen(usdPriceFig(null, null).s)).toContain("no data yet");
  });
  test("24h change: of the dollar price when the indexer has it, else against the quote coin, and the title says which", () => {
    expect(usdChangeFig({ change_24h: 0.1, change_24h_usd: 0.25 }).s).toMatch(/data-f="change_24h_usd"[^>]*>\+25%/);
    expect(usdChangeFig({ change_24h: 0.1, change_24h_usd: null }).s).toMatch(/data-f="change_24h"[^>]*not on record[^>]*>\+10%/);
  });
  test("candles in dollars: the _usd fields, or nothing when one is missing; one caption sentence per basis", () => {
    const c = { t: 1, open: 1, high: 2, low: 1, close: 2, volume: 10, volume_base: 5, trades: 1, open_usd: 0.002, high_usd: 0.004, low_usd: 0.002, close_usd: 0.004, volume_usd: 0.02 };
    expect(usdCandles({ candles: [c], usd_basis: "current", start_price_usd: 0.001 })).toEqual({ candles: [{ ...c, open: 0.002, high: 0.004, low: 0.002, close: 0.004, volume: 0.02 }], basis: "current", start: 0.001 });
    expect(usdCandles({ candles: [c, { ...c, close_usd: null }] })).toBeNull();
    expect(usdBasisNote("current")).toMatch(/today's UNITS price/);
    expect(usdBasisNote("at_time")).toMatch(/price of its own time/);
    expect(usdBasisNote(null)).toContain(USD_NA);
    expect(usdBasisNote("current", false)).toBe("");
    for (const b of ["at_time", "current", "mixed", null] as const) expect(usdBasisNote(b)).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("the reading", () => {
  test("ledger amounts convert at the indexer's reading; none without one", async () => {
    setUsdReading({ ok: false, reason: "Jupiter answered HTTP 503" });
    expect([quoteToUsd(100), solToUsd(1)]).toEqual([null, null]);
    setUsdReading({ ok: true, usd: 0.002, read_at: 1, age_s: 0, sol_usd: 200, pair: "SOL", venue: "curve" });
    expect(quoteToUsd(100)).toBeCloseTo(0.2, 12);
    expect(solToUsd(0.05)).toBeCloseTo(10, 12);
    expect(quoteToUsd(null)).toBeNull();
  });
  test("loadUsd: the indexer's answer, or the reason it gave none; never throws", async () => {
    const realNow = Date.now;
    let t = realNow() + 10 * 60_000;
    Date.now = () => t;
    try {
      const ok = (async () => Response.json({ quote: "UNITS", ok: true, usd: 0.003, read_at: 5, age_s: 1, sol_usd: 190, pair: "SOL", venue: "pool" })) as unknown as typeof fetch;
      expect(await loadUsd("", ok)).toMatchObject({ ok: true, usd: 0.003 });
      t += 60_000;
      expect(await loadUsd("", (async () => Response.json({ quote: "UNITS", ok: false, reason: "the last USD price reading is too old" })) as unknown as typeof fetch)).toEqual({ ok: false, reason: "the last USD price reading is too old" });
      t += 60_000;
      expect(await loadUsd("", (async () => { throw new Error("connection refused"); }) as unknown as typeof fetch)).toMatchObject({ ok: false, reason: expect.stringMatching(/did not answer/) });
      expect(quoteToUsd(5)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });
});
