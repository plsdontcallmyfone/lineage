// scripts/verify.ts draws: a canary or audit decision uses its draw subject's first slot draw, which Core
// publishes in the epoch it was requested in (often earlier than the decision's epoch). The verifier
// must find it there, and must still fail when the draw is published nowhere or is not the first one.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { H, Rng } from "@units/protocol";

const ROOT = join(import.meta.dir, "..");

function epoch(n: number, secret: string, draws: any[], decisions: any[]) {
  return { n, status: "closed", secret, beacon_commit: H("beacon-commit", secret), assignment_rounds: [], slot_beacon: { lag_slots: 2, draws, decisions } };
}
const draw = (subject: string, round: number, ep: number, slot: number) => ({
  subject, round, epoch: ep, requested_at: 1000, anchor_slot: slot - 2, anchored_at: 1001, lag_slots: 2, target_slot: slot, slot, hash: `hash${slot}`, block_time: 1, resolved_at: 1002,
});
function decision(epochN: number, secret: string, subject: string, d: any) {
  const value = new Rng(H("slot-audit", secret, subject, d.slot, d.hash)).next();
  return { kind: "audit", subject, epoch: epochN, draw_subject: d.subject, draw_round: d.round, value, rate: 0.1, outcome: value < 0.1 };
}

async function run(epochs: any[]): Promise<{ code: number; out: string }> {
  const server = Bun.serve({
    port: 0, // any free port: a fixed one fails whenever something else holds it
    hostname: "127.0.0.1",
    fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === "/v1/config") return Response.json({ network: { quorum: 3, det_tolerance: 0, bootstrap_resamples: 10, bond_cap: "0" } });
      if (p === "/v1/lineages") return Response.json([]); // verify.ts reads the final candidates per unit
      if (p === "/v1/candidates") return Response.json([]);
      if (p === "/v1/epochs") return Response.json(epochs.map((e) => ({ n: e.n, status: e.status })));
      const m = p.match(/^\/v1\/epochs\/(\d+)$/);
      const e = m && epochs.find((x) => x.n === Number(m[1]));
      return e ? Response.json(e) : new Response("not found", { status: 404 });
    },
  });
  try {
    const proc = Bun.spawn(["bun", join(ROOT, "scripts/verify.ts"), "--core", `http://127.0.0.1:${server.port}`], { stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    return { code: await proc.exited, out };
  } finally {
    server.stop(true);
  }
}

const S1 = "a".repeat(64), S2 = "b".repeat(64);
const d0 = draw("subj-x", 1, 15, 500);

test("a decision whose draw was published in an earlier epoch verifies", async () => {
  const r = await run([epoch(15, S1, [d0], []), epoch(17, S2, [], [decision(17, S2, "gen-1", d0)])]);
  expect(r.out).toContain("1 canary/audit decisions recomputed");
  expect(r.code).toBe(0);
}, 30_000);

test("a decision whose draw is published nowhere fails", async () => {
  const r = await run([epoch(17, S2, [], [decision(17, S2, "gen-1", d0)])]);
  expect(r.out).toContain("its slot draw is not published");
  expect(r.code).toBe(1);
}, 30_000);

test("a decision that uses a later round than the subject's first slot draw fails", async () => {
  const d1 = draw("subj-x", 2, 17, 600);
  const r = await run([epoch(15, S1, [d0], []), epoch(17, S2, [d1], [decision(17, S2, "gen-1", d1)])]);
  expect(r.out).toContain("not the first slot draw of its subject");
  expect(r.code).toBe(1);
}, 30_000);

test("a tampered decision value still fails when its draw is in another epoch", async () => {
  const u = { ...decision(17, S2, "gen-1", d0), value: 0.01, outcome: true };
  const r = await run([epoch(15, S1, [d0], []), epoch(17, S2, [], [u])]);
  expect(r.out).toContain("recomputes to");
  expect(r.code).toBe(1);
}, 30_000);
