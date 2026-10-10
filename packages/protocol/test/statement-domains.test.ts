import { describe, expect, test } from "bun:test";
import { H, canonicalJson, generateAgentKey, signMessage, signStatement, statementDigest, statementDomainOf, verifyStatement } from "../src/index.ts";

// Rebrand dual acceptance (docs/plans/REBRAND-UNITS.md 3.6).
describe("statement domains", () => {
  const k = generateAgentKey();
  test("the lineage digest is unchanged, so every signature made before the rebrand still verifies", () => {
    const st = { v: 1, kind: "lineage-follow", wallet: "w", agent: "a", follow: true, created_at: 1, nonce: "n" };
    expect(statementDigest("follow", st, "lineage")).toBe(H("lineage-follow-v1", canonicalJson(st)));
    const old = signMessage(k, H("lineage-follow-v1", canonicalJson(st)));
    expect(verifyStatement(k.id, old, "follow", st)).toBe(true);
    expect(statementDomainOf(k.id, old, "follow", st)).toBe("lineage");
  });
  test("a units signature verifies; a statement without a kind verifies under either domain", () => {
    const st = { agent: "a", new_key: "b", seq: 2 };
    expect(verifyStatement(k.id, signStatement(k, "rotate", st, "units"), "rotate", st)).toBe(true);
    expect(verifyStatement(k.id, signStatement(k, "rotate", st, "lineage"), "rotate", st)).toBe(true);
    expect(statementDomainOf(k.id, signStatement(k, "rotate", st, "units"), "rotate", st)).toBe("units");
  });
  test("a branded kind verifies only under its own domain", () => {
    const un = { v: 1, kind: "units-follow", agent: "a" };
    const li = { v: 1, kind: "lineage-follow", agent: "a" };
    expect(verifyStatement(k.id, signStatement(k, "follow", un, "units"), "follow", un)).toBe(true);
    expect(verifyStatement(k.id, signStatement(k, "follow", un, "lineage"), "follow", un)).toBe(false);
    expect(verifyStatement(k.id, signStatement(k, "follow", li, "units"), "follow", li)).toBe(false);
    expect(verifyStatement(k.id, signStatement(k, "follow", li, "lineage"), "follow", li)).toBe(true);
  });
  test("default signing domain is still lineage until the signing switch", () => {
    const st = { a: 1 };
    expect(statementDigest("team", st)).toBe(H("lineage-team-v1", canonicalJson(st)));
  });
});
