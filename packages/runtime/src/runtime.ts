import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { AgentKey } from "@units/protocol";
import { CoreClient } from "../../core/src/client.ts";
import { Worker } from "../../worker/src/worker.ts";
import { JOURNAL_RESERVE_USD } from "../../worker/src/journal.ts";
import type { Meter, Proposer } from "../../worker/src/proposers/types.ts";
import type { Backend, HostedAgent, Vault } from "./backend.ts";
import { chainCostOf, costOf, PLATFORM_FUNDING_DEFAULTS, resolvePrices, usdFor, windowStart, type Prices, type RuntimeConfig } from "./config.ts";
import type { ChainFee, Messenger } from "../../core/src/msgchain.ts";
import { provenanceRecord, signProvenance, type AttemptTotals } from "./provenance.ts";
import { emptyUsage, isAgentId, Lock, modelTokens, redact, StateStore, type AgentUsage, type ClosedEpoch } from "./state.ts";
import { AgentPoster, emptyPostState, POSTS_DEFAULTS, type PostState } from "./posts.ts";
import { AgentFollower, emptyFollowState, FOLLOWS_DEFAULTS, type FollowState } from "./follows.ts";
import type { ModelClient, Usage as SoulUsage } from "../../souls/src/generator.ts";
import type { DesktopProvider } from "../../desktop/src/pool.ts";
import { desktopGate } from "./desktop-gate.ts";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { sha256Hex } from "../../protocol/src/hash.ts";
import { FixedPrice, type PriceSource, type QuotePrice } from "./price.ts";
import type { OpenRouterBalance } from "./provider-balance.ts";
import { UnitSetup, unitSetupWork, type RepoSetup, type UnitSetupWork } from "./unit-setup.ts";
import { LEAD_PLAN_SYSTEM, leadPlanUser, parseLeadPlan, parseSlotKey, slotKey, SwarmLedger, type LedgerState, type RosterSeat, type SwarmConfig } from "./swarm.ts";
import { ROLE_PARAGRAPHS, swarmSeats } from "../../souls/src/swarm.ts";
import type { SeatHooks } from "../../worker/src/seat.ts";
import { emptySeatUsage, type SeatUsage } from "./state.ts";

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
  /** a proposer per agent (production: the Claude proposer; tests: one with a fake model client); `seat` is set only for a swarm's seat, whose model is its own */
  proposer: (agent: string, seat?: number) => Proposer;
  log?: (m: string) => void;
  now?: () => number;
  /** heartbeats and activity from each agent's worker (SPEC 17.1); default on */
  telemetry?: boolean;
  /**
   * Onchain messages (SPEC 12.5, devnet): a transport per bound agent, signing with the agent's
   * runtime key; the runtime pays the fees and `onFee` bills them to the agent's usage ("chain fee").
   */
  messenger?: (agent: string, key: AgentKey, onFee: (f: ChainFee) => void) => Messenger | undefined;
  /** Agent posts (plan S, posts.ts) and the follow step after a session (follows.ts): the model client they are written with; absent = neither. */
  postClient?: ModelClient;
  /** Agent desktops (SPEC 17.7, packages/desktop): a live desktop per attempt when a slot is free. */
  desktop?: DesktopProvider;
  /**
   * Plan MODELS-AND-SELF-FUNDING. `route`: which model and route an agent runs on now (the routed
   * proposers resolve it from the soul); `providerBalance`: OpenRouter's balance gate; `price`: the
   * quote token's price (default the configured TEST rate); `report`: posts the spend summary to Core.
   */
  route?: (agent: string, seat?: number) => Promise<AgentRoute | null>;
  /** Swarms (docs/plans/SWARMS.md): false never runs seats on this runtime, whatever Core says. Default: follow Core's flag. */
  swarms?: boolean;
  providerBalance?: OpenRouterBalance;
  price?: PriceSource;
  report?: (body: SpendReport) => Promise<void>;
  /** Unit setup (unit-setup.ts): how a repository is read and a recipe drafted; default the real git reading and the model drafter. */
  unitSetup?: UnitSetupWork;
}

export interface AgentRoute {
  via: "direct" | "openrouter" | null;
  model: { provider: string; id: string } | null;
  why: string | null;
  /** the routed model's rate in USD per million tokens, with the route's fee factor (the minimum useful attempt is priced with it) */
  rate?: { input: number; output: number; cache_write: number; fee_factor?: number } | null;
}

/** Defaults of cfg.min_useful_attempt (config.ts). */
export const MIN_USEFUL_DEFAULTS = { model_calls: 2, call_input_tokens: 20_000, call_output_tokens: 4096, recheck_s: 300 };

/** What the runtime publishes per agent (GET /v1/agents/:id/spend): real figures only, null when not known. */
export interface SpendReport {
  at: number;
  price: { source: string; status: string; usd_per_token: number | null; line_per_usd: string | null; why: string | null };
  provider_balance: { openrouter: { usd: number | null; source: string | null; read_at: number | null; low: boolean } | null };
  /** the platform cap and its counter (capStatus), for the Analytics page */
  cap?: ReturnType<Runtime["capStatus"]> & { scope: string };
  /** desktop slots by backend, counts only (no host names) */
  desktops?: { required: boolean | null; masked?: boolean | null; local: { running: number; max: number } | null; hosts: { count: number; up: number; running: number; max: number } | null; e2b: { running: number; max: number; spent_today_usd: number; cap_usd: number } | null } | null;
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
    /** network compute (plan section D): set while the agent's vault cannot pay and the network pays for its attempts, one every min_interval_s */
    covered?: { min_interval_s: number };
    /** false: known to the runtime but not bound to it (reported only with a unit setup reason; its figures are null) */
    bound?: false;
    /** since when the agent has been waiting for a desktop (ms); null when it is not */
    waiting_since?: number | null;
    /** per-agent desktops (desktop_mode per_agent): the agent's own desktop, in words a page can show; absent in per-attempt mode */
    desktop?: { state: "starting" | "running" | "paused" | "none"; why: string | null; since: number; stream?: string | null } | null;
    /** a swarm's seats (docs/plans/SWARMS.md): state in words, the unit and target of the attempt in progress, model, screen, and spend over closed usage epochs; absent for a solo agent */
    seats?: SeatReport[];
  }>;
}

export interface SeatReport {
  seat: number;
  state: "working" | "waiting" | "paused" | "asleep";
  why: string | null;
  since: number | null;
  unit: string | null;
  target: string | null;
  model: { provider: string; id: string } | null;
  via: "direct" | "openrouter" | null;
  desktop: { state: "starting" | "running" | "paused" | "none"; why: string | null; since: number; stream: string | null; charged: boolean } | null;
  spend: { usd: number; sandbox_s: number; desktop_s: number; desktop_usd: number; attempts: number; epochs: number };
}

