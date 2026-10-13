import { describe, expect, test } from "bun:test";
import { fillCandles } from "../src/candle-fill.ts";
import type { Candle } from "../src/market.ts";

const c = (t: number, open: number, close: number, volume = 10, trades = 1): Candle =>
  ({ t, open, high: Math.max(open, close), low: Math.min(open, close), close, volume, volume_base: volume, trades });

describe("fillCandles", () => {
  test("one trade twelve hours ago is a continuous line to now, not one bar", () => {
    const out = fillCandles([c(3000, 1, 2)], 300, 3000 + 12 * 3600 + 17);
    expect(out.length).toBe(1 + 144);
    expect(out[0]).toEqual(c(3000, 1, 2));
    for (const x of out.slice(1)) expect([x.open, x.high, x.low, x.close, x.volume, x.trades]).toEqual([2, 2, 2, 2, 0, 0]);
    for (let i = 1; i < out.length; i++) expect(out[i]!.t - out[i - 1]!.t).toBe(300);
    expect(out[out.length - 1]!.t).toBe(Math.floor((3000 + 12 * 3600 + 17) / 300) * 300);
  });

  test("gaps between trade candles carry the close before them; trade candles are passed through untouched", () => {
    const a = c(60, 1, 2), b = c(300, 2, 5), d = c(360, 5, 4);
    const out = fillCandles([d, a, b], 60, 420);
    expect(out.map((x) => x.t)).toEqual([60, 120, 180, 240, 300, 360, 420]);
    expect(out.map((x) => x.close)).toEqual([2, 2, 2, 2, 5, 4, 4]);
    expect(out[0]).toBe(a);
    expect(out[4]).toBe(b);
    expect(out.filter((x) => x.trades === 0).every((x) => x.volume === 0 && x.open === x.close && x.high === x.low)).toBe(true);
  });

  test("nothing is invented: no candle before the first trade, none at all without trades, none past now", () => {
    expect(fillCandles([], 60, 1e9)).toEqual([]);
    const out = fillCandles([c(600, 1, 1)], 60, 660);
    expect(out[0]!.t).toBe(600);
    expect(out.length).toBe(2);
    // a clock behind the newest candle adds nothing after it
    expect(fillCandles([c(600, 1, 1)], 60, 100).length).toBe(1);
  });

  test("the sum of volume and the count of trades are the input's", () => {
    const input = [c(0, 1, 2, 7, 3), c(3600 * 5, 2, 3, 11, 2)];
    const out = fillCandles(input, 3600, 3600 * 30);
    expect(out.reduce((n, x) => n + x.volume, 0)).toBe(18);
    expect(out.reduce((n, x) => n + x.trades, 0)).toBe(5);
  });

  test("an old coin on a narrow width keeps the newest candles only, and still carries the close from before the cut", () => {
    const out = fillCandles([c(0, 1, 2), c(60 * 10, 2, 9)], 60, 60 * 100_000, 500);
    expect(out.length).toBe(500);
    expect(out[out.length - 1]!.t).toBe(60 * 100_000);
    expect(out.every((x) => x.close === 9 && x.trades === 0)).toBe(true);
  });
});
