import "../../protocol/src/env-alias.ts"; // first: UNITS_* and LINEAGE_* env names both readable (docs/plans/REBRAND-UNITS.md 3.3)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { systemClock } from "./clock.ts";
import { loadNetworkConfig } from "./config.ts";
import { ChainReader, Rpc, rpcSlotSource } from "@units/chain";
import { redactRpc } from "../../chain/src/endpoint.ts";
import { applyNetworkProfile, rpcUrlFor } from "../../chain/src/profile-node.ts";
import { ChainBridge, chainBootstrap, loadChainSettings } from "./chain.ts";
import { erc8004Of } from "./erc8004.ts";
import { Core } from "./core.ts";
import { canaryDirIsPublic, loadCanaryDir } from "./hardening.ts";
import { serve } from "./http.ts";
import { GitTreeSource } from "./trees.ts";
import { revenueOf } from "./revenue.ts";
import { identityOfferOf, SAMPLE_MS as OFFER_SAMPLE_MS } from "./identity-offer.ts";
import { viewersOf } from "./viewers.ts";
import { base58Decode, keyFromSolanaJson } from "./protocol.ts";
import { agentWalletOf } from "./agent-wallet.ts";

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
// a second instance on one server (scripts/deploy/instance.ts) names its own block: UNITS_PORT_BLOCK=9760-9769
const [blockLo, blockHi] = /^\d+-\d+$/.test(process.env.UNITS_PORT_BLOCK ?? "") ? process.env.UNITS_PORT_BLOCK!.split("-").map(Number) as [number, number] : [9660, 9669];
if (port < blockLo || port > blockHi) {
  console.error(`port must be in this repo's block ${blockLo}-${blockHi}`);
  process.exit(2);
}
const busy = portBusy(port);
if (busy) {
  console.error(`port ${port} is already in use by pid ${busy.replace(/\n/g, ", ")}; not binding`);
  process.exit(1);
}

// network profile (SPEC 14.10): devnet unless config/profile.json or UNITS_NETWORK says mainnet;
// on mainnet every send prices compute units from recent fees (capped by config)
const profile = applyNetworkProfile();
const chainSettings = loadChainSettings(arg("chain") ?? configPath);
if (chainSettings) {
  if (chainSettings.mode !== profile.network) {
    console.error(`chain.mode ${chainSettings.mode} differs from the network profile ${profile.network} (config/profile.json, UNITS_NETWORK); refusing to start`);
    process.exit(2);
  }
  // mainnet: the keyed endpoint from env, never from a config file
  if (profile.network === "mainnet") chainSettings.rpc_url = rpcUrlFor(profile);
}
let network = loadNetworkConfig(configPath);
let firstEpoch = 0;
let reader: ChainReader | null = null;
if (chainSettings) {
  reader = new ChainReader(Rpc.http(chainSettings.rpc_url), chainSettings.registry_program, chainSettings.launch_program);
  const boot = await chainBootstrap(network, reader);
  if (profile.network === "mainnet") {
    const g = await reader.rpc.call<string>("getGenesisHash");
    if (g !== profile.genesis) {
      console.error(`RPC genesis ${g} is not the mainnet profile's; refusing to start`);
      process.exit(2);
    }
  }
  network = boot.network;
  firstEpoch = boot.firstEpoch;
  // --first-epoch N: this Core's epochs start at N, not at the registry's next one. For a proof run beside a live deployment on
  // the same registry (scripts/devnet/open-bounty-e2e.ts): its epochs never take the deployment's numbers, and the bridge cannot
  // post them (post_epoch takes only last + 1), so they reach the chain only by an admin's own transaction.
  if (arg("first-epoch")) {
    const n = Number(arg("first-epoch"));
    if (!Number.isSafeInteger(n) || n < boot.firstEpoch) {
      console.error(`--first-epoch must be an integer of at least the registry's next epoch ${boot.firstEpoch}`);
      process.exit(2);
    }
    firstEpoch = n;
  }
  console.log(`chain mode ${chainSettings.mode}: ${redactRpc(chainSettings.rpc_url)}, registry ${chainSettings.registry_program}, mint ${boot.registry.mint} (${boot.decimals} decimals), first epoch ${firstEpoch}`);
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
  // M2 slot-hash beacon in chain mode (SPEC 10.3, src/beacon.ts)
  ...(chainSettings ? { slotBeacon: { lagSlots: chainSettings.beacon_lag_slots } } : {}),
});
if (chainSettings) erc8004Of(core).configure({ registryProgram: chainSettings.registry_program }); // ERC-8004 file names the configured registry
// pools and GitHub fee claims (docs/plans/AGENT-POOLS.md, GITHUB-FEE-CLAIMS.md): chain reads always, the two service keys only
// when their files are named (UNITS_POOL_KEEPER_KEY, UNITS_FEE_CLAIMS_ATTESTOR_KEY); nothing runs while the feature flags are off
if (chainSettings && reader) await (await import("./pools-wiring.ts")).wirePoolsAndClaims(core, reader, chainSettings, profile.network);
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

