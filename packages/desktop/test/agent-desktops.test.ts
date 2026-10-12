import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDesktops, type AgentDesktopLimits } from "../src/agent-desktops.ts";
import { streamIdOf } from "../src/agent-desktops.ts";
import { E2BBackend, e2bUsdPerS } from "../src/e2b.ts";
import { liveArgs, liveFilter, plainFilter } from "../src/layout.ts";
import { DesktopPool } from "../src/pool.ts";
import { desktopHandler } from "../src/serve.ts";
import { FakeE2B } from "./fake-e2b.ts";

// One E2B desktop per agent (owner decision 2026-10-12, agent-desktops.ts) against a fake E2B account:
// made once, found again after a restart, paused and resumed, renewed, refused at the limit and at the
// budget, removed when its agent is unbound, and never in the way of a launch.

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "units-agent-desk-"));
  dirs.push(d);
  return d;
};
const A = "A".repeat(44);
const B = "B".repeat(44);
const C = "C".repeat(44);
const T0 = Date.UTC(2026, 9, 12, 12);
const RATE = e2bUsdPerS(2, 4);
const awake = (...ids: string[]) => ids.map((agent) => ({ agent, working: false, asleep: false }));

function setup(o: { limits?: Partial<AgentDesktopLimits>; root?: string; e2b?: FakeE2B; clock?: { t: number }; owner?: string; key?: string | null } = {}) {
  const root = o.root ?? tmp();
  mkdirSync(join(root, "live"), { recursive: true });
  const clock = o.clock ?? { t: T0 };
  const e2b = o.e2b ?? new FakeE2B(() => clock.t);
  const logs: string[] = [];
  const spend = { usd: 0 };
  const limits: AgentDesktopLimits = { e2b_max: 100, desktop_usd_per_day: 1000, idle_s: 600, session_max_s: 86400, ...o.limits };
  const backend = new E2BBackend({ root, key: o.key === undefined ? "test-key" : o.key, template: "lineage-desktop", vcpu: 2, ram_gib: 4, api: e2b });
  const m = new AgentDesktops({ root, owner: o.owner ?? "test-owner", limits, allow: ["github.com"], backend, spentToday: () => spend.usd, addSpend: (u) => (spend.usd += u), log: (x) => logs.push(x), now: () => clock.t, timers: false });
  const tree = join(root, "tree");
  mkdirSync(tree, { recursive: true });
  writeFileSync(join(tree, "a.txt"), "x");
  const open = (agent: string) => m.open(agent, { tree, homeUrl: "about:blank", allow: ["github.com"], label: "t" });
  return { m, e2b, clock, logs, spend, limits, root, open };
}

