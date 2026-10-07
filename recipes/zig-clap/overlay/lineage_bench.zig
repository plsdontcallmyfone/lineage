//! Lineage benchmark harness (protected). Seeded workload for the class's secondary metric,
//! counted under cachegrind. `parse` parses seeded argument vectors; `help` renders help and
//! usage text many times. Output is a single checksum so the work cannot be optimised away.
const std = @import("std");
const clap = @import("clap");
const gen = @import("lineage_gen.zig");

pub fn main() !void {
    var args = std.process.args();
    _ = args.next();
    const which = args.next() orelse "parse";

    var buf: [1 << 20]u8 = undefined;
    var fba = std.heap.FixedBufferAllocator.init(&buf);
    var prng = std.Random.DefaultPrng.init(gen.seedFromEnv());
    const rng = prng.random();
    var sum: u64 = 0;

    if (std.mem.eql(u8, which, "parse")) {
        var argv: [12][]const u8 = undefined;
        for (0..20000) |_| {
            fba.reset();
            const a = gen.nextArgs(rng, &argv);
            var iter = clap.args.SliceIterator{ .args = a };
            var diag = clap.Diagnostic{};
            if (clap.parseEx(clap.Help, &gen.params, gen.parsers, &iter, .{ .allocator = fba.allocator(), .diagnostic = &diag })) |res| {
                sum +%= res.args.verbose + res.args.string.len + res.positionals[0].len + (res.args.number orelse 0);
            } else |err| {
                sum +%= @intFromError(err) + diag.arg.len;
            }
        }
    } else if (std.mem.eql(u8, which, "help")) {
        var text: [16 * 1024]u8 = undefined;
        for (0..400) |_| {
            var w = std.Io.Writer.fixed(&text);
            const width = 30 + rng.uintLessThan(usize, 90);
            try clap.help(&w, clap.Help, &gen.params, .{ .max_width = width });
            try clap.usage(&w, clap.Help, &gen.params);
            sum +%= std.hash.Wyhash.hash(0, w.buffered());
        }
    } else return error.UnknownWorkload;

    var out_buf: [64]u8 = undefined;
    var fw = std.fs.File.stdout().writer(&out_buf);
    try fw.interface.print("{d}\n", .{sum});
    try fw.interface.flush();
}
