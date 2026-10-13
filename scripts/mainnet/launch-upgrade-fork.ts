#!/usr/bin/env bun
// The upgrade of the OFFICIAL units_launch to the build with agent pools and GitHub fee claims, rehearsed
// on a local fork of mainnet that holds the live accounts as they are (docs/MAINNET-RUNBOOK.md "Launch
// program upgrade: pools and claims"). Nothing is sent to mainnet and no real key is read: mainnet is
// read (accounts, rent), every transaction goes to 127.0.0.1:9690.
//
// What the fork holds: the launch program and its ProgramData exactly as deployed (685,224 bytes of code),
// every account the launch, registry and message programs own, the three launched agents' coins, curves,
// vaults and fee accounts, $UNITS with its PumpSwap pool, the frozen launch lookup table, pump.fun.
// THREE fields are replaced by throwaway keys, because the real keys are not used here: the ProgramData's
// upgrade authority and LaunchConfig.admin (both the dev wallet on mainnet; one stand-in key here) and
// LaunchConfig.runtime_authority (the hosted runtime's key on the server). Every other byte is mainnet's.
//
//   D=<empty dir outside the repo>; mkdir -p $D/keys $D/ledger
//   MAINNET_FORK_KEYS=$D/keys bun scripts/mainnet/launch-upgrade-fork.ts --prepare $D     # reads mainnet, writes $D/accounts, prints the validator arguments
//   scripts/mainnet/fork.sh $D/ledger $(cat $D/fork-args) &
//   MAINNET_FORK_KEYS=$D/keys LAUNCH_UPGRADE_FORK_DIR=$D UNITS_NETWORK=mainnet bun scripts/mainnet/launch-upgrade-fork.ts
//   kill <the validator's PID, after checking what it is>
//
// The run, in order: 0 the fork equals mainnet; 1 the upgrade with the runbook's own commands (write-buffer,
// interrupted once and resumed, extend, upgrade), each cost at mainnet rent; 2 every account unchanged and
// decodable; 3 today's flows with the bits off (the committed fee crank keeper on the three live agents,
// usage post and debit, a launch through the wizard's builders with the SOL purchase on the pool, the
// runtime binding); 4 the admin steps with scripts/mainnet/launch-features.ts; 5 routes, a pool, routed
// cranks, a settlement, buys, a claim; 6 what a client that predates the features does; 7 the bits off
// again. Writes scripts/mainnet/LAUNCH-UPGRADE-FORK-LAST.json.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalUrl, generateAgentKey, H, merkleRoot, repoId as repoIdOf } from "@units/protocol";
import {
  addressBytes, ata, ChainReader, claimMessage, claimPdas, claims, compileMessageV0, computeBudget, crankSplit, decodeAgent, decodeAgentLaunch, decodeBondingCurve, decodeBountyConfig, decodeClaimConfig,
  decodeClaimEscrow, decodeConfig, decodeDebitReceipt, decodeFeeRoute, decodeLaunchConfig, decodeLoaderAuthority, decodeLookupTable, decodeMint, decodePool, decodePoolConfig, decodePoolMember,
  decodePumpFeeConfig, decodePumpGlobal, decodePumpPool, decodeTokenAccount, decodeUsageEpoch, ed25519Ix, FEATURES, IDENTITY_MODE, initialBuyAmount, JITO_MAX_TXS, launch, launchPdas,
  launchTableAddresses, launchTempWsol, launchTxUnits, loadKeypair, maxBuyInput, maxSolIn, moveLaunchHolding, parsePrepayConfig, planLaunchBundle, poolPdas, poolRates, pools, programDataAddress, pump,
  PUMP, pumpCrankIxs, pumpInitialBuy, pumpLaunchMain, pumpPdas, pumpQuotedCurve, pumpSolToLinePool, quoteInitialBuy, quotePoolBuyExactOut, registry, registryPdas, rentLamports, requiredCredits,
  settlementAllocation, signBytes, signMessageWith, system, token, TOKEN_2022_PROGRAM, TOKEN_ACCOUNT_LEN, usageLeaf, wireSize, type AccountMeta, type BundleGroup, type Ix, type LookupTable, type Signer,
} from "@units/chain";
import { programIdsNow, useActiveProfile } from "./steps.ts";

const ROOT = join(import.meta.dir, "..", "..");
const STATE = JSON.parse(readFileSync(join(ROOT, "config/mainnet/state.json"), "utf8"));
const LINE = STATE.line_mint as string, POOL = STATE.line_pool as { pool: string; baseVault: string; quoteVault: string }, TABLE = STATE.launch_lookup_table as string;
const T22 = TOKEN_2022_PROGRAM, ONE = 1_000_000n;
useActiveProfile({ ...process.env, UNITS_NETWORK: "mainnet" });
const IDS = programIdsNow();
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const OLD_BUILD = join(ROOT, "onchain/target/mainnet/units_launch.so"), NEW_BUILD = join(ROOT, "onchain/target/pools-mainnet/units_launch.so");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const j = (o: unknown) => JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v));
const argv = process.argv.slice(2);
const DISC = (n: string) => createHash("sha256").update(`account:${n}`).digest().subarray(0, 8).toString("hex");
const LAUNCH_TYPES = new Map(["LaunchConfig", "AgentLaunch", "UsageEpoch", "DebitReceipt", "BountyConfig", "Bounty", "BountyLedger", "BountyReceipt", "ClaimConfig", "FeeRoute", "ClaimEscrow", "PoolConfig", "Pool",
  "PoolMember", "CrossHolding"].map((n) => [DISC(n), n]));
const typeOf = (d: Uint8Array) => LAUNCH_TYPES.get(Buffer.from(d.subarray(0, 8)).toString("hex")) ?? "unknown";

// ================================================================ --prepare: read mainnet, write the fork's accounts
if (argv[0] === "--prepare") {
  const DIR = argv[1];
  if (!DIR || !existsSync(DIR)) throw new Error("usage: --prepare <existing empty directory outside the repo>");
  const { mainnet, forkKey } = await import("./lib.ts");
  const dev = forkKey("dev-wallet-stand-in"), runtime = forkKey("runtime-stand-in");
  const forkSh = readFileSync(join(import.meta.dir, "fork.sh"), "utf8");
  const k = () => generateAgentKey().id;
  // what the launch through the wizard names (the pool purchase lane's own list)
  const pl = spawnSync("bun", [join(import.meta.dir, "pool-launch-fork.ts"), "--fork-args"], { encoding: "utf8", env: { ...process.env, UNITS_NETWORK: "mainnet" } });
  if (pl.status !== 0) throw new Error(`pool-launch-fork.ts --fork-args failed: ${pl.stderr.slice(-400)}`);
  const want = new Set(pl.stdout.trim().split(/\s+/).filter((t) => t && !t.startsWith("--")));
  // every account the three units programs own
  const owned = { launch: await mainnet.getProgramAccounts(IDS.launch), registry: await mainnet.getProgramAccounts(IDS.registry), msg: await mainnet.getProgramAccounts(IDS.msg) };
  for (const a of [...owned.launch, ...owned.registry, ...owned.msg]) want.add(a.address);
  const lc = decodeLaunchConfig(owned.launch.find((a) => typeOf(a.data) === "LaunchConfig")!.data);
  const agents = owned.launch.filter((a) => typeOf(a.data) === "AgentLaunch").map((a) => decodeAgentLaunch(a.data));
  // every account a trade, a crank, a debit, a route, a pool purchase of a live agent names
  const u = k();
  const ixs: Ix[] = [];
  for (const a of agents) {
    ixs.push(token.createAtaIdempotent(u, u, a.mint, T22), pump.buyExactQuoteInV3({ mint: a.mint, quoteMint: LINE, quoteTokenProgram: T22, user: u, spendableQuoteIn: 1n, minTokensOut: 1n }),
      ...pumpCrankIxs({ payer: u, agent: a.agent, agentMint: a.mint, lineMint: LINE, lineTokenProgram: T22 }), launch.refreshAwake({ agent: a.agent, agentMint: a.mint }),
      launch.debitCompute({ runtimeAuthority: u, epoch: 0, agent: a.agent, agentMint: a.mint, computeSink: lc.computeSink, lineMint: LINE, amount: 1n, modelTokens: 0, sandboxS: 0, proof: [], lineTokenProgram: T22 }),
      pools.poolBuy({ keeper: u, repoId: a.repoId, target: a.agent, targetMint: a.mint, lineMint: LINE, kind: 1, venue: 0, tokenAmount: 1n, maxQuote: 1n }));
    want.add(ata(a.agent, a.mint, T22));
    want.add(a.launcher);
  }
  for (const ix of ixs) { want.add(ix.programId); for (const m of ix.keys) want.add(m.pubkey); }
  for (const a of [TABLE, LINE, POOL.pool, POOL.baseVault, POOL.quoteVault, ...launchTableAddresses({ lineMint: LINE, lineTokenProgram: T22, linePool: POOL }), PUMP.ammFeeConfig, PUMP.ammGlobalConfig, PUMP.wsol,
    lc.computeSink, registryPdas.treasury(), programDataAddress(IDS.launch), IDS.registry, IDS.msg]) want.add(a);
  const BUILTIN = /^(11111111111111111111111111111111|ComputeBudget111111111111111111111111111111|TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA|ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL|AddressLookupTab1e1111111111111111111111111|Ed25519SigVerify111111111111111111111111111|Sysvar.*)$/;
  const keys = [...want].filter((a) => a !== u && !forkSh.includes(a) && !BUILTIN.test(a));
  const infos = await mainnet.getMultipleAccounts(keys);
  const slot = await mainnet.getSlot();
  const accDir = join(DIR, "accounts");
  rmSync(accDir, { recursive: true, force: true });
  mkdirSync(accDir, { recursive: true });
  const args: string[] = [], live: Record<string, { owner: string; bytes: number; lamports: string; sha256: string; type?: string }> = {}, patched: Record<string, string> = {};
  const write = (address: string, a: { lamports: bigint; owner: string; executable: boolean; data: Uint8Array }) =>
    writeFileSync(join(accDir, `${address}.json`), JSON.stringify({ pubkey: address, account: { lamports: Number(a.lamports), data: [Buffer.from(a.data).toString("base64"), "base64"], owner: a.owner, executable: a.executable,
      rentEpoch: "RENT_EPOCH", space: a.data.length } }).replace('"RENT_EPOCH"', "18446744073709551615"));
  keys.forEach((address, i) => {
    const a = infos[i];
    if (!a) return;
    if (a.executable && a.owner === LOADER && address !== IDS.launch) { args.push("--clone-upgradeable-program", address); return; }
    if (a.executable && address !== IDS.launch) { args.push("--clone", address); return; }
    let data = a.data;
    if (address === programDataAddress(IDS.launch)) {
      if (decodeLoaderAuthority(data) !== lc.admin) throw new Error("the live upgrade authority is not the launch admin: this rehearsal assumes one key holds both");
      data = new Uint8Array(data);
      data.set(addressBytes(dev.id), 13);
      patched[address] = "ProgramData: upgrade authority (bytes 13 to 44) replaced by the stand-in key";
    }
    if (address === launchPdas.config()) {
      data = new Uint8Array(data);
      data.set(addressBytes(dev.id), 8);
      data.set(addressBytes(runtime.id), 40);
      patched[address] = "LaunchConfig: admin (bytes 8 to 39) and runtime_authority (bytes 40 to 71) replaced by stand-in keys";
    }
    live[address] = { owner: a.owner, bytes: a.data.length, lamports: a.lamports.toString(), sha256: sha(a.data), ...(a.owner === IDS.launch ? { type: typeOf(a.data) } : {}) };
    write(address, { ...a, data });
  });
  args.push("--account-dir", accDir, "--warp-slot", String(slot));
  writeFileSync(join(DIR, "fork-args"), args.join(" ") + "\n");
  writeFileSync(join(DIR, "prepare.json"), JSON.stringify({ at: new Date().toISOString(), mainnet_slot: slot, real_admin: lc.admin, real_runtime_authority: lc.runtimeAuthority, stand_in_admin: dev.id, stand_in_runtime: runtime.id,
    agents: agents.map((a) => ({ agent: a.agent, mint: a.mint, launcher: a.launcher, repo_url: a.repoUrl })), patched, live, cloned_programs: args.filter((_, i) => args[i - 1] === "--clone-upgradeable-program") }, null, 1));
  console.log(`[prepare] ${Object.keys(live).length} accounts written to ${accDir} (${owned.launch.length} of the launch program, ${owned.registry.length} of the registry, ${owned.msg.length} of messages), mainnet slot ${slot}; validator arguments in ${join(DIR, "fork-args")}`);
  process.exit(0);
}

