import { describe, expect, test } from "bun:test";
import { ata, moveLaunchHolding, TOKEN_2022_PROGRAM } from "../src/index.ts";

const AGENT = "5iCWSoXAsvhdDiwsexnuAXU3RcNXgbXw7TzuRZH2LYoA", RT = "HkJd72ewk3AMzNm2cabSSdACtn8fxut17wcEQ2hUytu4";
const MINT = "CiBfnTkDc1vgYbuMobMNEQaKSQXPYeTUbZGRZcug1L62", PAYER = "FKQBjvfwfbwSynjRE8mT1ijSEc34JamjK1R3AgtvzYji";

describe("moveLaunchHolding (LAUNCH-FRONTING D3)", () => {
  test("creates the runtime key's account and moves the whole holding, signed by the agent key, paid by the launcher", () => {
    const ixs = moveLaunchHolding({ payer: PAYER, agentKey: AGENT, treasury: RT, agentMint: MINT, amount: 10_000_000_000_000n, decimals: 6 });
    expect(ixs.length).toBe(2);
    const [create, move] = ixs;
    expect(create!.keys[0]).toEqual({ pubkey: PAYER, isSigner: true, isWritable: true });
    expect(create!.keys.map((k) => k.pubkey)).toContain(RT);
    expect(move!.programId).toBe(TOKEN_2022_PROGRAM);
    expect(move!.keys.map((k) => k.pubkey)).toEqual([ata(AGENT, MINT, TOKEN_2022_PROGRAM), MINT, ata(RT, MINT, TOKEN_2022_PROGRAM), AGENT]);
    expect(move!.keys[3]!.isSigner).toBe(true);
    expect(move!.keys.some((k) => k.pubkey === RT && k.isSigner)).toBe(false);
    // transfer_checked: tag 12, amount u64 LE, decimals
    expect(move!.data[0]).toBe(12);
    expect(new DataView(move!.data.buffer, move!.data.byteOffset + 1, 8).getBigUint64(0, true)).toBe(10_000_000_000_000n);
    expect(move!.data[9]).toBe(6);
  });
  test("refuses an empty holding and a treasury that is the agent key", () => {
    expect(() => moveLaunchHolding({ payer: PAYER, agentKey: AGENT, treasury: RT, agentMint: MINT, amount: 0n, decimals: 6 })).toThrow(/empty/);
    expect(() => moveLaunchHolding({ payer: PAYER, agentKey: AGENT, treasury: AGENT, agentMint: MINT, amount: 1n, decimals: 6 })).toThrow(/already/);
  });
});
