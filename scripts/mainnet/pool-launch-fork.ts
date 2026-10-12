#!/usr/bin/env bun
// The launch with $UNITS on its PumpSwap pool, on a fork of mainnet with the REAL accounts cloned as
// they are: the three official programs and their config accounts, the $UNITS mint, its (migrated)
// bonding curve, its canonical pool and vaults, the frozen launch lookup table, pump.fun's programs.
// Instruction level: the same groups, planner, compute limits and cost arithmetic the Launch page
// uses (apps/web/wallet/main.ts buildLaunch), signed by throwaway fork keys. Two launches:
//
//   units  the launch buys nothing: a launcher that holds $UNITS pays the credits deposit and the 1%
//          initial buy from it, SOL pays only what is SOL (the plan the page runs when the quote coin
//          has migrated and no purchase is offered);
//   sol    the launcher holds SOL only: the first group buys exactly the $UNITS the launch needs on
//          the pool (pumpSolToLinePool: temporary wrapped SOL account, buy_v2, close).
//
// For each: sizes, compute units against the limits, and the launcher's SOL (and $UNITS) spend against
// the cost lines computed before sending, to the lamport. Nothing is sent to mainnet.
//
//   scripts/mainnet/fork.sh "$LEDGER" $(bun scripts/mainnet/pool-launch-fork.ts --fork-args) &
//   MAINNET_FORK_KEYS=<empty dir outside the repo> UNITS_NETWORK=mainnet bun scripts/mainnet/pool-launch-fork.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalUrl, H } from "@units/protocol";
import {
  ata, compileMessageV0, computeBudget, decodeBondingCurve, decodeLookupTable, decodeMint, decodePumpFeeConfig, decodePumpGlobal, decodePumpPool, decodeTokenAccount,
  IDENTITY_MODE, initialBuyAmount, JITO_BLOCK_ENGINE, JITO_MAX_TXS, JITO_TIP_FLOOR, jitoTipIx, launch, launchCostDetail, launchCreates, launchPdas, launchTableAddresses,
  launchTxUnits, launchUnitsCosts, maxBuyInput, maxSolIn, parsePrepayConfig, planLaunchBundle, poolRates, PUMP, pumpInitialBuy, pumpLaunchMain, pumpPdas, pumpQuotedCurve,
  pumpSolToLinePool, quoteInitialBuy, quotePoolBuyExactOut, registry, rentLamports, requiredCredits, signMessageWith, system, tipFromFloor, TOKEN_2022_PROGRAM,
  TOKEN_ACCOUNT_LEN, wireSize, ChainReader, launchTempWsol, type BundleGroup, type Ix, type LaunchCostTx, type LaunchUnitsCosts, type Signer,
} from "@units/chain";
import { useActiveProfile } from "./steps.ts";

const ROOT = join(import.meta.dir, "..", "..");
const STATE = JSON.parse(readFileSync(join(ROOT, "config/mainnet/state.json"), "utf8"));
const LINE = STATE.line_mint as string, POOL = STATE.line_pool as { pool: string; baseVault: string; quoteVault: string }, TABLE = STATE.launch_lookup_table as string;
const T22 = TOKEN_2022_PROGRAM;
const RECIPIENT = STATE.network_overrides?.prepay?.identity_account_recipient as string;
useActiveProfile();

const sample = (launcher: string, agent: string, mint: string, tipTo: string): Ix[] => [
  ...pumpLaunchMain({ launcher, agent, agentMint: mint, line: { mint: LINE, tokenProgram: T22, pool: POOL }, name: "n", symbol: "S", uri: "u",
    args: { repoUrl: canonicalUrl("https://github.com/karpathy/minbpe"), identityMode: IDENTITY_MODE.token, hosted: true } }),
  registry.setProfile({ signingKey: agent, agent, digest: new Uint8Array(32), seq: 1 }),
  ...pumpSolToLinePool({ launcher, lineMint: LINE, pool: POOL.pool, amountOut: 1n, maxSolIn: 1n, rentToken: 1n, lineTokenProgram: T22 }),
  ...pumpInitialBuy({ launcher, agent, agentMint: mint, lineMint: LINE, amountOut: 1n, maxIn: 1n, lineTokenProgram: T22, createBuyback: true }),
  ...launch.prepay({ launcher, agent, agentMint: mint, lineMint: LINE, amount: 1n, decimals: 6, lineTokenProgram: T22 }),
  system.transfer(launcher, RECIPIENT, 1n),
  system.transfer(launcher, tipTo, 1n),
];

