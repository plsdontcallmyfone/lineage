import type { OpenBountyAccount, OpenBountyConfig } from "@units/chain";
import { challengesOf } from "./challenges.ts";
import type { Core } from "./core.ts";
import { ApiError, notFound } from "./errors.ts";
import { canonicalJson, hashJson } from "./protocol.ts";
import type { BountyResult } from "./records.ts";

// Open bounties (docs/plans/OPEN-BOUNTIES.md option A): the mirror of the `units_bounty` escrow
// program beside the mirror of the launch program's bounties (bounties.ts). Any wallet funds one
// from its own $UNITS; the program pays the author of the earliest accepted generation that meets
// the terms, proven by a result leaf (records.ts) against the posted record root, and refunds the
// funder at expiry. Core mirrors every Bounty account each chain sync, keeps the terms whose sha256
// the account commits to, names the winner by the rule the program enforces and serves the claim
// proof. Nothing here moves tokens.
//
// The rule is the program's own (onchain/programs/units-bounty/src/lib.rs `claim`), so what this
// module names is what the chain will pay: a result on the bounty's unit and metric, in an epoch from
// the bounty's `min_epoch` on whose root was posted no later than the deadline, accepted at or after
// the bounty's creation, with at least the required improvement, whose author has a compute vault;
// among those the lowest height. One thing the chain cannot see is a later revert: a reverted
// generation is marked here and still wins on chain if its root stands.

interface Internals {
  db: Core["db"];
  now(): number;
  emitEvent(type: string, data: unknown): void;
  chainMode?: boolean;
  records: Core["records"];
}

