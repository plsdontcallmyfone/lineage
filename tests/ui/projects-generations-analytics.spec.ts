import { cleanPage, monoChrome } from "./support/checks.ts";
import { expect, test } from "./support/fixtures.ts";

// Projects, Generations and Analytics (docs/plans/PAGES-PROJECTS-GENERATIONS-ANALYTICS.md). Figures on
// the page equal Core's /v1/analytics/* answers; test launches only with ?hidden=1; no fee wording; no
// horizontal scroll, no em dash, no monospace chrome. Each page in both color schemes: the app has one
// theme (light), so the dark run checks that nothing depends on the system scheme.

const SCHEMES = ["light", "dark"] as const;
const FEES = /fees? (claimed|to compute|split)|crank/i;

for (const scheme of SCHEMES) {
  test.describe(`${scheme} scheme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
    });

    test("Projects: one card per project with Core's accepted counts and metric improvements", async ({ page, data }) => {
      const r = await data.core("analytics/projects");
      await page.goto("/projects");
      await page.locator(".pj-page").waitFor({ timeout: 60_000 });
      const cards = page.locator(".pj-card");
      await expect(cards).toHaveCount(r.projects.length);
      for (const p of r.projects.slice(0, 6)) {
        const card = page.locator(`.pj-card[data-project="${p.key}"]`);
        await expect(card.locator(".pj-figs b").first()).toHaveText(String(p.accepted));
        for (const m of p.lineages[0]?.metrics ?? []) {
          if (m.improvement_pct > 0) await expect(card).toContainText(`${m.improvement_pct.toFixed(2)}%`);
        }
      }
      await expect(page.locator(".pj-page")).not.toContainText(FEES);
      expect(await monoChrome(page)).toEqual([]);
      await cleanPage(page);
    });

    test("Project: charts, metric table and timeline equal Core; test launches withheld", async ({ page, data }) => {
      const list = await data.core("analytics/projects");
      const key = (list.projects.find((p: any) => p.accepted > 0) ?? list.projects[0]).key as string;
      const r = await data.core(`analytics/project?repo=${encodeURIComponent(key)}`);
      await page.goto(`/projects/${key}`);
      await page.locator(".pjd-page").waitFor({ timeout: 60_000 });
      const hidden = new Set((await data.hidden()).map((h) => h.agent).filter(Boolean));
      for (const l of r.lineages.filter((x: any) => x.status === "active" || x.timeline.length)) {
        const sec = page.locator(`.pjd-lin[data-lineage="${l.lineage_id}"]`);
        await expect(sec.locator("tr[data-gen]")).toHaveCount(l.timeline.length);
        for (const m of l.metrics) if (m.points.length || m.baseline !== null) await expect(sec.locator(`.ins-mini[data-metric="${m.name}"] svg`)).toHaveCount(1);
        for (const g of l.timeline) {
          if (g.author_hidden) expect(g.author).toBeNull();
          else expect(hidden.has(g.author)).toBe(false);
        }
      }
      const linked = await page.locator(".pjd-page a[href^='/agents/']").evaluateAll((els) => els.map((e) => (e.getAttribute("href") ?? "").split("/")[2]));
      expect(linked.filter((a) => hidden.has(a!)), "test launches linked without ?hidden=1").toEqual([]);
      await expect(page.locator(".pjd-page")).not.toContainText(FEES);
      await cleanPage(page);
    });

    test("Generations: rows, total and GitHub state equal Core; filters and sort; test launches only with ?hidden=1", async ({ page, data }) => {
      const r = await data.core("analytics/generations?limit=50");
      await page.goto("/generations");
      await page.locator(".gx-page").waitFor({ timeout: 60_000 });
      await expect(page.locator("tr[data-gen]")).toHaveCount(r.rows.length);
      await expect(page.locator(".ins-pager")).toContainText(`${r.total} accepted generation`);
      for (const row of r.rows.slice(0, 10)) {
        const tr = page.locator(`tr[data-gen="${row.gen_id}"]`);
        await expect(tr.locator(`a[href="/generations/${row.gen_id}"]`).first()).toBeVisible();
        await expect(tr.locator(`a[href="/generations/${row.gen_id}#github"]`)).toHaveText("How to verify");
        if (row.github?.verified) await expect(tr).toContainText("Verified on GitHub");
        expect(row.test_launch).toBe(false);
      }
      // sort by effect: the first row is Core's first
      const byEffect = await data.core("analytics/generations?limit=50&sort=effect");
      await page.locator('a.seg-b:has-text("Largest effect")').click();
      await expect(page).toHaveURL(/sort=effect/);
      if (byEffect.rows[0]) await expect(page.locator("tr[data-gen]").first()).toHaveAttribute("data-gen", byEffect.rows[0].gen_id);
      // a filter from the select
      if (r.facets.projects.length) {
        const k = r.facets.projects[0].key;
        const f = await data.core(`analytics/generations?limit=50&sort=effect&repo=${encodeURIComponent(k)}`);
        await page.locator('select[data-q-key="repo"]').selectOption(k);
        await expect(page).toHaveURL(new RegExp(`repo=${encodeURIComponent(k).replace(/[.%]/g, "\\$&")}`));
        await expect(page.locator(".ins-pager")).toContainText(`${f.total} accepted generation`);
      }
      const all = await data.core("analytics/generations?limit=50&hidden=1");
      await page.goto("/generations?hidden=1");
      await page.locator(".gx-page").waitFor({ timeout: 60_000 });
      await expect(page.locator(".ins-pager")).toContainText(`${all.total} accepted generation`);
      await cleanPage(page);
    });

    test("Analytics: network, costs, models, activity, verification and market equal their sources; no fee figure", async ({ page, data }) => {
      const o = await data.core("analytics/overview?window=7d");
      await page.goto("/analytics");
      await page.locator(".an-page").waitFor({ timeout: 60_000 });
      for (const id of ["an-network", "an-costs", "an-models", "an-activity", "an-verify", "an-market"]) await expect(page.locator(`#${id}`)).toHaveCount(1);
      await expect(page.locator("#an-models tr[data-model]")).toHaveCount(o.models.rows.length);
      await expect(page.locator("#an-costs tr[data-agent]")).toHaveCount(o.costs.by_agent.length);
      const hidden = new Set((await data.hidden()).map((h) => h.agent).filter(Boolean));
      for (const a of o.costs.by_agent) expect(hidden.has(a.agent)).toBe(false);
      await expect(page.locator("#an-activity")).toContainText(String(o.activity.generations_in_window));
      await expect(page.locator("#an-models")).toContainText(`from ${o.thresholds.min_attempts_for_rate} attempts`);
      const tokens = await data.tokens();
      await expect(page.locator("#an-market .ins-kpis b").first()).toHaveText(String(tokens.length));
      await expect(page.locator(".an-page")).not.toContainText(FEES);
      // the window chips re-render in place
      await page.locator('a.seg-b:has-text("24 h")').click();
      await expect(page).toHaveURL(/window=24h/);
      await expect(page.locator("#an-activity .panel-h")).toContainText("per hour");
      expect(await monoChrome(page)).toEqual([]);
      await cleanPage(page);
    });
  });
}

test("Eco links to Projects, Generations and Analytics", async ({ page }) => {
  await page.goto("/eco");
  await page.locator(".eco-page").waitFor({ timeout: 60_000 });
  for (const h of ["/projects", "/generations", "/analytics"]) await expect(page.locator(`.eco-links a[href="${h}"]`)).toHaveCount(1);
});
