import type { Core } from "./core.ts";
import { ApiError, bad, conflict, forbidden, notFound } from "./errors.ts";
import { canonicalJson, hashJson, verifyStatement } from "./protocol.ts";

// Hosted runtime surfaces in Core (SPEC 13.7, 17.2; identity plan I5): provenance records per
// candidate and the public, idempotent usage records the runtime posts in the simulated mode.
//
// Provenance: for a hosted agent's candidate the runtime authority (Core's `runtimeId`) signs
// `signStatement(runtimeKey, "provenance", record)`: the operator's statement of which model,
// harness, worker version and recipe produced the candidate and what it spent ("attested"). A
// self-hosted author may post its own record signed by its current signing key ("claimed"). Core
// stores the record at any time after commit and publishes it only once the candidate is final,
// so it cannot reveal the author (or even the author's runtime class) of an open candidate (10.7).

/** The parts of Core this module uses. */
interface Internals {
  db: Core["db"];
  adminId: string;
  runtimeId?: string;
  now(): number;
  emitEvent(type: string, data: unknown): void;
  collab: Core["collab"];
  identity: Core["identity"];
}

export const HOSTED_SCHEMA = `
  CREATE TABLE IF NOT EXISTS provenance (
    commit_id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    runtime TEXT NOT NULL,         -- hosted (attested by the runtime authority) | self (claimed by the agent)
    record TEXT NOT NULL,          -- canonical JSON of the signed record
    digest TEXT NOT NULL,          -- hashJson(record)
    sig TEXT NOT NULL,
    signer TEXT NOT NULL,
    stored_at INTEGER NOT NULL
  );
`;

const FINAL = new Set(["accepted", "rejected", "expired"]);
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const nat = (x: unknown) => typeof x === "number" && Number.isInteger(x) && x >= 0;
const str = (x: unknown, max = 200) => typeof x === "string" && x.length > 0 && x.length <= max;
const hex64 = (x: unknown) => typeof x === "string" && /^[0-9a-f]{64}$/.test(x);
const decimal = (x: unknown) => typeof x === "string" && /^\d{1,30}(\.\d{1,12})?$/.test(x);

interface CandLike {
  commit_id: string;
  candidate_id: string | null;
  lineage_id: string;
  author: string;
  status: string;
}

/** Validates a provenance record's shape (identity plan I5). Returns an error message or null. */
export function checkProvenanceRecord(r: unknown): string | null {
  if (!isObj(r)) return "record must be an object";
  if (r.v !== 1) return "record.v must be 1";
  if (!hex64(r.commit_id)) return "record.commit_id must be 64 hex";
  if (!str(r.agent, 64)) return "record.agent is required";
  if (r.runtime !== "hosted" && r.runtime !== "self") return "record.runtime is hosted or self";
  const models = r.models;
  if (!Array.isArray(models) || models.length === 0 || models.length > 8 || !models.every((m) => str(m, 100))) return "record.models must list 1 to 8 model ids";
  if (!isObj(r.proposer) || !str(r.proposer.name, 64) || !str(r.proposer.version, 64)) return "record.proposer needs name and version";
  if (!str(r.worker_version, 100)) return "record.worker_version is required";
  if (!hex64(r.harness_digest)) return "record.harness_digest must be 64 hex";
  if (!hex64(r.recipe_id)) return "record.recipe_id must be 64 hex";
  if (!hex64(r.lineage_id)) return "record.lineage_id must be 64 hex";
  const u = r.usage;
  if (!isObj(u) || !["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"].every((k) => nat(u[k]))) return "record.usage needs four token counts";
  const s = r.spend;
  if (!isObj(s) || !decimal(s.usd) || (s.amount !== null && !(typeof s.amount === "string" && /^\d{1,30}$/.test(s.amount)))) return "record.spend needs usd (decimal string) and amount (base units string or null)";
  if (!nat(r.sandbox_s)) return "record.sandbox_s must be a non-negative integer";
  if (!nat(r.started_at) || !nat(r.finished_at) || (r.finished_at as number) < (r.started_at as number)) return "record.started_at and finished_at are ms timestamps";
  if (canonicalJson(r).length > 4000) return "record too large";
  return null;
}

export class Hosted {
  private readonly c: Internals;
  constructor(core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(HOSTED_SCHEMA);
    const cols = new Set(this.c.db.query<{ name: string }, []>("PRAGMA table_info(usage)").all().map((x) => x.name));
    // idempotency key and the runtime's own record (usd, token breakdown, usage epoch, prices)
    if (!cols.has("ref")) {
      this.c.db.exec("ALTER TABLE usage ADD COLUMN ref TEXT");
      this.c.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS usage_ref ON usage(ref) WHERE ref IS NOT NULL");
    }
    if (!cols.has("detail")) this.c.db.exec("ALTER TABLE usage ADD COLUMN detail TEXT");
  }

  private cand(id: string): CandLike | null {
    return (
      this.c.db.query<CandLike, [string]>("SELECT commit_id, candidate_id, lineage_id, author, status FROM candidates WHERE commit_id = ?").get(id) ??
      this.c.db.query<CandLike, [string]>("SELECT commit_id, candidate_id, lineage_id, author, status FROM candidates WHERE candidate_id = ?").get(id)
    );
  }

