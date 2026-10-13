import { afterEach, describe, expect, test } from "bun:test";
import { bountiesOf } from "../src/bounties.ts";
import { intentStatement } from "../src/collab.ts";
import { hiddenOf } from "../src/hidden.ts";
import { hashJson, signStatement, verifyProof } from "../src/protocol.ts";
import { candidate, diff, expectOk, makeAuthor, RECIPE, result, runReplays, setup, submit, type Agent, type Env } from "./helpers.ts";

// Open bounties (docs/plans/OPEN-BOUNTIES.md 4.1): a bounty's terms name a metric and a required
// improvement; Core names the winner from replay verdicts (the accepted generation of lowest height
// whose verdict meets it), and serves the page's board and one bounty's view.

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

const addr = (n: number) => `Bnty${n}` + "1".repeat(39);
function account(over: Record<string, unknown>) {
  return {
    address: addr(1), payer: "P" + "1".repeat(31), bountyId: 1n, payee: null, opener: "O" + "1".repeat(31), amount: 5_000_000n,
    termsDigest: "00".repeat(32), conditionKind: 1, lineageId: "", conditionValue: null as string | null, minEpoch: 0n,
    epochsPostedAtOpen: 0n, deadline: 4_000_000_000n, createdAt: 1_000n, status: "open" as const, releasedTo: null, releasedEpoch: 0n, leaf: null, closedAt: 0n,
    ...over,
  } as any;
}
const terms = (lineage: string, bps: number) => ({ v: 1, kind: "improvement", lineage_id: lineage, metric: "ir", min_improvement_bps: bps, note: null });

async function accept(e: Env, author: Agent, name: string, irCand: number) {
  const c = await submit(e, author, diff(name, `src/${name}.rs`));
  await runReplays(e, c.candidate_id, () => result({}, irCand));
  const cand = await candidate(e, c.candidate_id);
  expect(cand.status).toBe("accepted");
  const closed = await expectOk(e.admin.c.post("/v1/admin/epochs/close"));
  return { gen: cand.gen_id as string, epoch: closed.n as number, root: closed.record_root as string };
}

