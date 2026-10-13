import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Recipe } from "@units/protocol";

// The free structural pass over a checkout (no model call, no sandbox): which packages a repository
// holds that could each be a unit of their own, and which one to measure first. For every package
// (a Cargo crate, a Go package, a Python project or import package, a C or C++ directory with its own
// build file, a Zig package) it reads: its source size, its tests, how many dependencies it has and
// whether any of them is another package of the same repository (a leaf has none), and the signs
// that make a measurement differ between machines or fail offline: code picked by CPU feature,
// assembly, C through a build script, a GPU, threads, the OS random source or clock, a system
// library. The packages are ranked small, self-contained, CPU-bound, own tests, few dependencies
// first, and the recipe drafter is told to write its recipe for ONE of them (recipe-proposer.ts).
// A repository cannot be a unit as a whole when its build and tests take longer than a replay may:
// the hand-built recipes for such repositories (recipes/gorbagana-chain, recipes/percolator) measure
// one small crate, fetch only what it needs and pin the image's toolchain; this pass gives a model
// the same start.

export interface UnitCandidate {
  /** the package's own name: crate name, Go import path, Python project or package, directory */
  name: string;
  /** its directory, relative to the repository root ("." for the root) */
  path: string;
  kind: "crate" | "go package" | "python package" | "directory" | "zig package";
  source_lines: number;
  source_files: number;
  /** tests found by the language's convention (test functions, or test files where functions are not countable) */
  tests: number;
  tests_where: string;
  /** dependencies from outside the repository (build ones included), and development-only ones */
  deps: string[];
  dev_deps: string[];
  /** packages of this repository it depends on; a leaf has none */
  internal: string[];
  /** signs that a measurement may differ between machines or the build may fail in the sandbox */
  risks: string[];
  /** facts that help write the recipe (a feature that pins a scalar backend, a build script, seeded property tests) */
  notes: string[];
  /** lower is better */
  score: number;
  /** false: it cannot be a unit as it stands (no tests of its own, no library, a GPU) */
  eligible: boolean;
}

export interface Structure {
  class: Recipe["class"];
  /** every package found, best first */
  candidates: UnitCandidate[];
  /** the toolchain version the repository asks for, as written (rust-toolchain, rust-version, go directive, minimum_zig_version, requires-python), or null */
  toolchain: string | null;
  /** how many packages the repository's lockfile names (Cargo.lock, go.sum modules), or null */
  locked: number | null;
}

/** What a probe of the class image found (recipe-proposer.ts imageFacts): the toolchain version it runs and tools it lacks. */
export interface ImageFacts {
  toolchain: string | null;
  missing: string[];
}

/** Classes this pass reads. A class outside it (cuda) gets no structure and the drafter's prompt is as before. */
export const STRUCTURE_CLASSES: Recipe["class"][] = ["rust", "solana", "go", "python", "cpp", "zig"];

const SKIP = new Set([".git", "node_modules", "vendor", "third_party", "target", "dist", "build", ".venv", "venv", "__pycache__", "zig-cache", ".zig-cache", "zig-out", ".github", "docs", "doc"]);
const MAX_FILES = 20_000;
const MAX_READ = 2 * 1024 * 1024;

function walk(root: string): string[] {
  const out: string[] = [];
  const go = (rel: string) => {
    if (out.length >= MAX_FILES) return;
    let es: import("node:fs").Dirent[];
    try {
      es = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= MAX_FILES) return;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) go(p);
      } else if (e.isFile()) out.push(p);
    }
  };
  go("");
  return out;
}

const read = (file: string): string => {
  try {
    return statSync(file).size <= MAX_READ ? readFileSync(file, "utf8") : "";
  } catch {
    return "";
  }
};

/** Lines of a file without reading one larger than MAX_READ whole into a string (a generated table still counts). */
function lineCount(file: string): number {
  try {
    const b = readFileSync(file);
    let n = b.length && b[b.length - 1] !== 10 ? 1 : 0;
    for (let i = 0; i < b.length; i++) if (b[i] === 10) n++;
    return n;
  } catch {
    return 0;
  }
}

const under = (dir: string, f: string) => dir === "." || f === dir || f.startsWith(`${dir}/`);
const uniq = <T>(a: T[]) => [...new Set(a)];
const toml = (text: string): Record<string, any> | null => {
  try {
    return Bun.TOML.parse(text) as Record<string, any>;
  } catch {
    return null;
  }
};

interface Sign {
  re: RegExp;
  risk: string;
  weight: number;
}

/** Counts the files of `files` whose text matches each sign; returns the risks seen with how many files, and their weight. */
function signs(root: string, files: string[], list: Sign[]): { risks: string[]; weight: number; hit: Set<string> } {
  const n = new Map<Sign, number>();
  for (const f of files.slice(0, 1500)) {
    const text = read(join(root, f));
    if (!text) continue;
    for (const s of list) if (s.re.test(text)) n.set(s, (n.get(s) ?? 0) + 1);
  }
  const seen = list.filter((s) => n.has(s));
  return { risks: seen.map((s) => `${s.risk} (${n.get(s)} file${n.get(s) === 1 ? "" : "s"})`), weight: seen.reduce((a, s) => a + s.weight, 0), hit: new Set(seen.map((s) => s.risk)) };
}

/** Size: a package with almost no code has nothing to improve; a very large one costs many turns to read and long builds. */
function sizeScore(lines: number): number {
  if (lines < 60) return 80;
  if (lines < 150) return 20;
  if (lines <= 4000) return lines / 400;
  return Math.min(60, 10 + ((lines - 4000) / 1000) * 5);
}

/** Very few tests check very little: a change could break behaviour unseen. */
const fewTests = (tests: number) => (tests === 0 ? 0 : tests < 3 ? 90 : tests < 8 ? 25 : 0);

const depScore = (deps: number, dev: number, internal: number) => Math.min(60, deps * 4) + Math.min(15, dev) + internal * 25;

// ---------------------------------------------------------------------------------------------
// Rust (and Solana programs): Cargo packages

