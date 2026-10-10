import { cleanPage } from "./support/checks.ts";
import { fmtChange, fmtPrice } from "./support/figures.ts";
import { expect, test } from "./support/fixtures.ts";

test.describe("Agents (/agents)", () => {
  test("a directory of listed agents with avatar, tagline, building, token price and change equal to the indexer", async ({ page, data }) => {
    await page.goto("/agents");
    await page.locator(".ag-card, .empty").first().waitFor({ timeout: 60_000 });
    const [tokens, hidden] = await Promise.all([data.tokens(), data.hidden()]);
    const hiddenAgents = new Set(hidden.map((h) => h.agent).filter((a): a is string => !!a));
    const byAgent = new Map(tokens.map((t) => [t.agent, t]));
    const cards = page.locator(".ag-card");
    const n = await cards.count();
    expect(n, "listed agents").toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const card = cards.nth(i);
      const agent = (await card.getAttribute("data-agent"))!;
      expect(hiddenAgents.has(agent), `agent ${agent} is on the hidden list`).toBe(false);
      const row = byAgent.get(agent);
      expect(row, `agent ${agent} has a listed token`).toBeTruthy();
      await expect(card.locator("img.av")).toHaveCount(1);
      await expect(card.locator(".ag-tag")).toHaveText(row.tagline ?? "No tagline yet");
      await expect(card.locator(".bd-building")).toHaveCount(1);
      await expect(card.locator(".ag-tok")).toHaveAttribute("href", `/tokens/${row.mint}`);
      const px = card.locator(".ag-px");
      if (row.price == null) await expect(px).toHaveText("TBA");
      else {
        await expect(px.locator(".bd-num")).toHaveText(fmtPrice(row.price));
        expect.soft(parseFloat((await px.locator(".bd-num").getAttribute("title"))!), "price equals the indexer's").toBe(row.price);
      }
      await expect(card.locator(".ag-chg")).toContainText(fmtChange(row.change_24h));
    }
    await cleanPage(page);
  });
});

test.describe("Eco (/eco)", () => {
  test("agents, projects, leaderboard and feed; no hidden agents; docs link", async ({ page, data }) => {
    await page.goto("/");
    await page.locator("#eco-open").click();
    await page.locator(".eco-page").waitFor({ timeout: 60_000 });
    await expect(page).toHaveURL(/\/eco$/);
    const secs = await page.locator(".eco-sec").evaluateAll((els) => els.map((e) => e.id));
    for (const s of ["eco-agents", "eco-projects", "eco-board", "eco-feed"]) expect(secs).toContain(s);
    const hiddenAgents = new Set((await data.hidden()).map((h) => h.agent).filter((a): a is string => !!a));
    const linked = await page
      .locator(".eco-page [data-agent], .eco-page a[href^='/agents/']")
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.agent ?? (e.getAttribute("href") ?? "").split("/")[2] ?? ""));
    expect(linked.filter((a) => hiddenAgents.has(a)), "hidden agents linked from Eco").toEqual([]);
    await expect(page.locator('.eco-links a[href="/docs"]')).toHaveCount(1);
    await expect(page.locator(".eco-page")).not.toContainText(/fees? (claimed|to compute|split)|crank/i);
    await cleanPage(page);
  });
});
