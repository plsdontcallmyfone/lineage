import { CandlestickSeries, ColorType, CrosshairMode, createChart, HistogramSeries, LineStyle, type CandlestickData, type HistogramData, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { changeFrom, type Candle } from "../market.ts";
import { fmtUsd, fmtUsdPrice, USD_NA } from "../usd.ts";

// The token page's price chart: TradingView Lightweight Charts (Apache-2.0; the library shows its
// attribution logo, as its licence asks). Candles of the indexer's trades in US dollars (the indexer's
// "_usd" candle fields, market.ts usdCandles) with the dollar volume as a histogram under them, the curve's start price as a dashed reference line, and an
// OHLC legend that follows the crosshair (the last candle otherwise). Colours follow the app's tokens.
// The indexer fills every interval (packages/indexer/src/api.ts, candles): one with no trade carries the
// UNITS close at that interval's own dollar price, and the open interval closes at the headline price, so
// the chart runs unbroken from the first trade to now. Such a candle has no volume and its legend says so.
// The legend's percentage is the page's change figure: the indexer's own number while nothing is
// hovered, and for a hovered candle its close over the same reference price (market.ts changeFrom).

export interface TokenChart {
  /** `candles` and `start` in US dollars; `noUsd`: there are trades but no dollar price, so nothing is drawn and the chart says so */
  set(candles: Candle[], start: number | null, label: string, noUsd?: boolean, change?: ChartChange | null): void;
  destroy(): void;
}

/** The page's change figure for the legend: the indexer's percentage and the dollar price it is measured from. */
export interface ChartChange {
  pct: number | null;
  ref: number | null;
  sinceLaunch: boolean;
}

const css = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/** Decimal places that keep four significant digits of the smallest price shown. */
function precisionFor(candles: Candle[]): number {
  const lo = Math.min(...candles.map((c) => c.low).filter((x) => x > 0));
  if (!Number.isFinite(lo)) return 6;
  return Math.min(12, Math.max(2, Math.ceil(-Math.log10(lo)) + 3));
}

export function mountTokenChart(host: HTMLElement): TokenChart {
  host.classList.add("tk-chart");
  host.innerHTML = `<div class="tk-legend"></div><div class="tk-canvas"></div><div class="tk-chart-empty" hidden>No trades in this window yet. Candles appear with the first trade the indexer reads.</div>`;
  const legend = host.querySelector<HTMLElement>(".tk-legend")!;
  const box = host.querySelector<HTMLElement>(".tk-canvas")!;
  const emptyEl = host.querySelector<HTMLElement>(".tk-chart-empty")!;
  const emptyText = emptyEl.textContent ?? "";
  const up = css("--good", "#4f7a12");
  const down = css("--bad", "#c62828");
  const ink = css("--tt", "#6c6962");
  const line = css("--border", "#d3d0c9");
  const chart: IChartApi = createChart(box, {
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: ink, fontFamily: css("--sans", "system-ui"), fontSize: 11 },
    grid: { vertLines: { color: line + "80" }, horzLines: { color: line + "80" } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.26 } },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 4 },
    crosshair: { mode: CrosshairMode.Normal },
  });
  const candles: ISeriesApi<"Candlestick"> = chart.addSeries(CandlestickSeries, { upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down });
  const volume: ISeriesApi<"Histogram"> = chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  let startLine: IPriceLine | null = null;
  let rows: Candle[] = [];
  let label = "";
  let fitted = false;
  let width = 0;
  let change: ChartChange | null = null;

  const paintLegend = (c: Candle | undefined) => {
    if (!c) {
      legend.innerHTML = `<b>${label}</b>`;
      return;
    }
    // the last candle: the indexer's own change figure (the stat beside the chart); any other: its close over the same reference
    const chg = c === rows[rows.length - 1] && change?.pct != null ? change.pct : changeFrom(change?.ref, c.close);
    const pct = chg == null ? "" : `<span class="tk-lg-chg ${chg > 0 ? "up" : chg < 0 ? "down" : ""}" data-v="${chg}" title="${change?.sinceLaunch ? "change of the US dollar price since launch" : "change of the US dollar price against 24 hours ago"}">${chg > 0 ? "+" : ""}${(chg * 100).toFixed(2)}%</span>`;
    legend.innerHTML = `<b>${label}</b>${pct}<span>O ${fmtUsdPrice(c.open)}</span><span>H ${fmtUsdPrice(c.high)}</span><span>L ${fmtUsdPrice(c.low)}</span><span>C ${fmtUsdPrice(c.close)}</span><span>${c.trades === 0 ? "No trades" : `Vol ${fmtUsd(c.volume, { compact: true })}`}</span>`;
  };
  chart.subscribeCrosshairMove((p) => {
    const t = p.time as number | undefined;
    paintLegend(t === undefined ? rows[rows.length - 1] : rows.find((r) => r.t === t));
  });

  return {
    set(next, start, lbl, noUsd = false, chg = null) {
      label = lbl;
      emptyEl.textContent = noUsd ? `${USD_NA}: the US dollar price could not be read, so the chart is not drawn. It returns with the next price reading.` : emptyText;
      change = chg;
      const sorted = [...next].sort((a, b) => a.t - b.t);
      // a different candle width or a different first candle is a new series: the view is fitted again
      const sec = sorted.length > 1 ? sorted[1]!.t - sorted[0]!.t : 0;
      const reset = rows.length && sorted.length && (rows[0]!.t !== sorted[0]!.t || sec !== width);
      width = sec;
      rows = sorted;
      emptyEl.hidden = rows.length > 0;
      const prec = precisionFor(rows);
      // the price scale runs on under the volume bars, below zero: a price is never negative, so no label is drawn there
      candles.applyOptions({ priceFormat: { type: "custom", formatter: (p: number) => (p < 10 ** -prec / 2 ? "" : fmtUsdPrice(p)), minMove: 10 ** -prec } });
      volume.applyOptions({ priceFormat: { type: "custom", formatter: (p: number) => fmtUsd(p, { compact: true }), minMove: 0.01 } });
      candles.setData(rows.map((c): CandlestickData => ({ time: c.t as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));
      volume.setData(rows.map((c): HistogramData => ({ time: c.t as UTCTimestamp, value: c.volume, color: (c.close >= c.open ? up : down) + "66" })));
      host.dataset.candles = String(rows.length);
      host.dataset.tradeCandles = String(rows.filter((c) => c.trades > 0).length);
      if (startLine) candles.removePriceLine(startLine);
      startLine = start ? candles.createPriceLine({ price: start, color: ink, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "start" }) : null;
      if (!fitted || reset) {
        // few candles: keep them at a readable width, anchored to the right edge, instead of stretching them across
        const ts = chart.timeScale();
        if (rows.length * 9 < box.clientWidth) {
          ts.applyOptions({ barSpacing: 9 });
          ts.scrollToRealTime();
        } else ts.fitContent();
        fitted = true;
      }
      paintLegend(rows[rows.length - 1]);
    },
    destroy() {
      chart.remove();
    },
  };
}
