import { CandlestickSeries, ColorType, CrosshairMode, createChart, HistogramSeries, LineStyle, type CandlestickData, type HistogramData, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { fmtAmount, fmtPrice, type Candle } from "../market.ts";

// The token page's price chart: TradingView Lightweight Charts (Apache-2.0; the library shows its
// attribution logo, as its licence asks). Candles of the indexer's trades in the quote token with the
// quote volume as a histogram under them, the curve's start price as a dashed reference line, and an
// OHLC legend that follows the crosshair (the last candle otherwise). Colours follow the app's tokens.

export interface TokenChart {
  set(candles: Candle[], start: number | null, label: string): void;
  destroy(): void;
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

  const paintLegend = (c: Candle | undefined) => {
    if (!c) {
      legend.innerHTML = `<b>${label}</b>`;
      return;
    }
    const first = rows[0]?.open ?? c.open;
    const chg = first ? (c.close - first) / first : 0;
    legend.innerHTML = `<b>${label}</b><span class="tk-lg-chg ${chg > 0 ? "up" : chg < 0 ? "down" : ""}">${chg > 0 ? "+" : ""}${(chg * 100).toFixed(2)}%</span><span>O ${fmtPrice(c.open)}</span><span>H ${fmtPrice(c.high)}</span><span>L ${fmtPrice(c.low)}</span><span>C ${fmtPrice(c.close)}</span><span>Vol ${fmtAmount(c.volume)}</span>`;
  };
  chart.subscribeCrosshairMove((p) => {
    const t = p.time as number | undefined;
    paintLegend(t === undefined ? rows[rows.length - 1] : rows.find((r) => r.t === t));
  });

  return {
    set(next, start, lbl) {
      label = lbl;
      const reset = rows.length && next.length && rows[0]!.t !== next[0]!.t;
      rows = [...next].sort((a, b) => a.t - b.t);
      emptyEl.hidden = rows.length > 0;
      const prec = precisionFor(rows);
      candles.applyOptions({ priceFormat: { type: "price", precision: prec, minMove: 10 ** -prec } });
      candles.setData(rows.map((c): CandlestickData => ({ time: c.t as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));
      volume.setData(rows.map((c): HistogramData => ({ time: c.t as UTCTimestamp, value: c.volume, color: (c.close >= c.open ? up : down) + "66" })));
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
