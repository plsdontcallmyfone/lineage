import type { Core } from "./core.ts";
import { slashId } from "./chain.ts";
import { notFound } from "./errors.ts";
import { canonicalJson, hashJson, leafHash, merkleProof, merkleRoot, signStatement, verifyProof, type AgentKey } from "./protocol.ts";

// Reputation records and contribution leaves (identity plan I2, SPEC 13.10, 14.1). At every epoch
// close Core summarises what became final in that epoch, per agent, and Merkle-roots the summaries
// together with one contribution leaf per accepted generation. The root is posted on chain as
// `Epoch.record_root`; every record is public, and anyone can check a credential against the posted
// roots without trusting Core (`scripts/verify-credential.ts`).
//
// Attribution is by finality, so a record never says anything about sealed work: everything counts
// in the first epoch close at which it is final (a mark in `record_marks` keeps it from counting
// twice): a candidate once final, its replays with it, a generation once accepted, an audit, revert
// or qualification once resolved, strikes and slashes once applied (they are public on chain at
// once). Replay units follow Core's own epoch attribution (the payout leaves). Shadow authors (canaries) get no
// author record; the canaries they ran are public at close anyway (SPEC 10.5).
//
// Leaves (canonical JSON, protocol leafHash; sorted by hash before the Merkle root):
//   record:       { epoch, agent, role: "author" | "verifier", lineage_id | null, record_digest }
//   contribution: { epoch, gen_id, lineage_id, target, candidate_commitment, members, finder }
// with record_digest = hashJson(record) and members [{ agent, role, share_bps }] (the lone author
// with 10,000 until teams exist, then the team's declared shares).

interface Internals {
  db: Core["db"];
  identity: Core["identity"];
  issuerKey: Core["issuerKey"];
  now(): number;
}

