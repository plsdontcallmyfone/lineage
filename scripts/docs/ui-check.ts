#!/usr/bin/env bun
// Headless check of every page of the standalone docs site at 1280 and 390 px (headless Chromium only,
// never a person's browser):
//
//   bun scripts/docs/ui-check.ts [--port 9663] [--app https://157-245-71-188.sslip.io] [--url <docs origin>] [--shots <dir>]
//
// Without --url it builds the docs in memory and serves them on 127.0.0.1:<port> the way the real
// hosts do (scripts/docs/serve.ts); the pages read their live figures from --app cross-origin, as they
// do in production. With --url (for example https://docs-157-245-71-188.sslip.io) it checks the
// deployed site instead.
// Per page and width: HTTP 200, the title and the summary are there, no console or page error, no
// failed request, no horizontal scroll, every image loaded, no monospace text, no em dash, the step
// line and the Previous and Next links of a path page, at least one live figure filled on a page
// that has any, the section tab of the page marked, the page marked in the side menu, the last-updated
// date and the edit link, no layout shift after the first paint (CLS under 0.05), and the fonts of the
// main website in use (Suisse Intl for text, KMR Apparat for the title). At 1280 the side menu is in
// view and "On this page" marks a section; at 390 the side menu is a drawer that opens and closes.
// Then, per width: the search palette opens from its button and from Ctrl+K and finds a page, a copy
// button copies, tabs switch, and a link into a folded block opens it.
// Also per page: the canonical link and og:url name https://docs.units.gg. Per width: an unknown path
// answers 404 with the docs' own page, /<slug>.html redirects to /<slug>, robots.txt and sitemap.xml
// answer, the stylesheet and script are cached for a year, and the page policy is sent.
// Exit 1 on any failure. The port must be free (lsof -ti :<port>); 9662 is not ours.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { buildDocsChecked, DOCS_ORIGIN, PAGES, SECTIONS } from "./build.ts";
import { docsResponse } from "./serve.ts";

