#!/usr/bin/env bun
// A local units instance (Core, market indexer, dashboard, site gate) under the mainnet profile with the
// OFFICIAL deployment's chain state (config/mainnet/state.json), reading and sending to a local FORK of
// mainnet (scripts/mainnet/fork.sh with the official accounts cloned: see pool-launch-fork.ts --fork-args).
// For driving the real Launch wizard against the real cloned accounts:
//
//   UNITS_NETWORK=mainnet bun scripts/mainnet/fork-instance.ts            # runs until stopped (Ctrl-C or kill <its pid>)
//   UNITS_NETWORK=mainnet UNITS_MAINNET_RPC=http://127.0.0.1:9690 bun scripts/mainnet/live-launch.ts --official --fork \
//        --site http://127.0.0.1:9696 --key <throwaway fork key> --send ...
//
// Fork only: the profile overlay written here names the FORK's genesis, so every genesis check matches the
// fork and nothing here can point at mainnet. Jito is a local stand-in that answers getTipAccounts with the
// real tip accounts and refuses every bundle (the page then sends in order). The same setup as
// scripts/mainnet/wizard-fork.ts. Ports (checked free first): Core 9694, dashboard 9695, gate 9696, Jito
// stand-in 9697, indexer 9698.
import { spawn, spawnSync, type Subprocess } from "bun";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey } from "@units/protocol";
import { JITO_BLOCK_ENGINE, Rpc } from "@units/chain";

const ROOT = join(import.meta.dir, "..", "..");
const FORK = "http://127.0.0.1:9690";
const PORTS = { core: 9694, web: 9695, gate: 9696, jito: 9697, indexer: 9698 };
const rpc = Rpc.http(FORK, "confirmed");
const genesis = await rpc.call<string>("getGenesisHash");
if (genesis === "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d") throw new Error("refusing: the endpoint is mainnet, this runs on a local fork only");
for (const p of Object.values(PORTS)) if (spawnSync(["lsof", "-ti", `:${p}`]).stdout.toString().trim()) throw new Error(`port ${p} is taken`);
const state = JSON.parse(readFileSync(join(ROOT, "config/mainnet/state.json"), "utf8"));
const tmp = mkdtempSync(join(tmpdir(), "units-fork-instance-"));
writeFileSync(join(tmp, "state.json"), JSON.stringify(state));
writeFileSync(join(tmp, "profile.local.json"), JSON.stringify({ profiles: { mainnet: { genesis, state_file: join(tmp, "state.json") } } }));
const net = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
const { prepay: prepayOver, ...restOver } = (state.network_overrides ?? {}) as Record<string, any>;
Object.assign(net, restOver, { prepay: { ...net.prepay, ...(prepayOver ?? {}) } });
// --prepay-from <site>: Core's launch credits and fronting settings as that site serves them now (GET /v1/config, read
// only), so the local Core prices the credits the way the live one does (the market rate on the official deployment)
const from = process.argv.includes("--prepay-from") ? process.argv[process.argv.indexOf("--prepay-from") + 1]!.replace(/\/+$/, "") : null;
if (from) {
  const live = ((await fetch(`${from}/v1/config`).then((r) => r.json())) as any)?.network?.prepay;
  if (!live) throw new Error(`${from} served no prepay block`);
  const { rate: _rate, min_base_units: _min, line_per_usd_config, ...cfg } = live;
  net.prepay = { ...net.prepay, ...cfg, ...(line_per_usd_config ? { line_per_usd: line_per_usd_config } : {}) };
}
net.chain = { mode: "mainnet", rpc_url: "from-environment:UNITS_MAINNET_RPC", registry_program: state.registry_program, launch_program: state.launch_program, line_mint: state.line_mint, poll_ms: 3_000 };
writeFileSync(join(tmp, "network.json"), JSON.stringify(net), { mode: 0o600 });
writeFileSync(join(tmp, "admin.json"), JSON.stringify(Array.from(generateAgentKey().secret)), { mode: 0o600 });

