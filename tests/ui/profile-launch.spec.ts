import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newSoul } from "../../packages/souls/src/schema.ts";
import { cleanPage } from "./support/checks.ts";
import { expect, plainLaunch, test, type Page } from "./support/fixtures.ts";
import { MOCK_WALLET_NAME } from "./support/wallet.ts";

// Profile and Launch with the mock Wallet Standard wallet (support/wallet.ts). Nothing here signs or
// sends a transaction: the wallet refuses, the write guard aborts sends, and the wizard stops at its
// review step (a simulation, which is a read). Costs lead in US dollars; the wording follows the site's network.

const ONE_PX_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

// Connect opens Privy's login modal (apps/web/src/connect.ts, the island apps/web/privy/main.tsx), which
// a test cannot finish without a real Privy login. The mock wallet connects the way a returning visitor's
// Wallet Standard wallet does: the site remembers the wallet's name (localStorage "lineage-wallet",
// apps/web/wallet/standard.ts) and reconnects it silently on load (restoreSession). Privy's own button is
// checked separately below: it opens Privy's modal, and no login is made.
async function connect(page: Page, address: string) {
  await page.evaluate((n) => localStorage.setItem("lineage-wallet", n), MOCK_WALLET_NAME);
  await page.reload();
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

  test("disconnected: Connect opens Privy's login modal (no login is made)", async ({ page, guard }) => {
    await page.goto("/profile");
    await page.locator(".me-prompt").waitFor({ timeout: 30_000 });
    await expect(page.locator("#cn-btn")).toHaveText("Connect");
    await page.locator("#cn-btn").click();
    await page.locator("#privy-modal-content").waitFor({ timeout: 60_000 });
    await expect(page.locator("#cn-btn.on")).toHaveCount(0);
    await expect(page.locator("#privy-modal-content")).toContainText(/Log in or sign up/i);

    // Privy serves its frame only to the origins its dashboard lists (the app's allowed origins). On an
    // origin it does not list, the browser refuses the frame, says so on the console, reports it to the
    // address Privy's policy names, and Privy answers its own analytics call with 403. That is a setting
    // of the Privy app, not something the page does: the run says so and names the origin to add, and
    // only the traces of that refusal are set aside. Everything else still fails the test.
    await page.waitForTimeout(3000);
    const origin = new URL(page.url()).origin;
    const refusal = guard.errors.find((e) => /Framing 'https:\/\/auth\.privy\.io\/' violates the following Content Security Policy directive: "frame-ancestors /.test(e));
    if (refusal) {
      const listed = /"frame-ancestors ([^"]*)"/.exec(refusal)![1]!.split(/\s+/);
      expect(listed.includes(origin), `Privy lists ${origin} and still refused its frame`).toBe(false);
      const drop = (list: string[], res: RegExp[]) => {
        for (let i = list.length - 1; i >= 0; i--) if (res.some((re) => re.test(list[i]!))) list.splice(i, 1);
      };
      drop(guard.errors, [/Framing 'https:\/\/auth\.privy\.io\/' violates/, /status of 403 \(\) https:\/\/auth\.privy\.io\/api\/v1\/analytics_events/]);
      drop(guard.blocked, [/^POST csp-report\.browser-intake-datadoghq\.com\/api\/v2\/logs$/]);
      test.skip(true, `Privy's allowed origins do not list ${origin}: its frame is refused there (the modal opens, the embedded frame does not load). Owner: add the origin in the Privy dashboard. Listed: ${listed.join(" ")}`);
    }
  });

  test("connected (mock wallet): my agents with the indexer's figures, holdings, follows, manage, menu, persists", async ({ page, wallet, data }) => {
    await page.goto("/profile");
    await page.locator(".me-prompt").waitFor({ timeout: 30_000 });
    await connect(page, wallet.address);
    // the wallet's launches on the current deployment: a token of a previous deployment (read_only: devnet
    // history, its agent relaunched under a new id) is not among My agents, which reads the chain
    const launched = (await data.get(`/market/tokens?launcher=${wallet.address}&sort=newest&limit=200`)).tokens as any[];
    const mine = launched.filter((t) => !t.read_only);
    const retired = launched.filter((t) => t.read_only && !mine.some((m) => m.agent === t.agent));
    if (!mine.length) {
      await expect(page.locator("#w-mine")).toContainText("has launched no agent");
    } else {
      await page.locator(".me-agents .me-ag").first().waitFor({ timeout: 90_000 });
      for (const t of mine) {
        const card = page.locator(`.me-ag[data-agent="${t.agent}"]`);
        await expect(card, `My agents lists ${t.symbol}`).toHaveCount(1);
        // the /agents card (token price and change, what it is building) with the agent's credits under it
        await card.locator(".ag-tok").waitFor({ timeout: 60_000 });
        await expect(card.locator(".bd-building")).toHaveCount(1);
        await expect(card.locator(".me-cr dt")).toHaveText(["Compute vault", "Burn", "Runway", "Model", "GitHub"]);
      }
      await expect(page.locator(".me-agents .me-ag")).toHaveCount(mine.length);
      for (const t of retired) await expect(page.locator(`.me-ag[data-agent="${t.agent}"]`), `the retired ${t.symbol} (${t.agent.slice(0, 6)}) is not listed`).toHaveCount(0);
    }
    await expect(page.locator(".wl-bal")).toHaveCount(1);
    await page.locator("#w-hold table, #w-hold [data-none]").first().waitFor({ timeout: 60_000 });
    await expect(page.locator("#me-signed")).not.toContainText(/fees? (claimed|to compute|split)|crank/i);
    await cleanPage(page);

    if (mine.length) {
      await page.locator('[data-act="me-manage"]').first().click();
      await page.locator("#me-manage:not([hidden]) #w-id .kv").first().waitFor({ timeout: 60_000 });
      await expect(page.locator('[data-me-up="avatar"]')).toHaveCount(1);
      await expect(page.locator('[data-act="me-fund"]')).toHaveCount(0); // no trading funding: agents do not trade
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
  test("every wizard step up to the review, with the mock wallet; nothing is sent", async ({ page, wallet, data }, info) => {
    const net = await data.network();
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
    // the coin image is stored before Review, signed by the agent key (apps/web/wallet/coin-uri.ts): this run stores nothing,
    // so the upload and the read-back of the image are answered here
    await page.route("**/social/media/*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    await page.route("**/coin/image/*", (r) => r.fulfill({ status: 200, contentType: "image/png", body: ONE_PX_PNG }));
    await page.locator('[name="l_image"]').setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: ONE_PX_PNG });
    await page.fill('[name="l_links"]', "https://example.com");
    await page.locator('[data-act="lz-next"]:not([disabled])').waitFor({ timeout: 60_000 });
    // the coin's on-chain name carries the TEST prefix on devnet only, and the form says so only there
    if (net === "mainnet") await expect(page.locator('[data-step="0"]')).not.toContainText(/devnet|\bTEST\b|test tokens|faucet|tUNITS/i);
    else await expect(page.locator('[data-step="0"]')).toContainText('"TEST " + this');
    await cleanPage(page);
    await page.click('[data-act="lz-next"]');

    // 2 work: targets read from Core for the repository
    await page.fill('[name="l_repo"]', "https://github.com/keis/base58");
    await page.locator("#w-work .lz-rec, #w-work .banner").first().waitFor({ timeout: 60_000 });
    await expect(page.locator("#w-work")).toContainText("base58-py");
    await expect(page.locator("#w-work")).toContainText("_ir");
    // no target class picker: the class follows the recipe (a hidden field carries it), nothing to choose
    await expect(page.locator('select[name="l_class"], input[name="l_class"]:not([type="hidden"])')).toHaveCount(0);
    await expect(page.locator('input[type="hidden"][name="l_class"]')).toHaveCount(1);
    await plainLaunch(page);
    await page.click('[data-act="lz-next"]');

    // 3 agent: soul drafted (stored doc), no trading temperament to pick, model table
    await page.fill('[name="s_vibe"]', "dry, exact, cheerful about small wins");
    await page.fill('[name="s_specialty"]', "base58 hot paths, same bytes out");
    await page.fill('[name="s_values"]', "measure before claiming, small diffs");
    await expect(page.locator('input[name="l_temp"]')).toHaveCount(0);
    await expect(page.locator('[data-step="2"]')).not.toContainText(/temperament/i);
    await page.click('[data-act="soul-generate"]');
    await page.locator(".wl-soul .wl-hash").waitFor({ timeout: 60_000 });
    await page.locator('[name="l_model"]').first().waitFor({ timeout: 30_000 });
    await expect(page.locator('input[name="l_temp"]')).toHaveCount(0); // still none once the soul is there
    expect(await page.locator(".wl-prov-i").count()).toBeGreaterThanOrEqual(2);
    await cleanPage(page);
    await page.click('[data-act="lz-next"]');

    // 4 identity: exactly two options, "A units account" (the default) and "Your own token"
    const ident = page.locator('[data-step="3"]');
    await expect(page.locator('input[name="l_identity"]')).toHaveCount(2);
    // each option leads with its name in bold
    expect(await ident.locator("label.radio").evaluateAll((els) => els.map((l) => l.querySelector("b")?.textContent?.trim().replace(/\.$/, "")))).toEqual(["A units account", "Your own token"]);
    // where the instance sells no units account (the mainnet test instance) that option is disabled and
    // Your own token is the selection
    await expect(page.locator("#w-id-price")).not.toHaveText(/^$|price from Core/, { timeout: 60_000 });
    const offered = !(await page.locator('input[name="l_identity"][value="purchased"]').isDisabled());
    await expect(page.locator(`input[name="l_identity"][value="${offered ? "purchased" : "token"}"]`)).toBeChecked();
    if (net === "devnet") expect(offered, "the devnet site sells units accounts").toBe(true);
    // (with Your own token selected and none pasted, the step itself says the app identity is used until one is added)
    if (offered) await expect(ident).not.toContainText(/App identity/i);
    await page.locator('input[name="l_identity"][value="token"]').check();
    await expect(page.locator('[data-act="gh-check"]')).toHaveCount(1);
    if (offered) await page.locator('input[name="l_identity"][value="purchased"]').check();
    await page.click('[data-act="lz-next"]');

    // 5 funding (owner direction 2026-10-11): credits in USD, everything paid in SOL with one signature,
    // one compact total in SOL, no pay-with, no parameters table, no fee split
    await expect(page.locator('[name="l_deposit"]')).toHaveValue("10");
    const fund = page.locator('[data-step="4"]');
    await expect(fund).toContainText("Credits (USD)");
    await expect(fund).toContainText("paid in SOL with one signature");
    // the total in US dollars with the SOL beside it once the launch is simulated; the chain refuses the
    // simulation for a wallet with no SOL (the test wallet is funded on devnet only), and the step says so
    await expect(page.locator("[data-fronting-total]")).not.toHaveText(/simulating/, { timeout: 120_000 });
    const simulated = (await page.locator("[data-fronting-total]").innerText()).startsWith("$");
    if (net === "devnet" && wallet.stored) expect(simulated, "the funded test wallet's launch simulates on devnet").toBe(true);
    if (simulated) await expect(page.locator("[data-fronting-sol]")).toHaveText(/^[\d.]+ SOL$/);
    else await expect(page.locator("#w-fronting [data-fronting-short]")).toContainText(/Launch disabled: .+/);
    await expect(fund).not.toContainText(/Pay with|Launch parameters|fee split|protocol treasury|to the protocol/i);
    if (net === "mainnet") await expect(fund).not.toContainText(/devnet|\bTEST\b|test tokens|faucet|tUNITS/i);
    await expect(fund).not.toContainText(/\bt?UNITS\b/);
    await cleanPage(page);

    // 6 review: a simulation on the site's network (needs the stored test wallet, funded on devnet)
    test.skip(!wallet.stored, "no stored test wallet (UI_WALLET_KEY): the review simulation needs a funded launcher");
    await page.locator('[data-act="lz-next"]:not([disabled])').click();
    await page.locator(".lz-review").first().waitFor(); // the summary; the cost breakdown is a second .lz-review block
    await page.locator("#w-launch-out .mark.good, #w-launch-out [data-err]").first().waitFor({ timeout: 120_000 });
    const review = page.locator('[data-step="5"]');
    if (simulated) await expect(review).toContainText(new RegExp(`simulation succeeded on ${net}`, "i"));
    else await expect(review).toContainText(/Launch disabled: .+/);
    await expect(review).toContainText(/Model credits/i);
    await expect(review).not.toContainText(/temperament/i); // no temperament row while the choice is not offered
    await expect(page.locator('[data-act="launch-sign"]')).toHaveCount(1);
    await cleanPage(page);
    // the step nav goes back to a reached step; Launch is never pressed
    await page.click('.lz-step[data-i="0"]');
    await expect(page.locator('[data-step="0"]')).toBeVisible();
  });
});
