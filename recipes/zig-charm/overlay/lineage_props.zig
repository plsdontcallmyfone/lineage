//! Lineage property tests for jedisct1/zig-charm (protected). The root of the test build: it
//! pulls in upstream's tests (src/main.zig `test "charm"`, which imports src/test.zig) and adds:
//! encrypt/decrypt round trips at every length from 0 to 100 bytes; detection of any corrupted
//! ciphertext or tag (error.AuthenticationFailed and a zeroed buffer); chained sessions on both
//! sides; hashing distinct messages; and regression vectors (hash, ciphertext and tag for fixed
//! inputs of 0 to 99 bytes, none ending in a full 16-byte block) measured at the recipe snapshot
//! (src/main.zig at 0f28f8a, built with Zig 0.15.2). Full-block messages are left to the
//! equivalence harness.
const std = @import("std");
const testing = std.testing;
const Charm = @import("src/main.zig").Charm;

test {
    _ = @import("src/main.zig");
}

fn fixedKey() [Charm.key_length]u8 {
    var k: [Charm.key_length]u8 = undefined;
    for (&k, 0..) |*b, i| b.* = @intCast((i * 7 + 3) & 0xff);
    return k;
}

fn fixedNonce() [Charm.nonce_length]u8 {
    var n: [Charm.nonce_length]u8 = undefined;
    for (&n, 0..) |*b, i| b.* = @intCast((i * 13 + 1) & 0xff);
    return n;
}

fn pattern(buf: []u8, salt: usize) void {
    for (buf, 0..) |*b, i| b.* = @intCast((i * 31 + salt * 17 + 5) & 0xff);
}

test "round trip at every length" {
    var buf: [100]u8 = undefined;
    var orig: [100]u8 = undefined;
    for (0..101) |n| {
        var enc = Charm.new(fixedKey(), fixedNonce());
        var dec = Charm.new(fixedKey(), fixedNonce());
        pattern(buf[0..n], n);
        @memcpy(orig[0..n], buf[0..n]);
        const tag = enc.encrypt(buf[0..n]);
        if (n >= 4) try testing.expect(!std.mem.eql(u8, buf[0..n], orig[0..n]));
        try dec.decrypt(buf[0..n], tag);
        try testing.expectEqualSlices(u8, orig[0..n], buf[0..n]);
    }
}

test "corrupted ciphertext or tag is rejected and zeroed" {
    var buf: [70]u8 = undefined;
    for ([_]usize{ 1, 15, 16, 17, 33, 70 }) |n| {
        for (0..n + 16) |pos| {
            var enc = Charm.new(fixedKey(), fixedNonce());
            var dec = Charm.new(fixedKey(), fixedNonce());
            pattern(buf[0..n], pos);
            var tag = enc.encrypt(buf[0..n]);
            if (pos < n) buf[pos] ^= 0x20 else tag[pos - n] ^= 0x01;
            try testing.expectError(error.AuthenticationFailed, dec.decrypt(buf[0..n], tag));
            for (buf[0..n]) |b| try testing.expectEqual(@as(u8, 0), b);
        }
    }
}

test "chained session stays in sync" {
    var enc = Charm.new(fixedKey(), null);
    var dec = Charm.new(fixedKey(), null);
    var buf: [48]u8 = undefined;
    for (0..20) |i| {
        const n = (i * 5) % 49;
        pattern(buf[0..n], i);
        const h1 = enc.hash(buf[0..n]);
        const h2 = dec.hash(buf[0..n]);
        try testing.expectEqualSlices(u8, &h1, &h2);
        const tag = enc.encrypt(buf[0..n]);
        try dec.decrypt(buf[0..n], tag);
    }
}

test "distinct messages hash differently" {
    var a: [40]u8 = undefined;
    pattern(&a, 1);
    var seen: [41][Charm.hash_length]u8 = undefined;
    for (0..41) |n| {
        var c = Charm.new(fixedKey(), fixedNonce());
        seen[n] = c.hash(a[0..n]);
        for (0..n) |m| try testing.expect(!std.mem.eql(u8, &seen[m], &seen[n]));
    }
}

