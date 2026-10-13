import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SpendLedger, toolLoop } from "../src/discovery.ts";
import { FIRST_TRIAL_TURNS, paceNote } from "../src/recipe-proposer.ts";
import { candidateLine, multiPackage, repoStructure, STRUCTURE_CLASSES, structureSection } from "../src/repo-structure.ts";

// The free structural pass (repo-structure.ts): the packages of a checkout, what each would cost to
// measure, and which one a recipe drafter is told to take; and the loop's turn budget before a first trial.

function tree(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "repo-structure-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(d, p)), { recursive: true });
    writeFileSync(join(d, p), c);
  }
  return d;
}
const fn = (n: number) => Array.from({ length: n }, (_, i) => `pub fn f${i}(x: u64) -> u64 { x.wrapping_mul(${i + 3}) }`).join("\n") + "\n";
const tests = (n: number) => `#[cfg(test)]\nmod tests {\n${Array.from({ length: n }, (_, i) => `    #[test]\n    fn t${i}() { assert_eq!(super::f0(1), 3); }`).join("\n")}\n}\n`;

const WORKSPACE = {
  "Cargo.toml": `[workspace]\nmembers = ["field", "curves/*", "gpu/prover-cuda", "macros", "cli"]\nresolver = "2"\n[workspace.package]\nrust-version = "1.89.0"\n[workspace.dependencies]\nfield = { path = "field" }\nsubtle = "2"\nopenssl = "0.10"\n`,
  "Cargo.lock": Array.from({ length: 40 }, (_, i) => `[[package]]\nname = "p${i}"\nversion = "1.0.0"\n`).join("\n"),
  // small, pure, a leaf, tests of its own
  "field/Cargo.toml": `[package]\nname = "ws-field"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nsubtle = { workspace = true }\n[dev-dependencies]\nproptest = "1"\n`,
  "field/src/lib.rs": fn(200) + tests(12),
  "field/tests/vectors.rs": "#[test]\nfn known() {}\n#[test]\nfn more() {}\n",
  // larger, built on field, picks code by CPU at run time, with a backend that can be pinned
  "curves/edwards/Cargo.toml": `[package]\nname = "ws-edwards"\nversion = "0.1.0"\nedition = "2024"\nrust-version = "1.85.0"\n[dependencies]\nfield = { workspace = true }\ncfg-if = "1"\nsha2 = "0.10"\n[target.'cfg(all(target_arch = "x86_64", not(curve_backend = "serial")))'.dependencies]\ncpufeatures = "0.2"\n[features]\ndefault = []\n`,
  "curves/edwards/build.rs": "fn main() {}\n",
  "curves/edwards/src/lib.rs": `${fn(900)}pub fn pick() { if is_x86_feature_detected!("avx2") {} }\n${tests(30)}`,
  // its tests link a system library
  "curves/p256/Cargo.toml": `[package]\nname = "ws-p256"\nversion = "0.1.0"\nedition = "2021"\n[dev-dependencies]\nopenssl = { workspace = true }\ncriterion = "0.5"\n`,
  "curves/p256/src/lib.rs": fn(150) + tests(20),
  // no tests
  "curves/untested/Cargo.toml": `[package]\nname = "ws-untested"\nversion = "0.1.0"\n`,
  "curves/untested/src/lib.rs": fn(100),
  // a GPU
  "gpu/prover-cuda/Cargo.toml": `[package]\nname = "ws-prover-cuda"\nversion = "0.1.0"\n[build-dependencies]\ncc = "1"\n`,
  "gpu/prover-cuda/src/lib.rs": fn(80) + tests(9),
  // a procedural macro, and a binary
  "macros/Cargo.toml": `[package]\nname = "ws-macros"\nversion = "0.1.0"\n[lib]\nproc-macro = true\n`,
  "macros/src/lib.rs": fn(70) + tests(9),
  "cli/Cargo.toml": `[package]\nname = "ws-cli"\nversion = "0.1.0"\n`,
  "cli/src/main.rs": `fn main() {}\n${fn(70)}${tests(9)}`,
  // outside the workspace, and a vendored copy that is skipped
  "tools/gen/Cargo.toml": `[package]\nname = "ws-gen"\nversion = "0.1.0"\n`,
  "tools/gen/src/lib.rs": fn(200) + tests(9),
  "vendor/dep/Cargo.toml": `[package]\nname = "vendored"\nversion = "0.1.0"\n`,
  "vendor/dep/src/lib.rs": fn(10) + tests(9),
};

