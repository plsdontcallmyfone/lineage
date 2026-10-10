import type { TemperamentParams, TradingConfig } from "../../core/src/scores.ts";

// The deterministic policy engine (plan T). Given one agent's book, the market and the published
// scores, it returns the trades to place, each with its rule and reason, and the trades it refused
// with the limit that refused them. Same inputs, same output: no clock reads, no randomness, no model.
// Every risk limit and integrity rule is checked here (and the integrity rules again by Core when the
// trade is recorded, and slippage and price impact again at execution, against the simulation).

export interface TokenView {
  mint: string;
  /** the agent whose token this is */
  agent: string;
  /** launcher, registry owner and operator of that agent */
  parties: string[];
  /** tLINE per whole token (the pool price), null when unknown */
  price: number | null;
  decimals: number;
  /** 24 h price change as a fraction, null when unknown */
  change_24h: number | null;
  /** where it trades now; null: not tradable */
  venue: "dbc" | "damm_v2" | "sim" | null;
  /** the token's agent is excluded from trading (Core's trading config) */
  excluded?: boolean;
}

export interface Position {
  mint: string;
  /** token base units held */
  qty: bigint;
  /** $LINE base units paid for what is held (cost basis, reduced pro rata on sells) */
  cost: bigint;
  opened_at: number;
  last_side: "buy" | "sell";
  last_at: number;
}

export interface Book {
  agent: string;
  /** the agent's own token */
  mint: string | null;
  parties: string[];
  /** $LINE base units in the treasury */
  line: bigint;
  /** lamports on the treasury key (fees) */
  sol: bigint;
  positions: Record<string, Position>;
  /** equity at the start of the current UTC day, and $LINE funded since then */
  day: { start: number; equity: bigint; funded: bigint };
  /** highest equity seen, raised by fundings so that a deposit is not counted as gain */
  peak: bigint;
  halted: { rule: "daily_loss" | "max_drawdown"; since: number; until: number | null } | null;
  /** private: the agent's own candidate is open, or its verdict is within verdict_window_s (never published while open) */
  blackout: boolean;
}

export interface ScoreInput {
  /** published project score now */
  now: number;
  /** published project score score_lookback_s ago (null: no history yet) */
  ref: number | null;
}

export interface ScoreUsed {
  project: number;
  ref: number | null;
  delta: number | null;
  momentum: number | null;
  composite: number;
  rank: number | null;
}

export interface Action {
  side: "buy" | "sell";
  mint: string;
  /** buy: $LINE base units in; sell: token base units in */
  amount: bigint;
  rule: string;
  reason: string;
  score: ScoreUsed;
  /** expected value of the trade in $LINE base units at the mark price */
  value: bigint;
}

export interface Refusal {
  mint: string | null;
  side: "buy" | "sell" | null;
  rule: string;
  detail: string;
  /** private refusals (the verdict window) are never published */
  private?: boolean;
}

export interface Decision {
  actions: Action[];
  refused: Refusal[];
  /** a halt the policy raised this tick (to be published) */
  halt: { rule: "daily_loss" | "max_drawdown"; reason: string } | null;
  equity: bigint;
}

export interface Market {
  tokens: TokenView[];
  /** agent -> its published score now and at the lookback */
  scores: Map<string, ScoreInput>;
  /** $LINE decimals */
  lineDecimals: number;
}

/** Value in $LINE base units of `qty` token base units at `price` tLINE per whole token. */
export function valueOf(qty: bigint, price: number | null, decimals: number, lineDecimals: number): bigint {
  if (price === null || !Number.isFinite(price) || price <= 0 || qty <= 0n) return 0n;
  // exact enough: qty and the product stay well inside 2^53 for TEST sizes; floor so a mark never flatters
  return BigInt(Math.floor((Number(qty) / 10 ** decimals) * price * 10 ** lineDecimals));
}

export function equityOf(b: Book, m: Market): bigint {
  let e = b.line;
  const tok = new Map(m.tokens.map((t) => [t.mint, t]));
  for (const p of Object.values(b.positions)) {
    const t = tok.get(p.mint);
    if (t) e += valueOf(p.qty, t.price, t.decimals, m.lineDecimals);
  }
  return e;
}

const bps = (x: bigint, b: number) => (x * BigInt(Math.max(0, Math.floor(b)))) / 10_000n;

/** The composite: project quality dominates; momentum is a small secondary input. */
export function composite(project: number, change24h: number | null, momentumWeight: number): { composite: number; momentum: number | null } {
  const momentum = change24h === null || !Number.isFinite(change24h) ? null : Math.max(-0.5, Math.min(0.5, change24h)) + 0.5;
  const c = (1 - momentumWeight) * project + momentumWeight * (momentum ?? 0.5);
  return { composite: Math.round(c * 1e6) / 1e6, momentum };
}

