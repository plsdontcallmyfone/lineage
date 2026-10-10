#!/usr/bin/env bun
// M1 + M2 mainnet rehearsal on a local fork of mainnet (scripts/mainnet/fork.sh). Nothing is sent to
// mainnet and no real key signs anything: every key is a throwaway in MAINNET_FORK_KEYS and every
// lamport is a fork airdrop. Mainnet is only read (program bytes, Squads program config, rent).
//
//   0  the fork runs mainnet's exact pump.fun (Pump, PumpSwap, Pump Fees, Mayhem), Token-2022 and Squads v4 builds; our ids are still empty
//   1  deploy: write-buffer + deploy of each build at the active profile's id with its id keypair, exactly
//      as the runbook does (LINEAGE_NETWORK=mainnet: onchain/target/mainnet builds, the mainnet ids, the
//      keypairs in ~/.config/lineage/mainnet signing on this local fork only), and its cost
//   2  Squads v4: a 2-of-3 multisig with a time lock; its vault is every admin and, later, the upgrade authority
//   3  a stand-in $LINE: a pump.fun coin paired with SOL, never mayhem (create_v2), bought on its own curve
//   4  initialize registry, launch and messages with admin = the vault (mainnet-shaped values, owner values TBA)
//   5  every onchain admin action through propose, approve (2 of 3), time lock, execute (incl. set_slash_cap)
//   6  upgrade authority to the vault, then an upgrade executed by the multisig
//   7  pump.fun launches exactly as the wizard plans them (create_v2 + register_pump_launch + 1% initial buy + deposit),
//      curve trades, multi_hop_swap from SOL, the keeper crank's exact split, completion, migrate_v2 + record_pump_graduation,
//      PumpSwap trades and pool fees, then $LINE's own migration and a launch quoted in the migrated $LINE
//   8  verifier, epoch post, a challenge opened and resolved, claims after the window, slashes up to the
//      cap and one refused past it (A1-08)
// Writes scripts/mainnet/REHEARSAL-LAST.json (every transaction with its exact cost, every check).
//
//   LINEAGE_NETWORK=mainnet MAINNET_FORK_KEYS=<throwaway key dir> bun scripts/mainnet/rehearsal.ts
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { base58Decode, canonicalUrl, H, merkleProof, merkleRoot, proportionalSplit } from "@lineage/protocol";
import {
  ata,
  CHALLENGE_KIND,
  CHALLENGE_OUTCOME,
  challenge,
  ChainReader,
  addressBytes,
  claimFromCoreProof,
  computeBudget,
  decodeAgentLaunch,
  decodeBondingCurve,
  decodeLoaderAuthority,
  decodeLookupTable,
  decodePumpEvent,
  decodePumpFeeConfig,
  decodePumpGlobal,
  decodePumpPool,
  decodeSquadsProgramConfig,
  epochSubject,
  IDENTITY_MODE,
  initialBuyAmount,
  launch,
  launchPdas,
  launchTableAddresses,
  maxBuyInput,
  msg,
  OFFENCE,
  parsePrepayConfig,
  planLaunch,
  PROGRAM_IDS,
  paramsFromNetworkJson,
  payoutLeaf,
  programDataAddress,
  pump,
  PUMP,
  pumpAmm,
  pumpCrankIxs,
  pumpGraduateIxs,
  pumpInitialBuy,
  pumpLaunchMain,
  pumpPdas,
  pumpQuotedCurve,
  quoteCurveBuyExactOut,
  quoteInitialBuy,
  registry,
  registryPdas,
  requiredCredits,
  SQUADS_PERM,
  SQUADS_PROGRAM_ID,
  squads,
  squadsPdas,
  system,
  token,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  createV2,
  type Ix,
  type LookupTable,
  type PumpEvent,
  type Signer,
} from "@lineage/chain";
import { checkEndpoint, createMultisig, initializeAll, launchArgs, parseLaunchParams, programIdsNow, registryArgs, checkHandover, useActiveProfile } from "./steps.ts";
import { adminActions, approve, execute, multisigState, proposalState, propose, proposeConfig, type Ms } from "./admin.ts";
import { airdrop, assertFork, check, checks, fork, FORK_URL, forkKey, forkNow, forkRent, forkTable, KEYS, log, mainnet, mainnetRent, refused, rows, send, sendV0, sleep, sol } from "./lib.ts";

const ROOT = join(import.meta.dir, "..", "..");
const T22 = TOKEN_2022_PROGRAM;
const DECIMALS = 6;
const ONE = 10n ** BigInt(DECIMALS);
const SUPPLY = 1_000_000_000n * ONE;
/** $LINE the deployer buys on the stand-in's own curve (it holds 793,100,000; this leaves it uncompleted). */
const LINE_HELD = 600_000_000n * ONE;
// Program ids, builds and id keypairs follow the active network profile (LINEAGE_NETWORK): mainnet
// deploys the `--features mainnet` builds at the mainnet ids; devnet the default builds at the devnet ids.
const profile = useActiveProfile();
const IDS = programIdsNow();
const DEPLOY = join(ROOT, "onchain", "target", profile.network === "mainnet" ? "mainnet" : "deploy");
const idKey = (name: string) =>
  profile.network === "mainnet" ? join(homedir(), ".config", "lineage", "mainnet", `${name}-program-keypair.json`) : join(ROOT, "onchain", "target", "deploy", `lineage_${name}-keypair.json`);
const PROGRAMS = {
  registry: { id: IDS.registry, so: "lineage_registry.so", key: idKey("registry") },
  launch: { id: IDS.launch, so: "lineage_launch.so", key: idKey("launch") },
  msg: { id: IDS.msg, so: "lineage_msg.so", key: idKey("msg") },
};
const reader = new ChainReader(fork);
const out: Record<string, unknown> = { started: new Date().toISOString(), fork: FORK_URL, params: "scripts/mainnet/fork-params.json", profile: profile.network,
  program_ids: IDS, builds: DEPLOY.slice(ROOT.length + 1) };
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

// ---------------------------------------------------------------- keys (throwaway)
const dep = forkKey("deployer"); // upgrade authority until the handover, payer of deploys and initializers
const [m1, m2, m3] = [forkKey("m1"), forkKey("m2"), forkKey("m3")];
const createKey = forkKey("ms-create");
const core = forkKey("core");
const runtime = forkKey("runtime");
const launcher = forkKey("launcher");
const trader = forkKey("trader");
const vOwner = forkKey("verifier-owner");
const verifier = forkKey("verifier");
const lineMintKey = forkKey("line-mint");
const lineMint = lineMintKey.id;
const ms: Ms = { multisig: squadsPdas.multisig(createKey.id), vault: "" };
ms.vault = squadsPdas.vault(ms.multisig, 0);