export const RECORDS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS records (
    epoch INTEGER NOT NULL,
    agent TEXT NOT NULL,
    role TEXT NOT NULL,                  -- author | verifier
    lineage_id TEXT NOT NULL DEFAULT '', -- '' for verifier records
    record TEXT NOT NULL,                -- canonical JSON
    leaf TEXT NOT NULL,
    PRIMARY KEY (epoch, agent, role, lineage_id)
  );
  CREATE TABLE IF NOT EXISTS contributions (
    gen_id TEXT PRIMARY KEY,
    epoch INTEGER NOT NULL,
    contribution TEXT NOT NULL,          -- canonical JSON of the leaf object
    leaf TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS contributions_epoch ON contributions(epoch);
  CREATE TABLE IF NOT EXISTS record_marks (
    kind TEXT NOT NULL,                  -- cand | gen | revert | audit | strike | slash | qual
    id TEXT NOT NULL,
    epoch INTEGER NOT NULL,              -- the epoch whose records counted it
    PRIMARY KEY (kind, id)
  );
`;

export interface AuthorRecord {
  v: 1;
  epoch: number;
  agent: string;
  role: "author";
  lineage_id: string;
  candidates: { final: number; revealed: number; accepted: number; rejected: number; expired: number };
  rejections: Record<string, number>;
  accepted: { gen_id: string; candidate_id: string; kind: string; target: unknown; effect: unknown; author_units: number }[];
  reverted: string[];
  audits: Record<string, number>;
  finder: { gen_id: string; units: number }[];
}
export interface VerifierRecord {
  v: 1;
  epoch: number;
  agent: string;
  role: "verifier";
  lineage_id: null;
  replays: Record<string, number>;
  audit_replays: Record<string, number>;
  canaries: { caught: number; accepted: number };
  strikes: Record<string, number>;
  slashes: { slash_id: string; reason: string; amount: string }[];
  slashed_total: string;
  replay_units: number;
  qualifications: { lineage_id: string; status: string }[];
}
export type AgentRecordDoc = AuthorRecord | VerifierRecord;
export interface Contribution {
  epoch: number;
  gen_id: string;
  lineage_id: string;
  target: unknown;
  candidate_commitment: string;
  members: { agent: string; role: string; share_bps: number }[];
  finder: string | null;
}

export const recordLeaf = (r: AgentRecordDoc) =>
  leafHash(canonicalJson({ epoch: r.epoch, agent: r.agent, role: r.role, lineage_id: r.lineage_id, record_digest: hashJson(r) }));
export const contributionLeaf = (c: Contribution) => leafHash(canonicalJson(c));

const inc = (m: Record<string, number>, k: string, by = 1) => (m[k] = (m[k] ?? 0) + by);
const sortObj = (m: Record<string, number>) => Object.fromEntries(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
/** Floating units rounded to a fixed precision so the record encodes identically everywhere. */
const units6 = (u: number) => Math.round(u * 1e6) / 1e6;

export class Records {
  private readonly c: Internals;
  constructor(core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(RECORDS_SCHEMA);
    const cols = this.c.db.query<{ name: string }, []>("PRAGMA table_info(epochs)").all();
    if (!cols.some((c) => c.name === "record_root")) this.c.db.exec("ALTER TABLE epochs ADD COLUMN record_root TEXT");
  }

  private isShadow(agent: string): boolean {
    const a = this.c.db.query<{ shadow: number; kind: string }, [string]>("SELECT shadow, kind FROM agents WHERE agent_id = ?").get(agent);
    return !!a && (a.shadow === 1 || (a.kind as string) === "shadow");
  }

  /** Team members of a candidate when the collaboration layer stores them (C4), else the lone author. */
  private members(commitId: string, author: string): Contribution["members"] {
    const has = this.c.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'team_members'").get();
    if (has) {
      const rows = this.c.db
        .query<{ agent: string; role: string; share_bps: number }, [string]>("SELECT agent, role, share_bps FROM team_members WHERE commit_id = ? ORDER BY agent")
        .all(commitId);
      if (rows.length) return rows.map((r) => ({ agent: r.agent, role: r.role, share_bps: Number(r.share_bps) }));
    }
    return [{ agent: author, role: "author", share_bps: 10_000 }];
  }

  /**
   * Builds, stores and roots the records of epoch `n` from everything final and not yet counted.
   * Runs inside the epoch-close transaction; returns the record root (protocol merkleRoot, H("empty") if none).
   */
  buildEpoch(n: number): { root: string; records: number; contributions: number } {
    const db = this.c.db;
    const unmarked = (kind: string, col: string) => `${col} NOT IN (SELECT id FROM record_marks WHERE kind = '${kind}')`;
    const mark = (kind: string, id: string | number) => db.query("INSERT OR IGNORE INTO record_marks (kind, id, epoch) VALUES (?, ?, ?)").run(kind, String(id), n);
    const authors = new Map<string, AuthorRecord>();
    const author = (agent: string, lineage: string): AuthorRecord => {
      const k = `${agent}\n${lineage}`;
      let r = authors.get(k);
      if (!r) {
        r = { v: 1, epoch: n, agent, role: "author", lineage_id: lineage, candidates: { final: 0, revealed: 0, accepted: 0, rejected: 0, expired: 0 },
          rejections: {}, accepted: [], reverted: [], audits: {}, finder: [] };
        authors.set(k, r);
      }
      return r;
    };
    const verifiers = new Map<string, VerifierRecord>();
    const verifier = (agent: string): VerifierRecord => {
      let r = verifiers.get(agent);
      if (!r) {
        r = { v: 1, epoch: n, agent, role: "verifier", lineage_id: null, replays: {}, audit_replays: {}, canaries: { caught: 0, accepted: 0 }, strikes: {},
          slashes: [], slashed_total: "0", replay_units: 0, qualifications: [] };
        verifiers.set(agent, r);
      }
      return r;
    };

    // candidates final in the window
    const finals = db
      .query<{ commit_id: string; candidate_id: string | null; lineage_id: string; author: string; status: string; reason: string | null;
        revealed_at: number | null; is_canary: number }, []>(
        `SELECT commit_id, candidate_id, lineage_id, author, status, reason, revealed_at, is_canary FROM candidates
         WHERE status IN ('accepted','rejected','expired') AND ${unmarked("cand", "commit_id")} ORDER BY finalized_at, commit_id`,
      )
      .all();
    for (const c of finals) {
      mark("cand", c.commit_id);
      if (!this.isShadow(c.author) && !c.is_canary) {
        const r = author(c.author, c.lineage_id);
        r.candidates.final++;
        if (c.revealed_at !== null) r.candidates.revealed++;
        if (c.status === "accepted") r.candidates.accepted++;
        else if (c.status === "expired") r.candidates.expired++;
        else {
          r.candidates.rejected++;
          inc(r.rejections, c.reason ?? "unknown");
        }
      }
      if (!c.candidate_id) continue;
      // every replay of a final candidate is resolved: attribute it here
      const reps = db
        .query<{ replayer: string; status: string; role: string | null; kind: string }, [string]>(
          "SELECT replayer, status, role, kind FROM replays WHERE candidate_id = ? AND audit_id IS NULL ORDER BY replay_id",
        )
        .all(c.candidate_id);
      for (const rp of reps) {
        const v = verifier(rp.replayer);
        inc(v.replays, "assigned");
        if (rp.role === "canary_pass") v.canaries.caught++;
        else if (rp.role === "canary_fail") v.canaries.accepted++;
        else if (rp.status === "revealed") inc(v.replays, rp.role ?? "revealed");
        else inc(v.replays, rp.status);
      }
    }
    // generations accepted in the window: accepted list, author units, contribution leaves
    const gens = db
      .query<{ gen_id: string; lineage_id: string; candidate_id: string; kind: string; target: string; effect: string | null; author: string; accepted_at: number }, []>(
        `SELECT gen_id, lineage_id, candidate_id, kind, target, effect, author, accepted_at FROM generations WHERE entry_type = 'patch' AND ${unmarked("gen", "gen_id")} ORDER BY accepted_at, gen_id`,
      )
      .all();
    const contributions: Contribution[] = [];
    for (const g of gens) {
      mark("gen", g.gen_id);
      const units = db.query<{ u: number | null }, [string, string]>("SELECT SUM(units) AS u FROM units WHERE ref = ? AND agent_id = ? AND kind = 'author' AND voided = 0").get(g.gen_id, g.author)!.u ?? 0;
      author(g.author, g.lineage_id).accepted.push({ gen_id: g.gen_id, candidate_id: g.candidate_id, kind: g.kind, target: JSON.parse(g.target),
        effect: g.effect ? JSON.parse(g.effect) : null, author_units: units6(units) });
      const cand = db.query<{ commit_id: string; commitment: string }, [string]>("SELECT commit_id, commitment FROM candidates WHERE candidate_id = ?").get(g.candidate_id)!;
      const finders = db
        .query<{ agent_id: string }, [string]>("SELECT DISTINCT agent_id FROM units WHERE ref = ? AND kind = 'finder' ORDER BY agent_id")
        .all(g.gen_id)
        .map((f) => f.agent_id);
      const members = this.members(cand.commit_id, g.author);
      for (const f of finders.slice(1)) members.push({ agent: f, role: "finder", share_bps: 0 });
      contributions.push({ epoch: n, gen_id: g.gen_id, lineage_id: g.lineage_id, target: JSON.parse(g.target), candidate_commitment: cand.commitment, members,
        finder: finders[0] ?? null });
      for (const f of finders) {
        const fu = db.query<{ u: number | null }, [string, string]>("SELECT SUM(units) AS u FROM units WHERE ref = ? AND agent_id = ? AND kind = 'finder' AND voided = 0").get(g.gen_id, f)!.u ?? 0;
        author(f, g.lineage_id).finder.push({ gen_id: g.gen_id, units: units6(fu) });
      }
    }
    // reverts in the window
    for (const rv of db
      .query<{ gen_id: string; reverts: string; lineage_id: string; author: string }, []>(
        `SELECT gen_id, reverts, lineage_id, author FROM generations WHERE entry_type = 'revert' AND ${unmarked("revert", "gen_id")} ORDER BY accepted_at, gen_id`,
      )
      .all()) {
      mark("revert", rv.gen_id);
      author(rv.author, rv.lineage_id).reverted.push(rv.reverts);
    }
    // audits resolved in the window: outcome for the author, audit replays for the verifiers
    for (const a of db
      .query<{ audit_id: string; status: string; lineage_id: string; author: string }, []>(
        `SELECT a.audit_id, a.status, g.lineage_id, g.author FROM audits a JOIN generations g ON g.gen_id = a.gen_id
         WHERE a.resolved_at IS NOT NULL AND a.status <> 'pending' AND ${unmarked("audit", "a.audit_id")} ORDER BY a.resolved_at, a.audit_id`,
      )
      .all()) {
      mark("audit", a.audit_id);
      inc(author(a.author, a.lineage_id).audits, a.status);
      for (const rp of db
        .query<{ replayer: string; status: string; role: string | null }, [string]>("SELECT replayer, status, role FROM replays WHERE audit_id = ? ORDER BY replay_id")
        .all(a.audit_id)) {
        const v = verifier(rp.replayer);
        inc(v.audit_replays, "assigned");
        inc(v.audit_replays, rp.status === "revealed" ? (rp.role ?? "revealed") : rp.status);
      }
    }
    // strikes and slashes applied in the window (already public on chain), replay units of the epoch
    for (const s of db.query<{ id: number; agent_id: string; reason: string }, []>(`SELECT id, agent_id, reason FROM strikes WHERE ${unmarked("strike", "CAST(id AS TEXT)")} ORDER BY id`).all()) {
      mark("strike", s.id);
      inc(verifier(s.agent_id).strikes, s.reason);
    }
    for (const s of db
      .query<{ id: number; agent_id: string; reason: string; ref: string; epoch: number; amount: string }, []>(
        `SELECT id, agent_id, reason, ref, epoch, amount FROM slashes WHERE ${unmarked("slash", "CAST(id AS TEXT)")} ORDER BY id`,
      )
      .all()) {
      mark("slash", s.id);
      const v = verifier(s.agent_id);
      v.slashes.push({ slash_id: slashId(s), reason: s.reason, amount: s.amount });
      v.slashed_total = (BigInt(v.slashed_total) + BigInt(s.amount)).toString();
    }
    for (const u of db
      .query<{ agent_id: string; u: number }, [number]>("SELECT agent_id, SUM(units) AS u FROM units WHERE epoch = ? AND kind = 'replay' AND voided = 0 GROUP BY agent_id ORDER BY agent_id")
      .all(n))
      verifier(u.agent_id).replay_units = units6(u.u);
    for (const q of db
      .query<{ qual_id: string; agent_id: string; lineage_id: string; status: string }, []>(
        `SELECT qual_id, agent_id, lineage_id, status FROM qualifications WHERE status IN ('passed','failed') AND ${unmarked("qual", "qual_id")} ORDER BY resolved_at, qual_id`,
      )
      .all()) {
      mark("qual", q.qual_id);
      verifier(q.agent_id).qualifications.push({ lineage_id: q.lineage_id, status: q.status });
    }

    const docs: AgentRecordDoc[] = [];
    for (const r of authors.values()) {
      if (this.isShadow(r.agent)) continue;
      r.rejections = sortObj(r.rejections);
      r.audits = sortObj(r.audits);
      docs.push(r);
    }
    for (const r of verifiers.values()) {
      if (this.isShadow(r.agent)) continue;
      r.replays = sortObj(r.replays);
      r.audit_replays = sortObj(r.audit_replays);
      r.strikes = sortObj(r.strikes);
      docs.push(r);
    }
    const leaves: string[] = [];
    db.query("DELETE FROM records WHERE epoch = ?").run(n);
    db.query("DELETE FROM contributions WHERE epoch = ?").run(n);
    for (const r of docs) {
      const leaf = recordLeaf(r);
      leaves.push(leaf);
      db.query("INSERT INTO records (epoch, agent, role, lineage_id, record, leaf) VALUES (?, ?, ?, ?, ?, ?)").run(n, r.agent, r.role, r.lineage_id ?? "", canonicalJson(r), leaf);
    }
    for (const c of contributions) {
      const leaf = contributionLeaf(c);
      leaves.push(leaf);
      db.query("INSERT INTO contributions (gen_id, epoch, contribution, leaf) VALUES (?, ?, ?, ?)").run(c.gen_id, n, canonicalJson(c), leaf);
    }
    leaves.sort();
    const root = merkleRoot(leaves);
    db.query("UPDATE epochs SET record_root = ? WHERE n = ?").run(root, n);
    return { root, records: docs.length, contributions: contributions.length };
  }

  /** Every leaf of epoch `n`, sorted (the order the root was built in). */
  private epochLeaves(n: number): string[] {
    const r = this.c.db.query<{ leaf: string }, [number]>("SELECT leaf FROM records WHERE epoch = ?").all(n).map((x) => x.leaf);
    const c = this.c.db.query<{ leaf: string }, [number]>("SELECT leaf FROM contributions WHERE epoch = ?").all(n).map((x) => x.leaf);
    return [...r, ...c].sort();
  }

  /** An agent's records (and contributions naming it) with proofs against each epoch's record root. */
  forAgent(agent: string, epoch?: number) {
    const db = this.c.db;
    const recs = db
      .query<{ epoch: number; record: string; leaf: string }, [string]>("SELECT epoch, record, leaf FROM records WHERE agent = ? ORDER BY epoch, role, lineage_id")
      .all(agent)
      .filter((r) => epoch === undefined || r.epoch === epoch);
    const contribs = db
      .query<{ epoch: number; contribution: string; leaf: string }, []>("SELECT epoch, contribution, leaf FROM contributions ORDER BY epoch, gen_id")
      .all()
      .filter((c) => (epoch === undefined || c.epoch === epoch) && (JSON.parse(c.contribution) as Contribution).members.concat(
        (JSON.parse(c.contribution) as Contribution).finder ? [{ agent: (JSON.parse(c.contribution) as Contribution).finder!, role: "finder", share_bps: 0 }] : [],
      ).some((m) => m.agent === agent));
    const byEpoch = new Map<number, { epoch: number; record_root: string; leaves: CredentialLeaf[] }>();
    const all = new Map<number, string[]>();
    const add = (n: number, leaf: CredentialLeaf) => {
      const ep = db.query<{ record_root: string | null }, [number]>("SELECT record_root FROM epochs WHERE n = ?").get(n);
      if (!ep?.record_root) return;
      if (!all.has(n)) all.set(n, this.epochLeaves(n));
      const leaves = all.get(n)!;
      leaf.proof = merkleProof(leaves, leaves.indexOf(leaf.leaf));
      if (!byEpoch.has(n)) byEpoch.set(n, { epoch: n, record_root: ep.record_root, leaves: [] });
      byEpoch.get(n)!.leaves.push(leaf);
    };
    for (const r of recs) add(r.epoch, { kind: "record", leaf: r.leaf, record: JSON.parse(r.record), proof: [] });
    for (const c of contribs) add(c.epoch, { kind: "contribution", leaf: c.leaf, contribution: JSON.parse(c.contribution), proof: [] });
    return [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch);
  }

  /** GET /v1/agents/:id/records: records and contributions naming the agent, with proofs. */
  view(agent: string, epoch?: number) {
    if (!this.c.db.query("SELECT 1 FROM agents WHERE agent_id = ?").get(agent)) throw notFound("agent");
    // a shadow answers exactly as a real agent with nothing final yet (SPEC 10.7): a 404 here would
    // name every member of the shadow pool from the moment it launches, before any canary
    return { agent, epochs: this.isShadow(agent) ? [] : this.forAgent(agent, epoch) };
  }

  /** GET /v1/agents/:id/credential. */
  credentialFor(agent: string) {
    const reg = this.c.db.query<{ registered_at: number }, [string]>("SELECT registered_at FROM agents WHERE agent_id = ?").get(agent);
    if (!reg) throw notFound("agent");
    return this.credential(agent, {
      now: this.c.now(),
      issuer: this.c.issuerKey,
      controllerSince: this.c.identity.controller(agent, reg.registered_at).since,
      postSignature: (n) => this.c.db.query<{ signature: string | null }, [number]>("SELECT signature FROM chain_epochs WHERE n = ?").get(n)?.signature ?? null,
    });
  }

  /**
   * The portable credential (identity plan 2.4). `post_signature` is the post_epoch transaction in
   * chain mode. Signed by Core's issuer key when it has one (the Core authority in chain mode); the
   * signature only says "Core issued this bundle at this time": verification needs only the chain.
   */
  credential(agent: string, opts: { now: number; issuer: AgentKey | null; controllerSince: number | null; postSignature: (n: number) => string | null }) {
    if (!this.c.db.query("SELECT 1 FROM agents WHERE agent_id = ?").get(agent)) throw notFound("agent");
    const epochs = (this.isShadow(agent) ? [] : this.forAgent(agent)).map((e) => ({ ...e, post_signature: opts.postSignature(e.epoch) }));
    const body = {
      v: 1 as const,
      kind: "lineage-reputation" as const,
      agent,
      issued_at: opts.now,
      issuer: opts.issuer?.id ?? null,
      controller_since: opts.controllerSince,
      epochs,
      totals: credentialTotals(agent, epochs),
    };
    return { ...body, sig: opts.issuer ? signStatement(opts.issuer, "credential", body) : null };
  }
}

export type CredentialLeaf =
  | { kind: "record"; leaf: string; record: AgentRecordDoc; proof: string[] }
  | { kind: "contribution"; leaf: string; contribution: Contribution; proof: string[] };

export interface CredentialTotals {
  epochs: number;
  candidates_final: number;
  accepted: number;
  rejected: number;
  expired: number;
  reverted: number;
  author_units: number;
  contributions: number;
  replays: number;
  replays_counted: number;
  replays_minority: number;
  replays_invalid: number;
  replays_abandoned: number;
  audit_replays: number;
  canaries_caught: number;
  canaries_accepted: number;
  strikes: number;
  slashed_total: string;
}

/** Totals recomputed from the leaves only (what a verifier recomputes too). */
export function credentialTotals(agent: string, epochs: { leaves: CredentialLeaf[] }[]): CredentialTotals {
  const t: CredentialTotals = { epochs: epochs.length, candidates_final: 0, accepted: 0, rejected: 0, expired: 0, reverted: 0, author_units: 0, contributions: 0,
    replays: 0, replays_counted: 0, replays_minority: 0, replays_invalid: 0, replays_abandoned: 0, audit_replays: 0, canaries_caught: 0, canaries_accepted: 0,
    strikes: 0, slashed_total: "0" };
  for (const e of epochs)
    for (const l of e.leaves) {
      if (l.kind === "contribution") {
        t.contributions++;
        continue;
      }
      const r = l.record;
      if (r.agent !== agent) continue;
      if (r.role === "author") {
        t.candidates_final += r.candidates.final;
        t.accepted += r.candidates.accepted;
        t.rejected += r.candidates.rejected;
        t.expired += r.candidates.expired;
        t.reverted += r.reverted.length;
        t.author_units = units6(t.author_units + r.accepted.reduce((s, a) => s + a.author_units, 0));
      } else {
        t.replays += r.replays.assigned ?? 0;
        t.replays_counted += r.replays.counted ?? 0;
        t.replays_minority += r.replays.minority ?? 0;
        t.replays_invalid += r.replays.invalid ?? 0;
        t.replays_abandoned += r.replays.abandoned ?? 0;
        t.audit_replays += r.audit_replays.assigned ?? 0;
        t.canaries_caught += r.canaries.caught;
        t.canaries_accepted += r.canaries.accepted;
        t.strikes += Object.values(r.strikes).reduce((a, b) => a + b, 0);
        t.slashed_total = (BigInt(t.slashed_total) + BigInt(r.slashed_total)).toString();
      }
    }
  return t;
}

/**
 * Checks a credential against record roots read from chain (`roots.get(epoch)`: the onchain
 * `Epoch.record_root`, null when absent). Recomputes every leaf from its record, every proof and
 * the totals; Core's signature is not needed and not trusted.
 */
export function verifyCredential(cred: { agent: string; epochs: { epoch: number; record_root: string; leaves: CredentialLeaf[] }[]; totals: CredentialTotals },
  roots: Map<number, string | null>): { ok: boolean; errors: string[]; checked: number; totals: CredentialTotals } {
  const errors: string[] = [];
  let checked = 0;
  for (const e of cred.epochs) {
    const onchain = roots.get(e.epoch);
    if (!onchain) {
      errors.push(`epoch ${e.epoch}: no record_root on chain`);
      continue;
    }
    if (onchain !== e.record_root) errors.push(`epoch ${e.epoch}: credential root ${e.record_root.slice(0, 16)} is not the onchain root ${onchain.slice(0, 16)}`);
    for (const l of e.leaves) {
      const leaf = l.kind === "record" ? recordLeaf(l.record) : contributionLeaf(l.contribution);
      const subject = l.kind === "record" ? l.record.agent : l.contribution.members.some((m) => m.agent === cred.agent) || l.contribution.finder === cred.agent;
      if (l.kind === "record" && l.record.epoch !== e.epoch) errors.push(`epoch ${e.epoch}: a record names epoch ${l.record.epoch}`);
      if (l.kind === "contribution" && l.contribution.epoch !== e.epoch) errors.push(`epoch ${e.epoch}: a contribution names epoch ${l.contribution.epoch}`);
      if (subject !== true && subject !== cred.agent) errors.push(`epoch ${e.epoch}: a leaf is about another agent`);
      if (leaf !== l.leaf) errors.push(`epoch ${e.epoch}: leaf ${l.leaf.slice(0, 16)} does not hash from its ${l.kind}`);
      else if (!verifyProof(leaf, l.proof, onchain)) errors.push(`epoch ${e.epoch}: leaf ${leaf.slice(0, 16)} proof does not verify against the onchain root`);
      else checked++;
    }
  }
  const totals = credentialTotals(cred.agent, cred.epochs);
  if (canonicalJson(totals) !== canonicalJson(cred.totals)) errors.push("totals do not equal the sums of the records");
  return { ok: errors.length === 0, errors, checked, totals };
}
