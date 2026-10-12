// The risk layer in the engine (docs/plans/AGENT-WALLET-SAFETY.md "Risk management"): the
// conservative defaults, one test per rule, the pre-trade checks, and the worst-case loss figures
// the plan states, computed here from the limits.
import { describe, expect, test } from "bun:test";
import { mergeTradingConfig, TRADING_DEFAULTS, type TradingConfig } from "../../core/src/scores.ts";
import { checkTrade, enforceDecision, riskExits, type Book, type Market, type ModelDecision, type TokenView } from "../src/policy.ts";
import { preTradeCheck, PreTradeRefusal, SimVenue, type Quote } from "../src/venue.ts";

const L = 1_000_000n;
const NOW = Date.UTC(2026, 9, 12, 12);
const cfg = (over: Record<string, unknown> = {}): TradingConfig => mergeTradingConfig(TRADING_DEFAULTS, over);
const M = (i: number | string) => `Tok${i}x`.padEnd(40, "z");
const good = { liquidity: 10_000n * L, holders: 50, move_1h: 0.02, price_at: NOW - 5_000, market_cap: 1_000_000n * L };
const quiet = { held: 0n, buyers: 0, bought: false, sold: false };
const tok = (i: number, over: Partial<TokenView> = {}): TokenView => ({
  mint: M(i), agent: `A${i}`, parties: [`L${i}`], price: 1, decimals: 6, change_24h: 0, venue: "sim",
  eligibility: { accepted: 3, launched_at: NOW - 10 * 86_400_000, hidden: false }, facts: good, network: quiet, ...over,
});
const book = (over: Partial<Book> = {}): Book => ({
  agent: "ME", mint: M("ME"), parties: ["LME"], line: 1000n * L, sol: 10n ** 9n, positions: {}, day: { start: 0, equity: 1000n * L, funded: 0n }, peak: 1000n * L, halted: null, blackout: false, trades_today: 0, ...over,
});
const market = (tokens: TokenView[], o: Partial<Market> = {}): Market => ({ tokens, scores: new Map(tokens.map((t) => [t.agent, { now: 0.8, ref: 0.7 }])), lineDecimals: 6, ...o });
const buy = (b: Book, t: TokenView, quote: bigint, c = cfg(), o: { reduceOnly?: boolean } = {}) => checkTrade(b, t, "buy", quote, quote, 1000n * L, c, NOW, 10, 6, o)?.rule ?? "ok";
const pos = (i: number, value: bigint) => ({ [M(i)]: { mint: M(i), qty: value, cost: value, opened_at: 0, last_side: "buy" as const, last_at: 0 } });

