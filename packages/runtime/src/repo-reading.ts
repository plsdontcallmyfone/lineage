import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Recipe } from "@units/protocol";

// The free reading of a repository (no model): its language class and whether it has tests of its
// own. One set of rules, used by the hosted runtime's unit setup (unit-setup.ts) and by Core's
// repository check before a launch (packages/core/src/repo-check.ts). Nothing here reaches the
// network or a model; it reads a checked-out tree.

const SKIP_DIRS = new Set([".git", "node_modules", "vendor", "third_party", "target", "dist", "build", ".venv", "venv", "__pycache__", "zig-cache", ".zig-cache"]);
const CLASS_OF_EXT: Record<string, Recipe["class"]> = { py: "python", rs: "rust", go: "go", zig: "zig", c: "cpp", cc: "cpp", cpp: "cpp", cxx: "cpp", h: "cpp", hpp: "cpp" };
export const CLASS_LABEL: Record<string, string> = { python: "Python", rust: "Rust", go: "Go", zig: "Zig", cpp: "C and C++", solana: "Solana program", cuda: "CUDA" };

function walk(root: string, max = 20_000): string[] {
  const out: string[] = [];
  const go = (rel: string) => {
    if (out.length >= max) return;
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (out.length >= max) return;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) go(p);
      } else if (e.isFile()) out.push(p);
    }
  };
  go("");
  return out;
}

const readSmall = (file: string, max = 512 * 1024): string => {
  try {
    return statSync(file).size <= max ? readFileSync(file, "utf8") : "";
  } catch {
    return "";
  }
};

/**
 * What the reading found. `tests` counts the files that hold tests and `tests_in` names where they are
 * (top folders, at most three). When no unit is possible, `impossible` is the sentence and `cause`
 * says which rule it was: `language` (no toolchain image; `seen` is what the tree mostly holds) or
 * `tests` (none found; `gpu` lists up to three files that call CUDA).
 */
export type TreeReading =
  | { class: Recipe["class"]; tests: number; tests_in: string[]; impossible: null }
  | { class: Recipe["class"] | null; tests: number; tests_in: string[]; impossible: string; cause: "language" | "tests"; seen: string | null; gpu: string[] };

/** Where a list of files lives: its top folders (a file at the top counts as itself), most files first, at most three. */
function places(files: string[]): string[] {
  const n = new Map<string, number>();
  for (const f of files) {
    const top = f.includes("/") ? f.slice(0, f.indexOf("/")) : f;
    n.set(top, (n.get(top) ?? 0) + 1);
  }
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([k]) => k);
}

/**
 * Pure reading of a checkout: the class is the language with the most source files among those with
 * a toolchain image (a Rust repository with Anchor.toml is a Solana program); tests are counted by
 * each language's own convention. Without a class or without one test the repository cannot have a
 * unit, and the sentence says which. A GPU is only noted beside missing tests; a repository with
 * tests that may need one is left to the drafter, which tries them in the sandbox.
 */
export function readTree(tree: string): TreeReading {
  const files = walk(tree);
  const count: Record<string, number> = {};
  const exts: Record<string, number> = {};
  for (const f of files) {
    const m = /\.([A-Za-z0-9]+)$/.exec(f);
    if (!m) continue;
    const ext = m[1]!.toLowerCase();
    exts[ext] = (exts[ext] ?? 0) + 1;
    const c = CLASS_OF_EXT[ext];
    if (c) count[c] = (count[c] ?? 0) + (ext === "h" || ext === "hpp" ? 0.5 : 1);
  }
  let cls = (Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null) as Recipe["class"] | null;
  if (!cls) {
    const code = Object.entries(exts).filter(([e]) => !["md", "txt", "json", "yml", "yaml", "toml", "lock", "png", "jpg", "jpeg", "gif", "svg", "ipynb", "cfg", "ini", "csv", "pdf"].includes(e)).sort((a, b) => b[1] - a[1])[0];
    return { class: null, tests: 0, tests_in: [], cause: "language", seen: code ? `.${code[0]}` : null, gpu: [], impossible: `there is no toolchain image for its language (${code ? `mostly .${code[0]} files` : "no source files found"}); images exist for Python, Rust, Go, C and C++, Zig and Solana programs` };
  }
  if (cls === "rust" && files.includes("Anchor.toml")) cls = "solana";
  const src = (re: RegExp) => files.filter((f) => re.test(f));
  const grep = (list: string[], re: RegExp, max = 3000) => list.slice(0, max).filter((f) => re.test(readSmall(join(tree, f))));
  const or = (a: string[], b: () => string[]) => (a.length ? a : b());
  let found: string[] = [];
  if (cls === "python") {
    const py = src(/\.py$/);
    found = or(py.filter((f) => /(^|\/)(test_[^/]*|[^/]*_test|tests?)\.py$/.test(f) || /(^|\/)tests?\/.*\.py$/.test(f)), () => grep(py, /\bunittest\b|^\s*def test_|doctest\.testmod|^\s*import pytest/m));
  } else if (cls === "rust" || cls === "solana") {
    const rs = src(/\.rs$/);
    found = or(rs.filter((f) => /(^|\/)tests\/.*\.rs$/.test(f)), () => grep(rs, /#\[(tokio::)?test\]|#\[cfg\(test\)\]/));
  } else if (cls === "go") found = src(/_test\.go$/);
  else if (cls === "zig") found = grep(src(/\.zig$/), /^\s*test\s+("|[A-Za-z_])/m);
  else if (cls === "cpp") {
    found = or([...src(/(^|\/)(tests?|unittests?)\/.*\.(c|cc|cpp|cxx)$/i), ...src(/(^|\/)[^/]*test[^/]*\.(c|cc|cpp|cxx)$/i)], () => grep(src(/(^|\/)(CMakeLists\.txt|Makefile|meson\.build)$/), /add_test|enable_testing|gtest|catch2|doctest|^check:|^test:/im));
  }
  const tests = found.length;
  if (tests > 0) return { class: cls, tests, tests_in: places(found), impossible: null };
  let why = "it has no tests, and a unit needs the repository's own tests to check every change";
  let gpu: string[] = [];
  if (cls === "python") {
    gpu = grep(src(/\.py$/), /torch\.cuda\.|device\s*=\s*["']cuda|\.cuda\(\)|device_type\s*=\s*["']cuda/).sort().slice(0, 3);
    if (gpu.length) why += `; its code also calls CUDA (a GPU) in ${gpu.join(" and ")}, and units are measured on CPUs`;
  }
  return { class: cls, tests: 0, tests_in: [], cause: "tests", seen: null, gpu, impossible: why };
}

export const REPO_URL = /^https:\/\/(github\.com|gitlab\.com|codeberg\.org)\/([\w.-]+)\/([\w.-]+)$/;

/** owner/name of a repository URL, for sentences. */
export function repoLabel(repo: string): string {
  const m = REPO_URL.exec(repo);
  return m ? `${m[2]}/${m[3]}` : repo.replace(/^https?:\/\//, "").slice(0, 80);
}

