#!/usr/bin/env bun
// Re-run any final candidate yourself (PARITY: "artifact replay"). Fetches the candidate, its parent
// patch series and the revealed replays from Core's public API, replays it in your local sandbox
// with the same seed the verifiers used, and compares every deterministic field with what they
// revealed. Trusts nothing Core or the verifiers said.
//
// Usage: bun scripts/replay.ts --core http://127.0.0.1:9660 --candidate <commit or candidate id>
import { median, relDiff } from "@lineage/protocol";
import { evaluate, loadRecipe, prepareDeps } from "@lineage/sandbox";
import { RecipeBook } from "../packages/worker/src/recipes.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
const CORE = opt("core") ?? "http://127.0.0.1:9660";
const id = opt("candidate");
if (!id) {
  console.error("--candidate <id> required");
  process.exit(2);
}
const get = async (p: string) => {
  const r = await fetch(CORE + p);
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
  return r.json() as Promise<any>;
};

const c = await get(`/v1/candidates/${id}`);
if (!["accepted", "rejected"].includes(c.status)) throw new Error(`candidate is ${c.status}; only final candidates have public replays`);
if (!c.patch) throw new Error("candidate has no revealed patch");
const lineage = await get(`/v1/lineages/${c.lineage_id}`);
const tree = await get(`/v1/lineages/${c.lineage_id}/tree?gen=${c.eval_parent_gen_id}`);
const book = new RecipeBook();
if (!book.has(lineage.recipe_id)) throw new Error(`recipe ${lineage.recipe_id.slice(0, 12)} not in your local recipes/ directory`);
const loaded = book.get(lineage.recipe_id);
const deps = await prepareDeps(loaded);
if (deps.digest !== tree.deps_digest) console.log(`warning: your dependency layer ${deps.digest.slice(0, 12)} differs from the snapshot's ${tree.deps_digest.slice(0, 12)}`);

const revealed = c.replays.filter((r: any) => r.stage === c.stage && !r.audit_id && r.result);
if (!revealed.length) throw new Error("no revealed replays for the final stage");
const seed: string = revealed[0].seed;
console.log(`replaying ${c.kind} ${JSON.stringify(c.target)} on ${lineage.repo} (parent height ${tree.height}, seed ${seed.slice(0, 16)}), ${revealed.length} revealed replays to compare`);
const t0 = Date.now();
const mine = (await evaluate({ loaded, deps, parentPatches: tree.patches.map((p: any) => p.patch), candidatePatch: c.patch, seed, enabledMetrics: Object.entries((lineage.calibration?.metrics ?? {}) as Record<string, { enabled: boolean }>).filter(([, m]) => m.enabled).map(([n]) => n) })).result;
console.log(`local replay done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const sorted = (xs: string[]) => [...xs].sort().join(",");
let mismatches = 0;
const row = (field: string, ok: boolean, detail: string) => {
  if (!ok) mismatches++;
  console.log(`${ok ? "same" : "DIFF"}  ${field.padEnd(22)} ${detail}`);
};
for (const r of revealed.filter((x: any) => x.seed === seed)) {
  const t = r.result;
  console.log(`\nvs ${r.kind} ${String(r.replayer).slice(0, 8)}`);
  row("apply", t.apply === mine.apply, `${mine.apply} / ${t.apply}`);
  row("guard", t.guard === mine.guard, `${mine.guard} / ${t.guard}`);
  row("build", t.build.cand === mine.build.cand, `${mine.build.cand} / ${t.build.cand}`);
  if (loaded.recipe.build.reproducible) row("artifact digest", t.build.cand_digest === mine.build.cand_digest, `${String(mine.build.cand_digest).slice(0, 12)} / ${String(t.build.cand_digest).slice(0, 12)}`);
  row("candidate tests", sorted(t.tests.cand_pass) === sorted(mine.tests.cand_pass), `${mine.tests.cand_pass.length} / ${t.tests.cand_pass.length} passing`);
  if (mine.equivalence && t.equivalence) row("equivalence", JSON.stringify(t.equivalence) === JSON.stringify(mine.equivalence), mine.equivalence.base_digest === mine.equivalence.cand_digest ? "outputs identical" : "outputs differ");
  for (const m of loaded.recipe.metrics.filter((m) => m.deterministic)) {
    const a = mine.metrics[m.name];
    const b = t.metrics[m.name];
    if (!a || !b || !a.cand.length || !b.cand.length) continue;
    const tol = m.tolerance ?? 0.001;
    const ok = relDiff(median(a.base), median(b.base)) <= tol && relDiff(median(a.cand), median(b.cand)) <= tol;
    row(`metric ${m.name}`, ok, `base ${median(a.base)} / ${median(b.base)}, cand ${median(a.cand)} / ${median(b.cand)}`);
  }
}
console.log(`\n${mismatches === 0 ? "REPRODUCED: your machine got the same deterministic results as the network" : `${mismatches} field(s) differ from the revealed replays`}`);
process.exit(mismatches ? 1 : 0);
