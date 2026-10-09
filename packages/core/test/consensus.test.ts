import { afterEach, describe, expect, test } from "bun:test";
import {
  agent,
  allAgents,
  assignmentsFor,
  CAPS,
  candidate,
  commitReplay,
  diff,
  expectOk,
  honest,
  makeAuthor,
  makeVerifier,
  qualify,
  reconcileOk,
  result,
  revealReplay,
  runReplays,
  setup,
  submit,
  type Agent,
  type Env,
} from "./helpers.ts";

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

const breaks = () => result({ tests: { base_pass: ["t1", "t2", "t3"], cand_pass: ["t1", "t2"], cand_fail: ["t3"] } });

describe("disputes (SPEC 10.2)", () => {
  test("disagreement -> one more random replayer plus the reference runner -> minority slashed", async () => {
    const e = (env = await setup({ verifiers: 4 }));
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("d"));
    let lazy: string | null = null;
    const behave = (a: Agent) => {
      lazy ??= a.id;
      return a.id === lazy ? result() : breaks(); // the lazy one claims everything passes
    };
    await runReplays(e, c.candidate_id, behave, 1);
    const mid = await candidate(e, c.candidate_id);
    expect(mid.status).toBe("disputed");
    // exactly one extra random replayer and one reference replay were assigned
    const refAsg = await assignmentsFor(e.reference!, c.candidate_id);
    expect(refAsg).toHaveLength(1);
    expect(refAsg[0].kind).toBe("reference");
    expect(mid.replays.filter((r: any) => r.status === "assigned")).toHaveLength(2);
    const lazyBond = BigInt((await agent(e, lazy!)).bond);
    await runReplays(e, c.candidate_id, behave);
    const v = await candidate(e, c.candidate_id);
    expect(v.status).toBe("rejected");
    expect(v.reason).toBe("tests_fail");
    expect(v.replays.find((r: any) => r.replayer === lazy).role).toBe("minority");
    expect(v.replays.filter((r: any) => r.role === "counted")).toHaveLength(3);
    const after = await agent(e, lazy!);
    expect(BigInt(after.bond)).toBe(lazyBond - (lazyBond * BigInt(e.cfg.minority_slash_bps)) / 10_000n);
    expect(after.strikes_epoch).toBe(1);
    expect(after.units_epoch).toBe(0);
    // the reference runner is neither paid from the pool nor penalised
    expect((await agent(e, e.reference!.id)).units_epoch).toBe(0);
    await reconcileOk(e);
  });

  test("all replays of a stage share one seed; a liar's deterministic numbers lose to the honest majority", async () => {
    const e = (env = await setup({ verifiers: 5, over: { audit_rate: 1, max_open_replays: 4 } }));
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("seed"));
    let liar: string | null = null;
    const behave = (a: Agent, asg: any) => {
      liar ??= a.id;
      // honest replayers measure the same holdout input, so their instruction counts agree exactly
      return a.id === liar && asg.kind === "replay" ? result({}, 850) : result({}, 900);
    };
    await runReplays(e, c.candidate_id, behave, 1);
    expect((await candidate(e, c.candidate_id)).status).toBe("disputed");
    await runReplays(e, c.candidate_id, behave);
    const v = await candidate(e, c.candidate_id);
    expect(v.status).toBe("accepted");
    // first pair, dispute extra and reference all ran the same seed
    const stage = v.replays.filter((r: any) => !r.audit_id);
    expect(stage).toHaveLength(4);
    expect(new Set(stage.map((r: any) => r.seed)).size).toBe(1);
    expect(stage.find((r: any) => r.replayer === liar).role).toBe("minority");
    expect(v.verdict.effect.ratio).toBeCloseTo(0.9);
    // the audit group gets its own fresh shared seed
    const audit = v.replays.filter((r: any) => r.audit_id);
    expect(audit.length).toBe(3); // audit_replayers random auditors plus the reference runner
    expect(new Set(audit.map((r: any) => r.seed)).size).toBe(1);
    expect(audit[0].seed).not.toBe(stage[0].seed);
  });

  test("a dispute that cannot draw a fresh replayer ends unresolved after twice the replay window, nobody slashed", async () => {
    const e = (env = await setup({ verifiers: 2, reference: false }));
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("starved-dispute"));
    let first: string | null = null;
    await runReplays(e, c.candidate_id, (a: Agent) => ((first ??= a.id) === a.id ? result() : breaks()), 1);
    expect((await candidate(e, c.candidate_id)).status).toBe("disputed");
    const bonds = await Promise.all(e.verifiers.map(async (v) => BigInt((await agent(e, v.id)).bond)));
    e.clock.advance(Math.max(e.cfg.replay_window_min_s, e.cfg.replay_window_factor * 120) * 1000);
    e.core.tick();
    expect((await candidate(e, c.candidate_id)).status).toBe("disputed");
    e.clock.advance(Math.max(e.cfg.replay_window_min_s, e.cfg.replay_window_factor * 120) * 1000 + 1);
    e.core.tick();
    const v = await candidate(e, c.candidate_id);
    expect(v.status).toBe("rejected");
    expect(v.reason).toBe("unresolved_dispute");
    for (const [i, x] of e.verifiers.entries()) expect(BigInt((await agent(e, x.id)).bond)).toBe(bonds[i]!);
  });

  test("without a reference runner a dispute draws two more random replayers; a 2-2 split is unresolved", async () => {
    const e = (env = await setup({ verifiers: 4, reference: false }));
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("u"));
    const seen: string[] = [];
    const behave = (a: Agent) => {
      if (!seen.includes(a.id)) seen.push(a.id);
      return seen.indexOf(a.id) % 2 === 0 ? result() : breaks();
    };
    await runReplays(e, c.candidate_id, behave, 1);
    expect((await candidate(e, c.candidate_id)).status).toBe("disputed");
    await runReplays(e, c.candidate_id, behave);
    const v = await candidate(e, c.candidate_id);
    expect(v.replays).toHaveLength(4);
    expect(v.status).toBe("rejected");
    expect(v.reason).toBe("unresolved_dispute");
    // no majority, so nobody is slashed
    for (const r of v.replays) expect((await agent(e, r.replayer)).slashed_total).toBe("0");
  });
});