describe("conservative defaults (owner 2026-10-12)", () => {
  test("the table", () => {
    const c = cfg();
    expect({
      max_trade_bps: c.max_trade_bps, max_position_bps: c.max_position_bps, max_open_positions: c.max_open_positions, max_deployed_bps: c.max_deployed_bps, daily_loss_bps: c.daily_loss_bps,
      max_drawdown_bps: c.max_drawdown_bps, stop_loss_bps: c.stop_loss_bps, take_profit_bps: c.take_profit_bps, take_profit_sell_bps: c.take_profit_sell_bps, max_slippage_bps: c.max_slippage_bps,
      max_impact_bps: c.max_impact_bps, max_trades_per_day: c.max_trades_per_day, cooldown_s: c.cooldown_s, min_hold_s: c.min_hold_s,
    }).toEqual({
      max_trade_bps: 100, max_position_bps: 500, max_open_positions: 5, max_deployed_bps: 2500, daily_loss_bps: 200, max_drawdown_bps: 1000, stop_loss_bps: 1000, take_profit_bps: 2500,
      take_profit_sell_bps: 5000, max_slippage_bps: 100, max_impact_bps: 50, max_trades_per_day: 10, cooldown_s: 1800, min_hold_s: 3600,
    });
    // no temperament may size a buy above the per-trade limit
    for (const t of Object.values(c.temperaments)) expect(t.size_bps).toBeLessThanOrEqual(c.max_trade_bps);
    expect(c.default_temperament).toBe("careful");
  });

  test("worst-case loss per agent and network-wide, computed from the limits (the plan's figures)", () => {
    const c = cfg();
    // hard bound: everything in positions goes to zero at once (stops cannot fire). At most max_deployed_bps of equity is in positions.
    expect(c.max_deployed_bps).toBe(2500); // 25% of an agent's trading equity, and of the network's (the sum of the same bound)
    // new money an agent can put at risk in one UTC day: trades per day x per-trade limit, and never past the deployed cap
    expect(Math.min(c.max_trades_per_day * c.max_trade_bps, c.max_deployed_bps)).toBe(1000); // 10%
    // when stops execute at their level: every position at its cap falls to the stop, sold with the worst allowed slippage
    const full = Math.floor(c.max_deployed_bps / c.max_position_bps); // 5 positions of 5%
    expect(full).toBe(c.max_open_positions);
    const perPosition = (c.max_position_bps * (c.stop_loss_bps + c.max_slippage_bps + c.max_impact_bps)) / 10_000; // 5% x (10% + 1% + 0.5%)
    expect(perPosition).toBe(57.5);
    expect(full * perPosition).toBe(287.5); // 2.875% of equity
    // the daily loss halt stops new buys at 2%; the drawdown halt at 10% from the peak; the network goes reduce-only at 5%
    expect([c.daily_loss_bps, c.max_drawdown_bps, c.network_drawdown_bps]).toEqual([200, 1000, 500]);
    // the firewall's absolute caps per key, whatever the equity (quote base units)
    expect([c.firewall_max_tx_line, c.firewall_max_day_line]).toEqual(["100000000", "1000000000"]);
  });
});

