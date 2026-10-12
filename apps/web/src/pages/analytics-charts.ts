import { AreaSeries, ColorType, CrosshairMode, createChart, createSeriesMarkers, HistogramSeries, LineSeries, LineStyle, LineType, type IChartApi, type ISeriesApi, type SeriesType, type UTCTimestamp } from "lightweight-charts";
import { fmtUsd } from "../usd.ts";
import { compact } from "../chart.ts";
import { esc } from "../html.ts";

// The Analytics page's one chart system (docs/plans/PAGES-PROJECTS-GENERATIONS-ANALYTICS.md 6.3).
//
// Time series are TradingView Lightweight Charts (Apache-2.0, already shipped for the token chart;
// the library shows its attribution logo, as its licence asks): areas, lines and columns on one time
// axis, a second measure in its own pane under the first (never a second y axis), a crosshair with an
// HTML tooltip that lists every visible series' exact value at the bucket under the pointer, and a
// legend whose buttons hide and show series. Stacked bars, plain bars and the heat grid are SVG drawn
// at the container's real width, with the same tooltip and legend.
//
// Nothing is interpolated or smoothed: a line joins bucket aggregates with straight segments and marks
// every point, cumulative series are steps, a bucket without a value is a gap. Categorical colours
// follow the series' fixed slot (never its rank); status colours only mean status.

export type Fmt = "num" | "usd" | "pct" | "min" | "s" | "amount";
export type Unit = "hour" | "day" | "event";

/** Categorical slots in fixed order (validated light palette), then status and neutral classes. */
const PAL = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
export const slotColor = (i: number) => PAL[i % PAL.length]!;
const cssVar = (name: string, fallback: string) => (typeof document === "undefined" ? fallback : getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback);
export const tone = {
  good: () => cssVar("--good", "#4f7a12"),
  bad: () => cssVar("--bad", "#c62828"),
  warn: () => cssVar("--warn", "#9a6b00"),
  accent: () => cssVar("--ac", "#7b54f5"),
  mute: () => "#a8a59d",
  mute2: () => "#c9c6be",
};

export function fmtVal(v: number | null | undefined, f: Fmt = "num"): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "no value";
  if (f === "usd") return fmtUsd(v); // the app's one dollar formatter (usd.ts)
  if (f === "pct") return `${v.toFixed(Math.abs(v) >= 10 ? 1 : 2)}%`;
  if (f === "s") return v < 90 ? `${Math.round(v)} s` : v < 5400 ? `${(v / 60).toFixed(1)} min` : `${(v / 3600).toFixed(1)} h`;
  if (f === "min") return v < 90 ? `${Math.round(v * 10) / 10} min` : `${(v / 60).toFixed(1)} h`;
  if (f === "amount") return compact(v);
  return Number.isInteger(v) ? v.toLocaleString("en-US") : v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
