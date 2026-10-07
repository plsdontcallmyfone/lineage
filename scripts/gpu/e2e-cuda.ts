#!/usr/bin/env bun
// GPU BOX ONLY. End-to-end proof of the cuda target class (SPEC 6.1) on one machine: a real Core,
// the reference runner and two verifier processes with separate keys, every replay in real GPU
// sandboxes on the fixture-cuda lineage. Verifiers declare their GPU (worker doctor), pass a
// qualification replay, then judge planted patches.
//
// One box means one operator and one GPU: this proves the pipeline and determinism across
// independent processes, not independence of hardware or operators (that needs two boxes).
//
// Usage: bun scripts/gpu/e2e-cuda.ts [--port 9663] [--keep] [--out <dir>]
import { spawn, type Subprocess } from "bun";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey, type AgentKey } from "@lineage/protocol";
import { loadRecipe, prepareDeps } from "@lineage/sandbox";
import { CoreClient } from "../../packages/core/src/client.ts";
import { loadScript, ScriptedProposer, Worker } from "../../packages/worker/src/index.ts";

const ROOT = join(import.meta.dir, "..", "..");
const PATCHES = join(ROOT, "fixtures", "cuda-reduce-patches");
const argv = process.argv.slice(2);
const opt = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const PORT = Number(opt("--port") ?? 9663);
const KEEP = argv.includes("--keep");
const OUT = opt("--out") ?? join(ROOT, "results");
const CORE = `http://127.0.0.1:${PORT}`;
const T0 = Date.now();

