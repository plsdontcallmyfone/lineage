import type { Address } from "./codec.ts";
import type { Ix } from "./registry.ts";
import { compileMessage, PACKET_LIMIT } from "./tx.ts";
import { compileMessageV0, wireSize, type LookupTable } from "./v0.ts";

// Prepaid credits at launch (plan C, owner decision 2026-10-09): config math and how the launch is
// split into transactions. The deposit is a dollar amount converted at a configured $LINE rate (a
// TEST rate on devnet); the minimum and the default are configuration, never constants.

/** Core's `prepay` block (config/network.json, served at GET /v1/config). Every figure the launch form shows comes from it or from chain. */
export interface PrepayConfig {
  /** Smallest deposit a launch may carry, USD (decimal string). */
  min_usd: string;
  /** What the form starts at, USD (decimal string, >= min_usd). */
  default_usd: string;
  /** Whole $LINE per USD (decimal string). */
  line_per_usd: string;
  /** "test" until $LINE exists and the owner sets a real rate. */
  rate_status: "test" | "live";
  /** The hosted runtime's published prices (must equal its config; the runtime checks at start). */
  compute_price_line_per_usd: string;
  compute_price_line_per_sandbox_s: string;
  sandbox_reserve_s: number;
  attempt_max_usd: number;
  /** Launches created at or after this unix time (s) must carry the minimum; older ones are not checked. */
  since: number;
  /**
   * Launch fronting (docs/plans/LAUNCH-FRONTING.md, owner decision 2026-10-10): the launcher's initial
   * buy of the new token, in basis points of its total supply, delivered to the agent's treasury in the
   * launch transaction (100 = 1%; 0 = none). Admin-editable (POST /v1/admin/launch-fronting).
   */
  initial_buy_bps: number;
  /** Most the initial buy may cost above the curve quote, in basis points of the quote (the maximum input sent with an exact-output buy). */
  initial_buy_slippage_bps: number;
}

const DEC = /^\d+(\.\d+)?$/;
/** A non-negative decimal string as (integer, scale). */
function dec(s: string): [bigint, bigint] {
  if (!DEC.test(s)) throw new Error(`${s} is not a non-negative decimal`);
  const [i, f = ""] = s.split(".");
  return [BigInt(i! + f), 10n ** BigInt(f.length)];
}

export function parsePrepayConfig(raw: unknown): PrepayConfig {
  if (!raw || typeof raw !== "object") throw new Error("prepay config: object expected");
  const r = raw as Record<string, unknown>;
  for (const k of ["min_usd", "default_usd", "line_per_usd", "compute_price_line_per_usd", "compute_price_line_per_sandbox_s"])
    if (typeof r[k] !== "string" || !DEC.test(r[k] as string)) throw new Error(`prepay config: ${k} must be a decimal string`);
  if (r.rate_status !== "test" && r.rate_status !== "live") throw new Error('prepay config: rate_status is "test" or "live"');
  for (const k of ["sandbox_reserve_s", "attempt_max_usd", "since"])
    if (typeof r[k] !== "number" || !Number.isFinite(r[k]) || (r[k] as number) < 0) throw new Error(`prepay config: ${k} must be a non-negative number`);
  for (const k of ["initial_buy_bps", "initial_buy_slippage_bps"])
    if (r[k] !== undefined && (!Number.isInteger(r[k]) || (r[k] as number) < 0 || (r[k] as number) > 10_000)) throw new Error(`prepay config: ${k} must be an integer 0 to 10000`);
  const c = r as unknown as PrepayConfig;
  if (cmpDec(c.default_usd, c.min_usd) < 0) throw new Error("prepay config: default_usd below min_usd");
  if (cmpDec(c.line_per_usd, "0") <= 0) throw new Error("prepay config: line_per_usd must be positive");
  return { min_usd: c.min_usd, default_usd: c.default_usd, line_per_usd: c.line_per_usd, rate_status: c.rate_status,
    compute_price_line_per_usd: c.compute_price_line_per_usd, compute_price_line_per_sandbox_s: c.compute_price_line_per_sandbox_s,
    sandbox_reserve_s: c.sandbox_reserve_s, attempt_max_usd: c.attempt_max_usd, since: c.since,
    initial_buy_bps: (r.initial_buy_bps as number | undefined) ?? 100, initial_buy_slippage_bps: (r.initial_buy_slippage_bps as number | undefined) ?? 100 };
}

