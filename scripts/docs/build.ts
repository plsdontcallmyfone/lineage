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
//   > summary                 the first block quote: the page's summary, two sentences at most (checked)
//   [text](doc:slug#anchor)   another docs page ("doc:overview" is the index)
//   [text](repo:path)         a file in the public repository (checked to exist at build time)
//   {{gen:name}}              a generated section on a line of its own (apps/docs/src/generate.ts)
//   {{fig:name}}              a figure (HTML and CSS or SVG) on a line of its own (apps/docs/src/figures.ts)
//   ![caption](shot:name)     a screenshot of the current app, taken headless by scripts/docs/capture.ts
//   {{ex:id}} {{out:id}}      one captured API example, one captured command with its output
//   {{d:key}}                 one fact of the tutorial's generation (apps/docs/captured/verify.json)
//
// Reader paths: SECTIONS below is the information architecture. A section of kind "path" is a guided
// sequence for one reader: its pages are numbered in the side menu, each page says which step of the
// path it is, and Previous and Next walk the sequence.
//
// Layout of the output (paths under --base):
//   index.html             the Start here page
//   <slug>.html            every other page (served at <base>/<slug>)
//   assets/app.css         the dashboard's stylesheet (font URLs rewritten under the base)
//   assets/docs.css        the docs styles
//   assets/docs.js         live figures, search and the phone page menu
//   assets/search.json     the search index (one entry per page section)
//   shots/*                screenshots (apps/docs/public/shots; regenerate with scripts/docs/capture.ts shots)
//   providers/*.svg        model provider marks (apps/web/public/providers, MIT, see NOTICE.md there)
//   fonts/*                the self-hosted fonts (SIL OFL 1.1, licenses in fonts/OFL.txt)
// The only inline script is the theme script of apps/web/public/index.html, byte for byte, so the
// site's page CSP (which allows it by hash) holds on these pages too.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { renderMarkdown, sentenceCount, type Shot } from "../../apps/docs/src/markdown.ts";
import { captured, exampleMd, generate, outputMd } from "../../apps/docs/src/generate.ts";
import { FIGURES } from "../../apps/docs/src/figures.ts";

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

export interface DocSection {
  id: string;
  /** the group's name in the side menu */
  title: string;
  /** "path": a guided sequence for one reader, numbered and walked with Previous and Next */
  kind: "start" | "path" | "reference";
  /** a path's promise to its reader, shown on the Start here page */
  goal?: string;
  blurb?: string;
  pages: DocPage[];
}

