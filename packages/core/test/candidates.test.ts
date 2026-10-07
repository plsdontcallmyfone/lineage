import { afterEach, describe, expect, test } from "bun:test";
import { ACC } from "../src/ledger.ts";
import { assignmentSeed, canonicalizeDiff, costClass, effectValue, genId, patchCommitment, patchHash, resultCommitment, sha256Hex, H } from "../src/protocol.ts";
import {
  agent,
  assignmentsFor,
  balance,
  CALIB,
  candidate,
  commitReplay,
  diff,
  expectOk,
  honest,
  makeAuthor,
  makeVerifier,
  reconcileOk,
  result,
  revealReplay,
  runReplays,
  setup,
  submit,
  type Env,
} from "./helpers.ts";

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

describe("happy path", () => {
  test("perf candidate: commit, reveal, two replays, accepted generation with exact units", async () => {
    const e = (env = await setup());
    const author = await makeAuthor(e);
    const patch = diff("a");
    const c = await submit(e, author, patch);
    expect(c.status).toBe("replaying");
    expect(c.patch_hash).toBe(patchHash(patch));
    expect(c.guard.ok).toBe(true);

    // exactly quorum replayers, none of them the author or the reference runner
    const assigned = [];
    for (const v of [...e.verifiers, e.reference!]) assigned.push(...(await assignmentsFor(v, c.candidate_id)).map((a) => ({ v, a })));
    expect(assigned).toHaveLength(e.cfg.quorum);
    for (const { v, a } of assigned) {
      expect(e.reference!.id).not.toBe(v.id);
      expect(a.kind).toBe("replay");
      expect(a.parent_gen_id).toBe(e.gen0);
      expect(a.parent_series).toEqual([]);
      expect(a.candidate.patch).toBe(patch);
      expect(a.recipe_id).toBe(CALIB.recipe_id);
      expect(a.calibration.stable).toEqual(CALIB.stable);
      expect(a.lineage.commit).toBeDefined();
      expect(a.reveal_open).toBe(false);
    }

    // before the candidate is final, the public view hides replayer identities and results
    const mid = await candidate(e, c.candidate_id);
    expect(mid.replays.every((r: any) => r.replayer === undefined && r.result === undefined)).toBe(true);

    await runReplays(e, c.candidate_id, honest(result({}, 900)));
    const v = await candidate(e, c.candidate_id);
    expect(v.status).toBe("accepted");
    expect(v.replays.every((r: any) => r.role === "counted" && r.transcript_digest)).toBe(true);
    const gen = await expectOk(e.anon.get(`/v1/generations/${v.gen_id}`));
    expect(gen.gen_id).toBe(genId(e.gen0, c.patch_hash, gen.verdict_digest));
    expect(gen.height).toBe(1);
    expect(gen.effect.ratio).toBeCloseTo(0.9);
    const l = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`));
    expect(l.tip).toBe(v.gen_id);
    expect(l.height).toBe(1);
    const tree = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}/tree?gen=${v.gen_id}`));
    expect(tree.patches.map((p: any) => p.patch)).toEqual([patch]);

    // one shared replay seed per stage: H(assignmentSeed(beacon, candidate), "replay-seed"), verifiable after close
    await expectOk(e.admin.c.post("/v1/admin/epochs/close"));
    const ep = await expectOk(e.anon.get("/v1/epochs/0"));
    const round = ep.assignment_rounds.find((r: any) => r.subject === c.candidate_id);
    const beacon = H("m1-beacon", ep.secret, c.candidate_id, round.round, round.bucket);
    expect(round.beacon).toBe(beacon);
    for (const { a } of assigned) expect(a.seed).toBe(H(assignmentSeed(beacon, c.candidate_id), "replay-seed"));

    // units: author u_author x cost_class x value; each replayer u_replay x cost_class
    const cls = costClass(CALIB.median_eval_seconds);
    const authorUnits = e.cfg.u_author * cls * effectValue(gen.effect, 0.01, e.cfg.value_cap);
    const units = ep.units as any[];
    expect(units.find((u) => u.agent === author.id && u.kind === "author").units).toBeCloseTo(authorUnits);
    for (const { v: who } of assigned) expect(units.find((u) => u.agent === who.id && u.kind === "replay").units).toBe(e.cfg.u_replay * cls);
    await reconcileOk(e);
  });

  test("fix candidate resolves its known-failure finding", async () => {
    const e = (env = await setup());
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("fix1"), { kind: "fix", target: ["bug1"] });
    await runReplays(e, c.candidate_id, honest(result({ tests: { base_pass: ["t1", "t2", "t3"], cand_pass: ["t1", "t2", "t3", "bug1"], cand_fail: ["bug2"] } })));
    const v = await candidate(e, c.candidate_id);
    expect(v.status).toBe("accepted");
    expect(v.verdict.effect).toEqual({ fixed: ["bug1"] });
    const open = await expectOk<any[]>(e.anon.get(`/v1/findings?lineage=${e.lineage}`));
    expect(open.map((f) => f.target)).not.toContain("bug1");
    const resolved = await expectOk<any[]>(e.anon.get(`/v1/findings?lineage=${e.lineage}&status=resolved`));
    expect(resolved[0].resolved_by).toBe(v.gen_id);
  });

  test("a later candidate builds on the new tip and gets the parent series", async () => {
    const e = (env = await setup());
    const author = await makeAuthor(e);
    const first = await submit(e, author, diff("a"));
    await runReplays(e, first.candidate_id, honest());
    const g1 = (await candidate(e, first.candidate_id)).gen_id;
    const second = await submit(e, author, diff("b", "src/other.rs"));
    let seen = false;
    for (const v of e.verifiers)
      for (const a of await assignmentsFor(v, second.candidate_id)) {
        seen = true;
        expect(a.parent_gen_id).toBe(g1);
        expect(a.parent_series.map((p: any) => p.gen_id)).toEqual([g1]);
      }
    expect(seen).toBe(true);
    await runReplays(e, second.candidate_id, honest());
    expect((await candidate(e, second.candidate_id)).status).toBe("accepted");
    expect((await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`))).height).toBe(2);
  });

  test("candidate waits in the queue until enough verifiers are eligible", async () => {
    const e = (env = await setup({ verifiers: 1 }));
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("q"));
    expect(c.status).toBe("queued");
    await makeVerifier(e).then((v) => e.verifiers.push(v));
    expect((await candidate(e, c.candidate_id)).status).toBe("replaying");
  });
});

describe("rejections from the judge", () => {
  const cases: [string, Parameters<typeof result>[0], { kind?: string; target?: any }, string, number?][] = [
    ["tests_fail", { tests: { base_pass: ["t1", "t2", "t3"], cand_pass: ["t1", "t2"], cand_fail: ["t3"] } }, {}, "tests_fail"],
    ["build_fail", { build: { base: "ok", cand: "fail" } }, {}, "build_fail"],
    ["apply_conflict", { apply: "conflict" }, {}, "apply_conflict"],
    ["guard in sandbox", { guard: "PROTECTED_PATH" }, {}, "guard"],
    ["equivalence", { equivalence: { base_digest: "e1", cand_digest: "e2" } }, {}, "equivalence_changed"],
    ["no improvement", {}, {}, "no_improvement", 995],
    ["metric disabled", {}, { kind: "slim", target: "size" }, "metric_disabled"],
    ["fix not fixed", {}, { kind: "fix", target: ["bug1"] }, "fix_target_not_fixed"],
    ["fix of a non-target", { tests: { base_pass: ["t1", "t2", "t3"], cand_pass: ["t1", "t2", "t3", "t9"], cand_fail: [] } }, { kind: "fix", target: ["t9"] }, "fix_target_not_fixed"],
  ];
  for (const [name, over, opts, reason, ir] of cases) {
    test(name, async () => {
      const e = (env = await setup());
      const author = await makeAuthor(e);
      const c = await submit(e, author, diff(name.replace(/\W/g, "_")), opts);
      await runReplays(e, c.candidate_id, honest(result(over, ir ?? 900)));
      const v = await candidate(e, c.candidate_id);
      expect(v.status).toBe("rejected");
      expect(v.reason).toBe(reason);
      // replayers are paid for the work whatever the verdict
      expect(v.replays.every((r: any) => r.role === "counted")).toBe(true);
      const l = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`));
      expect(l.height).toBe(0);
    });
  }

  test("noisy metric: each replay must pass alone (noisy_split), and both passing accepts", async () => {
    const e = (env = await setup({ over: { bootstrap_resamples: 300 } }));
    const author = await makeAuthor(e);
    // the recipe asks for 15 rounds of ns, and the judge requires that many samples per side
    const fast = { base: [100, 101, 99, 100, 102, 98, 100, 101, 99, 100, 100, 101, 99, 100, 102], cand: [80, 81, 79, 80, 82, 78, 80, 81, 79, 80, 80, 81, 79, 80, 82], deterministic: false };
    const flat = { base: [100, 101, 99, 100, 102, 98, 100, 101, 99, 100, 100, 101, 99, 100, 102], cand: [100, 101, 99, 100, 102, 98, 100, 101, 99, 100, 100, 101, 99, 100, 102], deterministic: false };
    const ok = await submit(e, author, diff("n1"), { target: "ns" });
    await runReplays(e, ok.candidate_id, honest(result({ metrics: { ns: fast } })));
    expect((await candidate(e, ok.candidate_id)).status).toBe("accepted");
    const split = await submit(e, author, diff("n2", "src/n2.rs"), { target: "ns" });
    let n = 0;
    await runReplays(e, split.candidate_id, () => result({ metrics: { ns: n++ === 0 ? fast : flat } }));
    const v = await candidate(e, split.candidate_id);
    expect(v.reason).toBe("noisy_split");
  });

  test("replays whose environment fails are not counted; budget exhaustion rejects insufficient_replays", async () => {
    const e = (env = await setup({ verifiers: 6 }));
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("env"));
    await runReplays(e, c.candidate_id, honest(result({ tests: { base_pass: ["t1"], cand_pass: ["t1", "t2", "t3"], cand_fail: [] } })));
    const v = await candidate(e, c.candidate_id);
    expect(v.status).toBe("rejected");
    expect(v.reason).toBe("insufficient_replays");
    // quorum first, then max_reassign replacements
    expect(v.replays).toHaveLength(e.cfg.quorum + e.cfg.max_reassign);
    expect(v.replays.every((r: any) => r.role === "env_failed")).toBe(true);
    // env failures are not held against anyone
    for (const r of v.replays) expect((await agent(e, r.replayer)).strikes_total).toBe(0);
  });
});

