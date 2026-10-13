import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newSoul } from "../../packages/souls/src/schema.ts";
import { expect, plainLaunch, test, type Page } from "./support/fixtures.ts";
import { MOCK_WALLET_NAME } from "./support/wallet.ts";

// "Started from a tweet" (docs/plans/TWEET-LAUNCH.md 9): a launch page opened from the reply bot's link
// says which tweet it started from, above the form and as a row in Review, only when Core confirms the
// link's id for the repository in the form. Run through `bun scripts/tweet-launch/origin-ui.ts`, which
// starts a local Core seeded with the links below and hands them over in TWEET_ORIGIN_UI; without it
// every test here skips. Nothing is signed or sent.

const SEED = process.env.TWEET_ORIGIN_UI ? (JSON.parse(process.env.TWEET_ORIGIN_UI) as { good: string; expired: string; unknown: string; used: string; agent: string; mint: string; plain: string; plain_mint: string; handle: string; under_handle: string; tweet_url: string }) : null;
const SHOTS = process.env.UI_SHOTS ?? null;
test.skip(!SEED, "needs the seeded local Core: run bun scripts/tweet-launch/origin-ui.ts");
const S = SEED!;

const width = (info: { project: { use: { viewport?: { width: number } | null } } }) => info.project.use.viewport?.width ?? 1280;
const shot = async (page: Page, name: string, w: number) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `tweet-origin-${name}-${w}.png`), fullPage: true });
};
/** Opens a bot link and waits until Core has answered for its id. */
async function open(page: Page, query: string) {
  const answered = page.waitForResponse((r) => /\/api\/tweet-links\//.test(r.url()), { timeout: 60_000 });
  await page.goto(`/launch?${query}`);
  await page.locator(".lz-nav").waitFor({ timeout: 30_000 });
  await answered;
  await expect(page.locator('[name="l_repo"]')).toHaveValue(/github\.com/);
}
/** The link is the tweet, in a new tab, and the text fits the page. */
async function isTweetLink(page: Page, scope: string) {
  const a = page.locator(`${scope} a[data-tweet-origin-link]`);
  await expect(a).toHaveCount(1);
  await expect(a).toHaveAttribute("href", S.tweet_url);
  await expect(a).toHaveAttribute("target", "_blank");
  await expect(a).toHaveAttribute("rel", /noopener/);
  expect(await a.evaluate((el) => getComputedStyle(el).fontFamily), "no monospace").not.toMatch(/mono|courier/i);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no sideways scroll").toBe(true);
}

test("a link Core confirms: the line above the form and the row in Review link the tweet", async ({ page, wallet }, info) => {
  const w = width(info);
  const persona = JSON.parse(readFileSync(join(__dirname, "../../scripts/launch-e2e/STATE.json"), "utf8")).soul_core.doc.persona;
  await page.route("**/souls/draft", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const doc = newSoul({ agent: body.agent, seed: { vibe: body.vibe || "dry and exacting", specialty: "keis/base58: measured improvements, same behaviour", values: ["measure before claiming"], lines: body.lines ?? "" }, persona, created_at: Math.floor(Date.now() / 1000), origin: { by: "model", model: "ui test (a stored soul, no model call)" } as any });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ doc, usd: 0 }) });
  });
  // stand-ins for this run, nothing is sent: the hosted runtime is not asked to reserve a key (the launch is then built without
  // its bind), and the test wallet reads as holding 5 SOL so the Review step opens (it holds none on mainnet)
  await page.route("**/runtime/bind/*", (r) => (r.request().method() === "POST" ? r.fulfill({ status: 200, contentType: "application/json", body: "{}" }) : r.fallback()));
  await page.route("**/chain/rpc", async (route) => {
    const q = JSON.parse(route.request().postData() ?? "null");
    if (q?.method === "getBalance" && q.params?.[0] === wallet.address) return route.fulfill({ json: { jsonrpc: "2.0", id: q.id, result: { context: { slot: 1 }, value: 5_000_000_000 } } });
    return route.fallback();
  });
  const link = `repo=keis/base58&name=${encodeURIComponent(`from tweet ${w}`)}&ticker=TWEET&tl=${S.good}`;
  await open(page, link);
  // the line, word for word
  const line = page.locator('#lz-origin [data-tweet-origin="line"]');
  await expect(line).toBeVisible();
  await expect(line).toHaveText(`Started from a tweet by @${S.handle}, under a tweet by @${S.under_handle}.`);
  await expect(line.locator("a")).toHaveText(`a tweet by @${S.handle}`);
  await isTweetLink(page, "#lz-origin");
  await expect(line).not.toContainText(/\u2014|devnet|test|status/i);
  // the address holds no handle and no tweet: both came from Core
  expect(page.url()).not.toContain(S.handle);
  expect(page.url()).not.toContain("status");
  await shot(page, "wizard", w);

  // another repository typed in: the tweet did not ask for that one; the link's own repository brings the line back
  await page.locator('[data-act="lz-go"][data-i="0"]').first().waitFor();
  await page.evaluate(() => {
    const el = document.querySelector<HTMLInputElement>('[name="l_repo"]')!;
    el.dataset.was = el.value;
    el.value = "https://github.com/karpathy/minbpe";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#lz-origin")).toBeHidden();
  await expect(page.locator("[data-tweet-origin]")).toHaveCount(0);
  await page.evaluate(() => {
    const el = document.querySelector<HTMLInputElement>('[name="l_repo"]')!;
    el.value = el.dataset.was!;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(line).toBeVisible();

  // through the steps to Review; the line stays above every step
  await page.evaluate((n) => localStorage.setItem("lineage-wallet", n), MOCK_WALLET_NAME);
  await page.reload();
  await page.locator("#cn-btn.on").waitFor({ timeout: 30_000 });
  await expect(line).toBeVisible();
  await expect(page.locator('[name="l_name"]')).toHaveValue(`from tweet ${w}`);
  await expect(page.locator('[name="l_symbol"]')).toHaveValue("TWEET");
  await page.click('[data-act="lz-next"]');
  await page.locator("#w-work .lz-rec, #w-work .banner, #w-work .dim").first().waitFor({ timeout: 60_000 });
  await plainLaunch(page);
  await expect(line).toBeVisible();
  await page.click('[data-act="lz-next"]');
  await page.locator(".wl-soul .wl-hash").waitFor({ timeout: 60_000 });
  await page.click('[data-act="lz-next"]');
  await expect(page.locator("#w-id-price")).not.toHaveText(/^$|price from Core/, { timeout: 60_000 });
  await page.click('[data-act="lz-next"]');
  await expect(page.locator("[data-fronting-total]")).toHaveText(/\$[\d,]*\.?\d+/, { timeout: 60_000 });
  await page.click('[data-act="lz-next"]');
  const row = page.locator('#w-review [data-tweet-origin="review"]');
  await expect(row).toBeVisible({ timeout: 60_000 });
  await expect(row.locator(".eyebrow")).toHaveText("Started from");
  await expect(row.locator(".lz-rv")).toHaveText(`A tweet by @${S.handle}, under a tweet by @${S.under_handle}`);
  await isTweetLink(page, "#w-review");
  // it sits with the other rows, under Repository
  expect(await page.locator("#w-review .lz-rr .eyebrow").allInnerTexts().then((t) => t.map((x) => x.toLowerCase()))).toEqual(expect.arrayContaining(["repository", "started from"]));
  await expect(line).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await shot(page, "review", w);
});

test("an id Core does not confirm shows nothing; the prefill still works", async ({ page }, info) => {
  const w = width(info);
  for (const [why, query] of [
    ["an id nobody registered", `repo=keis/base58&name=Plain&ticker=PLAIN&tl=${S.unknown}`],
    ["an id past its time", `repo=keis/base58&name=Plain&ticker=PLAIN&tl=${S.expired}`],
    ["an id a launch has used", `repo=keis/base58&name=Plain&ticker=PLAIN&tl=${S.used}`],
    ["a real id on a link for another repository, with a handle in the address", `repo=karpathy/minbpe&name=Plain&ticker=PLAIN&tl=${S.good}&handle=${S.handle}&tweet=${encodeURIComponent(S.tweet_url)}`],
  ] as const) {
    await open(page, query);
    await expect(page.locator('[name="l_name"]'), why).toHaveValue("Plain");
    await expect(page.locator('[name="l_symbol"]'), why).toHaveValue("PLAIN");
    await expect(page.locator("#lz-origin"), why).toBeHidden();
    await expect(page.locator("[data-tweet-origin], a[data-tweet-origin-link]"), why).toHaveCount(0);
    await expect(page.locator(".lz-page"), why).not.toContainText(/Started from|tweet by/i);
  }
  await shot(page, "bad-id", w);
});
