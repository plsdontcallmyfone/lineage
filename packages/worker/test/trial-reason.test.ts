import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import type { Calibration, Recipe } from "@units/protocol";
import { EvalError, isolateMetric, UNITS_HOME, type Transcript, type TranscriptStep } from "@units/sandbox";
import { historySection } from "../src/recipe-proposer.ts";
import { calibrationReason, CAUSE_MAX, causeOf, equivalenceReason, errorReason, historyLines, KINDS, oneLine, reasonLine, reasonWords, scrub, stepReason } from "../src/trial-reason.ts";

// Why a trial calibration of a recipe draft failed (trial-reason.ts): the stage, the rule and a short
// cause read from the sandbox result, safe to show.

const step = (o: Partial<TranscriptStep>): TranscriptStep => ({ step: "build", cmd: "x", exit: 1, duration_ms: 12_340, timed_out: false, stdout_tail: "", stderr_tail: "", stdout_sha256: "", stderr_sha256: "", ...o });
const LIMITS = { cpus: 2, memory_mb: 4096, pids: 512, wall_s: 1800, disk_mb: 4096 };
const recipe = (o: Partial<Recipe> = {}) =>
  ({
    limits: LIMITS,
    test: { command: "cargo test", parser: "libtest", timeout_s: 900 },
    metrics: [{ name: "add_ir", kind: "perf", command: "valgrind --tool=cachegrind target/release/examples/lineage_bench add $LINEAGE_SEED", parser: "cachegrind-ir", direction: "lower", deterministic: true, min_effect: 0.01 }],
    ...o,
  }) as unknown as Recipe;
const calib = (o: Partial<Calibration>): Calibration => ({ recipe_id: "r", snapshot_id: "", runs: 2, stable: ["a::t1"], known_failures: [], quarantined: [], metrics: { add_ir: { enabled: true, cv: 0, base_value: 100 } }, median_eval_seconds: 1, seed: "s", ...o }) as Calibration;
const transcript = (steps: TranscriptStep[], notes: string[] = []) => ({ steps, notes }) as Pick<Transcript, "steps" | "notes">;

const RUST_E0433 = `   Compiling curve25519 v0.1.0 (/work/src/curve25519)
warning: unused import: \`core::ops::Neg\`
 --> curve25519/src/edwards.rs:3:5
error[E0433]: failed to resolve: use of undeclared crate or module \`solana_define_syscall\`
  --> curve25519/src/syscalls.rs:14:9
   |
14 |     use solana_define_syscall::definitions as d;
   |         ^^^^^^^^^^^^^^^^^^^^^ use of undeclared crate or module
error: aborting due to 1 previous error
For more information about this error, try \`rustc --explain E0433\`.
error: could not compile \`curve25519\` (lib) due to 1 previous error`;

describe("what is safe to show", () => {
  test("host paths, tokens, keys and secret environment values are removed; the sandbox's paths become repository-relative", () => {
    const raw = [
      `${UNITS_HOME}/deps/abc/layer/x and ${homedir()}/.config/units/model.env and /Users/someone/code and /home/units/state and /root/.ssh/id and /var/lib/units-main/runtime/unit-setup/x-1/recipe.yml`,
      "/work/src/curve25519/src/lib.rs:12 and /deps/cargo/registry/src/index.crates.io-1949cf8c6b5b557f/subtle-2.6.1/src/lib.rs",
      // made up here from parts, so that no line of this file has the shape of a real token
      `OPENROUTER_API_KEY=${"sk-" + "or-v1-"}0123456789abcdef0123 and ${"sk-" + "ant-api03-"}abcdefgh12345678 and ${"gh" + "p_"}${"abcdefghijklmnopqrstuvwxyz0123456789"}`,
      "Authorization: Bearer abc.def-ghi_jkl123456 fetch https://user:hunter2@github.com/o/r.git",
      `key ${"a1".repeat(32)} and 4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi`,
      "commit 3efe73c7395f735f073bd25162cdc2fb4333f570 stays, an em dash \u2014 does not, \u001b[31mcolour\u001b[0m goes",
    ].join("\n");
    const t = scrub(raw);
    for (const leak of [UNITS_HOME, homedir(), "/Users/someone", "/home/units", "/root/", "/var/lib/units-main", "sk-or-v1", "sk-ant-", "ghp_", "hunter2", "abc.def-ghi", "a1".repeat(32), "4vJ9JU1bJJE96", "/work/src/", "index.crates.io", "\u2014", "\u001b"]) expect(t).not.toContain(leak);
    expect(t).toContain("curve25519/src/lib.rs:12");
    expect(t).toContain("deps:subtle-2.6.1/src/lib.rs");
    expect(t).toContain("3efe73c7395f735f073bd25162cdc2fb4333f570");
    expect(t).toContain("OPENROUTER_API_KEY=[removed]");
    expect(t).toContain("colour goes");
  });
  test("one line, bounded", () => {
    const l = oneLine(`a\n\tb ${"x".repeat(900)}`);
    expect(l).toStartWith("a b xxx");
    expect(l.includes("\n")).toBe(false);
    expect(l.length).toBe(CAUSE_MAX);
  });
});