const tickFmt = (v: number, f: Fmt) => (f === "usd" ? `$${compact(v)}` : f === "pct" ? `${compact(v)}%` : f === "min" ? (v >= 90 ? `${compact(v / 60)} h` : `${compact(v)} min`) : f === "s" ? fmtVal(v, "s") : compact(v));

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n: number) => String(n).padStart(2, "0");
/** A bucket or an instant, always in UTC and always saying so. */
export function timeLabel(ms: number, unit: Unit): string {
  const d = new Date(ms);
  const day = `${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  if (unit === "day") return `${day} (UTC day)`;
  if (unit === "hour") return `${day}, ${p2(d.getUTCHours())}:00 to ${p2((d.getUTCHours() + 1) % 24)}:00 UTC`;
  return `${day}, ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} UTC`;
}
export const shortDay = (ms: number) => `${MON[new Date(ms).getUTCMonth()]} ${new Date(ms).getUTCDate()}`;
const axisLabel = (ms: number, unit: Unit) => (unit === "hour" ? `${p2(new Date(ms).getUTCHours())}h` : shortDay(ms));

// ------------------------------------------------------------------------------------------------ specs

export interface TimeSeriesDef {
  key: string;
  name: string;
  color: string;
  /** area and line join points; columns are per-bucket totals; step is a cumulative figure */
  kind: "area" | "line" | "columns" | "step";
  fmt: Fmt;
  /** 0 the main pane, 1 the pane under it (a second measure never shares an axis with the first) */
  pane?: 0 | 1;
  /** stacked with the other stacked series of its pane (a cumulative total split by part) */
  stack?: boolean;
  dashed?: boolean;
  /** a fixed value range for the pane (a share between 0 and 100) */
  range?: [number, number];
  /** the value axis starts at zero (counts and amounts, where a floating baseline would exaggerate) */
  fromZero?: boolean;
  points: { t: number; v: number | null }[];
  /** marks on the series (an accepted generation on a price line) */
  marks?: { t: number; text: string }[];
}
export interface TimeSpec {
  kind: "time";
  unit: Unit;
  series: TimeSeriesDef[];
  height: number;
  /** what each pane measures, shown at the pane's top left */
  panes: string[];
  empty: string;
  /** a line under the tooltip's values for a bucket (which generations landed) */
  note?: (t: number) => string | null;
  totalLabel?: string;
}
export interface StackSpec {
  kind: "stack";
  unit: Unit;
  t: number[];
  series: { key: string; name: string; color: string; values: number[] }[];
  fmt: Fmt;
  height: number;
  yLabel: string;
  empty: string;
}
export interface BarsSpec {
  kind: "bars";
  /** one block of horizontal bars per measure, the same rows in each */
  groups: { title: string; fmt: Fmt; color: string; max?: number; /** what a row without a value says */ none?: string; rows: { label: string; sub?: string; v: number | null; note: string; tip: string[] }[] }[];
  empty: string;
}
export interface HeatSpec {
  kind: "heat";
  unit: Unit;
  t: number[];
  rows: { label: string; values: number[] }[];
  /** minutes in a full bucket */
  full: number;
  empty: string;
}
export interface MultiSpec {
  kind: "multi";
  charts: { title: string; sub: string; spec: TimeSpec }[];
  empty: string;
}
export type ChartSpec = TimeSpec | StackSpec | BarsSpec | HeatSpec | MultiSpec;
export interface Legend {
  key: string;
  name: string;
  color: string;
  dashed?: boolean;
}

export interface CardDef {
  id: string;
  /** variants of the same question (count or gain, with or without scripted attempts) */
  variants?: [string, string][];
  build: (variant: string) => ChartSpec;
}

/** What the reader toggled, kept across the page's background refreshes. */
const memory = new Map<string, { variant: string; hidden: Set<string> }>();
const stateOf = (def: CardDef) => memory.get(def.id) ?? memory.set(def.id, { variant: def.variants?.[0]?.[0] ?? "", hidden: new Set() }).get(def.id)!;

// ------------------------------------------------------------------------------------------------ tooltip

interface Tip {
  show(x: number, y: number, head: string, rows: { color?: string; name: string; value: string; dashed?: boolean }[], foot?: string | null): void;
  hide(): void;
}
function tipIn(host: HTMLElement): Tip {
  const el = document.createElement("div");
  el.className = "an-tip";
  el.hidden = true;
  el.setAttribute("role", "status");
  host.appendChild(el);
  return {
    show(x, y, head, rows, foot) {
      el.innerHTML = `<div class="an-tip-h">${esc(head)}</div>${rows.map((r) => `<div class="an-tip-r">${r.color ? `<i class="${r.dashed ? "dash" : ""}" style="--k:${r.color}"></i>` : "<i></i>"}<span>${esc(r.name)}</span><b>${esc(r.value)}</b></div>`).join("")}${foot ? `<div class="an-tip-f">${esc(foot)}</div>` : ""}`;
      el.hidden = false;
      const w = el.offsetWidth, h = el.offsetHeight, W = host.clientWidth, H = host.clientHeight;
      const left = x + 14 + w > W ? Math.max(4, x - 14 - w) : x + 14;
      el.style.left = `${Math.min(left, Math.max(4, W - w - 4))}px`;
      el.style.top = `${Math.max(4, Math.min(y - h / 2, H - h - 4))}px`;
    },
    hide() {
      el.hidden = true;
    },
  };
}

const emptyHtml = (text: string) => `<div class="an-empty">${esc(text)}</div>`;

// ------------------------------------------------------------------------------------------------ time series

/** A solid tint of a colour over the panel surface, so stacked areas cover what is under them. */
function tint(hex: string, share: number): string {
  const bg = cssVar("--bg2", "#e6e5e1");
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const a = p(hex), b = /^#[0-9a-f]{6}$/i.test(bg) ? p(bg) : [230, 229, 225];
  return `#${a.map((v, i) => Math.round(v * share + b[i]! * (1 - share)).toString(16).padStart(2, "0")).join("")}`;
}

