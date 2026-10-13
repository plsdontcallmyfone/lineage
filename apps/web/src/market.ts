import { ApiError } from "./api.ts";
import { esc, html, raw, type Raw } from "./html.ts";
import { fmtUsd, fmtUsdPrice, NO_DATA, usdFig, USD_NA } from "./usd.ts";

// Launchpad market data (plan L3): a client for the market indexer's read API (packages/indexer,
// served by the dashboard at /market/*, plan L2) and the presentation pieces the token pages share.
// Every figure comes from the indexer as it is; this file only formats it. Money is shown in US
// dollars (owner 2026-10-12): the indexer's "_usd" fields, formatted by usd.ts, the one formatter. The
// quote-token figures beside them (the network profile's quote, SPEC 14.10) stay in the rows for
// titles and checks; token amounts and percentages are not money and keep the formatters below.

/** The quote token's symbol; a live binding, set from /chain/config's network profile (UNITS until then). */
export let QUOTE = "UNITS";
/** How the quote token is named where it is introduced (the profile's quote.display). The devnet coin's
 * on-chain metadata says tLINE; that symbol is never read for display (owner 2026-10-12: UNITS always). */
export let QUOTE_LABEL = "UNITS";
/** The profile's network: the repository's default, mainnet, until /chain/config says what this server runs. */
export let NETWORK: "devnet" | "mainnet" = "mainnet";
let explorerQ = "";

/** Reads the network profile once (public view, no RPC); true when it changed the labels (a devnet server). */
export async function loadNetworkLabels(): Promise<boolean> {
  try {
    const c = (await (await fetch("/chain/config")).json()) as { profile?: { network: "devnet" | "mainnet"; quote: { symbol: string; display?: string }; explorer_cluster: string | null } };
    const before = `${NETWORK}|${QUOTE}|${QUOTE_LABEL}|${explorerQ}`;
    // a server that predates profiles is a devnet server
    const p = c.profile ?? { network: "devnet" as const, quote: { symbol: QUOTE }, explorer_cluster: "devnet" };
    if (p.quote.display) QUOTE_LABEL = p.quote.display;
    NETWORK = p.network;
    QUOTE = p.quote.symbol;
    explorerQ = p.explorer_cluster ? `?cluster=${p.explorer_cluster}` : "";
    return before !== `${NETWORK}|${QUOTE}|${QUOTE_LABEL}|${explorerQ}`;
  } catch {
    return false;
  }
}

export interface TokenSummary {
  mint: string;
  agent: string;
  name: string | null;
  symbol: string | null;
  phase: "curve" | "graduated";
  migrated: boolean;
  /** the curve is complete and pump.fun has not made its pool yet: no trade lands until it does */
  awaiting_migration?: boolean;
  price: number | null;
  market_cap: number | null;
  volume_24h: number;
  volume_24h_base: number;
  trades_24h: number;
  change_24h: number | null;
  /** US dollars, from the indexer (null: the dollar price could not be read) */
  quote_usd?: number | null;
  price_usd?: number | null;
  market_cap_usd?: number | null;
  volume_24h_usd?: number | null;
  change_24h_usd?: number | null;
  /** the dollar price that change is measured from (null: no UNITS dollar price on record for that time), and whether "then" is 24 hours ago or the launch */
  change_ref_usd?: number | null;
  change_window?: "24h" | "since_launch";
  quote_reserve_usd?: number | null;
  migration_threshold_usd?: number | null;
  curve_progress: number | null;
  quote_reserve: number | null;
  migration_threshold: number | null;
  holders: number | null;
  trades: number;
  last_trade_at: number | null;
  created_at: number;
  launcher: string;
  repo_url: string | null;
  state_at: number | null;
  /** "pump" (pump.fun) or "meteora" (the earlier venue, devnet history, read only); from the indexer */
  venue?: "pump" | "meteora";
  read_only?: boolean;
}

