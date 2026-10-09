import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calibId, generateAgentKey, recipeId, signMessage } from "@lineage/protocol";
import { FakeClock } from "../../core/src/clock.ts";
import { CoreClient } from "../../core/src/client.ts";
import { Core } from "../../core/src/core.ts";
import { serve } from "../../core/src/http.ts";
import { CALIB, DEPS, RECIPE, expectOk, makeAuthor, makeVerifier, testConfig } from "../../core/test/helpers.ts";
import { costOf, parseConfig, resolvePrices, Runtime, SimBackend } from "../../runtime/src/index.ts";
import { FundingStore, tradeShareOf } from "../src/funding.ts";
import { forwardAmount } from "../src/glue.ts";

// Treasury funding by a share of fee income (plan T): the share rides the usage leaf as the line
// "trade share", is debited with the compute usage and forwarded from the sink to the treasury.

const tmp: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "lineage-share-test-"));
  tmp.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

describe("trade share", () => {
  test("bps of new fee income only; never below the wake threshold (compute first); a skipped share stays owed", () => {
    const base = { mint: "M", baseline: 1000n, bps: 1000, vault: 10_000n, computeOwed: 0n, wake: 1000n };
    const s = tradeShareOf({ ...base, toCompute: 3000n });
    expect(s.amount).toBe(200n);
    expect(s.amount !== null && s.basis).toEqual({ mint: "M", to_compute_from: "1000", to_compute_to: "3000", bps: 1000 });
    expect(tradeShareOf({ ...base, toCompute: 1000n }).amount).toBeNull();
    expect(tradeShareOf({ ...base, toCompute: 3000n, bps: 0 }).amount).toBeNull();
    // compute owes 8,900: 10,000 - 8,900 - 200 < 1,000, so the share waits
    const starve = tradeShareOf({ ...base, toCompute: 3000n, computeOwed: 8_900n });
    expect(starve.amount).toBeNull();
    expect(starve.amount === null && starve.why).toMatch(/wake threshold/);
    // the baseline: first sight starts at the current income (no share of fees earned before trading); it moves only on commit
    const st = new FundingStore(join(scratch(), "f.json"));
    expect(st.baseline("A", 5000n, 1)).toBe(5000n);
    expect(st.baseline("A", 9000n, 2)).toBe(5000n);
    st.commit("A", "9000", 3);
    expect(st.baseline("A", 9500n, 4)).toBe(9000n);
    st.commit("A", "100", 5); // never backwards
    expect(st.baseline("A", 9500n, 6)).toBe(9000n);
  });

  test("what reaches the treasury: the share, or what was left after compute when the vault ran short", () => {
    expect(forwardAmount({ amount: "1200", cost: "1200", trade_share: "200" })).toBe(200n);
    expect(forwardAmount({ amount: "1100", cost: "1200", trade_share: "200" })).toBe(100n);
    expect(forwardAmount({ amount: "900", cost: "1200", trade_share: "200" })).toBe(0n);
  });

  test("the runtime adds the share to the agent's usage leaf and forwards it once the debit landed", async () => {
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
      await expectOk(ref.c.post("/v1/calibrations", { calibration: CALIB, sig: signMessage(ref.key, calibId(CALIB.recipe_id, CALIB.snapshot_id, CALIB)) }));
      // fee income well above the wake threshold, so the share does not have to wait for compute
      const author = await makeAuthor(env, { hosted: true, fees: ncfg.wake_threshold * 100n });
      const cfg = parseConfig({ mode: "sim", core: base, state_dir: scratch(), runtime_key: "unused", poll_ms: 10, sandbox_reserve_s: 100, usage_epoch_s: 60,
        compute_price_line_per_usd: "4", compute_price_line_per_sandbox_s: "0.001" });
      const forwarded: { agent: string; share: string; debit: string }[] = [];
      const trading = {
        share: async (o: { agent: string; vault: bigint; computeOwed: bigint; wake: bigint }) => {
          const s = tradeShareOf({ mint: "M", toCompute: 5_000_000n, baseline: 1_000_000n, bps: 1000, vault: o.vault, computeOwed: o.computeOwed, wake: o.wake });
          return s.amount === null ? null : { amount: s.amount, basis: s.basis };
        },
        forward: async (epochs: any[], save: () => void) => {
          for (const e of epochs)
            for (const l of e.leaves) {
              if (!l.trade_share || l.trade_forward !== undefined || !e.debits[l.agent]) continue;
              forwarded.push({ agent: l.agent, share: l.trade_share, debit: e.debits[l.agent] });
              l.trade_forward = "sig-forward";
              save();
            }
        },
      };
      const rt = new Runtime(cfg, { backend: new SimBackend(base, runtimeKey), runtimeKey, proposer: () => ({ name: "none", propose: async () => null }), log: () => {}, telemetry: false, trading, now: () => clock.now() });
      await rt.start();
      await rt.tick();
      const req = JSON.parse(readFileSync(join(cfg.state_dir, "bind-requests", `${author.id}.json`), "utf8"));
      await expectOk(author.c.post(`/v1/agents/${author.id}/keys/rotate`, req.body));
      await rt.tick();
      clock.advance(61_000);
      await rt.tick();
      const e = rt.state.closed.at(-1)!;
      const leaf = e.leaves.find((l) => l.agent === author.id)!;
      expect(leaf.trade_share).toBe("400000");
      // no compute usage this epoch: the leaf is the share alone, and it was debited
      expect(BigInt(leaf.cost)).toBe(costOf(resolvePrices(cfg, ncfg.token_decimals), 0, 0) + 400_000n);
      expect(leaf.amount).toBe(leaf.cost);
      expect(e.debits[author.id]).toMatch(/^sim:/);
      expect(forwarded).toEqual([{ agent: author.id, share: "400000", debit: e.debits[author.id]! }]);
      // Core's public usage record carries the amount
      const usage = await expectOk(env.anon.get(`/v1/agents/${author.id}/usage`));
      expect(JSON.stringify(usage)).toContain("400000");
      // idempotent: another tick forwards nothing twice
      await rt.tick();
      expect(forwarded).toHaveLength(1);
      await rt.stop({ flush: false });
    } finally {
      env.close();
    }
  }, 60_000);
});
