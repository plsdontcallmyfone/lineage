import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeDiff } from "@lineage/protocol";
import { changedProtectedBlocks, diffWorkingTree, evaluate, isolateMetric, loadRecipe, materialize, newWorkDir, prepareDeps, readRegularFile, removeTree } from "../src/index.ts";

// Regression tests for the adversarial review (2026-10-07): code under test must not be able to
// forge what the sandbox measures.

const ROOT = join(import.meta.dir, "../../..");
const dockerUp = Bun.spawnSync(["docker", "info"]).exitCode === 0;

describe("isolation helpers", () => {
  test("valgrind log goes to its own descriptor and the program's output is discarded", () => {
    const w = isolateMetric({ name: "m", kind: "perf", direction: "lower", deterministic: true, command: "valgrind --tool=cachegrind prog x", parser: "cachegrind-ir", min_effect: 0.01 });
    expect(w).toContain("valgrind --log-fd=9 --tool=cachegrind");
    expect(w).toContain(">/dev/null 2>/dev/null");
    expect(w).toContain("kill -9 -1");
    const plain = isolateMetric({ name: "s", kind: "slim", direction: "lower", deterministic: true, command: "wc -c < f", parser: "bytes", min_effect: 0.01 });
    expect(plain).not.toContain("/dev/null 2>");
  });

  test("results are read only from regular files: symlinks planted by a container are ignored", () => {
    const d = mkdtempSync(join(tmpdir(), "lineage-out-"));
    try {
      writeFileSync(join(d, "secret"), "do not read");
      Bun.spawnSync(["ln", "-s", join(d, "secret"), join(d, "junit.xml")]);
      expect(readRegularFile(join(d, "junit.xml"), 1024)).toBeNull();
      writeFileSync(join(d, "real.xml"), "<testsuite/>");
      expect(readRegularFile(join(d, "real.xml"), 1024)).toBe("<testsuite/>");
      expect(readRegularFile(join(d, "real.xml"), 3)).toBeNull();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("protected blocks: an edited inline test module is detected, other edits are not", () => {
    const d = mkdtempSync(join(tmpdir(), "lineage-blocks-"));
    try {
      const src = 'pub fn a() -> u8 { 1 }\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn t() { assert_eq!(super::a(), 1); }\n}\n';
      for (const side of ["p", "c"]) {
        mkdirSync(join(d, side, "src"), { recursive: true });
        writeFileSync(join(d, side, "src/lib.rs"), src);
      }
      const rules = [{ glob: "src/**/*.rs", start: "^#\\[cfg\\(test\\)\\]" }];
      writeFileSync(join(d, "c", "src/lib.rs"), src.replace("pub fn a() -> u8 { 1 }", "pub fn a() -> u8 { 0 + 1 }"));
      expect(changedProtectedBlocks(join(d, "p"), join(d, "c"), rules)).toEqual([]);
      writeFileSync(join(d, "c", "src/lib.rs"), src.replace("assert_eq!(super::a(), 1)", "assert!(true)"));
      expect(changedProtectedBlocks(join(d, "p"), join(d, "c"), rules)).toEqual(["src/lib.rs:3"]);
      writeFileSync(join(d, "c", "src/lib.rs"), "pub fn a() -> u8 { 1 }\n");
      expect(changedProtectedBlocks(join(d, "p"), join(d, "c"), rules)[0]).toContain("1 blocks became 0");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

(dockerUp ? describe : describe.skip)("forging attacks against a real sandbox", () => {
  test("a patch that prints a fake valgrind summary and overwrites the bench binary during tests is measured honestly", async () => {
    const loaded = loadRecipe(join(ROOT, "recipes/fixture-b58"));
    const deps = await prepareDeps(loaded);
    const work = newWorkDir("forge");
    try {
      const tree = join(work, "src");
      materialize(loaded.recipe.repo, loaded.recipe.commit, loaded.overlayDir, tree);
      const lib = join(tree, "src/lib.rs");
      const forged = readFileSync(lib, "utf8").replace(
        "pub fn encode(input: &[u8]) -> String {\n",
        `pub fn encode(input: &[u8]) -> String {
    {
        use std::io::Write;
        let fake = format!("==${"{}"}== I   refs:      1\\n", std::process::id());
        let _ = std::io::stderr().write_all(fake.as_bytes());
        let _ = std::fs::write("target/release/examples/lineage_bench", b"#!/bin/sh\\necho 1\\n");
    }
`,
      );
      writeFileSync(lib, forged);
      const patch = canonicalizeDiff(diffWorkingTree(tree));
      const { result } = await evaluate({ loaded, deps, parentPatches: [], candidatePatch: patch, seed: "f0" });
      expect(result.build.cand).toBe("ok");
      const ir = result.metrics.encode_ir!;
      expect(ir.base.length).toBe(1);
      expect(ir.cand.length).toBe(1);
      // honest measurement: the extra work makes encode slightly slower, never "1 instruction"
      expect(ir.cand[0]!).toBeGreaterThan(ir.base[0]! * 0.9);
      expect(ir.cand[0]!).toBeGreaterThan(1000);
    } finally {
      removeTree(work);
    }
  }, 600_000);
});
