import { decodeMint } from "../../../packages/chain/src/spl.ts";

/**
 * Decimals the trade box scales amounts with: the mint account's own, read from chain (audit A2
 * OFF-W1). The indexer's `decimals` is only compared: a wrong value there used to turn "1" into 1000
 * tokens on the wire and on the review screen alike.
 */
export function tradeDecimals(mintData: Uint8Array | null | undefined, indexerDecimals: number): number {
  if (!mintData) throw new Error("The token's mint account was not found on devnet.");
  let d: number;
  try {
    d = decodeMint(mintData).decimals;
  } catch {
    throw new Error("The token's mint account could not be read.");
  }
  if (d !== indexerDecimals) console.warn(`trade: mint decimals ${d} differ from the indexer's ${indexerDecimals}; using the mint's`);
  return d;
}
