import type { BountyAccount } from "@units/chain";
import { bountyOwnersOf } from "./bounty-owners.ts";
import type { Core } from "./core.ts";
import { ApiError, notFound } from "./errors.ts";
import { hiddenOf } from "./hidden.ts";
import { openBountiesOf } from "./open-bounties.ts";
import { canonicalJson, hashJson, merkleProof } from "./protocol.ts";
import { improvementBps, type Contribution } from "./records.ts";

// Bounties (identity plan C6, SPEC 14.7). The escrow lives on chain in `units_launch`; Core
// mirrors every Bounty account (ChainBridge, each sync), stores the terms whose sha256 the account
// commits to, and serves the release proof: the contribution leaf of an accepted generation that
// meets the condition, with its Merkle proof against the epoch's record root. Read-only for
// agents: nothing here moves tokens or changes a verdict, so the workboard (collab.ts) can show
// open bounties as hints from `GET /v1/lineages/:id/bounties`.

interface Internals {
  db: Core["db"];
  now(): number;
  emitEvent(type: string, data: unknown): void;
  chainMode?: boolean;
  chainView?: (() => unknown) | null;
}

// Open bounties (docs/plans/OPEN-BOUNTIES.md 4.1). A bounty's terms may name a metric and a required
// improvement: { v: 1, kind: "improvement", lineage_id, metric, min_improvement_bps, note }. The
// deployed program pays any accepted generation on the target; the required improvement and "lowest
// height first" are read here, from the replay verdict each generation carries. Nothing below moves
// tokens: `decide` names the winner, `/release` marks it, the board and the view show it.

/** A metric of a unit as the post form offers it. */
interface UnitMetric { name: string; kind: string; direction: string; deterministic: boolean; min_improvement_bps: number }
interface Unit { lineage_id: string; repo: string; recipe_name: string; metrics: UnitMetric[] }
/** One accepted generation on a bounty's target since it opened. */
export interface BountyGen {
  gen_id: string; height: number; author: string | null; accepted_at: number;
  /** the epoch whose record root holds its contribution leaf; null until that epoch closes */
  epoch: number | null;
  /** floor((1 - effect.ci_high) * 10000); null for a fix (no metric effect) */
  improvement_bps: number | null;
  reverted: boolean;
  /** its epoch's root was posted no later than the deadline */
  in_time: boolean;
  /** meets the required improvement */
  meets: boolean;
  /** the agent the reward goes to (never the paying agent); null when nobody credited can be paid */
  payee: string | null;
}
export { improvementBps };
const minBps = (minEffect: number) => Math.round(minEffect * 10_000);

