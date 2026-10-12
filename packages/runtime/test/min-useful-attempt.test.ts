import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey } from "@units/protocol";
import { JOURNAL_RESERVE_USD } from "../../worker/src/journal.ts";
import { parseConfig, Runtime, type Backend } from "../src/index.ts";
import { MIN_USEFUL_DEFAULTS, type AgentRoute } from "../src/runtime.ts";

// The minimum useful attempt (owner direction 2026-10-12). On the site, agents with a nearly empty
// vault started an attempt every 30 seconds that reserved a desktop, opened a session and ended at
// the spend cap with 0 model calls (the budget passed min_attempt_usd but not the proposer's first
// call after the journal reserve). Now no attempt starts, no desktop is taken and no session opens
// unless the budget covers the journal reserve plus two model calls at the agent's model's rate; the
// agent is paused with the reason and checked again after 5 minutes or on a vault deposit.

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

const backend: Backend = {
  mode: "sim",
  init: async () => ({ decimals: 6, sleepThreshold: 0n, wakeThreshold: 0n, maxDebitPerEpoch: null }),
  discover: async () => [],
  signingKey: async () => null,
  vault: async () => ({ balance: 0n, awake: false }),
  bindRequest: async () => ({}),
  nextEpoch: async (n) => ({ epoch: n, earliestS: 0 }),
  post: async () => {},
  refreshAwake: async () => false,
};

const T0 = Date.UTC(2026, 9, 12, 1, 0, 0);
const USD = 1_000_000n; // compute_price_line_per_usd "1" at 6 decimals
// a rate in USD per million tokens (figures of the test, not of any model)
const RATE = { input: 5, output: 25, cache_write: 6.25 };
const CALL = (MIN_USEFUL_DEFAULTS.call_input_tokens * RATE.cache_write + MIN_USEFUL_DEFAULTS.call_output_tokens * RATE.output) / 1e6;
const NEED = JOURNAL_RESERVE_USD + MIN_USEFUL_DEFAULTS.model_calls * CALL;

interface Internals {
  vaults: Map<string, { balance: bigint; awake: boolean }>;
  routes: Map<string, { at: number; r: AgentRoute }>;
  state: { agents: Record<string, unknown> };
  running: Map<string, unknown>;
  workers: Map<string, unknown>;
  attempts: Map<string, unknown>;
  paused: Map<string, { until: number; balance: bigint; why: string }>;
  waiting: Map<string, string>;
  startAttempts(): void;
  usageOf(agent: string): { attempts: number };
}

async function setup(o: { usd: number; over?: Record<string, unknown>; rate?: AgentRoute["rate"] }) {
  const clock = { t: T0 };
  const lines: string[] = [];
  const desktops: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "units-minuseful-"));
  tmp.push(dir);
  const cfg = parseConfig({ mode: "sim", core: "http://127.0.0.1:9", runtime_key: "k", state_dir: dir, compute_price_line_per_usd: "1", compute_price_line_per_sandbox_s: "0", attempt_max_usd: 1, sandbox_reserve_s: 0, min_attempt_usd: 0.05, ...(o.over ?? {}) });
  const rt = new Runtime(cfg, {
    backend, runtimeKey: generateAgentKey(), proposer: () => ({ name: "none", propose: async () => null }), log: (m) => lines.push(m), telemetry: false, now: () => clock.t,
    // a desktop pool that records every desktop asked for
    desktop: { required: false, open: async (x: { agent: string }) => (desktops.push(x.agent), null) } as never,
  });
  await rt.start();
  const r = rt as unknown as Internals;
  const agent = generateAgentKey().id;
  r.vaults.set(agent, { balance: BigInt(Math.round(o.usd * 1e6)), awake: true });
  r.state.agents[agent] = { key_id: "x", key_file: "x", status: "bound", discovered_at: 0, bound_at: 0, mint: null, target_repo: null, candidates: 0 };
  r.routes.set(agent, { at: T0 + 1e12, r: { via: "direct", model: { provider: "p", id: "m" }, why: null, rate: o.rate === undefined ? RATE : o.rate } });
  return { rt, r, agent, clock, lines, desktops };
}

