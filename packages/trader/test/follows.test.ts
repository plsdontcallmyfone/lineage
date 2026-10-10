import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messageEnvelope } from "../../core/src/messages.ts";
import { signStatement } from "../../core/src/protocol.ts";
import type { FollowContext } from "../../core/src/follow-context.ts";
import { mergeTradingConfig, TRADING_DEFAULTS } from "../../core/src/scores.ts";
import { expectOk, makeAuthor, setup, type Agent, type Env } from "../../core/test/helpers.ts";
import { emptyUsage, systemPrompt, userPrompt, type AnalysisInput, type DecisionModel } from "../src/analyst.ts";
import { parseFollows, splitFollows } from "../src/follows.ts";
import { parseDecision } from "../src/policy.ts";
import { Trader, type MarketToken } from "../src/trader.ts";
import { SimVenue } from "../src/venue.ts";

// Follow decisions in the analysis round (docs/plans/AGENT-FOLLOWS.md): parsing with the round's
// limits, the prompt blocks, and a round against a real Core where the agent's (scripted) model
// follows and unfollows, signed by its key; an excluded agent gets no round and follows no one.

const id = (c: string) => c.repeat(40).slice(0, 40).replace(/[0OIl]/g, "x");
const [ME, B, C, D] = [id("M"), id("B"), id("C"), id("D")];
const ctx = (over: Partial<FollowContext["limits"]> = {}): FollowContext => ({
  agent: ME,
  limits: { enabled: true, max_following: 50, following_count: 1, round_decisions: 2, reason_max: 140, ...over },
  following: [{ agent: D, name: "Dace", reason: "x", since: 0, posts: [{ id: "p", at: Date.UTC(2026, 9, 9), lineage_id: null, recipe_name: "minbpe", text: "Merged the encode fast path." }], generations: [{ id: "g", at: Date.UTC(2026, 9, 9), lineage_id: null, recipe_name: "minbpe", height: 4, kind: "perf", target: "encode_ir", gain_pct: 12.5, fixed: 0 }] }],
  following_all: [{ agent: D, name: "Dace" }],
  candidates: [
    { agent: B, name: "Bram", accepted_7d: 3, gain_7d_pct: 21.5, fixed_7d: 0, streak: 2, last_accepted_at: Date.UTC(2026, 9, 9), posts_7d: 4, followers: 2, agent_followers: 1 },
    { agent: C, name: "Cole", accepted_7d: 1, gain_7d_pct: 4, fixed_7d: 1, streak: 1, last_accepted_at: null, posts_7d: 0, followers: 0, agent_followers: 0 },
  ],
});
const decision = (extra: Record<string, unknown> = {}) => JSON.stringify({ thesis: "Nothing in the public record moved enough to act on this round.", action: "hold", token: null, size_pct: 0, reason: "no change", ...extra });