/** Integrity rules on the token itself: own token, and tokens of agents sharing a party. */
export function integrityRefusal(b: Book, t: TokenView): Refusal | null {
  if (t.agent === b.agent || (b.mint !== null && t.mint === b.mint)) return { mint: t.mint, side: null, rule: "integrity_own_token", detail: "an agent never trades its own token" };
  const mine = new Set(b.parties);
  if (t.parties.some((p) => mine.has(p))) return { mint: t.mint, side: null, rule: "integrity_same_party", detail: "the token's agent shares a launcher, owner or operator" };
  if (t.excluded) return { mint: t.mint, side: null, rule: "integrity_excluded", detail: "the token's agent is excluded from trading" };
  return null;
}

/**
 * Checks one proposed trade against every limit. Returns null when it may go, else the refusal.
 * `book` must reflect the trades already accepted this tick.
 */
export function checkTrade(
  b: Book,
  t: TokenView,
  side: "buy" | "sell",
  amount: bigint,
  value: bigint,
  equity: bigint,
  cfg: TradingConfig,
  now: number,
  globalLeft: number,
  lineDecimals = 6,
): Refusal | null {
  const r = (rule: string, detail: string): Refusal => ({ mint: t.mint, side, rule, detail });
  const integ = integrityRefusal(b, t);
  if (integ) return { ...integ, side };
  if (b.halted) return r("halted", `halted by ${b.halted.rule}`);
  if (b.blackout) return { ...r("verdict_window", "own candidate open or its verdict is recent"), private: true };
  if (!t.venue) return r("not_tradable", "no pool to trade on");
  if (t.price === null) return r("no_price", "no pool price");
  if (globalLeft <= 0) return r("global_rate", `global trade rate reached (${cfg.global_trades_per_epoch} per ${cfg.trade_epoch_s} s)`);
  if (b.sol < BigInt(cfg.gas_reserve_lamports)) return r("gas", `treasury SOL ${b.sol} below the gas reserve ${cfg.gas_reserve_lamports}`);
  if (amount <= 0n) return r("zero", "nothing to trade");
  const p = b.positions[t.mint];
  if (p && now - p.last_at < cfg.cooldown_s * 1000) return r("cooldown", `last trade in this token ${Math.floor((now - p.last_at) / 1000)} s ago (cooldown ${cfg.cooldown_s} s)`);
  if (p && p.last_side !== side && now - p.last_at < cfg.min_hold_s * 1000)
    return r("integrity_min_hold", `no ${side} within ${cfg.min_hold_s} s of a ${p.last_side} in the same token`);
  if (side === "buy") {
    if (amount < BigInt(cfg.min_trade_line)) return r("min_trade", `below the minimum trade ${cfg.min_trade_line}`);
    if (amount > b.line) return r("funds", `treasury holds ${b.line} base units of $LINE`);
    if (amount > bps(equity, cfg.max_trade_bps)) return r("max_trade", `above ${cfg.max_trade_bps} bps of equity per trade`);
    const open = Object.values(b.positions).filter((x) => x.qty > 0n).length;
    if ((!p || p.qty === 0n) && open >= cfg.max_open_positions) return r("max_open_positions", `${open} positions open (max ${cfg.max_open_positions})`);
    const held = p ? valueOf(p.qty, t.price, t.decimals, lineDecimals) : 0n;
    if (held + value > bps(equity, cfg.max_position_bps)) return r("max_position", `position would exceed ${cfg.max_position_bps} bps of equity`);
  } else {
    if (!p || p.qty <= 0n) return r("no_position", "nothing held");
    if (amount > p.qty) return r("no_position", "selling more than held");
    if (value > 0n && value < BigInt(cfg.min_trade_line) && amount < p.qty) return r("min_trade", "a partial sell below the minimum trade");
  }
  return null;
}

/** Halts the policy raises from the book: daily loss (until the UTC day ends) and drawdown (until reset). */
export function haltCheck(b: Book, equity: bigint, cfg: TradingConfig): Decision["halt"] {
  if (b.halted) return null;
  // funding during the day is not gain: compare equity less what was funded today with the day's start
  const base = b.day.equity;
  const net = equity - b.day.funded;
  if (base > 0n && net < base - bps(base, cfg.daily_loss_bps))
    return { rule: "daily_loss", reason: `equity ${net} (net of ${b.day.funded} funded today) fell more than ${cfg.daily_loss_bps} bps below the day's start ${base}` };
  if (b.peak > 0n && equity < b.peak - bps(b.peak, cfg.max_drawdown_bps))
    return { rule: "max_drawdown", reason: `equity ${equity} fell more than ${cfg.max_drawdown_bps} bps below its peak ${b.peak}` };
  return null;
}

