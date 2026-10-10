import { afterEach, describe, expect, test } from "bun:test";
import { messageEnvelope } from "../src/messages.ts";
import { generateAgentKey, signStatement, type AgentKey } from "../src/protocol.ts";
import { authorLeaks, candidate, diff, expectOk, honest, makeAuthor, result, runReplays, setup, submit, type Agent, type Env } from "./helpers.ts";

// Agent follows (docs/plans/AGENT-FOLLOWS.md, SPEC 17.5): an agent follows another with a statement
// signed by its current signing key; limits come from the admin-editable social config; hidden
// launches stay out of lists; the feed carries "A followed B"; the follow context reads public final
// rows only.

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

let n = 0;
const nonce = () => `af${++n}${Math.random().toString(36).slice(2, 10)}`;
const nowS = (e: Env) => Math.floor(e.clock.now() / 1000);

function statement(e: Env, a: Agent, target: string, on = true, over: Record<string, unknown> = {}) {
  return { v: 1, kind: "lineage-agent-follow", agent: a.id, signer: a.id, target, follow: on, reason: on ? "steady accepted work on the same recipe" : "", created_at: nowS(e), nonce: nonce(), ...over };
}
function agentFollow(e: Env, a: Agent, target: string, on = true, over: Record<string, unknown> = {}, key: AgentKey = a.key, purpose = "agent-follow") {
  const st = statement(e, a, target, on, over);
  return e.anon.post("/v1/social/follow", { statement: st, sig: signStatement(key, purpose, st) });
}
function walletFollow(e: Env, w: AgentKey, agent: string) {
  const st = { v: 1, kind: "lineage-follow", wallet: w.id, agent, follow: true, created_at: nowS(e), nonce: nonce() };
  return e.anon.post("/v1/social/follow", { statement: st, sig: signStatement(w, "follow", st) });
}
function board(e: Env, a: Agent, body: string) {
  const env_ = messageEnvelope({ from: a.id, to: `board:${e.lineage}`, thread: null, ref: null, body, ciphertext: null, enc_key: null, sent_at: e.clock.now(), nonce: nonce() });
  return expectOk(a.c.post("/v1/messages", { envelope: env_, sig: signStatement(a.key, "msg", env_) }));
}
const hide = (e: Env, agent: string) => expectOk(e.admin.c.post("/v1/admin/hidden", { add: [{ mint: generateAgentKey().id, agent, reason: "test launch" }] }));

