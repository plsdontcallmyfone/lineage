#!/usr/bin/env bun
// Exports the public recipes of this repository into a checkout of the recipes repository.
//
// The recipes repository is a repository of its own (local at ~/units-recipes until the owner
// publishes it): a README, the recipe and calibration schemas and a validation script, all written
// there. The recipes themselves are a SNAPSHOT of this repository, written by this script into its
// `recipes/` directory from one named commit:
//
//   recipes/<name>/recipe.yml               the recipe (SPEC 6)
//   recipes/<name>/overlay/**               the measurement harness, part of the recipe id
//   recipes/<name>/calibration.json         the calibration of recipe.yml as committed (its requires.arch)
//   recipes/<name>/calibration-amd64.json   the calibration the public devnet site recorded for the
//                                           amd64 variant of the recipe, where there is one
//   recipes/<name>/amd64/replace.json       how the amd64 variant differs from recipe.yml, where it does
//   recipes/<name>/amd64/overlay/**         (from scripts/deploy/amd64: text replacements and extra harness files)
//   recipes/index.json                      one row per recipe: class, arch, repository, commit, metrics,
//                                           limits, recipe id and calibration summary, computed here
//   recipes/SOURCE.json                     the commit and the sha256 of every file
//
// HELD BACK, on purpose (see HELD_BACK below; the test fails if one of them reaches the tree):
//   canaries/                 known-bad patches verifiers must reject (SPEC 10.5). A live network loads
//                             its canaries from a private directory; publishing a library defeats it.
//   patch-defs.json,          the definitions canaries and hand-written candidates are generated from
//   make-patches.ts           (scripts/make-canaries.ts)
//   candidates/               hand-written patches with their measured verdicts: test material, and a
//                             ready-made accepted patch is not part of what a recipe defines
//   claude-attempts/          transcripts of model runs from development
//   proposal.json, NOTES.md   development records (NOTES.md describes canaries by name and effect)
//   fixture-* recipes         test fixtures of this repository: their `repo` is a directory here, not a
//                             public repository, and the SPEC does not present them as examples
//
//   bun scripts/public/export-recipes.ts [<recipes checkout>] [--commit <rev>]     default ~/units-recipes, HEAD
//   bun scripts/public/export-recipes.ts --check [<recipes checkout>] [--commit <rev>]   write nothing; exit 1 if recipes/ would change
//
// Files are read from the commit through git, never from the working tree. Nothing is written when
// the audit finds a secret, a home directory path, a personal email or an em dash in the tree.
// After an export: in the checkout run `bun scripts/validate.ts` and commit `recipes/`. This script
// never touches a git remote and never pushes.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { H, recipeId, sha256Hex, type Calibration, type Recipe } from "@units/protocol";
import { validateRecipe } from "@units/sandbox";
import { assertLocalCheckout, auditTree, CommitReader, exportedBytes, parseArgs, report, syncTree, type Tree } from "./lib.ts";

const ROOT = join(import.meta.dir, "../..");

/** Names inside a recipe directory that are never exported, and why. */
export const HELD_BACK: Record<string, string> = {
  canaries: "known-bad patches verifiers must reject (SPEC 10.5); a published canary library defeats canaries",
  "patch-defs.json": "the definitions canaries and hand-written candidates are generated from",
  "make-patches.ts": "a generator holding canary definitions",
  candidates: "hand-written patches with their measured verdicts: test material, not part of a recipe",
  "claude-attempts": "transcripts of model runs from development",
  "proposal.json": "the development record of an agent-drafted recipe",
  "NOTES.md": "development notes that describe canaries by name and effect",
};

/** Recipes that are test fixtures of this repository. */
export const isFixtureRecipe = (name: string) => name.startsWith("fixture-");

/** Top-level names of a recipe directory that are exported. Anything else must be in HELD_BACK or the export stops. */
const PUBLIC_TOP = ["recipe.yml", "overlay", "calibration.json", "calibration-amd64.json"];

/** Where the amd64 variant of a recipe is described in this repository. */
const AMD64_DIR = "scripts/deploy/amd64";

