import { describe, expect, test } from "bun:test";
import { marketApi } from "../src/api.ts";
import { openDb } from "../src/db.ts";
import { MAX_AGE_S, USD_SCHEMA, usdNear, type QuoteUsdReading } from "../src/usd.ts";

// One dollar basis for every market figure (the header of src/api.ts): "then" is the UNITS figure at
// the UNITS/USD reading stored for that time, "now" the pool's current UNITS price at the current
// reading. These tests pin the definitions the pages rely on: the chart's change equals the stat's, a
// coin that did not trade follows UNITS in dollars, and a missing reading gives no dollar figure.

const MINT = "So11111111111111111111111111111111111111112";
const NOW = 1_800_000_000; // a multiple of 300 and 3600
const H = 3600;

function setup(o: { born: number; spot: number; start: number }) {
  const db = openDb(":memory:");
  db.exec(USD_SCHEMA);
  db.query("INSERT INTO meta (k, v) VALUES ('line_decimals', '6'), ('line_mint', 'Q')").run();
  db.query(`INSERT INTO tokens (mint, agent, launcher, launch_account, symbol, decimals, created_at, dbc_config, dbc_pool, dbc_base_vault, dbc_quote_vault, compute_vault, supply,
    spot_price, start_price, venue) VALUES (?, 'A', 'L', 'LA', 'COIN', 6, ?, 'C', 'P', 'BV', 'QV', 'V', '1000000000000000', ?, ?, 'pump')`).run(MINT, o.born, o.spot, o.start);
  let n = 0;
  const trade = (time: number, after: number, quote = 10) => db.query(`INSERT INTO trades (sig, idx, mint, venue, slot, time, side, base_raw, quote_raw, base, quote, price, spot_after, fee_raw, trader, source)
    VALUES (?, 0, ?, 'curve', ?, ?, 'buy', '0', '0', 100, ?, ?, ?, '0', 'T', 'event')`).run(`S${++n}`, MINT, n, time, quote, after, after);
  const sample = (t: number, usd: number) => db.query("INSERT OR REPLACE INTO quote_usd_samples (t, usd, pair_usd, pair_per_quote, venue) VALUES (?, ?, 1, 1, 'pool')").run(t, usd);
  const reading = (usd: number): QuoteUsdReading => ({ ok: true, usd, read_at: NOW, age_s: 0, max_age_s: MAX_AGE_S, quote_mint: "Q", pair_mint: "S", pair: "SOL", pair_per_quote: 1, pair_usd: 1, sol_usd: 1,
    venue: "pool", account: "p", sources: { pair_per_quote: "x", pair_usd: "y" } });
  const api = (usd: number | null) => {
    const h = marketApi(db, () => ({}), { now: () => NOW, usd: () => (usd == null ? { ok: false, reason: "feed down", read_at: null, max_age_s: MAX_AGE_S } : reading(usd)) });
    return async (p: string) => (await (await h(new Request(`http://x/market/${p}`))).json()) as any;
  };
  return { db, trade, sample, api };
}