if (process.argv.includes("--fork-args")) {
  // every account the launch names that exists on mainnet and fork.sh does not clone already: cloned as it is now
  const { mainnet } = await import("./lib.ts");
  const { generateAgentKey } = await import("@units/protocol");
  const forkSh = readFileSync(join(import.meta.dir, "fork.sh"), "utf8");
  const k = () => generateAgentKey().id;
  const keys = [...new Set([...sample(k(), k(), k(), k()).flatMap((ix) => [ix.programId, ...ix.keys.map((m) => m.pubkey)]), TABLE, LINE, POOL.pool, POOL.baseVault, POOL.quoteVault,
    ...launchTableAddresses({ lineMint: LINE, lineTokenProgram: T22, linePool: POOL }), PUMP.ammFeeConfig, PUMP.ammGlobalConfig, PUMP.wsol,
    STATE.admin, STATE.core_authority, STATE.runtime_authority, STATE.compute_sink])].filter((a) => !forkSh.includes(a));
  const infos = await mainnet.getMultipleAccounts(keys);
  const args: string[] = [];
  const BUILTIN = /^(11111111111111111111111111111111|ComputeBudget111111111111111111111111111111|TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA|ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL|AddressLookupTab1e1111111111111111111111111|Sysvar.*)$/;
  keys.forEach((a, i) => {
    const x = infos[i];
    if (!x || BUILTIN.test(a)) return;
    args.push((x as { executable?: boolean }).executable ? "--clone-upgradeable-program" : "--clone", a);
  });
  console.log(args.join(" "));
  process.exit(0);
}

const { airdrop, assertFork, check, checks, fork, forkKey, log, measure, rows, sleep, sol } = await import("./lib.ts");
await assertFork();
const reader = new ChainReader(fork);
const net = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
const prepay = parsePrepayConfig({ ...net.prepay, ...(STATE.network_overrides?.prepay ?? {}) });
const rent0 = BigInt(await fork.getMinimumBalanceForRentExemption(0));
const rentToken = rentLamports(TOKEN_ACCOUNT_LEN, rent0);
const tableAcc = await fork.getAccountInfo(TABLE);
if (!tableAcc) throw new Error("the launch lookup table is not on the fork");
const table = { address: TABLE, addresses: decodeLookupTable(tableAcc.data).addresses };
{
  const want = launchTableAddresses({ lineMint: LINE, lineTokenProgram: T22, linePool: POOL });
  check("0: the frozen launch lookup table cloned from mainnet holds exactly the addresses of launchTableAddresses with the pool", table.addresses.length === want.length && want.every((a) => table.addresses.includes(a)),
    `${table.addresses.length} addresses`);
  const c = decodeBondingCurve((await fork.getAccountInfo(pumpPdas.bondingCurve(LINE)))!.data);
  const p = decodePumpPool((await fork.getAccountInfo(POOL.pool))!.data);
  check("0: the real $UNITS on the fork: its curve is complete and migrated, its canonical pool is base $UNITS / quote wrapped SOL with the vaults of state.line_pool",
    c.complete && c.virtualTokenReserves === 0n && p.baseMint === LINE && p.quoteMint === PUMP.wsol && p.poolBaseTokenAccount === POOL.baseVault && p.poolQuoteTokenAccount === POOL.quoteVault && POOL.pool === pumpPdas.pool(LINE, PUMP.wsol));
}

