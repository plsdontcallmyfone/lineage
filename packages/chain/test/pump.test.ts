// pump.ts against bytes mainnet's pump.fun programs wrote on the mainnet fork (fixtures/pump-fork.json,
// recorded from scripts/mainnet/pump-fork-proof.ts): account decoders, the offsets lineage_launch
// reads, event decoding of the self-CPI events, fee schedules, PDAs and the quote math.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { base58Decode } from "@lineage/protocol";
import * as c from "../src/index.ts";

const fx = JSON.parse(readFileSync(new URL("./fixtures/pump-fork.json", import.meta.url), "utf8"));
const b64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));
const events = (step: string) => (fx.events[step] as string[]).map((d) => c.decodePumpEvent(base58Decode(d))).filter((e): e is c.PumpEvent => e !== null);
const { line, a1, a2 } = fx.mints;

describe("pump.fun accounts", () => {
  test("Global: mainnet values read 2026-10-10 (create_v2 enabled, max_curve_depth 1, configurable creator fee up to 300 bps)", () => {
    const g = c.decodePumpGlobal(b64(fx.accounts.global));
    expect([g.createV2Enabled, g.maxCurveDepth, g.creatorFeeConfigurable, g.maxConfigurableCreatorFeeBps]).toEqual([true, 1, true, 300n]);
    expect([g.tokenTotalSupply, g.initialRealTokenReserves, g.initialVirtualTokenReserves]).toEqual([1_000_000_000_000_000n, 793_100_000_000_000n, 1_073_000_000_000_000n]);
    expect(g.buybackFeeRecipients).toEqual([...c.PUMP.buybackRecipients]);
  });
  test("BondingCurve: an agent coin quoted in $LINE with our creator PDA, depth 1, at the offsets lineage_launch reads", () => {
    const d = b64(fx.accounts.a1_curve);
    const k = c.decodeBondingCurve(d);
    expect([k.quoteMint, k.creator, k.depth, k.isMayhemMode, k.isCashbackCoin, k.isHolderReward, k.creatorFeeBps]).toEqual([line, fx.creator_pdas.a1, 1, false, false, false, 0n]);
    expect(d.length).toBe(c.BONDING_CURVE_OFFSETS.end);
    const O = c.BONDING_CURVE_OFFSETS;
    expect(c.toAddress(d.subarray(O.creator, O.creator + 32))).toBe(k.creator);
    expect(c.toAddress(d.subarray(O.quoteMint, O.quoteMint + 32))).toBe(line);
    expect(d[O.depth]).toBe(1);
  });
  test("a migrated curve reads as migrated; its PumpSwap pool carries our creator PDA and the $LINE quote", () => {
    expect(c.curveMigrated(c.decodeBondingCurve(b64(fx.accounts.a2_curve)))).toBe(true);
    const p = c.decodePumpPool(b64(fx.accounts.a2_pool));
    expect([p.index, p.creator, p.baseMint, p.quoteMint, p.coinCreator]).toEqual([0, c.pumpPdas.poolAuthority(a2), a2, line, fx.creator_pdas.a2]);
    const lp = c.decodePumpPool(b64(fx.accounts.line_pool));
    expect([lp.baseMint, lp.quoteMint]).toEqual([line, c.PUMP.wsol]);
  });
  test("fee configs: custom pairs pay the flat exotic row (curve 95 + 30 bps, pool 20 LP + 5 + 5)", () => {
    const fc = c.decodePumpFeeConfig(b64(fx.accounts.fee_config));
    expect(c.pumpFeeSchedule(fc, line, 0n)).toEqual({ lpFeeBps: 0n, protocolFeeBps: 95n, creatorFeeBps: 30n });
    const afc = c.decodePumpFeeConfig(b64(fx.accounts.amm_fee_config));
    expect(c.pumpFeeSchedule(afc, line, 0n)).toEqual({ lpFeeBps: 20n, protocolFeeBps: 5n, creatorFeeBps: 5n });
  });
});

describe("pump.fun events", () => {
  test("launch: CreateEvent names our creator PDA and depth 1; the initial buy's TradeEvent keeps its fees on the curve (v3)", () => {
    const e = events("2");
    const create = e.find((x) => x.name === "CreateEvent")!;
    expect([create.fields.creator, create.fields.quote_mint, create.fields.depth]).toEqual([fx.creator_pdas.a1, line, 1]);
    const t = e.find((x) => x.name === "TradeEvent")!;
    // TRADE_V3.md says ix_name is "buy_v3"; mainnet's build (2026-10-10) writes "buy", so v3 is told by the zero fee_recipient
    expect([t.fields.ix_name, t.fields.is_buy, t.fields.token_amount, t.fields.quote_mint, t.fields.fee_recipient]).toEqual(["buy", true, 10_000_000_000_000n, line,
      "11111111111111111111111111111111"]);
  });
  test("v3 trades keep the fees on the curve: fee_recipient is the zero key, creator_fee_unclaimed grows", () => {
    const t = events("3a").find((x) => x.name === "TradeEvent")!;
    expect(t.fields.fee_recipient).toBe("11111111111111111111111111111111");
    expect((t.fields.creator_fee as bigint) > 0n).toBe(true);
  });
  test("multi-hop: two TradeEvents, protocol fee on the SOL hop only, creator fee on the agent hop only", () => {
    const t = events("3d").filter((x) => x.name === "TradeEvent");
    expect(t.map((x) => x.fields.ix_name)).toEqual(["multi_hop_swap", "multi_hop_swap"]);
    expect(t.find((x) => x.fields.mint === line)!.fields.creator_fee).toBe(0n);
    expect(t.find((x) => x.fields.mint === a1)!.fields.fee).toBe(0n);
  });
  test("the completing buy emits TradeEvent, CompleteEvent, PostCompleteBuyEvent", () => {
    const names = events("6a").map((e) => e.name);
    expect(names.slice(names.indexOf("TradeEvent"))).toEqual(["TradeEvent", "CompleteEvent", "PostCompleteBuyEvent"]);
  });
  test("sweeps: bucket 1 to the creator vault, then the collect; pool sweep to the AMM creator vault", () => {
    const s = events("4").find((x) => x.name === "SweepBondingCurveFeeEvent")!;
    expect([s.fields.bucket, s.fields.recipient]).toEqual([1, c.pumpPdas.creatorVault(fx.creator_pdas.a1)]);
    const p = events("9d").find((x) => x.name === "SweepPoolFeeEvent")!;
    expect([p.fields.bucket, p.fields.recipient]).toEqual([1, c.pumpPdas.ammCreatorVault(fx.creator_pdas.a2)]);
    const buys = events("9a").filter((x) => x.name === "BuyEvent");
    expect(buys[0]!.fields.coin_creator).toBe(fx.creator_pdas.a2);
  });
  test("unknown data is not an event", () => {
    expect(c.decodePumpEvent(new Uint8Array(20))).toBeNull();
  });
});

