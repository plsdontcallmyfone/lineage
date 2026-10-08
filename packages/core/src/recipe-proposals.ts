import type { Core } from "./core.ts";
import { bad, conflict, forbidden, notFound } from "./errors.ts";
import { H, assignmentSeed, assignReplayers, canonicalJson, median, recipeId, relDiff, satisfies, type Calibration, type Capabilities, type Eligible, type Recipe } from "./protocol.ts";

// Agent-proposed recipes (SPEC 6.2). Any registered agent may propose a recipe for a new target
// repository: the recipe (its loaded form, overlay digest included) plus its overlay files as blobs.
// It becomes a lineage only after calibration replays agree: Core draws `calib_replayers` verifiers
// qualified for the recipe's class (a passed qualification on an active lineage of the same class
// and arch, capabilities that satisfy the recipe), excluding the proposer and its operator; each
// prepares the dependency layer and calibrates the snapshot with one shared seed, commits, then
// reveals. When every reveal agrees on the deterministic fields (stable set, known failures,
// dependency digest, which metrics are enabled, deterministic base values within det_tolerance),
// Core adds the recipe and snapshot and creates the lineage from the merged calibration.
//
//   POST /v1/recipe-proposals                       { recipe, overlay: { path: sha256 }, note }
//   GET  /v1/recipe-proposals[?status=]             list
//   GET  /v1/recipe-proposals/:id                   one (replay results once decided)
//   GET  /v1/recipe-proposals/assignments           a drawn verifier's calibration assignments
//   POST /v1/recipe-proposals/replays/:id/commit    { commitment = H("calib-result", canonical({ calibration, deps_digest }), salt) }
//   POST /v1/recipe-proposals/replays/:id/reveal    { calibration, deps_digest, salt }

interface AgentRowLike {
  agent_id: string;
  operator: string | null;
  capabilities: string | null;
}

interface Internals {
  db: Core["db"];
  cfg: Core["cfg"];
  blobs: Core["blobs"];
  now(): number;
  tx<T>(fn: () => T): T;
  emitEvent(type: string, data: unknown): void;
  agentRow(id: string): AgentRowLike | null;
  isEligible(a: AgentRowLike, epoch: number, ignoreLoad?: boolean): boolean;
  bondOf(id: string): bigint;
  currentEpoch(): { n: number };
  beacon(subject: string, round: number): { beacon: string };
  addRecipe(body: unknown): { recipe_id: string; created: boolean };
  addSnapshot(body: unknown): { snapshot_id: string };
  submitCalibration(agent: string, body: unknown, consensus?: boolean): { lineage_id: string; calib_id: string; gen0: string };
}