const tipAccounts = ((await fetch(JITO_BLOCK_ENGINE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTipAccounts", params: [] }) })
  .then((r) => r.json()).catch(() => null)) as { result?: string[] } | null)?.result ?? [];
if (!tipAccounts.length) throw new Error("Jito gave no tip accounts (needed to build the tip as the wizard does)");
for (const a of tipAccounts) if ((await rpc.getBalance(a)) === 0n) await rpc.call("requestAirdrop", [a, 1_000_000_000]);
let bundles = 0;
const jito = Bun.serve({ port: PORTS.jito, hostname: "127.0.0.1", fetch: async (req) => {
  const b = (await req.json().catch(() => ({}))) as { method?: string; id?: unknown };
  if (b.method === "getTipAccounts") return Response.json({ jsonrpc: "2.0", id: b.id, result: tipAccounts });
  if (b.method === "sendBundle") {
    bundles++;
    console.log(`[fork-instance] the Jito stand-in refused bundle ${bundles}`);
    return Response.json({ jsonrpc: "2.0", id: b.id, error: { code: -32602, message: "bundle refused by the fork stand-in for Jito" } });
  }
  return Response.json({ jsonrpc: "2.0", id: b.id, error: { code: -32601, message: "not served by the fork stand-in" } });
} });

const CORE = `http://127.0.0.1:${PORTS.core}`, WEB = `http://127.0.0.1:${PORTS.web}`, BASE = `http://127.0.0.1:${PORTS.gate}`, MARKET = `http://127.0.0.1:${PORTS.indexer}`;
const env: Record<string, string | undefined> = { ...process.env, UNITS_NETWORK: "mainnet", UNITS_PROFILE_LOCAL: join(tmp, "profile.local.json"), UNITS_MAINNET_RPC: FORK, UNITS_JITO_URL: `http://127.0.0.1:${PORTS.jito}`,
  UNITS_HOME: join(tmp, "home"), UNITS_PORT_BLOCK: "9690-9699", UNITS_INDEXER_URL: MARKET };
const procs: Subprocess[] = [];
const run = (name: string, cmd: string[]) => procs.push(spawn(cmd, { cwd: ROOT, env, stdout: Bun.file(join(tmp, `${name}.log`)), stderr: Bun.file(join(tmp, `${name}.log`)) }));
run("core", ["bun", "packages/core/src/main.ts", "--data", join(tmp, "data"), "--port", String(PORTS.core), "--config", join(tmp, "network.json"), "--admin-key", join(tmp, "admin.json"), "--tick-ms", "1000"]);
run("indexer", ["bun", "packages/indexer/src/main.ts", "--port", String(PORTS.indexer), "--db", join(tmp, "market.db"), "--interval", "3", "--min-gap-ms", "20", "--core", CORE]);
run("web", ["bun", "apps/web/server.ts", "--port", String(PORTS.web), "--core", CORE, "--market", MARKET]);
run("gate", ["bun", "scripts/deploy/gate.ts", "--port", String(PORTS.gate), "--web", WEB, "--core", CORE, "--indexer", MARKET, "--origin", BASE]);
const stop = () => {
  for (const p of procs) p.kill(); // each by its own handle (its PID), nothing by name
  jito.stop(true);
};
process.on("exit", stop);
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
const up = async (u: string) => fetch(u).then((r) => r.ok).catch(() => false);
let started = false;
for (let i = 0; i < 240 && !started; i++) {
  started = (await up(`${CORE}/v1/health`)) && (await up(`${WEB}/chain/config`)) && (await up(`${BASE}/gate/health`)) && (await up(`${MARKET}/market/summary`));
  if (!started) await Bun.sleep(500);
}
if (!started) {
  for (const n of ["core", "web", "gate", "indexer"]) console.error(`--- ${n} log tail\n${(await Bun.file(join(tmp, `${n}.log`)).text().catch(() => "")).split("\n").slice(-6).join("\n")}`);
  throw new Error("the local instance did not start");
}
console.log(`[fork-instance] up: site ${BASE} (logs in ${tmp}); fork genesis ${genesis}; pid ${process.pid}`);
await new Promise(() => {});
