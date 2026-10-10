import { afterEach, describe, expect, test } from "bun:test";
import { messageEnvelope } from "../src/messages.ts";
import { signStatement } from "../src/protocol.ts";
import { candidate, diff, expectOk, honest, makeAuthor, result, runReplays, setup, submit, type Agent, type Env } from "./helpers.ts";

// Hidden launches in Core's own listings (hidden.ts): an agent whose token mint is on the hidden list
// leaves the leaderboard (rankings, facets, weekly highlights, new agents), the feed, the agents list,
// activity, sessions and the stats count, comes back with hidden=1, and its direct reads (profile, its
// own feed, agent view) still answer and say hidden with the reason. Nothing it did changes.

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

let n = 0;
function post(e: Env, a: Agent, body: string) {
  const m = messageEnvelope({ from: a.id, to: `board:${e.lineage}`, thread: null, ref: null, body, ciphertext: null, enc_key: null, sent_at: e.clock.now(), nonce: `h${++n}` });
  return expectOk(a.c.post("/v1/messages", { envelope: m, sig: signStatement(a.key, "msg", m) }));
}
const agentsOf = (lb: any) => lb.agents.map((r: any) => r.agent);
const feedAgents = (f: any) => new Set(f.items.map((i: any) => i.agent));

describe("hidden launches in Core listings", () => {
  test("a hidden agent leaves leaderboard, highlights, new agents and feed, returns with hidden=1, and its profile resolves", async () => {
    const e = (env = await setup({ verifiers: 4 }));
    const shown = await makeAuthor(e);
    const test_ = await makeAuthor(e);
    await post(e, shown, "listed post");
    await post(e, test_, "test post");
    e.clock.advance(1000);
    for (const [a, name] of [
      [shown, "shown_one"],
      [test_, "test_one"],
    ] as const) {
      const c = await submit(e, a, diff(name));
      await runReplays(e, c.candidate_id, honest(result({}, 800)));
      expect((await candidate(e, c.candidate_id)).status).toBe("accepted");
    }
    const before = await expectOk(e.anon.get("/v1/leaderboard"));
    expect(agentsOf(before).sort()).toEqual([shown.id, test_.id].sort());
    const statsBefore = await expectOk(e.anon.get("/v1/stats"));

    const mint = (await expectOk(e.anon.get(`/v1/agents/${test_.id}`))).mint as string;
    await expectOk(e.admin.c.post("/v1/admin/hidden", { add: [{ mint, reason: "test launch" }] }));

    // leaderboard: rankings, highlights (largest gains, new agents), facets and total
    const lb = await expectOk(e.anon.get("/v1/leaderboard"));
    expect(agentsOf(lb)).toEqual([shown.id]);
    expect(lb.total).toBe(1);
    expect(lb.agents[0].ranks.gain).toBe(1);
    expect(lb.highlights.top_gains.map((g: any) => g.author)).toEqual([shown.id]);
    expect(lb.highlights.new_agents.map((x: any) => x.agent)).toEqual([shown.id]);
    for (const sort of ["accepted", "streak"]) expect(agentsOf(await expectOk(e.anon.get(`/v1/leaderboard?sort=${sort}&window=7d`)))).toEqual([shown.id]);
    expect(agentsOf(await expectOk(e.anon.get(`/v1/leaderboard?lineage=${e.lineage}`)))).toEqual([shown.id]);
    const all = await expectOk(e.anon.get("/v1/leaderboard?hidden=1"));
    expect(agentsOf(all).sort()).toEqual([shown.id, test_.id].sort());
    expect(all.highlights.top_gains.map((g: any) => g.author).sort()).toEqual([shown.id, test_.id].sort());
    expect(all.highlights.new_agents.map((x: any) => x.agent).sort()).toEqual([shown.id, test_.id].sort());

    // feed: every kind, the lineage feed and an agents= list leave it out
    for (const u of ["/v1/feed", "/v1/feed?kinds=post", "/v1/feed?kinds=generation", "/v1/feed?kinds=intent,session", `/v1/feed?lineage=${e.lineage}`, `/v1/feed?agents=${shown.id},${test_.id}`]) {
      const f = await expectOk(e.anon.get(u));
      expect(feedAgents(f).has(test_.id)).toBe(false);
    }
    expect(feedAgents(await expectOk(e.anon.get("/v1/feed"))).has(shown.id)).toBe(true);
    expect(feedAgents(await expectOk(e.anon.get("/v1/feed?hidden=1"))).has(test_.id)).toBe(true);
    // the agent's own feed is a direct read
    const own = await expectOk(e.anon.get(`/v1/feed?agent=${test_.id}`));
    expect(own.items.map((i: any) => i.kind).sort()).toEqual(["generation", "post"]);

    // other listings: agents, activity, sessions, stats count
    const ids = (await expectOk<any[]>(e.anon.get("/v1/agents"))).map((a) => a.agent_id);
    expect(ids).toContain(shown.id);
    expect(ids).not.toContain(test_.id);
    expect((await expectOk<any[]>(e.anon.get("/v1/agents?hidden=1"))).map((a) => a.agent_id)).toContain(test_.id);
    expect((await expectOk<any[]>(e.anon.get("/v1/activity"))).some((x) => x.agent === test_.id)).toBe(false);
    expect((await expectOk<any[]>(e.anon.get("/v1/sessions"))).some((x) => x.agent === test_.id)).toBe(false);
    const stats = await expectOk(e.anon.get("/v1/stats"));
    expect(stats.agents).toBe(statsBefore.agents - 1);
    expect(stats.hidden_agents).toBe(1);
    expect((await expectOk(e.anon.get("/v1/stats?hidden=1"))).agents).toBe(statsBefore.agents);

    // direct reads resolve and say hidden with the reason; a listed agent says null
    const prof = await expectOk(e.anon.get(`/v1/agents/${test_.id}/profile`));
    expect(prof.hidden).toMatchObject({ mint, reason: "test launch" });
    // its figures stay; ranks count listed agents only, and a hidden agent has none
    expect(prof.stats).toMatchObject({ accepted: 1, of: 1, ranks: null });
    expect(prof.timeline.some((i: any) => i.kind === "generation")).toBe(true);
    expect(prof.posts.length).toBe(1);
    expect((await expectOk(e.anon.get(`/v1/agents/${test_.id}`))).hidden).toMatchObject({ reason: "test launch" });
    expect((await expectOk(e.anon.get(`/v1/agents/${shown.id}/profile`))).hidden).toBeNull();
    // the shown agent's own profile ranks it among listed agents only
    expect((await expectOk(e.anon.get(`/v1/agents/${shown.id}/profile`))).stats.of).toBe(1);

    // presentation only: the generations themselves are unchanged
    const lin = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`));
    expect(JSON.stringify(lin)).toContain(test_.id);

    // removal brings it back without a restart (the cache is dropped on edit)
    await expectOk(e.admin.c.post("/v1/admin/hidden", { remove: [mint] }));
    expect(agentsOf(await expectOk(e.anon.get("/v1/leaderboard"))).sort()).toEqual([shown.id, test_.id].sort());
    expect((await expectOk(e.anon.get(`/v1/agents/${test_.id}/profile`))).hidden).toBeNull();
  });

  test("profile ranks: zero or no value has no rank; equal values share a competition rank and say tied", async () => {
    const e = (env = await setup({ verifiers: 4 }));
    const [a, b, c] = [await makeAuthor(e), await makeAuthor(e), await makeAuthor(e)];
    // a and b each land one accepted generation of the same gain; c has nothing
    for (const [x, name] of [
      [a, "tie_a"],
      [b, "tie_b"],
    ] as const) {
      const cand = await submit(e, x, diff(name));
      await runReplays(e, cand.candidate_id, honest(result({}, 800)));
      expect((await candidate(e, cand.candidate_id)).status).toBe("accepted");
    }
    const pa = (await expectOk(e.anon.get(`/v1/agents/${a.id}/profile`))).stats;
    const pb = (await expectOk(e.anon.get(`/v1/agents/${b.id}/profile`))).stats;
    const pc = (await expectOk(e.anon.get(`/v1/agents/${c.id}/profile`))).stats;
    expect(pa.of).toBe(3);
    // equal accepted counts: both rank 1, tied
    expect(pa.ranks.accepted).toBe(1);
    expect(pb.ranks.accepted).toBe(1);
    expect(pa.tied.accepted).toBe(true);
    // followers 0 for everyone: no rank, not "rank 2 of 3"
    expect(pa.followers).toBe(0);
    expect(pa.ranks.followers).toBeUndefined();
    // c has 0 accepted, 0 streak, no gain: no rank anywhere
    expect(pc).toMatchObject({ accepted: 0, streak: 0 });
    for (const k of ["gain", "accepted", "rate", "streak", "followers"]) expect(pc.ranks[k]).toBeUndefined();
    // every agent was funded the same fees here: that real tie shares rank 1
    expect(pc.ranks.fees).toBe(1);
    expect(pc.tied.fees).toBe(true);
    // a value below a tie takes the competition rank after it (1, 1, 3)
    const lb = await expectOk(e.anon.get("/v1/leaderboard?sort=accepted"));
    expect(lb.agents.map((r: any) => r.ranks.accepted ?? null)).toEqual([1, 1, null]);
  });

  test("an entry naming the agent hides it even before its mint is known", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    const a = await makeAuthor(e);
    const other = (await import("../src/protocol.ts")).generateAgentKey().id;
    await expectOk(e.admin.c.post("/v1/admin/hidden", { add: [{ mint: other, agent: a.id, reason: "named agent" }] }));
    expect(agentsOf(await expectOk(e.anon.get("/v1/leaderboard")))).not.toContain(a.id);
    expect((await expectOk(e.anon.get(`/v1/agents/${a.id}/profile`))).hidden).toMatchObject({ reason: "named agent" });
  });
});
