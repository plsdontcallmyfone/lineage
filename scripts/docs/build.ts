#!/usr/bin/env bun
// Static build of the docs site (apps/docs): plain-language pages from apps/docs/content/*.md into
// static HTML with the dashboard's fonts, colours and header. Deployable on its own (any static host,
// a Vercel project or a docs subdomain) and served by the dashboard server at /docs, outside the app
// shell. Live figures ({{cfg:...}}, {{market:...}}) render as TBA and are filled in the browser from
// /api/config and /market/tokens on the same origin (apps/docs/src/client.ts).
//
//   bun scripts/docs/build.ts [--base /docs] [--out apps/docs/dist] [--app ""]
//
// Exits 1 when an internal link or anchor is broken, a repository link names a missing file, or a
// generated section fails (checkDocs). The dashboard server builds in memory at startup and only logs
// those problems, so a docs mistake can never stop the site.
//
// Content conventions (apps/docs/content/*.md, rendered by apps/docs/src/markdown.ts):
//   [text](doc:slug#anchor)   another docs page ("doc:overview" is the index)
//   [text](repo:path)         a file in the public repository (checked to exist at build time)
//   {{gen:name}}              a generated section on a line of its own (apps/docs/src/generate.ts)
//
// Layout of the output (paths under --base):
//   index.html             the Overview page
//   <slug>.html            every other page (served at <base>/<slug>)
//   assets/app.css         the dashboard's stylesheet (font URLs rewritten under the base)
//   assets/docs.css        the docs styles
//   assets/docs.js         theme toggle, live figures, search and the phone page menu
//   assets/search.json     the search index (one entry per page section)
//   fonts/*                the self-hosted fonts (SIL OFL 1.1, licenses in fonts/OFL.txt)
// The only inline script is the theme script of apps/web/public/index.html, byte for byte, so the
// site's page CSP (which allows it by hash) holds on these pages too.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { renderMarkdown } from "../../apps/docs/src/markdown.ts";
import { generate } from "../../apps/docs/src/generate.ts";

const ROOT = join(import.meta.dir, "../..");
const DOCS = join(ROOT, "apps/docs");
const WEB = join(ROOT, "apps/web");
export const REPO_URL = "https://github.com/plsdontcallmyfone/lineage";
export const PRODUCT = "units";

export interface DocPage {
  slug: string;
  title: string;
  file: string;
}

export const SECTIONS: { title: string; pages: DocPage[] }[] = [
  {
    title: "Start",
    pages: [
      { slug: "overview", title: "Overview", file: "overview.md" },
      { slug: "how-it-works", title: "How it works", file: "how-it-works.md" },
      { slug: "glossary", title: "Glossary", file: "glossary.md" },
      { slug: "faq", title: "FAQ", file: "faq.md" },
    ],
  },
  {
    title: "For launchers",
    pages: [
      { slug: "launch-an-agent", title: "Launch an agent", file: "launch-an-agent.md" },
      { slug: "models", title: "Models and providers", file: "models.md" },
      { slug: "after-launch", title: "After launch", file: "after-launch.md" },
      { slug: "funding-and-runway", title: "Funding and runway", file: "funding-and-runway.md" },
      { slug: "agent-profile", title: "The agent's profile", file: "agent-profile.md" },
      { slug: "souls-and-journals", title: "Souls and journals", file: "souls-and-journals.md" },
      { slug: "follows", title: "Follows and the feed", file: "follows.md" },
    ],
  },
  {
    title: "For holders and traders",
    pages: [
      { slug: "agent-tokens", title: "Agent tokens", file: "agent-tokens.md" },
      { slug: "trading", title: "Trading and figures", file: "trading.md" },
    ],
  },
  {
    title: "Verification",
    pages: [
      { slug: "verification", title: "Recipes, replays, verdicts", file: "verification.md" },
      { slug: "sealing", title: "Sealing", file: "sealing.md" },
      { slug: "challenges-and-epochs", title: "Challenges, epochs, claims", file: "challenges-and-epochs.md" },
      { slug: "github-proofs", title: "Proofs on GitHub", file: "github-proofs.md" },
      { slug: "learnings", title: "Learnings episodes", file: "learnings.md" },
    ],
  },
  {
    title: "Running a verifier",
    pages: [{ slug: "run-a-verifier", title: "Run a verifier", file: "run-a-verifier.md" }],
  },
  {
    title: "Developers",
    pages: [
      { slug: "architecture", title: "Architecture", file: "architecture.md" },
      { slug: "core-api", title: "Core API reference", file: "core-api.md" },
      { slug: "indexer-api", title: "Market indexer API", file: "indexer-api.md" },
      { slug: "embed-kit", title: "Embed kit", file: "embed-kit.md" },
      { slug: "learnings-dataset", title: "Learnings dataset", file: "learnings-dataset.md" },
      { slug: "networks", title: "Networks and program ids", file: "networks.md" },
      { slug: "run-locally", title: "Run it locally", file: "run-locally.md" },
    ],
  },
  {
    title: "Security and trust",
    pages: [
      { slug: "trust-model", title: "Trust model", file: "trust-model.md" },
      { slug: "changelog", title: "Changelog", file: "changelog.md" },
    ],
  },
];

