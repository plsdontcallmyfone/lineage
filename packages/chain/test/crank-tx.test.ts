import { describe, expect, test } from "bun:test";
import { generateAgentKey } from "@units/protocol";
import * as c from "../src/index.ts";

// The size decision of the agent fee crank and the lookup table checks (src/crank-tx.ts). The table
// here has the content of the launch lookup table (launchTableAddresses, what scripts/mainnet/steps.ts
// wrote and froze); sizes do not depend on which keys are used, only on how many.

const FAKE = "11111111111111111111111111111111";
const k = () => generateAgentKey().id;
const T22 = c.TOKEN_2022_PROGRAM;
const line = k(), payer = k(), agent = k(), mint = k();
const linePool = { pool: k(), baseVault: k(), quoteVault: k() };
const table: c.LookupTable = { address: k(), addresses: c.launchTableAddresses({ lineMint: line, lineTokenProgram: T22, linePool }) };
const gh = c.claims.crankRouteKeys(agent, 987_654_321n), pl = c.pools.crankRouteKeys(agent, "123456789", line, T22);
const crank = (graduated: boolean, routes: c.AccountMeta[]) =>
  c.pumpCrankIxs({ payer, agent, agentMint: mint, lineMint: line, lineTokenProgram: T22, pool: graduated ? c.pumpPdas.pool(mint, line) : undefined, routes });
const price = [c.computeBudget.price(100_000)], both = [c.computeBudget.limit(600_000), ...price];
const fit = (ixs: c.Ix[], tables = [table]) => c.fitMessage(payer, ixs, FAKE, tables);

describe("the fee crank's form is chosen from its size", () => {
  test("the launch lookup table of this test has the 24 addresses of the deployed one", () => {
    expect(table.addresses.length).toBe(24);
  });
  // [case, graduated, routes, legacy bytes with the priority fee instruction (what the keeper sends on mainnet), form]
  const cases: [string, boolean, c.AccountMeta[], number, c.TxForm, number][] = [
    ["no route, on the curve", false, [], 860, "legacy", 860],
    ["no route, graduated", true, [], 1126, "legacy", 1126],
    ["fee route, on the curve", false, gh, 959, "legacy", 959],
    ["pool member, on the curve", false, pl, 992, "legacy", 992],
    ["fee route and pool member, on the curve", false, [...gh, ...pl], 1091, "legacy", 1091],
    ["fee route, graduated", true, gh, 1225, "legacy", 1225],
    ["pool member, graduated", true, pl, 1258, "v0", 1108],
    ["fee route and pool member, graduated", true, [...gh, ...pl], 1357, "v0", 1207],
  ];
  for (const [name, graduated, routes, legacy, form, size] of cases) {
    test(`${name}: ${legacy} bytes as legacy, sent as ${form} (${size} bytes)`, () => {
      const f = fit([...price, ...crank(graduated, routes)]);
      expect([f.legacySize, f.form, f.size]).toEqual([legacy, form, size]);
      expect(f.size).toBeLessThanOrEqual(c.PACKET_LIMIT);
      expect(f.size).toBe(c.wireSize(f.msg));
      // a legacy choice never compiles version 0; a version 0 choice reports both
      expect(f.v0Size).toBe(form === "legacy" ? null : size);
      expect(f.loaded).toBe(form === "legacy" ? 0 : 6);
    });
  }
  test("the largest crank with both compute budget instructions still fits version 0: 1,215 bytes (1,365 as legacy)", () => {
    const f = fit([...both, ...crank(true, [...gh, ...pl])]);
    expect([f.form, f.size, f.legacySize]).toEqual(["v0", 1215, 1365]);
  });
  test("without the budget instructions the same crank is the 1,313 bytes the keeper used to report", () => {
    expect(c.wireSize(c.compileMessage(payer, crank(true, [...gh, ...pl]), FAKE))).toBe(1313);
  });
  test("the boundary: 1,232 bytes is legacy, 1,233 is version 0", () => {
    const base = crank(true, gh), pad = (n: number): c.Ix => ({ programId: c.COMPUTE_BUDGET_PROGRAM, keys: [], data: new Uint8Array(n) });
    // find the padding that lands a legacy message on the limit exactly (the data length prefix is one byte below 128)
    const at = (n: number) => c.wireSize(c.compileMessage(payer, [pad(n), ...base], FAKE));
    const n = c.PACKET_LIMIT - at(0);
    expect(n > 0 && n < 127).toBe(true);
    expect(at(n)).toBe(c.PACKET_LIMIT);
    expect(fit([pad(n), ...base]).form).toBe("legacy");
    const over = fit([pad(n + 1), ...base]);
    expect([over.form, over.legacySize]).toEqual(["v0", c.PACKET_LIMIT + 1]);
  });
  test("version 0 keeps the payer and every program id static and loads only what the table holds", () => {
    const ixs = [...price, ...crank(true, [...gh, ...pl])];
    const f = fit(ixs), m = f.msg as c.CompiledMessageV0;
    expect(m.keys[0]).toBe(payer);
    expect(m.numSigners).toBe(1);
    for (const ix of ixs) expect(m.keys).toContain(ix.programId);
    for (const a of [...m.loaded.writable, ...m.loaded.readonly]) expect(table.addresses).toContain(a);
    expect(m.bytes[0]).toBe(0x80);
  });
  test("no table: a crank over the packet is refused with its legacy size", () => {
    let e: unknown;
    try { fit([...price, ...crank(true, [...gh, ...pl])], []); } catch (x) { e = x; }
    expect(e).toBeInstanceOf(c.TxTooLargeError);
    expect([(e as c.TxTooLargeError).legacySize, (e as c.TxTooLargeError).v0Size]).toEqual([1357, null]);
    // and a crank that fits legacy needs none
    expect(fit([...price, ...crank(true, [])], []).form).toBe("legacy");
  });
  test("a table that holds none of the crank's accounts does not help: refused with both sizes", () => {
    let e: unknown;
    try { fit([...price, ...crank(true, [...gh, ...pl])], [{ address: k(), addresses: [k(), k()] }]); } catch (x) { e = x; }
    expect(e).toBeInstanceOf(c.TxTooLargeError);
    expect((e as c.TxTooLargeError).v0Size).toBe(1359); // the version byte and an empty lookup list on top of legacy
    expect((e as Error).message).toContain("1357 bytes as a legacy transaction");
  });
});

