//! Lineage size probe for jedisct1/zig-charm (protected): a minimal program that uses every
//! public operation that compiles at the snapshot (session setup with and without a nonce, hash,
//! encrypt, decrypt; nonceIncrement names builtin.Endian, which Zig 0.15 no longer has). Built
//! ReleaseSmall for aarch64-linux-musl; its size is what the library costs a program that uses
//! it, the property Charm is designed for (memory-constrained devices).
const std = @import("std");
const Charm = @import("charm").Charm;

pub fn main() !void {
    var key: [Charm.key_length]u8 = undefined;
    var nonce: [Charm.nonce_length]u8 = undefined;
    var msg: [256]u8 = undefined;
    var stdin_buf: [512]u8 = undefined;
    var r = std.fs.File.stdin().reader(&stdin_buf);
    const n = try r.interface.readSliceShort(&key);
    _ = try r.interface.readSliceShort(&nonce);
    const m = try r.interface.readSliceShort(&msg);
    var a = Charm.new(key, if (n & 1 == 0) nonce else null);
    var b = a;
    const h = a.hash(msg[0..m]);
    const tag = a.encrypt(msg[0..m]);
    b.decrypt(msg[0..m], tag) catch return error.AuthenticationFailed;
    var out_buf: [128]u8 = undefined;
    var fw = std.fs.File.stdout().writer(&out_buf);
    try fw.interface.writeAll(&h);
    try fw.interface.writeAll(&tag);
    try fw.interface.flush();
}
