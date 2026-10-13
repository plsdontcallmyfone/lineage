#!/usr/bin/env bun
// Proof run step 4, recovery: the launch's second transaction (fee-route + sol-to-units + credits) failed on chain
// (PumpSwap ExceededSlippage on the $UNITS purchase) after Jito did not take the bundle and the page sent the
// transactions one by one. The page offers "Launch again" only in the tab that launched, and the site has no page
// that adds credits or sets a fee route for an agent already launched, so this script sends exactly the missing
// transaction, built from the page's own builders (apps/web/wallet/fee-route-step.ts launchExtras: claims.setFeeRoute
// for the repository's GitHub id at ClaimConfig.min_bps; main.ts: pumpSolToLinePool priced by quotePoolBuyExactOut and
// bounded by maxSolIn; launch.prepay: the transfer into the compute vault and refresh_awake), v0 with the launch
// lookup table as the page builds it. Simulated first; sent only with --send and when the simulation succeeds.
//   bun scripts/mainnet/proof-run/launch-complete.ts --agent <id> --mint <mint> --repo owner/name [--usd 10] [--slippage-bps 100] [--send]
import { ata, claimPdas, claims, compileMessageV0, computeBudget, creditsAtPrice, decodeClaimConfig, decodeLookupTable, decodeMint, decodePumpFeeConfig, decodePumpGlobal, decodePumpPool, decodeTokenAccount, launch, launchPdas, maxSolIn,
  poolRates, PUMP, pumpSolToLinePool, quotePoolBuyExactOut, rentLamports, signBytes, TOKEN_2022_PROGRAM, TOKEN_ACCOUNT_LEN } from "@units/chain";
import { placeSignature, unsignedWire } from "../../../packages/chain/src/browser/wire.ts";
import { chain, j, saveStep, simulateFor, sol, solscan } from "./lib.ts";

const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1]! : d);
const SEND = argv.includes("--send");
const AGENT = opt("agent")!, MINT = opt("mint")!, REPO = opt("repo")!, USD = opt("usd", "10")!, BPS = Number(opt("slippage-bps", "100"));
const log = (m: string) => console.log(`[launch-complete] ${m}`);
const { state, rpc, wallet } = await chain();
const LINE = state.line_mint as string, T22 = TOKEN_2022_PROGRAM, lp = state.line_pool as { pool: string; baseVault: string; quoteVault: string };

const gh = (await j(`/api/github/repos/${REPO}`)).body;
if (!gh?.id || String(gh.full_name).toLowerCase() !== REPO.toLowerCase()) throw new Error(`the site's GitHub lookup did not confirm ${REPO}`);
const price = (await j("/market/quote-usd")).body;
if (!price?.ok || !(price.usd > 0) || price.age_s > price.max_age_s) throw new Error("no fresh UNITS price from the site");
const deposit = creditsAtPrice(USD, price.usd, 6);
const vault = launchPdas.computeVault(AGENT), mine = ata(wallet.id, LINE, T22);
const [ccA, frA, tA, gA, fcA, pA, bA, qA, mA, vA] = await rpc.getMultipleAccounts([claimPdas.config(), claimPdas.feeRoute(AGENT), state.launch_lookup_table, PUMP.global, PUMP.ammFeeConfig, lp.pool, lp.baseVault, lp.quoteVault, LINE, vault]);
if (!ccA || !tA || !gA || !fcA || !pA || !bA || !qA || !mA || !vA) throw new Error("an account the transaction reads is missing");
const cc = decodeClaimConfig(ccA.data);
if (cc.minBps !== cc.maxBps) throw new Error("ClaimConfig min_bps and max_bps differ: the page would not offer one share");
const vault0 = decodeTokenAccount(vA.data).amount;
const pool = decodePumpPool(pA.data), base = decodeTokenAccount(bA.data).amount, quote = decodeTokenAccount(qA.data).amount;
const rates = poolRates({ creatorFeeConfigurable: decodePumpGlobal(gA.data).creatorFeeConfigurable }, decodePumpFeeConfig(fcA.data), pool, decodeMint(mA.data).supply, quote + pool.virtualQuoteReserves, base);
const whole = quotePoolBuyExactOut(rates, pool, base, quote, deposit).quoteIn, maxSol = maxSolIn(whole, BPS);
const rentToken = rentLamports(TOKEN_ACCOUNT_LEN, BigInt(await rpc.call<number>("getMinimumBalanceForRentExemption", [0])));
const route = frA ? [] : [claims.setFeeRoute({ owner: wallet.id, agent: AGENT, agentMint: MINT, lineMint: LINE, githubId: BigInt(gh.id), bps: cc.minBps, lineTokenProgram: T22 })];
const ixs = [computeBudget.limit(347_000), computeBudget.price(10_000), ...route,
  ...pumpSolToLinePool({ launcher: wallet.id, lineMint: LINE, pool: lp.pool, amountOut: deposit, maxSolIn: maxSol, rentToken, lineTokenProgram: T22 }),
  ...launch.prepay({ launcher: wallet.id, agent: AGENT, agentMint: MINT, lineMint: LINE, amount: deposit, decimals: 6, lineTokenProgram: T22 })];
