import { describe, expect, test } from "bun:test";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { base58Encode, merkleRoot } from "@lineage/protocol";
import {
  bounty,
  bountyPdas,
  contributionLeaf,
  COND,
  decodeBounty,
  decodeBountyConfig,
  decodeBountyLedger,
  decodeBountyReceipt,
  releaseFromContribution,
  targetDigest,
  type Contribution,
  type Ix,
} from "../src/index.ts";
import { contributionLeaf as coreContributionLeaf } from "../../core/src/records.ts";

// Bounties (C6): builders against the Anchor encodings, decoders against live LiteSVM accounts, and
// the contribution leaf against Core's records.ts and the fixtures the Rust suite releases with.

const vectors = JSON.parse(readFileSync(new URL("../../../onchain/tests/fixtures/client-vectors.json", import.meta.url), "utf8"));
const merkle = JSON.parse(readFileSync(new URL("../../../onchain/tests/fixtures/merkle.json", import.meta.url), "utf8"));
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
const fill = (n: number) => new Uint8Array(32).fill(n);
const hexFill = (n: number) => n.toString(16).padStart(2, "0").repeat(32);

describe("bounty instruction builders equal the Anchor encodings", () => {
  const [line, agent, mint] = [k(4), k(6), k(7)];
  test("launch.set_bounty_config", () =>
    expect(asVector(bounty.setConfig({ admin: k(1), args: { maxBountyOutBps: 2_000, selfHostedInCap: 50_000_000n, windowS: 86_400, minTtlS: 3_600,
      maxTtlS: 2_592_000, refundGraceS: 3_600, minAmount: 1_000_000n, paused: false } }))).toEqual(vector("launch.set_bounty_config")));
  test("launch.open_bounty", () =>
    expect(asVector(bounty.open({ opener: k(3), payer: agent, payerMint: mint, lineMint: line, args: { bountyId: 7, payee: k(11), amount: 5_000_000n,
      termsDigest: fill(0xaa), conditionKind: COND.target, lineageId: fill(0xbb), conditionValue: fill(0xcc), deadline: 1_900_100_000 } })))
      .toEqual(vector("launch.open_bounty")));
  test("launch.release_bounty (receipt keyed by the vector's leaf)", () => {
    // The vector carries a placeholder leaf (0xdd...), which the builder would recompute; compare
    // everything but the leaf bytes and the receipt address, then check the receipt derivation.
    const c: Contribution = { epoch: 9, gen_id: hexFill(1), lineage_id: hexFill(0xbb), target: ["t1", "t2"], candidate_commitment: hexFill(2),
      members: [{ agent: k(11), role: "author", share_bps: 6_000 }, { agent: k(12), role: "reviewer", share_bps: 4_000 }], finder: k(13) };
    const ix = asVector(bounty.release({ caller: k(5), payer: agent, bountyId: 7, opener: k(3), payee: k(11), payeeMint: k(14), lineMint: line, contribution: c,
      proof: [fill(5), fill(6)] }));
    const v = vector("launch.release_bounty");
    const data = Buffer.from(ix.data, "base64");
    const vdata = Buffer.from(v.data, "base64");
    expect(data.length).toBe(vdata.length);
    expect(Buffer.compare(data.subarray(0, 8), vdata.subarray(0, 8))).toBe(0);
    expect(Buffer.compare(data.subarray(40), vdata.subarray(40))).toBe(0);
    expect(data.subarray(8, 40).toString("hex")).toBe(contributionLeaf(c));
    expect(ix.accounts.filter((_, i) => i !== 11)).toEqual(v.accounts.filter((_: unknown, i: number) => i !== 11));
    expect(v.accounts[11][0]).toBe(bountyPdas.receipt(agent, fill(0xdd)));
  });
  const ra = { payer: agent, payerMint: mint, bountyId: 7, opener: k(3), lineMint: line };
  test("launch.refund_bounty", () => expect(asVector(bounty.refund(ra))).toEqual(vector("launch.refund_bounty")));
  test("launch.cancel_bounty", () => expect(asVector(bounty.cancel({ ...ra, signer: k(3) }))).toEqual(vector("launch.cancel_bounty")));
});