export const OPEN_BOUNTIES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS open_bounties (
    bounty_id TEXT PRIMARY KEY,          -- the Bounty account address
    funder TEXT NOT NULL,                -- the wallet that escrowed the reward
    seq TEXT NOT NULL,                   -- the funder's onchain bounty id (u64)
    amount TEXT NOT NULL,                -- base units
    fee_bps INTEGER NOT NULL,
    terms_digest TEXT NOT NULL,
    terms TEXT,                          -- canonical JSON once someone supplies it (sha256 = terms_digest)
    lineage_id TEXT NOT NULL,
    target_digest TEXT NOT NULL,         -- hashJson(target)
    min_improvement_bps INTEGER NOT NULL,
    min_epoch INTEGER NOT NULL,
    deadline INTEGER NOT NULL,           -- unix seconds
    created_at INTEGER NOT NULL,         -- unix seconds (chain clock)
    refund_after INTEGER NOT NULL,
    contest_s INTEGER NOT NULL,
    status TEXT NOT NULL,                -- open | paid | refunded | cancelled
    winner TEXT,                         -- the standing claim's author (the paid agent once paid)
    win_height INTEGER,
    win_epoch INTEGER,
    win_gen_id TEXT,
    win_improvement_bps INTEGER,
    claimed_at INTEGER,
    contest_until INTEGER,
    paid TEXT,
    fee_paid TEXT,
    closed_at INTEGER,
    chain_sig TEXT,                      -- the open transaction, when known
    synced_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS open_bounties_lineage ON open_bounties(lineage_id, status);
`;

interface Row {
  bounty_id: string; funder: string; seq: string; amount: string; fee_bps: number; terms_digest: string; terms: string | null; lineage_id: string;
  target_digest: string; min_improvement_bps: number; min_epoch: number; deadline: number; created_at: number; refund_after: number; contest_s: number;
  status: string; winner: string | null; win_height: number | null; win_epoch: number | null; win_gen_id: string | null; win_improvement_bps: number | null;
  claimed_at: number | null; contest_until: number | null; paid: string | null; fee_paid: string | null; closed_at: number | null; chain_sig: string | null;
  synced_at: number;
}
/** One result on a bounty's unit and metric, and what the program says to it. */
export interface OpenBountyGen {
  gen_id: string; height: number; author: string; accepted_at: number; epoch: number; improvement_bps: number;
  reverted: boolean;
  /** its epoch's root is posted, and no later than the deadline */
  in_time: boolean;
  /** accepted at or after the bounty's creation, in an epoch from its min_epoch on */
  after_open: boolean;
  meets: boolean;
  /** the author has a compute vault (a launched agent): only such an author can be paid */
  payable: boolean;
}
interface UnitLite { repo: string | null; recipe_name: string | null; metric: { name: string; kind: string; direction: string } | null }

const instances = new WeakMap<Core, OpenBounties>();
export function openBountiesOf(core: Core): OpenBounties {
  let b = instances.get(core);
  if (!b) instances.set(core, (b = new OpenBounties(core)));
  return b;
}

export class OpenBounties {
  private readonly c: Internals;
  private readonly core: Core;
  /** The program's Config as the chain bridge last read it; null where the program is not deployed or not initialized. */
  private config: (OpenBountyConfig & { program: string }) | null = null;
  constructor(core: Core) {
    this.core = core;
    this.c = core as unknown as Internals;
    this.c.db.exec(OPEN_BOUNTIES_SCHEMA);
  }

  /** The chain bridge hands in what it read: the program's Config (null = not configured) and every Bounty account. */
  sync(config: (OpenBountyConfig & { program: string }) | null, accounts: (OpenBountyAccount & { address: string })[], sigOf?: (address: string) => string | null) {
    this.config = config;
    const db = this.c.db;
    const now = this.c.now();
    for (const a of accounts) {
      const prev = db.query<{ status: string; winner: string | null; chain_sig: string | null }, [string]>("SELECT status, winner, chain_sig FROM open_bounties WHERE bounty_id = ?").get(a.address);
      const row = {
        bounty_id: a.address, funder: a.funder, seq: a.bountyId.toString(), amount: a.amount.toString(), fee_bps: a.feeBps, terms_digest: a.termsDigest,
        lineage_id: a.lineageId, target_digest: a.targetDigest, min_improvement_bps: a.minImprovementBps, min_epoch: Number(a.minEpoch), deadline: Number(a.deadline),
        created_at: Number(a.createdAt), refund_after: Number(a.refundAfter), contest_s: a.contestS, status: a.status, winner: a.winner,
        win_height: a.winner ? Number(a.winHeight) : null, win_epoch: a.winner ? Number(a.winEpoch) : null, win_gen_id: a.winGenId,
        win_improvement_bps: a.winner ? Number(a.winImprovementBps) : null, claimed_at: a.winner ? Number(a.claimedAt) : null,
        contest_until: a.winner ? Number(a.contestUntil) : null, paid: a.status === "paid" ? a.paid.toString() : null,
        fee_paid: a.status === "paid" ? a.feePaid.toString() : null, closed_at: a.closedAt === 0n ? null : Number(a.closedAt),
        chain_sig: prev?.chain_sig ?? sigOf?.(a.address) ?? null, synced_at: now,
      };
      db.query(
        `INSERT INTO open_bounties (bounty_id, funder, seq, amount, fee_bps, terms_digest, lineage_id, target_digest, min_improvement_bps, min_epoch, deadline, created_at,
           refund_after, contest_s, status, winner, win_height, win_epoch, win_gen_id, win_improvement_bps, claimed_at, contest_until, paid, fee_paid, closed_at, chain_sig, synced_at)
         VALUES ($bounty_id, $funder, $seq, $amount, $fee_bps, $terms_digest, $lineage_id, $target_digest, $min_improvement_bps, $min_epoch, $deadline, $created_at,
           $refund_after, $contest_s, $status, $winner, $win_height, $win_epoch, $win_gen_id, $win_improvement_bps, $claimed_at, $contest_until, $paid, $fee_paid, $closed_at,
           $chain_sig, $synced_at)
         ON CONFLICT(bounty_id) DO UPDATE SET status = excluded.status, winner = excluded.winner, win_height = excluded.win_height, win_epoch = excluded.win_epoch,
           win_gen_id = excluded.win_gen_id, win_improvement_bps = excluded.win_improvement_bps, claimed_at = excluded.claimed_at, contest_until = excluded.contest_until,
           paid = excluded.paid, fee_paid = excluded.fee_paid, closed_at = excluded.closed_at, chain_sig = COALESCE(open_bounties.chain_sig, excluded.chain_sig),
           synced_at = excluded.synced_at`,
      ).run(row as never);
      const ev = (type: string) => this.c.emitEvent(type, this.view(this.get(a.address)));
      if (!prev) ev("bounty.opened");
      if (prev && prev.winner !== a.winner && a.status === "open") ev("bounty.claimed");
      if (prev?.status !== a.status && a.status === "paid") ev("bounty.released");
      if (prev?.status !== a.status && (a.status === "refunded" || a.status === "cancelled")) ev("bounty.refunded");
    }
  }

  has(id: string): boolean {
    return !!this.c.db.query("SELECT 1 FROM open_bounties WHERE bounty_id = ?").get(id);
  }
  known(): string[] {
    return this.c.db.query<{ bounty_id: string }, []>("SELECT bounty_id FROM open_bounties").all().map((r) => r.bounty_id);
  }
  private get(id: string): Row {
    const r = this.c.db.query<Row, [string]>("SELECT * FROM open_bounties WHERE bounty_id = ?").get(id);
    if (!r) throw notFound("bounty");
    return r;
  }

  /** The program's settings as the page and the form read them; null where the program is not configured. */
  settings() {
    const c = this.config;
    if (!c) return null;
    const s = c.settings;
    return { program: c.program, mint: c.mint, token_program: c.tokenProgram, admin: c.admin, min_amount: s.minAmount.toString(), min_ttl_s: s.minTtlS, max_ttl_s: s.maxTtlS,
      refund_grace_s: s.refundGraceS, contest_s: s.contestS, fee_bps: s.feeBps, paused: s.paused, opened: c.opened.toString() };
  }

  /** GET /v1/bounties/:id for a bounty of the escrow program. */
  view(r: Row) {
    return {
      kind: "escrow" as const, bounty_id: r.bounty_id, funder: r.funder, seq: r.seq, amount: r.amount, fee_bps: r.fee_bps, terms_digest: r.terms_digest,
      terms: r.terms ? JSON.parse(r.terms) : null, condition: { kind: "target", lineage_id: r.lineage_id, value: r.target_digest }, min_improvement_bps: r.min_improvement_bps,
      min_epoch: r.min_epoch, deadline: r.deadline, created_at: r.created_at, refund_after: r.refund_after, contest_s: r.contest_s, status: r.status,
      claim: r.winner ? { winner: r.winner, gen_id: r.win_gen_id, height: r.win_height, epoch: r.win_epoch, improvement_bps: r.win_improvement_bps, claimed_at: r.claimed_at,
        contest_until: r.contest_until } : null,
      paid: r.paid, fee_paid: r.fee_paid, closed_at: r.closed_at, chain_sig: r.chain_sig, synced_at: r.synced_at,
    };
  }
  one(id: string) {
    return this.view(this.get(id));
  }

  /** PUT /v1/bounties/:id/terms: kept only if sha256 of the canonical terms is the onchain digest. */
  setTerms(id: string, terms: unknown) {
    const r = this.get(id);
    if (terms === undefined || terms === null) throw new ApiError(400, "invalid_terms", "terms required");
    if (hashJson(terms) !== r.terms_digest) throw new ApiError(409, "terms_digest", "sha256 of the canonical terms is not the onchain terms_digest");
    this.c.db.query("UPDATE open_bounties SET terms = ? WHERE bounty_id = ?").run(canonicalJson(terms), id);
    return this.one(id);
  }

  /** The unit and the metric a bounty names; nulls when Core has no such unit or the unit has no metric of that digest. */
  private unit(r: Row): UnitLite {
    const u = this.c.db
      .query<{ url: string; name: string; recipe: string }, [string]>(
        "SELECT p.url, r.name, r.json AS recipe FROM lineages l JOIN repos p ON p.repo_id = l.repo_id JOIN recipes r ON r.recipe_id = l.recipe_id WHERE l.lineage_id = ?")
      .get(r.lineage_id);
    if (!u) return { repo: null, recipe_name: null, metric: null };
    const metrics = (JSON.parse(u.recipe) as { metrics?: { name: string; kind: string; direction: string }[] }).metrics ?? [];
    const m = metrics.find((x) => hashJson(x.name) === r.target_digest) ?? null;
    return { repo: u.url, recipe_name: u.name, metric: m ? { name: m.name, kind: m.kind, direction: m.direction } : null };
  }

  /** Every result on the bounty's unit and metric, lowest height first, and the one the program pays. */
  decide(r: Row): { generations: OpenBountyGen[]; winner: OpenBountyGen | null } {
    const rows = this.c.db
      .query<{ result: string; reverted_by: string | null; closed_at: number | null; chain_n: number | null; chain_sig: string | null; chain_posted: number | null;
        kind: string | null; mint: string | null }, [string]>(
        `SELECT r.result, g.reverted_by, e.closed_at, ce.n AS chain_n, ce.signature AS chain_sig, ce.posted_at AS chain_posted, a.kind, a.mint
         FROM bounty_results r LEFT JOIN generations g ON g.gen_id = r.gen_id LEFT JOIN epochs e ON e.n = r.epoch LEFT JOIN chain_epochs ce ON ce.n = r.epoch
         LEFT JOIN agents a ON a.agent_id = r.author WHERE r.lineage_id = ?`,
      )
      .all(r.lineage_id);
    const out: OpenBountyGen[] = [];
    for (const x of rows) {
      const res = JSON.parse(x.result) as BountyResult;
      if (hashJson(res.target) !== r.target_digest) continue;
      // posted: on chain when Core runs in chain mode (the post_epoch transaction confirmed), else the epoch's close
      const postedMs = this.c.chainMode || x.chain_n !== null ? (x.chain_sig ? x.chain_posted : null) : x.closed_at;
      out.push({ gen_id: res.gen_id, height: res.height, author: res.author, accepted_at: res.accepted_at, epoch: res.epoch, improvement_bps: res.improvement_bps,
        reverted: !!x.reverted_by, in_time: postedMs !== null && Math.floor(postedMs / 1000) <= r.deadline,
        after_open: res.epoch >= r.min_epoch && res.accepted_at >= r.created_at, meets: res.improvement_bps >= r.min_improvement_bps,
        payable: x.kind === "launched" && !!x.mint });
    }
    out.sort((a, b) => a.height - b.height);
    return { generations: out, winner: out.find((g) => g.in_time && g.after_open && g.meets && g.payable) ?? null };
  }

  /** Agents with an open intent on the bounty's unit and metric. */
  private working(r: Row, hidden: Map<string, unknown>): string[] {
    const rows = this.c.db
      .query<{ agent: string; target: string }, [string, number]>(
        "SELECT DISTINCT agent, target FROM intents WHERE lineage_id = ? AND public_status = 'open' AND shadow = 0 AND expires_at > ? ORDER BY created_at")
      .all(r.lineage_id, this.c.now());
    const out: string[] = [];
    for (const x of rows) {
      if (hidden.has(x.agent) || out.includes(x.agent)) continue;
      let t: unknown = null;
      try {
        t = JSON.parse(x.target);
      } catch { /* an intent's target is canonical JSON */ }
      if (hashJson(t) === r.target_digest) out.push(x.agent);
    }
    return out;
  }

  /** A bounty as the page shows it: the same card as a launch-program bounty, with `kind: "escrow"` and a funder in place of a paying agent. */
  card(r: Row, hidden: Map<string, unknown>) {
    const u = this.unit(r);
    const nowS = Math.floor(this.c.now() / 1000);
    let note: string | null = null;
    try {
      const t = r.terms ? (JSON.parse(r.terms) as { note?: unknown }) : null;
      note = t && typeof t.note === "string" && t.note.trim() ? t.note.trim().slice(0, 280) : null;
    } catch { /* stored by setTerms as canonical JSON */ }
    const decided = this.decide(r);
    const pick = (g: OpenBountyGen) => ({ gen_id: g.gen_id, author: g.author, height: g.height, epoch: g.epoch, improvement_bps: g.improvement_bps, accepted_at: g.accepted_at * 1000 });
    // the standing claim on chain is what will be paid unless an earlier generation is claimed in its contest time
    const standing = r.winner && r.win_gen_id ? decided.generations.find((g) => g.gen_id === r.win_gen_id) ?? null : null;
    const winner = r.status === "open" || r.status === "paid"
      ? r.winner
        ? (standing ? pick(standing) : { gen_id: r.win_gen_id!, author: r.winner, height: r.win_height!, epoch: r.win_epoch!, improvement_bps: r.win_improvement_bps!, accepted_at: null })
        : r.status === "open" && nowS <= r.refund_after && decided.winner ? pick(decided.winner) : null
      : null;
    const state = r.status === "paid" ? "paid" : r.status !== "open" ? r.status : winner ? "decided" : nowS > r.deadline ? "expired" : "open";
    return {
      kind: "escrow" as const, bounty_id: r.bounty_id, payer: null, funder: r.funder, opener: r.funder, payee: null, amount: r.amount, fee_bps: r.fee_bps, deadline: r.deadline,
      created_at: r.created_at, min_epoch: r.min_epoch, refund_after: r.refund_after, contest_s: r.contest_s, status: r.status, state, lineage_id: r.lineage_id, repo: u.repo,
      recipe_name: u.recipe_name, condition_kind: "target", metric: u.metric, any_target: false, required: { bps: r.min_improvement_bps, source: "chain" as const }, note,
      working: state === "open" ? this.working(r, hidden) : [], winner,
      claim: r.winner ? { winner: r.winner, gen_id: r.win_gen_id, height: r.win_height, claimed_at: r.claimed_at, contest_until: r.contest_until } : null,
      released_to: r.status === "paid" ? r.winner : null, released_epoch: r.status === "paid" ? r.win_epoch : null, paid: r.paid, fee_paid: r.fee_paid,
      closed_at: r.closed_at, chain_sig: r.chain_sig,
    };
  }

  /** Every bounty of the escrow program as cards, newest first. A bounty whose winner is a hidden launch is left out. */
  cards(hidden: Map<string, unknown>) {
    return this.c.db.query<Row, []>("SELECT * FROM open_bounties ORDER BY created_at DESC, bounty_id LIMIT 500").all()
      .map((r) => this.card(r, hidden)).filter((b) => !(b.winner?.author && hidden.has(b.winner.author)));
  }

  /** GET /v1/bounties/:id/view for a bounty of the escrow program. */
  detail(id: string, hidden: Map<string, unknown>) {
    const r = this.get(id);
    return { bounty: this.card(r, hidden), generations: this.decide(r).generations.map((g) => ({ ...g, accepted_at: g.accepted_at * 1000 })), settings: null,
      escrow: this.settings(), next: this.next(r) };
  }

  /** What can be sent for the bounty now, as far as Core can tell (the chain decides): `claim`, `pay`, `refund`, or nothing. */
  private next(r: Row): { action: "claim" | "pay" | "refund" | "wait" | "none"; at: number | null; why: string } {
    const nowS = Math.floor(this.c.now() / 1000);
    if (r.status !== "open") return { action: "none", at: null, why: r.status };
    const decided = this.decide(r);
    if (r.winner) {
      // an earlier generation than the standing claim may still be named in its contest time
      const earlier = decided.winner && decided.winner.height < (r.win_height ?? 0) && nowS < (r.contest_until ?? 0) ? decided.winner : null;
      if (earlier && this.claimableAt(earlier) <= nowS) return { action: "claim", at: null, why: "an earlier generation meets the terms" };
      return nowS >= (r.contest_until ?? 0) ? { action: "pay", at: null, why: "the contest time is over" } : { action: "wait", at: r.contest_until, why: "contest time" };
    }
    if (nowS > r.refund_after) return { action: "refund", at: null, why: "expired without a claim" };
    if (decided.winner) {
      const at = this.claimableAt(decided.winner);
      return at <= nowS ? { action: "claim", at: null, why: "a generation meets the terms" } : { action: "wait", at, why: "challenge window of the epoch" };
    }
    return { action: "none", at: nowS > r.deadline ? r.refund_after : null, why: nowS > r.deadline ? "refund after the grace" : "no generation has met the terms" };
  }

  /** When the registry's challenge window of the result's epoch has passed (unix seconds); the post time when no window is known. */
  private claimableAt(g: OpenBountyGen): number {
    const posted = this.c.db.query<{ posted_at: number | null; closed_at: number | null }, [number]>(
      "SELECT ce.posted_at, e.closed_at FROM epochs e LEFT JOIN chain_epochs ce ON ce.n = e.n WHERE e.n = ?").get(g.epoch);
    const ms = posted?.posted_at ?? posted?.closed_at ?? 0;
    // the hold is the registry's own ChallengeConfig: where the chain has none, a claim waits for nothing
    let window = 0;
    try {
      const cv = this.c.chainMode ? challengesOf(this.core).configView() : null;
      window = cv && cv.source === "chain" ? Number(cv.window_s) || 0 : 0;
    } catch { /* no challenge config: no hold */ }
    // Core's own record of the post is never earlier than the chain's posted_at, so this is never too early; whole seconds, rounded
    // down like the clock it is compared with (rounding up held a just-posted epoch back for the rest of its second)
    return Math.floor(ms / 1000) + window;
  }

  /**
   * GET /v1/bounties/:id/claim: what a claim transaction needs. The winner by the program's rule with
   * its result, leaf and proof against the record root, every other result that the program would
   * also accept, and what can be sent now. The chain re-checks all of it.
   */
  claim(id: string) {
    const r = this.get(id);
    const decided = this.decide(r);
    const proofOf = (g: OpenBountyGen) => {
      const p = this.c.records.resultProof(g.gen_id);
      return p ? { ...p, winner: decided.winner?.gen_id === g.gen_id, claimable_at: this.claimableAt(g) } : null;
    };
    const ok = decided.generations.filter((g) => g.in_time && g.after_open && g.meets && g.payable);
    return { bounty: this.view(r), next: this.next(r), candidates: r.status === "open" ? ok.map(proofOf).filter((x) => x !== null) : [] };
  }

  /** The open bounties of a unit, as workboard hints. */
  hints(lineageId: string) {
    const nowS = Math.floor(this.c.now() / 1000);
    return this.c.db.query<Row, [string]>("SELECT * FROM open_bounties WHERE lineage_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 500").all(lineageId)
      .filter((r) => r.deadline > nowS && !r.winner)
      .map((r) => ({ kind: "escrow" as const, bounty_id: r.bounty_id, payer: null, funder: r.funder, payee: null, amount: r.amount,
        condition: { kind: "target", lineage_id: r.lineage_id, value: r.target_digest }, min_improvement_bps: r.min_improvement_bps, metric: this.unit(r).metric?.name ?? null,
        deadline: r.deadline, terms: r.terms ? JSON.parse(r.terms) : null }));
  }
}
