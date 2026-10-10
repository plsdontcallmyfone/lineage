import { expect, type Locator } from "@playwright/test";

// Figures on the page against the indexer's row for the same token. Each figure the app draws carries
// the exact value it was given (a title or data-v attribute); the suite reads that back and compares it
// with the API value, and checks the visible text is that value formatted the way the app formats it.
// The formatters below mirror apps/web/src/market.ts (fmtPrice, fmtAmount, fmtChange); if the app
// changes how it rounds, change them here too.

const sig6 = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 });
const sig4 = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 });
const two = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const zero = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const ok = (n: number | null | undefined): n is number => n !== null && n !== undefined && Number.isFinite(n);

export const fmtPrice = (n: number | null | undefined) => (ok(n) ? sig6.format(n) : "TBA");
export function fmtAmount(n: number | null | undefined) {
  if (!ok(n)) return "TBA";
  const a = Math.abs(n);
  return a >= 100_000 ? zero.format(n) : a >= 1 || a === 0 ? two.format(n) : sig4.format(n);
}
export function fmtChange(n: number | null | undefined) {
  if (!ok(n)) return "TBA";
  const p = n * 100;
  return `${p > 0 ? "+" : p < 0 ? "-" : ""}${two.format(Math.abs(p))}%`;
}

export interface Fig {
  text: string;
  exact: number | null;
}

/** The four cells of a `.bd-params` block (Explorer cards, Profile agents). */
export async function readParams(block: Locator): Promise<{ labels: string[]; figs: Fig[] }> {
  return block.evaluate((el) => {
    const cells = [...el.querySelectorAll(":scope > div")];
    return {
      labels: cells.map((c) => c.querySelector("span")!.textContent!.trim().toLowerCase()),
      figs: cells.map((c) => {
        const b = c.querySelector("b")!;
        const n = b.querySelector<HTMLElement>(".bd-num, .mk-chg");
        const exact = n ? parseFloat((n.getAttribute("title") ?? "").split(" ")[0]!) : null;
        return { text: (n ?? b).textContent!.trim(), exact: Number.isFinite(exact) ? exact : null };
      }),
    };
  });
}

/** price, market cap, 24h volume, 24h change of the page against the API row. */
export function expectFigures(where: string, figs: Fig[], row: { price: number | null; market_cap: number | null; volume_24h: number | null; change_24h: number | null }) {
  const want: [string, number | null, (n: number | null) => string][] = [
    ["price", row.price, fmtPrice],
    ["market cap", row.market_cap, fmtAmount],
    ["24h volume", row.volume_24h, fmtAmount],
    ["24h change", row.change_24h, fmtChange],
  ];
  want.forEach(([name, v, f], i) => {
    const g = figs[i]!;
    expect.soft(g.exact, `${where} ${name}: exact value equals the API's`).toBe(v ?? null);
    expect.soft(g.text, `${where} ${name}: shown as the app formats the API value`).toBe(f(v));
  });
}
