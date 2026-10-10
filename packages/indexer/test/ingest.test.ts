import { describe, expect, test } from "bun:test";
import { accountDisc, addressBytes, PUMP, pumpPdas, Rpc, RpcError, toAddress, type Transport } from "@lineage/chain";
import { pumpAlerts } from "../src/alerts.ts";
import { marketApi } from "../src/api.ts";
import { openDb } from "../src/db.ts";
import { accountKeys } from "../src/decode.ts";
import { Indexer } from "../src/indexer.ts";
import { throttledTransport } from "../src/rpc.ts";
import { A1, A2, b64, feesCranked, FX, LINE, withLog } from "./pumpfx.ts";

// Ingest and API over the pump.fun proof's transactions recorded on the mainnet fork: a fake RPC
// serves getSignaturesForAddress (every recorded transaction naming the address) and the recorded
// getTransaction answers, and the recorded accounts for the state refresh.

const AGENT1 = "Agent1111111111111111111111111111111111111";
const AGENT2 = "Agent2222222222222222222222222222222222222";
const METEORA_MINT = "MeteoraMint11111111111111111111111111111111";
const POOL2 = pumpPdas.pool(A2, LINE);

const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
/** An AgentLaunch account (onchain/programs/lineage-launch/src/lib.rs) of a pump.fun launch. */
function agentLaunch(agent: string, mint: string, creator: string, graduated: boolean, l: { fees: bigint; toCompute: bigint }) {
  const url = new TextEncoder().encode("https://github.com/lineage-test/base58");
  const k = (a: string) => addressBytes(a);
  return cat(accountDisc("AgentLaunch"), k(agent), k(mint), k(LINE), new Uint8Array(32), u64(BigInt(url.length)).subarray(0, 4), url, Uint8Array.of(2, 1),
    k(PUMP.program), k(pumpPdas.bondingCurve(mint)), graduated ? k(POOL2) : new Uint8Array(32), k(creator), new Uint8Array(32), Uint8Array.of(graduated ? 1 : 0, 1),
    u64(1_791_661_100n), u64(l.fees), u64(l.toCompute), u64(l.fees - l.toCompute), u64(0n), u64(0n), Uint8Array.of(255, 254));
}
const mintAcct = (supply: bigint) => { const d = new Uint8Array(82); d.set(u64(supply), 36); d[44] = 6; d[45] = 1; return d; };
const tokenAcct = (mint: string, owner: string, amount: bigint) => cat(addressBytes(mint), addressBytes(owner), u64(amount), new Uint8Array(165 - 72));