export interface TokenDetail extends TokenSummary {
  decimals: number;
  quote_decimals: number;
  supply: number | null;
  supply_raw: string | null;
  start_price: number | null;
  start_price_usd?: number | null;
  hosted: boolean;
  identity_mode: number | null;
  awake: boolean | null;
  pools: {
    launch_account: string;
    dbc_config: string;
    dbc_pool: string;
    dbc_base_vault: string;
    dbc_quote_vault: string;
    damm_pool: string | null;
    damm_base_vault: string | null;
    damm_quote_vault: string | null;
    position: string | null;
    position_nft_account: string | null;
  };
  fees: { claimed: number | null; to_compute: number | null; to_treasury: number | null; claimed_raw: string | null; cranks: number };
  compute_vault: { address: string; balance: number | null; balance_raw: string | null; debited: number | null; withdrawn: number | null };
  events: { kind: string; signature: string; slot: number; time: number | null; [k: string]: unknown }[];
  holders_at: number | null;
}

export interface Candle {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  volume_base: number;
  trades: number;
  open_usd?: number | null;
  high_usd?: number | null;
  low_usd?: number | null;
  close_usd?: number | null;
  volume_usd?: number | null;
}
/** How a series was converted to dollars: every point at the price of its own time, all at today's, or some of each; null without a price. */
export type UsdBasis = "at_time" | "partial" | "current" | "mixed" | null;
export interface CandlesAnswer {
  candles: Candle[];
  usd_basis?: UsdBasis;
  start_price_usd?: number | null;
  /** the change shown beside the chart: its reference dollar price and the window (the indexer's summary) */
  change?: { ref_usd: number | null; window: "24h" | "since_launch"; pct: number | null };
}
export interface Trade {
  signature: string;
  index: number;
  slot: number;
  time: number | null;
  venue: string;
  side: "buy" | "sell";
  base_amount: number;
  quote_amount: number;
  price: number;
  price_after: number | null;
  trader: string;
  quote_amount_usd?: number | null;
  price_usd?: number | null;
  price_after_usd?: number | null;
  usd_basis?: "at_time" | "current" | null;
}
export interface Holders {
  holders: number | null;
  source: string | null;
  as_of: number | null;
  excludes: string;
  top: { owner: string; amount: number; amount_raw: string; share: number | null }[];
}
export interface FeeCrank {
  signature: string;
  slot: number;
  time: number | null;
  source: "dbc" | "damm_v2";
  amount: number;
  to_vault: number;
  to_treasury: number;
  vault_balance_after: number | null;
  awake_after: boolean;
}

/** GET /market/<path> through the dashboard. Errors surface as ApiError like Core's. */
export async function market<T = any>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/market/${path.replace(/^\/+/, "")}`, { headers: { accept: "application/json" } });
  } catch (e) {
    throw new ApiError(0, "web_unreachable", `the dashboard server did not answer (${(e as Error).message})`);
  }
  const body = (res.headers.get("content-type") ?? "").includes("json") ? await res.json().catch(() => null) : null;
  if (!res.ok) throw new ApiError(res.status, body?.code ?? (res.status === 404 ? "not_found" : "market_error"), body?.message ?? body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

// ------------------------------------------------------------------------------------------------
// formatting (pure: the token page check formats the indexer's JSON with these same functions)

const sig6 = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 });
const sig4 = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 });
const two = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const zero = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** A price in UNITS per token: six significant digits. */
export function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return NO_DATA;
  return sig6.format(n);
}
/** An amount (UNITS or tokens): whole numbers from 100,000, two places from 1, four significant digits below. */
export function fmtAmount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return NO_DATA;
  const a = Math.abs(n);
  if (a >= 100_000) return zero.format(n);
  if (a >= 1 || a === 0) return two.format(n);
  return sig4.format(n);
}
/** A ratio change (0.05 is +5.00%). */
export function fmtChange(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return NO_DATA;
  const p = n * 100;
  return `${p > 0 ? "+" : p < 0 ? "-" : ""}${two.format(Math.abs(p))}%`;
}
/** Curve progress, a fraction of the migration threshold. */
export function fmtProgress(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return NO_DATA;
  return `${(Math.min(1, Math.max(0, n)) * 100).toFixed(2)}%`;
}
export const fmtInt = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? NO_DATA : zero.format(n));

export const shortAddr = (a: string | null | undefined) => (!a ? "" : a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
export const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}${explorerQ}`;
export const explorerAddr = (a: string) => `https://explorer.solana.com/address/${a}${explorerQ}`;

