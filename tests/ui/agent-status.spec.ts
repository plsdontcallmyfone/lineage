import type { BrowserContext, Page } from "@playwright/test";
import { base58Decode } from "../../packages/protocol/src/index.ts";
import { cleanPage } from "./support/checks.ts";
import { expect, test } from "./support/fixtures.ts";
import { installMockWallet, MOCK_WALLET_NAME } from "./support/wallet.ts";

// The one status line (apps/web/src/agent-status.ts) where a launcher meets it: the Profile's "your
// agents" card, the agent profile's header and the coin page's building panel. The wallet is watch-only
// at the address of a launcher the site lists (it can sign nothing; nothing is sent), so the cards are
// that launcher's real agents read from chain. Where a test needs one particular state, the hosted
// runtime's report for that agent is a stand-in made here; every other read is the site's own.

const SHOTS = process.env.UI_SHOTS_DIR;
const RAW = /\bTBA\b|not bound|\bbound\b|setting_up|\basleep\b|\bawake\b|key revoked|no unit possible/i;
const LABELS = ["Finish setup", "Setting up", "Cannot be measured", "Working", "Between attempts", "Network compute", "Paused", "Desktop starting", "Runtime restarting", "Waiting", "Starting", "Launched", "Key revoked"];
const NO_TESTS_GPU = "no unit possible for karpathy/autoresearch: it has no tests, and a unit needs the repository's own tests to check every change; its code also calls CUDA (a GPU) in prepare.py and train.py, and units are measured on CPUs";
const CANNOT = "It cannot work on this repository yet: it has no tests of its own, and every change must be checked by the repository's own tests. Its code also needs a GPU (prepare.py and train.py), and agents are measured on CPUs. It reads the repository again by itself and starts when that changes.";

type Tok = { agent: string; mint: string; launcher: string; hosted?: boolean; read_only?: boolean };
async function hostedTokens(data: { get(p: string): Promise<any> }): Promise<Tok[]> {
  const all = ((await data.get("/market/tokens?sort=newest&limit=200")).tokens ?? []) as Tok[];
  const out: Tok[] = [];
  for (const t of all.filter((t) => !t.read_only && t.launcher)) {
    const d = await data.get(`/market/tokens/${t.mint}`).catch(() => null);
    if (d?.hosted) out.push(t);
    if (out.length >= 8) break;
  }
  return out;
}

async function asLauncher(context: BrowserContext, page: Page, address: string) {
  const log: string[] = [];
  await installMockWallet(context, { address, publicKey: base58Decode(address), stored: true, signMessage: () => { throw new Error("watch-only"); } }, log);
  await page.goto("/profile");
  await page.evaluate((n) => localStorage.setItem("lineage-wallet", n), MOCK_WALLET_NAME);
  await page.reload();
  await page.locator("#cn-btn.on").waitFor({ timeout: 30_000 });
  return log;
}
const report = (page: Page, agent: string, spend: Record<string, unknown>) =>
  page.route(`**/api/agents/${agent}/spend*`, (r) => r.fulfill({ json: { agent, reported_at: Date.now(), spend: { vault: null, vault_usd: null, burn_per_h: null, burn_usd_per_h: null, burn_window_s: null, runway_h: null, model: null, via: null, ...spend }, price: null, provider_balance_low: false, desktop_masked: false } }));