describe("timeouts and strikes", () => {
  test("an abandoned assignment gets a strike and is reassigned", async () => {
    const e = (env = await setup({ verifiers: 4 }));
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("ab"));
    let quitter: string | null = null;
    await runReplays(e, c.candidate_id, (a) => {
      quitter ??= a.id;
      return a.id === quitter ? "skip" : result();
    });
    // the other replayer committed; its reveal is not open while the quitter is still assigned
    expect((await candidate(e, c.candidate_id)).status).toBe("replaying");
    e.clock.advance(Math.max(e.cfg.replay_window_min_s, e.cfg.replay_window_factor * 120) * 1000 + 1);
    e.core.tick();
    const q = await agent(e, quitter!);
    expect(q.strikes_epoch).toBe(1);
    expect(q.slashed_total).toBe("0");
    const mid = await candidate(e, c.candidate_id);
    expect(mid.replays.filter((r: any) => r.status === "abandoned")).toHaveLength(1);
    expect(mid.replays.filter((r: any) => r.status === "assigned")).toHaveLength(1);
    await runReplays(e, c.candidate_id, honest());
    expect((await candidate(e, c.candidate_id)).status).toBe("accepted");
  });

  test("a committed replay that never reveals is abandoned after the reveal window", async () => {
    const e = (env = await setup({ verifiers: 4 }));
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("nr"));
    let mute: string | null = null;
    await runReplays(e, c.candidate_id, (a) => {
      mute ??= a.id;
      return a.id === mute ? "commit-only" : result();
    });
    e.clock.advance(e.cfg.reveal_window_s * 1000 + 1);
    e.core.tick();
    expect((await agent(e, mute!)).strikes_epoch).toBe(1);
    await runReplays(e, c.candidate_id, honest());
    expect((await candidate(e, c.candidate_id)).status).toBe("accepted");
  });

  test("abandoners are drawn again for the same candidate after the epoch rolls over, so a small network cannot starve it", async () => {
    const e = (env = await setup({ verifiers: 2 }));
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("starve"));
    await runReplays(e, c.candidate_id, () => "skip", 1);
    e.clock.advance(Math.max(e.cfg.replay_window_min_s, e.cfg.replay_window_factor * 120) * 1000 + 1);
    e.core.tick();
    expect((await candidate(e, c.candidate_id)).status).toBe("replaying");
    for (const v of e.verifiers) expect(await assignmentsFor(v, c.candidate_id)).toHaveLength(0);
    await expectOk(e.admin.c.post("/v1/admin/epochs/close"));
    e.core.tick();
    for (const v of e.verifiers) expect(await assignmentsFor(v, c.candidate_id)).toHaveLength(1);
    await runReplays(e, c.candidate_id, honest());
    expect((await candidate(e, c.candidate_id)).status).toBe("accepted");
  });

  test("strike_limit strikes in an epoch suspend the agent through the next epoch", async () => {
    const e = (env = await setup({ verifiers: 2, over: { max_open_replays: 10 } }));
    const author = await makeAuthor(e);
    const ids = [];
    for (let i = 0; i < e.cfg.strike_limit; i++) ids.push((await submit(e, author, diff(`s${i}`, `src/s${i}.rs`))).candidate_id);
    const [v, w] = e.verifiers as [Agent, Agent];
    for (const id of ids) await runReplays(e, id, (a) => (a.id === v.id ? "skip" : result()), 1);
    // work a replayer already holds pushes a new assignment's window back (queuedDeadline), so the
    // skipped replays expire one window apart
    const window = Math.max(e.cfg.replay_window_min_s, e.cfg.replay_window_factor * 120) * 1000;
    for (let i = 0; i < e.cfg.strike_limit; i++) {
      e.clock.advance(window + 1);
      e.core.tick();
    }
    const s = await agent(e, v.id);
    expect(s.strikes_epoch).toBe(e.cfg.strike_limit);
    expect(s.suspended).toBe(true);
    expect(s.suspended_through_epoch).toBe(1);
    expect(s.eligible).toBe(false);
    expect((await agent(e, w.id)).suspended).toBe(false);
    await expectOk(e.admin.c.post("/v1/admin/epochs/close"));
    expect((await agent(e, v.id)).suspended).toBe(true);
    await expectOk(e.admin.c.post("/v1/admin/epochs/close"));
    const back = await agent(e, v.id);
    expect(back.suspended).toBe(false);
    expect(back.eligible).toBe(true);
  });

  test("cooling agents keep their assignments and stay slashable; the cooldown counts from their last involvement", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("cool"));
    const assigned: Agent[] = [];
    for (const x of e.verifiers) if ((await assignmentsFor(x, c.candidate_id)).length) assigned.push(x);
    const [v, w] = assigned as [Agent, Agent];
    await expectOk(v.c.post(`/v1/agents/${v.id}/unbond`, { amount: e.cfg.min_bond.toString() }));
    const av = (await assignmentsFor(v, c.candidate_id))[0];
    const aw = (await assignmentsFor(w, c.candidate_id))[0];
    const cv = await commitReplay(v, av, result());
    const cw = await commitReplay(w, aw, result());
    const r = await expectOk(v.c.post(`/v1/replays/${av.replay_id}/reveal`, { result: { ...cv.result, apply: "conflict" }, salt: cv.salt }));
    expect(r.status).toBe("invalid");
    const after = await agent(e, v.id);
    expect(BigInt(after.bond)).toBe(e.cfg.min_bond - (e.cfg.min_bond * BigInt(e.cfg.reveal_slash_bps)) / 10_000n);
    await revealReplay(cw);
    await runReplays(e, c.candidate_id, honest());
    expect((await candidate(e, c.candidate_id)).status).toBe("accepted");
    // a plain cooldown is not enough: the invalid reveal is still inside its replay window (SPEC 13.6)
    e.clock.advance(e.cfg.unbond_cooldown_s * 1000 + 1);
    e.core.tick();
    expect((await agent(e, v.id)).bond).toBe(after.bond);
    const self = await expectOk(v.c.get(`/v1/agents/${v.id}/self`, true));
    expect(self.unbond.ready_at).toBeNull();
    expect(self.unbond.waiting_on.join(" ")).toContain("replay window");
    // the public view shows the pending amount, never a ready time
    expect((await agent(e, v.id)).unbond.ready_at).toBeNull();
    // once the window has passed, the cooldown starts from its end
    e.clock.advance(200_000); // past the 720 s replay window (6 x 120 s median eval), inside the next cooldown
    e.core.tick();
    const later = await expectOk(v.c.get(`/v1/agents/${v.id}/self`, true));
    expect(later.unbond.ready_at).toBeGreaterThan(e.clock.now());
    expect((await agent(e, v.id)).bond).toBe(after.bond);
    // then it releases only what is left
    e.clock.advance(later.unbond.ready_at - e.clock.now() + 1);
    e.core.tick();
    expect((await agent(e, v.id)).wallet).toBe(after.bond);
    await reconcileOk(e);
  });
});

