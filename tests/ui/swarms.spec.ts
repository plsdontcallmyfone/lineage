import { cleanPage, monoChrome } from "./support/checks.ts";
import { expect, NO_COINS, test, type Page } from "./support/fixtures.ts";

// Swarms: one coin, several agents (docs/plans/SWARMS.md 6).
//
// Where the app's Core runs with the `swarms` flag off (every deployed site until the owner opens it)
// the pages are what they were: the coin page's second view reads "Computer", the launch form has no
// Agents field and no swarm route is asked for. That is what runs by default.
//
// With UI_SWARM_AGENT=<agent id> the app under test reads a Core that has swarms on and that agent as
// a swarm (the local proof, scripts/swarms/proof.ts --serve, with the dashboard's --core pointed at
// it). The market indexer knows no coin for a simulated agent, so one listed coin's indexer rows are
// answered with that agent id in place of their own; everything about the swarm itself (seats, their
// states, the record) is Core's real answer.

const SWARM = process.env.UI_SWARM_AGENT ?? "";
/** A repository the Core under test has a unit for (the local proof serves keis/base58). */
const REPO = process.env.UI_SWARM_REPO ?? "https://github.com/keis/base58";

/**
 * The launch form opens a later step only once the steps before it are complete (wallet/main.ts
 * renderWizard): the coin is named and the repository checked before "The agent" can be reached.
 */
async function toAgentStep(page: Page) {
  await page.locator('[name="l_name"]').fill("Swarm Check");
  await page.locator('[name="l_symbol"]').fill("SWRM");
  const next = page.locator('[data-act="lz-next"]');
  await expect(next).toBeEnabled();
  await next.click();
  await page.locator('[name="l_repo"]').fill(REPO);
  await page.locator("#w-work .lz-rec, #w-work .banner").first().waitFor({ timeout: 90_000 });
  await expect(next).toBeEnabled({ timeout: 90_000 });
  await next.click();
  await expect(page.locator("#lz-nav .lz-step", { hasText: "The agent" })).toBeEnabled();
}

/** A read of Core through the app, waited out when the site's gate asks (it limits reads per address). */
async function core(page: Page, path: string): Promise<any> {
  for (let i = 0; ; i++) {
    const r = await page.request.get(path, { headers: { accept: "application/json" } });
    if (r.ok()) return r.json();
    if (i >= 5 || ![429, 502, 503].includes(r.status())) throw new Error(`GET ${path}: HTTP ${r.status()}`);
    await page.waitForTimeout(1000 * Math.min(20, Number(r.headers()["retry-after"] ?? 5)));
  }
}
/** The swarm's own coin where the market lists it (a real swarm); else the first listed coin stands in for it (the local proof). */
const coinOf = (tokens: any[]): string => (tokens.find((t) => t.agent === SWARM) ?? tokens[0]).mint as string;

