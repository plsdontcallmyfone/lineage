import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSwarm, newSoul, nextVersion, signSoul, type SoulDoc } from "@units/souls/doc";
import { persona, SEED } from "../../souls/test/fixtures.ts";
import { FakeClock } from "../src/clock.ts";
import { CoreClient } from "../src/client.ts";
import { Core } from "../src/core.ts";
import { serve } from "../src/http.ts";
import { RULES } from "../src/purge.ts";
import { generateAgentKey, signStatement, type AgentKey } from "../src/protocol.ts";
import { SESSION_LIMITS } from "../src/sessions.ts";
import { calibId, recipeId, signMessage } from "../src/protocol.ts";
import { CALIB, DEPS, expectOk, honest, makeVerifier, RECIPE, runReplays, submit, testConfig, type Env } from "./helpers.ts";

// Swarms in Core (docs/plans/SWARMS.md, swarms.ts): the soul's swarm block, the seat dimension of the
// per-agent limits, a seat's own rows, the seat a final candidate names, and that nothing changes
// for anyone while the flag is off.

const OPUS = { provider: "anthropic", id: "claude-opus-5-5" };
const HAIKU = { provider: "anthropic", id: "claude-haiku-4-5" };
const MINI = { provider: "openai", id: "gpt-5-mini" };

let closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers) c();
  closers = [];
});

/** A Core with a runtime authority, one unit and its verifiers; `swarms` sets the flag. */
async function world(swarms: boolean, over: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "units-swarms-test-"));
  const clock = new FakeClock();
  const adminKey = generateAgentKey();
  const runtimeKey = generateAgentKey();
  const cfg = testConfig({ features: { agent_pools: false, github_fee_claims: false, swarms }, ...over });
  const core = new Core({ dataDir: dir, network: cfg, adminId: adminKey.id, runtimeId: runtimeKey.id, clock });
  const server = serve(core, { port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  const admin = { key: adminKey, id: adminKey.id, c: new CoreClient(base, adminKey, () => clock.now()) };
  const b = { core, clock, server, base, admin, dir, cfg, anon: new CoreClient(base, null), close() { server.stop(true); core.close(); rmSync(dir, { recursive: true, force: true }); } };
  closers.push(() => b.close());
  await expectOk(admin.c.post("/v1/admin/recipes", { recipe: RECIPE, recipe_id: recipeId(RECIPE) }));
  await expectOk(admin.c.post("/v1/admin/snapshots", { repo: RECIPE.repo, commit: RECIPE.commit, deps_digest: DEPS }));
  const ref = await makeVerifier(b, { bond: 0n });
  await expectOk(admin.c.post(`/v1/admin/agents/${ref.id}/reference`, { reference: true }));
  const lin = await expectOk(ref.c.post("/v1/calibrations", { calibration: CALIB, sig: signMessage(ref.key, calibId(CALIB.recipe_id, CALIB.snapshot_id, CALIB)) }));
  const verifiers = [];
  for (let i = 0; i < 4; i++) verifiers.push(await makeVerifier(b));
  const env = { ...b, verifiers, reference: ref, lineage: lin.lineage_id as string, gen0: lin.gen0 as string } as unknown as Env;
  const runtime = new CoreClient(base, runtimeKey, () => clock.now());
  return { env, runtime, runtimeKey };
}

const soulOf = (k: AgentKey, models: { provider: string; id: string }[] | null, lead = 1): SoulDoc => ({
  ...newSoul({ agent: k.id, seed: SEED, persona: persona(), created_at: 1_790_000_000, origin: { by: "launcher", model: null, prompt_version: null } }),
  ...(models ? { model: models[0]!, swarm: buildSwarm(models.map((m, i) => ({ name: `Wren ${i + 1}`, model: m })), lead) } : {}),
});
const putSoul = (e: Env, k: AgentKey, doc: SoulDoc) => e.anon.request("PUT", `/v1/agents/${doc.agent}/soul`, { doc, sig: signSoul(k, doc) }, { sign: false });

/** A hosted launched agent, awake and funded; with `models` its soul declares that many seats. */
async function launch(e: Env, models: { provider: string; id: string }[] | null) {
  const k = generateAgentKey();
  const soul = soulOf(k, models);
  const stored = await putSoul(e, k, soul);
  await expectOk(e.admin.c.post("/v1/admin/launches", { agent: k.id, mint: generateAgentKey().id, launcher: generateAgentKey().id, target_repo: RECIPE.repo, hosted: true, identity_mode: "purchased" }));
  await expectOk(e.admin.c.post("/v1/admin/agent-fees", { agent: k.id, amount: ((e.cfg.wake_threshold * 10_000n) / BigInt(e.cfg.agent_compute_bps) + 1n).toString() }));
  const client = (seat?: number) => {
    const c = new CoreClient(e.base, k, () => e.clock.now());
    if (seat !== undefined) (c as { seat?: number }).seat = seat;
    return c;
  };
  return { key: k, id: k.id, c: client(), client, soul, stored };
}

const sessionBody = (e: Env) => ({ lineage_id: e.lineage, gen_id: e.gen0, commit: RECIPE.commit, proposer: "scripted" });
const intentBody = (e: Env, k: AgentKey, target: string, kind = "perf") => {
  const st = { v: 1, agent: k.id, lineage_id: e.lineage, tip: e.gen0, kind, target, finding_id: null, note: null, ttl_s: 600 };
  return { lineage_id: e.lineage, tip: e.gen0, kind, target, note: null, ttl_s: 600, sig: signStatement(k, "intent", st) };
};
const provenance = (e: Env, commit_id: string, agent: string, seat?: number) => ({
  v: 1, commit_id, agent, runtime: "hosted", models: ["claude-haiku-4-5"], proposer: { name: "p", version: "1" }, worker_version: "w", harness_digest: "a".repeat(64),
  recipe_id: recipeId(RECIPE), lineage_id: e.lineage, usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 }, spend: { usd: "0.01", amount: "1" }, sandbox_s: 1, started_at: 1, finished_at: 2,
  ...(seat !== undefined ? { seat } : {}),
});

