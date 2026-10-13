import type { Candle } from "./market.ts";

// A chart of trade candles alone has holes: an interval with no trade has no candle, so a quiet coin
// draws as a few scattered bars (or one) and looks broken. The price did not stop existing in those
// intervals: the pool sat at the last trade's price. `fillCandles` says exactly that, and nothing more:
// every empty interval between the first candle and now becomes a flat candle at the close before it,
// with no volume and no trades. No price is invented; an interval before the first trade stays empty.

export const TF_SECONDS: Record<string, number> = { "1m": 60, "5m": 300, "1h": 3600, "1d": 86400 };
/** The most candles a chart is given; with more, the oldest are left out (the newest are what the chart opens on). */
export const MAX_CANDLES = 5000;

/**
 * `candles` (any order, bucket start `t` in unix seconds, width `sec`) with every empty interval up to
 * `now` filled by a flat candle at the previous close. At most `max` candles, the newest.
 */
export function fillCandles(candles: Candle[], sec: number, now: number, max = MAX_CANDLES): Candle[] {
  if (!candles.length || !(sec > 0)) return [...candles].sort((a, b) => a.t - b.t);
  const rows = [...candles].sort((a, b) => a.t - b.t);
  const end = Math.max(rows[rows.length - 1]!.t, Math.floor(now / sec) * sec);
  // only the newest `max` intervals are built, so a 1 minute chart of an old coin costs no more than `max` rows
  const first = Math.max(rows[0]!.t, end - (max - 1) * sec);
  const out: Candle[] = [];
  let i = 0;
  let prev: Candle | null = null;
  // the close before the window opens, when older candles were left out
  while (i < rows.length && rows[i]!.t < first) prev = rows[i++]!;
  for (let t = first; t <= end; t += sec) {
    while (i < rows.length && rows[i]!.t < t) prev = rows[i++]!; // a candle off the grid: its close still carries
    const c = i < rows.length && rows[i]!.t === t ? rows[i++]! : null;
    if (c) {
      out.push(c);
      prev = c;
    } else if (prev) {
      const p = prev.close;
      out.push({ t, open: p, high: p, low: p, close: p, volume: 0, volume_base: 0, trades: 0 });
    }
  }
  return out;
}
