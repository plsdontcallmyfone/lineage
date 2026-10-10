#!/usr/bin/env bun
// Headless check of the embed kit (docs/plans/FRONTEND-EMBED.md exit):
//  1. the demo page (/embed/demo.html on a running dashboard) at 1280 and 390 px: every element
//     renders live data, no horizontal page scroll, no console errors, no monospace text inside the
//     kit, the terminal answers (did you mean, ask, how, watch switches the paired screen);
//     token figures are only price, market cap, 24h volume, 24h change and what the agent is building
//     (APP-CONSOLIDATION.md amendment 2026-10-10 (2)), equal to the indexer's, and no fee figure shows;
//  2. the kit on a host page is covered by the demo page served at /embed/demo.html.
//
// playwright-core is not a repo dependency: pass its location.
//   bun packages/embed/scripts/check.ts --pw <dir with node_modules/playwright-core> --web http://127.0.0.1:9665
//     [--api https://<site>] [--shots <dir>]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fmtAmount, fmtChange, fmtPrice } from "../../../apps/web/src/market.ts";

const arg = (n: string, d?: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d);
const PW = arg("pw") ?? process.env.LINEAGE_PLAYWRIGHT;
if (!PW) throw new Error("--pw <dir with node_modules/playwright-core> is required (not a repo dependency)");
const { chromium } = await import(join(PW, "node_modules", "playwright-core", "index.mjs"));
const WEB = arg("web", "http://127.0.0.1:9665")!.replace(/\/+$/, "");
const API = arg("api", WEB)!.replace(/\/+$/, "");
const SHOTS = arg("shots", join(import.meta.dir, "../.shots"))!;
mkdirSync(SHOTS, { recursive: true });

const results: { check: string; ok: boolean; detail: string }[] = [];
/** GET JSON; a transient 502/503/504 from the site's gateway is retried a few times */
const j = async (u: string): Promise<any> => {
  for (let i = 0; ; i++) {
    const r = await fetch(u);
    if (r.ok) return r.json();
    if (i >= 3 || ![502, 503, 504].includes(r.status)) throw new Error(`${u}: HTTP ${r.status}`);
    await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
  }
};
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