describe("one desktop per agent", () => {
  test("created once in the background, named by the agent id, paused instead of killed at its timeout", async () => {
    const s = setup();
    await s.m.settle();
    s.m.sync(awake(A, B));
    // sync never waits: nothing exists yet when it returns
    expect(s.m.view(A)).toMatchObject({ state: "none", why: "not created yet" });
    expect(s.e2b.boxes.size).toBe(0);
    await s.m.settle();
    s.m.sync(awake(A, B));
    s.m.sync(awake(A, B));
    await s.m.settle();
    expect(s.e2b.count("create")).toBe(2);
    const a = s.e2b.ofAgent(A);
    expect(a).toHaveLength(1);
    expect(a[0]!.metadata).toEqual({ units_desktop: "agent", owner: "test-owner", agent: A });
    expect(a[0]!.onTimeout).toBe("pause");
    expect(a[0]!.provisioned).toBe(true);
    expect(a[0]!.cmds).toContain("<network locked>");
    expect(s.m.view(A)).toMatchObject({ state: "running", why: null });
    expect(s.m.counts()).toEqual({ running: 2, paused: 0, starting: 0, none: 0 });
  });

  test("a launch never waits on E2B and never fails because of it", async () => {
    const s = setup();
    await s.m.settle();
    let letGo!: () => void;
    s.e2b.gate = new Promise((r) => (letGo = r));
    const t = performance.now();
    s.m.sync(awake(A));
    expect(performance.now() - t).toBeLessThan(50);
    await Bun.sleep(2);
    expect(s.m.view(A)!.state).toBe("starting");
    s.e2b.failCreate = "E2B is down";
    letGo();
    await s.m.settle();
    // the agent has no desktop and the state says why; the next pass tries again after a wait
    expect(s.m.view(A)).toMatchObject({ state: "none", why: "create failed; next try in 30 s" });
    expect(s.logs.join("\n")).toContain("E2B is down");
    s.e2b.gate = null;
    s.e2b.failCreate = null;
    s.m.sync(awake(A));
    await s.m.settle();
    expect(s.e2b.count("create")).toBe(1);
    s.clock.t += 31_000;
    s.m.sync(awake(A));
    await s.m.settle();
    expect(s.m.view(A)!.state).toBe("running");
    expect(s.e2b.ofAgent(A)).toHaveLength(1);
  });

  test("found again after a restart by the record, and by the metadata alone; a second sandbox is killed; others are left alone", async () => {
    const s = setup();
    await s.m.settle();
    s.m.sync(awake(A, B));
    await s.m.settle();
    const ids = [s.m.sandboxOf(A), s.m.sandboxOf(B)];
    // sandboxes that are not ours: a live site's per-attempt desktop and another runtime's agent desktop
    await s.e2b.create("lineage-desktop", { timeoutMs: 3_600_000, metadata: { lineage: "1", attempt: "x" } });
    await s.e2b.create("lineage-desktop", { timeoutMs: 3_600_000, metadata: { units_desktop: "agent", owner: "someone-else", agent: A } });
    s.m.stop();

    // restart with the record
    const s2 = setup({ root: s.root, e2b: s.e2b, clock: s.clock });
    await s2.m.settle();
    s2.m.sync(awake(A, B));
    await s2.m.settle();
    expect([s2.m.sandboxOf(A), s2.m.sandboxOf(B)]).toEqual(ids);
    expect(s2.e2b.count("create")).toBe(4);

    // restart without it (state lost), with a stray second sandbox for A made later
    rmSync(join(s.root, "agent-desktops.json"));
    s.clock.t += 1000;
    await s.e2b.create("lineage-desktop", { timeoutMs: 900_000, metadata: { units_desktop: "agent", owner: "test-owner", agent: A } });
    const s3 = setup({ root: s.root, e2b: s.e2b, clock: s.clock });
    await s3.m.settle();
    s3.m.sync(awake(A, B));
    await s3.m.settle();
    expect([s3.m.sandboxOf(A), s3.m.sandboxOf(B)]).toEqual(ids);
    expect(s.e2b.ofAgent(A).filter((b) => b.metadata.owner === "test-owner")).toHaveLength(1);
    expect(s.e2b.count("create")).toBe(5);
    // the two that are not ours are still there
    expect([...s.e2b.boxes.values()].filter((b) => b.metadata.lineage === "1" || b.metadata.owner === "someone-else")).toHaveLength(2);
  });

  test("nothing is created before the account's list was read", async () => {
    const e2b = new FakeE2B(() => T0);
    const list = e2b.list.bind(e2b);
    let fail = true;
    e2b.list = async (m) => {
      if (fail) throw new Error("503");
      return list(m);
    };
    const s = setup({ e2b });
    await s.m.settle();
    s.m.sync(awake(A));
    await s.m.settle();
    expect(e2b.count("create")).toBe(0);
    expect(s.m.ready(A)).toContain("E2B list not read");
    fail = false;
    s.clock.t += 61_000;
    s.m.sync(awake(A));
    await s.m.settle();
    s.m.sync(awake(A));
    await s.m.settle();
    expect(s.m.view(A)!.state).toBe("running");
  });
});

