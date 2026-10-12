// The launch credits at the coin's live market price (owner 2026-10-12; Core's prepay.rate_source
// "market"): the coin amount a dollar figure buys comes from the page's one USD reading (src/usd.ts,
// GET /market/quote-usd, the number behind every dollar figure here), never from a static rate. A
// launch is refused while that reading is missing, older than Core's rate_max_age_s or outside Core's
// band, and the reading is asked again right before the transactions are built. With the configured
// rate (rate_source absent: devnet, the test deployment) nothing here changes the old arithmetic.
// Pure (no wallet, no DOM), so the rule is tested without a browser: apps/web/test/credits-rate.test.ts.
import { fmtUsd, fmtUsdPrice, loadUsd, usdReading, usdReadingAge } from "../src/usd.ts";
import { checkMarketRate, creditsAtPrice, marketRate, usdToBase, type PrepayConfig, type RateCheck } from "../../../packages/chain/src/browser/index.ts";

/** A held reading counts this long when the launch asks again (the indexer itself reads about every 45 s). */
export const REREAD_MS = 5_000;

export type UsableRate = Extract<RateCheck, { ok: true }>;

/** Whether the credits follow the live price on this network. */
export const marketMode = (c: PrepayConfig | null): boolean => !!marketRate(c);

/** The page's current reading against Core's rule (age, band). */
export function currentRate(c: PrepayConfig, symbol: string): RateCheck {
  const r = usdReading(), age = usdReadingAge();
  return checkMarketRate(c, r.ok && age !== null ? { usd: r.usd, read_at: r.read_at, age_s: age } : null, { symbol, why: r.ok ? null : r.reason });
}

/** Asks the indexer again unless the held reading is a few seconds old. Never throws. */
export async function rereadRate(base = "", f: typeof fetch = fetch): Promise<void> {
  await loadUsd(base, f, REREAD_MS);
}

/** Why the launch cannot be built at the market rate: one plain clause for "Launch disabled: <reason>." */
export class RateBlocked extends Error {
  constructor(readonly reason: string) {
    super(`Launch disabled: ${reason}.`);
  }
}

/**
 * The coin base units `usd` dollars of credits put in the vault. Configured rate: usd x line_per_usd,
 * as before (`rate` null). Market rate: ceil(usd / the reading's price), with the reading used; throws
 * RateBlocked when there is no usable reading.
 */
export function creditsFor(c: PrepayConfig, usd: string, decimals: number, symbol: string): { base: bigint; rate: UsableRate | null } {
  if (!marketMode(c)) return { base: usdToBase(usd, c.line_per_usd, decimals), rate: null };
  const rate = currentRate(c, symbol);
  if (!rate.ok) throw new RateBlocked(rate.reason);
  return { base: creditsAtPrice(usd, rate.usd, decimals), rate };
}

/** "$10.00 of credits = 3,330,003.330004 UNITS at $0.000003003, read 12 s ago": the rate and the reading's age, in the page's own dollar format. */
export function rateLine(o: { usd: string; base: bigint; rate: { usd: number; age_s: number }; symbol: string; amount: string }): string {
  return `${fmtUsd(Number(o.usd))} of credits = ${o.amount} ${o.symbol} at ${fmtUsdPrice(o.rate.usd)}, read ${Math.round(o.rate.age_s)} s ago`;
}
