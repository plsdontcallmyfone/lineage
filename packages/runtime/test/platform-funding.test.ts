import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey } from "@units/protocol";
import { ChainBackend, parseConfig, Runtime, type Backend } from "../src/index.ts";
import { OpenRouterBalance } from "../src/provider-balance.ts";
import type { AgentRoute, SpendReport } from "../src/runtime.ts";
import type { ClosedEpoch } from "../src/state.ts";

// Plan MODELS-AND-SELF-FUNDING section D (owner 2026-10-13): an agent whose vault cannot pay keeps
// working on the network's OpenRouter balance, one attempt per min_interval_s, under the global cap
// and the balance gate; the vault pays what it holds and never more; the rest is subsidized spend.

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

const T0 = Date.UTC(2026, 9, 13, 12, 0, 0);
const USD = 1_000_000n; // compute_price_line_per_usd "1" at 6 decimals

interface Ctx { maxUsd: number; meter: { model(u: Record<string, unknown>): void; sandbox(s: number): void } }
interface Internals {
  vaults: Map<string, { balance: bigint; awake: boolean }>;
  hosted: Map<string, unknown>;
  discovered: Set<string> | null;
  routes: Map<string, { at: number; r: AgentRoute }>;
  exhausted: Set<string>;
  running: Map<string, unknown>;
  attempts: Map<string, { network?: boolean; maxUsd: number }>;
  waiting: Map<string, string>;
  state: { agents: Record<string, unknown>; window?: { usd: number }; closed: ClosedEpoch[]; subsidized_usd_total?: number; network_started?: Record<string, number> };
  startAttempts(): void;
  refreshAgents(): Promise<void>;
  reportSpend(): Promise<void>;
  syncDesktops(): void;
  beginAttempt(agent: string, seat: number): Ctx | null;
  attemptFor(agent: string, seat?: number): Promise<void>;
  epochs(force?: boolean): Promise<void>;
  covered(agent: string): boolean;
  networkBudget(agent: string): { usd: number | null; why?: string };
  slots(): number;
}

const ON = { enabled: true, min_interval_s: 900 };

async function setup(o: { over?: Record<string, unknown>; balance?: bigint; awake?: boolean; spend?: { usd: number; sandbox_s?: number }; providerBalance?: OpenRouterBalance; report?: boolean; state_dir?: string; clock?: { t: number }; desktop?: boolean; key?: ReturnType<typeof generateAgentKey> } = {}) {
  const clock = o.clock ?? { t: T0 };
  const dir = o.state_dir ?? mkdtempSync(join(tmpdir(), "units-network-compute-"));
  if (!o.state_dir) tmp.push(dir);
  const lines: string[] = [];
  const reports: SpendReport[] = [];
  const synced: { agent: string; working: boolean; asleep: boolean; asleep_why?: string }[][] = [];
  const chain = new Map<string, { balance: bigint; awake: boolean }>();
  const backend: Backend = {
    mode: "sim",
    init: async () => ({ decimals: 6, sleepThreshold: 0n, wakeThreshold: 0n, maxDebitPerEpoch: null }),
    discover: async () => [],
    signingKey: async () => "x",
    vault: async (a) => chain.get(a.agent) ?? { balance: 0n, awake: false },
    bindRequest: async () => ({}),
    nextEpoch: async (n) => ({ epoch: n, earliestS: 0 }),
    post: async () => {},
    refreshAwake: async () => false,
  };
  const cfg = parseConfig({
    mode: "sim", core: "http://127.0.0.1:9", runtime_key: "k", state_dir: dir, compute_price_line_per_usd: "1", compute_price_line_per_sandbox_s: "0.001", attempt_max_usd: 0.5, sandbox_reserve_s: 0,
    min_attempt_usd: 0.2, min_useful_attempt: null, global_max_usd: 10, global_window_s: 86400, global_cap_scope: "all", platform_funding: ON, ...(o.over ?? {}),
  });
  const key = o.key ?? generateAgentKey();
  const rt = new Runtime(cfg, {
    backend, runtimeKey: key, proposer: () => ({ name: "none", propose: async () => null }), log: (m) => lines.push(m), telemetry: false, now: () => clock.t, providerBalance: o.providerBalance,
    ...(o.report ? { report: async (b: SpendReport) => void reports.push(structuredClone(b)) } : {}),
    ...(o.desktop ? { desktop: { required: false, syncAgents: (l: never) => void synced.push(structuredClone(l)) } as never } : {}),
  });
  await rt.start();
  const r = rt as unknown as Internals;
  const starts: { t: number; cap: number | null; network: boolean }[] = [];
  // the worker's side of an attempt: asks for the cap and the meter, spends, ends
  r.attemptFor = async (agent, seat = 1) => {
    const ctx = r.beginAttempt(agent, seat);
    starts.push({ t: clock.t, cap: ctx?.maxUsd ?? null, network: r.attempts.get(agent)?.network === true });
    if (ctx && o.spend) {
      ctx.meter.model({ usd: o.spend.usd, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, model: "m" });
      if (o.spend.sandbox_s) ctx.meter.sandbox(o.spend.sandbox_s);
    }
    r.attempts.delete(agent);
  };
  const add = (balance: bigint, awake: boolean) => {
    const agent = generateAgentKey().id;
    chain.set(agent, { balance, awake });
    r.vaults.set(agent, { balance, awake });
    r.hosted.set(agent, { agent, mint: null, launcher: null, target_repo: null });
    r.state.agents[agent] = { key_id: "x", key_file: "x", status: "bound", discovered_at: 0, bound_at: 0, mint: null, target_repo: null, candidates: 0 };
    r.routes.set(agent, { at: T0 + 1e12, r: { via: "openrouter", model: { provider: "p", id: "m" }, why: null } });
    return agent;
  };
  const agent = add(o.balance ?? 0n, o.awake ?? true);
  /** one runtime tick as far as attempts go: the report, then the starts */
  const tick = async (ms = 5000) => {
    if (o.report) await r.reportSpend();
    r.startAttempts();
    await rt.idle();
    clock.t += ms;
  };
  return { rt, r, agent, add, chain, clock, lines, reports, starts, synced, tick, dir, cfg, key };
}

