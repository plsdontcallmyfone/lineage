#!/usr/bin/env bun
// Lineage site: writes the server's configuration files from the release being deployed. Idempotent;
// prints what it wrote, never a key.
//
//   bun scripts/deploy/site-config.ts --out /var/lib/lineage/site [--refresh-caps]
//
// Writes:
//   network.json  config/network.json with the site's values (daily epochs, the private canaries
//                 directory) and the `chain` block for devnet chain mode (scripts/devnet/devnet.json).
//                 `core_authority_key` is set only when the key file is on this machine; without it
//                 Core's chain bridge reads and never sends.
//   caps.json     this machine's capabilities (lineage-worker doctor). Written once and kept, so the
//                 digest the site's verifiers registered on chain stays stable across reboots;
//                 --refresh-caps rewrites it (site-chain.ts then sends update_agent).
//   runtime.json  the hosted runtime's config (devnet mode, rewritten each time from the values below; the
//                 previous file is kept as runtime.json.prev when it differed), used only when lineage-runtime is enabled.
//   runtime-authority.pub   the runtime authority's public key (Core's --runtime-key: no secret needed)
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalJson, H } from "@lineage/protocol";
import { doctor } from "../../packages/worker/src/doctor.ts";
import { devnetRpcUrl, redactRpc } from "../../packages/chain/src/endpoint.ts";

const ROOT = join(import.meta.dir, "..", "..");
const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
const OUT = opt("out") ?? "/var/lib/lineage/site";
const HOME_CFG = join(homedir(), ".config", "lineage");
mkdirSync(OUT, { recursive: true });

const devnet = JSON.parse(readFileSync(join(ROOT, "scripts/devnet/devnet.json"), "utf8"));
const net = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
// The Core authority key: on a site with service users (remote.sh users_setup) it lives in
// /etc/lineage-core, which this user cannot read, so remote.sh names it in LINEAGE_SITE_CORE_KEY;
// otherwise the copy in this user's home (older layout, local dry runs).
const coreKeyEnv = process.env.LINEAGE_SITE_CORE_KEY || "";
const coreKey = join(HOME_CFG, "devnet", "core-authority.json");
Object.assign(net, {
  _note: "Lineage public devnet site. M1 TEST values from config/network.json; epoch length daily so each post_epoch (about 0.0015 devnet SOL) happens once a day.",
  epoch_length_s: Number(process.env.LINEAGE_SITE_EPOCH_S ?? 86400),
  canaries_dir: "/var/lib/lineage/canaries",
  chain: {
    mode: "devnet",
    // the keyed RPC from ~/.config/lineage/rpc.env when deploy.sh copied it (Core publishes it redacted
    // at /v1/chain); this file is mode 600 because of it
    rpc_url: devnetRpcUrl(),
    registry_program: devnet.registry_program,
    launch_program: devnet.launch_program,
    line_mint: devnet.line_mint,
    ...(coreKeyEnv ? { core_authority_key: coreKeyEnv } : existsSync(coreKey) ? { core_authority_key: "~/.config/lineage/devnet/core-authority.json" } : {}),
    poll_ms: Number(process.env.LINEAGE_SITE_POLL_MS ?? 20000),
  },
});
writeFileSync(join(OUT, "network.json"), JSON.stringify(net, null, 2) + "\n", { mode: 0o600 });
chmodSync(join(OUT, "network.json"), 0o600);
console.log(`network.json: chain mode devnet, rpc ${redactRpc(net.chain.rpc_url)}, epoch ${net.epoch_length_s} s, poll ${net.chain.poll_ms} ms, ${net.chain.core_authority_key ? "Core authority key present (posts epochs and slashes)" : "no Core authority key (read only bridge)"}`);

const capsPath = join(OUT, "caps.json");
if (!existsSync(capsPath) || argv.includes("--refresh-caps")) {
  const r = doctor();
  writeFileSync(capsPath, JSON.stringify(r.capabilities, null, 2) + "\n");
  for (const n of r.notes) console.log(`doctor: ${n}`);
}
const caps = JSON.parse(readFileSync(capsPath, "utf8"));
console.log(`caps.json: ${caps.arch}, ${caps.cpus} cpus, ${caps.memory_mb} MB, ${caps.gpus.length} gpus, digest ${H("caps", canonicalJson(caps)).slice(0, 16)}...`);

writeFileSync(join(OUT, "runtime-authority.pub"), devnet.runtime_authority + "\n");
const runtimeCfg = {
  mode: "devnet",
  core: "http://127.0.0.1:9660",
  state_dir: "/var/lib/lineage/runtime",
  runtime_key: join(HOME_CFG, "devnet", "runtime-authority.json"),
  // no rpc_url: the runtime resolves it like Core (LINEAGE_DEVNET_RPC, the keyed rpc.env, else public devnet)
  _note:
    "Written by scripts/deploy/site-config.ts on every install and activate. Owner decision 2026-10-09: the hosted runtime runs on the site with a global cap of 10 USD of model spend per UTC day (global_max_usd per global_window_s, reset at 00:00 UTC), across all hosted agents; each agent is further limited by its compute vault, attempt_max_usd and agent_epoch_max_usd. Prices are TEST values.",
  attempt_max_usd: 0.5,
  agent_epoch_max_usd: 2,
  global_max_usd: 10,
  global_window_s: 86400,
  compute_price_line_per_usd: "20",
  compute_price_line_per_sandbox_s: "0.002",
  max_concurrent: 1,
  // agents as traders (plan T, owner direction 2026-10-09): devnet TEST tokens only, limits in Core's trading config
  trading: { enabled: true, poll_s: 60, market: "http://127.0.0.1:9668" },
  // hosted launches bind from the Wallet page (packages/runtime/src/bind.ts); the gate forwards /runtime/bind/* here
  bind_port: 9667,
  // agent desktops (SPEC 17.7, owner decisions 2026-10-10): 2 on this server (4 vCPU, 8 GB), then E2B
  // overflow, at most 3, within 5 USD of E2B time per UTC day (separate from the model cap); the
  // stream is served on bind_port at /desktops/*, which the gate forwards
  desktops_max: 2,
  e2b_max: 3,
  desktop_usd_per_day: 5,
  desktop_allow: ["github.com", "githubusercontent.com", "githubassets.com"],
  e2b: { template: "desktop", vcpu: 2, ram_gib: 4, session_max_s: 3600 },
};
const runtimePath = join(OUT, "runtime.json");
const runtimeText = JSON.stringify(runtimeCfg, null, 2) + "\n";
const prevRuntime = existsSync(runtimePath) ? readFileSync(runtimePath, "utf8") : null;
if (prevRuntime !== null && prevRuntime !== runtimeText) writeFileSync(`${runtimePath}.prev`, prevRuntime, { mode: 0o600 });
writeFileSync(runtimePath, runtimeText, { mode: 0o600 });
chmodSync(runtimePath, 0o600);
console.log(
  `runtime.json: global cap ${runtimeCfg.global_max_usd} USD per ${runtimeCfg.global_window_s} s (UTC day), attempt ${runtimeCfg.attempt_max_usd}, agent epoch ${runtimeCfg.agent_epoch_max_usd}, desktops ${runtimeCfg.desktops_max} here + ${runtimeCfg.e2b_max} E2B (${runtimeCfg.desktop_usd_per_day} USD per UTC day)${prevRuntime !== null && prevRuntime !== runtimeText ? " (changed; previous kept as runtime.json.prev)" : ""}; ${existsSync(runtimeCfg.runtime_key) ? "runtime authority key present" : "no runtime authority key (lineage-runtime stays disabled)"}`,
);
