#!/usr/bin/env bun
// Proof run step 1: buys an exact amount of $UNITS with SOL on its PumpSwap pool from the test launcher, with the
// builder the launch form uses for its own purchase (packages/chain pumpSolToLinePool, priced by quotePoolBuyExactOut
// and bounded by maxSolIn, as apps/web/wallet/main.ts does). The site has no page that buys $UNITS alone, so this
// step is a script built from the page's builders. Simulated first; sent only with --send and when the simulated
// cost is within the bound.
//   bun scripts/mainnet/proof-run/buy-units.ts [--units 40000] [--slippage-bps 100] [--send]
import { ata, compileMessage, computeBudget, decodeMint, decodePumpFeeConfig, decodePumpGlobal, decodePumpPool, decodeTokenAccount, maxSolIn, poolRates, PUMP, pumpSolToLinePool, quotePoolBuyExactOut,
  rentLamports, signMessageWith, TOKEN_2022_PROGRAM, TOKEN_ACCOUNT_LEN } from "@units/chain";
import { chain, j, saveStep, simulateFor, sol, solscan } from "./lib.ts";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1]! : d);
const SEND = argv.includes("--send");
const WANT = BigInt(Math.round(Number(opt("units", "40000")) * 1e6));
const BPS = Number(opt("slippage-bps", "100"));
const log = (m: string) => console.log(`[buy-units] ${m}`);

const { state, rpc, wallet } = await chain();
const LINE = state.line_mint as string, lp = state.line_pool as { pool: string; baseVault: string; quoteVault: string };
const T22 = TOKEN_2022_PROGRAM;
const mine = ata(wallet.id, LINE, T22);
const [gA, fcA, pA, bA, qA, mA, hA] = await rpc.getMultipleAccounts([PUMP.global, PUMP.ammFeeConfig, lp.pool, lp.baseVault, lp.quoteVault, LINE, mine]);
if (!gA || !fcA || !pA || !bA || !qA || !mA) throw new Error("pump.fun's Global, PumpSwap's fee config or the $UNITS pool is missing");
const pool = decodePumpPool(pA.data), base = decodeTokenAccount(bA.data).amount, quote = decodeTokenAccount(qA.data).amount;
if (pool.baseMint !== LINE || pool.quoteMint !== PUMP.wsol) throw new Error("the pool on chain is not the $UNITS pool");
const rates = poolRates({ creatorFeeConfigurable: decodePumpGlobal(gA.data).creatorFeeConfigurable }, decodePumpFeeConfig(fcA.data), pool, decodeMint(mA.data).supply, quote + pool.virtualQuoteReserves, base);
const q = quotePoolBuyExactOut(rates, pool, base, quote, WANT);
const maxSol = maxSolIn(q.quoteIn, BPS);
const rent0 = BigInt(await rpc.call<number>("getMinimumBalanceForRentExemption", [0]));
const rentToken = rentLamports(TOKEN_ACCOUNT_LEN, rent0);
const held0 = hA ? decodeTokenAccount(hA.data).amount : 0n;
const spot = Number(quote + pool.virtualQuoteReserves) / 1e9 / (Number(base) / 1e6); // SOL per UNITS before the trade
const paid = Number(q.quoteIn) / 1e9 / (Number(WANT) / 1e6);
const solUsd = (await j("/chain/sol-price")).body?.usd ?? null, siteQuote = (await j("/market/quote-usd")).body ?? null;
log(`pool reserves ${Number(base) / 1e6} UNITS, ${sol(quote)} SOL; spot ${spot.toExponential(6)} SOL per UNITS; ${Number(WANT) / 1e6} UNITS quoted at ${sol(q.quoteIn)} SOL (fees and price impact ${(100 * (paid / spot - 1)).toFixed(3)}% over spot); bound ${sol(maxSol)} SOL (${BPS} bps)`);

