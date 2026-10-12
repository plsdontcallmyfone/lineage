import { describe, expect, test } from "bun:test";
import { marketApi } from "../src/api.ts";
import { openDb } from "../src/db.ts";
import { MAX_AGE_S, QuoteUsd, SAMPLE_REACH_S, usdAt, usdLookup, type QuoteUsdReading } from "../src/usd.ts";

// US dollars (owner 2026-10-12): the price chain quote coin -> pair asset -> USD, its cache and its
// failure, and the "_usd" fields of the market API. The chain and Jupiter are stubs; the numbers in
// the assertions are multiplications of the stubbed readings, nothing else.

const WSOL = "So11111111111111111111111111111111111111112";
const QUOTE = "C5dYJH9gpLkPrmbWatMhFj2mWGx9pvyRoUenJmFhL6br";
const A = { mint: "MintA111111111111111111111111111111111111111", agent: "AgentA11111111111111111111111111111111111111" };

function feed(db = openDb(":memory:")) {
  const s = { now: 1_000_000, pairPerQuote: 0.00000002 as number | Error, pairUsd: 200 as number | Error, block: 10, quote: { mint: QUOTE, decimals: 6 } as { mint: string; decimals: number } | null,
    pairMint: WSOL, calls: 0 };
  const q = new QuoteUsd(db, {
    now: () => s.now,
    quote: () => s.quote as any,
    pair: async (mint) => {
      s.calls++;
      if (s.pairPerQuote instanceof Error) throw s.pairPerQuote;
      return { pairMint: s.pairMint as any, pairDecimals: 9, venue: "curve", account: `curve-of-${mint}` as any, pairPerQuote: s.pairPerQuote };
    },
    pairUsd: async () => {
      if (s.pairUsd instanceof Error) throw s.pairUsd;
      return { usd: s.pairUsd, block: s.block };
    },
  });
  return { db, s, q };
}

describe("quote coin USD price", () => {
  test("quote coin in SOL times SOL in USD, with its sources and the time it was read", async () => {
    const { s, q } = feed();
    expect(q.current()).toMatchObject({ ok: false, reason: "the USD price has not been read yet", read_at: null });
    const r = await q.refresh();
    expect(r).toMatchObject({ ok: true, read_at: 1_000_000, age_s: 0, max_age_s: MAX_AGE_S, quote_mint: QUOTE, pair: "SOL", pair_mint: WSOL, pair_per_quote: 0.00000002, pair_usd: 200, sol_usd: 200,
      venue: "curve", account: `curve-of-${QUOTE}`, sources: { pair_usd: "Jupiter Price API V3" } });
    expect(r.ok && r.usd).toBeCloseTo(0.000004, 15);
    s.now += 120;
    expect(q.current()).toMatchObject({ ok: true, age_s: 120, read_at: 1_000_000 });
  });

  test("feed down: the last reading is served until MAX_AGE_S, then there is no price, with the reason", async () => {
    const { s, q } = feed();
    await q.refresh();
    s.pairUsd = new Error("Jupiter answered HTTP 503");
    s.now += 60;
    expect(await q.refresh()).toMatchObject({ ok: true, age_s: 60 }); // still the reading of a minute ago, with its age
    s.now += MAX_AGE_S;
    expect(await q.refresh()).toEqual({ ok: false, reason: "Jupiter answered HTTP 503", read_at: 1_000_000, max_age_s: MAX_AGE_S });
    // the chain side failing reads the same way
    s.pairUsd = 200;
    s.pairPerQuote = new Error("the quote coin has no pump.fun bonding curve on this cluster");
    expect(await q.refresh()).toMatchObject({ ok: false, reason: "the quote coin has no pump.fun bonding curve on this cluster" });
    // and it recovers with the next good reading
    s.pairPerQuote = 0.00000003;
    const back = await q.refresh();
    expect(back.ok && back.usd).toBeCloseTo(0.000006, 15);
  });

  test("refused: an unknown quote coin, a price outside the band, a zero price, Jupiter going back in blocks", async () => {
    const { s, q } = feed();
    s.quote = null;
    expect(await q.refresh()).toMatchObject({ ok: false, reason: expect.stringMatching(/quote coin is not known yet/) });
    expect(s.calls).toBe(0);
    s.quote = { mint: QUOTE, decimals: 6 };
    s.pairUsd = 5e9;
    expect(await q.refresh()).toMatchObject({ ok: false, reason: expect.stringMatching(/outside the accepted band/) });
    s.pairUsd = 200;
    s.pairPerQuote = 0;
    expect(await q.refresh()).toMatchObject({ ok: false, reason: expect.stringMatching(/positive number/) });
    s.pairPerQuote = 0.00000002;
    expect((await q.refresh()).ok).toBe(true);
    s.block = 9;
    s.now += MAX_AGE_S + 1;
    expect(await q.refresh()).toMatchObject({ ok: false, reason: expect.stringMatching(/older block/) });
  });

  test("a coin paired with something other than SOL: the pair's own USD price, SOL/USD read beside it", async () => {
    const db = openDb(":memory:");
    const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const asked: string[] = [];
    const q = new QuoteUsd(db, { now: () => 50, quote: () => ({ mint: QUOTE as any, decimals: 6 }),
      pair: async () => ({ pairMint: USDC as any, pairDecimals: 6, venue: "pool", account: "pool" as any, pairPerQuote: 0.0005 }),
      pairUsd: async (m) => (asked.push(m), { usd: m === USDC ? 0.9998 : 180, block: 1 }) });
    const r = await q.refresh();
    expect(r).toMatchObject({ ok: true, pair: USDC, pair_usd: 0.9998, sol_usd: 180, venue: "pool" });
    expect(r.ok && r.usd).toBeCloseTo(0.0005 * 0.9998, 15);
    expect(asked).toEqual([USDC, WSOL]);
  });

  test("each reading is kept as a sample; an event is priced by the newest sample at or before it, within reach", async () => {
    const { db, s, q } = feed();
    s.now = 3000;
    await q.refresh(); // 0.000004 in the bucket starting at 3000
    s.now = 3600;
    s.pairUsd = 250;
    await q.refresh(); // 0.000005 in the bucket starting at 3600
    expect(usdAt(db, 2999)).toBeNull();
    expect(usdAt(db, 3000)).toBeCloseTo(0.000004, 15);
    expect(usdAt(db, 3599)).toBeCloseTo(0.000004, 15);
    expect(usdAt(db, 3700)).toBeCloseTo(0.000005, 15);
    expect(usdAt(db, 3600 + SAMPLE_REACH_S + 1)).toBeNull();
    expect(usdAt(db, null)).toBeNull();
    const at = usdLookup(db, 0, 10_000);
    expect([at(2999), at(null)]).toEqual([null, null]);
    expect(at(3100)).toBeCloseTo(0.000004, 15);
    expect(at(4000)).toBeCloseTo(0.000005, 15);
    expect(at(3600 + SAMPLE_REACH_S + 1)).toBeNull();
  });
});

