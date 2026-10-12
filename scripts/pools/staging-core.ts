#!/usr/bin/env bun
// The staging Core of the pools and fee-claims proofs: a real Core (its HTTP API, its database, the
// pools and fee-claims modules wired to the chain exactly as packages/core/src/main.ts wires them),
// started without the chain bridge. The bridge mirrors every registration, epoch, message and launch
// deposit since genesis, which takes many minutes on a public devnet endpoint and is not what these
// features read; without it and without the Core authority key this process can never post an
// epoch or a slash. Flags and keys come from the environment (scripts/pools/staging.ts).
//
//   bun scripts/pools/staging-core.ts --data <dir> --port 9664 --chain <chain.json> --admin-key <keypair.json>
import { readFileSync } from "node:fs";
import { ChainReader, Rpc } from "@units/chain";
import { applyNetworkProfile } from "../../packages/chain/src/profile-node.ts";
import { loadChainSettings } from "../../packages/core/src/chain.ts";
import { systemClock } from "../../packages/core/src/clock.ts";
import { loadNetworkConfig } from "../../packages/core/src/config.ts";
import { Core } from "../../packages/core/src/core.ts";
import { serve } from "../../packages/core/src/http.ts";
import { wirePoolsAndClaims } from "../../packages/core/src/pools-wiring.ts";
import { keyFromSolanaJson } from "@units/protocol";

const arg = (n: string) => process.argv[process.argv.indexOf(`--${n}`) + 1]!;
const profile = applyNetworkProfile();
if (profile.network !== "devnet") throw new Error("the staging Core is devnet only");
const settings = loadChainSettings(arg("chain"))!;
if (settings.core_authority_key) throw new Error("the staging Core never holds the Core authority key");
const reader = new ChainReader(Rpc.http(settings.rpc_url), settings.registry_program, settings.launch_program);
const core = new Core({ dataDir: arg("data"), network: loadNetworkConfig("config/network.json"), adminId: keyFromSolanaJson(JSON.parse(readFileSync(arg("admin-key"), "utf8"))).id,
  clock: systemClock, trees: null, chainMode: true });
await wirePoolsAndClaims(core, reader, settings, profile.network);
const server = serve(core, { port: Number(arg("port")) });
const timer = setInterval(() => { try { core.tick(); } catch (e) { console.error("tick failed", e); } }, 1000);
console.log(`staging core on http://127.0.0.1:${server.port} (pid ${process.pid}, no chain bridge)`);
const stop = () => { clearInterval(timer); server.stop(true); core.close(); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