const log = (m: string) => console.log(`[e2e-cuda +${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
const results: { check: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ check: name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
}

const busy = Bun.spawnSync(["lsof", "-ti", `:${PORT}`]).stdout.toString().trim();
if (busy) {
  console.error(`port ${PORT} busy (pid ${busy}); pick another in 9662-9669`);
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "lineage-e2e-cuda-"));
const procs: Subprocess[] = [];
const keys = { admin: generateAgentKey(), ref: generateAgentKey(), v1: generateAgentKey(), v2: generateAgentKey(), author: generateAgentKey(), launcher: generateAgentKey() };
const kp = Object.fromEntries(
  Object.entries(keys).map(([n, k]) => {
    const p = join(tmp, `${n}.json`);
    writeFileSync(p, JSON.stringify(Array.from(k.secret)));
    return [n, p];
  }),
) as Record<keyof typeof keys, string>;
const net = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
Object.assign(net, { canary_rate: 0, audit_rate: 0, reveal_window_s: 1800, replay_window_min_s: 1800, max_open_candidates_per_agent: 20, epoch_length_s: 86400 });
writeFileSync(join(tmp, "network.json"), JSON.stringify(net));

const admin = new CoreClient(CORE, keys.admin);
const as = (k: AgentKey) => new CoreClient(CORE, k);
async function ok<T = any>(p: Promise<{ status: number; body: T }>, what: string): Promise<T> {
  const r = await p;
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 1_800_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v as T;
    await Bun.sleep(2000);
  }
  throw new Error(`timed out waiting for ${what}`);
}
function startVerifier(name: keyof typeof keys): void {
  const p = spawn(["bun", join(ROOT, "packages/worker/src/main.ts"), "run", "--core", CORE, "--key", kp[name], "--interval", "1000"], { stdout: "pipe", stderr: "pipe", env: process.env });
  const pipe = async (s: ReadableStream<Uint8Array>, mark: string) => {
    for await (const c of s) for (const l of new TextDecoder().decode(c).split("\n")) if (l.trim()) console.log(`   ${name.padEnd(4)}${mark} ${l}`);
  };
  pipe(p.stdout, "");
  pipe(p.stderr, " !");
  procs.push(p);
}
const FINAL = new Set(["accepted", "rejected", "expired"]);
const candidateFinal = (id: string) =>
  waitFor(`candidate ${id.slice(0, 10)}`, async () => {
    const r = await admin.get(`/v1/candidates/${id}`);
    return r.status === 200 && FINAL.has(r.body.status) ? r.body : null;
  });
async function events(): Promise<any[]> {
  const e = await ok<any>(admin.get("/v1/events/log?since=0&limit=10000"), "events");
  return Array.isArray(e) ? e : (e.events ?? []);
}

async function main() {
  const core = spawn(["bun", join(ROOT, "packages/core/src/main.ts"), "--data", join(tmp, "data"), "--port", String(PORT), "--config", join(tmp, "network.json"), "--admin-key", kp.admin, "--tick-ms", "500"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  procs.push(core);
  await waitFor("core", async () => (await fetch(`${CORE}/v1/health`).catch(() => null))?.ok, 60_000);
  log(`core up on ${CORE}`);

  const loaded = loadRecipe(join(ROOT, "recipes/fixture-cuda"));
  const deps = await prepareDeps(loaded);
  await ok(admin.post("/v1/admin/recipes", { recipe: loaded.recipe, recipe_id: loaded.recipe_id }), "recipe");
  const snap = await ok(admin.post("/v1/admin/snapshots", { repo: loaded.recipe.repo, commit: loaded.recipe.commit, deps_digest: deps.digest }), "snapshot");
  const MIN_BOND = BigInt(net.min_bond);
  const BURN = BigInt(net.register_burn);
  for (const n of ["ref", "v1", "v2"] as const) {
    await ok(admin.post("/v1/admin/faucet", { agent: keys[n].id, amount: (BURN + MIN_BOND * 20n).toString() }), "faucet");
    await ok(as(keys[n]).post("/v1/agents", {}), `register ${n}`);
  }
  await ok(admin.post(`/v1/admin/agents/${keys.ref.id}/reference`, { reference: true }), "mark reference");
  for (const n of ["v1", "v2"] as const) await ok(as(keys[n]).post(`/v1/agents/${keys[n].id}/bond`, { amount: MIN_BOND.toString() }), `bond ${n}`);

  log("reference runner calibrating fixture-cuda on the GPU");
  const refWorker = new Worker({ core: CORE, key: keys.ref, log: (m) => console.log(`   ref  ${m}`) });
  await refWorker.submitCalibration(loaded.recipe_id, snap.snapshot_id, 3);
  const lineages = await ok<any[]>(admin.get("/v1/lineages"), "lineages");
  check("cuda lineage created from a real GPU calibration", lineages.length === 1);
  const lineage = await ok(admin.get(`/v1/lineages/${lineages[0].lineage_id}`), "lineage");
  const L = lineage.lineage_id as string;
  const cal = lineage.calibration;
  check("all fixture tests stable, none quarantined", cal.stable.length === 14 && cal.quarantined.length === 0, `stable ${cal.stable.length}, known failures ${cal.known_failures.length}, quarantined ${cal.quarantined.length}`);
  for (const m of ["reduce_warp_inst", "scale_warp_inst"])
    check(`${m} deterministic at calibration (cv 0)`, cal.metrics[m]?.enabled === true && cal.metrics[m]?.cv === 0, JSON.stringify(cal.metrics[m]));

  await ok(admin.post("/v1/admin/launches", { agent: keys.author.id, mint: generateAgentKey().id, launcher: keys.launcher.id, target_repo: loaded.recipe.repo, hosted: false, identity_mode: "token" }), "launch author");
  await ok(admin.post("/v1/admin/agent-fees", { agent: keys.author.id, amount: (BigInt(net.wake_threshold) * 10n).toString() }), "agent fees");

  startVerifier("ref");
  startVerifier("v1");
  startVerifier("v2");
  log("waiting for both verifiers to declare their GPU and pass a qualification replay");
  await waitFor("qualifications", async () => {
    const ev = await events();
    const passed = new Set(ev.filter((e) => e.type === "qualification.passed").map((e) => (e.data ?? e.payload ?? e).agent));
    const failed = ev.filter((e) => e.type === "qualification.failed");
    if (failed.length) log(`qualification failed: ${JSON.stringify(failed.at(-1)).slice(0, 300)}`);
    return passed.has(keys.v1.id) && passed.has(keys.v2.id);
  });
  check("both verifiers qualified for the cuda lineage", true);

  const submit = async (name: string) => {
    const w = new Worker({ core: CORE, key: keys.author, proposer: new ScriptedProposer(loadScript(PATCHES, [name])), lineages: [L], log: (m) => console.log(`   auth ${m}`) });
    const id = await w.authorOnce();
    if (!id) throw new Error(`author did not submit ${name}`);
    const f = await candidateFinal(id);
    log(`${name}: ${f.status}${f.reason ? ` (${f.reason})` : ""}`);
    return f;
  };
  const p1 = await submit("perf_reduce");
  check("perf_reduce accepted on executed warp instructions", p1.status === "accepted", p1.effect ? `ratio ${p1.effect.ratio}` : "");
  const p2 = await submit("perf_scale");
  check("perf_scale accepted", p2.status === "accepted", p2.effect ? `ratio ${p2.effect.ratio}` : "");
  for (const [name, reason] of [
    ["break_tests", "tests_fail"],
    ["equiv_change", "equivalence_changed"],
    ["regress", "no_improvement"],
    ["protected_test_edit", "guard"],
  ] as const) {
    const f = await submit(name);
    check(`${name} rejected with ${reason}`, f.status === "rejected" && String(f.reason).includes(reason), `${f.status} ${f.reason ?? ""}`);
  }
  const lv = await ok(admin.get(`/v1/lineages/${L}`), "lineage");
  check("lineage height 2 (reduce, scale)", lv.height === 2, `height ${lv.height}`);
  const ver = Bun.spawnSync(["bun", join(ROOT, "scripts/verify.ts"), "--core", CORE]);
  check("every verdict recomputed from public data (scripts/verify.ts)", ver.exitCode === 0, ver.stdout.toString().trim().split("\n").at(-1) ?? "");
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  log(`ERROR ${(e as Error).stack ?? e}`);
} finally {
  for (const p of procs) p.kill();
  const bad = results.filter((r) => !r.ok);
  log(`${results.length - bad.length}/${results.length} checks passed in ${((Date.now() - T0) / 1000).toFixed(0)}s`);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "e2e-cuda.json"), JSON.stringify({ at: new Date().toISOString(), seconds: Math.round((Date.now() - T0) / 1000), results }, null, 2) + "\n");
  if (!KEEP) rmSync(tmp, { recursive: true, force: true });
  else log(`kept ${tmp}`);
  process.exit(failed || bad.length ? 1 : 0);
}
