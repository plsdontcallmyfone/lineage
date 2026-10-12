// One approval for the whole deployment (owner direction 2026-10-11): measured sizes, the in-order
// packing, the SOL cost lines, the units account payment check and the Jito helpers.
import { describe, expect, test } from "bun:test";
import { base58Encode, generateAgentKey } from "@units/protocol";
import * as c from "../src/index.ts";

const k = () => generateAgentKey().id;
const LINE = "CiBfnTkDc1vgYbuMobMNEQaKSQXPYeTUbZGRZcug1L62";
const T22 = c.TOKEN_2022_PROGRAM;
const RECIPIENT = "GZszrP7EYDH8RNo6NsqFwAy7WVYsqmqjj3hquTRhAYPW";
const budget = [c.computeBudget.limit(450_000), c.computeBudget.price(1)];
const table = () => ({ address: k(), addresses: c.launchTableAddresses({ lineMint: LINE, lineTokenProgram: T22 }) });

function groups(o: { strings?: number; soul?: boolean; identity?: boolean; tip?: boolean } = {}) {
  const launcher = k(), agent = k(), mint = k();
  const base = { name: "TEST minbpe speedups", symbol: "TMBPE", uri: "https://units.invalid/devnet/agents/tmbpe.json?class=python", repo: "https://github.com/karpathy/minbpe" };
  const used = base.name.length + base.symbol.length + base.uri.length + base.repo.length;
  const pad = Math.max(0, (o.strings ?? used) - used), toUri = Math.min(pad, 200 - base.uri.length);
  const main = c.pumpLaunchMain({ launcher, agent, agentMint: mint, line: { mint: LINE, tokenProgram: T22 }, name: base.name, symbol: base.symbol,
    uri: base.uri + "x".repeat(toUri), args: { repoUrl: base.repo + "x".repeat(pad - toUri), identityMode: 1, hosted: true } });
  const g: c.BundleGroup[] = [
    { name: "launch", ixs: main },
    { name: "soul", ixs: o.soul === false ? [] : [c.registry.setProfile({ signingKey: agent, agent, digest: new Uint8Array(32).fill(7), seq: 1 })] },
    { name: "sol-to-units", ixs: c.pumpSolToLine({ launcher, lineMint: LINE, amountOut: 2_400_000_000n, maxSolIn: 50_000_000n }) },
    { name: "initial-buy", ixs: c.pumpInitialBuy({ launcher, agent, agentMint: mint, lineMint: LINE, amountOut: 10_000_000_000_000n, maxIn: 2_200_000_000n, lineTokenProgram: T22 }) },
    { name: "credits", ixs: c.launch.prepay({ launcher, agent, agentMint: mint, lineMint: LINE, amount: 200_000_000n, decimals: 6, lineTokenProgram: T22 }) },
    { name: "units-account", ixs: o.identity === false ? [] : [c.system.transfer(launcher, RECIPIENT, 50_000_000n)] },
    { name: "tip", ixs: o.tip ? [c.jitoTipIx(launcher, ["96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"], 1_000n)] : [] },
  ];
  return { launcher, agent, mint, g };
}
const all = (g: c.BundleGroup[]) => g.flatMap((x) => x.ixs);

