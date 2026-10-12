#!/usr/bin/env bun
// Exit check for the verifier kit's image (the kit is exported by scripts/public/export-verifier.ts):
// a local simulated Core from THIS repository with one real unit (base58-py, calibrated by an
// in-process reference runner on the host), two verifiers that run ONLY as containers of the kit's
// image (registered and bonded with the image's own CLI, sandboxes on the host Docker daemon through
// the mounted socket), and a scripted author on the host submitting one known patch. Checks: the image
// reports the snapshot commit, both containers qualify, both replay the candidate, it becomes final
// on their replays, verify.ts inside the image recomputes the verdict, and `docker stop` drains each
// worker. Same shape as images/worker/smoke.ts, on a public recipe (the kit ships no fixture).
//
// Nothing here touches a chain or a public site. Containers are named units-kit-smoke-* and labelled
// units=1; they are removed by name. The toolchain image for the recipe must be on this machine
// (pinned, or a local rebuild in the local pin map: scripts/local-images.ts).
//
// Usage: bun scripts/public/verifier-smoke.ts [--port 9664] [--image units/verifier:local] [--recipe base58-py] [--patch encode_chunked] [--keep]
import "../../packages/protocol/src/env-alias.ts";
import { spawn, spawnSync, type Subprocess } from "bun";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateAgentKey, type AgentKey } from "@units/protocol";
import { CoreClient } from "../../packages/core/src/client.ts";