describe("assignment exclusions", () => {
  test("never the author's operator, and two replays of one candidate never share an operator", async () => {
    const e = (env = await setup({ verifiers: 0, over: { max_open_replays: 10 } }));
    for (const op of ["op-author", "op-author", "op-y", "op-y", "op-z", "op-z"]) e.verifiers.push(await makeVerifier(e, { operator: op }));
    const opOf = new Map<string, string>();
    for (const v of e.verifiers) opOf.set(v.id, (await agent(e, v.id)).operator);
    const author = await makeAuthor(e, { operator: "op-author" });
    for (let i = 0; i < 3; i++) {
      const c = await submit(e, author, diff(`op${i}`, `src/op${i}.rs`));
      const ops: string[] = [];
      for (const v of e.verifiers) for (const _ of await assignmentsFor(v, c.candidate_id)) ops.push(opOf.get(v.id)!);
      expect(ops).toHaveLength(2);
      expect(ops).not.toContain("op-author");
      expect(new Set(ops).size).toBe(2);
    }
  });

  test("hosted agents are never assigned even with funds; a self-hosted bonded agent is", async () => {
    const e = (env = await setup({ verifiers: 1 }));
    const selfHosted = await makeAuthor(e, { hosted: false });
    await expectOk(e.admin.c.post("/v1/admin/faucet", { agent: selfHosted.id, amount: e.cfg.min_bond.toString() }));
    await expectOk(selfHosted.c.post(`/v1/agents/${selfHosted.id}/bond`, { amount: e.cfg.min_bond.toString() }));
    await expectOk(selfHosted.c.put(`/v1/agents/${selfHosted.id}/capabilities`, { capabilities: CAPS }));
    await qualify(selfHosted);
    const hosted = await makeAuthor(e, { hosted: true });
    await expectOk(hosted.c.put(`/v1/agents/${hosted.id}/capabilities`, { capabilities: CAPS }));
    expect(await assignmentsFor(hosted).catch(() => [])).toHaveLength(0);
    expect((await expectOk<any[]>(hosted.c.get("/v1/assignments", true))).filter((x) => x.kind === "qualify")).toHaveLength(0);
    const author = await makeAuthor(e, { hosted: true });
    const c = await submit(e, author, diff("h"));
    expect(await assignmentsFor(hosted, c.candidate_id).catch(() => [])).toHaveLength(0);
    expect(await assignmentsFor(selfHosted, c.candidate_id)).toHaveLength(1);
    expect(await assignmentsFor(e.verifiers[0]!, c.candidate_id)).toHaveLength(1);
  });

  test("the author never replays its own candidate", async () => {
    const e = (env = await setup({ verifiers: 2 }));
    const author = await makeAuthor(e, { hosted: false });
    await expectOk(e.admin.c.post("/v1/admin/faucet", { agent: author.id, amount: e.cfg.min_bond.toString() }));
    await expectOk(author.c.post(`/v1/agents/${author.id}/bond`, { amount: e.cfg.min_bond.toString() }));
    const c = await submit(e, author, diff("self"));
    expect(await assignmentsFor(author, c.candidate_id)).toHaveLength(0);
  });
});

