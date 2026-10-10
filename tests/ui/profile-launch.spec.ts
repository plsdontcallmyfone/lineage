import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newSoul } from "../../packages/souls/src/schema.ts";
import { cleanPage } from "./support/checks.ts";
import { expectFigures, readParams } from "./support/figures.ts";
import { expect, test, type Page } from "./support/fixtures.ts";

// Profile and Launch with the mock Wallet Standard wallet (support/wallet.ts). Nothing here signs or
// sends a transaction: the wallet refuses, the write guard aborts sends, and the wizard stops at its
// review step (a devnet simulation, which is a read).

const ONE_PX_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function connect(page: Page, address: string) {
  await page.locator("#cn-btn").click();
  await page.locator("#cn-btn.on").waitFor({ timeout: 30_000 });
  await expect(page.locator("#cn-btn.on img.cn-av")).toHaveCount(1);
  expect(await page.locator("#cn-btn").getAttribute("aria-label")).toContain(address.slice(0, 4));
}

test.describe("Profile (/profile)", () => {
  test("disconnected: a single prompt to connect", async ({ page }) => {
    await page.goto("/profile");
    await page.locator(".me-prompt").waitFor({ timeout: 30_000 });
    await expect(page.locator("#me-signed")).toBeHidden();
    await expect(page.locator(".me-prompt")).toContainText("Connect a wallet");
    await cleanPage(page);
  });

  test("connected (mock wallet): my agents with the indexer's figures, holdings, follows, manage, menu, persists", async ({ page, wallet, data }) => {
    await page.goto("/profile");
    await page.locator(".me-prompt").waitFor({ timeout: 30_000 });
    await connect(page, wallet.address);
    const mine = (await data.get(`/market/tokens?launcher=${wallet.address}&sort=newest&limit=200`)).tokens as any[];
    if (!mine.length) {
      await expect(page.locator("#w-mine")).toContainText("has launched no agent");
    } else {
      await page.locator(".me-agents .me-ag").first().waitFor({ timeout: 90_000 });
      for (const t of mine) {
        const card = page.locator(`.me-ag[data-agent="${t.agent}"]`);
        await expect(card, `My agents lists ${t.symbol}`).toHaveCount(1);
        await card.locator(".bd-params").waitFor({ timeout: 60_000 });
        await expect(card.locator(".bd-building")).toHaveCount(1);
        const { labels, figs } = await readParams(card.locator(".bd-params"));
        expect(labels).toEqual(["price", "market cap", "24h volume", "24h change"]);
        expectFigures(`profile ${t.symbol}`, figs, t);
      }
    }
    await expect(page.locator(".wl-bal")).toHaveCount(1);
    await page.locator("#w-hold table, #w-hold [data-none]").first().waitFor({ timeout: 60_000 });
    await page.locator("#w-follow .me-follow, #w-follow [data-none]").first().waitFor({ timeout: 30_000 });
    await expect(page.locator("#me-signed")).not.toContainText(/fees? (claimed|to compute|split)|crank/i);
    await cleanPage(page);

    if (mine.length) {
      await page.locator('[data-act="me-manage"]').first().click();
      await page.locator("#me-manage:not([hidden]) #w-id .kv").first().waitFor({ timeout: 60_000 });
      await expect(page.locator('[data-me-up="avatar"]')).toHaveCount(1);
      await expect(page.locator('[data-act="me-fund"]')).toHaveCount(1);
      await expect(page.locator('[data-act="me-crank"]')).toHaveCount(0);
      await cleanPage(page);
    }

    await page.reload();
    await page.locator("#cn-btn.on").waitFor({ timeout: 30_000 });
    await page.locator("#cn-btn").click();
    const menu = page.locator("#cn-menu");
    await expect(menu).toContainText("My profile");
    await expect(menu).toContainText("Copy address");
    await expect(menu).toContainText("Disconnect");
    await page.keyboard.press("Escape");
  });
});

