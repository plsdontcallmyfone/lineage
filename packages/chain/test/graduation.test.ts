// The graduation keeper's detection and its one-step rule (src/graduation.ts), on bytes mainnet's
// pump.fun programs wrote on the mainnet fork (fixtures/pump-fork.json): a coin on its curve (a1) and
// a migrated coin with its PumpSwap pool (a2). The state between the two, a complete curve with no
// pool, is a1's curve with its `complete` byte set and its real token reserves zeroed, as the
// completing buy leaves it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { base58Decode, generateAgentKey } from "@units/protocol";
import * as c from "../src/index.ts";

const fx = JSON.parse(readFileSync(new URL("./fixtures/pump-fork.json", import.meta.url), "utf8"));
const b64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));
const { line, a1, a2 } = fx.mints as { line: string; a1: string; a2: string };
const O = c.BONDING_CURVE_OFFSETS;
const k = () => generateAgentKey().id;

const launchOf = (mint: string, graduated = false) => ({ venue: "pump" as const, mint, graduated, bondingCurve: c.pumpPdas.bondingCurve(mint) });
const curveAcc = (data: Uint8Array) => ({ owner: c.PUMP.program, data });
const poolAcc = (data: Uint8Array) => ({ owner: c.PUMP.amm, data });
const onCurve = b64(fx.accounts.a1_curve), migratedCurve = b64(fx.accounts.a2_curve), pool2 = b64(fx.accounts.a2_pool);
/** a1's curve as the completing buy leaves it: complete, no real tokens left, the raise still in it. */
const completeCurve = (() => {
  const d = onCurve.slice();
  d[O.complete] = 1;
  d.fill(0, O.realTokenReserves, O.realTokenReserves + 8);
  return d;
})();
const policy = (over: Partial<c.GraduationPolicy> = {}): c.GraduationPolicy => ({ migrate: true, migrateAfterS: 120, enableMigrate: true, completedAt: 1_000, now: 2_000, ...over });

describe("where a coin stands", () => {
  test("on its curve", () => {
    const r = c.graduationState(launchOf(a1), line, curveAcc(onCurve), null);
    expect([r.state, r.pool, r.curve!.complete]).toEqual(["curve", c.pumpPdas.pool(a1, line), false]);
  });
  test("complete, pool not made yet: awaiting migration", () => {
    const r = c.graduationState(launchOf(a1), line, curveAcc(completeCurve), null);
    expect(r.state).toBe("awaiting_migration");
    expect([r.curve!.complete, r.curve!.realTokenReserves, c.curveMigrated(r.curve!)]).toEqual([true, 0n, false]);
  });
  test("migrated by pump.fun, not recorded by the launch program", () => {
    const r = c.graduationState(launchOf(a2), line, curveAcc(migratedCurve), poolAcc(pool2));
    expect([r.state, r.pool, r.poolData!.baseMint, r.poolData!.quoteMint]).toEqual(["migrated", c.pumpPdas.pool(a2, line), a2, line]);
  });
  test("recorded: nothing else is read", () => {
    expect(c.graduationState(launchOf(a2, true), line, null, null).state).toBe("recorded");
    expect(c.graduationState(launchOf(a2, true), line, curveAcc(migratedCurve), poolAcc(pool2)).state).toBe("recorded");
  });
  test("the same accounts read twice give the same state (nothing is remembered between runs)", () => {
    for (const [l, cu, p] of [[launchOf(a1), curveAcc(onCurve), null], [launchOf(a1), curveAcc(completeCurve), null], [launchOf(a2), curveAcc(migratedCurve), poolAcc(pool2)]] as const)
      expect(c.graduationState(l, line, cu, p).state).toBe(c.graduationState(l, line, cu, p).state);
  });
});

