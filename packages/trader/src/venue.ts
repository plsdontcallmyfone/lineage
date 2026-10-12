import type { TokenView } from "./policy.ts";

// Where trades execute. `SimVenue` is the simulated market (constant-product pools with a flat fee,
// the shape of a bonding curve segment and a pool); `ChainVenue` (chain-venue.ts) trades on pump.fun's
// bonding curve before graduation and its PumpSwap pool after, simulating every transaction first.

export interface Quote {
  /** simulated output of the exact trade, base units */
  out: bigint;
  /** execution price against the marginal price (a small probe), bps */
  impact_bps: number;
  venue: "pump_curve" | "pump_pool" | "sim";
  /** the probe behind impact_bps (a small trade's input and simulated output): the marginal price at quote time */
  probe?: { in: bigint; out: bigint };
}

/** What a venue re-checks right before it sends (docs/plans/AGENT-WALLET-SAFETY.md "Risk management", pre-trade checks). */
export interface PreTrade {
  /** the quote this trade was decided on */
  quote: Quote;
  /** the fresh simulation must be within this of the quote, bps */
  sim_tolerance_bps: number;
  /** the marginal price must be within this of the quote's, bps */
  state_drift_bps: number;
}

/** A pre-trade check failed: nothing was signed or sent. */
export class PreTradeRefusal extends Error {
  constructor(readonly rule: "sim_mismatch" | "state_drift", readonly detail: string) {
    super(`${rule}: ${detail}`);
  }
}

/** The two comparisons, shared by every venue: fresh full-size output against the quote, fresh probe output against the quote's probe. */
export function preTradeCheck(pre: PreTrade, fresh: { out: bigint; probeOut: bigint | null }): void {
  const gap = (a: bigint, b: bigint) => (a > b ? a - b : b - a);
  // exact: |fresh - quoted| x 10,000 against quoted x bps (no rounding in the refusal's favour)
  const over = (a: bigint, b: bigint, bps: number) => (b === 0n ? a !== 0n : gap(a, b) * 10_000n > b * BigInt(bps));
  const bpsOf = (a: bigint, b: bigint) => (b === 0n ? "an unbounded number of" : ((gap(a, b) * 10_000n) / b).toString());
  if (pre.quote.probe && fresh.probeOut !== null && over(fresh.probeOut, pre.quote.probe.out, pre.state_drift_bps))
    throw new PreTradeRefusal("state_drift", `the marginal price moved ${bpsOf(fresh.probeOut, pre.quote.probe.out)} bps between the quote and the send (max ${pre.state_drift_bps})`);
  if (over(fresh.out, pre.quote.out, pre.sim_tolerance_bps))
    throw new PreTradeRefusal("sim_mismatch", `the simulation right before sending gives ${fresh.out}, the quote gave ${pre.quote.out} (tolerance ${pre.sim_tolerance_bps} bps)`);
}

export interface Fill {
  signature: string;
  amount_in: bigint;
  amount_out: bigint;
  /** lamports the treasury key paid in fees */
  fee_lamports: number;
  venue: "pump_curve" | "pump_pool" | "sim";
}

export interface Balances {
  line: bigint;
  sol: bigint;
  tokens: Map<string, bigint>;
}

export interface Venue {
  readonly kind: "chain" | "sim";
  /** what the treasury key holds: $UNITS, SOL and each agent token among `mints` */
  balances(owner: string, mints: string[]): Promise<Balances>;
  quote(owner: TraderKey, t: TokenView, side: "buy" | "sell", amountIn: bigint): Promise<Quote>;
  /** sends the trade with `minOut`; with `pre`, simulates again first and refuses (PreTradeRefusal) on a mismatch; resolves once confirmed */
  execute(owner: TraderKey, t: TokenView, side: "buy" | "sell", amountIn: bigint, minOut: bigint, pre?: PreTrade): Promise<Fill>;
}

/** The treasury key: an agent key the hosted runtime holds (packages/protocol AgentKey shape). */
export interface TraderKey {
  id: string;
  secret: Uint8Array;
}

// ------------------------------------------------------------------------------------------------

export interface SimPool {
  /** token base units in the pool */
  base: bigint;
  /** $UNITS base units in the pool */
  quote: bigint;
  fee_bps: number;
  decimals: number;
}