test.describe("Launch (/launch)", () => {
  test("every wizard step up to the review, with the mock wallet; nothing is sent", async ({ page, wallet }, info) => {
    const narrow = (info.project.use.viewport?.width ?? 1280) < 600;
    // the soul draft is answered here with a stored soul document: no model is paid for
    const persona = JSON.parse(readFileSync(join(__dirname, "../../scripts/launch-e2e/STATE.json"), "utf8")).soul_core.doc.persona;
    await page.route("**/souls/draft", async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}");
      const doc = newSoul({ agent: body.agent, seed: body.seed, persona, created_at: Math.floor(Date.now() / 1000), origin: { by: "model", model: "ui test (a stored soul, no model call)" } as any });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ doc, usd: 0 }) });
    });

    await page.goto("/launch");
    await page.locator(".lz-nav").waitFor({ timeout: 30_000 });
    await expect(page.locator(".lz-step")).toHaveCount(6);
    await expect(page.locator(".lz-step:not([disabled])")).toHaveCount(1);
    await connect(page, wallet.address);

    // 1 coin
    await page.fill('[name="l_name"]', `ui test ${narrow ? 390 : 1280}`);
    await page.fill('[name="l_desc"]', "A check of the launch wizard. Nothing is launched by this run.");
    await page.locator('[name="l_image"]').setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: ONE_PX_PNG });
    await page.fill('[name="l_links"]', "https://example.com");
    await page.locator('[data-act="lz-next"]:not([disabled])').waitFor({ timeout: 10_000 });
    await cleanPage(page);
    await page.click('[data-act="lz-next"]');

    // 2 work: targets read from Core for the repository
    await page.fill('[name="l_repo"]', "https://github.com/keis/base58");
    await page.locator("#w-work .lz-rec, #w-work .banner").first().waitFor({ timeout: 60_000 });
    await expect(page.locator("#w-work")).toContainText("base58-py");
    await expect(page.locator("#w-work")).toContainText("_ir");
    await page.click('[data-act="lz-next"]');

    // 3 agent: soul drafted (stored doc), temperament read back, model table
    await page.fill('[name="s_vibe"]', "dry, exact, cheerful about small wins");
    await page.fill('[name="s_specialty"]', "base58 hot paths, same bytes out");
    await page.fill('[name="s_values"]', "measure before claiming, small diffs");
    await page.locator('input[name="l_temp"][value="balanced"]').check();
    await page.click('[data-act="soul-generate"]');
    await page.locator(".wl-soul .wl-hash").waitFor({ timeout: 60_000 });
    await page.locator('[name="l_model"]').first().waitFor({ timeout: 30_000 });
    await expect(page.locator("#w-temp-eff")).toContainText("balanced");
    expect(await page.locator(".wl-prov-i").count()).toBeGreaterThanOrEqual(2);
    await cleanPage(page);
    await page.click('[data-act="lz-next"]');

    // 4 identity
    await page.locator('input[name="l_identity"][value="token"]').check();
    await expect(page.locator('[data-act="gh-check"]')).toHaveCount(1);
    await page.locator('input[name="l_identity"][value="purchased"]').check();
    await page.click('[data-act="lz-next"]');

    // 5 funding: 10 USD default, first-run budget, launch parameters from chain, no fee split
    await page.locator("#w-fees .wl-params").waitFor({ timeout: 30_000 });
    await page.locator("#w-prepay b.num").first().waitFor({ timeout: 30_000 });
    await expect(page.locator('[name="l_deposit"]')).toHaveValue("10");
    const fund = page.locator('[data-step="4"]');
    await expect(fund).toContainText("First-run budget");
    await expect(fund).toContainText("agent wakes at");
    await expect(fund).not.toContainText(/fee split|protocol treasury|to the protocol/i);
    await cleanPage(page);

    // 6 review: a devnet simulation (needs the stored, funded test wallet)
    test.skip(!wallet.stored, "no stored test wallet (UI_WALLET_KEY): the review simulation needs a funded launcher");
    await page.locator('[data-act="lz-next"]:not([disabled])').click();
    await page.locator(".lz-review").waitFor();
    await page.locator("#w-launch-out .mark.good, #w-launch-out [data-err]").first().waitFor({ timeout: 120_000 });
    const review = page.locator('[data-step="5"]');
    await expect(review).toContainText(/simulation succeeded on devnet/i);
    await expect(review).toContainText(/Prepaid credits/i);
    await expect(page.locator('[data-act="launch-sign"]')).toHaveCount(1);
    await cleanPage(page);
    // the step nav goes back to a reached step; Launch is never pressed
    await page.click('.lz-step[data-i="0"]');
    await expect(page.locator('[data-step="0"]')).toBeVisible();
  });
});
