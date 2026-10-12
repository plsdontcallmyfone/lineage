import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanPage } from "./support/checks.ts";
import { expect, test } from "./support/fixtures.ts";

// The docs are a web site and a repository of their own (units-docs; canonical origin https://docs.units.gg). The app
// only redirects to it. UI_DOCS_URL names the docs origin under test; the default is the one the app
// is configured with (config/sites.json docs_url, the temporary docs host until the DNS record of
// docs.units.gg exists). A local build is served from a checkout of the docs repository by
// `bun scripts/serve.ts --port 9663`.
const SITES = JSON.parse(readFileSync(join(__dirname, "../../config/sites.json"), "utf8")) as { docs_url: string; docs_canonical: string };
const DOCS = (process.env.UI_DOCS_URL ?? SITES.docs_url).replace(/\/+$/, "");
const CANONICAL = SITES.docs_canonical.replace(/\/+$/, "");
// where the app under test sends /docs (its own UNITS_DOCS_URL); the same origin unless told otherwise
const APP_DOCS = (process.env.UI_APP_DOCS_URL ?? SITES.docs_url).replace(/\/+$/, "");

// Removed pages go to what replaced them (apps/web/server.ts REDIRECTS, mirrored in the client router).
const REDIRECTS: [string, string][] = [
  ["/network", "/"],
  ["/live", "/"],
  ["/tokens", "/"],
  ["/explorer", "/"],
  ["/wallet", "/profile"],
  ["/spawn", "/launch"],
  ["/trading", "/"],
];

test.describe("removed routes", () => {
  for (const [from, to] of REDIRECTS) {
    test(`${from} redirects to ${to}`, async ({ page }) => {
      await page.goto(from);
      await expect(page).toHaveURL((u) => u.pathname === to);
    });
  }
});

test.describe("the app's /docs", () => {
  test("redirects to the docs site, same page; the app serves no docs page itself", async ({ request }) => {
    const cases: [string, string][] = [
      ["/docs", "/"],
      ["/docs/", "/"],
      ["/docs/launch-quickstart", "/launch-quickstart"],
      ["/docs/verification.html", "/verification"],
      ["/docs/core-api?x=1", "/core-api?x=1"],
      ["/manual", "/"],
    ];
    for (const [from, to] of cases) {
      const r = await request.get(from, { maxRedirects: 0 });
      // a 302 for now (301 with UNITS_DOCS_REDIRECT=301; a static host answers 307 or 308)
      expect({ from, redirect: [301, 302, 307, 308].includes(r.status()), location: r.headers().location }).toEqual({ from, redirect: true, location: `${APP_DOCS}${to}` });
    }
    // nothing of the docs is left under the app's own origin
    for (const p of ["/docs/assets/docs.js", "/docs/assets/search.json", "/docs/shots/explorer.jpg"]) expect((await request.get(p, { maxRedirects: 0 })).status(), p).not.toBe(200);
  });

  test("links from the app to the docs name the docs origin", async ({ page }) => {
    await page.goto("/eco");
    const docs = page.locator(".eco-links a", { hasText: "Docs" });
    await expect(docs).toHaveCount(1);
    await expect(docs).toHaveAttribute("href", `${APP_DOCS}/`);
    await page.goto("/generations");
    await expect(page.locator("a", { hasText: "How verification works" }).first()).toHaveAttribute("href", `${APP_DOCS}/verification`);
    for (const a of await page.locator('a[href^="/docs"]').all()) expect(await a.getAttribute("href"), "an in-app link still points at /docs").toBeNull();
  });
});