describe("pause and resume", () => {
  test("paused after the idle time, resumed for the next attempt; only running time is spent", async () => {
    const s = setup();
    await s.m.settle();
    s.m.sync(awake(A));
    await s.m.settle();
    s.clock.t += 599_000;
    s.m.sync(awake(A));
    await s.m.settle();
    expect(s.m.view(A)!.state).toBe("running");
    s.clock.t += 2_000;
    s.m.sync(awake(A));
    await s.m.settle();
    expect(s.m.view(A)).toMatchObject({ state: "paused", why: "agent idle" });
    expect(s.e2b.running()).toBe(0);
    expect(s.spend.usd).toBeCloseTo(RATE * 601, 6);
    // an hour paused costs nothing
    s.clock.t += 3_600_000;
    s.m.sync(awake(A));
    await s.m.settle();
    expect(s.spend.usd).toBeCloseTo(RATE * 601, 6);
    // the next attempt: its desktop first
    expect(s.m.ready(A)).toBeNull();
    const id = s.m.sandboxOf(A);
    const inst = await s.open(A);
    expect(inst).not.toBeNull();
    expect(s.m.sandboxOf(A)).toBe(id);
    expect(s.m.view(A)!.state).toBe("running");
    expect(s.e2b.count("create")).toBe(1);
    // in an attempt it is never paused, however long
    for (let i = 0; i < 4; i++) {
      s.clock.t += 300_000;
      s.m.sync([{ agent: A, working: true, asleep: false }]);
      await s.m.settle();
    }
    expect(s.m.view(A)!.state).toBe("running");
    await inst!.destroy();
    // the session ended, the sandbox stays; idle counts from the attempt's end
    expect(s.e2b.ofAgent(A)).toHaveLength(1);
    s.clock.t += 300_000;
    s.m.sync(awake(A));
    await s.m.settle();
    expect(s.m.view(A)!.state).toBe("running");
    s.clock.t += 301_000;
    s.m.sync(awake(A));
    await s.m.settle();
    expect(s.m.view(A)!.state).toBe("paused");
    expect(s.spend.usd).toBeCloseTo(RATE * (601 + 1200 + 601), 6);
  });

  test("an asleep agent's desktop is paused at once", async () => {
    const s = setup();
    await s.m.settle();
    s.m.sync(awake(A));
    await s.m.settle();
    s.m.sync([{ agent: A, working: false, asleep: true }]);
    await s.m.settle();
    expect(s.m.view(A)).toMatchObject({ state: "paused", why: "agent asleep (vault empty)" });
  });

  test("each attempt gets the same sandbox with its tiles reset and the new tree; the windows stay; a desktop without its windows gets a fresh session", async () => {
    const s = setup();
    await s.m.settle();
    s.m.sync(awake(A));
    await s.m.settle();
    const box = s.e2b.ofAgent(A)[0]!;
    // the desktop session started with the desktop, before any attempt
    expect(box.cmds.filter((c) => c.includes("desk-bg session"))).toHaveLength(1);
    expect(box.windows).toBe(true);
    let n = box.cmds.length;
    const one = await s.open(A);
    const first = box.cmds.slice(n).join("\n");
    expect(first).toContain("desk-cmd term clear");
    expect(first).toContain("find /home/user/repo -mindepth 1 -delete");
    expect(first).toContain("tar -xzf /tmp/repo.tgz");
    expect(first).not.toContain("pkill -KILL -x xterm");
    expect(box.cmds.filter((c) => c.includes("desk-bg session"))).toHaveLength(1);
    expect(one!.managedStream).toBe(true);
    n = box.cmds.length;
    await one!.destroy();
    // the attempt's end closes no window and stops no encoder; what the attempt put on the screen is cleared and its tree copy deleted
    const end = box.cmds.slice(n).join("\n");
    expect(end).toContain("pkill -x micro");
    expect(end).toContain("desk-cmd run clear");
    expect(end).toContain("find /home/user/repo -mindepth 1 -delete");
    expect(end).not.toContain("pkill -KILL");
    expect(end).not.toContain("desk-stop");
    expect(box.windows).toBe(true);
    // the windows are gone (something on the desktop died): the next attempt starts the session afresh
    box.windows = false;
    const two = await s.open(A);
    expect(box.cmds.filter((c) => c.includes("desk-bg session"))).toHaveLength(2);
    expect(box.windows).toBe(true);
    expect(two!.id).not.toBe(one!.id);
    expect(two!.usdPerS).toBe(0);
    await two!.destroy();
    expect(s.e2b.count("create")).toBe(1);
  });

  test("a refused pause leaves the desktop running and is tried again", async () => {
    const s = setup();
    await s.m.settle();
    s.m.sync(awake(A));
    await s.m.settle();
    s.e2b.failPause = "503 service busy";
    s.clock.t += 601_000;
    s.m.sync(awake(A));
    await s.m.settle();
    expect(s.m.view(A)!.state).toBe("running");
    s.e2b.failPause = null;
    s.clock.t += 5_000;
    s.m.sync(awake(A));
    await s.m.settle();
    expect(s.m.view(A)!.state).toBe("paused");
  });
});

