import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountDisc, addressBytes, LAUNCH_PROGRAM_ID, launchPdas, PUMP, pumpPdas, Rpc, RpcError, toAddress, TOKEN_2022_PROGRAM, type Transport } from "@units/chain";
import { purgeDigest as coreDigest } from "../../core/src/purge.ts";
import { marketApi } from "../src/api.ts";
import { syncCore } from "../src/core-sync.ts";
import { openDb, storeDecoded } from "../src/db.ts";
import { accountKeys, decodeTx, type RawTx } from "../src/decode.ts";
import { Indexer } from "../src/indexer.ts";
import { isPurgedMint, purgeDigest } from "../src/purged.ts";
import { A1, A2, b64, ctxOf, feesCranked, FX, LINE, pumpLaunched, tx, withLog } from "./pumpfx.ts";

// A launch Core purged (packages/core/src/purge.ts) leaves the market indexer for good: Core lists
// sha256 digests only (GET /v1/purged), the indexer hashes what it holds, deletes every row of a
// match and never imports the launch again, although its AgentLaunch account still exists on chain.
// The chain is a fake RPC over the pump.fun proof's recorded transactions (two coins, A1 kept and A2
// purged); Core is a fake serving the shapes of its public routes.

const addr = (n: number) => toAddress(new Uint8Array(32).fill(n));
const G1 = addr(21), G2 = addr(22); // the agents
const LA1 = addr(31), LA2 = addr(32); // their AgentLaunch accounts
const POOL2 = pumpPdas.pool(A2, LINE);
const NOW = 1791661200;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const k = (a: string) => addressBytes(a);
/** An AgentLaunch account of a pump.fun launch (the layout packages/chain decodeAgentLaunch reads). */
function agentLaunch(agent: string, mint: string, creator: string, graduated: boolean) {
  const url = new TextEncoder().encode("https://github.com/lineage-test/base58");
  return cat(accountDisc("AgentLaunch"), k(agent), k(mint), k(LINE), new Uint8Array(32), u64(BigInt(url.length)).subarray(0, 4), url, Uint8Array.of(2, 1),
    k(PUMP.program), k(pumpPdas.bondingCurve(mint)), graduated ? k(POOL2) : new Uint8Array(32), k(creator), new Uint8Array(32), Uint8Array.of(graduated ? 1 : 0, 1),
    u64(1_791_661_100n), u64(100n), u64(70n), u64(30n), u64(0n), u64(0n), Uint8Array.of(255, 254));
}
/** The launch program's LaunchConfig (decodeLaunchConfig): the quote mint is all discovery needs. */
const launchConfig = () => cat(accountDisc("LaunchConfig"), k(addr(1)), k(addr(2)), k(addr(3)), k(LINE), k(TOKEN_2022_PROGRAM), k(addr(4)), k(PUMP.program),
  Uint8Array.of(0x58, 0x1b, 0xb8, 0x0b), u64(1n), u64(2n), u64(0n), new Uint8Array(16), Uint8Array.of(0, 255, 254));
const mintAcct = (supply: bigint) => { const d = new Uint8Array(82); d.set(u64(supply), 36); d[44] = 6; d[45] = 1; return d; };

const sigOf = (c: string) => c.repeat(88);
/** One more transaction per coin through its launch source: a fee crank and the launch record of units_launch. */
function crankOf(step: string, agent: string, mint: string, sig: string): RawTx {
  let t = withLog(tx(step), feesCranked(agent, mint, 1000n, 700n, false, 700n));
  t = withLog(t, pumpLaunched(agent, mint, addr(9), pumpPdas.bondingCurve(mint), mint === A1 ? FX.creator_pdas.a1 : FX.creator_pdas.a2));
  t.transaction.signatures = [sig];
  t.slot += 1;
  t.meta!.innerInstructions = [];
  t.meta!.postTokenBalances = [];
  return t;
}

