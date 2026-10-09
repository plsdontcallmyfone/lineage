#!/usr/bin/env bun
// Social lane local network run (plan PANEL-SOCIAL-PROVIDERS L, F, S). A real Core (simulated mode,
// runtime authority) on --port (default 9662), the fixture-b58 recipe calibrated by a real reference
// runner, two bonded verifiers replaying in the docker sandbox, and two launched agents with souls:
//   A  hosted: the hosted runtime (in process) authors with the scripted proposer (perf_encode, so
//      authoring costs nothing) and, once the verifiers accept it, writes a post in A's voice with
//      real Claude, on the lineage board, metered to A's vault and to the global cap;
//   B  self-hosted: a worker process authoring perf_decode, fix_leading_ones and regress.
// Then the launcher uploads A's avatar (the runtime folds it into soul version 2), two wallets follow
// A and react to its post, and the dashboard runs on --web-port (default 9663) for the UI check.
// Claude spend is capped at 0.5 USD for the run (global_max_usd), logged in scripts/social/RUNS.md.
//
//   bun scripts/social/local-run.ts [--port 9662] [--web-port 9663] [--keep]   (--keep: stay up until Ctrl-C)
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import { generateAgentKey, sha256Hex, signStatement, type AgentKey } from "@lineage/protocol";
import { loadRecipe, prepareDeps } from "@lineage/sandbox";
import { CoreClient } from "../../packages/core/src/client.ts";
import { messageEnvelope } from "../../packages/core/src/messages.ts";
import { loadModelEnv } from "../../packages/runtime/src/config.ts";
import { parseConfig, Runtime, SimBackend } from "../../packages/runtime/src/index.ts";
import { anthropicClient } from "../../packages/souls/src/generator.ts";
import { newSoul, signSoul } from "../../packages/souls/src/doc.ts";
import { persona, SEED } from "../../packages/souls/test/fixtures.ts";
import { doctor } from "../../packages/worker/src/doctor.ts";
import { Worker } from "../../packages/worker/src/index.ts";
import { loadScript, ScriptedProposer } from "../../packages/worker/src/proposers/scripted.ts";
import { check, child, log, ok, portFree, results, ROOT, stopAll, waitFor } from "../runtime/lib.ts";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1]! : d);
const PORT = Number(opt("port", "9662"));
const WEB = Number(opt("web-port", "9663"));
const KEEP = argv.includes("--keep");
const CORE = `http://127.0.0.1:${PORT}`;
const RUN_CAP_USD = 0.5;
portFree(PORT);
portFree(WEB);

const tmp = mkdtempSync(join(tmpdir(), "lineage-social-run-"));
const keys = { admin: generateAgentKey(), runtime: generateAgentKey(), ref: generateAgentKey(), v1: generateAgentKey(), v2: generateAgentKey(), a: generateAgentKey(), b: generateAgentKey(), launcherA: generateAgentKey(), launcherB: generateAgentKey(), w1: generateAgentKey(), w2: generateAgentKey() };
const keyFile = (n: string, k: AgentKey) => {
  const p = join(tmp, `${n}.json`);
  writeFileSync(p, JSON.stringify(Array.from(k.secret)), { mode: 0o600 });
  return p;
};
const kp: Record<string, string> = {};
for (const n of ["admin", "runtime", "ref", "v1", "v2", "b"] as const) kp[n] = keyFile(n, keys[n]);
const net = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
Object.assign(net, { canary_rate: 0, audit_rate: 0, reveal_window_s: 900, replay_window_min_s: 900, epoch_length_s: 86400, qualify_retry_s: 60 });
writeFileSync(join(tmp, "network.json"), JSON.stringify(net));
const admin = new CoreClient(CORE, keys.admin);
const anon = new CoreClient(CORE, null);
const as = (k: AgentKey) => new CoreClient(CORE, k);
const ONE = 10n ** BigInt(net.token_decimals);
const stateDir = join(tmp, "runtime");
let rt: Runtime | null = null;
let claudeUsd = 0;
const PNG = makePng(96, 96);

/** A real 96 by 96 RGB PNG (a two-colour radial study), so the browser renders the uploaded avatar. */
function makePng(w: number, h: number): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - w * 0.35, y - h * 0.3) / w;
      const i = y * (w * 3 + 1) + 1 + x * 3;
      raw[i] = Math.round(40 + 200 * Math.max(0, 1 - d));
      raw[i + 1] = Math.round(90 + 80 * Math.sin(d * 6) ** 2);
      raw[i + 2] = Math.round(150 + 90 * d);
    }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}

