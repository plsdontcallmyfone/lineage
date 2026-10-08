import { afterEach, describe, expect, test } from "bun:test";
import { ACC } from "../src/ledger.ts";
import { canonicalJson, commitBeacon, leafHash, merkleRoot, proportionalSplit, verifyProof } from "../src/protocol.ts";
import { agent, balance, candidate, diff, expectOk, honest, makeAuthor, reconcileOk, result, runReplays, setup, submit, type Env } from "./helpers.ts";

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

async function workedEpoch(e: Env, fixToo = true) {
  await expectOk(e.admin.c.post("/v1/admin/creator-rewards", { amount: "1000000000000" }));
  const author = await makeAuthor(e);
  const c = await submit(e, author, diff("ep"));
  await runReplays(e, c.candidate_id, honest());
  if (fixToo) {
    const f = await submit(e, author, diff("epfix", "src/f.rs"), { kind: "fix", target: ["bug2"] });
    await runReplays(e, f.candidate_id, honest(result({ tests: { base_pass: ["t1", "t2", "t3"], cand_pass: ["t1", "t2", "t3", "bug2"], cand_fail: ["bug1"] } })));
  }
  const rejected = await submit(e, author, diff("eprej", "src/r.rs"));
  // after the fix generation bug2 passes at base too (tip-relative stable set)
  const tests = fixToo ? { base_pass: ["t1", "t2", "t3", "bug2"], cand_pass: ["t1", "t2", "t3", "bug2"], cand_fail: ["bug1"] } : undefined;
  await runReplays(e, rejected.candidate_id, honest(result(tests ? { tests } : {}, 999)));
  expect((await candidate(e, rejected.candidate_id)).reason).toBe("no_improvement");
  return { author };
}