// ------------------------------------------------------------------------------------------------
// components (plain functions returning markup; classes are prefixed mk- so the owner can restyle)

const NONE = html`<span class="faint">${NO_DATA}</span>`;

/** A figure with its exact indexer value in the title and a data-v the page check compares. */
export function fig(text: string, exact: number | string | null | undefined, unit?: string, field?: string): Raw {
  if (text === NO_DATA) return NONE;
  return html`<span class="num" data-v="${exact ?? ""}"${field ? raw(` data-f="${esc(field)}"`) : ""} title="${String(exact ?? "")}${unit ? ` ${unit}` : ""}">${text}</span>${unit ? html`<span class="unit">${unit}</span>` : ""}`;
}
export const priceFig = (n: number | null | undefined, field?: string) => fig(fmtPrice(n), n, QUOTE, field);

// US dollars: the indexer's "_usd" fields through usd.ts. `quote` is the same figure in the quote token:
// when it exists and the dollar one does not, the figure reads "$ unavailable", never the quote number.
const quoteTitle = (usd: number | null | undefined, quote: number | null | undefined) => (usd == null ? undefined : `$${usd}${quote == null ? "" : ` (${quote} ${QUOTE})`}`);
/** A token price in dollars (field: the API field the page checks compare, e.g. "price_usd"). */
export const usdPriceFig = (usd: number | null | undefined, quote: number | null | undefined, field?: string) =>
  usdFig(usd, { exists: quote != null, price: true, field, title: quoteTitle(usd, quote) });
/** A money amount in dollars: full on detail pages, compact ("$1.2M") on cards. */
export const usdAmountFig = (usd: number | null | undefined, quote: number | null | undefined, field?: string, compact = false) =>
  usdFig(usd, { exists: quote != null, compact, field, title: quoteTitle(usd, quote) });
/**
 * The change of the US dollar price: the dollar price now over the dollar price 24 hours ago (at the launch for a coin
 * younger than a day), the indexer's change_24h_usd. Never the change against the quote token: where the dollar price
 * of "then" is not on record the figure reads USD_NA and its title says what is missing.
 */
export function usdChangeFig(t: Pick<TokenSummary, "change_24h" | "change_24h_usd" | "change_window">): Raw {
  const n = t.change_24h_usd;
  const since = t.change_window === "since_launch";
  if (n == null || !Number.isFinite(n)) {
    if (t.change_24h == null) return NONE;
    return html`<span class="num usd-na" data-v="" data-f="change_24h_usd" title="${changeMissing(since)}">${USD_NA}</span>`;
  }
  return html`<span class="num mk-chg ${n > 0 ? "up" : n < 0 ? "down" : ""}" data-v="${n}" data-f="change_24h_usd" title="${since ? "change of the US dollar price since launch" : "change of the US dollar price over 24 hours"}">${fmtChange(n)}</span>`;
}
/** One plain line: why a dollar change cannot be shown. */
export const changeMissing = (sinceLaunch: boolean) =>
  `No US dollar change: the dollar price of ${QUOTE} ${sinceLaunch ? "at the launch" : "24 hours ago"} or now is not on record.`;
