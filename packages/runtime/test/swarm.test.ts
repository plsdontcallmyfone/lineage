import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calibId, generateAgentKey, recipeId, signMessage, type AgentKey } from "@units/protocol";
import { buildSwarm, newSoul, signSoul } from "../../souls/src/doc.ts";
import { persona, SEED } from "../../souls/test/fixtures.ts";
import { FakeClock } from "../../core/src/clock.ts";
import { CoreClient } from "../../core/src/client.ts";
import { Core } from "../../core/src/core.ts";
import { serve } from "../../core/src/http.ts";
import { CALIB, DEPS, RECIPE, expectOk, makeVerifier, testConfig } from "../../core/test/helpers.ts";
import type { SeatUnitInput } from "../../worker/src/seat.ts";
import { streamIdOf, desktopKeyOf, seatOfDesktopKey } from "../../desktop/src/agent-desktops.ts";
import { costOf, parseConfig, resolvePrices, Runtime, SimBackend, type RuntimeConfig } from "../src/index.ts";
import { parseLeadPlan, parseSlotKey, slotKey, SwarmLedger, type LedgerState, type RosterSeat } from "../src/swarm.ts";
import { createHash } from "node:crypto";

// Swarms in the hosted runtime (docs/plans/SWARMS.md; src/swarm.ts): the ledger's placement rules,
// seat keys, the reserve rule that shrinks a swarm on a low vault, one usage record per swarm with
// its seats inside, and that a solo agent's runtime is what it was.

const tmp: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "units-swarm-rt-test-"));
  tmp.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

const U1 = "a".repeat(64);
const U2 = "b".repeat(64);
const unit = (id: string, targets: string[], open: string[] = [], read_at = Date.now()): SeatUnitInput => ({ unit: id, tip: "t".repeat(64), targets: targets.map((name) => ({ kind: "perf" as const, name, facts: "0 other agents have an open intent on it" })), open, read_at });
const ledger = (state: LedgerState = { units: {}, holds: {} }) => {
  return { l: new SwarmLedger(state, { now: () => Date.now(), save: () => {} }), state };
};

describe("seat keys", () => {
  test("seat 1 is the agent id itself; seat k adds a suffix a base58 id cannot hold", () => {
    const a = generateAgentKey().id;
    expect(slotKey(a, 1)).toBe(a);
    expect(slotKey(a, 3)).toBe(`${a}.s3`);
    expect(parseSlotKey(a)).toEqual({ agent: a, seat: 1 });
    expect(parseSlotKey(`${a}.s3`)).toEqual({ agent: a, seat: 3 });
    expect(desktopKeyOf(a, 2)).toBe(slotKey(a, 2));
    expect(seatOfDesktopKey(`${a}.s2`)).toEqual({ agent: a, seat: 2 });
    // stream ids: seat 1 keeps the solo id, seat k adds "\n" + k (docs/plans/SWARMS.md 6)
    const h = (s: string) => createHash("sha256").update(s).digest("hex");
    expect(streamIdOf(a)).toBe(h(`units-desktop-stream\n${a}`));
    expect(streamIdOf(slotKey(a, 1))).toBe(streamIdOf(a));
    expect(streamIdOf(slotKey(a, 2))).toBe(h(`units-desktop-stream\n${a}\n2`));
  });
});

