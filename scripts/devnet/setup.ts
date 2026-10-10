#!/usr/bin/env bun
// Devnet wiring, steps (a) to (f) of the devnet lane, each idempotent (skipped when already done)
// and each read back from chain:
//   a  TEST $LINE as a real pump.fun coin (create_v2 paired with SOL, never mayhem; owner decisions
//      2026-10-10), the supply holder (the deployer) buying the tLINE the steps need on its curve
//      (nothing can be minted: pump.fun revokes the mint authority)
//   b  lineage_registry::initialize with config/network.json params (paramsFromNetworkJson)
//   c  the frozen launch lookup table (launchTableAddresses: pump.fun's fixed accounts, $LINE's quote accounts, ours)
//   d  lineage_launch::initialize_launch (pump_creator_fee_bps 0: pump.fun's default)
//   e  an agent launch on pump.fun targeting https://github.com/karpathy/minbpe (create_v2 +
//      register_pump_launch in one transaction), trades on its curve from a test trader, the fee
//      crank (pump.fun's sweep + collect, then crank_pump_fees) with the exact split verified against
//      the creator fee the curve held, then split of the treasury
//   f  a verifier registered and bonded, an epoch posted with a Core-format Merkle root, claimed
//   g  Agent v2 and Epoch.record_root (identity plan I1, I2): every Agent record and Epoch account an
//      earlier registry layout wrote is grown in place (migrate_agent, migrate_epoch; the deployer
//      pays the added rent) and read back
//   h  bounties (plan C6): lineage_launch's BountyConfig set with TEST values (set_bounty_config,
//      launch admin) and read back
//   i  a second TEST agent, hosted, on the same repository, whose compute vault funds devnet bounties
//      (100 tLINE sent to its vault by transfer); the runtime authority opens its bounties
//   m  lineage_msg's MsgConfig with TEST caps (msg-e2e.ts's values)
// Devnet v2 (2026-10-10, fresh deployment bound to the pump.fun tLINE): run with --only a,b,c,d,h,m;
// e, f and i are the original wiring proofs (a test launch, a test verifier, a test epoch 0 that would
// anchor the registry's epoch numbering at 0 instead of Core's next epoch), not part of the site's setup.
// Usage: bun scripts/devnet/setup.ts [--only a,b,...]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalUrl, H, merkleProof, merkleRoot, proportionalSplit, repoId } from "@lineage/protocol";
import {
  ata,
  bounty,
  claimFromCoreProof,
  createV2,
  decodeBondingCurve,
  decodeLookupTable,
  decodePumpFeeConfig,
  decodePumpGlobal,
  decodeT22Metadata,
  IDENTITY_MODE,
  launch,
  launchPdas,
  launchTableAddresses,
  msg,
  MSG_PROGRAM_ID,
  readMsgConfig,
  lookupTable,
  paramsFromNetworkJson,
  payoutLeaf,
  pump,
  PUMP,
  pumpPdas,
  quoteCurveBuyExactOut,
  registry,
  registryPdas,
  token,
  TOKEN_2022_PROGRAM,
  type Signer,
} from "@lineage/chain";
import { check, deployer, key, LAMPORTS, loadState, log, logTx, reader, ROOT, rpc, saveState, send, sol, topUp } from "./lib.ts";
import { curveCreatorFee, launchTable, pumpCrank, pumpLaunchTx, pumpTrade } from "./pump-lib.ts";

const argv = process.argv.slice(2);
const only = argv.includes("--only") ? new Set(argv[argv.indexOf("--only") + 1]!.split(",")) : null;
const want = (s: string) => !only || only.has(s);

const T22 = TOKEN_2022_PROGRAM;
const DECIMALS = 6;
const ONE = 10n ** BigInt(DECIMALS);
const LINE_META = { name: "Lineage devnet TEST LINE", symbol: "tLINE", uri: "https://lineage.invalid/devnet/tline.json" }; // as pump-devnet-proof.ts created it
const AGENT_REPO = "https://github.com/karpathy/minbpe";
const AGENT_META = { name: "TEST minbpe agent", symbol: "TMBPE", uri: "https://lineage.invalid/devnet/agents/minbpe-test.json" };

