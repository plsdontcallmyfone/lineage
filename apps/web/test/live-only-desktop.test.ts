import { describe, expect, test } from "bun:test";
import { desktopOf, desktopWaitOf, idleCaption, idleHeadline, idleStatus, idleSub, idleTitle } from "../src/live-panel/live-only.ts";

// One E2B desktop per agent (runtime desktop_mode per_agent): while the agent's desktop is paused or
// missing the screen says so in words, from the runtime's own report. Never a picture.

describe("the agent's own desktop in the idle state", () => {
  const now = Date.UTC(2026, 9, 12, 12);
  test("read from the spend report; absent or malformed is no desktop state at all", async () => {
    expect(desktopOf({ spend: { desktop: { state: "paused", why: "agent idle", since: 5 } } })).toEqual({ state: "paused", why: "agent idle", since: 5 });
    expect(desktopOf({ spend: { desktop: { state: "melted" } } })).toBeNull();
    expect(desktopOf({ spend: { waiting: null } })).toBeNull();
    expect(desktopOf(null)).toBeNull();
    const st = await idleStatus(async () => ({ spend: { waiting: null, desktop: { state: "paused", why: "agent idle", since: now } } }), "agent-with-a-desktop", now - 3_600_000);
    expect(st).toEqual({ kind: "next", last_end: now - 3_600_000, desktop: { state: "paused", why: "agent idle", since: now } });
    // per-attempt desktops: nothing changes
    const old = await idleStatus(async () => ({ spend: { waiting: null } }), "agent-without", now);
    expect(old).toEqual({ kind: "next", last_end: now });
  });

  test("paused, starting and missing are said in words", () => {
    const paused = { kind: "next" as const, last_end: now - 40 * 60_000, desktop: { state: "paused" as const, why: "agent idle", since: now - 30 * 60_000 } };
    expect(idleHeadline(paused, now)).toBe("Desktop paused: agent idle");
    expect(idleCaption(paused, now)).toBe("Desktop paused: agent idle");
    expect(idleSub(paused, now)).toContain("(40 min ago). Its desktop is paused and resumes with its next session.");
    expect(idleHeadline({ kind: "next", last_end: null, desktop: { state: "none", why: "E2B desktop limit reached: 100 of 100 running", since: now } }, now)).toBe("No desktop: E2B desktop limit reached: 100 of 100 running");
    expect(idleHeadline({ kind: "next", last_end: null, desktop: { state: "starting", why: null, since: now } }, now)).toBe("Desktop starting");
    // a running desktop between sessions did not end
    const running = { kind: "next" as const, last_end: now - 60_000, desktop: { state: "running" as const, why: null, since: now - 3_600_000 } };
    expect(idleHeadline(running, now)).toBe("Next session starting");
    expect(idleCaption(running, now)).toBe("Next session starting");
    // the runtime's own pause keeps its headline; the desktop is in the line under it
    const vault = { kind: "vault" as const, last_end: now - 60_000, desktop: { state: "paused" as const, why: "agent asleep (vault empty)", since: now } };
    expect(idleHeadline(vault, now)).toBe("Paused: vault empty");
    expect(idleSub(vault, now)).toContain("Its desktop is paused");
  });
});

// A bound, funded agent whose attempts do not start for want of a desktop (the mainnet instance logged
// "E2B: day cap reached (0.0000 of 0 USD)" for 16 minutes while the page showed a spinner): the
// runtime's reason reaches the screen.
describe("waiting for a desktop", () => {
  const now = Date.parse("2026-10-12T18:20:00Z");
  const why = "E2B: day cap reached (0.0000 of 0 USD, UTC day 2026-10-12)";
  test("the reason is read from the spend report; other waits are not desktop waits", () => {
    expect(desktopWaitOf({ spend: { waiting: `waiting for a desktop: ${why}` } })).toBe(why);
    expect(desktopWaitOf({ spend: { waiting: "waiting for a desktop" } })).toBe("none is free");
    for (const w of [null, "", "asleep (vault below the wake threshold)", "provider balance low", "waiting for a quote price (none)"]) expect(desktopWaitOf({ spend: { waiting: w } })).toBeNull();
    expect(desktopWaitOf(null)).toBeNull();
  });
  test("the screen says Waiting for a desktop and why, on every surface, instead of a next session that is not coming", async () => {
    const st = await idleStatus(async () => ({ spend: { waiting: `waiting for a desktop: ${why}`, waiting_since: now - 16 * 60_000 } }), "agent-starved-of-a-desktop", null);
    expect(st).toEqual({ kind: "next", last_end: null, waiting_desktop: why });
    for (const say of [idleHeadline(st, now), idleCaption(st, now), idleTitle(st)]) expect(say).toBe(`Waiting for a desktop: ${why}`);
    // after an earlier session too
    expect(idleHeadline({ ...st, last_end: now - 60_000 }, now)).toBe(`Waiting for a desktop: ${why}`);
  });
  test("an empty vault or a low provider balance is still said first; no wait, no change", async () => {
    const asleep = await idleStatus(async () => ({ spend: { waiting: "asleep (vault below the wake threshold)" } }), "agent-asleep-x", null);
    expect(asleep.waiting_desktop).toBeUndefined();
    expect(idleHeadline(asleep, now)).toBe("Paused: vault empty");
    const fine = await idleStatus(async () => ({ spend: { waiting: null } }), "agent-fine-x", null);
    expect(fine).toEqual({ kind: "next", last_end: null });
    expect(idleHeadline(fine, now)).toBe("Agent idle: no session has run yet");
  });
});
