#!/usr/bin/env bun
// Proof run step 3: the next step the live bounty page offers (anyone may send it): "Name the winner" (claim) or
// "Send the payout" (pay), from /bounties/<id> with the test launcher connected. The page's transaction is simulated
// here before the wallet signs: it must succeed and cost the wallet no more than a small fee and rent.
//   bun scripts/mainnet/proof-run/bounty-step.ts --bounty <address> --step claim|pay [--send]
import { decodeTokenAccount, launchPdas } from "@units/chain";
import { chain, j, openPage, saveStep, SITE, sol, solscan } from "./lib.ts";
const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1]! : d);
const SEND = argv.includes("--send"), ID = opt("bounty")!, STEP = opt("step")!;
const log = (m: string) => console.log(`[bounty-step ${STEP}] ${m}`);
const { rpc, wallet } = await chain();
const P = await openPage({ send: SEND, guard: (asks) => {
  if (asks.length !== 1) return `the page asked for ${asks.length} transactions, expected one`;
  const d = -BigInt(asks[0]!.wallet_delta_lamports ?? "0");
  return d > 5_000_000n ? `the simulation spends ${d} lamports, over this step's 0.005 SOL limit` : null;
} });
const { page, shot, text } = P;
const before = (await j(`/api/bounties/${ID}/claim`)).body;
const out: Record<string, unknown> = { how: "the live bounty page, headless, wallet signing with the test key", bounty: ID, step: STEP, core_next_before: before?.next, candidates: (before?.candidates ?? []).map((c: any) => ({ winner: c.winner, claimable_at: c.claimable_at, result: c.result })), claim_before: before?.bounty?.claim ?? null };
try {
  const winner = before?.bounty?.claim?.winner ?? (before?.candidates ?? []).find((c: any) => c.winner)?.result?.author ?? null;
  const vault = winner ? launchPdas.computeVault(winner) : null;
  const vaultBal = async () => { if (!vault) return null; const a = await rpc.getAccountInfo(vault); return a ? decodeTokenAccount(a.data).amount : null; };
  const bal0 = await rpc.getBalance(wallet.id), v0 = await vaultBal();
  await page.goto(`${SITE}/bounties/${ID}`);
  await P.connected();
  await page.locator("[data-bounty-next]").waitFor({ timeout: 90_000 });
  await new Promise((r) => setTimeout(r, 3000));
  out.next_box_before = await text("[data-bounty-next]");
  out.page_before = (await text("main")).slice(0, 3500);
  await shot(`3-bounty-${STEP}-offered`);
  const btn = page.locator(`[data-next-act="${STEP}"]`);
  if (!(await btn.count())) throw new Error(`the page does not offer "${STEP}" now: ${out.next_box_before}`);
  await btn.click();
  await page.locator("[data-next-review], [data-bounty-next] .banner").first().waitFor({ timeout: 120_000 });
  out.review = await text("[data-bounty-next]");
  if (!(await page.locator(`[data-next-review="${STEP}"]`).count())) throw new Error(`no review: ${out.review}`);
  await shot(`3-bounty-${STEP}-review`);
  log(`review: ${out.review}`);
  await page.locator('[data-next-act="send"]').click();
  await page.locator("[data-bounty-next] [data-bounty-tx], [data-bounty-next] .banner.bad").first().waitFor({ timeout: 180_000 });
  out.wallet_requests = P.requests.map((r) => ({ refused: r.refused, at: r.at, txs: r.asks.map((a) => ({ bytes: a.bytes, version: a.version, programs: a.programs, sim_err: a.sim_err, sim_logs_tail: a.sim_err ? a.sim_logs_tail : undefined, units: a.units, wallet_delta_lamports: a.wallet_delta_lamports })) }));
  out.wallet_prompts = P.requests.length;
  out.next_box_after = await text("[data-bounty-next]");
  await shot(SEND ? `3-bounty-${STEP}-sent` : `3-bounty-${STEP}-dry-refused`);
  const sig = await page.locator("[data-bounty-next] [data-bounty-tx]").getAttribute("data-bounty-tx").catch(() => null);
  if (!SEND) { out.result = "DRY (the wallet refused; the page's transaction simulated here)"; log(JSON.stringify(out.wallet_requests)); }
  else {
    if (!sig) throw new Error(`no transaction shown: ${out.next_box_after}`);
    const t = await rpc.call<any>("getTransaction", [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
    const v1 = await vaultBal();
    out.signature = sig; out.solscan = solscan(sig);
    out.chain = { slot: t?.slot, err: t?.meta?.err ?? null, fee_lamports: t?.meta?.fee, wallet_spent_sol: sol(bal0 - (await rpc.getBalance(wallet.id))), winner, winner_compute_vault: vault, vault_before: v0?.toString() ?? null, vault_after: v1?.toString() ?? null,
      vault_gain: v0 !== null && v1 !== null ? (v1 - v0).toString() : null, instructions: (t?.meta?.logMessages ?? []).filter((x: string) => x.includes("Instruction:")).map((x: string) => x.split("Instruction: ")[1]),
      token_moves: (() => { const k = t?.transaction?.message?.accountKeys ?? []; const m = (a: any[]) => new Map(a.map((b: any) => [k[b.accountIndex], BigInt(b.uiTokenAmount.amount)])); const pre = m(t?.meta?.preTokenBalances ?? []), post = m(t?.meta?.postTokenBalances ?? []); return [...new Set([...pre.keys(), ...post.keys()])].map((a) => ({ account: a, delta: ((post.get(a) ?? 0n) - (pre.get(a) ?? 0n)).toString() })).filter((x) => x.delta !== "0"); })() };
    await new Promise((r) => setTimeout(r, 25_000));
    out.core_after = (await j(`/api/bounties/${ID}/claim`)).body;
    out.result = !t?.meta?.err ? "PASS" : "FAIL";
    log(`${out.result} ${sig}: ${JSON.stringify(out.chain).slice(0, 900)}`);
  }
} catch (e) {
  out.result = `FAIL: ${(e as Error).message.slice(0, 900)}`;
  out.wallet_requests ??= P.requests.map((r) => ({ refused: r.refused, txs: r.asks.map((a) => ({ bytes: a.bytes, programs: a.programs, sim_err: a.sim_err, sim_logs_tail: a.sim_logs_tail, wallet_delta_lamports: a.wallet_delta_lamports })) }));
  await shot(`3-bounty-${STEP}-failure`);
  log(String(out.result));
} finally {
  out.page_errors = P.errors.slice(0, 10);
  saveStep(SEND ? `3_bounty_${STEP}` : `3_bounty_${STEP}_dry`, out);
  await P.browser.close();
}
