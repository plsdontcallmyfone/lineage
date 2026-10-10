#!/usr/bin/env bun
// Headless check of the trading pages (plan T) on a running dashboard: /trading and /trading/:agent at
// 1280 and 390 wide, light and dark. The trade rows shown must equal Core's records (count, first
// signature, rule), the limits must equal GET /v1/trading/config, no horizontal scroll, no page errors.
// Headless Chromium only (playwright-core is not a repo dependency: pass its location).
// Usage: bun scripts/trader/ui-check.ts --pw <dir> [--web https://157-245-71-188.sslip.io] [--shots <dir>]
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const arg = (n: string, d?: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d);
const PW = arg("pw") ?? process.env.LINEAGE_PLAYWRIGHT;
if (!PW) throw new Error("--pw <dir with node_modules/playwright-core> is required");
const { chromium } = await import(join(PW, "node_modules", "playwright-core", "index.mjs"));
const WEB = arg("web", "https://157-245-71-188.sslip.io")!.replace(/\/+$/, "");
const SHOTS = arg("shots");
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ check: name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
const api = async (p: string) => (await fetch(`${WEB}/api/${p}`)).json();
const feed = await api("trades?limit=100");
const cfg = await api("trading/config");
const agent = (feed.records as any[]).find((r) => r.kind === "trade")?.agent;
const exe = join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell");
const browser = await chromium.launch({ headless: true, ...(existsSync(exe) ? { executablePath: exe } : {}) });
try {
  for (const [w, h] of [[1280, 900], [390, 844]]) {
    for (const scheme of ["light", "dark"]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme });
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e: Error) => errors.push(e.message));
      page.on("console", (m: any) => m.type() === "error" && errors.push(m.text()));
      const tag = `${w} ${scheme}`;
      await page.goto(`${WEB}/trading`, { waitUntil: "networkidle" });
      await page.locator("h1:has-text('Trading')").waitFor({ timeout: 30_000 });
      const rows = await page.locator("section.panel:has(h2:has-text('Recent trades')) tbody tr").count();
      check(`${tag} /trading: recent records shown equal Core's`, rows === feed.records.length, `${rows} rows, Core ${feed.records.length}`);
      const text = await page.locator("main").innerText();
      check(`${tag} /trading: limits equal the config`, text.includes(`${cfg.max_trade_bps / 100}% of treasury`) && text.includes(`${cfg.cooldown_s / 60} min`) && text.includes(`${cfg.stop_loss_bps / 100}%`), "");
      const sx = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`${tag} /trading: no horizontal page scroll`, sx <= 0, `${sx}px`);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `trading-${w}-${scheme}.png`), fullPage: true });
      if (agent) {
        const d = await api(`agents/${agent}/trades?limit=200`);
        await page.goto(`${WEB}/trading/${agent}`, { waitUntil: "networkidle" });
        await page.locator("section.panel:has(h2:has-text('Trades'))").waitFor({ timeout: 30_000 });
        const n = await page.locator("section.panel:has(h2:has-text('Trades')) tbody tr").count();
        check(`${tag} /trading/${agent.slice(0, 6)}: records shown equal Core's`, n === d.records.length, `${n} vs ${d.records.length}`);
        const first = d.records.find((r: any) => r.kind === "trade");
        if (first) check(`${tag} /trading/${agent.slice(0, 6)}: newest trade's signature links to the explorer`, (await page.locator(`a[href*="${first.signature}"]`).count()) > 0);
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `trading-agent-${w}-${scheme}.png`), fullPage: true });
      }
      check(`${tag}: no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
const pass = results.filter((r) => r.ok).length;
console.log(`${pass}/${results.length} checks passed`);
writeFileSync(join(import.meta.dir, "UI-CHECK-LAST.json"), JSON.stringify({ at: new Date().toISOString(), web: WEB, pass, total: results.length, results }, null, 2));
process.exit(pass === results.length ? 0 : 1);
