//! Lineage benchmark harness for jedisct1/zig-charm (protected). Usage: lineage_bench <hash|aead> <seed>
//! Counted under cachegrind (ReleaseFast). Output is a single checksum so the work cannot be
//! optimised away. Inputs depend only on the seed.
//!   hash: keyed hashes of seeded messages (0 to 2 KB) in a rolling session
//!   aead: encrypt then decrypt seeded messages (0 to 2 KB) in a session, checking tags
const std = @import("std");
const Charm = @import("charm").Charm;
const gen = @import("lineage_gen.zig");

pub fn main() !void {
    var it = std.process.args();
    _ = it.next();
    const which = it.next() orelse "hash";
    const seed = it.next() orelse "lineage";
    var prng = gen.rng(seed);
    const r = prng.random();
    var key: [Charm.key_length]u8 = undefined;
    var nonce: [Charm.nonce_length]u8 = undefined;
    r.bytes(&key);
    r.bytes(&nonce);
    var buf: [2048]u8 = undefined;
    var sum: u64 = 0;
    if (std.mem.eql(u8, which, "hash")) {
        var charm = Charm.new(key, nonce);
        for (0..600) |_| {
            const n = gen.msgLen(r, buf.len);
            r.bytes(buf[0..n]);
            const h = charm.hash(buf[0..n]);
            sum = sum *% 131 +% std.mem.readInt(u64, h[0..8], .little);
        }
    } else if (std.mem.eql(u8, which, "aead")) {
        var enc = Charm.new(key, nonce);
        var dec = Charm.new(key, nonce);
        for (0..300) |_| {
            const n = gen.msgLen(r, buf.len);
            r.bytes(buf[0..n]);
            const tag = enc.encrypt(buf[0..n]);
            try dec.decrypt(buf[0..n], tag);
            sum = sum *% 131 +% std.mem.readInt(u64, tag[0..8], .little) +% n;
        }
    } else return error.UnknownWorkload;
    var out_buf: [64]u8 = undefined;
    var fw = std.fs.File.stdout().writer(&out_buf);
    try fw.interface.print("{s} {x}\n", .{ which, sum });
    try fw.interface.flush();
}
