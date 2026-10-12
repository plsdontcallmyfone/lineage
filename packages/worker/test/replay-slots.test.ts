// Scale-out lane (docs/plans/SCALE-OUT.md): a verifier ran one replay at a time, and both site verifiers
// replay every candidate, so verification was one candidate at a time whatever the machine. With
// replaySlots (UNITS_REPLAY_SLOTS) a verifier runs that many at once; 1 (the default) is the old loop.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey } from "../../protocol/src/auth.ts";
import { Worker } from "../src/worker.ts";

let srv: ReturnType<typeof Bun.serve> | null = null;
let dir = "";
afterEach(() => {
  srv?.stop(true);
  srv = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function setup(n: number, replaySlots?: number) {
  const assigned = Array.from({ length: n }, (_, i) => ({ replay_id: `r${i}`.padEnd(16, "0"), status: "assigned", kind: "replay" }));
  const done = new Set<string>();
  srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === "/v1/assignments") return Response.json(assigned.filter((a) => !done.has(a.replay_id)));
      if (p === "/v1/findings/assignments" || p === "/v1/recipe-proposals/assignments") return Response.json([]);
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  dir = mkdtempSync(join(tmpdir(), "replay-slots-"));
  const w = new Worker({ core: `http://127.0.0.1:${srv.port}`, key: generateAgentKey(), telemetry: false, stateDir: dir, log: () => {}, replaySlots });
  let now = 0;
  let peak = 0;
  const started: string[] = [];
  const twice: string[] = [];
  (w as unknown as { runAndCommit: (a: { replay_id: string }) => Promise<void> }).runAndCommit = async (a) => {
    if (started.includes(a.replay_id)) twice.push(a.replay_id);
    started.push(a.replay_id);
    peak = Math.max(peak, ++now);
    await Bun.sleep(120);
    now--;
    done.add(a.replay_id);
  };
  (w as unknown as { authorOnce: () => Promise<null> }).authorOnce = async () => null;
  return { w, started, twice, done, peak: () => peak };
}

test("default: one replay at a time, in Core's order", async () => {
  const s = setup(3);
  await s.w.run(20, () => s.done.size === 3);
  expect(s.peak()).toBe(1);
  expect(s.started).toEqual(["r0", "r1", "r2"].map((x) => x.padEnd(16, "0")));
  expect(s.twice).toEqual([]);
});

test("replaySlots 3: three at once, never more, no assignment run twice, a freed slot is refilled", async () => {
  const s = setup(7, 3);
  const t0 = Date.now();
  await s.w.run(20, () => s.done.size === 7);
  expect(s.peak()).toBe(3);
  expect(s.twice).toEqual([]);
  expect(new Set(s.started).size).toBe(7);
  expect(s.w.running).toBe(false);
  // 7 replays of 120 ms: 840 ms one at a time; three at once is three rounds
  expect(Date.now() - t0).toBeLessThan(800);
});

test("replaySlots: a stop takes no new assignment and waits for the replays that run", async () => {
  const s = setup(6, 2);
  let stop = false;
  // SIGTERM arrives once two replays run: what main.ts's onStop does
  const t = setInterval(() => {
    if (s.started.length < 2) return;
    stop = true;
    s.w.draining = true;
    clearInterval(t);
  }, 5);
  await s.w.run(20, () => stop);
  await s.w.drain(20, 2000); // waits for the two that run in the background
  expect(s.w.running).toBe(false);
  expect(s.started.length).toBe(2);
  expect(s.done.size).toBe(2);
});

test("UNITS_REPLAY_SLOTS is the default when the option is absent; a bad value means one at a time", async () => {
  const before = process.env.UNITS_REPLAY_SLOTS;
  try {
    process.env.UNITS_REPLAY_SLOTS = "2";
    const a = setup(4);
    await a.w.run(20, () => a.done.size === 4);
    expect(a.peak()).toBe(2);
    srv?.stop(true);
    process.env.UNITS_REPLAY_SLOTS = "many";
    const b = setup(2);
    await b.w.run(20, () => b.done.size === 2);
    expect(b.peak()).toBe(1);
  } finally {
    if (before === undefined) delete process.env.UNITS_REPLAY_SLOTS;
    else process.env.UNITS_REPLAY_SLOTS = before;
  }
});
