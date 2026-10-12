#!/usr/bin/env bun
// Exports what the docs site shows of this repository into a checkout of the docs repository.
//
// The docs are a repository of their own (https://github.com/plsdontcallmyfone/units-docs, served at
// https://docs.units.gg): content, renderer, styles, build, tests and deploy all live there, and it
// builds with no access to this repository. The few things on its pages that are facts of this
// repository's code and config are written by this script as data files into its `generated/`
// directory, each with a header naming this script and the commit it was generated from:
//
//   core-api.json     every Core route of packages/core/src/http.ts (method, path, access, query
//                     parameters), described from packages/core/README.md (bodies and response shapes),
//                     docs/SPEC.md (purposes) and scripts/docs/api-notes.ts (the rest)
//   indexer-api.json  the market indexer's routes (scripts/docs/api-notes.ts INDEXER_ROUTES, checked
//                     against the dispatcher in packages/indexer/src/api.ts)
//   networks.json     program ids and the public network profile fields, from config/profile.json
//   models.json       the model registry seed, from config/models.json
//   changelog.json    the specification's changelog, newest first, from docs/SPEC.md
//   repo-paths.json   every file or directory of this repository a docs page links to with
//                     [text](repo:path), and whether it is a file or a directory (the docs build
//                     refuses a repo: link that is not in this list)
//   updated.json      the day each docs page last changed while the pages lived in this repository
//                     (apps/docs/content, from git history); the docs repository's own history takes
//                     over from there
//
//   bun scripts/docs/export.ts [<docs checkout>]      default ~/units-docs
//   bun scripts/docs/export.ts --check [<docs checkout>]   write nothing; exit 1 if a file would change
//
// A file is rewritten only when its data changed, so its commit names the last commit that changed
// what the docs show (a file written from uncommitted sources says "<commit>-dirty" and is written
// again by the first export after they are committed). Exits 1 (after writing the rest) when a Core route has no description anywhere,
// a note names a route that no longer exists, the indexer list differs from its dispatcher, or a docs
// page links to a path that is not in this repository. After an export: in the docs checkout run
// `bun test` and `bun scripts/build.ts`, commit `generated/`, and deploy from there.
//
// A lane that adds a Core route adds its line to scripts/docs/api-notes.ts (unless the README or a
// SPEC route table already describes it): scripts/docs/export.test.ts fails on an undescribed route.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { API_NOTES, INDEXER_ROUTES } from "./api-notes.ts";

const ROOT = join(import.meta.dir, "../..");
export const MONOREPO_URL = "https://github.com/plsdontcallmyfone/lineage";
export const DOCS_REPO_URL = "https://github.com/plsdontcallmyfone/units-docs";

export interface CoreRoute {
  method: string;
  path: string;
  auth: "none" | "optional" | "agent" | "admin" | "runtime";
  query: string[];
}

/** Every route of Core's router, in the order http.ts declares them. */
export function coreRoutes(root: string): CoreRoute[] {
  const src = readFileSync(join(root, "packages/core/src/http.ts"), "utf8");
  const re = /route\("(GET|POST|PUT|DELETE)",\s*"([^"]+)",\s*"(none|optional|agent|admin|runtime)"/g;
  const hits = [...src.matchAll(re)];
  return hits.map((m, i) => {
    const end = i + 1 < hits.length ? hits[i + 1]!.index! : src.indexOf("];", m.index!);
    const body = src.slice(m.index!, end);
    const query = new Set<string>();
    for (const q of body.matchAll(/\b(?:q|int)\(c,\s*"([a-z_]+)"\)/g)) query.add(q[1]!);
    if (/withHidden\(c\)|unlisted\(c\)/.test(body)) query.add("hidden");
    if (/searchParams\.get\("([a-z_]+)"\)/.test(body)) for (const q of body.matchAll(/searchParams\.get\("([a-z_]+)"\)/g)) query.add(q[1]!);
    return { method: m[1]!, path: m[2]!, auth: m[3] as CoreRoute["auth"], query: [...query] };
  });
}