describe("a Rust workspace", () => {
  const s = repoStructure(tree(WORKSPACE), "rust")!;
  const by = (name: string) => s.candidates.find((c) => c.name === name)!;
  test("every crate is found with its size, tests, dependencies and whether it is a leaf; a vendored copy is not", () => {
    expect(s.candidates.map((c) => c.name).sort()).toEqual(["ws-cli", "ws-edwards", "ws-field", "ws-gen", "ws-macros", "ws-p256", "ws-prover-cuda", "ws-untested"]);
    expect(by("ws-field")).toMatchObject({ path: "field", kind: "crate", source_files: 1, tests: 14, tests_where: "12 in src, 2 in tests/", deps: ["subtle"], dev_deps: ["proptest"], internal: [], eligible: true });
    expect(by("ws-field").source_lines).toBeGreaterThan(200);
    expect(by("ws-edwards")).toMatchObject({ path: "curves/edwards", internal: ["field"], deps: ["cfg-if", "cpufeatures", "sha2"], eligible: true });
    expect(s.toolchain).toBe("rust-version 1.89.0 or newer");
    expect(s.locked).toBe(40);
  });
  test("the signs that make a measurement differ between machines, and the facts that help pin it", () => {
    expect(by("ws-edwards").risks.join("; ")).toContain("picks code by CPU feature at run time (1 file)");
    expect(by("ws-edwards").notes.join("; ")).toContain('its backend is chosen by --cfg (curve_backend="serial")');
    expect(by("ws-edwards").notes.join("; ")).toContain("has a build script");
    expect(by("ws-edwards").notes.join("; ")).toContain("asks for Rust 1.85.0 or newer");
    expect(by("ws-field").notes.join("; ")).toContain("PROPTEST_RNG_SEED");
    expect(by("ws-p256").risks.join("; ")).toContain("its tests and examples link openssl (development dependency)");
    expect(by("ws-gen").risks.join("; ")).toContain("is not a member of the root workspace");
  });
  test("what cannot be a unit is marked and ranked last: no tests, a GPU, a procedural macro, no library", () => {
    for (const [name, why] of [["ws-untested", "has no tests of its own"], ["ws-prover-cuda", "needs a GPU"], ["ws-macros", "is a procedural macro crate"], ["ws-cli", "has no library target"]] as const) {
      expect(by(name).eligible).toBe(false);
      expect(by(name).risks.join("; ")).toContain(why);
    }
    const order = s.candidates.map((c) => c.eligible);
    expect(order.indexOf(false)).toBe(order.lastIndexOf(true) + 1);
  });
  test("ranked small, self-contained, CPU-bound, own tests, few dependencies first", () => {
    expect(s.candidates[0]!.name).toBe("ws-field");
    expect(s.candidates.findIndex((c) => c.name === "ws-field")).toBeLessThan(s.candidates.findIndex((c) => c.name === "ws-edwards"));
    expect(by("ws-edwards").score).toBeGreaterThan(by("ws-field").score);
  });
  test("with the image read: a crate whose tests need a library the image lacks drops below the others, and the line says so", () => {
    const before = s.candidates.findIndex((c) => c.name === "ws-p256");
    const t = repoStructure(tree(WORKSPACE), "rust", { toolchain: "1.89.0", missing: ["pkg-config", "OpenSSL headers"] })!;
    const p = t.candidates.find((c) => c.name === "ws-p256")!;
    expect(p.risks.join("; ")).toContain("the image has no pkg-config, no OpenSSL headers, so its tests will not build there");
    expect(t.candidates.filter((c) => c.eligible).at(-1)!.name).toBe("ws-p256");
    expect(before).toBeLessThan(t.candidates.findIndex((c) => c.name === "ws-p256"));
  });
  test("a generated table does not count as code to read", () => {
    const t = repoStructure(tree({ "Cargo.toml": `[workspace]\nmembers = ["a", "b"]\n`, "a/Cargo.toml": `[package]\nname = "a"\nversion = "0.1.0"\n`, "a/src/lib.rs": fn(300) + tests(10), "a/src/constants.rs": "pub const T: [u64; 1] = [\n" + "    1,\n".repeat(9000) + "];\n", "b/Cargo.toml": `[package]\nname = "b"\nversion = "0.1.0"\n`, "b/src/lib.rs": fn(300) + tests(10) }), "rust")!;
    const a = t.candidates.find((c) => c.name === "a")!;
    expect(a.source_lines).toBeGreaterThan(9000);
    expect(a.notes.join("; ")).toContain("src/constants.rs is 9,002 lines (a table: do not read it)");
    expect(Math.abs(a.score - t.candidates.find((c) => c.name === "b")!.score)).toBeLessThan(1);
  });
});