function setup(o: { creatorOverride?: string } = {}) {
  const db = openDb(":memory:");
  const ins = db.prepare(`INSERT INTO tokens (mint, agent, launcher, launch_account, name, symbol, decimals, created_at, dbc_config, dbc_pool, dbc_base_vault,
    dbc_quote_vault, compute_vault, supply, venue, pump_creator) VALUES (?,?,?,?,?,?,6,?,?,?,?,?,?,?,?,?)`);
  ins.run(A1, AGENT1, "L", "LA1", "Agent One", "TONE", 1791661112, PUMP.program, pumpPdas.bondingCurve(A1), "BV1", "QV1", "VAULT1", "1000000000000000", "pump",
    FX.creator_pdas.a1);
  ins.run(A2, AGENT2, "L", "LA2", "Agent Two", "TTWO", 1791661127, PUMP.program, pumpPdas.bondingCurve(A2), "BV2", "QV2", "VAULT2", "1000000000000000", "pump",
    FX.creator_pdas.a2);
  // a launch from the Meteora venue (devnet history): listed read-only, never ingested
  db.query(`INSERT INTO tokens (mint, agent, launcher, launch_account, name, symbol, decimals, created_at, dbc_config, dbc_pool, dbc_base_vault, dbc_quote_vault,
    compute_vault, spot_price) VALUES (?,?,?,?,?,?,6,1,'CFG','DBCPOOL','BV','QV','VAULTM',0.25)`).run(METEORA_MINT, "AgentM", "L", "LAM", "Old", "OLD");
  db.query("INSERT INTO meta (k, v) VALUES ('line_decimals', '6')").run();
  for (const [a, m, k] of [[pumpPdas.bondingCurve(A1), A1, "curve"], [pumpPdas.bondingCurve(A2), A2, "curve"], [POOL2, A2, "pool"], ["DBCPOOL", METEORA_MINT, "dbc"]] as [string, string, string][])
    db.query("INSERT INTO sources (address, mint, kind) VALUES (?, ?, ?)").run(a, m, k);
  const bySig = new Map(FX.txs.map((t) => [t.tx.transaction.signatures[0]!, t.tx]));
  const calls: { method: string; params: unknown[] }[] = [];
  const curve2 = b64(FX.accounts.a2_curve!);
  if (o.creatorOverride) curve2.set(addressBytes(o.creatorOverride), 49);
  const accounts: Record<string, Uint8Array | null> = {
    LA1: agentLaunch(AGENT1, A1, FX.creator_pdas.a1, false, { fees: 0n, toCompute: 0n }),
    LA2: agentLaunch(AGENT2, A2, FX.creator_pdas.a2, true, { fees: 100n, toCompute: 70n }),
    LAM: agentLaunch("AgentM111111111111111111111111111111111111", METEORA_MINT, "AgentM111111111111111111111111111111111111", false, { fees: 5n, toCompute: 3n }),
    [A1]: mintAcct(1_000_000_000_000_000n), [A2]: mintAcct(1_000_000_000_000_000n), [METEORA_MINT]: mintAcct(100n),
    VAULT1: tokenAcct(LINE, "x", 1n), VAULT2: tokenAcct(LINE, "x", 2n), VAULTM: tokenAcct(LINE, "x", 3n),
    [pumpPdas.bondingCurve(A1)]: b64(FX.accounts.a1_curve!), [pumpPdas.bondingCurve(A2)]: curve2, [POOL2]: b64(FX.accounts.a2_pool!),
    [pumpPdas.pool(A1, LINE)]: null,
    [PUMP.global]: b64(FX.accounts.global!), [PUMP.feeConfig]: b64(FX.accounts.fee_config!), [PUMP.ammFeeConfig]: b64(FX.accounts.amm_fee_config!),
  };
  // pool vaults: fixed test balances (the price check reads them back through the pool's virtual quote reserves)
  const pool = b64(FX.accounts.a2_pool!);
  accounts[toAddress(pool.subarray(139, 171))] = tokenAcct(A2, POOL2, 200_000_000_000_000n);
  accounts[toAddress(pool.subarray(171, 203))] = tokenAcct(LINE, POOL2, 80_000_000_000_000n);
  const owners: Record<string, string> = { [pumpPdas.bondingCurve(A1)]: PUMP.program, [pumpPdas.bondingCurve(A2)]: PUMP.program, [POOL2]: PUMP.amm,
    [PUMP.global]: PUMP.program, [PUMP.feeConfig]: PUMP.fees, [PUMP.ammFeeConfig]: PUMP.fees };
  const raw = (a: string) => (accounts[a] ? { lamports: 1, owner: owners[a] ?? "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", executable: false,
    data: [Buffer.from(accounts[a]!).toString("base64"), "base64"] } : null);
  const state = { visible: FX.txs.length };
  const transport: Transport = async (method, params) => {
    calls.push({ method, params });
    if (method === "getSignaturesForAddress") {
      const [addr, opt] = params as [string, { until?: string; before?: string; limit: number }];
      let list = FX.txs.slice(0, state.visible).filter((t) => accountKeys(t.tx).includes(addr))
        .map((t) => ({ signature: t.tx.transaction.signatures[0]!, slot: t.tx.slot, err: null })).sort((a, b) => b.slot - a.slot);
      if (opt.until) list = list.slice(0, Math.max(0, list.findIndex((s) => s.signature === opt.until)));
      if (opt.before) list = list.slice(list.findIndex((s) => s.signature === opt.before) + 1);
      return list.slice(0, opt.limit);
    }
    if (method === "getTransaction") {
      const sig = (params as [string])[0];
      return structuredClone(bySig.get(sig) ?? null);
    }
    if (method === "getMultipleAccounts") return { value: (params[0] as string[]).map(raw) };
    if (method === "getAccountInfo") return { value: raw(params[0] as string) };
    throw new Error(`unexpected ${method}`);
  };
  const ix = new Indexer(db, new Rpc(transport));
  ix.lineMint = LINE;
  return { db, ix, calls, state };
}
const count = (db: ReturnType<typeof openDb>, mint?: string) =>
  (db.query(`SELECT COUNT(*) AS n FROM trades${mint ? " WHERE mint = ?" : ""}`).get(...(mint ? [mint] : [])) as { n: number }).n;

