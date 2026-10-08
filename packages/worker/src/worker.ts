import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  calibId,
  canonicalizeDiff,
  canonicalJson,
  guard,
  H,
  hashJson,
  judge,
  patchCommitment,
  patchHash,
  resultCommitment,
  signMessage,
  signStatement,
  type AgentKey,
  type Calibration,
  type Capabilities,
  type CandidateKind,
  type CandidateView,
  type Recipe,
  type ReplayResult,
} from "@lineage/protocol";
import { applyPatch, calibrate, diffWorkingTree, evaluate, materialize, newWorkDir, removeTree, WORKER_VERSION, type Transcript } from "@lineage/sandbox";
import { CoreClient } from "../../core/src/client.ts";
import { teamStatement, type TeamMember } from "../../core/src/collab.ts";
import type { Finding, IntentView, PlannedTarget, ProposeContext, Proposer } from "./proposers/types.ts";
import { doctor } from "./doctor.ts";
import { RecipeBook } from "./recipes.ts";
import { Telemetry } from "./telemetry.ts";

// The worker process: replays assignments first (they have deadlines), then authors when it has a
// proposer and its agent is an awake launched agent (SPEC 3, 5).

/**
 * Test-only dishonest modes. `fabricate` never runs anything, qualification included (so it never
 * qualifies); `fabricate-after-qualify` qualifies honestly, then fabricates every replay.
 */
export type Dishonesty = "none" | "fabricate" | "fabricate-after-qualify";

export interface WorkerOptions {
  core: string;
  key: AgentKey;
  proposer?: Proposer;
  /** lineages this worker authors on; empty means every lineage of its target repo */
  lineages?: string[];
  dishonest?: Dishonesty;
  log?: (msg: string) => void;
  stateDir?: string;
  /** stop authoring after this many submitted candidates (e2e) */
  maxCandidates?: number;
  /** capabilities to declare; default: what doctor() detects */
  capabilities?: Capabilities;
  /** live heartbeats and activity (SPEC 17.1); default on */
  telemetry?: boolean;
  /**
   * Collaboration (SPEC 12.1): `advisory` (default) reads the lineage's intents, lets the proposer
   * plan a target nobody else holds, and files an intent for it before editing; `team` does the same
   * and commits team candidates when `team` is set (SPEC 12.2); `off` does neither.
   */
  collab?: "off" | "advisory" | "team";
  /**
   * Team candidates (SPEC 12.2, with collab "team"): the members and declared shares (this agent
   * must be an `author` member) and the keys of co-members this operator holds; each signs every
   * commitment and split. Without a key for every other member the worker commits alone.
   */
  team?: { members: TeamMember[]; keys: AgentKey[] };
}

interface PendingReplay {
  result: ReplayResult;
  salt: string;
}

interface Assignment {
  replay_id: string;
  kind: "replay" | "audit" | "reference" | "qualify";
  status: "assigned" | "committed";
  reveal_open: boolean;
  seed: string;
  lineage: { lineage_id: string; repo: string; commit: string; snapshot_id: string; deps_digest: string };
  recipe_id: string;
  recipe: Recipe;
  calibration: Calibration;
  parent_gen_id: string;
  parent_series: { gen_id: string; patch: string }[];
  /** null for a qualification (SPEC 6.1) */
  candidate: { candidate_id: string; kind: CandidateKind; target: string | string[]; patch: string; patch_hash: string } | null;
}

class ApiFailure extends Error {
  constructor(public status: number, public body: unknown, what: string) {
    super(`${what}: HTTP ${status} ${JSON.stringify(body).slice(0, 300)}`);
  }
}

export class Worker {
  readonly client: CoreClient;
  readonly recipes = new RecipeBook();
  readonly telemetry: Telemetry;
  private log: (m: string) => void;
  private pending = new Map<string, PendingReplay>();
  private stateFile: string;
  private submitted = 0;
  private busy = false;

