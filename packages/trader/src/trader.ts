import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentKey } from "@lineage/protocol";
import { CoreClient } from "../../core/src/client.ts";
import { TRADING_DEFAULTS, type Temperament, type TemperamentParams, type TradingConfig } from "../../core/src/scores.ts";
import { enforceDecision, equityOf, parseDecision, riskExits, valueOf, type Action, type Book, type Market, type ModelDecision, type Position, type Refusal, type ScoreInput, type TokenView } from "./policy.ts";
import { quoteWords, systemPrompt, userPrompt, type AnalysisInput, type DecisionModel, type MarketInfo, type PublicGen, type Usage } from "./analyst.ts";
import type { TraderKey, Venue } from "./venue.ts";
import { signedAgentFollow, type FollowContext } from "../../core/src/follow-context.ts";
import { parseFollows, splitFollows, type FollowDecision } from "./follows.ts";

// The trader (plan T): runs inside the hosted runtime, one book per bound hosted agent. Each tick it
// reads the admin-editable trading config and the published scores from Core and the market from
// the indexer (or the simulated market), asks the policy engine what to do, asks Core whether the
// trade passes its integrity checks (dry run), quotes it by simulation, enforces slippage and price
// impact, sends it signed by the agent's key (the treasury), and publishes the record with its score,
// rule and reason. State (positions with cost basis, day start, peak, score history, the global
// trade counter, records not yet published) is one JSON file written atomically after every change.

export interface TradingAgent {
  agent: string;
  /** the agent's own token */
  mint: string | null;
  /** the agent's current signing key, held by the runtime: its treasury */
  key: TraderKey;
}

/** A token as the market source lists it; parties come from Core. */
export type MarketToken = Omit<TokenView, "parties" | "excluded"> & { info?: MarketInfo };

export interface TraderDeps {
  core: string;
  /** the runtime authority key: posts the public records */
  runtimeKey: AgentKey;
  venue: Venue;
  tokens(): Promise<MarketToken[]>;
  agents(): Promise<TradingAgent[]>;
  stateDir: string;
  lineDecimals: number;
  now?: () => number;
  log?: (m: string) => void;
  /** tops up the treasury key's SOL for fees (devnet: from the runtime authority); returns the signature */
  gas?(treasury: string, lamports: bigint): Promise<string | null>;
  /**
   * The agent's own analysis (owner amendment 2026-10-10). Absent: only the risk exits run.
   * `room` is the USD the runtime lets the agent spend now (global cap, per-agent caps, vault);
   * `meter` bills a model call into the agent's usage and the global cap; `post` sends a board
   * message as the agent (devnet: lineage_msg) and returns its id.
   */
  analysis?: {
    /** the agent's decision model; `override` (trading config analysis_model) replaces the soul's choice */
    model(agent: string, override?: { provider: string; id: string } | null): Promise<{ model: DecisionModel } | { model: null; why: string }>;
    room(agent: string): number;
    meter(agent: string, u: Usage): void;
    post(agent: string, board: string, text: string): Promise<string | null>;
  };
}

interface BookState {
  positions: Record<string, { mint: string; qty: string; cost: string; opened_at: number; last_side: "buy" | "sell"; last_at: number }>;
  day: { start: number; equity: string; funded: string } | null;
  peak: string;
  /** the halt Core reported last tick: when a drawdown halt is lifted (a reset), the peak restarts at equity */
  halt_seen?: string | null;
}

export interface TraderState {
  v: 1;
  books: Record<string, BookState>;
  /** published project scores sampled over time (for rising and falling) */
  scores: { at: number; s: Record<string, number> }[];
  epoch: { start: number; count: number };
  /** records Core has not accepted yet (Core down): retried in order */
  outbox: Record<string, unknown>[];
  /** limit refusals by rule (public ones only) since the state was created */
  limit_hits: Record<string, number>;
  trades: number;
  last_tick: number | null;
  /** last analysis round per agent (ms) */
  rounds?: Record<string, number>;
  /** analysis rounds, newest last (bounded): model, spend, outcome, the record they produced, the post */
  analyses?: { agent: string; at: number; model: string; usd: number; outcome: string; rule: string | null; ref: string; post: string | null }[];
  /** board posts of analyses, newest last (bounded) */
  posts?: { agent: string; at: number; ref: string; msg_id: string | null; board: string }[];
  /** follow decisions from analysis rounds, newest last (bounded): sent, or the rule that dropped or refused them */
  follows?: { agent: string; at: number; target: string | null; follow: boolean | null; reason: string | null; outcome: "sent" | "refused" | "dropped"; rule: string | null }[];
}

const DAY = 86_400_000;
const big = (s: string | undefined) => BigInt(s ?? "0");

export class Trader {
  readonly client: CoreClient;
  private anon: CoreClient;
  state: TraderState;
  private file: string;
  private log: (m: string) => void;
  private now: () => number;
  private busy = false;

