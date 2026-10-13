import { describe, expect, test } from "bun:test";
import { progressHtml, progressSteps, readProgress, type Progress } from "../wallet/launch-progress.ts";

// The launched screen's progress list (wallet/launch-progress.ts): the five steps to their exact
// words, which one is current, and that a time is said only when Core gives one.

const fresh: Progress = { hosted: true, bound: false, lifecycle: undefined, session: false, result: false, setup_minutes: null };
const view = (p: Progress) => progressSteps(p).map((s) => `${s.state} | ${s.title} | ${s.text}`);

describe("the steps", () => {
  test("right after a hosted launch that is not bound yet", () => {
    expect(view(fresh)).toEqual([
      "done | Launched | Your coin and its agent exist on Solana.",
      "now | Setup finished | One approval from your wallet lets the hosted runtime work for it.",
      "todo | Measurement ready | The agent sets up how its work on the repository is measured, and verifiers check it.",
      "todo | First session | Its first working session starts by itself.",
      "todo | First result | Verifiers replay its first change and judge it.",
    ]);
  });
  test("bound and setting up: the time only when Core has one from recorded setups", () => {
    expect(view({ ...fresh, bound: true, lifecycle: "setting_up" })[2]).toBe("now | Measurement ready | The agent sets up how its work on the repository is measured, and verifiers check it.");
    expect(view({ ...fresh, bound: true, lifecycle: "setting_up", setup_minutes: 14 })[2]).toBe("now | Measurement ready | The agent sets up how its work on the repository is measured, and verifiers check it. Usually within 14 minutes.");
    expect(view({ ...fresh, bound: true, lifecycle: "setting_up", setup_minutes: 1 })[2]).toContain("Usually within 1 minute.");
  });
  test("everything done", () => {
    expect(view({ hosted: true, bound: true, lifecycle: "active", session: true, result: true, setup_minutes: null })).toEqual([
      "done | Launched | Your coin and its agent exist on Solana.",
      "done | Setup finished | The hosted runtime can work for it.",
      "done | Measurement ready | The network can measure its work on the repository.",
      "done | First session | It has started working on the repository.",
      "done | First result | Verifiers have judged its first change.",
    ]);
  });
  test("a repository that already has its measurement: ready at once, the session is next", () => {
    expect(view({ ...fresh, bound: true, lifecycle: "active" }).map((s) => s.split(" | ")[0])).toEqual(["done", "done", "done", "now", "todo"]);
  });
  test("a self-hosted agent has no setup step", () => {
    expect(progressSteps({ ...fresh, hosted: false, bound: null, lifecycle: "active" }).map((s) => s.key)).toEqual(["launched", "ready", "session", "result"]);
  });
  test("no internal word, no em dash", () => {
    for (const p of [fresh, { ...fresh, bound: true, lifecycle: "active" as const, session: true, result: true }]) expect(view(p).join(" ")).not.toMatch(/—|\bTBA\b|\bbound\b|\bunit\b|recipe|lineage|calibrat/i);
  });
});

describe("one read", () => {
  const answers = (m: Record<string, unknown>) => {
    const asked: string[] = [];
    const f = (async (url: string) => {
      asked.push(url);
      const k = Object.keys(m).find((k) => url.startsWith(k));
      return k ? Response.json(m[k]) : new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    return { f, asked };
  };
  const base = { agent: "A", mint: "M", hosted: true, repo: "https://github.com/o/r" };
  test("Core has not read the launch yet: launched, and the status asks for the setup approval", async () => {
    const a = answers({ "/api/agents/A/profile": { _miss: { status: 404 } } });
    const r = await readProgress({ ...base, chainBound: async () => false }, a.f);
    expect(r.progress).toEqual({ hosted: true, bound: false, lifecycle: undefined, session: false, result: false, setup_minutes: null });
    expect(r.status.label).toBe("Finish setup");
    expect(a.asked.some((u) => u.startsWith("/api/repo-check"))).toBe(false);
  });
  test("setting up: the usual time is asked of the repository check; a live session and a judged change tick their steps", async () => {
    const a = answers({
      "/api/agents/A/profile": { lifecycle: "setting_up", awake: true, stats: { final: 0 } },
      "/api/agents/A/spend": { reported_at: Date.now(), spend: { waiting: "setting up: drafting the unit for o/r (draft 1 of 3)" } },
      "/api/repo-check": { state: "can_set_up", setup_minutes: 14 },
      "/market/tokens/M": { building: null, session: null },
    });
    const r = await readProgress({ ...base, chainBound: async () => true }, a.f);
    expect(r.progress).toMatchObject({ bound: true, lifecycle: "setting_up", setup_minutes: 14, session: false, result: false });
    expect(r.status).toMatchObject({ label: "Setting up", sentence: "It is writing how its work on this repository is measured. Verifiers check that next." });
    const b = answers({ "/api/agents/A/profile": { lifecycle: "active", awake: true, stats: { final: 2 } }, "/api/agents/A/spend": { reported_at: Date.now(), spend: {} }, "/market/tokens/M": { building: { live: true, session_id: "s" } } });
    const r2 = await readProgress({ ...base, chainBound: async () => true, setupMinutes: null }, b.f);
    expect(r2.progress).toMatchObject({ lifecycle: "active", session: true, result: true });
    expect(r2.status.label).toBe("Working");
    expect(b.asked.some((u) => u.startsWith("/api/repo-check"))).toBe(false);
  });
  test("the markup: one row per step with its state, then the status with its action", async () => {
    const r = await readProgress({ ...base, chainBound: async () => false }, answers({}).f);
    const h = progressHtml(progressSteps(r.progress), r.status, "BUTTON").s;
    expect(h.match(/class="lp-step"/g)!.length).toBe(5);
    expect(h).toContain('data-step-key="bound" data-state="now"');
    expect(h).toContain('<span class="as-l warn">Finish setup</span>');
    expect(h).toContain('<div class="as-a">BUTTON</div>');
  });
});
