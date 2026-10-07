// Generates the zig class patch sets as canonical diffs, by editing a real checkout of each
// recipe snapshot (overlay included) and diffing it, the same method as fixtures/make-patches.ts.
// Output: recipes/<name>/<set>/<patch>.diff + index.json, checked with
//   bun scripts/check-canaries.ts recipes/<name> <set>
// Usage: bun fixtures/zigsize-patches/make-patches.ts [recipe names...]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalizeDiff, guard } from "@lineage/protocol";
import { diffWorkingTree, loadRecipe, materialize, newWorkDir, removeTree } from "@lineage/sandbox";

const ROOT = join(import.meta.dir, "..", "..");

type Edit = [file: string, from: string, to: string];

interface PatchDef {
  name: string;
  kind: "perf" | "fix" | "slim";
  target: string | string[];
  /** the verdict reason a single honest replay must produce (or "accepted") */
  expect: string;
  note: string;
  edits: Edit[];
}

const POPCOUNT_TABLE = `/// Set bits of every 16-bit value, computed at compile time.
const pop16: [65536]u8 = blk: {
    @setEvalBranchQuota(1_000_000);
    var t: [65536]u8 = undefined;
    for (&t, 0..) |*e, i| e.* = @popCount(@as(u16, @intCast(i)));
    break :blk t;
};

`;
const POPCOUNT_BODY = `    var total: u64 = 0;
    var i: usize = 0;
    while (i + 2 <= data.len) : (i += 2) {
        total += pop16[(@as(u16, data[i]) << 8) | data[i + 1]];
    }
    if (i < data.len) total += pop16[data[i]];
    return total;`;

const LIB = "src/lib.zig";