/** What the change is measured against, for the line under the figure. */
export const changeLabel = (t: Pick<TokenSummary, "change_window">) => (t.change_window === "since_launch" ? "since launch" : "vs the price 24h ago");
/** A dollar price against the reference of the change: the same arithmetic as the indexer's change_24h_usd (value over reference, minus 1); null without both. */
export const changeFrom = (refUsd: number | null | undefined, usd: number | null | undefined): number | null =>
  refUsd == null || usd == null || !(refUsd > 0) || !Number.isFinite(usd) ? null : usd / refUsd - 1;

/** What `amount` tokens (UI units) are worth in dollars at the token's dollar price from the indexer; null without one. */
export const holdingUsd = (amount: number | null | undefined, t: Pick<TokenSummary, "price_usd"> | null | undefined): number | null =>
  amount == null || !Number.isFinite(amount) || t?.price_usd == null ? null : amount * t.price_usd;

/**
 * The indexer's candles in US dollars (its "_usd" fields in place of the quote-token ones), for the
 * charts. A candle without a dollar value (no UNITS dollar price on record for its time) is left out,
 * never drawn at another price; null when there are candles and none has one. `basis` says which case.
 */
export function usdCandles(a: CandlesAnswer): { candles: Candle[]; basis: UsdBasis; start: number | null; missing: number } | null {
  const out: Candle[] = [];
  for (const c of a.candles) {
    if (c.open_usd == null || c.high_usd == null || c.low_usd == null || c.close_usd == null || c.volume_usd == null) continue;
    out.push({ ...c, open: c.open_usd, high: c.high_usd, low: c.low_usd, close: c.close_usd, volume: c.volume_usd });
  }
  if (a.candles.length && !out.length) return null;
  const missing = a.candles.length - out.length;
  return { candles: out, basis: missing ? "partial" : a.usd_basis ?? null, start: a.start_price_usd ?? null, missing };
}
/** One plain sentence for a chart caption: how its history was converted to dollars. */
export function usdBasisNote(basis: UsdBasis, any = true): string {
  if (!any) return "";
  if (basis === "at_time") return `In US dollars: each trade at the ${QUOTE} price of its own time, a quiet interval at that interval's, the latest at the current one.`;
  if (basis === "partial") return `In US dollars at the ${QUOTE} price of each interval's own time. Some intervals are not drawn: no dollar price of ${QUOTE} is on record for them.`;
  if (basis === "current") return `In US dollars at today's ${QUOTE} price: its dollar price at the time of these trades is not on record.`;
  if (basis === "mixed") return `In US dollars: trades since the dollar price of ${QUOTE} has been recorded use the price of their own time, earlier ones today's.`;
  return `${USD_NA}: no dollar price of ${QUOTE} is on record for these trades, so no chart is drawn.`;
}
export const amountFig = (n: number | null | undefined, unit: string, field?: string) => fig(fmtAmount(n), n, unit, field);

export function changeFig(n: number | null | undefined, field?: string): Raw {
  const t = fmtChange(n);
  if (t === NO_DATA) return NONE;
  return html`<span class="num mk-chg ${n! > 0 ? "up" : n! < 0 ? "down" : ""}" data-v="${n}"${field ? raw(` data-f="${esc(field)}"`) : ""} title="${String(n)}">${t}</span>`;
}

export function phaseBadge(t: Pick<TokenSummary, "phase" | "migrated" | "awaiting_migration"> & { venue?: string }): Raw {
  if (t.phase === "graduated") return html`<span class="b good mk-phase" data-phase="graduated">Graduated, ${t.venue === "meteora" ? "DAMM v2" : "PumpSwap"}</span>`;
  if (t.migrated) return html`<span class="b warn mk-phase" data-phase="migrated">Migrated, graduation pending</span>`;
  if (t.awaiting_migration) return html`<span class="b warn mk-phase" data-phase="complete" title="This coin's curve is complete. Trading moves to its pool shortly.">Curve complete, pool opening</span>`;
  return html`<span class="b info mk-phase" data-phase="curve">Bonding curve</span>`;
}