const argv = process.argv.slice(2);
const opt = (n: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
const PORT = Number(opt("port") ?? 9663);
const APP = opt("app")?.replace(/\/+$/, "");
const SHOTS = opt("shots") ?? null;
let base = opt("url")?.replace(/\/+$/, "") ?? null;
let server: ReturnType<typeof Bun.serve> | null = null;

if (!base) {
  if (PORT === 9662) throw new Error("port 9662 is the owner's review server");
  const { files, problems, app } = await buildDocsChecked({ app: APP });
  if (problems.length) {
    console.error(`build problems:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  server = Bun.serve({ port: PORT, hostname: "127.0.0.1", fetch: (req) => docsResponse(files, req, app) });
  base = `http://127.0.0.1:${PORT}`;
}

const EM = String.fromCharCode(0x2014);
const browser = await chromium.launch({ headless: true });
const fails: string[] = [];
let checks = 0;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
for (const width of [1280, 390]) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, deviceScaleFactor: 1, isMobile: width < 600, hasTouch: width < 600 });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    (window as any).__cls = 0;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as any[]) if (!e.hadRecentInput) (window as any).__cls += e.value;
    }).observe({ type: "layout-shift", buffered: true });
  });
  let errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
  page.on("requestfailed", (r) => errors.push(`request failed: ${r.url()} ${r.failure()?.errorText ?? ""}`));
  page.on("response", (r) => r.status() >= 400 && !/\/(v1|market)\//.test(r.url()) && errors.push(`HTTP ${r.status()} ${r.url()}`));
  for (const p of PAGES) {
    errors = [];
    const url = p.slug === "overview" ? `${base}/` : `${base}/${p.slug}`;
    const bad = (why: string) => fails.push(`${p.slug} @${width}: ${why}`);
    checks++;
    const res = await page.goto(url, { waitUntil: "load", timeout: 60_000 }).catch((e) => (bad(String(e).slice(0, 120)), null));
    if (!res) continue;
    if (res.status() !== 200) bad(`HTTP ${res.status()}`);
    await page.evaluate(async () => {
      // lazy images load when scrolled to: walk the page once, then wait for every image
      // (instant jumps: the page scrolls smoothly by default; an image in a folded block loads when it is opened)
      for (let y = 0; y < document.body.scrollHeight; y += 600) {
        window.scrollTo({ top: y, behavior: "instant" });
        await new Promise((r) => setTimeout(r, 25));
      }
      window.scrollTo({ top: 0, behavior: "instant" });
      const shown = [...document.images].filter((i) => i.getClientRects().length);
      await Promise.race([Promise.all(shown.map((i) => (i.complete ? null : new Promise((r) => ((i.onload = r), (i.onerror = r)))))), new Promise((r) => setTimeout(r, 20_000))]);
      await document.fonts.ready;
    });
    await page.waitForFunction(() => !document.querySelector("[data-live]") || !!document.querySelector("[data-live]:not(.tba)"), null, { timeout: 15_000 }).catch(() => undefined);
    const r = await page.evaluate((em) => {
      const mono = /mono|courier|menlo|consolas/i;
      const texts = [...document.querySelectorAll<HTMLElement>("body *")].filter((e) => e.children.length === 0 && (e.textContent ?? "").trim());
      return {
        h1: document.querySelector(".dc-h1")?.textContent?.trim() ?? "",
        canonical: document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.getAttribute("href") ?? "",
        ogUrl: document.querySelector('meta[property="og:url"]')?.getAttribute("content") ?? "",
        appLinks: [...document.querySelectorAll<HTMLAnchorElement>(".dc-links a")].map((a) => a.href),
        lead: document.querySelector(".dc-lead")?.textContent?.trim() ?? "",
        scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        brokenImages: [...document.images].filter((i) => i.getClientRects().length && (!i.complete || i.naturalWidth === 0)).map((i) => i.getAttribute("src")),
        mono: [...new Set(texts.filter((e) => mono.test(getComputedStyle(e).fontFamily.split(",")[0]!)).map((e) => `${e.tagName.toLowerCase()}.${e.className}`))].slice(0, 3),
        em: document.body.innerText.includes(em),
        live: document.querySelectorAll("[data-live]").length,
        filled: document.querySelectorAll("[data-live]:not(.tba)").length,
        step: document.querySelector(".dc-step")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
        prev: !!document.querySelector('.dc-pager a[rel="prev"]'),
        next: !!document.querySelector('.dc-pager a[rel="next"]'),
        search: !!document.getElementById("dc-q") && !!document.getElementById("dc-search-open"),
        tab: document.querySelector('.dc-tabl[aria-current="true"]')?.textContent ?? null,
        navCurrent: document.querySelectorAll('.dc-nav a[aria-current="page"]').length,
        updated: document.querySelector(".dc-meta time")?.textContent ?? "",
        edit: document.querySelector<HTMLAnchorElement>(".dc-meta a")?.href ?? "",
        cls: (window as any).__cls as number,
        fonts: [getComputedStyle(document.querySelector(".dc-prose")!).fontFamily.split(",")[0]!.replace(/"/g, ""), getComputedStyle(document.querySelector(".dc-h1")!).fontFamily.split(",")[0]!.replace(/"/g, "")],
        loaded: [document.fonts.check('16px "Suisse Intl"'), document.fonts.check('500 40px "KMR Apparat"')],
        sideShown: (() => {
          const r = document.getElementById("dc-side")!.getBoundingClientRect();
          return getComputedStyle(document.getElementById("dc-side")!).visibility !== "hidden" && r.right > 0 && r.left < innerWidth;
        })(),
        toc: document.querySelectorAll("#dc-toc a").length,
        tocShown: !!document.getElementById("dc-toc") && getComputedStyle(document.querySelector(".dc-toc")!).display !== "none",
        tocMarked: document.querySelectorAll("#dc-toc a[aria-current]").length,
        tocFold: !!document.querySelector(".dc-toc-m") && getComputedStyle(document.querySelector(".dc-toc-m")!).display !== "none",
        colons: /(^|\s):{3,}/m.test((document.querySelector(".dc-prose") as HTMLElement).innerText.replace(/\S*:{3,}\S+/g, "")),
        unexpanded: /\{\{[a-z]+:/.test(document.body.innerText),
      };
    }, EM);
    const sec = SECTIONS.find((s) => s.pages.some((x) => x.slug === p.slug))!;
    if (!r.h1) bad("no title");
    const canon = `${DOCS_ORIGIN}${p.slug === "overview" ? "/" : `/${p.slug}`}`;
    if (r.canonical !== canon || r.ogUrl !== canon) bad(`canonical is "${r.canonical}", og:url "${r.ogUrl}", not ${canon}`);
    if (r.appLinks.some((h) => new URL(h).origin === new URL(base!).origin)) bad(`a header link stays on the docs origin: ${r.appLinks.join(", ")}`);
    if (!r.lead) bad("no summary");
    if (r.scroll > 1) bad(`horizontal scroll of ${r.scroll} px`);
    if (r.brokenImages.length) bad(`images not loaded: ${r.brokenImages.join(", ")}`);
    if (r.mono.length) bad(`monospace text in ${r.mono.join(", ")}`);
    if (r.em) bad("an em dash");
    if (r.unexpanded) bad("an unexpanded {{tag}}");
    if (!r.search) bad("no search box");
    if (r.tab !== sec.tab) bad(`the marked section tab is "${r.tab}", not "${sec.tab}"`);
    if (r.navCurrent !== 1) bad(`${r.navCurrent} side menu links marked as the current page`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.updated)) bad(`last updated date is "${r.updated}"`);
    if (!r.edit.endsWith(`/edit/main/apps/docs/content/${p.file}`)) bad(`edit link is ${r.edit}`);
    if (r.cls > 0.05) bad(`layout shift ${r.cls.toFixed(3)}`);
    if (r.fonts[0] !== "Suisse Intl" || r.fonts[1] !== "KMR Apparat" || r.loaded.includes(false)) bad(`fonts are ${r.fonts.join(" / ")} (loaded: ${r.loaded.join(", ")})`);
    if (r.colons) bad("a component's colons are left in the text");
    if (width >= 1024 ? !r.sideShown : r.sideShown) bad(width >= 1024 ? "the side menu is not in view" : "the side menu is open before its button is pressed");
    if (r.toc && (width >= 1280 ? !r.tocShown || r.tocMarked !== 1 : !r.tocFold)) bad(width >= 1280 ? `"On this page": shown ${r.tocShown}, ${r.tocMarked} marked` : `"On this page" does not fold into the page`);
    if (r.live && !r.filled) bad(`none of ${r.live} live figures filled`);
    if (sec.kind === "path" && !r.step?.includes(`step ${sec.pages.findIndex((x) => x.slug === p.slug) + 1} of ${sec.pages.length}`)) bad(`step line is "${r.step}"`);
    if (PAGES.indexOf(p) > 0 && !r.prev) bad("no Previous link");
    if (PAGES.indexOf(p) < PAGES.length - 1 && !r.next) bad("no Next link");
    for (const e of errors) bad(e);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `${p.slug}-${width}.png`), fullPage: true });
  }
  // the components behave: search palette, drawer, copy, tabs, a link into a folded block
  const act = async (name: string, f: () => Promise<string | null>) => {
    checks++;
    const why = await Promise.race([f(), new Promise<string>((r) => setTimeout(() => r("no answer in 60 s"), 60_000))]).catch((e) => String(e).slice(0, 160));
    if (why) fails.push(`${name} @${width}: ${why}`);
  };
  await act("standalone site", async () => {
    const get = (path: string) => ctx.request.get(base + path, { maxRedirects: 0 });
    const missing = await get("/no-such-page");
    if (missing.status() !== 404 || !(await missing.text()).includes("Page not found")) return `an unknown path answers ${missing.status()} without the docs' 404 page`;
    const redir = await get("/verification.html");
    if (![301, 308].includes(redir.status()) || redir.headers().location !== "/verification") return `/verification.html answers ${redir.status()} to ${redir.headers().location}`;
    for (const f of ["/robots.txt", "/sitemap.xml", "/favicon.png"]) if ((await get(f)).status() !== 200) return `${f} does not answer 200`;
    if (!(await (await get("/sitemap.xml")).text()).includes(`<loc>${DOCS_ORIGIN}/verification</loc>`)) return "sitemap.xml does not list the pages under the canonical origin";
    const html = await (await get("/")).text();
    const assets = [/href="(\/assets\/docs\.[0-9a-f]+\.css)"/.exec(html)?.[1], /src="(\/assets\/docs\.[0-9a-f]+\.js)"/.exec(html)?.[1], /data-search="(\/assets\/search\.[0-9a-f]+\.json)"/.exec(html)?.[1]];
    for (const a of assets) {
      if (!a) return "the start page does not name its hashed stylesheet, script and search index";
      const r = await get(a);
      if (r.status() !== 200 || !/max-age=31536000/.test(r.headers()["cache-control"] ?? "")) return `${a}: ${r.status()}, cache-control "${r.headers()["cache-control"]}"`;
    }
    const csp = (await get("/")).headers()["content-security-policy"] ?? "";
    if (!csp.includes("script-src 'self'") || !csp.includes("connect-src 'self' https://")) return `page policy is "${csp}"`;
    return null;
  });
  await page.goto(`${base}/`, { waitUntil: "load" });
  await act("search", async () => {
    await page.click("#dc-search-open");
    await page.fill("#dc-q", "guard limit");
    const hit = await page.locator("#dc-res .dc-hit").first().textContent({ timeout: 10_000 }).catch(() => null);
    if (!hit || !/guard/i.test(hit)) return `"guard limit" found ${hit ? `"${hit.slice(0, 60)}"` : "nothing"}`;
    await page.fill("#dc-q", "/v1/guard-config");
    const route = await page.locator("#dc-res .dc-hit").first().textContent({ timeout: 10_000 }).catch(() => null);
    if (!route || !route.includes("/v1/guard-config")) return `"/v1/guard-config" found ${route ? `"${route.slice(0, 60)}"` : "nothing"}`;
    await page.keyboard.press("Escape");
    if (await page.locator("#dc-palette").evaluate((d) => (d as HTMLDialogElement).open)) return "Escape does not close the palette";
    await page.keyboard.press("Control+k");
    if (!(await page.locator("#dc-palette").evaluate((d) => (d as HTMLDialogElement).open))) return "Ctrl+K does not open the palette";
    await page.fill("#dc-q", "sealing");
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/sealing/, { timeout: 10_000 });
    return null;
  });
  if (width < 1024)
    await act("drawer", async () => {
      await page.goto(`${base}/`, { waitUntil: "load" });
      await page.click("#dc-menu");
      const link = page.locator('.dc-nav a[href$="/glossary"]');
      if (await link.isVisible()) return "another section's pages are unfolded before their group is opened";
      await page.locator(".dc-nav-s", { has: page.locator('a[href$="/glossary"]') }).locator("summary").first().click();
      await link.click();
      await page.waitForURL(/\/glossary/, { timeout: 10_000 });
      await page.click("#dc-menu");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(450);
      const open = await page.evaluate(() => getComputedStyle(document.getElementById("dc-side")!).visibility !== "hidden");
      return open ? "Escape does not close the page menu" : null;
    });
  await act("copy", async () => {
    await page.goto(`${base}/api-examples`, { waitUntil: "load" });
    // what the button hands to the clipboard (read through a stand-in: a headless phone context has no clipboard to read back)
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (t: string) => (((window as any).__copied = t), Promise.resolve()) } }));
    const b = page.locator(".dc-codeb [data-copy]").first();
    await b.click();
    const want = await page.locator(".dc-codeb pre").first().textContent();
    const got = await page.evaluate(() => (window as any).__copied as string | undefined);
    if (got !== want) return `the copy button copied "${String(got).slice(0, 50)}"`;
    return (await b.textContent()) === "Copied" ? null : "the button does not say Copied";
  });
  await act("tabs", async () => {
    await page.goto(`${base}/networks`, { waitUntil: "load" });
    const tabs = page.locator('[data-tabs] [role="tab"]');
    if ((await tabs.count()) < 2) return "no tabs on the networks page";
    await tabs.nth(1).click();
    const shown = await page.locator('[data-tabs] [role="tabpanel"]:not([hidden])').first().getAttribute("aria-labelledby");
    return shown === (await tabs.nth(1).getAttribute("id")) ? null : "the second tab's panel is not shown";
  });
  await act("folded link", async () => {
    await page.goto(`${base}/core-api#get-v1-stats`, { waitUntil: "load" });
    const open = await page.locator("#get-v1-stats").evaluate((d) => (d as HTMLDetailsElement).open);
    return open ? null : "the API block named in the link stays folded";
  });
  await ctx.close();
}
await browser.close();
server?.stop(true);
console.log(`${checks - new Set(fails.map((f) => f.split(":")[0])).size}/${checks} checks pass (${PAGES.length} pages x 1280 and 390, plus the standalone checks, search, drawer, copy, tabs and folded links) on ${base}`);
if (fails.length) {
  console.error(fails.join("\n"));
  process.exit(1);
}
