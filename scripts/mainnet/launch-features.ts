#!/usr/bin/env bun
// Opens agent pools and GitHub fee claims on the OFFICIAL launch program, after its upgrade to the build
// that carries them (docs/MAINNET-RUNBOOK.md "Launch program upgrade: pools and claims"). The launch
// admin signs. Three commands, each a dry run unless --send is given:
//
//   status      what the chain holds: the deployed build's sha256, LaunchConfig.features, PoolConfig, ClaimConfig
//   configs     set_claim_config and set_pool_config in ONE transaction (creates both accounts the first time,
//               the admin pays their rent; later runs update them). Changes no behaviour while the bits are 0
//   features    set_features with the bits named in the params file ("pools", "github"), or --set none|pools|github|pools,github
//
//   bun scripts/mainnet/launch-features.ts status --mainnet
//   bun scripts/mainnet/launch-features.ts configs --mainnet --key <admin keypair> [--send]
//   bun scripts/mainnet/launch-features.ts features --mainnet --key <admin keypair> [--set none] [--send]
//
// Options: --params <file> (default scripts/mainnet/launch-features-params.json), --rpc <url> (default the local
// fork 127.0.0.1:9690; with --mainnet the keyed endpoint of the mainnet profile, never printed), --mainnet
// (required on a mainnet endpoint, refused on any other), --priority-micro-lamports <n>, --unconfirmed-ok (a
// fork only: send while owner_confirmed is false). Refuses to send when: the endpoint is mainnet without
// --mainnet; the key is not LaunchConfig.admin; the deployed program is not the pools build
// (onchain/target/pools-mainnet/units_launch.so); owner_confirmed is false; the attestor or the keeper is
// missing; a bit is asked for whose config account does not exist. The key is passed explicitly, never
// printed; `solana config` is not read.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  claimPdas, claims, decodeClaimConfig, decodeLaunchConfig, decodeLoaderAuthority, decodePoolConfig, FEATURES, launchPdas, loadKeypair, poolPdas, pools, programDataAddress, Rpc, sendAndConfirm,
  type ClaimConfigArgs, type Ix, type PoolConfigArgs,
} from "@units/chain";
import { rpcUrlFor } from "../../packages/chain/src/profile-node.ts";
import { programIdsNow, useActiveProfile } from "./steps.ts";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const has = (n: string) => argv.includes(n);
const say = (m: string) => console.log(`[launch-features] ${m}`);
const j = (o: unknown) => JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v));
if (!cmd || !["status", "configs", "features"].includes(cmd)) throw new Error("usage: launch-features.ts status|configs|features [--mainnet] [--key <admin keypair>] [--send]");

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const FORK = "http://127.0.0.1:9690";
const profile = useActiveProfile({ ...process.env, UNITS_NETWORK: "mainnet" });
const IDS = programIdsNow();
const rpcUrl = flag("--rpc") ?? (has("--mainnet") ? rpcUrlFor(profile) : FORK);
const rpc = Rpc.http(rpcUrl, "confirmed");
const isMainnet = (await rpc.call<string>("getGenesisHash")) === MAINNET_GENESIS;
if (isMainnet && !has("--mainnet")) throw new Error("mainnet endpoint: pass --mainnet to confirm");
if (!isMainnet && has("--mainnet")) throw new Error("--mainnet was passed but the endpoint is not mainnet");
const SEND = has("--send");
const BUILD = join(import.meta.dir, "..", "..", "onchain", "target", "pools-mainnet", "units_launch.so");
const names = (f: number) => [f & FEATURES.pools ? "pools" : "", f & FEATURES.githubFees ? "github" : ""].filter(Boolean).join(",") || "none";
const bitsOf = (list: string[]) => {
  let f = 0;
  for (const n of list.map((s) => s.trim()).filter((s) => s && s !== "none")) {
    if (n === "pools") f |= FEATURES.pools;
    else if (n === "github") f |= FEATURES.githubFees;
    else throw new Error(`a feature is pools or github, not ${n}`);
  }
  return f;
};

async function state() {
  const [lcA, pcA, ccA, pdA] = await rpc.getMultipleAccounts([launchPdas.config(), poolPdas.config(), claimPdas.config(), programDataAddress(IDS.launch)]);
  if (!lcA || !pdA) throw new Error(`units_launch ${IDS.launch} is not deployed and initialized on this endpoint`);
  const lc = decodeLaunchConfig(lcA.data);
  // the deployed code: ProgramData after its 45-byte header, compared over the build's own length (the rest is zero padding)
  const build = existsSync(BUILD) ? new Uint8Array(readFileSync(BUILD)) : null;
  const code = pdA.data.subarray(45);
  const isBuild = !!build && code.length >= build.length && Buffer.compare(code.subarray(0, build.length), build) === 0 && code.subarray(build.length).every((b) => b === 0);
  const sha = createHash("sha256").update(build && isBuild ? code.subarray(0, build.length) : code).digest("hex");
  return { lc, pool: pcA ? decodePoolConfig(pcA.data) : null, claim: ccA ? decodeClaimConfig(ccA.data) : null, isBuild, sha, programBytes: code.length, upgradeAuthority: decodeLoaderAuthority(pdA.data) };
}
function print(s: Awaited<ReturnType<typeof state>>) {
  say(`${isMainnet ? "mainnet" : "fork"} units_launch ${IDS.launch}: ${s.isBuild ? "the pools and claims build" : "NOT the pools and claims build"} (sha256 ${s.sha}, ${s.programBytes} bytes of program space), upgrade authority ${s.upgradeAuthority}`);
  say(`LaunchConfig: admin ${s.lc.admin}, features ${s.lc.features} (${names(s.lc.features)}), paused ${s.lc.paused}`);
  say(`ClaimConfig: ${s.claim ? j(s.claim) : "none"}`);
  say(`PoolConfig: ${s.pool ? j(s.pool) : "none"}`);
}

