const std = @import("std");
const zs = @import("zigsize");

test "popcount of empty input is zero" {
    try std.testing.expectEqual(@as(u64, 0), zs.popcount(""));
}

test "popcount of ascii text" {
    try std.testing.expectEqual(@as(u64, 45), zs.popcount("hello world"));
    try std.testing.expectEqual(@as(u64, 4), zs.popcount("AA"));
}

test "popcount of a single byte" {
    try std.testing.expectEqual(@as(u64, 1), zs.popcount("@"));
    try std.testing.expectEqual(@as(u64, 7), zs.popcount("\x7f"));
}

test "checksums of short inputs" {
    const s = zs.checksums("abc");
    try std.testing.expectEqual(@as(u8, 0x62), s.c8);
    try std.testing.expectEqual(@as(u16, 0x7862), s.c16);
    try std.testing.expectEqual(@as(u32, 96354), s.c32);
    try std.testing.expectEqual(@as(u64, 96354), s.c64);
}

test "checksum wraps" {
    const data = "the quick brown fox jumps over the lazy dog";
    const s = zs.checksums(data);
    try std.testing.expectEqual(@as(u8, @truncate(s.c64)), s.c8);
    try std.testing.expectEqual(@as(u32, @truncate(s.c64)), s.c32);
}

test "longest run" {
    const r = zs.longestRun("abbbcc");
    try std.testing.expectEqual(@as(u8, 'b'), r[0]);
    try std.testing.expectEqual(@as(usize, 3), r[1]);
    try std.testing.expectEqual(@as(usize, 0), zs.longestRun("")[1]);
}

test "report" {
    var buf: [1024]u8 = undefined;
    var w = std.Io.Writer.fixed(&buf);
    try zs.report(&w, "aab");
    try std.testing.expectEqualStrings(
        \\bytes:    3
        \\set bits: 9
        \\density:  0.3750
        \\run:      2 x 0x61
        \\sum8     42
        \\sum16    7842
        \\sum24    017842
        \\sum32    00017842
        \\sum40    0000017842
        \\sum48    000000017842
        \\sum56    00000000017842
        \\sum64    0000000000017842
        \\
    , w.buffered());
}
