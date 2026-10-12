import { cleanPage, monoChrome } from "./support/checks.ts";
import { fmtUsd, USD_NA } from "./support/figures.ts";
import { expect, test } from "./support/fixtures.ts";

// The Analytics dashboard (docs/plans/PAGES-PROJECTS-GENERATIONS-ANALYTICS.md 6): headline figures
// equal Core's GET /v1/analytics/dashboard, every chart is drawn with data or says in one line why
// not, tooltips give exact values, legends and variants redraw, the window applies to everything;
// protocol revenue equals Core's GET /v1/analytics/revenue (plan section 7), in US dollars (its _usd
// fields; "$ unavailable" without a dollar price, never the quote-coin sum);
// the network status is one slim strip and the platform cap block is gone; test launches only with
// ?hidden=1; no horizontal scroll, no em dash, no monospace chrome, no console error; at 1280 and 390.

/** The page's amount format (apps/web/src/market.ts fmtAmount). */
const amount = (n: number) => {
  const a = Math.abs(n);
  if (a >= 100_000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (a >= 1 || a === 0) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return n.toLocaleString("en-US", { maximumSignificantDigits: 4 });
};
const int = (n: number) => n.toLocaleString("en-US");
const CARDS = ["improvements", "revenue", "attempts", "spend", "cost", "models", "heat", "verification", "viewers", "runway", "price"];
const CANVAS = ["improvements", "spend", "cost", "verification", "viewers"];

async function open(page: import("@playwright/test").Page, q = "") {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource|net::ERR|429|502/.test(m.text()) && errors.push(m.text()));
  await page.goto(`/analytics${q}`);
  // the frame is there at once with skeletons; the figures replace them
  await page.locator(".an-page").waitFor({ timeout: 60_000 });
  await page.locator(".an-tile[data-kpi]").first().waitFor({ timeout: 90_000 });
  await expect(page.locator(".an-skel, .an-skel-t")).toHaveCount(0);
  return errors;
}