function chain(db: Database) {
  const extra: Record<string, RawTx> = { [LA1]: crankOf("4", G1, A1, sigOf("3")), [LA2]: crankOf("9d", G2, A2, sigOf("4")) };
  const bySig = new Map<string, RawTx>([...FX.txs.map((t) => [t.tx.transaction.signatures[0]!, t.tx] as [string, RawTx]),
    ...Object.values(extra).map((t) => [t.transaction.signatures[0]!, t] as [string, RawTx])]);
  // both curves name a creator pump.fun reassigned, so the pump.fun watch (meta pump_alerts) names both mints
  const curve1 = b64(FX.accounts.a1_curve!), curve2 = b64(FX.accounts.a2_curve!);
  curve1.set(addressBytes(addr(8)), 49);
  curve2.set(addressBytes(addr(8)), 49);
  const pool = b64(FX.accounts.a2_pool!);
  const tokenAcct = (mint: string, owner: string, amount: bigint) => cat(addressBytes(mint), addressBytes(owner), u64(amount), new Uint8Array(165 - 72));
  const accounts: Record<string, Uint8Array> = {
    [launchPdas.config()]: launchConfig(), [LINE]: mintAcct(1_000_000_000_000_000n),
    [LA1]: agentLaunch(G1, A1, FX.creator_pdas.a1, false), [LA2]: agentLaunch(G2, A2, FX.creator_pdas.a2, true),
    [A1]: mintAcct(1_000_000_000_000_000n), [A2]: mintAcct(1_000_000_000_000_000n),
    [pumpPdas.bondingCurve(A1)]: curve1, [pumpPdas.bondingCurve(A2)]: curve2, [POOL2]: pool,
    [toAddress(pool.subarray(139, 171))]: tokenAcct(A2, POOL2, 200_000_000_000_000n), [toAddress(pool.subarray(171, 203))]: tokenAcct(LINE, POOL2, 80_000_000_000_000n),
    [PUMP.global]: b64(FX.accounts.global!), [PUMP.feeConfig]: b64(FX.accounts.fee_config!), [PUMP.ammFeeConfig]: b64(FX.accounts.amm_fee_config!),
  };
  const owners: Record<string, string> = { [pumpPdas.bondingCurve(A1)]: PUMP.program, [pumpPdas.bondingCurve(A2)]: PUMP.program, [POOL2]: PUMP.amm,
    [PUMP.global]: PUMP.program, [PUMP.feeConfig]: PUMP.fees, [PUMP.ammFeeConfig]: PUMP.fees, [LA1]: LAUNCH_PROGRAM_ID, [LA2]: LAUNCH_PROGRAM_ID };
  const raw = (a: string) => (accounts[a] ? { lamports: 1, owner: owners[a] ?? TOKEN_2022_PROGRAM, executable: false, data: [Buffer.from(accounts[a]!).toString("base64"), "base64"] } : null);
  const calls: { method: string; params: unknown[] }[] = [];
  /** set to hold every call of one method until `release()`: a pass of the indexer caught in the middle of a chain read */
  const gate: { method: string | null; waiting: number; release: () => void; opened: Promise<void> } = { method: null, waiting: 0, release: () => {}, opened: Promise.resolve() };
  const hold = (method: string) => {
    gate.method = method;
    gate.waiting = 0;
    gate.opened = new Promise<void>((r) => (gate.release = () => { gate.method = null; r(); }));
  };
  const transport: Transport = async (method, params) => {
    calls.push({ method, params });
    if (gate.method === method) {
      gate.waiting++;
      await gate.opened;
    }
    if (method === "getSlot") return 1000;
    if (method === "getAccountInfo") return { value: raw(params[0] as string) };
    if (method === "getMultipleAccounts") return { value: (params[0] as string[]).map(raw) };
    if (method === "getProgramAccounts") {
      // the launch program's AgentLaunch accounts; the token program refuses, so holders come from indexed balances
      if (params[0] !== LAUNCH_PROGRAM_ID) {
        if (!opts.holdersFromChain) throw new RpcError("excluded from account secondary indexes", -32010);
        return [{ pubkey: addr(41), account: { data: [Buffer.from(cat(addressBytes(addr(42)), u64(5n))).toString("base64"), "base64"] } }];
      }
      return [LA1, LA2].map((a) => ({ pubkey: a, account: raw(a)! }));
    }
    if (method === "getSignaturesForAddress") {
      const [address, opt] = params as [string, { until?: string; before?: string; limit: number }];
      let list = extra[address] ? [{ signature: extra[address]!.transaction.signatures[0]!, slot: extra[address]!.slot, err: null }]
        : FX.txs.filter((t) => accountKeys(t.tx).includes(address)).map((t) => ({ signature: t.tx.transaction.signatures[0]!, slot: t.tx.slot, err: null })).sort((a, b) => b.slot - a.slot);
      if (opt.until) list = list.slice(0, Math.max(0, list.findIndex((s) => s.signature === opt.until)));
      if (opt.before) list = list.slice(list.findIndex((s) => s.signature === opt.before) + 1);
      return list.slice(0, opt.limit);
    }
    if (method === "getTransaction") return structuredClone(bySig.get((params as [string])[0]) ?? null);
    throw new Error(`unexpected ${method}`);
  };
  let clock = NOW;
  const ix = new Indexer(db, new Rpc(transport), { now: () => clock, discoverEveryS: 0 });
  /** holdersFromChain: the token program answers getProgramAccounts with one holder of whatever mint is asked for */
  const opts = { holdersFromChain: false };
  return { ix, calls, hold, gate, opts, tick: (s: number) => (clock += s) };
}