describe("bounty accounts decode live LiteSVM bytes", () => {
  const acct = (t: string) => vectors.accounts.find((a: { type: string }) => a.type === t);
  const raw = (t: string) => new Uint8Array(Buffer.from(acct(t).data, "base64"));
  test("BountyConfig", () => {
    const c = decodeBountyConfig(raw("BountyConfig"));
    const f = acct("BountyConfig").fields;
    expect([c.maxBountyOutBps, String(c.selfHostedInCap), c.windowS, c.minTtlS, c.maxTtlS, c.refundGraceS, String(c.minAmount), c.paused]).toEqual([
      f.maxBountyOutBps, f.selfHostedInCap, f.windowS, f.minTtlS, f.maxTtlS, f.refundGraceS, f.minAmount, f.paused]);
    expect(acct("BountyConfig").address).toBe(bountyPdas.config());
  });
  test("Bounty (released)", () => {
    const b = decodeBounty(raw("Bounty"));
    const f = acct("Bounty").fields;
    expect([b.payer, String(b.bountyId), b.payee, b.opener, String(b.amount), b.termsDigest, b.conditionKind, b.lineageId, b.conditionValue]).toEqual([
      f.payer, f.bountyId, null, f.opener, f.amount, f.termsDigest, f.conditionKind, f.lineageId, f.conditionValue]);
    expect(f.payee).toBe("11111111111111111111111111111111");
    expect([String(b.minEpoch), String(b.epochsPostedAtOpen), String(b.deadline), String(b.createdAt), b.status, b.releasedTo, String(b.releasedEpoch), b.leaf,
      String(b.closedAt)]).toEqual([f.minEpoch, f.epochsPostedAtOpen, f.deadline, f.createdAt, "released", f.releasedTo, f.releasedEpoch, f.leaf, f.closedAt]);
    expect(bountyPdas.bounty(b.payer, b.bountyId)).toBe(acct("Bounty").address);
  });
  test("BountyLedger and BountyReceipt", () => {
    const l = decodeBountyLedger(raw("BountyLedger"));
    const f = acct("BountyLedger").fields;
    expect([l.agent, ...[l.outWindow, l.outBase, l.outAmount, l.inWindow, l.inAmount, l.openedTotal, l.receivedTotal].map(String)]).toEqual([f.agent,
      f.outWindow, f.outBase, f.outAmount, f.inWindow, f.inAmount, f.openedTotal, f.receivedTotal]);
    const r = decodeBountyReceipt(raw("BountyReceipt"));
    const g = acct("BountyReceipt").fields;
    expect([r.bounty, r.payer, r.leaf, String(r.epoch), r.genId, r.payee, String(r.amount), String(r.releasedAt)]).toEqual([g.bounty, g.payer, g.leaf, g.epoch,
      g.genId, g.payee, g.amount, g.releasedAt]);
    expect(bountyPdas.receipt(r.payer, r.leaf)).toBe(acct("BountyReceipt").address);
    expect(r.bounty).toBe(acct("Bounty").address);
  });
});

describe("contribution leaves", () => {
  test("equal Core's records.ts and the fixtures the Rust suite releases with", () => {
    const fx = merkle.bounty;
    for (const [name, c] of Object.entries<any>(fx.contributions)) {
      const { json: _, leaf, proof, ...contribution } = c;
      expect(contributionLeaf(contribution)).toBe(leaf);
      expect(coreContributionLeaf(contribution)).toBe(leaf);
      expect(releaseFromContribution(contribution, proof, fx.roots[String(c.epoch)]).leaf).toBe(leaf);
      expect(() => releaseFromContribution({ ...contribution, epoch: c.epoch + 1 }, proof, fx.roots[String(c.epoch)])).toThrow();
      void name;
    }
    expect(targetDigest("ir")).toBe(fx.target_ir_digest);
    expect(merkleRoot([])).toMatch(/^[0-9a-f]{64}$/);
  });
});
