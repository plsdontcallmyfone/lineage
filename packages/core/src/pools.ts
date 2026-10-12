import {
  accountDisc, compileMessageV0, computeBudget, decodeAgentLaunch, decodeBondingCurve, decodeLaunchConfig, decodePool, decodePoolConfig, decodePoolMember, decodePumpPool,
  decodeConfig as decodeRegistryConfig, decodeTokenAccount, FEATURES, LAUNCH_PROGRAM_ID, launchPdas, POOL_BUY, POOL_VENUE, poolPdas, pools as poolIx, PUMP, pumpPdas, registryPdas,
  settlementAllocation, signMessageWith, system, token, TOKEN_2022_PROGRAM, wireSize, ata,
  type Address, type AgentLaunch, type Ix, type LookupTable, type Pool, type PoolConfig, type PoolMember, type Rpc, type Signer,
} from "@units/chain";
import type { Core } from "./core.ts";
import { ApiError, bad, notFound } from "./errors.ts";
import { featureOn, requireFeature } from "./features.ts";
import { canonicalJson, hashJson } from "./protocol.ts";

// Agent pools, Core side (docs/plans/AGENT-POOLS.md 5): the agents launched on one repository.
// Core mirrors pools from chain, serves them, applies the two coordination rules (a member's
// intent on a target another member holds is refused; a stacked series inside one pool asks for the
// measured split where it exists), computes each epoch's settlement from its own public records
// and, when it holds the pool keeper key, sends the settlement, the payouts and the buys. The
// keeper reads records and chain state only: nothing a model writes reaches a pool instruction,
// and the program pins where pool funds can go whatever this module sends.

export interface PoolsOptions {
  rpc: Rpc | null;
  keeper: Signer | null;
  lineMint: Address | null;
  lineTokenProgram: Address;
  /** a frozen lookup table the keeper's transactions may read (the launch table); null: none */
  table: LookupTable | null;
  /** seconds between keeper steps from Core's tick; 0 = only on request (POST /v1/admin/pools/run) */
  keeperEveryS: number;
  /** price margin a buy leaves under its budget for the venue's fees and movement, bps */
  buyMarginBps: number;
  /** a due amount below this is left for the next settlement */
  minBuyQuote: bigint;
  /** lamports the keeper keeps in a pool authority for the venue's per-user accounts */
  authLamports: bigint;
  log: (m: string) => void;
}

interface Internals {
  db: Core["db"];
  cfg: Core["cfg"] & { max_split_members: number };
  chainMode: boolean;
  now(): number;
  tx<T>(fn: () => T): T;
  emitEvent(type: string, data: unknown): void;
  lineageRow(id: string): { lineage_id: string; repo_id: string; recipe_id: string; tip: string } | null;
  recipeOf(id: string): { metrics: { name: string; deterministic?: boolean }[] };
}

/** TEST values (AGENT-POOLS.md 6): cumulative improvement of one metric of one unit. */
const DEFAULT_MILESTONES = [0.1, 0.25, 0.5];

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS pool_mirror (
    repo_id TEXT NOT NULL, agent TEXT NOT NULL, mint TEXT NOT NULL, idx INTEGER NOT NULL, pool TEXT NOT NULL, synced_at INTEGER NOT NULL,
    PRIMARY KEY (repo_id, agent)
  );
  CREATE INDEX IF NOT EXISTS pool_mirror_agent ON pool_mirror(agent);
  CREATE TABLE IF NOT EXISTS pool_settlements (
    repo_id TEXT NOT NULL, epoch INTEGER NOT NULL, record TEXT NOT NULL, evidence TEXT NOT NULL, signature TEXT, created_at INTEGER NOT NULL,
    PRIMARY KEY (repo_id, epoch)
  );
  CREATE TABLE IF NOT EXISTS pool_milestones (
    repo_id TEXT NOT NULL, lineage_id TEXT NOT NULL, metric TEXT NOT NULL, threshold REAL NOT NULL, cumulative REAL NOT NULL, epoch INTEGER NOT NULL,
    PRIMARY KEY (repo_id, lineage_id, metric, threshold)
  );
  CREATE TABLE IF NOT EXISTS pool_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, signature TEXT, error TEXT, at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pool_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

export interface SettlementRecord {
  v: 1;
  kind: "units-pool-settlement";
  repo_id: string;
  /** the registry epoch the settlement is posted for */
  epoch: number;
  /** Core epochs whose records it covers (after the previous settlement, through `epoch`) */
  epochs: number[];
  members: { agent: string; author_units: number; weight_bps: number }[];
  generations: string[];
  gens: number;
  milestones: { lineage_id: string; metric: string; threshold: number; cumulative: number }[];
}