describe("epoch close and claims (SPEC 13)", () => {
  test("payouts split the pool by units, rebates come from the reserve, everything reconciles exactly", async () => {
    const e = (env = await setup({ verifiers: 4 }));
    const { author } = await workedEpoch(e);
    const pool = await balance(e, ACC.pool);
    const reserve = await balance(e, ACC.reserve);
    const live = await expectOk(e.anon.get("/v1/epochs/0"));
    expect(live.status).toBe("open");
    expect(live.secret).toBeNull();
    expect(live.canaries).toBeNull();
    const ep = await expectOk(e.admin.c.post("/v1/admin/epochs/close"));
    expect(ep.status).toBe("closed");
    expect(commitBeacon(ep.secret)).toBe(ep.beacon_commit);
    // the whole pool is paid out by units, rebates are rebate_per_class x cost_class per valid replay
    const leaves = ep.payouts as any[];
    const poolOut = BigInt(ep.pool_amount);
    const rebateOut = BigInt(ep.rebate_amount);
    expect(poolOut).toBe(pool);
    const replayCount = (ep.units as any[]).filter((u) => u.kind === "replay").reduce((s, u) => s + u.count, 0);
    expect(replayCount).toBe(6);
    expect(rebateOut).toBe(e.cfg.rebate_per_class * 2n * BigInt(replayCount));
    expect(rebateOut).toBeLessThanOrEqual(reserve);
    expect(leaves.reduce((s, l) => s + BigInt(l.amount), 0n)).toBe(poolOut + rebateOut);
    expect(await balance(e, ACC.payable(0))).toBe(poolOut + rebateOut);
    expect(await balance(e, ACC.pool)).toBe(0n);
    // proportional: each leaf's pool share is exactly proportionalSplit(pool, units), which is
    // pool x units / total up to the split's 1e-9 resolution
    const split = proportionalSplit(pool, new Map(leaves.map((l) => [`${l.agent}|${l.dest}`, l.units])));
    const total = leaves.reduce((s, l) => s + l.units, 0);
    for (const l of leaves) {
      const share = BigInt(l.amount) - BigInt(l.rebate);
      expect(share).toBe(split.get(`${l.agent}|${l.dest}`)!);
      expect(Math.abs(Number(share) - (Number(pool) * l.units) / total)).toBeLessThanOrEqual(Number(pool) / 1e9 + 1);
    }
    // the root is the Merkle root of canonical (epoch, agent, dest, amount) leaves
    expect(ep.root).toBe(merkleRoot(leaves.map((l) => leafHash(canonicalJson({ epoch: 0, agent: l.agent, dest: l.dest, amount: l.amount })))));
    // author rewards go to the compute vault by default
    const authorLeaf = leaves.find((l) => l.agent === author.id);
    expect(authorLeaf.dest).toBe(ACC.compute(author.id));
    expect(authorLeaf.rebate).toBe("0");

    // claims: every leaf claims with its proof, after which the payable account is empty
    const computeBefore = await balance(e, ACC.compute(author.id));
    for (const who of [author, ...e.verifiers]) {
      const proofs = await expectOk<any[]>(e.anon.get(`/v1/epochs/0/proofs/${who.id}`));
      for (const p of proofs) {
        expect(verifyProof(p.leaf, p.proof, ep.root)).toBe(true);
        const wrong = await who.c.post("/v1/epochs/0/claim", { dest: p.dest, amount: (BigInt(p.amount) + 1n).toString(), proof: p.proof });
        expect(wrong.body.error).toBe("bad_proof");
        const ok = await expectOk(who.c.post("/v1/epochs/0/claim", { dest: p.dest, amount: p.amount, proof: p.proof }));
        expect(ok.amount).toBe(p.amount);
        expect((await who.c.post("/v1/epochs/0/claim", { dest: p.dest, amount: p.amount, proof: p.proof })).body.error).toBe("already_claimed");
      }
    }
    expect(await balance(e, ACC.compute(author.id))).toBe(computeBefore + BigInt(authorLeaf.amount));
    expect(await balance(e, ACC.payable(0))).toBe(0n);
    const rec = await reconcileOk(e);
    expect(rec.total).toBe("0");
  });

  test("someone else's leaf cannot be claimed", async () => {
    const e = (env = await setup({ verifiers: 2 }));
    await workedEpoch(e, false);
    await expectOk(e.admin.c.post("/v1/admin/epochs/close"));
    const [v, w] = e.verifiers;
    const p = (await expectOk<any[]>(e.anon.get(`/v1/epochs/0/proofs/${v!.id}`)))[0];
    expect((await w!.c.post("/v1/epochs/0/claim", { dest: p.dest, amount: p.amount, proof: p.proof })).body.error).toBe("bad_proof");
    expect((await v!.c.post("/v1/epochs/1/claim", { dest: p.dest, amount: p.amount, proof: p.proof })).body.error).toBe("epoch_open");
  });

  test("author_reward_to launcher pays the launcher wallet", async () => {
    const e = (env = await setup({ verifiers: 2, over: { author_reward_to: "launcher" } }));
    const { author } = await workedEpoch(e, false);
    const ep = await expectOk(e.admin.c.post("/v1/admin/epochs/close"));
    const launcher = (await agent(e, author.id)).launcher;
    const leaf = (ep.payouts as any[]).find((l) => l.agent === author.id);
    expect(leaf.dest).toBe(ACC.extWallet(launcher));
    const p = (await expectOk<any[]>(e.anon.get(`/v1/epochs/0/proofs/${author.id}`)))[0];
    await expectOk(author.c.post("/v1/epochs/0/claim", { dest: p.dest, amount: p.amount, proof: p.proof }));
    expect(await balance(e, ACC.extWallet(launcher))).toBe(BigInt(leaf.amount));
    await reconcileOk(e);
  });

  test("rebates are capped by the reserve balance", async () => {
    const e = (env = await setup({ verifiers: 2, over: { rebate_per_class: "1000000000000000" } }));
    await workedEpoch(e, false);
    const reserve = await balance(e, ACC.reserve);
    const ep = await expectOk(e.admin.c.post("/v1/admin/epochs/close"));
    expect(BigInt(ep.rebate_amount)).toBe(reserve);
    expect(await balance(e, ACC.reserve)).toBe(0n);
    await reconcileOk(e);
  });

  test("epochs close automatically on tick at epoch_length_s and units land in the next epoch", async () => {
    const e = (env = await setup({ verifiers: 2 }));
    e.clock.advance(e.cfg.epoch_length_s * 1000 - 1);
    e.core.tick();
    expect((await expectOk(e.anon.get("/v1/epochs/current"))).n).toBe(0);
    e.clock.advance(1);
    e.core.tick();
    const cur = await expectOk(e.anon.get("/v1/epochs/current"));
    expect(cur.n).toBe(1);
    expect((await expectOk(e.anon.get("/v1/epochs/0"))).status).toBe("closed");
    // several elapsed epochs close in one tick
    e.clock.advance(e.cfg.epoch_length_s * 1000 * 3);
    e.core.tick();
    expect((await expectOk(e.anon.get("/v1/epochs/current"))).n).toBe(4);
    await reconcileOk(e);
  });

  test("finder share is taken from the author's units", async () => {
    const e = (env = await setup({ verifiers: 2 }));
    const finder = e.verifiers[0]!;
    await expectOk(e.admin.c.post("/v1/admin/findings", { lineage_id: e.lineage, kind: "metric_target", target: "ir", finder: finder.id }));
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("fd"));
    await runReplays(e, c.candidate_id, honest());
    const ep = await expectOk(e.anon.get("/v1/epochs/current"));
    const a = ep.units.find((u: any) => u.agent === author.id && u.kind === "author").units;
    const f = ep.units.find((u: any) => u.agent === finder.id && u.kind === "finder").units;
    expect(f / (a + f)).toBeCloseTo(e.cfg.finder_share);
    const resolved = await expectOk<any[]>(e.anon.get(`/v1/findings?lineage=${e.lineage}&status=resolved`));
    expect(resolved.find((x) => x.finder === finder.id)).toBeDefined();
  });
});