export function progressBar(p: number | null | undefined, field?: string): Raw {
  if (p === null || p === undefined || !Number.isFinite(p)) return NONE;
  const pct = Math.min(1, Math.max(0, p)) * 100;
  return html`<span class="mk-prog"><span class="bar"><i style="width:${pct.toFixed(2)}%"></i></span><span class="num" data-v="${p}"${field ? raw(` data-f="${esc(field)}"`) : ""}>${fmtProgress(p)}</span></span>`;
}

export function tokenLabel(t: Pick<TokenSummary, "name" | "symbol" | "mint">): Raw {
  return html`<span class="mk-tok"><span class="mk-sym">${t.symbol ?? shortAddr(t.mint)}</span><span class="mk-name">${t.name ?? ""}</span></span>`;
}

export const addrLink = (a: string | null | undefined, label?: string) =>
  a ? html`<a class="link nowrap" href="${explorerAddr(a)}" target="_blank" rel="noopener" title="${a}">${label ?? shortAddr(a)}</a>` : html`<span class="faint">none</span>`;
export const txLink = (s: string, label?: string) => html`<a class="link nowrap" href="${explorerTx(s)}" target="_blank" rel="noopener" title="${s}">${label ?? shortAddr(s)}</a>`;

// ------------------------------------------------------------------------------------------------
// candle chart: OHLC of the pool price after each trade, on a time axis, rendered at real width

export interface CandleSpec {
  tf: string;
  /** candles in US dollars (usdCandles) */
  candles: Candle[];
  /** the curve's start price, drawn as a reference line when present */
  start: number | null;
}

export function candleSlot(spec: CandleSpec, height = 260): Raw {
  return html`<div class="mk-chart" style="height:${height}px" data-candles="${JSON.stringify(spec)}"></div>`;
}

function ticks(lo: number, hi: number, n: number): number[] {
  const span = hi - lo || Math.abs(hi) || 1;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
}

const TF_S: Record<string, number> = { "1m": 60, "5m": 300, "1h": 3600, "1d": 86400 };

