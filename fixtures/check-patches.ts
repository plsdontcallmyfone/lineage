// Evaluates every fixture patch against its parent with the real sandbox and judges it as a
// single replay, printing the outcome next to what the patch is expected to produce.
// Usage: bun fixtures/check-patches.ts [names...]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { judge, type CandidateView } from "@lineage/protocol";
import { calibrate, evaluate, loadRecipe, prepareDeps } from "@lineage/sandbox";

const ROOT = join(import.meta.dir, "..");
const DIR = join(ROOT, "fixtures", "b58-patches");
const index = JSON.parse(readFileSync(join(DIR, "index.json"), "utf8"));
const loaded = loadRecipe(join(ROOT, "recipes", "fixture-b58"));
const deps = await prepareDeps(loaded);
const { calibration } = await calibrate({ loaded, deps, seed: "c0ffee", runs: 3 });
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(index);
for (const name of names) {
  const meta = index[name];
  const patch = readFileSync(join(DIR, `${name}.diff`), "utf8");
  const parents = meta.parent.map((p: string) => readFileSync(join(DIR, `${p}.diff`), "utf8"));
  const t0 = Date.now();
  const { result } = await evaluate({ loaded, deps, parentPatches: parents, candidatePatch: patch, seed: "5eed" + name.length });
  const cand: CandidateView = { candidate_id: name, author: "author", kind: meta.kind, target: meta.target };
  const j = judge(loaded.recipe, calibration, cand, [{ replay_id: "r1", replayer: "v1", seed: "s", result }], { quorum: 1, det_tolerance: 0.001, bootstrap_resamples: 2000 });
  const eff = j.effect && "ratio" in j.effect ? ` ratio=${j.effect.ratio.toFixed(4)}` : j.effect ? ` fixed=${(j.effect as any).fixed.length}` : "";
  console.log(`${name.padEnd(20)} ${(j.outcome + (j.reason ? ":" + j.reason : "")).padEnd(32)}${eff.padEnd(16)} ${((Date.now() - t0) / 1000).toFixed(1)}s | expect ${meta.expect}`);
}
