import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Rpc, RpcError, type Transport } from "@lineage/chain";
import { marketApi } from "../src/api.ts";
import { openDb } from "../src/db.ts";
import type { RawTx, TokenCtx } from "../src/decode.ts";
import { Indexer } from "../src/indexer.ts";
import { throttledTransport } from "../src/rpc.ts";

// Ingest and API over the recorded graduation-run transactions of TEST token AbBT1Mh3... (L1):
// a fake RPC serves getSignaturesForAddress pages and the recorded getTransaction answers.

const NAMES = ["curve-fill", "crank-fees", "migration", "graduate", "damm-buy", "damm-sell", "add-liquidity", "repoint", "damm-buy-2", "damm-sell-2",
  "crank-pool-fees"];
const fx = NAMES.map((n) => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", `${n}.json`), "utf8")) as { ctx: TokenCtx; tx: RawTx });
const ctx = fx[0]!.ctx;
const MINT = ctx.mint;

function setup(visible: number) {
  const db = openDb(":memory:");
  db.query(`INSERT INTO tokens (mint, agent, launcher, launch_account, name, symbol, decimals, created_at, dbc_config, dbc_pool, dbc_base_vault,
    dbc_quote_vault, damm_pool, damm_base_vault, damm_quote_vault, compute_vault, supply, graduated, spot_price, start_price, quote_reserve,
    migration_threshold, to_compute, to_protocol, fees_claimed, compute_balance)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(MINT, "EfyccrDk4Tg77PapaYf4tPMsmLLz6yAEKA57VhN62pMq", "L", "LA", "Grad", "GRAD", 6,
    1791559749, "CFG", ctx.dbcPool, ctx.dbcBaseVault, ctx.dbcQuoteVault, ctx.dammPool!, ctx.dammBaseVault!, ctx.dammQuoteVault!, "VAULT",
    "100000000000000", 1, 0.5, 0.05, "0", "15999999999792", "340117655127", "145764709341", "485882364468", "340117655127");
  db.query("INSERT INTO meta (k, v) VALUES ('line_decimals', '6')").run();
  for (const a of [ctx.dbcPool, ctx.dammPool!]) db.query("INSERT INTO sources (address, mint, kind) VALUES (?, ?, ?)").run(a, MINT, a === ctx.dbcPool ? "dbc" : "damm");
  const bySig = new Map(fx.map((f) => [f.tx.transaction.signatures[0]!, f.tx]));
  const calls: { method: string; params: unknown[] }[] = [];
  const state = { visible };
  const transport: Transport = async (method, params) => {
    calls.push({ method, params });
    if (method === "getSignaturesForAddress") {
      const [, o] = params as [string, { until?: string; before?: string; limit: number }];
      // newest first, like the RPC; both pools see every fixture (fine: decoding is per token)
      let list = fx.slice(0, state.visible).map((f) => ({ signature: f.tx.transaction.signatures[0]!, slot: f.tx.slot, err: null })).reverse();
      if (o.until) list = list.slice(0, list.findIndex((s) => s.signature === o.until));
      if (o.before) list = list.slice(list.findIndex((s) => s.signature === o.before) + 1);
      return list.slice(0, o.limit);
    }
    if (method === "getTransaction") return structuredClone(bySig.get((params as [string])[0]) ?? null);
    throw new Error(`unexpected ${method}`);
  };
  const ix = new Indexer(db, new Rpc(transport));
  ix.lineMint = ctx.lineMint;
  return { db, ix, calls, state };
}

describe("ingest", () => {
  test("backfill, then poll: resumable and idempotent by signature", async () => {
    const { db, ix, calls, state } = setup(5);
    await ix.syncSource(ctx.dbcPool);
    await ix.syncSource(ctx.dammPool!);
    const count = () => (db.query("SELECT COUNT(*) AS n FROM trades").get() as { n: number }).n;
    expect(count()).toBe(2); // curve fill + DAMM buy
    const fetched = calls.filter((c) => c.method === "getTransaction").length;
    expect(fetched).toBe(5); // the second source re-lists the same signatures but fetches none again
    state.visible = 11;
    await ix.syncSource(ctx.dbcPool);
    expect(calls.filter((c) => c.method === "getTransaction").length).toBe(11);
    expect(count()).toBe(5); // DAMM trades decoded from the DBC source's listing too (decoding is per token, both venues)
    const last = calls.filter((c) => c.method === "getSignaturesForAddress").at(-1)!.params[1] as { until?: string };
    expect(last.until).toBe(fx[4]!.tx.transaction.signatures[0]!);
    await ix.syncSource(ctx.dbcPool);
    await ix.syncSource(ctx.dammPool!);
    expect(calls.filter((c) => c.method === "getTransaction").length).toBe(11);
    expect(count()).toBe(5);
    expect((db.query("SELECT COUNT(*) AS n FROM fee_cranks").get() as { n: number }).n).toBe(2);
    expect((db.query("SELECT kind FROM events ORDER BY slot").all() as { kind: string }[]).map((r) => r.kind)).toEqual(["migration", "graduated", "repointed"]);
  });

  test("holders from indexed balances when the RPC refuses getProgramAccounts", async () => {
    const { db, ix } = setup(11);
    await ix.syncSource(ctx.dbcPool);
    const refusing = new Indexer(db, new Rpc(async (m) => {
      if (m === "getAccountInfo") return { value: { lamports: 1, owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", executable: false, data: ["", "base64"] } };
      throw new RpcError("excluded from account secondary indexes", -32010);
    }));
    expect(await refusing.refreshHolders(MINT)).toBeGreaterThan(0);
    const dep = db.query("SELECT amount FROM holders WHERE mint = ? AND owner = ?").get(MINT, "CVEZWyUBoNb6Zkte3qa7JDu5TBV4wTH6wMw4pLodnDih") as { amount: string };
    expect(dep.amount).toBe("50193807575216"); // onchain/DEVNET.md: the deployer still holds 50193807575216 agent-token base units
    expect((db.query("SELECT holders_source AS s FROM tokens").get() as { s: string }).s).toBe("transactions");
    const vaults = db.query("SELECT COUNT(*) AS n FROM holders WHERE owner IN ('FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM', 'HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC')").get() as { n: number };
    expect(vaults.n).toBe(0); // DBC and DAMM pool authorities own the vaults, which are excluded
  });

  test("API routes", async () => {
    const { db, ix } = setup(11);
    await ix.syncSource(ctx.dbcPool);
    await ix.syncSource(ctx.dammPool!);
    db.query("INSERT INTO holders (mint, owner, amount) VALUES (?, 'A', '50193807575216'), (?, 'B', '7')").run(MINT, MINT);
    db.query("UPDATE tokens SET holders = 2, holders_source = 'accounts', holders_at = 1 WHERE mint = ?").run(MINT);
    const api = marketApi(db, () => ({ ok: true }), { now: () => 1791559800 });
    const get = async (p: string) => {
      const r = await api(new Request(`http://x${p}`));
      expect(r.headers.get("access-control-allow-origin")).toBe("*");
      return { status: r.status, body: (await r.json()) as any };
    };
    const list = await get("/market/tokens");
    expect(list.body.tokens).toHaveLength(1);
    const t = list.body.tokens[0];
    expect([t.mint, t.phase, t.price, t.market_cap, t.curve_progress, t.holders, t.trades]).toEqual([MINT, "graduated", 0.5, 0.5 * 100_000_000, 1, 2, 5]);
    expect(t.volume_24h).toBeCloseTo(16_494_845.360611 + 200_000 + 2_650_232.987542 + 200_000 + 1_393_025.153136, 3);
    const d = await get(`/market/tokens/${MINT}`);
    expect([d.body.pools.damm_pool, d.body.fees.to_compute_raw, d.body.compute_vault.balance_raw, d.body.supply]).toEqual([
      ctx.dammPool, "340117655127", "340117655127", 100_000_000]);
    const tr = await get(`/market/tokens/${MINT}/trades?limit=2`);
    expect(tr.body.trades.map((x: any) => [x.venue, x.side])).toEqual([["damm", "sell"], ["damm", "buy"]]);
    const tr2 = await get(`/market/tokens/${MINT}/trades?limit=2&before=${tr.body.next}`);
    expect(tr2.body.trades.map((x: any) => [x.venue, x.side])).toEqual([["damm", "sell"], ["damm", "buy"]]);
    const tr3 = await get(`/market/tokens/${MINT}/trades?limit=2&before=${tr2.body.next}`);
    expect([tr3.body.trades.map((x: any) => [x.venue, x.side]), tr3.body.next]).toEqual([[["dbc", "buy"]], null]);
    const c = await get(`/market/tokens/${MINT}/candles?tf=1d&from=0`);
    expect(c.body.candles).toHaveLength(1);
    expect(c.body.candles[0].trades).toBe(5);
    expect((await get(`/market/tokens/${MINT}/candles?tf=7m`)).status).toBe(400);
    const h = await get(`/market/tokens/${MINT}/holders?limit=1`);
    expect([h.body.holders, h.body.top.length, h.body.top[0].owner]).toEqual([2, 1, "A"]);
    const f = await get(`/market/tokens/${MINT}/fees`);
    expect(f.body.cranks.map((x: any) => [x.source, x.to_vault_raw])).toEqual([["damm_v2", "13743310604"], ["dbc", "277113402059"]]);
    expect((await get("/market/tokens/nope")).status).toBe(404);
    expect((await get("/market/status")).body.ok).toBe(true);
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
    const { db, ix, state } = setup(3);
    const orig = (ix as any).rpc.call.bind((ix as any).rpc);
    const badSig = fx[1]!.tx.transaction.signatures[0]!;
    (ix as any).rpc.call = async (m: string, p: unknown[]) => {
      const r = await orig(m, p);
      if (m === "getTransaction" && (p as [string])[0] === badSig) r.meta.postTokenBalances = [{ accountIndex: 0, mint: MINT, uiTokenAmount: { amount: "not a number" } }];
      return r;
    };
    await ix.syncSource(ctx.dbcPool);
    const src = db.query("SELECT newest_sig FROM sources WHERE address = ?").get(ctx.dbcPool) as { newest_sig: string };
    expect(src.newest_sig).toBe(fx[2]!.tx.transaction.signatures[0]!);
    state.visible = 4;
    await ix.syncSource(ctx.dbcPool);
    expect((db.query("SELECT newest_sig FROM sources WHERE address = ?").get(ctx.dbcPool) as { newest_sig: string }).newest_sig).toBe(fx[3]!.tx.transaction.signatures[0]!);
  });
});