describe("per-agent limits", () => {
  test("max per trade 1%, max position 5%, max open positions 5", () => {
    expect(buy(book(), tok(1), 10n * L)).toBe("ok");
    expect(buy(book(), tok(1), 10n * L + 1n)).toBe("max_trade");
    expect(buy(book({ line: 955n * L, positions: pos(1, 45n * L) }), tok(1), 5n * L)).toBe("ok");
    expect(buy(book({ line: 955n * L, positions: pos(1, 45n * L) }), tok(1), 5n * L + 1n)).toBe("max_position");
    const five = Object.assign({}, ...[1, 2, 3, 4, 5].map((i) => pos(i, 10n * L)));
    expect(buy(book({ line: 950n * L, positions: five }), tok(6), 5n * L)).toBe("max_open_positions");
  });

  test("max total deployed 25%: the rest stays in the quote token", () => {
    // 245 of 1000 in five positions of 49: one more unit of 5 fits exactly, a sixth does not
    const five = Object.assign({}, ...[1, 2, 3, 4, 5].map((i) => pos(i, 49n * L)));
    const b = book({ line: 755n * L, positions: five });
    const m = market([1, 2, 3, 4, 5].map((i) => tok(i)));
    const eq = 1000n * L;
    expect(checkTrade(b, m.tokens[0]!, "buy", 1n * L, 1n * L, eq, cfg({ max_position_bps: 10_000 }), NOW, 10)?.rule ?? "ok").toBe("ok"); // 246
    expect(checkTrade(b, m.tokens[0]!, "buy", 5n * L, 5n * L, eq, cfg({ max_position_bps: 10_000 }), NOW, 10)?.rule ?? "ok").toBe("ok"); // 250: exactly the cap
    expect(checkTrade(b, m.tokens[0]!, "buy", 5n * L + 1n, 5n * L + 1n, eq, cfg({ max_position_bps: 10_000 }), NOW, 10)?.rule).toBe("max_deployed");
    // a sell is never refused by it
    expect(checkTrade(b, m.tokens[0]!, "sell", 49n * L, 49n * L, eq, cfg(), NOW, 10)?.rule ?? "ok").toBe("ok");
  });

  test("max trades per day 10: no further buy, a sell still goes", () => {
    expect(buy(book({ trades_today: 9 }), tok(1), 5n * L)).toBe("ok");
    expect(buy(book({ trades_today: 10 }), tok(1), 5n * L)).toBe("max_trades_per_day");
    const b = book({ trades_today: 10, line: 990n * L, positions: pos(1, 10n * L) });
    expect(checkTrade(b, tok(1), "sell", 10n * L, 10n * L, 1000n * L, cfg(), NOW, 10)?.rule ?? "ok").toBe("ok");
  });

  test("cooldown 30 min and minimum hold 60 min", () => {
    const held = (ago: number) => book({ line: 990n * L, positions: { [M(1)]: { mint: M(1), qty: 10n * L, cost: 10n * L, opened_at: 0, last_side: "buy", last_at: NOW - ago } } });
    expect(buy(held(29 * 60_000), tok(1), 5n * L)).toBe("cooldown");
    expect(buy(held(30 * 60_000), tok(1), 5n * L)).toBe("ok");
    expect(checkTrade(held(59 * 60_000), tok(1), "sell", 10n * L, 10n * L, 1000n * L, cfg(), NOW, 10)?.rule).toBe("integrity_min_hold");
    expect(checkTrade(held(60 * 60_000), tok(1), "sell", 10n * L, 10n * L, 1000n * L, cfg(), NOW, 10)?.rule ?? "ok").toBe("ok");
  });

  test("stop-loss at 10% sells all; take-profit at 25% sells half; daily loss 2% and drawdown 10% halt", () => {
    const p = (price: number) => {
      const b = book({ line: 950n * L, positions: { [M(1)]: { mint: M(1), qty: 50n * L, cost: 50n * L, opened_at: 0, last_side: "buy", last_at: 0 } }, day: { start: 0, equity: 0n, funded: 0n }, peak: 0n });
      return riskExits(b, market([tok(1, { price })]), cfg(), NOW, 10);
    };
    expect(p(0.91).actions).toEqual([]);
    expect(p(0.9).actions.map((a) => [a.rule, a.amount])).toEqual([["stop_loss", 50n * L]]);
    expect(p(1.24).actions).toEqual([]);
    expect(p(1.25).actions.map((a) => [a.rule, a.amount])).toEqual([["take_profit", 25n * L]]);
    const day = (equityNow: bigint) => riskExits(book({ line: equityNow, day: { start: 0, equity: 1000n * L, funded: 0n }, peak: 0n }), market([]), cfg(), NOW, 10).halt?.rule ?? null;
    expect(day(980n * L)).toBeNull();
    expect(day(980n * L - 1n)).toBe("daily_loss");
    const dd = (equityNow: bigint) => riskExits(book({ line: equityNow, day: { start: 0, equity: 0n, funded: 0n }, peak: 1000n * L }), market([]), cfg(), NOW, 10).halt?.rule ?? null;
    expect(dd(900n * L)).toBeNull();
    expect(dd(900n * L - 1n)).toBe("max_drawdown");
  });
});