const net = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
// TEST values. epoch_length_s 300 instead of the file's 3600: the registry requires
// unbond_cooldown_s (600) >= 2 x epoch_length_s (review M4). Core keeps its own epoch timing.
const params = { ...paramsFromNetworkJson(net, DECIMALS), epochLengthS: 300 };
/** TEST: most rebate one post_epoch may move (1 tLINE) and most the runtime may debit per usage epoch (1,000 tLINE). */
const MAX_REBATE_PER_EPOCH = 1n * 10n ** BigInt(DECIMALS);
const MAX_DEBIT_PER_EPOCH = 1_000n * 10n ** BigInt(DECIMALS);
const state = loadState();
const dep = deployer();
// the devnet tLINE pump.fun coin (CiBfnTkD..., made by pump-devnet-proof.ts); the earlier devnet tLINE
// (key "line-mint") was a plain Token-2022 mint, bound to the first devnet deployment (devnet v1)
const lineMint = key("tline-pump-mint");
// the devnet treasury holds the tLINE the steps hand out (bought on tLINE's curve by pump-devnet-proof.ts)
const holder = key("tline-pump-treasury");
const core = key("core-authority");
const runtime = key("runtime-authority");
const lineHolder = ata(holder.id, lineMint.id, T22);
const computeSink = ata(runtime.id, lineMint.id, T22);

/** TEST bounty values (plan C6; launch values TBA, SPEC 20). */
const BOUNTY_TEST = {
  maxBountyOutBps: 5_000,
  selfHostedInCap: 10n * ONE,
  windowS: 86_400,
  minTtlS: 60,
  maxTtlS: 30 * 86_400,
  refundGraceS: 60,
  minAmount: ONE / 100n,
  paused: false,
};
const PAYER_META = { name: "TEST bounty payer agent", symbol: "TBNTY", uri: "https://lineage.invalid/devnet/agents/bounty-payer-test.json" };
/** tLINE the trader of step e is given (base units). */
const TRADER_LINE = 1_000_000n * ONE;
/** tLINE the bounty payer's compute vault receives in step i. */
const BOUNTY_VAULT_LINE = 100n * ONE;

const startBalance = await rpc.getBalance(dep.id);
log(`deployer ${dep.id} holds ${sol(startBalance)} SOL`);

// ------------------------------------------------------------------ a: $LINE as a pump.fun coin
async function stepA() {
  const existing = await rpc.getAccountInfo(lineMint.id);
  if (!existing) {
    await send("a", `pump.fun create_v2: TEST $LINE ${lineMint.id} paired with SOL, not mayhem, creator = deployer`, dep, [
      createV2({ mint: lineMint.id, user: dep.id, creator: dep.id, name: LINE_META.name, symbol: LINE_META.symbol, uri: LINE_META.uri, quote: { kind: "sol" } }),
    ], { signers: [lineMint], computeUnits: 400_000 });
  } else log("a: tLINE exists, skipping create_v2");
  const [gA, fcA] = await rpc.getMultipleAccounts([PUMP.global, PUMP.feeConfig]);
  const g = decodePumpGlobal(gA!.data);
  const curve = decodeBondingCurve((await rpc.getAccountInfo(pumpPdas.bondingCurve(lineMint.id)))!.data);
  check("a: tLINE curve: owned by Pump, quoted in SOL, depth 0, not mayhem", curve.quoteMint === "11111111111111111111111111111111" && curve.depth === 0
    && !curve.isMayhemMode, `real token reserves ${curve.realTokenReserves}`);
  // what the later steps hand out: the trader (e), a verifier owner's burn and bond (f), the bounty payer's vault (i)
  const need = TRADER_LINE + params.registerBurn + params.minBond + BOUNTY_VAULT_LINE;
  const held = (await reader.tokenBalance(lineHolder)) ?? 0n;
  if (held < need) {
    const amount = need - held;
    if (amount >= curve.realTokenReserves) throw new Error(`buying ${amount} would complete tLINE's curve (${curve.realTokenReserves} left)`);
    const q = quoteCurveBuyExactOut(g, decodePumpFeeConfig(fcA!.data), curve, amount, (await reader.tokenBalance(ata(pumpPdas.bondingCurve(lineMint.id), lineMint.id, T22))) ?? 0n);
    throw new Error(`the devnet treasury ${holder.id} holds ${held} tLINE base units, ${amount} short: buy on tLINE's curve with scripts/devnet/pump-devnet-proof.ts`);
  }
  const m = (await reader.mint(lineMint.id))!;
  const meta = decodeT22Metadata((await rpc.getAccountInfo(lineMint.id))!.data);
  check("a: tLINE is a Token-2022 mint with metadata", m.tokenProgram === T22 && meta?.name === LINE_META.name && meta?.symbol === LINE_META.symbol, JSON.stringify(meta));
  check("a: fixed supply (pump.fun's), no mint or freeze authority", m.mintAuthority === null && m.freezeAuthority === null && m.decimals === DECIMALS
    && m.supply === g.tokenTotalSupply, `supply ${m.supply}`);
  check("a: the supply holder holds what the steps need", ((await reader.tokenBalance(lineHolder)) ?? 0n) >= need);
  Object.assign(state, { line_mint: lineMint.id, line_token_program: T22, line_decimals: DECIMALS, line_holder: lineHolder, line_supply_initial: m.supply.toString(),
    line_venue: "pump.fun" });
  delete state.dbc_config;
}