// ================================================================ the rehearsal
const DIR = process.env.LAUNCH_UPGRADE_FORK_DIR ?? "";
if (!DIR || !existsSync(join(DIR, "prepare.json"))) throw new Error("set LAUNCH_UPGRADE_FORK_DIR to the directory --prepare filled");
const PREP = JSON.parse(readFileSync(join(DIR, "prepare.json"), "utf8")) as { mainnet_slot: number; real_admin: string; real_runtime_authority: string; agents: { agent: string; mint: string; launcher: string; repo_url: string }[];
  patched: Record<string, string>; live: Record<string, { owner: string; bytes: number; lamports: string; sha256: string; type?: string }> };
const { airdrop, assertFork, check: check0, checks, fork, FORK_URL, forkKey, forkNow, KEYS, log, mainnet, mainnetRent, forkRent, measure, rows, send, sendV0, sleep, sol } = await import("./lib.ts");
await assertFork();
const reader = new ChainReader(fork);
const OUT_FILE = join(import.meta.dir, "LAUNCH-UPGRADE-FORK-LAST.json");
const sections: Record<string, { passed: number; total: number }> = {};
let section = "0";
// a failed check is recorded and the run goes on, so one failure does not hide the rest
const check = (name: string, ok: boolean, detail = "") => {
  const s = (sections[section] ??= { passed: 0, total: 0 });
  s.total++;
  if (ok) s.passed++;
  try { check0(`${section}: ${name}`, ok, detail); } catch { /* recorded in `checks` */ }
};
const out: Record<string, any> = { started: new Date().toISOString(), fork: FORK_URL, program: IDS.launch, program_data: programDataAddress(IDS.launch), mainnet_slot_of_the_copy: PREP.mainnet_slot,
  replaced_on_the_fork: PREP.patched, live_agents: PREP.agents };
const dev = forkKey("dev-wallet-stand-in"), runtime = forkKey("runtime-stand-in"), keeper = forkKey("pool-keeper"), attestor = forkKey("claim-attestor"), trader = forkKey("trader"), claimer = forkKey("claimer"),
  cranker = forkKey("cranker"), stranger = forkKey("stranger");
const keyPath = (n: string) => join(KEYS, `${n}.json`);
const acct = async <T>(a: string, d: (b: Uint8Array) => T): Promise<T> => d((await fork.getAccountInfo(a))!.data);
const bal = async (a: string) => { const i = await fork.getAccountInfo(a); return i ? decodeTokenAccount(i.data).amount : 0n; };
const tableAcc = await fork.getAccountInfo(TABLE);
if (!tableAcc) throw new Error("the launch lookup table is not on the fork");
const table: LookupTable = { address: TABLE, addresses: decodeLookupTable(tableAcc.data).addresses };
const sizes: Record<string, { bytes: number; cu: number | undefined; payer_mainnet_lamports: string; created_bytes: number[] }> = {};
async function tx(name: string, payer: Signer, ixs: Ix[], signers: Signer[] = [], cu = 600_000) {
  const r = await sendV0(section, name, payer, ixs, [table], { signers, computeUnits: cu });
  sizes[name] = { bytes: r.size, cu: r.computeUnits, payer_mainnet_lamports: r.cost.payerMainnet, created_bytes: r.cost.created.map((c) => c.bytes) };
  return r;
}
/** Simulates a v0 transaction; returns its error and logs as text, or "" when it would pass. */
async function simulated(payer: Signer, ixs: Ix[], signers: Signer[] = []): Promise<string> {
  const { blockhash } = await fork.getLatestBlockhash();
  const m = compileMessageV0(payer.id, [computeBudget.limit(600_000), ...ixs], blockhash, [table]);
  const sim = await fork.simulate(signMessageWith(m, [payer, ...signers]).wire);
  return sim.err ? `${JSON.stringify(sim.err)} ${(sim.logs ?? []).join(" ")}` : "";
}
const refusedWith = async (payer: Signer, ixs: Ix[], what: string, signers: Signer[] = []) => (await simulated(payer, ixs, signers)).includes(what);
const cli = (args: string[], o: { env?: Record<string, string> } = {}) => {
  const r = spawnSync(args[0]!, args.slice(1), { encoding: "utf8", cwd: ROOT, env: { ...process.env, ...(o.env ?? {}) } });
  return { status: r.status, text: `${r.stdout}${r.stderr}`.trim() };
};
const programData = async () => {
  const a = (await fork.getAccountInfo(programDataAddress(IDS.launch)))!;
  const code = a.data.subarray(45);
  /** The deployed code is exactly `build` (followed by nothing but zero padding). */
  const is = (build: Uint8Array) => code.length >= build.length && Buffer.compare(code.subarray(0, build.length), build) === 0 && code.subarray(build.length).every((b) => b === 0);
  return { lamports: a.lamports, bytes: a.data.length, authority: decodeLoaderAuthority(a.data), slot: Number(new DataView(a.data.buffer, a.data.byteOffset + 4, 8).getBigUint64(0, true)), code, is };
};
const launchAccounts = async () => new Map((await fork.getProgramAccounts(IDS.launch)).map((a) => [a.address, a]));
const decodeAny = (d: Uint8Array): unknown => {
  const t = typeOf(d);
  if (t === "LaunchConfig") return decodeLaunchConfig(d);
  if (t === "AgentLaunch") return decodeAgentLaunch(d);
  if (t === "UsageEpoch") return decodeUsageEpoch(d);
  if (t === "DebitReceipt") return decodeDebitReceipt(d);
  if (t === "BountyConfig") return decodeBountyConfig(d);
  if (t === "ClaimConfig") return decodeClaimConfig(d);
  if (t === "PoolConfig") return decodePoolConfig(d);
  if (t === "FeeRoute") return decodeFeeRoute(d);
  if (t === "ClaimEscrow") return decodeClaimEscrow(d);
  if (t === "Pool") return decodePool(d);
  if (t === "PoolMember") return decodePoolMember(d);
  throw new Error(`no decoder for ${t}`);
};

/** The launch transaction (create_v2 + register_pump_launch) of fixed throwaway keys, simulated: its compute units and the launch program's own share. */
const simLauncher = forkKey("sim-launcher"), simAgent = forkKey("sim-agent"), simMint = forkKey("sim-mint");
async function launchSim() {
  const { blockhash } = await fork.getLatestBlockhash();
  const ixs = [computeBudget.limit(1_400_000), ...pumpLaunchMain({ launcher: simLauncher.id, agent: simAgent.id, agentMint: simMint.id, line: { mint: LINE, tokenProgram: T22, pool: POOL }, name: "Sim", symbol: "SIM",
    uri: `https://app.units.gg/coin/${simMint.id}.json`, args: { repoUrl: canonicalUrl("https://github.com/karpathy/minbpe"), identityMode: IDENTITY_MODE.token, hosted: true } })];
  const sim = await fork.simulate(signMessageWith(compileMessageV0(simLauncher.id, ixs, blockhash, [table]), [simLauncher, simAgent, simMint]).wire);
  const own = (sim.logs ?? []).filter((l) => l.startsWith(`Program ${IDS.launch} consumed`)).map((l) => Number(/consumed (\d+)/.exec(l)![1]));
  return { err: sim.err ? JSON.stringify(sim.err) : null, units: sim.unitsConsumed ?? 0, register_pump_launch_units: own.at(-1) ?? 0 };
}

