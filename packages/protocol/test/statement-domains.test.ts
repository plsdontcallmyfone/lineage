import { describe, expect, test } from "bun:test";
import { H, SIGN_DOMAIN, canonicalJson, generateAgentKey, isKind, signKind, signMessage, signStatement, statementDigest, statementDomainOf, verifyStatement } from "../src/index.ts";

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
  test("signing switch: new signatures use the units domain and units kinds", () => {
    expect(SIGN_DOMAIN).toBe("units");
    expect(signKind("follow")).toBe("units-follow");
    const st = { a: 1 };
    expect(statementDigest("team", st)).toBe(H("units-team-v1", canonicalJson(st)));
    const sig = signStatement(k, "team", st);
    expect(statementDomainOf(k.id, sig, "team", st)).toBe("units");
    const un = { v: 1, kind: signKind("follow"), agent: "a" };
    expect(statementDomainOf(k.id, signStatement(k, "follow", un), "follow", un)).toBe("units");
  });
  test("a statement continuing an older chain is signed under the domain its kind names", () => {
    const li = { v: 1, kind: "lineage-soul", seq: 3 };
    expect(statementDigest("soul", li)).toBe(H("lineage-soul-v1", canonicalJson(li)));
    const sig = signStatement(k, "soul", li);
    expect(verifyStatement(k.id, sig, "soul", li)).toBe(true);
    expect(statementDomainOf(k.id, sig, "soul", li)).toBe("lineage");
  });
  test("old signatures made before the switch still verify (every purpose, with and without a kind)", () => {
    for (const purpose of ["follow", "reaction", "media", "agent-follow", "journal", "link", "identity", "github-genesis", "soul", "credential", "provenance", "rotate", "intent", "team", "msg", "msgkey"]) {
      const st = { v: 1, kind: `lineage-${purpose}`, x: purpose };
      expect(verifyStatement(k.id, signMessage(k, H(`lineage-${purpose}-v1`, canonicalJson(st))), purpose, st)).toBe(true);
      const bare = { x: purpose };
      expect(verifyStatement(k.id, signMessage(k, H(`lineage-${purpose}-v1`, canonicalJson(bare))), purpose, bare)).toBe(true);
    }
  });
  test("isKind accepts a kind under either brand and nothing else", () => {
    expect(isKind("lineage-follow", "follow")).toBe(true);
    expect(isKind("units-follow", "follow")).toBe(true);
    expect(isKind("units-follows", "follow")).toBe(false);
    expect(isKind("other-follow", "follow")).toBe(false);
    expect(isKind(undefined, "follow")).toBe(false);
  });
});