describe("session length", () => {
  test("the timeout is pushed forward while the runtime lives; a dead runtime's desktops are paused by E2B and found again", async () => {
    const s = setup({ limits: { idle_s: 100_000, keepalive_s: 900 } });
    await s.m.settle();
    s.m.sync(awake(A));
    await s.m.settle();
    const box = s.e2b.ofAgent(A)[0]!;
    expect(box.endAt - s.clock.t).toBe(900_000);
    for (let i = 0; i < 10; i++) {
      s.clock.t += 300_000;
      s.m.sync(awake(A));
      await s.m.settle();
    }
    expect(box.state).toBe("running");
    expect(box.endAt).toBeGreaterThan(s.clock.t);
    const spent = s.spend.usd;
    // the runtime dies: no more pushes; E2B pauses the desktop when the timeout runs out
    s.m.stop();
    const end = box.endAt;
    s.clock.t += 3_600_000;
    s.e2b.expire();
    expect(box.state).toBe("paused");
    const s2 = setup({ root: s.root, e2b: s.e2b, clock: s.clock, limits: { idle_s: 100_000 } });
    await s2.m.settle();
    expect(s2.m.view(A)).toMatchObject({ state: "paused", why: "paused by E2B when its timeout ran out" });
    expect(s2.m.sandboxOf(A)).toBe(box.id);
    // what it ran before E2B paused it is spent, the hour paused is not
    expect(spent + s2.spend.usd).toBeCloseTo(RATE * ((end - T0) / 1000), 6);
  });

  test("renewed between attempts by a pause and a resume before the window ends; never under an attempt", async () => {
    const s = setup({ limits: { idle_s: 100_000, session_max_s: 3600, renew_before_s: 600 } });
    await s.m.settle();
    s.m.sync(awake(A));
    await s.m.settle();
    const box = s.e2b.ofAgent(A)[0]!;
    // 49 minutes in: nothing yet
    for (let i = 0; i < 49; i++) {
      s.clock.t += 60_000;
      s.m.sync(awake(A));
      await s.m.settle();
    }
    expect(s.e2b.count("pause")).toBe(0);
    // an attempt runs across the 50 minute mark: it is left alone
    const inst = await s.open(A);
    s.clock.t += 120_000;
    s.m.sync([{ agent: A, working: true, asleep: false }]);
    await s.m.settle();
    expect(s.e2b.count("pause")).toBe(0);
    await inst!.destroy();
    // between attempts: paused and resumed, the window starts again, same sandbox
    s.m.sync(awake(A));
    await s.m.settle();
    expect(s.e2b.count("pause")).toBe(1);
    expect(box.state).toBe("running");
    expect(box.startedAt).toBe(s.clock.t);
    expect(s.m.sandboxOf(A)).toBe(box.id);
    expect(s.logs.join("\n")).toContain("session window renewed after 3060 s of 3600 s");
    // an attempt that starts with too little of the window left renews first
    s.clock.t += 3_050_000 - 60_000;
    s.m.sync(awake(A));
    await s.m.settle();
    s.clock.t += 60_000;
    const again = await s.open(A);
    expect(s.e2b.count("pause")).toBe(2);
    expect(box.startedAt).toBe(s.clock.t);
    await again!.destroy();
  });

  test("E2B pauses the desktop under a running attempt: it is resumed at the next command, within the bound", async () => {
    const s = setup({ limits: { idle_s: 100_000 } });
    await s.m.settle();
    s.m.sync(awake(A));
    await s.m.settle();
    const inst = await s.open(A);
    const box = s.e2b.ofAgent(A)[0]!;
    box.state = "paused";
    const r = await inst!.exec(["desk-geom"]);
    expect(r.code).toBe(0);
    expect(s.e2b.ofAgent(A)[0]!.state).toBe("running");
    expect(inst!.lost!()).toBe(false);
    expect(s.logs.join("\n")).toContain("was paused by E2B under a running attempt");
    // killed for good: the attempt goes on without its desktop
    s.e2b.boxes.delete(box.id);
    const r2 = await inst!.exec(["desk-geom"]);
    expect(r2.code).not.toBe(0);
    expect(inst!.lost!()).toBe(true);
    await inst!.destroy();
  });
});

