#!/usr/bin/env bun
// Headless check of the embed kit (docs/plans/FRONTEND-EMBED.md exit):
//  1. the demo page (/embed/demo.html on a running dashboard) at 1280 and 390 px: every element
//     renders live data, no horizontal page scroll, no console errors, no monospace text inside the
//     kit, the terminal answers (did you mean, ask, how, watch switches the paired screen);
//  2. the kit on a host page is covered by the demo page served at /embed/demo.html.
//
// playwright-core is not a repo dependency: pass its location.
//   bun packages/embed/scripts/check.ts --pw <dir with node_modules/playwright-core> --web http://127.0.0.1:9665
//     [--api https://<site>] [--shots <dir>]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (n: string, d?: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d);
const PW = arg("pw") ?? process.env.LINEAGE_PLAYWRIGHT;
if (!PW) throw new Error("--pw <dir with node_modules/playwright-core> is required (not a repo dependency)");
const { chromium } = await import(join(PW, "node_modules", "playwright-core", "index.mjs"));
const WEB = arg("web", "http://127.0.0.1:9665")!.replace(/\/+$/, "");
const API = arg("api", WEB)!.replace(/\/+$/, "");
const SHOTS = arg("shots", join(import.meta.dir, "../.shots"))!;
mkdirSync(SHOTS, { recursive: true });

const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ check: name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

/** In-page: every element inside the kit's shadow roots whose first font family is monospace. */
const MONO_PROBE = `(() => {
  const mono = /(^|,)\\s*["']?(monospace|ui-monospace|menlo|monaco|consolas|courier|sf mono|geist mono|jetbrains mono|fira code|ibm plex mono|source code pro|roboto mono)/i;
  const bad = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) walk(el.shadowRoot);
      if (!el.closest || !(el.textContent || "").trim() || el.children.length) continue;
      const f = getComputedStyle(el).fontFamily;
      if (mono.test(f.split(",")[0])) bad.push(el.tagName + "." + el.className + ": " + f);
    }
  };
  for (const host of document.querySelectorAll("lineage-screen, lineage-terminal, lineage-reel, lineage-token, lineage-how, lineage-stats, lineage-palette")) if (host.shadowRoot) walk(host.shadowRoot);
  return bad.slice(0, 5);
})()`;

const shadowCount = (tag: string, sel: string) => `(() => [...document.querySelectorAll(${JSON.stringify(tag)})].reduce((n, h) => n + (h.shadowRoot ? h.shadowRoot.querySelectorAll(${JSON.stringify(sel)}).length : 0), 0))()`;

/** Scrolls through the page so lazily drawn stills (IntersectionObserver) come into view. */
const SCROLL_ALL = `(async () => { for (let y = 0; y < document.documentElement.scrollHeight; y += 500) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 250)); } scrollTo(0, 0); })()`;

async function waitFor(page: any, expr: string, ms = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(expr).catch(() => false)) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

const browser = await chromium.launch();

