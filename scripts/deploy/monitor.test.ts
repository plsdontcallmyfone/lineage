import { describe, expect, test } from "bun:test";
import { decide, epochLengthMs, epochLimits, evaluate, LIMITS, mergeWaiting, parseMore, type Inputs, type MoreCore } from "./monitor.ts";

const NOW = 1_800_000_000_000;
const healthy = (): Inputs => ({
  now: NOW,
  units: { "units-core.service": { enabled: true, active: "active" }, "units-backup.timer": { enabled: true, active: "active" }, "units-author@x.service": { enabled: false, active: "inactive" } },
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
    i.units["units-core.service"] = { enabled: true, active: "failed" };
    const c = evaluate(i).find((x) => x.id === "units")!;
    expect(c.level).toBe("fail");
    expect(c.msg).toContain("units-core.service (failed)");
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

// A bound, funded agent that cannot get a desktop shows only a waiting screen: after 5 minutes it is a failing check
// (the mainnet instance's first agent waited 16 minutes on "E2B: day cap reached (0.0000 of 0 USD)" unnoticed).
describe("agents waiting for a desktop", () => {
  const row = (min: number, waiting = "waiting for a desktop: E2B: day cap reached (0.0000 of 0 USD)", reportedAgoMs = 30_000) => ({ agent: "FScgU8v8PtabhWzCxhX1iQEs7JyMP34MV4UWH2gpZrKG", waiting, waiting_since: NOW - min * 60_000, reported_at: NOW - reportedAgoMs });
  const check = (i: Inputs) => evaluate(i).find((c) => c.id === "desktops");
  test("over 5 minutes fails and names the agent, how long and why", () => {
    const c = check({ ...healthy(), waiting: { agents: [row(16)] } })!;
    expect(c.level).toBe("fail");
    expect(c.msg).toBe("1 funded agent has waited for a desktop over 5 min: FScgU8v8 for 16 min (E2B: day cap reached (0.0000 of 0 USD))");
    expect(decide({}, evaluate({ ...healthy(), waiting: { agents: [row(16)] } }), NOW).send.map((c) => c.id)).toContain("desktops");
  });
  test("under 5 minutes, other waits (an empty vault), a stale report and a runtime that reports no start time do not fail", () => {
    expect(check({ ...healthy(), waiting: { agents: [row(4)] } })).toMatchObject({ level: "ok", msg: "1 agent waiting for a desktop, none over 5 min" });
    expect(check({ ...healthy(), waiting: { agents: [row(60, "asleep (vault below the wake threshold)")] } })).toMatchObject({ level: "ok", msg: "no agent is waiting for a desktop" });
    expect(check({ ...healthy(), waiting: { agents: [row(60, undefined, 20 * 60_000)] } })!.level).toBe("ok");
    expect(check({ ...healthy(), waiting: { agents: [{ ...row(60), waiting_since: null }] } })!.level).toBe("ok");
    expect(check({ ...healthy(), waiting: { agents: [] } })!.level).toBe("ok");
  });
  test("no runtime on the instance, or the list not read: no check at all", () => {
    expect(check({ ...healthy(), runtimeEnabled: false, waiting: { agents: [row(16)] } })).toBeUndefined();
    expect(check({ ...healthy(), waiting: null })).toBeUndefined();
    expect(check(healthy())).toBeUndefined();
  });
  test("the waiting lists of the other instances on the server (MONITOR_WAITING_CORES) join the check", () => {
    const merged = mergeWaiting([{ agents: [] }, null, { agents: [row(16)] }]);
    expect(merged!.agents).toHaveLength(1);
    expect(check({ ...healthy(), waiting: merged })!.level).toBe("fail");
    expect(mergeWaiting([null, undefined])).toBeNull();
  });
});

// Epoch thresholds follow the monitored Core's own epoch length; a daily epoch keeps the limits it always had.
describe("epoch thresholds from the epoch length", () => {
  const DAY = 86_400_000, MIN = 60_000;
  const withLength = (lengthMs: number, pastEndMs: number, unpostedMs: number): Inputs => {
    const i = healthy();
    i.epochs = [
      { n: 5, status: "open", start_ms: NOW - pastEndMs - lengthMs, end_ms: NOW - pastEndMs },
      { n: 4, status: "closed", start_ms: NOW - pastEndMs - 2 * lengthMs, end_ms: NOW - pastEndMs - lengthMs, closed_at: NOW - unpostedMs },
    ];
    i.chain!.last_epoch = "3";
    return i;
  };
  test("the length is the open epoch's end minus its start; rows without start_ms give none", () => {
    expect(epochLengthMs(withLength(900_000, 0, 0).epochs)).toBe(900_000);
    expect(epochLengthMs(healthy().epochs)).toBeNull();
    expect(epochLengthMs(null)).toBeNull();
  });
  test("a daily epoch (the devnet instance) keeps exactly the limits it had: 60 minutes overdue, 2 hours unposted", () => {
    expect(epochLimits(DAY)).toEqual({ overdueMs: LIMITS.epochOverdueMs, postGraceMs: LIMITS.epochPostGraceMs });
    expect(epochLimits(null)).toEqual({ overdueMs: 60 * MIN, postGraceMs: 120 * MIN });
    expect(level(withLength(DAY, 60 * MIN, 0), "epochs")).toBe("ok");
    expect(level(withLength(DAY, 60 * MIN + 1, 0), "epochs")).toBe("fail");
    expect(level(withLength(DAY, 0, 120 * MIN), "epochs")).toBe("ok");
    expect(level(withLength(DAY, 0, 120 * MIN + 1), "epochs")).toBe("fail");
    // and the messages are the ones it always wrote
    expect(evaluate(withLength(DAY, 61 * MIN, 0)).find((c) => c.id === "epochs")!.msg).toBe("epoch 5 should have closed 61 min ago");
    expect(evaluate(withLength(DAY, -30 * MIN, 121 * MIN)).find((c) => c.id === "epochs")!.msg).toBe("epoch 4 closed 121 min ago, chain has up to 3");
  });
  test("a 900 s epoch: overdue past 2 epochs (30 min), unposted past 4 epochs (60 min)", () => {
    expect(epochLimits(900_000)).toEqual({ overdueMs: 30 * MIN, postGraceMs: 60 * MIN });
    expect(level(withLength(900_000, 30 * MIN, 0), "epochs")).toBe("ok");
    expect(level(withLength(900_000, 30 * MIN + 1, 0), "epochs")).toBe("fail");
    expect(level(withLength(900_000, 0, 60 * MIN), "epochs")).toBe("ok");
    expect(level(withLength(900_000, 0, 60 * MIN + 1), "epochs")).toBe("fail");
  });
  test("a very short epoch never goes under 10 minutes overdue and 20 minutes unposted", () => {
    expect(epochLimits(60_000)).toEqual({ overdueMs: 10 * MIN, postGraceMs: 20 * MIN });
  });
});

// The mainnet instance has no monitor of its own: MONITOR_MORE adds its Core to this one.
describe("an additional monitored Core (MONITOR_MORE)", () => {
  const CA = "AYsa2Pn2pzH5SeknsA8TZc3ndA9V3oNpau5oFex4yVtu", RT = "CCt4EoNuYhVbk4cXUXBzMLQBfshfPF1f5rLyw22S2uXs";
  const PER_DAY = 1_493_440 * 96; // one epoch post, 96 posts a day at 900 s
  const mainnet = (): MoreCore => ({
    name: "mainnet",
    coreHealth: { ok: true },
    epochs: [
      { n: 41, status: "open", start_ms: NOW - 300_000, end_ms: NOW + 600_000 },
      { n: 40, status: "closed", start_ms: NOW - 1_200_000, end_ms: NOW - 300_000, closed_at: NOW - 300_000 },
    ],
    chain: { mode: "mainnet", core_signing: true, last_epoch: "40" },
    expectSigning: true,
    balances: [{ name: "core-authority", lamports: 1e9 }, { name: "runtime-authority", lamports: 1e9 }],
  });
  const run = (m: MoreCore) => evaluate({ ...healthy(), more: [m] });
  const get = (m: MoreCore, id: string) => run(m).find((c) => c.id === id)!;

  test("the entry is parsed; the RPC is named by its variable, never given as a URL", () => {
    const [m] = parseMore(`name=mainnet,core=http://127.0.0.1:9760/,rpc_env=UNITS_MAINNET_RPC,core_authority=${CA},runtime_authority=${RT},signing=1`);
    expect(m).toEqual({ name: "mainnet", core: "http://127.0.0.1:9760", rpcEnv: "UNITS_MAINNET_RPC", signing: true, keys: [{ name: "core-authority", id: CA }, { name: "runtime-authority", id: RT }] });
    expect(parseMore(undefined)).toEqual([]);
    expect(parseMore("name=x,core=notaurl")).toEqual([]);
    expect(parseMore(`name=a,core=http://h:1;name=b,core=http://h:2,rpc_env=https://secret.example/key,core_authority=bad`)).toEqual([
      { name: "a", core: "http://h:1", rpcEnv: null, signing: false, keys: [] },
      { name: "b", core: "http://h:2", rpcEnv: null, signing: false, keys: [] },
    ]);
  });
  test("healthy: its checks follow the first instance's, all ok, with their texts", () => {
    const c = run(mainnet());
    expect(c.filter((x) => x.level !== "ok")).toEqual([]);
    expect(c.slice(-4)).toEqual([
      { id: "core:mainnet", level: "ok", msg: "mainnet Core /v1/health ok" },
      { id: "epochs:mainnet", level: "ok", msg: "mainnet: open epoch 41 ends in 10 min; last closed 40, on chain 40" },
      { id: "balance:mainnet:core-authority", level: "ok", msg: "mainnet core-authority 1.0000 SOL, 0.1434 SOL a day (96 epoch posts), 7.0 days left" },
      { id: "balance:mainnet:runtime-authority", level: "ok", msg: "mainnet runtime-authority 1.0000 SOL (warn under 0.0500 SOL, fail under 0.0100 SOL: no measured cost of a usage post)" },
    ]);
    // the first instance's checks are untouched
    expect(c.slice(0, -4)).toEqual(evaluate(healthy()));
  });
  test("its Core down fails, and so do its epochs (not readable)", () => {
    const m = { ...mainnet(), coreHealth: { ok: false, err: "ECONNREFUSED" }, epochs: null, chain: null };
    expect(get(m, "core:mainnet")).toEqual({ id: "core:mainnet", level: "fail", msg: "mainnet Core /v1/health: ECONNREFUSED" });
    expect(get(m, "epochs:mainnet")).toEqual({ id: "epochs:mainnet", level: "fail", msg: "mainnet: could not read /v1/epochs or /v1/chain" });
  });
  test("its epoch thresholds are its own: 31 minutes past the end fails at 900 s; 61 minutes unposted fails", () => {
    const m = mainnet();
    m.epochs = [{ n: 41, status: "open", start_ms: NOW - 31 * 60_000 - 900_000, end_ms: NOW - 31 * 60_000 }, { ...m.epochs![1]!, closed_at: NOW - 61 * 60_000 }];
    m.chain!.last_epoch = "39";
    expect(get(m, "epochs:mainnet")).toEqual({ id: "epochs:mainnet", level: "fail", msg: "mainnet: epoch 41 should have closed 31 min ago; epoch 40 closed 61 min ago, chain has up to 39" });
    // the first instance, read at the same moment with its daily epoch, is not affected
    expect(level({ ...healthy(), more: [m] }, "epochs")).toBe("ok");
  });
  test("the Core authority is measured in days of posts: warn under 3 days, fail under 1", () => {
    const at = (lamports: number) => get({ ...mainnet(), balances: [{ name: "core-authority", lamports }] }, "balance:mainnet:core-authority");
    expect(PER_DAY).toBe(143_370_240);
    expect(at(3 * PER_DAY).level).toBe("ok");
    expect(at(3 * PER_DAY - 1).level).toBe("warn");
    expect(at(PER_DAY).level).toBe("warn");
    expect(at(PER_DAY - 1).level).toBe("fail");
    expect(at(200_000_000).msg).toBe("mainnet core-authority 0.2000 SOL, 0.1434 SOL a day (96 epoch posts), 1.4 days left");
    expect(at(100_000_000)).toEqual({ id: "balance:mainnet:core-authority", level: "fail", msg: "mainnet core-authority 0.1000 SOL, 0.1434 SOL a day (96 epoch posts), 0.7 days left" });
  });
  test("the runtime authority keeps absolute thresholds (no measured usage post cost); an unread balance warns", () => {
    const at = (lamports: number | null) => get({ ...mainnet(), balances: [{ name: "runtime-authority", lamports }] }, "balance:mainnet:runtime-authority");
    expect(at(0.05e9).level).toBe("ok");
    expect(at(0.04e9).level).toBe("warn");
    expect(at(0.009e9).level).toBe("fail");
    expect(at(null)).toEqual({ id: "balance:mainnet:runtime-authority", level: "warn", msg: "mainnet runtime-authority balance not readable" });
  });
  test("a Core authority whose epoch length was not read falls back to the absolute thresholds and says so", () => {
    const m = { ...mainnet(), epochs: null, chain: null, balances: [{ name: "core-authority", lamports: 0.04e9 }] };
    expect(get(m, "balance:mainnet:core-authority")).toEqual({ id: "balance:mainnet:core-authority", level: "warn", msg: "mainnet core-authority 0.0400 SOL (warn under 0.0500 SOL, fail under 0.0100 SOL: epoch length not read)" });
  });
  test("the first instance's Core authority check is unchanged (absolute)", () => {
    const i = { ...healthy(), more: [mainnet()] };
    i.balances[0]!.lamports = 0.04e9;
    expect(evaluate(i).find((c) => c.id === "balance:core-authority")).toEqual({ id: "balance:core-authority", level: "warn", msg: "core-authority 0.0400 SOL" });
  });
});
