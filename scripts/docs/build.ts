#!/usr/bin/env bun
// Static build of the docs site (apps/docs): plain-language pages from apps/docs/content/*.md into
// static HTML with the dashboard's fonts, colours and header. Deployable on its own (any static host,
// a Vercel project or a docs subdomain) and served by the dashboard server at /docs, outside the app
// shell. Live figures ({{cfg:...}}, {{market:...}}) render as TBA and are filled in the browser from
// /api/config and /market/tokens on the same origin (apps/docs/src/client.ts).
//
//   bun scripts/docs/build.ts [--base /docs] [--out apps/docs/dist]
//
// Layout of the output (paths under --base):
//   index.html             the Overview page
//   <slug>.html            every other page (served at <base>/<slug>)
//   assets/app.css         the dashboard's stylesheet (font URLs rewritten under the base)
//   assets/docs.css        the docs styles
//   assets/docs.js         theme toggle and live figures
//   fonts/*                the self-hosted fonts (SIL OFL 1.1, licenses in fonts/OFL.txt)
// The only inline script is the theme script of apps/web/public/index.html, byte for byte, so the
// site's page CSP (which allows it by hash) holds on these pages too.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { renderMarkdown } from "../../apps/docs/src/markdown.ts";

const ROOT = join(import.meta.dir, "../..");
const DOCS = join(ROOT, "apps/docs");
const WEB = join(ROOT, "apps/web");

export const PAGES: { slug: string; title: string; file: string }[] = [
  { slug: "overview", title: "Overview", file: "overview.md" },
  { slug: "how-it-works", title: "How it works", file: "how-it-works.md" },
  { slug: "launch-an-agent", title: "Launch an agent", file: "launch-an-agent.md" },
  { slug: "verification", title: "Verification", file: "verification.md" },
  { slug: "fees-and-compute", title: "Fees and compute", file: "fees-and-compute.md" },
  { slug: "graduation", title: "Graduation", file: "graduation.md" },
  { slug: "souls-and-identity", title: "Souls and identity", file: "souls-and-identity.md" },
  { slug: "api-and-embed-kit", title: "API and embed kit", file: "api-and-embed-kit.md" },
  { slug: "faq", title: "FAQ", file: "faq.md" },
];

export interface DocsFile {
  body: string | Uint8Array;
  type: string;
}

const esc = (v: unknown) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const LOGO = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 15.5L10 10l5.5-5.5" stroke="var(--accent)" stroke-width="1.6" fill="none"/><circle cx="4.5" cy="15.5" r="2.4" fill="var(--accent)"/><circle cx="10" cy="10" r="2.4" fill="var(--accent)"/><circle cx="15.5" cy="4.5" r="2.4" fill="var(--panel)" stroke="var(--accent)" stroke-width="1.6"/></svg>`;
const MOON = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 9.8A5.8 5.8 0 016.2 2.5a5.8 5.8 0 107.3 7.3z"/></svg>`;

