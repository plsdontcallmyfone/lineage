import type { Address } from "./codec.ts";
import { curveMigrated, curveQuoteMint, decodeBondingCurve, decodePumpPool, PUMP, pumpPdas } from "./pump.ts";
import { decodeMint, decodeTokenAccount } from "./spl.ts";

// The quote coin's price, for every USD figure the app shows (owner 2026-10-12: "everything needs to
// be denominated in USD"). Two readings, both stated facts, nothing modelled:
//
//   1. what one quote coin costs in the asset its own pump.fun market is paired with (SOL, or another
//      mint): read from chain, from its bonding curve until it migrates and from its canonical PumpSwap
//      pool after. The same reserves pumpQuotedCurve (pump-launch.ts) prices a launch with, and the
//      same formula the indexer prices an agent token with: virtual quote over virtual base on the
//      curve, (quote vault + the pool's virtual quote) over the base vault in the pool.
//   2. what that pair asset costs in US dollars: Jupiter Price API V3, the source /chain/sol-price
//      already uses for SOL (developers.jup.ag/docs/price, read 2026-10-10; keyless).
//
// Nothing here depends on which coin is the quote: it takes a mint. No fees, no slippage: a spot
// price, not what a trade of any size would pay.

export const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";

export interface QuotePair {
  /** the asset the quote coin's own market is paired with (WSOL for a SOL coin) */
  pairMint: Address;
  pairDecimals: number;
  /** where the price was read */
  venue: "curve" | "pool";
  /** the account the reserves were read from (the bonding curve, or the PumpSwap pool) */
  account: Address;
  /** pair asset per one quote coin, both in UI units */
  pairPerQuote: number;
}

interface AccountsReader {
  getMultipleAccounts(addresses: Address[]): Promise<({ data: Uint8Array; owner: Address } | null)[]>;
}

/** Reads what one quote coin costs in its pair asset from its pump.fun curve, or its PumpSwap pool once migrated. Throws with the reason when it cannot. */
export async function readQuotePair(rpc: AccountsReader, mint: Address, decimals: number): Promise<QuotePair> {
  const curveAddr = pumpPdas.bondingCurve(mint);
  const [curveA] = await rpc.getMultipleAccounts([curveAddr]);
  if (!curveA || curveA.owner !== PUMP.program) throw new Error("the quote coin has no pump.fun bonding curve on this cluster");
  const c = decodeBondingCurve(curveA.data);
  const pairMint = curveQuoteMint(c);
  const migrated = curveMigrated(c);
  const poolAddr = pumpPdas.pool(mint, pairMint);
  const [pairA, poolA] = await rpc.getMultipleAccounts([pairMint, ...(migrated ? [poolAddr] : [])]);
  const pairDecimals = pairMint === PUMP.wsol ? 9 : pairA ? decodeMint(pairA.data).decimals : null;
  if (pairDecimals === null) throw new Error("the quote coin's pair mint could not be read");
  const ui = (base: bigint, quote: bigint) => Number(quote) / 10 ** pairDecimals / (Number(base) / 10 ** decimals);
  if (!migrated) {
    if (c.virtualTokenReserves <= 0n || c.virtualQuoteReserves <= 0n) throw new Error("the quote coin's bonding curve holds no reserves");
    return { pairMint, pairDecimals, venue: "curve", account: curveAddr, pairPerQuote: ui(c.virtualTokenReserves, c.virtualQuoteReserves) };
  }
  if (!poolA || poolA.owner !== PUMP.amm) throw new Error("the quote coin has migrated and its PumpSwap pool could not be read");
  const p = decodePumpPool(poolA.data);
  const [baseA, quoteA] = await rpc.getMultipleAccounts([p.poolBaseTokenAccount, p.poolQuoteTokenAccount]);
  if (!baseA || !quoteA) throw new Error("the quote coin's PumpSwap pool vaults could not be read");
  const base = decodeTokenAccount(baseA.data).amount;
  const quote = decodeTokenAccount(quoteA.data).amount + p.virtualQuoteReserves;
  if (base <= 0n || quote <= 0n) throw new Error("the quote coin's PumpSwap pool holds no reserves");
  return { pairMint, pairDecimals, venue: "pool", account: poolAddr, pairPerQuote: ui(base, quote) };
}

/** One mint's USD price from Jupiter Price API V3. Throws when Jupiter gives no usable number. */
export async function readJupiterUsd(f: typeof fetch, mint: string, timeoutMs = 8_000): Promise<{ usd: number; block: number }> {
  const r = await f(`${JUPITER_PRICE_API}?ids=${mint}`, { signal: AbortSignal.timeout(timeoutMs) } as RequestInit);
  if (!r.ok) throw new Error(`Jupiter answered HTTP ${r.status}`);
  const e = ((await r.json()) as Record<string, { usdPrice?: unknown; blockId?: unknown } | null>)?.[mint];
  const usd = e?.usdPrice;
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) throw new Error("Jupiter gave no usable price");
  return { usd, block: Number(e?.blockId ?? 0) };
}
