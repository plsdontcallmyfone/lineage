#!/usr/bin/env bun
// A/B of attempt efficiency settings (docs/plans/AGENT-EFFICIENCY.md) with the real model on real
// recipes, locally, without Core: each attempt materialises gen 0, runs the Anthropic proposer with
// one arm's settings under the site's per-attempt cap, and every submitted change is then replayed
// once more in the sandbox with a fresh seed the author never saw and judged with the recipe's own
// rules (the replay a verifier would run). Spend is capped in total.
//
//   bun scripts/efficiency/ab.ts --recipes fixture-b58,minbpe --arms A,B,C --n 2 --budget 5 --out <dir>
//
// Arms (the model is claude-opus-5-5 in every arm; nothing else differs between them):
//   A  effort high, cap_mode projected   (the site's settings on 2026-10-10)
//   B  effort high, cap_mode bounded
//   C  effort medium, cap_mode bounded
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { canonicalizeDiff, judge, type CandidateView } from "@lineage/protocol";
import { diffWorkingTree, evaluate, loadRecipe, materialize, newWorkDir, prepareDeps, removeTree } from "@lineage/sandbox";
import { AnthropicProposer } from "../../packages/worker/src/proposers/anthropic.ts";
import type { EfficiencyOptions } from "../../packages/worker/src/proposers/efficiency.ts";

const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);

for (const line of readFileSync(`${process.env.HOME}/.config/lineage/model.env`, "utf8").split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}

const ARMS: Record<string, { effort: "high" | "medium" | "low"; efficiency: EfficiencyOptions }> = {
  A: { effort: "high", efficiency: { cap_mode: "projected" } },
  B: { effort: "high", efficiency: { cap_mode: "bounded" } },
  C: { effort: "medium", efficiency: { cap_mode: "bounded" } },
  D: { effort: "medium", efficiency: { cap_mode: "projected" } },
};
const recipes = opt("recipes", "fixture-b58,minbpe")!.split(",");
const arms = opt("arms", "A,B,C")!.split(",");
const n = Number(opt("n", "2"));
const maxUsd = Number(opt("max-usd", "0.5"));
const reserve = Number(opt("reserve", "0.08")); // the site keeps 0.08 USD of each attempt for the journal call
const budget = Number(opt("budget", "5"));
const out = resolve(opt("out", `scripts/efficiency/runs/ab-${new Date().toISOString().replace(/[:.]/g, "-")}`)!);
mkdirSync(out, { recursive: true });
const resultsPath = join(out, "results.json");
const results: any[] = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, "utf8")) : [];
let spent = results.reduce((a, r) => a + (r.usd ?? 0), 0);

async function attempt(recipe: string, arm: string, i: number) {
  const dir = resolve("recipes", recipe);
  const loaded = loadRecipe(dir);
  const calib = JSON.parse(readFileSync(join(dir, "calibration.json"), "utf8"));
  const calibration = calib.calibration ?? calib;
  const deps = await prepareDeps(loaded);
  const work = newWorkDir("eff-ab");
  const tree = join(work, "src");
  const logs: string[] = [];
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
    const a = ARMS[arm]!;
    const p = new AnthropicProposer({ max_usd: maxUsd, effort: a.effort, efficiency: a.efficiency });
    let sandbox_s = 0;
    const spentBox = { usd: 0 };
    const proposal = await p.propose({
      loaded,
      deps,
      calibration,
      parentPatches: [],
      findings,
      tree,
      seed: randomBytes(8).toString("hex"),
      log: (m) => (logs.push(`${new Date().toISOString().slice(11, 19)} ${m}`), console.log(`  [${recipe} ${arm}${i}] ${m}`)),
      journalReserveUsd: reserve,
      spent: spentBox,
      meter: { model: () => {}, sandbox: (s) => (sandbox_s += s) },
    });
    const authorS = (Date.now() - t0) / 1000;
    const usageLine = logs.find((l) => / anthropic: usage /.test(l)) ?? "";
    const u = usageLine.match(/usage (.+?): (\d+) calls, (\d+) in, (\d+) out, (\d+) cache read, (\d+) cache write, ([\d.]+) USD/);
    const end = u ? u[1] : "unknown";
    const raw = diffWorkingTree(tree);
    const diff = raw.trim() ? canonicalizeDiff(raw) : "";
    // independent replay of a submitted change: fresh seed, recipe rules, quorum 1 (what one verifier sees)
    let replay: { outcome: string; reason?: string; ratio?: number } | null = null;
    if (proposal && diff) {
      const seed = randomBytes(8).toString("hex");
      const { result } = await evaluate({ loaded, deps, parentPatches: [], candidatePatch: diff, seed, enabledMetrics: Object.entries(calibration.metrics).filter(([, m]: any) => m.enabled).map(([k]) => k) });
      const cand: CandidateView = { candidate_id: "ab", author: "ab", kind: proposal.kind, target: proposal.target };
      const j = judge(loaded.recipe, calibration, cand, [{ replay_id: "r", replayer: "ab-replay", seed, result }], { quorum: 1, det_tolerance: 0.001, bootstrap_resamples: 4000 });
      replay = { outcome: j.outcome, ...(j.reason ? { reason: j.reason } : {}), ...(j.effect && "ratio" in j.effect ? { ratio: j.effect.ratio } : {}) };
    }
    const r = {
      recipe,
      arm,
      i,
      effort: a.effort,
      cap_mode: a.efficiency.cap_mode,
      at: new Date(t0).toISOString(),
      end,
      calls: u ? Number(u[2]) : null,
      input_tokens: u ? Number(u[3]) : null,
      output_tokens: u ? Number(u[4]) : null,
      cache_read_tokens: u ? Number(u[5]) : null,
      cache_write_tokens: u ? Number(u[6]) : null,
      usd: u ? Number(u[7]) : spentBox.usd,
      evals: logs.filter((l) => / evaluating \(/.test(l)).length,
      author_s: Math.round(authorS),
      sandbox_s: Math.round(sandbox_s),
      submitted: proposal ? { kind: proposal.kind, target: proposal.target, claimed: proposal.claimed_effect ?? null } : null,
      replay,
      diff_lines: diff ? diff.split("\n").length : 0,
    };
    writeFileSync(join(out, `${recipe}-${arm}${i}.log`), logs.join("\n") + "\n");
    if (diff) writeFileSync(join(out, `${recipe}-${arm}${i}.diff`), diff);
    return r;
  } finally {
    removeTree(work);
  }
}

