import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildDocsChecked, docsLookup, PAGES, PATHS, SECTIONS } from "./build.ts";
import { captured, coreApiDoc, coreRoutes, indexerRouteNames, routeKey } from "../../apps/docs/src/generate.ts";
import { API_NOTES, INDEXER_ROUTES } from "../../apps/docs/src/api-notes.ts";
import { renderMarkdown, sentenceCount } from "../../apps/docs/src/markdown.ts";
import { trim } from "./capture.ts";

const root = join(import.meta.dir, "../..");
const hashes = (s: string) => [...s.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => createHash("sha256").update(m[1]!).digest("base64"));
const built = buildDocsChecked({ base: "/docs" });
const page = async (slug: string) => String(docsLookup((await built).files, slug === "overview" ? "" : `/${slug}`)!.body);

test("every docs page is built, with the one inline script the page CSP allows", async () => {
  const { files } = await built;
  const app = hashes(readFileSync(join(root, "apps/web/public/index.html"), "utf8"));
  expect(app).toHaveLength(1);
  for (const p of PAGES) {
    const f = docsLookup(files, p.slug === "overview" ? "" : `/${p.slug}`);
    expect(f).not.toBeNull();
    const html = String(f!.body);
    expect(hashes(html)).toEqual(app);
    expect(html).not.toContain(String.fromCharCode(0x2014)); // no em dashes
    expect(html).toContain(`src="/docs/assets/docs.js"`);
    expect(html).toContain('id="dc-q"'); // the search box
  }
  expect(files.has("assets/docs.js") && files.has("assets/app.css") && files.has("assets/search.json")).toBe(true);
  expect(String(files.get("assets/app.css")!.body)).toContain('url("/docs/fonts/');
  expect(docsLookup(files, "/nope")).toBeNull();
});

test("no broken internal link, anchor, image, repository link, generator, example or summary", async () => {
  const { problems } = await built;
  expect(problems).toEqual([]);
});

test("the link check catches a broken link, a broken anchor and a missing image", async () => {
  const { checkDocs } = await import("./build.ts");
  const files = new Map([
    ["index.html", { body: '<a href="/docs/missing">x</a><a href="/docs/b#nope">y</a><h2 id="ok">ok</h2><a href="#ok">z</a><img src="/docs/shots/none.jpg">', type: "text/html" }],
    ["b.html", { body: '<h2 id="there">t</h2>', type: "text/html" }],
  ]);
  const p = checkDocs(files, "/docs");
  expect(p).toHaveLength(3);
  expect(p[0]).toContain("/docs/missing");
  expect(p[1]).toContain("#nope");
  expect(p[2]).toContain("/docs/shots/none.jpg");
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
    expect(start).toContain(`<a class="dc-pathcard" href="/docs/${s.pages[0]!.slug}">`);
    for (const [i, p] of s.pages.entries()) {
      const html = await page(p.slug);
      expect(html).toContain(`<span>step ${i + 1} of ${s.pages.length}</span>`);
      if (i > 0) expect(html).toContain(`href="/docs/${s.pages[i - 1]!.slug}" rel="prev"`);
      if (i + 1 < s.pages.length) expect(html).toContain(`class="next" href="/docs/${s.pages[i + 1]!.slug}" rel="next"`);
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
  expect((await page("indexer-api")).match(/class="dc-block-h">Request/g)!.length).toBe(c.api!.examples.length - core.length);
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
    for (const m of html.matchAll(/<img src="\/docs\/shots\/([^"]+)" alt="[^"]*" width="(\d+)" height="(\d+)"/g)) {
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
  const idx = JSON.parse(String(files.get("assets/search.json")!.body)) as { p: string; u: string }[];
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
  const marks = [...models.matchAll(/<img class="dc-plogo" src="\/docs\/providers\/([a-z]+\.svg)"/g)].map((m) => m[1]!);
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