// agent wallets (docs/plans/AGENT-WALLET-SAFETY.md 2): balances are read from chain with Core's own reader
if (chainSettings) agentWalletOf(core).configure({ reader: reader!, network: profile.network, quoteSymbol: profile.quote.symbol ?? null });
const bridge = chainSettings ? new ChainBridge(core, chainSettings, { reader: reader!, log: (m) => console.log(`[chain] ${m}`) }) : null;
if (bridge) await bridge.tick().catch(() => undefined);
const chainTimer = bridge ? setInterval(() => void bridge.tick().catch(() => undefined), chainSettings!.poll_ms ?? 5000) : null;
// resolves slot beacon requests: anchors them at the tip, reads the target's finalized block hash; RPC failures back off
const slotSource = chainSettings && core.slotBeacon ? rpcSlotSource(reader!.rpc) : null;
let beaconErr = "";
const beaconTimer = slotSource
  ? setInterval(() => {
      void core.slotBeacon!.resolve(slotSource).then((r) => {
        if (r.error && r.error !== beaconErr) console.error(`[beacon] slot read failed, backing off: ${r.error}`);
        beaconErr = r.error ?? "";
      });
    }, 1000)
  : null;
if (core.slotBeacon) console.log(`assignment beacon: Solana slot hash, lag ${core.slotBeacon.lagSlots} slots`);
const server = serve(core, { port, hostname: host });
// live stream viewers (viewers.ts): the gate's counts, sampled once a minute when the site names its gate
const gateUrl = process.env.UNITS_GATE_URL?.trim() || null;
let viewerErr = "";
const viewerTimer = gateUrl
  ? setInterval(() => {
      void viewersOf(core).sample(gateUrl).then((r) => {
        const err = "error" in r ? String(r.error) : "";
        if (err && err !== viewerErr) console.error(`[viewers] gate read failed: ${err}`);
        viewerErr = err;
      });
    }, 60_000)
  : null;
if (gateUrl) console.log(`viewer counts: sampling ${gateUrl}/gate/viewers every minute`);
// protocol revenue records (revenue.ts): Core keeps a copy of the indexer's fee cranks and the identity
// service's units account payments, read once a minute over loopback
const revenueUrls = { indexer: process.env.UNITS_INDEXER_URL?.trim() || null, identity: process.env.UNITS_IDENTITY_URL?.trim() || null };
const revenueErr: Record<string, string> = {};
const sampleRevenue = () =>
  void revenueOf(core)
    .sample(revenueUrls)
    .then((r) => {
      for (const [k, v] of Object.entries(r as Record<string, { ok: boolean; error?: string }>)) {
        const err = v.ok ? "" : String(v.error ?? "failed");
        if (err && err !== revenueErr[k]) console.error(`[revenue] ${k} read failed: ${err}`);
        revenueErr[k] = err;
      }
    })
    .catch((e) => console.error("[revenue] sample failed", e));
const revenueTimer = revenueUrls.indexer || revenueUrls.identity ? setInterval(sampleRevenue, 60_000) : null;
if (revenueTimer) {
  console.log(`protocol revenue records: reading ${[revenueUrls.indexer && `${revenueUrls.indexer}/market/flows`, revenueUrls.identity && `${revenueUrls.identity}/identity/payments`].filter(Boolean).join(" and ")} every minute`);
  setTimeout(sampleRevenue, 5_000);
}
// "A units account" is offered only while the identity service has a free account (identity-offer.ts)
const identityOffer = identityOfferOf(core);
identityOffer.url = revenueUrls.identity;
let offerErr = "";
const sampleOffer = () =>
  void identityOffer.sample().then((r) => {
    const err = r.ok ? "" : String(r.error ?? "failed");
    if (err !== offerErr) console.error(err ? `[identity offer] pool read failed: ${err}; A units account is not offered` : `[identity offer] pool read again: ${JSON.stringify(identityOffer.status().pool)}`);
    offerErr = err;
  });
const offerTimer = identityOffer.url ? setInterval(sampleOffer, OFFER_SAMPLE_MS) : null;
if (offerTimer) {
  console.log(`units account offer: reading ${identityOffer.url}/identity/pool every ${OFFER_SAMPLE_MS / 1000} s`);
  sampleOffer();
}
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
  if (beaconTimer) clearInterval(beaconTimer);
  if (viewerTimer) clearInterval(viewerTimer);
  if (revenueTimer) clearInterval(revenueTimer);
  if (offerTimer) clearInterval(offerTimer);
  server.stop(true);
  core.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
