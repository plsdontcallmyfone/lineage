import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calibId, generateAgentKey, recipeId, signMessage } from "@units/protocol";
import { FakeClock } from "../../core/src/clock.ts";
import { CoreClient } from "../../core/src/client.ts";
import { Core } from "../../core/src/core.ts";
import { serve } from "../../core/src/http.ts";
import { CALIB, DEPS, RECIPE, expectOk, makeAuthor, makeVerifier, testConfig } from "../../core/test/helpers.ts";
import { costOf, parseConfig, resolvePrices, Runtime, SimBackend, type SpendReport } from "../src/index.ts";

// Network compute against a real Core (plan MODELS-AND-SELF-FUNDING section D): the runtime's report
// makes Core accept the candidate of an agent whose vault is asleep, awake is never faked, an empty
// vault is not debited, and its zero leaf does not hold up the debit of another agent in the epoch.

const tmp: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "units-network-compute-core-"));
  tmp.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

describe("network compute with Core (simulated mode)", () => {
  test("covered in Core once reported; the asleep agent's candidate is accepted; usage posts for every agent; the vault never goes below zero", async () => {
    const clock = new FakeClock(Date.now());
    const adminKey = generateAgentKey();
    const runtimeKey = generateAgentKey();
    const net = testConfig();
    const dir = scratch();
    const core = new Core({ dataDir: dir, network: net, adminId: adminKey.id, runtimeId: runtimeKey.id, clock });
    const server = serve(core, { port: 0 });
    const base = `http://127.0.0.1:${server.port}`;
    const admin = { key: adminKey, id: adminKey.id, c: new CoreClient(base, adminKey, () => clock.now()) };
    const env = { core, clock, server, base, admin, cfg: net, dir, anon: new CoreClient(base, null), close: () => (server.stop(true), core.close()) };
    try {
      await expectOk(admin.c.post("/v1/admin/recipes", { recipe: RECIPE, recipe_id: recipeId(RECIPE) }));
      await expectOk(admin.c.post("/v1/admin/snapshots", { repo: RECIPE.repo, commit: RECIPE.commit, deps_digest: DEPS }));
      const ref = await makeVerifier(env, { bond: 0n });
      await expectOk(admin.c.post(`/v1/admin/agents/${ref.id}/reference`, { reference: true }));
      const lin = await expectOk(ref.c.post("/v1/calibrations", { calibration: CALIB, sig: signMessage(ref.key, calibId(CALIB.recipe_id, CALIB.snapshot_id, CALIB)) }));

      const empty = await makeAuthor(env, { hosted: true, fees: 0n }); // never funded: asleep, vault 0
      const low = await makeAuthor(env, { hosted: true, fees: 0n });
      // a little in the vault, under the wake threshold: asleep too
      const part = net.wake_threshold / 4n;
      await expectOk(admin.c.post("/v1/admin/agent-fees", { agent: low.id, amount: ((part * 10_000n) / BigInt(net.agent_compute_bps)).toString() }));
      const view = async (id: string) => expectOk(env.anon.get(`/v1/agents/${id}`));
      const lowBal = BigInt((await view(low.id)).compute);
      expect(lowBal > 0n && lowBal < net.wake_threshold).toBe(true);
      expect((await view(empty.id)).awake).toBe(false);
      expect((await view(low.id)).awake).toBe(false);

      const cfg = parseConfig({
        mode: "sim", core: base, state_dir: scratch(), runtime_key: "unused-in-tests", compute_price_line_per_usd: "4", compute_price_line_per_sandbox_s: "0.001", poll_ms: 10, sandbox_reserve_s: 100,
        global_cap_scope: "all", global_window_s: 86400, global_max_usd: 800, spend_report_s: 1, platform_funding: { enabled: true, min_interval_s: 900 }, unit_setup: { enabled: false },
      });
      const logs: string[] = [];
      const reporter = new CoreClient(base, runtimeKey);
      const rt = new Runtime(cfg, {
        backend: new SimBackend(base, runtimeKey), runtimeKey, proposer: () => ({ name: "none", propose: async () => null }), log: (m) => logs.push(m), telemetry: false,
        route: async () => ({ via: "openrouter", model: { provider: "anthropic", id: "claude-opus-5-5" }, why: null }),
        report: async (body: SpendReport) => {
          const r = await reporter.post("/v1/admin/runtime/spend", body);
          if (r.status >= 300) throw new Error(`HTTP ${r.status} ${JSON.stringify(r.body)}`);
        },
      });
      await rt.start();
      await rt.tick();
      for (const a of [empty, low]) {
        const req = JSON.parse(readFileSync(join(cfg.state_dir, "bind-requests", `${a.id}.json`), "utf8"));
        await expectOk(a.c.post(`/v1/agents/${a.id}/keys/rotate`, req.body));
      }
      const body = (c: string) => ({ lineage_id: lin.lineage_id, parent_gen_id: lin.gen0, kind: "perf", target: "ir", commitment: c.repeat(64) });
      const as = (id: string) => new CoreClient(base, { ...rt.keyOf(id)!, agent: id });
      // bound, asleep, not reported yet: Core refuses
      expect((await as(empty.id).post("/v1/candidates", body("a"))).body.error).toBe("asleep");
      await rt.tick(); // bound; the vault path is refused ("asleep"), so both are covered from here
      await Bun.sleep(1100);
      await rt.tick(); // the report with covered reaches Core
      await rt.idle();
      for (const a of [empty, low]) {
        const v = await view(a.id);
        expect(v.awake).toBe(false); // the vault decides; nothing wakes it
        expect(v.compute_covered).toBe(true);
        expect((await expectOk(env.anon.get(`/v1/agents/${a.id}/spend`))).spend).toMatchObject({ covered: { min_interval_s: 900 }, waiting: null });
      }
      expect((await expectOk(env.anon.get(`/v1/agents/${empty.id}/spend`))).spend.vault).toBe("0");
      // the candidate of the asleep, covered agent is accepted, signed by the key the runtime holds for it
      await expectOk(as(empty.id).post("/v1/candidates", body("a")));

      // usage of covered attempts: 0.30 USD each this epoch
      const usage = () => ({ input_tokens: 1000, output_tokens: 200, cache_read_tokens: 0, cache_write_tokens: 0, usd: 0.3, sandbox_s: 10, models: ["claude-opus-5-5"], attempts: 1, candidates: [] });
      rt.state.open.usage[empty.id] = usage();
      rt.state.open.usage[low.id] = usage();
      rt.store.save();
      await rt.flush();
      const cost = costOf(resolvePrices(cfg, net.token_decimals), 0.3, 10);
      expect(cost > lowBal).toBe(true);
      const e = rt.state.closed[0]!;
      expect(e.done).toBe(true);
      expect(e.leaves.find((l) => l.agent === empty.id)).toMatchObject({ amount: "0", cost: cost.toString() });
      expect(e.leaves.find((l) => l.agent === low.id)).toMatchObject({ amount: lowBal.toString(), cost: cost.toString() });
      expect(e.debits[empty.id]).toBe("none"); // no debit was sent for the empty vault
      expect(e.debits[low.id]).toMatch(/^sim:\d+$/); // and the other agent's went through
      expect((await view(empty.id)).compute).toBe("0");
      expect((await view(low.id)).compute).toBe("0"); // all it held, no more
      expect((await expectOk(env.anon.get(`/v1/agents/${empty.id}/usage`))).records.length).toBe(0);
      const rec = (await expectOk(env.anon.get(`/v1/agents/${low.id}/usage`))).records;
      expect(rec.length).toBe(1);
      expect(rec[0].amount).toBe(lowBal.toString());
      expect(rec[0].detail.cost).toBe(cost.toString()); // the public record keeps the whole cost
      expect(rt.state.subsidized_usd_total!).toBeGreaterThan(0);
      expect(core.ledger.reconcile().ok).toBe(true);

      // fees arrive: awake again, covered no more, the vault path is back
      await expectOk(admin.c.post("/v1/admin/agent-fees", { agent: empty.id, amount: ((net.wake_threshold * 10n * 10_000n) / BigInt(net.agent_compute_bps)).toString() }));
      await Bun.sleep(1100);
      await rt.tick();
      await rt.tick();
      await rt.idle();
      expect(rt.covered(empty.id)).toBe(false);
      await Bun.sleep(1100);
      await rt.tick();
      expect(await view(empty.id)).toMatchObject({ awake: true, compute_covered: false });
      await rt.stop({ flush: false });
      expect(logs.filter((l) => l.startsWith("tick:"))).toEqual([]);
    } finally {
      env.close();
    }
  }, 60_000);
});