const before = await state();
print(before);
if (cmd === "status") process.exit(0);

const paramsFile = flag("--params") ?? join(import.meta.dir, "launch-features-params.json");
const P = JSON.parse(readFileSync(paramsFile, "utf8")) as { owner_confirmed: boolean; claim: Record<string, unknown>; pool: Record<string, unknown>; features: string[] };
const confirmed = P.owner_confirmed === true || (!isMainnet && has("--unconfirmed-ok"));
const keyPath = flag("--key");
const admin = keyPath ? loadKeypair(keyPath) : null;
const who = admin?.id ?? before.lc.admin;
const problems: string[] = [];
if (!before.isBuild) problems.push("the deployed program is not the pools and claims build: upgrade first");
if (!confirmed) problems.push(`${paramsFile.replace(homedir(), "~")}: owner_confirmed is false`);
if (admin && admin.id !== before.lc.admin) problems.push(`the key given is ${admin.id}, not the launch admin ${before.lc.admin}`);

const ixs: Ix[] = [];
let want: number | null = null;
if (cmd === "configs") {
  if (typeof P.claim.attestor !== "string") problems.push("claim.attestor is not set (the public key of the attestor key generated on the server)");
  if (typeof P.pool.keeper !== "string") problems.push("pool.keeper is not set (the public key of the pool keeper key generated on the server)");
  const c = P.claim as unknown as ClaimConfigArgs;
  const p = { ...P.pool, crossHoldQuote: BigInt(String(P.pool.crossHoldQuote)), maxBuyQuote: BigInt(String(P.pool.maxBuyQuote)) } as unknown as PoolConfigArgs;
  if (c.minBps > c.maxBps || c.maxBps > 5000) problems.push("claim: min_bps above max_bps, or max_bps above the program's 5,000");
  if (p.payoutBps + p.buybackBps + p.burnBps !== 10_000) problems.push("pool: payout, buyback and burn must sum to 10,000");
  if (p.poolFeeBps > 5000 || p.maxMembers < 2 || p.maxMembers > 16) problems.push("pool: pool_fee_bps above 5,000, or max_members outside 2 to 16");
  if (typeof P.claim.attestor === "string" && typeof P.pool.keeper === "string") ixs.push(claims.setClaimConfig({ admin: who, args: c }), pools.setPoolConfig({ admin: who, args: p }));
  say(`configs: set_claim_config ${j(P.claim)}`);
  say(`configs: set_pool_config ${j(P.pool)}`);
} else {
  want = bitsOf(flag("--set") !== undefined ? flag("--set")!.split(",") : P.features);
  if ((want & FEATURES.pools) && !before.pool) problems.push("pools need a PoolConfig first: run configs");
  if ((want & FEATURES.githubFees) && !before.claim) problems.push("GitHub fees need a ClaimConfig first: run configs");
  if (want === before.lc.features) { say(`features are already ${want} (${names(want)}): nothing to send`); process.exit(0); }
  ixs.push(claims.setFeatures({ admin: who, features: want }));
  say(`features: ${before.lc.features} (${names(before.lc.features)}) to ${want} (${names(want)})`);
}
for (const p of problems) say(`REFUSED ${p}`);
if (!SEND) {
  say(`${problems.length ? "NOT READY" : "PLAN"}, nothing sent: ${ixs.length} instruction${ixs.length === 1 ? "" : "s"} in one transaction signed by ${who}. Add --send to send.`);
  process.exit(problems.length ? 1 : 0);
}
if (problems.length) process.exit(1);
if (!admin) throw new Error("--send needs --key <admin keypair>");
const price = flag("--priority-micro-lamports") ? Number(flag("--priority-micro-lamports")) : undefined;
const bal0 = await rpc.getBalance(admin.id);
const r = await sendAndConfirm(rpc, admin, ixs, { computeUnits: 200_000, ...(price !== undefined ? { priorityMicroLamports: price } : {}) });
say(`sent: ${r.signature} (fee ${r.fee} lamports, the admin's balance fell by ${bal0 - (await rpc.getBalance(admin.id))} lamports)`);
print(await state());
