import { cleanPage } from "./support/checks.ts";
import { expectFigures, readParams } from "./support/figures.ts";
import { expect, test, type Data } from "./support/fixtures.ts";

/** The listed token whose agent has a public session (the live panel needs one), else the top one. */
async function pickToken(data: Data) {
  const tokens = await data.tokens();
  expect(tokens.length, "listed tokens").toBeGreaterThan(0);
  return tokens.find((t) => t.building?.session_id ?? t.session?.id) ?? tokens[0];
}

test.describe("Token page (/tokens/:mint)", () => {
  test("every listed token: price, market cap, 24h volume and 24h change equal to the indexer; building; no fees", async ({ page, data }) => {
    const tokens = await data.tokens();
    for (const t of tokens) {
      await page.goto(`/tokens/${t.mint}`);
      await page.locator(".mk-statspanel .mk-stats").waitFor({ timeout: 60_000 });
      const labels = (await page.locator(".mk-stats .stat .eyebrow").allInnerTexts()).map((x) => x.trim().toLowerCase());
      expect(labels).toEqual(["market cap", "price", "24h volume", "24h change", "holders"]);
      const detail = await data.token(t.mint);
      const figs = await page.locator(".mk-stats").evaluate((el) =>
        ["price", "market_cap", "volume_24h", "change_24h"].map((f) => {
          const n = el.querySelector<HTMLElement>(`[data-f="${f}"]`);
          return { text: n?.textContent?.trim() ?? "TBA", exact: n ? Number(n.dataset.v) : null };
        }),
      );
      expectFigures(`${t.symbol ?? t.mint} page`, figs, detail);
      await expect(page.locator(".mk-buildpanel .bd-building")).toHaveCount(1);
      await expect(page.locator("#main")).not.toContainText(/fee history|fees and compute|fees to compute|crank/i);
      await expect(page.locator(".bd-hidden")).toHaveCount(0);
      await cleanPage(page);
    }
  });

  test("panels: head, feed | chart (or the computer) | trade, holders, transactions; curve, agent and commits", async ({ page, data }) => {
    const t = await pickToken(data);
    await page.goto(`/tokens/${t.mint}`);
    await page.locator(".mk-statspanel").waitFor({ timeout: 60_000 });
    for (const p of [".mk-buildpanel", ".mk-pricepanel", ".mk-tradepanel", ".mk-holderspanel", ".mk-activity", ".mk-curvepanel", ".mk-agentpanel"]) await expect(page.locator(p)).toBeVisible();
    // the chart (Lightweight Charts canvas) by default; the toggle swaps it for the agent's computer and back
    await expect(page.locator("#mk-chart canvas").first()).toBeVisible();
    await expect(page.locator(".mk-livepanel")).toBeHidden();
    await page.locator("[data-view-b=computer]").click();
    await expect(page.locator(".mk-livepanel")).toBeVisible();
    await expect(page.locator("#mk-chart")).toBeHidden();
    await page.locator("[data-view-b=chart]").click();
    await expect(page.locator("#mk-chart canvas").first()).toBeVisible();
    await page.locator(".cm-panel table, .cm-panel .empty, .cm-panel .banner").first().waitFor({ timeout: 60_000 });
    const repo = t.building?.repo ?? t.repo_url;
    if (repo) await expect(page.locator(".mk-buildpanel .bd-repo > span")).toHaveAttribute("title", repo);
    // transaction rows are the indexer's trades for this mint
    const trades = await data.get(`/market/tokens/${t.mint}/trades?limit=50`).catch(() => null);
    if (trades?.trades?.length) await expect(page.locator(".mk-trades > li").first()).toHaveAttribute("data-sig", trades.trades[0].signature);
    await cleanPage(page);
  });

  test("a hidden launch still resolves by direct link and is marked", async ({ page, data }) => {
    const h = (await data.hidden())[0];
    test.skip(!h, "the hidden list is empty");
    await page.goto(`/tokens/${h!.mint}`);
    await page.locator(".mk-statspanel").waitFor({ timeout: 60_000 });
    await expect(page.locator(".bd-hidden")).toContainText("Hidden from listings");
    await cleanPage(page);
  });
});

test.describe("Session page (/sessions/:id)", () => {
  test("the live panel plays the session; the facts equal Core's", async ({ page, data }) => {
    const t = await pickToken(data);
    const id = t.building?.session_id ?? t.session?.id;
    test.skip(!id, "no listed token has a public session");
    const s = await data.core(`sessions/${id}`);
    await page.goto(`/sessions/${id}`);
    await page.locator(".lp").first().waitFor({ timeout: 60_000 });
    await page.locator(".cr .cr-tab").first().waitFor({ timeout: 60_000 });
    await expect(page.locator(".lp lineage-device")).toHaveCount(1);
    await expect(page.locator(".cr .cr-lights i")).toHaveCount(3);
    await expect(page.locator("#session-facts")).toContainText(id!);
    const commit = (s.session ?? s).commit as string | undefined;
    if (commit) await expect(page.locator("#session-facts")).toContainText(commit.slice(0, 10));
    await cleanPage(page);
  });
});

test.describe("Agent profile (/agents/:id/profile)", () => {
  test("name, building and token figures equal Core and the indexer", async ({ page, data }) => {
    const t = await pickToken(data);
    const [p, detail] = await Promise.all([data.core(`agents/${t.agent}/profile`), data.token(t.mint)]);
    await page.goto(`/agents/${t.agent}/profile`);
    await page.locator(".pf-head").waitFor({ timeout: 60_000 });
    await expect(page.locator(".pf-name h1")).toHaveText(p.soul?.name ?? new RegExp(`^Agent ${t.agent.slice(0, 4)}`));
    await expect(page.locator(".pf-building .bd-building")).toHaveCount(1);
    await expect(page.locator(`.pf-chips a[href="/tokens/${t.mint}"]`)).toHaveCount(1);
    const block = page.locator(".panel .bd-params");
    await expect(block).toHaveCount(1);
    const { labels, figs } = await readParams(block);
    expect(labels).toEqual(["market cap", "price", "24h volume", "24h change", "holders"]);
    expectFigures(`${t.symbol} profile`, figs, detail);
    await expect(page.locator("#main")).not.toContainText(/fees? (claimed|to compute|split)|crank/i);
    await cleanPage(page);
  });
});
