import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey } from "@lineage/protocol";
import { loadRecipe } from "@lineage/sandbox";
import { AnthropicProposer } from "../../worker/src/proposers/anthropic.ts";
import type { ProposeContext } from "../../worker/src/proposers/types.ts";
import { addSecret, isAgentId, Lock, parseConfig, redact, Runtime, StateStore, type Backend } from "../src/index.ts";
import { fakeClient } from "./fake.ts";

// Offchain audit A2 (docs/AUDIT.md, Offchain): the hosted runtime's trust in Core, its spend caps,
// its lock and its log redaction.

const ROOT = join(import.meta.dir, "../../..");
const tmp: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "lineage-a2-rt-"));
  tmp.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

function proposeCtx(over: Partial<ProposeContext> = {}): ProposeContext {
  const tree = scratch();
  writeFileSync(join(tree, "hello.txt"), "hello\n");
  return {
    loaded: loadRecipe(join(ROOT, "recipes/fixture-b58")),
    deps: { dir: tree, digest: "0".repeat(64) },
    calibration: { recipe_id: "", snapshot_id: "", runs: 1, stable: [], known_failures: [], quarantined: [], metrics: {}, median_eval_seconds: 1 } as never,
    parentPatches: [],
    findings: [],
    tree,
    seed: "5eed",
    log: () => {},
    ...over,
  };
}

function stubBackend(agents: string[]): Backend {
  return {
    mode: "sim",
    init: async () => ({ decimals: 6, sleepThreshold: 0n, wakeThreshold: 0n, maxDebitPerEpoch: null }),
    discover: async () => agents.map((agent) => ({ agent, mint: null, launcher: null, target_repo: null })),
    signingKey: async () => null,
    vault: async () => ({ balance: 0n, awake: false }),
    bindRequest: async () => ({ forged: true }),
    nextEpoch: async (n) => ({ epoch: n, earliestS: 0 }),
    post: async () => {},
    refreshAwake: async () => false,
  };
}

function runtimeIn(dir: string, backend: Backend) {
  const cfg = parseConfig({ mode: "sim", core: "http://127.0.0.1:9", runtime_key: "k", state_dir: dir, compute_price_line_per_usd: "1", compute_price_line_per_sandbox_s: "0" });
  const runtimeKey = generateAgentKey();
  return new Runtime(cfg, { backend, runtimeKey, proposer: () => ({ name: "none", propose: async () => null }), log: () => {}, telemetry: false });
}

describe("OFF-R1 agent ids from Core never become paths outside the state directory", () => {
  test("a discovered id like ../../victim is skipped; the file it named is neither read nor overwritten", async () => {
    const d = scratch();
    const victim = join(d, "victim.json");
    const original = JSON.stringify(Array.from(generateAgentKey().secret));
    writeFileSync(victim, original);
    const rt = runtimeIn(join(d, "state"), stubBackend(["../../victim", generateAgentKey().id]));
    try {
      await (rt as unknown as { refreshAgents(): Promise<void> }).refreshAgents();
      expect(readFileSync(victim, "utf8")).toBe(original);
      expect(Object.keys((rt as unknown as { state: { agents: Record<string, unknown> } }).state.agents)).toHaveLength(1);
    } finally {
      await rt.stop();
    }
  });

  test("the key store refuses anything but a 32-byte base58 key", () => {
    const s = new StateStore(scratch(), { mode: "sim", runtime: "r", now: 0 });
    expect(() => s.keyFor("../../x")).toThrow(/not an agent id/);
    expect(isAgentId(generateAgentKey().id)).toBe(true);
    expect(isAgentId("abc")).toBe(false);
    expect(isAgentId("../x")).toBe(false);
  });
});

