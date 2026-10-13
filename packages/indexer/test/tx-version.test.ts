import { describe, expect, test } from "bun:test";
import { PUMP, pumpPdas, Rpc, RpcError, type Transport } from "@units/chain";
import { marketApi } from "../src/api.ts";
import { openDb } from "../src/db.ts";
import { accountKeys } from "../src/decode.ts";
import { Indexer, refusedTxVersion, TX_VERSION_MAX } from "../src/indexer.ts";
import { A1, FX, LINE } from "./pumpfx.ts";

// The mainnet defect of 2026-10-13: getTransaction refuses a version 1 transaction when asked with
// maxSupportedTransactionVersion 0, the error was thrown on every pass and the source never moved past
// that signature (2 of 416 signatures of one curve indexed, one candle on the chart). These tests serve
// the recorded pump.fun transactions through an RPC that behaves like mainnet's: some transactions are
// version 1 and refused below it, some signatures are failed transactions, and the RPC can die mid-backfill.

const CURVE = pumpPdas.bondingCurve(A1);
const REFUSAL = (v: number) => `Transaction version (${v}) is not supported by the requesting client. Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": ${v}`;
const FAILED_SIG = "FailedSig11111111111111111111111111111111111111111111111111111111111111111111111111";

function setup(o: { versionOf?: (i: number) => number; failAfter?: number } = {}) {
  const db = openDb(":memory:");
  db.query(`INSERT INTO tokens (mint, agent, launcher, launch_account, name, symbol, decimals, created_at, dbc_config, dbc_pool, dbc_base_vault,
    dbc_quote_vault, compute_vault, supply, venue, pump_creator, start_price) VALUES (?,?,?,?,?,?,6,?,?,?,?,?,?,?,?,?,?)`)
    .run(A1, "Agent1", "L", "LA1", "Agent One", "TONE", 1791661112, PUMP.program, CURVE, "BV1", "QV1", "VAULT1", "1000000000000000", "pump", FX.creator_pdas.a1, 0.00001);
  db.query("INSERT INTO meta (k, v) VALUES ('line_decimals', '6'), ('line_mint', ?)").run(LINE);
  db.query("INSERT INTO sources (address, mint, kind) VALUES (?, ?, 'curve')").run(CURVE, A1);
  // the recorded transactions naming A1's curve, oldest first, with one failed transaction after the second
  const txs = FX.txs.filter((t) => accountKeys(t.tx).includes(CURVE)).map((t) => t.tx).sort((a, b) => a.slot - b.slot);
  const rows = txs.map((t, i) => ({ signature: t.transaction.signatures[0]!, slot: t.slot, err: null as unknown, blockTime: t.blockTime, version: o.versionOf?.(i) ?? 0 }));
  rows.splice(2, 0, { signature: FAILED_SIG, slot: rows[1]!.slot, err: { InstructionError: [2, { Custom: 6002 }] }, blockTime: rows[1]!.blockTime, version: 1 });
  const bySig = new Map(txs.map((t) => [t.transaction.signatures[0]!, t]));
  const asked: { sig: string; max: number }[] = [];
  const state = { served: 0, failAfter: o.failAfter ?? Infinity };
  const transport: Transport = async (method, params) => {
    if (method === "getSignaturesForAddress") {
      const [, opt] = params as [string, { until?: string; before?: string; limit: number }];
      let list = [...rows].reverse();
      if (opt.until) list = list.slice(0, Math.max(0, list.findIndex((s) => s.signature === opt.until)));
      if (opt.before) list = list.slice(list.findIndex((s) => s.signature === opt.before) + 1);
      return list.slice(0, opt.limit).map(({ version: _v, ...r }) => r);
    }
    if (method === "getTransaction") {
      const [sig, opt] = params as [string, { maxSupportedTransactionVersion: number }];
      asked.push({ sig, max: opt.maxSupportedTransactionVersion });
      const row = rows.find((r) => r.signature === sig)!;
      if (row.version > opt.maxSupportedTransactionVersion) throw new RpcError(`getTransaction: ${REFUSAL(row.version)}`, -32015);
      if (state.served >= state.failAfter) throw new RpcError("getTransaction: gave up after 9 attempts (network: socket closed)");
      state.served++;
      return structuredClone(bySig.get(sig) ?? null);
    }
    throw new Error(`unexpected ${method}`);
  };
  const make = () => new Indexer(db, new Rpc(transport));
  return { db, make, asked, state, rows, txs };
}
const trades = (db: ReturnType<typeof openDb>) => (db.query("SELECT COUNT(*) AS n FROM trades WHERE mint = ?").get(A1) as { n: number }).n;
const cursor = (db: ReturnType<typeof openDb>) => db.query("SELECT newest_sig, txs, last_error FROM sources WHERE address = ?").get(CURVE) as { newest_sig: string | null; txs: number; last_error: string | null };