function drawTime(host: HTMLElement, spec: TimeSpec, hidden: Set<string>): () => void {
  const vis = spec.series.filter((s) => !hidden.has(s.key));
  if (!spec.series.some((s) => s.points.some((p) => p.v !== null))) {
    host.innerHTML = emptyHtml(spec.empty);
    return () => undefined;
  }
  host.innerHTML = `<div class="an-lwc" style="height:${spec.height}px"></div>${spec.panes.map((p, i) => `<div class="an-pane-l" data-pane="${i}">${esc(p)}</div>`).join("")}`;
  const box = host.querySelector<HTMLElement>(".an-lwc")!;
  const ink = cssVar("--tt", "#6c6962");
  const grid = cssVar("--border", "#d3d0c9");
  const twoPanes = spec.series.some((s) => s.pane === 1);
  const chart: IChartApi = createChart(box, {
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: ink, fontFamily: cssVar("--sans", "system-ui"), fontSize: 11, panes: { enableResize: false, separatorColor: grid } },
    grid: { vertLines: { visible: false }, horzLines: { color: grid + "99" } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.16, bottom: 0.06 } },
    timeScale: { borderVisible: false, timeVisible: spec.unit !== "day", secondsVisible: false, fixLeftEdge: true, fixRightEdge: true, lockVisibleTimeRangeOnResize: true },
    crosshair: { mode: CrosshairMode.Magnet, vertLine: { color: ink + "99", width: 1, style: LineStyle.Dashed, labelVisible: false }, horzLine: { visible: false, labelVisible: false } },
    handleScroll: false,
    handleScale: false,
  });
  // stacks: each stacked series is drawn as the running total up to it, the tallest first, in a solid tint
  const tops = new Map<string, Map<number, number>>();
  for (const pane of [0, 1] as const) {
    const st = vis.filter((s) => s.stack && (s.pane ?? 0) === pane);
    const run = new Map<number, number>();
    for (const s of st) {
      const m = new Map<number, number>();
      for (const p of s.points) {
        const v = (run.get(p.t) ?? 0) + (p.v ?? 0);
        run.set(p.t, v);
        m.set(p.t, v);
      }
      tops.set(s.key, m);
    }
  }
  const sec = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;
  const drawn: { def: TimeSeriesDef; api: ISeriesApi<SeriesType> }[] = [];
  const order = [...vis].sort((a, b) => Number(!!b.stack) - Number(!!a.stack)).sort((a, b) => (a.stack && b.stack ? vis.indexOf(b) - vis.indexOf(a) : 0));
  for (const s of order) {
    const pane = twoPanes ? (s.pane ?? 0) : 0;
    const fmt = { type: "custom" as const, formatter: (v: number) => tickFmt(v, s.fmt), minMove: s.fmt === "num" ? 1 : 0.0001 };
    const base = { priceFormat: fmt, lastValueVisible: false, priceLineVisible: false, crosshairMarkerRadius: 4, crosshairMarkerBorderWidth: 2, crosshairMarkerBorderColor: cssVar("--bg2", "#e6e5e1") };
    const few = s.points.length <= 62;
    let api: ISeriesApi<SeriesType>;
    if (s.kind === "columns") {
      api = chart.addSeries(HistogramSeries, { priceFormat: fmt, lastValueVisible: false, priceLineVisible: false, color: s.color }, pane);
      api.setData(s.points.map((p) => (p.v === null ? { time: sec(p.t) } : { time: sec(p.t), value: p.v })));
    } else if (s.kind === "line" || (s.kind === "area" && !s.stack)) {
      // a bucket without a value is a gap: each run of consecutive values is its own stretch of line,
      // so nothing is drawn across buckets that have no figure (a lone value shows as its marker)
      const runs: { t: number; v: number }[][] = [];
      let open = false;
      for (const p of s.points) {
        if (p.v === null) open = false;
        else {
          if (!open) runs.push([]);
          runs[runs.length - 1]!.push({ t: p.t, v: p.v });
          open = true;
        }
      }
      const all = s.points.map((p) => ({ time: sec(p.t) }));
      api = undefined as unknown as ISeriesApi<SeriesType>;
      for (const run of runs) {
        const has = new Map(run.map((p) => [sec(p.t), p.v]));
        const data = all.map((w) => (has.has(w.time) ? { time: w.time, value: has.get(w.time)! } : w));
        const one =
          s.kind === "line"
            ? chart.addSeries(LineSeries, { ...base, color: s.color, lineWidth: 2, lineType: LineType.Simple, lineStyle: s.dashed ? LineStyle.Dashed : LineStyle.Solid, pointMarkersVisible: few || run.length === 1, pointMarkersRadius: 3 }, pane)
            : chart.addSeries(AreaSeries, { ...base, lineColor: s.color, lineWidth: 2, lineType: LineType.Simple, topColor: s.color + "55", bottomColor: s.color + "05", pointMarkersVisible: few || run.length === 1, pointMarkersRadius: 3 }, pane);
        one.setData(data);
        if (s.range) one.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: s.range![0], maxValue: s.range![1] } }) });
        else if (s.fromZero) one.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: Math.max(1, ...s.points.map((p) => p.v ?? 0)) } }) });
        api ??= one;
      }
      if (!api) continue;
    } else {
      const top = tops.get(s.key);
      const solid = !!s.stack;
      api = chart.addSeries(AreaSeries, {
        ...base,
        lineColor: s.color,
        lineWidth: 2,
        lineType: s.kind === "step" ? LineType.WithSteps : LineType.Simple,
        topColor: solid ? tint(s.color, 0.62) : s.color + "55",
        bottomColor: solid ? tint(s.color, 0.3) : s.color + "05",
        pointMarkersVisible: s.kind === "area" && few,
        pointMarkersRadius: 3,
      }, pane);
      api.setData(s.points.map((p) => (p.v === null && !top ? { time: sec(p.t) } : { time: sec(p.t), value: top ? top.get(p.t)! : p.v! })));
    }
    if (s.range) api.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: s.range![0], maxValue: s.range![1] } }) });
    else if (s.stack) {
      // a filled total starts at zero
      const hi = Math.max(1, ...[...(tops.get(s.key)?.values() ?? [])]);
      const top = Math.max(hi, ...order.filter((x) => x.stack && (x.pane ?? 0) === (s.pane ?? 0)).map((x) => Math.max(0, ...[...(tops.get(x.key)?.values() ?? [])])));
      api.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: top } }) });
    }
    if (s.marks?.length) createSeriesMarkers(api, s.marks.map((m) => ({ time: sec(m.t), position: "aboveBar" as const, shape: "circle" as const, color: tone.good(), text: m.text })));
    drawn.push({ def: s, api });
  }
  if (twoPanes && chart.panes().length > 1) {
    chart.panes()[0]!.setStretchFactor(0.58);
    chart.panes()[1]!.setStretchFactor(0.42);
    const l1 = host.querySelector<HTMLElement>('[data-pane="1"]');
    if (l1) l1.style.top = `${Math.round((spec.height - 26) * 0.58) + 6}px`;
  }
  chart.timeScale().fitContent();
  const tip = tipIn(host);
  const byT = new Map<number, Map<string, number | null>>();
  for (const s of vis) for (const p of s.points) (byT.get(sec(p.t)) ?? byT.set(sec(p.t), new Map()).get(sec(p.t))!).set(s.key, p.v);
  chart.subscribeCrosshairMove((p) => {
    const t = p.time as number | undefined;
    if (t === undefined || !p.point || !byT.has(t)) return tip.hide();
    const row = byT.get(t)!;
    const rows = vis.map((s) => ({ color: s.color, dashed: s.dashed, name: s.name, value: fmtVal(row.get(s.key), s.fmt) }));
    const stacked = vis.filter((s) => s.stack && (s.pane ?? 0) === 0);
    if (stacked.length > 1) rows.push({ color: undefined as unknown as string, dashed: false, name: spec.totalLabel ?? "Total", value: fmtVal(stacked.reduce((n, s) => n + (row.get(s.key) ?? 0), 0), stacked[0]!.fmt) });
    tip.show(p.point.x, p.point.y, timeLabel(t * 1000, spec.unit), rows, spec.note?.(t * 1000));
  });
  return () => chart.remove();
}