outer: for (let i = 0; i < n; i++)
  for (const recipe of recipes)
    // rotate the arm order each round so no arm always runs first (warm caches, machine load)
    for (const arm of [...arms.slice(i % arms.length), ...arms.slice(0, i % arms.length)]) {
      if (results.some((r) => r.recipe === recipe && r.arm === arm && r.i === i)) continue;
      if (spent + maxUsd > budget) {
        console.log(`budget: ${spent.toFixed(4)} of ${budget} USD spent; stopping before an attempt that could take ${maxUsd}`);
        break outer;
      }
      console.log(`attempt ${recipe} ${arm}${i} (spent so far ${spent.toFixed(4)} USD)`);
      const r = await attempt(recipe, arm, i);
      spent += r.usd ?? 0;
      results.push(r);
      writeFileSync(resultsPath, JSON.stringify(results, null, 1) + "\n");
      console.log(`  -> ${r.end}, ${r.usd?.toFixed(4)} USD, ${r.author_s} s, replay ${r.replay?.outcome ?? "none"}`);
    }

// summary per arm
const lines = ["| arm | attempts | USD/attempt | submitted | accepted by replay | USD per accepted | author s per accepted | calls (mean) | output tokens (mean) | cache read share of input | ended with nothing (why) |", "|---|---|---|---|---|---|---|---|---|---|---|"];
for (const arm of arms) {
  const rs = results.filter((r) => r.arm === arm);
  if (!rs.length) continue;
  const usd = rs.reduce((a, r) => a + r.usd, 0);
  const acc = rs.filter((r) => r.replay?.outcome === "accepted").length;
  const sec = rs.reduce((a, r) => a + r.author_s, 0);
  const tin = rs.reduce((a, r) => a + (r.input_tokens ?? 0) + (r.cache_read_tokens ?? 0) + (r.cache_write_tokens ?? 0), 0);
  const tcr = rs.reduce((a, r) => a + (r.cache_read_tokens ?? 0), 0);
  const nothing: Record<string, number> = {};
  for (const r of rs) if (!r.submitted) nothing[r.end] = (nothing[r.end] ?? 0) + 1;
  const mean = (k: string) => (rs.reduce((a, r) => a + (r[k] ?? 0), 0) / rs.length).toFixed(1);
  lines.push(
    `| ${arm} (${ARMS[arm]!.effort}, ${ARMS[arm]!.efficiency.cap_mode}) | ${rs.length} | ${(usd / rs.length).toFixed(4)} | ${rs.filter((r) => r.submitted).length} | ${acc} | ${acc ? (usd / acc).toFixed(4) : "n/a"} | ${acc ? Math.round(sec / acc) : "n/a"} | ${mean("calls")} | ${mean("output_tokens")} | ${tin ? ((100 * tcr) / tin).toFixed(0) + "%" : "n/a"} | ${Object.entries(nothing).map(([k, v]) => `${k} ${v}`).join(", ") || "none"} |`,
  );
}
const summary = `A/B ${new Date().toISOString()}: recipes ${recipes.join(", ")}, ${n} rounds, cap ${maxUsd} USD per attempt with ${reserve} kept back, total ${spent.toFixed(4)} USD\n\n${lines.join("\n")}\n`;
writeFileSync(join(out, "SUMMARY.md"), summary);
console.log(summary);
