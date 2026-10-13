import Anthropic from "@anthropic-ai/sdk";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { H, sha256Hex, type Calibration, type Recipe } from "@units/protocol";
import { UNITS_HOME, calibrate, loadRecipe, materialize, newWorkDir, prepareDeps, removeTree, runContainer, runnableImage, RecipeError, type LoadedRecipe } from "@units/sandbox";
import { CoreClient, type SigningKey } from "../../core/src/client.ts";
import { calibCommitment } from "../../core/src/recipe-proposals.ts";
import { duplicateUnit, headroomError } from "../../core/src/more-units.ts";
import { toolLoop, withBuiltTree, type SpendLedger } from "./discovery.ts";
import { ToolBox } from "./proposers/anthropic.ts";
import type { ProposeContext } from "./proposers/types.ts";
import { candidateLine, multiPackage, repoStructure, structureSection, type ImageFacts } from "./repo-structure.ts";
import { calibrationReason, equivalenceReason, errorReason, historyLines, oneLine, reasonLine, reasonWords, type TrialOutcome, type TrialReason } from "./trial-reason.ts";

// Agent-proposed recipes (SPEC 6.2), worker side.
// - RecipeDrafter: Claude reads a checkout of a target repository and drafts recipe.yml plus the
//   overlay harness (benchmark and equivalence programs). It can trial-calibrate its draft in the
//   real sandbox (the same calibrate() Core's reference runner uses) and may submit only a draft
//   whose last trial built, found stable tests, kept every deterministic metric enabled and ran
//   the equivalence harness to identical digests twice.
// - submitProposal: uploads the overlay files as blobs and posts the proposal to Core.
// - CalibrationVerifier: a qualified verifier's side of the calibration replays: materializes the
//   proposed recipe from Core (recipe JSON plus overlay blobs), checks its recipe_id, prepares the
//   dependency layer, calibrates with the shared seed, commits, then reveals once every drawn
//   verifier has committed.

// ---------------------------------------------------------------------------------------------
// Drafting

export interface DraftTarget {
  /** recipe name to use (lowercase kebab) */
  name: string;
  repo: string;
  commit: string;
  class: Recipe["class"];
  arch: "amd64" | "arm64";
  /** pinned image for the class (one Core already vets: used by an active lineage of the class) */
  image: string;
}

export interface TrialReport {
  ok: boolean;
  recipe_id?: string;
  text: string;
  /** why it is not ok: the stage, the rule and a short scrubbed cause from the sandbox result (trial-reason.ts) */
  reason?: TrialReason;
}

/** What earlier drafts of the same recipe left: their trials with the reason each failed, oldest first. */
export interface DraftHistory {
  draft: number;
  trials: TrialOutcome[];
}

/** How a draft ended when the model neither submitted nor gave up. */
export type DraftStop = "spend" | "turns" | "trials";

/** What the drafter of an ADDITIONAL unit is told about a unit the repository already has (plan AGENT-EFFICIENCY 8.2). */
export interface ExistingUnit {
  name: string;
  recipe: Recipe;
  height: number;
  metrics: {
    name: string;
    kind: string;
    command: string;
    enabled: boolean;
    base_value: number | null;
    /** accepted changes that targeted it, and their combined ratio (1 when none) */
    accepted: number;
    ratio: number;
    /** the share of its tip value that is not the library, where the calibration records it */
    fixed_share: number | null;
  }[];
  /** Core's dry facts for the unit, as one sentence, or null */
  recent: string | null;
}

export interface MoreContext {
  units: ExistingUnit[];
  /** the largest share of an instruction-count metric that may be outside the library at generation 0 */
  maxFixedShare: number;
}

/** Reads what Core knows about the given units: recipe, calibrated values, accepted changes per target, the dry facts. */
export async function describeUnits(client: CoreClient, lineages: string[]): Promise<ExistingUnit[]> {
  const out: ExistingUnit[] = [];
  for (const id of lineages) {
    const v = await client.request("GET", `/v1/lineages/${id}`, undefined, { sign: false });
    if (v.status !== 200) throw new Error(`unit ${id.slice(0, 10)}: HTTP ${v.status}`);
    const view = v.body as { recipe: Recipe; height: number; calibration: Calibration; generations: { entry_type: string; reverted_by: string | null; effect: { metric?: string; ratio?: number } | null }[] };
    const d = await client.request("GET", `/v1/lineages/${id}/dry`, undefined, { sign: false }).catch(() => null);
    const f = d?.status === 200 ? (d.body as { facts?: { attempts: number; fruitless: number; accepted: number; best_gain_pct: number | null; fixed?: Record<string, { share: number }> } }).facts : undefined;
    const live = view.generations.filter((g) => g.entry_type === "patch" && !g.reverted_by);
    out.push({
      name: view.recipe.name,
      recipe: view.recipe,
      height: view.height,
      metrics: view.recipe.metrics.map((m) => {
        const mine = live.filter((g) => g.effect?.metric === m.name && typeof g.effect.ratio === "number");
        const c = view.calibration.metrics[m.name];
        return { name: m.name, kind: m.kind, command: m.command, enabled: !!c?.enabled, base_value: typeof c?.base_value === "number" ? c.base_value : null, accepted: mine.length, ratio: mine.reduce((a, g) => a * (g.effect!.ratio as number), 1), fixed_share: f?.fixed?.[m.name]?.share ?? null };
      }),
      recent: f && f.attempts ? `of its last ${f.attempts} final attempts ${f.fruitless} ended without an improvement and ${f.accepted} were accepted${f.best_gain_pct === null ? "" : ` (largest gain ${f.best_gain_pct.toFixed(1)}%)`}` : null,
    });
  }
  return out;
}