// ---------------------------------------------------------------- the solana CLI against the fork only
const CLI_CONFIG = join(KEYS, "cli-fork.yml");
writeFileSync(CLI_CONFIG, `json_rpc_url: "${FORK_URL}"\nwebsocket_url: ""\nkeypair_path: "${join(KEYS, "deployer.json")}"\naddress_labels: {}\ncommitment: confirmed\n`);
function cli(args: string[]): string {
  const r = spawnSync("solana", ["-C", CLI_CONFIG, "-u", FORK_URL, "-k", join(KEYS, "deployer.json"), ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`solana ${args[0]} ${args[1]} failed: ${(r.stderr || r.stdout).slice(-600)}`);
  return r.stdout;
}
function freshKey(name: string): string {
  const p = join(KEYS, `${name}.json`);
  spawnSync("solana-keygen", ["new", "--no-bip39-passphrase", "--silent", "--force", "-o", p]);
  return p;
}
const pubkeyOf = (p: string) => spawnSync("solana-keygen", ["pubkey", p], { encoding: "utf8" }).stdout.trim();

async function programBytes(rpc: typeof fork, program: string): Promise<Uint8Array> {
  const pd = await rpc.getAccountInfo(programDataAddress(program));
  if (!pd) throw new Error(`no ProgramData for ${program}`);
  return pd.data.subarray(45);
}
const trimZeros = (b: Uint8Array) => {
  let n = b.length;
  while (n > 0 && b[n - 1] === 0) n--;
  return b.subarray(0, n);
};

// ---------------------------------------------------------------- 0: what the fork runs
async function step0() {
  await assertFork();
  await checkEndpoint(fork, profile, { deployed: false, local: true });
  const other = profile.network === "mainnet" ? PROGRAM_IDS.devnet : PROGRAM_IDS.mainnet;
  const has = (hay: Uint8Array, id: string) => Buffer.from(hay).indexOf(Buffer.from(addressBytes(id))) >= 0;
  for (const [name, p] of Object.entries(PROGRAMS)) {
    const so = readFileSync(join(DEPLOY, p.so));
    check(`0: ${name} build embeds the ${profile.network} ids only`, has(so, p.id) && !Object.values(other).some((id) => has(so, id)),
      `${DEPLOY.slice(ROOT.length + 1)}/${p.so}, ${so.length} bytes, ${sha(so).slice(0, 16)}`);
    check(`0: ${name} id keypair is the ${profile.network} id ${p.id.slice(0, 6)}...`, existsSync(p.key) && pubkeyOf(p.key) === p.id);
    check(`0: no program at ${p.id.slice(0, 6)}... on the fork yet (the deploy below is the first)`, (await fork.getAccountInfo(p.id)) === null);
  }
  const fromMainnet: Record<string, string> = {};
  for (const [name, id] of [["Pump", PUMP.program], ["PumpSwap", PUMP.amm], ["Pump Fees", PUMP.fees], ["Mayhem", PUMP.mayhem], ["Token-2022", T22], ["Squads v4", SQUADS_PROGRAM_ID]] as const) {
    const [f, m] = [trimZeros(await programBytes(fork, id)), trimZeros(await programBytes(mainnet, id))];
    fromMainnet[name] = sha(m);
    check(`0: fork ${name} is mainnet's build`, sha(f) === sha(m), sha(m).slice(0, 16));
  }
  const pc = decodeSquadsProgramConfig((await mainnet.getAccountInfo(squadsPdas.programConfig()))!.data);
  check("0: Squads program config cloned (mainnet creation fee read)", true, `fee ${pc.multisigCreationFee} lamports, treasury ${pc.treasury}`);
  out.mainnet_builds = { ...fromMainnet, squads_creation_fee_lamports: pc.multisigCreationFee.toString(), squads_treasury: pc.treasury };
  for (const k of [dep, m1, m2, m3, core, runtime, launcher, trader, vOwner]) await airdrop(k.id, 500n * 10n ** 9n);
}

// ---------------------------------------------------------------- 1: deploy path and its cost
async function step1() {
  const deploys: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(PROGRAMS)) {
    const so = join(DEPLOY, p.so);
    const len = readFileSync(so).length;
    const bufKp = freshKey(`deploy-buffer-${name}`), progKp = p.key;
    const buffer = pubkeyOf(bufKp), program = p.id;
    const b0 = await fork.getBalance(dep.id);
    cli(["program", "write-buffer", so, "--buffer", bufKp, "--buffer-authority", join(KEYS, "deployer.json"), "--fee-payer", join(KEYS, "deployer.json")]);
    const b1 = await fork.getBalance(dep.id);
    const bufBytes = (await fork.getAccountInfo(buffer))!.data.length;
    await sleep(1500);
    cli(["program", "deploy", "--buffer", bufKp, "--program-id", progKp, "--upgrade-authority", join(KEYS, "deployer.json"), "--max-len", String(len),
      "--fee-payer", join(KEYS, "deployer.json")]);
    await sleep(1500);
    const b2 = await fork.getBalance(dep.id);
    const pdBytes = (await fork.getAccountInfo(programDataAddress(program)))!.data.length;
    const progBytes = (await fork.getAccountInfo(program))!.data.length;
    const [fPd, fProg] = [await forkRent(pdBytes), await forkRent(progBytes)];
    const [mBuf, mPd, mProg] = [await mainnetRent(bufBytes), await mainnetRent(pdBytes), await mainnetRent(progBytes)];
    // Every transaction that touched the buffer (the writes and the deploy), read back one by one.
    const sigs = await fork.call<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [buffer, { limit: 1000, commitment: "confirmed" }]);
    let fees = 0n;
    for (const s of sigs) fees += BigInt((await fork.call<{ meta: { fee: number } }>("getTransaction", [s.signature, { encoding: "json", commitment: "confirmed" }])).meta.fee);
    const writeFees = fees; // includes the deploy transaction's fee
    check(`1: ${name} deployed at its ${profile.network} id ${program.slice(0, 6)}... by write-buffer + deploy`, (await fork.getAccountInfo(buffer)) === null && sigs.every((x) => !x.err) && b0 - b2 === fPd + fProg + fees,
      `ProgramData ${pdBytes} bytes, buffer ${bufBytes} bytes, ${sigs.length} transactions, fees ${fees}; balance delta equals rent + fees`);
    const onFork = (await programBytes(fork, program)).subarray(0, len);
    check(`1: ${name} at ${program.slice(0, 6)}... runs the build, upgrade authority the deployer`, sha(onFork) === sha(readFileSync(so)) &&
      decodeLoaderAuthority((await fork.getAccountInfo(programDataAddress(program)))!.data) === dep.id);
    deploys[name] = {
      program_id: program, so_bytes: len, so_sha256: sha(readFileSync(so)), max_len: len, buffer_bytes: bufBytes, programdata_bytes: pdBytes, program_bytes: progBytes,
      transactions: sigs.length, fees_lamports: writeFees.toString(),
      fork_delta_write_lamports: (b0 - b1).toString(), fork_delta_deploy_lamports: (b1 - b2).toString(),
      mainnet_rent: { buffer: mBuf.toString(), programdata: mPd.toString(), program: mProg.toString() },
      mainnet_locked_after: (mPd + mProg).toString(),
      mainnet_spent_after: (mPd + mProg + writeFees).toString(),
      mainnet_peak_during: (mBuf + writeFees + mPd + mProg).toString(),
    };
  }
  // upgrade headroom: what a larger --max-len locks, and the extend path
  const headroom: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(PROGRAMS)) {
    const len = readFileSync(join(DEPLOY, p.so)).length;
    headroom[name] = Object.fromEntries(await Promise.all([1, 1.25, 1.5, 2].map(async (f) => {
      const ml = Math.ceil(len * f);
      return [`x${f}`, { max_len: ml, programdata_mainnet_rent: (await mainnetRent(45 + ml)).toString() }];
    })));
  }
  // measured extend: the loader's 10,240-byte minimum, on a throwaway copy of the messages build at a
  // fresh id (the real programs stay exactly as the runbook deploys them)
  const msgLen = readFileSync(join(DEPLOY, PROGRAMS.msg.so)).length;
  const freshKp = freshKey("fresh-program-extend"), fresh = pubkeyOf(freshKp);
  cli(["program", "deploy", join(DEPLOY, PROGRAMS.msg.so), "--program-id", freshKp, "--upgrade-authority", join(KEYS, "deployer.json"), "--max-len", String(msgLen),
    "--fee-payer", join(KEYS, "deployer.json")]);
  await sleep(1500);
  const e0 = await fork.getBalance(dep.id);
  cli(["program", "extend", fresh, "10240"]);
  const e1 = await fork.getBalance(dep.id);
  const before = await forkRent(45 + msgLen);
  const after = await forkRent((await fork.getAccountInfo(programDataAddress(fresh)))!.data.length);
  const extendFee = e0 - e1 - (after - before);
  out.extend_10240 = { fee_lamports: extendFee.toString(), on: "a throwaway copy of lineage_msg", mainnet_rent_added: ((await mainnetRent(45 + 10240 + msgLen)) - (await mainnetRent(45 + msgLen))).toString(),
    per_program_mainnet_rent_added: Object.fromEntries(await Promise.all(Object.entries(PROGRAMS).map(async ([n, p]) => {
      const l = readFileSync(join(DEPLOY, p.so)).length;
      return [n, ((await mainnetRent(45 + 10240 + l)) - (await mainnetRent(45 + l))).toString()];
    }))) };
  // set-upgrade-authority: a fee only
  const s0 = await fork.getBalance(dep.id);
  cli(["program", "set-upgrade-authority", fresh, "--upgrade-authority", join(KEYS, "deployer.json"), "--new-upgrade-authority", ms.vault, "--skip-new-upgrade-authority-signer-check"]);
  out.set_upgrade_authority_fee_lamports = (s0 - (await fork.getBalance(dep.id))).toString();
  out.deploys = deploys;
  out.headroom = headroom;
}

