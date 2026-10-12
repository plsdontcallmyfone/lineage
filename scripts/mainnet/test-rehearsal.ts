#!/usr/bin/env bun
// The mainnet TEST, rehearsed end to end on a local fork of mainnet (scripts/mainnet/fork.sh) with
// the operator commands themselves (scripts/mainnet/test.ts): docs/MAINNET-RUNBOOK.md "Mainnet test
// (single key, throwaway quote coin)". Nothing is sent to mainnet and no real key signs anything but
// the three mainnet-test program id keypairs, which sign their deploys on this local fork only. Mainnet is
// read for rent, the programs' bytes and Jito's public tip accounts and tip floor.
//
//   0  the fork runs mainnet's pump.fun and Token-2022 builds; the three test ids are empty; the mainnet-test builds embed only them
//   1  test.ts keys, coin (create_v2 SOL-paired + a small buy), deploy, init (admin = the deployer), fund
//   2  one agent launched as the wizard plans it on mainnet for this test: create_v2 quoted in the test coin +
//      register_pump_launch, the soul, SOL to the test coin on its curve, the 1% initial buy, the credits +
//      wake, the units account payment and the Jito tip, packed by planLaunchBundle and signed on one blockhash
//   3  a verifier registered and bonded by the site owner key, a trade from SOL (multi_hop_swap through both
//      curves) and a sell, a fee crank, a split and an epoch post
//   4  test.ts close (sweep the hot keys, sell the test coin, close the three programs), then a redeploy
//      at a closed id is refused
// Every cost is recorded at mainnet rent (lib.ts measure). The deployer's ledger gives the SOL it must
// hold at the peak, what is spent and what comes back. Writes scripts/mainnet/TEST-REHEARSAL-LAST.json.
//
//   UNITS_NETWORK=mainnet MAINNET_FORK_KEYS=<throwaway key dir> bun scripts/mainnet/test-rehearsal.ts
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalUrl, H, merkleRoot } from "@units/protocol";
import {
  addressBytes,
  ata,
  ChainReader,
  compileMessage,
  compileMessageV0,
  computeBudget,
  decodeBondingCurve,
  decodeLookupTable,
  decodePumpEvent,
  decodePumpFeeConfig,
  decodePumpGlobal,
  IDENTITY_MODE,
  initialBuyAmount,
  jitoTipIx,
  JITO_BLOCK_ENGINE,
  JITO_MAX_TXS,
  JITO_TIP_FLOOR,
  launch,
  launchPdas,
  launchSolCosts,
  maxBuyInput,
  maxSolIn,
  parsePrepayConfig,
  payoutLeaf,
  planLaunchBundle,
  PROGRAM_IDS,
  programDataAddress,
  PUMP,
  pump,
  pumpAmm,
  pumpCrankIxs,
  pumpInitialBuy,
  pumpLaunchMain,
  pumpPdas,
  pumpQuotedCurve,
  pumpSolToLine,
  quoteCurveBuyExactOut,
  quoteInitialBuy,
  registry,
  registryPdas,
  requiredCredits,
  signMessageWith,
  system,
  tipFromFloor,
  token,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  wireSize,
  type BundleGroup,
  type Ix,
  type Signer,
} from "@units/chain";
import { base58Decode } from "@units/protocol";
import { checkEndpoint, parseLaunchParams, programIdsNow } from "./steps.ts";
import { sellTestCoin, sweepKey, TEST_BUILD_DIR, TEST_PROGRAM_KEYS, useTestProfile } from "./test-steps.ts";
import { airdrop, assertFork, check, checks, fork, FORK_URL, forkKey, forkRent, KEYS, log, mainnet, mainnetRent, measure, rows, send, sleep, sol, type CostRow } from "./lib.ts";

const ROOT = join(import.meta.dir, "..", "..");
const T22 = TOKEN_2022_PROGRAM;
const profile = useTestProfile();
const IDS = programIdsNow();
const PROGRAM_KEYS = TEST_PROGRAM_KEYS;
const DEPLOY = TEST_BUILD_DIR;
const names = ["registry", "launch", "msg"] as const;
const reader = new ChainReader(fork);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const trimZeros = (b: Uint8Array) => {
  let n = b.length;
  while (n > 0 && b[n - 1] === 0) n--;
  return b.subarray(0, n);
};
const out: Record<string, unknown> = { started: new Date().toISOString(), fork: FORK_URL, profile: profile.network, program_ids: IDS, params: "scripts/mainnet/test-params.json" };

// The values of this run (choices, not measurements): how much the deployer puts into the test coin and the hot keys.
const COIN = { name: "units mainnet test (fork)", symbol: "UTEST", uri: "https://units.invalid/fork/test-coin.json" };
const COIN_BUY_SOL = "0.05";
const HOT_SOL = "0.05";
const OWNER_SOL = "0.05";
const OWNER_COINS = "20";
const LAUNCHER_SOL = 500_000_000n;
const TRADE_SOL = 20_000_000n;

// ---------------------------------------------------------------- keys (throwaway, except the program id keypairs)
const dep = forkKey("deployer");
const launcher = forkKey("launcher"); // stands for the owner's browser wallet
const agent = forkKey("agent");
const agentMint = forkKey(`agent-mint-${Date.now()}`);
const siteOwner = forkKey("site-owner"); // stands for the site instance's owner key (made on the server), which registers its verifiers
const verifier = forkKey("verifier");
const LOGF = join(KEYS, "test-cli.jsonl");
const OUT_DIR = join(KEYS, "out");
mkdirSync(OUT_DIR, { recursive: true });
if (process.env.TEST_REHEARSAL_FROM !== "2") writeFileSync(LOGF, "");

