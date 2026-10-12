import { afterEach, describe, expect, test } from "bun:test";
import { settlementAllocation } from "@units/chain";
import { intentStatement } from "../src/collab.ts";
import { poolsOf, weightsOf } from "../src/pools.ts";
import { hashJson, repoId, signStatement } from "../src/protocol.ts";
import { diff, expectOk, makeAuthor, RECIPE, result, runReplays, setup, submit, type Agent, type Env } from "./helpers.ts";

// Agent pools, Core side (docs/plans/AGENT-POOLS.md D11 and 6), in the simulated mode: the pool of a
// repository is its launched agents; a member's intent on a target another member holds is refused;
// the settlement record comes from final records only; and with the flag off nothing changes.

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
  delete process.env.UNITS_FEATURE_AGENT_POOLS;
});
const honest = (r = result()) => () => r;
const REPO = repoId(RECIPE.repo);

async function intent(e: Env, a: Agent, target = "ir", kind = "perf") {
  const tip = (await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`))).tip;
  const sig = signStatement(a.key, "intent", intentStatement({ agent: a.id, lineage_id: e.lineage, tip, kind, target, ttl_s: 600, note: null }));
  return a.c.post("/v1/intents", { lineage_id: e.lineage, tip, kind, target, ttl_s: 600, sig });
}

describe("agent pools (Core)", () => {
  test("flag off: intents stay advisory for everyone and no pool route exists", async () => {
    const e = (env = await setup({ verifiers: 4 }));
    const a = await makeAuthor(e), b = await makeAuthor(e);
    expect((await intent(e, a)).status).toBe(200);
    expect((await intent(e, b)).status).toBe(200);
    for (const p of ["/v1/pools", `/v1/pools/${REPO}`, `/v1/pools/${REPO}/context`, `/v1/agents/${a.id}/pool`, "/v1/pools/config"]) {
      const r = await e.anon.get(p);
      expect([p, r.status, r.body.error]).toEqual([p, 404, "feature_off"]);
    }
    expect((await e.admin.c.post("/v1/admin/pools/run", {})).status).toBe(404);
  });

  test("flag on: a member's intent on a target another member holds is refused; outsiders and other targets are not", async () => {
    process.env.UNITS_FEATURE_AGENT_POOLS = "1";
    const e = (env = await setup({ verifiers: 4 }));
    const a = await makeAuthor(e);
    // one agent on the repository is no pool
    expect(poolsOf(e.core).poolOf(a.id)).toBeNull();
    const b = await makeAuthor(e);
    const outsider = await makeAuthor(e, { repo: "https://github.com/example/elsewhere" });
    expect(poolsOf(e.core).members(REPO).map((m) => m.agent)).toEqual([a.id, b.id]);
    expect([poolsOf(e.core).poolOf(a.id), poolsOf(e.core).poolOf(outsider.id)]).toEqual([REPO, null]);
    const first = await expectOk(intent(e, a));
    const refused = await intent(e, b);
    expect([refused.status, refused.body.error]).toEqual([409, "pool_target_claimed"]);
    // the holder itself is answered by the ordinary intent rules, not by the pool rule; another metric is free; an agent of another repository is not bound
    expect((await intent(e, a)).body.error).not.toBe("pool_target_claimed");
    expect((await intent(e, b, "ns")).status).toBe(200);
    expect((await intent(e, outsider)).status).toBe(200);
    const ctx = await expectOk(e.anon.get(`/v1/pools/${REPO}/context`));
    expect(ctx.members).toEqual([a.id, b.id]);
    expect(ctx.claimed_targets.map((c: any) => [c.by, c.target]).sort()).toEqual([[a.id, "ir"], [b.id, "ns"]].sort());
    // the claim ends with the intent
    await expectOk(a.c.request("DELETE", `/v1/intents/${first.intent_id}`));
    expect((await intent(e, b)).status).toBe(200);
    // and the rule never touches a commit: both members can still commit on the same target
    const ca = await submit(e, a, diff("pa"));
    const cb = await submit(e, b, diff("pb"));
    expect([ca.status, cb.status].every((s) => typeof s === "string")).toBe(true);
  });

  test("settlement record: author units of final work, weights by largest remainder, a milestone counted once", async () => {
    process.env.UNITS_FEATURE_AGENT_POOLS = "1";
    const e = (env = await setup({ verifiers: 4 }));
    const a = await makeAuthor(e), b = await makeAuthor(e);
    const pools = poolsOf(e.core);
    const epoch = e.core.currentEpoch().n;
    // nothing final yet: no weights, no generations
    expect(pools.settlement(REPO, [a.id, b.id], epoch, -1)).toMatchObject({ gens: 0, generations: [], milestones: [], members: [{ weight_bps: 0 }, { weight_bps: 0 }] });
    const c = await submit(e, a, diff("p1"));
    await runReplays(e, c.candidate_id, honest());
    const got = await expectOk(e.anon.get(`/v1/candidates/${c.candidate_id}`));
    expect(got.status).toBe("accepted");
    const rec = pools.settlement(REPO, [a.id, b.id], epoch, -1);
    expect(rec.gens).toBe(1);
    expect(rec.generations).toHaveLength(1);
    expect(rec.members.map((m) => m.weight_bps)).toEqual([10_000, 0]);
    expect(rec.members[0]!.author_units).toBeGreaterThan(0);
    // ir 1000 -> 900: cumulative improvement 0.1, the first TEST threshold
    expect(rec.milestones).toEqual([{ lineage_id: e.lineage, metric: "ir", threshold: 0.1, cumulative: 0.1 }]);
    // the record is canonical: its evidence is its hash, and members in pool order decide the weights' order
    expect(hashJson(rec)).toMatch(/^[0-9a-f]{64}$/);
    expect(pools.settlement(REPO, [b.id, a.id], epoch, -1).members.map((m) => m.weight_bps)).toEqual([0, 10_000]);
    // covered epochs only: after this epoch there is nothing new
    expect(pools.settlement(REPO, [a.id, b.id], epoch + 5, epoch)).toMatchObject({ gens: 0, generations: [] });
    // thresholds are admin-editable
    const cfg = await expectOk(e.admin.c.post("/v1/admin/pools/config", { milestones: [0.05, 0.08] }));
    expect(cfg.milestones).toEqual([0.05, 0.08]);
    expect(pools.settlement(REPO, [a.id, b.id], epoch, -1).milestones.map((m) => m.threshold)).toEqual([0.05, 0.08]);
    expect((await e.admin.c.post("/v1/admin/pools/config", { milestones: [2] })).status).toBe(400);
  });

  test("weights and the allocation the program makes", () => {
    expect(weightsOf([0, 0])).toEqual([0, 0]);
    expect(weightsOf([1, 1, 1])).toEqual([3334, 3333, 3333]);
    expect(weightsOf([4, 0])).toEqual([10_000, 0]);
    expect(weightsOf([1, 2]).reduce((x, y) => x + y, 0)).toBe(10_000);
    // pool.rs pool_settle with the TEST config: one generation, all the author's; one milestone
    const cfg = { authorBuybackBps: 2000, buybackPerGenBps: 2500, burnPerMilestoneBps: 5000 };
    const m = settlementAllocation(cfg, { payout: 1_000n, buyback: 1_000n, burn: 501n }, { gens: 1, weights: [10_000, 0], milestones: 1 });
    expect(m).toEqual([{ payout: 1_000n, buyback: 50n, burn: 125n }, { payout: 0n, buyback: 200n, burn: 125n }]);
    // no generations: nothing but a milestone burn moves; generations are capped at the whole bucket
    expect(settlementAllocation(cfg, { payout: 9n, buyback: 9n, burn: 10n }, { gens: 0, weights: [0, 0], milestones: 3 })).toEqual([{ payout: 0n, buyback: 0n, burn: 5n }, { payout: 0n, buyback: 0n, burn: 5n }]);
    const all = settlementAllocation(cfg, { payout: 100n, buyback: 100n, burn: 0n }, { gens: 9, weights: [5000, 5000], milestones: 0 });
    expect(all.reduce((s, x) => s + x.buyback, 0n)).toBe(100n);
  });
});
