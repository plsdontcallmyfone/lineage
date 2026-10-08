import { afterEach, describe, expect, test } from "bun:test";
import { bountiesOf } from "../src/bounties.ts";
import { canonicalJson, hashJson, verifyProof } from "../src/protocol.ts";
import { contributionLeaf } from "../src/records.ts";
import { candidate, diff, expectOk, makeAuthor, result, runReplays, setup, submit, type Env } from "./helpers.ts";

// Bounties (C6): Core mirrors the onchain Bounty accounts (ChainBridge feeds `sync`), keeps the terms
// whose digest the account commits to, and serves release candidates: contribution leaves that meet
// the condition, with proofs against the epoch's record root.

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

const ZERO = "11111111111111111111111111111111";
function account(over: Record<string, unknown>) {
  return {
    address: "Bnty" + "1".repeat(40), payer: ZERO.replace(/^1/, "P"), bountyId: 1n, payee: null, opener: ZERO.replace(/^1/, "O"), amount: 5_000_000n,
    termsDigest: hashJson({ note: "make it faster" }), conditionKind: 1, lineageId: "", conditionValue: null as string | null, minEpoch: 0n,
    epochsPostedAtOpen: 0n, deadline: 4_000_000_000n, createdAt: 1_000n, status: "open" as const, releasedTo: null, releasedEpoch: 0n, leaf: null, closedAt: 0n,
    ...over,
  } as any;
}

describe("bounties mirror (C6)", () => {
  test("release candidates prove against the record root; terms, filters, hints and events", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("fast", "src/a.rs"));
    await runReplays(e, c.candidate_id, () => result());
    const cand = await candidate(e, c.candidate_id);
    expect(cand.status).toBe("accepted");
    const closed = await expectOk(e.admin.c.post("/v1/admin/epochs/close"));
    const b = bountiesOf(e.core);
    const target = cand.target;
    const accounts = [
      account({ address: "Bnty1" + "1".repeat(39), lineageId: e.lineage, conditionValue: hashJson(target) }),
      account({ address: "Bnty2" + "1".repeat(39), lineageId: e.lineage, conditionValue: hashJson("other"), bountyId: 2n }),
      account({ address: "Bnty3" + "1".repeat(39), lineageId: e.lineage, conditionKind: 0, conditionValue: "ab".repeat(32), bountyId: 3n, payee: author.id }),
      account({ address: "Bnty4" + "1".repeat(39), lineageId: e.lineage, minEpoch: BigInt(closed.n + 1), bountyId: 4n }),
    ];
    const events: string[] = [];
    const orig = (e.core as any).emitEvent.bind(e.core);
    (e.core as any).emitEvent = (t: string, d: unknown) => (events.push(t), orig(t, d));
    b.sync(accounts, () => "sig-open");
    expect(events.filter((t) => t === "bounty.opened")).toHaveLength(4);

    const list = await expectOk<any[]>(e.anon.get(`/v1/bounties?lineage=${e.lineage}`));
    expect(list).toHaveLength(4);
    expect(list.every((x) => x.chain_sig === "sig-open" && x.status === "open")).toBe(true);
    // an open bounty (payee null) is listed for any payee
    expect((await expectOk<any[]>(e.anon.get(`/v1/bounties?payee=${author.id}`))).length).toBe(4);
    expect((await expectOk<any[]>(e.anon.get(`/v1/lineages/${e.lineage}/bounties`))).map((x) => x.bounty_id).sort()).toEqual(accounts.map((a) => a.address).sort());

    // Target bounty: the accepted generation releases it to its author, with a proof against record_root.
    const rel = await expectOk(e.anon.get(`/v1/bounties/${accounts[0].address}/release`));
    expect(rel.candidates).toHaveLength(1);
    const x = rel.candidates[0];
    expect([x.epoch, x.gen_id, x.payees, x.record_root]).toEqual([closed.n, cand.gen_id, [author.id], closed.record_root]);
    expect(contributionLeaf(x.contribution)).toBe(x.leaf);
    expect(verifyProof(x.leaf, x.proof, closed.record_root)).toBe(true);
    // Other target, other commitment, and a bounty opened after that epoch: nothing qualifies.
    for (const a of accounts.slice(1)) expect((await expectOk(e.anon.get(`/v1/bounties/${a.address}/release`))).candidates).toEqual([]);

    // Terms are kept only when their digest is the onchain one.
    const bad = await e.anon.put(`/v1/bounties/${accounts[0].address}/terms`, { note: "something else" });
    expect(bad.status).toBe(409);
    const ok = await expectOk(e.anon.put(`/v1/bounties/${accounts[0].address}/terms`, { note: "make it faster" }));
    expect(canonicalJson(ok.terms)).toBe(canonicalJson({ note: "make it faster" }));

    // Status changes from chain: released and refunded, each with its event; released ones offer nothing.
    b.sync([{ ...accounts[0], status: "released", releasedTo: author.id, releasedEpoch: BigInt(closed.n), leaf: x.leaf, closedAt: 2_000n },
      { ...accounts[1], status: "refunded", closedAt: 2_000n }]);
    expect(events.filter((t) => t === "bounty.released")).toHaveLength(1);
    expect(events.filter((t) => t === "bounty.refunded")).toHaveLength(1);
    const one = await expectOk(e.anon.get(`/v1/bounties/${accounts[0].address}`));
    expect([one.status, one.released_to, one.leaf, one.chain_sig]).toEqual(["released", author.id, x.leaf, "sig-open"]);
    expect((await expectOk(e.anon.get(`/v1/bounties/${accounts[0].address}/release`))).candidates).toEqual([]);
    expect((await expectOk<any[]>(e.anon.get(`/v1/bounties?status=all`))).length).toBe(4);
    expect((await expectOk<any[]>(e.anon.get(`/v1/bounties`))).length).toBe(2);
    expect((await e.anon.get(`/v1/bounties/nope`)).status).toBe(404);
  });
});