test "regression vectors from the snapshot" {
    var buf: [100]u8 = undefined;
    for (VECTORS) |v| {
        var c = Charm.new(fixedKey(), if (v.nonce) fixedNonce() else null);
        pattern(buf[0..v.len], v.len);
        const h = c.hash(buf[0..v.len]);
        try testing.expectEqualStrings(v.hash, &std.fmt.bytesToHex(h, .lower));
        const tag = c.encrypt(buf[0..v.len]);
        var ct: [200]u8 = undefined;
        const hex = std.fmt.bytesToHex(tag, .lower);
        try testing.expectEqualStrings(v.tag, &hex);
        for (buf[0..v.len], 0..) |b, i| _ = std.fmt.bufPrint(ct[i * 2 ..][0..2], "{x:0>2}", .{b}) catch unreachable;
        try testing.expectEqualStrings(v.ct, ct[0 .. v.len * 2]);
    }
}

const Vector = struct { len: usize, nonce: bool, hash: []const u8, ct: []const u8, tag: []const u8 };
const VECTORS = [_]Vector{
    .{ .len = 0, .nonce = true, .hash = "7e7a66302e77848ea4cafdad67b1e064272184bbc3be32612396f1e97acee4cb", .ct = "", .tag = "7d6cd88b3dc8f98762c87d1b468d1f29" },
    .{ .len = 0, .nonce = false, .hash = "6d47e1746450ddf809e1c12cff085b7b4f125222645be21db53c8206ccd85158", .ct = "", .tag = "65774f1a60f87afd94b4f8fedf51fbb3" },
    .{ .len = 1, .nonce = true, .hash = "976b05761b255c020c26844077b0962e54bb241f6a5aeb268e9523199762d73e", .ct = "cf", .tag = "408b3ea6c1501938e524b3ac54629f20" },
    .{ .len = 1, .nonce = false, .hash = "0eed44a3c837bde578bcb7d7fbf7de9eb069dc0e0e432483ce2ae4c9e3e88acd", .ct = "c6", .tag = "84ba789dcd04c50c8917e28b6e5fbfaf" },
    .{ .len = 15, .nonce = true, .hash = "e69125042dbf26e0389b06adb9ed823a34bd8990c51fbaa0854f85a9d0beb770", .ct = "3eb4d9bdcdfe5c57557e0b337aaa56", .tag = "14d2f3274974912aa12ba1b6bb2bd4a3" },
    .{ .len = 15, .nonce = false, .hash = "ebb37dcafdfe53089c712a05e5c70ccf80ad13507c548c49ef4a681193948e26", .ct = "8a9af0201548b64915a3fe2a2666a6", .tag = "725a3b604b9c06aaab591459e984f54e" },
    .{ .len = 17, .nonce = true, .hash = "8d755bc32fdbc44d974d555629938491ee4efc2528da1a6a2b939a01f007532b", .ct = "138f03ed5e6bd61fab01f728538e2b715a", .tag = "837dd11d9dc681eb0a5f4d1db1825da6" },
    .{ .len = 17, .nonce = false, .hash = "dbfe51253588506b60996c334e5b89c5e7a9df844e0040abb114aa1f539dc458", .ct = "63aa778d255c3762732f9ac7a703f9885a", .tag = "25bfbbe99207524e388126856822c60f" },
    .{ .len = 31, .nonce = true, .hash = "550f5c90ef00e188c0bd4112436ec7f4b310b6e8d2f1fee25ed8724047a6437f", .ct = "cbd2f501e705851d7677f718a96d0a0093dd80124f1fa46205482e8b02087c", .tag = "392509b1bc38d24ab31b926f4f971182" },
    .{ .len = 31, .nonce = false, .hash = "ca872638048861c3a7657ed69ee94fcd5fc13c0877711683afa47a7ce619a438", .ct = "622f9480aefc30f3d51a7f4a46f7f62581a2a1b490e8e26cb92d05d5e518ec", .tag = "b52087c9da52e22056a9e10c3bce0b38" },
    .{ .len = 33, .nonce = true, .hash = "c2fb3228613fc1e965c893c78a8b307b5b4e6ff84230f8127a5f132825c8cb29", .ct = "88b454fa25328ae569f5c15732137c4579e2ed5ce03734b7326eb69925ceabd6e4", .tag = "ef88e1cf875f57f413c08be48ecd933e" },
    .{ .len = 33, .nonce = false, .hash = "5e1f857affcbd2d7a5bc7bbcf04595f2cde0b06b6370d690e81c8c3cceacc294", .ct = "9d737932d2f9cc99db581622d61b40f7276aefa60ebfd2bc96bcba4587a0d67f58", .tag = "4e2b0b28e61bbe90cfd48f938c912222" },
    .{ .len = 47, .nonce = true, .hash = "04f5bcb8affc5641029ec3f8b98cbd81ea1c852d302084d767ed7a642944693a", .ct = "a4a0d8645e9d5073d2a2b4585cf9de4562e35f5c497ce2dfd621dc84aaddda93cffde33ead114798f3dea81fe0334a", .tag = "38b010ade36cd6e076e6422d9f3c97d5" },
    .{ .len = 47, .nonce = false, .hash = "e05bf83883079ef5a30d63c6773ee4fb1afb678d8cb6c5cd363f2177aee9d570", .ct = "800764de011d560ce899546fdbbb3d558f9f019165215db787979e5b0c91290887c34c896e9fb82bb269be9a74a568", .tag = "38bfc010ef4c1c96dab6f651fa6dfd55" },
    .{ .len = 63, .nonce = true, .hash = "3048f1d27c1d6d7860d09d59a8e68f71d1c4ec3e132e2c94d49c83b321c8952d", .ct = "84d315bc7f8f4b2c69663c6e5c3de4d9eadc770f910e540a2bd386f9adb9e24be07fe2ab3b744042e136804e2ca28252499b86dd39b85ede6139b9bdb9182d", .tag = "513d24e52cea165ef10406e2474b0cfe" },
    .{ .len = 63, .nonce = false, .hash = "316675fe2b3a94984317ca091d4496b5a06b9e86841d06449287a0d023ab6a95", .ct = "bc7820307c8337d248d5ed8e7d3369ca2e81961642b6fc55074a28a62f6f94207b5a7f29ce3cc74508cc65b0cddbcda8ae564315dbf48832ebfd83f84c984d", .tag = "7a903754376324bd9633aed00309c4be" },
    .{ .len = 99, .nonce = true, .hash = "4d2fb0ac64dd12cceb057acd0f0505ef7073f7bfe2438ce177432a643553546b", .ct = "c1e8b5228ea506f2a92158ca43b94cc4ddbdf00d4683d387ee546d28dca2b1e2f1945e3f8d70972bf4a6b92579c83dc3812a88717ee3344caa56f50bfe0a1bd861abe28ef212bf2941a9a98370ecb2c3c363eb572813d2187a3ae01024f3dcf6cb0b2e", .tag = "5204929d3167385f1e4df4914e35faf9" },
    .{ .len = 99, .nonce = false, .hash = "5082277a64cccbbd330c2265df34136649824c888e6cd851b997b2e51bf9ed36", .ct = "0c92d41187b3caf4f1dcf7cf75f3ed1bae4d39baff34c42e73f77c0f465940133067e6c77babbd4515f85050c8f17a13ddc6df8db2dd3fbf632952c23b4a3f6b9ff219c1b0e876ee04128975bf293796039f2fb24b12a9154112dfdf75c926f11c8337", .tag = "3207a62dff870b1ccd3da3c1d4291eb9" },
};
