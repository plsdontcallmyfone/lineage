import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { AgentKey } from "@lineage/protocol";
import { CoreClient } from "../../core/src/client.ts";
import { Worker } from "../../worker/src/worker.ts";
import type { Meter, Proposer } from "../../worker/src/proposers/types.ts";
import type { Backend, HostedAgent, Vault } from "./backend.ts";
import { chainCostOf, costOf, resolvePrices, usdFor, windowStart, type Prices, type RuntimeConfig } from "./config.ts";
import type { ChainFee, Messenger } from "../../core/src/msgchain.ts";
import { provenanceRecord, signProvenance, type AttemptTotals } from "./provenance.ts";
import { emptyUsage, isAgentId, Lock, modelTokens, redact, StateStore, type AgentUsage, type ClosedEpoch } from "./state.ts";
import { AgentPoster, emptyPostState, POSTS_DEFAULTS, type PostState } from "./posts.ts";
import type { ModelClient, Usage as SoulUsage } from "../../souls/src/generator.ts";
import type { DesktopProvider } from "../../desktop/src/pool.ts";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { FixedPrice, type PriceSource, type QuotePrice } from "./price.ts";
import type { OpenRouterBalance } from "./provider-balance.ts";

/** A spend figure for logs; a corrupt record shows as such (the caps then refuse every attempt). */
const usd4 = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(4) : `unknown (${String(x)})`);

// The hosted runtime (SPEC 17.2): runs every hosted launched agent. For each one it generates its
// own signing key and waits for the owner to bind it (identity plan I1; the launcher's key never
// reaches the runtime), then authors with the Claude proposer while the agent's compute vault pays:
// every model response and sandbox evaluation is metered into a per-agent usage record, each usage
// epoch is posted (devnet: post_usage plus debit_compute; sim: Core's usage endpoint), and the agent
// sleeps when its vault falls below sleep_threshold and resumes when new fees wake it.

export interface RuntimeDeps {
  backend: Backend;
  /** the runtime authority key (signs provenance; on devnet it is LaunchConfig.runtime_authority) */
  runtimeKey: AgentKey;
  /** a proposer per agent (production: the Claude proposer; tests: one with a fake model client) */
  proposer: (agent: string) => Proposer;
  log?: (m: string) => void;
  now?: () => number;
  /** heartbeats and activity from each agent's worker (SPEC 17.1); default on */
  telemetry?: boolean;
  /**
   * Onchain messages (SPEC 12.5, devnet): a transport per bound agent, signing with the agent's
   * runtime key; the runtime pays the fees and `onFee` bills them to the agent's usage ("chain fee").
   */
  messenger?: (agent: string, key: AgentKey, onFee: (f: ChainFee) => void) => Messenger | undefined;
  /**
   * Agents as traders (plan T, packages/trader glue.ts): when a usage epoch is due, `share` gives the
   * trade share of each bound agent's new fee income, which rides its usage leaf as the line "trade
   * share"; after epochs post, `forward` moves each landed share from the compute sink to the treasury.
   */
  trading?: {
    share(o: { agent: string; mint: string; vault: bigint; computeOwed: bigint; wake: bigint }): Promise<{ amount: bigint; basis: unknown } | null>;
    forward(epochs: ClosedEpoch[], save: () => void): Promise<void>;
  };
  /** Agent posts (plan S, posts.ts): the model client posts are written with; absent = no posts. */
  postClient?: ModelClient;
  /** Agent desktops (SPEC 17.7, packages/desktop): a live desktop per attempt when a slot is free. */
  desktop?: DesktopProvider;
  /**
   * Plan MODELS-AND-SELF-FUNDING. `route`: which model and route an agent runs on now (the routed
   * proposers resolve it from the soul); `providerBalance`: OpenRouter's balance gate; `price`: the
   * quote token's price (default the configured TEST rate); `report`: posts the spend summary to Core.
   */
  route?: (agent: string) => Promise<AgentRoute | null>;
  providerBalance?: OpenRouterBalance;
  price?: PriceSource;
  report?: (body: SpendReport) => Promise<void>;
}

export interface AgentRoute {
  via: "direct" | "openrouter" | null;
  model: { provider: string; id: string } | null;
  why: string | null;
}

/** What the runtime publishes per agent (GET /v1/agents/:id/spend): real figures only, null when not known. */
export interface SpendReport {
  at: number;
  price: { source: string; status: string; usd_per_token: number | null; line_per_usd: string | null; why: string | null };
  provider_balance: { openrouter: { usd: number | null; source: string | null; read_at: number | null; low: boolean } | null };
  agents: Record<string, {
    vault: string | null;
    vault_usd: number | null;
    burn_per_h: string | null;
    burn_usd_per_h: number | null;
    burn_window_s: number | null;
    runway_h: number | null;
    model: { provider: string; id: string } | null;
    via: "direct" | "openrouter" | null;
    waiting: string | null;
  }>;
}

interface Attempt {
  agent: string;
  maxUsd: number;
  totals: AttemptTotals;
  /** the route the attempt was started on (OpenRouter attempts hold part of its balance) */
  via?: "direct" | "openrouter" | null;
}

interface Running {
  agent: string;
  promise: Promise<void>;
}

/** Agents ordered least recently started first (never started first, then by state order). */
/**
 * How long an agent waits after `failures` attempts in a row that failed for infrastructure reasons
 * (the attempt threw: a provider error, the sandbox, Core): 30 s doubling, capped at 15 min (owner
 * direction 2026-10-10, "the live stuff always"). An attempt that ended normally without a candidate
 * is not a failure: a funded agent starts its next one after `attempt_gap_s` (TEST 30 s). An agent
 * whose vault cannot pay never starts (budget), so it needs no backoff here.
 */
export function failureBackoffMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(30_000 * 2 ** (failures - 1), 15 * 60_000);
}

/** @deprecated kept for callers of the old name: the infrastructure-failure backoff. */
export const missBackoffMs = failureBackoffMs;

export function fairOrder<T>(entries: [string, T][], lastStarted: Map<string, number>): [string, T][] {
  return entries.map((e, i) => ({ e, i, t: lastStarted.get(e[0]) ?? -1 })).sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.e);
}

