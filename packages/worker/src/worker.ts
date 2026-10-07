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
  type AgentKey,
  type Calibration,
  type CandidateKind,
  type CandidateView,
  type Recipe,
  type ReplayResult,
} from "@lineage/protocol";
import { applyPatch, calibrate, diffWorkingTree, evaluate, materialize, newWorkDir, removeTree, WORKER_VERSION, type Transcript } from "@lineage/sandbox";
import { CoreClient } from "../../core/src/client.ts";
import type { Finding, Proposer } from "./proposers/types.ts";
import { RecipeBook } from "./recipes.ts";

// The worker process: replays assignments first (they have deadlines), then authors when it has a
// proposer and its agent is an awake launched agent (SPEC 3, 5).

export type Dishonesty = "none" | "fabricate";

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
}

interface PendingReplay {
  result: ReplayResult;
  salt: string;
}

interface Assignment {
  replay_id: string;
  kind: "replay" | "audit" | "reference";
  status: "assigned" | "committed";
  reveal_open: boolean;
  seed: string;
  lineage: { lineage_id: string; repo: string; commit: string; snapshot_id: string; deps_digest: string };
  recipe_id: string;
  recipe: Recipe;
  calibration: Calibration;
  parent_gen_id: string;
  parent_series: { gen_id: string; patch: string }[];
  candidate: { candidate_id: string; kind: CandidateKind; target: string | string[]; patch: string; patch_hash: string };
}

class ApiFailure extends Error {
  constructor(public status: number, public body: unknown, what: string) {
    super(`${what}: HTTP ${status} ${JSON.stringify(body).slice(0, 300)}`);
  }
}

export class Worker {
  readonly client: CoreClient;
  readonly recipes = new RecipeBook();
  private log: (m: string) => void;
  private pending = new Map<string, PendingReplay>();
  private stateFile: string;
  private submitted = 0;
  private busy = false;

  constructor(private opts: WorkerOptions) {
    this.client = new CoreClient(opts.core, opts.key);
    const tag = opts.key.id.slice(0, 6);
    this.log = opts.log ?? ((m) => console.log(`[${new Date().toISOString().slice(11, 19)} ${tag}] ${m}`));
    const dir = opts.stateDir ?? join(process.env.LINEAGE_HOME ?? join(homedir(), ".lineage"), "worker", opts.key.id);
    mkdirSync(dir, { recursive: true });
    this.stateFile = join(dir, "pending.json");
    if (existsSync(this.stateFile)) {
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(this.stateFile, "utf8")) as Record<string, PendingReplay>)) this.pending.set(k, v);
    }
  }

  get id(): string {
    return this.opts.key.id;
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
          const r = await this.ok(this.client.post(`/v1/replays/${a.replay_id}/reveal`, { result: p.result, salt: p.salt }), "reveal");
          this.pending.delete(a.replay_id);
          this.persist();
          this.log(`replay ${a.replay_id.slice(0, 10)}: revealed (${(r as { status: string }).status})`);
          acted++;
        }
      } catch (e) {
        this.log(`replay ${a.replay_id.slice(0, 10)}: ${(e as Error).message}`);
      }
    }
    return acted;
  }

  private async runAndCommit(a: Assignment): Promise<void> {
    const t0 = Date.now();
    const loaded = this.recipes.get(a.recipe_id);
    let result: ReplayResult;
    let transcript: Transcript | Record<string, unknown>;
    if (this.opts.dishonest === "fabricate") {
      ({ result, transcript } = fabricate(a));
    } else {
      const deps = await this.recipes.depsFor(loaded, a.lineage.deps_digest);
      ({ result, transcript } = await evaluate({ loaded, deps, parentPatches: a.parent_series.map((p) => p.patch), candidatePatch: a.candidate.patch, seed: a.seed }));
    }
    const bytes = canonicalJson(transcript);
    if (hashJson(transcript) !== result.transcript_digest) result.transcript_digest = hashJson(transcript);
    await this.ok(this.client.putBlob(result.transcript_digest, new TextEncoder().encode(bytes)), "transcript upload");
    const salt = randomBytes(16).toString("hex");
    this.pending.set(a.replay_id, { result, salt });
    this.persist();
    await this.ok(this.client.post(`/v1/replays/${a.replay_id}/commit`, { commitment: resultCommitment(result, salt) }), "commit");
    const summary = result.guard !== "ok" ? result.guard : result.apply !== "ok" ? "conflict" : `build ${result.build.cand}, ${result.tests.cand_pass.length} tests pass`;
    this.log(`replay ${a.replay_id.slice(0, 10)} (${a.kind}) of ${a.candidate.candidate_id.slice(0, 10)}: ${summary}, committed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
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

  private async authorOn(view: any): Promise<string | null> {
    const proposer = this.opts.proposer!;
    const loaded = this.recipes.get(view.recipe_id);
    const tree = await this.ok(this.client.get(`/v1/lineages/${view.lineage_id}/tree`), "tree");
    const parentPatches: string[] = tree.patches.map((p: { patch: string }) => p.patch);
    const findings = (await this.ok<any[]>(this.client.get(`/v1/findings?lineage=${view.lineage_id}`), "findings")).map((f) => ({ key: f.finding_key ?? f.key, kind: f.kind, target: f.target }) as Finding);
    const deps = await this.recipes.depsFor(loaded, tree.deps_digest);
    const work = newWorkDir("author");
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
      const proposal = await proposer.propose({ loaded, deps, calibration: view.calibration, parentPatches, findings, tree: dir, seed, log: this.log });
      if (!proposal) return null;
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
        }),
        "commit candidate",
      );
      const revealed = await this.ok(this.client.post(`/v1/candidates/${committed.commit_id}/reveal`, { patch, salt }), "reveal candidate");
      this.submitted++;
      this.log(`author: ${proposal.kind} on ${JSON.stringify(proposal.target)} (${g.lines} lines) -> ${revealed.status}${revealed.reason ? ` (${revealed.reason})` : ""}`);
      return committed.commit_id;
    } finally {
      removeTree(work);
    }
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
    while (!until?.()) {
      await this.tick();
      await Bun.sleep(intervalMs);
    }
  }
}

/**
 * A dishonest replayer that never runs anything and claims everything passed with a 10% gain.
 * Used only to prove canaries and disputes catch it (MILESTONES M1 exit check 2).
 */
function fabricate(a: Assignment): { result: ReplayResult; transcript: Record<string, unknown> } {
  const c = a.calibration;
  const targets = a.candidate.kind === "fix" ? (Array.isArray(a.candidate.target) ? a.candidate.target : [a.candidate.target]) : [];
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

/** Self-check an author can run before submitting (the anthropic proposer does this itself). */
export async function selfCheck(w: Worker, recipe_id: string, calibration: Calibration, parentPatches: string[], patch: string, cand: CandidateView): Promise<string> {
  const loaded = w.recipes.get(recipe_id);
  const deps = await w.recipes.depsFor(loaded);
  const { result } = await evaluate({ loaded, deps, parentPatches, candidatePatch: patch, seed: randomBytes(8).toString("hex") });
  const j = judge(loaded.recipe, calibration, cand, [{ replay_id: "self", replayer: "self", seed: "self", result }], { quorum: 1, det_tolerance: 0.001, bootstrap_resamples: 2000 });
  return j.outcome + (j.reason ? `:${j.reason}` : "");
}
