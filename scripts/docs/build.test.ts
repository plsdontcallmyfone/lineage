import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildDocsChecked, docsCsp, DOCS_ORIGIN, docsLookup, PAGES, PATHS, SECTIONS, vercelConfig, vercelProjectJson } from "./build.ts";
import { docsResponse } from "./serve.ts";
import sites from "../../config/sites.json" with { type: "json" };
import { captured, coreApiDoc, coreRoutes, indexerRouteNames, routeKey } from "../../apps/docs/src/generate.ts";
import { API_NOTES, INDEXER_ROUTES } from "../../apps/docs/src/api-notes.ts";
import { renderMarkdown, sentenceCount } from "../../apps/docs/src/markdown.ts";
import { trim } from "./capture.ts";

const root = join(import.meta.dir, "../..");
const APP = "https://app.example";
const built = buildDocsChecked({ app: APP });
const page = async (slug: string) => String(docsLookup((await built).files, slug === "overview" ? "" : `/${slug}`)!.body);

test("every docs page is built at the root of its own site, with no inline script and hashed assets", async () => {
  const { files, assets } = await built;
  const sha = (f: string) => createHash("sha256").update(files.get(f)!.body).digest("hex").slice(0, 12);
  for (const [k, a] of Object.entries(assets)) {
    expect(a).toMatch(k === "search" ? /^\/assets\/search\.[0-9a-f]{12}\.json$/ : new RegExp(`^/assets/docs\\.[0-9a-f]{12}\\.${k}$`));
    expect(a).toContain(sha(a.slice(1))); // the name carries the hash of the content
  }
  for (const p of PAGES) {
    const f = docsLookup(files, p.slug === "overview" ? "" : `/${p.slug}`);
    expect(f).not.toBeNull();
    const html = String(f!.body);
    expect(html).not.toMatch(/<script(?![^>]* src=)/); // no inline script: the page policy allows scripts of the site only
    expect(html).not.toContain(String.fromCharCode(0x2014)); // no em dashes
    expect(html).toContain(`<script type="module" src="${assets.js}"></script>`);
    expect(html).toContain(`<link rel="stylesheet" href="${assets.css}">`);
    expect(html).toContain(`data-search="${assets.search}"`);
    expect(html).toContain('id="dc-q"'); // the search box
    expect(html).not.toMatch(/(?:href|src)="\/docs(?:\/|")/); // nothing lives under /docs any more
  }
  // the main website's fonts, self-hosted and preloaded; nothing is fetched from another origin
  const css = String(files.get(assets.css.slice(1))!.body);
  for (const f of [...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]!)) {
    expect(f.startsWith("/fonts/")).toBe(true);
    expect(files.has(f.slice(1))).toBe(true);
    expect(String(files.get("index.html")!.body)).toContain(`<link rel="preload" href="${f}" as="font"`);
  }
  expect(css).toContain('"Suisse Intl"');
  expect(css).toContain('"KMR Apparat"');
  expect(css).not.toMatch(/https?:\/\/(?!lineagee\.vercel\.app)/);
  expect(docsLookup(files, "/nope")).toBeNull();
});

test("canonical origin: every page names docs.units.gg in its canonical link and Open Graph tags; sitemap and robots too", async () => {
  const { files } = await built;
  expect(DOCS_ORIGIN).toBe("https://docs.units.gg");
  for (const p of PAGES) {
    const html = await page(p.slug);
    const url = `https://docs.units.gg${p.slug === "overview" ? "/" : `/${p.slug}`}`;
    expect(html).toContain(`<link rel="canonical" href="${url}">`);
    expect(html).toContain(`<meta property="og:url" content="${url}">`);
    expect(html).toMatch(/<meta property="og:title" content="[^"]+">/);
    expect(html).toMatch(/<meta property="og:description" content="[^"]+">/);
    expect(html).toContain('<meta property="og:image" content="https://docs.units.gg/logo.png">');
  }
  const map = String(files.get("sitemap.xml")!.body);
  expect([...map.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])).toEqual(PAGES.map((p) => `https://docs.units.gg${p.slug === "overview" ? "/" : `/${p.slug}`}`));
  expect(String(files.get("robots.txt")!.body)).toContain("Sitemap: https://docs.units.gg/sitemap.xml");
  const missing = String(files.get("404.html")!.body);
  expect(missing).toContain('<meta name="robots" content="noindex">');
  expect(missing).not.toContain('rel="canonical"');
  expect(missing).toContain("Page not found");
});

