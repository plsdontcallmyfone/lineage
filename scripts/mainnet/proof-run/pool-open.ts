#!/usr/bin/env bun
// Proof run step 2: the live Pools page (/pools) with the test launcher connected, "Open this repository's pool with
// <agent>" for one agent the wallet owns. The page builds and simulates join_pool; this process simulates what the page
// hands the wallet once more and signs only when it succeeds and costs what the page's review showed.
//   bun scripts/mainnet/proof-run/pool-open.ts --agent <agent id> [--send]
import { decodePool, decodePoolMember, poolPdas, TOKEN_2022_PROGRAM } from "@units/chain";
import { chain, j, openPage, saveStep, SITE, sol, solscan } from "./lib.ts";

const argv = process.argv.slice(2);
const AGENT = argv[argv.indexOf("--agent") + 1]!;
const SEND = argv.includes("--send");
const log = (m: string) => console.log(`[pool-open] ${m}`);
const { rpc, wallet, state } = await chain();
let pageCost: bigint | null = null;
const P = await openPage({ send: SEND, guard: (asks) => {
  if (asks.length !== 1) return `the page asked for ${asks.length} transactions, expected one`;
  const d = -BigInt(asks[0]!.wallet_delta_lamports ?? "0");
  if (pageCost === null) return "the page showed no cost";
  if (d > pageCost) return `the simulation spends ${d} lamports, more than the ${pageCost} the page showed`;
  if (d > 30_000_000n) return `the simulation spends ${d} lamports, over this step's 0.03 SOL limit`;
  return null;
} });
const { page, shot, text } = P;
const out: Record<string, unknown> = { how: "the live /pools page, headless, wallet signing with the test key", agent: AGENT };
try {
  const bal0 = await rpc.getBalance(wallet.id);
  await page.goto(`${SITE}/pools`);
  await P.connected();
  const row = page.locator(`[data-pj-agent="${AGENT}"]`);
  await row.waitFor({ timeout: 90_000 });
  out.page_before = (await text("main")).slice(0, 2500);
  out.row_before = { state: await row.getAttribute("data-pj-state"), text: (await row.innerText()).replace(/\s+/g, " ") };
  await shot("2-pools-before");
  log(`row: ${JSON.stringify(out.row_before)}`);
  const btn = row.locator('[data-pj-act="review"]');
  out.button = (await btn.innerText().catch(() => "")).replace(/\s+/g, " ");
  if (!(await btn.count())) throw new Error(`the page offers no action for this agent: ${(out.row_before as any).text}`);
  await btn.click();
  await page.locator(`[data-pj-review="${AGENT}"], [data-pj-agent="${AGENT}"] .banner`).first().waitFor({ timeout: 90_000 });
  const rv = page.locator(`[data-pj-review="${AGENT}"]`);
  if (!(await rv.count())) throw new Error(`no review: ${(await row.innerText()).replace(/\s+/g, " ").slice(0, 600)}`);
  out.review = { title: (await rv.locator("h3").first().innerText()).replace(/\s+/g, " "), facts: await rv.locator("[data-pj-fact]").evaluateAll((els: HTMLElement[]) => els.map((e) => ({ key: e.dataset.pjFact, text: e.innerText.replace(/\s+/g, " ") }))),
    cost_lines: await rv.locator("[data-pj-cost-line]").evaluateAll((els: HTMLElement[]) => els.map((e) => ({ key: e.dataset.pjCostLine, lamports: e.dataset.lamports, text: e.innerText.replace(/\s+/g, " "), label: (e.previousElementSibling as HTMLElement).innerText }))),
    total_lamports: await rv.locator("[data-pj-cost]").getAttribute("data-pj-cost"), text: (await rv.innerText()).replace(/\s+/g, " ") };
  pageCost = BigInt((out.review as any).total_lamports);
  await shot("2-pools-review");
  log(`review: ${(out.review as any).title}; total ${sol(pageCost)} SOL; ${(out.review as any).cost_lines.map((c: any) => `${c.label} ${c.lamports}`).join("; ")}`);
  await rv.locator('[data-pj-act="sign"]').click();
  await page.locator(`[data-pj-agent="${AGENT}"] [data-pj-tx], [data-pj-agent="${AGENT}"] .banner`).first().waitFor({ timeout: 180_000 });
  await new Promise((r) => setTimeout(r, 1500));
  out.wallet_requests = P.requests.map((r) => ({ refused: r.refused, at: r.at, txs: r.asks.map((a) => ({ bytes: a.bytes, version: a.version, programs: a.programs, sim_err: a.sim_err, units: a.units, wallet_delta_lamports: a.wallet_delta_lamports })) }));
  out.wallet_prompts = P.requests.length;
  const sig = await page.locator(`[data-pj-agent="${AGENT}"] [data-pj-tx]`).getAttribute("data-pj-tx").catch(() => null);
  out.row_after = (await row.innerText().catch(() => "")).replace(/\s+/g, " ");
  await shot(SEND ? "2-pools-after-send" : "2-pools-dry-refused");
  if (!SEND) { out.result = "DRY (the wallet refused; the page's transaction simulated here)"; log(`dry: ${JSON.stringify(out.wallet_requests)}`); }
  else {
    if (!sig) throw new Error(`no transaction shown: ${out.row_after}`);
    out.signature = sig; out.solscan = solscan(sig);
    const t = await rpc.call<any>("getTransaction", [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
    const bal1 = await rpc.getBalance(wallet.id);
    out.chain = { slot: t?.slot, err: t?.meta?.err ?? null, fee_lamports: t?.meta?.fee, wallet_spent_lamports: (bal0 - bal1).toString(), page_total_lamports: pageCost.toString(),
      instructions: (t?.meta?.logMessages ?? []).filter((x: string) => x.includes("Instruction:")).map((x: string) => x.split("Instruction: ")[1]) };
    // the accounts on chain
    const launches = (await (await import("@units/chain")).ChainReader.prototype.launches.call(new (await import("@units/chain")).ChainReader(rpc))) as any[];
    const l = launches.find((x) => x.agent === AGENT)!;
    const [pA, mA, vA] = await rpc.getMultipleAccounts([poolPdas.pool(l.repoId), poolPdas.member(AGENT), poolPdas.vault(l.repoId, state.line_mint, TOKEN_2022_PROGRAM)]);
    const pool = pA ? decodePool(pA.data) : null, member = mA ? decodePoolMember(mA.data) : null;
    const ser = (o: any) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v)));
    out.accounts = { pool_address: poolPdas.pool(l.repoId), pool: ser(pool), member_address: poolPdas.member(AGENT), member: ser(member), vault_address: poolPdas.vault(l.repoId, state.line_mint, TOKEN_2022_PROGRAM), vault_exists: !!vA, repo_id: l.repoId };
    const ok = !t?.meta?.err && !!pool && !!member && pool.members.includes(AGENT);
    out.result = ok ? "PASS (chain); site checks below" : "FAIL";
    log(`${ok ? "PASS" : "FAIL"} ${sig}: spent ${sol(bal0 - bal1)} SOL, the page showed ${sol(pageCost)}`);
    // the site: /v1/pools and the page, up to 3 minutes
    for (let i = 0; i < 18; i++) {
      const v = (await j("/v1/pools")).body;
      out.v1_pools = v?.pools ?? null;
      if ((v?.pools ?? []).length) break;
      await new Promise((r) => setTimeout(r, 10_000));
    }
    await page.goto(`${SITE}/pools`);
    await page.locator(`[data-pj-agent="${AGENT}"]`).waitFor({ timeout: 90_000 });
    await new Promise((r) => setTimeout(r, 4000));
    out.page_after = (await text("main")).slice(0, 4000);
    out.row_after_reload = { state: await page.locator(`[data-pj-agent="${AGENT}"]`).getAttribute("data-pj-state"), text: (await page.locator(`[data-pj-agent="${AGENT}"]`).innerText()).replace(/\s+/g, " ") };
    await shot("2-pools-after-reload");
  }
} catch (e) {
  out.result = `FAIL: ${(e as Error).message.slice(0, 800)}`;
  out.wallet_requests ??= P.requests.map((r) => ({ refused: r.refused, txs: r.asks.map((a) => ({ bytes: a.bytes, programs: a.programs, sim_err: a.sim_err, sim_logs_tail: a.sim_logs_tail, wallet_delta_lamports: a.wallet_delta_lamports })) }));
  await shot("2-pools-failure");
  log(String(out.result));
} finally {
  out.page_errors = P.errors.slice(0, 10);
  saveStep(SEND ? "2_pool" : "2_pool_dry", out);
  await P.browser.close();
}
