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
import { existsSync, readFileSync, renameSync } from "node:fs";

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
  /** Agent posts (plan S, posts.ts): the model client posts are written with; absent = no posts. */
  postClient?: ModelClient;
  /**
   * Agents as traders (plan T, packages/trader glue.ts): when a usage epoch is due, `share` gives the
   * trade share of each bound agent's new fee income, which rides its usage leaf as the line "trade
   * share"; after epochs post, `forward` moves each landed share from the compute sink to the treasury.
   */
  trading?: {
    share(o: { agent: string; mint: string; vault: bigint; computeOwed: bigint; wake: bigint }): Promise<{ amount: bigint; basis: unknown } | null>;
    forward(epochs: ClosedEpoch[], save: () => void): Promise<void>;
  };
}

interface Attempt {
  agent: string;
  maxUsd: number;
  totals: AttemptTotals;
}

interface Running {
  agent: string;
  promise: Promise<void>;
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
    this.startPoster();
    this.state.runs.push({ started_at: this.now(), stopped_at: null, spent_usd: 0, pid: process.pid });
    this.save();
    const unposted = this.state.closed.filter((e) => !e.done).length;
    const cap = this.capStatus();
    const capText = cap.window_s
      ? `global cap ${cap.max_usd} USD per ${cap.window_s} s window (${cap.window_s === 86400 ? "UTC day" : "aligned to the Unix epoch"}), this window ${new Date(cap.window_start!).toISOString()} to ${new Date(cap.window_end!).toISOString()} spent ${usd4(cap.spent_usd)}; lifetime ${usd4(this.state.spent_usd_total)} USD`
      : `spent so far ${usd4(this.state.spent_usd_total)} of ${this.cfg.global_max_usd} USD (lifetime cap)`;
    this.log(
      `started (${this.cfg.mode}, runtime ${this.deps.runtimeKey.id}, pid ${process.pid}); prices ${this.cfg.compute_price_line_per_usd} $LINE per USD and ${this.cfg.compute_price_line_per_sandbox_s} per sandbox second (TEST values); ${capText}${unposted ? `; recovering ${unposted} unposted usage epoch(s)` : ""}`,
    );
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
    for (const a of this.attempts.values()) reserved += Math.max(0, a.maxUsd - a.totals.usd);
    // a non-finite or negative total (NaN usage saved as null) must not reset the cap (audit A2, OFF-R3)
    const total = this.state.spent_usd_total;
    if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return 0;
    const w = this.spendWindow();
    const spent = w ? w.usd : total;
    if (typeof spent !== "number" || !Number.isFinite(spent) || spent < 0) return 0;
    return this.cfg.global_max_usd - spent - reserved;
  }

  /**
   * The most an attempt for `agent` may spend now (USD), or null with the reason. Lowest of: the
   * per-attempt cap, what the compute vault still pays at the published price after what it already
   * owes and a sandbox reserve, the per-agent epoch cap, the onchain max_debit_per_epoch left this
   * epoch, and the global runtime cap.
   */
  budget(agent: string): { usd: number } | { usd: null; why: string; vault: boolean } {
    const v = this.vaults.get(agent);
    if (!v) return { usd: null, why: "vault unknown", vault: false };
    if (!v.awake) return { usd: null, why: "asleep", vault: true };
    const avail = v.balance - this.owed(agent);
    let line = avail;
    if (this.limits.maxDebitPerEpoch !== null) {
      let epochOwed = 0n;
      for (const u of Object.values(this.state.open.usage)) epochOwed += this.usageCost(u);
      const left = this.limits.maxDebitPerEpoch - epochOwed;
      if (left < line) line = left;
    }
    const fromVault = usdFor(this.prices, line, this.cfg.sandbox_reserve_s);
    const used = this.usageOf(agent).usd;
    const epochLeft = typeof used === "number" && Number.isFinite(used) && used >= 0 ? this.cfg.agent_epoch_max_usd - used : 0;
    const g = this.globalLeft();
    const usd = Math.min(this.cfg.attempt_max_usd, fromVault, epochLeft, g);
    if (!Number.isFinite(usd) || !Number.isFinite(epochLeft)) return { usd: null, why: "spend record is not a finite number; refusing to start an attempt", vault: false };
    if (usd < this.cfg.min_attempt_usd) {
      const why = g === usd ? `global runtime cap (${this.cfg.global_max_usd} USD${this.cfg.global_window_s ? ` per ${this.cfg.global_window_s} s window` : ""}) reached` : epochLeft === usd ? "per-agent epoch cap reached" : `compute vault exhausted (${avail} base units unowed)`;
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
        const w = this.spendWindow();
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
      messenger: this.deps.messenger?.(agent, key, (f) => this.meterChain(f)),
      attempt: () => {
        const b = this.budget(agent);
        if (b.usd === null) {
          this.log(`${agent.slice(0, 6)} attempt not started: ${b.why}`);
          if (b.vault) this.exhausted.add(agent);
          return null;
        }
        const a: Attempt = { agent, maxUsd: b.usd, totals: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, usd: 0, sandbox_s: 0, models: [], started_at: this.now(), finished_at: 0 } };
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
        const key = this.store.keyFor(h.agent);
        this.state.agents[h.agent] = { key_id: key.id, key_file: this.store.keyFile(h.agent), status: "awaiting_owner", discovered_at: this.now(), bound_at: null, mint: h.mint, target_repo: h.target_repo, candidates: 0 };
        this.save();
        const req = await b.bindRequest(h.agent, key);
        const dir = join(this.cfg.state_dir, "bind-requests");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${h.agent}.json`), JSON.stringify(req, null, 2));
        this.log(`discovered hosted agent ${h.agent} (${h.target_repo ?? "no target"}); generated runtime key ${key.id}; waiting for the owner to bind it`);
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
      // exhausted until the vault can pay for an attempt again (new fees, or a debit lowered what it owes)
      if (this.exhausted.has(agent) && this.budget(agent).usd !== null) this.exhausted.delete(agent);
    }
  }

  private startAttempts(): void {
    if (this.stopping) return;
    for (const [agent, st] of Object.entries(this.state.agents)) {
      if (this.running.size >= this.cfg.max_concurrent) return;
      if (st.status !== "bound" || this.running.has(agent)) continue;
      if (this.cfg.max_candidates_per_agent !== undefined && st.candidates >= this.cfg.max_candidates_per_agent) continue;
      const v = this.vaults.get(agent);
      if (!v?.awake || this.exhausted.has(agent)) continue;
      if (this.budget(agent).usd === null) {
        const b = this.budget(agent);
        if (b.usd === null && b.vault) this.exhausted.add(agent);
        continue;
      }
      const promise = this.attemptFor(agent).finally(() => this.running.delete(agent));
      this.running.set(agent, { agent, promise });
    }
  }

  private async attemptFor(agent: string): Promise<void> {
    const w = this.worker(agent);
    let commit: string | null = null;
    try {
      commit = await w.authorOnce();
    } catch (e) {
      this.log(`${agent.slice(0, 6)} attempt failed: ${(e as Error).message}`);
    }
    const a = this.attempts.get(agent);
    this.attempts.delete(agent);
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

  /** USD a post may spend for `agent` now: the global cap, the agent's epoch cap and what its vault pays. */
  private postRoom(agent: string): number {
    const v = this.vaults.get(agent);
    if (!v?.awake) return 0;
    const avail = v.balance - this.owed(agent);
    const fromVault = usdFor(this.prices, avail, 0);
    const used = this.usageOf(agent).usd;
    const epochLeft = typeof used === "number" && Number.isFinite(used) && used >= 0 ? this.cfg.agent_epoch_max_usd - used : 0;
    const r = Math.min(fromVault, epochLeft, this.globalLeft());
    return Number.isFinite(r) && r > 0 ? r : 0;
  }

  /** A post's model call: into the agent's usage (billed to its vault with the epoch) and the global cap. */
  private meterPost(agent: string, u: SoulUsage): void {
    const s = this.usageOf(agent);
    s.input_tokens += u.input_tokens;
    s.output_tokens += u.output_tokens;
    s.cache_read_tokens += u.cache_read_tokens;
    s.cache_write_tokens += u.cache_write_tokens;
    s.usd += u.usd;
    for (const m of u.models) if (!s.models.includes(m)) s.models.push(m);
    this.state.spent_usd_total += u.usd;
    const w = this.spendWindow();
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
    if (used.length && !pending && (due || drained || force)) {
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
      await this.refreshAgents();
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
