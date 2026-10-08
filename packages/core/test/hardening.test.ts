import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canaryDirIsPublic, loadCanaryDir } from "../src/hardening.ts";
import { candidateId, patchCommitment, patchHash, sha256Hex } from "../src/protocol.ts";
import {
  agent,
  assignmentsFor,
  authorLeaks,
  candidate,
  CANARY_FAST,
  commitReplay,
  diff,
  expectOk,
  honest,
  makeAuthor,
  reconcileOk,
  result,
  revealReplay,
  ROOT,
  runReplays,
  settleCanaries,
  setup,
  submit,
  warmShadows,
  type Agent,
  type Env,
} from "./helpers.ts";

// Regression tests for the 2026-10-07 adversarial review of Core. Each reproduces an attack that
// used to succeed (scratchpad core-attacks.test.ts) and asserts it no longer does.

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

const broken = () => result({ tests: { base_pass: ["t1", "t2", "t3"], cand_pass: ["t1"], cand_fail: ["t2", "t3"] } });

describe("canaries are indistinguishable before the epoch closes (SPEC 10.5)", () => {
  test("none of the four tells hold: shadow age, commit/reveal gap, injection tick, public patch library", async () => {
    const e = (env = await setup({ verifiers: 6, over: { canary_rate: 1, max_open_replays: 4, ...CANARY_FAST } }));
    await expectOk(e.admin.c.post("/v1/admin/canaries", { lineage_id: e.lineage, kind: "perf", target: "ir", expected_reason: "tests_fail", patch: diff("canary1") }));
    await expectOk(e.admin.c.post("/v1/admin/canaries", { lineage_id: e.lineage, kind: "perf", target: "ir", expected_reason: "tests_fail", patch: diff("canary2", "src/two.rs") }));
    const author = await makeAuthor(e);
    warmShadows(e);
    e.clock.advance(5_000);
    const real = await submit(e, author, diff("real"));
    // (c) nothing is injected in the transaction that assigns the real candidate's replays
    expect(await expectOk<any[]>(e.anon.get(`/v1/candidates?lineage=${e.lineage}`))).toHaveLength(1);
    settleCanaries(e);
    const all = await expectOk<any[]>(e.anon.get(`/v1/candidates?lineage=${e.lineage}`));
    const others = all.filter((c) => c.candidate_id !== real.candidate_id);
    expect(others).toHaveLength(1);
    expect((await candidate(e, others[0].candidate_id)).author).toBeNull();
    const canary = await expectOk(e.admin.c.get(`/v1/candidates/${others[0].candidate_id}`, true));
    const rv = await candidate(e, real.candidate_id);
    // (b) commit and reveal are separate requests in time, at least one tick apart
    expect(canary.revealed_at - canary.committed_at).toBeGreaterThanOrEqual(1000);
    // (c) committed on a later tick, at least canary_inject_delay_s[0] after the trigger's assignment
    for (const r of rv.replays) expect(canary.committed_at - r.assigned_at).toBeGreaterThanOrEqual(5_000);
    expect(canary.replays.every((r: any) => r.assigned_at === canary.revealed_at)).toBe(true);
    // (a) the shadow existed well before the canary, from a pool launched at staggered times
    const shadow = await agent(e, canary.author);
    expect(canary.committed_at - shadow.registered_at).toBeGreaterThanOrEqual(30_000);
    const pool = await expectOk<any[]>(e.anon.get("/v1/agents"));
    const shadows = e.core.db.query<{ agent_id: string; launched_at: number | null }, []>("SELECT agent_id, launched_at FROM shadows").all();
    expect(shadows.length).toBe(e.cfg.shadow_pool);
    expect(new Set(shadows.map((s) => s.launched_at)).size).toBeGreaterThan(1);
    // ... with exactly the fields of a real launched agent, a compute balance from the ordinary fee path
    const realView = await agent(e, author.id);
    expect(Object.keys(shadow).sort()).toEqual(Object.keys(realView).sort());
    expect(shadow.kind).toBe("launched");
    expect(BigInt(shadow.compute)).toBeGreaterThan(0n);
    const feeEvents = e.core.events(0, 5000).filter((x) => x.type === "ledger.agent_fees").map((x) => (x.data as any).agent);
    expect(feeEvents).toContain(canary.author);
    expect(pool.filter((a) => shadows.some((s) => s.agent_id === a.agent_id)).every((a) => !("shadow" in a))).toBe(true);
    // the canary was taken from the library once; the second real candidate gets the other one
    const real2 = await submit(e, author, diff("real2", "src/r2.rs"));
    settleCanaries(e);
    const canaries2 = (await expectOk<any[]>(e.anon.get(`/v1/candidates?lineage=${e.lineage}`))).filter((c) => ![real.candidate_id, real2.candidate_id].includes(c.candidate_id));
    expect(canaries2).toHaveLength(2);
    expect(new Set(canaries2.map((c) => c.patch_hash)).size).toBe(2);
    await reconcileOk(e);
  });

  test("(d) canaries load from a private directory; the public repository is not one", async () => {
    const e = (env = await setup({ verifiers: 2 }));
    const dir = mkdtempSync(join(tmpdir(), "lineage-canaries-"));
    try {
      mkdirSync(join(dir, "fx"));
      writeFileSync(join(dir, "fx", "index.json"), JSON.stringify({ hidden: { kind: "perf", target: "ir", expect: "tests_fail" } }));
      writeFileSync(join(dir, "fx", "hidden.diff"), diff("hidden_canary"));
      const r = loadCanaryDir(e.core, dir);
      expect(r).toEqual({ loaded: 1, lineages: 1, errors: [] });
      expect(loadCanaryDir(e.core, dir).loaded).toBe(0); // idempotent
      const list = await expectOk<any[]>(e.admin.c.get(`/v1/admin/canaries?lineage=${e.lineage}`, true));
      expect(list.map((c) => c.patch_hash)).toEqual([patchHash(diff("hidden_canary"))]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(canaryDirIsPublic(join(ROOT, "recipes/base58-py/canaries"), ROOT)).toBe(true);
    expect(canaryDirIsPublic(ROOT, ROOT)).toBe(true);
    expect(canaryDirIsPublic("/home/op/.config/lineage/canaries", ROOT)).toBe(false);
  });
});

describe("replayer identities stay private (SPEC 17.1)", () => {
  test("an author cannot learn its replayers from public agent views", async () => {
    const e = (env = await setup({ verifiers: 6 }));
    const author = await makeAuthor(e);
    const before = new Map<string, any>();
    for (const v of e.verifiers) before.set(v.id, await agent(e, v.id));
    const c = await submit(e, author, diff("leak"));
    const truth: string[] = [];
    for (const v of e.verifiers) if ((await assignmentsFor(v, c.candidate_id)).length) truth.push(v.id);
    expect(truth).toHaveLength(2);
    for (const v of e.verifiers) {
      const now = await agent(e, v.id);
      expect(now.open_replays).toBeNull();
      expect(now).toEqual(before.get(v.id));
    }
    // the agent itself still sees its own load
    expect((await expectOk(e.verifiers.find((v) => v.id === truth[0])!.c.get(`/v1/agents/${truth[0]}/self`, true))).open_replays).toBe(1);
    expect((await candidate(e, c.candidate_id)).status).toBe("replaying");
  });
});

describe("no slash evasion by unbonding (SPEC 13.6)", () => {
  test("a liar that requests unbond right after a lying reveal is still slashed when the dispute resolves", async () => {
    const e = (env = await setup({ verifiers: 4 }));
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("evade"));
    const assigned: { v: Agent; a: any }[] = [];
    for (const v of e.verifiers) for (const a of await assignmentsFor(v, c.candidate_id)) assigned.push({ v, a });
    expect(assigned.length).toBe(2);
    const [liar, honestOne] = assigned as [{ v: Agent; a: any }, { v: Agent; a: any }];
    const xl = await commitReplay(liar.v, liar.a, result()); // liar claims all pass
    const xh = await commitReplay(honestOne.v, honestOne.a, broken());
    await revealReplay(xl);
    await expectOk(liar.v.c.post(`/v1/agents/${liar.v.id}/unbond`, { amount: e.cfg.min_bond.toString() }));
    await revealReplay(xh);
    expect((await candidate(e, c.candidate_id)).status).toBe("disputed");
    // the cooldown passes while the dispute is still open: nothing is released
    e.clock.advance(e.cfg.unbond_cooldown_s * 1000 + 1);
    e.core.tick();
    const mid = await agent(e, liar.v.id);
    expect(mid.bond).toBe(e.cfg.min_bond.toString());
    expect(mid.wallet).toBe("0");
    expect(mid.cooling).toBe(true);
    // dispute replayers report the breakage; the liar is the minority and loses part of its bond
    await runReplays(e, c.candidate_id, () => broken());
    const v = await candidate(e, c.candidate_id);
    expect(v.status).toBe("rejected");
    expect(v.replays.find((r: any) => r.replayer === liar.v.id).role).toBe("minority");
    const slash = (e.cfg.min_bond * BigInt(e.cfg.minority_slash_bps)) / 10_000n;
    const after = await agent(e, liar.v.id);
    expect(after.slashed_total).toBe(slash.toString());
    // the cooldown counts from the last involvement; then only the remainder is released
    for (let i = 0; i < 4; i++) {
      e.clock.advance(e.cfg.unbond_cooldown_s * 1000);
      e.core.tick();
    }
    const done = await agent(e, liar.v.id);
    expect(done.bond).toBe("0");
    expect(done.wallet).toBe((e.cfg.min_bond - slash).toString());
    await reconcileOk(e);
  }, 60_000);
});

describe("patch theft (SPEC 10.4)", () => {
  test("a copied revealed patch with a later commitment is a duplicate at once; the original is accepted", async () => {
    const e = (env = await setup({ verifiers: 6, over: { max_open_replays: 4 } }));
    const victim = await makeAuthor(e);
    const thief = await makeAuthor(e);
    const p = diff("steal");
    const vc = await submit(e, victim, p);
    const pub = await candidate(e, vc.candidate_id);
    expect(pub.status).toBe("replaying");
    e.clock.advance(1000);
    const tc = await submit(e, thief, pub.patch);
    expect(tc.status).toBe("rejected");
    expect(tc.reason).toBe("duplicate");
    expect(tc.detail).toContain(vc.candidate_id);
    expect(tc.replays).toHaveLength(0);
    await runReplays(e, vc.candidate_id, honest(result({}, 900)));
    expect((await candidate(e, vc.candidate_id)).status).toBe("accepted");
  });

  test("a later commitment revealed first is held until the earlier twin is final, then rejected as its duplicate", async () => {
    const e = (env = await setup({ verifiers: 6, over: { max_open_replays: 4 } }));
    const first = await makeAuthor(e);
    const second = await makeAuthor(e);
    const p = diff("twin");
    const tip = (await e.anon.get(`/v1/lineages/${e.lineage}`)).body.tip;
    const commit = async (a: Agent, salt: string) =>
      expectOk(a.c.post("/v1/candidates", { lineage_id: e.lineage, parent_gen_id: tip, kind: "perf", target: "ir", commitment: patchCommitment(patchHash(p), salt) }));
    const s1 = sha256Hex("s1").slice(0, 32);
    const s2 = sha256Hex("s2").slice(0, 32);
    const c1 = await commit(first, s1);
    e.clock.advance(1000);
    const c2 = await commit(second, s2);
    // the later commitment reveals first and its replays finish first
    const r2 = await expectOk(second.c.post(`/v1/candidates/${c2.commit_id}/reveal`, { patch: p, salt: s2 }));
    const r1 = await expectOk(first.c.post(`/v1/candidates/${c1.commit_id}/reveal`, { patch: p, salt: s1 }));
    expect(r1.status).toBe("replaying");
    await runReplays(e, r2.candidate_id, honest(result({}, 900)));
    const held = await candidate(e, r2.candidate_id);
    expect(held.status).toBe("replaying");
    expect(held.detail).toContain("held");
    expect(held.gen_id).toBeNull();
    await runReplays(e, r1.candidate_id, honest(result({}, 900)));
    expect((await candidate(e, r1.candidate_id)).status).toBe("accepted");
    e.core.tick();
    const late = await candidate(e, r2.candidate_id);
    expect(late.status).toBe("rejected");
    expect(late.reason).toBe("duplicate");
    expect((await e.anon.get(`/v1/lineages/${e.lineage}`)).body.height).toBe(1);
  });
});

describe("audits cannot be nullified by one auditor (SPEC 10.6)", () => {
  test("a colluding auditor is outvoted and slashed; the behaviour change on the fresh seed reverts", async () => {
    const e = (env = await setup({ verifiers: 5, over: { audit_rate: 1, max_open_replays: 4 } }));
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("aud"));
    let colluder: string | null = null;
    await runReplays(e, c.candidate_id, (a, asg) => {
      if (asg.kind !== "audit" && asg.kind !== "reference") return result({}, 900);
      // the reference runner and the honest auditor see behaviour change on the fresh seed
      if (asg.kind === "reference") return result({ equivalence: { base_digest: "e1", cand_digest: "e2" } }, 900);
      colluder ??= a.id;
      if (a.id === colluder) return result({}, 901); // reports "same" with a different metric value
      return result({ equivalence: { base_digest: "e1", cand_digest: "e2" } }, 900);
    });
    const v = await candidate(e, c.candidate_id);
    expect(v.status).toBe("accepted");
    const g = await expectOk(e.anon.get(`/v1/generations/${v.gen_id}`));
    const audits = g.replays.filter((r: any) => r.audit_id);
    expect(audits.map((r: any) => r.kind).sort()).toEqual(["audit", "audit", "audit_reference"]);
    expect(g.audit.status).toBe("reverted");
    expect(g.audit.detail).toContain("equivalence");
    expect(g.reverted_by).toBeTruthy();
    expect(audits.find((r: any) => r.replayer === colluder).role).toBe("minority");
    expect(BigInt((await agent(e, colluder!)).slashed_total)).toBeGreaterThan(0n);
    const honestAuditor = audits.find((r: any) => r.kind === "audit" && r.replayer !== colluder);
    expect((await agent(e, honestAuditor.replayer)).slashed_total).toBe("0");
    await reconcileOk(e);
  });

  test("an audit short of independent auditors is judged with what arrived after twice the replay window", async () => {
    const e = (env = await setup({ verifiers: 3, over: { audit_rate: 1, max_open_replays: 4 } }));
    const c = await submit(e, await makeAuthor(e), diff("short"));
    await runReplays(e, c.candidate_id, () => result());
    const v = await candidate(e, c.candidate_id);
    expect((await expectOk(e.anon.get(`/v1/generations/${v.gen_id}`))).audit.status).toBe("pending");
    e.clock.advance(2 * Math.max(e.cfg.replay_window_min_s, e.cfg.replay_window_factor * 120) * 1000 + 1);
    e.core.tick();
    const g = await expectOk(e.anon.get(`/v1/generations/${v.gen_id}`));
    expect(g.audit.status).toBe("agreed");
    expect(g.replays.filter((r: any) => r.audit_id)).toHaveLength(2);
  });
});

