#!/usr/bin/env bun
// Reads the calibration the mainnet site recorded for every live unit and writes one record per
// recipe of this repository into scripts/public/site-calibrations/.
//
// A unit is calibrated by the site's reference runner when the site first serves its recipe. That
// calibration, signed by the runner, is what a new verifier has to reproduce (qualification), and it
// is public: GET /v1/lineages/:id. scripts/public/export-recipes.ts publishes these records as
// recipes/<name>/calibration-amd64.json of the recipes repository.
//
// This is NOT recipes/<name>/calibration-amd64.json of this repository: those files are the recipe
// authors' own amd64 measurements (on the capacity host, or read from the earlier test site), kept
// beside the recipe as a development record. The export publishes one of them only for a recipe that
// has no site record, and then only its calibration.
//
//   bun scripts/public/site-calibrations.ts            read the site, write the records
//   bun scripts/public/site-calibrations.ts --check    write nothing; exit 1 if a record would change
//   --site <url>   the address to read (default: app_url of config/sites.json). The backend address
//                  (mainnet_site_url) is read as well and must give the same answer.
//
// Read only: GET requests to public routes. A unit whose recipe is not a directory under recipes/
// (a unit made from an agent's recipe proposal) or is a fixture gets no record; index.json lists it
// with the reason.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recipeId, type Calibration, type Recipe } from "@units/protocol";

const ROOT = join(import.meta.dir, "../..");
export const SITE_CAL_DIR = "scripts/public/site-calibrations";

/** GET /v1/lineages/:id, the fields this script reads. */
export interface LineageView {
  lineage_id: string;
  repo: string;
  recipe_id: string;
  recipe: Recipe;
  calib_id: string;
  calibration: Calibration;
  calibration_by?: string;
  calibration_sig?: string;
  status: string;
}

/** A site-recorded calibration as it is committed here and published in the recipes repository. */
export interface SiteCalibration {
  _note: string;
  source: "site";
  network: "mainnet";
  site: string;
  lineage_id: string;
  recipe_id: string;
  calib_id: string;
  calibrated_by: string | null;
  calibration_sig: string | null;
  read_at: string;
  calibration: Calibration;
}

export interface SiteIndex {
  _note: string;
  network: "mainnet";
  site: string;
  read_at: string;
  units: { name: string; lineage_id: string; recipe_id: string; repo: string; status: string; record: string | null; reason?: string }[];
}

/** What the recipe of this repository must share with the recipe the site serves under its name. */
export function sameUnit(local: Pick<Recipe, "name" | "class" | "repo" | "commit" | "metrics">, served: Recipe): string | null {
  for (const k of ["name", "class", "repo", "commit"] as const) if (local[k] !== served[k]) return `${k} is ${served[k]} on the site, ${local[k]} here`;
  const a = local.metrics.map((m) => m.name).join(",");
  const b = served.metrics.map((m) => m.name).join(",");
  return a === b ? null : `metrics are ${b} on the site, ${a} here`;
}

/** The record of one unit. Throws when the site's own fields do not agree with each other. */
export function siteRecord(v: LineageView, site: string, readAt: string): SiteCalibration {
  if (recipeId(v.recipe) !== v.recipe_id) throw new Error(`${v.recipe.name}: the recipe the site serves does not hash to its recipe id`);
  if (v.calibration.recipe_id !== v.recipe_id) throw new Error(`${v.recipe.name}: the calibration is for another recipe id`);
  if (v.recipe.requires.arch !== "amd64") throw new Error(`${v.recipe.name}: the site's recipe is ${v.recipe.requires.arch}, not amd64`);
  return {
    _note: `The calibration the units mainnet site recorded for the unit of this recipe, as its Core serves it: GET ${site}/v1/lineages/${v.lineage_id} (fields calibration, calib_id, calibration_by, calibration_sig), read on ${readAt}. It is the baseline a verifier reproduces to qualify for the unit. Written by scripts/public/site-calibrations.ts; not edited by hand.`,
    source: "site",
    network: "mainnet",
    site,
    lineage_id: v.lineage_id,
    recipe_id: v.recipe_id,
    calib_id: v.calib_id,
    calibrated_by: v.calibration_by ?? null,
    calibration_sig: v.calibration_sig ?? null,
    read_at: readAt,
    calibration: v.calibration,
  };
}

/** A record without the fields that only say when it was read. */
const facts = (r: SiteCalibration) => JSON.stringify({ ...r, _note: "", read_at: "" });