const ixs = [computeBudget.limit(300_000), computeBudget.price(10_000), ...pumpSolToLinePool({ launcher: wallet.id, lineMint: LINE, pool: lp.pool, amountOut: WANT, maxSolIn: maxSol, rentToken, lineTokenProgram: T22 })];
const bal0 = await rpc.getBalance(wallet.id);
const { blockhash } = await rpc.getLatestBlockhash();
const tx = signMessageWith(compileMessage(wallet.id, ixs, blockhash), [wallet]);
const sim = await simulateFor(rpc, Buffer.from(tx.wire).toString("base64"), [wallet.id, mine]);
const simSpent = sim.accounts?.[0] ? bal0 - BigInt(sim.accounts[0].lamports) : null;
const simHeld = sim.accounts?.[1] ? decodeTokenAccount(new Uint8Array(Buffer.from(sim.accounts[1].data[0], "base64"))).amount : null;
log(`simulation: ${sim.err ? `FAILED ${JSON.stringify(sim.err)} ${(sim.logs ?? []).slice(-4).join(" | ")}` : `ok, ${sim.unitsConsumed} compute units, wallet spends ${simSpent === null ? "?" : sol(simSpent)} SOL, holds ${simHeld === null ? "?" : Number(simHeld) / 1e6} UNITS after`}`);
const feeBound = 5_000n + 3_000n + 2_100_000n; // signature, priority, and the wallet's UNITS account rent if it is new
const within = !sim.err && simSpent !== null && simHeld !== null && simHeld - held0 === WANT && simSpent <= maxSol + feeBound;
const rec: Record<string, unknown> = { how: "script built from the launch form's own purchase builder (pumpSolToLinePool, quotePoolBuyExactOut, maxSolIn): the site has no page that buys $UNITS alone",
  units_wanted: (Number(WANT) / 1e6).toString(), pool: lp.pool, pool_reserves: { units: (Number(base) / 1e6).toString(), sol: sol(quote) }, spot_sol_per_units: spot, quoted_sol_in: sol(q.quoteIn),
  quote_parts_lamports: Object.fromEntries(Object.entries(q).map(([k, v]) => [k, String(v)])), over_spot_pct: 100 * (paid / spot - 1), slippage_bound_bps: BPS, max_sol_in: sol(maxSol),
  sol_usd: solUsd, site_quote_usd: siteQuote, simulation: { err: sim.err, units_consumed: sim.unitsConsumed, wallet_spends_sol: simSpent === null ? null : sol(simSpent), units_after: simHeld === null ? null : (Number(simHeld) / 1e6).toString() } };
if (!SEND || !within) {
  saveStep("1_buy_units", { ...rec, result: within ? "DRY (simulated only)" : "FAIL: the simulation failed or its cost is outside the bound; nothing sent" });
  log(within ? "dry run: nothing sent" : "NOT SENT: the simulation failed or is outside the bound");
  process.exit(within ? 0 : 1);
}
await rpc.sendRawTransaction(tx.wire, true);
log(`sent ${tx.signature}`);
let st: { err: unknown; slot: number } | null = null;
for (let i = 0; i < 90 && !st; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const [s] = await rpc.getSignatureStatuses([tx.signature]);
  if (s && (s.err || s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) st = s;
  else if (i % 3 === 2) await rpc.sendRawTransaction(tx.wire, true).catch(() => undefined);
}
const bal1 = await rpc.getBalance(wallet.id);
const held1 = (await rpc.getAccountInfo(mine).then((a) => (a ? decodeTokenAccount(a.data).amount : 0n)));
const t = st ? await rpc.getTransaction(tx.signature).catch(() => null) : null;
const spent = bal0 - bal1, got = held1 - held0;
const tradeSol = spent - BigInt(t?.meta?.fee ?? 0) - (hA ? 0n : rentToken);
const ok = !!st && !st.err && got === WANT;
saveStep("1_buy_units", { ...rec, result: ok ? "PASS" : "FAIL", signature: tx.signature, solscan: solscan(tx.signature), slot: st?.slot ?? null, err: st?.err ?? (st ? null : "not confirmed in 90 s"),
  fee_lamports: t?.meta?.fee ?? null, wallet_spent_sol: sol(spent), units_received: (Number(got) / 1e6).toString(), units_account_rent_paid_sol: hA ? "0" : sol(rentToken),
  trade_sol: sol(tradeSol), price_sol_per_units: Number(tradeSol) / 1e9 / (Number(got) / 1e6), price_usd_per_units: solUsd ? (Number(tradeSol) / 1e9 / (Number(got) / 1e6)) * solUsd : null,
  slippage_vs_quote_pct: 100 * (Number(tradeSol) / Number(q.quoteIn) - 1), wallet_sol_before: sol(bal0), wallet_sol_after: sol(bal1), units_held_after: (Number(held1) / 1e6).toString() });
log(`${ok ? "PASS" : "FAIL"}: spent ${sol(spent)} SOL (trade ${sol(tradeSol)}, quoted ${sol(q.quoteIn)}), received ${Number(got) / 1e6} UNITS; ${solscan(tx.signature)}`);
process.exit(ok ? 0 : 1);