describe("accounts the launch program would refuse are refused here first", () => {
  const refuses = (f: () => unknown, re: RegExp) => { expect(f).toThrow(c.GraduationRefused); expect(f).toThrow(re); };
  test("a Meteora-era record", () => refuses(() => c.graduationState({ ...launchOf(a1), venue: "meteora" }, line, curveAcc(onCurve), null), /not a pump\.fun launch/));
  test("a record whose curve is not pump.fun's curve of the mint", () => refuses(() => c.graduationState({ ...launchOf(a1), bondingCurve: k() }, line, curveAcc(onCurve), null), /not pump\.fun's curve/));
  test("no curve account, or one another program owns", () => {
    refuses(() => c.graduationState(launchOf(a1), line, null, null), /no pump\.fun bonding curve/);
    refuses(() => c.graduationState(launchOf(a1), line, { owner: k(), data: onCurve }, null), /no pump\.fun bonding curve/);
  });
  test("an account at the pool's address that PumpSwap does not own", () => refuses(() => c.graduationState(launchOf(a2), line, curveAcc(migratedCurve), { owner: k(), data: pool2 }), /not owned by PumpSwap/));
  test("a pool of another coin, or quoted in another coin", () => {
    refuses(() => c.graduationState(launchOf(a1), line, curveAcc(completeCurve), poolAcc(pool2)), /not the canonical pool/);
    refuses(() => c.graduationState(launchOf(a2), k(), curveAcc(migratedCurve), poolAcc(pool2)), /not the canonical pool/);
  });
  test("a pool beside a curve that is not complete", () => {
    const open = migratedCurve.slice();
    open[O.complete] = 0;
    refuses(() => c.graduationState(launchOf(a2), line, curveAcc(open), poolAcc(pool2)), /not complete/);
  });
  test("a curve that says it migrated with no pool at the canonical address", () => refuses(() => c.graduationState(launchOf(a2), line, curveAcc(migratedCurve), null), /pool is not there/));
});

describe("the one step per state", () => {
  test("on its curve and recorded: nothing, whatever the policy", () => {
    for (const p of [policy(), policy({ migrate: false }), policy({ enableMigrate: false }), policy({ completedAt: null })]) {
      expect(c.graduationStep("curve", p).kind).toBe("none");
      expect(c.graduationStep("recorded", p).kind).toBe("none");
    }
  });
  test("migrated: record, whoever migrated and whatever the policy says about migrating", () => {
    for (const p of [policy(), policy({ migrate: false }), policy({ enableMigrate: false }), policy({ completedAt: 1_999 })]) expect(c.graduationStep("migrated", p).kind).toBe("record");
  });
  test("awaiting migration: pump.fun's keeper is given its head start, then this one migrates", () => {
    expect(c.graduationStep("awaiting_migration", policy({ completedAt: 1_990 })).kind).toBe("wait");
    expect(c.graduationStep("awaiting_migration", policy({ completedAt: 1_881 })).kind).toBe("wait");
    expect(c.graduationStep("awaiting_migration", policy({ completedAt: 1_880 })).kind).toBe("migrate");
    expect(c.graduationStep("awaiting_migration", policy({ completedAt: 1_000 })).kind).toBe("migrate");
    expect(c.graduationStep("awaiting_migration", policy({ completedAt: 1_999, migrateAfterS: 0 })).kind).toBe("migrate");
  });
  test("a completion time that cannot be found counts as long ago", () => expect(c.graduationStep("awaiting_migration", policy({ completedAt: null })).kind).toBe("migrate"));
  test("a block time ahead of this clock never makes the wait negative", () => {
    const s = c.graduationStep("awaiting_migration", policy({ completedAt: 2_005 }));
    expect(s.kind).toBe("wait");
    expect(s.why).toContain("completed 0 s ago");
  });
  test("it never migrates when told not to, or while pump.fun has migrations switched off: it waits and records later", () => {
    expect(c.graduationStep("awaiting_migration", policy({ migrate: false })).kind).toBe("wait");
    expect(c.graduationStep("awaiting_migration", policy({ enableMigrate: false })).kind).toBe("wait");
  });
});

describe("idempotence over the whole sequence", () => {
  // the chain as a keeper run changes it: a migration makes the pool, a record sets the flag
  type World = { launch: ReturnType<typeof launchOf>; curve: Uint8Array; pool: Uint8Array | null };
  const read = (w: World) => c.graduationState(w.launch, line, curveAcc(w.curve), w.pool ? poolAcc(w.pool) : null).state;
  const run = (w: World, p = policy()): { w: World; did: string } => {
    const step = c.graduationStep(read(w), p);
    if (step.kind === "migrate") return { w: { launch: { ...w.launch, graduated: true }, curve: migratedCurve, pool: pool2 }, did: "migrate+record" };
    if (step.kind === "record") return { w: { ...w, launch: { ...w.launch, graduated: true } }, did: "record" };
    return { w, did: step.kind };
  };
  const awaiting: World = { launch: launchOf(a2), curve: (() => { const d = migratedCurve.slice(); d.set(completeCurve.subarray(O.virtualTokenReserves, O.complete), O.virtualTokenReserves); return d; })(), pool: null };
  test("this keeper does both steps once, then every later run does nothing", () => {
    const first = run(awaiting);
    expect([first.did, read(first.w)]).toEqual(["migrate+record", "recorded"]);
    for (let i = 0, w = first.w; i < 3; i++) { const n = run(w); expect(n.did).toBe("none"); w = n.w; }
  });
  test("pump.fun migrates first: this keeper only records, once", () => {
    const theirs: World = { launch: launchOf(a2), curve: migratedCurve, pool: pool2 };
    const first = run(theirs);
    expect([first.did, read(first.w)]).toEqual(["record", "recorded"]);
    expect(run(first.w).did).toBe("none");
  });
  test("somebody else records too: nothing is left to do", () => expect(run({ launch: launchOf(a2, true), curve: migratedCurve, pool: pool2 }).did).toBe("none"));
  test("a run interrupted after the migration landed and before the record is resumed by the next run as a record", () => {
    const afterMigration: World = { launch: launchOf(a2), curve: migratedCurve, pool: pool2 };
    expect(read(afterMigration)).toBe("migrated");
    expect(run(afterMigration, policy({ migrate: false })).did).toBe("record");
  });
  test("inside pump.fun's head start the keeper waits and changes nothing, run after run", () => {
    for (let i = 0; i < 3; i++) expect(run(awaiting, policy({ completedAt: 1_950 + i })).did).toBe("wait");
  });
});

describe("the step's instructions", () => {
  const payer = k(), wa = k();
  test("migrate: pump.fun's migrate_v2 then record_pump_graduation, signed by the payer alone", () => {
    const ixs = c.graduationIxs("migrate", { payer, agentMint: a1, lineMint: line, withdrawAuthority: wa });
    expect(ixs.map((i) => i.programId)).toEqual([c.PUMP.program, c.LAUNCH_PROGRAM_ID]);
    expect([...new Set(ixs.flatMap((i) => i.keys.filter((m) => m.isSigner).map((m) => m.pubkey)))]).toEqual([payer]);
  });
  test("record: one instruction with no signer of its own and four accounts (config, the launch record, the curve, the canonical pool)", () => {
    const ixs = c.graduationIxs("record", { payer, agentMint: a1, lineMint: line, withdrawAuthority: wa });
    expect(ixs.length).toBe(1);
    expect(ixs[0]!.keys.map((m) => m.pubkey)).toEqual([c.launchPdas.config(), c.launchPdas.agentLaunch(a1), c.pumpPdas.bondingCurve(a1), c.pumpPdas.pool(a1, line)]);
    expect(ixs[0]!.keys.some((m) => m.isSigner)).toBe(false);
  });
  test("both fit one packet: the record as a legacy transaction, the migration with the launch lookup table", () => {
    const table: c.LookupTable = { address: k(), addresses: c.launchTableAddresses({ lineMint: line, lineTokenProgram: c.TOKEN_2022_PROGRAM, linePool: { pool: k(), baseVault: k(), quoteVault: k() } }) };
    const price = [c.computeBudget.limit(600_000), c.computeBudget.price(100_000)];
    const rec = c.fitMessage(payer, [...price, ...c.graduationIxs("record", { payer, agentMint: a1, lineMint: line, withdrawAuthority: wa })], "11111111111111111111111111111111", [table]);
    expect(rec.form).toBe("legacy");
    const mig = c.fitMessage(payer, [...price, ...c.graduationIxs("migrate", { payer, agentMint: a1, lineMint: line, withdrawAuthority: wa })], "11111111111111111111111111111111", [table]);
    expect(mig.size).toBeLessThanOrEqual(c.PACKET_LIMIT);
  });
});

describe("when the curve completed", () => {
  const rpcOf = (sigs: { signature: string; err: unknown; blockTime: number | null }[], txs: Record<string, string[]>) =>
    new c.Rpc(async (method: string, params: unknown[]) => {
      if (method === "getSignaturesForAddress") return sigs;
      if (method === "getTransaction") return { meta: { innerInstructions: [{ instructions: (txs[params[0] as string] ?? []).map((data) => ({ data })) }] } };
      throw new Error(method);
    });
  const all = Object.values(fx.events as Record<string, string[]>).flat();
  const isEvent = (d: string, name: string) => { try { return c.decodePumpEvent(base58Decode(d))?.name === name; } catch { return false; } };
  const complete = all.find((d) => isEvent(d, "CompleteEvent"))!, trade = all.find((d) => isEvent(d, "TradeEvent"))!;
  test("the fixture carries pump.fun's CompleteEvent and a trade", () => expect([!!complete, !!trade]).toEqual([true, true]));
  test("the block time of the newest successful transaction on the curve that carries CompleteEvent", async () => {
    const rpc = rpcOf([{ signature: "sweep", err: null, blockTime: 500 }, { signature: "late", err: { x: 1 }, blockTime: 450 }, { signature: "done", err: null, blockTime: 400 }, { signature: "buy", err: null, blockTime: 300 }],
      { sweep: [], late: [complete], done: [trade, complete], buy: [trade] });
    expect(await c.curveCompletedAt(rpc, k())).toBe(400);
  });
  test("null when no such transaction is in reach, or its time is unknown", async () => {
    expect(await c.curveCompletedAt(rpcOf([{ signature: "buy", err: null, blockTime: 300 }], { buy: [trade] }), k())).toBeNull();
    expect(await c.curveCompletedAt(rpcOf([{ signature: "done", err: null, blockTime: null }], { done: [complete] }), k())).toBeNull();
    expect(await c.curveCompletedAt(rpcOf([], {}), k())).toBeNull();
  });
});

describe("the chain's clock", () => {
  const rpcOf = (slot: number, times: Record<number, number | null>) => new c.Rpc(async (method: string, params: unknown[]) => {
    if (method === "getSlot") return slot;
    if (method === "getBlockTime") { const t = times[params[0] as number]; if (t === undefined) throw new Error("Block not available"); return t; }
    throw new Error(method);
  });
  test("the block time of the newest slot", async () => expect(await c.chainTime(rpcOf(100, { 100: 5_000 }))).toBe(5_000));
  test("a slot with no block yet: the one before it", async () => expect(await c.chainTime(rpcOf(100, { 99: 4_999, 98: 4_998 }))).toBe(4_999));
  test("no block time at all: this machine's clock", async () => {
    const t = await c.chainTime(rpcOf(100, {}));
    expect(Math.abs(t - Date.now() / 1000)).toBeLessThan(5);
  });
});
