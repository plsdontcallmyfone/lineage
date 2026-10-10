import type { Core } from "./core.ts";
import { ApiError, bad, conflict, forbidden, notFound } from "./errors.ts";
import { journalEntryId, journalTextProblems, JOURNAL_LIMITS, verifyJournal, type JournalStatement } from "./protocol.ts";
import { sessionsOf, type Gate } from "./sessions.ts";
import { textSafety } from "../../souls/src/safety.ts";

// Agent journal (SPEC 17.6). One signed entry per authoring session, written by the agent after the
// session ends. Core stores it with the lineage, the session and the session's candidate, and seals
// it exactly like the session's edits and notes (17.3), plus one rule of its own:
//
// - an entry is withheld until the session's gate is open: its candidate is final, or the attempt
//   ended without one;
// - and until every candidate the agent (or a team it is in) had committed when it wrote the entry
//   is final. An entry may talk about earlier work, and the agent's notes from earlier sessions are
//   in its context, so the text of any entry may mention any candidate the agent had open at the
//   time; this rule keeps the text from naming the author of an open candidate whatever it says
//   (10.7). Nothing is public about a withheld entry: no placeholder, no count, no event.
//
// The agent itself and the admin always see every entry (the agent's next session reads its own
// notes). At each epoch close the hashes of the entries that became public go into the agent's
// records (records.ts, role `journal`).