describe("follow decisions: parsing with limits", () => {
  test("follows are taken out before the trade decision parses; a fenced answer works too", () => {
    const s = splitFollows("```json\n" + decision({ follows: [{ agent: B, follow: true, reason: "three accepted perf gains" }] }) + "\n```");
    expect(parseDecision(s.text).ok).toBe(true);
    expect(parseFollows(s.follows, ctx(), ME).decisions).toEqual([{ agent: B, follow: true, reason: "three accepted perf gains" }]);
    // without follows the answer is untouched; garbage stays garbage for parseDecision
    expect(splitFollows(decision()).text).toBe(decision());
    expect(splitFollows("not json").text).toBe("not json");
    // an unknown field next to follows still refuses the trade decision
    expect(parseDecision(splitFollows(decision({ follows: [], extra: 1 })).text).ok).toBe(false);
  });

  test("each entry is checked: listed candidate or followed agent, not itself, a one-line reason, the round's limit, the maximum", () => {
    const ok = { agent: B, follow: true, reason: "steady accepted perf work" };
    const r = parseFollows(
      [
        ok,
        { agent: ME, follow: true, reason: "myself, why not" },
        { agent: id("Z"), follow: true, reason: "not in the list" },
        { agent: B, follow: true, reason: "the same agent twice" },
        { agent: C, follow: false, reason: "never followed it" },
        { agent: C, follow: true, reason: "dash \u2014 here" },
        { agent: C, follow: true, reason: "two\nlines" },
        { agent: C, follow: true, reason: "ok" },
        { agent: C, follow: true, reason: "fine reason", extra: 1 },
        { agent: D, follow: false, reason: "its posts stopped matching my work" },
        { agent: C, follow: true, reason: "a third one this round" },
      ],
      ctx(),
      ME,
    );
    expect(r.decisions).toEqual([ok, { agent: D, follow: false, reason: "its posts stopped matching my work" }]);
    expect(r.dropped.map((d) => d.rule)).toEqual([
      "self_follow",
      "not a listed candidate",
      "the same agent twice",
      "not an agent you follow",
      "reason contains an em dash",
      "reason is one line without control characters",
      "reason at least 5 characters",
      "unknown field(s): extra",
      "round_decisions",
    ]);
    expect(parseFollows("nope", ctx(), ME).dropped[0]!.rule).toBe("follows must be a list");
    expect(parseFollows(undefined, ctx(), ME)).toEqual({ decisions: [], dropped: [] });
    // the maximum counts the agents already followed
    expect(parseFollows([ok], ctx({ following_count: 50 }), ME).dropped[0]!.rule).toBe("max_following");
    expect(parseFollows([ok], ctx({ round_decisions: 0 }), ME).dropped[0]!.rule).toBe("round_decisions");
  });

  test("the prompt: rules and choices only when the round allows follows; the followed block whenever there is one", () => {
    const cfg = mergeTradingConfig(TRADING_DEFAULTS, {});
    const book = { agent: ME, mint: null, parties: [], line: 0n, sol: 0n, positions: {}, day: { start: 0, equity: 0n, funded: 0n }, peak: 0n, halted: null, blackout: false };
    const base: AnalysisInput = { agent: ME, temperament: "aggressive", temp: cfg.temperaments.aggressive, cfg, book, market: { tokens: [], scores: new Map(), lineDecimals: 6 }, info: new Map(), components: new Map(), gens: [], realized: 0n, persona: null, now: Date.UTC(2026, 9, 10) };
    const on = { ...base, follows: ctx() };
    expect(systemPrompt(on)).toContain('"follows"');
    const u = userPrompt(on);
    expect(u).toContain("Merged the encode fast path.");
    expect(u).toContain("Agents you could follow");
    expect(u).toContain(B);
    expect(systemPrompt(on) + u).not.toMatch(/\u2014/);
    const off = { ...base, follows: ctx({ round_decisions: 0 }) };
    expect(systemPrompt(off)).not.toContain('"follows"');
    expect(userPrompt(off)).not.toContain("Agents you could follow");
    expect(userPrompt(off)).toContain("Merged the encode fast path.");
    expect(systemPrompt(base)).not.toContain('"follows"');
    expect(userPrompt(base)).not.toContain("Agents you follow");
  });
});

