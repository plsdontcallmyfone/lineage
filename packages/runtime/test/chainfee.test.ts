import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calibId, generateAgentKey, recipeId, signMessage } from "@lineage/protocol";
import { FakeClock } from "../../core/src/clock.ts";
import { CoreClient } from "../../core/src/client.ts";
import { Core } from "../../core/src/core.ts";
import { serve } from "../../core/src/http.ts";
import type { ChainFee, Messenger } from "../../core/src/msgchain.ts";
import { CALIB, DEPS, RECIPE, expectOk, makeAuthor, makeVerifier, testConfig } from "../../core/test/helpers.ts";
import { chainCostOf, costOf, parseConfig, resolvePrices, Runtime, SimBackend } from "../src/index.ts";

// Usage line kind "chain fee" (SPEC 12.5, 17.2): lamports the runtime pays as fee payer for a hosted
// agent's onchain messages are billed to that agent's compute vault like model tokens, at
// `compute_price_line_per_sol` (TEST value), and appear in its usage leaf's amount.

const tmp: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "lineage-chainfee-test-"));
  tmp.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

describe("chain fee usage line", () => {
  test("lamports convert at the per-SOL price, rounded up; absent price bills nothing", () => {
    const p = { decimals: 6, perUsd: 0n, perSandboxS: 0n, perSol: 2_000_000n }; // 2 $LINE per SOL
    expect(chainCostOf(p, 10_000)).toBe(20n); // 0.00001 SOL -> 0.00002 $LINE = 20 base units
    expect(chainCostOf(p, 1)).toBe(1n);
    expect(chainCostOf(p, 0)).toBe(0n);
    expect(chainCostOf({ ...p, perSol: undefined }, 10_000)).toBe(0n);
    expect(() => parseConfig({ mode: "sim", core: "http://x", runtime_key: "k", compute_price_line_per_usd: "1", compute_price_line_per_sandbox_s: "0", compute_price_line_per_sol: "x" })).toThrow(/per_sol/);
    const c = parseConfig({ mode: "sim", core: "http://x", runtime_key: "k", compute_price_line_per_usd: "1", compute_price_line_per_sandbox_s: "0", compute_price_line_per_sol: "2" });
    expect(resolvePrices(c, 6).perSol).toBe(2_000_000n);
  });

  test("a hosted agent's message fees are metered into its usage and its closed usage leaf", async () => {
    const dir = scratch();
    const clock = new FakeClock(Date.now());
    const adminKey = generateAgentKey();
    const runtimeKey = generateAgentKey();
    const ncfg = testConfig();
    const core = new Core({ dataDir: dir, network: ncfg, adminId: adminKey.id, runtimeId: runtimeKey.id, clock });
    const server = serve(core, { port: 0 });
    const base = `http://127.0.0.1:${server.port}`;
    const admin = { key: adminKey, id: adminKey.id, c: new CoreClient(base, adminKey, () => clock.now()) };
    const env = { core, clock, server, base, admin, dir, cfg: ncfg, anon: new CoreClient(base, null), close: () => (server.stop(true), core.close()) };
    try {
      await expectOk(admin.c.post("/v1/admin/recipes", { recipe: RECIPE, recipe_id: recipeId(RECIPE) }));
      await expectOk(admin.c.post("/v1/admin/snapshots", { repo: RECIPE.repo, commit: RECIPE.commit, deps_digest: DEPS }));
      const ref = await makeVerifier(env, { bond: 0n });
      await expectOk(admin.c.post(`/v1/admin/agents/${ref.id}/reference`, { reference: true }));
      const lin = await expectOk(ref.c.post("/v1/calibrations", { calibration: CALIB, sig: signMessage(ref.key, calibId(CALIB.recipe_id, CALIB.snapshot_id, CALIB)) }));
      const author = await makeAuthor(env, { hosted: true });
      const cfg = parseConfig({
        mode: "sim", core: base, state_dir: scratch(), runtime_key: "unused", poll_ms: 10, sandbox_reserve_s: 100,
        compute_price_line_per_usd: "4", compute_price_line_per_sandbox_s: "0.001", compute_price_line_per_sol: "2", // TEST
      });
      const sent: string[] = [];
      const messenger = (agent: string, _key: unknown, onFee: (f: ChainFee) => void): Messenger => ({
        publishKey: async () => onFee({ agent, lamports: 1_500_000, signature: "keysig", what: "enc_key" }), // fee plus the state's rent, once
        send: async (to, text) => {
          sent.push(`${to} ${text}`);
          onFee({ agent, lamports: 10_000, signature: `sig${sent.length}`, what: to.startsWith("board:") ? "board" : "dm" });
          return "m";
        },
      });
      const rt = new Runtime(cfg, { backend: new SimBackend(base, runtimeKey), runtimeKey, proposer: () => ({ name: "none", propose: async () => null }), log: () => {}, telemetry: false, messenger });
      await rt.start();
      await rt.tick();
      const req = JSON.parse(readFileSync(join(cfg.state_dir, "bind-requests", `${author.id}.json`), "utf8"));
      await expectOk(author.c.post(`/v1/agents/${author.id}/keys/rotate`, req.body));
      await rt.tick();
      const owedBefore = rt.owed(author.id);
      const w = (rt as unknown as { worker(a: string): { ensureEncryptionKey(): Promise<unknown>; send(t: string, x: string): Promise<string | null> } }).worker(author.id);
      await w.ensureEncryptionKey();
      expect(await w.send(`board:${lin.lineage_id}`, "on chain")).toBe("m");
      const u = rt.state.open.usage[author.id]!;
      expect([u.chain_lamports, u.chain_txs]).toEqual([1_510_000, 2]);
      const prices = resolvePrices(cfg, ncfg.token_decimals);
      expect(rt.owed(author.id) - owedBefore).toBe(chainCostOf(prices, 1_510_000));
      expect(chainCostOf(prices, 1_510_000)).toBeGreaterThan(0n);
      await rt.flush();
      const leaf = rt.state.closed.at(-1)!.leaves.find((l) => l.agent === author.id)!;
      expect(leaf.chain_lamports).toBe(1_510_000);
      expect(BigInt(leaf.cost)).toBe(costOf(prices, 0, 0) + chainCostOf(prices, 1_510_000));
      await rt.stop({ flush: false });
    } finally {
      env.close();
    }
  }, 60_000);
});
