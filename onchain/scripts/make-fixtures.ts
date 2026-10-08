// Emits onchain/tests/fixtures/merkle.json: payout and usage leaves, roots and proofs built with the
// TypeScript protocol code Core uses (packages/protocol econ.ts and hash.ts). The Rust LiteSVM suite
// claims and debits with them, so a Core-built root is proven to verify onchain.
//   bun onchain/scripts/make-fixtures.ts           write
//   bun onchain/scripts/make-fixtures.ts --check   fail if the committed file differs
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { base58Encode, canonicalJson, H, hashJson, leafHash, merkleProof, merkleRoot, repoId, verifyProof } from "@lineage/protocol";
import { contributionLeaf, type Contribution } from "../../packages/core/src/records.ts";

const out = new URL("../tests/fixtures/merkle.json", import.meta.url);

/** The ed25519 public key of a 32-byte seed, as solana_keypair::keypair_from_seed derives it. */
function pubkeyOfSeed(byte: number): string {
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, byte)]);
  const spki = createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" });
  return base58Encode(new Uint8Array(spki.subarray(spki.length - 32)));
}

// Seeds shared with onchain/tests (fixture_keys): verifier A, launched agent B, launcher W, plus
// payees that only make the tree deeper.
const A = pubkeyOfSeed(11);
const B = pubkeyOfSeed(12);
const W = pubkeyOfSeed(13);
const extra = [21, 22, 23].map(pubkeyOfSeed);
const EPOCH = 7;

const payouts = [
  { agent: A, dest: `agent:${A}:wallet`, amount: "1234567" },
  { agent: B, dest: `agent:${B}:compute`, amount: "2000000" },
  { agent: B, dest: `agent:${B}:wallet`, amount: "5" },
  { agent: B, dest: `wallet:${W}`, amount: "777" },
  ...extra.map((x, i) => ({ agent: x, dest: `agent:${x}:wallet`, amount: String(1000 + i) })),
].sort((a, b) => (a.agent === b.agent ? (a.dest < b.dest ? -1 : 1) : a.agent < b.agent ? -1 : 1));
const payoutLeaves = payouts.map((p) => leafHash(canonicalJson({ epoch: EPOCH, agent: p.agent, dest: p.dest, amount: p.amount })));
const payoutRoot = merkleRoot(payoutLeaves);

const USAGE_EPOCH = 3;
const usage = [
  { agent: B, amount: "150000", model_tokens: 81234, sandbox_s: 412 },
  { agent: A, amount: "1", model_tokens: 0, sandbox_s: 0 },
  { agent: extra[0]!, amount: "99", model_tokens: 7, sandbox_s: 3 },
];
const usageLeaves = usage.map((u) => leafHash(canonicalJson({ epoch: USAGE_EPOCH, ...u })));
const usageRoot = merkleRoot(usageLeaves);