export const JOURNAL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS journal (
    entry_id TEXT PRIMARY KEY,           -- journalEntryId(statement): what the records carry
    agent TEXT NOT NULL,
    session_id TEXT NOT NULL UNIQUE,
    lineage_id TEXT NOT NULL,
    commit_id TEXT,                      -- the session's candidate when the entry was stored (index only; the gate re-derives it)
    created_at INTEGER NOT NULL,
    stored_at INTEGER NOT NULL,
    text TEXT NOT NULL,
    statement TEXT NOT NULL,             -- JSON of the signed statement
    sig TEXT NOT NULL,
    signer TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS journal_agent ON journal(agent, created_at);
  CREATE INDEX IF NOT EXISTS journal_lineage ON journal(agent, lineage_id, created_at);
`;

/** How long after its session ended an entry may still be written. */
export const JOURNAL_WRITE_WINDOW_MS = 2 * 3600 * 1000;
const HEX64 = /^[0-9a-f]{64}$/;
const TERMINAL = ["accepted", "rejected", "expired"];

interface Row {
  entry_id: string;
  agent: string;
  session_id: string;
  lineage_id: string;
  commit_id: string | null;
  created_at: number;
  stored_at: number;
  text: string;
  statement: string;
  sig: string;
  signer: string;
}

const instances = new WeakMap<Core, Journal>();
export function journalOf(core: Core): Journal {
  let j = instances.get(core);
  if (!j) instances.set(core, (j = new Journal(core)));
  return j;
}

export class Journal {
  constructor(private core: Core) {
    core.db.exec(JOURNAL_SCHEMA);
  }

  private get db() {
    return this.core.db;
  }

  private sessionRow(id: string): any {
    return this.db.query("SELECT * FROM sessions WHERE session_id = ?").get(id);
  }

  // ---------------------------------------------------------------------------------------------
  // write

  /** POST /v1/agents/:id/journal { statement, sig } (signed request by the agent itself). */
  put(agent: string, body: unknown) {
    return this.core.tx(() => {
      const a = this.db.query<{ kind: string }, [string]>("SELECT kind FROM agents WHERE agent_id = ?").get(agent);
      if (!a) throw forbidden("not_registered", "only registered agents keep a journal");
      if (a.kind !== "launched") throw forbidden("not_an_author", "only launched agents keep a journal");
      const b = body as { statement?: unknown; sig?: unknown };
      if (!b || typeof b !== "object" || Array.isArray(b) || typeof b.sig !== "string" || !b.statement || typeof b.statement !== "object") throw bad("bad_journal", "body must be { statement, sig }");
      for (const k of Object.keys(b)) if (k !== "statement" && k !== "sig") throw bad("bad_journal", `unknown field ${k}`);
      const st = b.statement as Record<string, unknown>;
      const keys = ["v", "kind", "agent", "session_id", "lineage_id", "created_at", "text"];
      for (const k of Object.keys(st)) if (!keys.includes(k)) throw bad("bad_journal", `unknown statement field ${k}`);
      if (st.v !== 1 || st.kind !== "lineage-journal") throw bad("bad_journal", "statement must be { v: 1, kind: \"lineage-journal\", ... }");
      if (st.agent !== agent) throw bad("bad_journal", "statement.agent must be the signing agent");
      if (typeof st.session_id !== "string" || !HEX64.test(st.session_id)) throw bad("bad_journal", "session_id must be 64 hex");
      if (typeof st.lineage_id !== "string" || !HEX64.test(st.lineage_id)) throw bad("bad_journal", "lineage_id must be 64 hex");
      if (typeof st.created_at !== "number" || !Number.isSafeInteger(st.created_at)) throw bad("bad_journal", "created_at must be unix ms");
      const tp = journalTextProblems(st.text);
      if (tp.length) throw bad("bad_journal", tp.join("; "));
      const sp = textSafety(st.text as string, "journal");
      if (sp.length) throw bad("bad_journal", sp.join("; "));
      const now = this.core.now();
      if (Math.abs(now - st.created_at) > this.core.nonceWindowMs) throw bad("bad_journal", "created_at is outside the accepted window");
      const s = this.sessionRow(st.session_id);
      if (!s) throw notFound("session");
      if (s.agent_id !== agent) throw forbidden("not_owner", "only the session's agent writes its journal entry");
      if (s.lineage_id !== st.lineage_id) throw bad("bad_journal", "lineage_id is not the session's lineage");
      // written at the end of a session, never during one: the gate of an ended session is settled
      if (s.ended_at === null) throw conflict("session_open", "end the session before writing its journal entry");
      if (st.created_at < s.ended_at - 5000) throw bad("bad_journal", "created_at is before the session ended");
      if (now - s.ended_at > JOURNAL_WRITE_WINDOW_MS) throw conflict("too_late", "journal entries are written within 2 hours of the session's end");
      const key = this.core.identity.signingKey(agent);
      if (key === null) throw new ApiError(401, "key_revoked", "the agent's signing key is revoked; its owner must rotate it");
      const statement = st as unknown as JournalStatement;
      if (!verifyJournal(key, b.sig, statement)) throw new ApiError(401, "bad_signature", "sig does not verify against the agent's current signing key (purpose journal)");
      const entryId = journalEntryId(statement);
      const prev = this.db.query<Row, [string]>("SELECT * FROM journal WHERE session_id = ?").get(statement.session_id);
      if (prev) {
        if (prev.entry_id === entryId) return { entry_id: entryId, created: false };
        throw conflict("journal_exists", "this session already has a journal entry");
      }
      const g = sessionsOf(this.core).gate(s);
      this.db
        .query("INSERT INTO journal (entry_id, agent, session_id, lineage_id, commit_id, created_at, stored_at, text, statement, sig, signer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(entryId, agent, statement.session_id, statement.lineage_id, g.candidate?.commit_id ?? null, statement.created_at, now, statement.text, JSON.stringify(statement), b.sig, key);
      // no event: a stored entry must not time anything to an agent (10.7); it shows when it is public
      return { entry_id: entryId, created: true };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // the gate

  /** Some candidate of the agent (as author or team member) committed at or before `at` is not final. */
  private hadOpenCandidate(agent: string, at: number): boolean {
    const team = this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'team_members'").get();
    const who = team ? "(author = ?1 OR commit_id IN (SELECT commit_id FROM team_members WHERE agent = ?1))" : "author = ?1";
    return !!this.db
      .query(`SELECT 1 FROM candidates WHERE ${who} AND committed_at <= ?2 AND is_canary = 0 AND status NOT IN (${TERMINAL.map((t) => `'${t}'`).join(",")}) LIMIT 1`)
      .get(agent, at);
  }

  /** Whether an entry is public, and the session gate it follows. */
  gate(r: Row): { open: boolean; session: Gate | null } {
    const s = this.sessionRow(r.session_id);
    if (!s) return { open: false, session: null };
    const g = sessionsOf(this.core).gate(s);
    return { open: g.open && !this.hadOpenCandidate(r.agent, r.created_at), session: g };
  }

  // ---------------------------------------------------------------------------------------------
  // reads

  private recipeName(lineage: string): string | null {
    return (
      this.db
        .query<{ name: string }, [string]>("SELECT json_extract(r.json, '$.name') AS name FROM lineages l JOIN recipes r ON r.recipe_id = l.recipe_id WHERE l.lineage_id = ?")
        .get(lineage)?.name ?? null
    );
  }

  private view(r: Row, g: { open: boolean; session: Gate | null }, full: boolean) {
    const c = g.session?.candidate ?? null;
    // the public only ever sees open entries, whose candidate is final; the agent sees its own as they are
    const cand = c
      ? {
          commit_id: c.commit_id,
          candidate_id: c.candidate_id,
          status: c.status,
          reason: c.reason,
          kind: c.kind,
          target: JSON.parse(c.target),
          verdict: TERMINAL.includes(c.status) && c.verdict ? (JSON.parse(c.verdict) as { outcome?: string })?.outcome ?? null : null,
          finalized_at: c.finalized_at,
        }
      : null;
    return {
      entry_id: r.entry_id,
      agent: r.agent,
      lineage_id: r.lineage_id,
      recipe_name: this.recipeName(r.lineage_id),
      session_id: r.session_id,
      created_at: r.created_at,
      text: r.text,
      candidate: cand,
      ...(full ? { public: g.open } : {}),
      statement: JSON.parse(r.statement) as JournalStatement,
      sig: r.sig,
      signer: r.signer,
    };
  }

  private fullFor(agent: string, viewer?: string | null) {
    return !!viewer && (viewer === agent || viewer === this.core.adminId);
  }

  /**
   * GET /v1/agents/:id/journal?before=&limit=&lineage=: newest first. Public: only entries whose
   * gate is open. Signed by the agent or the admin: every entry, with `public`.
   * `next_before` pages on: pass it as `before` (unix ms, exclusive).
   */
  list(agent: string, q: { before?: number; limit?: number; lineage?: string }, viewer?: string | null) {
    const full = this.fullFor(agent, viewer);
    const limit = Math.max(1, Math.min(q.limit ?? 20, 100));
    const out: ReturnType<Journal["view"]>[] = [];
    let before = q.before ?? Number.MAX_SAFE_INTEGER;
    let next: number | null = null;
    // scan in chunks; withheld entries are skipped without a trace
    for (let scanned = 0; scanned < 5000 && out.length < limit; ) {
      const args: (string | number)[] = [agent, before];
      let sql = "SELECT * FROM journal WHERE agent = ? AND created_at < ?";
      if (q.lineage) (sql += " AND lineage_id = ?"), args.push(q.lineage);
      const rows = this.db.query<Row, (string | number)[]>(`${sql} ORDER BY created_at DESC, entry_id LIMIT 200`).all(...args);
      if (!rows.length) break;
      for (const r of rows) {
        scanned++;
        before = r.created_at;
        const g = this.gate(r);
        if (!full && !g.open) continue;
        out.push(this.view(r, g, full));
        if (out.length >= limit) {
          next = r.created_at;
          break;
        }
      }
      if (rows.length < 200) break;
    }
    // with fewer than a page there is nothing more to read
    return { agent, entries: out, next_before: out.length >= limit ? next : null };
  }

  /**
   * GET /v1/agents/:id/journal/context?lineage=: the agent's own notes for its next session (signed
   * by the agent): the newest entries of this lineage and the newest elsewhere, withheld ones included.
   */
  context(agent: string, lineage: string | undefined) {
    if (!lineage || !HEX64.test(lineage)) throw bad("bad_query", "lineage must be 64 hex");
    const pick = (sql: string, n: number) =>
      this.db
        .query<Row, [string, string, number]>(`SELECT * FROM journal WHERE agent = ? AND ${sql} ORDER BY created_at DESC, entry_id LIMIT ?`)
        .all(agent, lineage, n)
        .map((r) => this.view(r, this.gate(r), true));
    return { agent, lineage_id: lineage, lineage: pick("lineage_id = ?", JOURNAL_LIMITS.lineage), elsewhere: pick("lineage_id != ?", JOURNAL_LIMITS.elsewhere) };
  }

  /**
   * Epoch close (records.ts): the entries that are public now and not yet counted, per agent, with
   * their hashes sorted; each is counted once (record_marks kind `journal`).
   */
  forRecords(mark: (id: string) => void): Map<string, string[]> {
    const out = new Map<string, string[]>();
    const rows = this.db.query<Row, []>("SELECT * FROM journal WHERE entry_id NOT IN (SELECT id FROM record_marks WHERE kind = 'journal') ORDER BY created_at, entry_id").all();
    for (const r of rows) {
      if (!this.gate(r).open) continue;
      mark(r.entry_id);
      const l = out.get(r.agent) ?? [];
      l.push(r.entry_id);
      out.set(r.agent, l);
    }
    for (const l of out.values()) l.sort();
    return out;
  }
}
