import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkProposedRecipe } from "../../core/src/recipe-proposals.ts";
import { applyOverlay, changedProtectedBlocks, copyPrepareOutputs, dirDigest, loadRecipe, openPermissions, parseJunit, readRegularFile, validateRecipe } from "../src/index.ts";

// Offchain audit A2 (docs/AUDIT.md, Offchain): host-side reads and copies out of trees that
// untrusted code wrote. Pure unit tests, no Docker.

const ROOT = join(import.meta.dir, "../../..");
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "lineage-a2-sbx-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("OFF-S1 prepare outputs never follow a symlink the repository shipped", () => {
  test("a symlinked output directory pointing at host secrets is refused, nothing is copied", () => {
    const home = tmp();
    mkdirSync(join(home, "secrets"));
    writeFileSync(join(home, "secrets", "model.env"), "ANTHROPIC_API_KEY=sk-test-secret");
    const tree = join(home, "tree");
    mkdirSync(tree);
    symlinkSync("../secrets", join(tree, "out"));
    const outputs = join(home, "outputs");
    mkdirSync(outputs);
    expect(() => copyPrepareOutputs(tree, outputs, ["out/model.env"])).toThrow(/symlink/);
    expect(existsSync(join(outputs, "out", "model.env"))).toBe(false);
    // a symlink inside a copied directory is refused too
    mkdirSync(join(tree, "gen"));
    writeFileSync(join(tree, "gen", "ok.txt"), "ok");
    symlinkSync(join(home, "secrets", "model.env"), join(tree, "gen", "leak"));
    expect(() => copyPrepareOutputs(tree, outputs, ["gen"])).toThrow(/symlink/);
    // ordinary outputs still copy
    rmSync(join(tree, "gen", "leak"));
    copyPrepareOutputs(tree, outputs, ["gen"]);
    expect(readFileSync(join(outputs, "gen", "ok.txt"), "utf8")).toBe("ok");
  });

  test("recipes and proposals with an escaping prepare_outputs path are invalid", () => {
    const r = loadRecipe(join(ROOT, "recipes/fixture-b58")).recipe;
    for (const bad of ["../x", "/etc/passwd", "a/../../b", "./x"]) {
      expect(() => validateRecipe({ ...r, prepare_outputs: [bad] })).toThrow(/prepare_outputs/);
      expect(() => checkProposedRecipe({ ...r, repo: "https://github.com/a/b", prepare_outputs: [bad] })).toThrow(/prepare_outputs/);
    }
    expect(() => validateRecipe({ ...r, prepare_outputs: ["target/gen.rs"] })).not.toThrow();
  });
});

test("OFF-S2 a FIFO at a result path is skipped at once, it does not block the worker", () => {
  const d = tmp();
  const fifo = join(d, "junit.xml");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  // in a subprocess, so a regression hangs that process and not this test runner
  const p = Bun.spawnSync(["bun", "-e", `import { readRegularFile } from ${JSON.stringify(join(import.meta.dir, "../src/evaluate.ts"))}; console.log(String(readRegularFile(${JSON.stringify(fifo)}, 1024)));`], {
    timeout: 8000,
  });
  expect(p.signalCode ?? null).toBeNull();
  expect(p.stdout.toString().trim()).toBe("null");
  expect(readRegularFile(join(d, "missing"), 10)).toBeNull();
});

test("OFF-S3 parseJunit is linear in its input: unclosed testcases cannot stall the host", () => {
  const t = performance.now();
  const r = parseJunit("<testsuite>" + "<testcase a>".repeat(40_000));
  expect(performance.now() - t).toBeLessThan(500);
  expect(r.pass).toEqual([]);
  // same results as before on well-formed input
  const ok = parseJunit(
    `<testsuite><testcase classname="m" name="a"/><testcase classname="m" name="b"><failure/></testcase><testcase classname="m" name="c"><skipped/></testcase><testcase classname="m" name="d"></testcase><testcases/></testsuite>`,
  );
  expect(ok.pass.sort()).toEqual(["m::a", "m::d"]);
  expect(ok.fail).toEqual(["m::b"]);
  expect(ok.recognised).toBe(true);
});

test("OFF-S4 dirDigest hashes a 2.2 GB artifact in constant memory", () => {
  const d = tmp();
  const big = join(d, "artifact.bin");
  expect(Bun.spawnSync(["truncate", "-s", "2200M", big]).exitCode).toBe(0);
  writeFileSync(join(d, "small"), "x");
  expect(dirDigest(d)).toMatch(/^[0-9a-f]{64}$/);
  // peak memory of a fresh process: the old readFileSync held the whole file (1.6 GB measured)
  const p = Bun.spawnSync(["bun", "-e", `import { dirDigest } from ${JSON.stringify(join(import.meta.dir, "../src/evaluate.ts"))}; dirDigest(${JSON.stringify(d)}); console.log(process.resourceUsage().maxRSS * (process.platform === "linux" ? 1024 : 1));`]);
  expect(Number(p.stdout.toString().trim())).toBeLessThan(400 * 1024 * 1024);
}, 60_000);

test("OFF-S5 the overlay never writes through a symlink the repository shipped", () => {
  const d = tmp();
  const outside = join(d, "outside");
  mkdirSync(outside);
  const overlay = join(d, "overlay");
  mkdirSync(join(overlay, "bench"), { recursive: true });
  writeFileSync(join(overlay, "bench", "authorized_keys"), "ssh-ed25519 attacker");
  const tree = join(d, "tree");
  mkdirSync(tree);
  symlinkSync(outside, join(tree, "bench"));
  expect(() => applyOverlay(overlay, tree)).toThrow(/symlink/);
  expect(existsSync(join(outside, "authorized_keys"))).toBe(false);
  // a plain tree takes the overlay
  rmSync(join(tree, "bench"));
  applyOverlay(overlay, tree);
  expect(readFileSync(join(tree, "bench", "authorized_keys"), "utf8")).toBe("ssh-ed25519 attacker");
});

test("OFF-S6 work trees are opened to all users only when containers run as 10001", () => {
  const d = tmp();
  writeFileSync(join(d, "f"), "x");
  const before = statSync(join(d, "f")).mode & 0o777;
  expect(openPermissions(d, "1000:1000")).toBe(false);
  expect(statSync(join(d, "f")).mode & 0o777).toBe(before);
  expect(openPermissions(d, "10001:10001")).toBe(true);
  expect(statSync(join(d, "f")).mode & 0o006).toBe(0o006);
});

test("OFF-S7 protected-block comparison never reads through a symlinked directory", () => {
  const d = tmp();
  const block = "// lineage:protected\nfn harness() {\n  check();\n}\n";
  const parent = join(d, "parent");
  mkdirSync(join(parent, "src"), { recursive: true });
  writeFileSync(join(parent, "src", "a.rs"), block);
  // the candidate replaced src/ with a symlink to a directory holding an identical copy
  const cand = join(d, "cand");
  mkdirSync(cand);
  mkdirSync(join(d, "elsewhere"));
  writeFileSync(join(d, "elsewhere", "a.rs"), block);
  symlinkSync(join(d, "elsewhere"), join(cand, "src"));
  const changed = changedProtectedBlocks(parent, cand, [{ glob: "src/**", start: "lineage:protected" }]);
  expect(changed).toEqual(["src/a.rs: 1 blocks became 0"]);
});
