import { describe, expect, test } from "bun:test";
import { mergeTradingConfig, TRADING_DEFAULTS, type TradingConfig } from "../../core/src/scores.ts";
import { checkTrade, composite, enforceDecision, equityOf, haltCheck, parseDecision, riskExits, valueOf, type Book, type Market, type ModelDecision, type Position, type TokenView } from "../src/policy.ts";

// Unit tests of the engine (plan T, owner amendment 2026-10-10): the decision schema the agent's model
// must meet, every risk limit and integrity rule enforced on the model's decision (adversarial outputs
// included: nothing is clamped, every bad decision is refused with its rule), and the risk exits.

const NOW = Date.UTC(2026, 9, 10, 12);
const L = 1_000_000n; // one tLINE in base units
const cfg = (over: Record<string, unknown> = {}): TradingConfig => mergeTradingConfig(TRADING_DEFAULTS, over);
const agg = TRADING_DEFAULTS.temperaments.aggressive;
const careful = TRADING_DEFAULTS.temperaments.careful;
const M = (i: number | string) => `Tok${i}x`.padEnd(40, "z");

function tok(i: number, over: Partial<TokenView> = {}): TokenView {
  return { mint: M(i), agent: `A${i}`, parties: [`L${i}`], price: 1, decimals: 6, change_24h: 0, venue: "sim", ...over };
}
function book(over: Partial<Book> = {}): Book {
  return { agent: "ME", mint: M("ME"), parties: ["LME"], line: 1000n * L, sol: 1_000_000_000n, positions: {}, day: { start: NOW - 3600_000, equity: 1000n * L, funded: 0n }, peak: 1000n * L, halted: null, blackout: false, ...over };
}
function market(tokens: TokenView[], scores: Record<string, [number, number | null]> = {}): Market {
  return { tokens, scores: new Map(Object.entries(scores).map(([a, [now, ref]]) => [a, { now, ref }])), lineDecimals: 6 };
}
function pos(mint: string, qty: bigint, cost: bigint, over: Partial<Position> = {}): Position {
  return { mint, qty, cost, opened_at: NOW - 7200_000, last_side: "buy", last_at: NOW - 7200_000, ...over };
}
const dec = (over: Partial<ModelDecision> = {}): ModelDecision => ({ thesis: "Strong accepted work this week and rising volume.", action: "buy", token: M(1), size_pct: 3, reason: "best public record", ...over });
const J = (o: unknown) => JSON.stringify(o);

describe("decision schema (the model's output is untrusted)", () => {
  test("a valid decision parses; a single json fence is allowed", () => {
    const ok = parseDecision(J(dec()));
    expect(ok.ok).toBe(true);
    expect(parseDecision("```json\n" + J(dec()) + "\n```").ok).toBe(true);
    expect(parseDecision(J({ thesis: "Nothing stands out against my positions today.", action: "hold", token: null, size_pct: 0, reason: "no edge" })).ok).toBe(true);
  });
  const bad: [string, unknown][] = [
    ["prose around the JSON", `I think so. ${J(dec())}`],
    ["two objects", J(dec()) + J(dec())],
    ["an array", J([dec()])],
    ["an extra field", J({ ...dec(), max_trade_bps: 10000 })],
    ["a missing field", J({ thesis: dec().thesis, action: "buy", token: M(1), size_pct: 3 })],
    ["an unknown action", J(dec({ action: "short" as any }))],
    ["a buy without a token", J(dec({ token: null }))],
    ["a hold with a token", J(dec({ action: "hold", size_pct: 0 }))],
    ["a hold with a size", J(dec({ action: "hold", token: null, size_pct: 1 }))],
    ["size 0", J(dec({ size_pct: 0 }))],
    ["a negative size", J(dec({ size_pct: -5 }))],
    ["size above 100", J(dec({ size_pct: 101 }))],
    ["size as a string", J({ ...dec(), size_pct: "3" })],
    ["a non-finite size", J(dec()).replace('"size_pct":3', '"size_pct":1e400')],
    ["a token that is no address", J(dec({ token: "../../etc" }))],
    ["a thesis too short", J(dec({ thesis: "buy" }))],
    ["a thesis too long", J(dec({ thesis: "x".repeat(1201) }))],
    ["an em dash", J(dec({ reason: "best record — trust me" }))],
    ["no text", ""],
    ["not JSON", "{action: buy}"],
  ];
  for (const [name, text] of bad)
    test(`refused: ${name}`, () => {
      const r = parseDecision(text as string);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.rule).toBe("invalid_decision");
    });
});

