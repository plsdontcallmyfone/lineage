#!/usr/bin/env bun
// Exports the worker code of this repository into a checkout of the verifier kit.
//
// The verifier kit is a repository of its own (local at ~/units-verifier until the owner publishes
// it): a Dockerfile, a compose file, a thin command wrapper, one config file and a README, all written
// there. What it runs is a SNAPSHOT of this repository, written by this script into its `vendor/`
// directory from one named commit:
//
//   packages/**            the import closure of the entry points below (worker, sandbox, protocol and
//                          the few files of core, chain, souls and mirror they load), nothing else
//   scripts/*.ts           the entry points that are not the worker: verify.ts (recompute verdicts and
//                          draws), replay.ts (replay one final candidate in a local sandbox),
//                          identity/verify-generation.ts (a generation against its GitHub commit),
//                          local-images.ts (build the toolchain images), calibrate-recipe.ts
//   images/<class>/**      the toolchain image build contexts (not the worker or desktop images)
//   recipes/<name>/        recipe.yml and overlay/ of every public recipe: what a worker must hold to
//                          match a unit's recipe id. No canaries, no patch definitions, no candidates.
//   config/profile.json    program ids and public network fields (verify.ts --chain)
//   package.json files     written here: only the vendored workspace packages and the external
//                          packages the closure imports, pinned to the versions in this repository's bun.lock
//   SOURCE.json            the commit and the sha256 of every file
//
// The closure follows static imports and the worker's dynamic imports of packages/chain; it does not
// follow type-only imports (erased at run time) or the agent desktop (packages/desktop, an authoring
// feature the kit does not ship). `vendor/bun.lock` and `vendor/node_modules` belong to the kit.
//
//   bun scripts/public/export-verifier.ts [<kit checkout>] [--commit <rev>]     default ~/units-verifier, HEAD
//   bun scripts/public/export-verifier.ts --check [<kit checkout>] [--commit <rev>]   write nothing; exit 1 if vendor/ would change
//
// Files are read from the commit through git, never from the working tree. Nothing is written when
// the audit finds a secret, a home directory path, a personal email or an em dash in the tree.
// After an export that changed a package.json: in the kit run `bun install` inside vendor/ and commit
// vendor/bun.lock with the rest. This script never touches a git remote and never pushes.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import { assertLocalCheckout, auditTree, CommitReader, exportedBytes, parseArgs, report, syncTree, type Tree } from "./lib.ts";

const ROOT = join(import.meta.dir, "../..");

/** What the kit runs. The closure of these files is the vendored code. */
export const ENTRIES = [
  "packages/worker/src/main.ts",
  "scripts/verify.ts",
  "scripts/replay.ts",
  "scripts/identity/verify-generation.ts",
  "scripts/local-images.ts",
  "scripts/calibrate-recipe.ts",
];

/** Dynamic imports that are not followed: authoring on an agent desktop is not part of the kit. */
export const NOT_SHIPPED = ["packages/desktop/"];

/** Toolchain image build contexts (SPEC 6.1 classes). */
export const IMAGE_CLASSES = ["rust", "python", "go", "cpp", "zig", "solana", "cuda"];

/** Files read at run time by path, not by import. */
export const ASSETS = ["config/profile.json", "config/mainnet-test/profile.json"];

/** Recipes that are test fixtures of this repository (their repo is a directory here, not a public repository). */
export const isFixtureRecipe = (name: string) => name.startsWith("fixture-");

/** Recipe files a worker needs: the recipe and its harness overlay. Everything else stays here. */
export const workerRecipeFile = (rel: string) => rel === "recipe.yml" || rel.startsWith("overlay/");