export const BOUNTIES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS bounties (
    bounty_id TEXT PRIMARY KEY,          -- the Bounty account address
    payer TEXT NOT NULL,
    seq TEXT NOT NULL,                   -- the payer's onchain bounty id (u64)
    payee TEXT,                          -- null: any agent credited as author
    opener TEXT NOT NULL,
    amount TEXT NOT NULL,                -- base units
    terms_digest TEXT NOT NULL,
    terms TEXT,                          -- canonical JSON once someone supplies it (sha256 = terms_digest)
    condition_kind TEXT NOT NULL,        -- commitment | target
    lineage_id TEXT NOT NULL,
    condition_value TEXT,                -- commitment, or hashJson(target); null = any target
    min_epoch INTEGER NOT NULL,
    deadline INTEGER NOT NULL,           -- unix seconds
    created_at INTEGER NOT NULL,         -- unix seconds (chain clock)
    status TEXT NOT NULL,                -- open | released | refunded | cancelled
    released_to TEXT,
    released_epoch INTEGER,
    leaf TEXT,
    closed_at INTEGER,
    chain_sig TEXT,                      -- the open transaction, when known
    synced_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS bounties_lineage ON bounties(lineage_id, status);
  CREATE INDEX IF NOT EXISTS bounties_payee ON bounties(payee, status);
`;

interface Row {
  bounty_id: string;
  payer: string;
  seq: string;
  payee: string | null;
  opener: string;
  amount: string;
  terms_digest: string;
  terms: string | null;
  condition_kind: string;
  lineage_id: string;
  condition_value: string | null;
  min_epoch: number;
  deadline: number;
  created_at: number;
  status: string;
  released_to: string | null;
  released_epoch: number | null;
  leaf: string | null;
  closed_at: number | null;
  chain_sig: string | null;
  synced_at: number;
}

const instances = new WeakMap<Core, Bounties>();
/** The one Bounties of a Core (created on first use, schema included). */
export function bountiesOf(core: Core): Bounties {
  let b = instances.get(core);
  if (!b) instances.set(core, (b = new Bounties(core)));
  return b;
}

export class Bounties {
  private readonly c: Internals;
  constructor(core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(BOUNTIES_SCHEMA);
  }

  /** Mirrors the Bounty accounts read from chain; emits bounty.opened / released / refunded on changes. */
  sync(accounts: (BountyAccount & { address: string })[], sigOf?: (address: string) => string | null) {
    const db = this.c.db;
    const now = this.c.now();
    for (const a of accounts) {
      const prev = db.query<{ status: string; chain_sig: string | null }, [string]>("SELECT status, chain_sig FROM bounties WHERE bounty_id = ?").get(a.address);
      const row = {
        bounty_id: a.address, payer: a.payer, seq: a.bountyId.toString(), payee: a.payee, opener: a.opener, amount: a.amount.toString(),
        terms_digest: a.termsDigest, condition_kind: a.conditionKind === 0 ? "commitment" : "target", lineage_id: a.lineageId,
        condition_value: a.conditionValue, min_epoch: Number(a.minEpoch), deadline: Number(a.deadline), created_at: Number(a.createdAt), status: a.status,
        released_to: a.releasedTo, released_epoch: a.status === "released" ? Number(a.releasedEpoch) : null, leaf: a.leaf,
        closed_at: a.closedAt === 0n ? null : Number(a.closedAt), chain_sig: prev?.chain_sig ?? sigOf?.(a.address) ?? null, synced_at: now,
      };
      db.query(
        `INSERT INTO bounties (bounty_id, payer, seq, payee, opener, amount, terms_digest, condition_kind, lineage_id, condition_value, min_epoch, deadline,
           created_at, status, released_to, released_epoch, leaf, closed_at, chain_sig, synced_at)
         VALUES ($bounty_id, $payer, $seq, $payee, $opener, $amount, $terms_digest, $condition_kind, $lineage_id, $condition_value, $min_epoch, $deadline,
           $created_at, $status, $released_to, $released_epoch, $leaf, $closed_at, $chain_sig, $synced_at)
         ON CONFLICT(bounty_id) DO UPDATE SET status = excluded.status, released_to = excluded.released_to, released_epoch = excluded.released_epoch,
           leaf = excluded.leaf, closed_at = excluded.closed_at, chain_sig = COALESCE(bounties.chain_sig, excluded.chain_sig), synced_at = excluded.synced_at`,
      ).run(row as never);
      if (!prev) this.c.emitEvent("bounty.opened", this.view(this.get(a.address)));
      if (prev?.status !== a.status && a.status === "released") this.c.emitEvent("bounty.released", this.view(this.get(a.address)));
      if (prev?.status !== a.status && (a.status === "refunded" || a.status === "cancelled")) this.c.emitEvent("bounty.refunded", this.view(this.get(a.address)));
    }
  }

  private get(id: string): Row {
    const r = this.c.db.query<Row, [string]>("SELECT * FROM bounties WHERE bounty_id = ?").get(id);
    if (!r) throw notFound("bounty");
    return r;
  }

  view(r: Row) {
    return {
      bounty_id: r.bounty_id, payer: r.payer, seq: r.seq, payee: r.payee, opener: r.opener, amount: r.amount, terms_digest: r.terms_digest,
      terms: r.terms ? JSON.parse(r.terms) : null, condition: { kind: r.condition_kind, lineage_id: r.lineage_id, value: r.condition_value },
      min_epoch: r.min_epoch, deadline: r.deadline, created_at: r.created_at, status: r.status, released_to: r.released_to,
      released_epoch: r.released_epoch, leaf: r.leaf, closed_at: r.closed_at, chain_sig: r.chain_sig, synced_at: r.synced_at,
    };
  }

  /** GET /v1/bounties?lineage=&payee=&payer=&status= (status `all` for every state; default open). */
  list(f: { lineage?: string; payee?: string; payer?: string; status?: string }) {
    const where: string[] = [];
    const args: string[] = [];
    if (f.lineage) where.push("lineage_id = ?"), args.push(f.lineage);
    if (f.payer) where.push("payer = ?"), args.push(f.payer);
    // an open bounty (payee null) is offered to everyone, so it is listed for any payee
    if (f.payee) where.push("(payee = ? OR payee IS NULL)"), args.push(f.payee);
    const status = f.status ?? "open";
    if (status !== "all") where.push("status = ?"), args.push(status);
    return this.c.db
      .query<Row, string[]>(`SELECT * FROM bounties ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, bounty_id LIMIT 500`)
      .all(...args)
      .map((r) => this.view(r));
  }

  // ---------- open bounties: the winner, the board, one bounty's view ----------

  private unitCache = new Map<string, Unit | null>();
  /** The unit behind a lineage: its repository and the metrics its calibration has enabled. */
  private unit(lineageId: string): Unit | null {
    const hit = this.unitCache.get(lineageId);
    if (hit !== undefined) return hit;
    const r = this.c.db
      .query<{ url: string; name: string; recipe: string; calib: string | null }, [string]>(
        `SELECT p.url, r.name, r.json AS recipe, c.json AS calib FROM lineages l JOIN repos p ON p.repo_id = l.repo_id JOIN recipes r ON r.recipe_id = l.recipe_id
         LEFT JOIN calibrations c ON c.calib_id = l.calib_id WHERE l.lineage_id = ?`,
      )
      .get(lineageId);
    let u: Unit | null = null;
    if (r) {
      const recipe = JSON.parse(r.recipe) as { metrics?: { name: string; kind: string; direction: string; deterministic: boolean; min_effect: number }[] };
      const calib = r.calib ? (JSON.parse(r.calib) as { metrics?: Record<string, { enabled: boolean }> }) : null;
      u = { lineage_id: lineageId, repo: r.url, recipe_name: r.name,
        metrics: (recipe.metrics ?? []).filter((m) => calib?.metrics?.[m.name]?.enabled !== false)
          .map((m) => ({ name: m.name, kind: m.kind, direction: m.direction, deterministic: !!m.deterministic, min_improvement_bps: minBps(m.min_effect) })) };
    }
    this.unitCache.set(lineageId, u);
    return u;
  }

  /** The metric a target bounty names (its condition is sha256 of the metric's name), and what it requires. */
  private requirement(b: Row): { unit: Unit | null; metric: UnitMetric | null; required: { bps: number; source: "terms" | "unit" } | null; note: string | null } {
    const unit = this.unit(b.lineage_id);
    const metric = b.condition_kind === "target" && b.condition_value ? (unit?.metrics.find((m) => hashJson(m.name) === b.condition_value) ?? null) : null;
    let terms: { kind?: unknown; metric?: unknown; min_improvement_bps?: unknown; note?: unknown } | null = null;
    try {
      terms = b.terms ? JSON.parse(b.terms) : null;
    } catch { /* stored by setTerms as canonical JSON */ }
    const note = terms && typeof terms.note === "string" && terms.note.trim() ? terms.note.trim().slice(0, 280) : null;
    if (!metric) return { unit, metric, required: null, note };
    const t = terms && terms.kind === "improvement" && terms.metric === metric.name ? terms.min_improvement_bps : null;
    // a requirement below the metric's own minimum cannot be met by less than an accepted generation anyway
    const ok = typeof t === "number" && Number.isInteger(t) && t >= metric.min_improvement_bps && t < 10_000;
    return { unit, metric, required: ok ? { bps: t as number, source: "terms" } : { bps: metric.min_improvement_bps, source: "unit" }, note };
  }

  /**
   * Every accepted generation on the bounty's unit and target from its `min_epoch` on, lowest height
   * first, and the winner: the first that is not reverted, sits in an epoch posted no later than the
   * deadline, meets the required improvement and credits an agent other than the payer.
   */
  decide(b: Row): { generations: BountyGen[]; winner: BountyGen | null } {
    const { required } = this.requirement(b);
    const rows = this.c.db
      .query<{ gen_id: string; height: number; author: string | null; target: string | null; effect: string | null; accepted_at: number; reverted_by: string | null;
        c_epoch: number | null; contribution: string | null; closed_at: number | null; chain_n: number | null; chain_sig: string | null; chain_posted: number | null }, [string]>(
        `SELECT g.gen_id, g.height, g.author, g.target, g.effect, g.accepted_at, g.reverted_by, c.epoch AS c_epoch, c.contribution, e.closed_at,
           ce.n AS chain_n, ce.signature AS chain_sig, ce.posted_at AS chain_posted
         FROM generations g LEFT JOIN contributions c ON c.gen_id = g.gen_id LEFT JOIN epochs e ON e.n = c.epoch LEFT JOIN chain_epochs ce ON ce.n = c.epoch
         WHERE g.lineage_id = ? AND g.entry_type = 'patch' ORDER BY g.height`,
      )
      .all(b.lineage_id);
    const out: BountyGen[] = [];
    for (const g of rows) {
      const epoch = g.c_epoch;
      if (epoch !== null ? epoch < b.min_epoch : false) continue;
      const con = g.contribution ? (JSON.parse(g.contribution) as Contribution) : null;
      const target = g.target ? JSON.parse(g.target) : null;
      if (b.condition_kind === "commitment" ? con?.candidate_commitment !== b.condition_value : b.condition_value !== null && hashJson(target) !== b.condition_value) continue;
      const eff = g.effect ? (JSON.parse(g.effect) as { ci_high?: unknown }) : null;
      const bps = eff && typeof eff.ci_high === "number" ? improvementBps(eff.ci_high) : null;
      // posted: on chain when Core runs in chain mode (the post_epoch transaction confirmed), else the epoch's close
      const postedMs = epoch === null ? null : this.c.chainMode || g.chain_n !== null ? (g.chain_sig ? g.chain_posted : null) : g.closed_at;
      let payee: string | null = null;
      if (con) {
        if (b.payee) payee = con.members.some((m) => m.agent === b.payee) || con.finder === b.payee ? b.payee : null;
        else payee = con.members.filter((m) => m.role === "author" && m.agent !== b.payer).sort((x, y) => y.share_bps - x.share_bps || (x.agent < y.agent ? -1 : 1))[0]?.agent ?? null;
        if (payee === b.payer) payee = null;
      }
      out.push({ gen_id: g.gen_id, height: g.height, author: g.author, accepted_at: g.accepted_at, epoch, improvement_bps: bps, reverted: !!g.reverted_by,
        in_time: postedMs !== null && Math.floor(postedMs / 1000) <= b.deadline, meets: required ? bps !== null && bps >= required.bps : true, payee });
    }
    return { generations: out, winner: out.find((g) => !g.reverted && g.in_time && g.meets && g.payee !== null) ?? null };
  }

  /** Agents with an open intent on the bounty's unit and target (what they said in public they are working on). */
  private working(b: Row, hidden: Map<string, unknown>): string[] {
    if (b.condition_kind !== "target") return [];
    const rows = this.c.db
      .query<{ agent: string; target: string }, [string, number]>(
        "SELECT DISTINCT agent, target FROM intents WHERE lineage_id = ? AND public_status = 'open' AND shadow = 0 AND expires_at > ? ORDER BY created_at")
      .all(b.lineage_id, this.c.now());
    const out: string[] = [];
    for (const r of rows) {
      if (r.agent === b.payer || hidden.has(r.agent) || out.includes(r.agent)) continue;
      let t: unknown = null;
      try {
        t = JSON.parse(r.target);
      } catch { /* an intent's target is canonical JSON */ }
      if (b.condition_value === null || hashJson(t) === b.condition_value) out.push(r.agent);
    }
    return out;
  }

  /** A bounty as the page shows it. */
  private card(b: Row, hidden: Map<string, unknown>) {
    const { unit, metric, required, note } = this.requirement(b);
    const nowS = Math.floor(this.c.now() / 1000);
    const pick = (g: BountyGen) => ({ gen_id: g.gen_id, author: g.payee ?? g.author, height: g.height, epoch: g.epoch, improvement_bps: g.improvement_bps, accepted_at: g.accepted_at });
    let winner: ReturnType<typeof pick> | null = null;
    if (b.status === "released" && b.leaf) {
      const c = this.c.db.query<{ gen_id: string }, [string]>("SELECT gen_id FROM contributions WHERE leaf = ?").get(b.leaf);
      const g = c ? this.decide({ ...b, min_epoch: 0 }).generations.find((x) => x.gen_id === c.gen_id) : null;
      if (g) winner = { ...pick(g), author: b.released_to ?? g.author };
    } else if (b.status === "open") {
      const w = this.decide(b).winner;
      if (w) winner = pick(w);
    }
    const state = b.status === "released" ? "paid" : b.status !== "open" ? b.status : winner ? "decided" : nowS > b.deadline ? "expired" : "open";
    return {
      bounty_id: b.bounty_id, payer: b.payer, opener: b.opener, payee: b.payee, amount: b.amount, deadline: b.deadline, created_at: b.created_at, min_epoch: b.min_epoch,
      status: b.status, state, lineage_id: b.lineage_id, repo: unit?.repo ?? null, recipe_name: unit?.recipe_name ?? null, condition_kind: b.condition_kind,
      metric: metric ? { name: metric.name, kind: metric.kind, direction: metric.direction } : null, any_target: b.condition_kind === "target" && b.condition_value === null,
      required, note, working: state === "open" ? this.working(b, hidden) : [], winner, released_to: b.released_to, released_epoch: b.released_epoch,
      closed_at: b.closed_at, chain_sig: b.chain_sig,
    };
  }

  /** The onchain bounty config as Core's chain bridge last read it; null off chain. */
  private settings(): Record<string, unknown> | null {
    if (!this.c.chainMode) return null;
    const v = this.c.chainView?.() as { bounties?: { config?: Record<string, unknown> | null } } | null | undefined;
    return v?.bounties?.config ?? null;
  }

  /**
   * GET /v1/bounties/board: what the Bounties page reads in one call. `settings` is the onchain
   * config, `posting` who can post under the deployed program, `bounties` every bounty with its
   * repository, target, requirement, agents working on it and winner, `units` what the post form
   * offers (active units with their enabled metrics). Hidden launches are left out.
   */
  board() {
    this.unitCache.clear();
    const hidden = hiddenOf(this.c as unknown as Core).agents();
    // On mainnet the board stays closed until the owner opens it (UNITS_FEATURE_BOUNTIES=1): who may post
    // a bounty there is an open owner decision (docs/plans/OPEN-BOUNTIES.md section 3).
    const held = process.env.UNITS_FEATURE_BOUNTIES !== "1" && (process.env.UNITS_NETWORK ?? "mainnet") === "mainnet";
    const settings = held ? null : this.settings();
    // the escrow program (docs/plans/OPEN-BOUNTIES.md option A, open-bounties.ts): any wallet posts where it is configured
    const open = openBountiesOf(this.c as unknown as Core);
    const escrow = held ? null : open.settings();
    const rows = this.c.db.query<Row, []>("SELECT * FROM bounties ORDER BY created_at DESC, bounty_id LIMIT 500").all();
    const own = rows.filter((b) => !hidden.has(b.payer)).map((b) => ({ kind: "agent" as const, ...this.card(b, hidden) })).filter((b) => !(b.winner?.author && hidden.has(b.winner.author)));
    const bounties = [...own, ...open.cards(hidden)].sort((x, y) => y.created_at - x.created_at || (x.bounty_id < y.bounty_id ? -1 : 1)).map((b) => this.withOwner(b));
    const units = this.c.db.query<{ lineage_id: string }, []>("SELECT lineage_id FROM lineages WHERE status = 'active' ORDER BY created_at").all()
      .map((l) => this.unit(l.lineage_id)).filter((u): u is Unit => !!u && u.metrics.length > 0);
    return { settings, escrow, posting: { agent_owner: !!settings && settings.paused !== true, any_wallet: !!escrow && escrow.paused !== true }, bounties, units };
  }

  /**
   * `posted_by_owner`: the poster's wallet is one Core holds an ownership proof for on the bounty's repository
   * (bounty-owners.ts, docs/plans/OPEN-BOUNTIES.md 9). Read from Core's records at every call, never from the bounty's own text.
   */
  private withOwner<T extends { repo: string | null; opener: string }>(b: T): T & { posted_by_owner: ReturnType<ReturnType<typeof bountyOwnersOf>["mark"]> } {
    return { ...b, posted_by_owner: bountyOwnersOf(this.c as unknown as Core).mark(b.repo, b.opener) };
  }

  /** GET /v1/bounties/:id/view: one bounty as the page shows it, with every accepted generation on its target since it opened. */
  detail(id: string) {
    this.unitCache.clear();
    const open = openBountiesOf(this.c as unknown as Core);
    if (open.has(id)) {
      const d = open.detail(id, hiddenOf(this.c as unknown as Core).agents());
      return { ...d, bounty: this.withOwner(d.bounty) };
    }
    const b = this.get(id);
    const hidden = hiddenOf(this.c as unknown as Core).agents();
    return { bounty: this.withOwner({ kind: "agent" as const, ...this.card(b, hidden) }), generations: this.decide(b).generations, settings: this.settings() };
  }

  /** GET /v1/bounties/:id. */
  one(id: string) {
    const open = openBountiesOf(this.c as unknown as Core);
    if (open.has(id)) return open.one(id);
    return this.view(this.get(id));
  }

  /** GET /v1/lineages/:id/bounties: the open bounties of a lineage, as workboard hints. */
  hints(lineageId: string) {
    const nowS = Math.floor(this.c.now() / 1000);
    const own = this.list({ lineage: lineageId }).filter((b) => b.deadline > nowS).map((b) => ({
      bounty_id: b.bounty_id, payer: b.payer, payee: b.payee, amount: b.amount, condition: b.condition, deadline: b.deadline, terms: b.terms,
    }));
    // bounties any wallet funded (the escrow program) are hints too: they name the metric and the improvement that is paid
    return [...own, ...openBountiesOf(this.c as unknown as Core).hints(lineageId)];
  }

  /** PUT /v1/bounties/:id/terms: anyone may supply the terms; they are kept only if sha256 matches the onchain digest. */
  setTerms(id: string, terms: unknown) {
    const open = openBountiesOf(this.c as unknown as Core);
    if (open.has(id)) return open.setTerms(id, terms);
    const r = this.get(id);
    if (terms === undefined || terms === null) throw new ApiError(400, "invalid_terms", "terms required");
    if (hashJson(terms) !== r.terms_digest) throw new ApiError(409, "terms_digest", "sha256 of the canonical terms is not the onchain terms_digest");
    this.c.db.query("UPDATE bounties SET terms = ? WHERE bounty_id = ?").run(canonicalJson(terms), id);
    return this.one(id);
  }

  /** Every leaf of epoch n in root order (records.ts builds the root from the same rows). */
  private epochLeaves(n: number): string[] {
    const of = (table: string) => this.c.db.query<{ leaf: string }, [number]>(`SELECT leaf FROM ${table} WHERE epoch = ?`).all(n).map((x) => x.leaf);
    return [...of("records"), ...of("contributions"), ...of("bounty_results")].sort();
  }

  /**
   * GET /v1/bounties/:id/release: every accepted generation that releases this bounty, with the
   * contribution, its leaf and proof against the record root, and the agents it may pay (a named
   * payee if credited in any role, else every member credited as author). Only epochs whose root
   * Core posted are offered; the chain re-checks everything (and the epoch's posted_at <= deadline).
   */
  release(id: string) {
    const b = this.get(id);
    const db = this.c.db;
    const out: { epoch: number; gen_id: string; record_root: string; post_signature: string | null; contribution: Contribution; leaf: string; proof: string[];
      payees: string[]; meets_terms: boolean; winner: boolean }[] = [];
    if (b.status !== "open") return { bounty: this.view(b), candidates: out };
    // the terms' required improvement and the winner (plan 4.1): the chain accepts every candidate below, the page offers the winner
    this.unitCache.clear();
    const decided = this.decide(b);
    const meets = new Map(decided.generations.map((g) => [g.gen_id, g.meets && !g.reverted]));
    const rows = db
      .query<{ epoch: number; contribution: string; leaf: string; record_root: string | null; signature: string | null }, [number]>(
        `SELECT c.epoch, c.contribution, c.leaf, e.record_root, ce.signature FROM contributions c JOIN epochs e ON e.n = c.epoch
         LEFT JOIN chain_epochs ce ON ce.n = c.epoch WHERE c.epoch >= ? ORDER BY c.epoch, c.gen_id`,
      )
      .all(b.min_epoch);
    for (const r of rows) {
      if (!r.record_root) continue;
      const c = JSON.parse(r.contribution) as Contribution;
      if (c.lineage_id !== b.lineage_id) continue;
      if (b.condition_kind === "commitment" ? c.candidate_commitment !== b.condition_value : b.condition_value !== null && hashJson(c.target) !== b.condition_value)
        continue;
      const payees = b.payee
        ? (c.members.some((m) => m.agent === b.payee) || c.finder === b.payee ? [b.payee] : [])
        : c.members.filter((m) => m.role === "author").map((m) => m.agent);
      const eligible = payees.filter((p) => p !== b.payer);
      if (!eligible.length) continue;
      const leaves = this.epochLeaves(r.epoch);
      out.push({ epoch: r.epoch, gen_id: c.gen_id, record_root: r.record_root, post_signature: r.signature, contribution: c, leaf: r.leaf, proof: merkleProof(leaves, leaves.indexOf(r.leaf)),
        payees: eligible, meets_terms: meets.get(c.gen_id) ?? false, winner: decided.winner?.gen_id === c.gen_id });
    }
    // the winner first; the rest in epoch order
    out.sort((x, y) => Number(y.winner) - Number(x.winner));
    return { bounty: this.view(b), candidates: out };
  }
}