/** The prompt section of an additional unit: what exists, what was achieved, what to add, and the two refusals. */
export function moreSection(more: MoreContext): string {
  const pctOf = (x: number) => `${(100 * x).toFixed(1)}%`;
  const units = more.units
    .map((u) => {
      const ms = u.metrics.map((m) => {
        const got = m.accepted ? `${m.accepted} accepted change${m.accepted === 1 ? "" : "s"}, now at ${m.ratio.toFixed(4)} of its start` : "no accepted change yet";
        const fixed = m.fixed_share === null ? "" : `; at least ${pctOf(m.fixed_share)} of what is left is not the library`;
        return `  - ${m.name} (${m.kind}${m.enabled ? "" : ", disabled"}): \`${m.command}\`; calibrated ${m.base_value ?? "-"}; ${got}${fixed}`;
      });
      return `- unit ${u.name} (${u.height} accepted generation${u.height === 1 ? "" : "s"}); a patch may change: ${u.recipe.patch.allowed_paths.join(", ")}; tests: \`${u.recipe.test.command}\`\n${ms.join("\n")}${u.recent ? `\n  recent work: ${u.recent}` : ""}`;
    })
    .join("\n");
  const limit = pctOf(more.maxFixedShare).replace(/\.0%$/, "%");
  return `

THIS IS AN ADDITIONAL UNIT. The repository already has ${more.units.length === 1 ? "a unit" : `${more.units.length} units`}, and agents have taken the easy gains there: most recent attempts found nothing more to improve. Existing units, with what was achieved on each target:
${units}

Your unit must add headroom those units do not have. Choose one or more, by reading the code:
(a) another part of the code: a module, package or crate the existing units do not let a patch change, which has tests of its own; allow only that part;
(b) a heavier or more realistic workload on the same code, as NEW targets with their own names (for example encode_long_ir, decode_batch_ir): larger and more varied inputs, the calls real users make, so that the library's own work is nearly all of each count;
(c) more targets: operations of the library that no existing target measures, and binary size where this class measures it.
Keep the prepare, build and test commands of the format reference (it is this repository's own unit) unless the new part of the code needs others.

Two rules are checked for an additional unit:
1. No duplicate. A draft whose allowed paths overlap an existing unit's and that has no target that unit lacks (the same kind and name, or the same command, is the same target) is refused when you write the recipe. Name every new target for what it measures.
2. Headroom. Every cachegrind metric must declare fixed_command: the metric's command with a flag (--inputs-only) that makes the benchmark do everything except call the library (start, imports, building the seeded inputs) and exit 0. The trial measures it, and fails unless it is at most ${limit} of the metric. So make each workload heavy enough (more and larger inputs, more repetitions of the library calls), build inputs cheaply, and still keep one cachegrind run under about a minute.
In recipe.yml a metric then reads:
  - name: encode_long_ir
    ...
    command: <the cachegrind command> encode_long $LINEAGE_SEED
    fixed_command: <the same command> --inputs-only
If the repository has nothing more to measure (one small module, already covered), call give_up with impossible true and say so.`;
}

const DRAFT_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "list_files",
    description: "List files under a directory of the target repository (relative path, '.' for the root).",
    input_schema: { type: "object", properties: { dir: { type: "string" } }, required: ["dir"], additionalProperties: false },
  },
  {
    name: "read_file",
    description: "Read a text file of the target repository, optionally a 1-based inclusive line range.",
    input_schema: { type: "object", properties: { path: { type: "string" }, start_line: { type: "integer" }, end_line: { type: "integer" } }, required: ["path"], additionalProperties: false },
  },
  {
    name: "search",
    description: "Search the target repository for a regular expression. Returns up to 200 matching lines.",
    input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"], additionalProperties: false },
  },
  {
    name: "write_overlay_file",
    description:
      "Create or replace one overlay (harness) file. Overlay files are copied onto the repository root before the build and are always protected. The file must be named lineage_* (for example lineage_bench.py, examples/lineage_bench.rs) or lie under a directory named lineage or lineage_* (for example lineage_harness/Cargo.toml, lineage/bench/main.go), and must not exist in the repository.",
    input_schema: { type: "object", properties: { path: { type: "string" }, contents: { type: "string" } }, required: ["path", "contents"], additionalProperties: false },
  },
  {
    name: "write_recipe",
    description: "Write the whole recipe.yml (YAML). Replaces the previous draft.",
    input_schema: { type: "object", properties: { yaml: { type: "string" } }, required: ["yaml"], additionalProperties: false },
  },
  {
    name: "trial_calibrate",
    description:
      "Validate the draft and calibrate it in the real sandbox exactly as verifiers will: prepare (with network), build, run the tests twice, measure every metric, and run the equivalence harness twice on the same seed. Slow and limited in number; use it when the draft is complete.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "submit",
    description: "Submit the draft as a recipe proposal. Allowed only right after a trial_calibrate that reported ok, with no edits since.",
    input_schema: { type: "object", properties: { note: { type: "string", description: "one paragraph: what the recipe measures and why it is a good target" } }, required: ["note"], additionalProperties: false },
  },
  {
    name: "give_up",
    description:
      "Stop without a proposal. reason: one plain sentence a visitor of the agent's public page will read (no file dumps, at most 200 characters). impossible: true when no recipe can exist for this repository as it stands (it has no tests of its own that run offline on a CPU, it needs a GPU or other hardware, its results are not deterministic); false when only this draft failed.",
    input_schema: { type: "object", properties: { reason: { type: "string" }, impossible: { type: "boolean" } }, required: ["reason"], additionalProperties: false },
  },
];