describe("one dollar basis", () => {
  test("the chart's change equals the stat: a coin younger than a day, from its start price at the launch's reading to the current price now", async () => {
    const BORN = NOW - 12 * H;
    const { trade, sample, api } = setup({ born: BORN, spot: 0.05, start: 0.04 });
    trade(BORN + 10, 0.045);
    trade(BORN + 2 * H, 0.05);
    for (let t = BORN - 300; t <= NOW; t += 300) sample(t, 0.0001 + ((t - BORN) / (12 * H)) * 0.0002); // UNITS triples over the 12 hours
    const get = api(0.0003);
    const d = await get(`tokens/${MINT}`);
    expect(d.change_window).toBe("since_launch");
    expect(d.price_usd).toBeCloseTo(0.05 * 0.0003, 15);
    expect(d.change_ref_usd).toBeCloseTo(0.04 * 0.0001, 15); // the start price at the launch's reading
    expect(d.change_24h_usd).toBeCloseTo(d.price_usd / d.change_ref_usd - 1, 12);
    for (const tf of ["1m", "5m", "1h", "1d"]) {
      const c = await get(`tokens/${MINT}/candles?tf=${tf}&from=${BORN - 86400}`);
      const last = c.candles[c.candles.length - 1];
      // the open interval closes at the headline price, and the legend's arithmetic (close over the reference, minus 1) gives the stat
      expect(last.close_usd).toBe(d.price_usd);
      expect(last.close_usd / c.change.ref_usd - 1).toBe(d.change_24h_usd);
      expect(c.change).toMatchObject({ pct: d.change_24h_usd, window: "since_launch", now_usd: d.price_usd });
      // the first candle opens at that same reference: the start price at the launch's reading
      expect(c.candles[0].open_usd).toBeCloseTo(d.change_ref_usd, 12);
      expect(c.start_price_usd).toBeCloseTo(d.change_ref_usd, 12);
      expect(c.usd_basis).toBe("at_time");
    }
  });

  test("the chart's change equals the stat: an older coin, from the pool price 24 hours ago at that time's reading", async () => {
    const { trade, sample, api } = setup({ born: NOW - 5 * 86400, spot: 0.5, start: 0.25 });
    trade(NOW - 2 * 86400, 0.4);
    trade(NOW - 20 * H, 0.45);
    trade(NOW - H - 20, 0.5);
    for (let t = NOW - 2 * 86400 - 300; t <= NOW; t += 300) sample(t, t < NOW - 86400 + 1 ? 0.0016 : 0.002);
    const get = api(0.0022);
    const d = await get(`tokens/${MINT}`);
    expect(d.change_window).toBe("24h");
    expect(d.change_ref_usd).toBeCloseTo(0.4 * 0.0016, 15);
    expect(d.change_24h_usd).toBeCloseTo((0.5 * 0.0022) / (0.4 * 0.0016) - 1, 12);
    const c = await get(`tokens/${MINT}/candles?tf=1h&from=${NOW - 3 * 86400}`);
    const last = c.candles[c.candles.length - 1];
    expect(last.t).toBe(NOW);
    expect(last.close_usd / c.change.ref_usd - 1).toBe(d.change_24h_usd);
    // the candle 24 hours ago closed at the reference itself (no trade since two days: the carried 0.4 at that interval's reading)
    const then = c.candles.find((x: any) => x.t === NOW - 86400 - H);
    expect(then.trades).toBe(0);
    expect(then.close_usd).toBeCloseTo(d.change_ref_usd, 15);
    // 24h volume: each trade at the reading of its own time
    expect(d.volume_24h_usd).toBeCloseTo(10 * 0.002 + 10 * 0.002, 12);
  });

  test("a quiet coin's dollar candles follow UNITS: flat in UNITS, re-priced at each interval's own reading, no volume", async () => {
    const BORN = NOW - 6 * H;
    const { trade, sample, api } = setup({ born: BORN, spot: 0.05, start: 0.04 });
    trade(BORN + 30, 0.05);
    // UNITS: 0.0001 for two hours, 0.0002 for two, 0.00015 after
    for (let t = BORN - 300; t <= NOW; t += 300) sample(t, t < BORN + 2 * H ? 0.0001 : t < BORN + 4 * H ? 0.0002 : 0.00015);
    const c = await api(0.00015)(`tokens/${MINT}/candles?tf=1h&from=${BORN - H}`);
    expect(c.candles.map((x: any) => x.t)).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => BORN + i * H));
    const flat = c.candles.slice(1);
    expect(flat.every((x: any) => x.trades === 0 && x.volume === 0 && x.volume_usd === 0 && x.open === 0.05 && x.close === 0.05)).toBe(true);
    const usd = (v: number) => 0.05 * v;
    expect(c.candles.map((x: any) => +x.close_usd.toFixed(12))).toEqual([0.0001, 0.0001, 0.0002, 0.0002, 0.00015, 0.00015, 0.00015].map((v) => +usd(v).toFixed(12)));
    // continuous: each opens at the close before it; the move of UNITS is the candle's body
    for (let i = 1; i < c.candles.length; i++) expect(c.candles[i].open_usd).toBe(c.candles[i - 1].close_usd);
    expect(c.candles[2]).toMatchObject({ low_usd: c.candles[2].open_usd, high_usd: c.candles[2].close_usd });
    expect(c.candles[2].close_usd).toBeCloseTo(2 * c.candles[2].open_usd, 15);
    // a window that opens after the last trade still shows the carried price
    const late = await api(0.00015)(`tokens/${MINT}/candles?tf=1h&from=${BORN + 3 * H}`);
    expect(late.candles.map((x: any) => x.t)).toEqual([3, 4, 5, 6].map((i) => BORN + i * H));
    expect(late.candles.every((x: any) => x.trades === 0 && x.close === 0.05 && x.close_usd != null)).toBe(true);
    // fill=0: the trade candles alone, as before
    expect((await api(0.00015)(`tokens/${MINT}/candles?tf=1h&from=${BORN - H}&fill=0`)).candles.length).toBe(1);
    // limit: the newest intervals
    const cut = await api(0.00015)(`tokens/${MINT}/candles?tf=1m&from=${BORN - H}&limit=10`);
    expect(cut.candles.length).toBe(10);
    expect(cut.candles[9].t).toBe(NOW);
  });

  test("a missing reading gives null, never another time's price: trades, candles, volume, change, start line", async () => {
    const BORN = NOW - 6 * H;
    const { db, trade, sample, api } = setup({ born: BORN, spot: 0.05, start: 0.04 });
    trade(BORN + 30, 0.045);
    trade(BORN + 3 * H + 30, 0.05);
    // readings only from the fourth hour on: nothing within 15 minutes of the launch, of the first trade or of the first two hours
    for (let t = BORN + 3 * H; t <= NOW; t += 300) sample(t, 0.0002);
    const get = api(0.0002);
    const d = await get(`tokens/${MINT}`);
    expect(d.price_usd).toBeCloseTo(0.05 * 0.0002, 15); // now has a reading
    expect([d.change_24h_usd, d.change_ref_usd, d.volume_24h_usd]).toEqual([null, null, null]);
    expect(d.change_24h).toBeCloseTo(0.25, 12); // the UNITS figure stays in the API; no page shows it
    const tr = (await get(`tokens/${MINT}/trades`)).trades;
    expect(tr.map((x: any) => [x.price_usd == null, x.usd_basis])).toEqual([[false, "at_time"], [true, null]]);
    const c = await get(`tokens/${MINT}/candles?tf=1h&from=${BORN - H}`);
    expect(c.usd_basis).toBe("partial");
    expect(c.start_price_usd).toBeNull();
    expect(c.change.pct).toBeNull();
    const priced = c.candles.map((x: any) => x.close_usd != null);
    // the third hour ends within 15 minutes of the first reading, so it has one (the first read after it)
    expect(priced).toEqual([false, false, true, true, true, true, true]);
    expect(c.unpriced).toBe(2);
    expect(c.candles[0]).toMatchObject({ open_usd: null, high_usd: null, low_usd: null, close_usd: null, volume_usd: null, close: 0.045 });
    // the first candle with a reading opens at its own open in dollars, not at a guess for the gap before it
    expect(c.candles[2].open_usd).toBeCloseTo(0.045 * 0.0002, 15);
    // no reading at all and the feed down: nothing in dollars anywhere
    db.exec("DELETE FROM quote_usd_samples");
    const down = api(null);
    const dd = await down(`tokens/${MINT}`);
    expect([dd.price_usd, dd.market_cap_usd, dd.change_24h_usd, dd.volume_24h_usd]).toEqual([null, null, null, null]);
    const dc = await down(`tokens/${MINT}/candles?tf=1h&from=${BORN - H}`);
    expect(dc.usd_basis).toBeNull();
    expect(dc.candles.every((x: any) => x.close_usd == null && x.open_usd == null)).toBe(true);
  });

  test("the reading of a time: nearest before within 15 minutes, else the first after within 15 minutes, else none", () => {
    const { db, sample } = setup({ born: NOW, spot: 1, start: 1 });
    sample(1000, 1);
    sample(3000, 3);
    const at = usdNear(db, 0, 10_000);
    expect([at(1000), at(1899), at(1901), at(2100), at(2099), at(3900), at(3901), at(99), at(100), at(null)]).toEqual([1, 1, null, 3, null, 3, null, null, 1, null]);
  });
});
