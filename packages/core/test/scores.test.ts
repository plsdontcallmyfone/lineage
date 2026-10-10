import { afterEach, describe, expect, test } from "bun:test";
import { generateAgentKey } from "../src/protocol.ts";
import { combineScores, mergeTradingConfig, storedPatch, temperamentFromSoul, TRADING_DEFAULTS, type RawComponents } from "../src/scores.ts";
import { agentClient, authorLeaks, bare, diff, expectOk, honest, makeAuthor, result, runReplays, setup, submit, type Agent, type Env } from "./helpers.ts";

// Plan T in Core: the published project score (public data only, author-blind), the admin-editable
// trading config, and the public trade records with the integrity rules Core checks again.

const envs: { close(): void }[] = [];
afterEach(() => {
  while (envs.length) envs.pop()!.close();
});

const SIG = "5".repeat(88);

function trade(agent: string, mint: string, side: "buy" | "sell", at: number, over: Record<string, unknown> = {}) {
  return { kind: "trade", ref: `trade:${agent}:${mint}:${at}:${side}`, agent, at, mint, side, venue: "sim", amount_in: "1000000", amount_out: "900000", rule: "score_high", reason: "test", score: { project: 0.5 }, signature: `sim:${at}`, ...over };
}

async function launched(e: { admin: Agent; base: string; clock: any; cfg: any }, launcher: string, hosted = true) {
  const a = agentClient(e);
  const mint = generateAgentKey().id;
  await expectOk(e.admin.c.post("/v1/admin/launches", { agent: a.id, mint, launcher, target_repo: "https://github.com/example/fx", hosted, identity_mode: "app" }));
  return { ...a, mint };
}

describe("trading config", () => {
  test("TEST defaults are the plan's table; every limit is admin-editable and bounded", async () => {
    const e = bare();
    envs.push(e);
    const c = await expectOk(e.anon.get("/v1/trading/config"));
    expect([c.max_position_bps, c.max_trade_bps, c.max_open_positions, c.daily_loss_bps, c.max_drawdown_bps, c.stop_loss_bps, c.take_profit_bps, c.max_slippage_bps, c.max_impact_bps, c.cooldown_s, c.min_hold_s]).toEqual([
      1000, 300, 8, 500, 2000, 1500, 4000, 200, 100, 600, 1800,
    ]);
    expect(c.trade_share_bps).toBe(1000);
    expect(c.default_temperament).toBe("aggressive");
    // only the admin edits it
    const someone = agentClient(e);
    expect((await someone.c.post("/v1/admin/trading/config", { max_trade_bps: 9000 })).status).toBe(403);
    const up = await expectOk(e.admin.c.post("/v1/admin/trading/config", { max_trade_bps: 200, cooldown_s: 120, temperaments: { careful: { size_bps: 50 } } }));
    expect([up.max_trade_bps, up.cooldown_s, up.temperaments.careful.size_bps, up.max_position_bps]).toEqual([200, 120, 50, 1000]);
    expect((await e.anon.get("/v1/trading/config")).body.max_trade_bps).toBe(200);
    // bounds: a typo cannot switch the limits off
    for (const bad of [{ max_trade_bps: 10_001 }, { cooldown_s: -1 }, { momentum_weight: 0.5 }, { nope: 1 }, { temperaments: { reckless: {} } }, { score_weights: { verified_gain_7d: 0, accepted_generations: 0, acceptance_rate: 0, sessions_24h: 0, leaderboard_rank: 0, follower_growth: 0 } }]) {
      const r = await e.admin.c.post("/v1/admin/trading/config", bad);
      expect(r.status).toBe(400);
    }
    expect((await e.anon.get("/v1/trading/config")).body.max_trade_bps).toBe(200);
  });

  test("merge keeps untouched fields; temperament comes from the soul's own words", () => {
    const c = mergeTradingConfig(TRADING_DEFAULTS, { stop_loss_bps: 1000 });
    expect(c.stop_loss_bps).toBe(1000);
    expect(c.take_profit_bps).toBe(4000);
    expect(temperamentFromSoul({ seed: { values: ["careful with money"], vibe: "x" }, persona: { values: [] } }, "aggressive")).toBe("careful");
    expect(temperamentFromSoul({ seed: { values: [], vibe: "a steady hand" }, persona: { values: [] } }, "aggressive")).toBe("balanced");
    expect(temperamentFromSoul({ seed: { values: ["speed"], vibe: "bold" }, persona: { values: ["craft"] } }, "aggressive")).toBe("aggressive");
    expect(temperamentFromSoul(null, "aggressive")).toBe("aggressive");
  });
});