// ------------------------------------------------------------------------------------------------ SVG

function niceTicks(hi: number, n: number): number[] {
  const step0 = (hi || 1) / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0;
  const out: number[] = [];
  for (let v = 0; v <= hi + 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
}
const r1 = (n: number) => Math.round(n * 10) / 10;
/** The width a chart may draw in: the host's box without its padding. */
function innerW(host: HTMLElement): number {
  const cs = getComputedStyle(host);
  return Math.max(220, Math.floor(host.clientWidth - parseFloat(cs.paddingLeft || "0") - parseFloat(cs.paddingRight || "0")));
}

function drawStack(host: HTMLElement, s: StackSpec, hidden: Set<string>): () => void {
  const vis = s.series.filter((x) => !hidden.has(x.key));
  const n = s.t.length;
  const tot = s.t.map((_, i) => vis.reduce((a, x) => a + (x.values[i] ?? 0), 0));
  if (!n || s.series.every((x) => x.values.every((v) => !v))) {
    host.innerHTML = emptyHtml(s.empty);
    return () => undefined;
  }
  const W = innerW(host), H = s.height;
  const L = 44, R = 8, T = 22, B = 24;
  const max = Math.max(1, ...tot);
  const tk = niceTicks(max, 4);
  const top = tk[tk.length - 1]! >= max ? tk[tk.length - 1]! : max;
  const slot = (W - L - R) / n;
  const bw = Math.max(3, Math.min(34, slot * 0.68));
  const y = (v: number) => T + (1 - v / top) * (H - T - B);
  const out: string[] = [`<text class="yl" x="0" y="11">${esc(s.yLabel)}</text>`];
  for (const t of tk) out.push(`<line class="g" x1="${L}" x2="${W - R}" y1="${r1(y(t))}" y2="${r1(y(t))}"/><text x="${L - 6}" y="${r1(y(t)) + 3.5}" text-anchor="end">${esc(tickFmt(t, s.fmt))}</text>`);
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - L - R) / 54))));
  for (let i = 0; i < n; i++) {
    const cx = L + slot * i + slot / 2;
    let acc = 0;
    const parts = vis.filter((x) => (x.values[i] ?? 0) > 0);
    parts.forEach((x, k) => {
      const v = x.values[i]!;
      const y0 = y(acc), y1 = y(acc + v);
      acc += v;
      // a 2 px surface gap between segments; the top segment carries the rounded end
      const h = Math.max(1, y0 - y1 - (k > 0 ? 2 : 0));
      const last = k === parts.length - 1;
      out.push(last ? `<path d="M${r1(cx - bw / 2)},${r1(y1 + h)}v${r1(-(h - Math.min(4, h)))}q0,${-Math.min(4, h)} ${Math.min(4, bw / 2)},${-Math.min(4, h)}h${r1(bw - 2 * Math.min(4, bw / 2))}q${Math.min(4, bw / 2)},0 ${Math.min(4, bw / 2)},${Math.min(4, h)}v${r1(h - Math.min(4, h))}z" fill="${x.color}"/>` : `<rect x="${r1(cx - bw / 2)}" y="${r1(y1)}" width="${r1(bw)}" height="${r1(h)}" fill="${x.color}"/>`);
    });
    if (i % every === 0) out.push(`<text x="${r1(cx)}" y="${H - 7}" text-anchor="middle">${esc(axisLabel(s.t[i]!, s.unit))}</text>`);
    out.push(`<rect class="hit" data-i="${i}" x="${r1(L + slot * i)}" y="${T}" width="${r1(slot)}" height="${H - T - B}"/>`);
  }
  out.push(`<line class="ax" x1="${L}" x2="${W - R}" y1="${H - B + 0.5}" y2="${H - B + 0.5}"/>`);
  host.innerHTML = `<svg class="an-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(s.yLabel)}">${out.join("")}</svg>`;
  const tip = tipIn(host);
  const svg = host.querySelector("svg")!;
  const move = (ev: PointerEvent) => {
    const el = (ev.target as Element).closest?.(".hit") as SVGRectElement | null;
    svg.querySelectorAll(".hit.on").forEach((e) => e !== el && e.classList.remove("on"));
    if (!el) return tip.hide();
    el.classList.add("on");
    const i = Number(el.dataset.i);
    const r = host.getBoundingClientRect();
    tip.show(ev.clientX - r.left, ev.clientY - r.top, timeLabel(s.t[i]!, s.unit), [...vis.filter((x) => (x.values[i] ?? 0) > 0).map((x) => ({ color: x.color, name: x.name, value: fmtVal(x.values[i]!, s.fmt) })), { name: tot[i] ? "Total" : "Nothing in this bucket", value: tot[i] ? fmtVal(tot[i]!, s.fmt) : "0" }]);
  };
  const leave = () => (tip.hide(), svg.querySelectorAll(".hit.on").forEach((e) => e.classList.remove("on")));
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerdown", move);
  svg.addEventListener("pointerleave", leave);
  return () => undefined;
}

