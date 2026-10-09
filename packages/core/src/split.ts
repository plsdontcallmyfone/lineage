import type { Core } from "./core.ts";
import { bad, conflict, forbidden } from "./errors.ts";
import { ACC } from "./ledger.ts";
import { splitByBps, type Team } from "./collab.ts";
import {
  canonicalizeDiff,
  canonicalJson,
  costClass,
  extraTrees,
  guard,
  measuredSplit,
  patchHash,
  splitReportCommitment,
  subCommitment,
  subsetKey,
  subsetMasks,
  type Calibration,
  type Judgement,
  type Recipe,
  type SplitOutcome,
  type SplitReport,
} from "./protocol.ts";

// Measured split (SPEC 12.6, plan C5). Opt-in per team candidate: the team commits one sub-patch per
// member (in member order) under `sub_commitment`; at reveal the sub-patches are revealed and each
// must pass the guard alone; every replayer of the candidate (not audits) also measures every proper
// non-empty coalition of the sub-patches on the target's deterministic metric and commits that report
// next to its result. The verdict is computed from the results alone, exactly as without a split.
// At acceptance the counted replays' reports give the coalition gains, the protocol package computes
// exact Shapley values (packages/protocol/src/shapley.ts), and author units are divided by the
// measured shares; any missing, disagreeing or non-composing report falls back to declared shares.
//
// Cost: the team pays the rebate the extra trees earn (rebate_per_class x cost class x extra trees x
// quorum) from its author members' compute vaults at commit, into the reserve that pays rebates; it
// is refunded if the candidate ends before any replay revealed. Replayers whose counted replay carried
// a report earn u_replay x cost class x extra trees more units, plus that rebate.
//
// Tables live here (CREATE TABLE IF NOT EXISTS), outside store.ts migrations, like collab.ts.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS splits (
  commit_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,                  -- shapley
  n INTEGER NOT NULL,                  -- members = sub-patches
  metric TEXT NOT NULL,                -- the candidate's deterministic target metric
  sub_commitment TEXT NOT NULL,        -- subCommitment(sub patch hashes, salt)
  extra_trees INTEGER NOT NULL,
  fee_paid TEXT NOT NULL,              -- JSON [{ agent, amount, charged? }]: due at commit, debited when final
  refunded INTEGER NOT NULL DEFAULT 0,
  subs TEXT,                           -- JSON canonical sub-patches, once revealed
  sub_hashes TEXT,                     -- JSON patch hashes
  outcome TEXT,                        -- JSON SplitOutcome at acceptance
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS split_reports (
  replay_id TEXT PRIMARY KEY,
  commit_id TEXT NOT NULL,
  commitment TEXT NOT NULL,            -- splitReportCommitment(report, replay salt)
  report TEXT,                         -- canonical JSON once revealed
  status TEXT NOT NULL                 -- committed | revealed | mismatch | invalid
);
CREATE INDEX IF NOT EXISTS split_reports_commit ON split_reports(commit_id);
`;

const HEX64 = /^[0-9a-f]{64}$/;
const MAX_REPORT_BYTES = 2 * 1024 * 1024;

interface SplitRow {
  commit_id: string;
  mode: string;
  n: number;
  metric: string;
  sub_commitment: string;
  extra_trees: number;
  fee_paid: string;
  refunded: number;
  subs: string | null;
  sub_hashes: string | null;
  outcome: string | null;
  created_at: number;
}

interface CandLike {
  commit_id: string;
  candidate_id: string | null;
  lineage_id: string;
  author: string;
  kind: string;
  target: string;
  status: string;
}

/** The parts of Core this module uses. Core passes itself; the private members exist at runtime. */
interface Internals {
  db: Core["db"];
  cfg: Core["cfg"];
  ledger: Core["ledger"];
  chainMode: boolean;
  now(): number;
  emitEvent(type: string, data: unknown): void;
  recipeOf(id: string): Recipe;
  lineageRow(id: string): { lineage_id: string; recipe_id: string; calib_id: string } | null;
  effectiveCalibration(calib_id: string, gen: string): Calibration;
  agentRow(id: string): { agent_id: string; kind: string; reference: number } | null;
  addUnits(agent: string, kind: string, ref: string, units: number, rebate?: bigint): void;
  refreshAwake(agent: string): void;
  collab: Core["collab"];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export class Split {
  private readonly c: Internals;

  constructor(core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(SCHEMA);
  }

  private get db() {
    return this.c.db;
  }

  row(commitId: string): SplitRow | null {
    return this.db.query<SplitRow, [string]>("SELECT * FROM splits WHERE commit_id = ?").get(commitId);
  }

  /**
   * The split part of a team body, for the team statement every member signs (SPEC 12.6):
   * `team.split = { mode: "shapley", sub_commitment }`. Null when the team has no split.
   */
  parse(team: unknown): { mode: "shapley"; sub_commitment: string } | null {
    if (!isObj(team) || team.split === undefined || team.split === null) return null;
    const s = team.split;
    if (!isObj(s) || s.mode !== "shapley" || typeof s.sub_commitment !== "string" || !HEX64.test(s.sub_commitment))
      throw bad("bad_split", 'team.split is { mode: "shapley", sub_commitment: <64 hex> }');
    return { mode: "shapley", sub_commitment: s.sub_commitment };
  }

  /** At commit, after the team is stored: checks the split rules and debits the extra measurement cost. */
  onCommit(commitId: string, lead: string, team: Team | null, lineageId: string, kind: string, target: string | string[], rawTeam: unknown) {
    const spec = this.parse(rawTeam);
    if (!spec) return;
    if (!team) throw bad("bad_split", "a measured split needs a team");
    if (this.c.chainMode) throw conflict("split_offchain_only", "measured split fees are debited from Core-held compute vaults; chain mode does not support it yet (SPEC 12.6)");
    const n = team.members.length;
    if (n > this.c.cfg.max_split_members) throw bad("bad_split", `a measured split has at most max_split_members (${this.c.cfg.max_split_members}) members`);
    if (kind === "fix" || Array.isArray(target)) throw bad("bad_split", "a measured split needs a perf or slim target");
    const l = this.c.lineageRow(lineageId)!;
    const recipe = this.c.recipeOf(l.recipe_id);
    const m = recipe.metrics.find((x) => x.name === target);
    if (!m || !m.deterministic) throw bad("split_needs_deterministic", "a measured split is measured on a deterministic metric only (noisy coalitions would split noise)");
    const calib = this.c.effectiveCalibration(l.calib_id, (this.db.query<{ tip: string }, [string]>("SELECT tip FROM lineages WHERE lineage_id = ?").get(lineageId)!).tip);
    const cls = costClass(calib.median_eval_seconds);
    const trees = extraTrees(n);
    const fee = this.c.cfg.rebate_per_class * BigInt(cls) * BigInt(trees) * BigInt(this.c.cfg.quorum);
    // the author members pay, evenly, the lead taking the remainder; reviewers and harness members hold no compute vault
    const payers = team.members.filter((x) => x.role === "author").map((x) => x.agent);
    const each = fee / BigInt(payers.length);
    // Checked now, debited when the candidate is final (onFinal): compute balances are public, and a
    // debit at commit named the team's authors of an open candidate (10.7; audit A2, OFF-09).
    const paid: { agent: string; amount: string }[] = [];
    for (const p of payers) {
      const amt = p === lead ? fee - each * BigInt(payers.length - 1) : each;
      if (amt === 0n) continue;
      const bal = this.c.ledger.balance(ACC.compute(p));
      if (bal < amt) throw forbidden("insufficient_compute", `member ${p} cannot pay its part of the split's measurement cost (${amt}; compute vault holds ${bal})`);
      paid.push({ agent: p, amount: amt.toString() });
    }
    this.db
      .query("INSERT INTO splits (commit_id, mode, n, metric, sub_commitment, extra_trees, fee_paid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(commitId, spec.mode, n, m.name, spec.sub_commitment, trees, JSON.stringify(paid), this.c.now());
  }

  /**
   * At reveal, before anything is stored (a throw rolls the reveal back): the sub-patches match the
   * sub commitment under the candidate's salt, and each one alone passes the guard. That the
   * sub-patches compose to the candidate is checked by every replayer on the real tree (report
   * field `compose`); a failure there only drops the split, never the candidate.
   */
  onReveal(c: CandLike, body: Record<string, unknown>, salt: string) {
    const s = this.row(c.commit_id);
    if (!s) return;
    if (!Array.isArray(body.subs) || body.subs.length !== s.n || !body.subs.every((x) => typeof x === "string"))
      throw bad("bad_split", `reveal { patch, salt, subs: [${s.n} sub-patches in member order] }`);
    const recipe = this.c.recipeOf(this.c.lineageRow(c.lineage_id)!.recipe_id);
    const subs: string[] = [];
    for (const [i, raw] of (body.subs as string[]).entries()) {
      let canon: string;
      try {
        canon = canonicalizeDiff(raw);
      } catch {
        throw bad("bad_split", `sub-patch ${i} is not a parseable diff`);
      }
      const g = guard(canon, recipe.patch);
      if (!g.ok) throw bad("bad_split", `sub-patch ${i} fails the guard alone: ${g.violation}`);
      subs.push(canon);
    }
    const hashes = subs.map((x) => patchHash(x));
    if (subCommitment(hashes, salt) !== s.sub_commitment) throw bad("split_mismatch", "sub-patches and salt do not match the sub commitment");
    this.db.query("UPDATE splits SET subs = ?, sub_hashes = ? WHERE commit_id = ?").run(JSON.stringify(subs), JSON.stringify(hashes), c.commit_id);
  }

  /** What a replayer of the candidate (not an audit) gets: the sub-patches by index, never who wrote them. */
  assignment(c: CandLike, r: { audit_id: string | null }): { n: number; metric: string; subs: string[]; coalitions: string[] } | null {
    if (r.audit_id) return null;
    const s = this.row(c.commit_id);
    if (!s || !s.subs) return null;
    return { n: s.n, metric: s.metric, subs: JSON.parse(s.subs), coalitions: subsetMasks(s.n).map(subsetKey) };
  }

  onReplayCommit(r: { replay_id: string; candidate_id: string; audit_id: string | null }, body: unknown) {
    if (r.audit_id || !isObj(body) || body.split_commitment === undefined) return;
    const commitId = this.commitOf(r.candidate_id);
    if (!commitId || !this.row(commitId)) return;
    if (typeof body.split_commitment !== "string" || !HEX64.test(body.split_commitment)) throw bad("bad_commitment", "split_commitment must be 64 hex chars");
    this.db.query("INSERT OR REPLACE INTO split_reports (replay_id, commit_id, commitment, status) VALUES (?, ?, ?, 'committed')").run(r.replay_id, commitId, body.split_commitment);
  }

  /** Stores a revealed report that matches its commitment; a mismatch or bad shape only drops the report. */
  onReplayReveal(r: { replay_id: string }, body: Record<string, unknown>) {
    const row = this.db.query<{ commitment: string; commit_id: string }, [string]>("SELECT commitment, commit_id FROM split_reports WHERE replay_id = ?").get(r.replay_id);
    if (!row) return;
    const rep = body.split;
    let status = "revealed";
    let text: string | null = null;
    if (!isObj(rep)) status = "invalid";
    else {
      text = canonicalJson(rep);
      if (splitReportCommitment(rep, String(body.salt)) !== row.commitment) status = "mismatch";
      else if (text.length > MAX_REPORT_BYTES || !validReport(rep as unknown as SplitReport, this.row(row.commit_id)!.n)) status = "invalid";
    }
    this.db.query("UPDATE split_reports SET report = ?, status = ? WHERE replay_id = ?").run(text, status, r.replay_id);
  }

  /**
   * The counted replays whose split reports agree with each other on every coalition (the same check
   * the measured split applies). Only those earn the extra pay: a well-formed report with made-up
   * numbers used to earn it without measuring anything (audit A2, OFF-10). One dissenting report
   * voids the extra for every counted replay of the candidate, its own included, so lying gains nothing.
   */
  agreedReports(c: CandLike, j: Judgement, recipe: Recipe, calib: Calibration): Set<string> {
    const s = this.row(c.commit_id);
    if (!s || !j.counted.length) return new Set();
    const reports = j.counted.map((id) => {
      const x = this.db.query<{ report: string | null; status: string }, [string]>("SELECT report, status FROM split_reports WHERE replay_id = ?").get(id);
      return { replay_id: id, report: x && x.status === "revealed" && x.report ? (JSON.parse(x.report) as SplitReport) : null };
    });
    // the agreement check does not depend on the verdict's effect; a rejected candidate has none
    const effect = j.effect && "ratio" in j.effect ? j.effect : ({ ratio: 1 } as never);
    const o = measuredSplit({ recipe, calib, metric: s.metric, n: s.n, effect, reports, det_tolerance: this.c.cfg.det_tolerance });
    return new Set(o.used);
  }

  /** Extra pay for a counted replay that measured the coalitions (SPEC 12.6), when its report agreed. */
  onCounted(r: { replay_id: string; replayer: string }, calib: Calibration, agreed: Set<string>) {
    if (!agreed.has(r.replay_id)) return;
    const rep = this.db.query<{ commit_id: string; report: string }, [string]>("SELECT commit_id, report FROM split_reports WHERE replay_id = ? AND status = 'revealed'").get(r.replay_id);
    if (!rep) return;
    if ((JSON.parse(rep.report) as SplitReport).compose === "skipped") return;
    const a = this.c.agentRow(r.replayer);
    if (!a || a.reference) return;
    const s = this.row(rep.commit_id)!;
    const cls = costClass(calib.median_eval_seconds);
    this.c.addUnits(r.replayer, "replay", r.replay_id, this.c.cfg.u_replay * cls * s.extra_trees, this.c.cfg.rebate_per_class * BigInt(cls * s.extra_trees));
  }

  /**
   * Author units by measured shares at acceptance, or null (no split, or the split did not measure:
   * declared shares apply). Records the outcome either way.
   */
  authorShares(c: CandLike, j: Judgement, recipe: Recipe, calib: Calibration, total: number): [string, number][] | null {
    const s = this.row(c.commit_id);
    if (!s) return null;
    const reports = j.counted.map((id) => {
      const x = this.db.query<{ report: string | null; status: string }, [string]>("SELECT report, status FROM split_reports WHERE replay_id = ?").get(id);
      return { replay_id: id, report: x && x.status === "revealed" && x.report ? (JSON.parse(x.report) as SplitReport) : null };
    });
    const o: SplitOutcome = measuredSplit({ recipe, calib, metric: s.metric, n: s.n, effect: j.effect, reports, det_tolerance: this.c.cfg.det_tolerance });
    this.db.query("UPDATE splits SET outcome = ? WHERE commit_id = ?").run(JSON.stringify(o), c.commit_id);
    this.c.emitEvent("split.measured", { commit_id: c.commit_id, candidate_id: c.candidate_id, status: o.status, share_bps: o.share_bps });
    if (o.status !== "measured" || !o.share_bps) return null;
    const members = this.c.collab.members(c.commit_id);
    return splitByBps(total, members.map((m, i) => ({ agent: m.agent, share_bps: o.share_bps![i]! })));
  }

  /**
   * When the candidate ends: debits the fee set at commit, or nothing if no replay was ever revealed
   * (nobody measured anything). A member whose vault holds less by now pays what it holds.
   */
  onFinal(c: { commit_id: string; candidate_id: string | null }) {
    const s = this.row(c.commit_id);
    if (!s || s.refunded) return;
    const due = JSON.parse(s.fee_paid) as { agent: string; amount: string; charged?: boolean }[];
    if (due.some((x) => x.charged)) return;
    const revealed = c.candidate_id
      ? this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM replays WHERE candidate_id = ? AND audit_id IS NULL AND status IN ('revealed','invalid')").get(c.candidate_id)!.n
      : 0;
    if (revealed === 0) {
      this.db.query("UPDATE splits SET refunded = 1 WHERE commit_id = ?").run(c.commit_id);
      return;
    }
    const paid = due.map((p) => {
      const bal = this.c.ledger.balance(ACC.compute(p.agent));
      const amt = BigInt(p.amount) < bal ? BigInt(p.amount) : bal;
      if (amt > 0n) {
        this.c.ledger.transfer(ACC.compute(p.agent), ACC.reserve, amt, "split_fee", c.commit_id);
        this.c.refreshAwake(p.agent);
      }
      return { agent: p.agent, amount: amt.toString(), charged: true };
    });
    this.db.query("UPDATE splits SET fee_paid = ? WHERE commit_id = ?").run(JSON.stringify(paid), c.commit_id);
  }

  /** Public view: withheld while the candidate is blind to the viewer; reports only once final. */
  view(c: CandLike, blind: boolean, terminal: boolean) {
    const s = this.row(c.commit_id);
    if (!s || blind) return null;
    const reports = terminal
      ? this.db
          .query<{ replay_id: string; report: string | null; status: string }, [string]>("SELECT replay_id, report, status FROM split_reports WHERE commit_id = ? ORDER BY replay_id")
          .all(c.commit_id)
          .map((r) => ({ replay_id: r.replay_id, status: r.status, report: r.report ? JSON.parse(r.report) : null }))
      : [];
    return {
      mode: s.mode,
      n: s.n,
      metric: s.metric,
      sub_commitment: s.sub_commitment,
      sub_hashes: s.sub_hashes ? JSON.parse(s.sub_hashes) : null,
      subs: s.subs ? JSON.parse(s.subs) : null,
      extra_trees: s.extra_trees,
      fee_paid: JSON.parse(s.fee_paid),
      refunded: !!s.refunded,
      outcome: s.outcome ? JSON.parse(s.outcome) : null,
      reports,
    };
  }

  private commitOf(candidateId: string): string | null {
    return this.db.query<{ commit_id: string }, [string]>("SELECT commit_id FROM candidates WHERE candidate_id = ?").get(candidateId)?.commit_id ?? null;
  }
}

function validReport(r: SplitReport, n: number): boolean {
  if (r.v !== 1 || !["ok", "mismatch", "conflict", "skipped"].includes(r.compose) || typeof r.metric !== "string" || !isObj(r.subsets)) return false;
  const keys = new Set(subsetMasks(n).map(subsetKey));
  for (const [k, m] of Object.entries(r.subsets)) {
    if (!keys.has(k) || !isObj(m)) return false;
    if (!["ok", "conflict"].includes(m.apply) || !["ok", "fail", "skipped"].includes(m.build)) return false;
    if (!Array.isArray(m.cand_pass) || !m.cand_pass.every((t) => typeof t === "string")) return false;
    if (m.equivalence !== null && (!isObj(m.equivalence) || typeof m.equivalence.base_digest !== "string" || typeof m.equivalence.cand_digest !== "string")) return false;
    const nums = (xs: unknown) => Array.isArray(xs) && xs.length <= 1000 && xs.every((x) => typeof x === "number" && Number.isFinite(x));
    if (m.metric !== null && (!isObj(m.metric) || !nums(m.metric.base) || !nums(m.metric.cand))) return false;
  }
  return true;
}

