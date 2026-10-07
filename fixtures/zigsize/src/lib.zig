//! zigsize: byte statistics for a buffer (bit population, checksums, a short text report).
//! A fixture for Lineage's zig class: small, deterministic, and deliberately not as small as
//! it could be.
const std = @import("std");

/// Set bits of every 16-bit value, computed at compile time.
const pop16: [65536]u8 = blk: {
    @setEvalBranchQuota(1_000_000);
    var t: [65536]u8 = undefined;
    for (&t, 0..) |*e, i| e.* = @popCount(@as(u16, @intCast(i)));
    break :blk t;
};

/// Number of set bits in `data`.
pub fn popcount(data: []const u8) u64 {
    var total: u64 = 0;
    var i: usize = 0;
    while (i + 2 <= data.len) : (i += 2) {
        total += pop16[(@as(u16, data[i]) << 8) | data[i + 1]];
    }
    if (i < data.len) total += pop16[data[i]];
    return total;
}

/// Multiplicative checksum `acc = acc * 31 + byte`, wrapping at the width of `T`.
pub fn Checksum(comptime T: type) type {
    return struct {
        pub const width = @bitSizeOf(T);

        pub fn compute(data: []const u8) T {
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
        }
    };
}

pub const Sums = struct {
    c8: u8,
    c16: u16,
    c24: u24,
    c32: u32,
    c40: u40,
    c48: u48,
    c56: u56,
    c64: u64,
};

pub fn checksums(data: []const u8) Sums {
    return .{
        .c8 = Checksum(u8).compute(data),
        .c16 = Checksum(u16).compute(data),
        .c24 = Checksum(u24).compute(data),
        .c32 = Checksum(u32).compute(data),
        .c40 = Checksum(u40).compute(data),
        .c48 = Checksum(u48).compute(data),
        .c56 = Checksum(u56).compute(data),
        .c64 = Checksum(u64).compute(data),
    };
}

/// Longest run of one repeated byte value: (value, length). Empty input gives (0, 0).
pub fn longestRun(data: []const u8) struct { u8, usize } {
    var best_v: u8 = 0;
    var best_n: usize = 0;
    var i: usize = 0;
    while (i < data.len) {
        var j = i + 1;
        while (j < data.len and data[j] == data[i]) j += 1;
        if (j - i > best_n) {
            best_n = j - i;
            best_v = data[i];
        }
        i = j;
    }
    return .{ best_v, best_n };
}

/// Writes the text report the CLI prints.
pub fn report(w: *std.Io.Writer, data: []const u8) !void {
    const bits = popcount(data);
    try w.print("bytes:    {d}\n", .{data.len});
    try w.print("set bits: {d}\n", .{bits});
    if (data.len > 0) {
        const density = @as(f64, @floatFromInt(bits)) / @as(f64, @floatFromInt(data.len * 8));
        try w.print("density:  {d:.4}\n", .{density});
    }
    const run = longestRun(data);
    try w.print("run:      {d} x 0x{x:0>2}\n", .{ run[1], run[0] });
    var buf: [32]u8 = undefined;
    inline for (.{ u8, u16, u24, u32, u40, u48, u56, u64 }) |T| {
        try w.print("sum{d: <5} {s}\n", .{ @bitSizeOf(T), Checksum(T).hex(data, &buf) });
    }
}