/** A listed coin served with the swarm's agent id (the swarm run only). */
async function asSwarmCoin(page: Page, mint: string) {
  const swap = async (route: import("@playwright/test").Route, f: (j: any) => void) => {
    const res = await route.fetch();
    const j = await res.json().catch(() => null);
    if (!j) return route.fulfill({ response: res });
    f(j);
    return route.fulfill({ response: res, json: j });
  };
  // the other coins' avatars live on the deployed site's Core, not on the swarm's: answered with a blank image here
  await page.route("**/api/media/**", (r) => r.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64") }));
  await page.route(`**/market/tokens/${mint}`, (r) => swap(r, (j) => (j.agent = SWARM)));
  await page.route(/\/market\/tokens(\?[^/]*)?$/, (r) => swap(r, (j) =>
    (j.tokens ?? []).forEach((t: any) => {
      if (t.mint === mint) t.agent = SWARM;
      t.session = null; // the listed coins' sessions live on the deployed site's Core, not on the swarm's
    }),
  ));
}

test.describe("swarms are off (the default): the pages are what they were", () => {
  test.skip(!!SWARM, "this run reads a Core with swarms on");

  test("a coin page says Computer and asks for no swarm route", async ({ page, data }) => {
    const tokens = await data.tokens();
    test.skip(!tokens.length, NO_COINS);
    const asked: string[] = [];
    page.on("request", (r) => /\/api\/(swarms|agents\/[^/]+\/swarm)/.test(r.url()) && asked.push(r.url()));
    await page.goto(`/tokens/${tokens[0].mint}`);
    const seg = page.locator(".tk-view");
    await expect(seg.locator('[data-view-b="computer"]')).toHaveText("Computer");
    await expect(page.locator(".mk-buildpanel h2")).toHaveText("What the agent is building");
    await seg.locator('[data-view-b="computer"]').click();
    await expect(page.locator("#mk-live")).toBeVisible();
    await expect(page.locator("#mk-swarm")).toHaveCount(0);
    expect(asked, "no swarm route is requested while the flag is off").toEqual([]);
    await cleanPage(page);
  });

  test("the launch form has no Agents field and the credits minimum is Core's own", async ({ page }) => {
    await page.goto("/launch");
    await page.locator('[name="l_name"]').waitFor({ timeout: 60_000 });
    await expect(page.locator(".lz-swarm")).toHaveCount(0);
    await expect(page.locator('[name="l_sw_size"]')).toHaveCount(0);
    const cfg = await page.evaluate(() => fetch("/api/config").then((r) => r.json()));
    expect(cfg.network.features.swarms ?? false).toBe(false);
    await expect(page.locator('[name="l_deposit"]')).toHaveValue(String(cfg.network.prepay.default_usd));
    await cleanPage(page);
  });
});

test.describe("swarms are on: one coin, several agents", () => {
  test.skip(!SWARM, "set UI_SWARM_AGENT to run against a Core with swarms on (scripts/swarms/proof.ts --serve)");

  test("the coin page: a toggle per agent's computer, its screen and its own line, the rows and the record", async ({ page, data }) => {
    const tokens = await data.tokens();
    test.skip(!tokens.length, NO_COINS);
    const mint = coinOf(tokens);
    await asSwarmCoin(page, mint);
    const sw = await core(page, `/api/agents/${SWARM}/swarm`);
    expect(sw.size).toBeGreaterThanOrEqual(2);
    const narrow = (page.viewportSize()?.width ?? 1280) <= 640;
    await page.goto(`/tokens/${mint}`);
    await expect(page.locator(".mk-buildpanel h2")).toHaveText("What the swarm is building");
    // the control: Chart, then one button per agent's computer; the chart is shown first
    const seg = page.locator(".tk-view");
    const comps = seg.locator('[data-view-b="computer"]');
    await expect(comps).toHaveCount(sw.size);
    await expect(seg.locator('[data-view-b="chart"]')).toHaveAttribute("aria-pressed", "true");
    const pane = page.locator("#mk-swarm");
    await expect(pane).toBeHidden();
    for (const s of sw.seats) {
      const b = comps.nth(s.seat - 1);
      // the word is left out on a narrow screen (the number stays); the accessible name is whole either way
      expect((await b.innerText()).trim()).toBe(narrow ? String(s.seat) : `Computer ${s.seat}`);
      await expect(b).toHaveAttribute("aria-label", `Computer ${s.seat}: ${s.name}`);
    }
    // the control stays inside its panel (no overflow at 390)
    const fits = await seg.evaluate((e) => {
      const p = e.closest(".panel")!.getBoundingClientRect(), r = e.getBoundingClientRect();
      return r.left >= p.left - 1 && r.right <= p.right + 1 && e.scrollWidth <= e.clientWidth + 1;
    });
    expect(fits, "the view control fits its panel").toBe(true);
    const shows = async (s: any) => {
      await expect(comps.nth(s.seat - 1)).toHaveAttribute("aria-pressed", "true");
      await expect(seg.locator('[aria-pressed="true"]')).toHaveCount(1);
      await expect(pane).toBeVisible();
      // one screen (that agent's), or its resting line in words when the vault does not carry it; never an empty box, no tiles
      const view = (await core(page, `/api/agents/${SWARM}/swarm`)).seats.find((x: any) => x.seat === s.seat);
      if (view?.runtime?.state === "paused") await expect(pane.locator("#sw-live .sw-rest, #sw-live .lp-stage, #sw-live .lp").first()).toBeVisible();
      else await expect(pane.locator("#sw-live .lp-stage, #sw-live .lp, #sw-live .sw-rest")).not.toHaveCount(0);
      await expect(pane.locator("#sw-live")).not.toBeEmpty();
      await expect(pane.locator(".sw-tile")).toHaveCount(0);
      // its own line: name, role, model, and its last final result (or that it has none)
      const now = pane.locator("#sw-now");
      await expect(now).toContainText(s.name);
      await expect(now).toContainText(s.role === "lead" ? "Lead" : "Builder");
      await expect(now).toContainText(s.model.id);
      await expect(now.locator(".sw-nres")).toHaveText(/Accepted: |Rejected: |Expired: |No final result yet/);
      await expect(pane.locator('#sw-seats > li[aria-current="true"]')).toHaveCount(1);
      await expect(pane.locator('#sw-seats > li[aria-current="true"]')).toContainText(s.name);
    };
    const first = sw.seats[0], second = sw.seats[1];
    await comps.nth(0).click();
    await shows(first);
    // a row per agent: name, role, model, and its counts from Core
    const rows = pane.locator("#sw-seats > li");
    await expect(rows).toHaveCount(sw.size);
    for (const s of sw.seats) {
      const row = rows.nth(s.seat - 1);
      await expect(row).toContainText(s.name);
      await expect(row).toContainText(s.role === "lead" ? "Lead" : "Builder");
      await expect(row).toContainText(s.model.id);
      await expect(row).toContainText(`${s.totals.accepted} accepted of ${s.totals.final} final`);
    }
    // the record names the agent and model of every accepted change
    const rec = pane.locator("#sw-record > li");
    if (sw.record.length) {
      await expect(rec).toHaveCount(sw.record.length);
      await expect(rec.first()).toContainText(`by ${sw.record[0].name}`);
      await expect(rec.first()).toContainText(sw.record[0].model);
    } else await expect(rec.first()).toContainText("No accepted change yet");
    // the other computer's toggle, and a row as a second way to the same choice
    await comps.nth(1).click();
    await shows(second);
    await rows.nth(0).click();
    await shows(first);
    await comps.nth(1).click();
    await shows(second);
    expect(await monoChrome(page), "monospace on a computer's view").toEqual([]);
    await cleanPage(page);
    await page.screenshot({ path: test.info().outputPath("computer-2.png"), fullPage: true });
    // the choice is kept for this coin in this session, and the chart is where it falls back to
    await page.reload();
    await shows(second);
    await seg.locator('[data-view-b="chart"]').click();
    await expect(pane).toBeHidden();
    await expect(page.locator("#sw-live")).toBeEmpty();
    await page.reload();
    await expect(seg.locator('[data-view-b="chart"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#mk-swarm")).toBeHidden();
  });

  test("the agent profile's Desktop panel has the same toggle per agent's computer", async ({ page }) => {
    const sw = await core(page, `/api/agents/${SWARM}/swarm`);
    await page.goto(`/agents/${SWARM}/profile`);
    const seg = page.locator("#pf-seats");
    await expect(seg).toBeVisible();
    const b = seg.locator('[data-view-b="computer"]');
    await expect(b).toHaveCount(sw.size);
    // it opens on the lead's computer
    await expect(b.nth(sw.lead - 1)).toHaveAttribute("aria-pressed", "true");
    const other = sw.seats.find((s: any) => s.seat !== sw.lead);
    await b.nth(other.seat - 1).click();
    await expect(b.nth(other.seat - 1)).toHaveAttribute("aria-pressed", "true");
    await expect(seg.locator('[aria-pressed="true"]')).toHaveCount(1);
    await expect(page.locator("#pf-live .lp-stage, #pf-live .lp")).not.toHaveCount(0);
    await expect(b.nth(other.seat - 1)).toHaveAttribute("aria-label", `Computer ${other.seat}: ${other.name}`);
    await cleanPage(page);
  });

  test("the Explorer card of a swarm says how many agents it has", async ({ page, data }) => {
    const tokens = await data.tokens();
    test.skip(!tokens.length, NO_COINS);
    const mint = coinOf(tokens);
    await asSwarmCoin(page, mint);
    const list = await core(page, "/api/swarms");
    const mine = list.swarms.find((s: any) => s.agent === SWARM);
    await page.goto("/");
    const card = page.locator(`.ex-card[data-mint="${mint}"]`);
    await expect(card.locator(".ex-swarm")).toHaveText(`${mine.size} agents`);
    // one card per coin, whatever its number of agents
    await expect(page.locator(`.ex-card[data-agent="${SWARM}"]`)).toHaveCount(1);
    await cleanPage(page);
    await card.screenshot({ path: test.info().outputPath("explorer-card.png") });
  });

  test("the launch form: size, a row per agent, credits per agent and the cost before signing", async ({ page, guard }) => {
    test.setTimeout(480_000); // the agent's soul is written before Funding opens (up to a few minutes)
    const cfg = await page.request.get("/api/swarms/config").then((r) => r.json());
    const net = await page.request.get("/api/config").then((r) => r.json());
    const per = Number(net.network.prepay.min_usd);
    const usd = (x: number) => `$${x.toFixed(2)}`;
    await page.goto("/launch");
    await page.locator('[name="l_name"]').waitFor({ timeout: 60_000 });
    // an empty form: only the first step is open
    await expect(page.locator("#lz-nav .lz-step", { hasText: "The agent" })).toBeDisabled();
    await toAgentStep(page);
    const funding = page.locator("#lz-nav .lz-step", { hasText: "Funding" });
    const box = page.locator(".lz-swarm");
    await expect(box).toBeVisible();
    await expect(box.locator('[name="l_sw_size"]')).toHaveCount(cfg.max_now);
    // one agent: no rows, the credits minimum as ever
    await expect(box.locator(".lz-seat")).toHaveCount(0);
    const n = Math.min(3, cfg.max_now);
    await box.locator(`label.seg-b:has([name="l_sw_size"][value="${n}"])`).click();
    await expect(box.locator(".lz-seat")).toHaveCount(n);
    // exactly one lead, picked by default
    await expect(box.locator('select[name^="l_sw_role_"] option[value="lead"]:checked')).toHaveCount(1);
    // credits: Core's own minimum once per agent, never a number of the page's
    await expect(box).toContainText(`${usd(per)} for each agent, ${usd(per * n)} for ${n}`);
    if (cfg.settings.seat_desktop_usd_per_h) await expect(box).toContainText(`$${cfg.settings.seat_desktop_usd_per_h} an hour`);
    // Funding opens once this step is complete: the soul is written and the roster is valid
    await page.locator(".wl-soul .wl-hash").waitFor({ timeout: 300_000 });
    await expect(funding).toBeEnabled({ timeout: 30_000 });
    await funding.click();
    await expect(page.locator('[name="l_deposit"]')).toHaveValue(String(per * n));
    await expect(page.locator("#w-prepay")).toContainText(`At least ${usd(per * n)}`);
    await expect(page.locator("#w-prepay")).toContainText(`${usd(per)} for each of the ${n} agents`);
    // below it is refused in words
    await page.locator('[name="l_deposit"]').fill(String(per));
    await expect(page.locator("#w-prepay")).toContainText(`at least ${usd(per * n)}`);
    // back to one agent: the minimum is Core's own again
    await page.locator("#lz-nav .lz-step", { hasText: "The agent" }).click();
    await box.locator('label.seg-b:has([name="l_sw_size"][value="1"])').click();
    await expect(box.locator(".lz-seat")).toHaveCount(0);
    await funding.click();
    await expect(page.locator('[name="l_deposit"]')).toHaveValue(String(per));
    await page.locator("#lz-nav .lz-step", { hasText: "The agent" }).click();
    await box.locator(`label.seg-b:has([name="l_sw_size"][value="${n}"])`).click();
    expect(await monoChrome(page), "monospace on the launch form").toEqual([]);
    // the app's profile may have the fee route and repository pools on while the proof's Core has them off: the form asks
    // both once, takes the 404 as "off" (wallet/fee-route-step.ts), and the browser logs the two misses
    guard.errors.splice(0, guard.errors.length, ...guard.errors.filter((e) => !/\/api\/(fee-claims\/providers|pools\/config)\b/.test(e)));
    await cleanPage(page);
    await box.screenshot({ path: test.info().outputPath("wizard-agents.png") });
  });
});