describe("the swarm ledger", () => {
  test("units first, one seat per target, a target is held until its candidate is final", () => {
    const { l } = ledger();
    const units = () => [unit(U1, ["encode", "decode"]), unit(U2, ["encode_heavy", "decode_heavy"])];
    const p1 = l.place(1, units(), 3);
    const p2 = l.place(2, units(), 3);
    const p3 = l.place(3, units(), 3);
    if (!p1.ok || !p2.ok || !p3.ok) throw new Error("placement refused");
    // two units, three seats: the first two take different units, the third a second target on one of them
    expect(new Set([p1.p.unit, p2.p.unit]).size).toBe(2);
    const targets = [p1, p2, p3].map((p) => `${p.p.unit}:${p.p.planned.target}`);
    expect(new Set(targets).size).toBe(3);
    expect(p3.p.planned.target).not.toBe(p1.p.unit === p3.p.unit ? p1.p.planned.target : p2.p.planned.target);
    expect(l.activeOf(1)).toMatchObject({ unit: p1.p.unit, target: `perf ${p1.p.planned.target}` });
    // seat 1 ends without a candidate: its target is free again
    l.ended(1, null);
    expect(l.activeOf(1)).toBeNull();
    const again = l.place(1, units(), 3);
    expect(again.ok && again.p.unit === p1.p.unit && again.p.planned.target === p1.p.planned.target).toBe(true);
  });

  test("one stack per unit: a later seat builds on every open candidate and depends on the newest; commits are serialized", async () => {
    const { l } = ledger();
    const one = (open: string[] = []) => [unit(U1, ["encode", "decode", "size"], open)];
    const p1 = l.place(1, one(), 3);
    const p2 = l.place(2, one(), 3);
    if (!p1.ok || !p2.ok) throw new Error("placement refused");
    expect(p1.p.stack).toBeNull();
    expect(p2.p.stack).toBeNull(); // nothing open yet: both started from the tip
    const order: string[] = [];
    // both commit at once: the second sees the first in the stack when its turn comes
    const c1 = l.commit(1, U1, async (io) => {
      order.push("1 in");
      await Bun.sleep(20);
      expect(io.stack(["x".repeat(64)], Date.now())).toBeNull();
      io.committed("c1".padEnd(64, "0"), "patch one");
      order.push("1 out");
    });
    const c2 = l.commit(2, U1, async (io) => {
      order.push("2 in");
      const s = io.stack(["c1".padEnd(64, "0")], Date.now());
      expect(s).toEqual({ commit_id: "c1".padEnd(64, "0"), patches: ["patch one"] });
      io.committed("c2".padEnd(64, "0"), "patch two");
    });
    await Promise.all([c1, c2]);
    expect(order).toEqual(["1 in", "1 out", "2 in"]);
    l.ended(1, "c1".padEnd(64, "0"));
    l.ended(2, "c2".padEnd(64, "0"));
    // a third seat is stacked on both, and cannot take either held target
    const open = ["c1".padEnd(64, "0"), "c2".padEnd(64, "0")];
    const p3 = l.place(3, one(open), 3);
    if (!p3.ok) throw new Error("placement refused");
    expect(p3.p.planned.target).toBe("size");
    expect(p3.p.stack).toEqual({ commit_id: "c2".padEnd(64, "0"), patches: ["patch one", "patch two"] });
    // with three open or in work on the unit the swarm waits there (max_open_candidates_per_agent)
    expect(l.place(1, one(open), 3)).toEqual({ ok: false, why: "Waiting for verdicts" });
    // c1 becomes final: Core no longer lists it, its target is free and the stack is c2 alone
    l.ended(3, null);
    const after = l.place(1, one(["c2".padEnd(64, "0")]), 3);
    if (!after.ok) throw new Error("placement refused");
    expect(after.p.planned.target).toBe(p1.p.planned.target);
    expect(after.p.stack).toEqual({ commit_id: "c2".padEnd(64, "0"), patches: ["patch two"] });
  });

  test("a listing read before a commit does not drop that commit; the ledger survives a restart", async () => {
    const st: LedgerState = { units: {}, holds: {} };
    const { l } = ledger(st);
    const p = l.place(1, [unit(U1, ["encode", "decode"])], 3);
    if (!p.ok) throw new Error("placement refused");
    const stale = Date.now() - 1;
    await Bun.sleep(3);
    await l.commit(1, U1, async (io) => io.committed("c9".padEnd(64, "0"), "patch nine"));
    l.ended(1, "c9".padEnd(64, "0"));
    // seat 2's listing was read before c9 existed: c9 stays in the stack
    const p2 = l.place(2, [unit(U1, ["encode", "decode"], [], stale)], 3);
    expect(p2.ok && p2.p.stack?.commit_id).toBe("c9".padEnd(64, "0"));
    l.ended(2, null);
    // restart: open candidates and their holds are kept, a hold without a candidate is not
    const { l: l2 } = ledger(JSON.parse(JSON.stringify(st)));
    expect(l2.openBy()[U1]!.map((c) => c.commit_id)).toEqual(["c9".padEnd(64, "0")]);
    const p3 = l2.place(3, [unit(U1, ["encode", "decode"], ["c9".padEnd(64, "0")])], 3);
    expect(p3.ok && p3.p.planned.target).toBe(p.p.planned.target === "encode" ? "decode" : "encode");
  });

  test("retarget: a change on another target stands only when no other seat holds it", () => {
    const { l } = ledger();
    const p1 = l.place(1, [unit(U1, ["encode", "decode", "size"])], 3);
    const p2 = l.place(2, [unit(U1, ["encode", "decode", "size"])], 3);
    if (!p1.ok || !p2.ok) throw new Error("placement refused");
    expect(l.retarget(1, U1, "perf", p2.p.planned.target as string)).toBe(false);
    const free = ["encode", "decode", "size"].find((t) => t !== p1.p.planned.target && t !== p2.p.planned.target)!;
    expect(l.retarget(1, U1, "perf", free)).toBe(true);
    // its first target is free for the next seat
    const p3 = l.place(3, [unit(U1, ["encode", "decode", "size"])], 3);
    expect(p3.ok && p3.p.planned.target).toBe(p1.p.planned.target);
  });

  test("the lead's plan is followed while it is possible, and only then", () => {
    const { l } = ledger();
    const roster: RosterSeat[] = [1, 2, 3].map((seat) => ({ seat, name: `S ${seat}`, role: seat === 1 ? "lead" : "builder", model: { provider: "anthropic", id: "claude-haiku-4-5" } }));
    const units = () => [unit(U1, ["encode", "decode"]), unit(U2, ["encode_heavy"])];
    l.place(1, units(), 3);
    l.ended(1, null);
    const text = `Here is the plan.\n{"assignments":[{"seat":2,"unit":"${U2.slice(0, 10)}","kind":"perf","target":"encode_heavy","brief":"Look at the inner loop.\\nKeep the output identical.\\nA third line."},{"seat":3,"unit":"${U2.slice(0, 10)}","kind":"perf","target":"encode_heavy","brief":"dup"},{"seat":9,"unit":"${U1.slice(0, 10)}","kind":"perf","target":"encode"},{"seat":1,"unit":"${U1.slice(0, 10)}","kind":"perf","target":"nope"}]}`;
    const plan = parseLeadPlan(text, roster, l.known, 5);
    // one seat per target, known seats and targets only, a brief of at most two lines
    expect(plan).toEqual({ at: 5, seats: { 2: { unit: U2, kind: "perf", target: "encode_heavy", brief: "Look at the inner loop.\nKeep the output identical." } } });
    expect(parseLeadPlan("no json here", roster, l.known, 5)).toBeNull();
    l.setPlan(plan);
    const p2 = l.place(2, units(), 3);
    expect(p2.ok && [p2.p.unit, p2.p.planned.target, p2.p.brief]).toEqual([U2, "encode_heavy", "Look at the inner loop.\nKeep the output identical."]);
    // the same assignment for another seat is no longer possible: it is placed from the ledger alone
    l.setPlan({ at: 6, seats: { 3: { unit: U2, kind: "perf", target: "encode_heavy", brief: null } } });
    const p3 = l.place(3, units(), 3);
    expect(p3.ok && p3.p.unit).toBe(U1);
  });
});