describe("OFF-K3, OFF-K4, OFF-R3 spend that is billed is always metered and caps hold", () => {
  test("a turn whose tool JSON fails to parse is still metered", async () => {
    const { client, calls } = fakeClient([{ usage: { input_tokens: 1000, output_tokens: 10 }, fail: true }]);
    const metered: { usd: number; output_tokens: number }[] = [];
    const ctx = proposeCtx({ maxUsd: 100, meter: { model: (u) => metered.push(u), sandbox: () => {} } });
    expect(await new AnthropicProposer({ max_usd: 100, max_turns: 3 }, client).propose(ctx)).toBeNull();
    expect(calls.length).toBe(3);
    expect(metered).toHaveLength(3);
    expect(metered.every((m) => m.output_tokens === 64000 && m.usd > 0)).toBe(true);
  });

  test("a usage block with missing or negative counts charges the rest of the cap, never NaN", async () => {
    const { client, calls } = fakeClient([{ usage: { input_tokens: undefined as unknown as number, output_tokens: -5 }, tools: [{ name: "list_files", input: {} }] }]);
    const metered: number[] = [];
    const ctx = proposeCtx({ maxUsd: 2, meter: { model: (u) => metered.push(u.usd), sandbox: () => {} } });
    expect(await new AnthropicProposer({ max_usd: 5, max_turns: 5 }, client).propose(ctx)).toBeNull();
    expect(calls.length).toBe(1);
    expect(metered).toEqual([2]);
  });

  test("a NaN spend record (saved as null) does not reset the global or epoch caps", async () => {
    const d = scratch();
    const rt = runtimeIn(d, stubBackend([]));
    const agent = generateAgentKey().id;
    const r = rt as unknown as { state: { spent_usd_total: number }; vaults: Map<string, unknown>; prices: unknown; limits: unknown };
    try {
      r.vaults.set(agent, { balance: 10n ** 15n, awake: true });
      r.limits = { decimals: 6, sleepThreshold: 0n, wakeThreshold: 0n, maxDebitPerEpoch: null };
      r.prices = { decimals: 6, perUsd: 1_000_000n, perSandboxS: 0n, perSol: 0n };
      expect(rt.budget(agent).usd).toBeGreaterThan(0);
      r.state.spent_usd_total = NaN;
      expect(rt.budget(agent).usd).toBeNull();
      r.state.spent_usd_total = null as unknown as number;
      expect(rt.budget(agent).usd).toBeNull();
    } finally {
      await rt.stop();
    }
  });
});

describe("OFF-R4 a stale runtime lock is taken over by one process only", () => {
  test("a takeover in progress by a live process refuses a second starter", async () => {
    const dir = scratch();
    const child = Bun.spawn(["bun", "-e", "await Bun.sleep(20000)"]);
    try {
      writeFileSync(join(dir, "runtime.lock"), "999999999\nx\n");
      writeFileSync(join(dir, "runtime.lock.takeover"), `${child.pid}\n`);
      expect(() => new Lock(dir).acquire()).toThrow(/being taken over/);
    } finally {
      child.kill(); // our own child, by PID
      await child.exited;
    }
    const l = new Lock(dir);
    l.acquire();
    expect(readFileSync(join(dir, "runtime.lock"), "utf8").split("\n")[0]).toBe(String(process.pid));
    expect(existsSync(join(dir, "runtime.lock.takeover"))).toBe(false);
    l.release();
  });

  test("concurrent starters on one stale lock: never two holders", async () => {
    const script = (dir: string) =>
      `import { Lock } from ${JSON.stringify(join(import.meta.dir, "../src/state.ts"))}; try { new Lock(${JSON.stringify(dir)}).acquire(); console.log("got"); await Bun.sleep(1500); } catch { console.log("no"); }`;
    for (let round = 0; round < 4; round++) {
      const dir = scratch();
      writeFileSync(join(dir, "runtime.lock"), "999999999\nstale\n");
      const ps = Array.from({ length: 6 }, () => Bun.spawn(["bun", "-e", script(dir)], { stdout: "pipe" }));
      const outs = await Promise.all(ps.map(async (p) => (await new Response(p.stdout).text()).trim()));
      expect(outs.filter((o) => o === "got").length).toBeLessThanOrEqual(1);
    }
  }, 60_000);
});

test("OFF-R5 redaction covers GitHub tokens, auth headers, path-keyed RPC URLs and config secrets", () => {
  const gh = "ghp_" + "A".repeat(36);
  expect(redact(`push failed with ${gh}`)).not.toContain(gh);
  expect(redact("github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz")).toBe("[redacted]");
  expect(redact("AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46Z2hwX3NlY3JldA==")).toBe("AUTHORIZATION: basic [redacted]");
  expect(redact("rpc https://solana-devnet.g.alchemy.com/v2/AbCdEf0123456789xyzQRS failed")).toBe("rpc https://solana-devnet.g.alchemy.com/v2/[redacted] failed");
  expect(redact("https://example.quiknode.pro/0123456789abcdef0123/")).toBe("https://example.quiknode.pro/[redacted]/");
  addSecret("https://my-private-rpc.example/secret-path-xyz");
  expect(redact("rpc https://my-private-rpc.example/secret-path-xyz down")).toBe("rpc [redacted] down");
  // ordinary text is untouched
  expect(redact("https://explorer.solana.com/tx/abc?cluster=devnet")).toBe("https://explorer.solana.com/tx/abc?cluster=devnet");
});
