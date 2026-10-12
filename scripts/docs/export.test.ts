import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_NOTES, INDEXER_ROUTES } from "./api-notes.ts";
import { trim } from "./capture.ts";
import { changelogData, coreApiData, coreRoutes, exportData, indexerProblems, indexerRouteNames, modelsData, networksData, routeKey, unitAlias, updatedData, writeExport } from "./export.ts";

// The docs are a repository of their own (https://github.com/plsdontcallmyfone/units-docs). What they
// show of this repository's code is exported by scripts/docs/export.ts; these tests keep that export
// complete, so a route cannot be added here without the docs learning of it.
const root = join(import.meta.dir, "../..");

/** A stand-in docs checkout: one page with links into this repository. */
function docsCheckout(md: string): string {
  const dir = mkdtempSync(join(tmpdir(), "units-docs-export-"));
  mkdirSync(join(dir, "content"));
  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, "content/overview.md"), md);
  writeFileSync(join(dir, "scripts/build.ts"), "");
  return dir;
}

test("every Core route in http.ts has a description, and every note names a real route", () => {
  const api = coreApiData(root);
  expect(api.undescribed).toEqual([]);
  expect(api.stale_notes).toEqual([]);
  const routes = coreRoutes(root);
  expect(routes.length).toBeGreaterThan(100);
  expect(api.routes.map((r) => routeKey(r.method, r.path))).toEqual(routes.map((r) => routeKey(r.method, r.path)));
  for (const r of api.routes) expect(r.purpose !== null || r.readme !== null, `${r.method} ${r.path}`).toBe(true);
  expect(Object.keys(API_NOTES).length).toBeGreaterThan(0);
});

test("every /v1/lineages route is exported with its /v1/units spelling", () => {
  const old = coreApiData(root).routes.filter((r) => r.path.startsWith("/v1/lineages"));
  expect(old.length).toBeGreaterThan(0);
  for (const r of old) expect(r.alias).toBe("/v1/units" + r.path.slice("/v1/lineages".length));
  expect(unitAlias("/v1/admin/lineages/x")).toBe("/v1/admin/units/x");
  expect(unitAlias("/v1/agents")).toBeNull();
});

test("the indexer list is exactly what the indexer serves", () => {
  expect(indexerProblems(root)).toEqual([]);
  const code = indexerRouteNames(root);
  const documented = INDEXER_ROUTES.map((r) => r.path);
  for (const c of code) expect(documented).toContain(c);
});

test("networks, models and changelog carry what the docs show and nothing keyed", () => {
  const n = networksData(root);
  expect(Object.keys(n.profiles)).toContain(n.network);
  for (const p of Object.values(n.profiles)) {
    expect(Object.keys(p.programs).sort()).toEqual(["launch", "msg", "registry"]);
    expect(Object.keys(p).sort()).toEqual(["cluster", "explorer_cluster", "faucet", "fees", "genesis", "programs", "quote", "swap", "test_labels", "usd_feed"]);
  }
  const m = modelsData(root);
  expect(m.models.length).toBeGreaterThan(0);
  expect(m.models.some((x) => x.id === m.default.id)).toBe(true);
  for (const x of m.models) expect(m.providers.some((p) => p.id === x.provider), x.id as string).toBe(true);
  const c = changelogData(root).entries;
  expect(c.length).toBeGreaterThan(10);
  const num = (v: string) => v.split(".").map(Number);
  for (let i = 1; i < c.length; i++) {
    const [a, b] = [num(c[i - 1]!.version), num(c[i]!.version)];
    expect(a[0]! > b[0]! || (a[0] === b[0] && (a[1] ?? 0) >= (b[1] ?? 0)), `${c[i - 1]!.version} before ${c[i]!.version}`).toBe(true);
  }
  // nothing that could hold a key or a private endpoint leaves the repository
  const text = JSON.stringify([n, m]);
  expect(text).not.toMatch(/api[-_]?key|secret|token=|rpc_url|helius|quiknode|alchemy/i);
});

test("page dates come from the history of apps/docs/content, the removal left out", () => {
  const all = updatedData(root).pages;
  expect(Object.keys(all).length).toBeGreaterThan(30);
  for (const d of Object.values(all)) expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(all["overview.md"]).toBeTruthy();
});

test("the export writes every file with its header, keeps an unchanged file, and reports a link to a missing path", () => {
  const docs = docsCheckout("# T\n\n> S.\n\n[spec](repo:docs/SPEC.md) [core](repo:packages/core) [gone](repo:no/such/file.ts)\n");
  try {
    const first = writeExport(root, docs);
    expect(first.changed.sort()).toEqual(["changelog.json", "core-api.json", "indexer-api.json", "models.json", "networks.json", "repo-paths.json", "updated.json"]);
    expect(first.problems).toEqual(["a docs page links to repo:no/such/file.ts, which is not in this repository"]);
    for (const f of readdirSync(join(docs, "generated"))) {
      const j = JSON.parse(readFileSync(join(docs, "generated", f), "utf8"));
      expect(Object.keys(j).slice(0, 3)).toEqual(["_generated", "_source_commit", "_sources"]);
      expect(j._generated).toContain("scripts/docs/export.ts");
      expect(j._source_commit).toMatch(/^[0-9a-f]{40}(-dirty)?$/);
      expect(readFileSync(join(docs, "generated", f), "utf8")).not.toContain(String.fromCharCode(0x2014));
    }
    const paths = JSON.parse(readFileSync(join(docs, "generated/repo-paths.json"), "utf8")).paths;
    expect(paths).toEqual({ "docs/SPEC.md": "file", "packages/core": "dir" });
    expect(Object.keys(JSON.parse(readFileSync(join(docs, "generated/updated.json"), "utf8")).pages)).toEqual(["overview.md"]);
    // a second run changes nothing; a hand edit of the data is written over, of the header alone is not
    expect(writeExport(root, docs).changed).toEqual([]);
    const file = join(docs, "generated/changelog.json");
    const j = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...j, _source_commit: "0".repeat(40) }));
    expect(writeExport(root, docs).changed).toEqual([]);
    writeFileSync(file, JSON.stringify({ ...j, entries: [] }));
    expect(writeExport(root, docs, { check: true }).changed).toEqual(["changelog.json"]);
    expect(JSON.parse(readFileSync(file, "utf8")).entries).toEqual([]);
    expect(writeExport(root, docs).changed).toEqual(["changelog.json"]);
    expect(exportData(root, docs).files["core-api.json"]!.data.route_count).toBe(coreRoutes(root).length);
  } finally {
    rmSync(docs, { recursive: true, force: true });
  }
});

test("the trim rule of the captured examples marks every cut", () => {
  const t = trim({ a: [1, 2, 3], s: "x".repeat(200), o: { p: 1, q: 2, r: 3 } }, { arr: 2, keys: 2 }) as any;
  expect(t.a).toEqual([1, 2, "... 1 more"]);
  expect(t["..."]).toBe("1 more fields");
  const n = trim({ list: [[1, 2, 3]] }, { arr: 2, keys: 5 }) as any;
  expect(n.list[0]).toEqual([1, 2, "... 1 more"]);
  expect(String((trim("y".repeat(200), { arr: 1, keys: 1 }) as string)).endsWith("(200 characters)")).toBe(true);
});
