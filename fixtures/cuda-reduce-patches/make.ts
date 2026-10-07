// Generates the cuda-reduce fixture's known patches as canonical diffs by editing a real checkout of
// the fixture snapshot and diffing it (needs only git, no GPU). Output: fixtures/cuda-reduce-patches/
// <name>.diff plus index.json with the outcome each patch is expected to produce on a GPU replay.
// Usage: bun fixtures/cuda-reduce-patches/make.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalizeDiff, guard } from "@lineage/protocol";
import { applyPatch, diffWorkingTree, loadRecipe, materialize, newWorkDir, removeTree } from "@lineage/sandbox";

const ROOT = join(import.meta.dir, "..", "..");
const OUT = import.meta.dir;
const loaded = loadRecipe(join(ROOT, "recipes", "fixture-cuda"));

type Edit = [file: string, from: string, to: string];

interface PatchDef {
  name: string;
  /** names of patches applied first (the parent series this patch is written against) */
  parent: string[];
  kind: "perf" | "fix" | "slim";
  target: string | string[];
  /** what the network should conclude; not yet observed on a GPU (marked expected) */
  expect: string;
  edits: Edit[];
}

const K = "src/kernels.cu";

const REDUCE_LOOP_OLD = `  for (unsigned int s = 1; s < blockDim.x; s *= 2) {
    if (tid % (2 * s) == 0) {
      sdata[tid] += sdata[tid + s];
    }
    __syncthreads();
  }`;

const REDUCE_LOOP_SEQ = `  for (unsigned int s = blockDim.x / 2; s > 0; s >>= 1) {
    if (tid < s) {
      sdata[tid] += sdata[tid + s];
    }
    __syncthreads();
  }`;

const DEFS: PatchDef[] = [
  {
    name: "perf_reduce",
    parent: [],
    kind: "perf",
    target: "reduce_warp_inst",
    expect: "accepted (sequential addressing: idle warps skip the add path and no integer modulo)",
    edits: [[K, REDUCE_LOOP_OLD, REDUCE_LOOP_SEQ]],
  },
  {
    name: "perf_reduce_warp",
    parent: ["perf_reduce"],
    kind: "perf",
    target: "reduce_warp_inst",
    expect: "accepted on top of perf_reduce (last 64 elements reduced with warp shuffles, no barriers)",
    edits: [
      [
        K,
        `${REDUCE_LOOP_SEQ}
  if (tid == 0) atomicAdd(out, (unsigned long long)sdata[0]);`,
        `${REDUCE_LOOP_SEQ.replace("s > 0", "s > 32")}
  if (tid < 32) {
    long long v = sdata[tid] + sdata[tid + 32];
    for (int offset = 16; offset > 0; offset >>= 1) v += __shfl_down_sync(0xffffffffu, v, offset);
    if (tid == 0) atomicAdd(out, (unsigned long long)v);
  }`,
      ],
    ],
  },
  {
    name: "perf_scale",
    parent: [],
    kind: "perf",
    target: "scale_warp_inst",
    expect: "accepted (scale[r] loaded once instead of once per column; row pointer hoisted)",
    edits: [
      [
        K,
        `  for (int c = 0; c < cols; ++c) {
    m[(size_t)r * cols + c] *= scale[r];
  }`,
        `  const int s = scale[r];
  int* row = m + (size_t)r * cols;
  for (int c = 0; c < cols; ++c) {
    row[c] *= s;
  }`,
      ],
    ],
  },
  {
    name: "equiv_change",
    parent: [],
    kind: "perf",
    target: "scale_warp_inst",
    expect: "rejected:equivalence_changed (stops at column 4096; unit tests use at most 1000 columns, the seeded equivalence shapes use 4000 to 9000)",
    edits: [[K, `  for (int c = 0; c < cols; ++c) {\n    m[(size_t)r * cols + c] *= scale[r];`, `  for (int c = 0; c < cols && c < 4096; ++c) {\n    m[(size_t)r * cols + c] *= scale[r];`]],
  },
  {
    name: "regress",
    parent: [],
    kind: "perf",
    target: "reduce_warp_inst",
    expect: "rejected:no_improvement (two extra uncached loads per element; same result, more warp instructions)",
    edits: [
      [
        K,
        `  sdata[tid] = (i < (unsigned int)n) ? (long long)in[i] : 0;`,
        `  sdata[tid] = (i < (unsigned int)n) ? (long long)__ldcv(in + i) + (long long)__ldcv(in + i) - (long long)__ldcv(in + i) : 0;`,
      ],
    ],
  },
  {
    name: "break_tests",
    parent: [],
    kind: "perf",
    target: "reduce_warp_inst",
    expect: "rejected:tests_fail (drops the partial last block: fewer instructions, wrong sums for n not a multiple of 256)",
    edits: [[K, `  int grid = (n + REDUCE_BLOCK - 1) / REDUCE_BLOCK;`, `  int grid = n / REDUCE_BLOCK;`]],
  },
  {
    name: "protected_test_edit",
    parent: [],
    kind: "perf",
    target: "reduce_warp_inst",
    expect: "rejected:guard PROTECTED_PATH",
    edits: [["tests/test_kernels.cu", `  const int sizes[] = {0, 1, 255, 256, 257, 1000, 65536, 100003};`, `  const int sizes[] = {256, 65536};`]],
  },
];

mkdirSync(OUT, { recursive: true });
const index: Record<string, Omit<PatchDef, "edits"> & { lines: number; guard: string }> = {};
const built = new Map<string, string>();
for (const def of DEFS) {
  const work = newWorkDir("mkpatch-cuda");
  try {
    const tree = join(work, "src");
    materialize(loaded.recipe.repo, loaded.recipe.commit, loaded.overlayDir, tree);
    for (const p of def.parent) if (!applyPatch(tree, built.get(p)!)) throw new Error(`${def.name}: parent ${p} does not apply`);
    for (const [file, from, to] of def.edits) {
      const path = join(tree, file);
      const src = readFileSync(path, "utf8");
      if (!src.includes(from)) throw new Error(`${def.name}: anchor not found in ${file}`);
      writeFileSync(path, src.replace(from, to));
    }
    const diff = canonicalizeDiff(diffWorkingTree(tree));
    built.set(def.name, diff);
    writeFileSync(join(OUT, `${def.name}.diff`), diff);
    const g = guard(diff, loaded.recipe.patch);
    const { edits: _e, ...meta } = def;
    index[def.name] = { ...meta, lines: g.lines, guard: g.ok ? "ok" : g.violation! };
    console.log(`${def.name.padEnd(22)} guard=${g.ok ? "ok" : g.violation} lines=${g.lines}`);
  } finally {
    removeTree(work);
  }
}
writeFileSync(join(OUT, "index.json"), JSON.stringify(index, null, 2) + "\n");