const IMPORT_RE = /(?:^|\n)[ \t]*(?:import|export)\s[^;'"`]*?from\s+["']([^"']+)["']|(?:^|\n)[ \t]*import\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
const TYPE_ONLY_RE = /(^|\n)[ \t]*(?:import|export)\s+type\s[^;'"`]*?from\s+["'][^"']+["'];?/g;

export interface Closure {
  files: string[];
  /** external packages imported by the closure */
  external: string[];
}

/** The files the entry points load at run time, by following imports through the commit. */
export function closure(r: CommitReader, entries = ENTRIES): Closure {
  const seen = new Set<string>();
  const external = new Set<string>();
  const pkgMain = new Map<string, { dir: string; exports: Record<string, string> }>();
  for (const p of r.children("packages")) {
    const f = `packages/${p}/package.json`;
    if (!r.has(f)) continue;
    const j = JSON.parse(r.text(f)) as { name: string; main?: string; exports?: Record<string, string> };
    pkgMain.set(j.name, { dir: `packages/${p}`, exports: { ".": j.main ?? "src/index.ts", ...(j.exports ?? {}) } });
  }
  const resolve = (from: string, spec: string): string | null => {
    if (spec.startsWith(".")) {
      const base = posix.normalize(posix.join(posix.dirname(from), spec));
      for (const c of [base, `${base}.ts`, `${base}/index.ts`]) if (r.has(c)) return c;
      throw new Error(`${from} imports ${spec}, which is not in the commit`);
    }
    if (spec.startsWith("node:") || spec === "bun" || spec.startsWith("bun:")) return null;
    const parts = spec.split("/");
    const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
    const ws = pkgMain.get(name);
    if (!ws) {
      external.add(name);
      return null;
    }
    const sub = "./" + parts.slice(spec.startsWith("@") ? 2 : 1).join("/");
    const target = ws.exports[sub === "./" ? "." : sub];
    if (!target) throw new Error(`${from} imports ${spec}, which ${name} does not export`);
    return posix.normalize(posix.join(ws.dir, target));
  };
  const visit = (f: string) => {
    if (seen.has(f)) return;
    seen.add(f);
    if (!/\.tsx?$/.test(f)) return;
    const src = r.text(f).replace(TYPE_ONLY_RE, "$1");
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = (m[1] ?? m[2] ?? m[3])!;
      const to = resolve(f, spec);
      if (!to) continue;
      if (m[3] && NOT_SHIPPED.some((p) => to.startsWith(p))) continue;
      visit(to);
    }
  };
  for (const e of entries) visit(e);
  return { files: [...seen].sort(), external: [...external].sort() };
}

/** The version this repository's bun.lock resolves an external package to. */
export function lockedVersion(lock: string, name: string): string {
  const m = new RegExp(`"${name.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}": \\["${name.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}@([^"]+)"`).exec(lock);
  if (!m) throw new Error(`bun.lock has no entry for ${name}`);
  return m[1]!;
}

const json = (v: unknown) => Buffer.from(JSON.stringify(v, null, 2) + "\n");

/** The whole vendor/ tree of the kit for one commit. */
export function vendorTree(r: CommitReader): { tree: Tree; closure: Closure; recipes: string[] } {
  const c = closure(r);
  const tree: Tree = new Map();
  for (const f of c.files) tree.set(f, exportedBytes(r.read(f)));
  for (const f of ASSETS) tree.set(f, exportedBytes(r.read(f)));
  for (const cls of IMAGE_CLASSES) for (const f of r.under(`images/${cls}`)) tree.set(f, exportedBytes(r.read(f)));
  const recipes = r.children("recipes").filter((n) => r.has(`recipes/${n}/recipe.yml`) && !isFixtureRecipe(n));
  for (const n of recipes)
    for (const f of r.under(`recipes/${n}`)) if (workerRecipeFile(f.slice(`recipes/${n}/`.length))) tree.set(f, exportedBytes(r.read(f)));

  // package manifests: the vendored workspace packages and the external packages the closure imports
  const lock = r.text("bun.lock");
  const vendored = new Set(c.files.filter((f) => f.startsWith("packages/")).map((f) => f.split("/")[1]!));
  const names = new Map<string, string>();
  for (const p of vendored) names.set((JSON.parse(r.text(`packages/${p}/package.json`)) as { name: string }).name, p);
  for (const p of [...vendored].sort()) {
    const j = JSON.parse(r.text(`packages/${p}/package.json`)) as Record<string, any>;
    const deps: Record<string, string> = {};
    for (const [d, v] of Object.entries((j.dependencies ?? {}) as Record<string, string>)) {
      if (names.has(d)) deps[d] = v;
      else if (c.external.includes(d)) deps[d] = lockedVersion(lock, d);
    }
    const out: Record<string, unknown> = { name: j.name, version: j.version, type: j.type, main: j.main };
    if (j.types) out.types = j.types;
    if (j.exports) out.exports = j.exports;
    if (Object.keys(deps).length) out.dependencies = deps;
    tree.set(`packages/${p}/package.json`, json(out));
  }
  const root = JSON.parse(r.text("package.json")) as { dependencies?: Record<string, string> };
  tree.set(
    "package.json",
    json({
      name: "units-verifier-vendor",
      private: true,
      type: "module",
      workspaces: ["packages/*"],
      dependencies: Object.fromEntries(Object.entries(root.dependencies ?? {}).filter(([d]) => names.has(d))),
    }),
  );
  return { tree, closure: c, recipes };
}

/** Relative and workspace imports of the vendored code that do not resolve inside the tree (run time imports only). */
export function unresolved(tree: Tree): string[] {
  const out: string[] = [];
  const exportsOf = new Map<string, { dir: string; exports: Record<string, string> }>();
  for (const [p, b] of tree) {
    const m = /^packages\/([^/]+)\/package\.json$/.exec(p);
    if (!m) continue;
    const j = JSON.parse(b.toString("utf8")) as { name: string; main?: string; exports?: Record<string, string> };
    exportsOf.set(j.name, { dir: `packages/${m[1]}`, exports: { ".": j.main ?? "src/index.ts", ...(j.exports ?? {}) } });
  }
  for (const [f, b] of tree) {
    if (!/\.tsx?$/.test(f)) continue;
    const src = b.toString("utf8").replace(TYPE_ONLY_RE, "$1");
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = (m[1] ?? m[2] ?? m[3])!;
      if (spec.startsWith(".")) {
        const base = posix.normalize(posix.join(posix.dirname(f), spec));
        if (![base, `${base}.ts`, `${base}/index.ts`].some((c) => tree.has(c)) && !(m[3] && NOT_SHIPPED.some((p) => base.startsWith(p)))) out.push(`${f} -> ${spec}`);
      } else if (spec.startsWith("@units/")) {
        const parts = spec.split("/");
        const ws = exportsOf.get(parts.slice(0, 2).join("/"));
        const sub = "./" + parts.slice(2).join("/");
        const target = ws?.exports[sub === "./" ? "." : sub];
        if (!ws || !target || !tree.has(posix.normalize(posix.join(ws.dir, target)))) out.push(`${f} -> ${spec}`);
      }
    }
  }
  return out;
}

/** Files of the kit's vendor/ directory that the kit owns (never written or removed by the export). */
export const KIT_OWNED = ["bun.lock", "node_modules"];

export function exportVerifier(root: string, target: string, o: { check?: boolean; rev?: string } = {}) {
  const r = new CommitReader(root, o.rev ?? "HEAD");
  const { tree, closure: c, recipes } = vendorTree(r);
  const findings = auditTree(tree);
  const missing = unresolved(tree);
  if (missing.length) throw new Error(`the vendored code would not be self-contained:\n  ${missing.join("\n  ")}`);
  const extra = { entries: ENTRIES, not_shipped: NOT_SHIPPED, external_packages: Object.fromEntries(c.external.map((e) => [e, lockedVersion(r.text("bun.lock"), e)])), recipes };
  const res = findings.length
    ? { changed: [], extra: [] }
    : syncTree(join(target, "vendor"), tree, { check: o.check, script: "scripts/public/export-verifier.ts", commit: r.commit, keep: KIT_OWNED, extra });
  return { commit: r.commit, tree, closure: c, recipes, findings, ...res };
}

if (import.meta.main) {
  const { check, rev, target } = parseArgs(process.argv.slice(2), join(homedir(), "units-verifier"));
  assertLocalCheckout(target, ROOT);
  if (!existsSync(join(target, "Dockerfile")) && !existsSync(join(target, ".git"))) {
    console.error(`${target} is not a checkout of the verifier kit (no Dockerfile and no .git)`);
    process.exit(2);
  }
  const r = exportVerifier(ROOT, target, { check, rev });
  const code = report("verifier kit", target, "vendor", r, r.findings, check, r.commit);
  if (!check && r.changed.some((p) => p.endsWith("package.json"))) console.log(`next, in ${join(target, "vendor")}: bun install, then commit vendor/ with its bun.lock`);
  process.exit(code);
}
