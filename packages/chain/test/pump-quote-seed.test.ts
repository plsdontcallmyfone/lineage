import { describe, expect, test } from "bun:test";
import { pumpQuotedCurve, type BondingCurve, type PumpGlobal } from "../src/index.ts";

// Measured on devnet 2026-10-10 (devnet v2 relaunch): Global and the tLINE curve at the TMBPE launch;
// the launch's buy_v3 asked exactly the quote of a curve seeded at 329,097,379,248,143.
const g = { initialVirtualTokenReserves: 1_073_000_000_000_000n, initialVirtualSolReserves: 1_000_000_000n, initialRealTokenReserves: 793_100_000_000_000n,
  initialVirtualQuoteReserves: 4_292_000n, tokenTotalSupply: 1_000_000_000_000_000n } as unknown as PumpGlobal;
const line = { virtualTokenReserves: 594_240_261_698_183n, virtualQuoteReserves: 1_805_666_952n, quoteMint: "11111111111111111111111111111111", depth: 0,
  isMayhemMode: false, complete: false, realTokenReserves: 314_340_261_698_183n } as unknown as BondingCurve;
const C = "5uUyWAc9DQEWb3XF1aH8yG62sCjmrEjtAoRB1SD9JFqV", M = "CiBfnTkDc1vgYbuMobMNEQaKSQXPYeTUbZGRZcug1L62";

describe("pumpQuotedCurve seed rule (profile pump_quote_seed)", () => {
  test("spot (devnet's build): target x $LINE base / $LINE quote", () => {
    expect(pumpQuotedCurve(g, { curve: line }, C, M, 0n, "spot").virtualQuoteReserves).toBe(329_097_379_248_143n);
  });
  test("swap (mainnet's build, the default) stays as proven on the fork", () => {
    const swap = pumpQuotedCurve(g, { curve: line }, C, M).virtualQuoteReserves;
    expect(swap).toBe(pumpQuotedCurve(g, { curve: line }, C, M, 0n, "swap").virtualQuoteReserves);
    expect(swap).toBe(128_091_688_600_080n);
  });
});
