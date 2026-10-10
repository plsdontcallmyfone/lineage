import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attributeFile, callgrindCommand, parseCallgrind, profileTable, shortName, SpendLedger, topFunctions } from "../src/discovery.ts";
import { overlayPathOk } from "../src/recipe-proposer.ts";

// W6 worker side: callgrind parsing, the profile command, file attribution, overlay rules, spend log.

// A small callgrind file in the compressed format valgrind writes (name compression, a call with its
// inclusive cost, a recursion level suffix and an inline file switch).
const CG = `version: 1
creator: callgrind-3.22.0
pid: 7
cmd:  bench encode 1
part: 1

positions: line
events: Ir
summary: 1000

ob=(1) /work/src/target/release/examples/lineage_bench
fl=(1) ???
fn=(1) <[u8] as base58::ToBase58>::to_base58
0 600
cfl=(2) /usr/lib/malloc.c
cfn=(2) malloc
calls=3 0
0 150
fn=(3) <[u8] as base58::ToBase58>::to_base58'2
0 100
fl=(2)
fn=(2)
0 150
fi=(3) /usr/include/inline.h
0 50
fn=(4) main
fl=(4) /work/src/src/lib.rs
fn=(5) helper
0 100

totals: 1000
`;

describe("profiles (SPEC 12.8)", () => {
  test("callgrind: self cost per function, call costs excluded, recursion levels merged, files resolved", () => {
    const p = parseCallgrind(CG);
    expect(p.summary).toBe(1000);
    expect(p.total).toBe(1000);
    expect(p.events).toEqual(["Ir"]);
    const by = Object.fromEntries(p.functions.map((f) => [f.fn, f]));
    expect(by["<[u8] as base58::ToBase58>::to_base58"]).toEqual({ fn: "<[u8] as base58::ToBase58>::to_base58", file: null, self: 700 });
    expect(by["malloc"]).toEqual({ fn: "malloc", file: "/usr/lib/malloc.c", self: 200 }); // its own lines plus the inline file's
    expect(by["helper"]!.file).toBe("/work/src/src/lib.rs");
    expect(by["main"]).toBeUndefined(); // no self cost
    expect(p.functions[0]!.fn).toBe("<[u8] as base58::ToBase58>::to_base58");
    expect(topFunctions(p, 1).functions).toHaveLength(1);
    expect(profileTable(p, 2).split("\n")[0]).toBe("1. 70.00%  self 700  <[u8] as base58::ToBase58>::to_base58");
  });

  test("the metric command becomes a callgrind run writing /out, with the program's output discarded", () => {
    const m = { name: "encode_ir", kind: "perf" as const, direction: "lower" as const, deterministic: true, min_effect: 0.01, parser: "cachegrind-ir", command: 'valgrind --tool=cachegrind --cache-sim=no --cachegrind-out-file=/dev/null target/release/examples/lineage_bench encode "$LINEAGE_SEED"' };
    const c = callgrindCommand(m)!;
    expect(c).toContain("--tool=callgrind");
    expect(c).toContain("--callgrind-out-file=/out/callgrind.out");
    expect(c).not.toContain("cachegrind");
    expect(c).toContain('lineage_bench encode "$LINEAGE_SEED" ) >/dev/null 2>/dev/null');
    expect(callgrindCommand({ ...m, parser: "number", command: "wc -c < x" })).toBeNull();
  });

  test("a profiled symbol without debug info is attributed to a file that defines it", () => {
    expect(shortName("<[u8] as base58::ToBase58>::to_base58")).toBe("to_base58");
    expect(shortName("bs58::encode::EncodeBuilder<I>::into_string")).toBe("into_string");
    expect(shortName("segwit_addr.bech32_polymod")).toBe("segwit_addr");
    const tree = mkdtempSync(join(tmpdir(), "w6-attr-"));
    try {
      mkdirSync(join(tree, "src"));
      writeFileSync(join(tree, "src/lib.rs"), "fn to_base58(&self) -> String {}\n");
      writeFileSync(join(tree, "src/other.rs"), "fn x() {}\n");
      const f = { fn: "<[u8] as base58::ToBase58>::to_base58", file: null, self: 1 };
      expect(attributeFile(tree, f, "src/lib.rs")).toBe("src/lib.rs");
      expect(() => attributeFile(tree, f, "src/other.rs")).toThrow("does not contain");
      expect(() => attributeFile(tree, f, "src/none.rs")).toThrow("does not exist");
      expect(() => attributeFile(tree, f, null)).toThrow();
      expect(attributeFile(tree, { ...f, file: "/work/src/src/lib.rs" }, null)).toBe("src/lib.rs");
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  test("overlay files are new lineage_* files inside the tree", () => {
    const tree = mkdtempSync(join(tmpdir(), "w6-ov-"));
    try {
      writeFileSync(join(tree, "lineage_bench.py"), "");
      expect(overlayPathOk("lineage_equiv.py", tree)).toBeNull();
      expect(overlayPathOk("ref/python/lineage_bench.py", tree)).toBeNull();
      expect(overlayPathOk("lineage_bench.py", tree)).toContain("already has");
      expect(overlayPathOk("bench.py", tree)).toContain("lineage_");
      expect(overlayPathOk("../lineage_x.py", tree)).toContain("outside");
      expect(overlayPathOk(".git/lineage_x", tree)).toContain("outside");
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  test("spend ledger prices every call at the published rates and keeps a running total", () => {
    const dir = mkdtempSync(join(tmpdir(), "w6-spend-"));
    try {
      const l = new SpendLedger(join(dir, "spend.jsonl"), 3);
      const e = l.record("t", "claude-opus-5-5", { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 4000 } as any);
      // 1000*4 + 2000*20 + 10000*0.2 + 4000*5 = 66000 per million
      expect(e.usd).toBeCloseTo(0.066, 10);
      l.record("t", "unknown-model", { input_tokens: 1_000_000, output_tokens: 0 } as any);
      expect(l.total()).toBeCloseTo(0.066 + 10, 6); // unknown models at the highest listed rate
      expect(l.remaining()).toBeLessThan(0);
      expect(readFileSync(join(dir, "spend.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
      // a dated snapshot id is priced as its model, not at the highest rate
      const dated = l.record("t", "claude-opus-5-5-20261001", { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 4000 } as any);
      expect(dated.usd).toBeCloseTo(0.066, 10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
