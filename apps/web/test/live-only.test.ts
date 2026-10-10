import { describe, expect, test } from "bun:test";
import { endOf, idleCaption, idleStatus, idleSub, idleTitle, lastEndOf, pauseOf, RECORDINGS_SHOWN } from "../src/live-panel/live-only.ts";

// Live only (owner direction 2026-10-10): the UI shows live work, and with none an idle state read
// from the runtime's spend report (GET /v1/agents/:id/spend).

describe("live only", () => {
  test("recordings and replays are off", () => {
    expect(RECORDINGS_SHOWN).toBe(false);
  });

  test("pause from the spend report: provider balance low, vault empty, else none", () => {
    expect(pauseOf({ provider_balance_low: true, spend: { waiting: null } })).toBe("provider");
    expect(pauseOf({ provider_balance_low: false, spend: { waiting: "provider balance low (OpenRouter has 0.10 USD, 0.0000 free of running reserves)" } })).toBe("provider");
    expect(pauseOf({ provider_balance_low: false, spend: { waiting: "compute vault exhausted (0 base units unowed)" } })).toBe("vault");
    expect(pauseOf({ provider_balance_low: false, spend: { waiting: "asleep (vault below the wake threshold)" } })).toBe("vault");
    expect(pauseOf({ provider_balance_low: false, spend: { waiting: "global runtime cap (10 USD per 86400 s window) reached" } })).toBe(null);
    expect(pauseOf({ provider_balance_low: false, spend: null })).toBe(null);
    expect(pauseOf(null)).toBe(null);
  });

  test("idle status reads the spend route once and falls back to waiting for the next session", async () => {
    const asked: string[] = [];
    const st = await idleStatus(async (p) => (asked.push(p), { provider_balance_low: false, spend: { waiting: "compute vault exhausted (0 base units unowed)" } }), "AgentOne", 1000);
    expect(asked).toEqual(["agents/AgentOne/spend"]);
    expect(st).toEqual({ kind: "vault", last_end: 1000 });
    const none = await idleStatus(async () => {
      throw new Error("404");
    }, "AgentTwo", null);
    expect(none).toEqual({ kind: "next", last_end: null });
  });

  test("labels", () => {
    const now = Date.parse("2026-10-10T12:00:00Z");
    expect(idleTitle({ kind: "next", last_end: null })).toBe("Starting next session");
    expect(idleTitle({ kind: "vault", last_end: null })).toBe("Paused: vault empty");
    expect(idleTitle({ kind: "provider", last_end: null })).toBe("Paused: provider balance low");
    expect(idleSub({ kind: "next", last_end: now - 12 * 60_000 }, now)).toContain("(12 min ago)");
    expect(idleSub({ kind: "next", last_end: null }, now)).toBe("No session has run yet.");
    expect(idleCaption({ kind: "next", last_end: now - 3 * 3600_000 }, now)).toBe("Starting next session, last ended 3 h ago");
    expect(idleCaption({ kind: "provider", last_end: now }, now)).toBe("Paused: provider balance low");
  });

  test("last end over sessions skips live ones", () => {
    expect(lastEndOf([{ state: "live", ended_at: null, last_at: 9 }, { state: "final", ended_at: 5, last_at: 5 }, { state: "ended", ended_at: null, last_at: 7 }])).toBe(7);
    expect(endOf({ ended_at: null, last_at: null, at: 3 })).toBe(3);
    expect(endOf(null)).toBe(null);
  });
});
