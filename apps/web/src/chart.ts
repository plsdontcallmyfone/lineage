import { esc, html, type Raw } from "./html.ts";

// Sample strip chart: for one metric, a pair of rows per replay (parent "base" and "candidate"),
// one dot per revealed sample, a tick at each median, and a shared x scale so replays compare.
// Rendered at the container's real width (see mountCharts) so text never scales.

export interface SampleRow {
  label: string; // r1, r2, ...
  title: string; // replay id and role, for the tooltip
  base: number[];
  cand: number[];
}
export interface ChartSpec {
  metric: string;
  direction: string;
  rows: SampleRow[];
}

export function chartSlot(spec: ChartSpec): Raw {
  const h = 22 + spec.rows.length * 2 * 15 + spec.rows.length * 6;
  return html`<div class="chart-slot" style="min-height:${h}px" data-chart="${JSON.stringify(spec)}"></div>`;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function compact(n: number, digits?: number): string {
  const a = Math.abs(n);
  const f = (v: number, d: number) => v.toFixed(digits ?? d);
  if (a >= 1e9) return f(n / 1e9, a >= 1e10 ? 1 : 2) + "G";
  if (a >= 1e6) return f(n / 1e6, a >= 1e7 ? 1 : 2) + "M";
  if (a >= 1e4) return f(n / 1e3, a >= 1e5 ? 0 : 1) + "k";
  return Number.isInteger(n) && digits === undefined ? String(n) : n.toFixed(digits ?? 2);
}

/** Tick labels with the fewest decimals that keep every label distinct. */
function tickLabels(ts: number[]): string[] {
  let out = ts.map((t) => compact(t));
  for (let d = 0; d <= 6 && new Set(out).size < out.length; d++) out = ts.map((t) => compact(t, d));
  return out;
}

function niceTicks(lo: number, hi: number, n = 4): number[] {
  const span = hi - lo || Math.abs(hi) || 1;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function renderChart(spec: ChartSpec, width: number): string {
  const all = spec.rows.flatMap((r) => [...r.base, ...r.cand]);
  if (!all.length) return `<div class="faint" style="padding:6px 0">No samples revealed.</div>`;
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (lo === hi) {
    lo -= Math.abs(lo) * 0.01 || 1;
    hi += Math.abs(hi) * 0.01 || 1;
  }
  const pad = (hi - lo) * 0.06;
  lo -= pad;
  hi += pad;
  const L = 74;
  const R = 12;
  const rowH = 15;
  const gap = 6;
  const top = 4;
  const W = Math.max(240, width);
  const x = (v: number) => r1(L + ((v - lo) / (hi - lo)) * (W - L - R));
  const plotH = spec.rows.length * (rowH * 2 + gap) - gap;
  const H = top + plotH + 20;
  const ticks = niceTicks(lo, hi, W < 420 ? 3 : 5);
  const parts: string[] = [];
  const shown = ticks.filter((t) => x(t) >= L - 0.5 && x(t) <= W - R + 0.5);
  const labels = tickLabels(shown);
  shown.forEach((t, i) => {
    const tx = x(t);
    parts.push(`<line class="grid" x1="${tx}" x2="${tx}" y1="${top}" y2="${top + plotH}"/>`);
    parts.push(`<text x="${tx}" y="${top + plotH + 14}" text-anchor="middle">${esc(labels[i]!)}</text>`);
  });
  parts.push(`<line class="axis" x1="${L}" x2="${W - R}" y1="${top + plotH + 0.5}" y2="${top + plotH + 0.5}"/>`);
  spec.rows.forEach((row, i) => {
    const y0 = top + i * (rowH * 2 + gap);
    for (const [k, xs, label] of [
      ["base", row.base, "parent"],
      ["cand", row.cand, "candidate"],
    ] as const) {
      const yc = r1(y0 + (k === "base" ? rowH / 2 : rowH * 1.5));
      parts.push(`<text class="lbl" x="${L - 8}" y="${yc + 3.5}" text-anchor="end">${esc(row.label)} ${k === "base" ? "parent" : "cand"}</text>`);
      if (!xs.length) continue;
      const m = median(xs);
      parts.push(`<line class="med ${k}" x1="${x(m)}" x2="${x(m)}" y1="${yc - 6}" y2="${yc + 6}"/>`);
      for (const v of xs) {
        const tip = `${row.label} ${label} sample: ${v.toLocaleString("en-US")}\nmedian ${m.toLocaleString("en-US")} (${xs.length} samples)\n${row.title}`;
        parts.push(`<circle class="${k}" cx="${x(v)}" cy="${yc}" r="4" data-tip="${esc(tip)}"/>`);
      }
    }
  });
  return `<svg class="chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${spec.metric} samples per replay, parent versus candidate (${spec.direction} is better)`)}">${parts.join("")}</svg>`;
}

export function mountCharts(root: ParentNode) {
  for (const el of root.querySelectorAll<HTMLElement>(".chart-slot")) {
    const spec = JSON.parse(el.dataset.chart!) as ChartSpec;
    const w = Math.floor(el.clientWidth);
    if (w <= 0 || Number(el.dataset.w) === w) continue;
    el.dataset.w = String(w);
    el.innerHTML = renderChart(spec, w);
  }
}