// Bounties (C6): contribution leaves exactly as Core builds them (records.ts contributionLeaf), in
// record roots with filler record leaves, for epochs 1 to 3 of the bounty suite. Keys: payer P
// (hosted), self-hosted payee S, hosted payee Hd, reviewer R (not launched), finder X.
const [P, S, Hd, R, X] = [31, 32, 33, 34, 35].map(pubkeyOfSeed) as [string, string, string, string, string];
const L = H("lineage", "bounty-fixture");
const L2 = H("lineage", "bounty-fixture-2");
const g = (n: number) => H("gen", "bounty", n);
const k = (n: number) => H("commit-patch", "bounty", n);
const contributions: Record<string, Contribution> = {
  c1: { epoch: 1, gen_id: g(1), lineage_id: L, target: "ir", candidate_commitment: k(1), members: [{ agent: S, role: "author", share_bps: 10_000 }], finder: null },
  c2: { epoch: 2, gen_id: g(2), lineage_id: L, target: "ir", candidate_commitment: k(2),
    members: [{ agent: Hd, role: "author", share_bps: 6_000 }, { agent: R, role: "reviewer", share_bps: 4_000 }], finder: X },
  c3: { epoch: 2, gen_id: g(3), lineage_id: L, target: ["t1", "t2"], candidate_commitment: k(3), members: [{ agent: S, role: "author", share_bps: 10_000 }],
    finder: null },
  c4: { epoch: 2, gen_id: g(4), lineage_id: L2, target: "ir", candidate_commitment: k(4), members: [{ agent: Hd, role: "author", share_bps: 10_000 }],
    finder: null },
  c5: { epoch: 2, gen_id: g(5), lineage_id: L, target: "ir", candidate_commitment: k(5), members: [{ agent: S, role: "author", share_bps: 10_000 }],
    finder: null },
  c6: { epoch: 3, gen_id: g(6), lineage_id: L, target: "ir", candidate_commitment: k(6), members: [{ agent: Hd, role: "author", share_bps: 10_000 }],
    finder: null },
};
const filler = (e: number) => [1, 2, 3].map((i) => leafHash(canonicalJson({ epoch: e, agent: A, role: "verifier", lineage_id: null, record_digest: H("filler", e, i) })));
const bountyEpochs: Record<string, { root: string; leaves: string[] }> = {};
for (const e of [1, 2, 3]) {
  const leaves = [...Object.values(contributions).filter((c) => c.epoch === e).map(contributionLeaf), ...filler(e)].sort();
  bountyEpochs[e] = { root: merkleRoot(leaves), leaves };
}
const bounty = {
  keys: { P, S, H: Hd, R, X },
  seeds: { P: 31, S: 32, H: 33, R: 34, X: 35 },
  lineage: L,
  lineage2: L2,
  target_ir_digest: hashJson("ir"),
  roots: Object.fromEntries(Object.entries(bountyEpochs).map(([e, v]) => [e, v.root])),
  contributions: Object.fromEntries(Object.entries(contributions).map(([name, c]) => {
    const leaf = contributionLeaf(c);
    const ep = bountyEpochs[c.epoch]!;
    const proof = merkleProof(ep.leaves, ep.leaves.indexOf(leaf));
    if (!verifyProof(leaf, proof, ep.root)) throw new Error("bounty proof");
    return [name, { ...c, json: canonicalJson(c), leaf, proof }];
  })),
};

const doc = {
  _note: "Generated by onchain/scripts/make-fixtures.ts from @lineage/protocol; do not edit.",
  seeds: { A: 11, B: 12, W: 13 },
  keys: { A, B, W },
  payout: {
    epoch: EPOCH,
    root: payoutRoot,
    total: payouts.reduce((s, p) => s + BigInt(p.amount), 0n).toString(),
    leaves: payouts.map((p, i) => ({ ...p, leaf: payoutLeaves[i], proof: merkleProof(payoutLeaves, i) })),
  },
  usage: {
    epoch: USAGE_EPOCH,
    root: usageRoot,
    leaves: usage.map((u, i) => ({ ...u, leaf: usageLeaves[i], proof: merkleProof(usageLeaves, i) })),
  },
  repo: { url: "https://github.com/lineage-test/base58", repo_id: repoId("https://github.com/lineage-test/base58") },
  bounty,
};
for (const l of doc.payout.leaves) if (!verifyProof(l.leaf!, l.proof, payoutRoot)) throw new Error("payout proof");
for (const l of doc.usage.leaves) if (!verifyProof(l.leaf!, l.proof, usageRoot)) throw new Error("usage proof");

const text = JSON.stringify(doc, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(out, "utf8") !== text) {
    console.error("merkle.json is stale: run bun onchain/scripts/make-fixtures.ts");
    process.exit(1);
  }
  console.log("merkle.json current");
} else {
  writeFileSync(out, text);
  console.log(`wrote ${out.pathname}: ${payouts.length} payout leaves, ${usage.length} usage leaves`);
}
