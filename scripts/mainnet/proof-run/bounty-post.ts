#!/usr/bin/env bun
// Proof run step 3: one bounty posted from the test launcher on the live Bounties page (/bounties), paid from the wallet
// (the escrow program). The page's transaction is simulated here before the wallet signs: it must succeed, take exactly
// the reward the review showed from the wallet's $UNITS and no more SOL than the review's rent and fee.
//   bun scripts/mainnet/proof-run/bounty-post.ts --unit <lineage id> --metric <name> --pct 2 [--reward-usd <n>] [--days 1] [--max-units 28500] [--send]
import { ata, decodeTokenAccount, TOKEN_2022_PROGRAM } from "@units/chain";
import { chain, j, openPage, saveStep, simulateFor, SITE, sol, solscan } from "./lib.ts";

const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1]! : d);
const SEND = argv.includes("--send");
const UNIT = opt("unit")!, METRIC = opt("metric")!, PCT = opt("pct", "2")!, DAYS = opt("days", "1")!, MAX_UNITS = BigInt(Math.round(Number(opt("max-units", "28500")) * 1e6));
const log = (m: string) => console.log(`[bounty-post] ${m}`);
const { rpc, wallet, state } = await chain();
const mine = ata(wallet.id, state.line_mint, TOKEN_2022_PROGRAM);
const held = async () => { const a = await rpc.getAccountInfo(mine); return a ? decodeTokenAccount(a.data).amount : 0n; };
let shown: { amount: bigint; rent: bigint } | null = null;
const guardSim: Record<string, unknown> = {};
const P = await openPage({ send: SEND, guard: async (asks) => {
  if (asks.length !== 1) return `the page asked for ${asks.length} transactions, expected one`;
  if (!shown) return "the page showed no review";
  const before = await held(), bal = await rpc.getBalance(wallet.id);
  const sim = await simulateFor(rpc, asks[0]!.b64, [wallet.id, mine]);
  if (sim.err || !sim.accounts?.[0] || !sim.accounts?.[1]) return `simulation failed: ${JSON.stringify(sim.err)}`;
  const coinOut = before - decodeTokenAccount(new Uint8Array(Buffer.from(sim.accounts[1].data[0], "base64"))).amount, solOut = bal - BigInt(sim.accounts[0].lamports);
  Object.assign(guardSim, { units_leaving: coinOut.toString(), sol_leaving_lamports: solOut.toString(), units_consumed: sim.unitsConsumed });
  if (coinOut !== shown.amount) return `the simulation takes ${coinOut} base units of UNITS, the review showed ${shown.amount}`;
  if (coinOut > MAX_UNITS) return `the reward ${coinOut} is over this step's limit ${MAX_UNITS}`;
  if (solOut > shown.rent + 20_000n) return `the simulation spends ${solOut} lamports, the review showed rent ${shown.rent} and a small fee`;
  return null;
} });
const { page, shot, text } = P;
const out: Record<string, unknown> = { how: "the live /bounties page, headless, wallet signing with the test key", unit: UNIT, metric: METRIC, pct: PCT, days: DAYS };
try {
  const bal0 = await rpc.getBalance(wallet.id), coin0 = await held();
  out.board_config = (await j("/api/bounties/board")).body?.escrow ?? null;
  await page.goto(`${SITE}/bounties`);
  await P.connected();
  const form = page.locator('[data-wallet-form="bounty-post"]');
  await form.waitFor({ timeout: 90_000 });
  await shot("3-bounties-empty-board");
  out.page_before = (await text("main")).slice(0, 3000);
  const payer = form.locator('select[name="bo_payer"]');
  if (await payer.count()) {
    out.payer_options = await payer.locator("option").allInnerTexts();
    const v = await payer.locator("option").evaluateAll((os: HTMLOptionElement[]) => os.find((o) => /^This wallet/.test(o.textContent ?? ""))?.value ?? null);
    if (!v) throw new Error("the form does not offer paying from this wallet");
    await payer.selectOption(v);
  } else out.payer_options = "hidden field: this wallet";
  await form.locator('select[name="bo_unit"]').waitFor();
  out.unit_options = await page.locator('select[name="bo_unit"] option').allInnerTexts();
  await page.selectOption('select[name="bo_unit"]', UNIT);
  await page.locator(`select[name="bo_metric"] option[value="${METRIC}"]`).waitFor({ state: "attached", timeout: 30_000 });
  out.metric_options = await page.locator('select[name="bo_metric"] option').evaluateAll((os: HTMLOptionElement[]) => os.map((o) => `${o.value}: ${o.textContent}`));
  await page.selectOption('select[name="bo_metric"]', METRIC);
  await page.fill('[name="bo_pct"]', PCT);
  const help = (await page.locator('[name="bo_reward"]').locator("xpath=..").innerText()).replace(/\s+/g, " ");
  out.reward_help = help;
  const smallest = (/Smallest reward \$\s*([\d,]+(?:\.\d+)?)/.exec(help) ?? [])[1] ?? null;
  const reward = opt("reward-usd") ?? smallest;
  if (!reward) throw new Error(`the form names no smallest reward in dollars: ${help}`);
  out.reward_typed_usd = reward;
  await page.fill('[name="bo_reward"]', reward);
  await page.locator(`[data-bounty-days="${DAYS}"]`).click();
  await page.fill('[name="bo_note"]', "Proof run 2026-10-13: a test bounty from the throwaway test wallet.").catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  out.form_view = (await text("[data-bounty-post]")).slice(0, 3500);
  out.metric_explain = await text("[data-metric-explain]");
  out.deadline_line = await text("[data-deadline-line]");
  await shot("3-bounties-form");
  await page.locator('[data-bounty-act="review"]').click();
  await page.locator('[data-bounty-review], [data-bounty-post] .banner, [data-bounty-short]').first().waitFor({ timeout: 120_000 });
  const rv = page.locator('[data-bounty-review="wallet"]');
  if (!(await rv.count())) {
    out.refusal = { typed_usd: reward, banner: await text("[data-bounty-post] .banner"), short: await text("[data-bounty-short]") };
    throw new Error(`the form gave no review: ${(out.refusal as any).banner} ${(out.refusal as any).short}`);
  }
  shown = { amount: BigInt((await rv.locator("[data-review-amount]").getAttribute("data-review-amount"))!), rent: BigInt((await rv.locator("[data-review-rent]").getAttribute("data-review-rent"))!) };
  out.review = { amount_base_units: shown.amount.toString(), rent_lamports: shown.rent.toString(), text: (await text("[data-bounty-post]")).slice(0, 3500) };
  await shot("3-bounties-review");
  log(`review: reward ${Number(shown.amount) / 1e6} UNITS, rent ${sol(shown.rent)} SOL; ${(out.review as any).text.slice(0, 700)}`);
  await page.locator('[data-bounty-act="sign"]').click();
  await page.locator("[data-bounty-tx], [data-bounty-post] .banner").first().waitFor({ timeout: 180_000 });
  await new Promise((r) => setTimeout(r, 1500));
  out.wallet_requests = P.requests.map((r) => ({ refused: r.refused, at: r.at, txs: r.asks.map((a) => ({ bytes: a.bytes, version: a.version, programs: a.programs, sim_err: a.sim_err, units: a.units, wallet_delta_lamports: a.wallet_delta_lamports })) }));
  out.wallet_prompts = P.requests.length;
  out.messages_signed = P.messages;
  out.guard_simulation = guardSim;
  const sig = await page.locator("[data-bounty-tx]").getAttribute("data-bounty-tx").catch(() => null);
  if (!SEND) { out.result = "DRY (the wallet refused; the page's transaction simulated here)"; await shot("3-bounties-dry-refused"); log(`dry: ${JSON.stringify(out.wallet_requests)} ${JSON.stringify(guardSim)}`); }
  else {
    if (!sig) throw new Error(`no transaction shown: ${(await text("[data-bounty-post]")).slice(0, 900)}`);
    out.signature = sig; out.solscan = solscan(sig);
    // the page links the bounty once Core took its terms
    await page.locator("[data-bounty-posted]").waitFor({ timeout: 150_000 }).catch(() => {});
    out.bounty = await page.locator("[data-bounty-posted]").getAttribute("data-bounty-posted").catch(() => null);
    out.done_view = await text("[data-bounty-post]");
    await shot("3-bounties-posted");
    const t = await rpc.call<any>("getTransaction", [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
    const bal1 = await rpc.getBalance(wallet.id), coin1 = await held();
    out.chain = { slot: t?.slot, err: t?.meta?.err ?? null, fee_lamports: t?.meta?.fee, wallet_sol_spent_lamports: (bal0 - bal1).toString(), wallet_units_spent: (coin0 - coin1).toString(), review_amount: shown.amount.toString(), review_rent_lamports: shown.rent.toString(),
      instructions: (t?.meta?.logMessages ?? []).filter((x: string) => x.includes("Instruction:")).map((x: string) => x.split("Instruction: ")[1]),
      token_balances_after: (t?.meta?.postTokenBalances ?? []).map((b: any) => ({ account: t.transaction.message.accountKeys[b.accountIndex], owner: b.owner, mint: b.mint, amount: b.uiTokenAmount.amount })) };
    const ok = !t?.meta?.err && coin0 - coin1 === shown.amount;
    out.result = ok ? "PASS (posted); see checks" : "FAIL";
    log(`${ok ? "PASS" : "FAIL"} ${sig}: bounty ${out.bounty}; ${Number(coin0 - coin1) / 1e6} UNITS and ${sol(bal0 - bal1)} SOL left the wallet`);
  }
} catch (e) {
  out.result = `FAIL: ${(e as Error).message.slice(0, 900)}`;
  out.wallet_requests ??= P.requests.map((r) => ({ refused: r.refused, txs: r.asks.map((a) => ({ bytes: a.bytes, programs: a.programs, sim_err: a.sim_err, sim_logs_tail: a.sim_logs_tail, wallet_delta_lamports: a.wallet_delta_lamports })) }));
  await shot("3-bounties-failure");
  log(String(out.result));
} finally {
  out.page_errors = P.errors.slice(0, 10);
  saveStep(SEND ? "3_bounty_post" : "3_bounty_post_dry", out);
  await P.browser.close();
}