/** "GET /v1/agents/:id/soul" with every path parameter name replaced, so README and SPEC spellings match. */
export const routeKey = (method: string, path: string) => `${method} ${path.replace(/\?.*$/, "").replace(/:[a-z_0-9]+/gi, ":_").replace(/\/+$/, "")}`;

const cells = (line: string) =>
  line.trim().replace(/^\||\|$/g, "").replace(/\\\|/g, "\u0001").split("|").map((c) => c.trim().replace(/\u0001/g, " or "));

/** `METHOD path` codes in a table cell (several per cell in the SPEC and README tables). */
function codes(cell: string): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = [];
  let last = "";
  for (const m of cell.matchAll(/`([^`]+)`/g)) {
    const t = m[1]!.trim().replace(/\s+/g, " ");
    const mm = /^(GET|POST|PUT|DELETE) (\/\S+)$/.exec(t);
    if (mm) {
      last = mm[1]!;
      out.push({ method: mm[1]!, path: mm[2]! });
    } else if (last && /^\/v1\//.test(t)) out.push({ method: last, path: t });
  }
  return out;
}

/** README rows: body and response per route. */
function readmeRows(root: string): Map<string, { body: string | null; response: string }> {
  const md = readFileSync(join(root, "packages/core/README.md"), "utf8");
  const out = new Map<string, { body: string | null; response: string }>();
  let cols = 0;
  for (const line of md.split("\n")) {
    if (!line.startsWith("|")) {
      cols = 0;
      continue;
    }
    const c = cells(line);
    if (/^Method and path$/i.test(c[0] ?? "")) {
      cols = c.length;
      continue;
    }
    if (!cols || c.every((x) => /^:?-+:?$/.test(x))) continue;
    for (const k of codes(c[0]!)) {
      const key = routeKey(k.method, k.path);
      if (out.has(key)) continue;
      out.set(key, cols >= 3 ? { body: c[1] || null, response: c[2] ?? "" } : { body: null, response: c[1] ?? "" });
    }
  }
  return out;
}

/** SPEC rows: purpose per route (section 17 and every other `| METHOD path | purpose |` table). */
function specRows(root: string): Map<string, string> {
  const md = readFileSync(join(root, "docs/SPEC.md"), "utf8");
  const out = new Map<string, string>();
  for (const line of md.split("\n")) {
    if (!line.startsWith("| `")) continue;
    const c = cells(line);
    if (c.length !== 2) continue;
    for (const k of codes(c[0]!)) {
      const key = routeKey(k.method, k.path);
      if (!out.has(key)) out.set(key, c[1]!);
    }
  }
  return out;
}

/** The /v1/units spelling of a /v1/lineages route (same handler), or null. */
export function unitAlias(path: string): string | null {
  if (path === "/v1/lineages" || path.startsWith("/v1/lineages/")) return "/v1/units" + path.slice("/v1/lineages".length);
  if (path.startsWith("/v1/admin/lineages/")) return "/v1/admin/units/" + path.slice("/v1/admin/lineages/".length);
  return null;
}

export interface CoreApiRoute extends CoreRoute {
  /** the /v1/units spelling the docs show first (packages/core/src/unit-alias.ts), or null */
  alias: string | null;
  /** what the route is for (api-notes.ts, else a SPEC route table), or null */
  purpose: string | null;
  /** the README row of the route: its body (null for a route without one) and its response, or null */
  readme: { body: string | null; response: string } | null;
}

