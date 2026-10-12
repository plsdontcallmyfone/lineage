#!/usr/bin/env bun
// How much of a recipe's instruction-count metric is not the library's work (docs/plans/AGENT-EFFICIENCY.md
// section 5): for a Python recipe at a lineage's tip, the instructions of the metric command against the
// instructions of starting the interpreter and importing the benchmark harness with everything it
// imports (`python -c "import lineage_bench"`, the same cachegrind flags and environment, the library's
// own import included). A change to the library can only move the rest, and the minimum improvement is
// taken on the whole count. Measured locally in the recipe's image; arm64 counts differ from the site's
// amd64 counts, the share is what matters.
//
//   bun scripts/efficiency/fixed-share.ts --recipe base58-py --tree <tree.json> [--seed 5eed] [--json out.json]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyPatch, loadRecipe, materialize, newWorkDir, prepareDeps, removeTree } from "@units/sandbox";
import { runnableImage } from "../../packages/sandbox/src/docker.ts";

const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const recipe = opt("recipe")!;
const seed = opt("seed", "5eed")!;
const loaded = loadRecipe(resolve("recipes", recipe));
const tip = opt("tree") ? JSON.parse(readFileSync(opt("tree")!, "utf8")) : null;
const deps = await prepareDeps(loaded);
const work = newWorkDir("fixed-share");
const tree = join(work, "src");
const VG = "PYTHONPYCACHEPREFIX=/deps/pycache valgrind --tool=cachegrind --cache-sim=no --cachegrind-out-file=/dev/null";

function ir(cmd: string): number {
  const p = Bun.spawnSync([
    "docker", "run", "--rm", "--hostname", "lineage", "--label", "lineage=1", "--label", "units=1", "--network", "none", "--read-only", "--tmpfs", "/tmp:rw,exec,size=512m",
    "--volume", `${tree}:/work/src:ro`, "--volume", `${join(deps.dir, "layer")}:/deps:ro`, "--workdir", loaded.recipe.workdir ?? "/work/src",
    "--env", "TZ=UTC", "--env", "LANG=C.UTF-8", "--env", "CI=1", "--env", "HOME=/tmp", "--env", "PYTHONHASHSEED=0", "--env", "CARGO_INCREMENTAL=0", "--env", "VIRTUAL_ENV=/deps/venv", "--env", "PATH=/deps/venv/bin:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "--env", `LINEAGE_SEED=${seed}`,
    runnableImage(loaded.recipe.image), "sh", "-c", cmd,
  ]);
  if (p.exitCode !== 0) throw new Error(`exit ${p.exitCode} from: ${cmd}\n${p.stderr.toString().slice(-600)}`);
  const m = /I\s+refs:\s+([\d,]+)/.exec(p.stderr.toString());
  if (!m) throw new Error(`no instruction count from: ${cmd}\n${p.stderr.toString().slice(-400)}`);
  return Number(m[1]!.replace(/,/g, ""));
}

try {
  materialize(loaded.recipe.repo, loaded.recipe.commit, loaded.overlayDir, tree);
  for (const p of tip?.patches ?? []) if (!applyPatch(tree, p.patch)) throw new Error("a tip patch does not apply locally");
  if (!existsSync(join(tree, "lineage_bench.py"))) throw new Error("this script is for recipes whose harness is lineage_bench.py");
  const start = ir(`${VG} python -c "pass"`);
  const imports = ir(`${VG} python -c "import lineage_bench"`);
  const rows = loaded.recipe.metrics
    .filter((m) => m.parser === "cachegrind-ir")
    .map((m) => {
      const total = ir(m.command);
      return { metric: m.name, ir: total, interpreter_and_imports_ir: imports, fixed_share_pct: Number(((100 * imports) / total).toFixed(1)), min_effect_pct: m.min_effect * 100, min_effect_of_the_rest_pct: Number(((100 * m.min_effect * total) / (total - imports)).toFixed(2)) };
    });
  const out = { recipe, parent: tip ? `tip height ${tip.height}` : "gen 0", seed, arch: process.arch, interpreter_start_ir: start, interpreter_and_imports_ir: imports, metrics: rows };
  console.log(JSON.stringify(out, null, 1));
  if (opt("json")) writeFileSync(opt("json")!, JSON.stringify(out, null, 1) + "\n");
} finally {
  removeTree(work);
}
