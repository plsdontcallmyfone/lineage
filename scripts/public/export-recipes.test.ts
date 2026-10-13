import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadRecipe } from "@units/sandbox";
import { recipeId, type Calibration } from "@units/protocol";
import { exportRecipes, HELD_BACK, isFixtureRecipe, leaked, loadFromCommit, measuredCalibration, recipesTree } from "./export-recipes.ts";
import { auditTree, CommitReader, sha256 } from "./lib.ts";
import { sameUnit, SITE_CAL_DIR, siteRecord, type LineageView, type SiteCalibration } from "./site-calibrations.ts";

// The recipes repository is a repository of its own; its recipes/ directory is a snapshot of this
// one, written by scripts/public/export-recipes.ts. These tests keep canaries and everything else
// that is held back out of it, and keep the exported recipes the ones this repository computes.
const root = join(import.meta.dir, "../..");
const reader = new CommitReader(root);
const { tree, index, held, fixtures } = recipesTree(reader);
const paths = [...tree.keys()];
const all = reader.children("recipes").filter((n) => reader.has(`recipes/${n}/recipe.yml`));

test("every public recipe is exported with its calibration; fixtures are not", () => {
  expect(index.length).toBeGreaterThan(15);
  expect(index.map((r) => r.name).sort()).toEqual(all.filter((n) => !isFixtureRecipe(n)).sort());
  expect(fixtures.sort()).toEqual(all.filter(isFixtureRecipe).sort());
  for (const r of index) {
    expect(tree.has(`${r.name}/recipe.yml`), r.name).toBe(true);
    expect(tree.has(`${r.name}/calibration.json`), r.name).toBe(true);
    // the calibration of recipe.yml is filed under the architecture the recipe requires
    expect(r.calibrations[r.requires.arch]?.recipe_id, r.name).toBe(r.recipe_id);
    expect(r.calibrations[r.requires.arch]!.stable, r.name).toBeGreaterThan(0);
    if (r.calibrations.amd64 && r.requires.arch !== "amd64") expect(r.calibrations.amd64.recipe_id, r.name).not.toBe(r.recipe_id);
    expect(r.metrics.some((m) => m.deterministic), r.name).toBe(true);
  }
  for (const p of paths) expect(isFixtureRecipe(p.split("/")[0]!), p).toBe(false);
});

test("nothing held back reaches the tree: no canary, patch definition, candidate, transcript or note, by name or by content", () => {
  expect(leaked(tree)).toEqual([]);
  const digests = new Set([...tree.values()].map((b) => sha256(b)));
  let heldFiles = 0;
  for (const name of all)
    for (const f of reader.under(`recipes/${name}`)) {
      const top = f.slice(`recipes/${name}/`.length).split("/")[0]!;
      const rel = f.slice("recipes/".length);
      if (isFixtureRecipe(name)) {
        // a fixture's harness may share a file (a lockfile) with a public recipe: only its path is checked
        expect(tree.has(rel), rel).toBe(false);
        continue;
      }
      if (!(top in HELD_BACK)) continue;
      heldFiles++;
      expect(tree.has(rel), rel).toBe(false);
      // no exported file has the bytes of a held back file either (an empty file aside)
      const b = reader.read(f);
      if (b.length > 64) expect(digests.has(sha256(b)), `${f} is exported under another name`).toBe(false);
    }
  expect(heldFiles).toBeGreaterThan(100);
  expect(Object.keys(held).sort()).toEqual(Object.keys(HELD_BACK).filter((k) => held[k]).sort());
  expect(held.canaries!.length).toBeGreaterThan(15);
  // no exported text carries a canary diff's body
  const canaryBodies = all.flatMap((n) => reader.under(`recipes/${n}/canaries`).filter((f) => f.endsWith(".diff")).map((f) => reader.text(f)));
  expect(canaryBodies.length).toBeGreaterThan(40);
  const exportedText = [...tree.values()].filter((b) => !b.includes(0)).map((b) => b.toString("utf8"));
  for (const body of canaryBodies) {
    const hunk = body.split("\n").filter((l) => /^[+-][^+-]/.test(l)).join("\n");
    if (hunk.length > 40) expect(exportedText.some((t) => t.includes(hunk))).toBe(false);
  }
  // and the leak check sees one
  expect(leaked(new Map([["minbpe/canaries/x.diff", Buffer.from("")]]))).toEqual(["minbpe/canaries/x.diff"]);
  expect(leaked(new Map([["fixture-b58/recipe.yml", Buffer.from("")]]))).toEqual(["fixture-b58/recipe.yml"]);
  expect(leaked(new Map([["minbpe/overlay/candidates/x.py", Buffer.from("")]]))).toEqual([]);
}, 60_000); // one git read per held back file (about 300): past the default 5 s on a busy machine