function drawBars(host: HTMLElement, s: BarsSpec): () => void {
  if (!s.groups.length || s.groups.every((g) => !g.rows.length)) {
    host.innerHTML = emptyHtml(s.empty);
    return () => undefined;
  }
  host.innerHTML = `<div class="an-bars">${s.groups
    .map((g, gi) => {
      const max = g.max ?? Math.max(0, ...g.rows.map((r) => r.v ?? 0));
      return `<div class="an-bar-g"><div class="an-bar-t">${esc(g.title)}</div>${g.rows
        .map((r, ri) => `<div class="an-bar-r" data-g="${gi}" data-r="${ri}" tabindex="0"><div class="an-bar-l"><span>${esc(r.label)}</span>${r.sub ? `<small>${esc(r.sub)}</small>` : ""}</div><div class="an-bar-x">${r.v === null ? "" : `<i style="width:${max > 0 && r.v > 0 ? Math.max(0.6, (r.v / max) * 100).toFixed(2) : 0}%;--k:${g.color}"></i>`}</div><div class="an-bar-v"><b>${esc(r.v === null ? (g.none ?? "no value") : fmtVal(r.v, g.fmt))}</b><small>${esc(r.note)}</small></div></div>`)
        .join("")}</div>`;
    })
    .join("")}</div>`;
  const tip = tipIn(host);
  const show = (el: HTMLElement, x: number, y: number) => {
    const g = s.groups[Number(el.dataset.g)]!, r = g.rows[Number(el.dataset.r)]!;
    tip.show(x, y, r.label, r.tip.map((t) => ({ name: t.split(": ")[0]!, value: t.split(": ").slice(1).join(": ") })));
  };
  const root = host.querySelector<HTMLElement>(".an-bars")!;
  root.addEventListener("pointermove", (ev) => {
    const el = (ev.target as Element).closest?.(".an-bar-r") as HTMLElement | null;
    const b = host.getBoundingClientRect();
    if (el) show(el, ev.clientX - b.left, ev.clientY - b.top);
    else tip.hide();
  });
  root.addEventListener("pointerleave", () => tip.hide());
  root.addEventListener("focusin", (ev) => {
    const el = (ev.target as Element).closest?.(".an-bar-r") as HTMLElement | null;
    if (el) show(el, el.offsetLeft + 120, el.offsetTop + el.offsetHeight);
  });
  root.addEventListener("focusout", () => tip.hide());
  return () => undefined;
}