export interface IndexRow {
  name: string;
  class: string;
  requires: Recipe["requires"];
  repo: string;
  commit: string;
  image: string;
  recipe_id: string;
  overlay_digest: string | null;
  overlay_files: number;
  metrics: { name: string; kind: string; direction: string; deterministic: boolean; min_effect: number; holdout: boolean; parser: string }[];
  patch: { allowed_paths: string[]; max_files: number; max_lines: number };
  limits: Recipe["limits"];
  calibrations: Record<string, { file: string; recipe_id: string; runs: number; stable: number; known_failures: number; quarantined: number; metrics_enabled: number; metrics_disabled: number }>;
  amd64_variant: { replace: boolean; overlay_files: number } | null;
}

/** The recipe as packages/sandbox loadRecipe builds it, from the files of a commit. */
export function loadFromCommit(r: CommitReader, name: string): { recipe: Recipe; recipe_id: string; overlayFiles: string[] } {
  const dir = `recipes/${name}`;
  const raw = Bun.YAML.parse(r.text(`${dir}/recipe.yml`)) as unknown as Recipe;
  const overlayFiles = r.under(`${dir}/overlay`).map((f) => f.slice(`${dir}/overlay/`.length)).sort();
  const overlay_digest = overlayFiles.length ? H("overlay", JSON.stringify(overlayFiles.map((f) => [f, sha256Hex(r.read(`${dir}/overlay/${f}`))]))) : undefined;
  let recipe: Recipe = { ...raw, overlay_digest };
  recipe.test = { exclude: [], ...recipe.test };
  recipe.build = { reproducible: false, artifacts: [], ...recipe.build };
  validateRecipe(recipe);
  recipe = { ...recipe, patch: { ...recipe.patch, protected_paths: [...new Set([...recipe.patch.protected_paths, ...overlayFiles])].sort() } };
  return { recipe, recipe_id: recipeId(recipe), overlayFiles };
}

const calSummary = (file: string, c: Calibration) => ({
  file,
  recipe_id: c.recipe_id,
  runs: c.runs,
  stable: c.stable.length,
  known_failures: c.known_failures.length,
  quarantined: c.quarantined.length,
  metrics_enabled: Object.values(c.metrics).filter((m) => m.enabled).length,
  metrics_disabled: Object.values(c.metrics).filter((m) => !m.enabled).length,
});

/** The whole recipes/ tree of the recipes repository for one commit. */
export function recipesTree(r: CommitReader): { tree: Tree; index: IndexRow[]; held: Record<string, string[]>; fixtures: string[] } {
  const tree: Tree = new Map();
  const index: IndexRow[] = [];
  const held: Record<string, string[]> = {};
  const all = r.children("recipes").filter((n) => r.has(`recipes/${n}/recipe.yml`));
  const fixtures = all.filter(isFixtureRecipe);
  for (const name of all.filter((n) => !isFixtureRecipe(n))) {
    const dir = `recipes/${name}`;
    for (const top of r.children(dir)) {
      if (PUBLIC_TOP.includes(top)) continue;
      if (!(top in HELD_BACK)) throw new Error(`${dir}/${top}: not a known public or held back name; decide which it is in scripts/public/export-recipes.ts`);
      (held[top] ??= []).push(name);
    }
    const put = (from: string, to: string) => tree.set(to, exportedBytes(r.read(from)));
    put(`${dir}/recipe.yml`, `${name}/recipe.yml`);
    for (const f of r.under(`${dir}/overlay`)) put(f, f.slice("recipes/".length));
    const loaded = loadFromCommit(r, name);
    const calibrations: IndexRow["calibrations"] = {};
    if (r.has(`${dir}/calibration.json`)) {
      put(`${dir}/calibration.json`, `${name}/calibration.json`);
      const c = JSON.parse(r.text(`${dir}/calibration.json`)) as Calibration;
      if (c.recipe_id !== loaded.recipe_id) throw new Error(`${dir}/calibration.json is for recipe ${c.recipe_id.slice(0, 12)}, but recipe.yml is ${loaded.recipe_id.slice(0, 12)}: calibrate again before exporting`);
      calibrations[loaded.recipe.requires.arch] = calSummary("calibration.json", c);
    }
    if (r.has(`${dir}/calibration-amd64.json`)) {
      put(`${dir}/calibration-amd64.json`, `${name}/calibration-amd64.json`);
      const c = JSON.parse(r.text(`${dir}/calibration-amd64.json`)) as { recipe_id: string; calibration: Calibration };
      calibrations.amd64 = calSummary("calibration-amd64.json", { ...c.calibration, recipe_id: c.recipe_id });
    }
    // the amd64 variant: text replacements in recipe.yml and extra harness files
    const replace = `${AMD64_DIR}/${name}.replace.json`;
    const extra = r.under(`${AMD64_DIR}/${name}`);
    if (r.has(replace)) put(replace, `${name}/amd64/replace.json`);
    for (const f of extra) put(f, `${name}/amd64/overlay/${f.slice(`${AMD64_DIR}/${name}/`.length)}`);
    const m = loaded.recipe;
    index.push({
      name: m.name,
      class: m.class,
      requires: m.requires,
      repo: m.repo,
      commit: m.commit,
      image: m.image,
      recipe_id: loaded.recipe_id,
      overlay_digest: m.overlay_digest ?? null,
      overlay_files: loaded.overlayFiles.length,
      metrics: m.metrics.map((x) => ({ name: x.name, kind: x.kind, direction: x.direction, deterministic: x.deterministic, min_effect: x.min_effect, holdout: !!x.holdout, parser: x.parser })),
      patch: { allowed_paths: m.patch.allowed_paths, max_files: m.patch.max_files, max_lines: m.patch.max_lines },
      limits: m.limits,
      calibrations,
      amd64_variant: r.has(replace) || extra.length ? { replace: r.has(replace), overlay_files: extra.length } : null,
    });
    if (m.name !== name) throw new Error(`${dir}/recipe.yml names itself ${m.name}`);
  }
  tree.set("index.json", Buffer.from(JSON.stringify({ recipes: index }, null, 2) + "\n"));
  return { tree, index, held, fixtures };
}

