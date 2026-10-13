import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { verifyProof } from "@units/protocol";
import { ata, bountyTargetDigest, bytesToHex, claimFromResult, decodeOpenBounty, decodeOpenBountyConfig, hexToBytes, OPEN_BOUNTY_ACCOUNT_LEN, openBounty, openBountyPdas,
  resultLeaf, BOUNTY_PROGRAM_ID, BOUNTY_PROGRAM_IDS, launchPdas, registryPdas, type BountyResult, type Ix } from "../src/index.ts";

// units_bounty (docs/plans/OPEN-BOUNTIES.md option A): the builders and decoders against what the
// program's own LiteSVM suite wrote (onchain/tests/fixtures/open-bounty-vectors.json), and the result
// leaf against Core's (onchain/tests/fixtures/merkle.json, built by packages/core records.ts).

const vec = JSON.parse(readFileSync(new URL("../../../onchain/tests/fixtures/open-bounty-vectors.json", import.meta.url), "utf8"));
const fx = JSON.parse(readFileSync(new URL("../../../onchain/tests/fixtures/merkle.json", import.meta.url), "utf8")).open_bounty;
const K = vec.keys as { funder: string; mint: string; token_program: string; author: string; admin: string };
const want = (name: string) => vec.instructions.find((i: { name: string }) => i.name === name) as { data: string; accounts: [string, boolean, boolean][] };
const shape = (ix: Ix) => ({ data: bytesToHex(ix.data), accounts: ix.keys.map((k) => [k.pubkey, k.isSigner, k.isWritable]) });
const same = (name: string, ix: Ix) => {
  expect(ix.programId).toBe(vec.program);
  expect(shape(ix)).toEqual({ data: want(name).data, accounts: want(name).accounts });
};