test.describe("Docs site", () => {
  test("a static site of its own at the root; the nav lists every page the build made, each answers and names its canonical URL", async ({ page, request }) => {
    await page.goto(`${DOCS}/`);
    await page.locator(".dc-h1").waitFor();
    await expect(page.locator("#app")).toHaveCount(0);
    // the build's own page list: its search index has entries for every page (u is the page, with or without an anchor)
    const search = await page.locator("body").getAttribute("data-search");
    expect(search, "the page names its hashed search index").toMatch(/^\/assets\/search\.[0-9a-f]+\.json$/);
    const index = (await (await request.get(`${DOCS}${search}`)).json()) as { u: string }[];
    const pages = [...new Set(index.map((x) => x.u.split("#")[0]!))].sort();
    expect(pages.length, "docs pages").toBeGreaterThanOrEqual(30);
    const nav = (await page.locator(".dc-nav a").evaluateAll((els) => els.map((e) => new URL((e as HTMLAnchorElement).href).pathname))).sort();
    expect(new Set(nav).size, "no page twice in the nav").toBe(nav.length);
    expect(nav).toEqual(pages);
    expect(nav.some((p) => p.startsWith("/docs")), "no page lives under /docs").toBe(false);
    for (const p of nav) {
      const r = await request.get(`${DOCS}${p}`);
      expect({ page: p, status: r.status() }).toEqual({ page: p, status: 200 });
      const html = await r.text();
      expect(html.includes('class="dc-h1"'), `${p} is a docs page`).toBe(true);
      expect(html, `${p} names its canonical URL`).toContain(`<link rel="canonical" href="${CANONICAL}${p}">`);
      expect(html, `${p} has its Open Graph URL`).toContain(`<meta property="og:url" content="${CANONICAL}${p}">`);
    }
    await cleanPage(page);
  });

  test("its own index, assets, sitemap, robots, 404 page and page policy", async ({ request }) => {
    const start = await request.get(`${DOCS}/`);
    const html = await start.text();
    const csp = start.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp, "no inline script and nothing from the app's policy").not.toMatch(/sha256-|privy|unsafe-eval/);
    expect(html).not.toMatch(/<script(?![^>]* src=)/);
    for (const a of [/href="(\/assets\/docs\.[0-9a-f]+\.css)"/, /src="(\/assets\/docs\.[0-9a-f]+\.js)"/]) {
      const path = a.exec(html)?.[1];
      expect(path, `the start page names ${a}`).toBeTruthy();
      const r = await request.get(`${DOCS}${path}`);
      expect({ path, status: r.status(), cache: r.headers()["cache-control"] }).toEqual({ path, status: 200, cache: expect.stringContaining("max-age=31536000") });
    }
    expect(await (await request.get(`${DOCS}/robots.txt`)).text()).toContain(`Sitemap: ${CANONICAL}/sitemap.xml`);
    expect(await (await request.get(`${DOCS}/sitemap.xml`)).text()).toContain(`<loc>${CANONICAL}/launch-quickstart</loc>`);
    const missing = await request.get(`${DOCS}/no-such-page`);
    expect(missing.status()).toBe(404);
    expect(await missing.text()).toContain("Page not found");
    const old = await request.get(`${DOCS}/verification.html`, { maxRedirects: 0 });
    expect({ redirect: [301, 308].includes(old.status()), location: old.headers().location }).toEqual({ redirect: true, location: "/verification" });
  });

  test("header links go to the app; live figures are read from the app's API across origins", async ({ page }) => {
    await page.goto(`${DOCS}/verification`);
    await page.locator(".dc-h1").waitFor();
    const app = await page.locator("body").getAttribute("data-app");
    expect(app, "the build names the app origin").toMatch(/^https:\/\/[^/]+$/);
    // the docs header (its own repository, units-docs) carries the Launch button; an Explorer link only
    // in some of its layouts. Whatever links to the app names the app origin of the build
    await expect(page.locator("a.dc-cta").first()).toHaveAttribute("href", `${app}/launch`);
    const explorer = page.locator(".dc-links a", { hasText: "Explorer" });
    if (await explorer.count()) await expect(explorer.first()).toHaveAttribute("href", `${app}/`);
    await expect.poll(async () => (await page.locator("[data-live]").allInnerTexts()).some((x) => x.trim() && x !== "TBA"), { timeout: 30_000 }).toBe(true);
    await cleanPage(page);
  });

  test("the indexed token count equals the indexer's", async ({ page, request }) => {
    await page.goto(`${DOCS}/`);
    const span = page.locator('[data-live="market:tokens"]').first();
    await expect(span).not.toHaveClass(/tba/, { timeout: 30_000 });
    // the docs read the app their build names (body data-app, the docs repository's site.json app_url),
    // which need not be the app under test: the count is compared with that app's indexer
    const app = await page.locator("body").getAttribute("data-app");
    const r = await request.get(`${app}/market/tokens?limit=200`, { headers: { accept: "application/json" } });
    expect(r.ok(), `GET ${app}/market/tokens: HTTP ${r.status()}`).toBeTruthy();
    const l = await r.json();
    await expect(span).toHaveText(String(l.total ?? l.count ?? l.tokens.length));
  });
});
