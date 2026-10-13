import { homedir, tmpdir } from "node:os";
import type { Calibration, Recipe } from "@units/protocol";
import { isolateMetric, parseMetric, UNITS_HOME, type Transcript, type TranscriptStep } from "@units/sandbox";

// Why a trial calibration of a recipe draft failed (SPEC 6.2), taken from the sandbox result itself:
// the stage that failed (prepare, build, tests, a metric, the equivalence harness), which rule it was
// (a fixed word the public sentence is chosen by), and a short cause: the compiler's first error with
// its file, the tests that failed and how many, the two readings of a metric that was not the same on
// identical runs, the measured time of a step that hit its limit. The cause is plain text on one
// line, bounded, with host paths, tokens and environment values removed: it is a public repository's
// build output, and it still goes to a log, a state file, the next draft's prompt and a public panel.
// Nothing here calls a model or the sandbox.

export type TrialStage = "recipe" | "prepare" | "build" | "tests" | "metric" | "equivalence" | "headroom" | "sandbox";

export interface TrialReason {
  stage: TrialStage;
  /** which rule failed: one of KINDS */
  kind: string;
  /** the short cause, scrubbed, at most CAUSE_MAX characters */
  cause: string;
  /** measured seconds of the step that failed, when one ran */
  seconds?: number;
}

/** One trial of a draft as it is kept: its number, whether it passed, how long it took and why not. */
export interface TrialOutcome {
  n: number;
  ok: boolean;
  seconds: number;
  reason: TrialReason | null;
}

export const CAUSE_MAX = 240;

/** Every kind a reason can have, with the few words the runtime's sentence uses for it. */
export const KINDS: Record<string, string> = {
  invalid: "recipe not valid",
  duplicate: "nothing new measured",
  network: "a download failed",
  toolchain: "toolchain version",
  offline: "a dependency was not fetched",
  compile: "compile error",
  time: "time limit",
  memory: "memory limit",
  disk: "disk limit",
  processes: "process limit",
  failed: "command failed",
  not_recognised: "test output not recognised",
  none_stable: "no test passed every run",
  missing: "a metric gave no value",
  not_deterministic: "a metric differed between identical runs",
  too_noisy: "a metric too noisy",
  none: "no equivalence harness",
  differs: "equivalence output differed between identical runs",
  empty: "equivalence harness printed nothing",
  not_shown: "too much of the count is not the library",
  unavailable: "sandbox not available",
};