const SETS: Record<string, Record<string, PatchDef[]>> = {
  "fixture-zigsize": {
    candidates: [
      {
        name: "slim_popcount",
        kind: "slim",
        target: "bin_bytes",
        expect: "accepted",
        note: "Drops the 64 KiB comptime popcount table for @popCount per byte.",
        edits: [
          [LIB, POPCOUNT_TABLE, ""],
          [LIB, POPCOUNT_BODY, `    var total: u64 = 0;\n    for (data) |b| total += @popCount(b);\n    return total;`],
        ],
      },
      {
        name: "slim_checksum",
        kind: "slim",
        target: "bin_bytes",
        expect: "accepted",
        note: "One u64 checksum loop truncated to each width (wrapping multiply-add commutes with truncation) and one hex formatter with a runtime width, instead of eight instantiations of each.",
        edits: [
          [
            LIB,
            `        pub fn compute(data: []const u8) T {
            var acc: T = 0;
            var i: usize = 0;
            while (i + 4 <= data.len) : (i += 4) {
                inline for (0..4) |k| acc = acc *% 31 +% @as(T, data[i + k]);
            }
            while (i < data.len) : (i += 1) acc = acc *% 31 +% @as(T, data[i]);
            return acc;
        }

        pub fn hex(data: []const u8, buf: []u8) []const u8 {
            return std.fmt.bufPrint(buf, "{x:0>" ++ std.fmt.comptimePrint("{d}", .{width / 4}) ++ "}", .{compute(data)}) catch unreachable;
        }`,
            `        pub fn compute(data: []const u8) T {
            return @truncate(checksum64(data));
        }

        pub fn hex(data: []const u8, buf: []u8) []const u8 {
            return hexN(compute(data), width / 4, buf);
        }`,
          ],
          [
            LIB,
            `pub const Sums = struct {`,
            `fn checksum64(data: []const u8) u64 {
    var acc: u64 = 0;
    for (data) |byte| acc = acc *% 31 +% byte;
    return acc;
}

fn hexN(v: u64, digits: usize, buf: []u8) []const u8 {
    return std.fmt.bufPrint(buf, "{x:0>[1]}", .{ v, digits }) catch unreachable;
}

pub const Sums = struct {`,
          ],
        ],
      },
      {
        name: "perf_popcount64",
        kind: "perf",
        target: "work_ir",
        expect: "accepted",
        note: "Counts eight bytes per @popCount on a little-endian u64 load instead of one table lookup per two bytes.",
        edits: [
          [
            LIB,
            POPCOUNT_BODY,
            `    var total: u64 = 0;
    var i: usize = 0;
    while (i + 8 <= data.len) : (i += 8) {
        total += @popCount(std.mem.readInt(u64, data[i..][0..8], .little));
    }
    while (i < data.len) : (i += 1) total += @popCount(data[i]);
    return total;`,
          ],
        ],
      },
      {
        name: "equiv_change",
        kind: "slim",
        target: "bin_bytes",
        expect: "equivalence_changed",
        note: "Drops the table but counts only the low seven bits of each byte. The unit tests only use ASCII, so they pass; seeded random bytes do not.",
        edits: [
          [LIB, POPCOUNT_TABLE, ""],
          [LIB, POPCOUNT_BODY, `    var total: u64 = 0;\n    for (data) |b| total += @popCount(b & 0x7f);\n    return total;`],
        ],
      },
      {
        name: "regress",
        kind: "slim",
        target: "bin_bytes",
        expect: "no_improvement",
        note: "Widens the table entries to u16 'to avoid a widening load'; the table doubles to 128 KiB.",
        edits: [
          [LIB, `const pop16: [65536]u8 = blk: {`, `const pop16: [65536]u16 = blk: {`],
          [LIB, `    var t: [65536]u8 = undefined;`, `    var t: [65536]u16 = undefined;`],
        ],
      },
      {
        name: "break_tests",
        kind: "slim",
        target: "bin_bytes",
        expect: "tests_fail",
        note: "Drops the table and counts 16 bits at a time, but forgets a trailing odd byte.",
        edits: [
          [LIB, POPCOUNT_TABLE, ""],
          [
            LIB,
            POPCOUNT_BODY,
            `    var total: u64 = 0;
    var i: usize = 0;
    while (i + 2 <= data.len) : (i += 2) {
        total += @popCount((@as(u16, data[i]) << 8) | data[i + 1]);
    }
    return total;`,
          ],
        ],
      },
      {
        name: "protected_test_edit",
        kind: "slim",
        target: "bin_bytes",
        expect: "guard",
        note: "Edits a protected test file.",
        edits: [["tests/lib_test.zig", `    try std.testing.expectEqual(@as(u64, 7), zs.popcount("\\x7f"));\n`, ``]],
      },
    ],
  },
  "zig-clap": {
    canaries: [
      {
        name: "sep_value_slice",
        kind: "slim",
        target: "examples_bytes",
        expect: "tests_fail",
        note: "Presented as removing a branch that duplicates the fallthrough in short-option chaining; '-a=0' now yields the value '=0'.",
        edits: [
          [
            "clap/streaming.zig",
            `                if (next_is_separator)
                    return Arg(Id){ .param = param, .value = arg[next_index + 1 ..] };

`,
            ``,
          ],
        ],
      },
      {
        name: "long_lastsep",
        kind: "perf",
        target: "parse_ir",
        expect: "equivalence_changed",
        note: "Presented as scanning long options for the separator from the end; '--string=k=v' now splits at the last '=' and is rejected as an unknown option. No upstream test has a separator inside a long option's value.",
        edits: [
          [
            "clap/streaming.zig",
            `const eql_index = std.mem.indexOfAny(u8, arg, parser.assignment_separators);`,
            `const eql_index = std.mem.lastIndexOfAny(u8, arg, parser.assignment_separators);`,
          ],
        ],
      },
      {
        name: "inline_chaining",
        kind: "slim",
        target: "examples_bytes",
        expect: "no_improvement",
        note: "Presented as letting LLVM fold the chaining state machine into its callers; it duplicates the function at both call sites instead.",
        edits: [["clap/streaming.zig", `        fn chaining(parser: *@This(), state: State.Chaining) !?Arg(Id) {`, `        inline fn chaining(parser: *@This(), state: State.Chaining) !?Arg(Id) {`]],
      },
    ],
    candidates: [
      {
        name: "slim_report",
        kind: "slim",
        target: "examples_bytes",
        expect: "accepted",
        note: "Diagnostic.report writes fixed pieces with writeAll instead of instantiating Writer.print once per message format. Same bytes out; every program that reports parse errors links less formatting code.",
        edits: [
          [
            "clap.zig",
            `        switch (err) {
            streaming.Error.DoesntTakeValue => try stream.print(
                "The argument '{s}{s}' does not take a value\\n",
                .{ longest.kind.prefix(), longest.name },
            ),
            streaming.Error.MissingValue => try stream.print(
                "The argument '{s}{s}' requires a value but none was supplied\\n",
                .{ longest.kind.prefix(), longest.name },
            ),
            streaming.Error.InvalidArgument => try stream.print(
                "Invalid argument '{s}{s}'\\n",
                .{ longest.kind.prefix(), longest.name },
            ),
            else => try stream.print("Error while parsing arguments: {s}\\n", .{@errorName(err)}),
        }`,
            `        // One writeAll per piece instead of one \`print\` instantiation per message keeps the
        // reporter small in every program that links it. Output is unchanged.
        const before: []const u8, const after: []const u8 = switch (err) {
            streaming.Error.DoesntTakeValue => .{ "The argument '", "' does not take a value\\n" },
            streaming.Error.MissingValue => .{ "The argument '", "' requires a value but none was supplied\\n" },
            streaming.Error.InvalidArgument => .{ "Invalid argument '", "'\\n" },
            else => {
                try stream.writeAll("Error while parsing arguments: ");
                try stream.writeAll(@errorName(err));
                return stream.writeAll("\\n");
            },
        };
        try stream.writeAll(before);
        try stream.writeAll(longest.kind.prefix());
        try stream.writeAll(longest.name);
        try stream.writeAll(after);`,
          ],
        ],
      },
    ],
  },
};

const only = process.argv.slice(2);
for (const [recipe, sets] of Object.entries(SETS)) {
  if (only.length && !only.includes(recipe)) continue;
  const loaded = loadRecipe(join(ROOT, "recipes", recipe));
  for (const [set, defs] of Object.entries(sets)) {
    const out = join(ROOT, "recipes", recipe, set);
    mkdirSync(out, { recursive: true });
    const index: Record<string, unknown> = {};
    for (const def of defs) {
      const work = newWorkDir("mkpatch");
      try {
        const tree = join(work, "src");
        materialize(loaded.recipe.repo, loaded.recipe.commit, loaded.overlayDir, tree);
        for (const [file, from, to] of def.edits) {
          const path = join(tree, file);
          const src = readFileSync(path, "utf8");
          if (!src.includes(from)) throw new Error(`${recipe}/${def.name}: anchor not found in ${file}`);
          writeFileSync(path, src.replace(from, to));
        }
        const diff = canonicalizeDiff(diffWorkingTree(tree));
        writeFileSync(join(out, `${def.name}.diff`), diff);
        const g = guard(diff, loaded.recipe.patch);
        const { edits: _e, ...meta } = def;
        index[def.name] = { ...meta, lines: g.lines, guard: g.ok ? "ok" : g.violation };
        console.log(`${recipe}/${set}/${def.name.padEnd(20)} guard=${g.ok ? "ok" : g.violation} lines=${g.lines}`);
      } finally {
        removeTree(work);
      }
    }
    writeFileSync(join(out, "index.json"), JSON.stringify(index, null, 2) + "\n");
  }
}
