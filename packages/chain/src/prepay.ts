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
  const c = r as unknown as PrepayConfig;
  if (cmpDec(c.default_usd, c.min_usd) < 0) throw new Error("prepay config: default_usd below min_usd");
  if (cmpDec(c.line_per_usd, "0") <= 0) throw new Error("prepay config: line_per_usd must be positive");
  return { min_usd: c.min_usd, default_usd: c.default_usd, line_per_usd: c.line_per_usd, rate_status: c.rate_status,
    compute_price_line_per_usd: c.compute_price_line_per_usd, compute_price_line_per_sandbox_s: c.compute_price_line_per_sandbox_s,
    sandbox_reserve_s: c.sandbox_reserve_s, attempt_max_usd: c.attempt_max_usd, since: c.since };
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
  /** legacy: one legacy transaction; v0: one v0 transaction with the lookup table; split: launch, deposit and wake first, then the soul */
  mode: "legacy" | "v0" | "split";
  txs: LaunchTx[];
}

const FAKE_BLOCKHASH = "11111111111111111111111111111111";

/**
 * One signed launch transaction when it fits: `main` is launch_agent + deposit + refresh_awake,
 * `soul` the optional set_profile, `budget` the compute budget instructions the sender prepends. A
 * legacy message first; over the packet limit, a v0 message with `table` (when the wallet signs v0);
 * still over, two transactions: (a) main, so the agent wakes at once, (b) the soul.
 */
export function planLaunch(o: { payer: Address; main: Ix[]; soul: Ix | null; budget: Ix[]; table: LookupTable | null; v0: boolean }): LaunchPlan {
  const all = o.soul ? [...o.main, o.soul] : o.main;
  const legacy = (ixs: Ix[]) => {
    const m = compileMessage(o.payer, [...o.budget, ...ixs], FAKE_BLOCKHASH);
    return wireSize({ bytes: m.bytes, numSigners: m.numSigners });
  };
  const v0 = (ixs: Ix[]) => wireSize(compileMessageV0(o.payer, [...o.budget, ...ixs], FAKE_BLOCKHASH, [o.table!]));
  const one = legacy(all);
  if (one <= PACKET_LIMIT) return { mode: "legacy", txs: [{ ixs: all, table: null, size: one }] };
  if (o.v0 && o.table) {
    const s = v0(all);
    if (s <= PACKET_LIMIT) return { mode: "v0", txs: [{ ixs: all, table: o.table, size: s }] };
  }
  if (!o.soul) throw new Error(`the launch transaction is ${one} bytes, over the ${PACKET_LIMIT}-byte packet limit${o.v0 && o.table ? "" : " (and no v0 lookup table is usable)"}`);
  const pick = (ixs: Ix[]): LaunchTx => {
    const l = legacy(ixs);
    if (l <= PACKET_LIMIT) return { ixs, table: null, size: l };
    const s = o.v0 && o.table ? v0(ixs) : Infinity;
    if (s <= PACKET_LIMIT) return { ixs, table: o.table, size: s };
    throw new Error(`the launch transaction is ${l} bytes even without the soul, over the ${PACKET_LIMIT}-byte packet limit`);
  };
  return { mode: "split", txs: [pick(o.main), pick([o.soul])] };
}
