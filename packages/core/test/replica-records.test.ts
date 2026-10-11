import { afterEach, describe, expect, test } from "bun:test";
import { replicate } from "../src/replica.ts";
import { merkleRoot } from "../src/protocol.ts";
import { candidate, diff, expectOk, honest, makeAuthor, result, runReplays, setup, submit, type Env } from "./helpers.ts";

// Replica record roots (SPEC 10.8). The site's replica reported the record roots of epochs 13, 15,
// 17 and 18 as divergent. Cause: the replica enumerated agents from GET /v1/agents, which leaves
// hidden launches out unless hidden=1 (hidden.ts), so the records and contribution leaves of hidden
// agents never reached its recomputation. Core's published roots equal its own records (checked on
// the site database: every leaf rehashes from its record and the sorted leaves root to the published
// value), so the replica was behind, not Core.

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

async function leavesOf(e: Env, ids: string[], n: number): Promise<string[]> {
  const set = new Set<string>();
  for (const id of ids) {
    const r = await expectOk(e.anon.get(`/v1/agents/${id}/records?epoch=${n}`));
    for (const ep of r.epochs) for (const l of ep.leaves) set.add(l.leaf);
  }
  return [...set].sort();
}

describe("replica record roots with hidden launches", () => {
  test("a hidden author's record and contribution leaves are in the root; the replica counts them and reports zero divergence", async () => {
    const e = (env = await setup({ verifiers: 4 }));
    const shown = await makeAuthor(e);
    const hidden = await makeAuthor(e);
    e.clock.advance(1000);
    for (const [a, name] of [
      [shown, "shown_gen"],
      [hidden, "hidden_gen"],
    ] as const) {
      const c = await submit(e, a, diff(name, `src/${name}.rs`));
      await runReplays(e, c.candidate_id, honest(result({}, 800)));
      expect((await candidate(e, c.candidate_id)).status).toBe("accepted");
    }
    const mint = (await expectOk(e.anon.get(`/v1/agents/${hidden.id}`))).mint as string;
    await expectOk(e.admin.c.post("/v1/admin/hidden", { add: [{ mint, reason: "test launch" }] }));
    const closed = await expectOk(e.admin.c.post("/v1/admin/epochs/close"));
    expect(closed.record_root).toMatch(/^[0-9a-f]{64}$/);

    // the cause: the plain listing leaves the hidden author out, and the leaves of listed agents alone
    // do not give the published root; with hidden=1 they do
    const listed = (await expectOk<any[]>(e.anon.get("/v1/agents"))).map((a) => a.agent_id);
    const all = (await expectOk<any[]>(e.anon.get("/v1/agents?hidden=1"))).map((a) => a.agent_id);
    expect(listed).not.toContain(hidden.id);
    expect(all).toContain(hidden.id);
    const hiddenLeaves = await leavesOf(e, [hidden.id], closed.n);
    expect(hiddenLeaves.length).toBe(2); // its author record and its contribution
    expect(merkleRoot(await leavesOf(e, listed, closed.n))).not.toBe(closed.record_root);
    expect(merkleRoot(await leavesOf(e, all, closed.n))).toBe(closed.record_root);

    // the fix: the replica reads every agent, hidden ones included
    const rep = await replicate(e.base);
    expect(rep.epochs.checked).toBeGreaterThan(0);
    expect(rep.divergences).toEqual([]);
  }, 60_000);
});
