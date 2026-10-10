import { compact } from "../chart.ts";
import { esc, html, raw, type Raw } from "../html.ts";
import { shortId } from "../fmt.ts";

// Shared pieces of the Projects, Generations and Analytics pages
// (docs/plans/PAGES-PROJECTS-GENERATIONS-ANALYTICS.md): query chips and selects that re-render in place,
// plain SVG charts drawn at the container's real width (a line over generation heights, bars per day),
// and the pages' own `ins-` styles on the app's colour tokens. Each page stays a self-contained module
// the owner's developer can restyle; nothing here knows a page's layout.

const CSS = `
.ins-page{display:grid;grid-template-columns:minmax(0,1fr);gap:20px}
.ins-page>*{min-width:0}
.ins-page>.panel+.panel{margin-top:0}
.ins-bar{display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px 12px;padding:12px 16px;border-bottom:1px solid var(--line-soft)}
.ins-bar .seg{overflow-x:auto;max-width:100%;scrollbar-width:none}
.ins-bar.ins-filters{background:var(--panel-2)}
.ins-sel{display:grid;gap:3px;min-width:0;flex:1 1 150px;max-width:220px}
.ins-sel select,.ins-sel input{height:32px;border:0;border-radius:14px;corner-shape:squircle;background:var(--bg);color:var(--text);font:500 13px/1 var(--sans);letter-spacing:-.01em;padding:0 10px;min-width:0;width:100%}
.ins-sel select:focus-visible,.ins-sel input:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.ins-clear{font-size:13px;align-self:center}
.ins-chart{min-height:120px;position:relative}
.ins-chart svg{display:block;overflow:visible}
.ins-chart .g{stroke:var(--border);stroke-width:1}
.ins-chart .ax{stroke:var(--border-h);stroke-width:1}
.ins-chart text{fill:var(--tt);font:400 11px/1 var(--sans);font-variant-numeric:tabular-nums}
.ins-chart .ln{fill:none;stroke:var(--series-2);stroke-width:1.75;stroke-linejoin:round}
.ins-chart .pt{fill:var(--bg2);stroke:var(--series-2);stroke-width:1.75}
.ins-chart .pt.hit{fill:var(--series-2)}
.ins-chart .base{stroke:var(--tt);stroke-width:1;stroke-dasharray:4 4}
.ins-chart .bv1{fill:var(--series-2)}
.ins-chart .bv2{fill:color-mix(in srgb,var(--series-2) 35%,transparent)}
.ins-chart .bv1:hover,.ins-chart .bv2:hover{opacity:.8}
.ins-legend{display:flex;flex-wrap:wrap;gap:4px 14px;padding:0 16px 12px;color:var(--tt);font-size:12px}
.ins-legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px;background:var(--series-2)}
.ins-legend i.l2{background:color-mix(in srgb,var(--series-2) 35%,transparent)}
.ins-legend i.dash{height:0;border-top:1px dashed var(--tt);border-radius:0;background:none;vertical-align:3px}
.ins-pad{padding:14px 16px}
.ins-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:0}
.ins-grid>div{background:var(--bg2);min-width:0;box-shadow:0 0 0 .5px var(--border)}
.ins-mini h3{font:500 13px/1.3 var(--sans);letter-spacing:-.01em;color:var(--tp);padding:12px 16px 0;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
.ins-mini h3 span{color:var(--tt);font-weight:400}
.ins-mini .ins-chart{padding:4px 12px 8px}
.ins-live{display:inline-flex;align-items:center;gap:6px;color:var(--good);font:500 12px/1 var(--sans)}
.ins-live::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--good);box-shadow:0 0 0 3px color-mix(in srgb,var(--good) 20%,transparent)}
.ins-chips{display:flex;flex-wrap:wrap;gap:6px}
.ins-note{color:var(--tt);font-size:12px;line-height:1.45}
.ins-pager{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 16px;border-top:1px solid var(--line-soft);font-size:13px;color:var(--tt);flex-wrap:wrap}
.ins-pager a[aria-disabled="true"]{pointer-events:none;opacity:.4}
.ins-kpis{display:grid;grid-template-columns:repeat(var(--n,4),minmax(0,1fr));gap:1px;background:var(--border)}
.ins-kpis>div{background:var(--bg2);padding:12px 16px;min-width:0}
.ins-kpis b{display:block;font-family:var(--display);font-weight:500;font-size:22px;letter-spacing:-.03em;margin-top:6px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ins-kpis span{color:var(--tt);font-size:12px}
.ins-kpis small{display:block;color:var(--tt);font-size:12px;margin-top:2px;overflow-wrap:anywhere}
@media (max-width:760px){
  .ins-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}
  .ins-sel{max-width:none;flex-basis:calc(50% - 6px)}
  .ins-grid{grid-template-columns:minmax(0,1fr)}
}
`;