describe("token eligibility", () => {
  test("accepted work, launch age, hidden", () => {
    expect(buy(book(), tok(1, { eligibility: { accepted: 0, launched_at: 0, hidden: false } }), 5n * L)).toBe("ineligible_generations");
    expect(buy(book(), tok(1, { eligibility: { accepted: 2, launched_at: NOW - 23 * 3_600_000, hidden: false } }), 5n * L)).toBe("ineligible_age");
    expect(buy(book(), tok(1, { eligibility: { accepted: 2, launched_at: 0, hidden: true } }), 5n * L)).toBe("ineligible_hidden");
    expect(buy(book(), tok(1, { eligibility: null }), 5n * L)).toBe("ineligible_unknown");
  });
  test("minimum real quote reserves and minimum holders", () => {
    const c = cfg();
    expect(buy(book(), tok(1, { facts: { ...good, liquidity: BigInt(c.eligibility_min_liquidity_line) } }), 5n * L)).toBe("ok");
    expect(buy(book(), tok(1, { facts: { ...good, liquidity: BigInt(c.eligibility_min_liquidity_line) - 1n } }), 5n * L)).toBe("ineligible_liquidity");
    expect(buy(book(), tok(1, { facts: { ...good, liquidity: null } }), 5n * L)).toBe("ineligible_liquidity");
    expect(buy(book(), tok(1, { facts: { ...good, holders: c.eligibility_min_holders - 1 } }), 5n * L)).toBe("ineligible_holders");
    expect(buy(book(), tok(1, { facts: { ...good, holders: null } }), 5n * L)).toBe("ineligible_holders");
  });
  test("anti-pump: no buy when the price moved more than 30% within the hour, or before an hour of samples exists", () => {
    expect(buy(book(), tok(1, { facts: { ...good, move_1h: 0.3 } }), 5n * L)).toBe("ok");
    expect(buy(book(), tok(1, { facts: { ...good, move_1h: 0.3001 } }), 5n * L)).toBe("anti_pump");
    expect(buy(book(), tok(1, { facts: { ...good, move_1h: null } }), 5n * L)).toBe("price_history");
  });
  test("a stale or unreadable price refuses the trade", () => {
    expect(buy(book(), tok(1, { facts: { ...good, price_at: NOW - 120_000 } }), 5n * L)).toBe("ok");
    expect(buy(book(), tok(1, { facts: { ...good, price_at: NOW - 121_000 } }), 5n * L)).toBe("stale_price");
    expect(buy(book(), tok(1, { facts: { ...good, price_at: null } }), 5n * L)).toBe("stale_price");
    expect(buy(book(), tok(1, { price: null }), 5n * L)).toBe("no_price");
  });
});

describe("network-wide guards", () => {
  test("exposure: all hosted agents together hold at most 5% of a token's market cap", () => {
    const cap = 10_000n * L; // 5% is 500
    const t = (held: bigint) => tok(1, { facts: { ...good, market_cap: cap }, network: { ...quiet, held } });
    expect(buy(book(), t(490n * L), 10n * L)).toBe("ok");
    expect(buy(book(), t(490n * L + 1n), 10n * L)).toBe("network_exposure");
    expect(buy(book(), tok(1, { facts: { ...good, market_cap: null } }), 5n * L)).toBe("network_exposure");
  });
  test("herding: at most 2 other agents bought the token within the window", () => {
    expect(buy(book(), tok(1, { network: { ...quiet, buyers: 1, bought: true } }), 5n * L)).toBe("ok");
    expect(buy(book(), tok(1, { network: { ...quiet, buyers: 2, bought: true } }), 5n * L)).toBe("herd_limit");
  });
  test("wash guard: never opposite another hosted agent within the window; a stop-loss is not held back", () => {
    expect(buy(book(), tok(1, { network: { ...quiet, sold: true } }), 5n * L)).toBe("wash_guard");
    const b = book({ line: 990n * L, positions: pos(1, 10n * L) });
    const t = tok(1, { network: { ...quiet, bought: true, buyers: 1 } });
    expect(checkTrade(b, t, "sell", 10n * L, 10n * L, 1000n * L, cfg(), NOW, 10)?.rule).toBe("wash_guard");
    expect(checkTrade(b, t, "sell", 10n * L, 10n * L, 1000n * L, cfg(), NOW, 10, 6, { exit: true })?.rule ?? "ok").toBe("ok");
    // through the risk exits: the stop-loss fires although another agent bought
    const down = riskExits(book({ line: 950n * L, positions: pos(1, 50n * L), day: { start: 0, equity: 0n, funded: 0n }, peak: 0n }), market([tok(1, { price: 0.8, network: { ...quiet, bought: true, buyers: 1 } })]), cfg(), NOW, 10);
    expect(down.actions.map((a) => a.rule)).toEqual(["stop_loss"]);
  });
});

