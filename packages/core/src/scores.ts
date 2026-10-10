import type { Core } from "./core.ts";
import { bad, conflict, forbidden, notFound } from "./errors.ts";
import { sessionsOf } from "./sessions.ts";
import { soulsOf } from "./souls.ts";

// Agents as traders (plan T, docs/plans/PANEL-SOCIAL-PROVIDERS.md section T).
//
// This module holds what is public about agent trading:
//   - the published project score ("cool projects"), computed only from data Core already serves
//     publicly: final generations, final candidates and the public session list (author-blind, 10.7:
//     nothing here reads an open candidate or a sealed session);
//   - the trading configuration: every risk limit, the trade share of fee income, the score weights
//     and the temperament bounds, admin-editable at POST /v1/admin/trading/config;
//   - the public trade records the hosted runtime's trader posts (trades with their score, rule and
//     reason; treasury fundings; halts and resets), with the integrity rules checked again here.
//
// Integrity rules (Core refuses a trade record that breaks one, 409; the trader checks first):
//   own_token       an agent never trades its own token;
//   same_party      nor the token of an agent sharing its launcher, registry owner or operator;
//   min_hold        nor the opposite side of its last trade in a token within min_hold_s;
//   halted          nor anything while halted (daily loss until the UTC day ends; drawdown until reset);
//   verdict_window  (trader only: Core never learns it) nor anything from its own candidate's commit
//                   until verdict_window_s after the verdict. Core cannot check this rule without naming
//                   an open candidate's author, so it is enforced in the runtime and tested there.

export type Temperament = "aggressive" | "balanced" | "careful";
export const TEMPERAMENTS: Temperament[] = ["aggressive", "balanced", "careful"];

/**
 * A temperament (plan T, owner amendment 2026-10-10): the agent's own model decides each round, and
 * its temperament is part of the prompt. `size_bps` is also a hard bound the engine enforces: a
 * careful agent's buy above it is refused like any other limit, never resized.
 */
export interface TemperamentParams {
  /** most of one buy for this temperament, bps of treasury equity (and never above max_trade_bps) */
  size_bps: number;
  /** what the agent's prompt says about its appetite for risk */
  prompt: string;
}

export const SCORE_COMPONENTS = ["verified_gain_7d", "accepted_generations", "acceptance_rate", "sessions_24h", "leaderboard_rank", "follower_growth"] as const;
export type ScoreComponent = (typeof SCORE_COMPONENTS)[number];

export interface TradingConfig {
  enabled: boolean;
  /** share of the agent's fee income (AgentLaunch.to_compute) routed to its trading treasury, bps */
  trade_share_bps: number;
  max_position_bps: number;
  max_trade_bps: number;
  max_open_positions: number;
  daily_loss_bps: number;
  max_drawdown_bps: number;
  stop_loss_bps: number;
  take_profit_bps: number;
  /** take-profit is partial: this share of the position is sold */
  take_profit_sell_bps: number;
  max_slippage_bps: number;
  /** execution price against the marginal price, both from simulation */
  max_impact_bps: number;
  cooldown_s: number;
  min_hold_s: number;
  /** trades across all agents of one trader per trade epoch */
  global_trades_per_epoch: number;
  trade_epoch_s: number;
  /** after its own candidate's verdict, an agent waits this long before trading again */
  verdict_window_s: number;
  /** smallest trade, base units of $LINE */
  min_trade_line: string;
  /** SOL kept on the treasury key for fees, lamports */
  gas_reserve_lamports: number;
  /** weight of price momentum in the composite score (project quality dominates) */
  momentum_weight: number;
  /** rising and falling scores compare with the score this long ago */
  score_lookback_s: number;
  score_weights: Record<ScoreComponent, number>;
  temperaments: Record<Temperament, TemperamentParams>;
  default_temperament: Temperament;
  /** per-agent temperament set by the admin; otherwise the soul's, otherwise the default */
  agent_temperament: Record<string, Temperament>;
  /** token account receiving optional launch allocations (memo names the agent); null: not offered */
  allocation_escrow: string | null;
  /** agents that never trade and whose tokens are never traded (agent id -> public reason) */
  excluded_agents: Record<string, string>;
  /** each agent's own model analyses the public data and decides once per round */
  analysis_enabled: boolean;
  /** seconds between an agent's analysis rounds */
  round_s: number;
  /** most one round's model call may cost, USD (counts against the runtime's global and per-agent caps) */
  analysis_max_usd: number;
  /** how many tokens the analysis context lists (by project score), at most */
  analysis_tokens: number;
  /**
   * model for trading analysis, overriding the soul's model (owner 2026-10-10: a cheaper model so
   * trading does not take the authoring budget); null: each agent's own soul model
   */
  analysis_model: { provider: string; id: string } | null;
}

