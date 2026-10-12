// The site's settings follow from the machine's size (docs/plans/SCALE-OUT.md, scripts/deploy/sizing.ts).
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentsCarried, applyOverrides, evalSlots, MEASURED, sizeFor, sizingEnv, thisMachine, vcpuPerAgent } from "./sizing.ts";

test("the 4 vCPU / 8 GB server gets what was set by hand before", () => {
  const s = sizeFor({ cores: 4, memory_mb: 7941 });
  expect(s.sandbox_slots).toBe(2); // UNITS_SANDBOX_SLOTS=2 in site.env
  expect(s.attempts).toBe(2); // max_concurrent_ceiling 2
  expect(s.replay_slots).toBe(1); // one replay at a time per verifier
  expect(s.max_open_replays).toBe(2); // config/network.json
  expect(s.cpu_shares).toBe(512);
});

test("vCPU per agent is the stated calculation from the measured inputs", () => {
  const v = vcpuPerAgent();
  expect(v.cycle_s).toBe(432 + 59 + 30);
  expect(v.authoring).toBeCloseTo(432 / 521, 10);
  expect(v.verification).toBeCloseTo(((31 / 36) * 2 * 1.1 * 483) / 521, 10);
  expect(+v.total.toFixed(2)).toBe(2.59);
});

test("16, 32 and 48 dedicated vCPUs (CPU-Optimized: 2 GiB per vCPU)", () => {
  const rows = [16, 32, 48].map((c) => sizeFor({ cores: c, memory_mb: c * 2048 }));
  expect(rows.map((s) => s.sandbox_slots)).toEqual([14, 28, 42]);
  expect(rows.map((s) => s.attempts)).toEqual([5, 10, 16]);
  expect(rows.map((s) => s.replay_slots)).toEqual([4, 9, 14]);
  expect(rows.map((s) => agentsCarried(s))).toEqual([5, 10, 16]);
  for (const s of rows) {
    // what the verifiers and the attempts can hold at once never exceeds much more than the slots
    expect(s.replay_slots * s.verifiers).toBeLessThanOrEqual(s.sandbox_slots);
    expect(s.max_open_replays).toBeGreaterThanOrEqual(s.replay_slots);
  }
});

test("settings never shrink as the machine grows", () => {
  let prev = sizeFor({ cores: 1, memory_mb: 2048 });
  for (let c = 2; c <= 96; c++) {
    const s = sizeFor({ cores: c, memory_mb: c * 2048 });
    expect(s.sandbox_slots).toBeGreaterThanOrEqual(prev.sandbox_slots);
    expect(s.attempts).toBeGreaterThanOrEqual(prev.attempts);
    expect(s.replay_slots).toBeGreaterThanOrEqual(prev.replay_slots);
    expect(s.sandbox_slots).toBeLessThan(Math.max(2, c));
    prev = s;
  }
});

test("memory bounds the slots at the recipes' limit", () => {
  expect(sizeFor({ cores: 48, memory_mb: 16384 }).sandbox_slots).toBe(Math.floor((16384 - 2048) / MEASURED.sandbox_limit_mb));
});

test("roles: a verifier host only replays, a shard only authors", () => {
  const v = sizeFor({ cores: 32, memory_mb: 65536, role: "verifier" });
  expect(v.attempts).toBe(0);
  expect(v.replay_slots).toBe(v.sandbox_slots);
  expect(v.sandbox_slots).toBe(30);
  const sh = sizeFor({ cores: 32, memory_mb: 65536, role: "shard" });
  expect(sh.replay_slots).toBe(0);
  expect(sh.attempts).toBe(Math.floor(30 / vcpuPerAgent().authoring));
});

test("a capacity host that does both: its verifier takes the verification share, evaluations the rest", () => {
  for (const c of [16, 32, 48]) {
    const b = sizeFor({ cores: c, memory_mb: c * 2048, role: "both" });
    expect(b.replay_slots + evalSlots(b)).toBe(b.sandbox_slots);
    expect(evalSlots(b)).toBeGreaterThanOrEqual(1);
  }
  const b = sizeFor({ cores: 32, memory_mb: 65536, role: "both" });
  expect([b.sandbox_slots, b.replay_slots, evalSlots(b)]).toEqual([30, 20, 10]);
  expect(evalSlots(sizeFor({ cores: 32, memory_mb: 65536, role: "verifier" }))).toBe(0);
  expect(evalSlots(sizeFor({ cores: 32, memory_mb: 65536, role: "shard" }))).toBe(30);
  expect(sizingEnv(b)).toContain("UNITS_EVAL_SLOTS=10\n");
  expect(sizingEnv(sizeFor({ cores: 48, memory_mb: 98304 }))).not.toContain("UNITS_EVAL_SLOTS");
});

