#!/usr/bin/env bun
// One standalone Claude authoring attempt on a calibrated recipe, without Core: materialise gen 0,
// let the proposer explore, edit and self-evaluate in the real sandbox, then print the resulting
// patch and the proposer's measured outcome. Spend is capped.
// Usage: bun scripts/try-proposer.ts recipes/<name> [--max-usd 2] [--effort high] [--out <dir>]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalizeDiff } from "@lineage/protocol";
import { diffWorkingTree, loadRecipe, materialize, newWorkDir, prepareDeps, removeTree } from "@lineage/sandbox";
import { AnthropicProposer } from "../packages/worker/src/proposers/anthropic.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
const dir = resolve(argv.find((a) => !a.startsWith("--")) ?? "recipes/minbpe");

for (const line of readFileSync(`${process.env.HOME}/.config/lineage/model.env`, "utf8").split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}

const loaded = loadRecipe(dir);
const calib = JSON.parse(readFileSync(join(dir, "calibration.json"), "utf8"));
const calibration = calib.calibration ?? calib;
if ((calib.recipe_id ?? calibration.recipe_id) !== loaded.recipe_id) throw new Error("calibration.json is for a different recipe id; recalibrate first");
const deps = await prepareDeps(loaded);
const work = newWorkDir("try-proposer");
const tree = join(work, "src");
const t0 = Date.now();
try {
  materialize(loaded.recipe.repo, loaded.recipe.commit, loaded.overlayDir, tree);
  const outputs = join(deps.dir, "outputs");
  if (existsSync(outputs)) {
    Bun.spawnSync(["cp", "-R", `${outputs}/.`, tree]);
    Bun.spawnSync(["git", "add", "-A"], { cwd: tree });
    Bun.spawnSync(["git", "-c", "user.name=l", "-c", "user.email=l@l", "commit", "-q", "-m", "prepare outputs"], { cwd: tree });
  }
  const findings = [
    ...calibration.known_failures.map((t: string) => ({ key: t, kind: "known_failure", target: t })),
    ...loaded.recipe.metrics.filter((m) => calibration.metrics[m.name]?.enabled).map((m) => ({ key: m.name, kind: "metric_target", target: m.name })),
  ];
  const p = new AnthropicProposer({ max_usd: Number(opt("max-usd") ?? 2), effort: (opt("effort") as never) ?? "high" });
  const proposal = await p.propose({
    loaded,
    deps,
    calibration,
    parentPatches: [],
    findings,
    tree,
    seed: "a11ce5eed0000001",
    log: (m) => console.log(`[proposer] ${m}`),
  });
  const raw = diffWorkingTree(tree);
  const diff = raw.trim() ? canonicalizeDiff(raw) : "";
  const result = { recipe: loaded.recipe.name, at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), proposal, diff_lines: diff.split("\n").length };
  console.log(JSON.stringify(result, null, 2));
  const out = opt("out") ?? join(dir, "claude-attempts");
  mkdirSync(out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(out, `${stamp}.json`), JSON.stringify(result, null, 2) + "\n");
  if (diff) writeFileSync(join(out, `${stamp}.diff`), diff);
  if (diff) console.log(diff.slice(0, 6000));
} finally {
  removeTree(work);
}
