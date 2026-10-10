import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey } from "@lineage/protocol";
import type { DesktopProvider } from "../../desktop/src/pool.ts";
import { parseConfig, Runtime, type Backend } from "../src/index.ts";
import { desktopGate } from "../src/desktop-gate.ts";

// "Every working agent has its own live desktop" (owner decision 2026-10-10): with desktops required,
// the runtime starts an attempt only after a desktop slot was reserved for it; with none free the
// attempt does not start and the agent's status says why; the next try comes after the short gap.

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

function provider(free: () => string | null, required = true): DesktopProvider & { reserved: string[] } {
  const reserved: string[] = [];
  return {
    required,
    reserved,
    begin: async () => null,
    reserve: (a) => {
      const why = free();
      if (!why) reserved.push(a);
      return why;
    },
  };
}

async function setup(desktop?: DesktopProvider) {
  const d = mkdtempSync(join(tmpdir(), "lineage-deskgate-"));
  tmp.push(d);
  const cfg = parseConfig({ mode: "sim", core: "http://127.0.0.1:9", runtime_key: "k", state_dir: d, compute_price_line_per_usd: "1", compute_price_line_per_sandbox_s: "0", attempt_max_usd: 0.5, sandbox_reserve_s: 0, min_attempt_usd: 0.05, global_max_usd: 10, global_window_s: 86400 });
  const logs: string[] = [];
  const rt = new Runtime(cfg, { backend, runtimeKey: generateAgentKey(), proposer: () => ({ name: "none", propose: async () => null }), log: (m) => logs.push(m), telemetry: false, now: () => Date.UTC(2026, 9, 10, 12), desktop });
  await rt.start();
  const r = rt as unknown as { vaults: Map<string, unknown>; state: { agents: Record<string, unknown> }; waiting: Map<string, string>; worker(a: string): { opts: { attempt(): unknown } } };
  const agent = generateAgentKey().id;
  r.vaults.set(agent, { balance: 100_000_000n, awake: true });
  r.state.agents[agent] = { key_id: "x", key_file: "x", status: "bound", discovered_at: 0, bound_at: 0, mint: null, target_repo: null, candidates: 0 };
  return { rt, r, agent, logs, attempt: () => (r.worker(agent) as unknown as { opts: { attempt(): unknown } }).opts.attempt() };
}

test("desktop required and none free: the attempt does not start, the status says why; free again: it starts with a slot held", async () => {
  let why: string | null = "desktop hosts 4 of 4 busy; this server 2 of 2 busy; E2B: day cap reached (16.0000 of 16 USD, UTC day)";
  const p = provider(() => why);
  const s = await setup(p);
  expect(s.attempt()).toBeNull();
  expect(s.r.waiting.get(s.agent)).toBe(`waiting for a desktop: ${why}`);
  expect(s.logs.filter((m) => m.includes("waiting for a desktop")).length).toBe(1);
  expect(s.attempt()).toBeNull();
  expect(s.logs.filter((m) => m.includes("waiting for a desktop")).length).toBe(1); // logged once per reason
  why = null;
  expect(s.attempt()).toMatchObject({ maxUsd: 0.5 });
  expect(p.reserved).toEqual([s.agent]);
  expect(s.r.waiting.has(s.agent)).toBe(false);
  await s.rt.stop({ flush: false });
});

test("desktops optional or off: no gate", async () => {
  expect(desktopGate(undefined, "a")).toBeNull();
  expect(desktopGate(provider(() => "busy", false), "a")).toBeNull();
  const s = await setup(provider(() => "busy", false));
  expect(s.attempt()).toMatchObject({ maxUsd: 0.5 });
  await s.rt.stop({ flush: false });
});