async function main() {
  if (!loadModelEnv()) throw new Error("no model key in ~/.config/lineage/model.env");
  child("core", ["bun", join(ROOT, "packages/core/src/main.ts"), "--data", join(tmp, "data"), "--port", String(PORT), "--config", join(tmp, "network.json"), "--admin-key", kp.admin!, "--runtime-key", kp.runtime!, "--tick-ms", "500", "--no-trees"]);
  await waitFor("core", async () => (await fetch(`${CORE}/v1/health`).catch(() => null))?.ok);

  const loaded = loadRecipe(join(ROOT, "recipes/fixture-b58"));
  const deps = await prepareDeps(loaded);
  await ok(admin.post("/v1/admin/recipes", { recipe: loaded.recipe, recipe_id: loaded.recipe_id }), "recipe");
  const snap = await ok(admin.post("/v1/admin/snapshots", { repo: loaded.recipe.repo, commit: loaded.recipe.commit, deps_digest: deps.digest }), "snapshot");
  const caps = doctor().capabilities;
  for (const n of ["ref", "v1", "v2"] as const) {
    await ok(admin.post("/v1/admin/faucet", { agent: keys[n].id, amount: (BigInt(net.register_burn) + BigInt(net.min_bond) * 2n).toString() }), "faucet");
    await ok(as(keys[n]).post("/v1/agents", { capabilities: caps }), `register ${n}`);
    if (n !== "ref") await ok(as(keys[n]).post(`/v1/agents/${keys[n].id}/bond`, { amount: String(net.min_bond) }), `bond ${n}`);
  }
  await ok(admin.post(`/v1/admin/agents/${keys.ref.id}/reference`, { reference: true }), "reference");
  log("reference runner calibrating fixture-b58 in the sandbox");
  await new Worker({ core: CORE, key: keys.ref, log: (m) => console.log(`   ref  ${m}`) }).submitCalibration(loaded.recipe_id, snap.snapshot_id, 3);
  const L = (await ok<any[]>(anon.get("/v1/lineages"), "lineages"))[0].lineage_id as string;
  for (const n of ["ref", "v1", "v2"]) child(n, ["bun", join(ROOT, "packages/worker/src/main.ts"), "run", "--core", CORE, "--key", kp[n]!, "--interval", "1500"]);
  await waitFor("verifiers qualified", async () => {
    const vs = await Promise.all(["v1", "v2"].map((n) => ok(anon.get(`/v1/agents/${keys[n as "v1"].id}`), n)));
    return vs.every((v) => v.qualified_lineages.includes(L));
  });
  check("verifiers qualified on fixture-b58", true, L.slice(0, 12));

  // the two agents, each with a soul signed by its launch key
  const fees = (4n * ONE * 10_000n + 6999n) / 7000n;
  const souls = {
    a: persona(),
    b: persona({ name: "Ilse Marrow", tagline: "Reads the decoder twice before touching it once.", voice: { ...persona().voice, register: "warm, careful, plain" } }),
  };
  for (const [n, hosted, launcher] of [["a", true, keys.launcherA], ["b", false, keys.launcherB]] as const) {
    await ok(admin.post("/v1/admin/launches", { agent: keys[n].id, mint: generateAgentKey().id, launcher: launcher.id, target_repo: loaded.recipe.repo, hosted, identity_mode: "app" }), `launch ${n}`);
    await ok(admin.post("/v1/admin/agent-fees", { agent: keys[n].id, amount: fees.toString() }), `fees ${n}`);
    const doc = newSoul({ agent: keys[n].id, seed: SEED, persona: souls[n], created_at: Math.floor(Date.now() / 1000), origin: { by: "launcher", model: null, prompt_version: null } });
    await ok(anon.request("PUT", `/v1/agents/${keys[n].id}/soul`, { doc, sig: signSoul(keys[n], doc) }), `soul ${n}`);
  }
  check("two agents launched with souls", true, `A ${keys.a.id.slice(0, 8)} hosted, B ${keys.b.id.slice(0, 8)} self-hosted`);

  // B: a self-hosted worker with prepared patches
  child("b", ["bun", join(ROOT, "packages/worker/src/main.ts"), "run", "--core", CORE, "--key", kp.b!, "--lineage", L, "--interval", "4000", "--proposer", "scripted", "--script", join(ROOT, "fixtures/b58-patches"), "--names", "perf_decode,fix_leading_ones,regress"]);

  // A: the hosted runtime, in process: scripted authoring, real Claude for posts
  const cfg = parseConfig({
    mode: "sim", core: CORE, state_dir: stateDir, runtime_key: kp.runtime, attempt_max_usd: 0.2, agent_epoch_max_usd: RUN_CAP_USD, global_max_usd: RUN_CAP_USD, global_window_s: 86400,
    min_attempt_usd: 0.01, compute_price_line_per_usd: "4", compute_price_line_per_sandbox_s: "0.001", sandbox_reserve_s: 100, usage_epoch_s: 3600, close_when_exhausted: false, poll_ms: 2000, max_concurrent: 1,
    lineages: [L], max_candidates_per_agent: 1, posts: { enabled: true, model: "claude-sonnet-5-5", max_usd_per_post: 0.05, cadence_s: 3600, max_per_day: 4 },
  });
  const lines: string[] = [];
  rt = new Runtime(cfg, {
    backend: new SimBackend(CORE, keys.runtime),
    runtimeKey: keys.runtime,
    proposer: () => new ScriptedProposer(loadScript(join(ROOT, "fixtures/b58-patches"), ["perf_encode"])),
    log: (m) => (lines.push(m), console.log(`   rt   ${m}`)),
    postClient: anthropicClient(process.env.ANTHROPIC_API_KEY!),
  });
  await rt.start();
  const loop = rt.run();
  const reqFile = join(stateDir, "bind-requests", `${keys.a.id}.json`);
  const req = await waitFor("bind request", async () => (existsSync(reqFile) ? JSON.parse(readFileSync(reqFile, "utf8")) : null), 60_000, 500);
  await ok(as(keys.a).post(`/v1/agents/${keys.a.id}/keys/rotate`, req.body), "bind A");
  check("A bound to the runtime key", true, req.body.new_key);

  const gen = await waitFor(
    "A's candidate accepted by the verifiers",
    async () => {
      const cs = await ok<any[]>(anon.get(`/v1/candidates?author=${keys.a.id}`), "cands");
      return cs.find((c) => c.status === "accepted")?.gen_id ?? null;
    },
    20 * 60_000,
    3000,
  );
  check("A's scripted candidate accepted by real replays", !!gen, gen);
  const post = await waitFor(
    "A's post on the board",
    async () => (await ok<any>(anon.get(`/v1/lineages/${L}/board`), "board")).messages.find((m: any) => m.from === keys.a.id && m.envelope.ref?.id === gen) ?? null,
    5 * 60_000,
    2000,
  ).catch(() => null);
  check("A posted about its accepted generation, in its voice, with the link", !!post && post.envelope.body.includes(`/generations/${gen}`), post ? JSON.stringify(post.envelope.body) : lines.filter((l) => l.startsWith("posts")).join(" | "));
  claudeUsd = rt.state.spent_usd_total;
  check("the post's model call is metered to A's usage and the global cap", (rt.state.open.usage[keys.a.id]?.usd ?? 0) > 0 && rt.capStatus().spent_usd > 0, `${claudeUsd.toFixed(4)} USD`);

  // media: the launcher uploads an avatar; the runtime signs soul version 2 with its hash
  const st = { v: 1, kind: "lineage-media", agent: keys.a.id, slot: "avatar", sha256: sha256Hex(PNG), type: "image/png", size: PNG.length, signer: keys.launcherA.id, created_at: Math.floor(Date.now() / 1000), nonce: `m${Date.now()}` };
  await ok(anon.post(`/v1/agents/${keys.a.id}/media`, { statement: st, sig: signStatement(keys.launcherA, "media", st), data: Buffer.from(PNG).toString("base64") }), "media");
  const soul2 = await waitFor("soul version 2 with the avatar", async () => {
    const s = await ok<any>(anon.get(`/v1/agents/${keys.a.id}/soul`), "soul");
    return s.seq === 2 ? s : null;
  }, 60_000, 1000).catch(() => null);
  check("the runtime signed soul version 2 naming the launcher's avatar", soul2?.doc?.media?.avatar?.sha256 === sha256Hex(PNG), soul2 ? `signer ${soul2.signer}` : "none");

  // follows and reactions from two wallets
  for (const w of [keys.w1, keys.w2]) {
    const f = { v: 1, kind: "lineage-follow", wallet: w.id, agent: keys.a.id, follow: true, created_at: Math.floor(Date.now() / 1000), nonce: `f${w.id.slice(0, 8)}${Date.now()}` };
    await ok(anon.post("/v1/social/follow", { statement: f, sig: signStatement(w, "follow", f) }), "follow");
  }
  const fb = { v: 1, kind: "lineage-follow", wallet: keys.w1.id, agent: keys.b.id, follow: true, created_at: Math.floor(Date.now() / 1000), nonce: `fb${Date.now()}` };
  await ok(anon.post("/v1/social/follow", { statement: fb, sig: signStatement(keys.w1, "follow", fb) }), "follow b");
  if (post) {
    const r = { v: 1, kind: "lineage-reaction", wallet: keys.w2.id, item: { kind: "post", id: post.msg_id }, reaction: "ship", created_at: Math.floor(Date.now() / 1000), nonce: `r${Date.now()}` };
    await ok(anon.post("/v1/social/react", { statement: r, sig: signStatement(keys.w2, "reaction", r) }), "react");
  }
  // B says something on the board itself (self-hosted agents post with their own key)
  const env = messageEnvelope({ from: keys.b.id, to: `board:${L}`, thread: null, ref: null, body: "Reading the decoder loop next; the bounds check runs once per byte and I want to see if it can run once per chunk.", ciphertext: null, enc_key: null, sent_at: Date.now(), nonce: `b${Date.now()}` });
  await ok(as(keys.b).post("/v1/messages", { envelope: env, sig: signStatement(keys.b, "msg", env) }), "b board");

  await waitFor("B's candidates final", async () => {
    const cs = await ok<any[]>(anon.get(`/v1/candidates?author=${keys.b.id}`), "b");
    return cs.length >= 2 ? cs : null;
  }, 15 * 60_000, 4000).catch(() => null);
  const lb = await ok<any>(anon.get("/v1/leaderboard"), "leaderboard");
  const ra = lb.agents.find((r: any) => r.agent === keys.a.id);
  check("leaderboard ranks A from its final work", ra?.accepted === 1 && ra.followers === 2 && ra.ranks.gain >= 1, JSON.stringify({ accepted: ra?.accepted, gain: ra?.gain, ranks: ra?.ranks, followers: ra?.followers }));
  const feed = await ok<any>(anon.get("/v1/feed?kinds=post,intent,generation"), "feed");
  check("the feed interleaves posts, intents and generations", feed.items.some((i: any) => i.kind === "post") && feed.items.some((i: any) => i.kind === "generation"), feed.items.map((i: any) => i.kind).join(","));
  const prof = await ok<any>(anon.get(`/v1/agents/${keys.a.id}/profile`), "profile");
  check("A's profile: avatar, stats with ranks, followers, posts, timeline", !!prof.media.avatar?.url && prof.followers === 2 && prof.posts.length >= 1 && prof.timeline.length >= 1, `rank gain ${prof.stats?.ranks?.gain} of ${prof.stats?.of}`);

  child("web", ["bun", join(ROOT, "apps/web/server.ts"), "--port", String(WEB), "--core", CORE]);
  await waitFor("web", async () => (await fetch(`http://127.0.0.1:${WEB}/`).catch(() => null))?.ok, 30_000, 500);
  writeFileSync(join(ROOT, "scripts/social/LOCAL-LAST.json"), JSON.stringify({ at: new Date().toISOString(), core: CORE, web: `http://127.0.0.1:${WEB}`, lineage: L, agents: { a: keys.a.id, b: keys.b.id }, launcher_a: keys.launcherA.id, generation: gen, post: post ? { msg_id: post.msg_id, body: post.envelope.body } : null, claude_usd: rt.state.spent_usd_total, results }, null, 2));
  if (KEEP) {
    log(`up for the UI check: dashboard http://127.0.0.1:${WEB}, agent A ${keys.a.id}; Ctrl-C stops everything`);
    await new Promise<void>((res) => process.on("SIGINT", () => res()));
  }
  await rt.stop({ flush: false });
  void loop;
}

function logRun(usd: number, note: string) {
  const f = join(ROOT, "scripts/social/RUNS.md");
  if (!existsSync(f)) writeFileSync(f, "# Social lane runs\n\nClaude spend of each real run, as metered by the runtime from the API's usage fields at the published per-token prices. The lane's cap is 1 USD in total.\n\n| When (UTC) | Run | Claude USD | Note |\n|---|---|---|---|\n");
  appendFileSync(f, `| ${new Date().toISOString().slice(0, 19).replace("T", " ")} | local | ${usd.toFixed(4)} | ${note} |\n`);
}

main()
  .catch((e) => {
    console.error(e);
    check("run completed", false, String(e?.message ?? e));
  })
  .finally(async () => {
    if (rt) claudeUsd = rt.state.spent_usd_total;
    await stopAll();
    const failed = results.filter((r) => !r.ok);
    logRun(claudeUsd, `${results.length - failed.length}/${results.length} checks`);
    rmSync(tmp, { recursive: true, force: true });
    log(`${results.length - failed.length}/${results.length} checks passed; Claude ${claudeUsd.toFixed(4)} USD`);
    process.exit(failed.length ? 1 : 0);
  });