describe("events", () => {
  test("SSE streams the backlog and live state changes", async () => {
    const e = (env = await setup({ verifiers: 2 }));
    const res = await fetch(e.base + "/v1/events?since=0");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("sse"));
    const deadline = Date.now() + 3000;
    while (!buf.includes("candidate.queued") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
    }
    await reader.cancel();
    expect(buf).toContain("event: lineage.created");
    expect(buf).toContain("event: candidate.committed");
    expect(buf).toContain(c.candidate_id);
    // no replayer identity leaks through events while the candidate is open
    for (const v of e.verifiers) {
      const lines = buf.split("\n").filter((l) => l.startsWith("data:") && l.includes("replay."));
      expect(lines.some((l) => l.includes(v.id))).toBe(false);
    }
    const log = await expectOk<any[]>(e.anon.get("/v1/events/log?since=0"));
    expect(log.length).toBeGreaterThan(5);
  });
});

describe("epoch secret disclosure (SPEC 10.3, 10.7)", () => {
  test("a closed epoch withholds its secret while any candidate drawn in it is still open", async () => {
    const e = (env = await setup({ verifiers: 4 }));
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("open-at-close"));
    // assignments exist, nobody has revealed: the candidate is open when the epoch closes
    const closed = await expectOk(e.admin.c.post("/v1/admin/epochs/close"));
    expect(closed.status).toBe("closed");
    const view = await expectOk(e.anon.get(`/v1/epochs/${closed.n}`));
    expect(view.secret).toBeNull();
    // once the candidate is final the secret is published and matches the commitment
    await runReplays(e, c.candidate_id, honest());
    expect((await candidate(e, c.candidate_id)).status).toBe("accepted");
    const after = await expectOk(e.anon.get(`/v1/epochs/${closed.n}`));
    expect(after.secret).not.toBeNull();
    expect(commitBeacon(after.secret)).toBe(after.beacon_commit);
  });
});