function drawHeat(host: HTMLElement, s: HeatSpec): () => void {
  if (!s.rows.length || s.rows.every((r) => r.values.every((v) => !v))) {
    host.innerHTML = emptyHtml(s.empty);
    return () => undefined;
  }
  const W = innerW(host);
  const n = s.t.length;
  const LW = Math.min(132, Math.max(84, W * 0.26));
  const cw = (W - LW - 2) / n;
  const ch = 22, gap = 3;
  const H = s.rows.length * (ch + gap) + 22;
  const color = tone.accent();
  const out: string[] = [];
  s.rows.forEach((r, j) => {
    const yy = j * (ch + gap);
    out.push(`<text class="rl" x="${LW - 10}" y="${yy + 15}" text-anchor="end">${esc(r.label.length > 16 ? r.label.slice(0, 15) + "…" : r.label)}</text>`);
    r.values.forEach((v, i) => {
      const share = Math.max(0, Math.min(1, v / s.full));
      out.push(`<rect class="hc" data-j="${j}" data-i="${i}" x="${r1(LW + i * cw + 1)}" y="${yy}" width="${r1(Math.max(1, cw - 2))}" height="${ch}" rx="${Math.min(4, cw / 3)}" fill="${color}" fill-opacity="${share === 0 ? 0.07 : (0.2 + share * 0.8).toFixed(3)}"/>`);
    });
  });
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - LW) / 50))));
  for (let i = 0; i < n; i += every) out.push(`<text x="${r1(LW + i * cw + cw / 2)}" y="${H - 5}" text-anchor="middle">${esc(axisLabel(s.t[i]!, s.unit))}</text>`);
  const per = s.unit === "hour" ? "hour" : "day";
  host.innerHTML = `<svg class="an-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="minutes live per agent per ${per}">${out.join("")}</svg>
    <div class="an-scale"><span>0</span><i style="--k:${color}"></i><span>the whole ${per} (${s.full === 60 ? "60 min" : "24 h"})</span></div>`;
  const tip = tipIn(host);
  const svg = host.querySelector("svg")!;
  const move = (ev: PointerEvent) => {
    const el = (ev.target as Element).closest?.(".hc") as SVGRectElement | null;
    if (!el) return tip.hide();
    const r = s.rows[Number(el.dataset.j)]!, i = Number(el.dataset.i), v = r.values[i] ?? 0;
    const b = host.getBoundingClientRect();
    tip.show(ev.clientX - b.left, ev.clientY - b.top, timeLabel(s.t[i]!, s.unit), [{ color, name: r.label, value: `${fmtVal(v, "min")} live` }, { name: `Share of the ${per}`, value: `${((v / s.full) * 100).toFixed(1)}%` }]);
  };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerdown", move);
  svg.addEventListener("pointerleave", () => tip.hide());
  return () => undefined;
}

// ------------------------------------------------------------------------------------------------ cards

function legendOf(spec: ChartSpec): Legend[] {
  if (spec.kind === "time") return spec.series.map((s) => ({ key: s.key, name: s.name, color: s.color, dashed: s.dashed }));
  if (spec.kind === "stack") return spec.series.filter((s) => s.values.some((v) => v > 0)).map((s) => ({ key: s.key, name: s.name, color: s.color }));
  return [];
}

/**
 * Fills one chart card (`[data-card="<id>"]` with `.an-card-seg`, `.an-card-legend`, `.an-card-body`)
 * and keeps it drawn: variant buttons, legend toggles and the container's width redraw it.
 */
export function mountCard(el: HTMLElement, def: CardDef): () => void {
  const st = stateOf(def);
  const seg = el.querySelector<HTMLElement>(".an-card-seg");
  const lg = el.querySelector<HTMLElement>(".an-card-legend")!;
  const body = el.querySelector<HTMLElement>(".an-card-body")!;
  let dispose: (() => void)[] = [];
  let width = 0;
  const draw = () => {
    for (const d of dispose) d();
    dispose = [];
    const spec = def.build(st.variant);
    width = body.clientWidth;
    if (seg && def.variants) seg.innerHTML = def.variants.map(([k, l]) => `<button type="button" class="seg-b" data-variant="${esc(k)}" aria-pressed="${k === st.variant}">${esc(l)}</button>`).join("");
    const items = legendOf(spec);
    lg.innerHTML = items.length > 1 ? items.map((i) => `<button type="button" class="an-lg" data-key="${esc(i.key)}" aria-pressed="${!st.hidden.has(i.key)}" title="Show or hide ${esc(i.name)}"><i class="${i.dashed ? "dash" : ""}" style="--k:${i.color}"></i>${esc(i.name)}</button>`).join("") : "";
    lg.hidden = items.length <= 1;
    body.classList.remove("an-skel");
    if (spec.kind === "time") dispose.push(drawTime(body, spec, st.hidden));
    else if (spec.kind === "stack") dispose.push(drawStack(body, spec, st.hidden));
    else if (spec.kind === "bars") dispose.push(drawBars(body, spec));
    else if (spec.kind === "heat") dispose.push(drawHeat(body, spec));
    else if (!spec.charts.length) body.innerHTML = emptyHtml(spec.empty);
    else {
      body.innerHTML = `<div class="an-multi">${spec.charts.map((c, i) => `<div class="an-mini"><div class="an-mini-h"><b>${esc(c.title)}</b><span>${esc(c.sub)}</span></div><div class="an-mini-b" data-mini="${i}"></div></div>`).join("")}</div>`;
      spec.charts.forEach((c, i) => dispose.push(drawTime(body.querySelector<HTMLElement>(`[data-mini="${i}"]`)!, c.spec, new Set())));
    }
  };
  const click = (ev: Event) => {
    const b = (ev.target as Element).closest?.("button") as HTMLButtonElement | null;
    if (!b || !el.contains(b)) return;
    if (b.dataset.variant !== undefined) st.variant = b.dataset.variant;
    else if (b.dataset.key !== undefined) {
      if (st.hidden.has(b.dataset.key)) st.hidden.delete(b.dataset.key);
      else st.hidden.add(b.dataset.key);
    } else return;
    draw();
  };
  el.addEventListener("click", click);
  // SVG charts are drawn at the real width; the canvas charts size themselves
  let rz: ReturnType<typeof setTimeout> | null = null;
  const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
    if (Math.abs(body.clientWidth - width) < 2) return;
    if (rz) clearTimeout(rz);
    rz = setTimeout(draw, 120);
  });
  ro?.observe(body);
  draw();
  return () => {
    ro?.disconnect();
    if (rz) clearTimeout(rz);
    el.removeEventListener("click", click);
    for (const d of dispose) d();
  };
}

