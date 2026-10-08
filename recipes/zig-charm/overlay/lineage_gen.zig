//! Seeded inputs for the lineage harnesses (protected). The seed string (argv[1]) is hashed with
//! FNV-1a into the state of the standard library's default PRNG, so inputs depend only on it.
const std = @import("std");

pub fn rng(seed: []const u8) std.Random.DefaultPrng {
    return std.Random.DefaultPrng.init(std.hash.Fnv1a_64.hash(seed));
}

pub fn seedArg() []const u8 {
    var it = std.process.args();
    _ = it.next();
    _ = it.next();
    return it.next() orelse "lineage";
}

/// message lengths around the 16-byte rate boundaries, plus longer ones
pub fn msgLen(r: std.Random, max: usize) usize {
    return switch (r.uintLessThan(u8, 4)) {
        0 => r.uintLessThan(usize, 34),
        1 => 16 * r.uintLessThan(usize, 8) + r.uintLessThan(usize, 3),
        else => r.uintLessThan(usize, max),
    };
}
