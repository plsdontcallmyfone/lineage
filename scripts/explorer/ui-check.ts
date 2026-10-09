#!/usr/bin/env bun
// Headless check of the token directory (/explorer) and every /docs page at 1280 and 390 px:
// no horizontal scroll, no console errors, no monospace, figures equal the indexer's, and search
// resolving real devnet ids to their token pages. Screenshots go to --shots.
//
//   bun scripts/explorer/ui-check.ts --pw <dir with node_modules/playwright-core> --web http://127.0.0.1:9663
//     [--market http://127.0.0.1:9668] [--shots <dir>]
// playwright-core is not a repo dependency: pass its location.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const PW = arg("pw");
if (!PW) throw new Error("--pw <dir with node_modules/playwright-core> is required");
const WEB = arg("web", "http://127.0.0.1:9663")!.replace(/\/+$/, "");
const MARKET = arg("market", "http://127.0.0.1:9668")!.replace(/\/+$/, "");
const SHOTS = arg("shots", "/tmp/lineage-explorer-shots")!;
mkdirSync(SHOTS, { recursive: true });
const { chromium } = await import(join(PW, "node_modules", "playwright-core", "index.mjs"));

const GRAD_MINT = "AbBT1Mh3mQJgMfVVfKj8zUZhD4mLw5NqbJptFUacb9Zz";
const GRAD_AGENT = "EfyccrDk4Tg77PapaYf4tPMsmLLz6yAEKA57VhN62pMq";
const DOCS = ["", "how-it-works", "launch-an-agent", "verification", "fees-and-compute", "graduation", "souls-and-identity", "api-and-embed-kit", "faq"];

const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

const browser = await chromium.launch();
async function page(width: number) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on("console", (m: any) => m.type() === "error" && errors.push(m.text()));
  p.on("pageerror", (e: Error) => errors.push(String(e)));
  return { p, errors, ctx };
}
async function layout(p: any) {
  return p.evaluate(() => {
    const doc = document.documentElement;
    const mono: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim())) continue;
      const f = getComputedStyle(el).fontFamily;
      if (/mono|courier|consolas|menlo/i.test(f)) mono.push(`${el.tagName}.${el.className}: ${f}`);
    }
    return { scroll: doc.scrollWidth - doc.clientWidth, mono: mono.slice(0, 3) };
  });
}
async function settle(p: any) {
  await p.waitForLoadState("networkidle").catch(() => {});
  await p.waitForTimeout(700);
}