describe("the other classes", () => {
  test("Go: the packages of a module that have tests, with their imports, assembly and whether they are leaves", () => {
    const s = repoStructure(tree({
      "go.mod": "module example.com/kit\n\ngo 1.24\n\nrequire golang.org/x/sys v0.1.0\n",
      "go.sum": "golang.org/x/sys v0.1.0 h1:x\ngolang.org/x/sys v0.1.0/go.mod h1:y\n",
      "base58/base58.go": `package base58\n\nimport (\n\t"errors"\n)\n\nfunc Encode(b []byte) string { _ = errors.New; return "" }\n${"// line\n".repeat(200)}`,
      "base58/base58_test.go": `package base58\n\nimport "testing"\n\n${Array.from({ length: 9 }, (_, i) => `func TestE${i}(t *testing.T) {}`).join("\n")}\n`,
      "hash/hash.go": `package hash\n\nimport (\n\t"example.com/kit/base58"\n\t"golang.org/x/sys/cpu"\n)\n\nvar _ = base58.Encode\nvar fast = cpu.X86.HasAVX2\n${"// line\n".repeat(200)}`,
      "hash/hash_amd64.s": "TEXT ·sum(SB),0,$0\n",
      "hash/hash_test.go": `package hash\n\nimport "testing"\n\n${Array.from({ length: 9 }, (_, i) => `func TestH${i}(t *testing.T) {}`).join("\n")}\n`,
      "cmd/tool/main.go": "package main\n\nfunc main() {}\n",
      "plain/plain.go": "package plain\n\nfunc F() {}\n",
    }), "go")!;
    expect(s.candidates.map((c) => c.name)).toEqual(["example.com/kit/base58", "example.com/kit/hash", "example.com/kit/plain"]);
    expect(s.candidates[0]).toMatchObject({ path: "base58", kind: "go package", tests: 9, internal: [], deps: [], eligible: true });
    expect(s.candidates[1]).toMatchObject({ internal: ["example.com/kit/base58"], deps: ["golang.org/x/sys/cpu"] });
    expect(s.candidates[1]!.risks.join("; ")).toContain("picks code by CPU feature at run time");
    expect(s.candidates[1]!.risks.join("; ")).toContain("has assembly files (1)");
    expect(s.candidates[2]).toMatchObject({ eligible: false });
    expect(s.toolchain).toBe("go 1.24");
    expect(s.locked).toBe(1);
  });
  test("Python: the projects of a monorepo, each with its own tests and dependencies", () => {
    const s = repoStructure(tree({
      "libs/core/pyproject.toml": `[project]\nname = "kit-core"\ndependencies = []\n`,
      "libs/core/kit_core/__init__.py": "def f():\n    return 1\n" + "# line\n".repeat(200),
      "libs/core/tests/test_core.py": Array.from({ length: 9 }, (_, i) => `def test_${i}():\n    pass\n`).join(""),
      "libs/gpu/pyproject.toml": `[project]\nname = "kit-gpu"\ndependencies = ["torch>=2", "kit-core"]\n`,
      "libs/gpu/kit_gpu/__init__.py": "import torch\n" + "# line\n".repeat(200),
      "libs/gpu/tests/test_gpu.py": Array.from({ length: 9 }, (_, i) => `def test_${i}():\n    pass\n`).join(""),
      "libs/bare/setup.py": "from setuptools import setup\nsetup()\n",
      "libs/bare/bare/__init__.py": "x = 1\n" + "# line\n".repeat(200),
    }), "python")!;
    expect(s.candidates.map((c) => c.name)).toEqual(["kit-core", "kit-gpu", "bare"]);
    expect(s.candidates[0]).toMatchObject({ path: "libs/core", kind: "python package", tests: 9, deps: [], internal: [], eligible: true });
    expect(s.candidates[1]).toMatchObject({ deps: ["torch"], internal: ["kit-core"] });
    expect(s.candidates[1]!.risks.join("; ")).toContain("imports a GPU or JIT numeric library");
    expect(s.candidates[2]!.eligible).toBe(false);
  });
  test("Python: one project is its import packages; a single package is not a choice", () => {
    const one = repoStructure(tree({ "pyproject.toml": `[project]\nname = "tomli"\nrequires-python = ">=3.8"\n`, "src/tomli/__init__.py": "def loads(s):\n    return {}\n", "src/tomli/_parser.py": "# x\n".repeat(300), "tests/test_misc.py": "import tomli\n\ndef test_a():\n    pass\n" }), "python")!;
    expect(one.candidates.map((c) => c.name)).toEqual(["tomli"]);
    expect(one.toolchain).toBe("requires-python >=3.8");
    expect(multiPackage(one)).toBe(false);
    expect(structureSection(one)).toBe("");
  });
  test("C and C++: directories with their own build file and tests; intrinsics and a GPU are seen", () => {
    const s = repoStructure(tree({
      "codec/Makefile": "all:\n\tcc -o codec codec.c -lz\n",
      "codec/codec.c": "int enc(int x) { return x; }\n" + "// line\n".repeat(300),
      "codec/codec.h": "int enc(int x);\n",
      "codec/test_codec.c": "int main(void) { return 0; }\n",
      "simd/CMakeLists.txt": "cmake_minimum_required(VERSION 3.10)\nproject(simd)\nfind_package(OpenSSL REQUIRED)\n",
      "simd/sum.c": "#include <immintrin.h>\nint sum(void) { return __builtin_cpu_supports(\"avx2\"); }\n" + "// line\n".repeat(300),
      "simd/tests/test_sum.c": "int main(void) { return 0; }\n",
      "kernels/Makefile": "all:\n",
      "kernels/k.cpp": "#include <cuda_runtime.h>\n__global__ void k() {}\n" + "// line\n".repeat(300),
      "kernels/test_k.cpp": "int main() { return 0; }\n",
    }), "cpp")!;
    expect(s.candidates.map((c) => c.name)).toEqual(["codec", "simd", "kernels"]);
    expect(s.candidates[0]).toMatchObject({ kind: "directory", tests: 1, deps: ["z"], eligible: true });
    expect(s.candidates[1]!.deps).toEqual(["OpenSSL"]);
    expect(s.candidates[1]!.risks.join("; ")).toContain("picks code by CPU feature at run time");
    expect(s.candidates[1]!.risks.join("; ")).toContain("uses assembly or SIMD intrinsics");
    expect(s.candidates[2]).toMatchObject({ eligible: false });
  });
  test("Zig: packages with their build file, their declared dependencies and their test blocks", () => {
    const s = repoStructure(tree({
      "build.zig.zon": `.{\n    .name = .kit,\n    .minimum_zig_version = "0.15.1",\n    .dependencies = .{},\n}\n`,
      "build.zig": "pub fn build(b: *anyopaque) void { _ = b; }\n",
      "src/root.zig": "pub fn f() u8 { return 1; }\n" + "// line\n".repeat(200) + Array.from({ length: 9 }, (_, i) => `test "t${i}" {}\n`).join(""),
      "pkgs/vec/build.zig": "pub fn build(b: *anyopaque) void { _ = b; }\n",
      "pkgs/vec/build.zig.zon": `.{\n    .name = .vec,\n    .dependencies = .{\n        .clap = .{\n            .url = "https://example.com/clap.tar.gz",\n            .hash = "1220",\n        },\n    },\n}\n`,
      "pkgs/vec/src/vec.zig": "const V = @Vector(4, f32);\n" + "// line\n".repeat(200) + Array.from({ length: 9 }, (_, i) => `test "t${i}" {}\n`).join(""),
    }), "zig")!;
    expect(s.candidates.map((c) => c.name)).toEqual(["kit", "vec"]);
    expect(s.candidates[0]).toMatchObject({ kind: "zig package", path: ".", tests: 9, deps: [], eligible: true });
    expect(s.candidates[1]).toMatchObject({ path: "pkgs/vec", deps: ["clap"] });
    expect(s.candidates[1]!.risks.join("; ")).toContain("uses vectors or assembly");
    expect(s.toolchain).toBe("minimum_zig_version 0.15.1");
  });
  test("classes covered; a class outside them has no structure, and a tree that cannot be read gives none", () => {
    expect(STRUCTURE_CLASSES).toEqual(["rust", "solana", "go", "python", "cpp", "zig"]);
    expect(repoStructure(tree({ "a.cu": "" }), "cuda")).toBeNull();
    expect(repoStructure("/nonexistent/units-structure", "rust")).toEqual({ class: "rust", candidates: [], toolchain: null, locked: null });
  });
});

