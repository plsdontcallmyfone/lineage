//! Lineage equivalence harness (protected). Prints, for seeded argument vectors, either the full
//! parse result or the error and the diagnostic text, then the help and usage renderings. The
//! sandbox digests stdout; a candidate must print exactly what its parent prints.
const std = @import("std");
const clap = @import("clap");
const gen = @import("lineage_gen.zig");

pub fn main() !void {
    var gpa_state = std.heap.DebugAllocator(.{}){};
    defer _ = gpa_state.deinit();
    const gpa = gpa_state.allocator();

    var out_buf: [64 * 1024]u8 = undefined;
    var fw = std.fs.File.stdout().writer(&out_buf);
    const out = &fw.interface;

    var prng = std.Random.DefaultPrng.init(gen.seedFromEnv());
    const rng = prng.random();
    var argv: [12][]const u8 = undefined;

    for (0..3000) |case| {
        const args = gen.nextArgs(rng, &argv);
        try out.print("case {d}:", .{case});
        for (args) |a| try out.print(" [{s}]", .{a});
        try out.writeAll("\n");
        var iter = clap.args.SliceIterator{ .args = args };
        var diag = clap.Diagnostic{};
        var res = clap.parseEx(clap.Help, &gen.params, gen.parsers, &iter, .{
            .allocator = gpa,
            .diagnostic = &diag,
            .assignment_separators = if (case % 3 == 0) "=:" else "=",
        }) catch |err| {
            try out.print("  error {s}: ", .{@errorName(err)});
            try diag.report(out, err);
            continue;
        };
        defer res.deinit();
        const a = res.args;
        try out.print("  help={d} verbose={d}", .{ a.help, a.verbose });
        if (a.number) |v| try out.print(" number={d}", .{v});
        for (a.int) |v| try out.print(" int={d}", .{v});
        if (a.float) |v| try out.print(" float={e}", .{v});
        if (a.mode) |v| try out.print(" mode={s}", .{@tagName(v)});
        for (a.string) |v| try out.print(" string=[{s}]", .{v});
        if (a.output) |v| try out.print(" output=[{s}]", .{v});
        for (res.positionals[0]) |v| try out.print(" pos=[{s}]", .{v});
        try out.writeAll("\n");
    }

    try out.writeAll("help default:\n");
    try clap.help(out, clap.Help, &gen.params, .{});
    try out.writeAll("help narrow:\n");
    try clap.help(out, clap.Help, &gen.params, .{ .max_width = 40, .description_on_new_line = false, .indent = 4, .spacing_between_parameters = 0 });
    try out.writeAll("help plain:\n");
    try clap.help(out, clap.Help, &gen.params, .{ .markdown_lite = false, .description_indent = 2 });
    try out.writeAll("usage:\n");
    try clap.usage(out, clap.Help, &gen.params);
    try out.writeAll("\n");
    try out.flush();
}