for (const width of [1280, 390]) {
  const { p, errors, ctx } = await page(width);
  // ---- directory home
  await p.goto(`${WEB}/explorer`);
  await p.waitForSelector(".ex-card", { timeout: 30_000 });
  await settle(p);
  let l = await layout(p);
  check(`${width} /explorer no horizontal scroll`, l.scroll <= 0, `overflow ${l.scroll}px`);
  check(`${width} /explorer no monospace`, l.mono.length === 0, l.mono.join("; "));
  const sum = await (await fetch(`${MARKET}/market/summary`)).json();
  const list = await (await fetch(`${MARKET}/market/tokens?sort=market_cap&limit=24`)).json();
  const ui = await p.evaluate(() => ({
    ctrs: [...document.querySelectorAll(".ex-ctr b")].map((b) => b.textContent),
    cards: [...document.querySelectorAll<HTMLElement>(".ex-card")].map((c) => c.dataset.mint),
    showing: document.querySelector(".ex-showing")?.textContent ?? "",
    canvases: [...document.querySelectorAll("canvas")].filter((c) => (c as HTMLCanvasElement).width > 0).length,
  }));
  check(`${width} counters equal /market/summary`, JSON.stringify(ui.ctrs) === JSON.stringify([sum.tokens, sum.awake, sum.verified_generations, sum.graduated].map((v) => String(v ?? "TBA"))), `${ui.ctrs} vs ${[sum.tokens, sum.awake, sum.verified_generations, sum.graduated]}`);
  check(`${width} cards in the indexer's Top order`, JSON.stringify(ui.cards) === JSON.stringify(list.tokens.map((t: any) => t.mint)), `${ui.cards.length} cards`);
  check(`${width} showing line`, ui.showing.includes(`of ${list.count}`), ui.showing);
  check(`${width} screens painted`, ui.canvases > 0, `${ui.canvases} canvases`);
  await p.screenshot({ path: join(SHOTS, `explorer-${width}.png`), fullPage: false });
  await p.screenshot({ path: join(SHOTS, `explorer-${width}-full.png`), fullPage: true });

  // ---- filters and sorts
  await p.click("[data-ex-state=graduated]");
  await p.waitForFunction(() => document.querySelector("[data-ex-state=graduated]")?.getAttribute("aria-pressed") === "true");
  await settle(p);
  const grads = await p.evaluate(() => [...document.querySelectorAll<HTMLElement>(".ex-card")].map((c) => c.dataset.mint));
  const gradList = await (await fetch(`${MARKET}/market/tokens?state=graduated&sort=market_cap`)).json();
  check(`${width} state Graduated filter`, JSON.stringify(grads) === JSON.stringify(gradList.tokens.map((t: any) => t.mint)) && grads.includes(GRAD_MINT), `${grads.length} card(s)`);
  await p.screenshot({ path: join(SHOTS, `explorer-${width}-graduated.png`) });
  await p.click("[data-ex-state='']");
  await p.click("[data-ex-sort=fees]");
  await settle(p);
  const fees = await p.evaluate(() => [...document.querySelectorAll<HTMLElement>(".ex-card")].slice(0, 5).map((c) => c.dataset.mint));
  const feeList = await (await fetch(`${MARKET}/market/tokens?sort=fees&limit=5`)).json();
  check(`${width} sort Most fees`, JSON.stringify(fees) === JSON.stringify(feeList.tokens.map((t: any) => t.mint)));
  l = await layout(p);
  check(`${width} no horizontal scroll after filters`, l.scroll <= 0, `overflow ${l.scroll}px`);

  // ---- search: typing filters, Enter on one match opens its token page
  for (const [label, q] of [["graduated mint", GRAD_MINT], ["agent id", GRAD_AGENT], ["ticker", "TGRAD"]] as const) {
    await p.goto(`${WEB}/explorer`);
    await p.waitForSelector(".ex-card");
    await p.fill("[data-ex-q]", q);
    await p.waitForTimeout(600);
    const n = await p.evaluate(() => document.querySelectorAll(".ex-card").length);
    await p.press("[data-ex-q]", "Enter");
    await p.waitForURL(`**/tokens/${GRAD_MINT}`, { timeout: 15_000 }).catch(() => {});
    check(`${width} search ${label} resolves to the token page`, p.url().endsWith(`/tokens/${GRAD_MINT}`) && n === 1, `${n} card(s), at ${p.url()}`);
  }
  await settle(p);
  await p.screenshot({ path: join(SHOTS, `search-${width}-token-page.png`) });

  // ---- docs
  for (const d of DOCS) {
    await p.goto(`${WEB}/docs${d ? `/${d}` : ""}`);
    await p.waitForSelector(".dc-prose");
    await settle(p);
    l = await layout(p);
    const info = await p.evaluate(() => ({ h1: document.querySelector(".dc-h1")?.textContent, tba: document.querySelectorAll(".dc-live.tba").length, live: document.querySelectorAll(".dc-live:not(.tba)").length,
      em: document.body.innerText.includes("—") }));
    check(`${width} /docs/${d || "overview"} layout`, l.scroll <= 0 && l.mono.length === 0 && !info.em, `overflow ${l.scroll}px, mono ${l.mono.join("; ")}, "${info.h1}", live ${info.live}, TBA ${info.tba}`);
    await p.screenshot({ path: join(SHOTS, `docs-${d || "overview"}-${width}.png`), fullPage: true });
  }
  check(`${width} no console errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
}
await browser.close();
const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} checks passed; screenshots in ${SHOTS}`);
writeFileSync(join(import.meta.dir, "UI-CHECK-LAST.json"), JSON.stringify({ at: new Date().toISOString(), web: WEB, pass, total: results.length, results }, null, 1) + "\n");
process.exit(pass === results.length ? 0 : 1);