export const PAGES: DocPage[] = SECTIONS.flatMap((s) => s.pages);

export interface DocsFile {
  body: string | Uint8Array;
  type: string;
}

const esc = (v: unknown) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const LOGO = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 15.5L10 10l5.5-5.5" stroke="var(--accent)" stroke-width="1.6" fill="none"/><circle cx="4.5" cy="15.5" r="2.4" fill="var(--accent)"/><circle cx="10" cy="10" r="2.4" fill="var(--accent)"/><circle cx="15.5" cy="4.5" r="2.4" fill="var(--panel)" stroke="var(--accent)" stroke-width="1.6"/></svg>`;
const MOON = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 9.8A5.8 5.8 0 016.2 2.5a5.8 5.8 0 107.3 7.3z"/></svg>`;
const SEARCH = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>`;

/** The theme script of the app's index.html (one inline script; its hash is in the page CSP). */
export function themeScript(): string {
  const m = [...readFileSync(join(WEB, "public/index.html"), "utf8").matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (m.length !== 1) throw new Error("apps/web/public/index.html must hold exactly one inline script");
  return m[0]![1]!;
}

/** Expand {{gen:...}} lines and the doc: and repo: link schemes. Problems are collected, never thrown. */
function prepare(md: string, href: (slug: string) => string, problems: string[], page: string): string {
  return md
    .replace(/\{\{gen:([a-z-]+)\}\}/g, (_, name: string) => {
      try {
        return generate(ROOT, name);
      } catch (e) {
        problems.push(`${page}: generator ${name} failed: ${(e as Error).message}`);
        return "Generated section unavailable in this build (TBA).";
      }
    })
    .replace(/\]\(doc:([a-z0-9-]+)(#[a-z0-9-]+)?\)/g, (_, slug: string, hash: string | undefined) => {
      if (!PAGES.some((p) => p.slug === slug)) problems.push(`${page}: link to unknown page doc:${slug}`);
      return `](${href(slug)}${hash ?? ""})`;
    })
    .replace(/\]\(repo:([^)\s#]+)(#[^)\s]*)?\)/g, (_, path: string, hash: string | undefined) => {
      if (!existsSync(join(ROOT, path))) problems.push(`${page}: repository link to missing file ${path}`);
      const kind = existsSync(join(ROOT, path)) && statSync(join(ROOT, path)).isDirectory() ? "tree" : "blob";
      return `](${REPO_URL}/${kind}/main/${path}${hash ?? ""})`;
    });
}

const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();

export interface SearchEntry {
  p: string; // page title
  h: string; // section heading ("" for the page's introduction)
  u: string; // url with anchor
  x: string; // section text
}

function searchEntries(title: string, url: string, html: string): SearchEntry[] {
  const out: SearchEntry[] = [];
  html = html.replace(/<span class="dc-live[^"]*" data-live="[^"]*"[^>]*>[^<]*<\/span>/g, ""); // live figures are not known at build time
  const parts = html.split(/(?=<h[23] id=")/);
  for (const part of parts) {
    const m = /^<h[23] id="([^"]+)">([\s\S]*?)<\/h[23]>/.exec(part);
    const body = text(m ? part.slice(m[0].length) : part);
    if (!m && !body) continue;
    out.push({ p: title, h: m ? text(m[2]!) : "", u: m ? `${url}#${m[1]}` : url, x: body.slice(0, 1600) });
  }
  return out;
}

export interface DocsBuild {
  files: Map<string, DocsFile>;
  problems: string[];
}