export function injectInsightsStyle() {
  if (typeof document === "undefined" || document.getElementById("ins-style")) return;
  const s = document.createElement("style");
  s.id = "ins-style";
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ------------------------------------------------------------------------------------------------ query

export const qs = () => new URLSearchParams(location.search);

/** A link to this page with one query key set (or removed with ""), keeping the others; `drop` keys go away (the page number). */
export function hrefWith(key: string, val: string, drop: string[] = ["page"]): string {
  const p = qs();
  for (const d of drop) p.delete(d);
  if (val === "") p.delete(key);
  else p.set(key, val);
  const s = p.toString();
  return `${location.pathname}${s ? `?${s}` : ""}`;
}

export function chip(key: string, val: string, label: string, cur: string): Raw {
  return html`<a class="seg-b" href="${hrefWith(key, val)}" data-q aria-pressed="${cur === val ? "true" : "false"}">${label}</a>`;
}

export function selectBox(key: string, label: string, opts: [string, string][], cur: string, all = "All"): Raw {
  return html`<label class="ins-sel"><span class="eyebrow">${label}</span><select data-q-key="${key}"><option value="">${all}</option>${opts.map(([v, l]) => html`<option value="${v}"${v === cur ? raw(" selected") : ""}>${l}</option>`)}</select></label>`;
}

export function dateBox(key: string, label: string, cur: string): Raw {
  return html`<label class="ins-sel"><span class="eyebrow">${label}</span><input type="date" data-q-key="${key}" value="${cur}"></label>`;
}

/** Chips, links and fields with data-q change the URL and re-render in place (main.ts follows popstate). */
export function wireInsights(root: HTMLElement) {
  const go = (href: string) => {
    history.pushState(null, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  for (const a of root.querySelectorAll<HTMLAnchorElement>("a[data-q]"))
    a.addEventListener("click", (ev) => {
      if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      ev.preventDefault();
      ev.stopPropagation();
      go(a.getAttribute("href")!);
    });
  for (const s of root.querySelectorAll<HTMLSelectElement | HTMLInputElement>("[data-q-key]"))
    s.addEventListener("change", () => go(hrefWith(s.dataset.qKey!, s.value)));
  mountInsightCharts(root);
}

// ------------------------------------------------------------------------------------------------ format

export const agentLabel = (agent: string | null | undefined, name: string | null | undefined) => name ?? shortId(agent ?? "");

/** USD with enough places for small per-attempt figures. */
export function usd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "TBA";
  const a = Math.abs(v);
  return `${v < 0 ? "-" : ""}$${a >= 100 ? a.toFixed(0) : a >= 1 ? a.toFixed(2) : a.toFixed(4)}`;
}
export const pct = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "TBA" : `${v.toFixed(d)}%`);
export const metricVal = (v: number | null | undefined) => (v === null || v === undefined ? "TBA" : v.toLocaleString("en-US", { maximumFractionDigits: 2 }));
export const hours = (h: number | null | undefined) => (h === null || h === undefined ? "TBA" : h >= 48 ? `${(h / 24).toFixed(1)} d` : `${h.toFixed(1)} h`);
export function secs(s: number | null | undefined): string {
  if (s === null || s === undefined) return "TBA";
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${(s / 60).toFixed(1)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

export function kpis(items: [string, Raw | string, (Raw | string)?][]): Raw {
  return html`<div class="ins-kpis" style="--n:${Math.min(items.length, 6)}">${items.map(([l, v, s]) => html`<div><span>${l}</span><b>${v}</b>${s !== undefined ? html`<small>${s}</small>` : ""}</div>`)}</div>`;
}

// ------------------------------------------------------------------------------------------------ charts

export interface LineSpec {
  type: "line";
  label: string;
  /** dashed reference at this value (the calibration baseline), drawn at x 0 */
  baseline: number | null;
  points: { x: number; y: number; tip: string; hit?: boolean }[];
  xLabel: string;
}
export interface BarSpec {
  type: "bar";
  label: string;
  bars: { label: string; v: number; v2?: number; tip: string }[];
}
type Spec = LineSpec | BarSpec;

export function chartSlot(spec: Spec, h = 160): Raw {
  return html`<div class="ins-chart" style="min-height:${h}px" data-h="${h}" data-ins="${JSON.stringify(spec)}"></div>`;
}

function ticks(lo: number, hi: number, n: number): number[] {
  const span = hi - lo || Math.abs(hi) || 1;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

function renderLine(s: LineSpec, W: number, H: number): string {
  const ys = [...s.points.map((p) => p.y), ...(s.baseline !== null ? [s.baseline] : [])];
  if (!ys.length) return `<div class="faint ins-pad">No measured value yet.</div>`;
  let lo = Math.min(...ys);
  let hi = Math.max(...ys);
  if (lo === hi) (lo -= Math.abs(lo) * 0.02 || 1), (hi += Math.abs(hi) * 0.02 || 1);
  const pad = (hi - lo) * 0.08;
  lo -= pad;
  hi += pad;
  const xs = [0, ...s.points.map((p) => p.x)];
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs, x0 + 1);
  const L = 58, R = 12, T = 8, B = 24;
  const x = (v: number) => r1(L + ((v - x0) / (x1 - x0)) * (W - L - R));
  const y = (v: number) => r1(T + (1 - (v - lo) / (hi - lo)) * (H - T - B));
  const out: string[] = [];
  for (const t of ticks(lo, hi, 3)) {
    if (y(t) < T - 0.5 || y(t) > H - B + 0.5) continue;
    out.push(`<line class="g" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 6}" y="${y(t) + 3.5}" text-anchor="end">${esc(compact(t))}</text>`);
  }
  const xt = ticks(x0, x1, Math.max(2, Math.min(8, Math.floor((W - L - R) / 60)))).filter((t) => Number.isInteger(t));
  for (const t of xt) out.push(`<text x="${x(t)}" y="${H - 6}" text-anchor="middle">${t}</text>`);
  out.push(`<line class="ax" x1="${L}" x2="${W - R}" y1="${H - B + 0.5}" y2="${H - B + 0.5}"/>`);
  if (s.baseline !== null) out.push(`<line class="base" x1="${L}" x2="${W - R}" y1="${y(s.baseline)}" y2="${y(s.baseline)}"><title>${esc(`baseline (calibration) ${s.baseline.toLocaleString("en-US")}`)}</title></line>`);
  const pts = [...s.points].sort((a, b) => a.x - b.x);
  const path = [...(s.baseline !== null ? [{ x: 0, y: s.baseline }] : []), ...pts];
  if (path.length > 1) out.push(`<polyline class="ln" points="${path.map((p) => `${x(p.x)},${y(p.y)}`).join(" ")}"/>`);
  for (const p of pts) out.push(`<circle class="pt${p.hit ? " hit" : ""}" cx="${x(p.x)}" cy="${y(p.y)}" r="3.5" data-tip="${esc(p.tip)}"/>`);
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${s.label}: measured value per ${s.xLabel}`)}">${out.join("")}</svg>`;
}

function renderBars(s: BarSpec, W: number, H: number): string {
  if (!s.bars.length) return `<div class="faint ins-pad">Nothing in this window yet.</div>`;
  const max = Math.max(1, ...s.bars.map((b) => Math.max(b.v, b.v2 ?? 0)));
  const L = 34, R = 6, T = 8, B = 22;
  const n = s.bars.length;
  const slot = (W - L - R) / n;
  const bw = Math.max(1, Math.min(22, slot * 0.7));
  const y = (v: number) => r1(T + (1 - v / max) * (H - T - B));
  const out: string[] = [];
  for (const t of ticks(0, max, 3)) out.push(`<line class="g" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 6}" y="${y(t) + 3.5}" text-anchor="end">${esc(compact(t))}</text>`);
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - L - R) / 56))));
  s.bars.forEach((b, i) => {
    const cx = L + slot * i + slot / 2;
    if (b.v2 !== undefined && b.v2 > 0) out.push(`<rect class="bv2" x="${r1(cx - bw / 2)}" y="${y(b.v2)}" width="${r1(bw)}" height="${r1(H - B - y(b.v2))}" data-tip="${esc(b.tip)}"/>`);
    if (b.v > 0) out.push(`<rect class="bv1" x="${r1(cx - bw / 2)}" y="${y(b.v)}" width="${r1(bw)}" height="${r1(H - B - y(b.v))}" rx="2" data-tip="${esc(b.tip)}"/>`);
    if (i % every === 0) out.push(`<text x="${r1(cx)}" y="${H - 6}" text-anchor="middle">${esc(b.label)}</text>`);
  });
  out.push(`<line class="ax" x1="${L}" x2="${W - R}" y1="${H - B + 0.5}" y2="${H - B + 0.5}"/>`);
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(s.label)}">${out.join("")}</svg>`;
}

export function mountInsightCharts(root: ParentNode) {
  for (const el of root.querySelectorAll<HTMLElement>(".ins-chart[data-ins]")) {
    const cs = getComputedStyle(el);
    const w = Math.floor(el.clientWidth - parseFloat(cs.paddingLeft || "0") - parseFloat(cs.paddingRight || "0"));
    if (w <= 0 || Number(el.dataset.w) === w) continue;
    el.dataset.w = String(w);
    const spec = JSON.parse(el.dataset.ins!) as Spec;
    const h = Number(el.dataset.h) || 160;
    el.innerHTML = spec.type === "line" ? renderLine(spec, Math.max(200, w), h) : renderBars(spec, Math.max(200, w), h);
  }
}

if (typeof window !== "undefined") {
  let t: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener("resize", () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => mountInsightCharts(document), 140);
  });
}
