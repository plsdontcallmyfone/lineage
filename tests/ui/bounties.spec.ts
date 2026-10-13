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
  // what posting does, in plain words, above the fields
  await expect(page.locator("[data-bounty-intro]")).toContainText("the first verified change that meets it is paid");
  // a repository is owner/repo with the unit after it; a unit without a public repository is not offered
  const repos = await form.locator('[name="bo_unit"] option').allInnerTexts();
  expect(repos.length).toBeGreaterThan(0);
  for (const r of repos) expect(r).toMatch(/^[\w.-]+\/[\w.-]+ \([\w.-]+\)$/);
  expect(repos.join(" ")).not.toMatch(/fixture/i);
  // a metric is a human label with its raw name after it, and is explained under the field with a value Core measured
  const first = (board.units as any[]).find((u) => /^https?:\/\//.test(u.repo));
  const metrics = await form.locator('[name="bo_metric"] option').allInnerTexts();
  expect(metrics.length).toBe(first.metrics.length);
  metrics.forEach((m, i) => { expect(m).toContain(`(${first.metrics[i].name}`); expect(m.length).toBeGreaterThan(first.metrics[i].name.length + 8); });
  const explain = page.locator("[data-metric-explain]");
  await expect(explain.locator("[data-metric-value]")).toBeVisible({ timeout: 60_000 });
  const shown = Number(await explain.locator("[data-metric-value]").getAttribute("data-metric-value"));
  const unit = await (await request.get(`/api/lineages/${first.lineage_id}`)).json();
  const gen = unit.height > 0 ? await (await request.get(`/api/generations/${unit.tip}`)).json() : null;
  const served = [unit.calibration.metrics[first.metrics[0].name]?.base_value, ...((gen?.replays ?? []) as any[]).flatMap((r) => r.result?.metrics?.[first.metrics[0].name]?.cand ?? [])];
  expect(served, "the value under the metric is one Core serves").toContain(shown);
  // the required improvement in the metric's own terms follows what is typed
  await form.locator('[name="bo_pct"]').fill("5");
  await expect(explain.locator("[data-metric-example]")).toContainText("5% better means going from");
  const goal = Number((await explain.locator("[data-metric-example]").innerText()).match(/ to ([\d,]+) or /)![1]!.replace(/,/g, ""));
  expect(goal).toBe(first.metrics[0].direction === "higher" ? Math.ceil(shown / 0.95) : Math.floor(shown * 0.95));
  // "What does this mean?" under the percentage: closed until asked, in this metric's own numbers, and it follows what is typed
  const rq = form.locator("[data-rq-form]");
  const rqPanel = rq.locator(".rq-panel");
  await expect(rqPanel).toBeHidden();
  await rq.locator("[data-rq-toggle]").click();
  await expect(rqPanel.locator('[data-rq-line="win"]')).toContainText(`to ${goal.toLocaleString("en-US")} or `, { timeout: 60_000 });
  await expect(rqPanel.locator('[data-rq-line="win"]')).toContainText("which is 5% better");
  await expect(rqPanel.locator('[data-rq-line="one"]')).toContainText("It is one change, measured against the unit's best code at the moment that change is verified");
  await rq.locator("[data-rq-toggle]").click();
  await expect(rq.locator(".rq-panel")).toBeHidden();
  // the deadline: the site's segmented buttons inside the on-chain limits, a week first, the end in local time and when the reward returns
  const dl = page.locator("[data-bounty-deadline]");
  const days = [1, 3, 7, 14, 30].filter((d) => d * 86_400 >= board.escrow.min_ttl_s && d * 86_400 <= board.escrow.max_ttl_s);
  await expect(dl.locator(".seg button")).toHaveCount(days.length + 1);
  await expect(dl.locator("select")).toHaveCount(0);
  if (days.includes(7)) await expect(dl.locator('.seg button[aria-pressed="true"]')).toHaveText("1 week");
  const endOf = async () => Number(await dl.locator("[data-deadline-end]").getAttribute("data-deadline-end"));
  const nowS = Math.floor(Date.now() / 1000);
  if (days.includes(7)) expect(Math.abs((await endOf()) - nowS - 7 * 86_400)).toBeLessThan(120);
  await expect(dl.locator("[data-deadline-line]")).toContainText("If nobody wins, the reward returns to your wallet from");
  await expect(dl.locator('[name="bo_days_custom"]')).toHaveCount(0);
  await dl.locator('.seg button', { hasText: "Custom" }).click();
  await dl.locator('[name="bo_days_custom"]').fill("3");
  expect(Math.abs((await endOf()) - nowS - 3 * 86_400)).toBeLessThan(120);
  await dl.locator('[name="bo_days_custom"]').fill("100000");
  await expect(dl.locator("[data-deadline-line]")).toContainText("Enter a number of days between");
  await dl.locator('[name="bo_days_custom"]').fill("3");
  // typed values survive the redraws
  await expect(form.locator('[name="bo_pct"]')).toHaveValue("5");
  await form.locator('[name="bo_pct"]').fill(String(Math.max(10, metricMin / 100)));
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
  // the requirement is explained in the review too, by the same toggle
  await expect(review.locator("[data-rq-toggle]")).toHaveCount(1);
  await review.locator("[data-rq-toggle]").click();
  await expect(review.locator('.rq-panel [data-rq-line="one"]')).toContainText("It is one change");
  await review.locator("[data-rq-toggle]").click();
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

// "Posted by an owner of owner/repo" (docs/plans/OPEN-BOUNTIES.md 9) shows on exactly the bounties Core
// marks, with the repository Core names; the filter exists only when one bounty carries the mark.
test("a bounty is marked as posted by an owner only where Core says so", async ({ page, request }) => {
  const board = await (await request.get("/api/bounties/board")).json().catch(() => null);
  test.skip(!board || (!board.settings && !board.escrow), "the board is not open on this site");
  await page.goto("/bounties");
  await page.locator(".bo-page .bo-how").first().waitFor({ timeout: 60_000 });
  const owned = (board.bounties as any[]).filter((b) => b.posted_by_owner?.verified === true);
  await expect(page.locator("[data-bounty-owner]")).toHaveCount(owned.filter((b) => !b.repo || /^https?:\/\//.test(b.repo)).length);
  await expect(page.locator("[data-bounty-filter]")).toHaveCount(owned.length ? 1 : 0);
  for (const b of owned.slice(0, 3)) await expect(page.locator(`article[data-bounty="${b.bounty_id}"] [data-bounty-owner]`)).toContainText(`Posted by an owner of ${b.posted_by_owner.repository}`);
  await cleanPage(page);
});

// "Request a repository" (docs/plans/OPEN-BOUNTIES.md 10): on an open board the box is beside the post
// form; a repository that already has a unit is sent to the post form and no request is offered for
// it; requested repositories are listed with their interest named as interest. Nothing is signed here.
test("Request a repository: the box, a repository that already has units, and the list", async ({ page, request }) => {
  const board = await (await request.get("/api/bounties/board")).json().catch(() => null);
  test.skip(!board || (!board.settings && !board.escrow), "the board is not open on this site");
  const listed = await request.get("/api/repo-requests");
  test.skip(!listed.ok(), "this site's Core does not serve repository requests yet");
  const list = await listed.json();
  await page.goto("/bounties");
  const box = page.locator("[data-repo-request]");
  await box.waitFor({ timeout: 90_000 });
  await expect(box).toContainText("Want a bounty on a repository that is not in the list? Ask for it here.");
  const unit = (board.units as any[]).find((u) => /^https:\/\/github\.com\//.test(u.repo));
  if (unit) {
    const name = (unit.repo as string).replace("https://github.com/", "");
    await box.locator('[name="rq_repo"]').fill(name);
    await box.locator('[data-request-act="check"]').click();
    await expect(box.locator('[data-request-state="has_units"]')).toContainText("can already be measured", { timeout: 60_000 });
    await expect(box.locator('[data-request-act="send"]')).toHaveCount(0);
  }
  await expect(page.locator("[data-repo-requests]")).toHaveCount(list.requests.length ? 1 : 0);
  for (const r of (list.requests as any[]).slice(0, 3)) {
    const row = page.locator(`[data-request="${r.name}"]`);
    await expect(row.locator("[data-request-n]")).toHaveText(String(r.requesters));
    await expect(row).toContainText("stated interest");
  }
  expect(await monoChrome(page), "monospace on UI chrome").toEqual([]);
  await cleanPage(page);
});

// "What does this mean?" beside a requirement and "How improvement is measured" on the board (owner
// 2026-10-13): closed by default, one open at a time, and every figure in the panel is one Core serves.
test("the board explains how improvement is measured, with a live unit's own numbers", async ({ page, request }) => {
  const board = await (await request.get("/api/bounties/board")).json().catch(() => null);
  test.skip(!board || (!board.settings && !board.escrow), "the board is not open on this site");
  const unit = (board.units as any[]).find((u) => /^https?:\/\//.test(u.repo) && u.metrics.length);
  test.skip(!unit, "this site has no unit a bounty can name");
  await page.goto("/bounties");
  const top = page.locator("[data-rq-general]");
  await top.waitFor({ timeout: 60_000 });
  const btn = top.locator("[data-rq-toggle]");
  await expect(btn).toHaveText("How improvement is measured");
  await expect(btn).toHaveAttribute("aria-expanded", "false");
  await expect(top.locator(".rq-panel")).toBeHidden();
  await btn.click();
  await expect(btn).toHaveAttribute("aria-expanded", "true");
  const panel = top.locator(".rq-panel");
  await expect(panel.locator('[data-rq-line="example"]')).toContainText(unit.metrics[0].name);
  await expect(panel.locator('[data-rq-line="now"]')).toBeVisible({ timeout: 60_000 });
  // the value in the panel is one Core serves for that unit and metric
  const u = await (await request.get(`/api/lineages/${unit.lineage_id}`)).json();
  const g = u.height > 0 ? await (await request.get(`/api/generations/${u.tip}`)).json() : null;
  const served = [u.calibration.metrics[unit.metrics[0].name]?.base_value, ...((g?.replays ?? []) as any[]).flatMap((r) => r.result?.metrics?.[unit.metrics[0].name]?.cand ?? [])].filter((x) => typeof x === "number");
  const now = await panel.locator('[data-rq-line="now"]').innerText();
  expect(served.some((v: number) => now.includes(Math.round(v).toLocaleString("en-US"))), `a served value in: ${now}`).toBe(true);
  await expect(panel.locator('[data-rq-line="moving"]')).toContainText("the unit's best moves");
  expect(await monoChrome(page), "monospace on UI chrome").toEqual([]);
  await cleanPage(page);
  await page.keyboard.press("Escape");
  await expect(btn).toHaveAttribute("aria-expanded", "false");
  // every card with a requirement carries its own toggle
  const withAsk = (board.bounties as any[]).filter((b) => b.metric && b.required && (!b.repo || /^https?:\/\//.test(b.repo))).length;
  await expect(page.locator("article.bo-card [data-rq-toggle]")).toHaveCount(withAsk);
});
