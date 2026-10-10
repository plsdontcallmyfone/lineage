#!/usr/bin/env bun
// Lineage site: launches one TEST author agent per served recipe that has prepared candidates
// (recipes/<name>/candidates), so the site's scripted authors (lineage-author@<name>) can submit them.
// Runs LOCALLY (the devnet deployer key never leaves this machine). Idempotent: an agent already
// launched, or a compute vault already at its minimum, is skipped.
//
//   bun scripts/deploy/site-authors.ts --recipes base58-py,base58-rs,... [--plan]
//
// Chain mode only lets an agent author on lineages of the repository its launch names
// (lineage_launch::launch_agent repo_url), so each repository needs its own launched agent; a
// fixture recipe (repo "fixture:...") cannot be a launch target (the program requires https://).
// Per recipe (devnet only, refused on any other genesis):
//   - keys ~/.config/lineage/devnet/agent-<name>.json and agent-<name>-mint.json (mode 600, made here
//     on first use; minbpe keeps the existing agent-minbpe key from scripts/devnet/setup.ts);
//   - launch_agent by the devnet launcher key (TEST metadata, identity mode app, not hosted);
//   - tLINE from the deployer to the agent's compute vault up to the wake threshold plus 500 tLINE,
//     then refresh_awake, so Core sees the agent awake.
// Every transaction is appended to scripts/deploy/SITE-DEVNET.md. Public keys only are printed.
// Prints { name: agent pubkey } as JSON on the last line.
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalUrl } from "@lineage/protocol";
import { ata, ChainReader, IDENTITY_MODE, launch, launchPdas, loadKeypair, loadOrCreateKeypair, Rpc, sendAndConfirm, system, token, TOKEN_2022_PROGRAM, type Ix, type Signer } from "@lineage/chain";
import { DEVNET_GENESIS } from "../../packages/chain/src/browser/client.ts";
import { devnetRpcUrl } from "../../packages/chain/src/endpoint.ts";
import { launchTable, pumpLaunchTx } from "../devnet/pump-lib.ts";

const ROOT = join(import.meta.dir, "..", "..");
const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
const PLAN = argv.includes("--plan");
const names = (opt("recipes") ?? "").split(",").filter(Boolean);
if (!names.length) {
  console.error("usage: site-authors.ts --recipes a,b,c [--plan]");
  process.exit(2);
}
const LOGMD = join(import.meta.dir, "SITE-DEVNET.md");
const KEYS = join(homedir(), ".config", "lineage", "devnet");
const devnet = JSON.parse(readFileSync(join(ROOT, "scripts/devnet/devnet.json"), "utf8"));
const net = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
const rpc = Rpc.http(devnetRpcUrl(), "confirmed");
const reader = new ChainReader(rpc);
const T22 = TOKEN_2022_PROGRAM;
const DECIMALS = 6;
const ONE = 10n ** BigInt(DECIMALS);
const lineMint = devnet.line_mint as string;
const WANT = BigInt(net.wake_threshold) + 500n * ONE;
const log = (m: string) => console.log(`[site-authors] ${m}`);

const genesis = await rpc.call<string>("getGenesisHash", []);
if (genesis !== DEVNET_GENESIS) throw new Error(`RPC genesis ${genesis} is not devnet; refusing`);
const dep = loadKeypair(join(homedir(), ".config", "lineage", "devnet-deployer.json"));
const launcher = loadKeypair(join(KEYS, "launcher.json"));

function logTx(what: string, signature: string, fee?: number) {
  appendFileSync(LOGMD, `| ${new Date().toISOString().replace("T", " ").slice(0, 19)} | authors | ${what} | ${fee ?? "?"} | \`${signature}\` |\n`);
}
async function send(what: string, payer: Signer, ixs: Ix[], o: { signers?: Signer[]; computeUnits?: number } = {}) {
  if (PLAN) return log(`plan: ${what}`);
  const r = await sendAndConfirm(rpc, payer, ixs, { ...o, log: (m) => log(`  ${m}`) });
  logTx(what, r.signature, r.fee);
  log(`${what}: ${r.signature}`);
}
function keyFor(file: string): Signer {
  const { key, created } = loadOrCreateKeypair(join(KEYS, file));
  if (created) log(`new key ${file}: ${key.id}`);
  return key;
}

const out: Record<string, string> = {};
for (const name of names) {
  const y = readFileSync(join(ROOT, "recipes", name, "recipe.yml"), "utf8");
  const repo = /^repo:\s*"?([^"\s]+)"?/m.exec(y)?.[1] ?? "";
  if (!repo.startsWith("https://")) {
    log(`${name}: repo ${repo} is not an https URL; a launch cannot target it, skipped`);
    continue;
  }
  const url = canonicalUrl(repo);
  const agent = keyFor(`agent-${name}.json`);
  const mint = keyFor(`agent-${name}-mint.json`);
  const l = await reader.agentLaunch(mint.id);
  if (!l) {
    const bal = await rpc.getBalance(launcher.id);
    if (bal < 50_000_000n) await send(`fund launcher ${launcher.id} with 0.1 SOL`, dep, [system.transfer(dep.id, launcher.id, 100_000_000n)]);
    const sym = `T${name.replace(/[^a-z0-9]/gi, "").toUpperCase()}`.slice(0, 10);
    const r = await pumpLaunchTx(rpc, { launcher, agent, mint, lineMint, name: `TEST ${name} author`.slice(0, 32), symbol: sym,
      uri: `https://lineage.invalid/devnet/agents/${name}-test.json`, args: { repoUrl: url, identityMode: IDENTITY_MODE.app, hosted: false },
      table: await launchTable(rpc, devnet) });
    log(`pump.fun launch: TEST author agent ${agent.id} for ${name} on ${url}, mint ${mint.id}: ${r.sent.map((t) => t.signature).join(", ")}`);
  } else if (l.agent !== agent.id || l.repoUrl !== url) throw new Error(`${name}: mint ${mint.id} launched for another agent or repo`);
  else log(`${name}: launched already (${agent.id})`);
  const vault = launchPdas.computeVault(agent.id);
  const have = (await reader.tokenBalance(vault)) ?? 0n;
  if (have < WANT) {
    await send(`send ${WANT - have} tLINE base units to ${name} author's compute vault ${vault}`, dep, [
      token.transferChecked(ata(dep.id, lineMint, T22), lineMint, vault, dep.id, WANT - have, DECIMALS, T22),
    ]);
    await send(`refresh_awake for ${name} author ${agent.id}`, dep, [launch.refreshAwake({ agent: agent.id, agentMint: mint.id })]);
  } else log(`${name}: compute vault holds ${have}, ok`);
  out[name] = agent.id;
}
console.log(JSON.stringify(out));
