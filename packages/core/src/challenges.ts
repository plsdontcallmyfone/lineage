import { createHash } from "node:crypto";
import type { Address, ChainReader, Ix, RegistryConfig } from "@lineage/chain";
import { CHALLENGE_KIND, CHALLENGE_OUTCOME, challenge as challengeIx, epochSubject } from "@lineage/chain";
import type { Core } from "./core.ts";
import { ApiError, bad, conflict, forbidden, notFound } from "./errors.ts";
import { ACC } from "./ledger.ts";
import { computePayouts, lineageRootOf } from "./replica.ts";
import {
  H,
  hashJson,
  judge,
  merkleRoot,
  resultCommitment,
  type Calibration,
  type CandidateView,
  type Judgement,
  type Recipe,
  type RevealedReplay,
} from "./protocol.ts";

// Bonded challenges (SPEC 10.8, milestone M4). Any registered agent may contest, within
// `challenge_window_s`, a final verdict, a slash or a closed epoch's roots by bonding
// `challenge_bond`. Core resolves each one:
//
// - verdict: fresh random replays (`challenge_replayers` plus the reference runner) drawn from
//   eligible verifiers excluding every party (the author, its team and series, every replayer of the
//   candidate, the challenger, their operators), on the original stage's shared seed, judged together
//   with the original replays. Upheld when an original counted replay ends in the minority on a
//   deterministic field, or the outcome flips for a reason that is not noise: the wrong side is
//   slashed (`minority_slash_bps`), an accepted generation is reverted (SPEC 11.3), a wrongly
//   rejected candidate is queued again on the tip (its commitment time kept). Failed otherwise.
// - slash: a reveal mismatch and a canary are recomputed (no replays needed); a minority slash is
//   re-judged with fresh replays as above on the slashed replay's seed. Upheld: the slash is reversed
//   (amount back into the bond, the strike removed) and anyone now in the minority is slashed.
// - epoch: Core recomputes the payout, lineage and record roots from its records (src/replica.ts,
//   the same rules a replica uses) and compares them with what it published and, in chain mode,
//   with the posted Epoch. Upheld: the recomputed roots replace the published ones.
//
// Upheld: the bond comes back with `challenge_reward` from the compute reserve; failed: the bond
// goes to the reserve; void (too few independent verifiers before the deadline, or a split
// judgement): the bond comes back. Payouts of an epoch with an open challenge are held; on chain the
// registry also holds every epoch for its window (`claim` refuses). In chain mode the challenge is
// opened on chain (open_challenge), Core mirrors it each sync and records its resolution with
// `resolve_challenge` (packages/chain challenge.ts), correcting a posted epoch's roots before any
// claim when the resolution changed them.

const TERMINAL = new Set(["accepted", "rejected", "expired"]);
const OPEN = ["open", "replaying"];
const KINDS = ["verdict", "slash", "epoch"] as const;
type Kind = (typeof KINDS)[number];