async function getJson(origin: string, path: string): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(origin + path, { headers: { accept: "application/json" } });
    if (r.status === 429 && attempt < 5) {
      await new Promise((ok) => setTimeout(ok, Math.min(60, Math.max(1, Number(r.headers.get("retry-after") ?? 2))) * 1000));
      continue;
    }
    if (!r.ok) throw new Error(`GET ${origin}${path}: HTTP ${r.status}`);
    return r.json();
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const sites = JSON.parse(readFileSync(join(ROOT, "config/sites.json"), "utf8")) as { app_url: string; mainnet_site_url: string };
  const site = (argv.includes("--site") ? argv[argv.indexOf("--site") + 1]! : sites.app_url).replace(/\/+$/, "");
  const backend = sites.mainnet_site_url.replace(/\/+$/, "");
  const readAt = new Date().toISOString().slice(0, 10);
  const dir = join(ROOT, SITE_CAL_DIR);

  const list = (await getJson(site, "/v1/lineages")) as { lineage_id: string; recipe_name: string; recipe_id: string; repo: string; status: string }[];
  const index: SiteIndex = {
    _note: "The units the mainnet site serves (GET /v1/lineages) and the record written for each. Written by scripts/public/site-calibrations.ts.",
    network: "mainnet",
    site,
    read_at: readAt,
    units: [],
  };
  const records = new Map<string, SiteCalibration>();
  for (const u of [...list].sort((a, b) => a.recipe_name.localeCompare(b.recipe_name))) {
    const row = { name: u.recipe_name, lineage_id: u.lineage_id, recipe_id: u.recipe_id, repo: u.repo, status: u.status };
    const skip = (reason: string) => index.units.push({ ...row, record: null, reason });
    if (u.status !== "active") { skip(`status ${u.status}`); continue; }
    if (u.recipe_name.startsWith("fixture-")) { skip("a fixture recipe: a test of the software, not a public repository"); continue; }
    const yml = join(ROOT, "recipes", u.recipe_name, "recipe.yml");
    if (!existsSync(yml)) { skip("no recipe of this name in this repository: a unit made from a recipe proposal"); continue; }
    const v = (await getJson(site, `/v1/lineages/${u.lineage_id}`)) as LineageView;
    const differs = sameUnit(Bun.YAML.parse(readFileSync(yml, "utf8")) as unknown as Recipe, v.recipe);
    if (differs) { skip(`not the recipe of this repository: ${differs}`); continue; }
    if (records.has(u.recipe_name)) throw new Error(`${u.recipe_name}: two active units on the site`);
    const rec = siteRecord(v, site, readAt);
    if (backend !== site) {
      const b = (await getJson(backend, `/v1/lineages/${u.lineage_id}`)) as LineageView;
      if (facts(siteRecord(b, site, readAt)) !== facts(rec)) throw new Error(`${u.recipe_name}: ${site} and ${backend} give different calibrations`);
    }
    records.set(u.recipe_name, rec);
    index.units.push({ ...row, record: `${u.recipe_name}.json` });
  }

  // a record keeps its read date while its facts are unchanged
  const changed: string[] = [];
  const out = new Map<string, string>();
  for (const [name, rec] of records) {
    const f = join(dir, `${name}.json`);
    const old = existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as SiteCalibration) : null;
    if (old && facts(old) === facts(rec)) continue;
    changed.push(`${name}.json`);
    out.set(f, JSON.stringify(rec, null, 2) + "\n");
  }
  const stale = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json" && !records.has(f.slice(0, -5))) : [];
  const indexFile = join(dir, "index.json");
  const oldIndex = existsSync(indexFile) ? (JSON.parse(readFileSync(indexFile, "utf8")) as SiteIndex) : null;
  if (!oldIndex || JSON.stringify({ ...oldIndex, read_at: "" }) !== JSON.stringify({ ...index, read_at: "" })) {
    changed.push("index.json");
    out.set(indexFile, JSON.stringify(index, null, 2) + "\n");
  }
  for (const u of index.units) console.log(`${u.record ? "record " : "skipped"} ${u.name.padEnd(20)} ${u.lineage_id.slice(0, 12)} recipe ${u.recipe_id.slice(0, 12)}${u.reason ? `  (${u.reason})` : ""}`);
  if (!changed.length && !stale.length) {
    console.log(`site calibrations: ${SITE_CAL_DIR} is up to date with ${site} (${records.size} records)`);
    process.exit(0);
  }
  console.log(`site calibrations: ${check ? "would write" : "wrote"} ${changed.join(", ") || "nothing"}${stale.length ? `; ${check ? "would remove" : "removed"} ${stale.join(", ")} (no longer a live unit)` : ""}`);
  if (check) process.exit(1);
  mkdirSync(dir, { recursive: true });
  for (const f of stale) rmSync(join(dir, f));
  for (const [f, text] of out) writeFileSync(f, text);
}
