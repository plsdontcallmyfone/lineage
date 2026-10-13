#!/usr/bin/env bun
// Proof run step 6: one message to an agent from the live Talk page (/talk?agent=<id>) with the test launcher connected.
// The page's transaction is simulated here before the wallet signs: it must succeed and take no more than the message's
// amount plus the fee the page showed. After it lands: the transaction on chain (a transfer and a memo), the page's
// "You and <agent>" list and recent messages, and Core's view of it.
//   bun scripts/mainnet/proof-run/talk-send.ts --agent <id> --text "<message>" [--send]
import { chain, j, openPage, saveStep, SITE, sol, solscan } from "./lib.ts";
const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1]! : d);
const SEND = argv.includes("--send"), AGENT = opt("agent")!, TEXT = opt("text")!;
const log = (m: string) => console.log(`[talk-send] ${m}`);
const { rpc, wallet } = await chain();
const board = (await j("/api/talk")).body;
const out: Record<string, unknown> = { how: "the live /talk page, headless, wallet signing with the test key", agent: AGENT, text: TEXT, board: { open: board?.open, closed_why: board?.closed_why, min_lamports: board?.min_lamports, max_bytes: board?.max_bytes, replies: board?.replies, memo_prefix: board?.memo_prefix },
  agent_on_board: (board?.agents ?? []).find((a: any) => a.agent === AGENT) ?? null, conversations_config_people: (await j("/api/conversations/config")).body?.people ?? null };
if (!board?.open) { saveStep("6_talk", { ...out, result: `SKIPPED: sending is off (${board?.closed_why ?? "no answer"})` }); console.log("sending is off; skipped"); process.exit(0); }
const min = BigInt(board.min_lamports);
const P = await openPage({ send: SEND, guard: (asks) => {
  if (asks.length !== 1) return `the page asked for ${asks.length} transactions, expected one`;
  const d = -BigInt(asks[0]!.wallet_delta_lamports ?? "0");
  return d > min + 100_000n ? `the simulation spends ${d} lamports, over the message's ${min} plus a fee` : null;
} });
const { page, shot, text } = P;
try {
  const bal0 = await rpc.getBalance(wallet.id);
  await page.goto(`${SITE}/talk?agent=${AGENT}`);
  await P.connected();
  const box = page.locator('[data-tk="text"]');
  await box.waitFor({ timeout: 90_000 });
  out.page_before = (await text("main")).slice(0, 3500);
  await box.fill(TEXT);
  await page.locator('[data-tk-act="send"]:not([disabled])').waitFor({ timeout: 90_000 });
  out.cost_shown = { count: await text("[data-tk-count]"), fee: await text("[data-tk-fee]"), total: await text("[data-tk-total]") };
  await shot("6-talk-composed");
  log(`cost shown: ${JSON.stringify(out.cost_shown)}`);
  await page.locator('[data-tk-act="send"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-tk-act="send"]') || /sent|Solscan|did not|refused|closed the wallet|dry run/i.test(document.querySelector("main")?.textContent ?? ""), null, { timeout: 180_000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 3000));
  out.wallet_requests = P.requests.map((r) => ({ refused: r.refused, at: r.at, txs: r.asks.map((a) => ({ bytes: a.bytes, version: a.version, programs: a.programs, sim_err: a.sim_err, units: a.units, wallet_delta_lamports: a.wallet_delta_lamports })) }));
  out.wallet_prompts = P.requests.length;
  out.page_after_send = (await text("main")).slice(0, 3500);
  await shot(SEND ? "6-talk-sent" : "6-talk-dry-refused");
  if (!SEND) { out.result = "DRY (the wallet refused; the page's transaction simulated here)"; log(JSON.stringify(out.wallet_requests)); }
  else {
    const sent = P.sends.filter((s) => s.method === "sendTransaction").map((s) => { try { return JSON.parse(s.result).result as string; } catch { return null; } }).filter(Boolean) as string[];
    const sig = sent[0] ?? null;
    if (!sig) throw new Error(`the page sent no transaction: ${String(out.page_after_send).slice(0, 600)}`);
    out.signature = sig; out.solscan = solscan(sig);
    let t: any = null;
    for (let i = 0; i < 30 && !t; i++) { t = await rpc.call<any>("getTransaction", [sig, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]).catch(() => null); if (!t) await new Promise((r) => setTimeout(r, 2000)); }
    const ins = (t?.transaction?.message?.instructions ?? []) as any[];
    out.chain = { slot: t?.slot, err: t?.meta?.err ?? null, fee_lamports: t?.meta?.fee, wallet_spent_lamports: (bal0 - (await rpc.getBalance(wallet.id))).toString(),
      instructions: ins.map((i) => ({ program: i.program ?? i.programId, parsed: i.parsed ?? null })) };
    // the page's lists and Core's view, for up to 3 minutes
    let seen: any = null;
    for (let i = 0; i < 18 && !seen; i++) {
      await new Promise((r) => setTimeout(r, 10_000));
      const v = (await j(`/api/talk/${AGENT}?wallet=${wallet.id}`)).body;
      seen = JSON.stringify(v ?? {}).includes(sig) ? v : null;
      out.core_view_keys = v ? Object.keys(v) : null;
    }
    out.core_indexed = !!seen;
    out.core_view = seen ? JSON.parse(JSON.stringify(seen, (k, v) => (Array.isArray(v) ? v.slice(0, 4) : v))) : null;
    await page.reload();
    await page.locator('[data-tk="text"]').waitFor({ timeout: 90_000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 8000));
    out.page_after_reload = (await text("main")).slice(0, 5000);
    await shot("6-talk-after-reload");
    const ok = !t?.meta?.err && !!seen;
    out.result = ok ? "PASS" : !t?.meta?.err ? "PARTIAL: sent on chain; Core had not listed it within 3 minutes" : "FAIL";
    log(`${out.result} ${sig}`);
  }
} catch (e) {
  out.result = `FAIL: ${(e as Error).message.slice(0, 900)}`;
  await shot("6-talk-failure");
  log(String(out.result));
} finally {
  out.page_errors = P.errors.slice(0, 10);
  saveStep(SEND ? "6_talk" : "6_talk_dry", out);
  await P.browser.close();
}