/** A lookup table account's bytes (LookupTableMeta, 56 bytes, then the addresses). */
function tableData(o: { addresses: string[]; authority?: string | null; deactivation?: bigint; lastExtended?: bigint }): Uint8Array {
  const d = new Uint8Array(c.ALT_META_LEN + 32 * o.addresses.length), dv = new DataView(d.buffer);
  dv.setUint32(0, 1, true);
  dv.setBigUint64(4, o.deactivation ?? 0xffff_ffff_ffff_ffffn, true);
  dv.setBigUint64(12, o.lastExtended ?? 100n, true);
  if (o.authority) { d[21] = 1; d.set(c.addressBytes(o.authority), 22); }
  o.addresses.forEach((a, i) => d.set(c.addressBytes(a), c.ALT_META_LEN + 32 * i));
  return d;
}

describe("a lookup table is used only when a transaction can load from it", () => {
  const at = k(), addresses = [k(), k(), k()];
  const acc = (data: Uint8Array, owner = c.ALT_PROGRAM) => ({ owner, data });
  test("a frozen table extended in an earlier slot is usable, with its addresses in order", () => {
    const u = c.usableLookupTable(at, acc(tableData({ addresses })), 101);
    expect(u.table).toEqual({ address: at, addresses });
    expect(u.reason).toBe("frozen");
  });
  test("a table that still has an authority is usable and says who", () => {
    const authority = k();
    expect(c.usableLookupTable(at, acc(tableData({ addresses, authority })), 101)).toEqual({ table: { address: at, addresses }, reason: `authority ${authority}` });
  });
  test("extended in the current slot: not yet (loadable from the next slot), then usable", () => {
    const d = tableData({ addresses, lastExtended: 500n });
    expect(c.usableLookupTable(at, acc(d), 500).table).toBeNull();
    expect(c.usableLookupTable(at, acc(d), 500).reason).toContain("loadable from the next slot");
    expect(c.usableLookupTable(at, acc(d), 501).table).not.toBeNull();
  });
  test("missing, foreign, deactivated, empty and malformed accounts are refused with the reason", () => {
    expect(c.usableLookupTable(at, null, 101)).toEqual({ table: null, reason: "no account at that address" });
    expect(c.usableLookupTable(at, acc(tableData({ addresses }), c.SYSTEM_PROGRAM), 101).reason).toContain("not owned");
    expect(c.usableLookupTable(at, acc(tableData({ addresses, deactivation: 90n })), 101).reason).toBe("deactivated at slot 90");
    expect(c.usableLookupTable(at, acc(tableData({ addresses: [] })), 101).reason).toBe("holds no addresses");
    expect(c.usableLookupTable(at, acc(new Uint8Array(40)), 101).table).toBeNull();
    expect(c.usableLookupTable(at, acc(new Uint8Array(c.ALT_META_LEN)), 101).reason).toContain("not an initialized");
  });
});

