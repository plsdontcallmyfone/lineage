import { afterEach, describe, expect, test } from "bun:test";
import { recipeId } from "../src/protocol.ts";
import {
  CALIB,
  CAPS,
  RECIPE,
  agent,
  assignmentsFor,
  bare,
  candidate,
  diff,
  expectOk,
  makeAuthor,
  makeVerifier,
  qualify,
  qualifyResult,
  result,
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

const quals = async (a: Agent) => (await expectOk<any[]>(a.c.get("/v1/assignments", true))).filter((x) => x.kind === "qualify");

describe("capabilities (SPEC 6.1)", () => {
  test("declared at registration, updated with PUT, validated strictly, shown in the agent view", async () => {
    const e = (env = await setup({ verifiers: 1 }));
    const v = e.verifiers[0]!;
    const view = await agent(e, v.id);
    expect(view.capabilities).toEqual(CAPS);
    expect(view.qualified_lineages).toEqual([e.lineage]);
    expect(view.qualifications[0].status).toBe("passed");
    const bad = [
      { ...CAPS, arch: "x86_64" },
      { ...CAPS, extra: 1 },
      { ...CAPS, cpus: 0 },
      { ...CAPS, memory_mb: 1.5 },
      { ...CAPS, gpus: [{ vendor: "amd", model: "x", sm: "8.9", mem_gb: 24, driver: "550.1" }] },
      { ...CAPS, gpus: [{ vendor: "nvidia", model: "RTX 4090", sm: "89", mem_gb: 24, driver: "550.1" }] },
      { ...CAPS, gpus: [{ vendor: "nvidia", model: "RTX 4090", sm: "8.9", mem_gb: 24, driver: "550.1", serial: "x" }] },
      "arm64",
    ];
    for (const caps of bad) {
      const r = await v.c.put(`/v1/agents/${v.id}/capabilities`, { capabilities: caps });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("bad_capabilities");
    }
    const gpu = { ...CAPS, gpus: [{ vendor: "nvidia", model: "NVIDIA GeForce RTX 4090", sm: "8.9", mem_gb: 24, driver: "550.54.15" }] };
    expect((await expectOk(v.c.put(`/v1/agents/${v.id}/capabilities`, { capabilities: gpu }))).capabilities).toEqual(gpu);
    // only the agent itself may declare its capabilities
    const other = e.verifiers[0]!;
    const stranger = await makeVerifier(e, { qualify: false });
    expect((await stranger.c.put(`/v1/agents/${other.id}/capabilities`, { capabilities: CAPS })).status).toBe(403);
    // registration refuses bad capabilities too
    const reg = await makeVerifier(e, { capabilities: { arch: "arm64" }, qualify: false }).catch((err) => String(err));
    expect(String(reg)).toContain("bad_capabilities");
  });

  test("recipes must carry class and requires", async () => {
    const e = (env = bare() as unknown as Env);
    const { class: _c, ...noClass } = RECIPE;
    const { requires: _r, ...noReq } = RECIPE;
    for (const r of [noClass, noReq, { ...RECIPE, class: "java" }, { ...RECIPE, requires: { arch: "riscv" } }, { ...RECIPE, class: "cuda" }]) {
      const res = await e.admin.c.post("/v1/admin/recipes", { recipe: r });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("bad_recipe");
    }
    expect((await expectOk(e.admin.c.post("/v1/admin/recipes", { recipe: RECIPE }))).recipe_id).toBe(recipeId(RECIPE));
  });
});

describe("qualification (SPEC 6.1)", () => {
  test("the assignment carries gen_0, the calibration seed and no answer key", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    const v = await makeVerifier(e, { qualify: false });
    const [q] = await quals(v);
    expect(q.seed).toBe(CALIB.seed);
    expect(q.candidate).toBeNull();
    expect(q.parent_gen_id).toBe(e.gen0);
    expect(q.parent_series).toEqual([]);
    expect(q.calibration.stable).toEqual(CALIB.stable);
    expect(q.calibration.metrics.ir.base_value).toBeUndefined();
    expect(q.recipe.name).toBe(RECIPE.name);
    expect((await agent(e, v.id)).qualified_lineages).toEqual([]);
  });

  test("verifiers without capabilities, or of the wrong arch, get no qualification and no replay", async () => {
    const e = (env = await setup({ verifiers: 2 }));
    const none = await makeVerifier(e, { capabilities: null });
    const amd = await makeVerifier(e, { capabilities: { ...CAPS, arch: "amd64" } });
    expect(await quals(none)).toHaveLength(0);
    expect(await quals(amd)).toHaveLength(0);
    for (let i = 0; i < 4; i++) {
      const c = await submit(e, await makeAuthor(e), diff(`w${i}`));
      expect(await assignmentsFor(none, c.candidate_id)).toHaveLength(0);
      expect(await assignmentsFor(amd, c.candidate_id)).toHaveLength(0);
      await runReplays(e, c.candidate_id, () => result());
    }
    const rounds = (await expectOk(e.admin.c.post("/v1/admin/epochs/close"))).assignment_rounds as any[];
    expect(rounds.length).toBeGreaterThan(0);
    for (const r of rounds) for (const p of r.pool) expect([none.id, amd.id]).not.toContain(p.agent);
  });

  test("a failed qualification is not slashed or struck, keeps the verifier out, and may retry after the cooldown", async () => {
    const e = (env = await setup({ verifiers: 2, over: { qualify_retry_s: 60 } }));
    const v = await makeVerifier(e, { qualify: false });
    const bondBefore = (await agent(e, v.id)).bond;
    const [r] = await qualify(v, qualifyResult({ metrics: { ir: { base: [1100], cand: [], deterministic: true } } }));
    expect(r.qualification).toBe("failed");
    expect(r.reason).toContain("ir base 1100");
    const view = await agent(e, v.id);
    expect(view.bond).toBe(bondBefore);
    expect(view.strikes_total).toBe(0);
    expect(view.qualified_lineages).toEqual([]);
    expect(view.qualifications[0].retry_at).toBe(e.clock.now() + 60_000);
    const c = await submit(e, await makeAuthor(e), diff("f"));
    expect(await assignmentsFor(v, c.candidate_id)).toHaveLength(0);
    // a different stable set fails too
    e.clock.advance(61_000);
    await expectOk(e.admin.c.post("/v1/admin/tick"));
    const [r2] = await qualify(v, qualifyResult({ tests: { base_pass: ["t1", "t2"], cand_pass: [], cand_fail: [] } }));
    expect(r2.qualification).toBe("failed");
    expect(r2.reason).toContain("missing t3");
    expect(await quals(v)).toHaveLength(0); // cooldown again
    e.clock.advance(61_000);
    await expectOk(e.admin.c.post("/v1/admin/tick"));
    const [r3] = await qualify(v);
    expect(r3.qualification).toBe("passed");
    const after = await agent(e, v.id);
    expect(after.qualifications.map((q: any) => q.attempt)).toEqual([1, 2, 3]);
    expect(after.qualified_lineages).toEqual([e.lineage]);
    expect(after.strikes_total).toBe(0);
  });

  test("an expired qualification gives no strike", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    const v = await makeVerifier(e, { qualify: false });
    e.clock.advance(Math.max(e.cfg.replay_window_min_s, e.cfg.replay_window_factor * CALIB.median_eval_seconds) * 1000 + 1);
    await expectOk(e.admin.c.post("/v1/admin/tick"));
    const view = await agent(e, v.id);
    expect(view.qualifications[0].status).toBe("expired");
    expect(view.strikes_total).toBe(0);
  });

  test("a qualified verifier is assigned; changing to an unsatisfying arch revokes the qualification", async () => {
    const e = (env = await setup({ verifiers: 2 }));
    const v = await makeVerifier(e, { bond: e.cfg.min_bond * 1000n });
    const c1 = await submit(e, await makeAuthor(e), diff("q1"));
    expect(await assignmentsFor(v, c1.candidate_id)).toHaveLength(1);
    await runReplays(e, c1.candidate_id, () => result());
    await expectOk(v.c.put(`/v1/agents/${v.id}/capabilities`, { capabilities: { ...CAPS, arch: "amd64" } }));
    const view = await agent(e, v.id);
    expect(view.qualifications[0].status).toBe("revoked");
    expect(view.qualified_lineages).toEqual([]);
    const c2 = await submit(e, await makeAuthor(e), diff("q2"));
    expect(await assignmentsFor(v, c2.candidate_id)).toHaveLength(0);
    // back on the right arch: a fresh qualification is issued at once (no cooldown after a revoke)
    await expectOk(v.c.put(`/v1/agents/${v.id}/capabilities`, { capabilities: CAPS }));
    expect(await quals(v)).toHaveLength(1);
    // a capability change that still satisfies keeps the qualification
    await qualify(v);
    await expectOk(v.c.put(`/v1/agents/${v.id}/capabilities`, { capabilities: { ...CAPS, cpus: 4 } }));
    expect((await agent(e, v.id)).qualified_lineages).toEqual([e.lineage]);
  });

  test("reference runners are qualified by definition", async () => {
    const e = (env = await setup({ verifiers: 4, over: { audit_rate: 1 } }));
    expect(await quals(e.reference!)).toHaveLength(0);
    const c = await submit(e, await makeAuthor(e), diff("ref"));
    await runReplays(e, c.candidate_id, () => result());
    const gen = await expectOk(e.anon.get(`/v1/generations/${(await candidate(e, c.candidate_id)).gen_id}`));
    expect(gen.replays.some((r: any) => r.kind === "audit_reference" && r.replayer === e.reference!.id)).toBe(true);
  });
});