describe("swarms: the flag is off", () => {
  test("no route, the block is an unknown field, the seat header is ignored and no table is made", async () => {
    const { env: e, runtime, runtimeKey } = await world(false);
    for (const p of ["/v1/swarms/config", "/v1/swarms", `/v1/agents/${generateAgentKey().id}/swarm`]) {
      const r = await e.anon.get(p);
      expect(r.status).toBe(404);
      expect(r.body.error).toBe("feature_off");
    }
    expect((await e.admin.c.post("/v1/admin/swarms/config", { max_members: 8 })).body.error).toBe("feature_off");
    // a soul with a swarm block is refused, a solo soul stored as ever
    const k = generateAgentKey();
    const bad = await putSoul(e, k, soulOf(k, [OPUS, HAIKU]));
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain("soul.swarm: unknown field");
    const a = await launch(e, null);
    expect(a.stored.status).toBe(200);
    // the header changes nothing: the fifth session is refused at the solo limit
    const seated = a.client(3);
    for (let i = 0; i < SESSION_LIMITS.live_sessions_per_agent; i++) await expectOk(seated.post("/v1/sessions", sessionBody(e)));
    expect((await seated.post("/v1/sessions", sessionBody(e))).body.error).toBe("too_many_sessions");
    // and a seat's heartbeat lands in the agent's own row
    await expectOk(seated.post("/v1/heartbeat", { job: "idle", at: e.clock.now() }));
    expect(JSON.stringify(await expectOk(e.anon.get("/v1/heartbeats")))).toContain(a.id);
    // a provenance record that names a seat is refused
    const c = await submit(e, { key: a.key, id: a.id, c: a.c }, "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,3 +1,3 @@\n fn a() {\n-    slow();\n+    fast();\n }\n");
    const rec = provenance(e, c.commit_id, a.id, 2);
    const r = await runtime.post(`/v1/candidates/${c.commit_id}/provenance`, { record: rec, sig: signStatement(runtimeKey, "provenance", rec) });
    expect(r.body.message).toContain("swarms are switched off");
    const tables = e.core.db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'swarm_%'").all();
    expect(tables).toEqual([]);
    // the config Core serves says so
    expect((await expectOk(e.anon.get("/v1/config"))).network.features.swarms).toBe(false);
  });
});

