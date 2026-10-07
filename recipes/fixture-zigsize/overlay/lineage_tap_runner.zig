//! Lineage test runner (harness, protected). Runs every test the root module references, like
//! Zig's default runner, but reports TAP on stdout so each test has a stable id
//! (`ok N - <fully qualified test name>`). Test output and stack traces stay on stderr.
//!
//! Differences from the default runner, all toward strictness and determinism:
//! - a test that leaks memory through std.testing.allocator is reported `not ok` (the default
//!   runner reports it OK and fails the whole run);
//! - a test that logs at error level is reported `not ok` (same);
//! - std.testing.random_seed is fixed, so seeded tests see the same inputs on every replay.
const std = @import("std");
const builtin = @import("builtin");
const testing = std.testing;

pub const std_options: std.Options = .{ .logFn = log };

var log_err_count: usize = 0;

fn log(
    comptime level: std.log.Level,
    comptime scope: @Type(.enum_literal),
    comptime format: []const u8,
    args: anytype,
) void {
    if (@intFromEnum(level) <= @intFromEnum(std.log.Level.err)) log_err_count += 1;
    if (@intFromEnum(level) <= @intFromEnum(testing.log_level)) {
        std.debug.print("[" ++ @tagName(scope) ++ "] (" ++ @tagName(level) ++ "): " ++ format ++ "\n", args);
    }
}

pub fn main() void {
    var buf: [4096]u8 = undefined;
    var w = std.fs.File.stdout().writer(&buf);
    const out = &w.interface;
    const tests = builtin.test_functions;
    testing.random_seed = 0x6c696e65;
    out.print("TAP version 13\n1..{d}\n", .{tests.len}) catch {};
    out.flush() catch {};
    var failed: usize = 0;
    for (tests, 1..) |t, n| {
        testing.allocator_instance = .{};
        testing.log_level = .warn;
        log_err_count = 0;
        std.debug.print("# {d} {s}\n", .{ n, t.name });
        const res = t.func();
        const leaked = testing.allocator_instance.deinit() == .leak;
        if (res) |_| {
            if (leaked or log_err_count != 0) {
                failed += 1;
                out.print("not ok {d} - {s}\n", .{ n, t.name }) catch {};
            } else {
                out.print("ok {d} - {s}\n", .{ n, t.name }) catch {};
            }
        } else |err| switch (err) {
            error.SkipZigTest => out.print("ok {d} - {s} # SKIP\n", .{ n, t.name }) catch {},
            else => {
                failed += 1;
                out.print("not ok {d} - {s}\n", .{ n, t.name }) catch {};
                std.debug.print("FAIL {s}: {s}\n", .{ t.name, @errorName(err) });
                if (@errorReturnTrace()) |trace| std.debug.dumpStackTrace(trace.*);
            },
        }
        out.flush() catch {};
    }
    std.process.exit(if (failed == 0) 0 else 1);
}
