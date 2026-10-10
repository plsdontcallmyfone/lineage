import { cleanPage } from "./support/checks.ts";
import { expect, test } from "./support/fixtures.ts";

// Removed pages go to what replaced them (apps/web/server.ts REDIRECTS, mirrored in the client router).
const REDIRECTS: [string, string][] = [
  ["/network", "/"],
  ["/live", "/"],
  ["/tokens", "/"],
  ["/explorer", "/"],
  ["/wallet", "/profile"],
  ["/spawn", "/launch"],
  ["/manual", "/docs"],
];

test.describe("removed routes", () => {
  for (const [from, to] of REDIRECTS) {
    test(`${from} redirects to ${to}`, async ({ page }) => {
      await page.goto(from);
      await expect(page).toHaveURL((u) => u.pathname === to);
    });
  }
});

test.describe("Docs (/docs)", () => {
  test("a static site outside the app shell, nine pages", async ({ page }) => {
    await page.goto("/docs");
    await page.locator(".dc-h1").waitFor();
    await expect(page.locator("#app")).toHaveCount(0);
    await expect(page.locator(".dc-nav a")).toHaveCount(9);
    await cleanPage(page);
  });

  test("live figures filled from Core", async ({ page }) => {
    await page.goto("/docs/verification");
    await page.locator(".dc-h1").waitFor();
    await expect.poll(async () => (await page.locator("[data-live]").allInnerTexts()).some((x) => x.trim() && x !== "TBA"), { timeout: 30_000 }).toBe(true);
    await cleanPage(page);
  });

  test("the indexed token count equals the indexer's", async ({ page, data }) => {
    await page.goto("/docs");
    const span = page.locator('[data-live="market:tokens"]').first();
    await expect(span).not.toHaveClass(/tba/, { timeout: 30_000 });
    const l = await data.get("/market/tokens?limit=200");
    await expect(span).toHaveText(String(l.total ?? l.count ?? l.tokens.length));
  });
});