// ---------- launch fronting (docs/plans/LAUNCH-FRONTING.md) ----------

/** The prepaid credits a launch must carry: exactly the configured amount (min_usd), at the configured rate, in base units. */
export function requiredCredits(c: PrepayConfig, decimals: number): bigint {
  return usdToBase(c.min_usd, c.line_per_usd, decimals);
}

/** Token base units the initial buy must deliver: floor(total supply x bps / 10,000). */
export function initialBuyAmount(supply: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error(`initial_buy_bps ${bps} is not 0 to 10000`);
  if (supply < 0n) throw new Error("supply is negative");
  return (supply * BigInt(bps)) / 10_000n;
}

/** The maximum quote input an exact-output buy may spend: ceil(quote x (10,000 + slippage bps) / 10,000). */
export function maxBuyInput(quote: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) throw new Error(`initial_buy_slippage_bps ${slippageBps} is not 0 to 10000`);
  return (quote * BigInt(10_000 + slippageBps) + 9_999n) / 10_000n;
}

/**
 * The three costs a launcher fronts and what the wallet must hold. `creationLamports` is the
 * launcher's SOL change in the launch simulation (network fee plus every rent deposit it pays);
 * `credits` the prepaid credits; `buy` the initial buy (its exact simulated cost when known, and the
 * maximum input the transaction allows), or null when the venue does not add one yet.
 */
export interface FrontingCosts {
  creationLamports: bigint | null;
  credits: bigint;
  buy: { amountOut: bigint; cost: bigint; maxIn: bigint } | null;
  /** quote-token total: credits plus the buy's maximum input (what must be in the wallet) */
  quoteNeeded: bigint;
  /** quote-token total actually spent per the simulation: credits plus the buy's cost */
  quoteSpent: bigint;
}
export function frontingCosts(o: { creationLamports: bigint | null; credits: bigint; buy: FrontingCosts["buy"] }): FrontingCosts {
  return { ...o, quoteNeeded: o.credits + (o.buy?.maxIn ?? 0n), quoteSpent: o.credits + (o.buy?.cost ?? 0n) };
}

/** Why the wallet cannot cover the launch, or null. `solBalance`/`quoteBalance` null: unknown, refused. */
export function frontingShortfall(c: FrontingCosts, solBalance: bigint | null, quoteBalance: bigint | null): string | null {
  if (c.creationLamports === null) return "the token creation cost is not simulated yet";
  if (solBalance === null || quoteBalance === null) return "the wallet's balances are not read yet";
  if (solBalance < c.creationLamports) return `the wallet holds ${solBalance} lamports; the token creation costs ${c.creationLamports}`;
  if (quoteBalance < c.quoteNeeded) return `the wallet holds ${quoteBalance} quote base units; credits and the initial buy need ${c.quoteNeeded}`;
  return null;
}

export function cmpDec(a: string, b: string): number {
  const [x, sx] = dec(a), [y, sy] = dec(b);
  const l = x * sy, r = y * sx;
  return l < r ? -1 : l > r ? 1 : 0;
}

/** USD (decimal string) to $LINE base units at `linePerUsd`, rounded up (the deposit never falls short of the dollar figure). */
export function usdToBase(usd: string, linePerUsd: string, decimals: number): bigint {
  const [u, su] = dec(usd), [p, sp] = dec(linePerUsd);
  const num = u * p * 10n ** BigInt(decimals), den = su * sp;
  return (num + den - 1n) / den;
}

/** $LINE base units to USD at `linePerUsd`, rounded down to the cent: what a deposit is worth at the rate. */
export function baseToUsdCents(amount: bigint, linePerUsd: string, decimals: number): bigint {
  const [p, sp] = dec(linePerUsd);
  return (amount * sp * 100n) / (p * 10n ** BigInt(decimals));
}

/**
 * The first-run budget a deposit pays for at the runtime's published prices: model spend in USD after
 * the sandbox reserve (SPEC 17.2 `usdFor`), and how many attempts at the per-attempt cap that is.
 */