describe("circuit breakers and pre-trade checks", () => {
  const d = (action: "buy" | "sell", size: number): ModelDecision => ({ thesis: "The public record for this project is strong this week.", action, token: M(1), size_pct: size, reason: "public record" });
  test("reduce only: the model's buy is refused, its sell goes, and so do the risk exits", () => {
    const c = cfg();
    const m = market([tok(1)], { reduce_only: true });
    const refused = enforceDecision(book(), m, c, c.temperaments.careful, d("buy", 0.5), NOW, 10);
    expect(refused.ok ? "ok" : refused.refusal.rule).toBe("reduce_only");
    const b = book({ line: 990n * L, positions: pos(1, 10n * L) });
    const sold = enforceDecision(b, m, c, c.temperaments.careful, d("sell", 100), NOW, 10);
    expect(sold.ok && sold.action?.side).toBe("sell");
    const exits = riskExits(book({ line: 950n * L, positions: pos(1, 50n * L), day: { start: 0, equity: 0n, funded: 0n }, peak: 0n }), market([tok(1, { price: 0.5 })], { reduce_only: true }), c, NOW, 10);
    expect(exits.actions.map((a) => a.rule)).toEqual(["stop_loss"]);
  });

  test("the simulation right before sending must match the quote, and the marginal price must not have moved", () => {
    const q: Quote = { out: 1_000_000n, impact_bps: 10, venue: "sim", probe: { in: 10_000n, out: 10_100n } };
    const pre = { quote: q, sim_tolerance_bps: 100, state_drift_bps: 100 };
    expect(() => preTradeCheck(pre, { out: 990_000n, probeOut: 10_000n })).not.toThrow(); // exactly 1% and 0.99%
    expect(() => preTradeCheck(pre, { out: 989_999n, probeOut: 10_100n })).toThrow(/sim_mismatch/);
    expect(() => preTradeCheck(pre, { out: 1_010_001n, probeOut: 10_100n })).toThrow(/sim_mismatch/); // better than quoted is a mismatch too
    expect(() => preTradeCheck(pre, { out: 1_000_000n, probeOut: 9_998n })).toThrow(/state_drift/);
    expect(() => preTradeCheck({ ...pre, quote: { ...q, out: 0n } }, { out: 5n, probeOut: 10_100n })).toThrow(PreTradeRefusal);
  });

  test("a pool that moved between the quote and the send refuses the trade before anything is taken", async () => {
    const v = new SimVenue();
    v.addPool(M(1), { base: 1_000_000n * L, quote: 100_000n * L, fee_bps: 100, decimals: 6 });
    const key = { id: "treasury", secret: new Uint8Array(64) };
    v.fund(key.id, 1000n * L);
    const t = tok(1);
    const q = await v.quote(key, t, "buy", 10n * L);
    const pre = { quote: q, sim_tolerance_bps: 100, state_drift_bps: 100 };
    v.shock(M(1), true, 3_000n * L); // someone buys 3% of the pool's quote side in between
    await expect(v.execute(key, t, "buy", 10n * L, 1n, pre)).rejects.toBeInstanceOf(PreTradeRefusal);
    expect((await v.balances(key.id, [M(1)])).line).toBe(1000n * L);
    // unchanged pool: the same call goes through
    const q2 = await v.quote(key, t, "buy", 10n * L);
    const fill = await v.execute(key, t, "buy", 10n * L, 1n, { ...pre, quote: q2 });
    expect(fill.amount_out).toBe(q2.out);
  });
});

// ------------------------------------------------------------------------------------------------
// through the trader and a real Core (in process): the circuit breaker, and the risk rules as the
// loop applies them (Core's network view, its own dry run, the venue's pre-trade check)

import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectOk, makeAuthor, setup, type Agent, type Env } from "../../core/test/helpers.ts";
import { LEGACY_LIMITS } from "../../core/test/legacy-limits.ts";
import { emptyUsage } from "../src/analyst.ts";
import { Trader, type MarketToken } from "../src/trader.ts";