describe("limits", () => {
  test("at e2b_max a new agent has no desktop and the state says why; an idle desktop is paused to make room for one that works", async () => {
    const s = setup({ limits: { e2b_max: 2 } });
    await s.m.settle();
    s.m.sync(awake(A, B));
    await s.m.settle();
    const a = await s.open(A);
    const b = await s.open(B);
    // both working: the third agent launches and works, without a desktop
    s.m.sync([{ agent: A, working: true, asleep: false }, { agent: B, working: true, asleep: false }, { agent: C, working: false, asleep: false }]);
    await s.m.settle();
    expect(s.m.view(C)).toMatchObject({ state: "none", why: "E2B desktop limit reached: 2 of 2 running" });
    expect(s.m.ready(C)).toBe("E2B desktop limit reached: 2 of 2 running");
    expect(await s.open(C)).toBeNull();
    expect(s.e2b.running()).toBe(2);
    // A's attempt ends: A is idle, so C may take its place at once
    await a!.destroy();
    s.clock.t += 1000;
    expect(s.m.ready(C)).toBeNull();
    const c = await s.open(C);
    expect(c).not.toBeNull();
    expect(s.m.view(A)).toMatchObject({ state: "paused", why: "paused to make room: the limit of desktops running at once was reached" });
    expect(s.e2b.running()).toBe(2);
    // paused desktops are not counted: three agents have a desktop each with two running
    expect(s.m.counts()).toMatchObject({ running: 2, paused: 1 });
    await b!.destroy();
    await c!.destroy();
  });

  test("the limit is read at every use: raising it lets the waiting agent's desktop start", async () => {
    const s = setup({ limits: { e2b_max: 1 } });
    await s.m.settle();
    s.m.sync([{ agent: A, working: true, asleep: false }, { agent: B, working: false, asleep: false }]);
    await s.m.settle();
    const first = s.m.view(A)!.state === "running" ? A : B;
    const other = first === A ? B : A;
    const inst = await s.open(first);
    s.m.sync([{ agent: first, working: true, asleep: false }, { agent: other, working: false, asleep: false }]);
    await s.m.settle();
    expect(s.m.view(other)!.state).toBe("none");
    s.limits.e2b_max = 2;
    s.clock.t += 31_000;
    s.m.sync([{ agent: first, working: true, asleep: false }, { agent: other, working: false, asleep: false }]);
    await s.m.settle();
    expect(s.m.view(other)!.state).toBe("running");
    await inst!.destroy();
  });

  test("at the day's budget: no new desktop, idle ones paused at once, an attempt in progress is not interrupted", async () => {
    // room for two desktops' next idle time, not three
    const s = setup({ limits: { desktop_usd_per_day: RATE * 600 * 2.5 } });
    await s.m.settle();
    s.m.sync(awake(A, B, C));
    await s.m.settle();
    expect(s.m.counts()).toMatchObject({ running: 2, none: 1 });
    const none = [A, B, C].find((x) => s.m.view(x)!.state === "none")!;
    expect(s.m.view(none)!.why).toMatch(/^day cap reached \(0\.0000 of 0\.069 USD, UTC day 2026-10-12\)$/);
    expect(s.m.ready(none)).toContain("day cap reached");
    const run = [A, B, C].filter((x) => x !== none);
    const inst = await s.open(run[0]!);
    // the budget is used up while one works and one idles
    s.clock.t += 500_000;
    s.m.sync([{ agent: run[0]!, working: true, asleep: false }, { agent: run[1]!, working: false, asleep: false }, { agent: none, working: false, asleep: false }]);
    await s.m.settle();
    s.clock.t += 400_000;
    s.m.sync([{ agent: run[0]!, working: true, asleep: false }, { agent: run[1]!, working: false, asleep: false }, { agent: none, working: false, asleep: false }]);
    await s.m.settle();
    expect(s.m.view(run[1]!)!.state).toBe("paused");
    expect(s.m.view(run[0]!)!.state).toBe("running");
    await inst!.destroy();
    s.m.sync(awake(A, B, C));
    await s.m.settle();
    expect(s.m.view(run[0]!)).toMatchObject({ state: "paused" });
    expect(s.m.view(run[0]!)!.why).toContain("day cap reached");
    expect(s.e2b.running()).toBe(0);
    // a new UTC day's budget is the caller's (spentToday reads 0): desktops come back with the next attempt
    s.spend.usd = 0;
    expect(s.m.ready(run[0]!)).toBeNull();
  });

  test("no key: no desktop, and the state says so", async () => {
    const s = setup({ key: null });
    await s.m.settle();
    s.m.sync(awake(A));
    await s.m.settle();
    expect(s.m.ready(A)).toContain("no E2B_API_KEY");
    expect(s.e2b.count("create")).toBe(0);
  });

  test("creates go at most start_parallel at once", async () => {
    const s = setup({ limits: { start_parallel: 2 } });
    await s.m.settle();
    let active = 0;
    let peak = 0;
    const create = s.e2b.create.bind(s.e2b);
    s.e2b.create = async (t, o) => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(5);
      try {
        return await create(t, o);
      } finally {
        active--;
      }
    };
    const ids = Array.from({ length: 7 }, (_, i) => String.fromCharCode(68 + i).repeat(44));
    s.m.sync(awake(...ids));
    await s.m.settle();
    expect(peak).toBe(2);
    expect(s.m.counts().running).toBe(7);
  });
});

describe("removal", () => {
  test("an unbound agent's desktop is paused, then killed after the grace time; only on the runtime's word", async () => {
    const s = setup({ limits: { remove_after_s: 300 } });
    await s.m.settle();
    s.m.sync(awake(A, B));
    await s.m.settle();
    const idA = s.m.sandboxOf(A)!;
    // the timer alone (the runtime cannot read its agents) removes nothing, however long
    s.clock.t += 3_600_000;
    s.m.maintain();
    await s.m.settle();
    expect(s.e2b.boxes.has(idA)).toBe(true);
    // A is unbound: not wanted any more
    s.m.sync(awake(B));
    await s.m.settle();
    expect(s.e2b.boxes.get(idA)!.state).toBe("paused");
    s.clock.t += 299_000;
    s.m.sync(awake(B));
    await s.m.settle();
    expect(s.e2b.boxes.has(idA)).toBe(true);
    // bound again inside the grace time: it keeps its desktop
    s.m.sync(awake(A, B));
    await s.m.settle();
    s.clock.t += 600_000;
    s.m.sync(awake(B));
    await s.m.settle();
    s.clock.t += 301_000;
    s.m.sync(awake(B));
    await s.m.settle();
    expect(s.e2b.boxes.has(idA)).toBe(false);
    expect(s.m.view(A)).toBeNull();
    expect(s.e2b.ofAgent(B)).toHaveLength(1);
  });

  test("a desktop found at E2B whose agent this runtime does not know is removed after the grace time", async () => {
    const clock = { t: T0 };
    const e2b = new FakeE2B(() => clock.t);
    await e2b.create("lineage-desktop", { timeoutMs: 900_000, metadata: { units_desktop: "agent", owner: "test-owner", agent: C }, lifecycle: { onTimeout: "pause" } });
    const s = setup({ e2b, clock });
    await s.m.settle();
    s.m.sync(awake(A));
    await s.m.settle();
    expect(e2b.ofAgent(C)).toHaveLength(1);
    clock.t += 301_000;
    s.m.sync(awake(A));
    await s.m.settle();
    expect(e2b.ofAgent(C)).toHaveLength(0);
    expect(e2b.ofAgent(A)).toHaveLength(1);
  });
});

