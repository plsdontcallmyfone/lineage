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