describe("every limit enforced on the model's decision (adversarial outputs are refused, never clamped)", () => {
  const m = market([tok(1), tok(2), tok(3)], { A1: [0.9, null], A2: [0.5, null] });
  const go = (d: Partial<ModelDecision>, b = book(), c = cfg(), t = agg, left = 100, mk = m) => enforceDecision(b, mk, c, t, dec(d), NOW, left);
  const rule = (r: ReturnType<typeof enforceDecision>) => (r.ok ? "ok" : r.refusal.rule);

  test("a buy inside every limit becomes one exact trade with the model's reason", () => {
    const r = go({ size_pct: 3 });
    expect(r.ok && r.action?.amount).toBe(30n * L);
    expect(r.ok && r.action?.rule).toBe("agent_decision");
    expect(r.ok && r.action?.reason).toBe("best public record");
  });
  test("max per trade (3%): 3.01% is refused, not resized", () => expect(rule(go({ size_pct: 3.01 }))).toBe("temperament_size"));
  test("the temperament's own bound: careful refuses 2%", () => expect(rule(go({ size_pct: 2 }, book(), cfg(), careful))).toBe("temperament_size"));
  test("max per trade binds even when the temperament allows more", () => {
    const c = cfg({ temperaments: { aggressive: { size_bps: 900 } } });
    expect(rule(go({ size_pct: 5 }, book(), c, c.temperaments.aggressive))).toBe("max_trade");
  });
  test("100% of treasury in one trade: refused", () => expect(rule(go({ size_pct: 100 }))).toBe("temperament_size"));
  test("more than two decimals: refused, not rounded", () => expect(rule(go({ size_pct: 1.005 }))).toBe("invalid_decision"));
  test("max position (10% per token)", () => {
    const b = book({ line: 920n * L, positions: { [M(1)]: pos(M(1), 80n * L, 80n * L) } });
    expect(rule(go({ size_pct: 2 }, b))).toBe("ok");
    expect(rule(go({ size_pct: 2.1 }, b))).toBe("max_position");
  });
  test("max open positions (8)", () => {
    const positions = Object.fromEntries([4, 5, 6, 7, 8, 9, 10, 11].map((i) => [M(i), pos(M(i), L, L)]));
    const mk = market([tok(1), ...[4, 5, 6, 7, 8, 9, 10, 11].map((i) => tok(i))]);
    expect(rule(go({ size_pct: 1 }, book({ positions }), cfg(), agg, 100, mk))).toBe("max_open_positions");
  });
  test("daily loss (5%) and drawdown (20%): refused, with the halt", () => {
    expect(rule(go({}, book({ line: 940n * L })))).toBe("daily_loss");
    expect(rule(go({}, book({ line: 790n * L, day: { start: NOW, equity: 790n * L, funded: 0n } }), cfg()))).toBe("max_drawdown");
    expect(rule(go({}, book({ halted: { rule: "max_drawdown", since: NOW - 1, until: null } })))).toBe("halted");
  });
  test("cooldown (10 min) and minimum hold (30 min, opposite side)", () => {
    expect(rule(go({}, book({ positions: { [M(1)]: pos(M(1), L, L, { last_at: NOW - 599_000 }) } })))).toBe("cooldown");
    expect(rule(go({ action: "sell", size_pct: 100 }, book({ positions: { [M(1)]: pos(M(1), 10n * L, 10n * L, { last_at: NOW - 1799_000 }) } }), cfg({ cooldown_s: 0 })))).toBe("integrity_min_hold");
  });
  test("global trade rate, gas reserve, minimum trade, funds", () => {
    expect(rule(go({}, book(), cfg(), agg, 0))).toBe("global_rate");
    expect(rule(go({}, book({ sol: 1n })))).toBe("gas");
    expect(rule(go({ size_pct: 0.09 }))).toBe("min_trade");
    // equity is mostly a position here: 3% of equity is more cash than the treasury holds
    const b = book({ line: 10n * L, positions: { [M(2)]: pos(M(2), 990n * L, 990n * L) } });
    expect(rule(go({ size_pct: 3 }, b))).toBe("funds");
  });
  test("selling what is not held, or a token not in the list", () => {
    expect(rule(go({ action: "sell", size_pct: 50 }))).toBe("no_position");
    expect(rule(go({ token: M(99) }))).toBe("unknown_token");
  });
  test("a sell of a percent of the position is exact", () => {
    const r = go({ action: "sell", size_pct: 25 }, book({ positions: { [M(1)]: pos(M(1), 40n * L, 40n * L) } }));
    expect(r.ok && r.action?.amount).toBe(10n * L);
  });
  test("a hold trades nothing", () => {
    const r = go({ action: "hold", token: null, size_pct: 0 });
    expect(r.ok && r.action).toBeNull();
  });
});