test.describe("the status line a launcher sees", () => {
  test("Profile card: a label, one sentence and no raw chips; a repository that cannot be measured says why and asks for nothing", async ({ page, context, data }, info) => {
    const toks = await hostedTokens(data);
    test.skip(!toks.length, "the site lists no hosted agent coin");
    const t = toks[0]!;
    await report(page, t.agent, { waiting: NO_TESTS_GPU, bound: false });
    await asLauncher(context, page, t.launcher);
    const card = page.locator(`.me-ag[data-agent="${t.agent}"]`);
    await card.waitFor({ timeout: 90_000 });
    const st = card.locator(".me-cr-st .as");
    await expect(st).toHaveAttribute("data-status", "cannot", { timeout: 60_000 });
    await expect(st.locator(".as-l")).toHaveText("Cannot be measured");
    await expect(st.locator(".as-s")).toHaveText(CANNOT);
    await expect(st.locator(".as-a")).toHaveCount(0);
    await expect(card.locator(".me-cr-why, .me-cr-st .badge")).toHaveCount(0);
    await expect(card.locator(".me-cr")).not.toContainText(RAW);
    // the detail figures stay, with words where the runtime reported nothing
    await expect(card.locator(".me-cr-k")).toContainText("not reported");
    await expect(card.locator('[data-act="me-manage"]')).toHaveText("Manage");
    await cleanPage(page);
    if (SHOTS) await card.screenshot({ path: `${SHOTS}/card-cannot-${info.project.name}.png` });
  });

  test("Profile card: with a fresh report and nothing waiting it is one of the plain states; Finish setup opens the agent's setup", async ({ page, context, data }) => {
    const toks = await hostedTokens(data);
    test.skip(!toks.length, "the site lists no hosted agent coin");
    const t = toks[0]!;
    await report(page, t.agent, {});
    await asLauncher(context, page, t.launcher);
    const card = page.locator(`.me-ag[data-agent="${t.agent}"]`);
    await card.waitFor({ timeout: 90_000 });
    const label = card.locator(".me-cr-st .as-l");
    await expect(label).toHaveText(new RegExp(`^(${LABELS.join("|")})$`), { timeout: 60_000 });
    await expect(card.locator(".me-cr-st .as-s")).toHaveText(/\.$/);
    await expect(card.locator(".me-cr")).not.toContainText(RAW);
    // bound or not is the chain's word: an agent whose setup is not finished gets the one button, and it opens its setup
    if ((await label.textContent()) === "Finish setup") {
      await expect(card.locator(".me-cr-st .as-s")).toHaveText("It cannot start until your wallet signs one approval that lets the hosted runtime work for it.");
      const go = card.locator('.me-cr-st .as-a [data-act="me-manage"]');
      await expect(go).toHaveText("Finish setup");
      await go.click();
      await expect(page.locator("#me-manage")).toBeVisible();
      await expect(page.locator("#me-manage #w-rt-bind")).toBeVisible();
    } else await expect(card.locator('.me-cr-st [data-act="me-manage"]')).toHaveCount(0);
  });

  test("the agent's profile header and its coin page say the same thing in the same words, for anyone", async ({ page, data }, info) => {
    const toks = await hostedTokens(data);
    test.skip(!toks.length, "the site lists no hosted agent coin");
    const t = toks[0]!;
    await report(page, t.agent, { waiting: NO_TESTS_GPU, bound: false });
    await page.goto(`/agents/${t.agent}/profile`);
    const head = page.locator("#pf-status .as");
    await expect(head).toHaveAttribute("data-status", "cannot", { timeout: 60_000 });
    await expect(head.locator(".as-l")).toHaveText("Cannot be measured");
    await expect(head.locator(".as-s")).toHaveText(CANNOT);
    await expect(page.locator(".pf-head .pf-name")).not.toContainText(RAW);
    await expect(page.locator("#pf-setup")).toHaveCount(0);
    await cleanPage(page);
    if (SHOTS) await page.locator(".pf-head").screenshot({ path: `${SHOTS}/header-cannot-${info.project.name}.png` });
    await page.goto(`/tokens/${t.mint}`);
    const b = page.locator("#mk-building [data-agent-status] .as");
    await expect(b).toHaveAttribute("data-status", "cannot", { timeout: 60_000 });
    await expect(b.locator(".as-s")).toHaveText(CANNOT);
    await cleanPage(page);
    if (SHOTS) await page.locator(".mk-buildpanel").screenshot({ path: `${SHOTS}/building-cannot-${info.project.name}.png` });
  });

  test("anyone but the launcher is told what an unfinished setup waits for, and is not asked to act", async ({ page, data }) => {
    const toks = await hostedTokens(data);
    test.skip(!toks.length, "the site lists no hosted agent coin");
    const t = toks[0]!;
    await report(page, t.agent, { waiting: "waiting for its owner's wallet to sign the binding to the hosted runtime", bound: false });
    await page.goto(`/tokens/${t.mint}`);
    const b = page.locator("#mk-building [data-agent-status] .as");
    await expect(b.locator(".as-l")).toHaveText("Setup not finished", { timeout: 60_000 });
    await expect(b.locator(".as-s")).toHaveText("It starts once its launcher finishes setup with one approval from their wallet.");
    await expect(b.locator(".as-a")).toHaveCount(0);
  });
});

// Screenshots of the live states (no stand-in): UI_SHOTS_DIR=<dir> UI_SHOT_LAUNCHERS=<address,address>
test.describe("live cards", () => {
  for (const address of (process.env.UI_SHOT_LAUNCHERS ?? "").split(",").filter(Boolean))
    test(`the cards of ${address.slice(0, 6)} as the site has them now`, async ({ page, context }, info) => {
      test.skip(!SHOTS, "screenshots only");
      await asLauncher(context, page, address);
      const cards = page.locator(".me-ag");
      await cards.first().waitFor({ timeout: 90_000 });
      await expect(cards.first().locator(".me-cr-st .as-l")).toHaveText(new RegExp(`^(${LABELS.join("|")})$`), { timeout: 60_000 });
      await page.waitForTimeout(4000);
      for (let i = 0; i < (await cards.count()); i++) {
        const c = cards.nth(i);
        console.log(`LIVE ${address.slice(0, 6)} ${info.project.name}: ${await c.locator(".me-cr-st .as-l").textContent()} | ${await c.locator(".me-cr-st .as-s").textContent()} | action: ${(await c.locator(".me-cr-st .as-a").count()) ? await c.locator(".me-cr-st .as-a").textContent() : "none"}`);
        await c.screenshot({ path: `${SHOTS}/live-card-${address.slice(0, 6)}-${i}-${info.project.name}.png` });
      }
    });
});
