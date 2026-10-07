//! Lineage harness (protected): seeded inputs shared by lineage_bench.zig and lineage_equiv.zig.
//! The only input is $LINEAGE_SEED (any string, hashed to a PRNG seed).
const std = @import("std");

pub fn rng() std.Random.DefaultPrng {
    const s = std.posix.getenv("LINEAGE_SEED") orelse "0";
    return std.Random.DefaultPrng.init(std.hash.Wyhash.hash(0x7a6967, s));
}

/// Fills `buf` with one of several input shapes (random bytes, ASCII text, long runs, sparse
/// bits) and returns a prefix of random length, so odd lengths and empty input occur.
pub fn fill(r: std.Random, buf: []u8) []u8 {
    const n = r.uintLessThan(usize, buf.len + 1);
    const out = buf[0..n];
    switch (r.uintLessThan(u8, 4)) {
        0 => r.bytes(out),
        1 => for (out) |*b| {
            b.* = 0x20 + r.uintLessThan(u8, 0x5f);
        },
        2 => {
            var i: usize = 0;
            while (i < n) {
                const v = r.int(u8);
                const len = @min(n - i, 1 + r.uintLessThan(usize, 64));
                @memset(out[i..][0..len], v);
                i += len;
            }
        },
        else => for (out) |*b| {
            b.* = if (r.uintLessThan(u8, 16) == 0) @as(u8, 1) << r.int(u3) else 0;
        },
    }
    return out;
}