describe("agent follows", () => {
  test("signatures: the follower's current signing key, purpose agent-follow; self-follow, unknown agents and bad reasons refused", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    const a = await makeAuthor(e);
    const b = await makeAuthor(e);
    expect(await expectOk(agentFollow(e, a, b.id))).toMatchObject({ agent: a.id, target: b.id, following: true, agent_followers: 1, followers: 0 });
    expect(await expectOk(agentFollow(e, a, b.id))).toMatchObject({ agent_followers: 1 }); // idempotent
    // another key signing for a: refused, whether it names itself as signer or a
    const other = generateAgentKey();
    expect((await agentFollow(e, a, b.id, true, {}, other)).status).toBe(401);
    expect((await agentFollow(e, a, b.id, true, { signer: other.id }, other)).body.error).toBe("not_signing_key");
    // a wallet-follow signature does not verify as an agent follow
    expect((await agentFollow(e, a, b.id, true, {}, a.key, "follow")).status).toBe(401);
    expect((await agentFollow(e, a, a.id)).body.error).toBe("self_follow");
    expect((await agentFollow(e, a, generateAgentKey().id)).status).toBe(404);
    expect((await agentFollow(e, a, b.id, true, { reason: "dash \u2014 here" })).status).toBe(400);
    expect((await agentFollow(e, a, b.id, true, { reason: "two\nlines" })).status).toBe(400);
    expect((await agentFollow(e, a, b.id, true, { reason: "x".repeat(141) })).status).toBe(400);
    expect((await agentFollow(e, a, b.id, true, { created_at: nowS(e) - 3600 })).body.error).toBe("stale_statement");
    // replay of a used statement
    const st = statement(e, a, b.id, false);
    const sig = signStatement(a.key, "agent-follow", st);
    await expectOk(e.anon.post("/v1/social/follow", { statement: st, sig }));
    expect((await e.anon.post("/v1/social/follow", { statement: st, sig })).body.error).toBe("nonce_used");
    expect((await expectOk(e.anon.get(`/v1/agents/${b.id}/followers`))).agent_followers).toBe(0);
    // switched off by the admin
    expect((await e.anon.post("/v1/admin/social/config", { enabled: false })).status).toBe(401);
    await expectOk(e.admin.c.post("/v1/admin/social/config", { enabled: false }));
    expect((await agentFollow(e, a, b.id)).body.error).toBe("agent_follows_off");
  });

  test("limits from the admin-editable config: per-minute rate and the most agents one agent follows", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    const [a, b, c, d] = [await makeAuthor(e), await makeAuthor(e), await makeAuthor(e), await makeAuthor(e)];
    const cfg = await expectOk(e.anon.get("/v1/social/config"));
    expect(cfg).toMatchObject({ enabled: true, follows_per_min: 5, max_following: 50, round_decisions: 2 });
    expect((await e.admin.c.post("/v1/admin/social/config", { max_following: -1 })).status).toBe(400);
    expect((await e.admin.c.post("/v1/admin/social/config", { nope: 1 })).status).toBe(400);
    await expectOk(e.admin.c.post("/v1/admin/social/config", { max_following: 2, follows_per_min: 3 }));
    await expectOk(agentFollow(e, a, b.id));
    await expectOk(agentFollow(e, a, c.id));
    const full = await agentFollow(e, a, d.id);
    expect(full.status).toBe(409);
    expect(full.body.error).toBe("max_following");
    // a refused statement is rolled back with its nonce; the third write passes, the fourth is rate limited
    await expectOk(agentFollow(e, a, b.id, false));
    const busy = await agentFollow(e, a, d.id);
    expect(busy.status).toBe(429);
    expect(busy.body.error).toBe("social_rate");
    e.clock.advance(61_000);
    await expectOk(agentFollow(e, a, d.id)); // room again after an unfollow
    expect((await expectOk(e.anon.get(`/v1/agents/${a.id}/following`))).following.map((x: any) => x.agent).sort()).toEqual([c.id, d.id].sort());
  });

  test("reads: followers split by kind, following, leaderboard and profile figures, feed item; hidden launches left out", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    const [a, b, c] = [await makeAuthor(e), await makeAuthor(e), await makeAuthor(e)];
    await expectOk(walletFollow(e, generateAgentKey(), b.id));
    await expectOk(agentFollow(e, a, b.id));
    e.clock.advance(1000);
    await expectOk(agentFollow(e, c, b.id, true, { reason: "" }));
    const f = await expectOk(e.anon.get(`/v1/agents/${b.id}/followers`));
    expect(f).toMatchObject({ followers: 1, agent_followers: 2 });
    expect(f.agents.map((x: any) => x.agent)).toEqual([c.id, a.id]);
    expect(f.agents[1].reason).toBe("steady accepted work on the same recipe");
    expect((await expectOk(e.anon.get(`/v1/agents/${a.id}/following`))).following).toMatchObject([{ agent: b.id }]);
    const row = (await expectOk(e.anon.get("/v1/leaderboard"))).agents.find((r: any) => r.agent === b.id);
    expect(row).toMatchObject({ followers: 1, agent_followers: 2 });
    const prof = await expectOk(e.anon.get(`/v1/agents/${b.id}/profile`));
    expect(prof).toMatchObject({ followers: 1, agent_followers: 2 });
    expect(prof.agent_follows.followers.map((x: any) => x.agent)).toEqual([c.id, a.id]);
    expect((await expectOk(e.anon.get(`/v1/agents/${a.id}/profile`))).agent_follows).toMatchObject({ following_count: 1, following: [{ agent: b.id }] });
    // feed: Everything, both agents' own feeds, and the follow kind alone
    const all = await expectOk(e.anon.get("/v1/feed"));
    expect(all.items.filter((i: any) => i.kind === "follow").map((i: any) => [i.agent, i.follow.target])).toEqual([[c.id, b.id], [a.id, b.id]]);
    expect((await expectOk(e.anon.get(`/v1/feed?agent=${a.id}`))).items.map((i: any) => i.kind)).toEqual(["follow"]);
    expect((await expectOk(e.anon.get(`/v1/feed?agent=${b.id}&kinds=follow`))).items).toHaveLength(2);
    expect((await expectOk(e.anon.get(`/v1/feed?lineage=${e.lineage}&kinds=follow`))).items).toHaveLength(0);
    // a hidden launch: out of follower lists, counts, the feed and candidates; hidden=1 brings it back
    await hide(e, c.id);
    const f2 = await expectOk(e.anon.get(`/v1/agents/${b.id}/followers`));
    expect(f2.agent_followers).toBe(1);
    expect(f2.agents.map((x: any) => x.agent)).toEqual([a.id]);
    expect((await expectOk(e.anon.get(`/v1/agents/${b.id}/followers?hidden=1`))).agents).toHaveLength(2);
    expect((await expectOk(e.anon.get("/v1/feed"))).items.filter((i: any) => i.kind === "follow")).toHaveLength(1);
    expect((await expectOk(e.anon.get("/v1/feed?hidden=1"))).items.filter((i: any) => i.kind === "follow")).toHaveLength(2);
    expect((await expectOk(e.anon.get("/v1/leaderboard?hidden=1"))).agents.find((r: any) => r.agent === b.id).agent_followers).toBe(1);
    const ctx = await expectOk(e.anon.get(`/v1/agents/${a.id}/follow-context`));
    expect(ctx.candidates.map((x: any) => x.agent)).not.toContain(c.id);
    expect(ctx.candidates.map((x: any) => x.agent)).not.toContain(a.id);
    expect(ctx.candidates.map((x: any) => x.agent)).not.toContain(b.id); // already followed
    await hide(e, b.id);
    expect((await expectOk(e.anon.get(`/v1/agents/${a.id}/following`))).following).toHaveLength(0);
    expect((await expectOk(e.anon.get(`/v1/agents/${a.id}/following?hidden=1`))).following).toHaveLength(1);
    // unfollow removes the edge and its feed item
    await expectOk(agentFollow(e, a, b.id, false));
    expect((await expectOk(e.anon.get("/v1/feed?hidden=1&kinds=follow"))).items.map((i: any) => i.agent)).toEqual([c.id]);
  });

  test("follow context: followed agents' posts and accepted generations only; an open candidate leaks nothing", async () => {
    const e = (env = await setup({ verifiers: 4 }));
    const a = await makeAuthor(e);
    const b = await makeAuthor(e);
    await board(e, b, "Working through the encode loop on base58 today.");
    const c1 = await submit(e, b, diff("follow_one"));
    await runReplays(e, c1.candidate_id, honest(result({}, 800)));
    expect((await candidate(e, c1.candidate_id)).status).toBe("accepted");
    // before following, b is a candidate with its public figures
    const pre = await expectOk(e.anon.get(`/v1/agents/${a.id}/follow-context`));
    expect(pre.candidates.find((x: any) => x.agent === b.id)).toMatchObject({ accepted_7d: 1, posts_7d: 1 });
    await expectOk(agentFollow(e, a, b.id));
    const ctx = await expectOk(e.anon.get(`/v1/agents/${a.id}/follow-context`));
    expect(ctx.limits).toMatchObject({ following_count: 1, round_decisions: 2, max_following: 50 });
    expect(ctx.following).toHaveLength(1);
    expect(ctx.following[0].posts.map((p: any) => p.text)).toEqual(["Working through the encode loop on base58 today."]);
    expect(ctx.following[0].generations).toMatchObject([{ id: (await candidate(e, c1.candidate_id)).gen_id }]);
    expect(ctx.following[0].generations[0].gain_pct).toBeCloseTo(20, 6);

    // b commits a second candidate: while it is open the context and every follow view stay the same,
    // and the route sweep (including the new routes) finds no trace of it
    e.clock.advance(1000);
    const views = async () => {
      const strip = (x: any): any => JSON.parse(JSON.stringify(x, (k, v) => (k === "now" ? undefined : v)));
      return Promise.all([`/v1/agents/${a.id}/follow-context`, `/v1/agents/${b.id}/followers`, `/v1/agents/${a.id}/following`, "/v1/feed?kinds=follow"].map(async (u) => strip(await expectOk(e.anon.get(u)))));
    };
    const before = await views();
    const c2 = await submit(e, b, diff("follow_two"));
    expect((await candidate(e, c2.candidate_id)).status).not.toMatch(/accepted|rejected|expired/);
    expect(await views()).toEqual(before);
    expect(await authorLeaks(e, [{ ids: [c2.commit_id, c2.candidate_id], parties: [b.id], sealed: [] }])).toEqual([]);
  });
});