test("the app is another origin: header links, app: links and the live figures' source use the configured app origin", async () => {
  const start = await page("overview");
  expect(start).toContain(`<body data-app="${APP}"`);
  expect(start).toContain(`<a href="${APP}/">Explorer</a>`);
  expect(start).toContain(`<a class="dc-cta" href="${APP}/launch">Launch</a>`);
  expect(await page("launch-quickstart")).toContain(`href="${APP}/launch"`);
  expect(await page("site-pages")).toContain(`href="${APP}/generations"`);
  // no page of the app is linked as if it lived on the docs origin
  for (const p of PAGES) expect(await page(p.slug)).not.toMatch(/href="\/(launch|generations|profile|projects)(["#/?])/);
  // the default is the one configured value
  expect(docsCsp()).toContain(`connect-src 'self' ${process.env.UNITS_APP_URL ?? sites.app_url};`);
  expect(docsCsp(APP)).toContain("script-src 'self';");
  expect(docsCsp(APP)).not.toContain("unsafe-eval");
  await expect(buildDocsChecked({ app: "https://app.example/path" })).rejects.toThrow();
});

test("a static host's answers: clean URLs, the 404 page, cache rules, the page policy", async () => {
  const { files, assets, app } = await built;
  const get = (path: string, method = "GET") => docsResponse(files, new Request(`http://docs.test${path}`, { method }), app);
  expect(get("/").status).toBe(200);
  expect(await get("/verification").text()).toContain('class="dc-h1"');
  expect([get("/verification.html").status, get("/verification.html").headers.get("location")]).toEqual([308, "/verification"]);
  expect([get("/verification/").status, get("/verification/").headers.get("location")]).toEqual([308, "/verification"]);
  expect(get("/index.html").headers.get("location")).toBe("/");
  const missing = get("/docs/verification");
  expect(missing.status).toBe(404);
  expect(await missing.text()).toContain("Page not found");
  expect(get("/", "POST").status).toBe(405);
  expect(get(assets.js).headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(get(assets.css).headers.get("cache-control")).toContain("immutable");
  expect(get("/fonts/SuisseIntl-Regular-WebS.woff2").headers.get("cache-control")).toBe("public, max-age=2592000");
  expect(get("/").headers.get("cache-control")).toBe("no-cache");
  expect(get("/").headers.get("content-security-policy")).toBe(docsCsp(APP));
  expect(get("/robots.txt").headers.get("content-type")).toContain("text/plain");
  expect(get("/sitemap.xml").headers.get("content-type")).toContain("xml");
});

test("Vercel: apps/docs/vercel.json is the build's own file for the configured app origin", () => {
  expect(readFileSync(join(root, "apps/docs/vercel.json"), "utf8")).toBe(vercelProjectJson(sites.app_url));
  const v = vercelConfig(APP, { project: true }) as any;
  expect(v.outputDirectory).toBe("dist");
  expect(v.buildCommand).toContain("bun scripts/docs/build.ts");
  expect(v.cleanUrls).toBe(true);
  expect(v.headers[0].headers.find((h: any) => h.key === "content-security-policy").value).toBe(docsCsp(APP));
  expect(v.headers.find((h: any) => h.source === "/assets/(.*)").headers[0].value).toContain("immutable");
});

test("no broken internal link, anchor, image, repository link, generator, example or summary", async () => {
  const { problems } = await built;
  expect(problems).toEqual([]);
});

test("the link check catches a broken link, a broken anchor and a missing image", async () => {
  const { checkDocs } = await import("./build.ts");
  const files = new Map([
    ["index.html", { body: '<a href="/missing">x</a><a href="/b#nope">y</a><h2 id="ok">ok</h2><a href="#ok">z</a><img src="/shots/none.jpg">', type: "text/html" }],
    ["b.html", { body: '<h2 id="there">t</h2>', type: "text/html" }],
  ]);
  const p = checkDocs(files, "");
  expect(p).toHaveLength(3);
  expect(p[0]).toContain("/missing");
  expect(p[1]).toContain("#nope");
  expect(p[2]).toContain("/shots/none.jpg");
});

test("every page opens with a summary of at most two sentences, shown as the lead", async () => {
  for (const p of PAGES) {
    const md = readFileSync(join(root, "apps/docs/content", p.file), "utf8");
    const r = renderMarkdown(md, () => null);
    expect(r.summary, `${p.slug} has no summary`).not.toBe("");
    const n = sentenceCount(r.summaryText);
    expect(n >= 1 && n <= 2, `${p.slug}: ${n} sentences in the summary`).toBe(true);
    expect(await page(p.slug)).toContain('<p class="dc-lead">');
  }
  expect(sentenceCount("It costs 0.05 SOL in `a.json`. Two.")).toBe(2);
});

test("reader paths: five guided sequences, each page numbered, with previous and next links", async () => {
  expect(PATHS.map((s) => s.goal)).toEqual(["Launch an agent in 5 minutes", "Understand verification", "Hold or trade a coin", "Run a verifier", "Build on the API"]);
  const start = await page("overview");
  for (const s of PATHS) {
    expect(s.pages.length).toBeGreaterThanOrEqual(2);
    expect(start).toContain(`<a class="dc-card is-link dc-pathcard" href="/${s.pages[0]!.slug}">`);
    for (const [i, p] of s.pages.entries()) {
      const html = await page(p.slug);
      expect(html).toContain(`<span>step ${i + 1} of ${s.pages.length}</span>`);
      if (i > 0) expect(html).toContain(`href="/${s.pages[i - 1]!.slug}" rel="prev"`);
      if (i + 1 < s.pages.length) expect(html).toContain(`class="next" href="/${s.pages[i + 1]!.slug}" rel="next"`);
    }
  }
  // every page is in exactly one section
  expect(new Set(PAGES.map((p) => p.slug)).size).toBe(PAGES.length);
  expect(SECTIONS.flatMap((s) => s.pages).length).toBe(PAGES.length);
});

test("live figures render as TBA with data-live for the page script to fill", async () => {
  const v = await page("verifier-economics");
  expect(v).toMatch(/<span class="dc-live tba" data-live="cfg:register_burn"[^>]*>TBA<\/span>/);
  expect(await page("launch-an-agent")).toContain('data-live="cfg:prepay.min_usd"');
  expect(await page("guard-limits")).toContain('data-live="guard:default_max_regression"');
  expect(await page("overview")).toContain('data-live="stats:generations"');
});

test("the Core API reference covers every route in http.ts, and every note names a real route", () => {
  const doc = coreApiDoc(root);
  expect(doc.undescribed).toEqual([]);
  const keys = new Set(coreRoutes(root).map((r) => routeKey(r.method, r.path)));
  expect(Object.keys(API_NOTES).filter((k) => !keys.has(k))).toEqual([]);
  for (const r of coreRoutes(root)) expect(doc.markdown).toContain(`\`${r.method} ${r.path}\``);
});

test("the indexer API page lists exactly the routes the indexer serves", () => {
  const code = indexerRouteNames(root);
  const documented = INDEXER_ROUTES.map((r) => r.path);
  for (const c of code) expect(documented).toContain(c);
  for (const d of documented) if (d !== "/market/tokens" && d !== "/market/tokens/:mint") expect(code).toContain(d);
});

test("captured API examples: fifteen Core routes that exist in http.ts, each a real 200 answer", async () => {
  const c = captured(root);
  expect(c.api).not.toBeNull();
  const core = c.api!.examples.filter((e) => e.group === "core");
  expect(core).toHaveLength(15);
  const keys = new Set(coreRoutes(root).flatMap((r) => [routeKey(r.method, r.path), routeKey(r.method, r.path.replace("/v1/lineages", "/v1/units"))]));
  for (const e of c.api!.examples) {
    expect(e.status).toBe(200);
    expect(e.response).toBeTruthy();
    if (e.group === "core") expect(keys.has(routeKey(e.method, e.path.replace(/\/[0-9a-f]{64}|\/[1-9A-HJ-NP-Za-km-z]{32,44}/g, "/:_"))), `${e.method} ${e.path} is not a route of http.ts`).toBe(true);
  }
  const html = await page("api-examples");
  for (const e of core) expect(html).toContain(`curl ${c.api!.site}${e.request.replace(/&/g, "&amp;")}`);
  expect((await page("indexer-api")).match(/class="dc-codeb-l">Request/g)!.length).toBe(c.api!.examples.length - core.length);
  // the reference shows the captured example inside its route
  const ref = await page("core-api");
  expect(ref.match(/class="dc-codeb-l">Request/g)!.length).toBe(core.length);
  expect(ref).toMatch(/<details class="dc-api" id="get-v1-stats"><summary><span class="dc-m is-get">GET<\/span><span class="dc-api-p">\/v1\/stats<\/span>/);
});

test("the trim rule marks every cut", () => {
  const t = trim({ a: [1, 2, 3], s: "x".repeat(200), o: { p: 1, q: 2, r: 3 } }, { arr: 2, keys: 2 }) as any;
  expect(t.a).toEqual([1, 2, "... 1 more"]);
  expect(t["..."]).toBe("1 more fields");
  const n = trim({ list: [[1, 2, 3]] }, { arr: 2, keys: 5 }) as any;
  expect(n.list[0]).toEqual([1, 2, "... 1 more"]);
  expect(String((trim("y".repeat(200), { arr: 1, keys: 1 }) as string)).endsWith("(200 characters)")).toBe(true);
});

test("the verify tutorial shows the captured commands, their exact output and the generation's facts", async () => {
  const c = captured(root).verify!;
  expect(c).not.toBeNull();
  const html = await page("verify-yourself");
  for (const id of ["verify-generation", "verify-candidate", "verify-all"]) {
    const o = c.outputs[id]!;
    expect(o.exit).toBe(0);
    expect(html).toContain(o.cmd.replace(/&/g, "&amp;"));
    expect(html).toContain(o.out.split("\n")[0]!.replace(/&/g, "&amp;"));
  }
  expect(html).toContain(c.facts.gen_id!);
  expect(html).toContain(c.facts.target_base!);
  expect(html).not.toContain("{{");
  expect(c.metrics.some((m) => m.target)).toBe(true);
});

test("screenshots: every one a page uses exists in the manifest and on disk, with its capture date", async () => {
  const { files } = await built;
  const shots = JSON.parse(readFileSync(join(root, "apps/docs/captured/shots.json"), "utf8")).shots as Record<string, { file: string; width: number; height: number; captured_at: string }>;
  let used = 0;
  for (const p of PAGES) {
    const html = await page(p.slug);
    for (const m of html.matchAll(/<img src="\/shots\/([^"]+)" alt="[^"]*" width="(\d+)" height="(\d+)"/g)) {
      used++;
      const s = Object.values(shots).find((x) => x.file === m[1]);
      expect(s, `${p.slug}: ${m[1]} is not in the manifest`).toBeTruthy();
      expect([Number(m[2]), Number(m[3])]).toEqual([s!.width, s!.height]);
      expect(existsSync(join(root, "apps/docs/public/shots", m[1]!))).toBe(true);
      expect(files.has(`shots/${m[1]}`)).toBe(true);
    }
    expect(html).not.toContain("Screenshot not captured in this build");
  }
  expect(used).toBeGreaterThanOrEqual(12);
  expect(await page("launch-quickstart")).toMatch(/Captured from the devnet site on \d{4}-\d{2}-\d{2}\./);
});

test("the search index has every page", async () => {
  const { files } = await built;
  const idx = JSON.parse(String(files.get((await built).assets.search.slice(1))!.body)) as { p: string; u: string }[];
  for (const p of PAGES) expect(idx.some((e) => e.p === p.title)).toBe(true);
});

test("figures are HTML, CSS or SVG: the start page has no image, and the only logos are the provider marks", async () => {
  const start = await page("overview");
  expect(start).toContain('class="dc-fig"');
  expect(start).not.toMatch(/<img\b/);
  const { FIGURES } = await import("../../apps/docs/src/figures.ts");
  for (const f of Object.values(FIGURES)) {
    expect(f).not.toContain(String.fromCharCode(0x2014));
    expect(f).not.toMatch(/<img\b/);
  }
  const { files } = await built;
  const models = await page("models");
  const marks = [...models.matchAll(/<img class="dc-plogo" src="\/providers\/([a-z]+\.svg)"/g)].map((m) => m[1]!);
  expect(new Set(marks).size).toBeGreaterThanOrEqual(9);
  for (const m of marks) expect(files.has(`providers/${m}`)).toBe(true);
});

test("the Core API reference shows the /v1/units spelling of every /v1/lineages route", () => {
  const doc = coreApiDoc(root);
  for (const r of coreRoutes(root).filter((x) => x.path.startsWith("/v1/lineages")))
    expect(doc.markdown).toContain(`\`${r.method} /v1/units${r.path.slice("/v1/lineages".length)}\``);
});

test("what is not live is not described as live", async () => {
  const status = await page("status");
  expect(status).toContain('id="in-preparation"');
  expect(status).toMatch(/mainnet test[\s\S]{0,200}being prepared/i);
  for (const p of PAGES) {
    const html = (await page(p.slug)).replace(/<[^>]+>/g, " ");
    expect(html, p.slug).not.toMatch(/\(coming\)|Coming:|being built now/);
  }
});

test("components: callouts, cards, steps, tabs, accordions, API blocks and code blocks render from the documented syntax", () => {
  const md = [
    "# T", "", "> One sentence.", "",
    ":::warning Careful", "Body with `code`.", ":::", "",
    "::::cards 3", ":::card [A](/docs/a) {tag=\"2 steps\"}", "Text of a.", ":::", ":::card B", "No link.", ":::", "::::", "",
    ":::::steps", "::::step First thing", "Do it.", "", ":::tip", "Nested.", ":::", "::::", "::::step Second", "Then this.", "::::", ":::::", "",
    "::::tabs", ":::tab Devnet", "d", ":::", ":::tab Mainnet", "m", ":::", "::::", "",
    ":::accordion Why is it folded? {open}", "Because.", ":::", "",
    ":::api `POST /v1/agents/:id/soul` {access=\"agent-signed\"}", "Sets it.", ":::", "",
    "```ts title=\"a.ts\"", "const a = 1;", "```", "",
    "```Request", "curl x", "```", "",
    "## Section", "### Sub",
  ].join("\n");
  const missing: string[] = [];
  const r = renderMarkdown(md, () => null, { missing });
  expect(missing).toEqual([]);
  expect(r.html).toContain('<aside class="dc-callout is-warning" role="note" aria-label="Warning">');
  expect(r.html).toContain('<p class="dc-callout-t">Careful</p>');
  expect(r.html).toContain('<div class="dc-cards" data-cols="3"><a class="dc-card is-link" href="/docs/a"><span class="dc-card-tag">2 steps</span>');
  expect(r.html).toContain('<div class="dc-card"><b class="dc-card-t">B</b>');
  expect(r.html).toContain('<ol class="dc-stepper"><li class="dc-stp"><h3 id="first-thing">First thing');
  expect(r.html).toMatch(/<li class="dc-stp"><h3 id="first-thing">[\s\S]*is-tip[\s\S]*<\/li><li class="dc-stp"><h3 id="second">/);
  expect(r.html).toMatch(/role="tab" id="tab" aria-controls="tab-p" aria-selected="true">Devnet<[\s\S]*id="tab-2-p" aria-labelledby="tab-2" hidden>/);
  expect(r.html).toContain('<details class="dc-acc" id="why-is-it-folded" open>');
  expect(r.html).toContain('<details class="dc-api" id="post-v1-agents-id-soul"><summary><span class="dc-m is-post">POST</span><span class="dc-api-p">/v1/agents/<i class="dc-api-v">:id</i>/soul</span><span class="dc-api-a">agent-signed</span>');
  expect(r.html).toContain('<span class="dc-codeb-l">TypeScript</span><span class="dc-codeb-f">a.ts</span>');
  expect(r.html).toContain('<span class="dc-codeb-l">Request</span>');
  expect(r.html.match(/data-copy/g)!.length).toBe(2);
  expect(r.html).toContain('<h2 id="section">Section<a class="dc-anchor" href="#section"');
  expect(r.toc).toEqual([
    { id: "first-thing", text: "First thing", level: 3 },
    { id: "second", text: "Second", level: 3 },
    { id: "section", text: "Section", level: 2 },
    { id: "sub", text: "Sub", level: 3 },
  ]);
  // an unknown component and a card group holding something else are reported, never dropped silently
  const bad: string[] = [];
  renderMarkdown("# T\n\n> S.\n\n:::nope\nx\n:::\n\n::::cards\nstray\n::::\n", () => null, { missing: bad });
  expect(bad).toHaveLength(2);
});

test("the shell: section tabs, a side menu with every page once, on this page, edit link, last updated, the search palette", async () => {
  const { files } = await built;
  expect(SECTIONS.map((s) => s.tab)).toEqual(["Start", "Launch", "Verification", "Hold or trade", "Verifiers", "API", "Reference"]);
  for (const s of SECTIONS)
    for (const p of s.pages) {
      const html = await page(p.slug);
      expect(html.match(/class="dc-tabl"[^>]*aria-current="true">([^<]+)</)![1]).toBe(s.tab);
      const links = [...html.match(/<nav class="dc-nav"[\s\S]*?<\/nav>/)![0].matchAll(/<a href="([^"]+)"( aria-current="page")?>/g)];
      expect(links).toHaveLength(PAGES.length);
      expect(links.filter((l) => l[2]).map((l) => l[1])).toEqual([p.slug === "overview" ? "/" : `/${p.slug}`]);
      expect(html).toContain(`href="https://github.com/plsdontcallmyfone/lineage/edit/main/apps/docs/content/${p.file}"`);
      expect(html, `${p.slug}: last updated`).toMatch(/Last updated <time datetime="\d{4}-\d{2}-\d{2}">/);
      expect(html).toContain('<dialog class="dc-palette" id="dc-palette"');
      expect(html).toContain('id="main"');
    }
  expect(await page("verification")).toMatch(/<nav class="dc-toc-n" id="dc-toc"[\s\S]*<a href="#recipes" data-lv="2">Recipes<\/a>/);
  // the search index reaches folded questions and API routes
  const idx = JSON.parse(String(files.get((await built).assets.search.slice(1))!.body)) as { h: string; u: string }[];
  expect(idx.some((e) => e.u === "/core-api#get-v1-stats" && e.h.includes("/v1/stats"))).toBe(true);
  expect(idx.some((e) => e.u.startsWith("/faq#") && e.h === "Is this on mainnet?")).toBe(true);
});

test("components are used where they help: steps, callouts, tabs, cards on the landing pages, folded questions", async () => {
  expect((await page("launch-quickstart")).match(/<li class="dc-stp">/g)!.length).toBe(6);
  expect((await page("run-a-verifier")).match(/<li class="dc-stp">/g)!.length).toBe(5);
  expect(await page("status")).toMatch(/is-warning[\s\S]{0,400}Not live yet/);
  expect(await page("networks")).toMatch(/role="tab"[^>]*>Devnet<[\s\S]*role="tab"[^>]*>Mainnet</);
  expect(await page("api-examples")).toMatch(/role="tab"[^>]*>TypeScript<[\s\S]*role="tab"[^>]*>curl</);
  expect((await page("faq")).match(/<details class="dc-acc"/g)!.length).toBeGreaterThanOrEqual(20);
  for (const s of PATHS) if (s.id !== "verifier") expect((await page(s.pages[0]!.slug)).match(/<a class="dc-card is-link" /g)!.length).toBeGreaterThanOrEqual(s.pages.length);
});
