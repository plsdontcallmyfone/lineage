//! Lineage benchmark harness (protected). Seeded workload counted under cachegrind: popcount,
//! checksums, longest run and the report over seeded buffers. Prints one checksum.
const std = @import("std");
const zs = @import("zigsize");
const input = @import("lineage_input.zig");

pub fn main() !void {
    var prng = input.rng();
    const r = prng.random();
    var buf: [1 << 16]u8 = undefined;
    var text: [1024]u8 = undefined;
    var acc: u64 = 0;
    for (0..64) |_| {
        const data = input.fill(r, &buf);
        acc +%= zs.popcount(data);
        acc +%= zs.checksums(data).c64;
        acc +%= zs.longestRun(data)[1];
        var w = std.Io.Writer.fixed(&text);
        try zs.report(&w, data);
        acc +%= std.hash.Wyhash.hash(0, w.buffered());
    }
    var out_buf: [64]u8 = undefined;
    var fw = std.fs.File.stdout().writer(&out_buf);
    try fw.interface.print("{d}\n", .{acc});
    try fw.interface.flush();
}
