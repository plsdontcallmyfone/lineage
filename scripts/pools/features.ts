#!/usr/bin/env bun
// The onchain switch of agent pools and GitHub fee routes: LaunchConfig.features of units_launch
// (bit 0 pools, bit 1 GitHub fees; docs/plans/AGENT-POOLS.md 2, GITHUB-FEE-CLAIMS.md 2), and the two
// config accounts the features read (PoolConfig, ClaimConfig). The launch admin signs.
//
//   bun scripts/pools/features.ts                              devnet: prints the state, sends nothing
//   bun scripts/pools/features.ts --set pools,github --send    devnet: set_features(3), signed by the devnet deployer
//   bun scripts/pools/features.ts --set none --send            devnet: set_features(0)
//
//   UNITS_NETWORK=mainnet bun scripts/pools/features.ts --mainnet-test --key <admin keypair>
//                                                              the mainnet TEST deployment: state only
//   ... --configs <file.json> --set pools,github               the plan: what would be sent; NOT sent
//   ... --configs <file.json> --set pools,github --send        sends (owner decision; never run by an agent)
//
// --configs names a JSON file { "claim": ClaimConfigArgs, "pool": PoolConfigArgs } (packages/chain
// src/claims.ts, src/pools.ts; amounts as decimal strings in base units): set_claim_config and
// set_pool_config go in the same transaction, before set_features. Without --send nothing is sent on
// any network. The key is passed explicitly and never printed; `solana config` is not read.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const has = (n: string) => argv.includes(n);
const MAIN = has("--mainnet-test");
if (MAIN && process.env.UNITS_NETWORK !== "mainnet") throw new Error("--mainnet-test needs UNITS_NETWORK=mainnet");
if (!MAIN) await import("../../packages/chain/src/devnet-process.ts"); // pins this process to devnet, refuses another network

const { claimPdas, claims, decodeClaimConfig, decodeLaunchConfig, decodePoolConfig, FEATURES, launchPdas, loadKeypair, poolPdas, pools, Rpc, sendAndConfirm, LAUNCH_PROGRAM_ID } = await import("@units/chain");
type Ix = import("@units/chain").Ix;

let rpc: InstanceType<typeof Rpc>;
let keyPath: string;
if (MAIN) {
  const { useTestProfile } = await import("../mainnet/test-steps.ts");
  const { rpcUrlFor } = await import("../../packages/chain/src/profile-node.ts");
  rpc = Rpc.http(rpcUrlFor(useTestProfile()), "confirmed");
  keyPath = flag("--key") ?? join(homedir(), ".config", "units", "mainnet", "deployer.json");
} else {
  const lib = await import("../devnet/lib.ts");
  const { assertDevnet } = await import("../../packages/chain/src/browser/client.ts");
  rpc = lib.rpc;
  await assertDevnet(rpc);
  keyPath = flag("--key") ?? lib.DEPLOYER_PATH;
}
const say = (m: string) => console.log(`[features] ${m}`);
const j = (o: unknown) => JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v));
const names = (f: number) => [f & FEATURES.pools ? "pools" : "", f & FEATURES.githubFees ? "github" : ""].filter(Boolean).join(",") || "none";

async function state() {
  const [lcA, pcA, ccA] = await rpc.getMultipleAccounts([launchPdas.config(), poolPdas.config(), claimPdas.config()]);
  if (!lcA) throw new Error(`no LaunchConfig for ${LAUNCH_PROGRAM_ID} on this network`);
  const lc = decodeLaunchConfig(lcA.data);
  // a build from before pools and claims has no `features` byte to read as such: the reserved bytes are zero, so it reads 0
  say(`${MAIN ? "mainnet TEST" : "devnet"} units_launch ${LAUNCH_PROGRAM_ID}: admin ${lc.admin}, features ${lc.features} (${names(lc.features)})`);
  say(`PoolConfig: ${pcA ? j(decodePoolConfig(pcA.data)) : "none"}`);
  say(`ClaimConfig: ${ccA ? j(decodeClaimConfig(ccA.data)) : "none"}`);
  return { lc, hasPool: !!pcA, hasClaim: !!ccA };
}

const before = await state();
const set = flag("--set");
const cfgFile = flag("--configs");
if (set === undefined && !cfgFile) process.exit(0);

let want: number | null = null;
if (set !== undefined) {
  want = 0;
  for (const n of set.split(",").map((s) => s.trim()).filter((s) => s && s !== "none")) {
    if (n === "pools") want |= FEATURES.pools;
    else if (n === "github") want |= FEATURES.githubFees;
    else throw new Error(`--set takes pools, github or none, not ${n}`);
  }
}
if (!existsSync(keyPath)) throw new Error(`no admin keypair at ${keyPath.replace(homedir(), "~")}`);
const admin = loadKeypair(keyPath);
if (admin.id !== before.lc.admin) throw new Error(`the key at ${keyPath.replace(homedir(), "~")} is ${admin.id}, not the launch admin ${before.lc.admin}`);

const ixs: Ix[] = [];
if (cfgFile) {
  const c = JSON.parse(readFileSync(cfgFile, "utf8")) as { claim?: Record<string, unknown>; pool?: Record<string, unknown> };
  if (c.claim) ixs.push(claims.setClaimConfig({ admin: admin.id, args: c.claim as never }));
  if (c.pool) ixs.push(pools.setPoolConfig({ admin: admin.id, args: { ...c.pool, crossHoldQuote: BigInt(String(c.pool.crossHoldQuote)), maxBuyQuote: BigInt(String(c.pool.maxBuyQuote)) } as never }));
  say(`configs from ${cfgFile}: ${[c.claim ? "set_claim_config" : "", c.pool ? "set_pool_config" : ""].filter(Boolean).join(", ")}`);
}
if (want !== null) {
  if ((want & FEATURES.pools) && !before.hasPool && !cfgFile) throw new Error("pools need a PoolConfig first: pass --configs");
  if ((want & FEATURES.githubFees) && !before.hasClaim && !cfgFile) throw new Error("GitHub fees need a ClaimConfig first: pass --configs");
  if (want !== before.lc.features) ixs.push(claims.setFeatures({ admin: admin.id, features: want }));
  else say(`features are already ${want} (${names(want)})`);
}
if (!ixs.length) process.exit(0);
if (!has("--send")) {
  say(`PLAN, nothing sent: ${ixs.length} instruction${ixs.length === 1 ? "" : "s"} signed by ${admin.id}${want !== null ? `, features ${before.lc.features} to ${want} (${names(want)})` : ""}. Add --send to send.`);
  process.exit(0);
}
const price = flag("--priority-micro-lamports") ? Number(flag("--priority-micro-lamports")) : undefined;
const r = await sendAndConfirm(rpc, admin, ixs, { computeUnits: 200_000, ...(price !== undefined ? { priorityMicroLamports: price } : {}) });
say(`sent: ${r.signature} (fee ${r.fee})`);
await state();