/** Every Core route with its description, and the routes that have none anywhere. */
export function coreApiData(root: string): { routes: CoreApiRoute[]; undescribed: string[]; stale_notes: string[] } {
  const routes = coreRoutes(root);
  const readme = readmeRows(root);
  const spec = specRows(root);
  const undescribed: string[] = [];
  const out = routes.map((r): CoreApiRoute => {
    const key = routeKey(r.method, r.path);
    const purpose = API_NOTES[key] ?? spec.get(key) ?? null;
    const rd = readme.get(key) ?? null;
    if (!purpose && !rd) undescribed.push(key);
    return { ...r, alias: unitAlias(r.path), purpose, readme: rd };
  });
  const keys = new Set(routes.map((r) => routeKey(r.method, r.path)));
  return { routes: out, undescribed, stale_notes: Object.keys(API_NOTES).filter((k) => !keys.has(k)) };
}

/** The indexer's route names as its dispatcher spells them (parts[1] === "x", case "x"). */
export function indexerRouteNames(root: string): string[] {
  const src = readFileSync(join(root, "packages/indexer/src/api.ts"), "utf8");
  const top = [...src.matchAll(/parts\[1\] === "([a-z]+)"/g)].map((m) => m[1]!);
  const sub = [...src.matchAll(/case "([a-z]+)":/g)].map((m) => m[1]!);
  return [...new Set([...top.map((t) => `/market/${t}`), ...sub.map((s) => `/market/tokens/:mint/${s}`)])];
}

/** Where the documented indexer routes and the dispatcher disagree. */
export function indexerProblems(root: string): string[] {
  const code = indexerRouteNames(root);
  const documented = INDEXER_ROUTES.map((r) => r.path);
  return [
    ...code.filter((c) => !documented.includes(c)).map((c) => `indexer route ${c} is not in INDEXER_ROUTES (scripts/docs/api-notes.ts)`),
    ...documented.filter((d) => d !== "/market/tokens" && d !== "/market/tokens/:mint" && !code.includes(d)).map((d) => `INDEXER_ROUTES names ${d}, which the indexer does not serve`),
  ];
}

const pick = (o: Record<string, unknown>, keys: string[]): Record<string, any> => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));

/** Program ids and the public fields of each network profile (config/profile.json). Only what the docs show. */
export function networksData(root: string) {
  const p = JSON.parse(readFileSync(join(root, "config/profile.json"), "utf8")) as { network: string; profiles: Record<string, Record<string, any>> };
  return {
    network: p.network,
    profiles: Object.fromEntries(
      Object.entries(p.profiles).map(([name, x]) => [
        name,
        {
          cluster: x.cluster,
          genesis: x.genesis,
          explorer_cluster: x.explorer_cluster ?? null,
          programs: pick(x.programs, ["registry", "launch", "msg"]),
          quote: pick(x.quote, ["source", "symbol", "status", "mint", "line_mint"]),
          faucet: !!x.faucet,
          test_labels: !!x.test_labels,
          swap: !!x.swap,
          usd_feed: x.usd_feed ?? null,
          fees: pick(x.fees, ["mode", "cu_price_micro_lamports", "percentile", "cap_micro_lamports"]),
        },
      ]),
    ),
  };
}

/** The model registry seed (config/models.json). Only what the docs show. */
export function modelsData(root: string) {
  const reg = JSON.parse(readFileSync(join(root, "config/models.json"), "utf8")) as {
    default: { provider: string; id: string };
    routing: { openrouter: { funding_fee_bps: number; read_on: string } };
    providers: Record<string, unknown>[];
    models: Record<string, any>[];
  };
  return {
    default: pick(reg.default, ["provider", "id"]),
    routing: { openrouter: pick(reg.routing.openrouter, ["funding_fee_bps", "read_on"]) },
    providers: reg.providers.map((p) => pick(p, ["id", "name", "pricing_url", "read_on"])),
    models: reg.models.map((m): Record<string, any> => ({
      ...pick(m, ["id", "provider", "name", "status", "enabled", "note"]),
      rate: m.rate ?? null,
      peak: !!m.peak,
      tiers: !!m.tiers,
      openrouter_rate: m.routes?.openrouter?.rate ?? null,
    })),
  };
}