export const RECIPE_PROPOSALS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS recipe_proposals (
    proposal_id TEXT PRIMARY KEY,        -- H("recipe-proposal", proposer, recipe_id)
    proposer TEXT NOT NULL,
    name TEXT NOT NULL,
    recipe_id TEXT NOT NULL,
    class TEXT NOT NULL,
    arch TEXT NOT NULL,
    repo TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    recipe TEXT NOT NULL,                -- canonical JSON (loaded form)
    overlay TEXT NOT NULL,               -- canonical JSON { path: sha256 } (blobs)
    note TEXT,
    status TEXT NOT NULL,                -- waiting | calibrating | accepted | rejected
    round INTEGER NOT NULL DEFAULT 0,
    seed TEXT,                           -- shared calibration seed of the current round
    runs INTEGER NOT NULL,
    reason TEXT,
    lineage_id TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS calib_replays (
    replay_id TEXT PRIMARY KEY,
    proposal_id TEXT NOT NULL,
    round INTEGER NOT NULL,
    replayer TEXT NOT NULL,
    seed TEXT NOT NULL,
    assignment_seed TEXT NOT NULL,
    pool TEXT NOT NULL,
    status TEXT NOT NULL,                -- assigned | committed | revealed | expired | cancelled
    commitment TEXT,
    result TEXT,                         -- JSON { calibration, deps_digest }
    deadline INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    revealed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS calib_replays_replayer ON calib_replays(replayer, status);
`;

export const calibCommitment = (r: { calibration: Calibration; deps_digest: string }, salt: string): string =>
  H("calib-result", canonicalJson({ calibration: r.calibration, deps_digest: r.deps_digest }), salt);

/** The overlay digest the sandbox computes (packages/sandbox recipe.ts overlayDigest) from { path: sha256 }. */
export function overlayDigestOf(overlay: Record<string, string>): string {
  const entries = Object.keys(overlay)
    .sort()
    .map((p) => [p, overlay[p]!]);
  return H("overlay", JSON.stringify(entries));
}

const CLASSES = new Set(["rust", "solana", "zig", "cuda", "python", "go", "cpp"]);
const DEFAULTS = { calib_replayers: 2, calib_runs: 3, calib_window_s: 3600, max_open_per_agent: 2 };
const LIMIT_CAPS = { cpus: 4, memory_mb: 8192, pids: 1024, wall_s: 3600, disk_mb: 8192 };
const MAX_OVERLAY_FILES = 32;
const MAX_OVERLAY_BYTES = 1024 * 1024;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const sortedEq = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

interface PropRow {
  proposal_id: string;
  proposer: string;
  name: string;
  recipe_id: string;
  class: string;
  arch: string;
  repo: string;
  commit_sha: string;
  recipe: string;
  overlay: string;
  note: string | null;
  status: string;
  round: number;
  seed: string | null;
  runs: number;
  reason: string | null;
  lineage_id: string | null;
  created_at: number;
  decided_at: number | null;
}
interface CReplayRow {
  replay_id: string;
  proposal_id: string;
  round: number;
  replayer: string;
  seed: string;
  assignment_seed: string;
  pool: string;
  status: string;
  commitment: string | null;
  result: string | null;
  deadline: number;
  created_at: number;
  revealed_at: number | null;
}
interface Revealed {
  replayer: string;
  calibration: Calibration;
  deps_digest: string;
}

/** Structural checks a proposal must pass before any verifier spends compute on it. Throws ApiError. */
export function checkProposedRecipe(r: Recipe): void {
  const need = (cond: unknown, msg: string) => {
    if (!cond) throw bad("bad_recipe", msg);
  };
  need(isObj(r), "recipe object expected");
  need(typeof r.name === "string" && /^[a-z0-9][a-z0-9-]{1,63}$/.test(r.name), "name must be lowercase kebab, 2 to 64 chars");
  need(typeof r.repo === "string" && /^https:\/\/(github\.com|gitlab\.com|codeberg\.org)\/[\w.-]+\/[\w.-]+$/.test(r.repo), "repo must be a public https repository URL (github, gitlab or codeberg)");
  need(typeof r.commit === "string" && /^[0-9a-f]{40}$/.test(r.commit), "commit must be a full 40-hex sha");
  need(CLASSES.has(r.class), `class must be one of ${[...CLASSES].join(", ")}`);
  need(isObj(r.requires) && (r.requires.arch === "amd64" || r.requires.arch === "arm64"), "requires.arch must be amd64 or arm64");
  need(typeof r.image === "string" && /@sha256:[0-9a-f]{64}$/.test(r.image), "image must be pinned as name@sha256:<id>");
  need(r.workdir === "/work/src", "workdir must be /work/src");
  need(strArr(r.prepare), "prepare must be a list of commands");
  need(isObj(r.build) && strArr(r.build.commands) && r.build.commands.length > 0, "build.commands required");
  need(isObj(r.test) && typeof r.test.command === "string" && ["libtest", "junit", "tap"].includes(r.test.parser), "test.command and test.parser (libtest | junit | tap) required");
  need(Array.isArray(r.metrics) && r.metrics.length > 0 && r.metrics.length <= 8, "1 to 8 metrics");
  need(
    r.metrics.some((m) => m.deterministic),
    "at least one deterministic metric (SPEC 9.1)",
  );
  const names = new Set<string>();
  for (const m of r.metrics) {
    need(isObj(m) && /^[a-z0-9_]+$/.test(m.name) && !names.has(m.name), `metric name ${m?.name}`);
    names.add(m.name);
    need(m.kind === "perf" || m.kind === "slim", `metric ${m.name}: kind`);
    need(m.direction === "lower" || m.direction === "higher", `metric ${m.name}: direction`);
    need(typeof m.min_effect === "number" && m.min_effect > 0 && m.min_effect < 1, `metric ${m.name}: min_effect in (0,1)`);
    need(typeof m.command === "string" && typeof m.parser === "string", `metric ${m.name}: command and parser`);
    if (!m.deterministic) need((m.rounds ?? 0) >= 5, `metric ${m.name}: noisy metrics need rounds >= 5`);
  }
  const p = r.patch;
  need(isObj(p) && strArr(p.allowed_paths) && p.allowed_paths.length > 0 && strArr(p.protected_paths), "patch.allowed_paths and protected_paths required");
  need(p.max_files > 0 && p.max_files <= 20 && p.max_lines > 0 && p.max_lines <= 1000, "patch bounds (max_files 1..20, max_lines 1..1000)");
  const l = r.limits;
  need(isObj(l), "limits required");
  for (const k of Object.keys(LIMIT_CAPS) as (keyof typeof LIMIT_CAPS)[])
    need(typeof l[k] === "number" && l[k] > 0 && l[k] <= LIMIT_CAPS[k], `limits.${k} must be in (0, ${LIMIT_CAPS[k]}]`);
}

/**
 * Pure: do these calibration replays agree (SPEC 6.2)? Returns the merged calibration or the first
 * disagreement. Noisy metrics may differ in whether they resolve their effect; a split disables them.
 */
export function mergeCalibrations(recipe: Recipe, recipe_id: string, seed: string, reveals: Revealed[], tol: number): { ok: true; calibration: Calibration; deps_digest: string } | { ok: false; reason: string } {
  if (!reveals.length) return { ok: false, reason: "no calibration replays" };
  const first = reveals[0]!;
  for (const r of reveals) {
    if (r.calibration.recipe_id !== recipe_id) return { ok: false, reason: `${r.replayer.slice(0, 8)} calibrated recipe ${r.calibration.recipe_id.slice(0, 12)}` };
    if (r.calibration.seed !== seed) return { ok: false, reason: `${r.replayer.slice(0, 8)} used another seed` };
    if (r.deps_digest !== first.deps_digest) return { ok: false, reason: "dependency layer digests differ (prepare is not reproducible)" };
    if (!sortedEq(r.calibration.stable, first.calibration.stable)) return { ok: false, reason: "stable test sets differ" };
    if (!sortedEq(r.calibration.known_failures, first.calibration.known_failures)) return { ok: false, reason: "known failures differ" };
  }
  if (first.calibration.stable.length === 0) return { ok: false, reason: "empty stable set" };
  const metrics: Calibration["metrics"] = {};
  for (const m of recipe.metrics) {
    const vals = reveals.map((r) => r.calibration.metrics[m.name]);
    if (vals.some((v) => !isObj(v))) return { ok: false, reason: `metric ${m.name} missing from a calibration` };
    if (m.deterministic) {
      const enabled = vals.map((v) => !!v!.enabled);
      if (enabled.some((e) => e !== enabled[0])) return { ok: false, reason: `replays disagree on whether ${m.name} is deterministic` };
      if (!enabled[0]) {
        metrics[m.name] = { enabled: false, cv: Math.max(...vals.map((v) => v!.cv)), reason: vals[0]!.reason ?? "disabled by every calibration replay" };
        continue;
      }
      const bases = vals.map((v) => v!.base_value);
      if (bases.some((b) => typeof b !== "number")) return { ok: false, reason: `metric ${m.name} has no base value` };
      for (const b of bases) if (relDiff(b!, bases[0]!) > tol) return { ok: false, reason: `metric ${m.name} base values differ beyond ${tol}` };
      metrics[m.name] = { enabled: true, cv: Math.max(...vals.map((v) => v!.cv)), base_value: median(bases as number[]) };
    } else {
      const all = vals.every((v) => v!.enabled);
      const bases = vals.map((v) => v!.base_value).filter((b): b is number => typeof b === "number");
      metrics[m.name] = all
        ? { enabled: true, cv: Math.max(...vals.map((v) => v!.cv)), ...(bases.length ? { base_value: median(bases) } : {}) }
        : { enabled: false, cv: Math.max(...vals.map((v) => v!.cv)), reason: "calibration replays split on whether the noise resolves min_effect" };
    }
  }
  const quarantined = [...new Set(reveals.flatMap((r) => r.calibration.quarantined))].sort();
  return {
    ok: true,
    deps_digest: first.deps_digest,
    calibration: {
      recipe_id,
      snapshot_id: "",
      runs: reveals.reduce((a, r) => a + r.calibration.runs, 0),
      stable: [...first.calibration.stable].sort(),
      known_failures: [...first.calibration.known_failures].sort(),
      quarantined,
      metrics,
      median_eval_seconds: Math.max(1, Math.round(median(reveals.map((r) => r.calibration.median_eval_seconds)))),
      seed,
    },
  };
}

const instances = new WeakMap<Core, RecipeProposals>();
/** The one RecipeProposals of a Core (created on first use, schema included). */
export function recipeProposalsOf(core: Core): RecipeProposals {
  let p = instances.get(core);
  if (!p) instances.set(core, (p = new RecipeProposals(core)));
  return p;
}

export class RecipeProposals {
  private c: Internals;

  constructor(core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(RECIPE_PROPOSALS_SCHEMA);
  }

  private param<K extends keyof typeof DEFAULTS>(k: K): number {
    const v = (this.c.cfg as unknown as Record<string, unknown>)[k];
    return typeof v === "number" && v > 0 ? v : DEFAULTS[k];
  }

  /** Images vetted for a class: those of recipes with an active lineage of that class and arch. */
  private vettedImages(cls: string, arch: string): Set<string> {
    const out = new Set<string>();
    for (const r of this.c.db.query<{ json: string }, []>("SELECT r.json FROM recipes r JOIN lineages l ON l.recipe_id = r.recipe_id WHERE l.status = 'active'").all()) {
      const rec = JSON.parse(r.json) as Recipe;
      if (rec.class === cls && rec.requires?.arch === arch) out.add(rec.image);
    }
    return out;
  }

  submit(agent: string, body: unknown) {
    return this.c.tx(() => {
      if (!this.c.agentRow(agent)) throw forbidden("not_registered", `agent ${agent} is not registered`);
      if (!isObj(body) || !isObj(body.recipe) || !isObj(body.overlay)) throw bad("bad_body", "{ recipe, overlay: { path: sha256 }, note? } expected");
      const recipe = body.recipe as unknown as Recipe;
      checkProposedRecipe(recipe);
      const overlay: Record<string, string> = {};
      const paths = Object.keys(body.overlay).sort();
      if (paths.length > MAX_OVERLAY_FILES) throw bad("bad_overlay", `at most ${MAX_OVERLAY_FILES} overlay files`);
      let bytes = 0;
      for (const p of paths) {
        const sha = String((body.overlay as Record<string, unknown>)[p]);
        if (!/^[\w.-][\w./-]*$/.test(p) || p.split("/").some((s) => s === ".." || s === "." || s === "" || s === ".git")) throw bad("bad_overlay", `overlay path ${p}`);
        if (!/^[0-9a-f]{64}$/.test(sha) || !this.c.blobs.has(sha)) throw bad("missing_blob", `upload overlay file ${p} as a blob first`);
        bytes += this.c.blobs.size(sha) ?? 0;
        overlay[p] = sha;
      }
      if (bytes > MAX_OVERLAY_BYTES) throw bad("bad_overlay", `overlay exceeds ${MAX_OVERLAY_BYTES} bytes`);
      // the recipe must carry the digest of exactly these files, and protect every one (SPEC 6)
      const want = paths.length ? overlayDigestOf(overlay) : undefined;
      if ((recipe.overlay_digest ?? undefined) !== want) throw bad("overlay_mismatch", `recipe.overlay_digest must be ${want ?? "absent"}`);
      for (const p of paths) if (!recipe.patch.protected_paths.includes(p)) throw bad("overlay_unprotected", `overlay file ${p} must be listed in patch.protected_paths`);
      const vetted = this.vettedImages(recipe.class, recipe.requires.arch);
      if (!vetted.has(recipe.image)) throw bad("unvetted_image", `image must be one already used by an active ${recipe.class} lineage on ${recipe.requires.arch}: ${[...vetted].join(", ") || "none yet"}`);
      const rid = recipeId(recipe);
      if (body.recipe_id !== undefined && body.recipe_id !== rid) throw bad("recipe_id_mismatch", `recipe_id recomputes to ${rid}`);
      if (this.c.db.query("SELECT 1 FROM recipes WHERE name = ? AND recipe_id != ?").get(recipe.name, rid)) throw conflict("name_taken", "a recipe with this name exists");
      if (this.c.db.query("SELECT 1 FROM lineages WHERE recipe_id = ?").get(rid)) throw conflict("lineage_exists", "this recipe already has a lineage");
      if (this.c.db.query("SELECT 1 FROM recipe_proposals WHERE (recipe_id = ? OR name = ?) AND status IN ('waiting','calibrating','accepted')").get(rid, recipe.name))
        throw conflict("proposal_exists", "an open or accepted proposal has this recipe or name");
      const open = this.c.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM recipe_proposals WHERE proposer = ? AND status IN ('waiting','calibrating')").get(agent)!.n;
      if (open >= this.param("max_open_per_agent")) throw conflict("too_many_proposals", "too many open proposals");
      const id = H("recipe-proposal", agent, rid);
      this.c.db.query("DELETE FROM calib_replays WHERE proposal_id = ?").run(id);
      this.c.db.query("DELETE FROM recipe_proposals WHERE proposal_id = ?").run(id);
      const note = body.note === undefined || body.note === null ? null : String(body.note).slice(0, 4000);
      this.c.db
        .query(
          `INSERT INTO recipe_proposals (proposal_id, proposer, name, recipe_id, class, arch, repo, commit_sha, recipe, overlay, note, status, round, runs, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', 0, ?, ?)`,
        )
        .run(id, agent, recipe.name, rid, recipe.class, recipe.requires.arch, recipe.repo, recipe.commit, canonicalJson(recipe), canonicalJson(overlay), note, this.param("calib_runs"), this.c.now());
      this.c.emitEvent("recipe_proposal.submitted", { proposal_id: id, proposer: agent, name: recipe.name, recipe_id: rid, repo: recipe.repo, class: recipe.class });
      this.fill(id);
      return this.view(id);
    });
  }

  /** Verifiers qualified for a class (SPEC 6.1 "per class"): a passed qualification on an active lineage of that class and arch. */
  private classPool(p: PropRow, recipe: Recipe, exclude: Set<string>, excludeOps: Set<string>): Eligible[] {
    const epoch = this.c.currentEpoch().n;
    const qualified = new Set(
      this.c.db
        .query<{ agent_id: string; json: string }, []>(
          `SELECT q.agent_id, r.json FROM qualifications q JOIN lineages l ON l.lineage_id = q.lineage_id JOIN recipes r ON r.recipe_id = l.recipe_id
           WHERE q.status = 'passed' AND l.status = 'active'`,
        )
        .all()
        .filter((x) => {
          const rec = JSON.parse(x.json) as Recipe;
          return rec.class === p.class && rec.requires?.arch === p.arch;
        })
        .map((x) => x.agent_id),
    );
    return this.c.db
      .query<AgentRowLike, []>("SELECT * FROM agents ORDER BY agent_id")
      .all()
      .filter(
        (a) =>
          qualified.has(a.agent_id) &&
          !exclude.has(a.agent_id) &&
          !(a.operator && excludeOps.has(a.operator)) &&
          this.c.isEligible(a, epoch) &&
          satisfies(a.capabilities ? (JSON.parse(a.capabilities) as Capabilities) : null, recipe.requires),
      )
      .map((a) => ({ agent: a.agent_id, bond: this.c.bondOf(a.agent_id), operator: a.operator ?? undefined }));
  }

  /** Expires missed windows (the round restarts without those verifiers) and draws waiting proposals. Idempotent. */
  fill(only?: string) {
    return this.c.tx(() => {
      const now = this.c.now();
      for (const r of this.c.db.query<CReplayRow, [number]>("SELECT * FROM calib_replays WHERE status IN ('assigned','committed') AND deadline < ?").all(now)) {
        this.c.db.query("UPDATE calib_replays SET status = 'expired' WHERE replay_id = ?").run(r.replay_id);
        this.c.db.query("UPDATE calib_replays SET status = 'cancelled' WHERE proposal_id = ? AND round = ? AND status IN ('assigned','committed')").run(r.proposal_id, r.round);
        this.c.db.query("UPDATE recipe_proposals SET status = 'waiting', round = round + 1, seed = NULL WHERE proposal_id = ? AND status = 'calibrating' AND round = ?").run(r.proposal_id, r.round);
        this.c.emitEvent("recipe_proposal.replay_expired", { proposal_id: r.proposal_id, replay_id: r.replay_id });
      }
      const waiting = only
        ? this.c.db.query<PropRow, [string]>("SELECT * FROM recipe_proposals WHERE proposal_id = ? AND status = 'waiting'").all(only)
        : this.c.db.query<PropRow, []>("SELECT * FROM recipe_proposals WHERE status = 'waiting' ORDER BY created_at").all();
      for (const p of waiting) this.draw(p);
    });
  }

  private draw(p: PropRow) {
    const recipe = JSON.parse(p.recipe) as Recipe;
    const proposer = this.c.agentRow(p.proposer);
    const expired = this.c.db
      .query<{ replayer: string }, [string]>("SELECT replayer FROM calib_replays WHERE proposal_id = ? AND status = 'expired'")
      .all(p.proposal_id)
      .map((r) => r.replayer);
    const pool = this.classPool(p, recipe, new Set([p.proposer, ...expired]), new Set(proposer?.operator ? [proposer.operator] : []));
    const need = this.param("calib_replayers");
    if (pool.length < need) return; // waits until enough class-qualified verifiers exist
    const { beacon } = this.c.beacon(p.proposal_id, p.round);
    const aseed = assignmentSeed(beacon, p.proposal_id);
    const chosen = assignReplayers(aseed, pool, need, { agents: [] }, this.c.cfg.bond_cap);
    // one shared seed per round, unknown to the proposer when it submitted (SPEC 10.3)
    const seed = H("recipe-calib-seed", aseed);
    const deadline = this.c.now() + this.param("calib_window_s") * 1000;
    const poolJson = JSON.stringify(pool.map((x) => ({ agent: x.agent, bond: x.bond.toString(), operator: x.operator ?? null })));
    for (const who of chosen) {
      const rid = H("calib-replay", p.proposal_id, String(p.round), who);
      this.c.db
        .query("INSERT INTO calib_replays (replay_id, proposal_id, round, replayer, seed, assignment_seed, pool, status, deadline, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'assigned', ?, ?)")
        .run(rid, p.proposal_id, p.round, who, seed, aseed, poolJson, deadline, this.c.now());
      this.c.emitEvent("recipe_proposal.replay_assigned", { proposal_id: p.proposal_id, replay_id: rid, replayer: who });
    }
    this.c.db.query("UPDATE recipe_proposals SET status = 'calibrating', seed = ? WHERE proposal_id = ?").run(seed, p.proposal_id);
  }

  assignments(agent: string) {
    this.fill();
    return this.c.db
      .query<CReplayRow, [string]>("SELECT * FROM calib_replays WHERE replayer = ? AND status IN ('assigned','committed') ORDER BY created_at")
      .all(agent)
      .map((r) => {
        const p = this.row(r.proposal_id);
        const others = this.c.db.query<{ status: string }, [string, number]>("SELECT status FROM calib_replays WHERE proposal_id = ? AND round = ?").all(r.proposal_id, r.round);
        return {
          replay_id: r.replay_id,
          kind: "calibrate",
          proposal_id: r.proposal_id,
          status: r.status,
          // reveals open once every drawn verifier has committed, so nobody copies a calibration
          reveal_open: r.status === "committed" && others.every((o) => o.status === "committed" || o.status === "revealed"),
          deadline: r.deadline,
          recipe_id: p.recipe_id,
          recipe: JSON.parse(p.recipe) as Recipe,
          overlay: JSON.parse(p.overlay) as Record<string, string>,
          seed: r.seed,
          runs: p.runs,
        };
      });
  }

  private row(id: string): PropRow {
    const p = this.c.db.query<PropRow, [string]>("SELECT * FROM recipe_proposals WHERE proposal_id = ?").get(id);
    if (!p) throw notFound("recipe proposal");
    return p;
  }

  commit(agent: string, replayId: string, body: unknown) {
    return this.c.tx(() => {
      this.fill();
      const r = this.c.db.query<CReplayRow, [string]>("SELECT * FROM calib_replays WHERE replay_id = ?").get(replayId);
      if (!r) throw notFound("calibration replay");
      if (r.replayer !== agent) throw forbidden("not_assigned", "not your assignment");
      if (r.status !== "assigned") throw conflict("bad_state", `replay is ${r.status}`);
      const commitment = isObj(body) ? String(body.commitment ?? "") : "";
      if (!/^[0-9a-f]{64}$/.test(commitment)) throw bad("bad_commitment", "commitment is 64 hex");
      this.c.db.query("UPDATE calib_replays SET status = 'committed', commitment = ? WHERE replay_id = ?").run(commitment, replayId);
      this.c.emitEvent("recipe_proposal.replay_committed", { proposal_id: r.proposal_id, replay_id: replayId });
      return { replay_id: replayId, status: "committed" };
    });
  }

  reveal(agent: string, replayId: string, body: unknown) {
    return this.c.tx(() => {
      const r = this.c.db.query<CReplayRow, [string]>("SELECT * FROM calib_replays WHERE replay_id = ?").get(replayId);
      if (!r) throw notFound("calibration replay");
      if (r.replayer !== agent) throw forbidden("not_assigned", "not your assignment");
      if (r.status !== "committed") throw conflict("bad_state", `replay is ${r.status}`);
      const round = this.c.db.query<CReplayRow, [string, number]>("SELECT * FROM calib_replays WHERE proposal_id = ? AND round = ?").all(r.proposal_id, r.round);
      if (round.some((x) => x.status === "assigned")) throw conflict("reveal_not_open", "every drawn verifier must commit first");
      if (!isObj(body) || !isObj(body.calibration) || typeof body.deps_digest !== "string" || typeof body.salt !== "string") throw bad("bad_body", "{ calibration, deps_digest, salt } expected");
      const cal = body.calibration as unknown as Calibration;
      if (!strArr(cal.stable) || !strArr(cal.known_failures) || !strArr(cal.quarantined) || !isObj(cal.metrics) || typeof cal.runs !== "number" || typeof cal.median_eval_seconds !== "number")
        throw bad("bad_calibration", "stable, known_failures, quarantined, metrics, runs and median_eval_seconds required");
      const res = { calibration: cal, deps_digest: body.deps_digest };
      if (calibCommitment(res, body.salt) !== r.commitment) throw bad("commitment_mismatch", "calibration and salt do not open the commitment");
      this.c.db.query("UPDATE calib_replays SET status = 'revealed', result = ?, revealed_at = ? WHERE replay_id = ?").run(canonicalJson(res), this.c.now(), replayId);
      this.c.emitEvent("recipe_proposal.replay_revealed", { proposal_id: r.proposal_id, replay_id: replayId });
      const p = this.row(r.proposal_id);
      const now = this.c.db.query<CReplayRow, [string, number]>("SELECT * FROM calib_replays WHERE proposal_id = ? AND round = ?").all(r.proposal_id, r.round);
      if (p.status === "calibrating" && p.round === r.round && now.every((x) => x.status === "revealed")) this.decide(p, now);
      return { replay_id: replayId, status: "revealed", proposal: this.row(r.proposal_id).status };
    });
  }

  private decide(p: PropRow, round: CReplayRow[]) {
    const recipe = JSON.parse(p.recipe) as Recipe;
    const reveals: Revealed[] = round.map((x) => ({ replayer: x.replayer, ...(JSON.parse(x.result!) as { calibration: Calibration; deps_digest: string }) }));
    const m = mergeCalibrations(recipe, p.recipe_id, p.seed!, reveals, this.c.cfg.det_tolerance);
    const now = this.c.now();
    if (!m.ok) {
      // no slash: a recipe whose calibration does not reproduce is the proposal's fault, not the verifiers'
      this.c.db.query("UPDATE recipe_proposals SET status = 'rejected', reason = ?, decided_at = ? WHERE proposal_id = ?").run(m.reason, now, p.proposal_id);
      this.c.emitEvent("recipe_proposal.rejected", { proposal_id: p.proposal_id, reason: m.reason });
      return;
    }
    this.c.addRecipe({ recipe, recipe_id: p.recipe_id });
    const snap = this.c.addSnapshot({ repo: recipe.repo, commit: recipe.commit, deps_digest: m.deps_digest });
    const calibration = { ...m.calibration, snapshot_id: snap.snapshot_id };
    // the consensus of the calibration replays stands in for a reference runner's signature
    const sig = canonicalJson({ proposal_id: p.proposal_id, replays: round.map((x) => ({ replay_id: x.replay_id, replayer: x.replayer, commitment: x.commitment })) });
    const lin = this.c.submitCalibration(`proposal:${p.proposal_id}`, { calibration, sig }, true);
    this.c.db.query("UPDATE recipe_proposals SET status = 'accepted', lineage_id = ?, reason = NULL, decided_at = ? WHERE proposal_id = ?").run(lin.lineage_id, now, p.proposal_id);
    this.c.emitEvent("recipe_proposal.accepted", { proposal_id: p.proposal_id, recipe_id: p.recipe_id, lineage_id: lin.lineage_id, proposer: p.proposer });
  }

  view(id: string) {
    const p = this.row(id);
    const decided = p.status === "accepted" || p.status === "rejected";
    const replays = this.c.db.query<CReplayRow, [string]>("SELECT * FROM calib_replays WHERE proposal_id = ? ORDER BY round, replay_id").all(id);
    return {
      proposal_id: p.proposal_id,
      proposer: p.proposer,
      name: p.name,
      recipe_id: p.recipe_id,
      class: p.class,
      arch: p.arch,
      repo: p.repo,
      commit: p.commit_sha,
      recipe: JSON.parse(p.recipe),
      overlay: JSON.parse(p.overlay),
      note: p.note,
      status: p.status,
      round: p.round,
      runs: p.runs,
      reason: p.reason,
      lineage_id: p.lineage_id,
      created_at: p.created_at,
      decided_at: p.decided_at,
      replays: replays.map((r) => ({
        replay_id: r.replay_id,
        round: r.round,
        replayer: r.replayer,
        status: r.status,
        seed: decided ? r.seed : null,
        assignment_seed: r.assignment_seed,
        result: decided && r.result ? JSON.parse(r.result) : null,
      })),
    };
  }

  list(status?: string) {
    this.fill();
    const rows = status
      ? this.c.db.query<{ proposal_id: string }, [string]>("SELECT proposal_id FROM recipe_proposals WHERE status = ? ORDER BY created_at").all(status)
      : this.c.db.query<{ proposal_id: string }, []>("SELECT proposal_id FROM recipe_proposals ORDER BY created_at").all();
    return rows.map((r) => this.view(r.proposal_id));
  }
}