describe("buildFitted and sendFitted over a recorded RPC", () => {
  const key = generateAgentKey();
  const calls: string[] = [], wires: Uint8Array[] = [];
  const rpc = new c.Rpc(async (method, params) => {
    calls.push(method);
    if (method === "getLatestBlockhash") return { value: { blockhash: FAKE, lastValidBlockHeight: 1000 } };
    if (method === "simulateTransaction") return { value: { err: null, logs: [] } };
    if (method === "sendTransaction") { wires.push(new Uint8Array(Buffer.from(params[0] as string, "base64"))); return "sig"; }
    if (method === "getSignatureStatuses") return { value: [{ err: null, confirmationStatus: "confirmed", slot: 7 }] };
    if (method === "getTransaction") return { slot: 7, meta: { err: null, fee: 5000, logMessages: [], computeUnitsConsumed: 1 } };
    if (method === "getBlockHeight") return 1;
    throw new Error(`unexpected ${method}`);
  });
  const ixs = (graduated: boolean, routes: c.AccountMeta[]) =>
    c.pumpCrankIxs({ payer: key.id, agent, agentMint: mint, lineMint: line, lineTokenProgram: T22, pool: graduated ? c.pumpPdas.pool(mint, line) : undefined, routes });
  test("build signs the chosen form and sends nothing", async () => {
    calls.length = 0;
    const b = await c.buildFitted(rpc, key, ixs(true, [...gh, ...pl]), { tables: [table], priorityMicroLamports: 100_000 });
    expect([b.fit.form, b.fit.size, b.tx.wire.length]).toEqual(["v0", 1207, 1207]);
    expect(b.tx.wire[0]).toBe(1);
    expect(b.tx.wire[65]).toBe(0x80);
    expect(calls).toEqual(["getLatestBlockhash"]);
  });
  test("send broadcasts exactly the bytes of the chosen form and reports it", async () => {
    calls.length = 0; wires.length = 0;
    const v0 = await c.sendFitted(rpc, key, ixs(true, [...gh, ...pl]), { tables: [table], priorityMicroLamports: 100_000 });
    expect([v0.form, v0.size, v0.fee, v0.slot]).toEqual(["v0", 1207, 5000, 7]);
    expect(wires[0]!.length).toBe(1207);
    const legacy = await c.sendFitted(rpc, key, ixs(false, []), { tables: [table], priorityMicroLamports: 100_000 });
    expect([legacy.form, legacy.size]).toEqual(["legacy", 860]);
    expect(wires[1]!.length).toBe(860);
    expect(wires[1]![65]! & 0x80).toBe(0);
    expect(calls.filter((m) => m === "simulateTransaction").length).toBe(2);
  });
  test("a crank that fits neither form is refused before anything is signed or sent", async () => {
    calls.length = 0; wires.length = 0;
    await expect(c.sendFitted(rpc, key, ixs(true, [...gh, ...pl]), { priorityMicroLamports: 100_000 })).rejects.toBeInstanceOf(c.TxTooLargeError);
    expect(wires.length).toBe(0);
    expect(calls).not.toContain("simulateTransaction");
  });
});
