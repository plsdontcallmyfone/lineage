#!/usr/bin/env bun
// Launchpad L1 (docs/plans/LAUNCHPAD-AND-LIVE.md): graduates one fresh TEST agent token on devnet,
// end to end, and reads every result back from chain:
//   1  launch_agent with the Lineage deployer as launcher (fresh agent key and mint each run)
//   2  fill the DBC curve to its migration threshold with deployer tLINE (one PartialFill buy)
//   3  crank_fees (the curve's partner fees, exact 7000/3000 split)
//   4  Meteora's permissionless migration_damm_v2, then our graduate on DBC's migration position
//   5  trades on the DAMM v2 pool, crank_pool_fees into the agent's compute vault (exact split)
//   6  repoint_position: the deployer locks strictly more liquidity than the migration position in
//      a new position, hands its NFT to the launch authority, and repoints; trades and cranks again
// It never posts epochs or slashes and never uses the Core authority. Every transaction is
// appended to onchain/DEVNET.md in this run's own section (written once, at the end of the run).
// Keys: the deployer (~/.config/lineage/devnet-deployer.json) passed explicitly; the run's fresh
// agent and mint keys are saved under ~/.config/lineage/devnet/grad-<stamp>-*.json (mode 600).
// Usage: bun scripts/devnet/graduation-e2e.ts
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  ata,
  damm,
  dammPdas,
  dbc,
  decodeAgentLaunch,
  decodeDammPool,
  decodeDammPosition,
  decodeDbcPool,
  IDENTITY_MODE,
  launch,
  launchPdas,
  METEORA,
  registryPdas,
  sendAndConfirm,
  setTokenAccountOwner,
  token,
  TOKEN_2022_PROGRAM,
  TxError,
  type Ix,
  type SendOptions,
  type Signer,
} from "@lineage/chain";
import { deployer, key, LAMPORTS, loadState, log, reader, ROOT, rpc, sol } from "./lib.ts";

const T22 = TOKEN_2022_PROGRAM;
const STAMP = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const STEP = "L1";
const META = { name: "TEST graduation agent", symbol: "TGRAD", uri: "https://lineage.invalid/devnet/agents/graduation-test.json" };
const REPO = "https://github.com/karpathy/minbpe";

const state = loadState();
const lineMint = state.line_mint!;
const dbcConfig = state.dbc_config!;
const ONE = 10n ** BigInt(state.line_decimals ?? 6);
const dep = deployer();
const treasury = registryPdas.treasury();
const authority = launchPdas.authority();

// ---------- transaction log (this run's section of onchain/DEVNET.md) ----------
const rows: string[] = [];
const notes: string[] = [];
const results: { name: string; ok: boolean; detail: string }[] = [];
async function send(what: string, payer: Signer, ixs: Ix[], o: SendOptions = {}) {
  try {
    const r = await sendAndConfirm(rpc, payer, ixs, { log: (m) => log(`  ${m}`), ...o });
    const when = new Date().toISOString().replace("T", " ").slice(0, 19);
    rows.push(`| ${when} | ${STEP} | ${what.replace(/\|/g, "/")} | ${r.fee ?? "?"} | \`${r.signature}\` |`);
    log(`${what}: ${r.signature}${r.computeUnits ? ` (${r.computeUnits} CU)` : ""}`);
    return r;
  } catch (e) {
    if (e instanceof TxError) {
      console.error(`[devnet] ${what} FAILED: ${e.message}`);
      for (const l of e.logs.slice(-30)) console.error(`    ${l}`);
    }
    throw e;
  }
}
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`[devnet] ${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) throw new Error(`check failed: ${name}`);
}
function writeSection(outcome: string) {
  const passed = results.filter((r) => r.ok).length;
  const text = [
    "",
    `## Graduation e2e run ${STAMP} (launchpad L1, scripts/devnet/graduation-e2e.ts)`,
    "",
    `Outcome: ${outcome}; checks ${passed}/${results.length}.`,
    "",
    ...notes.map((n) => `- ${n}`),
    "",
    "| When (UTC) | Step | What | Fee | Signature |",
    "|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
  appendFileSync(join(ROOT, "onchain", "DEVNET.md"), text);
}

