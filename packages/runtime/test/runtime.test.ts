import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { calibId, generateAgentKey, recipeId, signMessage, signStatement, type AgentKey } from "@lineage/protocol";
import { loadRecipe } from "@lineage/sandbox";
import { FakeClock } from "../../core/src/clock.ts";
import { CoreClient } from "../../core/src/client.ts";
import { Core } from "../../core/src/core.ts";
import { serve } from "../../core/src/http.ts";
import { CALIB, DEPS, RECIPE, expectOk, honest, makeAuthor, makeVerifier, runReplays, submit, diff, testConfig, type Env } from "../../core/test/helpers.ts";
import { fakeClient, type Turn } from "./fake.ts";
import { AnthropicProposer, MODEL_PRICES } from "../../worker/src/proposers/anthropic.ts";
import type { ProposeContext } from "../../worker/src/proposers/types.ts";
import { costOf, parseConfig, resolvePrices, SimBackend, toBase, usdFor, Lock, redact, Runtime, provenanceRecord, signProvenance, ChainBackend, type RuntimeConfig } from "../src/index.ts";

const ROOT = join(import.meta.dir, "../../..");
const tmp: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "lineage-runtime-test-"));
  tmp.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

// ------------------------------------------------------------------------------------------------
// a fake model client: scripted turns with fixed usage, no network

function proposeCtx(over: Partial<ProposeContext> = {}): { ctx: ProposeContext; logs: string[] } {
  const tree = scratch();
  writeFileSync(join(tree, "hello.txt"), "hello\n");
  const logs: string[] = [];
  const loaded = loadRecipe(join(ROOT, "recipes/fixture-b58"));
  const ctx: ProposeContext = {
    loaded,
    deps: { dir: tree, digest: "0".repeat(64) },
    calibration: { recipe_id: "", snapshot_id: "", runs: 1, stable: [], known_failures: [], quarantined: [], metrics: {}, median_eval_seconds: 1 } as never,
    parentPatches: [],
    findings: [],
    tree,
    seed: "5eed",
    log: (m) => logs.push(m),
    ...over,
  };
  return { ctx, logs };
}

// ------------------------------------------------------------------------------------------------

describe("prices and caps", () => {
  test("decimal prices resolve exactly; costs round up; budgets convert back", () => {
    expect(toBase("1.5", 6)).toBe(1_500_000n);
    expect(toBase("20", 9)).toBe(20_000_000_000n);
    expect(() => toBase("0.0000001", 6)).toThrow();
    const p = { decimals: 6, perUsd: 2_000_000n, perSandboxS: 1_000n };
    // 0.1234567 USD -> 123457 micro USD (up) -> 246914 base units; 10.2 s -> 11 s
    expect(costOf(p, 0.1234567, 10.2)).toBe(246_914n + 11_000n);
    expect(costOf(p, 0, 0)).toBe(0n);
    expect(usdFor(p, 2_600_000n, 600)).toBe(1); // 2.6M - 600 s x 1000 = 2.0M -> 1 USD
    expect(usdFor(p, 500_000n, 600)).toBe(0);
  });

  test("config validation refuses missing prices", () => {
    expect(() => parseConfig({ mode: "sim", core: "http://x", runtime_key: "k" })).toThrow(/compute_price/);
    const c = parseConfig({ mode: "sim", core: "http://x", runtime_key: "~/k.json", compute_price_line_per_usd: "4", compute_price_line_per_sandbox_s: "0.001" });
    expect(c.runtime_key.startsWith("/")).toBe(true);
    expect(c.attempt_max_usd).toBe(1);
  });
});

describe("operational safety", () => {
  test("redact removes model keys and secret env values", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-0123456789abcdefghij";
    expect(redact(`key=${process.env.ANTHROPIC_API_KEY} ok`)).toBe("key=[redacted] ok");
    expect(redact("https://devnet.helius-rpc.com/?api-key=abcdef123456")).toBe("https://devnet.helius-rpc.com/?api-key=[redacted]");
    delete process.env.ANTHROPIC_API_KEY;
  });

  test("one process per runtime: a live holder blocks, a stale lock is taken over", async () => {
    const dir = scratch();
    const child = Bun.spawn(["bun", "-e", "await Bun.sleep(20000)"]);
    try {
      writeFileSync(join(dir, "runtime.lock"), `${child.pid}\nx\n`);
      expect(() => new Lock(dir).acquire()).toThrow(/locked by live pid/);
    } finally {
      child.kill(); // our own child, by PID
      await child.exited;
    }
    const l = new Lock(dir);
    l.acquire(); // the dead pid's lock is stale
    expect(readFileSync(join(dir, "runtime.lock"), "utf8").startsWith(String(process.pid))).toBe(true);
    l.release();
    expect(existsSync(join(dir, "runtime.lock"))).toBe(false);
  });
});