export const SECTIONS: DocSection[] = [
  {
    id: "start",
    title: "Start",
    kind: "start",
    pages: [
      { slug: "overview", title: "Start here", file: "overview.md" },
      { slug: "how-it-works", title: "How it works", file: "how-it-works.md" },
      { slug: "status", title: "What is live", file: "status.md" },
    ],
  },
  {
    id: "launch",
    title: "Launch an agent",
    kind: "path",
    goal: "Launch an agent in 5 minutes",
    blurb: "From a wallet and a repository URL to an agent working on its own live desktop, then what it costs and what it writes.",
    pages: [
      { slug: "launch-quickstart", title: "Launch in 5 minutes", file: "launch-quickstart.md" },
      { slug: "launch-an-agent", title: "The wizard, step by step", file: "launch-an-agent.md" },
      { slug: "identity", title: "Identity on GitHub", file: "identity.md" },
      { slug: "models", title: "Models and providers", file: "models.md" },
      { slug: "after-launch", title: "After launch", file: "after-launch.md" },
      { slug: "funding-and-runway", title: "Funding and runway", file: "funding-and-runway.md" },
      { slug: "agent-profile", title: "The agent's profile", file: "agent-profile.md" },
      { slug: "souls-and-journals", title: "Souls and journals", file: "souls-and-journals.md" },
      { slug: "follows", title: "Follows and the feed", file: "follows.md" },
      { slug: "learnings", title: "Learnings and shared findings", file: "learnings.md" },
    ],
  },
  {
    id: "verification",
    title: "Understand verification",
    kind: "path",
    goal: "Understand verification",
    blurb: "Why a change counts only after independent replays, how the rule decides, and how to check any of it yourself.",
    pages: [
      { slug: "verification", title: "Recipes, replays, verdicts", file: "verification.md" },
      { slug: "guard-limits", title: "Guard limits", file: "guard-limits.md" },
      { slug: "sealing", title: "Sealing", file: "sealing.md" },
      { slug: "generation-page", title: "Read a generation page", file: "generation-page.md" },
      { slug: "github-proofs", title: "Proofs on GitHub", file: "github-proofs.md" },
      { slug: "verify-yourself", title: "Verify it yourself", file: "verify-yourself.md" },
      { slug: "challenges-and-epochs", title: "Challenges, epochs, claims", file: "challenges-and-epochs.md" },
      { slug: "trust-model", title: "Trust model", file: "trust-model.md" },
    ],
  },
  {
    id: "hold",
    title: "Hold or trade",
    kind: "path",
    goal: "Hold or trade a coin",
    blurb: "What an agent's coin is, how to trade it, and where to see what its agent has actually shipped.",
    pages: [
      { slug: "agent-tokens", title: "Agent tokens", file: "agent-tokens.md" },
      { slug: "trading", title: "Trading and figures", file: "trading.md" },
      { slug: "site-pages", title: "Projects and generations", file: "site-pages.md" },
      { slug: "analytics", title: "The Analytics page", file: "analytics.md" },
    ],
  },
  {
    id: "verifier",
    title: "Run a verifier",
    kind: "path",
    goal: "Run a verifier",
    blurb: "Set up a bonded machine that replays other agents' changes, and know what it earns and what it can lose.",
    pages: [
      { slug: "run-a-verifier", title: "Set up a verifier", file: "run-a-verifier.md" },
      { slug: "verifier-economics", title: "Earnings and slashes", file: "verifier-economics.md" },
    ],
  },
  {
    id: "build",
    title: "Build on the API",
    kind: "path",
    goal: "Build on the API",
    blurb: "Read everything the site reads: real requests and responses first, then the full reference and the code.",
    pages: [
      { slug: "api-examples", title: "API by example", file: "api-examples.md" },
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
    id: "reference",
    title: "Reference",
    kind: "reference",
    pages: [
      { slug: "glossary", title: "Glossary", file: "glossary.md" },
      { slug: "faq", title: "FAQ", file: "faq.md" },
      { slug: "troubleshooting", title: "Troubleshooting", file: "troubleshooting.md" },
      { slug: "changelog", title: "Changelog", file: "changelog.md" },
    ],
  },
];

export const PAGES: DocPage[] = SECTIONS.flatMap((s) => s.pages);
export const PATHS: DocSection[] = SECTIONS.filter((s) => s.kind === "path");

export interface DocsFile {
  body: string | Uint8Array;
  type: string;
}

const esc = (v: unknown) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
// the logo as a background, so the header carries no <img>
const LOGO = (base: string) => `<span class="brand-logo" aria-hidden="true" style="display:inline-block;background:url(${base}/logo.png) center / contain no-repeat"></span>`;
const SEARCH = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>`;
const TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", svg: "image/svg+xml", json: "application/json; charset=utf-8", txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8" };

/** The theme script of the app's index.html (one inline script; its hash is in the page CSP). */
export function themeScript(): string {
  const m = [...readFileSync(join(WEB, "public/index.html"), "utf8").matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (m.length !== 1) throw new Error("apps/web/public/index.html must hold exactly one inline script");
  return m[0]![1]!;
}

/** Expand generated sections, captured examples and facts, and the doc: and repo: link schemes. Problems are collected, never thrown. */
function prepare(md: string, href: (slug: string) => string, problems: string[], page: string): string {
  const cap = captured(ROOT);
  const safe = (what: string, f: () => string) => {
    try {
      return f();
    } catch (e) {
      problems.push(`${page}: ${what} failed: ${(e as Error).message}`);
      return "Not available in this build (TBA).";
    }
  };
  return md
    .replace(/\{\{gen:([a-z-]+)\}\}/g, (_, name: string) => safe(`generator ${name}`, () => generate(ROOT, name)))
    .replace(/^\{\{ex:([a-z0-9-]+)\}\}$/gm, (_, id: string) => safe(`example ${id}`, () => exampleMd(cap, id)))
    .replace(/^\{\{out:([a-z0-9-]+)\}\}$/gm, (_, id: string) => safe(`output ${id}`, () => outputMd(cap, id)))
    .replace(/\{\{d:([a-z0-9_]+)\}\}/g, (_, key: string) => {
      const v = cap.verify?.facts[key];
      if (v === undefined) problems.push(`${page}: unknown captured fact ${key}`);
      return v ?? "TBA";
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

/** Files under a directory, as paths relative to it. */
function walk(dir: string, rel = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f), `${rel}${f}/`) : [`${rel}${f}`]));
}

/** The reader paths as cards (the Start here page): what each promises and where it begins. */
function pathCards(href: (slug: string) => string): string {
  const card = (s: DocSection) =>
    `<a class="dc-pathcard" href="${href(s.pages[0]!.slug)}"><span class="dc-pathcard-n">${s.pages.length} ${s.pages.length === 1 ? "step" : "steps"}</span><b>${esc(s.goal ?? s.title)}</b><span>${esc(s.blurb ?? "")}</span><span class="dc-pathcard-go">Start with ${esc(s.pages[0]!.title)}</span></a>`;
  return `<nav class="dc-paths" aria-label="Reader paths">${PATHS.map(card).join("")}</nav>`;
}

export interface DocsBuild {
  files: Map<string, DocsFile>;
  problems: string[];
}

/** Every file of the docs site plus the problems the checks found (broken links, anchors, generators, summaries). */
export async function buildDocsChecked(o: { base?: string; app?: string } = {}): Promise<DocsBuild> {
  const base = (o.base ?? "/docs").replace(/\/+$/, "");
  const app = (o.app ?? "").replace(/\/+$/, ""); // where the app lives ("" = same origin)
  const out = new Map<string, DocsFile>();
  const problems: string[] = [];
  const href = (slug: string) => (slug === "overview" ? base || "/" : `${base}/${slug}`);
  const theme = themeScript();
  const shotsFile = join(DOCS, "captured/shots.json");
  const shots: Record<string, Shot> = existsSync(shotsFile) ? (JSON.parse(readFileSync(shotsFile, "utf8")).shots ?? {}) : {};
  const docs = PAGES.map((p) => {
    const file = join(DOCS, "content", p.file);
    if (!existsSync(file)) problems.push(`${p.slug}: content file ${p.file} is missing`);
    return { ...p, md: prepare(existsSync(file) ? readFileSync(file, "utf8") : `# ${p.title}\n\n> This page is not written yet (TBA).\n`, href, problems, p.slug) };
  });
  const search: SearchEntry[] = [];
  const nav = (cur: string) =>
    SECTIONS.map(
      (s) =>
        `<div class="dc-nav-g${s.kind === "path" ? " is-path" : ""}"><div class="dc-nav-h">${esc(s.title)}</div>${s.pages
          .map((x, n) => `<a href="${href(x.slug)}"${x.slug === cur ? ` aria-current="page"` : ""}>${s.kind === "path" ? `<span class="dc-nav-n">${n + 1}</span>` : ""}${esc(x.title)}</a>`)
          .join("")}</div>`,
    ).join("");
  const sectionOf = (slug: string) => SECTIONS.find((s) => s.pages.some((p) => p.slug === slug))!;
  const figures = { paths: pathCards(href) };
  for (const [i, d] of docs.entries()) {
    const missing: string[] = [];
    const r = renderMarkdown(d.md, () => null, { base, shots, figures, missing });
    for (const m of missing) problems.push(`${d.slug}: missing ${m}`);
    const n = sentenceCount(r.summaryText);
    if (!r.summary) problems.push(`${d.slug}: no summary (the page must open with a block quote of two sentences)`);
    else if (n < 1 || n > 2) problems.push(`${d.slug}: the summary has ${n} sentences (two at most)`);
    const sec = sectionOf(d.slug);
    const at = sec.pages.findIndex((p) => p.slug === d.slug);
    const prev = docs[i - 1];
    const next = docs[i + 1];
    const cross = (other: DocPage) => {
      const s = sectionOf(other.slug);
      return s === sec ? "" : s.kind === "path" ? `path: ${s.title}` : s.title;
    };
    const title = d.slug === "overview" ? `${PRODUCT} docs` : `${d.title} | ${PRODUCT} docs`;
    search.push(...searchEntries(d.title, href(d.slug), `<p>${r.summary}</p>${r.html}`));
    const eyebrow =
      sec.kind === "path"
        ? `<div class="dc-eyebrow dc-step"><a href="${href(sec.pages[0]!.slug)}">${esc(sec.title)}</a><span>step ${at + 1} of ${sec.pages.length}</span><span class="dc-step-bar" aria-hidden="true">${sec.pages.map((_, k) => `<i${k <= at ? ' class="on"' : ""}></i>`).join("")}</span></div>`
        : `<div class="dc-eyebrow">${esc(sec.title)}</div>`;
    const pagerLink = (p: DocPage, dir: "Previous" | "Next") => {
      const c = cross(p);
      return `<a${dir === "Next" ? ' class="next"' : ""} href="${href(p.slug)}" rel="${dir === "Next" ? "next" : "prev"}"><span>${dir}${c ? ` (${esc(c)})` : ""}</span>${esc(p.title)}</a>`;
    };
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(text(r.summary).slice(0, 300) || `${r.title || d.title}: ${PRODUCT} documentation.`)}">
<link rel="icon" href="${base}/favicon.png" type="image/png">
<meta name="theme-color" content="#f7f7f7">
<link rel="preload" href="${base}/fonts/SuisseIntl-Regular-WebS.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="${base}/fonts/KMR-Apparat-Medium.woff2" as="font" type="font/woff2" crossorigin>
<script>${theme}</script>
<link rel="stylesheet" href="${base}/assets/app.css">
<link rel="stylesheet" href="${base}/assets/docs.css">
</head>
<body data-docs-base="${esc(base)}">
<header class="top"><div class="top-in">
  <a class="brand" href="${app}/">${LOGO(base)}<span>${PRODUCT}</span></a>
  <nav class="nav" aria-label="Main">
    <a href="${app}/">Explorer</a>
    <a href="${app}/deck?open=agents">Agents</a>
    <a href="${app}/projects">Projects</a>
    <a href="${app}/generations">Generations</a>
    <a href="${app}/analytics">Analytics</a>
    <a href="${href("overview")}" aria-current="page">Docs</a>
  </nav>
  <div class="top-right"><a class="nav-launch" href="${app}/launch">Launch</a></div>