/** Paths of a tree that carry a held back name (must be empty). */
export function leaked(tree: Tree): string[] {
  const bad = new Set(Object.keys(HELD_BACK));
  return [...tree.keys()].filter((p) => {
    const parts = p.split("/");
    // <name>/amd64/overlay/** and <name>/overlay/** are harness files, whatever they are called
    const inOverlay = parts[1] === "overlay" || (parts[1] === "amd64" && parts[2] === "overlay");
    return isFixtureRecipe(parts[0]!) || (!inOverlay && parts.slice(1).some((x) => bad.has(x)));
  });
}

export function exportRecipes(root: string, target: string, o: { check?: boolean; rev?: string } = {}) {
  const r = new CommitReader(root, o.rev ?? "HEAD");
  const { tree, index, held, fixtures } = recipesTree(r);
  const leaks = leaked(tree);
  if (leaks.length) throw new Error(`held back files would be exported:\n  ${leaks.join("\n  ")}`);
  const findings = auditTree(tree);
  const extra = { recipes: index.map((x) => x.name), held_back: { ...HELD_BACK, "fixture-*": "test fixtures of the monorepo, not public repositories" } };
  const res = findings.length ? { changed: [], extra: [] } : syncTree(join(target, "recipes"), tree, { check: o.check, script: "scripts/public/export-recipes.ts", commit: r.commit, extra });
  return { commit: r.commit, tree, index, held, fixtures, findings, ...res };
}

if (import.meta.main) {
  const { check, rev, target } = parseArgs(process.argv.slice(2), join(homedir(), "units-recipes"));
  assertLocalCheckout(target, ROOT);
  if (!existsSync(join(target, "scripts/validate.ts")) && !existsSync(join(target, ".git"))) {
    console.error(`${target} is not a checkout of the recipes repository (no scripts/validate.ts and no .git)`);
    process.exit(2);
  }
  const r = exportRecipes(ROOT, target, { check, rev });
  const code = report("recipes", target, "recipes", r, r.findings, check, r.commit);
  console.log(`${r.index.length} recipes exported; held back: ${Object.entries(r.held).map(([k, v]) => `${k} (${v.length})`).join(", ")}; fixture recipes left out: ${r.fixtures.join(", ")}`);
  if (!check && (r.changed.length || r.extra.length)) console.log(`next, in ${target}: bun scripts/validate.ts, then commit recipes/`);
  process.exit(code);
}