describe("transaction versions", () => {
  test("the refusal's version is read from the RPC's own words", () => {
    expect(refusedTxVersion(`getTransaction: ${REFUSAL(1)}`)).toBe(1);
    expect(refusedTxVersion(`getTransaction: ${REFUSAL(2)}`)).toBe(2);
    expect(refusedTxVersion("getTransaction: Transaction version (999) is not supported")).toBeNull();
    expect(refusedTxVersion("getTransaction: gave up after 3 attempts (HTTP 503)")).toBeNull();
  });

  test("version 1 transactions are indexed: every trade after the first one, not only the launch", async () => {
    // mainnet's mix: the launch and its first buy are version 0, the bots' trades after them version 1
    const { db, make, asked, rows } = setup({ versionOf: (i) => (i < 2 ? 0 : 1) });
    const ix = make();
    expect(ix.txVersion).toBe(TX_VERSION_MAX);
    await ix.syncSource(CURVE);
    expect(trades(db)).toBe(5);
    expect(asked.every((a) => a.max >= 1)).toBe(true);
    expect(cursor(db)).toEqual({ newest_sig: rows[rows.length - 1]!.signature, txs: rows.length, last_error: null });
  });

  test("the defect, pinned: asking with version 0 and never raising stops at the first version 1 transaction", async () => {
    const { db, make } = setup({ versionOf: (i) => (i < 2 ? 0 : 1) });
    const ix = make();
    ix.txVersion = 0;
    // without the raise (the code before the fix) the source throws here on every pass
    ix.getTx = (sig) => ix.rpc.call("getTransaction", [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
    await expect(ix.syncSource(CURVE)).rejects.toThrow(/version \(1\) is not supported/);
    await expect(ix.syncSource(CURVE)).rejects.toThrow(/version \(1\) is not supported/);
    expect(trades(db)).toBeLessThan(5);
  });

  test("a version above the one asked for is raised to and asked again, once; later transactions use it", async () => {
    const { db, make, asked } = setup({ versionOf: (i) => (i === 3 ? 2 : 1) });
    const ix = make();
    const logs: string[] = [];
    (ix as unknown as { log: (m: string) => void }).log = (m) => logs.push(m);
    await ix.syncSource(CURVE);
    expect(ix.txVersion).toBe(2);
    expect(trades(db)).toBe(5);
    expect(logs.filter((l) => l.includes("transaction version 2")).length).toBe(1);
    // one refused request, then every later one at the raised version
    const first2 = asked.findIndex((a) => a.max === 2);
    expect(asked.slice(first2).every((a) => a.max === 2)).toBe(true);
    expect(asked.filter((a) => a.max === 1 && a.sig === asked[first2]!.sig).length).toBe(1);
  });

  test("a failed transaction is recorded from its signature row and never fetched", async () => {
    const { db, make, asked } = setup();
    await make().syncSource(CURVE);
    expect(asked.some((a) => a.sig === FAILED_SIG)).toBe(false);
    expect(db.query("SELECT failed FROM seen WHERE sig = ? AND mint = ?").get(FAILED_SIG, A1)).toEqual({ failed: 1 });
    expect(trades(db)).toBe(5);
  });
});

describe("restarts", () => {
  test("a backfill cut short resumes from its cursor in a new process: no trade lost, none fetched twice, none stored twice", async () => {
    const { db, make, asked, state, rows } = setup({ versionOf: () => 1, failAfter: 3 });
    await expect(make().syncSource(CURVE)).rejects.toThrow(/gave up/);
    const part = trades(db);
    expect(part).toBeGreaterThan(0);
    expect(part).toBeLessThan(5);
    const at = cursor(db).newest_sig;
    expect(at).not.toBeNull();
    // the process restarts (a deploy): a new Indexer on the same database, the RPC is back
    state.failAfter = Infinity;
    const ix = make();
    expect(ix.lineMint).toBe(LINE); // the quote coin is known at once, from the last run's meta
    await ix.syncSource(CURVE);
    expect(trades(db)).toBe(5);
    expect(cursor(db).newest_sig).toBe(rows[rows.length - 1]!.signature);
    // each signature was served exactly once across both runs (the one that failed was asked again, nothing else)
    const served = new Map<string, number>();
    for (const a of asked) served.set(a.sig, (served.get(a.sig) ?? 0) + 1);
    expect([...served.values()].filter((n) => n > 1).length).toBe(1);
    // a third run with a wiped cursor re-reads the signature list and changes nothing (idempotent by signature)
    db.query("UPDATE sources SET newest_sig = NULL WHERE address = ?").run(CURVE);
    const before = asked.length;
    await make().syncSource(CURVE);
    expect(asked.length).toBe(before);
    expect(trades(db)).toBe(5);
  });
});

describe("candles", () => {
  test("the first candle opens at the curve's start price, a later window at the close before it", async () => {
    const { db, make } = setup();
    await make().syncSource(CURVE);
    const api = marketApi(db, () => ({ ok: true }), { now: () => 1791670000 });
    const get = async (p: string) => (await (await api(new Request(`http://x${p}`))).json()) as { candles: { t: number; open: number; close: number; high: number; low: number; trades: number }[] };
    const all = (await get(`/market/tokens/${A1}/candles?tf=1m&from=1791600000`)).candles;
    expect(all.length).toBeGreaterThan(0);
    expect(all[0]!.open).toBe(0.00001);
    expect(all[0]!.high).toBeGreaterThanOrEqual(all[0]!.close);
    expect(all[0]!.low).toBeLessThanOrEqual(0.00001);
    for (let i = 1; i < all.length; i++) expect(all[i]!.open).toBe(all[i - 1]!.close);
    expect(all.reduce((n, c) => n + c.trades, 0)).toBe(5);
    if (all.length > 1) {
      const later = (await get(`/market/tokens/${A1}/candles?tf=1m&from=${all[1]!.t}`)).candles;
      expect(later[0]!.open).toBe(all[0]!.close);
    }
  });
});

describe("a coin younger than a day, in dollars", () => {
  test("the 24h change is measured from the start price at the dollar price of the launch; the chart's start line sits where its candles open", async () => {
    const NOW = 1_800_000_000, BORN = NOW - 12 * 3600;
    const db = openDb(":memory:");
    db.query("INSERT INTO meta (k, v) VALUES ('line_decimals', '6'), ('line_mint', ?)").run(LINE);
    db.query(`INSERT INTO tokens (mint, agent, launcher, launch_account, symbol, decimals, created_at, dbc_config, dbc_pool, dbc_base_vault, dbc_quote_vault, compute_vault, supply,
      spot_price, start_price, venue) VALUES (?, 'A', 'L', 'LA', 'YOUNG', 6, ?, 'C', 'P', 'BV', 'QV', 'V', '1000000000000000', 0.05, 0.04, 'pump')`).run(A1, BORN);
    db.query(`INSERT INTO trades (sig, idx, mint, venue, slot, time, side, base_raw, quote_raw, base, quote, price, spot_after, fee_raw, trader, source)
      VALUES ('S1', 0, ?, 'curve', 1, ?, 'buy', '0', '0', 10, 1, 0.045, 0.05, '0', 'T', 'event')`).run(A1, BORN + 1);
    const api = marketApi(db, () => ({}), { now: () => NOW, usd: () => ({ ok: true, usd: 0.0003, read_at: NOW, age_s: 0, max_age_s: 300, quote_mint: LINE, pair_mint: "S", pair: "SOL",
      pair_per_quote: 1, pair_usd: 1, sol_usd: 1, venue: "pool", account: "p", sources: { pair_per_quote: "x", pair_usd: "y" } }) });
    const get = async (p: string) => (await (await api(new Request(`http://x/market/${p}`))).json()) as any;
    // no dollar price on record for the launch: no dollar change is claimed
    expect((await get(`tokens/${A1}`)).change_24h_usd).toBeNull();
    db.query("INSERT INTO quote_usd_samples (t, usd, pair_usd, pair_per_quote, venue) VALUES (?, 0.00005, 1, 1, 'pool')").run(BORN - 120);
    const d = await get(`tokens/${A1}`);
    expect(d.change_24h).toBeCloseTo(0.05 / 0.04 - 1, 12);
    expect(d.change_24h_usd).toBeCloseTo((0.05 * 0.0003) / (0.04 * 0.00005) - 1, 9);
    const c = await get(`tokens/${A1}/candles?tf=5m&from=${BORN - 300}&fill=0`);
    expect(c.usd_basis).toBe("at_time");
    expect(c.start_price_usd).toBeCloseTo(0.04 * 0.00005, 15);
    expect(c.candles[0].open_usd).toBeCloseTo(c.start_price_usd, 15);
    expect(c.candles[0].close_usd).toBeCloseTo(0.05 * 0.00005, 15);
  });
});