for (const win of ["7d", "24h", "30d", "all"]) {
  test(`Analytics dashboard (${win}): headline figures equal Core, charts drawn, nothing redundant`, async ({ page, data }) => {
    const d = await data.core(`analytics/dashboard?window=${win}`);
    const errors = await open(page, win === "7d" ? "" : `?window=${win}`);

    // eight headline figures, each with its change against the period before and a sparkline
    await expect(page.locator(".an-tile[data-kpi]")).toHaveCount(8);
    await expect(page.locator(".an-tile .an-delta")).toHaveCount(8);
    expect(await page.locator(".an-tile svg.an-spark, .an-tile .an-spark-none").count()).toBe(8);
    // accepted generations only ever grow inside a window; the page may be a few seconds newer than our read
    const shown = Number((await page.locator('[data-kpi="improvements"] b').innerText()).replace(/,/g, ""));
    expect(shown).toBeGreaterThanOrEqual(d.kpis.improvements.value);
    expect(shown).toBeLessThanOrEqual(d.kpis.improvements.value + 3);
    if (d.kpis.acceptance.value !== null) await expect(page.locator('[data-kpi="acceptance"] b')).toHaveText(/^\d+\.\d%$/);
    if (win === "all") await expect(page.locator('[data-kpi="improvements"] .an-delta')).toHaveText("all time");
    await expect(page.locator('[data-kpi="viewers"] b')).toHaveText(d.kpis.viewers.since === null ? "not sampled" : /^(\d[\d,]*|not sampled)$/);

    // the old page's nine sections and their nav are gone
    await expect(page.locator(".an-nav")).toHaveCount(0);
    for (const id of ["an-work", "an-results", "an-costs", "an-models", "an-social", "an-launches"]) await expect(page.locator(`#${id}`)).toHaveCount(0);
    await expect(page.locator(".an-page")).not.toContainText(/TBA|credits fronted/i);

    // every chart card is either drawn or says why not in one line; a card that cannot have data is not shown
    for (const id of CARDS) {
      const card = page.locator(`[data-card="${id}"]`);
      await expect(card).toHaveCount(1);
      if (!(await card.isVisible())) continue;
      const body = card.locator(".an-card-body");
      const drawn = (await body.locator("canvas").count()) + (await body.locator("svg.an-svg").count()) + (await body.locator(".an-bars").count());
      const note = await body.locator(".an-empty").count();
      expect(drawn + note, `${id}: drawn or explained`).toBeGreaterThan(0);
      if (note) await expect(body.locator(".an-empty")).toContainText(/since [A-Z][a-z]{2} \d+/);
    }
    if (d.kpis.improvements.value > 0) await expect(page.locator('[data-card="improvements"] canvas').first()).toBeVisible();
    if (d.kpis.spend.value !== null) await expect(page.locator('[data-card="spend"] canvas').first()).toBeVisible();

    // the window selector covers 24 h, 7 d, 30 d and all time
    await expect(page.locator(".ph-row .seg a.seg-b")).toHaveCount(4);
    await expect(page.locator(`.ph-row .seg a.seg-b[aria-pressed="true"]`)).toHaveCount(1);

    // live sessions carry their viewer count (or a plain link while the gate's counts are not sampled)
    for (const row of await page.locator("#an-live li").all()) await expect(row.locator(".an-live-w")).toHaveText(/^(\d[\d,]* watching|watch)$/);

    // tables are folded closed
    expect(await page.locator("details.an-fold").count()).toBeGreaterThan(0);
    expect(await page.locator("details.an-fold[open]").count()).toBe(0);
    // the network status is one slim strip of one-line chips (label, coloured state, one detail); the
    // old large widgets and the platform cap block are gone
    const strip = page.locator("#an-network");
    await expect(strip).toHaveCount(1);
    await expect(page.locator(".an-grid, .an-w, .an-kpi")).toHaveCount(0);
    await expect(page.locator(".an-page")).not.toContainText(/Platform cap|Spent this window/i);
    const chips = strip.locator(".an-chip");
    expect(await chips.count()).toBeGreaterThanOrEqual(8);
    for (const id of ["core", "indexer", "runtime", "machines"]) await expect(strip.locator(`[data-chip="${id}"] b`)).not.toBeEmpty();
    for (const c of await chips.all()) expect(["good", "warn", "bad", "mute"]).toContain(await c.getAttribute("data-tone"));
    const wide = page.viewportSize()!.width >= 900;
    const chipBox = (await chips.first().boundingBox())!;
    expect(chipBox.height, "a chip is one line").toBeLessThanOrEqual(40);
    expect((await strip.boundingBox())!.height, "the status area is slim").toBeLessThanOrEqual(wide ? 240 : 520);
    // it sits under the charts
    expect((await strip.boundingBox())!.y).toBeGreaterThan((await page.locator("#an-charts").boundingBox())!.y);

    // no test launch linked without ?hidden=1
    const hidden = new Set((await data.hidden()).map((h) => h.agent).filter(Boolean));
    const linked = await page.locator(".an-page a[href^='/agents/']").evaluateAll((els) => els.map((e) => (e.getAttribute("href") ?? "").split("/")[2]));
    expect(linked.filter((a) => hidden.has(a!)), "test launches linked without ?hidden=1").toEqual([]);

    expect(await monoChrome(page)).toEqual([]);
    await cleanPage(page);
    expect(errors, "console errors").toEqual([]);
  });
}