// ------------------------------------------------------------------------------------------------
// the runtime against a simulated Core

const OPUS = { provider: "anthropic", id: "claude-opus-5-5" };
const HAIKU = { provider: "anthropic", id: "claude-haiku-4-5" };

async function world(swarms: boolean) {
  const dir = scratch();
  const clock = new FakeClock(Date.now());
  const adminKey = generateAgentKey();
  const runtimeKey = generateAgentKey();
  const cfg = testConfig({ features: { agent_pools: false, github_fee_claims: false, swarms } });
  const core = new Core({ dataDir: dir, network: cfg, adminId: adminKey.id, runtimeId: runtimeKey.id, clock });
  const server = serve(core, { port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  const admin = { key: adminKey, id: adminKey.id, c: new CoreClient(base, adminKey, () => clock.now()) };
  const b = { core, clock, server, base, admin, dir, cfg, anon: new CoreClient(base, null), close: () => (server.stop(true), core.close()) };
  await expectOk(admin.c.post("/v1/admin/recipes", { recipe: RECIPE, recipe_id: recipeId(RECIPE) }));
  await expectOk(admin.c.post("/v1/admin/snapshots", { repo: RECIPE.repo, commit: RECIPE.commit, deps_digest: DEPS }));
  const ref = await makeVerifier(b, { bond: 0n });
  await expectOk(admin.c.post(`/v1/admin/agents/${ref.id}/reference`, { reference: true }));
  await expectOk(ref.c.post("/v1/calibrations", { calibration: CALIB, sig: signMessage(ref.key, calibId(CALIB.recipe_id, CALIB.snapshot_id, CALIB)) }));
  return { ...b, runtimeKey };
}

async function launch(e: Awaited<ReturnType<typeof world>>, models: { provider: string; id: string }[] | null, fees: bigint) {
  const k: AgentKey = generateAgentKey();
  const doc = { ...newSoul({ agent: k.id, seed: SEED, persona: persona(), created_at: 1_790_000_000, origin: { by: "launcher" as const, model: null, prompt_version: null } }), ...(models ? { model: models[0]!, swarm: buildSwarm(models.map((m, i) => ({ name: `Wren ${i + 1}`, model: m })), 1) } : {}) };
  await expectOk(e.anon.request("PUT", `/v1/agents/${k.id}/soul`, { doc, sig: signSoul(k, doc) }, { sign: false }));
  await expectOk(e.admin.c.post("/v1/admin/launches", { agent: k.id, mint: generateAgentKey().id, launcher: generateAgentKey().id, target_repo: RECIPE.repo, hosted: true, identity_mode: "purchased" }));
  await expectOk(e.admin.c.post("/v1/admin/agent-fees", { agent: k.id, amount: fees.toString() }));
  return { key: k, id: k.id, c: new CoreClient(e.base, k, () => e.clock.now()) };
}

const rtConfig = (e: { base: string }, over: Partial<RuntimeConfig> = {}) =>
  parseConfig({ mode: "sim", core: e.base, state_dir: scratch(), runtime_key: "unused-in-tests", compute_price_line_per_usd: "4", compute_price_line_per_sandbox_s: "0.001", poll_ms: 10, sandbox_reserve_s: 100, attempt_gap_s: 0, max_concurrent: 8, ...over });

async function bind(rt: Runtime, cfg: RuntimeConfig, a: { id: string; c: CoreClient }) {
  await rt.tick();
  const req = JSON.parse(readFileSync(join(cfg.state_dir, "bind-requests", `${a.id}.json`), "utf8"));
  await expectOk(a.c.post(`/v1/agents/${a.id}/keys/rotate`, req.body));
  await rt.tick();
}

describe("the runtime and swarms", () => {
  test("Core's flag off: no roster, no ledger, no seat in any record; a solo agent is what it was", async () => {
    const e = await world(false);
    try {
      const unit = 10n ** BigInt(e.cfg.token_decimals);
      const a = await launch(e, null, 100n * unit);
      const cfg = rtConfig(e);
      const seen: (number | undefined)[] = [];
      const rt = new Runtime(cfg, { backend: new SimBackend(e.base, e.runtimeKey), runtimeKey: e.runtimeKey, proposer: (_agent, seat) => (seen.push(seat), { name: "none", propose: async () => null }), log: () => {}, telemetry: false });
      await rt.start();
      await bind(rt, cfg, a);
      expect(rt.seatsOf(a.id)).toBeNull();
      expect(rt.seatsFunded(a.id)).toBe(1);
      await rt.tick();
      await rt.idle();
      // the proposer was asked for the agent alone (no seat), the report has no seats, the state no ledger
      expect(seen.every((s) => s === undefined)).toBe(true);
      const report = rt.spendReport();
      expect(report.agents[a.id]!.seats).toBeUndefined();
      expect(rt.state.swarms).toBeUndefined();
      expect(Object.keys(rt.state.open.usage[a.id] ?? {})).not.toContain("seats");
      await rt.stop({ flush: false });
    } finally {
      e.close();
    }
  }, 60_000);

  test("a swarm: one worker per seat with its own model, reservations on the one vault, a low vault shrinks it, one usage record with the seats inside", async () => {
    const e = await world(true);
    try {
      const cfg = rtConfig(e);
      const prices = resolvePrices(cfg, e.cfg.token_decimals);
      const one = costOf(prices, cfg.attempt_max_usd, cfg.sandbox_reserve_s); // one seat's full reservation
      // the vault receives agent_compute_bps of the fees: fund it for a little over two full reservations
      const fees = ((one * 5n) / 2n * 10_000n) / BigInt(e.cfg.agent_compute_bps) + e.cfg.wake_threshold;
      const a = await launch(e, [OPUS, HAIKU, HAIKU], fees);
      const solo = await launch(e, null, fees);
      const asked: string[] = [];
      const logs: string[] = [];
      const rt = new Runtime(cfg, {
        backend: new SimBackend(e.base, e.runtimeKey), runtimeKey: e.runtimeKey, log: (m) => logs.push(m), telemetry: false,
        proposer: (agent, seat) => (asked.push(`${agent === a.id ? "swarm" : "solo"}:${seat ?? "-"}`), { name: "none", propose: async () => null }),
        route: async (_agent, seat) => ({ via: "openrouter", model: seat === undefined || seat === 1 ? OPUS : HAIKU, why: null, rate: null }),
      });
      await rt.start();
      await bind(rt, cfg, a);
      await bind(rt, cfg, solo);
      expect(rt.seatsOf(a.id)!.map((s) => [s.seat, s.role, s.model.id])).toEqual([[1, "lead", OPUS.id], [2, "builder", HAIKU.id], [3, "builder", HAIKU.id]]);
      expect(rt.seatsOf(solo.id)).toBeNull();
      const bal = BigInt((await expectOk(e.anon.get(`/v1/agents/${a.id}`))).compute);
      expect(rt.seatsFunded(a.id)).toBe(Number(bal / one));
      expect(rt.seatsFunded(a.id)).toBe(2);
      await rt.tick();
      await rt.idle();
      // each seat has its own worker and proposer; the solo agent's is asked without a seat
      expect(asked.filter((x) => x.startsWith("swarm")).sort()).toEqual(["swarm:1", "swarm:2"]);
      expect(asked).toContain("solo:-");
      expect(logs.some((l) => l.includes("s3 paused: the vault carries 2 of 3 seats now"))).toBe(true);
      const report = rt.spendReport();
      const seats = report.agents[a.id]!.seats!;
      expect(seats.map((s) => [s.seat, s.state, s.model?.id])).toEqual([[1, "waiting", OPUS.id], [2, "waiting", HAIKU.id], [3, "paused", HAIKU.id]]);
      expect(seats[2]!.why).toBe("Paused: vault low");
      expect(report.agents[solo.id]!.seats).toBeUndefined();
      // more fees: the third seat is carried again
      await expectOk(e.admin.c.post("/v1/admin/agent-fees", { agent: a.id, amount: ((one * 2n) * 10_000n / BigInt(e.cfg.agent_compute_bps)).toString() }));
      await rt.tick();
      expect(rt.seatsFunded(a.id)).toBe(3);
      await rt.idle();
      expect(asked).toContain("swarm:3");
      // usage metered under two seats and a screen charge for seat 2: one record for the swarm, the seats inside it
      rt.state.open.usage[a.id] = { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0, usd: 0.5, sandbox_s: 30, models: [OPUS.id, HAIKU.id], attempts: 2, candidates: [], desktop_usd: 0.05, desktop_s: 1087,
        seats: { 1: { usd: 0.4, sandbox_s: 20, attempts: 1, desktop_s: 0, desktop_usd: 0 }, 2: { usd: 0.1, sandbox_s: 10, attempts: 1, desktop_s: 1087, desktop_usd: 0.05 } } };
      rt.store.save();
      const before = BigInt((await expectOk(e.anon.get(`/v1/agents/${a.id}`))).compute);
      await rt.flush();
      const usage = await expectOk(e.anon.get(`/v1/agents/${a.id}/usage`));
      expect(usage.records.length).toBe(1);
      const cost = costOf(prices, 0.5 + 0.05, 30);
      expect(usage.records[0].amount).toBe(cost.toString());
      expect(BigInt((await expectOk(e.anon.get(`/v1/agents/${a.id}`))).compute)).toBe(before - cost);
      // the seats' lines add up to the one debit: nothing counted twice, nothing left out
      const d = usage.records[0].detail;
      const sum = Object.values(d.seats as Record<string, { usd: number; sandbox_s: number; desktop_usd: number }>).reduce((x, s) => ({ usd: x.usd + s.usd, sandbox_s: x.sandbox_s + s.sandbox_s, desktop_usd: x.desktop_usd + s.desktop_usd }), { usd: 0, sandbox_s: 0, desktop_usd: 0 });
      expect(costOf(prices, sum.usd + sum.desktop_usd, sum.sandbox_s)).toBe(cost);
      expect(rt.spendReport().agents[a.id]!.seats![1]!.spend).toMatchObject({ usd: 0.1, sandbox_s: 10, desktop_usd: 0.05, epochs: 1 });
      // Core takes the seat part of the report
      await expectOk(new CoreClient(e.base, e.runtimeKey).post("/v1/admin/runtime/spend", rt.spendReport()));
      const view = await expectOk(e.anon.get(`/v1/agents/${a.id}/swarm`));
      expect(view.seats[1].runtime.spend).toMatchObject({ usd: 0.1, desktop_usd: 0.05 });
      await rt.stop({ flush: false });
    } finally {
      e.close();
    }
  }, 60_000);

  test("Core's list of launcher wallets: an agent of another wallet runs solo whatever its soul declares, and as a swarm once the list is gone", async () => {
    const e = await world(true);
    try {
      const unit = 10n ** BigInt(e.cfg.token_decimals);
      const listed = generateAgentKey().id;
      await expectOk(e.admin.c.post("/v1/admin/swarms/config", { launchers: [listed] }));
      const mk = async (launcher: string) => {
        const k: AgentKey = generateAgentKey();
        const doc = { ...newSoul({ agent: k.id, seed: SEED, persona: persona(), created_at: 1_790_000_000, origin: { by: "launcher" as const, model: null, prompt_version: null } }), model: OPUS, swarm: buildSwarm([{ name: "W 1", model: OPUS }, { name: "W 2", model: HAIKU }], 1) };
        await expectOk(e.anon.request("PUT", `/v1/agents/${k.id}/soul`, { doc, sig: signSoul(k, doc) }, { sign: false }));
        await expectOk(e.admin.c.post("/v1/admin/launches", { agent: k.id, mint: generateAgentKey().id, launcher, target_repo: RECIPE.repo, hosted: true, identity_mode: "purchased" }));
        await expectOk(e.admin.c.post("/v1/admin/agent-fees", { agent: k.id, amount: (100n * unit).toString() }));
        return { key: k, id: k.id, c: new CoreClient(e.base, k, () => e.clock.now()) };
      };
      const yes = await mk(listed);
      const no = await mk(generateAgentKey().id);
      const cfg = rtConfig(e);
      const asked: string[] = [];
      const logs: string[] = [];
      let now = Date.now();
      const rt = new Runtime(cfg, {
        backend: new SimBackend(e.base, e.runtimeKey), runtimeKey: e.runtimeKey, log: (m) => logs.push(m), telemetry: false, now: () => now,
        proposer: (agent, seat) => (asked.push(`${agent === yes.id ? "yes" : "no"}:${seat ?? "-"}`), { name: "none", propose: async () => null }),
        route: async (_agent, seat) => ({ via: "openrouter", model: seat === undefined || seat === 1 ? OPUS : HAIKU, why: null, rate: null }),
      });
      await rt.start();
      await bind(rt, cfg, yes);
      await bind(rt, cfg, no);
      expect(rt.seatsOf(yes.id)!.length).toBe(2);
      expect(rt.seatsOf(no.id)).toBeNull();
      expect(logs.filter((l) => l.includes("Core lists it as one agent; it runs solo")).length).toBe(1);
      await rt.tick();
      await rt.idle();
      expect(asked.filter((x) => x.startsWith("yes")).sort()).toEqual(["yes:1", "yes:2"]);
      expect(asked.filter((x) => x.startsWith("no"))).toEqual(["no:-"]);
      expect(rt.spendReport().agents[no.id]!.seats).toBeUndefined();
      // the list removed: the runtime follows Core within its next roster read
      await expectOk(e.admin.c.post("/v1/admin/swarms/config", { launchers: null }));
      now += 61_000;
      await rt.tick();
      expect(rt.seatsOf(no.id)!.length).toBe(2);
      await rt.idle();
      await rt.stop({ flush: false });
    } finally {
      e.close();
    }
  }, 60_000);
});
