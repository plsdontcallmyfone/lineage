import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join, relative } from "node:path";
import {
  guard,
  H,
  hashJson,
  matchesAny,
  sha256Hex,
  type Calibration,
  type GuardViolation,
  type Hex,
  type MetricSamples,
  type MetricSpec,
  type ReplayResult,
  bootstrapRatio,
  cv,
  median,
} from "@lineage/protocol";
import { gpuDeviceRequest, hostGpus, withHostLock, imageArch, imageDigest, runContainer, runnableImage, type Mount, type RunResult } from "./docker.ts";
import { parseMetric, parseTests, type TestOutcome } from "./parsers.ts";
import type { LoadedRecipe } from "./recipe.ts";
import { applyPatch, cloneTree, commitTime, LINEAGE_HOME, materialize, newWorkDir, openPermissions, removeTree } from "./repo.ts";

// The evaluation pipeline every replay runs, SPEC sections 8 and 9.

export const WORKER_VERSION = "lineage-sandbox/0.1.0";

export interface TranscriptStep {
  step: string;
  side?: "base" | "cand";
  cmd: string;
  exit: number;
  duration_ms: number;
  timed_out: boolean;
  stdout_tail: string;
  stderr_tail: string;
  stdout_sha256: Hex;
  stderr_sha256: Hex;
}

export interface Transcript {
  version: string;
  recipe_id: Hex;
  seed: Hex;
  parent_patches: Hex[];
  candidate_patch: Hex | null;
  started_at: string;
  steps: TranscriptStep[];
  notes: string[];
}

export interface DepsLayer {
  dir: string;
  digest: Hex;
}

export class EvalError extends Error {}

const tail = (s: string, n = 4000) => (s.length > n ? s.slice(s.length - n) : s);