export class Runtime {
  readonly store: StateStore;
  private lock: Lock;
  private prices!: Prices;
  private limits!: { decimals: number; sleepThreshold: bigint; wakeThreshold: bigint; maxDebitPerEpoch: bigint | null };
  private workers = new Map<string, Worker>();
  private running = new Map<string, Running>();
  private attempts = new Map<string, Attempt>();
  private vaults = new Map<string, Vault>();
  private hosted = new Map<string, HostedAgent>();
  /** When each agent's last attempt started (this process): the attempt slots go round robin. */
  private lastStarted = new Map<string, number>();
  /** Infrastructure failures in a row, and when the agent may try again (failure backoff or the short gap). */
  private misses = new Map<string, { n: number; until: number }>();
  private exhausted = new Set<string>();
  private client: CoreClient;
  private ticks = 0;
  private stopping = false;
  private posting: Promise<void> | null = null;
  private runSpent = 0;
  private log: (m: string) => void;
  private now: () => number;
  private pendingProvenance: { agent: string; commit_id: string; totals: AttemptTotals }[] = [];
  private poster: AgentPoster | null = null;
  private postState: PostState = emptyPostState();
  private postsRun: Promise<void> | null = null;
  /** plan MODELS-AND-SELF-FUNDING */
  private price!: PriceSource;
  private routes = new Map<string, { at: number; r: AgentRoute }>();
  /** USD held for an analysis or post that asked for room and has not metered yet */
  private holds = new Map<string, { usd: number; until: number; via: AgentRoute["via"] }>();
  private waiting = new Map<string, string>();
  private lastReport = 0;

  constructor(readonly cfg: RuntimeConfig, private deps: RuntimeDeps) {
    const sink = deps.log ?? ((m: string) => console.log(`[${new Date().toISOString().slice(11, 19)} runtime] ${m}`));
    this.log = (m) => sink(redact(m));
    this.now = deps.now ?? Date.now;
    this.lock = new Lock(cfg.state_dir);
    this.lock.acquire();
    try {
      this.store = new StateStore(cfg.state_dir, { mode: cfg.mode, runtime: deps.runtimeKey.id, now: this.now() });
    } catch (e) {
      this.lock.release();
      throw e;
    }
    this.client = new CoreClient(cfg.core, deps.runtimeKey);
  }

  get state() {
    return this.store.state;
  }

  private save() {
    this.store.save();
  }

  async start(): Promise<void> {
    this.limits = await this.deps.backend.init();
    this.prices = resolvePrices(this.cfg, this.limits.decimals);
    this.price = this.deps.price ?? new FixedPrice(this.cfg.compute_price_line_per_usd, this.limits.decimals);
    await this.price.refresh();
    this.applyPrice();
    this.startPoster();
    this.state.runs.push({ started_at: this.now(), stopped_at: null, spent_usd: 0, pid: process.pid });
    this.save();
    const unposted = this.state.closed.filter((e) => !e.done).length;
    const cap = this.capStatus();
    const capText = cap.window_s
      ? `global cap ${cap.max_usd} USD per ${cap.window_s} s window (${cap.window_s === 86400 ? "UTC day" : "aligned to the Unix epoch"}), this window ${new Date(cap.window_start!).toISOString()} to ${new Date(cap.window_end!).toISOString()} spent ${usd4(cap.spent_usd)}; lifetime ${usd4(this.state.spent_usd_total)} USD`
      : `spent so far ${usd4(this.state.spent_usd_total)} of ${this.cfg.global_max_usd} USD (lifetime cap)`;
    const q = this.price.current(this.now());
    this.log(
      `started (${this.cfg.mode}, runtime ${this.deps.runtimeKey.id}, pid ${process.pid}); prices ${q?.status === "live" ? `${q.perUsd} base units per USD (live, ${q.source})` : q ? `${this.cfg.compute_price_line_per_usd} $LINE per USD (TEST value)` : `no quote price yet (${this.price.why(this.now())})`} and ${this.cfg.compute_price_line_per_sandbox_s} per sandbox second; vault-funded spend has no global cap, the ${this.cfg.global_cap_scope === "all" ? "global cap counts every USD" : "global cap counts subsidized spend only"}: ${capText}${unposted ? `; recovering ${unposted} unposted usage epoch(s)` : ""}`,
    );
  }

  /** The quote price in force (plan MODELS-AND-SELF-FUNDING), copied into `prices` when fresh. */
  private applyPrice(): QuotePrice | null {
    // before start() (tests that set prices directly): the configured rate in `prices`
    if (!this.price) return this.prices ? { perUsd: this.prices.perUsd, usd: null, source: "config", status: "test", at: 0 } : null;
    const q = this.price.current(this.now());
    if (q && this.prices) this.prices = { ...this.prices, perUsd: q.perUsd };
    return q;
  }

  // ------------------------------------------------------------------ budgets

  private usageOf(agent: string): AgentUsage {
    return (this.state.open.usage[agent] ??= emptyUsage());
  }

  /** What a usage record costs: model spend and sandbox time, plus chain fees paid for the agent. */
  private usageCost(u: AgentUsage): bigint {
    return costOf(this.prices, u.usd, u.sandbox_s) + chainCostOf(this.prices, u.chain_lamports ?? 0) + BigInt(u.trade_share ?? "0");
  }

  /** Records lamports this runtime paid for one of the agent's onchain messages (usage line "chain fee"). */
  private meterChain(f: ChainFee): void {
    const u = this.usageOf(f.agent);
    u.chain_lamports = (u.chain_lamports ?? 0) + f.lamports;
    u.chain_txs = (u.chain_txs ?? 0) + 1;
    this.save();
    this.log(`${f.agent.slice(0, 6)} chain fee ${f.lamports} lamports for ${f.what} ${f.signature}`);
  }

  /** Base units already owed by `agent`: its open usage plus closed epochs not yet debited. */
  owed(agent: string): bigint {
    const u = this.state.open.usage[agent];
    let owed = u ? this.usageCost(u) : 0n;
    for (const e of this.state.closed) {
      if (e.done || e.debits[agent]) continue;
      const l = e.leaves.find((x) => x.agent === agent);
      if (l) owed += BigInt(l.amount);
    }
    return owed;
  }