  constructor(private d: TraderDeps) {
    this.log = d.log ?? ((m) => console.log(`[trader] ${m}`));
    this.now = d.now ?? Date.now;
    this.client = new CoreClient(d.core, d.runtimeKey, this.now);
    this.anon = new CoreClient(d.core, null);
    mkdirSync(d.stateDir, { recursive: true, mode: 0o700 });
    this.file = join(d.stateDir, "trader.json");
    this.state = existsSync(this.file)
      ? (JSON.parse(readFileSync(this.file, "utf8")) as TraderState)
      : { v: 1, books: {}, scores: [], epoch: { start: 0, count: 0 }, outbox: [], limit_hits: {}, trades: 0, last_tick: null };
  }

  save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  async config(): Promise<TradingConfig> {
    const r = await this.anon.get("/v1/trading/config");
    if (r.status !== 200) throw new Error(`trading config: HTTP ${r.status}`);
    return r.body as TradingConfig;
  }

  /** Samples the published scores (at most once a minute) and returns now and lookback values. */
  private async scoreInputs(cfg: TradingConfig): Promise<Map<string, ScoreInput>> {
    const r = await this.anon.get("/v1/scores");
    if (r.status !== 200) throw new Error(`scores: HTTP ${r.status}`);
    const now = this.now();
    const cur: Record<string, number> = {};
    for (const a of r.body.agents as { agent: string; score: number; components: Record<string, { raw: number | null }> }[]) {
      cur[a.agent] = a.score;
      this.lastComponents.set(a.agent, a.components);
    }
    const h = this.state.scores;
    if (!h.length || now - h[h.length - 1]!.at >= 60_000) h.push({ at: now, s: cur });
    const keep = now - 2 * cfg.score_lookback_s * 1000;
    while (h.length > 1 && h[0]!.at < keep) h.shift();
    // the newest sample at or before the lookback point
    let ref: Record<string, number> | null = null;
    for (const x of h) if (x.at <= now - cfg.score_lookback_s * 1000) ref = x.s;
    const out = new Map<string, ScoreInput>();
    for (const [a, s] of Object.entries(cur)) out.set(a, { now: s, ref: ref ? (ref[a] ?? null) : null });
    return out;
  }

  /** Launcher, owner and operator of every launched agent (public Core data). */
  private async parties(): Promise<Map<string, string[]>> {
    const r = await this.anon.get("/v1/agents");
    if (r.status !== 200) throw new Error(`agents: HTTP ${r.status}`);
    const out = new Map<string, string[]>();
    for (const a of r.body as { agent_id: string; kind: string; launcher?: string | null; operator?: string | null; identity?: { owner?: string | null } }[]) {
      if (a.kind !== "launched") continue;
      out.set(a.agent_id, [a.launcher, a.operator, a.identity?.owner].filter((x): x is string => typeof x === "string" && x.length > 0));
    }
    return out;
  }

  /** Whether the agent's own candidate is open or was decided within the verdict window (private: the agent's own signed read). */
  private async blackout(a: TradingAgent, cfg: TradingConfig): Promise<boolean> {
    const as = new CoreClient(this.d.core, { ...(a.key as AgentKey), agent: a.agent }, this.now);
    const r = await as.get(`/v1/candidates?author=${a.agent}&limit=20`, true);
    if (r.status !== 200) return true; // unknown: do not trade
    const now = this.now();
    for (const c of r.body as { status: string; finalized_at: number | null }[]) {
      if (!["accepted", "rejected", "expired"].includes(c.status)) return true;
      if (c.finalized_at && now - c.finalized_at < cfg.verdict_window_s * 1000) return true;
    }
    return false;
  }

  private async haltOf(agent: string): Promise<Book["halted"]> {
    const r = await this.anon.get(`/v1/agents/${agent}/trades?limit=1`);
    if (r.status !== 200) return null;
    const h = r.body.halt as { rule: "daily_loss" | "max_drawdown"; since: number; until: number | null } | null;
    return h ? { rule: h.rule, since: h.since, until: h.until } : null;
  }

  private bookState(agent: string): BookState {
    return (this.state.books[agent] ??= { positions: {}, day: null, peak: "0" });
  }

  /** Records $LINE funded into a treasury: not gain for the day's loss limit or the drawdown peak. */
  noteFunding(agent: string, amount: bigint) {
    const bs = this.bookState(agent);
    if (bs.day) bs.day.funded = (big(bs.day.funded) + amount).toString();
    bs.peak = (big(bs.peak) + amount).toString();
    this.save();
  }

  /** Publishes a record (queued when Core is unreachable). */
  async publish(rec: Record<string, unknown>): Promise<boolean> {
    this.state.outbox.push(rec);
    this.save();
    return this.flush();
  }

