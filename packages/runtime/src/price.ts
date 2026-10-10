// The quote token's price in USD for converting model spend into vault debits (plan
// MODELS-AND-SELF-FUNDING). Devnet and sim use the configured TEST rate compute_price_line_per_usd.
// Mainnet uses the quote token's live USD price from Jupiter Price API V3 (read 2026-10-10 at
// https://developers.jup.ag/docs/price: GET https://api.jup.ag/price/v3?ids=<mint>, keyless or with
// x-api-key; the answer maps the mint to { usdPrice, blockId, decimals, priceChange24h }, or leaves the
// mint out / null when Jupiter has no reliable price). A price older than max_age_s, outside the
// sanity band or missing means no price: the runtime starts nothing and closes no usage epoch until
// one is back. No figure is ever invented.

import { toBase } from "./config.ts";

export interface QuotePrice {
  /** quote token base units per 1 USD of model spend */
  perUsd: bigint;
  /** USD per whole quote token, when read from a feed */
  usd: number | null;
  source: "config" | "jupiter";
  /** "test" for the configured rate (devnet), "live" for a feed */
  status: "test" | "live";
  at: number;
}

export interface PriceSource {
  /** Reads the feed (no-op for a fixed rate). Never throws; failures show in `current()` as null with `why()`. */
  refresh(): Promise<void>;
  /** The price in force now, or null when none may be used. */
  current(now: number): QuotePrice | null;
  why(now: number): string | null;
}

/** The configured TEST rate (whole quote tokens per USD), as before. */
export class FixedPrice implements PriceSource {
  private p: QuotePrice;
  constructor(linePerUsd: string, decimals: number) {
    this.p = { perUsd: toBase(linePerUsd, decimals), usd: null, source: "config", status: "test", at: 0 };
  }
  async refresh() {}
  current() {
    return this.p;
  }
  why() {
    return null;
  }
}

export interface JupiterPriceConfig {
  mint: string;
  decimals: number;
  /** default https://api.jup.ag/price/v3 */
  api?: string;
  /** a reading older than this is not used (default 300) */
  max_age_s?: number;
  /** sanity band, USD per whole token (both required: a stand-in stablecoin uses 0.95 to 1.05) */
  min_usd: number;
  max_usd: number;
  /** seconds between reads (default 60) */
  refresh_s?: number;
}

export const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";

/** The quote token's USD price from Jupiter, refused when stale or outside the band. */
export class JupiterPrice implements PriceSource {
  private last: QuotePrice | null = null;
  private lastErr: string | null = "not read yet";
  private readAt = 0;
  constructor(
    private c: JupiterPriceConfig,
    private deps: { fetch?: typeof fetch; now?: () => number; apiKey?: string } = {},
  ) {
    if (!(c.min_usd > 0 && c.max_usd > c.min_usd)) throw new Error("price: min_usd and max_usd must bound a positive band");
  }

  async refresh(): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    if (now - this.readAt < (this.c.refresh_s ?? 60) * 1000 && this.last) return;
    this.readAt = now;
    try {
      const r = await (this.deps.fetch ?? fetch)(`${(this.c.api ?? JUPITER_PRICE_API).replace(/\/+$/, "")}?ids=${this.c.mint}`, {
        headers: this.deps.apiKey ? { "x-api-key": this.deps.apiKey } : {},
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as Record<string, { usdPrice?: unknown; decimals?: unknown } | null>;
      const e = j?.[this.c.mint];
      const usd = e?.usdPrice;
      if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) throw new Error("Jupiter has no price for the quote token");
      if (e!.decimals !== undefined && e!.decimals !== this.c.decimals) throw new Error(`Jupiter reports ${String(e!.decimals)} decimals, the profile ${this.c.decimals}`);
      if (usd < this.c.min_usd || usd > this.c.max_usd) throw new Error(`price ${usd} USD is outside the sanity band ${this.c.min_usd} to ${this.c.max_usd}`);
      this.last = { perUsd: perUsdOf(usd, this.c.decimals), usd, source: "jupiter", status: "live", at: now };
      this.lastErr = null;
    } catch (e) {
      this.lastErr = (e as Error).message;
      // an out-of-band or missing price also retires the previous reading: never keep debiting at a price the feed no longer gives
      if (!/HTTP|abort|timeout|fetch/i.test(this.lastErr)) this.last = null;
    }
  }

  current(now: number): QuotePrice | null {
    if (!this.last) return null;
    if (now - this.last.at > (this.c.max_age_s ?? 300) * 1000) return null;
    return this.last;
  }

  why(now: number): string | null {
    if (this.current(now)) return null;
    if (this.last && now - this.last.at > (this.c.max_age_s ?? 300) * 1000) return `the last quote price is ${Math.round((now - this.last.at) / 1000)} s old (max ${this.c.max_age_s ?? 300} s)${this.lastErr ? `; ${this.lastErr}` : ""}`;
    return this.lastErr ?? "no quote price";
  }
}

/** Base units per 1 USD at `usd` per whole token (rounded up: a debit never undercounts). */
export function perUsdOf(usd: number, decimals: number): bigint {
  // the price in 1e-9 USD steps keeps this exact enough: ceil(10^decimals / usd)
  const micro = BigInt(Math.round(usd * 1e9));
  return (10n ** BigInt(decimals) * 1_000_000_000n + micro - 1n) / micro;
}
