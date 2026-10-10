// A stopping worker (SIGTERM) finishes the job it is running, starts nothing new and exits within a
// bound. Site incident 2026-10-10: lineage-verifier@v2 revealed a replay at 19:44:41 after its SIGTERM
// and then kept working until its 45 min stop timeout, holding the deploy. `draining` was set only after
// the loop returned, so the tick running at SIGTERM went on to start the next assigned replay.
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

test("a worker stopped mid-replay starts no further assignment and returns promptly", async () => {
  // a fake Core: two replays assigned to this worker, nothing else
  const assigned = [1, 2].map((n) => ({ replay_id: `r${n}`.padEnd(16, "0"), status: "assigned", kind: "replay" }));
  srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === "/v1/assignments") return Response.json(assigned);
      if (p === "/v1/findings/assignments" || p === "/v1/recipe-proposals/assignments") return Response.json([]);
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  dir = mkdtempSync(join(tmpdir(), "drain-stop-"));
  const w = new Worker({ core: `http://127.0.0.1:${srv.port}`, key: generateAgentKey(), telemetry: false, stateDir: dir, log: () => {} });
  const started: string[] = [];
  let authored = 0;
  let stop = false;
  // stand-ins for a long replay (the sandbox) and an authoring step
  (w as unknown as { runAndCommit: (a: { replay_id: string }) => Promise<void> }).runAndCommit = async (a) => {
    started.push(a.replay_id);
    if (started.length === 1) {
      // SIGTERM arrives while the first replay runs: what main.ts's onStop does
      stop = true;
      w.draining = true;
    }
    await Bun.sleep(300);
  };
  (w as unknown as { authorOnce: () => Promise<null> }).authorOnce = async () => (authored++, null);

  const t0 = Date.now();
  await w.run(50, () => stop);
  await w.drain(50, 2000);
  const took = Date.now() - t0;
  expect(started).toEqual([assigned[0]!.replay_id]); // the second assignment was not started
  expect(authored).toBe(0);
  expect(w.running).toBe(false);
  expect(w.pendingReveals).toBe(0);
  expect(took).toBeLessThan(3000);
});

test("main.ts sets draining at SIGTERM, not after the loop", async () => {
  const src = await Bun.file(join(import.meta.dir, "../src/main.ts")).text();
  const onStop = src.slice(src.indexOf("const onStop = () => {"), src.indexOf('process.on("SIGTERM", onStop)'));
  expect(onStop).toContain("w.draining = true");
});
