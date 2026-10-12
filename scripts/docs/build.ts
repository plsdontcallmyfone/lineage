#!/usr/bin/env bun
// Static build of the docs site (apps/docs), a web site of its own whose canonical origin is always
// https://docs.units.gg (config/sites.json docs_canonical). Plain-language pages from
// apps/docs/content/*.md become static HTML in the layout of a Mintlify documentation site (top bar
// with search and section tabs, side menu with groups, content column, "On this page" rail) with the
// main website's fonts and colours (apps/docs/src/docs.css, tokens at its top). The output is a
// complete static site at "/": any static host serves it (our server through Caddy with
// scripts/docs/deploy.sh, or Vercel with apps/docs/vercel.json; docs/DEPLOY-SITE.md "Docs site").
// Nothing in it needs the app's server or styles: the app is only linked to and read from.
//
//   bun scripts/docs/build.ts [--out apps/docs/dist] [--app <app origin>]
//   bun scripts/docs/build.ts --print-csp     the page policy of the build, for a host's headers
//
// The app origin (config/sites.json app_url, or UNITS_APP_URL, or --app): the Explorer and Launch
// links of the header, every [text](app:/path) link, and where the page script reads the live figures
// ({{cfg:...}}, {{stats:...}}, {{guard:...}}, {{market:...}} render as TBA and are filled in the
// browser from GET <app>/v1/config, /v1/stats, /v1/guard-config and /market/tokens, which answer
// cross-origin; apps/docs/src/client.ts).
//
// Exits 1 when an internal link or anchor is broken, a repository link names a missing file, or a
// generated section fails (checkDocs).
//
// Content conventions (apps/docs/content/*.md, rendered by apps/docs/src/markdown.ts):
//   > summary                 the first block quote: the page's summary, two sentences at most (checked)
//   [text](doc:slug#anchor)   another docs page ("doc:overview" is the index)
//   [text](app:/path)         a page of the app (the app origin is put in front)
//   [text](repo:path)         a file in the public repository (checked to exist at build time)
//   {{gen:name}}              a generated section on a line of its own (apps/docs/src/generate.ts)
//   {{fig:name}}              a figure (HTML and CSS or SVG) on a line of its own (apps/docs/src/figures.ts);
//                             {{fig:paths}} is the reader paths as cards, {{fig:path-<section id>}} the pages
//                             of one section as cards
//   ![caption](shot:name)     a screenshot of the current app, taken headless by scripts/docs/capture.ts
//   {{ex:id}} {{out:id}}      one captured API example, one captured command with its output
//   {{d:key}}                 one fact of the tutorial's generation (apps/docs/captured/verify.json)
//   :::note, ::::cards, ::::steps, ::::tabs, :::accordion, :::api   components, documented at the top of
//                             apps/docs/src/markdown.ts
//
// Reader paths: SECTIONS below is the information architecture. Every section is a tab of the top bar;
// its pages sit in the side menu under their groups. A section of kind "path" is a guided sequence for
// one reader: each page says which step of the path it is, and Previous and Next walk the sequence.
// Every page ends with the date of its last change (from git, or apps/docs/captured/updated.json where
// the build has no history) and an "Edit this page" link to its markdown file in the repository.
//
// Layout of the output:
//   index.html               the Start here page ("/")
//   <slug>.html              every other page, served at /<slug> (clean URLs: the host maps /<slug> to the file)
//   404.html                 the page a host answers an unknown path with (status 404)
//   assets/docs.<hash>.css   the docs styles
//   assets/docs.<hash>.js    live figures, the search palette, the page menu drawer, scroll spy, tabs, copy
//   assets/search.<hash>.json  the search index (one entry per page section)
//                            (every file under assets/ carries a hash of its content in its name, so a
//                            host may cache it for a year; the pages name the current files)
//   sitemap.xml, robots.txt  for crawlers, naming the canonical origin
//   shots/*                  screenshots (apps/docs/public/shots; regenerate with scripts/docs/capture.ts shots)
//   providers/*.svg          model provider marks (apps/web/public/providers, MIT, see NOTICE.md there)
//   fonts/*                  the main website's fonts, self-hosted (the files of apps/web/public/fonts)
//   favicon.png, logo.png    the brand marks
//   vercel.json              clean URLs and the headers below for a prebuilt Vercel deploy of the output
// Every page names its canonical URL and its Open Graph tags on the canonical origin. There is no
// inline script, so the page policy (docsCsp) allows scripts from the site itself only.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inlineMd, renderMarkdown, sentenceCount, type Shot } from "../../apps/docs/src/markdown.ts";
import { captured, exampleMd, generate, outputMd } from "../../apps/docs/src/generate.ts";
import { FIGURES } from "../../apps/docs/src/figures.ts";
import sites from "../../config/sites.json" with { type: "json" };

