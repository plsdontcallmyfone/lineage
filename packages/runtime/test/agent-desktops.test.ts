import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey } from "@units/protocol";
import { streamIdOf } from "../../desktop/src/agent-desktops.ts";
import { E2BBackend, e2bUsdPerS } from "../../desktop/src/e2b.ts";
import { FakeE2B } from "../../desktop/test/fake-e2b.ts";
import { parseConfig, Runtime, type Backend } from "../src/index.ts";
import { desktopOwner, desktopPool } from "../src/desktops.ts";

// One E2B desktop per agent in the hosted runtime (owner decision 2026-10-12, desktop_mode per_agent):
// binding an agent starts its desktop in the background (the tick does not wait on E2B), the spend
// report carries its state, an unbound or vanished agent's desktop is removed, and two runtimes on
// one server share one E2B day budget.

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});
const scratch = (p = "units-rt-agentdesk-") => {
  const d = mkdtempSync(join(tmpdir(), p));
  tmp.push(d);
  return d;
};
const T0 = Date.UTC(2026, 9, 12, 12);
const RATE = e2bUsdPerS(2, 4);

function setup(over: Record<string, unknown> = {}) {
  const dir = scratch();
  const clock = { t: T0 };
  const e2b = new FakeE2B(() => clock.t);
  const lines: string[] = [];
  const log = (m: string) => lines.push(m);
  // no attempts in these tests (max_candidates_per_agent 0): only the desktops' own life
  const cfg = parseConfig({ mode: "sim", core: "http://127.0.0.1:9", runtime_key: "k", state_dir: dir, compute_price_line_per_usd: "1", compute_price_line_per_sandbox_s: "0", attempt_max_usd: 1, sandbox_reserve_s: 0, min_attempt_usd: 0.05, max_candidates_per_agent: 0, desktops_max: 0, e2b_max: 100, desktop_usd_per_day: 50, desktop_mode: "per_agent", e2b: { template: "lineage-desktop", vcpu: 2, ram_gib: 4, session_max_s: 86400 }, ...over });
  const pool = desktopPool(cfg, log, { e2b: new E2BBackend({ root: join(dir, "desktops"), key: "k", vcpu: 2, ram_gib: 4, api: e2b }), now: () => clock.t, timers: false })!;
  const world = { hosted: [] as string[], signing: new Map<string, string | null>(), awake: true };
  const backend: Backend = {
    mode: "sim",
    init: async () => ({ decimals: 6, sleepThreshold: 0n, wakeThreshold: 0n, maxDebitPerEpoch: null }),
    discover: async () => world.hosted.map((agent) => ({ agent, mint: null, launcher: null, target_repo: null })),
    signingKey: async (a) => world.signing.get(a) ?? null,
    vault: async () => ({ balance: 5_000_000n, awake: world.awake }),
    bindRequest: async () => ({}),
    nextEpoch: async (n) => ({ epoch: n, earliestS: 0 }),
    post: async () => {},
    refreshAwake: async () => false,
  };
  const rt = new Runtime(cfg, { backend, runtimeKey: generateAgentKey(), proposer: () => ({ name: "none", propose: async () => null }), log, telemetry: false, now: () => clock.t, desktop: pool });
  /** the owner binds the agent: its signing key becomes the runtime's key for it */
  const bind = (agent: string) => world.signing.set(agent, (rt.state.agents[agent] as { key_id: string }).key_id);
  return { rt, pool, e2b, clock, lines, world, bind, cfg, dir };
}