test("Analytics charts: tooltips with exact values, legend toggles, scripted attempts off by default", async ({ page, data }) => {
  const d = await data.core("analytics/dashboard?window=all");
  const errors = await open(page, "?window=all");
  const sum = (o: Record<string, number>) => Object.values(o).reduce((s, n) => s + n, 0);

  // a canvas chart: the crosshair tooltip names the time in UTC and every series with a value
  for (const id of CANVAS) {
    const card = page.locator(`[data-card="${id}"]`);
    if (!(await card.isVisible()) || !(await card.locator("canvas").count())) continue;
    await card.scrollIntoViewIfNeeded();
    const box = (await card.locator(".an-lwc").first().boundingBox())!;
    let seen = false;
    for (const fx of [0.75, 0.6, 0.45, 0.3, 0.88]) {
      await page.mouse.move(box.x + box.width * fx, box.y + box.height * 0.5);
      await page.mouse.move(box.x + box.width * fx + 2, box.y + box.height * 0.5 + 1);
      if (await card.locator(".an-tip:not([hidden])").count()) {
        seen = true;
        break;
      }
    }
    if (page.viewportSize()!.width >= 900) {
      expect(seen, `${id}: tooltip on hover`).toBe(true);
      await expect(card.locator(".an-tip:not([hidden]) .an-tip-h")).toContainText("UTC");
      expect(await card.locator(".an-tip:not([hidden]) .an-tip-r").count()).toBeGreaterThan(0);
    }
    await page.mouse.move(2, 2);
  }

  // attempts: model attempts by default; the toggle adds the scripted ones
  const att = page.locator('[data-card="attempts"]');
  const scripted = sum(d.attempts.totals.scripted);
  const model = sum(d.attempts.totals.model);
  if (model + scripted > 0) {
    await att.scrollIntoViewIfNeeded();
    await expect(att.locator("svg.an-svg")).toHaveCount(1);
    await expect(att.locator(".an-card-legend")).not.toContainText("Scripted");
    if (scripted > 0) {
      await expect(att.locator('.an-card-seg button[aria-pressed="true"]')).toHaveText("Model attempts");
      await att.locator(".an-card-seg button", { hasText: "With scripted" }).click();
      await expect(att.locator(".an-card-seg button", { hasText: "With scripted" })).toHaveAttribute("aria-pressed", "true");
      await expect(att.locator(".an-card-legend")).toContainText("Scripted");
      await att.locator(".an-card-seg button", { hasText: "Model attempts" }).click();
      await expect(att.locator(".an-card-legend")).not.toContainText("Scripted");
    }
    // the bar under the pointer (or the tap) gives its bucket's exact counts
    const hit = att.locator("svg .hit").last();
    await hit.dispatchEvent("pointermove", { bubbles: true, clientX: 200, clientY: 300 });
    await expect(att.locator(".an-tip:not([hidden]) .an-tip-h")).toContainText("UTC");
    // a legend button hides its series and shows it again
    const lg = att.locator(".an-card-legend .an-lg").first();
    if (await lg.count()) {
      await lg.click();
      await expect(att.locator(".an-card-legend .an-lg").first()).toHaveAttribute("aria-pressed", "false");
      await att.locator(".an-card-legend .an-lg").first().click();
      await expect(att.locator(".an-card-legend .an-lg").first()).toHaveAttribute("aria-pressed", "true");
    }
  }

  // the cumulative chart switches between count and summed gain
  const imp = page.locator('[data-card="improvements"]');
  if (d.improvements.projects.length) {
    await imp.locator(".an-card-seg button", { hasText: "Summed gain" }).click();
    await expect(imp.locator(".an-pane-l").first()).toContainText("%");
    await expect(imp.locator("canvas").first()).toBeVisible();
  }

  // model comparison: one row per model with its sample beside the bar
  if (d.models.length) {
    await expect(page.locator('[data-card="models"] .an-bar-g').first().locator(".an-bar-r")).toHaveCount(d.models.length);
    await expect(page.locator('[data-card="models"] .an-bar-g').first()).toContainText(/of [\d,]+ attempts/);
  }

  // the agents table opens on demand, one row per agent of the route
  const fold = page.locator("#an-t-agents");
  if (await fold.count()) {
    await fold.locator("summary").click();
    expect(await fold.locator("tbody tr").count()).toBeGreaterThan(0);
  }
  await cleanPage(page);
  expect(errors, "console errors").toEqual([]);
});