describe("author-blind replay (SPEC 10.7)", () => {
  test("no public endpoint, event or telemetry names the author of an open candidate; ids cannot be tested against agent ids", async () => {
    const e = (env = await setup({ verifiers: 6, over: { canary_rate: 1, max_open_replays: 4, ...CANARY_FAST } }));
    await expectOk(e.admin.c.post("/v1/admin/canaries", { lineage_id: e.lineage, kind: "perf", target: "ir", expected_reason: "tests_fail", patch: diff("blind_canary", "src/c.rs") }));
    const author = await makeAuthor(e);
    warmShadows(e);
    const lv = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`));
    // the author's live telemetry: search activity (public by design), a submit and a commit-phase heartbeat
    await expectOk(author.c.post("/v1/heartbeat", { job: "author", lineage_id: e.lineage, gen_id: lv.tip, phase: "propose" }));
    await expectOk(author.c.post("/v1/activity", { events: [{ kind: "search", lineage_id: e.lineage, gen_id: lv.tip, commit: lv.snapshot.commit_sha, query: "slow" }] }));
    const real = await submit(e, author, diff("blind_real"));
    await expectOk(author.c.post("/v1/activity", { events: [{ kind: "submit", lineage_id: e.lineage, gen_id: lv.tip, commit: lv.snapshot.commit_sha }] }));
    e.clock.advance(1500);
    await expectOk(author.c.post("/v1/heartbeat", { job: "author", lineage_id: e.lineage, gen_id: lv.tip, phase: "commit" }));
    settleCanaries(e);
    // an epoch closes while both are open: its assignment rounds must not name them yet
    await expectOk(e.admin.c.post("/v1/admin/epochs/close"));
    const all = await expectOk<any[]>(e.admin.c.get(`/v1/candidates?lineage=${e.lineage}`, true));
    expect(all).toHaveLength(2);
    expect(all.every((c) => c.status === "replaying")).toBe(true);
    const open = all.map((c) => ({ ids: [c.commit_id, c.candidate_id], parties: [c.author], sealed: [c.commitment] }));
    const leaks = await authorLeaks(e, open);
    expect(leaks).toEqual([]);
    // the public views say nothing; the author and the admin see everything
    for (const c of all) {
      const pub = await candidate(e, c.candidate_id);
      expect(pub.author).toBeNull();
      expect(pub.commitment).toBeNull();
      expect(pub.salt).toBeNull();
    }
    expect((await expectOk(author.c.get(`/v1/candidates/${real.candidate_id}`, true))).author).toBe(author.id);
    expect(await expectOk<any[]>(e.anon.get(`/v1/candidates?author=${author.id}`))).toHaveLength(0);
    expect(await expectOk<any[]>(author.c.get(`/v1/candidates?author=${author.id}`, true))).toHaveLength(1);
    expect((await expectOk<any[]>(e.anon.get(`/v1/activity?agent=${author.id}`))).map((a) => a.kind)).toEqual(["search"]);
    expect((await expectOk<any[]>(author.c.get(`/v1/activity?agent=${author.id}`, true))).map((a) => a.kind).sort()).toEqual(["search", "submit"]);
    expect((await expectOk<any[]>(e.anon.get("/v1/heartbeats"))).find((m) => m.agent_id === author.id).phase).toBe("propose");
    // a replayer holds the patch, so it knows every input of the candidate id but the author tag
    const agents = await expectOk<any[]>(e.anon.get("/v1/agents"));
    const asg = (await Promise.all(e.verifiers.map((v) => assignmentsFor(v)))).flat();
    const held = asg.find((a) => a.candidate?.candidate_id === real.candidate_id);
    expect(held).toBeDefined();
    const pubReal = await candidate(e, real.candidate_id);
    for (const a of agents)
      expect(candidateId({ lineage_id: e.lineage, parent_gen_id: pubReal.parent_gen_id, patch_hash: patchHash(held.candidate.patch), author: a.agent_id, kind: "perf", target: "ir" })).not.toBe(real.candidate_id);
    // once final, everything is public again and the id is recomputable from the published salt
    await runReplays(e, real.candidate_id, honest(result({}, 900)));
    const fin = await candidate(e, real.candidate_id);
    expect(fin.status).toBe("accepted");
    expect(fin.author).toBe(author.id);
    expect(fin.commitment).toBe(patchCommitment(fin.patch_hash, fin.salt));
    expect(candidateId({ lineage_id: e.lineage, parent_gen_id: fin.parent_gen_id, patch_hash: fin.patch_hash, author: e.core.collab.authorTag(author.id, fin.salt), kind: "perf", target: "ir" })).toBe(fin.candidate_id);
    const closed = await expectOk(e.anon.get("/v1/epochs/0"));
    expect((closed.assignment_rounds as any[]).some((r) => r.subject === real.candidate_id)).toBe(true);
    await reconcileOk(e);
  }, 60_000);
});