function timeLabel(t: number, tf: string): string {
  const d = new Date(t * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  if (tf === "1d") return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function renderCandles(spec: CandleSpec, width: number, height: number): string {
  const cs = spec.candles;
  if (!cs.length) return `<div class="mk-chart-empty">No trades in this range yet.</div>`;
  const W = Math.max(260, Math.floor(width));
  const H = Math.max(160, Math.floor(height));
  const sec = TF_S[spec.tf] ?? 3600;
  const L = 8, R = 62, T = 10, B = 22;
  const VOL = Math.round((H - T - B) * 0.2);
  const plotB = H - B - VOL - 6;
  let lo = Math.min(...cs.map((c) => c.low));
  let hi = Math.max(...cs.map((c) => c.high));
  if (spec.start !== null && Number.isFinite(spec.start)) {
    lo = Math.min(lo, spec.start);
    hi = Math.max(hi, spec.start);
  }
  if (lo === hi) {
    lo -= Math.abs(lo) * 0.05 || 1;
    hi += Math.abs(hi) * 0.05 || 1;
  }
  const pad = (hi - lo) * 0.08;
  lo -= pad;
  hi += pad;
  const t0 = cs[0]!.t;
  const t1 = cs[cs.length - 1]!.t + sec;
  const slots = Math.max(1, Math.round((t1 - t0) / sec));
  const span = Math.max(slots, 24);
  const pw = W - L - R;
  const cw = pw / span;
  const x = (t: number) => L + ((t - t0) / sec) * cw + (span - slots) * cw * 0.5;
  const y = (v: number) => T + ((hi - v) / (hi - lo)) * (plotB - T);
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const out: string[] = [];
  const yt = ticks(lo, hi, H < 220 ? 3 : 4).filter((v) => v >= lo && v <= hi);
  for (const v of yt) {
    const yy = r1(y(v));
    out.push(`<line class="grid" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/>`);
    out.push(`<text x="${W - R + 6}" y="${yy + 3.5}">${esc(fmtUsdPrice(v))}</text>`);
  }
  if (spec.start !== null && Number.isFinite(spec.start)) {
    const ys = r1(y(spec.start));
    out.push(`<line class="ref" x1="${L}" x2="${W - R}" y1="${ys}" y2="${ys}"/><text class="ref" x="${L + 4}" y="${ys - 4}">curve start ${esc(fmtUsdPrice(spec.start))}</text>`);
  }
  const maxV = Math.max(...cs.map((c) => c.volume)) || 1;
  const body = Math.max(1, Math.min(14, cw * 0.66));
  for (const c of cs) {
    const cx = r1(x(c.t) + cw / 2);
    const up = c.close >= c.open;
    const yo = y(c.open), yc = y(c.close);
    const top = r1(Math.min(yo, yc));
    const h = Math.max(1, r1(Math.abs(yc - yo)));
    const tip = `${new Date(c.t * 1000).toLocaleString("en-US")} (${spec.tf})\nopen ${fmtUsdPrice(c.open)}  high ${fmtUsdPrice(c.high)}\nlow ${fmtUsdPrice(c.low)}  close ${fmtUsdPrice(c.close)}\nvolume ${fmtUsd(c.volume)}, ${c.trades} trade${c.trades === 1 ? "" : "s"}`;
    out.push(`<g class="c ${up ? "up" : "down"}" data-tip="${esc(tip)}"><line x1="${cx}" x2="${cx}" y1="${r1(y(c.high))}" y2="${r1(y(c.low))}"/><rect x="${r1(cx - body / 2)}" y="${top}" width="${r1(body)}" height="${h}" rx="1"/>` +
      `<rect class="v" x="${r1(cx - body / 2)}" y="${r1(H - B - (c.volume / maxV) * VOL)}" width="${r1(body)}" height="${Math.max(1, r1((c.volume / maxV) * VOL))}"/><rect class="hit" x="${r1(cx - Math.max(cw, 8) / 2)}" y="${T}" width="${r1(Math.max(cw, 8))}" height="${H - B - T}"/></g>`);
  }
  out.push(`<line class="axis" x1="${L}" x2="${W - R}" y1="${H - B + 0.5}" y2="${H - B + 0.5}"/>`);
  const nx = Math.max(2, Math.floor(pw / 90));
  const step = Math.max(1, Math.ceil(span / nx));
  for (let i = 0; i <= span; i += step) {
    const tt = t0 + (i - (span - slots) * 0.5) * sec;
    const xx = r1(L + i * cw);
    if (xx < L + 12 || xx > W - R - 12) continue;
    out.push(`<text x="${xx}" y="${H - 6}" text-anchor="middle">${esc(timeLabel(tt, spec.tf))}</text>`);
  }
  return `<svg class="mk-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Price in US dollars per token, ${spec.tf} candles">${out.join("")}</svg>`;
}

export function mountCandles(root: ParentNode) {
  for (const el of root.querySelectorAll<HTMLElement>(".mk-chart[data-candles]")) {
    const w = Math.floor(el.clientWidth);
    const key = `${w}:${el.dataset.candles!.length}:${el.dataset.candles!.slice(-64)}`;
    if (w <= 0 || el.dataset.drawn === key) continue;
    el.dataset.drawn = key;
    el.innerHTML = renderCandles(JSON.parse(el.dataset.candles!) as CandleSpec, w, el.clientHeight);
  }
}

/** The candle width that keeps a token's whole history readable. */
export function defaultTf(createdAt: number, now = Date.now() / 1000): string {
  const span = now - createdAt;
  if (span <= 4 * 3600) return "1m";
  if (span <= 36 * 3600) return "5m";
  if (span <= 40 * 86400) return "1h";
  return "1d";
}
