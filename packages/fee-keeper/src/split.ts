// The split of one collection. Integer lamports only, nothing rounded up: each share is the floor of
// its basis points, and the lamports no share can take (at most one for 5000/5000) stay in the fee
// reserve, so at 5000/5000 the two shares are equal to the lamport.

export interface Split {
  /** What the collection brought to the wallet, after its own transaction fee and any rent it paid. */
  net: bigint;
  /** Kept in the wallet to refill the fee reserve to its configured level. */
  reserve: bigint;
  /** Sent to the compute funding address. */
  compute: bigint;
  /** Spent on buying $UNITS, which is burned. */
  burn: bigint;
  /** Indivisible remainder, kept in the reserve (included in `reserve`). */
  dust: bigint;
}

/**
 * Splits `net` lamports: first the fee reserve is refilled from `reserveNow` to `reserveTarget`
 * (never more than `net`), then the rest goes `computeBps` to compute and `burnBps` to the buyback.
 * `net` at or below zero splits to nothing. reserve + compute + burn = net, always.
 */
export function splitCollected(net: bigint, o: { computeBps: number; burnBps: number; reserveTarget: bigint; reserveNow: bigint }): Split {
  if (!Number.isInteger(o.computeBps) || !Number.isInteger(o.burnBps) || o.computeBps < 0 || o.burnBps < 0 || o.computeBps + o.burnBps !== 10_000)
    throw new Error("compute_bps + burn_bps must be 10000");
  if (net <= 0n) return { net, reserve: 0n, compute: 0n, burn: 0n, dust: 0n };
  const missing = o.reserveTarget > o.reserveNow ? o.reserveTarget - o.reserveNow : 0n;
  const refill = missing < net ? missing : net;
  const rest = net - refill;
  const compute = (rest * BigInt(o.computeBps)) / 10_000n;
  const burn = (rest * BigInt(o.burnBps)) / 10_000n;
  const dust = rest - compute - burn;
  return { net, reserve: refill + dust, compute, burn, dust };
}

/** Token base units to ask for so that a buy priced at `quoteTokens` for `budget` still fills when the price is `slippageBps` worse. */
export const budgetBeforeSlippage = (budget: bigint, slippageBps: number): bigint => (budget * 10_000n) / (10_000n + BigInt(slippageBps));