/** Overlay paths the drafter may write: a file named lineage_* at any depth or any file under a lineage or lineage_* directory; never .git, never an existing repo file. */
export function overlayPathOk(rel: string, repoTree: string): string | null {
  const p = normalize(rel).replace(/^\.\//, "");
  if (!p || p.startsWith("..") || p.startsWith("/") || p.split("/").includes(".git")) return "path outside the overlay";
  // a harness is often several files (a Go main package, a Cargo harness crate, C++ sources with a Makefile):
  // the file itself, or a directory above it, carries the lineage name
  if (!p.split("/").some((seg) => seg === "lineage" || /^lineage_[\w.-]+$/.test(seg))) return "overlay paths must be a file named lineage_* or lie under a directory named lineage or lineage_*";
  if (existsSync(join(repoTree, p))) return "the repository already has this file; harness files must be new";
  return null;
}

/**
 * What a recipe of each class looks like, in a few lines (SPEC 6.1; the format reference shows it in
 * full). The drafter's requirements are otherwise written once for every class.
 */
export const CLASS_NOTES: Record<string, string> = {
  python:
    "Tests: the repository's own, run with pytest --junitxml=/out/junit.xml (parser junit; it runs unittest suites too). Harness: lineage_bench.py and lineage_equiv.py at the root, the benchmark run as `python lineage_bench.py <mode> $LINEAGE_SEED` under valgrind. Interpreter start and imports are part of every count: import only what the benchmark needs.",
  rust:
    "Tests: `cargo test --release --locked --offline --no-fail-fast 2>&1` with parser libtest. Harness: examples/lineage_bench.rs and examples/lineage_equiv.rs, built by `cargo build --release --locked --offline --all-targets` and run from target/release/examples/; they may use only the crate and std (no new dependency, a small seeded generator written in the file). prepare makes the lockfile when the repository commits none (`cargo generate-lockfile`, prepare_outputs [Cargo.lock]) and fetches. In a workspace, build, test and allow only the member crate you measure (-p <crate>, its src/**).",
  go:
    "Tests: `go test -json -count=1 -p 1 <packages> | gotap` with parser tap, GOCACHE under /work/src as in the reference. Harness: main packages in their own directories (lineage/<name>/main.go), built in build.commands into lineage_bin/. The benchmark runs with GOMAXPROCS=1 GOGC=off and callgrind's --toggle-collect on the one function that does the work, exactly as the reference's metric commands do, so the Go runtime's start is not counted and counts are deterministic.",
  zig:
    "The primary metric is the size in bytes of the ReleaseSmall artifacts (parser bytes, kind slim, min_effect as in the reference); an instruction count of a seeded workload (parser cachegrind-ir) is the second kind of target. Tests run through a TAP test runner in the overlay (parser tap). Use the reference's -target and -mcpu flags for every compile.",
  cpp:
    "Build the library's sources and the harness with the reference's compiler flags (a Makefile or CMake file in the overlay, output under lineage_out/). Tests print TAP (parser tap): the repository's own test file compiled against a small TAP main. Harness sources live under lineage/ or are named lineage_*.",
  solana:
    "Metrics are compute units, measured in process by a harness crate on seeded instruction data (parser number, deterministic; they are exact, so no cachegrind and no fixed_command), and the size of the program's .so (parser bytes, kind slim). The program is built with cargo-build-sbf as in the reference; the harness crate lives in lineage_harness/ and is built in prepare into /deps/bin. Tests are the program's own, with parser libtest.",
};

/** The class block of the drafter's prompt. */
export function classNotes(cls: string): string {
  const n = CLASS_NOTES[cls];
  return n ? `\nConventions of class ${cls} (the format reference shows them in full): ${n}\n` : "";
}

/** Model turns one draft may take. */
const MAX_TURNS = 30;

/** Turns a draft may take before its first trial; after them the loop tells the model to trial what it has. */
export const FIRST_TRIAL_TURNS = 12;

const probed = new Map<string, ImageFacts>();

/**
 * What the class image holds, read from it once (one short container, no network, no model): the
 * toolchain version it runs and build tools it lacks. A recipe that asks for another toolchain
 * version or a system library the image does not have fails its trial; knowing it first is free.
 */
export async function imageFacts(image: string, cls: Recipe["class"]): Promise<ImageFacts> {
  const have = probed.get(image);
  if (have) return have;
  const version: Record<string, string> = { rust: "rustc -V", solana: "rustc -V", go: "go version", python: "python3 -V", zig: "zig version", cpp: "cc --version | head -1" };
  const cmd = `${version[cls] ?? "true"} 2>/dev/null; for t in pkg-config cmake; do command -v $t >/dev/null 2>&1 || echo "MISSING $t"; done; [ -e /usr/include/openssl/ssl.h ] || echo "MISSING OpenSSL headers"`;
  const r = await runContainer({ image: runnableImage(image), cmd, cwd: "/", mounts: [], network: false, env: { PATH: "/usr/local/cargo/bin:/usr/local/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" }, limits: { cpus: 1, memory_mb: 512, pids: 64, wall_s: 60, disk_mb: 64 }, timeout_s: 60, job: "image-facts" });
  const lines = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const facts: ImageFacts = { toolchain: /\b(\d+\.\d+(?:\.\d+)?)\b/.exec(lines.find((l) => !l.startsWith("MISSING ")) ?? "")?.[1] ?? null, missing: lines.filter((l) => l.startsWith("MISSING ")).map((l) => l.slice(8)) };
  if (r.exit === 0 || facts.toolchain) probed.set(image, facts);
  return facts;
}

/** What the model reads with a turn's tool results while no trial has run: the turn budget before the first trial, then every third turn. */
export function paceNote(o: { turn: number; usd: number; capUsd: number; trials: number; firstTrialTurns: number }): string | null {
  if (o.trials > 0 || o.turn < o.firstTrialTurns || (o.turn - o.firstTrialTurns) % 3 !== 0) return null;
  return `Pace: ${o.turn} turns and ${o.usd.toFixed(2)} of ${o.capUsd.toFixed(2)} USD are used and no trial has run. Stop reading. Write recipe.yml and the overlay files now from what you know and call trial_calibrate: its report costs no model spend and says exactly what is wrong. A draft that ends without a trial leaves nothing to build on.`;
}

/** The note of a draft the loop submits itself: what was measured, from the passing trial's own report. */
export function autoNote(t: Pick<DraftTarget, "repo" | "commit">, report: string): string {
  const facts = report.split("\n").filter((l) => /^(build ok|metric |equivalence:|headroom:)/.test(l)).join("; ");
  return oneLine(`Recipe for ${t.repo} at ${t.commit.slice(0, 7)}. Its last trial calibration passed in the sandbox and the draft was not changed after it; the drafting model reached its limit before writing a note, so this note is that trial's report: ${facts}`, 1800);
}

/** The prompt section of a draft that follows drafts which did not pass: what each trial failed on, and that the files are already there. */
export function historySection(history: DraftHistory[], keptFiles: string[] = []): string {
  const lines = historyLines(history);
  const all = history.flatMap((d) => d.trials);
  const last = all.filter((t) => !t.ok && t.reason).at(-1);
  const passed = all.at(-1)?.ok === true;
  if (!lines.length && !keptFiles.length) return "";
  return `

EARLIER DRAFTS of this recipe did not pass. This was measured in the sandbox already; do not find it out again:
${lines.length ? lines.join("\n") : "- no trial was reached: the earlier draft spent its budget reading the repository"}${passed ? "\nThe last trial PASSED, and the draft ended before it was submitted. Change nothing: call trial_calibrate on the files as they are, then submit." : last ? `\nLast time this failed because: ${reasonLine(last.reason!)}. Fix exactly that first.` : "\nLast time no trial ran at all. Read less and trial early."}${keptFiles.length ? `\nThe draft directory already holds the previous draft (${keptFiles.join(", ")}); your first message shows the files. Keep what worked and change what failed; replace the approach only when the reason above shows it cannot work.` : ""}`;
}

/** The model a recipe is drafted with when the caller names none (a registry id; routed like every Claude call). */
export const DRAFT_MODEL = "claude-opus-5-5";

export class RecipeDrafter {
  constructor(
    private o: {
      client: Anthropic;
      model?: string;
      ledger: SpendLedger;
      capUsd: number;
      /** where the draft lives: <dir>/recipe.yml and <dir>/overlay/ */
      dir: string;
      target: DraftTarget;
      /** an existing recipe of the same class, shown as the format reference */
      example: { recipe_yml: string; overlay: Record<string, string> };
      /** set when the repository already has units: the draft is an additional unit (plan AGENT-EFFICIENCY 8.2) */
      more?: MoreContext;
      /** a harness directory the draft's overlay starts as a copy of (an additional unit: the repository's own unit's overlay), so a many-file harness is changed, not retyped */
      seedOverlay?: string | null;
      maxTrials?: number;
      /** model turns before the first trial after which the loop tells the model to trial what it has (default FIRST_TRIAL_TURNS; 4 when the draft resumes an earlier one) */
      firstTrialTurns?: number;
      /** what the class image holds (imageFacts); read from the image when absent. Tests pass it to run without a sandbox */
      image?: ImageFacts | null;
      /** earlier drafts of this recipe and why each trial failed: the prompt starts from them, so the model does not find them out again */
      history?: DraftHistory[];
      /** the directory of the last draft that did not pass (recipe.yml and overlay/): this draft starts as a copy of it */
      resume?: string | null;
      /** seconds of sandbox time each trial calibration took (the hosted runtime meters them to the agent's vault) */
      onSandbox?: (seconds: number) => void;
      log: (m: string) => void;
    },
  ) {}

  /** Trial calibration of the current draft (also used by tests and scripts directly). */
  async trial(seed = "d1af7"): Promise<TrialReport> {
    let loaded: LoadedRecipe;
    try {
      loaded = loadRecipe(this.o.dir);
    } catch (e) {
      return { ok: false, text: `recipe invalid: ${(e as Error).message}`, reason: { stage: "recipe", kind: "invalid", cause: oneLine((e as Error).message) } };
    }
    const r = loaded.recipe;
    const t = this.o.target;
    const fixed: [string, unknown, unknown][] = [
      ["name", r.name, t.name],
      ["repo", r.repo, t.repo],
      ["commit", r.commit, t.commit],
      ["class", r.class, t.class],
      ["requires.arch", r.requires.arch, t.arch],
      ["image", r.image, t.image],
    ];
    for (const [k, got, want] of fixed) if (got !== want) return { ok: false, text: `${k} must be ${want} (got ${got})`, reason: { stage: "recipe", kind: "invalid", cause: oneLine(`${k} must be ${want} (got ${got})`) } };
    // an additional unit: a duplicate of an existing unit is refused here, before any sandbox time
    const dup = this.o.more ? duplicateUnit(r, this.o.more.units.map((u) => u.recipe)) : null;
    if (dup) return { ok: false, text: `duplicate of an existing unit: ${dup.why}`, reason: { stage: "recipe", kind: "duplicate", cause: oneLine(dup.why) } };
    const lines: string[] = [`recipe_id ${loaded.recipe_id}`];
    try {
      const deps = await prepareDeps(loaded);
      lines.push(`prepare ok (deps ${deps.digest.slice(0, 12)})`);
      const { calibration, transcript } = await calibrate({ loaded, deps, seed, runs: 2 });
      lines.push(`build ok; stable tests ${calibration.stable.length}, known failures ${calibration.known_failures.length}, quarantined ${calibration.quarantined.length}`);
      if (calibration.stable.length) lines.push(`stable sample: ${calibration.stable.slice(0, 8).join(", ")}`);
      if (calibration.known_failures.length) lines.push(`known failures: ${calibration.known_failures.slice(0, 10).join(", ")}`);
      let ok = calibration.stable.length > 0;
      // the first thing that keeps this calibration from making a unit, from the transcript itself
      let reason: TrialReason | null = calibrationReason(r, calibration, transcript);
      for (const m of r.metrics) {
        const c = calibration.metrics[m.name]!;
        lines.push(`metric ${m.name}: ${c.enabled ? "enabled" : "DISABLED"} cv ${c.cv.toExponential(2)} base ${c.base_value ?? "-"}${c.reason ? ` (${c.reason})` : ""}`);
        if (m.deterministic && !c.enabled) ok = false;
      }
      for (const n of transcript.notes.slice(0, 6)) lines.push(`note: ${n.slice(0, 300)}`);
      for (const m of r.metrics) {
        const c = calibration.metrics[m.name];
        if (c?.enabled && typeof c.fixed_value === "number" && typeof c.base_value === "number" && c.base_value > 0) lines.push(`metric ${m.name}: not the library ${c.fixed_value} of ${c.base_value} (${((100 * c.fixed_value) / c.base_value).toFixed(1)}%)`);
      }
      if (this.o.more) {
        const why = headroomError(r, calibration, this.o.more.maxFixedShare);
        if (why) {
          lines.push(`headroom: NOT shown: ${why}`);
          ok = false;
          reason ??= { stage: "headroom", kind: "not_shown", cause: oneLine(why) };
        } else lines.push("headroom: shown");
      }
      if (r.equivalence) {
        const eq = await withBuiltTree({ loaded, deps, parentPatches: [], seed, job: "trial-equiv" }, async (run, tree) => {
          const a = await run("equivalence", r.equivalence!.command, [{ host: tree, container: "/work/src", readonly: true }]);
          const b = await run("equivalence", r.equivalence!.command, [{ host: tree, container: "/work/src", readonly: true }]);
          return { a, b };
        });
        const same = eq.a.exit === 0 && eq.b.exit === 0 && sha256Hex(eq.a.stdout) === sha256Hex(eq.b.stdout) && eq.a.stdout.length > 0;
        lines.push(`equivalence: exit ${eq.a.exit}/${eq.b.exit}, ${eq.a.stdout.length} bytes of output, ${same ? "identical digests" : "NOT identical or failed"}${eq.a.exit ? `; stderr: ${eq.a.stderr.slice(-600)}` : ""}`);
        if (!same) ok = false;
        reason ??= equivalenceReason(eq.a, eq.b, same, r.limits);
      } else {
        lines.push("equivalence: none (perf metrics need an equivalence harness)");
        ok = false;
        reason ??= { stage: "equivalence", kind: "none", cause: "the recipe has no equivalence harness, and a performance metric needs one" };
      }
      if (!ok) reason ??= { stage: "metric", kind: "missing", cause: "a deterministic metric is disabled" };
      return ok ? { ok, recipe_id: loaded.recipe_id, text: lines.join("\n") } : { ok, recipe_id: loaded.recipe_id, text: lines.join("\n"), reason: reason! };
    } catch (e) {
      lines.push(`FAILED: ${(e as Error).message.slice(0, 2500)}`);
      return { ok: false, recipe_id: loaded.recipe_id, text: lines.join("\n"), reason: errorReason(e, r) };
    }
  }

  /** Runs the Claude drafting loop. Returns the note when Claude submitted an ok draft. */
  async draft(): Promise<{ submitted: boolean; note?: string; usd: number; turns: number; trials: number; reason?: string; impossible?: boolean; /** every trial of this draft, in order */ outcomes: TrialOutcome[]; /** set when the loop ended without the model's decision */ stop?: DraftStop; /** turns and USD before the first trial started (the whole draft when none did) */ before_trial: { turns: number; usd: number } }> {
    const t = this.o.target;
    const repoTree = join(newWorkDir("draft-repo"), "src");
    materialize(t.repo, t.commit, null, repoTree);
    mkdirSync(join(this.o.dir, "overlay"), { recursive: true });
    // a draft after one that did not pass starts as a copy of it (recipe.yml and overlay), so only what failed is redone
    const prev = this.o.resume && existsSync(join(this.o.resume, "recipe.yml")) ? this.o.resume : null;
    const kept: Record<string, string> = {};
    if (prev) {
      cpSync(join(prev, "recipe.yml"), join(this.o.dir, "recipe.yml"));
      if (existsSync(join(prev, "overlay"))) cpSync(join(prev, "overlay"), join(this.o.dir, "overlay"), { recursive: true });
      kept["recipe.yml"] = readFileSync(join(this.o.dir, "recipe.yml"), "utf8");
      for (const f of Bun.spawnSync(["find", join(this.o.dir, "overlay"), "-type", "f"]).stdout.toString().split("\n").filter(Boolean).sort()) kept[`overlay/${relative(join(this.o.dir, "overlay"), f)}`] = readFileSync(f, "utf8");
    }
    const seeded = !prev && this.o.seedOverlay && existsSync(this.o.seedOverlay) ? (cpSync(this.o.seedOverlay, join(this.o.dir, "overlay"), { recursive: true }), Bun.spawnSync(["find", join(this.o.dir, "overlay"), "-type", "f"]).stdout.toString().split("\n").filter(Boolean).map((f) => relative(join(this.o.dir, "overlay"), f)).sort()) : [];
    const box = new ToolBox({ tree: repoTree } as unknown as ProposeContext, 0);
    // the free structural pass (repo-structure.ts): for a repository of several packages the prompt names ONE to
    // measure, with how it is fetched, built and tested alone. An additional unit has its own section instead.
    const image = this.o.image === undefined ? await imageFacts(t.image, t.class).catch(() => undefined) : (this.o.image ?? undefined);
    const structure = this.o.more ? null : repoStructure(repoTree, t.class, image);
    const multi = multiPackage(structure) && structure!.candidates[0]!.eligible;
    if (structure?.candidates.length) this.o.log(`recipe-drafter: structure: ${structure.candidates.length} package${structure.candidates.length === 1 ? "" : "s"}${multi ? `; told to measure ${structure.candidates[0]!.name} (${structure.candidates[0]!.path}), then ${structure.candidates.slice(1, 4).map((c) => c.name).join(", ")}` : ""}${image ? `; image toolchain ${image.toolchain ?? "not read"}${image.missing.length ? `, without ${image.missing.join(", ")}` : ""}` : ""}`);
    const one = structure && !multi && structure.candidates.length === 1 && (structure.candidates[0]!.risks.length || structure.candidates[0]!.notes.length) ? `\n\nA free reading of the checkout found one package:\n${candidateLine(structure.candidates[0]!, 0)}${image?.toolchain ? `\nThe image runs toolchain ${image.toolchain}${structure.toolchain ? `; the repository asks for ${structure.toolchain}` : ""}${image.missing.length ? `; it does NOT have ${image.missing.join(", ")}` : ""}.` : ""}` : "";
    const firstTrialTurns = this.o.firstTrialTurns ?? (prev ? 4 : FIRST_TRIAL_TURNS);
    const maxTrials = this.o.maxTrials ?? 4;
    let trials = 0;
    const outcomes: TrialOutcome[] = [];
    let turn = 0;
    let spent = 0;
    let beforeTrial: { turns: number; usd: number } | null = null;
    let lastOk: string | null = null; // draft digest of the last ok trial
    let lastOkText = ""; // and its report
    const digest = () => {
      const files = [join(this.o.dir, "recipe.yml")];
      const ov = join(this.o.dir, "overlay");
      for (const f of Bun.spawnSync(["find", ov, "-type", "f"]).stdout.toString().split("\n").filter(Boolean).sort()) files.push(f);
      return H("draft", ...files.map((f) => `${relative(this.o.dir, f)}:${existsSync(f) ? sha256Hex(readFileSync(f)) : "-"}`));
    };
    const ex = this.o.example;
    const system = `You are a recipe author in units, a network where agents improve real repositories and every accepted change is reproduced by independent verifiers in a sandbox.

A recipe makes one repository measurable. Draft a recipe for:
- repository ${t.repo} at commit ${t.commit}
- name: ${t.name}; class: ${t.class}; requires.arch: ${t.arch}; image: "${t.image}" (use exactly these)

Sandbox facts: workdir /work/src holds the repository plus your overlay files at the root. prepare commands run once WITH network and may only write under /deps (the repository tree is discarded afterwards); every other step runs with NO network, a read-only /deps, a read-only root filesystem, /tmp as tmpfs, as a non-root user. LINEAGE_SEED is the only nondeterministic input. junit output goes to /out/junit.xml. Commands run under sh -c with cwd /work/src.

Requirements:
- Tests: the repository's own tests, run so the parser recognises every test id (see the class conventions below). Never edit or skip upstream tests.
- Metrics: at least one deterministic metric of the class's kind. For an instruction count: parser cachegrind-ir, the same valgrind invocation as the example, of an overlay benchmark (lineage_bench.*) whose workload is generated only from the seed argument, exercising the library's real hot path the way it is used in practice, printing a checksum so work cannot be skipped. min_effect 0.01, holdout true.
- A benchmark should take --inputs-only as a last argument: it then does everything except call the library (start, imports, building the seeded inputs) and exits 0. Declare it on the metric as fixed_command (the metric's command plus --inputs-only): calibration records how much of the count is not the library's own work.
- Equivalence: an overlay program (lineage_equiv.*) that prints the library's outputs for many seeded random inputs (including edge cases and invalid inputs where the API defines behaviour) so any behaviour change alters the digest.
- patch.allowed_paths: only the library source a patch should change; protected_paths: tests, packaging, CI files and every overlay file (lineage_*).
- Keep limits modest like the example. ${this.o.more ? "The workload is sized by the headroom rule below." : "Bound the workload so one cachegrind run takes a few seconds."}
${classNotes(t.class)}
Format reference, an accepted recipe of the same class (${this.o.more ? "a unit this repository already has" : "another repository"}):
--- recipe.yml ---
${ex.recipe_yml}
${Object.entries(ex.overlay)
  .map(([p, c]) => `--- overlay/${p} ---\n${c}`)
  .join("\n")}

If the repository cannot have a recipe as it stands, do not force one: call give_up with impossible true. That is the case when it has no tests of its own that run offline on a CPU, when its code needs a GPU or other hardware, or when nothing it computes is deterministic. Never write tests for it yourself and never fake a metric.

Work efficiently: read only what you need (the library module and its tests; a line range of a long file, never a generated table), write the overlay files and recipe, run trial_calibrate, fix what it reports, then submit. You have ${maxTrials} trials and ${this.o.capUsd.toFixed(2)} USD of model spend for the whole draft; plan to reach your first trial within ${firstTrialTurns} turns.${this.o.more ? moreSection(this.o.more) : ""}${seeded.length ? `\n\nYour overlay already holds a copy of the format reference's harness files (${seeded.join(", ")}): keep the ones your recipe uses, and replace or add files with write_overlay_file. Every file in the overlay is part of your recipe.` : ""}${structureSection(structure, image)}${one}${historySection(this.o.history ?? [], Object.keys(kept))}`;
    const keptText = Object.entries(kept).map(([p, c]) => `--- ${p} ---\n${c}`).join("\n");
    const first = Object.keys(kept).length
      ? `Your draft already holds the previous draft's files, shown below${keptText.length > 60_000 ? " (the largest are cut here; write a file again to change it)" : ""}. Do not start over: fix what the last trial reported, change only what that needs, then call trial_calibrate.\n${keptText.length > 60_000 ? Object.entries(kept).map(([p, c]) => `--- ${p} ---\n${c.length > 6000 ? `${c.slice(0, 6000)}\n[... ${c.length - 6000} more characters]` : c}`).join("\n") : keptText}`
      : this.o.more ? `Start by listing the repository to find what the existing units do not measure, then draft the additional recipe for ${t.repo}.`
      : multi ? `Start with package 1 of the list, ${structure!.candidates[0]!.name}: read its manifest (${structure!.candidates[0]!.path}/) and the part of its public API a benchmark will call, then write the recipe and harness for it and trial.`
      : `Start by listing the repository, then draft the recipe for ${t.repo}.`;
    const res = await toolLoop({
      client: this.o.client,
      model: this.o.model ?? DRAFT_MODEL,
      effort: "medium",
      system,
      tools: DRAFT_TOOLS,
      first,
      ledger: this.o.ledger,
      who: "recipe-drafter",
      capUsd: this.o.capUsd,
      maxTurns: MAX_TURNS,
      log: this.o.log,
      onTurn: (n, usd) => {
        turn = n;
        spent = usd;
      },
      note: (n, usd) => {
        const note = paceNote({ turn: n, usd, capUsd: this.o.capUsd, trials, firstTrialTurns });
        if (note) this.o.log(`recipe-drafter: told to trial now (${n} turns, ${usd.toFixed(4)} USD, no trial yet)`);
        return note;
      },
      // a trial calibration can outlast the 5 minute prompt cache: on the site a 7 minute trial made the next turn write 107,802 tokens again (0.59 USD)
      keepAliveS: 240,
      handle: async (name, input) => {
        switch (name) {
          case "list_files":
          case "read_file":
          case "search":
            return box.run(name, input);
          case "write_overlay_file": {
            const p = String(input.path ?? "");
            const err = overlayPathOk(p, repoTree);
            if (err) throw new Error(err);
            const abs = join(this.o.dir, "overlay", normalize(p));
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, String(input.contents ?? ""));
            return `wrote overlay/${p}`;
          }
          case "write_recipe": {
            const y = String(input.yaml ?? "");
            try {
              Bun.YAML.parse(y);
            } catch (e) {
              throw new Error(`not valid YAML: ${(e as Error).message}`);
            }
            if (this.o.more) {
              // free, before any trial: a draft that measures nothing new on the same paths is not written
              const d = Bun.YAML.parse(y) as Partial<Recipe> | null;
              const shaped = d && Array.isArray(d.metrics) && d.metrics.every((m) => m && typeof m.name === "string" && typeof m.command === "string") && Array.isArray(d.patch?.allowed_paths) && d.patch.allowed_paths.every((p) => typeof p === "string");
              const dup = shaped ? duplicateUnit({ name: String(d.name ?? t.name), repo: t.repo, metrics: d.metrics!, patch: d.patch! }, this.o.more.units.map((u) => u.recipe)) : null;
              if (dup) throw new Error(`refused, nothing was written: this draft duplicates an existing unit: ${dup.why}`);
            }
            writeFileSync(join(this.o.dir, "recipe.yml"), y.endsWith("\n") ? y : y + "\n");
            return "wrote recipe.yml";
          }
          case "trial_calibrate": {
            if (trials >= maxTrials) throw new Error(`trial limit reached (${maxTrials}); submit or give_up`);
            trials++;
            beforeTrial ??= { turns: turn, usd: spent };
            this.o.log(`recipe-drafter: trial ${trials}/${maxTrials} (after ${turn} turn${turn === 1 ? "" : "s"}, ${spent.toFixed(4)} USD)`);
            const t0 = Date.now();
            const rep = await this.trial();
            const seconds = (Date.now() - t0) / 1000;
            this.o.onSandbox?.(seconds);
            outcomes.push({ n: trials, ok: rep.ok, seconds: Math.round(seconds * 10) / 10, reason: rep.ok ? null : (rep.reason ?? null) });
            // the first line is the one a runtime keeps in its journal: it says why
            this.o.log(`recipe-drafter: trial ${trials} ${rep.ok ? "ok" : `not ok: ${rep.reason ? reasonLine(rep.reason) : "no reason recorded"}`} (${Math.round(seconds)} s)\n${rep.text}`);
            lastOk = rep.ok ? digest() : null;
            if (rep.ok) lastOkText = rep.text;
            return `${rep.ok ? "TRIAL OK" : `TRIAL NOT OK\nwhy: ${rep.reason ? reasonLine(rep.reason) : "see below"}`}\n${rep.text}`;
          }
          case "submit":
            if (!lastOk || lastOk !== digest()) throw new Error("the last trial_calibrate was not ok, or the draft changed since; trial first");
            return { done: { note: String(input.note ?? "").slice(0, 2000) } };
          case "give_up":
            return { done: { gave_up: String(input.reason ?? "").slice(0, 400), impossible: input.impossible === true } };
          default:
            throw new Error(`unknown tool ${name}`);
        }
      },
    });
    removeTree(dirname(repoTree));
    const v = res.value as { note?: string; gave_up?: string; impossible?: boolean } | null;
    const before_trial = beforeTrial ?? { turns: res.turns, usd: res.usd };
    if (v?.note !== undefined) return { submitted: true, note: v.note, usd: res.usd, turns: res.turns, trials, outcomes, before_trial };
    if (v?.gave_up !== undefined) return { submitted: false, usd: res.usd, turns: res.turns, trials, reason: v.gave_up || "the drafter gave up without a reason", impossible: v.impossible === true, outcomes, before_trial };
    // no decision of the model: the loop ended at its spend cap, its turn limit or a refusal.
    // A draft whose last trial passed and that was not changed since is complete: it meets the one condition
    // of submit, and only the model's note is missing. It is proposed with the trial's own report as its note,
    // not thrown away (measured 2026-10-13: a first trial that passed after 397 s ended a draft at its cap).
    if (lastOk && lastOk === digest()) {
      this.o.log(`recipe-drafter: the last trial passed and the draft is unchanged: submitted by the loop (no budget was left for the model's note)`);
      return { submitted: true, note: autoNote(t, lastOkText), usd: res.usd, turns: res.turns, trials, outcomes, before_trial };
    }
    // The reason names the last trial's failure in fixed words (the raw cause stays in `outcomes`)
    const stop: DraftStop = trials >= maxTrials ? "trials" : res.turns >= MAX_TURNS ? "turns" : "spend";
    const last = outcomes.filter((o) => !o.ok && o.reason).at(-1);
    const ended = stop === "trials" ? `it used its ${maxTrials} trials` : stop === "turns" ? "it used all its turns" : "it reached its spend limit";
    const reason = last ? `${reasonWords(last.n, last.reason!)}, and ${ended}` : trials ? `the draft was not submitted, and ${ended}` : `${ended} before its first trial (${res.turns} turn${res.turns === 1 ? "" : "s"})`;
    return { submitted: false, usd: res.usd, turns: res.turns, trials, reason, outcomes, stop, before_trial };
  }
}

