import { describe, expect, test } from "bun:test";
import {
  damm,
  dammPdas,
  dbc,
  decodeDammPool,
  decodeDammPosition,
  launchPdas,
  METEORA,
  setTokenAccountOwner,
  sha256,
  TOKEN_2022_PROGRAM,
} from "../src/index.ts";

// The graduation builders (launchpad L1). Account order follows DBC release_0.2.2 `MigrateDammV2Ctx`
// and the DAMM v2 IDL; the same calls ran on devnet in scripts/devnet/graduation-e2e.ts (onchain/DEVNET.md).
const disc = (n: string) => Array.from(sha256(`global:${n}`).subarray(0, 8));
const MINT = "AbBT1Mh3mQJgMfVVfKj8zUZhD4mLw5NqbJptFUacb9Zz";
const LINE = "3PLqpwWokAbpxZgBVLAzMAeLSvzfoDvjkhH9YydwVXmU";
const CONFIG = "AEcaMdhK3PSqPDq2rrXZMoKsCPCTVTMdqJXaT34mWWGw";
const PAYER = "CVEZWyUBoNb6Zkte3qa7JDu5TBV4wTH6wMw4pLodnDih";
const N1 = "Dd6MS4NJLzHUHM17Gr9yAsDLEqJSKbmuNKMZ18osnpqr";
const N2 = "7UzD2gGSFRN5VXMXvwuChKZckQFHobSsDryiErhSjCm2";

describe("graduation builders", () => {
  test("migration_damm_v2: 26 accounts, three signers, the DAMM v2 pool and positions devnet created", () => {
    const pool = launchPdas.dbcPool(CONFIG, MINT, LINE);
    const ix = dbc.migrationDammV2({ dbcPool: pool, dbcConfig: CONFIG, agentMint: MINT, lineMint: LINE, firstNftMint: N1, secondNftMint: N2, payer: PAYER,
      lineTokenProgram: TOKEN_2022_PROGRAM });
    expect(ix.programId).toBe(METEORA.dbcProgram);
    expect(Array.from(ix.data)).toEqual(disc("migration_damm_v2"));
    expect(ix.keys.length).toBe(26);
    expect(ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey)).toEqual([N1, N2, PAYER]);
    expect(ix.keys[1]!.pubkey).toBe(METEORA.dbcProgram); // migration_metadata: None
    // Read back from devnet on 2026-10-09 (run 20261009152905).
    expect(ix.keys[4]!.pubkey).toBe("6mNHiH2MzGD4bHFMkB8R6aGTLAR2D1ovcFRVMqUFfvkp");
    expect(dammPdas.position(N1)).toBe("CC4ZQFcsDBKfCqNXipEnvTy77EGQjkERWmpNU1qaZoM2");
    expect(ix.keys[7]!.pubkey).toBe(dammPdas.position(N1));
    expect(ix.keys[25]!.pubkey).toBe(METEORA.dammDynamicConfig);
  });

  test("DBC swap2 carries the swap mode", () => {
    const pool = launchPdas.dbcPool(CONFIG, MINT, LINE);
    const base = { config: CONFIG, pool, agentMint: MINT, lineMint: LINE, trader: PAYER, lineAccount: PAYER, agentAccount: PAYER, buy: true, amountIn: 5n, minOut: 1n };
    expect(dbc.swap(base).data.at(-1)).toBe(0);
    expect(dbc.swap({ ...base, mode: 1 }).data.at(-1)).toBe(1);
  });

  test("DAMM v2 calls: discriminators, argument sizes, signers", () => {
    const pool = launchPdas.dammPool(MINT, LINE);
    const s = damm.swap({ pool, agentMint: MINT, lineMint: LINE, trader: PAYER, lineAccount: PAYER, agentAccount: PAYER, buy: true, amountIn: 1n, minOut: 0n });
    expect(Array.from(s.data.subarray(0, 8))).toEqual(disc("swap2"));
    expect(s.data.length).toBe(8 + 8 + 8 + 1);
    expect(s.keys.length).toBe(14);
    const c = damm.createPosition({ owner: PAYER, nftMint: N1, pool, payer: PAYER });
    expect(c.keys.filter((k) => k.isSigner).map((k) => k.pubkey)).toEqual([N1, PAYER]);
    const a = damm.addLiquidity({ pool, nftMint: N1, owner: PAYER, agentMint: MINT, lineMint: LINE, agentAccount: PAYER, lineAccount: PAYER, liquidity: 1n << 100n,
      maxAgent: 7n, maxLine: 9n });
    expect(a.data.length).toBe(8 + 16 + 8 + 8);
    expect(a.keys.length).toBe(14);
    const l = damm.permanentLock({ pool, nftMint: N1, owner: PAYER, liquidity: 3n });
    expect(Array.from(l.data.subarray(0, 8))).toEqual(disc("permanent_lock_position"));
    expect(l.data.length).toBe(24);
    const o = setTokenAccountOwner(dammPdas.positionNftAccount(N1), PAYER, PAYER);
    expect(Array.from(o.data.subarray(0, 3))).toEqual([6, 2, 1]);
    expect(o.data.length).toBe(35);
  });

  test("DAMM v2 pool and position decoders read the launch program's offsets", () => {
    const pool = new Uint8Array(1112);
    pool.set(new Uint8Array(32).fill(1), 168);
    new DataView(pool.buffer).setBigUint64(360 + 8, 2n, true);
    new DataView(pool.buffer).setBigUint64(552, 5n, true);
    const p = decodeDammPool(pool);
    expect(p.liquidity).toBe(2n << 64n);
    expect(p.permanentLockLiquidity).toBe(5n);
    const pos = new Uint8Array(408);
    new DataView(pos.buffer).setBigUint64(184, 9n, true);
    expect(decodeDammPosition(pos).permanentLockedLiquidity).toBe(9n);
  });
});
