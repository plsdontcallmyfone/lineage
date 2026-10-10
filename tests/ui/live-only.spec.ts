import type { Page } from "@playwright/test";
import { cleanPage } from "./support/checks.ts";
import { expect, test, type Data } from "./support/fixtures.ts";

// Live only (owner direction 2026-10-10, apps/web/src/live-panel/live-only.ts): every surface that
// shows an agent's machine shows only work in progress. With no live session it shows the idle state
// (Starting next session with the last end, or the runtime's pause), never a replay of a past session
// and never a desktop recording. Session pages of ended sessions show the final facts without playback.
//
// The agent's session list is Core's real list with any live session turned into an ended one (so the
// idle state shows whatever the site is doing), and its spend report is answered per test to show each
// pause. Nothing else is stubbed.

type Spend = { provider_balance_low: boolean; spend: { waiting: string | null } | null } | null;

async function idleAgent(page: Page, agent: string, spend: Spend) {
  await page.route(/\/api\/sessions\?(.*&)?agent=/, async (route) => {
    const r = await route.fetch();
    const list = (await r.json().catch(() => [])) as any[];
    const ended = (Array.isArray(list) ? list : []).map((s) => (s.state === "live" ? { ...s, state: "ended", ended_at: s.last_at } : s));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ended) });
  });
  await page.route(new RegExp(`/api/agents/${agent}/spend$`), (route) =>
    // null: what Core answers when the runtime never reported the agent (packages/core/src/runtime-spend.ts)
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ agent, reported_at: null, price: null, ...(spend ?? { provider_balance_low: false, spend: null }) }) }),
  );
}

/** No replay of past work anywhere in the panel: no playback controls, no progress bar, no recording, no reconstructed code. */
async function noReplay(page: Page, scope: string) {
  const lp = page.locator(scope).first();
  await expect(lp.locator('[data-act="replay"], [data-act="play"], [data-act="restart"], [data-speed]')).toHaveCount(0);
  await expect(lp.locator(".lp-prog")).toBeHidden();
  await expect(lp.locator(".lp-l")).toHaveCount(0);
  await expect(lp.locator(".cr-desk-v[src]")).toHaveCount(0);
  await expect(lp.locator("video[src]")).toHaveCount(0);
  await expect(lp).not.toContainText(/Recording of the desktop|Replaying the session/);
}

async function pickToken(data: Data) {
  const tokens = await data.tokens();
  expect(tokens.length, "listed tokens").toBeGreaterThan(0);
  return tokens.find((t) => t.building?.session_id ?? t.session?.id) ?? tokens[0];
}

test.describe("Live only: idle state, no replay", () => {
  test("agent profile: Paused: provider balance low", async ({ page, data }) => {
    const t = await pickToken(data);
    await idleAgent(page, t.agent, { provider_balance_low: true, spend: { waiting: null } });
    await page.goto(`/agents/${t.agent}/profile`);
    const idle = page.locator('.lp-idle[data-idle="provider"]');
    await idle.waitFor({ timeout: 60_000 });
    await expect(idle).toContainText("Paused: provider balance low");
    await expect(page.locator(".lp-state").first()).toHaveText("Paused");
    await noReplay(page, ".lp");
    await cleanPage(page);
  });

  test("token page: Paused: vault empty", async ({ page, data }) => {
    const t = await pickToken(data);
    await idleAgent(page, t.agent, { provider_balance_low: false, spend: { waiting: "compute vault exhausted (0 base units unowed)" } });
    await page.goto(`/tokens/${t.mint}`);
    await page.locator("[data-view-b=computer]").click(); // the token page shows its chart first; the toggle shows the computer
    const idle = page.locator('.mk-livepanel .lp-idle[data-idle="vault"]');
    await idle.waitFor({ timeout: 60_000 });
    await expect(idle).toContainText("Paused: vault empty");
    await noReplay(page, ".mk-livepanel .lp");
    await cleanPage(page);
  });

  test("token page: Starting next session with the last session's end", async ({ page, data }) => {
    const t = await pickToken(data);
    const list = (await data.core(`sessions?agent=${t.agent}&limit=24`)) as any[];
    await idleAgent(page, t.agent, null);
    await page.goto(`/tokens/${t.mint}`);
    await page.locator("[data-view-b=computer]").click(); // the token page shows its chart first; the toggle shows the computer
    const idle = page.locator('.mk-livepanel .lp-idle[data-idle="next"]');
    await idle.waitFor({ timeout: 60_000 });
    await expect(idle).toContainText("Starting next session");
    await expect(idle).toContainText(list.length ? /Last session ended .+ \(.+\)\./ : /No session has run yet\./);
    await expect(page.locator(".mk-livepanel .lp-state").first()).toHaveText("Idle");
    await noReplay(page, ".mk-livepanel .lp");
    await cleanPage(page);
  });

  test("explorer card hover shows the idle state, not a past session", async ({ page, data }, info) => {
    test.skip(info.project.name.startsWith("mobile"), "hover needs a pointer device");
    expect((await data.tokens()).length, "listed tokens").toBeGreaterThan(0);
    await page.goto("/");
    const first = page.locator(".ex-card[data-agent]").first();
    await first.waitFor({ timeout: 60_000 });
    const agent = (await first.getAttribute("data-agent"))!;
    await idleAgent(page, agent, null);
    const card = page.locator(`.ex-card[data-agent="${agent}"]`).first();
    await card.locator(".ex-screen").hover();
    const idle = card.locator(".ex-livewrap .lp-idle");
    await idle.waitFor({ timeout: 60_000 });
    await expect(idle).toContainText(/Starting next session|Paused: /);
    await noReplay(page, `.ex-card[data-agent="${agent}"] .ex-livewrap`);
  });

  test("session page of an ended session: final facts, no playback", async ({ page, data }) => {
    const list = (await data.core("sessions?limit=60")) as any[];
    const s = list.find((x) => x.state === "final" && x.candidate) ?? list.find((x) => x.state !== "live");
    test.skip(!s, "Core lists no ended session");
    await page.goto(`/sessions/${s.session_id}`);
    const facts = page.locator(".lp-facts");
    await facts.waitFor({ timeout: 60_000 });
    await expect(facts).toHaveAttribute("data-facts", s.state);
    await expect(facts).toContainText("Session ended");
    if (s.state === "final" && s.candidate) {
      await expect(facts).toContainText(s.candidate.status);
      await expect(facts.locator(`a[href="/candidates/${s.candidate.candidate_id ?? s.candidate.commit_id}"]`)).toHaveCount(1);
      if (s.candidate.gen_id) await expect(facts.locator(`a[href="/generations/${s.candidate.gen_id}"]`)).toHaveCount(1);
    }
    await expect(page.locator(".lp-state").first()).toContainText("Ended");
    await expect(page.locator("#session-facts")).toContainText(s.session_id);
    await noReplay(page, ".lp");
    await cleanPage(page);
  });
});