/** A fake Core: `purged` is what GET /v1/purged answers (null: the route does not exist), `down` fails every read. */
function fakeCore(o: { purged?: unknown; agents?: string[]; hidden?: { mint: string; agent: string }[]; down?: boolean }) {
  const mintOf: Record<string, string> = { [G1]: A1, [G2]: A2 };
  return async (p: string) => {
    if (o.down) throw new Error("connection refused");
    if (p === "/v1/purged" && o.purged != null) return structuredClone(o.purged);
    if (p === "/v1/hidden") return { hidden: (o.hidden ?? []).map((h) => ({ ...h, reason: "test launch", added_at: 5 })) };
    if (p === "/v1/agents") return (o.agents ?? [G1, G2]).map((a) => ({ agent_id: a, mint: mintOf[a] ?? null, target_repo: "https://github.com/lineage-test/base58", kind: "launched" }));
    if (p === "/v1/lineages") return [];
    if (p === "/v1/sessions?limit=500") return [];
    throw new Error(`404 ${p}`);
  };
}
const listing = (rows: { agent: string; mint: string | null }[]) => ({ digest: "sha256 of the base58 text",
  purged: rows.map((r) => ({ agent_sha256: sha(r.agent), mint_sha256: r.mint ? sha(r.mint) : null, purged_at: 1791661150 })), count: rows.length });

