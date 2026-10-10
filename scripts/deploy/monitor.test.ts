import { describe, expect, test } from "bun:test";
import { decide, evaluate, LIMITS, type Inputs } from "./monitor.ts";

const NOW = 1_800_000_000_000;
const healthy = (): Inputs => ({
  now: NOW,
  units: { "lineage-core.service": { enabled: true, active: "active" }, "lineage-backup.timer": { enabled: true, active: "active" }, "lineage-author@x.service": { enabled: false, active: "inactive" } },
  coreHealth: { ok: true },
  gateHealth: { ok: true },
  publicHealth: { ok: true },
  epochs: [
    { n: 5, status: "open", end_ms: NOW + 3600_000 },
    { n: 4, status: "closed", end_ms: NOW - 1000, closed_at: NOW - 1000 },
  ],
  chain: { mode: "devnet", core_signing: true, last_epoch: "4" },
  expectSigning: true,
  heartbeats: [{ agent_id: "V1", last_seen: NOW - 30_000 }, { agent_id: "V2", last_seen: NOW - 60_000 }],
  verifiers: [{ name: "verifier-v1", id: "V1" }, { name: "verifier-v2", id: "V2" }],
  spend: { window: { start: NOW - 3600_000, window_s: 86400, usd: 2 }, cap_usd: 10 },
  runtimeEnabled: true,
  souls: { enabled: true, daily_usd: 2, spent_today_usd: 0.2 },
  balances: [{ name: "core-authority", lamports: 1e9 }, { name: "owner", lamports: 1e9 }],
  faucet: { enabled: true, sol_lamports: "200000000", line_base_units: "96000000000", amount: "1000000000" },
  disk: [{ path: "/", freeBytes: 100 * 2 ** 30, totalBytes: 150 * 2 ** 30 }],
  newestBackupMs: NOW - 20 * 60_000,
  backupsExpected: true,
  secretsBackups: [{ part: "state", newestMs: NOW - 20 * 60_000 }, { part: "identity", newestMs: NOW - 20 * 60_000 }],
});
const level = (i: Inputs, id: string) => evaluate(i).find((c) => c.id === id)?.level;