const bal = async (a: string) => (await reader.tokenBalance(a)) ?? 0n;
const acct = async (a: string) => (await rpc.getAccountInfo(a))!;
const split = (fees: bigint, bps: number) => {
  const c = (fees * BigInt(bps)) / 10_000n;
  return [c, fees - c] as const;
};

async function main() {
  // ---------- preconditions, measured ----------
  const lc = (await reader.launchConfig())!;
  check("launch config live and unpaused, configured DBC config", !!lc && !lc.paused && lc.dbcConfig === dbcConfig && lc.lineMint === lineMint);
  const cfg = (await acct(dbcConfig)).data;
  const cv = new DataView(cfg.buffer, cfg.byteOffset, cfg.length);
  const threshold = cv.getBigUint64(264, true);
  const migrationOption = cfg[233]!, partnerLocked = cfg[239]!, creatorLocked = cfg[241]!;
  check("DBC config: DAMM v2 migration, 100% partner lock, threshold read", migrationOption === 1 && partnerLocked === 100 && creatorLocked === 0,
    `threshold ${threshold} base units (${threshold / ONE} tLINE)`);
  const sol0 = await rpc.getBalance(dep.id);
  const depLine = ata(dep.id, lineMint, T22);
  const line0 = await bal(depLine);
  const poolAuthSol = await rpc.getBalance(METEORA.dbcPoolAuthority);
  const rentPool = await rpc.getMinimumBalanceForRentExemption(1112);
  const rentPos = await rpc.getMinimumBalanceForRentExemption(408);
  const buyIn = (threshold * 110n) / 100n;
  const needLine = buyIn + threshold * 2n + 1_000_000n * ONE;
  notes.push(`Preconditions: deployer ${dep.id} ${sol(sol0)} SOL and ${line0 / ONE} tLINE; DBC config ${dbcConfig} migration threshold ${threshold} base units, migration option ${migrationOption}, partner/creator permanent lock ${partnerLocked}/${creatorLocked}%; DBC pool authority holds ${sol(poolAuthSol)} SOL (it lends migration rent); rent: DAMM pool ${sol(rentPool)}, position ${sol(rentPos)} SOL.`);
  check("deployer holds enough SOL and tLINE", sol0 > LAMPORTS && line0 >= needLine, `${sol(sol0)} SOL, ${line0} tLINE base units, need about ${needLine}`);

  // ---------- 1: launch ----------
  const agent = key(`grad-${STAMP}-agent`);
  const agentMint = key(`grad-${STAMP}-mint`);
  const mint = agentMint.id;
  await send(`launch_agent: TEST graduation agent ${agent.id} on ${REPO}, agent mint ${mint}, launcher = deployer`, dep, [
    launch.launchAgent({ launcher: dep.id, agent: agent.id, agentMint: mint, lineMint, dbcConfig, lineTokenProgram: T22,
      args: { ...META, repoUrl: REPO, identityMode: IDENTITY_MODE.app, hosted: false } }),
  ], { signers: [agent, agentMint], computeUnits: 400_000 });
  const la0 = decodeAgentLaunch((await acct(launchPdas.agentLaunch(mint))).data);
  check("AgentLaunch read back", la0.agent === agent.id && la0.mint === mint && la0.launcher === dep.id && !la0.graduated);
  const dbcPool = launchPdas.dbcPool(dbcConfig, mint, lineMint);
  const vault = launchPdas.computeVault(agent.id);
  const depAgent = ata(dep.id, mint, T22);
  await send("create the launch authority's and the deployer's agent-token ATAs", dep, [
    token.createAtaIdempotent(dep.id, authority, mint, T22), token.createAtaIdempotent(dep.id, dep.id, mint, T22),
  ]);

  // ---------- 2: fill the curve ----------
  const dbcSwap = (buy: boolean, amountIn: bigint, mode = 0) => dbc.swap({ config: dbcConfig, pool: dbcPool, agentMint: mint, lineMint, trader: dep.id,
    lineAccount: depLine, agentAccount: depAgent, buy, amountIn, minOut: 1n, lineTokenProgram: T22, mode });
  const lb = await bal(depLine);
  await send(`fill the curve: deployer buys with up to ${buyIn} tLINE base units (PartialFill, stops at the threshold)`, dep, [dbcSwap(true, buyIn, 1)],
    { computeUnits: 400_000 });
  const spentOnCurve = lb - (await bal(depLine));
  const v = decodeDbcPool((await acct(dbcPool)).data);
  check("curve complete: quote reserve at the threshold, migration progress 2", v.quoteReserve >= threshold && v.migrationProgress === 2,
    `reserve ${v.quoteReserve}, progress ${v.migrationProgress}, deployer paid ${spentOnCurve}, got ${await bal(depAgent)} agent base units`);
  notes.push(`Curve fill: the deployer paid ${spentOnCurve} tLINE base units in one PartialFill buy (quote reserve ${v.quoteReserve}, partner fee ${v.partnerQuoteFee}).`);

  // ---------- 3: crank the curve's fees ----------
  {
    const [c0, t0] = [await bal(vault), await bal(treasury)];
    await send(`crank_fees: curve partner fee ${v.partnerQuoteFee} base units`, dep, [
      token.createAtaIdempotent(dep.id, authority, mint, T22),
      launch.crankFees({ agent: agent.id, agentMint: mint, lineMint, dbcConfig, lineTokenProgram: T22 }),
    ], { computeUnits: 400_000 });
    const [dc, dt] = [(await bal(vault)) - c0, (await bal(treasury)) - t0];
    check("crank_fees before migration: exact split", dc + dt >= v.partnerQuoteFee && dc === split(dc + dt, lc.agentComputeBps)[0], `compute +${dc}, treasury +${dt}`);
  }

  // ---------- 4: Meteora migration, graduate ----------
  const m1 = key(`grad-${STAMP}-nft1`), m2 = key(`grad-${STAMP}-nft2`);
  const dammPool = launchPdas.dammPool(mint, lineMint);
  await send(`Meteora DBC migration_damm_v2: DAMM v2 pool ${dammPool} on config ${METEORA.dammDynamicConfig}`, dep, [
    dbc.migrationDammV2({ dbcPool, dbcConfig, agentMint: mint, lineMint, firstNftMint: m1.id, secondNftMint: m2.id, payer: dep.id, lineTokenProgram: T22 }),
  ], { signers: [m1, m2], computeUnits: 1_400_000 });
  const v2 = decodeDbcPool((await acct(dbcPool)).data);
  const pool = decodeDammPool((await acct(dammPool)).data);
  check("DBC migrated (progress 3), DAMM v2 pool agent/tLINE created by DBC's pool authority",
    v2.isMigrated === 1 && v2.migrationProgress === 3 && pool.tokenAMint === mint && pool.tokenBMint === lineMint && pool.creator === METEORA.dbcPoolAuthority,
    `liquidity ${pool.liquidity}, permanently locked ${pool.permanentLockLiquidity}`);
  const positions = [];
  for (const m of [m1, m2]) {
    const a = await rpc.getAccountInfo(dammPdas.position(m.id));
    if (a && a.owner === METEORA.dammV2Program) positions.push({ nft: m.id, position: dammPdas.position(m.id), nftAccount: dammPdas.positionNftAccount(m.id), ...decodeDammPosition(a.data) });
  }
  const mig = positions.sort((a, b) => (b.permanentLockedLiquidity > a.permanentLockedLiquidity ? 1 : -1))[0]!;
  notes.push(`Migration positions: ${positions.map((p) => `${p.position} (NFT ${p.nft}, locked ${p.permanentLockedLiquidity}, unlocked ${p.unlockedLiquidity})`).join("; ")}.`);
  await send(`graduate: DAMM v2 pool ${dammPool}, migration position ${mig.position}`, dep, [
    launch.graduate({ agentMint: mint, dbcPool, dammPool, position: mig.position, positionNftAccount: mig.nftAccount }),
  ]);
  let la = decodeAgentLaunch((await acct(launchPdas.agentLaunch(mint))).data);
  check("graduated: AgentLaunch records pool and position", la.graduated && la.dammPool === dammPool && la.position === mig.position && la.positionNftAccount === mig.nftAccount);
  if (v2.partnerQuoteFee > 0n) {
    await send(`crank_fees after graduation: ${v2.partnerQuoteFee} base units left on the curve`, dep, [
      launch.crankFees({ agent: agent.id, agentMint: mint, lineMint, dbcConfig, lineTokenProgram: T22 }),
    ], { computeUnits: 400_000 });
  }

  // ---------- 5: DAMM v2 trades, crank_pool_fees ----------
  const dammSwap = (buy: boolean, amountIn: bigint) => damm.swap({ pool: dammPool, agentMint: mint, lineMint, trader: dep.id, lineAccount: depLine,
    agentAccount: depAgent, buy, amountIn, minOut: 1n, lineTokenProgram: T22 });
  async function tradeAndCrank(label: string, position: { position: string; nftAccount: string }) {
    const buy = 200_000n * ONE;
    await send(`DAMM v2 trade (${label}): deployer buys with ${buy / ONE} tLINE`, dep, [dammSwap(true, buy)], { computeUnits: 300_000 });
    const sell = (await bal(depAgent)) / 20n;
    await send(`DAMM v2 trade (${label}): deployer sells ${sell} agent-token base units`, dep, [dammSwap(false, sell)], { computeUnits: 300_000 });
    const [c0, t0] = [await bal(vault), await bal(treasury)];
    const s0 = (await reader.mint(mint))!.supply;
    await send(`crank_pool_fees (${label}): position ${position.position} into compute vault ${vault}`, dep, [
      launch.crankPoolFees({ agent: agent.id, agentMint: mint, lineMint, dammPool, position: position.position, positionNftAccount: position.nftAccount,
        lineTokenProgram: T22 }),
    ], { computeUnits: 400_000 });
    const [c1, t1] = [await bal(vault), await bal(treasury)];
    const s1 = (await reader.mint(mint))!.supply;
    const fees = c1 - c0 + (t1 - t0);
    check(`crank_pool_fees (${label}): pool fees landed in the compute vault, exact split`, fees > 0n && c1 - c0 === split(fees, lc.agentComputeBps)[0],
      `vault ${c0} -> ${c1} (+${c1 - c0}), treasury +${t1 - t0}, agent tokens burned ${s0 - s1}`);
    check(`crank_pool_fees (${label}): the program keeps no agent tokens`, (await bal(ata(authority, mint, T22))) === 0n);
    notes.push(`crank_pool_fees (${label}): compute vault ${vault} ${c0} -> ${c1} base units (+${c1 - c0}), treasury +${t1 - t0}, agent-token fees burned ${s0 - s1}.`);
  }
  await tradeAndCrank("migration position", { position: mig.position, nftAccount: mig.nftAccount });

  // ---------- 6: repoint_position ----------
  const g = key(`grad-${STAMP}-nft3`);
  const gift = { position: dammPdas.position(g.id), nftAccount: dammPdas.positionNftAccount(g.id) };
  await send(`DAMM v2 create_position ${gift.position} (deployer owns the NFT)`, dep, [damm.createPosition({ owner: dep.id, nftMint: g.id, pool: dammPool, payer: dep.id })],
    { signers: [g], computeUnits: 300_000 });
  const locked0 = decodeDammPosition((await acct(mig.position)).data).permanentLockedLiquidity;
  const liq = locked0 + 1n;
  const p = decodeDammPool((await acct(dammPool)).data);
  const [va, vb] = [await bal(launchPdas.dammVault(mint, dammPool)), await bal(launchPdas.dammVault(lineMint, dammPool))];
  const needA = (va * liq) / p.liquidity + 1n, needB = (vb * liq) / p.liquidity + 1n;
  const [haveA, haveB] = [await bal(depAgent), await bal(depLine)];
  check("deployer holds enough of both tokens for a larger locked position", haveA > needA && haveB > needB, `agent ${haveA} vs about ${needA}, tLINE ${haveB} vs about ${needB}`);
  await send(`add_liquidity ${liq} (migration position locked + 1), permanent_lock_position, hand the NFT account to the launch authority`, dep, [
    damm.addLiquidity({ pool: dammPool, nftMint: g.id, owner: dep.id, agentMint: mint, lineMint, agentAccount: depAgent, lineAccount: depLine, liquidity: liq,
      maxAgent: haveA, maxLine: haveB, lineTokenProgram: T22 }),
    damm.permanentLock({ pool: dammPool, nftMint: g.id, owner: dep.id, liquidity: liq }),
    setTokenAccountOwner(gift.nftAccount, authority, dep.id),
  ], { computeUnits: 400_000 });
  const gp = decodeDammPosition((await acct(gift.position)).data);
  check("new position fully locked with strictly more liquidity", gp.permanentLockedLiquidity === liq && gp.unlockedLiquidity === 0n && gp.vestedLiquidity === 0n);
  await send(`repoint_position: ${mig.position} -> ${gift.position}`, dep, [
    launch.repointPosition({ agentMint: mint, currentPosition: mig.position, position: gift.position, positionNftAccount: gift.nftAccount }),
  ]);
  la = decodeAgentLaunch((await acct(launchPdas.agentLaunch(mint))).data);
  check("repointed: AgentLaunch records the new position", la.position === gift.position && la.positionNftAccount === gift.nftAccount);
  await tradeAndCrank("repointed position", gift);

  // ---------- totals ----------
  la = decodeAgentLaunch((await acct(launchPdas.agentLaunch(mint))).data);
  const vaultEnd = await bal(vault);
  check("AgentLaunch totals: to_compute + to_protocol = fees_claimed; vault = to_compute (nothing debited)",
    la.toCompute + la.toProtocol === la.feesClaimed && vaultEnd === la.toCompute, `vault ${vaultEnd}, fees ${la.feesClaimed}, compute ${la.toCompute}, protocol ${la.toProtocol}`);
  const [sol1, line1] = [await rpc.getBalance(dep.id), await bal(depLine)];
  notes.push(`Token mint ${mint}; agent ${agent.id}; DBC pool ${dbcPool}; DAMM v2 pool ${dammPool}; migration position ${mig.position}; repointed position ${gift.position}; compute vault ${vault} ends at ${vaultEnd} base units (to_compute ${la.toCompute}, to_protocol ${la.toProtocol}).`);
  notes.push(`Deployer spent ${sol(sol0 - sol1)} SOL and ${line0 - line1} tLINE base units (curve fill, DAMM trades, locked liquidity); it still holds ${await bal(depAgent)} agent-token base units.`);
  console.log(JSON.stringify({ mint, agent: agent.id, dbcPool, dammPool, migrationPosition: mig.position, repointedPosition: gift.position, vault, vaultEnd: vaultEnd.toString(),
    solSpent: sol(sol0 - sol1), tlineSpent: (line0 - line1).toString() }, null, 2));
}

try {
  await main();
  writeSection("PASS");
  console.log(`[devnet] graduation e2e PASS ${results.length}/${results.length}`);
} catch (e) {
  notes.push(`Stopped: ${(e as Error).message}`);
  writeSection("FAIL");
  console.error(e);
  process.exit(1);
}