const ROOT = join(import.meta.dir, "../..");
const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1]! : d);
const PORT = Number(opt("port", "9664"));
const IMAGE = opt("image", "units/verifier:local");
const RECIPE = opt("recipe", "base58-py");
const PATCH = opt("patch", "encode_chunked");
const KEEP = argv.includes("--keep");
const CORE = `http://127.0.0.1:${PORT}`;
const LINUX = process.platform === "linux";
const CORE_IN = LINUX ? CORE : `http://host.docker.internal:${PORT}`;
const T0 = Date.now();
const log = (m: string) => console.log(`[kit +${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ check: name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

if (![9663, 9664, 9666, 9667, 9668, 9669].includes(PORT)) {
  console.error("use a port of this repository's test block: 9663, 9664, 9666-9669");
  process.exit(2);
}
if (spawnSync(["lsof", "-ti", `:${PORT}`]).stdout.toString().trim()) {
  console.error(`port ${PORT} busy; pick another of 9663, 9664, 9666-9669`);
  process.exit(1);
}

// Docker Desktop shares /private with its VM; sandbox bind mounts must be the same path on both sides
const tmp = mkdtempSync(join(process.platform === "darwin" ? "/private/tmp" : "/tmp", "units-kit-smoke-"));
// the local pin map (a rebuilt toolchain image standing in for the pinned id) is read by the host
// side and by the containers from one file inside tmp
const hostMap = (process.env.UNITS_LOCAL_IMAGES && !/^(off|0|false|no)$/i.test(process.env.UNITS_LOCAL_IMAGES)) ? process.env.UNITS_LOCAL_IMAGES : join(homedir(), ".lineage", "local-images.json");
const MAP = join(tmp, "local-images.json");
writeFileSync(MAP, existsSync(hostMap) ? readFileSync(hostMap) : '{"version":1,"images":{}}\n');
process.env.UNITS_LOCAL_IMAGES = MAP;
process.env.LINEAGE_LOCAL_IMAGES = MAP;
process.env.UNITS_HOME = join(tmp, "home-host");
process.env.LINEAGE_HOME = join(tmp, "home-host");
const { loadRecipe, prepareDeps } = await import("@units/sandbox");
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
const NET = LINUX ? ["--network", "host"] : [];

function docker(args: string[], what: string): string {
  const p = spawnSync(["docker", ...args]);
  if (p.exitCode !== 0) throw new Error(`${what}: ${p.stderr.toString().trim()}`);
  return p.stdout.toString().trim();
}
/** The kit image's CLI as a one-off container (key read only). */
function cli(name: keyof typeof keys, args: string[]) {
  return docker(["run", "--rm", "--label", "units=1", ...NET, "-v", `${paths[name]}:/keys/agent.json:ro`, IMAGE, ...args], `${name} ${args[0]}`);
}
function startContainer(name: "v1" | "v2") {
  const home = join(tmp, `home-${name}`);
  mkdirSync(home, { recursive: true });
  const cname = `units-kit-smoke-${name}-${process.pid}`;
  docker([
    "run", "-d", "--name", cname, "--label", "units=1", "--stop-timeout", "600", ...NET,
    "-v", "/var/run/docker.sock:/var/run/docker.sock",
    "-v", `${home}:${home}`, "-e", `UNITS_HOME=${home}`,
    "-v", `${MAP}:${MAP}:ro`, "-e", `UNITS_LOCAL_IMAGES=${MAP}`,
    "-v", `${paths[name]}:/keys/agent.json:ro`,
    IMAGE, "run", "--core", CORE_IN, "--key", "/keys/agent.json", "--interval", "1000",
  ], `start ${name}`);
  containers.push(cname);
  return cname;
}
async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 1_500_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v as T;
    await Bun.sleep(2000);
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
  // sandboxes wrote as uid 10001 inside the Docker VM; on Linux a leftover may need the worker's uid to remove
  if (!KEEP) rmSync(tmp, { recursive: true, force: true });
}

async function main() {
  log(`image ${IMAGE} ${docker(["image", "inspect", "--format", "{{.Id}} {{.Architecture}}", IMAGE], "image")}`);
  const src = spawnSync(["docker", "run", "--rm", "--label", "units=1", IMAGE, "source"]);
  const commit = /commit\s+([0-9a-f]{40})/.exec(src.stdout.toString())?.[1] ?? "";
  check("the image names the monorepo commit it was exported from", src.exitCode === 0 && !!commit, commit.slice(0, 12));
  const doc = JSON.parse(docker(["run", "--rm", "--label", "units=1", "-v", "/var/run/docker.sock:/var/run/docker.sock", IMAGE, "doctor"], "doctor"));
  check("doctor inside the container sees the host daemon's architecture", doc.arch === (process.arch === "arm64" ? "arm64" : "amd64"), JSON.stringify(doc));

  const core = spawn(["bun", join(ROOT, "packages/core/src/main.ts"), "--data", join(tmp, "data"), "--port", String(PORT), "--config", join(tmp, "network.json"),
    "--admin-key", paths.admin, "--tick-ms", "500"], { stdout: "inherit", stderr: "inherit", env: { ...process.env, UNITS_NETWORK: "devnet", LINEAGE_NETWORK: "devnet" } });
  procs.push(core);
  await waitFor("core", async () => (await fetch(`${CORE}/v1/health`).catch(() => null))?.ok, 60_000);

  const loaded = loadRecipe(join(ROOT, "recipes", RECIPE));
  // the kit must hold this very recipe: same id inside the image as in this repository
  const inImage = spawnSync(["docker", "run", "--rm", "--label", "units=1", "--entrypoint", "bun", IMAGE, "-e",
    `import { loadRecipe } from "@units/sandbox"; console.log(loadRecipe("/opt/units/recipes/${RECIPE}").recipe_id)`]);
  check(`the image holds ${RECIPE} with this repository's recipe id`, inImage.stdout.toString().trim() === loaded.recipe_id, `${loaded.recipe_id.slice(0, 12)} / ${inImage.stdout.toString().trim().slice(0, 12)}`);

  const deps = await prepareDeps(loaded);
  await ok(admin.post("/v1/admin/recipes", { recipe: loaded.recipe, recipe_id: loaded.recipe_id }), "recipe");
  const snap = await ok(admin.post("/v1/admin/snapshots", { repo: loaded.recipe.repo, commit: loaded.recipe.commit, deps_digest: deps.digest }), "snapshot");
  const fund = (k: AgentKey, amount: bigint) => ok(admin.post("/v1/admin/faucet", { agent: k.id, amount: amount.toString() }), "faucet");
  const MIN_BOND = BigInt(net.min_bond);
  const BURN = BigInt(net.register_burn);
  for (const n of ["ref", "v1", "v2"] as const) await fund(keys[n], BURN + MIN_BOND * 2n);
  await ok(new CoreClient(CORE, keys.ref).post("/v1/agents", {}), "register ref");
  await ok(admin.post(`/v1/admin/agents/${keys.ref.id}/reference`, { reference: true }), "reference");
  log(`reference runner (host) calibrating ${RECIPE}`);
  await new Worker({ core: CORE, key: keys.ref, log: (m) => console.log(`   ref  ${m}`) }).submitCalibration(loaded.recipe_id, snap.snapshot_id, 3);
  const L = (await ok<any[]>(admin.get("/v1/lineages"), "lineages"))[0].lineage_id as string;
  await ok(admin.post(`/v1/admin/agents/${keys.ref.id}/reference`, { reference: false }), "reference off");

  for (const n of ["v1", "v2"] as const) {
    cli(n, ["register", "--core", CORE_IN, "--key", "/keys/agent.json"]);
    cli(n, ["bond", "--core", CORE_IN, "--key", "/keys/agent.json", "--amount", MIN_BOND.toString()]);
    const v = await ok(admin.get(`/v1/agents/${keys[n].id}`), n);
    check(`${n} registered and bonded by the kit image's CLI`, v.kind === "verifier" && v.bond === MIN_BOND.toString() && !!v.capabilities, `caps ${JSON.stringify(v.capabilities)}`);
  }
  const c1 = startContainer("v1");
  const c2 = startContainer("v2");
  log(`containers ${c1}, ${c2}`);
  const quals = await waitFor("containers qualified", async () => {
    const vs = await Promise.all((["v1", "v2"] as const).map((n) => ok(admin.get(`/v1/agents/${keys[n].id}`), n)));
    return vs.every((v) => v.qualified_lineages.includes(L)) ? vs : null;
  });
  check(`both containers qualified on ${RECIPE} (sandboxes on the host daemon)`, true,
    quals.map((v) => (v.qualifications as any[]).filter((q) => q.lineage_id === L).at(-1)?.status).join(", "));

  await ok(admin.post("/v1/admin/launches", { agent: keys.author.id, mint: generateAgentKey().id, launcher: generateAgentKey().id, target_repo: loaded.recipe.repo, hosted: false, identity_mode: "token" }), "launch");
  await ok(admin.post("/v1/admin/agent-fees", { agent: keys.author.id, amount: (BigInt(net.wake_threshold) * 10n).toString() }), "fees");
  const author = new Worker({ core: CORE, key: keys.author, lineages: [L], proposer: new ScriptedProposer(loadScript(join(ROOT, "recipes", RECIPE, "candidates"), [PATCH])),
    log: (m) => console.log(`   auth ${m}`) });
  const id = await author.authorOnce();
  if (!id) throw new Error("author did not submit");
  const final = await waitFor("candidate final", async () => {
    const r = await admin.get(`/v1/candidates/${id}`);
    return r.status === 200 && ["accepted", "rejected", "expired"].includes(r.body.status) ? r.body : null;
  });
  const counted = (final.replays as any[]).filter((r) => r.status === "revealed").map((r) => r.replayer);
  check(`${PATCH} accepted on the containers' replays`, final.status === "accepted" && [keys.v1.id, keys.v2.id].every((x) => counted.includes(x)),
    `${final.status} ${final.reason ?? ""} effect ${JSON.stringify(final.effect ?? null).slice(0, 80)}; revealed by ${counted.map((x: string) => x.slice(0, 6)).join(", ")}`);
  const ver = spawnSync(["docker", "run", "--rm", "--label", "units=1", ...NET, IMAGE, "verify", "--core", CORE_IN, "--candidate", id, "--no-draws"]);
  check("verify inside the image recomputes the verdict", ver.exitCode === 0, ver.stdout.toString().trim().split("\n")[0]);

  for (const c of [c1, c2]) {
    docker(["stop", "-t", "600", c], `stop ${c}`);
    const logs = spawnSync(["docker", "logs", c]);
    const out = logs.stdout.toString() + logs.stderr.toString();
    const exit = docker(["inspect", "--format", "{{.State.ExitCode}}", c], "inspect");
    check(`docker stop drains ${c.split("-")[3]} (SIGTERM through tini, exit 0)`, /drained|drain timed out/.test(out) && exit === "0", `${out.trim().split("\n").filter((l) => l.includes("drain")).at(-1) ?? "no drain line"}; exit ${exit}`);
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
  const l = spawnSync(["docker", "logs", "--tail", "20", c]);
  if (failed) console.log(`--- ${c}\n${l.stdout}${l.stderr}`);
}
cleanup();
const pass = results.filter((r) => r.ok).length;
console.log(`\nverifier kit image: ${pass}/${results.length} checks passed${failed ? " (aborted)" : ""}`);
if (argv.includes("--out")) writeFileSync(opt("out", ""), JSON.stringify({ at: new Date().toISOString(), image: IMAGE, arch: process.arch, recipe: RECIPE, patch: PATCH, results }, null, 2) + "\n");
process.exit(failed || pass !== results.length ? 1 : 0);