// ------------------------------------------------------------------------------------------ demo
for (const width of [1280, 390]) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: "dark" });
  const errors: string[] = [];
  page.on("console", (m: any) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e: any) => errors.push(String(e)));
  await page.goto(`${WEB}/embed/demo.html${API !== WEB ? `?api=${encodeURIComponent(API)}` : ""}`, { waitUntil: "domcontentloaded" });
  const w = `demo ${width}`;
  check(`${w}: reel cards`, await waitFor(page, `${shadowCount("lineage-reel", ".card")} >= 4`), String(await page.evaluate(shadowCount("lineage-reel", ".card"))));
  await page.evaluate(SCROLL_ALL);
  check(`${w}: card screens drawn`, await waitFor(page, `${shadowCount("lineage-reel", ".thumb canvas")} >= 2`, 40_000));
  check(`${w}: dithered stills`, (await page.evaluate(shadowCount("lineage-reel", "canvas.dith"))) >= 1);
  check(`${w}: screen panel mounted`, await waitFor(page, `${shadowCount("lineage-screen", ".lp")} === 1`));
  check(`${w}: token block`, await waitFor(page, `${shadowCount("lineage-token", ".thead")} === 1 && ${shadowCount("lineage-token", ".lp")} === 1`, 40_000));
  check(`${w}: how, six steps with figures`, await waitFor(page, `${shadowCount("lineage-how", ".step .f")} === 6`));
  check(`${w}: stats`, await waitFor(page, `${shadowCount("lineage-stats", ".stat")} === 8`));
  const noUsd = await page.evaluate(`(() => { let t = ""; for (const h of document.querySelectorAll("lineage-reel, lineage-token, lineage-stats, lineage-how")) t += h.shadowRoot ? h.shadowRoot.textContent : ""; return !/\\$\\s?\\d|USD|\\u2014/.test(t); })()`);
  check(`${w}: no USD, no em dash`, noUsd);
  if (width === 1280) {
    // the terminal: typo, ask, how, watch
    const term = page.locator("lineage-terminal");
    const input = term.locator("input");
    await input.fill("tokns");
    await input.press("Enter");
    check("terminal: did you mean", await waitFor(page, `document.querySelector("lineage-terminal").shadowRoot.textContent.includes("did you mean")`));
    await input.fill("ask where do the fees go");
    await input.press("Enter");
    check("terminal: ask answers with a follow-up", await waitFor(page, `document.querySelector("lineage-terminal").shadowRoot.textContent.includes("Next: What is the compute vault?")`));
    await input.fill("how");
    await input.press("Enter");
    await page.waitForTimeout(400);
    for (let i = 0; i < 5; i++) {
      await input.press("Enter");
      await page.waitForTimeout(150);
    }
    check("terminal: how steps 1 to 6", await waitFor(page, `document.querySelector("lineage-terminal").shadowRoot.textContent.includes("6/6")`));
    const t = await page.evaluate(`Lineage.tokens({ sort: "newest" }).then((ts) => ts.find((x) => x.symbol)) `);
    await input.fill(`watch ${t.symbol}`);
    await input.press("Enter");
    check("terminal: watch switches the paired screen", await waitFor(page, `document.getElementById("screen1").getAttribute("agent") === ${JSON.stringify(t.agent)}`), t.symbol);
    await input.fill("sta");
    await input.press("Tab");
    check("terminal: tab completion", (await input.inputValue()) === "stats ");
    await page.evaluate(`Lineage.terminal.openAndRun("stats")`);
    check("terminal: Lineage.terminal.openAndRun", await waitFor(page, `document.querySelector("lineage-terminal").shadowRoot.textContent.includes("Verified generations")`));
    await page.keyboard.press("Meta+k");
    check("palette: Cmd K opens", await waitFor(page, `!document.querySelector("lineage-palette").shadowRoot.querySelector(".ov").hidden`));
    await page.screenshot({ path: join(SHOTS, "demo-palette-1280.png") });
    await page.keyboard.press("Escape");
    // hover a card: the still develops
    const card = page.locator("lineage-reel").first().locator(".card").first();
    await card.hover();
    await page.waitForTimeout(800);
    check("reel: hover develops the still", (await card.locator("canvas.dith").evaluate((c: HTMLElement) => getComputedStyle(c).opacity)) === "0");
    await page.locator("lineage-terminal").screenshot({ path: join(SHOTS, "demo-terminal-1280.png") });
  }
  await page.waitForTimeout(1500);
  const sw = await page.evaluate(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
  check(`${w}: no horizontal page scroll`, sw <= 0, `overflow ${sw}px`);
  const mono = await page.evaluate(MONO_PROBE);
  check(`${w}: no monospace in the kit`, mono.length === 0, mono.join("; "));
  // a 502/503/504 from the upstream site is retried by the client; it is counted and reported, not failed
  const upstream = errors.filter((e) => /status of 50[234]/.test(e));
  const real = errors.filter((e) => !upstream.includes(e));
  check(`${w}: no console errors`, real.length === 0, real.slice(0, 3).join(" | "));
  if (upstream.length) console.log(`NOTE ${w}: ${upstream.length} upstream gateway errors (5xx from the site, retried by the client)`);
  await page.screenshot({ path: join(SHOTS, `demo-${width}.png`), fullPage: true });
  await page.close();
}

// ------------------------------------------------------------------------------------------ explorer
{
  // <lineage-explorer> wraps the explorer+docs lane's module; its routes may not be deployed yet, so
  // its console errors are reported, and only the wrapper loading and mounting is checked
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on("console", (m: any) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`${WEB}/embed/demo.html?explorer=1${API !== WEB ? `&api=${encodeURIComponent(API)}` : ""}`, { waitUntil: "domcontentloaded" });
  check("explorer: lineage-explorer.js loaded on demand and mounted", await waitFor(page, `document.querySelectorAll("lineage-explorer [class^=ex-]").length > 3`));
  if (errors.length) console.log(`NOTE explorer: ${errors.length} console errors from the explorer module (${errors[0]?.slice(0, 120)})`);
  await page.locator("lineage-explorer").screenshot({ path: join(SHOTS, "demo-explorer-1280.png") }).catch(() => {});
  await page.close();
}

await browser.close();
const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} checks passed; screenshots in ${SHOTS}`);
writeFileSync(join(import.meta.dir, "../CHECK-LAST.json"), JSON.stringify({ at: new Date().toISOString(), web: WEB, api: API, pass, total: results.length, results }, null, 2));
process.exit(pass === results.length ? 0 : 1);
