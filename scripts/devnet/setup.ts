#!/usr/bin/env bun
// Devnet wiring, steps (a) to (f) of the devnet lane, each idempotent (skipped when already done)
// and each read back from chain:
//   a  a Token-2022 Pump.fun-style TEST $LINE mint ("Lineage Test LINE", symbol tLINE)
//   b  lineage_registry::initialize with config/network.json params (paramsFromNetworkJson)
//   c  a Meteora DBC config naming the launch authority PDA as fee claimer and leftover receiver
//   d  lineage_launch::initialize_launch
//   e  an agent launch targeting https://github.com/karpathy/minbpe, trades on its curve from a
//      test trader, crank_fees with the exact split verified, then split of the treasury
//   f  a verifier registered and bonded, an epoch posted with a Core-format Merkle root, claimed
// Usage: bun scripts/devnet/setup.ts [--only a,b,...]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalUrl, H, merkleProof, merkleRoot, proportionalSplit, repoId } from "@lineage/protocol";
import {
  ata,
  claimFromCoreProof,
  dbc,
  decodeDbcPool,
  decodeT22Metadata,
  IDENTITY_MODE,
  launch,
  launchPdas,
  METEORA,
  paramsFromNetworkJson,
  payoutLeaf,
  registry,
  registryPdas,
  standardDbcParams,
  system,
  T22_MINT_WITH_POINTER,
  token,
  TOKEN_2022_PROGRAM,
  tokenMetadataLen,
  type Signer,
} from "@lineage/chain";
import { check, deployer, key, LAMPORTS, loadState, log, reader, ROOT, rpc, saveState, send, sol, topUp } from "./lib.ts";

const argv = process.argv.slice(2);
const only = argv.includes("--only") ? new Set(argv[argv.indexOf("--only") + 1]!.split(",")) : null;
const want = (s: string) => !only || only.has(s);

const T22 = TOKEN_2022_PROGRAM;
const DECIMALS = 6;
const ONE = 10n ** BigInt(DECIMALS);
const SUPPLY = 1_000_000_000n * ONE;
const LINE_META = { name: "Lineage Test LINE (TEST)", symbol: "tLINE", uri: "https://lineage.invalid/devnet/tline-test.json" };
const AGENT_REPO = "https://github.com/karpathy/minbpe";
const AGENT_META = { name: "TEST minbpe agent", symbol: "TMBPE", uri: "https://lineage.invalid/devnet/agents/minbpe-test.json" };

const net = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
const params = paramsFromNetworkJson(net, DECIMALS);
const state = loadState();
const dep = deployer();
const lineMint = key("line-mint");
const core = key("core-authority");
const runtime = key("runtime-authority");
const dbcConfigKey = key("dbc-config");
const lineHolder = ata(dep.id, lineMint.id, T22);
const computeSink = ata(runtime.id, lineMint.id, T22);

const startBalance = await rpc.getBalance(dep.id);
log(`deployer ${dep.id} holds ${sol(startBalance)} SOL`);