describe("the most telling line of a step's output", () => {
  test("rustc: the first error with the file it points at, not the warnings or the summary", () => {
    expect(causeOf(RUST_E0433)).toBe("error[E0433]: failed to resolve: use of undeclared crate or module `solana_define_syscall` in curve25519/src/syscalls.rs:14");
  });
  test("a C compiler line, a Python traceback's exception, else the first line that names a failure, else the last line", () => {
    expect(causeOf("In file included from a.c:1:\nsrc/x.c:10:5: error: unknown type name 'u128'\nmake: *** [x.o] Error 1")).toBe("src/x.c:10:5: error: unknown type name 'u128'");
    expect(causeOf('Traceback (most recent call last):\n  File "/work/src/lineage_bench.py", line 3, in <module>\n    import tomli_w\nModuleNotFoundError: No module named \'tomli_w\'')).toBe("ModuleNotFoundError: No module named 'tomli_w'");
    expect(causeOf("starting\nthread 'main' panicked at examples/lineage_bench.rs:40:9:\nindex out of bounds\nnote: run with RUST_BACKTRACE=1")).toBe("thread 'main' panicked at examples/lineage_bench.rs:40:9:");
    expect(causeOf("one\ntwo\n\n")).toBe("two");
    expect(causeOf("")).toBe("");
  });
});

describe("a failed step", () => {
  test("build: a compile error with the compiler's line and the measured time", () => {
    expect(stepReason("build", step({ stderr_tail: RUST_E0433 }), LIMITS)).toEqual({ stage: "build", kind: "compile", cause: "error[E0433]: failed to resolve: use of undeclared crate or module `solana_define_syscall` in curve25519/src/syscalls.rs:14", seconds: 12.3 });
  });
  test("the time limit, with the limit and the measured time", () => {
    expect(stepReason("build", step({ exit: 124, timed_out: true, duration_ms: 1_800_400 }), LIMITS)).toMatchObject({ kind: "time", cause: "stopped at the time limit of 1,800 s after 1,800.4 s", seconds: 1800.4 });
    expect(stepReason("tests", step({ step: "test", exit: 124, timed_out: true, duration_ms: 900_100 }), { ...LIMITS, test_timeout_s: 900 }).cause).toBe("stopped at the time limit of 900 s after 900.1 s");
  });
  test("disk, memory and process limits", () => {
    expect(stepReason("prepare", step({ stderr_tail: "error: failed to unpack\nCaused by:\n  No space left on device (os error 28)" }), LIMITS)).toMatchObject({ stage: "prepare", kind: "disk" });
    expect(stepReason("prepare", step({ stderr_tail: "x\nNo space left on device" }), LIMITS).cause).toStartWith("ran out of disk (limit 4,096 MB) after 12.3 s: ");
    expect(stepReason("build", step({ exit: 137, stderr_tail: "" }), LIMITS)).toMatchObject({ kind: "memory", cause: "ran out of memory (limit 4,096 MB) after 12.3 s" });
    expect(stepReason("build", step({ stderr_tail: "thread 'main' panicked: failed to spawn thread: Resource temporarily unavailable" }), LIMITS).kind).toBe("processes");
  });
  test("a toolchain the image does not have, a failed download at prepare, a dependency missing offline", () => {
    expect(stepReason("build", step({ stderr_tail: "error: toolchain '1.96.1-aarch64-unknown-linux-gnu' is not installed" }), LIMITS)).toMatchObject({ kind: "toolchain", cause: "error: toolchain '1.96.1-aarch64-unknown-linux-gnu' is not installed" });
    expect(stepReason("build", step({ stderr_tail: "error: package `foo v1.0.0` cannot be built because it requires rustc 1.93 or newer, while the currently active rustc version is 1.89.0" }), LIMITS).kind).toBe("toolchain");
    expect(stepReason("prepare", step({ stderr_tail: "warning: spurious network error (3 tries remaining): [6] Could not resolve host: index.crates.io" }), LIMITS).kind).toBe("network");
    expect(stepReason("build", step({ stderr_tail: "error: no matching package named `rand_core` found\nlocation searched: crates.io index\nAs a reminder, you're using offline mode (--offline)" }), LIMITS)).toMatchObject({ kind: "offline", cause: "error: no matching package named `rand_core` found" });
    expect(stepReason("prepare", step({ exit: 2, stderr_tail: "sh: 1: nope: not found" }), LIMITS)).toMatchObject({ kind: "failed", cause: "exit 2: sh: 1: nope: not found" });
  });
});

