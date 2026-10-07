// Generates the fixture's known patches as canonical diffs, by editing a real checkout of the
// fixture snapshot and diffing it. Output: fixtures/b58-patches/<name>.diff (+ index.json).
// Usage: bun fixtures/make-patches.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalizeDiff, guard } from "@lineage/protocol";
import { applyPatch, diffWorkingTree, loadRecipe, materialize, newWorkDir, removeTree } from "@lineage/sandbox";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "fixtures", "b58-patches");
const loaded = loadRecipe(join(ROOT, "recipes", "fixture-b58"));

type Edit = [file: string, from: string, to: string];

interface PatchDef {
  name: string;
  /** names of patches applied first (the parent series this patch is written against) */
  parent: string[];
  kind: "perf" | "fix" | "slim";
  target: string | string[];
  /** what the network should conclude */
  expect: string;
  canary?: boolean;
  edits: Edit[];
}

const ENCODE_OUT_OLD = `    let mut out = String::new();
    for &d in digits.iter() {
        out.insert(0, ALPHABET[d as usize] as char);
    }
    for _ in 0..zeros {
        out.insert(0, '1');
    }
    out`;

const DEFS: PatchDef[] = [
  {
    name: "perf_encode",
    parent: [],
    kind: "perf",
    target: "encode_ir",
    expect: "accepted",
    edits: [
      [
        "src/lib.rs",
        ENCODE_OUT_OLD,
        `    let mut out = String::with_capacity(zeros + digits.len());
    out.extend(std::iter::repeat('1').take(zeros));
    out.extend(digits.iter().rev().map(|&d| ALPHABET[d as usize] as char));
    out`,
      ],
    ],
  },
  {
    name: "perf_encode_dup",
    parent: [],
    kind: "perf",
    target: "encode_ir",
    expect: "rejected:duplicate (same change as perf_encode, whitespace differs)",
    edits: [
      [
        "src/lib.rs",
        ENCODE_OUT_OLD,
        `    let mut out = String::with_capacity(zeros  +  digits.len());
    out.extend(std::iter::repeat('1').take(zeros));
    out.extend(digits.iter().rev().map(|&d|  ALPHABET[d as usize] as char));
    out`,
      ],
    ],
  },
  {
    name: "stale_conflict",
    parent: [],
    kind: "perf",
    target: "encode_ir",
    expect: "rejected:stale_conflict once perf_encode is accepted (edits the same lines)",
    edits: [
      [
        "src/lib.rs",
        ENCODE_OUT_OLD,
        `    let mut bytes = vec![b'1'; zeros];
    bytes.extend(digits.iter().rev().map(|&d| ALPHABET[d as usize]));
    String::from_utf8(bytes).unwrap()`,
      ],
    ],
  },
  {
    name: "perf_decode",
    parent: [],
    kind: "perf",
    target: "decode_ir",
    expect: "accepted (also after perf_encode: rebases cleanly, different lines)",
    edits: [
      [
        "src/lib.rs",
        `fn digit_value(c: u8) -> Option<u8> {
    ALPHABET.iter().position(|&a| a == c).map(|p| p as u8)
}`,
        `const DIGITS: [u8; 128] = {
    let mut t = [0xffu8; 128];
    let mut i = 0;
    while i < 58 {
        t[ALPHABET[i] as usize] = i as u8;
        i += 1;
    }
    t
};

fn digit_value(c: u8) -> Option<u8> {
    match DIGITS.get(c as usize) {
        Some(&v) if v != 0xff => Some(v),
        _ => None,
    }
}`,
      ],
    ],
  },
  {
    name: "fix_leading_ones",
    parent: [],
    kind: "fix",
    target: ["tests/basic.rs::decode_leading_ones_are_zero_bytes"],
    expect: "accepted",
    edits: [
      [
        "src/lib.rs",
        `    bytes.reverse();
    Ok(bytes)`,
        `    let ones = input.bytes().take_while(|&c| c == b'1').count();
    bytes.extend(std::iter::repeat(0).take(ones));
    bytes.reverse();
    Ok(bytes)`,
      ],
    ],
  },
  {
    name: "break_tests",
    parent: [],
    kind: "perf",
    target: "encode_ir",
    expect: "rejected:tests_fail",
    edits: [["src/lib.rs", `    let zeros = input.iter().take_while(|&&b| b == 0).count();\n    let mut digits`, `    let zeros = input.iter().take_while(|&&b| b == 0).count().min(1);\n    let mut digits`]],
  },
  {
    name: "regress",
    parent: [],
    kind: "perf",
    target: "encode_ir",
    expect: "rejected:no_improvement (slower)",
    edits: [["src/lib.rs", `        let mut carry = byte as u32;\n        for d in digits.iter_mut() {`, `        let mut carry = byte as u32;\n        let snapshot = digits.clone();\n        std::hint::black_box(&snapshot);\n        for d in digits.iter_mut() {`]],
  },
  {
    name: "equiv_change",
    parent: [],
    kind: "perf",
    target: "encode_ir",
    expect: "rejected:equivalence_changed (truncates inputs over 64 bytes; unit tests only use short inputs)",
    edits: [["src/lib.rs", `pub fn encode(input: &[u8]) -> String {\n`, `pub fn encode(input: &[u8]) -> String {\n    let input = &input[..input.len().min(64)];\n`]],
  },
  {
    name: "protected_test_edit",
    parent: [],
    kind: "fix",
    target: ["tests/basic.rs::decode_leading_ones_are_zero_bytes"],
    expect: "rejected:guard PROTECTED_PATH",
    edits: [["tests/basic.rs", `    assert_eq!(decode("112").unwrap(), vec![0, 0, 1]);\n    assert_eq!(decode("1").unwrap(), vec![0]);`, `    assert!(decode("112").is_ok());`]],
  },
  {
    name: "canary_roundtrip",
    parent: [],
    kind: "perf",
    target: "decode_ir",
    canary: true,
    expect: "canary: breaks roundtrip for inputs over 40 bytes",
    edits: [["src/lib.rs", `        let mut carry = value as u32;\n        for b in bytes.iter_mut() {`, `        let mut carry = value as u32;\n        if bytes.len() > 40 {\n            bytes.truncate(40);\n        }\n        for b in bytes.iter_mut() {`]],
  },
  {
    name: "canary_equiv",
    parent: [],
    kind: "perf",
    target: "encode_ir",
    canary: true,
    expect: "canary: skips leading-zero handling past 2 zeros, invisible to unit tests",
    edits: [["src/lib.rs", `    for _ in 0..zeros {\n        out.insert(0, '1');\n    }`, `    for _ in 0..zeros.min(2) {\n        out.insert(0, '1');\n    }`]],
  },
  {
    name: "canary_regress",
    parent: [],
    kind: "perf",
    target: "encode_ir",
    canary: true,
    expect: "canary: slower encode dressed as a win",
    edits: [["src/lib.rs", `    let mut out = String::new();\n    for &d in digits.iter() {`, `    let mut out = String::new();\n    for &d in digits.clone().iter() {\n        std::hint::black_box(digits.clone());`]],
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