describe("integrity rules on the model's decision (attempts to break each)", () => {
  const go = (d: Partial<ModelDecision>, mk: Market, b = book()) => enforceDecision(b, mk, cfg(), agg, dec(d), NOW, 100);
  test("its own token, by mint, is refused", () => {
    const r = go({ token: M("ME") }, market([tok(1), { ...tok(9), mint: M("ME"), agent: "ME" }]));
    expect(!r.ok && r.refusal.rule).toBe("integrity_own_token");
  });
  test("a same-launcher agent's token is refused", () => {
    const r = go({ token: M(1) }, market([tok(1, { parties: ["LME"] })]));
    expect(!r.ok && r.refusal.rule).toBe("integrity_same_party");
  });
  test("an excluded agent's token is refused", () => {
    const r = go({ token: M(1) }, market([tok(1, { excluded: true })]));
    expect(!r.ok && r.refusal.rule).toBe("integrity_excluded");
  });
  test("during its own verdict window nothing trades and the refusal is private", () => {
    const r = go({}, market([tok(1)]), book({ blackout: true }));
    expect(!r.ok && r.refusal.rule).toBe("verdict_window");
    expect(!r.ok && r.refusal.private).toBe(true);
  });
});

describe("risk exits and limits", () => {
  test("stop-loss sells all at -15%, take-profit sells half at +40%, not before", () => {
    const b = book({ positions: { [M(1)]: pos(M(1), 100n * L, 100n * L) } });
    const at = (price: number) => riskExits(b, market([tok(1, { price })]), cfg(), NOW, 100).actions;
    expect(at(0.86)).toHaveLength(0);
    expect(at(0.85)[0]?.rule).toBe("stop_loss");
    expect(at(0.85)[0]?.amount).toBe(100n * L);
    expect(at(1.39)).toHaveLength(0);
    expect(at(1.4)[0]?.rule).toBe("take_profit");
    expect(at(1.4)[0]?.amount).toBe(50n * L);
  });
  test("a stop-loss inside the minimum hold waits (the integrity rule binds the exits too)", () => {
    const b = book({ positions: { [M(1)]: pos(M(1), 100n * L, 100n * L, { last_at: NOW - 60_000 }) } });
    const d = riskExits(b, market([tok(1, { price: 0.5 })]), cfg({ cooldown_s: 0 }), NOW, 100);
    expect(d.actions).toHaveLength(0);
    expect(d.refused.some((r) => r.rule === "integrity_min_hold")).toBe(true);
  });
  test("daily loss is netted against today's funding; drawdown against the funded peak", () => {
    const E = 1000n * L;
    expect(haltCheck(book(), E - 50n * L, cfg())).toBeNull();
    expect(haltCheck(book(), E - 51n * L, cfg())?.rule).toBe("daily_loss");
    expect(haltCheck(book({ day: { start: NOW, equity: E, funded: 100n * L }, peak: E + 100n * L }), E + 40n * L, cfg())?.rule).toBe("daily_loss");
    expect(haltCheck(book(), E - 201n * L, cfg({ daily_loss_bps: 10_000 }))?.rule).toBe("max_drawdown");
  });
  test("checkTrade: max position, per trade, cooldown boundaries", () => {
    const t = tok(1);
    const e = equityOf(book(), market([t]));
    expect(checkTrade(book(), t, "buy", 30n * L, 30n * L, e, cfg(), NOW, 100)).toBeNull();
    expect(checkTrade(book(), t, "buy", 31n * L, 31n * L, e, cfg(), NOW, 100)?.rule).toBe("max_trade");
    expect(checkTrade(book({ positions: { [M(1)]: pos(M(1), L, L, { last_at: NOW - 600_000 }) } }), t, "buy", L, L, e, cfg(), NOW, 100)).toBeNull();
  });
  test("project quality dominates momentum in the published composite", () => {
    expect(composite(0.8, -0.5, 0.15).composite).toBeGreaterThan(composite(0.2, 0.5, 0.15).composite);
    expect(valueOf(2n * L, 1.5, 6, 6)).toBe(3n * L);
  });
});