describe("a trial that threw", () => {
  test("the step the sandbox attached is read: prepare, the calibration build, an unreadable test output, a metric past its time", () => {
    const prep = Object.assign(new EvalError("prepare failed (101): ..."), { step: step({ step: "prepare", exit: 101, stderr_tail: "error: failed to get `x` as a dependency\nCaused by:\n  failed to fetch `https://github.com/a/b`", duration_ms: 61_000 }) });
    expect(errorReason(prep, recipe())).toMatchObject({ stage: "prepare", kind: "network", seconds: 61 });
    const build = Object.assign(new EvalError("calibration build failed: ..."), { step: step({ stderr_tail: RUST_E0433 }) });
    expect(reasonLine(errorReason(build, recipe()))).toBe("build: error[E0433]: failed to resolve: use of undeclared crate or module `solana_define_syscall` in curve25519/src/syscalls.rs:14");
    const unread = Object.assign(new EvalError("test output not recognised by parser libtest"), { step: step({ step: "test", exit: 101, stderr_tail: "error: no test target matches pattern `curve`", duration_ms: 3000 }) });
    expect(errorReason(unread, recipe())).toEqual({ stage: "tests", kind: "not_recognised", cause: "the test command printed nothing the libtest parser reads (exit 101): error: no test target matches pattern `curve`", seconds: 3 });
    const slow = Object.assign(new EvalError("metric add_ir timed out"), { step: step({ step: "metrics", exit: 124, timed_out: true, duration_ms: 1_800_200 }) });
    expect(errorReason(slow, recipe())).toMatchObject({ stage: "metric", kind: "time", cause: "metric add_ir was stopped at the time limit of 1,800 s after 1,800.2 s" });
  });
  test("with no step (an older sandbox): the message is read; the sandbox itself being down is its own stage", () => {
    expect(errorReason(new Error(`calibration build failed: ${RUST_E0433}`), recipe())).toMatchObject({ stage: "build", kind: "compile" });
    expect(errorReason(new Error("prepare failed (124): "), recipe())).toMatchObject({ stage: "prepare", kind: "time" });
    expect(errorReason(new Error("the sandbox could not be started (docker exit 125): no such image"), recipe())).toMatchObject({ stage: "sandbox", kind: "unavailable" });
  });
});

describe("a calibration that ran but makes no unit", () => {
  test("good: no reason", () => {
    expect(calibrationReason(recipe(), calib({}), transcript([]))).toBeNull();
  });
  test("tests: which failed and how many, with the test command's own line", () => {
    const r = calibrationReason(recipe(), calib({ stable: [], known_failures: ["a::t1", "a::t2", "b::t3", "b::t4"], quarantined: ["c::flaky"] }), transcript([step({ step: "test", exit: 101, stdout_tail: "test a::t1 ... FAILED\nthread 'a::t1' panicked at src/lib.rs:9:5:\nassertion failed", duration_ms: 40_000 })]));
    expect(r).toEqual({ stage: "tests", kind: "none_stable", cause: "no test passed in every run: 4 failed every run, 1 passed only sometimes (a::t1, a::t2, b::t3, ...); test a::t1 ... FAILED", seconds: 40 });
    expect(calibrationReason(recipe(), calib({ stable: [] }), transcript([]))!.cause).toBe("the test command ran no test");
  });
  test("a metric that is not the same on identical runs: both readings and the measured spread", () => {
    const m = recipe().metrics[0]!;
    const run = (ir: number) => step({ step: "metrics", cmd: isolateMetric(m), exit: 0, stderr_tail: `==1== Cachegrind, a high-precision tracing profiler\n==1== I refs:        ${ir.toLocaleString("en-US")}\n` });
    const r = calibrationReason(recipe(), calib({ metrics: { add_ir: { enabled: false, cv: 1.2e-3, base_value: 1_000_500, reason: "not deterministic: cv 1.20e-3 above tolerance" } } }), transcript([run(1_000_000), run(1_001_000)]));
    expect(r).toEqual({ stage: "metric", kind: "not_deterministic", cause: "metric add_ir is not deterministic: it read 1,000,000 and 1,001,000 on identical runs (1,000 apart); spread (cv) 1.20e-3, allowed 5.00e-4" });
  });
  test("a metric that gave no value: its command's own error", () => {
    const m = recipe().metrics[0]!;
    const r = calibrationReason(recipe(), calib({ metrics: { add_ir: { enabled: false, cv: 0, reason: "metric command failed at calibration" } } }), transcript([step({ step: "metrics", cmd: isolateMetric(m), exit: 127, stderr_tail: "sh: 1: target/release/examples/lineage_bench: not found", duration_ms: 900 })]));
    expect(r).toMatchObject({ stage: "metric", kind: "missing", cause: "metric add_ir gave no value: exit 127: sh: 1: target/release/examples/lineage_bench: not found" });
  });
});