describe("units_bounty client", () => {
  test("the devnet id is the active one and the program of the vectors", () => {
    expect(BOUNTY_PROGRAM_ID).toBe(BOUNTY_PROGRAM_IDS.devnet);
    expect(vec.program).toBe(BOUNTY_PROGRAM_IDS.devnet);
    // the ids are the ones the program source declares per cargo feature, and Anchor.toml restates
    const src = readFileSync(new URL("../../../onchain/programs/units-bounty/src/lib.rs", import.meta.url), "utf8");
    const toml = readFileSync(new URL("../../../onchain/Anchor.toml", import.meta.url), "utf8");
    expect(src.split('#[cfg(not(feature = "mainnet"))]\ndeclare_id!("')[1]?.split('"')[0]).toBe(BOUNTY_PROGRAM_IDS.devnet);
    expect(src.split('#[cfg(feature = "mainnet")]\ndeclare_id!("')[1]?.split('"')[0]).toBe(BOUNTY_PROGRAM_IDS.mainnet);
    for (const net of ["devnet", "mainnet"] as const)
      expect(toml.match(new RegExp(`\\[programs\\.${net}\\]\\n[^\\[]*units_bounty = "(\\w+)"`))?.[1]).toBe(BOUNTY_PROGRAM_IDS[net]);
    expect(BOUNTY_PROGRAM_IDS.devnet).not.toBe(BOUNTY_PROGRAM_IDS.mainnet);
  });

  test("every instruction is encoded as the program's own types encode it", () => {
    const settings = { minAmount: 1_234_567n, minTtlS: 60, maxTtlS: 86_400, refundGraceS: 7_200, contestS: 1_800, feeBps: 250, paused: true };
    const tp = K.token_program;
    const b = openBountyPdas.bounty(K.funder, 7);
    same("initialize", openBounty.initialize({ upgradeAuthority: K.admin, admin: K.admin, mint: K.mint, settings, tokenProgram: tp }));
    same("set_settings", openBounty.setSettings({ admin: K.admin, settings }));
    same("propose_admin", openBounty.proposeAdmin({ admin: K.admin, newAdmin: K.funder }));
    same("accept_admin", openBounty.acceptAdmin({ newAdmin: K.funder }));
    same("withdraw_fees", openBounty.withdrawFees({ admin: K.admin, to: ata(K.funder, K.mint, tp), mint: K.mint, amount: 99n, tokenProgram: tp }));
    same("open", openBounty.open({ funder: K.funder, mint: K.mint, tokenProgram: tp, args: { bountyId: 7, amount: 5_000_000n, termsDigest: "11".repeat(32),
      lineageId: "22".repeat(32), targetDigest: "33".repeat(32), minImprovementBps: 1_000, deadline: 1_900_086_400 } }));
    const result: BountyResult = { accepted_at: 1_900_000_100, author: K.author, epoch: 9, gen_id: "44".repeat(32), height: 12, improvement_bps: 1_500,
      kind: "bounty_result", lineage_id: "22".repeat(32), target: ["t1", "t2"] };
    same("claim", openBounty.claim({ bounty: b, result, proof: ["55".repeat(32), "66".repeat(32)] }));
    same("pay", openBounty.pay({ bounty: b, funder: K.funder, winner: K.author, mint: K.mint, tokenProgram: tp }));
    same("refund", openBounty.refund({ bounty: b, funder: K.funder, mint: K.mint, tokenProgram: tp }));
    // no cancel: the program has no such instruction and the client builds none
    expect(vec.instructions.map((x: { name: string }) => x.name)).not.toContain("cancel");
    expect("cancel" in openBounty).toBe(false);
    // the claim reads the registry's epoch and the author's compute vault under the launch program
    const keys = openBounty.claim({ bounty: b, result, proof: [] }).keys.map((k) => k.pubkey);
    expect(keys).toContain(registryPdas.epoch(9));
    expect(keys[keys.length - 1]).toBe(launchPdas.computeVault(K.author));
  });

  test("accounts the program wrote decode to the fields the program reads back", () => {
    const c = decodeOpenBountyConfig(hexToBytes(vec.config.bytes));
    expect({ admin: c.admin, mint: c.mint, token_program: c.tokenProgram, launch_program: c.launchProgram, min_amount: c.settings.minAmount.toString(),
      min_ttl_s: c.settings.minTtlS, max_ttl_s: c.settings.maxTtlS, refund_grace_s: c.settings.refundGraceS, contest_s: c.settings.contestS, fee_bps: c.settings.feeBps,
      paused: c.settings.paused, opened: c.opened.toString() }).toEqual((({ bytes: _b, ...rest }) => rest)(vec.config));
    expect(c.pendingAdmin).toBeNull();
    const raw = hexToBytes(vec.bounty.bytes);
    expect(raw.length).toBe(OPEN_BOUNTY_ACCOUNT_LEN);
    const b = decodeOpenBounty(raw);
    expect({ funder: b.funder, bounty_id: b.bountyId.toString(), amount: b.amount.toString(), fee_bps: b.feeBps, terms_digest: b.termsDigest, lineage_id: b.lineageId,
      target_digest: b.targetDigest, min_improvement_bps: b.minImprovementBps, min_epoch: b.minEpoch.toString(), deadline: b.deadline.toString(),
      created_at: b.createdAt.toString(), refund_after: b.refundAfter.toString(), contest_s: b.contestS, status: 0, winner: b.winner,
      win_height: b.winHeight.toString(), win_epoch: b.winEpoch.toString(), win_gen_id: b.winGenId, win_improvement_bps: b.winImprovementBps.toString(),
      win_leaf: b.winLeaf, claimed_at: b.claimedAt.toString(), contest_until: b.contestUntil.toString() }).toEqual((({ bytes: _b, ...rest }) => rest)(vec.bounty));
    expect([b.status, b.paid, b.feePaid, b.closedAt]).toEqual(["open", 0n, 0n, 0n]);
    // the standing claim is fixture result r3
    expect(b.winLeaf).toBe(fx.results.r3.leaf);
  });

  test("the result leaf is Core's, and a changed field has no proof", () => {
    for (const [name, x] of Object.entries(fx.results) as [string, BountyResult & { leaf: string; proof: string[]; json: string }][]) {
      const { leaf, proof, json: _j, ...result } = x;
      expect(resultLeaf(result as BountyResult)).toBe(leaf);
      const root = fx.roots[String(result.epoch)];
      expect(claimFromResult(result as BountyResult, proof, root).leaf).toBe(leaf);
      expect(() => claimFromResult({ ...(result as BountyResult), improvement_bps: result.improvement_bps + 1 }, proof, root)).toThrow();
      expect(verifyProof(leaf, proof, fx.roots[String(result.epoch === 2 ? 3 : 2)])).toBe(false);
      void name;
    }
    expect(bountyTargetDigest("ir")).toBe(fx.target_ir_digest);
  });
});
