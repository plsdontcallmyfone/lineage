import { cleanPage } from "./support/checks.ts";
import { expect, test } from "./support/fixtures.ts";

// Agents do not trade (owner decision 2026-10-12). The app has no agent trading surface: no trading
// page or link, no risk panel, no temperament, no trading allocation, and Core no longer serves the
// routes behind them. People still trade agent coins: the coin page keeps its trade box and its
// transactions list. Read-only: nothing here signs or sends.

const GONE = /trading allocation|fund trading|temperament|risk limits|reduce only|trades today|agent trading|never traded/i;

test.describe("no agent trading", () => {
  test("Core serves none of the trading routes", async ({ request, data }) => {
    const t = (await data.tokens()).find((x) => x.agent);
    test.skip(!t, "no listed coin with an agent");
    for (const p of ["/api/trades", "/api/scores", "/api/trading/config", "/api/trading/risk", "/api/trading/eligibility", `/api/agents/${t.agent}/risk`, `/api/agents/${t.agent}/trades`, `/api/agents/${t.agent}/score`]) {
      const r = await request.get(p);
      expect({ path: p, status: r.status() }).toEqual({ path: p, status: 404 });
    }
    // what stays: the agent's wallet, read from chain
    expect((await request.get(`/api/agents/${t.agent}/wallet`)).status()).toBe(200);
  });

  test("no link to a trading page anywhere in the shell, the Eco page or the agents list", async ({ page }) => {
    for (const p of ["/", "/eco", "/agents"]) {
      await page.goto(p);
      await page.locator("#main .panel, #main .ph-title, #main h1").first().waitFor({ timeout: 60_000 });
      await expect(page.locator('a[href^="/trading"]')).toHaveCount(0);
    }
  });

  test("agent profile: the wallet panel says the key signs no swap; no risk panel, no trading words", async ({ page, data }) => {
    const t = (await data.tokens()).find((x) => x.agent);
    test.skip(!t, "no listed coin with an agent");
    await page.goto(`/agents/${t.agent}/profile`);
    const wallet = page.locator(".wl-panel");
    await wallet.waitFor({ timeout: 60_000 });
    await expect(wallet).toContainText("Agents do not trade");
    await expect(wallet).not.toContainText(/can buy and sell|can swap/i);
    await expect(page.locator("[data-risk-panel]")).toHaveCount(0);
    await expect(page.locator("#main")).not.toContainText(GONE);
    await cleanPage(page);
  });

  test("coin page: the trade box for people is there, with Buy and Sell and the transactions list", async ({ page, data }) => {
    const t = (await data.tokens()).find((x) => x.agent);
    test.skip(!t, "no listed coin with an agent");
    await page.goto(`/tokens/${t.mint}`);
    await page.locator(".mk-statspanel").waitFor({ timeout: 60_000 });
    const box = page.locator(".mk-tradepanel");
    await expect(box).toBeVisible();
    await expect(box.locator('[data-tb="side"][data-side="buy"]')).toBeVisible({ timeout: 60_000 });
    await expect(box.locator('[data-tb="side"][data-side="sell"]')).toBeVisible();
    await expect(box.locator('input[name="tb_amount"]')).toBeVisible();
    await expect(box).not.toContainText(/Trading is off/);
    await page.locator("[data-book-b=trades]").click();
    await expect(page.locator("#mk-trades")).toBeVisible();
    await expect(page.locator("#main")).not.toContainText(GONE);
  });
});