describe("minimum useful attempt", () => {
  test("priced from the agent's model: the journal reserve plus two calls", async () => {
    const s = await setup({ usd: 100 });
    expect(s.rt.minUsefulUsd(s.agent)).toBeCloseTo(NEED, 12);
    expect(NEED).toBeGreaterThan(0.05);
    // an OpenRouter route's fee is part of the price
    s.r.routes.set(s.agent, { at: T0 + 1e12, r: { via: "openrouter", model: { provider: "p", id: "m" }, why: null, rate: { ...RATE, fee_factor: 1.055 } } });
    expect(s.rt.minUsefulUsd(s.agent)).toBeCloseTo(JOURNAL_RESERVE_USD + 2 * CALL * 1.055, 12);
    await s.rt.stop();
  });

  test("a vault that passes min_attempt_usd but not a useful attempt: no attempt, no desktop, no session, paused with the reason", async () => {
    // the site's case: 0.1091 USD of budget, over the 0.05 floor, under one real model call after the journal reserve
    const s = await setup({ usd: 0.1091 });
    expect(0.1091).toBeLessThan(NEED);
    const b = s.rt.budget(s.agent);
    expect(b.usd).toBeNull();
    expect((b as { why: string }).why).toMatch(/^compute vault exhausted \(109100 base units unowed\); a useful attempt needs \d+\.\d{4} USD, 0\.1091 available$/);
    for (let i = 0; i < 20; i++) {
      s.r.startAttempts();
      s.clock.t += 5000; // the runtime's poll
    }
    expect(s.r.running.size).toBe(0);
    expect(s.r.workers.size).toBe(0); // no worker was even asked: no session opened, nothing reported to Core
    expect(s.r.attempts.size).toBe(0);
    expect(s.r.usageOf(s.agent).attempts).toBe(0);
    expect(s.desktops).toEqual([]);
    expect(s.lines.filter((l) => l.includes("attempt starts"))).toEqual([]);
    // said once, with when it is looked at again
    const paused = s.lines.filter((l) => l.includes("paused:"));
    expect(paused).toHaveLength(1);
    expect(paused[0]).toContain("no attempt, desktop or session; next check in 300 s or on a vault deposit");
    // the reason the spend report and the app show (the app reads the "compute vault exhausted" prefix as Paused: vault empty)
    expect(s.r.waiting.get(s.agent)).toMatch(/^compute vault exhausted/);
    await s.rt.stop();
  });

  test("rechecked after 5 minutes, and at once on a vault deposit", async () => {
    const s = await setup({ usd: 0.1091 });
    s.r.startAttempts();
    expect(s.r.paused.get(s.agent)?.until).toBe(T0 + 300_000);
    // inside the pause nothing is looked at
    s.clock.t = T0 + 299_000;
    s.r.startAttempts();
    expect(s.lines.filter((l) => l.includes("paused:"))).toHaveLength(1);
    // a deposit ends the pause at once and the attempt starts
    s.r.vaults.set(s.agent, { balance: 5n * USD, awake: true });
    (s.rt as unknown as { exhausted: Set<string> }).exhausted.delete(s.agent); // the vault refresh does this when the budget is back
    s.r.startAttempts();
    expect(s.r.paused.has(s.agent)).toBe(false);
    expect(s.r.running.has(s.agent)).toBe(true);
    await s.rt.stop();
  });

  test("the platform cap as the binding limit pauses with its own reason", async () => {
    const s = await setup({ usd: 100, over: { global_cap_scope: "all", global_max_usd: 0.2, global_window_s: 86400 } });
    const b = s.rt.budget(s.agent) as { usd: null; why: string; short?: boolean };
    expect(b.usd).toBeNull();
    expect(b.why).toMatch(/^global runtime cap \(0\.2 USD per 86400 s window\) reached; a useful attempt needs/);
    s.r.startAttempts();
    expect(s.r.running.size).toBe(0);
    expect(s.lines.filter((l) => l.includes("paused: global runtime cap"))).toHaveLength(1);
    await s.rt.stop();
  });

  test("enough for a useful attempt starts one; null turns the model-rate floor off; an unknown rate leaves min_attempt_usd alone", async () => {
    const ok = await setup({ usd: NEED + 0.01 });
    expect(ok.rt.budget(ok.agent).usd).toBeCloseTo(NEED + 0.01, 6);
    ok.r.startAttempts();
    expect(ok.r.running.has(ok.agent)).toBe(true);
    await ok.rt.stop();

    const off = await setup({ usd: 0.1091, over: { min_useful_attempt: null } });
    expect(off.rt.minUsefulUsd(off.agent)).toBe(0);
    expect(off.rt.budget(off.agent).usd).toBeCloseTo(0.1091, 6);
    await off.rt.stop();

    const unknown = await setup({ usd: 0.1091, rate: null });
    expect(unknown.rt.minUsefulUsd(unknown.agent)).toBe(0);
    expect(unknown.rt.budget(unknown.agent).usd).toBeCloseTo(0.1091, 6);
    const under = await setup({ usd: 0.04, rate: null });
    expect(under.rt.budget(under.agent).usd).toBeNull();
    await unknown.rt.stop();
    await under.rt.stop();
  });

  test("posts and analyses (no sandbox) keep their own smaller floor", async () => {
    const s = await setup({ usd: 0.1091 });
    expect(s.rt.budget(s.agent, { sandbox: false, cap: 0.02 }).usd).toBeCloseTo(0.02, 6);
    await s.rt.stop();
  });

  test("config: counts and seconds of 0 or more, or null", () => {
    const base = { mode: "sim", core: "http://127.0.0.1:9", runtime_key: "k", compute_price_line_per_usd: "1", compute_price_line_per_sandbox_s: "0" };
    expect(() => parseConfig({ ...base, min_useful_attempt: { model_calls: -1 } })).toThrow(/min_useful_attempt\.model_calls/);
    expect(() => parseConfig({ ...base, min_useful_attempt: { recheck_s: "soon" } })).toThrow(/min_useful_attempt\.recheck_s/);
    expect(parseConfig({ ...base, min_useful_attempt: null }).min_useful_attempt).toBeNull();
    expect(parseConfig({ ...base, min_useful_attempt: { model_calls: 3 } }).min_useful_attempt).toEqual({ model_calls: 3 });
  });
});