/** The bd- parameter labels and texts inside one element's shadow root, per block. */
const paramsIn = (host: string) => `(() => [...document.querySelectorAll(${JSON.stringify(host)})].flatMap((h) => h.shadowRoot ? [...h.shadowRoot.querySelectorAll(".bd-params")].map((p) => ({ mint: p.closest("[data-mint]")?.dataset.mint ?? h.getAttribute("mint"), cells: [...p.children].map((d) => [d.querySelector("span").textContent.trim(), d.querySelector("b").textContent.trim()]) })) : []))()`;
const PARAM_LABELS = ["Price", "Market cap", "24h volume", "24h change"];
/** Any fee wording in the kit's visible text (the terminal's fixed answers excepted: they explain the mechanism, no figures). */
const FEE_PROBE = `(() => { let t = ""; for (const h of document.querySelectorAll("lineage-reel, lineage-token, lineage-stats, lineage-how, lineage-leaderboard")) t += h.shadowRoot ? h.shadowRoot.textContent : ""; const m = t.match(/[^.]{0,40}\\b(fees?|fee split|to compute|compute vault|treasury|cranks?)\\b[^.]{0,40}/i); return m ? m[0] : null; })()`;

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
  const statKeys = await page.evaluate(`[...document.querySelectorAll("lineage-stats")].flatMap((h) => [...h.shadowRoot.querySelectorAll(".stat")].map((s) => s.dataset.k))`);
  check(`${w}: stats keys have no fee figure`, statKeys.length === 8 && !statKeys.some((k: string) => /fee/.test(k)), statKeys.join(","));
  // token parameters: the reel cards and the token block, each the four figures in order plus the building line
  {
    const rows = (await j(`${API}/market/tokens?sort=newest`)).tokens as any[];
    const want = (t: any) => [fmtPrice(t.price), fmtAmount(t.market_cap), fmtAmount(t.volume_24h), fmtChange(t.change_24h)];
    for (const host of ["lineage-reel", "lineage-token"]) {
      const blocks = (await page.evaluate(paramsIn(host))) as { mint: string; cells: [string, string][] }[];
      const bad = blocks.filter((b) => JSON.stringify(b.cells.map((c) => c[0])) !== JSON.stringify(PARAM_LABELS));
      check(`${w}: ${host} shows only price, market cap, 24h volume, 24h change`, blocks.length > 0 && bad.length === 0, `${blocks.length} blocks${bad.length ? `, bad ${JSON.stringify(bad[0]!.cells)}` : ""}`);
      let off: string[] = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        const fresh = attempt ? ((await j(`${API}/market/tokens?sort=newest`)).tokens as any[]) : rows;
        const now = attempt ? ((await page.evaluate(paramsIn(host))) as typeof blocks) : blocks;
        off = [];
        for (const b of now) {
          // a mint left out of the listing (hidden) is compared with its own detail row
          const t = fresh.find((x) => x.mint === b.mint) ?? (await j(`${API}/market/tokens/${b.mint}`).catch(() => null));
          if (!t) {
            off.push(`${b.mint}: not in the indexer`);
            continue;
          }
          const got = b.cells.map((c) => c[1].replace(/\s*tLINE$/, ""));
          if (JSON.stringify(got) !== JSON.stringify(want(t))) off.push(`${b.mint.slice(0, 6)} page ${got.join("|")} indexer ${want(t).join("|")}`);
        }
        if (!off.length) break;
        await page.waitForTimeout(20_000);
      }
      check(`${w}: ${host} figures equal the indexer's`, off.length === 0, off.slice(0, 2).join("; "));
      const bd = await page.evaluate(shadowCount(host, ".bd-building"));
      check(`${w}: ${host} says what the agent is building`, bd >= blocks.length && bd > 0, `${bd} building lines`);
    }
    const fee = await page.evaluate(FEE_PROBE);
    check(`${w}: no fee figures, splits or compute vault in the kit`, fee === null, fee ?? "");
    // <lineage-stats mint=> the same five for one token
    const mint = rows[0]?.mint;
    await page.evaluate(`(() => { const e = document.createElement("lineage-stats"); e.id = "tokstats"; e.setAttribute("mint", ${JSON.stringify(mint)}); document.body.appendChild(e); })()`);
    const ok = await waitFor(page, `${shadowCount("#tokstats", ".bd-params > div")} === 4 && ${shadowCount("#tokstats", ".bd-building")} === 1`);
    const cells = ((await page.evaluate(paramsIn("#tokstats"))) as { cells: [string, string][] }[])[0]?.cells ?? [];
    check(`${w}: <lineage-stats mint> shows the five token parameters`, ok && JSON.stringify(cells.map((c) => c[0])) === JSON.stringify(PARAM_LABELS), cells.map((c) => c.join(" ")).join(", "));
    await page.evaluate(`document.getElementById("tokstats").remove()`);
  }
  const noUsd = await page.evaluate(`(() => { let t = ""; for (const h of document.querySelectorAll("lineage-reel, lineage-token, lineage-stats, lineage-how")) t += h.shadowRoot ? h.shadowRoot.textContent : ""; return !/\\$\\s?\\d|USD|\\u2014/.test(t); })()`);
  check(`${w}: no USD, no em dash`, noUsd);
  if (width === 1280) {
    // the terminal: typo, ask, how, watch
    const term = page.locator("lineage-terminal");
    const input = term.locator("input");
    await input.fill("tokns");
    await input.press("Enter");
    check("terminal: did you mean", await waitFor(page, `document.querySelector("lineage-terminal").shadowRoot.textContent.includes("did you mean")`));
    await input.fill("ask how is a change verified");
    await input.press("Enter");
    check("terminal: ask answers with a follow-up", await waitFor(page, `document.querySelector("lineage-terminal").shadowRoot.textContent.includes("Next: What stops a verifier from lying?")`));
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
    check("terminal: stats has no fee row", !/fees? routed|to compute/i.test(await page.evaluate(`document.querySelector("lineage-terminal").shadowRoot.querySelector(".out").textContent`)));
    await page.evaluate(`Lineage.terminal.openAndRun("agent ${t.symbol}")`);
    check("terminal: agent shows price, market cap, 24h volume, 24h change, building", await waitFor(page, `(() => { const o = document.querySelector("lineage-terminal").shadowRoot.querySelector(".out").lastElementChild?.parentElement.textContent ?? ""; return ["Price", "Market cap", "24h volume", "24h change", "Building"].every((k) => o.includes(k)); })()`), t.symbol);
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
