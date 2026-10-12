import { cleanPage } from "./support/checks.ts";
import { expect, test, type Page } from "./support/fixtures.ts";

// Launch while the deployment is being opened (apps/web/src/opening.ts, pages/launch.ts). The local
// dashboard is real; only Core's chain read (GET /api/chain, the page's "is it live" question) is
// answered here: first as a Core that has not read an initialized registry, or one that does not answer,
// then left to the real backend. The page must say launches open in a moment, in plain words, and
// switch to the wizard by itself: no reload, and no further asking once it is live.

const TITLE = "Launches open in a moment.";
const LINE = "The network is starting. This page switches by itself.";
// nothing of an error, of another network or of the wizard's failure lines may show while opening
const FORBIDDEN = /error|fail|refus|unreachable|not initialized|did not|devnet|\bTEST\b|simulat|HTTP \d|\b50[234]\b|\u2014|\u2013/i;

type Mode = "not-initialized" | "unreachable" | "live";

async function stubCore(page: Page, start: Mode) {
  const s = { mode: start as Mode, asked: 0 };
  await page.route("**/api/chain", (route) => {
    s.asked++;
    if (s.mode === "not-initialized") return route.fulfill({ json: { mode: "mainnet", read_at: null } });
    if (s.mode === "unreachable") return route.fulfill({ status: 502, json: { error: "core_unreachable", message: "Core did not answer" } });
    return route.fallback();
  });
  return s;
}

async function opening(page: Page) {
  const panel = page.locator("#lz-opening");
  await panel.waitFor({ timeout: 30_000 });
  await expect(panel.locator(".t1")).toHaveText(TITLE);
  await expect(panel).toContainText(LINE);
  // the wizard is not there, and neither is its loading line
  await expect(page.locator('[name="l_name"]')).toHaveCount(0);
  const text = await page.locator("main").innerText();
  expect(text).not.toMatch(FORBIDDEN);
  await cleanPage(page); // no horizontal scroll (390 px in the mobile project), no em dash
}

async function switchesByItself(page: Page, s: { mode: Mode; asked: number }) {
  // the page keeps asking while it waits
  await expect.poll(() => s.asked, { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
  await page.evaluate(() => ((window as any).__sameDocument = true));
  s.mode = "live";
  await page.locator('[name="l_name"]').waitFor({ timeout: 60_000 });
  await expect(page.locator("#lz-opening")).toHaveCount(0);
  await expect(page.locator("#lz-nav")).toContainText("The coin");
  expect(await page.evaluate(() => (window as any).__sameDocument), "the page switched without a reload").toBe(true);
  // live: the asking has stopped
  const asked = s.asked;
  await page.waitForTimeout(12_000);
  expect(s.asked).toBe(asked);
  await cleanPage(page);
}

test.describe("Launch while the deployment opens", () => {
  test("Core has not read an initialized registry: the opening panel, then the wizard by itself", async ({ page }) => {
    const s = await stubCore(page, "not-initialized");
    await page.goto("/launch");
    await opening(page);
    await switchesByItself(page, s);
  });

  test("Core does not answer (502): the opening panel, then the wizard by itself", async ({ page, guard }) => {
    const s = await stubCore(page, "unreachable");
    await page.goto("/launch");
    await opening(page);
    await switchesByItself(page, s);
    // the browser logs each refused read of this test's own 502; nothing else is set aside
    for (let i = guard.errors.length - 1; i >= 0; i--) if (/status of 502 \([^)]*\) \S+\/api\/chain$/.test(guard.errors[i]!)) guard.errors.splice(i, 1);
  });

  test("live from the start: the wizard, never the panel, and one check", async ({ page }) => {
    const s = await stubCore(page, "live");
    let panel = false;
    await page.exposeFunction("__sawPanel", () => (panel = true));
    await page.addInitScript(() => new MutationObserver(() => document.getElementById("lz-opening") && (window as any).__sawPanel()).observe(document, { childList: true, subtree: true }));
    await page.goto("/launch");
    await page.locator('[name="l_name"]').waitFor({ timeout: 60_000 });
    await page.waitForTimeout(6_000);
    expect(panel, "the opening panel showed on a live deployment").toBe(false);
    expect(s.asked).toBe(1);
  });
});
