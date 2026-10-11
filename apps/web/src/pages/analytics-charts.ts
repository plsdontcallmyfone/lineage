import { compact } from "../chart.ts";
import { esc, html, type Raw } from "../html.ts";

// Chart helpers for the Analytics page sections (docs/plans/PAGES-PROJECTS-GENERATIONS-ANALYTICS.md 5):
// plain SVG drawn at the container's real width, like insights-ui.ts, with three more forms: stacked
// bars per time bucket (outcomes, launches by kind), lines over time (several series, one axis), and a
// heat grid (minutes live per agent per bucket). Categorical colors follow the series' fixed slot (never
// its rank); status colors (accepted, rejected, cap reached) only mean status. Every mark has a hover
// tip (data-tip, the app's tooltip) and every multi-series chart a legend.

/** Categorical slots in fixed order (the dataviz reference palette, light), then status classes. */
export const SLOTS = 8;
export type Cls = `c${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}` | "ok" | "bad" | "warn" | "mute" | "mute2" | "acc";
export const slot = (i: number): Cls => (`c${(i % SLOTS) + 1}` as Cls);

export interface StackSpec {
  kind: "stack";
  label: string;
  x: string[];
  series: { name: string; cls: Cls; values: number[] }[];
  fmt?: Fmt;
}
export interface LinesSpec {
  kind: "lines";
  label: string;
  series: { name: string; cls: Cls; pts: { t: number; v: number; tip?: string }[]; step?: boolean }[];
  fmt?: Fmt;
  /** dashed reference (zero, a cap) */
  ref?: number | null;
  from?: number;
  to?: number;
  /** fixed x labels (one per day, at its middle) instead of computed ticks */
  xLabels?: { t: number; label: string }[];
}
export interface HeatSpec {
  kind: "heat";
  label: string;
  x: string[];
  rows: { name: string; values: number[] }[];
  /** the value of a full cell (minutes in a bucket) */
  full: number;
  unit: string;
}
type Spec = StackSpec | LinesSpec | HeatSpec;
type Fmt = "num" | "usd" | "pct" | "s" | "min";

export function fmtVal(v: number, f: Fmt = "num"): string {
  if (!Number.isFinite(v)) return "TBA";
  if (f === "usd") return `$${Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4)}`;
  if (f === "pct") return `${v.toFixed(Math.abs(v) >= 10 ? 1 : 2)}%`;
  if (f === "s") return v < 90 ? `${Math.round(v)} s` : v < 5400 ? `${(v / 60).toFixed(1)} min` : `${(v / 3600).toFixed(1)} h`;
  if (f === "min") return v < 90 ? `${Math.round(v)} min` : `${(v / 60).toFixed(1)} h`;
  return Number.isInteger(v) ? v.toLocaleString("en-US") : v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
const tickFmt = (v: number, f: Fmt = "num") => (f === "usd" ? `$${compact(v)}` : f === "pct" ? `${compact(v)}%` : f === "s" ? fmtVal(v, "s") : f === "min" ? fmtVal(v, "min") : compact(v));

/** Bucket labels for an axis from Core (hours or UTC days). */
export function axisLabels(axis: { unit: string; t: number[] }): string[] {
  return axis.t.map((t) => {
    const d = new Date(t);
    return axis.unit === "hour" ? `${String(d.getHours()).padStart(2, "0")}h` : d.toISOString().slice(5, 10);
  });
}

export function vizSlot(spec: Spec, h = 160): Raw {
  return html`<div class="an-viz" style="min-height:${h}px" data-h="${h}" data-viz="${JSON.stringify(spec)}"></div>`;
}

export function legend(items: { name: string; cls: Cls; dash?: boolean }[]): Raw {
  return items.length > 1 ? html`<div class="an-legend">${items.map((i) => html`<span><i class="an-${i.cls}${i.dash ? " dash" : ""}"></i>${i.name}</span>`)}</div>` : html``;
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
/** Ticks in the unit the labels show (hours or minutes for durations), so labels read as round numbers. */
function unitTicks(lo: number, hi: number, n: number, f: Fmt = "num"): number[] {
  const u = f === "s" ? (hi >= 5400 ? 3600 : hi >= 90 ? 60 : 1) : f === "min" ? (hi >= 90 ? 60 : 1) : 1;
  return ticks(lo / u, hi / u, n).map((t) => t * u);
}

function renderStack(s: StackSpec, W: number, H: number): string {
  const n = s.x.length;
  const tot = s.x.map((_, i) => s.series.reduce((a, x) => a + (x.values[i] ?? 0), 0));
  if (!n || tot.every((t) => t === 0)) return `<div class="faint an-none">Nothing in this window.</div>`;
  const max = Math.max(1, ...tot);
  const L = 52, R = 10, T = 8, B = 22;
  const slotW = (W - L - R) / n;
  const bw = Math.max(2, Math.min(28, slotW * 0.7));
  const y = (v: number) => T + (1 - v / max) * (H - T - B);
  const out: string[] = [];
  for (const t of unitTicks(0, max, 3, s.fmt)) out.push(`<line class="g" x1="${L}" x2="${W - R}" y1="${r1(y(t))}" y2="${r1(y(t))}"/><text x="${L - 6}" y="${r1(y(t)) + 3.5}" text-anchor="end">${esc(tickFmt(t, s.fmt))}</text>`);
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - L - R) / 52))));
  for (let i = 0; i < n; i++) {
    const cx = L + slotW * i + slotW / 2;
    let acc = 0;
    const parts = s.series.filter((x) => (x.values[i] ?? 0) > 0);
    const tip = `${s.x[i]}: ${fmtVal(tot[i]!, s.fmt)} in all${parts.length ? "\n" + parts.map((x) => `${x.name} ${fmtVal(x.values[i]!, s.fmt)}`).join("\n") : ""}`;
    parts.forEach((x, k) => {
      const v = x.values[i]!;
      const y0 = y(acc), y1 = y(acc + v);
      acc += v;
      // a 2px surface gap between stacked segments; the top segment gets the rounded end
      const gap = k > 0 ? 1 : 0;
      const hgt = Math.max(0.5, y0 - y1 - gap);
      out.push(`<rect class="an-${x.cls}" x="${r1(cx - bw / 2)}" y="${r1(y1)}" width="${r1(bw)}" height="${r1(hgt)}"${k === parts.length - 1 ? ' rx="2"' : ""} data-tip="${esc(tip)}"/>`);
    });
    if (i % every === 0) out.push(`<text x="${r1(cx)}" y="${H - 6}" text-anchor="middle">${esc(s.x[i]!)}</text>`);
  }
  out.push(`<line class="ax" x1="${L}" x2="${W - R}" y1="${H - B + 0.5}" y2="${H - B + 0.5}"/>`);
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(s.label)}">${out.join("")}</svg>`;
}

