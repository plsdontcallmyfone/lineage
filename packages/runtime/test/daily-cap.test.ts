import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey } from "@lineage/protocol";
import { parseConfig, Runtime, windowStart, type Backend } from "../src/index.ts";

// The global cap per spend window (config global_window_s): the hosted runtime on the live site
// spends at most global_max_usd of model usage per UTC day, across all agents and restarts.

const tmp: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "lineage-rt-window-"));
  tmp.push(d);
  return d;
};
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

const DAY = 86_400_000;
const AGENT = generateAgentKey().id;
const T0 = Date.UTC(2026, 9, 9, 22, 0, 0); // 2026-10-09 22:00 UTC

function setup(dir: string, clock: { t: number }, over: Record<string, unknown> = {}, runtimeKey = generateAgentKey()) {
  const cfg = parseConfig({ mode: "sim", core: "http://127.0.0.1:9", runtime_key: "k", state_dir: dir, compute_price_line_per_usd: "1", compute_price_line_per_sandbox_s: "0", attempt_max_usd: 0.5, agent_epoch_max_usd: 100, global_max_usd: 10, global_window_s: 86400, ...over });
  const rt = new Runtime(cfg, { backend, runtimeKey, proposer: () => ({ name: "none", propose: async () => null }), log: () => {}, telemetry: false, now: () => clock.t });
  const r = rt as unknown as { vaults: Map<string, unknown>; prices: unknown; limits: unknown; meterFor(a: unknown): { model(u: unknown): void } };
  const agent = AGENT;
  r.vaults.set(agent, { balance: 10n ** 15n, awake: true });
  r.limits = { decimals: 6, sleepThreshold: 0n, wakeThreshold: 0n, maxDebitPerEpoch: null };
  r.prices = { decimals: 6, perUsd: 1_000_000n, perSandboxS: 0n, perSol: 0n };
  const spend = (usd: number) =>
    r.meterFor({ agent, maxUsd: usd, totals: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, usd: 0, sandbox_s: 0, models: [], started_at: 0, finished_at: 0 } }).model({ input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, usd, model: "claude-opus-5-5" });
  return { rt, agent, spend, cfg, runtimeKey };
}

describe("global cap per window (global_window_s)", () => {
  test("config: a window is whole seconds >= 60, or absent/null for the lifetime cap", () => {
    const base = { mode: "sim", core: "http://x", runtime_key: "k", compute_price_line_per_usd: "1", compute_price_line_per_sandbox_s: "0" };
    expect(parseConfig({ ...base, global_window_s: 86400 }).global_window_s).toBe(86400);
    expect(parseConfig({ ...base }).global_window_s).toBeUndefined();
    expect(parseConfig({ ...base, global_window_s: null }).global_window_s).toBeNull();
    expect(() => parseConfig({ ...base, global_window_s: 0 })).toThrow(/global_window_s/);
    expect(() => parseConfig({ ...base, global_window_s: 1.5 })).toThrow(/global_window_s/);
    expect(windowStart(T0, 86400)).toBe(Date.UTC(2026, 9, 9));
  });

  test("10 USD per UTC day: refused once the day's spend reaches the cap, open again after 00:00 UTC, kept across restarts", async () => {
    const dir = scratch();
    const clock = { t: T0 };
    let s = setup(dir, clock);
    await s.rt.start();
    expect(s.rt.budget(s.agent).usd).toBe(0.5);
    for (let i = 0; i < 19; i++) s.spend(0.5); // 9.5 USD
    expect(s.rt.budget(s.agent).usd).toBe(0.5);
    s.spend(0.5); // 10 USD
    const refused = s.rt.budget(s.agent);
    expect(refused.usd).toBeNull();
    expect((refused as { why: string }).why).toMatch(/global runtime cap \(10 USD per 86400 s window\) reached/);
    const cap = s.rt.capStatus();
    expect(cap).toMatchObject({ max_usd: 10, window_s: 86400, window_start: Date.UTC(2026, 9, 9), window_end: Date.UTC(2026, 9, 10), left_usd: 0 });
    expect(cap.spent_usd).toBeCloseTo(10, 9);

    // a restart the same day keeps the counter
    await s.rt.stop({ flush: false });
    s = setup(dir, clock, {}, s.runtimeKey);
    await s.rt.start();
    expect(s.rt.budget(s.agent).usd).toBeNull();

    // 00:00 UTC: a fresh window; the closed one is kept in the record, the lifetime total keeps counting
    clock.t = T0 + 2 * 3_600_000;
    expect(s.rt.budget(s.agent).usd).toBe(0.5);
    s.spend(0.25);
    const next = s.rt.capStatus();
    expect(next.window_start).toBe(Date.UTC(2026, 9, 10));
    expect(next.spent_usd).toBeCloseTo(0.25, 9);
    expect(next.lifetime_usd).toBeCloseTo(10.25, 9);
    expect(next.past_windows.at(-1)).toMatchObject({ start: Date.UTC(2026, 9, 9), window_s: 86400 });
    expect(next.past_windows.at(-1)!.usd).toBeCloseTo(10, 9);

    // a clock that steps back into a closed window does not get a fresh budget there
    clock.t = T0;
    expect(s.rt.capStatus().window_start).toBe(Date.UTC(2026, 9, 10));
    await s.rt.stop({ flush: false });
  });

  test("an open attempt's reserve counts against the window (two attempts cannot overshoot together)", async () => {
    const clock = { t: T0 };
    const s = setup(scratch(), clock, { attempt_max_usd: 4, max_concurrent: 2 });
    await s.rt.start();
    const r = s.rt as unknown as { attempts: Map<string, { maxUsd: number; totals: { usd: number } }> };
    r.attempts.set("other", { maxUsd: 4, totals: { usd: 0 } });
    s.spend(4);
    expect(s.rt.budget(s.agent).usd).toBe(2); // 10 - 4 spent - 4 reserved
    await s.rt.stop({ flush: false });
  });

  test("without a window the cap stays a lifetime cap", async () => {
    const clock = { t: T0 };
    const s = setup(scratch(), clock, { global_window_s: null, global_max_usd: 1 });
    await s.rt.start();
    s.spend(1);
    expect(s.rt.budget(s.agent).usd).toBeNull();
    clock.t = T0 + 30 * DAY;
    expect(s.rt.budget(s.agent).usd).toBeNull();
    expect(s.rt.capStatus().window_s).toBeNull();
    await s.rt.stop({ flush: false });
  });
});
