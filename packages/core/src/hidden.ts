import type { Core } from "./core.ts";
import { bad } from "./errors.ts";

// Hidden launches (docs/plans/APP-CONSOLIDATION.md, amendment 2026-10-10 (2)): a list of agent token
// mints kept out of the app's listings (Explorer, Agents, search, Eco), each with a reason. The
// admin edits it with POST /v1/admin/hidden, so a test launch leaves the listings without a redeploy.
// Nothing is deleted or altered: the token, its agent and its work stay readable, and a direct link
// still resolves (the page says "hidden from listings"). GET /v1/hidden is public, so anyone can see
// what is hidden and why. The market indexer reads it on every Core pass.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS hidden_mints (
  mint TEXT PRIMARY KEY,
  agent TEXT,
  reason TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  added_by TEXT NOT NULL
);`;

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX = 1000;

interface Internals {
  db: Core["db"];
  now(): number;
  emitEvent(type: string, data: unknown): void;
}

export interface HiddenRow {
  mint: string;
  agent: string | null;
  reason: string;
  added_at: number;
  added_by: string;
}

const instances = new WeakMap<Core, Hidden>();
export function hiddenOf(core: Core): Hidden {
  let h = instances.get(core);
  if (!h) instances.set(core, (h = new Hidden(core)));
  return h;
}

/** What a hidden agent's detail says (the indexer's token detail has the same reason and added_at). */
export interface HiddenMark {
  mint: string;
  reason: string;
  added_at: number;
}

export class Hidden {
  private readonly c: Internals;
  // the list changes only through edit(), which drops this; reads between edits cost no query
  private cache: HiddenRow[] | null = null;
  constructor(core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(SCHEMA);
  }

  /** GET /v1/hidden: every hidden mint with its reason, newest first. */
  list(): { hidden: HiddenRow[]; count: number } {
    // created on use too: a first call inside a transaction that rolled back would otherwise lose the table
    this.c.db.exec(SCHEMA);
    const rows = this.c.db.query<HiddenRow, []>("SELECT mint, agent, reason, added_at, added_by FROM hidden_mints ORDER BY added_at DESC, mint").all();
    return { hidden: rows, count: rows.length };
  }

  /**
   * POST /v1/admin/hidden { add?: [{ mint, agent?, reason }], remove?: [mint] }. Adding a mint that is
   * already listed replaces its reason. Applied in one transaction; the whole body is checked first.
   */
  edit(by: string, body: unknown) {
    try {
      return this.editInner(by, body);
    } finally {
      // dropped whether the edit committed or not, so the next read comes from the table
      this.cache = null;
    }
  }

  private rows(): HiddenRow[] {
    return (this.cache ??= this.list().hidden);
  }

  /**
   * Agents kept out of Core's public listings (leaderboard, highlights, feed, agents, activity,
   * sessions, trades): the agent whose launch minted a hidden token, and the agent an entry names.
   * Presentation only: no record, score, epoch or verdict reads this. Each agent maps to its entry.
   */
  agents(): Map<string, HiddenMark> {
    const rows = this.rows();
    const out = new Map<string, HiddenMark>();
    if (!rows.length) return out;
    const byMint = new Map(rows.map((r) => [r.mint, r]));
    for (const r of rows) if (r.agent) out.set(r.agent, { mint: r.mint, reason: r.reason, added_at: r.added_at });
    for (const a of this.c.db.query<{ agent_id: string; mint: string }, []>("SELECT agent_id, mint FROM agents WHERE mint IS NOT NULL").all()) {
      const r = byMint.get(a.mint);
      if (r) out.set(a.agent_id, { mint: r.mint, reason: r.reason, added_at: r.added_at });
    }
    return out;
  }

  /** Hidden mints (cached). */
  mints(): Set<string> {
    return new Set(this.rows().map((r) => r.mint));
  }

  /** The hidden entry for one agent, or null: per-agent detail routes still answer and carry this. */
  ofAgent(agent: string): HiddenMark | null {
    if (!this.rows().length) return null;
    return this.agents().get(agent) ?? null;
  }

  private editInner(by: string, body: unknown) {
    this.c.db.exec(SCHEMA);
    const b = (body ?? {}) as { add?: unknown; remove?: unknown };
    const add = b.add === undefined ? [] : b.add;
    const remove = b.remove === undefined ? [] : b.remove;
    if (!Array.isArray(add) || !Array.isArray(remove)) throw bad("bad_hidden", "add: [{ mint, agent?, reason }], remove: [mint]");
    if (!add.length && !remove.length) throw bad("bad_hidden", "nothing to add or remove");
    if (add.length + remove.length > MAX) throw bad("bad_hidden", `at most ${MAX} entries per call`);
    const adds = add.map((x, i) => {
      const r = x as { mint?: unknown; agent?: unknown; reason?: unknown };
      if (typeof r?.mint !== "string" || !B58.test(r.mint)) throw bad("bad_hidden", `add[${i}].mint: a base58 address`);
      if (r.agent !== undefined && r.agent !== null && (typeof r.agent !== "string" || !B58.test(r.agent))) throw bad("bad_hidden", `add[${i}].agent: a base58 address`);
      if (typeof r.reason !== "string" || !r.reason.trim() || r.reason.length > 200) throw bad("bad_hidden", `add[${i}].reason: 1 to 200 characters`);
      return { mint: r.mint, agent: (r.agent as string | undefined) ?? null, reason: r.reason.trim() };
    });
    for (const [i, m] of remove.entries()) if (typeof m !== "string" || !B58.test(m)) throw bad("bad_hidden", `remove[${i}]: a base58 address`);
    const now = this.c.now();
    const ins = this.c.db.query(`INSERT INTO hidden_mints (mint, agent, reason, added_at, added_by) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (mint) DO UPDATE SET agent = COALESCE(excluded.agent, hidden_mints.agent), reason = excluded.reason`);
    const del = this.c.db.query("DELETE FROM hidden_mints WHERE mint = ?");
    let removed = 0;
    // the route runs this inside core.tx, so the whole edit commits or none of it does
    for (const a of adds) ins.run(a.mint, a.agent, a.reason, now, by);
    for (const m of remove as string[]) removed += del.run(m).changes;
    const out = this.list();
    if (out.count > 5 * MAX) throw bad("bad_hidden", "the list is too long");
    this.c.emitEvent("hidden.updated", { added: adds.length, removed, count: out.count });
    return { ...out, added: adds.length, removed };
  }
}
