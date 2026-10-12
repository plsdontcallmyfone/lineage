#!/usr/bin/env bun
// Headless check of every docs page at 1280 and 390 px (headless Chromium only, never a person's browser):
//
//   bun scripts/docs/ui-check.ts [--port 9663] [--site https://157-245-71-188.sslip.io] [--url <docs base URL>] [--shots <dir>]
//
// Without --url it builds the docs in memory and serves them on 127.0.0.1:<port> at /docs, passing
// /api and /market reads to --site so the live figures fill as they do on the site. With --url (for
// example https://157-245-71-188.sslip.io/docs) it checks the deployed pages instead.
// Per page and width: HTTP 200, the title and the summary are there, no console or page error, no
// failed request, no horizontal scroll, every image loaded, no monospace text, no em dash, the step
// line and the Previous and Next links of a path page, and at least one live figure filled on a page
// that has any. Exit 1 on any failure. The port must be free (lsof -ti :<port>); 9662 is not ours.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { buildDocsChecked, docsLookup, PAGES, SECTIONS } from "./build.ts";

const argv = process.argv.slice(2);
const opt = (n: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
const PORT = Number(opt("port") ?? 9663);
const SITE = (opt("site") ?? "https://157-245-71-188.sslip.io").replace(/\/+$/, "");
const SHOTS = opt("shots") ?? null;
let base = opt("url")?.replace(/\/+$/, "") ?? null;
let server: ReturnType<typeof Bun.serve> | null = null;

if (!base) {
  if (PORT === 9662) throw new Error("port 9662 is the owner's review server");
  const { files, problems } = await buildDocsChecked({ base: "/docs" });
  if (problems.length) {
    console.error(`build problems:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  server = Bun.serve({
    port: PORT,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname.startsWith("/api/") || u.pathname.startsWith("/market/")) {
        for (let i = 0; ; i++) {
          const r = await fetch(SITE + u.pathname + u.search, { headers: { accept: "application/json" } });
          if ([429, 502, 503].includes(r.status) && i < 4) {
            await new Promise((res) => setTimeout(res, 1000 * Math.min(15, Number(r.headers.get("retry-after") ?? 3))));
            continue;
          }
          return new Response(await r.arrayBuffer(), { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "application/json" } });
        }
      }
      if (u.pathname === "/docs" || u.pathname.startsWith("/docs/")) {
        const f = docsLookup(files, u.pathname.slice("/docs".length));
        if (f) return new Response(f.body, { headers: { "content-type": f.type } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${PORT}/docs`;
}

const EM = String.fromCharCode(0x2014);
const browser = await chromium.launch({ headless: true });
const fails: string[] = [];
let checks = 0;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
for (const width of [1280, 390]) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, deviceScaleFactor: 1, isMobile: width < 600, hasTouch: width < 600 });
  const page = await ctx.newPage();
  let errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
  page.on("requestfailed", (r) => errors.push(`request failed: ${r.url()} ${r.failure()?.errorText ?? ""}`));
  page.on("response", (r) => r.status() >= 400 && !/\/(api|market)\//.test(r.url()) && errors.push(`HTTP ${r.status()} ${r.url()}`));
  for (const p of PAGES) {
    errors = [];
    const url = p.slug === "overview" ? base : `${base}/${p.slug}`;
    const bad = (why: string) => fails.push(`${p.slug} @${width}: ${why}`);
    checks++;
    const res = await page.goto(url, { waitUntil: "load", timeout: 60_000 }).catch((e) => (bad(String(e).slice(0, 120)), null));
    if (!res) continue;
    if (res.status() !== 200) bad(`HTTP ${res.status()}`);
    await page.evaluate(async () => {
      // lazy images load when scrolled to: walk the page once, then wait for every image
      for (let y = 0; y < document.body.scrollHeight; y += 600) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 25));
      }
      window.scrollTo(0, 0);
      await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => ((i.onload = r), (i.onerror = r))))));
      await document.fonts.ready;
    });
    await page.waitForFunction(() => !document.querySelector("[data-live]") || !!document.querySelector("[data-live]:not(.tba)"), null, { timeout: 15_000 }).catch(() => undefined);
    const r = await page.evaluate((em) => {
      const mono = /mono|courier|menlo|consolas/i;
      const texts = [...document.querySelectorAll<HTMLElement>("body *")].filter((e) => e.children.length === 0 && (e.textContent ?? "").trim());
      return {
        h1: document.querySelector(".dc-h1")?.textContent?.trim() ?? "",
        lead: document.querySelector(".dc-lead")?.textContent?.trim() ?? "",
        scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        brokenImages: [...document.images].filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.getAttribute("src")),
        mono: [...new Set(texts.filter((e) => mono.test(getComputedStyle(e).fontFamily.split(",")[0]!)).map((e) => `${e.tagName.toLowerCase()}.${e.className}`))].slice(0, 3),
        em: document.body.innerText.includes(em),
        live: document.querySelectorAll("[data-live]").length,
        filled: document.querySelectorAll("[data-live]:not(.tba)").length,
        step: document.querySelector(".dc-step")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
        prev: !!document.querySelector('.dc-pager a[rel="prev"]'),
        next: !!document.querySelector('.dc-pager a[rel="next"]'),
        search: !!document.getElementById("dc-q"),
        unexpanded: /\{\{[a-z]+:/.test(document.body.innerText),
      };
    }, EM);
    if (!r.h1) bad("no title");
    if (!r.lead) bad("no summary");
    if (r.scroll > 1) bad(`horizontal scroll of ${r.scroll} px`);
    if (r.brokenImages.length) bad(`images not loaded: ${r.brokenImages.join(", ")}`);
    if (r.mono.length) bad(`monospace text in ${r.mono.join(", ")}`);
    if (r.em) bad("an em dash");
    if (r.unexpanded) bad("an unexpanded {{tag}}");
    if (!r.search) bad("no search box");
    if (r.live && !r.filled) bad(`none of ${r.live} live figures filled`);
    const sec = SECTIONS.find((s) => s.pages.some((x) => x.slug === p.slug))!;
    if (sec.kind === "path" && !r.step?.includes(`step ${sec.pages.findIndex((x) => x.slug === p.slug) + 1} of ${sec.pages.length}`)) bad(`step line is "${r.step}"`);
    if (PAGES.indexOf(p) > 0 && !r.prev) bad("no Previous link");
    if (PAGES.indexOf(p) < PAGES.length - 1 && !r.next) bad("no Next link");
    for (const e of errors) bad(e);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `${p.slug}-${width}.png`), fullPage: true });
  }
  // search works: a term from the tutorial finds its page
  await page.goto(base, { waitUntil: "load" });
  await page.fill("#dc-q", "guard limit");
  const hit = await page.locator("#dc-res .dc-hit").first().textContent({ timeout: 10_000 }).catch(() => null);
  checks++;
  if (!hit || !/guard/i.test(hit)) fails.push(`search @${width}: "guard limit" found ${hit ? `"${hit.slice(0, 60)}"` : "nothing"}`);
  await ctx.close();
}
await browser.close();
server?.stop(true);
console.log(`${checks - new Set(fails.map((f) => f.split(":")[0])).size}/${checks} checks pass (${PAGES.length} pages x 1280 and 390, plus search) on ${base}`);
if (fails.length) {
  console.error(fails.join("\n"));
  process.exit(1);
}
