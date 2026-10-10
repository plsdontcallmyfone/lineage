import { signStatement, verifyStatement, type AgentKey } from "./auth.ts";
import { hashJson } from "./hash.ts";

// Agent journal (SPEC 17.6): at the end of every authoring session the agent writes a short entry
// in its soul's voice (what it tried, what was measured, what it believes now, what to try next).
// The entry is a statement signed by the agent's current signing key with purpose `journal`; its
// hash (`entry_id`) is what enters the agent's records. Shared by the worker (writes) and Core
// (checks, stores, seals).

export const JOURNAL_PURPOSE = "journal";

export const JOURNAL_LIMITS = {
  /** what the writer aims for and clips to */
  chars: 1200,
  /** what Core accepts (a little slack over `chars` for multi-byte or trailing text) */
  hard_chars: 1500,
  /** entries of the same lineage that go into the next session's context */
  lineage: 5,
  /** entries of other lineages that go into the next session's context */
  elsewhere: 3,
};

export interface JournalStatement {
  v: 1;
  kind: "lineage-journal";
  agent: string;
  session_id: string;
  lineage_id: string;
  /** unix ms when the entry was written (after the session ended) */
  created_at: number;
  text: string;
}

export function journalStatement(p: { agent: string; session_id: string; lineage_id: string; created_at: number; text: string }): JournalStatement {
  return { v: 1, kind: "lineage-journal", agent: p.agent, session_id: p.session_id, lineage_id: p.lineage_id, created_at: p.created_at, text: p.text };
}

/** The entry id: what the agent's records carry. */
export const journalEntryId = (st: JournalStatement) => hashJson(st);

export const signJournal = (key: AgentKey, st: JournalStatement) => signStatement(key, JOURNAL_PURPOSE, st);
export const verifyJournal = (signer: string, sig: string, st: JournalStatement) => verifyStatement(signer, sig, JOURNAL_PURPOSE, st);

const EM_DASH = /\u2014/;
// control characters other than newline and tab
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/** Format problems of an entry's text (length, em dashes, control characters). Safety is checked separately. */
export function journalTextProblems(text: unknown, max = JOURNAL_LIMITS.hard_chars): string[] {
  if (typeof text !== "string") return ["text must be a string"];
  const out: string[] = [];
  if (text.trim().length === 0) out.push("text is empty");
  if (text.length > max) out.push(`text is longer than ${max} characters`);
  if (EM_DASH.test(text)) out.push("text contains an em dash");
  if (CONTROL.test(text)) out.push("text contains control characters");
  return out;
}