describe("per-agent desktops in the runtime", () => {
  test("binding starts the agent's desktop in the background; the tick does not wait on E2B; the spend report says its state", async () => {
    const s = setup();
    await s.rt.start();
    await s.pool.agents!.settle();
    const a = generateAgentKey().id;
    s.world.hosted = [a];
    await s.rt.tick();
    // discovered, not bound: no desktop yet
    expect(s.e2b.boxes.size).toBe(0);
    s.bind(a);
    // E2B is slow: its create does not return until we let it
    let letGo!: () => void;
    s.e2b.gate = new Promise((r) => (letGo = r));
    const t = performance.now();
    await s.rt.tick();
    expect(performance.now() - t).toBeLessThan(500);
    expect(s.rt.state.agents[a]!.status).toBe("bound");
    expect(s.e2b.boxes.size).toBe(0);
    await Bun.sleep(2);
    expect(s.rt.spendReport().agents[a]!.desktop).toMatchObject({ state: "starting" });
    letGo();
    await s.pool.agents!.settle();
    expect(s.e2b.ofAgent(a)).toHaveLength(1);
    expect(s.e2b.ofAgent(a)[0]!.metadata).toEqual({ units_desktop: "agent", owner: desktopOwner(s.cfg), agent: a });
    // its state, and the id its live stream is served under while it runs
    expect(s.rt.spendReport().agents[a]!.desktop).toEqual({ state: "running", why: null, since: T0, stream: streamIdOf(a) });
    expect(s.rt.spendReport().desktops!.masked).toBe(true);
    expect(s.rt.spendReport().desktops!.e2b).toMatchObject({ running: 1, max: 100 });
    // more ticks: still the one sandbox
    await s.rt.tick();
    await s.rt.tick();
    await s.pool.agents!.settle();
    expect(s.e2b.count("create")).toBe(1);
    await s.rt.stop({ flush: false });
    s.pool.stop();
  });

  test("E2B down at launch: the agent is bound and works as before, its desktop state says why", async () => {
    const s = setup();
    await s.rt.start();
    await s.pool.agents!.settle();
    const a = generateAgentKey().id;
    s.world.hosted = [a];
    await s.rt.tick();
    s.bind(a);
    s.e2b.failCreate = "connect ECONNREFUSED";
    await s.rt.tick();
    await s.pool.agents!.settle();
    expect(s.rt.state.agents[a]!.status).toBe("bound");
    const d = s.rt.spendReport().agents[a]!.desktop!;
    expect(d.state).toBe("none");
    // the page gets the reason without the service's own error text
    expect(d.why).toBe("create failed; next try in 30 s");
    await s.rt.stop({ flush: false });
    s.pool.stop();
  });

  test("asleep: paused at once. Unbound, or gone from the chain: paused, then removed after the grace time. A failed read removes nothing", async () => {
    const s = setup({ desktop_remove_after_s: 300 });
    await s.rt.start();
    await s.pool.agents!.settle();
    const [a, b, c] = [generateAgentKey().id, generateAgentKey().id, generateAgentKey().id];
    s.world.hosted = [a, b, c];
    await s.rt.tick();
    for (const x of [a, b, c]) s.bind(x);
    await s.rt.tick();
    await s.pool.agents!.settle();
    expect(s.e2b.running()).toBe(3);
    // every vault empties: the desktops are paused, not removed
    s.world.awake = false;
    await s.rt.tick();
    await s.pool.agents!.settle();
    expect(s.e2b.running()).toBe(0);
    expect(s.e2b.boxes.size).toBe(3);
    expect(s.rt.spendReport().agents[a]!.desktop).toMatchObject({ state: "paused", why: "agent asleep (vault empty)" });
    s.world.awake = true;
    // the chain cannot be read for an hour: nothing is removed
    const discover = s.world.hosted;
    const signing = new Map(s.world.signing);
    s.world.signing = { get: () => { throw new Error("rpc 429"); } } as never;
    s.clock.t += 3_600_000;
    await s.rt.tick();
    s.pool.agents!.maintain();
    await s.pool.agents!.settle();
    expect(s.e2b.boxes.size).toBe(3);
    s.world.signing = signing;
    // a's owner moves its signing key away; c is not a hosted agent any more
    s.world.signing.set(a, "someone-else");
    s.world.hosted = discover.filter((x) => x !== c);
    await s.rt.tick();
    await s.pool.agents!.settle();
    expect(s.rt.state.agents[a]!.status).toBe("unbound");
    expect(s.e2b.boxes.size).toBe(3);
    s.clock.t += 301_000;
    await s.rt.tick();
    await s.pool.agents!.settle();
    expect(s.e2b.ofAgent(a)).toHaveLength(0);
    expect(s.e2b.ofAgent(c)).toHaveLength(0);
    expect(s.e2b.ofAgent(b)).toHaveLength(1);
    await s.rt.stop({ flush: false });
    s.pool.stop();
  });

  test("an awake agent whose vault cannot pay for an attempt: its desktop rests, with that reason; with desktop_idle_pause false an agent that can work keeps its desktop", async () => {
    const s = setup({ desktop_idle_pause: false, desktop_idle_s: 60 });
    await s.rt.start();
    await s.pool.agents!.settle();
    const [a, b] = [generateAgentKey().id, generateAgentKey().id];
    s.world.hosted = [a, b];
    await s.rt.tick();
    s.bind(a);
    s.bind(b);
    await s.rt.tick();
    await s.pool.agents!.settle();
    // an hour of waiting for a turn: both still running
    for (let i = 0; i < 12; i++) {
      s.clock.t += 300_000;
      await s.rt.tick();
      await s.pool.agents!.settle();
    }
    expect(s.e2b.running()).toBe(2);
    // a's vault can no longer pay (the runtime marks it exhausted)
    (s.rt as unknown as { exhausted: Set<string>; budget: (x: string) => unknown }).exhausted.add(a);
    (s.rt as unknown as { budget: (x: string) => unknown }).budget = () => ({ usd: null, why: "compute vault exhausted", vault: true });
    await s.rt.tick();
    await s.pool.agents!.settle();
    expect(s.rt.spendReport().agents[a]!.desktop).toMatchObject({ state: "paused", why: "agent cannot pay for an attempt (vault low)", stream: null });
    await s.rt.stop({ flush: false });
    s.pool.stop();
  });

  test("a restarted runtime takes its agents' desktops back: same sandbox ids, no new sandbox", async () => {
    const s = setup();
    await s.rt.start();
    await s.pool.agents!.settle();
    const ids = [generateAgentKey().id, generateAgentKey().id, generateAgentKey().id];
    s.world.hosted = ids;
    await s.rt.tick();
    ids.forEach(s.bind);
    await s.rt.tick();
    await s.pool.agents!.settle();
    const before = ids.map((a) => s.pool.agents!.sandboxOf(a));
    await s.rt.stop({ flush: false });
    s.pool.stop();
    // the same state directory, the same E2B account
    const log: string[] = [];
    const pool2 = desktopPool(s.cfg, (m) => log.push(m), { e2b: new E2BBackend({ root: join(s.dir, "desktops"), key: "k", api: s.e2b }), now: () => s.clock.t, timers: false })!;
    await pool2.agents!.settle();
    pool2.syncAgents(ids.map((agent) => ({ agent, working: false, asleep: false })));
    await pool2.agents!.settle();
    expect(ids.map((a) => pool2.agents!.sandboxOf(a))).toEqual(before);
    expect(s.e2b.count("create")).toBe(3);
    expect(log.filter((l) => l.includes("has its desktop")).length).toBe(3);
    pool2.stop();
  });
});

