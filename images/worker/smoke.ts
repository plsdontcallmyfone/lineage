#!/usr/bin/env bun
// W9b exit check for the lineage/worker image: a local simulated Core with the fixture-b58 lineage
// (calibrated by an in-process reference runner on the host), two verifiers that run ONLY as
// lineage/worker containers (registered and bonded with the image's own CLI, sandboxes on the host
// Docker daemon through the mounted socket), and a scripted author on the host submitting
// perf_encode. Checks: both containers qualify, both replay the candidate, it is accepted, and
// `docker stop` drains each worker. Containers are named lineage-w9b-* and removed by name.
//
// Usage: bun images/worker/smoke.ts [--port 9664] [--image lineage/worker] [--keep]
import { spawn, spawnSync, type Subprocess } from "bun";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateAgentKey, type AgentKey } from "@lineage/protocol";
import { CoreClient } from "../../packages/core/src/client.ts";

const ROOT = join(import.meta.dir, "../..");
const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1]! : d);
const PORT = Number(opt("port", "9664"));
const IMAGE = opt("image", "lineage/worker");
const KEEP = argv.includes("--keep");
const CORE = `http://127.0.0.1:${PORT}`;
// a container reaches the host's loopback through host.docker.internal on Docker Desktop, or shares it with --network host on Linux
const LINUX = process.platform === "linux";
const CORE_IN = LINUX ? CORE : `http://host.docker.internal:${PORT}`;
const T0 = Date.now();
const log = (m: string) => console.log(`[w9b +${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ check: name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

if (spawnSync(["lsof", "-ti", `:${PORT}`]).stdout.toString().trim()) {
  console.error(`port ${PORT} busy; pick another in 9662-9669`);
  process.exit(1);
}

// Docker Desktop shares /private with its VM; sandboxes' bind mounts must be the same path on both sides
const tmp = mkdtempSync(join(process.platform === "darwin" ? "/private/tmp" : "/tmp", "lineage-w9b-"));
// every machine here starts cold, the host side (reference runner, author) included: nothing is shared
// through a cache, so the containers' dependency layers must agree with the host's by content
process.env.LINEAGE_HOME = join(tmp, "home-host");
const { loadRecipe, prepareDeps } = await import("@lineage/sandbox");
const { loadScript, ScriptedProposer, Worker } = await import("../../packages/worker/src/index.ts");
const net = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
Object.assign(net, { canary_rate: 0, audit_rate: 0, epoch_length_s: 86400, qualify_retry_s: 30 });
writeFileSync(join(tmp, "network.json"), JSON.stringify(net));
const keyFile = (name: string, k: AgentKey) => {
  const p = join(tmp, "keys", `${name}.json`);
  mkdirSync(join(tmp, "keys"), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(Array.from(k.secret)), { mode: 0o600 });
  return p;
};
const keys = { admin: generateAgentKey(), ref: generateAgentKey(), v1: generateAgentKey(), v2: generateAgentKey(), author: generateAgentKey() };
const paths = Object.fromEntries(Object.entries(keys).map(([n, k]) => [n, keyFile(n, k)])) as Record<keyof typeof keys, string>;
const admin = new CoreClient(CORE, keys.admin);
const procs: Subprocess[] = [];
const containers: string[] = [];

function docker(args: string[], what: string): string {
  const p = spawnSync(["docker", ...args]);
  if (p.exitCode !== 0) throw new Error(`${what}: ${p.stderr.toString().trim()}`);
  return p.stdout.toString().trim();
}

/** The image's CLI as a one-off container (key read-only, same LINEAGE_HOME path inside and out). */
function cli(name: string, args: string[]) {
  return docker(["run", "--rm", ...(LINUX ? ["--network", "host"] : []), "-v", `${paths[name as keyof typeof paths]}:/keys/agent.json:ro`, IMAGE, ...args], `${name} ${args[0]}`);
}

function startContainer(name: "v1" | "v2") {
  const home = join(tmp, `home-${name}`);
  mkdirSync(home, { recursive: true });
  const cname = `lineage-w9b-${name}-${process.pid}`;
  docker([
    "run", "-d", "--name", cname, "--stop-timeout", "600", ...(LINUX ? ["--network", "host"] : []),
    "-v", "/var/run/docker.sock:/var/run/docker.sock",
    "-v", `${home}:${home}`, "-e", `LINEAGE_HOME=${home}`,
    "-v", `${paths[name]}:/keys/agent.json:ro`,
    IMAGE, "run", "--core", CORE_IN, "--key", "/keys/agent.json", "--interval", "1000",
  ], `start ${name}`);
  containers.push(cname);
  return cname;
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 900_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v as T;
    await Bun.sleep(1500);
  }
  throw new Error(`timed out waiting for ${what}`);
}
async function ok<T = any>(p: Promise<{ status: number; body: T }>, what: string): Promise<T> {
  const r = await p;
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

function cleanup() {
  for (const c of containers) spawnSync(["docker", "rm", "-f", c]);
  for (const p of procs) p.kill();
  if (!KEEP) rmSync(tmp, { recursive: true, force: true });
}

async function main() {
  const img = docker(["image", "inspect", "--format", "{{.Id}} {{.Architecture}}", IMAGE], "image");
  log(`image ${IMAGE} ${img}`);
  const help = spawnSync(["docker", "run", "--rm", IMAGE, "--help"]);
  check("the image prints its usage", help.exitCode === 0 && help.stdout.toString().includes("lineage-worker CLI"));
  const doc = JSON.parse(cli("v1", ["doctor"]));
  check("doctor inside the container sees the host daemon's architecture", doc.arch === (process.arch === "arm64" ? "arm64" : "amd64"), JSON.stringify(doc));

  const core = spawn(["bun", join(ROOT, "packages/core/src/main.ts"), "--data", join(tmp, "data"), "--port", String(PORT), "--config", join(tmp, "network.json"),
    "--admin-key", paths.admin, "--tick-ms", "500"], { stdout: "inherit", stderr: "inherit" });
  procs.push(core);
  await waitFor("core", async () => (await fetch(`${CORE}/v1/health`).catch(() => null))?.ok);

  const loaded = loadRecipe(join(ROOT, "recipes/fixture-b58"));
  const deps = await prepareDeps(loaded);
  await ok(admin.post("/v1/admin/recipes", { recipe: loaded.recipe, recipe_id: loaded.recipe_id }), "recipe");
  const snap = await ok(admin.post("/v1/admin/snapshots", { repo: loaded.recipe.repo, commit: loaded.recipe.commit, deps_digest: deps.digest }), "snapshot");
  const fund = (k: AgentKey, amount: bigint) => ok(admin.post("/v1/admin/faucet", { agent: k.id, amount: amount.toString() }), "faucet");
  const MIN_BOND = BigInt(net.min_bond);
  const BURN = BigInt(net.register_burn);
  for (const n of ["ref", "v1", "v2"] as const) await fund(keys[n], BURN + MIN_BOND * 2n);
  await ok(new CoreClient(CORE, keys.ref).post("/v1/agents", {}), "register ref");
  await ok(admin.post(`/v1/admin/agents/${keys.ref.id}/reference`, { reference: true }), "reference");
  log("reference runner (host) calibrating fixture-b58");
  await new Worker({ core: CORE, key: keys.ref, log: (m) => console.log(`   ref  ${m}`) }).submitCalibration(loaded.recipe_id, snap.snapshot_id, 3);
  const L = (await ok<any[]>(admin.get("/v1/lineages"), "lineages"))[0].lineage_id as string;
  // the two verifiers answer every replay: the reference runner stays out of the candidate's draw
  await ok(admin.post(`/v1/admin/agents/${keys.ref.id}/reference`, { reference: false }), "reference off");

  // register and bond with the image's own CLI, from inside containers
  for (const n of ["v1", "v2"] as const) {
    cli(n, ["register", "--core", CORE_IN, "--key", "/keys/agent.json"]);
    cli(n, ["bond", "--core", CORE_IN, "--key", "/keys/agent.json", "--amount", MIN_BOND.toString()]);
    const v = await ok(admin.get(`/v1/agents/${keys[n].id}`), n);
    check(`${n} registered and bonded by the containerized CLI`, v.kind === "verifier" && v.bond === MIN_BOND.toString() && !!v.capabilities, `caps ${JSON.stringify(v.capabilities)}`);
  }
  const c1 = startContainer("v1");
  const c2 = startContainer("v2");
  log(`containers ${c1}, ${c2}`);
  const quals = await waitFor("containers qualified", async () => {
    const vs = await Promise.all((["v1", "v2"] as const).map((n) => ok(admin.get(`/v1/agents/${keys[n].id}`), n)));
    return vs.every((v) => v.qualified_lineages.includes(L)) ? vs : null;
  });
  check("both containers qualified on fixture-b58 (sandboxes on the host daemon)", true,
    quals.map((v) => (v.qualifications as any[]).filter((q) => q.lineage_id === L).at(-1)?.status).join(", "));

  await ok(admin.post("/v1/admin/launches", { agent: keys.author.id, mint: generateAgentKey().id, launcher: generateAgentKey().id, target_repo: loaded.recipe.repo, hosted: false, identity_mode: "token" }), "launch");
  await ok(admin.post("/v1/admin/agent-fees", { agent: keys.author.id, amount: (BigInt(net.wake_threshold) * 10n).toString() }), "fees");
  const author = new Worker({ core: CORE, key: keys.author, lineages: [L], proposer: new ScriptedProposer(loadScript(join(ROOT, "fixtures/b58-patches"), ["perf_encode"])),
    log: (m) => console.log(`   auth ${m}`) });
  const id = await author.authorOnce();
  if (!id) throw new Error("author did not submit");
  const final = await waitFor("candidate final", async () => {
    const r = await admin.get(`/v1/candidates/${id}`);
    return r.status === 200 && ["accepted", "rejected", "expired"].includes(r.body.status) ? r.body : null;
  });
  const counted = (final.replays as any[]).filter((r) => r.status === "revealed").map((r) => r.replayer);
  check("perf_encode accepted on the containers' replays", final.status === "accepted" && [keys.v1.id, keys.v2.id].every((x) => counted.includes(x)),
    `${final.status} ${final.reason ?? ""} effect ${JSON.stringify(final.effect ?? null).slice(0, 80)}; revealed by ${counted.map((x: string) => x.slice(0, 6)).join(", ")}`);
  const ver = spawnSync(["bun", join(ROOT, "scripts/verify.ts"), "--core", CORE, "--candidate", id]);
  check("verify.ts recomputes the verdict", ver.exitCode === 0, ver.stdout.toString().trim().split("\n")[0]);

  for (const c of [c1, c2]) {
    docker(["stop", "-t", "600", c], `stop ${c}`);
    const logs = spawnSync(["docker", "logs", c]);
    const out = logs.stdout.toString() + logs.stderr.toString();
    const exit = docker(["inspect", "--format", "{{.State.ExitCode}}", c], "inspect");
    check(`docker stop drains ${c.split("-")[2]} (SIGTERM through tini, exit 0)`, /drained|drain timed out/.test(out) && exit === "0", `${out.trim().split("\n").filter((l) => l.includes("drain")).at(-1) ?? "no drain line"}; exit ${exit}`);
  }
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  console.error(e);
}
for (const c of containers) {
  const l = spawnSync(["docker", "logs", "--tail", "15", c]);
  if (failed) console.log(`--- ${c}\n${l.stdout}${l.stderr}`);
}
cleanup();
const pass = results.filter((r) => r.ok).length;
console.log(`\nW9b worker image: ${pass}/${results.length} checks passed${failed ? " (aborted)" : ""}`);
writeFileSync(join(import.meta.dir, `SMOKE-LAST-${process.arch}.json`), JSON.stringify({ at: new Date().toISOString(), image: IMAGE, arch: process.arch, results }, null, 2) + "\n");
process.exit(failed || pass !== results.length ? 1 : 0);
