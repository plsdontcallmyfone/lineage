// The agent profile's Vault and Acceptance lines read as facts: no "devnet", no "TEST", no bare "TBA".
import { describe, expect, test } from "bun:test";
import { acceptanceStat, vaultLine } from "../src/pages/profile-lines.ts";

describe("agent profile lines", () => {
  test("Vault: the dollar amount; a rate is named only when it is a live one", () => {
    // the mainnet instance's report: a configured rate
    expect(vaultLine(10, { status: "test", source: "config", why: null })).toBe("$10.00 of model and sandbox time");
    expect(vaultLine(10, { status: "live", source: "jupiter" })).toBe("$10.00 at the live quote price (jupiter)");
    expect(vaultLine(10, { status: "none", why: "stale" })).toBe("$10.00, no quote price right now: stale");
    expect(vaultLine(null, { status: "test" })).toBeNull();
    for (const p of [{ status: "test" }, { status: "live", source: "jupiter" }, { status: "none" }, null]) expect(vaultLine(10, p) ?? "").not.toMatch(/devnet|TEST|TBA/);
  });
  test("Acceptance: a rate with enough final results, else how many of the three exist", () => {
    expect(acceptanceStat({ rate: null, final: 1 })).toEqual({ value: "1 of 3", sub: "final results needed for a rate" });
    expect(acceptanceStat({ rate: null, final: 0 }).value).toBe("0 of 3");
    expect(acceptanceStat({ rate: 0.6667, final: 3 })).toEqual({ value: "67%", sub: null });
    expect(JSON.stringify(acceptanceStat({ rate: null, final: 2 }))).not.toContain("TBA");
  });
});

// Network compute (plan MODELS-AND-SELF-FUNDING section D): an agent whose vault cannot pay reads as
// working, with one plain line that the network covers its compute; the vault figure is untouched.
import { coveredLine, statusLine } from "../src/pages/profile-lines.ts";
import { pauseOf } from "../src/live-panel/live-only.ts";

describe("network compute lines", () => {
  const covered = { vault: "0", vault_usd: 0, waiting: null, covered: { min_interval_s: 900 } };
  test("Compute: covered by the network, with the interval the runtime reports; absent for a vault-paid agent", () => {
    expect(coveredLine(covered)).toBe("Covered by the network. Its vault cannot pay for an attempt, so the network pays for its model and sandbox time: one attempt every 15 minutes. Full pace returns when the vault can pay again.");
    expect(coveredLine({ covered: { min_interval_s: 90 } })).toContain("one attempt every 90 seconds");
    expect(coveredLine({ covered: { min_interval_s: 60 } })).toContain("one attempt every minute");
    expect(coveredLine({})).toBeNull();
    expect(coveredLine({ covered: null })).toBeNull();
    expect(coveredLine({ covered: { min_interval_s: "900" } })).toBeNull();
    for (const banned of ["devnet", "TEST", "test", "may", "might", "currently", "—"]) expect(coveredLine(covered)!).not.toContain(banned);
  });
  test("Status: working on network compute, or the reason it waits; the vault line still shows the true figure", () => {
    expect(statusLine(covered)).toBe("working on network compute");
    expect(statusLine({ ...covered, waiting: "global runtime cap (800 USD per 86400 s window) reached" })).toBe("waiting: global runtime cap (800 USD per 86400 s window) reached");
    expect(statusLine({ waiting: null })).toBe("running when a slot is free");
    expect(vaultLine(covered.vault_usd, { status: "test" })).toBe("$0 of model and sandbox time");
  });
  test("the live panel shows no vault pause for a covered agent (the runtime reports none), and still shows one for an agent that is asleep", () => {
    expect(pauseOf({ spend: covered })).toBeNull();
    expect(pauseOf({ spend: { waiting: "asleep (vault below the wake threshold)" } })).toBe("vault");
    expect(pauseOf({ spend: { waiting: "compute vault exhausted (0 base units unowed)" } })).toBe("vault");
  });
});