describe("config", () => {
  const base = { mode: "sim", core: "http://127.0.0.1:9", runtime_key: "k", state_dir: "/tmp/x", compute_price_line_per_usd: "1", compute_price_line_per_sandbox_s: "0", attempt_max_usd: 1, sandbox_reserve_s: 0, min_attempt_usd: 0.05 };
  test("per_attempt is the default; every limit is a setting", () => {
    expect(parseConfig(base).desktop_mode).toBeUndefined();
    const dir = scratch();
    const p = desktopPool(parseConfig({ ...base, state_dir: dir, e2b_max: 2 }), () => {}, { timers: false, e2b: new E2BBackend({ root: dir, key: null }) })!;
    expect(p.agents).toBeNull();
    p.stop();
    const c = parseConfig({ ...base, desktop_mode: "per_agent", e2b_max: 100, desktop_usd_per_day: 60, desktop_idle_s: 300, desktop_renew_before_s: 3600, desktop_keepalive_s: 600, desktop_resume_gap_max_s: 30, desktop_remove_after_s: 120, desktop_start_parallel: 5, desktop_owner: "devnet-site" });
    expect(c).toMatchObject({ desktop_mode: "per_agent", e2b_max: 100, desktop_idle_s: 300, desktop_owner: "devnet-site" });
    expect(desktopOwner(c)).toBe("devnet-site");
    expect(() => parseConfig({ ...base, desktop_mode: "per_agent" })).toThrow("e2b_max above 0");
    expect(() => parseConfig({ ...base, desktop_mode: "each" })).toThrow("desktop_mode");
    expect(() => parseConfig({ ...base, e2b_max: 1101 })).toThrow("e2b_max");
    expect(() => parseConfig({ ...base, desktop_idle_s: -1 })).toThrow("desktop_idle_s");
    expect(() => parseConfig({ ...base, desktop_owner: "a b" })).toThrow("desktop_owner");
    // the mask and the idle pause are settings too: on unless the config says false
    expect(() => parseConfig({ ...base, desktop_mask: "no" })).toThrow("desktop_mask");
    expect(() => parseConfig({ ...base, desktop_idle_pause: 0 })).toThrow("desktop_idle_pause");
    for (const [mask, want] of [[undefined, true], [true, true], [false, false]] as const) {
      const d2 = scratch();
      const pm = desktopPool(parseConfig({ ...base, state_dir: d2, e2b_max: 2, ...(mask === undefined ? {} : { desktop_mask: mask }) }), () => {}, { timers: false, e2b: new E2BBackend({ root: d2, key: null }) })!;
      expect(pm.cfg.mask).toBe(want);
      expect(pm.status().masked).toBe(want);
      pm.stop();
    }
  });

  test("two runtimes get different labels, the same runtime the same one", () => {
    const one = parseConfig({ ...base, state_dir: "/var/lib/units/runtime", desktop_shared: { dir: "/run/x", name: "devnet", peers: ["mainnet"] } });
    const two = parseConfig({ ...base, state_dir: "/var/lib/units-mainnet/runtime", desktop_shared: { dir: "/run/x", name: "mainnet", peers: ["devnet"] } });
    expect(desktopOwner(one)).toMatch(/^devnet-[0-9a-f]{12}$/);
    expect(desktopOwner(two)).toMatch(/^mainnet-[0-9a-f]{12}$/);
    expect(desktopOwner(one)).toBe(desktopOwner(parseConfig({ ...base, state_dir: "/var/lib/units/runtime/", desktop_shared: { dir: "/run/x", name: "devnet", peers: ["mainnet"] } })));
    expect(desktopOwner(one)).not.toBe(desktopOwner({ ...one, state_dir: "/var/lib/other" }));
  });
});