  /**
   * POST /v1/candidates/:id/provenance, body `{ record, sig }`. The runtime authority attests hosted
   * candidates; an author may claim its own (runtime "self"). Stored once.
   */
  submit(caller: string, id: string, body: unknown) {
    const c = this.cand(id);
    if (!c) throw notFound("candidate");
    // Only the author or the runtime authority may submit, and that is checked before anything is
    // compared with the author: otherwise "record.agent is not this candidate's author" (400) versus
    // a later 403 answered "is X the author of this open candidate?" for anyone (audit A2, OFF-01).
    if (caller !== c.author && (!this.c.runtimeId || caller !== this.c.runtimeId)) throw forbidden("not_author", "provenance is submitted by the candidate's author or the runtime authority");
    if (!isObj(body)) throw bad("bad_body", "object expected");
    const record = body.record;
    const err = checkProvenanceRecord(record);
    if (err) throw bad("bad_provenance", err);
    const r = record as Record<string, any>;
    if (typeof body.sig !== "string") throw bad("bad_sig", "sig is required");
    if (r.commit_id !== c.commit_id) throw bad("bad_provenance", "record.commit_id is not this candidate's commit id");
    if (r.agent !== c.author) throw bad("bad_provenance", "record.agent is not this candidate's author");
    const lineage = this.c.db.query<{ recipe_id: string }, [string]>("SELECT recipe_id FROM lineages WHERE lineage_id = ?").get(c.lineage_id);
    if (r.lineage_id !== c.lineage_id || r.recipe_id !== lineage?.recipe_id) throw bad("bad_provenance", "record.lineage_id and recipe_id must be the candidate's");
    const agent = this.c.db.query<{ hosted: number }, [string]>("SELECT hosted FROM agents WHERE agent_id = ?").get(c.author);
    let signer: string;
    if (r.runtime === "hosted") {
      if (!this.c.runtimeId || caller !== this.c.runtimeId) throw forbidden("not_runtime", "hosted provenance is attested by the runtime authority");
      if (!agent?.hosted) throw bad("not_hosted", "the author is not a hosted agent");
      signer = this.c.runtimeId;
    } else {
      if (caller !== c.author) throw forbidden("not_author", "a self-hosted record is claimed by the candidate's author");
      const key = this.c.identity.signingKey(c.author);
      if (!key) throw new ApiError(401, "key_revoked", "the agent's signing key is revoked");
      signer = key;
    }
    if (!verifyStatement(signer, body.sig, "provenance", r)) throw new ApiError(403, "bad_provenance_sig", `sig must be signStatement(${signer}, "provenance", record)`);
    if (this.c.db.query("SELECT 1 FROM provenance WHERE commit_id = ?").get(c.commit_id)) throw conflict("provenance_exists", "this candidate already has a provenance record");
    const digest = hashJson(r);
    this.c.db
      .query("INSERT INTO provenance (commit_id, agent, runtime, record, digest, sig, signer, stored_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(c.commit_id, c.author, r.runtime, canonicalJson(r), digest, body.sig, signer, this.c.now());
    // no public event: a "provenance stored" event for an open candidate would name hosted authors (10.7)
    return { commit_id: c.commit_id, digest, stored: true };
  }

  /**
   * GET /v1/candidates/:id/provenance. Open candidates: 409 `not_final` whether or not a record
   * exists (only the author's parties, the runtime authority and the admin see it earlier).
   */
  view(id: string, viewer?: string | null) {
    const c = this.cand(id);
    if (!c) throw notFound("candidate");
    const privileged = !!viewer && (viewer === this.c.runtimeId || viewer === this.c.adminId);
    if (!FINAL.has(c.status) && !privileged && this.c.collab.blind(c as never, viewer)) throw conflict("not_final", "provenance is published once the candidate is final (author-blind replay, SPEC 10.7)");
    const row = this.c.db
      .query<{ runtime: string; record: string; digest: string; sig: string; signer: string; stored_at: number }, [string]>("SELECT * FROM provenance WHERE commit_id = ?")
      .get(c.commit_id);
    if (!row) throw notFound("provenance");
    return {
      commit_id: c.commit_id,
      candidate_id: c.candidate_id,
      status: c.status,
      runtime: row.runtime,
      attestation: row.runtime === "hosted" ? "attested by the hosted runtime" : "claimed by the agent",
      signer: row.signer,
      record: JSON.parse(row.record),
      digest: row.digest,
      sig: row.sig,
      purpose: "provenance",
      stored_at: row.stored_at,
    };
  }

  /** An idempotent usage post seen before (same `ref`), or null. */
  usageByRef(ref: string) {
    return this.c.db.query<{ id: number; agent_id: string; amount: string }, [string]>("SELECT id, agent_id, amount FROM usage WHERE ref = ?").get(ref);
  }

  /** GET /v1/agents/:id/usage: every usage record of an agent, newest first (SPEC 3: hosted spend is public per agent). */
  usageOf(agent: string, limit = 200) {
    if (!this.c.db.query("SELECT 1 FROM agents WHERE agent_id = ?").get(agent)) throw notFound("agent");
    const rows = this.c.db
      .query<{ id: number; amount: string; model_tokens: number | null; sandbox_seconds: number | null; note: string | null; epoch: number; at: number; ref: string | null; detail: string | null }, [string, number]>(
        "SELECT id, amount, model_tokens, sandbox_seconds, note, epoch, at, ref, detail FROM usage WHERE agent_id = ? ORDER BY id DESC LIMIT ?",
      )
      .all(agent, Math.max(1, Math.min(limit, 1000)));
    let total = 0n;
    for (const r of this.c.db.query<{ amount: string }, [string]>("SELECT amount FROM usage WHERE agent_id = ?").all(agent)) total += BigInt(r.amount);
    return { agent, debited_total: total.toString(), records: rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null })) };
  }
}