test("Analytics: the window chips re-render in place, and test launches appear only with ?hidden=1", async ({ page, data }) => {
  await open(page);
  await page.locator('.ph-row a.seg-b:has-text("24 h")').click();
  await expect(page).toHaveURL(/window=24h/);
  await page.locator('.an-page[data-window="24h"] .an-tile[data-kpi]').first().waitFor({ timeout: 90_000 });
  await expect(page.locator('[data-card="attempts"] .an-card-h p')).toBeVisible();
  await page.locator('.ph-row a.seg-b:has-text("30 d")').click();
  await expect(page).toHaveURL(/window=30d/);
  await page.locator('.an-page[data-window="30d"] .an-tile[data-kpi]').first().waitFor({ timeout: 90_000 });

  const on = await data.core("analytics/dashboard?window=all&hidden=1");
  const off = await data.core("analytics/dashboard?window=all");
  expect(on.agents.length).toBeGreaterThanOrEqual(off.agents.length);
  const hidden = new Set((await data.hidden()).map((h) => h.agent).filter(Boolean));
  for (const a of off.agents) expect(hidden.has(a.agent)).toBe(false);
  for (const s of off.live) expect(hidden.has(s.agent)).toBe(false);
});

for (const win of ["7d", "all"]) {
  test(`Analytics protocol revenue (${win}): the figure, the chart and the split equal Core's records`, async ({ page, data }) => {
    const r = await data.core(`analytics/revenue?window=${win}`);
    const errors = await open(page, win === "7d" ? "" : `?window=${win}`);
    const src = (id: string) => r.sources.find((x: any) => x.id === id);
    const fees = src("creator_fees"), idp = src("identity");
    const tile = page.locator('[data-kpi="revenue"]');
    await expect(tile.locator(".an-tile-l")).toHaveText("Protocol revenue");

    // the headline figure: the window's inflows in US dollars (Core's kpi.usd: every source at the
    // indexer's dollar price). Cranks only ever add to a window and the price is read again every minute,
    // so the page may be a little off our read; without a dollar price the tile says "$ unavailable",
    // never the quote-coin sum
    if (fees.available && r.kpi.quote.value !== null) {
      const shown = (await tile.locator("b").innerText()).trim();
      if (r.kpi.usd?.value == null) expect(shown).toBe(USD_NA);
      else if (shown !== USD_NA) {
        expect(shown, "the revenue figure carries $").toMatch(/^\$/);
        const num = Number(shown.replace(/[$,]/g, "").replace(/K$/, "e3").replace(/M$/, "e6").replace(/B$/, "e9"));
        expect(num).toBeGreaterThanOrEqual(r.kpi.usd.value * 0.9 - 1e-12);
        expect(num).toBeLessThanOrEqual(r.kpi.usd.value * 1.3 + 0.01);
      }
      await expect(tile.locator("small")).toContainText("to the treasury and reserve");
    } else await expect(tile.locator("b")).toHaveText("not recorded");
    // units account payments are paid in SOL: their dollar value leads, the SOL amount beside it
    await expect(tile.locator("small")).toContainText(idp.available ? /[\d.,]+ SOL/ : "not recorded on this instance");
    if (idp.available && (await tile.locator("b").innerText()).trim().startsWith("$") && (await tile.locator("b").innerText()).trim() !== USD_NA) await expect(tile.locator("small")).toContainText(/\$[\d.,]+[KMB]? of it for units accounts/);

    // the chart: stacked bars by source, or one line saying why nothing is drawn
    const card = page.locator('[data-card="revenue"]');
    await expect(card).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    const any = r.kpi.quote.value_raw !== "0";
    if (any) {
      await expect(card.locator("svg.an-svg")).toHaveCount(1);
      await expect(card.locator(".an-card-legend")).toContainText("Creator fees, protocol share");
      await card.locator("svg .hit").last().dispatchEvent("pointermove", { bubbles: true, clientX: 200, clientY: 300 });
      await expect(card.locator(".an-tip:not([hidden]) .an-tip-h")).toContainText("UTC");
      await page.mouse.move(2, 2);
    } else await expect(card.locator(".an-empty")).toContainText(/since [A-Z][a-z]{2} \d+/);
    // the SOL view exists only where the identity service's records do
    await expect(card.locator(".an-card-seg button")).toHaveCount(idp.available ? 2 : 0);
    if (idp.available) {
      await card.locator(".an-card-seg button", { hasText: "SOL" }).click();
      if (idp.value_raw === "0") await expect(card.locator(".an-empty")).toContainText("No units account was bought");
      else await expect(card.locator("svg.an-svg")).toHaveCount(1);
      await card.locator(".an-card-seg button").first().click();
    }

    // where creator fees go: one stacked bar whose parts are the crank events' own amounts
    const split = page.locator("#an-split");
    await expect(split).toBeVisible();
    const cf = r.creator_fees;
    if (cf.available && cf.fees > 0) {
      const parts = [["compute", cf.to_compute], ["protocol", cf.to_protocol], ...(cf.routed > 0 ? [["routed", cf.routed]] : [])] as [string, number][];
      await expect(split.locator(".an-split-l li")).toHaveCount(parts.length);
      await expect(split.locator(".an-split > i")).toHaveCount(parts.filter(([, v]) => v > 0).length);
      // amounts only grow inside a window; when our read and the page's agree, the text is exact
      const again = await data.core(`analytics/revenue?window=${win}`);
      // each part in US dollars (the API's _usd field of the part), its quote-coin amount in the title
      if (again.creator_fees.fees_raw === cf.fees_raw)
        for (const [k, v] of parts) {
          const b = split.locator(`[data-part="${k}"] b`);
          const shown = (await b.innerText()).trim();
          const usd = again.creator_fees[`${k === "compute" ? "to_compute" : k === "protocol" ? "to_protocol" : "routed"}_usd`] as number | null;
          if (usd == null) expect(shown).toBe(USD_NA);
          else if (shown !== USD_NA) {
            expect(shown, `${k}: carries $`).toMatch(/^\$/);
            const num = Number(shown.replace(/[$,]/g, ""));
            expect(Math.abs(num - usd), `${k}: ${shown} against the API's ${fmtUsd(usd)}`).toBeLessThanOrEqual(Math.abs(usd) * 0.1 + 1e-12);
          }
          await expect(b).toHaveAttribute("title", new RegExp(`^${amount(v).replace(/[.]/g, "\\.")} `));
        }
    } else await expect(split.locator(".an-line")).toBeVisible();
    // every inflow with its account, folded closed; the compute sink is a running total outside the figure
    const fold = split.locator("#an-t-revenue");
    await fold.locator("summary").click();
    await expect(fold.locator("tbody tr")).toHaveCount(r.sources.length + 1);
    await expect(fold.locator("tbody tr").last()).toContainText("not part of the revenue figure");
    await expect(fold).not.toContainText("TBA");

    // no token page or card carries a fee figure (unchanged); and nothing here overflows
    await cleanPage(page);
    expect(await monoChrome(page)).toEqual([]);
    expect(errors, "console errors").toEqual([]);
  });
}

test("Analytics protocol revenue: test launches count only with ?hidden=1", async ({ data }) => {
  const off = await data.core("analytics/revenue?window=all");
  const on = await data.core("analytics/revenue?window=all&hidden=1");
  const hidden = new Set((await data.hidden()).flatMap((h) => [h.mint, h.agent]).filter(Boolean));
  for (const t of [...off.creator_fees.tokens, ...off.compute_sink.by_token]) expect(hidden.has(t.mint) || hidden.has(t.agent), `${t.mint} is hidden`).toBe(false);
  expect(BigInt(on.kpi.quote.lifetime_raw) >= BigInt(off.kpi.quote.lifetime_raw)).toBe(true);
  expect(on.creator_fees.lifetime.cranks).toBeGreaterThanOrEqual(off.creator_fees.lifetime.cranks);
  // a window is its buckets: each source's figure is the sum of its series
  for (const x of off.sources) expect(x.series_raw.reduce((t: bigint, v: string) => t + BigInt(v), 0n).toString()).toBe(x.value_raw);
});
