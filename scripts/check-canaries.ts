// Evaluates a recipe's canary (or candidate) patches against the snapshot with the real sandbox
// and judges each as a single honest replay, printing the verdict next to the expected one.
// Uses recipes/<name>/calibration.json when its recipe_id matches, otherwise calibrates (3 runs).
// Writes the measured verdicts to recipes/<name>/<set>/results.json.
// Usage: bun scripts/check-canaries.ts recipes/<name> [canaries|candidates] [patch names...] [--seed <hex>]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { judge, type Calibration, type CandidateView } from "@lineage/protocol";
import { calibrate, evaluate, loadRecipe, prepareDeps } from "@lineage/sandbox";

const args = process.argv.slice(2);
const seedIdx = args.indexOf("--seed");
const seedOpt = seedIdx >= 0 ? args.splice(seedIdx, 2)[1] : undefined;
const [dirArg, setArg, ...names] = args;
if (!dirArg) {
  console.error("usage: bun scripts/check-canaries.ts recipes/<name> [canaries|candidates] [names...] [--seed <hex>]");
  process.exit(2);
}
const dir = resolve(dirArg);
const set = setArg ?? "canaries";
const index = JSON.parse(readFileSync(join(dir, set, "index.json"), "utf8")) as Record<string, { kind: "perf" | "fix" | "slim"; target: string | string[]; expect: string }>;
const loaded = loadRecipe(dir);
const deps = await prepareDeps(loaded);

let calibration: Calibration;
const calFile = join(dir, "calibration.json");
const saved = existsSync(calFile) ? JSON.parse(readFileSync(calFile, "utf8")) : null;
if (saved && saved.recipe_id === loaded.recipe_id) {
  calibration = saved as Calibration;
  console.log(`using ${calFile}`);
} else {
  console.log("calibration.json missing or stale for this recipe id: calibrating (3 runs)");
  calibration = (await calibrate({ loaded, deps, seed: "c0ffee", runs: 3 })).calibration;
}

const results: Record<string, unknown> = existsSync(join(dir, set, "results.json")) ? JSON.parse(readFileSync(join(dir, set, "results.json"), "utf8")) : {};
let mismatches = 0;
for (const name of names.length ? names : Object.keys(index)) {
  const meta = index[name];
  if (!meta) throw new Error(`no ${set} patch named ${name}`);
  const patch = readFileSync(join(dir, set, `${name}.diff`), "utf8");
  const seed = seedOpt ?? Buffer.from(`replay-${name}`).toString("hex").slice(0, 16);
  const t0 = Date.now();
  const { result, transcript } = await evaluate({ loaded, deps, parentPatches: [], candidatePatch: patch, seed });
  const cand: CandidateView = { candidate_id: name, author: "author", kind: meta.kind, target: meta.target };
  const j = judge(loaded.recipe, calibration, cand, [{ replay_id: "r1", replayer: "v1", seed, result }], { quorum: 1, det_tolerance: 0.001, bootstrap_resamples: 2000 });
  const got = j.outcome === "accepted" ? "accepted" : `${j.outcome}${j.reason ? ":" + j.reason : ""}`;
  const ok = j.outcome === "accepted" ? meta.expect === "accepted" : j.reason === meta.expect;
  if (!ok) mismatches++;
  const ratio = j.effect && "ratio" in j.effect ? j.effect.ratio : undefined;
  const metrics = Object.fromEntries(Object.entries(result.metrics).map(([k, v]) => [k, { base: v.base, cand: v.cand, ratio: v.base.length && v.cand.length ? v.cand[0]! / v.base[0]! : null }]));
  const secs = (Date.now() - t0) / 1000;
  console.log(`${name.padEnd(18)} ${got.padEnd(34)} ${ratio !== undefined ? `ratio=${ratio.toFixed(5)}` : ""} ${secs.toFixed(1)}s | expect ${meta.expect} ${ok ? "OK" : "MISMATCH"}`);
  if (j.detail) console.log(`  detail: ${j.detail}`);
  for (const [k, v] of Object.entries(metrics)) console.log(`  ${k}: base ${v.base.join(",")} cand ${v.cand.join(",")} ratio ${v.ratio?.toFixed(5)}`);
  if (transcript.notes.length) console.log(`  notes: ${transcript.notes.join(" | ").slice(0, 600)}`);
  results[name] = {
    expect: meta.expect,
    outcome: j.outcome,
    reason: j.reason ?? null,
    detail: j.detail ?? null,
    effect: j.effect ?? null,
    metrics,
    equivalence: result.equivalence ? (result.equivalence.base_digest === result.equivalence.cand_digest ? "same" : "changed") : null,
    seed,
    recipe_id: loaded.recipe_id,
    eval_seconds: Math.round(secs * 10) / 10,
    date: new Date().toISOString(),
    match: ok,
  };
  writeFileSync(join(dir, set, "results.json"), JSON.stringify(results, null, 2) + "\n");
}
process.exit(mismatches ? 1 : 0);
