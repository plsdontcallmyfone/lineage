import { describe, expect, test } from "bun:test";
import { mergeTradingConfig, TRADING_DEFAULTS, type TradingConfig } from "../../core/src/scores.ts";
import { checkTrade, composite, decide, equityOf, haltCheck, valueOf, type Book, type Market, type Position, type TokenView } from "../src/policy.ts";

// Unit tests of the deterministic policy engine and of every risk limit (plan T exit).

const NOW = Date.UTC(2026, 9, 10, 12);
const L = 1_000_000n; // one tLINE in base units
const cfg = (over: Record<string, unknown> = {}): TradingConfig => mergeTradingConfig(TRADING_DEFAULTS, over);
const agg = TRADING_DEFAULTS.temperaments.aggressive;

function tok(i: number, over: Partial<TokenView> = {}): TokenView {
  return { mint: `M${i}`, agent: `A${i}`, parties: [`L${i}`], price: 1, decimals: 6, change_24h: 0, venue: "sim", ...over };
}
function book(over: Partial<Book> = {}): Book {
  return { agent: "ME", mint: "MME", parties: ["LME"], line: 1000n * L, sol: 1_000_000_000n, positions: {}, day: { start: NOW - 3600_000, equity: 1000n * L, funded: 0n }, peak: 1000n * L, halted: null, blackout: false, ...over };
}
function market(tokens: TokenView[], scores: Record<string, [number, number | null]>): Market {
  return { tokens, scores: new Map(Object.entries(scores).map(([a, [now, ref]]) => [a, { now, ref }])), lineDecimals: 6 };
}
function pos(mint: string, qty: bigint, cost: bigint, over: Partial<Position> = {}): Position {
  return { mint, qty, cost, opened_at: NOW - 7200_000, last_side: "buy", last_at: NOW - 7200_000, ...over };
}

