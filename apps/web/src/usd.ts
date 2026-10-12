import { esc, html, raw, type Raw } from "./html.ts";

// US dollars (owner 2026-10-12: "everything needs to be denominated in USD"). The ONE formatter every
// money figure in the app, the wallet bundle and the embed kit goes through, and the page's copy of the
// one price behind it.
//
// Where a dollar figure comes from:
//   market rows (price, market cap, volume, trades, candles, fees): the indexer's own "_usd" fields
//     (packages/indexer/src/api.ts). The page formats them, it never multiplies.
//   amounts Core's ledger and the chain give in the quote coin (vaults, bonds, credits, payouts, feed
//     amounts): this file converts them with the indexer's reading from GET /market/quote-usd, the same
//     number behind the "_usd" fields (packages/indexer/src/usd.ts: the quote coin's pump.fun market
//     read from chain, times Jupiter's USD price of its pair asset), at the current price.
// When there is no reading, a figure reads USD_NA. A quote-coin number is never shown as dollars and
// nothing is guessed.

/** What a money figure reads when the USD price could not be read. */
export const USD_NA = "$ unavailable";

const full0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const full2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sig4 = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

const signed = (n: number, body: string) => `${n < 0 ? "-" : ""}$${body}`;

/**
 * A dollar amount. Full (detail pages): whole dollars from $1,000 ("$312,508,385"), cents from $1
 * ("$12.34"), four significant digits below ("$0.001234"). Compact (cards, tiles, axes): "$1.2M",
 * "$312.5M", "$4.1K" from $1,000 and the full form below.
 */
export function fmtUsd(n: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return USD_NA;
  const a = Math.abs(n);
  if (a === 0) return "$0";
  if (opts.compact && a >= 1000) return signed(n, compact.format(a));
  if (a >= 1000) return signed(n, full0.format(a));
  if (a >= 1) return signed(n, full2.format(a));
  return signed(n, sig4.format(a));
}

/** A dollar price per token: cents from $1 ("$1.23", "$1,234.56"), four significant digits below ("$0.3125", "$0.00001234"). */
export function fmtUsdPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return USD_NA;
  const a = Math.abs(n);
  if (a === 0) return "$0";
  return signed(n, a >= 1 ? full2.format(a) : sig4.format(a));
}

// ------------------------------------------------------------------------------------------------
// the reading (GET /market/quote-usd), kept for REFRESH_MS

export type UsdReading =
  | { ok: true; usd: number; read_at: number; age_s: number; sol_usd: number | null; pair: string; venue: string; quote?: string; sources?: { pair_per_quote: string; pair_usd: string } }
  | { ok: false; reason: string; read_at?: number | null };

const REFRESH_MS = 45_000;
let reading: UsdReading = { ok: false, reason: "the USD price has not been read yet" };
let readAt = 0;
let pending: Promise<UsdReading> | null = null;

/** The current reading (never fetches). */
export const usdReading = (): UsdReading => reading;
/** For tests and the embed kit: set the reading directly. */
export function setUsdReading(r: UsdReading) {
  reading = r;
  readAt = Date.now();
}

/** Loads the reading unless a fresh one is held. `base` is the market API's origin ("" on the app). Never throws. */
export function loadUsd(base = "", f: typeof fetch = fetch): Promise<UsdReading> {
  if (Date.now() - readAt < REFRESH_MS) return Promise.resolve(reading);
  pending ??= (async () => {
    try {
      const r = await f(`${base}/market/quote-usd`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(6_000) });
      const j = (await r.json()) as UsdReading & { message?: string; error?: string };
      reading = r.ok && j && j.ok === true && typeof j.usd === "number" && Number.isFinite(j.usd) && j.usd > 0
        ? j
        : { ok: false, reason: (j as { reason?: string })?.reason ?? j?.message ?? j?.error ?? `the market indexer answered HTTP ${r.status}` };
    } catch (e) {
      reading = { ok: false, reason: `the market indexer did not answer (${(e as Error).message})` };
    }
    readAt = Date.now();
    pending = null;
    return reading;
  })();
  return pending;
}

/** A quote-coin amount (UI units) in dollars at the current reading; null when there is none. */
export const quoteToUsd = (n: number | null | undefined): number | null => (n === null || n === undefined || !Number.isFinite(n) || !reading.ok ? null : n * reading.usd);
/** SOL in dollars at the reading's SOL/USD; null when there is none. */
export const solToUsd = (n: number | null | undefined): number | null =>
  n === null || n === undefined || !Number.isFinite(n) || !reading.ok || reading.sol_usd == null ? null : n * reading.sol_usd;
/** Why there is no dollar figure, for a title. */
export const usdWhy = (): string => (reading.ok ? "" : `No US dollar price: ${reading.reason}`);
/** Where the dollar price comes from and when it was read, in plain words (for a caption or a title). */
export function usdSourceLine(): string {
  if (!reading.ok) return usdWhy();
  return `US dollar figures: the ${reading.quote ?? "quote"} coin's ${reading.venue === "pool" ? "PumpSwap pool" : "pump.fun curve"} price in ${reading.pair}, times Jupiter's ${reading.pair} price, read ${new Date(reading.read_at * 1000).toLocaleTimeString("en-US")}.`;
}

// ------------------------------------------------------------------------------------------------
// markup

const TBA = html`<span class="faint">TBA</span>`;

/**
 * A dollar figure. `usd` is the API's "_usd" value (or a conversion from this file); `exists` says
 * whether the underlying figure exists at all: a figure the chain has not produced reads TBA, one that
 * exists without a dollar price reads USD_NA. data-v carries the exact dollar value and data-f the
 * API field, which the page checks compare with the indexer's rows.
 */
export function usdFig(usd: number | null | undefined, opts: { exists?: boolean; compact?: boolean; price?: boolean; field?: string; title?: string } = {}): Raw {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) {
    if (opts.exists === false) return TBA;
    return html`<span class="num usd-na"${opts.field ? raw(` data-f="${esc(opts.field)}"`) : ""} data-v="" title="${usdWhy() || "No US dollar price for this figure"}">${USD_NA}</span>`;
  }
  const text = opts.price ? fmtUsdPrice(usd) : fmtUsd(usd, { compact: opts.compact });
  return html`<span class="num" data-v="${usd}"${opts.field ? raw(` data-f="${esc(opts.field)}"`) : ""} title="${opts.title ?? `$${usd}`}">${text}</span>`;
}
/** The same as text (chart labels, tooltips, the embed kit's string templates). */
export function usdText(usd: number | null | undefined, opts: { exists?: boolean; compact?: boolean; price?: boolean } = {}): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return opts.exists === false ? "TBA" : USD_NA;
  return opts.price ? fmtUsdPrice(usd) : fmtUsd(usd, { compact: opts.compact });
}
