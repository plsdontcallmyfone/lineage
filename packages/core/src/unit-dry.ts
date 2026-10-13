import type { Core } from "./core.ts";
import { bad, notFound } from "./errors.ts";
import { learningsOf } from "./learnings.ts";

// Units that run dry (docs/plans/AGENT-EFFICIENCY.md section 8.1). A unit's easy gains get taken, and
// after that most attempts on it end with no improvement. Core says when that has happened, from its
// own records only (no model call): the last final attempts on the unit by any agent, the largest gain
// among them, the time since the last accepted change, and, where the unit's calibration records it,
// the share of each metric that is not the library's own work. The hosted runtime reads the signal to
// have an agent draft another unit on the repository (packages/runtime/src/more-units.ts), the worker
// reads it to rank a dry unit last (packages/worker/src/target-spread.ts), and the pages show its one
// sentence. A dry unit is never closed here: its accepted changes stay.
//
//   GET /v1/units/dry[?repo=]     every active unit
//   GET /v1/lineages/:id/dry      one unit

export interface DrySettings {
  /** final attempts looked at, newest first */
  window: number;
  /** fewer final attempts than this: the unit is fresh, never dry */
  min_attempts: number;
  /** rule 1: at least this part of the window ended without an improvement */
  fruitless_share: number;
  /** an accepted gain of at least this many percent inside the window keeps rules 1 and 3 off */
  small_gain_pct: number;
  /** rule 2: no accepted change for this long while min_attempts final attempts ended */
  quiet_hours: number;
  /** rule 3: every metric that records it has at least this part of its tip value outside the library */
  fixed_share: number;
}

export const DRY_DEFAULTS: DrySettings = { window: 12, min_attempts: 8, fruitless_share: 0.6, small_gain_pct: 3, quiet_hours: 24, fixed_share: 0.5 };

/** Network config `dry`: absent fields take the defaults; an unknown field or a value out of range is refused. */
export function parseDrySettings(raw: unknown, base: DrySettings = DRY_DEFAULTS): DrySettings {
  if (raw === undefined || raw === null) return { ...base };
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("dry settings: an object expected");
  const r = raw as Record<string, unknown>;
  const out = { ...base };
  const ranges: Record<keyof DrySettings, [number, number, boolean]> = {
    window: [1, 200, true],
    min_attempts: [1, 200, true],
    fruitless_share: [0, 1, false],
    small_gain_pct: [0, 100, false],
    quiet_hours: [0, 24 * 365, false],
    fixed_share: [0, 1, false],
  };
  for (const k of Object.keys(r)) {
    if (k.startsWith("_")) continue;
    if (!(k in ranges)) throw new Error(`dry settings: unknown field ${k}`);
    const [lo, hi, whole] = ranges[k as keyof DrySettings];
    const v = r[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi || (whole && !Number.isInteger(v))) throw new Error(`dry settings: ${k} must be ${whole ? "a whole number" : "a number"} from ${lo} to ${hi}`);
    out[k as keyof DrySettings] = v;
  }
  if (out.min_attempts > out.window) throw new Error("dry settings: min_attempts above window");
  return out;
}

/** One final attempt on a unit (a published episode). */
export interface DryAttempt {
  /** accepted | rejected | expired | no_candidate */
  outcome: string;
  /** the rejection's reason, else null */
  reason: string | null;
  /** an accepted metric change's gain in percent, else null */
  gain_pct: number | null;
  /** when the attempt ended (ms) */
  at: number;
}

export interface DryFixed {
  /** instructions (or the metric's unit) of the run stopped before the first library call, at calibration */
  fixed_value: number;
  /** the calibrated value times the accepted ratios on the metric: an upper bound of the tip's value */
  tip_value: number;
  /** fixed_value / tip_value, at most 1: a lower bound of the share that is not the library */
  share: number;
}

export interface DryFacts {
  /** final attempts in the window */
  attempts: number;
  no_candidate: number;
  no_improvement: number;
  accepted: number;
  /** rejected for another reason (order, a wrong change) or expired: in the window, counted as neither */
  other: number;
  fruitless: number;
  fruitless_share: number | null;
  best_gain_pct: number | null;
  last_accepted_at: number | null;
  /** hours since the last accepted change, or since the unit was created */
  quiet_hours: number;
  /** final attempts that ended in that time */
  attempts_since_accepted: number;
  /** per metric, where the calibration records fixed_value */
  fixed: Record<string, DryFixed>;
}

export type DryRule = "fruitless" | "quiet" | "fixed";

export interface DryVerdict {
  dry: boolean;
  /** fewer than min_attempts final attempts: nothing can be said yet */
  fresh: boolean;
  rule: DryRule | null;
  /** one plain sentence for the unit's page when it is dry, else null */
  line: string | null;
  facts: DryFacts;
}