describe("the agent's live stream", () => {
  const get = (root: string, m: AgentDesktops) => {
    const h = desktopHandler(root, (dir) => m.watched(dir));
    return async (id: string, file = "live.m3u8") => (await h(new Request(`http://x/desktops/${id}/${file}`)))!;
  };
  const segs = (text: string) => [...text.matchAll(/seg-(\d+)\.m4s/g)].map((x) => Number(x[1]));

  test("it runs from the desktop's creation, across an attempt and after it, from one encoder; a viewer keeps the same playlist advancing", async () => {
    const s = setup({ limits: { idle_s: 100_000 } });
    mkdirSync(join(s.root, "sessions"), { recursive: true });
    const fetch = get(s.root, s.m);
    await s.m.settle();
    s.m.sync(awake(A));
    await s.m.settle();
    const box = s.e2b.ofAgent(A)[0]!;
    const sid = streamIdOf(A);
    expect(sid).toMatch(/^[0-9a-f]{64}$/);
    expect(s.m.view(A)).toMatchObject({ state: "running", stream: sid });
    await s.m.streamPass();
    expect(box.encoder).toBe(true);
    expect(box.encoderStarts).toBe(1);
    // nobody watches and no attempt runs: nothing is copied to this host, a first viewer is told "starting"
    expect((await fetch(sid)).status).toBe(404);
    s.clock.t += 1000;
    await s.m.streamPass();
    const p0 = await fetch(sid);
    expect(p0.status).toBe(200);
    const before = segs(await p0.text());
    expect((await fetch(sid, `seg-${before[0]}.m4s`)).status).toBe(200);

    // an attempt starts on the desktop: same encoder, the playlist goes on
    const inst = await s.open(A);
    s.clock.t += 4000;
    await s.m.streamPass();
    expect(box.encoderStarts).toBe(1);
    const during = segs(await (await fetch(sid)).text());
    expect(during.at(-1)!).toBeGreaterThan(before.at(-1)!);
    // and ends: the desktop, its windows and its stream stay
    await inst!.destroy();
    for (let i = 0; i < 5; i++) {
      s.clock.t += 2000;
      await s.m.streamPass();
      await fetch(sid);
    }
    expect(box.encoderStarts).toBe(1);
    const after = segs(await (await fetch(sid)).text());
    expect(after.at(-1)!).toBeGreaterThan(during.at(-1)!);
    expect(after.at(-1)! - before.at(-1)!).toBe(7);
    expect(s.m.sandboxOf(A)).toBe(box.id);
    // the next attempt: still the one encoder
    const again = await s.open(A);
    s.clock.t += 2000;
    await s.m.streamPass();
    expect(box.encoderStarts).toBe(1);
    await again!.destroy();
  });

  test("a stream nobody watches is not copied; a pause ends it (410) after stopping the encoder; a resume brings it back under the same id", async () => {
    const s = setup({ limits: { idle_s: 100_000 } });
    mkdirSync(join(s.root, "sessions"), { recursive: true });
    const fetch = get(s.root, s.m);
    await s.m.settle();
    s.m.sync(awake(A));
    await s.m.settle();
    const box = s.e2b.ofAgent(A)[0]!;
    const sid = streamIdOf(A);
    await s.m.streamPass();
    await fetch(sid);
    s.clock.t += 1000;
    await s.m.streamPass();
    expect((await fetch(sid)).status).toBe(200);
    // the viewer leaves: 30 s later the copy is dropped, the encoder goes on
    const reads = () => box.cmds.length;
    s.clock.t += 40_000;
    await s.m.streamPass();
    s.clock.t += 5000;
    await s.m.streamPass();
    expect(box.encoder).toBe(true);
    const h = desktopHandler(s.root);
    expect((await h(new Request(`http://x/desktops/${sid}/live.m3u8`)))!.status).toBe(404);
    void reads;
    // asleep: the encoder is stopped, then the desktop paused; the stream answers 410
    const n = box.cmds.length;
    s.m.sync([{ agent: A, working: false, asleep: true, asleep_why: "agent cannot pay for an attempt (vault low)" }]);
    await s.m.settle();
    expect(box.cmds.slice(n).some((c) => c.includes("desk-stop") && c.includes("live"))).toBe(true);
    expect(box.state).toBe("paused");
    expect(s.m.view(A)).toMatchObject({ state: "paused", why: "agent cannot pay for an attempt (vault low)", stream: null });
    expect((await fetch(sid)).status).toBe(410);
    // its next attempt: resumed, a fresh encoder, the same stream id
    const inst = await s.open(A);
    s.clock.t += 1000;
    await s.m.streamPass();
    expect(box.encoderStarts).toBe(2);
    expect((await fetch(sid)).status).toBe(200);
    expect(s.m.view(A)!.stream).toBe(sid);
    await inst!.destroy();
    // removed with its agent: 410 again, nothing left on this host
    s.m.sync([]);
    s.clock.t += 301_000;
    s.m.sync([]);
    await s.m.settle();
    expect((await fetch(sid)).status).toBe(410);
  });

  test("mask on (the default): the pixelation filter, and a window outside its tile stops the stream until it is back", async () => {
    const s = setup({ limits: { idle_s: 100_000 } });
    await s.m.settle();
    s.m.sync(awake(A));
    await s.m.settle();
    const box = s.e2b.ofAgent(A)[0]!;
    await s.m.streamPass();
    expect(box.encoderCmd).toContain("scale=");
    expect(box.encoderCmd).toContain("flags=neighbor");
    expect(box.cmds.at(-1)).not.toBeUndefined();
    // the editor window leaves its tile
    box.geom = box.geom.replace("LineageEditor 0 0 636 795", "LineageEditor 300 0 636 795");
    s.clock.t += 5000;
    await s.m.streamPass();
    expect(box.encoder).toBe(false);
    expect(s.logs.join("\n")).toContain("blackout (a window is outside its tile); live stream stopped");
    s.clock.t += 5000;
    await s.m.streamPass();
    expect(box.encoder).toBe(false);
    box.geom = box.geom.replace("LineageEditor 300 0", "LineageEditor 0 0");
    s.clock.t += 5000;
    await s.m.streamPass();
    expect(box.encoder).toBe(true);
    expect(s.logs.join("\n")).toContain("live stream back");
  });

  test("mask off (desktop_mask false): the video as it is, no window check, and nothing stops the stream when a window moves", async () => {
    const s = setup({ limits: { idle_s: 100_000, mask: false } });
    await s.m.settle();
    s.m.sync(awake(A));
    await s.m.settle();
    const box = s.e2b.ofAgent(A)[0]!;
    await s.m.streamPass();
    expect(box.encoder).toBe(true);
    expect(box.encoderCmd).toContain("[0:v]format=yuv420p[v]");
    expect(box.encoderCmd).not.toContain("scale=");
    expect(box.encoderCmd).not.toContain("crop=");
    const guard = box.cmds.filter((c) => c.includes("echo ---"));
    expect(guard.length).toBeGreaterThan(0);
    expect(guard.every((c) => !c.includes("desk-geom"))).toBe(true);
    box.geom = "LineageEditor 300 0 636 795\n";
    s.clock.t += 5000;
    await s.m.streamPass();
    expect(box.encoder).toBe(true);
    expect(box.encoderStarts).toBe(1);
    expect(s.logs.join("\n")).not.toContain("blackout");
  });

  test("the filter of each setting", () => {
    expect(liveArgs("/tmp/stream").join(" ")).toContain(liveFilter());
    expect(liveArgs("/tmp/stream", ":0", true).join(" ")).toContain(liveFilter());
    const off = liveArgs("/tmp/stream", ":0", false);
    expect(off[off.indexOf("-filter_complex") + 1]).toBe(plainFilter());
    expect(plainFilter()).toBe("[0:v]format=yuv420p[v]");
    // everything but the filter is the same stream
    expect(off.filter((_, i) => i !== off.indexOf("-filter_complex") + 1)).toEqual(liveArgs("/tmp/stream").filter((_, i, a) => i !== a.indexOf("-filter_complex") + 1));
  });

  test("idle_pause false: an awake agent's desktop keeps running however long it waits; an agent that cannot work is still paused", async () => {
    const s = setup({ limits: { idle_s: 600, idle_pause: false } });
    await s.m.settle();
    s.m.sync(awake(A, B));
    await s.m.settle();
    for (let i = 0; i < 24; i++) {
      s.clock.t += 300_000;
      s.m.sync(awake(A, B));
      await s.m.settle();
    }
    expect(s.m.counts()).toMatchObject({ running: 2, paused: 0 });
    s.m.sync([{ agent: A, working: false, asleep: false }, { agent: B, working: false, asleep: true }]);
    await s.m.settle();
    expect(s.m.view(A)!.state).toBe("running");
    expect(s.m.view(B)).toMatchObject({ state: "paused", why: "agent asleep (vault empty)" });
  });
});

