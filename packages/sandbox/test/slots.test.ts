import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSandboxSlot, dockerArgs, sandboxCpuShares, sandboxSlots } from "../src/docker.ts";

// Sandbox slots (server load, 2026-10-12): at most UNITS_SANDBOX_SLOTS sandbox containers at once on a
// host, across processes, by lock files; and the optional CPU weight of sandbox containers.

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "units-slots-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  delete process.env.UNITS_SANDBOX_CPU_SHARES;
});

test("settings: unset means no limit; bad values are refused", () => {
  expect(sandboxSlots({})).toBeNull();
  expect(sandboxSlots({ UNITS_SANDBOX_SLOTS: "0" })).toBeNull();
  expect(sandboxSlots({ UNITS_SANDBOX_SLOTS: "2" })).toEqual({ n: 2, dir: "/tmp/units-sandbox-slots" });
  expect(sandboxSlots({ UNITS_SANDBOX_SLOTS: "3", UNITS_SANDBOX_SLOTS_DIR: "/run/x" })).toEqual({ n: 3, dir: "/run/x" });
  expect(() => sandboxSlots({ UNITS_SANDBOX_SLOTS: "two" })).toThrow(/UNITS_SANDBOX_SLOTS/);
  expect(sandboxCpuShares({})).toBeNull();
  expect(sandboxCpuShares({ UNITS_SANDBOX_CPU_SHARES: "256" })).toBe(256);
  expect(() => sandboxCpuShares({ UNITS_SANDBOX_CPU_SHARES: "1" })).toThrow(/UNITS_SANDBOX_CPU_SHARES/);
});

test("no more holders than slots: the third waits until one is released", async () => {
  const slots = { n: 2, dir: join(tmp(), "slots") };
  const a = await acquireSandboxSlot(slots, { pollMs: 10 });
  const b = await acquireSandboxSlot(slots, { pollMs: 10 });
  expect(readdirSync(slots.dir).sort()).toEqual(["slot-0", "slot-1"]);
  let got = false;
  const third = acquireSandboxSlot(slots, { pollMs: 10 }).then((r) => ((got = true), r));
  await Bun.sleep(80);
  expect(got).toBe(false);
  a();
  const c = await third;
  expect(got).toBe(true);
  a(); // releasing twice does not free the slot its next holder took
  expect(readdirSync(slots.dir).sort()).toEqual(["slot-0", "slot-1"]);
  b();
  c();
  expect(readdirSync(slots.dir)).toEqual([]);
});

test("running holders never exceed the limit under contention", async () => {
  const slots = { n: 2, dir: join(tmp(), "slots") };
  let now = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 9 }, async () => {
      const release = await acquireSandboxSlot(slots, { pollMs: 5 });
      peak = Math.max(peak, ++now);
      await Bun.sleep(15);
      now--;
      release();
    }),
  );
  expect(peak).toBe(2);
});

test("a slot whose owner is gone (a process killed in mid-run) is taken over; a live owner's is not", async () => {
  const slots = { n: 1, dir: join(tmp(), "slots") };
  (await acquireSandboxSlot(slots))();
  writeFileSync(join(slots.dir, "slot-0"), "4242\n");
  const dead = await acquireSandboxSlot(slots, { pollMs: 10, alive: (pid) => pid !== 4242 });
  expect(existsSync(join(slots.dir, "slot-0"))).toBe(true);
  dead();
  writeFileSync(join(slots.dir, "slot-0"), "4242\n");
  let got = false;
  void acquireSandboxSlot(slots, { pollMs: 10, alive: () => true }).then((r) => ((got = true), r()));
  await Bun.sleep(60);
  expect(got).toBe(false);
  rmSync(join(slots.dir, "slot-0"));
  await Bun.sleep(60);
  expect(got).toBe(true);
});

test("the CPU weight reaches docker run only when set", () => {
  const spec = { image: "i", cmd: "true", cwd: "/w", mounts: [], env: {}, limits: { cpus: 2, memory_mb: 256, pids: 64, wall_s: 10, disk_mb: 64 }, timeout_s: 10, job: "t", network: false } as never;
  expect(dockerArgs(spec, "n")).not.toContain("--cpu-shares");
  process.env.UNITS_SANDBOX_CPU_SHARES = "256";
  const args = dockerArgs(spec, "n");
  expect(args[args.indexOf("--cpu-shares") + 1]).toBe("256");
});
