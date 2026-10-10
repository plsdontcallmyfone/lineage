import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { BlobStore } from "./blobs.ts";
import type { Clock } from "./clock.ts";
import type { NetworkConfig } from "./config.ts";
import { ApiError, bad, conflict, forbidden, notFound } from "./errors.ts";
import { ACC, Ledger } from "./ledger.ts";
import {
  H,
  assignReplayers,
  assignmentSeed,
  calibId,
  canonicalJson,
  canonicalUrl,
  candidateId,
  canonicalizeDiff,
  commitBeacon,
  costClass,
  effectValue,
  gen0,
  genId,
  generateAgentKey,
  guard,
  judge,
  leafHash,
  lineageId,
  median,
  relDiff,
  satisfies,
  merkleProof,
  merkleRoot,
  patchCommitment,
  patchHash,
  proportionalSplit,
  recipeId,
  repoId,
  resultCommitment,
  semanticHash,
  snapshotId,
  verifyMessage,
  verifyProof,
  Rng,
  type Calibration,
  type Capabilities,
  type CandidateKind,
  type CandidateView,
  type Eligible,
  type Judgement,
  type Recipe,
  type ReplayResult,
  type RevealedReplay,
} from "./protocol.ts";
import { Collab } from "./collab.ts";
import { Hardening } from "./hardening.ts";
import { Identity } from "./identity.ts";
import { Records } from "./records.ts";
import { Series } from "./series.ts";
import { Messages } from "./messages.ts";
import { soulsOf } from "./souls.ts";
import { challengesOf } from "./challenges.ts";
import { findingsOf } from "./findings.ts";
import { linksOf } from "./links.ts";
import { prepayOf } from "./prepay.ts";
import { upstreamOf } from "./upstream.ts";
import { Hosted } from "./hosted.ts";
import { Split } from "./split.ts";
import { Ports } from "./ports.ts";
import { Live } from "./live.ts";
import { openDb } from "./store.ts";
import { SlotBeacon } from "./beacon.ts";
import { deploymentsOf } from "./deployments.ts";
import type { TreeSource } from "./trees.ts";

// The Core coordinator: SPEC sections 5, 10, 11, 12, 13. Every state change goes through a method
// of this class inside one SQLite transaction, time comes only from the injected clock, and every
// random choice is derived from the epoch secret so it can be recomputed once the secret is revealed.

export interface CoreOptions {
  dataDir: string;
  network: NetworkConfig;
  /** base58 ed25519 public key of the admin. */
  adminId: string;
  /** Optional hosted runtime authority (may post usage debits). The admin may always do so. */
  runtimeId?: string;
  clock: Clock;
  /** Width of the reveal-time bucket mixed into the M1 assignment beacon (SPEC 10.3). */
  beaconBucketS?: number;
  /** Accepted clock skew for request nonces. */
  nonceWindowMs?: number;
  maxBlobBytes?: number;
  /** Source of epoch secrets (tests may make it deterministic). */
  randomHex?: (bytes: number) => string;
  /** Where the live wall's generation trees come from (SPEC 17.1). Null: paths unchecked, no file reads. */
  trees?: TreeSource | null;
  /**
   * Chain mode (config `chain.mode: "devnet"`): registrations, bonds, fees, claims and usage happen
   * on chain and are mirrored in by `ChainBridge` (src/chain.ts); the endpoints that would simulate
   * them answer 409 `on_chain`. Default false: the simulated M1 ledger.
   */
  chainMode?: boolean;
  /** Number of the first epoch a fresh database opens (chain mode: one past the last posted epoch). */
  firstEpoch?: number;
  /**
   * M2 slot-hash beacon (SPEC 10.3, src/beacon.ts): draws wait for a finalized Solana slot hash
   * fixed after the request. main.ts sets it in chain mode and runs the resolver; without it the M1 beacon.
   */
  slotBeacon?: { lagSlots?: number };
}

/** An agent as the registry program holds it, plus its launch and compute vault for launched agents. */
export interface ChainAgent {
  agent: string;
  owner: string;
  kind: "verifier" | "launched";
  burned: bigint;
  bond: bigint;
  unbondAmount: bigint;
  /** Unix seconds; 0 when no unbond is pending. */
  unbondReadyAt: bigint;
  registeredAt: bigint;
  /** 64 hex; all zero when undeclared. */
  operator: string;
  capabilities: string;
  launch?: { mint: string; launcher: string; repoUrl: string; identityMode: number; hosted: boolean };
  /** Compute vault balance (launched agents). */
  compute?: bigint;
  /** Agent v2 (identity plan I1): current signing key (null: revoked), rotation counter, last change (unix s). */
  signingKey?: string | null;
  keySeq?: number;
  keyChangedAt?: bigint;
  /** Unix seconds since the current owner controls the agent; pending owner of a transfer. */
  ownerSince?: bigint;
  pendingOwner?: string | null;
}
const ZERO32 = "00".repeat(32);
const CHAIN_OFFENCE: Record<string, number> = { canary: 0, minority: 1, audit_minority: 1, reveal_mismatch: 2 };

/** Candidate rejection reasons: the judge's reasons plus those Core decides itself. */
export type CandidateReason =
  | NonNullable<Judgement["reason"]>
  | "duplicate"
  | "stale_conflict"
  | "stale"
  | "unresolved_dispute"
  | "canary"
  | "lineage_retired"
  | "expired"
  | "dependency_failed";

export type CandidateStatus = "committed" | "waiting" | "queued" | "replaying" | "disputed" | "accepted" | "rejected" | "expired";
const OPEN_STATUSES = ["committed", "waiting", "queued", "replaying", "disputed"];
const TERMINAL = new Set(["accepted", "rejected", "expired"]);

export interface CoreEvent {
  id: number;
  at: number;
  type: string;
  data: unknown;
}

interface AgentRow {
  agent_id: string;
  kind: "launched" | "verifier";
  operator: string | null;
  registered_at: number;
  mint: string | null;
  launcher: string | null;
  target_repo: string | null;
  target_repo_id: string | null;
  identity_mode: string | null;
  hosted: number;
  lifecycle: "setting_up" | "active";
  awake: number;
  reference: number;
  shadow: number;
  suspended_through_epoch: number;
  unbond_amount: string;
  unbond_ready_at: number | null;
  capabilities: string | null;
  capabilities_at: number | null;
}

interface QualRow {
  qual_id: string;
  agent_id: string;
  lineage_id: string;
  recipe_id: string;
  attempt: number;
  seed: string;
  status: "assigned" | "committed" | "passed" | "failed" | "expired" | "revoked" | "cancelled";
  capabilities: string | null;
  commitment: string | null;
  result: string | null;
  salt: string | null;
  reason: string | null;
  assigned_at: number;
  commit_deadline: number;
  committed_at: number | null;
  reveal_deadline: number | null;
  revealed_at: number | null;
  resolved_at: number | null;
}

interface LineageRow {
  lineage_id: string;
  repo_id: string;
  snapshot_id: string;
  recipe_id: string;
  calib_id: string;
  gen0: string;
  tip: string;
  height: number;
  status: string;
  created_at: number;
}

interface GenRow {
  gen_id: string;
  lineage_id: string;
  parent_gen_id: string | null;
  height: number;
  entry_type: "genesis" | "patch" | "revert";
  candidate_id: string | null;
  patch_hash: string | null;
  semantic_hash: string | null;
  patch: string | null;
  kind: string | null;
  target: string | null;
  effect: string | null;
  verdict_digest: string | null;
  verdict: string | null;
  replay_ids: string | null;
  author: string | null;
  accepted_at: number;
  epoch: number;
  reverts: string | null;
  reverted_by: string | null;
  needs_revalidation: number;
  audit_status: string | null;
}

interface CandRow {
  commit_id: string;
  candidate_id: string | null;
  lineage_id: string;
  parent_gen_id: string;
  eval_parent_gen_id: string;
  author: string;
  kind: CandidateKind;
  target: string;
  claimed_effect: number | null;
  commitment: string;
  patch: string | null;
  salt: string | null;
  patch_hash: string | null;
  semantic_hash: string | null;
  guard: string | null;
  status: CandidateStatus;
  reason: string | null;
  detail: string | null;
  committed_at: number;
  reveal_deadline: number;
  revealed_at: number | null;
  finalized_at: number | null;
  stage: number;
  want_replays: number;
  want_reference: number;
  reassigns: number;
  dispute_rounds: number;
  rounds: number;
  is_canary: number;
  canary_id: string | null;
  gen_id: string | null;
  verdict: string | null;
  epoch: number;
}

interface ReplayRow {
  replay_id: string;
  candidate_id: string;
  grp: string;
  audit_id: string | null;
  replayer: string;
  kind: "replay" | "reference" | "audit" | "audit_reference";
  stage: number;
  round: number;
  eval_parent_gen_id: string;
  assignment_seed: string;
  seed: string;
  status: "assigned" | "committed" | "revealed" | "invalid" | "abandoned" | "cancelled";
  commitment: string | null;
  result: string | null;
  salt: string | null;
  assigned_at: number;
  commit_deadline: number;
  committed_at: number | null;
  reveal_open_at: number | null;
  reveal_deadline: number | null;
  revealed_at: number | null;
  role: string | null;
  epoch: number;
}

interface AuditRow {
  audit_id: string;
  gen_id: string;
  candidate_id: string;
  status: "pending" | "agreed" | "reverted" | "inconclusive" | "weak";
  want_replays: number;
  want_reference: number;
  rounds: number;
  verdict: string | null;
  created_at: number;
  resolved_at: number | null;
  epoch: number;
  detail: string | null;
}

interface EpochRow {
  n: number;
  start_ms: number;
  end_ms: number;
  secret: string;
  beacon_commit: string;
  status: "open" | "closed";
  closed_at: number | null;
  pool_amount: string | null;
  rebate_amount: string | null;
  total_units: number | null;
  payouts: string | null;
  root: string | null;
  lineage_root: string | null;
  record_root?: string | null;
  canaries: string | null;
}

interface CanaryRow {
  canary_id: string;
  lineage_id: string;
  patch: string;
  patch_hash: string;
  kind: CandidateKind;
  target: string;
  expected_reason: string;
  created_at: number;
  uses: number;
}

