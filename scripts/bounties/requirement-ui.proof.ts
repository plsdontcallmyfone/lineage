// "What does this mean?" beside a bounty's requirement and "How improvement is measured" on the board,
// in headless Chromium at 1280 and 390:   bun test ./scripts/bounties/requirement-ui.proof.ts
//
// Real: Core with a unit, one accepted generation (replayed by verifiers, so the unit's best code has
// measured values) and an open bounty asking for 10% on its metric; the web server; the page bundles.
// Every number the panels show is compared with what Core serves. No transaction on any network.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "@playwright/test";
import { generateAgentKey, hashJson } from "@units/protocol";
import { openBountiesOf } from "../../packages/core/src/open-bounties.ts";
import { candidate, diff, makeAuthor, result, runReplays, setup, submit, type Env } from "../../packages/core/test/helpers.ts";
import { startWeb } from "../claims/page-proof.ts";
import { CLEAN, freePort, pageRules, testWallet } from "./ui-kit.ts";

const CONFIG = { program: "Prog" + "1".repeat(28), admin: "A" + "1".repeat(31), pendingAdmin: null, mint: "M" + "1".repeat(31), tokenProgram: "T" + "1".repeat(31), launchProgram: "L" + "1".repeat(31), opened: 1n,
  settings: { minAmount: 1_000_000n, minTtlS: 3600, maxTtlS: 2_592_000, refundGraceS: 7200, contestS: 1800, feeBps: 0, paused: false } };
let e: Env, web: Awaited<ReturnType<typeof startWeb>>, browser: Browser;
let bountyId = "", metric = "", value = 0, height = 0;
const whole = (n: number) => Math.round(n).toLocaleString("en-US");