test("overrides: applied, refused when unknown or out of range, max_open_replays follows replay_slots", () => {
  const s = sizeFor({ cores: 48, memory_mb: 98304 });
  expect(applyOverrides(s, { attempts: 50, _note: "owner 2026-10-12" }).attempts).toBe(50);
  expect(applyOverrides(s, { replay_slots: 20 }).max_open_replays).toBe(20);
  expect(applyOverrides(s, undefined)).toEqual(s);
  expect(() => applyOverrides(s, { attemps: 50 })).toThrow(/unknown key/);
  expect(() => applyOverrides(s, { attempts: 65 })).toThrow(/1 to 64/);
  expect(() => applyOverrides(s, { sandbox_slots: 0 })).toThrow();
  expect(() => applyOverrides(s, [])).toThrow();
});

test("sizing.env and the stand-in machine", () => {
  const env = sizingEnv(sizeFor({ cores: 48, memory_mb: 98304 }));
  expect(env).toContain("UNITS_SANDBOX_SLOTS=42\n");
  expect(env).toContain("UNITS_REPLAY_SLOTS=14\n");
  expect(env).toContain("UNITS_SANDBOX_CPU_SHARES=512\n");
  expect(sizingEnv(sizeFor({ cores: 32, memory_mb: 65536, role: "shard" }))).toContain("UNITS_REPLAY_SLOTS=1\n");
  expect(thisMachine({ UNITS_SIZE_CORES: "48", UNITS_SIZE_MEMORY_MB: "98304" })).toEqual({ cores: 48, memory_mb: 98304 });
  expect(thisMachine({}).cores).toBeGreaterThanOrEqual(1);
});

// site-config.ts end to end: the files a deploy writes on a 4 vCPU and on a 48 vCPU machine
function siteConfig(cores: number, memMb: number, over?: object) {
  const dir = mkdtempSync(join(tmpdir(), "sizing-site-"));
  const etc = join(dir, "etc");
  mkdirSync(etc, { recursive: true });
  if (over) writeFileSync(join(etc, "sizing.json"), JSON.stringify(over));
  const state = join(dir, "devnet.json");
  writeFileSync(state, JSON.stringify({ registry_program: "11111111111111111111111111111111", launch_program: "11111111111111111111111111111111", line_mint: "11111111111111111111111111111111", runtime_authority: "11111111111111111111111111111111" }));
  writeFileSync(join(dir, "caps.json"), JSON.stringify({ arch: "amd64", cpus: cores, memory_mb: memMb, gpus: [] }));
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "site-config.ts"), "--out", dir], {
    env: { ...process.env, UNITS_INSTANCE: "", UNITS_INSTANCE_STATE: state, UNITS_SIZE_CORES: String(cores), UNITS_SIZE_MEMORY_MB: String(memMb), UNITS_SIZING_FILE: join(etc, "sizing.json"), HOME: dir, UNITS_NETWORK: "devnet" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = p.stdout.toString() + p.stderr.toString();
  const read = (f: string) => readFileSync(join(dir, f), "utf8");
  try {
    return { code: p.exitCode, out, env: p.exitCode === 0 ? read("sizing.env") : "", runtime: p.exitCode === 0 ? JSON.parse(read("runtime.json")) : null, net: p.exitCode === 0 ? JSON.parse(read("network.json")) : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("site-config on 4 vCPU: today's values", () => {
  const r = siteConfig(4, 7941);
  expect(r.out).toContain("sizing.env: 4 cores");
  expect(r.code).toBe(0);
  expect(r.env).toContain("UNITS_SANDBOX_SLOTS=2\n");
  expect(r.env).toContain("UNITS_REPLAY_SLOTS=1\n");
  expect(r.net.max_open_replays).toBe(2);
  expect([2, 3]).toContain(r.runtime.max_concurrent_ceiling); // 3, or 2 beside a second instance
});

test("site-config on 48 vCPU: derived, and the operator's sizing.json wins", () => {
  const r = siteConfig(48, 98304);
  expect(r.code).toBe(0);
  expect(r.env).toContain("UNITS_SANDBOX_SLOTS=42\n");
  expect(r.env).toContain("UNITS_REPLAY_SLOTS=14\n");
  expect(r.net.max_open_replays).toBe(14);
  expect(r.runtime.max_concurrent_ceiling).toBe(16);
  const o = siteConfig(48, 98304, { attempts: 50 });
  expect(o.code).toBe(0);
  expect(o.runtime.max_concurrent_ceiling).toBe(50);
  expect(o.env).toContain("UNITS_SANDBOX_SLOTS=42\n");
  const bad = siteConfig(48, 98304, { attempts: 500 });
  expect(bad.code).not.toBe(0);
});
