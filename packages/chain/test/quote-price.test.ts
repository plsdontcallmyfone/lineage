import { describe, expect, test } from "bun:test";
import { accountDisc, addressBytes, Writer, type Address } from "../src/codec.ts";
import { PUMP, pumpPdas } from "../src/pump.ts";
import { readJupiterUsd, readQuotePair } from "../src/quote-price.ts";

// The quote coin's price in its pair asset, read from accounts shaped like pump.fun's (owner
// 2026-10-12: every USD figure starts here). The accounts are built in the layouts pump.ts decodes.

const MINT = "C5dYJH9gpLkPrmbWatMhFj2mWGx9pvyRoUenJmFhL6br" as Address;
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
const ZERO = "11111111111111111111111111111111" as Address;
const KEY = "GZszrP1x9nQ5aRSuLz7n7Yxcd1gUQwyVqDqXnZHHj3dc" as Address;

function curve(o: { vt: bigint; vq: bigint; rt: bigint; rq: bigint; complete?: boolean; quoteMint?: Address }): Uint8Array {
  const w = new Writer().bytes(accountDisc("BondingCurve")).u64(o.vt).u64(o.vq).u64(o.rt).u64(o.rq).u64(1_000_000_000_000_000n).bool(!!o.complete)
    .bytes(addressBytes(KEY)).bool(false).bool(false).bytes(addressBytes(o.quoteMint ?? ZERO));
  return w.done();
}
function pool(base: Address, quote: Address, baseVault: Address, quoteVault: Address, virtualQuote = 0n): Uint8Array {
  return new Writer().bytes(accountDisc("Pool")).u8(255).u16(0).bytes(addressBytes(KEY)).bytes(addressBytes(base)).bytes(addressBytes(quote)).bytes(addressBytes(KEY))
    .bytes(addressBytes(baseVault)).bytes(addressBytes(quoteVault)).u64(0n).bytes(addressBytes(KEY)).bool(false).bool(false).u128(virtualQuote).done();
}
function tokenAccount(amount: bigint): Uint8Array {
  const d = new Uint8Array(165);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  return d;
}
function mint(decimals: number): Uint8Array {
  const d = new Uint8Array(82);
  d[44] = decimals;
  return d;
}
const rpcOf = (accs: Record<string, { data: Uint8Array; owner: string }>) => ({
  asked: [] as string[],
  async getMultipleAccounts(addrs: Address[]) {
    this.asked.push(...addrs);
    return addrs.map((a) => (accs[a] ? { data: accs[a]!.data, owner: accs[a]!.owner as Address } : null));
  },
});

describe("quote coin price from chain", () => {
  test("on its bonding curve: virtual quote over virtual base, in SOL for a SOL-paired coin", async () => {
    // 30 SOL virtual against 1,073,000,000 coins virtual (6 decimals)
    const rpc = rpcOf({ [pumpPdas.bondingCurve(MINT)]: { data: curve({ vt: 1_073_000_000_000_000n, vq: 30_000_000_000n, rt: 793_100_000_000_000n, rq: 0n }), owner: PUMP.program } });
    const p = await readQuotePair(rpc, MINT, 6);
    expect(p).toMatchObject({ pairMint: PUMP.wsol, pairDecimals: 9, venue: "curve", account: pumpPdas.bondingCurve(MINT) });
    expect(p.pairPerQuote).toBeCloseTo(30 / 1_073_000_000, 18);
  });

  test("a curve paired with another mint reads that mint's decimals", async () => {
    const rpc = rpcOf({
      [pumpPdas.bondingCurve(MINT)]: { data: curve({ vt: 1_000_000_000_000n, vq: 2_500_000n, rt: 1n, rq: 0n, quoteMint: USDC }), owner: PUMP.program },
      [USDC]: { data: mint(6), owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
    });
    const p = await readQuotePair(rpc, MINT, 6);
    expect(p).toMatchObject({ pairMint: USDC, pairDecimals: 6, venue: "curve" });
    expect(p.pairPerQuote).toBeCloseTo(2.5 / 1_000_000, 15);
  });

  test("after migration: the PumpSwap pool's vaults, the pool's virtual quote added", async () => {
    const BV = "5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD" as Address, QV = "9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7" as Address;
    const poolAddr = pumpPdas.pool(MINT, PUMP.wsol);
    const rpc = rpcOf({
      [pumpPdas.bondingCurve(MINT)]: { data: curve({ vt: 0n, vq: 0n, rt: 0n, rq: 0n, complete: true }), owner: PUMP.program },
      [poolAddr]: { data: pool(MINT, PUMP.wsol, BV, QV, 1_000_000_000n), owner: PUMP.amm },
      [BV]: { data: tokenAccount(200_000_000_000_000n), owner: "x" },
      [QV]: { data: tokenAccount(84_000_000_000n), owner: "x" },
    });
    const p = await readQuotePair(rpc, MINT, 6);
    expect(p).toMatchObject({ venue: "pool", account: poolAddr, pairMint: PUMP.wsol });
    expect(p.pairPerQuote).toBeCloseTo(85 / 200_000_000, 18);
  });

  test("no curve, an empty curve or a missing pool is an error with its reason, never a number", async () => {
    await expect(readQuotePair(rpcOf({}), MINT, 6)).rejects.toThrow(/no pump.fun bonding curve/);
    await expect(readQuotePair(rpcOf({ [pumpPdas.bondingCurve(MINT)]: { data: curve({ vt: 1n, vq: 1n, rt: 1n, rq: 0n }), owner: "SomeoneElse1111111111111111111111111111111" } }), MINT, 6)).rejects.toThrow(/no pump.fun bonding curve/);
    const migrated = { [pumpPdas.bondingCurve(MINT)]: { data: curve({ vt: 0n, vq: 0n, rt: 0n, rq: 0n, complete: true }), owner: PUMP.program } };
    await expect(readQuotePair(rpcOf(migrated), MINT, 6)).rejects.toThrow(/PumpSwap pool could not be read/);
  });
});

describe("Jupiter USD price", () => {
  const f = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  test("the mint's usdPrice and block", async () => {
    expect(await readJupiterUsd(f({ [PUMP.wsol]: { usdPrice: 112.18, blockId: 77 } }), PUMP.wsol)).toEqual({ usd: 112.18, block: 77 });
  });
  test("an error status, a missing entry, zero or text is refused", async () => {
    await expect(readJupiterUsd(f({}, 503), PUMP.wsol)).rejects.toThrow(/HTTP 503/);
    for (const body of [{}, { [PUMP.wsol]: null }, { [PUMP.wsol]: { usdPrice: 0 } }, { [PUMP.wsol]: { usdPrice: "112" } }])
      await expect(readJupiterUsd(f(body), PUMP.wsol)).rejects.toThrow(/no usable price/);
  });
});