/** Constant-product pools; the fee is taken from the input, like a flat quote fee. */
export class SimVenue implements Venue {
  readonly kind = "sim" as const;
  readonly pools = new Map<string, SimPool>();
  readonly wallets = new Map<string, { line: bigint; sol: bigint; tokens: Map<string, bigint> }>();
  private n = 0;
  constructor(readonly lineDecimals = 6, readonly feeLamports = 5000) {}

  addPool(mint: string, p: SimPool) {
    this.pools.set(mint, { ...p });
  }
  fund(owner: string, line: bigint, sol = 1_000_000_000n) {
    const w = this.wallet(owner);
    w.line += line;
    w.sol += sol;
  }
  wallet(owner: string) {
    let w = this.wallets.get(owner);
    if (!w) this.wallets.set(owner, (w = { line: 0n, sol: 0n, tokens: new Map() }));
    return w;
  }
  /** tUNITS per whole token at the margin */
  price(mint: string): number | null {
    const p = this.pools.get(mint);
    if (!p || p.base === 0n) return null;
    return Number(p.quote) / 10 ** this.lineDecimals / (Number(p.base) / 10 ** p.decimals);
  }
  private out(p: SimPool, buy: boolean, amountIn: bigint): bigint {
    const net = amountIn - (amountIn * BigInt(p.fee_bps)) / 10_000n;
    const [rin, rout] = buy ? [p.quote, p.base] : [p.base, p.quote];
    return (rout * net) / (rin + net);
  }

  async balances(owner: string, mints: string[]): Promise<Balances> {
    const w = this.wallet(owner);
    return { line: w.line, sol: w.sol, tokens: new Map(mints.map((m) => [m, w.tokens.get(m) ?? 0n])) };
  }

  async quote(_owner: TraderKey, t: TokenView, side: "buy" | "sell", amountIn: bigint): Promise<Quote> {
    const p = this.pools.get(t.mint);
    if (!p) throw new Error(`no pool for ${t.mint}`);
    const out = this.out(p, side === "buy", amountIn);
    const probeIn = amountIn / 1000n > 0n ? amountIn / 1000n : 1n;
    const probe = this.out(p, side === "buy", probeIn);
    const impact = probe > 0n ? 1 - Number(out) / Number(amountIn) / (Number(probe) / Number(probeIn)) : 1;
    return { out, impact_bps: Math.max(0, Math.round(impact * 10_000)), venue: "sim", probe: { in: probeIn, out: probe } };
  }

  async execute(owner: TraderKey, t: TokenView, side: "buy" | "sell", amountIn: bigint, minOut: bigint, pre?: PreTrade): Promise<Fill> {
    const p = this.pools.get(t.mint);
    if (!p) throw new Error(`no pool for ${t.mint}`);
    if (pre) preTradeCheck(pre, { out: this.out(p, side === "buy", amountIn), probeOut: pre.quote.probe ? this.out(p, side === "buy", pre.quote.probe.in) : null });
    const w = this.wallet(owner.id);
    if (w.sol < BigInt(this.feeLamports)) throw new Error("insufficient SOL for the fee");
    const have = side === "buy" ? w.line : (w.tokens.get(t.mint) ?? 0n);
    if (amountIn > have) throw new Error("insufficient funds");
    const out = this.out(p, side === "buy", amountIn);
    if (out < minOut) throw new Error(`slippage: out ${out} below minimum ${minOut}`);
    w.sol -= BigInt(this.feeLamports);
    if (side === "buy") {
      p.quote += amountIn;
      p.base -= out;
      w.line -= amountIn;
      w.tokens.set(t.mint, (w.tokens.get(t.mint) ?? 0n) + out);
    } else {
      p.base += amountIn;
      p.quote -= out;
      w.tokens.set(t.mint, have - amountIn);
      w.line += out;
    }
    return { signature: `sim:${++this.n}`, amount_in: amountIn, amount_out: out, fee_lamports: this.feeLamports, venue: "sim" };
  }

  /** An outside trader moves a price (for the simulated market's scenarios). */
  shock(mint: string, buy: boolean, amountIn: bigint) {
    const p = this.pools.get(mint)!;
    const out = this.out(p, buy, amountIn);
    if (buy) (p.quote += amountIn), (p.base -= out);
    else (p.base += amountIn), (p.quote -= out);
  }
}