describe("ingest", () => {
  test("backfill, then poll: resumable and idempotent by signature; Meteora-era sources are never synced", async () => {
    const { db, ix, calls, state } = setup();
    state.visible = 6; // through A1's sweep
    await ix.syncSource(pumpPdas.bondingCurve(A1));
    expect(count(db, A1)).toBe(5); // initial buy, buy, exact-in buy, sell, multi-hop leg
    const fetched = calls.filter((c) => c.method === "getTransaction").length;
    state.visible = FX.txs.length;
    await ix.syncSource(pumpPdas.bondingCurve(A1));
    expect(calls.filter((c) => c.method === "getTransaction").length).toBe(fetched); // nothing new names A1's curve
    await ix.syncSource(pumpPdas.bondingCurve(A2));
    await ix.syncSource(POOL2);
    expect(count(db, A2)).toBe(5); // multi-hop curve leg, completing buy, pool buy, pool sell, multi-hop pool leg
    const before = calls.filter((c) => c.method === "getTransaction").length;
    await ix.syncSource(pumpPdas.bondingCurve(A2));
    await ix.syncSource(POOL2);
    expect(calls.filter((c) => c.method === "getTransaction").length).toBe(before);
    expect(count(db, A2)).toBe(5);
    expect(await ix.syncSource("DBCPOOL")).toBe(0);
    expect(count(db, METEORA_MINT)).toBe(0);
    expect((db.query("SELECT kind FROM events WHERE mint = ? ORDER BY slot").all(A2) as { kind: string }[]).map((r) => r.kind)).toEqual(["complete", "migration"]);
    const sweeps = db.query("SELECT venue, amount_raw FROM sweeps WHERE mint = ? ORDER BY idx").all(A2) as { venue: string; amount_raw: string }[];
    expect(sweeps.map((s) => s.venue)).toEqual(["curve", "pool"]);
  });

  test("recount: the indexer's creator fee income and trade amounts equal the chain's", async () => {
    const { db, ix } = setup();
    for (const a of [pumpPdas.bondingCurve(A1), pumpPdas.bondingCurve(A2), POOL2]) await ix.syncSource(a);
    await ix.refreshState();
    const api = marketApi(db, () => ({ ok: true }), { now: () => 1791661200 });
    const get = async (p: string) => (await (await api(new Request(`http://x${p}`))).json()) as any;
    for (const [mint, want] of [[A1, FX.pda_line_after_sweeps.a1], [A2, FX.pda_line_after_sweeps.a2]] as const) {
      const d = await get(`/market/tokens/${mint}`);
      expect(d.fees.creator_fee_income_raw).toBe(want); // equals the creator PDA's $LINE after pump.fun's sweeps and collects
      expect(d.fees.swept_raw).toBe(want);
    }
    // base amounts: the sum over trades equals the base tokens traders received minus what they sold
    const net = (db.query("SELECT side, base_raw FROM trades WHERE mint = ?").all(A1) as { side: string; base_raw: string }[])
      .reduce((n, t) => n + (t.side === "buy" ? BigInt(t.base_raw) : -BigInt(t.base_raw)), 0n);
    const curve1 = b64(FX.accounts.a1_curve!);
    const realLeft = new DataView(curve1.buffer, curve1.byteOffset).getBigUint64(24, true);
    expect(net).toBe(793_100_000_000_000n - realLeft); // Global's initial real token reserves minus what the curve still holds
  });

  test("state refresh: graduation from the pool, the price from the pool's vaults and signed virtual quote reserves, the curve price before", async () => {
    const { db, ix } = setup();
    await ix.refreshState();
    const t2 = db.query("SELECT graduated, migrated, spot_price, damm_pool, progress, venue, pump_creator FROM tokens WHERE mint = ?").get(A2) as any;
    expect([t2.graduated, t2.migrated, t2.damm_pool, t2.progress, t2.venue]).toEqual([1, 1, POOL2, 1, "pump"]);
    const pool = b64(FX.accounts.a2_pool!);
    const dv = new DataView(pool.buffer, pool.byteOffset);
    const vqr = BigInt.asIntN(128, dv.getBigUint64(245, true) | (dv.getBigUint64(253, true) << 64n));
    expect(t2.spot_price).toBeCloseTo(Number(80_000_000_000_000n + vqr) / 200_000_000_000_000, 12);
    const t1 = db.query("SELECT graduated, spot_price, progress FROM tokens WHERE mint = ?").get(A1) as any;
    const c = b64(FX.accounts.a1_curve!);
    const cv = new DataView(c.buffer, c.byteOffset);
    expect(t1.graduated).toBe(0);
    expect(t1.spot_price).toBeCloseTo(Number(cv.getBigUint64(16, true)) / Number(cv.getBigUint64(8, true)), 15);
    expect(t1.progress).toBeCloseTo(Number(793_100_000_000_000n - cv.getBigUint64(24, true)) / 793_100_000_000_000, 12);
    // the Meteora-era row keeps its stored price; its compute-side fields still refresh
    const m = db.query("SELECT spot_price, to_compute FROM tokens WHERE mint = ?").get(METEORA_MINT) as any;
    expect([m.spot_price, m.to_compute]).toEqual([0.25, "3"]);
  });

  test("API routes: venue and read_only, trades by venue, candles, fees with sweeps, alerts", async () => {
    const { db, ix } = setup();
    for (const a of [pumpPdas.bondingCurve(A1), pumpPdas.bondingCurve(A2), POOL2]) await ix.syncSource(a);
    await ix.refreshState();
    // a crank of A2 by lineage_launch (the proof ran before our program change, so the log is added here)
    const last = FX.txs.find((t) => t.step === "9d")!;
    const crank = withLog(last.tx, feesCranked(AGENT2, A2, 295_621_266_363n, 206_934_886_454n, true, 206_934_886_454n));
    crank.transaction.signatures = ["CrankSig1111111111111111111111111111111111111111111111111111111111111111111111111111"];
    crank.slot += 1;
    crank.meta!.innerInstructions = []; // the crank's own pump.fun sweeps are already in 9d
    crank.meta!.postTokenBalances = [];
    db.query("INSERT INTO sources (address, mint, kind) VALUES ('LA2', ?, 'launch')").run(A2);
    await setupExtra(ix, crank);
    const api = marketApi(db, () => ({ ok: true }), { now: () => 1791661200 });
    const get = async (p: string) => {
      const r = await api(new Request(`http://x${p}`));
      return { status: r.status, body: (await r.json()) as any };
    };
    const list = await get("/market/tokens");
    const by = Object.fromEntries(list.body.tokens.map((t: any) => [t.mint, t]));
    expect([by[A1].venue, by[A1].read_only, by[A2].phase, by[METEORA_MINT].venue, by[METEORA_MINT].read_only]).toEqual(["pump", false, "graduated", "meteora", true]);
    expect([by[A1].trades, by[A2].trades, by[METEORA_MINT].trades]).toEqual([5, 5, 0]);
    const d = await get(`/market/tokens/${A2}`);
    expect([d.body.pools.venue, d.body.pools.bonding_curve, d.body.pools.pump_pool, d.body.pools.pump_creator]).toEqual(["pump", pumpPdas.bondingCurve(A2), POOL2,
      FX.creator_pdas.a2]);
    const tr = await get(`/market/tokens/${A2}/trades?limit=10`);
    expect(tr.body.trades.map((x: any) => `${x.venue}:${x.side}`)).toEqual(["pool:buy", "pool:sell", "pool:buy", "curve:buy", "curve:buy"]);
    expect(tr.body.trades.every((x: any) => typeof x.creator_fee_raw === "string")).toBe(true);
    const c = await get(`/market/tokens/${A2}/candles?tf=1d&from=0`);
    expect(c.body.candles[0].trades).toBe(5);
    const f = await get(`/market/tokens/${A2}/fees`);
    expect([f.body.cranks.length, f.body.cranks[0].source, f.body.cranks[0].to_vault_raw]).toEqual([1, "pump_curve_and_pool", "206934886454"]);
    expect(f.body.sweeps.map((s: any) => s.venue)).toEqual(["pool", "curve"]); // newest first
    expect(f.body.creator_fee_income_raw).toBe(FX.pda_line_after_sweeps.a2);
    const al = await get("/market/alerts");
    expect([al.body.alerts, al.body.baseline.maxCurveDepth]).toEqual([[], 1]);
    expect((await get("/market/summary")).body.alerts).toBe(0);
    expect((await get("/market/tokens/nope")).status).toBe(404);
  });

  test("alerts: a creator reassigned by pump.fun shows on /market/alerts", async () => {
    const { db, ix } = setup({ creatorOverride: pumpPdas.creatorVault(A1) });
    await ix.refreshState();
    const api = marketApi(db, () => ({ ok: true }), { now: () => 1 });
    const al = (await (await api(new Request("http://x/market/alerts"))).json()) as any;
    expect(al.alerts.map((a: any) => [a.kind, a.subject])).toEqual([["curve_creator", A2]]);
  });

  test("holders from indexed balances when the RPC refuses getProgramAccounts; pump.fun vaults excluded", async () => {
    const { db, ix } = setup();
    await ix.syncSource(pumpPdas.bondingCurve(A1));
    db.query("UPDATE tokens SET dbc_base_vault = ? WHERE mint = ?").run(
      (db.query("SELECT account FROM token_accounts WHERE mint = ? AND owner = ?").get(A1, pumpPdas.bondingCurve(A1)) as { account: string }).account, A1);
    const refusing = new Indexer(db, new Rpc(async (m) => {
      if (m === "getAccountInfo") return { value: { lamports: 1, owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", executable: false, data: ["", "base64"] } };
      throw new RpcError("excluded from account secondary indexes", -32010);
    }));
    expect(await refusing.refreshHolders(A1)).toBeGreaterThan(0);
    expect((db.query("SELECT holders_source AS s FROM tokens WHERE mint = ?").get(A1) as { s: string }).s).toBe("transactions");
    expect((db.query("SELECT COUNT(*) AS n FROM holders WHERE mint = ? AND owner = ?").get(A1, pumpPdas.bondingCurve(A1)) as { n: number }).n).toBe(0);
  });
});

/** Ingests one extra transaction through the launch source (the crank log added to a recorded transaction). */
async function setupExtra(ix: Indexer, extra: (typeof FX.txs)[number]["tx"]) {
  const rpc = (ix as any).rpc as Rpc;
  const orig = rpc.transport;
  (rpc as any).transport = async (m: string, p: unknown[]) => {
    if (m === "getSignaturesForAddress" && (p as [string])[0] === "LA2") return [{ signature: extra.transaction.signatures[0], slot: extra.slot, err: null }];
    if (m === "getTransaction" && (p as [string])[0] === extra.transaction.signatures[0]) return structuredClone(extra);
    return orig(m, p);
  };
  await ix.syncSource("LA2");
  (rpc as any).transport = orig;
}

describe("pump.fun alerts (pure)", () => {
  const base = { maxCurveDepth: 1, feeConfigSha: "a", ammFeeConfigSha: "b", recordedAt: 0 };
  test("creator changes, max_curve_depth 0 and fee config changes are flagged; nothing when all is as recorded", () => {
    const ok = { tokens: [{ mint: "M", expectedCreator: "P", curveCreator: "P", poolCoinCreator: "P" }], maxCurveDepth: 1, feeConfigSha: "a", ammFeeConfigSha: "b" };
    expect(pumpAlerts(ok, base)).toEqual([]);
    const bad = { tokens: [{ mint: "M", expectedCreator: "P", curveCreator: "X", poolCoinCreator: "Y" }], maxCurveDepth: 0, feeConfigSha: "c", ammFeeConfigSha: "d" };
    expect(pumpAlerts(bad, base).map((a) => a.kind)).toEqual(["curve_creator", "pool_creator", "max_curve_depth", "fee_config", "amm_fee_config"]);
    expect(pumpAlerts({ ...ok, maxCurveDepth: 2 }, base).map((a) => a.detail)).toEqual(["max_curve_depth changed from 1 to 2"]);
  });
});

describe("rpc transport", () => {
  test("backs off on 429 (honouring Retry-After) and counts it", async () => {
    let n = 0;
    const slept: number[] = [];
    const fake = (async () => {
      n++;
      if (n <= 2) return new Response("busy", { status: 429, headers: n === 1 ? { "retry-after": "2" } : {} });
      return Response.json({ jsonrpc: "2.0", id: 1, result: 42 });
    }) as unknown as typeof fetch;
    const { transport, stats } = throttledTransport("http://rpc.invalid", { fetch: fake, minGapMs: 0, sleep: async (ms) => { slept.push(ms); } });
    expect(await transport("getSlot", [])).toBe(42);
    expect([stats.http429, slept]).toEqual([2, [2000, 1000]]);
  });
  test("gives up after maxWaitMs", async () => {
    const fake = (async () => new Response("busy", { status: 429 })) as unknown as typeof fetch;
    const { transport } = throttledTransport("http://rpc.invalid", { fetch: fake, minGapMs: 0, maxWaitMs: 3000, sleep: async () => {} });
    await expect(transport("getSlot", [])).rejects.toThrow(/gave up/);
  });
});

// Audit A2 OFF-I3: one transaction the decoder cannot read (a lying RPC, a malformed balance) is
// recorded as an error and skipped; it must not make the source retry it forever.
describe("audit: a malformed transaction does not wedge its source", () => {
  test("the bad signature is skipped, later ones are ingested, and the next poll moves on", async () => {
    const { db, ix } = setup();
    const curve = pumpPdas.bondingCurve(A1);
    const sigs = FX.txs.filter((t) => accountKeys(t.tx).includes(curve)).map((t) => t.tx.transaction.signatures[0]!);
    const badSig = sigs[1]!;
    const orig = (ix as any).rpc.call.bind((ix as any).rpc);
    (ix as any).rpc.call = async (m: string, p: unknown[]) => {
      const r = await orig(m, p);
      if (m === "getTransaction" && (p as [string])[0] === badSig) r.meta.postTokenBalances = [{ accountIndex: 0, mint: A1, owner: A1, uiTokenAmount: { amount: "not a number" } }];
      return r;
    };
    await ix.syncSource(curve);
    expect((db.query("SELECT newest_sig FROM sources WHERE address = ?").get(curve) as { newest_sig: string }).newest_sig).toBe(sigs.at(-1)!);
    expect(count(db, A1)).toBe(sigs.length - 2); // the sweep transaction names the curve but trades nothing, the bad one is skipped
    expect((db.query("SELECT last_error FROM sources WHERE address = ?").get(curve) as { last_error: string }).last_error).toMatch(/^skipped /);
  });
});