// ---------------------------------------------------------------- 2: Squads multisig
async function step2() {
  const r = await createMultisig(fork, (w, p, i, o) => send("2", w, p, i, o), check, dep, createKey, P);
  check("2: the multisig and vault are the ones the rehearsal derived", r.multisig === ms.multisig && r.vault === ms.vault);
  // The vault pays the rent of the config accounts its admin actions create (ChallengeConfig and its vault, BountyConfig).
  await send("2", "fund the vault for the rent its admin actions create (0.05 SOL)", dep, [system.transfer(dep.id, ms.vault, 50_000_000n)]);
  out.multisig = { address: ms.multisig, vault: ms.vault, threshold: P.multisig.threshold, members: P.multisig.members, time_lock_s: P.multisig.time_lock_s };
}

// ---------------------------------------------------------------- 3: stand-in quote mint
const LINE_META = { name: "Lineage stand-in LINE (fork)", symbol: "sLINE", uri: "https://lineage.invalid/fork/stand-in-line.json" };
async function step3() {
  await send("3", "create the stand-in $LINE: pump.fun create_v2 paired with SOL, not mayhem", dep, [
    createV2({ mint: lineMint, user: dep.id, creator: dep.id, name: LINE_META.name, symbol: LINE_META.symbol, uri: LINE_META.uri, quote: { kind: "sol" } })],
    { signers: [lineMintKey], computeUnits: 400_000 });
  const c = decodeBondingCurve((await fork.getAccountInfo(pumpPdas.bondingCurve(lineMint)))!.data);
  const g = decodePumpGlobal((await fork.getAccountInfo(PUMP.global))!.data);
  const q = quoteCurveBuyExactOut(g, decodePumpFeeConfig((await fork.getAccountInfo(PUMP.feeConfig))!.data), c, LINE_HELD, SUPPLY);
  await send("3", `buy ${LINE_HELD / ONE} stand-in $LINE on its own curve with SOL (buy_v3)`, dep, [token.createAtaIdempotent(dep.id, dep.id, lineMint, T22),
    pump.buyV3({ mint: lineMint, quoteMint: PUMP.wsol, user: dep.id, amount: LINE_HELD, maxQuoteIn: (q.quoteIn * 101n) / 100n })], { computeUnits: 300_000 });
  const m = (await reader.mint(lineMint))!;
  check("3: stand-in $LINE: a pump.fun coin (Token-2022, 1e15 supply, no mint or freeze authority), quoted in SOL, depth 0, not mayhem",
    m.tokenProgram === T22 && m.supply === SUPPLY && m.mintAuthority === null && m.freezeAuthority === null && c.quoteMint === "11111111111111111111111111111111" && c.depth === 0 && !c.isMayhemMode);
  check("3: the deployer holds the bought $LINE", (await reader.tokenBalance(ata(dep.id, lineMint, T22))) === LINE_HELD);
}

// ---------------------------------------------------------------- 4: initialize with admin = the vault
// The fork's launch values: scripts/mainnet/fork-params.json (TEST shape), with this run's throwaway keys.
const forkParams = JSON.parse(readFileSync(join(import.meta.dir, "fork-params.json"), "utf8"));
const P = parseLaunchParams({ ...forkParams, multisig: { ...forkParams.multisig, members: [m1.id, m2.id, m3.id] }, core_authority: core.id,
  runtime_authority: runtime.id, line_mint: lineMint });
const params = P.params;
const net = P.net;
const TIME_LOCK_S = P.multisig.time_lock_s;
const CHALLENGE_WINDOW_S = Number(P.challenge.windowS);

async function step4() {
  const r = await initializeAll(fork, (w, p, i, o) => send("4", w, p, i, o), check, dep, P, ms.vault);
  out.launch_lookup_table = r.lookupTable;
}