describe("rejections and limits in Core", () => {
  test("guard violation is rejected at reveal with no replays", async () => {
    const e = (env = await setup());
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("g", "tests/x.rs"));
    expect(c.status).toBe("rejected");
    expect(c.reason).toBe("guard");
    expect(c.detail).toContain("PROTECTED_PATH");
    expect(c.replays).toHaveLength(0);
    const out = await submit(e, author, diff("g2", "README.md"));
    expect(out.detail).toContain("OUTSIDE_ALLOWED");
    const big = await submit(e, author, diff("g3", "src/big.rs", 150));
    expect(big.detail).toContain("TOO_MANY_LINES");
  });

  test("malformed patch is rejected(guard) MALFORMED when the commitment matches", async () => {
    const e = (env = await setup());
    const author = await makeAuthor(e);
    const c = await submit(e, author, "this is not a diff\n");
    expect(c.status).toBe("rejected");
    expect(c.reason).toBe("guard");
    expect(c.detail).toContain("MALFORMED");
  });

  test("non-canonical patch text is canonicalised before hashing", async () => {
    const e = (env = await setup());
    const author = await makeAuthor(e);
    const canonical = diff("canon");
    const withIndex = canonical.replace("--- a/", "index 1111111..2222222 100644\n--- a/");
    expect(withIndex).not.toBe(canonical);
    const c = await submit(e, author, withIndex);
    expect(c.patch).toBe(canonical);
    expect(c.patch_hash).toBe(patchHash(canonical));
  });

  test("duplicate of an accepted patch (exact or whitespace-only) is rejected at reveal", async () => {
    const e = (env = await setup());
    const a1 = await makeAuthor(e);
    const a2 = await makeAuthor(e);
    const c = await submit(e, a1, diff("dup"));
    await runReplays(e, c.candidate_id, honest());
    const tip = (await candidate(e, c.candidate_id)).gen_id;
    const again = await submit(e, a2, diff("dup"), { parent: e.gen0 });
    expect(again.reason).toBe("duplicate");
    const reskinned = canonicalizeDiff(diff("dup").replace("+    fast_dup_0();", "+  fast_dup_0( ) ;"));
    const r2 = await submit(e, a2, reskinned, { parent: tip });
    expect(r2.reason).toBe("duplicate");
  });

  test("commitment mismatch is refused without a state change; unrevealed commits expire", async () => {
    const e = (env = await setup());
    const author = await makeAuthor(e);
    const patch = diff("m");
    const c = await expectOk(
      author.c.post("/v1/candidates", { lineage_id: e.lineage, parent_gen_id: e.gen0, kind: "perf", target: "ir", commitment: patchCommitment(patchHash(patch), "salt1") }),
    );
    const bad = await author.c.post(`/v1/candidates/${c.commit_id}/reveal`, { patch, salt: "salt2" });
    expect(bad.body.error).toBe("commitment_mismatch");
    expect((await candidate(e, c.commit_id)).status).toBe("committed");
    const other = await makeAuthor(e);
    expect((await other.c.post(`/v1/candidates/${c.commit_id}/reveal`, { patch, salt: "salt1" })).body.error).toBe("not_author");
    e.clock.advance(e.cfg.reveal_window_s * 1000 + 1);
    e.core.tick();
    const v = await candidate(e, c.commit_id);
    expect(v.status).toBe("expired");
    expect((await author.c.post(`/v1/candidates/${c.commit_id}/reveal`, { patch, salt: "salt1" })).status).toBe(409);
  });

  test("max_open_candidates_per_agent", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    const author = await makeAuthor(e);
    for (let i = 0; i < e.cfg.max_open_candidates_per_agent; i++) await submit(e, author, diff(`o${i}`, `src/o${i}.rs`));
    const r = await author.c.post("/v1/candidates", { lineage_id: e.lineage, parent_gen_id: e.gen0, kind: "perf", target: "ir", commitment: "a".repeat(64) });
    expect(r.status).toBe(429);
  });

  test("only awake, active, launched agents author, and only on their target", async () => {
    const e = (env = await setup({ verifiers: 1 }));
    const body = { lineage_id: e.lineage, parent_gen_id: e.gen0, kind: "perf", target: "ir", commitment: "b".repeat(64) };
    expect((await e.verifiers[0]!.c.post("/v1/candidates", body)).body.error).toBe("not_an_author");
    const sleepy = await makeAuthor(e, { fees: 0n });
    expect((await sleepy.c.post("/v1/candidates", body)).body.error).toBe("asleep");
    const elsewhere = await makeAuthor(e, { repo: "https://github.com/example/other" });
    expect((await elsewhere.c.post("/v1/candidates", body)).body.error).toBe("setting_up");
    const ok = await makeAuthor(e);
    expect((await ok.c.post("/v1/candidates", { ...body, target: ["bug1"] })).body.error).toBe("bad_target");
    expect((await ok.c.post("/v1/candidates", { ...body, parent_gen_id: "c".repeat(64) })).body.error).toBe("bad_parent");
  });

  test("an asleep agent's pending candidates are still judged", async () => {
    const e = (env = await setup());
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("zz"));
    const compute = await balance(e, ACC.compute(author.id));
    await expectOk(e.admin.c.post("/v1/admin/usage", { agent: author.id, amount: compute.toString() }));
    expect((await agent(e, author.id)).awake).toBe(false);
    await runReplays(e, c.candidate_id, honest());
    expect((await candidate(e, c.candidate_id)).status).toBe("accepted");
  });
});