describe("two instances share one E2B day budget in per-agent mode", () => {
  test("each counts the other's spend; each touches only its own agents' desktops", async () => {
    const shared = scratch("units-e2b-shared-");
    const clock = { t: T0 };
    const e2b = new FakeE2B(() => clock.t);
    const base = { mode: "sim", core: "http://127.0.0.1:9", runtime_key: "k", compute_price_line_per_usd: "1", compute_price_line_per_sandbox_s: "0", attempt_max_usd: 1, sandbox_reserve_s: 0, min_attempt_usd: 0.05, desktops_max: 0, e2b_max: 50, desktop_mode: "per_agent", desktop_idle_s: 600, e2b: { vcpu: 2, ram_gib: 4, session_max_s: 86400 } };
    // one budget: what four desktops cost in 1000 s
    const cap = RATE * 4000;
    const mk = (name: string, peer: string, strict: boolean) => {
      const dir = scratch();
      const cfg = parseConfig({ ...base, state_dir: dir, desktop_usd_per_day: cap, desktop_shared: { dir: shared, name, peers: [peer], strict } });
      const pool = desktopPool(cfg, () => {}, { e2b: new E2BBackend({ root: join(dir, "desktops"), key: "k", vcpu: 2, ram_gib: 4, api: e2b }), now: () => clock.t, timers: false })!;
      return { cfg, pool, owner: desktopOwner(cfg) };
    };
    const dev = mk("devnet", "mainnet", false);
    const main = mk("mainnet", "devnet", true);
    expect(dev.owner).not.toBe(main.owner);
    await dev.pool.agents!.settle();
    await main.pool.agents!.settle();
    // a pass of both runtimes; reading the status publishes each one's spend, as their 30 s timers do
    const both = async () => {
      for (let i = 0; i < 2; i++) {
        dev.pool.syncAgents(D);
        main.pool.syncAgents(M);
        await dev.pool.agents!.settle();
        await main.pool.agents!.settle();
        dev.pool.status();
        main.pool.status();
      }
    };
    const D = ["D".repeat(44), "E".repeat(44)].map((agent) => ({ agent, working: true, asleep: false }));
    const M = ["M".repeat(44), "N".repeat(44)].map((agent) => ({ agent, working: true, asleep: false }));
    dev.pool.syncAgents(D);
    main.pool.syncAgents(M);
    await dev.pool.agents!.settle();
    await main.pool.agents!.settle();
    expect(e2b.running()).toBe(4);
    expect([...e2b.boxes.values()].filter((b) => b.metadata.owner === dev.owner)).toHaveLength(2);
    // 500 s on: each instance spent 2 desktops x 500 s; together half the budget
    clock.t += 500_000;
    await both();
    expect(dev.pool.spentToday()).toBeCloseTo(RATE * 1000, 6);
    expect(main.pool.spentToday()).toBeCloseTo(RATE * 1000, 6);
    // what is left to one is the cap less the other's spend
    expect(main.pool.status().e2b.cap_usd).toBeCloseTo(cap - RATE * 1000, 6);
    // 1000 s on: together at the budget; a new agent on either instance gets no desktop, with the reason
    clock.t += 500_000;
    await both();
    const late = { agent: "L".repeat(44), working: false, asleep: false };
    dev.pool.syncAgents([...D, late]);
    await dev.pool.agents!.settle();
    expect(dev.pool.agentDesktop(late.agent)!.state).toBe("none");
    expect(dev.pool.agentDesktop(late.agent)!.why).toContain("day cap reached");
    expect(dev.pool.reserve(late.agent)).toContain("day cap reached");
    // attempts over on both: every idle desktop is paused at once, each by its own runtime
    dev.pool.syncAgents(D.map((x) => ({ ...x, working: false })));
    main.pool.syncAgents(M.map((x) => ({ ...x, working: false })));
    await dev.pool.agents!.settle();
    await main.pool.agents!.settle();
    expect(e2b.running()).toBe(0);
    expect(e2b.boxes.size).toBe(4);
    // an instance that goes away removes only its own
    main.pool.syncAgents([]);
    clock.t += 301_000;
    main.pool.syncAgents([]);
    await main.pool.agents!.settle();
    expect([...e2b.boxes.values()].map((b) => b.metadata.owner)).toEqual([dev.owner, dev.owner]);
    dev.pool.stop();
    main.pool.stop();
  });
});
