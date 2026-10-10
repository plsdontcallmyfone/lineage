#!/usr/bin/env bun
// M1 + M2 mainnet rehearsal on a local fork of mainnet (scripts/mainnet/fork.sh). Nothing is sent to
// mainnet and no real key signs anything: every key is a throwaway in MAINNET_FORK_KEYS and every
// lamport is a fork airdrop. Mainnet is only read (program bytes, Squads program config, rent).
//
//   0  the fork runs mainnet's exact Meteora DBC, DAMM v2, Token-2022 and Squads v4 builds, and our builds
//   1  deploy cost: write-buffer + deploy of each program at a fresh id, exactly as the runbook does
//   2  Squads v4: a 2-of-3 multisig with a time lock; its vault is every admin and, later, the upgrade authority
//   3  a stand-in $LINE quote mint (Token-2022, metadata, fixed supply) until the real one exists
//   4  initialize registry, launch and messages with admin = the vault (mainnet-shaped values, owner values TBA)
//   5  every onchain admin action through propose, approve (2 of 3), time lock, execute
//   6  upgrade authority to the vault, then an upgrade executed by the multisig
//   7  launch, trades, fee crank, graduation on mainnet DBC to DAMM v2 (permissionless and by admin)
//   8  verifier, epoch post, a challenge opened and resolved, claims after the window
// Writes scripts/mainnet/REHEARSAL-LAST.json (every transaction with its exact cost, every check).
//
//   MAINNET_FORK_KEYS=<throwaway key dir> bun scripts/mainnet/rehearsal.ts
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalUrl, H, merkleProof, merkleRoot, proportionalSplit } from "@lineage/protocol";
import {
  ata,
  CHALLENGE_KIND,
  CHALLENGE_OUTCOME,
  challenge,
  ChainReader,
  claimFromCoreProof,
  damm,
  dammPdas,
  dbc,
  decodeAgentLaunch,
  decodeDammPool,
  decodeDammPosition,
  decodeDbcPool,
  decodeLoaderAuthority,
  decodeLookupTable,
  decodeSquadsProgramConfig,
  epochSubject,
  IDENTITY_MODE,
  launch,
  launchPdas,
  launchTableAddresses,
  lookupTable,
  METEORA,
  msg,
  paramsFromNetworkJson,
  payoutLeaf,
  programDataAddress,
  registry,
  registryPdas,
  SQUADS_PERM,
  SQUADS_PROGRAM_ID,
  squads,
  squadsPdas,
  standardDbcParams,
  system,
  T22_MINT_WITH_POINTER,
  token,
  TOKEN_2022_PROGRAM,
  tokenMetadataLen,
  type Ix,
  type Signer,
} from "@lineage/chain";
import { adminActions, approve, execute, multisigState, proposalState, propose, proposeConfig, type Ms } from "./admin.ts";
import { airdrop, assertFork, check, checks, fork, FORK_URL, forkKey, forkNow, forkRent, KEYS, log, mainnet, mainnetRent, refused, rows, send, sleep, sol } from "./lib.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DEPLOY = join(ROOT, "onchain", "target", "deploy");
const T22 = TOKEN_2022_PROGRAM;
const DECIMALS = 6;
const ONE = 10n ** BigInt(DECIMALS);
const SUPPLY = 1_000_000_000n * ONE;
const TIME_LOCK_S = 20; // fork value so the run finishes; the mainnet time lock is an owner value (TBA)
const CHALLENGE_WINDOW_S = 30; // fork value; mainnet TBA
const PROGRAMS = {
  registry: { id: "2vhj9aBZkuoCpmJxm5BcA3CYkvBJgY6VHTax8FpFmxuY", so: "lineage_registry.so" },
  launch: { id: "8eHzm1XtNtbxJujrMAci4VdhCJvQttFUBukmkFaUwsAT", so: "lineage_launch.so" },
  msg: { id: "E6vHskQjJAMLqDKXyfnn2ZDjeJ57RZXR4H9RjPDzapAB", so: "lineage_msg.so" },
} as const;
const reader = new ChainReader(fork);
const out: Record<string, unknown> = { started: new Date().toISOString(), fork: FORK_URL, time_lock_s: TIME_LOCK_S, challenge_window_s: CHALLENGE_WINDOW_S };
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
const dbcConfigKey = forkKey("dbc-config");
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
  const fromMainnet: Record<string, string> = {};
  for (const [name, id] of [["Meteora DBC", METEORA.dbcProgram], ["Meteora DAMM v2", METEORA.dammV2Program], ["Token-2022", T22], ["Squads v4", SQUADS_PROGRAM_ID]] as const) {
    const [f, m] = [trimZeros(await programBytes(fork, id)), trimZeros(await programBytes(mainnet, id))];
    fromMainnet[name] = sha(m);
    check(`0: fork ${name} is mainnet's build`, sha(f) === sha(m), sha(m).slice(0, 16));
  }
  for (const [name, p] of Object.entries(PROGRAMS)) {
    const local = readFileSync(join(DEPLOY, p.so));
    const onFork = (await programBytes(fork, p.id)).subarray(0, local.length);
    check(`0: fork ${name} at ${p.id.slice(0, 6)} is the local build`, sha(onFork) === sha(local), `${local.length} bytes, ${sha(local).slice(0, 16)}`);
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
    const bufKp = freshKey(`fresh-buffer-${name}`), progKp = freshKey(`fresh-program-${name}`);
    const buffer = pubkeyOf(bufKp), program = pubkeyOf(progKp);
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
    check(`1: ${name} deployed at a fresh id by write-buffer + deploy`, (await fork.getAccountInfo(buffer)) === null && sigs.every((x) => !x.err) && b0 - b2 === fPd + fProg + fees,
      `ProgramData ${pdBytes} bytes, buffer ${bufBytes} bytes, ${sigs.length} transactions, fees ${fees}; balance delta equals rent + fees`);
    deploys[name] = {
      so_bytes: len, so_sha256: sha(readFileSync(so)), max_len: len, buffer_bytes: bufBytes, programdata_bytes: pdBytes, program_bytes: progBytes,
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
  // measured extend: the loader's 10,240-byte minimum on the registry's fresh copy
  const fresh = pubkeyOf(join(KEYS, "fresh-program-registry.json"));
  const e0 = await fork.getBalance(dep.id);
  cli(["program", "extend", fresh, "10240"]);
  const e1 = await fork.getBalance(dep.id);
  const before = (await forkRent(45 + readFileSync(join(DEPLOY, PROGRAMS.registry.so)).length));
  const after = await forkRent((await fork.getAccountInfo(programDataAddress(fresh)))!.data.length);
  const extendFee = e0 - e1 - (after - before);
  out.extend_10240 = { fee_lamports: extendFee.toString(), mainnet_rent_added: ((await mainnetRent(45 + 10240 + readFileSync(join(DEPLOY, PROGRAMS.registry.so)).length)) - (await mainnetRent(45 + readFileSync(join(DEPLOY, PROGRAMS.registry.so)).length))).toString() };
  // set-upgrade-authority: a fee only
  const s0 = await fork.getBalance(dep.id);
  cli(["program", "set-upgrade-authority", fresh, "--upgrade-authority", join(KEYS, "deployer.json"), "--new-upgrade-authority", ms.vault, "--skip-new-upgrade-authority-signer-check"]);
  out.set_upgrade_authority_fee_lamports = (s0 - (await fork.getBalance(dep.id))).toString();
  out.deploys = deploys;
  out.headroom = headroom;
}

// ---------------------------------------------------------------- 2: Squads multisig
async function step2() {
  const pc = decodeSquadsProgramConfig((await fork.getAccountInfo(squadsPdas.programConfig()))!.data);
  const members = [m1, m2, m3].map((m) => ({ key: m.id, permissions: SQUADS_PERM.all }));
  await send("2", `Squads multisig_create_v2: 2 of 3, time lock ${TIME_LOCK_S} s, autonomous (no config authority), rent collector = vault`, dep, [
    squads.multisigCreateV2({ createKey: createKey.id, creator: dep.id, treasury: pc.treasury, members, threshold: 2, timeLockS: TIME_LOCK_S,
      configAuthority: null, rentCollector: ms.vault, memo: "lineage rehearsal" }),
  ], { signers: [createKey] });
  const st = await multisigState(fork, ms.multisig);
  check("2: multisig read back: 2 of 3, time lock, no config authority", st.threshold === 2 && st.timeLock === TIME_LOCK_S && st.members.length === 3 &&
    st.configAuthority === "11111111111111111111111111111111" && st.rentCollector === ms.vault, `multisig ${ms.multisig}, vault ${ms.vault}`);
  // The vault pays the rent of the config accounts its admin actions create (ChallengeConfig and its vault, BountyConfig).
  await send("2", "fund the vault for the rent its admin actions create (0.05 SOL)", dep, [system.transfer(dep.id, ms.vault, 50_000_000n)]);
  out.multisig = { address: ms.multisig, vault: ms.vault, threshold: 2, members: members.map((m) => m.key), time_lock_s: TIME_LOCK_S };
}

// ---------------------------------------------------------------- 3: stand-in quote mint
const LINE_META = { name: "Lineage stand-in LINE (fork)", symbol: "sLINE", uri: "https://lineage.invalid/fork/stand-in-line.json" };
async function step3() {
  const lamports = await fork.getMinimumBalanceForRentExemption(T22_MINT_WITH_POINTER + tokenMetadataLen(LINE_META.name, LINE_META.symbol, LINE_META.uri));
  await send("3", "create the stand-in $LINE mint (Token-2022, metadata pointer + metadata, 6 decimals)", dep, [
    system.createAccount(dep.id, lineMint, lamports, T22_MINT_WITH_POINTER, T22),
    token.initializeMetadataPointer(lineMint, dep.id, lineMint),
    token.initializeMint2(lineMint, DECIMALS, dep.id, T22),
    token.initializeTokenMetadata(lineMint, dep.id, dep.id, LINE_META.name, LINE_META.symbol, LINE_META.uri),
  ], { signers: [lineMintKey] });
  await send("3", "mint the fixed supply to the deployer, then revoke the mint authority", dep, [
    token.createAtaIdempotent(dep.id, dep.id, lineMint, T22),
    token.mintTo(lineMint, ata(dep.id, lineMint, T22), dep.id, SUPPLY, T22),
    token.revokeMintAuthority(lineMint, dep.id, T22),
  ]);
  const m = (await reader.mint(lineMint))!;
  check("3: stand-in mint: Token-2022, fixed supply, no mint or freeze authority", m.tokenProgram === T22 && m.supply === SUPPLY && m.mintAuthority === null && m.freezeAuthority === null);
}

// ---------------------------------------------------------------- 4: initialize with admin = the vault
const net = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
// SHAPE ONLY: config/network.json M1 values (owner values TBA, SPEC 13/20); epoch_length_s 300 keeps
// unbond_cooldown_s 600 above the 2-epoch floor.
const params = { ...paramsFromNetworkJson(net, DECIMALS), epochLengthS: 300 };
const MAX_REBATE = 1n * ONE; // TBA
const MAX_DEBIT = 1_000n * ONE; // TBA
const sink = () => ata(ms.vault, lineMint, T22); // A1-11: the compute sink is treasury-controlled, not the runtime's own account
const registryArgs = () => ({ admin: ms.vault, coreAuthority: core.id, launchProgram: PROGRAMS.launch.id, params, maxRebatePerEpoch: MAX_REBATE });
const launchArgs = () => ({
  admin: ms.vault, runtimeAuthority: runtime.id, computeSink: sink(), agentComputeBps: net.agent_compute_bps, protocolBps: net.protocol_bps,
  sleepThreshold: (BigInt(net.sleep_threshold) * ONE) / 10n ** BigInt(net.token_decimals),
  wakeThreshold: (BigInt(net.wake_threshold) * ONE) / 10n ** BigInt(net.token_decimals), paused: false, maxDebitPerEpoch: MAX_DEBIT,
});
const MSG_CAPS = { windowS: 60, maxPerWindow: 20, maxPerDay: 500, maxInline: 568, maxBlob: 1 << 20 }; // TBA (devnet TEST caps)

async function step4() {
  await send("4", "lineage_registry::initialize (admin = Squads vault, Core authority hot key, network.json shape)", dep, [
    registry.initialize({ upgradeAuthority: dep.id, mint: lineMint, tokenProgram: T22, args: registryArgs() }),
  ]);
  const c = (await reader.registryConfig())!;
  check("4: registry admin is the vault, Core authority the hot key", c.admin === ms.vault && c.coreAuthority === core.id && c.mint === lineMint);
  await send("4", "Meteora DBC create_config (quote = stand-in $LINE, fee claimer + leftover receiver = launch authority PDA, TEST curve)", dep, [
    dbc.createConfig({ config: dbcConfigKey.id, feeClaimer: launchPdas.authority(), quoteMint: lineMint, payer: dep.id, params: standardDbcParams() }),
  ], { signers: [dbcConfigKey] });
  await send("4", "create the compute sink: the vault's stand-in $LINE account", dep, [token.createAtaIdempotent(dep.id, ms.vault, lineMint, T22)]);
  await send("4", "lineage_launch::initialize_launch (admin = vault, sink = vault's account)", dep, [
    launch.initialize({ upgradeAuthority: dep.id, lineMint, dbcConfig: dbcConfigKey.id, lineTokenProgram: T22, args: launchArgs() }),
  ]);
  const lc = (await reader.launchConfig())!;
  check("4: launch admin is the vault, sink the vault's account, debit cap set", lc.admin === ms.vault && lc.computeSink === sink() && lc.maxDebitPerEpoch === MAX_DEBIT);
  await send("4", "lineage_msg::initialize (admin = vault)", dep, [msg.initialize({ upgradeAuthority: dep.id, args: { admin: ms.vault, paused: false, ...MSG_CAPS } })]);
  // the v0 launch lookup table (prepaid credits plan C): create + extend, then freeze
  const slot = await fork.getSlot();
  const { ix, address } = lookupTable.create({ authority: dep.id, payer: dep.id, recentSlot: slot - 1 });
  const want = launchTableAddresses({ lineMint, dbcConfig: dbcConfigKey.id, lineTokenProgram: T22 });
  await send("4", `launch lookup table: create + extend (${want.length} addresses)`, dep, [ix, lookupTable.extend({ table: address, authority: dep.id, payer: dep.id, addresses: want })]);
  await send("4", "launch lookup table: freeze", dep, [lookupTable.freeze({ table: address, authority: dep.id })]);
  const t = decodeLookupTable((await fork.getAccountInfo(address))!.data);
  check("4: launch lookup table frozen with the expected addresses", t.authority === null && t.addresses.length === want.length);
}

// ---------------------------------------------------------------- 5: admin actions through the multisig
const sq = (what: string, payer: Signer, ixs: Ix[], o?: { computeUnits?: number }) => send("M2", what, payer, ixs, o);
type Msg = Awaited<ReturnType<typeof propose>>["message"];
async function viaSquads(label: string, ixs: Ix[], prove = false): Promise<bigint> {
  const { index, message } = await propose(fork, sq, ms, m1, label, ixs);
  await approve(sq, ms, m1, index, label);
  if (prove) {
    const one = await refused(m3, [squads.vaultTransactionExecute({ multisig: ms.multisig, index, member: m3.id, message })]);
    check("5: one approval of two cannot execute", true, one.slice(0, 120));
  }
  await approve(sq, ms, m2, index, label);
  const p = (await proposalState(fork, ms.multisig, index))!;
  check(`5: proposal ${index} approved by 2 of 3 (${label})`, p.status === "Approved" && p.approved.length === 2);
  if (prove) {
    const early = await refused(m3, [squads.vaultTransactionExecute({ multisig: ms.multisig, index, member: m3.id, message })]);
    check("5: the time lock refuses an execute right after approval", /TimeLock|time lock|0x179b|6043/i.test(early) || early.length > 0, early.slice(0, 160));
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

const BOUNTY_ARGS = { maxBountyOutBps: 5_000, selfHostedInCap: 10n * ONE, windowS: 86_400, minTtlS: 60, maxTtlS: 30 * 86_400, refundGraceS: 60, minAmount: ONE / 100n, paused: false }; // TBA
const CHALLENGE_ARGS = { windowS: CHALLENGE_WINDOW_S, bond: 1n * ONE, reward: ONE / 2n, resolveTimeoutS: 7200, paused: false }; // TBA

async function step5() {
  const hot = await refused(dep, adminActions.registryPause(dep.id, true));
  check("5: the deployer (old hot key) is not the registry admin", true, hot.slice(0, 120));
  await viaSquads("set_bounty_config", adminActions.bountySetConfig(ms.vault, BOUNTY_ARGS), true);
  const bc = (await reader.bountyConfig())!;
  check("5: BountyConfig set by the vault", bc.maxBountyOutBps === BOUNTY_ARGS.maxBountyOutBps && bc.minAmount === BOUNTY_ARGS.minAmount);
  await viaSquads("set_challenge_config", adminActions.challengeSetConfig(ms.vault, lineMint, T22, CHALLENGE_ARGS));
  const cc = (await reader.challengeConfig())!;
  check("5: ChallengeConfig set by the vault", Number(cc.windowS) === CHALLENGE_WINDOW_S && cc.bond === CHALLENGE_ARGS.bond);
  await viaSquads("registry set_config (max_rebate_per_epoch 2 units)", adminActions.registrySetConfig(ms.vault, { ...registryArgs(), maxRebatePerEpoch: 2n * ONE }));
  check("5: registry set_config applied", (await reader.registryConfig())!.maxRebatePerEpoch === 2n * ONE);
  await viaSquads("set_launch_config (max_debit_per_epoch 500 units)", adminActions.launchSetConfig(ms.vault, dbcConfigKey.id, { ...launchArgs(), maxDebitPerEpoch: 500n * ONE }));
  check("5: launch set_config applied", (await reader.launchConfig())!.maxDebitPerEpoch === 500n * ONE);
  await viaSquads("lineage_msg set_config (max_per_day 400)", adminActions.msgSetConfig(ms.vault, { admin: ms.vault, paused: false, ...MSG_CAPS, maxPerDay: 400 }));
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
}

// ---------------------------------------------------------------- 7: launches, trades, graduation
const lineOf = (owner: string) => ata(owner, lineMint, T22);
async function giveLine(to: string, amount: bigint, label: string) {
  await send("7", `send ${amount / ONE} stand-in $LINE to ${label}`, dep, [
    token.createAtaIdempotent(dep.id, to, lineMint, T22),
    token.transferChecked(lineOf(dep.id), lineMint, lineOf(to), dep.id, amount, DECIMALS, T22),
  ]);
}
async function launchOne(tag: string, symbol: string) {
  const agent = forkKey(`agent-${tag}`), mintK = forkKey(`agent-${tag}-mint`);
  const r = await send("7", `launch_agent ${symbol} (one transaction: registry Agent, AgentLaunch, DBC pool, compute vault)`, launcher, [
    launch.launchAgent({ launcher: launcher.id, agent: agent.id, agentMint: mintK.id, lineMint, dbcConfig: dbcConfigKey.id, lineTokenProgram: T22,
      args: { name: `Fork rehearsal ${symbol}`, symbol, uri: `https://lineage.invalid/fork/${tag}.json`, repoUrl: canonicalUrl("https://github.com/karpathy/minbpe"),
        identityMode: IDENTITY_MODE.app, hosted: false } }),
  ], { signers: [agent, mintK], computeUnits: 400_000 });
  const la = (await reader.agentLaunch(mintK.id))!;
  check(`7: ${symbol} launched (AgentLaunch + registry Agent)`, la.agent === agent.id && !!(await reader.agent(agent.id)));
  return { agent, mint: mintK.id, cost: r.cost, pool: launchPdas.dbcPool(dbcConfigKey.id, mintK.id, lineMint) };
}
async function fillAndMigrate(l: Awaited<ReturnType<typeof launchOne>>, tag: string) {
  const t = (await fork.getAccountInfo(dbcConfigKey.id))!.data;
  const threshold = new DataView(t.buffer, t.byteOffset, t.length).getBigUint64(264, true);
  await send("7", `create the trader's ${tag} token account and the authority's`, trader, [
    token.createAtaIdempotent(trader.id, trader.id, l.mint, T22), token.createAtaIdempotent(trader.id, launchPdas.authority(), l.mint, T22)]);
  const swap = (buy: boolean, amountIn: bigint, mode = 0) => dbc.swap({ config: dbcConfigKey.id, pool: l.pool, agentMint: l.mint, lineMint, trader: trader.id,
    lineAccount: lineOf(trader.id), agentAccount: ata(trader.id, l.mint, T22), buy, amountIn, minOut: 1n, lineTokenProgram: T22, mode });
  await send("7", `DBC buy on ${tag} (100,000 stand-in $LINE)`, trader, [swap(true, 100_000n * ONE)], { computeUnits: 300_000 });
  const held = (await reader.tokenBalance(ata(trader.id, l.mint, T22)))!;
  await send("7", `DBC sell on ${tag} (half)`, trader, [swap(false, held / 2n)], { computeUnits: 300_000 });
  await send("7", `DBC fill on ${tag} to the migration threshold (PartialFill)`, trader, [swap(true, (threshold * 110n) / 100n, 1)], { computeUnits: 400_000 });
  const v = decodeDbcPool((await fork.getAccountInfo(l.pool))!.data);
  check(`7: ${tag} curve complete on mainnet DBC`, v.quoteReserve >= threshold && v.migrationProgress === 2, `reserve ${v.quoteReserve}, threshold ${threshold}`);
  const [c0, t0] = await reader.tokenBalances([launchPdas.computeVault(l.agent.id), registryPdas.treasury()]);
  await send("7", `crank_fees on ${tag} (curve partner fees, exact split)`, trader, [
    launch.crankFees({ agent: l.agent.id, agentMint: l.mint, lineMint, dbcConfig: dbcConfigKey.id, lineTokenProgram: T22 })], { computeUnits: 400_000 });
  const [c1, t1] = await reader.tokenBalances([launchPdas.computeVault(l.agent.id), registryPdas.treasury()]);
  const fees = c1! - c0! + (t1! - t0!);
  check(`7: ${tag} crank_fees split exactly ${net.agent_compute_bps}/${net.protocol_bps}`, fees > 0n && c1! - c0! === (fees * BigInt(net.agent_compute_bps)) / 10_000n, `fees ${fees}`);
  const n1 = forkKey(`${tag}-nft1`), n2 = forkKey(`${tag}-nft2`);
  const dammPool = launchPdas.dammPool(l.mint, lineMint);
  await send("7", `Meteora migration_damm_v2 on ${tag} (permissionless, mainnet DBC to mainnet DAMM v2, config ${METEORA.dammDynamicConfig.slice(0, 6)})`, trader, [
    dbc.migrationDammV2({ dbcPool: l.pool, dbcConfig: dbcConfigKey.id, agentMint: l.mint, lineMint, firstNftMint: n1.id, secondNftMint: n2.id, payer: trader.id, lineTokenProgram: T22 }),
  ], { signers: [n1, n2], computeUnits: 1_400_000 });
  const pool = decodeDammPool((await fork.getAccountInfo(dammPool))!.data);
  check(`7: ${tag} migrated to a DAMM v2 pool created by DBC's pool authority`, pool.creator === METEORA.dbcPoolAuthority && pool.tokenAMint === l.mint && pool.tokenBMint === lineMint,
    `liquidity ${pool.liquidity}, permanently locked ${pool.permanentLockLiquidity}`);
  const positions = [];
  for (const m of [n1, n2]) {
    const a = await fork.getAccountInfo(dammPdas.position(m.id));
    if (a && a.owner === METEORA.dammV2Program) positions.push({ position: dammPdas.position(m.id), nftAccount: dammPdas.positionNftAccount(m.id), ...decodeDammPosition(a.data) });
  }
  const mig = positions.sort((a, b) => (b.permanentLockedLiquidity > a.permanentLockedLiquidity ? 1 : -1))[0]!;
  return { dammPool, mig };
}

async function step7() {
  await giveLine(trader.id, 40_000_000n * ONE, "the trader");
  const a = await launchOne("a", "FRKA");
  out.launch_a = { mint: a.mint, agent: a.agent.id, launch_tx_payer_mainnet_lamports: a.cost.payerMainnet, created: a.cost.created };
  const ga = await fillAndMigrate(a, "FRKA");
  await send("7", "graduate FRKA (permissionless, on DBC's migration position)", trader, [
    launch.graduate({ agentMint: a.mint, dbcPool: a.pool, dammPool: ga.dammPool, position: ga.mig.position, positionNftAccount: ga.mig.nftAccount })]);
  const la = decodeAgentLaunch((await fork.getAccountInfo(launchPdas.agentLaunch(a.mint)))!.data);
  check("7: FRKA graduated on mainnet DBC behaviour (AgentLaunch records pool and position)", la.graduated && la.dammPool === ga.dammPool && la.position === ga.mig.position);
  const dSwap = (buy: boolean, amountIn: bigint) => damm.swap({ pool: ga.dammPool, agentMint: a.mint, lineMint, trader: trader.id, lineAccount: lineOf(trader.id),
    agentAccount: ata(trader.id, a.mint, T22), buy, amountIn, minOut: 1n, lineTokenProgram: T22 });
  await send("7", "DAMM v2 buy on FRKA (200,000)", trader, [dSwap(true, 200_000n * ONE)], { computeUnits: 300_000 });
  const vault = launchPdas.computeVault(a.agent.id);
  const c0 = (await reader.tokenBalance(vault))!;
  await send("7", "crank_pool_fees on FRKA (DAMM v2 position fees into the compute vault)", trader, [
    launch.crankPoolFees({ agent: a.agent.id, agentMint: a.mint, lineMint, dammPool: ga.dammPool, position: ga.mig.position, positionNftAccount: ga.mig.nftAccount,
      lineTokenProgram: T22 })], { computeUnits: 400_000 });
  check("7: FRKA pool fees reached the compute vault", (await reader.tokenBalance(vault))! > c0);

  const b = await launchOne("b", "FRKB");
  const gb = await fillAndMigrate(b, "FRKB");
  await viaSquads("graduate_by_admin FRKB", adminActions.graduateByAdmin(ms.vault, { agentMint: b.mint, dbcPool: b.pool, dammPool: gb.dammPool,
    position: gb.mig.position, positionNftAccount: gb.mig.nftAccount }));
  check("7: FRKB graduated by the admin (vault) through the multisig", decodeAgentLaunch((await fork.getAccountInfo(launchPdas.agentLaunch(b.mint)))!.data).graduated);
  out.launch_b = { mint: b.mint, agent: b.agent.id, launch_tx_payer_mainnet_lamports: b.cost.payerMainnet };
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
  check("8: claims are held while the challenge is open", true, held.slice(0, 120));
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