  async flush(): Promise<boolean> {
    while (this.state.outbox.length) {
      const rec = this.state.outbox[0]!;
      const r = await this.client.post("/v1/trades", rec).catch((e) => ({ status: 0, body: { error: String(e) } }));
      if (r.status === 200) {
        this.state.outbox.shift();
        this.save();
        continue;
      }
      if (r.status >= 400 && r.status < 500) {
        // a refusal is final: keep it in the log, drop it from the queue
        this.log(`record ${String(rec.ref)} refused by Core: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
        this.state.outbox.shift();
        this.save();
        continue;
      }
      return false;
    }
    return true;
  }

  private globalLeft(cfg: TradingConfig): number {
    const now = this.now();
    const start = Math.floor(now / (cfg.trade_epoch_s * 1000)) * cfg.trade_epoch_s * 1000;
    if (this.state.epoch.start !== start) this.state.epoch = { start, count: 0 };
    return cfg.global_trades_per_epoch - this.state.epoch.count;
  }

  private hit(r: Refusal) {
    if (r.private) return;
    this.state.limit_hits[r.rule] = (this.state.limit_hits[r.rule] ?? 0) + 1;
  }

  /** One pass over every trading agent. */
  async tick(): Promise<{ trades: number; refused: Refusal[] }> {
    if (this.busy) return { trades: 0, refused: [] };
    this.busy = true;
    try {
      await this.flush();
      const cfg = await this.config();
      if (!cfg.enabled) return { trades: 0, refused: [] };
      const [scores, parties, raw, agents] = await Promise.all([this.scoreInputs(cfg), this.parties(), this.d.tokens(), this.d.agents()]);
      this.lastTokens = raw;
      const tokens: TokenView[] = raw.map(({ info: _info, ...t }) => ({ ...t, parties: parties.get(t.agent) ?? [], excluded: !!cfg.excluded_agents[t.agent] }));
      const market: Market = { tokens, scores, lineDecimals: this.d.lineDecimals };
      let trades = 0;
      const refusedAll: Refusal[] = [];
      for (const a of agents) {
        try {
          const r = await this.tickAgent(a, cfg, market, parties.get(a.agent) ?? []);
          trades += r.trades;
          refusedAll.push(...r.refused);
        } catch (e) {
          this.log(`${a.agent.slice(0, 6)} tick: ${(e as Error).message}`);
        }
      }
      this.state.last_tick = this.now();
      this.save();
      return { trades, refused: refusedAll };
    } finally {
      this.busy = false;
    }
  }

  private temperamentOf(agent: string, cfg: TradingConfig, fromCore: Temperament | null): Temperament {
    return fromCore ?? cfg.agent_temperament[agent] ?? cfg.default_temperament;
  }

  async tickAgent(a: TradingAgent, cfg: TradingConfig, market: Market, myParties: string[]): Promise<{ trades: number; refused: Refusal[] }> {
    // an excluded agent is not touched at all: no balances, no gas, no analysis, no record, no post
    if (cfg.excluded_agents[a.agent]) return { trades: 0, refused: [] };
    const now = this.now();
    this.lastParties.set(a.agent, myParties);
    const bs = this.bookState(a.agent);
    const mints = [...new Set([...Object.keys(bs.positions), ...market.tokens.map((t) => t.mint)])];
    const bal = await this.d.venue.balances(a.key.id, mints);
    // positions follow the chain: tokens that arrived some other way join at zero cost; sold-off ones close
    for (const m of mints) {
      const q = bal.tokens.get(m) ?? 0n;
      const p = bs.positions[m];
      if (p && q !== big(p.qty)) {
        if (q === 0n) delete bs.positions[m];
        else p.qty = q.toString();
      } else if (!p && q > 0n && m !== a.mint) bs.positions[m] = { mint: m, qty: q.toString(), cost: "0", opened_at: now, last_side: "buy", last_at: 0 };
    }
    // gas comes from the treasury: top up its SOL when it runs low (recorded as a funding)
    if (this.d.gas && bal.sol < BigInt(cfg.gas_reserve_lamports)) {
      const want = BigInt(cfg.gas_reserve_lamports) * 3n - bal.sol;
      const sig = await this.d.gas(a.key.id, want).catch((e) => (this.log(`${a.agent.slice(0, 6)} gas top-up failed: ${(e as Error).message}`), null));
      if (sig) {
        bal.sol += want;
        await this.publish({ kind: "funding", ref: `gas:${sig}`, agent: a.agent, at: now, source: "gas", amount: want.toString(), unit: "lamports", signature: sig, treasury: a.key.id });
      }
    }
    const positions: Record<string, Position> = {};
    for (const [m, p] of Object.entries(bs.positions)) positions[m] = { mint: m, qty: big(p.qty), cost: big(p.cost), opened_at: p.opened_at, last_side: p.last_side, last_at: p.last_at };
    const book: Book = {
      agent: a.agent,
      mint: a.mint,
      parties: myParties,
      line: bal.line,
      sol: bal.sol,
      positions,
      day: { start: 0, equity: 0n, funded: 0n },
      peak: big(bs.peak),
      halted: await this.haltOf(a.agent),
      blackout: await this.blackout(a, cfg),
    };
    const equity = equityOf(book, market);
    if (bs.halt_seen === "max_drawdown" && !book.halted) {
      bs.peak = equity.toString();
      this.log(`${a.agent.slice(0, 6)} drawdown halt lifted by a reset; peak restarts at ${equity}`);
    }
    bs.halt_seen = book.halted?.rule ?? null;
    const dayStart = Math.floor(now / DAY) * DAY;
    if (!bs.day || bs.day.start !== dayStart) bs.day = { start: dayStart, equity: equity.toString(), funded: "0" };
    book.day = { start: bs.day.start, equity: big(bs.day.equity), funded: big(bs.day.funded) };
    if (equity > book.peak) bs.peak = equity.toString();
    book.peak = big(bs.peak);
    this.save();

    const tr = await this.anon.get(`/v1/agents/${a.agent}/trades?limit=1`);
    const temperament = this.temperamentOf(a.agent, cfg, (tr.body?.temperament?.temperament as Temperament | undefined) ?? null);
    const temp = cfg.temperaments[temperament] ?? TRADING_DEFAULTS.temperaments.aggressive;
    const realized = typeof tr.body?.summary?.realized_pnl_line === "string" ? BigInt(tr.body.summary.realized_pnl_line) : 0n;
    // deterministic risk exits first (stop-loss, take-profit): limits, not opinions
    const d = riskExits(book, market, cfg, now, this.globalLeft(cfg));
    for (const r of d.refused) this.hit(r);
    if (d.halt) {
      await this.publish({ kind: "halt", ref: `halt:${a.agent}:${d.halt.rule}:${now}`, agent: a.agent, at: now, rule: d.halt.rule, reason: d.halt.reason, treasury: this.treasuryOf(a, book.line, book.sol, d.equity) });
      this.log(`${a.agent.slice(0, 6)} halted: ${d.halt.rule} (${d.halt.reason})`);
      return { trades: 0, refused: d.refused };
    }
    let trades = 0;
    for (const act of d.actions) {
      const r = await this.execute(a, act, cfg, market, temperament, d.equity, {});
      if (r.ok) trades++;
    }
    if (book.halted || book.blackout) return { trades, refused: d.refused };
    // the agent's own analysis round
    const refused = [...d.refused];
    const last = (this.state.rounds ??= {})[a.agent] ?? 0;
    if (cfg.analysis_enabled && this.d.analysis && now - last >= cfg.round_s * 1000) {
      const r = await this.round(a, cfg, market, temperament, temp, realized).catch((e) => {
        this.log(`${a.agent.slice(0, 6)} analysis round failed: ${(e as Error).message}`);
        return { traded: false, refusal: null as Refusal | null };
      });
      if (r.traded) trades++;
      if (r.refusal) refused.push(r.refusal);
    }
    return { trades, refused };
  }

  private treasuryOf(a: TradingAgent, line: bigint, sol: bigint, eq: bigint) {
    return { key: a.key.id, line: line.toString(), sol: sol.toString(), equity: eq.toString(), positions: Object.keys(this.bookState(a.agent).positions).length };
  }

  /** Rebuilds the agent's book from state and chain after a trade (for the next decision of the same tick). */
  private async bookNow(a: TradingAgent, market: Market, base: Book): Promise<Book> {
    const bs = this.bookState(a.agent);
    const bal = await this.d.venue.balances(a.key.id, Object.keys(bs.positions));
    const positions: Record<string, Position> = {};
    for (const [m, p] of Object.entries(bs.positions)) positions[m] = { mint: m, qty: big(p.qty), cost: big(p.cost), opened_at: p.opened_at, last_side: p.last_side, last_at: p.last_at };
    return { ...base, line: bal.line, sol: bal.sol, positions };
  }

  /**
   * One analysis round: the agent's model reads public data and decides; the engine enforces; the
   * trade (if any) executes and its record is published; only then is the analysis posted on the
   * agent's board, with the outcome. Nothing is posted before the trade is done.
   */
  private async round(a: TradingAgent, cfg: TradingConfig, market: Market, temperament: Temperament, temp: TemperamentParams, realized: bigint): Promise<{ traded: boolean; refusal: Refusal | null }> {
    const an = this.d.analysis!;
    const now = this.now();
    const room = an.room(a.agent);
    if (!(room >= cfg.analysis_max_usd)) {
      this.hit({ mint: null, side: null, rule: "analysis_budget", detail: `${room} USD of room` });
      this.log(`${a.agent.slice(0, 6)} analysis waits: ${room.toFixed(4)} USD of room under the caps, a round may cost ${cfg.analysis_max_usd}`);
      return { traded: false, refusal: null };
    }
    const routed = await an.model(a.agent, cfg.analysis_model);
    this.state.rounds![a.agent] = now;
    this.save();
    if (!routed.model) {
      this.hit({ mint: null, side: null, rule: "no_model", detail: routed.why });
      this.log(`${a.agent.slice(0, 6)} no analysis: ${routed.why}`);
      return { traded: false, refusal: null };
    }
    const bs = this.bookState(a.agent);
    const base = await this.bookNow(a, market, {
      agent: a.agent, mint: a.mint, parties: market.tokens.find((t) => t.mint === a.mint)?.parties ?? [], line: 0n, sol: 0n, positions: {},
      day: { start: bs.day?.start ?? 0, equity: big(bs.day?.equity), funded: big(bs.day?.funded) }, peak: big(bs.peak), halted: null, blackout: false,
    });
    base.parties = this.lastParties.get(a.agent) ?? base.parties;
    // an empty treasury has nothing to decide: no model call (it cost about 0.03 USD a round on the site)
    if (base.line < BigInt(cfg.min_trade_line) && !Object.values(base.positions).some((p) => p.qty > 0n)) {
      this.hit({ mint: null, side: null, rule: "empty_treasury", detail: `${base.line} base units of cash, no positions` });
      return { traded: false, refusal: null };
    }
    const input = await this.analysisInput(a, cfg, market, base, temperament, temp, realized);
    const system = systemPrompt(input);
    const user = userPrompt(input);
    let out: { text: string | null; usage: Usage; error?: string };
    try {
      out = await routed.model.complete({ system, user, maxUsd: cfg.analysis_max_usd });
    } catch (e) {
      this.hit({ mint: null, side: null, rule: "model_error", detail: (e as Error).message });
      this.log(`${a.agent.slice(0, 6)} analysis model error: ${(e as Error).message}`);
      return { traded: false, refusal: null };
    }
    an.meter(a.agent, out.usage); // always: what the call cost counts against the caps, whatever it returned
    const model = routed.model.id;
    const usd = Math.round(out.usage.usd * 1e6) / 1e6;
    // follow decisions ride in the same answer (AGENT-FOLLOWS.md); taken out before the trade decision parses
    const split = out.error ? { text: out.text, follows: undefined } : splitFollows(out.text);
    const follows = input.follows ? parseFollows(split.follows, input.follows, a.agent) : { decisions: [], dropped: [] };
    const parsed = out.error ? ({ ok: false, rule: "invalid_decision", detail: out.error, thesis: "" } as const) : parseDecision(split.text);
    const meta = { model, analysis_usd: usd, temperament };
    let refusal: Refusal | null = null;
    let decision: ModelDecision | null = null;
    if (!parsed.ok) refusal = { mint: null, side: null, rule: parsed.rule, detail: parsed.detail };
    else {
      decision = parsed.decision;
      const e = enforceDecision(base, market, cfg, temp, decision, now, this.globalLeft(cfg));
      if (!e.ok) refusal = e.refusal;
      else if (e.action) {
        const x = await this.execute(a, e.action, cfg, market, temperament, equityOf(base, market), { ...meta, thesis: decision.thesis, decision: { action: decision.action, token: decision.token, size_pct: decision.size_pct, reason: decision.reason } });
        if (x.ok) {
          await this.postAnalysis(a, market, decision, { outcome: "filled", ref: x.ref, id: x.id, amount_in: x.amount_in, amount_out: x.amount_out });
          this.logRound(a.agent, now, model, usd, "filled", null, x.ref);
          await this.applyFollows(a, follows);
          return { traded: true, refusal: null };
        }
        refusal = { mint: decision.token, side: decision.action as "buy" | "sell", rule: x.rule, detail: x.detail };
      }
    }
    if (refusal) this.hit(refusal);
    // a hold or a refusal: the decision record first, then (refusals only) the post
    const ref = `decision:${a.agent}:${now}`;
    const thesis = decision?.thesis ?? (parsed.ok ? "" : parsed.thesis);
    const rec = await this.publishNow({
      kind: "decision", ref, agent: a.agent, at: now, outcome: refusal ? "refused" : "hold", rule: refusal?.rule ?? null, detail: refusal?.detail ?? null,
      thesis, action: decision?.action ?? null, mint: decision?.token ?? null, size_pct: decision?.size_pct ?? null, reason: decision?.reason ?? null, ...meta,
    });
    if (refusal) await this.postAnalysis(a, market, decision, { outcome: "refused", rule: refusal.rule, ref, id: rec?.id ?? null });
    this.logRound(a.agent, now, model, usd, refusal ? "refused" : "hold", refusal?.rule ?? null, ref);
    await this.applyFollows(a, follows);
    this.log(`${a.agent.slice(0, 6)} analysis (${model}, ${usd.toFixed(4)} USD): ${decision ? `${decision.action}${decision.token ? ` ${decision.token.slice(0, 6)} ${decision.size_pct}%` : ""}` : "no valid decision"}${refusal ? `, refused by ${refusal.rule}` : ""}`);
    return { traded: false, refusal };
  }

  private logRound(agent: string, at: number, model: string, usd: number, outcome: string, rule: string | null, ref: string, post: string | null = null) {
    const l = (this.state.analyses ??= []);
    l.push({ agent, at, model, usd, outcome, rule, ref, post });
    if (l.length > 500) l.splice(0, l.length - 500);
    this.save();
  }

  private lastParties = new Map<string, string[]>();
  private lastTokens: MarketToken[] = [];
  private lastComponents = new Map<string, Record<string, { raw: number | null }>>();

  private async analysisInput(a: TradingAgent, cfg: TradingConfig, market: Market, book: Book, temperament: Temperament, temp: TemperamentParams, realized: bigint): Promise<AnalysisInput> {
    const [soul, feed, fc] = await Promise.all([
      this.anon.get(`/v1/agents/${a.agent}/soul`),
      this.anon.get("/v1/feed?kinds=generation&limit=100"),
      // whom it follows, their recent public work, whom it could follow (public data; AGENT-FOLLOWS.md)
      this.anon.get(`/v1/agents/${a.agent}/follow-context`).catch(() => ({ status: 0, body: null })),
    ]);
    const doc = soul.status === 200 ? soul.body?.doc : null;
    const persona = doc?.persona ? { name: String(doc.persona.name ?? ""), tagline: String(doc.persona.tagline ?? ""), register: String(doc.persona.voice?.register ?? ""), values: Array.isArray(doc.persona.values) ? doc.persona.values.map(String) : [] } : null;
    const gens: PublicGen[] = feed.status === 200 ? (feed.body.items as any[]).filter((i) => i.kind === "generation" && i.agent && !i.generation?.reverted).map((i) => ({ agent: i.agent, at: i.at, recipe_name: i.recipe_name ?? null, height: i.generation.height, kind: i.generation.kind, target: i.generation.target, gain_pct: i.generation.gain_pct })) : [];
    const info = new Map<string, MarketInfo>();
    for (const t of this.lastTokens) if (t.info) info.set(t.mint, t.info);
    const follows = fc.status === 200 ? (fc.body as FollowContext) : null;
    return { agent: a.agent, temperament, temp, cfg, book, market, info, components: this.lastComponents, gens, realized, persona, now: this.now(), follows };
  }

  /**
   * Sends the round's follow decisions, each signed by the agent's key (its registry signing key),
   * after the trade is done; Core checks the signature, rate limits and maximum. Dropped entries are
   * logged with their rule. No model call happens here.
   */
  private async applyFollows(a: TradingAgent, f: { decisions: FollowDecision[]; dropped: { index: number; rule: string }[] }) {
    const l = (this.state.follows ??= []);
    const at = this.now();
    for (const d of f.dropped) l.push({ agent: a.agent, at, target: null, follow: null, reason: null, outcome: "dropped", rule: d.rule });
    for (const d of f.decisions) {
      const body = signedAgentFollow(a.key as AgentKey, { agent: a.agent, target: d.agent, follow: d.follow, reason: d.reason, now_ms: this.now() });
      const r = await this.anon.post("/v1/social/follow", body).catch((e) => ({ status: 0, body: { error: (e as Error).message } }));
      const ok = r.status === 200;
      l.push({ agent: a.agent, at, target: d.agent, follow: d.follow, reason: d.reason, outcome: ok ? "sent" : "refused", rule: ok ? null : String(r.body?.error ?? `core_${r.status}`) });
      this.log(`${a.agent.slice(0, 6)} ${d.follow ? "follows" : "unfollows"} ${d.agent.slice(0, 6)}: ${ok ? "sent" : `refused (${String(r.body?.error ?? r.status)})`}`);
    }
    if (f.dropped.length) this.log(`${a.agent.slice(0, 6)} follow entries dropped: ${f.dropped.map((d) => d.rule).join("; ")}`);
    if (l.length > 500) l.splice(0, l.length - 500);
    if (f.dropped.length || f.decisions.length) this.save();
  }

  /** The board post of a round, sent only after the trade (or the refusal) is final and recorded. */
  private async postAnalysis(a: TradingAgent, market: Market, d: ModelDecision | null, o: { outcome: "filled" | "refused"; rule?: string; ref: string; id: number | null; amount_in?: bigint; amount_out?: bigint }) {
    const an = this.d.analysis!;
    const own = this.lastTokens.find((t) => t.mint === a.mint)?.info?.lineage_id ?? null;
    if (!own) {
      this.log(`${a.agent.slice(0, 6)} analysis not posted: no lineage board for its own token`);
      return null;
    }
    const link = ` /trading/${a.agent}${o.id !== null ? `#r${o.id}` : ""}`;
    if (!d) {
      // the model's output was not a valid decision: the refusal is published without its text
      const id = await this.d.analysis!.post(a.agent, `board:${own}`, `My analysis this round was refused by the engine: ${o.rule}. Nothing traded.${link}`).catch(() => null);
      (this.state.posts ??= []).push({ agent: a.agent, at: this.now(), ref: o.ref, msg_id: id, board: own });
      this.save();
      return id;
    }
    const sym = this.lastTokens.find((t) => t.mint === d.token)?.info?.symbol ?? d.token?.slice(0, 6) ?? "";
    const dec = this.d.lineDecimals;
    const tdec = market.tokens.find((t) => t.mint === d.token)?.decimals ?? 6;
    const outcome =
      o.outcome === "filled"
        ? `Filled: ${d.action === "buy" ? `${(Number(o.amount_in) / 10 ** dec).toFixed(2)} ${quoteWords().q} for ${(Number(o.amount_out) / 10 ** tdec).toFixed(2)} ${sym}` : `${(Number(o.amount_in) / 10 ** tdec).toFixed(2)} ${sym} for ${(Number(o.amount_out) / 10 ** dec).toFixed(2)} ${quoteWords().q}`}.`
        : `Refused by the engine: ${o.rule}.`;
    const head = `Decision: ${d.action} ${sym} ${d.size_pct}% of ${d.action === "buy" ? "treasury" : "the position"}. ${outcome}`;
    const enc = new TextEncoder();
    const budget = 560 - enc.encode(head + link).length - "Thesis: ".length - 2;
    let thesis = d.thesis;
    if (enc.encode(thesis).length > budget) {
      while (enc.encode(thesis).length > budget - 3) thesis = thesis.slice(0, -1);
      thesis = `${thesis.trimEnd()}...`;
    }
    const text = `Thesis: ${thesis} ${head}${link}`;
    const id = await an.post(a.agent, `board:${own}`, text).catch((e) => (this.log(`${a.agent.slice(0, 6)} analysis post failed: ${(e as Error).message}`), null));
    const l = this.state.analyses?.at(-1);
    if (l && l.ref === o.ref) l.post = id;
    (this.state.posts ??= []).push({ agent: a.agent, at: this.now(), ref: o.ref, msg_id: id, board: own });
    if (this.state.posts.length > 500) this.state.posts.splice(0, this.state.posts.length - 500);
    this.save();
    this.log(`${a.agent.slice(0, 6)} analysis posted on board:${own.slice(0, 8)}: ${id ?? "not sent"}`);
    return id;
  }

  /** Publishes now and returns Core's stored record (or null when Core is unreachable; then it is queued). */
  private async publishNow(rec: Record<string, unknown>): Promise<{ id: number } | null> {
    await this.flush();
    const r = await this.client.post("/v1/trades", rec).catch(() => ({ status: 0, body: null }));
    if (r.status === 200) return r.body as { id: number };
    if (r.status === 0 || r.status >= 500) {
      this.state.outbox.push(rec);
      this.save();
    } else this.log(`record ${String(rec.ref)} refused by Core: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    return null;
  }

  private async execute(a: TradingAgent, act: Action, cfg: TradingConfig, market: Market, temperament: Temperament, equityBefore: bigint, extra: Record<string, unknown>): Promise<{ ok: true; ref: string; id: number | null; amount_in: bigint; amount_out: bigint } | { ok: false; rule: string; detail: string }> {
    try {
      return await this.executeInner(a, act, cfg, market, temperament, equityBefore, extra);
    } catch (e) {
      this.log(`${a.agent.slice(0, 6)} ${act.side} ${act.mint.slice(0, 6)} failed: ${(e as Error).message}`);
      this.hit({ mint: act.mint, side: act.side, rule: "execution_failed", detail: (e as Error).message });
      return { ok: false, rule: "execution_failed", detail: (e as Error).message.slice(0, 200) };
    }
  }

  private async executeInner(a: TradingAgent, act: Action, cfg: TradingConfig, market: Market, temperament: Temperament, equityBefore: bigint, extra: Record<string, unknown>): Promise<{ ok: true; ref: string; id: number | null; amount_in: bigint; amount_out: bigint } | { ok: false; rule: string; detail: string }> {
    const t = market.tokens.find((x) => x.mint === act.mint)!;
    const now = this.now();
    const held = this.state.books[a.agent]?.positions[act.mint];
    const positionBefore = held ? valueOf(big(held.qty), t.price, t.decimals, this.d.lineDecimals) : 0n;
    // Core's integrity rules, before any money moves
    const dry = await this.client.post("/v1/trades", { kind: "trade", dry_run: true, ref: `dry:${a.agent}:${now}`, agent: a.agent, at: now, mint: act.mint, side: act.side, venue: t.venue, amount_in: act.amount.toString(), amount_out: "0", rule: act.rule, reason: act.reason, score: act.score, signature: "sim:dry-run" });
    if (dry.status !== 200) {
      const rule = String(dry.body?.error ?? `core_${dry.status}`);
      this.hit({ mint: act.mint, side: act.side, rule, detail: String(dry.body?.message ?? "") });
      this.log(`${a.agent.slice(0, 6)} ${act.side} ${act.mint.slice(0, 6)} refused by Core: ${rule}`);
      return { ok: false, rule, detail: String(dry.body?.message ?? "") };
    }
    // quote by simulation; a price impact over the limit refuses the trade (never resized)
    const amount = act.amount;
    const q = await this.d.venue.quote(a.key, t, act.side, amount);
    if (q.impact_bps > cfg.max_impact_bps) {
      this.hit({ mint: act.mint, side: act.side, rule: "max_impact", detail: `${q.impact_bps} bps` });
      this.log(`${a.agent.slice(0, 6)} ${act.side} ${act.mint.slice(0, 6)} refused: price impact ${q.impact_bps} bps over ${cfg.max_impact_bps}`);
      return { ok: false, rule: "max_impact", detail: `simulated price impact ${q.impact_bps} bps, limit ${cfg.max_impact_bps}` };
    }
    if (q.out <= 0n) {
      this.hit({ mint: act.mint, side: act.side, rule: "zero_out", detail: "simulated output is zero" });
      return { ok: false, rule: "zero_out", detail: "the simulated output is zero" };
    }
    const minOut = (q.out * BigInt(10_000 - cfg.max_slippage_bps)) / 10_000n;
    const fill = await this.d.venue.execute(a.key, t, act.side, amount, minOut);
    this.state.epoch.count++;
    this.state.trades++;
    // book: cost basis follows the fill
    const bs = this.bookState(a.agent);
    const p = (bs.positions[act.mint] ??= { mint: act.mint, qty: "0", cost: "0", opened_at: now, last_side: act.side, last_at: now });
    let realized: bigint | null = null;
    if (act.side === "buy") {
      if (big(p.qty) === 0n) p.opened_at = now;
      p.qty = (big(p.qty) + fill.amount_out).toString();
      p.cost = (big(p.cost) + fill.amount_in).toString();
    } else {
      const qty = big(p.qty);
      const removed = qty > 0n ? (big(p.cost) * fill.amount_in) / qty : 0n;
      realized = fill.amount_out - removed;
      p.cost = (big(p.cost) - removed).toString();
      p.qty = (qty - fill.amount_in).toString();
    }
    p.last_side = act.side;
    p.last_at = now;
    if (big(p.qty) <= 0n) delete bs.positions[act.mint];
    this.save();
    const after = await this.d.venue.balances(a.key.id, Object.keys(bs.positions));
    const positions: Record<string, Position> = {};
    for (const [m, x] of Object.entries(bs.positions)) positions[m] = { mint: m, qty: big(x.qty), cost: big(x.cost), opened_at: x.opened_at, last_side: x.last_side, last_at: x.last_at };
    const eq = equityOf({ line: after.line, positions } as Book, market);
    const tokenAmt = act.side === "buy" ? fill.amount_out : fill.amount_in;
    const lineAmt = act.side === "buy" ? fill.amount_in : fill.amount_out;
    const price = tokenAmt > 0n ? Number(lineAmt) / 10 ** this.d.lineDecimals / (Number(tokenAmt) / 10 ** t.decimals) : null;
    const ref = `trade:${fill.signature}`;
    const rec = await this.publishNow({
      kind: "trade",
      ref,
      agent: a.agent,
      at: now,
      mint: act.mint,
      token_agent: t.agent,
      side: act.side,
      venue: fill.venue,
      amount_in: fill.amount_in.toString(),
      amount_out: fill.amount_out.toString(),
      price,
      signature: fill.signature,
      fee_lamports: fill.fee_lamports,
      rule: act.rule,
      reason: act.reason,
      ...extra,
      temperament,
      score: act.score,
      quote_out: q.out.toString(),
      min_out: minOut.toString(),
      impact_bps: q.impact_bps,
      planned_in: act.amount.toString(),
      equity_before: equityBefore.toString(),
      position_before: positionBefore.toString(),
      realized_pnl: realized === null ? null : realized.toString(),
      limits: { max_trade_bps: cfg.max_trade_bps, max_position_bps: cfg.max_position_bps, max_slippage_bps: cfg.max_slippage_bps, max_impact_bps: cfg.max_impact_bps, cooldown_s: cfg.cooldown_s, min_hold_s: cfg.min_hold_s },
      treasury: { key: a.key.id, line: after.line.toString(), sol: after.sol.toString(), equity: eq.toString(), positions: Object.keys(bs.positions).length },
    });
    this.log(`${a.agent.slice(0, 6)} ${act.side} ${t.mint.slice(0, 6)} ${fill.venue}: in ${fill.amount_in} out ${fill.amount_out} (${act.rule}) ${fill.signature.slice(0, 12)}`);
    return { ok: true, ref, id: rec?.id ?? null, amount_in: fill.amount_in, amount_out: fill.amount_out };
  }

  /** A public summary for logs and the observation report (no keys). */
  summary() {
    return { trades: this.state.trades, limit_hits: this.state.limit_hits, outbox: this.state.outbox.length, last_tick: this.state.last_tick, agents: Object.keys(this.state.books).length };
  }
}
