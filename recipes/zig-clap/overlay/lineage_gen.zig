//! Lineage harness (protected): seeded command-line generator shared by lineage_bench.zig and
//! lineage_equiv.zig. The only input is $LINEAGE_SEED (any string, hashed to a PRNG seed).
const std = @import("std");
const clap = @import("clap");

pub const Mode = enum { fast, slow, auto };

pub const params = clap.parseParamsComptime(
    \\-h, --help              Display this help and exit.
    \\-v, --verbose           Increase verbosity. Can be repeated: `-vvv`.
    \\-n, --number <usize>    An option parameter, which takes a value.
    \\-i, --int <isize>...    A signed number, repeatable.
    \\-f, --float <f64>       A floating point value.
    \\-m, --mode <MODE>       One of fast, slow or auto.
    \\-s, --string <str>...   A string, repeatable.
    \\-o, --output <FILE>     Where to write. Long descriptions are wrapped by the help renderer
    \\                        when they do not fit the configured width, and this one is long
    \\                        on purpose so wrapping is exercised.
    \\<FILE>...
    \\
);

pub const parsers = .{
    .usize = clap.parsers.int(usize, 0),
    .isize = clap.parsers.int(isize, 0),
    .f64 = clap.parsers.float(f64),
    .str = clap.parsers.string,
    .FILE = clap.parsers.string,
    .MODE = clap.parsers.enumeration(Mode),
};

pub fn seedFromEnv() u64 {
    const s = std.posix.getenv("LINEAGE_SEED") orelse "0";
    return std.hash.Wyhash.hash(0x6c696e65616765, s);
}

const flags = [_][]const u8{ "-h", "--help", "-v", "-vv", "-vvv", "--verbose", "-hv" };
const unsigned_vals = [_][]const u8{ "0", "17", "0x10", "0b101", "4096" };
const signed_vals = [_][]const u8{ "0", "-5", "42", "-0x10", "9001" };
const float_vals = [_][]const u8{ "2.5", "1e3", "-0.125", "inf", "3" };
const mode_vals = [_][]const u8{ "fast", "slow", "auto" };
const str_vals = [_][]const u8{ "file.txt", "", "a=b", "-", "hello world", "αβγ" };
const Opt = struct { name: []const u8, vals: []const []const u8 };
const with_value = [_]Opt{
    .{ .name = "-n", .vals = &unsigned_vals },  .{ .name = "--number", .vals = &unsigned_vals },
    .{ .name = "-i", .vals = &signed_vals },    .{ .name = "--int", .vals = &signed_vals },
    .{ .name = "-f", .vals = &float_vals },     .{ .name = "--float", .vals = &float_vals },
    .{ .name = "-m", .vals = &mode_vals },      .{ .name = "--mode", .vals = &mode_vals },
    .{ .name = "-s", .vals = &str_vals },       .{ .name = "--string", .vals = &str_vals },
    .{ .name = "-o", .vals = &str_vals },       .{ .name = "--output", .vals = &str_vals },
};
const attached = [_][]const u8{ "-n7", "-n=12", "--number=0x1f", "-i-3", "--int=-42", "-f=2.5", "--float:1e-3", "-mfast", "--mode=slow", "-s=a b", "--string=", "-o=out.txt", "--output:x", "--string=k=v", "--output=a:b", "-s=x=y" };
const values = [_][]const u8{ "0", "17", "0x10", "-5", "2.5", "1e3", "nan", "fast", "slow", "auto", "file.txt", "", "a=b" };
const positionals = [_][]const u8{ "file.txt", "dir/sub/x.zig", "αβγ.txt", "123", "-", "README" };
const junk = [_][]const u8{ "--bogus", "-z", "-vz", "--help=1", "--mode=bogus", "-n", "18446744073709551616", "-9223372036854775808" };

fn pick(rng: std.Random, list: []const []const u8) []const u8 {
    return list[rng.uintLessThan(usize, list.len)];
}

/// Fills `buf` with a random argument vector and returns it. Most vectors are valid; a few tokens
/// are junk (unknown options, missing, mistyped or malformed values), so both the success
/// and the diagnostic paths run.
pub fn nextArgs(rng: std.Random, buf: [][]const u8) []const []const u8 {
    const want = rng.uintLessThan(usize, buf.len + 1);
    var n: usize = 0;
    var dashdash = false;
    while (n < want) {
        const r = rng.uintLessThan(u32, 100);
        if (r < 3) {
            buf[n] = pick(rng, &junk);
        } else if (dashdash or r < 30) {
            buf[n] = pick(rng, &positionals);
        } else if (r < 45) {
            buf[n] = pick(rng, &flags);
        } else if (r < 65) {
            buf[n] = pick(rng, &attached);
        } else if (r < 97 and n + 1 < want) {
            const opt = with_value[rng.uintLessThan(usize, with_value.len)];
            buf[n] = opt.name;
            n += 1;
            // one value in ten is drawn from the untyped pool, so it may not parse
            buf[n] = if (rng.uintLessThan(u32, 10) == 0) pick(rng, &values) else pick(rng, opt.vals);
        } else {
            buf[n] = "--";
            dashdash = true;
        }
        n += 1;
    }
    return buf[0..n];
}
