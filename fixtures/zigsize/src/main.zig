//! zigsize CLI: prints the report for each file named on the command line, or for stdin.
const std = @import("std");
const zigsize = @import("zigsize");

pub fn main() !void {
    var gpa_state = std.heap.DebugAllocator(.{}){};
    defer _ = gpa_state.deinit();
    const gpa = gpa_state.allocator();

    var out_buf: [4096]u8 = undefined;
    var fw = std.fs.File.stdout().writer(&out_buf);
    const out = &fw.interface;

    const args = try std.process.argsAlloc(gpa);
    defer std.process.argsFree(gpa, args);

    if (args.len < 2) {
        var in_buf: [4096]u8 = undefined;
        var fr = std.fs.File.stdin().reader(&in_buf);
        const data = try fr.interface.allocRemaining(gpa, .limited(1 << 30));
        defer gpa.free(data);
        try zigsize.report(out, data);
    } else for (args[1..]) |path| {
        const data = try std.fs.cwd().readFileAlloc(gpa, path, 1 << 30);
        defer gpa.free(data);
        try out.print("== {s}\n", .{path});
        try zigsize.report(out, data);
    }
    try out.flush();
}
