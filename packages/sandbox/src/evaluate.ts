import { closeSync, constants, cpSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
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

/** Live phase reporting (SPEC 17.1): called as each step starts, with the container start time. */
export type PhaseCallback = (phase: "prepare" | "build" | "test" | "equivalence" | "metrics", startedAt: number) => void;

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
 * Cargo's own bookkeeping in CARGO_HOME, not dependency content: `.global-cache` is an SQLite file of
 * last-use timestamps and the `.package-cache*` files are locks. They differ on every machine and run,
 * so including them made a fresh verifier's deps digest disagree with the snapshot's (found by the
 * worker image lane, W9b: a container with its own LINEAGE_HOME could never replay fixture-b58).
 * A layer cached before this rule keeps its stored digest (`.lineage-digest`) until re-prepared.
 */
export const VOLATILE_DEPS = /(^|\/)cargo\/\.(global-cache|package-cache|package-cache-mutate)$/;

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
    const digest = H("deps-layer", dirDigest(join(dir, "layer"), (rel) => !VOLATILE_DEPS.test(rel)), dirDigest(join(dir, "outputs")));
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
  onPhase?: PhaseCallback;
}

async function run(ctx: Ctx, step: string, cmd: string, mounts: Mount[], timeout_s: number, side?: "base" | "cand", cwd = "/work/src") {
  // GPU steps that execute kernels take the device in turns across every worker on this host
  // (builds only compile). See withHostLock.
  const exclusive = ctx.gpus && step !== "build";
  const go = () => (phase(ctx.onPhase, step as Parameters<PhaseCallback>[0]), runContainer({
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
  }));
  const res = exclusive ? await withHostLock(join(LINEAGE_HOME, "locks"), `gpu-${ctx.gpus!.replace(/[^0-9a-z]/gi, "")}`, go) : await go();
  record(ctx.transcript, step, cmd, res, side);
  return res;
}

/** Telemetry must never break a replay: callback errors are swallowed. */
function phase(cb: PhaseCallback | undefined, p: Parameters<PhaseCallback>[0]) {
  try {
    cb?.(p, Date.now());
  } catch {
    /* ignore */
  }
}

async function build(ctx: Ctx, tree: string, side: "base" | "cand"): Promise<{ ok: boolean; digest?: Hex }> {
  const r = ctx.loaded.recipe;
  const res = await run(ctx, "build", r.build.commands.join(" && "), [{ host: tree, container: "/work/src" }], r.limits.wall_s, side);
  if (res.exit !== 0) return { ok: false };
  const globs = r.build.artifacts ?? [];
  return { ok: true, digest: globs.length ? dirDigest(tree, (rel) => matchesAny(rel, globs)) : undefined };
}

async function tests(ctx: Ctx, built: string, side: "base" | "cand"): Promise<TestOutcome> {
  const r = ctx.loaded.recipe;
  // tests run on a throwaway copy: code they execute can write anywhere in it, but never into the
  // frozen built tree that equivalence and metrics measure (adversarial review 2026-10-07)
  const n = ctx.transcript.steps.length;
  const scratch = join(ctx.outDir, `test-tree-${side}-${n}`);
  cloneTree(built, scratch);
  openPermissions(scratch);
  const out = join(ctx.outDir, `tests-${side}-${n}`);
  mkdirSync(out, { recursive: true });
  openPermissions(out);
  try {
    const res = await run(ctx, "test", r.test.command, [{ host: scratch, container: "/work/src" }, { host: out, container: "/out" }], r.test.timeout_s, side);
    const junit = readRegularFile(join(out, "junit.xml"), 16 * 1024 * 1024);
    const parsed = parseTests(r.test.parser, res.stdout, res.stderr, junit ?? undefined);
    if (res.timed_out) ctx.transcript.notes.push(`${side} tests timed out`);
    return parsed;
  } finally {
    removeTree(scratch);
  }
}

/**
 * Reads a file the sandbox produced only if it is a regular file (never a symlink or device) and
 * not larger than `cap`. A container can plant a symlink in a bind-mounted directory that the HOST
 * would otherwise follow when reading results.
 */
export function readRegularFile(path: string, cap: number): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > cap) return null;
    const buf = Buffer.alloc(st.size);
    readSync(fd, buf, 0, st.size, 0);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

