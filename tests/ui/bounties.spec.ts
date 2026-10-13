import { cleanPage, monoChrome } from "./support/checks.ts";
import { expect, test } from "./support/fixtures.ts";

// Bounties (/bounties, docs/plans/OPEN-BOUNTIES.md 6). On a site whose Core serves no bounty settings
// the page says bounties are not open, in product words, with no form. On a site that does: the
// stats, the onchain limits, one card per bounty with its reward in dollars and in the coin, the post
// form's box, and a bounty's own view with its result. Either way: the content width of the other
// pages, no horizontal scroll, no em dash, no monospace chrome, at 1280 and 390.

const STATUS = /\b(devnet|testnet|test deployment|switched off|built and|coming soon|TBA|todo)\b/i;

test("the Bounties page, open or not, and a bounty's own view", async ({ page }) => {
  await page.goto("/bounties");
  await page.locator(".bo-page .bo-how").first().waitFor({ timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator(".bo-page h1")).toHaveText("Bounties");
  const text = await page.locator(".bo-page").innerText();
  expect(text).not.toMatch(STATUS);
  expect(await monoChrome(page), "monospace on UI chrome").toEqual([]);
  // the content width of Pools, Projects and Analytics: at most 1440 less the page padding, centred
  const box = await page.locator(".bo-page").boundingBox();
  const vw = page.viewportSize()!.width;
  expect(box!.width).toBeLessThanOrEqual(1440);
  expect(Math.abs(box!.x - (vw - box!.x - box!.width))).toBeLessThanOrEqual(2);
  await cleanPage(page);

  const open = (await page.locator("[data-bounty-stats]").count()) > 0;
  if (!open) {
    await expect(page.locator(".bo-page .empty .t1")).toHaveText("Bounties are not open yet");
    await expect(page.locator("[data-bounty-post]")).toHaveCount(0);
    return;
  }
  await expect(page.locator("[data-bounty-rules]")).toContainText("Smallest reward");
  // the post box: a wallet is asked for before anything else
  await expect(page.locator("[data-bounty-post]")).toContainText("Post a bounty", { timeout: 60_000 });
  await cleanPage(page);
  const cards = page.locator("article[data-bounty]");
  test.skip((await cards.count()) === 0, "this site has no bounty yet");
  const first = cards.first();
  // a reward is a dollar figure (or says the price is unavailable) with the coin amount under it
  await expect(first.locator("[data-bounty-amount] .num, [data-bounty-amount] .usd-na").first()).toBeVisible();
  await expect(first.locator(".bo-figs i").first()).toContainText("$UNITS");
  const id = await first.getAttribute("data-bounty");
  await first.locator("a.bo-name").click();
  await page.waitForURL(`**/bounties/${id}`);
  await page.locator(".bo-sec").first().waitFor();
  await expect(page.locator(".bo-sec h2").first()).toHaveText("Result");
  await expect(page.locator(".bo-how h2").first()).toHaveText("How this bounty is decided");
  expect(await page.locator(".bo-page").innerText()).not.toMatch(STATUS);
  expect(await monoChrome(page), "monospace on UI chrome").toEqual([]);
  await cleanPage(page);
});

test("Eco links to Bounties", async ({ page }) => {
  await page.goto("/eco");
  await page.locator(".eco-links").waitFor({ timeout: 60_000 });
  await expect(page.locator('.eco-links a[href="/bounties"]')).toContainText("Bounties");
});