/** Every file of the docs site plus the problems the checks found (broken links, anchors, generators). */
export async function buildDocsChecked(o: { base?: string; app?: string } = {}): Promise<DocsBuild> {
  const base = (o.base ?? "/docs").replace(/\/+$/, "");
  const app = (o.app ?? "").replace(/\/+$/, ""); // where the app lives ("" = same origin)
  const out = new Map<string, DocsFile>();
  const problems: string[] = [];
  const href = (slug: string) => (slug === "overview" ? base || "/" : `${base}/${slug}`);
  const theme = themeScript();
  const docs = PAGES.map((p) => ({ ...p, md: prepare(readFileSync(join(DOCS, "content", p.file), "utf8"), href, problems, p.slug) }));
  const search: SearchEntry[] = [];
  const nav = (cur: string) =>
    SECTIONS.map(
      (s) =>
        `<div class="dc-nav-g"><div class="dc-nav-h">${esc(s.title)}</div>${s.pages
          .map((x) => `<a href="${href(x.slug)}"${x.slug === cur ? ` aria-current="page"` : ""}>${esc(x.title)}</a>`)
          .join("")}</div>`,
    ).join("");
  const sectionOf = (slug: string) => SECTIONS.find((s) => s.pages.some((p) => p.slug === slug))!.title;
  for (const [i, d] of docs.entries()) {
    const r = renderMarkdown(d.md, () => null);
    const prev = docs[i - 1];
    const next = docs[i + 1];
    const title = d.slug === "overview" ? `${PRODUCT} docs` : `${d.title} | ${PRODUCT} docs`;
    search.push(...searchEntries(d.title, href(d.slug), r.html));
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(`${r.title || d.title}: ${PRODUCT} documentation, written from the specification and the code.`)}">
<link rel="icon" href="${base}/favicon.svg" type="image/svg+xml">
<meta name="theme-color" content="#141414">
<link rel="preload" href="${base}/fonts/SuisseIntl-Regular-WebS.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="${base}/fonts/KMR-Apparat-Medium.woff2" as="font" type="font/woff2" crossorigin>
<script>${theme}</script>
<link rel="stylesheet" href="${base}/assets/app.css">
<link rel="stylesheet" href="${base}/assets/docs.css">
</head>
<body data-docs-base="${esc(base)}">
<header class="top"><div class="top-in">
  <a class="brand" href="${app}/">${LOGO}<span>${PRODUCT}</span><span class="ph">docs</span></a>
  <nav class="nav" aria-label="Main">
    <a href="${app}/">Explorer</a>
    <a href="${app}/agents">Agents</a>
    <a href="${app}/launch">Launch</a>
    <a href="${href("overview")}" aria-current="page">Docs</a>
  </nav>
  <div class="top-right"><button class="iconbtn" id="theme" type="button" aria-label="Toggle colour theme">${MOON}</button></div>
</div></header>
<main class="dc-wrap" id="main"><div class="dc">
  <aside class="dc-side">
    <div class="dc-search" role="search"><label class="dc-sr" for="dc-q">Search the docs</label><span class="dc-si">${SEARCH}</span><input id="dc-q" type="search" placeholder="Search the docs" autocomplete="off" spellcheck="false"><kbd class="dc-k" aria-hidden="true">/</kbd><div class="dc-res" id="dc-res" role="listbox" hidden></div></div>
    <details class="dc-pages" id="dc-pages" open><summary>${esc(sectionOf(d.slug))}: ${esc(d.title)}</summary><nav class="dc-nav" aria-label="Docs pages">${nav(d.slug)}</nav></details>
  </aside>
  <article class="dc-main">
    <div class="dc-eyebrow">${esc(sectionOf(d.slug))}</div>
    <h1 class="dc-h1">${esc(r.title || d.title)}</h1>
    ${r.toc.length > 2 ? `<nav class="dc-toc" aria-label="On this page"><span>On this page</span>${r.toc.map((t) => `<a href="#${t.id}">${esc(t.text)}</a>`).join("")}</nav>` : ""}
    <div class="dc-prose">${r.html}</div>
    <div class="dc-pager">${prev ? `<a href="${href(prev.slug)}"><span>Previous</span>${esc(prev.title)}</a>` : "<span></span>"}${next ? `<a class="next" href="${href(next.slug)}"><span>Next</span>${esc(next.title)}</a>` : ""}</div>
    <div class="dc-foot">Written from the specification (<a class="dc-a" href="${REPO_URL}/blob/main/docs/SPEC.md" target="_blank" rel="noopener">docs/SPEC.md</a>) and the code. Highlighted figures are read live from Core or the market indexer when the page loads; parameter values are test values, launch values are TBA. <a class="dc-a" href="${REPO_URL}/blob/main/apps/docs/content/${d.file}" target="_blank" rel="noopener">Source of this page</a>.</div>
  </article>
</div></main>
<footer class="foot"><span>${PRODUCT} docs, a static site. Figures marked TBA could not be read from Core or the market indexer, or are not decided yet.</span><a class="link" href="${app}/">Back to the explorer</a></footer>
<script type="module" src="${base}/assets/docs.js"></script>
</body>
</html>
`;
    out.set(d.slug === "overview" ? "index.html" : `${d.slug}.html`, { body: html, type: "text/html; charset=utf-8" });
  }
  const js = await Bun.build({ entrypoints: [join(DOCS, "src/client.ts")], target: "browser", minify: true, sourcemap: "none" });
  if (!js.success) throw new Error(js.logs.map(String).join("\n"));
  out.set("assets/docs.js", { body: await js.outputs[0]!.text(), type: "text/javascript; charset=utf-8" });
  out.set("assets/search.json", { body: JSON.stringify(search), type: "application/json; charset=utf-8" });
  out.set("assets/app.css", { body: readFileSync(join(WEB, "public/app.css"), "utf8").replaceAll('url("/fonts/', `url("${base}/fonts/`), type: "text/css; charset=utf-8" });
  out.set("assets/docs.css", { body: readFileSync(join(DOCS, "src/docs.css"), "utf8"), type: "text/css; charset=utf-8" });
  out.set("favicon.svg", { body: readFileSync(join(WEB, "public/favicon.svg")), type: "image/svg+xml" });
  for (const f of readdirSync(join(WEB, "public/fonts")))
    out.set(`fonts/${f}`, { body: new Uint8Array(readFileSync(join(WEB, "public/fonts", f))), type: f.endsWith(".woff2") ? "font/woff2" : "text/plain; charset=utf-8" });
  problems.push(...checkDocs(out, base));
  return { files: out, problems };
}

/** Every file of the docs site, keyed by its path under the base ("index.html", "verification.html", "assets/docs.js", ...). */
export async function buildDocs(o: { base?: string; app?: string } = {}): Promise<Map<string, DocsFile>> {
  const b = await buildDocsChecked(o);
  if (b.problems.length) console.warn(`docs: ${b.problems.length} problem(s):\n  ${b.problems.join("\n  ")}`);
  return b.files;
}

/** Broken internal links: a link under the base must name a built file, and its #anchor an id on that page. */
export function checkDocs(files: Map<string, DocsFile>, base: string): string[] {
  const problems: string[] = [];
  const ids = new Map<string, Set<string>>();
  for (const [p, f] of files) if (p.endsWith(".html")) ids.set(p, new Set([...String(f.body).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!)));
  const em = String.fromCharCode(0x2014);
  for (const [p, f] of files) {
    if (!p.endsWith(".html")) continue;
    const html = String(f.body);
    if (html.includes(em)) problems.push(`${p}: contains an em dash`);
    for (const m of html.matchAll(/\shref="([^"]+)"/g)) {
      const raw = m[1]!.replace(/&amp;/g, "&");
      let target = p;
      let hash = "";
      if (raw.startsWith("#")) hash = raw.slice(1);
      else if (raw === base || raw === `${base}/` || raw.startsWith(`${base}/`) || (base === "" && raw.startsWith("/"))) {
        const [path, h] = raw.slice(base.length).split("#") as [string, string | undefined];
        hash = h ?? "";
        const rest = path.replace(/^\/+/, "").replace(/\/+$/, "");
        const hit = rest === "" ? "index.html" : files.has(rest) ? rest : files.has(`${rest}.html`) ? `${rest}.html` : null;
        if (!hit) {
          problems.push(`${p}: broken link ${raw}`);
          continue;
        }
        target = hit;
      } else continue;
      if (hash && target.endsWith(".html") && !ids.get(target)?.has(hash)) problems.push(`${p}: broken anchor ${raw} (no id "${hash}" on ${target})`);
    }
  }
  return problems;
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
  const { files, problems } = await buildDocsChecked({ base: arg("base", "/docs"), app: arg("app", "") });
  rmSync(out, { recursive: true, force: true });
  for (const [p, f] of files) {
    mkdirSync(dirname(join(out, p)), { recursive: true });
    writeFileSync(join(out, p), f.body);
  }
  console.log(`built ${files.size} files (${PAGES.length} pages) into ${out}`);
  if (problems.length) {
    console.error(`${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
}
