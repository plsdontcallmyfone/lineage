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
 * One tick for one agent. Sells first (stop-loss, take-profit, falling score, low score, rotation),
 * then buys in order of composite score. Ties break by mint, so the order is total.
 */
export function decide(b0: Book, m: Market, cfg: TradingConfig, temp: TemperamentParams, now: number, globalLeft: number): Decision {
  const b: Book = { ...b0, positions: Object.fromEntries(Object.entries(b0.positions).map(([k, v]) => [k, { ...v }])) };
  const refused: Refusal[] = [];
  const actions: Action[] = [];
  const equity = equityOf(b, m);
  const halt = haltCheck(b, equity, cfg);
  if (halt) {
    return { actions, refused: [{ mint: null, side: null, rule: halt.rule, detail: halt.reason }], halt, equity };
  }
  if (b.halted) return { actions, refused: [{ mint: null, side: null, rule: "halted", detail: `halted by ${b.halted.rule}` }], halt: null, equity };
  if (b.blackout) return { actions, refused: [{ mint: null, side: null, rule: "verdict_window", detail: "own candidate", private: true }], halt: null, equity };

  // eligible universe and its ranking by composite score
  const scored = m.tokens
    .filter((t) => t.venue !== null && t.price !== null && !integrityRefusal(b, t))
    .map((t) => {
      const s = m.scores.get(t.agent);
      const project = s?.now ?? 0;
      const ref = s?.ref ?? null;
      const c = composite(project, t.change_24h, cfg.momentum_weight);
      return { t, used: { project, ref, delta: ref === null ? null : Math.round((project - ref) * 1e6) / 1e6, momentum: c.momentum, composite: c.composite, rank: null as number | null } };
    })
    .sort((x, y) => y.used.composite - x.used.composite || (x.t.mint < y.t.mint ? -1 : 1));
  scored.forEach((s, i) => (s.used.rank = i + 1));
  const byMint = new Map(scored.map((s) => [s.t.mint, s]));
  const topK = new Set(scored.slice(0, temp.top_k).map((s) => s.t.mint));
  let left = globalLeft;
  let budget = temp.max_actions_per_tick;

  const tryAct = (t: TokenView, side: "buy" | "sell", amount: bigint, rule: string, reason: string, used: ScoreUsed) => {
    if (budget <= 0) return false;
    const value = side === "buy" ? amount : valueOf(amount, t.price, t.decimals, m.lineDecimals);
    const no = checkTrade(b, t, side, amount, value, equity, cfg, now, left, m.lineDecimals);
    if (no) {
      refused.push(no);
      return false;
    }
    actions.push({ side, mint: t.mint, amount, rule, reason, score: used, value });
    // reflect it in the book so later checks in this tick see it (at the mark price)
    const p = b.positions[t.mint] ?? { mint: t.mint, qty: 0n, cost: 0n, opened_at: now, last_side: side, last_at: now };
    if (side === "buy") {
      const q = t.price ? BigInt(Math.floor((Number(amount) / 10 ** m.lineDecimals / t.price) * 10 ** t.decimals)) : 0n;
      p.qty += q;
      p.cost += amount;
      b.line -= amount;
    } else {
      p.cost -= p.qty > 0n ? (p.cost * amount) / p.qty : 0n;
      p.qty -= amount;
      b.line += value;
    }
    p.last_side = side;
    p.last_at = now;
    b.positions[t.mint] = p;
    left--;
    budget--;
    return true;
  };

  // ---------------------------------------------------------------- sells
  const tokOf = new Map(m.tokens.map((t) => [t.mint, t]));
  for (const p of Object.values(b0.positions).sort((x, y) => (x.mint < y.mint ? -1 : 1))) {
    if (p.qty <= 0n) continue;
    const t = tokOf.get(p.mint);
    if (!t || t.price === null) continue;
    const s = byMint.get(p.mint);
    const used: ScoreUsed = s?.used ?? { project: m.scores.get(t.agent)?.now ?? 0, ref: null, delta: null, momentum: null, composite: 0, rank: null };
    const mark = valueOf(p.qty, t.price, t.decimals, m.lineDecimals);
    const pnl = p.cost > 0n ? Number(mark - p.cost) / Number(p.cost) : 0;
    const held = now - p.opened_at;
    if (p.cost > 0n && mark <= p.cost - bps(p.cost, cfg.stop_loss_bps)) {
      tryAct(t, "sell", p.qty, "stop_loss", `marked ${fmtPct(pnl)} against cost; stop-loss at -${cfg.stop_loss_bps / 100}%`, used);
    } else if (p.cost > 0n && mark >= p.cost + bps(p.cost, cfg.take_profit_bps)) {
      const q = bps(p.qty, cfg.take_profit_sell_bps) || p.qty;
      tryAct(t, "sell", q, "take_profit", `marked ${fmtPct(pnl)} against cost; take-profit at +${cfg.take_profit_bps / 100}% sells ${cfg.take_profit_sell_bps / 100}%`, used);
    } else if (used.delta !== null && used.delta <= -temp.fall_threshold) {
      tryAct(t, "sell", p.qty / 2n || p.qty, "score_falling", `project score fell ${used.delta.toFixed(3)} over the lookback (threshold ${temp.fall_threshold})`, used);
    } else if (used.composite < temp.exit_threshold) {
      tryAct(t, "sell", p.qty, "score_low", `composite score ${used.composite.toFixed(3)} below the exit threshold ${temp.exit_threshold}`, used);
    } else if (temp.rotate_after_s !== null && held >= temp.rotate_after_s * 1000 && !topK.has(p.mint)) {
      tryAct(t, "sell", p.qty / 2n || p.qty, "rotate", `held ${Math.floor(held / 60000)} min and ranked ${used.rank ?? "unranked"}, outside the top ${temp.top_k}`, used);
    }
  }

  // ---------------------------------------------------------------- buys
  const size = bps(equity, Math.min(temp.size_bps, cfg.max_trade_bps));
  for (const s of scored) {
    if (budget <= 0) break;
    const { t, used } = s;
    const rising = used.delta !== null && used.delta >= temp.rise_threshold && used.composite >= temp.buy_threshold / 2;
    const high = used.composite >= temp.buy_threshold;
    if (!rising && !high) continue;
    const p = b.positions[t.mint];
    const held = p ? valueOf(p.qty, t.price, t.decimals, m.lineDecimals) : 0n;
    const room = bps(equity, cfg.max_position_bps) - held;
    let amount = size < room ? size : room;
    if (amount > b.line) amount = b.line;
    if (amount < BigInt(cfg.min_trade_line)) {
      if (room < BigInt(cfg.min_trade_line)) continue; // already at the position limit: not a refusal worth publishing
      refused.push({ mint: t.mint, side: "buy", rule: amount <= 0n ? "funds" : "min_trade", detail: `buy of ${amount} base units is below the minimum` });
      continue;
    }
    const why = rising
      ? `project score rose ${used.delta!.toFixed(3)} over the lookback to ${used.project.toFixed(3)} (rank ${used.rank})`
      : `composite score ${used.composite.toFixed(3)} (project ${used.project.toFixed(3)}, rank ${used.rank}) at or above the buy threshold ${temp.buy_threshold}`;
    tryAct(t, "buy", amount, rising ? "score_rising" : "score_high", why, used);
  }
  return { actions, refused, halt: null, equity };
}