describe("open bounties: the winner is decided from replay verdicts", () => {
  test("the lowest accepted generation that meets the required improvement wins; the board and the view say so", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const a = await makeAuthor(e);
    const b = await makeAuthor(e);
    const small = await accept(e, a, "small", 950); // 5% lower
    const big = await accept(e, b, "big", 850); // 15% lower
    const B = bountiesOf(e.core);
    const t10 = terms(e.lineage, 1000);
    B.sync([
      account({ address: addr(1), lineageId: e.lineage, conditionValue: hashJson("ir"), termsDigest: hashJson(t10) }),
      account({ address: addr(2), bountyId: 2n, lineageId: e.lineage, conditionValue: hashJson("ir") }), // no terms: the unit's own min_effect
      account({ address: addr(3), bountyId: 3n, lineageId: e.lineage, conditionValue: hashJson("ir"), payer: a.id }), // the payer's own work never wins
      account({ address: addr(4), bountyId: 4n, lineageId: e.lineage, conditionValue: hashJson("ir"), termsDigest: hashJson(terms(e.lineage, 5000)) }),
      account({ address: addr(5), bountyId: 5n, lineageId: e.lineage, conditionValue: hashJson("ir"), deadline: 1n }), // every epoch was posted after its deadline
    ]);
    await expectOk(e.anon.put(`/v1/bounties/${addr(1)}/terms`, t10));
    await expectOk(e.anon.put(`/v1/bounties/${addr(4)}/terms`, terms(e.lineage, 5000)));

    // release: both generations pass the chain's condition; only the 15% one meets the terms and it is the winner
    const rel = await expectOk(e.anon.get(`/v1/bounties/${addr(1)}/release`));
    expect(rel.candidates.map((c: any) => [c.gen_id, c.meets_terms, c.winner])).toEqual([[big.gen, true, true], [small.gen, false, false]]);
    expect(verifyProof(rel.candidates[0].leaf, rel.candidates[0].proof, big.root)).toBe(true);
    expect(rel.candidates[0].payees).toEqual([b.id]);

    const board = await expectOk(e.anon.get("/v1/bounties/board"));
    const row = (n: number) => board.bounties.find((x: any) => x.bounty_id === addr(n));
    expect(board.bounties).toHaveLength(5);
    expect([row(1).repo, row(1).recipe_name, row(1).metric?.name, row(1).metric?.direction]).toEqual([RECIPE.repo, RECIPE.name, "ir", "lower"]);
    expect(row(1).required).toEqual({ bps: 1000, source: "terms" });
    expect([row(1).winner.gen_id, row(1).winner.author, row(1).winner.improvement_bps, row(1).winner.height, row(1).winner.epoch]).toEqual([big.gen, b.id, 1500, 2, big.epoch]);
    expect(row(1).state).toBe("decided");
    // no terms: the requirement is the metric's min_effect, so the first accepted generation wins
    expect(row(2).required).toEqual({ bps: 100, source: "unit" });
    expect([row(2).winner.gen_id, row(2).winner.author, row(2).winner.improvement_bps]).toEqual([small.gen, a.id, 500]);
    // the paying agent's own generation is passed over
    expect(row(3).winner.gen_id).toBe(big.gen);
    // nothing meets 50%: open, no winner
    expect([row(4).required.bps, row(4).winner, row(4).state]).toEqual([5000, null, "open"]);
    // posted after the deadline: no winner, and the bounty has expired
    expect([row(5).winner, row(5).state]).toEqual([null, "expired"]);
    expect(board.settings).toBeNull();
    expect(board.posting).toEqual({ agent_owner: false, any_wallet: false });

    // the form's units: the repository, and the enabled metrics with their own minimum
    const u = board.units.find((x: any) => x.lineage_id === e.lineage);
    expect(u.repo).toBe(RECIPE.repo);
    expect(u.metrics.map((m: any) => [m.name, m.direction, m.min_improvement_bps])).toEqual([["ir", "lower", 100], ["ns", "lower", 300]]);

    // one bounty's view: every accepted generation on the metric since it opened, lowest first
    const v = await expectOk(e.anon.get(`/v1/bounties/${addr(1)}/view`));
    expect(v.generations.map((g: any) => [g.gen_id, g.author, g.improvement_bps, g.meets])).toEqual([[small.gen, a.id, 500, false], [big.gen, b.id, 1500, true]]);
    expect(v.bounty.winner.gen_id).toBe(big.gen);
    expect((await e.anon.get("/v1/bounties/nope/view")).status).toBe(404);

    // released on chain: the result is the generation of the released leaf
    B.sync([account({ address: addr(1), lineageId: e.lineage, conditionValue: hashJson("ir"), termsDigest: hashJson(t10), status: "released", releasedTo: b.id,
      releasedEpoch: BigInt(big.epoch), leaf: rel.candidates[0].leaf, closedAt: 2_000n })]);
    const after = (await expectOk(e.anon.get("/v1/bounties/board"))).bounties.find((x: any) => x.bounty_id === addr(1));
    expect([after.state, after.winner.gen_id, after.winner.author, after.released_to]).toEqual(["paid", big.gen, b.id, b.id]);
  });

  test("agents working on a bounty are the open intents on its unit and metric; hidden launches are left out; settings come from the chain view", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const a = await makeAuthor(e);
    const h = await makeAuthor(e);
    const lv = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`));
    for (const x of [a, h]) {
      const st = { agent: x.id, lineage_id: e.lineage, tip: lv.tip, kind: "perf", target: "ir", ttl_s: 600, note: null };
      await expectOk(x.c.post("/v1/intents", { lineage_id: e.lineage, tip: lv.tip, kind: "perf", target: "ir", ttl_s: 600, sig: signStatement(x.key, "intent", intentStatement(st as never)) }));
    }
    const B = bountiesOf(e.core);
    B.sync([
      account({ address: addr(1), lineageId: e.lineage, conditionValue: hashJson("ir") }),
      account({ address: addr(2), bountyId: 2n, lineageId: e.lineage, conditionValue: hashJson("ns") }),
      account({ address: addr(3), bountyId: 3n, lineageId: e.lineage, conditionValue: hashJson("ir"), payer: h.id }),
    ]);
    const board1 = await expectOk(e.anon.get("/v1/bounties/board"));
    expect(board1.bounties.find((x: any) => x.bounty_id === addr(1)).working.sort()).toEqual([a.id, h.id].sort());
    expect(board1.bounties.find((x: any) => x.bounty_id === addr(2)).working).toEqual([]);

    const mint = e.core.db.query<{ mint: string }, [string]>("SELECT mint FROM agents WHERE agent_id = ?").get(h.id)!.mint;
    hiddenOf(e.core).edit("test", { add: [{ mint, reason: "test launch" }] });
    const board2 = await expectOk(e.anon.get("/v1/bounties/board"));
    // the hidden launch is no longer named as working, and the bounty it pays is not listed
    expect(board2.bounties.map((x: any) => x.bounty_id).sort()).toEqual([addr(1), addr(2)]);
    expect(board2.bounties.find((x: any) => x.bounty_id === addr(1)).working).toEqual([a.id]);
    // a direct link still resolves
    expect((await expectOk(e.anon.get(`/v1/bounties/${addr(3)}/view`))).bounty.bounty_id).toBe(addr(3));

    const cfg = { max_bounty_out_bps: 5000, self_hosted_in_cap: "7", window_s: 86400, min_ttl_s: 60, max_ttl_s: 2592000, refund_grace_s: 60, min_amount: "2000", paused: false };
    (e.core as any).chainMode = true;
    (e.core as any).chainView = () => ({ bounties: { count: 3, config: cfg } });
    const board3 = await expectOk(e.anon.get("/v1/bounties/board"));
    expect(board3.settings).toEqual(cfg);
    expect(board3.posting).toEqual({ agent_owner: true, any_wallet: false });
    (e.core as any).chainView = () => ({ bounties: { count: 3, config: { ...cfg, paused: true } } });
    expect((await expectOk(e.anon.get("/v1/bounties/board"))).posting.agent_owner).toBe(false);
  });
});