/** A sparkline of bucket values: straight segments, a gap where a bucket has no value, the last point marked. */
export function sparkline(values: (number | null)[], color: string): string {
  const pts = values.map((v, i) => (v === null || !Number.isFinite(v) ? null : { i, v }));
  const real = pts.filter((p): p is { i: number; v: number } => !!p);
  if (!real.length) return `<div class="an-spark an-spark-none"></div>`;
  const W = 120, H = 34, pad = 3;
  const lo = Math.min(0, ...real.map((p) => p.v)), hi = Math.max(...real.map((p) => p.v));
  const n = Math.max(2, values.length);
  const x = (i: number) => r1(pad + (i / (n - 1)) * (W - 2 * pad));
  const y = (v: number) => r1(H - pad - (hi === lo ? 0.5 : (v - lo) / (hi - lo)) * (H - 2 * pad));
  const runs: { i: number; v: number }[][] = [];
  for (const p of pts) {
    if (!p) runs.push([]);
    else (runs[runs.length - 1] ?? runs[runs.push([]) - 1]!).push(p);
  }
  const id = `sp${Math.abs(Math.round(real.reduce((s, p) => s * 31 + p.v * 1000 + p.i, 7))) % 1e9}${color.replace(/[^a-z0-9]/gi, "")}`;
  const parts = runs.filter((r) => r.length).map((r) => {
    if (r.length === 1) return `<line x1="${x(r[0]!.i) - 0.01}" x2="${x(r[0]!.i)}" y1="${y(r[0]!.v)}" y2="${y(r[0]!.v)}" class="dot" stroke="${color}"/>`;
    const d = r.map((p, k) => `${k ? "L" : "M"}${x(p.i)},${y(p.v)}`).join("");
    return `<path d="${d}L${x(r[r.length - 1]!.i)},${H}L${x(r[0]!.i)},${H}Z" fill="url(#${id})"/><path d="${d}" class="ln" stroke="${color}"/>`;
  });
  const last = real[real.length - 1]!;
  return `<svg class="an-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".32"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>${parts.join("")}<line x1="${x(last.i) - 0.01}" x2="${x(last.i)}" y1="${y(last.v)}" y2="${y(last.v)}" class="dot" stroke="${color}"/></svg>`;
}

