import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildDocs, docsLookup, PAGES } from "./build.ts";

const root = join(import.meta.dir, "../..");
const hashes = (s: string) => [...s.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => createHash("sha256").update(m[1]!).digest("base64"));

test("every docs page is built, with the one inline script the page CSP allows", async () => {
  const files = await buildDocs({ base: "/docs" });
  const app = hashes(readFileSync(join(root, "apps/web/public/index.html"), "utf8"));
  expect(app).toHaveLength(1);
  for (const p of PAGES) {
    const f = docsLookup(files, p.slug === "overview" ? "" : `/${p.slug}`);
    expect(f).not.toBeNull();
    const html = String(f!.body);
    expect(hashes(html)).toEqual(app);
    expect(html).not.toContain(String.fromCharCode(0x2014)); // no em dashes
    expect(html).toContain(`src="/docs/assets/docs.js"`);
  }
  expect(files.has("assets/docs.js") && files.has("assets/app.css") && files.has("fonts/Geist-Variable.woff2")).toBe(true);
  expect(String(files.get("assets/app.css")!.body)).toContain('url("/docs/fonts/');
  expect(docsLookup(files, "/nope")).toBeNull();
});

test("live figures render as TBA with data-live for the page script to fill", async () => {
  const files = await buildDocs({ base: "/docs" });
  const v = String(docsLookup(files, "/verification")!.body);
  expect(v).toMatch(/<span class="dc-live tba" data-live="cfg:register_burn"[^>]*>TBA<\/span>/);
});
