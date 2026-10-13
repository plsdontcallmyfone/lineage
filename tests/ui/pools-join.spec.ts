import { cleanPage, monoChrome } from "./support/checks.ts";
import { expect, test } from "./support/fixtures.ts";
import { MOCK_WALLET_NAME } from "./support/wallet.ts";

// "Join a pool" on the Pools page (docs/plans/AGENT-POOLS.md 11): a launcher opens or joins its
// repository's pool for an agent it already launched. With a wallet: its agents, each with its
// repository's pool and one action; the review before signing states what joining does with the
// numbers of the chain's PoolConfig, that it cannot be undone, and the exact cost. Nothing is signed
// or sent: the mock wallet refuses transactions and the write guard aborts sends.
// UI_WALLET_ADDRESS=<the public address of a wallet that owns an agent> makes the wallet watch-only at
// that address, so the rows and the review are those of a real owner.

const pct = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

test("a visitor: the two ways into a pool, and each pool's own figures", async ({ page, data }) => {
  const res = await data.core("pools").catch(() => null);
  await page.goto("/pools?repo=karpathy/minbpe");
  await page.locator(".pl-page").waitFor({ timeout: 60_000 });
  if (!res?.config) {
    await expect(page.locator(".pl-page .empty .t1")).toHaveText("Pools are not open yet");
    await expect(page.locator("[data-pool-join-box]")).toHaveCount(0);
    return;
  }
  // the head says in one line how to set a pool up; the box about a repository's owners says who claims
  await expect(page.locator("[data-pool-setup]")).toHaveText("Connect the wallet that launched an agent to open or join its repository's pool.");
  const claim = page.locator(".pl-how", { hasText: "Fees for a repository's owner" });
  await expect(claim).toContainText("to the owners of the repository it works on; anyone with admin on the repository can claim.");
  await expect(claim).not.toContainText("GitHub account");
  const box = page.locator("[data-pool-join]");
  await box.locator('[data-pj-ready="visitor"]').waitFor({ timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  // the two ways in: the wizard (with the repository named in the address filled in) and the wallet of an agent already launched
  await expect(box.locator("[data-pj-way]")).toHaveCount(2);
  await expect(box.locator('[data-pj-way="launch"]')).toContainText("Launch an agent on karpathy/minbpe and tick the pool box");
  await expect(box.locator('[data-pj-way="launch"] a')).toHaveAttribute("href", "/launch?repo=karpathy%2Fminbpe");
  await expect(box.locator('[data-pj-way="connect"]')).toContainText("Already launched one? Connect the wallet that launched it.");
  await expect(box.locator('[data-pj-act="connect"]')).toHaveText("Connect wallet");
  // every pool: its members and figures, the ways in for its repository, and what Core keeps about it folded under it
  const cards = page.locator("article[data-pool]");
  for (let i = 0; i < (await cards.count()); i++) {
    const card = cards.nth(i), id = await card.getAttribute("data-pool"), row = (res.pools as any[]).find((p) => p.repo_id === id);
    if (!row) continue; // opened since the API was read
    await expect(card.locator("[data-pool-member]")).toHaveCount(row.members.length);
    await expect(card.locator("[data-pool-join-link]")).toBeVisible();
    await card.locator("details[data-pool-more] summary").click();
    await expect(card.locator("[data-pool-settlements]")).toBeVisible({ timeout: 30_000 });
    await expect(card.locator("[data-pool-actions]")).toBeVisible();
  }
  if ((await cards.count()) === 0) await expect(page.locator(".pl-list .empty")).toContainText("No pool yet");
  expect(await monoChrome(page), "monospace on UI chrome").toEqual([]);
  await cleanPage(page);
  if (process.env.UI_SHOTS) await page.screenshot({ path: `${process.env.UI_SHOTS}/pools-visitor-${page.viewportSize()!.width}.png`, fullPage: true });
});

test("a connected wallet: its agents, each repository's pool, one action, and the review before signing", async ({ page, wallet, data }) => {
  const res = await data.core("pools").catch(() => null);
  test.skip(!res?.config, "pools are not open on this site");
  const cfg = res.config as { poolFeeBps: number; payoutBps: number; buybackBps: number; burnBps: number; maxMembers: number };
  await page.goto("/pools");
  await page.evaluate((n) => localStorage.setItem("lineage-wallet", n), MOCK_WALLET_NAME);
  await page.reload();
  const box = page.locator("[data-pool-join]");
  await expect(page.locator("[data-pool-join-box] h2")).toHaveText("Join a pool");
  await box.locator('[data-pj-ready="rows"]').waitFor({ timeout: 120_000 });
  await page.evaluate(() => document.fonts.ready);
  const rows = box.locator("[data-pj-agent]");
  if ((await rows.count()) === 0) {
    // a wallet that owns no agent is told so, with its own address
    await expect(box.locator("[data-pj-none]")).toContainText(`${wallet.address.slice(0, 4)}…${wallet.address.slice(-4)}`);
    await expect(box.locator("[data-pj-none]")).toContainText("owns no agent on chain");
    await cleanPage(page);
    return;
  }
  await expect(box.locator("[data-pj-intro]")).toContainText(`A member routes ${pct(cfg.poolFeeBps)} of the fees it keeps into its pool`);
  // every row: the agent, its repository, where it stands; at most one primary action
  for (let i = 0; i < (await rows.count()); i++) {
    const row = rows.nth(i);
    await expect(row.locator(".pj-name")).toBeVisible();
    await expect(row.locator(".pj-repo")).toHaveText(/^[\w.-]+\/[\w.-]+$/);
    await expect(row.locator("[data-pj-line]")).not.toBeEmpty();
    expect(await row.locator('[data-pj-act="review"]').count()).toBeLessThanOrEqual(1);
    const state = await row.getAttribute("data-pj-state");
    if (state === "open") await expect(row.locator('[data-pj-act="review"]')).toHaveText(/^Open this repository's pool with /);
    if (state === "open") await expect(row.locator("[data-pj-line]")).toContainText("A pool starts routing fees only when a second agent joins.");
    if (state === "join") await expect(row.locator('[data-pj-act="review"]')).toHaveText(/^Join the pool of [\w.-]+\/[\w.-]+$/);
    if (state === "join" || state === "member") expect(await row.locator("[data-pj-member]").count()).toBeGreaterThan(0);
    if (state === "member") await expect(row.locator('[data-pj-act="review"]')).toHaveCount(0);
  }
  expect(await monoChrome(page), "monospace on UI chrome").toEqual([]);
  await cleanPage(page);
  const act = box.locator('[data-pj-act="review"]').first();
  test.skip((await act.count()) === 0, "every agent of this wallet is already in a pool, or none can join");
  const agent = await act.getAttribute("data-agent");
  await act.click();
  const review = box.locator(`[data-pj-review="${agent}"]`);
  await review.waitFor({ timeout: 90_000 });
  // what joining does: the chain's numbers, the cross holding, and that it cannot be undone
  await expect(review.locator('[data-pj-fact="share"]')).toContainText(`${pct(cfg.poolFeeBps)} of the creator fees`);
  const split = review.locator('[data-pj-fact="split"]');
  for (const b of [cfg.payoutBps, cfg.buybackBps, cfg.burnBps]) await expect(split).toContainText(pct(b));
  await expect(review.locator('[data-pj-fact="cross"]')).toContainText(/Cross holding: /);
  await expect(review.locator('[data-pj-fact="cross"]')).toContainText(/Your wallet does not pay for this|none is set/);
  await expect(review.locator('[data-pj-fact="compute"]')).toContainText("own compute");
  await expect(review.locator('[data-pj-fact="undo"]')).toContainText("Joining cannot be undone. The program has no way to leave a pool");
  // the cost: each new account's rent and the fee, summing to the total, in dollars first
  const cost = review.locator("[data-pj-cost]");
  const lines = cost.locator("[data-pj-cost-line]");
  const keys = await lines.evaluateAll((els) => els.map((e) => e.getAttribute("data-pj-cost-line")));
  expect(keys.at(-1)).toBe("fee");
  expect(keys).toContain("member");
  const lamports = await lines.evaluateAll((els) => els.map((e) => BigInt(e.getAttribute("data-lamports")!).toString()));
  expect(lamports.reduce((a, x) => a + BigInt(x), 0n).toString()).toBe(await cost.getAttribute("data-pj-cost"));
  for (const t of await lines.allInnerTexts()) expect(t).toMatch(/^(\$[\d.,]+|\$ unavailable) \([\d.,]+ SOL\)$/);
  // one approval button, and nothing has been offered to the wallet yet
  await expect(review.locator('[data-pj-act="sign"]')).toHaveText(/^(Open|Join) the pool: approve in your wallet$/);
  await expect(review.locator('[data-pj-act="sign"]')).toBeEnabled();
  expect(wallet.log.filter((x) => x.startsWith("signTransaction"))).toEqual([]);
  expect(await monoChrome(page), "monospace on UI chrome").toEqual([]);
  await cleanPage(page);
  if (process.env.UI_SHOTS) await page.locator("[data-pool-join-box]").screenshot({ path: `${process.env.UI_SHOTS}/pool-join-review-${page.viewportSize()!.width}.png` });
  await review.locator('[data-pj-act="back"]').click();
  await expect(box.locator(`[data-pj-agent="${agent}"] [data-pj-act="review"]`)).toBeVisible();
});

// Profile > Manage carries the same component for the one agent being managed.
test("Profile > Manage: the same join for one agent", async ({ page, wallet, data }) => {
  const res = await data.core("pools").catch(() => null);
  test.skip(!res?.config, "pools are not open on this site");
  await page.goto("/profile");
  await page.evaluate((n) => localStorage.setItem("lineage-wallet", n), MOCK_WALLET_NAME);
  await page.reload();
  const manage = page.locator('.me-cr-act [data-act="me-manage"]').first();
  const found = await manage.waitFor({ timeout: 120_000 }).then(() => true).catch(() => false);
  test.skip(!found, "this wallet owns no agent");
  const agent = await manage.getAttribute("data-agent");
  await manage.click();
  const box = page.locator(`#me-manage #me-pool[data-pool-join-agent="${agent}"]`);
  await box.locator('[data-pj-ready="rows"]').waitFor({ timeout: 120_000 });
  // exactly this agent, with its state and at most one action
  await expect(box.locator("[data-pj-agent]")).toHaveCount(1);
  await expect(box.locator(`[data-pj-agent="${agent}"] [data-pj-line]`)).not.toBeEmpty();
  const act = box.locator('[data-pj-act="review"]');
  expect(await act.count()).toBeLessThanOrEqual(1);
  if (await act.count()) {
    await act.click();
    const review = box.locator(`[data-pj-review="${agent}"]`);
    await review.waitFor({ timeout: 90_000 });
    await expect(review.locator('[data-pj-fact="undo"]')).toContainText("Joining cannot be undone.");
    await expect(review.locator('[data-pj-act="sign"]')).toBeEnabled();
  }
  expect(wallet.log.filter((x) => x.startsWith("signTransaction"))).toEqual([]);
  await cleanPage(page);
  if (process.env.UI_SHOTS) await page.locator("#me-manage").screenshot({ path: `${process.env.UI_SHOTS}/manage-pool-${page.viewportSize()!.width}.png` });
});