/** Basis points summing to exactly 10,000, by largest remainder (ties by order); all zero when nothing was earned. */
export function weightsOf(units: number[]): number[] {
  const total = units.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return units.map(() => 0);
  const exact = units.map((u) => (u / total) * 10_000);
  const out = exact.map(Math.floor);
  let left = 10_000 - out.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const o of order) {
    if (left <= 0) break;
    out[o.i]! += 1;
    left--;
  }
  return out;
}

const instances = new WeakMap<Core, Pools>();
export function poolsOf(core: Core): Pools {
  let s = instances.get(core);
  if (!s) instances.set(core, (s = new Pools(core)));
  return s;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Pools {
  private readonly c: Internals;
  private readonly core: Core;
  opts: PoolsOptions;
  private running = false;
  private lastStep = 0;
  constructor(core: Core) {
    this.core = core;
    this.c = core as unknown as Internals;
    this.opts = { rpc: null, keeper: null, lineMint: null, lineTokenProgram: TOKEN_2022_PROGRAM, table: null, keeperEveryS: 0, buyMarginBps: 400, minBuyQuote: 1_000n,
      authLamports: 20_000_000n, log: () => {} };
    this.c.db.exec(SCHEMA);
  }

  configure(o: Partial<PoolsOptions>) {
    this.opts = { ...this.opts, ...o };
    return this;
  }

  private on() {
    requireFeature(this.core, "agent_pools");
  }
  private enabled() {
    return featureOn(this.core, "agent_pools");
  }

  // ---------------------------------------------------------------------------------------------
  // membership

  /**
   * The members of the pool of a repository, in member order. Chain mode: the mirror of the onchain
   * pool. Simulated mode: the launched agents that target the repository (a pool forms at two).
   */
  members(repoId: string): { agent: string; mint: string | null }[] {
    if (this.c.chainMode)
      return this.c.db.query<{ agent: string; mint: string }, [string]>("SELECT agent, mint FROM pool_mirror WHERE repo_id = ? ORDER BY idx").all(repoId);
    return this.c.db.query<{ agent: string; mint: string | null }, [string]>(
      "SELECT agent_id AS agent, mint FROM agents WHERE kind = 'launched' AND shadow = 0 AND target_repo_id = ? ORDER BY registered_at, agent_id").all(repoId);
  }

  /** The repository whose pool the agent is in (a pool has at least two members), or null. */
  poolOf(agent: string): string | null {
    const repo = this.c.chainMode
      ? this.c.db.query<{ repo_id: string }, [string]>("SELECT repo_id FROM pool_mirror WHERE agent = ?").get(agent)?.repo_id
      : this.c.db.query<{ r: string | null }, [string]>("SELECT target_repo_id AS r FROM agents WHERE agent_id = ? AND kind = 'launched' AND shadow = 0").get(agent)?.r;
    return repo && this.members(repo).length >= 2 ? repo : null;
  }

  // ---------------------------------------------------------------------------------------------
  // coordination (AGENT-POOLS.md D11)

  /**
   * Before an intent is filed: a pool member may not take a target another member of the same
   * pool holds an open intent on at this tip. Binds members only, never a commit, never a verdict.
   */
  checkIntentClaim(agent: string, body: unknown): void {
    if (!this.enabled()) return;
    const b = (body ?? {}) as { lineage_id?: unknown; kind?: unknown; target?: unknown; tip?: unknown };
    if (typeof b.lineage_id !== "string" || typeof b.kind !== "string") return;
    const l = this.c.lineageRow(b.lineage_id);
    const repo = this.poolOf(agent);
    if (!l || !repo || l.repo_id !== repo) return;
    const others = this.members(repo).map((m) => m.agent).filter((a) => a !== agent);
    if (!others.length) return;
    const target = canonicalJson(Array.isArray(b.target) ? [...b.target].sort() : b.target);
    const held = this.c.db
      .query<{ agent: string; expires_at: number }, [string, string, string, string]>(
        `SELECT agent, expires_at FROM intents WHERE lineage_id = ? AND tip = ? AND kind = ? AND target = ? AND public_status = 'open' AND shadow = 0 AND agent IN (${others.map(() => "?").join(",")}) ORDER BY created_at LIMIT 1`,
      )
      .get(b.lineage_id, l.tip, b.kind, target, ...(others as []));
    if (held) throw new ApiError(409, "pool_target_claimed", `another member of this repository's pool holds this target until ${new Date(held.expires_at).toISOString()}; pick another target`);
  }

  /**
   * Before a commit: a stacked candidate whose team is made of members of one pool asks for the
   * measured split where the protocol offers it (simulated mode, perf or slim on a deterministic
   * metric, at most max_split_members). Where it does not, declared shares apply as before.
   */
  checkStackedSplit(agent: string, body: unknown): void {
    if (!this.enabled() || this.c.chainMode) return;
    const b = (body ?? {}) as { depends_on?: unknown; lineage_id?: unknown; kind?: unknown; target?: unknown; team?: { members?: { agent?: unknown }[]; split?: unknown } };
    if (typeof b.depends_on !== "string" || !b.team || !Array.isArray(b.team.members) || b.team.split) return;
    const repo = this.poolOf(agent);
    if (!repo || typeof b.lineage_id !== "string") return;
    const l = this.c.lineageRow(b.lineage_id);
    if (!l || l.repo_id !== repo) return;
    const ids = new Set(this.members(repo).map((m) => m.agent));
    const team = b.team.members.map((m) => m.agent);
    if (team.length < 2 || team.length > this.c.cfg.max_split_members || !team.every((a) => typeof a === "string" && ids.has(a))) return;
    if (b.kind === "fix" || typeof b.target !== "string") return;
    const m = this.c.recipeOf(l.recipe_id).metrics.find((x) => x.name === b.target);
    if (!m?.deterministic) return;
    throw bad("pool_split_required", "a stacked candidate by members of one pool divides its credit by the measured split: add team.split { mode: \"shapley\", sub_commitment } (SPEC 12.6)");
  }

  /** GET /v1/pools/:id/context: what a member's worker reads before it plans. */
  context(id: string) {
    this.on();
    const repo = this.repoOf(id);
    const members = this.members(repo);
    if (members.length < 2) throw notFound("pool");
    const lineages = this.c.db.query<{ lineage_id: string; tip: string }, [string]>("SELECT lineage_id, tip FROM lineages WHERE repo_id = ? AND status = 'active'").all(repo);
    const ids = members.map((m) => m.agent), ph = ids.map(() => "?").join(","), lh = lineages.map(() => "?").join(",");
    const intents = lineages.length ? this.c.db.query<Record<string, unknown>, []>(
      `SELECT intent_id, agent, lineage_id, tip, kind, target, note, expires_at FROM intents WHERE public_status = 'open' AND shadow = 0 AND agent IN (${ph}) AND lineage_id IN (${lh}) ORDER BY created_at DESC LIMIT 200`,
    ).all(...([...ids, ...lineages.map((l) => l.lineage_id)] as [])) : [];
    const findings = lineages.length ? this.c.db.query<Record<string, unknown>, []>(
      `SELECT finding_id, lineage_id, kind, target, tip, finder, created_at FROM findings WHERE status = 'open' AND lineage_id IN (${lh}) ORDER BY created_at DESC LIMIT 200`,
    ).all(...(lineages.map((l) => l.lineage_id) as [])) : [];
    return {
      repo_id: repo, members: ids, units: lineages,
      intents: intents.map((i) => ({ ...i, target: JSON.parse(i.target as string) })),
      claimed_targets: intents.map((i) => ({ lineage_id: i.lineage_id, kind: i.kind, target: JSON.parse(i.target as string), by: i.agent, until: i.expires_at })),
      findings,
      shared_findings: `/v1/findings/shared?repo=${repo}`,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // settlement record (from Core's own final records)

  milestoneThresholds(): number[] {
    const row = this.c.db.query<{ v: string }, []>("SELECT v FROM pool_kv WHERE k = 'milestones'").get();
    return row ? (JSON.parse(row.v) as number[]) : DEFAULT_MILESTONES;
  }

  /** POST /v1/admin/pools/config { milestones?: number[] } */
  setConfig(body: unknown) {
    this.on();
    const m = (body as { milestones?: unknown })?.milestones;
    if (m !== undefined) {
      if (!Array.isArray(m) || !m.length || m.length > 16 || !m.every((x) => typeof x === "number" && x > 0 && x < 1)) throw bad("bad_milestones", "milestones: 1 to 16 fractions between 0 and 1");
      this.c.db.query("INSERT INTO pool_kv (k, v) VALUES ('milestones', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(JSON.stringify([...new Set(m as number[])].sort((a, b) => a - b)));
    }
    return this.configView();
  }
  configView() {
    this.on();
    return { milestones: this.milestoneThresholds(), keeper: this.opts.keeper?.id ?? null, keeper_every_s: this.opts.keeperEveryS, buy_margin_bps: this.opts.buyMarginBps,
      min_buy_quote: this.opts.minBuyQuote.toString() };
  }

  /** Cumulative improvement per unit and metric through `epoch`: 1 - product of the effect ratios of its live accepted generations. */
  cumulative(repoId: string, epoch: number): { lineage_id: string; metric: string; cumulative: number }[] {
    const rows = this.c.db.query<{ lineage_id: string; target: string | null; effect: string | null }, [string, number]>(
      `SELECT g.lineage_id, g.target, g.effect FROM generations g JOIN lineages l ON l.lineage_id = g.lineage_id
       WHERE l.repo_id = ? AND g.entry_type = 'patch' AND g.reverted_by IS NULL AND g.epoch <= ? ORDER BY g.lineage_id, g.height`).all(repoId, epoch);
    const acc = new Map<string, number>();
    for (const g of rows) {
      let target: unknown, effect: { ratio?: unknown } | null;
      try {
        target = g.target ? JSON.parse(g.target) : null;
        effect = g.effect ? JSON.parse(g.effect) : null;
      } catch {
        continue;
      }
      if (typeof target !== "string" || !effect || typeof effect.ratio !== "number" || !(effect.ratio > 0) || !(effect.ratio < 1)) continue;
      const k = `${g.lineage_id}\n${target}`;
      acc.set(k, (acc.get(k) ?? 1) * effect.ratio);
    }
    return [...acc].map(([k, r]) => ({ lineage_id: k.split("\n")[0]!, metric: k.split("\n")[1]!, cumulative: Math.round((1 - r) * 1e9) / 1e9 }));  // 1 - 0.9 must count as 0.1
  }

  /**
   * The settlement of a pool for registry epoch `epoch`, covering Core epochs after `after`: the
   * members' author units on the repository's units, the generations that earned them and the
   * milestones newly crossed. `members` in pool order.
   */
  settlement(repoId: string, members: string[], epoch: number, after: number): SettlementRecord {
    const ph = members.map(() => "?").join(",");
    const rows = this.c.db.query<{ agent_id: string; ref: string; units: number; epoch: number }, []>(
      `SELECT u.agent_id, u.ref, u.units, u.epoch FROM units u JOIN generations g ON g.gen_id = u.ref JOIN lineages l ON l.lineage_id = g.lineage_id
       WHERE u.kind = 'author' AND u.voided = 0 AND u.epoch > ? AND u.epoch <= ? AND l.repo_id = ? AND g.reverted_by IS NULL AND u.agent_id IN (${ph}) ORDER BY u.id`,
    ).all(...([after, epoch, repoId, ...members] as unknown as []));
    const units = members.map((a) => rows.filter((r) => r.agent_id === a).reduce((s, r) => s + r.units, 0));
    const weights = weightsOf(units);
    const generations = [...new Set(rows.map((r) => r.ref))].sort();
    const thresholds = this.milestoneThresholds();
    const done = new Set(this.c.db.query<{ lineage_id: string; metric: string; threshold: number }, [string]>("SELECT lineage_id, metric, threshold FROM pool_milestones WHERE repo_id = ?")
      .all(repoId).map((m) => `${m.lineage_id}\n${m.metric}\n${m.threshold}`));
    const milestones = this.cumulative(repoId, epoch).flatMap((c) => thresholds.filter((t) => c.cumulative >= t && !done.has(`${c.lineage_id}\n${c.metric}\n${t}`))
      .map((t) => ({ lineage_id: c.lineage_id, metric: c.metric, threshold: t, cumulative: Math.round(c.cumulative * 1e6) / 1e6 })))
      .sort((a, b) => (a.lineage_id + a.metric).localeCompare(b.lineage_id + b.metric) || a.threshold - b.threshold).slice(0, 16);
    const epochs = [...new Set(rows.map((r) => r.epoch))].sort((a, b) => a - b);
    return { v: 1, kind: "units-pool-settlement", repo_id: repoId, epoch, epochs,
      members: members.map((agent, i) => ({ agent, author_units: Math.round(units[i]! * 1e6) / 1e6, weight_bps: weights[i]! })), generations, gens: Math.min(generations.length, 65_535), milestones };
  }

  private recordSettlement(r: SettlementRecord, signature: string | null) {
    this.c.tx(() => {
      this.c.db.query("INSERT INTO pool_settlements (repo_id, epoch, record, evidence, signature, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(repo_id, epoch) DO UPDATE SET signature = excluded.signature")
        .run(r.repo_id, r.epoch, canonicalJson(r), hashJson(r), signature, this.c.now());
      for (const m of r.milestones)
        this.c.db.query("INSERT OR IGNORE INTO pool_milestones (repo_id, lineage_id, metric, threshold, cumulative, epoch) VALUES (?, ?, ?, ?, ?, ?)").run(r.repo_id, m.lineage_id, m.metric, m.threshold, m.cumulative, r.epoch);
      this.c.emitEvent("pool.settled", { repo_id: r.repo_id, epoch: r.epoch, gens: r.gens, milestones: r.milestones.length, signature });
    });
  }

  /** GET /v1/pools/:id/settlements */
  settlements(id: string) {
    this.on();
    const repo = this.repoOf(id);
    return this.c.db.query<{ epoch: number; record: string; evidence: string; signature: string | null; created_at: number }, [string]>(
      "SELECT epoch, record, evidence, signature, created_at FROM pool_settlements WHERE repo_id = ? ORDER BY epoch DESC LIMIT 200").all(repo)
      .map((s) => ({ epoch: s.epoch, evidence: s.evidence, signature: s.signature, created_at: s.created_at, record: JSON.parse(s.record) as SettlementRecord }));
  }

  /** GET /v1/pools/:id/actions */
  actions(id: string) {
    this.on();
    const repo = this.repoOf(id);
    return this.c.db.query<{ kind: string; detail: string; signature: string | null; error: string | null; at: number }, [string]>(
      "SELECT kind, detail, signature, error, at FROM pool_actions WHERE repo_id = ? ORDER BY id DESC LIMIT 200").all(repo).map((a) => ({ ...a, detail: JSON.parse(a.detail) }));
  }

  // ---------------------------------------------------------------------------------------------
  // chain reads and views

  private rpc(): Rpc {
    if (!this.opts.rpc || !this.opts.lineMint) throw new ApiError(503, "no_chain", "pools need chain mode");
    return this.opts.rpc;
  }

  private repoOf(id: string): string {
    if (/^[0-9a-f]{64}$/.test(id)) return id;
    const byUrl = this.c.db.query<{ repo_id: string }, [string]>("SELECT repo_id FROM repos WHERE url = ?").get(id);
    if (byUrl) return byUrl.repo_id;
    throw bad("bad_pool", "a pool is named by its repository id (64 hex)");
  }

  async chainConfig(): Promise<PoolConfig | null> {
    const a = await this.rpc().getAccountInfo(poolPdas.config());
    return a ? decodePoolConfig(a.data) : null;
  }

  private async chainPools(): Promise<(Pool & { address: Address })[]> {
    const accts = await this.rpc().getProgramAccounts(LAUNCH_PROGRAM_ID, { memcmp: [{ offset: 0, bytes: accountDisc("Pool") }] });
    return accts.map((a) => ({ address: a.address, ...decodePool(a.data) }));
  }

  private async chainMembers(p: Pool): Promise<PoolMember[]> {
    const accts = await this.rpc().getMultipleAccounts(p.members.map((m) => poolPdas.member(m)));
    return accts.map((a, i) => {
      if (!a) throw new Error(`pool member ${p.members[i]} has no account`);
      return decodePoolMember(a.data);
    });
  }

  /** Mirrors every onchain pool's member list (chain mode). */
  async sync(): Promise<number> {
    const pools = await this.chainPools();
    const members = await Promise.all(pools.map((p) => this.chainMembers(p)));
    const now = this.c.now();
    this.c.tx(() => {
      this.c.db.exec("DELETE FROM pool_mirror");
      pools.forEach((p, i) => members[i]!.forEach((m) =>
        this.c.db.query("INSERT INTO pool_mirror (repo_id, agent, mint, idx, pool, synced_at) VALUES (?, ?, ?, ?, ?, ?)").run(p.repoId, m.agent, m.mint, m.index, p.address, now)));
    });
    return pools.length;
  }

  private memberView(m: PoolMember) {
    return { agent: m.agent, mint: m.mint, index: m.index, joined_at: Number(m.joinedAt), contributed: m.contributed.toString(), cross_pairs_owed: m.crossPairs,
      cross_due: m.crossDue.toString(), cross_funded: m.crossFunded.toString(), payout_due: m.payoutDue.toString(), buyback_due: m.buybackDue.toString(),
      burn_due: m.burnDue.toString(), paid: m.paid.toString(), bought_quote: m.boughtQuote.toString(), tokens_held: m.tokensHeld.toString(), tokens_burned: m.tokensBurned.toString() };
  }
  private async poolView(p: Pool & { address: Address }) {
    const [members, vault] = await Promise.all([this.chainMembers(p), this.rpc().getAccountInfo(p.vault)]);
    const url = this.c.db.query<{ url: string }, [string]>("SELECT url FROM repos WHERE repo_id = ?").get(p.repoId)?.url ?? null;
    return {
      repo_id: p.repoId, repo_url: url, address: p.address, authority: poolPdas.auth(p.repoId), vault: p.vault, vault_balance: vault ? decodeTokenAccount(vault.data).amount.toString() : "0",
      active: p.members.length >= 2, created_at: Number(p.createdAt),
      buckets: { payout: p.bucketPayout.toString(), buyback: p.bucketBuyback.toString(), burn: p.bucketBurn.toString() },
      last_epoch: p.settled ? Number(p.lastEpoch) : null, gens: Number(p.gens), milestones: p.milestones,
      totals: { contributed: p.contributed.toString(), paid: p.paid.toString(), bought: p.bought.toString(), burn_spent: p.burnSpent.toString() },
      members: members.map((m) => this.memberView(m)),
    };
  }

  /** GET /v1/pools */
  async list() {
    this.on();
    const [cfg, pools] = await Promise.all([this.chainConfig(), this.chainPools()]);
    return { config: cfg ? { ...cfg, crossHoldQuote: cfg.crossHoldQuote.toString(), maxBuyQuote: cfg.maxBuyQuote.toString() } : null, pools: await Promise.all(pools.map((p) => this.poolView(p))) };
  }

  /** GET /v1/pools/:id */
  async view(id: string) {
    this.on();
    const repo = this.repoOf(id);
    const a = await this.rpc().getAccountInfo(poolPdas.pool(repo));
    if (!a) throw notFound("pool");
    return this.poolView({ address: a.address, ...decodePool(a.data) });
  }

  /** GET /v1/agents/:id/pool */
  async ofAgent(agent: string) {
    this.on();
    const a = await this.rpc().getAccountInfo(poolPdas.member(agent));
    if (!a || a.owner !== LAUNCH_PROGRAM_ID) return { agent, pool: null };
    const m = decodePoolMember(a.data);
    const p = await this.rpc().getAccountInfo(m.pool);
    if (!p) return { agent, pool: null };
    const pool = { address: p.address, ...decodePool(p.data) };
    return { agent, pool: await this.poolView(pool), member: this.memberView(m) };
  }

  // ---------------------------------------------------------------------------------------------
  // keeper

  private act(repo: string, kind: string, detail: unknown, signature: string | null, error: string | null = null) {
    this.c.db.query("INSERT INTO pool_actions (repo_id, kind, detail, signature, error, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(repo, kind, JSON.stringify(detail, (_, v) => (typeof v === "bigint" ? v.toString() : v)), signature, error, this.c.now());
    this.opts.log(`pools: ${kind} ${repo.slice(0, 12)} ${signature ?? error}`);
  }

  /** One v0 transaction signed by the keeper, simulated first, rebroadcast until confirmed. */
  private async send(ixs: Ix[], computeUnits: number): Promise<string> {
    const rpc = this.rpc(), key = this.opts.keeper!;
    const all = [computeBudget.limit(computeUnits), ...ixs];
    for (let attempt = 0; attempt < 3; attempt++) {
      const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
      const msg = compileMessageV0(key.id, all, blockhash, this.opts.table ? [this.opts.table] : []);
      if (wireSize(msg) > 1232) throw new Error(`transaction is ${wireSize(msg)} bytes`);
      const tx = signMessageWith(msg, [key]);
      const sim = await rpc.simulate(tx.wire);
      if (sim.err) throw new Error(`simulation failed: ${JSON.stringify(sim.err)} ${(sim.logs ?? []).filter((l) => /Error|failed/.test(l)).slice(-2).join(" | ")}`);
      await rpc.sendRawTransaction(tx.wire, true);
      let last = Date.now();
      for (;;) {
        await sleep(800);
        const [st] = await rpc.getSignatureStatuses([tx.signature]);
        if (st?.err) throw new Error(`transaction ${tx.signature} failed: ${JSON.stringify(st.err)}`);
        if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return tx.signature;
        if ((await rpc.getBlockHeight()) > lastValidBlockHeight) break;
        if (Date.now() - last > 2500) {
          await rpc.sendRawTransaction(tx.wire, true).catch(() => undefined);
          last = Date.now();
        }
      }
    }
    throw new Error("not confirmed after 3 blockhashes");
  }

  /** Tokens of `mint` that cost at most `budget` on its venue now, with the configured margin, and the venue. */
  private async buySize(mint: Address, budget: bigint): Promise<{ venue: number; tokens: bigint }> {
    const rpc = this.rpc(), line = this.opts.lineMint!, tp = this.opts.lineTokenProgram;
    const pool = pumpPdas.pool(mint, line);
    const [c, p, pb, pq] = await rpc.getMultipleAccounts([pumpPdas.bondingCurve(mint), pool, ata(pool, mint, TOKEN_2022_PROGRAM), ata(pool, line, tp)]);
    const net = (budget * BigInt(10_000 - this.opts.buyMarginBps)) / 10_000n;
    if (p && pb && pq) {
      const base = decodeTokenAccount(pb.data).amount, quote = decodeTokenAccount(pq.data).amount + decodePumpPool(p.data).virtualQuoteReserves;
      return { venue: POOL_VENUE.amm, tokens: (net * base) / (quote + net) };
    }
    if (!c) throw new Error(`${mint}: no bonding curve`);
    const curve = decodeBondingCurve(c.data);
    if (curve.complete) throw new Error(`${mint}: the curve is complete and not migrated yet`);
    const tokens = (net * curve.virtualTokenReserves) / (curve.virtualQuoteReserves + net);
    return { venue: POOL_VENUE.curve, tokens: tokens < curve.realTokenReserves ? tokens : 0n };
  }

  /**
   * One pass over every pool: auto-join (when the program allows it), settle the newest posted
   * epoch, pay allocated payouts, buy cross-holdings, buybacks and burns. Each action is one
   * transaction; a failure is recorded and the pass goes on. Returns what it did.
   */
  async keeperStep(): Promise<{ pools: number; actions: { repo: string; kind: string; signature?: string; error?: string }[] }> {
    this.on();
    const key = this.opts.keeper;
    if (!key) throw new ApiError(503, "no_keeper", "this Core holds no pool keeper key");
    if (this.running) throw new ApiError(409, "keeper_busy", "a keeper step is running");
    this.running = true;
    const out: { repo: string; kind: string; signature?: string; error?: string }[] = [];
    const line = this.opts.lineMint!, tp = this.opts.lineTokenProgram, rpc = this.rpc();
    const run = async (repo: string, kind: string, detail: unknown, ixs: Ix[], cu = 400_000): Promise<boolean> => {
      try {
        const signature = await this.send(ixs, cu);
        this.act(repo, kind, detail, signature);
        out.push({ repo, kind, signature });
        return true;
      } catch (e) {
        const error = String((e as Error)?.message ?? e).slice(0, 400);
        this.act(repo, kind, detail, null, error);
        out.push({ repo, kind, error });
        return false;
      }
    };
    try {
      const [cfgA, lcA, rcA] = await rpc.getMultipleAccounts([poolPdas.config(), launchPdas.config(), registryPdas.config()]);
      if (!cfgA || !lcA || !rcA) throw new ApiError(503, "no_pool_config", "the program has no PoolConfig");
      const cfg = decodePoolConfig(cfgA.data), lc = decodeLaunchConfig(lcA.data), rc = decodeRegistryConfig(rcA.data);
      if (!(lc.features & FEATURES.pools) || cfg.paused) return { pools: 0, actions: out };
      if (cfg.keeper !== key.id) throw new ApiError(503, "keeper_mismatch", "this Core's keeper key is not the one the program trusts");

      // 1. auto-join: every launched agent of a repository that has at least two
      if (cfg.autoJoin) {
        const launches = (await rpc.getProgramAccounts(LAUNCH_PROGRAM_ID, { memcmp: [{ offset: 0, bytes: accountDisc("AgentLaunch") }] }))
          .map((a) => { try { return decodeAgentLaunch(a.data); } catch { return null; } }).filter((l): l is AgentLaunch => !!l && l.venue === "pump");
        const byRepo = new Map<string, AgentLaunch[]>();
        for (const l of launches) byRepo.set(l.repoId, [...(byRepo.get(l.repoId) ?? []), l]);
        for (const [repo, ls] of byRepo) {
          if (ls.length < 2) continue;
          for (const l of ls.sort((a, b) => Number(a.createdAt - b.createdAt)).filter((l) => !(l.routes & FEATURES.pools))) {
            const p = await rpc.getAccountInfo(poolPdas.pool(repo));
            const members = p ? decodePool(p.data).members : [];
            if (members.length >= cfg.maxMembers) break;
            await run(repo, "join", { agent: l.agent }, [poolIx.joinPool({ signer: key.id, agent: l.agent, agentMint: l.mint, repoId: repo, lineMint: line, members, lineTokenProgram: tp })]);
          }
        }
      }

      await this.sync();
      const pools = (await this.chainPools()).filter((p) => p.members.length >= 2);
      for (const p0 of pools) {
        const repo = p0.repoId;
        let p = p0;
        const reload = async () => {
          const a = await rpc.getAccountInfo(p.address);
          p = { address: p.address, ...decodePool(a!.data) };
          return this.chainMembers(p);
        };
        // 2. settle the newest posted registry epoch
        const epoch = Number(rc.lastEpoch);
        if (rc.epochsPosted > 0n && (!p.settled || BigInt(epoch) > p.lastEpoch)) {
          const record = this.settlement(repo, p.members, epoch, p.settled ? Number(p.lastEpoch) : -1);
          const weights = record.members.map((m) => m.weight_bps);
          if (record.gens > 0 || record.milestones.length > 0) {
            const ok = await run(repo, "settle", { epoch, gens: record.gens, weights, milestones: record.milestones.length, evidence: hashJson(record) },
              [poolIx.poolSettle({ keeper: key.id, repoId: repo, members: p.members, epoch, gens: record.gens, weights, milestones: record.milestones.length, evidence: hashJson(record) })]);
            if (ok) this.recordSettlement(record, out[out.length - 1]!.signature!);
          }
        }
        let members = await reload();
        // the pool authority pays the venue's per-user account rent, and holds one token account per member mint
        const prep: Ix[] = [];
        const [authInfo, ...holdings] = await rpc.getMultipleAccounts([poolPdas.auth(repo), ...members.map((m) => poolPdas.holding(repo, m.mint))]);
        if ((authInfo?.lamports ?? 0n) < this.opts.authLamports / 2n) prep.push(system.transfer(key.id, poolPdas.auth(repo), this.opts.authLamports));
        members.forEach((m, i) => { if (!holdings[i]) prep.push(token.createAtaIdempotent(key.id, poolPdas.auth(repo), m.mint, TOKEN_2022_PROGRAM)); });
        prep.push(token.createAtaIdempotent(key.id, PUMP.buybackRecipients[0]!, line, tp));
        if (prep.length > 1 && !(await run(repo, "prepare", { accounts: prep.length }, prep, 200_000))) continue;
        // 3. payouts
        for (const m of members.filter((m) => m.payoutDue > 0n))
          await run(repo, "pay", { agent: m.agent, amount: m.payoutDue }, [poolIx.poolPay({ repoId: repo, agent: m.agent, agentMint: m.mint, lineMint: line, lineTokenProgram: tp })], 200_000);
        // 4. cross-holdings: each funded holder buys each member it does not hold yet
        for (const h of members.filter((m) => m.crossPairs > 0)) {
          const have = await rpc.getMultipleAccounts(members.map((t) => poolPdas.cross(h.agent, t.agent)));
          for (const [i, t] of members.entries()) {
            if (t.agent === h.agent || have[i]) continue;
            const cur = decodePoolMember((await rpc.getAccountInfo(poolPdas.member(h.agent)))!.data);
            if (cur.crossPairs === 0 || (cur.crossFunded < cfg.crossHoldQuote && cur.crossDue > 0n)) break;
            const budget = [cur.crossFunded, cfg.crossHoldQuote, cfg.maxBuyQuote].reduce((a, b) => (a < b ? a : b));
            if (budget < this.opts.minBuyQuote && cur.crossDue > 0n) break;
            try {
              const size = await this.buySize(t.mint, budget);
              if (size.tokens <= 0n) continue;
              await run(repo, "cross_buy", { holder: h.agent, target: t.agent, budget, tokens: size.tokens, venue: size.venue, delivered_to: poolPdas.heldBy(h.agent, t.mint) },
                [token.createAtaIdempotent(key.id, h.agent, t.mint, TOKEN_2022_PROGRAM), poolIx.poolCrossBuy({ keeper: key.id, repoId: repo, holder: h.agent, target: t.agent, targetMint: t.mint, lineMint: line, venue: size.venue, tokenAmount: size.tokens,
                  maxQuote: budget, lineTokenProgram: tp })], 600_000);
            } catch (e) {
              this.act(repo, "cross_buy", { holder: h.agent, target: t.agent }, null, String((e as Error).message).slice(0, 300));
            }
          }
        }
        // 5. buybacks (held) and milestone burns
        members = await reload();
        for (const m of members) {
          for (const [kind, due] of [[POOL_BUY.buyback, m.buybackDue], [POOL_BUY.burn, m.burnDue]] as const) {
            const budget = due < cfg.maxBuyQuote ? due : cfg.maxBuyQuote;
            if (budget < this.opts.minBuyQuote) continue;
            try {
              const size = await this.buySize(m.mint, budget);
              if (size.tokens <= 0n) continue;
              await run(repo, kind === POOL_BUY.burn ? "burn_buy" : "buyback", { target: m.agent, budget, tokens: size.tokens, venue: size.venue },
                [poolIx.poolBuy({ keeper: key.id, repoId: repo, target: m.agent, targetMint: m.mint, lineMint: line, kind, venue: size.venue, tokenAmount: size.tokens, maxQuote: budget,
                  lineTokenProgram: tp })], 600_000);
            } catch (e) {
              this.act(repo, kind === POOL_BUY.burn ? "burn_buy" : "buyback", { target: m.agent }, null, String((e as Error).message).slice(0, 300));
            }
          }
        }
      }
      return { pools: pools.length, actions: out };
    } finally {
      this.running = false;
      this.lastStep = this.c.now();
    }
  }

  /** Called from Core.tick(): a keeper step in the background every `keeperEveryS`, when this Core holds the key. */
  tick() {
    if (!this.enabled() || !this.opts.keeper || !this.opts.rpc || this.opts.keeperEveryS <= 0 || this.running) return;
    if (this.c.now() - this.lastStep < this.opts.keeperEveryS * 1000) return;
    this.lastStep = this.c.now();
    void this.keeperStep().catch((e) => this.opts.log(`pools: keeper step failed: ${String((e as Error)?.message ?? e)}`));
  }
}

/** What a settlement allocates, recomputed offchain (scripts/pools/verify-settlement.ts and tests). */
export { settlementAllocation };