// ---------------------------------------------------------------- the deployer's ledger at mainnet rent
// Positive: lamports leaving the deployer; negative: lamports coming back. The peak it must hold is the
// largest running total; what it spends is the final total.
const ledger: { what: string; lamports: string; running: string }[] = [];
let running = 0n, peak = 0n, peakAt = "";
function book(what: string, lamports: bigint) {
  running += lamports;
  if (running > peak) {
    peak = running;
    peakAt = what;
  }
  ledger.push({ what, lamports: lamports.toString(), running: running.toString() });
}

// ---------------------------------------------------------------- the operator CLI against the fork
let logAt = 0;
function cliLog(): Record<string, any>[] {
  const lines = readFileSync(LOGF, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const fresh = lines.slice(logAt);
  logAt = lines.length;
  return fresh;
}
function testCli(args: string[], o: { expectFail?: boolean } = {}): string {
  const r = spawnSync("bun", [join(import.meta.dir, "test.ts"), ...args, "--rpc", FORK_URL, "--keys", KEYS, "--program-keys", PROGRAM_KEYS, "--out", OUT_DIR, "--log", LOGF],
    { encoding: "utf8", env: { ...process.env, UNITS_NETWORK: "mainnet" } });
  const text = `${r.stdout}${r.stderr}`;
  if (!o.expectFail && r.status !== 0) throw new Error(`test.ts ${args[0]} failed: ${text.slice(-900)}`);
  if (o.expectFail && r.status === 0) throw new Error(`test.ts ${args[0]} was expected to refuse`);
  return text;
}
/** Measures every transaction the last CLI command sent (by the deployer) and books it. */
async function bookCli(step: string): Promise<CostRow[]> {
  const got: CostRow[] = [];
  for (const e of cliLog()) {
    if (!e.signature) continue;
    const c = await measure(step, e.what, e.signature);
    got.push(c);
    if (c.payer === dep.id) book(e.what, /^fund /.test(e.what) ? faceValue(c) : BigInt(c.payerMainnet));
  }
  return got;
}
/**
 * A funding transfer at mainnet rent: SOL sent to a wallet is face value (a wallet that had no lamports
 * is not an account being created at a rent price), and only accounts with data (a token account made
 * for the recipient) are converted from the fork's rent to mainnet's.
 */
function faceValue(c: CostRow): bigint {
  const data = c.created.filter((x) => x.bytes > 0);
  const forkData = data.reduce((a, x) => a + BigInt(x.forkRent), 0n), mainData = data.reduce((a, x) => a + BigInt(x.mainnetRent), 0n);
  return BigInt(c.payerDeltaFork) - forkData + mainData;
}
const pubkeyOf = (p: string) => spawnSync("solana-keygen", ["pubkey", p], { encoding: "utf8" }).stdout.trim();
async function programBytes(rpc: typeof fork, program: string): Promise<Uint8Array> {
  const pd = await rpc.getAccountInfo(programDataAddress(program));
  if (!pd) throw new Error(`no ProgramData for ${program}`);
  return pd.data.subarray(45);
}

// ---------------------------------------------------------------- 0: the fork
async function step0() {
  await assertFork();
  await checkEndpoint(fork, profile, { deployed: false, local: true });
  const has = (hay: Uint8Array, id: string) => Buffer.from(hay).indexOf(Buffer.from(addressBytes(id))) >= 0;
  const builds: Record<string, unknown> = {};
  for (const n of names) {
    const so = readFileSync(join(DEPLOY, `units_${n}.so`));
    check(`0: ${n} build embeds the mainnet-test ids only (no devnet id, no mainnet id)`, has(so, IDS[n]) && ![...Object.values(PROGRAM_IDS.devnet), ...Object.values(PROGRAM_IDS.mainnet)].some((id) => has(so, id)), `${so.length} bytes, sha256 ${sha(so)}`);
    check(`0: ${n} id keypair is ${IDS[n].slice(0, 6)}...`, pubkeyOf(join(PROGRAM_KEYS, `${n}-program-keypair.json`)) === IDS[n]);
    check(`0: no program at ${IDS[n].slice(0, 6)}... on the fork yet`, (await fork.getAccountInfo(IDS[n])) === null);
    builds[n] = { so_bytes: so.length, so_sha256: sha(so) };
  }
  out.builds = builds;
  for (const n of names) check(`0: the launch's mainnet id ${PROGRAM_IDS.mainnet[n].slice(0, 6)}... is not used on the fork`, (await fork.getAccountInfo(PROGRAM_IDS.mainnet[n])) === null);
  const pumpBuilds: Record<string, string> = {};
  for (const [name, id] of [["Pump", PUMP.program], ["PumpSwap", PUMP.amm], ["Pump Fees", PUMP.fees], ["Token-2022", T22]] as const) {
    const [f, m] = [trimZeros(await programBytes(fork, id)), trimZeros(await programBytes(mainnet, id))];
    pumpBuilds[name] = sha(m);
    check(`0: fork ${name} is mainnet's build`, sha(f) === sha(m), sha(m).slice(0, 16));
  }
  out.mainnet_builds = pumpBuilds;
  const g = decodePumpGlobal((await mainnet.getAccountInfo(PUMP.global))!.data);
  check("0: mainnet pump.fun Global.max_curve_depth is 1 or more", g.maxCurveDepth >= 1, `${g.maxCurveDepth}`);
  // fork SOL only: far more than the test needs, because the fork charges more rent than mainnet; the ledger below is at mainnet rent
  await airdrop(dep.id, 100n * 10n ** 9n);
}

// ---------------------------------------------------------------- 1: keys, coin, deploy, init, fund (the operator commands)
async function step1() {
  testCli(["keys", "--backup", join(KEYS, "backup"), "--program-backup", join(KEYS, "backup")]);
  check("1: keys: hot keys and the coin mint key made (mode 600) and every key file backed up",
    ["core-authority", "runtime-authority", "test-coin-mint", "deployer"].every((n) => existsSync(join(KEYS, "backup", `${n}.json`))) &&
    names.every((n) => existsSync(join(KEYS, "backup", `${n}-program-keypair.json`))));
  cliLog();

  testCli(["coin", "--name", COIN.name, "--symbol", COIN.symbol, "--uri", COIN.uri, "--buy-sol", COIN_BUY_SOL]);
  const coinRows = await bookCli("1 coin");
  const coinMint = pubkeyOf(join(KEYS, "test-coin-mint.json"));
  const c = decodeBondingCurve((await fork.getAccountInfo(pumpPdas.bondingCurve(coinMint)))!.data);
  const held = (await reader.tokenBalance(ata(dep.id, coinMint, T22)))!;
  check("1: test coin created on pump.fun: SOL-paired, depth 0, not mayhem, creator the deployer; the deployer holds the bought coins",
    c.quoteMint === "11111111111111111111111111111111" && c.depth === 0 && !c.isMayhemMode && c.creator === dep.id && held > 0n, `${held} base units for ${COIN_BUY_SOL} SOL at most`);
  out.test_coin = { mint: coinMint, symbol: COIN.symbol, buy_sol_max: COIN_BUY_SOL, held_base_units: held.toString(),
    create_mainnet_lamports: coinRows[0]!.payerMainnet, buy_mainnet_lamports: coinRows[1]!.payerMainnet, buy_created: coinRows[1]!.created };

  // deploy: the CLI runs write-buffer + deploy per program; each is booked as buffer funded, then ProgramData and program funded with the buffer refunded
  const b0 = await fork.getBalance(dep.id);
  testCli(["deploy"]);
  const deploys: Record<string, unknown> = {};
  let before = b0;
  for (const e of cliLog()) {
    if (!e.program) continue;
    const name = names.find((n) => IDS[n] === e.program)!;
    const pd = (await fork.getAccountInfo(programDataAddress(e.program)))!, prog = (await fork.getAccountInfo(e.program))!;
    const sigs = await fork.call<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [e.buffer, { limit: 1000, commitment: "confirmed" }]);
    let fees = 0n, cu = 0n, deployFee = 0n;
    for (const s of sigs) {
      const t = await fork.call<{ meta: { fee: number; computeUnitsConsumed?: number } }>("getTransaction", [s.signature, { encoding: "json", commitment: "confirmed" }]);
      fees += BigInt(t.meta.fee);
      cu += BigInt(t.meta.computeUnitsConsumed ?? 0);
      if (s === sigs[0]) deployFee = BigInt(t.meta.fee); // newest first: the deploy transaction
    }
    const [mBuf, mPd, mProg] = [await mainnetRent(e.buffer_bytes), await mainnetRent(pd.data.length), await mainnetRent(prog.data.length)];
    const [fPd, fProg] = [await forkRent(pd.data.length), await forkRent(prog.data.length)];
    deploys[name] = { program_id: e.program, so_bytes: e.so_bytes, so_sha256: e.so_sha256, buffer_bytes: e.buffer_bytes, programdata_bytes: pd.data.length, program_bytes: prog.data.length,
      transactions: sigs.length, fees_lamports: fees.toString(), compute_units_all_transactions: cu.toString(),
      mainnet_rent: { buffer: mBuf.toString(), programdata: mPd.toString(), program: mProg.toString() },
      fork_rent: { programdata: fPd.toString(), program: fProg.toString() } };
    book(`deploy ${name}: buffer funded and written (${sigs.length - 1} transactions)`, mBuf + fees - deployFee);
    book(`deploy ${name}: ProgramData and program account funded while the buffer is still funded`, mPd + mProg + deployFee);
    book(`deploy ${name}: buffer rent refunded`, -mBuf);
    check(`1: ${name} deployed at ${e.program.slice(0, 6)}... by test.ts deploy, every transaction succeeded`, sigs.every((s) => !s.err) && sha(trimZeros((await programBytes(fork, e.program)))) === sha(trimZeros(readFileSync(join(DEPLOY, `units_${name}.so`)))),
      `ProgramData ${pd.data.length} bytes, ${sigs.length} transactions, fees ${fees}`);
    before -= fPd + fProg + fees;
  }
  check("1: the deployer's fork balance fell by exactly ProgramData rent + program rent + fees over the three deploys", (await fork.getBalance(dep.id)) === before);
  out.deploys = deploys;
  const again = testCli(["deploy"]);
  check("1: deploy run again skips all three (already deployed, code equals the build)", (again.match(/PASS \w+: already deployed/g) ?? []).length === 3 && cliLog().length === 0);

  testCli(["init", "--symbol", COIN.symbol]);
  const initRows = await bookCli("1 init");
  out.init = initRows.map((r) => ({ what: r.what, mainnet_lamports: r.payerMainnet, compute_units: r.computeUnits, created: r.created.map((x) => x.bytes) }));
  const state = JSON.parse(readFileSync(join(OUT_DIR, "mainnet.json"), "utf8"));
  const overlay = JSON.parse(readFileSync(join(OUT_DIR, "profile.local.json"), "utf8"));
  const cfg = (await reader.registryConfig())!, lc = (await reader.launchConfig())!;
  check("1: initialized with the deployer as every admin; state file and profile overlay written",
    cfg.admin === dep.id && lc.admin === dep.id && cfg.mint === coinMint && state.line_mint === coinMint && state.admin === dep.id && overlay.profiles.mainnet.quote.mint === coinMint && overlay.profiles.mainnet.swap === false,
    `lookup table ${state.launch_lookup_table}`);
  const init2 = testCli(["init", "--symbol", COIN.symbol]);
  check("1: init run again sends nothing", cliLog().length === 0 && !/FAIL/.test(init2));
  const chk = testCli(["check"]);
  check("1: test.ts check passes (admins, upgrade authorities, quote coin, table)", !/FAIL/.test(chk) && (chk.match(/PASS/g) ?? []).length >= 9);

  testCli(["fund", "--core", HOT_SOL, "--runtime", HOT_SOL]);
  await bookCli("1 fund");
  out.hot_keys = { core_authority: state.core_authority, runtime_authority: state.runtime_authority, funded_sol_each: HOT_SOL };
  check("1: the state file sends the units account payment to the deployer (not to the devnet treasury key of config/network.json)", state.network_overrides?.prepay?.identity_account_recipient === dep.id);
  // the site instance's owner key registers and bonds its verifiers: SOL and a few test coins from the deployer
  testCli(["fund", "--to", siteOwner.id, "--sol", OWNER_SOL, "--coin", OWNER_COINS]);
  const ownerRow = (await bookCli("1 fund owner"))[0]!;
  check("1: the site owner key holds its SOL and test coins", (await reader.tokenBalance(ata(siteOwner.id, coinMint, T22))) === BigInt(OWNER_COINS) * 1_000_000n && (await fork.getBalance(siteOwner.id)) === BigInt(Math.round(Number(OWNER_SOL) * 1e9)),
    `${OWNER_SOL} SOL, ${OWNER_COINS} test coins; the transfer cost the deployer ${sol(faceValue(ownerRow) - BigInt(Math.round(Number(OWNER_SOL) * 1e9)))} SOL beyond the SOL sent (its fee and the recipient's token account)`);
  return { coinMint, state, table: state.launch_lookup_table as string };
}