export function firstRunBudget(c: PrepayConfig, amount: bigint, decimals: number): { usd: number; attempts: number } {
  const perUsd = usdToBase("1", c.compute_price_line_per_usd, decimals);
  const perS = usdToBase("1", c.compute_price_line_per_sandbox_s, decimals);
  const left = amount - BigInt(Math.ceil(c.sandbox_reserve_s)) * perS;
  const usd = left <= 0n || perUsd === 0n ? 0 : Number((left * 1_000_000n) / perUsd) / 1e6;
  return { usd, attempts: c.attempt_max_usd > 0 ? Math.floor(usd / c.attempt_max_usd) : 0 };
}

// ---------- transaction plan ----------

export interface LaunchTx {
  ixs: Ix[];
  /** set when the transaction is a v0 message reading this lookup table */
  table: LookupTable | null;
  size: number;
}
export interface LaunchPlan {
  /** legacy: one legacy transaction; v0: one v0 transaction with the lookup table; split: two transactions (see `buyTx`) */
  mode: "legacy" | "v0" | "split";
  txs: LaunchTx[];
  /** index of the transaction carrying the initial buy (launch fronting), null without one */
  buyTx: number | null;
}

const FAKE_BLOCKHASH = "11111111111111111111111111111111";

/**
 * One signed launch transaction when it fits: `main` is the venue's create + register (pump.fun:
 * create_v2 + register_pump_launch), `buy` the venue's initial buy instructions (launch fronting;
 * empty when the venue adds none), `rest` what may follow in a second transaction (the deposit and
 * refresh_awake; empty to keep them in `main`), `soul` the optional set_profile, `budget` the compute
 * budget instructions the sender prepends. A legacy message first; over the packet limit, a v0
 * message with `table` (when the wallet signs v0); still over, exactly two transactions, never more:
 * (a) main + buy + rest, (b) the soul; else (a) main + buy, (b) rest + soul; else (a) main, (b) buy +
 * rest + soul. The buy stays in the first transaction whenever it fits there, so nobody can trade the
 * new curve before it.
 */
export function planLaunch(o: { payer: Address; main: Ix[]; buy?: Ix[]; rest?: Ix[]; soul: Ix | null; budget: Ix[]; table: LookupTable | null; v0: boolean }): LaunchPlan {
  const buy = o.buy ?? [];
  const rest = o.rest ?? [];
  const soul = o.soul ? [o.soul] : [];
  const hasBuy = buy.length > 0;
  const all = [...o.main, ...buy, ...rest, ...soul];
  const legacy = (ixs: Ix[]) => {
    const m = compileMessage(o.payer, [...o.budget, ...ixs], FAKE_BLOCKHASH);
    return wireSize({ bytes: m.bytes, numSigners: m.numSigners });
  };
  const v0 = (ixs: Ix[]) => wireSize(compileMessageV0(o.payer, [...o.budget, ...ixs], FAKE_BLOCKHASH, [o.table!]));
  const fit = (ixs: Ix[]): LaunchTx | null => {
    const l = legacy(ixs);
    if (l <= PACKET_LIMIT) return { ixs, table: null, size: l };
    const s = o.v0 && o.table ? v0(ixs) : Infinity;
    return s <= PACKET_LIMIT ? { ixs, table: o.table, size: s } : null;
  };
  const one = fit(all);
  if (one) return { mode: one.table ? "v0" : "legacy", txs: [one], buyTx: hasBuy ? 0 : null };
  const size = legacy(all);
  const why = `${o.v0 && o.table ? "" : " (and no v0 lookup table is usable)"}`;
  if (!soul.length && !rest.length && !hasBuy) throw new Error(`the launch transaction is ${size} bytes, over the ${PACKET_LIMIT}-byte packet limit${why}`);
  const two = (first: Ix[], second: Ix[], buyTx: number | null): LaunchPlan | null => {
    if (!second.length) return null;
    const a = fit(first), b = fit(second);
    return a && b ? { mode: "split", txs: [a, b], buyTx } : null;
  };
  const plan = two([...o.main, ...buy, ...rest], soul, hasBuy ? 0 : null) ?? two([...o.main, ...buy], [...rest, ...soul], hasBuy ? 0 : null)
    ?? (hasBuy ? two(o.main, [...buy, ...rest, ...soul], 1) : null);
  if (plan) return plan;
  throw new Error(`the launch transaction is ${legacy(o.main)} bytes even without the soul${hasBuy ? " and the initial buy" : ""}, over the ${PACKET_LIMIT}-byte packet limit${why}`);
}