describe("project score", () => {
  test("combines components with visible weights; unavailable inputs weigh 0, never a measured 0", () => {
    const raw: RawComponents[] = [
      { agent: "A", verified_gain_7d: 0.2, accepted_generations: 4, acceptance_rate: 0.8, sessions_24h: 2, leaderboard_rank: null, follower_growth: null },
      { agent: "B", verified_gain_7d: 0.1, accepted_generations: 1, acceptance_rate: 0.5, sessions_24h: 0, leaderboard_rank: null, follower_growth: null },
      { agent: "C", verified_gain_7d: 0, accepted_generations: 0, acceptance_rate: 0.5, sessions_24h: 0, leaderboard_rank: null, follower_growth: null },
    ];
    const s = combineScores(raw, TRADING_DEFAULTS.score_weights);
    const a = s.find((x) => x.agent === "A")!;
    expect(a.components.leaderboard_rank.weight).toBe(0);
    expect(a.components.follower_growth.norm).toBeNull();
    const wsum = Object.values(a.components).reduce((x, c) => x + c.weight, 0);
    expect(Math.abs(wsum - 1)).toBeLessThan(1e-5);
    // A leads every available component: it scores the most, and its score is the sum shown
    expect(a.score).toBeGreaterThan(s.find((x) => x.agent === "B")!.score);
    const recomputed = Object.values(a.components).reduce((x, c) => x + c.weight * (c.norm ?? 0), 0);
    expect(Math.abs(recomputed - a.score)).toBeLessThan(1e-5);
    // with a rank available it counts
    const ranked = combineScores(raw.map((r, i) => ({ ...r, leaderboard_rank: i + 1 })), TRADING_DEFAULTS.score_weights);
    expect(ranked[0]!.components.leaderboard_rank.weight).toBeGreaterThan(0);
  });

  test("uses final work only: an open candidate changes nothing and no score route names its author", async () => {
    const env: Env = await setup();
    envs.push(env);
    const winner = await makeAuthor(env);
    const quiet = await makeAuthor(env);
    const c = await submit(env, winner, diff("perf"));
    await runReplays(env, c.candidate_id, honest(result()));
    expect((await env.anon.get(`/v1/candidates/${c.candidate_id}`)).body.status).toBe("accepted");
    const before = await expectOk(env.anon.get("/v1/scores"));
    const w = before.agents.find((x: any) => x.agent === winner.id);
    expect(w.components.accepted_generations.raw).toBe(1);
    expect(w.components.verified_gain_7d.raw).toBeGreaterThan(0);
    expect(w.rank).toBe(1);
    const q0 = before.agents.find((x: any) => x.agent === quiet.id);
    // quiet commits a candidate that stays open
    const open = await submit(env, quiet, diff("other", "src/lib.rs", 2));
    const after = await expectOk(env.anon.get(`/v1/agents/${quiet.id}/score`));
    expect(after.score).toBe(q0.score);
    expect(after.components).toEqual(q0.components);
    const leaks = await authorLeaks(env, [{ ids: [open.commit_id, open.candidate_id], parties: [quiet.id], sealed: [] }]);
    expect(leaks).toEqual([]);
  });
});

