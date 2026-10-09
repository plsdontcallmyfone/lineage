import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey } from "@lineage/protocol";
import { registerScoreInputs, type TradingConfig } from "../../core/src/scores.ts";
import { agentClient, diff, expectOk, honest, makeAuthor, result, runReplays, setup, submit, type Agent, type Env } from "../../core/test/helpers.ts";
import { Trader, type MarketToken, type TradingAgent } from "../src/trader.ts";
import { SimVenue, type Fill, type TraderKey } from "../src/venue.ts";
import type { TokenView } from "../src/policy.ts";

// The simulated market (plan T exit): a real Core (in process, fake clock) publishes the scores and
// stores the records; constant-product pools with a 3% fee stand in for DBC and DAMM v2; outside
// traders move prices with a seeded random walk and one crash. Hosted agents trade each other's
// tokens for six simulated hours. Afterwards every published record is checked against every limit
// and integrity rule, and separate scenarios try to break slippage, price impact, the verdict window
// and the halts.

const L = 1_000_000n;
const dirs: string[] = [];
const envs: Env[] = [];
afterEach(() => {
  while (envs.length) envs.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

interface World {
  env: Env;
  venue: SimVenue;
  agents: (Agent & { mint: string; launcher: string })[];
  scores: Map<string, number>;
  trader: Trader;
  tokens(): MarketToken[];
}

async function world(n: number, o: { siblings?: boolean; poolQuote?: bigint; config?: Partial<TradingConfig>; treasury?: bigint } = {}): Promise<World> {
  const env = await setup({ verifiers: 3 });
  envs.push(env);
  const venue = new SimVenue();
  const agents: World["agents"] = [];
  for (let i = 0; i < n; i++) {
    const a = await makeAuthor(env);
    const row = env.core.db.query<{ mint: string; launcher: string }, [string]>("SELECT mint, launcher FROM agents WHERE agent_id = ?").get(a.id)!;
    agents.push({ ...a, ...row });
  }
  if (o.siblings) {
    // a second agent of the first agent's launcher
    const sib = agentClient(env);
    const mint = generateAgentKey().id;
    await expectOk(env.admin.c.post("/v1/admin/launches", { agent: sib.id, mint, launcher: agents[0]!.launcher, target_repo: "https://github.com/example/fx", hosted: true, identity_mode: "app" }));
    agents.push({ ...sib, mint, launcher: agents[0]!.launcher });
  }
  for (const a of agents) {
    venue.addPool(a.mint, { base: 1_000_000n * L, quote: (o.poolQuote ?? 100_000n) * L, fee_bps: 300, decimals: 6 });
    venue.fund(a.key.id, o.treasury ?? 1000n * L);
  }
  const scores = new Map<string, number>();
  registerScoreInputs(env.core, { leaderboardRank: (a) => scores.get(a) ?? null });
  if (o.config) await expectOk(env.admin.c.post("/v1/admin/trading/config", o.config));
  const tokens = (): MarketToken[] => agents.map((a) => ({ mint: a.mint, agent: a.id, price: venue.price(a.mint), decimals: 6, change_24h: null, venue: "sim" }));
  const dir = mkdtempSync(join(tmpdir(), "lineage-trader-sim-"));
  dirs.push(dir);
  const trader = new Trader({
    core: env.base,
    runtimeKey: env.admin.key,
    venue,
    tokens: async () => tokens(),
    agents: async (): Promise<TradingAgent[]> => agents.map((a) => ({ agent: a.id, mint: a.mint, key: a.key })),
    stateDir: dir,
    lineDecimals: 6,
    now: () => env.clock.now(),
    log: process.env.TRADER_SIM_DEBUG ? (m) => console.log(m) : () => {},
  });
  return { env, venue, agents, scores, trader, tokens };
}

async function records(env: Env): Promise<any[]> {
  const out: any[] = [];
  let before: number | undefined;
  for (;;) {
    const r = await expectOk(env.anon.get(`/v1/trades?limit=500${before ? `&before=${before}` : ""}`));
    out.push(...r.records);
    if (r.records.length < 500) break;
    before = r.records[r.records.length - 1].id;
  }
  return out.reverse();
}

describe("simulated market", () => {
  test("six hours of hosted agents trading each other's tokens: every trade within every limit, every rule held, every trade published", async () => {
    const w = await world(5, { siblings: true });
    const { env, venue, agents, scores } = w;
    const r = rng(7);
    // initial ranks: a spread of project quality
    agents.forEach((a, i) => scores.set(a.id, i + 1));
    const ticks = 360;
    let crashed = false;
    for (let i = 0; i < ticks; i++) {
      // outside flow: a random walk on every pool, and a crash in one token two hours in
      for (const a of agents) {
        const buy = r() < 0.5;
        const size = BigInt(Math.floor(r() * 400)) * L;
        if (size > 0n) venue.shock(a.mint, buy, buy ? size : size * 10n); // a sell of about the same value (pool price 0.1)
      }
      if (i === 120 && !crashed) {
        venue.shock(agents[0]!.mint, false, 600_000n * L);
        crashed = true;
      }
      // project quality changes now and then (rising and falling scores)
      if (i % 45 === 0) {
        const ids = agents.map((a) => a.id).sort(() => (r() < 0.5 ? -1 : 1));
        ids.forEach((id, k) => scores.set(id, k + 1));
      }
      await w.trader.tick();
      env.clock.advance(60_000);
    }
    const recs = await records(env);
    const trades = recs.filter((x) => x.kind === "trade");
    const cfg = (await env.anon.get("/v1/trading/config")).body as TradingConfig;
    if (process.env.TRADER_SIM_DEBUG) console.log(JSON.stringify({ trades: trades.length, rules: trades.map((t) => t.rule), halts: recs.filter((x) => x.kind === "halt").map((h) => [h.rule, h.reason]), hits: w.trader.state.limit_hits }, null, 1));
    expect(trades.length).toBeGreaterThan(30);
    expect(trades.some((t) => t.side === "sell")).toBe(true);
    const mintOwner = new Map(agents.map((a) => [a.mint, a]));
    const byAgent = new Map(agents.map((a) => [a.id, a]));
    const lastIn = new Map<string, any>();
    const perEpoch = new Map<number, number>();
    const rules = new Set<string>();
    for (const t of trades) {
      rules.add(t.rule);
      // published with its score, rule and reason
      expect(typeof t.reason).toBe("string");
      expect(t.reason.length).toBeGreaterThan(10);
      expect(typeof t.score.composite).toBe("number");
      // integrity: never its own token, never a same-launcher token
      const me = byAgent.get(t.agent)!;
      const owner = mintOwner.get(t.mint)!;
      expect(owner.id).not.toBe(t.agent);
      expect(owner.launcher).not.toBe(me.launcher);
      // limits
      const eq = BigInt(t.equity_before);
      if (t.side === "buy") {
        expect(BigInt(t.amount_in) * 10_000n).toBeLessThanOrEqual(eq * BigInt(cfg.max_trade_bps));
        expect((BigInt(t.position_before) + BigInt(t.amount_in)) * 10_000n).toBeLessThanOrEqual(eq * BigInt(cfg.max_position_bps) + 10_000n);
      }
      expect(BigInt(t.amount_out)).toBeGreaterThanOrEqual(BigInt(t.min_out));
      expect(BigInt(t.min_out) * 10_000n).toBeGreaterThanOrEqual(BigInt(t.quote_out) * BigInt(10_000 - cfg.max_slippage_bps) - 10_000n);
      expect(t.impact_bps).toBeLessThanOrEqual(cfg.max_impact_bps);
      expect(t.treasury.positions).toBeLessThanOrEqual(cfg.max_open_positions);
      const k = `${t.agent}:${t.mint}`;
      const prev = lastIn.get(k);
      if (prev) {
        expect(t.at - prev.at).toBeGreaterThanOrEqual(cfg.cooldown_s * 1000);
        if (prev.side !== t.side) expect(t.at - prev.at).toBeGreaterThanOrEqual(cfg.min_hold_s * 1000);
      }
      lastIn.set(k, t);
      const ep = Math.floor(t.at / (cfg.trade_epoch_s * 1000));
      perEpoch.set(ep, (perEpoch.get(ep) ?? 0) + 1);
    }
    for (const n of perEpoch.values()) expect(n).toBeLessThanOrEqual(cfg.global_trades_per_epoch);
    // after a halt, the halted agent trades no more that day (daily loss) or at all (drawdown, no reset here)
    for (const h of recs.filter((x) => x.kind === "halt")) {
      const until = h.rule === "daily_loss" ? Math.floor(h.at / 86_400_000) * 86_400_000 + 86_400_000 : Infinity;
      expect(trades.some((t) => t.agent === h.agent && t.at > h.at && t.at < until)).toBe(false);
    }
    // the crash fired stop-losses for whoever held the crashed token past the minimum hold
    const held0 = trades.some((t) => t.mint === agents[0]!.mint && t.side === "buy" && t.at < Date.UTC(2026, 9, 7) + 120 * 60_000 - 1800_000);
    if (held0) expect(rules.has("stop_loss")).toBe(true);
    expect(rules.has("score_high") || rules.has("score_rising")).toBe(true);
    // the profile view sums them
    const page = await expectOk(env.anon.get(`/v1/agents/${agents[1]!.id}/trades`));
    expect(page.summary.trades).toBe(trades.filter((t) => t.agent === agents[1]!.id).length);
  }, 120_000);

  test("slippage: a price that moves between the quote and the fill beyond 2% makes the trade fail, and nothing is published", async () => {
    const w = await world(3);
    w.agents.forEach((a, i) => w.scores.set(a.id, i + 1));
    // a sandwich: every execute is front-run by a big buy in the same pool
    const exec = w.venue.execute.bind(w.venue);
    w.venue.execute = async (owner: TraderKey, t: TokenView, side: "buy" | "sell", amountIn: bigint, minOut: bigint): Promise<Fill> => {
      w.venue.shock(t.mint, side === "buy", 20_000n * L);
      return exec(owner, t, side, amountIn, minOut);
    };
    const r = await w.trader.tick();
    expect(r.trades).toBe(0);
    expect(w.trader.state.limit_hits.execution_failed ?? 0).toBeGreaterThan(0);
    expect((await records(w.env)).filter((x) => x.kind === "trade")).toHaveLength(0);
  });

  test("price impact: a shallow pool shrinks the trade until it is inside 1%, or skips it", async () => {
    const w = await world(3, { poolQuote: 1000n });
    w.agents.forEach((a, i) => w.scores.set(a.id, i + 1));
    await w.trader.tick();
    const trades = (await records(w.env)).filter((x) => x.kind === "trade");
    for (const t of trades) {
      expect(t.impact_bps).toBeLessThanOrEqual(100);
      expect(BigInt(t.amount_in)).toBeLessThan(BigInt(t.planned_in));
    }
    expect(trades.length + (w.trader.state.limit_hits.max_impact ?? 0)).toBeGreaterThan(0);
  });

  test("verdict window: an agent with an open candidate does not trade until its verdict plus the window", async () => {
    const w = await world(3);
    const { env, agents } = w;
    agents.forEach((a, i) => w.scores.set(a.id, i + 1));
    const busy = agents[0]!;
    const c = await submit(env, busy, diff("perf"));
    await w.trader.tick();
    let recs = (await records(env)).filter((x) => x.kind === "trade");
    expect(recs.some((t) => t.agent === busy.id)).toBe(false);
    expect(recs.some((t) => t.agent !== busy.id)).toBe(true);
    // the blackout is never published (it would name the author of an open candidate)
    expect(JSON.stringify(await records(env))).not.toContain("verdict_window");
    await runReplays(env, c.candidate_id, honest(result()));
    env.clock.advance(60_000);
    await w.trader.tick();
    recs = (await records(env)).filter((x) => x.kind === "trade");
    expect(recs.some((t) => t.agent === busy.id)).toBe(false); // still inside the window after the verdict
    env.clock.advance(300_000);
    await w.trader.tick();
    recs = (await records(env)).filter((x) => x.kind === "trade");
    expect(recs.some((t) => t.agent === busy.id)).toBe(true);
  });

  test("drawdown halt is published, holds across days, and lifts only on a reset by the launcher or admin", async () => {
    const w = await world(3, { config: { daily_loss_bps: 10_000, cooldown_s: 0, min_hold_s: 0 } });
    const { env, agents, venue } = w;
    agents.forEach((a, i) => w.scores.set(a.id, i + 1));
    for (let i = 0; i < 4; i++) {
      await w.trader.tick();
      env.clock.advance(60_000);
    }
    const victim = agents.find((a) => Object.keys(w.trader.state.books[a.id]?.positions ?? {}).length > 0)!;
    expect(victim).toBeDefined();
    // the victim's treasury loses a quarter outright (a theft or an exploit), so its equity falls past 20%
    const wal = venue.wallet(victim.key.id);
    wal.line = (wal.line * 3n) / 4n - 100n * L;
    await w.trader.tick();
    const halts = (await records(env)).filter((x) => x.kind === "halt" && x.agent === victim.id);
    expect(halts.map((h) => h.rule)).toContain("max_drawdown");
    const nTrades = async () => (await records(env)).filter((x) => x.kind === "trade" && x.agent === victim.id).length;
    const before = await nTrades();
    env.clock.advance(2 * 86_400_000);
    await w.trader.tick();
    expect(await nTrades()).toBe(before);
    await expectOk(env.admin.c.post(`/v1/agents/${victim.id}/trading/reset`, { note: "test" }));
    // after the reset the trader restarts the peak at the current equity (else it would halt again at once);
    // its positions are at the per-token limit of its smaller equity, so the admin raises that limit to give it room
    const halted0 = w.trader.state.limit_hits.halted ?? 0;
    await expectOk(env.admin.c.post("/v1/admin/trading/config", { max_position_bps: 5000 }));
    for (let i = 0; i < 3; i++) {
      await w.trader.tick();
      env.clock.advance(60_000);
    }
    expect(await nTrades()).toBeGreaterThan(before);
    expect(w.trader.state.limit_hits.halted ?? 0).toBe(halted0);
  });
});