describe("monitor evaluate", () => {
  test("a healthy site is all ok", () => {
    const c = evaluate(healthy());
    expect(c.filter((x) => x.level !== "ok")).toEqual([]);
    expect(c.map((x) => x.id)).toEqual(["units", "core", "gate", "public", "epochs", "verifiers", "spend", "souls", "balance:core-authority", "balance:owner", "faucet", "disk:/", "backup", "backup:state", "backup:identity"]);
  });
  test("an enabled unit that is not active fails; a disabled one is ignored", () => {
    const i = healthy();
    i.units["lineage-core.service"] = { enabled: true, active: "failed" };
    const c = evaluate(i).find((x) => x.id === "units")!;
    expect(c.level).toBe("fail");
    expect(c.msg).toContain("lineage-core.service (failed)");
    expect(c.msg).not.toContain("author");
  });
  test("Core down fails", () => {
    const i = healthy();
    i.coreHealth = { ok: false, err: "ECONNREFUSED" };
    expect(level(i, "core")).toBe("fail");
  });
  test("an epoch past its end by more than an hour fails", () => {
    const i = healthy();
    i.epochs![0]!.end_ms = NOW - LIMITS.epochOverdueMs - 1;
    expect(level(i, "epochs")).toBe("fail");
  });
  test("a closed epoch not on chain fails only after the grace", () => {
    const i = healthy();
    i.chain!.last_epoch = "3";
    expect(level(i, "epochs")).toBe("ok");
    i.epochs![1]!.closed_at = NOW - LIMITS.epochPostGraceMs - 1;
    expect(level(i, "epochs")).toBe("fail");
  });
  test("Core without its authority key fails when signing is expected", () => {
    const i = healthy();
    i.chain!.core_signing = false;
    expect(level(i, "epochs")).toBe("fail");
    i.expectSigning = false;
    expect(level(i, "epochs")).toBe("ok");
  });
  test("a verifier silent for 10 minutes or never seen fails", () => {
    const i = healthy();
    i.heartbeats![1]!.last_seen = NOW - LIMITS.heartbeatStaleMs - 1;
    expect(level(i, "verifiers")).toBe("fail");
    i.heartbeats = [i.heartbeats![0]!];
    expect(evaluate(i).find((c) => c.id === "verifiers")!.msg).toContain("verifier-v2 (never)");
  });
  test("runtime spend warns at 80% of the cap and says when the cap is reached; an expired window counts 0", () => {
    const i = healthy();
    i.spend!.window!.usd = 8;
    expect(level(i, "spend")).toBe("warn");
    i.spend!.window!.usd = 10;
    expect(evaluate(i).find((c) => c.id === "spend")!.msg).toContain("cap reached");
    i.spend!.window!.start = NOW - 86400_000 - 1;
    expect(level(i, "spend")).toBe("ok");
  });
  test("Core authority balance warns under 0.05 SOL and fails under 0.01", () => {
    const i = healthy();
    i.balances[0]!.lamports = 0.04e9;
    expect(level(i, "balance:core-authority")).toBe("warn");
    i.balances[0]!.lamports = 0.009e9;
    expect(level(i, "balance:core-authority")).toBe("fail");
  });
  test("faucet warns with fewer than 10 drips left", () => {
    const i = healthy();
    i.faucet!.line_base_units = "9000000000";
    expect(level(i, "faucet")).toBe("warn");
  });
  test("disk warns under 20% free and fails under 10% or 5 GiB", () => {
    const i = healthy();
    i.disk[0]!.freeBytes = 25 * 2 ** 30;
    expect(level(i, "disk:/")).toBe("warn");
    i.disk[0]!.freeBytes = 14 * 2 ** 30;
    expect(level(i, "disk:/")).toBe("fail");
    i.disk = [{ path: "/", freeBytes: 4 * 2 ** 30, totalBytes: 8 * 2 ** 30 }];
    expect(level(i, "disk:/")).toBe("fail");
  });
  test("no snapshot, or one older than 2 hours, fails", () => {
    const i = healthy();
    i.newestBackupMs = NOW - LIMITS.backupStaleMs - 1;
    expect(level(i, "backup")).toBe("fail");
    i.newestBackupMs = null;
    expect(level(i, "backup")).toBe("fail");
  });
  test("secrets+state snapshots: each part checked for age; no recipient warns", () => {
    const i = healthy();
    i.secretsBackups![0]!.newestMs = NOW - LIMITS.backupStaleMs - 1;
    expect(level(i, "backup:state")).toBe("fail");
    expect(level(i, "backup:identity")).toBe("ok");
    i.secretsBackups![1]!.newestMs = null;
    expect(level(i, "backup:identity")).toBe("fail");
    i.secretsBackups = null;
    expect(level(i, "backup:secrets")).toBe("warn");
    expect(level(i, "backup:state")).toBeUndefined();
  });
});

describe("monitor decide", () => {
  const ok = { id: "core", level: "ok" as const, msg: "" };
  const fail = { id: "core", level: "fail" as const, msg: "down" };
  test("first run announces only problems", () => {
    expect(decide({}, [ok], NOW).send).toEqual([]);
    expect(decide({}, [fail], NOW).send).toEqual([fail]);
  });
  test("a transition is sent once, a recovery is marked, a fail repeats every 6 hours", () => {
    let s = decide({}, [ok], NOW).next;
    const r1 = decide(s, [fail], NOW + 1);
    expect(r1.send).toEqual([fail]);
    s = r1.next;
    expect(decide(s, [fail], NOW + 2).send).toEqual([]);
    const r2 = decide(s, [fail], NOW + 1 + LIMITS.repeatMs);
    expect(r2.send).toEqual([fail]);
    const r3 = decide(r2.next, [ok], NOW + 2 + LIMITS.repeatMs);
    expect(r3.send).toEqual([{ ...ok, recovered: true }]);
  });
  test("a warn does not repeat", () => {
    const warn = { id: "spend", level: "warn" as const, msg: "" };
    const s = decide({}, [warn], NOW).next;
    expect(decide(s, [warn], NOW + LIMITS.repeatMs * 2).send).toEqual([]);
  });
});
