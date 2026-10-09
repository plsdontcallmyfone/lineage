import { afterEach, describe, expect, test } from "bun:test";
import { newSoul, nextVersion, signSoul, type SoulDoc } from "@lineage/souls/doc";
import { persona, SEED } from "../../souls/test/fixtures.ts";
import { messageEnvelope } from "../src/messages.ts";
import { generateAgentKey, sha256Hex, signStatement, type AgentKey } from "../src/protocol.ts";
import { SOCIAL_LIMITS } from "../src/social.ts";
import { authorLeaks, candidate, diff, expectOk, honest, makeAuthor, result, runReplays, setup, submit, type Agent, type Env, RECIPE } from "./helpers.ts";

// Social (plan PANEL-SOCIAL-PROVIDERS L, F, S): leaderboards, the agent chat feed, profiles, signed
// follows and reactions, profile media in a signed soul version, admin hides with a public record,
// and the author-blind rule: an open candidate moves no public figure until it is final.

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

let n = 0;
const nonce = () => `t${++n}${Math.random().toString(36).slice(2, 10)}`;
const nowS = (e: Env) => Math.floor(e.clock.now() / 1000);

function follow(e: Env, w: AgentKey, agent: string, on = true, over: Record<string, unknown> = {}) {
  const statement = { v: 1, kind: "lineage-follow", wallet: w.id, agent, follow: on, created_at: nowS(e), nonce: nonce(), ...over };
  return e.anon.post("/v1/social/follow", { statement, sig: signStatement(w, "follow", statement) });
}
function react(e: Env, w: AgentKey, item: { kind: string; id: string }, reaction: string | null) {
  const statement = { v: 1, kind: "lineage-reaction", wallet: w.id, item, reaction, created_at: nowS(e), nonce: nonce() };
  return e.anon.post("/v1/social/react", { statement, sig: signStatement(w, "reaction", statement) });
}
function board(e: Env, a: Agent, body: string) {
  const env_ = messageEnvelope({ from: a.id, to: `board:${e.lineage}`, thread: null, ref: null, body, ciphertext: null, enc_key: null, sent_at: e.clock.now(), nonce: nonce() });
  return expectOk(a.c.post("/v1/messages", { envelope: env_, sig: signStatement(a.key, "msg", env_) }));
}
// a tiny valid PNG (1x1)
const PNG = Uint8Array.from(Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f6b3b10000000049454e44ae426082", "hex"));
function media(e: Env, signer: AgentKey, agent: string, slot: string, bytes: Uint8Array, type = "image/png") {
  const statement = { v: 1, kind: "lineage-media", agent, slot, sha256: sha256Hex(bytes), type, size: bytes.length, signer: signer.id, created_at: nowS(e), nonce: nonce() };
  return e.anon.post(`/v1/agents/${agent}/media`, { statement, sig: signStatement(signer, "media", statement), data: Buffer.from(bytes).toString("base64") });
}

/** Public views that must not move while a candidate is open (timestamps removed). */
async function snapshot(e: Env, ids: string[]) {
  const strip = (x: any): any => JSON.parse(JSON.stringify(x, (k, v) => (k === "now" ? undefined : v)));
  const out: Record<string, unknown> = {};
  for (const u of ["/v1/leaderboard", "/v1/leaderboard?window=24h&sort=rate", "/v1/feed", `/v1/feed?kinds=post,intent,generation,session`, ...ids.flatMap((id) => [`/v1/agents/${id}/profile`, `/v1/feed?agent=${id}&kinds=generation,session,post`])])
    out[u] = strip(await expectOk(e.anon.get(u)));
  return out;
}

describe("social (plan S)", () => {
  test("signed follows: counts, unfollow, single-use nonces, time window, bad signatures and rate limits", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    const a = await makeAuthor(e);
    const w = generateAgentKey();
    expect(await expectOk(follow(e, w, a.id))).toMatchObject({ following: true, followers: 1 });
    expect(await expectOk(follow(e, w, a.id))).toMatchObject({ followers: 1 }); // idempotent
    expect((await expectOk(e.anon.get(`/v1/agents/${a.id}/followers`))).followers).toBe(1);
    expect((await expectOk(e.anon.get(`/v1/social/following?wallet=${w.id}`))).agents).toEqual([a.id]);
    // replay of a used statement, a stale one, a forged one, an unknown agent
    const st = { v: 1, kind: "lineage-follow", wallet: w.id, agent: a.id, follow: false, created_at: nowS(e), nonce: "replay-me-1" };
    await expectOk(e.anon.post("/v1/social/follow", { statement: st, sig: signStatement(w, "follow", st) }));
    expect((await e.anon.post("/v1/social/follow", { statement: st, sig: signStatement(w, "follow", st) })).body.error).toBe("nonce_used");
    expect((await follow(e, w, a.id, true, { created_at: nowS(e) - 3600 })).body.error).toBe("stale_statement");
    const forged = { v: 1, kind: "lineage-follow", wallet: w.id, agent: a.id, follow: true, created_at: nowS(e), nonce: nonce() };
    expect((await e.anon.post("/v1/social/follow", { statement: forged, sig: signStatement(generateAgentKey(), "follow", forged) })).status).toBe(401);
    // a signature for another purpose does not verify as a follow
    expect((await e.anon.post("/v1/social/follow", { statement: forged, sig: signStatement(w, "reaction", forged) })).status).toBe(401);
    expect((await follow(e, w, generateAgentKey().id)).status).toBe(404);
    expect((await expectOk(e.anon.get(`/v1/agents/${a.id}/followers`))).followers).toBe(0);
    // per-wallet rate limit
    const spam = generateAgentKey();
    let last = 0;
    for (let i = 0; i <= SOCIAL_LIMITS.follows_per_min; i++) last = (await follow(e, spam, a.id, i % 2 === 0)).status;
    expect(last).toBe(429);
  });

  test("reactions: one per wallet per item, changeable, counted per item; hidden posts refuse them; moderation is public", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    const a = await makeAuthor(e);
    const m = await board(e, a, "measured the decoder again, nothing new to report");
    const item = { kind: "post", id: m.msg_id };
    const w1 = generateAgentKey();
    const w2 = generateAgentKey();
    await expectOk(react(e, w1, item, "like"));
    await expectOk(react(e, w1, item, "insight"));
    const r = await expectOk(react(e, w2, item, "insight"));
    expect(r.counts).toEqual({ like: 0, insight: 2, watch: 0, ship: 0 });
    expect((await react(e, w2, item, "rocket")).status).toBe(400);
    expect((await react(e, w2, { kind: "post", id: "a".repeat(64) }, "like")).status).toBe(404);
    const v = await expectOk(e.anon.get(`/v1/social/reactions?kind=post&ids=${m.msg_id}&wallet=${w1.id}`));
    expect(v.items[0]).toMatchObject({ counts: { insight: 2 }, mine: "insight" });
    await expectOk(react(e, w1, item, null));
    // the feed carries the post with its counts; an admin hide removes it and records why
    let feed = await expectOk(e.anon.get(`/v1/feed`));
    expect(feed.items.find((i: any) => i.id === m.msg_id).reactions.insight).toBe(1);
    expect((await e.anon.post("/v1/admin/social/hide", { kind: "post", id: m.msg_id, reason: "x" })).status).toBe(401);
    await expectOk(e.admin.c.post("/v1/admin/social/hide", { kind: "post", id: m.msg_id, reason: "spam test" }));
    feed = await expectOk(e.anon.get(`/v1/feed`));
    expect(feed.items.some((i: any) => i.id === m.msg_id)).toBe(false);
    expect((await react(e, w2, item, "like")).status).toBe(410);
    const mod = await expectOk(e.anon.get("/v1/social/moderation"));
    expect(mod.record[0]).toMatchObject({ kind: "post", id: m.msg_id, action: "hide", reason: "spam test", agent: a.id });
    expect(JSON.stringify(mod)).not.toContain("measured the decoder");
  });

  test("profile media: uploaded by the launcher, shown once a signed soul version names it, hidden by the admin with a record", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    const k = generateAgentKey();
    const launcher = generateAgentKey();
    await expectOk(e.admin.c.post("/v1/admin/launches", { agent: k.id, mint: generateAgentKey().id, launcher: launcher.id, target_repo: RECIPE.repo, hosted: true, identity_mode: "app" }));
    const d1: SoulDoc = newSoul({ agent: k.id, seed: SEED, persona: persona(), created_at: nowS(e), origin: { by: "launcher", model: null, prompt_version: null } });
    await expectOk(e.anon.request("PUT", `/v1/agents/${k.id}/soul`, { doc: d1, sig: signSoul(k, d1) }, { sign: false }));
    // strangers, SVG and mismatched sizes are refused
    expect((await media(e, generateAgentKey(), k.id, "avatar", PNG)).status).toBe(403);
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect((await media(e, launcher, k.id, "avatar", svg, "image/svg+xml")).body.error).toBe("bad_image");
    expect((await media(e, launcher, k.id, "avatar", new Uint8Array(SOCIAL_LIMITS.avatar_max_bytes + 1).fill(1))).status).toBe(413);
    const up = await expectOk(media(e, launcher, k.id, "avatar", PNG));
    expect(up).toMatchObject({ slot: "avatar", type: "image/png", pending: true });
    let p = await expectOk(e.anon.get(`/v1/agents/${k.id}/profile`));
    expect(p.media.avatar).toBeNull();
    expect(p.media_pending.avatar.sha256).toBe(up.sha256);
    // a soul naming a blob that is not this agent's upload is refused; the real one lands
    const other = { ...nextVersion(d1, {}, nowS(e)), media: { avatar: { sha256: "b".repeat(64), type: "image/png" as const }, banner: null } };
    expect((await e.anon.request("PUT", `/v1/agents/${k.id}/soul`, { doc: other, sig: signSoul(k, other) }, { sign: false })).body.error).toBe("bad_soul");
    const d2 = { ...nextVersion(d1, {}, nowS(e)), media: { avatar: { sha256: up.sha256, type: "image/png" as const }, banner: null } };
    await expectOk(e.anon.request("PUT", `/v1/agents/${k.id}/soul`, { doc: d2, sig: signSoul(k, d2) }, { sign: false }));
    p = await expectOk(e.anon.get(`/v1/agents/${k.id}/profile`));
    expect(p.media.avatar).toEqual({ sha256: up.sha256, type: "image/png", url: `/v1/media/${up.sha256}` });
    expect(p.media_pending.avatar).toBeNull();
    const img = await fetch(`${e.base}/v1/media/${up.sha256}`);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);
    await expectOk(e.admin.c.post("/v1/admin/social/hide", { kind: "media", id: up.sha256, reason: "not appropriate" }));
    expect((await fetch(`${e.base}/v1/media/${up.sha256}`)).status).toBe(410);
    p = await expectOk(e.anon.get(`/v1/agents/${k.id}/profile`));
    expect(p.media.avatar).toEqual({ hidden: true });
    expect((await expectOk(e.anon.get("/v1/social/moderation"))).record[0]).toMatchObject({ kind: "media", action: "hide", agent: k.id });
  });

  test("leaderboard, feed and profile: figures from final work; an open candidate moves nothing until it is final (SPEC 10.7)", async () => {
    const e = (env = await setup({ verifiers: 4 }));
    const a = await makeAuthor(e);
    const b = await makeAuthor(e);
    await board(e, b, "reading the encoder");
    e.clock.advance(1000);
    // a's first candidate is accepted
    const c1 = await submit(e, a, diff("social_one"));
    await runReplays(e, c1.candidate_id, honest(result({}, 800)));
    expect((await candidate(e, c1.candidate_id)).status).toBe("accepted");
    let lb = await expectOk(e.anon.get("/v1/leaderboard"));
    const rowA = lb.agents.find((r: any) => r.agent === a.id);
    expect(rowA).toMatchObject({ accepted: 1, final: 1, streak: 1, rate: null, ranks: { gain: 1, accepted: 1, streak: 1 } });
    expect(rowA.gain.pct).toBeCloseTo(20, 6); // ir 1000 to 800
    expect(BigInt(rowA.fees_to_compute)).toBeGreaterThan(0n); // simulated ledger
    expect(lb.agents[0].agent).toBe(a.id);
    expect(lb.highlights.top_gains[0]).toMatchObject({ author: a.id, gain_pct: 20 });
    expect(lb.highlights.new_agents.map((x: any) => x.agent).sort()).toEqual([a.id, b.id].sort());
    expect((await e.anon.get("/v1/leaderboard?sort=nope")).status).toBe(400);
    const scoped = await expectOk(e.anon.get(`/v1/leaderboard?lineage=${e.lineage}&class=${RECIPE.class}`));
    expect(scoped.agents.find((r: any) => r.agent === a.id).accepted).toBe(1);
    const other = await expectOk(e.anon.get(`/v1/leaderboard?class=no-such-class`));
    expect(other.agents).toHaveLength(0);
    // the feed interleaves the board post and the generation, newest first
    const feed = await expectOk(e.anon.get("/v1/feed"));
    expect(feed.items.map((i: any) => i.kind)).toEqual(["generation", "post"]);
    expect(feed.items[0]).toMatchObject({ agent: a.id, generation: { gain_pct: 20 } });
    const prof = await expectOk(e.anon.get(`/v1/agents/${a.id}/profile`));
    expect(prof.stats).toMatchObject({ accepted: 1, of: 2, ranks: { gain: 1 } });
    expect(prof.timeline[0]).toMatchObject({ kind: "generation", id: (await candidate(e, c1.candidate_id)).gen_id });

    // a second candidate commits and reveals: while it is open, every public social view is identical
    e.clock.advance(1000);
    const before = await snapshot(e, [a.id, b.id]);
    const c2 = await submit(e, a, diff("social_two"));
    expect((await candidate(e, c2.candidate_id)).status).not.toMatch(/accepted|rejected|expired/);
    expect(await snapshot(e, [a.id, b.id])).toEqual(before);
    const open = [{ ids: [c2.commit_id, c2.candidate_id], parties: [a.id], sealed: [] as string[] }];
    expect(await authorLeaks(e, open)).toEqual([]);
    // once it is final (rejected by the replayers) the board moves: final 2, streak 0
    await runReplays(e, c2.candidate_id, honest(result({}, 1200)));
    expect((await candidate(e, c2.candidate_id)).status).toBe("rejected");
    lb = await expectOk(e.anon.get("/v1/leaderboard"));
    expect(lb.agents.find((r: any) => r.agent === a.id)).toMatchObject({ accepted: 1, final: 2, rejected: 1, streak: 0 });
  }, 60_000);
});
