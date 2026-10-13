#!/usr/bin/env bun
// Proof run step 3, read only: the posted bounty on chain (the escrow's balance), on the board (its card, the
// "What does this mean?" panel, the dollars against the site's price) and on its own page (the next step offered).
//   bun scripts/mainnet/proof-run/bounty-check.ts --bounty <address> --escrow <token account> [--tag <name>]
import { decodeTokenAccount } from "@units/chain";
import { chain, j, openPage, saveStep, SITE } from "./lib.ts";

const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1]! : d);
const ID = opt("bounty")!, ESCROW = opt("escrow")!, TAG = opt("tag", "posted")!;
const { rpc } = await chain();
const out: Record<string, unknown> = {};
const eA = await rpc.getAccountInfo(ESCROW);
const escrow = eA ? decodeTokenAccount(eA.data) : null;
out.escrow = { address: ESCROW, amount: escrow?.amount.toString() ?? null, owner: escrow?.owner ?? null, mint: escrow?.mint ?? null };
const board = (await j("/api/bounties/board")).body;
const mine = (board?.bounties ?? []).find((b: any) => JSON.stringify(b).includes(ID));
out.board_entry = mine ?? null;
out.view = (await j(`/api/bounties/${ID}/view`)).body;
out.claim = (await j(`/api/bounties/${ID}/claim`)).body;
const price = (await j("/market/quote-usd")).body;
out.site_price = price;
const P = await openPage({ send: false, guard: () => "read only" });
try {
  await P.page.goto(`${SITE}/bounties`);
  await P.connected();
  const card = P.page.locator(`a[href*="${ID}"]`).first();
  await card.waitFor({ timeout: 90_000 }).catch(() => {});
  const cardBox = P.page.locator(`[data-bounty="${ID}"], article:has(a[href*="${ID}"]), li:has(a[href*="${ID}"]), .bo-card:has(a[href*="${ID}"])`).first();
  out.card_text = ((await cardBox.innerText().catch(() => "")) as string).replace(/\s+/g, " ").slice(0, 2500);
  // the panel: a details or a toggle named "What does this mean?"
  const tog = cardBox.locator('summary:has-text("What does this mean?"), button:has-text("What does this mean?")').first();
  out.panel_toggle_present = (await tog.count()) > 0;
  if (await tog.count()) { await tog.click().catch(() => {}); await new Promise((r) => setTimeout(r, 800)); }
  out.card_text_panel_open = ((await cardBox.innerText().catch(() => "")) as string).replace(/\s+/g, " ").slice(0, 3500);
  await P.shot(`3-board-${TAG}`);
  out.board_page_text = (await P.text("main")).slice(0, 2500);
  await P.page.goto(`${SITE}/bounties/${ID}`);
  await P.page.locator("[data-bounty-next], main h1").first().waitFor({ timeout: 90_000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 5000));
  out.bounty_page_text = (await P.text("main")).slice(0, 5000);
  out.bounty_page_next = await P.text("[data-bounty-next]");
  await P.shot(`3-bounty-page-${TAG}`);
  const amount = Number(escrow?.amount ?? 0n) / 1e6;
  out.dollars_expected_at_site_price = price?.usd ? amount * price.usd : null;
  out.page_errors = P.errors.slice(0, 10);
} finally {
  await P.browser.close();
}
saveStep(`3_bounty_check_${TAG}`, out);
console.log(JSON.stringify(out, null, 1).slice(0, 9000));
