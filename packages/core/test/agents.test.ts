import { afterEach, describe, expect, test } from "bun:test";
import { calibId, generateAgentKey, signMessage } from "../src/protocol.ts";
import { ACC } from "../src/ledger.ts";
import { agent, agentClient, balance, bare, CALIB, DEPS, expectOk, fund, makeAuthor, makeVerifier, RECIPE, reconcileOk, setup, type Env } from "./helpers.ts";

let env: Env | ReturnType<typeof bare> | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

describe("lineage setup", () => {
  test("calibration creates the lineage, gen_0 and automatic findings", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    const l = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`));
    expect(l.tip).toBe(e.gen0);
    expect(l.height).toBe(0);
    expect(l.generations).toHaveLength(1);
    expect(l.generations[0].entry_type).toBe("genesis");
    expect(l.calibration.stable).toEqual(CALIB.stable);
    const f = await expectOk<any[]>(e.anon.get(`/v1/findings?lineage=${e.lineage}`));
    // two known failures plus the enabled metrics (ir, ns); size is disabled by calibration
    expect(f.map((x) => `${x.kind}:${x.target}`).sort()).toEqual(["known_failure:bug1", "known_failure:bug2", "metric_target:ir", "metric_target:ns"]);
    const again = await e.reference!.c.post("/v1/calibrations", { calibration: CALIB, sig: signMessage(e.reference!.key, calibId(CALIB.recipe_id, CALIB.snapshot_id, CALIB)) });
    expect(again.body.error).toBe("lineage_exists");
  });

  test("calibration signature must sign the calib id, snapshot must match the recipe", async () => {
    const e = (env = bare());
    await expectOk(e.admin.c.post("/v1/admin/recipes", { recipe: RECIPE }));
    await expectOk(e.admin.c.post("/v1/admin/snapshots", { repo: RECIPE.repo, commit: RECIPE.commit, deps_digest: DEPS }));
    const ref = await makeVerifier(e as any, { bond: 0n });
    await expectOk(e.admin.c.post(`/v1/admin/agents/${ref.id}/reference`, {}));
    const bad = await ref.c.post("/v1/calibrations", { calibration: CALIB, sig: signMessage(ref.key, "something else") });
    expect(bad.body.error).toBe("bad_signature");
    const other = await expectOk(e.admin.c.post("/v1/admin/snapshots", { repo: RECIPE.repo, commit: "ffffffffffffffffffffffffffffffffffffffff", deps_digest: DEPS }));
    const wrongSnap = { ...CALIB, snapshot_id: other.snapshot_id };
    const r = await ref.c.post("/v1/calibrations", { calibration: wrongSnap, sig: signMessage(ref.key, calibId(wrongSnap.recipe_id, wrongSnap.snapshot_id, wrongSnap)) });
    expect(r.body.error).toBe("snapshot_mismatch");
  });

  test("a launched agent is setting_up until its target is calibrated, then active", async () => {
    const e = (env = bare());
    const author = await makeAuthor(e as any);
    expect((await agent(e as any, author.id)).lifecycle).toBe("setting_up");
    await expectOk(e.admin.c.post("/v1/admin/recipes", { recipe: RECIPE }));
    await expectOk(e.admin.c.post("/v1/admin/snapshots", { repo: RECIPE.repo, commit: RECIPE.commit, deps_digest: DEPS }));
    const ref = await makeVerifier(e as any, { bond: 0n });
    await expectOk(e.admin.c.post(`/v1/admin/agents/${ref.id}/reference`, {}));
    await expectOk(ref.c.post("/v1/calibrations", { calibration: CALIB, sig: signMessage(ref.key, calibId(CALIB.recipe_id, CALIB.snapshot_id, CALIB)) }));
    expect((await agent(e as any, author.id)).lifecycle).toBe("active");
    // a launch after calibration starts active
    expect((await agent(e as any, (await makeAuthor(e as any)).id)).lifecycle).toBe("active");
  });
});

describe("registration, bonds and token simulation", () => {
  test("verifier registration burns register_burn; needs funds; only once", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    const a = agentClient(e);
    expect((await a.c.post("/v1/agents", {})).body.error).toBe("insufficient_funds");
    await fund(e, a.id, e.cfg.register_burn);
    const v = await expectOk(a.c.post("/v1/agents", { operator: "op-1" }));
    expect(v.kind).toBe("verifier");
    expect(v.operator).toBe("op-1");
    expect(v.wallet).toBe("0");
    expect((await a.c.post("/v1/agents", {})).body.error).toBe("already_registered");
    expect(await balance(e, ACC.burned)).toBe(e.cfg.register_burn * 2n); // reference + this one
    await reconcileOk(e);
  });

  test("launch records the agent without a burn; one agent per mint", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    const burnedBefore = await balance(e, ACC.burned);
    const id = generateAgentKey().id;
    const mint = generateAgentKey().id;
    const body = { agent: id, mint, launcher: generateAgentKey().id, target_repo: "https://github.com/Example/FX.git", hosted: false, identity_mode: "import" };
    const v = await expectOk(e.admin.c.post("/v1/admin/launches", body));
    expect(v.kind).toBe("launched");
    expect(v.target_repo).toBe("https://github.com/example/fx");
    expect(v.lifecycle).toBe("active");
    expect(v.awake).toBe(false);
    expect(await balance(e, ACC.burned)).toBe(burnedBefore);
    expect((await e.admin.c.post("/v1/admin/launches", { ...body, agent: generateAgentKey().id })).body.error).toBe("mint_taken");
  });

  test("hosted agents cannot bond and are never eligible", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    const h = await makeAuthor(e, { hosted: true });
    await fund(e, h.id, e.cfg.min_bond);
    const r = await h.c.post(`/v1/agents/${h.id}/bond`, { amount: e.cfg.min_bond.toString() });
    expect(r.body.error).toBe("hosted");
    expect((await agent(e, h.id)).eligible).toBe(false);
    // a self-hosted launched agent may bond and verify
    const s = await makeAuthor(e, { hosted: false });
    await fund(e, s.id, e.cfg.min_bond);
    await expectOk(s.c.post(`/v1/agents/${s.id}/bond`, { amount: e.cfg.min_bond.toString() }));
    expect((await agent(e, s.id)).eligible).toBe(true);
  });

  test("agent fees split into compute and treasury, then reserve and pool; exact to the unit", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    const a = await makeAuthor(e, { fees: 0n });
    const amount = 1_000_000_007n;
    const before = { reserve: await balance(e, ACC.reserve), pool: await balance(e, ACC.pool), treasury: await balance(e, ACC.treasury) };
    const r = await expectOk(e.admin.c.post("/v1/admin/agent-fees", { agent: a.id, amount: amount.toString() }));
    const compute = (amount * BigInt(e.cfg.agent_compute_bps)) / 10_000n;
    const protocol = (amount * BigInt(e.cfg.protocol_bps)) / 10_000n;
    const reserve = (protocol * BigInt(e.cfg.reserve_bps)) / 10_000n;
    const pool = (protocol * BigInt(e.cfg.pool_bps)) / 10_000n;
    expect(r.compute).toBe(compute.toString());
    expect(await balance(e, ACC.compute(a.id))).toBe(compute);
    expect(await balance(e, ACC.reserve)).toBe(before.reserve + reserve);
    expect(await balance(e, ACC.pool)).toBe(before.pool + pool);
    expect(await balance(e, ACC.treasury)).toBe(before.treasury + protocol - reserve - pool);
    await reconcileOk(e);
  });

  test("creator rewards split reserve_bps and pool_bps", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    const r = await expectOk(e.admin.c.post("/v1/admin/creator-rewards", { amount: "10000" }));
    expect(r.reserve).toBe(String((10000 * e.cfg.reserve_bps) / 10000));
    expect(r.pool).toBe(String((10000 * e.cfg.pool_bps) / 10000));
    await reconcileOk(e);
  });

  test("sleep and wake follow the compute vault with hysteresis; usage debits to the reserve", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    const a = await makeAuthor(e, { fees: 0n });
    const toCompute = (want: bigint) => (want * 10_000n + BigInt(e.cfg.agent_compute_bps) - 1n) / BigInt(e.cfg.agent_compute_bps);
    // just below wake: still asleep
    await expectOk(e.admin.c.post("/v1/admin/agent-fees", { agent: a.id, amount: toCompute(e.cfg.wake_threshold - 10n).toString() }));
    expect((await agent(e, a.id)).awake).toBe(false);
    await expectOk(e.admin.c.post("/v1/admin/agent-fees", { agent: a.id, amount: toCompute(20n).toString() }));
    expect((await agent(e, a.id)).awake).toBe(true);
    const compute = await balance(e, ACC.compute(a.id));
    // spend down to between the thresholds: stays awake (hysteresis)
    const between = (e.cfg.sleep_threshold + e.cfg.wake_threshold) / 2n;
    const u = await expectOk(e.admin.c.post("/v1/admin/usage", { agent: a.id, amount: (compute - between).toString(), model_tokens: 1234, sandbox_seconds: 56 }));
    expect(u.awake).toBe(true);
    const reserveBefore = await balance(e, ACC.reserve);
    const u2 = await expectOk(e.admin.c.post("/v1/admin/usage", { agent: a.id, amount: (between - e.cfg.sleep_threshold + 1n).toString() }));
    expect(u2.awake).toBe(false);
    expect(await balance(e, ACC.reserve)).toBe(reserveBefore + between - e.cfg.sleep_threshold + 1n);
    const over = await e.admin.c.post("/v1/admin/usage", { agent: a.id, amount: (compute * 10n).toString() });
    expect(over.body.error).toBe("insufficient_compute");
    const ep = await expectOk(e.anon.get("/v1/epochs/current"));
    expect(ep.usage).toHaveLength(2);
    expect(ep.usage[0].model_tokens).toBe(1234);
    await reconcileOk(e);
  });

  test("usage can be posted by the runtime key but not by agents", async () => {
    const e = (env = await setup({ verifiers: 1 }));
    const a = await makeAuthor(e);
    const r = await e.verifiers[0]!.c.post("/v1/admin/usage", { agent: a.id, amount: "1" });
    expect(r.body.error).toBe("not_runtime");
  });

  test("unbond: cooling agents are not assignable, still slashable, and receive the bond after the cooldown", async () => {
    const e = (env = await setup({ verifiers: 1 }));
    const v = e.verifiers[0]!;
    expect((await agent(e, v.id)).eligible).toBe(true);
    await expectOk(v.c.post(`/v1/agents/${v.id}/unbond`, { amount: e.cfg.min_bond.toString() }));
    const cooling = await agent(e, v.id);
    expect(cooling.cooling).toBe(true);
    expect(cooling.eligible).toBe(false);
    expect(cooling.bond).toBe(e.cfg.min_bond.toString());
    expect((await v.c.post(`/v1/agents/${v.id}/unbond`, { amount: "1" })).body.error).toBe("already_cooling");
    e.clock.advance(e.cfg.unbond_cooldown_s * 1000 - 1);
    e.core.tick();
    expect((await agent(e, v.id)).bond).toBe(e.cfg.min_bond.toString());
    e.clock.advance(2);
    e.core.tick();
    const done = await agent(e, v.id);
    expect(done.cooling).toBe(false);
    expect(done.bond).toBe("0");
    expect(done.wallet).toBe(e.cfg.min_bond.toString());
    await reconcileOk(e);
  });
});
