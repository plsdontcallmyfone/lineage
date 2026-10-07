// Loads a recipe, prepares its dependency layer, calibrates it in real sandboxes (SPEC 6) and
// writes recipes/<name>/calibration.json. Every number in that file comes from this run.
// Usage: bun scripts/calibrate-recipe.ts recipes/<name> [--runs 5] [--seed <hex>] [--force-prepare]
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { calibrate, imageDigest, loadRecipe, prepareDeps } from "@lineage/sandbox";

const args = process.argv.slice(2);
const dir = args[0];
if (!dir || dir.startsWith("--")) {
  console.error("usage: bun scripts/calibrate-recipe.ts recipes/<name> [--runs 5] [--seed <hex>] [--force-prepare]");
  process.exit(2);
}
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const runs = Number(opt("--runs") ?? 5);
const seed = opt("--seed") ?? "ca11b7a7e";

const loaded = loadRecipe(resolve(dir));
console.log(`recipe ${loaded.recipe.name} id ${loaded.recipe_id}`);
const t0 = performance.now();
const deps = await prepareDeps(loaded, { force: args.includes("--force-prepare") });
const prepareSeconds = (performance.now() - t0) / 1000;
console.log(`deps ${deps.digest} (${prepareSeconds.toFixed(1)} s, cached when ~0)`);
const image = await imageDigest(loaded.recipe.image);
const t1 = performance.now();
const { calibration, transcript, snapshot_commit } = await calibrate({ loaded, deps, seed, runs });
const calibSeconds = (performance.now() - t1) / 1000;

const out = {
  ...calibration,
  recipe_name: loaded.recipe.name,
  repo: loaded.recipe.repo,
  commit: snapshot_commit,
  deps_digest: deps.digest,
  image_digest: image,
  seed,
  date: new Date().toISOString(),
  calibration_wall_seconds: Math.round(calibSeconds * 10) / 10,
  counts: { stable: calibration.stable.length, known_failures: calibration.known_failures.length, quarantined: calibration.quarantined.length, excluded: (loaded.recipe.test.exclude ?? []).length },
  notes: transcript.notes,
};
const file = join(resolve(dir), "calibration.json");
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(`stable ${out.counts.stable}, known failures ${out.counts.known_failures}, quarantined ${out.counts.quarantined}, excluded ${out.counts.excluded}`);
for (const [name, m] of Object.entries(calibration.metrics)) {
  console.log(`metric ${name}: ${m.enabled ? "enabled" : "DISABLED"} cv=${m.cv.toExponential(3)} base=${m.base_value ?? "-"}${m.reason ? " (" + m.reason + ")" : ""}`);
}
console.log(`median_eval_seconds ${calibration.median_eval_seconds}, calibration wall ${calibSeconds.toFixed(1)} s`);
for (const s of transcript.steps.filter((s) => s.exit !== 0 && s.step !== "test")) console.log(`step ${s.step} exit ${s.exit}: ${s.stderr_tail.slice(-500)}`);
console.log(`wrote ${file}`);