describe("one approval: measured sizes", () => {
  test("the whole launch cannot be one transaction, even as v0 with the launch lookup table", () => {
    const { launcher, g } = groups();
    const v0 = c.wireSize(c.compileMessageV0(launcher, [...budget, ...all(g)], "11111111111111111111111111111111", [table()]));
    expect(v0).toBeGreaterThan(c.PACKET_LIMIT);
    // create_v2 + register_pump_launch alone already take most of a packet for typical strings
    const main = c.wireSize(c.compileMessageV0(launcher, [...budget, ...g[0]!.ixs], "11111111111111111111111111111111", [table()]));
    expect(main).toBeGreaterThan(1000);
    console.log(`measured: whole launch ${v0} bytes as v0, create_v2 + register ${main} bytes`);
  });
  test("typical strings: two transactions (launch + soul, then SOL to $UNITS + initial buy + credits + units account)", () => {
    const { launcher, g } = groups();
    const txs = c.planLaunchBundle({ payer: launcher, groups: g, budget, table: table(), v0: true });
    expect(txs.map((t) => t.groups)).toEqual([["launch", "soul"], ["sol-to-units", "initial-buy", "credits", "units-account"]]);
    for (const t of txs) expect(t.size).toBeLessThanOrEqual(c.PACKET_LIMIT);
    console.log(`measured: ${txs.map((t) => `${t.groups.join("+")} ${t.size} bytes${t.table ? " (v0)" : ""}`).join("; ")}`);
  });
  test("a coin with a chosen image and links (the longest metadata URI, 169 bytes): still two transactions within a packet", () => {
    // name 20 + ticker 5 + the longest URI with ?i= and &l= (169) + a typical repository URL (33)
    const strings = 20 + 5 + c.coinMetadataUriBytes("https://app.units.gg", true, true) + 33;
    expect(strings).toBe(227);
    const { launcher, g } = groups({ strings, identity: false, tip: true });
    const txs = c.planLaunchBundle({ payer: launcher, groups: g, budget, table: table(), v0: true });
    expect(txs.map((t) => t.groups)).toEqual([["launch", "soul"], ["sol-to-units", "initial-buy", "credits", "tip"]]);
    for (const t of txs) expect(t.size).toBeLessThanOrEqual(c.PACKET_LIMIT);
    console.log(`measured, image + links URI: ${txs.map((t) => `${t.groups.join("+")} ${t.size} bytes`).join("; ")}`);
  });
  test("the quote coin on its PumpSwap pool, no purchase inside the launch: two transactions, the second smaller", () => {
    // create_v2 names the pool and its two vaults (three more accounts, all in the launch table); the $UNITS come from the wallet
    const POOL = { pool: k(), baseVault: k(), quoteVault: k() };
    const strings = 20 + 5 + c.coinMetadataUriBytes("https://app.units.gg", true, true) + 33;
    const { launcher, agent, mint, g } = groups({ strings, tip: true });
    const withPool = c.pumpLaunchMain({ launcher, agent, agentMint: mint, line: { mint: LINE, tokenProgram: T22, pool: POOL }, name: "N".repeat(20), symbol: "TMBPE",
      uri: "u".repeat(c.coinMetadataUriBytes("https://app.units.gg", true, true)), args: { repoUrl: "https://github.com/karpathy/minbpe", identityMode: 1, hosted: true } });
    const noBuy = g.filter((x) => x.name !== "sol-to-units").map((x) => (x.name === "launch" ? { ...x, ixs: withPool } : x));
    const t = { address: k(), addresses: c.launchTableAddresses({ lineMint: LINE, lineTokenProgram: T22, linePool: POOL }) };
    const txs = c.planLaunchBundle({ payer: launcher, groups: noBuy, budget, table: t, v0: true });
    expect(txs.map((x) => x.groups)).toEqual([["launch", "soul"], ["initial-buy", "credits", "units-account", "tip"]]);
    for (const x of txs) expect(x.size).toBeLessThanOrEqual(c.PACKET_LIMIT);
    const before = c.planLaunchBundle({ payer: launcher, groups: g, budget, table: table(), v0: true });
    expect(txs[1]!.size).toBeLessThan(before[1]!.size);
    console.log(`measured, quote coin on its pool, no purchase: ${txs.map((x) => `${x.groups.join("+")} ${x.size} bytes${x.table ? " (v0)" : ""}`).join("; ")}`);
  });
  test("MAX_LAUNCH_STRINGS_POOL: with the pool and its vaults named, create_v2 + register fill the packet at 321 bytes of strings, not one byte over", () => {
    const POOL = { pool: k(), baseVault: k(), quoteVault: k() };
    const t = { address: k(), addresses: c.launchTableAddresses({ lineMint: LINE, lineTokenProgram: T22, linePool: POOL }) };
    const size = (strings: number) => {
      const launcher = k(), agent = k(), mint = k();
      const ixs = c.pumpLaunchMain({ launcher, agent, agentMint: mint, line: { mint: LINE, tokenProgram: T22, pool: POOL }, name: "n".repeat(32), symbol: "s".repeat(13), uri: "u".repeat(200),
        args: { repoUrl: "r".repeat(strings - 245), identityMode: 1, hosted: true } });
      return c.wireSize(c.compileMessageV0(launcher, [...budget, ...ixs], "11111111111111111111111111111111", [t]));
    };
    expect(c.maxLaunchStrings(true)).toBe(c.MAX_LAUNCH_STRINGS_POOL);
    expect(c.maxLaunchStrings(false)).toBe(c.MAX_LAUNCH_STRINGS);
    expect(size(c.MAX_LAUNCH_STRINGS_POOL)).toBe(c.PACKET_LIMIT);
    expect(size(c.MAX_LAUNCH_STRINGS_POOL + 1)).toBeGreaterThan(c.PACKET_LIMIT);
  });
  test("the quote coin on its PumpSwap pool, bought with SOL inside the launch: three transactions (the pool purchase names nine accounts the frozen table does not hold)", () => {
    const POOL = { pool: k(), baseVault: k(), quoteVault: k() };
    const t = { address: k(), addresses: c.launchTableAddresses({ lineMint: LINE, lineTokenProgram: T22, linePool: POOL }) };
    const strings = 20 + 5 + c.coinMetadataUriBytes("https://app.units.gg", true, true) + 33;
    const { launcher, agent, mint, g } = groups({ strings, tip: true });
    const buy = c.pumpSolToLinePool({ launcher, lineMint: LINE, pool: POOL.pool, amountOut: 2_400_000_000n, maxSolIn: 50_000_000n, rentToken: 2_039_280n });
    const withPool = c.pumpLaunchMain({ launcher, agent, agentMint: mint, line: { mint: LINE, tokenProgram: T22, pool: POOL }, name: "N".repeat(20), symbol: "TMBPE",
      uri: "u".repeat(c.coinMetadataUriBytes("https://app.units.gg", true, true)), args: { repoUrl: "https://github.com/karpathy/minbpe", identityMode: 1, hosted: true } });
    const gs = g.map((x) => (x.name === "launch" ? { ...x, ixs: withPool } : x.name === "sol-to-units" ? { ...x, ixs: buy } : x));
    const txs = c.planLaunchBundle({ payer: launcher, groups: gs, budget, table: t, v0: true });
    expect(txs.map((x) => x.groups)).toEqual([["launch", "soul"], ["sol-to-units", "initial-buy"], ["credits", "units-account", "tip"]]);
    for (const x of txs) expect(x.size).toBeLessThanOrEqual(c.PACKET_LIMIT);
    expect(txs.length).toBeLessThanOrEqual(c.JITO_MAX_TXS);
    // the purchase and everything after it do not fit one packet, with or without the units account payment
    const rest = gs.filter((x) => !["launch", "soul"].includes(x.name)).flatMap((x) => x.ixs);
    expect(c.wireSize(c.compileMessageV0(launcher, [...budget, ...rest], "11111111111111111111111111111111", [t]))).toBeGreaterThan(c.PACKET_LIMIT);
    console.log(`measured, quote coin on its pool, bought with SOL: ${txs.map((x) => `${x.groups.join("+")} ${x.size} bytes${x.table ? " (v0)" : ""}`).join("; ")}; purchase onward as one v0 transaction ${c.wireSize(c.compileMessageV0(launcher, [...budget, ...rest], "11111111111111111111111111111111", [t]))} bytes`);
    // the builder: the launcher's $UNITS account, a temporary wrapped SOL account holding rent + the bound, buy_v2, close
    expect(buy.length).toBe(5);
    const temp = c.launchTempWsol(launcher);
    expect(temp).toBe(c.seededAddress(launcher, c.LAUNCH_WSOL_SEED, c.TOKEN_PROGRAM));
    expect(buy[1]!.programId).toBe(c.SYSTEM_PROGRAM);
    expect(buy[1]!.keys.map((m) => m.pubkey)).toEqual([launcher, temp]);
    expect(new DataView(buy[1]!.data.buffer, buy[1]!.data.byteOffset).getUint32(0, true)).toBe(3);
    const seedLen = c.LAUNCH_WSOL_SEED.length;
    expect(new DataView(buy[1]!.data.buffer, buy[1]!.data.byteOffset).getBigUint64(4 + 32 + 8 + seedLen, true)).toBe(2_039_280n + 50_000_000n);
    expect(buy[3]!.programId).toBe(c.PUMP.amm);
    expect(buy[3]!.keys[0]!.pubkey).toBe(POOL.pool);
    expect(buy[3]!.keys[5]!.pubkey).toBe(c.ata(launcher, LINE, T22));
    expect(buy[3]!.keys[6]!.pubkey).toBe(temp);
    const d = new DataView(buy[3]!.data.buffer, buy[3]!.data.byteOffset);
    expect([d.getBigUint64(8, true), d.getBigUint64(16, true)]).toEqual([2_400_000_000n, 50_000_000n]);
    expect(buy[4]!.keys.map((m) => m.pubkey)).toEqual([temp, launcher, launcher]);
    expect(Array.from(buy[4]!.data)).toEqual([9]);
    // only the launcher signs the purchase
    expect([...new Set(buy.flatMap((ix) => ix.keys.filter((m) => m.isSigner).map((m) => m.pubkey)))]).toEqual([launcher]);
  });
  test("the longest strings: still one approval, three transactions in order", () => {
    const { launcher, g } = groups({ strings: c.MAX_LAUNCH_STRINGS });
    const txs = c.planLaunchBundle({ payer: launcher, groups: g, budget, table: table(), v0: true });
    expect(txs.length).toBeLessThanOrEqual(3);
    expect(txs.flatMap((t) => t.groups)).toEqual(["launch", "soul", "sol-to-units", "initial-buy", "credits", "units-account"]);
    for (const t of txs) expect(t.size).toBeLessThanOrEqual(c.PACKET_LIMIT);
  });
  test("the units account payment rides in the funding transaction, never twice", () => {
    const { launcher, g } = groups();
    const txs = c.planLaunchBundle({ payer: launcher, groups: g, budget, table: table(), v0: true });
    const transfers = txs.flatMap((t) => t.ixs).filter((ix) => ix.programId === c.SYSTEM_PROGRAM && ix.keys[1]!.pubkey === RECIPIENT);
    expect(transfers.length).toBe(1);
    expect(new DataView(transfers[0]!.data.buffer, transfers[0]!.data.byteOffset).getBigUint64(4, true)).toBe(50_000_000n);
  });
  test("without the units account, no transfer; mainnet tip fits the last transaction", () => {
    const { launcher, g } = groups({ identity: false, tip: true });
    const txs = c.planLaunchBundle({ payer: launcher, groups: g, budget, table: table(), v0: true });
    expect(txs.flatMap((t) => t.groups)).not.toContain("units-account");
    expect(txs[txs.length - 1]!.groups.at(-1)).toBe("tip");
    expect(txs.length).toBeLessThanOrEqual(c.JITO_MAX_TXS - 1); // room for the Jupiter swap in front
  });
  test("a group that cannot fit alone is a clear error; more than maxTxs refused", () => {
    const { launcher, g } = groups({ strings: c.MAX_LAUNCH_STRINGS + 1 });
    expect(() => c.planLaunchBundle({ payer: launcher, groups: g, budget, table: table(), v0: true })).toThrow(/launch alone is .* packet limit/);
    const ok = groups();
    expect(() => c.planLaunchBundle({ payer: ok.launcher, groups: ok.g, budget, table: table(), v0: true, maxTxs: 1 })).toThrow(/more than 1/);
  });
});