// ---------------------------------------------------------------------------------------------
// Submitting

/** Uploads a recipe directory's overlay files as blobs and posts the proposal. */
export async function submitProposal(client: CoreClient, dir: string, note: string) {
  const loaded = loadRecipe(dir);
  const overlay: Record<string, string> = {};
  for (const f of loaded.overlayFiles) {
    const bytes = readFileSync(join(loaded.overlayDir!, f));
    const sha = sha256Hex(bytes);
    const put = await client.putBlob(sha, new Uint8Array(bytes));
    if (put.status >= 300) throw new Error(`blob ${f}: HTTP ${put.status}`);
    overlay[f] = sha;
  }
  const r = await client.post("/v1/recipe-proposals", { recipe: loaded.recipe, recipe_id: loaded.recipe_id, overlay, note });
  if (r.status >= 300) throw new Error(`proposal: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 500)}`);
  return r.body as { proposal_id: string; status: string; recipe_id: string };
}

// ---------------------------------------------------------------------------------------------
// Verifying

export interface CalibAssignment {
  replay_id: string;
  kind: "calibrate";
  proposal_id: string;
  status: "assigned" | "committed";
  reveal_open: boolean;
  recipe_id: string;
  recipe: Recipe;
  overlay: Record<string, string>;
  seed: string;
  runs: number;
}