/** The word each stage has in a sentence. */
export const STAGE_WORD: Record<TrialStage, string> = { recipe: "the recipe", prepare: "prepare", build: "build", tests: "tests", metric: "metrics", equivalence: "equivalence", headroom: "headroom", sandbox: "the sandbox" };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Plain text safe to show: no terminal colours or control characters, no path of this host (the
 * sandbox's own paths become repository-relative), no token, key or environment value, no em dash.
 * Whitespace is kept (callers cut lines first); use oneLine for a single bounded line.
 */
export function scrub(text: string): string {
  let t = String(text ?? "");
  // terminal escapes and control characters
  t = t.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b[@-_]/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  // credentials inside URLs, bearer and basic headers
  t = t.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, "$1[removed]@").replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [removed]");
  // known token shapes
  t = t.replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|e2b_[A-Za-z0-9]{16,})\b/g, "[removed]");
  // NAME=value where the name says it is a secret, then any other environment assignment of a secret-looking value
  t = t.replace(/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|MNEMONIC|PRIVATE)[A-Za-z0-9_]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1$2[removed]");
  // long unbroken key material: hex of 64 or more, or 48 or more characters of one base64 or base58 word (a commit id of 40 hex stays)
  t = t.replace(/\b[0-9a-fA-F]{64,}\b/g, "[removed]").replace(/(?<![A-Za-z0-9+/_=-])(?=[A-Za-z0-9+_=-]*\d)(?=[A-Za-z0-9+_=-]*[A-Za-z])[A-Za-z0-9+_=-]{48,}(?![A-Za-z0-9+/_=-])/g, "[removed]");
  // the sandbox's own paths: repository-relative, and a short name for the dependency layer
  t = t.replace(/\/deps\/cargo\/registry\/src\/[^/\s]+\//g, "deps:").replace(/\/deps\/cargo\/git\/checkouts\/[^/\s]+\/[^/\s]+\//g, "deps:").replace(/\/work\/src\//g, "").replace(/\/work\/src\b/g, ".");
  // this host's paths: the units home, the user's home, temporary directories, then any other home
  for (const p of [UNITS_HOME, homedir(), tmpdir(), "/private" + tmpdir()].filter((x) => x && x.length > 3).sort((a, b) => b.length - a.length)) t = t.replace(new RegExp(esc(p.replace(/\/+$/, "")) + "(?=/|\\b)", "g"), "[host]");
  t = t.replace(/\/(?:Users|home)\/[^/\s:'"]+/g, "[host]").replace(/\/(?:root|var\/lib\/[a-z0-9-]*units[a-z0-9-]*|var\/lib\/lineage|opt\/(?:units|lineage)[a-z0-9-]*|etc\/(?:units|lineage)[a-z0-9-]*|private\/(?:tmp|var)\/[^/\s:'"]+)(?=\/|\b)/g, "[host]");
  return t.replace(/\u2014/g, ", ");
}

/** One scrubbed line, at most `max` characters. */
export function oneLine(text: string, max = CAUSE_MAX): string {
  const t = scrub(text).replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 3).trimEnd()}...`;
}

const NOISE = /^(warning(\[|:)|\s*Compiling |\s*Downloaded |\s*Downloading |\s*Finished |\s*Running |\s*Updating |\s*Fresh |\s*Locking |\s*Checking |note: |help: |\s*= (note|help): |error: aborting due to|error: could not compile|For more information about this error|Some errors have detailed explanations|make(\[\d+\])?: \*\*\*|ninja: build stopped|==\d+== |Caused by:$|\s*\|?\s*$)/;
const SIGNAL = /(^|\s)(error(\[[A-Z]?\d+\])?:|fatal( error)?:|panicked at|thread '.*' panicked|[A-Za-z_.]*(Error|Exception): |cannot find|could not |couldn't |no such file|not found|undefined (reference|symbol)|unresolved|failed to |permission denied|is not installed|no space left|out of memory|killed|segmentation fault|assertion|FAILED|timed out|requires )/i;

/**
 * The most telling line of a step's output: the compiler's first error with the file it points at, a
 * Python exception (the last line of its traceback), else the first line that names a failure, else
 * the last line that says anything.
 */
export function causeOf(output: string, max = CAUSE_MAX): string {
  const lines = scrub(output).split("\n").map((l) => l.replace(/\s+$/, ""));
  const said = lines.filter((l) => l.trim() && !NOISE.test(l));
  if (!said.length) return "";
  // rustc, clang, gcc, zig, go: `error...: message` followed by where
  const at = lines.findIndex((l) => /^\s*error(\[[A-Z]?\d+\])?: /.test(l) && !NOISE.test(l));
  if (at >= 0) {
    const where = lines.slice(at + 1, at + 4).map((l) => /^\s*-->\s*(\S+)/.exec(l)).find(Boolean);
    // path:line, without the column
    const loc = where ? where[1]!.replace(/^([^:]+:\d+):\d+$/, "$1") : null;
    return oneLine(`${lines[at]!.trim()}${loc ? ` in ${loc}` : ""}`, max);
  }
  // file:line:col: error: message (C, C++, Zig, Go vet)
  const cc = lines.find((l) => /^[^\s:]+:\d+(:\d+)?: (fatal )?error: /.test(l));
  if (cc) return oneLine(cc, max);
  // a Python traceback: its last line is the exception
  const tb = lines.map((l) => /^Traceback \(most recent call last\):/.test(l)).lastIndexOf(true);
  if (tb >= 0) {
    const exc = lines.slice(tb + 1).find((l) => /^[A-Za-z_][\w.]*(Error|Exception|Exit|Interrupt|Warning)?: /.test(l) || /^[A-Za-z_][\w.]*(Error|Exception)$/.test(l));
    if (exc) return oneLine(exc, max);
  }
  return oneLine(said.find((l) => SIGNAL.test(l)) ?? said[said.length - 1]!, max);
}

type Step = Pick<TranscriptStep, "exit" | "timed_out" | "duration_ms" | "stderr_tail" | "stdout_tail"> & { step?: string };

const secs = (ms: number) => Math.round(ms / 100) / 10;
const count = (n: number) => n.toLocaleString("en-US");

/** A failed step (prepare, build, a test or metric command) as a reason: a limit first, then what its output says. */
export function stepReason(stage: TrialStage, step: Step, limits?: { wall_s?: number; memory_mb?: number; disk_mb?: number; test_timeout_s?: number }): TrialReason {
  const out = `${step.stderr_tail ?? ""}\n${step.stdout_tail ?? ""}`;
  const seconds = secs(step.duration_ms ?? 0);
  const said = causeOf(step.stderr_tail || step.stdout_tail || "");
  const r = (kind: string, cause: string): TrialReason => ({ stage, kind, cause: oneLine(cause), seconds });
  if (step.timed_out) {
    const limit = stage === "tests" ? limits?.test_timeout_s : limits?.wall_s;
    return r("time", `stopped at the time limit${limit ? ` of ${count(limit)} s` : ""} after ${count(seconds)} s`);
  }
  if (/No space left on device|Disk quota exceeded|ENOSPC/i.test(out)) return r("disk", `ran out of disk${limits?.disk_mb ? ` (limit ${count(limits.disk_mb)} MB)` : ""} after ${count(seconds)} s: ${said}`);
  if (step.exit === 137 || /\b(out of memory|Cannot allocate memory|memory allocation of \d+ bytes failed|std::bad_alloc|MemoryError|signal: 9, SIGKILL)\b/i.test(out)) return r("memory", `ran out of memory${limits?.memory_mb ? ` (limit ${count(limits.memory_mb)} MB)` : ""} after ${count(seconds)} s${said ? `: ${said}` : ""}`);
  if (/Resource temporarily unavailable|failed to spawn thread|can't start new thread|fork: retry|pthread_create failed/i.test(out)) return r("processes", `hit the process limit after ${count(seconds)} s: ${said}`);
  if (/toolchain '[^']*' is not installed|rustup could not|error: could not download file|info: (syncing|downloading) (channel|component)|requires rustc \d|cannot be built because it requires rustc|rustc [\d.]+ is not supported by|is not supported by the following package|feature `edition\d+` is required|requires a newer version of Cargo|lock file version `?\d+`? (was found|requires)|requires go ?>?=? ?\d|go\.mod requires go|toolchain not available|requires zig version|minimum_zig_version|Requires-Python|requires a different Python|python_requires/i.test(out)) return r("toolchain", said);
  if (stage === "prepare" && /Could not resolve host|Temporary failure in name resolution|spurious network error|failed to (fetch|download)|Connection (reset|refused|timed out)|network (is )?unreachable|i\/o timeout|TLS|SSL|HTTP (error )?(4|5)\d\d|status code (4|5)\d\d|the requested URL returned error/i.test(out)) return r("network", said);
  if (stage !== "prepare" && /--offline|offline mode|no matching package named|can't checkout from|Unable to update registry|failed to (download|fetch|load source)|cannot find module providing package|missing go\.sum entry|No matching distribution found|Could not find a version that satisfies|ModuleNotFoundError|No module named|network access|Could not resolve host|Temporary failure in name resolution/i.test(out)) return r("offline", said);
  if (stage === "build" || /(^|\n)\s*error(\[[A-Z]?\d+\])?: |: (fatal )?error: |SyntaxError|undefined reference/.test(out)) return r(stage === "prepare" ? "failed" : "compile", said || `exit ${step.exit}`);
  return r("failed", said ? `exit ${step.exit}: ${said}` : `exit ${step.exit} with no output`);
}

/** The step a thrown sandbox error carries (EvalError.step), or null. */
const stepOf = (e: unknown): (Step & { step: string }) | null => {
  const s = (e as { step?: Step & { step?: string } } | null)?.step;
  return s && typeof s === "object" && typeof s.step === "string" ? (s as Step & { step: string }) : null;
};

const STAGE_OF_STEP: Record<string, TrialStage> = { prepare: "prepare", build: "build", test: "tests", metrics: "metric", equivalence: "equivalence" };

/** A trial that threw (prepare, the calibration build, an unreadable test output, a metric past its time, the sandbox itself). */
export function errorReason(e: unknown, recipe: Pick<Recipe, "limits" | "test">): TrialReason {
  const msg = (e as Error)?.message ?? String(e);
  const limits = { ...recipe.limits, test_timeout_s: recipe.test?.timeout_s };
  const step = stepOf(e);
  if (/^the sandbox could not be started|image not available|Cannot connect to the Docker daemon|docker: /.test(msg)) return { stage: "sandbox", kind: "unavailable", cause: oneLine(msg) };
  if (/^test output not recognised/.test(msg)) {
    const said = step ? causeOf(step.stderr_tail || step.stdout_tail || "") : "";
    if (step?.timed_out) return stepReason("tests", step, limits);
    return { stage: "tests", kind: "not_recognised", cause: oneLine(`the test command printed nothing the ${recipe.test?.parser ?? ""} parser reads${step ? ` (exit ${step.exit})` : ""}${said ? `: ${said}` : ""}`), ...(step ? { seconds: secs(step.duration_ms) } : {}) };
  }
  const timed = /^metric (\S+) timed out/.exec(msg);
  if (timed) return { stage: "metric", kind: "time", cause: oneLine(`metric ${timed[1]} was stopped at the time limit of ${count(recipe.limits?.wall_s ?? 0)} s${step ? ` after ${count(secs(step.duration_ms))} s` : ""}`), ...(step ? { seconds: secs(step.duration_ms) } : {}) };
  if (step) return stepReason(STAGE_OF_STEP[step.step] ?? "sandbox", step, limits);
  // no step attached (an older sandbox, or an error before any command ran): read the message
  const prep = /^prepare failed \((-?\d+)\): ([\s\S]*)$/.exec(msg);
  if (prep) return stepReason("prepare", { exit: Number(prep[1]), timed_out: Number(prep[1]) === 124, duration_ms: 0, stderr_tail: prep[2]!, stdout_tail: "" }, limits);
  const build = /^calibration build failed: ([\s\S]*)$/.exec(msg);
  if (build) return stepReason("build", { exit: 1, timed_out: false, duration_ms: 0, stderr_tail: build[1]!, stdout_tail: "" }, limits);
  if (/^prepare output /.test(msg)) return { stage: "prepare", kind: "failed", cause: oneLine(msg) };
  return { stage: "sandbox", kind: "failed", cause: oneLine(msg) };
}

/**
 * A calibration that ran to its end but does not make a unit: no test passed every run, or a
 * deterministic metric is disabled. Null when the calibration is good.
 */
export function calibrationReason(recipe: Pick<Recipe, "metrics" | "limits" | "test">, calibration: Calibration, transcript: Pick<Transcript, "steps" | "notes">): TrialReason | null {
  const limits = { ...recipe.limits, test_timeout_s: recipe.test?.timeout_s };
  if (!calibration.stable.length) {
    const t = transcript.steps.filter((s) => s.step === "test").at(-1);
    if (t?.timed_out) return stepReason("tests", t, limits);
    const failed = calibration.known_failures.length;
    const flaky = calibration.quarantined.length;
    const names = [...calibration.known_failures, ...calibration.quarantined].slice(0, 3).join(", ");
    const said = t ? causeOf(t.stderr_tail || t.stdout_tail || "") : "";
    const what = failed + flaky === 0 ? "the test command ran no test" : `no test passed in every run: ${count(failed)} failed every run${flaky ? `, ${count(flaky)} passed only sometimes` : ""} (${names}${failed + flaky > 3 ? ", ..." : ""})`;
    return { stage: "tests", kind: "none_stable", cause: oneLine(`${what}${said ? `; ${said}` : ""}`), ...(t ? { seconds: secs(t.duration_ms) } : {}) };
  }
  for (const m of recipe.metrics) {
    const c = calibration.metrics[m.name];
    if (!m.deterministic || !c || c.enabled) continue;
    const runs = transcript.steps.filter((s) => s.step === "metrics" && (s.cmd === isolateMetric(m) || s.cmd === m.command));
    if (/not deterministic/.test(c.reason ?? "")) {
      const vals: number[] = [];
      for (const s of runs)
        try {
          vals.push(parseMetric(m.parser, s.stdout_tail, s.stderr_tail));
        } catch {}
      const lo = Math.min(...vals);
      const hi = Math.max(...vals);
      const read = vals.length >= 2 && hi > lo ? `it read ${count(lo)} and ${count(hi)} on identical runs (${count(hi - lo)} apart); ` : "";
      return { stage: "metric", kind: "not_deterministic", cause: oneLine(`metric ${m.name} is not deterministic: ${read}spread (cv) ${c.cv.toExponential(2)}, allowed ${((m.tolerance ?? 0.001) / 2).toExponential(2)}`) };
    }
    if (/too noisy/.test(c.reason ?? "")) return { stage: "metric", kind: "too_noisy", cause: oneLine(`metric ${m.name}: ${c.reason}`) };
    const bad = runs.filter((s) => s.exit !== 0).at(-1) ?? runs.at(-1);
    if (bad && bad.exit !== 0) {
      const sr = stepReason("metric", bad, limits);
      return { ...sr, kind: sr.kind === "failed" || sr.kind === "compile" ? "missing" : sr.kind, cause: oneLine(`metric ${m.name} gave no value: ${sr.cause}`) };
    }
    const note = transcript.notes.find((n) => n.startsWith(`metric ${m.name} `));
    return { stage: "metric", kind: "missing", cause: oneLine(`metric ${m.name} gave no value${note ? `: ${note.replace(`metric ${m.name} `, "")}` : `: its command exited 0 but the ${m.parser} parser found no number`}`), ...(bad ? { seconds: secs(bad.duration_ms) } : {}) };
  }
  return null;
}

/** The equivalence harness run twice on one seed: it must exit 0 both times and print the same, non-empty output. */
export function equivalenceReason(a: { exit: number; stdout: string; stderr: string; timed_out?: boolean; duration_ms?: number }, b: { exit: number; stdout: string; stderr: string; timed_out?: boolean; duration_ms?: number }, same: boolean, limits?: { wall_s?: number; memory_mb?: number; disk_mb?: number }): TrialReason | null {
  if (same) return null;
  const bad = a.exit !== 0 ? a : b.exit !== 0 ? b : null;
  if (bad) {
    const sr = stepReason("equivalence", { exit: bad.exit, timed_out: !!bad.timed_out, duration_ms: bad.duration_ms ?? 0, stderr_tail: bad.stderr.slice(-4000), stdout_tail: "" }, limits);
    return sr.kind === "compile" ? { ...sr, kind: "failed" } : sr;
  }
  if (!a.stdout.length) return { stage: "equivalence", kind: "empty", cause: "the equivalence harness exited 0 and printed nothing, so there is nothing to compare" };
  return { stage: "equivalence", kind: "differs", cause: oneLine(`two runs on the same seed printed different output (${count(a.stdout.length)} and ${count(b.stdout.length)} bytes): something in it is not seeded`) };
}

/** "build: error[E0433]: ... in curve25519/src/lib.rs:12": the log line's and the prompt's form. */
export function reasonLine(r: TrialReason): string {
  return `${STAGE_WORD[r.stage]}: ${r.cause}`;
}

/** "trial 2 failed at build (compile error)": the words of the runtime's public sentence; no raw output. */
export function reasonWords(n: number, r: TrialReason): string {
  return `trial ${n} failed at ${STAGE_WORD[r.stage]} (${KINDS[r.kind] ?? r.kind})`;
}

/** Earlier trials as the next draft's prompt reads them, newest last, at most `max` lines. */
export function historyLines(drafts: { draft: number; trials: TrialOutcome[] }[], max = 8): string[] {
  const out: string[] = [];
  for (const d of drafts) for (const t of d.trials) out.push(`- draft ${d.draft}, trial ${t.n} (${count(Math.round(t.seconds))} s): ${t.ok ? "passed" : t.reason ? reasonLine(t.reason) : "failed"}`);
  return out.slice(-max);
}