const table = { address: state.launch_lookup_table as string, addresses: decodeLookupTable(tA.data).addresses };
const { blockhash } = await rpc.getLatestBlockhash();
const msg = compileMessageV0(wallet.id, ixs, blockhash, [table]);
const wire = placeSignature(unsignedWire(msg), wallet.id, signBytes(wallet, msg.bytes));
const bal0 = await rpc.getBalance(wallet.id);
const sim = await simulateFor(rpc, Buffer.from(wire).toString("base64"), [wallet.id, vault, mine]);
const simSpent = sim.accounts?.[0] ? bal0 - BigInt(sim.accounts[0].lamports) : null;
const simVault = sim.accounts?.[1] ? decodeTokenAccount(new Uint8Array(Buffer.from(sim.accounts[1].data[0], "base64"))).amount : null;
log(`${REPO} is GitHub id ${gh.id}; share ${cc.minBps} bps; $${USD} of credits = ${Number(deposit) / 1e6} UNITS at $${price.usd} (read ${price.age_s} s ago); purchase quoted ${sol(whole)} SOL, bound ${sol(maxSol)} (${BPS} bps); ${wire.length} bytes v0${route.length ? "" : "; the fee route exists already"}`);
log(`simulation: ${sim.err ? `FAILED ${JSON.stringify(sim.err)} ${(sim.logs ?? []).slice(-5).join(" | ")}` : `ok, ${sim.unitsConsumed} compute units, wallet spends ${simSpent === null ? "?" : sol(simSpent)} SOL, vault ${simVault === null ? "?" : Number(simVault) / 1e6} UNITS after`}`);
const rec: Record<string, unknown> = { how: "script built from the page's own builders (the site has no page for this once the launching tab is gone)", agent: AGENT, mint: MINT, repo: REPO, github_id: gh.id, route_bps: cc.minBps,
  credits_usd: USD, credits_units: (Number(deposit) / 1e6).toString(), units_usd_at_build: price.usd, purchase_quoted_sol: sol(whole), purchase_bound_sol: sol(maxSol), slippage_bps: BPS, bytes: wire.length,
  simulation: { err: sim.err, units_consumed: sim.unitsConsumed, wallet_spends_sol: simSpent === null ? null : sol(simSpent), logs_tail: sim.err ? (sim.logs ?? []).slice(-6) : undefined } };
const within = !sim.err && simSpent !== null && simVault !== null && simVault - vault0 === deposit && simSpent <= maxSol + 6_000_000n;
if (!SEND || !within) {
  saveStep(SEND ? "4_launch_complete" : "4_launch_complete_dry", { ...rec, result: within ? "DRY (simulated only)" : "FAIL: the simulation failed or its cost is outside the bound; nothing sent" });
  process.exit(within ? 0 : 1);
}
const sig = await rpc.sendRawTransaction(wire, true);
log(`sent ${sig}`);
let st: { err: unknown; slot: number } | null = null;
for (let i = 0; i < 90 && !st; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const [s] = await rpc.getSignatureStatuses([sig]);
  if (s && (s.err || s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) st = s;
  else if (i % 3 === 2) await rpc.sendRawTransaction(wire, true).catch(() => undefined);
}
const t = st ? await rpc.call<any>("getTransaction", [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]).catch(() => null) : null;
const bal1 = await rpc.getBalance(wallet.id);
const vault1 = await rpc.getAccountInfo(vault).then((a) => (a ? decodeTokenAccount(a.data).amount : 0n));
const ok = !!st && !st.err && vault1 - vault0 === deposit;
saveStep("4_launch_complete", { ...rec, result: ok ? "PASS" : "FAIL", signature: sig, solscan: solscan(sig), slot: st?.slot ?? null, err: st?.err ?? (st ? null : "not confirmed in 90 s"), fee_lamports: t?.meta?.fee ?? null,
  instructions: (t?.meta?.logMessages ?? []).filter((x: string) => x.includes("Instruction:")).map((x: string) => x.split("Instruction: ")[1]), logs_tail: st?.err ? (t?.meta?.logMessages ?? []).slice(-8) : undefined,
  wallet_spent_sol: sol(bal0 - bal1), vault_units_after: (Number(vault1) / 1e6).toString() });
log(`${ok ? "PASS" : "FAIL"}: wallet spent ${sol(bal0 - bal1)} SOL, vault holds ${Number(vault1) / 1e6} UNITS; ${solscan(sig)}${st?.err ? ` ${JSON.stringify(st.err)}` : ""}`);
process.exit(ok ? 0 : 1);
