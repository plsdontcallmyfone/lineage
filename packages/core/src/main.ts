import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { systemClock } from "./clock.ts";
import { loadNetworkConfig } from "./config.ts";
import { Core } from "./core.ts";
import { serve } from "./http.ts";
import { base58Decode, keyFromSolanaJson } from "./protocol.ts";

// bun packages/core/src/main.ts --data ./data --port 9660 --config config/network.json --admin-key <path>
//   [--runtime-key <path>] [--tick-ms 1000] [--host 127.0.0.1]
// Key files are either a Solana keypair JSON (64-byte array; only the public half is used) or a file
// holding the base58 public key.

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
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

const core = new Core({
  dataDir,
  network: loadNetworkConfig(configPath),
  adminId: readPubkey(adminKey),
  runtimeId: runtimeKey ? readPubkey(runtimeKey) : undefined,
  clock: systemClock,
});
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
  server.stop(true);
  core.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
