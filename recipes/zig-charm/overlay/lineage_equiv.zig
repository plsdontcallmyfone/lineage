//! Lineage equivalence harness for jedisct1/zig-charm (protected). Usage: lineage_equiv <seed>
//! Prints, for seeded keys, nonces and messages (lengths around every 16-byte boundary and up to
//! 600 bytes), a rolling session of hashes, ciphertexts and tags; decryption results for the
//! right tag and for corrupted tags and ciphertexts (error and zeroed output); sessions with no
//! nonce. (nonceIncrement is not called: at the snapshot it names builtin.Endian, which Zig 0.15
//! no longer has, so any call fails to compile.)
const std = @import("std");
const Charm = @import("charm").Charm;
const gen = @import("lineage_gen.zig");

pub fn main() !void {
    var it = std.process.args();
    _ = it.next();
    const seed = it.next() orelse "lineage";
    var prng = gen.rng(seed);
    const r = prng.random();
    var out_buf: [64 * 1024]u8 = undefined;
    var fw = std.fs.File.stdout().writer(&out_buf);
    const out = &fw.interface;

    var buf: [600]u8 = undefined;
    var copy: [600]u8 = undefined;
    for (0..40) |s| {
        var key: [Charm.key_length]u8 = undefined;
        var nonce: [Charm.nonce_length]u8 = undefined;
        r.bytes(&key);
        r.bytes(&nonce);
        const with_nonce = s % 5 != 4;
        var enc = Charm.new(key, if (with_nonce) nonce else null);
        var dec = enc;
        for (0..12) |i| {
            const n = gen.msgLen(r, buf.len);
            r.bytes(buf[0..n]);
            @memcpy(copy[0..n], buf[0..n]);
            switch (r.uintLessThan(u8, 3)) {
                0 => {
                    const h = enc.hash(buf[0..n]);
                    const h2 = dec.hash(buf[0..n]);
                    try out.print("s{d} m{d} hash {d} {x} {}\n", .{ s, i, n, h, std.mem.eql(u8, &h, &h2) });
                },
                else => {
                    const tag = enc.encrypt(buf[0..n]);
                    try out.print("s{d} m{d} enc {d} {x} {x}\n", .{ s, i, n, buf[0..n], tag });
                    if (i == 11 and n > 0) {
                        var bad_tag = tag;
                        var trial = dec;
                        if (r.boolean()) bad_tag[r.uintLessThan(usize, 16)] ^= @as(u8, 1) << r.int(u3) else buf[r.uintLessThan(usize, n)] ^= 1;
                        if (trial.decrypt(buf[0..n], bad_tag)) |_| {
                            try out.print("  bad accepted {x}\n", .{buf[0..n]});
                        } else |err| {
                            try out.print("  bad {s} {x}\n", .{ @errorName(err), buf[0..n] });
                        }
                    } else {
                        if (dec.decrypt(buf[0..n], tag)) |_| {
                            try out.print("  dec ok {}\n", .{std.mem.eql(u8, buf[0..n], copy[0..n])});
                        } else |err| {
                            try out.print("  dec {s}\n", .{@errorName(err)});
                        }
                    }
                },
            }
        }
    }
    try out.flush();
}
