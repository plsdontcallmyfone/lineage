import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newSoul } from "../../packages/souls/src/schema.ts";
import { cleanPage } from "./support/checks.ts";
import { expect, plainLaunch, test, type Page } from "./support/fixtures.ts";
import { MOCK_WALLET_NAME } from "./support/wallet.ts";

// The launch wizard's Identity, Funding and Review steps (owner direction 2026-10-11): two identity
// choices (A units account, the default, and Your own token), everything paid in SOL, a compact
// Funding total with a one-line breakdown that expands, the full breakdown once in Review, and one
// signature. Every cost leads in US dollars (owner 2026-10-12) with the SOL the wallet pays beside it.
// The wording follows the site's network (data.network()): no devnet text on the mainnet site. Nothing is signed or sent: the mock wallet refuses and the write guard aborts sends.
// Screenshots go to UI_SHOTS when set.

const SHOTS = process.env.UI_SHOTS ?? null;
const ONE_PX_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function connect(page: Page) {
  await page.evaluate((n) => localStorage.setItem("lineage-wallet", n), MOCK_WALLET_NAME);
  await page.reload();
  await page.locator("#cn-btn.on").waitFor({ timeout: 30_000 });
}
const shot = async (page: Page, name: string, w: number) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}-${w}.png`), fullPage: true });
};

test("identity, funding and review: two choices, SOL only, one signature; nothing is sent", async ({ page, wallet, data }, info) => {
  const net = await data.network();
  const usd = /\$[\d,]*\.?\d+/; // a dollar figure
  const w = info.project.use.viewport?.width ?? 1280;
  const persona = JSON.parse(readFileSync(join(__dirname, "../../scripts/launch-e2e/STATE.json"), "utf8")).soul_core.doc.persona;
  await page.route("**/souls/draft", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const doc = newSoul({ agent: body.agent, seed: { vibe: body.vibe || "dry and exacting", specialty: "keis/base58: measured improvements, same behaviour", values: ["measure before claiming"], lines: body.lines ?? "" }, persona, created_at: Math.floor(Date.now() / 1000), origin: { by: "model", model: "ui test (a stored soul, no model call)" } as any });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ doc, usd: 0 }) });
  });
  await page.goto("/launch");
  await page.locator(".lz-nav").waitFor({ timeout: 30_000 });
  await connect(page);
  await page.fill('[name="l_name"]', `ui id ${w}`);
  // the ticker is the launcher's own choice, never filled from the name (owner 2026-10-12)
  await page.fill('[name="l_symbol"]', "UITEST");
  await page.fill('[name="l_desc"]', "A check of the identity and funding steps. Nothing is launched by this run.");
  // the coin image is stored before Review, signed by the agent key (apps/web/wallet/coin-uri.ts): this run stores nothing,
  // so the upload and the read-back of the image are answered here
  await page.route("**/social/media/*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.route("**/coin/image/*", (r) => r.fulfill({ status: 200, contentType: "image/png", body: ONE_PX_PNG }));
  await page.locator('[name="l_image"]').setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: ONE_PX_PNG });
  await page.click('[data-act="lz-next"]');
  await page.fill('[name="l_repo"]', "https://github.com/keis/base58");
  await page.locator("#w-work .lz-rec, #w-work .banner, #w-work .dim").first().waitFor({ timeout: 60_000 });
  await plainLaunch(page);
  await page.click('[data-act="lz-next"]');
  await page.fill('[name="s_vibe"]', "dry, exact, cheerful about small wins");
  // the soul is written without a click; the step has no Specialty or Values input
  await expect(page.locator('[name="s_specialty"], [name="s_values"]')).toHaveCount(0);
  await page.locator(".wl-soul .wl-hash").waitFor({ timeout: 60_000 });
  await page.click('[data-act="lz-next"]');

  // Identity: exactly two choices, A units account (bold, default) and Your own token
  const radios = page.locator('input[name="l_identity"]');
  await expect(radios).toHaveCount(2);
  expect(await radios.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).toEqual(["purchased", "token"]);
  // A units account is the default where the instance sells one; where it does not (no recipient in its
  // config: the mainnet test instance), that option is disabled and Your own token is selected
  await expect(page.locator("#w-id-price")).not.toHaveText(/^$|price from Core/, { timeout: 60_000 });
  const offered = !(await page.locator('input[name="l_identity"][value="purchased"]').isDisabled());
  await expect(page.locator(`input[name="l_identity"][value="${offered ? "purchased" : "token"}"]`)).toBeChecked();
  if (net === "devnet") expect(offered, "the devnet site sells units accounts").toBe(true);
  const id = page.locator('[data-step="3"]');
  await expect(id.locator("b").filter({ hasText: /^A units account$/ })).toHaveCount(1);
  await expect(id).toContainText("a member of the units-agents organization");
  // the price in US dollars with the SOL beside it; an instance that sells no units account says so
  await expect(page.locator("#w-id-price")).toHaveText(net === "devnet" ? /^\$[\d,]*\.?\d+, 0\.03 SOL$/ : /^\$[\d,]*\.?\d+, [\d.]+ SOL$|^not offered here$/);
  const sold = offered;
  // where the deployment gives no account the option is not shown at all (no dead radio), and the own-token path is selected
  if (!offered) {
    await expect(page.locator("#w-id-paid")).toBeHidden();
    await expect(page.locator('input[name="l_identity"][value="token"]')).toBeChecked();
  } else await expect(page.locator("#w-id-paid")).toContainText("Your agent gets access to a GitHub account");
  await expect(page.locator('[data-step="3"]')).not.toContainText(/we operate|not offered here/);
  // (with Your own token selected and none pasted, the step itself says the app identity is used until one is added)
  await expect(id).not.toContainText(offered ? /App identity|lineage-app|Price TBA|devnet charges nothing/ : /lineage-app|Price TBA|devnet charges nothing/);
  if (net === "mainnet") await expect(id).not.toContainText(/devnet|\bTEST\b|test tokens|faucet|tUNITS/i);
  await cleanPage(page);
  await shot(page, "identity", w);
  await page.click('[data-act="lz-next"]');

  // Funding: credits in USD, no pay-with selector, no allocation, no parameters table; one compact total in SOL
  const fund = page.locator('[data-step="4"]');
  await expect(page.locator('[name="l_deposit"]')).toHaveValue("10");
  await expect(fund).not.toContainText(/Pay with|Trading allocation|Launch parameters|First-run budget|\bt?UNITS\b/);
  await expect(fund).toContainText("one signature");
  await expect(page.locator(".lz-sum-more summary")).toHaveText(`Token creation · Model credits · Initial buy 1%${sold ? " · A units account" : ""}`);
  if (net === "devnet") await expect(fund).toContainText("Devnet test tokens, no value");
  else await expect(fund).not.toContainText(/devnet|\bTEST\b|test tokens|faucet|tUNITS/i);
  // the total: US dollars, the SOL the wallet pays beside it. Nothing is simulated (owner 2026-10-12): the
  // figures are arithmetic on chain reads, so they are there for any connected wallet; a wallet that cannot
  // pay (the test wallet is funded on devnet only) reads the figures and one line saying what it holds
  await expect(page.locator("[data-fronting-total]")).toHaveText(usd, { timeout: 60_000 });
  await expect(page.locator("[data-fronting-sol]")).toHaveText(/^[\d.]+ SOL$/);
  await expect(fund).not.toContainText(/simulat/i);
  const covered = (await page.locator("#w-fronting [data-fronting-short]").count()) === 0;
  if (net === "devnet" && wallet.stored) expect(covered, "the funded test wallet covers a launch on devnet").toBe(true);
  if (!covered) await expect(page.locator("#w-fronting [data-fronting-short]")).toContainText(/Launch disabled: the wallet holds .+ SOL; the launch needs .+ SOL/);
  await page.click(".lz-sum-more summary");
  if (sold) await expect(page.locator('.lz-sum-lines [data-fronting="A units account"]')).toContainText(/\$[\d,]*\.?\d+ [\d.]+ SOL/);
  await expect(page.locator('.lz-sum-lines [data-fronting="Model credits"]')).toContainText("$10.00 of credits");
  for (const line of await page.locator(".lz-sum-lines .lz-rr b").allInnerTexts()) expect(line, "a cost line is a dollar figure").toMatch(/^\$/);
  await cleanPage(page);
  await shot(page, "funding", w);

  // Review: the full breakdown once, one signature, Launch never pressed
  test.skip(!wallet.stored, "no stored test wallet: the review needs a launcher key");
  await page.click('[data-act="lz-next"]');
  await page.locator('#w-launch-out [data-act="launch-sign"], #w-launch-out [data-err]').first().waitFor({ timeout: 60_000 });
  const review = page.locator('[data-step="5"]');
  await expect(review).not.toContainText(/simulat/i);
  await expect(review.locator('.lz-fronting [data-fronting="Total"] b')).toHaveText(usd);
  await expect(review.locator('.lz-fronting [data-fronting="Total"]')).toContainText("SOL");
  // Launch is enabled exactly when the wallet covers the total
  if (covered) await expect(review.locator('[data-act="launch-sign"]')).toBeEnabled();
  else await expect(review.locator('[data-act="launch-sign"]')).toBeDisabled();
  if (sold) await expect(review).toContainText("A units account");
  if (net === "mainnet") await expect(review.locator(".lz-fronting")).not.toContainText(/devnet|\bTEST\b|test tokens|faucet|tUNITS/i);
  await expect(review).toContainText("one signature");
  await expect(page.locator('[data-act="launch-sign"]')).toHaveText("Launch (one signature)");
  await cleanPage(page);
  await shot(page, "review", w);
});