  /**
   * The current spend window (config `global_window_s`), rolled over when the clock left it: the
   * closed window goes to `windows` and a new one starts at 0. Null for a lifetime cap.
   */
  private spendWindow(): { start: number; window_s: number; usd: number } | null {
    const ws = this.cfg.global_window_s;
    if (!ws) return null;
    const start = windowStart(this.now(), ws);
    const w = this.state.window;
    if (!w || w.start !== start || w.window_s !== ws) {
      // a clock that went backwards never reopens a closed window with a fresh budget
      if (w && w.window_s === ws && w.start > start) return w;
      if (w) {
        (this.state.windows ??= []).push(w);
        if (this.state.windows.length > 60) this.state.windows.splice(0, this.state.windows.length - 60);
        this.log(`spend window ${new Date(w.start).toISOString()} closed at ${usd4(w.usd)} USD of ${this.cfg.global_max_usd}`);
      }
      this.state.window = { start, window_s: ws, usd: 0 };
      this.save();
    }
    return this.state.window!;
  }

  /** The global cap as configured, and the spend counter it is checked against (public: no keys). */
  capStatus() {
    const w = this.spendWindow();
    const spent = w ? w.usd : this.state.spent_usd_total;
    return {
      max_usd: this.cfg.global_max_usd,
      window_s: this.cfg.global_window_s ?? null,
      window_start: w ? w.start : null,
      window_end: w ? w.start + w.window_s * 1000 : null,
      spent_usd: spent,
      left_usd: Math.max(0, this.globalLeft()),
      lifetime_usd: this.state.spent_usd_total,
      past_windows: (this.state.windows ?? []).slice(-7),
    };
  }

  private globalLeft(): number {
    let reserved = 0;
    // only "all" counts open reserves: in "subsidized" scope no attempt draws on the cap
    if (this.cfg.global_cap_scope === "all") for (const a of this.attempts.values()) reserved += Math.max(0, a.maxUsd - a.totals.usd);
    // a non-finite or negative total (NaN usage saved as null) must not reset the cap (audit A2, OFF-R3)
    const total = this.state.spent_usd_total;
    if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return 0;
    const w = this.spendWindow();
    const spent = w ? w.usd : this.cfg.global_cap_scope === "all" ? total : (this.state.subsidized_usd_total ?? 0);
    if (typeof spent !== "number" || !Number.isFinite(spent) || spent < 0) return 0;
    return this.cfg.global_max_usd - spent - reserved;
  }

  /** Base units the agent's running attempt still holds (unspent model reserve and sandbox reserve) plus open holds. */
  private reservedLine(agent: string): bigint {
    let line = 0n;
    const a = this.attempts.get(agent);
    if (a) line += costOf(this.prices, Math.max(0, a.maxUsd - a.totals.usd), Math.max(0, this.cfg.sandbox_reserve_s - a.totals.sandbox_s));
    const h = this.holds.get(agent);
    if (h && h.until > this.now()) line += costOf(this.prices, h.usd, 0);
    return line;
  }

  /** USD the OpenRouter balance still covers after the reserves of running OpenRouter attempts and holds; null: unknown or not used. */
  private providerRoom(): number | null {
    const b = this.deps.providerBalance?.room();
    if (b === null || b === undefined) return null;
    let held = 0;
    for (const a of this.attempts.values()) if (a.via === "openrouter") held += Math.max(0, a.maxUsd - a.totals.usd);
    for (const h of this.holds.values()) if (h.via === "openrouter" && h.until > this.now()) held += h.usd;
    return b - held;
  }

  /** The cached route of an agent (refreshed in refreshAgents); null when unknown. */
  routeOf(agent: string): AgentRoute | null {
    return this.routes.get(agent)?.r ?? null;
  }

  /**
   * The most an attempt (or a post or analysis, with `sandbox` false) for `agent` may spend now (USD),
   * or null with the reason (plan MODELS-AND-SELF-FUNDING, owner decision 2026-10-10: the agent's own
   * vault pays and there is no platform cap on it). Lowest of: the per-attempt cap, what the vault
   * still pays at the current quote price after what it already owes, what its running attempt and
   * holds still reserve, and a sandbox reserve; the optional per-agent epoch cap; the onchain
   * max_debit_per_epoch left this epoch; for an OpenRouter-routed model, what OpenRouter's known
   * balance still covers; and only with global_cap_scope "all", the global window.
   */
  budget(agent: string, o: { sandbox?: boolean; cap?: number } = {}): { usd: number } | { usd: null; why: string; vault: boolean } {
    const v = this.vaults.get(agent);
    if (!v) return { usd: null, why: "vault unknown", vault: false };
    if (!v.awake) return { usd: null, why: "asleep", vault: true };
    if (!this.applyPrice()) return { usd: null, why: `waiting for a quote price (${this.price?.why(this.now()) ?? "none"})`, vault: false };
    const avail = v.balance - this.owed(agent) - this.reservedLine(agent);
    let line = avail;
    if (this.limits.maxDebitPerEpoch !== null) {
      let epochOwed = 0n;
      for (const u of Object.values(this.state.open.usage)) epochOwed += this.usageCost(u);
      for (const a of this.attempts.keys()) epochOwed += this.reservedLine(a);
      const left = this.limits.maxDebitPerEpoch - epochOwed;
      if (left < line) line = left;
    }
    const fromVault = usdFor(this.prices, line, o.sandbox === false ? 0 : this.cfg.sandbox_reserve_s);
    const used = this.usageOf(agent).usd;
    const epochCap = this.cfg.agent_epoch_max_usd;
    const epochLeft = epochCap === null || epochCap === undefined ? Infinity : typeof used === "number" && Number.isFinite(used) && used >= 0 ? epochCap - used : 0;
    if (typeof used !== "number" || !Number.isFinite(used)) return { usd: null, why: "spend record is not a finite number; refusing to start an attempt", vault: false };
    const g = this.cfg.global_cap_scope === "all" ? this.globalLeft() : Infinity;
    const route = this.routeOf(agent);
    const pr = route?.via === "openrouter" ? this.providerRoom() : null;
    const prov = pr === null ? Infinity : pr;
    const usd = Math.min(o.cap ?? this.cfg.attempt_max_usd, fromVault, epochLeft, g, prov);
    if (Number.isNaN(usd)) return { usd: null, why: "spend record is not a finite number; refusing to start an attempt", vault: false };
    if (!(usd >= (o.sandbox === false ? Math.min(this.cfg.min_attempt_usd, o.cap ?? Infinity) : this.cfg.min_attempt_usd))) {
      const why =
        prov === usd ? `provider balance low (OpenRouter has ${(this.deps.providerBalance?.room() ?? 0).toFixed(2)} USD, ${Math.max(0, prov).toFixed(4)} free of running reserves)`
        : g === usd ? `global runtime cap (${this.cfg.global_max_usd} USD${this.cfg.global_window_s ? ` per ${this.cfg.global_window_s} s window` : ""}) reached`
        : epochLeft === usd ? "per-agent epoch cap reached"
        : `compute vault exhausted (${avail} base units unowed)`;
      return { usd: null, why, vault: fromVault === usd };
    }
    return { usd };
  }