const tables = (db: Database) => (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
/** Every row of every table whose any text cell holds one of `needles`: the full scan, not a list of known tables. */
function mentions(db: Database, needles: string[]) {
  const out: Record<string, number> = {};
  for (const t of tables(db)) {
    for (const row of db.query(`SELECT * FROM "${t}"`).all() as Record<string, unknown>[]) {
      if (Object.values(row).some((v) => typeof v === "string" && needles.some((n) => v.includes(n)))) out[t] = (out[t] ?? 0) + 1;
    }
  }
  return out;
}
/** Every row of every table as text, sorted; rows that hold one of `needles` are left out (what a purge is expected to delete). */
function dump(db: Database, needles: string[] = []) {
  const out: Record<string, string[]> = {};
  for (const t of tables(db)) {
    if (t === "purged_mints" || t === "purged_agents") continue;
    const rows = (db.query(`SELECT * FROM "${t}"`).all() as Record<string, unknown>[])
      .filter((r) => !(t === "meta" && r.k === "pump_alerts"))
      .map((r) => JSON.stringify(r)).filter((s) => !needles.some((n) => s.includes(n))).sort();
    out[t] = rows;
  }
  return out;
}
const n = (db: Database, sql: string, ...args: string[]) => (db.query(sql).get(...args) as { n: number }).n;

/** Both coins discovered from chain and fully indexed, Core read once with nothing purged. */
async function indexed(path = ":memory:") {
  const db = openDb(path);
  const c = chain(db);
  await c.ix.cycle(); // discovery, state (the pool source of A2 appears), every source, holders
  await c.ix.cycle(); // the pool source, state again
  await syncCore(db, fakeCore({ hidden: [{ mint: A2, agent: G2 }] }), NOW);
  return { db, ...c };
}
// everything that names the purged launch: its mint and agent, and the chain addresses derived from them
const PURGED_IDS = [A2, G2, LA2, pumpPdas.bondingCurve(A2), POOL2, launchPdas.computeVault(G2)];

describe("purged launches", () => {
  test("the digest is Core's: sha256 of the base58 text, lowercase hex", () => {
    expect(purgeDigest(A2)).toBe(sha(A2));
    expect(purgeDigest(G2)).toBe(coreDigest(G2));
    expect(purgeDigest(A2)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("every row of a purged coin goes, the other coin's rows stay as they were, and the list holds digests only", async () => {
    const { db, ix } = await indexed();
    // what the test stands on: both coins have rows in every per-coin table, and the watch names both
    for (const t of ["tokens", "sources", "seen", "trades", "fee_cranks", "events", "token_accounts", "holders", "sweeps"])
      for (const m of [A1, A2]) expect([t, m, n(db, `SELECT COUNT(*) AS n FROM ${t} WHERE mint = ?`, m) > 0]).toEqual([t, m, true]);
    expect(n(db, "SELECT COUNT(*) AS n FROM core_agents WHERE agent = ?", G2)).toBe(1);
    expect(n(db, "SELECT COUNT(*) AS n FROM hidden_mints WHERE mint = ?", A2)).toBe(1);
    const alertsBefore = JSON.parse((db.query("SELECT v FROM meta WHERE k = 'pump_alerts'").get() as { v: string }).v);
    expect(alertsBefore.alerts.map((a: { subject: string }) => a.subject).sort()).toEqual([A1, A2].sort());
    expect(Object.keys(mentions(db, [A2, G2])).length).toBeGreaterThanOrEqual(11);
    (ix as any).dirtyHolders.add(A2);
    expect([...(ix as any).schedule.keys()]).toContain(pumpPdas.bondingCurve(A2));
    const before = dump(db, PURGED_IDS);

    // Core purged A2: it is gone from Core's agents and hidden list, and listed by digest
    const dropped: unknown[] = [];
    const cache = new Map([[G1, { model: "m", at: NOW }], [G2, { model: "m", at: NOW }]]);
    await syncCore(db, fakeCore({ purged: listing([{ agent: G2, mint: A2 }]), agents: [G1] }), NOW,
      { modelCache: cache, onPurge: (p) => { dropped.push(p); ix.forgetMissing(); } });

    expect(mentions(db, PURGED_IDS)).toEqual({}); // every text cell of every table
    expect(dump(db)).toEqual(before); // the other coin, the quote coin and Core's rows: unchanged
    expect(n(db, "SELECT COUNT(*) AS n FROM tokens")).toBe(1);
    const alerts = JSON.parse((db.query("SELECT v FROM meta WHERE k = 'pump_alerts'").get() as { v: string }).v);
    expect(alerts.alerts.map((a: { subject: string }) => a.subject)).toEqual([A1]);
    expect({ ...alerts, alerts: [] }).toEqual({ ...alertsBefore, alerts: [] });
    // the list: digests, never an id
    expect(db.query("SELECT * FROM purged_mints").all()).toEqual([{ mint_sha256: sha(A2), agent_sha256: sha(G2), purged_at: 1791661150 }]);
    expect(db.query("SELECT * FROM purged_agents").all()).toEqual([{ agent_sha256: sha(G2), purged_at: 1791661150 }]);
    // what the process held in memory
    expect(dropped.length).toBe(1);
    expect(dropped[0]).toMatchObject({ mints: 1, agents: 1 });
    expect(JSON.stringify(dropped)).not.toContain(A2);
    expect([...cache.keys()]).toEqual([G1]);
    expect([...(ix as any).dirtyHolders]).not.toContain(A2);
    const sched = [...(ix as any).schedule.keys()] as string[];
    expect(sched.some((a) => PURGED_IDS.includes(a))).toBe(false);
    expect(sched).toContain(pumpPdas.bondingCurve(A1));

    // a second pass deletes nothing and changes nothing
    await syncCore(db, fakeCore({ purged: listing([{ agent: G2, mint: A2 }]), agents: [G1] }), NOW, { onPurge: (p) => dropped.push(p) });
    expect(dropped.length).toBe(1);
    expect(dump(db)).toEqual(before);

    // rows of the coin with no token row (written past the guards, by whatever means) go on the next pass, Core readable or not
    db.query("INSERT INTO sources (address, mint, kind) VALUES (?, ?, 'pool')").run(POOL2, A2);
    db.query("INSERT INTO holders (mint, owner, amount) VALUES (?, 'someone', '1')").run(A2);
    db.query("INSERT INTO seen (sig, mint, slot, time, failed) VALUES ('sig', ?, 1, 1, 0)").run(A2);
    expect(Object.keys(mentions(db, PURGED_IDS)).sort()).toEqual(["holders", "seen", "sources"]);
    await expect(syncCore(db, fakeCore({ down: true }), NOW, { onPurge: (p) => dropped.push(p) })).rejects.toThrow();
    expect(mentions(db, PURGED_IDS)).toEqual({});
    expect(dropped[1]).toMatchObject({ mints: 1, rows: 3 });
    expect(dump(db)).toEqual(before);
  });

  test("discovery never imports it again, and no decoded transaction is stored for it", async () => {
    const { db, ix, calls, tick } = await indexed();
    const before = dump(db, PURGED_IDS);
    await syncCore(db, fakeCore({ purged: listing([{ agent: G2, mint: A2 }]), agents: [G1] }), NOW);
    calls.length = 0;
    expect(await ix.discover()).toBe(2); // the chain still has both AgentLaunch accounts
    expect(calls.some((c) => c.method === "getMultipleAccounts" && (c.params[0] as string[]).includes(A2))).toBe(false);
    for (let i = 0; i < 3; i++) {
      tick(3600);
      const r = await ix.cycle(); // discovery, state, sources and holders, all due
      expect(r.errors).toBe(0);
    }
    expect(calls.some((c) => c.method === "getSignaturesForAddress" && PURGED_IDS.includes(c.params[0] as string))).toBe(false);
    expect(mentions(db, PURGED_IDS)).toEqual({});
    expect(n(db, "SELECT COUNT(*) AS n FROM tokens")).toBe(1);
    // holders_at, state_at and poll times moved for the kept coin; nothing else did
    const strip = (d: Record<string, string[]>) => Object.fromEntries(Object.entries(d).filter(([t]) => t !== "tokens" && t !== "sources"));
    expect(strip(dump(db))).toEqual(strip(before));

    // the single write point of decoded transactions refuses the coin
    const d = decodeTx(tx("9a"), ctxOf(A2));
    expect(d.trades.length).toBe(1);
    expect(storeDecoded(db, A2, d, { base: 6, quote: 6 })).toBe(false);
    expect(mentions(db, PURGED_IDS)).toEqual({});
    expect(await ix.syncSource(POOL2)).toBe(0);
    expect(await ix.refreshHolders(A2)).toBe(0);
    expect(isPurgedMint(db, A2)).toBe(true);
    expect(isPurgedMint(db, A1)).toBe(false);
  });

  test("a pass that was reading the chain for the coin when it was purged writes nothing afterwards", async () => {
    const purge = (db: Database) => syncCore(db, fakeCore({ purged: listing([{ agent: G2, mint: A2 }]), agents: [G1] }), NOW);
    const waiting = async (gate: { waiting: number }) => { for (let i = 0; i < 200 && !gate.waiting; i++) await new Promise((r) => setTimeout(r, 1)); expect(gate.waiting).toBeGreaterThan(0); };

    // a source held between its signature list and a transaction: forget the cursor so there is something to fetch
    {
      const { db, ix, hold, gate } = await indexed();
      db.query("DELETE FROM seen WHERE mint = ?").run(A2);
      db.query("DELETE FROM trades WHERE mint = ?").run(A2);
      db.query("UPDATE sources SET newest_sig = NULL WHERE mint = ?").run(A2);
      hold("getTransaction");
      const run = ix.syncSource(POOL2);
      await waiting(gate);
      await purge(db);
      gate.release();
      expect(await run).toBe(0);
      expect(mentions(db, PURGED_IDS)).toEqual({});
    }
    // the state refresh held while it reads every token's accounts (it would write the pool source and the watch)
    {
      const { db, ix, hold, gate } = await indexed();
      hold("getMultipleAccounts");
      const run = ix.refreshState();
      await waiting(gate);
      await purge(db);
      gate.release();
      await run;
      expect(mentions(db, PURGED_IDS)).toEqual({});
    }
    // the holder refresh held while it reads the mint; the chain then answers with a holder of the coin
    {
      const { db, ix, hold, gate, opts } = await indexed();
      (ix as any).gpaRefused = false; // read the token program's accounts again, as a first refresh does
      opts.holdersFromChain = true;
      hold("getAccountInfo");
      const run = ix.refreshHolders(A2);
      await waiting(gate);
      await purge(db);
      gate.release();
      expect(await run).toBe(0);
      expect(mentions(db, PURGED_IDS)).toEqual({});
    }
    // discovery held while it reads the mint accounts of a launch it has not seen yet
    {
      const db = openDb(":memory:");
      const { ix, hold, gate } = chain(db);
      hold("getMultipleAccounts");
      const run = ix.discover();
      await waiting(gate);
      await purge(db);
      gate.release();
      await run;
      expect(mentions(db, PURGED_IDS)).toEqual({});
      expect(n(db, "SELECT COUNT(*) AS n FROM tokens WHERE mint = ?", A1)).toBe(1);
    }
  });

  test("the list survives a Core that fails, lacks the route, or answers without the digest", async () => {
    const { db, ix, tick } = await indexed();
    await syncCore(db, fakeCore({ purged: listing([{ agent: G2, mint: A2 }]), agents: [G1] }), NOW);
    const check = async () => {
      tick(3600);
      await ix.cycle();
      expect(db.query("SELECT mint_sha256 FROM purged_mints").all()).toEqual([{ mint_sha256: sha(A2) }]);
      expect(mentions(db, PURGED_IDS)).toEqual({});
      expect(n(db, "SELECT COUNT(*) AS n FROM tokens")).toBe(1);
    };
    await expect(syncCore(db, fakeCore({ down: true }), NOW)).rejects.toThrow(/refused/); // Core down: the pass fails, the list stays
    await check();
    // an older Core: no /v1/purged, and it still lists the agent and its hidden entry
    expect(await syncCore(db, fakeCore({ hidden: [{ mint: A2, agent: G2 }] }), NOW)).toBe(1);
    await check();
    await syncCore(db, fakeCore({ purged: { purged: [], count: 0 }, agents: [G1, G2] }), NOW); // an empty answer removes nothing
    await check();
    await syncCore(db, fakeCore({ purged: { purged: [{ agent_sha256: "not a digest", mint_sha256: 7 }, null, "x"] }, agents: [G1] }), NOW); // a malformed answer adds nothing
    expect(n(db, "SELECT COUNT(*) AS n FROM purged_mints")).toBe(1);
    await check();
  });

  test("a purge takes effect although the rest of the Core pass fails", async () => {
    const { db } = await indexed();
    const core = fakeCore({ purged: listing([{ agent: G2, mint: A2 }]) });
    await expect(syncCore(db, async (p) => { if (p === "/v1/agents") throw new Error("HTTP 502"); return core(p); }, NOW)).rejects.toThrow(/502/);
    expect(mentions(db, PURGED_IDS)).toEqual({});
  });

  test("a launch listed by its agent alone (Core held no mint) is matched by the agent, and its mint is guarded from then on", async () => {
    const { db, ix, tick } = await indexed();
    await syncCore(db, fakeCore({ purged: listing([{ agent: G2, mint: null }]), agents: [G1] }), NOW);
    expect(mentions(db, PURGED_IDS)).toEqual({});
    expect(db.query("SELECT mint_sha256, agent_sha256 FROM purged_mints").all()).toEqual([{ mint_sha256: sha(A2), agent_sha256: sha(G2) }]);
    expect(storeDecoded(db, A2, decodeTx(tx("9a"), ctxOf(A2)), { base: 6, quote: 6 })).toBe(false);
    tick(3600);
    await ix.cycle();
    expect(mentions(db, PURGED_IDS)).toEqual({});
    expect(n(db, "SELECT COUNT(*) AS n FROM tokens")).toBe(1);
  });

  test("the API: 404 for the coin, and it is in no listing, total, flow or alert", async () => {
    const { db } = await indexed();
    const api = marketApi(db, () => ({ tokens: n(db, "SELECT COUNT(*) AS n FROM tokens"), trades: n(db, "SELECT COUNT(*) AS n FROM trades"),
      fee_cranks: n(db, "SELECT COUNT(*) AS n FROM fee_cranks"), transactions: n(db, "SELECT COUNT(*) AS n FROM seen"),
      sources: db.query("SELECT address, mint FROM sources").all() }), { now: () => NOW });
    const get = async (p: string) => {
      const r = await api(new Request(`http://x${p}`));
      return { status: r.status, text: await r.text() };
    };
    const routes = ["", "/trades", "/candles?tf=1d&from=0", "/holders", "/fees"];
    const lists = ["/market/tokens", "/market/tokens?hidden=1", `/market/tokens?q=${A2}`, `/market/tokens?q=${G2}`, "/market/tokens?launcher=" + LINE, "/market/summary", "/market/flows",
      "/market/flows?hidden=1", "/market/alerts", "/market/status"];
    for (const r of routes) expect([r, (await get(`/market/tokens/${A2}${r}`)).status]).toEqual([r, 200]);
    expect((await get("/market/tokens?hidden=1")).text).toContain(A2);
    const a1 = Object.fromEntries(await Promise.all(routes.map(async (r) => [r, (await get(`/market/tokens/${A1}${r}`)).text])));
    const statusBefore = JSON.parse((await get("/market/status")).text);

    await syncCore(db, fakeCore({ purged: listing([{ agent: G2, mint: A2 }]), agents: [G1] }), NOW);

    for (const r of routes) expect([r, (await get(`/market/tokens/${A2}${r}`)).status]).toEqual([r, 404]);
    for (const p of lists) {
      const r = await get(p);
      expect([p, r.status]).toEqual([p, 200]);
      for (const id of PURGED_IDS) expect([p, r.text.includes(id)]).toEqual([p, false]);
    }
    expect(JSON.parse((await get("/market/tokens?hidden=1")).text)).toMatchObject({ count: 1, total: 1 });
    expect(JSON.parse((await get(`/market/tokens?q=${A2}`)).text).count).toBe(0);
    expect(JSON.parse((await get("/market/summary")).text)).toMatchObject({ tokens: 1, hidden: 0, alerts: 1 });
    const status = JSON.parse((await get("/market/status")).text);
    expect(status.tokens).toBe(1);
    for (const key of ["trades", "fee_cranks", "transactions"]) expect(status[key]).toBeLessThan(statusBefore[key]);
    expect(status.trades).toBe(n(db, "SELECT COUNT(*) AS n FROM trades WHERE mint = ?", A1));
    // the kept coin answers as before
    for (const r of routes) expect([r, (await get(`/market/tokens/${A1}${r}`)).text]).toEqual([r, a1[r]]);
  });

  test("on disk: after the purge neither the database file nor its log holds the mint or the agent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "units-indexer-purged-"));
    try {
      const { db } = await indexed(join(dir, "market.db"));
      const held = () => readdirSync(dir).map((f) => readFileSync(join(dir, f)).toString("latin1")).join("\n");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      expect(held()).toContain(A2);
      await syncCore(db, fakeCore({ purged: listing([{ agent: G2, mint: A2 }]), agents: [G1] }), NOW);
      const bytes = held();
      for (const id of PURGED_IDS) expect([id, bytes.includes(id)]).toEqual([id, false]);
      expect(bytes).toContain(A1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