/** The specification's changelog (docs/SPEC.md "## Changelog"), newest version first. */
export function changelogData(root: string): { entries: { version: string; date: string; text: string }[] } {
  const md = readFileSync(join(root, "docs/SPEC.md"), "utf8");
  const lines = md.slice(md.indexOf("\n## Changelog")).split("\n").filter((l) => /^- \d/.test(l));
  const ver = (l: string) => (/^- ([\d.]+)/.exec(l)?.[1] ?? "0").split(".").map(Number);
  const cmp = (a: number[], b: number[]) => {
    for (let k = 0; k < Math.max(a.length, b.length); k++) if ((a[k] ?? 0) !== (b[k] ?? 0)) return (b[k] ?? 0) - (a[k] ?? 0);
    return 0;
  };
  const entries: { version: string; date: string; text: string }[] = [];
  for (const l of [...lines].sort((a, b) => cmp(ver(a), ver(b)))) {
    const m = /^- ([\d.]+) \(([^)]*)\):\s*(.*)$/.exec(l);
    if (m) entries.push({ version: m[1]!, date: m[2]!, text: m[3]! });
  }
  return { entries };
}

const git = (root: string, ...a: string[]) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });

/**
 * The day each docs page last changed while the pages lived in this repository (apps/docs/content,
 * removed when the docs became a repository of their own; the removal itself is not a change).
 */
export function updatedData(root: string, docs?: string): { pages: Record<string, string> } {
  const kept = docs && existsSync(join(docs, "content")) ? new Set(readdirSync(join(docs, "content"))) : null; // pages the docs still have
  const pages: Record<string, string> = {};
  let day = "";
  for (const l of git(root, "log", "--diff-filter=d", "--format=@%cs", "--name-only", "--", "apps/docs/content").split("\n")) {
    if (l.startsWith("@")) day = l.slice(1);
    else if (l.endsWith(".md") && (!kept || kept.has(l.split("/").pop()!))) pages[l.split("/").pop()!] ??= day;
  }
  return { pages: Object.fromEntries(Object.entries(pages).sort(([a], [b]) => a.localeCompare(b))) };
}

