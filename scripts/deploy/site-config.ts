#!/usr/bin/env bun
// units site: writes the server's configuration files from the release being deployed. Idempotent;
// prints what it wrote, never a key.
//
//   bun scripts/deploy/site-config.ts --out /var/lib/units/site [--refresh-caps]
//
// Writes:
//   network.json  config/network.json with the site's values (daily epochs, the private canaries
//                 directory) and the `chain` block for devnet chain mode (scripts/devnet/devnet.json).
//                 `core_authority_key` is set only when the key file is on this machine; without it
//                 Core's chain bridge reads and never sends.
//   caps.json     this machine's capabilities (units-worker doctor). Written once and kept, so the
//                 digest the site's verifiers registered on chain stays stable across reboots;
//                 --refresh-caps rewrites it (site-chain.ts then sends update_agent).
//   runtime.json  the hosted runtime's config (devnet mode, rewritten each time from the values below; the
//                 previous file is kept as runtime.json.prev when it differed), used only when lineage-runtime is enabled.
//   runtime-authority.pub   the runtime authority's public key (Core's --runtime-key: no secret needed)
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalJson, H } from "@units/protocol";
import { doctor } from "../../packages/worker/src/doctor.ts";
import { devnetRpcUrl, redactRpc } from "../../packages/chain/src/endpoint.ts";
import { instanceLayout, SHARED_E2B_DIR } from "./instance.ts";

const ROOT = join(import.meta.dir, "..", "..");
const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
// A second instance on the same server (instance.ts; UNITS_INSTANCE=mainnet): its own directories,
// ports and chain state file, mainnet chain mode and the mainnet test's safety values. Unset: the
// devnet site, as before.
const L = instanceLayout(process.env.UNITS_INSTANCE);
const MAIN = L.network === "mainnet";
const OUT = opt("out") ?? `${L.state}/site`;
const HOME_CFG = join(homedir(), ".config", "lineage");
mkdirSync(OUT, { recursive: true });

const stateFile = process.env.UNITS_INSTANCE_STATE || (L.stateFile.startsWith("/") ? L.stateFile : join(ROOT, L.stateFile));
if (!existsSync(stateFile)) {
  // staged before the programs exist (docs/DEPLOY-SITE.md "Second instance"): nothing to configure yet
  console.log(`no chain state at ${stateFile}: no configuration written; the ${L.name || "devnet"} instance cannot be activated until it is shipped`);
  process.exit(0);
}
const devnet = JSON.parse(readFileSync(stateFile, "utf8"));
const net = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
// the instance's state file may carry Core config overrides (network_overrides: top-level keys replace,
// the prepay block is merged key by key), e.g. the units account payment recipient on mainnet
if (MAIN && devnet.network_overrides && typeof devnet.network_overrides === "object") {
  const { prepay, ...rest } = devnet.network_overrides as Record<string, unknown>;
  Object.assign(net, rest);
  if (prepay && typeof prepay === "object") net.prepay = { ...net.prepay, ...(prepay as object) };
}
// The Core authority key: on a site with service users (remote.sh users_setup) it lives in
// /etc/units-core, which this user cannot read, so remote.sh names it in UNITS_SITE_CORE_KEY;
// otherwise the copy in this user's home (older layout, local dry runs).
const coreKeyEnv = (process.env.UNITS_SITE_CORE_KEY ?? process.env.LINEAGE_SITE_CORE_KEY) || "";
const coreKey = join(HOME_CFG, L.keysDir, "core-authority.json");
Object.assign(net, {
  _note: MAIN
    ? "units mainnet test instance (docs/MAINNET-RUNBOOK.md \"Mainnet test\"). TEST values from config/network.json with the state file's network_overrides; epoch length daily."
    : "units public devnet site. M1 TEST values from config/network.json; epoch length daily so each post_epoch (about 0.0015 devnet SOL) happens once a day.",
  epoch_length_s: Number((process.env.UNITS_SITE_EPOCH_S ?? process.env.LINEAGE_SITE_EPOCH_S) ?? 86400),
  canaries_dir: `${L.state}/canaries`,
  chain: {
    mode: L.network,
    // devnet: the keyed RPC from ~/.config/lineage/rpc.env when deploy.sh copied it (Core publishes it
    // redacted at /v1/chain); this file is mode 600 because of it. mainnet: never in a file here, Core
    // takes UNITS_MAINNET_RPC from its unit's environment (packages/core main.ts)
    rpc_url: MAIN ? "from-environment:UNITS_MAINNET_RPC" : devnetRpcUrl(),
    registry_program: devnet.registry_program,
    launch_program: devnet.launch_program,
    line_mint: devnet.line_mint,
    ...(coreKeyEnv ? { core_authority_key: coreKeyEnv } : existsSync(coreKey) ? { core_authority_key: `~/.config/lineage/${L.keysDir}/core-authority.json` } : {}),
    poll_ms: Number((process.env.UNITS_SITE_POLL_MS ?? process.env.LINEAGE_SITE_POLL_MS) ?? 20000),
  },
});
writeFileSync(join(OUT, "network.json"), JSON.stringify(net, null, 2) + "\n", { mode: 0o600 });
chmodSync(join(OUT, "network.json"), 0o600);
console.log(`network.json: chain mode ${L.network}, rpc ${MAIN ? "from the unit's environment" : redactRpc(net.chain.rpc_url)}, epoch ${net.epoch_length_s} s, poll ${net.chain.poll_ms} ms, ${net.chain.core_authority_key ? "Core authority key present (posts epochs and slashes)" : "no Core authority key (read only bridge)"}`);