async function equivalence(ctx: Ctx, tree: string, side: "base" | "cand"): Promise<Hex | null> {
  const eq = ctx.loaded.recipe.equivalence;
  if (!eq) return null;
  const res = await run(ctx, "equivalence", eq.command, [{ host: tree, container: "/work/src", readonly: true }], ctx.loaded.recipe.limits.wall_s, side);
  return equivalenceDigest(res.exit, res.stdout, side);
}

/**
 * The parent tree is the reference: if the harness fails on it, this seed cannot show the candidate
 * is equivalent. No digest, so the judge rejects (`equivalence_changed`, no output) instead of a
 * candidate that fails the same way matching the parent's failure digest (seen on spl-record).
 */
export function equivalenceDigest(exit: number, stdout: string, side: "base" | "cand"): Hex | null {
  if (exit === 0) return sha256Hex(stdout);
  if (side === "base") return null;
  return H("equivalence-failed", String(exit), sha256Hex(stdout));
}

/**
 * Measures metrics (SPEC 9). Every single run gets its own container with the frozen built tree
 * mounted read-only and no shared writable directory, so a candidate run can never touch a base
 * run's output or binaries (adversarial review 2026-10-07). Noisy metrics still interleave base and
 * candidate in ABBA order after one warm-up each (SPEC 9.2); runs are sequential on one host.
 */
async function measure(ctx: Ctx, trees: { base: string; cand: string | null }, metrics: MetricSpec[]): Promise<Record<string, MetricSamples>> {
  const plan: { metric: MetricSpec; side: "base" | "cand"; warm: boolean }[] = [];
  for (const m of metrics) {
    const sides: ("base" | "cand")[] = trees.cand ? ["base", "cand"] : ["base"];
    if (m.deterministic) {
      sides.forEach((side) => plan.push({ metric: m, side, warm: false }));
      continue;
    }
    sides.forEach((side) => plan.push({ metric: m, side, warm: true }));
    const rounds = m.rounds ?? 10;
    for (let i = 0; i < rounds; i++) {
      const order = trees.cand ? (i % 2 === 0 ? ["base", "cand"] : ["cand", "base"]) : ["base", "base"];
      order.forEach((side) => plan.push({ metric: m, side: side as "base" | "cand", warm: false }));
    }
  }
  const samples: Record<string, MetricSamples> = {};
  for (const [n, p] of plan.entries()) {
    const tree = p.side === "cand" ? trees.cand! : trees.base;
    const res = await run(ctx, "metrics", isolateMetric(p.metric), [{ host: tree, container: "/work/src", readonly: true }], ctx.loaded.recipe.limits.wall_s, p.side);
    if (res.timed_out) throw new EvalError(`metric ${p.metric.name} timed out`);
    if (p.warm) continue;
    const s = (samples[p.metric.name] ??= { base: [], cand: [], deterministic: p.metric.deterministic });
    if (res.exit !== 0) {
      ctx.transcript.notes.push(`metric ${p.metric.name} ${p.side} run ${n} exited ${res.exit}: ${tail(res.stderr, 300)}`);
      continue;
    }
    try {
      s[p.side].push(parseMetric(p.metric.parser, res.stdout, res.stderr));
    } catch (e) {
      ctx.transcript.notes.push(`metric ${p.metric.name} ${p.side} run ${n}: ${(e as Error).message}`);
    }
  }
  return samples;
}

/**
 * Wraps a metric command so the measured program cannot forge the measurement text:
 * - valgrind-based metrics send valgrind's own log to descriptor 9 (the container's stderr) while
 *   the program's stdout and stderr are discarded;
 * - every process the command left behind is killed before the container returns its output.
 * Residual risk (SPEC 15): code running as the same user could still write to the container's
 * stderr through /proc; guard flags and audits cover that path.
 */
export function isolateMetric(m: MetricSpec): string {
  const valgrind = m.parser === "cachegrind-ir" && /\bvalgrind\s/.test(m.command);
  const cmd = valgrind ? m.command.replace(/\bvalgrind\s/, "valgrind --log-fd=9 ") : m.command;
  const quiet = valgrind ? " >/dev/null 2>/dev/null" : "";
  return `exec 9>&2; ( ${cmd} )${quiet}; lineage_ec=$?; kill -9 -1 2>/dev/null; exit $lineage_ec`;
}