const dirs: string[] = [];
const envs: Env[] = [];
afterEach(() => {
  while (envs.length) envs.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

type A = Agent & { mint: string };
async function loop(config: Record<string, unknown>, script: (me: A, all: A[]) => string, o: { failExecute?: () => boolean; facts?: (a: A, env: Env) => MarketToken["facts"] } = {}) {
  const env = await setup({ verifiers: 3 });
  envs.push(env);
  const venue = new SimVenue();
  const agents: A[] = [];
  for (let i = 0; i < 3; i++) {
    const a = await makeAuthor(env);
    const mint = env.core.db.query<{ mint: string }, [string]>("SELECT mint FROM agents WHERE agent_id = ?").get(a.id)!.mint;
    agents.push({ ...a, mint });
    venue.addPool(mint, { base: 1_000_000n * L, quote: 100_000n * L, fee_bps: 100, decimals: 6 });
    venue.fund(a.key.id, 1000n * L);
  }
  await expectOk(env.admin.c.post("/v1/admin/trading/config", { ...LEGACY_LIMITS, round_s: 60, cooldown_s: 0, min_hold_s: 0, ...config }));
  if (o.failExecute) {
    const exec = venue.execute.bind(venue);
    venue.execute = async (...a: Parameters<typeof exec>) => {
      if (o.failExecute!()) throw new Error("transaction failed: BlockhashNotFound");
      return exec(...a);
    };
  }
  const dir = mkdtempSync(join(tmpdir(), "units-trader-risk-"));
  dirs.push(dir);
  const calls: string[] = [];
  const trader = new Trader({
    core: env.base, runtimeKey: env.admin.key, venue, stateDir: dir, lineDecimals: 6, now: () => env.clock.now(), log: () => {},
    tokens: async () => agents.map((a) => ({ mint: a.mint, agent: a.id, price: venue.price(a.mint), decimals: 6, change_24h: null, venue: "sim" as const, ...(o.facts ? { facts: o.facts(a, env) } : {}), info: { symbol: "T", phase: "curve", volume_24h: null, trades_24h: null, holders: null, curve_progress: null, repo_url: null, class: null, lineage_id: env.lineage } })),
    agents: async () => agents.map((a) => ({ agent: a.id, mint: a.mint, key: a.key })),
    analysis: {
      model: async (agent) => ({ model: { id: "test/scripted", complete: async () => (calls.push(agent), { text: script(agents.find((a) => a.id === agent)!, agents), usage: { ...emptyUsage(), usd: 0.001, calls: 1 } }) } }),
      room: () => 1, meter: () => {}, post: async () => "msg",
    },
  });
  const records = async () => (await expectOk(env.anon.get("/v1/trades?limit=500"))).records.reverse() as any[];
  const step = async (n = 1) => {
    for (let i = 0; i < n; i++) (await trader.tick(), env.clock.advance(61_000));
  };
  return { env, venue, agents, trader, calls, records, step };
}
const say = (action: string, token: string | null, size: number) => JSON.stringify({ thesis: "Public accepted work is strong and the token trades with depth.", action, token, size_pct: size, reason: "public record" });

describe("the loop", () => {
  test("circuit breaker: three failed transactions within the window halt the agent until a reset; the others keep going", async () => {
    let failing: string | null = null;
    const w = await loop({ breaker_failures: 3, breaker_window_s: 3600 }, (me, all) => say("buy", all[(all.indexOf(me) + 1) % all.length]!.mint, 1));
    failing = w.agents[0]!.key.id;
    const exec = w.venue.execute.bind(w.venue);
    w.venue.execute = async (owner, ...rest) => {
      if (owner.id === failing) throw new Error("transaction failed: BlockhashNotFound");
      return exec(owner, ...rest);
    };
    await w.step(3);
    const recs = await w.records();
    const halts = recs.filter((r) => r.kind === "halt");
    expect(halts.map((h) => [h.agent, h.rule])).toEqual([[w.agents[0]!.id, "breaker"]]);
    expect(halts[0].reason).toMatch(/^3 failed or refused transactions within 3600 s \(last: execution_failed/);
    expect(recs.filter((r) => r.kind === "decision" && r.agent === w.agents[0]!.id && r.rule === "execution_failed").length).toBe(3);
    // halted: no further analysis round for it, while the others trade on
    const before = w.calls.filter((c) => c === w.agents[0]!.id).length;
    await w.step(2);
    expect(w.calls.filter((c) => c === w.agents[0]!.id).length).toBe(before);
    expect((await w.records()).filter((r) => r.kind === "trade" && r.agent !== w.agents[0]!.id).length).toBeGreaterThan(2);
    expect((await expectOk(w.env.anon.get(`/v1/agents/${w.agents[0]!.id}/risk`))).halt).toMatchObject({ rule: "breaker", until: null });
    // the admin resets it; with the venue healthy again it trades
    await expectOk(w.env.admin.c.post(`/v1/agents/${w.agents[0]!.id}/trading/reset`, {}));
    failing = null;
    await w.step(1);
    expect((await w.records()).some((r) => r.kind === "trade" && r.agent === w.agents[0]!.id)).toBe(true);
  });

  test("herding and the wash guard across agents: the third buyer of one token is refused, and nobody sells what another just bought", async () => {
    // every agent wants the last agent's token; the last one wants to sell... nothing (it holds none), so it holds
    const w = await loop({ herd_max_agents: 1, herd_window_s: 3600, wash_window_s: 86_400 }, (me, all) => (me === all[2] ? say("hold", null, 0) : say("buy", all[2]!.mint, 1)));
    await w.step(1);
    const recs = await w.records();
    expect(recs.filter((r) => r.kind === "trade").map((r) => r.agent)).toEqual([w.agents[0]!.id]);
    expect(recs.filter((r) => r.kind === "decision" && r.outcome === "refused").map((r) => [r.agent, r.rule])).toEqual([[w.agents[1]!.id, "herd_limit"]]);
    const risk = await expectOk(w.env.anon.get("/v1/trading/risk"));
    expect(risk.tokens.find((t: any) => t.mint === w.agents[2]!.mint).recent.map((x: any) => [x.agent, x.side])).toEqual([[w.agents[0]!.id, "buy"]]);
  });

  test("the kill switch through the loop: reduce-only stops the buys of every agent in the next tick", async () => {
    const w = await loop({}, (me, all) => say("buy", all[(all.indexOf(me) + 1) % all.length]!.mint, 1));
    await w.step(1);
    const n = (await w.records()).filter((r) => r.kind === "trade").length;
    expect(n).toBe(3);
    await expectOk(w.env.admin.c.post("/v1/admin/trading/reduce-only", { on: true, reason: "drill" }));
    await w.step(2);
    const recs = await w.records();
    expect(recs.filter((r) => r.kind === "trade").length).toBe(n);
    expect(new Set(recs.filter((r) => r.kind === "decision" && r.outcome === "refused").map((r) => r.rule))).toEqual(new Set(["reduce_only"]));
  });

  test("market facts through the loop: no buy before an hour of price samples, none on a stale price", async () => {
    const fresh = (_a: A, env: Env) => ({ liquidity: 100_000n * L, holders: 20, move_1h: null, price_at: env.clock.now() - 1000, market_cap: 100_000_000n * L });
    const w = await loop({ eligibility_min_liquidity_line: "1", eligibility_min_holders: 1 }, (me, all) => say("buy", all[(all.indexOf(me) + 1) % all.length]!.mint, 1), { facts: fresh });
    await w.step(1);
    expect(new Set((await w.records()).filter((r) => r.kind === "decision").map((r) => r.rule))).toEqual(new Set(["price_history"]));
    await w.step(56); // 56 more minutes of samples
    expect((await w.records()).some((r) => r.kind === "trade")).toBe(true);
    const stale = await loop({ eligibility_min_liquidity_line: "1", eligibility_min_holders: 1 }, (me, all) => say("buy", all[(all.indexOf(me) + 1) % all.length]!.mint, 1), { facts: (_a, env) => ({ liquidity: 100_000n * L, holders: 20, move_1h: null, price_at: env.clock.now() - 121_000, market_cap: 100_000_000n * L }) });
    await stale.step(1);
    expect(new Set((await stale.records()).filter((r) => r.kind === "decision").map((r) => r.rule))).toEqual(new Set(["stale_price"]));
  });
});
