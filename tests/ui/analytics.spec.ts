import { cleanPage, monoChrome } from "./support/checks.ts";
import { expect, test } from "./support/fixtures.ts";

// Analytics expansion (docs/plans/PAGES-PROJECTS-GENERATIONS-ANALYTICS.md 5): nine sections behind a
// sticky section nav, each figure equal to its Core route; test launches only with ?hidden=1; no fee
// wording; no horizontal scroll, no em dash, no monospace chrome; charts drawn (SVG) at 1280 and 390.

const FEES = /fees? (claimed|to compute|split)|crank/i;
const SECTIONS = ["an-network", "an-work", "an-results", "an-costs", "an-models", "an-verification", "an-market-sec", "an-social", "an-launches"];
const int = (n: number) => n.toLocaleString("en-US");

for (const win of ["7d", "24h"]) {
  test(`Analytics sections (${win}): nav, figures equal the section routes, no test launch, no fee figure`, async ({ page, data }) => {
    const q = `window=${win}`;
    const [work, results, ver, social, launches, spend] = await Promise.all(["work", "results", "verifiers", "social", "launches", "spend"].map((r) => data.core(`analytics/${r}?${q}`)));
    await page.goto(win === "7d" ? "/analytics" : `/analytics?window=${win}`);
    await page.locator(".an-page").waitFor({ timeout: 90_000 });

    // the sticky nav links every section, and every section is there
    await expect(page.locator(".an-nav a")).toHaveCount(SECTIONS.length);
    for (const id of SECTIONS) {
      await expect(page.locator(`#${id}`)).toHaveCount(1);
      await expect(page.locator(`.an-nav a[href="#${id}"]`)).toHaveCount(1);
    }
    expect(await page.locator(".an-nav").evaluate((e) => getComputedStyle(e).position)).toBe("sticky");

    // agent work: attempts equal the outcome totals; lines changed and conflicts as Core counts them
    const attempts = Object.values(work.outcomes.totals as Record<string, number>).reduce((s, n) => s + n, 0);
    await expect(page.locator("#an-work .ins-kpis b").first()).toHaveText(int(attempts));
    await expect(page.locator("#an-work")).toContainText(`${work.lines.n} generations`);
    for (const c of work.conflicts) await expect(page.locator("#an-work")).toContainText(c.project);
    // results: one record row per metric (15 shown, the rest behind "more")
    const recRows = page.locator("#an-results details.an-more tr, #an-results .panel:has-text('Record progression') > .tw tbody tr");
    expect(await recRows.count()).toBeGreaterThanOrEqual(Math.min(results.metrics.length, 15));
    for (const w of results.wins.all_time.slice(0, 3)) await expect(page.locator("#an-results")).toContainText(`${w.gain_pct.toFixed(2)}%`);
    // verification: replays and verifiers
    await expect(page.locator("#an-verification")).toContainText(`${ver.verifiers.length} verifiers`);
    // social: org members and episodes
    await expect(page.locator("#an-social")).toContainText(int(social.totals.episodes));
    if (social.org.members) await expect(page.locator("#an-social .an-chips a")).toHaveCount(social.org.members.length);
    // launches: one row per launched agent
    await expect(page.locator("#an-launches .panel:has-text('Launched agents') tbody tr")).toHaveCount(launches.agents.length);
    // cost: Anthropic spend of the window
    if (spend.anthropic.attempts) await expect(page.locator("#an-costs-x")).toContainText(`${spend.anthropic.attempts} priced attempts`);

    // charts are drawn
    expect(await page.locator(".an-viz svg").count()).toBeGreaterThan(8);

    // no test launch linked without ?hidden=1
    const hidden = new Set((await data.hidden()).map((h) => h.agent).filter(Boolean));
    const linked = await page.locator(".an-page a[href^='/agents/']").evaluateAll((els) => els.map((e) => (e.getAttribute("href") ?? "").split("/")[2]));
    expect(linked.filter((a) => hidden.has(a!)), "test launches linked without ?hidden=1").toEqual([]);

    await expect(page.locator(".an-page")).not.toContainText(FEES);
    expect(await monoChrome(page)).toEqual([]);
    await cleanPage(page);
  });
}

test("Analytics: the nav marks the section scrolled to", async ({ page }) => {
  await page.goto("/analytics");
  await page.locator(".an-page").waitFor({ timeout: 90_000 });
  await page.locator(".an-nav a[href='#an-social']").click();
  await expect(page.locator(".an-nav a[href='#an-social']")).toHaveAttribute("aria-current", "true", { timeout: 10_000 });
});