  private meterFor(a: Attempt): Meter {
    return {
      model: (u) => {
        const t = a.totals;
        t.input_tokens += u.input_tokens;
        t.output_tokens += u.output_tokens;
        t.cache_read_tokens += u.cache_read_tokens;
        t.cache_write_tokens += u.cache_write_tokens;
        t.usd += u.usd;
        if (!t.models.includes(u.model)) t.models.push(u.model);
        const s = this.usageOf(a.agent);
        s.input_tokens += u.input_tokens;
        s.output_tokens += u.output_tokens;
        s.cache_read_tokens += u.cache_read_tokens;
        s.cache_write_tokens += u.cache_write_tokens;
        s.usd += u.usd;
        if (!s.models.includes(u.model)) s.models.push(u.model);
        this.state.spent_usd_total += u.usd;
        const w = this.cfg.global_cap_scope === "all" ? this.spendWindow() : null;
        if (w) w.usd += u.usd;
        this.runSpent += u.usd;
        const run = this.state.runs[this.state.runs.length - 1];
        if (run) run.spent_usd = this.runSpent;
        this.save();
      },
      sandbox: (sec) => {
        a.totals.sandbox_s += sec;
        this.usageOf(a.agent).sandbox_s += sec;
        this.save();
      },
      harness: (h) => {
        a.totals.proposer = h; // plan M: provenance attests the harness and provider that ran
      },
      route: (r) => {
        a.totals.route = { via: r.via, model: r.model, upstream: a.totals.route?.upstream ?? [] }; // provenance attests the route that ran
        a.via = r.via;
      },
      upstream: (name) => {
        const rt = (a.totals.route ??= { via: "openrouter", model: { provider: "", id: "" }, upstream: [] });
        if (!rt.upstream.includes(name) && rt.upstream.length < 8) rt.upstream.push(name);
      },
    };
  }

  // ------------------------------------------------------------------ agents