export interface DryInput {
  /** every final model attempt on the unit that the caller has, newest first (at least `window` of them when that many exist) */
  attempts: DryAttempt[];
  created_at: number;
  last_accepted_at: number | null;
  fixed: Record<string, DryFixed>;
  now: number;
}

const pct = (x: number) => (Math.round(x * 10) / 10).toFixed(1);

/** Pure: the rule of section 8.1. */
export function dryVerdict(i: DryInput, s: DrySettings = DRY_DEFAULTS): DryVerdict {
  const win = i.attempts.slice(0, s.window);
  const n = win.length;
  const no_candidate = win.filter((a) => a.outcome === "no_candidate").length;
  const no_improvement = win.filter((a) => a.outcome === "rejected" && a.reason === "no_improvement").length;
  const accepted = win.filter((a) => a.outcome === "accepted").length;
  const fruitless = no_candidate + no_improvement;
  const gains = win.filter((a) => a.outcome === "accepted" && typeof a.gain_pct === "number" && Number.isFinite(a.gain_pct)).map((a) => a.gain_pct as number);
  const best = gains.length ? Math.max(...gains) : null;
  const since = i.last_accepted_at ?? i.created_at;
  const sinceCount = i.attempts.filter((a) => a.at > since).length;
  const quiet = Math.max(0, (i.now - since) / 3_600_000);
  const facts: DryFacts = {
    attempts: n,
    no_candidate,
    no_improvement,
    accepted,
    other: n - fruitless - accepted,
    fruitless,
    fruitless_share: n ? fruitless / n : null,
    best_gain_pct: best,
    last_accepted_at: i.last_accepted_at,
    quiet_hours: quiet,
    attempts_since_accepted: sinceCount,
    fixed: i.fixed,
  };
  if (n < s.min_attempts) return { dry: false, fresh: true, rule: null, line: null, facts };
  // an accepted change that fixed tests has no gain figure; it is still a find
  const found = win.some((a) => a.outcome === "accepted" && a.gain_pct === null);
  const small = !found && (best === null || best < s.small_gain_pct);
  const shares = Object.values(i.fixed).map((f) => f.share);
  let rule: DryRule | null = null;
  let line: string | null = null;
  if (small && fruitless / n >= s.fruitless_share) {
    rule = "fruitless";
    line = `Most recent attempts found nothing more to improve here: ${fruitless} of the last ${n} ended without an improvement${best === null ? "" : `, and the largest accepted gain among them was ${pct(best)}%`}.`;
  } else if (sinceCount >= s.min_attempts && quiet >= s.quiet_hours) {
    rule = "quiet";
    line = `No change has been accepted here for ${Math.floor(quiet)} hours, over ${sinceCount} attempts.`;
  } else if (small && shares.length > 0 && shares.every((x) => x >= s.fixed_share)) {
    rule = "fixed";
    line = `What is left to measure here is mostly not the library's own work: at least ${pct(100 * Math.min(...shares))}% of every metric that records it.`;
  }
  return { dry: rule !== null, fresh: false, rule, line, facts };
}

interface Internals {
  db: Core["db"];
  cfg: Core["cfg"];
  now(): number;
}

interface UnitRow {
  lineage_id: string;
  recipe_id: string;
  calib_id: string;
  created_at: number;
  height: number;
  status: string;
  repo: string;
}

const instances = new WeakMap<Core, UnitDry>();
/** The one UnitDry of a Core (created on first use). */
export function unitDryOf(core: Core): UnitDry {
  let d = instances.get(core);
  if (!d) instances.set(core, (d = new UnitDry(core)));
  return d;
}

export class UnitDry {
  private readonly c: Internals;
  private cache = new Map<string, { at: number; v: ReturnType<UnitDry["build"]> }>();

  constructor(private readonly core: Core) {
    this.c = core as unknown as Internals;
  }

  settings(): DrySettings {
    return (this.c.cfg as unknown as { dry?: DrySettings }).dry ?? DRY_DEFAULTS;
  }

  private row(id: string): UnitRow | null {
    return this.c.db
      .query<UnitRow, [string]>("SELECT l.lineage_id, l.recipe_id, l.calib_id, l.created_at, l.height, l.status, r.url AS repo FROM lineages l JOIN repos r ON r.repo_id = l.repo_id WHERE l.lineage_id = ?")
      .get(id);
  }

