import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resultLeaf as chainResultLeaf } from "@units/chain";
import { buildRoutes } from "../src/http.ts";
import { openBountiesOf } from "../src/open-bounties.ts";
import { hashJson, merkleRoot, verifyProof } from "../src/protocol.ts";
import { resultLeaf, verifyCredential } from "../src/records.ts";
import { replicate } from "../src/replica.ts";
import { candidate, diff, expectOk, makeAuthor, result, runReplays, setup, submit, type Agent, type Env } from "./helpers.ts";

// The escrow program's bounties (docs/plans/OPEN-BOUNTIES.md option A): the result leaf Core adds to
// the record root while the feature is on, the mirror beside the launch program's bounties, the
// winner by the program's own rule, the claim proof, and the route order of the bounty board.

let env: Env | null = null;
const saved = { ...process.env };
beforeEach(() => {
  process.env.UNITS_FEATURE_OPEN_BOUNTIES = "1";
});
afterEach(() => {
  env?.close();
  env = null;
  for (const k of ["UNITS_FEATURE_OPEN_BOUNTIES", "UNITS_FEATURE_BOUNTIES", "UNITS_NETWORK"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const addr = (n: number) => `Escr${n}` + "1".repeat(39);
const FUNDER = "F" + "1".repeat(31);
const CONFIG = { program: "Prog" + "1".repeat(28), admin: "A" + "1".repeat(31), pendingAdmin: null, mint: "M" + "1".repeat(31), tokenProgram: "T" + "1".repeat(31),
  launchProgram: "L" + "1".repeat(31), opened: 3n,
  settings: { minAmount: 1_000_000n, minTtlS: 3600, maxTtlS: 2_592_000, refundGraceS: 7200, contestS: 1800, feeBps: 0, paused: false } };
function account(e: Env, over: Record<string, unknown>) {
  return {
    address: addr(1), funder: FUNDER, bountyId: 1n, amount: 5_000_000n, feeBps: 0, termsDigest: "00".repeat(32), lineageId: e.lineage, targetDigest: hashJson("ir"),
    minImprovementBps: 1000, minEpoch: 0n, epochsPostedAtOpen: 0n, deadline: 4_000_000_000n, createdAt: 0n, refundAfter: 4_000_007_200n, contestS: 1800,
    status: "open" as const, winner: null, winHeight: 0n, winEpoch: 0n, winGenId: null, winImprovementBps: 0n, winLeaf: null, claimedAt: 0n, contestUntil: 0n,
    paid: 0n, feePaid: 0n, closedAt: 0n, ...over,
  } as any;
}
async function accept(e: Env, author: Agent, name: string, irCand: number) {
  const c = await submit(e, author, diff(name, `src/${name}.rs`));
  await runReplays(e, c.candidate_id, () => result({}, irCand));
  const cand = await candidate(e, c.candidate_id);
  expect(cand.status).toBe("accepted");
  const closed = await expectOk(e.admin.c.post("/v1/admin/epochs/close"));
  return { gen: cand.gen_id as string, epoch: closed.n as number, root: closed.record_root as string };
}
const count = (e: Env) => e.core.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM bounty_results").get()!.c;

describe("the result leaf", () => {
  test("off: no result is written and the root is the records and contributions alone", async () => {
    process.env.UNITS_FEATURE_OPEN_BOUNTIES = "0";
    const e = (env = await setup({ verifiers: 3 }));
    const a = await makeAuthor(e);
    const g = await accept(e, a, "one", 850);
    expect(count(e)).toBe(0);
    const recs = await expectOk(e.anon.get(`/v1/agents/${a.id}/records`));
    const kinds = recs.epochs.flatMap((x: any) => x.leaves.map((l: any) => l.kind)).sort();
    expect(kinds).toEqual(["contribution", "record"]);
    const db = e.core.db;
    const leaves = [...db.query<{ leaf: string }, [number]>("SELECT leaf FROM records WHERE epoch = ?").all(g.epoch),
      ...db.query<{ leaf: string }, [number]>("SELECT leaf FROM contributions WHERE epoch = ?").all(g.epoch)].map((x) => x.leaf).sort();
    expect(merkleRoot(leaves)).toBe(g.root);
  });

  test("on: one leaf per accepted metric generation, in the root, served with a proof, recomputed by the credential check and the replica", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const a = await makeAuthor(e);
    e.clock.advance(5000);
    const g = await accept(e, a, "one", 850);
    expect(count(e)).toBe(1);
    const recs = await expectOk(e.anon.get(`/v1/agents/${a.id}/records`));
    const leaf = recs.epochs.flatMap((x: any) => x.leaves).find((l: any) => l.kind === "result");
    expect(leaf.result).toMatchObject({ kind: "bounty_result", author: a.id, epoch: g.epoch, gen_id: g.gen, lineage_id: e.lineage, target: "ir", improvement_bps: 1500, height: 1 });
    expect(leaf.result.accepted_at).toBe(Math.floor((await expectOk(e.anon.get(`/v1/generations/${g.gen}`))).accepted_at / 1000));
    expect(resultLeaf(leaf.result)).toBe(leaf.leaf);
    expect(chainResultLeaf(leaf.result)).toBe(leaf.leaf); // the client's leaf, which the program's suite is run on
    expect(verifyProof(leaf.leaf, leaf.proof, g.root)).toBe(true);
    // a changed field has no proof
    expect(verifyProof(resultLeaf({ ...leaf.result, improvement_bps: 9000 }), leaf.proof, g.root)).toBe(false);
    const cred = await expectOk(e.anon.get(`/v1/agents/${a.id}/credential`));
    const v = verifyCredential(cred, new Map([[g.epoch, g.root]]));
    expect(v.errors).toEqual([]);
    const rep = await replicate(e.base);
    expect(rep.divergences).toEqual([]);
  });
});

describe("the escrow program's mirror", () => {
  test("the board offers posting to any wallet where the program is configured, and names the winner by the program's rule", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const a = await makeAuthor(e);
    const b = await makeAuthor(e);
    const O = openBountiesOf(e.core);
    expect((await expectOk(e.anon.get("/v1/bounties/board"))).posting.any_wallet).toBe(false);

    e.clock.advance(60_000);
    const small = await accept(e, a, "small", 950); // 5%, height 1
    const createdAt = BigInt(Math.floor(e.clock.now() / 1000) + 1); // the bounty is created after `small` was accepted
    e.clock.advance(60_000);
    const mid = await accept(e, a, "mid", 880); // height 2
    const big = await accept(e, b, "big", 800); // height 3
    const terms = { v: 1, kind: "improvement", lineage_id: e.lineage, metric: "ir", min_improvement_bps: 500, note: "faster encode" };
    O.sync(CONFIG, [
      account(e, { address: addr(1), minImprovementBps: 500, termsDigest: hashJson(terms), createdAt }), // `small` meets 5% but predates the bounty
      account(e, { address: addr(2), bountyId: 2n, minImprovementBps: 1500 }), // only `big` meets it
      account(e, { address: addr(3), bountyId: 3n, minImprovementBps: 9000 }), // nothing meets it
      account(e, { address: addr(4), bountyId: 4n, lineageId: "ab".repeat(32) }), // a unit Core does not have
      account(e, { address: addr(5), bountyId: 5n, targetDigest: hashJson("no_such_metric") }),
      account(e, { address: addr(6), bountyId: 6n, deadline: 1n, refundAfter: 2n }), // every epoch was posted after its deadline
    ]);
    const board = await expectOk(e.anon.get("/v1/bounties/board"));
    expect(board.posting.any_wallet).toBe(true);
    expect(board.escrow).toMatchObject({ program: CONFIG.program, mint: CONFIG.mint, min_amount: "1000000", contest_s: 1800, refund_grace_s: 7200, fee_bps: 0, paused: false });
    const row = (n: number) => board.bounties.find((x: any) => x.bounty_id === addr(n));
    expect(board.bounties.map((x: any) => x.kind)).toEqual(Array(6).fill("escrow"));
    expect([row(1).funder, row(1).payer, row(1).metric?.name, row(1).required, row(1).note]).toEqual([FUNDER, null, "ir", { bps: 500, source: "chain" }, null]);
    expect(row(1).winner.gen_id).toBe(mid.gen); // not `small`: accepted before the bounty existed
    expect([row(2).winner.gen_id, row(2).winner.author, row(2).state]).toEqual([big.gen, b.id, "decided"]);
    expect([row(3).winner, row(3).state]).toEqual([null, "open"]);
    expect([row(4).repo, row(4).metric, row(4).winner]).toEqual([null, null, null]);
    expect([row(5).metric, row(5).winner]).toEqual([null, null]);
    expect([row(6).winner, row(6).state]).toEqual([null, "expired"]);

    // terms: kept only when they hash to the onchain digest
    expect((await e.anon.put(`/v1/bounties/${addr(1)}/terms`, { ...terms, note: "other" })).status).toBe(409);
    await expectOk(e.anon.put(`/v1/bounties/${addr(1)}/terms`, terms));
    expect((await expectOk(e.anon.get(`/v1/bounties/${addr(1)}`))).terms).toEqual(terms);

    // the view: every result on the metric with what the program says to it
    const v = await expectOk(e.anon.get(`/v1/bounties/${addr(1)}/view`));
    expect(v.bounty.note).toBe("faster encode");
    expect(v.generations.map((g: any) => [g.gen_id, g.after_open, g.meets, g.payable])).toEqual([[small.gen, false, true, true], [mid.gen, true, true, true], [big.gen, true, true, true]]);
    expect(v.next.action).toBe("claim");

    // the claim proof: the winner first by the program's rule, each leaf proven against its epoch's root
    const c = await expectOk(e.anon.get(`/v1/bounties/${addr(1)}/claim`));
    expect(c.candidates.map((x: any) => [x.result.gen_id, x.winner])).toEqual([[mid.gen, true], [big.gen, false]]);
    expect(verifyProof(chainResultLeaf(c.candidates[0].result), c.candidates[0].proof, mid.root)).toBe(true);
    expect(c.candidates[0].record_root).toBe(mid.root);
    expect((await e.anon.get(`/v1/bounties/${"N".repeat(44)}/claim`)).status).toBe(404);

    // hints for agents: the open bounties of the unit, with the metric and the improvement that is paid
    const hints = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}/bounties`));
    expect(hints.filter((h: any) => h.kind === "escrow" && h.metric === "ir").map((h: any) => h.min_improvement_bps).sort((x: number, y: number) => x - y)).toEqual([500, 1500, 9000]);

    // a later claim stands on chain: the page shows it, and an earlier generation may still replace it
    const nowS = Math.floor(e.clock.now() / 1000);
    O.sync(CONFIG, [account(e, { address: addr(1), minImprovementBps: 500, termsDigest: hashJson(terms), createdAt, winner: b.id, winHeight: 3n, winEpoch: BigInt(big.epoch),
      winGenId: big.gen, winImprovementBps: 2000n, claimedAt: BigInt(nowS), contestUntil: BigInt(nowS + 1800) })]);
    let d = await expectOk(e.anon.get(`/v1/bounties/${addr(1)}/view`));
    expect([d.bounty.winner.gen_id, d.bounty.claim.winner, d.next.action]).toEqual([big.gen, b.id, "claim"]);
    e.clock.advance(1_800_000);
    d = await expectOk(e.anon.get(`/v1/bounties/${addr(1)}/view`));
    expect(d.next.action).toBe("pay");
    O.sync(CONFIG, [account(e, { address: addr(1), minImprovementBps: 500, termsDigest: hashJson(terms), createdAt, status: "paid", winner: b.id, winHeight: 3n,
      winEpoch: BigInt(big.epoch), winGenId: big.gen, winImprovementBps: 2000n, paid: 5_000_000n, closedAt: BigInt(nowS + 1800) })]);
    d = await expectOk(e.anon.get(`/v1/bounties/${addr(1)}/view`));
    expect([d.bounty.state, d.bounty.released_to, d.bounty.paid, d.next.action]).toEqual(["paid", b.id, "5000000", "none"]);

    // not configured any more (or never): nobody is offered the form
    O.sync(null, []);
    expect((await expectOk(e.anon.get("/v1/bounties/board"))).posting.any_wallet).toBe(false);
    O.sync({ ...CONFIG, settings: { ...CONFIG.settings, paused: true } }, []);
    expect((await expectOk(e.anon.get("/v1/bounties/board"))).posting.any_wallet).toBe(false);
  });

  test("the mainnet hold stays: the board is closed there until the owner opens it", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    openBountiesOf(e.core).sync(CONFIG, []);
    process.env.UNITS_NETWORK = "mainnet";
    delete process.env.UNITS_FEATURE_BOUNTIES;
    let board = await expectOk(e.anon.get("/v1/bounties/board"));
    expect([board.settings, board.escrow, board.posting]).toEqual([null, null, { agent_owner: false, any_wallet: false }]);
    process.env.UNITS_FEATURE_BOUNTIES = "1";
    board = await expectOk(e.anon.get("/v1/bounties/board"));
    expect(board.posting.any_wallet).toBe(true);
  });
});

describe("route order", () => {
  // The live defect: GET /v1/bounties/board answered "bounty not found" because the route was registered
  // after /v1/bounties/:id, which matched "board" as an id. No fixed path may sit behind a pattern that takes it.
  test("no fixed GET path is taken by a parameter route registered before it", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const routes = buildRoutes(e.core);
    const shadowed: string[] = [];
    for (const r of routes) {
      if (r.keys.length) continue;
      const path = r.pattern.source.replace(/^\^|\$$/g, "").replace(/\\(.)/g, "$1");
      const first = routes.find((x) => x.method === r.method && x.pattern.test(path));
      if (first !== r && first!.keys.length) shadowed.push(`${r.method} ${path} is taken by ${first!.pattern.source}`);
    }
    expect(shadowed).toEqual([]);
    const board = await expectOk(e.anon.get("/v1/bounties/board"));
    expect(Array.isArray(board.bounties)).toBe(true);
  });
});
