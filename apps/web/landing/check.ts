#!/usr/bin/env bun
// Headless check of the landing page ("/") on a running dashboard server, at 1280 and 390 px, dark and
// light: the page CSP header is present and nothing violates it, no console errors, no horizontal page
// scroll, live figures filled from the network, the terminal, reels and screen render, no monospace
// outside the drawn tube, no em dash. Screenshots per width and theme.
//
// playwright-core is not a repo dependency: pass its location (chromium-headless-shell, never a
// visible browser).
//   bun apps/web/landing/check.ts --pw <dir with node_modules/playwright-core> --web http://127.0.0.1:9667 [--shots <dir>] [--gap <seconds between loads>]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (n: string, d?: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d);
const PW = arg("pw") ?? process.env.LINEAGE_PLAYWRIGHT;
if (!PW) throw new Error("--pw <dir with node_modules/playwright-core> is required (not a repo dependency)");
const { chromium } = await import(join(PW, "node_modules", "playwright-core", "index.mjs"));
const WEB = arg("web", "http://127.0.0.1:9661")!.replace(/\/+$/, "");
const SHOTS = arg("shots", join(import.meta.dir, ".shots"))!;
mkdirSync(SHOTS, { recursive: true });
const GAP = Number(arg("gap", "0"));

const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ check: name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

/** Text-bearing elements (light DOM and the kit's shadow roots) whose first font is monospace, outside the tube. */
const MONO_PROBE = `(() => {
  const mono = /^\\s*["']?(monospace|ui-monospace|menlo|monaco|consolas|courier|sf mono|geist ?mono|departure mono|jetbrains mono|fira code)/i;
  const bad = [];
  const walk = (root, inTube) => {
    for (const el of root.querySelectorAll("*")) {
      const tube = inTube || !!(el.closest && el.closest("lineage-device"));
      if (el.shadowRoot) walk(el.shadowRoot, tube);
      if (tube || el.children.length || !(el.textContent || "").trim()) continue;
      if (el.tagName === "SCRIPT" || el.tagName === "STYLE") continue;
      const f = getComputedStyle(el).fontFamily;
      if (mono.test(f)) bad.push(el.tagName + "." + el.className + ": " + f);
    }
  };
  walk(document, false);
  return bad.slice(0, 5);
})()`;

const SCROLL_ALL = `(async () => { document.documentElement.style.scrollBehavior = "auto"; for (let y = 0; y < document.documentElement.scrollHeight; y += 400) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 200)); } scrollTo(0, 0); })()`;

async function waitFor(page: any, expr: string, ms = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(expr).catch(() => false)) return true;
    await page.waitForTimeout(300);
  }
  return false;
}
const shadowCount = (tag: string, sel: string) => `(() => [...document.querySelectorAll(${JSON.stringify(tag)})].reduce((n, h) => n + (h.shadowRoot ? h.shadowRoot.querySelectorAll(${JSON.stringify(sel)}).length : 0), 0))()`;