describe("pump.fun builders", () => {
  test("PDAs equal the documented addresses", () => {
    expect(c.pda(c.PUMP.program, "global")).toBe(c.PUMP.global);
    expect(c.pumpPdas.eventAuthority()).toBe(c.PUMP.eventAuthority);
    expect(c.pda(c.PUMP.program, "quote-control")).toBe(c.PUMP.quoteControl);
    expect(c.pda(c.PUMP.fees, "fee_config", c.addressBytes(c.PUMP.program))).toBe(c.PUMP.feeConfig);
    expect(c.pda(c.PUMP.fees, "fee_config", c.addressBytes(c.PUMP.amm))).toBe(c.PUMP.ammFeeConfig);
    expect(c.pda(c.PUMP.amm, "global_config")).toBe(c.PUMP.ammGlobalConfig);
  });
  test("create_v2 data: never mayhem, cashback false, the configured creator fee, no holder rewards; pump-coin quote accounts", () => {
    const ix = c.createV2({ mint: a1, user: line, creator: fx.creator_pdas.a1, name: "N", symbol: "S", uri: "u", quote: { kind: "pumpCoin", mint: line }, creatorFeeBps: 0n });
    const d = ix.data;
    const tail = d.subarray(d.length - 1 - 8 - 1 - 1 - 32);
    expect(c.toAddress(tail.subarray(0, 32))).toBe(fx.creator_pdas.a1);
    expect([...tail.subarray(32)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(ix.keys.length).toBe(16 + 5);
    expect(ix.keys[16 + 3]!.pubkey).toBe(c.PUMP.quoteControl);
    expect(ix.keys[16 + 4]!.pubkey).toBe(c.pumpPdas.bondingCurve(line));
    expect(() => c.createV2({ mint: a1, user: line, creator: line, name: "N".repeat(33), symbol: "S", uri: "u", quote: { kind: "sol" } })).toThrow();
  });
  test("the crank harvest: curve sweep + collect, and the pool's once graduated, before crank_pump_fees", () => {
    const ixs = c.pumpCrankIxs({ payer: line, agent: a1, agentMint: a1, lineMint: line, pool: c.pumpPdas.pool(a1, line) });
    expect(ixs.map((x) => x.programId)).toEqual([c.ASSOCIATED_TOKEN_PROGRAM, c.PUMP.program, c.PUMP.program, c.PUMP.amm, c.PUMP.amm, c.LAUNCH_PROGRAM_ID]);
    expect(ixs[0]!.keys[1]!.pubkey).toBe(c.ata(c.launchPdas.pumpCreator(a1), line, c.TOKEN_2022_PROGRAM));
  });
  test("quote math: the seed of a coin quoted in $LINE on its curve, and the 1% initial buy's quote", () => {
    const g = c.decodePumpGlobal(b64(fx.accounts.global));
    const fc = c.decodePumpFeeConfig(b64(fx.accounts.fee_config));
    const lineCurve: c.BondingCurve = { ...c.decodeBondingCurve(b64(fx.accounts.a1_curve)), quoteMint: "11111111111111111111111111111111", depth: 0,
      virtualTokenReserves: g.initialVirtualTokenReserves, virtualQuoteReserves: g.initialVirtualSolReserves, complete: false };
    const fresh = c.pumpQuotedCurve(g, { curve: lineCurve }, fx.creator_pdas.a1, line);
    // a fresh $LINE: the reference raise buys the curve's real reserves exactly, scaled back to the seed
    expect(fresh.virtualQuoteReserves > 0n && fresh.realTokenReserves === g.initialRealTokenReserves).toBe(true);
    const q = c.quoteInitialBuy(g, fc, fresh, c.initialBuyAmount(g.tokenTotalSupply, 100));
    const net = (10_000_000_000_000n * fresh.virtualQuoteReserves) / (fresh.virtualTokenReserves - 10_000_000_000_000n) + 1n;
    expect(q).toBe(net + (net * 95n + 9_999n) / 10_000n + (net * 30n + 9_999n) / 10_000n);
  });
});