/** TEST defaults (plan T table; the values the table leaves open are TEST values of this lane). */
export const TRADING_DEFAULTS: TradingConfig = {
  enabled: true,
  trade_share_bps: 1000,
  max_position_bps: 1000,
  max_trade_bps: 300,
  max_open_positions: 8,
  daily_loss_bps: 500,
  max_drawdown_bps: 2000,
  stop_loss_bps: 1500,
  take_profit_bps: 4000,
  take_profit_sell_bps: 5000,
  max_slippage_bps: 200,
  max_impact_bps: 100,
  cooldown_s: 600,
  min_hold_s: 1800,
  global_trades_per_epoch: 120,
  trade_epoch_s: 3600,
  verdict_window_s: 300,
  min_trade_line: "1000000",
  gas_reserve_lamports: 10_000_000,
  momentum_weight: 0.15,
  score_lookback_s: 3600,
  score_weights: { verified_gain_7d: 0.35, accepted_generations: 0.2, acceptance_rate: 0.15, sessions_24h: 0.15, leaderboard_rank: 0.1, follower_growth: 0.05 },
  temperaments: {
    aggressive: { size_bps: 300, prompt: "Aggressive: a willing buyer and a risk taker. Trade often; back the projects whose public work is strongest and getting stronger; take profits and cut losers without hesitation." },
    balanced: { size_bps: 200, prompt: "Balanced: trade when the public record gives a clear reason; size moderately; hold otherwise." },
    careful: { size_bps: 100, prompt: "Careful: trade rarely and small; buy only clear quality; hold when in doubt." },
  },
  default_temperament: "aggressive",
  agent_temperament: {},
  allocation_escrow: null,
  excluded_agents: {},
  analysis_enabled: true,
  round_s: 900,
  analysis_max_usd: 0.05,
  analysis_tokens: 20,
  analysis_model: { provider: "anthropic", id: "claude-sonnet-5-5" },
};

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const UINT = /^\d{1,30}$/;

/**
 * Merges `patch` onto `base` and checks every field. Returns the full config or throws a message.
 * Bounds keep an admin typo from turning the limits off (a bps above 10,000, a negative cooldown).
 */
export function mergeTradingConfig(base: TradingConfig, patch: unknown): TradingConfig {
  if (!isObj(patch)) throw new Error("trading config: an object");
  const known = new Set(Object.keys(TRADING_DEFAULTS));
  for (const k of Object.keys(patch)) if (!known.has(k)) throw new Error(`trading config: unknown key ${k}`);
  const c: TradingConfig = structuredClone(base);
  const p = patch as Record<string, unknown>;
  const int = (k: keyof TradingConfig, lo: number, hi: number) => {
    if (!(k in p)) return;
    const v = p[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) throw new Error(`trading config: ${k} is an integer in [${lo}, ${hi}]`);
    (c as unknown as Record<string, unknown>)[k] = v;
  };
  if ("enabled" in p) {
    if (typeof p.enabled !== "boolean") throw new Error("trading config: enabled is a boolean");
    c.enabled = p.enabled;
  }
  for (const k of ["trade_share_bps", "max_position_bps", "max_trade_bps", "daily_loss_bps", "max_drawdown_bps", "stop_loss_bps", "take_profit_sell_bps", "max_slippage_bps", "max_impact_bps"] as const) int(k, 0, 10_000);
  int("take_profit_bps", 1, 1_000_000);
  int("max_open_positions", 0, 100);
  int("cooldown_s", 0, 30 * 86400);
  int("min_hold_s", 0, 30 * 86400);
  int("global_trades_per_epoch", 0, 1_000_000);
  int("trade_epoch_s", 60, 30 * 86400);
  int("verdict_window_s", 0, 30 * 86400);
  int("gas_reserve_lamports", 0, 10_000_000_000);
  int("score_lookback_s", 60, 30 * 86400);
  if ("min_trade_line" in p) {
    if (typeof p.min_trade_line !== "string" || !UINT.test(p.min_trade_line)) throw new Error("trading config: min_trade_line is base units as a decimal string");
    c.min_trade_line = p.min_trade_line;
  }
  if ("momentum_weight" in p) {
    const v = p.momentum_weight;
    // project quality must dominate (plan T): momentum is at most a third of the composite
    if (typeof v !== "number" || !(v >= 0 && v <= 0.33)) throw new Error("trading config: momentum_weight is a number in [0, 0.33]");
    c.momentum_weight = v;
  }
  if ("score_weights" in p) {
    const w = p.score_weights;
    if (!isObj(w)) throw new Error("trading config: score_weights is an object");
    for (const [k, v] of Object.entries(w)) {
      if (!(SCORE_COMPONENTS as readonly string[]).includes(k)) throw new Error(`trading config: unknown score component ${k}`);
      if (typeof v !== "number" || !(v >= 0 && v <= 1)) throw new Error(`trading config: score_weights.${k} is a number in [0, 1]`);
      c.score_weights[k as ScoreComponent] = v;
    }
    if (!(Object.values(c.score_weights).reduce((a, b) => a + b, 0) > 0)) throw new Error("trading config: score_weights must not all be 0");
  }
  if ("temperaments" in p) {
    const t = p.temperaments;
    if (!isObj(t)) throw new Error("trading config: temperaments is an object");
    for (const [name, v] of Object.entries(t)) {
      if (!TEMPERAMENTS.includes(name as Temperament)) throw new Error(`trading config: unknown temperament ${name}`);
      if (!isObj(v)) throw new Error(`trading config: temperaments.${name} is an object`);
      const cur = c.temperaments[name as Temperament];
      for (const [k, x] of Object.entries(v)) {
        if (!(k in cur)) throw new Error(`trading config: temperaments.${name}.${k} is unknown`);
        const ok =
          k === "size_bps" ? typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 10_000
          : k === "prompt" ? typeof x === "string" && x.length > 0 && x.length <= 500 && !/[\u2014]/.test(x)
          : false;
        if (!ok) throw new Error(`trading config: temperaments.${name}.${k} is out of bounds`);
        (cur as unknown as Record<string, unknown>)[k] = x;
      }
    }
  }
  if ("default_temperament" in p) {
    if (!TEMPERAMENTS.includes(p.default_temperament as Temperament)) throw new Error("trading config: default_temperament is aggressive, balanced or careful");
    c.default_temperament = p.default_temperament as Temperament;
  }
  if ("agent_temperament" in p) {
    const a = p.agent_temperament;
    if (!isObj(a)) throw new Error("trading config: agent_temperament maps agent ids to temperaments");
    for (const [id, t] of Object.entries(a)) {
      if (!B58.test(id)) throw new Error(`trading config: agent_temperament key ${id.slice(0, 50)} is not an agent id`);
      if (t === null) delete c.agent_temperament[id];
      else if (!TEMPERAMENTS.includes(t as Temperament)) throw new Error(`trading config: agent_temperament.${id} is a temperament or null`);
      else c.agent_temperament[id] = t as Temperament;
    }
  }
  if ("excluded_agents" in p) {
    const a = p.excluded_agents;
    if (!isObj(a)) throw new Error("trading config: excluded_agents maps agent ids to a reason (null removes)");
    for (const [id, why] of Object.entries(a)) {
      if (!B58.test(id)) throw new Error(`trading config: excluded_agents key ${id.slice(0, 50)} is not an agent id`);
      if (why === null) delete c.excluded_agents[id];
      else if (typeof why !== "string" || !why || why.length > 200) throw new Error(`trading config: excluded_agents.${id} is a reason of 1 to 200 characters, or null`);
      else c.excluded_agents[id] = why;
    }
  }
  if ("analysis_enabled" in p) {
    if (typeof p.analysis_enabled !== "boolean") throw new Error("trading config: analysis_enabled is a boolean");
    c.analysis_enabled = p.analysis_enabled;
  }
  int("round_s", 60, 7 * 86400);
  int("analysis_tokens", 1, 60);
  if ("analysis_max_usd" in p) {
    const v = p.analysis_max_usd;
    if (typeof v !== "number" || !(v > 0 && v <= 1)) throw new Error("trading config: analysis_max_usd is a number in (0, 1]");
    c.analysis_max_usd = v;
  }
  if ("analysis_model" in p) {
    const v = p.analysis_model;
    if (v !== null && !(isObj(v) && typeof v.provider === "string" && /^[a-z][a-z0-9-]{1,31}$/.test(v.provider) && typeof v.id === "string" && v.id.length > 0 && v.id.length <= 100 && Object.keys(v).length === 2))
      throw new Error("trading config: analysis_model is {provider, id} or null");
    c.analysis_model = v === null ? null : { provider: v.provider as string, id: v.id as string };
  }
  if ("allocation_escrow" in p) {
    if (p.allocation_escrow !== null && !(typeof p.allocation_escrow === "string" && B58.test(p.allocation_escrow))) throw new Error("trading config: allocation_escrow is an address or null");
    c.allocation_escrow = p.allocation_escrow as string | null;
  }
  return c;
}

