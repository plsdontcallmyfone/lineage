import { canonicalizeDiff, subsetKey, subsetMasks, type Hex, type ReplayResult, type SplitReport, type SubsetMeasure } from "@lineage/protocol";
import { applyPatch, evaluate, materialize, newWorkDir, removeTree, type DepsLayer, type PhaseCallback } from "@lineage/sandbox";
import type { LoadedRecipe } from "@lineage/sandbox";

// Measured split, replayer side (SPEC 12.6, plan C5). For a team candidate with a split the
// assignment carries the sub-patches by index (never who wrote them). After the ordinary replay
// (which alone decides acceptance) the replayer:
//   1. checks that the sub-patches, applied in order to the parent tree, give exactly the
//      candidate's tree (git tree hashes compared; `compose`);
//   2. measures every proper non-empty coalition of sub-patches as its own tree, with the same
//      seed as the main replay, on the target metric only: build, tests, equivalence and the metric
//      samples, reported raw. Core and scripts/verify.ts derive each coalition's status and gain.
// The report is committed with the result commitment and revealed with it.

export interface SplitAssignment {
  n: number;
  metric: string;
  subs: string[];
  coalitions: string[];
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const p = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim() };
}

const treeOf = (dir: string) => git(dir, ["rev-parse", "HEAD^{tree}"]).out;
const reset = (dir: string, sha: string) => {
  git(dir, ["reset", "-q", "--hard", sha]);
  git(dir, ["clean", "-fdq"]);
};

/** Applies the sub-patches of `mask` in member order on the parent; false when one does not apply. */
function applyCoalition(dir: string, parent: string, subs: string[], mask: number): boolean {
  reset(dir, parent);
  for (let i = 0; i < subs.length; i++) if (mask & (1 << i) && !applyPatch(dir, subs[i]!)) return false;
  return true;
}

export async function measureCoalitions(p: {
  loaded: LoadedRecipe;
  deps: DepsLayer;
  parentPatches: string[];
  candidatePatch: string;
  split: SplitAssignment;
  seed: Hex;
  main: ReplayResult;
  mainSeconds: number;
  onPhase?: PhaseCallback;
  log?: (m: string) => void;
}): Promise<SplitReport> {
  const t0 = Date.now();
  const { split, main } = p;
  const report: SplitReport = { v: 1, compose: "skipped", metric: split.metric, subsets: {} };
  // a candidate that does not even apply or build is rejected anyway; every honest replayer skips alike
  if (main.apply !== "ok" || main.guard !== "ok" || main.build.cand !== "ok") return report;
  const work = newWorkDir("split");
  try {
    const dir = `${work}/src`;
    materialize(p.loaded.recipe.repo, p.loaded.recipe.commit, p.loaded.overlayDir, dir);
    for (const x of p.parentPatches) if (!applyPatch(dir, x)) throw new Error("parent series does not apply");
    const parent = git(dir, ["rev-parse", "HEAD"]).out;
    // 1. composition: all sub-patches in order give the candidate's tree
    const all = (1 << split.n) - 1;
    if (!applyCoalition(dir, parent, split.subs, all)) report.compose = "conflict";
    else {
      const composed = treeOf(dir);
      reset(dir, parent);
      report.compose = applyPatch(dir, p.candidatePatch) && treeOf(dir) === composed ? "ok" : "mismatch";
    }
    if (report.compose !== "ok") return report;
    // 2. every proper non-empty coalition as its own tree, same seed, target metric only
    for (const mask of subsetMasks(split.n)) {
      const key = subsetKey(mask);
      let m: SubsetMeasure = { apply: "conflict", build: "skipped", cand_pass: [], equivalence: null, metric: null };
      if (applyCoalition(dir, parent, split.subs, mask)) {
        const diff = canonicalizeDiff(git(dir, ["diff", "--no-color", "--no-ext-diff", "--no-renames", "-U3", "--full-index", parent, "HEAD"]).out + "\n");
        const { result } = await evaluate({ loaded: p.loaded, deps: p.deps, parentPatches: p.parentPatches, candidatePatch: diff, seed: p.seed, onPhase: p.onPhase, enabledMetrics: [split.metric] });
        const s = result.metrics[split.metric];
        m = {
          apply: result.apply,
          build: result.guard !== "ok" ? "skipped" : result.build.cand,
          cand_pass: [...result.tests.cand_pass].sort(),
          equivalence: result.equivalence,
          metric: s ? { base: s.base, cand: s.cand } : null,
        };
      }
      report.subsets[key] = m;
      p.log?.(`split coalition ${key}: ${m.apply}/${m.build}${m.metric ? `, ${split.metric} ${m.metric.cand[0]} vs ${m.metric.base[0]}` : ""}`);
    }
    report.cost = { main_s: Math.round(p.mainSeconds * 10) / 10, subsets_s: Math.round((Date.now() - t0) / 100) / 10 };
    return report;
  } finally {
    removeTree(work);
  }
}
