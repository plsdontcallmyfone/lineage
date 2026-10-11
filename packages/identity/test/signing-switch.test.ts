// Signing switch (docs/plans/REBRAND-UNITS.md 3.6, 6.2): new statements carry units-* kinds and are
// signed under the units domain; statements signed before the switch (lineage-* kinds, lineage domain)
// still verify everywhere they are read. Covers the identity service, genesis proofs, souls, Core
// links and credentials, and the browser wallet's digest.
import { describe, expect, test } from "bun:test";
import { canonicalJson, generateAgentKey, H, signMessage, signStatement, statementDomainOf } from "../../protocol/src/index.ts";
import { checkStatement, statementMessage, tokenSha256 } from "../src/statement.ts";
import { GENESIS_KIND, signGenesis, verifyGenesis, type UnsignedGenesis } from "../src/genesis-proof.ts";
import { checkSoul, nextVersion, signSoul, verifySoul } from "../../souls/src/doc.ts";
import { soul } from "../../souls/test/fixtures.ts";
import { linkStatement, signLink } from "../../core/src/links.ts";

const k = generateAgentKey();
const mint = generateAgentKey().id;
const now = 1_760_000_000;

describe("identity service statements", () => {
  const base = { v: 1, agent: k.id, mint, signer: k.id, token_sha256: tokenSha256("t"), created_at: now };
  test("a new units-identity-token signed with the defaults is accepted, under the units domain", () => {
    const st = { ...base, kind: "units-identity-token" };
    const sig = signStatement(k, "identity", st);
    expect(statementDomainOf(k.id, sig, "identity", st)).toBe("units");
    expect(statementMessage(st as never)).toBe(H("units-identity-v1", canonicalJson(st)));
    expect(checkStatement(st, sig, "units-identity-token", now)).toBeNull();
  });
  test("an old lineage-identity-token signed under the lineage domain is still accepted", () => {
    const st = { ...base, kind: "lineage-identity-token" };
    const sig = signMessage(k, H("lineage-identity-v1", canonicalJson(st)));
    expect(checkStatement(st, sig, "units-identity-token", now)).toBeNull();
  });
  test("a kind relabelled to the other brand fails", () => {
    const old = { ...base, kind: "lineage-identity-token" };
    const sig = signMessage(k, H("lineage-identity-v1", canonicalJson(old)));
    expect(checkStatement({ ...old, kind: "units-identity-token" }, sig, "units-identity-token", now)).toContain("signature");
  });
  test("the wallet page's digest (apps/web/wallet/identity.ts) equals the protocol digest", () => {
    const st = { ...base, kind: "units-identity-token" };
    expect(H("units-identity-v1", canonicalJson(st))).toBe(statementMessage(st as never));
  });
});

describe("genesis proofs", () => {
  const unsigned: UnsignedGenesis = {
    v: 1, kind: GENESIS_KIND, agent: k.id, mint, launch_tx: null, soul_digest: null, target_repo: "https://github.com/a/b",
    github_login: "abc", network: "devnet", site: null, issued_at: now,
  };
  test("new proofs carry units-github-genesis and verify", () => {
    expect(GENESIS_KIND).toBe("units-github-genesis");
    const f = signGenesis(k, unsigned);
    const { sig, ...st } = f;
    expect(statementDomainOf(k.id, sig!, "github-genesis", st)).toBe("units");
    expect(verifyGenesis(f).ok).toBe(true);
  });
  test("a proof signed before the switch still verifies", () => {
    const st = { ...unsigned, kind: "lineage-github-genesis" as const, signer: k.id };
    const f = { ...st, sig: signMessage(k, H("lineage-github-genesis-v1", canonicalJson(st))) };
    expect(verifyGenesis(f).ok).toBe(true);
  });
});

describe("souls", () => {
  test("a new soul is a units-soul signed under the units domain", () => {
    const doc = soul(k.id);
    expect(doc.kind).toBe("units-soul");
    expect(checkSoul(doc)).toEqual([]);
    const sig = signSoul(k, doc);
    expect(verifySoul(k.id, sig, doc)).toBe(true);
    expect(statementDomainOf(k.id, sig, "soul", doc)).toBe("units");
  });
  test("a soul begun before the switch keeps its kind; its next version is signed under lineage and verifies", () => {
    const old = { ...soul(k.id), kind: "lineage-soul" as const };
    expect(checkSoul(old)).toEqual([]);
    expect(verifySoul(k.id, signMessage(k, H("lineage-soul-v1", canonicalJson(old))), old)).toBe(true);
    const next = nextVersion(old, {}, now);
    expect(next.kind).toBe("lineage-soul");
    const sig = signSoul(k, next);
    expect(verifySoul(k.id, sig, next)).toBe(true);
    expect(statementDomainOf(k.id, sig, "soul", next)).toBe("lineage");
  });
});

describe("Core link statements", () => {
  test("new link statements are units-link under the units domain", () => {
    const p = signLink(k, linkStatement(k.id, "github", "abc", now));
    expect(p.statement.kind).toBe("units-link");
    expect(statementDomainOf(k.id, p.sig, "link", p.statement)).toBe("units");
  });
});
