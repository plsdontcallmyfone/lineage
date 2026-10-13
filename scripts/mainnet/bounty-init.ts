#!/usr/bin/env bun
// units_bounty: the plan and the one initialize transaction (docs/MAINNET-RUNBOOK.md "Bounty escrow
// program"). Keys are passed as files; nothing reads `solana config`; no key or keyed URL is printed.
//
//   bun scripts/mainnet/bounty-init.ts plan [--params scripts/mainnet/bounty-params.json] [--so onchain/target/bounty-mainnet/units_bounty.so] [--rpc <url>]
//   bun scripts/mainnet/bounty-init.ts send --payer <upgrade authority key file> [--params ...] [--priority-micro-lamports N] [--rpc <url>] [--mainnet]
//
// `plan` sends nothing and needs no key: it prints the program id of the active profile, whether the
// program is deployed and initialized, the build's size and the rent of every account at the
// cluster's own rate (getMinimumBalanceForRentExemption), and the initialize instruction's accounts.
// `send` signs initialize with the program's upgrade authority (the program checks it through
// ProgramData), then reads the Config back. Program ids follow the active profile: UNITS_NETWORK=mainnet
// for mainnet, UNITS_NETWORK=devnet for devnet. A mainnet endpoint is refused without --mainnet.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BOUNTY_PROGRAM_ID, ChainReader, loadKeypair, openBounty, openBountyPdas, OPEN_BOUNTY_ACCOUNT_LEN, Rpc, sendAndConfirm, type OpenBountySettings } from "@units/chain";
import { applyNetworkProfile, rpcUrlFor } from "../../packages/chain/src/profile-node.ts";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const ROOT = join(import.meta.dir, "..", "..");
const profile = applyNetworkProfile();
const rpc = Rpc.http(flag("--rpc") ?? rpcUrlFor(profile), "confirmed");
const reader = new ChainReader(rpc);
const genesis = await rpc.call<string>("getGenesisHash");
const isMainnet = genesis === "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
if (isMainnet !== (profile.network === "mainnet")) throw new Error(`the endpoint's genesis ${genesis.slice(0, 8)}... is not the ${profile.network} profile's`);
const sol = (l: bigint | number) => (Number(l) / 1e9).toFixed(9);
const rent = async (bytes: number) => BigInt(await rpc.getMinimumBalanceForRentExemption(bytes));
const log = (m: string) => console.log(`[bounty-init] ${m}`);

const paramsPath = flag("--params") ?? join(ROOT, "scripts/mainnet/bounty-params.json");
const P = JSON.parse(readFileSync(paramsPath, "utf8")) as { owner_confirmed: boolean; admin: string | null;
  settings: { min_amount_units: number | null; min_ttl_s: number | null; max_ttl_s: number | null; refund_grace_s: number | null; contest_s: number | null; fee_bps: number | null; paused: boolean } };

const reg = await reader.registryConfig();
const program = await rpc.getAccountInfo(BOUNTY_PROGRAM_ID);
const programData = await rpc.getAccountInfo(openBountyPdas.programData());
const config = program ? await reader.openBountyConfig() : null;
log(`${isMainnet ? "MAINNET" : profile.network}: units_bounty ${BOUNTY_PROGRAM_ID}: ${program ? "deployed" : "NOT deployed"}${program ? (config ? ", initialized" : ", not initialized") : ""}`);
if (!reg) throw new Error("units_registry is not initialized on this cluster");
log(`registry mint ${reg.mint}, launch program ${reg.launchProgram}, registry admin ${reg.admin}`);