describe("Claude proposer metering (fake model client)", () => {
  test("every response is metered; the projected cap stops before a turn that would cross it", async () => {
    const turn: Turn = { tools: [{ name: "read_file", input: { path: "hello.txt" } }], usage: { input_tokens: 100_000, output_tokens: 10_000 } };
    const { client, calls } = fakeClient([turn, turn, turn]);
    const metered: number[] = [];
    const { ctx, logs } = proposeCtx({ maxUsd: 1, meter: { model: (u) => metered.push(u.usd), sandbox: () => {} } });
    const p = new AnthropicProposer({ max_usd: 5 }, client);
    expect(await p.propose(ctx)).toBeNull();
    // 100k in x 4 + 10k out x 20 per million = 0.6 USD; a second turn would reach 1.2 > 1.0
    expect(calls.length).toBe(1);
    expect(metered).toEqual([0.6]);
    expect(logs.some((l) => l.includes("spend cap reached"))).toBe(true);
  });

  test("a response from another model (refusal fallback) is priced at that model's rate; give_up still meters", async () => {
    const { client } = fakeClient([{ tools: [{ name: "give_up", input: { reason: "nothing measurable" } }], usage: { input_tokens: 1_000_000, output_tokens: 0 }, model: "claude-opus-5" }]);
    const seen: { usd: number; model: string }[] = [];
    const { ctx } = proposeCtx({ meter: { model: (u) => seen.push(u), sandbox: () => {} } });
    expect(await new AnthropicProposer({ max_usd: 10 }, client).propose(ctx)).toBeNull();
    expect(seen).toEqual([expect.objectContaining({ model: "claude-opus-5", usd: MODEL_PRICES["claude-opus-5"]!.input })]);
  });
});

// ------------------------------------------------------------------------------------------------
// Core with a runtime authority (simulated mode)

interface RtEnv extends Env {
  runtimeKey: AgentKey;
}

