import { cleanPage } from "./support/checks.ts";
import { expectFigures, readParams } from "./support/figures.ts";
import { expect, test } from "./support/fixtures.ts";

test.describe("Explorer (/)", () => {
  test("header: Explorer, Agents, Launch; Eco, Connect and the theme toggle", async ({ page }) => {
    await page.goto("/");
    await page.locator(".ex-card, .ex-empty").first().waitFor({ timeout: 60_000 });
    const nav = (await page.locator(".nav a").allInnerTexts()).map((s) => s.trim().toLowerCase());
    expect(nav).toEqual(["explorer", "agents", "launch"]);
    await expect(page.locator(".nav a[aria-current=page]")).toHaveText(/explorer/i);
    await expect(page.locator("a#eco-open[href='/eco']")).toBeVisible();
    await expect(page.locator("#cn-btn")).toBeVisible();
    await expect(page.locator("#theme")).toBeVisible();
    await cleanPage(page);
  });

  test("cards: only listed tokens, four figures equal to the indexer, what the agent is building, no fees", async ({ page, data }) => {
    await page.goto("/");
    await page.locator(".ex-card").first().waitFor({ timeout: 60_000 });
    const [tokens, hidden] = await Promise.all([data.tokens(), data.hidden()]);
    const hiddenMints = new Set(hidden.map((h) => h.mint));
    const byMint = new Map(tokens.map((t) => [t.mint, t]));
    const cards = page.locator(".ex-card");
    const n = await cards.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const card = cards.nth(i);
      const mint = (await card.getAttribute("data-mint"))!;
      expect(hiddenMints.has(mint), `card ${mint} is on the hidden list`).toBe(false);
      const row = byMint.get(mint);
      expect(row, `card ${mint} is a listed token of GET /market/tokens`).toBeTruthy();
      const { labels, figs } = await readParams(card.locator(".bd-params"));
      expect(labels).toEqual(["price", "market cap", "24h volume", "24h change"]);
      expectFigures(`card ${row.symbol ?? mint}`, figs, row);
      await expect(card.locator(".bd-building")).toHaveCount(1);
      const repo = row.building?.repo ?? row.repo_url;
      if (repo) await expect(card.locator(".bd-repo > span")).toHaveAttribute("title", repo);
      if (row.building?.live) await expect(card.locator(".bd-live")).toContainText("Working");
      else if (row.building?.last) await expect(card.locator(".bd-last")).toContainText(`Last improvement: ${row.building.last.metric ?? ""}`.trim());
    }
    const text = (await page.locator(".ex-grid").innerText()).toLowerCase();
    expect(text.match(/.{0,40}(fee|model tba|\d+ verified).{0,40}/)?.[0] ?? null, "fee, model TBA or verified-count text in the grid").toBeNull();
    await cleanPage(page);
  });

  test("a card opens its token page", async ({ page }) => {
    await page.goto("/");
    const card = page.locator(".ex-card").first();
    await card.waitFor({ timeout: 60_000 });
    const mint = await card.getAttribute("data-mint");
    await card.locator(".ex-cardlink").click();
    await expect(page).toHaveURL(new RegExp(`/tokens/${mint}$`));
    await page.locator(".mk-statspanel").waitFor();
  });
});
