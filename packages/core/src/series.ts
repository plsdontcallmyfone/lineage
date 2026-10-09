import type { Core } from "./core.ts";
import { bad, conflict, forbidden, notFound } from "./errors.ts";
import { H, Rng } from "./protocol.ts";

// Stacked series (plan IDENTITY-AND-COLLABORATION 3.5, milestone C3; SPEC 12.4). A candidate B may
// declare `depends_on` a pending candidate A of the same lineage: B is computed against the tip plus
// A's patch (shared privately between the parties; Core never sees A's patch before A reveals), B
// commits now so its priority is fixed, may reveal only after A revealed, and is then held
// (`waiting`) until A is final. When A is final B is queued on the tip like any candidate:
//
//   A accepted (and not reverted) -> B is measured on the tip, which includes A (V1 and V4 unchanged);
//   A failed                      -> B is queued alone on the tip; if its patch does not apply there
//                                    the apply_conflict rejection is reported as `dependency_failed`.
//
// The verdict is never touched: a released B is an ordinary candidate whose eval parent is the tip.
// Everything here runs inside a Core transaction, reads time only from Core's clock and draws
// randomness from the epoch secret, like the rest of Core.
//
// Author-blind replay (SPEC 10.7) is preserved:
// - the link (`depends_on`, dependents) is shown only to the parties and the admin until both ends
//   are final: a public dependent would tell a replayer of A that A is real, never a canary;
// - `waiting` is not a tell either: canaries are held as `waiting` at the rate real candidates of the
//   lineage waited, for a duration drawn from real waits (shadow parity);
// - replayer exclusions cover the whole series: no party of any candidate in a series (nor its
//   operator or owner group) replays, disputes or audits another candidate of that series, and
//   replays a party already held on an earlier candidate are cancelled and redrawn when B commits.
//
// Credit is unchanged: each candidate's author units go to its own authors (its team shares), so a
// dependency's author earns from B only if it is a member of B with a share.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS series (
  commit_id TEXT PRIMARY KEY,
  depends_on TEXT,                      -- commit_id of the dependency; null: a canary held for shadow parity
  depth INTEGER NOT NULL,               -- open candidates in its chain at commit (<= max_series_depth)
  state TEXT NOT NULL,                  -- committed | waiting | released | failed
  outcome TEXT,                         -- on_tip | alone | dependency_failed
  waiting_since INTEGER,
  release_at INTEGER,                   -- held canaries: when the hold ends
  released_at INTEGER,
  released_onto TEXT                    -- the tip it was queued on
);
CREATE INDEX IF NOT EXISTS series_dep ON series(depends_on);
CREATE INDEX IF NOT EXISTS series_state ON series(state);
`;

const TERMINAL = new Set(["accepted", "rejected", "expired"]);
const HEX64 = /^[0-9a-f]{64}$/;

interface Cand {
  commit_id: string;
  candidate_id: string | null;
  lineage_id: string;
  parent_gen_id: string;
  eval_parent_gen_id: string;
  author: string;
  status: string;
  revealed_at: number | null;
  gen_id: string | null;
  is_canary: number;
  committed_at: number;
}

interface Row {
  commit_id: string;
  depends_on: string | null;
  depth: number;
  state: string;
  outcome: string | null;
  waiting_since: number | null;
  release_at: number | null;
  released_at: number | null;
  released_onto: string | null;
}

/** The parts of Core this module drives. Core passes itself; the private members exist at runtime. */
interface Internals {
  db: Core["db"];
  cfg: Core["cfg"];
  adminId: string;
  now(): number;
  currentEpoch(): { n: number; secret: string };
  emitEvent(type: string, data: unknown): void;
  candRow(id: string): Cand | null;
  finalizeCandidate(c: Cand, status: "accepted" | "rejected", reason: string | null, detail: string | null, verdict: null): void;
  fillWants(): void;
  collab: Core["collab"];
}

export interface Dependency {
  dep: Cand;
  depth: number;
}

export class Series {
  private readonly c: Internals;

  constructor(core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(SCHEMA);
  }

  private get db() {
    return this.c.db;
  }

  private row(commitId: string): Row | null {
    return this.db.query<Row, [string]>("SELECT * FROM series WHERE commit_id = ?").get(commitId);
  }

  private cand(commitId: string): Cand | null {
    return this.db.query<Cand, [string]>("SELECT * FROM candidates WHERE commit_id = ?").get(commitId);
  }

  // ---------------------------------------------------------------------------------------------
  // Commit

  /**
   * Validates `depends_on` of a commit body (before the candidate is inserted). Returns null when
   * the body has none. The dependency must be an open candidate of the same lineage (a final one
   * has nothing to wait for: commit on the tip instead), and the chain of open candidates under the
   * new one may hold at most `max_series_depth`.
   */
  parse(lineageId: string, raw: unknown): Dependency | null {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "string" || !HEX64.test(raw)) throw bad("bad_dependency", "depends_on is the commit_id (64 hex) of a pending candidate");
    const dep = this.cand(raw);
    if (!dep) throw notFound("dependency");
    if (dep.lineage_id !== lineageId) throw bad("bad_dependency", "depends_on must be a candidate of the same lineage");
    if (TERMINAL.has(dep.status)) throw conflict("dependency_final", `the dependency is already ${dep.status}; commit on the tip instead`);
    let depth = 1;
    for (let cur: Row | null = this.row(dep.commit_id); cur?.depends_on; cur = this.row(cur.depends_on)) {
      const up = this.cand(cur.depends_on);
      if (!up || TERMINAL.has(up.status)) break;
      depth++;
    }
    if (depth > this.c.cfg.max_series_depth) throw conflict("series_too_deep", `this candidate would sit on ${depth} open candidates; max_series_depth is ${this.c.cfg.max_series_depth}`);
    return { dep, depth };
  }

  /**
   * After the candidate row is inserted (same transaction, so a refusal rolls it back). A dependency
   * on another author's candidate needs that author's signature: it must be the committer or a team
   * member with role `author` (whose team signature binds `depends_on`), otherwise anyone could chain
   * onto anyone's candidate and ride its priority. Then the series row is stored and replays that a
   * party of the new candidate already holds on an open candidate of the series are cancelled and
   * redrawn (a party knows the shared patch and has a stake in its acceptance).
   */
  committed(commitId: string, author: string, d: Dependency, team: { members: { agent: string; role: string }[] } | null) {
    const depAuthors = new Set([d.dep.author, ...this.c.collab.members(d.dep.commit_id).filter((m) => m.role === "author").map((m) => m.agent)]);
    const mine = new Set([author, ...(team?.members.filter((m) => m.role === "author").map((m) => m.agent) ?? [])]);
    if (!depAuthors.has(author) && !mine.has(d.dep.author))
      throw forbidden("dependency_unsigned", "a candidate built on another author's candidate needs that author as a signing team member with role author (share_bps may be 0)");
    this.db.query("INSERT INTO series (commit_id, depends_on, depth, state) VALUES (?, ?, ?, 'committed')").run(commitId, d.dep.commit_id, d.depth);
    const self = this.cand(commitId)!;
    const group = this.c.collab.exclusionGroup(this.c.collab.parties(self));
    for (const rel of this.ancestors(self)) {
      if (!rel.candidate_id || TERMINAL.has(rel.status)) continue;
      const held = this.db
        .query<{ replay_id: string; replayer: string; operator: string | null }, [string]>(
          `SELECT r.replay_id, r.replayer, a.operator FROM replays r JOIN agents a ON a.agent_id = r.replayer
           WHERE r.candidate_id = ? AND r.audit_id IS NULL AND r.status IN ('assigned','committed','revealed')`,
        )
        .all(rel.candidate_id);
      let n = 0;
      for (const r of held) {
        if (!group.agents.has(r.replayer) && !(r.operator && group.ops.has(r.operator))) continue;
        this.db.query("UPDATE replays SET status = 'cancelled' WHERE replay_id = ?").run(r.replay_id);
        n++;
      }
      if (n) this.db.query("UPDATE candidates SET want_replays = want_replays + ? WHERE commit_id = ?").run(n, rel.commit_id);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Reveal

  /** Before a reveal is accepted: a stacked candidate reveals only after its dependency did (its diff context would leak the sealed patch). */
  beforeReveal(commitId: string) {
    const r = this.row(commitId);
    if (!r?.depends_on) return;
    const dep = this.cand(r.depends_on);
    if (!dep || dep.revealed_at === null)
      throw conflict("dependency_unrevealed", "the candidate this one depends on has not revealed; reveal after it does, so this diff cannot expose its sealed patch");
  }

  /**
   * At the point a revealed candidate would be queued. Returns true when it is held (`waiting`):
   * a stacked candidate whose dependency is not final, or a canary held for shadow parity. A stacked
   * candidate whose dependency is already final is routed onto the tip and queued now (false).
   */
  holdAtReveal(c: Cand): boolean {
    const r = this.row(c.commit_id);
    if (r?.depends_on) {
      const dep = this.cand(r.depends_on)!;
      if (TERMINAL.has(dep.status)) {
        this.route(c, dep);
        return false;
      }
      this.wait(c, null);
      return true;
    }
    if (c.is_canary) {
      const until = this.canaryHold(c);
      if (until !== null) {
        this.wait(c, until);
        return true;
      }
    }
    return false;
  }

  private wait(c: Cand, releaseAt: number | null) {
    const now = this.c.now();
    if (releaseAt !== null) this.db.query("INSERT OR REPLACE INTO series (commit_id, depends_on, depth, state) VALUES (?, NULL, 0, 'committed')").run(c.commit_id);
    this.db.query("UPDATE series SET state = 'waiting', waiting_since = ?, release_at = ? WHERE commit_id = ?").run(now, releaseAt, c.commit_id);
    this.db.query("UPDATE candidates SET status = 'waiting', want_replays = 0, want_reference = 0, detail = ? WHERE commit_id = ?").run("waiting: held until the candidate it builds on is final", c.commit_id);
    // the same event for a held canary and a real stacked candidate; neither names the dependency
    this.c.emitEvent("candidate.waiting", { candidate_id: c.candidate_id });
  }

  /**
   * Shadow parity (SPEC 10.7): with the fraction of the lineage's last 50 revealed real candidates
   * that waited, a canary waits too, for a duration drawn from real waits. Null: no hold.
   */
  private canaryHold(c: Cand): number | null {
    const real = this.db
      .query<{ commit_id: string }, [string]>("SELECT commit_id FROM candidates WHERE lineage_id = ? AND is_canary = 0 AND revealed_at IS NOT NULL ORDER BY committed_at DESC LIMIT 50")
      .all(c.lineage_id);
    if (!real.length) return null;
    const waited = real.filter((x) => this.db.query("SELECT 1 FROM series WHERE commit_id = ? AND depends_on IS NOT NULL AND waiting_since IS NOT NULL").get(x.commit_id)).length;
    const waits = this.db
      .query<{ w: number }, [string]>(
        `SELECT s.released_at - s.waiting_since AS w FROM series s JOIN candidates c ON c.commit_id = s.commit_id
         WHERE c.lineage_id = ? AND c.is_canary = 0 AND s.depends_on IS NOT NULL AND s.released_at IS NOT NULL AND s.waiting_since IS NOT NULL ORDER BY s.released_at DESC LIMIT 50`,
      )
      .all(c.lineage_id)
      .map((r) => r.w);
    const rng = new Rng(H("m1-series-canary", this.c.currentEpoch().secret, c.commit_id));
    if (!waits.length || rng.next() >= waited / real.length) return null;
    const ms = waits[rng.int(waits.length)]! * (0.9 + 0.2 * rng.next());
    return this.c.now() + Math.max(1000, Math.round(ms));
  }

  /** Points a stacked candidate whose dependency is final at the tip and records the outcome. */
  private route(c: Cand, dep: Cand) {
    const tip = this.db.query<{ tip: string }, [string]>("SELECT tip FROM lineages WHERE lineage_id = ?").get(c.lineage_id)!.tip;
    const live = dep.status === "accepted" && !!dep.gen_id && !this.db.query("SELECT 1 FROM generations WHERE gen_id = ? AND reverted_by IS NOT NULL").get(dep.gen_id);
    const outcome = live ? "on_tip" : "alone";
    // `detail` is public while the candidate is open, so it reads like a canary's release: naming the
    // dependency's generation linked this candidate to that generation's (public) author and told it
    // apart from a canary (audit A2, OFF-05). The outcome stays in the series record, public once both
    // ends are final (12.4).
    const detail = `released: measured on the tip ${tip}`;
    this.db.query("UPDATE candidates SET eval_parent_gen_id = ?, detail = ? WHERE commit_id = ?").run(tip, detail, c.commit_id);
    this.db.query("UPDATE series SET state = 'released', outcome = ?, released_at = ?, released_onto = ? WHERE commit_id = ?").run(outcome, this.c.now(), tip, c.commit_id);
  }

  // ---------------------------------------------------------------------------------------------
  // Scheduler

  /** Called from Core.tick(): releases held candidates, fails stacked candidates that can never reveal. */
  tick() {
    const now = this.c.now();
    let queued = false;
    for (const r of this.db.query<Row, []>("SELECT * FROM series WHERE state = 'waiting' ORDER BY waiting_since, commit_id").all()) {
      const c = this.cand(r.commit_id);
      if (!c || c.status !== "waiting") continue;
      if (r.depends_on) {
        const dep = this.cand(r.depends_on);
        if (dep && !TERMINAL.has(dep.status)) continue;
        if (dep) this.route(c, dep);
      } else {
        if (r.release_at === null || now < r.release_at) continue;
        const tip = this.db.query<{ tip: string }, [string]>("SELECT tip FROM lineages WHERE lineage_id = ?").get(c.lineage_id)!.tip;
        this.db.query("UPDATE candidates SET eval_parent_gen_id = ?, detail = ? WHERE commit_id = ?").run(tip, `released: measured on the tip ${tip}`, c.commit_id);
        this.db.query("UPDATE series SET state = 'released', outcome = 'on_tip', released_at = ?, released_onto = ? WHERE commit_id = ?").run(now, tip, c.commit_id);
      }
      this.db
        .query("UPDATE candidates SET status = 'queued', stage = 0, want_replays = ?, want_reference = 0, reassigns = 0, dispute_rounds = 0 WHERE commit_id = ?")
        .run(this.c.cfg.quorum, c.commit_id);
      this.c.emitEvent("candidate.released", { candidate_id: c.candidate_id });
      this.c.emitEvent("candidate.queued", { candidate_id: c.candidate_id, stage: 0 });
      queued = true;
    }
    // a stacked candidate still sealed whose dependency ended without revealing can never reveal
    for (const r of this.db.query<Row, []>("SELECT * FROM series WHERE state = 'committed' AND depends_on IS NOT NULL").all()) {
      const c = this.cand(r.commit_id);
      if (!c || TERMINAL.has(c.status)) {
        this.db.query("UPDATE series SET state = 'failed' WHERE commit_id = ?").run(r.commit_id);
        continue;
      }
      const dep = this.cand(r.depends_on!);
      if (c.status !== "committed" || !dep || !TERMINAL.has(dep.status) || dep.revealed_at !== null) continue;
      this.db.query("UPDATE series SET state = 'failed', outcome = 'dependency_failed' WHERE commit_id = ?").run(r.commit_id);
      this.c.finalizeCandidate(c, "rejected", "dependency_failed", `the candidate it depends on ended ${dep.status} without revealing`, null);
    }
    if (queued) this.c.fillWants();
  }

  /** Judge reasons of a candidate queued alone after its dependency failed: a patch that cannot apply without it failed with it. */
  rejectReason<R extends string>(c: { commit_id: string; stage: number }, reason: R): R | "dependency_failed" {
    if (reason !== "apply_conflict" || c.stage !== 0) return reason;
    return this.row(c.commit_id)?.outcome === "alone" ? "dependency_failed" : reason;
  }

  // ---------------------------------------------------------------------------------------------
  // Exclusions and views

  /** Earlier candidates a candidate builds on, nearest first. */
  ancestors(c: { commit_id: string }): Cand[] {
    const out: Cand[] = [];
    const seen = new Set([c.commit_id]);
    for (let r = this.row(c.commit_id); r?.depends_on && !seen.has(r.depends_on); r = this.row(r.depends_on)) {
      seen.add(r.depends_on);
      const x = this.cand(r.depends_on);
      if (!x) break;
      out.push(x);
    }
    return out;
  }

  /** Later candidates built on this one, directly or through others. */
  descendants(c: { commit_id: string }): Cand[] {
    const out: Cand[] = [];
    const seen = new Set([c.commit_id]);
    const queue = [c.commit_id];
    while (queue.length) {
      const id = queue.shift()!;
      for (const r of this.db.query<{ commit_id: string }, [string]>("SELECT commit_id FROM series WHERE depends_on = ? ORDER BY commit_id").all(id)) {
        if (seen.has(r.commit_id)) continue;
        seen.add(r.commit_id);
        const x = this.cand(r.commit_id);
        if (x) (out.push(x), queue.push(x.commit_id));
      }
    }
    return out;
  }

  /** Adds every party of every other candidate of the series (and their groups) to a draw's exclusions (V2). */
  extendExclusion(c: { commit_id: string }, exAgents: Set<string>, exOps: Set<string>) {
    for (const rel of [...this.ancestors(c), ...this.descendants(c)]) this.c.collab.extendExclusion(rel, exAgents, exOps);
  }

  /** The candidates a set of candidates' series relatives belong to (for the message firewall). */
  relatives(c: { commit_id: string }): Cand[] {
    return [...this.ancestors(c), ...this.descendants(c)];
  }

  /**
   * The series record of a candidate for its view, or null. Parties and the admin always see it;
   * everyone else once the candidate and its dependency are both final (a public link from an open
   * candidate would tell a replayer its dependency is real). A held canary shows nothing, like a
   * real candidate does publicly while open.
   */
  view(c: { commit_id: string; status: string; author: string }, viewer?: string | null) {
    const r = this.row(c.commit_id);
    const dependents = this.db.query<{ commit_id: string }, [string]>("SELECT commit_id FROM series WHERE depends_on = ? ORDER BY commit_id").all(c.commit_id).map((x) => x.commit_id);
    if (!r?.depends_on && !dependents.length) return null;
    const party = !!viewer && (viewer === this.c.adminId || this.c.collab.parties(c).includes(viewer));
    const final = (id: string) => TERMINAL.has(this.cand(id)?.status ?? "");
    const showDep = !!r?.depends_on && (party || (TERMINAL.has(c.status) && final(r.depends_on)));
    const shownDependents = dependents.filter((d) => party || (TERMINAL.has(c.status) && final(d)));
    if (!showDep && !shownDependents.length) return null;
    return {
      depends_on: showDep ? r!.depends_on : null,
      depth: showDep ? r!.depth : null,
      outcome: showDep ? r!.outcome : null,
      waiting_since: showDep ? r!.waiting_since : null,
      released_at: showDep ? r!.released_at : null,
      released_onto: showDep ? r!.released_onto : null,
      dependents: shownDependents,
    };
  }
}