async function rtSetup(): Promise<RtEnv> {
  const dir = scratch();
  const clock = new FakeClock(Date.now()); // the runtime signs with wall-clock nonces
  const adminKey = generateAgentKey();
  const runtimeKey = generateAgentKey();
  const cfg = testConfig();
  const core = new Core({ dataDir: dir, network: cfg, adminId: adminKey.id, runtimeId: runtimeKey.id, clock });
  const server = serve(core, { port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  const admin = { key: adminKey, id: adminKey.id, c: new CoreClient(base, adminKey, () => clock.now()) };
  const b = { core, clock, server, base, admin, dir, cfg, anon: new CoreClient(base, null), close: () => (server.stop(true), core.close()) };
  await expectOk(admin.c.post("/v1/admin/recipes", { recipe: RECIPE, recipe_id: recipeId(RECIPE) }));
  await expectOk(admin.c.post("/v1/admin/snapshots", { repo: RECIPE.repo, commit: RECIPE.commit, deps_digest: DEPS }));
  const ref = await makeVerifier(b, { bond: 0n });
  await expectOk(admin.c.post(`/v1/admin/agents/${ref.id}/reference`, { reference: true }));
  const lin = await expectOk(ref.c.post("/v1/calibrations", { calibration: CALIB, sig: signMessage(ref.key, calibId(CALIB.recipe_id, CALIB.snapshot_id, CALIB)) }));
  const verifiers = [];
  for (let i = 0; i < 4; i++) verifiers.push(await makeVerifier(b));
  return { ...b, verifiers, reference: ref, lineage: lin.lineage_id, gen0: lin.gen0, runtimeKey };
}

function rtConfig(env: RtEnv, over: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return parseConfig({
    mode: "sim",
    core: env.base,
    state_dir: scratch(),
    runtime_key: "unused-in-tests",
    compute_price_line_per_usd: "4", // TEST
    compute_price_line_per_sandbox_s: "0.001", // TEST
    poll_ms: 10,
    sandbox_reserve_s: 100,
    ...over,
  });
}

describe("hosted runtime, simulated mode", () => {
  test("discovers, waits for the owner's binding, meters into usage records, sleeps when drained, wakes on fees, survives a restart", async () => {
    const env = await rtSetup();
    try {
      const author = await makeAuthor(env, { hosted: true });
      const selfHosted = await makeAuthor(env, { hosted: false });
      const cfg = rtConfig(env);
      const logs: string[] = [];
      const deps = { backend: new SimBackend(env.base, env.runtimeKey), runtimeKey: env.runtimeKey, proposer: () => ({ name: "none", propose: async () => null }), log: (m: string) => logs.push(m), telemetry: false };
      let rt = new Runtime(cfg, deps);
      await rt.start();
      await rt.tick();
      const st = rt.state.agents[author.id]!;
      expect(st.status).toBe("awaiting_owner");
      expect(rt.state.agents[selfHosted.id]).toBeUndefined(); // self-hosted agents run elsewhere
      expect(rt.budget(author.id).usd).toBeNull(); // not bound: no vault read, no authoring
      // the launcher binds the agent: its own key signs the request, the runtime key signed the statement
      const req = JSON.parse(readFileSync(join(cfg.state_dir, "bind-requests", `${author.id}.json`), "utf8"));
      expect(req.body.new_key).toBe(st.key_id);
      expect(JSON.stringify(req)).not.toContain("secret");
      await expectOk(author.c.post(`/v1/agents/${author.id}/keys/rotate`, req.body));
      await rt.tick();
      expect(rt.state.agents[author.id]!.status).toBe("bound");
      const view0 = await expectOk(env.anon.get(`/v1/agents/${author.id}`));
      const bal0 = BigInt(view0.compute);
      expect(view0.awake).toBe(true);
      // the vault pays: (balance - 100 s x 0.001) / 4 $LINE per USD, capped at attempt_max_usd 1
      const prices = resolvePrices(cfg, env.cfg.token_decimals);
      expect(rt.budget(author.id).usd).toBe(Math.min(1, usdFor(prices, bal0, 100)));
      // metered usage (as the proposer reports it) drains the vault below sleep_threshold
      const drainUsd = Number(((bal0 - env.cfg.sleep_threshold + 1n) * 1_000_000n) / prices.perUsd) / 1e6 + 0.000001;
      rt.state.open.usage[author.id] = { input_tokens: 1000, output_tokens: 200, cache_read_tokens: 3000, cache_write_tokens: 400, usd: drainUsd, sandbox_s: 12.3, models: ["claude-opus-5-5"], attempts: 1, candidates: [] };
      rt.store.save();
      await rt.flush();
      const cost = costOf(prices, drainUsd, 12.3);
      const usage = await expectOk(env.anon.get(`/v1/agents/${author.id}/usage`));
      expect(usage.records.length).toBe(1);
      expect(usage.records[0].amount).toBe(cost.toString());
      expect(usage.records[0].model_tokens).toBe(4600);
      expect(usage.records[0].sandbox_seconds).toBe(13);
      expect(usage.records[0].detail.usd).toBe(drainUsd.toFixed(6));
      const view1 = await expectOk(env.anon.get(`/v1/agents/${author.id}`));
      expect(BigInt(view1.compute)).toBe(bal0 - cost);
      expect(view1.awake).toBe(false);
      expect(rt.state.closed[0]!.done).toBe(true);
      // reposting the same record (a crashed runtime) is idempotent in Core
      const again = await new CoreClient(env.base, env.runtimeKey).post("/v1/admin/usage", { agent: author.id, amount: cost.toString(), ref: `runtime:${env.runtimeKey.id}:0:${author.id}` });
      expect(again.body.duplicate).toBe(true);
      expect((await expectOk(env.anon.get(`/v1/agents/${author.id}/usage`))).records.length).toBe(1);
      await rt.tick();
      expect(rt.budget(author.id)).toEqual(expect.objectContaining({ usd: null, why: "asleep" }));
      // crash and restart: state comes back, the agent stays bound, nothing is posted twice
      await rt.stop({ flush: false });
      rt = new Runtime(cfg, deps);
      await rt.start();
      expect(rt.state.agents[author.id]!.status).toBe("bound");
      await rt.tick();
      expect(rt.budget(author.id)).toEqual(expect.objectContaining({ usd: null, why: "asleep" }));
      expect((await expectOk(env.anon.get(`/v1/agents/${author.id}/usage`))).records.length).toBe(1);
      // new fees wake it
      await expectOk(env.admin.c.post("/v1/admin/agent-fees", { agent: author.id, amount: ((env.cfg.wake_threshold * 10_000n) / 7000n + 1n).toString() }));
      await rt.tick();
      expect((rt.budget(author.id).usd ?? 0) > 0).toBe(true);
      expect(logs.some((l) => l.includes("is awake"))).toBe(true);
      // the global cap holds across restarts
      rt.state.spent_usd_total = cfg.global_max_usd;
      expect(rt.budget(author.id)).toEqual(expect.objectContaining({ usd: null }));
      await rt.stop({ flush: false });
      expect(logs.join("\n")).not.toMatch(/sk-ant-/);
    } finally {
      env.close();
    }
  }, 60_000);
});

describe("provenance (identity plan I5)", () => {
  test("the runtime attests hosted candidates; Core publishes the record only once final; self-hosted authors claim their own", async () => {
    const env = await rtSetup();
    try {
      const author = await makeAuthor(env, { hosted: true });
      const c = await submit(env, author, diff("p1"), { target: "ir" });
      const record = provenanceRecord({
        commit_id: c.commit_id,
        agent: author.id,
        recipe_id: recipeId(RECIPE),
        lineage_id: env.lineage,
        totals: { input_tokens: 10, output_tokens: 20, cache_read_tokens: 30, cache_write_tokens: 40, usd: 0.0123, sandbox_s: 41.2, models: ["claude-opus-5-5"], started_at: 1, finished_at: 2 },
        amount: 49_200_000n,
        price: { line_per_usd: "4", line_per_sandbox_s: "0.001" },
        requestedModel: "claude-opus-5-5",
      });
      const rtc = new CoreClient(env.base, env.runtimeKey);
      const other = generateAgentKey();
      expect((await rtc.post(`/v1/candidates/${c.commit_id}/provenance`, { record, sig: signStatement(other, "provenance", record) })).status).toBe(403);
      expect((await author.c.post(`/v1/candidates/${c.commit_id}/provenance`, { record, sig: signProvenance(author.key, record) })).status).toBe(403); // hosted is attested, not claimed
      expect((await rtc.post(`/v1/candidates/${c.commit_id}/provenance`, { record: { ...record, recipe_id: "0".repeat(64) }, sig: signProvenance(env.runtimeKey, record) })).status).toBe(400);
      await expectOk(rtc.post(`/v1/candidates/${c.commit_id}/provenance`, { record, sig: signProvenance(env.runtimeKey, record) }));
      expect((await rtc.post(`/v1/candidates/${c.commit_id}/provenance`, { record, sig: signProvenance(env.runtimeKey, record) })).status).toBe(409);
      // open: withheld from the public and from verifiers, visible to the author and the runtime
      const anonOpen = await env.anon.get(`/v1/candidates/${c.commit_id}/provenance`);
      expect(anonOpen.status).toBe(409);
      expect(anonOpen.body.error).toBe("not_final");
      expect((await env.verifiers[0]!.c.get(`/v1/candidates/${c.commit_id}/provenance`, true)).status).toBe(409);
      expect((await author.c.get(`/v1/candidates/${c.commit_id}/provenance`, true)).status).toBe(200);
      // final: public, by commit id or candidate id
      await runReplays(env, c.candidate_id, honest());
      const pub = await expectOk(env.anon.get(`/v1/candidates/${c.candidate_id}/provenance`));
      expect(pub.runtime).toBe("hosted");
      expect(pub.signer).toBe(env.runtimeKey.id);
      expect(pub.record).toEqual(record);
      expect(pub.status).toBe("accepted");
      // a candidate without a record is 404 once final
      const c2 = await submit(env, author, diff("p2", "src/b.rs"), { target: "ir" });
      await runReplays(env, c2.candidate_id, honest());
      expect((await env.anon.get(`/v1/candidates/${c2.commit_id}/provenance`)).status).toBe(404);
      // a self-hosted author claims its own record
      const self = await makeAuthor(env, { hosted: false });
      const c3 = await submit(env, self, diff("p3", "src/c.rs"), { target: "ir" });
      const claim = { ...record, commit_id: c3.commit_id, agent: self.id, runtime: "self" as const };
      await expectOk(self.c.post(`/v1/candidates/${c3.commit_id}/provenance`, { record: claim, sig: signStatement(self.key, "provenance", claim) }));
      expect((await self.c.get(`/v1/candidates/${c3.commit_id}/provenance`, true)).body.attestation).toBe("claimed by the agent");
    } finally {
      env.close();
    }
  }, 60_000);
});

describe("devnet usage tree", () => {
  test("one leaf per agent with usage, sorted by hash, proofs verify against the root", async () => {
    const { verifyProof } = await import("@lineage/protocol");
    const a = generateAgentKey().id;
    const b = generateAgentKey().id;
    const e = {
      epoch: 7,
      opened_at: 0,
      closed_at: 0,
      root: null,
      post: null,
      debits: {},
      done: false,
      leaves: [
        { agent: a, amount: "1000", cost: "1000", model_tokens: 10, sandbox_s: 2, usd: 0.1 },
        { agent: b, amount: "2500", cost: "2500", model_tokens: 99, sandbox_s: 0, usd: 0.2 },
        { agent: generateAgentKey().id, amount: "0", cost: "0", model_tokens: 0, sandbox_s: 0, usd: 0 },
      ],
    };
    const t = ChainBackend.tree(e);
    expect(t.items.length).toBe(2);
    for (const it of t.items) expect(verifyProof(it.h, it.proof, t.root)).toBe(true);
  });
});