const dirs: string[] = [];
let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("follow decisions in a round against Core", () => {
  test("the agent's model follows and unfollows, signed by its key; the followed agent's posts reach its next round; an excluded agent has no round", async () => {
    const e = (env = await setup({ verifiers: 0 }));
    const L = 1_000_000n;
    const all: (Agent & { mint: string })[] = [];
    for (let i = 0; i < 3; i++) {
      const a = await makeAuthor(e);
      all.push({ ...a, mint: e.core.db.query<{ mint: string }, [string]>("SELECT mint FROM agents WHERE agent_id = ?").get(a.id)!.mint });
    }
    const [me, other, excluded] = all as [Agent & { mint: string }, Agent & { mint: string }, Agent & { mint: string }];
    await expectOk(e.admin.c.post("/v1/admin/trading/config", { round_s: 60, excluded_agents: { [excluded.id]: "standing TEST agent: never talks about tokens" } }));
    const msg = messageEnvelope({ from: other.id, to: `board:${e.lineage}`, thread: null, ref: null, body: "Profiled the decode path; the hot loop is in the varint read.", ciphertext: null, enc_key: null, sent_at: e.clock.now(), nonce: "post-other-1" });
    await expectOk(other.c.post("/v1/messages", { envelope: msg, sig: signStatement(other.key, "msg", msg) }));
    const venue = new SimVenue();
    for (const a of all) {
      venue.addPool(a.mint, { base: 1_000_000n * L, quote: 100_000n * L, fee_bps: 300, decimals: 6 });
      venue.fund(a.key.id, 1000n * L);
    }
    const prompts: { agent: string; user: string }[] = [];
    const answers = new Map<string, string[]>([
      [me.id, [decision({ follows: [{ agent: other.id, follow: true, reason: "careful profiling posts on the decode path" }, { agent: excluded.id, follow: true, reason: "small steady code fixes" }, { agent: me.id, follow: true, reason: "myself" }] }), decision({ follows: [{ agent: excluded.id, follow: false, reason: "no longer close to my work" }] })]],
      [other.id, [decision({ follows: "garbage" }), decision()]],
    ]);
    const model = (agent: string): DecisionModel => ({
      id: "test/scripted",
      async complete(q) {
        prompts.push({ agent, user: q.user });
        return { text: answers.get(agent)!.shift() ?? decision(), usage: { ...emptyUsage(), usd: 0.003, calls: 1 } };
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "lineage-trader-follows-"));
    dirs.push(dir);
    const tokens = (): MarketToken[] => all.map((a) => ({ mint: a.mint, agent: a.id, price: venue.price(a.mint), decimals: 6, change_24h: null, venue: "sim" }));
    const trader = new Trader({
      core: e.base,
      runtimeKey: e.admin.key,
      venue,
      tokens: async () => tokens(),
      agents: async () => all.map((a) => ({ agent: a.id, mint: a.mint, key: a.key })),
      stateDir: dir,
      lineDecimals: 6,
      now: () => e.clock.now(),
      log: () => {},
      analysis: { model: async (agent) => ({ model: model(agent) }), room: () => 1, meter: () => {}, post: async () => "msg" },
    });
    await trader.tick();
    // round 1: the candidates were offered; two follows sent (self dropped), signed by me's key
    expect(prompts.find((p) => p.agent === me.id)!.user).toContain("Agents you could follow");
    const following = await expectOk(e.anon.get(`/v1/agents/${me.id}/following`));
    expect(following.following.map((f: any) => f.agent).sort()).toEqual([other.id, excluded.id].sort());
    expect(following.following.find((f: any) => f.agent === other.id).reason).toBe("careful profiling posts on the decode path");
    expect(trader.state.follows!.filter((f) => f.agent === me.id).map((f) => f.outcome).sort()).toEqual(["dropped", "sent", "sent"]);
    expect(trader.state.follows!.find((f) => f.agent === other.id)).toMatchObject({ outcome: "dropped", rule: "follows must be a list" });
    // the excluded agent: no model call, no follow of its own
    expect(prompts.some((p) => p.agent === excluded.id)).toBe(false);
    expect((await expectOk(e.anon.get(`/v1/agents/${excluded.id}/following`))).count).toBe(0);
    // the feed says so
    const feed = await expectOk(e.anon.get(`/v1/feed?agent=${me.id}&kinds=follow`));
    expect(feed.items).toHaveLength(2);
    // round 2: the followed agent's post is in what it reads; the unfollow goes through
    e.clock.advance(61_000);
    await trader.tick();
    const second = prompts.filter((p) => p.agent === me.id)[1]!.user;
    expect(second).toContain("Agents you follow, recent public work");
    expect(second).toContain("Profiled the decode path; the hot loop is in the varint read.");
    expect((await expectOk(e.anon.get(`/v1/agents/${me.id}/following`))).following.map((f: any) => f.agent)).toEqual([other.id]);
    expect((await expectOk(e.anon.get(`/v1/agents/${other.id}/followers`))).agent_followers).toBe(1);
  });
});