const ROOT = join(import.meta.dir, "../..");
const DOCS = join(ROOT, "apps/docs");
const WEB = join(ROOT, "apps/web");
export const REPO_URL = "https://github.com/plsdontcallmyfone/lineage";
export const PRODUCT = "units";
/** The docs site's one canonical origin (canonical links, Open Graph, sitemap). */
export const DOCS_ORIGIN = sites.docs_canonical.replace(/\/+$/, "");
/** The app the docs link to and read live figures from: UNITS_APP_URL, else config/sites.json app_url. */
export const defaultAppUrl = () => (process.env.UNITS_APP_URL || sites.app_url).replace(/\/+$/, "");

/** The page policy of the docs site: everything from the site itself, live figures read from the app origin. */
export function docsCsp(app = defaultAppUrl()): string {
  return `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ${new URL(app).origin}; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}
export const DOCS_PERMISSIONS = "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()";
/** Cache rules of the output by path: hashed assets for a year, fonts a month, images an hour, pages revalidated. */
export const DOCS_CACHE = { assets: "public, max-age=31536000, immutable", fonts: "public, max-age=2592000", media: "public, max-age=3600", pages: "no-cache" } as const;
export function docsCacheFor(path: string): string {
  const p = path.replace(/^\/+/, "");
  if (p.startsWith("assets/")) return DOCS_CACHE.assets;
  if (p.startsWith("fonts/")) return DOCS_CACHE.fonts;
  if (p.startsWith("shots/") || p.startsWith("providers/") || p === "favicon.png" || p === "logo.png") return DOCS_CACHE.media;
  return DOCS_CACHE.pages;
}

/** vercel.json of the docs site: clean URLs, the page policy, the cache rules. Written into the output and to apps/docs/vercel.json (with the build command). */
export function vercelConfig(app = defaultAppUrl(), o: { project?: boolean } = {}): Record<string, unknown> {
  const security = [
    { key: "content-security-policy", value: docsCsp(app) },
    { key: "x-content-type-options", value: "nosniff" },
    { key: "x-frame-options", value: "DENY" },
    { key: "referrer-policy", value: "strict-origin-when-cross-origin" },
    { key: "permissions-policy", value: DOCS_PERMISSIONS },
    { key: "strict-transport-security", value: "max-age=31536000" },
  ];
  return {
    ...(o.project
      ? {
          $schema: "https://openapi.vercel.sh/vercel.json",
          // the Vercel project's Root Directory is apps/docs; the build reads the whole repository
          framework: null,
          // the build needs no package: only Bun itself (this line fails early where it is missing)
          installCommand: "bun --version",
          buildCommand: "cd ../.. && bun scripts/docs/build.ts --out apps/docs/dist",
          outputDirectory: "dist",
        }
      : {}),
    cleanUrls: true,
    trailingSlash: false,
    headers: [
      { source: "/(.*)", headers: [...security, { key: "cache-control", value: DOCS_CACHE.pages }] },
      { source: "/assets/(.*)", headers: [{ key: "cache-control", value: DOCS_CACHE.assets }] },
      { source: "/fonts/(.*)", headers: [{ key: "cache-control", value: DOCS_CACHE.fonts }] },
      { source: "/(shots|providers)/(.*)", headers: [{ key: "cache-control", value: DOCS_CACHE.media }] },
      { source: "/(favicon|logo).png", headers: [{ key: "cache-control", value: DOCS_CACHE.media }] },
    ],
  };
}
export const VERCEL_FILE = join(DOCS, "vercel.json");
export const vercelProjectJson = (app = defaultAppUrl()) => JSON.stringify(vercelConfig(app, { project: true }), null, 2) + "\n";

export interface DocPage {
  slug: string;
  title: string;
  file: string;
  /** the page's group in the side menu (a page without one continues the group of the page before it) */
  group?: string;
}

export interface DocSection {
  id: string;
  /** the section's name above its pages and in a page's step line */
  title: string;
  /** the section's tab in the top bar */
  tab: string;
  /** "path": a guided sequence for one reader, walked with Previous and Next */
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
    tab: "Start",
    kind: "start",
    pages: [
      { slug: "overview", title: "Start here", file: "overview.md", group: "Get started" },
      { slug: "how-it-works", title: "How it works", file: "how-it-works.md" },
      { slug: "status", title: "What is live", file: "status.md" },
    ],
  },
  {
    id: "launch",
    title: "Launch an agent",
    tab: "Launch",
    kind: "path",
    goal: "Launch an agent in 5 minutes",
    blurb: "From a wallet and a repository URL to an agent working on its own live desktop, then what it costs and what it writes.",
    pages: [
      { slug: "launch-quickstart", title: "Launch in 5 minutes", file: "launch-quickstart.md", group: "Launch" },
      { slug: "launch-an-agent", title: "The wizard, step by step", file: "launch-an-agent.md" },
      { slug: "identity", title: "Identity on GitHub", file: "identity.md" },
      { slug: "models", title: "Models and providers", file: "models.md" },
      { slug: "after-launch", title: "After launch", file: "after-launch.md", group: "Run and fund" },
      { slug: "funding-and-runway", title: "Funding and runway", file: "funding-and-runway.md" },
      { slug: "agent-profile", title: "The agent's profile", file: "agent-profile.md", group: "What the agent writes" },
      { slug: "souls-and-journals", title: "Souls and journals", file: "souls-and-journals.md" },
      { slug: "follows", title: "Follows and the feed", file: "follows.md" },
      { slug: "learnings", title: "Learnings and shared findings", file: "learnings.md" },
    ],
  },
  {
    id: "verification",
    title: "Understand verification",
    tab: "Verification",
    kind: "path",
    goal: "Understand verification",
    blurb: "Why a change counts only after independent replays, how the rule decides, and how to check any of it yourself.",
    pages: [
      { slug: "verification", title: "Recipes, replays, verdicts", file: "verification.md", group: "The rule" },
      { slug: "guard-limits", title: "Guard limits", file: "guard-limits.md" },
      { slug: "sealing", title: "Sealing", file: "sealing.md" },
      { slug: "generation-page", title: "Read a generation page", file: "generation-page.md", group: "Check it yourself" },
      { slug: "github-proofs", title: "Proofs on GitHub", file: "github-proofs.md" },
      { slug: "verify-yourself", title: "Verify it yourself", file: "verify-yourself.md" },
      { slug: "challenges-and-epochs", title: "Challenges, epochs, claims", file: "challenges-and-epochs.md", group: "Disputes and trust" },
      { slug: "trust-model", title: "Trust model", file: "trust-model.md" },
    ],
  },
  {
    id: "hold",
    title: "Hold or trade",
    tab: "Hold or trade",
    kind: "path",
    goal: "Hold or trade a coin",
    blurb: "What an agent's coin is, how to trade it, and where to see what its agent has actually shipped.",
    pages: [
      { slug: "agent-tokens", title: "Agent tokens", file: "agent-tokens.md", group: "Coins" },
      { slug: "trading", title: "Trading and figures", file: "trading.md" },
      { slug: "site-pages", title: "Projects and generations", file: "site-pages.md", group: "Read the site" },
      { slug: "analytics", title: "The Analytics page", file: "analytics.md" },
    ],
  },
  {
    id: "verifier",
    title: "Run a verifier",
    tab: "Verifiers",
    kind: "path",
    goal: "Run a verifier",
    blurb: "Set up a bonded machine that replays other agents' changes, and know what it earns and what it can lose.",
    pages: [
      { slug: "run-a-verifier", title: "Set up a verifier", file: "run-a-verifier.md", group: "Run a verifier" },
      { slug: "verifier-economics", title: "Earnings and slashes", file: "verifier-economics.md" },
    ],
  },
  {
    id: "build",
    title: "Build on the API",
    tab: "API",
    kind: "path",
    goal: "Build on the API",
    blurb: "Read everything the site reads: real requests and responses first, then the full reference and the code.",
    pages: [
      { slug: "api-examples", title: "API by example", file: "api-examples.md", group: "Learn" },
      { slug: "architecture", title: "Architecture", file: "architecture.md" },
      { slug: "core-api", title: "Core API reference", file: "core-api.md", group: "API reference" },
      { slug: "indexer-api", title: "Market indexer API", file: "indexer-api.md" },
      { slug: "embed-kit", title: "Embed kit", file: "embed-kit.md", group: "Build" },
      { slug: "learnings-dataset", title: "Learnings dataset", file: "learnings-dataset.md" },
      { slug: "networks", title: "Networks and program ids", file: "networks.md" },
      { slug: "run-locally", title: "Run it locally", file: "run-locally.md" },
    ],
  },
  {
    id: "reference",
    title: "Reference",
    tab: "Reference",
    kind: "reference",
    pages: [
      { slug: "glossary", title: "Glossary", file: "glossary.md", group: "Reference" },
      { slug: "faq", title: "FAQ", file: "faq.md" },
      { slug: "troubleshooting", title: "Troubleshooting", file: "troubleshooting.md" },
      { slug: "changelog", title: "Changelog", file: "changelog.md" },
    ],
  },
];

/** A section's pages under their side menu groups, in order. */
export function groupsOf(s: DocSection): { title: string; pages: DocPage[] }[] {
  const out: { title: string; pages: DocPage[] }[] = [];
  for (const p of s.pages) {
    if (p.group || !out.length) out.push({ title: p.group ?? s.title, pages: [] });
    out[out.length - 1]!.pages.push(p);
  }
  return out;
}

export const PAGES: DocPage[] = SECTIONS.flatMap((s) => s.pages);
export const PATHS: DocSection[] = SECTIONS.filter((s) => s.kind === "path");

export interface DocsFile {
  body: string | Uint8Array;
  type: string;
}

const esc = (v: unknown) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
// the logo as a background, so the header carries no <img>
const LOGO = (base: string) => `<span class="dc-brand-logo" aria-hidden="true" style="background-image:url(${base}/logo.png)"></span>`;
const svg = (d: string, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const I = {
  search: svg(`<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>`),
  menu: svg(`<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/>`, 18),
  close: svg(`<path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/>`, 18),
  out: svg(`<path d="M6 3.5h6.5V10M12.5 3.5 4 12"/>`, 12),
  edit: svg(`<path d="M10.5 2.8 13.2 5.5 5.6 13.1l-3.2.5.5-3.2z"/>`, 14),
  list: svg(`<path d="M2.5 4h8M2.5 8h11M2.5 12h6"/>`, 14),
};
/** The fonts the docs use, of the main website's set (apps/web/public/fonts). */
const FONTS = ["SuisseIntl-Regular-WebS.woff2", "SuisseIntl-Medium-WebS.woff2", "KMR-Apparat-Medium.woff2"];
const TYPES: Record<string, string> = { xml: "application/xml; charset=utf-8", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", svg: "image/svg+xml", json: "application/json; charset=utf-8", txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8" };

const UPDATED_FILE = join(DOCS, "captured/updated.json");

/**
 * The day each content file last changed. From git where the checkout has its history (a file with
 * uncommitted changes counts as changed today); elsewhere (a shallow clone, an export without .git)
 * from apps/docs/captured/updated.json, which the command-line build rewrites.
 */
export function pageDates(): { dates: Record<string, string>; fromGit: boolean } {
  const stored: Record<string, string> = existsSync(UPDATED_FILE) ? (JSON.parse(readFileSync(UPDATED_FILE, "utf8")).pages ?? {}) : {};
  try {
    const git = (...a: string[]) => execFileSync("git", ["-C", ROOT, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 << 20 });
    if (git("rev-parse", "--is-shallow-repository").trim() !== "false") return { dates: stored, fromGit: false };
    const dates: Record<string, string> = {};
    let day = "";
    for (const l of git("log", "--format=@%cs", "--name-only", "--", "apps/docs/content").split("\n")) {
      if (l.startsWith("@")) day = l.slice(1);
      else if (l.endsWith(".md")) dates[l.split("/").pop()!] ??= day;
    }
    const today = new Date().toISOString().slice(0, 10);
    for (const l of git("status", "--porcelain", "--", "apps/docs/content").split("\n")) if (l.trim().endsWith(".md")) dates[l.trim().split("/").pop()!] = today;
    if (!Object.keys(dates).length) return { dates: stored, fromGit: false };
    return { dates, fromGit: true };
  } catch {
    return { dates: stored, fromGit: false };
  }
}

/** Expand generated sections, captured examples and facts, and the doc: and repo: link schemes. Problems are collected, never thrown. */
function prepare(md: string, href: (slug: string) => string, app: string, problems: string[], page: string): string {
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
    .replace(/\]\(app:(\/[^)\s]*)\)/g, (_, path: string) => `](${app}${path === "/" ? "/" : path})`)
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
  html = html.replace(/<button class="dc-copy"[\s\S]*?<\/button>/g, "");
  // a section starts at a heading, a folded question or an API block
  const parts = html.split(/(?=<h[23] id="|<details class="dc-(?:acc|api)" id=")/);
  for (const part of parts) {
    const m = /^<h[23] id="([^"]+)">([\s\S]*?)<\/h[23]>/.exec(part) ?? /^<details class="dc-(?:acc|api)" id="([^"]+)"[^>]*><summary>([\s\S]*?)<\/summary>/.exec(part);
    const body = text(m ? part.slice(m[0].length) : part);
    if (!m && !body) continue;
    out.push({ p: title, h: m ? text(m[2]!) : "", u: m ? `${url}#${m[1]}` : url, x: body.slice(0, m && part.startsWith("<details") ? 400 : 1600) });
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
    `<a class="dc-card is-link dc-pathcard" href="${href(s.pages[0]!.slug)}"><span class="dc-card-tag">${s.pages.length} ${s.pages.length === 1 ? "step" : "steps"}</span><b class="dc-card-t">${esc(s.goal ?? s.title)}</b><span class="dc-card-b">${esc(s.blurb ?? "")}</span><span class="dc-pathcard-go">Start with ${esc(s.pages[0]!.title)}</span><span class="dc-card-go" aria-hidden="true"></span></a>`;
  return `<nav class="dc-cards dc-paths" data-cols="2" aria-label="Reader paths">${PATHS.map(card).join("")}</nav>`;
}