// ------------------------------------------------------------------ a: $LINE test mint
async function stepA() {
  const existing = await rpc.getAccountInfo(lineMint.id);
  if (!existing) {
    const lamports = await rpc.getMinimumBalanceForRentExemption(T22_MINT_WITH_POINTER + tokenMetadataLen(LINE_META.name, LINE_META.symbol, LINE_META.uri));
    await send("a", `create TEST $LINE mint ${lineMint.id} (Token-2022, metadata pointer + metadata, ${DECIMALS} decimals)`, dep, [
      system.createAccount(dep.id, lineMint.id, lamports, T22_MINT_WITH_POINTER, T22),
      token.initializeMetadataPointer(lineMint.id, dep.id, lineMint.id),
      token.initializeMint2(lineMint.id, DECIMALS, dep.id, T22),
      token.initializeTokenMetadata(lineMint.id, dep.id, dep.id, LINE_META.name, LINE_META.symbol, LINE_META.uri),
    ], { signers: [lineMint] });
  } else log("a: mint exists, skipping create");
  let m = (await reader.mint(lineMint.id))!;
  if (m.supply === 0n && m.mintAuthority === dep.id) {
    await send("a", `mint the full TEST supply ${SUPPLY / ONE} tLINE to the deployer's ATA ${lineHolder}`, dep, [
      token.createAtaIdempotent(dep.id, dep.id, lineMint.id, T22),
      token.mintTo(lineMint.id, lineHolder, dep.id, SUPPLY, T22),
    ]);
  }
  m = (await reader.mint(lineMint.id))!;
  if (m.mintAuthority) await send("a", "revoke the tLINE mint authority (fixed supply, as Pump.fun mints)", dep, [token.revokeMintAuthority(lineMint.id, dep.id, T22)]);
  m = (await reader.mint(lineMint.id))!;
  const meta = decodeT22Metadata((await rpc.getAccountInfo(lineMint.id))!.data);
  check("a: tLINE is a Token-2022 mint with metadata", m.tokenProgram === T22 && meta?.name === LINE_META.name && meta?.symbol === LINE_META.symbol, JSON.stringify(meta));
  check("a: fixed supply, no mint or freeze authority", m.mintAuthority === null && m.freezeAuthority === null && m.decimals === DECIMALS, `supply ${m.supply}`);
  Object.assign(state, { line_mint: lineMint.id, line_token_program: T22, line_decimals: DECIMALS, line_holder: lineHolder, line_supply_initial: SUPPLY.toString() });
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
        args: { admin: dep.id, coreAuthority: core.id, launchProgram: state.launch_program, params },
      }),
    ]);
    c = await reader.registryConfig();
  } else log("b: registry config exists, skipping initialize");
  check("b: registry config read back", !!c && c.admin === dep.id && c.coreAuthority === core.id && c.launchProgram === state.launch_program && c.mint === lineMint.id && c.tokenProgram === T22);
  check("b: every parameter equals paramsFromNetworkJson(config/network.json, 6)", JSON.stringify(c!.params, (_, v) => (typeof v === "bigint" ? v.toString() : v)) === JSON.stringify(params, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  const vaults = await reader.vaults();
  check("b: treasury, reserve, pool, payable and bond vaults exist", [vaults.treasury, vaults.reserve, vaults.pool, vaults.payable, vaults.bondVault].every((x) => x !== null));
  Object.assign(state, { admin: dep.id, core_authority: core.id, core_authority_key: "~/.config/lineage/devnet/core-authority.json" });
}

// ------------------------------------------------------------------ c: DBC config
async function stepC() {
  const existing = await rpc.getAccountInfo(dbcConfigKey.id);
  if (!existing) {
    await send("c", `Meteora DBC create_config ${dbcConfigKey.id} (quote tLINE, fee claimer and leftover receiver = launch authority PDA, TEST curve)`, dep, [
      dbc.createConfig({ config: dbcConfigKey.id, feeClaimer: launchPdas.authority(), quoteMint: lineMint.id, payer: dep.id, params: standardDbcParams() }),
    ], { signers: [dbcConfigKey] });
  } else log("c: DBC config exists, skipping");
  const a = (await rpc.getAccountInfo(dbcConfigKey.id))!;
  check("c: DBC config owned by DBC", a.owner === METEORA.dbcProgram, `${a.data.length} bytes`);
  state.dbc_config = dbcConfigKey.id;
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
        dbcConfig: dbcConfigKey.id,
        lineTokenProgram: T22,
        args: {
          admin: dep.id, runtimeAuthority: runtime.id, registryProgram: state.registry_program, computeSink,
          agentComputeBps: net.agent_compute_bps, protocolBps: net.protocol_bps, sleepThreshold: sleep, wakeThreshold: wake, paused: false,
        },
      }),
    ]);
    lc = await reader.launchConfig();
  } else log("d: launch config exists, skipping");
  const p = standardDbcParams();
  check("d: launch config read back", !!lc && lc.dbcConfig === dbcConfigKey.id && lc.lineMint === lineMint.id && lc.computeSink === computeSink && lc.runtimeAuthority === runtime.id
    && lc.agentComputeBps === net.agent_compute_bps && lc.protocolBps === net.protocol_bps && lc.sleepThreshold === sleep && lc.wakeThreshold === wake);
  check("d: curve threshold and start price read from the DBC config", lc!.migrationQuoteThreshold === p.threshold && lc!.sqrtStartPrice === p.sqrtStart, `${lc!.migrationQuoteThreshold} / ${lc!.sqrtStartPrice}`);
  Object.assign(state, { runtime_authority: runtime.id, compute_sink: computeSink, agent_compute_bps: lc!.agentComputeBps, protocol_bps: lc!.protocolBps });
}