describe("network compute (platform_funding)", () => {
  test("off by default: an empty vault starts nothing, as before", async () => {
    expect(parseConfig({ mode: "sim", core: "http://x", runtime_key: "k", compute_price_line_per_usd: "1", compute_price_line_per_sandbox_s: "0" }).platform_funding?.enabled ?? false).toBe(false);
    const s = await setup({ over: { platform_funding: undefined } });
    for (let i = 0; i < 720; i++) await s.tick();
    expect(s.starts).toEqual([]);
    expect(s.r.covered(s.agent)).toBe(false);
    expect(s.r.exhausted.has(s.agent)).toBe(true);
    await s.rt.stop({ flush: false });
  });

  test("config: the interval and the cap are settings; bad values are refused", () => {
    const base = { mode: "sim", core: "http://x", runtime_key: "k", compute_price_line_per_usd: "1", compute_price_line_per_sandbox_s: "0" };
    expect(parseConfig({ ...base, platform_funding: { enabled: true } }).platform_funding).toMatchObject({ enabled: true });
    expect(() => parseConfig({ ...base, platform_funding: { enabled: "yes" } })).toThrow(/platform_funding/);
    expect(() => parseConfig({ ...base, platform_funding: { enabled: true, min_interval_s: -1 } })).toThrow(/min_interval_s/);
    expect(() => parseConfig({ ...base, platform_funding: { enabled: true, attempt_max_usd: -1 } })).toThrow(/attempt_max_usd/);
  });

  for (const [name, awake] of [["an awake agent with an empty vault", true], ["an agent asleep on chain", false]] as const)
    test(`${name} starts an attempt on network compute at most once per interval`, async () => {
      const s = await setup({ awake, spend: { usd: 0.3 } });
      for (let i = 0; i < 720; i++) await s.tick(); // one hour of 5 s ticks
      expect(s.starts.length).toBeGreaterThanOrEqual(3);
      expect(s.starts.length).toBeLessThanOrEqual(4);
      expect(s.starts.every((x) => x.network && x.cap === 0.5)).toBe(true); // sized by the attempt cap, not by the vault
      for (let i = 1; i < s.starts.length; i++) expect(s.starts[i]!.t - s.starts[i - 1]!.t).toBeGreaterThanOrEqual(900_000);
      expect(s.lines.filter((l) => l.includes("attempt starts on network compute")).length).toBe(s.starts.length);
      await s.rt.stop({ flush: false });
    });

  test("the interval and the cap follow the settings; a restart does not shorten the interval", async () => {
    const s = await setup({ over: { platform_funding: { enabled: true, min_interval_s: 60, attempt_max_usd: 0.25 } }, spend: { usd: 0.1 } });
    for (let i = 0; i < 60; i++) await s.tick(); // 5 minutes
    expect(s.starts.length).toBe(5);
    expect(s.starts.every((x) => x.cap === 0.25)).toBe(true);
    const last = s.starts[s.starts.length - 1]!.t;
    expect(s.r.state.network_started?.[s.agent]).toBe(last);
    await s.rt.stop({ flush: false });
    // a new process on the same state: its first covered attempt still waits for the interval
    const again = await setup({ over: { platform_funding: { enabled: true, min_interval_s: 3600 } }, state_dir: s.dir, clock: s.clock, key: s.key });
    const agent2 = s.agent;
    again.r.vaults.delete(again.agent);
    delete again.r.state.agents[again.agent];
    again.chain.set(agent2, { balance: 0n, awake: true });
    again.r.vaults.set(agent2, { balance: 0n, awake: true });
    again.r.routes.set(agent2, { at: T0 + 1e12, r: { via: "openrouter", model: { provider: "p", id: "m" }, why: null } });
    for (let i = 0; i < 120; i++) await again.tick(); // 10 minutes
    expect(again.starts).toEqual([]);
    again.clock.t = last + 3600_000;
    await again.tick();
    await again.tick();
    expect(again.starts.length).toBe(1);
    await again.rt.stop({ flush: false });
  });

  test("returns to the vault path and the normal pace as soon as the vault can pay", async () => {
    const s = await setup({ spend: { usd: 0.01 } });
    for (let i = 0; i < 12; i++) await s.tick();
    expect(s.starts.map((x) => x.network)).toEqual([true]);
    expect(s.r.covered(s.agent)).toBe(true);
    // fees arrive
    s.chain.set(s.agent, { balance: 20n * USD, awake: true });
    await s.r.refreshAgents();
    expect(s.r.covered(s.agent)).toBe(false);
    const before = s.starts.length;
    for (let i = 0; i < 6; i++) await s.tick(); // 30 s: far inside the 900 s interval
    const after = s.starts.slice(before);
    expect(after.length).toBeGreaterThan(1);
    expect(after.every((x) => !x.network && x.cap === 0.5)).toBe(true);
    // and back again when it runs dry
    s.chain.set(s.agent, { balance: 0n, awake: true });
    await s.r.refreshAgents();
    await s.tick();
    expect(s.r.covered(s.agent)).toBe(true);
    await s.rt.stop({ flush: false });
  });

  for (const scope of ["all", "subsidized"] as const)
    test(`scope ${scope}: a covered attempt is not charged to the vault at all; its whole cost is subsidized spend under the global cap`, async () => {
      // 0.10 USD in the vault: under the 0.20 floor, so it cannot pay for an attempt
      const s = await setup({ balance: USD / 10n, spend: { usd: 0.3, sandbox_s: 100 }, over: { global_cap_scope: scope } });
      const empty = s.add(0n, false);
      for (let i = 0; i < 4; i++) await s.tick();
      expect(s.starts.length).toBe(2);
      expect(s.starts.every((x) => x.network)).toBe(true);
      // nothing of it is owed by the vault while the epoch is open
      expect(s.rt.owed(s.agent)).toBe(0n);
      await s.r.epochs(true);
      const e = s.r.state.closed[0]!;
      const mine = e.leaves.find((l) => l.agent === s.agent)!;
      const zero = e.leaves.find((l) => l.agent === empty)!;
      // 0.30 USD of model spend plus 100 sandbox s at 0.001 = 0.40 USD of cost each, none of it debited
      expect(mine.cost).toBe("400000");
      expect(mine.amount).toBe("0"); // the 0.10 USD the vault holds stays in it
      expect(zero.cost).toBe("400000");
      expect(zero.amount).toBe("0");
      expect(s.r.state.subsidized_usd_total).toBeCloseTo(0.8, 9);
      // the cap's window: every model USD in scope all, the whole cost in scope subsidized
      expect(s.r.state.window!.usd).toBeCloseTo(scope === "all" ? 0.6 : 0.8, 9);
      expect(s.rt.capStatus().left_usd).toBeCloseTo(scope === "all" ? 9.4 : 9.2, 9);
      // no leaf with an amount: nothing is posted or debited for the epoch
      expect(ChainBackend.tree(e).items).toEqual([]);
      await s.rt.stop({ flush: false });
    });

  test("fees arriving while covered are kept: the covered usage does not eat them, and the vault path is back as soon as they cover an attempt", async () => {
    const s = await setup({ spend: { usd: 0.45 } });
    for (let i = 0; i < 4; i++) await s.tick();
    expect(s.starts.map((x) => x.network)).toEqual([true]);
    // 0.30 USD of fees: under an attempt's floor of 0.20? no, over it, so the vault pays again at once
    s.chain.set(s.agent, { balance: (3n * USD) / 10n, awake: true });
    await s.r.refreshAgents();
    expect(s.rt.owed(s.agent)).toBe(0n);
    expect(s.r.covered(s.agent)).toBe(false);
    expect(s.rt.budget(s.agent)).toEqual({ usd: 0.3 }); // the whole deposit, not the deposit less the 0.45 the network paid
    await s.r.epochs(true);
    expect(s.r.state.closed[0]!.leaves[0]).toMatchObject({ amount: "0", cost: "450000" });
    await s.rt.stop({ flush: false });
  });

  test("a vault-paid attempt and a covered one in the same usage epoch: the vault is charged the first only", async () => {
    const s = await setup({ balance: USD, spend: { usd: 0.45 } });
    await s.tick(); // vault-paid: 0.45 of the 1.00
    await s.tick(); // vault-paid: 0.90
    await s.tick(); // 0.10 left: under the floor, marked exhausted
    for (let i = 0; i < 190; i++) await s.tick(); // covered, one interval after the last attempt began
    expect(s.starts.map((x) => x.network)).toEqual([false, false, true]);
    expect(s.rt.owed(s.agent)).toBe(900_000n);
    await s.r.epochs(true);
    expect(s.r.state.closed[0]!.leaves[0]).toMatchObject({ amount: "900000", cost: "1350000" });
    expect(s.r.state.subsidized_usd_total).toBeCloseTo(0.45, 9);
    await s.rt.stop({ flush: false });
  });

  test("charge_vault true is the earlier rule: the vault pays what it holds toward covered usage, never more", async () => {
    const s = await setup({ balance: USD / 10n, spend: { usd: 0.3, sandbox_s: 100 }, over: { platform_funding: { enabled: true, min_interval_s: 900, charge_vault: true } } });
    for (let i = 0; i < 4; i++) await s.tick();
    await s.r.epochs(true);
    expect(s.r.state.closed[0]!.leaves[0]).toMatchObject({ amount: "100000", cost: "400000" });
    expect(s.r.state.subsidized_usd_total).toBeCloseTo(0.3, 9);
    expect(() => parseConfig({ mode: "sim", core: "http://x", runtime_key: "k", compute_price_line_per_usd: "1", compute_price_line_per_sandbox_s: "0", platform_funding: { enabled: true, charge_vault: "no" } })).toThrow(/charge_vault/);
    await s.rt.stop({ flush: false });
  });

  for (const scope of ["all", "subsidized"] as const)
    test(`scope ${scope}: the global cap stops a covered agent`, async () => {
      const s = await setup({ spend: { usd: 0.45 }, over: { global_cap_scope: scope, global_max_usd: 1, platform_funding: { enabled: true, min_interval_s: 10 } } });
      for (let i = 0; i < 60; i++) await s.tick();
      // 0.45 + 0.45 spent; the 0.10 left is under the 0.20 floor of an attempt
      expect(s.starts.length).toBe(2);
      expect(s.starts[1]!.cap).toBeCloseTo(0.5, 9);
      expect(s.r.networkBudget(s.agent)).toMatchObject({ usd: null, why: expect.stringMatching(/^global runtime cap \(1 USD per 86400 s window\) reached/) });
      expect(s.rt.spendReport().agents[s.agent]!.waiting).toMatch(/^global runtime cap/);
      await s.rt.stop({ flush: false });
    });

  test("a running covered attempt's reserve is held against the cap", async () => {
    const s = await setup({ over: { global_cap_scope: "subsidized", global_max_usd: 0.6 } });
    s.r.attempts.set("other", { network: true, maxUsd: 0.5, agent: "other", totals: { usd: 0, sandbox_s: 0 } } as never);
    expect(s.r.networkBudget(s.agent).usd).toBeNull();
    s.r.attempts.delete("other");
    expect(s.r.networkBudget(s.agent).usd).toBeCloseTo(0.5, 9);
    await s.rt.stop({ flush: false });
  });

  test("a low OpenRouter balance stops it; a model that does not run through OpenRouter is not covered by it", async () => {
    const api = (async () => new Response(JSON.stringify({ data: { limit_remaining: 0.1, limit: 10, usage: 9.9 } }), { status: 200 })) as unknown as typeof fetch;
    const ob = new OpenRouterBalance({ keys: { openrouter: "k" }, floor_usd: 5, fetch: api });
    await ob.refresh(true);
    expect(ob.room()).toBeCloseTo(0.1, 9);
    const s = await setup({ providerBalance: ob, spend: { usd: 0.1 } });
    for (let i = 0; i < 12; i++) await s.tick();
    expect(s.starts).toEqual([]);
    expect(s.r.networkBudget(s.agent)).toMatchObject({ usd: null, why: expect.stringMatching(/^provider balance low \(OpenRouter has 0\.10 USD/) });
    expect(s.rt.spendReport().agents[s.agent]!.waiting).toMatch(/^provider balance low/);
    const d = await setup({ spend: { usd: 0.1 } });
    d.r.routes.set(d.agent, { at: T0 + 1e12, r: { via: "direct", model: { provider: "p", id: "m" }, why: null } });
    for (let i = 0; i < 12; i++) await d.tick();
    expect(d.starts).toEqual([]);
    expect(d.r.networkBudget(d.agent)).toMatchObject({ usd: null, why: expect.stringMatching(/OpenRouter/) });
    await s.rt.stop({ flush: false });
    await d.rt.stop({ flush: false });
  });

  test("the report names the agent as covered with the interval, without a vault pause; its vault figure stays what it is; Core hears it before the first attempt", async () => {
    const s = await setup({ awake: false, report: true, spend: { usd: 0.1 } });
    for (let i = 0; i < 6; i++) await s.tick();
    expect(s.starts.length).toBe(1);
    const firstCovered = s.reports.findIndex((b) => b.agents[s.agent]?.covered);
    expect(firstCovered).toBeGreaterThanOrEqual(0);
    expect(s.reports[firstCovered]!.at).toBeLessThanOrEqual(s.starts[0]!.t);
    const row = s.rt.spendReport().agents[s.agent]!;
    expect(row.covered).toEqual({ min_interval_s: 900 });
    expect(row.waiting).toBeNull(); // not "asleep", not "compute vault exhausted"
    expect(row.vault).toBe("0");
    expect(row.vault_usd).toBe(0);
    // a funded agent's row has no such field
    const rich = s.add(50n * USD, true);
    expect(s.rt.spendReport().agents[rich]!.covered).toBeUndefined();
    await s.rt.stop({ flush: false });
  });

  test("an attempt that could not begin (no desktop free) is tried again after the short gap and uses up no interval", async () => {
    const s = await setup({ spend: { usd: 0.1 }, over: { attempt_gap_s: 30 } });
    let free = false;
    (s.rt as unknown as { deps: { desktop: unknown } }).deps.desktop = { required: true, reserve: () => (free ? null : "none is free") };
    // the real end of an attempt: the short gap before the next try
    const begin = s.r.attemptFor;
    s.r.attemptFor = async (agent, seat) => {
      await begin(agent, seat);
      (s.rt as unknown as { misses: Map<string, { n: number; until: number }> }).misses.set(agent, { n: 0, until: s.clock.t + 30_000 });
    };
    for (let i = 0; i < 24; i++) await s.tick(); // 2 minutes with no desktop
    expect(s.starts.length).toBeGreaterThanOrEqual(3); // asked again about every 30 s
    expect(s.starts.every((x) => x.cap === null)).toBe(true);
    expect(s.r.state.network_started?.[s.agent]).toBeUndefined();
    expect(s.rt.spendReport().agents[s.agent]!.waiting).toBe("waiting for a desktop: none is free");
    free = true;
    const n = s.starts.length;
    for (let i = 0; i < 24; i++) await s.tick();
    // begins within the short gap, then once per interval
    expect(s.starts.slice(n).filter((x) => x.cap !== null).length).toBe(1);
    expect(s.starts.slice(n)[0]!.cap).toBe(0.5);
    await s.rt.stop({ flush: false });
  });

  test("its desktop is not rested for a low vault; with the setting off it is", async () => {
    const on = await setup({ awake: false, desktop: true });
    on.r.discovered = null;
    await on.tick();
    on.r.syncDesktops();
    expect(on.synced.at(-1)).toEqual([{ agent: on.agent, working: false, asleep: false }]);
    expect(on.r.slots()).toBeGreaterThanOrEqual(1);
    const off = await setup({ awake: true, desktop: true, over: { platform_funding: { enabled: false } } });
    off.r.discovered = null;
    await off.tick();
    await off.tick();
    off.r.syncDesktops();
    expect(off.synced.at(-1)).toEqual([{ agent: off.agent, working: false, asleep: true, asleep_why: "agent cannot pay for an attempt (vault low)" }]);
    await on.rt.stop({ flush: false });
    await off.rt.stop({ flush: false });
  });
});