describe("audits revert only on deterministic contradictions (SPEC 10.6)", () => {
  async function auditWith(e: Env, target: string, original: () => ReturnType<typeof result>, audit: () => ReturnType<typeof result>) {
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff(`a-${target}-${Math.random()}`.replace(/\W/g, "")), { target });
    await runReplays(e, c.candidate_id, (_a, asg) => (asg.kind === "replay" ? original() : "skip"));
    const v = await candidate(e, c.candidate_id);
    expect(v.status).toBe("accepted");
    await runReplays(e, c.candidate_id, (_a, asg) => (asg.kind === "replay" ? original() : audit()));
    const gen = await expectOk(e.anon.get(`/v1/generations/${v.gen_id}`));
    return { gen, author };
  }
  const noisy = (base: number, cand: number) =>
    result({
      metrics: {
        ir: { base: [1000], cand: [900], deterministic: true },
        ns: { base: Array.from({ length: 15 }, (_, i) => base + (i % 3)), cand: Array.from({ length: 15 }, (_, i) => cand + (i % 3)), deterministic: false },
      },
    });

  test("a fresh-seed miss on a noisy metric is inconclusive, not a revert", async () => {
    const e = (env = await setup({ verifiers: 4, over: { audit_rate: 1, max_open_replays: 4 } }));
    const { gen, author } = await auditWith(e, "ns", () => noisy(100, 80), () => noisy(100, 100));
    expect(gen.audit.status).toBe("inconclusive");
    expect(gen.audit.detail).toContain("noisy");
    expect(gen.reverted_by).toBeNull();
    expect((await agent(e, author.id)).units_epoch).toBeGreaterThan(0);
    for (const v of e.verifiers) expect((await agent(e, v.id)).slashed_total).toBe("0");
    // honest audit work is still paid
    const auditor = gen.replays.find((r: any) => r.kind === "audit");
    expect(auditor.role).toBe("counted");
  });

  test("a fresh-seed miss on a deterministic metric is recorded as weak, not reverted", async () => {
    const e = (env = await setup({ verifiers: 4, over: { audit_rate: 1, max_open_replays: 4 } }));
    const { gen } = await auditWith(e, "ir", () => result(), () => result({}, 1000));
    expect(gen.audit.status).toBe("weak");
    expect(gen.audit.detail).toContain("ir");
    expect(gen.reverted_by).toBeNull();
    for (const v of e.verifiers) expect((await agent(e, v.id)).slashed_total).toBe("0");
  });

  test("a behaviour change on the audit's fresh inputs reverts", async () => {
    const e = (env = await setup({ verifiers: 4, over: { audit_rate: 1, max_open_replays: 4 } }));
    const { gen } = await auditWith(e, "ir", () => result(), () => result({ equivalence: { base_digest: "e1", cand_digest: "e2" } }));
    expect(gen.audit.status).toBe("reverted");
    expect(gen.audit.detail).toContain("equivalence");
    expect(gen.reverted_by).toBeTruthy();
  });
});
