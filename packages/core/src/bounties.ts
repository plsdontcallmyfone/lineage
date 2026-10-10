import type { BountyAccount } from "@lineage/chain";
import type { Core } from "./core.ts";
import { ApiError, notFound } from "./errors.ts";
import { canonicalJson, hashJson, merkleProof } from "./protocol.ts";
import type { Contribution } from "./records.ts";

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
}

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

  /** GET /v1/bounties/:id. */
  one(id: string) {
    return this.view(this.get(id));
  }

  /** GET /v1/lineages/:id/bounties: the open bounties of a lineage, as workboard hints. */
  hints(lineageId: string) {
    const nowS = Math.floor(this.c.now() / 1000);
    return this.list({ lineage: lineageId }).filter((b) => b.deadline > nowS).map((b) => ({
      bounty_id: b.bounty_id, payer: b.payer, payee: b.payee, amount: b.amount, condition: b.condition, deadline: b.deadline, terms: b.terms,
    }));
  }

  /** PUT /v1/bounties/:id/terms: anyone may supply the terms; they are kept only if sha256 matches the onchain digest. */
  setTerms(id: string, terms: unknown) {
    const r = this.get(id);
    if (terms === undefined || terms === null) throw new ApiError(400, "invalid_terms", "terms required");
    if (hashJson(terms) !== r.terms_digest) throw new ApiError(409, "terms_digest", "sha256 of the canonical terms is not the onchain terms_digest");
    this.c.db.query("UPDATE bounties SET terms = ? WHERE bounty_id = ?").run(canonicalJson(terms), id);
    return this.one(id);
  }

  /** Every leaf of epoch n in root order (records.ts builds the root from the same rows). */
  private epochLeaves(n: number): string[] {
    const db = this.c.db;
    const r = db.query<{ leaf: string }, [number]>("SELECT leaf FROM records WHERE epoch = ?").all(n).map((x) => x.leaf);
    const c = db.query<{ leaf: string }, [number]>("SELECT leaf FROM contributions WHERE epoch = ?").all(n).map((x) => x.leaf);
    return [...r, ...c].sort();
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
      payees: string[] }[] = [];
    if (b.status !== "open") return { bounty: this.view(b), candidates: out };
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
        payees: eligible });
    }
    return { bounty: this.view(b), candidates: out };
  }
}