export interface PayoutLeaf {
  agent: string;
  dest: string;
  amount: string;
  units: number;
  rebate: string;
  leaf: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const KINDS = new Set(["perf", "fix", "slim"]);

function parseAmount(v: unknown, what = "amount"): bigint {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v !== "string" || !/^\d+$/.test(v)) throw bad("bad_amount", `${what} must be a non-negative integer string`);
  return BigInt(v);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const strArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export class Core {
  readonly db: Database;
  readonly ledger: Ledger;
  readonly blobs: BlobStore;
  readonly cfg: NetworkConfig;
  readonly clock: Clock;
  readonly adminId: string;
  readonly runtimeId?: string;
  readonly beaconBucketS: number;
  readonly nonceWindowMs: number;
  readonly maxBlobBytes: number;
  private randomHex: (n: number) => string;
  private pendingEvents: { type: string; data: unknown; id: number; at: number }[] = [];
  private listeners = new Set<(e: CoreEvent) => void>();
  private depth = 0;
  readonly live: Live;
  /** Canary scheduling, unbond involvement, twin candidates, audit fallback (src/hardening.ts). */
  readonly hardening: Hardening;
  /** Author-blind replay, intents and teams (src/collab.ts). */
  readonly collab: Collab;
  /** Agent signing keys: rotation and revocation (src/identity.ts). */
  readonly identity: Identity;
  /** Reputation records and contribution leaves per epoch (src/records.ts). */
  readonly records: Records;
  /** Stacked series: depends_on, waiting, release onto the tip (src/series.ts, SPEC 12.4). */
  readonly series: Series;
  /** Signed agent messages and lineage boards (src/messages.ts, SPEC 12.3). */
  readonly messages: Messages;
  /** Hosted runtime: provenance records and usage record reads (src/hosted.ts). */
  readonly hosted: Hosted;
  /** Measured split of team candidates (src/split.ts, SPEC 12.6). */
  readonly split: Split;
  /** Cross-lineage ports (src/ports.ts, SPEC 12.7). */
  readonly ports: Ports;
  /** Key that signs credentials (chain mode: the Core authority, set by ChainBridge); null: unsigned. */
  issuerKey: { id: string; secret: Uint8Array } | null = null;
  readonly chainMode: boolean;
  /** Set by ChainBridge in chain mode: the last chain read, for /v1/stats and /v1/chain. */
  chainView: (() => unknown) | null = null;
  /** Set by ChainBridge: run one chain sync now (POST /v1/admin/chain/sync). */
  chainSync: (() => Promise<unknown>) | null = null;
  /** M2 slot-hash beacon (src/beacon.ts); null: the M1 beacon. */
  readonly slotBeacon: SlotBeacon | null;

  constructor(opts: CoreOptions) {
    this.cfg = opts.network;
    this.clock = opts.clock;
    this.adminId = opts.adminId;
    this.runtimeId = opts.runtimeId;
    this.beaconBucketS = opts.beaconBucketS ?? 60;
    this.nonceWindowMs = opts.nonceWindowMs ?? 5 * 60_000;
    this.maxBlobBytes = opts.maxBlobBytes ?? 32 * 1024 * 1024;
    this.randomHex = opts.randomHex ?? ((n) => randomBytes(n).toString("hex"));
    this.db = openDb(join(opts.dataDir, "core.db"));
    this.blobs = new BlobStore(join(opts.dataDir, "blobs"));
    this.ledger = new Ledger(this.db, () => this.clock.now());
    this.live = new Live(this, opts.trees ?? null);
    this.hardening = new Hardening(this);
    this.collab = new Collab(this);
    this.series = new Series(this);
    this.messages = new Messages(this);
    this.chainMode = !!opts.chainMode;
    this.slotBeacon = opts.slotBeacon ? new SlotBeacon(this, opts.slotBeacon) : null;
    this.identity = new Identity(this);
    this.records = new Records(this);
    this.hosted = new Hosted(this);
    this.split = new Split(this);
    this.ports = new Ports(this);
    this.tx(() => {
      if (!this.db.query("SELECT n FROM epochs LIMIT 1").get()) this.openEpoch(opts.firstEpoch ?? 0, this.now());
    });
  }

  close() {
    this.db.close();
  }

  now(): number {
    return this.clock.now();
  }

  // ---------------------------------------------------------------------------------------------
  // Transactions and events

  /** Runs fn atomically. Nested calls join the outer transaction. Events are published after commit. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.depth++;
    try {
      const out = this.db.transaction(fn)();
      const evs = this.pendingEvents;
      this.pendingEvents = [];
      for (const e of evs) for (const l of this.listeners) l({ id: e.id, at: e.at, type: e.type, data: e.data });
      return out;
    } catch (e) {
      this.pendingEvents = [];
      throw e;
    } finally {
      this.depth--;
    }
  }

  private emit(type: string, data: unknown) {
    const at = this.now();
    const r = this.db.query("INSERT INTO events (at, type, data) VALUES (?, ?, ?)").run(at, type, JSON.stringify(data));
    this.pendingEvents.push({ id: Number(r.lastInsertRowid), at, type, data });
  }

  /** Records an event from a collaborator module (live.ts); same semantics as emit. */
  emitEvent(type: string, data: unknown) {
    this.emit(type, data);
  }

  /** Digest of declared capabilities, as workers send it in heartbeats (SPEC 17.1). */
  capsDigest(caps: unknown): string {
    return H("caps", canonicalJson(caps));
  }

  subscribe(fn: (e: CoreEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Id of the newest event (0 when there is none). */
  lastEventId(): number {
    return this.db.query<{ id: number | null }, []>("SELECT MAX(id) AS id FROM events").get()?.id ?? 0;
  }

  events(since = 0, limit = 1000): CoreEvent[] {
    return this.db
      .query<{ id: number; at: number; type: string; data: string }, [number, number]>("SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?")
      .all(since, limit)
      .map((r) => ({ id: r.id, at: r.at, type: r.type, data: JSON.parse(r.data) }));
  }

  // ---------------------------------------------------------------------------------------------
  // Request nonces (SPEC 17)

  /** Records a request nonce. Nonces start with a millisecond timestamp and are single use per agent. */
  useNonce(agent: string, nonce: string) {
    const m = /^(\d{10,16})(?:[-:.][A-Za-z0-9_-]{0,64})?$/.exec(nonce);
    if (!m) throw new ApiError(401, "bad_nonce", "nonce must be <unix ms>[-<suffix>]");
    const ts = Number(m[1]);
    if (Math.abs(this.now() - ts) > this.nonceWindowMs) throw new ApiError(401, "stale_nonce", "nonce timestamp outside the accepted window");
    const r = this.db.query("INSERT OR IGNORE INTO nonces (agent_id, nonce, at) VALUES (?, ?, ?)").run(agent, nonce, ts);
    if (r.changes === 0) throw new ApiError(401, "replayed_nonce", "nonce already used");
  }

  // ---------------------------------------------------------------------------------------------
  // Lookups

  private agentRow(id: string): AgentRow | null {
    return this.db.query<AgentRow, [string]>("SELECT * FROM agents WHERE agent_id = ?").get(id);
  }
  private mustAgent(id: string): AgentRow {
    const a = this.agentRow(id);
    if (!a) throw forbidden("not_registered", `agent ${id} is not registered`);
    return a;
  }
  private lineageRow(id: string): LineageRow | null {
    return this.db.query<LineageRow, [string]>("SELECT * FROM lineages WHERE lineage_id = ?").get(id);
  }
  private genRow(id: string): GenRow | null {
    return this.db.query<GenRow, [string]>("SELECT * FROM generations WHERE gen_id = ?").get(id);
  }
  private candByCandidateId(id: string): CandRow | null {
    return this.db.query<CandRow, [string]>("SELECT * FROM candidates WHERE candidate_id = ?").get(id);
  }
  private candRow(id: string): CandRow | null {
    return (
      this.db.query<CandRow, [string]>("SELECT * FROM candidates WHERE commit_id = ?").get(id) ?? this.candByCandidateId(id)
    );
  }
  private replayRow(id: string): ReplayRow | null {
    return this.db.query<ReplayRow, [string]>("SELECT * FROM replays WHERE replay_id = ?").get(id);
  }
  private auditRow(id: string): AuditRow | null {
    return this.db.query<AuditRow, [string]>("SELECT * FROM audits WHERE audit_id = ?").get(id);
  }
  private recipeOf(id: string): Recipe {
    const r = this.db.query<{ json: string }, [string]>("SELECT json FROM recipes WHERE recipe_id = ?").get(id);
    if (!r) throw notFound("recipe");
    return JSON.parse(r.json);
  }
  private calibOf(id: string): Calibration {
    const r = this.db.query<{ json: string }, [string]>("SELECT json FROM calibrations WHERE calib_id = ?").get(id);
    if (!r) throw notFound("calibration");
    return JSON.parse(r.json);
  }
  currentEpoch(): EpochRow {
    return this.db.query<EpochRow, []>("SELECT * FROM epochs WHERE status = 'open' ORDER BY n DESC LIMIT 1").get()!;
  }
  private epochRow(n: number): EpochRow | null {
    return this.db.query<EpochRow, [number]>("SELECT * FROM epochs WHERE n = ?").get(n);
  }
  private bondOf(id: string): bigint {
    return this.ledger.balance(ACC.bond(id));
  }
  private openReplaysOf(id: string): number {
    return this.db
      .query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM replays WHERE replayer = ? AND status IN ('assigned','committed')")
      .get(id)!.c;
  }
  private judgeCfg(quorum = this.cfg.quorum) {
    return { quorum, det_tolerance: this.cfg.det_tolerance, bootstrap_resamples: this.cfg.bootstrap_resamples };
  }
  private replayWindowMs(calib: Calibration): number {
    return Math.max(this.cfg.replay_window_min_s, this.cfg.replay_window_factor * calib.median_eval_seconds) * 1000;
  }

  // ---------------------------------------------------------------------------------------------
  // Agents: registration, launches, bonds, compute (SPEC 5.3, 5.4, 13)

  /** Tokenless verifier registration: burns register_burn from the agent wallet. */
  registerVerifier(agent: string, body: unknown) {
    return this.tx(() => {
      this.notOnChain("registration");
      const b = isObj(body) ? body : {};
      if (this.agentRow(agent)) throw conflict("already_registered", "agent already registered");
      const operator = b.operator === undefined || b.operator === null ? null : String(b.operator);
      if (operator !== null && !/^[\w.:-]{1,64}$/.test(operator)) throw bad("bad_operator", "operator must be 1-64 word characters");
      const caps = b.capabilities === undefined || b.capabilities === null ? null : validateCapabilities(b.capabilities);
      const wallet = this.ledger.balance(ACC.wallet(agent));
      if (wallet < this.cfg.register_burn) throw forbidden("insufficient_funds", `register_burn is ${this.cfg.register_burn}, wallet holds ${wallet}`);
      this.ledger.transfer(ACC.wallet(agent), ACC.burned, this.cfg.register_burn, "register_burn", agent);
      this.db
        .query("INSERT INTO agents (agent_id, kind, operator, registered_at, lifecycle, capabilities, capabilities_at) VALUES (?, 'verifier', ?, ?, 'active', ?, ?)")
        .run(agent, operator, this.now(), caps ? canonicalJson(caps) : null, caps ? this.now() : null);
      this.emit("agent.registered", { agent, kind: "verifier", operator, capabilities: caps });
      return this.agentView(agent);
    });
  }

  /**
   * Records an agent token launch (M1 simulation of lineage_launch::launch_agent, SPEC 13.7). No burn:
   * the launch itself prices the identity.
   */
  launchAgent(body: unknown, opts: { shadow?: boolean; fromChain?: boolean } = {}) {
    return this.tx(() => {
      if (!opts.shadow && !opts.fromChain) this.notOnChain("an agent launch");
      if (!isObj(body)) throw bad("bad_body", "object expected");
      const agent = String(body.agent ?? "");
      const mint = String(body.mint ?? "");
      const launcher = String(body.launcher ?? "");
      const target = String(body.target_repo ?? "");
      // SPEC 13.9: token (launcher pasted a GitHub access token), purchased (account bought from our
      // pool at launch), app (our GitHub App, always available). import and provided are the 0.3 names.
      const LEGACY: Record<string, string> = { import: "token", provided: "purchased" };
      const rawMode = String(body.identity_mode ?? "app");
      const mode = LEGACY[rawMode] ?? rawMode;
      const hosted = body.hosted === true;
      const operator = body.operator === undefined || body.operator === null ? null : String(body.operator);
      if (!agent || !mint || !launcher || !target) throw bad("bad_body", "agent, mint, launcher and target_repo are required");
      if (!["token", "purchased", "app"].includes(mode)) throw bad("bad_identity_mode", "identity_mode is token, purchased or app");
      if (this.agentRow(agent)) throw conflict("already_registered", "agent already registered");
      if (this.db.query("SELECT 1 FROM agents WHERE mint = ?").get(mint)) throw conflict("mint_taken", "one agent per mint");
      const url = canonicalUrl(target);
      const rid = repoId(url);
      const active = !!this.db.query("SELECT 1 FROM lineages WHERE repo_id = ? AND status = 'active'").get(rid);
      this.db
        .query(
          `INSERT INTO agents (agent_id, kind, operator, registered_at, mint, launcher, target_repo, target_repo_id, identity_mode, hosted, lifecycle, awake, shadow)
           VALUES (?, 'launched', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        )
        .run(agent, operator, this.now(), mint, launcher, url, rid, mode, hosted ? 1 : 0, active ? "active" : "setting_up", opts.shadow ? 1 : 0);
      // simulated prepaid launch (plan C): the launcher's deposit into the compute vault in the same step
      if (!opts.shadow && !opts.fromChain && body.deposit !== undefined) {
        const s = String(body.deposit);
        if (!/^\d{1,30}$/.test(s)) throw bad("bad_deposit", "deposit is an integer string of base units");
        const dep = BigInt(s);
        prepayOf(this).checkSimDeposit(dep);
        prepayOf(this).record(agent, { mint, launchedAt: Math.floor(this.now() / 1000), signature: null, deposit: dep, woke: true, source: "sim" });
        this.ledger.transfer(ACC.faucet, ACC.compute(agent), dep, "launch_deposit", agent);
      }
      this.refreshAwake(agent);
      this.emit("agent.launched", { agent, mint, launcher, target_repo: url, hosted, identity_mode: mode, lifecycle: active ? "active" : "setting_up" });
      return this.agentView(agent);
    });
  }

  setReference(agent: string, reference: boolean) {
    return this.tx(() => {
      this.mustAgent(agent);
      this.db.query("UPDATE agents SET reference = ? WHERE agent_id = ?").run(reference ? 1 : 0, agent);
      this.emit("agent.reference", { agent, reference });
      this.fillWants();
      return this.agentView(agent);
    });
  }

  /**
   * Declares or replaces an agent's hardware capabilities (SPEC 6.1). Qualifications whose recipe the
   * new capabilities no longer satisfy are revoked, and open qualification assignments for them are
   * cancelled.
   */
  setCapabilities(agent: string, body: unknown) {
    return this.tx(() => {
      this.mustAgent(agent);
      if (!isObj(body)) throw bad("bad_body", "{ capabilities } expected");
      const caps = validateCapabilities(body.capabilities);
      const declared = (this.agentRow(agent) as AgentRow & { chain_caps?: string | null }).chain_caps;
      if (this.chainMode && declared && declared !== ZERO32 && declared !== this.capsDigest(caps))
        throw forbidden("caps_mismatch", `capabilities digest ${this.capsDigest(caps)} differs from the one registered on chain (${declared})`);
      const now = this.now();
      this.db.query("UPDATE agents SET capabilities = ?, capabilities_at = ? WHERE agent_id = ?").run(canonicalJson(caps), now, agent);
      const revoked: string[] = [];
      for (const q of this.db
        .query<QualRow, [string]>("SELECT * FROM qualifications WHERE agent_id = ? AND status IN ('assigned','committed','passed') ORDER BY qual_id")
        .all(agent)) {
        if (satisfies(caps, this.recipeOf(q.recipe_id).requires)) continue;
        const status = q.status === "passed" ? "revoked" : "cancelled";
        this.db
          .query("UPDATE qualifications SET status = ?, reason = ?, resolved_at = ? WHERE qual_id = ?")
          .run(status, "declared capabilities no longer satisfy the recipe", now, q.qual_id);
        revoked.push(q.lineage_id);
      }
      this.emit("agent.capabilities", { agent, capabilities: caps, revoked });
      this.fillWants();
      return this.agentView(agent);
    });
  }

  bond(agent: string, body: unknown) {
    return this.tx(() => {
      this.notOnChain("bonding");
      const a = this.mustAgent(agent);
      const amount = parseAmount(isObj(body) ? body.amount : undefined);
      if (amount === 0n) throw bad("bad_amount", "amount must be positive");
      if (a.hosted) throw forbidden("hosted", "hosted agents are never eligible to verify, so they cannot bond");
      const bal = this.ledger.balance(ACC.wallet(agent));
      if (bal < amount) throw forbidden("insufficient_funds", `wallet holds ${bal}`);
      this.ledger.transfer(ACC.wallet(agent), ACC.bond(agent), amount, "bond", agent);
      this.db.query("INSERT INTO bonds (agent_id, action, amount, at) VALUES (?, 'bond', ?, ?)").run(agent, amount.toString(), this.now());
      this.emit("agent.bonded", { agent, amount: amount.toString(), bond: this.bondOf(agent).toString() });
      this.fillWants();
      return this.agentView(agent);
    });
  }

  /** Starts the cooldown. The agent is not assignable while cooling but stays slashable. */
  unbond(agent: string, body: unknown) {
    return this.tx(() => {
      this.notOnChain("unbonding");
      const a = this.mustAgent(agent);
      const amount = parseAmount(isObj(body) ? body.amount : undefined);
      if (amount === 0n) throw bad("bad_amount", "amount must be positive");
      if (BigInt(a.unbond_amount) > 0n) throw conflict("already_cooling", "an unbond request is already pending");
      const bond = this.bondOf(agent);
      if (bond < amount) throw forbidden("insufficient_bond", `bond is ${bond}`);
      const ready = this.now() + this.cfg.unbond_cooldown_s * 1000;
      this.db.query("UPDATE agents SET unbond_amount = ?, unbond_ready_at = ? WHERE agent_id = ?").run(amount.toString(), ready, agent);
      this.db
        .query("INSERT INTO bonds (agent_id, action, amount, at, ready_at) VALUES (?, 'unbond_request', ?, ?, ?)")
        .run(agent, amount.toString(), this.now(), ready);
      this.emit("agent.cooling", { agent, amount: amount.toString(), ready_at: ready });
      return this.agentView(agent);
    });
  }

  private matureUnbonds() {
    if (this.chainMode) return; // withdraw_unbonded moves the tokens on chain; the bond mirror follows
    // the cooldown counts from the last resolved involvement (SPEC 13.6, src/hardening.ts)
    this.hardening.matureUnbonds((id) => this.releaseUnbond(this.agentRow(id)!));
  }

  private releaseUnbond(a: AgentRow) {
    // slashes during the cooldown come out of the same bond
    const amount = [BigInt(a.unbond_amount), this.bondOf(a.agent_id)].reduce((x, y) => (x < y ? x : y));
    this.ledger.transfer(ACC.bond(a.agent_id), ACC.wallet(a.agent_id), amount, "unbond", a.agent_id);
    this.db.query("UPDATE agents SET unbond_amount = '0', unbond_ready_at = NULL WHERE agent_id = ?").run(a.agent_id);
    this.db.query("INSERT INTO bonds (agent_id, action, amount, at) VALUES (?, 'unbond_release', ?, ?)").run(a.agent_id, amount.toString(), this.now());
    this.emit("agent.unbonded", { agent: a.agent_id, amount: amount.toString() });
  }

  faucet(body: unknown) {
    return this.tx(() => {
      if (!isObj(body)) throw bad("bad_body", "object expected");
      const agent = String(body.agent ?? "");
      if (!agent) throw bad("bad_body", "agent required");
      const amount = parseAmount(body.amount);
      this.ledger.transfer(ACC.faucet, ACC.wallet(agent), amount, "faucet", agent);
      this.emit("ledger.faucet", { agent, amount: amount.toString() });
      return { agent, wallet: this.ledger.balance(ACC.wallet(agent)).toString() };
    });
  }

  private splitTreasury(amount: bigint, ref: string) {
    const reserve = (amount * BigInt(this.cfg.reserve_bps)) / 10_000n;
    const pool = (amount * BigInt(this.cfg.pool_bps)) / 10_000n;
    this.ledger.transfer(ACC.treasury, ACC.reserve, reserve, "treasury_split", ref);
    this.ledger.transfer(ACC.treasury, ACC.pool, pool, "treasury_split", ref);
    return { reserve, pool };
  }

  /** $LINE creator rewards (SPEC 13.1): into the treasury, then split reserve_bps and pool_bps. */
  creatorRewards(body: unknown) {
    return this.tx(() => {
      this.notOnChain("creator rewards");
      const amount = parseAmount(isObj(body) ? body.amount : undefined);
      const ref = `creator:${this.now()}`;
      this.ledger.transfer(ACC.faucet, ACC.treasury, amount, "creator_rewards", ref);
      const s = this.splitTreasury(amount, ref);
      this.emit("ledger.creator_rewards", { amount: amount.toString(), reserve: s.reserve.toString(), pool: s.pool.toString() });
      return { amount: amount.toString(), reserve: s.reserve.toString(), pool: s.pool.toString(), treasury: this.ledger.balance(ACC.treasury).toString() };
    });
  }

  /** Agent token trading fees arriving (simulated crank_fees, SPEC 13.7). */
  agentFees(body: unknown, opts: { shadow?: boolean } = {}) {
    return this.tx(() => {
      if (!opts.shadow) this.notOnChain("agent token fees (crank_fees)");
      if (!isObj(body)) throw bad("bad_body", "object expected");
      const agent = String(body.agent ?? "");
      const a = this.mustAgent(agent);
      if (a.kind !== "launched") throw bad("not_launched", "only launched agents have a token");
      const amount = parseAmount(body.amount);
      const compute = (amount * BigInt(this.cfg.agent_compute_bps)) / 10_000n;
      const protocol = (amount * BigInt(this.cfg.protocol_bps)) / 10_000n;
      const ref = `fees:${agent}:${this.now()}`;
      this.ledger.transfer(ACC.faucet, ACC.compute(agent), compute, "agent_fees", ref);
      this.ledger.transfer(ACC.faucet, ACC.treasury, protocol, "agent_fees", ref);
      const s = this.splitTreasury(protocol, ref);
      this.refreshAwake(agent);
      this.emit("ledger.agent_fees", { agent, amount: amount.toString(), compute: compute.toString(), protocol: protocol.toString() });
      return {
        agent,
        compute: compute.toString(),
        protocol: protocol.toString(),
        reserve: s.reserve.toString(),
        pool: s.pool.toString(),
        compute_balance: this.ledger.balance(ACC.compute(agent)).toString(),
        awake: !!this.agentRow(agent)!.awake,
      };
    });
  }

  /** Hosted runtime usage debit: compute vault to reserve, with a public usage record. */
  usage(body: unknown) {
    return this.tx(() => {
      this.notOnChain("compute usage (debit_compute)");
      if (!isObj(body)) throw bad("bad_body", "object expected");
      const agent = String(body.agent ?? "");
      this.mustAgent(agent);
      const amount = parseAmount(body.amount);
      // hosted runtime records are idempotent by `ref` (a crashed runtime reposts the same record)
      if (body.ref !== undefined && body.ref !== null && (typeof body.ref !== "string" || body.ref.length > 200)) throw bad("bad_ref", "ref is a string of at most 200 characters");
      const ref = body.ref === undefined || body.ref === null ? null : body.ref;
      const seen = ref ? this.hosted.usageByRef(ref) : null;
      if (seen) {
        if (seen.agent_id !== agent || seen.amount !== amount.toString()) throw conflict("usage_ref_reused", "this ref was posted with a different agent or amount");
        return { usage_id: seen.id, duplicate: true, compute_balance: this.ledger.balance(ACC.compute(agent)).toString(), awake: !!this.agentRow(agent)!.awake };
      }
      const bal = this.ledger.balance(ACC.compute(agent));
      if (bal < amount) throw forbidden("insufficient_compute", `compute vault holds ${bal}`);
      const tokens = body.model_tokens === undefined ? null : Number(body.model_tokens);
      const secs = body.sandbox_seconds === undefined ? null : Number(body.sandbox_seconds);
      // NaN or negative figures went into public usage records as is (audit A2, OFF-14)
      if ((tokens !== null && !(Number.isSafeInteger(tokens) && tokens >= 0)) || (secs !== null && !(Number.isFinite(secs) && secs >= 0)))
        throw bad("bad_usage", "model_tokens is a non-negative integer and sandbox_seconds a non-negative number");
      const note = body.note === undefined ? null : String(body.note).slice(0, 500);
      const epoch = this.currentEpoch().n;
      const detail = body.detail === undefined || body.detail === null ? null : canonicalJson(body.detail).slice(0, 4000);
      const r = this.db
        .query("INSERT INTO usage (agent_id, amount, model_tokens, sandbox_seconds, note, epoch, at, ref, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(agent, amount.toString(), tokens, secs, note, epoch, this.now(), ref, detail);
      this.ledger.transfer(ACC.compute(agent), ACC.reserve, amount, "usage", `usage:${r.lastInsertRowid}`);
      this.refreshAwake(agent);
      this.emit("agent.usage", { agent, amount: amount.toString(), model_tokens: tokens, sandbox_seconds: secs });
      return { usage_id: Number(r.lastInsertRowid), compute_balance: this.ledger.balance(ACC.compute(agent)).toString(), awake: !!this.agentRow(agent)!.awake };
    });
  }

  /** Sleep and wake hysteresis on the compute vault (SPEC 13.7). */
  private refreshAwake(agent: string) {
    const a = this.agentRow(agent);
    if (!a || a.kind !== "launched") return;
    const bal = this.ledger.balance(ACC.compute(agent));
    let awake = a.awake;
    if (awake && bal < this.cfg.sleep_threshold) awake = 0;
    // an underfunded prepaid launch wakes only once its vault holds the minimum deposit (plan C)
    else if (!awake && bal >= prepayOf(this).wakeThreshold(agent, this.cfg.wake_threshold)) awake = 1;
    if (awake !== a.awake) {
      this.db.query("UPDATE agents SET awake = ? WHERE agent_id = ?").run(awake, agent);
      this.emit(awake ? "agent.awake" : "agent.asleep", { agent, compute: bal.toString() });
    }
  }

  private strike(agent: string, reason: string, ref: string) {
    const a = this.agentRow(agent);
    if (!a || a.reference) return; // the reference runner is Core itself (SPEC 3)
    const epoch = this.currentEpoch().n;
    this.db.query("INSERT INTO strikes (agent_id, epoch, reason, ref, at) VALUES (?, ?, ?, ?, ?)").run(agent, epoch, reason, ref, this.now());
    const n = this.db.query<{ c: number }, [string, number]>("SELECT COUNT(*) AS c FROM strikes WHERE agent_id = ? AND epoch = ?").get(agent, epoch)!.c;
    this.emit("agent.strike", { agent, reason, ref, strikes_this_epoch: n });
    if (n >= this.cfg.strike_limit && a.suspended_through_epoch < epoch + 1) {
      this.db.query("UPDATE agents SET suspended_through_epoch = ? WHERE agent_id = ?").run(epoch + 1, agent);
      this.emit("agent.suspended", { agent, through_epoch: epoch + 1 });
    }
  }

  private slash(agent: string, bps: number, reason: string, ref: string): bigint {
    const a = this.agentRow(agent);
    if (!a || a.reference) return 0n;
    const amount = (this.bondOf(agent) * BigInt(bps)) / 10_000n;
    this.ledger.transfer(ACC.bond(agent), ACC.reserve, amount, `slash:${reason}`, ref);
    this.db
      .query("INSERT INTO slashes (agent_id, bps, amount, reason, ref, epoch, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(agent, bps, amount.toString(), reason, ref, this.currentEpoch().n, this.now());
    this.emit("agent.slashed", { agent, reason, ref, bps, amount: amount.toString() });
    return amount;
  }

  /** Verifier eligibility (SPEC 5.4, 10.3), before per-candidate exclusions. */
  private isEligible(a: AgentRow, epoch: number, ignoreLoad = false): boolean {
    return (
      !a.shadow &&
      !a.reference &&
      !a.hosted &&
      a.unbond_amount === "0" &&
      a.suspended_through_epoch < epoch &&
      this.bondOf(a.agent_id) >= this.cfg.min_bond &&
      (ignoreLoad || this.openReplaysOf(a.agent_id) < this.cfg.max_open_replays)
    );
  }

  private capsOf(a: AgentRow): Capabilities | null {
    return a.capabilities ? (JSON.parse(a.capabilities) as Capabilities) : null;
  }

  private hasPassedQualification(agent: string, lineage: string): boolean {
    return !!this.db.query("SELECT 1 FROM qualifications WHERE agent_id = ? AND lineage_id = ? AND status = 'passed'").get(agent, lineage);
  }

  /**
   * Eligible for a lineage (SPEC 6.1, 10.3): generally eligible, declared capabilities satisfy the
   * recipe's requirements, and a passed qualification for the lineage.
   */
  private eligibleFor(a: AgentRow, epoch: number, lineage: LineageRow, recipe: Recipe): boolean {
    return this.isEligible(a, epoch) && satisfies(this.capsOf(a), recipe.requires) && this.hasPassedQualification(a.agent_id, lineage.lineage_id);
  }

  private eligiblePool(excludeAgents: Set<string>, excludeOperators: Set<string>, lineage: LineageRow): Eligible[] {
    const epoch = this.currentEpoch().n;
    const recipe = this.recipeOf(lineage.recipe_id);
    return this.db
      .query<AgentRow, []>("SELECT * FROM agents ORDER BY agent_id")
      .all()
      .filter((a) => !excludeAgents.has(a.agent_id) && !(a.operator && excludeOperators.has(a.operator)) && this.eligibleFor(a, epoch, lineage, recipe))
      .map((a) => ({ agent: a.agent_id, bond: this.bondOf(a.agent_id), operator: a.operator ?? undefined }));
  }

  // ---------------------------------------------------------------------------------------------
  // Lineage setup (SPEC 6, 12)

  addRecipe(body: unknown) {
    return this.tx(() => {
      if (!isObj(body) || !isObj(body.recipe)) throw bad("bad_body", "{ recipe } expected");
      const recipe = body.recipe as unknown as Recipe;
      validateRecipe(recipe);
      const id = recipeId(recipe);
      if (body.recipe_id !== undefined && body.recipe_id !== id) throw bad("recipe_id_mismatch", `recipe_id recomputes to ${id}`);
      const existed = !!this.db.query("SELECT 1 FROM recipes WHERE recipe_id = ?").get(id);
      if (!existed) {
        this.db.query("INSERT INTO recipes (recipe_id, name, json, created_at) VALUES (?, ?, ?, ?)").run(id, recipe.name, canonicalJson(recipe), this.now());
        this.emit("recipe.added", { recipe_id: id, name: recipe.name });
      }
      return { recipe_id: id, created: !existed };
    });
  }

  addSnapshot(body: unknown) {
    return this.tx(() => {
      if (!isObj(body)) throw bad("bad_body", "object expected");
      const repo = String(body.repo ?? "");
      const commit = String(body.commit ?? "");
      const deps = String(body.deps_digest ?? "");
      if (!repo || !/^[0-9a-fA-F]{7,64}$/.test(commit) || !deps) throw bad("bad_body", "repo, commit (hex sha) and deps_digest required");
      const url = canonicalUrl(repo);
      const rid = repoId(url);
      const sid = snapshotId(rid, commit, deps);
      this.db.query("INSERT OR IGNORE INTO repos (repo_id, url, created_at) VALUES (?, ?, ?)").run(rid, url, this.now());
      const existed = !!this.db.query("SELECT 1 FROM snapshots WHERE snapshot_id = ?").get(sid);
      if (!existed) {
        this.db
          .query("INSERT INTO snapshots (snapshot_id, repo_id, commit_sha, deps_digest, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(sid, rid, commit.toLowerCase(), deps, this.now());
        this.emit("snapshot.added", { snapshot_id: sid, repo_id: rid, repo: url, commit: commit.toLowerCase() });
      }
      return { snapshot_id: sid, repo_id: rid, created: !existed };
    });
  }

  /**
   * A reference agent submits a calibration (SPEC 6). body.sig is the agent's signature over the
   * calib_id (signMessage), so the record stays verifiable outside this request. Creates the lineage
   * with gen_0 and its automatic findings.
   */
  submitCalibration(agent: string, body: unknown, consensus = false) {
    return this.tx(() => {
      // consensus: an agent-proposed recipe whose calibration replays agreed (recipe-proposals.ts, SPEC 6.2)
      const a = consensus ? null : this.mustAgent(agent);
      if (a && !a.reference) throw forbidden("not_reference", "only a reference runner may submit calibrations");
      if (!isObj(body) || !isObj(body.calibration) || typeof body.sig !== "string") throw bad("bad_body", "{ calibration, sig } expected");
      const c = body.calibration as unknown as Calibration;
      if (!strArr(c.stable) || !strArr(c.known_failures) || !strArr(c.quarantined) || !isObj(c.metrics))
        throw bad("bad_calibration", "stable, known_failures, quarantined (string arrays) and metrics required");
      if (typeof c.median_eval_seconds !== "number" || !(c.median_eval_seconds > 0)) throw bad("bad_calibration", "median_eval_seconds must be positive");
      if (typeof c.runs !== "number" || c.runs < 1) throw bad("bad_calibration", "runs must be at least 1");
      if (c.stable.length === 0) throw bad("bad_calibration", "empty stable set");
      if (c.seed !== undefined && (typeof c.seed !== "string" || !HEX64.test(c.seed))) throw bad("bad_calibration", "seed must be 64 hex chars");
      const recipe = this.recipeOf(c.recipe_id);
      const snap = this.db
        .query<{ snapshot_id: string; repo_id: string; commit_sha: string }, [string]>("SELECT * FROM snapshots WHERE snapshot_id = ?")
        .get(c.snapshot_id);
      if (!snap) throw notFound("snapshot");
      if (snap.repo_id !== repoId(recipe.repo) || snap.commit_sha !== recipe.commit.toLowerCase())
        throw bad("snapshot_mismatch", "snapshot repo and commit must match the recipe");
      for (const m of recipe.metrics) if (!isObj(c.metrics[m.name])) throw bad("bad_calibration", `metric ${m.name} missing from calibration`);
      const cid = calibId(c.recipe_id, c.snapshot_id, c);
      if (!consensus && !verifyMessage(this.identity.signingKey(agent) ?? agent, body.sig, cid)) throw forbidden("bad_signature", "sig must sign the calib_id");
      const lid = lineageId(c.snapshot_id, c.recipe_id);
      if (this.lineageRow(lid)) throw conflict("lineage_exists", "lineage already calibrated");
      const now = this.now();
      const epoch = this.currentEpoch().n;
      this.db
        .query("INSERT INTO calibrations (calib_id, recipe_id, snapshot_id, json, submitted_by, sig, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(cid, c.recipe_id, c.snapshot_id, canonicalJson(c), agent, body.sig, now);
      const g0 = gen0(lid);
      this.db
        .query(
          "INSERT INTO lineages (lineage_id, repo_id, snapshot_id, recipe_id, calib_id, gen0, tip, height, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active', ?)",
        )
        .run(lid, snap.repo_id, c.snapshot_id, c.recipe_id, cid, g0, g0, now);
      this.db
        .query("INSERT INTO generations (gen_id, lineage_id, parent_gen_id, height, entry_type, accepted_at, epoch) VALUES (?, ?, NULL, 0, 'genesis', ?, ?)")
        .run(g0, lid, now, epoch);
      const fins: { kind: string; target: string }[] = [
        ...c.known_failures.map((t) => ({ kind: "known_failure", target: t })),
        ...recipe.metrics.filter((m) => c.metrics[m.name]?.enabled).map((m) => ({ kind: "metric_target", target: m.name })),
      ];
      for (const f of fins) this.insertFinding(lid, g0, f.kind, f.target, null);
      const activated = this.db
        .query<{ agent_id: string }, [string]>("SELECT agent_id FROM agents WHERE target_repo_id = ? AND lifecycle = 'setting_up'")
        .all(snap.repo_id);
      this.db.query("UPDATE agents SET lifecycle = 'active' WHERE target_repo_id = ? AND lifecycle = 'setting_up'").run(snap.repo_id);
      this.emit("lineage.created", { lineage_id: lid, recipe_id: c.recipe_id, snapshot_id: c.snapshot_id, calib_id: cid, gen0: g0, findings: fins.length });
      for (const x of activated) this.emit("agent.active", { agent: x.agent_id, lineage_id: lid });
      return { lineage_id: lid, calib_id: cid, gen0: g0, findings: fins.length };
    });
  }

  private insertFinding(lineage: string, tip: string, kind: string, target: string, finder: string | null): string {
    const id = H("finding", lineage, tip, kind, target);
    const r = this.db
      .query("INSERT OR IGNORE INTO findings (finding_id, lineage_id, kind, target, tip, finder, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)")
      .run(id, lineage, kind, target, tip, finder, this.now());
    if (r.changes) this.emit("finding.opened", { finding_id: id, lineage_id: lineage, kind, target, finder });
    return id;
  }

  /** Admin-recorded finding with a finder (M1 stand-in for verified agent findings, SPEC 12). */
  /**
   * Retires (or reactivates) a lineage. A retired lineage takes no new candidates and draws no new
   * qualifications; open candidates finish normally and its history stays public.
   */
  setLineageStatus(id: string, body: unknown) {
    return this.tx(() => {
      const l = this.lineageRow(id);
      if (!l) throw notFound("lineage");
      const status = isObj(body) ? String(body.status ?? "") : "";
      if (status !== "retired" && status !== "active") throw bad("bad_status", "status is retired or active");
      this.db.query("UPDATE lineages SET status = ? WHERE lineage_id = ?").run(status, id);
      if (status === "retired") {
        // open work on a retired lineage closes cleanly: verifiers may no longer hold its recipe,
        // so leaving it assigned would only produce abandoned assignments and unfair strikes
        const now = this.now();
        for (const c of this.db
          .query<CandRow, [string]>(`SELECT * FROM candidates WHERE lineage_id = ? AND status IN (${OPEN_STATUSES.map((x) => `'${x}'`).join(",")})`)
          .all(id))
          this.finalizeCandidate(c, "rejected", "lineage_retired", "the lineage was retired before this candidate was judged", null);
        this.db
          .query("UPDATE qualifications SET status = 'cancelled', reason = 'lineage retired', resolved_at = ? WHERE lineage_id = ? AND status IN ('assigned','committed')")
          .run(now, id);
        this.db
          .query("UPDATE replays SET status = 'cancelled' WHERE status IN ('assigned','committed') AND candidate_id IN (SELECT candidate_id FROM candidates WHERE lineage_id = ?)")
          .run(id);
      }
      this.emit("lineage.status", { lineage_id: id, status });
      return { lineage_id: id, status };
    });
  }

  addFinding(body: unknown) {
    return this.tx(() => {
      if (!isObj(body)) throw bad("bad_body", "object expected");
      const l = this.lineageRow(String(body.lineage_id ?? ""));
      if (!l) throw notFound("lineage");
      const kind = String(body.kind ?? "");
      const target = String(body.target ?? "");
      if (!["known_failure", "metric_target", "hotspot"].includes(kind) || !target) throw bad("bad_body", "kind and target required");
      const finder = body.finder === undefined || body.finder === null ? null : String(body.finder);
      if (finder) this.mustAgent(finder);
      // a finder-attributed finding replaces an automatic one with the same key
      const id = H("finding", l.lineage_id, l.tip, kind, target);
      this.db.query("DELETE FROM findings WHERE finding_id = ? AND finder IS NULL AND status = 'open'").run(id);
      this.insertFinding(l.lineage_id, l.tip, kind, target, finder);
      return { finding_id: id };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Canaries (SPEC 10.5)

  addCanary(body: unknown) {
    return this.tx(() => {
      if (!isObj(body)) throw bad("bad_body", "object expected");
      const l = this.lineageRow(String(body.lineage_id ?? ""));
      if (!l) throw notFound("lineage");
      const kind = String(body.kind ?? "") as CandidateKind;
      if (!KINDS.has(kind)) throw bad("bad_kind", "kind is perf, fix or slim");
      const target = normTarget(kind, body.target);
      const expected = String(body.expected_reason ?? "");
      if (!expected) throw bad("bad_body", "expected_reason required");
      let patch: string;
      try {
        patch = canonicalizeDiff(String(body.patch ?? ""));
      } catch (e) {
        throw bad("malformed_patch", String((e as Error).message));
      }
      const recipe = this.recipeOf(l.recipe_id);
      const g = guard(patch, recipe.patch);
      if (!g.ok) throw bad("canary_guard", `canary must pass the static guard to reach replayers (${g.violation}: ${g.detail})`);
      const ph = patchHash(patch);
      const id = H("canary", l.lineage_id, ph, kind, canonicalJson(target));
      const r = this.db
        .query("INSERT OR IGNORE INTO canaries (canary_id, lineage_id, patch, patch_hash, kind, target, expected_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, l.lineage_id, patch, ph, kind, JSON.stringify(target), expected, this.now());
      if (r.changes) this.hardening.planShadows();
      return { canary_id: id, patch_hash: ph, created: r.changes > 0 };
    });
  }

  listCanaries(lineage?: string) {
    const rows = lineage
      ? this.db.query<CanaryRow, [string]>("SELECT * FROM canaries WHERE lineage_id = ? ORDER BY created_at").all(lineage)
      : this.db.query<CanaryRow, []>("SELECT * FROM canaries ORDER BY created_at").all();
    return rows.map((r) => ({ ...r, target: JSON.parse(r.target) }));
  }

  // ---------------------------------------------------------------------------------------------
  // Candidates (SPEC 5.1, 10.4)

  commitCandidate(author: string, body: unknown) {
    return this.tx(() => this.commitCandidateInner(author, body, {}));
  }

  private commitCandidateInner(author: string, body: unknown, opts: { canary?: string }) {
    const a = this.mustAgent(author);
    if (!isObj(body)) throw bad("bad_body", "object expected");
    if (a.kind !== "launched") throw forbidden("not_an_author", "only launched agents author candidates (SPEC 3); verifiers replay");
    if (a.lifecycle !== "active") throw forbidden("setting_up", "agent target is not calibrated yet");
    if (!a.awake) throw forbidden("asleep", "agent compute vault is below the wake threshold");
    const l = this.lineageRow(String(body.lineage_id ?? ""));
    if (!l) throw notFound("lineage");
    if (l.status !== "active") throw forbidden("lineage_inactive", "lineage is not active");
    if (l.repo_id !== a.target_repo_id) throw forbidden("wrong_target", "agent may only author on lineages of its target repository");
    const parent = this.genRow(String(body.parent_gen_id ?? ""));
    if (!parent || parent.lineage_id !== l.lineage_id) throw bad("bad_parent", "parent_gen_id is not a generation of this lineage");
    const kind = String(body.kind ?? "") as CandidateKind;
    if (!KINDS.has(kind)) throw bad("bad_kind", "kind is perf, fix or slim");
    const target = normTarget(kind, body.target);
    const commitment = String(body.commitment ?? "");
    if (!HEX64.test(commitment)) throw bad("bad_commitment", "commitment must be 64 hex chars");
    const claimed = body.claimed_effect === undefined || body.claimed_effect === null ? null : Number(body.claimed_effect);
    if (claimed !== null && !Number.isFinite(claimed)) throw bad("bad_claimed_effect", "claimed_effect must be a number");
    const open = this.db
      .query<{ c: number }, [string, string]>(
        `SELECT COUNT(*) AS c FROM candidates WHERE author = ? AND lineage_id = ? AND status IN (${OPEN_STATUSES.map((s) => `'${s}'`).join(",")})`,
      )
      .get(author, l.lineage_id)!.c;
    if (open >= this.cfg.max_open_candidates_per_agent)
      throw new ApiError(429, "too_many_open", `max_open_candidates_per_agent is ${this.cfg.max_open_candidates_per_agent}`);
    const commit_id = H("cand-commit", author, commitment);
    if (this.db.query("SELECT 1 FROM candidates WHERE commit_id = ?").get(commit_id)) throw conflict("duplicate_commit", "commitment already used");
    // a team candidate: every member signed this commitment and split (SPEC 12.2)
    // a stacked candidate (SPEC 12.4): depends on a pending candidate, held until that one is final
    const dep = this.series.parse(l.lineage_id, body.depends_on);
    const team = this.collab.checkTeam(author, { lineage_id: l.lineage_id, parent_gen_id: parent.gen_id, commitment, kind, target, depends_on: dep?.dep.commit_id ?? null, split: this.split.parse(body.team), ported_from: typeof body.ported_from === "string" ? body.ported_from : null }, body.team);
    const now = this.now();
    const deadline = now + this.cfg.reveal_window_s * 1000;
    this.db
      .query(
        `INSERT INTO candidates (commit_id, lineage_id, parent_gen_id, eval_parent_gen_id, author, kind, target, claimed_effect, commitment, status, committed_at, reveal_deadline, is_canary, canary_id, epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?, ?, ?, ?, ?)`,
      )
      .run(commit_id, l.lineage_id, parent.gen_id, parent.gen_id, author, kind, JSON.stringify(target), claimed, commitment, now, deadline, opts.canary ? 1 : 0, opts.canary ?? null, this.currentEpoch().n);
    // the author's open intents on this target now point at it, privately until it is final (SPEC 12.1)
    if (team) this.collab.storeTeam(commit_id, team);
    // measured split (SPEC 12.6) and declared port (SPEC 12.7)
    this.split.onCommit(commit_id, author, team, l.lineage_id, kind, target, body.team);
    this.ports.onCommit(commit_id, l.lineage_id, body.ported_from);
    if (dep) this.series.committed(commit_id, author, dep, team);
    this.collab.onCommit(team ? team.members.map((m) => m.agent) : [author], l.lineage_id, kind, target, commit_id);
    // no author: who committed an open candidate stays private until it is final (SPEC 10.7)
    this.emit("candidate.committed", { commit_id, lineage_id: l.lineage_id, parent_gen_id: parent.gen_id, kind, target, claimed_effect: claimed });
    return { commit_id, reveal_deadline: deadline, status: "committed" as const };
  }

  revealCandidate(author: string, id: string, body: unknown) {
    return this.tx(() => this.revealCandidateInner(author, id, body));
  }

  private revealCandidateInner(author: string, id: string, body: unknown) {
    const c = this.db.query<CandRow, [string]>("SELECT * FROM candidates WHERE commit_id = ?").get(id);
    if (!c) throw notFound("candidate commit");
    if (c.author !== author) throw forbidden("not_author", "only the author can reveal");
    if (c.status !== "committed") throw conflict("not_committed", `candidate is ${c.status}`);
    if (this.now() > c.reveal_deadline) {
      this.expire(c);
      throw conflict("expired", "reveal window closed");
    }
    this.series.beforeReveal(c.commit_id);
    if (!isObj(body) || typeof body.patch !== "string" || typeof body.salt !== "string") throw bad("bad_body", "{ patch, salt } expected");
    const salt = body.salt;
    let canonical: string | null = null;
    try {
      canonical = canonicalizeDiff(body.patch);
    } catch {
      canonical = null;
    }
    const l = this.lineageRow(c.lineage_id)!;
    const recipe = this.recipeOf(l.recipe_id);
    const now = this.now();
    if (canonical === null) {
      // the commitment must still bind: authors commit to the hash of the bytes they reveal
      if (patchCommitment(patchHash(body.patch), salt) !== c.commitment) throw bad("commitment_mismatch", "patch and salt do not match the commitment");
      this.db
        .query("UPDATE candidates SET patch = ?, salt = ?, patch_hash = ?, revealed_at = ? WHERE commit_id = ?")
        .run(body.patch, salt, patchHash(body.patch), now, c.commit_id);
      this.finalizeCandidate(this.candRow(c.commit_id)!, "rejected", "guard", "MALFORMED: patch is not a parseable diff", null);
      return this.candidateView(c.commit_id, author);
    }
    const ph = patchHash(canonical);
    if (patchCommitment(ph, salt) !== c.commitment) throw bad("commitment_mismatch", "patch and salt do not match the commitment (patch_hash covers the canonical diff)");
    this.split.onReveal(c, body, salt);
    const target = JSON.parse(c.target) as string | string[];
    // the id hashes an author tag, not the author: a replayer holding the patch cannot test agent ids (SPEC 4, 10.7)
    const cid = candidateId({ lineage_id: c.lineage_id, parent_gen_id: c.parent_gen_id, patch_hash: ph, author: this.collab.authorTag(author, salt), kind: c.kind, target });
    const again = this.db
      .query<{ c: number }, [string, string, string, string, string, string]>(
        // a stacked candidate that failed only with its dependency may be committed again on another (SPEC 12.4)
        "SELECT COUNT(*) AS c FROM candidates WHERE lineage_id = ? AND parent_gen_id = ? AND author = ? AND patch_hash = ? AND kind = ? AND target = ? AND candidate_id IS NOT NULL AND (reason IS NULL OR reason != 'dependency_failed')",
      )
      .get(c.lineage_id, c.parent_gen_id, author, ph, c.kind, c.target)!.c;
    if (this.candByCandidateId(cid) || again > 0) {
      this.db.query("UPDATE candidates SET patch = ?, salt = ?, patch_hash = ?, revealed_at = ? WHERE commit_id = ?").run(canonical, salt, ph, now, c.commit_id);
      this.finalizeCandidate(this.candRow(c.commit_id)!, "rejected", "duplicate", "this author already revealed the same candidate", null);
      return this.candidateView(c.commit_id, author);
    }
    const sh = semanticHash(canonical);
    const g = guard(canonical, recipe.patch);
    this.db
      .query("UPDATE candidates SET candidate_id = ?, patch = ?, salt = ?, patch_hash = ?, semantic_hash = ?, guard = ?, revealed_at = ? WHERE commit_id = ?")
      .run(cid, canonical, salt, ph, sh, JSON.stringify(g), now, c.commit_id);
    this.emit("candidate.revealed", { commit_id: c.commit_id, candidate_id: cid, patch_hash: ph, guard: g.ok ? "ok" : g.violation, flags: g.flags });
    const fresh = this.candRow(c.commit_id)!;
    if (!g.ok) {
      this.finalizeCandidate(fresh, "rejected", "guard", `${g.violation}: ${g.detail ?? ""}`.trim(), null);
      return this.candidateView(c.commit_id, author);
    }
    const dup = this.db
      .query<{ gen_id: string }, [string, string, string]>(
        "SELECT gen_id FROM generations WHERE lineage_id = ? AND entry_type = 'patch' AND reverted_by IS NULL AND (patch_hash = ? OR semantic_hash = ?) LIMIT 1",
      )
      .get(c.lineage_id, ph, sh);
    if (dup) {
      this.finalizeCandidate(fresh, "rejected", "duplicate", `same change as accepted generation ${dup.gen_id}`, null);
      return this.candidateView(c.commit_id, author);
    }
    // an earlier commitment owns this change (SPEC 10.4): a copied revealed patch loses at once
    const twin = this.hardening.earlierTwin(fresh, ph, sh);
    if (twin) {
      this.finalizeCandidate(fresh, "rejected", "duplicate", `same change as earlier-committed candidate ${twin.candidate_id ?? twin.commit_id}`, null);
      return this.candidateView(c.commit_id, author);
    }
    // held while the candidate it builds on is open (or a canary held for parity, SPEC 12.4)
    if (this.series.holdAtReveal(fresh)) return this.candidateView(c.commit_id, author);
    this.db.query("UPDATE candidates SET status = 'queued', want_replays = ? WHERE commit_id = ?").run(this.cfg.quorum, c.commit_id);
    this.emit("candidate.queued", { candidate_id: cid, stage: 0 });
    this.fillWants();
    return this.candidateView(c.commit_id, author);
  }

  private expire(c: CandRow) {
    this.db.query("UPDATE candidates SET status = 'expired', reason = 'expired', finalized_at = ? WHERE commit_id = ?").run(this.now(), c.commit_id);
    this.split.onFinal(c);
    this.emit("candidate.expired", { commit_id: c.commit_id });
  }

  private finalizeCandidate(c: CandRow, status: "accepted" | "rejected", reason: CandidateReason | null, detail: string | null, verdict: Judgement | null) {
    this.db
      .query("UPDATE candidates SET status = ?, reason = ?, detail = ?, verdict = ?, finalized_at = ?, want_replays = 0, want_reference = 0 WHERE commit_id = ?")
      .run(status, reason, detail, verdict ? JSON.stringify(verdict) : null, this.now(), c.commit_id);
    // anything still outstanding for this candidate (not audits) is no longer needed
    const open = this.db
      .query<ReplayRow, [string]>("SELECT * FROM replays WHERE candidate_id = ? AND audit_id IS NULL AND status IN ('assigned','committed')")
      .all(c.candidate_id ?? "");
    for (const r of open) this.db.query("UPDATE replays SET status = 'cancelled' WHERE replay_id = ?").run(r.replay_id);
    this.split.onFinal(c);
    this.emit(`candidate.${status}`, { candidate_id: c.candidate_id, commit_id: c.commit_id, reason, detail });
  }

  // ---------------------------------------------------------------------------------------------
  // Assignment (SPEC 10.3, M1 variant)

  /**
   * M1 assignment beacon: H(epoch_secret, subject, round, reveal-time bucket). With the slot beacon
   * (M2, src/beacon.ts) the slot hash replaces the bucket (bucket -1) and the answer is null until
   * that slot is final; the draw then waits for a later tick.
   */
  private beacon(subject: string, round: number): { beacon: string; bucket: number; epoch: EpochRow } | null {
    const ep = this.currentEpoch();
    if (this.slotBeacon) {
      const b = this.slotBeacon.get(subject, round, ep, (n) => this.epochRow(n)!.secret);
      return b ? { beacon: b.beacon, bucket: -1, epoch: this.epochRow(b.epoch)! } : null;
    }
    const bucket = Math.floor(this.now() / 1000 / this.beaconBucketS);
    return { beacon: H("m1-beacon", ep.secret, subject, round, bucket), bucket, epoch: ep };
  }

  /**
   * Reference runners are qualified by definition (they are Core). One that declared capabilities is
   * still only used for recipes those capabilities satisfy.
   */
  private referenceAgents(exclude: Set<string>, lineage?: LineageRow): string[] {
    const req = lineage ? this.recipeOf(lineage.recipe_id).requires : undefined;
    return this.db
      .query<AgentRow, []>("SELECT * FROM agents WHERE reference = 1 ORDER BY agent_id")
      .all()
      .filter((a) => !exclude.has(a.agent_id) && (!a.capabilities || satisfies(this.capsOf(a), req)))
      .map((a) => a.agent_id);
  }

  /** Assigns outstanding replays of every candidate and audit that wants them. */
  fillWants() {
    this.issueQualifications();
    const cands = this.db
      .query<CandRow, []>(
        "SELECT * FROM candidates WHERE (want_replays > 0 OR want_reference > 0) AND status IN ('queued','replaying','disputed') ORDER BY committed_at, commit_id",
      )
      .all();
    // rows are re-read before use: assigning one candidate can inject a canary, which assigns too
    for (const stale of cands) {
      const c = this.candRow(stale.commit_id)!;
      if ((c.want_replays > 0 || c.want_reference > 0) && ["queued", "replaying", "disputed"].includes(c.status)) this.assignCandidate(c);
    }
    const audits = this.db
      .query<AuditRow, []>("SELECT * FROM audits WHERE status = 'pending' AND (want_replays > 0 OR want_reference > 0) ORDER BY created_at")
      .all();
    for (const stale of audits) {
      const a = this.auditRow(stale.audit_id)!;
      if (a.status === "pending" && (a.want_replays > 0 || a.want_reference > 0)) this.assignAudit(a);
    }
  }

  private draw(
    subject: string,
    round: number,
    count: number,
    wantRef: boolean,
    excludeAgents: Set<string>,
    excludeOps: Set<string>,
    requireFull: boolean,
    lineage: LineageRow,
  ): { chosen: string[]; reference: string | null; seed: string; epoch: number } | null {
    const pool = this.eligiblePool(excludeAgents, excludeOps, lineage);
    if (requireFull && pool.length < count) return null;
    const b = this.beacon(subject, round);
    if (!b) return null; // slot beacon: waiting for the slot to be final
    const { beacon, bucket, epoch } = b;
    const seed = assignmentSeed(beacon, subject);
    const chosen = count > 0 ? assignReplayers(seed, pool, Math.min(count, pool.length), { agents: [] }, this.cfg.bond_cap) : [];
    let reference: string | null = null;
    if (wantRef) {
      const refs = this.referenceAgents(new Set([...excludeAgents, ...chosen]), lineage);
      if (refs.length) reference = refs[new Rng(H("m1-ref", seed)).int(refs.length)]!;
    }
    if (!chosen.length && !reference) return null;
    this.db
      .query(
        "INSERT INTO assignment_rounds (subject, round, epoch, bucket, beacon, assignment_seed, pool, exclude, count, chosen, reference, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        subject,
        round,
        epoch.n,
        bucket,
        beacon,
        seed,
        JSON.stringify(pool.map((p) => ({ agent: p.agent, bond: p.bond.toString(), operator: p.operator ?? null }))),
        JSON.stringify({ agents: [...excludeAgents].sort(), operators: [...excludeOps].sort() }),
        count,
        JSON.stringify(chosen),
        reference,
        this.now(),
      );
    // replays belong to the epoch open now; the round keeps the epoch whose secret drew it
    return { chosen, reference, seed, epoch: this.currentEpoch().n };
  }

  private insertReplay(p: {
    candidate: CandRow;
    grp: string;
    audit_id: string | null;
    replayer: string;
    kind: ReplayRow["kind"];
    stage: number;
    round: number;
    eval_parent: string;
    seed: string;
    window: number;
    epoch: number;
  }) {
    const id = H("replay", p.grp, p.round, p.replayer);
    const now = this.now();
    // one shared replay seed per group (candidate stage or audit), fixed by its first round (SPEC 10.3)
    const first = this.db.query<{ seed: string }, [string]>("SELECT seed FROM replays WHERE grp = ? ORDER BY assigned_at, round LIMIT 1").get(p.grp);
    const seed = first?.seed ?? H(p.seed, "replay-seed");
    this.db
      .query(
        `INSERT INTO replays (replay_id, candidate_id, grp, audit_id, replayer, kind, stage, round, eval_parent_gen_id, assignment_seed, seed, status, assigned_at, commit_deadline, epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'assigned', ?, ?, ?)`,
      )
      .run(id, p.candidate.candidate_id!, p.grp, p.audit_id, p.replayer, p.kind, p.stage, p.round, p.eval_parent, p.seed, seed, now, this.queuedDeadline(p.replayer, now) + p.window, p.epoch);
    // the event names only the candidate: who replays it stays private until it is final
    this.emit("replay.assigned", { candidate_id: p.candidate.candidate_id, kind: p.kind === "audit_reference" ? "audit" : p.kind === "reference" ? "replay" : p.kind });
    return id;
  }

  /**
   * Where a new assignment's commit window starts for this replayer: after the latest commit deadline
   * of the work it already holds uncommitted. Workers run jobs one at a time, so a replay assigned
   * while a verifier runs a long one (geth-rlp, about 13 min) otherwise expired before the worker
   * could start it, and an honest verifier took an abandoned strike.
   */
  private queuedDeadline(replayer: string, now: number): number {
    const r = this.db.query<{ d: number | null }, [string]>("SELECT MAX(commit_deadline) AS d FROM replays WHERE replayer = ? AND status = 'assigned'").get(replayer)?.d ?? 0;
    const q = this.db.query<{ d: number | null }, [string]>("SELECT MAX(commit_deadline) AS d FROM qualifications WHERE agent_id = ? AND status = 'assigned'").get(replayer)?.d ?? 0;
    return Math.max(now, r, q);
  }

  private candGroup(c: CandRow) {
    return `cand:${c.candidate_id}:${c.stage}`;
  }

  private assignCandidate(c: CandRow) {
    const grp = this.candGroup(c);
    const existing = this.db.query<ReplayRow, [string]>("SELECT * FROM replays WHERE grp = ?").all(grp);
    const author = this.agentRow(c.author)!;
    // an agent that abandoned this group is left out for the rest of that epoch only (it was struck
    // for it); excluding it for good starved candidates on a small network, where the abandoners were
    // the only verifiers left (site, 2026-10-09: six candidates stuck in replaying)
    const epoch = this.currentEpoch().n;
    const exAgents = new Set([c.author, ...existing.filter((r) => r.status !== "abandoned" || r.epoch >= epoch).map((r) => r.replayer)]);
    const exOps = new Set<string>();
    if (author.operator) exOps.add(author.operator);
    // every team member, their operators and their owners' other agents (SPEC 12.2)
    this.collab.extendExclusion(c, exAgents, exOps);
    this.series.extendExclusion(c, exAgents, exOps);
    for (const r of existing) {
      const op = this.agentRow(r.replayer)?.operator;
      if (op) exOps.add(op);
    }
    const l = this.lineageRow(c.lineage_id)!;
    if (c.want_reference && this.referenceAgents(exAgents, l).length === 0) {
      // no reference runner available: a random replayer takes its place
      this.db.query("UPDATE candidates SET want_reference = 0, want_replays = want_replays + 1 WHERE commit_id = ?").run(c.commit_id);
      c = this.candRow(c.commit_id)!;
    }
    const initial = existing.length === 0;
    const d = this.draw(c.candidate_id!, c.rounds, c.want_replays, !!c.want_reference, exAgents, exOps, initial, l);
    if (!d) return;
    const calib = this.calibOf(l.calib_id);
    const window = this.replayWindowMs(calib);
    const base = { candidate: c, grp, audit_id: null, stage: c.stage, round: c.rounds, eval_parent: c.eval_parent_gen_id, seed: d.seed, window, epoch: d.epoch };
    for (const r of d.chosen) this.insertReplay({ ...base, replayer: r, kind: "replay" });
    if (d.reference) this.insertReplay({ ...base, replayer: d.reference, kind: "reference" });
    this.db
      .query(
        "UPDATE candidates SET want_replays = want_replays - ?, want_reference = ?, rounds = rounds + 1, status = CASE WHEN status = 'disputed' THEN 'disputed' ELSE 'replaying' END WHERE commit_id = ?",
      )
      .run(d.chosen.length, d.reference ? 0 : c.want_reference, c.commit_id);
    // the canary, if any, is committed on a later tick at a random offset (SPEC 10.5)
    if (initial && c.stage === 0 && !c.is_canary) this.hardening.scheduleCanary(c);
  }

  private assignAudit(a: AuditRow) {
    const c = this.candByCandidateId(a.candidate_id)!;
    const gen = this.genRow(a.gen_id)!;
    const grp = `audit:${a.audit_id}`;
    // the audit re-checks the stage that was accepted; replayers of an earlier stage (a rebase measured
    // another parent) may audit, otherwise a rebased generation can run out of auditors
    const original = this.db
      .query<ReplayRow, [string, number]>("SELECT * FROM replays WHERE candidate_id = ? AND audit_id IS NULL AND stage = ?")
      .all(a.candidate_id, c.stage);
    const existing = this.db.query<ReplayRow, [string]>("SELECT * FROM replays WHERE grp = ?").all(grp);
    const author = this.agentRow(c.author)!;
    // the reference runner may audit a generation it also replayed: it is Core, and the audit runs a fresh seed
    const exAgents = new Set([c.author, ...original.filter((r) => r.kind !== "reference").map((r) => r.replayer), ...existing.map((r) => r.replayer)]);
    const exOps = new Set<string>(author.operator ? [author.operator] : []);
    this.collab.extendExclusion(c, exAgents, exOps);
    this.series.extendExclusion(c, exAgents, exOps);
    const l = this.lineageRow(c.lineage_id)!;
    if (a.want_reference && this.referenceAgents(exAgents, l).length === 0) {
      this.db.query("UPDATE audits SET want_reference = 0, want_replays = want_replays + 1 WHERE audit_id = ?").run(a.audit_id);
      a = this.auditRow(a.audit_id)!;
    }
    const d = this.draw(a.audit_id, a.rounds, a.want_replays, !!a.want_reference, exAgents, exOps, false, l);
    if (!d) return;
    const window = this.replayWindowMs(this.calibOf(l.calib_id));
    const base = { candidate: c, grp, audit_id: a.audit_id, stage: c.stage, round: a.rounds, eval_parent: gen.parent_gen_id!, seed: d.seed, window, epoch: d.epoch };
    for (const r of d.chosen) this.insertReplay({ ...base, replayer: r, kind: "audit" });
    if (d.reference) this.insertReplay({ ...base, replayer: d.reference, kind: "audit_reference" });
    this.db
      .query("UPDATE audits SET want_replays = want_replays - ?, want_reference = ?, rounds = rounds + 1 WHERE audit_id = ?")
      .run(d.chosen.length, d.reference ? 0 : a.want_reference, a.audit_id);
  }

  // ---------------------------------------------------------------------------------------------
  // Qualification (SPEC 6.1)

  private qualRow(id: string): QualRow | null {
    return this.db.query<QualRow, [string]>("SELECT * FROM qualifications WHERE qual_id = ?").get(id);
  }

  /** The seed the reference runner calibrated with. Calibrations before 0.8 carry none: M1 workers used H("calibration", snapshot_id). */
  private calibSeed(calib: Calibration): string {
    return typeof calib.seed === "string" && HEX64.test(calib.seed) ? calib.seed : H("calibration", calib.snapshot_id);
  }

  /**
   * Issues a qualification assignment to every generally eligible verifier whose declared
   * capabilities satisfy an active lineage's recipe and that holds no passed or open qualification
   * for it. A failed or expired attempt may be retried after qualify_retry_s.
   */
  private issueQualifications() {
    const epoch = this.currentEpoch().n;
    const lineages = this.db.query<LineageRow, []>("SELECT * FROM lineages WHERE status = 'active' ORDER BY created_at, lineage_id").all();
    if (!lineages.length) return;
    const agents = this.db
      .query<AgentRow, []>("SELECT * FROM agents WHERE capabilities IS NOT NULL ORDER BY agent_id")
      .all()
      .filter((a) => this.isEligible(a, epoch));
    if (!agents.length) return;
    const now = this.now();
    // one open qualification per verifier at a time: workers run them one after another, so issuing
    // every lineage at once let the later windows expire before a slow recipe's run had finished
    const busy = new Set(
      this.db
        .query<{ agent_id: string }, []>("SELECT DISTINCT agent_id FROM qualifications WHERE status IN ('assigned','committed')")
        .all()
        .map((r) => r.agent_id),
    );
    for (const l of lineages) {
      const recipe = this.recipeOf(l.recipe_id);
      let calib: Calibration | null = null;
      for (const a of agents) {
        if (busy.has(a.agent_id)) continue;
        const caps = this.capsOf(a);
        if (!satisfies(caps, recipe.requires)) continue;
        const last = this.db
          .query<QualRow, [string, string]>("SELECT * FROM qualifications WHERE agent_id = ? AND lineage_id = ? ORDER BY attempt DESC LIMIT 1")
          .get(a.agent_id, l.lineage_id);
        if (last && ["assigned", "committed", "passed"].includes(last.status)) continue;
        if (last && (last.status === "failed" || last.status === "expired") && now < (last.resolved_at ?? now) + this.cfg.qualify_retry_s * 1000) continue;
        calib ??= this.calibOf(l.calib_id);
        const attempt = (last?.attempt ?? 0) + 1;
        const id = H("qualify", a.agent_id, l.lineage_id, String(attempt));
        this.db
          .query(
            `INSERT INTO qualifications (qual_id, agent_id, lineage_id, recipe_id, attempt, seed, status, capabilities, assigned_at, commit_deadline)
             VALUES (?, ?, ?, ?, ?, ?, 'assigned', ?, ?, ?)`,
          )
          .run(id, a.agent_id, l.lineage_id, l.recipe_id, attempt, this.calibSeed(calib), a.capabilities, now, now + this.replayWindowMs(calib));
        this.emit("qualification.assigned", { agent: a.agent_id, lineage_id: l.lineage_id, attempt });
        busy.add(a.agent_id);
      }
    }
  }

  private commitQualification(agent: string, q: QualRow, body: unknown) {
    if (q.agent_id !== agent) throw notFound("assignment");
    if (q.status !== "assigned") throw conflict("not_assigned", `qualification is ${q.status}`);
    if (this.now() > q.commit_deadline) throw conflict("deadline_passed", "commit window closed");
    const commitment = isObj(body) ? String(body.commitment ?? "") : "";
    if (!HEX64.test(commitment)) throw bad("bad_commitment", "commitment must be 64 hex chars");
    const now = this.now();
    // a qualification has one replayer, so its reveal opens as soon as it commits
    this.db
      .query("UPDATE qualifications SET status = 'committed', commitment = ?, committed_at = ?, reveal_deadline = ? WHERE qual_id = ?")
      .run(commitment, now, now + this.cfg.reveal_window_s * 1000, q.qual_id);
    this.emit("qualification.committed", { agent, lineage_id: q.lineage_id });
    return this.qualificationAssignmentView(this.qualRow(q.qual_id)!);
  }

  private revealQualification(agent: string, q: QualRow, body: unknown) {
    if (q.agent_id !== agent) throw notFound("assignment");
    if (q.status !== "committed") throw conflict("not_committed", `qualification is ${q.status}`);
    if (!isObj(body) || !isObj(body.result) || typeof body.salt !== "string") throw bad("bad_body", "{ result, salt } expected");
    const result = body.result as unknown as ReplayResult;
    validateResult(result);
    const now = this.now();
    if (resultCommitment(result, body.salt) !== q.commitment) {
      // no slash and no strike for a failed qualification (SPEC 6.1); the attempt simply fails
      this.resolveQualification(q, "failed", "reveal does not match the commitment", canonicalJson(result), body.salt);
      return { replay_id: q.qual_id, status: "invalid" as const };
    }
    if (!this.blobs.has(result.transcript_digest)) throw bad("missing_transcript", "upload the transcript blob (PUT /v1/blobs/:sha256) before revealing");
    this.db.query("UPDATE qualifications SET revealed_at = ? WHERE qual_id = ?").run(now, q.qual_id);
    const l = this.lineageRow(q.lineage_id)!;
    const verdict = qualificationVerdict(this.recipeOf(q.recipe_id), this.calibOf(l.calib_id), result, this.cfg.det_tolerance);
    this.resolveQualification(q, verdict.pass ? "passed" : "failed", verdict.reason, canonicalJson(result), body.salt);
    this.fillWants();
    return { replay_id: q.qual_id, status: "revealed" as const, qualification: verdict.pass ? "passed" : "failed", reason: verdict.reason };
  }

  private resolveQualification(q: QualRow, status: "passed" | "failed" | "expired", reason: string | null, result: string | null, salt: string | null) {
    const now = this.now();
    this.db
      .query("UPDATE qualifications SET status = ?, reason = ?, result = COALESCE(?, result), salt = COALESCE(?, salt), resolved_at = ? WHERE qual_id = ?")
      .run(status, reason, result, salt, now, q.qual_id);
    this.emit(`qualification.${status}`, {
      agent: q.agent_id,
      lineage_id: q.lineage_id,
      attempt: q.attempt,
      reason,
      retry_at: status === "passed" ? null : now + this.cfg.qualify_retry_s * 1000,
    });
  }

  private expireQualifications() {
    const now = this.now();
    for (const q of this.db.query<QualRow, [number]>("SELECT * FROM qualifications WHERE status = 'assigned' AND commit_deadline < ?").all(now))
      this.resolveQualification(q, "expired", "no commit within the window", null, null);
    for (const q of this.db
      .query<QualRow, [number]>("SELECT * FROM qualifications WHERE status = 'committed' AND reveal_deadline IS NOT NULL AND reveal_deadline < ?")
      .all(now))
      this.resolveQualification(q, "expired", "no reveal within the window", null, null);
  }

  /** The assignment a verifier sees for a qualification: gen_0, the calibration seed, no answer key. */
  qualificationAssignmentView(q: QualRow) {
    const l = this.lineageRow(q.lineage_id)!;
    const calib = this.effectiveCalibration(l.calib_id, l.gen0);
    const snap = this.db.query<{ commit_sha: string; deps_digest: string }, [string]>("SELECT * FROM snapshots WHERE snapshot_id = ?").get(l.snapshot_id)!;
    const repo = this.db.query<{ url: string }, [string]>("SELECT url FROM repos WHERE repo_id = ?").get(l.repo_id)!;
    // the recorded base values are what the verifier must reproduce, so the assignment leaves them out
    const metrics = Object.fromEntries(Object.entries(calib.metrics).map(([k, m]) => [k, { enabled: m.enabled, cv: m.cv, ...(m.reason ? { reason: m.reason } : {}) }]));
    return {
      replay_id: q.qual_id,
      kind: "qualify" as const,
      status: q.status,
      reveal_open: q.status === "committed",
      assigned_at: q.assigned_at,
      commit_deadline: q.commit_deadline,
      reveal_deadline: q.reveal_deadline,
      seed: q.seed,
      lineage: { lineage_id: l.lineage_id, repo: repo.url, commit: snap.commit_sha, snapshot_id: l.snapshot_id, deps_digest: snap.deps_digest },
      recipe_id: l.recipe_id,
      recipe: this.recipeOf(l.recipe_id),
      calibration: { ...calib, metrics },
      parent_gen_id: l.gen0,
      parent_series: [] as { gen_id: string; height: number; patch_hash: string; patch: string }[],
      candidate: null,
      attempt: q.attempt,
    };
  }

  qualificationsOf(agent: string) {
    return this.db
      .query<QualRow, [string]>("SELECT * FROM qualifications WHERE agent_id = ? ORDER BY lineage_id, attempt")
      .all(agent)
      .map((q) => ({
        lineage_id: q.lineage_id,
        recipe_id: q.recipe_id,
        attempt: q.attempt,
        status: q.status,
        reason: q.reason,
        assigned_at: q.assigned_at,
        resolved_at: q.resolved_at,
        retry_at: q.status === "failed" || q.status === "expired" ? (q.resolved_at ?? q.assigned_at) + this.cfg.qualify_retry_s * 1000 : null,
      }));
  }

  // ---------------------------------------------------------------------------------------------
  // Replays (SPEC 5.2, 10.4)

  private mustOwnReplay(agent: string, id: string): ReplayRow {
    const r = this.replayRow(id);
    if (!r || r.replayer !== agent) throw notFound("assignment");
    return r;
  }

  commitReplay(agent: string, id: string, body: unknown) {
    return this.tx(() => {
      const q = this.qualRow(id);
      if (q) return this.commitQualification(agent, q, body);
      const r = this.mustOwnReplay(agent, id);
      if (r.status !== "assigned") throw conflict("not_assigned", `replay is ${r.status}`);
      if (this.now() > r.commit_deadline) throw conflict("deadline_passed", "commit window closed");
      const commitment = isObj(body) ? String(body.commitment ?? "") : "";
      if (!HEX64.test(commitment)) throw bad("bad_commitment", "commitment must be 64 hex chars");
      this.db.query("UPDATE replays SET status = 'committed', commitment = ?, committed_at = ? WHERE replay_id = ?").run(commitment, this.now(), id);
      this.split.onReplayCommit(r, body);
      this.emit("replay.committed", { candidate_id: r.candidate_id });
      this.progress(r.grp);
      return this.assignmentView(this.replayRow(id)!);
    });
  }

  revealReplay(agent: string, id: string, body: unknown) {
    return this.tx(() => {
      const q = this.qualRow(id);
      if (q) return this.revealQualification(agent, q, body);
      const r = this.mustOwnReplay(agent, id);
      if (r.status !== "committed") throw conflict("not_committed", `replay is ${r.status}`);
      if (r.reveal_open_at === null) throw conflict("reveal_not_open", "reveal opens once every assigned replayer of this candidate has committed");
      if (!isObj(body) || !isObj(body.result) || typeof body.salt !== "string") throw bad("bad_body", "{ result, salt } expected");
      const result = body.result as unknown as ReplayResult;
      validateResult(result);
      if (resultCommitment(result, body.salt) !== r.commitment) {
        this.db.query("UPDATE replays SET status = 'invalid', result = ?, salt = ?, revealed_at = ? WHERE replay_id = ?").run(canonicalJson(result), body.salt, this.now(), id);
        this.slash(agent, this.cfg.reveal_slash_bps, "reveal_mismatch", id);
        this.strike(agent, "reveal_mismatch", id);
        this.emit("replay.invalid", { candidate_id: r.candidate_id, reason: "reveal_mismatch" });
        this.wantReplacement(r);
        this.progress(r.grp);
        this.fillWants();
        return { replay_id: id, status: "invalid" as const };
      }
      if (!this.blobs.has(result.transcript_digest)) throw bad("missing_transcript", "upload the transcript blob (PUT /v1/blobs/:sha256) before revealing");
      this.db.query("UPDATE replays SET status = 'revealed', result = ?, salt = ?, revealed_at = ? WHERE replay_id = ?").run(canonicalJson(result), body.salt, this.now(), id);
      this.split.onReplayReveal(r, body);
      this.emit("replay.revealed", { candidate_id: r.candidate_id });
      const c = this.candByCandidateId(r.candidate_id)!;
      // a canary's replays are judged when its group settles (finalizeCanary), like a real candidate's
      // are paid: judging each at its reveal published units or a canary slash right after the first
      // reveal, so a replayer that committed "accept" learned it was a canary and skipped its own
      // reveal for a smaller penalty (audit A2, OFF-03)
      this.progress(r.grp);
      this.fillWants();
      return { replay_id: id, status: "revealed" as const };
    });
  }

  /** A replay slot was lost (abandoned or invalid): ask for a replacement within the reassign budget. */
  private wantReplacement(r: ReplayRow) {
    if (r.audit_id) return; // audits judge with whatever arrives; no reassignment
    const c = this.candByCandidateId(r.candidate_id)!;
    if (TERMINAL.has(c.status) || c.stage !== r.stage) return;
    if (c.reassigns >= this.cfg.max_reassign) return;
    if (r.kind === "reference") this.db.query("UPDATE candidates SET reassigns = reassigns + 1, want_reference = 1 WHERE commit_id = ?").run(c.commit_id);
    else this.db.query("UPDATE candidates SET reassigns = reassigns + 1, want_replays = want_replays + 1 WHERE commit_id = ?").run(c.commit_id);
  }

  /** Opens reveals when nobody in the group is still uncommitted, then judges when the group settles. */
  private progress(grp: string) {
    const rows = this.db.query<ReplayRow, [string]>("SELECT * FROM replays WHERE grp = ?").all(grp);
    if (!rows.some((r) => r.status === "assigned")) {
      const now = this.now();
      for (const r of rows) {
        if (r.status === "committed" && r.reveal_open_at === null) {
          this.db.query("UPDATE replays SET reveal_open_at = ?, reveal_deadline = ? WHERE replay_id = ?").run(now, now + this.cfg.reveal_window_s * 1000, r.replay_id);
        }
      }
      if (rows.some((r) => r.status === "committed" && r.reveal_open_at === null)) this.emit("replay.reveal_open", { group: grp.split(":")[0] === "audit" ? "audit" : "candidate", candidate_id: rows[0]!.candidate_id });
    }
    if (rows.some((r) => r.status === "assigned" || r.status === "committed")) return;
    if (grp.startsWith("chal:")) return challengesOf(this).progress(grp); // bonded challenges (SPEC 10.8)
    if (grp.startsWith("audit:")) {
      const a = this.auditRow(grp.slice(6))!;
      if (a.status === "pending" && a.want_replays === 0 && a.want_reference === 0) this.judgeAudit(a);
      return;
    }
    const c = this.candByCandidateId(rows[0]?.candidate_id ?? grp.split(":")[1]!);
    if (!c || TERMINAL.has(c.status) || this.candGroup(c) !== grp) return;
    if (c.want_replays > 0 || c.want_reference > 0) {
      // waiting for replacements; give up only when the budget is spent and nothing can arrive
      return;
    }
    if (c.is_canary) this.finalizeCanary(c);
    else this.judgeStage(c);
  }

  private revealedOf(grp: string): RevealedReplay[] {
    return this.db
      .query<ReplayRow, [string]>("SELECT * FROM replays WHERE grp = ? AND status = 'revealed' ORDER BY replay_id")
      .all(grp)
      .map((r) => this.asRevealed(r));
  }

  private asRevealed(r: ReplayRow): RevealedReplay {
    return {
      replay_id: r.replay_id,
      replayer: r.replayer,
      seed: r.seed,
      result: JSON.parse(r.result!),
      reference: r.kind === "reference" || r.kind === "audit_reference",
    };
  }

  private viewOf(c: CandRow): CandidateView {
    return { candidate_id: c.candidate_id!, author: c.author, kind: c.kind, target: JSON.parse(c.target) };
  }

  private lineageCtx(c: CandRow, evalParent: string = c.eval_parent_gen_id) {
    const l = this.lineageRow(c.lineage_id)!;
    return { l, recipe: this.recipeOf(l.recipe_id), calib: this.effectiveCalibration(l.calib_id, evalParent) };
  }

  /**
   * Calibration as seen at a generation (SPEC 9.3): tests fixed by `fix` generations in its patch
   * series join the stable set and leave the known failures, so measurement stays tip-relative.
   */
  effectiveCalibration(calib_id: string, gen: string): Calibration {
    const calib = this.calibOf(calib_id);
    const fixed = new Set<string>();
    for (const p of this.patchSeries(gen)) {
      const g = this.genRow(p.gen_id)!;
      if (g.kind === "fix" && g.effect) for (const t of (JSON.parse(g.effect) as { fixed: string[] }).fixed) fixed.add(t);
    }
    if (!fixed.size) return calib;
    return {
      ...calib,
      stable: [...new Set([...calib.stable, ...fixed])].sort(),
      known_failures: calib.known_failures.filter((t) => !fixed.has(t)),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Judging (SPEC 10.1, 10.2, 11.2)

  private judgeStage(c: CandRow) {
    const { recipe, calib } = this.lineageCtx(c);
    const grp = this.candGroup(c);
    const replays = this.revealedOf(grp);
    const j = judge(recipe, calib, this.viewOf(c), replays, this.judgeCfg());
    this.emit("candidate.judged", { candidate_id: c.candidate_id, stage: c.stage, outcome: j.outcome, reason: j.reason ?? null });
    if (j.outcome === "pending") {
      const need = this.cfg.quorum - j.counted.length;
      if (c.reassigns + need > this.cfg.max_reassign) {
        this.settleRoles(c, grp, j, true);
        this.finalizeCandidate(c, "rejected", "insufficient_replays", j.detail ?? null, j);
        return;
      }
      this.db.query("UPDATE candidates SET want_replays = ?, reassigns = reassigns + ? WHERE commit_id = ?").run(need, need, c.commit_id);
      this.fillWants();
      return;
    }
    if (j.outcome === "disputed") {
      if (c.dispute_rounds >= 1) {
        this.closeDispute(c, "unresolved");
        this.settleRoles(c, grp, j, false);
        this.finalizeCandidate(c, "rejected", "unresolved_dispute", j.detail ?? null, j);
        return;
      }
      const hasRef = this.referenceAgents(new Set([c.author]), this.lineageRow(c.lineage_id)!).length > 0;
      this.db
        .query("UPDATE candidates SET status = 'disputed', dispute_rounds = dispute_rounds + 1, want_replays = want_replays + ?, want_reference = ? WHERE commit_id = ?")
        .run(hasRef ? 1 : 2, hasRef ? 1 : 0, c.commit_id);
      this.db
        .query("INSERT INTO disputes (candidate_id, stage, fields, opened_at) VALUES (?, ?, ?, ?)")
        .run(c.candidate_id!, c.stage, JSON.stringify(j.disputed_fields), this.now());
      this.emit("candidate.disputed", { candidate_id: c.candidate_id, fields: j.disputed_fields });
      this.fillWants();
      return;
    }
    // an earlier commitment with the same change is still open: hold this one (SPEC 10.4)
    if (j.outcome === "accepted" && this.hardening.deferIfTwinOpen(c)) return;
    this.closeDispute(c, j.outcome);
    this.settleRoles(c, grp, j, true);
    const twinGen = j.outcome === "accepted" ? this.hardening.acceptedTwin(c) : null;
    if (twinGen) {
      this.finalizeCandidate(c, "rejected", "duplicate", `same change as accepted generation ${twinGen}`, j);
      return;
    }
    if (j.outcome === "rejected") {
      let reason: CandidateReason = j.reason!;
      if (c.stage > 0 && reason === "apply_conflict") reason = "stale_conflict";
      reason = this.series.rejectReason(c, reason);
      this.finalizeCandidate(c, "rejected", reason, j.detail ?? null, j);
      return;
    }
    // accepted by measurement; becomes a generation only on the current tip (SPEC 11.2)
    const l = this.lineageRow(c.lineage_id)!;
    if (c.eval_parent_gen_id === l.tip) {
      this.createGeneration(c, j);
      return;
    }
    if (c.stage === 0) {
      this.db
        .query(
          "UPDATE candidates SET stage = 1, eval_parent_gen_id = ?, status = 'queued', want_replays = ?, want_reference = 0, reassigns = 0, dispute_rounds = 0, detail = ? WHERE commit_id = ?",
        )
        .run(l.tip, this.cfg.quorum, `rebased onto ${l.tip} after the tip moved (stage 0 verdict ${j.digest})`, c.commit_id);
      this.emit("candidate.rebased", { candidate_id: c.candidate_id, from: c.eval_parent_gen_id, to: l.tip });
      this.fillWants();
      return;
    }
    this.finalizeCandidate(c, "rejected", "stale", "the tip moved again during the rebase replay", j);
  }

  private closeDispute(c: CandRow, outcome: string) {
    this.db
      .query("UPDATE disputes SET resolved_at = ?, outcome = ? WHERE candidate_id = ? AND stage = ? AND resolved_at IS NULL")
      .run(this.now(), outcome, c.candidate_id!, c.stage);
  }

  /**
   * Records each revealed replay's role and pays or penalises it. Counted replays earn units
   * regardless of the verdict (SPEC 1.1 principle 3); minority replays are slashed (SPEC 13.6).
   */
  private settleRoles(c: CandRow, grp: string, j: Judgement, resolved: boolean) {
    const { recipe, calib } = this.lineageCtx(c);
    const counted = new Set(resolved ? j.counted : []);
    const minority = new Set(resolved ? j.minority : []);
    const envFailed = new Set(j.env_failed);
    const splitAgreed = resolved ? this.split.agreedReports(c, j, recipe, calib) : new Set<string>();
    for (const r of this.db.query<ReplayRow, [string]>("SELECT * FROM replays WHERE grp = ? AND status = 'revealed'").all(grp)) {
      let role: string | null = null;
      if (counted.has(r.replay_id)) {
        role = "counted";
        this.awardReplay(r, calib);
        this.split.onCounted(r, calib, splitAgreed);
      } else if (minority.has(r.replay_id)) {
        role = "minority";
        this.slash(r.replayer, this.cfg.minority_slash_bps, "minority", r.replay_id);
        this.strike(r.replayer, "minority", r.replay_id);
      } else if (envFailed.has(r.replay_id)) role = "env_failed";
      this.db.query("UPDATE replays SET role = ? WHERE replay_id = ?").run(role, r.replay_id);
    }
  }

  private awardReplay(r: ReplayRow, calib: Calibration) {
    const a = this.agentRow(r.replayer);
    if (!a || a.reference) return; // the reference runner is paid from the reserve, not the pool
    const cls = costClass(calib.median_eval_seconds);
    this.addUnits(r.replayer, "replay", r.replay_id, this.cfg.u_replay * cls, this.cfg.rebate_per_class * BigInt(cls));
  }

  private addUnits(agent: string, kind: string, ref: string, units: number, rebate = 0n) {
    if (units <= 0 && rebate === 0n) return;
    const epoch = this.currentEpoch().n;
    this.db
      .query("INSERT INTO units (epoch, agent_id, kind, ref, units, rebate, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(epoch, agent, kind, ref, units, rebate.toString(), this.now());
    this.emit("units.awarded", { agent, kind, ref, units, rebate: rebate.toString(), epoch });
  }

  private voidUnits(where: string, ref: string) {
    const rows = this.db
      .query<{ id: number; epoch: number; agent_id: string; kind: string }, [string]>(`SELECT id, epoch, agent_id, kind FROM units WHERE ref = ? AND voided = 0 ${where}`)
      .all(ref);
    for (const u of rows) {
      const ep = this.epochRow(u.epoch)!;
      if (ep.status === "open") {
        this.db.query("UPDATE units SET voided = 1 WHERE id = ?").run(u.id);
        this.emit("units.voided", { agent: u.agent_id, kind: u.kind, ref, epoch: u.epoch });
      } else {
        // already paid out in a closed epoch; M1 cannot claw it back, so it is recorded instead
        this.emit("units.void_after_close", { agent: u.agent_id, kind: u.kind, ref, epoch: u.epoch });
      }
    }
  }

  private createGeneration(c: CandRow, j: Judgement) {
    const { l, recipe, calib } = this.lineageCtx(c);
    const parent = this.genRow(l.tip)!;
    const gid = genId(parent.gen_id, c.patch_hash!, j.digest);
    const epoch = this.currentEpoch().n;
    this.db
      .query(
        `INSERT INTO generations (gen_id, lineage_id, parent_gen_id, height, entry_type, candidate_id, patch_hash, semantic_hash, patch, kind, target, effect, verdict_digest, verdict, replay_ids, author, accepted_at, epoch)
         VALUES (?, ?, ?, ?, 'patch', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        gid,
        l.lineage_id,
        parent.gen_id,
        parent.height + 1,
        c.candidate_id!,
        c.patch_hash!,
        c.semantic_hash,
        c.patch!,
        c.kind,
        c.target,
        JSON.stringify(j.effect),
        j.digest,
        JSON.stringify(j),
        JSON.stringify(j.counted),
        c.author,
        this.now(),
        epoch,
      );
    this.db.query("UPDATE lineages SET tip = ?, height = ? WHERE lineage_id = ?").run(gid, parent.height + 1, l.lineage_id);
    this.db.query("UPDATE candidates SET gen_id = ? WHERE commit_id = ?").run(gid, c.commit_id);
    this.finalizeCandidate(this.candRow(c.commit_id)!, "accepted", null, null, j);

    // author and finder units (SPEC 13.3)
    const target = JSON.parse(c.target) as string | string[];
    const metricName = Array.isArray(target) ? target[0] : target;
    const minEffect = recipe.metrics.find((m) => m.name === metricName)?.min_effect ?? 1;
    const value = effectValue(j.effect!, minEffect, this.cfg.value_cap);
    const authorUnits = this.cfg.u_author * costClass(calib.median_eval_seconds) * value;
    const resolvedKeys =
      c.kind === "fix"
        ? (Array.isArray(target) ? target : [target]).map((t) => ({ kind: "known_failure", target: t }))
        : [{ kind: "metric_target", target: metricName! }];
    const finders = new Set<string>();
    for (const k of resolvedKeys) {
      const f = this.db
        .query<{ finding_id: string; finder: string | null }, [string, string, string]>(
          "SELECT finding_id, finder FROM findings WHERE lineage_id = ? AND kind = ? AND target = ? AND status = 'open' ORDER BY created_at LIMIT 1",
        )
        .get(l.lineage_id, k.kind, k.target);
      if (!f) continue;
      if (f.finder && f.finder !== c.author) finders.add(f.finder);
      // metric targets stay open: every metric of an active lineage is an open target (SPEC 12)
      if (k.kind === "known_failure") {
        this.db.query("UPDATE findings SET status = 'resolved', resolved_by = ? WHERE finding_id = ?").run(gid, f.finding_id);
        this.emit("finding.resolved", { finding_id: f.finding_id, gen_id: gid });
      } else if (f.finder) {
        // a finder-attributed metric finding is credited once, then reopened as an automatic target
        this.db.query("UPDATE findings SET status = 'resolved', resolved_by = ? WHERE finding_id = ?").run(gid, f.finding_id);
        this.emit("finding.resolved", { finding_id: f.finding_id, gen_id: gid });
      }
    }
    // verified hotspots whose source file this perf patch changes (findings.ts, SPEC 12.8)
    for (const f of findingsOf(this).resolveOnAccept({ lineage_id: l.lineage_id, gen_id: gid, kind: c.kind, metric: metricName, patch: c.patch, author: c.author })) finders.add(f);
    const finderTotal = finders.size ? this.cfg.finder_share * authorUnits : 0;
    // a team divides the same total by its declared shares; team size never adds units (SPEC 12.2)
    // a port credits the original generation's authors first (SPEC 12.7); a measured split divides the rest (SPEC 12.6)
    const portParts = this.ports.credit(c, gid, authorUnits - finderTotal);
    const ownTotal = authorUnits - finderTotal - portParts.reduce((a, [, u]) => a + u, 0);
    for (const [member, u] of this.split.authorShares(c, j, recipe, calib, ownTotal) ?? this.collab.authorShares(c, ownTotal)) this.addUnits(member, "author", gid, u);
    for (const [orig, u] of portParts) this.addUnits(orig, "author", gid, u);
    for (const f of finders) this.addUnits(f, "finder", gid, finderTotal / finders.size);
    this.emit("generation.accepted", {
      gen_id: gid,
      lineage_id: l.lineage_id,
      height: parent.height + 1,
      candidate_id: c.candidate_id,
      author: c.author,
      team: this.collab.teamView(c.commit_id)?.members.map((m) => ({ agent: m.agent, role: m.role, share_bps: m.share_bps })) ?? null,
      kind: c.kind,
      effect: j.effect,
    });

    // random audit (SPEC 10.6)
    const ep = this.currentEpoch();
    // slot beacon (M2): the decision uses the slot hash of the candidate's first draw (src/beacon.ts)
    const auditSlot = this.slotBeacon?.decisionSeed("audit", gid, c.candidate_id!, ep) ?? null;
    const auditDraw = new Rng(auditSlot?.seed ?? H("m1-audit", ep.secret, gid)).next();
    if (auditSlot) this.slotBeacon!.recordUse("audit", gid, ep.n, auditSlot.draw, auditDraw, this.cfg.audit_rate);
    if (this.cfg.audit_rate > 0 && auditDraw < this.cfg.audit_rate) {
      const hasRef = this.referenceAgents(new Set([c.author]), l).length > 0;
      const aid = H("audit", gid);
      this.db
        .query("INSERT INTO audits (audit_id, gen_id, candidate_id, status, want_replays, want_reference, created_at, epoch) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)")
        .run(aid, gid, c.candidate_id!, this.cfg.audit_replayers + (hasRef ? 0 : 1), hasRef ? 1 : 0, this.now(), ep.n);
      this.db.query("UPDATE generations SET audit_status = 'pending' WHERE gen_id = ?").run(gid);
      this.emit("audit.opened", { audit_id: aid, gen_id: gid });
      this.fillWants();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Canary judging (SPEC 10.5)

  private checkCanaryReplay(c: CandRow, r: ReplayRow) {
    const { recipe, calib } = this.lineageCtx(c);
    const j = judge(recipe, calib, this.viewOf(c), [this.asRevealed(r)], this.judgeCfg(1));
    if (j.outcome === "accepted") {
      this.db.query("UPDATE replays SET role = 'canary_fail' WHERE replay_id = ?").run(r.replay_id);
      this.slash(r.replayer, this.cfg.canary_slash_bps, "canary", r.replay_id);
      this.strike(r.replayer, "canary", r.replay_id);
    } else if (j.outcome === "rejected") {
      this.db.query("UPDATE replays SET role = 'canary_pass' WHERE replay_id = ?").run(r.replay_id);
      this.awardReplay(r, calib);
    } else {
      this.db.query("UPDATE replays SET role = 'env_failed' WHERE replay_id = ?").run(r.replay_id);
    }
  }

  private finalizeCanary(c: CandRow) {
    for (const r of this.db.query<ReplayRow, [string]>("SELECT * FROM replays WHERE grp = ? AND status = 'revealed' AND role IS NULL AND audit_id IS NULL ORDER BY replay_id").all(this.candGroup(c)))
      this.checkCanaryReplay(c, r);
    const { recipe, calib } = this.lineageCtx(c);
    const replays = this.revealedOf(this.candGroup(c));
    // its public status is what the full rule says, except it can never become a generation
    const j = judge(recipe, calib, this.viewOf(c), replays, this.judgeCfg());
    let reason: CandidateReason;
    if (j.outcome === "accepted") reason = "canary";
    else if (j.outcome === "rejected") reason = j.reason!;
    else if (j.outcome === "disputed") reason = "unresolved_dispute";
    else reason = "insufficient_replays";
    this.finalizeCandidate(c, "rejected", reason, j.detail ?? null, j);
  }

  // ---------------------------------------------------------------------------------------------
  // Audits and reverts (SPEC 10.6, 11.3)

  /**
   * Settles an audit (SPEC 10.6). The audit group ran a fresh shared seed, so only a contradiction on
   * a deterministic field reverts: an original replay in the minority on a seed-independent field
   * (or a deterministic metric or equivalence value within one seed group), a seed-independent
   * rejection, or the audit's own replays agreeing that the patch changes behaviour on the fresh
   * inputs (equivalence). A fresh-seed miss on a noisy metric is `inconclusive`; on a deterministic
   * metric it is `weak` (recorded, no revert in M1).
   */
  private judgeAudit(a: AuditRow) {
    const c = this.candByCandidateId(a.candidate_id)!;
    const { recipe, calib } = this.lineageCtx(c);
    const original = this.db
      .query<ReplayRow, [string, number]>("SELECT * FROM replays WHERE grp = ? AND role = 'counted' AND stage = ? ORDER BY replay_id")
      .all(`cand:${c.candidate_id}:${c.stage}`, c.stage);
    const origIds = new Set(original.map((r) => r.replay_id));
    const auditReplays = this.revealedOf(`audit:${a.audit_id}`);
    const auditIds = new Set(auditReplays.map((r) => r.replay_id));
    const j = judge(recipe, calib, this.viewOf(c), [...original.map((r) => this.asRevealed(r)), ...auditReplays], this.judgeCfg());
    const auditCounted = j.counted.filter((id) => auditIds.has(id)).length + j.minority.filter((id) => auditIds.has(id)).length;
    const v = auditOutcome(recipe, this.viewOf(c), j, origIds, auditReplays, auditCounted);
    const status = v.status;
    const now = this.now();
    if (status !== "inconclusive" || v.settled) {
      for (const id of j.minority) {
        const r = this.replayRow(id)!;
        this.slash(r.replayer, this.cfg.minority_slash_bps, "audit_minority", id);
        this.strike(r.replayer, "audit_minority", id);
        this.voidUnits("AND kind = 'replay'", id);
        this.db.query("UPDATE replays SET role = 'minority' WHERE replay_id = ?").run(id);
      }
      for (const id of j.counted) {
        if (!auditIds.has(id)) continue;
        this.db.query("UPDATE replays SET role = 'counted' WHERE replay_id = ?").run(id);
        this.awardReplay(this.replayRow(id)!, calib);
      }
    }
    this.db.query("UPDATE audits SET status = ?, verdict = ?, detail = ?, resolved_at = ? WHERE audit_id = ?").run(status, JSON.stringify(j), v.detail, now, a.audit_id);
    this.db.query("UPDATE generations SET audit_status = ? WHERE gen_id = ?").run(status, a.gen_id);
    this.emit("audit.resolved", { audit_id: a.audit_id, gen_id: a.gen_id, status, outcome: j.outcome, reason: j.reason ?? null, detail: v.detail });
    if (status === "reverted") this.revert(a.gen_id, j);
  }

  /**
   * Appends a revert entry (SPEC 11.3). M1 does not replay later generations automatically: they are
   * flagged needs_revalidation, and the patch series served to workers omits the reverted patch.
   */
  private revert(genIdToRevert: string, j: Judgement) {
    const g = this.genRow(genIdToRevert)!;
    const l = this.lineageRow(g.lineage_id)!;
    const tip = this.genRow(l.tip)!;
    const rid = H("gen-revert", tip.gen_id, g.gen_id, j.digest);
    this.db
      .query(
        `INSERT INTO generations (gen_id, lineage_id, parent_gen_id, height, entry_type, verdict_digest, verdict, author, accepted_at, epoch, reverts)
         VALUES (?, ?, ?, ?, 'revert', ?, ?, ?, ?, ?, ?)`,
      )
      .run(rid, l.lineage_id, tip.gen_id, tip.height + 1, j.digest, JSON.stringify(j), g.author, this.now(), this.currentEpoch().n, g.gen_id);
    this.db.query("UPDATE generations SET reverted_by = ? WHERE gen_id = ?").run(rid, g.gen_id);
    this.db
      .query("UPDATE generations SET needs_revalidation = 1 WHERE lineage_id = ? AND entry_type = 'patch' AND height > ? AND reverted_by IS NULL")
      .run(l.lineage_id, g.height);
    this.db.query("UPDATE lineages SET tip = ?, height = ? WHERE lineage_id = ?").run(rid, tip.height + 1, l.lineage_id);
    // the author's reward for it is void (SPEC 10.6)
    this.voidUnits("AND kind IN ('author','finder')", g.gen_id);
    this.emit("generation.reverted", { gen_id: g.gen_id, revert_id: rid, lineage_id: l.lineage_id });
  }

  // ---------------------------------------------------------------------------------------------
  // Scheduler

  /** Advances every timer against the clock. Idempotent; main.ts calls it on an interval. */
  /**
   * A dispute round that could not draw a fresh replayer (every eligible verifier already replayed the
   * candidate: a small network) within twice its lineage's replay window ends as `unresolved_dispute`,
   * judged on the replays it has: rejected, nobody slashed (SPEC 10.6). It used to wait forever.
   */
  private closeStarvedDisputes(now: number) {
    const rows = this.db
      .query<CandRow & { opened_at: number }, []>(
        `SELECT c.*, d.opened_at AS opened_at FROM candidates c JOIN disputes d ON d.candidate_id = c.candidate_id AND d.stage = c.stage AND d.resolved_at IS NULL
         WHERE c.status = 'disputed' AND (c.want_replays > 0 OR c.want_reference > 0)`,
      )
      .all();
    for (const c of rows) {
      const grp = this.candGroup(c);
      if (this.db.query("SELECT 1 FROM replays WHERE grp = ? AND status IN ('assigned','committed') LIMIT 1").get(grp)) continue;
      const wait = 2 * this.replayWindowMs(this.calibOf(this.lineageRow(c.lineage_id)!.calib_id));
      if (now < c.opened_at + wait) continue;
      this.db.query("UPDATE candidates SET want_replays = 0, want_reference = 0 WHERE commit_id = ?").run(c.commit_id);
      this.emit("candidate.dispute_starved", { candidate_id: c.candidate_id });
      this.progress(grp);
    }
  }

  tick() {
    return this.tx(() => {
      const now = this.now();
      for (const c of this.db.query<CandRow, [number]>("SELECT * FROM candidates WHERE status = 'committed' AND reveal_deadline < ?").all(now)) this.expire(c);
      const touched = new Set<string>();
      for (const r of this.db.query<ReplayRow, [number]>("SELECT * FROM replays WHERE status = 'assigned' AND commit_deadline < ?").all(now)) {
        this.db.query("UPDATE replays SET status = 'abandoned' WHERE replay_id = ?").run(r.replay_id);
        this.strike(r.replayer, "abandoned", r.replay_id);
        this.emit("replay.abandoned", { candidate_id: r.candidate_id, phase: "commit" });
        this.wantReplacement(r);
        touched.add(r.grp);
      }
      for (const r of this.db
        .query<ReplayRow, [number]>("SELECT * FROM replays WHERE status = 'committed' AND reveal_deadline IS NOT NULL AND reveal_deadline < ?")
        .all(now)) {
        this.db.query("UPDATE replays SET status = 'abandoned' WHERE replay_id = ?").run(r.replay_id);
        this.strike(r.replayer, "unrevealed", r.replay_id);
        this.emit("replay.abandoned", { candidate_id: r.candidate_id, phase: "reveal" });
        this.wantReplacement(r);
        touched.add(r.grp);
      }
      for (const g of touched) this.progress(g);
      this.closeStarvedDisputes(now);
      this.expireQualifications();
      this.hardening.tick();
      this.series.tick();
      this.messages.tick();
      soulsOf(this).tick(); // souls: shadow parity (SPEC 14.8)
      challengesOf(this).tick(); // bonded challenges (SPEC 10.8)
      linksOf(this).tick(); // verified links: background rechecks, per-tick budget (identity plan I3)
      upstreamOf(this).tick(); // upstream merge detection, one repository per tick at most (SPEC 16)
      this.matureUnbonds();
      this.fillWants();
      let ep = this.currentEpoch();
      while (now >= ep.end_ms) {
        this.closeEpochInner(ep);
        ep = this.currentEpoch();
      }
      this.db.query("DELETE FROM nonces WHERE at < ?").run(now - 2 * this.nonceWindowMs);
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Epochs (SPEC 13)

  private openEpoch(n: number, start: number) {
    const secret = this.randomHex(32);
    const end = start + this.cfg.epoch_length_s * 1000;
    this.db
      .query("INSERT INTO epochs (n, start_ms, end_ms, secret, beacon_commit, status) VALUES (?, ?, ?, ?, ?, 'open')")
      .run(n, start, end, secret, commitBeacon(secret));
    this.emit("epoch.opened", { n, start_ms: start, end_ms: end, beacon_commit: commitBeacon(secret) });
  }

  /** Admin close: ends the current epoch now. */
  closeEpoch() {
    return this.tx(() => {
      const ep = this.currentEpoch();
      this.db.query("UPDATE epochs SET end_ms = ? WHERE n = ?").run(this.now(), ep.n);
      this.closeEpochInner(this.epochRow(ep.n)!);
      return this.epochView(ep.n);
    });
  }

  private destFor(agent: string, kind: string): string {
    const a = this.agentRow(agent);
    if ((kind === "author" || kind === "finder" || kind === "upstream") && a?.kind === "launched") {
      return this.cfg.author_reward_to === "compute" ? ACC.compute(agent) : ACC.extWallet(a.launcher!);
    }
    return ACC.wallet(agent);
  }

  private closeEpochInner(ep: EpochRow) {
    const units = this.db
      .query<{ agent_id: string; kind: string; units: number; rebate: string }, [number]>(
        "SELECT agent_id, kind, units, rebate FROM units WHERE epoch = ? AND voided = 0 ORDER BY id",
      )
      .all(ep.n);
    const key = (agent: string, dest: string) => `${agent}\n${dest}`;
    const unitMap = new Map<string, number>();
    const rebateMap = new Map<string, bigint>();
    for (const u of units) {
      const k = key(u.agent_id, this.destFor(u.agent_id, u.kind));
      unitMap.set(k, (unitMap.get(k) ?? 0) + u.units);
      const rb = BigInt(u.rebate);
      if (rb > 0n) {
        const rk = key(u.agent_id, ACC.wallet(u.agent_id));
        rebateMap.set(rk, (rebateMap.get(rk) ?? 0n) + rb);
      }
    }
    const pool = this.ledger.balance(ACC.pool);
    const split = proportionalSplit(pool, unitMap);
    const rebateWanted = [...rebateMap.values()].reduce((a, b) => a + b, 0n);
    const reserve = this.ledger.balance(ACC.reserve);
    let rebates: Map<string, bigint>;
    if (rebateWanted <= reserve) rebates = rebateMap;
    else {
      // capped by the reserve: shared pro rata to what each agent earned
      rebates = proportionalSplit(reserve, new Map([...rebateMap].map(([k, v]) => [k, Number(v)])));
    }
    const keys = [...new Set([...split.keys(), ...rebates.keys(), ...unitMap.keys()])].sort();
    const leaves: PayoutLeaf[] = [];
    let poolOut = 0n;
    let rebateOut = 0n;
    for (const k of keys) {
      const [agent, dest] = k.split("\n") as [string, string];
      const p = split.get(k) ?? 0n;
      const r = rebates.get(k) ?? 0n;
      poolOut += p;
      rebateOut += r;
      const amount = p + r;
      if (amount === 0n) continue;
      const leaf = leafHash(canonicalJson({ epoch: ep.n, agent, dest, amount: amount.toString() }));
      leaves.push({ agent, dest, amount: amount.toString(), units: unitMap.get(k) ?? 0, rebate: r.toString(), leaf });
    }
    const root = merkleRoot(leaves.map((l) => l.leaf));
    this.ledger.transfer(ACC.pool, ACC.payable(ep.n), poolOut, "epoch_payout", `epoch:${ep.n}`);
    this.ledger.transfer(ACC.reserve, ACC.payable(ep.n), rebateOut, "epoch_rebate", `epoch:${ep.n}`);
    const genRows = this.db
      .query<{ lineage_id: string; gen_id: string; parent_gen_id: string | null; height: number; entry_type: string }, []>(
        "SELECT lineage_id, gen_id, parent_gen_id, height, entry_type FROM generations ORDER BY lineage_id, height",
      )
      .all();
    const lineageRoot = merkleRoot(genRows.map((g) => leafHash(canonicalJson(g))));
    const canaries = this.db
      .query<CandRow, [number]>("SELECT * FROM candidates WHERE is_canary = 1 AND epoch = ? ORDER BY committed_at")
      .all(ep.n)
      .map((c) => {
        const cn = this.db.query<CanaryRow, [string]>("SELECT * FROM canaries WHERE canary_id = ?").get(c.canary_id!)!;
        return {
          candidate_id: c.candidate_id,
          shadow_agent: c.author,
          canary_id: c.canary_id,
          kind: cn.kind,
          expected_reason: cn.expected_reason,
          status: c.status,
          reason: c.reason,
        };
      });
    const totalUnits = [...unitMap.values()].reduce((a, b) => a + b, 0);
    // reputation records and contribution leaves of what became final in this epoch (identity plan I2)
    const recordRoot = this.records.buildEpoch(ep.n).root;
    this.db
      .query(
        "UPDATE epochs SET status = 'closed', closed_at = ?, pool_amount = ?, rebate_amount = ?, total_units = ?, payouts = ?, root = ?, lineage_root = ?, canaries = ? WHERE n = ?",
      )
      .run(this.now(), poolOut.toString(), rebateOut.toString(), totalUnits, JSON.stringify(leaves), root, lineageRoot, JSON.stringify(canaries), ep.n);
    this.emit("epoch.closed", { n: ep.n, root, lineage_root: lineageRoot, record_root: recordRoot, pool_amount: poolOut.toString(), rebate_amount: rebateOut.toString(), payouts: leaves.length });
    this.openEpoch(ep.n + 1, ep.end_ms);
  }

  /** Merkle claim (SPEC 13.3). The caller must be the leaf's agent. */
  claim(agent: string, n: number, body: unknown) {
    return this.tx(() => {
      this.notOnChain("an epoch claim");
      challengesOf(this).assertClaimable(n); // held while a challenge on the epoch is open (SPEC 10.8)
      const ep = this.epochRow(n);
      if (!ep) throw notFound("epoch");
      if (ep.status !== "closed") throw conflict("epoch_open", "epoch not closed yet");
      if (!isObj(body)) throw bad("bad_body", "{ dest, amount, proof } expected");
      const dest = String(body.dest ?? "");
      const amount = parseAmount(body.amount);
      const proof = body.proof;
      if (!strArr(proof)) throw bad("bad_proof", "proof must be an array of hex hashes");
      const leaf = leafHash(canonicalJson({ epoch: n, agent, dest, amount: amount.toString() }));
      if (!verifyProof(leaf, proof, ep.root!)) throw forbidden("bad_proof", "proof does not verify against the epoch root");
      const r = this.db.query("INSERT OR IGNORE INTO claims (epoch, agent_id, dest, amount, claimed_at) VALUES (?, ?, ?, ?, ?)").run(n, agent, dest, amount.toString(), this.now());
      if (r.changes === 0) throw conflict("already_claimed", "already claimed");
      this.ledger.transfer(ACC.payable(n), dest, amount, "claim", `epoch:${n}:${agent}`);
      if (dest === ACC.compute(agent)) this.refreshAwake(agent);
      this.emit("epoch.claimed", { n, agent, dest, amount: amount.toString() });
      return { epoch: n, agent, dest, amount: amount.toString(), balance: this.ledger.balance(dest).toString() };
    });
  }

  proofs(n: number, agent: string) {
    const ep = this.epochRow(n);
    if (!ep) throw notFound("epoch");
    if (ep.status !== "closed") throw conflict("epoch_open", "epoch not closed yet");
    const leaves = JSON.parse(ep.payouts!) as PayoutLeaf[];
    const all = leaves.map((l) => l.leaf);
    return leaves
      .map((l, i) => ({ ...l, index: i }))
      .filter((l) => l.agent === agent)
      .map((l) => ({
        epoch: n,
        agent,
        dest: l.dest,
        amount: l.amount,
        leaf: l.leaf,
        proof: merkleProof(all, l.index),
        root: ep.root,
        claimed: !!this.db.query("SELECT 1 FROM claims WHERE epoch = ? AND agent_id = ? AND dest = ?").get(n, agent, l.dest),
      }));
  }


  // ---------------------------------------------------------------------------------------------
  // Chain mode (SPEC 14): the bridge in src/chain.ts reads the programs and mirrors them in here.
  // Mirrored ledger accounts are set to what the chain holds, net of what Core has decided but not
  // yet sent (closed epochs not posted, slashes not sent), through `faucet` with a chain_* reason,
  // so reconcile() still holds.

  private notOnChain(what: string) {
    if (this.chainMode) throw conflict("on_chain", `${what} happens on chain in chain mode`);
  }

  private mirror(account: string, want: bigint, reason: string): bigint {
    const target = want < 0n ? 0n : want;
    const have = this.ledger.balance(account);
    if (target > have) this.ledger.transfer(ACC.faucet, account, target - have, reason, "chain");
    else if (target < have) this.ledger.transfer(account, ACC.faucet, have - target, reason, "chain");
    return target - have;
  }

  private unsentSlashes(agent?: string): bigint {
    const rows = this.db
      .query<{ amount: string; agent_id: string }, []>(
        "SELECT s.amount, s.agent_id FROM slashes s LEFT JOIN chain_slashes c ON c.slash_id = s.id WHERE c.signature IS NULL",
      )
      .all();
    return rows.filter((r) => !agent || r.agent_id === agent).reduce((t, r) => t + BigInt(r.amount), 0n);
  }

  /** Mirrors one registry Agent (and, for launched agents, its AgentLaunch and compute vault). */
  chainSyncAgent(r: ChainAgent) {
    return this.tx(() => {
      let a = this.agentRow(r.agent);
      if (!a) {
        if (r.kind === "verifier") {
          const operator = r.operator === ZERO32 ? null : r.operator;
          this.db
            .query("INSERT INTO agents (agent_id, kind, operator, registered_at, lifecycle) VALUES (?, 'verifier', ?, ?, 'active')")
            .run(r.agent, operator, Number(r.registeredAt) * 1000);
          this.ledger.transfer(ACC.faucet, ACC.burned, r.burned, "chain_register_burn", r.agent);
          this.emit("agent.registered", { agent: r.agent, kind: "verifier", operator, capabilities: null, chain: true });
        } else if (r.launch) {
          const MODES = ["token", "purchased", "app"];
          this.launchAgent(
            { agent: r.agent, mint: r.launch.mint, launcher: r.launch.launcher, target_repo: r.launch.repoUrl, hosted: r.launch.hosted,
              identity_mode: MODES[r.launch.identityMode] ?? "app" },
            { fromChain: true },
          );
        } else return null;
        this.db.query("UPDATE agents SET chain_owner = ?, chain_caps = ? WHERE agent_id = ?").run(r.owner, r.capabilities, r.agent);
        a = this.agentRow(r.agent)!;
      } else if (r.launch && a.mint && a.mint !== r.launch.mint) {
        // relaunched under the same agent key on a new deployment (devnet v2): the old token is history
        const MODES = ["token", "purchased", "app"];
        deploymentsOf(this).recordRelaunch(r.agent, a.mint, r.launch.mint);
        this.db
          .query("UPDATE agents SET mint = ?, launcher = ?, hosted = ?, identity_mode = ?, chain_owner = ?, chain_caps = ? WHERE agent_id = ?")
          .run(r.launch.mint, r.launch.launcher, r.launch.hosted ? 1 : 0, MODES[r.launch.identityMode] ?? "app", r.owner, r.capabilities, r.agent);
        a = this.agentRow(r.agent)!;
      }
      if (r.keySeq !== undefined) this.identity.syncChain(r.agent, r.signingKey ?? null, r.keySeq, r.keyChangedAt ?? 0n);
      if (r.ownerSince !== undefined) this.identity.syncOwner(r.agent, r.owner, r.ownerSince, r.pendingOwner ?? null);
      const delta = this.mirror(ACC.bond(r.agent), r.bond - this.unsentSlashes(r.agent), "chain_bond");
      if (delta !== 0n) {
        this.db.query("INSERT INTO bonds (agent_id, action, amount, at) VALUES (?, ?, ?, ?)").run(r.agent, delta > 0n ? "bond" : "unbond_release", (delta > 0n ? delta : -delta).toString(), this.now());
        this.emit(delta > 0n ? "agent.bonded" : "agent.unbonded", { agent: r.agent, amount: (delta > 0n ? delta : -delta).toString(), bond: this.bondOf(r.agent).toString(), chain: true });
      }
      const unbond = r.unbondAmount.toString();
      const ready = r.unbondAmount > 0n ? Number(r.unbondReadyAt) * 1000 : null;
      if (a.unbond_amount !== unbond || a.unbond_ready_at !== ready) {
        this.db.query("UPDATE agents SET unbond_amount = ?, unbond_ready_at = ? WHERE agent_id = ?").run(unbond, ready, r.agent);
        if (r.unbondAmount > 0n) this.emit("agent.cooling", { agent: r.agent, amount: unbond, ready_at: ready, chain: true });
      }
      if (r.compute !== undefined) {
        this.mirror(ACC.compute(r.agent), r.compute, "chain_compute");
        this.refreshAwake(r.agent);
      }
      if (delta !== 0n) this.fillWants();
      return this.agentView(r.agent);
    });
  }

  /**
   * Agents Core mirrored that the current registry does not carry (a retired deployment's, devnet v2):
   * no compute vault and no bond there, so both mirror as zero and the agent sleeps.
   */
  chainAbsentAgents(present: Set<string>) {
    return this.tx(() => {
      const rows = this.db.query<{ agent_id: string; kind: string }, []>("SELECT agent_id, kind FROM agents WHERE kind IN ('launched', 'verifier') AND shadow = 0").all();
      const out: string[] = [];
      for (const r of rows.filter((x) => !present.has(x.agent_id))) {
        const c = r.kind === "launched" ? this.mirror(ACC.compute(r.agent_id), 0n, "chain_absent") : 0n;
        const b = this.mirror(ACC.bond(r.agent_id), 0n, "chain_absent");
        if (r.kind === "launched") this.refreshAwake(r.agent_id);
        if (b !== 0n) this.db.query("INSERT INTO bonds (agent_id, action, amount, at) VALUES (?, 'unbond_release', ?, ?)").run(r.agent_id, (-b).toString(), this.now());
        if (c !== 0n || b !== 0n) out.push(r.agent_id);
      }
      if (out.length) this.fillWants();
      return out;
    });
  }

  /** Mirrors the registry vaults: treasury as is, pool and reserve net of decisions not yet sent. */
  chainSetBalances(b: { treasury: bigint; reserve: bigint; pool: bigint }) {
    return this.tx(() => {
      const unposted = this.db
        .query<{ pool_amount: string; rebate_amount: string }, []>(
          "SELECT e.pool_amount, e.rebate_amount FROM epochs e LEFT JOIN chain_epochs c ON c.n = e.n WHERE e.status = 'closed' AND c.signature IS NULL AND e.n > ?",
        )
        .all(this.retiredThrough());
      const pool = unposted.reduce((t, e) => t + BigInt(e.pool_amount), 0n);
      const rebate = unposted.reduce((t, e) => t + BigInt(e.rebate_amount), 0n);
      this.mirror(ACC.treasury, b.treasury, "chain_treasury");
      this.mirror(ACC.pool, b.pool - pool, "chain_pool");
      this.mirror(ACC.reserve, b.reserve - rebate + this.unsentSlashes(), "chain_reserve");
    });
  }

  /** Closed epochs not yet posted on chain, oldest first (never dropped; the bridge backs off). */
  chainPendingEpochs(maxAttempts = Number.MAX_SAFE_INTEGER) {
    return this.db
      .query<EpochRow & { attempts: number | null }, [number, number]>(
        "SELECT e.*, c.attempts FROM epochs e LEFT JOIN chain_epochs c ON c.n = e.n WHERE e.status = 'closed' AND c.signature IS NULL AND COALESCE(c.attempts, 0) < ? AND e.n > ? ORDER BY e.n",
      )
      .all(maxAttempts, this.retiredThrough());
  }
  chainEpochResult(n: number, r: { signature?: string; error?: string }) {
    this.tx(() => {
      this.db
        .query(
          `INSERT INTO chain_epochs (n, signature, error, attempts, posted_at) VALUES (?, ?, ?, 1, ?)
           ON CONFLICT(n) DO UPDATE SET signature = excluded.signature, error = excluded.error, attempts = chain_epochs.attempts + 1, posted_at = excluded.posted_at`,
        )
        .run(n, r.signature ?? null, r.error ?? null, r.signature ? this.now() : null);
      this.emit(r.signature ? "chain.epoch_posted" : "chain.epoch_failed", { n, ...r });
    });
  }
  chainEpochs() {
    return this.db.query<{ n: number; signature: string | null; error: string | null; attempts: number; posted_at: number | null }, []>("SELECT * FROM chain_epochs ORDER BY n").all();
  }

  /**
   * Slashes Core decided that have not landed on the registry yet (reference runners are never
   * slashed). A failed send stays pending (the bridge backs off); it is never dropped.
   */
  chainPendingSlashes(maxAttempts = Number.MAX_SAFE_INTEGER) {
    return this.db
      .query<{ id: number; agent_id: string; reason: string; ref: string; epoch: number; amount: string }, [number]>(
        "SELECT s.id, s.agent_id, s.reason, s.ref, s.epoch, s.amount FROM slashes s LEFT JOIN chain_slashes c ON c.slash_id = s.id WHERE c.signature IS NULL AND COALESCE(c.attempts, 0) < ? ORDER BY s.id",
      )
      .all(maxAttempts)
      .map((s) => ({ ...s, offence: CHAIN_OFFENCE[s.reason] ?? 1 }));
  }
  chainSlashResult(id: number, r: { signature?: string; error?: string }) {
    this.tx(() => {
      this.db
        .query(
          `INSERT INTO chain_slashes (slash_id, signature, error, attempts, posted_at) VALUES (?, ?, ?, 1, ?)
           ON CONFLICT(slash_id) DO UPDATE SET signature = excluded.signature, error = excluded.error, attempts = chain_slashes.attempts + 1, posted_at = excluded.posted_at`,
        )
        .run(id, r.signature ?? null, r.error ?? null, r.signature ? this.now() : null);
    });
  }

  /** Epochs at or before this belong to a retired deployment (deployments.ts); -1 when none. */
  private retiredThrough(): number {
    return deploymentsOf(this).retiredThrough() ?? -1;
  }

  /** Payout leaves of epochs posted on chain, for the claim mirror. */
  chainPostedLeaves(): { n: number; leaves: PayoutLeaf[] }[] {
    return this.db
      .query<{ n: number; payouts: string }, [number]>("SELECT e.n, e.payouts FROM epochs e JOIN chain_epochs c ON c.n = e.n WHERE c.signature IS NOT NULL AND e.n > ? ORDER BY e.n")
      .all(this.retiredThrough())
      .map((r) => ({ n: r.n, leaves: JSON.parse(r.payouts) as PayoutLeaf[] }));
  }
  /** Records a claim made on chain (a ClaimReceipt exists for the leaf). */
  chainRecordClaim(n: number, l: { agent: string; dest: string; amount: string }) {
    return this.tx(() => {
      const r = this.db
        .query("INSERT OR IGNORE INTO claims (epoch, agent_id, dest, amount, claimed_at) VALUES (?, ?, ?, ?, ?)")
        .run(n, l.agent, l.dest, l.amount, this.now());
      if (r.changes === 0) return false;
      this.ledger.transfer(ACC.payable(n), l.dest, BigInt(l.amount), "claim", `epoch:${n}:${l.agent}:chain`);
      if (l.dest === ACC.compute(l.agent)) this.refreshAwake(l.agent);
      this.emit("epoch.claimed", { n, agent: l.agent, dest: l.dest, amount: l.amount, chain: true });
      return true;
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Read views

  /**
   * Public view unless `admin` or `self`: the public view never shows the agent's open replay
   * count, its eligibility under load or its unbond ready time, because each of them changes when
   * it is handed a sealed assignment (SPEC 17.1).
   */
  agentView(id: string, opts: { admin?: boolean; self?: boolean } = {}) {
    const a = this.agentRow(id);
    if (!a) throw notFound("agent");
    const epoch = this.currentEpoch().n;
    const strikesEpoch = this.db.query<{ c: number }, [string, number]>("SELECT COUNT(*) AS c FROM strikes WHERE agent_id = ? AND epoch = ?").get(id, epoch)!.c;
    const strikesTotal = this.db.query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM strikes WHERE agent_id = ?").get(id)!.c;
    const unitsEpoch =
      this.db.query<{ u: number | null }, [string, number]>("SELECT SUM(units) AS u FROM units WHERE agent_id = ? AND epoch = ? AND voided = 0").get(id, epoch)!.u ?? 0;
    const unitsTotal = this.db.query<{ u: number | null }, [string]>("SELECT SUM(units) AS u FROM units WHERE agent_id = ? AND voided = 0").get(id)!.u ?? 0;
    const slashed = this.db
      .query<{ amount: string }, [string]>("SELECT amount FROM slashes WHERE agent_id = ?")
      .all(id)
      .reduce((s, r) => s + BigInt(r.amount), 0n);
    const shadowRevealed = !!a.shadow && this.shadowRevealed(id);
    const full = !!opts.admin || !!opts.self;
    return {
      agent_id: a.agent_id,
      kind: a.kind,
      operator: a.operator,
      registered_at: a.registered_at,
      reference: !!a.reference,
      hosted: !!a.hosted,
      mint: a.mint,
      launcher: a.launcher,
      target_repo: a.target_repo,
      identity_mode: a.identity_mode,
      lifecycle: a.kind === "launched" ? a.lifecycle : null,
      awake: a.kind === "launched" ? !!a.awake : null,
      wallet: this.ledger.balance(ACC.wallet(id)).toString(),
      bond: this.bondOf(id).toString(),
      compute: this.ledger.balance(ACC.compute(id)).toString(),
      cooling: a.unbond_amount !== "0",
      unbond:
        a.unbond_amount !== "0"
          ? full
            ? { amount: a.unbond_amount, ready_at: a.unbond_ready_at, waiting_on: a.unbond_ready_at === null ? this.hardening.involvement(id).open : [] }
            : { amount: a.unbond_amount, ready_at: null }
          : null,
      suspended: a.suspended_through_epoch >= epoch,
      suspended_through_epoch: a.suspended_through_epoch >= 0 ? a.suspended_through_epoch : null,
      eligible: this.isEligible(a, epoch, !full),
      capabilities: this.capsOf(a),
      capabilities_at: a.capabilities_at,
      qualified_lineages: this.qualifiedLineages(a, epoch, !full),
      qualifications: this.qualificationsOf(id),
      open_replays: full ? this.openReplaysOf(id) : null,
      strikes_epoch: strikesEpoch,
      strikes_total: strikesTotal,
      slashed_total: slashed.toString(),
      units_epoch: unitsEpoch,
      units_total: unitsTotal,
      runway: this.live.runway(id),
      identity: this.identity.view(id, a.registered_at),
      ...(opts.admin || shadowRevealed ? { shadow: !!a.shadow } : {}),
    };
  }

  /** Lineages this agent can be drawn for right now (SPEC 6.1, 10.3). */
  private qualifiedLineages(a: AgentRow, epoch: number, ignoreLoad = false): string[] {
    if (!this.isEligible(a, epoch, ignoreLoad)) return [];
    return this.db
      .query<LineageRow, [string]>(
        "SELECT l.* FROM lineages l JOIN qualifications q ON q.lineage_id = l.lineage_id WHERE q.agent_id = ? AND q.status = 'passed' AND l.status = 'active' ORDER BY l.lineage_id",
      )
      .all(a.agent_id)
      .filter((l) => satisfies(this.capsOf(a), this.recipeOf(l.recipe_id).requires))
      .map((l) => l.lineage_id);
  }

  private shadowRevealed(id: string): boolean {
    const c = this.db.query<{ epoch: number }, [string]>("SELECT epoch FROM candidates WHERE author = ? AND is_canary = 1 LIMIT 1").get(id);
    // only once none of its canaries is still open (SPEC 10.7)
    const open = this.db.query("SELECT 1 FROM candidates WHERE author = ? AND is_canary = 1 AND status IN ('committed','waiting','queued','replaying','disputed') LIMIT 1").get(id);
    return !!c && !open && this.epochRow(c.epoch)?.status === "closed";
  }

  listAgents() {
    return this.db
      .query<{ agent_id: string }, []>("SELECT agent_id FROM agents ORDER BY registered_at, agent_id")
      .all()
      .map((r) => this.agentView(r.agent_id));
  }

  private candidateRevealedAsCanary(c: CandRow): boolean {
    return !!c.is_canary && TERMINAL.has(c.status) && this.epochRow(c.epoch)?.status === "closed";
  }

  /**
   * Public unless `viewer` is a party to the candidate (its author or a team member) or the admin:
   * while the candidate is open the public view withholds `author`, `team` and `commitment`
   * (author-blind replay, SPEC 10.7); `salt` is published once it is final so anyone can recompute
   * the candidate id.
   */
  candidateView(id: string, viewer?: string | null) {
    const c = this.candRow(id);
    if (!c) throw notFound("candidate");
    const terminal = TERMINAL.has(c.status);
    const blind = this.collab.blind(c, viewer);
    const replays = c.candidate_id
      ? this.db.query<ReplayRow, [string]>("SELECT * FROM replays WHERE candidate_id = ? ORDER BY assigned_at, replay_id").all(c.candidate_id)
      : [];
    return {
      commit_id: c.commit_id,
      candidate_id: c.candidate_id,
      lineage_id: c.lineage_id,
      parent_gen_id: c.parent_gen_id,
      eval_parent_gen_id: c.eval_parent_gen_id,
      author: blind ? null : c.author,
      kind: c.kind,
      target: JSON.parse(c.target),
      claimed_effect: c.claimed_effect,
      commitment: blind ? null : c.commitment,
      salt: terminal || !blind ? c.salt : null,
      patch: c.patch,
      patch_hash: c.patch_hash,
      semantic_hash: c.semantic_hash,
      guard: c.guard ? JSON.parse(c.guard) : null,
      status: c.status,
      reason: c.reason,
      detail: c.detail,
      stage: c.stage,
      committed_at: c.committed_at,
      reveal_deadline: c.reveal_deadline,
      revealed_at: c.revealed_at,
      finalized_at: c.finalized_at,
      gen_id: c.gen_id,
      epoch: c.epoch,
      verdict: terminal && c.verdict ? JSON.parse(c.verdict) : null,
      canary: this.candidateRevealedAsCanary(c) ? { canary_id: c.canary_id } : null,
      team: blind ? null : this.collab.teamView(c.commit_id),
      series: this.series.view(c, viewer),
      split: this.split.view(c, blind, terminal),
      port: this.ports.view(c, blind, terminal),
      // replayer identities and results stay hidden until the candidate is final, so nobody can
      // copy, bribe or coordinate with another replayer of the same candidate
      replays: replays.map((r) => this.replayPublic(r, terminal || r.replayer === viewer, !!c.is_canary && !this.candidateRevealedAsCanary(c) && viewer !== this.adminId)),
    };
  }

  /** `maskCanary`: a canary not yet listed shows its passing replays as `counted`, like a real rejection's (audit A2, OFF-04). */
  private replayPublic(r: ReplayRow, full: boolean, maskCanary = false) {
    const kind = r.kind === "reference" ? "replay" : r.kind === "audit_reference" ? "audit" : r.kind;
    const base = { status: r.status, stage: r.stage, assigned_at: r.assigned_at, committed_at: r.committed_at, revealed_at: r.revealed_at };
    if (!full) return { ...base, kind };
    const result = r.result ? (JSON.parse(r.result) as ReplayResult) : null;
    return {
      ...base,
      kind: r.kind,
      replay_id: r.replay_id,
      replayer: r.replayer,
      audit_id: r.audit_id,
      eval_parent_gen_id: r.eval_parent_gen_id,
      seed: r.seed,
      role: maskCanary && r.role === "canary_pass" ? "counted" : r.role,
      commitment: r.commitment,
      transcript_digest: result?.transcript_digest ?? null,
      result,
    };
  }

  /** Candidate summaries; filtering by author returns only candidates whose author `viewer` may see (SPEC 10.7). */
  listCandidates(q: { lineage?: string; status?: string; author?: string; limit?: number }, viewer?: string | null) {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.lineage) (where.push("lineage_id = ?"), args.push(q.lineage));
    if (q.status) (where.push("status = ?"), args.push(q.status));
    if (q.author) {
      where.push("author = ?");
      args.push(q.author);
      const vis = this.collab.visibleAuthorSql(viewer);
      where.push(vis.sql);
      args.push(...vis.args);
    }
    args.push(Math.min(q.limit ?? 200, 1000));
    const rows = this.db
      .query<{ commit_id: string }, (string | number)[]>(
        `SELECT commit_id FROM candidates ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY committed_at DESC, commit_id LIMIT ?`,
      )
      .all(...args);
    return rows.map((r) => {
      const v = this.candidateView(r.commit_id, viewer);
      return { ...v, patch: undefined, replays: undefined, replay_count: v.replays.length };
    });
  }

  /** Ordered canonical patches from gen_0 to gen, skipping reverted ones (SPEC 11.1, 11.3). */
  patchSeries(genId_: string): { gen_id: string; height: number; patch_hash: string; patch: string }[] {
    const chain: GenRow[] = [];
    let g = this.genRow(genId_);
    if (!g) throw notFound("generation");
    while (g) {
      chain.push(g);
      g = g.parent_gen_id ? this.genRow(g.parent_gen_id) : null;
    }
    chain.reverse();
    const reverted = new Set(chain.filter((x) => x.entry_type === "revert").map((x) => x.reverts!));
    return chain
      .filter((x) => x.entry_type === "patch" && !reverted.has(x.gen_id))
      .map((x) => ({ gen_id: x.gen_id, height: x.height, patch_hash: x.patch_hash!, patch: x.patch! }));
  }

  tree(lineage: string, gen?: string) {
    const l = this.lineageRow(lineage);
    if (!l) throw notFound("lineage");
    const g = gen ? this.genRow(gen) : this.genRow(l.tip);
    if (!g || g.lineage_id !== lineage) throw notFound("generation");
    const snap = this.db.query<{ commit_sha: string; deps_digest: string }, [string]>("SELECT * FROM snapshots WHERE snapshot_id = ?").get(l.snapshot_id)!;
    const repo = this.db.query<{ url: string }, [string]>("SELECT url FROM repos WHERE repo_id = ?").get(l.repo_id)!;
    return { lineage_id: lineage, gen_id: g.gen_id, height: g.height, repo: repo.url, commit: snap.commit_sha, deps_digest: snap.deps_digest, patches: this.patchSeries(g.gen_id) };
  }

  generationView(id: string) {
    const g = this.genRow(id);
    if (!g) throw notFound("generation");
    const replays = g.candidate_id
      ? this.db.query<ReplayRow, [string]>("SELECT * FROM replays WHERE candidate_id = ? ORDER BY assigned_at, replay_id").all(g.candidate_id)
      : [];
    const audit = this.db.query<AuditRow, [string]>("SELECT * FROM audits WHERE gen_id = ?").get(id);
    return {
      gen_id: g.gen_id,
      lineage_id: g.lineage_id,
      parent_gen_id: g.parent_gen_id,
      height: g.height,
      entry_type: g.entry_type,
      candidate_id: g.candidate_id,
      patch_hash: g.patch_hash,
      patch: g.patch,
      kind: g.kind,
      target: g.target ? JSON.parse(g.target) : null,
      effect: g.effect ? JSON.parse(g.effect) : null,
      verdict_digest: g.verdict_digest,
      verdict: g.verdict ? JSON.parse(g.verdict) : null,
      replay_ids: g.replay_ids ? JSON.parse(g.replay_ids) : [],
      author: g.author,
      team: g.candidate_id ? this.collab.teamView(this.candByCandidateId(g.candidate_id)?.commit_id ?? "") : null,
      accepted_at: g.accepted_at,
      epoch: g.epoch,
      reverts: g.reverts,
      reverted_by: g.reverted_by,
      needs_revalidation: !!g.needs_revalidation,
      audit: audit
        ? { audit_id: audit.audit_id, status: audit.status, detail: audit.status === "pending" ? null : audit.detail, verdict: audit.status === "pending" ? null : JSON.parse(audit.verdict ?? "null") }
        : null,
      replays: replays.map((r) => this.replayPublic(r, audit?.status !== "pending" || !r.audit_id)),
    };
  }

  lineageView(id: string) {
    const l = this.lineageRow(id);
    if (!l) throw notFound("lineage");
    const recipe = this.recipeOf(l.recipe_id);
    const snap = this.db.query<Record<string, unknown>, [string]>("SELECT * FROM snapshots WHERE snapshot_id = ?").get(l.snapshot_id)!;
    const repo = this.db.query<{ url: string }, [string]>("SELECT url FROM repos WHERE repo_id = ?").get(l.repo_id)!;
    const cal = this.db.query<{ json: string; submitted_by: string; sig: string; created_at: number }, [string]>("SELECT * FROM calibrations WHERE calib_id = ?").get(l.calib_id)!;
    const gens = this.db.query<GenRow, [string]>("SELECT * FROM generations WHERE lineage_id = ? ORDER BY height").all(id);
    const counts = Object.fromEntries(
      this.db
        .query<{ status: string; c: number }, [string]>("SELECT status, COUNT(*) AS c FROM candidates WHERE lineage_id = ? GROUP BY status")
        .all(id)
        .map((r) => [r.status, r.c]),
    );
    return {
      lineage_id: l.lineage_id,
      repo: repo.url,
      repo_id: l.repo_id,
      snapshot: snap,
      recipe_id: l.recipe_id,
      recipe,
      calib_id: l.calib_id,
      calibration: JSON.parse(cal.json),
      calibration_by: cal.submitted_by,
      calibration_sig: cal.sig,
      gen0: l.gen0,
      tip: l.tip,
      height: l.height,
      status: l.status,
      created_at: l.created_at,
      candidate_counts: counts,
      generations: gens.map((g) => ({
        gen_id: g.gen_id,
        parent_gen_id: g.parent_gen_id,
        height: g.height,
        entry_type: g.entry_type,
        candidate_id: g.candidate_id,
        patch_hash: g.patch_hash,
        kind: g.kind,
        target: g.target ? JSON.parse(g.target) : null,
        effect: g.effect ? JSON.parse(g.effect) : null,
        author: g.author,
        accepted_at: g.accepted_at,
        epoch: g.epoch,
        replay_ids: g.replay_ids ? JSON.parse(g.replay_ids) : [],
        reverts: g.reverts,
        reverted_by: g.reverted_by,
        needs_revalidation: !!g.needs_revalidation,
        audit_status: g.audit_status,
      })),
    };
  }

  listLineages() {
    return this.db
      .query<LineageRow & { url: string; name: string }, []>(
        "SELECT l.*, r.url AS url, rc.name AS name FROM lineages l JOIN repos r ON r.repo_id = l.repo_id JOIN recipes rc ON rc.recipe_id = l.recipe_id ORDER BY l.created_at",
      )
      .all()
      .map((l) => ({
        lineage_id: l.lineage_id,
        repo: l.url,
        recipe_name: l.name,
        recipe_id: l.recipe_id,
        snapshot_id: l.snapshot_id,
        calib_id: l.calib_id,
        gen0: l.gen0,
        tip: l.tip,
        height: l.height,
        status: l.status,
        created_at: l.created_at,
      }));
  }

  findings(lineage?: string, status = "open") {
    const rows = lineage
      ? this.db.query<Record<string, unknown>, [string, string]>("SELECT * FROM findings WHERE lineage_id = ? AND status = ? ORDER BY created_at").all(lineage, status)
      : this.db.query<Record<string, unknown>, [string]>("SELECT * FROM findings WHERE status = ? ORDER BY created_at").all(status);
    return rows;
  }

  assignmentView(r: ReplayRow) {
    const c = this.candByCandidateId(r.candidate_id)!;
    const { l, recipe, calib } = this.lineageCtx(c, r.eval_parent_gen_id);
    const snap = this.db.query<{ commit_sha: string; deps_digest: string }, [string]>("SELECT * FROM snapshots WHERE snapshot_id = ?").get(l.snapshot_id)!;
    const repo = this.db.query<{ url: string }, [string]>("SELECT url FROM repos WHERE repo_id = ?").get(l.repo_id)!;
    return {
      replay_id: r.replay_id,
      kind: r.kind === "reference" || r.kind === "audit_reference" ? "reference" : r.kind === "audit" ? "audit" : "replay",
      status: r.status,
      reveal_open: r.status === "committed" && r.reveal_open_at !== null,
      assigned_at: r.assigned_at,
      commit_deadline: r.commit_deadline,
      reveal_deadline: r.reveal_deadline,
      seed: r.seed,
      lineage: { lineage_id: l.lineage_id, repo: repo.url, commit: snap.commit_sha, snapshot_id: l.snapshot_id, deps_digest: snap.deps_digest },
      recipe_id: l.recipe_id,
      recipe,
      calibration: calib,
      parent_gen_id: r.eval_parent_gen_id,
      parent_series: this.patchSeries(r.eval_parent_gen_id),
      candidate: { candidate_id: c.candidate_id, kind: c.kind, target: JSON.parse(c.target), patch: c.patch, patch_hash: c.patch_hash },
      split: this.split.assignment(c, r),
    };
  }

  assignments(agent: string) {
    this.mustAgent(agent);
    const replays = this.db
      .query<ReplayRow, [string]>("SELECT * FROM replays WHERE replayer = ? AND status IN ('assigned','committed') ORDER BY assigned_at, replay_id")
      .all(agent)
      .map((r) => this.assignmentView(r) as ReturnType<Core["assignmentView"]> | ReturnType<Core["qualificationAssignmentView"]>);
    const quals = this.db
      .query<QualRow, [string]>("SELECT * FROM qualifications WHERE agent_id = ? AND status IN ('assigned','committed') ORDER BY assigned_at, qual_id")
      .all(agent)
      .map((q) => this.qualificationAssignmentView(q));
    return [...replays, ...quals];
  }

  epochView(n: number) {
    const ep = this.epochRow(n);
    if (!ep) throw notFound("epoch");
    const closed = ep.status === "closed";
    const units = this.db
      .query<{ agent_id: string; kind: string; u: number; rebate: string; c: number }, [number]>(
        "SELECT agent_id, kind, SUM(units) AS u, COUNT(*) AS c, GROUP_CONCAT(rebate) AS rebate FROM units WHERE epoch = ? AND voided = 0 GROUP BY agent_id, kind ORDER BY agent_id, kind",
      )
      .all(n)
      .map((r) => ({ agent: r.agent_id, kind: r.kind, units: r.u, count: r.c, rebate: r.rebate.split(",").reduce((s, x) => s + BigInt(x), 0n).toString() }));
    const rounds = closed
      ? this.db
          .query<Record<string, unknown>, [number]>("SELECT subject, round, bucket, beacon, assignment_seed, pool, exclude, count, chosen, reference, created_at FROM assignment_rounds WHERE epoch = ? ORDER BY id")
          .all(n)
          // a round names its subject's exclusions (the author) and its replayers: withheld until the subject is final (SPEC 10.7)
          .filter((r) => this.collab.subjectFinal(String(r.subject)))
          .map((r) => ({ ...r, pool: JSON.parse(String(r.pool)), exclude: JSON.parse(String(r.exclude)), chosen: JSON.parse(String(r.chosen)) }))
      : undefined;
    return {
      n: ep.n,
      status: ep.status,
      start_ms: ep.start_ms,
      end_ms: ep.end_ms,
      beacon_commit: ep.beacon_commit,
      // the secret recomputes every assignment draw of this epoch: published only once every subject
      // drawn in it is final, or it would name the replayers of candidates still open (SPEC 10.3, 10.7)
      secret: closed && this.epochSubjectsFinal(n) ? ep.secret : null,
      closed_at: ep.closed_at,
      pool_amount: ep.pool_amount,
      rebate_amount: ep.rebate_amount,
      total_units: closed ? ep.total_units : units.reduce((s, u) => s + u.units, 0),
      units,
      payouts: closed ? JSON.parse(ep.payouts!) : null,
      root: ep.root,
      lineage_root: ep.lineage_root,
      record_root: ep.record_root ?? null,
      // a canary still open at close is listed once it is final: its replayers must not learn it early (SPEC 10.5, 10.7)
      canaries: closed ? (JSON.parse(ep.canaries!) as { candidate_id: string | null }[]).filter((x) => !x.candidate_id || this.collab.subjectFinal(x.candidate_id)) : null,
      assignment_rounds: rounds,
      // M2 slot beacon (SPEC 10.3): each draw's request, anchor, target, slot and hash, and the canary and audit decisions
      ...(closed && this.slotBeacon ? { slot_beacon: this.slotBeacon.epochRecord(n, (s, kind) => (kind === "canary" ? this.slotBeacon!.canaryFinal(s, (x) => this.collab.subjectFinal(x)) : kind === "audit" || this.collab.subjectFinal(s))) } : {}),
      usage: this.db.query<Record<string, unknown>, [number]>("SELECT * FROM usage WHERE epoch = ? ORDER BY id").all(n),
    };
  }

  /** True when every subject drawn with this epoch's beacon (candidates, audits, qualifications) is final. */
  epochSubjectsFinal(n: number): boolean {
    const subjects = this.db.query<{ subject: string }, [number]>("SELECT DISTINCT subject FROM assignment_rounds WHERE epoch = ?").all(n);
    // a slot draw requested with this epoch's secret and not made yet would be computable once both are public
    if (this.slotBeacon?.pendingIn(n)) return false;
    return subjects.every((r) => this.collab.subjectFinal(String(r.subject)));
  }

  listEpochs() {
    return this.db
      .query<EpochRow, []>("SELECT * FROM epochs ORDER BY n DESC")
      .all()
      .map((e) => ({ n: e.n, status: e.status, start_ms: e.start_ms, end_ms: e.end_ms, beacon_commit: e.beacon_commit, root: e.root, pool_amount: e.pool_amount, rebate_amount: e.rebate_amount, total_units: e.total_units }));
  }

  stats() {
    const one = (sql: string) => this.db.query<{ c: number }, []>(sql).get()!.c;
    return {
      lineages: one("SELECT COUNT(*) AS c FROM lineages"),
      generations: one("SELECT COUNT(*) AS c FROM generations WHERE entry_type = 'patch'"),
      candidates: one("SELECT COUNT(*) AS c FROM candidates"),
      agents: one("SELECT COUNT(*) AS c FROM agents"),
      epoch: this.currentEpoch().n,
      ...this.live.stats(),
      balances: { treasury: this.ledger.balance(ACC.treasury).toString(), reserve: this.ledger.balance(ACC.reserve).toString(), pool: this.ledger.balance(ACC.pool).toString(), burned: this.ledger.balance(ACC.burned).toString() },
      ...(this.chainMode ? { chain: this.chainView?.() ?? null } : {}),
    };
  }
}

function normTarget(kind: CandidateKind, t: unknown): string | string[] {
  if (kind === "fix") {
    const arr = typeof t === "string" ? [t] : t;
    if (!strArr(arr) || arr.length === 0) throw bad("bad_target", "fix target is a non-empty list of test ids");
    return [...new Set(arr)].sort();
  }
  if (typeof t !== "string" || !t) throw bad("bad_target", `${kind} target is a metric name`);
  return t;
}

function validateRecipe(r: Recipe) {
  const ok =
    typeof r.name === "string" &&
    typeof r.repo === "string" &&
    typeof r.commit === "string" &&
    typeof r.image === "string" &&
    isObj(r.build) &&
    isObj(r.test) &&
    Array.isArray(r.metrics) &&
    isObj(r.patch) &&
    strArr(r.patch.allowed_paths) &&
    strArr(r.patch.protected_paths) &&
    typeof r.patch.max_files === "number" &&
    typeof r.patch.max_lines === "number";
  if (!ok) throw bad("bad_recipe", "recipe missing required fields (name, repo, commit, image, build, test, metrics, patch)");
  // SPEC 6.1: every recipe names its target class and the hardware a verifier needs
  if (typeof r.class !== "string" || !CLASSES.has(r.class)) throw bad("bad_recipe", `class must be one of ${[...CLASSES].join(", ")}`);
  const req = r.requires as unknown;
  if (!isObj(req)) throw bad("bad_recipe", "requires { arch, gpu?, min_cpus?, min_memory_mb? } is required");
  for (const k of Object.keys(req)) if (!["arch", "gpu", "min_cpus", "min_memory_mb"].includes(k)) throw bad("bad_recipe", `unknown requires field ${k}`);
  if (typeof req.arch !== "string" || !ARCHES.has(req.arch)) throw bad("bad_recipe", "requires.arch must be amd64 or arm64");
  for (const k of ["min_cpus", "min_memory_mb"] as const)
    if (req[k] !== undefined && (typeof req[k] !== "number" || !Number.isInteger(req[k]) || (req[k] as number) < 1)) throw bad("bad_recipe", `requires.${k} must be a positive integer`);
  if (req.gpu !== undefined) {
    const g = req.gpu;
    if (!isObj(g) || g.vendor !== "nvidia" || typeof g.sm !== "string" || !/^\d{1,2}\.\d{1,2}$/.test(g.sm))
      throw bad("bad_recipe", 'requires.gpu must be { vendor: "nvidia", sm: "<major.minor>", min_mem_gb? }');
    for (const k of Object.keys(g)) if (!["vendor", "sm", "min_mem_gb"].includes(k)) throw bad("bad_recipe", `unknown requires.gpu field ${k}`);
    if (g.min_mem_gb !== undefined && (typeof g.min_mem_gb !== "number" || !(g.min_mem_gb > 0))) throw bad("bad_recipe", "requires.gpu.min_mem_gb must be positive");
  }
  if (r.class === "cuda" && !req.gpu) throw bad("bad_recipe", "a cuda recipe must require a gpu");
  for (const m of r.metrics) {
    if (!isObj(m) || typeof m.name !== "string" || !["perf", "slim"].includes(m.kind) || !["lower", "higher"].includes(m.direction) || typeof m.min_effect !== "number")
      throw bad("bad_recipe", "each metric needs name, kind (perf|slim), direction and min_effect");
  }
}

function validateResult(r: ReplayResult) {
  const ok =
    (r.apply === "ok" || r.apply === "conflict") &&
    typeof r.guard === "string" &&
    isObj(r.build) &&
    isObj(r.tests) &&
    strArr(r.tests.base_pass) &&
    strArr(r.tests.cand_pass) &&
    strArr(r.tests.cand_fail) &&
    isObj(r.metrics) &&
    isObj(r.env) &&
    typeof r.transcript_digest === "string" &&
    HEX64.test(r.transcript_digest);
  if (!ok) throw bad("bad_result", "result does not match the ReplayResult shape (SPEC 4.3); transcript_digest must be a sha256 hex");
  for (const [k, m] of Object.entries(r.metrics)) {
    if (!isObj(m) || !Array.isArray(m.base) || !Array.isArray(m.cand) || ![...m.base, ...m.cand].every((x) => typeof x === "number" && Number.isFinite(x)))
      throw bad("bad_result", `metric ${k} samples must be finite numbers`);
  }
}

const ARCHES = new Set(["amd64", "arm64"]);
const CLASSES = new Set(["rust", "solana", "zig", "cuda", "python", "go", "cpp"]);
const CAP_KEYS = new Set(["arch", "cpus", "memory_mb", "gpus"]);
const GPU_KEYS = new Set(["vendor", "model", "sm", "mem_gb", "driver"]);

/** Strict validation of declared capabilities (SPEC 6.1). Unknown keys are refused, not ignored. */
export function validateCapabilities(v: unknown): Capabilities {
  const fail = (m: string): never => {
    throw bad("bad_capabilities", m);
  };
  if (!isObj(v)) fail("capabilities must be an object { arch, cpus, memory_mb, gpus }");
  const c = v as Record<string, unknown>;
  for (const k of Object.keys(c)) if (!CAP_KEYS.has(k)) fail(`unknown capability field ${k}`);
  if (typeof c.arch !== "string" || !ARCHES.has(c.arch)) fail("arch must be amd64 or arm64");
  if (typeof c.cpus !== "number" || !Number.isInteger(c.cpus) || c.cpus < 1 || c.cpus > 4096) fail("cpus must be an integer from 1 to 4096");
  if (typeof c.memory_mb !== "number" || !Number.isInteger(c.memory_mb) || c.memory_mb < 64 || c.memory_mb > 64 * 1024 * 1024)
    fail("memory_mb must be an integer from 64 to 67108864");
  const gpus = c.gpus === undefined ? [] : c.gpus;
  if (!Array.isArray(gpus) || gpus.length > 64) fail("gpus must be an array of at most 64 entries");
  const out: Capabilities["gpus"] = [];
  for (const g of gpus as unknown[]) {
    if (!isObj(g)) fail("each gpu must be an object { vendor, model, sm, mem_gb, driver }");
    const x = g as Record<string, unknown>;
    for (const k of Object.keys(x)) if (!GPU_KEYS.has(k)) fail(`unknown gpu field ${k}`);
    if (x.vendor !== "nvidia") fail("gpu vendor must be nvidia");
    if (typeof x.model !== "string" || !/^[\w .()+/-]{1,128}$/.test(x.model)) fail("gpu model must be 1-128 printable characters");
    if (typeof x.sm !== "string" || !/^\d{1,2}\.\d{1,2}$/.test(x.sm)) fail('gpu sm must be a compute capability like "8.9"');
    if (typeof x.mem_gb !== "number" || !Number.isFinite(x.mem_gb) || x.mem_gb <= 0 || x.mem_gb > 4096) fail("gpu mem_gb must be a positive number");
    if (typeof x.driver !== "string" || !/^[\w.-]{1,32}$/.test(x.driver)) fail("gpu driver must be a version string");
    out.push({ vendor: "nvidia", model: x.model as string, sm: x.sm as string, mem_gb: x.mem_gb as number, driver: x.driver as string });
  }
  return { arch: c.arch as Capabilities["arch"], cpus: c.cpus as number, memory_mb: c.memory_mb as number, gpus: out };
}

/**
 * Qualification verdict (SPEC 6.1): the base build works, the base tests reproduce the calibrated
 * stable set exactly (quarantined and excluded tests aside), and every enabled deterministic metric's
 * base value equals the calibrated base_value within the metric's tolerance.
 */
export function qualificationVerdict(recipe: Recipe, calib: Calibration, r: ReplayResult, det_tolerance: number): { pass: boolean; reason: string } {
  if (r.build.base !== "ok") return { pass: false, reason: "base build failed" };
  const ignore = new Set([...(recipe.test.exclude ?? []), ...calib.quarantined]);
  const base = [...new Set(r.tests.base_pass.filter((t) => !ignore.has(t)))].sort();
  const stable = [...new Set(calib.stable)].sort();
  const missing = stable.filter((t) => !base.includes(t));
  const extra = base.filter((t) => !stable.includes(t));
  if (missing.length || extra.length)
    return { pass: false, reason: `base tests differ from the calibrated stable set (missing ${missing.slice(0, 5).join(", ") || "none"}; extra ${extra.slice(0, 5).join(", ") || "none"})` };
  const checked: string[] = [];
  for (const m of recipe.metrics) {
    if (!m.deterministic) continue;
    const cm = calib.metrics[m.name];
    if (!cm?.enabled || typeof cm.base_value !== "number") continue;
    const s = r.metrics[m.name];
    if (!s || s.base.length === 0) return { pass: false, reason: `no base sample for ${m.name}` };
    const v = median(s.base);
    const tol = m.tolerance ?? det_tolerance;
    if (relDiff(v, cm.base_value) > tol) return { pass: false, reason: `${m.name} base ${v} differs from calibrated ${cm.base_value} beyond tolerance ${tol}` };
    checked.push(m.name);
  }
  return { pass: true, reason: `stable set reproduced; ${checked.length ? `${checked.join(", ")} match calibration` : "no deterministic base values to compare"}` };
}

const SEED_INDEPENDENT_REJECTS = new Set(["guard", "apply_conflict", "build_fail", "tests_fail", "fix_target_not_fixed"]);

/**
 * Audit status from the combined judgement (SPEC 10.6). `settled` means the judgement resolved, so
 * minority replays are slashed and counted audit replays are paid even when the status is
 * inconclusive (a noisy miss on fresh inputs is honest work).
 */
export function auditOutcome(
  recipe: Recipe,
  cand: CandidateView,
  j: Judgement,
  origIds: Set<string>,
  auditReplays: RevealedReplay[],
  auditCounted: number,
): { status: AuditRow["status"]; detail: string; settled: boolean } {
  if (auditCounted === 0) return { status: "inconclusive", detail: "no audit replay counted (environment failures or none revealed)", settled: false };
  if (j.outcome === "pending" || j.outcome === "disputed")
    return { status: "inconclusive", detail: `audit judgement ${j.outcome}: ${j.detail ?? ""}`.trim(), settled: false };
  const contradicted = j.minority.filter((id) => origIds.has(id));
  if (contradicted.length)
    return { status: "reverted", detail: `original replays contradicted on ${j.disputed_fields.join(", ") || "a deterministic field"}`, settled: true };
  if (j.outcome === "rejected" && SEED_INDEPENDENT_REJECTS.has(j.reason!))
    return { status: "reverted", detail: `seed-independent rejection: ${j.reason} (${j.detail ?? ""})`, settled: true };
  const counted = new Set(j.counted);
  const agreeing = auditReplays.filter((r) => counted.has(r.replay_id));
  if (cand.kind !== "fix" && recipe.equivalence && agreeing.some((r) => r.result.equivalence && r.result.equivalence.base_digest !== r.result.equivalence.cand_digest))
    return { status: "reverted", detail: "behaviour differs from the parent on the audit's fresh inputs (equivalence)", settled: true };
  if (j.outcome === "accepted") return { status: "agreed", detail: "audit replays reproduce the generation", settled: true };
  const metricName = Array.isArray(cand.target) ? cand.target[0] : cand.target;
  const metric = recipe.metrics.find((m) => m.name === metricName);
  if (j.reason === "no_improvement" || j.reason === "noisy_split") {
    if (metric?.deterministic)
      return { status: "weak", detail: `fresh-seed ${metricName} does not reach min_effect: ${j.detail ?? ""}; recorded, not reverted in M1`, settled: true };
    return { status: "inconclusive", detail: `noisy ${metricName} on a fresh seed: ${j.reason} (${j.detail ?? ""}); not a contradiction`, settled: true };
  }
  return { status: "inconclusive", detail: `audit judgement rejected ${j.reason}: ${j.detail ?? ""}`, settled: true };
}
