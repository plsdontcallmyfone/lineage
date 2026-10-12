#!/usr/bin/env bun
// units sandbox host: one evaluation for the site's hosted runtime (scale-out lane,
// packages/sandbox/src/remote.ts, docs/plans/SCALE-OUT.md section 6).
//
//   bun packages/worker/src/eval-job.ts < job.json
//
// Reads one EvalJob from stdin, runs it in this machine's sandbox exactly as evaluate() does on the
// site, and prints one JSON line: { ok: true, result, transcript } or { ok: false, kind, error }.
// kind "eval" is the evaluation's own refusal (the caller throws it as EvalError); kind "host" means
// this machine could not run it (a recipe or dependency layer that differs from the site's: the host
// needs the site's release) and the caller takes the next host. Phase lines go to stderr as
// "@phase <name> <start ms>". No key is read, nothing is written outside UNITS_HOME, and the work
// directory is removed by evaluate().
import "../../protocol/src/env-alias.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { EvalError, evaluate, loadRecipe, PHASE_PREFIX, UNITS_HOME, type EvalJob, type EvalJobAnswer, type LoadedRecipe } from "@units/sandbox";
import { RecipeBook } from "./recipes.ts";

const MAX_JOB_BYTES = 8 * 1024 * 1024;

export function jobError(j: unknown): string | null {
  if (!j || typeof j !== "object") return "a JSON object is expected";
  const x = j as Record<string, unknown>;
  const hex = (v: unknown) => typeof v === "string" && /^[0-9a-f]{8,128}$/.test(v);
  if (x.v !== 1) return "job version 1 is expected";
  if (!hex(x.recipe_id) || !hex(x.deps_digest) || !hex(x.seed)) return "recipe_id, deps_digest and seed are hex";
  if (!Array.isArray(x.parent_patches) || !x.parent_patches.every((p) => typeof p === "string")) return "parent_patches is a list of patches";
  if (typeof x.candidate_patch !== "string") return "candidate_patch is a patch";
  if (x.proposal !== undefined) {
    const p = x.proposal as { recipe?: unknown; overlay?: unknown } | null;
    if (!p || typeof p !== "object" || !p.recipe || typeof p.recipe !== "object" || !p.overlay || typeof p.overlay !== "object" || Array.isArray(p.overlay) || Object.keys(p.overlay).length > 32) return "proposal is { recipe, overlay: { path: base64 } } with at most 32 files";
  }
  if (x.enabled_metrics !== undefined && !(Array.isArray(x.enabled_metrics) && x.enabled_metrics.every((m) => typeof m === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(m)))) return "enabled_metrics is a list of metric names";
  return null;
}

/**
 * A recipe Core admitted from a proposal (SPEC 6.2) travels with the job: written under this host's
 * UNITS_HOME/proposals and used only when its files recompute to the job's recipe id.
 */
export function writeProposal(job: EvalJob, root = join(UNITS_HOME, "proposals")): LoadedRecipe {
  const p = job.proposal!;
  const name = (p.recipe as { name?: unknown } | null)?.name;
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(name)) throw new Error("proposal recipe name must be lowercase kebab");
  const dir = join(root, `${name}-${job.recipe_id.slice(0, 12)}`);
  try {
    const have = loadRecipe(dir);
    if (have.recipe_id === job.recipe_id) return have;
  } catch {}
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "overlay"), { recursive: true });
  writeFileSync(join(dir, "recipe.yml"), JSON.stringify(p.recipe, null, 2) + "\n");
  for (const [f, b64] of Object.entries(p.overlay)) {
    const abs = join(dir, "overlay", normalize(f));
    if (typeof b64 !== "string" || relative(join(dir, "overlay"), abs).startsWith("..") || f.split("/").includes(".git")) throw new Error(`proposal overlay path ${String(f).slice(0, 80)}`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, Buffer.from(b64, "base64"));
  }
  const loaded = loadRecipe(dir);
  if (loaded.recipe_id !== job.recipe_id) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`the job's recipe recomputes to ${loaded.recipe_id.slice(0, 12)}, not ${job.recipe_id.slice(0, 12)}`);
  }
  return loaded;
}

export async function runJob(job: EvalJob, book = new RecipeBook(), onPhase?: (line: string) => void): Promise<EvalJobAnswer> {
  let loaded;
  let deps;
  try {
    if (!book.has(job.recipe_id) && job.proposal) book.add(writeProposal(job));
    if (!book.has(job.recipe_id)) return { ok: false, kind: "host", error: `recipe ${job.recipe_id.slice(0, 12)} is not in this host's release; update the host` };
    loaded = book.get(job.recipe_id);
    deps = await book.depsFor(loaded, job.deps_digest);
  } catch (e) {
    return { ok: false, kind: "host", error: (e as Error).message.slice(0, 300) };
  }
  try {
    const { result, transcript } = await evaluate({
      loaded, deps, parentPatches: job.parent_patches, candidatePatch: job.candidate_patch, seed: job.seed, enabledMetrics: job.enabled_metrics, local: true,
      onPhase: (p, at) => onPhase?.(`${PHASE_PREFIX}${p} ${at}`),
    });
    return { ok: true, host: process.env.UNITS_SANDBOX_HOST, result, transcript };
  } catch (e) {
    if (e instanceof EvalError) return { ok: false, kind: "eval", error: e.message };
    return { ok: false, kind: "host", error: (e as Error).message.slice(0, 300) };
  }
}

if (import.meta.main) {
  const answer = (a: EvalJobAnswer) => {
    process.stdout.write(JSON.stringify(a) + "\n");
  };
  try {
    const raw = await Bun.stdin.text();
    if (raw.length > MAX_JOB_BYTES) throw new Error("job too large");
    const job = JSON.parse(raw) as EvalJob;
    const bad = jobError(job);
    if (bad) throw new Error(bad);
    answer(await runJob(job, new RecipeBook(), (l) => process.stderr.write(l + "\n")));
  } catch (e) {
    answer({ ok: false, kind: "host", error: `bad job: ${(e as Error).message.slice(0, 200)}` });
    process.exit(2);
  }
}