describe("stale candidates (SPEC 11.2)", () => {
  async function twoOnGen0(e: Env) {
    const a1 = await makeAuthor(e);
    const a2 = await makeAuthor(e);
    const first = await submit(e, a1, diff("first", "src/a.rs"));
    const second = await submit(e, a2, diff("second", "src/b.rs"), { parent: e.gen0 });
    await runReplays(e, first.candidate_id, honest());
    const g1 = (await candidate(e, first.candidate_id)).gen_id;
    return { first, second, g1 };
  }

  test("accepted against an old parent: rebased once onto the tip, replayed again, then accepted", async () => {
    const e = (env = await setup({ verifiers: 4, over: { max_open_replays: 4 } }));
    const { second, g1 } = await twoOnGen0(e);
    const parents: string[] = [];
    await runReplays(e, second.candidate_id, (_a, asg) => {
      parents.push(asg.parent_gen_id);
      if (asg.parent_gen_id === g1) expect(asg.parent_series.map((p: any) => p.gen_id)).toEqual([g1]);
      return result();
    });
    expect(parents.filter((p) => p === e.gen0)).toHaveLength(2);
    expect(parents.filter((p) => p === g1)).toHaveLength(2);
    const v = await candidate(e, second.candidate_id);
    expect(v.status).toBe("accepted");
    expect(v.stage).toBe(1);
    expect(v.committed_at).toBe(second.committed_at);
    const gen = await expectOk(e.anon.get(`/v1/generations/${v.gen_id}`));
    expect(gen.parent_gen_id).toBe(g1);
    expect(gen.height).toBe(2);
  });

  test("rebase replays that cannot apply the patch reject stale_conflict", async () => {
    const e = (env = await setup({ verifiers: 4, over: { max_open_replays: 4 } }));
    const { second, g1 } = await twoOnGen0(e);
    await runReplays(e, second.candidate_id, (_a, asg) => (asg.parent_gen_id === g1 ? result({ apply: "conflict" }) : result()));
    const v = await candidate(e, second.candidate_id);
    expect(v.status).toBe("rejected");
    expect(v.reason).toBe("stale_conflict");
  });

  test("a duplicate fix is rejected by the rebase measurement itself (target no longer a known failure)", async () => {
    const e = (env = await setup({ verifiers: 4, over: { max_open_replays: 4 } }));
    const a1 = await makeAuthor(e);
    const a2 = await makeAuthor(e);
    const fixed = result({ tests: { base_pass: ["t1", "t2", "t3"], cand_pass: ["t1", "t2", "t3", "bug1"], cand_fail: ["bug2"] } });
    // at the new tip bug1 already passes at base, so the honest base run includes it
    const onTip = result({ tests: { base_pass: ["t1", "t2", "t3", "bug1"], cand_pass: ["t1", "t2", "t3", "bug1"], cand_fail: ["bug2"] } });
    const x = await submit(e, a1, diff("fx1", "src/a.rs"), { kind: "fix", target: ["bug1"] });
    const y = await submit(e, a2, diff("fx2", "src/b.rs"), { kind: "fix", target: ["bug1"], parent: e.gen0 });
    await runReplays(e, x.candidate_id, honest(fixed));
    const g1 = (await candidate(e, x.candidate_id)).gen_id;
    await runReplays(e, y.candidate_id, (_a, asg) => {
      if (asg.parent_gen_id === g1) {
        // workers are handed the tip-relative calibration
        expect(asg.calibration.stable).toContain("bug1");
        expect(asg.calibration.known_failures).not.toContain("bug1");
        return onTip;
      }
      return fixed;
    });
    const v = await candidate(e, y.candidate_id);
    expect(v.status).toBe("rejected");
    expect(v.reason).toBe("fix_target_not_fixed");
    // and an ordinary perf candidate on top of the fix is measured against the new stable set
    const z = await submit(e, a1, diff("after", "src/z.rs"));
    await runReplays(e, z.candidate_id, honest(result({ tests: onTip.tests })));
    expect((await candidate(e, z.candidate_id)).status).toBe("accepted");
  });

  test("tip moving again during the rebase replay rejects stale", async () => {
    const e = (env = await setup({ verifiers: 6, over: { max_open_replays: 6 } }));
    const a1 = await makeAuthor(e);
    const a2 = await makeAuthor(e);
    const a3 = await makeAuthor(e);
    const first = await submit(e, a1, diff("p1", "src/a.rs"));
    const second = await submit(e, a2, diff("p2", "src/b.rs"), { parent: e.gen0 });
    const third = await submit(e, a3, diff("p3", "src/c.rs"), { parent: e.gen0 });
    await runReplays(e, first.candidate_id, honest());
    // second: stage 0 completes and is rebased; stop before its stage 1 replays
    await runReplays(e, second.candidate_id, honest(), 1);
    expect((await candidate(e, second.candidate_id)).stage).toBe(1);
    // third: stage 0 then rebase then accepted on top of first
    await runReplays(e, third.candidate_id, honest());
    expect((await candidate(e, third.candidate_id)).status).toBe("accepted");
    await runReplays(e, second.candidate_id, honest());
    const v = await candidate(e, second.candidate_id);
    expect(v.status).toBe("rejected");
    expect(v.reason).toBe("stale");
    await reconcileOk(e);
  });
});

void allAgents;