const SYSTEM_CRATES = /^(openssl|openssl-sys|native-tls|libz-sys|zstd-sys|libsqlite3-sys|rusqlite|libgit2-sys|git2|curl|curl-sys|rdkafka|rocksdb|librocksdb-sys|protobuf-src|prost-build|tonic-build|bindgen|cmake|pkg-config|aws-lc-sys|aws-lc-rs|ring|blst|blstrs|secp256k1-sys|secp256k1|lz4-sys|bzip2-sys|jemalloc-sys|tikv-jemallocator|hidapi|alsa|pq-sys|mysqlclient-sys)$/;
const GPU_NAME = /(^|[-_])(cuda|opencl|wgpu|vulkan|metal|gpu|ocl|icicle)([-_]|$)/i;
const SCALAR_FEATURE = /(^|[-_])(serial|portable|scalar|soft|software|fallback|generic|pure|no[-_]?simd|no[-_]?asm|force[-_]?soft|u64[-_]backend|u32[-_]backend|fiat)([-_]|$)/i;

const RUNTIME_DISPATCH = "picks code by CPU feature at run time";
const RUST_SIGNS: Sign[] = [
  { re: /is_(x86|aarch64|arm)_feature_detected!|cpufeatures::|\bcpufeatures\b.*new!|multiversion/, risk: RUNTIME_DISPATCH, weight: 70 },
  { re: /cfg\(\s*(all\(|any\()?\s*target_feature\s*=|cfg\(\s*(all\(|any\(|not\()?\s*target_arch\s*=|#\[target_feature|target_feature\s*\(\s*enable/, risk: "has code compiled only for some CPU architectures or features (chosen at build time by the compiler flags)", weight: 20 },
  { re: /\b(asm|global_asm|naked_asm)!\s*\(/, risk: "has inline assembly", weight: 60 },
  { re: /(core|std)::arch::(x86_64|x86|aarch64|arm)\b|core::simd|std::simd/, risk: "uses SIMD intrinsics", weight: 20 },
  { re: /\b(rayon::|std::thread::|tokio::|crossbeam|std::sync::mpsc)/, risk: "uses threads", weight: 30 },
  { re: /\b(thread_rng|OsRng|SysRng|getrandom::|rand::rng\(\)|SystemTime::now|Instant::now)\b/, risk: "reads the OS random source or the clock", weight: 15 },
  { re: /\b(reqwest|hyper::|TcpStream|UdpSocket|std::net::)/, risk: "opens network connections", weight: 80 },
];

function memberDirs(root: string, ws: Record<string, any> | undefined, manifests: string[]): Set<string> | null {
  if (!ws) return null;
  const pat = (g: string) => new RegExp(`^${g.replace(/^\.\//, "").replace(/\/+$/, "").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".+").replace(/\*/g, "[^/]+")}$`);
  const inc = (Array.isArray(ws.members) ? ws.members : []).filter((x: unknown) => typeof x === "string").map(pat);
  const exc = (Array.isArray(ws.exclude) ? ws.exclude : []).filter((x: unknown) => typeof x === "string").map(pat);
  const out = new Set<string>();
  for (const m of manifests) {
    const d = dirname(m);
    if (d === "." ? existsSync(join(root, "Cargo.toml")) : inc.some((r: RegExp) => r.test(d)) && !exc.some((r: RegExp) => r.test(d))) out.add(d);
  }
  return out;
}

function rustStructure(root: string, files: string[], image?: ImageFacts): Structure {
  const manifests = files.filter((f) => /(^|\/)Cargo\.toml$/.test(f));
  const rootToml = toml(read(join(root, "Cargo.toml")));
  const ws = rootToml?.workspace as Record<string, any> | undefined;
  const wsDeps = (ws?.dependencies ?? {}) as Record<string, any>;
  const members = memberDirs(root, ws, manifests);
  const parsed = manifests.map((m) => ({ dir: dirname(m), t: toml(read(join(root, m))) })).filter((x) => x.t?.package && typeof x.t.package.name === "string");
  const dirOfName = new Map(parsed.map((p) => [p.t!.package.name as string, p.dir]));
  const pkgDirs = parsed.map((p) => p.dir);
  const out: UnitCandidate[] = [];
  for (const { dir, t } of parsed) {
    const pkg = t!.package as Record<string, any>;
    const name = pkg.name as string;
    // files of this package: under its directory and under no deeper package
    const own = files.filter((f) => under(dir, f) && !pkgDirs.some((d) => d !== dir && d.length > (dir === "." ? 0 : dir.length) && under(d, f) && under(dir, d)));
    const rel = (f: string) => (dir === "." ? f : f.slice(dir.length + 1));
    const src = own.filter((f) => /^src\/.*\.rs$/.test(rel(f)));
    const testFiles = own.filter((f) => /^tests\/.*\.rs$/.test(rel(f)));
    const lib = !!t!.lib || src.some((f) => rel(f) === "src/lib.rs");
    let tests = 0;
    let inSrc = 0;
    for (const f of [...src, ...testFiles]) {
      const c = (read(join(root, f)).match(/#\[(tokio::|rstest|test_case\b[^\]]*\]\s*#\[)?test\b[^\]]*\]|\bproptest!\s*\{/g) ?? []).length;
      tests += c;
      if (src.includes(f)) inSrc += c;
    }
    const tables = (o: unknown) => (o && typeof o === "object" ? (o as Record<string, any>) : {});
    const targets = Object.values(tables(t!.target)).map(tables);
    const normal = { ...tables(t!.dependencies), ...Object.assign({}, ...targets.map((x) => tables(x.dependencies))) };
    const build = { ...tables(t!["build-dependencies"]), ...Object.assign({}, ...targets.map((x) => tables(x["build-dependencies"]))) };
    const dev = { ...tables(t!["dev-dependencies"]), ...Object.assign({}, ...targets.map((x) => tables(x["dev-dependencies"]))) };
    const isInternal = (n: string, spec: any) => (spec && typeof spec === "object" && typeof spec.path === "string") || (spec && typeof spec === "object" && spec.workspace === true && wsDeps[n] && typeof wsDeps[n] === "object" && typeof wsDeps[n].path === "string") || (dirOfName.has(n) && spec && typeof spec === "object" && spec.workspace === true && typeof wsDeps[n]?.path === "string");
    const internal = uniq([...Object.entries(normal), ...Object.entries(build)].filter(([n, s]) => isInternal(n, s)).map(([n]) => n)).filter((n) => n !== name);
    const deps = uniq([...Object.keys(normal), ...Object.keys(build)]).filter((n) => !internal.includes(n) && n !== name).sort();
    const devDeps = Object.keys(dev).filter((n) => n !== name && !deps.includes(n)).sort();
    const s = signs(root, src, RUST_SIGNS);
    const risks = [...s.risks];
    const notes: string[] = [];
    const lines = src.reduce((a, f) => a + lineCount(join(root, f)), 0);
    // a generated table (one file over 5,000 lines holding more than a third of the crate) is not code to read or improve
    const big = src.map((f) => ({ f, n: lineCount(join(root, f)) })).filter((x) => x.n > 5000 && x.n > lines / 3);
    const code = lines - big.reduce((a, x) => a + x.n, 0);
    let score = s.weight + sizeScore(code) + depScore(deps.length, devDeps.length, internal.length) + fewTests(tests);
    let eligible = true;
    if (deps.length >= 3 && code < 1000) {
      notes.push("a thin layer over its dependencies: most of the work happens in code a patch here cannot change");
      score += 40;
    }
    const sysDeps = [...deps, ...Object.keys(build)].filter((n) => SYSTEM_CRATES.test(n) || /-sys$/.test(n) || n === "cc");
    if (sysDeps.length) {
      risks.push(`builds C or assembly, or needs a system library, through ${uniq(sysDeps).join(", ")}`);
      score += 120;
    }
    const sysDev = devDeps.filter((n) => SYSTEM_CRATES.test(n) || /-sys$/.test(n));
    if (sysDev.length) {
      // measured on the image when the caller probed it: without pkg-config and the headers such a crate's build script fails offline
      const missing = image && image.missing.some((m) => /pkg-config|openssl|cmake/i.test(m));
      risks.push(`its tests and examples link ${sysDev.join(", ")} (development dependency), which needs a system library or a C build${missing ? `; the image has no ${image!.missing.join(", no ")}, so its tests will not build there the plain way (the hand-built recipe for anza-xyz/cryptography got around this with a manifest of its own in the overlay, lineage/Cargo.toml, that compiles the same source files with only the development dependencies the tests use)` : " the image may not have"}`);
      score += missing ? 400 : 90;
    }
    if (GPU_NAME.test(name) || [...deps, ...devDeps].some((n) => GPU_NAME.test(n))) {
      risks.push("needs a GPU");
      score += 500;
      eligible = false;
    }
    if (tables(t!.lib)["proc-macro"] === true) {
      risks.push("is a procedural macro crate (it runs inside the compiler)");
      score += 400;
      eligible = false;
    }
    if (!lib) {
      risks.push("has no library target, so a benchmark example cannot call it");
      score += 400;
      eligible = false;
    }
    if (members && !members.has(dir)) {
      risks.push("is not a member of the root workspace (it needs its own lockfile and build)");
      score += 60;
    }
    if (!tests) {
      risks.push("has no tests of its own");
      score += 1000;
      eligible = false;
    }
    if (own.some((f) => rel(f) === "build.rs")) notes.push("has a build script (build.rs): read it before choosing features");
    const features = Object.keys(tables(t!.features));
    const scalar = features.filter((f) => SCALAR_FEATURE.test(f));
    if (scalar.length) notes.push(`features that may pin a portable backend: ${scalar.join(", ")}`);
    const cfgs = uniq([...read(join(root, dir === "." ? "Cargo.toml" : `${dir}/Cargo.toml`)).matchAll(/cfg\([^)]*?\b([a-z0-9_]+_(?:backend|bits|impl))\s*=\s*"([a-z0-9_]+)"/g)].map((m) => `${m[1]}="${m[2]}"`));
    for (const f of src.filter((x) => /(^|\/)(lib|backend|backend\/mod)\.rs$/.test(x)).slice(0, 4)) for (const m of read(join(root, f)).matchAll(/cfg\([^)]*?\b([a-z0-9_]+_(?:backend|bits|impl))\s*=\s*"([a-z0-9_]+)"/g)) cfgs.push(`${m[1]}="${m[2]}"`);
    if (cfgs.length) notes.push(`its backend is chosen by --cfg (${uniq(cfgs).slice(0, 6).join(", ")}): pin the portable one with RUSTFLAGS in every command`);
    // a backend that can be pinned makes run-time dispatch a smaller risk
    if ((cfgs.length || scalar.length) && s.hit.has(RUNTIME_DISPATCH)) score -= 45;
    if ([...deps, ...devDeps].includes("proptest") || src.concat(testFiles).some((f) => /\bproptest!/.test(read(join(root, f))))) notes.push("has property tests (proptest): they draw from the OS unless PROPTEST_RNG_SEED is set in the test command");
    const optional = Object.entries(normal).filter(([, sp]) => sp && typeof sp === "object" && (sp as any).optional === true).length;
    if (optional) notes.push(`${optional} of its dependencies are optional (behind features)`);
    if (typeof pkg["rust-version"] === "string") notes.push(`asks for Rust ${pkg["rust-version"]} or newer`);
    if (pkg.edition === "2024") notes.push("edition 2024 (needs Rust 1.85 or newer; its examples are edition 2024 too, where gen is a reserved word: do not name anything gen)");
    if (big.length) notes.push(`${big.map((x) => `${rel(x.f)} is ${x.n.toLocaleString("en-US")} lines (a table: do not read it)`).join("; ")}`);
    out.push({ name, path: dir, kind: "crate", source_lines: lines, source_files: src.length, tests, tests_where: tests ? [inSrc ? `${inSrc} in src` : "", tests - inSrc ? `${tests - inSrc} in tests/` : ""].filter(Boolean).join(", ") : "none", deps, dev_deps: devDeps, internal, risks, notes, score, eligible });
  }
  // a crate built on another crate of the repository carries half of that crate's weight (its size, its risks)
  const own = new Map(out.map((c) => [c.name, c.score]));
  for (const c of out) c.score += c.internal.reduce((a, d) => a + Math.min(150, (own.get(d) ?? 0) / 2), 0);
  // what the repository asks for
  const tc = toml(read(join(root, "rust-toolchain.toml")))?.toolchain?.channel ?? (read(join(root, "rust-toolchain")).trim().split("\n")[0] || null);
  const rv = ws?.package?.["rust-version"] ?? rootToml?.package?.["rust-version"];
  const toolchain = typeof tc === "string" && tc ? `rust-toolchain: ${tc}` : typeof rv === "string" ? `rust-version ${rv} or newer` : null;
  const lock = read(join(root, "Cargo.lock"));
  return { class: "rust", candidates: rank(out), toolchain, locked: lock ? (lock.match(/^\[\[package\]\]/gm) ?? []).length : null };
}

// ---------------------------------------------------------------------------------------------
// Go: packages (directories) of each module that have tests

const GO_SIGNS: Sign[] = [
  { re: /golang\.org\/x\/sys\/cpu|internal\/cpu|\bcpu\.(X86|ARM64|ARM|S390X)\.|cpuid\./, risk: "picks code by CPU feature at run time", weight: 60 },
  { re: /^\s*import\s+"C"|^\s*"C"\s*$/m, risk: "uses cgo (C code)", weight: 120 },
  { re: /\bgo\s+func\b|\bgo\s+[a-zA-Z_][\w.]*\(|sync\.WaitGroup|runtime\.GOMAXPROCS/, risk: "starts goroutines", weight: 25 },
  { re: /"crypto\/rand"|time\.Now\(\)|"math\/rand(\/v2)?"/, risk: "reads the OS random source, an unseeded generator or the clock", weight: 15 },
  { re: /"net\/http"|"net"\s*$|net\.Dial|http\.(Get|Post|Client)/m, risk: "opens network connections", weight: 80 },
];

function goStructure(root: string, files: string[]): Structure {
  const mods = files.filter((f) => /(^|\/)go\.mod$/.test(f)).map((f) => ({ dir: dirname(f), text: read(join(root, f)) })).sort((a, b) => b.dir.length - a.dir.length);
  const goFiles = files.filter((f) => /\.go$/.test(f));
  const dirs = uniq(goFiles.map((f) => dirname(f)));
  const out: UnitCandidate[] = [];
  for (const dir of dirs) {
    const mod = mods.find((m) => under(m.dir, dir));
    const modPath = mod ? (/^module\s+(\S+)/m.exec(mod.text)?.[1] ?? "") : "";
    const relDir = mod && mod.dir !== "." ? dir.slice(mod.dir.length).replace(/^\//, "") : dir === "." ? "" : dir;
    const own = goFiles.filter((f) => dirname(f) === dir);
    const src = own.filter((f) => !/_test\.go$/.test(f));
    const testFiles = own.filter((f) => /_test\.go$/.test(f));
    if (!src.length) continue;
    if (src.every((f) => /^package\s+main\b/m.test(read(join(root, f)))) && !testFiles.length) continue; // a command with no tests
    const imports = uniq(src.flatMap((f) => [...read(join(root, f)).matchAll(/^\s*(?:import\s+)?(?:[\w.]+\s+)?"([^"\s]+)"\s*$/gm)].map((m) => m[1]!)));
    const internal = modPath ? imports.filter((i) => i === modPath || i.startsWith(`${modPath}/`)) : [];
    const deps = imports.filter((i) => /^[^/]+\.[^/]+\//.test(i) && !internal.includes(i)).sort();
    const tests = testFiles.reduce((a, f) => a + (read(join(root, f)).match(/^func (Test|Fuzz)\w*\(/gm) ?? []).length, 0);
    const asm = files.filter((f) => dirname(f) === dir && /\.(s|S)$/.test(f));
    const arch = own.filter((f) => /_(amd64|arm64|386|arm|s390x|ppc64le|riscv64)(_test)?\.go$/.test(f) || /^\/\/go:build .*\b(amd64|arm64)\b/m.test(read(join(root, f)).slice(0, 400)));
    const s = signs(root, src, GO_SIGNS);
    const risks = [...s.risks];
    let score = s.weight + sizeScore(src.reduce((a, f) => a + lineCount(join(root, f)), 0)) + depScore(deps.length, 0, internal.length) + fewTests(tests);
    let eligible = true;
    if (asm.length) {
      risks.push(`has assembly files (${asm.length})`);
      score += 100;
    }
    if (arch.length) {
      risks.push(`has files built per CPU architecture (${arch.length})`);
      score += 25;
    }
    if (!tests) {
      risks.push("has no tests of its own");
      score += 1000;
      eligible = false;
    }
    const notes: string[] = [];
    if (asm.length || arch.length) notes.push("the build tag purego (where the package honours it) selects the portable Go code: check its files' build constraints");
    out.push({ name: modPath ? (relDir ? `${modPath}/${relDir}` : modPath) : dir, path: dir, kind: "go package", source_lines: src.reduce((a, f) => a + lineCount(join(root, f)), 0), source_files: src.length, tests, tests_where: tests ? `${testFiles.length} test file${testFiles.length === 1 ? "" : "s"} in the package` : "none", deps, dev_deps: [], internal, risks, notes, score, eligible });
  }
  const rootMod = mods.find((m) => m.dir === ".") ?? mods.at(-1);
  const goV = rootMod ? (/^toolchain\s+(\S+)/m.exec(rootMod.text)?.[1] ?? /^go\s+(\S+)/m.exec(rootMod.text)?.[1]) : null;
  const sum = read(join(root, rootMod && rootMod.dir !== "." ? `${rootMod.dir}/go.sum` : "go.sum"));
  return { class: "go", candidates: rank(out), toolchain: goV ? `go ${goV.replace(/^go/, "")}` : null, locked: sum ? uniq(sum.split("\n").map((l) => l.split(" ")[0]).filter(Boolean)).length : null };
}

// ---------------------------------------------------------------------------------------------
// Python: projects of a monorepo (a directory with its own pyproject.toml, setup.py or setup.cfg),
// else the import packages of the one project

const PY_SIGNS: Sign[] = [
  { re: /^\s*(import|from)\s+(torch|tensorflow|jax|cupy|numba|pycuda)\b/m, risk: "imports a GPU or JIT numeric library", weight: 200 },
  { re: /^\s*(import|from)\s+(numpy|scipy|pandas)\b/m, risk: "imports compiled numeric libraries (numpy, scipy or pandas)", weight: 40 },
  { re: /^\s*(import|from)\s+(ctypes|cffi)\b|ext_modules\s*=|cythonize\(/m, risk: "uses C extensions or foreign calls", weight: 100 },
  { re: /^\s*(import|from)\s+(multiprocessing|threading|asyncio|concurrent)\b/m, risk: "uses threads, processes or an event loop", weight: 25 },
  { re: /\bos\.urandom\(|\bsecrets\.|\brandom\.(random|randint|choice|shuffle)\(|\btime\.time\(|datetime\.(now|utcnow)\(/, risk: "reads the OS random source, an unseeded generator or the clock", weight: 15 },
  { re: /^\s*(import|from)\s+(requests|httpx|urllib\.request|socket|aiohttp)\b/m, risk: "opens network connections", weight: 80 },
];

function pyDeps(root: string, dir: string): string[] {
  const t = toml(read(join(root, dir === "." ? "pyproject.toml" : `${dir}/pyproject.toml`)));
  const a: unknown[] = Array.isArray(t?.project?.dependencies) ? t!.project.dependencies : Object.keys(t?.tool?.poetry?.dependencies ?? {}).filter((k) => k !== "python");
  const fromSetup = [...read(join(root, dir === "." ? "setup.cfg" : `${dir}/setup.cfg`)).matchAll(/^\s{2,}([A-Za-z][\w.-]*)\s*(?:[<>=!~;].*)?$/gm)].map((m) => m[1]!);
  const req = read(join(root, dir === "." ? "requirements.txt" : `${dir}/requirements.txt`)).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith("-"));
  const names = (a.length ? a : req.length ? req : fromSetup).map((x) => String(x).split(/[\s<>=!~;[(]/)[0]!.toLowerCase()).filter(Boolean);
  return uniq(names).sort();
}

function pythonStructure(root: string, files: string[]): Structure {
  const py = files.filter((f) => /\.py$/.test(f));
  const isTest = (f: string) => /(^|\/)(test_[^/]*|[^/]*_test|conftest)\.py$/.test(f) || /(^|\/)tests?\//.test(f);
  const projects = uniq(files.filter((f) => /(^|\/)(pyproject\.toml|setup\.py|setup\.cfg)$/.test(f)).map((f) => dirname(f)));
  const sub = projects.filter((d) => d !== ".");
  const out: UnitCandidate[] = [];
  const add = (name: string, dir: string, src: string[], tests: string[], deps: string[], internal: string[], extra: { risks?: string[]; notes?: string[] } = {}) => {
    if (!src.length) return;
    const s = signs(root, src, PY_SIGNS);
    const n = tests.reduce((a, f) => a + (read(join(root, f)).match(/^\s*(async\s+)?def test_\w*\(/gm) ?? []).length, 0);
    const compiled = files.filter((f) => under(dir, f) && /\.(pyx|pxd|c|cpp|cc|rs)$/.test(f)).length;
    const risks = [...s.risks, ...(extra.risks ?? [])];
    let score = s.weight + sizeScore(src.reduce((a, f) => a + lineCount(join(root, f)), 0)) + depScore(deps.length, 0, internal.length);
    let eligible = true;
    if (compiled) {
      risks.push(`has compiled sources (${compiled} C, C++, Cython or Rust files)`);
      score += 100;
    }
    if (!n && !tests.length) {
      risks.push("has no tests of its own");
      score += 1000;
      eligible = false;
    }
    out.push({ name, path: dir, kind: "python package", source_lines: src.reduce((a, f) => a + lineCount(join(root, f)), 0), source_files: src.length, tests: n || tests.length, tests_where: tests.length ? `${tests.length} test file${tests.length === 1 ? "" : "s"} in ${uniq(tests.map((f) => dirname(f))).slice(0, 2).join(", ")}` : "none", deps, dev_deps: [], internal, risks, notes: extra.notes ?? [], score, eligible });
  };
  if (sub.length >= 2 || (sub.length === 1 && !projects.includes("."))) {
    // a monorepo: each project directory is a candidate
    const names = new Map(sub.map((d) => [d, String(toml(read(join(root, `${d}/pyproject.toml`)))?.project?.name ?? d.split("/").pop())]));
    for (const d of sub) {
      const own = py.filter((f) => under(d, f) && !sub.some((o) => o !== d && o.length > d.length && under(o, f)));
      const deps = pyDeps(root, d);
      const internal = deps.filter((x) => [...names.values()].some((nm) => nm.toLowerCase().replace(/_/g, "-") === x.replace(/_/g, "-")) && x !== names.get(d)!.toLowerCase());
      add(names.get(d)!, d, own.filter((f) => !isTest(f) && !/(^|\/)(setup|conftest)\.py$/.test(f)), own.filter(isTest), deps.filter((x) => !internal.includes(x)), internal);
    }
  } else {
    // one project: its import packages (a directory with __init__.py at the top or under src/), and top-level modules
    const tops = uniq(py.filter((f) => /(^|\/)__init__\.py$/.test(f)).map((f) => dirname(f))).filter((d) => !isTest(`${d}/x.py`) && (/^[^/]+$/.test(d) || /^src\/[^/]+$/.test(d)));
    const mods = py.filter((f) => /^[^/]+\.py$/.test(f) && !isTest(f) && !/^(setup|conftest|noxfile|tasks|fabfile)\.py$/.test(f));
    const allTests = py.filter(isTest);
    const deps = pyDeps(root, ".");
    const units = [...tops.map((d) => ({ name: d.split("/").pop()!, dir: d, src: py.filter((f) => under(d, f) && !isTest(f)) })), ...mods.map((f) => ({ name: f.replace(/\.py$/, ""), dir: ".", src: [f] }))];
    for (const u of units) {
      const mine = allTests.filter((f) => under(u.dir === "." ? "\u0000" : u.dir, f) || new RegExp(`\\b(import|from)\\s+${u.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(read(join(root, f))));
      const internal = units.filter((o) => o.name !== u.name && u.src.some((f) => new RegExp(`^\\s*(import|from)\\s+${o.name}\\b`, "m").test(read(join(root, f))))).map((o) => o.name);
      add(u.name, u.dir, u.src, units.length === 1 ? allTests : mine, deps, internal);
    }
  }
  const req = toml(read(join(root, "pyproject.toml")))?.project?.["requires-python"];
  return { class: "python", candidates: rank(out), toolchain: typeof req === "string" ? `requires-python ${req}` : null, locked: null };
}

// ---------------------------------------------------------------------------------------------
// C and C++: directories with their own build file

const C_SIGNS: Sign[] = [
  { re: /__builtin_cpu_supports|__get_cpuid|\bcpuid\b|getauxval\s*\(|__attribute__\s*\(\(\s*(target|ifunc)|IsProcessorFeaturePresent/, risk: "picks code by CPU feature at run time", weight: 60 },
  { re: /#\s*include\s*<(immintrin|emmintrin|xmmintrin|smmintrin|tmmintrin|wmmintrin|arm_neon|arm_sve)\.h>|__asm__|\basm\s*\(|__m(128|256|512)i?\b/, risk: "uses assembly or SIMD intrinsics", weight: 60 },
  { re: /#\s*include\s*<(cuda|CL\/cl|OpenCL\/opencl)[^>]*>|__global__|cudaMalloc/, risk: "needs a GPU", weight: 500 },
  { re: /#\s*include\s*<(pthread|omp|threads)\.h>|std::thread|std::async|#\s*pragma\s+omp/, risk: "uses threads", weight: 30 },
  { re: /\b(rand|random|arc4random|getrandom|time|clock|gettimeofday|clock_gettime)\s*\(/, risk: "may read an unseeded generator or the clock", weight: 10 },
  { re: /#\s*include\s*<(sys\/socket|netinet\/in|curl\/curl)\.h>/, risk: "opens network connections", weight: 80 },
];

function cppStructure(root: string, files: string[]): Structure {
  const isSrc = (f: string) => /\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(f);
  const isTest = (f: string) => /(^|\/)(tests?|unittests?)\//i.test(f) || /(^|\/)[^/]*test[^/]*\.(c|cc|cpp|cxx)$/i.test(f);
  const buildDirs = uniq(files.filter((f) => /(^|\/)(CMakeLists\.txt|Makefile|makefile|GNUmakefile|meson\.build|BUILD|BUILD\.bazel)$/.test(f)).map((f) => dirname(f))).filter((d) => !/(^|\/)(tests?|unittests?|examples?|bench(marks)?|cmake)$/i.test(d));
  const out: UnitCandidate[] = [];
  for (const dir of buildDirs) {
    const deeper = buildDirs.filter((d) => d !== dir && under(dir, d) && d.length > (dir === "." ? 0 : dir.length));
    const own = files.filter((f) => under(dir, f) && !deeper.some((d) => under(d, f)));
    const src = own.filter((f) => isSrc(f) && !isTest(f));
    const tests = own.filter((f) => isSrc(f) && isTest(f) && !/\.(h|hh|hpp|hxx)$/i.test(f));
    if (!src.length) continue;
    const buildText = ["CMakeLists.txt", "Makefile", "makefile", "GNUmakefile", "meson.build"].map((b) => read(join(root, dir === "." ? b : `${dir}/${b}`))).join("\n");
    const deps = uniq([...buildText.matchAll(/find_package\s*\(\s*([\w-]+)|pkg_check_modules\s*\(\s*\w+\s+(?:REQUIRED\s+)?([\w.+-]+)|dependency\s*\(\s*'([\w.+-]+)'|(?:^|\s)-l([a-z][\w+-]*)/gm)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]!).filter((d) => !/^(m|c|rt|dl|pthread|Threads|stdc\+\+)$/.test(d))).sort();
    const includes = uniq(src.flatMap((f) => [...read(join(root, f)).matchAll(/#\s*include\s*"([^"]+)"/g)].map((m) => m[1]!)));
    const internal = buildDirs.filter((d) => d !== dir && d !== "." && !under(dir, d) && includes.some((i) => i.startsWith(`${d.split("/").pop()}/`) || i.includes(`../${d.split("/").pop()}/`)));
    const asm = own.filter((f) => /\.(s|S|asm)$/.test(f));
    const s = signs(root, src, C_SIGNS);
    const risks = [...s.risks];
    let score = s.weight + sizeScore(src.reduce((a, f) => a + lineCount(join(root, f)), 0)) + depScore(deps.length, 0, internal.length);
    let eligible = !s.hit.has("needs a GPU");
    if (asm.length) {
      risks.push(`has assembly files (${asm.length})`);
      score += 100;
    }
    if (!tests.length) {
      risks.push("has no tests of its own");
      score += 1000;
      eligible = false;
    }
    out.push({ name: dir === "." ? "(repository root)" : dir, path: dir, kind: "directory", source_lines: src.reduce((a, f) => a + lineCount(join(root, f)), 0), source_files: src.length, tests: tests.length, tests_where: tests.length ? `${tests.length} test source file${tests.length === 1 ? "" : "s"}` : "none", deps, dev_deps: [], internal, risks, notes: /cmake_minimum_required|project\s*\(/i.test(buildText) ? ["built with CMake: check that the image has it, else compile its sources directly as the format reference does"] : [], score, eligible });
  }
  const std = /CMAKE_CXX_STANDARD\s+(\d+)|-std=(c\+\+\d+|gnu\+\+\d+|c\d+)/.exec(read(join(root, "CMakeLists.txt")) + read(join(root, "Makefile")));
  return { class: "cpp", candidates: rank(out), toolchain: std ? `language standard ${std[1] ? `C++${std[1]}` : std[2]}` : null, locked: null };
}

// ---------------------------------------------------------------------------------------------
// Zig: packages (a directory with build.zig)

const ZIG_SIGNS: Sign[] = [
  { re: /builtin\.cpu\.features|std\.Target\.\w+\.featureSetHas|has_(avx|sse|neon|aes)/, risk: "picks code by CPU feature", weight: 60 },
  { re: /@Vector\(|std\.simd|asm\s+volatile|\basm\s*\(/, risk: "uses vectors or assembly", weight: 50 },
  { re: /@cImport|linkLibC|linkSystemLibrary|addCSourceFile/, risk: "links C code or a system library", weight: 100 },
  { re: /std\.Thread\b/, risk: "uses threads", weight: 30 },
  { re: /std\.crypto\.random|std\.time\.(milli|nano|micro)?[tT]imestamp|std\.posix\.getrandom/, risk: "reads the OS random source or the clock", weight: 15 },
  { re: /std\.net\.|std\.http\./, risk: "opens network connections", weight: 80 },
];

function zigStructure(root: string, files: string[]): Structure {
  const pkgs = uniq(files.filter((f) => /(^|\/)build\.zig$/.test(f)).map((f) => dirname(f)));
  const out: UnitCandidate[] = [];
  for (const dir of pkgs) {
    const deeper = pkgs.filter((d) => d !== dir && under(dir, d) && d.length > (dir === "." ? 0 : dir.length));
    const own = files.filter((f) => under(dir, f) && /\.zig$/.test(f) && !deeper.some((d) => under(d, f)));
    const src = own.filter((f) => !/(^|\/)build\.zig$/.test(f));
    if (!src.length) continue;
    const zon = read(join(root, dir === "." ? "build.zig.zon" : `${dir}/build.zig.zon`));
    const depBlock = /\.dependencies\s*=\s*\.\{([\s\S]*?)\n\s{4}\},/.exec(zon)?.[1] ?? "";
    const all = [...depBlock.matchAll(/^\s*\.(?:@"([^"]+)"|([A-Za-z_][\w]*))\s*=\s*\.\{/gm)].map((m) => m[1] ?? m[2]!).filter((n) => !["url", "hash", "path", "lazy"].includes(n));
    const internal = all.filter((n) => new RegExp(`\\.(?:@"${n}"|${n})\\s*=\\s*\\.\\{[^}]*\\.path\\s*=`).test(depBlock));
    const deps = all.filter((n) => !internal.includes(n)).sort();
    const tests = src.reduce((a, f) => a + (read(join(root, f)).match(/^\s*test\s+("|[A-Za-z_])/gm) ?? []).length, 0);
    const s = signs(root, src, ZIG_SIGNS);
    const risks = [...s.risks];
    let score = s.weight + sizeScore(src.reduce((a, f) => a + lineCount(join(root, f)), 0)) + depScore(deps.length, 0, internal.length) + fewTests(tests);
    let eligible = true;
    if (!tests) {
      risks.push("has no tests of its own");
      score += 1000;
      eligible = false;
    }
    const name = /\.name\s*=\s*(?:"([^"]+)"|\.(\w+))/.exec(zon);
    out.push({ name: name?.[1] ?? name?.[2] ?? (dir === "." ? "(repository root)" : dir), path: dir, kind: "zig package", source_lines: src.reduce((a, f) => a + lineCount(join(root, f)), 0), source_files: src.length, tests, tests_where: tests ? "test blocks in its sources" : "none", deps, dev_deps: [], internal, risks, notes: [], score, eligible });
  }
  const min = /\.minimum_zig_version\s*=\s*"([^"]+)"/.exec(read(join(root, "build.zig.zon")))?.[1];
  return { class: "zig", candidates: rank(out), toolchain: min ? `minimum_zig_version ${min}` : null, locked: null };
}

// ---------------------------------------------------------------------------------------------

function rank(c: UnitCandidate[]): UnitCandidate[] {
  return c.map((x) => ({ ...x, score: Math.round(x.score * 10) / 10 })).sort((a, b) => Number(b.eligible) - Number(a.eligible) || a.score - b.score || a.source_lines - b.source_lines || a.name.localeCompare(b.name));
}

/** The structure of a checkout for its class; null for a class this pass does not read. Never throws: an unreadable tree gives no candidates. */
export function repoStructure(tree: string, cls: Recipe["class"], image?: ImageFacts): Structure | null {
  if (!STRUCTURE_CLASSES.includes(cls)) return null;
  try {
    const files = walk(tree);
    const s = cls === "rust" || cls === "solana" ? rustStructure(tree, files, image) : cls === "go" ? goStructure(tree, files) : cls === "python" ? pythonStructure(tree, files) : cls === "cpp" ? cppStructure(tree, files) : zigStructure(tree, files);
    return { ...s, class: cls };
  } catch {
    return { class: cls, candidates: [], toolchain: null, locked: null };
  }
}

/** True when the repository holds more than one package that could be a unit: the drafter is then told to pick one. */
export const multiPackage = (s: Structure | null): boolean => !!s && s.candidates.length >= 2;

const n = (x: number) => x.toLocaleString("en-US");
const few = (a: string[], max = 6) => (a.length <= max ? a.join(", ") : `${a.slice(0, max).join(", ")} and ${a.length - max} more`);

/** One candidate as one line of the prompt. */
export function candidateLine(c: UnitCandidate, i: number): string {
  const deps = c.deps.length ? `${c.deps.length} outside dependenc${c.deps.length === 1 ? "y" : "ies"} (${few(c.deps)})` : "no outside dependency";
  const dev = c.dev_deps.length ? `; development only: ${few(c.dev_deps)}` : "";
  const leaf = c.internal.length ? `depends on ${few(c.internal)} of this repository` : "a leaf (depends on no other package here)";
  return `${i + 1}. ${c.name} at ${c.path === "." ? "the root" : `${c.path}/`}: ${n(c.source_lines)} source lines in ${n(c.source_files)} file${c.source_files === 1 ? "" : "s"}; tests: ${c.tests ? `${n(c.tests)} (${c.tests_where})` : "none"}; ${deps}${dev}; ${leaf}.${c.risks.length ? ` Risks: ${c.risks.join("; ")}.` : " No risk sign found."}${c.notes.length ? ` Notes: ${c.notes.join("; ")}.` : ""}`;
}

/**
 * The seeded generator of the hand-built Rust recipes (recipes/gorbagana-chain overlay,
 * examples/lineage_support/rng.rs): std only, so a harness needs no dependency, and every seed text
 * gives distinct inputs. Shown to the drafter so it does not write (and debug) its own.
 */
export const RUST_SEEDED_RNG = `pub struct Rng(u64);
impl Rng {
    pub fn from_seed_str(s: &str) -> Rng {
        let mut h: u64 = 0xcbf29ce484222325;
        for b in s.bytes() { h ^= b as u64; h = h.wrapping_mul(0x100000001b3); }
        Rng(h)
    }
    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
        z ^ (z >> 31)
    }
    pub fn below(&mut self, n: u64) -> u64 { self.next() % n }
    pub fn bytes(&mut self, n: usize) -> Vec<u8> { (0..n).map(|_| self.next() as u8).collect() }
}`;

/** How one package of a repository is built, tested and fetched alone, per class: the technique of the hand-built recipes. */
function technique(s: Structure, top: UnitCandidate, image?: ImageFacts): string {
  const dir = top.path === "." ? "" : `${top.path}/`;
  if (s.class === "rust" || s.class === "solana") {
    const v = image?.toolchain ?? "<the image's version>";
    const pin = `RUSTUP_TOOLCHAIN=${v}`;
    const asks = s.toolchain ? `The repository asks for ${s.toolchain}; the image runs Rust ${image?.toolchain ?? "(the version the format reference names)"}. ` : "";
    return `Rust, one crate of a workspace (the technique of the hand-built recipes for agave-sized workspaces):
- Name the crate in every cargo command with -p ${top.name}; never build or test the workspace.
- prepare fetches only what that crate and its tests need: \`${pin} cargo tree --locked -p ${top.name} -e normal,build,dev > /dev/null\` downloads exactly the packages it prints${s.locked ? ` (a plain \`cargo fetch\` would download all ${n(s.locked)} packages of the lockfile)` : ""}. Add --features <list> there when the build uses features. With no Cargo.lock in the repository, make one first (\`cargo generate-lockfile\`, prepare_outputs [Cargo.lock]).
- build: \`${pin} cargo build --release --locked --offline -p ${top.name} --lib --examples --tests\`; test: \`${pin} cargo test --release --locked --offline -p ${top.name} --no-fail-fast --lib --tests 2>&1\` (parser libtest). --lib --tests leaves the benches out: a bench target (criterion) is not needed and is not built.
- ${asks}Write ${pin} in front of every cargo command: without it rustup tries to install the version a rust-toolchain file names, and there is no network after prepare. If the crate does not compile on the image's version, say so with give_up; do not try other versions.
- Harness: overlay files ${dir}examples/lineage_bench.rs and ${dir}examples/lineage_equiv.rs (examples of that crate, so they may use the crate, its dependencies and its dev-dependencies, and std; no new dependency). Run them as target/release/examples/lineage_bench <mode> "$LINEAGE_SEED" [--inputs-only] and target/release/examples/lineage_equiv "$LINEAGE_SEED". Inputs come only from the seed: hash the seed text with FNV-1a into a splitmix64 state, never the crate's own random constructors, the clock or the OS. The generator the hand-built recipes share between both examples (put it in ${dir}examples/lineage_support/rng.rs and include it with #[path = "lineage_support/rng.rs"] mod lineage_rng;): take every value into a local before passing the generator on (let k = r.below(8); f(&mut r, k)), since two uses of it in one call do not compile.
\`\`\`rust
${RUST_SEEDED_RNG}
\`\`\`
  The benchmark prints a checksum of every result; with --inputs-only as its last argument it builds the same inputs and stops before the first library call. The equivalence example prints the library's answers for seeded inputs, edge cases and invalid inputs.
- Where the crate offers a portable or serial backend (a feature, or a --cfg named in the notes above), pin it in every command (prepare, build, test, metrics) so every verifier's CPU runs the same code. Use the crate's public API only.
- patch.allowed_paths: ["${dir}src/**"]. protected_paths: "${dir}tests/**", "${dir}examples/**", "${dir}benches/**", "**/Cargo.toml", "Cargo.lock", "**/build.rs", "rust-toolchain*", ".cargo/**", ".github/**". When the crate keeps unit tests inside its source files, add protected_blocks: [{ glob: "${dir}src/**/*.rs", start: "^\\\\s*#\\\\[cfg\\\\(test\\\\)\\\\]" }].
- build.artifacts: ["target/release/lib<crate name with underscores>.rlib"].`;
  }
  if (s.class === "go")
    return `Go, one package of a module:
- test only that package: \`go test -json -count=1 -p 1 ./${top.path === "." ? "" : top.path} | gotap\`-style as the format reference does, with its package path; build the harness main packages (lineage/<name>/main.go) against that package only.
- prepare downloads only what it needs: \`go mod download\` for a small module, else \`go list -deps -test ./${top.path === "." ? "." : top.path} > /dev/null\` with the module cache under /deps as in the format reference.
- Where the package has assembly or per-architecture files, build with the purego tag if the package honours it (-tags purego in every command), so every verifier runs the same Go code.
- patch.allowed_paths: the package's non-test .go files ("${dir}*.go"); protected_paths: "${dir}*_test.go", "go.mod", "go.sum" and the overlay.`;
  if (s.class === "python")
    return `Python, one package of the repository:
- run only its tests (pytest with the path of its tests, --junitxml=/out/junit.xml); install only what it needs in prepare (its own requirements, not the whole repository's extras).
- the benchmark imports only that package, so the count is not dominated by imports of the rest.
- patch.allowed_paths: that package's sources ("${dir}**/*.py" without its tests); protected_paths: its tests, packaging files and the overlay.`;
  if (s.class === "cpp")
    return `C or C++, one directory with its own build:
- compile only that directory's sources and the harness with the format reference's compiler flags (no -march=native; no flags that turn on CPU features), output under lineage_out/.
- its tests print TAP as in the format reference; do not build the rest of the repository.
- patch.allowed_paths: that directory's sources; protected_paths: its tests, build files and the overlay.`;
  return `Zig, one package:
- build and test only that package (zig build in its directory, or zig test on its root source file) with the format reference's -target and -mcpu flags.
- patch.allowed_paths: that package's sources; protected_paths: its build.zig, build.zig.zon and the overlay.`;
}

/**
 * The drafter's prompt section for a repository with several packages: the ranked list, the instruction
 * to write the recipe for ONE (the first unless its code gives a concrete reason against it), and how
 * one package is fetched, built and tested alone in this class. Empty for a single package.
 */
export function structureSection(s: Structure | null, image?: ImageFacts, max = 8): string {
  if (!s || !multiPackage(s)) return "";
  const ok = s.candidates.filter((c) => c.eligible);
  const no = s.candidates.filter((c) => !c.eligible);
  if (!ok.length) return "";
  const shown = ok.slice(0, max);
  const img = image ? `\nThe image, read from it just now: ${[image.toolchain ? `toolchain ${image.toolchain}` : "", image.missing.length ? `it does NOT have ${image.missing.join(", ")}` : ""].filter(Boolean).join("; ") || "nothing to note"}.` : "";
  return `

THIS REPOSITORY HAS ${n(s.candidates.length)} PACKAGES. It is too large to measure whole (a replay must build and test it in minutes), so the unit is ONE package. A free reading of the checkout ranked them, best first: small, self-contained, CPU-bound, with tests of its own and few dependencies. You do not need to list or read the repository to find this out again.
${shown.map(candidateLine).join("\n")}${ok.length > shown.length ? `\n(${ok.length - shown.length} more, ranked lower, not shown)` : ""}${no.length ? `\nNot possible as they stand: ${no.slice(0, 6).map((c) => `${c.name} (${c.risks.filter((r) => /GPU|no tests|no library|procedural/.test(r)).join("; ") || "see its risks"})`).join("; ")}.` : ""}${img}

Write the recipe for number 1, ${shown[0]!.name}, and only for it. Take another from the list only for a concrete reason you see in its code (then say the reason in your submit note), and never more than one. Read only that package: its manifest, its public API and the tests that show how it is called. Do not read the other packages.

${technique(s, shown[0]!, image)}

Go to a first trial early. A trial's report (the build error, the tests that failed, a metric that is not deterministic) tells you more than reading does and costs no model spend: write the recipe and a small harness from what the manifest and the public API show, call trial_calibrate, then fix what it reports.`;
}