/**
 * A stored config written by an earlier layout: keys this version no longer knows are dropped (the
 * score-threshold temperament fields of the first trading layout), so an upgrade never bricks the
 * config. An admin patch is still checked strictly.
 */
export function storedPatch(raw: unknown): Record<string, unknown> {
  if (!isObj(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (k in TRADING_DEFAULTS) out[k] = v;
  if (isObj(out.temperaments)) {
    const t: Record<string, unknown> = {};
    for (const [name, v] of Object.entries(out.temperaments))
      if (TEMPERAMENTS.includes(name as Temperament) && isObj(v)) t[name] = Object.fromEntries(Object.entries(v).filter(([k]) => k === "size_bps" || k === "prompt"));
    out.temperaments = t;
  }
  return out;
}

/**
 * The soul sets the temperament within bounds: a soul whose seed or persona values name care
 * ("careful", "cautious", "patient", "conservative", "prudent") is careful; one naming balance
 * ("balanced", "steady", "measured", "moderate") is balanced; anything else keeps the default
 * (aggressive in TEST). Deterministic, and only words the launcher or the persona wrote.
 */
export function temperamentFromSoul(doc: unknown, fallback: Temperament): Temperament {
  if (!isObj(doc)) return fallback;
  const words: string[] = [];
  const seed = doc.seed as Record<string, unknown> | undefined;
  const persona = doc.persona as Record<string, unknown> | undefined;
  for (const src of [seed?.values, persona?.values]) if (Array.isArray(src)) for (const v of src) if (typeof v === "string") words.push(v.toLowerCase());
  if (typeof seed?.vibe === "string") words.push(seed.vibe.toLowerCase());
  const text = words.join(" ");
  if (/\b(careful|cautious|patient|conservative|prudent)\b/.test(text)) return "careful";
  if (/\b(balanced|steady|measured|moderate)\b/.test(text)) return "balanced";
  return fallback;
}

// ------------------------------------------------------------------------------------------------
// The project score

export interface RawComponents {
  agent: string;
  /** sum of |ln ratio| over the agent's accepted, unreverted generations of the last 7 days */
  verified_gain_7d: number;
  /** accepted, unreverted generations, all time */
  accepted_generations: number;
  /** (accepted + 1) / (final + 2) over its final candidates (Laplace: one accepted of one is not 100%) */
  acceptance_rate: number;
  /** public sessions started in the last 24 hours */
  sessions_24h: number;
  /** null: not available on this Core (the social lane publishes leaderboards and follows) */
  leaderboard_rank: number | null;
  follower_growth: number | null;
}

export interface ScoredAgent {
  agent: string;
  score: number;
  components: Record<ScoreComponent, { raw: number | null; norm: number | null; weight: number }>;
}

/**
 * Combines raw components into a score in [0, 1]. Counts are normalised by the largest value among
 * the scored agents (0 when every agent has 0); the acceptance rate is already a fraction; a rank
 * becomes 1 for first place down to 1/n; follower growth is normalised like a count (negative is 0).
 * Unavailable components get weight 0 and the others are renormalised, so a missing input never
 * counts as a measured zero. Pure; the trader and the tests use the same function.
 */
export function combineScores(raw: RawComponents[], weights: Record<ScoreComponent, number>): ScoredAgent[] {
  const max = (k: ScoreComponent) => Math.max(0, ...raw.map((r) => (typeof r[k] === "number" ? (r[k] as number) : 0)));
  const maxes = Object.fromEntries(SCORE_COMPONENTS.map((k) => [k, max(k)])) as Record<ScoreComponent, number>;
  const n = raw.length;
  const avail = Object.fromEntries(SCORE_COMPONENTS.map((k) => [k, raw.some((r) => r[k] !== null && r[k] !== undefined)])) as Record<ScoreComponent, boolean>;
  const wsum = SCORE_COMPONENTS.reduce((a, k) => a + (avail[k] ? weights[k] : 0), 0);
  return raw.map((r) => {
    const components = {} as ScoredAgent["components"];
    let score = 0;
    for (const k of SCORE_COMPONENTS) {
      const v = r[k];
      let norm: number | null = null;
      if (v !== null && v !== undefined && avail[k]) {
        if (k === "acceptance_rate") norm = Math.max(0, Math.min(1, v));
        else if (k === "leaderboard_rank") norm = n > 0 && v >= 1 ? Math.max(0, (n - v + 1) / n) : 0;
        else norm = maxes[k] > 0 ? Math.max(0, v) / maxes[k] : 0;
      }
      const weight = avail[k] && wsum > 0 ? weights[k] / wsum : 0;
      components[k] = { raw: v ?? null, norm, weight: round(weight) };
      if (norm !== null) score += weight * norm;
    }
    return { agent: r.agent, score: round(score), components };
  });
}

const round = (x: number) => Math.round(x * 1e6) / 1e6;

// ------------------------------------------------------------------------------------------------
// Trade records

export const SCORES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS trading_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    config TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS trade_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,              -- trade | funding | halt | reset
    agent TEXT NOT NULL,
    mint TEXT,
    side TEXT,
    at INTEGER NOT NULL,
    stored_at INTEGER NOT NULL,
    signature TEXT,
    record TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS trade_records_agent ON trade_records(agent, id);
  CREATE INDEX IF NOT EXISTS trade_records_mint ON trade_records(agent, mint, id);
`;

interface RecRow {
  id: number;
  ref: string;
  kind: string;
  agent: string;
  mint: string | null;
  side: string | null;
  at: number;
  stored_at: number;
  signature: string | null;
  record: string;
}

interface Internals {
  db: Core["db"];
  now(): number;
  emitEvent(type: string, data: unknown): void;
  adminId: string;
  identity: Core["identity"];
  tx<T>(fn: () => T): T;
}

const DAY = 86_400_000;

/**
 * Leaderboard rank and follower growth come from the social lane's modules (leaderboard.ts,
 * social.ts). Until they register here, both components are published as unavailable (weight 0).
 */
export interface SocialScoreInputs {
  /** 1 = first place; null when the agent is not ranked */
  leaderboardRank?(agent: string): number | null;
  /** followers gained over the score window (may be negative); null when unknown */
  followerGrowth?(agent: string): number | null;
}
const socialInputs = new WeakMap<Core, SocialScoreInputs>();
export function registerScoreInputs(core: Core, inputs: SocialScoreInputs): void {
  socialInputs.set(core, inputs);
}

const instances = new WeakMap<Core, Scores>();
export function scoresOf(core: Core): Scores {
  let s = instances.get(core);
  if (!s) instances.set(core, (s = new Scores(core)));
  return s;
}

export class Scores {
  private c: Internals;
  constructor(private core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(SCORES_SCHEMA);
  }

  // ---------------------------------------------------------------------- config

  config(): TradingConfig {
    const r = this.c.db.query<{ config: string }, []>("SELECT config FROM trading_config WHERE id = 1").get();
    if (!r) return structuredClone(TRADING_DEFAULTS);
    // stored as a patch over the defaults, so new fields get their defaults
    return mergeTradingConfig(TRADING_DEFAULTS, storedPatch(JSON.parse(r.config)));
  }

  configView() {
    const r = this.c.db.query<{ updated_at: number }, []>("SELECT updated_at FROM trading_config WHERE id = 1").get();
    return { ...this.config(), values: "TEST", updated_at: r?.updated_at ?? null };
  }

  /** POST /v1/admin/trading/config: a patch over the current config; every field is checked. */
  setConfig(body: unknown) {
    return this.c.tx(() => {
      const cur = this.c.db.query<{ config: string }, []>("SELECT config FROM trading_config WHERE id = 1").get();
      const stored = cur ? storedPatch(JSON.parse(cur.config)) : {};
      let merged: TradingConfig;
      try {
        merged = mergeTradingConfig(mergeTradingConfig(TRADING_DEFAULTS, stored), body);
      } catch (e) {
        throw bad("bad_trading_config", (e as Error).message);
      }
      // store the full merged config as the patch (the defaults may change later; the admin's values must not)
      this.c.db.query("INSERT INTO trading_config (id, config, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at")
        .run(JSON.stringify(merged), this.c.now());
      this.c.emitEvent("trading.config", { changed: Object.keys(body as object) });
      return this.configView();
    });
  }

  temperamentOf(agent: string, cfg = this.config()): { temperament: Temperament; source: "admin" | "soul" | "default" } {
    const set = cfg.agent_temperament[agent];
    if (set) return { temperament: set, source: "admin" };
    try {
      const doc = soulsOf(this.core).view(agent).doc;
      const t = temperamentFromSoul(doc, cfg.default_temperament);
      return { temperament: t, source: t === cfg.default_temperament ? "default" : "soul" };
    } catch {
      return { temperament: cfg.default_temperament, source: "default" };
    }
  }

  // ---------------------------------------------------------------------- scores

  private launchedAgents(): { agent_id: string; mint: string | null; launcher: string | null; operator: string | null }[] {
    return this.c.db
      .query<{ agent_id: string; mint: string | null; launcher: string | null; operator: string | null }, []>(
        "SELECT agent_id, mint, launcher, operator FROM agents WHERE kind = 'launched' AND shadow = 0 ORDER BY agent_id",
      )
      .all();
  }

  /** Raw components from public data only (final generations, final candidates, public sessions). */
  raw(): RawComponents[] {
    const now = this.c.now();
    const since7 = now - 7 * DAY;
    const since24 = now - DAY;
    const gens = this.c.db
      .query<{ author: string; verdict: string | null; effect: string | null; accepted_at: number }, []>(
        `SELECT author, verdict, effect, accepted_at FROM generations
         WHERE entry_type = 'patch' AND author IS NOT NULL AND reverted_by IS NULL AND (audit_status IS NULL OR audit_status != 'reverted')`,
      )
      .all();
    const finals = this.c.db
      .query<{ author: string; acc: number; fin: number }, []>(
        `SELECT author, SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS acc, COUNT(*) AS fin
         FROM candidates WHERE status IN ('accepted', 'rejected') AND is_canary = 0 GROUP BY author`,
      )
      .all();
    const fin = new Map(finals.map((f) => [f.author, f]));
    const sessions = this.publicSessions(since24);
    const social = socialInputs.get(this.core);
    const safe = (f: ((a: string) => number | null) | undefined, a: string) => {
      try {
        const v = f?.(a);
        return typeof v === "number" && Number.isFinite(v) ? v : null;
      } catch {
        return null;
      }
    };
    return this.launchedAgents().map(({ agent_id: a }) => {
      let gain = 0;
      let accepted = 0;
      for (const g of gens) {
        if (g.author !== a) continue;
        accepted++;
        if (g.accepted_at >= since7) gain += gainOf(g.effect, g.verdict);
      }
      const f = fin.get(a);
      return {
        agent: a,
        verified_gain_7d: round(gain),
        accepted_generations: accepted,
        acceptance_rate: round(((f?.acc ?? 0) + 1) / ((f?.fin ?? 0) + 2)),
        sessions_24h: sessions.get(a) ?? 0,
        leaderboard_rank: safe(social?.leaderboardRank?.bind(social), a),
        follower_growth: safe(social?.followerGrowth?.bind(social), a),
      };
    });
  }

  /** Sessions the public list names an agent for (sessions.ts decides; a sealed one names nobody). */
  private publicSessions(since: number): Map<string, number> {
    const out = new Map<string, number>();
    // the public list (viewer null): exactly what anyone can read at GET /v1/sessions
    const sessions = sessionsOf(this.core).list({ limit: 500 }, null) as { agent: string | null; started_at?: number }[];
    for (const s of sessions) {
      const a = s.agent;
      if (!a || !s.started_at || s.started_at < since) continue;
      out.set(a, (out.get(a) ?? 0) + 1);
    }
    return out;
  }

  scores() {
    const cfg = this.config();
    const scored = combineScores(this.raw(), cfg.score_weights);
    scored.sort((x, y) => y.score - x.score || (x.agent < y.agent ? -1 : 1));
    return {
      at: this.c.now(),
      formula:
        "score = sum of weight x norm over available components; counts normalised by the largest among launched agents, acceptance rate (accepted+1)/(final+2), gain = sum of |ln ratio| of accepted unreverted generations in 7 days; unavailable components weigh 0 and the rest are renormalised. Price momentum is not part of this score: the trader adds it with momentum_weight.",
      weights: cfg.score_weights,
      momentum_weight: cfg.momentum_weight,
      agents: scored.map((s, i) => ({ ...s, rank: i + 1 })),
    };
  }

  scoreOf(agent: string) {
    const s = this.scores();
    const one = s.agents.find((x) => x.agent === agent);
    if (!one) throw notFound("launched agent");
    return { at: s.at, formula: s.formula, weights: s.weights, momentum_weight: s.momentum_weight, of: s.agents.length, ...one };
  }

  // ---------------------------------------------------------------------- integrity

  /** The parties behind an agent: its launcher, registry owner (chain mode) and operator. */
  parties(agent: string): Set<string> {
    const a = this.c.db
      .query<{ launcher: string | null; operator: string | null; chain_owner: string | null }, [string]>(
        "SELECT launcher, operator, chain_owner FROM agents WHERE agent_id = ?",
      )
      .get(agent);
    const out = new Set<string>();
    if (a?.launcher) out.add(a.launcher);
    if (a?.operator) out.add(a.operator);
    if (a?.chain_owner) out.add(a.chain_owner);
    return out;
  }

  agentOfMint(mint: string): string | null {
    return this.c.db.query<{ agent_id: string }, [string]>("SELECT agent_id FROM agents WHERE mint = ? AND kind = 'launched'").get(mint)?.agent_id ?? null;
  }

  /** The halt in force for `agent` at `at`, if any (daily loss until the UTC day ends; drawdown until a reset). */
  haltOf(agent: string, at = this.c.now()): { rule: string; since: number; until: number | null; ref: string } | null {
    const rows = this.c.db
      .query<RecRow, [string]>("SELECT * FROM trade_records WHERE agent = ? AND kind IN ('halt', 'reset') ORDER BY id DESC LIMIT 50")
      .all(agent);
    for (const r of rows) {
      if (r.kind === "reset") return null;
      const rec = JSON.parse(r.record) as { rule: string };
      if (rec.rule === "max_drawdown") return { rule: rec.rule, since: r.at, until: null, ref: r.ref };
      if (rec.rule === "daily_loss") {
        const until = Math.floor(r.at / DAY) * DAY + DAY;
        if (at < until) return { rule: rec.rule, since: r.at, until, ref: r.ref };
      }
    }
    return null;
  }

  /** Checks the integrity rules Core can check for a trade by `agent` in `mint`; throws 409 with the rule. */
  checkTrade(agent: string, mint: string, side: "buy" | "sell", at: number, cfg = this.config()) {
    const owner = this.agentOfMint(mint);
    if (!owner) throw bad("unknown_token", "the mint is not a launched agent's token");
    if (owner === agent) throw conflict("integrity_own_token", "an agent never trades its own token");
    if (cfg.excluded_agents[agent]) throw conflict("integrity_excluded", `this agent is excluded from trading: ${cfg.excluded_agents[agent]}`);
    if (cfg.excluded_agents[owner]) throw conflict("integrity_excluded", `the token's agent is excluded from trading: ${cfg.excluded_agents[owner]}`);
    const mine = this.parties(agent);
    for (const p of this.parties(owner)) if (mine.has(p)) throw conflict("integrity_same_party", "the token's agent shares a launcher, owner or operator with this agent");
    const halt = this.haltOf(agent, at);
    if (halt) throw conflict("integrity_halted", `halted by ${halt.rule}`);
    const last = this.c.db
      .query<RecRow, [string, string]>("SELECT * FROM trade_records WHERE agent = ? AND mint = ? AND kind = 'trade' ORDER BY at DESC, id DESC LIMIT 1")
      .get(agent, mint);
    if (last && last.side !== side && at - last.at < cfg.min_hold_s * 1000)
      throw conflict("integrity_min_hold", `no ${side} within ${cfg.min_hold_s} s of a ${last.side} in the same token`);
  }

  // ---------------------------------------------------------------------- records

  /** POST /v1/trades (runtime authority). Idempotent by `ref`. */
  record(body: unknown) {
    if (!isObj(body)) throw bad("bad_body", "object expected");
    const b = body as Record<string, any>;
    if (typeof b.ref !== "string" || !/^[\w:.-]{8,160}$/.test(b.ref)) throw bad("bad_ref", "ref: 8 to 160 word characters");
    if (typeof b.agent !== "string" || !B58.test(b.agent)) throw bad("bad_agent", "agent id");
    if (!Number.isSafeInteger(b.at) || b.at <= 0) throw bad("bad_at", "at: unix ms");
    if (JSON.stringify(b).length > 8000) throw bad("too_large", "record too large");
    return this.c.tx(() => {
      const dup = b.dry_run === true ? null : this.c.db.query<RecRow, [string]>("SELECT * FROM trade_records WHERE ref = ?").get(b.ref);
      if (dup) return { ...view(dup), duplicate: true };
      const a = this.c.db.query<{ kind: string; hosted: number }, [string]>("SELECT kind, hosted FROM agents WHERE agent_id = ?").get(b.agent);
      if (!a || a.kind !== "launched") throw notFound("launched agent");
      if (!a.hosted) throw forbidden("not_hosted", "only hosted agents trade through the runtime");
      if (this.config().excluded_agents[b.agent] && b.kind !== "halt") throw conflict("integrity_excluded", "this agent is excluded from trading; nothing is recorded for it");
      let mint: string | null = null;
      let side: string | null = null;
      let sig: string | null = null;
      switch (b.kind) {
        case "trade": {
          if (b.side !== "buy" && b.side !== "sell") throw bad("bad_side", "side: buy or sell");
          if (typeof b.mint !== "string" || !B58.test(b.mint)) throw bad("bad_mint", "mint");
          if (!["pump_curve", "pump_pool", "sim", "dbc", "damm_v2"].includes(b.venue)) throw bad("bad_venue", "venue: pump_curve, pump_pool or sim (dbc, damm_v2: Meteora-era records)");
          for (const k of ["amount_in", "amount_out"]) if (typeof b[k] !== "string" || !UINT.test(b[k])) throw bad("bad_amount", `${k}: base units`);
          if (typeof b.rule !== "string" || !b.rule || typeof b.reason !== "string" || !b.reason) throw bad("bad_reason", "every trade carries its rule and reason");
          if (!isObj(b.score)) throw bad("bad_score", "every trade carries the score it acted on");
          if (typeof b.signature !== "string" || !(SIG.test(b.signature) || /^sim:/.test(b.signature))) throw bad("bad_signature", "signature");
          this.checkTrade(b.agent, b.mint, b.side, b.at);
          [mint, side, sig] = [b.mint, b.side, b.signature];
          break;
        }
        case "funding": {
          if (!["trade_share", "allocation", "gas"].includes(b.source)) throw bad("bad_source", "source: trade_share, allocation or gas");
          if (typeof b.amount !== "string" || !UINT.test(b.amount)) throw bad("bad_amount", "amount: base units");
          if (typeof b.signature !== "string" || !(SIG.test(b.signature) || /^sim:/.test(b.signature))) throw bad("bad_signature", "signature");
          sig = b.signature;
          break;
        }
        case "decision": {
          // an analysis round that did not trade: a hold, or a decision the engine refused
          if (this.config().excluded_agents[b.agent]) throw conflict("integrity_excluded", "this agent is excluded from trading");
          if (b.outcome !== "hold" && b.outcome !== "refused") throw bad("bad_outcome", "outcome: hold or refused (a filled decision is a trade record)");
          if (typeof b.thesis !== "string" || b.thesis.length > 4000) throw bad("bad_thesis", "thesis: a string of at most 4000 characters (empty when the model gave none)");
          if (b.outcome === "refused" && (typeof b.rule !== "string" || !b.rule)) throw bad("bad_rule", "a refused decision carries the rule that refused it");
          if (b.mint !== null && b.mint !== undefined && (typeof b.mint !== "string" || !B58.test(b.mint))) throw bad("bad_mint", "mint");
          mint = typeof b.mint === "string" ? b.mint : null;
          side = b.action === "buy" || b.action === "sell" ? b.action : null;
          break;
        }
        case "halt":
          if (b.rule !== "daily_loss" && b.rule !== "max_drawdown") throw bad("bad_rule", "halt rule: daily_loss or max_drawdown");
          if (typeof b.reason !== "string" || !b.reason) throw bad("bad_reason", "reason");
          break;
        default:
          throw bad("bad_kind", "kind: trade, decision, funding or halt (resets are posted by the launcher, owner or admin)");
      }
      // the trader asks before it sends a trade, so Core's rules are checked before money moves
      if (b.dry_run === true) return { ok: true, dry_run: true };
      const r = this.c.db
        .query("INSERT INTO trade_records (ref, kind, agent, mint, side, at, stored_at, signature, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(b.ref, b.kind, b.agent, mint, side, b.at, this.c.now(), sig, JSON.stringify(b));
      const row = this.c.db.query<RecRow, [number]>("SELECT * FROM trade_records WHERE id = ?").get(Number(r.lastInsertRowid))!;
      const v = view(row);
      this.c.emitEvent(b.kind === "trade" ? "trade.executed" : b.kind === "funding" ? "trade.funded" : b.kind === "decision" ? "trade.decision" : "trade.halted", v);
      return v;
    });
  }

  /** POST /v1/agents/:id/trading/reset: the launcher, the registry owner or the admin lifts a halt. */
  reset(caller: string, agent: string, body: unknown) {
    return this.c.tx(() => {
      const a = this.c.db.query<{ launcher: string | null; chain_owner: string | null }, [string]>("SELECT launcher, chain_owner FROM agents WHERE agent_id = ?").get(agent);
      if (!a) throw notFound("agent");
      if (caller !== this.c.adminId && caller !== a.launcher && caller !== a.chain_owner) throw forbidden("not_launcher", "the launcher, the registry owner or the admin resets a halt");
      const halt = this.haltOf(agent);
      if (!halt) throw conflict("not_halted", "the agent is not halted");
      const note = isObj(body) && typeof body.note === "string" ? body.note.slice(0, 200) : null;
      const at = this.c.now();
      const rec = { kind: "reset", agent, at, by: caller, lifts: halt.ref, rule: halt.rule, note };
      const ref = `reset:${agent}:${at}`;
      this.c.db.query("INSERT INTO trade_records (ref, kind, agent, mint, side, at, stored_at, signature, record) VALUES (?, 'reset', ?, NULL, NULL, ?, ?, NULL, ?)")
        .run(ref, agent, at, at, JSON.stringify({ ref, ...rec }));
      this.c.emitEvent("trade.reset", { ref, ...rec });
      return { ref, ...rec };
    });
  }

  /** GET /v1/agents/:id/trades: the agent's public trading page (treasury key, status, summary, records). */
  agentTrades(agent: string, q: { limit?: number; before?: number } = {}) {
    const a = this.c.db.query<{ kind: string; hosted: number; mint: string | null }, [string]>("SELECT kind, hosted, mint FROM agents WHERE agent_id = ?").get(agent);
    if (!a || a.kind !== "launched") throw notFound("launched agent");
    const limit = Math.max(1, Math.min(q.limit ?? 50, 500));
    const rows = this.c.db
      .query<RecRow, [string, number, number]>("SELECT * FROM trade_records WHERE agent = ? AND id < ? ORDER BY id DESC LIMIT ?")
      .all(agent, q.before ?? Number.MAX_SAFE_INTEGER, limit);
    const sum = this.c.db
      .query<{ kind: string; side: string | null; n: number }, [string]>("SELECT kind, side, COUNT(*) AS n FROM trade_records WHERE agent = ? GROUP BY kind, side")
      .all(agent);
    const n = (kind: string, side: string | null = null) => sum.filter((s) => s.kind === kind && (side === null || s.side === side)).reduce((x, s) => x + s.n, 0);
    const latest = this.c.db
      .query<RecRow, [string]>("SELECT * FROM trade_records WHERE agent = ? AND kind IN ('trade', 'halt') ORDER BY id DESC LIMIT 1")
      .get(agent);
    let realized = 0n;
    let funded = 0n;
    for (const r of this.c.db.query<{ record: string; kind: string }, [string]>("SELECT record, kind FROM trade_records WHERE agent = ? AND kind IN ('trade', 'funding')").all(agent)) {
      const rec = JSON.parse(r.record) as { realized_pnl?: string; amount?: string; source?: string };
      if (r.kind === "trade" && typeof rec.realized_pnl === "string" && /^-?\d+$/.test(rec.realized_pnl)) realized += BigInt(rec.realized_pnl);
      if (r.kind === "funding" && rec.source !== "gas" && rec.amount) funded += BigInt(rec.amount);
    }
    const cfg = this.config();
    return {
      agent,
      mint: a.mint,
      hosted: !!a.hosted,
      treasury: { key: this.c.identity.signingKey(agent), note: "the agent's current signing key (held by the hosted runtime) holds its trading treasury; separate from the compute vault" },
      temperament: this.temperamentOf(agent, cfg),
      halt: this.haltOf(agent),
      excluded: cfg.excluded_agents[agent] ?? null,
      summary: {
        trades: n("trade"),
        buys: n("trade", "buy"),
        sells: n("trade", "sell"),
        decisions: n("decision"),
        fundings: n("funding"),
        halts: n("halt"),
        funded_line: funded.toString(),
        realized_pnl_line: realized.toString(),
        latest_treasury: latest ? (JSON.parse(latest.record).treasury ?? null) : null,
      },
      records: rows.map(view),
    };
  }

  /** GET /v1/trades: every agent's records, newest first (the feed). */
  list(q: { limit?: number; before?: number; kind?: string; mint?: string } = {}) {
    const where = ["id < ?"];
    const args: (string | number)[] = [q.before ?? Number.MAX_SAFE_INTEGER];
    if (q.kind) (where.push("kind = ?"), args.push(q.kind));
    if (q.mint) (where.push("mint = ?"), args.push(q.mint));
    const limit = Math.max(1, Math.min(q.limit ?? 50, 500));
    const rows = this.c.db.query<RecRow, (string | number)[]>(`SELECT * FROM trade_records WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`).all(...args, limit);
    return { records: rows.map(view) };
  }
}

function view(r: RecRow) {
  return { id: r.id, stored_at: r.stored_at, ...(JSON.parse(r.record) as Record<string, unknown>) };
}

/** |ln ratio| of a final generation's verdict effect (perf and slim targets report new / old). */
export function gainOf(effect: string | null, verdict: string | null): number {
  for (const src of [effect, verdict]) {
    if (!src) continue;
    try {
      const j = JSON.parse(src) as { ratio?: unknown; effect?: { ratio?: unknown } };
      const ratio = typeof j.ratio === "number" ? j.ratio : typeof j.effect?.ratio === "number" ? j.effect.ratio : null;
      if (ratio !== null && ratio > 0 && Number.isFinite(ratio)) return Math.abs(Math.log(ratio));
    } catch {
      /* not JSON */
    }
  }
  return 0;
}
