//! Lineage equivalence harness (protected). Prints the full CLI report and every checksum width
//! for seeded inputs; the sandbox digests stdout and a candidate must match its parent.
const std = @import("std");
const zs = @import("zigsize");
const input = @import("lineage_input.zig");

pub fn main() !void {
    var out_buf: [64 * 1024]u8 = undefined;
    var fw = std.fs.File.stdout().writer(&out_buf);
    const out = &fw.interface;
    var prng = input.rng();
    const r = prng.random();
    var buf: [3000]u8 = undefined;
    for (0..400) |case| {
        const data = input.fill(r, &buf);
        try out.print("case {d} len {d}\n", .{ case, data.len });
        try zs.report(out, data);
        const s = zs.checksums(data);
        try out.print("sums {x} {x} {x} {x} {x} {x} {x} {x} pop {d}\n", .{ s.c8, s.c16, s.c24, s.c32, s.c40, s.c48, s.c56, s.c64, zs.popcount(data) });
    }
    try out.flush();
}
