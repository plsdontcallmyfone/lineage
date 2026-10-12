#!/usr/bin/env bun
// One base run of a recipe on this machine, timed: what a verifier's qualification runs (calibrate with
// one run: prepare, build, tests, every metric once on the unpatched tree). Used to compare machines
// (docs/plans/SCALE-OUT.md section 8): metrics are instruction counts and must be equal, wall time is
// what differs.   bun scripts/deploy/capacity-host/time-base.ts <recipe name> [seed hex]
import { join } from "node:path";
import { calibrate, loadRecipe, prepareDeps } from "@units/sandbox";

const [name, seed = "5eed5eed5eed5eed"] = process.argv.slice(2);
if (!name || !/^[a-z0-9-]+$/.test(name)) throw new Error("usage: time-base.ts <recipe name> [seed]");
const loaded = loadRecipe(join(import.meta.dir, "../../../recipes", name));
let t = performance.now();
const deps = await prepareDeps(loaded);
const deps_s = (performance.now() - t) / 1000;
t = performance.now();
const { calibration, transcript } = await calibrate({ loaded, deps, seed, runs: 1 });
const run_s = (performance.now() - t) / 1000;
const steps = (transcript as { steps?: { name?: string; step?: string; duration_ms: number }[] }).steps ?? [];
console.log(JSON.stringify({
  recipe: name, recipe_id: loaded.recipe_id, deps_prepare_s: +deps_s.toFixed(1), base_run_s: +run_s.toFixed(1),
  sandbox_s: +(steps.reduce((a, s) => a + s.duration_ms, 0) / 1000).toFixed(1),
  steps: steps.map((s) => [s.name ?? s.step ?? "?", +(s.duration_ms / 1000).toFixed(1)]),
  stable_tests: (calibration as { stable?: string[] }).stable?.length ?? null,
  metrics: calibration.metrics,
}));