describe("what the drafter is told", () => {
  const s = repoStructure(tree(WORKSPACE), "rust", { toolchain: "1.89.0", missing: ["pkg-config", "OpenSSL headers"] })!;
  const text = structureSection(s, { toolchain: "1.89.0", missing: ["pkg-config", "OpenSSL headers"] });
  test("the ranked list, ONE package, the first unless there is a concrete reason, and nothing else read", () => {
    expect(text).toContain("THIS REPOSITORY HAS 8 PACKAGES");
    expect(text).toContain("\n1. ws-field at field/: ");
    expect(text).toContain("a leaf (depends on no other package here)");
    expect(text).toContain("Write the recipe for number 1, ws-field, and only for it.");
    expect(text).toContain("Take another from the list only for a concrete reason you see in its code");
    expect(text).toContain("Do not read the other packages.");
    expect(text).toContain("Not possible as they stand: ");
    expect(text).toContain("ws-prover-cuda (needs a GPU)");
    expect(text).toContain("The image, read from it just now: toolchain 1.89.0; it does NOT have pkg-config, OpenSSL headers.");
    expect(text).not.toContain("\u2014");
  });
  test("Rust: the one-crate technique of the hand-built recipes, with the crate and the image's toolchain filled in", () => {
    expect(text).toContain("RUSTUP_TOOLCHAIN=1.89.0 cargo tree --locked -p ws-field -e normal,build,dev > /dev/null");
    expect(text).toContain("a plain `cargo fetch` would download all 40 packages of the lockfile");
    expect(text).toContain("RUSTUP_TOOLCHAIN=1.89.0 cargo build --release --locked --offline -p ws-field --lib --examples --tests");
    expect(text).toContain("RUSTUP_TOOLCHAIN=1.89.0 cargo test --release --locked --offline -p ws-field --no-fail-fast --lib --tests 2>&1");
    expect(text).toContain("The repository asks for rust-version 1.89.0 or newer; the image runs Rust 1.89.0.");
    expect(text).toContain("field/examples/lineage_bench.rs");
    expect(text).toContain('patch.allowed_paths: ["field/src/**"]');
    expect(text).toContain("FNV-1a into a splitmix64 state");
    expect(text).toContain("Go to a first trial early.");
  });
  test("every class with packages gets its own technique", () => {
    const go = repoStructure(tree({ "go.mod": "module m\n\ngo 1.24\n", "a/a.go": "package a\n", "a/a_test.go": "package a\nfunc TestA(t *testing.T) {}\n", "b/b.go": "package b\n", "b/b_test.go": "package b\nfunc TestB(t *testing.T) {}\n" }), "go");
    expect(structureSection(go)).toContain("Go, one package of a module:");
    expect(candidateLine(go!.candidates[0]!, 0)).toStartWith("1. m/a at a/: ");
  });
});

