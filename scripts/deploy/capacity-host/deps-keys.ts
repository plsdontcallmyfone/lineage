#!/usr/bin/env bun
// The dependency layer directory names (under UNITS_HOME/deps) of the named recipes in this release,
// one per line: "<key> <recipe>".   bun scripts/deploy/capacity-host/deps-keys.ts fixture-b58,minbpe
import { join } from "node:path";
import { H } from "@units/protocol";
import { loadRecipe } from "@units/sandbox";

for (const name of (process.argv[2] ?? "").split(",").filter((n) => /^[a-z0-9-]+$/.test(n))) {
  try {
    console.log(`${H("deps", loadRecipe(join(import.meta.dir, "../../../recipes", name)).recipe_id).slice(0, 32)} ${name}`);
  } catch {
    /* a recipe the release does not have is skipped */
  }
}
