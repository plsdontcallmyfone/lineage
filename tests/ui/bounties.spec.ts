import { cleanPage, monoChrome } from "./support/checks.ts";
import { expect, test } from "./support/fixtures.ts";
import { MOCK_WALLET_NAME } from "./support/wallet.ts";

// Bounties (/bounties, docs/plans/OPEN-BOUNTIES.md 6). On a site whose Core serves no bounty settings
// the page says bounties are not open, in product words, with no form. On a site that does: the
// stats, the onchain limits, one card per bounty with its reward in dollars and in the coin, the post
// form's box, and a bounty's own view with its result. Either way: the content width of the other
// pages, no horizontal scroll, no em dash, no monospace chrome, at 1280 and 390.

const STATUS = /\b(devnet|testnet|test deployment|switched off|built and|coming soon|TBA|todo)\b/i;
/** The page's own words: a bounty's note is its funder's text, not the app's, and is left out of the wording check. */
const appText = (page: import("@playwright/test").Page) => page.evaluate(() => {
  const el = document.querySelector(".bo-page")!.cloneNode(true) as HTMLElement;
  el.querySelectorAll(".bo-note").forEach((n) => n.remove());
  document.body.appendChild(el);
  const t = el.innerText;
  el.remove();
  return t;
});

test("the Bounties page, open or not, and a bounty's own view", async ({ page }) => {
  await page.goto("/bounties");
  await page.locator(".bo-page .bo-how").first().waitFor({ timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator(".bo-page h1")).toHaveText("Bounties");
  expect(await appText(page)).not.toMatch(STATUS);
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
  // an open bounty of the escrow program has its next step above this section
  await expect(page.locator(".bo-how h2", { hasText: "How this bounty is decided" })).toHaveCount(1);
  expect(await appText(page)).not.toMatch(STATUS);
  expect(await monoChrome(page), "monospace on UI chrome").toEqual([]);
  await cleanPage(page);
});

// Where the escrow program is configured (docs/plans/OPEN-BOUNTIES.md option A): any connected wallet
// gets the form. A reward the wallet cannot pay says exactly what it holds and what it still needs,
// with no purchase offered; a reward it can pay reaches the review with the exact cost, read from the
// chain and simulated. Nothing is signed or sent: the mock wallet refuses and the write guard aborts sends.
test("any wallet posts a bounty: the form, what a short wallet needs, the exact cost before signing", async ({ page, wallet, request }) => {
  const board = await (await request.get("/api/bounties/board")).json().catch(() => null);
  test.skip(!board?.posting?.any_wallet, "this site has no escrow program configured");
  test.skip(!board.units?.length, "this site has no unit a bounty can name");
  await page.goto("/bounties");
  await page.evaluate((n) => localStorage.setItem("lineage-wallet", n), MOCK_WALLET_NAME);
  await page.reload();
  await expect(page.locator('[data-bounty-rules="escrow"]')).toContainText("Any wallet can post");
  const form = page.locator('[data-wallet-form="bounty-post"]');
  await form.waitFor({ timeout: 90_000 });
  // no agent is asked for: the reward is paid from this wallet
  await expect(page.locator("[data-bounty-post]")).not.toContainText("owns no agent");
  const usd = (await page.locator('[data-bounty-post] label:has(input[name="bo_reward"]) .eyebrow').innerText()).includes("dollars");
  const metricMin = board.units[0].metrics[0].min_improvement_bps as number;
  await form.locator('[name="bo_pct"]').fill(String(Math.max(10, metricMin / 100)));
  await form.locator('[name="bo_days"]').fill("3");
  await form.locator('[name="bo_note"]').fill("ui check");
  // the coin's whole supply: far more than any wallet holds
  const price = usd ? ((await (await request.get("/market/quote-usd")).json()).usd as number) : 0;
  await form.locator('[name="bo_reward"]').fill(usd ? String(price * 1_000_000_000) : "1000000000");
  await page.locator('[data-bounty-act="review"]').click();
  const short = page.locator("[data-bounty-short]");
  await short.waitFor({ timeout: 90_000 });
  await expect(page.locator("[data-bounty-post]")).toContainText("This wallet cannot post this bounty yet");
  await expect(short).toContainText("This wallet holds");
  await expect(short.locator("[data-short-coin]")).toBeVisible();
  await expect(page.locator("[data-bounty-post]")).not.toContainText(/swap/i);
  expect(await monoChrome(page), "monospace on UI chrome").toEqual([]);
  await cleanPage(page);
  test.skip(!wallet.stored, "no stored test wallet: the review needs a wallet that holds the coin");
  const min = BigInt(board.escrow.min_amount);
  // the smallest reward the program takes, in whichever unit the form asks for
  await form.locator('[name="bo_reward"]').fill(usd ? String(Math.ceil((Number(min) / 1e6) * price * 1.2 * 1e6) / 1e6) : String(Number(min) / 1e6));
  await page.locator('[data-bounty-act="review"]').click();
  const review = page.locator('[data-bounty-review="wallet"]');
  await review.waitFor({ timeout: 90_000 });
  expect(BigInt((await review.locator("[data-review-amount]").getAttribute("data-review-amount"))!)).toBeGreaterThanOrEqual(min);
  expect(BigInt((await review.locator("[data-review-rent]").getAttribute("data-review-rent"))!)).toBeGreaterThan(0n);
  await expect(review).toContainText("Network fee");
  await expect(review).toContainText("returns to it when the bounty closes");
  await expect(page.locator("[data-bounty-post]")).toContainText("to no other wallet");
  await expect(page.locator('[data-bounty-act="sign"]')).toBeEnabled();
  expect(await monoChrome(page), "monospace on UI chrome").toEqual([]);
  await cleanPage(page);
});

test("a bounty of the escrow program says what the chain checks and offers its next step", async ({ page, request }) => {
  const board = await (await request.get("/api/bounties/board")).json().catch(() => null);
  const row = (board?.bounties ?? []).find((b: any) => b.kind === "escrow");
  test.skip(!row, "this site has no bounty of the escrow program");
  const open = (board.bounties as any[]).find((b) => b.kind === "escrow" && b.status === "open") ?? row;
  await page.goto(`/bounties/${open.bounty_id}`);
  await page.locator(".bo-sec").first().waitFor({ timeout: 60_000 });
  await expect(page.locator(".bo-how", { hasText: "How this bounty is decided" })).toContainText("The earliest such generation wins");
  await expect(page.locator(".bo-how", { hasText: "On chain" })).toContainText("Funded by");
  if (open.status === "open") await expect(page.locator("[data-bounty-next]")).toContainText("Next step", { timeout: 60_000 });
  else await expect(page.locator("[data-bounty-next]")).toHaveCount(0);
  expect(await appText(page)).not.toMatch(STATUS);
  expect(await monoChrome(page), "monospace on UI chrome").toEqual([]);
  await cleanPage(page);
});

test("Eco links to Bounties", async ({ page }) => {
  await page.goto("/eco");
  await page.locator(".eco-links").waitFor({ timeout: 60_000 });
  await expect(page.locator('.eco-links a[href="/bounties"]')).toContainText("Bounties");
});

// The navigation names Bounties only where the board is open: the header link and the footer link are
// added after one read of the board, and a site whose board is closed shows neither.
test("the header and the footer link to Bounties only where the board is open", async ({ page, request }) => {
  const board = await (await request.get("/api/bounties/board")).json().catch(() => null);
  const open = !!board && (!!board.settings || !!board.escrow);
  await page.goto("/");
  await page.locator("header.top nav.nav a").first().waitFor({ timeout: 60_000 });
  const head = page.locator('header.top nav.nav a[href="/bounties"]');
  const foot = page.locator('#footer a.sf-col-link[href="/bounties"]');
  if (!open) {
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await expect(head).toHaveCount(0);
    await expect(foot).toHaveCount(0);
    return;
  }
  await expect(head).toHaveText("Bounties", { timeout: 60_000 });
  await expect(foot).toHaveText("Bounties");
  expect(await monoChrome(page), "monospace on UI chrome").toEqual([]);
  // the header stays on one row with the link in it
  const tops = await page.locator("header.top nav.nav a").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  if (await head.isVisible()) {
    await head.click();
    await page.waitForURL("**/bounties");
    await expect(page.locator(".bo-page h1")).toHaveText("Bounties");
    await expect(page.locator('header.top nav.nav a[href="/bounties"]')).toHaveAttribute("aria-current", "page");
  }
  await cleanPage(page);
});
