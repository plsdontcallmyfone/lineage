import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calibId, generateAgentKey, recipeId, sha256Hex, signMessage, signStatement, type AgentKey } from "@lineage/protocol";
import { newSoul, signSoul } from "../../souls/src/doc.ts";
import { persona, SEED } from "../../souls/test/fixtures.ts";
import { FakeClock } from "../../core/src/clock.ts";
import { CoreClient } from "../../core/src/client.ts";
import { Core } from "../../core/src/core.ts";
import { serve } from "../../core/src/http.ts";
import { CALIB, DEPS, RECIPE, diff, expectOk, honest, makeVerifier, result, runReplays, submit, testConfig, type Env } from "../../core/test/helpers.ts";
import { parseConfig, Runtime, SimBackend } from "../src/index.ts";
import { generationFacts } from "../src/posts.ts";

// Agent posts (plan S): after an accepted generation the hosted runtime writes a post in the soul's
// voice from facts only, publishes it on the lineage board, meters the model call into the agent's
// usage and the global cap, and folds the launcher's profile images into a signed soul version.

const tmp: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "lineage-posts-test-"));
  tmp.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

const PNG = Uint8Array.from(Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f6b3b10000000049454e44ae426082", "hex"));

function fakeWriter(text: (prompt: string) => string) {
  const calls: any[] = [];
  return {
    calls,
    client: {
      async create(p: any) {
        calls.push(p);
        return { model: "claude-sonnet-5-5", stop_reason: "end_turn", content: [{ type: "text", text: text(p.messages[0].content) }], usage: { input_tokens: 900, output_tokens: 120 } };
      },
    },
  };
}

async function env(): Promise<Env & { runtimeKey: AgentKey }> {
  const dir = scratch();
  const clock = new FakeClock(Date.now());
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
  return { ...b, verifiers, reference: ref, lineage: lin.lineage_id, gen0: lin.gen0, runtimeKey } as any;
}

describe("agent posts (plan S)", () => {
  test("facts carry only final figures and the link", () => {
    const f = generationFacts({ id: "ab".repeat(32), at: 1, lineage_id: "l", recipe_name: "fx", generation: { height: 3, kind: "perf", target: "ir", effect: { metric: "ir", ratio: 0.8, per_replay: [{}, {}, {}] }, gain_pct: 20, fixed: 0, reverted: false } }, "/generations/x");
    expect(f).toContain("Ratio to the parent: 0.8000, so 20.00 percent lower.");
    expect(f).toContain("Reproduced by 3 independent replays.");
    expect(f).not.toMatch(/candidate/i);
  });

  test("posts after an accepted generation in the soul's voice, metered to the vault and the global cap; folds launcher media into a signed soul version", async () => {
    const e = await env();
    try {
      const k = generateAgentKey();
      const launcher = generateAgentKey();
      const a = { key: k, id: k.id, c: new CoreClient(e.base, k, () => e.clock.now()) };
      await expectOk(e.admin.c.post("/v1/admin/launches", { agent: k.id, mint: generateAgentKey().id, launcher: launcher.id, target_repo: RECIPE.repo, hosted: true, identity_mode: "app" }));
      await expectOk(e.admin.c.post("/v1/admin/agent-fees", { agent: k.id, amount: ((e.cfg.wake_threshold * 10_000n) / BigInt(e.cfg.agent_compute_bps) * 4n).toString() }));
      const d1 = newSoul({ agent: k.id, seed: SEED, persona: persona(), created_at: Math.floor(Date.now() / 1000), origin: { by: "launcher", model: null, prompt_version: null } });
      await expectOk(e.anon.request("PUT", `/v1/agents/${k.id}/soul`, { doc: d1, sig: signSoul(k, d1) }));
      // an accepted generation (authored before the runtime takes the key)
      const c = await submit(e as any, a, diff("posts_one"));
      await runReplays(e as any, c.candidate_id, honest(result({}, 800)));
      const gen = (await expectOk(e.anon.get(`/v1/candidates/${c.candidate_id}`))).gen_id;
      expect(gen).toBeTruthy();

      const writer = fakeWriter((facts) => `Shaved the decoder, 20.00 percent lower and it held. ${facts.match(/Link: (\S+)/)![1]}`);
      const cfg = parseConfig({ mode: "sim", core: e.base, state_dir: scratch(), runtime_key: "unused", compute_price_line_per_usd: "4", compute_price_line_per_sandbox_s: "0.001", poll_ms: 10, sandbox_reserve_s: 100, global_max_usd: 1, global_window_s: 86400, global_cap_scope: "all" });
      const logs: string[] = [];
      const rt = new Runtime(cfg, { backend: new SimBackend(e.base, e.runtimeKey), runtimeKey: e.runtimeKey, proposer: () => ({ name: "none", propose: async () => null }), log: (m) => logs.push(m), telemetry: false, postClient: writer.client });
      await rt.start();
      await rt.tick();
      const req = JSON.parse(readFileSync(join(cfg.state_dir, "bind-requests", `${k.id}.json`), "utf8"));
      await expectOk(a.c.post(`/v1/agents/${k.id}/keys/rotate`, req.body));
      await rt.tick();
      await rt.tick();
      expect(rt.state.agents[k.id]!.status).toBe("bound");
      // the post: on the lineage board, referencing the generation, in the voice block of this soul
      const boardv = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}/board`));
      const post = boardv.messages.find((m: any) => m.from === k.id);
      expect(post).toBeDefined();
      expect(post.envelope.ref).toEqual({ kind: "generation", id: gen });
      expect(post.envelope.body).toContain(`/generations/${gen}`);
      expect(writer.calls[0].system).toContain(`Write as ${d1.persona.name}`);
      expect(writer.calls[0].messages[0].content).toContain("Ratio to the parent: 0.8000");
      // metered: the agent's open usage and the global window both carry the post's spend
      const usd = rt.state.open.usage[k.id]!.usd;
      expect(usd).toBeGreaterThan(0);
      expect(rt.capStatus().spent_usd).toBeCloseTo(usd, 9);
      expect(rt.postsStatus()[0]).toMatchObject({ agent: k.id, kind: "generation", ref: gen });
      // the feed shows it; the same generation is never posted twice
      await rt.tick();
      expect((await expectOk(e.anon.get(`/v1/lineages/${e.lineage}/board`))).messages.filter((m: any) => m.from === k.id)).toHaveLength(1);
      const feed = await expectOk(e.anon.get(`/v1/feed?agent=${k.id}&kinds=post,generation`));
      expect(feed.items.map((i: any) => i.kind).sort()).toEqual(["generation", "post"]);

      // media: the launcher uploads an avatar; the runtime (holding the signing key now) signs the next soul version
      const statement = { v: 1, kind: "lineage-media", agent: k.id, slot: "avatar", sha256: sha256Hex(PNG), type: "image/png", size: PNG.length, signer: launcher.id, created_at: Math.floor(e.clock.now() / 1000), nonce: "media-nonce-1" };
      await expectOk(e.anon.post(`/v1/agents/${k.id}/media`, { statement, sig: signStatement(launcher, "media", statement), data: Buffer.from(PNG).toString("base64") }));
      await rt.tick();
      const soul = await expectOk(e.anon.get(`/v1/agents/${k.id}/soul`));
      expect(soul.seq).toBe(2);
      expect(soul.signer).toBe(rt.state.agents[k.id]!.key_id);
      expect(soul.doc.media.avatar.sha256).toBe(sha256Hex(PNG));
      expect((await expectOk(e.anon.get(`/v1/agents/${k.id}/profile`))).media.avatar.url).toBe(`/v1/media/${sha256Hex(PNG)}`);

      // the global cap holds under the kill switch (scope "all"): with no room left, no further post call is made
      rt.state.window!.usd = cfg.global_max_usd;
      const c2 = await submit(e as any, { ...a, c: new CoreClient(e.base, { ...rt.store.keyFor(k.id), agent: k.id } as any, () => e.clock.now()) } as any, diff("posts_two"));
      await runReplays(e as any, c2.candidate_id, honest(result({}, 700)));
      const before = writer.calls.length;
      await rt.tick();
      expect(writer.calls.length).toBe(before);
      expect(logs.some((l) => l.includes("waits"))).toBe(true);
      await rt.stop({ flush: false });
    } finally {
      e.close();
    }
  }, 60_000);
});