function renderLines(s: LinesSpec, W: number, H: number): string {
  const all = s.series.flatMap((x) => x.pts);
  if (!all.length) return `<div class="faint an-none">Nothing measured in this window.</div>`;
  const ys = [...all.map((p) => p.v), ...(s.ref !== undefined && s.ref !== null ? [s.ref] : [])];
  let lo = Math.min(...ys), hi = Math.max(...ys);
  if (lo === hi) (lo -= Math.abs(lo) * 0.05 || 1), (hi += Math.abs(hi) * 0.05 || 1);
  const pad = (hi - lo) * 0.08;
  lo = lo >= 0 && lo - pad < 0 ? 0 : lo - pad;
  hi += pad;
  const t0 = s.from ?? Math.min(...all.map((p) => p.t));
  let t1 = s.to ?? Math.max(...all.map((p) => p.t));
  if (t1 <= t0) t1 = t0 + 3_600_000;
  const L = 52, R = 10, T = 8, B = 22;
  const x = (t: number) => r1(L + ((t - t0) / (t1 - t0)) * (W - L - R));
  const y = (v: number) => r1(T + (1 - (v - lo) / (hi - lo)) * (H - T - B));
  const out: string[] = [];
  for (const t of unitTicks(lo, hi, 3, s.fmt)) {
    if (y(t) < T - 0.5 || y(t) > H - B + 0.5) continue;
    out.push(`<line class="g" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 6}" y="${y(t) + 3.5}" text-anchor="end">${esc(tickFmt(t, s.fmt))}</text>`);
  }
  const span = t1 - t0;
  // at most one tick per day over more than two days, so day labels never repeat
  const nt = Math.max(1, Math.min(6, Math.floor((W - L - R) / 80), span > 2 * 86_400_000 ? Math.floor(span / 86_400_000) : 6));
  if (s.xLabels) {
    const every = Math.max(1, Math.ceil(s.xLabels.length / Math.max(2, Math.floor((W - L - R) / 52))));
    s.xLabels.forEach((l, i) => i % every === 0 && out.push(`<text x="${x(l.t)}" y="${H - 6}" text-anchor="middle">${esc(l.label)}</text>`));
  } else for (let k = 0; k <= nt; k++) {
    const t = t0 + (span * k) / nt;
    const d = new Date(t);
    const lab = span <= 2 * 86_400_000 ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : d.toISOString().slice(5, 10);
    out.push(`<text x="${x(t)}" y="${H - 6}" text-anchor="${k === 0 ? "start" : k === nt ? "end" : "middle"}">${lab}</text>`);
  }
  out.push(`<line class="ax" x1="${L}" x2="${W - R}" y1="${H - B + 0.5}" y2="${H - B + 0.5}"/>`);
  if (s.ref !== undefined && s.ref !== null) out.push(`<line class="ref" x1="${L}" x2="${W - R}" y1="${y(s.ref)}" y2="${y(s.ref)}"/>`);
  for (const ser of s.series) {
    const pts = [...ser.pts].sort((a, b) => a.t - b.t);
    if (!pts.length) continue;
    let d = "";
    pts.forEach((p, i) => {
      if (i === 0) d += `M${x(p.t)},${y(p.v)}`;
      else if (ser.step) d += `H${x(p.t)}V${y(p.v)}`;
      else d += `L${x(p.t)},${y(p.v)}`;
    });
    if (ser.step && s.to !== undefined) d += `H${x(s.to)}`;
    out.push(`<path class="ln an-${ser.cls}" d="${d}"/>`);
    const big = pts.length <= 60;
    for (const p of pts) out.push(`<circle class="pt an-${ser.cls}" cx="${x(p.t)}" cy="${y(p.v)}" r="${big ? 4 : 2.5}" data-tip="${esc(p.tip ?? `${ser.name}: ${fmtVal(p.v, s.fmt)} at ${new Date(p.t).toISOString().slice(0, 16).replace("T", " ")} UTC`)}"/>`);
  }
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(s.label)}">${out.join("")}</svg>`;
}