const jito = async () => {
  const a = (await fetch(JITO_BLOCK_ENGINE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTipAccounts", params: [] }) }).then((r) => r.json())) as { result?: string[] };
  if (!a.result?.length) throw new Error("Jito gave no tip accounts");
  return { accounts: a.result, tip: tipFromFloor(await fetch(JITO_TIP_FLOOR).then((r) => r.json()).catch(() => null)) };
};
const signersOf = (ixs: Ix[], pool: Signer[]) => pool.filter((k) => ixs.some((ix) => ix.keys.some((m) => m.isSigner && m.pubkey === k.id)));
const bal = async (a: string) => (await reader.tokenBalance(a)) ?? 0n;

/** The pool as the page reads it, and the exact-output quote on it. */
async function poolNow() {
  const [gA, fcA, ammFcA, curveA, pA, bA, qA, mA] = await fork.getMultipleAccounts([PUMP.global, PUMP.feeConfig, PUMP.ammFeeConfig, pumpPdas.bondingCurve(LINE), POOL.pool, POOL.baseVault, POOL.quoteVault, LINE]);
  const g = decodePumpGlobal(gA!.data), pool = decodePumpPool(pA!.data), base = decodeTokenAccount(bA!.data).amount, quote = decodeTokenAccount(qA!.data).amount;
  const rates = poolRates({ creatorFeeConfigurable: g.creatorFeeConfigurable }, decodePumpFeeConfig(ammFcA!.data), pool, decodeMint(mA!.data).supply, quote + pool.virtualQuoteReserves, base);
  return { g, fc: decodePumpFeeConfig(fcA!.data), curve: decodeBondingCurve(curveA!.data), pool, base, quote, rates, buy: (out: bigint) => quotePoolBuyExactOut(rates, pool, base, quote, out) };
}

async function sendPlan(step: string, launcher: Signer, extra: Signer[], plan: ReturnType<typeof planLaunchBundle>, units: (groups: string[]) => number) {
  const { blockhash } = await fork.getLatestBlockhash();
  const signed = plan.map((x) => {
    const ixs = [computeBudget.limit(units(x.groups)), computeBudget.price(1), ...x.ixs];
    const msg = compileMessageV0(launcher.id, ixs, blockhash, [table]);
    return { ...x, limit: units(x.groups), size: wireSize({ bytes: msg.bytes, numSigners: msg.numSigners }), numSigners: msg.numSigners, tx: signMessageWith(msg, [launcher, ...signersOf(ixs, extra)]) };
  });
  const out: { groups: string[]; size: number; limit: number; cu: number; fee: number; created: { bytes: number }[] }[] = [];
  for (const [i, x] of signed.entries()) {
    // no simulation before sending (the page simulates nothing): the node's own preflight is skipped too
    await fork.sendRawTransaction(x.tx.wire, true);
    let ok = false;
    for (let k = 0; k < 120 && !ok; k++) {
      await sleep(500);
      if (k % 4 === 3) await fork.sendRawTransaction(x.tx.wire, true).catch(() => undefined);
      const [st] = await fork.getSignatureStatuses([x.tx.signature]);
      if (st?.err) {
        const t = await fork.call<{ meta: { logMessages?: string[] } }>("getTransaction", [x.tx.signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]).catch(() => null);
        for (const l of (t?.meta.logMessages ?? []).slice(-30)) console.error(`    ${l}`);
        throw new Error(`${step}: transaction ${i + 1} (${x.groups.join(" + ")}) failed: ${JSON.stringify(st.err)}`);
      }
      ok = !!st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized");
    }
    if (!ok) throw new Error(`${step}: transaction ${i + 1} was not confirmed`);
    const c = await measure(step, `tx ${i + 1}/${signed.length}: ${x.groups.join(" + ")} (${x.size} bytes, v0)`, x.tx.signature);
    log(`${step}: ${c.what}: fee ${c.fee}, ${c.computeUnits} CU of ${x.limit}, created ${c.created.map((a) => a.bytes).join(", ") || "nothing"}`);
    out.push({ groups: x.groups, size: x.size, limit: x.limit, cu: c.computeUnits ?? 0, fee: c.fee, created: c.created });
  }
  return { out, signatures: signed.map((x) => x.numSigners) };
}

const record: Record<string, unknown> = { fork_genesis: await fork.call<string>("getGenesisHash"), line_mint: LINE, line_pool: POOL, table: TABLE, rent0: rent0.toString() };

async function launchOnce(mode: "units" | "sol", tag: string) {
  const launcher = forkKey(`launcher-${tag}`), agent = forkKey(`agent-${tag}`), mint = forkKey(`mint-${tag}`);
  await airdrop(launcher.id, 2n * 10n ** 9n);
  const bps = prepay.initial_buy_slippage_bps;
  const deposit = requiredCredits(prepay, STATE.line_decimals);
  const { accounts, tip } = await jito();
  const tipIx = jitoTipIx(launcher.id, accounts, tip);
  await airdrop(tipIx.keys[1]!.pubkey, 10n ** 9n); // fork only: the tip account exists on mainnet
  const identity = BigInt(prepay.identity_account_price_lamports);

  if (mode === "units") {
    // the launcher gets its $UNITS the way a person would: a buy on the pool, in a transaction of its own BEFORE the launch.
    // Exact output through pumpSolToLinePool, so the quote and the builder are checked here too.
    const p = await poolNow();
    // a fifth more than the launch needs at the price now (its own purchase moves the price a little)
    const q0 = quoteInitialBuy(p.g, p.fc, pumpQuotedCurve(p.g, { curve: p.curve, pool: { pool: p.pool, baseReserve: p.base, quoteReserve: p.quote } }, launchPdas.pumpCreator(agent.id), LINE, 0n, "swap"),
      initialBuyAmount(p.g.tokenTotalSupply, prepay.initial_buy_bps));
    const want = ((deposit + q0) * 12n) / 10n;
    const q = p.buy(want), maxSol = maxSolIn(q.quoteIn, bps);
    const s0 = await fork.getBalance(launcher.id);
    const pre = planLaunchBundle({ payer: launcher.id, groups: [{ name: "sol-to-units", ixs: pumpSolToLinePool({ launcher: launcher.id, lineMint: LINE, pool: POOL.pool, amountOut: want, maxSolIn: maxSol, rentToken, lineTokenProgram: T22 }) }],
      budget: [computeBudget.limit(1), computeBudget.price(1)], table, v0: true });
    const r = await sendPlan(`${tag} pre`, launcher, [], pre, () => 300_000);
    const spent = s0 - (await fork.getBalance(launcher.id));
    const rents = r.out[0]!.created.reduce((n, a) => n + rentLamports(a.bytes, rent0), 0n);
    check(`${tag}: a stand-alone exact-output buy on the real pool delivered exactly the amount asked and took exactly quotePoolBuyExactOut's SOL (plus fee and the rent of the accounts it made)`,
      (await bal(ata(launcher.id, LINE, T22))) === want && spent === q.quoteIn + BigInt(r.out[0]!.fee) + rents && !(await fork.getAccountInfo(launchTempWsol(launcher.id))),
      `${want} base units for ${q.quoteIn} lamports (pool leg ${q.leg}, LP ${q.lpFee}, protocol ${q.protocolFee}, creator ${q.creatorFee}); spent ${spent}; ${r.out[0]!.cu} CU; ${r.out[0]!.size} bytes; created ${r.out[0]!.created.map((a) => a.bytes).join(", ")} bytes`);
    record.standalone_pool_buy = { inputs: { base_reserve: p.base.toString(), quote_vault: p.quote.toString(), virtual_quote_reserves: p.pool.virtualQuoteReserves.toString(),
      lp_fee_bps: p.rates.lpFeeBps.toString(), protocol_fee_bps: p.rates.protocolFeeBps.toString(), creator_fee_bps: p.rates.creatorFeeBps.toString() },
      pool_leg: q.leg.toString(), lp_fee: q.lpFee.toString(), protocol_fee: q.protocolFee.toString(), creator_fee: q.creatorFee.toString(), spent_lamports: spent.toString(),
      units: want.toString(), quote_lamports: q.quoteIn.toString(), cu: r.out[0]!.cu, bytes: r.out[0]!.size, created_bytes: r.out[0]!.created.map((a) => a.bytes) };
  }

  // the figures the page computes: the new coin's starting curve from the pool's reserves, the 1% buy, what the launch needs
  const p = await poolNow();
  const amountOut = initialBuyAmount(p.g.tokenTotalSupply, prepay.initial_buy_bps);
  const fresh = pumpQuotedCurve(p.g, { curve: p.curve, pool: { pool: p.pool, baseReserve: p.base, quoteReserve: p.quote } }, launchPdas.pumpCreator(agent.id), LINE, 0n, "swap");
  const quote = quoteInitialBuy(p.g, p.fc, fresh, amountOut);
  const maxIn = maxBuyInput(quote, bps);
  const need = deposit + maxIn;
  const createBuyback = !(await fork.getAccountInfo(ata(PUMP.buybackRecipients[0], LINE, T22)));
  let solToLine: Ix[] = [], purchase: { whole: bigint; credits: bigint } | null = null, headroom = 0n, fromUnits: LaunchUnitsCosts | undefined;
  if (mode === "sol") {
    const whole = p.buy(need).quoteIn, part = p.buy(deposit).quoteIn, maxSol = maxSolIn(whole, bps);
    headroom = maxSol - whole + rentToken;
    purchase = { whole, credits: part };
    solToLine = pumpSolToLinePool({ launcher: launcher.id, lineMint: LINE, pool: POOL.pool, amountOut: need, maxSolIn: maxSol, rentToken, lineTokenProgram: T22 });
  } else fromUnits = launchUnitsCosts({ deposit, buy: { quote, maxIn } });
  const name = "Quartz fork proof", symbol = "QRTZ", uri = `https://app.units.gg/coin/${mint.id}.json?i=${"h".repeat(64)}&l=${"h".repeat(64)}`.slice(0, 200);
  const groups: BundleGroup[] = [
    { name: "launch", ixs: pumpLaunchMain({ launcher: launcher.id, agent: agent.id, agentMint: mint.id, line: { mint: LINE, tokenProgram: T22, pool: POOL }, name, symbol, uri,
      args: { repoUrl: canonicalUrl("https://github.com/karpathy/minbpe"), identityMode: IDENTITY_MODE.token, hosted: true } }) },
    { name: "soul", ixs: [registry.setProfile({ signingKey: agent.id, agent: agent.id, digest: H("soul", `pool launch fork ${tag}`), seq: 1 })] },
    { name: "sol-to-units", ixs: solToLine },
    { name: "initial-buy", ixs: pumpInitialBuy({ launcher: launcher.id, agent: agent.id, agentMint: mint.id, lineMint: LINE, amountOut, maxIn, lineTokenProgram: T22, createBuyback }) },
    { name: "credits", ixs: launch.prepay({ launcher: launcher.id, agent: agent.id, agentMint: mint.id, lineMint: LINE, amount: deposit, decimals: STATE.line_decimals, lineTokenProgram: T22 }) },
    { name: "units-account", ixs: [system.transfer(launcher.id, RECIPIENT, identity)] },
    { name: "tip", ixs: [tipIx] },
  ];
  const plan = planLaunchBundle({ payer: launcher.id, groups, budget: [computeBudget.limit(1_400_000), computeBudget.price(1)], table, v0: true, maxTxs: JITO_MAX_TXS });
  const venue = mode === "sol" ? "pool" : "curve";
  const creates = launchCreates({ name, symbol, uri,
    purchase: solToLine.length ? { launcherLine: ata(launcher.id, LINE, T22), launcherVolume: pumpPdas.ammUserVolume(launcher.id), venue: "pool" } : undefined,
    buy: { createsBuyback: createBuyback, launcherVolume: pumpPdas.userVolume(launcher.id) } });
  const maybe = creates.flatMap((c) => (c.address ? [c.address] : []));
  const there = await fork.getMultipleAccounts(maybe);
  const FAKE = "11111111111111111111111111111111";
  const txs: LaunchCostTx[] = plan.map((t) => ({ groups: t.groups, signatures: compileMessageV0(launcher.id, [computeBudget.limit(1), computeBudget.price(1), ...t.ixs], FAKE, [table]).numSigners,
    units: launchTxUnits(t.groups, venue), price: 1 }));
  const detail = launchCostDetail({ txs, rent0, creates, existing: new Set(maybe.filter((_, i) => !!there[i])), purchase, hasBuy: true, identity, tip, headroom, units: fromUnits });
  log(`${tag}: plan ${plan.map((x) => `${x.groups.join(" + ")} (${x.size} bytes)`).join("; ")}; total ${sol(detail.costs.total)} SOL, wallet must hold ${sol(detail.costs.needed)}${fromUnits ? `, plus ${fromUnits.total} $UNITS base units (hold ${fromUnits.needed})` : ""}`);

  const s0 = await fork.getBalance(launcher.id), u0 = await bal(ata(launcher.id, LINE, T22));
  const sent = await sendPlan(tag, launcher, [agent, mint], plan, (g) => launchTxUnits(g, venue));
  const s1 = await fork.getBalance(launcher.id), u1 = await bal(ata(launcher.id, LINE, T22));

  const la = await reader.agentLaunch(mint.id);
  const ac = decodeBondingCurve((await fork.getAccountInfo(pumpPdas.bondingCurve(mint.id)))!.data);
  check(`${tag}: create_v2 took the REAL migrated $UNITS as the quote (its pool and vaults named): the agent coin exists, quoted in $UNITS, depth 1, creator the agent's PDA, registered in the same transaction`,
    !!la && la.venue === "pump" && ac.quoteMint === LINE && ac.depth === 1 && ac.creator === launchPdas.pumpCreator(agent.id) && !!(await reader.agent(agent.id)));
  check(`${tag}: the starting curve create_v2 wrote equals pumpQuotedCurve on the pool's reserves`, ac.initialVirtualQuoteReserves === fresh.virtualQuoteReserves, `seed ${ac.initialVirtualQuoteReserves} vs ${fresh.virtualQuoteReserves}`);
  check(`${tag}: the compute vault holds the credits deposit`, (await bal(launchPdas.computeVault(agent.id))) === deposit, `${deposit} base units`);
  check(`${tag}: the 1% initial buy is in the agent key's account, exactly`, (await bal(ata(agent.id, mint.id, T22))) === amountOut, `${amountOut} base units for ${quote} $UNITS base units (bound ${maxIn})`);
  check(`${tag}: the plan fits (${plan.length} transactions, each within 1,232 bytes)`, plan.length <= JITO_MAX_TXS && sent.out.every((x) => x.size <= 1232), sent.out.map((x) => `${x.groups.join(" + ")} ${x.size} bytes`).join("; "));
  check(`${tag}: every transaction used at most 62.5% of its compute limit (the 1.6 times headroom rule)`, sent.out.every((x) => x.cu * 1.6 <= x.limit), sent.out.map((x) => `${x.cu} of ${x.limit}`).join("; "));
  check(`${tag}: the launcher's SOL spend equals the cost lines' total computed before sending, to the lamport`, s0 - s1 === detail.costs.total,
    `spent ${s0 - s1}, total ${detail.costs.total} (creation ${detail.costs.creation}, credits ${detail.costs.credits}, buy ${detail.costs.buy}, units account ${detail.costs.identity}, tip ${detail.costs.tip}); rents ${detail.rents.map((r) => `${r.what} ${r.size}`).join(", ")}`);
  if (mode === "units") check(`${tag}: the launcher's $UNITS fell by exactly the deposit plus the initial buy's quote`, u0 - u1 === fromUnits!.total, `${u0 - u1} base units`);
  else check(`${tag}: the purchase delivered exactly what the launch spent: the launcher's $UNITS account holds the unused slippage bound of the initial buy and no more; no wrapped SOL account is left`,
    u1 - u0 === maxIn - quote && !(await fork.getAccountInfo(launchTempWsol(launcher.id))), `${u1 - u0} base units left`);
  record[mode] = { mode, agent: agent.id, mint: mint.id, deposit: deposit.toString(), initial_buy: { amount_out: amountOut.toString(), quote: quote.toString(), max_in: maxIn.toString() },
    txs: sent.out, total_lamports: detail.costs.total.toString(), needed_lamports: detail.costs.needed.toString(), spent_lamports: (s0 - s1).toString(),
    purchase: purchase ? { whole: purchase.whole.toString(), credits: purchase.credits.toString(), headroom: headroom.toString() } : null,
    units: fromUnits ? { total: fromUnits.total.toString(), needed: fromUnits.needed.toString(), spent: (u0 - u1).toString() } : null, rents: detail.rents.map((r) => ({ what: r.what, size: r.size, lamports: r.lamports.toString() })) };
}

let outcome = "PASS";
try {
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
  const run = (Date.now() % 1_000_000).toString(36); // fresh throwaway keys every run
  if (!only || only === "units") await launchOnce("units", `units-${run}`);
  if (!only || only === "sol") await launchOnce("sol", `sol-${run}`);
} catch (e) {
  outcome = `FAIL: ${(e as Error).message}`;
  console.error(e);
}
record.outcome = outcome;
record.checks = checks;
record.rows = rows;
writeFileSync(join(import.meta.dir, "POOL-LAUNCH-FORK-LAST.json"), JSON.stringify(record, null, 2) + "\n");
log(`${outcome}: ${checks.filter((c) => c.ok).length}/${checks.length} checks`);
process.exit(outcome === "PASS" ? 0 : 1);
