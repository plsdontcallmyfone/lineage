import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeDiff, guard, globToRegExp, parseDiff, patchHash, semanticHash, type PatchRules } from "../src/index.ts";

const RULES: PatchRules = {
  allowed_paths: ["src/**"],
  protected_paths: ["src/**/*_test.rs", "tests/**", "Cargo.toml"],
  max_files: 3,
  max_lines: 20,
};

function git(dir: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString();
}

/** Builds a real repo, applies `edit`, returns `git diff` output exactly as a worker would produce it. */
function realDiff(edit: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "lineage-diff-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(join(dir, "src/lib.rs"), Array.from({ length: 30 }, (_, i) => `fn f${i}() {}`).join("\n") + "\n");
    writeFileSync(join(dir, "src/util.rs"), "pub fn a() -> u32 { 1 }\n");
    writeFileSync(join(dir, "tests/it.rs"), "#[test] fn t() {}\n");
    writeFileSync(join(dir, "Cargo.toml"), "[package]\nname='x'\n");
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
    edit(dir);
    git(dir, "add", "-A");
    return git(dir, "diff", "--cached", "--no-color", "--no-ext-diff", "--no-renames", "-U3", "--full-index");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("glob", () => {
  test("double star spans directories, single star does not", () => {
    expect(globToRegExp("src/**").test("src/a/b/c.rs")).toBe(true);
    expect(globToRegExp("src/*.rs").test("src/a/b.rs")).toBe(false);
    expect(globToRegExp("**/*.yml").test("a/b/c.yml")).toBe(true);
    expect(globToRegExp("**/*.yml").test("c.yml")).toBe(true);
    expect(globToRegExp("src/**/*_test.rs").test("src/x_test.rs")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });
});

describe("canonical diff", () => {
  test("parses a real modify diff and counts lines", () => {
    const d = realDiff((dir) => writeFileSync(join(dir, "src/util.rs"), "pub fn a() -> u32 { 2 }\n"));
    const files = parseDiff(d);
    expect(files).toHaveLength(1);
    expect(files[0]!.added).toBe(1);
    expect(files[0]!.removed).toBe(1);
  });

  test("canonical form drops index lines and is idempotent", () => {
    const d = realDiff((dir) => {
      writeFileSync(join(dir, "src/util.rs"), "pub fn a() -> u32 { 2 }\n");
      writeFileSync(join(dir, "src/new.rs"), "pub fn b() {}\n");
    });
    const c = canonicalizeDiff(d);
    expect(c).not.toContain("index ");
    expect(canonicalizeDiff(c)).toBe(c);
    expect(c.indexOf("src/new.rs")).toBeLessThan(c.indexOf("src/util.rs"));
  });

  test("patch hash ignores file order, semantic hash ignores whitespace", () => {
    const a = realDiff((dir) => {
      writeFileSync(join(dir, "src/util.rs"), "pub fn a() -> u32 { 2 }\n");
      writeFileSync(join(dir, "src/new.rs"), "pub fn b() {}\n");
    });
    const parts = a.split(/(?=^diff --git )/m);
    const reordered = [...parts].reverse().join("");
    expect(patchHash(canonicalizeDiff(a))).toBe(patchHash(canonicalizeDiff(reordered)));
    const b = realDiff((dir) => {
      writeFileSync(join(dir, "src/util.rs"), "pub fn a()  ->  u32 {  2 }\n");
      writeFileSync(join(dir, "src/new.rs"), "pub fn b() { }\n");
    });
    expect(patchHash(canonicalizeDiff(a))).not.toBe(patchHash(canonicalizeDiff(b)));
    expect(semanticHash(canonicalizeDiff(a))).toBe(semanticHash(canonicalizeDiff(b)));
  });

  test("rejects garbage and truncated hunks", () => {
    expect(() => parseDiff("hello\n")).toThrow();
    const d = realDiff((dir) => writeFileSync(join(dir, "src/util.rs"), "pub fn a() -> u32 { 2 }\n"));
    expect(() => parseDiff(d.split("\n").slice(0, -2).join("\n"))).toThrow();
  });
});

describe("guard", () => {
  test("accepts a small allowed change", () => {
    const d = realDiff((dir) => writeFileSync(join(dir, "src/util.rs"), "pub fn a() -> u32 { 2 }\n"));
    const g = guard(d, RULES);
    expect(g.ok).toBe(true);
    expect(g.lines).toBe(2);
  });

  const cases: [string, (dir: string) => void, string][] = [
    ["protected test dir", (d) => writeFileSync(join(d, "tests/it.rs"), "#[test] fn t() { assert!(true) }\n"), "PROTECTED_PATH"],
    ["protected manifest", (d) => writeFileSync(join(d, "Cargo.toml"), "[package]\nname='y'\n"), "PROTECTED_PATH"],
    ["protected wins over allowed", (d) => writeFileSync(join(d, "src/x_test.rs"), "fn t() {}\n"), "PROTECTED_PATH"],
    ["outside allowed", (d) => writeFileSync(join(d, "README.md"), "hi\n"), "OUTSIDE_ALLOWED"],
    ["binary", (d) => writeFileSync(join(d, "src/blob.bin"), Buffer.from([0, 1, 2, 0, 255])), "BINARY"],
    ["symlink", (d) => symlinkSync("lib.rs", join(d, "src/link.rs")), "SYMLINK"],
    ["mode change", (d) => chmodSync(join(d, "src/util.rs"), 0o755), "MODE_CHANGE"],
    [
      "too many files",
      (d) => {
        for (let i = 0; i < 4; i++) writeFileSync(join(d, `src/n${i}.rs`), "fn x() {}\n");
      },
      "TOO_MANY_FILES",
    ],
    [
      "too many lines",
      (d) => writeFileSync(join(d, "src/lib.rs"), Array.from({ length: 30 }, (_, i) => `fn g${i}() {}`).join("\n") + "\n"),
      "TOO_MANY_LINES",
    ],
  ];
  for (const [name, edit, code] of cases) {
    test(`rejects ${name}`, () => {
      const g = guard(realDiff(edit), RULES);
      expect(g.ok).toBe(false);
      expect(g.violation).toBe(code as never);
    });
  }

  test("rejects path traversal and malformed input", () => {
    const evil = "diff --git a/src/../tests/it.rs b/src/../tests/it.rs\n--- a/src/../tests/it.rs\n+++ b/src/../tests/it.rs\n@@ -1 +1 @@\n-a\n+b\n";
    expect(guard(evil, RULES).violation).toBe("OUTSIDE_ALLOWED");
    expect(guard("not a diff", RULES).violation).toBe("MALFORMED");
    expect(guard("", RULES).violation).toBe("EMPTY");
  });

  test("flags harness and timing references without failing", () => {
    const d = realDiff((dir) =>
      writeFileSync(join(dir, "src/util.rs"), 'pub fn a() -> u32 { if std::env::var("LINEAGE_SEED").is_ok() { 0 } else { 1 } }\n'),
    );
    const g = guard(d, RULES);
    expect(g.ok).toBe(true);
    expect(g.flags.join(" ")).toContain("LINEAGE_");
  });
});