function renderHeat(s: HeatSpec, W: number): string {
  if (!s.rows.length) return `<div class="faint an-none">No one was live in this window.</div>`;
  const n = s.x.length;
  const LW = Math.min(150, Math.max(90, W * 0.28));
  const cw = (W - LW - 4) / n;
  const ch = 18;
  const H = s.rows.length * (ch + 3) + 20;
  const out: string[] = [];
  s.rows.forEach((r, j) => {
    const yy = j * (ch + 3);
    out.push(`<text class="rl" x="${LW - 8}" y="${yy + 13}" text-anchor="end">${esc(r.name.length > 18 ? r.name.slice(0, 17) + "…" : r.name)}</text>`);
    r.values.forEach((v, i) => {
      const share = Math.max(0, Math.min(1, v / s.full));
      out.push(`<rect class="hc" x="${r1(LW + i * cw + 1)}" y="${yy}" width="${r1(Math.max(1, cw - 2))}" height="${ch}" rx="2" style="fill-opacity:${share === 0 ? 0.06 : (0.18 + share * 0.82).toFixed(3)}" data-tip="${esc(`${r.name}, ${s.x[i]}: ${fmtVal(v, "min")} live (${Math.round(share * 100)}% of the ${s.unit})`)}"/>`);
    });
  });
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - LW) / 48))));
  for (let i = 0; i < n; i += every) out.push(`<text x="${r1(LW + i * cw + cw / 2)}" y="${H - 4}" text-anchor="middle">${esc(s.x[i]!)}</text>`);
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(s.label)}">${out.join("")}</svg>`;
}

export function mountViz(root: ParentNode) {
  for (const el of root.querySelectorAll<HTMLElement>(".an-viz[data-viz]")) {
    const cs = getComputedStyle(el);
    const w = Math.floor(el.clientWidth - parseFloat(cs.paddingLeft || "0") - parseFloat(cs.paddingRight || "0"));
    if (w <= 0 || Number(el.dataset.w) === w) continue;
    el.dataset.w = String(w);
    const spec = JSON.parse(el.dataset.viz!) as Spec;
    const h = Number(el.dataset.h) || 160;
    const W = Math.max(200, w);
    el.innerHTML = spec.kind === "stack" ? renderStack(spec, W, h) : spec.kind === "lines" ? renderLines(spec, W, h) : renderHeat(spec, W);
  }
}

if (typeof window !== "undefined") {
  let t: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener("resize", () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => mountViz(document), 140);
  });
}

export const VIZ_CSS = `
.an-viz{position:relative;padding:6px 12px 4px;min-width:0}
.an-viz svg{display:block;overflow:visible}
.an-viz .g{stroke:var(--border);stroke-width:1}
.an-viz .ax{stroke:var(--border-h);stroke-width:1}
.an-viz .ref{stroke:var(--tt);stroke-width:1;stroke-dasharray:4 4}
.an-viz text{fill:var(--tt);font:400 11px/1 var(--sans);font-variant-numeric:tabular-nums}
.an-viz text.rl{fill:var(--ts,var(--tt));font-size:12px}
.an-viz .ln{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.an-viz .pt{stroke:var(--bg2);stroke-width:2}
.an-viz rect:hover,.an-viz circle:hover{opacity:.8}
.an-viz .hc{fill:var(--series-2)}
.an-none{padding:14px 4px;font-size:13px}
.an-c1{--k:#2a78d6}.an-c2{--k:#eb6834}.an-c3{--k:#1baf7a}.an-c4{--k:#eda100}.an-c5{--k:#e87ba4}.an-c6{--k:#008300}.an-c7{--k:#4a3aa7}.an-c8{--k:#e34948}
.an-ok{--k:var(--good)}.an-bad{--k:var(--bad)}.an-warn{--k:var(--warn)}.an-mute{--k:#a8a59d}.an-mute2{--k:#cfccc4}.an-acc{--k:var(--series-2)}
.an-viz rect[class^="an-"],.an-viz circle.pt{fill:var(--k)}
.an-viz path.ln{stroke:var(--k)}
.an-legend{display:flex;flex-wrap:wrap;gap:4px 14px;padding:0 16px 12px;color:var(--tt);font-size:12px}
.an-legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px;background:var(--k)}
.an-legend i.dash{height:0;border-top:2px dashed var(--k);border-radius:0;background:none;vertical-align:3px}
`;