describe("a first trial early", () => {
  test("after the turn budget with no trial the model is told to trial what it has, then every third turn; never once a trial ran", () => {
    const at = (turn: number, trials = 0) => paceNote({ turn, usd: 0.61, capUsd: 1.5, trials, firstTrialTurns: 12 });
    expect(FIRST_TRIAL_TURNS).toBe(12);
    expect(at(11)).toBeNull();
    expect(at(12)).toStartWith("Pace: 12 turns and 0.61 of 1.50 USD are used and no trial has run. Stop reading.");
    expect(at(13)).toBeNull();
    expect(at(15)).not.toBeNull();
    expect(at(12, 1)).toBeNull();
  });
  test("the loop hands the note to the model with the tool results, and keeps the prompt cache alive under a slow tool", async () => {
    const requests: any[] = [];
    const pings: any[] = [];
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as Anthropic.Beta.BetaUsage;
    const client = {
      beta: {
        messages: {
          // the routed client (claude-route.ts routedSdk) has stream() and nothing else: the keep-alive goes through it too
          stream(req: any) {
            if (req.max_tokens === 1) return (pings.push(req), { finalMessage: async () => ({ model: "claude-opus-5-5", usage, stop_reason: "max_tokens", content: [] }) });
            requests.push(JSON.parse(JSON.stringify(req)));
            const n = requests.length;
            return { finalMessage: async () => ({ model: "claude-opus-5-5", usage, stop_reason: "tool_use", content: [{ type: "tool_use", id: `t${n}`, name: n < 3 ? "read_file" : "give_up", input: {} }] }) };
          },
        },
      },
    } as unknown as Anthropic;
    const seen: number[] = [];
    const res = await toolLoop({
      client, model: "claude-opus-5-5", effort: "medium", system: "s", tools: [], first: "go", ledger: new SpendLedger(join(mkdtempSync(join(tmpdir(), "ledger-")), "spend.jsonl"), 100), who: "t", capUsd: 5, maxTurns: 5, log: () => {},
      onTurn: (n) => seen.push(n),
      note: (n) => (n === 2 ? "Pace: trial now." : null),
      keepAliveS: 0.02,
      handle: async (name) => {
        if (name === "give_up") return { done: 1 };
        await Bun.sleep(requests.length === 1 ? 90 : 0);
        return "file text";
      },
    });
    expect(res).toMatchObject({ value: 1, turns: 3 });
    expect(seen).toEqual([1, 2, 3]);
    // turn 2's results carry the note; turn 1's do not
    expect(requests[1].messages.at(-1).content.map((b: any) => b.type)).toEqual(["tool_result"]);
    expect(requests[2].messages.at(-1).content).toEqual([{ type: "tool_result", tool_use_id: "t2", content: "file text" }, { type: "text", text: "Pace: trial now." }]);
    // the slow tool of turn 1: the request that was sent is sent again for one token
    expect(pings.length).toBeGreaterThanOrEqual(1);
    expect(pings[0]).toMatchObject({ max_tokens: 1, system: "s", messages: [{ role: "user", content: "go" }] });
  });
  test("a keep-alive the client cannot send turns itself off and never stops the loop", async () => {
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as Anthropic.Beta.BetaUsage;
    let n = 0;
    const logs: string[] = [];
    const client = {
      beta: {
        messages: {
          stream(req: any) {
            if (req.max_tokens === 1) throw new TypeError("not supported here");
            n++;
            return { finalMessage: async () => ({ model: "claude-opus-5-5", usage, stop_reason: "tool_use", content: [{ type: "tool_use", id: `t${n}`, name: n < 2 ? "read_file" : "give_up", input: {} }] }) };
          },
        },
      },
    } as unknown as Anthropic;
    const res = await toolLoop({
      client, model: "claude-opus-5-5", effort: "medium", system: "s", tools: [], first: "go", ledger: new SpendLedger(join(mkdtempSync(join(tmpdir(), "ledger-")), "spend.jsonl"), 100), who: "t", capUsd: 5, maxTurns: 5, log: (m) => logs.push(m), keepAliveS: 0.02,
      handle: async (name) => (name === "give_up" ? { done: 1 } : (await Bun.sleep(80), "x")),
    });
    expect(res).toMatchObject({ value: 1, turns: 2 });
    expect(logs.filter((l) => l.includes("cache keep-alive failed: not supported here")).length).toBe(1);
  });
});