test("the equivalence harness: failed, printed nothing, or differed between two runs on one seed", () => {
  const run = (o: object) => ({ exit: 0, stdout: "abc", stderr: "", ...o });
  expect(equivalenceReason(run({}), run({}), true)).toBeNull();
  expect(equivalenceReason(run({ exit: 101, stdout: "", stderr: "thread 'main' panicked at examples/lineage_equiv.rs:7:5:\nboom" }), run({}), false)).toMatchObject({ stage: "equivalence", kind: "failed" });
  expect(equivalenceReason(run({ stdout: "" }), run({ stdout: "" }), false)!.kind).toBe("empty");
  expect(equivalenceReason(run({ stdout: "abc" }), run({ stdout: "abcd" }), false)).toEqual({ stage: "equivalence", kind: "differs", cause: "two runs on the same seed printed different output (3 and 4 bytes): something in it is not seeded" });
});

describe("how a reason is said", () => {
  const r = stepReason("build", step({ stderr_tail: RUST_E0433 }), LIMITS);
  test("the log and the prompt get the cause; the public sentence gets fixed words only", () => {
    expect(reasonLine(r)).toStartWith("build: error[E0433]");
    expect(reasonWords(2, r)).toBe("trial 2 failed at build (compile error)");
    expect(reasonWords(1, { stage: "metric", kind: "not_deterministic", cause: "x" })).toBe("trial 1 failed at metrics (a metric differed between identical runs)");
  });
  test("every kind has its words, none with an em dash or a bracket", () => {
    for (const [k, w] of Object.entries(KINDS)) {
      expect(k).toMatch(/^[a-z_]+$/);
      expect(w).toMatch(/^[a-z ]+$/);
    }
  });
  test("the next draft's prompt starts from what failed and from the files that are already there", () => {
    const history = [{ draft: 1, trials: [{ n: 1, ok: false, seconds: 427.2, reason: r }] }, { draft: 2, trials: [{ n: 1, ok: false, seconds: 174, reason: r }, { n: 2, ok: false, seconds: 392, reason: { stage: "tests" as const, kind: "none_stable", cause: "no test passed in every run: 3 failed every run (a, b, c)" } }] }];
    expect(historyLines(history)).toEqual([
      "- draft 1, trial 1 (427 s): build: error[E0433]: failed to resolve: use of undeclared crate or module `solana_define_syscall` in curve25519/src/syscalls.rs:14",
      "- draft 2, trial 1 (174 s): build: error[E0433]: failed to resolve: use of undeclared crate or module `solana_define_syscall` in curve25519/src/syscalls.rs:14",
      "- draft 2, trial 2 (392 s): tests: no test passed in every run: 3 failed every run (a, b, c)",
    ]);
    const s = historySection(history, ["recipe.yml", "overlay/examples/lineage_bench.rs"]);
    expect(s).toContain("EARLIER DRAFTS of this recipe did not pass");
    expect(s).toContain("Last time this failed because: tests: no test passed in every run: 3 failed every run (a, b, c). Fix exactly that first.");
    expect(s).toContain("already holds the previous draft (recipe.yml, overlay/examples/lineage_bench.rs)");
    expect(historySection([{ draft: 1, trials: [] }])).toBe("");
    expect(historySection([{ draft: 1, trials: [] }], ["recipe.yml"])).toContain("Last time no trial ran at all");
    expect(historySection([])).toBe("");
  });
});
