import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildDocsChecked, docsLookup, PAGES } from "./build.ts";
import { coreApiDoc, coreRoutes, indexerRouteNames, routeKey } from "../../apps/docs/src/generate.ts";
import { API_NOTES, INDEXER_ROUTES } from "../../apps/docs/src/api-notes.ts";

const root = join(import.meta.dir, "../..");
const hashes = (s: string) => [...s.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => createHash("sha256").update(m[1]!).digest("base64"));
const built = buildDocsChecked({ base: "/docs" });

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

test("no broken internal link, anchor, repository link or generator", async () => {
  const { problems } = await built;
  expect(problems).toEqual([]);
});

test("the link check catches a broken link and a broken anchor", async () => {
  const { checkDocs } = await import("./build.ts");
  const files = new Map([
    ["index.html", { body: '<a href="/docs/missing">x</a><a href="/docs/b#nope">y</a><h2 id="ok">ok</h2><a href="#ok">z</a>', type: "text/html" }],
    ["b.html", { body: '<h2 id="there">t</h2>', type: "text/html" }],
  ]);
  const p = checkDocs(files, "/docs");
  expect(p).toHaveLength(2);
  expect(p[0]).toContain("/docs/missing");
  expect(p[1]).toContain("#nope");
});

test("live figures render as TBA with data-live for the page script to fill", async () => {
  const { files } = await built;
  const v = String(docsLookup(files, "/run-a-verifier")!.body);
  expect(v).toMatch(/<span class="dc-live tba" data-live="cfg:register_burn"[^>]*>TBA<\/span>/);
  const l = String(docsLookup(files, "/launch-an-agent")!.body);
  expect(l).toContain('data-live="cfg:prepay.min_usd"');
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

test("the search index has every page", async () => {
  const { files } = await built;
  const idx = JSON.parse(String(files.get("assets/search.json")!.body)) as { p: string; u: string }[];
  for (const p of PAGES) expect(idx.some((e) => e.p === p.title)).toBe(true);
});
