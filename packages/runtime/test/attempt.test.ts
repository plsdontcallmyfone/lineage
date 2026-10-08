import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calibId, generateAgentKey, H, signMessage } from "@lineage/protocol";
import { applyPatch, loadRecipe, materialize, newWorkDir, prepareDeps, removeTree } from "@lineage/sandbox";
import { FakeClock } from "../../core/src/clock.ts";
import { CoreClient } from "../../core/src/client.ts";
import { Core } from "../../core/src/core.ts";
import { serve } from "../../core/src/http.ts";
import { expectOk, testConfig } from "../../core/test/helpers.ts";
import { AnthropicProposer, HARNESS_DIGEST } from "../../worker/src/proposers/anthropic.ts";
import { costOf, parseConfig, resolvePrices, Runtime, SimBackend } from "../src/index.ts";
import { fakeClient } from "./fake.ts";

// One full hosted attempt in the real sandbox with a fake model client: the runtime binds the agent,
// the Claude proposer (scripted responses, no network) edits, evaluates in Docker and submits, the
// runtime meters model usage and sandbox seconds, stores signed provenance and posts the usage record.

const ROOT = join(import.meta.dir, "../../..");
const dockerUp = Bun.spawnSync(["docker", "info"]).exitCode === 0;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(!dockerUp)("hosted attempt in the sandbox (fake model client)", () => {
  test("binds, authors a candidate, meters tokens and sandbox seconds, attests provenance, posts usage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lineage-runtime-attempt-"));
    dirs.push(dir);
    const clock = new FakeClock(Date.now());
    const admin = generateAgentKey();
    const runtimeKey = generateAgentKey();
    const cfgNet = testConfig();
    const core = new Core({ dataDir: join(dir, "core"), network: cfgNet, adminId: admin.id, runtimeId: runtimeKey.id, clock });
    const server = serve(core, { port: 0 });
    const base = `http://127.0.0.1:${server.port}`;
    const A = new CoreClient(base, admin);
    const anon = new CoreClient(base, null);
    try {
      const loaded = loadRecipe(join(ROOT, "recipes/fixture-b58"));
      const deps = await prepareDeps(loaded);
      await expectOk(A.post("/v1/admin/recipes", { recipe: loaded.recipe, recipe_id: loaded.recipe_id }));
      const snap = await expectOk(A.post("/v1/admin/snapshots", { repo: loaded.recipe.repo, commit: loaded.recipe.commit, deps_digest: deps.digest }));
      const ref = generateAgentKey();
      await expectOk(A.post("/v1/admin/faucet", { agent: ref.id, amount: cfgNet.register_burn.toString() }));
      await expectOk(new CoreClient(base, ref).post("/v1/agents", {}));
      await expectOk(A.post(`/v1/admin/agents/${ref.id}/reference`, { reference: true }));
      const calibration = { ...JSON.parse(readFileSync(join(ROOT, "recipes/fixture-b58/calibration.json"), "utf8")), snapshot_id: snap.snapshot_id, seed: H("calibration", snap.snapshot_id) };
      await expectOk(new CoreClient(base, ref).post("/v1/calibrations", { calibration, sig: signMessage(ref, calibId(loaded.recipe_id, snap.snapshot_id, calibration)) }));
      const agentKey = generateAgentKey();
      await expectOk(A.post("/v1/admin/launches", { agent: agentKey.id, mint: generateAgentKey().id, launcher: generateAgentKey().id, target_repo: loaded.recipe.repo, hosted: true, identity_mode: "app" }));
      await expectOk(A.post("/v1/admin/agent-fees", { agent: agentKey.id, amount: "100000000000" }));

      // the patched file the fake model will write: the fixture's perf_encode patch applied to gen 0
      const work = newWorkDir("runtime-test");
      materialize(loaded.recipe.repo, loaded.recipe.commit, loaded.overlayDir, join(work, "src"));
      expect(applyPatch(join(work, "src"), readFileSync(join(ROOT, "fixtures/b58-patches/perf_encode.diff"), "utf8"))).toBe(true);
      const patched = readFileSync(join(work, "src/src/lib.rs"), "utf8");
      removeTree(work);
      const usage = { input_tokens: 2000, output_tokens: 1000, cache_read_input_tokens: 5000, cache_creation_input_tokens: 1000 };
      const { client, calls } = fakeClient([
        { tools: [{ name: "write_file", input: { path: "src/lib.rs", contents: patched } }], usage },
        { tools: [{ name: "evaluate", input: { kind: "perf", target: "encode_ir" } }], usage },
        { tools: [{ name: "submit", input: { kind: "perf", target: "encode_ir", rationale: "build the string once" } }], usage },
      ]);
      const cfg = parseConfig({
        mode: "sim",
        core: base,
        state_dir: join(dir, "rt"),
        runtime_key: "unused",
        compute_price_line_per_usd: "4", // TEST
        compute_price_line_per_sandbox_s: "0.001", // TEST
        poll_ms: 10,
        max_candidates_per_agent: 1,
      });
      const logs: string[] = [];
      const rt = new Runtime(cfg, { backend: new SimBackend(base, runtimeKey), runtimeKey, proposer: () => new AnthropicProposer({ max_usd: 1 }, client), log: (m) => logs.push(m) });
      await rt.start();
      await rt.tick();
      const req = JSON.parse(readFileSync(join(cfg.state_dir, "bind-requests", `${agentKey.id}.json`), "utf8"));
      await expectOk(new CoreClient(base, agentKey).post(`/v1/agents/${agentKey.id}/keys/rotate`, req.body));
      await rt.tick();
      await rt.idle();
      expect(calls.length).toBe(3);
      const st = rt.state.open.usage[agentKey.id]!;
      // 3 x (2000 x 4 + 1000 x 20 + 5000 x 0.2 + 1000 x 5) / 1e6 = 0.102 USD
      expect(st.usd).toBeCloseTo(0.102, 9);
      expect(st.sandbox_s).toBeGreaterThan(0);
      expect(st.candidates.length).toBe(1);
      const commit = st.candidates[0]!;
      // the candidate was signed by the runtime key under the agent's unchanged id
      const mine = await expectOk(new CoreClient(base, { ...rt.store.keyFor(agentKey.id), agent: agentKey.id } as never).get(`/v1/candidates/${commit}`, true));
      expect(mine.author).toBe(agentKey.id);
      // provenance: stored, withheld while open, signed by the runtime authority
      expect((await anon.get(`/v1/candidates/${commit}/provenance`)).status).toBe(409);
      const prov = await expectOk(new CoreClient(base, runtimeKey).get(`/v1/candidates/${commit}/provenance`, true));
      const prices = resolvePrices(cfg, cfgNet.token_decimals);
      expect(prov.signer).toBe(runtimeKey.id);
      expect(prov.record.models).toEqual(["claude-opus-5-5"]);
      expect(prov.record.harness_digest).toBe(HARNESS_DIGEST);
      expect(prov.record.recipe_id).toBe(loaded.recipe_id);
      expect(prov.record.usage).toEqual({ input_tokens: 6000, output_tokens: 3000, cache_read_tokens: 15000, cache_write_tokens: 3000 });
      expect(prov.record.spend.amount).toBe(costOf(prices, st.usd, st.sandbox_s).toString());
      // heartbeats as the author, signed by the runtime key
      const hb = core.live.machineView(agentKey.id, { full: true }) as { job?: string } | null;
      expect(hb).not.toBeNull();
      // usage posted for the epoch equals the provenance spend
      await rt.flush();
      const u = await expectOk(anon.get(`/v1/agents/${agentKey.id}/usage`));
      expect(u.records[0].amount).toBe(prov.record.spend.amount);
      await rt.stop();
      expect(logs.join("\n")).not.toMatch(/sk-ant-/);
    } finally {
      server.stop(true);
      core.close();
    }
  }, 600_000);
});
