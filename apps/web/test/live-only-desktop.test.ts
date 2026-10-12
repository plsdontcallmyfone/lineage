import { describe, expect, test } from "bun:test";
import { desktopOf, idleCaption, idleHeadline, idleStatus, idleSub } from "../src/live-panel/live-only.ts";

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