// ---------------------------------------------------------------- 5: admin actions through the multisig
const sq = (what: string, payer: Signer, ixs: Ix[], o?: { computeUnits?: number }) => send("M2", what, payer, ixs, o);
type Msg = Awaited<ReturnType<typeof propose>>["message"];
async function viaSquads(label: string, ixs: Ix[], prove = false): Promise<bigint> {
  const { index, message } = await propose(fork, sq, ms, m1, label, ixs);
  await approve(sq, ms, m1, index, label);
  if (prove) {
    const one = await refused(m3, [squads.vaultTransactionExecute({ multisig: ms.multisig, index, member: m3.id, message })]);
    check("5: one approval of two cannot execute (InvalidProposalStatus)", /"Custom":6008/.test(one), one.slice(0, 120));
  }
  await approve(sq, ms, m2, index, label);
  const p = (await proposalState(fork, ms.multisig, index))!;
  check(`5: proposal ${index} approved by 2 of 3 (${label})`, p.status === "Approved" && p.approved.length === 2);
  if (prove) {
    const early = await refused(m3, [squads.vaultTransactionExecute({ multisig: ms.multisig, index, member: m3.id, message })]);
    check("5: the time lock refuses an execute right after approval (TimeLockNotReleased)", /"Custom":6021/.test(early), early.slice(0, 160));
  }
  await waitTimeLock(p.statusTs!);
  await execute(sq, ms, m3, index, message as Msg, label);
  const done = (await proposalState(fork, ms.multisig, index))!;
  check(`5: proposal ${index} executed (${label})`, done.status === "Executed");
  return index;
}
async function waitTimeLock(approvedAt: bigint) {
  const lock = BigInt((await multisigState(fork, ms.multisig)).timeLock);
  for (;;) {
    const now = await forkNow();
    if (BigInt(now) - approvedAt >= lock + 1n) return;
    await sleep(2000);
  }
}

const BOUNTY_ARGS = P.bounty;
/** The cap the vault sets: the largest single share, the lowest the registry accepts (one such slash per agent per epoch). */
const SLASH_CAP_BPS = Math.max(params.canarySlashBps, params.minoritySlashBps, params.revealSlashBps);
const CHALLENGE_ARGS = P.challenge;

async function step5() {
  const hot = await refused(dep, adminActions.registryPause(dep.id, true));
  check("5: the deployer (old hot key) is not the registry admin (Unauthorized)", /"Custom":6000/.test(hot), hot.slice(0, 120));
  await viaSquads("set_bounty_config", adminActions.bountySetConfig(ms.vault, BOUNTY_ARGS), true);
  const bc = (await reader.bountyConfig())!;
  check("5: BountyConfig set by the vault", bc.maxBountyOutBps === BOUNTY_ARGS.maxBountyOutBps && bc.minAmount === BOUNTY_ARGS.minAmount);
  await viaSquads("set_challenge_config", adminActions.challengeSetConfig(ms.vault, lineMint, T22, CHALLENGE_ARGS));
  const cc = (await reader.challengeConfig())!;
  check("5: ChallengeConfig set by the vault", Number(cc.windowS) === CHALLENGE_WINDOW_S && cc.bond === CHALLENGE_ARGS.bond);
  await viaSquads("registry set_config (max_rebate_per_epoch 2 units)", adminActions.registrySetConfig(ms.vault, { ...registryArgs(P, ms.vault), maxRebatePerEpoch: 2n * ONE }));
  check("5: registry set_config applied", (await reader.registryConfig())!.maxRebatePerEpoch === 2n * ONE);
  // A1-08: the per agent, per epoch slash cap. initialize set the default (largest share x strike_limit, at most 10,000).
  const maxShare = Math.max(params.canarySlashBps, params.minoritySlashBps, params.revealSlashBps);
  const capDefault = Math.min(maxShare * Math.max(params.strikeLimit, 1), 10_000);
  check("5: initialize set the default slash cap (largest share x strike_limit)", (await reader.registryConfig())!.maxSlashBpsPerEpoch === capDefault, `${capDefault} bps`);
  const hotCap = await refused(dep, adminActions.registrySetSlashCap(dep.id, SLASH_CAP_BPS));
  check("5: the deployer cannot set the slash cap (Unauthorized)", /"Custom":6000/.test(hotCap), hotCap.slice(0, 120));
  await viaSquads(`registry set_slash_cap (${SLASH_CAP_BPS} bps: one largest-share slash per agent per epoch)`, adminActions.registrySetSlashCap(ms.vault, SLASH_CAP_BPS));
  check("5: set_slash_cap applied by the vault", (await reader.registryConfig())!.maxSlashBpsPerEpoch === SLASH_CAP_BPS, `${capDefault} -> ${SLASH_CAP_BPS} bps`);
  out.slash_cap = { default_bps: capDefault, set_bps: SLASH_CAP_BPS };
  await viaSquads("set_launch_config (max_debit_per_epoch 500 units, pump_creator_fee_bps 0)", adminActions.launchSetConfig(ms.vault, { ...launchArgs(P, ms.vault), maxDebitPerEpoch: 500n * ONE }));
  const lc5 = (await reader.launchConfig())!;
  check("5: launch set_config applied (venue pump.fun, creator fee rate pump.fun's default)", lc5.maxDebitPerEpoch === 500n * ONE && lc5.venue === PUMP.program && lc5.pumpCreatorFeeBps === 0n);
  await viaSquads("lineage_msg set_config (max_per_day 400)", adminActions.msgSetConfig(ms.vault, { admin: ms.vault, ...P.msg, maxPerDay: 400 }));
  await viaSquads("registry pause", adminActions.registryPause(ms.vault, true));
  check("5: registry paused by the vault", (await reader.registryConfig())!.paused === true);
  await viaSquads("registry unpause", adminActions.registryPause(ms.vault, false));
  const c = (await reader.registryConfig())!;
  await viaSquads("registry set_epoch_cursor (rewrites the current values)", adminActions.registrySetEpochCursor(ms.vault, {
    epochsPosted: c.epochsPosted, lastEpoch: c.lastEpoch, anchor: c.epochAnchor ?? 0n, anchorTs: c.epochAnchorTs ?? 0n }));
  // a config transaction (time lock change) through the same path
  const idx = await proposeConfig(fork, sq, ms, m1, `time lock ${TIME_LOCK_S} -> ${TIME_LOCK_S + 5} s`, [{ kind: "setTimeLock", seconds: TIME_LOCK_S + 5 }]);
  await approve(sq, ms, m1, idx, "time lock");
  await approve(sq, ms, m2, idx, "time lock");
  await waitTimeLock((await proposalState(fork, ms.multisig, idx))!.statusTs!);
  await send("5", `squads: execute config transaction ${idx} (time lock)`, m3, [squads.configTransactionExecute({ multisig: ms.multisig, index: idx, member: m3.id, rentPayer: m3.id })]);
  check("5: config transaction executed: time lock changed", (await multisigState(fork, ms.multisig)).timeLock === TIME_LOCK_S + 5);
}