  private worker(agent: string): Worker {
    let w = this.workers.get(agent);
    if (w) return w;
    const key = this.store.keyFor(agent);
    w = new Worker({
      core: this.cfg.core,
      key: { ...key, agent } as AgentKey,
      proposer: this.deps.proposer(agent),
      lineages: this.cfg.lineages,
      telemetry: this.deps.telemetry !== false,
      stateDir: join(this.cfg.state_dir, "worker", agent),
      log: (m) => this.log(`${agent.slice(0, 6)} ${m}`),
      collab: "advisory",
      // agent journal (SPEC 17.6): own notes in, one entry out per session, inside the attempt cap
      journal: true,
      messenger: this.deps.messenger?.(agent, key, (f) => this.meterChain(f)),
      desktop: this.deps.desktop,
      attempt: () => {
        const b = this.budget(agent);
        if (b.usd === null) {
          this.log(`${agent.slice(0, 6)} attempt not started: ${b.why}`);
          this.waiting.set(agent, b.why);
          if (b.vault) this.exhausted.add(agent);
          return null;
        }
        this.waiting.delete(agent);
        const a: Attempt = { agent, maxUsd: b.usd, via: this.routeOf(agent)?.via ?? null, totals: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, usd: 0, sandbox_s: 0, models: [], started_at: this.now(), finished_at: 0 } };
        this.attempts.set(agent, a);
        this.usageOf(agent).attempts++;
        this.save();
        this.log(`${agent.slice(0, 6)} attempt starts, cap ${b.usd.toFixed(4)} USD`);
        return { maxUsd: b.usd, meter: this.meterFor(a) };
      },
    });
    this.workers.set(agent, w);
    if (this.deps.telemetry !== false) void w.telemetry.start();
    return w;
  }

  /** A newly seen hosted agent: its runtime key (made once) and the bind request for its owner. */
  private async adopt(h: HostedAgent): Promise<void> {
    const key = this.store.keyFor(h.agent);
    this.state.agents[h.agent] = { key_id: key.id, key_file: this.store.keyFile(h.agent), status: "awaiting_owner", discovered_at: this.now(), bound_at: null, mint: h.mint, target_repo: h.target_repo, candidates: 0 };
    this.save();
    const req = await this.deps.backend.bindRequest(h.agent, key);
    const dir = join(this.cfg.state_dir, "bind-requests");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${h.agent}.json`), JSON.stringify(req, null, 2));
    this.log(`discovered hosted agent ${h.agent} (${h.target_repo ?? "no target"}); generated runtime key ${key.id}; waiting for the owner to bind it`);
  }

  /**
   * The bind endpoint (bind.ts): the runtime key a hosted agent's owner rotates to. An agent the
   * runtime has not discovered yet is read from chain at once and adopted when it is a hosted launch;
   * null when it is not one.
   */
  async bindTarget(agent: string): Promise<{ agent: string; new_key: string; status: string } | null> {
    if (!isAgentId(agent)) return null;
    if (!this.state.agents[agent]) {
      const h = await this.deps.backend.hostedAgent?.(agent);
      if (!h || h.agent !== agent) return null;
      this.hosted.set(agent, h);
      if (!this.state.agents[agent]) await this.adopt(h);
    }
    const st = this.state.agents[agent]!;
    return { agent, new_key: st.key_id, status: st.status };
  }

  /** The runtime key of an agent this runtime adopted (never makes one). */
  keyOf(agent: string): AgentKey | null {
    return this.state.agents[agent] ? this.store.keyFor(agent) : null;
  }

  /** Discovery, binding and vault reads. */
  private async refreshAgents(): Promise<void> {
    const b = this.deps.backend;
    if (this.ticks % (b.mode === "devnet" ? 6 : 1) === 0 || this.hosted.size === 0) {
      for (const h of await b.discover()) {
        // ids become file names below: a malformed one from Core or the chain is skipped (audit A2, OFF-R1)
        if (!isAgentId(h.agent)) {
          this.log(`skipping a discovered agent with a malformed id ${JSON.stringify(String(h.agent).slice(0, 60))}`);
          continue;
        }
        this.hosted.set(h.agent, h);
        if (this.state.agents[h.agent]) continue;
        await this.adopt(h);
      }
    }
    for (const [agent, st] of Object.entries(this.state.agents)) {
      const h = this.hosted.get(agent);
      if (!h) continue;
      const signing = await b.signingKey(agent);
      if (signing === st.key_id && st.status !== "bound") {
        st.status = "bound";
        st.bound_at = this.now();
        this.save();
        this.log(`agent ${agent} is bound to runtime key ${st.key_id}`);
      } else if (signing !== st.key_id && st.status === "bound") {
        st.status = "unbound";
        this.save();
        this.log(`agent ${agent}: its owner moved the signing key away from this runtime (${signing ?? "revoked"}); not authoring`);
      }
      if (st.status !== "bound") continue;
      const before = this.vaults.get(agent);
      let v = await b.vault(h);
      if (await b.refreshAwake(h, v, this.limits.wakeThreshold, this.limits.sleepThreshold)) v = await b.vault(h);
      this.vaults.set(agent, v);
      if (before && before.awake !== v.awake) this.log(`agent ${agent} is ${v.awake ? "awake" : "asleep"} (compute vault ${v.balance} base units)`);
      // the model and route the agent runs on now (its soul, the keys on this host), refreshed every minute
      if (this.deps.route && (this.now() - (this.routes.get(agent)?.at ?? -Infinity) >= 60_000)) {
        const r = await this.deps.route(agent).catch(() => null);
        if (r) this.routes.set(agent, { at: this.now(), r });
      }
      // exhausted until the vault can pay for an attempt again (new fees, or a debit lowered what it owes)
      if (this.exhausted.has(agent) && this.budget(agent).usd !== null) this.exhausted.delete(agent);
    }
  }

  /**
   * Attempt slots now: at least one per funded bound agent (awake, vault can pay), never fewer than
   * `max_concurrent`, never more than `max_concurrent_ceiling` (owner direction 2026-10-10: funded
   * agents are live all the time; the ceiling is what the server carries).
   */
  slots(): number {
    const ceiling = this.cfg.max_concurrent_ceiling ?? this.cfg.max_concurrent;
    let funded = 0;
    for (const [agent, st] of Object.entries(this.state.agents)) {
      if (st.status !== "bound" || this.exhausted.has(agent) || !this.vaults.get(agent)?.awake) continue;
      if (this.running.has(agent) || this.budget(agent).usd !== null) funded++;
    }
    return Math.max(1, Math.min(ceiling, Math.max(this.cfg.max_concurrent, funded)));
  }

  private startAttempts(): void {
    if (this.stopping) return;
    const slots = this.slots();
    // least recently started first, so one agent cannot hold the only slot (max_concurrent) while others wait
    for (const [agent, st] of fairOrder(Object.entries(this.state.agents), this.lastStarted)) {
      if (this.running.size >= slots) return;
      if (st.status !== "bound" || this.running.has(agent)) continue;
      if (this.cfg.max_candidates_per_agent !== undefined && st.candidates >= this.cfg.max_candidates_per_agent) continue;
      const v = this.vaults.get(agent);
      if (!v?.awake || this.exhausted.has(agent)) continue;
      // the vault first: an agent that can no longer pay is marked exhausted even inside its gap
      const b = this.budget(agent);
      if (b.usd === null) {
        if (b.vault) this.exhausted.add(agent);
        this.waiting.set(agent, b.why);
        continue;
      }
      if ((this.misses.get(agent)?.until ?? 0) > this.now()) continue;
      this.lastStarted.set(agent, this.now());
      const promise = this.attemptFor(agent).finally(() => this.running.delete(agent));
      this.running.set(agent, { agent, promise });
    }
  }

  private async attemptFor(agent: string): Promise<void> {
    const w = this.worker(agent);
    let commit: string | null = null;
    let failed = false;
    try {
      commit = await w.authorOnce();
    } catch (e) {
      failed = true;
      this.log(`${agent.slice(0, 6)} attempt failed: ${(e as Error).message}`);
      // OpenRouter 402: its credits cannot cover requests; routed attempts wait until a top-up shows
      if ((e as { noCredits?: boolean }).noCredits && (e as { provider?: string }).provider === "openrouter") this.deps.providerBalance?.markNoCredits();
    }
    const a = this.attempts.get(agent);
    this.attempts.delete(agent);
    // the next attempt: after the short gap, or after the failure backoff when this one threw
    const gap = (this.cfg.attempt_gap_s ?? 30) * 1000;
    if (failed) {
      const n = (this.misses.get(agent)?.n ?? 0) + 1;
      const wait = Math.max(gap, failureBackoffMs(n));
      this.misses.set(agent, { n, until: this.now() + wait });
      this.log(`${agent.slice(0, 6)} ${n} failed attempt${n === 1 ? "" : "s"} in a row; next attempt in ${Math.round(wait / 1000)} s`);
    } else this.misses.set(agent, { n: 0, until: this.now() + gap });
    if (!a) return; // no proposer run (not awake in Core, open-candidate limit, no lineage)
    a.totals.finished_at = this.now();
    this.save();
    const cost = costOf(this.prices, a.totals.usd, a.totals.sandbox_s);
    this.log(`${agent.slice(0, 6)} attempt done: ${a.totals.usd.toFixed(4)} USD model spend, ${Math.ceil(a.totals.sandbox_s)} sandbox s, cost ${cost} base units${commit ? `, candidate ${commit.slice(0, 12)}` : ", no candidate"}`);
    if (!commit) return;
    this.state.agents[agent]!.candidates++;
    this.usageOf(agent).candidates.push(commit);
    this.save();
    this.pendingProvenance.push({ agent, commit_id: commit, totals: a.totals });
    await this.flushProvenance();
  }

  private provenanceFlush: Promise<void> | null = null;

  /** Signs and posts provenance for authored candidates; retried on the next tick when Core refuses or is down. One flush at a time. */
  private flushProvenance(): Promise<void> {
    this.provenanceFlush ??= this.flushProvenanceOnce().finally(() => (this.provenanceFlush = null));
    return this.provenanceFlush;
  }

  private async flushProvenanceOnce(): Promise<void> {
    const batch = this.pendingProvenance;
    this.pendingProvenance = [];
    const left: typeof this.pendingProvenance = [];
    for (const p of batch) {
      try {
        const key = this.store.keyFor(p.agent);
        const as = new CoreClient(this.cfg.core, { ...key, agent: p.agent });
        const c = await as.get(`/v1/candidates/${p.commit_id}`, true);
        if (c.status !== 200) throw new Error(`candidate ${c.status}`);
        const l = await as.get(`/v1/lineages/${c.body.lineage_id}`);
        if (l.status !== 200) throw new Error(`lineage ${l.status}`);
        const record = provenanceRecord({
          commit_id: p.commit_id,
          agent: p.agent,
          recipe_id: l.body.recipe_id,
          lineage_id: c.body.lineage_id,
          totals: p.totals,
          amount: costOf(this.prices, p.totals.usd, p.totals.sandbox_s),
          price: { line_per_usd: this.cfg.compute_price_line_per_usd, line_per_sandbox_s: this.cfg.compute_price_line_per_sandbox_s },
          requestedModel: this.cfg.model,
        });
        const r = await this.client.post(`/v1/candidates/${p.commit_id}/provenance`, { record, sig: signProvenance(this.deps.runtimeKey, record) });
        if (r.status >= 300 && r.body?.error !== "provenance_exists") throw new Error(`HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
        this.log(`${p.agent.slice(0, 6)} provenance stored for ${p.commit_id.slice(0, 12)} (published once final)`);
      } catch (e) {
        this.log(`provenance for ${p.commit_id.slice(0, 12)} not stored yet: ${(e as Error).message}`);
        left.push(p);
      }
    }
    this.pendingProvenance.push(...left);
  }

  // ------------------------------------------------------------------ agent posts (plan S, posts.ts)

  private postsFile() {
    return join(this.cfg.state_dir, "posts.json");
  }

  private startPoster() {
    if (!this.deps.postClient) return;
    const cfg = { ...POSTS_DEFAULTS, ...(this.cfg.posts ?? {}) };
    try {
      if (existsSync(this.postsFile())) this.postState = { ...emptyPostState(), ...JSON.parse(readFileSync(this.postsFile(), "utf8")) };
    } catch (e) {
      this.log(`posts: state unreadable (${(e as Error).message}); starting fresh`);
    }
    this.poster = new AgentPoster({
      core: this.cfg.core,
      client: this.deps.postClient,
      cfg,
      state: () => this.postState,
      save: () => {
        const tmp = `${this.postsFile()}.tmp`;
        writeFileSync(tmp, JSON.stringify(this.postState), { mode: 0o600 });
        renameSync(tmp, this.postsFile());
      },
      now: this.now,
      log: (m) => this.log(`posts: ${m}`),
      room: (agent) => this.postRoom(agent),
      meter: (agent, u) => this.meterPost(agent, u),
      send: (agent, to, text, ref) => this.worker(agent).send(to, text, { ref }),
      keyOf: (agent) => this.store.keyFor(agent),
    });
    this.log(`posts: ${cfg.enabled ? `on (${cfg.model}, at most ${cfg.max_usd_per_post} USD each, ${cfg.max_per_day} per agent per UTC day, cadence ${cfg.cadence_s} s)` : "off (media folding only)"}`);
  }

  private async postsTick(): Promise<void> {
    if (!this.poster || this.stopping) return;
    const bound = Object.entries(this.state.agents).filter(([, s]) => s.status === "bound").map(([a]) => a);
    await this.poster.tick(bound);
  }

  /**
   * USD a post or analysis may spend for `agent` now: the same budget as an attempt without the
   * sandbox reserve (its vault after what it owes and what its running attempt still holds, the
   * OpenRouter balance for a routed model). With `reserve`, that much is held until the call is
   * metered (or 5 minutes pass), so an attempt starting meanwhile cannot spend it too.
   */
  private postRoom(agent: string, reserve?: number): number {
    const b = this.budget(agent, { sandbox: false, cap: Infinity });
    const r = b.usd ?? 0;
    if (!(Number.isFinite(r) && r > 0)) return 0;
    if (reserve !== undefined && reserve > 0 && r >= reserve) this.holds.set(agent, { usd: reserve, until: this.now() + 300_000, via: this.routeOf(agent)?.via ?? null });
    return r;
  }

  /** A post's model call: into the agent's usage (billed to its vault with the epoch) and the global cap. */
  private meterPost(agent: string, u: SoulUsage): void {
    this.holds.delete(agent);
    const s = this.usageOf(agent);
    s.input_tokens += u.input_tokens;
    s.output_tokens += u.output_tokens;
    s.cache_read_tokens += u.cache_read_tokens;
    s.cache_write_tokens += u.cache_write_tokens;
    s.usd += u.usd;
    for (const m of u.models) if (!s.models.includes(m)) s.models.push(m);
    this.state.spent_usd_total += u.usd;
    const w = this.cfg.global_cap_scope === "all" ? this.spendWindow() : null;
    if (w) w.usd += u.usd;
    this.runSpent += u.usd;
    const run = this.state.runs[this.state.runs.length - 1];
    if (run) run.spent_usd = this.runSpent;
    this.save();
  }

  /**
   * Plan T (owner amendment 2026-10-10): what the trader's analysis rounds use, so an analysis is
   * metered and capped like a post: USD room under the global cap, the agent's epoch cap and its
   * vault; metering into the agent's usage and the global window; board posts as the agent.
   */
  analysisSurface() {
    return {
      room: (agent: string, reserve?: number) => this.postRoom(agent, reserve),
      meter: (agent: string, u: SoulUsage) => this.meterPost(agent, u),
      send: (agent: string, to: string, text: string) => this.worker(agent).send(to, text),
    };
  }

  /** Posts sent and refused so far (public summary). */
  postsStatus() {
    return this.postState.log.slice(-50);
  }

  // ------------------------------------------------------------------ usage epochs

  /** Closes the open usage epoch when it is due and the chain clock allows it, then posts closed epochs in order. */
  /** Plan T: sets each bound agent's trade share line for the epoch about to close (replaced, never added twice). */
  private async accrueTradeShares(): Promise<void> {
    const t = this.deps.trading!;
    for (const [agent, st] of Object.entries(this.state.agents)) {
      const v = this.vaults.get(agent);
      if (st.status !== "bound" || !st.mint || !v) continue;
      const u = this.usageOf(agent);
      const computeOwed = this.owed(agent) - BigInt(u.trade_share ?? "0");
      const s = await t.share({ agent, mint: st.mint, vault: v.balance, computeOwed, wake: this.limits.wakeThreshold }).catch((e) => (this.log(`${agent.slice(0, 6)} trade share: ${(e as Error).message}`), null));
      if (s) {
        u.trade_share = s.amount.toString();
        u.trade_basis = s.basis;
      } else {
        delete u.trade_share;
        delete u.trade_basis;
      }
    }
    this.save();
  }

  private async epochs(force = false): Promise<void> {
    if (this.deps.trading && (force || this.now() - this.state.open.opened_at >= this.cfg.usage_epoch_s * 1000) && !this.state.closed.some((e) => !e.done)) await this.accrueTradeShares();
    const open = this.state.open;
    const used = Object.entries(open.usage).filter(([, u]) => u.usd > 0 || u.sandbox_s > 0 || (u.chain_lamports ?? 0) > 0 || BigInt(u.trade_share ?? "0") > 0n);
    const due = this.now() - open.opened_at >= this.cfg.usage_epoch_s * 1000;
    const drained = this.cfg.close_when_exhausted && used.some(([a]) => this.exhausted.has(a) && !this.running.has(a));
    const pending = this.state.closed.some((e) => !e.done);
    // no quote price (mainnet feed stale or out of band): the epoch stays open, no amount is invented
    const priced = !!this.applyPrice();
    if (used.length && !pending && (due || drained || force) && !priced) this.log(`usage epoch not closed: waiting for a quote price (${this.price.why(this.now())})`);
    if (used.length && !pending && (due || drained || force) && priced) {
      const next = await this.deps.backend.nextEpoch(open.period);
      if (this.now() / 1000 >= next.earliestS) {
        const leaves: ClosedEpoch["leaves"] = [];
        for (const [agent, u] of used) {
          const cost = this.usageCost(u);
          // a vault cannot pay more than it holds; the shortfall stays in the record (cost) and is never invented
          const bal = this.vaults.get(agent)?.balance ?? cost;
          const amount = cost < bal ? cost : bal;
          leaves.push({ agent, amount: amount.toString(), cost: cost.toString(), model_tokens: modelTokens(u), sandbox_s: Math.ceil(u.sandbox_s), usd: u.usd, chain_lamports: u.chain_lamports ?? 0, ...(u.trade_share ? { trade_share: u.trade_share, trade_basis: u.trade_basis } : {}) });
        }
        this.state.closed.push({ epoch: next.epoch, opened_at: open.opened_at, closed_at: this.now(), leaves, root: null, post: null, debits: {}, done: false });
        // subsidized spend (plan MODELS-AND-SELF-FUNDING): what the vaults could not pay, in USD, is what the global cap counts
        if (this.cfg.global_cap_scope !== "all") {
          let short = 0;
          for (const l of leaves) {
            const gap = BigInt(l.cost) - BigInt(l.amount);
            if (gap > 0n && this.prices.perUsd > 0n) short += Number((gap * 1_000_000n) / this.prices.perUsd) / 1e6;
          }
          if (short > 0) {
            this.state.subsidized_usd_total = (this.state.subsidized_usd_total ?? 0) + short;
            const w = this.spendWindow();
            if (w) w.usd += short;
            this.log(`usage epoch ${next.epoch}: ${short.toFixed(4)} USD the vaults could not pay counts as subsidized spend`);
          }
        }
        this.state.open = { period: open.period + 1, opened_at: this.now(), usage: {} };
        this.save();
        this.log(`usage epoch ${next.epoch} closed: ${leaves.map((l) => `${l.agent.slice(0, 6)} ${l.amount} base units (${l.usd.toFixed(4)} USD, ${l.model_tokens} tokens, ${l.sandbox_s} s)`).join("; ")}`);
      } else if (force) this.log(`usage epoch not closed: the onchain clock allows the next post at ${new Date(next.earliestS * 1000).toISOString()}; it stays open in state`);
    }
    for (const e of this.state.closed) {
      if (e.done) continue;
      try {
        await this.deps.backend.post(e, () => this.save());
        this.log(`usage epoch ${e.epoch} posted${e.root ? ` (root ${e.root})` : ""}: ${Object.entries(e.debits).map(([a, s]) => `${a.slice(0, 6)} ${s}`).join(", ")}`);
        for (const l of e.leaves) {
          const h = this.hosted.get(l.agent);
          if (h) this.vaults.set(l.agent, await this.deps.backend.vault(h));
        }
      } catch (err) {
        this.log(`usage epoch ${e.epoch} not fully posted yet: ${(err as Error).message}`);
        break; // keep the order: a later epoch never lands before an earlier one
      }
    }
    // plan T: landed trade shares go from the compute sink to the treasuries (idempotent per leaf)
    if (this.deps.trading) await this.deps.trading.forward(this.state.closed.slice(-20), () => this.save()).catch((e) => this.log(`trade share forward: ${(e as Error).message}`));
  }

  // ------------------------------------------------------------------ loop

  async tick(): Promise<void> {
    try {
      await this.price.refresh();
      await this.deps.providerBalance?.refresh();
      this.state.provider_balance = this.deps.providerBalance ? { openrouter: { ...this.deps.providerBalance.state, configured: this.deps.providerBalance.configured } } : undefined;
      await this.refreshAgents();
      await this.reportSpend();
      if (this.pendingProvenance.length) await this.flushProvenance();
      if (!this.posting) {
        this.posting = this.epochs().finally(() => (this.posting = null));
        await this.posting;
      }
      this.startAttempts();
      this.postsRun ??= this.postsTick().finally(() => (this.postsRun = null));
      await this.postsRun; // attempts already run in the background; posts are short model calls
    } catch (e) {
      this.log(`tick: ${(e as Error).message}`);
    }
    this.ticks++;
  }

  async run(until: () => boolean = () => false): Promise<void> {
    while (!this.stopping && !until()) {
      await this.tick();
      await Bun.sleep(this.cfg.poll_ms);
    }
  }

  /** Closes the open usage epoch now (where the chain clock allows) and posts every closed epoch. */
  async flush(): Promise<void> {
    if (this.posting) await this.posting;
    await this.refreshAgents();
    await this.epochs(true);
  }

  /** Waits until no attempt runs (tests and proofs). */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running.values()].map((r) => r.promise));
  }

  /** Graceful stop: no new attempts, running ones finish, usage is closed and posted where the clock allows, the lock is released. */
  async stop(opts: { flush?: boolean } = {}): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.log(`stopping: waiting for ${this.running.size} running attempt(s)`);
    await this.idle();
    if (this.postsRun) await this.postsRun;
    if (this.posting) await this.posting;
    if (opts.flush !== false) {
      try {
        await this.refreshAgents();
        await this.epochs(true);
      } catch (e) {
        this.log(`stop: usage not flushed (${(e as Error).message}); it is kept in state and posted on the next start`);
      }
    }
    for (const w of this.workers.values()) await w.telemetry.stop();
    const run = this.state.runs[this.state.runs.length - 1];
    if (run) {
      run.stopped_at = this.now();
      run.spent_usd = this.runSpent;
    }
    this.save();
    this.lock.release();
    this.log(`stopped; this run spent ${this.runSpent.toFixed(4)} USD of model usage, ${usd4(this.state.spent_usd_total)} USD in total`);
  }

  // ------------------------------------------------------------------ spend report (plan MODELS-AND-SELF-FUNDING)

  /**
   * Per bound agent: vault, its USD value at the price in force, burn per hour over the last 24 h of
   * closed usage epochs (public anyway; open usage is left out so nothing hints at an attempt in
   * progress), runway = vault / burn, the model and route, and why it waits. Null where not known.
   */
  spendReport(): SpendReport {
    const now = this.now();
    const q = this.applyPrice();
    const ob = this.deps.providerBalance;
    const out: SpendReport = {
      at: now,
      price: { source: q?.source ?? "none", status: q?.status ?? "none", usd_per_token: q?.usd ?? null, line_per_usd: q ? q.perUsd.toString() : null, why: q ? null : this.price.why(now) },
      provider_balance: { openrouter: ob?.configured ? { usd: ob.state.usd, source: ob.state.source, read_at: ob.state.read_at, low: ob.state.usd !== null && ob.state.usd < ob.state.floor_usd } : null },
      agents: {},
    };
    const since = now - 86_400_000;
    for (const [agent, st] of Object.entries(this.state.agents)) {
      if (st.status !== "bound") continue;
      const v = this.vaults.get(agent);
      let burn = 0n;
      let first = Infinity;
      for (const e of this.state.closed) {
        if (e.closed_at < since) continue;
        const l = e.leaves.find((x) => x.agent === agent);
        if (!l) continue;
        burn += BigInt(l.cost);
        first = Math.min(first, Math.max(e.opened_at, since));
      }
      const spanS = Number.isFinite(first) ? Math.max(3600, (now - first) / 1000) : null;
      const perH = spanS && burn > 0n ? (burn * 3600n) / BigInt(Math.ceil(spanS)) : null;
      const r = this.routeOf(agent);
      out.agents[agent] = {
        vault: v ? v.balance.toString() : null,
        vault_usd: v && q ? usdFor(this.prices, v.balance, 0) : null,
        burn_per_h: perH !== null ? perH.toString() : null,
        burn_usd_per_h: perH !== null && q ? usdFor(this.prices, perH, 0) : null,
        burn_window_s: spanS && burn > 0n ? Math.ceil(spanS) : null,
        runway_h: v && perH && perH > 0n ? Number((v.balance * 1000n) / perH) / 1000 : null,
        model: r?.model ?? null,
        via: r?.via ?? null,
        waiting: !v ? "vault not read yet" : !v.awake ? "asleep (vault below the wake threshold)" : this.waiting.get(agent) ?? (r && !r.via ? r.why : null),
      };
    }
    return out;
  }

  private async reportSpend(): Promise<void> {
    const every = (this.cfg.spend_report_s ?? 60) * 1000;
    if (!this.deps.report || every <= 0 || this.now() - this.lastReport < every) return;
    this.lastReport = this.now();
    await this.deps.report(this.spendReport()).catch((e) => this.log(`spend report not sent: ${(e as Error).message}`));
  }

  /** A public summary (no keys, no secrets). */
  status() {
    return {
      mode: this.cfg.mode,
      runtime: this.deps.runtimeKey.id,
      spent_usd_total: this.state.spent_usd_total,
      run_spent_usd: this.runSpent,
      cap: this.capStatus(),
      agents: Object.fromEntries(
        Object.entries(this.state.agents).map(([a, s]) => [a, { status: s.status, runtime_key: s.key_id, candidates: s.candidates, vault: this.vaults.get(a)?.balance.toString() ?? null, awake: this.vaults.get(a)?.awake ?? null, owed: this.prices ? this.owed(a).toString() : null }]),
      ),
      open_epoch: { period: this.state.open.period, usage: this.state.open.usage },
      closed: this.state.closed,
    };
  }
}
