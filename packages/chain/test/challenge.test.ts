import { describe, expect, test } from "bun:test";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { base58Encode } from "@lineage/protocol";
import {
  ata,
  challenge,
  CHALLENGE_KIND,
  CHALLENGE_OUTCOME,
  decodeChallenge,
  decodeChallengeConfig,
  decodeChallengeGate,
  epochSubject,
  registryPdas,
  type Ix,
} from "../src/index.ts";

// Bonded challenges (SPEC 10.8): builders and decoders against onchain/tests/fixtures/client-vectors.json,
// which onchain/tests/tests/client_vectors.rs writes from the Anchor program's own types.

const vectors = JSON.parse(readFileSync(new URL("../../../onchain/tests/fixtures/client-vectors.json", import.meta.url), "utf8"));
function k(n: number): string {
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, n)]);
  const spki = createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" });
  return base58Encode(new Uint8Array(spki.subarray(spki.length - 32)));
}
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const asVector = (ix: Ix) => ({ program: ix.programId, accounts: ix.keys.map((m) => [m.pubkey, m.isSigner, m.isWritable]), data: b64(ix.data) });
const vector = (name: string) => {
  const { name: _, ...rest } = vectors.instructions.find((x: { name: string }) => x.name === name);
  return rest;
};
const fill = (b: number) => new Uint8Array(32).fill(b);

describe("challenge instructions match the Anchor encodings", () => {
  const line = k(4);
  const owner = k(5);
  const agent = k(6);
  const ownerToken = ata(owner, line);
  const cases: [string, () => Ix][] = [
    ["registry.set_challenge_config", () => challenge.setConfig({ admin: k(1), mint: line, args: { windowS: 600, bond: 2_000_000n, reward: 1_000_000n,
      resolveTimeoutS: 3_600, paused: false } })],
    ["registry.open_challenge.verdict", () => challenge.open({ challenger: agent, signingKey: k(12), payer: owner, payerToken: ownerToken, mint: line,
      kind: CHALLENGE_KIND.verdict, subject: fill(0x3c), epoch: 9, claim: fill(0x3d) })],
    ["registry.open_challenge.slash", () => challenge.open({ challenger: agent, signingKey: k(12), payer: owner, payerToken: ownerToken, mint: line,
      kind: CHALLENGE_KIND.slash, subject: fill(0x5a), epoch: 42, claim: fill(0x3e) })],
    ["registry.resolve_challenge.epoch", () => challenge.resolve({ coreAuthority: k(2), mint: line, kind: CHALLENGE_KIND.epoch, subject: epochSubject(9), epoch: 9,
      refundToken: ownerToken, outcome: CHALLENGE_OUTCOME.upheld, evidence: fill(0x4e), corrected: { payoutRoot: fill(1), lineageRoot: fill(2), recordRoot: fill(3),
        totalUnitsMicro: 77n } })],
    ["registry.resolve_challenge.slash", () => challenge.resolve({ coreAuthority: k(2), mint: line, kind: CHALLENGE_KIND.slash, subject: fill(0x5a), epoch: 42,
      refundToken: ownerToken, outcome: CHALLENGE_OUTCOME.upheld, evidence: fill(0x4f), slashedAgent: agent })],
    ["registry.resolve_challenge.failed", () => challenge.resolve({ coreAuthority: k(2), mint: line, kind: CHALLENGE_KIND.verdict, subject: fill(0x3c), epoch: 9,
      refundToken: ownerToken, outcome: CHALLENGE_OUTCOME.failed, evidence: fill(0x50) })],
    ["registry.expire_challenge", () => challenge.expire({ kind: CHALLENGE_KIND.verdict, subject: fill(0x3c), epoch: 9, refundToken: ownerToken, mint: line })],
  ];
  for (const [name, build] of cases) test(name, () => expect(asVector(build())).toEqual(vector(name)));
  test("the epoch subject is the epoch number, little-endian", () => {
    expect(Buffer.from(epochSubject(258)).toString("hex")).toBe("0201" + "00".repeat(30));
  });
});

describe("challenge accounts decode live LiteSVM bytes", () => {
  const acct = (t: string) => vectors.accounts.find((a: { type: string }) => a.type === t);
  const raw = (t: string) => new Uint8Array(Buffer.from(acct(t).data, "base64"));
  test("ChallengeConfig", () => {
    const c = decodeChallengeConfig(raw("ChallengeConfig"));
    const f = acct("ChallengeConfig").fields;
    expect([String(c.windowS), String(c.bond), String(c.reward), String(c.resolveTimeoutS), c.paused, c.open]).toEqual([f.windowS, f.bond, f.reward,
      f.resolveTimeoutS, f.paused, f.open]);
    expect(acct("ChallengeConfig").address).toBe(registryPdas.challengeConfig());
  });
  test("Challenge (an upheld slash challenge)", () => {
    const c = decodeChallenge(raw("Challenge"));
    const f = acct("Challenge").fields;
    expect(c.kind).toBe(["verdict", "slash", "epoch"][f.kind] as typeof c.kind);
    expect(c.status).toBe(["open", "upheld", "failed", "void", "expired"][f.status] as typeof c.status);
    expect([c.subject, String(c.epoch), c.challenger, c.payer, c.refundToken, String(c.bond), c.claim, String(c.openedAt), String(c.resolvedAt), c.evidence,
      String(c.reward), String(c.reversed), c.corrected]).toEqual([f.subject, f.epoch, f.challenger, f.payer, f.refundToken, f.bond, f.claim, f.openedAt,
      f.resolvedAt, f.evidence, f.reward, f.reversed, f.corrected]);
    expect(acct("Challenge").address).toBe(registryPdas.challenge(1, c.subject));
    expect(c.status).toBe("upheld");
    expect(c.reversed > 0n).toBe(true);
  });
  test("ChallengeGate", () => {
    const g = decodeChallengeGate(raw("ChallengeGate"));
    const f = acct("ChallengeGate").fields;
    expect([String(g.epoch), g.open, g.opened, g.upheld, g.corrected]).toEqual([f.epoch, f.open, f.opened, f.upheld, f.corrected]);
    expect(acct("ChallengeGate").address).toBe(registryPdas.challengeGate(4));
    expect(g.open).toBe(1);
  });
});