describe("SOL cost lines", () => {
  test("total and what the wallet must hold", () => {
    const x = c.launchSolCosts({ creation: 25_000_000n, credits: 7_000n, buy: 1_000_000n, identity: 50_000_000n, headroom: 10_070n });
    expect(x.total).toBe(76_007_000n);
    expect(x.needed).toBe(76_017_070n);
    expect(c.solShortfall(x, 76_017_070n)).toBeNull();
    expect(c.solShortfall(x, 76_017_069n)).toMatch(/needs 0.07601707 SOL/);
    expect(c.solShortfall(x, null)).toMatch(/not read/);
  });
  test("SOL bound of an exact-output buy rounds up", () => {
    expect(c.maxSolIn(1_000_000n, 100)).toBe(1_010_000n);
    expect(c.maxSolIn(1n, 100)).toBe(2n);
  });
  test("config: price default 0.03 SOL, recipient optional and checked", () => {
    const base = { min_usd: "10", default_usd: "10", line_per_usd: "20", rate_status: "test", compute_price_line_per_usd: "20", compute_price_line_per_sandbox_s: "0.002",
      sandbox_reserve_s: 600, attempt_max_usd: 0.5, since: 0 };
    const p = c.parsePrepayConfig(base);
    expect(p.identity_account_price_lamports).toBe("30000000");
    expect(p.identity_account_recipient).toBeNull();
    expect(c.parsePrepayConfig({ ...base, identity_account_recipient: RECIPIENT, identity_account_price_lamports: "60000000" }).identity_account_recipient).toBe(RECIPIENT);
    expect(() => c.parsePrepayConfig({ ...base, identity_account_recipient: "not an address" })).toThrow(/recipient/);
    expect(() => c.parsePrepayConfig({ ...base, identity_account_price_lamports: 5 })).toThrow(/lamports/);
  });
});