// ---------------------------------------------------------------- 2: one launch as the wizard plans it
async function jito(): Promise<{ accounts: string[]; tip: bigint }> {
  const a = await fetch(JITO_BLOCK_ENGINE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTipAccounts", params: [] }) }).then((r) => r.json()) as { result?: string[] };
  const floor = await fetch(JITO_TIP_FLOOR).then((r) => r.json());
  if (!a.result?.length) throw new Error("Jito gave no tip accounts");
  return { accounts: a.result, tip: tipFromFloor(floor) };
}
const signerFor = (ixs: Ix[], pool: Signer[]) => pool.filter((k) => ixs.some((ix) => ix.keys.some((m) => m.isSigner && m.pubkey === k.id)));

async function step2(coinMint: string, tableAddr: string, P: ReturnType<typeof parseLaunchParams>) {
  const s = await send("2", `fund the launcher (the owner's wallet in the test) with ${sol(LAUNCHER_SOL)} SOL`, dep, [system.transfer(dep.id, launcher.id, LAUNCHER_SOL)]);
  book("fund the launcher wallet", LAUNCHER_SOL + BigInt(s.cost.fee)); // a transfer: face value plus its fee
  const prepay = parsePrepayConfig(P.net.prepay);
  const [gA, fcA, cA, bA] = await fork.getMultipleAccounts([PUMP.global, PUMP.feeConfig, pumpPdas.bondingCurve(coinMint), ata(pumpPdas.bondingCurve(coinMint), coinMint, T22)]);
  const g = decodePumpGlobal(gA!.data), fc = decodePumpFeeConfig(fcA!.data), coinCurve = decodeBondingCurve(cA!.data);
  const base = (await reader.tokenBalance(ata(pumpPdas.bondingCurve(coinMint), coinMint, T22)))!;
  void bA;
  // the same figures the wizard computes (apps/web/wallet/main.ts, pump-venue.ts, fronting.ts)
  const deposit = requiredCredits(prepay, P.line_decimals);
  const amountOut = initialBuyAmount(g.tokenTotalSupply, prepay.initial_buy_bps);
  const fresh = pumpQuotedCurve(g, { curve: coinCurve }, launchPdas.pumpCreator(agent.id), coinMint, 0n, profile.pump_quote_seed);
  const quote = quoteInitialBuy(g, fc, fresh, amountOut);
  const maxIn = maxBuyInput(quote, prepay.initial_buy_slippage_bps);
  const need = deposit + maxIn;
  const whole = quoteCurveBuyExactOut(g, fc, coinCurve, need, base);
  const maxSol = maxSolIn(whole.quoteIn, prepay.initial_buy_slippage_bps);
  const identity = BigInt(prepay.identity_account_price_lamports);
  const { accounts, tip } = await jito();
  const tipIx = jitoTipIx(launcher.id, accounts, tip);
  // fork only: Jito's tip accounts exist on mainnet; here the picked one is given lamports so a small transfer to it is rent-exempt
  await airdrop(tipIx.keys[1]!.pubkey, 10n ** 9n);
  const soulDigest = H("soul", "fork rehearsal");
  const groups: BundleGroup[] = [
    { name: "launch", ixs: pumpLaunchMain({ launcher: launcher.id, agent: agent.id, agentMint: agentMint.id, line: { mint: coinMint, tokenProgram: T22 }, name: "Mainnet test agent (fork)", symbol: "MTA",
      uri: "https://units.invalid/fork/mta.json", args: { repoUrl: canonicalUrl("https://github.com/karpathy/minbpe"), identityMode: IDENTITY_MODE.purchased, hosted: true } }) },
    { name: "soul", ixs: [registry.setProfile({ signingKey: agent.id, agent: agent.id, digest: soulDigest, seq: 1 })] },
    { name: "sol-to-units", ixs: pumpSolToLine({ launcher: launcher.id, lineMint: coinMint, amountOut: need, maxSolIn: maxSol, lineTokenProgram: T22 }) },
    { name: "initial-buy", ixs: pumpInitialBuy({ launcher: launcher.id, agent: agent.id, agentMint: agentMint.id, lineMint: coinMint, amountOut, maxIn, lineTokenProgram: T22,
      createBuyback: !(await fork.getAccountInfo(ata(PUMP.buybackRecipients[0], coinMint, T22))) }) },
    { name: "credits", ixs: launch.prepay({ launcher: launcher.id, agent: agent.id, agentMint: agentMint.id, lineMint: coinMint, amount: deposit, decimals: P.line_decimals, lineTokenProgram: T22 }) },
    { name: "units-account", ixs: [system.transfer(launcher.id, dep.id, identity)] },
    { name: "tip", ixs: [tipIx] },
  ];
  const t = decodeLookupTable((await fork.getAccountInfo(tableAddr))!.data);
  const table = { address: tableAddr, addresses: t.addresses };
  // the wizard's budget instructions: a compute unit limit and a price (the price is the market's on mainnet; the fork runs at 1 micro-lamport)
  const budget = (units: number) => [computeBudget.limit(units), computeBudget.price(1)];
  const plan = planLaunchBundle({ payer: launcher.id, groups, budget: budget(450_000), table, v0: true, maxTxs: JITO_MAX_TXS });
  check("2: the launch packs into at most 5 transactions (one Jito bundle), launch first", plan.length <= JITO_MAX_TXS && plan[0]!.groups[0] === "launch",
    plan.map((x) => `${x.groups.join(" + ")} (${x.size} bytes${x.table ? ", v0" : ""})`).join("; "));
  // one approval: every transaction on one blockhash, signed before any is sent
  const { blockhash } = await fork.getLatestBlockhash();
  const signed = plan.map((x) => {
    const units = x.groups.includes("launch") ? 450_000 : 400_000;
    const ixs = [...budget(units), ...x.ixs];
    const msg = x.table ? compileMessageV0(launcher.id, ixs, blockhash, [x.table]) : compileMessage(launcher.id, ixs, blockhash);
    const size = wireSize({ bytes: msg.bytes, numSigners: msg.numSigners });
    return { ...x, units, size, tx: signMessageWith(msg, [launcher, ...signerFor(ixs, [agent, agentMint])]) };
  });
  const l0 = await fork.getBalance(launcher.id), d0 = await fork.getBalance(dep.id);
  const costs: CostRow[] = [];
  for (const [i, x] of signed.entries()) {
    const sim = await fork.simulate(x.tx.wire);
    if (sim.err) {
      for (const l of (sim.logs ?? []).slice(-25)) console.error(`    ${l}`);
      throw new Error(`launch transaction ${i + 1} (${x.groups.join(" + ")}) failed in simulation: ${JSON.stringify(sim.err)}`);
    }
    await fork.sendRawTransaction(x.tx.wire, true);
    let ok = false;
    for (let k = 0; k < 120 && !ok; k++) {
      await sleep(500);
      if (k % 4 === 3) await fork.sendRawTransaction(x.tx.wire, true).catch(() => undefined);
      const [st] = await fork.getSignatureStatuses([x.tx.signature]);
      if (st?.err) throw new Error(`launch transaction ${i + 1} failed: ${JSON.stringify(st.err)}`);
      ok = !!st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized");
    }
    if (!ok) throw new Error(`launch transaction ${i + 1} was not confirmed`);
    const c = await measure("2", `launch tx ${i + 1}/${signed.length}: ${x.groups.join(" + ")} (${x.size} bytes${x.table ? ", v0" : ""})`, x.tx.signature);
    log(`2: ${c.what}: fee ${c.fee}, payer mainnet ${sol(BigInt(c.payerMainnet))} SOL, ${c.computeUnits} CU`);
    costs.push(c);
  }
  const la = (await reader.agentLaunch(agentMint.id))!;
  const ac = decodeBondingCurve((await fork.getAccountInfo(pumpPdas.bondingCurve(agentMint.id)))!.data);
  check("2: the agent is registered in the create_v2 transaction: venue pump, curve creator = its PDA, quoted in the test coin, depth 1",
    la.venue === "pump" && ac.creator === launchPdas.pumpCreator(agent.id) && ac.quoteMint === coinMint && ac.depth === 1 && !!(await reader.agent(agent.id)));
  check("2: the 1% initial buy is in the agent key's account, exactly", (await reader.tokenBalance(ata(agent.id, agentMint.id, T22))) === amountOut, `${amountOut} base units, quote ${quote} test coin base units, max ${maxIn}`);
  check("2: the credits are in the compute vault and the agent is awake", (await reader.tokenBalance(launchPdas.computeVault(agent.id))) === deposit && la.awake === true, `${deposit} base units`);
  check("2: the soul digest is on chain", (await reader.agent(agent.id))!.profileDigest === soulDigest);
  check("2: the units account payment reached its recipient", (await fork.getBalance(dep.id)) - d0 === identity, `${identity} lamports`);
  book("units account payment received (its recipient is the deployer in the test)", -identity);
  const spentFork = l0 - (await fork.getBalance(launcher.id));
  const spentMainnet = costs.reduce((a, c) => a + BigInt(c.payerMainnet), 0n);
  const fees = costs.reduce((a, c) => a + BigInt(c.fee), 0n);
  const rent = costs.reduce((a, c) => a + c.created.reduce((b, x) => b + BigInt(x.mainnetRent), 0n), 0n);
  const sums = launchSolCosts({ creation: fees + rent, credits: 0n, buy: null, identity, tip });
  out.launch = {
    agent: agent.id, mint: agentMint.id, transactions: signed.map((x, i) => ({ groups: x.groups, bytes: x.size, v0: !!x.table, compute_unit_limit: x.units, compute_units: costs[i]!.computeUnits,
      signature: x.tx.signature, payer_mainnet_lamports: costs[i]!.payerMainnet, created_bytes: costs[i]!.created.map((c) => c.bytes) })),
    credits_base_units: deposit.toString(), initial_buy: { tokens: amountOut.toString(), quote_base_units: quote.toString(), max_in: maxIn.toString() },
    sol_to_test_coin: { test_coin_base_units: need.toString(), quote_lamports: whole.quoteIn.toString(), max_lamports: maxSol.toString() },
    units_account_lamports: identity.toString(), jito_tip_lamports: tip.toString(), jito_tip_read: new Date().toISOString(),
    fees_lamports: fees.toString(), rent_mainnet_lamports: rent.toString(), creation_lamports: sums.creation.toString(),
    launcher_spent_mainnet_lamports: spentMainnet.toString(), launcher_spent_fork_lamports: spentFork.toString(),
    priority_fee_bound_lamports_at_profile_cap: profile.fees.mode === "recent" ? ((BigInt(signed.reduce((a, x) => a + x.units, 0)) * BigInt(profile.fees.cap_micro_lamports)) / 1_000_000n).toString() : null,
    not_on_a_fork: "the Jito bundle itself (all or nothing in one slot): the same signed transactions were sent in order instead",
  };
  return { costs, spentMainnet };
}

// ---------------------------------------------------------------- 3: a verifier, a trade, a crank, an epoch post
let ownerSpent = 0n;
async function step3(coinMint: string, P: ReturnType<typeof parseLaunchParams>) {
  const launcherCosts: CostRow[] = [];
  const core = forkKey("core-authority");
  // one of the instance's verifiers, registered and bonded by the site owner key (the kit's `chain` step sends the same instructions)
  const ownerCoin = ata(siteOwner.id, coinMint, T22);
  const reg = await send("3", "register a verifier (burns register_burn; 2 signatures)", siteOwner, [
    registry.register({ owner: siteOwner.id, agent: verifier.id, mint: coinMint, ownerToken: ownerCoin, operator: H("operator", "fork"), capabilities: "00".repeat(32), tokenProgram: T22 })], { signers: [verifier] });
  const bond = await send("3", "bond min_bond", siteOwner, [registry.bond({ owner: siteOwner.id, agent: verifier.id, mint: coinMint, ownerToken: ownerCoin, amount: P.params.minBond, tokenProgram: T22 })]);
  const va = (await reader.agent(verifier.id))!;
  check("3: a verifier is registered and bonded by the site owner key, paid in the test coin", va.bond === P.params.minBond, `burn ${P.params.registerBurn}, bond ${P.params.minBond} base units`);
  out.verifier = { register_mainnet_lamports: reg.cost.payerMainnet, bond_mainnet_lamports: bond.cost.payerMainnet, register_burn_base_units: P.params.registerBurn.toString(), min_bond_base_units: P.params.minBond.toString() };
  ownerSpent = BigInt(reg.cost.payerMainnet) + BigInt(bond.cost.payerMainnet);
  const buy = await send("3", `trade: multi_hop_swap ${sol(TRADE_SOL)} SOL -> test coin curve -> agent coin curve`, launcher, [
    token.createAtaIdempotent(launcher.id, launcher.id, PUMP.wsol, TOKEN_PROGRAM), token.createAtaIdempotent(launcher.id, launcher.id, agentMint.id, T22),
    pumpAmm.multiHopSwap({ user: launcher.id, userIn: ata(launcher.id, PUMP.wsol, TOKEN_PROGRAM), userOut: ata(launcher.id, agentMint.id, T22), amountIn: TRADE_SOL, minOut: 1n,
      buybackQuoteMint: PUMP.wsol, hops: [{ kind: "curve", mint: coinMint, quoteMint: PUMP.wsol }, { kind: "curve", mint: agentMint.id, quoteMint: coinMint, quoteTokenProgram: T22 }] })],
    { computeUnits: 400_000 });
  launcherCosts.push(buy.cost);
  const got = (await reader.tokenBalance(ata(launcher.id, agentMint.id, T22)))!;
  const t = await fork.call<{ meta: { innerInstructions: { instructions: { data: string }[] }[] } }>("getTransaction", [buy.signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
  const trades = (t.meta.innerInstructions ?? []).flatMap((x) => x.instructions.map((i) => decodePumpEvent(base58Decode(i.data)))).filter((e) => e?.name === "TradeEvent").length;
  check("3: the SOL buy went through both curves (two TradeEvents) and delivered agent coins", trades === 2 && got > 0n, `${got} base units`);
  const sell = await send("3", "trade: sell_v3 half of the agent coins for the test coin", launcher,
    [pump.sellV3({ mint: agentMint.id, quoteMint: coinMint, quoteTokenProgram: T22, user: launcher.id, amount: got / 2n, minQuoteOut: 1n })], { computeUnits: 300_000 });
  launcherCosts.push(sell.cost);
  const waiting = decodeBondingCurve((await fork.getAccountInfo(pumpPdas.bondingCurve(agentMint.id)))!.data).creatorFee;
  const vault = launchPdas.computeVault(agent.id);
  const [c0, t0] = await reader.tokenBalances([vault, registryPdas.treasury()]);
  const crank = await send("3", "fee crank: pump.fun sweep + collect, then crank_pump_fees (anyone)", launcher,
    pumpCrankIxs({ payer: launcher.id, agent: agent.id, agentMint: agentMint.id, lineMint: coinMint, lineTokenProgram: T22 }), { computeUnits: 600_000 });
  launcherCosts.push(crank.cost);
  const [c1, t1] = await reader.tokenBalances([vault, registryPdas.treasury()]);
  const lc = (await reader.launchConfig())!;
  const computeShare = (waiting * BigInt(lc.agentComputeBps)) / 10_000n;
  check("3: the crank paid exactly the waiting creator fees, split between the agent's compute vault and the treasury", waiting > 0n && c1! - c0! === computeShare && t1! - t0! === waiting - computeShare,
    `${waiting} test coin base units: ${computeShare} / ${waiting - computeShare}`);
  const sp = await send("3", "registry split (treasury to reserve and pool, anyone)", launcher, [registry.split({ mint: coinMint, tokenProgram: T22 })]);
  launcherCosts.push(sp.cost);
  const pool = (await reader.tokenBalance(registryPdas.pool()))!;
  const dest = `agent:${agent.id}:compute`;
  const cfg0 = (await reader.registryConfig())!;
  const n = Number(cfg0.epochsPosted);
  const post = await send("3", `post_epoch ${n} (the Core authority hot key: one leaf, pool ${pool}, no rebate)`, core, [
    registry.postEpoch({ coreAuthority: core.id, mint: coinMint, epoch: n, payoutRoot: merkleRoot([payoutLeaf(n, agent.id, dest, pool)]), lineageRoot: merkleRoot([]), totalUnitsMicro: 1_000_000n,
      poolAmount: pool, rebateAmount: 0n, tokenProgram: T22 })]);
  const cfg1 = (await reader.registryConfig())!;
  check("3: the epoch is posted by the Core authority hot key", cfg1.epochsPosted === cfg0.epochsPosted + 1n, `epochs posted ${cfg1.epochsPosted}`);
  out.trade = { buy: { signature: buy.signature, sol_in_lamports: TRADE_SOL.toString(), payer_mainnet_lamports: buy.cost.payerMainnet, compute_units: buy.cost.computeUnits },
    sell: { signature: sell.signature, payer_mainnet_lamports: sell.cost.payerMainnet, compute_units: sell.cost.computeUnits } };
  out.crank = { signature: crank.signature, payer_mainnet_lamports: crank.cost.payerMainnet, compute_units: crank.cost.computeUnits, creator_fees_base_units: waiting.toString(), created_bytes: crank.cost.created.map((c) => c.bytes) };
  out.epoch_post = { signature: post.signature, payer_mainnet_lamports: post.cost.payerMainnet, compute_units: post.cost.computeUnits, created_bytes: post.cost.created.map((c) => c.bytes) };
  return { launcherCosts, corePost: post.cost };
}

// ---------------------------------------------------------------- 4: close and what comes back
async function step4(coinMint: string, launcherSpent: bigint, corePost: CostRow) {
  // the launcher (the owner's wallet) sells what it holds and returns its SOL, so the ledger shows the whole test's net cost
  const rest = (await reader.tokenBalance(ata(launcher.id, agentMint.id, T22)))!;
  const s1 = await send("4", "launcher: sell the rest of its agent coins for the test coin", launcher,
    [pump.sellV3({ mint: agentMint.id, quoteMint: coinMint, quoteTokenProgram: T22, user: launcher.id, amount: rest, minQuoteOut: 1n })], { computeUnits: 300_000 });
  let spent = launcherSpent + BigInt(s1.cost.payerMainnet);
  const fwd = (step: string) => async (what: string, payer: Signer, ixs: Ix[], o?: { signers?: Signer[]; computeUnits?: number }) => {
    const r = await send(step, what, payer, ixs, o);
    if (payer.id === launcher.id) spent += BigInt(r.cost.payerMainnet);
    return r;
  };
  await sellTestCoin(fork, fwd("4"), launcher, coinMint, 300, "launcher");
  const back = LAUNCHER_SOL - spent - 5_000n;
  const moved = await sweepKey(fork, fwd("4"), launcher, dep.id, "the launcher wallet");
  check("4: the launcher wallet sold its coins and returned its SOL", moved > 0n, `${sol(moved)} SOL on the fork; ${sol(back)} SOL at mainnet rent`);
  book("launcher wallet swept back (funded amount less what it spent at mainnet rent)", -back);

  // the site owner key's SOL comes back the same way (on the server it is the kit's key; here it is swept directly)
  const ownerBack = BigInt(Math.round(Number(OWNER_SOL) * 1e9)) - ownerSpent - 5_000n;
  await sweepKey(fork, fwd("4"), siteOwner, dep.id, "the site owner key");
  book("site owner key swept back (funded SOL less what registering and bonding one verifier cost)", -ownerBack);

  const b0 = await fork.getBalance(dep.id);
  const refuse = testCli(["close"], { expectFail: true });
  check("4: close without --confirm <registry id> refuses", /--confirm/.test(refuse));
  cliLog();
  const text = testCli(["close", "--sell-coin", "--confirm", IDS.registry]);
  const closeRows = cliLog();
  const hot = BigInt(Math.round(Number(HOT_SOL) * 1e9));
  // sweeps: each hot key returns what it was given less what it spent at mainnet rent and its own fee
  book("Core authority hot key swept back", -(hot - BigInt(corePost.payerMainnet) - 5_000n));
  book("runtime authority hot key swept back", -(hot - 5_000n));
  const sellRow = closeRows.find((e) => typeof e.what === "string" && /sell .* test coin/.test(e.what));
  if (!sellRow) throw new Error("close did not sell the test coin");
  const sold = await measure("4", sellRow.what, sellRow.signature);
  book("the deployer's test coins sold back on the curve", BigInt(sold.payerMainnet));
  const closes: Record<string, unknown> = {};
  let recovered = 0n;
  for (const n of names) {
    const d = (out.deploys as Record<string, any>)[n];
    const e = closeRows.find((x) => x.program === IDS[n] && x.returned_lamports);
    const fPd = BigInt(d.fork_rent.programdata), mPd = BigInt(d.mainnet_rent.programdata), mProg = BigInt(d.mainnet_rent.program);
    check(`4: ${n} closed: the whole ProgramData rent came back to the deployer (fork: rent less the fee, exactly)`, !!e && BigInt(e.returned_lamports) === fPd - 5_000n && (await fork.getAccountInfo(programDataAddress(IDS[n]))) === null,
      `mainnet: ${sol(mPd - 5_000n)} SOL back, ${sol(mProg)} SOL stays in the program account`);
    book(`close ${n}: ProgramData rent returned`, -(mPd - 5_000n));
    recovered += mPd - 5_000n;
    closes[n] = { returned_mainnet_lamports: (mPd - 5_000n).toString(), fee_lamports: "5000", stays_in_program_account_lamports: mProg.toString() };
  }
  check("4: the fork deployer's balance rose by the three ProgramData rents (and the sweeps and the coin sale)", (await fork.getBalance(dep.id)) > b0 && /returned to the deployer/.test(text));
  // a closed program id is gone for good: the loader refuses a deploy at it
  const again = testCli(["deploy"], { expectFail: true });
  check("4: test.ts deploy refuses a closed program id", /closed/.test(again), again.trim().split("\n").pop()!.slice(0, 160));
  // and the loader itself: the solana CLI, asked directly, cannot deploy at the closed id either
  const direct = spawnSync("solana", ["-u", FORK_URL, "-k", join(KEYS, "deployer.json"), "program", "deploy", join(DEPLOY, "units_msg.so"), "--program-id", join(PROGRAM_KEYS, "msg-program-keypair.json"),
    "--upgrade-authority", join(KEYS, "deployer.json"), "--fee-payer", join(KEYS, "deployer.json")], { encoding: "utf8" });
  const why = `${direct.stdout}${direct.stderr}`.trim().split("\n").pop() ?? "";
  check("4: the loader refuses a deploy at a closed program id (only the throwaway test ids are spent)", direct.status !== 0 && (await fork.getAccountInfo(programDataAddress(IDS.msg))) === null, why.slice(0, 200));
  (out as Record<string, unknown>).closed_id_redeploy_refusal = why.slice(0, 300);
  const st = testCli(["status"]);
  check("4: status reports the three programs CLOSED", (st.match(/CLOSED/g) ?? []).length === 3);
  out.close = { programs: closes, programdata_recovered_mainnet_lamports: recovered.toString(), test_coin_sale_mainnet_lamports: (-BigInt(sold.payerMainnet)).toString(),
    program_ids_reusable: false };
}

// ---------------------------------------------------------------- run
let outcome = "PASS";
// TEST_REHEARSAL_FROM=2 (debugging only): continue on a fork where steps 0 and 1 already ran; the ledger is then incomplete and no record is written
const RESUME = process.env.TEST_REHEARSAL_FROM === "2";
try {
  if (!RESUME) await step0();
  const { coinMint, state, table } = RESUME
    ? (() => { const st = JSON.parse(readFileSync(join(OUT_DIR, "mainnet.json"), "utf8")); logAt = readFileSync(LOGF, "utf8").split("\n").filter(Boolean).length; return { coinMint: st.line_mint as string, state: st, table: st.launch_lookup_table as string }; })()
    : await step1();
  const raw = JSON.parse(readFileSync(join(import.meta.dir, "test-params.json"), "utf8"));
  const P = parseLaunchParams({ ...raw, core_authority: state.core_authority, runtime_authority: state.runtime_authority, line_mint: coinMint });
  const l = await step2(coinMint, table, P);
  const t = await step3(coinMint, P);
  await step4(coinMint, l.spentMainnet + t.launcherCosts.reduce((a, c) => a + BigInt(c.payerMainnet), 0n), t.corePost);
  out.deployer = {
    note: "at mainnet rent and the base fee of 5,000 lamports per signature; no priority fee; the launcher wallet and the hot keys are funded from the deployer and swept back to it",
    peak_lamports: peak.toString(), peak_sol: sol(peak), peak_at: peakAt,
    net_spent_lamports: running.toString(), net_spent_sol: sol(running),
    returned_at_close_lamports: ledger.filter((x) => BigInt(x.lamports) < 0n && /close |swept|sold/.test(x.what)).reduce((a, x) => a - BigInt(x.lamports), 0n).toString(),
  };
} catch (e) {
  outcome = `FAIL: ${(e as Error).message}`;
  console.error(e);
} finally {
  out.finished = new Date().toISOString();
  out.outcome = outcome;
  out.ledger = ledger;
  out.checks = checks;
  out.transactions = rows;
  if (!RESUME) writeFileSync(join(import.meta.dir, "TEST-REHEARSAL-LAST.json"), JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  console.log(`[fork] mainnet test rehearsal ${outcome}: checks ${checks.filter((c) => c.ok).length}/${checks.length}, ${rows.length} transactions measured; deployer peak ${sol(peak)} SOL, net spent ${sol(running)} SOL`);
  if (outcome !== "PASS") process.exit(1);
}
