import { ApiError } from "./api.ts";
import { esc, html, raw, type Raw } from "./html.ts";

// Launchpad market data (plan L3): a client for the market indexer's read API (packages/indexer,
// served by the dashboard at /market/*, plan L2) and the presentation pieces the token pages share.
// Every figure comes from the indexer as it is; this file only formats it. Prices are in the quote
// token per agent token (tLINE on devnet; on mainnet the network profile's quote, SPEC 14.10): no USD
// price feed is wired, so nothing here is ever shown in USD.

/** The quote token's symbol; a live binding, set from /chain/config's network profile (tLINE until then). */
export let QUOTE = "tLINE";
/** The profile's network: "devnet" until /chain/config says otherwise. */
export let NETWORK: "devnet" | "mainnet" = "devnet";
let explorerQ = "?cluster=devnet";

/** Reads the network profile once (public view, no RPC); true when it changed the labels (mainnet). */
export async function loadNetworkLabels(): Promise<boolean> {
  try {
    const c = (await (await fetch("/chain/config")).json()) as { profile?: { network: "devnet" | "mainnet"; quote: { symbol: string }; explorer_cluster: string | null } };
    if (!c.profile || c.profile.network === "devnet") return false;
    NETWORK = c.profile.network;
    QUOTE = c.profile.quote.symbol;
    explorerQ = c.profile.explorer_cluster ? `?cluster=${c.profile.explorer_cluster}` : "";
    return true;
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
  price: number | null;
  market_cap: number | null;
  volume_24h: number;
  volume_24h_base: number;
  trades_24h: number;
  change_24h: number | null;
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
}

export interface TokenDetail extends TokenSummary {
  decimals: number;
  quote_decimals: number;
  supply: number | null;
  supply_raw: string | null;
  start_price: number | null;
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

/** A price in tLINE per token: six significant digits. */
export function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "TBA";
  return sig6.format(n);
}
/** An amount (tLINE or tokens): whole numbers from 100,000, two places from 1, four significant digits below. */
export function fmtAmount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "TBA";
  const a = Math.abs(n);
  if (a >= 100_000) return zero.format(n);
  if (a >= 1 || a === 0) return two.format(n);
  return sig4.format(n);
}
/** A ratio change (0.05 is +5.00%). */
export function fmtChange(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "TBA";
  const p = n * 100;
  return `${p > 0 ? "+" : p < 0 ? "-" : ""}${two.format(Math.abs(p))}%`;
}
/** Curve progress, a fraction of the migration threshold. */
export function fmtProgress(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "TBA";
  return `${(Math.min(1, Math.max(0, n)) * 100).toFixed(2)}%`;
}
export const fmtInt = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? "TBA" : zero.format(n));

export const shortAddr = (a: string | null | undefined) => (!a ? "" : a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
export const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}${explorerQ}`;
export const explorerAddr = (a: string) => `https://explorer.solana.com/address/${a}${explorerQ}`;

// ------------------------------------------------------------------------------------------------
// components (plain functions returning markup; classes are prefixed mk- so the owner can restyle)

const TBA = html`<span class="faint">TBA</span>`;

/** A figure with its exact indexer value in the title and a data-v the page check compares. */
export function fig(text: string, exact: number | string | null | undefined, unit?: string, field?: string): Raw {
  if (text === "TBA") return TBA;
  return html`<span class="num" data-v="${exact ?? ""}"${field ? raw(` data-f="${esc(field)}"`) : ""} title="${String(exact ?? "")}${unit ? ` ${unit}` : ""}">${text}</span>${unit ? html`<span class="unit">${unit}</span>` : ""}`;
}
export const priceFig = (n: number | null | undefined, field?: string) => fig(fmtPrice(n), n, QUOTE, field);
export const amountFig = (n: number | null | undefined, unit: string, field?: string) => fig(fmtAmount(n), n, unit, field);

export function changeFig(n: number | null | undefined, field?: string): Raw {
  const t = fmtChange(n);
  if (t === "TBA") return TBA;
  return html`<span class="num mk-chg ${n! > 0 ? "up" : n! < 0 ? "down" : ""}" data-v="${n}"${field ? raw(` data-f="${esc(field)}"`) : ""} title="${String(n)}">${t}</span>`;
}

export function phaseBadge(t: Pick<TokenSummary, "phase" | "migrated">): Raw {
  if (t.phase === "graduated") return html`<span class="b good mk-phase" data-phase="graduated">Graduated, DAMM v2</span>`;
  if (t.migrated) return html`<span class="b warn mk-phase" data-phase="migrated">Migrated, graduation pending</span>`;
  return html`<span class="b info mk-phase" data-phase="curve">Bonding curve</span>`;
}

export function progressBar(p: number | null | undefined, field?: string): Raw {
  if (p === null || p === undefined || !Number.isFinite(p)) return TBA;
  const pct = Math.min(1, Math.max(0, p)) * 100;
  return html`<span class="mk-prog"><span class="bar"><i style="width:${pct.toFixed(2)}%"></i></span><span class="num" data-v="${p}"${field ? raw(` data-f="${esc(field)}"`) : ""}>${fmtProgress(p)}</span></span>`;
}

export function tokenLabel(t: Pick<TokenSummary, "name" | "symbol" | "mint">): Raw {
  return html`<span class="mk-tok"><span class="mk-sym">${t.symbol ?? shortAddr(t.mint)}</span><span class="mk-name">${t.name ?? ""}</span></span>`;
}

export const addrLink = (a: string | null | undefined, label?: string) =>
  a ? html`<a class="link nowrap" href="${explorerAddr(a)}" target="_blank" rel="noopener" title="${a}">${label ?? shortAddr(a)}</a>` : TBA;
export const txLink = (s: string, label?: string) => html`<a class="link nowrap" href="${explorerTx(s)}" target="_blank" rel="noopener" title="${s}">${label ?? shortAddr(s)}</a>`;

// ------------------------------------------------------------------------------------------------
// candle chart: OHLC of the pool price after each trade, on a time axis, rendered at real width

export interface CandleSpec {
  tf: string;
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
    out.push(`<text x="${W - R + 6}" y="${yy + 3.5}">${esc(fmtPrice(v))}</text>`);
  }
  if (spec.start !== null && Number.isFinite(spec.start)) {
    const ys = r1(y(spec.start));
    out.push(`<line class="ref" x1="${L}" x2="${W - R}" y1="${ys}" y2="${ys}"/><text class="ref" x="${L + 4}" y="${ys - 4}">curve start ${esc(fmtPrice(spec.start))}</text>`);
  }
  const maxV = Math.max(...cs.map((c) => c.volume)) || 1;
  const body = Math.max(1, Math.min(14, cw * 0.66));
  for (const c of cs) {
    const cx = r1(x(c.t) + cw / 2);
    const up = c.close >= c.open;
    const yo = y(c.open), yc = y(c.close);
    const top = r1(Math.min(yo, yc));
    const h = Math.max(1, r1(Math.abs(yc - yo)));
    const tip = `${new Date(c.t * 1000).toLocaleString("en-US")} (${spec.tf})\nopen ${fmtPrice(c.open)}  high ${fmtPrice(c.high)}\nlow ${fmtPrice(c.low)}  close ${fmtPrice(c.close)} ${QUOTE}\nvolume ${fmtAmount(c.volume)} ${QUOTE}, ${c.trades} trade${c.trades === 1 ? "" : "s"}`;
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
  return `<svg class="mk-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Price in ${QUOTE} per token, ${spec.tf} candles">${out.join("")}</svg>`;
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