describe("replay commit-reveal", () => {
  test("no reveal before every assigned replayer committed; results stay hidden; mismatch is slashed", async () => {
    const e = (env = await setup());
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("cr"));
    const mine = [];
    for (const v of e.verifiers) for (const a of await assignmentsFor(v, c.candidate_id)) mine.push({ v, a });
    expect(mine).toHaveLength(2);
    const [x, y] = mine as [any, any];
    const cx = await commitReplay(x.v, x.a, result());
    const early = await x.v.c.post(`/v1/replays/${x.a.replay_id}/reveal`, { result: cx.result, salt: cx.salt });
    expect(early.status).toBe(409);
    expect(early.body.error).toBe("reveal_not_open");
    // the other replayer sees no result of the first
    const view = await candidate(e, c.candidate_id);
    expect(JSON.stringify(view)).not.toContain(cx.salt);
    const cy = await commitReplay(y.v, y.a, result());
    expect((await assignmentsFor(x.v, c.candidate_id))[0].reveal_open).toBe(true);
    await revealReplay(cx);
    // y reveals something other than what it committed to
    const bondBefore = BigInt((await agent(e, y.v.id)).bond);
    const r = await expectOk(y.v.c.post(`/v1/replays/${y.a.replay_id}/reveal`, { result: { ...cy.result, apply: "conflict" }, salt: cy.salt }));
    expect(r.status).toBe("invalid");
    const after = await agent(e, y.v.id);
    expect(BigInt(after.bond)).toBe(bondBefore - (bondBefore * BigInt(e.cfg.reveal_slash_bps)) / 10_000n);
    expect(after.strikes_epoch).toBe(1);
    // a replacement replayer is assigned and the candidate still completes
    await runReplays(e, c.candidate_id, honest());
    const v = await candidate(e, c.candidate_id);
    expect(v.status).toBe("accepted");
    expect(v.replays.find((q: any) => q.replayer === y.v.id).status).toBe("invalid");
    await reconcileOk(e);
  });

  test("reveal must reference an uploaded transcript", async () => {
    const e = (env = await setup());
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("tr"));
    const all = [];
    for (const v of e.verifiers) for (const a of await assignmentsFor(v, c.candidate_id)) all.push({ v, a });
    const [x, y] = all as [any, any];
    const missing = result({ transcript_digest: "e".repeat(64) });
    await expectOk(x.v.c.post(`/v1/replays/${x.a.replay_id}/commit`, { commitment: resultCommitment(missing, "s1") }));
    await commitReplay(y.v, y.a, result());
    const r = await x.v.c.post(`/v1/replays/${x.a.replay_id}/reveal`, { result: missing, salt: "s1" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("missing_transcript");
    const bytes = new TextEncoder().encode("late upload");
    const sha = sha256Hex(bytes);
    expect(sha).not.toBe(missing.transcript_digest);
  });
});