/**
 * Text of every protected block (SPEC 7.1 protected_blocks) in the files matching each glob: from a
 * line matching `start` to the line where its braces balance. Returns "path:line" of each block
 * that differs between the parent and the candidate tree, or whose count changed.
 */
export function changedProtectedBlocks(parent: string, cand: string, rules: { glob: string; start: string }[]): string[] {
  const changed: string[] = [];
  const files = new Set<string>();
  for (const root of [parent, cand])
    for (const f of walkFiles(root)) {
      const rel = relative(root, f);
      if (!rel.startsWith(".git/") && rules.some((r) => matchesAny(rel, [r.glob]))) files.add(rel);
    }
  for (const rel of [...files].sort()) {
    const read = (root: string) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : "");
    for (const rule of rules.filter((r) => matchesAny(rel, [r.glob]))) {
      const a = blocks(read(parent), new RegExp(rule.start));
      const b = blocks(read(cand), new RegExp(rule.start));
      if (a.length !== b.length) {
        changed.push(`${rel}: ${a.length} blocks became ${b.length}`);
        continue;
      }
      a.forEach((blk, i) => {
        if (blk.text !== b[i]!.text) changed.push(`${rel}:${blk.line}`);
      });
    }
  }
  return changed;
}

function blocks(text: string, start: RegExp): { line: number; text: string }[] {
  const lines = text.split("\n");
  const out: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!start.test(lines[i]!)) continue;
    let depth = 0;
    let opened = false;
    let j = i;
    for (; j < lines.length; j++) {
      for (const ch of lines[j]!) {
        if (ch === "{") {
          depth++;
          opened = true;
        } else if (ch === "}") depth--;
      }
      if (opened && depth <= 0) break;
    }
    out.push({ line: i + 1, text: lines.slice(i, j + 1).join("\n") });
    i = j;
  }
  return out;
}

function cpuModel(): string {
  return cpus()[0]?.model ?? "unknown";
}

async function setup(loaded: LoadedRecipe, deps: DepsLayer, seed: Hex, parentPatches: string[], candidatePatch: string | null, onPhase?: PhaseCallback) {
  const r = loaded.recipe;
  phase(onPhase, "prepare");
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
  const ctx: Ctx = { loaded, deps, seed, image, sourceEpoch: commitTime(r.repo, r.commit), transcript, outDir, gpus, onPhase };
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
  onPhase?: PhaseCallback;
  /** metric names calibration enabled; others are not measured (they can never decide a verdict) */
  enabledMetrics?: string[];
}): Promise<EvalOutput> {
  const { loaded, deps, seed } = input;
  const r = loaded.recipe;
  const { ctx, work, base } = await setup(loaded, deps, seed, input.parentPatches, input.candidatePatch, input.onPhase);
  try {
    const g = guard(input.candidatePatch, r.patch);
    let guardCode: "ok" | GuardViolation = g.ok ? "ok" : g.violation!;
    if (g.flags.length) ctx.transcript.notes.push(...g.flags.map((f) => `guard flag: ${f}`));
    const cand = join(work, "cand");
    cloneTree(base, cand);
    let applied = guardCode === "ok" ? applyPatch(cand, input.candidatePatch) : false;
    if (applied && r.patch.protected_blocks?.length) {
      const changed = changedProtectedBlocks(base, cand, r.patch.protected_blocks);
      if (changed.length) {
        guardCode = "PROTECTED_REGION";
        ctx.transcript.notes.push(`protected blocks changed: ${changed.slice(0, 10).join(", ")}`);
      }
    }
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
      const metrics = input.enabledMetrics ? r.metrics.filter((m) => input.enabledMetrics!.includes(m.name)) : r.metrics;
      result.metrics = await measure(ctx, { base, cand }, metrics);
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
export async function calibrate(input: { loaded: LoadedRecipe; deps: DepsLayer; parentPatches?: string[]; runs?: number; seed: Hex; onPhase?: PhaseCallback }): Promise<{ calibration: Calibration; transcript: Transcript; snapshot_commit: string }> {
  const { loaded, deps, seed } = input;
  const r = loaded.recipe;
  const runs = input.runs ?? 5;
  const started = performance.now();
  const { ctx, work, base } = await setup(loaded, deps, seed, input.parentPatches ?? [], null, input.onPhase);
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