/** Every repo: link of the docs checkout (content and the renderer's own generated text), checked against this repository. */
export function repoPathsData(root: string, docs: string): { paths: Record<string, "file" | "dir">; missing: string[] } {
  const found = new Set<string>();
  for (const dir of ["content", "src"]) {
    if (!existsSync(join(docs, dir))) continue;
    for (const f of readdirSync(join(docs, dir))) {
      if (!/\.(md|ts)$/.test(f)) continue;
      for (const m of readFileSync(join(docs, dir, f), "utf8").matchAll(/\]\(repo:([^)\s#]+)(?:#[^)\s]*)?\)/g)) found.add(m[1]!);
    }
  }
  const paths: Record<string, "file" | "dir"> = {};
  const missing: string[] = [];
  for (const p of [...found].sort()) {
    if (!existsSync(join(root, p))) missing.push(p);
    else paths[p] = statSync(join(root, p)).isDirectory() ? "dir" : "file";
  }
  return { paths, missing };
}

export interface ExportFile {
  /** the monorepo files the data is read from */
  sources: string[];
  data: Record<string, unknown>;
}

/** Every generated data file by name, and what stops the export from being complete. */
export function exportData(root: string, docs: string): { files: Record<string, ExportFile>; problems: string[] } {
  const problems: string[] = [];
  const api = coreApiData(root);
  for (const k of api.undescribed) problems.push(`Core route ${k} has no description (add a line to scripts/docs/api-notes.ts)`);
  for (const k of api.stale_notes) problems.push(`scripts/docs/api-notes.ts describes ${k}, which is not a route of packages/core/src/http.ts`);
  problems.push(...indexerProblems(root));
  const repo = repoPathsData(root, docs);
  for (const p of repo.missing) problems.push(`a docs page links to repo:${p}, which is not in this repository`);
  return {
    problems,
    files: {
      "core-api.json": { sources: ["packages/core/src/http.ts", "packages/core/README.md", "docs/SPEC.md", "scripts/docs/api-notes.ts"], data: { route_count: api.routes.length, routes: api.routes } },
      "indexer-api.json": { sources: ["scripts/docs/api-notes.ts", "packages/indexer/src/api.ts"], data: { routes: INDEXER_ROUTES } },
      "networks.json": { sources: ["config/profile.json"], data: networksData(root) },
      "models.json": { sources: ["config/models.json"], data: modelsData(root) },
      "changelog.json": { sources: ["docs/SPEC.md"], data: changelogData(root) },
      "repo-paths.json": { sources: ["the docs checkout's repo: links, checked against this repository's tree"], data: { repo_url: MONOREPO_URL, paths: repo.paths } },
      "updated.json": { sources: ["git history of apps/docs/content"], data: updatedData(root, docs) },
    },
  };
}

const HEADER = `Generated by scripts/docs/export.ts of the units monorepo (${MONOREPO_URL}). Do not edit by hand: change the source there and run the export again.`;

/** The commit the export runs at; "-dirty" when one of the sources has uncommitted changes. */
export function sourceCommit(root: string, sources: string[]): string {
  const sha = git(root, "rev-parse", "HEAD").trim();
  const tracked = sources.filter((s) => existsSync(join(root, s)));
  const dirty = tracked.length ? git(root, "status", "--porcelain", "--", ...tracked).trim() : "";
  return dirty ? `${sha}-dirty` : sha;
}

/** The text of one generated file: the header (what wrote it, from which commit and sources), then the data. */
export const fileText = (f: ExportFile, commit: string) => JSON.stringify({ _generated: HEADER, _source_commit: commit, _sources: f.sources, ...f.data }, null, 2) + "\n";

/** The data of a generated file as stored, without its header. */
const storedData = (text: string): string => {
  const { _generated, _source_commit, _sources, ...data } = JSON.parse(text);
  return JSON.stringify(data);
};

/** Write (or with check: compare) the generated files of a docs checkout. A file whose data is unchanged keeps its commit. */
export function writeExport(root: string, docs: string, o: { check?: boolean } = {}): { changed: string[]; problems: string[] } {
  const dir = join(docs, "generated");
  const { files, problems } = exportData(root, docs);
  const changed: string[] = [];
  if (!o.check) mkdirSync(dir, { recursive: true });
  for (const [name, f] of Object.entries(files)) {
    const path = join(dir, name);
    if (existsSync(path)) {
      try {
        const stored = readFileSync(path, "utf8");
        // same data: the file keeps its commit, unless it was written from uncommitted sources that are committed now
        const settle = /"_source_commit": "[0-9a-f]+-dirty"/.test(stored) && !sourceCommit(root, f.sources).endsWith("-dirty");
        if (!settle && storedData(stored) === JSON.stringify(JSON.parse(JSON.stringify(f.data)))) continue;
      } catch {
        /* unreadable: written again */
      }
    }
    changed.push(name);
    if (!o.check) writeFileSync(path, fileText(f, sourceCommit(root, f.sources)));
  }
  return { changed, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const docs = args.find((a) => !a.startsWith("--")) ?? join(homedir(), "units-docs");
  if (!existsSync(join(docs, "content")) || !existsSync(join(docs, "scripts/build.ts"))) {
    console.error(`${docs} is not a checkout of the docs repository (${DOCS_REPO_URL}): no content/ or scripts/build.ts`);
    process.exit(2);
  }
  const { changed, problems } = writeExport(ROOT, docs, { check });
  console.log(changed.length ? `${check ? "would change" : "wrote"} ${changed.map((c) => `generated/${c}`).join(", ")} in ${docs}` : `generated/ in ${docs} is up to date`);
  if (problems.length) console.error(`${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  if (problems.length || (check && changed.length)) process.exit(1);
  if (changed.length) console.log(`next, in ${docs}: bun test && bun scripts/build.ts, commit generated/, then scripts/deploy.sh <host>`);
}