test("the tree is clean: no secret, no home directory path, no personal email, no em dash", () => {
  expect(auditTree(tree)).toEqual([]);
});

test("recipe ids: the export, the sandbox loader and the files written to disk all agree", () => {
  const dir = mkdtempSync(join(tmpdir(), "units-recipes-ids-"));
  try {
    for (const [p, b] of tree) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), b);
    }
    for (const r of index) {
      expect(loadFromCommit(reader, r.name).recipe_id).toBe(r.recipe_id);
      const onDisk = loadRecipe(join(dir, r.name));
      expect(onDisk.recipe_id, r.name).toBe(r.recipe_id);
      expect(onDisk.recipe.overlay_digest ?? null, r.name).toBe(r.overlay_digest);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("amd64 variants come with their replacement rules and extra harness files", () => {
  const withVariant = index.filter((r) => r.amd64_variant);
  expect(withVariant.length).toBeGreaterThan(0);
  for (const r of withVariant) {
    if (r.amd64_variant!.replace) {
      const repl = JSON.parse(tree.get(`${r.name}/amd64/replace.json`)!.toString()) as [string, string][];
      const yml = tree.get(`${r.name}/recipe.yml`)!.toString();
      for (const [from] of repl) expect(yml.includes(from), `${r.name}: ${from}`).toBe(true);
    }
    expect(paths.filter((p) => p.startsWith(`${r.name}/amd64/overlay/`)).length).toBe(r.amd64_variant!.overlay_files);
    expect(r.calibrations.amd64, r.name).toBeDefined();
  }
});

test("amd64 calibrations: the mainnet site's record for a live unit, else only the calibration of this repository's own measurement", () => {
  const siteNames = reader.children(SITE_CAL_DIR).filter((f) => f.endsWith(".json") && f !== "index.json").map((f) => f.slice(0, -5));
  expect(siteNames.length).toBeGreaterThan(0);
  for (const name of siteNames) {
    // published byte for byte as scripts/public/site-calibrations.ts wrote it
    expect(tree.get(`${name}/calibration-amd64.json`)!.equals(reader.read(`${SITE_CAL_DIR}/${name}.json`)), name).toBe(true);
    const rec = JSON.parse(reader.text(`${SITE_CAL_DIR}/${name}.json`)) as SiteCalibration;
    const row = index.find((r) => r.name === name)!;
    expect(row.mainnet).toEqual({ site: rec.site, lineage_id: rec.lineage_id, recipe_id: rec.recipe_id });
    expect(row.calibrations.amd64!.source).toBe("site");
    expect(rec.calibration.recipe_id).toBe(rec.recipe_id);
    expect(Object.keys(rec.calibration.metrics).sort(), name).toEqual(row.metrics.map((m) => m.name).sort());
  }
  let measured = 0;
  for (const r of index) {
    const b = tree.get(`${r.name}/calibration-amd64.json`);
    if (!b) {
      expect(r.calibrations.amd64 === undefined || r.requires.arch === "amd64", r.name).toBe(true);
      continue;
    }
    const text = b.toString("utf8");
    const c = JSON.parse(text) as Record<string, any>;
    // no old network, no host name, no address: only the mainnet site's own origin
    expect(/devnet|testnet|\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\d+-\d+-\d+-\d+\.sslip|cap-[a-z]+\d/i.test(text), r.name).toBe(false);
    expect("canaries" in c || "candidates" in c || "host" in c, r.name).toBe(false);
    if (siteNames.includes(r.name)) continue;
    measured++;
    expect(r.mainnet, r.name).toBeNull();
    expect(Object.keys(c)).toEqual(["_note", "source", "recipe_id", "calibration"]);
    expect(c.source).toBe("measured");
    const raw = JSON.parse(reader.text(`recipes/${r.name}/calibration-amd64.json`)) as { recipe_id: string; calibration: Calibration };
    expect(c.recipe_id).toBe(raw.recipe_id);
    expect(c.calibration.metrics).toEqual(raw.calibration.metrics);
    expect(c.calibration.stable).toEqual(raw.calibration.stable);
  }
  expect(measured).toBeGreaterThan(0);
  // a source file's other fields never come along
  const m = measuredCalibration({ recipe_id: "ab", host: "h", canaries: { x: 1 }, calibration: { runs: 5, stable: ["t"], known_failures: [], quarantined: [], metrics: {}, median_eval_seconds: 1, wall: 9, recipe_id: "zz" } } as any);
  expect(JSON.stringify(m)).not.toMatch(/"host"|canaries|"wall"|zz/);
  expect(m.calibration.recipe_id).toBe("ab");
});

test("a site record is made only from a view whose recipe hashes to its id, for the recipe of this repository", () => {
  const local = loadFromCommit(reader, index[0]!.name).recipe;
  const served = { ...local, requires: { ...local.requires, arch: "amd64" as const }, image: local.image.replace(/[0-9a-f]{8}$/, "00000000") };
  const id = recipeId(served);
  const cal = { recipe_id: id, snapshot_id: "", runs: 5, stable: ["t"], known_failures: [], quarantined: [], metrics: {}, median_eval_seconds: 1 };
  const view: LineageView = { lineage_id: "aa".repeat(32), repo: local.repo, recipe_id: id, recipe: served, calib_id: "bb".repeat(32), calibration: cal, calibration_by: "runner", calibration_sig: "sig", status: "active" };
  const rec = siteRecord(view, "https://site.example", "2026-01-01");
  expect([rec.source, rec.network, rec.site, rec.lineage_id, rec.recipe_id, rec.calibrated_by]).toEqual(["site", "mainnet", "https://site.example", view.lineage_id, id, "runner"]);
  expect(id).not.toBe(recipeId(local));
  expect(() => siteRecord({ ...view, recipe_id: "cc".repeat(32) }, "https://site.example", "2026-01-01")).toThrow();
  expect(() => siteRecord({ ...view, calibration: { ...cal, recipe_id: "cc".repeat(32) } }, "https://site.example", "2026-01-01")).toThrow();
  expect(sameUnit(local, served)).toBeNull();
  expect(sameUnit(local, { ...served, commit: "0".repeat(40) })).toContain("commit");
  expect(sameUnit(local, { ...served, metrics: served.metrics.slice(1) })).toContain("metrics");
});

test("export, check, tamper, check: recipes/ is written once and --check sees every drift", () => {
  const repo = mkdtempSync(join(tmpdir(), "units-recipes-export-"));
  try {
    const first = exportRecipes(root, repo);
    expect(first.findings).toEqual([]);
    const source = JSON.parse(readFileSync(join(repo, "recipes/SOURCE.json"), "utf8"));
    expect(source.source_commit).toBe(reader.commit);
    expect(source.recipes).toEqual(index.map((r) => r.name));
    expect(Object.keys(source.held_back)).toContain("canaries");
    const idx = JSON.parse(readFileSync(join(repo, "recipes/index.json"), "utf8"));
    expect(idx.recipes.length).toBe(index.length);

    const clean = exportRecipes(root, repo, { check: true });
    expect([clean.changed, clean.extra]).toEqual([[], []]);

    const name = index[0]!.name;
    writeFileSync(join(repo, "recipes", name, "recipe.yml"), "name: edited\n");
    mkdirSync(join(repo, "recipes", name, "canaries"));
    writeFileSync(join(repo, "recipes", name, "canaries/planted.diff"), "x");
    const drift = exportRecipes(root, repo, { check: true });
    expect(drift.changed).toEqual([`${name}/recipe.yml`]);
    expect(drift.extra).toEqual([`${name}/canaries/planted.diff`]);

    exportRecipes(root, repo);
    const again = exportRecipes(root, repo, { check: true });
    expect([again.changed, again.extra]).toEqual([[], []]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}, 120_000);
