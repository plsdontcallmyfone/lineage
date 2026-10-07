// GPU BOX ONLY. Calibrates recipes/fixture-cuda in the real sandbox, evaluates every fixture patch
// against its parent series and judges each as a single replay, printing the outcome next to the
// expected one from index.json. Exit code 1 when any outcome differs from the expectation.
// Usage: bun fixtures/cuda-reduce-patches/check.ts [names...]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { judge, type CandidateView } from "@lineage/protocol";
import { calibrate, evaluate, loadRecipe, prepareDeps } from "@lineage/sandbox";

const ROOT = join(import.meta.dir, "..", "..");
const DIR = import.meta.dir;
const index = JSON.parse(readFileSync(join(DIR, "index.json"), "utf8"));
const loaded = loadRecipe(join(ROOT, "recipes", "fixture-cuda"));
const deps = await prepareDeps(loaded);
const { calibration } = await calibrate({ loaded, deps, seed: "c0ffee", runs: 3 });
console.log(`calibration: stable ${calibration.stable.length}, known failures ${calibration.known_failures.length}, quarantined ${calibration.quarantined.length}`);
for (const [m, v] of Object.entries(calibration.metrics)) console.log(`  ${m}: ${v.enabled ? "enabled" : "DISABLED"} cv=${v.cv} base=${v.base_value ?? "-"} ${v.reason ?? ""}`);

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(index);
const rows: Record<string, unknown>[] = [];
let mismatches = 0;
for (const name of names) {
  const meta = index[name];
  const patch = readFileSync(join(DIR, `${name}.diff`), "utf8");
  const parents = meta.parent.map((p: string) => readFileSync(join(DIR, `${p}.diff`), "utf8"));
  const t0 = Date.now();
  const { result } = await evaluate({ loaded, deps, parentPatches: parents, candidatePatch: patch, seed: "5eed" + name.length });
  const cand: CandidateView = { candidate_id: name, author: "author", kind: meta.kind, target: meta.target };
  const j = judge(loaded.recipe, calibration, cand, [{ replay_id: "r1", replayer: "v1", seed: "s", result }], { quorum: 1, det_tolerance: 0.001, bootstrap_resamples: 2000 });
  const got = j.outcome + (j.reason ? ":" + j.reason : "");
  // expect starts with the outcome token: "accepted" or "rejected:<reason>"
  const want = String(meta.expect).split(" ")[0]!;
  const ok = got === want;
  if (!ok) mismatches++;
  const eff = j.effect && "ratio" in j.effect ? ` ratio=${j.effect.ratio.toFixed(4)}` : "";
  const m = result.metrics[Array.isArray(meta.target) ? "" : meta.target];
  console.log(`${ok ? "OK  " : "DIFF"} ${name.padEnd(20)} ${got.padEnd(32)}${eff.padEnd(16)} ${((Date.now() - t0) / 1000).toFixed(1)}s | expect ${meta.expect}`);
  rows.push({ name, outcome: got, expected: meta.expect, ok, base: m?.base, cand: m?.cand, guard: result.guard, tests_cand_fail: result.tests.cand_fail, equivalence: result.equivalence });
}
writeFileSync(join(DIR, "check-last.json"), JSON.stringify({ at: new Date().toISOString(), calibration, rows }, null, 2) + "\n");
console.log(`${names.length - mismatches}/${names.length} outcomes as expected; wrote ${join(DIR, "check-last.json")}`);
process.exit(mismatches ? 1 : 0);