const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1280, 390]) {
    for (const theme of ["dark", "light"] as const) {
      const w = `${width} ${theme}`;
      const ctx = await browser.newContext({ viewport: { width, height: width > 600 ? 860 : 844 }, colorScheme: theme, deviceScaleFactor: width > 600 ? 1 : 2 });
      await ctx.addInitScript(`try { localStorage.setItem("lineage-theme", ${JSON.stringify(theme)}); } catch (e) {}
        window.__csp = []; document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI));`);
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text()); });
      page.on("pageerror", (e: Error) => errors.push(e.message));
      const api = { api: 0, market: 0 };
      page.on("request", (r: any) => {
        const u = new URL(r.url());
        if (u.pathname.startsWith("/api/")) api.api++;
        else if (u.pathname.startsWith("/market/")) api.market++;
      });
      const res = await page.goto(`${WEB}/`, { waitUntil: "load" });
      const csp = (await res.headers())["content-security-policy"] ?? "";
      check(`${w}: page CSP header`, csp.includes("script-src 'self' 'sha256-") && !csp.includes("unsafe-eval"), csp.slice(0, 60));
      check(`${w}: theme applied`, (await page.evaluate(`document.documentElement.getAttribute("data-theme") || "dark"`)) === theme);
      check(`${w}: figures filled`, await waitFor(page, `[...document.querySelectorAll(".figs [data-stat]")].every((b) => b.textContent.trim().length > 0)`, 45_000),
        await page.evaluate(`[...document.querySelectorAll(".figs [data-stat]")].map((b) => b.dataset.stat + "=" + b.textContent.trim()).join(", ")`));
      check(`${w}: terminal rendered`, await waitFor(page, shadowCount("lineage-terminal", ".term")));
      await page.evaluate(SCROLL_ALL);
      check(`${w}: strip cards`, await waitFor(page, `(() => { const r = document.querySelector(".reel-strip"); return !!r && !!r.shadowRoot && r.shadowRoot.querySelectorAll("[part~=card]").length > 0; })()`));
      check(`${w}: timeline cards`, await waitFor(page, `(() => { const r = document.querySelector(".reel-time"); return !!r && !!r.shadowRoot && r.shadowRoot.querySelectorAll("[part~=card]").length > 0; })()`));
      check(`${w}: screen rendered`, await waitFor(page, `(() => { const s = document.getElementById("watch-screen"); return !!s && !!s.shadowRoot && s.shadowRoot.textContent.trim().length > 0; })()`));
      check(`${w}: step figures filled`, await waitFor(page, `[...document.querySelectorAll(".steps [data-stat]")].every((b) => b.textContent.trim().length > 0)`));
      await page.waitForTimeout(1500);
      const sw = await page.evaluate(`[document.documentElement.scrollWidth, innerWidth]`);
      check(`${w}: no horizontal page scroll`, sw[0] <= sw[1], `${sw[0]} <= ${sw[1]}`);
      const mono = await page.evaluate(MONO_PROBE);
      check(`${w}: no monospace outside the device screen`, mono.length === 0, mono.join(" | "));
      const text = await page.evaluate(`document.body.innerText`);
      check(`${w}: no em dash`, !text.includes(String.fromCharCode(0x2014)));
      check(`${w}: no scraped names`, !/garage|bryan/i.test(await page.content()));
      // the site's gate allows a burst of 120 per class per client (scripts/deploy/gate.ts LIMITS)
      check(`${w}: one load stays under the gate's burst`, api.api < 120 && api.market < 120, `/api ${api.api}, /market ${api.market}`);
      const csps = await page.evaluate(`window.__csp`);
      check(`${w}: no CSP violations`, csps.length === 0, csps.join(" | "));
      check(`${w}: no console errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
      await page.evaluate(`document.documentElement.style.scrollBehavior = "auto"; scrollTo(0, 0)`);
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(SHOTS, `landing-${width}-${theme}-fold.png`) });
      await page.screenshot({ path: join(SHOTS, `landing-${width}-${theme}.png`), fullPage: true });
      await page.locator(".rig").screenshot({ path: join(SHOTS, `landing-${width}-${theme}-device.png`) });
      if (width === 1280 && theme === "dark") {
        // the terminal answers inside the tube
        const input = page.locator("#term input").first();
        await input.fill("stats");
        await input.press("Enter");
        check(`${w}: terminal answers`, await waitFor(page, `/agent tokens|verified generations/i.test(document.getElementById("term").shadowRoot.textContent)`, 15_000));
      }
      await ctx.close();
      if (GAP) await new Promise((r) => setTimeout(r, GAP * 1000)); // let a remote gate's per-client budget refill between loads
    }
  }
} finally {
  await browser.close();
}
const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} passed; screenshots in ${SHOTS}`);
writeFileSync(join(import.meta.dir, "CHECK-LAST.json"), JSON.stringify({ at: new Date().toISOString(), web: WEB, pass, total: results.length, results }, null, 2) + "\n");
process.exit(pass === results.length ? 0 : 1);