export interface DocsBuild {
  files: Map<string, DocsFile>;
  problems: string[];
  /** the hashed files under assets/, as paths from the site root */
  assets: { css: string; js: string; search: string };
  app: string;
}

const hashOf = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex").slice(0, 12);

/** Every file of the docs site plus the problems the checks found (broken links, anchors, generators, summaries). */
export async function buildDocsChecked(o: { app?: string } = {}): Promise<DocsBuild> {
  const base = ""; // the site is served at the root of its own origin
  const app = (o.app || defaultAppUrl()).replace(/\/+$/, ""); // where the app lives (links and live figures)
  if (!/^https?:\/\/[^/]+$/.test(app)) throw new Error(`the app origin must be http(s)://host with no path, got "${app}"`);
  const out = new Map<string, DocsFile>();
  const problems: string[] = [];
  const href = (slug: string) => (slug === "overview" ? "/" : `/${slug}`);
  // the scripts, styles and search index first: the pages name them by the hash of their content
  const js = await Bun.build({ entrypoints: [join(DOCS, "src/client.ts")], target: "browser", minify: true, sourcemap: "none" });
  if (!js.success) throw new Error(js.logs.map(String).join("\n"));
  const jsText = await js.outputs[0]!.text();
  const cssText = readFileSync(join(DOCS, "src/docs.css"), "utf8");
  const assets = { css: `/assets/docs.${hashOf(cssText)}.css`, js: `/assets/docs.${hashOf(jsText)}.js`, search: "" };
  const shotsFile = join(DOCS, "captured/shots.json");
  const shots: Record<string, Shot> = existsSync(shotsFile) ? (JSON.parse(readFileSync(shotsFile, "utf8")).shots ?? {}) : {};
  const docs = PAGES.map((p) => {
    const file = join(DOCS, "content", p.file);
    if (!existsSync(file)) problems.push(`${p.slug}: content file ${p.file} is missing`);
    return { ...p, md: prepare(existsSync(file) ? readFileSync(file, "utf8") : `# ${p.title}\n\n> This page is not written yet (TBA).\n`, href, app, problems, p.slug) };
  });
  const search: SearchEntry[] = [];
  const sectionOf = (slug: string) => SECTIONS.find((s) => s.pages.some((p) => p.slug === slug))!;
  const updated = pageDates().dates;
  // the side menu: every section with its groups. A wide screen shows the current tab's section; the
  // phone drawer shows them all, the other sections' groups folded.
  const nav = (cur: string) => {
    const here = sectionOf(cur);
    return SECTIONS.map(
      (s) =>
        `<div class="dc-nav-s${s === here ? " is-tab" : ""}"><div class="dc-nav-st">${esc(s.tab)}</div>${groupsOf(s)
          .map(
            (g) =>
              `<details class="dc-nav-g"${s === here ? " open" : ""}><summary>${esc(g.title)}</summary><div class="dc-nav-l">${g.pages
                .map((x) => `<a href="${href(x.slug)}"${x.slug === cur ? ` aria-current="page"` : ""}>${esc(x.title)}</a>`)
                .join("")}</div></details>`,
          )
          .join("")}</div>`,
    ).join("");
  };
  const tabs = (cur: string) => {
    const here = sectionOf(cur);
    return SECTIONS.map((s) => `<a class="dc-tabl" href="${href(s.pages[0]!.slug)}"${s === here ? ` aria-current="true"` : ""}>${esc(s.tab)}</a>`).join("");
  };
  // the parts every page shares: the head, the top bar, the search palette
  const head = (h: { title: string; description: string; path: string | null; kind: "website" | "article" }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(h.title)}</title>
<meta name="description" content="${esc(h.description)}">
${h.path === null ? `<meta name="robots" content="noindex">` : `<link rel="canonical" href="${DOCS_ORIGIN}${h.path}">`}
<meta property="og:site_name" content="${PRODUCT} docs">
<meta property="og:type" content="${h.kind}">
<meta property="og:title" content="${esc(h.title)}">
<meta property="og:description" content="${esc(h.description)}">
<meta property="og:url" content="${DOCS_ORIGIN}${h.path ?? "/"}">
<meta property="og:image" content="${DOCS_ORIGIN}/logo.png">
<meta name="twitter:card" content="summary">
<link rel="icon" href="/favicon.png" type="image/png">
<meta name="theme-color" content="#f8f8f8">
${FONTS.map((f) => `<link rel="preload" href="/fonts/${f}" as="font" type="font/woff2" crossorigin>`).join("\n")}
<link rel="stylesheet" href="${assets.css}">
</head>
<body data-app="${esc(app)}" data-search="@@SEARCH@@">
<a class="dc-skip" href="#main">Skip to the content</a>`;
  const top = (cur: string | null) => `<header class="dc-top">
  <div class="dc-bar">
    <button class="dc-iconb dc-menu-b" id="dc-menu" type="button" aria-label="Open the page menu" aria-expanded="false" aria-controls="dc-side">${I.menu}</button>
    <a class="dc-brand" href="${href("overview")}" aria-label="${PRODUCT} docs, start page">${LOGO(base)}<span class="dc-brand-n">${PRODUCT}</span><span class="dc-brand-d">Docs</span></a>
    <button class="dc-search-b" id="dc-search-open" type="button" aria-haspopup="dialog" aria-controls="dc-palette">${I.search}<span class="dc-search-t">Search the docs</span><kbd class="dc-k" id="dc-k">Ctrl K</kbd></button>
    <nav class="dc-links" aria-label="Site">
      <a href="${app}/">Explorer</a>
      <a href="${REPO_URL}" target="_blank" rel="noopener">GitHub${I.out}</a>
      <a class="dc-cta" href="${app}/launch">Launch</a>
    </nav>
  </div>
  <nav class="dc-tabsbar" aria-label="Sections"><div class="dc-tabsbar-in">${cur === null ? tabs("overview").replace(' aria-current="true"', "") : tabs(cur)}</div></nav>
</header>`;
  const side = (cur: string | null) => `<aside class="dc-side" id="dc-side" aria-label="Docs pages">
    <div class="dc-side-h"><span>Pages</span><button class="dc-iconb" id="dc-menu-x" type="button" aria-label="Close the page menu">${I.close}</button></div>
    <nav class="dc-nav" aria-label="Docs pages">${cur === null ? nav("overview").replace(' aria-current="page"', "") : nav(cur)}</nav>
    <div class="dc-side-f"><a href="${app}/">Explorer</a><a href="${REPO_URL}" target="_blank" rel="noopener">GitHub</a><a href="${app}/launch">Launch an agent</a></div>
  </aside>
  <div class="dc-scrim" id="dc-scrim" hidden></div>`;
  const tail = `<dialog class="dc-palette" id="dc-palette" aria-label="Search the docs">
  <div class="dc-search" role="search"><label class="dc-sr" for="dc-q">Search the docs</label><span class="dc-si">${I.search}</span><input id="dc-q" type="search" placeholder="Search the docs" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false" aria-controls="dc-res" aria-autocomplete="list"><button class="dc-k dc-esc" type="button" id="dc-palette-x" aria-label="Close the search">Esc</button></div>
  <div class="dc-res" id="dc-res" role="listbox" aria-label="Results"></div>
  <div class="dc-palette-f"><span><kbd class="dc-k">Up</kbd><kbd class="dc-k">Down</kbd> to move</span><span><kbd class="dc-k">Enter</kbd> to open</span></div>
</dialog>
<script type="module" src="${assets.js}"></script>
</body>
</html>
`;
  // {{fig:paths}} on Start here, and {{fig:path-<section id>}}: the pages of one path as cards, each with
  // the first sentence of its own summary
  const firstSentence = (md: string) => {
    const quote = /^> (.*)$/m.exec(md)?.[1] ?? "";
    return (/^(.*?[.!?])(?=\s|$)/.exec(quote.replace(/\b(\d)\.(\d)/g, "$1\u0001$2"))?.[1] ?? quote).replace(/\u0001/g, ".").replace(/\[([^\]]+)\]\([^)\s]+\)/g, "$1");
  };
  const figures: Record<string, string> = { paths: pathCards(href) };
  for (const s of SECTIONS)
    figures[`path-${s.id}`] = `<nav class="dc-cards" data-cols="2" aria-label="${esc(s.title)}: the pages of this path">${s.pages
      .map((x, k) => {
        const md = docs.find((y) => y.slug === x.slug)!.md;
        return `<a class="dc-card is-link" href="${href(x.slug)}">${s.kind === "path" ? `<span class="dc-card-tag">Step ${k + 1}</span>` : ""}<b class="dc-card-t">${esc(x.title)}</b><span class="dc-card-b">${inlineMd(firstSentence(md), () => null, { base }).replace(/<a [^>]*>|<\/a>/g, "")}</span><span class="dc-card-go" aria-hidden="true"></span></a>`;
      })
      .join("")}</nav>`;
  for (const [i, d] of docs.entries()) {
    const missing: string[] = [];
    const r = renderMarkdown(d.md, () => null, { base, shots, figures, missing });
    for (const m of missing) problems.push(`${d.slug}: missing ${m}`);
    if (/(^|>|\s):{3,}([a-z]|<|\s|$)/m.test(r.html.replace(/<pre[\s\S]*?<\/pre>/g, ""))) problems.push(`${d.slug}: a component's colons are left in the page (an unclosed or misnested container)`);
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
        ? `<div class="dc-eyebrow dc-step"><a href="${href(sec.pages[0]!.slug)}">${esc(sec.title)}</a><span>step ${at + 1} of ${sec.pages.length}</span></div>`
        : `<div class="dc-eyebrow">${esc(sec.title)}</div>`;
    const pagerLink = (p: DocPage, dir: "Previous" | "Next") => {
      const c = cross(p);
      return `<a${dir === "Next" ? ' class="next"' : ""} href="${href(p.slug)}" rel="${dir === "Next" ? "next" : "prev"}"><span>${dir}${c ? ` (${esc(c)})` : ""}</span>${esc(p.title)}</a>`;
    };
    const tocLinks = r.toc.map((t) => `<a href="#${t.id}" data-lv="${t.level}">${esc(t.text)}</a>`).join("");
    const hasToc = r.toc.filter((t) => t.level === 2).length >= 2 || r.toc.length >= 4;
    const day = updated[d.file];
    const html = `${head({ title, description: text(r.summary).replace(/ ([,.;:])/g, "$1").slice(0, 300) || `${r.title || d.title}: ${PRODUCT} documentation.`, path: href(d.slug), kind: d.slug === "overview" ? "website" : "article" })}
${top(d.slug)}
<div class="dc-shell${hasToc ? "" : " no-toc"}">
  ${side(d.slug)}
  <main class="dc-main" id="main"><article class="dc-article">
    <header class="dc-head">
      ${eyebrow}
      <h1 class="dc-h1">${esc(r.title || d.title)}</h1>
      ${r.summary ? `<p class="dc-lead">${r.summary}</p>` : ""}
    </header>
    ${hasToc ? `<details class="dc-toc-m"><summary>${I.list}<span>On this page</span></summary><nav aria-label="On this page">${tocLinks}</nav></details>` : ""}
    <div class="dc-prose">${r.html}</div>
    <div class="dc-meta">${day ? `<span>Last updated <time datetime="${day}">${day}</time></span>` : "<span></span>"}<a href="${REPO_URL}/edit/main/apps/docs/content/${d.file}" target="_blank" rel="noopener">${I.edit}Edit this page</a></div>
    <nav class="dc-pager" aria-label="Previous and next page">${prev ? pagerLink(prev, "Previous") : "<span></span>"}${next ? pagerLink(next, "Next") : ""}</nav>
    <p class="dc-foot">Written from the specification (<a class="dc-a" href="${REPO_URL}/blob/main/docs/SPEC.md" target="_blank" rel="noopener">docs/SPEC.md</a>) and the code. Highlighted figures are read live from Core or the market indexer when the page loads; TBA means a figure could not be read or is not decided. Examples, command output and screenshots are captured from the devnet site and dated where they appear. Parameter values are test values; launch values are TBA.</p>
  </article></main>
  ${hasToc ? `<aside class="dc-toc" aria-label="On this page"><nav class="dc-toc-n" id="dc-toc" aria-label="On this page"><div class="dc-toc-h">${I.list}On this page</div>${tocLinks}</nav></aside>` : ""}
</div>
${tail}`;
    out.set(d.slug === "overview" ? "index.html" : `${d.slug}.html`, { body: html, type: "text/html; charset=utf-8" });
  }
  // the page an unknown path gets (the host answers it with status 404)
  out.set("404.html", {
    body: `${head({ title: `Page not found | ${PRODUCT} docs`, description: `This page does not exist in the ${PRODUCT} docs.`, path: null, kind: "website" })}
${top(null)}
<div class="dc-shell no-toc">
  ${side(null)}
  <main class="dc-main" id="main"><article class="dc-article">
    <header class="dc-head">
      <div class="dc-eyebrow">404</div>
      <h1 class="dc-h1">Page not found</h1>
      <p class="dc-lead">There is no docs page at this address. It may have moved: search the docs, or start from one of the sections below.</p>
    </header>
    <div class="dc-prose"><nav class="dc-cards" data-cols="2" aria-label="Sections">${SECTIONS.map((s) => `<a class="dc-card is-link" href="${href(s.pages[0]!.slug)}"><b class="dc-card-t">${esc(s.goal ?? s.title)}</b><span class="dc-card-b">${esc(s.pages[0]!.title)}</span><span class="dc-card-go" aria-hidden="true"></span></a>`).join("")}</nav></div>
  </article></main>
</div>
${tail}`,
    type: "text/html; charset=utf-8",
  });
  const searchText = JSON.stringify(search);
  assets.search = `/assets/search.${hashOf(searchText)}.json`;
  for (const [p, f] of out) if (p.endsWith(".html")) f.body = String(f.body).replace("@@SEARCH@@", assets.search);
  out.set(assets.js.slice(1), { body: jsText, type: "text/javascript; charset=utf-8" });
  out.set(assets.search.slice(1), { body: searchText, type: "application/json; charset=utf-8" });
  out.set(assets.css.slice(1), { body: cssText, type: "text/css; charset=utf-8" });
  // for crawlers: every page under the canonical origin, with the day it last changed
  out.set("sitemap.xml", {
    body: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${docs.map((d) => `  <url><loc>${DOCS_ORIGIN}${href(d.slug)}</loc>${updated[d.file] ? `<lastmod>${updated[d.file]}</lastmod>` : ""}</url>`).join("\n")}\n</urlset>\n`,
    type: "application/xml; charset=utf-8",
  });
  out.set("robots.txt", { body: `User-agent: *\nAllow: /\nSitemap: ${DOCS_ORIGIN}/sitemap.xml\n`, type: "text/plain; charset=utf-8" });
  out.set("vercel.json", { body: JSON.stringify(vercelConfig(app), null, 2) + "\n", type: "application/json; charset=utf-8" });
  out.set("favicon.png", { body: readFileSync(join(WEB, "public/favicon.png")), type: "image/png" });
  out.set("logo.png", { body: readFileSync(join(WEB, "public/logo.png")), type: "image/png" });
  for (const f of FONTS) out.set(`fonts/${f}`, { body: new Uint8Array(readFileSync(join(WEB, "public/fonts", f))), type: "font/woff2" });
  // the docs' own static files (screenshots) and the licensed provider marks the models page shows
  for (const f of walk(join(DOCS, "public"))) out.set(f, { body: new Uint8Array(readFileSync(join(DOCS, "public", f))), type: TYPES[f.split(".").pop()!.toLowerCase()] ?? "application/octet-stream" });
  for (const f of walk(join(WEB, "public/providers"))) out.set(`providers/${f}`, { body: new Uint8Array(readFileSync(join(WEB, "public/providers", f))), type: TYPES[f.split(".").pop()!.toLowerCase()] ?? "text/plain; charset=utf-8" });
  for (const d of ["assets", "fonts", "shots", "providers"]) if (PAGES.some((p) => p.slug === d)) problems.push(`${d}: a page cannot be named like a directory of the output`);
  problems.push(...checkDocs(out, base));
  return { files: out, problems, assets, app };
}

/** Every file of the docs site, keyed by its path under the base ("index.html", "verification.html", "assets/docs.js", ...). */
export async function buildDocs(o: { app?: string } = {}): Promise<Map<string, DocsFile>> {
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
  const app = arg("app", defaultAppUrl());
  if (process.argv.includes("--print-csp")) {
    console.log(docsCsp(app));
    process.exit(0);
  }
  const out = arg("out", join(DOCS, "dist"));
  const { files, problems } = await buildDocsChecked({ app });
  rmSync(out, { recursive: true, force: true });
  for (const [p, f] of files) {
    mkdirSync(dirname(join(out, p)), { recursive: true });
    writeFileSync(join(out, p), f.body);
  }
  // the dates of the last change, for builds that have no git history (a shallow clone on a static host)
  const d = pageDates();
  if (d.fromGit) {
    const pages = Object.fromEntries(PAGES.map((p) => [p.file, d.dates[p.file] ?? ""]).filter(([, v]) => v));
    const next = JSON.stringify({ note: "The day each docs page last changed (git); written by bun scripts/docs/build.ts, read where the build has no git history.", pages }, null, 2) + "\n";
    if (!existsSync(UPDATED_FILE) || readFileSync(UPDATED_FILE, "utf8") !== next) writeFileSync(UPDATED_FILE, next);
  }
  // the Vercel project file names the app origin in its page policy: kept equal to config/sites.json
  // (not rewritten for a one-off --app or UNITS_APP_URL build)
  const project = vercelProjectJson(sites.app_url.replace(/\/+$/, ""));
  if (!existsSync(VERCEL_FILE) || readFileSync(VERCEL_FILE, "utf8") !== project) {
    writeFileSync(VERCEL_FILE, project);
    console.log("rewrote apps/docs/vercel.json (commit it)");
  }
  console.log(`built ${files.size} files (${PAGES.length} pages) into ${out} for ${DOCS_ORIGIN}, app ${app}`);
  if (problems.length) {
    console.error(`${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
}
