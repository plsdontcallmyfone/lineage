import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSETS, closure, ENTRIES, exportVerifier, IMAGE_CLASSES, isFixtureRecipe, KIT_OWNED, unresolved, vendorTree } from "./export-verifier.ts";
import { loadFromCommit } from "./export-recipes.ts";
import { auditTree, CommitReader, exportedBytes, sha256, syncTree, type Tree } from "./lib.ts";

// The verifier kit is a repository of its own; its vendor/ directory is a snapshot of this one,
// written by scripts/public/export-verifier.ts. These tests keep that snapshot small, self-contained
// and free of what must not be published.
const root = join(import.meta.dir, "../..");
const reader = new CommitReader(root);
const { tree, closure: c, recipes } = vendorTree(reader);
const paths = [...tree.keys()];

test("the snapshot holds the entry points and what they load, and nothing of the rest of the repository", () => {
  for (const e of ENTRIES) expect(tree.has(e), e).toBe(true);
  for (const a of ASSETS) expect(tree.has(a), a).toBe(true);
  for (const f of ["packages/worker/src/worker.ts", "packages/sandbox/src/evaluate.ts", "packages/protocol/src/verdict.ts", "packages/core/src/client.ts", "packages/mirror/src/verify.ts"]) expect(tree.has(f), f).toBe(true);
  // not the server, not the web app, not the programs, not the hosted runtime, not the agent desktop
  for (const p of paths) expect(/^(apps|onchain|docs|research|tests|fixtures|work)\//.test(p) || /^packages\/(desktop|runtime|identity|indexer|embed|fee-keeper)\//.test(p), p).toBe(false);
  expect(tree.has("packages/core/src/core.ts")).toBe(false);
  expect(tree.has("packages/core/src/http.ts")).toBe(false);
  for (const p of paths.filter((x) => x.startsWith("scripts/"))) expect(ENTRIES, p).toContain(p);
  expect(paths.filter((p) => /\.test\.ts$/.test(p))).toEqual([]);
  // small on purpose: the closure, not whole packages
  expect(c.files.length).toBeLessThan(200);
});

test("every run time import of the vendored code resolves inside the snapshot", () => {
  expect(unresolved(tree)).toEqual([]);
  // and the check itself sees a missing file
  const broken: Tree = new Map(tree);
  broken.delete("packages/protocol/src/hash.ts");
  expect(unresolved(broken).length).toBeGreaterThan(0);
});

test("type-only imports and the agent desktop are not followed", () => {
  const all = closure(reader);
  expect(all.files.some((f) => f.startsWith("packages/desktop/"))).toBe(false);
  // worker.ts imports types from the Core server; the server itself stays out
  expect(reader.text("packages/worker/src/worker.ts")).toContain('import type { Messenger } from "../../core/src/msgchain.ts"');
  expect(all.files).not.toContain("packages/core/src/msgchain.ts");
});

test("recipes: recipe.yml and overlay of every public recipe, with this repository's recipe ids; no canaries, calibrations or fixtures", () => {
  expect(recipes.length).toBeGreaterThan(15);
  expect(recipes.some(isFixtureRecipe)).toBe(false);
  const recipeFiles = paths.filter((p) => p.startsWith("recipes/"));
  for (const p of recipeFiles) {
    const [, name, top] = p.split("/");
    expect(recipes, p).toContain(name!);
    expect(top === "recipe.yml" || top === "overlay", p).toBe(true);
  }
  for (const p of paths) expect(/(^|\/)(canaries|candidates|claude-attempts)\/|patch-defs\.json|calibration[^/]*\.json/.test(p), p).toBe(false);
  // a worker matches a unit by recipe id: the exported files must give the id this repository computes
  for (const name of recipes) {
    const here = loadFromCommit(reader, name);
    for (const f of here.overlayFiles) expect(sha256(tree.get(`recipes/${name}/overlay/${f}`)!)).toBe(sha256(exportedBytes(reader.read(`recipes/${name}/overlay/${f}`))));
    expect(tree.get(`recipes/${name}/recipe.yml`)!.equals(exportedBytes(reader.read(`recipes/${name}/recipe.yml`)))).toBe(true);
    // the em dash escape must never touch a recipe: its bytes are its identity
    expect(reader.read(`recipes/${name}/recipe.yml`).includes("—")).toBe(false);
    for (const f of here.overlayFiles) expect(reader.read(`recipes/${name}/overlay/${f}`).includes("—"), `${name}/overlay/${f}`).toBe(false);
  }
});

test("toolchain image build contexts are exported, the worker and desktop images are not", () => {
  for (const cls of IMAGE_CLASSES) expect(tree.has(`images/${cls}/Dockerfile`), cls).toBe(true);
  expect(paths.some((p) => p.startsWith("images/worker/") || p.startsWith("images/desktop/"))).toBe(false);
});

test("package manifests name only vendored workspace packages and pinned external packages", () => {
  const rootPkg = JSON.parse(tree.get("package.json")!.toString());
  expect(rootPkg.workspaces).toEqual(["packages/*"]);
  const vendored = new Set(paths.filter((p) => /^packages\/[^/]+\/package\.json$/.test(p)).map((p) => JSON.parse(tree.get(p)!.toString()).name as string));
  for (const p of paths.filter((x) => /^packages\/[^/]+\/package\.json$/.test(x))) {
    const j = JSON.parse(tree.get(p)!.toString()) as { dependencies?: Record<string, string>; bin?: unknown; scripts?: unknown };
    expect(j.bin).toBeUndefined();
    expect(j.scripts).toBeUndefined();
    for (const [d, v] of Object.entries(j.dependencies ?? {})) {
      if (d.startsWith("@units/")) expect(vendored.has(d), `${p} -> ${d}`).toBe(true);
      else {
        expect(c.external, `${p} -> ${d}`).toContain(d);
        expect(v, `${d} must be an exact version`).toMatch(/^\d+\.\d+\.\d+/);
      }
    }
  }
  for (const d of Object.keys(rootPkg.dependencies)) expect(vendored.has(d), d).toBe(true);
});

test("the snapshot is clean: no secret, no home directory path, no personal email, no em dash", () => {
  expect(auditTree(tree)).toEqual([]);
  // the audit sees each kind of thing it is there for
  const planted: Tree = new Map([
    ["a.json", Buffer.from("[" + Array.from({ length: 64 }, (_, i) => i).join(",") + "]")],
    ["b.ts", Buffer.from('const rpc = "https://mainnet.helius-rpc.com/?api-key=00000000-0000-0000-0000-000000000000";')],
    ["c.md", Buffer.from("see /Users/someone/project/file")],
    ["d.md", Buffer.from("write to someone.else@gmail.com")],
    ["e.md", Buffer.from("a dash — here")],
  ]);
  expect(auditTree(planted).map((f) => f.rule).sort()).toEqual(["Solana keypair (64 byte array)", "em dash", "home directory path", "keyed RPC URL", "personal email"]);
  // source files that hold an em dash inside a pattern are exported with its escape
  expect(exportedBytes(Buffer.from("/—/")).toString()).toBe("/\\u2014/");
});

test("export, check, tamper, check: vendor/ is written once and --check sees every drift; the kit's own files are left alone", () => {
  const kit = mkdtempSync(join(tmpdir(), "units-verifier-export-"));
  try {
    mkdirSync(join(kit, "vendor/node_modules/x"), { recursive: true });
    writeFileSync(join(kit, "vendor/node_modules/x/index.js"), "");
    writeFileSync(join(kit, "vendor/bun.lock"), "kit owned");
    const first = exportVerifier(root, kit);
    expect(first.findings).toEqual([]);
    expect(first.changed.length).toBeGreaterThan(100);
    const source = JSON.parse(readFileSync(join(kit, "vendor/SOURCE.json"), "utf8"));
    expect(source.source_commit).toBe(reader.commit);
    expect(Object.keys(source.files).length).toBe(tree.size);
    expect(source.files["packages/worker/src/main.ts"]).toBe(sha256(tree.get("packages/worker/src/main.ts")!));
    expect(KIT_OWNED).toContain("bun.lock");
    expect(readFileSync(join(kit, "vendor/bun.lock"), "utf8")).toBe("kit owned");
    expect(existsSync(join(kit, "vendor/node_modules/x/index.js"))).toBe(true);

    const clean = exportVerifier(root, kit, { check: true });
    expect([clean.changed, clean.extra]).toEqual([[], []]);

    writeFileSync(join(kit, "vendor/packages/protocol/src/hash.ts"), "// edited by hand\n");
    writeFileSync(join(kit, "vendor/packages/protocol/src/stray.ts"), "");
    const drift = exportVerifier(root, kit, { check: true });
    expect(drift.changed).toEqual(["packages/protocol/src/hash.ts"]);
    expect(drift.extra).toEqual(["packages/protocol/src/stray.ts"]);
    // --check wrote nothing
    expect(readFileSync(join(kit, "vendor/packages/protocol/src/hash.ts"), "utf8")).toBe("// edited by hand\n");

    exportVerifier(root, kit);
    const again = exportVerifier(root, kit, { check: true });
    expect([again.changed, again.extra]).toEqual([[], []]);
    expect(existsSync(join(kit, "vendor/packages/protocol/src/stray.ts"))).toBe(false);
  } finally {
    rmSync(kit, { recursive: true, force: true });
  }
}, 120_000);

test("SOURCE.json keeps its commit while the files are unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "units-export-sync-"));
  try {
    const t: Tree = new Map([["a/b.txt", Buffer.from("one")]]);
    syncTree(dir, t, { script: "s", commit: "1".repeat(40) });
    const same = syncTree(dir, t, { script: "s", commit: "2".repeat(40), check: true });
    expect([same.changed, same.extra]).toEqual([[], []]);
    syncTree(dir, t, { script: "s", commit: "2".repeat(40) });
    expect(JSON.parse(readFileSync(join(dir, "SOURCE.json"), "utf8")).source_commit).toBe("1".repeat(40));
    t.set("a/b.txt", Buffer.from("two"));
    expect(syncTree(dir, t, { script: "s", commit: "2".repeat(40), check: true }).changed).toEqual(["SOURCE.json", "a/b.txt"]);
    syncTree(dir, t, { script: "s", commit: "2".repeat(40) });
    expect(JSON.parse(readFileSync(join(dir, "SOURCE.json"), "utf8")).source_commit).toBe("2".repeat(40));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