export const CHALLENGES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS challenges (
    challenge_id TEXT PRIMARY KEY,       -- H("challenge", kind, subject_hex)
    kind TEXT NOT NULL,                  -- verdict | slash | epoch
    subject TEXT NOT NULL,               -- candidate id | slash id (hex) | epoch number
    subject_hex TEXT NOT NULL,           -- the 32-byte onchain subject
    epoch INTEGER NOT NULL,              -- the epoch whose payouts it holds (slash: the slash's epoch)
    challenger TEXT NOT NULL,
    claim TEXT,                          -- the challenger's statement (JSON), optional
    claim_digest TEXT NOT NULL,
    bond TEXT NOT NULL,
    status TEXT NOT NULL,                -- open | replaying | upheld | failed | void | expired
    opened_at INTEGER NOT NULL,
    deadline INTEGER NOT NULL,           -- Core resolves before this (ms)
    started_at INTEGER,
    resolved_at INTEGER,
    detail TEXT,
    resolution TEXT,                     -- JSON evidence document
    evidence TEXT,                       -- hashJson(resolution)
    reward TEXT,
    source TEXT NOT NULL,                -- sim | chain
    chain_address TEXT,
    refund_token TEXT,
    chain_status TEXT,
    resolve_sig TEXT,
    resolve_error TEXT,
    resolve_attempts INTEGER NOT NULL DEFAULT 0,
    resolve_next_at INTEGER,
    UNIQUE (kind, subject)
  );
  CREATE INDEX IF NOT EXISTS challenges_status ON challenges(status, deadline);
  CREATE INDEX IF NOT EXISTS challenges_epoch ON challenges(epoch, status);
  CREATE TABLE IF NOT EXISTS slash_reversals (
    slash_row INTEGER PRIMARY KEY,       -- slashes.id
    challenge_id TEXT NOT NULL,
    amount TEXT NOT NULL,
    at INTEGER NOT NULL
  );
`;

interface Row {
  challenge_id: string;
  kind: Kind;
  subject: string;
  subject_hex: string;
  epoch: number;
  challenger: string;
  claim: string | null;
  claim_digest: string;
  bond: string;
  status: string;
  opened_at: number;
  deadline: number;
  started_at: number | null;
  resolved_at: number | null;
  detail: string | null;
  resolution: string | null;
  evidence: string | null;
  reward: string | null;
  source: "sim" | "chain";
  chain_address: string | null;
  refund_token: string | null;
  chain_status: string | null;
  resolve_sig: string | null;
  resolve_error: string | null;
  resolve_attempts: number;
  resolve_next_at: number | null;
}
interface CandLite {
  commit_id: string;
  candidate_id: string | null;
  lineage_id: string;
  author: string;
  kind: string;
  target: string;
  status: string;
  stage: number;
  eval_parent_gen_id: string;
  finalized_at: number | null;
  is_canary: number;
  gen_id: string | null;
  verdict: string | null;
}
interface ReplayLite {
  replay_id: string;
  candidate_id: string;
  grp: string;
  audit_id: string | null;
  replayer: string;
  kind: string;
  stage: number;
  eval_parent_gen_id: string;
  seed: string;
  status: string;
  commitment: string | null;
  result: string | null;
  salt: string | null;
  role: string | null;
}
interface SlashRow {
  id: number;
  agent_id: string;
  bps: number;
  amount: string;
  reason: string;
  ref: string;
  epoch: number;
  at: number;
}
interface EpochLite {
  n: number;
  status: string;
  start_ms: number;
  closed_at: number | null;
  pool_amount: string | null;
  rebate_amount: string | null;
  total_units: number | null;
  payouts: string | null;
  root: string | null;
  lineage_root: string | null;
  record_root?: string | null;
}

/** The parts of Core this module drives (Core passes itself; the private members exist at runtime). */
interface Internals {
  db: Core["db"];
  cfg: Core["cfg"];
  ledger: Core["ledger"];
  chainMode: boolean;
  now(): number;
  tx<T>(fn: () => T): T;
  currentEpoch(): { n: number };
  emitEvent(type: string, data: unknown): void;
  agentRow(id: string): { agent_id: string; operator: string | null; reference: number; shadow: number; kind: string; launcher: string | null;
    suspended_through_epoch: number } | null;
  candByCandidateId(id: string): CandLite | null;
  candRow(id: string): CandLite | null;
  genRow(id: string): { gen_id: string; reverted_by: string | null; entry_type: string; epoch: number } | null;
  replayRow(id: string): ReplayLite | null;
  lineageRow(id: string): { lineage_id: string; tip: string; recipe_id: string; calib_id: string } | null;
  lineageCtx(c: CandLite, evalParent?: string): { l: unknown; recipe: Recipe; calib: Calibration };
  calibOf(id: string): Calibration;
  viewOf(c: CandLite): CandidateView;
  asRevealed(r: ReplayLite): RevealedReplay;
  revealedOf(grp: string): RevealedReplay[];
  judgeCfg(quorum?: number): { quorum: number; det_tolerance: number; bootstrap_resamples: number };
  draw(subject: string, round: number, count: number, wantRef: boolean, ex: Set<string>, exOps: Set<string>, requireFull: boolean, lineage: unknown):
    { chosen: string[]; reference: string | null; seed: string; epoch: number } | null;
  replayWindowMs(calib: Calibration): number;
  slash(agent: string, bps: number, reason: string, ref: string): bigint;
  strike(agent: string, reason: string, ref: string): void;
  awardReplay(r: ReplayLite, calib: Calibration): void;
  revert(genId: string, j: Judgement): void;
  voidUnits(where: string, ref: string): void;
  fillWants(): void;
  destFor(agent: string, kind: string): string;
  epochRow(n: number): EpochLite | null;
  collab: Core["collab"];
  series: Core["series"];
}

/** Core's onchain slash id (chain.ts `slashId`), the SlashReceipt seed and a slash challenge's subject. */
export function slashIdOf(sl: { id: number; agent_id: string; reason: string; ref: string; epoch: number }): string {
  return createHash("sha256").update(JSON.stringify(["lineage-slash", sl.id, sl.agent_id, sl.reason, sl.ref, sl.epoch])).digest("hex");
}
export const challengeId = (kind: Kind, subjectHex: string) => H("challenge", kind, subjectHex);
const epochHex = (n: number) => Buffer.from(epochSubject(n)).toString("hex");

const instances = new WeakMap<Core, Challenges>();
/** The one Challenges of a Core (created on first use, schema included). */
export function challengesOf(core: Core): Challenges {
  let c = instances.get(core);
  if (!c) instances.set(core, (c = new Challenges(core)));
  return c;
}

/** ChallengeConfig as read from chain (chain mode); Core's config otherwise. */
interface Params {
  window_s: number;
  bond: bigint;
  reward: bigint;
  resolve_timeout_s: number;
  replayers: number;
}

export class Challenges {
  private readonly c: Internals;
  private chainParams: Params | null = null;

  constructor(core: Core) {
    this.c = core as unknown as Internals;
    this.ensure();
  }

  /**
   * The schema is created lazily; a first use inside a transaction that rolls back takes the tables
   * with it, so every entry point re-runs the idempotent CREATE IF NOT EXISTS.
   */
  private ensure() {
    this.c.db.exec(CHALLENGES_SCHEMA);
  }

  params(): Params {
    const cfg = this.c.cfg;
    const local: Params = { window_s: cfg.challenge_window_s ?? 3600, bond: cfg.challenge_bond ?? 0n, reward: cfg.challenge_reward ?? 0n,
      resolve_timeout_s: cfg.challenge_resolve_timeout_s ?? 7200, replayers: cfg.challenge_replayers ?? 1 };
    return this.chainParams ? { ...this.chainParams, replayers: local.replayers } : local;
  }

  private row(id: string): Row | null {
    return this.c.db.query<Row, [string]>("SELECT * FROM challenges WHERE challenge_id = ?").get(id);
  }

  // ---------------------------------------------------------------------------------------------
  // Views

  configView() {
    this.ensure();
    const p = this.params();
    return { source: this.chainParams ? "chain" : "config", window_s: p.window_s, bond: p.bond.toString(), reward: p.reward.toString(),
      resolve_timeout_s: p.resolve_timeout_s, replayers: p.replayers };
  }

  view(r: Row) {
    const replays = this.c.db
      .query<ReplayLite, [string]>("SELECT * FROM replays WHERE grp = ? ORDER BY replay_id")
      .all(`chal:${r.challenge_id}`)
      .map((x) => ({ replay_id: x.replay_id, kind: x.kind, status: x.status, role: x.role, replayer: TERMINAL_CH.has(r.status) ? x.replayer : null }));
    return {
      challenge_id: r.challenge_id, kind: r.kind, subject: r.subject, subject_hex: r.subject_hex, epoch: r.epoch, challenger: r.challenger,
      claim: r.claim ? JSON.parse(r.claim) : null, claim_digest: r.claim_digest, bond: r.bond, status: r.status, opened_at: r.opened_at, deadline: r.deadline,
      started_at: r.started_at, resolved_at: r.resolved_at, detail: r.detail, resolution: r.resolution ? JSON.parse(r.resolution) : null, evidence: r.evidence,
      reward: r.reward, source: r.source, chain: r.source === "chain" ? { address: r.chain_address, status: r.chain_status, resolve_signature: r.resolve_sig,
        resolve_error: r.resolve_error } : null, replays,
    };
  }

  list(q: { status?: string; kind?: string; challenger?: string; epoch?: string } = {}) {
    this.ensure();
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.status && q.status !== "all") (where.push("status = ?"), args.push(q.status));
    if (q.kind) (where.push("kind = ?"), args.push(q.kind));
    if (q.challenger) (where.push("challenger = ?"), args.push(q.challenger));
    if (q.epoch !== undefined) (where.push("epoch = ?"), args.push(Number(q.epoch)));
    return this.c.db
      .query<Row, (string | number)[]>(`SELECT * FROM challenges ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY opened_at DESC, challenge_id LIMIT 500`)
      .all(...args)
      .map((r) => this.view(r));
  }

  one(id: string) {
    this.ensure();
    const r = this.row(id);
    if (!r) throw notFound("challenge");
    return this.view(r);
  }

  // ---------------------------------------------------------------------------------------------
  // Opening (simulated mode; chain mode mirrors open_challenge)

  /** POST /v1/challenges { kind, subject, claim? } signed by a registered agent. */
  open(agent: string, body: unknown) {
    return this.c.tx(() => {
      this.ensure();
      if (this.c.chainMode) throw conflict("use_chain", "challenges are opened on chain with open_challenge in chain mode");
      const a = this.c.agentRow(agent);
      if (!a || a.shadow) throw forbidden("not_registered", "only a registered agent can challenge");
      if (typeof body !== "object" || body === null) throw bad("bad_body", "{ kind, subject, claim? } expected");
      const b = body as Record<string, unknown>;
      const kind = String(b.kind) as Kind;
      if (!KINDS.includes(kind)) throw bad("bad_kind", "kind must be verdict, slash or epoch");
      const p = this.params();
      const now = this.c.now();
      const target = this.target(kind, String(b.subject ?? ""));
      if (now >= target.since + p.window_s * 1000) throw conflict("challenge_window", `the ${kind} is older than challenge_window_s`);
      const id = challengeId(kind, target.subject_hex);
      if (this.c.db.query("SELECT 1 FROM challenges WHERE kind = ? AND subject = ?").get(kind, target.subject)) throw conflict("already_challenged", "this subject was already challenged");
      const claim = b.claim === undefined ? null : JSON.stringify(b.claim);
      if (claim && claim.length > 4096) throw bad("claim_too_long", "claim is at most 4096 bytes of JSON");
      const wallet = ACC.wallet(agent);
      if (this.c.ledger.balance(wallet) < p.bond) throw new ApiError(402, "insufficient_balance", `the bond is ${p.bond} base units`);
      this.c.ledger.transfer(wallet, escrow(id), p.bond, "challenge_bond", id);
      this.insert({ challenge_id: id, kind, subject: target.subject, subject_hex: target.subject_hex, epoch: target.epoch, challenger: agent, claim,
        claim_digest: claim ? hashJson(JSON.parse(claim)) : "00".repeat(32), bond: p.bond.toString(), opened_at: now, source: "sim" });
      this.start(this.row(id)!);
      return this.view(this.row(id)!);
    });
  }

  /** The subject in Core's terms, the epoch it holds and when its window started. */
  private target(kind: Kind, subject: string): { subject: string; subject_hex: string; epoch: number; since: number } {
    if (kind === "verdict") {
      const c = this.c.candRow(subject);
      if (!c?.candidate_id || !TERMINAL.has(c.status) || !c.verdict) throw conflict("not_final", "only a final verdict can be challenged");
      return { subject: c.candidate_id, subject_hex: c.candidate_id, epoch: this.verdictEpoch(c), since: c.finalized_at ?? 0 };
    }
    if (kind === "slash") {
      const s = this.slashBySubject(subject);
      if (!s) throw notFound("slash");
      return { subject: slashIdOf(s), subject_hex: slashIdOf(s), epoch: s.epoch, since: s.at };
    }
    const n = Number(subject);
    const ep = Number.isInteger(n) ? this.c.epochRow(n) : null;
    if (!ep || ep.status !== "closed") throw conflict("not_closed", "only a closed epoch can be challenged");
    return { subject: String(n), subject_hex: epochHex(n), epoch: n, since: ep.closed_at ?? 0 };
  }

  /** The epoch a verdict's units landed in: its generation's, else the epoch it became final in. */
  private verdictEpoch(c: CandLite): number {
    if (c.gen_id) return this.c.genRow(c.gen_id)?.epoch ?? this.c.currentEpoch().n;
    const r = this.c.db.query<{ n: number }, [number]>("SELECT n FROM epochs WHERE start_ms <= ? ORDER BY n DESC LIMIT 1").get(c.finalized_at ?? this.c.now());
    return r?.n ?? this.c.currentEpoch().n;
  }

  /** A slash by its onchain id (64 hex) or its row number (#n). */
  private slashBySubject(subject: string): SlashRow | null {
    if (/^#?\d+$/.test(subject)) return this.c.db.query<SlashRow, [number]>("SELECT * FROM slashes WHERE id = ?").get(Number(subject.replace("#", "")));
    if (!/^[0-9a-f]{64}$/.test(subject)) return null;
    for (const s of this.c.db.query<SlashRow, []>("SELECT * FROM slashes ORDER BY id DESC").all()) if (slashIdOf(s) === subject) return s;
    return null;
  }

  private insert(r: { challenge_id: string; kind: Kind; subject: string; subject_hex: string; epoch: number; challenger: string; claim: string | null;
    claim_digest: string; bond: string; opened_at: number; source: "sim" | "chain"; chain_address?: string; refund_token?: string; chain_status?: string;
    status?: string }) {
    const p = this.params();
    // in chain mode Core resolves well before the program lets anyone expire the challenge
    const timeout = p.resolve_timeout_s * 1000;
    const deadline = r.opened_at + (r.source === "chain" ? Math.floor(timeout / 2) : timeout);
    this.c.db
      .query(
        `INSERT INTO challenges (challenge_id, kind, subject, subject_hex, epoch, challenger, claim, claim_digest, bond, status, opened_at, deadline, source,
           chain_address, refund_token, chain_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.challenge_id, r.kind, r.subject, r.subject_hex, r.epoch, r.challenger, r.claim, r.claim_digest, r.bond, r.status ?? "open", r.opened_at, deadline,
        r.source, r.chain_address ?? null, r.refund_token ?? null, r.chain_status ?? null);
    this.c.emitEvent("challenge.opened", { challenge_id: r.challenge_id, kind: r.kind, subject: r.subject, epoch: r.epoch, challenger: r.challenger, bond: r.bond,
      source: r.source });
  }

  // ---------------------------------------------------------------------------------------------
  // Resolution

  /** Called from Core.tick(): starts open challenges, judges with what arrived at the deadline. */
  tick() {
    this.ensure();
    const now = this.c.now();
    for (const r of this.c.db.query<Row, []>("SELECT * FROM challenges WHERE status = 'open' ORDER BY opened_at").all()) {
      if (r.kind === "epoch" && r.source === "chain") continue; // resolved in syncChain, which reads the posted Epoch
      this.start(r);
    }
    for (const r of this.c.db.query<Row, [number]>("SELECT * FROM challenges WHERE status IN ('open','replaying') AND deadline <= ?").all(now)) {
      const grp = `chal:${r.challenge_id}`;
      this.c.db.query("UPDATE replays SET status = 'cancelled' WHERE grp = ? AND status IN ('assigned','committed')").run(grp);
      if (r.status === "replaying" && this.c.revealedOf(grp).length) this.judge(this.row(r.challenge_id)!);
      else this.finish(r, "void", "no independent replay arrived before the deadline", { v: 1, reason: "deadline" });
    }
  }

  /** Called from Core.progress() for `chal:` groups once nothing in the group is outstanding. */
  progress(grp: string) {
    this.ensure();
    const r = this.row(grp.slice(5));
    if (!r || r.status !== "replaying") return;
    const rows = this.c.db.query<ReplayLite, [string]>("SELECT * FROM replays WHERE grp = ?").all(grp);
    if (rows.some((x) => x.status === "assigned" || x.status === "committed")) return;
    this.judge(r);
  }

  private start(r: Row) {
    if (r.kind === "verdict") return this.startVerdict(r);
    if (r.kind === "slash") return this.startSlash(r);
    return this.resolveEpoch(r, null);
  }

  private startVerdict(r: Row) {
    const c = this.c.candByCandidateId(r.subject);
    if (!c || !TERMINAL.has(c.status) || !c.verdict) return this.finish(r, "failed", "the subject is not a final verdict", { v: 1, reason: "not_final" });
    if (r.source === "chain" && r.epoch !== this.verdictEpoch(c))
      return this.finish(r, "failed", `the verdict's units are in epoch ${this.verdictEpoch(c)}, not ${r.epoch}`, { v: 1, reason: "wrong_epoch" });
    const orig = this.originalGroup(c);
    if (!orig.length) return this.finish(r, "failed", "the verdict has no revealed replays to re-check", { v: 1, reason: "nothing_to_check" });
    this.assign(r, c, orig[0]!, this.parties(c, r));
  }

  private originalGroup(c: CandLite): ReplayLite[] {
    return this.c.db
      .query<ReplayLite, [string]>("SELECT * FROM replays WHERE grp = ? AND status = 'revealed' ORDER BY replay_id")
      .all(`cand:${c.candidate_id}:${c.stage}`);
  }

  /** Every party of a candidate: author, team, series, every replayer it ever had, the challenger, their operators. */
  private parties(c: CandLite, r: Row): { agents: Set<string>; ops: Set<string> } {
    const agents = new Set<string>([c.author, r.challenger]);
    const ops = new Set<string>();
    for (const x of this.c.db.query<{ replayer: string }, [string]>("SELECT DISTINCT replayer FROM replays WHERE candidate_id = ?").all(c.candidate_id!))
      agents.add(x.replayer);
    this.c.collab.extendExclusion(c as never, agents, ops);
    this.c.series.extendExclusion(c as never, agents, ops);
    for (const a of [...agents]) {
      const op = this.c.agentRow(a)?.operator;
      if (op) ops.add(op);
    }
    return { agents, ops };
  }

  /** Draws fresh replayers (and the reference runner) on `like`'s seed and parent; marks the challenge replaying. */
  private assign(r: Row, c: CandLite, like: ReplayLite, ex: { agents: Set<string>; ops: Set<string> }) {
    const l = this.c.lineageRow(c.lineage_id)!;
    // the reference runner is Core itself: it may re-run a candidate it replayed before
    const refOk = new Set([...ex.agents].filter((a) => !this.c.agentRow(a)?.reference));
    // every fresh replayer must be drawn (with too few, colluding original replayers would outvote them);
    // the reference runner joins when one is available
    const d = this.c.draw(r.challenge_id, 0, this.params().replayers, true, refOk, ex.ops, true, l);
    if (!d || d.chosen.length < this.params().replayers) return; // retried every tick until the deadline (void)
    const grp = `chal:${r.challenge_id}`;
    const window = this.c.replayWindowMs(this.c.calibOf(l.calib_id));
    const now = this.c.now();
    const add = (replayer: string, kind: string) => {
      const id = H("replay", grp, 0, replayer);
      this.c.db
        .query(
          `INSERT INTO replays (replay_id, candidate_id, grp, audit_id, replayer, kind, stage, round, eval_parent_gen_id, assignment_seed, seed, status, assigned_at, commit_deadline, epoch)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'assigned', ?, ?, ?)`,
        )
        .run(id, c.candidate_id!, grp, r.challenge_id, replayer, kind, like.stage, like.eval_parent_gen_id, d.seed, like.seed, now, now + window, d.epoch);
      this.c.emitEvent("replay.assigned", { candidate_id: c.candidate_id, kind: "challenge" });
    };
    for (const a of d.chosen) add(a, "challenge");
    if (d.reference) add(d.reference, "challenge_reference");
    this.c.db.query("UPDATE challenges SET status = 'replaying', started_at = ? WHERE challenge_id = ?").run(now, r.challenge_id);
    this.c.emitEvent("challenge.replaying", { challenge_id: r.challenge_id, replays: d.chosen.length + (d.reference ? 1 : 0) });
  }

  private startSlash(r: Row) {
    const s = this.slashBySubject(r.subject);
    if (!s) {
      // a SlashReceipt on chain that no Core slash produced (a key used outside Core): reversed
      if (r.source === "chain") return this.finish(r, "upheld", "no Core slash has this id", { v: 1, reason: "unknown_slash", slash_id: r.subject }, { reverse: true });
      return this.finish(r, "failed", "no such slash", { v: 1, reason: "unknown_slash" });
    }
    if (this.c.db.query("SELECT 1 FROM slash_reversals WHERE slash_row = ?").get(s.id)) return this.finish(r, "failed", "the slash was already reversed", { v: 1 });
    const rp = this.c.replayRow(s.ref);
    const base = { v: 1, slash: { id: s.id, slash_id: slashIdOf(s), agent: s.agent_id, reason: s.reason, ref: s.ref, amount: s.amount, epoch: s.epoch } };
    if (s.reason === "reveal_mismatch") {
      const justified = !!rp && rp.status === "invalid" && !!rp.result && !!rp.salt && resultCommitment(JSON.parse(rp.result), rp.salt) !== rp.commitment;
      return justified
        ? this.finish(r, "failed", "the revealed result does not match the commitment", { ...base, recomputed: "mismatch" })
        : this.finish(r, "upheld", "the revealed result matches the commitment", { ...base, recomputed: "match" }, { slash: s });
    }
    if (s.reason === "canary") {
      const c = rp ? this.c.candByCandidateId(rp.candidate_id) : null;
      let accepted = false;
      if (c && rp?.result) {
        const { recipe, calib } = this.c.lineageCtx(c, rp.eval_parent_gen_id);
        accepted = judge(recipe, calib, this.c.viewOf(c), [this.c.asRevealed(rp)], this.c.judgeCfg(1)).outcome === "accepted";
      }
      return c?.is_canary && accepted
        ? this.finish(r, "failed", "the replay accepted a canary", { ...base, recomputed: "accepted_canary" })
        : this.finish(r, "upheld", "the replay did not accept a canary", { ...base, recomputed: c?.is_canary ? "rejected_canary" : "not_a_canary" }, { slash: s });
    }
    if (!rp || !rp.result) return this.finish(r, "void", "the slashed replay has no revealed result", base);
    const c = this.c.candByCandidateId(rp.candidate_id)!;
    const ex = this.parties(c, r);
    ex.agents.add(s.agent_id);
    this.assign(r, c, rp, ex);
  }

  /** The replays a minority slash was judged with: its group, plus the original counted ones for audits and challenges. */
  private slashedContext(rp: ReplayLite): ReplayLite[] {
    const group = this.c.db.query<ReplayLite, [string]>("SELECT * FROM replays WHERE grp = ? AND status = 'revealed' ORDER BY replay_id").all(rp.grp);
    if (rp.grp.startsWith("cand:")) return group;
    const c = this.c.candByCandidateId(rp.candidate_id)!;
    const ids = new Set(group.map((x) => x.replay_id));
    return [...group, ...this.originalGroup(c).filter((x) => !ids.has(x.replay_id))];
  }

  private judge(r: Row) {
    if (r.kind === "verdict") return this.judgeVerdict(r);
    return this.judgeSlash(r);
  }

  private settleFresh(grp: string, j: Judgement, calib: Calibration) {
    for (const x of this.c.db.query<ReplayLite, [string]>("SELECT * FROM replays WHERE grp = ? AND status = 'revealed'").all(grp)) {
      if (j.counted.includes(x.replay_id)) {
        this.c.db.query("UPDATE replays SET role = 'counted' WHERE replay_id = ?").run(x.replay_id);
        this.c.awardReplay(x, calib);
      } else if (j.env_failed.includes(x.replay_id)) this.c.db.query("UPDATE replays SET role = 'env_failed' WHERE replay_id = ?").run(x.replay_id);
    }
  }

  /** Slashes every replay in the combined minority: they were wrong on a deterministic field. */
  private slashMinority(j: Judgement, r: Row): string[] {
    const wrong: string[] = [];
    for (const id of j.minority) {
      const x = this.c.replayRow(id);
      if (!x) continue;
      this.c.slash(x.replayer, this.c.cfg.minority_slash_bps, "challenge_minority", id);
      this.c.strike(x.replayer, "challenge_minority", id);
      this.voidHeld("AND kind = 'replay'", id, r);
      this.c.voidUnits("AND kind = 'replay'", id); // open epochs (closed ones it records as void_after_close)
      this.c.db.query("UPDATE replays SET role = 'minority' WHERE replay_id = ?").run(id);
      wrong.push(x.replayer);
    }
    return wrong;
  }

  private judgeVerdict(r: Row) {
    const c = this.c.candByCandidateId(r.subject)!;
    const orig = this.originalGroup(c);
    const { recipe, calib } = this.c.lineageCtx(c, orig[0]?.eval_parent_gen_id ?? c.eval_parent_gen_id);
    const grp = `chal:${r.challenge_id}`;
    const fresh = this.c.revealedOf(grp).map((x) => ({ ...x, reference: this.c.replayRow(x.replay_id)?.kind === "challenge_reference" }));
    const freshIds = new Set(fresh.map((x) => x.replay_id));
    const j = judge(recipe, calib, this.c.viewOf(c), [...orig.map((x) => this.c.asRevealed(x)), ...fresh], this.c.judgeCfg());
    const j0 = JSON.parse(c.verdict!) as Judgement;
    const doc = {
      v: 1, kind: "verdict", candidate_id: c.candidate_id, original: { digest: j0.digest, outcome: j0.outcome, reason: j0.reason ?? null, counted: j0.counted },
      original_group: orig.map((x) => x.replay_id), fresh: [...freshIds],
      combined: { digest: j.digest, outcome: j.outcome, reason: j.reason ?? null, counted: j.counted, minority: j.minority, disputed_fields: j.disputed_fields },
    };
    const freshCounted = [...j.counted, ...j.minority].filter((id) => freshIds.has(id));
    if (j.outcome === "pending" || j.outcome === "disputed" || !freshCounted.length) {
      this.settleFresh(grp, j.outcome === "disputed" || j.outcome === "pending" ? { ...j, counted: [] } : j, calib);
      return this.finish(r, "void", `combined judgement ${j.outcome}${j.detail ? `: ${j.detail}` : ""}`, doc);
    }
    const target = JSON.parse(c.target) as string | string[];
    const metric = recipe.metrics.find((m) => m.name === (Array.isArray(target) ? target[0] : target));
    const noisy = (x: Judgement) => x.outcome === "rejected" && (x.reason === "noisy_split" || (x.reason === "no_improvement" && !metric?.deterministic));
    const wrongOriginal = j0.counted.filter((id) => j.minority.includes(id));
    const flipped = j0.outcome !== j.outcome && (j0.outcome === "accepted" || j0.outcome === "rejected") && !noisy(j0) && !noisy(j);
    this.settleFresh(grp, j, calib);
    const wrongSide = this.slashMinority(j, r);
    const upheld = wrongOriginal.length > 0 || flipped;
    if (!upheld) return this.finish(r, "failed", `the fresh replays confirm the verdict (${j.outcome})`, { ...doc, wrong_side: wrongSide });
    let effect = "recorded";
    if (j0.outcome === "accepted" && j.outcome !== "accepted" && c.gen_id) {
      // the generation stands only if the combined judgement still accepts it (the liars are slashed either way)
      const g = this.c.genRow(c.gen_id);
      if (g && !g.reverted_by) {
        this.voidHeld("AND kind IN ('author','finder')", g.gen_id, r);
        this.c.revert(g.gen_id, j);
        effect = "reverted";
      }
    } else if (j0.outcome !== "accepted" && j.outcome === "accepted" && !c.is_canary) {
      this.requeue(c, r);
      effect = "requeued";
    }
    return this.finish(r, "upheld", `${wrongOriginal.length ? `${wrongOriginal.length} original replays in the minority` : `outcome ${j0.outcome} -> ${j.outcome}`}; ${effect}`,
      { ...doc, wrong_side: wrongSide, effect });
  }

  private judgeSlash(r: Row) {
    const s = this.slashBySubject(r.subject)!;
    const rp = this.c.replayRow(s.ref)!;
    const c = this.c.candByCandidateId(rp.candidate_id)!;
    const { recipe, calib } = this.c.lineageCtx(c, rp.eval_parent_gen_id);
    const grp = `chal:${r.challenge_id}`;
    const fresh = this.c.revealedOf(grp).map((x) => ({ ...x, reference: this.c.replayRow(x.replay_id)?.kind === "challenge_reference" }));
    const context = this.slashedContext(rp);
    const j = judge(recipe, calib, this.c.viewOf(c), [...context.map((x) => this.c.asRevealed(x)), ...fresh], this.c.judgeCfg());
    const doc = {
      v: 1, kind: "slash", slash: { id: s.id, slash_id: slashIdOf(s), agent: s.agent_id, reason: s.reason, ref: s.ref, amount: s.amount, epoch: s.epoch },
      original_group: context.map((x) => x.replay_id), fresh: fresh.map((x) => x.replay_id),
      combined: { digest: j.digest, outcome: j.outcome, reason: j.reason ?? null, counted: j.counted, minority: j.minority, disputed_fields: j.disputed_fields },
    };
    if (j.outcome === "disputed" || j.outcome === "pending") {
      this.settleFresh(grp, { ...j, counted: [] }, calib);
      return this.finish(r, "void", `combined judgement ${j.outcome}`, doc);
    }
    this.settleFresh(grp, j, calib);
    if (j.minority.includes(rp.replay_id)) {
      // justified; fresh replays that disagree with the majority are slashed like any minority
      const wrong = this.slashMinority({ ...j, minority: j.minority.filter((id) => id !== rp.replay_id && fresh.some((f) => f.replay_id === id)) }, r);
      return this.finish(r, "failed", "the slashed replay is in the minority again", { ...doc, wrong_side: wrong });
    }
    if (!j.counted.includes(rp.replay_id)) return this.finish(r, "void", "the slashed replay is not counted either way", doc);
    const wrong = this.slashMinority(j, r);
    return this.finish(r, "upheld", "the slashed replay agrees with the majority", { ...doc, wrong_side: wrong }, { slash: s });
  }

  /**
   * An epoch's roots recomputed from Core's records with the replica's rules. `onchain` (chain mode):
   * the posted Epoch's roots, compared as well.
   */
  private recomputeEpoch(n: number) {
    const ep = this.c.epochRow(n)!;
    const units = this.c.db
      .query<{ agent_id: string; kind: string; units: number; rebate: string }, [number]>("SELECT agent_id, kind, units, rebate FROM units WHERE epoch = ? AND voided = 0 ORDER BY id")
      .all(n)
      .map((u) => ({ agent: u.agent_id, kind: u.kind, units: u.units, rebate: BigInt(u.rebate) }));
    const p = computePayouts({ epoch: n, units, destFor: (a, k) => this.c.destFor(a, k), walletOf: (a) => ACC.wallet(a), pool: BigInt(ep.pool_amount ?? "0"),
      reserve: BigInt(ep.rebate_amount ?? "0") });
    const gens = this.c.db
      .query<{ lineage_id: string; gen_id: string; parent_gen_id: string | null; height: number; entry_type: string }, [number]>(
        "SELECT lineage_id, gen_id, parent_gen_id, height, entry_type FROM generations WHERE epoch <= ?",
      )
      .all(n);
    const leaves = [
      ...this.c.db.query<{ leaf: string }, [number]>("SELECT leaf FROM records WHERE epoch = ?").all(n).map((x) => x.leaf),
      ...this.c.db.query<{ leaf: string }, [number]>("SELECT leaf FROM contributions WHERE epoch = ?").all(n).map((x) => x.leaf),
    ].sort();
    return { payouts: p, root: p.root, lineage_root: lineageRootOf(gens), record_root: ep.record_root ? merkleRoot(leaves) : null };
  }

  /** Epoch challenge: Core's published roots (and the posted ones) against a recomputation. */
  private resolveEpoch(r: Row, onchain: { payoutRoot: string; lineageRoot: string; recordRoot: string | null; claims: number } | null) {
    const n = Number(r.subject);
    const ep = this.c.epochRow(n);
    if (!ep || ep.status !== "closed") return this.finish(r, "failed", "the epoch is not closed in Core", { v: 1, reason: "not_closed" });
    const x = this.recomputeEpoch(n);
    const published = { root: ep.root, lineage_root: ep.lineage_root, record_root: ep.record_root ?? null };
    const mismatch: string[] = [];
    if (x.root !== ep.root) mismatch.push("payout root");
    if (x.lineage_root !== ep.lineage_root) mismatch.push("lineage root");
    if (x.record_root !== (ep.record_root ?? null)) mismatch.push("record root");
    if (onchain) {
      if (onchain.payoutRoot !== x.root) mismatch.push("posted payout root");
      if (onchain.lineageRoot !== x.lineage_root) mismatch.push("posted lineage root");
      if ((onchain.recordRoot ?? null) !== x.record_root) mismatch.push("posted record root");
    }
    const doc = { v: 1, kind: "epoch", epoch: n, published, onchain, recomputed: { root: x.root, lineage_root: x.lineage_root, record_root: x.record_root,
      total_units: x.payouts.totalUnits }, mismatch: [...new Set(mismatch)] };
    if (!mismatch.length) return this.finish(r, "failed", "the recomputed roots equal the published ones", doc);
    if (x.root !== ep.root) this.applyCorrection(n, x.payouts, r);
    return this.finish(r, "upheld", `recomputed ${[...new Set(mismatch)].join(", ")} differ`, { ...doc, corrected: { root: x.root, lineage_root: x.lineage_root,
      record_root: x.record_root, total_units_micro: Math.round(x.payouts.totalUnits * 1e6) } });
  }

  /** Voids units of `ref` in a closed epoch this challenge holds (no claim yet), so the epoch can be corrected. */
  private voidHeld(where: string, ref: string, r: Row) {
    for (const u of this.c.db
      .query<{ id: number; epoch: number; agent_id: string; kind: string }, [string]>(`SELECT id, epoch, agent_id, kind FROM units WHERE ref = ? AND voided = 0 ${where}`)
      .all(ref)) {
      const ep = this.c.epochRow(u.epoch);
      if (!ep || ep.status !== "closed") continue; // open epochs: Core's own void path (voidUnits) handles them
      if (u.epoch !== r.epoch || this.claimed(u.epoch)) continue; // paid or not held: recorded by Core as void_after_close
      this.c.db.query("UPDATE units SET voided = 1 WHERE id = ?").run(u.id);
      this.c.emitEvent("units.voided", { agent: u.agent_id, kind: u.kind, ref, epoch: u.epoch, challenge_id: r.challenge_id });
      this.pendingCorrection.add(u.epoch);
    }
  }
  private pendingCorrection = new Set<number>();

  private claimed(n: number): boolean {
    return !!this.c.db.query("SELECT 1 FROM claims WHERE epoch = ?").get(n);
  }

  /** Rewrites a held closed epoch's payouts (the pool and rebate it paid stay; less may be owed). */
  private applyCorrection(n: number, p: ReturnType<typeof computePayouts>, r: Row) {
    const ep = this.c.epochRow(n)!;
    const before = BigInt(ep.pool_amount ?? "0") + BigInt(ep.rebate_amount ?? "0");
    this.c.db
      .query("UPDATE epochs SET payouts = ?, root = ?, total_units = ?, pool_amount = ?, rebate_amount = ? WHERE n = ?")
      .run(JSON.stringify(p.leaves), p.root, p.totalUnits, p.poolOut.toString(), p.rebateOut.toString(), n);
    // simulated mode: what is no longer owed goes back where it came from (on chain it stays in the payable vault)
    if (!this.c.chainMode) {
      const poolBack = BigInt(ep.pool_amount ?? "0") - p.poolOut;
      const rebateBack = BigInt(ep.rebate_amount ?? "0") - p.rebateOut;
      if (poolBack > 0n) this.c.ledger.transfer(ACC.payable(n), ACC.pool, poolBack, "epoch_correction", r.challenge_id);
      if (rebateBack > 0n) this.c.ledger.transfer(ACC.payable(n), ACC.reserve, rebateBack, "epoch_correction", r.challenge_id);
    }
    this.c.emitEvent("epoch.corrected", { n, previous_root: ep.root, root: p.root, challenge_id: r.challenge_id, payable_before: before.toString(),
      payable_after: (p.poolOut + p.rebateOut).toString() });
  }

  /** A wrongly rejected candidate goes back on the tip as a rebase stage, its commitment time kept (SPEC 11.2). */
  private requeue(c: CandLite, r: Row) {
    const l = this.c.lineageRow(c.lineage_id)!;
    this.c.db
      .query(
        `UPDATE candidates SET status = 'queued', reason = NULL, finalized_at = NULL, verdict = NULL, stage = stage + 1, eval_parent_gen_id = ?, want_replays = ?,
           want_reference = 0, reassigns = 0, dispute_rounds = 0, detail = ? WHERE commit_id = ?`,
      )
      .run(l.tip, this.c.cfg.quorum, `queued again on ${l.tip} by upheld challenge ${r.challenge_id}`, c.commit_id);
    this.c.emitEvent("candidate.requeued", { candidate_id: c.candidate_id, challenge_id: r.challenge_id, tip: l.tip });
    this.c.fillWants();
  }

  /** Moves the slash back: Core's ledger (simulated mode; chain mode mirrors the program's reversal), the strike, the suspension. */
  private reverse(s: SlashRow, r: Row): string {
    let amount = BigInt(s.amount);
    if (!this.c.chainMode) {
      const reserve = this.c.ledger.balance(ACC.reserve);
      if (amount > reserve) amount = reserve;
      if (amount > 0n) this.c.ledger.transfer(ACC.reserve, ACC.bond(s.agent_id), amount, "slash_reversed", r.challenge_id);
    }
    const strike = this.c.db
      .query<{ id: number; epoch: number }, [string, string, string]>("SELECT id, epoch FROM strikes WHERE agent_id = ? AND ref = ? AND reason = ? ORDER BY id LIMIT 1")
      .get(s.agent_id, s.ref, s.reason);
    if (strike) {
      this.c.db.query("DELETE FROM strikes WHERE id = ?").run(strike.id);
      const left = this.c.db.query<{ c: number }, [string, number]>("SELECT COUNT(*) AS c FROM strikes WHERE agent_id = ? AND epoch = ?").get(s.agent_id, strike.epoch)!.c;
      const a = this.c.agentRow(s.agent_id);
      if (a && left < this.c.cfg.strike_limit && a.suspended_through_epoch === strike.epoch + 1) {
        this.c.db.query("UPDATE agents SET suspended_through_epoch = ? WHERE agent_id = ?").run(strike.epoch, s.agent_id);
      }
    }
    this.c.db.query("INSERT OR IGNORE INTO slash_reversals (slash_row, challenge_id, amount, at) VALUES (?, ?, ?, ?)").run(s.id, r.challenge_id, amount.toString(), this.c.now());
    this.c.emitEvent("slash.reversed", { agent: s.agent_id, slash: s.id, slash_id: slashIdOf(s), amount: amount.toString(), challenge_id: r.challenge_id });
    return amount.toString();
  }

  private finish(r: Row, outcome: "upheld" | "failed" | "void", detail: string, doc: Record<string, unknown>, opts: { slash?: SlashRow; reverse?: boolean } = {}) {
    const now = this.c.now();
    if (opts.slash) doc = { ...doc, reversed: this.reverse(opts.slash, r) };
    if (opts.reverse) doc = { ...doc, reversed: "chain" };
    for (const n of this.pendingCorrection) {
      const p = this.recomputeEpoch(n);
      this.applyCorrection(n, p.payouts, r);
      if (n === r.epoch) doc = { ...doc, corrected: { root: p.root, lineage_root: p.lineage_root, record_root: p.record_root, total_units_micro: Math.round(p.payouts.totalUnits * 1e6) } };
    }
    this.pendingCorrection.clear();
    let reward = 0n;
    if (r.source === "sim") {
      const bond = BigInt(r.bond);
      const esc = escrow(r.challenge_id);
      const wallet = ACC.wallet(r.challenger);
      if (outcome === "failed") this.c.ledger.transfer(esc, ACC.reserve, bond, "challenge_failed", r.challenge_id);
      else this.c.ledger.transfer(esc, wallet, bond, outcome === "upheld" ? "challenge_upheld" : "challenge_void", r.challenge_id);
      if (outcome === "upheld") {
        const reserve = this.c.ledger.balance(ACC.reserve);
        reward = this.params().reward < reserve ? this.params().reward : reserve;
        if (reward > 0n) this.c.ledger.transfer(ACC.reserve, wallet, reward, "challenge_reward", r.challenge_id);
      }
    }
    const full = { ...doc, challenge_id: r.challenge_id, outcome, detail };
    this.c.db
      .query("UPDATE challenges SET status = ?, detail = ?, resolution = ?, evidence = ?, resolved_at = ?, reward = ? WHERE challenge_id = ?")
      .run(outcome, detail, JSON.stringify(full), hashJson(full), now, r.source === "sim" ? reward.toString() : null, r.challenge_id);
    this.c.emitEvent("challenge.resolved", { challenge_id: r.challenge_id, kind: r.kind, subject: r.subject, outcome, detail, evidence: hashJson(full) });
  }

  // ---------------------------------------------------------------------------------------------
  // Payout hold (simulated mode; on chain the registry's claim enforces it)

  /** Refuses a claim of an epoch while a verdict or epoch challenge on it is open. */
  assertClaimable(n: number) {
    this.ensure();
    const open = this.c.db
      .query("SELECT 1 FROM challenges WHERE epoch = ? AND kind IN ('verdict','epoch') AND status IN ('open','replaying') LIMIT 1")
      .get(n);
    if (open) throw conflict("claim_held", `epoch ${n} has an open challenge; its payouts wait for the resolution`);
  }

  // ---------------------------------------------------------------------------------------------
  // Chain mode (ChainBridge calls this every sync)

  async syncChain(ctx: { reader: ChainReader; send: ((label: string, ixs: Ix[]) => Promise<{ signature: string }>) | null; coreKeyId: string | null; reg: RegistryConfig;
    log?: (m: string) => void }) {
    this.ensure();
    const cc = await ctx.reader.challengeConfig();
    if (!cc) return { config: null, count: 0 };
    this.chainParams = { window_s: Number(cc.windowS), bond: cc.bond, reward: cc.reward, resolve_timeout_s: Number(cc.resolveTimeoutS), replayers: 1 };
    const accounts = await ctx.reader.challenges();
    for (const a of accounts) {
      const kind = a.kind as Kind;
      const subject = kind === "epoch" ? String(Number(Buffer.from(a.subject, "hex").readBigUInt64LE(0))) : a.subject;
      const id = challengeId(kind, a.subject);
      const known = this.row(id);
      if (!known) {
        this.c.tx(() =>
          this.insert({ challenge_id: id, kind, subject, subject_hex: a.subject, epoch: Number(a.epoch), challenger: a.challenger, claim: null, claim_digest: a.claim,
            bond: a.bond.toString(), opened_at: Number(a.openedAt) * 1000, source: "chain", chain_address: a.address, refund_token: a.refundToken,
            chain_status: a.status, status: a.status === "open" ? "open" : a.status }),
        );
        // already resolved on chain by another Core (or before this one existed): nothing to send
        if (a.status !== "open") this.c.db.query("UPDATE challenges SET resolve_sig = ? WHERE challenge_id = ?").run(`landed:${a.address}`, id);
        continue;
      }
      if (known.chain_status !== a.status) {
        this.c.db.query("UPDATE challenges SET chain_status = ?, reward = ? WHERE challenge_id = ?").run(a.status, a.status === "open" ? null : a.reward.toString(), id);
        // resolved or expired on chain by someone else (or a send that reported failure but landed)
        if (a.status !== "open" && !known.resolve_sig) this.c.db.query("UPDATE challenges SET resolve_sig = ? WHERE challenge_id = ?").run(`landed:${a.address}`, id);
        if (a.status === "expired" && OPEN.includes(known.status)) {
          this.c.db.query("UPDATE challenges SET status = 'expired', resolved_at = ? WHERE challenge_id = ?").run(this.c.now(), id);
          this.c.db.query("UPDATE replays SET status = 'cancelled' WHERE grp = ? AND status IN ('assigned','committed')").run(`chal:${id}`);
        }
      }
    }
    // epoch challenges compare the posted Epoch too
    for (const r of this.c.db.query<Row, []>("SELECT * FROM challenges WHERE status = 'open' AND kind = 'epoch' AND source = 'chain'").all()) {
      const e = await ctx.reader.epoch(Number(r.subject));
      this.c.tx(() => this.resolveEpoch(r, e ? { payoutRoot: e.payoutRoot, lineageRoot: e.lineageRoot, recordRoot: e.recordRoot, claims: e.claims } : null));
    }
    if (!ctx.send || !ctx.coreKeyId) return { config: cc, count: accounts.length };
    // record Core's resolutions on chain
    const now = this.c.now();
    for (const r of this.c.db
      .query<Row, []>("SELECT * FROM challenges WHERE source = 'chain' AND status IN ('upheld','failed','void') AND resolve_sig IS NULL ORDER BY resolved_at")
      .all()) {
      if (r.resolve_next_at && now < r.resolve_next_at) continue;
      // resolved on chain already, or mirrored without a resolution of this Core's own: never re-send
      if ((r.chain_status && r.chain_status !== "open") || !r.evidence) {
        this.c.db.query("UPDATE challenges SET resolve_sig = ? WHERE challenge_id = ?").run(`landed:${r.chain_address}`, r.challenge_id);
        continue;
      }
      const doc = JSON.parse(r.resolution ?? "{}") as { corrected?: { root: string; lineage_root: string; record_root: string | null; total_units_micro: number } };
      const kindN = CHALLENGE_KIND[r.kind];
      let corrected = null;
      if (r.status === "upheld" && doc.corrected && r.kind !== "slash") {
        const e = await ctx.reader.epoch(r.epoch);
        if (e && e.claims === 0 && (e.payoutRoot !== doc.corrected.root || e.lineageRoot !== doc.corrected.lineage_root || (e.recordRoot ?? null) !== doc.corrected.record_root))
          corrected = { payoutRoot: doc.corrected.root, lineageRoot: doc.corrected.lineage_root, recordRoot: doc.corrected.record_root ?? "00".repeat(32),
            totalUnitsMicro: BigInt(doc.corrected.total_units_micro) };
      }
      let slashedAgent: Address | null = null;
      if (r.status === "upheld" && r.kind === "slash") slashedAgent = (await ctx.reader.slashReceipt(r.subject_hex))?.agent ?? null;
      const ix = challengeIx.resolve({ coreAuthority: ctx.coreKeyId, mint: ctx.reg.mint, kind: kindN, subject: r.subject_hex, epoch: r.epoch, refundToken: r.refund_token!,
        outcome: CHALLENGE_OUTCOME[r.status as "upheld" | "failed" | "void"], evidence: r.evidence!, corrected, slashedAgent, tokenProgram: ctx.reg.tokenProgram });
      try {
        const { signature: sig } = await ctx.send(`resolve_challenge ${r.kind} ${r.subject.slice(0, 16)} ${r.status}`, [ix]);
        this.c.db.query("UPDATE challenges SET resolve_sig = ?, resolve_error = NULL, resolve_attempts = resolve_attempts + 1 WHERE challenge_id = ?").run(sig, r.challenge_id);
        this.c.emitEvent("challenge.recorded", { challenge_id: r.challenge_id, signature: sig, corrected: !!corrected });
      } catch (e) {
        const acct = await ctx.reader.challenge(kindN, r.subject_hex).catch(() => null);
        if (acct && acct.status !== "open") {
          this.c.db.query("UPDATE challenges SET resolve_sig = ?, chain_status = ? WHERE challenge_id = ?").run((e as { signature?: string }).signature ?? `landed:${r.chain_address}`,
            acct.status, r.challenge_id);
          continue;
        }
        const attempts = r.resolve_attempts + 1;
        this.c.db
          .query("UPDATE challenges SET resolve_error = ?, resolve_attempts = ?, resolve_next_at = ? WHERE challenge_id = ?")
          .run((e as Error).message.slice(0, 500), attempts, now + Math.min(5_000 * 2 ** (attempts - 1), 600_000), r.challenge_id);
        ctx.log?.(`resolve_challenge ${r.challenge_id} failed: ${(e as Error).message}`);
      }
    }
    return { config: cc, count: accounts.length };
  }
}

const TERMINAL_CH = new Set(["upheld", "failed", "void", "expired"]);
const escrow = (id: string) => `challenge:${id}:bond`;

