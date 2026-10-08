import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { systemClock } from "./clock.ts";
import { loadNetworkConfig } from "./config.ts";
import { ChainReader, Rpc } from "@lineage/chain";
import { ChainBridge, chainBootstrap, loadChainSettings } from "./chain.ts";
import { erc8004Of } from "./erc8004.ts";
import { Core } from "./core.ts";
import { canaryDirIsPublic, loadCanaryDir } from "./hardening.ts";
import { serve } from "./http.ts";
import { GitTreeSource } from "./trees.ts";
import { base58Decode, keyFromSolanaJson } from "./protocol.ts";

// bun packages/core/src/main.ts --data ./data --port 9660 --config config/network.json --admin-key <path>
//   [--runtime-key <path>] [--tick-ms 1000] [--host 127.0.0.1] [--chain <file>]
//   [--canaries-dir <dir>] [--allow-public-canaries]
// Canaries (SPEC 10.5) load from a private directory: `--canaries-dir`, else `canaries_dir` in the
// config file, else ~/.config/lineage/canaries. Layout: <dir>/<recipe name>/index.json + <name>.diff.
// A directory inside this repository (recipes/*/canaries are public test fixtures) is refused unless
// --allow-public-canaries is given (tests only): replayers could recognise public canaries by hash.
// Chain mode: a `chain` object with `mode: "devnet"` in the config file, or `--chain <file>` (for
// example scripts/devnet/devnet.json). See src/chain.ts. Without it Core runs the simulated ledger.
// Key files are either a Solana keypair JSON (64-byte array; only the public half is used) or a file
// holding the base58 public key.

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

function argvFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function readPubkey(path: string): string {
  const text = readFileSync(path, "utf8").trim();
  if (text.startsWith("[")) return keyFromSolanaJson(JSON.parse(text)).id;
  if (base58Decode(text).length !== 32) throw new Error(`${path}: not a 32-byte base58 public key`);
  return text;
}

function portBusy(port: number): string | null {
  try {
    const out = execFileSync("lsof", ["-ti", `:${port}`], { encoding: "utf8" }).trim();
    return out || null;
  } catch {
    return null;
  }
}

// replica mode (SPEC 10.8): a read-only Core that recomputes another Core's verdicts and epochs from its public API
if (arg("replica-of")) await (await import("./replica.ts")).replicaMain(process.argv.slice(2));

const dataDir = resolve(arg("data", "./data")!);
const port = Number(arg("port", "9660"));
const configPath = arg("config", "config/network.json")!;
const adminKey = arg("admin-key");
const runtimeKey = arg("runtime-key");
const tickMs = Number(arg("tick-ms", "1000"));
const host = arg("host", "127.0.0.1")!;

if (!adminKey) {
  console.error("--admin-key <path> is required");
  process.exit(2);
}
if (port < 9660 || port > 9669) {
  console.error("port must be in this repo's block 9660-9669");
  process.exit(2);
}
const busy = portBusy(port);
if (busy) {
  console.error(`port ${port} is already in use by pid ${busy.replace(/\n/g, ", ")}; not binding`);
  process.exit(1);
}

const chainSettings = loadChainSettings(arg("chain") ?? configPath);
let network = loadNetworkConfig(configPath);
let firstEpoch = 0;
let reader: ChainReader | null = null;
if (chainSettings) {
  reader = new ChainReader(Rpc.http(chainSettings.rpc_url), chainSettings.registry_program, chainSettings.launch_program);
  const boot = await chainBootstrap(network, reader);
  network = boot.network;
  firstEpoch = boot.firstEpoch;
  console.log(`chain mode ${chainSettings.mode}: ${chainSettings.rpc_url}, registry ${chainSettings.registry_program}, mint ${boot.registry.mint} (${boot.decimals} decimals), first epoch ${firstEpoch}`);
}

const core = new Core({
  dataDir,
  network,
  adminId: readPubkey(adminKey),
  runtimeId: runtimeKey ? readPubkey(runtimeKey) : undefined,
  clock: systemClock,
  trees: argvFlag("no-trees") ? null : new GitTreeSource(),
  chainMode: !!chainSettings,
  firstEpoch,
});
if (chainSettings) erc8004Of(core).configure({ registryProgram: chainSettings.registry_program }); // ERC-8004 file names the configured registry
const REPO = resolve(import.meta.dir, "../../..");
const rawConfig = JSON.parse(readFileSync(configPath, "utf8")) as { canaries_dir?: unknown };
const canariesDir = resolve(arg("canaries-dir") ?? (typeof rawConfig.canaries_dir === "string" ? rawConfig.canaries_dir : join(homedir(), ".config/lineage/canaries")));
const insideRepo = canaryDirIsPublic(canariesDir, REPO);
let canaryNote = "";
function loadCanaries() {
  if (insideRepo && !argvFlag("allow-public-canaries")) {
    canaryNote ||= `canaries: ${canariesDir} is inside the public repository; not loaded (pass --allow-public-canaries for tests)`;
    return;
  }
  const r = loadCanaryDir(core, canariesDir);
  if (r.loaded) console.log(`canaries: loaded ${r.loaded} from ${canariesDir} (${r.lineages} lineages)`);
  for (const e of r.errors) if (!canaryNote.includes(e)) (canaryNote += e + "\n"), console.error(`canaries: ${e}`);
}
loadCanaries();
if (canaryNote && insideRepo) console.error(canaryNote);
const canaryTimer = setInterval(() => {
  try {
    loadCanaries();
  } catch (e) {
    console.error("canary load failed", e);
  }
}, 60_000);

const bridge = chainSettings ? new ChainBridge(core, chainSettings, { reader: reader!, log: (m) => console.log(`[chain] ${m}`) }) : null;
if (bridge) await bridge.tick().catch(() => undefined);
const chainTimer = bridge ? setInterval(() => void bridge.tick().catch(() => undefined), chainSettings!.poll_ms ?? 5000) : null;
const server = serve(core, { port, hostname: host });
const timer = setInterval(() => {
  try {
    core.tick();
  } catch (e) {
    console.error("tick failed", e);
  }
}, tickMs);
console.log(`lineage core on http://${host}:${server.port} (data ${dataDir}, admin ${core.adminId}, epoch ${core.currentEpoch().n}, pid ${process.pid})`);

const stop = () => {
  clearInterval(timer);
  clearInterval(canaryTimer);
  if (chainTimer) clearInterval(chainTimer);
  server.stop(true);
  core.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