// ---------------------------------------------------------------- 6: upgrade authority to the vault, multisig upgrade
async function step6() {
  for (const [name, p] of Object.entries(PROGRAMS)) {
    const s0 = await fork.getBalance(dep.id);
    cli(["program", "set-upgrade-authority", p.id, "--upgrade-authority", join(KEYS, "deployer.json"), "--new-upgrade-authority", ms.vault, "--skip-new-upgrade-authority-signer-check"]);
    const a = decodeLoaderAuthority((await fork.getAccountInfo(programDataAddress(p.id)))!.data);
    check(`6: ${name} upgrade authority is the vault`, a === ms.vault, `fee ${s0 - (await fork.getBalance(dep.id))}`);
  }
  const so = join(DEPLOY, PROGRAMS.msg.so);
  const hot = spawnSync("solana", ["-C", CLI_CONFIG, "-u", FORK_URL, "-k", join(KEYS, "deployer.json"), "program", "deploy", so, "--program-id", PROGRAMS.msg.id,
    "--upgrade-authority", join(KEYS, "deployer.json")], { encoding: "utf8" });
  check("6: the deployer can no longer upgrade", hot.status !== 0, (hot.stderr || hot.stdout).trim().split("\n").pop()!.slice(0, 120));
  const bufKp = freshKey("upgrade-buffer-msg");
  const buffer = pubkeyOf(bufKp);
  cli(["program", "write-buffer", so, "--buffer", bufKp, "--buffer-authority", join(KEYS, "deployer.json"), "--fee-payer", join(KEYS, "deployer.json")]);
  cli(["program", "set-buffer-authority", buffer, "--buffer-authority", join(KEYS, "deployer.json"), "--new-buffer-authority", ms.vault]);
  check("6: buffer authority handed to the vault", decodeLoaderAuthority((await fork.getAccountInfo(buffer))!.data) === ms.vault);
  await viaSquads("upgrade lineage_msg from buffer", adminActions.upgradeProgram(ms.vault, { program: PROGRAMS.msg.id, buffer, spill: dep.id }));
  const local = readFileSync(so);
  const now = (await programBytes(fork, PROGRAMS.msg.id)).subarray(0, local.length);
  check("6: lineage_msg upgraded by the multisig: code equals the build, authority still the vault, buffer closed",
    sha(now) === sha(local) && decodeLoaderAuthority((await fork.getAccountInfo(programDataAddress(PROGRAMS.msg.id)))!.data) === ms.vault &&
    (await fork.getAccountInfo(buffer)) === null);
  await checkHandover(fork, (n, ok, d) => check(`6: handover: ${n}`, ok, d), ms.vault, P);
}

