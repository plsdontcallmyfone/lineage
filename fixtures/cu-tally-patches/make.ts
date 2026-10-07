// Generates the cu-tally fixture's known patches as canonical diffs, by editing a real checkout of
// the fixture snapshot and diffing it (same method as fixtures/make-patches.ts).
// Output: fixtures/cu-tally-patches/<name>.diff + index.json.
// Usage: bun fixtures/cu-tally-patches/make.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalizeDiff, guard } from "@lineage/protocol";
import { applyPatch, diffWorkingTree, loadRecipe, materialize, newWorkDir, removeTree } from "@lineage/sandbox";

const ROOT = join(import.meta.dir, "..", "..");
const OUT = import.meta.dir;
const loaded = loadRecipe(join(ROOT, "recipes", "fixture-cu-tally"));

type Edit = [file: string, from: string, to: string];
interface PatchDef {
  name: string;
  parent: string[];
  kind: "perf" | "fix" | "slim";
  target: string | string[];
  expect: string;
  edits: Edit[];
}

const RECORD_LOOP = `    let n = values.len() / 8;
    for i in 0..n {
        let v = read_u64(values, i * 8);
        let mut s = Stats::load(state);
        if s.count == 0 {`;

const DEFS: PatchDef[] = [
  {
    name: "perf_record",
    parent: [],
    kind: "perf",
    target: "record_cu",
    expect: "accepted",
    edits: [
      [
        "src/lib.rs",
        RECORD_LOOP,
        `    let mut s = Stats::load(state);
    for chunk in values.chunks_exact(8) {
        let v = u64::from_le_bytes(chunk.try_into().unwrap());
        if s.count == 0 {`,
      ],
      ["src/lib.rs", `        s.sum = s.sum.wrapping_add(v);\n        s.store(state);\n    }\n    Ok(())`, `        s.sum = s.sum.wrapping_add(v);\n    }\n    s.store(state);\n    Ok(())`],
    ],
  },
  {
    name: "perf_digest",
    parent: [],
    kind: "perf",
    target: "digest_cu",
    expect: "accepted",
    edits: [
      [
        "src/lib.rs",
        `pub fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (i, slot) in table.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 == 1 { (c >> 1) ^ 0xEDB8_8320 } else { c >> 1 };
        }
        *slot = c;
    }
    let mut crc: u32 = 0xFFFF_FFFF;
    for &byte in data {
        crc = (crc >> 8) ^ table[((crc ^ byte as u32) & 0xff) as usize];
    }
    !crc
}`,
        `const CRC_TABLE: [u32; 256] = {
    let mut t = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 == 1 { (c >> 1) ^ 0xEDB8_8320 } else { c >> 1 };
            k += 1;
        }
        t[i] = c;
        i += 1;
    }
    t
};

pub fn crc32(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFF_FFFF;
    for &byte in data {
        crc = (crc >> 8) ^ CRC_TABLE[((crc ^ byte as u32) & 0xff) as usize];
    }
    !crc
}`,
      ],
    ],
  },
  {
    name: "perf_sort",
    parent: [],
    kind: "perf",
    target: "sort_cu",
    expect: "accepted",
    edits: [
      [
        "src/lib.rs",
        `    // bubble sort
    for i in 0..n {
        for j in 0..n - 1 - i {
            if v[j] > v[j + 1] {
                v.swap(j, j + 1);
            }
        }
    }`,
        `    v.sort_unstable();`,
      ],
    ],
  },
  {
    name: "equiv_change",
    parent: [],
    kind: "perf",
    target: "digest_cu",
    expect: "rejected:equivalence_changed (hashes only the first 64 bytes; unit tests only use short inputs)",
    edits: [["src/lib.rs", `    let c = crc32(data);`, `    let c = crc32(&data[..data.len().min(64)]);`]],
  },
  {
    name: "regress",
    parent: [],
    kind: "perf",
    target: "sort_cu",
    expect: "rejected:no_improvement (more compute units)",
    edits: [
      [
        "src/lib.rs",
        `    // bubble sort
    for i in 0..n {
        for j in 0..n - 1 - i {`,
        `    // bubble sort, without the early end of each pass
    for _ in 0..n {
        for j in 0..n - 1 {`,
      ],
    ],
  },
  {
    name: "break_tests",
    parent: [],
    kind: "perf",
    target: "record_cu",
    expect: "rejected:tests_fail",
    edits: [["src/lib.rs", `            if v < s.min {\n                s.min = v;\n            }\n`, ``]],
  },
  {
    name: "protected_test_edit",
    parent: [],
    kind: "perf",
    target: "sort_cu",
    expect: "rejected:guard PROTECTED_PATH",
    edits: [["tests/logic.rs", `    assert!(sort(&mut st, &le32(&[0; 65])).is_err());\n`, ``]],
  },
  {
    name: "meter_tamper",
    parent: [],
    kind: "perf",
    target: "sort_cu",
    expect: "rejected:guard PROTECTED_PATH (edits the overlay harness)",
    edits: [["lineage_harness/src/main.rs", `            total += r.compute_units_consumed;`, `            total += r.compute_units_consumed / 2;`]],
  },
];

mkdirSync(OUT, { recursive: true });
const index: Record<string, Omit<PatchDef, "edits"> & { lines: number }> = {};
const built = new Map<string, string>();
for (const def of DEFS) {
  const work = newWorkDir("mkpatch");
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
    index[def.name] = { ...meta, lines: g.lines };
    console.log(`${def.name.padEnd(22)} guard=${g.ok ? "ok" : g.violation} lines=${g.lines}`);
  } finally {
    removeTree(work);
  }
}
writeFileSync(join(OUT, "index.json"), JSON.stringify(index, null, 2) + "\n");