/** Writes a proposed recipe (Core's JSON plus overlay blobs) as a recipe directory and checks its id. */
export async function materializeProposal(client: CoreClient, a: { recipe: Recipe; recipe_id: string; overlay: Record<string, string> }, root = join(UNITS_HOME, "proposals")): Promise<LoadedRecipe> {
  // Core supplies both: a compromised Core naming "../../.." made the worker delete and write
  // outside its proposals directory before anything was validated (audit A2, OFF-K1)
  if (typeof a.recipe?.name !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(a.recipe.name)) throw new RecipeError("proposed recipe name must be lowercase kebab");
  if (typeof a.recipe_id !== "string" || !/^[0-9a-f]{64}$/.test(a.recipe_id)) throw new RecipeError("recipe_id must be 64 hex");
  const dir = join(root, a.recipe.name + "-" + a.recipe_id.slice(0, 12));
  // already written (by an earlier call, or by another process of this home): the id is re-derived from
  // the files, so a match is the same content, and a calibration running in that directory is left alone
  try {
    const have = loadRecipe(dir);
    if (have.recipe_id === a.recipe_id) return have;
  } catch {}
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // JSON is YAML; loadRecipe re-derives the overlay digest and protections from the files
  writeFileSync(join(dir, "recipe.yml"), JSON.stringify(a.recipe, null, 2) + "\n");
  for (const [p, sha] of Object.entries(a.overlay)) {
    const r = await client.request("GET", `/v1/blobs/${sha}`, undefined, { sign: false });
    if (r.status !== 200) throw new Error(`overlay blob ${p}: HTTP ${r.status}`);
    const bytes = new Uint8Array(r.body as ArrayBuffer);
    if (sha256Hex(bytes) !== sha) throw new Error(`overlay blob ${p}: digest mismatch`);
    const abs = join(dir, "overlay", normalize(p));
    if (relative(join(dir, "overlay"), abs).startsWith("..")) throw new Error(`overlay path ${p}`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
  }
  const loaded = loadRecipe(dir);
  if (loaded.recipe_id !== a.recipe_id) throw new RecipeError(`proposed recipe recomputes to ${loaded.recipe_id}, Core says ${a.recipe_id}`);
  return loaded;
}

export class CalibrationVerifier {
  readonly client: CoreClient;
  private pending = new Map<string, { calibration: Calibration; deps_digest: string; salt: string }>();

  constructor(
    core: string,
    key: SigningKey,
    private log: (m: string) => void = (m) => console.log(`[calibrate] ${m}`),
    private root = join(UNITS_HOME, "proposals"),
  ) {
    this.client = new CoreClient(core, key);
  }

  /** True once the worker is stopping: no new calibration run starts. */
  stopping: () => boolean = () => false;

  async once(): Promise<number> {
    const r = await this.client.get("/v1/recipe-proposals/assignments", true);
    if (r.status >= 300) throw new Error(`calibration assignments: HTTP ${r.status}`);
    let acted = 0;
    for (const a of r.body as CalibAssignment[]) {
      try {
        if (a.status === "assigned") {
          if (this.stopping()) continue;
          const t0 = Date.now();
          const loaded = await materializeProposal(this.client, a, this.root);
          const deps = await prepareDeps(loaded);
          const { calibration } = await calibrate({ loaded, deps, seed: a.seed, runs: a.runs });
          const salt = randomBytes(16).toString("hex");
          const res = { calibration, deps_digest: deps.digest };
          this.pending.set(a.replay_id, { ...res, salt });
          const c = await this.client.post(`/v1/recipe-proposals/replays/${a.replay_id}/commit`, { commitment: calibCommitment(res, salt) });
          if (c.status >= 300) throw new Error(`commit: HTTP ${c.status} ${JSON.stringify(c.body)}`);
          const ms = Object.entries(calibration.metrics).map(([k, v]) => `${k}=${v.enabled ? v.base_value : "off"}`).join(" ");
          this.log(`calibration ${a.replay_id.slice(0, 10)} of ${a.recipe.name}: ${calibration.stable.length} stable, ${calibration.known_failures.length} known failures, ${ms}; committed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
          acted++;
        } else if (a.reveal_open) {
          const p = this.pending.get(a.replay_id);
          if (!p) continue;
          const v = await this.client.post(`/v1/recipe-proposals/replays/${a.replay_id}/reveal`, p);
          if (v.status >= 300) throw new Error(`reveal: HTTP ${v.status} ${JSON.stringify(v.body)}`);
          this.pending.delete(a.replay_id);
          this.log(`calibration ${a.replay_id.slice(0, 10)}: revealed, proposal ${(v.body as { proposal: string }).proposal}`);
          acted++;
        }
      } catch (e) {
        this.log(`calibration ${a.replay_id.slice(0, 10)}: ${(e as Error).message.slice(0, 600)}`);
      }
    }
    return acted;
  }
}

// ---------------------------------------------------------------------------------------------
// Recipes that came from a proposal

const fetching = new Map<string, Promise<boolean>>();

/**
 * Makes `recipe_id` available in `book`. A recipe Core admitted from a proposal (SPEC 6.2) is in no
 * release: its JSON and overlay blobs are read from Core's accepted proposals once, written under
 * UNITS_HOME/proposals (where the book finds them again after a restart) and checked to recompute to
 * the same id. False when the book does not have it and Core has no accepted proposal for it.
 */
export async function ensureRecipe(book: { has(id: string): boolean; add(l: LoadedRecipe): void }, client: CoreClient, recipe_id: string, root = join(UNITS_HOME, "proposals")): Promise<boolean> {
  if (book.has(recipe_id)) return true;
  if (!/^[0-9a-f]{64}$/.test(recipe_id)) return false;
  let p = fetching.get(recipe_id);
  if (!p) {
    p = (async () => {
      const r = await client.request("GET", "/v1/recipe-proposals?status=accepted", undefined, { sign: false });
      if (r.status !== 200 || !Array.isArray(r.body)) return false;
      const a = (r.body as { recipe: Recipe; recipe_id: string; overlay: Record<string, string> }[]).find((x) => x.recipe_id === recipe_id);
      if (!a) return false;
      book.add(await materializeProposal(client, a, root));
      return true;
    })().finally(() => fetching.delete(recipe_id));
    fetching.set(recipe_id, p);
  }
  return (await p) || book.has(recipe_id);
}