// ------------------------------------------------------------------ b: registry initialize
async function stepB() {
  let c = await reader.registryConfig();
  if (!c) {
    await send("b", "lineage_registry::initialize (admin = deployer, Core authority, params from config/network.json)", dep, [
      registry.initialize({
        upgradeAuthority: dep.id,
        mint: lineMint.id,
        tokenProgram: T22,
        args: { admin: dep.id, coreAuthority: core.id, launchProgram: state.launch_program, params, maxRebatePerEpoch: MAX_REBATE_PER_EPOCH },
      }),
    ]);
    c = await reader.registryConfig();
  } else log("b: registry config exists, skipping initialize");
  if (c && c.maxRebatePerEpoch === null) {
    await send("b", `lineage_registry::migrate_config (grow Config to the review-fix layout, max_rebate_per_epoch ${MAX_REBATE_PER_EPOCH})`, dep, [
      registry.migrateConfig({ admin: dep.id, maxRebatePerEpoch: MAX_REBATE_PER_EPOCH }),
    ]);
    c = await reader.registryConfig();
  }
  const same = (a: unknown, b: unknown) => JSON.stringify(a, (_, v) => (typeof v === "bigint" ? v.toString() : v)) === JSON.stringify(b, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  if (c && (!same(c.params, params) || c.maxRebatePerEpoch !== MAX_REBATE_PER_EPOCH)) {
    await send("b", "lineage_registry::set_config (params: epoch_length_s 300 so unbond_cooldown_s 600 meets the 2-epoch floor; rebate cap)", dep, [
      registry.setConfig({ admin: dep.id, args: { admin: dep.id, coreAuthority: core.id, launchProgram: state.launch_program, params, maxRebatePerEpoch: MAX_REBATE_PER_EPOCH } }),
    ]);
    c = await reader.registryConfig();
  }
  check("b: registry config read back", !!c && c.admin === dep.id && c.coreAuthority === core.id && c.launchProgram === state.launch_program && c.mint === lineMint.id && c.tokenProgram === T22);
  check("b: rebate cap and epoch anchor set (review-fix layout)", c!.maxRebatePerEpoch === MAX_REBATE_PER_EPOCH && c!.epochAnchor !== null, `${c!.maxRebatePerEpoch} / anchor ${c!.epochAnchor}`);
  check("b: every parameter equals paramsFromNetworkJson(config/network.json, 6) with epoch_length_s 300", JSON.stringify(c!.params, (_, v) => (typeof v === "bigint" ? v.toString() : v)) === JSON.stringify(params, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  const vaults = await reader.vaults();
  check("b: treasury, reserve, pool, payable and bond vaults exist", [vaults.treasury, vaults.reserve, vaults.pool, vaults.payable, vaults.bondVault].every((x) => x !== null));
  Object.assign(state, { admin: dep.id, core_authority: core.id, core_authority_key: "~/.config/lineage/devnet/core-authority.json" });
}

// ------------------------------------------------------------------ c: launch lookup table
async function stepC() {
  const want = launchTableAddresses({ lineMint: lineMint.id, lineTokenProgram: T22, linePool: state.line_pool as never });
  const same = (a: string[]) => a.length === want.length && a.every((x, i) => x === want[i]);
  if (typeof state.launch_lookup_table === "string") {
    const acc = await rpc.getAccountInfo(state.launch_lookup_table);
    const t = acc ? decodeLookupTable(acc.data) : null;
    if (t && same(t.addresses) && t.authority === null) {
      log(`c: launch lookup table ${state.launch_lookup_table} is frozen with the expected content, skipping`);
      return;
    }
  }
  const slot = await rpc.getSlot();
  const { ix, address } = lookupTable.create({ authority: dep.id, payer: dep.id, recentSlot: slot - 1 });
  await send("c", `launch lookup table ${address} (${want.length} addresses)`, dep, [ix, lookupTable.extend({ table: address, authority: dep.id, payer: dep.id, addresses: want })]);
  await send("c", `freeze the launch lookup table ${address}`, dep, [lookupTable.freeze({ table: address, authority: dep.id })]);
  const t = decodeLookupTable((await rpc.getAccountInfo(address))!.data);
  check("c: launch lookup table frozen with the expected content", same(t.addresses) && t.authority === null, `${t.addresses.length} addresses`);
  state.launch_lookup_table = address;
  saveState(state);
  // a table is usable from the slot after its last extension
  const s0 = await rpc.getSlot();
  while ((await rpc.getSlot()) <= s0 + 1) await new Promise((r) => setTimeout(r, 400));
}

// ------------------------------------------------------------------ d: launch initialize
async function stepD() {
  let lc = await reader.launchConfig();
  const sleep = (BigInt(net.sleep_threshold) * ONE) / 10n ** BigInt(net.token_decimals);
  const wake = (BigInt(net.wake_threshold) * ONE) / 10n ** BigInt(net.token_decimals);
  if (!lc) {
    await send("d", `create the compute sink ${computeSink} (runtime authority's tLINE ATA)`, dep, [token.createAtaIdempotent(dep.id, runtime.id, lineMint.id, T22)]);
    await send("d", "lineage_launch::initialize_launch (admin = deployer, runtime authority, 7000/3000 split, sleep/wake from network.json)", dep, [
      launch.initialize({
        upgradeAuthority: dep.id,
        lineMint: lineMint.id,
        lineTokenProgram: T22,
        args: {
          admin: dep.id, runtimeAuthority: runtime.id, computeSink,
          agentComputeBps: net.agent_compute_bps, protocolBps: net.protocol_bps, sleepThreshold: sleep, wakeThreshold: wake, paused: false,
          maxDebitPerEpoch: MAX_DEBIT_PER_EPOCH, pumpCreatorFeeBps: 0n,
        },
      }),
    ]);
    lc = await reader.launchConfig();
  } else log("d: launch config exists, skipping");
  if (lc && lc.maxDebitPerEpoch === null) {
    await send("d", `lineage_launch::migrate_launch_config (grow LaunchConfig to the review-fix layout, max_debit_per_epoch ${MAX_DEBIT_PER_EPOCH})`, dep, [
      launch.migrateConfig({ admin: dep.id, maxDebitPerEpoch: MAX_DEBIT_PER_EPOCH }),
    ]);
    lc = await reader.launchConfig();
  }
  check("d: debit cap set, registry program is the constant", lc!.maxDebitPerEpoch === MAX_DEBIT_PER_EPOCH && lc!.registryProgram === state.registry_program,
    `${lc!.maxDebitPerEpoch}`);
  check("d: launch config read back", !!lc && lc.venue === PUMP.program && lc.lineMint === lineMint.id && lc.computeSink === computeSink && lc.runtimeAuthority === runtime.id
    && lc.agentComputeBps === net.agent_compute_bps && lc.protocolBps === net.protocol_bps && lc.sleepThreshold === sleep && lc.wakeThreshold === wake);
  check("d: pump.fun creator fee rate is pump.fun's default (0)", lc!.pumpCreatorFeeBps === 0n, `${lc!.pumpCreatorFeeBps}`);
  Object.assign(state, { runtime_authority: runtime.id, compute_sink: computeSink, agent_compute_bps: lc!.agentComputeBps, protocol_bps: lc!.protocolBps });
}

// ------------------------------------------------------------------ e: a real launch, trades, crank
async function lineTo(owner: string, min: bigint, label: string, step: string) {
  const dest = ata(owner, lineMint.id, T22);
  const bal = (await reader.tokenBalance(dest)) ?? 0n;
  if (bal >= min) return dest;
  await send(step, `send ${(min - bal) / ONE} tLINE to ${label} ${owner}`, dep, [
    token.createAtaIdempotent(dep.id, owner, lineMint.id, T22),
    token.transferChecked(lineHolder, lineMint.id, dest, holder.id, min - bal, DECIMALS, T22),
  ], { signers: [holder] });
  return dest;
}

async function stepE() {
  const launcher = key("launcher");
  const agent = key("agent-minbpe");
  const agentMint = key("agent-minbpe-mint");
  const trader = key("trader");
  const url = canonicalUrl(AGENT_REPO);
  let l = await reader.agentLaunch(agentMint.id);
  if (!l) {
    await topUp("e", dep, launcher.id, LAMPORTS / 10n, "launcher");
    const table = await launchTable(rpc, state as never);
    const r = await pumpLaunchTx(rpc, { launcher, agent, mint: agentMint, lineMint: lineMint.id, ...AGENT_META,
      args: { repoUrl: url, identityMode: IDENTITY_MODE.app, hosted: true }, table });
    for (const t of r.sent) {
      logTx("e", `pump.fun launch: TEST agent ${agent.id} on ${url}, agent mint ${agentMint.id} (${r.plan.mode}, ${t.size} bytes)`, { signature: t.signature, fee: t.fee ?? undefined, slot: 0, logs: [] });
      log(`e: launch ${t.signature} (${t.size} bytes${t.computeUnits ? `, ${t.computeUnits} CU` : ""})`);
    }
    l = await reader.agentLaunch(agentMint.id);
  } else log("e: agent launch exists, skipping the launch");
  const rec = await reader.agent(agent.id);
  check("e: AgentLaunch read back", !!l && l.venue === "pump" && l.agent === agent.id && l.launcher === launcher.id && l.repoUrl === url && l.hosted && l.identityMode === IDENTITY_MODE.app);
  check("e: repo_id computed onchain equals protocol repoId(url)", l!.repoId === repoId(url), l!.repoId);
  check("e: registry Agent record (kind launched) created by CPI", !!rec && rec.kind === "launched" && rec.owner === launcher.id && rec.mint === agentMint.id && rec.hosted);
  const curve0 = decodeBondingCurve((await rpc.getAccountInfo(pumpPdas.bondingCurve(agentMint.id)))!.data);
  check("e: the curve's creator is the agent's creator PDA and its quote is tLINE", curve0.creator === launchPdas.pumpCreator(agent.id) && curve0.quoteMint === lineMint.id
    && curve0.depth === 1, `virtual quote ${curve0.virtualQuoteReserves}`);

  const computeVault = launchPdas.computeVault(agent.id);
  const treasury = registryPdas.treasury();
  if (l!.feesClaimed === 0n) {
    if ((await curveCreatorFee(rpc, agentMint.id)) === 0n) {
      await topUp("e", dep, trader.id, LAMPORTS / 50n, "trader", LAMPORTS / 20n);
      await lineTo(trader.id, TRADER_LINE, "trader", "e");
      const trade = async (what: string, buy: boolean, amountIn: bigint) => {
        const t = await pumpTrade(rpc, { trader, mint: agentMint.id, lineMint: lineMint.id, buy, amountIn });
        logTx("e", what, { signature: t.signature, fee: t.fee ?? undefined, slot: 0, logs: [] });
        log(`e: ${what}: ${t.signature} (${t.venue})`);
      };
      await trade(`trade 1: trader buys with ${(TRADER_LINE / 10n) / ONE} tLINE on the pump.fun curve`, true, TRADER_LINE / 10n);
      await trade(`trade 2: trader buys with ${(TRADER_LINE / 20n) / ONE} tLINE`, true, TRADER_LINE / 20n);
      const held = (await reader.tokenBalance(ata(trader.id, agentMint.id, T22)))!;
      await trade(`trade 3: trader sells ${held / 2n} agent-token base units (half)`, false, held / 2n);
    }
    const fees = await curveCreatorFee(rpc, agentMint.id);
    check("e: trades left the creator fee waiting on the curve (v3 trades)", fees > 0n, `${fees}`);
    const [c0, t0] = await reader.tokenBalances([computeVault, treasury]);
    const crank = await pumpCrank(rpc, { payer: dep, agent: agent.id, mint: agentMint.id, lineMint: lineMint.id });
    logTx("e", `crank: pump.fun sweep + collect of ${fees} creator fee base units, then crank_pump_fees`, { signature: crank.signature, fee: crank.fee ?? undefined, slot: 0, logs: [] });
    const [c1, t1] = await reader.tokenBalances([computeVault, treasury]);
    const wantC = (fees * BigInt(net.agent_compute_bps)) / 10_000n;
    const la = (await reader.agentLaunch(agentMint.id))!;
    check("e: compute vault got exactly floor(fees x agent_compute_bps / 10,000)", c1! - c0! === wantC, `${c1! - c0!} of ${fees}`);
    check("e: treasury got exactly the rest", t1! - t0! === fees - wantC, `${t1! - t0!}`);
    check("e: AgentLaunch counters agree", la.feesClaimed === fees && la.toCompute === wantC && la.toProtocol === fees - wantC);
    check("e: the curve's waiting creator fee is now zero", (await curveCreatorFee(rpc, agentMint.id)) === 0n);
    state.fee_split = { crank_signature: crank.signature, fees: fees.toString(), to_compute: wantC.toString(), to_protocol: (fees - wantC).toString(),
      agent_compute_bps: net.agent_compute_bps, check: `${c1! - c0!} = floor(${fees} x ${net.agent_compute_bps} / 10000); ${t1! - t0!} = ${fees} - ${wantC}` };
  } else log(`e: fees already cranked (${l!.feesClaimed}), skipping trades and crank`);

  const tBal = (await reader.tokenBalance(treasury))!;
  if (tBal > 0n) {
    const [r0, p0] = await reader.tokenBalances([registryPdas.reserve(), registryPdas.pool()]);
    await send("e", `split: treasury ${tBal} to reserve (${params.reserveBps} bps) and pool`, dep, [registry.split({ mint: lineMint.id, tokenProgram: T22 })]);
    const [r1, p1, t1] = await reader.tokenBalances([registryPdas.reserve(), registryPdas.pool(), treasury]);
    const wantR = (tBal * BigInt(params.reserveBps)) / 10_000n;
    check("e: split moved floor(treasury x reserve_bps / 10,000) to the reserve and the rest to the pool", r1! - r0! === wantR && p1! - p0! === tBal - wantR && t1 === 0n,
      `reserve +${r1! - r0!}, pool +${p1! - p0!}`);
  }
  state.agents = { ...(state.agents ?? {}), minbpe: { agent: agent.id, mint: agentMint.id, launcher: launcher.id, repo_url: url } };
  state.trader = trader.id;
}

// ------------------------------------------------------------------ f: verifier, epoch, claims
async function registerVerifier(step: string, owner: Signer, agent: Signer, operator: string, capabilities: string) {
  const ownerLine = await lineTo(owner.id, params.registerBurn + params.minBond, "verifier owner", step);
  let rec = await reader.agent(agent.id);
  if (!rec) {
    const s0 = (await reader.mint(lineMint.id))!.supply;
    await send(step, `register verifier ${agent.id} (owner ${owner.id}, burns ${params.registerBurn} base units)`, owner, [
      registry.register({ owner: owner.id, agent: agent.id, mint: lineMint.id, ownerToken: ownerLine, operator, capabilities, tokenProgram: T22 }),
    ], { signers: [agent] });
    const s1 = (await reader.mint(lineMint.id))!.supply;
    check(`${step}: register burned register_burn from the supply`, s0 - s1 === params.registerBurn, `${s0 - s1}`);
    rec = await reader.agent(agent.id);
  }
  if (rec!.bond < params.minBond) {
    await lineTo(owner.id, params.minBond - rec!.bond, "verifier owner", step);
    await send(step, `bond ${params.minBond - rec!.bond} base units for ${agent.id}`, owner, [
      registry.bond({ owner: owner.id, agent: agent.id, mint: lineMint.id, ownerToken: ownerLine, amount: params.minBond - rec!.bond, tokenProgram: T22 }),
    ]);
    rec = await reader.agent(agent.id);
  }
  check(`${step}: verifier ${agent.id.slice(0, 8)} registered and bonded`, rec!.kind === "verifier" && rec!.owner === owner.id && rec!.burned === params.registerBurn && rec!.bond >= params.minBond,
    `bond ${rec!.bond}`);
  return rec!;
}

async function stepF() {
  const owner = key("verifier-owner");
  const v = key("verifier-test");
  await topUp("f", dep, owner.id, LAMPORTS / 50n, "verifier owner", (LAMPORTS * 15n) / 100n);
  await topUp("f", dep, core.id, LAMPORTS / 50n, "Core authority", LAMPORTS / 10n);
  await registerVerifier("f", owner, v, H("operator", "lineage-devnet-test"), "00".repeat(32));
  const minbpe = state.agents!.minbpe!;
  const cfg = (await reader.registryConfig())!;
  let n = state.test_epoch === undefined ? (cfg.epochsPosted === 0n ? 0n : cfg.lastEpoch + 1n) : BigInt(state.test_epoch as number);
  let ep = await reader.epoch(n);
  type Leaf = { agent: string; dest: string; amount: string; leaf: string };
  let leaves: Leaf[];
  if (!ep) {
    const [pool, reserve] = await reader.tokenBalances([registryPdas.pool(), registryPdas.reserve()]);
    // Core's close: proportional split of the whole pool by units per (agent, dest); rebates from the reserve.
    const units = new Map([[`${v.id}\nagent:${v.id}:wallet`, 3], [`${minbpe.agent}\nagent:${minbpe.agent}:compute`, 4]]);
    const split = proportionalSplit(pool!, units);
    const rebate = 3n * params.rebatePerClass;
    check("f: reserve covers the rebate", reserve! >= rebate);
    const keys = [...units.keys()].sort();
    leaves = keys.map((k) => {
      const [agent, dest] = k.split("\n") as [string, string];
      const amount = (split.get(k) ?? 0n) + (agent === v.id ? rebate : 0n);
      return { agent, dest, amount: amount.toString(), leaf: payoutLeaf(Number(n), agent, dest, amount) };
    });
    const root = merkleRoot(leaves.map((l) => l.leaf));
    state.test_epoch = Number(n);
    state.test_epoch_leaves = leaves;
    saveState(state);
    await send("f", `post_epoch ${n}: payout root ${root.slice(0, 16)}..., pool ${pool}, rebate ${rebate} (2 leaves, Core format)`, core, [
      registry.postEpoch({ coreAuthority: core.id, mint: lineMint.id, epoch: n, payoutRoot: root, lineageRoot: merkleRoot([]), totalUnitsMicro: 7_000_000n,
        poolAmount: pool!, rebateAmount: rebate, tokenProgram: T22 }),
    ]);
    ep = await reader.epoch(n);
    check("f: epoch record read back", !!ep && ep.payoutRoot === root && ep.poolAmount === pool && ep.rebateAmount === rebate && ep.totalPayable === pool! + rebate);
  } else {
    log(`f: epoch ${n} already posted, skipping post_epoch`);
    leaves = state.test_epoch_leaves as Leaf[];
  }
  const root = merkleRoot(leaves.map((l) => l.leaf));
  for (const [i, l] of leaves.entries()) {
    const c = claimFromCoreProof({ epoch: Number(n), agent: l.agent, dest: l.dest, amount: l.amount, leaf: l.leaf, proof: merkleProof(leaves.map((x) => x.leaf), i), root });
    const [receipt] = await reader.claimReceipts(n, [c.leaf]);
    if (receipt) {
      log(`f: leaf ${l.dest} already claimed`);
      continue;
    }
    const destToken = l.dest.endsWith(":compute") ? launchPdas.computeVault(l.agent) : ata(owner.id, lineMint.id, T22);
    const b0 = (await reader.tokenBalance(destToken))!;
    await send("f", `claim epoch ${n} leaf ${l.dest} amount ${l.amount}`, dep, [
      registry.claim({ payer: dep.id, mint: lineMint.id, ...c, destToken, tokenProgram: T22 }),
    ]);
    const b1 = (await reader.tokenBalance(destToken))!;
    check(`f: ${l.dest} paid exactly the leaf amount`, b1 - b0 === BigInt(l.amount), `${b1 - b0}`);
  }
  ep = (await reader.epoch(n))!;
  check("f: every leaf claimed, claimed total equals payable", ep.claims === leaves.length && ep.claimedAmount === ep.totalPayable, `${ep.claimedAmount} / ${ep.totalPayable}`);
  state.verifier_owner = owner.id;
  state.agents = { ...(state.agents ?? {}), "verifier-test": { agent: v.id, owner: owner.id } };
}

async function stepG() {
  const agents = await reader.agents();
  for (const a of agents.filter((x) => x.version === 1))
    await send("g", `migrate_agent ${a.agent} (Agent v2: signing_key = agent key, owner_since = registered_at)`, dep, [registry.migrateAgent({ payer: dep.id, agent: a.agent })]);
  const epochs = await reader.epochs();
  for (const e of epochs.filter((x) => x.version === 1))
    await send("g", `migrate_epoch ${e.epoch} (record_root zero: posted before records existed)`, dep, [registry.migrateEpoch({ payer: dep.id, epoch: e.epoch })]);
  const after = await reader.agents();
  check("g: every Agent record is v2 and keeps its fields", after.length === agents.length && after.every((a) => a.version === 2) &&
    after.every((a) => {
      const b = agents.find((x) => x.agent === a.agent)!;
      return a.owner === b.owner && a.bond === b.bond && a.registeredAt === b.registeredAt && (b.version === 2 || (a.signingKey === a.agent && a.ownerSince === a.registeredAt && a.keySeq === 0));
    }), `${after.length} agents, ${agents.filter((x) => x.version === 1).length} migrated now`);
  const eAfter = await reader.epochs();
  check("g: every Epoch account is v2 and keeps its roots", eAfter.length === epochs.length && eAfter.every((e) => e.version === 2) &&
    eAfter.every((e) => {
      const b = epochs.find((x) => x.epoch === e.epoch)!;
      return e.payoutRoot === b.payoutRoot && e.claimedAmount === b.claimedAmount && (b.version === 2 || e.recordRoot === null);
    }), `${eAfter.length} epochs, ${epochs.filter((x) => x.version === 1).length} migrated now`);
}

// ------------------------------------------------------------------ m: lineage_msg config
const MSG_TEST_CAPS = { windowS: 60, maxPerWindow: 20, maxPerDay: 500, maxInline: 568, maxBlob: 1 << 20 };
async function stepM() {
  const cur = await readMsgConfig(rpc);
  if (!cur)
    await send("m", "lineage_msg initialize (TEST caps: 20 per 60 s, 500 per day, 568-byte inline, 1 MiB blobs)", dep, [
      msg.initialize({ upgradeAuthority: dep.id, args: { admin: dep.id, paused: false, ...MSG_TEST_CAPS } }),
    ]);
  else log("m: MsgConfig exists, skipping");
  const got = await readMsgConfig(rpc);
  check("m: MsgConfig read back with the TEST caps", !!got && got.admin === dep.id && !got.paused && got.maxPerWindow === 20 && got.maxPerDay === 500 && got.maxInline === 568 && got.maxBlob === 1 << 20);
  state.msg_program = MSG_PROGRAM_ID;
}

async function stepH() {
  const cur = await reader.bountyConfig();
  const same = cur && Object.entries(BOUNTY_TEST).every(([k, v]) => (cur as any)[k] === v);
  if (!same)
    await send("h", `set_bounty_config (TEST: max_bounty_out_bps ${BOUNTY_TEST.maxBountyOutBps}, self-hosted cap ${BOUNTY_TEST.selfHostedInCap}, ttl ${BOUNTY_TEST.minTtlS}..${BOUNTY_TEST.maxTtlS} s, grace ${BOUNTY_TEST.refundGraceS} s)`, dep, [
      bounty.setConfig({ admin: dep.id, args: BOUNTY_TEST }),
    ]);
  else log("h: BountyConfig already holds the TEST values");
  const got = await reader.bountyConfig();
  check("h: BountyConfig read back equals the TEST values", !!got && Object.entries(BOUNTY_TEST).every(([k, v]) => (got as any)[k] === v));
}

async function stepI() {
  const launcher = key("launcher");
  const agent = key("agent-bounty-payer");
  const agentMint = key("agent-bounty-payer-mint");
  const url = canonicalUrl(AGENT_REPO);
  let l = await reader.agentLaunch(agentMint.id);
  if (!l) {
    await topUp("i", dep, launcher.id, LAMPORTS / 20n, "launcher", LAMPORTS / 10n);
    const table = await launchTable(rpc, state as never);
    const r = await pumpLaunchTx(rpc, { launcher, agent, mint: agentMint, lineMint: lineMint.id, ...PAYER_META,
      args: { repoUrl: url, identityMode: IDENTITY_MODE.app, hosted: true }, table });
    for (const t of r.sent)
      logTx("i", `pump.fun launch: TEST bounty payer agent ${agent.id} on ${url} (hosted), agent mint ${agentMint.id}`, { signature: t.signature, fee: t.fee ?? undefined, slot: 0, logs: [] });
    l = await reader.agentLaunch(agentMint.id);
  } else log("i: bounty payer launch exists, skipping the launch");
  check("i: bounty payer AgentLaunch read back (hosted)", !!l && l.agent === agent.id && l.hosted && l.launcher === launcher.id);
  const vault = launchPdas.computeVault(agent.id);
  const bal = (await reader.tokenBalance(vault)) ?? 0n;
  const want = BOUNTY_VAULT_LINE;
  if (bal < want) {
    await send("i", `send ${want - bal} tLINE base units to the bounty payer's compute vault ${vault} (deposit by transfer)`, dep, [
      token.transferChecked(lineHolder, lineMint.id, vault, holder.id, want - bal, DECIMALS, T22),
    ], { signers: [holder] });
    await send("i", "refresh_awake for the bounty payer", dep, [launch.refreshAwake({ agent: agent.id, agentMint: agentMint.id })]);
  }
  const after = (await reader.tokenBalance(vault)) ?? 0n;
  check("i: bounty payer compute vault holds at least 100 tLINE", after >= want, `${after}`);
  state.agents = { ...(state.agents ?? {}), "bounty-payer": { agent: agent.id, mint: agentMint.id, launcher: launcher.id, repo_url: url } };
}

try {
  if (want("a")) await stepA();
  if (want("b")) await stepB();
  if (want("c")) await stepC();
  if (want("d")) await stepD();
  if (want("e")) await stepE();
  if (want("f")) await stepF();
  if (want("g")) await stepG();
  if (want("h")) await stepH();
  if (want("m")) await stepM();
  if (want("i")) await stepI();
} finally {
  const end = await rpc.getBalance(dep.id);
  state.deployer_balance_after_setup = sol(end);
  saveState(state);
  log(`deployer ${sol(end)} SOL (spent or moved this run: ${sol(startBalance - end)})`);
}
const v = await reader.vaults([state.agents?.minbpe?.agent].filter(Boolean) as string[]);
log(`vaults (base units): treasury ${v.treasury}, reserve ${v.reserve}, pool ${v.pool}, payable ${v.payable}, bond ${v.bondVault}, compute ${JSON.stringify(Object.fromEntries(Object.entries(v.compute).map(([k, x]) => [k, String(x)])))}`);