describe("trade records and integrity rules (attempts to break each)", () => {
  async function three() {
    const e = bare();
    envs.push(e);
    const L1 = generateAgentKey().id;
    const L2 = generateAgentKey().id;
    const A = await launched(e, L1);
    const sibling = await launched(e, L1); // same launcher as A
    const B = await launched(e, L2);
    return { e, A, B, sibling };
  }

  test("a clean trade is stored, public on the agent's page and in the feed, with an event", async () => {
    const { e, A, B } = await three();
    const now = e.clock.now();
    const r = await expectOk(e.admin.c.post("/v1/trades", trade(A.id, B.mint, "buy", now)));
    expect(r.rule).toBe("score_high");
    const page = await expectOk(e.anon.get(`/v1/agents/${A.id}/trades`));
    expect(page.summary.buys).toBe(1);
    expect(page.records[0].mint).toBe(B.mint);
    expect(page.temperament.temperament).toBe("aggressive");
    expect(page.treasury.key).toBe(A.id);
    expect((await expectOk(e.anon.get("/v1/trades"))).records).toHaveLength(1);
    expect(e.core.events(0, 5000).some((x) => x.type === "trade.executed" && (x.data as any).agent === A.id)).toBe(true);
    // idempotent by ref
    const again = await expectOk(e.admin.c.post("/v1/trades", trade(A.id, B.mint, "buy", now)));
    expect(again.duplicate).toBe(true);
  });

  test("own token, same launcher, same registry owner: refused", async () => {
    const { e, A, B, sibling } = await three();
    const now = e.clock.now();
    expect((await e.admin.c.post("/v1/trades", trade(A.id, A.mint, "buy", now))).body.error).toBe("integrity_own_token");
    expect((await e.admin.c.post("/v1/trades", trade(A.id, sibling.mint, "buy", now))).body.error).toBe("integrity_same_party");
    // B's registry owner becomes A's launcher: same party now
    e.core.identity.syncOwner(B.id, (e.core.db.query("SELECT launcher FROM agents WHERE agent_id = ?").get(A.id) as any).launcher, 1n, null);
    expect((await e.admin.c.post("/v1/trades", trade(A.id, B.mint, "buy", now))).body.error).toBe("integrity_same_party");
  });

  test("opposite side within the minimum hold: refused; after it: allowed", async () => {
    const { e, A, B } = await three();
    const t0 = e.clock.now();
    await expectOk(e.admin.c.post("/v1/trades", trade(A.id, B.mint, "buy", t0)));
    const early = await e.admin.c.post("/v1/trades", trade(A.id, B.mint, "sell", t0 + 1799_000));
    expect(early.status).toBe(409);
    expect(early.body.error).toBe("integrity_min_hold");
    // the dry run the trader asks first says the same, and stores nothing
    expect((await e.admin.c.post("/v1/trades", { ...trade(A.id, B.mint, "sell", t0 + 1799_000), dry_run: true })).body.error).toBe("integrity_min_hold");
    await expectOk(e.admin.c.post("/v1/trades", trade(A.id, B.mint, "sell", t0 + 1800_000)));
  });

  test("halts: daily loss until the UTC day ends, drawdown until the launcher or admin resets it", async () => {
    const { e, A, B } = await three();
    const t0 = e.clock.now();
    await expectOk(e.admin.c.post("/v1/trades", { kind: "halt", ref: `halt:${A.id}:d:${t0}`, agent: A.id, at: t0, rule: "daily_loss", reason: "test" }));
    expect((await e.admin.c.post("/v1/trades", trade(A.id, B.mint, "buy", t0 + 1000))).body.error).toBe("integrity_halted");
    const nextDay = Math.floor(t0 / 86_400_000) * 86_400_000 + 86_400_000;
    await expectOk(e.admin.c.post("/v1/trades", trade(A.id, B.mint, "buy", nextDay + 1)));
    e.clock.set(nextDay + 10);
    await expectOk(e.admin.c.post("/v1/trades", { kind: "halt", ref: `halt:${A.id}:dd:${nextDay}`, agent: A.id, at: nextDay + 10, rule: "max_drawdown", reason: "test" }));
    expect((await e.admin.c.post("/v1/trades", trade(A.id, B.mint, "buy", nextDay + 86_400_000 * 5))).body.error).toBe("integrity_halted");
    expect((await expectOk(e.anon.get(`/v1/agents/${A.id}/trades`))).halt.rule).toBe("max_drawdown");
    // a stranger cannot lift it
    const stranger = agentClient(e);
    expect((await stranger.c.post(`/v1/agents/${A.id}/trading/reset`, {})).status).toBe(403);
    await expectOk(e.admin.c.post(`/v1/agents/${A.id}/trading/reset`, { note: "reviewed" }));
    expect((await expectOk(e.anon.get(`/v1/agents/${A.id}/trades`))).halt).toBeNull();
    await expectOk(e.admin.c.post("/v1/trades", trade(A.id, B.mint, "buy", nextDay + 86_400_000 * 5)));
  });

  test("only the runtime authority or admin records trades, only for hosted launched agents, with a rule, reason and score", async () => {
    const { e, A, B } = await three();
    const now = e.clock.now();
    const someone = agentClient(e);
    expect((await someone.c.post("/v1/trades", trade(A.id, B.mint, "buy", now))).status).toBe(403);
    // A signing for itself is not the runtime either
    expect((await A.c.post("/v1/trades", trade(A.id, B.mint, "buy", now))).status).toBe(403);
    const self = await launched(e, generateAgentKey().id, false);
    expect((await e.admin.c.post("/v1/trades", trade(self.id, B.mint, "buy", now))).body.error).toBe("not_hosted");
    expect((await e.admin.c.post("/v1/trades", trade(A.id, B.mint, "buy", now, { reason: "" }))).body.error).toBe("bad_reason");
    expect((await e.admin.c.post("/v1/trades", trade(A.id, B.mint, "buy", now, { score: undefined }))).body.error).toBe("bad_score");
    expect((await e.admin.c.post("/v1/trades", trade(A.id, generateAgentKey().id, "buy", now))).body.error).toBe("unknown_token");
  });

  test("exclusion flag: an excluded agent neither trades nor is traded, and records no decisions", async () => {
    const { e, A, B } = await three();
    const now = e.clock.now();
    await expectOk(e.admin.c.post("/v1/admin/trading/config", { excluded_agents: { [B.id]: "standing TEST agent: never talks about tokens" } }));
    expect((await e.admin.c.post("/v1/trades", trade(A.id, B.mint, "buy", now))).body.error).toBe("integrity_excluded");
    expect((await e.admin.c.post("/v1/trades", trade(B.id, A.mint, "buy", now))).body.error).toBe("integrity_excluded");
    expect((await e.admin.c.post("/v1/trades", { kind: "decision", ref: `decision:${B.id}:${now}`, agent: B.id, at: now, outcome: "hold", thesis: "x" })).body.error).toBe("integrity_excluded");
    expect((await expectOk(e.anon.get(`/v1/agents/${B.id}/trades`))).excluded).toContain("TEST agent");
    // lifting the flag (null) restores trading
    await expectOk(e.admin.c.post("/v1/admin/trading/config", { excluded_agents: { [B.id]: null } }));
    await expectOk(e.admin.c.post("/v1/trades", trade(A.id, B.mint, "buy", now)));
  });

  test("decision records: a hold or a refusal with its rule, public with its thesis", async () => {
    const { e, A } = await three();
    const now = e.clock.now();
    const r = await expectOk(e.admin.c.post("/v1/trades", { kind: "decision", ref: `decision:${A.id}:${now}`, agent: A.id, at: now, outcome: "refused", rule: "temperament_size", thesis: "Big conviction.", action: "buy", mint: A.mint, size_pct: 50, model: "anthropic/x", analysis_usd: 0.01 }));
    expect(r.rule).toBe("temperament_size");
    expect((await e.admin.c.post("/v1/trades", { kind: "decision", ref: `decision:${A.id}:${now + 1}`, agent: A.id, at: now + 1, outcome: "refused", thesis: "" })).body.error).toBe("bad_rule");
    expect((await e.admin.c.post("/v1/trades", { kind: "decision", ref: `decision:${A.id}:${now + 2}`, agent: A.id, at: now + 2, outcome: "filled", thesis: "" })).body.error).toBe("bad_outcome");
    const page = await expectOk(e.anon.get(`/v1/agents/${A.id}/trades`));
    expect(page.summary.decisions).toBe(1);
    expect(page.records[0].thesis).toBe("Big conviction.");
    expect(e.core.events(0, 5000).some((x) => x.type === "trade.decision")).toBe(true);
  });
});

describe("config upgrades", () => {
  test("a stored config of the first layout (score-threshold temperaments) still loads", () => {
    const old = { max_trade_bps: 250, temperaments: { aggressive: { size_bps: 300, buy_threshold: 0.2, top_k: 4 } }, gone_key: 1 };
    const c = mergeTradingConfig(TRADING_DEFAULTS, storedPatch(old));
    expect(c.max_trade_bps).toBe(250);
    expect(c.temperaments.aggressive.prompt.length).toBeGreaterThan(10);
    expect(() => mergeTradingConfig(TRADING_DEFAULTS, old)).toThrow();
  });
});