  private build(u: UnitRow) {
    const s = this.settings();
    const db = this.c.db;
    // final attempts: published episodes of sessions that called a model (a scripted author never does)
    const attempts = db
      .query<{ outcome: string; reason: string | null; gain: number | null; ended_at: number | null; last_at: number }, [string, number]>(
        `SELECT e.outcome, json_extract(e.json, '$.candidate.reason') AS reason, json_extract(e.json, '$.effect.gain_pct') AS gain, s.ended_at, s.last_at
         FROM learnings_episodes e JOIN sessions s ON s.session_id = e.session_id
         WHERE e.lineage_id = ? AND s.proposer != 'scripted' AND e.outcome != 'abandoned' ORDER BY e.seq DESC LIMIT ?`,
      )
      .all(u.lineage_id, Math.max(200, s.window))
      .map((r): DryAttempt => ({ outcome: r.outcome, reason: r.reason, gain_pct: typeof r.gain === "number" ? r.gain : null, at: r.ended_at ?? r.last_at }))
      .sort((a, b) => b.at - a.at);
    const gens = db
      .query<{ effect: string | null; accepted_at: number }, [string]>("SELECT effect, accepted_at FROM generations WHERE lineage_id = ? AND entry_type = 'patch' AND reverted_by IS NULL ORDER BY height")
      .all(u.lineage_id);
    const last = gens.length ? Math.max(...gens.map((g) => g.accepted_at)) : null;
    const recipe = JSON.parse(db.query<{ json: string }, [string]>("SELECT json FROM recipes WHERE recipe_id = ?").get(u.recipe_id)!.json) as { name: string; metrics: { name: string; kind: string }[]; patch: { allowed_paths: string[] } };
    const cal = JSON.parse(db.query<{ json: string }, [string]>("SELECT json FROM calibrations WHERE calib_id = ?").get(u.calib_id)!.json) as { metrics: Record<string, { enabled: boolean; base_value?: number; fixed_value?: number }> };
    const ratio = new Map<string, number>();
    for (const g of gens) {
      const e = g.effect ? (JSON.parse(g.effect) as { metric?: unknown; ratio?: unknown }) : null;
      if (e && typeof e.metric === "string" && typeof e.ratio === "number" && e.ratio > 0) ratio.set(e.metric, (ratio.get(e.metric) ?? 1) * e.ratio);
    }
    const fixed: Record<string, DryFixed> = {};
    for (const [name, m] of Object.entries(cal.metrics ?? {})) {
      if (!m.enabled || typeof m.fixed_value !== "number" || typeof m.base_value !== "number" || !(m.base_value > 0)) continue;
      const tip = m.base_value * (ratio.get(name) ?? 1);
      fixed[name] = { fixed_value: m.fixed_value, tip_value: tip, share: Math.min(1, m.fixed_value / tip) };
    }
    const v = dryVerdict({ attempts, created_at: u.created_at, last_accepted_at: last, fixed, now: this.c.now() }, s);
    return {
      unit: u.lineage_id,
      lineage_id: u.lineage_id,
      recipe_name: recipe.name,
      repo: u.repo,
      status: u.status,
      created_at: u.created_at,
      height: u.height,
      targets: recipe.metrics.filter((m) => cal.metrics?.[m.name]?.enabled).map((m) => ({ kind: m.kind, name: m.name })),
      allowed_paths: recipe.patch.allowed_paths,
      ...v,
    };
  }

  private read(u: UnitRow) {
    const now = this.c.now();
    const hit = this.cache.get(u.lineage_id);
    if (hit && now >= hit.at && now - hit.at < 20_000) return hit.v;
    const v = this.build(u);
    this.cache.set(u.lineage_id, { at: now, v });
    return v;
  }

  /** GET /v1/lineages/:id/dry */
  one(id: string) {
    const u = this.row(id);
    if (!u) throw notFound("lineage");
    learningsOf(this.core).sweep();
    return { settings: this.settings(), ...this.read(u) };
  }

  /** GET /v1/units/dry[?repo=]: every active unit, oldest first. */
  list(q: { repo?: string } = {}) {
    if (q.repo !== undefined && (q.repo.length > 300 || !/^[\w.:/-]+$/.test(q.repo))) throw bad("bad_query", "repo is a repository address");
    // episodes are published on reads; this one counts too, so the signal does not wait for another reader
    learningsOf(this.core).sweep();
    const rows = this.c.db
      .query<UnitRow, []>("SELECT l.lineage_id, l.recipe_id, l.calib_id, l.created_at, l.height, l.status, r.url AS repo FROM lineages l JOIN repos r ON r.repo_id = l.repo_id WHERE l.status = 'active' ORDER BY l.created_at, l.lineage_id")
      .all()
      .filter((u) => q.repo === undefined || u.repo === q.repo);
    return { settings: this.settings(), units: rows.map((u) => this.read(u)) };
  }
}
