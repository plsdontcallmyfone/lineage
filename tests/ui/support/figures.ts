import { expect, type Locator } from "@playwright/test";
import { fmtUsd, fmtUsdPrice, NO_DATA, USD_NA } from "../../../apps/web/src/usd.ts";

// Figures on the page against the indexer's row for the same token. Money is in US dollars (owner
// 2026-10-12): each figure the app draws carries the exact dollar value it was given (data-v) and the
// API field it came from (data-f, e.g. "price_usd"); the suite reads both back, compares the value with
// the API's "_usd" field and checks the visible text is that value through the app's own dollar
// formatter (apps/web/src/usd.ts, imported here, so the two cannot drift). A figure that exists without
// a dollar price reads "$ unavailable" (USD_NA), one the chain has not produced reads "no data yet" (NO_DATA); a quote-coin
// number is never accepted as money. The 24h change is of the dollar price where the indexer has one
// (change_24h_usd), else against the quote coin (change_24h): the page says which in data-f.

const two = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const ok = (n: number | null | undefined): n is number => n !== null && n !== undefined && Number.isFinite(n);

export { fmtUsd, fmtUsdPrice, USD_NA };
export function fmtChange(n: number | null | undefined) {
  if (!ok(n)) return NO_DATA;
  const p = n * 100;
  return `${p > 0 ? "+" : p < 0 ? "-" : ""}${two.format(Math.abs(p))}%`;
}
/** What a dollar figure reads: `usd` formatted, USD_NA when the quote-coin figure exists without a dollar value, NO_DATA when neither exists. */
export const usdShown = (usd: number | null | undefined, quote: number | null | undefined, o: { price?: boolean; compact?: boolean } = {}) =>
  ok(usd) ? (o.price ? fmtUsdPrice(usd) : fmtUsd(usd, { compact: o.compact })) : ok(quote) ? USD_NA : NO_DATA;

/**
 * The indexer reads the quote coin's dollar price again every 45 s (packages/indexer/src/usd.ts), so the
 * page's read and the suite's read of the same row can carry two readings: the dollar values then differ
 * by that drift while the quote-coin figure is identical. Equal means equal, or within USD_DRIFT.
 */
export const USD_DRIFT = 0.03;
export const sameUsd = (page: number | null, api: number) => page !== null && (page === api || Math.abs(page - api) <= Math.abs(api) * USD_DRIFT);

export interface Fig {
  text: string;
  exact: number | null;
  /** the API field the page says the figure came from (data-f) */
  field: string | null;
}

/** The four cells of a `.bd-params` block (Explorer cards, Profile agents, the agent profile). */
export async function readParams(block: Locator): Promise<{ labels: string[]; figs: Fig[] }> {
  return block.evaluate((el) => {
    const cells = [...el.querySelectorAll(":scope > div")];
    return {
      labels: cells.map((c) => c.querySelector("span")!.textContent!.trim().toLowerCase()),
      figs: cells.map((c) => {
        const b = c.querySelector("b")!;
        const n = b.querySelector<HTMLElement>("[data-v]");
        const v = n?.getAttribute("data-v");
        return { text: (n ?? b).textContent!.trim(), exact: v == null || v === "" ? null : Number(v), field: n?.getAttribute("data-f") ?? null };
      }),
    };
  });
}

export interface UsdRow {
  price: number | null;
  market_cap: number | null;
  volume_24h: number | null;
  change_24h: number | null;
  price_usd: number | null;
  market_cap_usd: number | null;
  volume_24h_usd: number | null;
  change_24h_usd: number | null;
}

/**
 * Price, market cap, 24h volume and 24h change of the page (in that order) against the API row's dollar
 * fields. `compact`: cards write amounts short ("$1.2M"), detail pages in full.
 */
export function expectFigures(where: string, figs: Fig[], row: UsdRow, o: { compact?: boolean } = {}) {
  const money: [string, string, number | null, number | null, { price?: boolean; compact?: boolean }][] = [
    ["price", "price_usd", row.price_usd, row.price, { price: true }],
    ["market cap", "market_cap_usd", row.market_cap_usd, row.market_cap, { compact: o.compact }],
    ["24h volume", "volume_24h_usd", row.volume_24h_usd, row.volume_24h, { compact: o.compact }],
  ];
  money.forEach(([name, field, usd, quote, f], i) => {
    const g = figs[i]!;
    if (!ok(usd)) {
      // no dollar value in the API row: "$ unavailable" when the quote-coin figure exists, else NO_DATA
      expect.soft(g.text, `${where} ${name}: no dollar value in the API's ${field}`).toBe(usdShown(usd, quote, f));
      if (ok(quote)) expect.soft(g.exact, `${where} ${name}: carries no value`).toBeNull();
      return;
    }
    expect.soft(g.field, `${where} ${name}: the figure is the API's ${field}`).toBe(field);
    expect.soft(sameUsd(g.exact, usd), `${where} ${name}: ${g.exact} equals the API's ${field} ${usd} (within the dollar price's drift between two reads)`).toBe(true);
    // the text is the page's own exact value through the app's formatter, and it carries $
    expect.soft(g.text, `${where} ${name}: shown as the app formats its value`).toBe(usdShown(g.exact, quote, f));
    expect.soft(/^-?\$/.test(g.text), `${where} ${name}: carries $ (${g.text})`).toBe(true);
  });
  const g = figs[3]!;
  const inUsd = ok(row.change_24h_usd);
  const chg = inUsd ? row.change_24h_usd : row.change_24h;
  expect.soft(g.text, `${where} 24h change: shown as the app formats its value`).toBe(fmtChange(ok(chg) && inUsd ? g.exact : chg));
  if (ok(chg)) {
    expect.soft(g.field, `${where} 24h change: of the dollar price where the API has one`).toBe(inUsd ? "change_24h_usd" : "change_24h");
    // against the quote coin the change is exact; of the dollar price it moves with the reading
    if (inUsd) expect.soft(g.exact !== null && Math.abs(g.exact - chg) <= USD_DRIFT, `${where} 24h change: ${g.exact} equals the API's ${chg}`).toBe(true);
    else expect.soft(g.exact, `${where} 24h change: exact value equals the API's`).toBe(chg);
  }
}