describe("market API in US dollars", () => {
  const NOW = 200_000;
  function setup() {
    const db = openDb(":memory:");
    db.query("INSERT INTO meta (k, v) VALUES ('line_decimals', '6'), ('line_mint', ?)").run(QUOTE);
    db.query(`INSERT INTO tokens (mint, agent, launcher, launch_account, name, symbol, decimals, repo_url, created_at, dbc_config, dbc_pool, dbc_base_vault, dbc_quote_vault,
      compute_vault, supply, spot_price, start_price, graduated, awake, to_compute, fees_claimed, to_protocol, compute_balance, quote_reserve, venue)
      VALUES (?,?,?,?,?,?,6,?,?,'CFG','P','BV','QV','V','1000000000000000',?,?,0,1,'5000000','8000000','3000000','2000000','40000000','pump')`)
      .run(A.mint, A.agent, "L", "LA", "Alpha agent", "ALPHA", null, 100, 0.5, 0.25);
    const tr = db.prepare(`INSERT INTO trades (sig, idx, mint, venue, slot, time, side, base_raw, quote_raw, base, quote, price, spot_after, fee_raw, trader, source)
      VALUES (?, 0, ?, 'curve', ?, ?, ?, '0', '0', ?, ?, ?, ?, '0', 'T', 'event')`);
    // one trade two days ago (the 24h reference), one 20 h ago with a stored price, one 1 h ago without
    tr.run("S1".padEnd(64, "1"), A.mint, 1, NOW - 2 * 86400, "buy", 400, 100, 0.25, 0.4);
    tr.run("S2".padEnd(64, "1"), A.mint, 2, NOW - 20 * 3600, "buy", 200, 90, 0.45, 0.45);
    tr.run("S3".padEnd(64, "1"), A.mint, 3, NOW - 3600, "sell", 100, 50, 0.5, 0.5);
    db.query(`INSERT INTO fee_cranks (sig, idx, mint, slot, time, fees_raw, to_compute_raw, to_protocol_raw, pool_fees, balance_raw, awake) VALUES (?, 0, ?, 5, ?, '1000000', '700000', '300000', 0, '2000000', 1)`)
      .run("F1".padEnd(64, "1"), A.mint, NOW - 20 * 3600);
    return db;
  }
  const sample = (db: ReturnType<typeof openDb>, t: number, usd: number) =>
    db.query("INSERT INTO quote_usd_samples (t, usd, pair_usd, pair_per_quote, venue) VALUES (?, ?, 1, ?, 'curve')").run(t, usd, usd);
  const reading = (usd: number): QuoteUsdReading => ({ ok: true, usd, read_at: NOW - 10, age_s: 10, max_age_s: MAX_AGE_S, quote_mint: QUOTE, pair_mint: WSOL, pair: "SOL", pair_per_quote: usd / 200,
    pair_usd: 200, sol_usd: 200, venue: "curve", account: "curve", sources: { pair_per_quote: "x", pair_usd: "Jupiter Price API V3" } });
  const get = async (api: ReturnType<typeof marketApi>, path: string) => (await (await api(new Request(`http://x/market/${path}`))).json()) as any;

  test("rows carry price, market cap, volume and change in dollars: the quote figure times the reading", async () => {
    const db = setup();
    const api = marketApi(db, () => ({}), { now: () => NOW, usd: () => reading(0.002) });
    sample(db, NOW - 20 * 3600 - 60, 0.001); // the stored price at the 20 h trade and the crank
    sample(db, NOW - 86400 - 600, 0.0016); // and the one 24 h ago
    const r = await get(api, "tokens");
    expect(r.usd).toMatchObject({ ok: true, usd: 0.002, read_at: NOW - 10 });
    const t = r.tokens[0];
    expect(t).toMatchObject({ price: 0.5, market_cap: 500_000_000, volume_24h: 140, quote_usd: 0.002, fees_to_compute: 5 });
    expect(t.price_usd).toBeCloseTo(0.001, 12);
    expect(t.market_cap_usd).toBeCloseTo(1_000_000, 6);
    // 24h volume: the 20 h trade at its own stored price (90 x 0.001), the 1 h trade at the current one (50 x 0.002)
    expect(t.volume_24h_usd).toBeCloseTo(0.09 + 0.1, 12);
    // change: 0.5 x 0.002 now against 0.4 x 0.0016 a day ago
    expect(t.change_24h).toBeCloseTo(0.25, 12);
    expect(t.change_24h_usd).toBeCloseTo((0.5 * 0.002) / (0.4 * 0.0016) - 1, 12);
    expect(t.fees_to_compute_usd).toBeCloseTo(0.01, 12);
    expect(t.quote_reserve_usd).toBeCloseTo(0.08, 12);

    const d = await get(api, `tokens/${A.mint}`);
    expect(d.usd.ok).toBe(true);
    expect(d.start_price_usd).toBeCloseTo(0.0005, 12);
    expect(d.fees).toMatchObject({ claimed: 8, to_treasury: 3 });
    expect(d.fees.claimed_usd).toBeCloseTo(0.016, 12);
    expect(d.compute_vault.balance_usd).toBeCloseTo(0.004, 12);

    const s = await get(api, "summary");
    expect(s.volume_24h).toBe(140);
    expect(s.volume_24h_usd).toBeCloseTo(0.19, 12);
    expect(s.market_cap_usd).toBeCloseTo(1_000_000, 6);
    expect(await get(api, "quote-usd")).toMatchObject({ quote: "UNITS", ok: true, usd: 0.002, sources: { pair_usd: "Jupiter Price API V3" } });
  });

  test("history: a trade, candle or crank uses the price stored for its own time, else today's, and says which", async () => {
    const db = setup();
    const api = marketApi(db, () => ({}), { now: () => NOW, usd: () => reading(0.002) });
    sample(db, NOW - 20 * 3600 - 60, 0.001);
    const tr = (await get(api, `tokens/${A.mint}/trades`)).trades;
    expect(tr.map((x: any) => x.usd_basis)).toEqual(["current", "at_time", "current"]);
    expect(tr[1].quote_amount_usd).toBeCloseTo(0.09, 12);
    expect(tr[1].price_usd).toBeCloseTo(0.00045, 12);
    expect(tr[0].quote_amount_usd).toBeCloseTo(0.1, 12);
    expect(tr[0].price_after_usd).toBeCloseTo(0.001, 12);
    const c = await get(api, `tokens/${A.mint}/candles?tf=1h&from=0`);
    expect(c.usd_basis).toBe("mixed");
    expect(c.candles).toHaveLength(3);
    expect(c.candles[1]).toMatchObject({ close: 0.45, volume: 90 });
    expect(c.candles[1].close_usd).toBeCloseTo(0.00045, 12);
    expect(c.candles[1].volume_usd).toBeCloseTo(0.09, 12);
    // a candle opens at the close before it, in dollars too
    expect(c.candles[1].open_usd).toBeCloseTo(c.candles[0].close_usd, 12);
    expect(c.candles[2].high_usd).toBeCloseTo(0.001, 12);
    expect(c.start_price_usd).toBeCloseTo(0.0005, 12);
    const f = await get(api, `tokens/${A.mint}/fees`);
    expect(f.cranks[0]).toMatchObject({ amount: 1, usd_basis: "at_time" });
    expect(f.cranks[0].to_treasury_usd).toBeCloseTo(0.0003, 12);
    expect(f.totals_onchain.claimed_usd).toBeCloseTo(0.016, 12);
    const fl = await get(api, "flows");
    expect(fl.usd).toMatchObject({ ok: true, usd: 0.002, sol_usd: 200 });
    expect(fl.cranks[0].quote_usd).toBeCloseTo(0.001, 12);
    // every candle with a stored price: at_time; none stored: current
    for (const t of [NOW - 2 * 86400, NOW - 3600]) sample(db, t - 30, 0.0015);
    expect((await get(api, `tokens/${A.mint}/candles?tf=1h&from=0`)).usd_basis).toBe("at_time");
    db.exec("DELETE FROM quote_usd_samples");
    expect((await get(api, `tokens/${A.mint}/candles?tf=1h&from=0`)).usd_basis).toBe("current");
    expect((await get(api, "flows")).cranks[0].quote_usd).toBeNull();
  });

  test("feed down: every dollar field is null and the answer says why; the quote-coin figures are untouched", async () => {
    const db = setup();
    const down: QuoteUsdReading = { ok: false, reason: "Jupiter answered HTTP 503", read_at: NOW - 900, max_age_s: MAX_AGE_S };
    for (const api of [marketApi(db, () => ({}), { now: () => NOW, usd: () => down }), marketApi(db, () => ({}), { now: () => NOW })]) {
      const r = await get(api, "tokens");
      expect(r.usd.ok).toBe(false);
      const t = r.tokens[0];
      expect(t).toMatchObject({ price: 0.5, market_cap: 500_000_000, volume_24h: 140, quote_usd: null, price_usd: null, market_cap_usd: null, volume_24h_usd: null, change_24h_usd: null,
        fees_to_compute_usd: null, quote_reserve_usd: null });
      const d = await get(api, `tokens/${A.mint}`);
      expect([d.start_price_usd, d.fees.claimed_usd, d.compute_vault.balance_usd]).toEqual([null, null, null]);
      const c = await get(api, `tokens/${A.mint}/candles?tf=1h&from=0`);
      expect(c.usd_basis).toBeNull();
      expect(c.candles.map((x: any) => [x.open_usd, x.high_usd, x.low_usd, x.close_usd, x.volume_usd])).toEqual([[null, null, null, null, null], [null, null, null, null, null], [null, null, null, null, null]]);
      expect(c.candles[2]).toMatchObject({ close: 0.5, volume: 50 });
      const tr = (await get(api, `tokens/${A.mint}/trades`)).trades;
      expect(tr.map((x: any) => [x.quote_amount_usd, x.price_usd, x.usd_basis])).toEqual([[null, null, null], [null, null, null], [null, null, null]]);
      const s = await get(api, "summary");
      expect([s.volume_24h, s.volume_24h_usd, s.market_cap_usd, s.fees_to_compute_usd]).toEqual([140, null, null, null]);
    }
    expect(await get(marketApi(db, () => ({}), { usd: () => down }), "quote-usd")).toEqual({ quote: "UNITS", ...down });
    expect(await get(marketApi(db, () => ({})), "quote-usd")).toMatchObject({ ok: false, reason: "no USD price reader on this instance" });
    // a stored price still converts the history it covers while the current one is missing
    sample(db, NOW - 20 * 3600 - 60, 0.001);
    const api = marketApi(db, () => ({}), { now: () => NOW, usd: () => down });
    const tr = (await get(api, `tokens/${A.mint}/trades`)).trades;
    expect(tr[1]).toMatchObject({ usd_basis: "at_time" });
    expect(tr[1].quote_amount_usd).toBeCloseTo(0.09, 12);
    expect((await get(api, "tokens")).tokens[0].volume_24h_usd).toBeNull(); // one of its trades has no price at all
  });

  test("a token with no trades has a zero dollar volume, not a missing one", async () => {
    const db = setup();
    db.exec("DELETE FROM trades");
    const t = (await get(marketApi(db, () => ({}), { now: () => NOW, usd: () => reading(0.002) }), "tokens")).tokens[0];
    expect([t.volume_24h, t.volume_24h_usd]).toEqual([0, 0]);
  });
});
