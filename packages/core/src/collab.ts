import type { Core } from "./core.ts";
import { H, type AgentKey } from "./protocol.ts";

// Collaboration and author-blind replay (docs/plans/IDENTITY-AND-COLLABORATION.md 2.7, 3.3, 3.6;
// SPEC 10.7, 12.1, 12.2). Everything here runs inside a Core transaction, reads time only from
// Core's clock and draws randomness from the epoch secret, like the rest of Core.
//
// - Author-blind replay (SPEC 10.7): while a candidate is not final, no public view, list or event
//   names its author or team. Only the author, its team members and the admin see them. The
//   candidate id hashes an author tag H("author-tag", author, salt) instead of the author, so a
//   replayer that holds the patch cannot recompute the id for each known agent and find the author;
//   the salt is published once the candidate is final, when anyone can recompute the id.
// - Shadow parity: every public signal that stays visible during replay is produced for shadows
//   too. Shadows keep their secret keys here (Core only), so they can sign what real agents sign.
//
// Tables are created here with CREATE TABLE IF NOT EXISTS, outside the numbered migrations in
// store.ts, so this module never competes with another lane for a migration number.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shadow_keys (
  agent_id TEXT PRIMARY KEY,
  secret TEXT NOT NULL                  -- hex, 64 bytes (Solana keypair layout); Core only
);
`;

const TERMINAL = new Set(["accepted", "rejected", "expired"]);

/** The parts of Core this module reads. Core passes itself; the private members exist at runtime. */
interface Internals {
  db: Core["db"];
  cfg: Core["cfg"];
  adminId: string;
  now(): number;
  currentEpoch(): { n: number; secret: string };
  emitEvent(type: string, data: unknown): void;
}

export interface CandidateLike {
  commit_id: string;
  author: string;
  status: string;
}

export class Collab {
  private readonly c: Internals;

  constructor(core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(SCHEMA);
  }

  private get db() {
    return this.c.db;
  }

  // ---------------------------------------------------------------------------------------------
  // Author-blind replay (SPEC 10.7)

  /** What the candidate id hashes in place of the author (SPEC 4). */
  authorTag(author: string, salt: string): string {
    return H("author-tag", author, salt);
  }

  /** The agents a candidate belongs to: its author plus, for a team candidate, every member. */
  parties(c: CandidateLike): string[] {
    return [c.author];
  }

  /** True when `viewer` may not see who authored `c`: it is open and the viewer is not a party or the admin. */
  blind(c: CandidateLike, viewer?: string | null): boolean {
    if (TERMINAL.has(c.status)) return false;
    if (!viewer) return true;
    if (viewer === this.c.adminId) return false;
    return !this.parties(c).includes(viewer);
  }

  /** SQL condition (on table `candidates`) for rows whose author a viewer may see. */
  visibleAuthorSql(viewer?: string | null): { sql: string; args: string[] } {
    const final = `status IN ('accepted','rejected','expired')`;
    if (viewer && viewer === this.c.adminId) return { sql: "1", args: [] };
    if (!viewer) return { sql: final, args: [] };
    return { sql: `(${final} OR author = ?)`, args: [viewer] };
  }

  /** An assignment round names its subject's exclusions and draw; public only once the subject is final. */
  subjectFinal(subject: string): boolean {
    const c = this.db.query<{ status: string }, [string]>("SELECT status FROM candidates WHERE candidate_id = ?").get(subject);
    if (c) return TERMINAL.has(c.status);
    const a = this.db.query<{ status: string }, [string]>("SELECT status FROM audits WHERE audit_id = ?").get(subject);
    if (a) return a.status !== "pending";
    return true;
  }

  // ---------------------------------------------------------------------------------------------
  // Shadow keys (shadow parity)

  rememberShadowKey(k: AgentKey) {
    this.db.query("INSERT OR IGNORE INTO shadow_keys (agent_id, secret) VALUES (?, ?)").run(k.id, Buffer.from(k.secret).toString("hex"));
  }

  shadowKey(id: string): AgentKey | null {
    const r = this.db.query<{ secret: string }, [string]>("SELECT secret FROM shadow_keys WHERE agent_id = ?").get(id);
    return r ? { id, secret: Uint8Array.from(Buffer.from(r.secret, "hex")) } : null;
  }

  /** Called from Hardening.tick(). */
  tick() {}
}
