#!/usr/bin/env bun
// Clones (or checks) the repository mirror of each named recipe on this host, one after the other, so
// the first evaluations that arrive together do not race for the same clone (seen in the two-machine
// proof: "fixture bare clone ... File exists").   bun scripts/deploy/capacity-host/warm.ts fixture-b58,minbpe
import { join } from "node:path";
import { loadRecipe, materialize, newWorkDir, removeTree } from "@units/sandbox";

for (const name of (process.argv[2] ?? "").split(",").filter((n) => /^[a-z0-9-]+$/.test(n))) {
  const work = newWorkDir("warm");
  try {
    const l = loadRecipe(join(import.meta.dir, "../../../recipes", name));
    const t = performance.now();
    materialize(l.recipe.repo, l.recipe.commit, l.overlayDir, join(work, "src"));
    console.log(`${name}: mirror ready (${((performance.now() - t) / 1000).toFixed(1)} s)`);
  } catch (e) {
    console.log(`${name}: not warmed (${(e as Error).message.split("\n")[0]!.slice(0, 160)})`);
  } finally {
    removeTree(work);
  }
}