let outcome = "PASS";
const oldBuild = new Uint8Array(readFileSync(OLD_BUILD)), newBuild = new Uint8Array(readFileSync(NEW_BUILD));
out.builds = { live: { file: "onchain/target/mainnet/units_launch.so", bytes: oldBuild.length, sha256: sha(oldBuild) }, upgrade: { file: "onchain/target/pools-mainnet/units_launch.so", bytes: newBuild.length, sha256: sha(newBuild) } };
try {
  for (const k of [dev, runtime, keeper, trader, claimer, cranker, stranger, simLauncher]) await airdrop(k.id, 100_000_000_000n);
  // the CLI funds a buffer with the rent of the ProgramData it will become (45 + the build's bytes), not of the buffer's own 37 + bytes
  const mainRent = { programDataOld: await mainnetRent(45 + oldBuild.length), programDataNew: await mainnetRent(45 + newBuild.length), buffer: await mainnetRent(45 + newBuild.length) };

  // ---------------------------------------------------------------- 0 the fork is mainnet
  section = "0 fork";
  // a fork that has just started: wait until the cloned program answers (a permissionless instruction of a live agent simulates)
  for (let i = 0; i < 60; i++) { if (!(await simulated(cranker, [launch.refreshAwake({ agent: PREP.agents[0]!.agent, agentMint: PREP.agents[0]!.mint })]))) break; await sleep(1000); }
  const before = await launchAccounts();
  {
    const pd = await programData();
    check("the launch program on the fork is the code deployed on mainnet, which is the build from before pools and claims", pd.is(oldBuild) && pd.code.length === oldBuild.length,
      `${pd.code.length} bytes, sha256 ${sha(pd.code)}; ProgramData ${pd.bytes} bytes holding ${sol(pd.lamports)} SOL`);
    check("its upgrade authority on the fork is the stand-in for the dev wallet", pd.authority === dev.id, `${dev.id} in place of ${PREP.real_admin}`);
    const mine = Object.entries(PREP.live).filter(([, v]) => v.owner === IDS.launch);
    const same = mine.filter(([a, v]) => before.has(a) && (sha(before.get(a)!.data) === v.sha256 || !!PREP.patched[a]) && before.get(a)!.lamports.toString() === v.lamports);
    check("every account the launch program owns on mainnet is on the fork with its bytes and balance (LaunchConfig apart from the two replaced keys)", same.length === mine.length && before.size === mine.length,
      `${mine.length} accounts: ${[...new Set(mine.map(([, v]) => v.type))].map((t) => `${mine.filter(([, v]) => v.type === t).length} ${t}`).join(", ")}`);
    const cfgLive = Buffer.from((await mainnet.getAccountInfo(launchPdas.config()))!.data), cfgFork = Buffer.from(before.get(launchPdas.config())!.data);
    check("LaunchConfig on the fork differs from mainnet's now in bytes 8 to 71 only (admin, runtime authority) or in what the runtime posted since the copy", cfgLive.subarray(0, 8).equals(cfgFork.subarray(0, 8))
      && cfgLive.subarray(72, 279).equals(cfgFork.subarray(72, 279)), "bytes 72 to 278 equal (the fee split, thresholds, the 16 reserved bytes, pause, bumps); the usage counters after them move with every epoch the runtime posts");
    const lc = decodeLaunchConfig(cfgFork);
    check("the 16 bytes that become `features` + reserved are zero in the live LaunchConfig, and the 32 that become `routes` + reserved are zero in every live AgentLaunch", lc.features === 0
      && cfgFork.subarray(260, 276).every((b) => b === 0) && [...before.values()].filter((a) => typeOf(a.data) === "AgentLaunch").every((a) => {
        const l = decodeAgentLaunch(a.data), at = 8 + 32 * 4 + 4 + new TextEncoder().encode(l.repoUrl).length + 2 + 32 * 4;
        return a.data.subarray(at, at + 32).every((b) => b === 0);
      }));
    const noSuch = await simulated(dev, [claims.setFeatures({ admin: dev.id, features: 3 })]);
    check("before the upgrade the program refuses set_features (the instruction does not exist)", noSuch.includes("InstructionFallbackNotFound"), noSuch.slice(0, 160));
    out.launch_compute_before = await launchSim();
    out.before = { program_data_bytes: pd.bytes, program_data_lamports: pd.lamports.toString(), last_deployed_slot: pd.slot, launch_accounts: [...before.values()].map((a) => ({ address: a.address, type: typeOf(a.data), bytes: a.data.length })) };
  }

  // ---------------------------------------------------------------- 1 the upgrade, with the runbook's commands
  section = "1 upgrade";
  const run = (Date.now() % 1_000_000).toString(36);
  const buffer = forkKey(`buffer-${run}`);
  const U = ["-u", FORK_URL, "-k", keyPath("dev-wallet-stand-in"), "--commitment", "confirmed"];
  const steps: Record<string, any>[] = [];
  const step = async (name: string, command: string, f: () => Promise<{ text: string; ok: boolean }>) => {
    const b0 = await fork.getBalance(dev.id), t0 = Date.now();
    const r = await f();
    const delta = b0 - (await fork.getBalance(dev.id));
    const s = { step: name, command, seconds: Math.round((Date.now() - t0) / 100) / 10, ok: r.ok, fork_balance_delta_lamports: delta.toString(), output: r.text.split("\n").slice(-4).map((l) => l.slice(0, 300)) };
    steps.push(s);
    log(`${section}: ${name}: ${r.ok ? "ok" : "FAILED"}, the payer's fork balance fell by ${sol(delta)} SOL`);
    return { ...s, delta };
  };
  const writeArgs = ["solana", "program", "write-buffer", ...U, "--buffer", keyPath(`buffer-${run}`), "--buffer-authority", keyPath("dev-wallet-stand-in"), NEW_BUILD];
  const WRITE_CMD = "solana program write-buffer -u $RPC -k $DEV --buffer $BUF --buffer-authority $DEV onchain/target/pools-mainnet/units_launch.so";
  // 1a. the write, killed part way (by its PID), to rehearse the recovery
  const w1 = await step("write-buffer, interrupted", `${WRITE_CMD}   (killed part way)`, async () => {
    const p = spawn(writeArgs[0]!, writeArgs.slice(1), { cwd: ROOT, stdio: "ignore" });
    const done = new Promise<number | null>((res) => p.on("exit", (c) => res(c)));
    for (let i = 0; i < 200; i++) { if (await fork.getAccountInfo(buffer.id)) break; await sleep(50); }
    await sleep(600);
    p.kill("SIGKILL");
    await done;
    await sleep(1500);
    return { text: "killed after the buffer account appeared", ok: true };
  });
  const partial = await fork.getAccountInfo(buffer.id);
  const written = (d: Uint8Array) => { let n = 0; for (let i = 0; i < newBuild.length; i += 1000) if (Buffer.compare(d.subarray(37 + i, 37 + Math.min(i + 1000, newBuild.length)), newBuild.subarray(i, Math.min(i + 1000, newBuild.length))) === 0) n++; return n; };
  const chunks = Math.ceil(newBuild.length / 1000);
  check("an interrupted write leaves a buffer account owned by the loader, its authority the dev wallet's stand-in, partly written", !!partial && partial.owner === LOADER && decodeLoaderAuthority(partial.data) === dev.id
    && partial.data.length === 37 + newBuild.length && Buffer.compare(partial.data.subarray(37), newBuild) !== 0, partial ? `${partial.data.length} bytes holding ${sol(partial.lamports)} SOL; about ${written(partial.data)} of ${chunks} thousand-byte pieces already equal the build` : "no buffer");
  const listed = cli(["solana", "program", "show", ...U, "--buffers", "--buffer-authority", dev.id]);
  check("`solana program show --buffers` lists the interrupted buffer", listed.text.includes(buffer.id), listed.text.split("\n").slice(-2).join(" | ").slice(0, 200));
  // 1b. the same command again resumes into the same buffer
  const w2 = await step("write-buffer, resumed", `${WRITE_CMD}   (the same command again)`, async () => { const r = cli(writeArgs); return { text: r.text, ok: r.status === 0 }; });
  const full = (await fork.getAccountInfo(buffer.id))!;
  check("the same command run again completes the same buffer: its bytes equal the build", w2.ok && Buffer.compare(full.data.subarray(37), newBuild) === 0 && full.data.length === 37 + newBuild.length, `buffer ${buffer.id}, sha256 ${sha(full.data.subarray(37))}`);
  const bufferRentFork = await forkRent(45 + newBuild.length);
  const writeFees = w1.delta + w2.delta - bufferRentFork;
  check("the write cost the buffer's balance plus one base fee per signature; the interruption added nothing (the second run wrote only what was missing)", full.lamports === bufferRentFork && writeFees > 0n && writeFees % 5000n === 0n
    && w2.delta % 5000n === 0n && writeFees <= BigInt(chunks + 10) * 5000n,
    `fees ${sol(writeFees)} SOL for ${writeFees / 5000n} signatures over both runs (the first run: the account's creation, 2 signatures, and ${(w1.delta - bufferRentFork - 10_000n) / 5000n} writes; the second: ${w2.delta / 5000n} writes); the buffer holds ${sol(mainRent.buffer)} SOL at mainnet rent`);
  const dump = join(DIR, "buffer-dump.so");
  const d1 = cli(["solana", "program", "dump", "-u", FORK_URL, buffer.id, dump]);
  check("`solana program dump <buffer>` gives back the build (the check to make before the upgrade)", d1.status === 0 && sha(new Uint8Array(readFileSync(dump))) === sha(newBuild), sha(new Uint8Array(readFileSync(dump))));
  // 1c. extend
  const extra = newBuild.length - oldBuild.length;
  const pd0 = await programData();
  const tooSmall = cli(["solana", "program", "upgrade", ...U, "--upgrade-authority", keyPath("dev-wallet-stand-in"), buffer.id, IDS.launch]);
  check("without the extension the upgrade is refused and the program stays as it was", tooSmall.status !== 0 && (await programData()).is(oldBuild), tooSmall.text.split("\n").slice(-1)[0]!.slice(0, 200));
  const ext = await step("extend", `solana program extend -u $RPC -k $DEV 2vwKsTZm5doa3ahBmpm8Sv3sKPD76Fq2ZZENbNW5BYBq ${extra}`, async () => { const r = cli(["solana", "program", "extend", ...U, IDS.launch, String(extra)]); return { text: r.text, ok: r.status === 0 }; });
  const pd1 = await programData();
  const extendRentFork = (await forkRent(45 + newBuild.length)) - pd0.lamports;
  check(`the extension by exactly ${extra} bytes makes the ProgramData ${45 + newBuild.length} bytes; the code is unchanged`, ext.ok && pd1.bytes === 45 + newBuild.length && pd1.is(oldBuild) && pd1.lamports - pd0.lamports === extendRentFork,
    `${pd0.bytes} to ${pd1.bytes} bytes; on the fork the payer added ${sol(extendRentFork)} SOL (the fork's rent rate), fee ${ext.delta - extendRentFork} lamports; at mainnet rent the addition is ${sol(mainRent.programDataNew - BigInt(PREP.live[programDataAddress(IDS.launch)]!.lamports))} SOL`);
  await sleep(1200);
  const lcMid = await simulated(cranker, [launch.refreshAwake({ agent: PREP.agents[0]!.agent, agentMint: PREP.agents[0]!.mint })]);
  check("between the extension and the upgrade the old code still runs (refresh_awake of a live agent simulates)", lcMid === "", lcMid.slice(0, 200));
  // 1d. upgrade
  const up = await step("upgrade", "solana program upgrade -u $RPC -k $DEV --upgrade-authority $DEV $BUF_ADDRESS 2vwKsTZm5doa3ahBmpm8Sv3sKPD76Fq2ZZENbNW5BYBq", async () => {
    const r = cli(["solana", "program", "upgrade", ...U, "--upgrade-authority", keyPath("dev-wallet-stand-in"), buffer.id, IDS.launch]);
    return { text: r.text, ok: r.status === 0 };
  });
  await sleep(1500);
  const pd2 = await programData();
  check("after the upgrade the deployed code is the pools and claims build, byte for byte", up.ok && pd2.code.length === newBuild.length && Buffer.compare(pd2.code, newBuild) === 0, `sha256 ${sha(pd2.code)}, ${pd2.code.length} bytes`);
  check("the upgrade authority is unchanged and the buffer is gone, its lamports back with the payer", pd2.authority === dev.id && !(await fork.getAccountInfo(buffer.id)) && -up.delta === bufferRentFork - 5000n,
    `the payer got ${sol(-up.delta)} SOL back on the fork (the buffer's rent less one 5,000 lamport fee)`);
  // 1e. the other recovery: an interrupted buffer that is not wanted any more is closed
  const buffer2 = forkKey(`buffer2-${run}`);
  const args2 = writeArgs.map((a) => (a === keyPath(`buffer-${run}`) ? keyPath(`buffer2-${run}`) : a));
  const b0 = await fork.getBalance(dev.id);
  {
    const p = spawn(args2[0]!, args2.slice(1), { cwd: ROOT, stdio: "ignore" });
    const done = new Promise<void>((res) => p.on("exit", () => res()));
    for (let i = 0; i < 200; i++) { if (await fork.getAccountInfo(buffer2.id)) break; await sleep(50); }
    await sleep(300);
    p.kill("SIGKILL");
    await done;
    await sleep(1500);
  }
  const held = (await fork.getAccountInfo(buffer2.id))?.lamports ?? 0n;
  const closed = cli(["solana", "program", "close", ...U, buffer2.id, "--recipient", dev.id, "--authority", keyPath("dev-wallet-stand-in")]);
  await sleep(800);
  const b1 = await fork.getBalance(dev.id);
  check("an abandoned buffer is closed with `solana program close <buffer>` and its whole balance returns; only the fees of the writes made are spent", closed.status === 0 && held === bufferRentFork && !(await fork.getAccountInfo(buffer2.id))
    && b0 - b1 > 0n && b0 - b1 < 2_000_000n, `the buffer held ${sol(held)} SOL on the fork; the detour cost ${sol(b0 - b1)} SOL in fees`);
  steps.push({ step: "close an abandoned buffer", command: "solana program close -u $RPC -k $DEV <buffer> --recipient <dev wallet> --authority $DEV", ok: closed.status === 0, output: closed.text.split("\n").slice(-2) });
  const locked = mainRent.programDataNew - BigInt(PREP.live[programDataAddress(IDS.launch)]!.lamports);
  const uninterruptedWriteFees = writeFees; // the resumed write sent no piece twice, so an uninterrupted one costs the same
  out.upgrade = {
    extra_bytes: extra, steps,
    measured_on_the_fork: { write_fee_lamports_both_runs: writeFees.toString(), write_signatures_both_runs: (writeFees / 5000n).toString(), extend_fee_lamports: (ext.delta - extendRentFork).toString(), upgrade_fee_lamports: "5000",
      program_data_slot_before: pd0.slot, program_data_slot_after_extend: pd1.slot, program_data_slot_after_upgrade: pd2.slot },
    at_mainnet_rent: {
      note: "rent figures are mainnet's own getMinimumBalanceForRentExemption (the fork's rate is higher); fees are the base fee, no priority fee",
      program_data_now_lamports: PREP.live[programDataAddress(IDS.launch)]!.lamports, program_data_after_lamports: mainRent.programDataNew.toString(),
      locked_for_good_sol: sol(locked), buffer_temporary_sol: sol(mainRent.buffer), write_fees_uninterrupted_sol: sol(uninterruptedWriteFees), write_fees_measured_with_one_interruption_sol: sol(writeFees),
      extend_fee_sol: sol(ext.delta - extendRentFork), upgrade_fee_sol: sol(5000n),
      peak_needed_sol: sol(locked + mainRent.buffer + writeFees + (ext.delta - extendRentFork) + 5000n), spent_in_the_end_sol: sol(locked + writeFees + (ext.delta - extendRentFork) + 5000n),
    },
  };
  check("the ProgramData's slot moved at the extension and again at the upgrade (the program is not callable in the slot of each)", pd1.slot > pd0.slot && pd2.slot > pd1.slot, `${pd0.slot}, ${pd1.slot}, ${pd2.slot}`);

  // ---------------------------------------------------------------- 2 nothing moved, everything decodes
  section = "2 accounts";
  const after = await launchAccounts();
  check("every account of the launch program is byte for byte what it was before the upgrade, with the same balance", after.size === before.size && [...before.values()].every((a) => after.has(a.address)
    && Buffer.compare(after.get(a.address)!.data, a.data) === 0 && after.get(a.address)!.lamports === a.lamports), `${after.size} accounts`);
  const decoded: Record<string, number> = {};
  let bad = "";
  for (const a of after.values()) { try { decodeAny(a.data); decoded[typeOf(a.data)] = (decoded[typeOf(a.data)] ?? 0) + 1; } catch (e) { bad += `${a.address}: ${(e as Error).message}; `; } }
  check("the current client decoders read every one of them", !bad, bad || Object.entries(decoded).map(([t, n]) => `${n} ${t}`).join(", "));
  const lc0 = (await reader.launchConfig())!;
  check("LaunchConfig read through the upgraded program's own account type: features 0, the fee split and thresholds as before", lc0.features === 0 && lc0.agentComputeBps === STATE.agent_compute_bps && lc0.lineMint === LINE && !lc0.paused,
    `agent share ${lc0.agentComputeBps} bps, sleep ${lc0.sleepThreshold}, wake ${lc0.wakeThreshold}, usage epochs posted ${lc0.usageEpochsPosted}`);
  for (const a of PREP.agents) {
    const l0 = decodeAgentLaunch(before.get(launchPdas.agentLaunch(a.mint))!.data);
    const err = await simulated(cranker, [launch.refreshAwake({ agent: a.agent, agentMint: a.mint })]);
    if (!err) await tx(`refresh_awake of live agent ${a.agent.slice(0, 6)}`, cranker, [launch.refreshAwake({ agent: a.agent, agentMint: a.mint })], [], 100_000);
    const l1 = (await reader.agentLaunch(a.mint))!;
    check(`live agent ${a.agent.slice(0, 6)}: the upgraded program loads and rewrites its AgentLaunch (refresh_awake), every field kept, routes 0`, !err && l1.routes === 0 && l1.feesClaimed === l0.feesClaimed && l1.toCompute === l0.toCompute
      && l1.debited === l0.debited && l1.repoUrl === l0.repoUrl && l1.launcher === l0.launcher && l1.bondingCurve === l0.bondingCurve, err.slice(0, 200) || `fees claimed ${l1.feesClaimed}, debited ${l1.debited}, awake ${l1.awake}`);
  }

  {
    const b = out.launch_compute_before as Awaited<ReturnType<typeof launchSim>>, a = await launchSim();
    out.launch_compute_after = a;
    check("the same launch transaction (create_v2 + register_pump_launch, same keys) simulated before and after the upgrade: it passes on both, and the compute units are compared", !b.err && !a.err && a.units > 0,
      `before ${b.units} CU (the launch program's instruction ${b.register_pump_launch_units})${b.err ? ` ${b.err}` : ""}, after ${a.units} CU (${a.register_pump_launch_units})${a.err ? ` ${a.err}` : ""}: ${a.units - b.units >= 0 ? "+" : ""}${a.units - b.units} CU; the page's limit for it is ${launchTxUnits(["launch"])}`);
  }

  // ---------------------------------------------------------------- 3 today's flows, bits off
  section = "3 flows";
  const poolNow = async () => {
    const [gA, fcA, ammFcA, curveA, pA, bA, qA, mA] = await fork.getMultipleAccounts([PUMP.global, PUMP.feeConfig, PUMP.ammFeeConfig, pumpPdas.bondingCurve(LINE), POOL.pool, POOL.baseVault, POOL.quoteVault, LINE]);
    const g = decodePumpGlobal(gA!.data), pool = decodePumpPool(pA!.data), base = decodeTokenAccount(bA!.data).amount, quote = decodeTokenAccount(qA!.data).amount;
    const rates = poolRates({ creatorFeeConfigurable: g.creatorFeeConfigurable }, decodePumpFeeConfig(ammFcA!.data), pool, decodeMint(mA!.data).supply, quote + pool.virtualQuoteReserves, base);
    return { g, fc: decodePumpFeeConfig(fcA!.data), curve: decodeBondingCurve(curveA!.data), pool, base, quote, rates, buy: (o: bigint) => quotePoolBuyExactOut(rates, pool, base, quote, o) };
  };
  const rent0 = BigInt(await fork.getMinimumBalanceForRentExemption(0)), rentToken = rentLamports(TOKEN_ACCOUNT_LEN, rent0);
  /** $UNITS for a fork key, bought with SOL on the real pool (the launch's own purchase builder). */
  const buyUnits = async (who: Signer, amount: bigint) => {
    const p = await poolNow(), q = p.buy(amount);
    await tx(`${who.id.slice(0, 6)} buys ${amount / ONE} $UNITS on the pool`, who, pumpSolToLinePool({ launcher: who.id, lineMint: LINE, pool: POOL.pool, amountOut: amount, maxSolIn: maxSolIn(q.quoteIn, 500), rentToken, lineTokenProgram: T22 }), [], 300_000);
  };
  const curveOf = (mint: string) => acct(pumpPdas.bondingCurve(mint), decodeBondingCurve);
  /** A trade on an agent coin's curve: the trader spends 2% of the curve's virtual $UNITS. Returns what it spent. */
  const trade = async (mint: string, tag: string) => {
    const c = await curveOf(mint), spend = c.virtualQuoteReserves / 50n;
    if ((await bal(ata(trader.id, LINE, T22))) < spend) await buyUnits(trader, spend * 6n);
    await tx(`trader buys ${tag}`, trader, [token.createAtaIdempotent(trader.id, trader.id, mint, T22), pump.buyExactQuoteInV3({ mint, quoteMint: LINE, quoteTokenProgram: T22, user: trader.id, spendableQuoteIn: spend, minTokensOut: 1n })], [], 400_000);
    return spend;
  };
  const four = async (agent: string, gh: bigint | number | null, repo: string | null) => [await bal(launchPdas.computeVault(agent)), await bal(registryPdas.treasury()), gh === null ? 0n : await bal(claimPdas.vault(gh)),
    repo === null ? 0n : await bal(poolPdas.vault(repo, LINE, T22))] as [bigint, bigint, bigint, bigint];
  // a stand-in for the two Core routes the keeper script reads (the agent list and the coin's dollar price)
  let served: { agent_id: string; mint: string }[] = [];
  const stub = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
    const p = new URL(req.url).pathname;
    if (p === "/v1/agents") return Response.json(served);
    if (p === "/market/quote-usd") return Response.json({ ok: true, usd: 0.001 });
    return new Response("not served by the rehearsal's stand-in", { status: 404 });
  } });
  // the keeper script as COMMITTED (what the server runs today), beside the working copy
  const headCrank = join(import.meta.dir, `crank-fees.head-${run}.tmp.ts`);
  const head = spawnSync("git", ["show", "HEAD:scripts/mainnet/crank-fees.ts"], { cwd: ROOT, encoding: "utf8" });
  if (head.status !== 0) throw new Error("git show HEAD:scripts/mainnet/crank-fees.ts failed");
  writeFileSync(headCrank, head.stdout);
  const keeperRun = (script: string, agentsServed: { agent_id: string; mint: string }[]) => {
    served = agentsServed;
    return new Promise<string>((res) => {
      const p = spawn("bun", [script, "--core", `http://127.0.0.1:${stub.port}`, "--key", keyPath("cranker"), "--min-usd", "0", "--send"], { cwd: ROOT, env: { ...process.env, UNITS_NETWORK: "mainnet", UNITS_MAINNET_RPC: FORK_URL } });
      let t = "";
      p.stdout.on("data", (d) => (t += d));
      p.stderr.on("data", (d) => (t += d));
      p.on("exit", () => res(t));
    });
  };
  try {
    // 3a. the committed fee crank keeper on the three live agents
    const liveBefore: Record<string, { v: bigint[]; l: ReturnType<typeof decodeAgentLaunch> }> = {};
    for (const a of PREP.agents) {
      await trade(a.mint, `live coin ${a.mint.slice(0, 6)}`);
      liveBefore[a.agent] = { v: await four(a.agent, null, null), l: (await reader.agentLaunch(a.mint))! };
    }
    out.keeper_committed_bits_off = (await keeperRun(headCrank, PREP.agents.map((a) => ({ agent_id: a.agent, mint: a.mint })))).trim().split("\n").map((l) => l.slice(0, 220));
    for (const a of PREP.agents) {
      const l1 = (await reader.agentLaunch(a.mint))!, l0 = liveBefore[a.agent]!.l;
      const fees = l1.feesClaimed - l0.feesClaimed, w = crankSplit(fees, lc0.agentComputeBps);
      const vault = (await bal(launchPdas.computeVault(a.agent))) - liveBefore[a.agent]!.v[0]!;
      check(`live agent ${a.agent.slice(0, 6)}: the committed keeper script (scripts/mainnet/crank-fees.ts at HEAD, eight accounts) cranked its fees; ${lc0.agentComputeBps / 100}% reached its compute vault, the rest the treasury, to the unit`,
        fees > 0n && vault === w.toCompute && l1.toCompute - l0.toCompute === w.toCompute && l1.toProtocol - l0.toProtocol === w.toProtocol && w.toProtocol === fees - (fees * BigInt(lc0.agentComputeBps)) / 10_000n,
        `fees ${fees}: compute ${w.toCompute}, protocol ${w.toProtocol}`);
    }
    // 3b. usage post and debit by the (stand-in) runtime authority on a live hosted agent
    {
      const a = PREP.agents[0]!, epoch = Number(lc0.lastUsageEpoch!) + 1, amount = 1_000_000n;
      const leaf = usageLeaf({ epoch, agent: a.agent, amount, model_tokens: 1234, sandbox_s: 56 });
      const v0 = await bal(launchPdas.computeVault(a.agent)), s0 = await bal(lc0.computeSink), l0 = (await reader.agentLaunch(a.mint))!;
      await send(section, `post_usage epoch ${epoch}`, runtime, [launch.postUsage({ runtimeAuthority: runtime.id, epoch, root: merkleRoot([leaf]) })]);
      await send(section, `debit_compute epoch ${epoch}`, runtime, [launch.debitCompute({ runtimeAuthority: runtime.id, epoch, agent: a.agent, agentMint: a.mint, computeSink: lc0.computeSink, lineMint: LINE, amount, modelTokens: 1234, sandboxS: 56, proof: [],
        lineTokenProgram: T22 })]);
      const l1 = (await reader.agentLaunch(a.mint))!, lcN = (await reader.launchConfig())!;
      check("the hosted runtime's path on a live agent: post_usage continues the live epoch sequence and debit_compute moves the amount from the vault to the compute sink", v0 - (await bal(launchPdas.computeVault(a.agent))) === amount
        && (await bal(lc0.computeSink)) - s0 === amount && l1.debited - l0.debited === amount && Number(lcN.lastUsageEpoch) === epoch && lcN.usageEpochsPosted === lc0.usageEpochsPosted! + 1n && lcN.features === 0,
        `usage epoch ${epoch} after the live ${lc0.lastUsageEpoch}; signed by the stand-in for the runtime authority`);
    }
    // 3c. a launch through the wizard's builders, both ways (the pool purchase lane's proof, run as it is, one mode at a time).
    // That proof stops at its first failed check. One of its checks is a convention, not a refusal by the chain: every
    // transaction at most 62.5% of its compute limit. The launch transaction's units vary with the keys (pump.fun derives
    // many addresses), so a launch that lands is run again with fresh keys when that convention alone was missed, and every
    // attempt is recorded.
    const keyOf = (id: string) => { for (const f of readdirSync(KEYS)) if (f.endsWith(".json")) { try { const k = loadKeypair(join(KEYS, f)); if (k.id === id) return k; } catch { /* not a key file */ } } throw new Error(`no fork key for ${id}`); };
    const attempts: { mode: string; attempt: number; outcome: string; passed: number; total: number; failed: string[] }[] = [];
    const wizard: Record<string, any> = {};
    for (const mode of ["units", "sol"] as const) {
      for (let attempt = 1; attempt <= 4; attempt++) {
        const plOut = join(DIR, `pool-launch-${mode}-${attempt}.json`);
        cli(["bun", join(import.meta.dir, "pool-launch-fork.ts"), "--only", mode], { env: { UNITS_NETWORK: "mainnet", MAINNET_FORK_KEYS: KEYS, POOL_LAUNCH_FORK_OUT: plOut } });
        const rec = existsSync(plOut) ? JSON.parse(readFileSync(plOut, "utf8")) : { outcome: "no record", checks: [] };
        const cs = rec.checks as { ok: boolean; name: string; detail: string }[];
        attempts.push({ mode, attempt, outcome: rec.outcome, passed: cs.filter((c) => c.ok).length, total: cs.length, failed: cs.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`) });
        wizard[mode] = rec;
        if (rec.outcome === "PASS" || !(cs.filter((c) => !c.ok).length === 1 && cs.some((c) => !c.ok && c.name.includes("62.5% of its compute limit")))) break;
      }
    }
    out.wizard_launch = { script: "scripts/mainnet/pool-launch-fork.ts --only <mode>", attempts, units: wizard.units?.units ?? null, sol: wizard.sol?.sol ?? null, checks: [...(wizard.units?.checks ?? []), ...(wizard.sol?.checks ?? [])] };
    const N = (["sol", "units"] as const).map((m) => { const r = wizard[m]?.[m]; if (!r) throw new Error(`the ${m} launch of the wizard proof left no record: ${attempts.filter((x) => x.mode === m).map((x) => x.failed.join("; ")).join(" | ").slice(0, 400)}`);
      return { s: m === "sol" ? "a" : "b", mode: m, rec: r, agent: keyOf(r.agent), mint: keyOf(r.mint), launcher: null as unknown as Signer }; });
    for (const n of N) n.launcher = keyOf((await acct(registryPdas.agent(n.agent.id), decodeAgent)).owner);
    const [A, B] = N as [typeof N[0], typeof N[0]];
    for (const n of N) {
      const la = await reader.agentLaunch(n.mint.id);
      check(`a new launch through the Launch page's own builders and planner on the upgraded program, ${n.mode === "sol" ? "with SOL only (the purchase on the PumpSwap pool)" : "paying from the wallet's own $UNITS"}: the agent is registered, its coin quoted in $UNITS, its credits in its vault`,
        !!la && la.agent === n.agent.id && la.routes === 0 && (await bal(launchPdas.computeVault(n.agent.id))) > 0n && (await curveOf(n.mint.id)).quoteMint === LINE,
        `${sol(BigInt(n.rec.spent_lamports))} SOL in ${n.rec.txs.length} transactions: ${n.rec.txs.map((t: any) => `${t.groups.join(" + ")} ${t.cu} of ${t.limit} CU`).join("; ")}`);
    }
    const last = (m: string) => attempts.filter((x) => x.mode === m).at(-1)!;
    const missed = attempts.filter((x) => x.outcome !== "PASS");
    check("the pool purchase lane's own proof of both launches passes whole (sizes, the starting curve, the spend equal to the cost lines to the lamport, compute against the page's limits)",
      last("units").outcome === "PASS" && last("sol").outcome === "PASS", `${["units", "sol"].map((m) => `${m}: PASS ${last(m).passed}/${last(m).total}${attempts.filter((x) => x.mode === m).length > 1 ? ` on attempt ${last(m).attempt}` : ""}`).join("; ")}${missed.length
        ? `. Earlier attempts that landed but missed that proof's 62.5% compute convention on the launch transaction, and nothing else: ${missed.map((x) => x.failed.join("; ")).join(" | ").slice(0, 500)}` : ""}`);
    // 3d. the runtime binding of a hosted agent: the owner and the new key sign, then the launch holding moves
    {
      const rt = forkKey(`runtime-key-${run}`);
      const held = await bal(ata(A.agent.id, A.mint.id, T22));
      await tx("bind: rotate_agent_key (owner + the runtime's key) and the launch holding to the runtime key", A.launcher, [registry.rotateAgentKey({ owner: A.launcher.id, agent: A.agent.id, newKey: rt.id }),
        ...moveLaunchHolding({ payer: A.launcher.id, agentKey: A.agent.id, treasury: rt.id, agentMint: A.mint.id, amount: held, decimals: 6 })], [rt, A.agent], 200_000);
      const rec = await acct(registryPdas.agent(A.agent.id), decodeAgent);
      check("bind: the new agent's registry signing key is the runtime's key and its launch holding sits in that key's account", rec.signingKey === rt.id && (await bal(ata(rt.id, A.mint.id, T22))) === held && held > 0n, `${held} base units`);
    }
    check("the new agents work on the repository of a live agent (the pool they can form is that repository's)", (await reader.agentLaunch(A.mint.id))!.repoId === (await reader.agentLaunch(B.mint.id))!.repoId
      && PREP.agents.some((a) => canonicalUrl(a.repo_url) === canonicalUrl("https://github.com/karpathy/minbpe")), (await reader.agentLaunch(A.mint.id))!.repoUrl);

    // ---------------------------------------------------------------- 4 the admin steps
    section = "4 admin";
    const paramsFile = join(DIR, "launch-features-params.fork.json");
    const P = JSON.parse(readFileSync(join(import.meta.dir, "launch-features-params.json"), "utf8"));
    P.claim.attestor = attestor.id;
    P.pool.keeper = keeper.id;
    writeFileSync(paramsFile, JSON.stringify(P, null, 1));
    const lf = (args: string[]) => cli(["bun", join(import.meta.dir, "launch-features.ts"), ...args, "--rpc", FORK_URL, "--params", paramsFile]);
    const transcript: { command: string; output: string[] }[] = [];
    const lfRun = (label: string, args: string[]) => { const r = lf(args); transcript.push({ command: `launch-features.ts ${label}`, output: r.text.split("\n").map((l) => l.slice(0, 400)) }); return r; };
    const committed = lfRun("configs --key $DEV --send   (the committed params file: owner_confirmed false, no keys)", ["configs", "--key", keyPath("dev-wallet-stand-in"), "--send", "--params", join(import.meta.dir, "launch-features-params.json")]);
    check("launch-features.ts refuses to send the committed params file (owner_confirmed false, attestor and keeper not set)", committed.status !== 0 && !(await fork.getAccountInfo(claimPdas.config())), committed.text.split("\n").filter((l) => l.includes("REFUSED")).join(" | ").slice(0, 300));
    check("the admin instructions are refused for a key that is not the admin", await refusedWith(stranger, [claims.setFeatures({ admin: stranger.id, features: 3 })], "Unauthorized")
      && lf(["configs", "--key", keyPath("stranger"), "--send", "--unconfirmed-ok"]).status !== 0);
    check("features cannot be switched on before the config accounts exist (the tool refuses)", lf(["features", "--key", keyPath("dev-wallet-stand-in"), "--send", "--unconfirmed-ok"]).status !== 0 && (await reader.launchConfig())!.features === 0);
    const d0 = await fork.getBalance(dev.id);
    const cfgRun = lfRun("configs --key $DEV --send", ["configs", "--key", keyPath("dev-wallet-stand-in"), "--send", "--unconfirmed-ok"]);
    const sigOf = (t: string) => /sent: (\S+)/.exec(t)?.[1] ?? "";
    const cfgCost = cfgRun.status === 0 ? await measure(section, "set_claim_config + set_pool_config (creates both accounts)", sigOf(cfgRun.text)) : null;
    const cc = await acct(claimPdas.config(), decodeClaimConfig), pc = await acct(poolPdas.config(), decodePoolConfig);
    check("configs: ClaimConfig holds one fixed share of 20% (min = max = 2000 bps), a 30 day change delay, a 24 hour rebind delay, 600 s attestations and the attestor key", cfgRun.status === 0 && cc.minBps === 2000 && cc.maxBps === 2000
      && cc.changeDelayS === 2_592_000n && cc.rebindDelayS === 86_400n && cc.maxAttestationTtlS === 600n && cc.attestor === attestor.id && !cc.paused, j(cc));
    check("configs: PoolConfig holds devnet's values (20% of the agent share routed; 40% payout, 40% buyback, 20% burn; up to 8 agents; joining by the owner) and the keeper key", pc.poolFeeBps === 2000 && pc.payoutBps === 4000
      && pc.buybackBps === 4000 && pc.burnBps === 2000 && pc.maxMembers === 8 && !pc.autoJoin && pc.keeper === keeper.id && !pc.paused, j(pc));
    check("configs alone change nothing: features still 0, and a route or a membership is refused (FeatureOff)", (await reader.launchConfig())!.features === 0
      && await refusedWith(A.launcher, [claims.setFeeRoute({ owner: A.launcher.id, agent: A.agent.id, agentMint: A.mint.id, lineMint: LINE, githubId: 1, bps: 2000 })], "FeatureOff")
      && await refusedWith(A.launcher, [pools.joinPool({ signer: A.launcher.id, agent: A.agent.id, agentMint: A.mint.id, repoId: (await reader.agentLaunch(A.mint.id))!.repoId, lineMint: LINE, members: [] })], "FeatureOff"));
    const lcBeforeBits = (await reader.launchConfig())!;
    const featRun = lfRun("features --key $DEV --send", ["features", "--key", keyPath("dev-wallet-stand-in"), "--send", "--unconfirmed-ok"]);
    const featCost = featRun.status === 0 ? await measure(section, "set_features(3)", sigOf(featRun.text)) : null;
    check("features: LaunchConfig.features is 3 (pools and GitHub fees), every other field as it was", featRun.status === 0 && (await reader.launchConfig())!.features === 3 && j({ ...(await reader.launchConfig())!, features: 0 }) === j(lcBeforeBits));
    lfRun("status", ["status"]);
    const adminMain = BigInt(cfgCost?.payerMainnet ?? "0") + BigInt(featCost?.payerMainnet ?? "0");
    {
      // the dev wallet's budget: its mainnet balance now (read only) against this upgrade and the bounty escrow program's deploy (docs/MAINNET-RUNBOOK.md "Bounty escrow program")
      const u = out.upgrade.at_mainnet_rent, lam = (x: string) => BigInt(Math.round(Number(x) * 1e9));
      const balance = await mainnet.getBalance(PREP.real_admin), peak = lam(u.peak_needed_sol), spent = lam(u.spent_in_the_end_sol) + adminMain;
      const bounty = { peak: 4_870_165_520n, locked: 2_435_519_640n, init: 3_510_200n };
      out.dev_wallet_budget = { note: "base fees only: add the priority fees chosen on the day (about 950 write transactions)", mainnet_balance_now_sol: sol(balance), upgrade_peak_sol: sol(peak), upgrade_and_admin_spent_sol: sol(spent),
        after_upgrade_and_admin_sol: sol(balance - spent), bounty_deploy: { peak_sol: sol(bounty.peak), locked_sol: sol(bounty.locked), init_sol: sol(bounty.init), source: "docs/MAINNET-RUNBOOK.md, the bounty escrow lane's figures" },
        upgrade_first_then_bounty: { lowest_balance_sol: sol(balance - spent - bounty.peak), ok: balance - spent >= bounty.peak && balance >= peak },
        bounty_first_then_upgrade: { lowest_balance_sol: sol(balance - bounty.locked - bounty.init - peak), ok: balance - bounty.locked - bounty.init >= peak },
        both_buffers_at_once: { lowest_balance_sol: sol(balance - peak - bounty.peak), ok: balance >= peak + bounty.peak },
        left_after_both_sol: sol(balance - spent - bounty.locked - bounty.init),
        with_11_1_sol: { upgrade_first: sol(11_100_000_000n - spent - bounty.peak), bounty_first: sol(11_100_000_000n - bounty.locked - bounty.init - peak), both_at_once: sol(11_100_000_000n - peak - bounty.peak), left_after_both: sol(11_100_000_000n - spent - bounty.locked - bounty.init) } };
    }
    out.admin = { transcript, configs: cfgCost && { signature: cfgCost.signature, fee_lamports: cfgCost.fee, compute_units: cfgCost.computeUnits, created: cfgCost.created, payer_mainnet_lamports: cfgCost.payerMainnet },
      features: featCost && { signature: featCost.signature, fee_lamports: featCost.fee, compute_units: featCost.computeUnits, payer_mainnet_lamports: featCost.payerMainnet }, admin_fork_balance_delta_lamports: (d0 - (await fork.getBalance(dev.id))).toString(),
      admin_cost_at_mainnet_rent_sol: sol(BigInt(cfgCost?.payerMainnet ?? "0") + BigInt(featCost?.payerMainnet ?? "0")) };

    // ---------------------------------------------------------------- 5 a route, a pool, routed cranks, a settlement, a claim
    section = "5 features";
    const lc3 = (await reader.launchConfig())!;
    const repo = (await reader.agentLaunch(A.mint.id))!.repoId;
    // the repository's numeric GitHub id, as the wizard looks it up (public API; a fixed stand-in when GitHub does not answer)
    const gh = await fetch("https://api.github.com/repos/karpathy/minbpe", { headers: { "user-agent": "units-fork-rehearsal" }, signal: AbortSignal.timeout(10_000) }).then((r) => r.json()).then((b: any) => Number(b.id)).catch(() => NaN);
    const GH = Number.isSafeInteger(gh) && gh > 0 ? gh : 757_000_001;
    out.features_run = { repository: "karpathy/minbpe", repository_id: GH, repository_id_source: GH === gh ? "api.github.com" : "stand-in (GitHub did not answer)", repo_id_on_chain: repo };
    // a live agent is untouched by the bits: its eight-account crank still runs
    {
      const a = PREP.agents[0]!;
      await trade(a.mint, `live coin ${a.mint.slice(0, 6)} (bits on)`);
      const l0 = (await reader.agentLaunch(a.mint))!, v0 = await bal(launchPdas.computeVault(a.agent));
      const t = await keeperRun(headCrank, [{ agent_id: a.agent, mint: a.mint }]);
      const l1 = (await reader.agentLaunch(a.mint))!, fees = l1.feesClaimed - l0.feesClaimed;
      check("with both bits on, a live agent that has no route and no membership is cranked by the committed keeper exactly as before", fees > 0n && (await bal(launchPdas.computeVault(a.agent))) - v0 === crankSplit(fees, lc3.agentComputeBps).toCompute && l1.routes === 0, t.trim().split("\n").slice(-2).join(" | ").slice(0, 200));
    }
    check("refused: a route by a wallet that is not the agent's owner; a share other than the fixed 20%; a membership by a wallet that is not the owner (auto-join off)",
      (await simulated(stranger, [claims.setFeeRoute({ owner: stranger.id, agent: A.agent.id, agentMint: A.mint.id, lineMint: LINE, githubId: GH, bps: 2000 })])) !== ""
      && await refusedWith(A.launcher, [claims.setFeeRoute({ owner: A.launcher.id, agent: A.agent.id, agentMint: A.mint.id, lineMint: LINE, githubId: GH, bps: 3000 })], "RouteBounds")
      && (await simulated(stranger, [pools.joinPool({ signer: stranger.id, agent: A.agent.id, agentMint: A.mint.id, repoId: repo, lineMint: LINE, members: [] })])) !== "");
    // agents launched BEFORE the features opened opt in afterwards, their owner signing
    await tx("set_fee_route (first for the repository: creates FeeRoute, ClaimEscrow and its vault)", A.launcher, [claims.setFeeRoute({ owner: A.launcher.id, agent: A.agent.id, agentMint: A.mint.id, lineMint: LINE, githubId: GH, bps: cc.minBps })]);
    await tx("join_pool (first member: creates Pool, its vault and PoolMember)", A.launcher, [pools.joinPool({ signer: A.launcher.id, agent: A.agent.id, agentMint: A.mint.id, repoId: repo, lineMint: LINE, members: [] })]);
    await tx("join_pool (second member: creates PoolMember)", B.launcher, [pools.joinPool({ signer: B.launcher.id, agent: B.agent.id, agentMint: B.mint.id, repoId: repo, lineMint: LINE, members: [A.agent.id] })]);
    check("an agent launched before the features opened opted in afterwards: A has a route and a membership (routes 3), B a membership (routes 1), the pool has two members", (await reader.agentLaunch(A.mint.id))!.routes === 3
      && (await reader.agentLaunch(B.mint.id))!.routes === 1 && (await acct(poolPdas.pool(repo), decodePool)).members.length === 2 && (await acct(claimPdas.feeRoute(A.agent.id), decodeFeeRoute)).bps === 2000);
    // a third agent launched WITH the tick and the pool box, through the page's groups and planner
    const C = { s: "c", agent: forkKey(`agent-c-${run}`), mint: forkKey(`mint-c-${run}`), launcher: forkKey(`launcher-c-${run}`) };
    {
      await airdrop(C.launcher.id, 3_000_000_000n);
      const net = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
      const prepay = parsePrepayConfig({ ...net.prepay, ...(STATE.network_overrides?.prepay ?? {}) });
      const p = await poolNow(), bps = prepay.initial_buy_slippage_bps, deposit = requiredCredits(prepay, STATE.line_decimals);
      const amountOut = initialBuyAmount(p.g.tokenTotalSupply, prepay.initial_buy_bps);
      const fresh = pumpQuotedCurve(p.g, { curve: p.curve, pool: { pool: p.pool, baseReserve: p.base, quoteReserve: p.quote } }, launchPdas.pumpCreator(C.agent.id), LINE, 0n, "swap");
      const quote = quoteInitialBuy(p.g, p.fc, fresh, amountOut), maxIn = maxBuyInput(quote, bps), need = deposit + maxIn, whole = p.buy(need).quoteIn;
      const members = (await acct(poolPdas.pool(repo), decodePool)).members;
      const groups: BundleGroup[] = [
        { name: "launch", ixs: pumpLaunchMain({ launcher: C.launcher.id, agent: C.agent.id, agentMint: C.mint.id, line: { mint: LINE, tokenProgram: T22, pool: POOL }, name: "Fork route proof", symbol: "FRP",
          uri: `https://app.units.gg/coin/${C.mint.id}.json?i=${"h".repeat(64)}&l=${"h".repeat(64)}`.slice(0, 200), args: { repoUrl: canonicalUrl("https://github.com/karpathy/minbpe"), identityMode: IDENTITY_MODE.token, hosted: true } }) },
        { name: "soul", ixs: [registry.setProfile({ signingKey: C.agent.id, agent: C.agent.id, digest: H("soul", `launch upgrade fork ${run}`), seq: 1 })] },
        { name: "fee-route", ixs: [claims.setFeeRoute({ owner: C.launcher.id, agent: C.agent.id, agentMint: C.mint.id, lineMint: LINE, githubId: GH, bps: cc.minBps, lineTokenProgram: T22 })] },
        { name: "pool", ixs: [pools.joinPool({ signer: C.launcher.id, agent: C.agent.id, agentMint: C.mint.id, repoId: repoIdOf(canonicalUrl("https://github.com/karpathy/minbpe")), lineMint: LINE, members, lineTokenProgram: T22 })] },
        { name: "sol-to-units", ixs: pumpSolToLinePool({ launcher: C.launcher.id, lineMint: LINE, pool: POOL.pool, amountOut: need, maxSolIn: maxSolIn(whole, bps), rentToken, lineTokenProgram: T22 }) },
        { name: "initial-buy", ixs: pumpInitialBuy({ launcher: C.launcher.id, agent: C.agent.id, agentMint: C.mint.id, lineMint: LINE, amountOut, maxIn, lineTokenProgram: T22, createBuyback: false }) },
        { name: "credits", ixs: launch.prepay({ launcher: C.launcher.id, agent: C.agent.id, agentMint: C.mint.id, lineMint: LINE, amount: deposit, decimals: STATE.line_decimals, lineTokenProgram: T22 }) },
        { name: "units-account", ixs: [system.transfer(C.launcher.id, STATE.network_overrides.prepay.identity_account_recipient, BigInt(prepay.identity_account_price_lamports))] },
      ];
      const plan = planLaunchBundle({ payer: C.launcher.id, groups, budget: [computeBudget.limit(1_400_000), computeBudget.price(1)], table, v0: true, maxTxs: JITO_MAX_TXS });
      const s0 = await fork.getBalance(C.launcher.id);
      const sent: { groups: string[]; bytes: number; limit: number; cu: number; created_bytes: number[] }[] = [];
      const { blockhash } = await fork.getLatestBlockhash();
      for (const [i, t] of plan.entries()) {
        const limit = launchTxUnits(t.groups, "pool"), ixs = [computeBudget.limit(limit), computeBudget.price(1), ...t.ixs];
        const msg = compileMessageV0(C.launcher.id, ixs, blockhash, [table]);
        const signed = signMessageWith(msg, [C.launcher, ...[C.agent, C.mint].filter((k) => ixs.some((ix) => ix.keys.some((m) => m.isSigner && m.pubkey === k.id)))]);
        await fork.sendRawTransaction(signed.wire, true);
        let st: any = null;
        for (let n = 0; n < 120 && !(st && (st.err || st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")); n++) { await sleep(500); [st] = await fork.getSignatureStatuses([signed.signature]); }
        if (!st || st.err) {
          const tr = await fork.call<{ meta: { logMessages?: string[] } }>("getTransaction", [signed.signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]).catch(() => null);
          throw new Error(`launch with route and pool: transaction ${i + 1} (${t.groups.join(" + ")}) failed: ${JSON.stringify(st?.err)} ${(tr?.meta.logMessages ?? []).slice(-6).join(" | ")}`);
        }
        const c = await measure(section, `launch with the route tick and the pool box, tx ${i + 1}/${plan.length}: ${t.groups.join(" + ")}`, signed.signature);
        sent.push({ groups: t.groups, bytes: wireSize({ bytes: msg.bytes, numSigners: msg.numSigners }), limit, cu: c.computeUnits ?? 0, created_bytes: c.created.map((x) => x.bytes) });
      }
      const la = (await reader.agentLaunch(C.mint.id))!;
      check("a launch through the page's groups and planner WITH the route tick and the pool box: it fits, lands, and the new agent has its route (the repository's id, 20%) and is the pool's third member",
        plan.length <= JITO_MAX_TXS && sent.every((x) => x.bytes <= 1232) && la.routes === 3 && (await acct(claimPdas.feeRoute(C.agent.id), decodeFeeRoute)).githubId === BigInt(GH)
        && (await acct(poolPdas.pool(repo), decodePool)).members.length === 3 && (await bal(launchPdas.computeVault(C.agent.id))) === deposit,
        sent.map((x) => `${x.groups.join(" + ")}: ${x.bytes} bytes, ${x.cu} of ${x.limit} CU`).join("; "));
      // the page's convention is 62.5% of the limit at most. It is asserted here for what is new, the transaction that carries the route and the pool
      // (allowances of 150,000 each, never measured on mainnet before). The launch transaction's units vary with the keys by tens of thousands
      // (pump.fun derives many addresses) and are the same before and after the upgrade (section 2): its ratio is recorded, not asserted.
      const withNew = sent.filter((x) => x.groups.includes("fee-route") || x.groups.includes("pool"));
      check("the transaction that carries the two new groups (fee-route, pool) used at most 62.5% of its compute limit (the page's 1.6 times headroom rule)", withNew.length > 0 && withNew.every((x) => x.cu * 1.6 <= x.limit),
        `${withNew.map((x) => `${x.groups.join(" + ")}: ${x.cu} of ${x.limit}`).join("; ")}; the others: ${sent.filter((x) => !withNew.includes(x)).map((x) => `${x.groups.join(" + ")} ${x.cu} of ${x.limit} (${Math.round((x.cu / x.limit) * 1000) / 10}%)`).join("; ")}`);
      out.launch_with_route_and_pool = { agent: C.agent.id, mint: C.mint.id, txs: sent, spent_lamports: (s0 - (await fork.getBalance(C.launcher.id))).toString() };
    }
    // routed cranks: what a client that predates the features sends, and what the route-aware one sends
    const routesOf = async (agent: string): Promise<AccountMeta[]> => {
      const la = (await fork.getProgramAccounts(IDS.launch)).map((x) => x).find((x) => typeOf(x.data) === "AgentLaunch" && decodeAgentLaunch(x.data).agent === agent)!;
      const active = (await reader.launchConfig())!.features & decodeAgentLaunch(la.data).routes, keys: AccountMeta[] = [];
      if (active & FEATURES.githubFees) keys.push(...claims.crankRouteKeys(agent, (await acct(claimPdas.feeRoute(agent), decodeFeeRoute)).githubId));
      if (active & FEATURES.pools) keys.push(...pools.crankRouteKeys(agent, (await acct((await acct(poolPdas.member(agent), decodePoolMember)).pool, decodePool)).repoId, LINE, T22));
      return keys;
    };
    const members3 = [A, B, C];
    for (const m of members3) await trade(m.mint.id, `fork coin ${m.s}`);
    section = "6 older client";
    {
      const eight = await simulated(cranker, pumpCrankIxs({ payer: cranker.id, agent: A.agent.id, agentMint: A.mint.id, lineMint: LINE, lineTokenProgram: T22 }));
      check("the eight-account crank of an agent with a route or a membership is refused (MissingRouteAccounts): nothing is lost, the fees wait", eight.includes("MissingRouteAccounts"));
      const v0 = await four(A.agent.id, GH, repo);
      const t = await keeperRun(headCrank, [{ agent_id: A.agent.id, mint: A.mint.id }]);
      const v1 = await four(A.agent.id, GH, repo);
      out.keeper_committed_on_a_routed_agent = t.trim().split("\n").map((l) => l.slice(0, 260));
      check("the committed keeper script skips such an agent (its simulation fails, it sends nothing): until the keeper on the server is route-aware, a routed agent's fees are not cranked", /skipped, simulation failed/.test(t) && /0 crank\(s\) sent/.test(t)
        && v0.every((x, i) => x === v1[i]), t.trim().split("\n").slice(-2).join(" | ").slice(0, 260));
    }
    section = "5 features";
    const workingCrank = join(import.meta.dir, "crank-fees.ts");
    const routeAware = readFileSync(workingCrank, "utf8").includes("crankRouteKeys");
    out.keeper_working_copy_is_route_aware = routeAware;
    const pcfg = pc;
    for (const [m, ghOf, routeBps] of [[A, GH, 2000], [B, null, 0], [C, GH, 2000]] as const) {
      const b0 = await four(m.agent.id, GH, repo), l0 = (await reader.agentLaunch(m.mint.id))!;
      if (routeAware && m === A) out.keeper_working_copy_on_a_routed_agent = (await keeperRun(workingCrank, [{ agent_id: m.agent.id, mint: m.mint.id }])).trim().split("\n").map((l) => l.slice(0, 260));
      if ((await reader.agentLaunch(m.mint.id))!.feesClaimed === l0.feesClaimed)
        await tx(`crank_pump_fees with route accounts (${m.s}: ${ghOf === null ? "pool" : "GitHub route and pool"})`, cranker, pumpCrankIxs({ payer: cranker.id, agent: m.agent.id, agentMint: m.mint.id, lineMint: LINE, lineTokenProgram: T22, routes: await routesOf(m.agent.id) }));
      const b1 = await four(m.agent.id, GH, repo), fees = (await reader.agentLaunch(m.mint.id))!.feesClaimed - l0.feesClaimed, w = crankSplit(fees, lc3.agentComputeBps, routeBps, pcfg.poolFeeBps);
      check(`routed crank of ${m.s}${routeAware && m === A ? " (sent by the working copy of the keeper script)" : ""}: compute, protocol, GitHub and pool amounts exact; the protocol share is what it is today`, fees > 0n && b1[0] - b0[0] === w.toCompute
        && b1[1] - b0[1] === w.toProtocol && b1[2] - b0[2] === w.toGithub && b1[3] - b0[3] === w.toPool && w.toProtocol === fees - (fees * BigInt(lc3.agentComputeBps)) / 10_000n && w.toPool > 0n && (routeBps === 0) === (w.toGithub === 0n),
        `fees ${fees}: compute ${w.toCompute}, protocol ${w.toProtocol}, GitHub ${w.toGithub}, pool ${w.toPool}`);
    }
    // settlement for the registry's last posted epoch, payout, cross-holdings, buyback, burn
    const rc = await acct(registryPdas.config(), decodeConfig);
    const members = (await acct(poolPdas.pool(repo), decodePool)).members, epoch = Number(rc.lastEpoch);
    const p1 = await acct(poolPdas.pool(repo), decodePool);
    const settle = (by: string) => pools.poolSettle({ keeper: by, repoId: repo, members, epoch, gens: 1, weights: [10_000, 0, 0], milestones: 1, evidence: "11".repeat(32) });
    check("refused: a settlement by the admin (only the keeper settles)", await refusedWith(dev, [settle(dev.id)], "Unauthorized"));
    await tx("pool_settle", keeper, [settle(keeper.id)]);
    const alloc = settlementAllocation(pcfg, { payout: p1.bucketPayout, buyback: p1.bucketBuyback, burn: p1.bucketBurn }, { gens: 1, weights: [10_000, 0, 0], milestones: 1 });
    const ms = await Promise.all(members3.map((m) => acct(poolPdas.member(m.agent.id), decodePoolMember)));
    check(`a settlement for the registry's posted epoch ${epoch} (a live epoch of the copy): each member's payout, buyback and burn equal the offchain recomputation`, ms.every((s, i) => s.payoutDue === alloc[i]!.payout && s.buybackDue === alloc[i]!.buyback
      && s.burnDue === alloc[i]!.burn) && ms[0]!.payoutDue > 0n, ms.map((s, i) => `${members3[i]!.s} ${s.payoutDue}/${s.buybackDue}/${s.burnDue}`).join(", "));
    check("refused: a second settlement for the same epoch", await refusedWith(keeper, [settle(keeper.id)], "PoolEpoch"));
    const cv0 = await bal(launchPdas.computeVault(A.agent.id));
    await tx("pool_pay", cranker, [pools.poolPay({ repoId: repo, agent: A.agent.id, agentMint: A.mint.id, lineMint: LINE })], [], 200_000);
    check("the author's payout reached its compute vault", (await bal(launchPdas.computeVault(A.agent.id))) - cv0 === ms[0]!.payoutDue);
    await airdrop(poolPdas.auth(repo), 100_000_000n);
    await tx("the pool's token accounts (one per member coin)", keeper, members3.map((m) => token.createAtaIdempotent(keeper.id, poolPdas.auth(repo), m.mint.id, T22)), [], 300_000);
    const sizeFor = async (mint: string, budget: bigint) => { const c = await curveOf(mint), n = (budget * 96n) / 100n; return (n * c.virtualTokenReserves) / (c.virtualQuoteReserves + n); };
    const capped = (x: bigint) => (x > pcfg.maxBuyQuote ? pcfg.maxBuyQuote : x);
    await tx("the holder agent's token account for its cross-holding", keeper, [token.createAtaIdempotent(keeper.id, A.agent.id, B.mint.id, T22)], [], 100_000);
    await tx("pool_cross_buy (A holds B; creates CrossHolding)", keeper, [pools.poolCrossBuy({ keeper: keeper.id, repoId: repo, holder: A.agent.id, target: B.agent.id, targetMint: B.mint.id, lineMint: LINE, venue: 0,
      tokenAmount: await sizeFor(B.mint.id, pcfg.crossHoldQuote), maxQuote: pcfg.crossHoldQuote })]);
    check("a cross-holding bought by the pool authority is in the holder agent's own token account, none with the pool", (await bal(poolPdas.heldBy(A.agent.id, B.mint.id))) > 0n && (await bal(poolPdas.holding(repo, B.mint.id))) === 0n,
      `${await bal(poolPdas.heldBy(A.agent.id, B.mint.id))} base units of B for at most ${pcfg.crossHoldQuote} base units of $UNITS`);
    const buy = (t: typeof A, kind: number, tokenAmount: bigint, maxQuote: bigint, by = keeper.id) => pools.poolBuy({ keeper: by, repoId: repo, target: t.agent.id, targetMint: t.mint.id, lineMint: LINE, kind, venue: 0, tokenAmount, maxQuote });
    check("refused: a pool purchase by a key that is not the keeper", await refusedWith(stranger, [buy(B, 1, 1n, 1n, stranger.id)], "Unauthorized"));
    const dueB = capped(ms[1]!.buybackDue), vb0 = await bal(poolPdas.vault(repo, LINE, T22));
    await tx("pool_buy (buyback, held by the pool)", keeper, [buy(B, 1, await sizeFor(B.mint.id, dueB), dueB)]);
    const spentB = vb0 - (await bal(poolPdas.vault(repo, LINE, T22)));
    check("a buyback: spent within the member's due amount and the per-buy cap, the tokens in the pool's own account", spentB > 0n && spentB <= dueB && (await bal(poolPdas.holding(repo, B.mint.id))) === (await acct(poolPdas.member(B.agent.id), decodePoolMember)).tokensHeld
      && (await bal(poolPdas.holding(repo, B.mint.id))) > 0n, `${spentB} base units of $UNITS (cap ${pcfg.maxBuyQuote}, due ${ms[1]!.buybackDue})`);
    const dueA = capped(ms[0]!.burnDue), supply0 = (await acct(A.mint.id, decodeMint)).supply;
    await tx("pool_buy (milestone burn)", keeper, [buy(A, 2, await sizeFor(A.mint.id, dueA), dueA)]);
    const burned = (await acct(poolPdas.member(A.agent.id), decodePoolMember)).tokensBurned;
    check("a milestone burn: the coin's supply fell by exactly the tokens bought", burned > 0n && supply0 - (await acct(A.mint.id, decodeMint)).supply === burned, `${burned} base units burned`);
    // the claim: an attestation by the attestor key, the wallet signs
    {
      const ceiling = await bal(claimPdas.vault(GH)), now = await forkNow(), exp = now + 300;
      const esc0 = await acct(claimPdas.escrow(GH), decodeClaimEscrow);
      const msg = claimMessage({ githubId: GH, wallet: claimer.id, ceiling, claimSeq: esc0.claimSeq, expiresAt: exp });
      const claimIx = claims.claimGithubFees({ wallet: claimer.id, walletToken: ata(claimer.id, LINE, T22), githubId: GH, lineMint: LINE, ceiling, expiresAt: exp });
      await tx("claimer's $UNITS account", claimer, [token.createAtaIdempotent(claimer.id, claimer.id, LINE, T22)], [], 100_000);
      check("refused: a claim attested by the claimant's own key; an attestation that lives longer than 600 s", await refusedWith(claimer, [ed25519Ix(claimer.id, signBytes(claimer, msg), msg), claimIx], "BadAttestation")
        && await (async () => { const e2 = now + 3600, m2 = claimMessage({ githubId: GH, wallet: claimer.id, ceiling, claimSeq: esc0.claimSeq, expiresAt: e2 });
          return refusedWith(claimer, [ed25519Ix(attestor.id, signBytes(attestor, m2), m2), claims.claimGithubFees({ wallet: claimer.id, walletToken: ata(claimer.id, LINE, T22), githubId: GH, lineMint: LINE, ceiling, expiresAt: e2 })], "AttestationTtl"); })());
      await tx("claim_github_fees (Ed25519 attestation + claim)", claimer, [ed25519Ix(attestor.id, signBytes(attestor, msg), msg), claimIx], [], 200_000);
      const esc1 = await acct(claimPdas.escrow(GH), decodeClaimEscrow);
      check("the claim paid the repository's whole escrow (the 20% slices of A and C) to the attested wallet and pinned it", ceiling > 0n && (await bal(ata(claimer.id, LINE, T22))) === ceiling && (await bal(claimPdas.vault(GH))) === 0n && esc1.claimed - esc0.claimed === ceiling
        && esc1.wallet === claimer.id, `${ceiling} base units of $UNITS`);
      check("refused: the same attestation again", await refusedWith(claimer, [ed25519Ix(attestor.id, signBytes(attestor, msg), msg), claimIx], "BadAttestation"));
    }
    // a redirect: pending for 30 days
    await tx("set_fee_route again (a redirect: pending)", A.launcher, [claims.setFeeRoute({ owner: A.launcher.id, agent: A.agent.id, agentMint: A.mint.id, lineMint: LINE, githubId: GH + 1, bps: 2000 })]);
    {
      const fr = await acct(claimPdas.feeRoute(A.agent.id), decodeFeeRoute), now = await forkNow();
      check("a redirect is only pending: the route still names the repository, the change takes effect 30 days later and apply_fee_route is refused until then", fr.githubId === BigInt(GH) && fr.pendingGithubId === BigInt(GH + 1)
        && Number(fr.pendingEffectiveAt) - now > 2_591_000 && Number(fr.pendingEffectiveAt) - now <= 2_592_000 && await refusedWith(cranker, [claims.applyFeeRoute({ agent: A.agent.id })], "RouteTimelock"), `effective in ${Number(fr.pendingEffectiveAt) - now} s`);
    }

    // ---------------------------------------------------------------- 7 the bits off again
    section = "7 switch off";
    const off = lf(["features", "--key", keyPath("dev-wallet-stand-in"), "--set", "none", "--send", "--unconfirmed-ok"]);
    await trade(A.mint.id, "fork coin a (bits off)");
    {
      const b0 = await four(A.agent.id, GH, repo), l0 = (await reader.agentLaunch(A.mint.id))!;
      const t = await keeperRun(headCrank, [{ agent_id: A.agent.id, mint: A.mint.id }]);
      const b1 = await four(A.agent.id, GH, repo), fees = (await reader.agentLaunch(A.mint.id))!.feesClaimed - l0.feesClaimed, w = crankSplit(fees, lc3.agentComputeBps);
      check("set_features(0) is the switch back: the routed agent is cranked by the committed keeper with eight accounts, today's two amounts to the unit, nothing routed; its route and membership stay recorded", off.status === 0 && fees > 0n
        && b1[0] - b0[0] === w.toCompute && b1[1] - b0[1] === w.toProtocol && b1[2] === b0[2] && b1[3] === b0[3] && (await reader.agentLaunch(A.mint.id))!.routes === 3, `fees ${fees}; ${t.trim().split("\n").slice(-1)[0]!.slice(0, 120)}`);
    }
    check("with the bits off a new route or membership is refused again", await refusedWith(B.launcher, [claims.setFeeRoute({ owner: B.launcher.id, agent: B.agent.id, agentMint: B.mint.id, lineMint: LINE, githubId: GH, bps: 2000 })], "FeatureOff"));
    const final = await launchAccounts();
    let bad2 = "";
    const kinds: Record<string, number> = {};
    for (const a of final.values()) { try { if (typeOf(a.data) !== "CrossHolding") decodeAny(a.data); kinds[typeOf(a.data)] = (kinds[typeOf(a.data)] ?? 0) + 1; } catch (e) { bad2 += `${a.address}: ${(e as Error).message}; `; } }
    check("at the end every launch program account decodes, old and new kinds side by side", !bad2 && !("unknown" in kinds), bad2 || Object.entries(kinds).map(([t, n]) => `${n} ${t}`).join(", "));
  } finally {
    stub.stop(true);
    rmSync(headCrank, { force: true });
  }
} catch (e) {
  outcome = `FAIL: ${(e as Error).message}`;
  console.error(e);
}
const failed = checks.filter((c) => !c.ok);
if (failed.length && outcome === "PASS") outcome = `FAIL: ${failed.length} check${failed.length === 1 ? "" : "s"} failed`;
out.outcome = outcome;
out.finished = new Date().toISOString();
out.sections = sections;
out.passed = checks.filter((c) => c.ok).length;
out.total = checks.length;
out.instructions = sizes;
out.checks = checks;
out.transactions = rows.length;
writeFileSync(OUT_FILE, JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
log(`${outcome}: ${out.passed}/${out.total} checks (besides them, the wizard launch proof's own: ${(out.wizard_launch?.checks ?? []).filter((c: { ok: boolean }) => c.ok).length}/${(out.wizard_launch?.checks ?? []).length}); ${rows.length} transactions measured`);
process.exit(outcome === "PASS" ? 0 : 1);