describe("policy", () => {
  test("deterministic: the same inputs give the same decision", () => {
    const m = market([tok(1), tok(2), tok(3)], { A1: [0.9, 0.8], A2: [0.5, 0.6], A3: [0.1, null] });
    const a = decide(book(), m, cfg(), agg, NOW, 100);
    const b = decide(book(), m, cfg(), agg, NOW, 100);
    expect(JSON.stringify(a, (_, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(JSON.stringify(b, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
    expect(a.actions.length).toBeGreaterThan(0);
  });

  test("buys follow high and rising scores, biggest composite first; each carries rule, reason and score", () => {
    const m = market([tok(1), tok(2), tok(3)], { A1: [0.9, 0.9], A2: [0.15, 0.1], A3: [0.05, 0.05] });
    const d = decide(book(), m, cfg(), agg, NOW, 100);
    expect(d.actions.map((a) => [a.side, a.mint, a.rule])).toEqual([
      ["buy", "M1", "score_high"],
      ["buy", "M2", "score_rising"],
    ]);
    for (const a of d.actions) {
      expect(a.reason.length).toBeGreaterThan(10);
      expect(a.score.project).toBeGreaterThan(0);
      // max per trade: 3% of equity
      expect(a.amount).toBe(30n * L);
    }
  });

  test("project quality dominates momentum", () => {
    const good = composite(0.8, -0.5, 0.15).composite;
    const hyped = composite(0.2, 0.5, 0.15).composite;
    expect(good).toBeGreaterThan(hyped);
  });

  test("temperaments: careful trades less and smaller than aggressive", () => {
    const m = market([tok(1), tok(2), tok(3)], { A1: [0.9, null], A2: [0.45, null], A3: [0.3, null] });
    const a = decide(book(), m, cfg(), TRADING_DEFAULTS.temperaments.aggressive, NOW, 100);
    const c = decide(book(), m, cfg(), TRADING_DEFAULTS.temperaments.careful, NOW, 100);
    expect(a.actions.length).toBeGreaterThan(c.actions.length);
    expect(c.actions[0]!.amount).toBeLessThan(a.actions[0]!.amount);
  });

  test("stop-loss sells all; take-profit sells part; falling and low scores sell; rotation trims outside the top", () => {
    const t = [tok(1, { price: 0.8 }), tok(2, { price: 1.5 }), tok(3), tok(4), tok(5)];
    const positions = {
      M1: pos("M1", 50n * L, 50n * L), // marked 40 vs cost 50: -20%
      M2: pos("M2", 40n * L, 40n * L), // marked 60 vs cost 40: +50%
      M3: pos("M3", 40n * L, 40n * L),
      M4: pos("M4", 40n * L, 40n * L),
      M5: pos("M5", 40n * L, 40n * L),
    };
    const m = market(t, { A1: [0.9, 0.9], A2: [0.9, 0.9], A3: [0.5, 0.7], A4: [0, 0], A5: [0.3, 0.3] });
    const d = decide(book({ positions }), m, cfg(), { ...agg, max_actions_per_tick: 10, top_k: 3 }, NOW, 100);
    const by = Object.fromEntries(d.actions.filter((a) => a.side === "sell").map((a) => [a.mint, a]));
    expect(by.M1!.rule).toBe("stop_loss");
    expect(by.M1!.amount).toBe(50n * L);
    expect(by.M2!.rule).toBe("take_profit");
    expect(by.M2!.amount).toBe(20n * L); // take_profit_sell_bps 5000
    expect(by.M3!.rule).toBe("score_falling");
    expect(by.M4!.rule).toBe("score_low");
    expect(by.M5!.rule).toBe("rotate");
  });
});

describe("every risk limit", () => {
  const T = tok(1);
  const E = 1000n * L;
  const go = (b: Book, side: "buy" | "sell", amount: bigint, c = cfg(), left = 100, t = T) => checkTrade(b, t, side, amount, side === "buy" ? amount : valueOf(amount, t.price, 6, 6), equityOf(b, market([t], {})), c, NOW, left);

  test("max position: 10% of treasury per token", () => {
    const b = book({ line: 920n * L, positions: { M1: pos("M1", 80n * L, 80n * L) } });
    expect(go(b, "buy", 20n * L)).toBeNull();
    expect(go(b, "buy", 21n * L)?.rule).toBe("max_position");
  });
  test("max per trade: 3% of treasury", () => {
    expect(go(book(), "buy", 30n * L)).toBeNull();
    expect(go(book(), "buy", 31n * L)?.rule).toBe("max_trade");
  });
  test("max open positions: 8", () => {
    const positions = Object.fromEntries([2, 3, 4, 5, 6, 7, 8, 9].map((i) => [`M${i}`, pos(`M${i}`, L, L)]));
    expect(go(book({ positions }), "buy", 10n * L)?.rule).toBe("max_open_positions");
    expect(go(book({ positions: { ...positions, M1: pos("M1", L, L) } }), "buy", 10n * L)).toBeNull(); // adding to an open one is fine
  });
  test("daily loss: 5%, net of today's funding, then halt", () => {
    const c = cfg();
    expect(haltCheck(book({ day: { start: NOW, equity: E, funded: 0n } }), E - 50n * L, c)).toBeNull();
    expect(haltCheck(book({ day: { start: NOW, equity: E, funded: 0n } }), E - 51n * L, c)?.rule).toBe("daily_loss");
    // a deposit today does not hide a loss
    expect(haltCheck(book({ day: { start: NOW, equity: E, funded: 100n * L }, peak: E + 100n * L }), E + 40n * L, c)?.rule).toBe("daily_loss");
    // halted: nothing trades
    const d = decide(book({ line: E - 60n * L }), market([T], { A1: [0.9, null] }), c, agg, NOW, 100);
    expect(d.halt?.rule).toBe("daily_loss");
    expect(d.actions).toHaveLength(0);
  });
  test("max drawdown: 20% from peak, halt until reset", () => {
    const c = cfg({ daily_loss_bps: 10_000 });
    expect(haltCheck(book({ peak: E }), E - 200n * L, c)).toBeNull();
    expect(haltCheck(book({ peak: E }), E - 201n * L, c)?.rule).toBe("max_drawdown");
    expect(go(book({ halted: { rule: "max_drawdown", since: NOW - 1, until: null } }), "buy", L)?.rule).toBe("halted");
  });
  test("stop-loss 15% and take-profit 40% trigger at their thresholds and not before", () => {
    const m = (price: number) => market([tok(1, { price })], { A1: [0.9, 0.9] });
    const b = book({ positions: { M1: pos("M1", 100n * L, 100n * L) } });
    expect(decide(b, m(0.86), cfg(), agg, NOW, 100).actions.find((a) => a.side === "sell")).toBeUndefined();
    expect(decide(b, m(0.85), cfg(), agg, NOW, 100).actions.find((a) => a.side === "sell")?.rule).toBe("stop_loss");
    expect(decide(b, m(1.39), cfg(), agg, NOW, 100).actions.find((a) => a.side === "sell")).toBeUndefined();
    expect(decide(b, m(1.4), cfg(), agg, NOW, 100).actions.find((a) => a.side === "sell")?.rule).toBe("take_profit");
  });
  test("per-agent cooldown: 10 min between trades in the same token", () => {
    const b = book({ positions: { M1: pos("M1", L, L, { last_at: NOW - 599_000 }) } });
    expect(go(b, "buy", L)?.rule).toBe("cooldown");
    b.positions.M1!.last_at = NOW - 600_000;
    expect(go(b, "buy", L)).toBeNull();
  });
  test("minimum hold: 30 min before the opposite side", () => {
    const b = book({ positions: { M1: pos("M1", 10n * L, 10n * L, { last_at: NOW - 1799_000 }) } });
    expect(go(b, "sell", 10n * L)?.rule).toBe("integrity_min_hold");
    b.positions.M1!.last_at = NOW - 1800_000;
    expect(go(b, "sell", 10n * L)).toBeNull();
  });
  test("global trade rate per epoch", () => {
    expect(go(book(), "buy", L, cfg(), 0)?.rule).toBe("global_rate");
    const d = decide(book(), market([tok(1), tok(2)], { A1: [0.9, null], A2: [0.9, null] }), cfg(), agg, NOW, 1);
    expect(d.actions).toHaveLength(1);
    expect(d.refused.some((r) => r.rule === "global_rate")).toBe(true);
  });
  test("gas reserve, minimum trade, funds", () => {
    expect(go(book({ sol: 9_999_999n }), "buy", L)?.rule).toBe("gas");
    expect(go(book(), "buy", L - 1n)?.rule).toBe("min_trade");
    expect(go(book({ line: 5n * L }), "buy", 6n * L)?.rule).toBe("funds");
  });
  test("max slippage and max price impact are enforced at execution (see sim.test.ts)", () => {
    expect(cfg().max_slippage_bps).toBe(200);
    expect(cfg().max_impact_bps).toBe(100);
  });
});

describe("integrity rules the policy enforces (attempts to break each)", () => {
  test("never its own token, even at the top score", () => {
    const m = market([tok(1, { agent: "ME", mint: "MME" }), tok(2)], { ME: [1, null], A2: [0.3, null] });
    const d = decide(book(), m, cfg(), agg, NOW, 100);
    expect(d.actions.map((a) => a.mint)).not.toContain("MME");
    expect(checkTrade(book(), tok(1, { agent: "ME", mint: "MME" }), "buy", L, L, 1000n * L, cfg(), NOW, 100)?.rule).toBe("integrity_own_token");
  });
  test("never a token whose agent shares a launcher, owner or operator", () => {
    const sib = tok(1, { parties: ["Lx", "LME"] });
    const d = decide(book(), market([sib, tok(2)], { A1: [1, null], A2: [0.3, null] }), cfg(), agg, NOW, 100);
    expect(d.actions.map((a) => a.mint)).not.toContain("M1");
    expect(checkTrade(book(), sib, "buy", L, L, 1000n * L, cfg(), NOW, 100)?.rule).toBe("integrity_same_party");
  });
  test("no opposite side within the minimum hold, even for a stop-loss", () => {
    const b = book({ positions: { M1: pos("M1", 100n * L, 100n * L, { opened_at: NOW - 60_000, last_at: NOW - 60_000 }) } });
    const d = decide(b, market([tok(1, { price: 0.5 })], { A1: [0.9, 0.9] }), cfg({ cooldown_s: 0 }), agg, NOW, 100);
    expect(d.actions.filter((a) => a.side === "sell")).toHaveLength(0);
    expect(d.refused.some((r) => r.rule === "integrity_min_hold")).toBe(true);
  });
  test("no trading in the window around its own candidate's verdict; the refusal is private", () => {
    const d = decide(book({ blackout: true }), market([tok(1)], { A1: [1, null] }), cfg(), agg, NOW, 100);
    expect(d.actions).toHaveLength(0);
    expect(d.refused.every((r) => r.private === true)).toBe(true);
  });
});
