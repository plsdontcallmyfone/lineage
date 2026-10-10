#!/usr/bin/env bun
// Fresh clone or lost images (RUNBOOK "Fresh clone or lost images").
//
//   bun scripts/local-images.ts [--build] [--skip solana,...] [recipe ...]
//
// Recipes pin sandbox images by local Docker image id, and Docker builds are not reproducible, so a
// fresh clone (or a machine that lost its lineage images) cannot run them as committed. This builds
// (with --build) every image class the named recipes need (default: every recipe except cuda, which
// needs an amd64 host with an NVIDIA GPU) from images/<class>, tagged as the recipe pins it
// (`lineage/<class>:<tag>`, the RUNBOOK "Prerequisites" tags), then writes this machine's local pin
// map (packages/sandbox/src/local-images.ts; default ~/.lineage/local-images.json, never committed)
// from each committed id to the local image id. The sandbox runs the local rebuild only when the
// committed id is absent, and logs it. Recipe files and recipe ids are left unchanged: that is for
// local tests and development. For a worker serving a real Core, re-pin with
// scripts/deploy/arch-recipes.ts instead (new recipe ids) and set LINEAGE_LOCAL_IMAGES=off.
// Without --build, maps the images already tagged here. Only lineage/* images are built or read;
// nothing is removed or pushed.
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  imageClass,
  loadRecipe,
  localImageId,
  localImagesPath,
  parsePinnedImage,
  readLocalImageMap,
  writeLocalImageMap,
} from "@lineage/sandbox";

const ROOT = join(import.meta.dir, "..");
const argv = process.argv.slice(2);
const BUILD = argv.includes("--build");
const skipArg = argv.indexOf("--skip");
const skip = new Set(skipArg >= 0 ? (argv[skipArg + 1] ?? "").split(",").filter(Boolean) : []);
const named = argv.filter((a, i) => !a.startsWith("--") && !(skipArg >= 0 && i === skipArg + 1));
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("usage: bun scripts/local-images.ts [--build] [--skip class,...] [recipe ...]");
  process.exit(0);
}

const mapPath = localImagesPath();
if (!mapPath) {
  console.error("LINEAGE_LOCAL_IMAGES is off; unset it (or point it at a file) to write a local pin map");
  process.exit(2);
}

const all = readdirSync(join(ROOT, "recipes")).filter((n) => existsSync(join(ROOT, "recipes", n, "recipe.yml")));
for (const n of named) if (!all.includes(n)) throw new Error(`no recipe ${n} in recipes/`);

// ref -> { committed ids, recipes, arch } for every image the chosen recipes pin
interface Need { cls: string; ids: Set<string>; recipes: string[]; arch: Set<string> }
const needs = new Map<string, Need>();
for (const name of named.length ? named : all) {
  const r = loadRecipe(join(ROOT, "recipes", name)).recipe;
  const pin = parsePinnedImage(r.image);
  const cls = pin && imageClass(pin.ref);
  if (!pin || !cls) throw new Error(`${name}: image ${r.image} is not a pinned lineage/<class>:<tag>`);
  if (!named.length && cls === "cuda") continue;
  if (skip.has(cls)) continue;
  const n = needs.get(pin.ref) ?? { cls, ids: new Set(), recipes: [], arch: new Set() };
  n.ids.add(pin.id);
  n.recipes.push(name);
  if (r.requires?.arch) n.arch.add(r.requires.arch);
  needs.set(pin.ref, n);
}

const map = readLocalImageMap(mapPath);
let missing = 0;
for (const [ref, n] of [...needs].sort()) {
  const context = join("images", n.cls);
  if (BUILD) {
    if (!existsSync(join(ROOT, context, "Dockerfile"))) throw new Error(`${ref}: no ${context}/Dockerfile`);
    console.log(`building ${ref} from ${context} (${n.recipes.length} recipe${n.recipes.length > 1 ? "s" : ""})`);
    const b = Bun.spawnSync(["docker", "build", "-q", "--label", "lineage=1", "-t", ref, context], { cwd: ROOT, stdout: "pipe", stderr: "inherit" });
    if (b.exitCode !== 0) throw new Error(`${ref}: docker build failed`);
  }
  const local = localImageId(ref);
  if (!local) {
    console.log(`${ref}: not built here (run with --build)`);
    missing++;
    continue;
  }
  const arch = Bun.spawnSync(["docker", "image", "inspect", "--format", "{{.Architecture}}", local]).stdout.toString().trim();
  for (const id of n.ids) {
    if (id === local || localImageId(`sha256:${id}`)) {
      // the committed image is on this machine: nothing to substitute
      if (map.images[id]) delete map.images[id];
      console.log(`${ref}: committed ${id.slice(0, 12)} present, no substitution`);
      continue;
    }
    map.images[id] = { ref, local, context, built_at: new Date().toISOString() };
    console.log(`${ref}: committed ${id.slice(0, 12)} -> local rebuild ${local.slice(0, 12)} (${n.recipes.join(", ")})`);
  }
  for (const want of n.arch) {
    if (want !== arch) console.log(`  warning: ${ref} built here is ${arch} but ${n.recipes.join(", ")} require ${want}; such recipes run only after scripts/deploy/arch-recipes.ts re-pins them (new recipe ids)`);
  }
}
writeLocalImageMap(map, mapPath);
console.log(`local pin map: ${mapPath} (${Object.keys(map.images).length} substitution${Object.keys(map.images).length === 1 ? "" : "s"}); recipe ids unchanged, for local tests and development only`);
if (missing) process.exit(1);
