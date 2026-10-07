import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerArgs, loadRecipe, parseCachegrindIr, parseJunit, parseLibtest, parseMetric, parseTap, RecipeError } from "../src/index.ts";

const ROOT = join(import.meta.dir, "../../..");

describe("parsers", () => {
  test("libtest groups by target and handles doc tests and ignored", () => {
    const out = `   Compiling x v0.1.0
     Running unittests src/lib.rs (target/release/deps/x-1)
test inner::a ... ok
test inner::b ... ignored, slow
     Running tests/basic.rs (target/release/deps/basic-2)
test t1 ... ok
test t2 ... FAILED
   Doc-tests x
test src/lib.rs - encode (line 3) ... ok
`;
    const r = parseLibtest(out);
    expect(r.recognised).toBe(true);
    expect(r.pass).toEqual(["src/lib.rs::inner::a", "tests/basic.rs::t1", "doc:x::src/lib.rs - encode (line 3)"]);
    expect(r.fail).toEqual(["tests/basic.rs::t2"]);
    expect(parseLibtest("error: could not compile").recognised).toBe(false);
  });

  test("junit counts failures and errors, skips skipped", () => {
    const xml = `<testsuites><testsuite name="pytest">
<testcase classname="tests.test_a" name="test_ok" time="0.1"/>
<testcase classname="tests.test_a" name="test_fail"><failure message="x">trace</failure></testcase>
<testcase classname="tests.test_a" name="test_err"><error message="boom"/></testcase>
<testcase classname="tests.test_a" name="test_skip"><skipped/></testcase>
</testsuite></testsuites>`;
    const r = parseJunit(xml);
    expect(r.pass).toEqual(["tests.test_a::test_ok"]);
    expect(r.fail).toEqual(["tests.test_a::test_fail", "tests.test_a::test_err"]);
  });

  test("tap", () => {
    const r = parseTap("TAP version 13\nok 1 - adds\nnot ok 2 - subtracts\nok 3 - later # SKIP not yet\n1..3\n");
    expect(r.pass).toEqual(["adds"]);
    expect(r.fail).toEqual(["subtracts"]);
  });

  test("metrics", () => {
    expect(parseCachegrindIr("==1== \n==1== I   refs:      47,137,386\n")).toBe(47137386);
    expect(parseMetric("number", "warming\n12.5\n", "")).toBe(12.5);
    expect(parseMetric("bytes", "19276\n", "")).toBe(19276);
    expect(() => parseMetric("cachegrind-ir", "", "nothing")).toThrow();
    expect(() => parseMetric("nope", "", "")).toThrow();
  });
});

describe("recipes", () => {
  test("fixture recipe loads, protects its overlay and hashes stably", () => {
    const a = loadRecipe(join(ROOT, "recipes/fixture-b58"));
    const b = loadRecipe(join(ROOT, "recipes/fixture-b58"));
    expect(a.recipe_id).toBe(b.recipe_id);
    expect(a.recipe.patch.protected_paths).toContain("examples/lineage_bench.rs");
    expect(a.recipe.overlay_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("overlay contents change the recipe id", () => {
    const dir = mkdtempSync(join(tmpdir(), "lineage-recipe-"));
    try {
      cpSync(join(ROOT, "recipes/fixture-b58"), dir, { recursive: true });
      const before = loadRecipe(dir).recipe_id;
      const f = join(dir, "overlay/examples/lineage_bench.rs");
      writeFileSync(f, readFileSync(f, "utf8") + "\n// changed\n");
      expect(loadRecipe(dir).recipe_id).not.toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("validation rejects unpinned images and short commits", () => {
    const dir = mkdtempSync(join(tmpdir(), "lineage-recipe-"));
    try {
      cpSync(join(ROOT, "recipes/fixture-b58"), dir, { recursive: true });
      const y = readFileSync(join(dir, "recipe.yml"), "utf8");
      writeFileSync(join(dir, "recipe.yml"), y.replace(/image: .*/, 'image: "lineage/rust:m1"'));
      expect(() => loadRecipe(dir)).toThrow(RecipeError);
      writeFileSync(join(dir, "recipe.yml"), y.replace(/commit: .*/, 'commit: "abc123"'));
      expect(() => loadRecipe(dir)).toThrow(RecipeError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("docker args", () => {
  test("sandbox hardening flags are always present; network only when asked", () => {
    const base = {
      image: "sha256:abc",
      cmd: "true",
      cwd: "/work/src",
      mounts: [{ host: "/h", container: "/deps", readonly: true }],
      env: { LINEAGE_SEED: "s" },
      limits: { cpus: 2, memory_mb: 512, pids: 64, wall_s: 10, disk_mb: 100 },
      timeout_s: 10,
      job: "t",
    };
    const off = dockerArgs({ ...base, network: false }, "n").join(" ");
    for (const flag of ["--cap-drop ALL", "no-new-privileges", "--read-only", "--network none", "--user 10001:10001", "--pids-limit 64", "--memory-swap 512m", "lineage=1", "/h:/deps:ro"])
      expect(off).toContain(flag);
    expect(dockerArgs({ ...base, network: true }, "n").join(" ")).not.toContain("--network none");
  });
});
