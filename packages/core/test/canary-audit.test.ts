import { afterEach, describe, expect, test } from "bun:test";
import { canonicalizeDiff, patchHash } from "../src/protocol.ts";
import {
  agent,
  candidate,
  diff,
  expectOk,
  makeAuthor,
  reconcileOk,
  result,
  CANARY_FAST,
  settleCanaries,
  warmShadows,
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

describe("canaries (SPEC 10.5)", () => {
  async function withCanary(e: Env) {
    const patch = diff("canary_break", "src/hidden.rs");
    const up = await expectOk(e.admin.c.post("/v1/admin/canaries", { lineage_id: e.lineage, patch, kind: "perf", target: "ir", expected_reason: "tests_fail" }));
    expect(up.patch_hash).toBe(patchHash(patch));
    const author = await makeAuthor(e);
    warmShadows(e);
    const real = await submit(e, author, diff("real"));
    // the canary is committed and revealed on later ticks, never with the real candidate
    expect(await expectOk<any[]>(e.anon.get(`/v1/candidates?lineage=${e.lineage}`))).toHaveLength(1);
    settleCanaries(e);
    // author-blind (SPEC 10.7): the public list names no author while a candidate is open; the admin sees it
    const pub = await expectOk<any[]>(e.anon.get(`/v1/candidates?lineage=${e.lineage}`));
    expect(pub.filter((c) => c.status !== "accepted" && c.status !== "rejected").every((c) => c.author === null)).toBe(true);
    const all = await expectOk<any[]>(e.admin.c.get(`/v1/candidates?lineage=${e.lineage}`, true));
    const canary = all.find((c) => c.candidate_id !== real.candidate_id)!;
    expect(canary).toBeDefined();
    expect(canary.author).not.toBe(author.id);
    return { real, canary, canaryHash: up.patch_hash as string, author };
  }

  test("a canary looks like any other candidate until the epoch closes", async () => {
    const e = (env = await setup({ verifiers: 2, over: { canary_rate: 1, max_open_replays: 4, ...CANARY_FAST } }));
    const { canary } = await withCanary(e);
    expect(canary.status).toBe("replaying");
    expect(canary.canary).toBeNull();
    const shadow = await agent(e, canary.author);
    expect(shadow.kind).toBe("launched");
    expect(shadow.awake).toBe(true);
    expect(shadow.lifecycle).toBe("active");
    expect("shadow" in shadow).toBe(false);
    // the admin can see it
    expect((await expectOk(e.admin.c.get(`/v1/admin/agents/${canary.author}`, true))).shadow).toBe(true);
    // replayers get it as an ordinary assignment
    const asg = await expectOk<any[]>(e.verifiers[0]!.c.get("/v1/assignments", true));
    const forCanary = asg.find((a) => a.candidate.candidate_id === canary.candidate_id);
    expect(forCanary.kind).toBe("replay");
  });

  test("an accept-all replayer is slashed and struck; an honest one is paid and untouched", async () => {
    const e = (env = await setup({ verifiers: 2, over: { canary_rate: 1, max_open_replays: 4, ...CANARY_FAST } }));
    const { real, canary, canaryHash } = await withCanary(e);
    const [cheat, honest] = e.verifiers as [Agent, Agent];
    const behave = (a: Agent, asg: any) => (a.id === cheat.id ? result() : asg.candidate.patch_hash === canaryHash ? breaks() : result());
    const before = BigInt((await agent(e, cheat.id)).bond);
    await runReplays(e, canary.candidate_id, behave);
    await runReplays(e, real.candidate_id, behave);
    const c = await agent(e, cheat.id);
    expect(BigInt(c.bond)).toBe(before - (before * BigInt(e.cfg.canary_slash_bps)) / 10_000n);
    expect(c.strikes_epoch).toBe(1);
    const h = await agent(e, honest.id);
    expect(h.slashed_total).toBe("0");
    expect(h.strikes_epoch).toBe(0);
    const v = await candidate(e, canary.candidate_id);
    expect(v.status).toBe("rejected");
    expect(v.gen_id).toBeNull();
    expect(v.replays.find((r: any) => r.replayer === cheat.id).role).toBe("canary_fail");
    expect(v.replays.find((r: any) => r.replayer === honest.id).role).toBe("canary_pass");
    // the honest canary replay earned normal replay units; the cheat earned only its real replay
    const ep = await expectOk(e.anon.get("/v1/epochs/current"));
    expect(ep.units.find((u: any) => u.agent === honest.id).count).toBe(2);
    expect(ep.units.find((u: any) => u.agent === cheat.id).count).toBe(1);
    // the real candidate is unaffected
    expect((await candidate(e, real.candidate_id)).status).toBe("accepted");
    // epoch close reveals the canary list and the shadow identity
    const closed = await expectOk(e.admin.c.post("/v1/admin/epochs/close"));
    expect(closed.canaries).toHaveLength(1);
    expect(closed.canaries[0].candidate_id).toBe(canary.candidate_id);
    expect(closed.canaries[0].shadow_agent).toBe(canary.author);
    expect(closed.canaries[0].expected_reason).toBe("tests_fail");
    expect((await agent(e, canary.author)).shadow).toBe(true);
    expect((await candidate(e, canary.candidate_id)).canary).not.toBeNull();
    await reconcileOk(e);
  });

  test("a canary accepted by every replayer still never becomes a generation", async () => {
    const e = (env = await setup({ verifiers: 2, over: { canary_rate: 1, max_open_replays: 4, ...CANARY_FAST } }));
    const { canary } = await withCanary(e);
    await runReplays(e, canary.candidate_id, () => result());
    const v = await candidate(e, canary.candidate_id);
    expect(v.status).toBe("rejected");
    expect(v.reason).toBe("canary");
    expect((await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`))).height).toBe(0);
    for (const x of e.verifiers) expect((await agent(e, x.id)).strikes_epoch).toBe(1);
  });

  test("no canary at canary_rate 0; canary uploads must pass the static guard", async () => {
    const e = (env = await setup({ verifiers: 2 }));
    await expectOk(e.admin.c.post("/v1/admin/canaries", { lineage_id: e.lineage, patch: diff("c0"), kind: "perf", target: "ir", expected_reason: "tests_fail" }));
    const author = await makeAuthor(e);
    await submit(e, author, diff("x"));
    expect(await expectOk<any[]>(e.anon.get(`/v1/candidates?lineage=${e.lineage}`))).toHaveLength(1);
    const bad = await e.admin.c.post("/v1/admin/canaries", { lineage_id: e.lineage, patch: canonicalizeDiff(diff("c1", "tests/t.rs")), kind: "perf", target: "ir", expected_reason: "guard" });
    expect(bad.body.error).toBe("canary_guard");
  });
});

describe("audits (SPEC 10.6, 11.3)", () => {
  test("an agreeing audit pays the audit replayer and marks the generation agreed", async () => {
    const e = (env = await setup({ verifiers: 4, over: { audit_rate: 1 } }));
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("au"));
    await runReplays(e, c.candidate_id, () => result());
    const v = await candidate(e, c.candidate_id);
    const gen = await expectOk(e.anon.get(`/v1/generations/${v.gen_id}`));
    expect(gen.audit.status).toBe("agreed");
    const audits = gen.replays.filter((r: any) => r.audit_id);
    // audit_replayers (default 2) random auditors plus the reference runner (SPEC 10.6)
    expect(audits.map((r: any) => r.kind).sort()).toEqual(["audit", "audit", "audit_reference"]);
    for (const auditor of audits.filter((r: any) => r.kind === "audit")) {
      expect(v.replays.filter((r: any) => !r.audit_id).map((r: any) => r.replayer)).not.toContain(auditor.replayer);
      expect((await agent(e, auditor.replayer)).units_epoch).toBeGreaterThan(0);
    }
  });

  test("a contradicting audit reverts the generation, slashes the original replayers and voids the author reward", async () => {
    const e = (env = await setup({ verifiers: 5, over: { audit_rate: 1, max_open_replays: 4 } }));
    const author = await makeAuthor(e);
    const a2 = await makeAuthor(e);
    const bad = await submit(e, author, diff("bad", "src/a.rs"));
    // the original pair rubber-stamps; audits are held back for now
    await runReplays(e, bad.candidate_id, (_a, asg) => (asg.kind === "replay" ? result() : "skip"));
    const g1 = (await candidate(e, bad.candidate_id)).gen_id;
    const good = await submit(e, a2, diff("good", "src/b.rs"));
    await runReplays(e, good.candidate_id, (_a, asg) => (asg.kind === "replay" ? result() : "skip"));
    const g2 = (await candidate(e, good.candidate_id)).gen_id;
    const originals = (await candidate(e, bad.candidate_id)).replays.filter((r: any) => !r.audit_id).map((r: any) => r.replayer);
    const bonds = await Promise.all(originals.map(async (id: string) => BigInt((await agent(e, id)).bond)));
    const authorUnitsBefore = (await agent(e, author.id)).units_epoch;
    expect(authorUnitsBefore).toBeGreaterThan(0);

    // the audit replayer and the reference runner measure honestly: the patch breaks a test
    await runReplays(e, bad.candidate_id, (_a, asg) => (asg.kind === "replay" ? result() : breaks()));
    const gen = await expectOk(e.anon.get(`/v1/generations/${g1}`));
    expect(gen.audit.status).toBe("reverted");
    expect(gen.reverted_by).toBeTruthy();
    for (let i = 0; i < originals.length; i++) {
      const o = await agent(e, originals[i]);
      expect(BigInt(o.bond)).toBe(bonds[i]! - (bonds[i]! * BigInt(e.cfg.minority_slash_bps)) / 10_000n);
      expect(o.strikes_epoch).toBe(1);
    }
    expect((await agent(e, author.id)).units_epoch).toBe(0);
    const l = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`));
    const revert = l.generations.find((g: any) => g.entry_type === "revert");
    expect(revert.reverts).toBe(g1);
    expect(l.tip).toBe(revert.gen_id);
    expect(l.generations.find((g: any) => g.gen_id === g2).needs_revalidation).toBe(true);
    // the tree at the tip no longer carries the reverted patch
    const tree = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}/tree`));
    expect(tree.patches.map((p: any) => p.gen_id)).toEqual([g2]);
    // history is not rewritten: the tree at g1 still has it
    expect((await expectOk(e.anon.get(`/v1/lineages/${e.lineage}/tree?gen=${g1}`))).patches.map((p: any) => p.gen_id)).toEqual([g1]);
    await reconcileOk(e);
  });
});