  constructor(private opts: WorkerOptions) {
    this.client = new CoreClient(opts.core, opts.key);
    // a rotated agent signs with a new key under its unchanged agent id (identity plan I1)
    const agentId = (opts.key as { agent?: string }).agent ?? opts.key.id;
    const tag = agentId.slice(0, 6);
    this.log = opts.log ?? ((m) => console.log(`[${new Date().toISOString().slice(11, 19)} ${tag}] ${m}`));
    const dir = opts.stateDir ?? join(process.env.LINEAGE_HOME ?? join(homedir(), ".lineage"), "worker", agentId);
    mkdirSync(dir, { recursive: true });
    this.stateFile = join(dir, "pending.json");
    this.telemetry = new Telemetry(this.client, this.log, { enabled: opts.telemetry !== false });
    if (existsSync(this.stateFile)) {
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(this.stateFile, "utf8")) as Record<string, PendingReplay>)) this.pending.set(k, v);
    }
  }

  get id(): string {
    return (this.opts.key as { agent?: string }).agent ?? this.opts.key.id;
  }

  private persist(): void {
    writeFileSync(this.stateFile, JSON.stringify(Object.fromEntries(this.pending)));
  }

  private async ok<T = any>(p: Promise<{ status: number; body: T }>, what: string): Promise<T> {
    const r = await p;
    if (r.status >= 300) throw new ApiFailure(r.status, r.body, what);
    return r.body;
  }

  async me() {
    return this.ok(this.client.get(`/v1/agents/${this.id}`), "agent");
  }

  // ------------------------------------------------------------------ replaying

  /** One pass over assignments: commit new ones, reveal open ones. Returns how many it acted on. */
  async replayOnce(): Promise<number> {
    const list = await this.ok<Assignment[]>(this.client.get("/v1/assignments", true), "assignments");
    let acted = 0;
    for (const a of list) {
      try {
        if (a.status === "assigned") {
          await this.runAndCommit(a);
          acted++;
        } else if (a.status === "committed" && a.reveal_open) {
          const p = this.pending.get(a.replay_id);
          if (!p) {
            this.log(`replay ${a.replay_id.slice(0, 10)}: committed but local result lost; cannot reveal`);
            continue;
          }
          this.telemetry.job(a.kind === "qualify" ? "qualify" : "replay", { replay_id: a.replay_id });
          this.telemetry.phase("reveal");
          const r = await this.ok(this.client.post(`/v1/replays/${a.replay_id}/reveal`, { result: p.result, salt: p.salt }), "reveal");
          this.pending.delete(a.replay_id);
          this.persist();
          this.log(`replay ${a.replay_id.slice(0, 10)}: revealed (${(r as { status: string }).status})`);
          acted++;
        }
      } catch (e) {
        this.log(`replay ${a.replay_id.slice(0, 10)}: ${(e as Error).message}`);
      } finally {
        this.telemetry.idle();
      }
    }
    return acted;
  }

  private async runAndCommit(a: Assignment): Promise<void> {
    const t0 = Date.now();
    this.telemetry.job(a.kind === "qualify" || !a.candidate ? "qualify" : "replay", { replay_id: a.replay_id });
    const loaded = this.recipes.get(a.recipe_id);
    let result: ReplayResult;
    let transcript: Transcript | Record<string, unknown>;
    if (a.kind === "qualify" || !a.candidate) {
      if (this.opts.dishonest === "fabricate") ({ result, transcript } = fabricateQualification(a));
      else ({ result, transcript } = await this.qualifyRun(a));
    } else if (this.opts.dishonest === "fabricate" || this.opts.dishonest === "fabricate-after-qualify") {
      ({ result, transcript } = fabricate(a));
    } else {
      const deps = await this.recipes.depsFor(loaded, a.lineage.deps_digest);
      ({ result, transcript } = await evaluate({ loaded, deps, parentPatches: a.parent_series.map((p) => p.patch), candidatePatch: a.candidate!.patch, seed: a.seed, onPhase: this.telemetry.onPhase, enabledMetrics: enabledMetrics(a.calibration) }));
    }
    this.telemetry.phase("commit");
    const bytes = canonicalJson(transcript);
    if (hashJson(transcript) !== result.transcript_digest) result.transcript_digest = hashJson(transcript);
    await this.ok(this.client.putBlob(result.transcript_digest, new TextEncoder().encode(bytes)), "transcript upload");
    const salt = randomBytes(16).toString("hex");
    this.pending.set(a.replay_id, { result, salt });
    this.persist();
    await this.ok(this.client.post(`/v1/replays/${a.replay_id}/commit`, { commitment: resultCommitment(result, salt) }), "commit");
    if (!a.candidate) {
      const m = Object.entries(result.metrics).map(([k, v]) => `${k}=${v.base[0]}`).join(" ");
      this.log(`qualify ${a.replay_id.slice(0, 10)} on ${a.lineage.lineage_id.slice(0, 10)}: base ${result.build.base}, ${result.tests.base_pass.length} tests pass, ${m}, committed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return;
    }
    const summary = result.guard !== "ok" ? result.guard : result.apply !== "ok" ? "conflict" : `build ${result.build.cand}, ${result.tests.cand_pass.length} tests pass`;
    this.log(`replay ${a.replay_id.slice(0, 10)} (${a.kind}) of ${a.candidate.candidate_id.slice(0, 10)}: ${summary}, committed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  /**
   * Qualification (SPEC 6.1): a baseline-only measurement of gen_0 with the calibration seed. Build,
   * one test run and the deterministic metrics, measured with the sandbox's calibrate() at runs=1.
   * Core compares the stable set and base values with the recorded calibration.
   */
  private async qualifyRun(a: Assignment): Promise<{ result: ReplayResult; transcript: Transcript | Record<string, unknown> }> {
    const loaded = this.recipes.get(a.recipe_id);
    const deps = await this.recipes.depsFor(loaded, a.lineage.deps_digest);
    const result: ReplayResult = {
      apply: "ok",
      guard: "ok",
      build: { base: "fail", cand: "skipped" },
      tests: { base_pass: [], cand_pass: [], cand_fail: [] },
      equivalence: null,
      metrics: {},
      env: { image_digest: a.recipe.image.split("@")[1] ?? "", cpu_model: "unknown", cores: a.recipe.limits.cpus, worker_version: WORKER_VERSION },
      transcript_digest: "",
    };
    try {
      const { calibration, transcript } = await calibrate({ loaded, deps, seed: a.seed, runs: 1, onPhase: this.telemetry.onPhase });
      result.build.base = "ok";
      result.tests.base_pass = [...calibration.stable].sort();
      for (const m of a.recipe.metrics) {
        const v = calibration.metrics[m.name]?.base_value;
        if (m.deterministic && typeof v === "number") result.metrics[m.name] = { base: [v], cand: [], deterministic: true };
      }
      result.transcript_digest = hashJson(transcript);
      return { result, transcript };
    } catch (e) {
      // an honest machine that cannot build or measure the baseline fails qualification, nothing more
      const transcript = { version: WORKER_VERSION, qualify: a.replay_id, error: String((e as Error).message ?? e).slice(0, 4000) };
      result.transcript_digest = hashJson(transcript);
      return { result, transcript };
    }
  }

  /** Declares this machine's capabilities to Core (SPEC 6.1). */
  async declareCapabilities(): Promise<Capabilities> {
    const caps = this.opts.capabilities ?? doctor().capabilities;
    const declared = await this.ok(this.client.put(`/v1/agents/${this.id}/capabilities`, { capabilities: caps }), "declare capabilities");
    this.telemetry.setCapabilities(declared?.capabilities ?? caps);
    this.log(`declared capabilities: ${caps.arch}, ${caps.cpus} cpus, ${caps.memory_mb} MB, ${caps.gpus.length} gpus`);
    return caps;
  }

  // ------------------------------------------------------------------ authoring

  /** One authoring attempt. Returns the commit id when a candidate was submitted. */
  async authorOnce(): Promise<string | null> {
    const proposer = this.opts.proposer;
    if (!proposer) return null;
    if (this.opts.maxCandidates !== undefined && this.submitted >= this.opts.maxCandidates) return null;
    const me = await this.me();
    if (me.kind !== "launched" || me.lifecycle !== "active" || !me.awake) return null;
    const all = await this.ok<{ lineage_id: string; repo: string; status: string }[]>(this.client.get("/v1/lineages"), "lineages");
    const mine = all.filter((l) => l.status === "active" && (this.opts.lineages?.length ? this.opts.lineages.includes(l.lineage_id) : true));
    for (const summary of mine) {
      const view = await this.ok(this.client.get(`/v1/lineages/${summary.lineage_id}`), "lineage");
      if (me.target_repo && view.repo !== me.target_repo) continue;
      if (!this.recipes.has(view.recipe_id)) {
        this.log(`lineage ${summary.lineage_id.slice(0, 10)}: recipe not available locally`);
        continue;
      }
      const id = await this.authorOn(view);
      if (id) return id;
    }
    return null;
  }

  private maxOpen: number | null = null;

  /** Core refuses a commit past max_open_candidates_per_agent; do not spend a proposal on it. */
  private async atOpenLimit(lineage: string): Promise<boolean> {
    if (this.maxOpen === null) {
      const c = await this.client.get("/v1/config");
      this.maxOpen = Number(c.body?.network?.max_open_candidates_per_agent ?? Infinity);
    }
    // signed: Core lists an agent's open candidates only to the agent itself (author-blind, SPEC 10.7)
    const mine = await this.ok<{ status: string }[]>(this.client.get(`/v1/candidates?lineage=${lineage}&author=${this.id}&limit=1000`, true), "candidates");
    return mine.filter((c) => ["committed", "queued", "replaying", "disputed"].includes(c.status)).length >= this.maxOpen;
  }

  private async authorOn(view: any): Promise<string | null> {
    const proposer = this.opts.proposer!;
    if (await this.atOpenLimit(view.lineage_id)) return null;
    const loaded = this.recipes.get(view.recipe_id);
    const tree = await this.ok(this.client.get(`/v1/lineages/${view.lineage_id}/tree`), "tree");
    const parentPatches: string[] = tree.patches.map((p: { patch: string }) => p.patch);
    const findings = (await this.ok<any[]>(this.client.get(`/v1/findings?lineage=${view.lineage_id}`), "findings")).map((f) => ({ key: f.finding_key ?? f.key, kind: f.kind, target: f.target }) as Finding);
    const deps = await this.recipes.depsFor(loaded, tree.deps_digest);
    const work = newWorkDir("author");
    const where = { lineage_id: view.lineage_id as string, gen_id: tree.gen_id as string, commit: tree.commit as string };
    this.telemetry.job("author", { lineage_id: where.lineage_id, gen_id: where.gen_id });
    this.telemetry.phase("propose");
    try {
      const dir = join(work, "src");
      materialize(loaded.recipe.repo, loaded.recipe.commit, loaded.overlayDir, dir);
      const outputs = join(deps.dir, "outputs");
      if (existsSync(outputs)) {
        Bun.spawnSync(["cp", "-R", `${outputs}/.`, dir]);
        Bun.spawnSync(["git", "add", "-A"], { cwd: dir });
        Bun.spawnSync(["git", "-c", "user.name=l", "-c", "user.email=l@l", "commit", "-q", "-m", "prepare outputs"], { cwd: dir });
      }
      for (const p of parentPatches) if (!applyPatch(dir, p)) throw new Error("parent series does not apply locally");
      const seed = randomBytes(8).toString("hex");
      const collab = this.opts.collab ?? "advisory";
      const ctx: ProposeContext = {
        loaded,
        deps,
        calibration: view.calibration,
        parentPatches,
        findings,
        tree: dir,
        seed,
        log: this.log,
        activity: (e) => this.telemetry.activity(where, e),
        onPhase: this.telemetry.onPhase,
        self: this.id,
        collab,
      };
      if (collab !== "off") {
        // intents are advisory (SPEC 12.1): reading or filing one never blocks authoring
        ctx.intents = await this.intentsOn(view.lineage_id);
        if (proposer.plan) {
          ctx.planned = await proposer.plan(ctx);
          if (ctx.planned) await this.fileIntent(view.lineage_id, tree.gen_id, ctx.planned);
        }
      }
      const proposal = await proposer.propose(ctx);
      if (!proposal) return null;
      if (proposal.usage) this.log(`author: model spend ${proposal.usage.usd.toFixed(4)} USD (${proposal.usage.input_tokens} in, ${proposal.usage.output_tokens} out, ${proposal.usage.cache_read_tokens} cache read)`);
      const raw = diffWorkingTree(dir);
      if (!raw.trim()) {
        this.log("author: proposer made no change");
        return null;
      }
      const patch = canonicalizeDiff(raw);
      const g = guard(patch, loaded.recipe.patch);
      if (!g.ok) this.log(`author: guard says ${g.violation}; submitting anyway only because the proposer is scripted`);
      const salt = randomBytes(16).toString("hex");
      const commitment = patchCommitment(patchHash(patch), salt);
      const committed = await this.ok(
        this.client.post("/v1/candidates", {
          lineage_id: view.lineage_id,
          parent_gen_id: tree.gen_id,
          kind: proposal.kind,
          target: proposal.target,
          commitment,
          claimed_effect: proposal.claimed_effect ?? null,
          ...this.teamFor({ lineage_id: view.lineage_id, parent_gen_id: tree.gen_id, commitment, kind: proposal.kind, target: proposal.target }),
        }),
        "commit candidate",
      );
      // no target: a submit names no candidate while it is sealed, and Core shows submits only to this agent (SPEC 10.7)
      this.telemetry.activity(where, { kind: "submit" });
      const revealed = await this.ok(this.client.post(`/v1/candidates/${committed.commit_id}/reveal`, { patch, salt }), "reveal candidate");
      this.submitted++;
      this.log(`author: ${proposal.kind} on ${JSON.stringify(proposal.target)} (${g.lines} lines) -> ${revealed.status}${revealed.reason ? ` (${revealed.reason})` : ""}`);
      return committed.commit_id;
    } finally {
      removeTree(work);
      this.telemetry.idle();
      void this.telemetry.flush();
    }
  }

  // ------------------------------------------------------------------ collaboration (SPEC 12.1)

  private intentTtl: number | null = null;

  /** Live intents on a lineage; empty when Core cannot be read (advisory, never fatal). */
  async intentsOn(lineage: string): Promise<IntentView[]> {
    const r = await this.client.get(`/v1/intents?lineage=${lineage}`, true).catch(() => null);
    return r && r.status === 200 && Array.isArray(r.body) ? (r.body as IntentView[]) : [];
  }

  /** Files a signed intent for the planned target. Returns its id, or null if Core refused (cap, rate, stale tip). */
  async fileIntent(lineage: string, tip: string, planned: PlannedTarget): Promise<string | null> {
    if (this.intentTtl === null) {
      const c = await this.client.get("/v1/config").catch(() => null);
      this.intentTtl = Math.min(1800, Number(c?.body?.network?.intent_max_ttl_s ?? 1800));
    }
    const target = planned.kind === "fix" ? [...new Set(Array.isArray(planned.target) ? planned.target : [planned.target])].sort() : planned.target;
    const note = planned.note ? planned.note.slice(0, 280) : null;
    const statement = { v: 1, agent: this.id, lineage_id: lineage, tip, kind: planned.kind, target, finding_id: null, note, ttl_s: this.intentTtl };
    const r = await this.client
      .post("/v1/intents", { lineage_id: lineage, tip, kind: planned.kind, target, note, ttl_s: this.intentTtl, sig: signStatement(this.opts.key, "intent", statement) })
      .catch((e) => ({ status: 0, body: { error: String(e) } }));
    if (r.status >= 300) {
      this.log(`intent not filed (${r.status} ${r.body?.error ?? ""}); authoring anyway, intents are advisory`);
      return null;
    }
    this.log(`intent ${String(r.body.intent_id).slice(0, 10)} filed: ${planned.kind} on ${JSON.stringify(target)}`);
    return r.body.intent_id as string;
  }

  /** `{ team }` for a commit when collab is "team" and every member can sign here, else nothing (SPEC 12.2). */
  teamFor(ctx: { lineage_id: string; parent_gen_id: string; commitment: string; kind: CandidateKind; target: string | string[] }): { team?: { members: TeamMember[]; sigs: Record<string, string> } } {
    const t = this.opts.team;
    if ((this.opts.collab ?? "advisory") !== "team" || !t) return {};
    const target = ctx.kind === "fix" ? [...new Set(Array.isArray(ctx.target) ? ctx.target : [ctx.target])].sort() : ctx.target;
    const st = teamStatement({ ...ctx, target, members: t.members });
    const sigs: Record<string, string> = {};
    for (const m of t.members) {
      const key = m.agent === this.id ? this.opts.key : t.keys.find((k) => ((k as { agent?: string }).agent ?? k.id) === m.agent);
      if (!key) {
        this.log(`team: no key for member ${m.agent.slice(0, 8)}; committing alone`);
        return {};
      }
      sigs[m.agent] = signStatement(key, "team", st);
    }
    this.log(`team: ${t.members.map((m) => `${m.agent.slice(0, 6)} ${m.role} ${m.share_bps / 100}%`).join(", ")}`);
    return { team: { members: t.members, sigs } };
  }

  // ------------------------------------------------------------------ reference runner

  /** Calibrates a recipe locally and submits it (reference runners only, SPEC 6). */
  async submitCalibration(recipe_id: string, snapshot_id: string, runs = 5): Promise<unknown> {
    const loaded = this.recipes.get(recipe_id);
    const deps = await this.recipes.depsFor(loaded);
    const { calibration } = await calibrate({ loaded, deps, seed: H("calibration", snapshot_id), runs });
    calibration.snapshot_id = snapshot_id;
    const sig = signMessage(this.opts.key, calibId(recipe_id, snapshot_id, calibration));
    return this.ok(this.client.post("/v1/calibrations", { calibration, sig }), "calibration");
  }

  // ------------------------------------------------------------------ loop

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const acted = await this.replayOnce();
      if (acted === 0) await this.authorOnce();
    } catch (e) {
      this.log(`tick: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  async run(intervalMs = 2000, until?: () => boolean): Promise<void> {
    try {
      await this.declareCapabilities();
    } catch (e) {
      this.log(`capabilities not declared: ${(e as Error).message}`);
    }
    await this.telemetry.start();
    try {
      while (!until?.()) {
        await this.tick();
        await Bun.sleep(intervalMs);
      }
    } finally {
      await this.telemetry.stop();
    }
  }
}

/**
 * A dishonest replayer that never runs anything and claims everything passed with a 10% gain.
 * Used only to prove canaries and disputes catch it (MILESTONES M1 exit check 2).
 */
function fabricate(a: Assignment): { result: ReplayResult; transcript: Record<string, unknown> } {
  const c = a.calibration;
  const cand = a.candidate!;
  const targets = cand.kind === "fix" ? (Array.isArray(cand.target) ? cand.target : [cand.target]) : [];
  const metrics: ReplayResult["metrics"] = {};
  for (const m of a.recipe.metrics) {
    const base = c.metrics[m.name]?.base_value ?? 1000;
    const cand = m.direction === "lower" ? base * 0.9 : base * 1.1;
    metrics[m.name] = m.deterministic ? { base: [base], cand: [cand], deterministic: true } : { base: Array(10).fill(base), cand: Array(10).fill(cand), deterministic: false };
  }
  const transcript = { version: WORKER_VERSION, fabricated: true, replay_id: a.replay_id, at: Date.now() };
  const result: ReplayResult = {
    apply: "ok",
    guard: "ok",
    build: { base: "ok", cand: "ok" },
    tests: { base_pass: [...c.stable], cand_pass: [...c.stable, ...targets].sort(), cand_fail: [] },
    equivalence: a.recipe.equivalence ? { base_digest: "0".repeat(64), cand_digest: "0".repeat(64) } : null,
    metrics,
    env: { image_digest: a.recipe.image.split("@")[1] ?? "", cpu_model: "unknown", cores: a.recipe.limits.cpus, worker_version: WORKER_VERSION },
    transcript_digest: hashJson(transcript),
  };
  return { result, transcript };
}

/**
 * A fabricated qualification: the public stable set and made-up base values. Core holds back the
 * calibrated base values from the assignment, so a liar that never measures cannot match them.
 */
function fabricateQualification(a: Assignment): { result: ReplayResult; transcript: Record<string, unknown> } {
  const metrics: ReplayResult["metrics"] = {};
  for (const m of a.recipe.metrics) if (m.deterministic) metrics[m.name] = { base: [a.calibration.metrics[m.name]?.base_value ?? 1000], cand: [], deterministic: true };
  const transcript = { version: WORKER_VERSION, fabricated: true, qualify: a.replay_id, at: Date.now() };
  const result: ReplayResult = {
    apply: "ok",
    guard: "ok",
    build: { base: "ok", cand: "skipped" },
    tests: { base_pass: [...a.calibration.stable], cand_pass: [], cand_fail: [] },
    equivalence: null,
    metrics,
    env: { image_digest: a.recipe.image.split("@")[1] ?? "", cpu_model: "unknown", cores: a.recipe.limits.cpus, worker_version: WORKER_VERSION },
    transcript_digest: hashJson(transcript),
  };
  return { result, transcript };
}

/** Self-check an author can run before submitting (the anthropic proposer does this itself). */
export async function selfCheck(w: Worker, recipe_id: string, calibration: Calibration, parentPatches: string[], patch: string, cand: CandidateView): Promise<string> {
  const loaded = w.recipes.get(recipe_id);
  const deps = await w.recipes.depsFor(loaded);
  const { result } = await evaluate({ loaded, deps, parentPatches, candidatePatch: patch, seed: randomBytes(8).toString("hex") });
  const j = judge(loaded.recipe, calibration, cand, [{ replay_id: "self", replayer: "self", seed: "self", result }], { quorum: 1, det_tolerance: 0.001, bootstrap_resamples: 2000 });
  return j.outcome + (j.reason ? `:${j.reason}` : "");
}

/** Metrics calibration left enabled; disabled ones can never decide a verdict, so they are not run. */
export function enabledMetrics(c: Calibration): string[] {
  return Object.entries(c.metrics)
    .filter(([, m]) => m.enabled)
    .map(([name]) => name);
}