function record(t: Transcript, step: string, cmd: string, r: RunResult, side?: "base" | "cand"): void {
  t.steps.push({
    step,
    side,
    cmd,
    exit: r.exit,
    duration_ms: r.duration_ms,
    timed_out: r.timed_out,
    stdout_tail: tail(r.stdout),
    stderr_tail: tail(r.stderr),
    stdout_sha256: sha256Hex(r.stdout),
    stderr_sha256: sha256Hex(r.stderr),
  });
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** Content digest of a directory: sorted (relative path, sha256) pairs. */
export function dirDigest(dir: string, filter?: (rel: string) => boolean): Hex {
  const entries = walkFiles(dir)
    .map((p) => relative(dir, p))
    .filter((r) => (filter ? filter(r) : true))
    .sort()
    .map((r) => [r, sha256Hex(readFileSync(join(dir, r)))]);
  return H("dir", JSON.stringify(entries));
}

function envFor(loaded: LoadedRecipe, seed: Hex, sourceEpoch: number): Record<string, string> {
  return {
    LINEAGE_SEED: seed,
    SOURCE_DATE_EPOCH: String(sourceEpoch),
    CARGO_HOME: "/deps/cargo",
    PIP_CACHE_DIR: "/deps/pip-cache",
    npm_config_cache: "/deps/npm-cache",
    VIRTUAL_ENV: "/deps/venv",
    PATH: "/deps/venv/bin:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  };
}

/**
 * Runs the recipe's prepare commands once per (recipe, snapshot) with network, producing the
 * read-only dependency layer every later step mounts at /deps (SPEC 8).
 */
export async function prepareDeps(loaded: LoadedRecipe, opts: { force?: boolean } = {}): Promise<DepsLayer> {
  const r = loaded.recipe;
  const key = H("deps", loaded.recipe_id).slice(0, 32);
  const dir = join(LINEAGE_HOME, "deps", key);
  const digestFile = join(dir, ".lineage-digest");
  if (!opts.force && existsSync(digestFile)) return { dir, digest: readFileSync(digestFile, "utf8").trim() };
  removeTree(dir);
  mkdirSync(join(dir, "layer"), { recursive: true });
  mkdirSync(join(dir, "outputs"), { recursive: true });
  const work = newWorkDir("prepare");
  try {
    const tree = join(work, "src");
    materialize(r.repo, r.commit, loaded.overlayDir, tree);
    openPermissions(work);
    openPermissions(dir);
    if (r.prepare.length) {
      const res = await runContainer({
        image: runnableImage(r.image),
        cmd: r.prepare.join(" && "),
        cwd: "/work/src",
        mounts: [
          { host: tree, container: "/work/src" },
          { host: join(dir, "layer"), container: "/deps" },
        ],
        network: true,
        env: envFor(loaded, "0", commitTime(r.repo, r.commit)),
        limits: r.limits,
        timeout_s: r.limits.wall_s,
        job: `prepare-${r.name}`,
      });
      if (res.exit !== 0) throw new EvalError(`prepare failed (${res.exit}): ${tail(res.stderr, 2000)}`);
    }
    for (const out of r.prepare_outputs ?? []) {
      const src = join(tree, out);
      if (!existsSync(src)) throw new EvalError(`prepare did not produce ${out}`);
      mkdirSync(join(dir, "outputs", out, ".."), { recursive: true });
      cpSync(src, join(dir, "outputs", out));
    }
    const digest = H("deps-layer", dirDigest(join(dir, "layer")), dirDigest(join(dir, "outputs")));
    writeFileSync(digestFile, digest);
    return { dir, digest };
  } finally {
    removeTree(work);
  }
}

interface Ctx {
  loaded: LoadedRecipe;
  deps: DepsLayer;
  seed: Hex;
  image: string;
  sourceEpoch: number;
  transcript: Transcript;
  outDir: string;
  /** `--gpus` value for cuda-class recipes (requires.gpu set), else undefined */
  gpus?: string;
}

async function run(ctx: Ctx, step: string, cmd: string, mounts: Mount[], timeout_s: number, side?: "base" | "cand", cwd = "/work/src") {
  // GPU steps that execute kernels take the device in turns across every worker on this host
  // (builds only compile). See withHostLock.
  const exclusive = ctx.gpus && step !== "build";
  const go = () => runContainer({
    image: ctx.image,
    cmd,
    cwd,
    mounts: [...mounts, { host: join(ctx.deps.dir, "layer"), container: "/deps", readonly: true }],
    network: false,
    env: envFor(ctx.loaded, ctx.seed, ctx.sourceEpoch),
    limits: ctx.loaded.recipe.limits,
    timeout_s,
    job: `${step}-${side ?? "x"}`,
    gpus: ctx.gpus,
  });
  const res = exclusive ? await withHostLock(join(LINEAGE_HOME, "locks"), `gpu-${ctx.gpus!.replace(/[^0-9a-z]/gi, "")}`, go) : await go();
  record(ctx.transcript, step, cmd, res, side);
  return res;
}

async function build(ctx: Ctx, tree: string, side: "base" | "cand"): Promise<{ ok: boolean; digest?: Hex }> {
  const r = ctx.loaded.recipe;
  const res = await run(ctx, "build", r.build.commands.join(" && "), [{ host: tree, container: "/work/src" }], r.limits.wall_s, side);
  if (res.exit !== 0) return { ok: false };
  const globs = r.build.artifacts ?? [];
  return { ok: true, digest: globs.length ? dirDigest(tree, (rel) => matchesAny(rel, globs)) : undefined };
}

async function tests(ctx: Ctx, tree: string, side: "base" | "cand"): Promise<TestOutcome> {
  const r = ctx.loaded.recipe;
  const out = join(ctx.outDir, `tests-${side}-${ctx.transcript.steps.length}`);
  mkdirSync(out, { recursive: true });
  openPermissions(out);
  const res = await run(ctx, "test", r.test.command, [{ host: tree, container: "/work/src" }, { host: out, container: "/out" }], r.test.timeout_s, side);
  const junitPath = join(out, "junit.xml");
  const junit = existsSync(junitPath) ? readFileSync(junitPath, "utf8") : undefined;
  const parsed = parseTests(r.test.parser, res.stdout, res.stderr, junit);
  if (res.timed_out) ctx.transcript.notes.push(`${side} tests timed out`);
  return parsed;
}

async function equivalence(ctx: Ctx, tree: string, side: "base" | "cand"): Promise<Hex | null> {
  const eq = ctx.loaded.recipe.equivalence;
  if (!eq) return null;
  const res = await run(ctx, "equivalence", eq.command, [{ host: tree, container: "/work/src" }], ctx.loaded.recipe.limits.wall_s, side);
  return res.exit === 0 ? sha256Hex(res.stdout) : H("equivalence-failed", String(res.exit), sha256Hex(res.stdout));
}

/**
 * Measures metrics for base and cand in ONE container with both trees mounted, so they share
 * hardware state. Noisy metrics run interleaved ABBA rounds after one warm-up each (SPEC 9.2).
 */
async function measure(ctx: Ctx, trees: { base: string; cand: string | null }, metrics: MetricSpec[]): Promise<Record<string, MetricSamples>> {
  const plan: { metric: MetricSpec; side: "base" | "cand"; idx: number; warm: boolean }[] = [];
  for (const m of metrics) {
    const sides: ("base" | "cand")[] = trees.cand ? ["base", "cand"] : ["base"];
    if (m.deterministic) {
      sides.forEach((side) => plan.push({ metric: m, side, idx: 0, warm: false }));
      continue;
    }
    sides.forEach((side) => plan.push({ metric: m, side, idx: -1, warm: true }));
    const rounds = m.rounds ?? 10;
    for (let i = 0; i < rounds; i++) {
      const order = trees.cand ? (i % 2 === 0 ? ["base", "cand"] : ["cand", "base"]) : ["base", "base"];
      order.forEach((side, k) => plan.push({ metric: m, side: side as "base" | "cand", idx: trees.cand ? i : i * 2 + k, warm: false }));
    }
  }
  if (plan.length === 0) return {};
  const out = join(ctx.outDir, `metrics-${ctx.transcript.steps.length}`);
  mkdirSync(out, { recursive: true });
  openPermissions(out);
  const lines = ["set +e"];
  plan.forEach((p, n) => {
    const tag = `${n}`;
    lines.push(`cd /work/${p.side} && ( ${p.metric.command} ) > /out/${tag}.o 2> /out/${tag}.e; echo $? > /out/${tag}.x`);
  });
  const mounts: Mount[] = [{ host: trees.base, container: "/work/base", readonly: true }, { host: out, container: "/out" }];
  if (trees.cand) mounts.push({ host: trees.cand, container: "/work/cand", readonly: true });
  const res = await run(ctx, "metrics", lines.join("\n"), mounts, ctx.loaded.recipe.limits.wall_s, undefined, "/work");
  if (res.timed_out) throw new EvalError("metric phase timed out");
  const samples: Record<string, MetricSamples> = {};
  plan.forEach((p, n) => {
    if (p.warm) return;
    const exit = Number(readFileSync(join(out, `${n}.x`), "utf8").trim());
    const so = readFileSync(join(out, `${n}.o`), "utf8");
    const se = readFileSync(join(out, `${n}.e`), "utf8");
    const s = (samples[p.metric.name] ??= { base: [], cand: [], deterministic: p.metric.deterministic });
    if (exit !== 0) {
      ctx.transcript.notes.push(`metric ${p.metric.name} ${p.side} run ${n} exited ${exit}: ${tail(se, 300)}`);
      return;
    }
    try {
      s[p.side].push(parseMetric(p.metric.parser, so, se));
    } catch (e) {
      ctx.transcript.notes.push(`metric ${p.metric.name} ${p.side} run ${n}: ${(e as Error).message}`);
    }
  });
  return samples;
}

function cpuModel(): string {
  return cpus()[0]?.model ?? "unknown";
}

async function setup(loaded: LoadedRecipe, deps: DepsLayer, seed: Hex, parentPatches: string[], candidatePatch: string | null) {
  const r = loaded.recipe;
  const image = await imageDigest(r.image);
  const arch = imageArch(r.image);
  if (r.requires?.arch && arch !== r.requires.arch) throw new EvalError(`image is ${arch} but the recipe requires ${r.requires.arch} (SPEC 6.1)`);
  const gpuNotes: string[] = [];
  let gpus: string | undefined;
  if (r.requires?.gpu) {
    // SPEC 6.1: warp instruction counts are only comparable on the recipe's compute capability.
    gpus = gpuDeviceRequest();
    const idx = Number(gpus.slice("device=".length));
    const g = hostGpus().find((x) => x.index === idx);
    if (!g) throw new EvalError(`recipe requires an NVIDIA GPU (sm ${r.requires.gpu.sm}) but host GPU ${idx} is not visible to nvidia-smi`);
    if (g.sm !== r.requires.gpu.sm) throw new EvalError(`host GPU ${idx} (${g.name}) is sm ${g.sm} but the recipe requires sm ${r.requires.gpu.sm} (SPEC 6.1)`);
    gpuNotes.push(`gpu ${idx}: ${g.name}, sm ${g.sm}, driver ${g.driver}, ${g.mem_mb} MiB`);
  }
  const transcript: Transcript = {
    version: WORKER_VERSION,
    recipe_id: loaded.recipe_id,
    seed,
    parent_patches: parentPatches.map((p) => sha256Hex(p)),
    candidate_patch: candidatePatch === null ? null : sha256Hex(candidatePatch),
    started_at: new Date().toISOString(),
    steps: [],
    notes: [...gpuNotes],
  };
  const work = newWorkDir("eval");
  const outDir = join(work, "out");
  mkdirSync(outDir);
  const base = join(work, "base");
  materialize(r.repo, r.commit, loaded.overlayDir, base);
  const outputs = join(deps.dir, "outputs");
  if (existsSync(outputs) && readdirSync(outputs).length) {
    cpSync(outputs, base, { recursive: true });
    Bun.spawnSync(["git", "add", "-A"], { cwd: base });
    Bun.spawnSync(["git", "-c", "user.name=l", "-c", "user.email=l@l", "commit", "-q", "-m", "prepare outputs"], { cwd: base });
  }
  parentPatches.forEach((p, i) => {
    if (!applyPatch(base, p)) throw new EvalError(`parent series broken at generation ${i + 1}`);
  });
  const ctx: Ctx = { loaded, deps, seed, image, sourceEpoch: commitTime(r.repo, r.commit), transcript, outDir, gpus };
  return { ctx, work, base };
}

export interface EvalOutput {
  result: ReplayResult;
  transcript: Transcript;
}

/**
 * Full replay of one candidate against its parent generation (SPEC 9, 10.1). `candidatePatch` is
 * the canonical diff; the parent is the snapshot plus `parentPatches` in order.
 */
export async function evaluate(input: {
  loaded: LoadedRecipe;
  deps: DepsLayer;
  parentPatches: string[];
  candidatePatch: string;
  seed: Hex;
  keepWork?: boolean;
}): Promise<EvalOutput> {
  const { loaded, deps, seed } = input;
  const r = loaded.recipe;
  const { ctx, work, base } = await setup(loaded, deps, seed, input.parentPatches, input.candidatePatch);
  try {
    const g = guard(input.candidatePatch, r.patch);
    const guardCode: "ok" | GuardViolation = g.ok ? "ok" : g.violation!;
    if (g.flags.length) ctx.transcript.notes.push(...g.flags.map((f) => `guard flag: ${f}`));
    const cand = join(work, "cand");
    cloneTree(base, cand);
    const applied = guardCode === "ok" ? applyPatch(cand, input.candidatePatch) : false;
    openPermissions(work);

    const result: ReplayResult = {
      apply: guardCode !== "ok" || applied ? "ok" : "conflict",
      guard: guardCode,
      build: { base: "fail", cand: "skipped" },
      tests: { base_pass: [], cand_pass: [], cand_fail: [] },
      equivalence: null,
      metrics: {},
      env: { image_digest: ctx.image, cpu_model: cpuModel(), cores: r.limits.cpus, worker_version: WORKER_VERSION },
      transcript_digest: "",
    };
    const candOk = guardCode === "ok" && applied;

    const [bb, cb] = await Promise.all([build(ctx, base, "base"), candOk ? build(ctx, cand, "cand") : Promise.resolve(null)]);
    result.build.base = bb.ok ? "ok" : "fail";
    result.build.base_digest = bb.digest;
    if (cb) {
      result.build.cand = cb.ok ? "ok" : "fail";
      result.build.cand_digest = cb.digest;
    }
    if (!bb.ok) {
      ctx.transcript.notes.push("base build failed: environment problem");
      return finish(result, ctx);
    }
    const bt = await tests(ctx, base, "base");
    result.tests.base_pass = bt.pass.sort();
    if (cb?.ok) {
      const ct = await tests(ctx, cand, "cand");
      result.tests.cand_pass = ct.pass.sort();
      result.tests.cand_fail = ct.fail.sort();
      if (r.equivalence) {
        const [be, ce] = await Promise.all([equivalence(ctx, base, "base"), equivalence(ctx, cand, "cand")]);
        if (be && ce) result.equivalence = { base_digest: be, cand_digest: ce };
      }
      result.metrics = await measure(ctx, { base, cand }, r.metrics);
    }
    return finish(result, ctx);
  } finally {
    if (!input.keepWork) removeTree(work);
  }
}

function finish(result: ReplayResult, ctx: Ctx): EvalOutput {
  result.transcript_digest = hashJson(ctx.transcript);
  return { result, transcript: ctx.transcript };
}

/**
 * Calibration (SPEC 6): stable test set, known failures, quarantine, metric noise, and the median
 * evaluation time used for windows and cost classes.
 */
export async function calibrate(input: { loaded: LoadedRecipe; deps: DepsLayer; parentPatches?: string[]; runs?: number; seed: Hex }): Promise<{ calibration: Calibration; transcript: Transcript; snapshot_commit: string }> {
  const { loaded, deps, seed } = input;
  const r = loaded.recipe;
  const runs = input.runs ?? 5;
  const started = performance.now();
  const { ctx, work, base } = await setup(loaded, deps, seed, input.parentPatches ?? [], null);
  try {
    openPermissions(work);
    const b = await build(ctx, base, "base");
    if (!b.ok) throw new EvalError(`calibration build failed: ${ctx.transcript.steps.at(-1)?.stderr_tail.slice(-1500)}`);
    const buildMs = ctx.transcript.steps.at(-1)!.duration_ms;
    const passCount = new Map<string, number>();
    const failCount = new Map<string, number>();
    let testMs = 0;
    for (let i = 0; i < runs; i++) {
      const t = await tests(ctx, base, "base");
      testMs += ctx.transcript.steps.at(-1)!.duration_ms;
      if (!t.recognised) throw new EvalError("test output not recognised by parser " + r.test.parser);
      t.pass.forEach((id) => passCount.set(id, (passCount.get(id) ?? 0) + 1));
      t.fail.forEach((id) => failCount.set(id, (failCount.get(id) ?? 0) + 1));
    }
    const excluded = new Set(r.test.exclude ?? []);
    const ids = [...new Set([...passCount.keys(), ...failCount.keys()])].filter((id) => !excluded.has(id)).sort();
    const stable = ids.filter((id) => passCount.get(id) === runs);
    const known_failures = ids.filter((id) => failCount.get(id) === runs);
    const quarantined = ids.filter((id) => !stable.includes(id) && !known_failures.includes(id));

    // A/A measurement: base against itself must not look like an improvement.
    const metrics: Calibration["metrics"] = {};
    const metricStart = ctx.transcript.steps.length;
    const det = r.metrics.filter((m) => m.deterministic);
    const noisy = r.metrics.filter((m) => !m.deterministic);
    const detA = await measure(ctx, { base, cand: null }, det);
    const detB = await measure(ctx, { base, cand: null }, det);
    for (const m of det) {
      const a = detA[m.name]?.base ?? [];
      const b2 = detB[m.name]?.base ?? [];
      if (!a.length || !b2.length) {
        metrics[m.name] = { enabled: false, cv: 0, reason: "metric command failed at calibration" };
        continue;
      }
      const vals = [...a, ...b2];
      const c = cv(vals);
      const tol = m.tolerance ?? 0.001;
      metrics[m.name] = c <= tol / 2
        ? { enabled: true, cv: c, base_value: median(vals) }
        : { enabled: false, cv: c, base_value: median(vals), reason: `not deterministic: cv ${c.toExponential(2)} above tolerance` };
    }
    const aa = await measure(ctx, { base, cand: null }, noisy);
    for (const m of noisy) {
      const s = aa[m.name]?.base ?? [];
      if (s.length < 6) {
        metrics[m.name] = { enabled: false, cv: 0, reason: "metric command failed at calibration" };
        continue;
      }
      const even = s.filter((_, i) => i % 2 === 0);
      const odd = s.filter((_, i) => i % 2 === 1);
      const ci = bootstrapRatio(even, odd, m.direction, H("calib-aa", seed, m.name), 4000);
      const halfWidth = Math.max(1 - ci.ci_low, ci.ci_high - 1);
      const c = cv(s);
      metrics[m.name] = halfWidth < m.min_effect * 0.75
        ? { enabled: true, cv: c, base_value: median(s) }
        : { enabled: false, cv: c, base_value: median(s), reason: `too noisy to resolve ${m.min_effect}: A/A half-width ${halfWidth.toFixed(4)}` };
    }
    const metricMs = ctx.transcript.steps.slice(metricStart).reduce((a, s) => a + s.duration_ms, 0);
    // a replay builds and tests both sides and measures once: approximate from what we ran
    const evalSeconds = Math.round((2 * buildMs + 2 * (testMs / runs) + metricMs / 3) / 1000);
    ctx.transcript.notes.push(`calibration wall time ${Math.round((performance.now() - started) / 1000)} s`);
    const calibration: Calibration = {
      recipe_id: loaded.recipe_id,
      snapshot_id: "",
      runs,
      stable,
      known_failures,
      quarantined,
      metrics,
      median_eval_seconds: Math.max(1, evalSeconds),
      seed,
    };
    return { calibration, transcript: ctx.transcript, snapshot_commit: r.commit };
  } finally {
    removeTree(work);
  }
}

export { statSync };