if (cmd === "plan" || !cmd) {
  const soPath = flag("--so") ?? join(ROOT, `onchain/target/${profile.network === "mainnet" ? "bounty-mainnet" : "bounty"}/units_bounty.so`);
  if (existsSync(soPath)) {
    const so = statSync(soPath).size;
    // upgradeable loader layouts: the program account is 36 bytes, ProgramData is a 45 byte header plus the build, a deploy buffer a 37 byte header plus the build
    const [rProgram, rData, rBuffer] = await Promise.all([rent(36), rent(45 + so), rent(37 + so)]);
    log(`build ${soPath}: ${so} bytes`);
    log(`rent at this cluster's rate: program account (36 bytes) ${sol(rProgram)} SOL; ProgramData (45 + ${so} = ${45 + so} bytes) ${sol(rData)} SOL; locked for good ${sol(rProgram + rData)} SOL`);
    log(`deploy buffer while deploying (37 + ${so} = ${37 + so} bytes) ${sol(rBuffer)} SOL, returned when the deploy lands; the deployer holds at least ${sol(rProgram + rData + rBuffer)} SOL plus fees at the peak`);
  } else log(`no build at ${soPath}: cargo build-sbf it first (onchain/README.md)`);
  const mintAcct = await rpc.getAccountInfo(reg.mint);
  // the fee vault is a token account of the registry's mint; an existing token account of that mint has its size
  const treasury = await rpc.getAccountInfo((await import("@units/chain")).registryPdas.treasury());
  const [rConfig, rVault, rBounty] = await Promise.all([rent(269), rent(treasury?.data.length ?? 165), rent(OPEN_BOUNTY_ACCOUNT_LEN)]);
  log(`initialize creates: Config (269 bytes) ${sol(rConfig)} SOL and the fee vault (${treasury?.data.length ?? 165} bytes) ${sol(rVault)} SOL; with the 5,000 lamport signature ${sol(rConfig + rVault + 5000n)} SOL`);
  log(`each bounty a wallet posts: its Bounty account (${OPEN_BOUNTY_ACCOUNT_LEN} bytes) ${sol(rBounty)} SOL kept as the record, its escrow account ${sol(rVault)} SOL returned to the funder when it closes`);
  const NOBODY = "11111111111111111111111111111111"; // stands for the signer, who is not known to a plan
  const ix = openBounty.initialize({ upgradeAuthority: NOBODY, admin: NOBODY, mint: reg.mint,
    settings: { minAmount: 0n, minTtlS: 0, maxTtlS: 1, refundGraceS: 0, contestS: 0, feeBps: 0, paused: false }, tokenProgram: mintAcct!.owner });
  log(`initialize accounts, in order: ${["config (created)", "upgrade authority (signer, pays)", "ProgramData", "registry Config", "mint", "authority PDA", "fee vault (created)", "token program", "system program"]
    .map((n, i) => (i === 1 ? n : `${n} ${ix.keys[i]!.pubkey}`)).join("; ")}`);
  log(`params ${paramsPath}: owner_confirmed ${P.owner_confirmed}, admin ${P.admin ?? "NOT NAMED"}, settings ${JSON.stringify(P.settings)}`);
  process.exit(0);
}

if (cmd !== "send") throw new Error("plan or send");
if (isMainnet && !argv.includes("--mainnet")) throw new Error("mainnet endpoint: pass --mainnet to confirm");
if (!program || !programData) throw new Error("the program is not deployed");
if (config) throw new Error("already initialized");
const s = P.settings;
if (!P.owner_confirmed || !P.admin || Object.values(s).some((v) => v === null)) throw new Error(`${paramsPath}: the owner has not confirmed every value (owner_confirmed, admin, settings)`);
const cc = await reader.challengeConfig();
if (cc && BigInt(s.refund_grace_s!) <= cc.windowS) throw new Error(`refund_grace_s ${s.refund_grace_s} is not above the registry's challenge window ${cc.windowS} s`);
const mint = await reader.mint(reg.mint);
const mintAcct = await rpc.getAccountInfo(reg.mint);
const settings: OpenBountySettings = { minAmount: BigInt(Math.round(s.min_amount_units! * 10 ** mint!.decimals)), minTtlS: s.min_ttl_s!, maxTtlS: s.max_ttl_s!, refundGraceS: s.refund_grace_s!,
  contestS: s.contest_s!, feeBps: s.fee_bps!, paused: s.paused };
const payer = loadKeypair(flag("--payer") ?? (() => { throw new Error("--payer required"); })());
const price = flag("--priority-micro-lamports") ? Number(flag("--priority-micro-lamports")) : undefined;
const before = await rpc.getBalance(payer.id);
const r = await sendAndConfirm(rpc, payer, [openBounty.initialize({ upgradeAuthority: payer.id, admin: P.admin, mint: reg.mint, settings, tokenProgram: mintAcct!.owner })],
  { computeUnits: 200_000, priorityMicroLamports: price });
const after = await reader.openBountyConfig();
log(`initialize: ${r.signature} (fee ${r.fee}); the payer spent ${sol(BigInt(before) - BigInt(await rpc.getBalance(payer.id)))} SOL`);
log(`Config: ${JSON.stringify(after, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
if (!after || after.admin !== P.admin || after.mint !== reg.mint || after.launchProgram !== reg.launchProgram) throw new Error("the Config read back does not match");
