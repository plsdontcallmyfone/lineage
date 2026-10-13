#!/usr/bin/env bun
// Proof run step 5: one small buy of an agent coin from the test launcher through the coin page's trade box, paid in SOL
// (the box's "Pay with: SOL", pump.fun's multi-hop swap through $UNITS). The page's transaction is simulated here before
// the wallet signs: it must succeed and take no more SOL than the amount typed plus fees and the new token account's rent.
//   bun scripts/mainnet/proof-run/coin-buy.ts --mint <mint> [--sol 0.02] [--slippage-bps <n>] [--send]
import { ata, decodeTokenAccount, TOKEN_2022_PROGRAM } from "@units/chain";
import { chain, openPage, saveStep, SITE, sol, solscan } from "./lib.ts";
const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1]! : d);
const SEND = argv.includes("--send"), MINT = opt("mint")!, SOL = opt("sol", "0.02")!;
const log = (m: string) => console.log(`[coin-buy] ${m}`);
const { rpc, wallet } = await chain();
const lam = BigInt(Math.round(Number(SOL) * 1e9));
const P = await openPage({ send: SEND, guard: (asks) => {
  if (asks.length !== 1) return `the page asked for ${asks.length} transactions, expected one`;
  const d = -BigInt(asks[0]!.wallet_delta_lamports ?? "0");
  return d > lam + 3_000_000n ? `the simulation spends ${d} lamports, over the ${lam} typed plus 0.003 SOL of rent and fees` : null;
} });
const { page, shot, text } = P;
const out: Record<string, unknown> = { how: "the coin page's trade box on the live site, headless, Pay with SOL", mint: MINT, sol_typed: SOL };
try {
  const mine = ata(wallet.id, MINT, TOKEN_2022_PROGRAM);
  const held = async () => { const a = await rpc.getAccountInfo(mine); return a ? decodeTokenAccount(a.data).amount : 0n; };
  const bal0 = await rpc.getBalance(wallet.id), tok0 = await held();
  await page.goto(`${SITE}/tokens/${MINT}`);
  await P.connected();
  const box = page.locator(".mk-tb");
  await box.locator('[name="tb_amount"]:not([disabled])').waitFor({ timeout: 90_000 });
  await box.locator('[data-tb="gear"]').click();
  await box.locator('select[name="tb_pay"]').waitFor({ timeout: 20_000 });
  out.pay_with_options = await box.locator('select[name="tb_pay"] option').allInnerTexts();
  out.pay_with_help = (await box.locator(".mk-tb2-set").innerText()).replace(/\s+/g, " ");
  await box.locator('select[name="tb_pay"]').selectOption("SOL");
  out.slippage_default_bps = await box.locator('[name="tb_slip"]').inputValue().catch(() => null);
  if (opt("slippage-bps")) { await box.locator('[name="tb_slip"]').fill(opt("slippage-bps")!); out.slippage_typed_bps = opt("slippage-bps"); }
  await box.locator('[name="tb_amount"]').fill(SOL);
  await new Promise((r) => setTimeout(r, 800));
  out.box_before = (await box.innerText()).replace(/\s+/g, " ").slice(0, 1500);
  await box.locator('[data-tb="review"]').click();
  await box.locator('[data-quote-out], [data-err]').first().waitFor({ timeout: 120_000 });
  out.quote = { out_base_units: await box.locator("[data-quote-out]").first().getAttribute("data-quote-out").catch(() => null), text: (await box.locator(".mk-tb-quote").first().innerText().catch(() => "")).replace(/\s+/g, " "), err: (await box.locator("[data-err]").innerText().catch(() => "")).slice(0, 600) };
  await shot("5-coin-buy-review");
  log(`quote: ${JSON.stringify(out.quote).slice(0, 700)}`);
  if (!(out.quote as any).out_base_units) throw new Error(`no quote: ${(out.quote as any).err}`);
  await box.locator('[data-tb="sign"]').click();
  await box.locator("[data-sig], [data-err]").first().waitFor({ timeout: 180_000 });
  out.wallet_requests = P.requests.map((r) => ({ refused: r.refused, at: r.at, txs: r.asks.map((a) => ({ bytes: a.bytes, version: a.version, programs: a.programs, sim_err: a.sim_err, units: a.units, wallet_delta_lamports: a.wallet_delta_lamports })) }));
  out.wallet_prompts = P.requests.length;
  const sig = await box.locator("[data-sig]").getAttribute("data-sig").catch(() => null);
  out.box_after = (await box.innerText()).replace(/\s+/g, " ").slice(0, 1500);
  await shot(SEND ? "5-coin-buy-done" : "5-coin-buy-dry-refused");
  if (!SEND) { out.result = "DRY (the wallet refused; the page's transaction simulated here)"; log(JSON.stringify(out.wallet_requests)); }
  else {
    if (!sig) throw new Error(`no transaction shown: ${out.box_after}`);
    const t = await rpc.call<any>("getTransaction", [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
    const bal1 = await rpc.getBalance(wallet.id), tok1 = await held();
    out.signature = sig; out.solscan = solscan(sig);
    out.chain = { slot: t?.slot, err: t?.meta?.err ?? null, fee_lamports: t?.meta?.fee, wallet_spent_sol: sol(bal0 - bal1), coins_received: (Number(tok1 - tok0) / 1e6).toString(), page_quoted_out: (Number(BigInt((out.quote as any).out_base_units)) / 1e6).toString(),
      instructions: (t?.meta?.logMessages ?? []).filter((x: string) => x.includes("Instruction:")).map((x: string) => x.split("Instruction: ")[1]) };
    const ok = !t?.meta?.err && tok1 > tok0;
    out.result = ok ? "PASS" : "FAIL";
    log(`${ok ? "PASS" : "FAIL"} ${sig}: ${sol(bal0 - bal1)} SOL for ${Number(tok1 - tok0) / 1e6} coins (the page quoted ${(out.chain as any).page_quoted_out})`);
  }
} catch (e) {
  out.result = `FAIL: ${(e as Error).message.slice(0, 900)}`;
  out.wallet_requests ??= P.requests.map((r) => ({ refused: r.refused, txs: r.asks.map((a) => ({ bytes: a.bytes, programs: a.programs, sim_err: a.sim_err, sim_logs_tail: a.sim_logs_tail, wallet_delta_lamports: a.wallet_delta_lamports })) }));
  await shot("5-coin-buy-failure");
  log(String(out.result));
} finally {
  out.page_errors = P.errors.slice(0, 10);
  saveStep(SEND ? `5_coin_buy${opt("tag") ? `_${opt("tag")}` : ""}` : "5_coin_buy_dry", out);
  await P.browser.close();
}