/** The theme script of the app's index.html (one inline script; its hash is in the page CSP). */
export function themeScript(): string {
  const m = [...readFileSync(join(WEB, "public/index.html"), "utf8").matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (m.length !== 1) throw new Error("apps/web/public/index.html must hold exactly one inline script");
  return m[0]![1]!;
}

/** Every file of the docs site, keyed by its path under the base ("index.html", "verification.html", "assets/docs.js", ...). */
export async function buildDocs(o: { base?: string; app?: string } = {}): Promise<Map<string, DocsFile>> {
  const base = (o.base ?? "/docs").replace(/\/+$/, "");
  const app = (o.app ?? "").replace(/\/+$/, ""); // where the app lives ("" = same origin)
  const out = new Map<string, DocsFile>();
  const href = (slug: string) => (slug === "overview" ? base : `${base}/${slug}`);
  const theme = themeScript();
  const docs = PAGES.map((p) => ({ ...p, md: readFileSync(join(DOCS, "content", p.file), "utf8") }));
  for (const [i, d] of docs.entries()) {
    const r = renderMarkdown(d.md, () => null);
    const prev = docs[i - 1];
    const next = docs[i + 1];
    const title = d.slug === "overview" ? "Lineage Docs" : `${d.title} | Lineage Docs`;
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(`${r.title || d.title}: how Lineage works, written from the specification.`)}">
<link rel="icon" href="${base}/favicon.svg" type="image/svg+xml">
<meta name="theme-color" content="#141414">
<link rel="preload" href="${base}/fonts/Geist-Variable.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="${base}/fonts/InstrumentSerif-Regular.woff2" as="font" type="font/woff2" crossorigin>
<script>${theme}</script>
<link rel="stylesheet" href="${base}/assets/app.css">
<link rel="stylesheet" href="${base}/assets/docs.css">
</head>
<body>
<header class="top"><div class="top-in">
  <a class="brand" href="${app}/">${LOGO}<span>Lineage</span><span class="ph">docs</span></a>
  <nav class="nav" aria-label="Main">
    <a href="${app}/">Explorer</a>
    <a href="${app}/launch">Launch</a>
    <a href="${app}/profile">Profile</a>
    <a href="${base}" aria-current="page">Docs</a>
  </nav>
  <div class="top-right"><button class="iconbtn" id="theme" type="button" aria-label="Toggle colour theme">${MOON}</button></div>
</div></header>
<main class="dc-wrap" id="main"><div class="dc">
  <nav class="dc-nav" aria-label="Docs pages"><div class="dc-nav-h">Docs</div>${docs.map((x) => `<a href="${href(x.slug)}"${x.slug === d.slug ? ` aria-current="page"` : ""}>${esc(x.title)}</a>`).join("")}</nav>
  <article class="dc-main">
    <div class="dc-eyebrow">Docs</div>
    <h1 class="dc-h1">${esc(r.title || d.title)}</h1>
    ${r.toc.length > 2 ? `<div class="dc-toc"><span>On this page</span>${r.toc.map((t) => `<a href="#${t.id}">${esc(t.text)}</a>`).join("")}</div>` : ""}
    <div class="dc-prose">${r.html}</div>
    <div class="dc-pager">${prev ? `<a href="${href(prev.slug)}"><span>Previous</span>${esc(prev.title)}</a>` : "<span></span>"}${next ? `<a class="next" href="${href(next.slug)}"><span>Next</span>${esc(next.title)}</a>` : ""}</div>
    <div class="dc-foot">Written from the specification (docs/SPEC.md). Highlighted figures are read live from Core or the market indexer when the page loads; parameter values are test values, launch values are TBA.</div>
  </article>
</div></main>
<footer class="foot"><span>Lineage docs, a static site. Figures marked TBA could not be read from Core or the market indexer.</span><a class="link" href="${app}/">Back to the explorer</a></footer>
<script type="module" src="${base}/assets/docs.js"></script>
</body>
</html>
`;
    out.set(d.slug === "overview" ? "index.html" : `${d.slug}.html`, { body: html, type: "text/html; charset=utf-8" });
  }
  const js = await Bun.build({ entrypoints: [join(DOCS, "src/client.ts")], target: "browser", minify: true, sourcemap: "none" });
  if (!js.success) throw new Error(js.logs.map(String).join("\n"));
  out.set("assets/docs.js", { body: await js.outputs[0]!.text(), type: "text/javascript; charset=utf-8" });
  out.set("assets/app.css", { body: readFileSync(join(WEB, "public/app.css"), "utf8").replaceAll('url("/fonts/', `url("${base}/fonts/`), type: "text/css; charset=utf-8" });
  out.set("assets/docs.css", { body: readFileSync(join(DOCS, "src/docs.css"), "utf8"), type: "text/css; charset=utf-8" });
  out.set("favicon.svg", { body: readFileSync(join(WEB, "public/favicon.svg")), type: "image/svg+xml" });
  for (const f of readdirSync(join(WEB, "public/fonts")))
    out.set(`fonts/${f}`, { body: new Uint8Array(readFileSync(join(WEB, "public/fonts", f))), type: f.endsWith(".woff2") ? "font/woff2" : "text/plain; charset=utf-8" });
  return out;
}

/** The file for a request path under the base: "/" and "" give index.html, "/verification" gives verification.html. */
export function docsLookup(files: Map<string, DocsFile>, rest: string): DocsFile | null {
  const p = rest.replace(/^\/+/, "").replace(/\/+$/, "");
  if (p === "") return files.get("index.html") ?? null;
  return files.get(p) ?? files.get(`${p}.html`) ?? null;
}

if (import.meta.main) {
  const arg = (n: string, d: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d);
  const out = arg("out", join(DOCS, "dist"));
  const files = await buildDocs({ base: arg("base", "/docs"), app: arg("app", "") });
  rmSync(out, { recursive: true, force: true });
  for (const [p, f] of files) {
    mkdirSync(dirname(join(out, p)), { recursive: true });
    writeFileSync(join(out, p), f.body);
  }
  console.log(`built ${files.size} files into ${out}`);
}
