#!/usr/bin/env bun
// Local network: a persistent Core on 9660 with every recipe in recipes/ calibrated into a lineage,
// one launched authoring agent per lineage, three honest verifiers and a reference runner, all as
// separate processes, plus the dashboard on 9661. State lives in ./data and ./.lineage-net (keys).
//
// Usage: bun scripts/network.ts [--recipes fixture-b58,base58-py,minbpe] [--author scripted|anthropic]
//        [--max-usd 2] [--no-web] [--port 9660] [--web-port 9661] [--data ./data] [--state ./.lineage-net]
//        [--verifiers 3] [--config config/network.json]
// Every worker sends heartbeats and its proposer's activity (SPEC 17.1), so the dashboard's live
// wall and machine wall show this network's real work.
// Ctrl-C stops every process this script started (by PID).
import { spawn, type Subprocess } from "bun";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateAgentKey, keyFromSolanaJson, satisfies, type AgentKey } from "@lineage/protocol";
import { loadRecipe, prepareDeps } from "@lineage/sandbox";
import { CoreClient } from "../packages/core/src/client.ts";
import { Worker } from "../packages/worker/src/index.ts";
import { doctor } from "../packages/worker/src/doctor.ts";

const ROOT = join(import.meta.dir, "..");
const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
const PORT = Number(opt("port") ?? 9660);
const WEB_PORT = Number(opt("web-port") ?? 9661);
const DATA = opt("data") ?? join(ROOT, "data");
const CONFIG = opt("config") ?? join(ROOT, "config/network.json");
const CORE = `http://127.0.0.1:${PORT}`;
const STATE = opt("state") ?? join(ROOT, ".lineage-net");
mkdirSync(STATE, { recursive: true });
const net = JSON.parse(readFileSync(CONFIG, "utf8"));
const procs: Subprocess[] = [];
const log = (m: string) => console.log(`[network] ${m}`);

function key(name: string): { key: AgentKey; path: string } {
  const path = join(STATE, `${name}.json`);
  if (!existsSync(path)) writeFileSync(path, JSON.stringify(Array.from(generateAgentKey().secret)), { mode: 0o600 });
  return { key: keyFromSolanaJson(JSON.parse(readFileSync(path, "utf8"))), path };
}

function start(name: string, cmd: string[]): Subprocess {
  const p = spawn(cmd, { stdout: "pipe", stderr: "pipe", env: process.env });
  for (const s of [p.stdout, p.stderr])
    (async () => {
      for await (const c of s) for (const l of new TextDecoder().decode(c).split("\n")) if (l.trim()) console.log(`${name.padEnd(10)} ${l}`);
    })();
  procs.push(p);
  return p;
}