describe("the pool in per_agent mode", () => {
  function pool(o: { e2b_max?: number; cap?: number; required?: boolean } = {}) {
    const root = tmp();
    const clock = { t: T0 };
    const e2b = new FakeE2B(() => clock.t);
    const logs: string[] = [];
    const cfg = { root, desktops_max: 2, e2b_max: o.e2b_max ?? 100, desktop_usd_per_day: o.cap ?? 100, allow: ["github.com"], e2b: { session_max_s: 86400 }, required: o.required ?? true, mode: "per_agent" as const, owner: "pool-test" };
    const backend = new E2BBackend({ root, key: "k", api: e2b });
    const p = new DesktopPool(cfg, { e2b: backend, log: (m) => logs.push(m), now: () => clock.t, timers: false });
    const tree = join(root, "tree");
    mkdirSync(tree, { recursive: true });
    return { p, e2b, clock, logs, root, cfg, begin: (agent: string) => p.begin({ agent, tree, repo: null, commit: "c".repeat(40), stacked: false, label: "t" }) };
  }

  test("an attempt runs on its agent's own desktop; the end of the attempt leaves it; its running time is the E2B spend", async () => {
    const s = pool();
    await s.p.agents!.settle();
    s.p.syncAgents(awake(A));
    await s.p.agents!.settle();
    expect(s.p.reserve(A)).toBeNull();
    const at = await s.begin(A);
    expect(at!.backend).toBe("e2b");
    expect(s.p.status()).toMatchObject({ mode: "per_agent", agent_desktops: { running: 1 }, e2b: { running: 1, max: 100 } });
    s.clock.t += 100_000;
    await at!.end();
    expect(s.e2b.ofAgent(A)).toHaveLength(1);
    expect(s.e2b.ofAgent(A)[0]!.state).toBe("running");
    s.p.syncAgents(awake(A));
    // this server's slots are never used in this mode
    expect(s.p.status().local.running).toBe(0);
    expect(s.p.spentToday()).toBeGreaterThanOrEqual(RATE * 100);
    expect(JSON.parse(readFileSync(join(s.root, "e2b-spend.json"), "utf8")).day).toBe("2026-10-12");
    expect(s.p.agentDesktop(A)).toMatchObject({ state: "running" });
    s.p.stop();
  });

  test("an attempt's session id is a second name for the agent's stream while the attempt lasts; after it the session answers 410 and the agent's stream goes on", async () => {
    const s = pool();
    await s.p.agents!.settle();
    s.p.syncAgents(awake(A));
    await s.p.agents!.settle();
    const h = desktopHandler(s.root, (dir) => s.p.agents!.watched(dir));
    const get = async (id: string) => (await h(new Request(`http://x/desktops/${id}/live.m3u8`)))!;
    const stream = s.p.agentDesktop(A)!.stream!;
    const at = await s.begin(A);
    const session = "5".repeat(64);
    at!.sessionOpened(session);
    await s.p.agents!.streamPass();
    s.clock.t += 2000;
    await s.p.agents!.streamPass();
    const bySession = await get(session);
    const byAgent = await get(stream);
    expect(bySession.status).toBe(200);
    const first = await byAgent.text();
    expect(await bySession.text()).toBe(first);
    // both names point at the one directory
    const dirOf = (id: string) => JSON.parse(readFileSync(join(s.root, "sessions", `${id}.json`), "utf8")).dir;
    expect(dirOf(session)).toBe(dirOf(stream));
    const box = s.e2b.ofAgent(A)[0]!;
    await at!.end();
    // the attempt started and stopped no encoder of its own and removed nothing
    expect(box.encoderStarts).toBe(1);
    expect(box.encoder).toBe(true);
    expect((await get(session)).status).toBe(410);
    s.clock.t += 2000;
    await s.p.agents!.streamPass();
    const later = await get(stream);
    expect(later.status).toBe(200);
    expect(await later.text()).not.toBe(first);
    // the pool's sweep of dead stream directories leaves the agent's
    s.clock.t += 600_000;
    await s.p.reap();
    await s.p.agents!.streamPass();
    await get(stream);
    s.clock.t += 1000;
    await s.p.agents!.streamPass();
    expect((await get(stream)).status).toBe(200);
    s.p.stop();
  });

  test("with desktops required an attempt waits at the limit, with the reason", async () => {
    const s = pool({ e2b_max: 1 });
    await s.p.agents!.settle();
    s.p.syncAgents(awake(A));
    await s.p.agents!.settle();
    const at = await s.begin(A);
    s.p.syncAgents([{ agent: A, working: true, asleep: false }, { agent: B, working: false, asleep: false }]);
    await s.p.agents!.settle();
    expect(s.p.reserve(B)).toBe("E2B desktop limit reached: 1 of 1 running");
    expect(s.p.status().waiting_why).toBe("E2B desktop limit reached: 1 of 1 running");
    expect(s.p.agentDesktop(B)).toMatchObject({ state: "none", why: "E2B desktop limit reached: 1 of 1 running" });
    await at!.end();
    s.p.stop();
  });

  test("per_attempt (the default) has no agent desktops and behaves as before", () => {
    const root = tmp();
    const p = new DesktopPool({ root, desktops_max: 0, e2b_max: 2, desktop_usd_per_day: 5, allow: [] }, { timers: false, e2b: new E2BBackend({ root, key: null }) });
    expect(p.agents).toBeNull();
    expect(p.status().mode).toBe("per_attempt");
    expect(p.agentDesktop(A)).toBeNull();
    p.syncAgents(awake(A));
    p.stop();
  });
});