describe("own-token holding (launch fronting: the launcher's 1% initial buy is held, not traded)", () => {
  const own = tok(9, { mint: M("ME"), agent: "ME", parties: ["LME"], price: 0.5 });
  // as if a position in its own token had appeared anyway (state edited, an older build): still never sold
  const holding = pos(M("ME"), 1_000_000_000_000n, 1n, { last_at: NOW - 86_400_000 });
  test("the model's sell of its own token is refused with integrity_own_token, at any size", () => {
    const b = book({ own_held: 1_000_000_000_000n, positions: { [M("ME")]: holding } });
    for (const size_pct of [1, 50, 100]) {
      const r = enforceDecision(b, market([own, tok(1)]), cfg(), agg, dec({ action: "sell", token: M("ME"), size_pct }), NOW, 10);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.refusal.rule).toBe("integrity_own_token");
    }
  });
  test("a buy of its own token is refused too", () => {
    const r = enforceDecision(book({ own_held: 1n }), market([own]), cfg(), agg, dec({ action: "buy", token: M("ME"), size_pct: 1 }), NOW, 10);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.rule).toBe("integrity_own_token");
  });
  test("checkTrade refuses a sell of it directly", () => {
    const no = checkTrade(book({ positions: { [M("ME")]: holding } }), own, "sell", 1n, 1n, 1000n * L, cfg(), NOW, 10);
    expect(no?.rule).toBe("integrity_own_token");
  });
  test("risk exits never sell it, at a stop-loss price or a take-profit price, and add no refusal noise", () => {
    for (const price of [0.0000001, 1_000_000]) {
      const d = riskExits(book({ own_held: 1_000_000_000_000n, positions: { [M("ME")]: holding } }), market([{ ...own, price }]), cfg(), NOW, 10);
      expect(d.actions).toEqual([]);
      expect(d.refused.filter((r) => r.mint === M("ME"))).toEqual([]);
    }
  });
  test("it is not counted in equity, so its price can neither halt nor size trades", () => {
    const b0 = book();
    const b1 = book({ own_held: 1_000_000_000_000n });
    expect(equityOf(b1, market([own]))).toBe(equityOf(b0, market([own])));
  });
});
