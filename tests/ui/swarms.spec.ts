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

/** The first listed coin, served with the swarm's agent id (the swarm run only). */
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

  test("the coin page's Computers view: one large screen, tiles, a row per agent, the record", async ({ page, data }) => {
    const tokens = await data.tokens();
    test.skip(!tokens.length, NO_COINS);
    const mint = tokens[0].mint as string;
    await asSwarmCoin(page, mint);
    const sw = await page.request.get(`/api/agents/${SWARM}/swarm`).then((r) => r.json());
    expect(sw.size).toBeGreaterThanOrEqual(2);
    await page.goto(`/tokens/${mint}`);
    await expect(page.locator(".mk-buildpanel h2")).toHaveText("What the swarm is building");
    const b = page.locator('.tk-view [data-view-b="computer"]');
    await expect(b).toHaveText("Computers");
    await b.click();
    const pane = page.locator("#mk-swarm");
    await expect(pane).toBeVisible();
    // one large screen (the lead's by default) and a tile for every other agent
    await expect(pane.locator("#sw-live .lp-stage, #sw-live .lp")).not.toHaveCount(0);
    await expect(pane.locator(".sw-tile")).toHaveCount(sw.size - 1);
    const lead = sw.seats.find((s: any) => s.seat === sw.lead);
    await expect(pane.locator("#sw-now")).toContainText(lead.name);
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
    // a tile becomes the large screen
    const tile = pane.locator(".sw-tile").first();
    const name = (await tile.locator(".sw-tl span").first().innerText()).trim();
    await tile.click();
    await expect(pane.locator("#sw-now")).toContainText(name);
    await expect(pane.locator(".sw-tile")).toHaveCount(sw.size - 1);
    await expect(pane.locator(`#sw-seats > li[aria-current="true"]`)).toContainText(name);
    expect(await monoChrome(page), "monospace on the Computers view").toEqual([]);
    await cleanPage(page);
    await page.screenshot({ path: test.info().outputPath("computers.png"), fullPage: true });
  });

  test("the Explorer card of a swarm says how many agents it has", async ({ page, data }) => {
    const tokens = await data.tokens();
    test.skip(!tokens.length, NO_COINS);
    const mint = tokens[0].mint as string;
    await asSwarmCoin(page, mint);
    const list = await page.request.get("/api/swarms").then((r) => r.json());
    const mine = list.swarms.find((s: any) => s.agent === SWARM);
    await page.goto("/");
    const card = page.locator(`.ex-card[data-mint="${mint}"]`);
    await expect(card.locator(".ex-swarm")).toHaveText(`${mine.size} agents`);
    // one card per coin, whatever its number of agents
    await expect(page.locator(`.ex-card[data-agent="${SWARM}"]`)).toHaveCount(1);
    await cleanPage(page);
    await card.screenshot({ path: test.info().outputPath("explorer-card.png") });
  });

  test("the launch form: size, a row per agent, credits per agent and the cost before signing", async ({ page }) => {
    const cfg = await page.request.get("/api/swarms/config").then((r) => r.json());
    const net = await page.request.get("/api/config").then((r) => r.json());
    const per = Number(net.network.prepay.min_usd);
    const usd = (x: number) => `$${x.toFixed(2)}`;
    await page.goto("/launch");
    await page.locator('[name="l_name"]').waitFor({ timeout: 60_000 });
    await page.locator("#lz-nav .lz-step", { hasText: "The agent" }).click();
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
    await page.locator("#lz-nav .lz-step", { hasText: "Funding" }).click();
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
    await page.locator("#lz-nav .lz-step", { hasText: "Funding" }).click();
    await expect(page.locator('[name="l_deposit"]')).toHaveValue(String(per));
    await page.locator("#lz-nav .lz-step", { hasText: "The agent" }).click();
    await box.locator(`label.seg-b:has([name="l_sw_size"][value="${n}"])`).click();
    expect(await monoChrome(page), "monospace on the launch form").toEqual([]);
    await cleanPage(page);
    await box.screenshot({ path: test.info().outputPath("wizard-agents.png") });
  });
});