interface Attempt {
  agent: string;
  /** a swarm's seat; absent for a solo agent */
  seat?: number;
  maxUsd: number;
  totals: AttemptTotals;
  /** the route the attempt was started on (OpenRouter attempts hold part of its balance) */
  via?: "direct" | "openrouter" | null;
  /** network compute (plan section D): sized by the global cap and the OpenRouter balance, not by the vault */
  network?: boolean;
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
  private pendingProvenance: { agent: string; commit_id: string; totals: AttemptTotals; seat?: number }[] = [];
  /**
   * Swarms (swarm.ts). `swarmCfg`: Core's settings, null while Core says swarms are off (then every
   * agent is solo and nothing below is used). `rosters`: the seats of each bound agent whose soul
   * declares two or more. The maps keyed "by agent" above (workers, running, attempts, lastStarted,
   * misses, routes, waiting, desktopWaitSince) are keyed by slot key: the agent id for seat 1 and for
   * every solo agent, `<agent>.s<k>` for seat k. The vault-level ones (vaults, hosted, exhausted,
   * paused, holds) stay per agent.
   */
  private swarmCfg: SwarmConfig | null = null;
  private swarmCfgAt = -Infinity;
  private rosters = new Map<string, RosterSeat[]>();
  private rosterAt = new Map<string, number>();
  private ledgers = new Map<string, SwarmLedger>();
  private planning = new Set<string>();
  /** what the lead's last plan was made from (the ledger's summary), by agent */
  private planned = new Map<string, string>();
  /** slot keys whose cached worker was made as a swarm's seat */
  private seated = new Set<string>();
  private poster: AgentPoster | null = null;
  private follower: AgentFollower | null = null;
  private followState: FollowState = emptyFollowState();
  private postState: PostState = emptyPostState();
  private postsRun: Promise<void> | null = null;
  /** plan MODELS-AND-SELF-FUNDING */
  private price!: PriceSource;
  private routes = new Map<string, { at: number; r: AgentRoute }>();
  /** USD held for an analysis or post that asked for room and has not metered yet */
  private holds = new Map<string, { usd: number; until: number; via: AgentRoute["via"] }>();
  private waiting = new Map<string, string>();
  /** since when an agent's attempts have not started for want of a desktop (the page says why, the site monitor alerts after 5 minutes) */
  private desktopWaitSince = new Map<string, number>();
  /** agents whose budget is under the minimum useful attempt: no attempt, desktop or session until `until`, or until the vault holds more than `balance` */
  private paused = new Map<string, { until: number; balance: bigint; why: string }>();
  private lastReport = 0;
  /** network compute (plan section D): the slot keys whose running attempt was started on the network's money, and the agents Core has been told are covered */
  private networkRun = new Set<string>();
  private coveredTold = new Set<string>();
  /** when each agent's last attempt began (its budget was granted), this process: the covered interval counts from it */
  private begun = new Map<string, number>();
  /** the hosted agents of the last successful discovery (an agent that left it no longer exists for the desktops) */
  private discovered: Set<string> | null = null;
  /** sha256 digests of the launches Core purged (GET /v1/purged; kept in <state_dir>/purged.json so a start without Core still knows them) */
  private purged: { agents: Set<string>; mints: Set<string> } | null = null;
  /** agents whose repository has no unit yet: the reading, the draft and the public reason (unit-setup.ts) */
  private setup!: UnitSetup;

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
    this.setup = new UnitSetup(cfg.unit_setup, {
      core: this.client,
      log: (m) => this.log(m),
      now: () => this.now(),
      save: () => this.save(),
      store: () => ((this.state as { unit_setup?: Record<string, RepoSetup> }).unit_setup ??= {}),
      agents: () => Object.entries(this.state.agents).map(([agent, st]) => ({ agent, status: st.status, target_repo: st.target_repo })),
      keyOf: (agent) => this.store.keyFor(agent),
      awake: (agent) => this.vaults.get(agent)?.awake === true,
      busy: (agent) => this.busy(agent),
      freeSlot: () => !this.stopping && this.running.size < this.slots(),
      budget: (agent, cap) => this.budget(agent, { cap }),
      run: (agent, maxUsd, job) => this.runSetup(agent, maxUsd, job),
    }, deps.unitSetup ?? unitSetupWork({ core: cfg.core, state_dir: cfg.state_dir, model: cfg.unit_setup?.model, max_trials: cfg.unit_setup?.max_trials }));
  }

  /** A recipe draft as an attempt of `agent` (unit-setup.ts): it holds a slot and its model and sandbox use are metered to the agent's vault. */
  private runSetup(agent: string, maxUsd: number, job: (meter: Pick<Meter, "model" | "sandbox">) => Promise<void>): void {
    const a: Attempt = { agent, maxUsd, via: "openrouter", totals: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, usd: 0, sandbox_s: 0, models: [], started_at: this.now(), finished_at: 0 } };
    this.attempts.set(agent, a);
    this.usageOf(agent).attempts++;
    this.lastStarted.set(agent, this.now());
    this.save();
    const promise = job(this.meterFor(a))
      .catch((e) => this.log(`${agent.slice(0, 6)} unit draft failed: ${(e as Error).message}`))
      .finally(() => {
        this.attempts.delete(agent);
        a.totals.finished_at = this.now();
        this.save();
        this.log(`${agent.slice(0, 6)} unit draft done: ${a.totals.usd.toFixed(4)} USD model spend, ${Math.ceil(a.totals.sandbox_s)} sandbox s, cost ${costOf(this.prices, a.totals.usd, a.totals.sandbox_s)} base units`);
        this.running.delete(agent);
      });
    this.running.set(agent, { agent, promise });
  }

  get state() {
    return this.store.state;
  }

  private save() {
    this.store.save();
  }

  // ------------------------------------------------------------------ seats (swarm.ts)

  /** The seats of a swarm, or null: a solo agent, or swarms are off. */
  seatsOf(agent: string): RosterSeat[] | null {
    return this.rosters.get(agent) ?? null;
  }

  /** The slot keys of an agent: its id alone, or one key per seat. */
  private keysOf(agent: string): string[] {
    const r = this.rosters.get(agent);
    return r ? r.map((x) => slotKey(agent, x.seat)) : [agent];
  }

  /** True while any attempt of the agent runs (any seat). */
  private busy(agent: string): boolean {
    if (this.running.has(agent)) return true;
    const r = this.rosters.get(agent);
    return !!r && r.some((x) => this.running.has(slotKey(agent, x.seat)));
  }

  private runningSeats(agent: string): number {
    return this.keysOf(agent).filter((k) => this.running.has(k)).length;
  }

  private ledgerOf(agent: string): SwarmLedger {
    let l = this.ledgers.get(agent);
    if (!l) {
      const all = (this.state.swarms ??= {}) as Record<string, LedgerState>;
      const st = (all[agent] ??= { units: {}, holds: {} });
      this.ledgers.set(agent, (l = new SwarmLedger(st, { now: () => this.now(), save: () => this.save(), log: (m) => this.log(`${agent.slice(0, 6)} ${m}`) })));
    }
    return l;
  }

  /**
   * How many of a swarm's seats its vault carries now (docs/plans/SWARMS.md 4, the reserve rule): the
   * full attempt reservations (cap plus sandbox reserve) that fit in what the vault does not owe. At
   * least one: the last seat runs on a part cap exactly as a solo agent does. Seats past that number,
   * in seat order, are paused, so a low vault shrinks the swarm from its highest seat down.
   */
  seatsFunded(agent: string): number {
    const r = this.rosters.get(agent);
    if (!r) return 1;
    const v = this.vaults.get(agent);
    if (!v || !this.prices) return r.length;
    const one = costOf(this.prices, this.cfg.attempt_max_usd, this.cfg.sandbox_reserve_s);
    if (one <= 0n) return r.length;
    const free = v.balance - this.owed(agent);
    const n = free > 0n ? Number(free / one) : 0;
    return Math.max(1, Math.min(r.length, n));
  }

  /** Core's swarm settings and each bound agent's roster, read about once a minute. Core's flag off: no rosters, every agent solo. */
  private async refreshSwarms(): Promise<void> {
    if (this.deps.swarms === false) return;
    const now = this.now();
    if (now - this.swarmCfgAt >= 60_000 || this.swarmCfgAt === -Infinity) {
      const r = await this.client.get("/v1/swarms/config").catch(() => null);
      if (r?.status === 200 && r.body?.settings) {
        if (!this.swarmCfg) this.log(`swarms: on (largest swarm ${r.body.settings.max_members}; a screen past seat ${r.body.settings.seat_desktop_free_seats} costs the vault ${r.body.settings.seat_desktop_usd_per_h === null ? "the desktop service's rate" : `${r.body.settings.seat_desktop_usd_per_h} USD an hour`})`);
        this.swarmCfg = r.body.settings as SwarmConfig;
        this.swarmCfgAt = now;
      } else if (r?.status === 404) {
        if (this.swarmCfg) this.log("swarms: Core switched them off; every agent is solo from the next attempt");
        this.swarmCfg = null;
        this.swarmCfgAt = now;
        this.rosters.clear();
        this.rosterAt.clear();
      }
      // any other answer (Core down): what was known stays
    }
  }

  /** A bound agent's seats from its soul (about once a minute), read before its attempts are looked at. */
  private async refreshRoster(agent: string): Promise<void> {
    if (!this.swarmCfg) return;
    const now = this.now();
    if (now - (this.rosterAt.get(agent) ?? -Infinity) < 60_000) return;
    const r = await this.client.get(`/v1/agents/${agent}/soul`).catch(() => null);
    if (!r || (r.status !== 200 && r.status !== 404)) return; // Core did not answer: asked again on the next tick
    this.rosterAt.set(agent, now);
    const seats = r.status === 200 ? swarmSeats(r.body?.doc) : null;
    // a roster never changes after launch (Core refuses it); seats past the network's size limit do not run
    const roster = seats && seats.length >= 2 ? seats.slice(0, this.swarmCfg.max_members).map((m) => ({ seat: m.seat, name: m.name, role: m.role, model: m.model })) : null;
    if (roster && roster.length >= 2) {
      if (!this.rosters.has(agent)) this.log(`${agent.slice(0, 6)} is a swarm of ${roster.length}: ${roster.map((m) => `${m.name} (${m.role}, ${m.model.id})`).join(", ")}`);
      this.rosters.set(agent, roster);
    } else this.rosters.delete(agent);
  }

  async start(): Promise<void> {
    this.limits = await this.deps.backend.init();
    this.prices = resolvePrices(this.cfg, this.limits.decimals);
    this.price = this.deps.price ?? new FixedPrice(this.cfg.compute_price_line_per_usd, this.limits.decimals);
    await this.price.refresh();
    this.applyPrice();
    this.startPoster();
    this.startFollower();
    this.state.runs.push({ started_at: this.now(), stopped_at: null, spent_usd: 0, pid: process.pid });
    this.save();
    const unposted = this.state.closed.filter((e) => !e.done).length;
    const cap = this.capStatus();
    const capText = cap.window_s
      ? `global cap ${cap.max_usd} USD per ${cap.window_s} s window (${cap.window_s === 86400 ? "UTC day" : "aligned to the Unix epoch"}), this window ${new Date(cap.window_start!).toISOString()} to ${new Date(cap.window_end!).toISOString()} spent ${usd4(cap.spent_usd)}; lifetime ${usd4(this.state.spent_usd_total)} USD`
      : `spent so far ${usd4(this.state.spent_usd_total)} of ${this.cfg.global_max_usd} USD (lifetime cap)`;
    const q = this.price.current(this.now());
    this.log(
      `started (${this.cfg.mode}, runtime ${this.deps.runtimeKey.id}, pid ${process.pid}); prices ${q?.status === "live" ? `${q.perUsd} base units per USD (live, ${q.source})` : q ? `${this.cfg.compute_price_line_per_usd} $UNITS per USD (TEST value)` : `no quote price yet (${this.price.why(this.now())})`} and ${this.cfg.compute_price_line_per_sandbox_s} per sandbox second; vault-funded spend has no global cap, the ${this.cfg.global_cap_scope === "all" ? "global cap counts every USD" : "global cap counts subsidized spend only"}: ${capText}${unposted ? `; recovering ${unposted} unposted usage epoch(s)` : ""}`,
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
    // desktop_usd: the screens of a swarm's seats past the free ones (absent, so 0, for a solo agent)
    return costOf(this.prices, u.usd + (u.desktop_usd ?? 0), u.sandbox_s) + chainCostOf(this.prices, u.chain_lamports ?? 0);
  }

  /**
   * What of a usage record its vault is charged: everything but the part attempts on the network's
   * money used (plan section D; with platform_funding.charge_vault the whole record, as before).
   */
  private vaultCost(u: AgentUsage): bigint {
    if (this.cfg.platform_funding?.charge_vault || !(u.network_usd || u.network_sandbox_s)) return this.usageCost(u);
    return costOf(this.prices, Math.max(0, u.usd - (u.network_usd ?? 0)) + (u.desktop_usd ?? 0), Math.max(0, u.sandbox_s - (u.network_sandbox_s ?? 0))) + chainCostOf(this.prices, u.chain_lamports ?? 0);
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
    let owed = u ? this.vaultCost(u) : 0n;
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
      /** what the vaults could not pay so far, in USD (leaf shortfalls of closed usage epochs) */
      subsidized_lifetime_usd: this.state.subsidized_usd_total ?? 0,
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
    // a swarm's seats draw on the one vault: every running seat's reservation counts
    for (const k of this.keysOf(agent)) {
      const a = this.attempts.get(k);
      if (a) line += costOf(this.prices, Math.max(0, a.maxUsd - a.totals.usd), Math.max(0, this.cfg.sandbox_reserve_s - a.totals.sandbox_s));
    }
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

  /** The cached route of an agent, or of a swarm's seat by its slot key (refreshed in refreshAgents); null when unknown. */
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
  budget(agent: string, o: { sandbox?: boolean; cap?: number; seat?: number } = {}): { usd: number } | { usd: null; why: string; vault: boolean; short?: boolean } {
    const key = slotKey(agent, o.seat ?? 1);
    const v = this.vaults.get(agent);
    if (!v) return { usd: null, why: "vault unknown", vault: false };
    if (!v.awake) return { usd: null, why: "asleep", vault: true };
    if (!this.applyPrice()) return { usd: null, why: `waiting for a quote price (${this.price?.why(this.now()) ?? "none"})`, vault: false };
    const avail = v.balance - this.owed(agent) - this.reservedLine(agent);
    let line = avail;
    if (this.limits.maxDebitPerEpoch !== null) {
      let epochOwed = 0n;
      for (const u of Object.values(this.state.open.usage)) epochOwed += this.vaultCost(u);
      for (const a of new Set([...this.attempts.values()].map((x) => x.agent))) epochOwed += this.reservedLine(a);
      const left = this.limits.maxDebitPerEpoch - epochOwed;
      if (left < line) line = left;
    }
    const fromVault = usdFor(this.prices, line, o.sandbox === false ? 0 : this.cfg.sandbox_reserve_s);
    const used = this.usageOf(agent).usd;
    const epochCap = this.cfg.agent_epoch_max_usd;
    let epochLeft = epochCap === null || epochCap === undefined ? Infinity : typeof used === "number" && Number.isFinite(used) && used >= 0 ? epochCap - used : 0;
    if (typeof used !== "number" || !Number.isFinite(used)) return { usd: null, why: "spend record is not a finite number; refusing to start an attempt", vault: false };
    // a swarm's optional caps per usage epoch (Core's swarm settings): the whole swarm's model spend, and this seat's
    const sw = o.seat !== undefined && this.rosters.has(agent) ? this.swarmCfg : null;
    if (sw && sw.swarm_epoch_max_usd !== null) epochLeft = Math.min(epochLeft, sw.swarm_epoch_max_usd - used);
    if (sw && sw.seat_epoch_max_usd !== null) epochLeft = Math.min(epochLeft, sw.seat_epoch_max_usd - (this.usageOf(agent).seats?.[String(o.seat)]?.usd ?? 0));
    const g = this.cfg.global_cap_scope === "all" ? this.globalLeft() : Infinity;
    const route = this.routeOf(key);
    const pr = route?.via === "openrouter" ? this.providerRoom() : null;
    const prov = pr === null ? Infinity : pr;
    const usd = Math.min(o.cap ?? this.cfg.attempt_max_usd, fromVault, epochLeft, g, prov);
    if (Number.isNaN(usd)) return { usd: null, why: "spend record is not a finite number; refusing to start an attempt", vault: false };
    // an authoring attempt must also cover a minimum useful attempt at the agent's model's rate
    const useful = o.sandbox === false ? 0 : this.minUsefulUsd(key);
    const floor = o.sandbox === false ? Math.min(this.cfg.min_attempt_usd, o.cap ?? Infinity) : Math.max(this.cfg.min_attempt_usd, useful);
    if (!(usd >= floor)) {
      const need = useful > this.cfg.min_attempt_usd ? `; a useful attempt needs ${floor.toFixed(4)} USD, ${Math.max(0, usd).toFixed(4)} available` : "";
      const base =
        prov === usd ? `provider balance low (OpenRouter has ${(this.deps.providerBalance?.room() ?? 0).toFixed(2)} USD, ${Math.max(0, prov).toFixed(4)} free of running reserves)`
        : g === usd ? `global runtime cap (${this.cfg.global_max_usd} USD${this.cfg.global_window_s ? ` per ${this.cfg.global_window_s} s window` : ""}) reached`
        : epochLeft === usd ? (sw ? "epoch cap reached" : "per-agent epoch cap reached")
        : `compute vault exhausted (${avail} base units unowed)`;
      return { usd: null, why: `${base}${need}`, vault: fromVault === usd, short: true };
    }
    return { usd };
  }

  // ------------------------------------------------------------------ network compute (plan MODELS-AND-SELF-FUNDING section D)

  /**
   * True while the network pays for `agent`'s attempts: the setting is on, the agent is bound, its
   * repository has a unit, and only its vault stands between it and an attempt (asleep, or budget()
   * refused it for the vault). Read again on every tick: it ends as soon as the vault can pay.
   */
  covered(agent: string): boolean {
    if (!this.cfg.platform_funding?.enabled) return false;
    if (this.state.agents[agent]?.status !== "bound" || this.setup.settingUp(agent)) return false;
    const v = this.vaults.get(agent);
    if (!v) return false;
    return !v.awake || this.exhausted.has(agent);
  }

  /** Room under the global cap for an attempt the network pays for (USD). */
  private networkCapLeft(): number {
    // scope "all": every metered USD is in the window and every running attempt's unspent reserve is held already
    if (this.cfg.global_cap_scope === "all") return this.globalLeft();
    // scope "subsidized": the window gets a shortfall only when its usage epoch closes, so the unspent
    // reserves of running covered attempts and the shortfall the open usage already implies are held here
    let held = 0;
    for (const a of this.attempts.values()) if (a.network) held += Math.max(0, a.maxUsd - a.totals.usd);
    if (this.prices.perUsd > 0n)
      for (const [agent, u] of Object.entries(this.state.open.usage)) {
        // what the vault is not charged (the network's part), and what it is charged past what it holds
        const over = this.owed(agent) - (this.vaults.get(agent)?.balance ?? 0n);
        const gap = this.usageCost(u) - this.vaultCost(u) + (over > 0n ? over : 0n);
        if (gap > 0n) held += Number((gap * 1_000_000n) / this.prices.perUsd) / 1e6;
      }
    return this.globalLeft() - held;
  }

  /**
   * The most an attempt of a covered agent may spend (USD), or null with the reason: the lowest of the
   * attempt cap (platform_funding.attempt_max_usd, else attempt_max_usd), the room under the global
   * cap, and what OpenRouter's known balance covers after running reserves. The vault is not part of
   * it. Only for a model that runs through OpenRouter here: the network pays from that balance alone.
   */
  private networkBudget(agent: string, seat = 1): { usd: number } | { usd: null; why: string; vault: false; short?: false } {
    const key = slotKey(agent, seat);
    if (!this.applyPrice()) return { usd: null, why: `waiting for a quote price (${this.price?.why(this.now()) ?? "none"})`, vault: false };
    const used = this.usageOf(agent).usd;
    if (typeof used !== "number" || !Number.isFinite(used)) return { usd: null, why: "spend record is not a finite number; refusing to start an attempt", vault: false };
    if (this.routeOf(key)?.via !== "openrouter") return { usd: null, why: "network compute runs through OpenRouter, and this agent's model has no OpenRouter route here", vault: false };
    const pr = this.providerRoom();
    const prov = pr === null ? Infinity : pr;
    const g = this.networkCapLeft();
    const usd = Math.min(this.cfg.platform_funding?.attempt_max_usd ?? this.cfg.attempt_max_usd, g, prov);
    const floor = Math.max(this.cfg.min_attempt_usd, this.minUsefulUsd(key));
    if (!(usd >= floor)) {
      const why = prov === usd && prov !== g
        ? `provider balance low (OpenRouter has ${(this.deps.providerBalance?.room() ?? 0).toFixed(2)} USD, ${Math.max(0, prov).toFixed(4)} free of running reserves)`
        : `global runtime cap (${this.cfg.global_max_usd} USD${this.cfg.global_window_s ? ` per ${this.cfg.global_window_s} s window` : ""}) reached`;
      return { usd: null, why, vault: false };
    }
    return { usd };
  }

  /**
   * Starts a covered agent's next attempt when its interval has passed and the cap and the balance
   * allow one. A swarm runs its first seat only while covered. True when one started.
   */
  private startCovered(agent: string, st: { candidates: number }): boolean {
    if (this.cfg.max_candidates_per_agent !== undefined && st.candidates >= this.cfg.max_candidates_per_agent) return false;
    if (this.busy(agent)) return false;
    const seat = this.rosters.get(agent)?.[0]?.seat ?? 1;
    const k = slotKey(agent, seat);
    const b = this.networkBudget(agent, seat);
    if (b.usd === null) {
      if (this.waiting.get(k) !== b.why) this.log(`${agent.slice(0, 6)} attempt on network compute not started: ${b.why}`);
      this.waiting.set(k, b.why);
      return false;
    }
    // the vault's own reason no longer holds it; a desktop wait is the desktop gate's to clear
    if (!this.waiting.get(k)?.startsWith("waiting for a desktop")) this.waiting.delete(k);
    const now = this.now();
    // from the last attempt that began (its budget was granted); one that could not begin (no desktop free,
    // nothing to author on) is tried again after the short gap below and uses up no interval
    const last = Math.max(this.state.network_started?.[agent] ?? -Infinity, this.begun.get(agent) ?? -Infinity);
    const every = (this.cfg.platform_funding?.min_interval_s ?? PLATFORM_FUNDING_DEFAULTS.min_interval_s) * 1000;
    if (now - last < every) return false;
    if ((this.misses.get(k)?.until ?? 0) > now) return false;
    // Core refuses an asleep agent's candidate unless the runtime's report says it is covered: told first
    if (this.deps.report && (this.cfg.spend_report_s ?? 60) > 0 && !this.coveredTold.has(agent)) {
      this.lastReport = 0;
      return false;
    }
    this.lastStarted.set(k, now);
    this.networkRun.add(k);
    const promise = this.attemptFor(agent, seat).finally(() => {
      this.running.delete(k);
      this.networkRun.delete(k);
    });
    this.running.set(k, { agent, promise });
    return true;
  }

  /**
   * What a minimum useful authoring attempt costs for `agent` (USD; cfg.min_useful_attempt): the
   * journal reserve the worker keeps out of the authoring loop plus `model_calls` calls at its
   * model's rate. 0 when turned off or while the model's rate is not known (then min_attempt_usd
   * alone decides, as before).
   */
  minUsefulUsd(agent: string): number {
    const m = this.cfg.min_useful_attempt;
    if (m === null) return 0;
    const rate = this.routeOf(agent)?.rate;
    if (!rate || !(rate.output > 0)) return 0;
    const calls = m?.model_calls ?? MIN_USEFUL_DEFAULTS.model_calls;
    const inTok = m?.call_input_tokens ?? MIN_USEFUL_DEFAULTS.call_input_tokens;
    const outTok = m?.call_output_tokens ?? MIN_USEFUL_DEFAULTS.call_output_tokens;
    const call = ((inTok * Math.max(rate.cache_write, rate.input) + outTok * rate.output) / 1e6) * (rate.fee_factor ?? 1);
    const usd = (this.cfg.efficiency?.journal_reserve_usd ?? JOURNAL_RESERVE_USD) + calls * call;
    return Number.isFinite(usd) && usd > 0 ? usd : 0;
  }

  /** The pause in force for `agent`, or null: it ends after recheck_s, or as soon as the vault holds more than when it began. */
  private pausedNow(agent: string): string | null {
    const p = this.paused.get(agent);
    if (!p) return null;
    const v = this.vaults.get(agent);
    if (this.now() >= p.until || (v && v.balance > p.balance)) {
      this.paused.delete(agent);
      return null;
    }
    return p.why;
  }

  /** Pauses `agent` (its budget is under a minimum useful attempt): logged once per pause, the reason is what the spend report shows. */
  private pause(agent: string, why: string): void {
    const s = this.cfg.min_useful_attempt?.recheck_s ?? MIN_USEFUL_DEFAULTS.recheck_s;
    this.waiting.set(agent, why);
    if (!(s > 0)) return;
    this.paused.set(agent, { until: this.now() + s * 1000, balance: this.vaults.get(agent)?.balance ?? 0n, why });
    this.log(`${agent.slice(0, 6)} paused: ${why}; no attempt, desktop or session; next check in ${s} s or on a vault deposit`);
  }

  private meterFor(a: Attempt): Meter {
    // a swarm's attempt is also counted under its seat (the agent's record stays the sum the vault is debited)
    const seatUsage = (): SeatUsage | null => (a.seat === undefined ? null : ((this.usageOf(a.agent).seats ??= {})[String(a.seat)] ??= emptySeatUsage()));
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
        if (a.network) s.network_usd = (s.network_usd ?? 0) + u.usd;
        if (!s.models.includes(u.model)) s.models.push(u.model);
        const su = seatUsage();
        if (su) su.usd += u.usd;
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
        if (a.network) this.usageOf(a.agent).network_sandbox_s = (this.usageOf(a.agent).network_sandbox_s ?? 0) + sec;
        const su = seatUsage();
        if (su) su.sandbox_s += sec;
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

  /** The worker of an agent, or of one seat of a swarm (each seat is its own worker of the agent's one key). */
  private worker(agent: string, seat = 1): Worker {
    const k = slotKey(agent, seat);
    // a swarm's seat: its own model, its unit and target from the swarm's ledger; undefined for a solo agent
    const rs = this.rosters.get(agent)?.find((x) => x.seat === seat);
    let w = this.workers.get(k);
    // a worker made before the agent's roster was known (or after it went) is made again as what the agent is now
    if (w && this.seated.has(k) !== !!rs) {
      void w.telemetry.stop();
      this.workers.delete(k);
      w = undefined;
    }
    if (w) return w;
    if (rs) this.seated.add(k);
    else this.seated.delete(k);
    const key = this.store.keyFor(agent);
    const tag = rs ? `${agent.slice(0, 6)} s${seat}` : agent.slice(0, 6);
    w = new Worker({
      core: this.cfg.core,
      key: { ...key, agent } as AgentKey,
      proposer: rs ? this.deps.proposer(agent, seat) : this.deps.proposer(agent),
      lineages: this.cfg.lineages,
      telemetry: this.deps.telemetry !== false,
      stateDir: join(this.cfg.state_dir, "worker", k),
      log: (m) => this.log(`${tag} ${m}`),
      collab: "advisory",
      // stacked authoring on the agent's own pending candidate (docs/plans/AGENT-EFFICIENCY.md); a swarm's stack is its ledger's
      series: !rs && this.cfg.efficiency?.series === true,
      // agents on one unit pointed at different targets, with an advisory intent each (agent productivity lane)
      spread: this.cfg.efficiency?.spread === true,
      spreadIntentTtlS: this.cfg.efficiency?.spread_intent_ttl_s,
      // agent journal (SPEC 17.6): own notes in, one entry out per session, inside the attempt cap
      journal: true,
      // the journal call's share of the attempt cap (default 0.08 USD; site-config sets what the call was measured to need)
      journalReserveUsd: this.cfg.efficiency?.journal_reserve_usd,
      messenger: this.deps.messenger?.(agent, key, (f) => this.meterChain(f)),
      desktop: this.deps.desktop,
      ...(rs ? { seat: this.seatHooks(agent, rs) } : {}),
      attempt: () => this.beginAttempt(agent, seat),
    });
    this.workers.set(k, w);
    if (this.deps.telemetry !== false) void w.telemetry.start();
    return w;
  }

  /** What a worker asks before it runs the model: the attempt's cap and meter, or null with the reason noted. */
  private beginAttempt(agent: string, seat: number): Pick<import("../../worker/src/proposers/types.ts").ProposeContext, "maxUsd" | "meter"> | null {
    const k = slotKey(agent, seat);
    const swarm = this.rosters.has(agent);
    const tag = swarm ? `${agent.slice(0, 6)} s${seat}` : agent.slice(0, 6);
    // an attempt started on network compute is sized by the cap and the OpenRouter balance, not by the vault
    const net = this.networkRun.has(k);
    const b = net ? this.networkBudget(agent, seat) : this.budget(agent, swarm ? { seat } : {});
    if (b.usd === null) {
      if (swarm && this.runningSeats(agent) > 1) {
        // other seats hold the vault's room: this seat waits, the swarm is not marked as out of funds
        this.waiting.set(k, "Paused: vault low");
        return null;
      }
      if (b.short) this.pause(agent, b.why);
      else {
        this.log(`${tag} attempt not started: ${b.why}`);
        this.waiting.set(k, b.why);
      }
      if (b.vault) this.exhausted.add(agent);
      return null;
    }
    // desktop hosts lane: no attempt without its live desktop when desktops are required
    const dw = desktopGate(this.deps.desktop, k);
    if (dw) {
      if (this.waiting.get(k) !== dw) this.log(`${tag} attempt not started: ${dw}`);
      this.waiting.set(k, dw);
      if (!this.desktopWaitSince.has(k)) this.desktopWaitSince.set(k, this.now());
      return null;
    }
    this.waiting.delete(k);
    this.desktopWaitSince.delete(k);
    const a: Attempt = { agent, ...(swarm ? { seat } : {}), ...(net ? { network: true } : {}), maxUsd: b.usd, via: this.routeOf(k)?.via ?? null, totals: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, usd: 0, sandbox_s: 0, models: [], started_at: this.now(), finished_at: 0 } };
    this.attempts.set(k, a);
    this.usageOf(agent).attempts++;
    if (swarm) ((this.usageOf(agent).seats ??= {})[String(seat)] ??= emptySeatUsage()).attempts++;
    this.begun.set(agent, this.now());
    if (net) (this.state.network_started ??= {})[agent] = this.now();
    this.save();
    this.log(`${tag} attempt starts${net ? " on network compute" : ""}, cap ${b.usd.toFixed(4)} USD`);
    return { maxUsd: b.usd, meter: this.meterFor(a) };
  }

  /** A seat's side of the swarm's ledger (packages/worker/src/seat.ts). */
  private seatHooks(agent: string, rs: RosterSeat): SeatHooks {
    const ledger = this.ledgerOf(agent);
    const k = slotKey(agent, rs.seat);
    return {
      seat: rs.seat,
      name: rs.name,
      role: rs.role,
      rolePrompt: `${ROLE_PARAGRAPHS[rs.role]} Your name in the group is ${rs.name}.`,
      desktopKey: k,
      place: (units, maxOpen) => {
        const r = ledger.place(rs.seat, units, maxOpen);
        if (r.ok) this.waiting.delete(k);
        else this.waiting.set(k, r.why);
        return r;
      },
      retarget: (unit, kind, target) => ledger.retarget(rs.seat, unit, kind, target),
      commit: (unit, f) => ledger.commit(rs.seat, unit, f),
      ended: (commitId) => ledger.ended(rs.seat, commitId),
    };
  }

  /**
   * Per-agent desktops (desktop_mode per_agent): tells the desktop provider which agents are bound now,
   * which are in an attempt and which sleep. Called only after the agents were read without an error,
   * so a failed read removes no desktop. Returns at once: an agent's desktop is created in the
   * background from its binding on, and the bind and the launch never wait on it.
   */
  private syncDesktops(): void {
    const d = this.deps.desktop;
    if (!d?.syncAgents) return;
    const list = [];
    for (const [agent, st] of Object.entries(this.state.agents)) {
      // bound to this runtime and still a hosted agent the backend knows
      if (st.status !== "bound" || !(this.discovered ?? this.hosted).has(agent)) continue;
      const awake = this.vaults.get(agent)?.awake !== false;
      const roster = this.rosters.get(agent);
      // network compute: a covered agent's desktop is not rested for a low vault (a swarm's first seat; its other seats rest)
      const cov = this.covered(agent);
      if (roster) {
        // a swarm: one desktop per seat; seats the vault does not carry now rest with their reason
        const funded = this.seatsFunded(agent);
        const broke = awake && !this.busy(agent) && (this.exhausted.has(agent) || !!this.pausedNow(agent));
        roster.forEach((m, i) => {
          const k = slotKey(agent, m.seat);
          const working = this.running.has(k);
          if (cov) return void list.push({ agent: k, working, asleep: i > 0, ...(i > 0 ? { asleep_why: "Paused: vault low" } : {}) });
          const low = awake && !working && (broke || i >= funded);
          list.push({ agent: k, working, asleep: !awake || low, ...(low ? { asleep_why: "Paused: vault low" } : {}) });
        });
        continue;
      }
      const working = this.running.has(agent);
      // an awake agent whose vault cannot pay for an attempt does not work either: its desktop rests until a deposit
      const broke = awake && !working && (this.exhausted.has(agent) || !!this.pausedNow(agent));
      if (cov) list.push({ agent, working, asleep: false });
      else list.push({ agent, working, asleep: !awake || broke, ...(broke ? { asleep_why: "agent cannot pay for an attempt (vault low)" } : {}) });
    }
    try {
      d.syncAgents(list);
    } catch (e) {
      this.log(`desktops: sync: ${(e as Error).message}`);
    }
  }

  /**
   * The screens of a swarm's seats past the free ones are charged to its vault for the time they ran
   * (docs/plans/SWARMS.md 4; Core's swarm settings): at the setting's hourly rate, or at the desktop
   * service's own charge when the setting is null. The charge is part of the one amount the vault is
   * debited per usage epoch. A solo agent's desktop, and a swarm's free seats, are never charged.
   */
  private meterSeatDesktops(): void {
    const d = this.deps.desktop;
    const cfg = this.swarmCfg;
    if (!d?.takeRun || !cfg || !this.rosters.size) return;
    let dirty = false;
    for (const [agent, roster] of this.rosters) {
      roster.forEach((m, i) => {
        if (i < cfg.seat_desktop_free_seats) return;
        const run = d.takeRun!(slotKey(agent, m.seat));
        if (!(run.seconds > 0)) return;
        const usd = cfg.seat_desktop_usd_per_h === null ? run.usd : (run.seconds / 3600) * cfg.seat_desktop_usd_per_h;
        const u = this.usageOf(agent);
        u.desktop_s = (u.desktop_s ?? 0) + run.seconds;
        u.desktop_usd = (u.desktop_usd ?? 0) + usd;
        const su = ((u.seats ??= {})[String(m.seat)] ??= emptySeatUsage());
        su.desktop_s += run.seconds;
        su.desktop_usd += usd;
        dirty = true;
      });
    }
    if (dirty) this.save();
  }

  /**
   * The lead's planning call (docs/plans/SWARMS.md 3): one small model call in the lead's model that
   * assigns each seat a unit and a free target with a two-line brief, from the units and targets the
   * seats last reported and the ledger. Inside a cost cap (Core's lead_plan_max_usd, else the journal
   * reserve), paid by the vault and counted under the lead's seat. When it cannot run or its answer
   * is not usable, seats are placed from counts alone, restricted by the ledger.
   */
  private async leadPlan(agent: string, roster: RosterSeat[]): Promise<void> {
    const cfg = this.swarmCfg;
    const client = this.deps.postClient;
    const ledger = this.ledgerOf(agent);
    if (!cfg?.lead_plan || !client || this.planning.has(agent) || ledger.known.size === 0) return;
    const lead = roster.find((m) => m.role === "lead") ?? roster[0]!;
    const k = slotKey(agent, lead.seat);
    const rate = this.routeOf(k)?.rate;
    if (!rate || !(rate.output > 0)) return;
    const cap = cfg.lead_plan_max_usd ?? this.cfg.efficiency?.journal_reserve_usd ?? JOURNAL_RESERVE_USD;
    const summary = ledger.summary();
    // nothing changed since the last plan (the swarm is waiting for verdicts, say): the plan stands, no call
    if (this.planned.get(agent) === summary) return;
    const user = leadPlanUser(roster, summary);
    const fee = rate.fee_factor ?? 1;
    const inputUsd = (((LEAD_PLAN_SYSTEM.length + user.length) / 2) * Math.max(rate.input, rate.cache_write) * fee) / 1e6;
    const maxTokens = Math.min(1500, Math.floor(((cap - inputUsd) * 1e6) / (rate.output * fee)));
    if (maxTokens < 200) return;
    if (this.postRoom(agent, cap) < cap) return;
    this.planning.add(agent);
    try {
      const res = await client.create({ model: lead.model.id, max_tokens: maxTokens, system: LEAD_PLAN_SYSTEM, messages: [{ role: "user", content: user }] });
      const u = res.usage ?? {};
      const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0);
      const tokens = { input_tokens: n(u.input_tokens), output_tokens: n(u.output_tokens), cache_read_tokens: n(u.cache_read_input_tokens), cache_write_tokens: n(u.cache_creation_input_tokens) };
      const usd = typeof u.usd === "number" && Number.isFinite(u.usd) && u.usd >= 0 ? u.usd : ((tokens.input_tokens * rate.input + tokens.output_tokens * rate.output + tokens.cache_write_tokens * rate.cache_write) * fee) / 1e6;
      this.meterPost(agent, { ...tokens, usd, models: [res.model ?? lead.model.id] } as SoulUsage);
      ((this.usageOf(agent).seats ??= {})[String(lead.seat)] ??= emptySeatUsage()).usd += usd;
      this.save();
      const text = res.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
      const plan = parseLeadPlan(text, roster, ledger.known, this.now());
      ledger.setPlan(plan);
      this.planned.set(agent, summary);
      this.log(`${agent.slice(0, 6)} s${lead.seat} lead plan: ${plan ? Object.entries(plan.seats).map(([seat, a]) => `seat ${seat} -> ${a.unit.slice(0, 10)} ${a.kind} ${a.target}`).join(", ") : "no usable assignment; seats placed from counts"}; ${usd.toFixed(4)} USD metered`);
    } finally {
      this.holds.delete(agent);
      this.planning.delete(agent);
    }
  }

  /** A swarm's seats for the spend report: what each is doing in words, its model, its screen, and its share of the closed usage epochs. */
  private seatReports(agent: string, roster: RosterSeat[]): SeatReport[] {
    const v = this.vaults.get(agent);
    const ledger = this.ledgerOf(agent);
    const cfg = this.swarmCfg;
    return roster.map((m, i) => {
      const k = slotKey(agent, m.seat);
      const at = ledger.activeOf(m.seat);
      const w = this.waiting.get(k) ?? null;
      const working = this.running.has(k) && !!at;
      // network compute: a covered swarm's first seat works; it is neither asleep nor paused
      const cov = i === 0 && this.covered(agent);
      const state: SeatReport["state"] = cov ? (working ? "working" : "waiting") : !v?.awake ? "asleep" : working ? "working" : w === "Paused: vault low" || (!this.busy(agent) && this.exhausted.has(agent)) ? "paused" : "waiting";
      const r = this.routeOf(k);
      const desk = this.deps.desktop?.agentDesktop?.(k) ?? null;
      const spend = { usd: 0, sandbox_s: 0, desktop_s: 0, desktop_usd: 0, attempts: 0, epochs: 0 };
      for (const e of this.state.closed) {
        const su = e.leaves.find((x) => x.agent === agent)?.seats?.[String(m.seat)];
        if (!su) continue;
        spend.usd += su.usd;
        spend.sandbox_s += su.sandbox_s;
        spend.desktop_s += su.desktop_s;
        spend.desktop_usd += su.desktop_usd;
        spend.attempts += su.attempts;
        spend.epochs++;
      }
      return {
        seat: m.seat,
        state,
        why: state === "asleep" ? "asleep (vault below the wake threshold)" : state === "paused" ? "Paused: vault low" : state === "waiting" ? w : null,
        since: working ? at!.since : null,
        // the unit and target of the attempt in progress: what the seat's intent already says, nothing about a submitted candidate
        unit: working ? at!.unit : null,
        target: working ? at!.target : null,
        model: r?.model ?? m.model,
        via: r?.via ?? null,
        desktop: desk ? { state: desk.state, why: desk.why ? desk.why.slice(0, 300) : null, since: desk.since, stream: desk.stream ?? null, charged: !!cfg && i >= cfg.seat_desktop_free_seats && cfg.seat_desktop_usd_per_h !== 0 } : null,
        spend,
      };
    });
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
    if (!isAgentId(agent) || this.isPurged(agent)) return null;
    if (!this.state.agents[agent]) {
      const h = await this.deps.backend.hostedAgent?.(agent);
      if (!h || h.agent !== agent || this.isPurged(agent, h.mint)) return null;
      this.hosted.set(agent, h);
      if (!this.state.agents[agent]) await this.adopt(h);
    }
    const st = this.state.agents[agent]!;
    return { agent, new_key: st.key_id, status: st.status };
  }

  /** The runtime key of an agent this runtime adopted (never makes one). */
  keyOf(agent: string): AgentKey | null {
    agent = parseSlotKey(agent).agent; // a seat's desktop key names its agent (swarm.ts)
    return this.state.agents[agent] ? this.store.keyFor(agent) : null;
  }

  /** True for a launch Core purged: never adopted, bound or worked for again. */
  private isPurged(agent: string, mint?: string | null): boolean {
    const p = this.purged;
    if (!p || (!p.agents.size && !p.mints.size)) return false;
    return p.agents.has(sha256Hex(agent)) || (!!mint && p.mints.has(sha256Hex(mint)));
  }

  /**
   * Core's list of purged launches (digests), and what this runtime still holds of them: the state
   * entry, open usage, bind request, worker directory and every in-memory trace go; the agent's key
   * file is moved to <state_dir>/purged-keys/<digest>.json (it is the agent's wallet on chain, so it is
   * not destroyed here: nothing loads it from there). Its desktop leaves with the state entry: the
   * next desktop sync no longer lists the agent, and the pool removes its sandbox. The launch still
   * exists on chain, so discovery and the bind endpoint check the list before they adopt.
   */
  private async dropPurged(): Promise<void> {
    const file = join(this.cfg.state_dir, "purged.json");
    if (!this.purged) {
      let saved: { agents?: string[]; mints?: string[] } = {};
      try {
        if (existsSync(file)) saved = JSON.parse(readFileSync(file, "utf8"));
      } catch {}
      this.purged = { agents: new Set(saved.agents ?? []), mints: new Set(saved.mints ?? []) };
    }
    const r = await this.client.get("/v1/purged").catch(() => null);
    const rows = r && r.status === 200 && Array.isArray(r.body?.purged) ? (r.body.purged as { agent_sha256?: unknown; mint_sha256?: unknown }[]) : null;
    if (rows) {
      // the list only grows: a digest once seen stays, whatever a later answer holds
      const before = this.purged.agents.size + this.purged.mints.size;
      for (const x of rows) {
        if (typeof x.agent_sha256 === "string" && /^[0-9a-f]{64}$/.test(x.agent_sha256)) this.purged.agents.add(x.agent_sha256);
        if (typeof x.mint_sha256 === "string" && /^[0-9a-f]{64}$/.test(x.mint_sha256)) this.purged.mints.add(x.mint_sha256);
      }
      if (this.purged.agents.size + this.purged.mints.size !== before) {
        const tmp = `${file}.tmp-${process.pid}`;
        writeFileSync(tmp, JSON.stringify({ agents: [...this.purged.agents], mints: [...this.purged.mints] }), { mode: 0o600 });
        renameSync(tmp, file);
      }
    }
    let dropped = 0;
    for (const [agent, st] of Object.entries(this.state.agents)) {
      if (!this.isPurged(agent, st.mint)) continue;
      delete this.state.agents[agent];
      delete this.state.open.usage[agent];
      const seatKeys = this.keysOf(agent);
      for (const m of [this.workers, this.attempts, this.vaults, this.hosted, this.lastStarted, this.misses, this.routes, this.holds, this.waiting, this.desktopWaitSince, this.paused] as Map<string, unknown>[]) for (const k of new Set([agent, ...seatKeys])) m.delete(k);
      this.rosters.delete(agent);
      this.rosterAt.delete(agent);
      this.ledgers.delete(agent);
      if (this.state.swarms) delete this.state.swarms[agent];
      this.exhausted.delete(agent);
      this.discovered?.delete(agent);
      try {
        const key = this.store.keyFile(agent);
        if (existsSync(key)) {
          const dir = join(this.cfg.state_dir, "purged-keys");
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          renameSync(key, join(dir, `${sha256Hex(agent)}.json`));
        }
        rmSync(join(this.cfg.state_dir, "bind-requests", `${agent}.json`), { force: true });
        // a running attempt still writes there; what is left goes on a later pass
        if (!this.running.has(agent) && !seatKeys.some((k) => this.running.has(k))) for (const k of new Set([agent, ...seatKeys])) rmSync(join(this.cfg.state_dir, "worker", k), { recursive: true, force: true });
      } catch (e) {
        this.log(`a purged agent's files: ${(e as Error).message}`);
      }
      dropped++;
    }
    // usage a running attempt of a purged agent metered after its entry went, and its worker directory once the attempt ended
    for (const agent of Object.keys(this.state.open.usage)) if (!this.state.agents[agent] && this.isPurged(agent)) delete this.state.open.usage[agent];
    if (dropped) {
      this.save();
      this.log(`dropped ${dropped} agent(s) Core purged: state, open usage and files removed, keys moved to purged-keys/, desktops leave with the next sync`);
    }
  }

  /** Discovery, binding and vault reads. */
  private async refreshAgents(): Promise<void> {
    const b = this.deps.backend;
    if (this.ticks % (b.mode === "devnet" ? 6 : 1) === 0 || this.hosted.size === 0 || !this.purged) {
      await this.dropPurged();
      const seen = new Set<string>();
      for (const h of await b.discover()) {
        if (this.isPurged(h.agent, h.mint)) continue; // still on chain, removed from the network (Core purge)
        seen.add(h.agent);
        // ids become file names below: a malformed one from Core or the chain is skipped (audit A2, OFF-R1)
        if (!isAgentId(h.agent)) {
          this.log(`skipping a discovered agent with a malformed id ${JSON.stringify(String(h.agent).slice(0, 60))}`);
          continue;
        }
        this.hosted.set(h.agent, h);
        const known = this.state.agents[h.agent];
        if (known) {
          // relaunched under the same agent key on a new deployment (devnet v2): its new token from now on
          if (h.mint && known.mint !== h.mint) {
            this.log(`agent ${h.agent} relaunched: mint ${known.mint ?? "none"} -> ${h.mint}`);
            known.mint = h.mint;
            this.save();
          }
          continue;
        }
        await this.adopt(h);
      }
      this.discovered = seen;
    }
    await this.refreshSwarms();
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
      await this.refreshRoster(agent);
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
      // a swarm's seats 2 and up each run their own model
      for (const m of this.rosters.get(agent) ?? []) {
        const k = slotKey(agent, m.seat);
        if (m.seat <= 1 || !this.deps.route || this.now() - (this.routes.get(k)?.at ?? -Infinity) < 60_000) continue;
        const r = await this.deps.route(agent, m.seat).catch(() => null);
        if (r) this.routes.set(k, { at: this.now(), r });
      }
      // exhausted until the vault can pay for an attempt again (new fees, or a debit lowered what it owes)
      if (this.exhausted.has(agent) && this.budget(agent, this.rosters.has(agent) ? { seat: 1 } : {}).usd !== null) this.exhausted.delete(agent);
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
      // network compute: a covered agent takes one slot while it runs or may start
      if (this.covered(agent)) {
        if (this.busy(agent) || this.networkBudget(agent, this.rosters.get(agent)?.[0]?.seat ?? 1).usd !== null) funded++;
        continue;
      }
      if (st.status !== "bound" || this.exhausted.has(agent) || !this.vaults.get(agent)?.awake) continue;
      const roster = this.rosters.get(agent);
      if (roster) {
        // a swarm: a slot per seat that runs, and per seat its vault still carries
        const run = this.runningSeats(agent);
        funded += !this.pausedNow(agent) && this.budget(agent, { seat: 1 }).usd !== null ? Math.max(run, this.seatsFunded(agent)) : run;
        continue;
      }
      if (this.running.has(agent) || (!this.pausedNow(agent) && this.budget(agent).usd !== null)) funded++;
    }
    return Math.max(1, Math.min(ceiling, Math.max(this.cfg.max_concurrent, funded)));
  }

  private startAttempts(): void {
    if (this.stopping) return;
    const slots = this.slots();
    // when each agent last started an attempt: its own time, or for a swarm the latest of its seats
    const last = new Map<string, number>();
    for (const agent of Object.keys(this.state.agents)) {
      let t: number | undefined;
      for (const k of this.keysOf(agent)) {
        const x = this.lastStarted.get(k);
        if (x !== undefined && (t === undefined || x > t)) t = x;
      }
      if (t !== undefined) last.set(agent, t);
    }
    // least recently started first, so one agent cannot hold the only slot (max_concurrent) while others wait
    const order = fairOrder(Object.entries(this.state.agents), last);
    for (const [agent, st] of order) {
      if (this.running.size >= slots) return;
      if (st.status !== "bound") continue;
      // network compute: an agent whose vault cannot pay, one attempt per interval
      if (this.covered(agent)) {
        this.startCovered(agent, st);
        continue;
      }
      const roster = this.rosters.get(agent);
      if (!roster) {
        if (this.running.has(agent)) continue;
        if (!this.agentMayStart(agent, st)) continue;
        this.startSeat(agent, 1, false);
        continue;
      }
      // a swarm takes one slot in this pass, like any coin (slot fairness "coin"); with "seat" all of its seats that can
      if (!this.agentMayStart(agent, st)) continue;
      const perCoin = this.swarmCfg?.slot_fairness !== "seat";
      if (perCoin && this.busy(agent)) continue;
      for (const m of roster) {
        if (this.running.size >= slots) return;
        if (this.startSeat(agent, m.seat, true) && perCoin) break;
      }
    }
    // then the swarms' further seats, lowest seat first, while slots are left: a swarm's second seat
    // starts only after every funded coin had its turn above (docs/plans/SWARMS.md 5)
    if (!this.rosters.size) return;
    for (const [agent, st] of order) {
      const roster = this.rosters.get(agent);
      if (!roster || st.status !== "bound" || !this.agentMayStart(agent, st)) continue;
      for (const m of roster) {
        if (this.running.size >= slots) return;
        this.startSeat(agent, m.seat, true);
      }
    }
  }

  /** The checks of an agent as a whole, before any of its attempts starts. */
  private agentMayStart(agent: string, st: { candidates: number }): boolean {
    // no unit for its repository yet: unit setup (unit-setup.ts) works for it, an attempt has nothing to author on
    if (this.setup.settingUp(agent)) return false;
    if (this.cfg.max_candidates_per_agent !== undefined && st.candidates >= this.cfg.max_candidates_per_agent) return false;
    const v = this.vaults.get(agent);
    if (!v?.awake) return false;
    // paused under the minimum useful attempt: not looked at again until its recheck or a deposit
    if (this.pausedNow(agent)) return false;
    if (this.exhausted.has(agent)) return false;
    return true;
  }

  /** Starts an attempt of `agent` (of its seat, for a swarm) when its budget and its gap allow. True when one started. */
  private startSeat(agent: string, seat: number, swarm: boolean): boolean {
    const k = slotKey(agent, seat);
    if (this.running.has(k)) return false;
    if (swarm) {
      // the reserve rule: the vault carries this many seats now; the ones past it wait, highest seat first
      const roster = this.rosters.get(agent)!;
      if (roster.findIndex((m) => m.seat === seat) >= this.seatsFunded(agent)) {
        if (this.waiting.get(k) !== "Paused: vault low") this.log(`${agent.slice(0, 6)} s${seat} paused: the vault carries ${this.seatsFunded(agent)} of ${roster.length} seats now`);
        this.waiting.set(k, "Paused: vault low");
        return false;
      }
      if (this.waiting.get(k) === "Paused: vault low") this.waiting.delete(k);
    }
    // the vault first: an agent that can no longer pay is marked exhausted even inside its gap
    const b = this.budget(agent, swarm ? { seat } : {});
    if (b.usd === null) {
      if (swarm && this.busy(agent)) {
        this.waiting.set(k, "Paused: vault low");
        return false;
      }
      if (b.vault) this.exhausted.add(agent);
      if (b.short) this.pause(agent, b.why);
      else this.waiting.set(k, b.why);
      return false;
    }
    if ((this.misses.get(k)?.until ?? 0) > this.now()) return false;
    this.lastStarted.set(k, this.now());
    const promise = this.attemptFor(agent, seat).finally(() => this.running.delete(k));
    this.running.set(k, { agent, promise });
    return true;
  }

  private async attemptFor(agent: string, seat = 1): Promise<void> {
    const k = slotKey(agent, seat);
    const roster = this.rosters.get(agent);
    const tag = roster ? `${agent.slice(0, 6)} s${seat}` : agent.slice(0, 6);
    // the lead plans the round before it works (docs/plans/SWARMS.md 3); a failed plan changes nothing
    if (roster?.find((m) => m.seat === seat)?.role === "lead") await this.leadPlan(agent, roster).catch((e) => this.log(`${tag} lead plan skipped: ${(e as Error).message}`));
    const w = this.worker(agent, seat);
    let commit: string | null = null;
    let failed = false;
    try {
      commit = await w.authorOnce();
    } catch (e) {
      failed = true;
      this.log(`${tag} attempt failed: ${(e as Error).message}`);
      // OpenRouter 402: its credits cannot cover requests; routed attempts wait until a top-up shows
      if ((e as { noCredits?: boolean }).noCredits && (e as { provider?: string }).provider === "openrouter") this.deps.providerBalance?.markNoCredits();
    }
    const a = this.attempts.get(k);
    this.attempts.delete(k);
    // the next attempt: after the short gap, or after the failure backoff when this one threw
    const gap = (this.cfg.attempt_gap_s ?? 30) * 1000;
    if (failed) {
      const n = (this.misses.get(k)?.n ?? 0) + 1;
      const wait = Math.max(gap, failureBackoffMs(n));
      this.misses.set(k, { n, until: this.now() + wait });
      this.log(`${tag} ${n} failed attempt${n === 1 ? "" : "s"} in a row; next attempt in ${Math.round(wait / 1000)} s`);
    } else this.misses.set(k, { n: 0, until: this.now() + gap });
    if (!a) return; // no proposer run (not awake in Core, open-candidate limit, no lineage)
    a.totals.finished_at = this.now();
    this.save();
    const cost = costOf(this.prices, a.totals.usd, a.totals.sandbox_s);
    this.log(`${tag} attempt done: ${a.totals.usd.toFixed(4)} USD model spend, ${Math.ceil(a.totals.sandbox_s)} sandbox s, cost ${cost} base units${commit ? `, candidate ${commit.slice(0, 12)}` : ", no candidate"}`);
    // the follow step (follows.ts): after the session, inside what the attempt left under its cap; never holds up the loop
    if (this.follower && !this.stopping && a.totals.usd > 0)
      await this.follower.afterSession(agent, this.cfg.attempt_max_usd - a.totals.usd).catch((e) => this.log(`${agent.slice(0, 6)} follow step skipped: ${(e as Error).message}`));
    if (!commit) return;
    this.state.agents[agent]!.candidates++;
    this.usageOf(agent).candidates.push(commit);
    this.save();
    this.pendingProvenance.push({ agent, commit_id: commit, totals: a.totals, ...(roster ? { seat } : {}) });
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
          ...(p.seat !== undefined ? { seat: p.seat } : {}),
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

  // ------------------------------------------------------------------ agent follows after a session (follows.ts)

  private followsFile() {
    return join(this.cfg.state_dir, "follows.json");
  }

  private startFollower() {
    if (!this.deps.postClient) return;
    const cfg = { ...FOLLOWS_DEFAULTS, ...(this.cfg.follows ?? {}) };
    try {
      if (existsSync(this.followsFile())) this.followState = { ...emptyFollowState(), ...JSON.parse(readFileSync(this.followsFile(), "utf8")) };
    } catch (e) {
      this.log(`follows: state unreadable (${(e as Error).message}); starting fresh`);
    }
    this.follower = new AgentFollower({
      core: this.cfg.core,
      client: this.deps.postClient,
      cfg,
      state: () => this.followState,
      save: () => {
        const tmp = `${this.followsFile()}.tmp`;
        writeFileSync(tmp, JSON.stringify(this.followState), { mode: 0o600 });
        renameSync(tmp, this.followsFile());
      },
      now: this.now,
      log: (m) => this.log(`follows: ${m}`),
      room: (agent) => this.postRoom(agent),
      meter: (agent, u) => this.meterPost(agent, u),
      keyOf: (agent) => this.store.keyFor(agent),
    });
    this.log(`follows: ${cfg.enabled ? `on (after a session: ${cfg.model}, at most ${cfg.max_usd} USD, one step per agent per ${cfg.min_gap_s} s; public work data only)` : "off"}`);
  }

  /** Follow decisions sent, refused and dropped so far (newest last). */
  followsStatus() {
    return this.followState.log.slice(-50);
  }

  private async postsTick(): Promise<void> {
    if (!this.poster || this.stopping) return;
    const bound = Object.entries(this.state.agents).filter(([, s]) => s.status === "bound").map(([a]) => a);
    await this.poster.tick(bound);
  }

  /**
   * USD a post or a follow step may spend for `agent` now: the same budget as an attempt without the
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

  /** Posts sent and refused so far (public summary). */
  postsStatus() {
    return this.postState.log.slice(-50);
  }

  // ------------------------------------------------------------------ usage epochs

  /** Closes the open usage epoch when it is due and the chain clock allows it, then posts closed epochs in order. */
  private async epochs(force = false): Promise<void> {
    const open = this.state.open;
    const used = Object.entries(open.usage).filter(([, u]) => u.usd > 0 || u.sandbox_s > 0 || (u.chain_lamports ?? 0) > 0 || (u.desktop_usd ?? 0) > 0);
    const due = this.now() - open.opened_at >= this.cfg.usage_epoch_s * 1000;
    const drained = this.cfg.close_when_exhausted && used.some(([a]) => this.exhausted.has(a) && !this.busy(a) && !this.covered(a));
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
          // the vault is charged its own part (not what the network paid for, plan section D)
          const due = this.vaultCost(u);
          // a vault cannot pay more than it holds; the shortfall stays in the record (cost) and is never invented
          const bal = this.vaults.get(agent)?.balance ?? due;
          const amount = due < bal ? due : bal;
          leaves.push({ agent, amount: amount.toString(), cost: cost.toString(), model_tokens: modelTokens(u), sandbox_s: Math.ceil(u.sandbox_s), usd: u.usd, chain_lamports: u.chain_lamports ?? 0, ...(u.seats ? { desktop_usd: u.desktop_usd ?? 0, desktop_s: u.desktop_s ?? 0, seats: u.seats } : {}) });
        }
        this.state.closed.push({ epoch: next.epoch, opened_at: open.opened_at, closed_at: this.now(), leaves, root: null, post: null, debits: {}, done: false });
        // subsidized spend (plan MODELS-AND-SELF-FUNDING): what the vaults could not pay, in USD. Scope
        // "subsidized": it is what the global cap counts; scope "all": the window already holds every USD
        {
          let short = 0;
          for (const l of leaves) {
            const gap = BigInt(l.cost) - BigInt(l.amount);
            if (gap > 0n && this.prices.perUsd > 0n) short += Number((gap * 1_000_000n) / this.prices.perUsd) / 1e6;
          }
          if (short > 0) {
            this.state.subsidized_usd_total = (this.state.subsidized_usd_total ?? 0) + short;
            const w = this.cfg.global_cap_scope !== "all" ? this.spendWindow() : null;
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
  }

  // ------------------------------------------------------------------ loop

  async tick(): Promise<void> {
    try {
      await this.price.refresh();
      await this.deps.providerBalance?.refresh();
      this.state.provider_balance = this.deps.providerBalance ? { openrouter: { ...this.deps.providerBalance.state, configured: this.deps.providerBalance.configured } } : undefined;
      await this.refreshAgents();
      await this.setup.tick();
      this.syncDesktops();
      this.meterSeatDesktops();
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
      cap: { ...this.capStatus(), scope: this.cfg.global_cap_scope === "all" ? "all" : "subsidized" },
      desktops: this.desktopCounts(),
      agents: {},
    };
    const since = now - 86_400_000;
    const unbound: SpendReport["agents"] = {};
    for (const [agent, st] of Object.entries(this.state.agents)) {
      // unit setup (unit-setup.ts): why an agent whose repository has no unit is not working yet
      const su = this.setup.reason(agent);
      if (st.status !== "bound") {
        // not bound, so nothing of its vault is read or spent here; its page still says why it does not work
        const why = su?.why ?? (st.status === "awaiting_owner" ? "waiting for its owner's wallet to sign the binding to the hosted runtime" : "its owner moved the signing key away from the hosted runtime");
        if (this.hosted.has(agent)) unbound[agent] = { vault: null, vault_usd: null, burn_per_h: null, burn_usd_per_h: null, burn_window_s: null, runway_h: null, model: null, via: null, waiting: why, bound: false };
        continue;
      }
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
      // network compute: a covered agent is not reported as asleep or out of funds; only what holds its covered attempts (the cap, the balance, a desktop)
      const cov = this.covered(agent);
      out.agents[agent] = {
        vault: v ? v.balance.toString() : null,
        vault_usd: v && q ? usdFor(this.prices, v.balance, 0) : null,
        burn_per_h: perH !== null ? perH.toString() : null,
        burn_usd_per_h: perH !== null && q ? usdFor(this.prices, perH, 0) : null,
        burn_window_s: spanS && burn > 0n ? Math.ceil(spanS) : null,
        runway_h: v && perH && perH > 0n ? Number((v.balance * 1000n) / perH) / 1000 : null,
        model: r?.model ?? null,
        via: r?.via ?? null,
        waiting: su?.final ? su.why : !v ? "vault not read yet" : cov ? (this.waiting.get(agent) ?? null) : !v.awake ? "asleep (vault below the wake threshold)" : su?.why ?? this.waiting.get(agent) ?? (r && !r.via ? r.why : null),
        ...(cov ? { covered: { min_interval_s: this.cfg.platform_funding?.min_interval_s ?? PLATFORM_FUNDING_DEFAULTS.min_interval_s } } : {}),
      };
      // a funded agent whose attempts do not start for want of a desktop: since when (desktop-gate.ts writes the reason)
      const w = out.agents[agent]!.waiting;
      if (w?.startsWith("waiting for a desktop")) out.agents[agent]!.waiting_since = this.desktopWaitSince.get(agent) ?? null;
      else this.desktopWaitSince.delete(agent);
      const desk = this.deps.desktop?.agentDesktop?.(agent);
      if (desk) out.agents[agent]!.desktop = { state: desk.state, why: desk.why ? desk.why.slice(0, 300) : null, since: desk.since, stream: desk.stream ?? null };
      const roster = this.rosters.get(agent);
      if (roster) out.agents[agent]!.seats = this.seatReports(agent, roster);
    }
    // bound agents first: Core takes at most 500 rows in one report
    for (const [agent, row] of Object.entries(unbound)) if (Object.keys(out.agents).length < 500) out.agents[agent] = row;
    return out;
  }

  /** The desktop pool's slots by backend for the spend report (Analytics page): counts only. */
  private desktopCounts(): SpendReport["desktops"] {
    const st = (this.deps.desktop as { status?: () => any } | undefined)?.status?.();
    if (!st) return null;
    const hosts = Array.isArray(st.hosts) ? (st.hosts as { running: number; max: number; up: boolean }[]) : [];
    return {
      required: typeof st.required === "boolean" ? st.required : null,
      masked: typeof st.masked === "boolean" ? st.masked : null,
      local: st.local ? { running: st.local.running, max: st.local.max } : null,
      hosts: hosts.length ? { count: hosts.length, up: hosts.filter((h) => h.up).length, running: hosts.reduce((n, h) => n + h.running, 0), max: hosts.reduce((n, h) => n + h.max, 0) } : null,
      e2b: st.e2b ? { running: st.e2b.running, max: st.e2b.max, spent_today_usd: st.e2b.spent_today_usd, cap_usd: st.e2b.cap_usd } : null,
    };
  }

  private async reportSpend(): Promise<void> {
    const every = (this.cfg.spend_report_s ?? 60) * 1000;
    if (!this.deps.report || every <= 0 || this.now() - this.lastReport < every) return;
    this.lastReport = this.now();
    const body = this.spendReport();
    await this.deps.report(body).then(
      // network compute: Core now knows which agents are covered (startCovered waits for this)
      () => void (this.coveredTold = new Set(Object.entries(body.agents).filter(([, a]) => a.covered).map(([id]) => id))),
      (e) => this.log(`spend report not sent: ${(e as Error).message}`),
    );
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
