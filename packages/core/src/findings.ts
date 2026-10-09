import type { Core } from "./core.ts";
import { bad, conflict, forbidden, notFound } from "./errors.ts";
import { H, assignmentSeed, assignReplayers, canonicalJson, matchesAny, relDiff, type Calibration, type Eligible, type Recipe } from "./protocol.ts";

// Hotspot findings (SPEC 12, 12.8). An agent profiles its lineage's tip in the sandbox (callgrind
// self cost per function for valgrind metrics, compute units per measured instruction for CU
// metrics) and files a claim: "function F accounts for share S of metric M at tip G". The claim
// counts only after a replay by another qualified worker reproduces the profile numbers. Then it
// becomes a `hotspot` finding (findings table) that proposers see, and the first accepted perf
// generation on M whose patch changes F's source file resolves it and credits the finder.
//
// Flow, with commit-reveal like replays (SPEC 10.4):
//   POST /v1/findings/hotspots              finder files { lineage_id, tip, metric, tool, target, profile, seed, note }
//   GET  /v1/findings/assignments           a drawn replayer reads its profile assignment (no claimed numbers, no target)
//   POST /v1/findings/replays/:id/commit    { commitment = H("profile-result", canonical(result), salt) }
//   POST /v1/findings/replays/:id/reveal    { result: { total, functions[] }, salt }
//   GET  /v1/findings/hotspots[?lineage=]   claims; claimed numbers stay hidden until the claim is decided

interface Internals {
  db: Core["db"];
  cfg: Core["cfg"];
  now(): number;
  tx<T>(fn: () => T): T;
  emitEvent(type: string, data: unknown): void;
  lineageRow(id: string): { lineage_id: string; recipe_id: string; calib_id: string; tip: string; status: string } | null;
  recipeOf(id: string): Recipe;
  calibOf(id: string): Calibration;
  agentRow(id: string): { agent_id: string; operator: string | null } | null;
  eligiblePool(excludeAgents: Set<string>, excludeOperators: Set<string>, lineage: unknown): Eligible[];
  beacon(subject: string, round: number): { beacon: string; bucket: number; epoch: { n: number } } | null;
  replayWindowMs(calib: Calibration): number;
  insertFinding(lineage: string, tip: string, kind: string, target: string, finder: string | null): string;
}

