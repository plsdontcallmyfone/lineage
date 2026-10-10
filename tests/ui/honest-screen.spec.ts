import type { Page } from "@playwright/test";
import { cleanPage } from "./support/checks.ts";
import { expect, test } from "./support/fixtures.ts";

// The honest screen (owner 2026-10-10: "i just want the screen to be honest"; apps/web/src/live-panel):
// a live agent's screen is its real desktop video, moving, with no drawn browser around it (no tab
// strip, address bar, profile avatar, window controls, no "Show the reconstruction"); every other state
// is text on a lit screen, never a black box. Live data from the site; only the idle test turns the
// agent's live session into an ended one so the idle state shows.

const FAKE = ".cr, .cr-strip, .cr-tab, .cr-omni, .cr-avatar, .cr-lights, .cr-desk-sw, .lp-deskback";

/** Two frames of the screen's video, a few seconds apart: playback time, and how much of each frame is not black. */
async function frames(page: Page) {
  const grab = () =>
    page.evaluate(() => {
      const v = document.querySelector<HTMLVideoElement>(".lp-scr video");
      if (!v || v.readyState < 2 || !v.videoWidth) return null;
      const c = document.createElement("canvas");
      c.width = 160;
      c.height = 100;
      const x = c.getContext("2d")!;
      x.drawImage(v, 0, 0, 160, 100);
      const d = x.getImageData(0, 0, 160, 100).data;
      let lit = 0;
      let h = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i]! + d[i + 1]! + d[i + 2]! > 60) lit++;
        h = (h * 31 + d[i]! + 7 * d[i + 1]! + 13 * d[i + 2]!) >>> 0;
      }
      return { t: v.currentTime, lit: lit / (d.length / 4), h, w: v.videoWidth, vh: v.videoHeight };
    });
  const a = await grab();
  await page.waitForTimeout(4000);
  const b = await grab();
  return { a, b };
}

test.describe("Honest screen", () => {
  test("a live agent's screen is its desktop video, moving, with nothing simulated around it", async ({ page, data }) => {
    const live = (await data.core("sessions?limit=40")) as any[];
    const tokens = await data.tokens();
    const s = live.find((x) => x.state === "live" && x.desktop && tokens.some((t) => t.agent === x.agent));
    test.skip(!s, "no listed agent is live on a desktop right now");
    const t = tokens.find((x) => x.agent === s.agent)!;
    await page.goto(`/tokens/${t.mint}`);
    const scr = page.locator(".mk-livepanel .lp-scr");
    await scr.waitFor({ timeout: 60_000 });
    await expect(scr).toHaveAttribute("data-kind", "live", { timeout: 60_000 });
    await expect(page.locator(".mk-livepanel")).not.toContainText("Show the reconstruction");
    await expect(page.locator(`.mk-livepanel :is(${FAKE})`)).toHaveCount(0);
    // the video fills the screen at the desktop's own shape
    const box = await scr.boundingBox();
    const vbox = await scr.locator("video").boundingBox();
    expect(Math.abs(vbox!.width - box!.width)).toBeLessThan(2);
    const { a, b } = await frames(page);
    expect(a && b, "two decoded frames").toBeTruthy();
    expect(b!.t - a!.t, "playback time moves").toBeGreaterThan(1);
    expect(a!.lit, "the frame is not black").toBeGreaterThan(0.05);
    expect(b!.lit, "the frame is not black").toBeGreaterThan(0.05);
    // the caption states facts: who, on which repository, and the server-side sealing
    await expect(page.locator(".mk-livepanel .lp-say .t")).toContainText(/^Live: .+ working on .+/);
    await expect(page.locator(".mk-livepanel .lp-note")).toContainText("pixelated on the server until the verdict");
    await cleanPage(page);
  });

  test("an idle agent's screen is lit text, not a black box", async ({ page, data }) => {
    const t = (await data.tokens())[0];
    await page.route(/\/api\/sessions\?(.*&)?agent=/, async (route) => {
      const r = await route.fetch();
      const list = (await r.json().catch(() => [])) as any[];
      const ended = (Array.isArray(list) ? list : []).map((x) => (x.state === "live" ? { ...x, state: "ended", ended_at: x.last_at } : x));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ended) });
    });
    await page.goto(`/agents/${t.agent}/profile`);
    const scr = page.locator(".mk-livepanel .lp-scr");
    await expect(scr).toHaveAttribute("data-kind", "idle", { timeout: 60_000 });
    await expect(scr.locator(".lp-msg-t")).toHaveText(/^(Desktop ended: next session starting|Agent idle since .+|Agent idle: no session has run yet|Paused: .+)$/);
    await expect(scr.locator("video")).toBeHidden();
    await expect(page.locator(`.mk-livepanel :is(${FAKE})`)).toHaveCount(0);
    const lum = await scr.evaluate((el) => {
      const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(el).backgroundColor)!;
      const [r, g, b] = m[1]!.split(/[\s,/]+/).map(Number) as [number, number, number];
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    });
    expect(lum, "the screen is lit").toBeGreaterThan(0.5);
    await cleanPage(page);
  });

  test("a stream that is not there says why in words", async ({ page, data }) => {
    const live = (await data.core("sessions?limit=40")) as any[];
    const tokens = await data.tokens();
    const s = live.find((x) => x.state === "live" && x.desktop && tokens.some((t) => t.agent === x.agent));
    test.skip(!s, "no listed agent is live on a desktop right now");
    const t = tokens.find((x) => x.agent === s.agent)!;
    // the desktop service's own answer for a session it has no desktop for
    await page.route(/\/desktops\/[0-9a-f]{64}\//, (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "no_desktop" }) }));
    await page.goto(`/tokens/${t.mint}`);
    const scr = page.locator(".mk-livepanel .lp-scr");
    await expect(scr).toHaveAttribute("data-kind", "unavailable", { timeout: 60_000 });
    await expect(scr.locator(".lp-msg-t")).toHaveText("Stream unavailable: the desktop service has no desktop for this session");
    await expect(scr).toContainText("Repository");
    await expect(scr).toContainText("Started");
  });
});