const capsPath = join(OUT, "caps.json");
if (!existsSync(capsPath) || argv.includes("--refresh-caps")) {
  const r = doctor();
  writeFileSync(capsPath, JSON.stringify(r.capabilities, null, 2) + "\n");
  for (const n of r.notes) console.log(`doctor: ${n}`);
}
const caps = JSON.parse(readFileSync(capsPath, "utf8"));
console.log(`caps.json: ${caps.arch}, ${caps.cpus} cpus, ${caps.memory_mb} MB, ${caps.gpus.length} gpus, digest ${H("caps", canonicalJson(caps)).slice(0, 16)}...`);

writeFileSync(join(OUT, "runtime-authority.pub"), devnet.runtime_authority + "\n");
const runtimeCfg: Record<string, any> = {
  mode: L.network,
  core: `http://127.0.0.1:${L.ports.core}`,
  state_dir: `${L.state}/runtime`,
  runtime_key: join(HOME_CFG, L.keysDir, "runtime-authority.json"),
  // no rpc_url: the runtime resolves it like Core (UNITS_DEVNET_RPC, the keyed rpc.env, else public devnet)
  _note:
    "Written by scripts/deploy/site-config.ts on every install and activate. Owner decisions 2026-10-09 and 2026-10-10: each hosted agent's model spend is paid by its own compute vault with no platform cap (attempt_max_usd per attempt, reserved from the vault first); the 10 USD per UTC day global cap (global_max_usd per global_window_s) counts only subsidized spend, the usage the vaults could not pay (global_cap_scope subsidized; set all to cap every USD again). Prices are TEST values.",
  // agent productivity lane 2026-10-12 (docs/plans/AGENT-EFFICIENCY.md section 5): 1.00 USD per attempt, was 0.50.
  // Measured on this site over 24 h at 0.50 (0.42 for the loop after the journal reserve): 259 attempts
  // with model calls, 0 candidates; a session reached its first evaluation result at 0.28 USD (median,
  // 0.31 at the 75th percentile), which left one more turn; 150 of 263 sessions ended before any edit.
  // The minimum useful attempt (0.4438 USD by default) stays: it is what one read-edit-evaluate-submit
  // cycle was measured to cost, now under half of the cap instead of 89% of it.
  attempt_max_usd: 1.0,
  // agent efficiency (docs/plans/AGENT-EFFICIENCY.md, measured 2026-10-10): effort medium (the model
  // stays the soul's; Opus 5.5's own default level) with bounded calls (each call's max_tokens fits
  // what is left of the attempt cap, so a long thinking turn no longer ends the attempt), and
  // stacked authoring on the agent's own pending candidate (stale conflicts were 8 of 26 candidates),
  // and a cache keep-alive while a self-evaluation runs past 4 minutes (they took up to 6 with five
  // agents at once, and the next turn wrote the whole prefix again)
  effort: "medium",
  // pace: the model is told its budget and what is left after every tool result, is nudged to edit and
  // evaluate at half, and the submit call is reserved (the one accepted self-evaluation of the day was
  // lost to the cap); spread: agents on one unit are pointed at different metric targets and file
  // advisory intents (agent productivity lane, section 5)
  // journal_reserve_usd 0.04 (recipes headroom lane 2026-10-12; was the 0.08 default): the journal call cost
  // 0.0099 USD at the median and 0.0175 at most in 370 calls on this site (28 h to 2026-10-12T07Z), and its
  // input estimate is now 2 characters per token instead of 1, so 0.04 holds an entry for the largest
  // prompt the facts log can make; the loop gets 0.96 of the 1.00 cap instead of 0.92.
  // spread_intent_ttl_s 1800 (Core's maximum; was 600): in the two hours after the heavy units went live a verdict
  // took 16 to 81 minutes, so a 10 minute intent was gone long before the candidate behind it was final and three
  // agents filed candidates on save_load_ir of one unit
  efficiency: { cap_mode: "bounded", series: true, keep_alive_s: 240, pace: true, spread: true, journal_reserve_usd: 0.04, spread_intent_ttl_s: 1800 },
  agent_epoch_max_usd: null,
  // owner decision 2026-10-10 (evening): devnet money is free, so on devnet a platform cap covers every
  // USD again (scope all), 100 USD per UTC day (owner 2026-10-11, was 30); the self-funding logic stays as built for mainnet
  global_max_usd: 100,
  global_cap_scope: "all",
  global_window_s: 86400,
  compute_price_line_per_usd: "20",
  compute_price_line_per_sandbox_s: "0.002",
  // owner direction 2026-10-10 ("the live stuff always"): one slot per funded agent up to the ceiling the
  // 4 vCPU / 8 GB server was measured to carry (docs/plans/MODELS-AND-SELF-FUNDING.md, "Live always"),
  // and 30 s between a funded agent's attempts; only infrastructure failures back off (to 15 min)
  max_concurrent: 1,
  // owner decision 2026-10-10: 3 at once (5 saturated the 4 vCPU box, 96 to 100% CPU); raise with desktop/sandbox hosts.
  // 2 while a second instance (the mainnet test) is installed on this server (2026-10-12: load average 16 to 28
  // on 4 vCPUs with both; each attempt holds a live desktop, about a quarter of a CPU, for its whole length).
  // UNITS_SITE_MAX_CONCURRENT overrides.
  max_concurrent_ceiling: Number(process.env.UNITS_SITE_MAX_CONCURRENT ?? (!MAIN && existsSync(instanceLayout("mainnet").state) ? 2 : 3)),
  attempt_gap_s: 30,
  // agents do not trade (owner decision 2026-10-12): there is no trading block; the runtime's firewall refuses every swap
  // hosted launches bind from the Wallet page (packages/runtime/src/bind.ts); the gate forwards /runtime/bind/* here
  bind_port: L.ports.bind,
  // agent desktops (SPEC 17.7, owner decisions 2026-10-10): every working agent has its own live desktop
  // (desktop_required: an attempt waits, short retry, until one is free). Desktop hosts first (the
  // hosts file that scripts/deploy/desktop-host/provision.sh fills; none until the owner creates one),
  // then 2 on this server (4 vCPU, 8 GB), then E2B overflow: at most 6 at once (6 hosted agents bound
  // on 2026-10-10), on the lineage-desktop template (2 vCPU, 4 GiB: 0.000046 USD/s, 0.1656 USD per
  // desktop-hour at e2b.dev/pricing read 2026-10-10; the stock desktop template measured 8 vCPU, 8 GiB),
  // within 16 USD of E2B time per UTC day (4 desktops all day: 4 x 24 x 0.1656 = 15.90; separate from
  // the model cap). The stream is served on bind_port at /desktops/*, which the gate forwards.
  desktops_max: 2,
  e2b_max: 6,
  desktop_usd_per_day: 16,
  desktop_allow: ["github.com", "githubusercontent.com", "githubassets.com"],
  e2b: { template: "lineage-desktop", vcpu: 2, ram_gib: 4, session_max_s: 3600 },
  desktop_required: true,
  desktop_hosts_file: "/home/units/.config/lineage/desktop-hosts/hosts.json",
  // one E2B day budget for every instance on this server (packages/runtime desktops.ts): this one
  // publishes its spend there and counts a second instance's; with no second instance (no directory,
  // no peer file) nothing changes
  desktop_shared: { dir: SHARED_E2B_DIR, name: "devnet", peers: ["mainnet"] },
  // owner direction 2026-10-10: live only. Desktops stream (sealed and redacted as before) but do not
  // record or publish a recording; the site shows only live work. true turns recordings back on.
  recordings: false,
};
if (MAIN) {
  // The mainnet test instance's safety values (owner decisions 2026-10-11, docs/DEPLOY-SITE.md "Second
  // instance (mainnet test)"). Every one is configuration in this file's output, none is in a program.
  Object.assign(runtimeCfg, {
    _note:
      "Written by scripts/deploy/site-config.ts for the mainnet test instance on every install and activate. Owner decisions 2026-10-11: at most 20 USD of model spend per UTC day counting every dollar (vault-paid included: global_cap_scope all), at most 2 attempts at once, a live desktop required for every attempt, E2B desktops only, inside the one E2B day budget shared with the devnet site (desktop_shared, strict), no agent trading (removed 2026-10-12). The quote token is a throwaway stand-in, so its rate is the configured TEST rate (price.source config), the same figures Core publishes (config/network.json prepay with the state file's network_overrides).",
    global_max_usd: 20,
    global_cap_scope: "all",
    global_window_s: 86400,
    max_concurrent: 1,
    max_concurrent_ceiling: 2,
    attempt_max_usd: net.prepay.attempt_max_usd,
    compute_price_line_per_usd: net.prepay.compute_price_line_per_usd,
    compute_price_line_per_sandbox_s: net.prepay.compute_price_line_per_sandbox_s,
    price: { source: "config" },
    // this server's two local desktop slots stay with the devnet site; the test instance's desktops are
    // E2B, at most one per attempt slot
    desktops_max: 0,
    e2b_max: 2,
    desktop_required: true,
    desktop_hosts_file: undefined,
    desktop_shared: { dir: SHARED_E2B_DIR, name: "mainnet", peers: ["devnet"], strict: true },
  });
}
const runtimePath = join(OUT, "runtime.json");
const runtimeText = JSON.stringify(runtimeCfg, null, 2) + "\n";
const prevRuntime = existsSync(runtimePath) ? readFileSync(runtimePath, "utf8") : null;
if (prevRuntime !== null && prevRuntime !== runtimeText) writeFileSync(`${runtimePath}.prev`, prevRuntime, { mode: 0o600 });
writeFileSync(runtimePath, runtimeText, { mode: 0o600 });
chmodSync(runtimePath, 0o600);
console.log(
  `runtime.json: global cap ${runtimeCfg.global_max_usd} USD per ${runtimeCfg.global_window_s} s (UTC day, ${runtimeCfg.global_cap_scope} spend), attempt ${runtimeCfg.attempt_max_usd}, agent epoch ${runtimeCfg.agent_epoch_max_usd ?? "no cap"}, desktops: hosts from ${runtimeCfg.desktop_hosts_file}, ${runtimeCfg.desktops_max} here, ${runtimeCfg.e2b_max} E2B (${runtimeCfg.e2b.template}, ${runtimeCfg.desktop_usd_per_day} USD per UTC day), ${runtimeCfg.desktop_required ? "required" : "optional"}, recordings ${runtimeCfg.recordings ? "on" : "off"}${prevRuntime !== null && prevRuntime !== runtimeText ? " (changed; previous kept as runtime.json.prev)" : ""}; ${existsSync(runtimeCfg.runtime_key) ? "runtime authority key present" : "no runtime authority key (lineage-runtime stays disabled)"}${runtimeCfg.desktop_shared ? `; E2B budget shared as ${runtimeCfg.desktop_shared.name} with ${runtimeCfg.desktop_shared.peers.join(", ")}${runtimeCfg.desktop_shared.strict ? " (strict)" : ""}` : ""}; at most ${runtimeCfg.max_concurrent_ceiling} attempts at once; agents do not trade`,
);