export const CHART_CSS = `
.an-card{display:flex;flex-direction:column;min-width:0;margin:0}
.an-card-h{display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px 12px;padding:16px 18px 6px}
.an-card-h h2{font:500 15px/1.25 var(--sans);letter-spacing:-.015em;color:var(--tp)}
.an-card-h p{color:var(--tt);font-size:12px;line-height:1.4;margin-top:3px;max-width:62ch}
.an-card-h>div:first-child{flex:1 1 220px;min-width:0}
.an-card-seg{flex:none}
.an-card-seg:empty{display:none}
.an-card-seg .seg-b{border:0;cursor:pointer;font:500 12px/1 var(--sans)}
.an-card-legend{display:flex;flex-wrap:wrap;gap:4px 6px;padding:2px 14px 4px}
.an-lg{display:inline-flex;align-items:center;gap:6px;border:0;background:none;padding:4px 6px;border-radius:8px;color:var(--ts);font:500 12px/1.2 var(--sans);cursor:pointer}
.an-lg:hover{background:var(--bg3)}
.an-lg:focus-visible,.an-bar-r:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.an-lg i{width:10px;height:10px;border-radius:3px;background:var(--k);flex:none}
.an-lg i.dash,.an-tip-r i.dash{height:0;border-top:2px dashed var(--k);border-radius:0;background:none}
.an-lg[aria-pressed="false"]{color:var(--tt);text-decoration:line-through}
.an-lg[aria-pressed="false"] i{background:none;box-shadow:inset 0 0 0 1.5px var(--tt)}
.an-card-body{position:relative;padding:4px 14px 14px;min-width:0;flex:1}
.an-lwc{width:100%}
.an-pane-l{position:absolute;left:18px;top:6px;z-index:2;pointer-events:none;color:var(--tt);font:500 11px/1.2 var(--sans);background:color-mix(in srgb,var(--bg2) 82%,transparent);padding:1px 4px;border-radius:4px}
.an-empty{display:grid;place-items:center;min-height:140px;padding:22px;text-align:center;color:var(--tt);font-size:13px;line-height:1.45}
.an-svg{display:block;overflow:visible}
.an-svg text{fill:var(--tt);font:400 11px/1 var(--sans);font-variant-numeric:tabular-nums}
.an-svg text.yl{font-weight:500}
.an-svg text.rl{fill:var(--ts);font-size:12px}
.an-svg .g{stroke:var(--border);stroke-width:1}
.an-svg .ax{stroke:var(--border-h);stroke-width:1}
.an-svg .hit{fill:transparent}
.an-svg .hit.on{fill:color-mix(in srgb,var(--tp) 6%,transparent)}
.an-svg .hc:hover{stroke:var(--tp);stroke-width:1.5}
.an-scale{display:flex;align-items:center;gap:8px;padding:8px 2px 0;color:var(--tt);font-size:11px}
.an-scale i{width:96px;height:8px;border-radius:4px;background:linear-gradient(90deg,color-mix(in srgb,var(--k) 8%,transparent),var(--k))}
.an-tip{position:absolute;z-index:5;pointer-events:none;min-width:150px;max-width:280px;padding:9px 11px;border-radius:12px;background:var(--bg);box-shadow:0 0 0 .5px var(--border-h),var(--float-shadow);font:400 12px/1.4 var(--sans);font-variant-numeric:tabular-nums;color:var(--ts)}
.an-tip[hidden]{display:none}
.an-tip-h{font-weight:500;color:var(--tp);margin-bottom:5px}
.an-tip-r{display:grid;grid-template-columns:10px minmax(0,1fr) auto;align-items:center;gap:7px;padding:1px 0}
.an-tip-r i{width:10px;height:10px;border-radius:3px;background:var(--k,transparent)}
.an-tip-r span{color:var(--tt);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.an-tip-r b{font-weight:500;color:var(--tp);white-space:nowrap}
.an-tip-f{margin-top:6px;padding-top:6px;border-top:1px solid var(--border);color:var(--tt)}
.an-bars{display:grid;gap:18px;padding:6px 4px 0}
.an-bar-t{font:500 12px/1.2 var(--sans);color:var(--tt);margin-bottom:8px}
.an-bar-r{display:grid;grid-template-columns:minmax(96px,30%) minmax(0,1fr) minmax(92px,auto);align-items:center;gap:10px;padding:5px 4px;border-radius:8px}
.an-bar-r:hover{background:color-mix(in srgb,var(--tp) 4%,transparent)}
.an-bar-l{min-width:0;font-size:13px;color:var(--tp)}
.an-bar-l span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.an-bar-l small,.an-bar-v small{display:block;color:var(--tt);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.an-bar-x{height:14px;border-radius:4px;background:color-mix(in srgb,var(--tp) 5%,transparent);overflow:hidden}
.an-bar-x i{display:block;height:100%;border-radius:0 4px 4px 0;background:var(--k)}
.an-bar-v{text-align:right;font-variant-numeric:tabular-nums}
.an-bar-v b{font-weight:500;font-size:13px;color:var(--tp)}
.an-multi{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.an-mini{min-width:0;position:relative}
.an-mini-h{display:flex;flex-wrap:wrap;gap:2px 8px;align-items:baseline;font-size:12px;padding:0 4px 2px}
.an-mini-h b{font-weight:500;color:var(--tp)}
.an-mini-h span{color:var(--tt)}
.an-mini-b{position:relative}
.an-spark{display:block;width:100%;height:34px;overflow:visible}
.an-spark .ln{fill:none;stroke-width:1.75;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}
.an-spark .dot{stroke-width:5;stroke-linecap:round;vector-effect:non-scaling-stroke}
.an-spark-none{height:34px;border-bottom:1px dashed var(--border)}
.an-skel{min-height:var(--h,220px);border-radius:12px;margin:6px 14px 14px;padding:0;background:linear-gradient(90deg,var(--bg3),var(--panel-3),var(--bg3));background-size:200% 100%;animation:sk 1.2s linear infinite}
@media (prefers-reduced-motion:reduce){.an-skel{animation:none}}
@media (max-width:640px){.an-bar-r{grid-template-columns:minmax(0,1fr) auto;row-gap:4px}.an-bar-x{grid-column:1 / -1;grid-row:2}.an-card-h{padding:14px 14px 4px}.an-card-body{padding:4px 10px 12px}.an-pane-l{left:14px}}
`;
