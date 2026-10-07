// Parameterised single-replay judge for a fixture patch set (adapted from fixtures/check-patches.ts):
// evaluates every patch against its parent with the real sandbox, judges it as one replay, and
// prints the outcome next to what the patch is expected to produce. Writes results.json.
// Usage: bun fixtures/cu-tally-patches/check.ts [--recipe recipes/<name>] [--patches <dir>] [names...]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { judge, type Calibration, type CandidateView } from "@lineage/protocol";
import { calibrate, evaluate, loadRecipe, prepareDeps } from "@lineage/sandbox";

const ROOT = join(import.meta.dir, "..", "..");
const args = process.argv.slice(2);
const take = (flag: string, dflt: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args.splice(i, 2)[1]! : dflt;
};
const recipeDir = resolve(take("--recipe", join(ROOT, "recipes", "fixture-cu-tally")));
const DIR = resolve(take("--patches", import.meta.dir));
const index = JSON.parse(readFileSync(join(DIR, "index.json"), "utf8"));
const loaded = loadRecipe(recipeDir);
const deps = await prepareDeps(loaded);
const calFile = join(recipeDir, "calibration.json");
const saved = existsSync(calFile) ? JSON.parse(readFileSync(calFile, "utf8")) : null;
const calibration: Calibration =
  saved && saved.recipe_id === loaded.recipe_id ? saved : (await calibrate({ loaded, deps, seed: "c0ffee", runs: 3 })).calibration;
const names = args.length ? args : Object.keys(index);
const out: Record<string, unknown> = existsSync(join(DIR, "results.json")) ? JSON.parse(readFileSync(join(DIR, "results.json"), "utf8")) : {};
let mismatches = 0;
for (const name of names) {
  const meta = index[name];
  const patch = readFileSync(join(DIR, `${name}.diff`), "utf8");
  const parents = meta.parent.map((p: string) => readFileSync(join(DIR, `${p}.diff`), "utf8"));
  const seed = Buffer.from(`replay-${name}`).toString("hex").slice(0, 16);
  const t0 = Date.now();
  const { result, transcript } = await evaluate({ loaded, deps, parentPatches: parents, candidatePatch: patch, seed });
  const cand: CandidateView = { candidate_id: name, author: "author", kind: meta.kind, target: meta.target };
  const j = judge(loaded.recipe, calibration, cand, [{ replay_id: "r1", replayer: "v1", seed, result }], { quorum: 1, det_tolerance: 0.001, bootstrap_resamples: 2000 });
  const got = j.outcome === "accepted" ? "accepted" : `${j.outcome}:${j.reason === "guard" ? "guard " + j.detail : j.reason}`;
  const ok = meta.expect.startsWith(got);
  if (!ok) mismatches++;
  const ratio = j.effect && "ratio" in j.effect ? j.effect.ratio : undefined;
  const metrics = Object.fromEntries(Object.entries(result.metrics).map(([k, v]) => [k, { base: v.base, cand: v.cand, ratio: v.base.length && v.cand.length ? v.cand[0]! / v.base[0]! : null }]));
  const secs = (Date.now() - t0) / 1000;
  console.log(`${name.padEnd(20)} ${got.padEnd(34)} ${ratio !== undefined ? `ratio=${ratio.toFixed(5)}` : ""} ${secs.toFixed(1)}s | expect ${meta.expect} ${ok ? "OK" : "MISMATCH"}`);
  if (j.detail) console.log(`  detail: ${j.detail}`);
  for (const [k, v] of Object.entries(metrics)) console.log(`  ${k}: base ${v.base.join(",")} cand ${v.cand.join(",")} ratio ${v.ratio?.toFixed(5)}`);
  if (transcript.notes.length) console.log(`  notes: ${transcript.notes.join(" | ").slice(0, 600)}`);
  out[name] = {
    expect: meta.expect,
    outcome: j.outcome,
    reason: j.reason ?? null,
    detail: j.detail ?? null,
    ratio: ratio ?? null,
    metrics,
    equivalence: result.equivalence ? (result.equivalence.base_digest === result.equivalence.cand_digest ? "same" : "changed") : null,
    seed,
    recipe_id: loaded.recipe_id,
    eval_seconds: Math.round(secs * 10) / 10,
    match: ok,
  };
  writeFileSync(join(DIR, "results.json"), JSON.stringify(out, null, 2) + "\n");
}
process.exit(mismatches ? 1 : 0);
