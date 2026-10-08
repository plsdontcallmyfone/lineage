import type { Core } from "./core.ts";
import { bad, notFound } from "./errors.ts";
import { splitByBps } from "./collab.ts";
import { sharesBps } from "./protocol.ts";

// Cross-lineage ports (SPEC 12.7, plan C7). One repository can have several lineages (another
// recipe, another architecture). A candidate whose change equals an accepted, live generation of a
// sibling lineage of the same repository (same patch_hash or semantic_hash) is a port: the original
// generation's authors are credited `port_share_bps` of the port's author units, in the proportion
// they were credited for the original. The porter may declare it (`ported_from: <gen_id>` at commit,
// any accepted live generation of a sibling lineage, also for an adapted change); undeclared ports
// are detected by Core at acceptance, when the credit is paid. Detection needs the original to have
// been committed before the port (the earlier commitment owns a change, SPEC 10.4), so an
// independent author who committed first is never treated as a porter.
//
// The per-lineage duplicate rules (SPEC 10.4, 11.2) are unchanged: a port is a new generation on its
// own lineage, never a duplicate there.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ports (
  commit_id TEXT PRIMARY KEY,           -- the porting candidate
  gen_id TEXT NOT NULL,                 -- the original generation (another lineage, same repo)
  source TEXT NOT NULL,                 -- declared | detected
  port_share_bps INTEGER,               -- set when credited
  credited TEXT,                        -- JSON [{ agent, units }] when credited
  at INTEGER NOT NULL
);
`;

interface Internals {
  db: Core["db"];
  cfg: Core["cfg"];
  now(): number;
  emitEvent(type: string, data: unknown): void;
}

interface CandLike {
  commit_id: string;
  candidate_id: string | null;
  lineage_id: string;
  committed_at: number;
  patch_hash: string | null;
  semantic_hash: string | null;
}

interface Row {
  commit_id: string;
  gen_id: string;
  source: string;
  port_share_bps: number | null;
  credited: string | null;
  at: number;
}

export class Ports {
  private readonly c: Internals;

  constructor(core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(SCHEMA);
  }

  private get db() {
    return this.c.db;
  }

  /** A live accepted patch generation of a lineage of `repo_id` other than `lineage_id`, or null. */
  private sibling(genId: string, lineageId: string): { gen_id: string; lineage_id: string } | null {
    return this.db
      .query<{ gen_id: string; lineage_id: string }, [string, string, string]>(
        `SELECT g.gen_id, g.lineage_id FROM generations g JOIN lineages o ON o.lineage_id = g.lineage_id JOIN lineages me ON me.lineage_id = ?
          WHERE g.gen_id = ? AND g.lineage_id != ? AND o.repo_id = me.repo_id AND g.entry_type = 'patch' AND g.reverted_by IS NULL`,
      )
      .get(lineageId, genId, lineageId);
  }

  /** Commit: a declared port (`ported_from`) must name a live accepted generation of a sibling lineage. */
  onCommit(commitId: string, lineageId: string, raw: unknown) {
    if (raw === undefined || raw === null) return;
    if (typeof raw !== "string") throw bad("bad_port", "ported_from is a generation id");
    if (!this.sibling(raw, lineageId)) throw notFound("ported_from generation (an accepted, live generation of another lineage of this repository)");
    this.db.query("INSERT INTO ports (commit_id, gen_id, source, at) VALUES (?, ?, 'declared', ?)").run(commitId, raw, this.c.now());
  }

  /** The original a candidate ports, declared or detected now (earliest accepted twin committed before it). */
  private originalOf(c: CandLike): { gen_id: string; source: "declared" | "detected" } | null {
    const declared = this.db.query<Row, [string]>("SELECT * FROM ports WHERE commit_id = ?").get(c.commit_id);
    if (declared) return this.sibling(declared.gen_id, c.lineage_id) ? { gen_id: declared.gen_id, source: declared.source as "declared" } : null;
    if (!c.patch_hash) return null;
    const g = this.db
      .query<{ gen_id: string }, [string, string, string, string, number, number, string]>(
        `SELECT g.gen_id FROM generations g
           JOIN lineages o ON o.lineage_id = g.lineage_id
           JOIN lineages me ON me.lineage_id = ?
           JOIN candidates oc ON oc.candidate_id = g.candidate_id
          WHERE g.lineage_id != ? AND o.repo_id = me.repo_id AND g.entry_type = 'patch' AND g.reverted_by IS NULL
            AND (g.patch_hash = ? OR g.semantic_hash = ?)
            AND (oc.committed_at < ? OR (oc.committed_at = ? AND oc.rowid < (SELECT rowid FROM candidates WHERE commit_id = ?)))
          ORDER BY g.accepted_at, g.gen_id LIMIT 1`,
      )
      .get(c.lineage_id, c.lineage_id, c.patch_hash, c.semantic_hash ?? "", c.committed_at, c.committed_at, c.commit_id);
    return g ? { gen_id: g.gen_id, source: "detected" } : null;
  }

  /**
   * At acceptance: the port credit out of `total` author units, as [agent, units] for the original's
   * authors (empty when this is not a port). The caller pays the rest to the candidate's own authors.
   */
  credit(c: CandLike, genId: string, total: number): [string, number][] {
    const o = this.originalOf(c);
    if (!o) return [];
    const bps = this.c.cfg.port_share_bps;
    const part = (total * bps) / 10_000;
    // the original's authors in the proportion they were credited for it (team shares, measured split, its own port credit)
    const credited = this.db
      .query<{ agent_id: string; u: number }, [string]>("SELECT agent_id, SUM(units) AS u FROM units WHERE ref = ? AND kind = 'author' AND voided = 0 GROUP BY agent_id ORDER BY MIN(id)")
      .all(o.gen_id);
    let parts: [string, number][];
    const w = sharesBps(credited.map((x) => x.u));
    if (w) parts = splitByBps(part, credited.map((x, i) => ({ agent: x.agent_id, share_bps: w[i]! })));
    else {
      const author = this.db.query<{ author: string }, [string]>("SELECT author FROM generations WHERE gen_id = ?").get(o.gen_id)!.author;
      parts = [[author, part]];
    }
    parts = parts.filter(([, u]) => u > 0);
    const rec = parts.map(([agent, units]) => ({ agent, units }));
    this.db
      .query("INSERT INTO ports (commit_id, gen_id, source, port_share_bps, credited, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(commit_id) DO UPDATE SET port_share_bps = excluded.port_share_bps, credited = excluded.credited")
      .run(c.commit_id, o.gen_id, o.source, bps, JSON.stringify(rec), this.c.now());
    this.c.emitEvent("port.credited", { gen_id: genId, ported_from: o.gen_id, source: o.source, port_share_bps: bps, credited: rec });
    return parts;
  }

  /** Public once the candidate is final (or to its parties): what it ports and who was credited. */
  view(c: { commit_id: string }, blind: boolean, terminal: boolean) {
    if (blind && !terminal) return null;
    const r = this.db.query<Row, [string]>("SELECT * FROM ports WHERE commit_id = ?").get(c.commit_id);
    if (!r) return null;
    const g = this.db.query<{ lineage_id: string; author: string }, [string]>("SELECT lineage_id, author FROM generations WHERE gen_id = ?").get(r.gen_id);
    return { ported_from: r.gen_id, lineage_id: g?.lineage_id ?? null, original_author: g?.author ?? null, source: r.source, port_share_bps: r.port_share_bps, credited: r.credited ? JSON.parse(r.credited) : null };
  }

  /** Ports of an original generation (for its generation view). */
  portsOf(genId: string) {
    return this.db
      .query<{ commit_id: string; gen_id: string | null }, [string]>("SELECT p.commit_id, c.gen_id FROM ports p JOIN candidates c ON c.commit_id = p.commit_id WHERE p.gen_id = ? AND c.status = 'accepted'")
      .all(genId);
  }
}