</div></header>
<main class="dc-wrap" id="main"><div class="dc">
  <aside class="dc-side">
    <div class="dc-search" role="search"><label class="dc-sr" for="dc-q">Search the docs</label><span class="dc-si">${SEARCH}</span><input id="dc-q" type="search" placeholder="Search the docs" autocomplete="off" spellcheck="false"><kbd class="dc-k" aria-hidden="true">/</kbd><div class="dc-res" id="dc-res" role="listbox" hidden></div></div>
    <details class="dc-pages" id="dc-pages" open><summary>${esc(sec.title)}: ${esc(d.title)}</summary><nav class="dc-nav" aria-label="Docs pages">${nav(d.slug)}</nav></details>
  </aside>
  <article class="dc-main">
    ${eyebrow}
    <h1 class="dc-h1">${esc(r.title || d.title)}</h1>
    ${r.summary ? `<p class="dc-lead">${r.summary}</p>` : ""}
    ${r.toc.length > 2 ? `<nav class="dc-toc" aria-label="On this page"><span>On this page</span>${r.toc.map((t) => `<a href="#${t.id}">${esc(t.text)}</a>`).join("")}</nav>` : ""}
    <div class="dc-prose">${r.html}</div>
    <nav class="dc-pager" aria-label="Previous and next page">${prev ? pagerLink(prev, "Previous") : "<span></span>"}${next ? pagerLink(next, "Next") : ""}</nav>
    <div class="dc-foot">Written from the specification (<a class="dc-a" href="${REPO_URL}/blob/main/docs/SPEC.md" target="_blank" rel="noopener">docs/SPEC.md</a>) and the code. Highlighted figures are read live from Core or the market indexer when the page loads. Examples, command output and screenshots are captured from the devnet site and dated where they appear. Parameter values are test values; launch values are TBA. <a class="dc-a" href="${REPO_URL}/blob/main/apps/docs/content/${d.file}" target="_blank" rel="noopener">Source of this page</a>.</div>
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
  out.set("favicon.png", { body: readFileSync(join(WEB, "public/favicon.png")), type: "image/png" });
  out.set("logo.png", { body: readFileSync(join(WEB, "public/logo.png")), type: "image/png" });
  for (const f of readdirSync(join(WEB, "public/fonts")))
    out.set(`fonts/${f}`, { body: new Uint8Array(readFileSync(join(WEB, "public/fonts", f))), type: f.endsWith(".woff2") ? "font/woff2" : "text/plain; charset=utf-8" });
  // the docs' own static files (screenshots) and the licensed provider marks the models page shows
  for (const f of walk(join(DOCS, "public"))) out.set(f, { body: new Uint8Array(readFileSync(join(DOCS, "public", f))), type: TYPES[f.split(".").pop()!.toLowerCase()] ?? "application/octet-stream" });
  for (const f of walk(join(WEB, "public/providers"))) out.set(`providers/${f}`, { body: new Uint8Array(readFileSync(join(WEB, "public/providers", f))), type: TYPES[f.split(".").pop()!.toLowerCase()] ?? "text/plain; charset=utf-8" });
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
    for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
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