beforeAll(async () => {
  for (const k of ["UNITS_FEATURE_OPEN_BOUNTIES", "UNITS_FEATURE_BOUNTIES"]) process.env[k] = "1";
  e = await setup({ verifiers: 3 });
  e.clock.advance(Date.now() - e.clock.now());
  // one accepted change: the unit's best code now has values measured in its replays
  const author = await makeAuthor(e);
  const c = await submit(e, author, diff("faster", "src/faster.rs"));
  await runReplays(e, c.candidate_id, () => result({}, 850));
  expect((await candidate(e, c.candidate_id)).status).toBe("accepted");
  const unit = await (await fetch(`${e.base}/v1/lineages/${e.lineage}`)).json();
  const board0 = await (await fetch(`${e.base}/v1/bounties/board`)).json();
  metric = board0.units[0].metrics[0].name;
  height = unit.height;
  const tip = await (await fetch(`${e.base}/v1/generations/${unit.tip}`)).json();
  const measured = (tip.replays as any[]).flatMap((r) => r.result?.metrics?.[metric]?.cand ?? []) as number[];
  value = [...measured].sort((a, b) => a - b)[Math.floor((measured.length - 1) / 2)]!;
  expect(measured.length).toBeGreaterThan(0);
  const now = BigInt(Math.floor(e.clock.now() / 1000));
  openBountiesOf(e.core).sync(CONFIG as never, [{ address: generateAgentKey().id, funder: generateAgentKey().id, bountyId: 1n, amount: 5_000_000n, feeBps: 0, termsDigest: "00".repeat(32), lineageId: e.lineage,
    targetDigest: hashJson(metric), minImprovementBps: 1000, minEpoch: 0n, epochsPostedAtOpen: 0n, deadline: now + 5n * 86_400n, createdAt: now, refundAfter: now + 5n * 86_400n + 7200n, contestS: 1800, status: "open" as const,
    winner: null, winHeight: 0n, winEpoch: 0n, winGenId: null, winImprovementBps: 0n, winLeaf: null, claimedAt: 0n, contestUntil: 0n, paid: 0n, feePaid: 0n, closedAt: 0n }] as never);
  bountyId = (await (await fetch(`${e.base}/v1/bounties/board`)).json()).bounties[0].bounty_id;
  web = await startWeb(freePort(), e.base);
  browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => {
  await browser?.close();
  web?.stop();
  e?.close();
});

const line = async (page: Page, scope: string, k: string) => (await page.locator(`${scope} .rq-panel [data-rq-line="${k}"]`).innerText()).replace(/\s+/g, " ").trim();
/** Opens the toggle under `scope`, checks the panel's numbers against Core, closes it again. */
async function openAndCheck(page: Page, scope: string, label: string, pct: number) {
  const btn = page.locator(`${scope} [data-rq-toggle]`);
  const panel = page.locator(`${scope} .rq-panel`);
  expect(await btn.innerText()).toBe(label);
  expect(await btn.getAttribute("aria-expanded")).toBe("false");
  expect(await panel.isHidden()).toBe(true);
  expect(await btn.getAttribute("aria-controls")).toBe(await panel.getAttribute("id"));
  await btn.click();
  expect(await btn.getAttribute("aria-expanded")).toBe("true");
  await page.locator(`${scope} .rq-panel [data-rq-line="now"]`).waitFor({ timeout: 60_000 });
  expect(await line(page, scope, "now")).toContain(`Where it stands: ${whole(value)}`);
  expect(await line(page, scope, "now")).toContain(`measured in the replays of generation ${height}`);
  const goal = Math.floor(value * (1 - pct / 100));
  expect(await line(page, scope, "win")).toContain(`from ${whole(value)}`);
  expect(await line(page, scope, "win")).toContain(`to ${whole(goal)} or `);
  expect(await line(page, scope, "win")).toContain(`which is ${pct}% better.`);
  expect(await line(page, scope, "one")).toBe("It is one change, measured against the unit's best code at the moment that change is verified. It is not the total of several smaller changes, and it is not compared with the repository as it was when the bounty was posted.");
  expect(await line(page, scope, "moving")).toContain(`every change still waiting is verified again on top of it, and the ${pct}% is counted from the new best`);
  expect(await line(page, scope, "who")).toContain("independent verifiers replay the change");
  expect(await line(page, scope, "tests")).toContain("The repository's own tests must still pass");
  expect(await line(page, scope, "not")).toContain("What it does not mean");
  expect(await pageRules(page, ".bo-page")).toMatchObject(CLEAN); // no sideways scroll with the panel open
  const box = await panel.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
}

for (const width of [1280, 390]) {
  test(`a card, the board's own explanation, the bounty page and the post form, at ${width}`, async () => {
    const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
    await testWallet(ctx, generateAgentKey());
    const page = await ctx.newPage();
    await page.goto(`${web.base}/bounties`);
    await page.locator(`article[data-bounty="${bountyId}"]`).waitFor({ timeout: 90_000 });
    expect(await page.locator(".rq-panel:visible").count()).toBe(0); // everything closed until asked
    const card = `article[data-bounty="${bountyId}"]`;
    await openAndCheck(page, card, "What does this mean?", 10);
    // the keyboard: Escape closes it and leaves the focus on its button; Enter opens it again
    await page.locator(`${card} [data-rq-toggle]`).focus();
    await page.keyboard.press("Escape");
    expect(await page.locator(`${card} .rq-panel`).isHidden()).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-rq-toggle"))).toBe(true);
    await page.keyboard.press("Enter");
    expect(await page.locator(`${card} .rq-panel`).isVisible()).toBe(true);
    await page.keyboard.press("Enter");
    expect(await page.locator(`${card} .rq-panel`).isHidden()).toBe(true);
    expect(new URL(page.url()).pathname).toBe("/bounties"); // a toggle is never a link
    // the board's own explanation, with the live unit as its example
    await openAndCheck(page, "[data-rq-general]", "How improvement is measured", 10);
    expect(await line(page, "[data-rq-general]", "general")).toContain("Every bounty asks for one metric of one unit to get better by a percentage.");
    expect(await line(page, "[data-rq-general]", "example")).toContain(`An example from a unit that is live now: example/fx`);
    expect(await line(page, "[data-rq-general]", "example")).toContain(`, ${metric} `);
    // the post form: the same panel, and it follows the percentage typed while it stays open
    const form = page.locator('[data-wallet-form="bounty-post"]');
    await form.waitFor({ timeout: 90_000 });
    await form.locator('[name="bo_pct"]').fill("10");
    await openAndCheck(page, "[data-rq-form]", "What does this mean?", 10);
    await form.locator('[name="bo_pct"]').fill("25");
    await page.locator('[data-rq-form] .rq-panel [data-rq-line="win"]').waitFor({ timeout: 30_000 });
    expect(await page.locator("[data-rq-form] [data-rq-toggle]").getAttribute("aria-expanded")).toBe("true");
    expect(await line(page, "[data-rq-form]", "win")).toContain(`to ${whole(Math.floor(value * 0.75))} or `);
    expect(await line(page, "[data-rq-form]", "win")).toContain("which is 25% better.");
    expect(await form.locator('[name="bo_pct"]').inputValue()).toBe("25"); // typing kept its place
    // the bounty's own page
    await page.goto(`${web.base}/bounties/${bountyId}`);
    await page.locator(".bo-sec").first().waitFor({ timeout: 60_000 });
    await openAndCheck(page, "article.bo-card", "What does this mean?", 10);
    await ctx.close();
  }, 300_000);
}