function fmtPct(x: number) {
  return `${(x * 100).toFixed(1)}%`;
}

/**
 * The deterministic risk exits, run before the agent's model each tick: a stop-loss sells the whole
 * position, a take-profit sells take_profit_sell_bps of it. They are limits, not opinions: the model
 * neither triggers nor delays them, and they pass every other check (minimum hold included).
 */
export function riskExits(b0: Book, m: Market, cfg: TradingConfig, now: number, globalLeft: number): Decision {
  const b: Book = { ...b0, positions: Object.fromEntries(Object.entries(b0.positions).map(([k, v]) => [k, { ...v }])) };
  const refused: Refusal[] = [];
  const actions: Action[] = [];
  const equity = equityOf(b, m);
  const halt = haltCheck(b, equity, cfg);
  if (halt) return { actions, refused: [{ mint: null, side: null, rule: halt.rule, detail: halt.reason }], halt, equity };
  if (b.halted) return { actions, refused: [{ mint: null, side: null, rule: "halted", detail: `halted by ${b.halted.rule}` }], halt: null, equity };
  if (b.blackout) return { actions, refused: [{ mint: null, side: null, rule: "verdict_window", detail: "own candidate", private: true }], halt: null, equity };
  const tokOf = new Map(m.tokens.map((t) => [t.mint, t]));
  let left = globalLeft;
  for (const p of Object.values(b.positions).sort((x, y) => (x.mint < y.mint ? -1 : 1))) {
    if (p.qty <= 0n) continue;
    const t = tokOf.get(p.mint);
    if (!t || t.price === null || p.cost <= 0n) continue;
    const mark = valueOf(p.qty, t.price, t.decimals, m.lineDecimals);
    const pnl = Number(mark - p.cost) / Number(p.cost);
    const s = m.scores.get(t.agent);
    const used: ScoreUsed = { project: s?.now ?? 0, ref: s?.ref ?? null, delta: null, momentum: null, composite: s?.now ?? 0, rank: null };
    let act: Action | null = null;
    if (mark <= p.cost - bps(p.cost, cfg.stop_loss_bps))
      act = { side: "sell", mint: p.mint, amount: p.qty, rule: "stop_loss", reason: `marked ${fmtPct(pnl)} against cost; stop-loss at -${cfg.stop_loss_bps / 100}%`, score: used, value: mark };
    else if (mark >= p.cost + bps(p.cost, cfg.take_profit_bps)) {
      const q = bps(p.qty, cfg.take_profit_sell_bps) || p.qty;
      act = { side: "sell", mint: p.mint, amount: q, rule: "take_profit", reason: `marked ${fmtPct(pnl)} against cost; take-profit at +${cfg.take_profit_bps / 100}% sells ${cfg.take_profit_sell_bps / 100}%`, score: used, value: valueOf(q, t.price, t.decimals, m.lineDecimals) };
    }
    if (!act) continue;
    const no = checkTrade(b, t, "sell", act.amount, act.value, equity, cfg, now, left, m.lineDecimals);
    if (no) {
      refused.push(no);
      continue;
    }
    actions.push(act);
    p.last_side = "sell";
    p.last_at = now;
    left--;
  }
  return { actions, refused, halt: null, equity };
}

// ------------------------------------------------------------------------------------------------
// The agent's own decision (owner amendment 2026-10-10): its model writes a thesis and one decision.
// The output is untrusted input: parsed strictly, every field checked, nothing clamped or resized.
// A decision that breaks the schema or any limit is refused with the rule, never executed.

export interface ModelDecision {
  thesis: string;
  action: "buy" | "sell" | "hold";
  /** the token's mint; null for a hold */
  token: string | null;
  /** buy: percent of treasury equity; sell: percent of the position; hold: 0 */
  size_pct: number;
  reason: string;
}

export const DECISION_KEYS = ["thesis", "action", "token", "size_pct", "reason"] as const;
export const THESIS_MAX = 1200;
export const REASON_MAX = 280;

/**
 * Parses the model's text into a decision. Accepts exactly one JSON object (a single surrounding
 * ```json fence is removed; nothing else is). Returns the decision or the refusal with its detail.
 */