// ---------------------------------------------------------------- 7: pump.fun launches, trades, fees, graduation
const lineOf = (owner: string) => ata(owner, lineMint, T22);
async function giveLine(to: string, amount: bigint, label: string) {
  await send("7", `send ${amount / ONE} stand-in $LINE to ${label}`, dep, [
    token.createAtaIdempotent(dep.id, to, lineMint, T22),
    token.transferChecked(lineOf(dep.id), lineMint, lineOf(to), dep.id, amount, DECIMALS, T22),
  ]);
}
const G = async () => decodePumpGlobal((await fork.getAccountInfo(PUMP.global))!.data);
const FC = async () => decodePumpFeeConfig((await fork.getAccountInfo(PUMP.feeConfig))!.data);
const curveOf = async (mint: string) => decodeBondingCurve((await fork.getAccountInfo(pumpPdas.bondingCurve(mint)))!.data);
const split = (fees: bigint) => {
  const c = (fees * BigInt(net.agent_compute_bps)) / 10_000n;
  return [c, fees - c] as const;
};
async function events(sig: string): Promise<PumpEvent[]> {
  const t = await fork.call<{ meta: { innerInstructions: { instructions: { data: string }[] }[] } }>("getTransaction",
    [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
  return (t.meta.innerInstructions ?? []).flatMap((g) => g.instructions.map((i) => decodePumpEvent(base58Decode(i.data)))).filter((e): e is PumpEvent => e !== null);
}
const linePoolNow = async () => {
  const pool = pumpPdas.pool(lineMint, PUMP.wsol);
  const a = await fork.getAccountInfo(pool);
  if (!a) return undefined;
  const p = decodePumpPool(a.data);
  return { pool, baseVault: p.poolBaseTokenAccount, quoteVault: p.poolQuoteTokenAccount };
};
let launchTable: LookupTable | null = null;
async function tableFor(linePool?: { pool: string; baseVault: string; quoteVault: string }): Promise<LookupTable> {
  if (!linePool && launchTable) return launchTable;
  if (!linePool) {
    const t = decodeLookupTable((await fork.getAccountInfo(out.launch_lookup_table as string))!.data);
    return (launchTable = { address: out.launch_lookup_table as string, addresses: t.addresses });
  }
  return forkTable("7", dep, launchTableAddresses({ lineMint, lineTokenProgram: T22, linePool }));
}

/** One agent launch on pump.fun exactly as the wizard plans it: create_v2 + register_pump_launch + the 1% initial buy + deposit + wake. */
async function launchOne(tag: string, symbol: string, linePool?: { pool: string; baseVault: string; quoteVault: string }) {
  const agent = forkKey(`agent-${tag}`), mintK = forkKey(`agent-${tag}-mint-${Date.now()}`);
  const g = await G(), fc = await FC();
  const lc = await curveOf(lineMint);
  const pool = linePool ? { pool: decodePumpPool((await fork.getAccountInfo(linePool.pool))!.data), baseReserve: (await reader.tokenBalance(linePool.baseVault))!,
    quoteReserve: (await reader.tokenBalance(linePool.quoteVault))! } : undefined;
  const fresh = pumpQuotedCurve(g, { curve: lc, pool }, launchPdas.pumpCreator(agent.id), lineMint, 0n);
  const amountOut = initialBuyAmount(g.tokenTotalSupply, 100);
  const quote = quoteInitialBuy(g, fc, fresh, amountOut);
  const maxIn = maxBuyInput(quote, 100);
  const deposit = requiredCredits(parsePrepayConfig(net.prepay), DECIMALS);
  const main = pumpLaunchMain({ launcher: launcher.id, agent: agent.id, agentMint: mintK.id, line: { mint: lineMint, tokenProgram: T22, pool: linePool },
    name: `Fork rehearsal ${symbol}`, symbol, uri: `https://lineage.invalid/fork/${tag}.json`,
    args: { repoUrl: canonicalUrl("https://github.com/karpathy/minbpe"), identityMode: IDENTITY_MODE.app, hosted: false } });
  const buy = pumpInitialBuy({ launcher: launcher.id, agent: agent.id, agentMint: mintK.id, lineMint, amountOut, maxIn, lineTokenProgram: T22,
    createBuyback: !(await fork.getAccountInfo(ata(PUMP.buybackRecipients[0], lineMint, T22))) });
  const rest = launch.prepay({ launcher: launcher.id, agent: agent.id, agentMint: mintK.id, lineMint, amount: deposit, decimals: DECIMALS, lineTokenProgram: T22 });
  const table = await tableFor(linePool);
  const plan = planLaunch({ payer: launcher.id, main, buy, rest, soul: null, budget: [computeBudget.limit(700_000)], table, v0: true });
  const l0 = (await reader.tokenBalance(lineOf(launcher.id)))!;
  const sent = [];
  for (const [i, t] of plan.txs.entries()) {
    const what = `${symbol} launch tx ${i + 1}/${plan.txs.length} (${t.ixs.length} instructions${i === plan.buyTx ? ", with the 1% initial buy" : ""}${t.table ? ", v0" : ""})`;
    sent.push(t.table ? await sendV0("7", what, launcher, t.ixs, [t.table], { signers: i === 0 ? [agent, mintK] : [], computeUnits: 700_000 })
      : await send("7", what, launcher, t.ixs, { signers: i === 0 ? [agent, mintK] : [], computeUnits: 700_000 }));
  }
  const la = (await reader.agentLaunch(mintK.id))!;
  const c = await curveOf(mintK.id);
  check(`7: ${symbol} registered in the create_v2 transaction (AgentLaunch venue pump, curve creator = the agent's PDA, quote $LINE, depth 1)`,
    la.venue === "pump" && la.bondingCurve === pumpPdas.bondingCurve(mintK.id) && la.pumpCreator === launchPdas.pumpCreator(agent.id) && c.creator === la.pumpCreator
    && c.quoteMint === lineMint && c.depth === 1 && !!(await reader.agent(agent.id)), `plan ${plan.mode}, sizes ${plan.txs.map((t) => t.size).join(", ")} bytes`);
  const spent = l0 - (await reader.tokenBalance(lineOf(launcher.id)))! - deposit;
  check(`7: ${symbol} initial buy: exactly 1% of the supply in the agent key's account, at exactly the quote (pump.fun arithmetic), within maxIn`,
    (await reader.tokenBalance(ata(agent.id, mintK.id, T22))) === amountOut && spent === quote && spent <= maxIn, `${amountOut} tokens for ${spent} $LINE (quote ${quote}, max ${maxIn})`);
  check(`7: ${symbol} deposit in the compute vault`, (await reader.tokenBalance(launchPdas.computeVault(agent.id))) === deposit, `${deposit}`);
  return { agent, mint: mintK.id, plan, sent, cost: sent.map((s) => s.cost), quote, amountOut };
}

async function crankExact(l: { agent: Signer; mint: string }, label: string, graduated: boolean) {
  const pool = pumpPdas.pool(l.mint, lineMint);
  const curveFee = (await curveOf(l.mint)).creatorFee;
  const poolFee = graduated ? decodePumpPool((await fork.getAccountInfo(pool))!.data).creatorFees : 0n;
  const vault = launchPdas.computeVault(l.agent.id);
  const [c0, t0] = await reader.tokenBalances([vault, registryPdas.treasury()]);
  const r = await send("7", `${label}: keeper harvest (pump.fun sweep + collect${graduated ? ", curve and pool" : ""}) + crank_pump_fees`, trader,
    pumpCrankIxs({ payer: trader.id, agent: l.agent.id, agentMint: l.mint, lineMint, lineTokenProgram: T22, pool: graduated ? pool : undefined }), { computeUnits: 600_000 });
  const [c1, t1] = await reader.tokenBalances([vault, registryPdas.treasury()]);
  const [wc, wp] = split(curveFee + poolFee);
  check(`7: ${label}: compute vault and treasury got exactly the waiting creator fees split ${net.agent_compute_bps}/${net.protocol_bps}`,
    c1! - c0! === wc && t1! - t0! === wp && curveFee + poolFee > 0n, `curve ${curveFee} + pool ${poolFee} = ${curveFee + poolFee}: ${wc} / ${wp}`);
  return r;
}

async function step7() {
  await giveLine(trader.id, 330_000_000n * ONE, "the trader");
  await giveLine(launcher.id, 5_000_000n * ONE, "the launcher");
  const a = await launchOne("a", "FRKA");
  out.launch_a = { mint: a.mint, agent: a.agent.id, plan: a.plan.mode, sizes: a.plan.txs.map((t) => t.size), initial_buy: { tokens: a.amountOut.toString(), line: a.quote.toString() },
    launch_txs: a.cost.map((c) => ({ signature: c.signature, payer_mainnet_lamports: c.payerMainnet, created: c.created, compute_units: c.computeUnits })) };
  // curve trades: $LINE in, a sell, and SOL straight in through multi_hop_swap ($LINE curve -> FRKA curve)
  const t = { mint: a.mint, quoteMint: lineMint, quoteTokenProgram: T22, user: trader.id };
  await send("7", "FRKA buy_exact_quote_in_v3 (100,000 $LINE)", trader, [token.createAtaIdempotent(trader.id, trader.id, a.mint, T22),
    pump.buyExactQuoteInV3({ ...t, spendableQuoteIn: 100_000n * ONE, minTokensOut: 1n })], { computeUnits: 300_000 });
  const held = (await reader.tokenBalance(ata(trader.id, a.mint, T22)))!;
  await send("7", "FRKA sell_v3 (half)", trader, [pump.sellV3({ ...t, amount: held / 2n, minQuoteOut: 1n })], { computeUnits: 300_000 });
  const hop = await send("7", "multi_hop_swap SOL -> $LINE curve -> FRKA curve (1 SOL)", trader, [token.createAtaIdempotent(trader.id, trader.id, PUMP.wsol, TOKEN_PROGRAM),
    pumpAmm.multiHopSwap({ user: trader.id, userIn: ata(trader.id, PUMP.wsol, TOKEN_PROGRAM), userOut: ata(trader.id, a.mint, T22), amountIn: 1_000_000_000n, minOut: 1n,
      buybackQuoteMint: PUMP.wsol, hops: [{ kind: "curve", mint: lineMint, quoteMint: PUMP.wsol }, { kind: "curve", mint: a.mint, quoteMint: lineMint, quoteTokenProgram: T22 }] })],
    { computeUnits: 400_000 });
  check("7: multi_hop_swap from SOL bought FRKA (two TradeEvents)", (await events(hop.signature)).filter((e) => e.name === "TradeEvent").length === 2);
  const crankA = await crankExact(a, "FRKA on its curve", false);
  out.crank_curve = { signature: crankA.signature, payer_mainnet_lamports: crankA.cost.payerMainnet, compute_units: crankA.cost.computeUnits, created: crankA.cost.created };
  // completion: the buy that empties the curve continues into the pool-to-be (synthetic migration), then migrate_v2 and our record
  const notYet = await refused(trader, [launch.recordPumpGraduation({ agentMint: a.mint, lineMint })]);
  check("7: record_pump_graduation refused before completion (NotMigrated)", /NotMigrated/.test(notYet), notYet.slice(0, 120));
  const cur = await curveOf(a.mint);
  const past = 1_000_000n * ONE;
  const q = quoteCurveBuyExactOut(await G(), await FC(), cur, cur.realTokenReserves + past, (await reader.tokenBalance(ata(pumpPdas.bondingCurve(a.mint), a.mint, T22)))!);
  const fill = await send("7", "FRKA: completing buy_v3 past the curve (synthetic migration)", trader, [pump.buyV3({ ...t, amount: cur.realTokenReserves + past, maxQuoteIn: (q.quoteIn * 101n) / 100n })],
    { computeUnits: 400_000 });
  const ev = (await events(fill.signature)).map((e) => e.name);
  check("7: FRKA completed: TradeEvent, CompleteEvent, PostCompleteBuyEvent", ev.join(",").includes("TradeEvent,CompleteEvent,PostCompleteBuyEvent"));
  const g = await G();
  const grad = await send("7", "FRKA: pump.fun migrate_v2 + record_pump_graduation (permissionless, one transaction)", trader,
    pumpGraduateIxs({ payer: trader.id, agentMint: a.mint, lineMint, withdrawAuthority: g.withdrawAuthority, migrated: false, lineTokenProgram: T22 }), { computeUnits: 900_000 });
  const la = (await reader.agentLaunch(a.mint))!;
  const pool = pumpPdas.pool(a.mint, lineMint);
  const pv = decodePumpPool((await fork.getAccountInfo(pool))!.data);
  check("7: FRKA graduated: AgentLaunch records the canonical PumpSwap pool; Pool.coin_creator is the agent's PDA; LP supply 0",
    la.graduated && la.pumpPool === pool && pv.coinCreator === la.pumpCreator && pv.quoteMint === lineMint && (await reader.mint(pv.lpMint))!.supply === 0n);
  out.graduation = { signature: grad.signature, payer_mainnet_lamports: grad.cost.payerMainnet, compute_units: grad.cost.computeUnits, created: grad.cost.created };
  const again = await refused(trader, [launch.recordPumpGraduation({ agentMint: a.mint, lineMint })]);
  check("7: graduation is recorded once (WrongPhase)", /WrongPhase/.test(again), again.slice(0, 120));
  const pt = { pool, mint: a.mint, quoteMint: lineMint, quoteTokenProgram: T22, user: trader.id };
  await send("7", "FRKA PumpSwap buy_exact_quote_in_v2 (200,000 $LINE)", trader, [pumpAmm.buyExactQuoteInV2({ ...pt, spendableQuoteIn: 200_000n * ONE, minBaseOut: 1n })],
    { computeUnits: 300_000 });
  await send("7", "FRKA PumpSwap sell_v2", trader, [pumpAmm.sellV2({ ...pt, baseIn: 1_000_000n * ONE, minQuoteOut: 1n })], { computeUnits: 300_000 });
  const crankP = await crankExact(a, "FRKA after graduation (curve leftover + pool)", true);
  out.crank_pool = { signature: crankP.signature, payer_mainnet_lamports: crankP.cost.payerMainnet, compute_units: crankP.cost.computeUnits };

  // $LINE itself migrates; a launch quoted in the migrated $LINE names its pool (the second table) and trades through it
  const lc = await curveOf(lineMint);
  const lq = quoteCurveBuyExactOut(await G(), await FC(), lc, lc.realTokenReserves + 1_000_000n * ONE, (await reader.tokenBalance(ata(pumpPdas.bondingCurve(lineMint), lineMint, T22)))!);
  await send("7", "$LINE stand-in: completing buy with SOL (synthetic migration)", dep, [
    pump.buyV3({ mint: lineMint, quoteMint: PUMP.wsol, user: dep.id, amount: lc.realTokenReserves + 1_000_000n * ONE, maxQuoteIn: (lq.quoteIn * 101n) / 100n })], { computeUnits: 400_000 });
  await send("7", "$LINE stand-in: migrate_v2 to PumpSwap (permissionless)", dep, [
    pump.migrateV2({ user: dep.id, mint: lineMint, quoteMint: PUMP.wsol, withdrawAuthority: (await G()).withdrawAuthority, quoteTokenProgram: TOKEN_PROGRAM })], { computeUnits: 900_000 });
  const lp = (await linePoolNow())!;
  check("7: $LINE migrated: its canonical PumpSwap pool is quoted in WSOL", !!lp);
  const b = await launchOne("b", "FRKB", lp);
  out.launch_b = { mint: b.mint, agent: b.agent.id, plan: b.plan.mode, sizes: b.plan.txs.map((t) => t.size), launch_txs: b.cost.map((c) => ({ signature: c.signature, payer_mainnet_lamports: c.payerMainnet })) };
  await send("7", "multi_hop_swap SOL -> $LINE pool -> FRKB curve (1 SOL wrapped)", trader, [
    system.transfer(trader.id, ata(trader.id, PUMP.wsol, TOKEN_PROGRAM), 1_000_000_000n), { programId: TOKEN_PROGRAM, keys: [{ pubkey: ata(trader.id, PUMP.wsol, TOKEN_PROGRAM), isSigner: false, isWritable: true }], data: Uint8Array.of(17) },
    token.createAtaIdempotent(trader.id, PUMP.buybackRecipients[0], PUMP.wsol, TOKEN_PROGRAM), token.createAtaIdempotent(trader.id, trader.id, b.mint, T22),
    pumpAmm.multiHopSwap({ user: trader.id, userIn: ata(trader.id, PUMP.wsol, TOKEN_PROGRAM), userOut: ata(trader.id, b.mint, T22), amountIn: 1_000_000_000n, minOut: 1n,
      buybackQuoteMint: PUMP.wsol, hops: [{ kind: "pool", mint: lineMint, quoteMint: PUMP.wsol, pool: lp.pool }, { kind: "curve", mint: b.mint, quoteMint: lineMint, quoteTokenProgram: T22 }] })],
    { computeUnits: 400_000 });
  await crankExact(b, "FRKB (quoted in the migrated $LINE)", false);
  return a;
}

// ---------------------------------------------------------------- 8: verifier, epoch, challenge, claims
async function step8(a: { agent: Signer }) {
  await giveLine(vOwner.id, params.registerBurn + params.minBond + 10n * ONE, "the verifier owner");
  const ownerLine = lineOf(vOwner.id);
  await send("8", "register a verifier (burns register_burn)", vOwner, [
    registry.register({ owner: vOwner.id, agent: verifier.id, mint: lineMint, ownerToken: ownerLine, operator: H("operator", "fork"), capabilities: "00".repeat(32), tokenProgram: T22 }),
  ], { signers: [verifier] });
  await send("8", "bond min_bond", vOwner, [registry.bond({ owner: vOwner.id, agent: verifier.id, mint: lineMint, ownerToken: ownerLine, amount: params.minBond, tokenProgram: T22 })]);
  await send("8", "split (treasury to reserve and pool, permissionless)", trader, [registry.split({ mint: lineMint, tokenProgram: T22 })]);
  const [pool, reserve] = await reader.tokenBalances([registryPdas.pool(), registryPdas.reserve()]);
  const units = new Map([[`${verifier.id}\nagent:${verifier.id}:wallet`, 3], [`${a.agent.id}\nagent:${a.agent.id}:compute`, 4]]);
  const split = proportionalSplit(pool!, units);
  const rebate = params.rebatePerClass;
  check("8: reserve covers the rebate", reserve! >= rebate);
  const n = 0;
  const leaves = [...units.keys()].sort().map((k) => {
    const [agent, dest] = k.split("\n") as [string, string];
    const amount = (split.get(k) ?? 0n) + (agent === verifier.id ? rebate : 0n);
    return { agent, dest, amount: amount.toString(), leaf: payoutLeaf(n, agent, dest, amount) };
  });
  const root = merkleRoot(leaves.map((l) => l.leaf));
  const post = await send("8", `post_epoch ${n} (Core authority: 2 leaves, pool ${pool}, rebate ${rebate})`, core, [
    registry.postEpoch({ coreAuthority: core.id, mint: lineMint, epoch: n, payoutRoot: root, lineageRoot: merkleRoot([]), totalUnitsMicro: 7_000_000n, poolAmount: pool!,
      rebateAmount: rebate, tokenProgram: T22 })]);
  const postedAt = await forkNow();
  await send("8", "open_challenge (epoch kind, by the verifier's signing key, bond from its owner)", vOwner, [
    challenge.open({ challenger: verifier.id, signingKey: verifier.id, payer: vOwner.id, payerToken: ownerLine, mint: lineMint, kind: CHALLENGE_KIND.epoch,
      subject: epochSubject(n), epoch: n, claim: H("fork-claim", "rehearsal"), tokenProgram: T22 }),
  ], { signers: [verifier] });
  const c0 = leaves.map((l, i) => claimFromCoreProof({ epoch: n, ...l, proof: merkleProof(leaves.map((x) => x.leaf), i), root }));
  const held = await refused(trader, [registry.claim({ payer: trader.id, mint: lineMint, ...c0[0]!, destToken: c0[0]!.destKind === 1 ? launchPdas.computeVault(a.agent.id) : ownerLine, tokenProgram: T22 })]);
  check("8: claims are held while the challenge is open (ClaimHeld)", /ClaimHeld/.test(held), held.slice(0, 160));
  const b0 = (await reader.tokenBalance(ownerLine))!;
  await send("8", "resolve_challenge void (Core authority; bond returned)", core, [
    challenge.resolve({ coreAuthority: core.id, mint: lineMint, kind: CHALLENGE_KIND.epoch, subject: epochSubject(n), epoch: n, refundToken: ownerLine,
      outcome: CHALLENGE_OUTCOME.void, evidence: H("fork-evidence", "void"), tokenProgram: T22 })]);
  check("8: void resolution returned the bond", (await reader.tokenBalance(ownerLine))! - b0 === CHALLENGE_ARGS.bond);
  while ((await forkNow()) < postedAt + CHALLENGE_WINDOW_S + 2) await sleep(2000);
  for (const [i, l] of leaves.entries()) {
    const c = c0[i]!;
    const dest = l.dest.endsWith(":compute") ? launchPdas.computeVault(l.agent) : ownerLine;
    const d0 = (await reader.tokenBalance(dest))!;
    await send("8", `claim epoch ${n} leaf ${l.dest.split(":").pop()} (anyone pays; receipt rent)`, trader, [registry.claim({ payer: trader.id, mint: lineMint, ...c, destToken: dest, tokenProgram: T22 })]);
    check(`8: claim paid exactly the leaf (${l.dest.split(":").pop()})`, (await reader.tokenBalance(dest))! - d0 === BigInt(l.amount));
  }
  out.epoch_post_signature = post.signature;

  // A1-08 on the fork: Core slashes the verifier up to the cap; the next slash in the same chain epoch is refused whole.
  const cfg = (await reader.registryConfig())!;
  const v0 = (await reader.agent(verifier.id))!;
  const sid = (tag: string) => H("fork-slash", tag);
  const slashIx = (offence: number, tag: string) =>
    registry.slash({ coreAuthority: core.id, agent: verifier.id, mint: lineMint, offence, epoch: n, slashId: sid(tag), tokenProgram: T22 });
  const r0 = (await reader.tokenBalance(registryPdas.reserve()))!;
  await send("8", `slash canary (${params.canarySlashBps} bps of the bond, Core authority; SlashReceipt)`, core, [slashIx(OFFENCE.canary, "one")]);
  const v1 = (await reader.agent(verifier.id))!;
  const first = (v0.bond * BigInt(params.canarySlashBps)) / 10_000n;
  check("8: first slash landed: bond down by the canary share, moved to the reserve, counted in this epoch's window",
    v0.bond - v1.bond === first && (await reader.tokenBalance(registryPdas.reserve()))! - r0 === first && v1.slashWindow === cfg.epochsPosted && v1.slashedInWindow === first &&
    (await reader.slashReceipt(sid("one")))?.amount === first, `slashed ${first}, window ${v1.slashWindow}, cap ${cfg.maxSlashBpsPerEpoch} bps of ${v0.bond}`);
  const capped = await refused(core, [slashIx(OFFENCE.canary, "two")]);
  const v2 = (await reader.agent(verifier.id))!;
  check("8: a second slash past the cap in the same chain epoch is refused whole (SlashCap), nothing moved",
    /SlashCap/.test(capped) && v2.bond === v1.bond && v2.slashedInWindow === v1.slashedInWindow && v2.strikesTotal === v1.strikesTotal &&
    (await reader.slashReceipt(sid("two"))) === null, capped.slice(0, 160));
  await send("8", "slash abandon (a strike without an amount; never refused by the cap)", core, [slashIx(OFFENCE.abandon, "three")]);
  const v3 = (await reader.agent(verifier.id))!;
  check("8: a strike without an amount lands under the cap", v3.bond === v2.bond && v3.strikesTotal === v2.strikesTotal + 1);
  out.slash = { bond_before: v0.bond.toString(), first_slash: first.toString(), cap_bps: cfg.maxSlashBpsPerEpoch, window: v1.slashWindow.toString(), refused: capped.slice(0, 200) };
}

// ---------------------------------------------------------------- run
let outcome = "PASS";
try {
  await step0();
  await step1();
  await step2();
  await step3();
  await step4();
  await step5();
  await step6();
  const a = await step7();
  await step8(a);
} catch (e) {
  outcome = `FAIL: ${(e as Error).message}`;
  console.error(e);
} finally {
  out.finished = new Date().toISOString();
  out.outcome = outcome;
  out.checks = checks;
  out.transactions = rows;
  writeFileSync(join(import.meta.dir, "REHEARSAL-LAST.json"), JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  console.log(`[fork] rehearsal ${outcome}: checks ${checks.filter((c) => c.ok).length}/${checks.length}, ${rows.length} transactions measured`);
  if (outcome !== "PASS") process.exit(1);
}