describe("units account payment check", () => {
  const launcher = k(), other = k();
  const view = (ixs: c.Ix[], payer = launcher, err: unknown = null): c.LaunchTxView => {
    const m = c.compileMessage(payer, ixs, "11111111111111111111111111111111");
    const keys = m.keys;
    return { signature: base58Encode(new Uint8Array(64).fill(ixs.length)), keys, err,
      instructions: ixs.map((ix) => ({ programIdIndex: keys.indexOf(ix.programId), accounts: ix.keys.map((x) => keys.indexOf(x.pubkey)), data: ix.data })) };
  };
  test("finds the launcher's transfer to the recipient and its amount", () => {
    const p = c.identityPaymentIn([view([c.system.transfer(launcher, RECIPIENT, 50_000_000n)])], { payer: launcher, recipient: RECIPIENT });
    expect(p.lamports).toBe(50_000_000n);
    expect(p.signatures.length).toBe(1);
  });
  test("ignores other recipients, other payers and failed transactions", () => {
    expect(c.identityPaymentIn([view([c.system.transfer(launcher, other, 50_000_000n)])], { payer: launcher, recipient: RECIPIENT }).lamports).toBe(0n);
    expect(c.identityPaymentIn([view([c.system.transfer(other, RECIPIENT, 50_000_000n)], other)], { payer: launcher, recipient: RECIPIENT }).lamports).toBe(0n);
    expect(c.identityPaymentIn([view([c.system.transfer(launcher, RECIPIENT, 50_000_000n)], launcher, { InstructionError: [0, "x"] })], { payer: launcher, recipient: RECIPIENT }).lamports).toBe(0n);
  });
});