export function parseDecision(text: string | null | undefined): { ok: true; decision: ModelDecision } | { ok: false; rule: "invalid_decision"; detail: string; thesis: string } {
  const fail = (detail: string, thesis = "") => ({ ok: false as const, rule: "invalid_decision" as const, detail, thesis });
  if (typeof text !== "string" || !text.trim()) return fail("the model returned no text");
  let t = text.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(t);
  if (fence) t = fence[1]!.trim();
  let j: unknown;
  try {
    j = JSON.parse(t);
  } catch {
    return fail("the output is not one JSON object");
  }
  if (typeof j !== "object" || j === null || Array.isArray(j)) return fail("the output is not one JSON object");
  const o = j as Record<string, unknown>;
  const thesis = typeof o.thesis === "string" ? o.thesis.slice(0, THESIS_MAX) : "";
  const keys = Object.keys(o);
  const extra = keys.filter((k) => !(DECISION_KEYS as readonly string[]).includes(k));
  if (extra.length) return fail(`unknown field(s): ${extra.slice(0, 5).join(", ")}`, thesis);
  for (const k of DECISION_KEYS) if (!(k in o)) return fail(`missing field ${k}`, thesis);
  if (typeof o.thesis !== "string" || o.thesis.trim().length < 20 || o.thesis.length > THESIS_MAX) return fail(`thesis must be 20 to ${THESIS_MAX} characters`, thesis);
  if (typeof o.reason !== "string" || o.reason.trim().length < 5 || o.reason.length > REASON_MAX) return fail(`reason must be 5 to ${REASON_MAX} characters`, thesis);
  if (/\u2014/.test(o.thesis + o.reason)) return fail("text contains an em dash", thesis);
  if (o.action !== "buy" && o.action !== "sell" && o.action !== "hold") return fail("action must be buy, sell or hold", thesis);
  if (typeof o.size_pct !== "number" || !Number.isFinite(o.size_pct)) return fail("size_pct must be a number", thesis);
  if (o.action === "hold") {
    if (o.token !== null) return fail("a hold names no token", thesis);
    if (o.size_pct !== 0) return fail("a hold has size_pct 0", thesis);
  } else {
    if (typeof o.token !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(o.token)) return fail("token must be a mint address from the list", thesis);
    if (!(o.size_pct > 0 && o.size_pct <= 100)) return fail("size_pct must be above 0 and at most 100", thesis);
  }
  return { ok: true, decision: { thesis: o.thesis.trim(), action: o.action, token: (o.token as string | null) ?? null, size_pct: o.size_pct, reason: o.reason.trim() } };
}

/**
 * Turns a valid decision into one trade, or refuses it with the rule that refuses it. Sizes are
 * computed exactly from the percent and checked as they are: a buy above the temperament's bound or
 * any limit is refused, not shrunk.
 */
export function enforceDecision(
  b: Book,
  m: Market,
  cfg: TradingConfig,
  temp: TemperamentParams,
  d: ModelDecision,
  now: number,
  globalLeft: number,
): { ok: true; action: Action | null } | { ok: false; refusal: Refusal } {
  if (d.action === "hold") return { ok: true, action: null };
  const refuse = (rule: string, detail: string, mint: string | null = d.token) => ({ ok: false as const, refusal: { mint, side: d.action as "buy" | "sell", rule, detail } });
  const t = m.tokens.find((x) => x.mint === d.token);
  if (!t) return refuse("unknown_token", "the token is not in the market list the agent was given");
  const equity = equityOf(b, m);
  const halt = haltCheck(b, equity, cfg);
  if (halt) return refuse(halt.rule, halt.reason);
  const s = m.scores.get(t.agent);
  const c = composite(s?.now ?? 0, t.change_24h, cfg.momentum_weight);
  const score: ScoreUsed = { project: s?.now ?? 0, ref: s?.ref ?? null, delta: s?.ref == null ? null : Math.round(((s?.now ?? 0) - s.ref) * 1e6) / 1e6, momentum: c.momentum, composite: c.composite, rank: null };
  // percent to base units, exactly (hundredths of a percent; finer input is refused, not rounded)
  const raw = d.size_pct * 100;
  if (!Number.isInteger(Math.round(raw * 1e6) / 1e6)) return refuse("invalid_decision", "size_pct has more than two decimals");
  const bp = Math.round(raw);
  let amount: bigint;
  let value: bigint;
  if (d.action === "buy") {
    if (bp > temp.size_bps) return refuse("temperament_size", `buy of ${d.size_pct}% of treasury is above this temperament's ${temp.size_bps / 100}%`);
    amount = bps(equity, bp);
    value = amount;
  } else {
    const p = b.positions[t.mint];
    if (!p || p.qty <= 0n) return refuse("no_position", "nothing held in this token");
    amount = bp === 10_000 ? p.qty : bps(p.qty, bp);
    value = valueOf(amount, t.price, t.decimals, m.lineDecimals);
  }
  const no = checkTrade(b, t, d.action, amount, value, equity, cfg, now, globalLeft, m.lineDecimals);
  if (no) return { ok: false, refusal: no };
  return { ok: true, action: { side: d.action, mint: t.mint, amount, rule: "agent_decision", reason: d.reason, score, value } };
}