// ------------------------------------------------------------------ e: a real launch, trades, crank
async function lineTo(owner: string, min: bigint, label: string, step: string) {
  const dest = ata(owner, lineMint.id, T22);
  const bal = (await reader.tokenBalance(dest)) ?? 0n;
  if (bal >= min) return dest;
  await send(step, `send ${(min - bal) / ONE} tLINE to ${label} ${owner}`, dep, [
    token.createAtaIdempotent(dep.id, owner, lineMint.id, T22),
    token.transferChecked(lineHolder, lineMint.id, dest, dep.id, min - bal, DECIMALS, T22),
  ]);
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
    await send("e", `launch_agent: TEST agent ${agent.id} on ${url}, agent mint ${agentMint.id}`, launcher, [
      launch.launchAgent({
        launcher: launcher.id, agent: agent.id, agentMint: agentMint.id, lineMint: lineMint.id, dbcConfig: dbcConfigKey.id, lineTokenProgram: T22,
        args: { ...AGENT_META, repoUrl: url, identityMode: IDENTITY_MODE.app, hosted: true },
      }),
    ], { signers: [agent, agentMint], computeUnits: 400_000 });
    l = await reader.agentLaunch(agentMint.id);
  } else log("e: agent launch exists, skipping launch_agent");
  const rec = await reader.agent(agent.id);
  check("e: AgentLaunch read back", !!l && l.agent === agent.id && l.launcher === launcher.id && l.repoUrl === url && l.hosted && l.identityMode === IDENTITY_MODE.app);
  check("e: repo_id computed onchain equals protocol repoId(url)", l!.repoId === repoId(url), l!.repoId);
  check("e: registry Agent record (kind launched) created by CPI", !!rec && rec.kind === "launched" && rec.owner === launcher.id && rec.mint === agentMint.id && rec.hosted);
  const pool = launchPdas.dbcPool(dbcConfigKey.id, agentMint.id, lineMint.id);
  check("e: DBC pool creator is the launch authority PDA", decodeDbcPool((await rpc.getAccountInfo(pool))!.data).creator === launchPdas.authority());
  const authAgentToken = ata(launchPdas.authority(), agentMint.id, T22);
  if (!(await rpc.getAccountInfo(authAgentToken)))
    await send("e", "create the launch authority's agent-token ATA (crank prerequisite)", dep, [token.createAtaIdempotent(dep.id, launchPdas.authority(), agentMint.id, T22)]);

  const computeVault = launchPdas.computeVault(agent.id);
  const treasury = registryPdas.treasury();
  if (l!.feesClaimed === 0n) {
    let view = decodeDbcPool((await rpc.getAccountInfo(pool))!.data);
    if (view.partnerQuoteFee === 0n) {
      await topUp("e", dep, trader.id, LAMPORTS / 50n, "trader", LAMPORTS / 20n);
      const traderLine = await lineTo(trader.id, 1_000_000n * ONE, "trader", "e");
      const traderAgent = ata(trader.id, agentMint.id, T22);
      await send("e", "create the trader's agent-token ATA", trader, [token.createAtaIdempotent(trader.id, trader.id, agentMint.id, T22)]);
      const swap = (buy: boolean, amountIn: bigint) =>
        dbc.swap({ config: dbcConfigKey.id, pool, agentMint: agentMint.id, lineMint: lineMint.id, trader: trader.id, lineAccount: traderLine, agentAccount: traderAgent,
          buy, amountIn, minOut: 1n, lineTokenProgram: T22 });
      await send("e", "trade 1: trader buys with 100,000 tLINE on the DBC curve", trader, [swap(true, 100_000n * ONE)], { computeUnits: 300_000 });
      await send("e", "trade 2: trader buys with 50,000 tLINE", trader, [swap(true, 50_000n * ONE)], { computeUnits: 300_000 });
      const held = (await reader.tokenBalance(traderAgent))!;
      await send("e", `trade 3: trader sells ${held / 2n} agent-token base units (half)`, trader, [swap(false, held / 2n)], { computeUnits: 300_000 });
      view = decodeDbcPool((await rpc.getAccountInfo(pool))!.data);
    }
    check("e: trades left partner (claimable) and Meteora protocol fees in the pool", view.partnerQuoteFee > 0n && view.protocolQuoteFee > 0n,
      `partner ${view.partnerQuoteFee}, Meteora protocol ${view.protocolQuoteFee}, quote reserve ${view.quoteReserve}`);
    const fees = view.partnerQuoteFee;
    const [c0, t0] = await reader.tokenBalances([computeVault, treasury]);
    const crank = await send("e", `crank_fees: claim ${fees} partner fee base units and split them`, dep, [
      launch.crankFees({ agent: agent.id, agentMint: agentMint.id, lineMint: lineMint.id, dbcConfig: dbcConfigKey.id, lineTokenProgram: T22 }),
    ], { computeUnits: 400_000 });
    const [c1, t1] = await reader.tokenBalances([computeVault, treasury]);
    const wantC = (fees * BigInt(net.agent_compute_bps)) / 10_000n;
    const la = (await reader.agentLaunch(agentMint.id))!;
    check("e: compute vault got exactly floor(fees x agent_compute_bps / 10,000)", c1! - c0! === wantC, `${c1! - c0!} of ${fees}`);
    check("e: treasury got exactly the rest", t1! - t0! === fees - wantC, `${t1! - t0!}`);
    check("e: AgentLaunch counters agree", la.feesClaimed === fees && la.toCompute === wantC && la.toProtocol === fees - wantC);
    check("e: partner fee in the pool is now zero", decodeDbcPool((await rpc.getAccountInfo(pool))!.data).partnerQuoteFee === 0n);
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

try {
  if (want("a")) await stepA();
  if (want("b")) await stepB();
  if (want("c")) await stepC();
  if (want("d")) await stepD();
  if (want("e")) await stepE();
  if (want("f")) await stepF();
} finally {
  const end = await rpc.getBalance(dep.id);
  state.deployer_balance_after_setup = sol(end);
  saveState(state);
  log(`deployer ${sol(end)} SOL (spent or moved this run: ${sol(startBalance - end)})`);
}
const v = await reader.vaults([state.agents?.minbpe?.agent].filter(Boolean) as string[]);
log(`vaults (base units): treasury ${v.treasury}, reserve ${v.reserve}, pool ${v.pool}, payable ${v.payable}, bond ${v.bondVault}, compute ${JSON.stringify(Object.fromEntries(Object.entries(v.compute).map(([k, x]) => [k, String(x)])))}`);