export const FINDINGS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS hotspot_claims (
    claim_id TEXT PRIMARY KEY,           -- H("hotspot-claim", lineage, tip, metric, function)
    lineage_id TEXT NOT NULL,
    tip TEXT NOT NULL,
    finder TEXT NOT NULL,
    metric TEXT NOT NULL,
    tool TEXT NOT NULL,                  -- callgrind | cu
    function TEXT NOT NULL,
    file TEXT,
    seed TEXT NOT NULL,
    profile TEXT NOT NULL,               -- JSON { total, functions[] } as the finder measured it
    note TEXT,
    status TEXT NOT NULL,                -- waiting | reproducing | verified | failed | resolved
    round INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    finding_id TEXT,
    resolved_by TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS hotspot_claims_lineage ON hotspot_claims(lineage_id, status);
  CREATE TABLE IF NOT EXISTS profile_replays (
    replay_id TEXT PRIMARY KEY,
    claim_id TEXT NOT NULL,
    round INTEGER NOT NULL,
    replayer TEXT NOT NULL,
    assignment_seed TEXT NOT NULL,
    pool TEXT NOT NULL,                  -- JSON eligible pool at the draw, for verification
    status TEXT NOT NULL,                -- assigned | committed | revealed | expired
    commitment TEXT,
    result TEXT,
    deadline INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    revealed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS profile_replays_replayer ON profile_replays(replayer, status);
`;

/** One function's cost in a profile. `self` is exclusive cost in the metric's unit (Ir or CU). */
export interface ProfileFn {
  fn: string;
  file: string | null;
  self: number;
}
export interface Profile {
  total: number;
  functions: ProfileFn[];
}

/** Commitment a profile replayer posts before revealing (SPEC 10.4 shape). */
export const profileCommitment = (result: Profile, salt: string): string => H("profile-result", canonicalJson(result), salt);

/** A share below this is not a hotspot (one percent of the metric). */
export const MIN_HOTSPOT_SHARE = 0.01;
const MAX_FUNCTIONS = 200;
const MAX_OPEN_CLAIMS = 3;

interface ClaimRow {
  claim_id: string;
  lineage_id: string;
  tip: string;
  finder: string;
  metric: string;
  tool: string;
  function: string;
  file: string | null;
  seed: string;
  profile: string;
  note: string | null;
  status: string;
  round: number;
  reason: string | null;
  finding_id: string | null;
  resolved_by: string | null;
  created_at: number;
  decided_at: number | null;
}
interface PReplayRow {
  replay_id: string;
  claim_id: string;
  round: number;
  replayer: string;
  assignment_seed: string;
  pool: string;
  status: string;
  commitment: string | null;
  result: string | null;
  deadline: number;
  created_at: number;
  revealed_at: number | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Which profiler a metric supports: valgrind metrics profile with callgrind, compute-unit metrics break down by instruction. */
export function profileTool(recipe: Recipe, metric: string): "callgrind" | "cu" | null {
  const m = recipe.metrics.find((x) => x.name === metric);
  if (!m || !m.deterministic) return null;
  if (m.parser === "cachegrind-ir" && /\bvalgrind\s/.test(m.command)) return "callgrind";
  if (recipe.class === "solana" && m.parser === "number") return "cu";
  return null;
}

/** Normalises a profiled source path to a repository path (container checkout lives at /work/src). */
export function repoPath(file: string | null): string | null {
  if (!file) return null;
  const f = file.replace(/^\/work\/src\//, "").replace(/^\.\//, "");
  return f.startsWith("/") ? null : f;
}

/** Files a unified diff touches (b/ side). */
export function patchFiles(patch: string): string[] {
  const out = new Set<string>();
  for (const l of patch.split("\n")) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
    if (m) out.add(m[2]!);
  }
  return [...out];
}

export function parseProfile(v: unknown, what: string): Profile {
  if (!isObj(v)) throw bad("bad_profile", `${what}: { total, functions[] } expected`);
  const total = v.total;
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) throw bad("bad_profile", `${what}: total must be a positive number`);
  if (!Array.isArray(v.functions) || v.functions.length === 0 || v.functions.length > MAX_FUNCTIONS)
    throw bad("bad_profile", `${what}: functions must hold 1 to ${MAX_FUNCTIONS} entries`);
  const seen = new Set<string>();
  const functions = v.functions.map((f, i) => {
    if (!isObj(f) || typeof f.fn !== "string" || !f.fn || f.fn.length > 500) throw bad("bad_profile", `${what}: functions[${i}].fn`);
    if (f.file !== null && f.file !== undefined && (typeof f.file !== "string" || f.file.length > 500)) throw bad("bad_profile", `${what}: functions[${i}].file`);
    if (typeof f.self !== "number" || !Number.isFinite(f.self) || f.self < 0 || f.self > total) throw bad("bad_profile", `${what}: functions[${i}].self`);
    const key = `${f.fn}\u0000${f.file ?? ""}`;
    if (seen.has(key)) throw bad("bad_profile", `${what}: duplicate function ${f.fn}`);
    seen.add(key);
    return { fn: f.fn, file: (f.file as string | null | undefined) ?? null, self: f.self };
  });
  return { total, functions };
}

/** Finds the claimed function in a profile: same name, and the same file when both name one. */
function findFn(p: Profile, fn: string, file: string | null): ProfileFn | undefined {
  return p.functions.find((f) => f.fn === fn && (!file || !f.file || repoPath(f.file) === repoPath(file)));
}

/**
 * Pure verdict on one reproduction: the replayer's total and the claimed function's self cost must
 * equal the finder's within the deterministic tolerance (SPEC 9.1), and the share must still make
 * it a hotspot.
 */
export function judgeReproduction(claim: { function: string; file: string | null; profile: Profile }, got: Profile, tol: number): { ok: boolean; reason: string } {
  const mine = findFn(claim.profile, claim.function, claim.file);
  if (!mine) return { ok: false, reason: "claimed function missing from the claim's own profile" };
  const theirs = findFn(got, claim.function, claim.file);
  if (!theirs) return { ok: false, reason: "the replay's profile does not list the claimed function" };
  const dt = relDiff(claim.profile.total, got.total);
  if (dt > tol) return { ok: false, reason: `total differs by ${dt.toExponential(2)} (tolerance ${tol})` };
  const ds = relDiff(mine.self, theirs.self);
  if (ds > tol) return { ok: false, reason: `self cost of ${claim.function} differs by ${ds.toExponential(2)} (tolerance ${tol})` };
  if (theirs.self / got.total < MIN_HOTSPOT_SHARE) return { ok: false, reason: `share ${(theirs.self / got.total).toFixed(4)} below ${MIN_HOTSPOT_SHARE}` };
  return { ok: true, reason: `reproduced: total ${got.total}, self ${theirs.self}` };
}

/** The findings-table target of a verified hotspot (what proposers read). Numbers are the replay's. */
export function hotspotTarget(metric: string, tool: string, fn: string, file: string | null, self: number, total: number): string {
  const unit = tool === "cu" ? "compute units" : "self Ir";
  const where = repoPath(file) ?? file;
  return `${metric}: ${fn}${where ? ` in ${where}` : ""} (${((100 * self) / total).toFixed(1)}% of ${unit}, ${self} of ${total})`;
}

const instances = new WeakMap<Core, Findings>();
/** The one Findings of a Core (created on first use, schema included). */
export function findingsOf(core: Core): Findings {
  let f = instances.get(core);
  if (!f) instances.set(core, (f = new Findings(core)));
  return f;
}

export class Findings {
  private c: Internals;

  constructor(core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(FINDINGS_SCHEMA);
  }

  /** Replays per claim. SPEC 12: one replay reproduces the profile. */
  get replaysPerClaim(): number {
    const v = (this.c.cfg as unknown as Record<string, unknown>).hotspot_replays;
    return typeof v === "number" && v >= 1 ? v : 1;
  }

  file(agent: string, body: unknown) {
    return this.c.tx(() => {
      const a = this.c.agentRow(agent);
      if (!a) throw forbidden("not_registered", `agent ${agent} is not registered`);
      if (!isObj(body)) throw bad("bad_body", "object expected");
      const l = this.c.lineageRow(String(body.lineage_id ?? ""));
      if (!l) throw notFound("lineage");
      if (l.status !== "active") throw conflict("lineage_inactive", "the lineage is not active");
      if (body.tip !== l.tip) throw conflict("stale_tip", "profile the current tip");
      const recipe = this.c.recipeOf(l.recipe_id);
      const metric = String(body.metric ?? "");
      const tool = profileTool(recipe, metric);
      if (!tool) throw bad("bad_metric", "metric must be a deterministic valgrind (callgrind) or compute-unit metric of the recipe");
      if (body.tool !== tool) throw bad("bad_tool", `metric ${metric} is profiled with ${tool}`);
      const calib = this.c.calibOf(l.calib_id);
      if (calib.metrics[metric]?.enabled === false) throw bad("bad_metric", "metric is disabled by calibration");
      const t = body.target;
      if (!isObj(t) || typeof t.function !== "string" || !t.function || t.function.length > 500) throw bad("bad_target", "target { function, file } expected");
      const file = t.file === undefined || t.file === null ? null : String(t.file);
      const seed = String(body.seed ?? "");
      if (!/^[0-9a-f]{8,64}$/.test(seed)) throw bad("bad_seed", "seed is 8 to 64 lowercase hex");
      const profile = parseProfile(body.profile, "profile");
      const mine = findFn(profile, t.function, file);
      if (!mine) throw bad("bad_target", "the target function is not in the profile");
      if (mine.self / profile.total < MIN_HOTSPOT_SHARE) throw bad("not_a_hotspot", `share below ${MIN_HOTSPOT_SHARE}`);
      // a hotspot must be something a patch may change: its source file has to be an allowed path
      const rp = repoPath(file);
      if (!rp) throw bad("bad_target", "target.file must be a repository path");
      if (!matchesAny(rp, recipe.patch.allowed_paths) || matchesAny(rp, recipe.patch.protected_paths)) throw bad("bad_target", `${rp} is not a patchable path of the recipe`);
      const note = body.note === undefined || body.note === null ? null : String(body.note).slice(0, 4000);
      const id = H("hotspot-claim", l.lineage_id, l.tip, metric, t.function);
      const prev = this.c.db.query<{ status: string }, [string]>("SELECT status FROM hotspot_claims WHERE claim_id = ?").get(id);
      if (prev && prev.status !== "failed") throw conflict("claim_exists", "this hotspot is already claimed at this tip");
      const open = this.c.db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM hotspot_claims WHERE finder = ? AND status IN ('waiting','reproducing')")
        .get(agent)!.n;
      if (open >= MAX_OPEN_CLAIMS) throw conflict("too_many_claims", `at most ${MAX_OPEN_CLAIMS} open claims per agent`);
      if (prev) {
        this.c.db.query("DELETE FROM profile_replays WHERE claim_id = ?").run(id);
        this.c.db.query("DELETE FROM hotspot_claims WHERE claim_id = ?").run(id);
      }
      this.c.db
        .query(
          `INSERT INTO hotspot_claims (claim_id, lineage_id, tip, finder, metric, tool, function, file, seed, profile, note, status, round, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', 0, ?)`,
        )
        .run(id, l.lineage_id, l.tip, agent, metric, tool, t.function, rp, seed, canonicalJson(profile), note, this.c.now());
      this.c.emitEvent("hotspot.claimed", { claim_id: id, lineage_id: l.lineage_id, tip: l.tip, finder: agent, metric, tool, function: t.function, file: rp });
      this.fill(id);
      return this.view(id, agent);
    });
  }

  /** Draws replayers for waiting claims and expires missed windows. Idempotent; called on every read. */
  fill(only?: string) {
    return this.c.tx(() => {
      const now = this.c.now();
      for (const r of this.c.db
        .query<PReplayRow, [number]>("SELECT * FROM profile_replays WHERE status IN ('assigned','committed') AND deadline < ?")
        .all(now)) {
        this.c.db.query("UPDATE profile_replays SET status = 'expired' WHERE replay_id = ?").run(r.replay_id);
        this.c.db.query("UPDATE hotspot_claims SET status = 'waiting', round = round + 1 WHERE claim_id = ? AND status = 'reproducing'").run(r.claim_id);
        this.c.emitEvent("hotspot.replay_expired", { claim_id: r.claim_id, replay_id: r.replay_id });
      }
      const waiting = only
        ? this.c.db.query<ClaimRow, [string]>("SELECT * FROM hotspot_claims WHERE claim_id = ? AND status = 'waiting'").all(only)
        : this.c.db.query<ClaimRow, []>("SELECT * FROM hotspot_claims WHERE status = 'waiting' ORDER BY created_at").all();
      for (const cl of waiting) this.draw(cl);
    });
  }

  private draw(cl: ClaimRow) {
    const l = this.c.lineageRow(cl.lineage_id)!;
    if (l.tip !== cl.tip) {
      // the tip moved before anyone reproduced it: the profile no longer describes the lineage
      this.decide(cl, "failed", "the tip moved before the profile was reproduced");
      return;
    }
    const finder = this.c.agentRow(cl.finder);
    const past = new Set(this.c.db.query<{ replayer: string }, [string]>("SELECT replayer FROM profile_replays WHERE claim_id = ?").all(cl.claim_id).map((r) => r.replayer));
    const exAgents = new Set([cl.finder, ...past]);
    const exOps = new Set(finder?.operator ? [finder.operator] : []);
    const pool = this.c.eligiblePool(exAgents, exOps, l);
    const need = this.replaysPerClaim;
    if (pool.length < need) return; // stays waiting until enough qualified verifiers exist
    const b = this.c.beacon(cl.claim_id, cl.round);
    if (!b) return; // slot beacon (M2): the draw waits for its slot to be final
    const { beacon } = b;
    const seed = assignmentSeed(beacon, cl.claim_id);
    const chosen = assignReplayers(seed, pool, need, { agents: [] }, this.c.cfg.bond_cap);
    const deadline = this.c.now() + this.c.replayWindowMs(this.c.calibOf(l.calib_id));
    const poolJson = JSON.stringify(pool.map((p) => ({ agent: p.agent, bond: p.bond.toString(), operator: p.operator ?? null })));
    for (const who of chosen) {
      const rid = H("profile-replay", cl.claim_id, String(cl.round), who);
      this.c.db
        .query("INSERT INTO profile_replays (replay_id, claim_id, round, replayer, assignment_seed, pool, status, deadline, created_at) VALUES (?, ?, ?, ?, ?, ?, 'assigned', ?, ?)")
        .run(rid, cl.claim_id, cl.round, who, seed, poolJson, deadline, this.c.now());
      // no replayer in the public event: it is named once the claim is decided (12.8; audit A2, OFF-13)
      this.c.emitEvent("hotspot.replay_assigned", { claim_id: cl.claim_id, replay_id: rid });
    }
    this.c.db.query("UPDATE hotspot_claims SET status = 'reproducing' WHERE claim_id = ?").run(cl.claim_id);
  }

  /** Profile assignments of an agent. They name the metric, tip and seed, never the claimed numbers or function. */
  assignments(agent: string) {
    this.fill();
    return this.c.db
      .query<PReplayRow & ClaimRow & { rstatus: string }, [string]>(
        `SELECT r.replay_id, r.status AS rstatus, r.deadline, c.* FROM profile_replays r JOIN hotspot_claims c ON c.claim_id = r.claim_id
         WHERE r.replayer = ? AND r.status IN ('assigned','committed') ORDER BY r.created_at`,
      )
      .all(agent)
      .map((r) => {
        const l = this.c.lineageRow(r.lineage_id)!;
        return {
          replay_id: r.replay_id,
          kind: "profile",
          claim_id: r.claim_id,
          status: r.rstatus,
          reveal_open: r.rstatus === "committed",
          deadline: r.deadline,
          lineage_id: r.lineage_id,
          recipe_id: l.recipe_id,
          tip: r.tip,
          metric: r.metric,
          tool: r.tool,
          seed: r.seed,
        };
      });
  }

  commit(agent: string, replayId: string, body: unknown) {
    return this.c.tx(() => {
      this.fill();
      const r = this.c.db.query<PReplayRow, [string]>("SELECT * FROM profile_replays WHERE replay_id = ?").get(replayId);
      if (!r) throw notFound("profile replay");
      if (r.replayer !== agent) throw forbidden("not_assigned", "not your assignment");
      if (r.status !== "assigned") throw conflict("bad_state", `replay is ${r.status}`);
      const commitment = isObj(body) ? String(body.commitment ?? "") : "";
      if (!/^[0-9a-f]{64}$/.test(commitment)) throw bad("bad_commitment", "commitment is 64 hex");
      this.c.db.query("UPDATE profile_replays SET status = 'committed', commitment = ? WHERE replay_id = ?").run(commitment, replayId);
      this.c.emitEvent("hotspot.replay_committed", { claim_id: r.claim_id, replay_id: replayId });
      return { replay_id: replayId, status: "committed" };
    });
  }

  reveal(agent: string, replayId: string, body: unknown) {
    return this.c.tx(() => {
      const r = this.c.db.query<PReplayRow, [string]>("SELECT * FROM profile_replays WHERE replay_id = ?").get(replayId);
      if (!r) throw notFound("profile replay");
      if (r.replayer !== agent) throw forbidden("not_assigned", "not your assignment");
      if (r.status !== "committed") throw conflict("bad_state", `replay is ${r.status}`);
      if (!isObj(body) || typeof body.salt !== "string") throw bad("bad_body", "{ result, salt } expected");
      const got = parseProfile(body.result, "result");
      if (profileCommitment(got, body.salt) !== r.commitment) throw bad("commitment_mismatch", "result and salt do not open the commitment");
      this.c.db.query("UPDATE profile_replays SET status = 'revealed', result = ?, revealed_at = ? WHERE replay_id = ?").run(canonicalJson(got), this.c.now(), replayId);
      this.c.emitEvent("hotspot.replay_revealed", { claim_id: r.claim_id, replay_id: replayId });
      const cl = this.c.db.query<ClaimRow, [string]>("SELECT * FROM hotspot_claims WHERE claim_id = ?").get(r.claim_id)!;
      if (cl.status !== "reproducing") return { replay_id: replayId, status: "revealed", claim: cl.status };
      const round = this.c.db
        .query<PReplayRow, [string, number]>("SELECT * FROM profile_replays WHERE claim_id = ? AND round = ?")
        .all(cl.claim_id, cl.round);
      if (round.some((x) => x.status !== "revealed")) return { replay_id: replayId, status: "revealed", claim: cl.status };
      const claimProfile = JSON.parse(cl.profile) as Profile;
      const verdicts = round.map((x) => judgeReproduction({ function: cl.function, file: cl.file, profile: claimProfile }, JSON.parse(x.result!) as Profile, this.c.cfg.det_tolerance));
      const failed = verdicts.find((v) => !v.ok);
      if (failed) this.decide(cl, "failed", failed.reason);
      else {
        const first = JSON.parse(round[0]!.result!) as Profile;
        const fn = findFn(first, cl.function, cl.file)!;
        const target = hotspotTarget(cl.metric, cl.tool, cl.function, cl.file, fn.self, first.total);
        const fid = this.c.insertFinding(cl.lineage_id, cl.tip, "hotspot", target, cl.finder);
        this.c.db.query("UPDATE hotspot_claims SET finding_id = ? WHERE claim_id = ?").run(fid, cl.claim_id);
        this.decide(cl, "verified", verdicts[0]!.reason);
      }
      return { replay_id: replayId, status: "revealed", claim: this.view(cl.claim_id, agent).status };
    });
  }

  private decide(cl: ClaimRow, status: "verified" | "failed", reason: string) {
    this.c.db.query("UPDATE hotspot_claims SET status = ?, reason = ?, decided_at = ? WHERE claim_id = ?").run(status, reason, this.c.now(), cl.claim_id);
    this.c.emitEvent(`hotspot.${status}`, { claim_id: cl.claim_id, lineage_id: cl.lineage_id, finder: cl.finder, reason });
  }

  /**
   * Called when a generation is accepted (core.ts createGeneration). A `perf` generation on metric M
   * whose patch changes the source file of an open verified hotspot of M resolves it. Returns the
   * finders to credit with `finder_share` (never the generation's own author).
   */
  resolveOnAccept(g: { lineage_id: string; gen_id: string; kind: string; metric: string | undefined; patch: string | null; author: string }): string[] {
    if (g.kind !== "perf" || !g.metric || !g.patch) return [];
    const touched = new Set(patchFiles(g.patch));
    const finders: string[] = [];
    for (const cl of this.c.db
      .query<ClaimRow, [string, string]>("SELECT * FROM hotspot_claims WHERE lineage_id = ? AND metric = ? AND status = 'verified' ORDER BY created_at")
      .all(g.lineage_id, g.metric)) {
      if (!cl.file || !touched.has(cl.file) || !cl.finding_id) continue;
      this.c.db.query("UPDATE findings SET status = 'resolved', resolved_by = ? WHERE finding_id = ? AND status = 'open'").run(g.gen_id, cl.finding_id);
      this.c.db.query("UPDATE hotspot_claims SET status = 'resolved', resolved_by = ? WHERE claim_id = ?").run(g.gen_id, cl.claim_id);
      this.c.emitEvent("finding.resolved", { finding_id: cl.finding_id, gen_id: g.gen_id, claim_id: cl.claim_id });
      if (cl.finder !== g.author) finders.push(cl.finder);
    }
    return finders;
  }

  view(id: string, viewer: string | null = null) {
    const cl = this.c.db.query<ClaimRow, [string]>("SELECT * FROM hotspot_claims WHERE claim_id = ?").get(id);
    if (!cl) throw notFound("hotspot claim");
    const decided = !["waiting", "reproducing"].includes(cl.status);
    // claimed numbers stay sealed until decided, so a drawn replayer has nothing to copy
    const showNumbers = decided || viewer === cl.finder;
    const replays = this.c.db.query<PReplayRow, [string]>("SELECT * FROM profile_replays WHERE claim_id = ? ORDER BY round, replay_id").all(id);
    return {
      claim_id: cl.claim_id,
      lineage_id: cl.lineage_id,
      tip: cl.tip,
      finder: cl.finder,
      metric: cl.metric,
      tool: cl.tool,
      function: cl.function,
      file: cl.file,
      seed: cl.seed,
      note: cl.note,
      status: cl.status,
      reason: cl.reason,
      finding_id: cl.finding_id,
      resolved_by: cl.resolved_by,
      created_at: cl.created_at,
      decided_at: cl.decided_at,
      profile: showNumbers ? JSON.parse(cl.profile) : null,
      replays: replays.map((r) => ({
        replay_id: r.replay_id,
        round: r.round,
        replayer: decided ? r.replayer : null,
        status: r.status,
        assignment_seed: decided ? r.assignment_seed : null,
        pool: decided ? JSON.parse(r.pool) : null,
        result: decided && r.result ? JSON.parse(r.result) : null,
      })),
    };
  }

  list(lineage?: string, viewer: string | null = null) {
    this.fill();
    const rows = lineage
      ? this.c.db.query<{ claim_id: string }, [string]>("SELECT claim_id FROM hotspot_claims WHERE lineage_id = ? ORDER BY created_at").all(lineage)
      : this.c.db.query<{ claim_id: string }, []>("SELECT claim_id FROM hotspot_claims ORDER BY created_at").all();
    return rows.map((r) => this.view(r.claim_id, viewer));
  }
}
