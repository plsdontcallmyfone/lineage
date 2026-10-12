import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newSoul } from "../../packages/souls/src/schema.ts";
import { cleanPage } from "./support/checks.ts";
import { expect, test, type Page } from "./support/fixtures.ts";
import { MOCK_WALLET_NAME } from "./support/wallet.ts";

// The launch wizard's Identity, Funding and Review steps (owner direction 2026-10-11): two identity
// choices (A units account, the default, and Your own token), everything paid in SOL, a compact
// Funding total with a one-line breakdown that expands, the full breakdown once in Review, and one
// signature. Nothing is signed or sent: the mock wallet refuses and the write guard aborts sends.
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

test("identity, funding and review: two choices, SOL only, one signature; nothing is sent", async ({ page, wallet }, info) => {
  const w = info.project.use.viewport?.width ?? 1280;
  const persona = JSON.parse(readFileSync(join(__dirname, "../../scripts/launch-e2e/STATE.json"), "utf8")).soul_core.doc.persona;
  await page.route("**/souls/draft", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const doc = newSoul({ agent: body.agent, seed: body.seed, persona, created_at: Math.floor(Date.now() / 1000), origin: { by: "model", model: "ui test (a stored soul, no model call)" } as any });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ doc, usd: 0 }) });
  });
  await page.goto("/launch");
  await page.locator(".lz-nav").waitFor({ timeout: 30_000 });
  await connect(page);
  await page.fill('[name="l_name"]', `ui id ${w}`);
  await page.fill('[name="l_desc"]', "A check of the identity and funding steps. Nothing is launched by this run.");
  await page.locator('[name="l_image"]').setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: ONE_PX_PNG });
  await page.click('[data-act="lz-next"]');
  await page.fill('[name="l_repo"]', "https://github.com/keis/base58");
  await page.locator("#w-work .lz-rec, #w-work .banner, #w-work .dim").first().waitFor({ timeout: 60_000 });
  await page.click('[data-act="lz-next"]');
  await page.fill('[name="s_vibe"]', "dry, exact, cheerful about small wins");
  await page.fill('[name="s_specialty"]', "base58 hot paths, same bytes out");
  await page.fill('[name="s_values"]', "measure before claiming, small diffs");
  await page.click('[data-act="soul-generate"]');
  await page.locator(".wl-soul .wl-hash").waitFor({ timeout: 60_000 });
  await page.click('[data-act="lz-next"]');

  // Identity: exactly two choices, A units account (bold, default) and Your own token
  const radios = page.locator('input[name="l_identity"]');
  await expect(radios).toHaveCount(2);
  expect(await radios.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).toEqual(["purchased", "token"]);
  await expect(page.locator('input[name="l_identity"][value="purchased"]')).toBeChecked();
  const id = page.locator('[data-step="3"]');
  await expect(id.locator("b").filter({ hasText: /^A units account$/ })).toHaveCount(1);
  await expect(id).toContainText("a member of the units-agents organization");
  await expect(page.locator("#w-id-price")).toHaveText("0.05 SOL");
  await expect(id).not.toContainText(/App identity|lineage-app|Price TBA|devnet charges nothing/);
  await cleanPage(page);
  await shot(page, "identity", w);
  await page.click('[data-act="lz-next"]');

  // Funding: credits in USD, no pay-with selector, no allocation, no parameters table; one compact total in SOL
  const fund = page.locator('[data-step="4"]');
  await expect(page.locator('[name="l_deposit"]')).toHaveValue("10");
  await expect(fund).not.toContainText(/Pay with|Trading allocation|Launch parameters|First-run budget|\bt?UNITS\b/);
  await expect(page.locator("[data-fronting-total]")).toContainText("SOL", { timeout: 120_000 });
  await expect(page.locator(".lz-sum-more summary")).toHaveText("Token creation · Model credits · Initial buy 1% · A units account");
  await expect(fund).toContainText("one signature");
  await expect(fund).toContainText("Devnet test tokens, no value");
  await page.click(".lz-sum-more summary");
  await expect(page.locator('.lz-sum-lines [data-fronting="A units account"]')).toContainText("0.05 SOL");
  await expect(page.locator('.lz-sum-lines [data-fronting="Model credits"]')).toContainText("10 USD of credits");
  await cleanPage(page);
  await shot(page, "funding", w);

  // Review: the full breakdown once, one signature, Launch never pressed
  test.skip(!wallet.stored, "no stored test wallet: the review simulation needs a funded launcher");
  await page.click('[data-act="lz-next"]');
  await page.locator("#w-launch-out .mark.good, #w-launch-out [data-err]").first().waitFor({ timeout: 120_000 });
  const review = page.locator('[data-step="5"]');
  await expect(review).toContainText(/simulation succeeded on devnet/i);
  await expect(review).toContainText("A units account");
  await expect(review.locator('.lz-fronting [data-fronting="Total"]')).toContainText("SOL");
  await expect(review).toContainText("one signature");
  await expect(page.locator('[data-act="launch-sign"]')).toHaveText("Launch (one signature)");
  await cleanPage(page);
  await shot(page, "review", w);
});