function shutdown() {
  for (const p of procs) p.kill();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function ok<T = any>(p: Promise<{ status: number; body: T }>, what: string, allow: number[] = []): Promise<T> {
  const r = await p;
  if (r.status >= 300 && !allow.includes(r.status)) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

for (const port of [PORT, WEB_PORT]) {
  const busy = Bun.spawnSync(["lsof", "-ti", `:${port}`]).stdout.toString().trim();
  if (busy) {
    console.error(`port ${port} busy (pid ${busy}); stop it first`);
    process.exit(1);
  }
}

const admin = key("admin");
start("core", ["bun", join(ROOT, "packages/core/src/main.ts"), "--data", DATA, "--port", String(PORT), "--config", CONFIG, "--admin-key", admin.path]);
for (let i = 0; i < 60 && !(await fetch(`${CORE}/v1/health`).catch(() => null))?.ok; i++) await Bun.sleep(500);
const A = new CoreClient(CORE, admin.key);
const as = (k: AgentKey) => new CoreClient(CORE, k);

// Without --recipes: every recipe this machine can run. A recipe whose `requires` the local hardware
// does not satisfy (the CUDA recipes need amd64 and an NVIDIA GPU) is skipped with a note, since its
// calibration could not run here; naming it in --recipes still tries it.
const HERE = doctor().capabilities;
const names = opt("recipes")
  ? opt("recipes")!.split(",")
  : readdirSync(join(ROOT, "recipes"))
      .filter((d) => existsSync(join(ROOT, "recipes", d, "recipe.yml")))
      .filter((d) => {
        const ok = satisfies(HERE, loadRecipe(join(ROOT, "recipes", d)).recipe.requires);
        if (!ok) log(`${d}: skipped, requires ${JSON.stringify(loadRecipe(join(ROOT, "recipes", d)).recipe.requires)} and this machine is ${HERE.arch} with ${HERE.gpus.length} GPUs`);
        return ok;
      })
      .sort();
const MIN_BOND = BigInt(net.min_bond);
const BURN = BigInt(net.register_burn);

// verifiers and the reference runner
const ref = key("reference");
const verifiers = Array.from({ length: Number(opt("verifiers") ?? 3) }, (_, i) => `v${i + 1}`).map(key);
for (const v of [ref, ...verifiers]) {
  const me = await A.get(`/v1/agents/${v.key.id}`);
  if (me.status === 404) {
    await ok(A.post("/v1/admin/faucet", { agent: v.key.id, amount: (BURN + MIN_BOND * 4n).toString() }), "faucet");
    await ok(as(v.key).post("/v1/agents", {}), "register");
    if (v !== ref) await ok(as(v.key).post(`/v1/agents/${v.key.id}/bond`, { amount: MIN_BOND.toString() }), "bond");
  }
}
await ok(A.post(`/v1/admin/agents/${ref.key.id}/reference`, { reference: true }), "reference");
const refWorker = new Worker({ core: CORE, key: ref.key, log: (m) => console.log(`reference  ${m}`) });

const existing = await ok<any[]>(A.get("/v1/lineages"), "lineages");
const authors: { name: string; path: string; lineage: string }[] = [];
for (const name of names) {
  const loaded = loadRecipe(join(ROOT, "recipes", name));
  log(`${name}: preparing dependency layer`);
  const deps = await prepareDeps(loaded);
  await ok(A.post("/v1/admin/recipes", { recipe: loaded.recipe, recipe_id: loaded.recipe_id }), "recipe");
  const snap = await ok(A.post("/v1/admin/snapshots", { repo: loaded.recipe.repo, commit: loaded.recipe.commit, deps_digest: deps.digest }), "snapshot");
  let lineage = existing.find((l) => l.recipe_id === loaded.recipe_id);
  if (!lineage) {
    log(`${name}: calibrating (reference runner)`);
    await refWorker.submitCalibration(loaded.recipe_id, snap.snapshot_id, 5);
    lineage = (await ok<any[]>(A.get("/v1/lineages"), "lineages")).find((l) => l.recipe_id === loaded.recipe_id);
  }
  const agent = key(`agent-${name}`);
  const launcher = key(`launcher-${name}`);
  if ((await A.get(`/v1/agents/${agent.key.id}`)).status === 404) {
    await ok(
      A.post("/v1/admin/launches", { agent: agent.key.id, mint: generateAgentKey().id, launcher: launcher.key.id, target_repo: loaded.recipe.repo, hosted: false, identity_mode: "token" }),
      "launch",
    );
    await ok(A.post("/v1/admin/agent-fees", { agent: agent.key.id, amount: (BigInt(net.wake_threshold) * 4n).toString() }), "fees");
  }
  authors.push({ name, path: agent.path, lineage: lineage.lineage_id });
  log(`${name}: lineage ${lineage.lineage_id.slice(0, 12)}, agent ${agent.key.id.slice(0, 8)}`);
}

start("reference", ["bun", join(ROOT, "packages/worker/src/main.ts"), "run", "--core", CORE, "--key", ref.path]);
verifiers.forEach((v, i) => start(`v${i + 1}`, ["bun", join(ROOT, "packages/worker/src/main.ts"), "run", "--core", CORE, "--key", v.path]));

const mode = opt("author") ?? "scripted";
for (const a of authors) {
  const args = ["bun", join(ROOT, "packages/worker/src/main.ts"), "run", "--core", CORE, "--key", a.path, "--lineage", a.lineage, "--interval", "5000"];
  if (mode === "anthropic") args.push("--proposer", "anthropic", "--max-usd", opt("max-usd") ?? "2", "--max-candidates", "1");
  else {
    const dir = a.name === "fixture-b58" ? join(ROOT, "fixtures/b58-patches") : join(ROOT, "recipes", a.name, "candidates");
    if (!existsSync(join(dir, "index.json"))) {
      log(`${a.name}: no scripted candidates (${dir}/index.json); agent replays nothing and authors nothing`);
      continue;
    }
    args.push("--proposer", "scripted", "--script", dir);
  }
  start(`agent-${a.name}`.slice(0, 10), args);
}

if (!argv.includes("--no-web") && existsSync(join(ROOT, "apps/web/server.ts"))) start("web", ["bun", join(ROOT, "apps/web/server.ts"), "--port", String(WEB_PORT), "--core", CORE, ...(argv.includes("--dev") ? ["--dev"] : [])]);
log(`network up: Core ${CORE}, dashboard http://127.0.0.1:${WEB_PORT} (Ctrl-C stops everything this script started)`);
await new Promise(() => {});