describe("Jito helpers", () => {
  test("tip: a transfer to one tip account, at least 1,000 lamports", () => {
    const ix = c.jitoTipIx(launcherKey(), ["A1111111111111111111111111111111111111111111", "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"], 5_000n, () => 0.9);
    expect(ix.keys[1]!.pubkey).toBe("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5");
    expect(() => c.jitoTipIx(launcherKey(), ["96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"], 999n)).toThrow(/at least/);
  });
  test("tip floor: EMA of the landed median in lamports, never below the minimum", () => {
    expect(c.tipFromFloor([{ ema_landed_tips_50th_percentile: 4.940728596121156e-6 }])).toBe(4_941n);
    expect(c.tipFromFloor([{ ema_landed_tips_50th_percentile: 1e-7 }])).toBe(1_000n);
    expect(c.tipFromFloor(null)).toBe(1_000n);
  });
  test("sendJitoBundle: Landed returns, Failed throws, size checked", async () => {
    const calls: string[] = [];
    const rpc = (status: string) => ({ call: async (m: string) => (calls.push(m), m === "sendBundle" ? "b".repeat(64) : { value: [{ bundle_id: "b", status, landed_slot: 7 }] }) }) as unknown as c.Rpc;
    expect(await c.sendJitoBundle(rpc("Landed"), ["AA=="], { sleep: async () => {} })).toEqual({ bundleId: "b".repeat(64), slot: 7 });
    await expect(c.sendJitoBundle(rpc("Failed"), ["AA=="], { sleep: async () => {} })).rejects.toThrow(/nothing was committed/);
    await expect(c.sendJitoBundle(rpc("Landed"), [], {})).rejects.toThrow(/1 to 5/);
  });
});
function launcherKey() {
  return k();
}