describe("swarms: the flag is on", () => {
  test("the soul's swarm block: size limit, priced models, fixed after the first version", async () => {
    const { env: e } = await world(true);
    const cfg = await expectOk(e.anon.get("/v1/swarms/config"));
    expect(cfg.settings.max_members).toBe(e.cfg.swarm.max_members);
    // the per-seat minimum is the network's own prepaid credits minimum, never a number of this module
    expect(cfg.min_usd_per_seat).toBe((e.cfg as any).prepay.min_usd);
    const k = generateAgentKey();
    const tooBig = await putSoul(e, k, soulOf(k, Array(e.cfg.swarm.max_members + 1).fill(HAIKU)));
    expect(tooBig.body.message).toContain("swarm.max_members");
    const unknownModel = await putSoul(e, k, soulOf(k, [OPUS, { provider: "anthropic", id: "no-such-model" }]));
    expect(unknownModel.status).toBe(400);
    const twoLeads = soulOf(k, [OPUS, HAIKU]);
    twoLeads.swarm!.members[1]!.role = "lead";
    expect((await putSoul(e, k, twoLeads)).body.message).toContain("exactly one lead");
    const a = await launch(e, [OPUS, HAIKU, MINI]);
    expect(a.stored.status).toBe(200);
    // a memory fold by the same key carries the block over; a changed or dropped block is refused
    const same = nextVersion(a.soul, { identity: { github_login: "goodone", ssh_signing_key: null, profile_url: null } }, 1_790_000_100);
    const changed = { ...same, swarm: buildSwarm([{ name: "Wren 1", model: OPUS }, { name: "Wren 2", model: OPUS }], 1) };
    expect((await putSoul(e, a.key, changed)).body.error).toBe("swarm_roster_fixed");
    const dropped = { ...same };
    delete (dropped as { swarm?: unknown }).swarm;
    expect((await putSoul(e, a.key, dropped)).body.error).toBe("swarm_roster_fixed");
    expect((await expectOk(putSoul(e, a.key, same))).seq).toBe(2);
    // a solo agent cannot grow seats with a later version either
    const solo = await launch(e, null);
    const grown = { ...nextVersion(solo.soul, {}, 1_790_000_100), model: OPUS, swarm: buildSwarm([{ name: "A 1", model: OPUS }, { name: "A 2", model: HAIKU }], 1) };
    expect((await putSoul(e, solo.key, grown)).body.error).toBe("swarm_roster_fixed");
    // the admin raises the size; the launch form reads it
    expect((await expectOk(e.admin.c.post("/v1/admin/swarms/config", { max_members: 6 }))).settings.max_members).toBe(6);
    const k6 = generateAgentKey();
    expect((await putSoul(e, k6, soulOf(k6, Array(6).fill(HAIKU)))).status).toBe(200);
    expect((await e.admin.c.post("/v1/admin/swarms/config", { max_members: 99 })).body.error).toBe("bad_swarm_settings");
  });

  test("per-agent limits count per seat for a swarm and are unchanged for a solo agent", async () => {
    const { env: e } = await world(true, { max_intents_per_agent: 1 });
    const swarm = await launch(e, Array(6 > e.cfg.swarm.max_members ? e.cfg.swarm.max_members : 6).fill(HAIKU));
    const solo = await launch(e, null);
    const seats = e.cfg.swarm.max_members;
    // sessions: max(4, seats)
    const cap = Math.max(SESSION_LIMITS.live_sessions_per_agent, seats);
    for (let i = 0; i < cap; i++) await expectOk(swarm.client((i % seats) + 1).post("/v1/sessions", sessionBody(e)));
    expect((await swarm.client(1).post("/v1/sessions", sessionBody(e))).body.error).toBe("too_many_sessions");
    // intents: one per seat here (max_intents_per_agent 1), one for the solo agent
    await expectOk(swarm.client(1).post("/v1/intents", intentBody(e, swarm.key, "ir")));
    e.clock.advance(5);
    await expectOk(swarm.client(2).post("/v1/intents", intentBody(e, swarm.key, "ns")));
    await expectOk(solo.c.post("/v1/intents", intentBody(e, solo.key, "ir")));
    e.clock.advance(5);
    expect((await solo.c.post("/v1/intents", intentBody(e, solo.key, "ns"))).body.error).toBe("too_many_intents");
  });

  test("a seat's heartbeat and session are its own; the view lists the seats", async () => {
    const { env: e, runtime } = await world(true);
    const a = await launch(e, [OPUS, HAIKU, MINI]);
    // seat 1 and seat 2 beat in the same second: neither is refused (one row each)
    await expectOk(a.client(1).post("/v1/heartbeat", { job: "author", phase: "propose", lineage_id: e.lineage, gen_id: e.gen0, at: e.clock.now() }));
    await expectOk(a.client(2).post("/v1/heartbeat", { job: "author", phase: "propose", lineage_id: e.lineage, gen_id: e.gen0, at: e.clock.now() }));
    expect((await a.client(2).post("/v1/heartbeat", { job: "idle", at: e.clock.now() })).body.error).toBe("too_frequent");
    expect((await a.client(2).post("/v1/heartbeat", { job: "replay", at: e.clock.now() })).status).toBe(400);
    const s2 = await expectOk(a.client(2).post("/v1/sessions", sessionBody(e)));
    // the runtime's statement about each seat
    const spend = { at: e.clock.now(), price: { source: "config", status: "test", usd_per_token: null, line_per_usd: "20", why: null }, provider_balance: { openrouter: null }, agents: {
      [a.id]: { vault: "100", vault_usd: 5, burn_per_h: null, burn_usd_per_h: null, burn_window_s: null, runway_h: null, model: OPUS, via: "openrouter", waiting: null,
        seats: [
          { seat: 1, state: "working", why: null, since: 1, unit: e.lineage, target: "perf ir", model: OPUS, via: "openrouter", desktop: { state: "running", why: null, since: 1, stream: "a".repeat(64), charged: false }, spend: { usd: 0.4, sandbox_s: 60, desktop_s: 0, desktop_usd: 0, attempts: 1, epochs: 1 } },
          { seat: 2, state: "paused", why: "Paused: vault low", since: 2, unit: null, target: null, model: HAIKU, via: "openrouter", desktop: { state: "paused", why: "vault low", since: 2, stream: null, charged: true }, spend: null },
          { seat: 9, state: "working" },
        ] } } };
    await expectOk(runtime.post("/v1/admin/runtime/spend", spend));
    const v = await expectOk(e.anon.get(`/v1/agents/${a.id}/swarm`));
    expect(v.size).toBe(3);
    expect(v.lead).toBe(1);
    expect(v.seats.map((s: any) => [s.seat, s.name, s.role, s.model.id])).toEqual([[1, "Wren 1", "lead", OPUS.id], [2, "Wren 2", "builder", HAIKU.id], [3, "Wren 3", "builder", MINI.id]]);
    expect(v.seats[0].runtime).toMatchObject({ state: "working", unit: e.lineage, target: "perf ir" });
    expect(v.seats[0].heartbeat).toMatchObject({ job: "author", awake: true });
    expect(v.seats[1].runtime).toMatchObject({ state: "paused", why: "Paused: vault low" });
    expect(v.seats[1].session.session_id).toBe(s2.session_id);
    expect(v.seats[2].runtime).toBeNull();
    expect(v.seats[2].last).toBeNull();
    const list = await expectOk(e.anon.get("/v1/swarms"));
    expect(list.swarms).toEqual([{ agent: a.id, size: 3, lead: 1, working: 1, stream: "a".repeat(64) }]);
    // a solo agent answers with no seats; it is not in the list
    const solo = await launch(e, null);
    expect(await expectOk<unknown>(e.anon.get(`/v1/agents/${solo.id}/swarm`))).toEqual({ agent: solo.id, size: 1, seats: null });
  });

  test("a candidate's seat rides in its provenance and is published only once the candidate is final", async () => {
    const { env: e, runtime, runtimeKey } = await world(true);
    const a = await launch(e, [OPUS, HAIKU]);
    const author = { key: a.key, id: a.id, c: a.c };
    const c = await submit(e, author, "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,3 +1,3 @@\n fn a() {\n-    slow();\n+    fast();\n }\n");
    const bad = provenance(e, c.commit_id, a.id, 3);
    expect((await runtime.post(`/v1/candidates/${c.commit_id}/provenance`, { record: bad, sig: signStatement(runtimeKey, "provenance", bad) })).body.message).toContain("not a seat");
    const rec = provenance(e, c.commit_id, a.id, 2);
    await expectOk(runtime.post(`/v1/candidates/${c.commit_id}/provenance`, { record: rec, sig: signStatement(runtimeKey, "provenance", rec) }));
    // open: nothing public names the seat
    expect((await e.anon.get(`/v1/candidates/${c.commit_id}/provenance`)).body.error).toBe("not_final");
    let v = await expectOk(e.anon.get(`/v1/agents/${a.id}/swarm`));
    expect(v.seats.every((s: any) => s.last === null && s.totals.final === 0)).toBe(true);
    await runReplays(e, c.candidate_id, honest());
    const done = await expectOk(e.anon.get(`/v1/candidates/${c.commit_id}`));
    expect(done.status).toBe("accepted");
    expect((await expectOk(e.anon.get(`/v1/candidates/${c.commit_id}/provenance`))).record.seat).toBe(2);
    v = await expectOk(e.anon.get(`/v1/agents/${a.id}/swarm`));
    expect(v.seats[1].last).toMatchObject({ commit_id: c.commit_id, status: "accepted", kind: "perf" });
    expect(v.seats[1].totals).toEqual({ final: 1, accepted: 1 });
    expect(v.record).toEqual([expect.objectContaining({ commit_id: c.commit_id, seat: 2, name: "Wren 2", model: "claude-haiku-4-5", kind: "perf" })]);
    expect(v.seats[0].last).toBeNull();
  });

  test("a list of launcher wallets: only a listed wallet's launch is a swarm, the form's answer is per wallet, the list is never published", async () => {
    const { env: e } = await world(true);
    const listed = generateAgentKey().id;
    const other = generateAgentKey().id;
    // no list: every wallet may
    const open = await expectOk(e.anon.get(`/v1/swarms/config?wallet=${other}`));
    expect(open.launch).toEqual({ restricted: false, open: true });
    expect(open.max_now).toBe(open.settings.max_members);
    expect((await e.admin.c.post("/v1/admin/swarms/config", { launchers: ["not a wallet"] })).body.error).toBe("bad_swarm_settings");
    expect((await e.admin.c.post("/v1/admin/swarms/config", { launchers: [listed, listed] })).body.error).toBe("bad_swarm_settings");
    const set = await expectOk(e.admin.c.post("/v1/admin/swarms/config", { launchers: [listed], max_members: 2 }));
    expect(set.launchers).toEqual([listed]);
    // the form's answer: open for the listed wallet, closed (size one) for any other and for none; the runtime's settings are in every answer
    const forListed = await expectOk(e.anon.get(`/v1/swarms/config?wallet=${listed}`));
    expect(forListed.launch).toEqual({ restricted: true, open: true });
    expect(forListed.max_now).toBe(2);
    for (const q of [`?wallet=${other}`, ""]) {
      const c = await expectOk(e.anon.get(`/v1/swarms/config${q}`));
      expect(c.launch).toEqual({ restricted: true, open: false });
      expect(c.max_now).toBe(1);
      expect(c.settings.max_members).toBe(2);
    }
    // the list is in no public answer
    for (const p of [`/v1/swarms/config?wallet=${other}`, "/v1/swarms/config", "/v1/config"]) expect(JSON.stringify(await expectOk(e.anon.get(p)))).not.toContain(listed);
    // a launch from each wallet with a two-seat soul stored first (Core has not read the launch yet, as with the launch form)
    const mk = async (launcher: string) => {
      const k = generateAgentKey();
      const soul = soulOf(k, [OPUS, HAIKU]);
      expect((await putSoul(e, k, soul)).status).toBe(200);
      await expectOk(e.admin.c.post("/v1/admin/launches", { agent: k.id, mint: generateAgentKey().id, launcher, target_repo: RECIPE.repo, hosted: true, identity_mode: "purchased" }));
      const c = new CoreClient(e.base, k, () => e.clock.now());
      (c as { seat?: number }).seat = 2;
      return { k, id: k.id, seat2: c };
    };
    const yes = await mk(listed);
    const no = await mk(other);
    expect((await expectOk(e.anon.get(`/v1/agents/${yes.id}/swarm`))).size).toBe(2);
    expect((await expectOk(e.anon.get(`/v1/agents/${no.id}/swarm`))) as unknown).toEqual({ agent: no.id, size: 1, seats: null });
    expect((await expectOk(e.anon.get("/v1/swarms"))).swarms.map((x: { agent: string }) => x.agent)).toEqual([yes.id]);
    // the other wallet's agent has a solo agent's limits, whatever seat its requests name
    for (let i = 0; i < SESSION_LIMITS.live_sessions_per_agent; i++) await expectOk(no.seat2.post("/v1/sessions", sessionBody(e)));
    expect((await no.seat2.post("/v1/sessions", sessionBody(e))).body.error).toBe("too_many_sessions");
    // once Core knows the launcher, a swarm soul for another wallet's agent is refused outright
    const late = generateAgentKey();
    await expectOk(e.admin.c.post("/v1/admin/launches", { agent: late.id, mint: generateAgentKey().id, launcher: other, target_repo: RECIPE.repo, hosted: true, identity_mode: "purchased" }));
    const refused = await putSoul(e, late, soulOf(late, [OPUS, HAIKU]));
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("swarm_not_open");
    expect((await putSoul(e, late, soulOf(late, null))).status).toBe(200);
    // the list removed: every wallet may, and the soul stored meanwhile is a swarm from then on
    expect((await expectOk(e.admin.c.post("/v1/admin/swarms/config", { launchers: null }))).launchers).toBeNull();
    expect((await expectOk(e.anon.get(`/v1/swarms/config?wallet=${other}`))).launch).toEqual({ restricted: false, open: true });
    expect((await expectOk(e.anon.get(`/v1/agents/${no.id}/swarm`))).size).toBe(2);
  });

  test("every swarm table is classified for a purge", () => {
    for (const t of ["swarm_settings", "swarm_sessions", "swarm_heartbeats", "swarm_seat_state"]) expect(RULES[t]).toBeDefined();
  });
});
