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
  splitReportCommitment,
  type SplitReport,
  type AgentKey,
  type Calibration,
  type Capabilities,
  type CandidateKind,
  type CandidateView,
  type GuardRule,
  type Recipe,
  type ReplayResult,
} from "@units/protocol";
import { applyPatch, calibrate, diffWorkingTree, evaluate, materialize, newWorkDir, removeTree, SandboxUnavailable, WORKER_VERSION, type Transcript } from "@units/sandbox";
import { CoreClient } from "../../core/src/client.ts";
import { teamStatement, type TeamMember } from "../../core/src/collab.ts";
import { encryptionKeyStatement, intentNote, messageEnvelope } from "../../core/src/messages.ts";
import { deriveEncryptionKey, open, seal, type EncryptionKey } from "../../core/src/seal.ts";
import type { Messenger } from "../../core/src/msgchain.ts";
import type { BoardNote, Finding, InboxMessage, IntentView, PlannedTarget, ProposeContext, Proposer } from "./proposers/types.ts";
import { targetKey } from "./proposers/types.ts";
import { doctor } from "./doctor.ts";
import { RecipeBook } from "./recipes.ts";
import { proposerSoulBlock, type SoulDoc } from "@units/souls";
import { Telemetry } from "./telemetry.ts";
import { guardOutcome, guardRuleReader } from "./guard-limits.ts";
import { checkEntry, FactsLog, journalPrompt, JOURNAL_RESERVE_USD, notesBlock, readNotes, storeEntry } from "./journal.ts";
import { plannedKey, readShared, sharedBlock, type SharedData } from "./shared-findings.ts";
import { pickTarget, rankUnits, type UnitInput } from "./target-spread.ts";
import { rankTargets, seatLine, type SeatHooks, type SeatPlacement, type SeatStack, type SeatUnitInput } from "./seat.ts";
import { writeSecret } from "./secret-file.ts";
import { SessionRecorder } from "./session.ts";
import { EpisodeCapture } from "./episode.ts";
import type { DesktopAttempt, DesktopProvider } from "../../desktop/src/pool.ts";
import { measureCoalitions, type SplitAssignment } from "./split.ts";
import { DiscoveryAgent } from "./discovery.ts";
import { CalibrationVerifier, ensureRecipe } from "./recipe-proposer.ts";

// The worker process: replays assignments first (they have deadlines), then authors when it has a
// proposer and its agent is an awake launched agent (SPEC 3, 5).

/**
 * Test-only dishonest modes. `fabricate` never runs anything, qualification included (so it never
 * qualifies); `fabricate-after-qualify` qualifies honestly, then fabricates every replay.
 */
export type Dishonesty = "none" | "fabricate" | "fabricate-after-qualify";

/**
 * How long a target-spread intent lives (seconds). About two attempts: long enough that agents
 * starting in the same minutes see each other, short enough to stay under Core's three live
 * intents per agent at one attempt every few minutes.
 */
export const SPREAD_INTENT_TTL_S = 600;

export interface WorkerOptions {
  core: string;
  key: AgentKey;
  /**
   * Replays this verifier runs at once (scale-out lane, docs/plans/SCALE-OUT.md): default the environment's
   * UNITS_REPLAY_SLOTS, else 1. Core hands a verifier at most max_open_replays, and the host's
   * UNITS_SANDBOX_SLOTS still bounds the containers.
   */
  replaySlots?: number;
  proposer?: Proposer;
  /** lineages this worker authors on; empty means every lineage of its target repo */
  lineages?: string[];
  dishonest?: Dishonesty;
  log?: (msg: string) => void;
  stateDir?: string;
  /** stop authoring after this many submitted candidates (e2e) */
  maxCandidates?: number;
  /**
   * Hosted runtime (packages/runtime): called before each authoring attempt for the attempt's spend
   * cap and meter; returning null skips the attempt (budget exhausted).
   */
  attempt?: () => Pick<ProposeContext, "maxUsd" | "meter"> | null;
  /**
   * Agent desktops (SPEC 17.7, packages/desktop): a live desktop for an attempt when a slot is free
   * (null keeps the reconstructed panel). It shows every tool call on a real desktop; it never
   * changes what the proposer sees or does.
   */
  desktop?: DesktopProvider;
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
  /**
   * Stacked series (SPEC 12.4): author the next candidate on top of this agent's own newest
   * revealed, still pending candidate (committed with `depends_on`, held until that one is final)
   * instead of waiting for its verdict. Default off.
   */
  series?: boolean;
  /**
   * Soul (SPEC 14.8): the block added to the proposer's system prompt. Default: the agent's current
   * public soul from Core (`GET /v1/agents/:id/soul`), read before each attempt; `false` disables it;
   * a function supplies it. The soul changes taste and voice, never the acceptance rules.
   */
  soul?: false | (() => Promise<string | null> | string | null);
  /**
   * Agent journal (SPEC 17.6): before each attempt read the agent's own recent notes into the
   * proposer's context, and after it write one signed entry in the soul's voice (a small model call
   * inside the attempt's cap). The hosted runtime turns it on; self-hosted workers opt in.
   */
  journal?: boolean;
  /** USD of an attempt's cap kept back for the journal call (default JOURNAL_RESERVE_USD). */
  journalReserveUsd?: number;
  /**
   * Shared findings (docs/plans/AGENT-LEARNINGS.md 12.4): before each attempt read every listed agent's
   * published outcomes on the unit from Core into a short labelled block after the agent's own notes.
   * Default: on with the journal (the hosted runtime); `false` turns it off; `{ max_tokens }` sets the cap.
   */
  sharedFindings?: boolean | { max_tokens?: number };
  /**
   * Target spread (docs/plans/AGENT-EFFICIENCY.md section 5): for a model proposer without a plan step,
   * pick one of the unit's enabled metric targets from counts (other agents' open intents, this
   * agent's own fruitless attempts on the tip, candidates that failed on the tip), tell the model,
   * and file an advisory intent for it. Off by default; needs collab other than "off".
   * With several active units of the agent's repository it also chooses the unit for each attempt from
   * the same kind of counts (target-spread.ts rankUnits), one attempt per authoring step.
   */
  spread?: boolean;
  /**
   * How long a target-spread intent lives, in seconds (default SPREAD_INTENT_TTL_S; Core caps it at
   * intent_max_ttl_s). It should cover the time from an attempt's start to its candidate's verdict:
   * on the site of 2026-10-12 that took 16 to 81 minutes while intents lived 10, so three agents
   * filed candidates on one target without seeing each other.
   */
  spreadIntentTtlS?: number;
  /**
   * Onchain messages (SPEC 12.5): when set, encryption keys and messages go through this transport
   * (units_msg; packages/core msgchain.ts ChainMessenger) instead of POST /v1/messages. Reading
   * stays on Core's board and inbox views, which index the chain.
   */
  messenger?: Messenger;
  /**
   * Swarms (docs/plans/SWARMS.md; seat.ts): this worker is one seat of a swarm. The hosted runtime's
   * ledger assigns its unit and target, its commits are serialized per unit and stacked on the
   * swarm's open candidates there, and its requests carry the seat number. Absent: a solo agent.
   */
  seat?: SeatHooks;
}

interface PendingReplay {
  result: ReplayResult;
  salt: string;
  /** measured split report (SPEC 12.6), revealed with the result */
  split?: SplitReport;
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
  /** a team candidate's sub-patches to measure by coalition (SPEC 12.6); null otherwise */
  split?: SplitAssignment | null;
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
  /**
   * Set on stop (SIGTERM, before the loop ends): no new assignment, profile, calibration or authoring
   * step starts, even inside the tick that is running; committed replays are still revealed. It used to
   * be set only once the loop had returned, so a tick running at SIGTERM went on to start the next
   * assigned replay (site incident 2026-10-10: lineage-verifier@v2 revealed at 19:44:41, then kept
   * working until its 45 min stop timeout).
   */
  draining = false;
  private stateFile: string;
  private submitted = 0;
  /** target spread: this agent's attempts without a candidate on a unit's current tip, by target */
  private fruitless = new Map<string, { tip: string; counts: Map<string, number> }>();
  /** whether the last authorOn call got as far as the proposer (an attempt ran) */
  private attempted = false;
  private busy = false;
  /** Reveals in flight, shared by the main loop and the reveal timer so neither sends one twice. */
  private revealing = new Set<string>();
  /** Replays running in the background, by replay id (only with replaySlots > 1). */
  private inflight = new Map<string, Promise<void>>();
  /** Replays at once: WorkerOptions.replaySlots, else UNITS_REPLAY_SLOTS, else 1 (one at a time, as before). */
  private get replaySlots(): number {
    const n = this.opts.replaySlots ?? Number(process.env.UNITS_REPLAY_SLOTS);
    return Number.isInteger(n) && n >= 1 && n <= 64 ? n : 1;
  }
  /** Patches this worker revealed, by commit id: what a stacked candidate builds on (SPEC 12.4). */
  private soulDoc: SoulDoc | null = null;
  private mine = new Map<string, { lineage_id: string; patch: string; at: number }>();
  /** Profile replays of hotspot claims (SPEC 12.8) and calibration replays of proposed recipes (SPEC 6.2). */
  private profiles: DiscoveryAgent;
  private calibrations: CalibrationVerifier;
  private sideErrors = new Set<string>();

  constructor(private opts: WorkerOptions) {
    this.client = new CoreClient(opts.core, opts.key);
    if (opts.seat) this.client.seat = opts.seat.seat; // Core keeps a seat's own heartbeat and session rows (swarms.ts)
    // a rotated agent signs with a new key under its unchanged agent id (identity plan I1)
    const agentId = (opts.key as { agent?: string }).agent ?? opts.key.id;
    const tag = agentId.slice(0, 6);
    this.log = opts.log ?? ((m) => console.log(`[${new Date().toISOString().slice(11, 19)} ${tag}] ${m}`));
    const dir = opts.stateDir ?? join((process.env.UNITS_HOME ?? process.env.LINEAGE_HOME) ?? join(homedir(), ".lineage"), "worker", agentId);
    mkdirSync(dir, { recursive: true });
    this.stateFile = join(dir, "pending.json");
    this.telemetry = new Telemetry(this.client, this.log, { enabled: opts.telemetry !== false });
    this.profiles = new DiscoveryAgent(opts.core, opts.key, this.recipes, this.log);
    this.calibrations = new CalibrationVerifier(opts.core, opts.key, this.log);
    // a stopping worker takes no new side work either (only finishes what it runs and reveals)
    this.profiles.stopping = () => this.draining;
    this.calibrations.stopping = () => this.draining;
    if (existsSync(this.stateFile)) {
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(this.stateFile, "utf8")) as Record<string, PendingReplay>)) this.pending.set(k, v);
    }
  }

  get id(): string {
    return (this.opts.key as { agent?: string }).agent ?? this.opts.key.id;
  }

  private persist(): void {
    writeSecret(this.stateFile, JSON.stringify(Object.fromEntries(this.pending)));
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
    // Core lists every open (assigned or committed) replay of ours; a local result for anything
    // else was cancelled, expired or abandoned there and can never be revealed, so drop it
    // (otherwise drain() waits its full timeout on every stop)
    const open = new Set(list.map((a) => a.replay_id));
    const stale = [...this.pending.keys()].filter((id) => !open.has(id));
    if (stale.length) {
      for (const id of stale) this.pending.delete(id);
      this.persist();
      this.log(`dropped ${stale.length} local result(s) Core no longer lists as open`);
    }
    for (const a of list) {
      try {
        if (a.status === "assigned") {
          if (this.draining) continue; // stopping: take no new work, only finish what is committed
          if (this.replaySlots > 1) {
            // scale-out lane: up to replaySlots replays at once, each in the background; the loop goes on
            // to the next assignment and the next tick fills a slot as soon as one is free
            if (this.inflight.has(a.replay_id) || this.inflight.size >= this.replaySlots) continue;
            const run = this.runAndCommit(a)
              .catch((e) => this.log(`replay ${a.replay_id.slice(0, 10)}: ${(e as Error).message}`))
              .finally(() => this.inflight.delete(a.replay_id));
            this.inflight.set(a.replay_id, run);
            acted++;
            continue;
          }
          await this.runAndCommit(a);
          acted++;
        } else if (a.status === "committed" && a.reveal_open) {
          if (await this.reveal(a)) acted++;
        }
      } catch (e) {
        this.log(`replay ${a.replay_id.slice(0, 10)}: ${(e as Error).message}`);
      } finally {
        if (this.inflight.size === 0) this.telemetry.idle();
      }
    }
    return acted;
  }

  /** Reveals one committed replay whose reveal window is open; false when there is nothing to send. */
  private async reveal(a: Assignment): Promise<boolean> {
    const p = this.pending.get(a.replay_id);
    if (!p) {
      if (!this.revealing.has(a.replay_id)) this.log(`replay ${a.replay_id.slice(0, 10)}: committed but local result lost; cannot reveal`);
      return false;
    }
    if (this.revealing.has(a.replay_id)) return false;
    this.revealing.add(a.replay_id);
    try {
      const r = await this.ok(this.client.post(`/v1/replays/${a.replay_id}/reveal`, { result: p.result, salt: p.salt, ...(p.split ? { split: p.split } : {}) }), "reveal");
      this.pending.delete(a.replay_id);
      this.persist();
      this.log(`replay ${a.replay_id.slice(0, 10)}: revealed (${(r as { status: string }).status})`);
      return true;
    } finally {
      this.revealing.delete(a.replay_id);
    }
  }

  /**
   * Reveals only. Runs on its own timer next to the main loop: a worker busy with a long replay or
   * qualification (minutes) must still reveal inside reveal_window_s, or it takes an unrevealed strike.
   */
  async revealOnce(): Promise<number> {
    if (this.pending.size === 0) return 0;
    const list = await this.ok<Assignment[]>(this.client.get("/v1/assignments", true), "assignments");
    let acted = 0;
    for (const a of list) {
      if (a.status !== "committed" || !a.reveal_open) continue;
      try {
        if (await this.reveal(a)) acted++;
      } catch (e) {
        this.log(`replay ${a.replay_id.slice(0, 10)}: ${(e as Error).message}`);
      }
    }
    return acted;
  }

  private async runAndCommit(a: Assignment): Promise<void> {
    const t0 = Date.now();
    this.telemetry.job(a.kind === "qualify" || !a.candidate ? "qualify" : "replay", { replay_id: a.replay_id });
    // a unit admitted from a recipe proposal (SPEC 6.2): its recipe comes from Core, checked against the id
    await ensureRecipe(this.recipes, this.client, a.recipe_id).catch(() => false);
    const loaded = this.recipes.get(a.recipe_id);
    let result: ReplayResult;
    let transcript: Transcript | Record<string, unknown>;
    let split: SplitReport | undefined;
    if (a.kind === "qualify" || !a.candidate) {
      if (this.opts.dishonest === "fabricate") ({ result, transcript } = fabricateQualification(a));
      else ({ result, transcript } = await this.qualifyRun(a));
    } else if (this.opts.dishonest === "fabricate" || this.opts.dishonest === "fabricate-after-qualify") {
      ({ result, transcript } = fabricate(a));
    } else {
      const deps = await this.recipes.depsFor(loaded, a.lineage.deps_digest);
      ({ result, transcript } = await evaluate({ loaded, deps, parentPatches: a.parent_series.map((p) => p.patch), candidatePatch: a.candidate!.patch, seed: a.seed, onPhase: this.telemetry.onPhase, enabledMetrics: enabledMetrics(a.calibration) }));
      if (a.split) {
        const parentPatches = a.parent_series.map((p) => p.patch);
        split = await measureCoalitions({ loaded, deps, parentPatches, candidatePatch: a.candidate!.patch, split: a.split, seed: a.seed, main: result, mainSeconds: (Date.now() - t0) / 1000, onPhase: this.telemetry.onPhase, log: this.log });
        this.log(`replay ${a.replay_id.slice(0, 10)}: split compose ${split.compose}, ${Object.keys(split.subsets).length} coalitions${split.cost ? `, ${split.cost.subsets_s}s extra vs ${split.cost.main_s}s main` : ""}`);
      }
    }
    this.telemetry.phase("commit");
    const bytes = canonicalJson(transcript);
    if (hashJson(transcript) !== result.transcript_digest) result.transcript_digest = hashJson(transcript);
    await this.ok(this.client.putBlob(result.transcript_digest, new TextEncoder().encode(bytes)), "transcript upload");
    const salt = randomBytes(16).toString("hex");
    this.pending.set(a.replay_id, { result, salt, ...(split ? { split } : {}) });
    this.persist();
    await this.ok(this.client.post(`/v1/replays/${a.replay_id}/commit`, { commitment: resultCommitment(result, salt), ...(split ? { split_commitment: splitReportCommitment(split, salt) } : {}) }), "commit");
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
      // a machine whose sandbox cannot start has measured nothing: an error to retry, never a result
      if (e instanceof SandboxUnavailable) throw e;
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
    // a proposer that can never propose again starts nothing: no tree, no session (an exhausted script)
    if (proposer.exhausted?.()) return null;
    const me = await this.me();
    // an asleep agent authors only while Core says the network pays for its compute (compute_covered)
    if (me.kind !== "launched" || me.lifecycle !== "active" || !(me.awake || me.compute_covered === true)) return null;
    const all = await this.ok<{ lineage_id: string; repo: string; status: string }[]>(this.client.get("/v1/lineages"), "lineages");
    const mine = all.filter((l) => l.status === "active" && (this.opts.lineages?.length ? this.opts.lineages.includes(l.lineage_id) : true));
    const units: any[] = [];
    for (const summary of mine) {
      // the list carries each unit's repository: a unit of another repository is not read at all
      if (me.target_repo && summary.repo && summary.repo !== me.target_repo) continue;
      const view = await this.ok(this.client.get(`/v1/lineages/${summary.lineage_id}`), "lineage");
      if (me.target_repo && view.repo !== me.target_repo) continue;
      // a unit admitted from a recipe proposal (SPEC 6.2) is in no release: its recipe is read from Core
      if (!(await ensureRecipe(this.recipes, this.client, view.recipe_id).catch(() => false))) {
        this.log(`lineage ${summary.lineage_id.slice(0, 10)}: recipe not available locally`);
        continue;
      }
      units.push(view);
    }
    // unit choice (recipes headroom lane): with target spread on, a model agent whose repository has
    // several active units takes them in the order of rankUnits and makes one attempt per step, so the
    // next step ranks again with the new counts. Otherwise (scripted, spread off) every unit in Core's
    // order until one yields a candidate, as before.
    // a swarm's seat: the unit and target come from the swarm's ledger, never from this worker's own pick
    if (this.opts.seat) return this.authorAsSeat(this.opts.seat, units);
    const choose = this.opts.spread === true && proposer.name !== "scripted" && (this.opts.collab ?? "advisory") !== "off";
    const order = choose && units.length > 1 ? await this.unitOrder(units) : units;
    for (const view of order) {
      this.attempted = false;
      const id = await this.authorOn(view);
      if (id) return id;
      if (choose && this.attempted) return null;
    }
    return null;
  }

  /** The agent's units in the order to try them (target-spread.ts rankUnits); Core's order when the counts cannot be read. */
  private async unitOrder(units: any[]): Promise<any[]> {
    try {
      const inputs: UnitInput[] = [];
      for (const view of units) {
        const loaded = this.recipes.get(view.recipe_id);
        const [intents, shared] = await Promise.all([this.intentsOn(view.lineage_id), readShared(this.client, view.lineage_id).catch(() => null)]);
        const mem = this.fruitless.get(view.lineage_id);
        const tip = shared?.tip?.gen_id ?? null;
        const own = mem && (tip === null || mem.tip === tip) ? [...mem.counts.values()].reduce((a, n) => a + n, 0) : 0;
        inputs.push({
          unit: view.lineage_id,
          targets: loaded.recipe.metrics.filter((m) => view.calibration?.metrics?.[m.name]?.enabled).map((m) => ({ kind: m.kind as CandidateKind, name: m.name })),
          intents,
          shared,
          ownFruitless: own,
        });
      }
      const ranked = rankUnits(this.id, inputs);
      const first = ranked[0]!;
      this.log(`unit choice: ${first.unit.slice(0, 10)} of ${ranked.length} units of this repository (${first.free_targets} of ${first.targets} targets without another agent, ${first.own_fruitless} own fruitless on its tip, ${first.misses} published misses on it)`);
      return ranked.map((r) => units.find((u) => u.lineage_id === r.unit)!);
    } catch (e) {
      this.log(`unit choice: counts not read (${(e as Error).message.slice(0, 120)}); Core's order`);
      return units;
    }
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
    return mine.filter((c) => ["committed", "waiting", "queued", "replaying", "disputed"].includes(c.status)).length >= this.maxOpen;
  }

  /** The proposer's soul block (SPEC 14.8); never blocks authoring. */
  private async soulBlock(): Promise<string | null> {
    if (this.opts.soul === false) return null;
    try {
      if (typeof this.opts.soul === "function") return (await this.opts.soul()) ?? null;
      const r = await this.client.get(`/v1/agents/${this.id}/soul`);
      this.soulDoc = r.status === 200 && r.body?.doc ? (r.body.doc as SoulDoc) : null;
      return this.soulDoc ? proposerSoulBlock(this.soulDoc) : null;
    } catch {
      return null;
    }
  }

  /**
   * One attempt as a seat of a swarm (seat.ts): the repository's units with their targets in target
   * spread's order and the swarm's open candidates on each go to the ledger, which answers with this
   * seat's unit, target and stack, or with why it waits (then nothing is spent).
   */
  private async authorAsSeat(seat: SeatHooks, units: any[]): Promise<string | null> {
    const ordered = units.length > 1 ? await this.unitOrder(units) : units;
    const inputs: SeatUnitInput[] = [];
    for (const view of ordered) {
      const loaded = this.recipes.get(view.recipe_id);
      const [intents, shared] = await Promise.all([this.intentsOn(view.lineage_id), readShared(this.client, view.lineage_id).catch(() => null)]);
      const mem = this.fruitless.get(view.lineage_id);
      const targets = rankTargets({
        targets: loaded.recipe.metrics.filter((m) => view.calibration?.metrics?.[m.name]?.enabled).map((m) => ({ kind: m.kind as CandidateKind, name: m.name })),
        intents,
        self: this.id,
        tip: view.tip,
        shared,
        fruitless: mem && mem.tip === view.tip ? mem.counts : undefined,
      });
      const read_at = Date.now();
      inputs.push({ unit: view.lineage_id, tip: view.tip, targets, open: await this.openCommits(view.lineage_id), read_at });
    }
    if (this.maxOpen === null) {
      const c = await this.client.get("/v1/config");
      this.maxOpen = Number(c.body?.network?.max_open_candidates_per_agent ?? Infinity);
    }
    const r = seat.place(inputs, this.maxOpen);
    if (!r.ok) {
      if (this.seatWhy !== r.why) this.log(`seat ${seat.seat}: no attempt (${r.why})`);
      this.seatWhy = r.why;
      return null;
    }
    this.seatWhy = null;
    const view = ordered.find((u) => u.lineage_id === r.p.unit)!;
    const t = inputs.find((u) => u.unit === r.p.unit)!.targets.find((x) => x.kind === r.p.planned.kind && x.name === r.p.planned.target);
    this.log(`seat ${seat.seat} (${seat.role}): unit ${r.p.unit.slice(0, 10)}, target ${r.p.planned.kind} ${JSON.stringify(r.p.planned.target)}${r.p.stack ? `, on ${r.p.stack.patches.length} open change(s) of the swarm` : ""}`);
    let commit: string | null = null;
    try {
      commit = await this.authorOn(view, { p: r.p, facts: t?.facts ?? null });
      return commit;
    } finally {
      seat.ended(commit);
    }
  }
  private seatWhy: string | null = null;

  /** Commit ids of this agent's open candidates on a unit, as Core lists them to the agent itself. */
  private async openCommits(lineage: string): Promise<string[]> {
    const mine = await this.ok<{ commit_id: string; status: string }[]>(this.client.get(`/v1/candidates?lineage=${lineage}&author=${this.id}&limit=1000`, true), "candidates");
    return mine.filter((c) => ["committed", "waiting", "queued", "replaying", "disputed"].includes(c.status)).map((c) => c.commit_id);
  }

  private async authorOn(view: any, seated?: { p: SeatPlacement; facts: string | null }): Promise<string | null> {
    const proposer = this.opts.proposer!;
    const sp = seated?.p ?? null;
    if (await this.atOpenLimit(view.lineage_id)) return null;
    const budget = this.opts.attempt ? this.opts.attempt() : {};
    if (budget === null) return null;
    const loaded = this.recipes.get(view.recipe_id);
    const tree = await this.ok(this.client.get(`/v1/lineages/${view.lineage_id}/tree`), "tree");
    const parentPatches: string[] = tree.patches.map((p: { patch: string }) => p.patch);
    // a stacked candidate builds on this agent's own pending patch (SPEC 12.4)
    let stack = !sp && this.opts.series ? await this.stackTarget(view.lineage_id) : null;
    // a seat builds on the swarm's open candidates on the unit (one stack per unit, from the ledger)
    const seatStack: SeatStack | null = sp?.stack ?? null;
    const findings = (await this.ok<any[]>(this.client.get(`/v1/findings?lineage=${view.lineage_id}`), "findings")).map((f) => ({ key: f.finding_key ?? f.key, kind: f.kind, target: f.target }) as Finding);
    const deps = await this.recipes.depsFor(loaded, tree.deps_digest);
    const work = newWorkDir("author");
    const where = { lineage_id: view.lineage_id as string, gen_id: tree.gen_id as string, commit: tree.commit as string };
    this.telemetry.job("author", { lineage_id: where.lineage_id, gen_id: where.gen_id });
    this.telemetry.phase("propose");
    // authoring session (SPEC 17.3): every tool call, sealed contents included; best effort
    const session = new SessionRecorder(this.client, this.log, { enabled: this.opts.telemetry !== false });
    await session.start(where, proposer.name);
    let sessionCommit: string | null = null;
    // agent journal (SPEC 17.6): the session's own facts, and the context for the entry at the end
    const journal = this.opts.journal === true && this.opts.telemetry !== false;
    const facts = journal ? new FactsLog() : null;
    // agent learnings (docs/plans/AGENT-LEARNINGS.md 1.1): what only the worker sees, reported after the end
    const episode = new EpisodeCapture();
    // the proposer's stop note (why its model loop ended, model calls) rides on the episode's outcome
    // line: the Analytics page counts "cap reached" attempts and turns per attempt from it (core
    // analytics.ts STOP_NOTE)
    const outcome = (s: string) => {
      facts?.outcome(s);
      episode.outcome(s);
      if (jctx?.stop) episode.stop(jctx.stop);
    };
    let jctx: ProposeContext | null = null;
    let desk: DesktopAttempt | null = null;
    try {
      const dir = join(work, "src");
      materialize(loaded.recipe.repo, loaded.recipe.commit, loaded.overlayDir, dir);
      const outputs = join(deps.dir, "outputs");
      if (existsSync(outputs)) {
        Bun.spawnSync(["cp", "-R", `${outputs}/.`, dir]);
        Bun.spawnSync(["git", "add", "-A"], { cwd: dir });
        Bun.spawnSync(["git", "-c", "user.name=l", "-c", "user.email=l@l", "commit", "-q", "-m", "prepare outputs"], { cwd: dir });
      }
      // the repository as the recipe pins it, before any generation's patch: a seat's change is re-based from here (below)
      const rootRef = sp ? Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dir }).stdout.toString().trim() : "";
      for (const p of parentPatches) if (!applyPatch(dir, p)) throw new Error("parent series does not apply locally");
      // the pending candidate no longer applies to the tip (another generation landed on the lines it
      // edits, so it is stale itself): author on the tip instead of failing the attempt (agent efficiency lane;
      // on the site this failed attempts in a row and backed agents off for up to 8 minutes)
      if (stack && !applyPatch(dir, stack.patch)) {
        this.log(`series: pending ${stack.commit_id.slice(0, 10)} does not apply to the tip; authoring on the tip`);
        stack = null;
      }
      if (stack) {
        parentPatches.push(stack.patch);
        this.log(`series: authoring on top of pending ${stack.commit_id.slice(0, 10)}`);
      }
      if (seatStack) {
        // an open change of the swarm that no longer applies to the tip is going stale itself: no attempt on top of it
        for (const p of seatStack.patches) {
          if (applyPatch(dir, p)) continue;
          this.log("seat: the swarm's open changes on this unit do not apply to its tip; no attempt until they are final");
          return null;
        }
        parentPatches.push(...seatStack.patches);
      }
      if (this.opts.desktop && this.opts.telemetry !== false) {
        desk = await this.opts.desktop
          .begin({ agent: this.opts.seat?.desktopKey ?? this.id, tree: dir, repo: loaded.recipe.repo, commit: where.commit, stacked: !!stack, label: `${this.id.slice(0, 8)}-${where.lineage_id.slice(0, 8)}` })
          .catch((e) => (this.log(`desktop: ${(e as Error).message}`), null));
        // desktop hosts lane: a required desktop that did not start ends the attempt before the model runs
        if (!desk && this.opts.desktop.required) {
          this.log("desktop: none started; attempt not run (desktops are required)");
          return null;
        }
        if (desk) {
          session.setDesktop(true);
          const d = desk;
          session.onOpen = (id) => d.sessionOpened(id);
        }
      }
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
        session: (e) => {
          session.push(e);
          facts?.push(e);
          desk?.event(e);
        },
        onPhase: this.telemetry.onPhase,
        self: this.id,
        collab,
        dependsOn: stack?.commit_id ?? seatStack?.commit_id ?? null,
        // a seat's role paragraph sits after the rules and before the soul (docs/plans/SWARMS.md 3)
        soul: sp && this.opts.seat ? [this.opts.seat.rolePrompt, await this.soulBlock()].filter(Boolean).join("\n") : await this.soulBlock(),
        notes: journal ? notesBlock(await readNotes(this.client, this.id, view.lineage_id), view.lineage_id) : null,
        shared: null,
        journalReserveUsd: journal && proposer.journal ? (this.opts.journalReserveUsd ?? JOURNAL_RESERVE_USD) : 0,
        spent: { usd: 0 },
        // guard limits (SPEC 10.1 rule 6): self-evaluation judges with the rule in force (GET /v1/guard-config)
        guardRule: guardRuleReader((path) => this.client.get(path), view.recipe_id),
        guardRegression: null,
        ...budget,
      };
      ctx.meter = episode.wrap(ctx.meter);
      // shared findings after the notes (AGENT-LEARNINGS.md 12.4); re-ranked for the planned target below
      const sharedOpt = this.opts.sharedFindings ?? journal;
      const sharedCap = typeof sharedOpt === "object" ? sharedOpt.max_tokens : undefined;
      const sharedData: SharedData | null = sharedOpt && proposer.name !== "scripted" ? await readShared(this.client, view.lineage_id) : null;
      const setShared = (target: string | null) => {
        const b = sharedBlock(sharedData, { self: this.id, target, maxTokens: sharedCap });
        ctx.shared = b?.text ?? null;
        if (b) this.log(`shared findings: ${b.items} items, about ${b.tokens} tokens${target ? ` (target ${target})` : ""}`);
      };
      setShared(null);
      jctx = ctx;
      if (collab !== "off") {
        // intents are advisory (SPEC 12.1): reading or filing one never blocks authoring
        ctx.intents = await this.intentsOn(view.lineage_id);
        // messages are advisory too (SPEC 12.3): the board and the inbox inform, never block
        await this.ensureEncryptionKey();
        ctx.board = await this.boardOf(view.lineage_id);
        ctx.inbox = await this.readInbox();
        if (sp) {
          // the ledger's assignment: an intent for the others to see, and the assignment paragraph for the model
          ctx.planned = sp.planned;
          ctx.suggested = seatLine(sp, seated?.facts ?? null);
          episode.plan(sp.planned);
          if (sharedData) setShared(plannedKey(sp.planned));
          await this.fileIntent(view.lineage_id, tree.gen_id, sp.planned, this.opts.spreadIntentTtlS ?? SPREAD_INTENT_TTL_S);
        } else if (!proposer.plan && this.opts.spread && proposer.name !== "scripted") {
          // target spread: a pick from counts, an intent for the others to see, one line for the model
          const mem = this.fruitless.get(view.lineage_id);
          const pick = pickTarget({
            targets: loaded.recipe.metrics.filter((m) => view.calibration?.metrics?.[m.name]?.enabled).map((m) => ({ kind: m.kind as CandidateKind, name: m.name })),
            intents: ctx.intents ?? [],
            self: this.id,
            tip: tree.gen_id,
            shared: sharedData,
            fruitless: mem && mem.tip === tree.gen_id ? mem.counts : undefined,
          });
          if (pick) {
            ctx.planned = pick.planned;
            ctx.suggested = pick.line;
            episode.plan(pick.planned);
            if (sharedData) setShared(plannedKey(pick.planned));
            this.log(`target spread: ${pick.planned.kind} ${pick.planned.target} (${pick.why.others} other agents on it, ${pick.why.own_fruitless} own fruitless on this tip, ${pick.why.tip_failed} failed on this tip)`);
            await this.fileIntent(view.lineage_id, tree.gen_id, pick.planned, this.opts.spreadIntentTtlS ?? SPREAD_INTENT_TTL_S);
          }
        }
        if (proposer.plan && !sp) {
          ctx.planned = await proposer.plan(ctx);
          episode.plan(ctx.planned);
          if (ctx.planned && sharedData) setShared(plannedKey(ctx.planned));
          if (ctx.planned) {
            const intent = await this.fileIntent(view.lineage_id, tree.gen_id, ctx.planned);
            if (intent) await this.send(`board:${view.lineage_id}`, intentNote({ kind: ctx.planned.kind, target: this.normTarget(ctx.planned), tip: tree.gen_id }), { ref: { kind: "intent", id: intent } });
          }
        }
      }
      this.attempted = true;
      const proposal = await proposer.propose(ctx);
      if (!proposal && ctx.suggested && ctx.planned) {
        // target spread: remember the miss on this tip, so the next pick moves on
        let mem = this.fruitless.get(view.lineage_id);
        if (!mem || mem.tip !== tree.gen_id) this.fruitless.set(view.lineage_id, (mem = { tip: tree.gen_id, counts: new Map() }));
        const k = plannedKey(ctx.planned)!;
        mem.counts.set(k, (mem.counts.get(k) ?? 0) + 1);
      }
      if (!proposal) {
        outcome(ctx.guardRegression ? guardOutcome(ctx.guardRegression) : "no candidate: the session stopped without submitting a change");
        return null;
      }
      // a change whose last self-evaluation regressed a guarded metric beyond its limit is never submitted
      if (ctx.guardRegression) {
        this.log(`author: ${guardOutcome(ctx.guardRegression)}`);
        outcome(guardOutcome(ctx.guardRegression));
        return null;
      }
      // a seat's target is fixed for the attempt: a change on another one stands only if no other seat holds that target
      if (sp && this.opts.seat && targetKey(proposal.kind, proposal.target) !== targetKey(sp.planned.kind, sp.planned.target) && !this.opts.seat.retarget(view.lineage_id, proposal.kind, proposal.target)) {
        this.log(`seat: the change is on ${proposal.kind} ${JSON.stringify(proposal.target)}, which another seat holds; not submitted`);
        outcome("no candidate: the change was on a target that another agent of the group is working on");
        return null;
      }
      if (proposal.usage) this.log(`author: model spend ${proposal.usage.usd.toFixed(4)} USD (${proposal.usage.input_tokens} in, ${proposal.usage.output_tokens} out, ${proposal.usage.cache_read_tokens} cache read)`);
      const raw = diffWorkingTree(dir);
      if (!raw.trim()) {
        outcome("no candidate: the working tree had no change to submit");
        this.log("author: proposer made no change");
        return null;
      }
      const patch = canonicalizeDiff(raw);
      const g = guard(patch, loaded.recipe.patch);
      if (!g.ok) this.log(`author: guard says ${g.violation}; submitting anyway only because the proposer is scripted`);
      const salt = randomBytes(16).toString("hex");
      const commitment = patchCommitment(patchHash(patch), salt);
      const commitBody = (parent: string, dep: string | null) => ({
        lineage_id: view.lineage_id,
        parent_gen_id: parent,
        kind: proposal.kind,
        target: proposal.target,
        commitment,
        claimed_effect: proposal.claimed_effect ?? null,
        ...(dep ? { depends_on: dep } : {}),
        ...this.teamFor({ lineage_id: view.lineage_id, parent_gen_id: parent, commitment, kind: proposal.kind, target: proposal.target, depends_on: dep }),
      });
      if (sp && this.opts.seat) {
        // commits of a swarm are serialized per unit and stacked on what is open there at this moment
        let seatChange = "";
        const res = await this.opts.seat.commit(view.lineage_id, async (io) => {
          for (let round = 0; round < 3; round++) {
            const readAt = Date.now();
            const now = io.stack(await this.openCommits(view.lineage_id), readAt);
            let finalPatch = patch;
            let parent = tree.gen_id as string;
            const same = (now?.commit_id ?? null) === (seatStack?.commit_id ?? null) && (now?.patches.length ?? 0) === (seatStack?.patches.length ?? 0);
            if (!same) {
              // another seat committed on this unit, or a change under this one became final, while it was written:
              // the change must apply on the tip plus the stack as they are now, and is re-cut there
              const tip = await this.ok(this.client.get(`/v1/lineages/${view.lineage_id}/tree`), "tree");
              // in the attempt's own repository: the change becomes a commit, the new base is built on a branch from
              // the pinned tree (the tip's patches, then the stack), and the change is cherry-picked onto it, so git
              // merges it with its real ancestor instead of matching context lines only
              const git = (...a: string[]) => Bun.spawnSync(["git", "-c", "user.name=l", "-c", "user.email=l@l", ...a], { cwd: dir });
              if (round === 0) {
                git("add", "-A");
                git("commit", "-q", "--no-gpg-sign", "-m", "seat change");
              }
              const change = round === 0 ? git("rev-parse", "HEAD").stdout.toString().trim() : seatChange;
              seatChange = change;
              let base = !!rootRef && git("checkout", "-q", "-B", `restack-${round}`, rootRef).exitCode === 0;
              for (const p of [...tip.patches.map((x: { patch: string }) => x.patch), ...(now?.patches ?? [])]) base = base && applyPatch(dir, p);
              if (!base || git("cherry-pick", "--no-commit", change).exitCode !== 0) {
                git("cherry-pick", "--abort");
                this.log("seat: the change no longer applies after another change of the swarm on this unit; not submitted");
                outcome("no candidate: the change no longer applied once another change of the group on this unit was in place");
                return null;
              }
              const dir2 = dir;
              finalPatch = canonicalizeDiff(diffWorkingTree(dir2));
              parent = tip.gen_id as string;
              this.log(`seat: re-cut on ${now ? `${now.patches.length} open change(s) of the swarm` : "the tip"} as they are now`);
            }
            const salt = randomBytes(16).toString("hex");
            const commitment = patchCommitment(patchHash(finalPatch), salt);
            const dep = now?.commit_id ?? null;
            const posted = await this.client.post("/v1/candidates", { lineage_id: view.lineage_id, parent_gen_id: parent, kind: proposal.kind, target: proposal.target, commitment, claimed_effect: proposal.claimed_effect ?? null, ...(dep ? { depends_on: dep } : {}) });
            // the newest change of the stack became final between the read and the commit: read again
            if (dep && posted.status === 409 && (posted.body as { error?: string })?.error === "dependency_final") continue;
            const committed = await this.ok(Promise.resolve(posted), "commit candidate");
            sessionCommit = committed.commit_id;
            this.telemetry.activity(where, { kind: "submit" });
            const revealed = await this.ok(this.client.post(`/v1/candidates/${committed.commit_id}/reveal`, { patch: finalPatch, salt }), "reveal candidate");
            io.committed(committed.commit_id, finalPatch);
            this.submitted++;
            this.log(`author: ${proposal.kind} on ${JSON.stringify(proposal.target)} (${g.lines} lines)${dep ? `, on ${dep.slice(0, 10)}` : ""} -> ${revealed.status}${revealed.reason ? ` (${revealed.reason})` : ""}`);
            outcome(`submitted a ${proposal.kind} candidate on ${Array.isArray(proposal.target) ? proposal.target.join(", ") : proposal.target} (${g.lines} changed lines); it was committed and revealed (status ${revealed.status}${revealed.reason ? `, ${revealed.reason}` : ""}); its verdict comes later from independent replays`);
            return committed.commit_id as string;
          }
          outcome("no candidate: the group's changes on this unit kept becoming final while this one was committed");
          return null;
        });
        return res;
      }
      let posted = await this.client.post("/v1/candidates", commitBody(tree.gen_id, stack?.commit_id ?? null));
      // stacked (agent efficiency lane): the pending candidate this attempt built on became final while
      // it ran. Accepted: the new tip is exactly the tree this change was made and measured on, so it
      // commits there as an ordinary candidate. Otherwise the change has no parent left and is dropped.
      if (stack && posted.status === 409 && (posted.body as { error?: string })?.error === "dependency_final") {
        const tip = await this.ok(this.client.get(`/v1/lineages/${view.lineage_id}/tree`), "tree");
        const same = tip.patches.length === parentPatches.length && tip.patches.every((p: { patch: string }, i: number) => p.patch === parentPatches[i]);
        if (!same) {
          this.log(`series: pending ${stack.commit_id.slice(0, 10)} became final without becoming the tip; change dropped`);
          outcome("no candidate: the pending candidate this change was built on was not accepted, so the change had no parent");
          return null;
        }
        this.log(`series: ${stack.commit_id.slice(0, 10)} was accepted while authoring; committing on the new tip ${String(tip.gen_id).slice(0, 10)}`);
        posted = await this.client.post("/v1/candidates", commitBody(tip.gen_id, null));
      }
      const committed = await this.ok(Promise.resolve(posted), "commit candidate");
      sessionCommit = committed.commit_id;
      // no target: a submit names no candidate while it is sealed, and Core shows submits only to this agent (SPEC 10.7)
      this.telemetry.activity(where, { kind: "submit" });
      const revealed = await this.ok(this.client.post(`/v1/candidates/${committed.commit_id}/reveal`, { patch, salt }), "reveal candidate");
      this.mine.set(committed.commit_id, { lineage_id: view.lineage_id, patch, at: Date.now() });
      this.submitted++;
      this.log(`author: ${proposal.kind} on ${JSON.stringify(proposal.target)} (${g.lines} lines) -> ${revealed.status}${revealed.reason ? ` (${revealed.reason})` : ""}`);
      outcome(`submitted a ${proposal.kind} candidate on ${Array.isArray(proposal.target) ? proposal.target.join(", ") : proposal.target} (${g.lines} changed lines); it was committed and revealed (status ${revealed.status}${revealed.reason ? `, ${revealed.reason}` : ""}); its verdict comes later from independent replays`);
      return committed.commit_id;
    } catch (e) {
      outcome(`the attempt failed: ${(e as Error).message.slice(0, 200)}`);
      throw e;
    } finally {
      const sid = session.id;
      await session.end(sessionCommit);
      if (facts && jctx && sid && !facts.empty) await this.writeJournal(proposer, jctx, facts, sid, view.lineage_id, loaded.recipe);
      if (sid && this.opts.telemetry !== false) await episode.post(this.client, sid, this.log);
      if (desk) await desk.end().catch((e) => this.log(`desktop end: ${(e as Error).message}`));
      removeTree(work);
      this.telemetry.idle();
      void this.telemetry.flush();
    }
  }

  /**
   * The session's journal entry (SPEC 17.6): one model call by the proposer in the soul's voice from
   * the session's facts, at most one repair, checked (format, safety, every number in the facts),
   * signed with purpose `journal` and stored in Core. Never throws: a missing entry costs nothing.
   */
  private async writeJournal(proposer: Proposer, ctx: ProposeContext, facts: FactsLog, sessionId: string, lineageId: string, recipe: { name: string; repo: string }): Promise<void> {
    if (!proposer.journal) return;
    try {
      const f = facts.text(`Session on the ${recipe.name} lineage (repository ${recipe.repo}).`);
      const req = journalPrompt(this.soulDoc, f);
      let text = (await proposer.journal(ctx, req))?.trim() ?? null;
      let problems = text ? checkEntry(text, f) : ["no text"];
      if (text && problems.length) {
        this.log(`journal: draft refused (${problems.slice(0, 3).join("; ")}), one repair`);
        text = (await proposer.journal(ctx, { system: req.system, user: `${req.user}\n\nYour draft:\n${text}\n\nIt was refused for: ${problems.join("; ")}. Write it again and fix these problems.` }))?.trim() ?? null;
        problems = text ? checkEntry(text, f) : ["no text"];
      }
      if (!text || problems.length) {
        this.log(`journal: no entry (${problems.slice(0, 3).join("; ")})`);
        return;
      }
      const id = await storeEntry(this.client, this.opts.key, this.id, { session_id: sessionId, lineage_id: lineageId, text }, this.log);
      if (id) this.log(`journal: entry ${id.slice(0, 10)} stored (${text.length} chars, attempt spend ${(ctx.spent?.usd ?? 0).toFixed(4)} USD)`);
    } catch (e) {
      this.log(`journal: no entry (${(e as Error).message.slice(0, 200)})`);
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
  async fileIntent(lineage: string, tip: string, planned: PlannedTarget, ttlS?: number): Promise<string | null> {
    if (this.intentTtl === null) {
      const c = await this.client.get("/v1/config").catch(() => null);
      this.intentTtl = Math.min(1800, Number(c?.body?.network?.intent_max_ttl_s ?? 1800));
    }
    const target = planned.kind === "fix" ? [...new Set(Array.isArray(planned.target) ? planned.target : [planned.target])].sort() : planned.target;
    const note = planned.note ? planned.note.slice(0, 280) : null;
    const ttl = ttlS ? Math.max(1, Math.min(ttlS, this.intentTtl)) : this.intentTtl;
    const statement = { v: 1, agent: this.id, lineage_id: lineage, tip, kind: planned.kind, target, finding_id: null, note, ttl_s: ttl };
    const r = await this.client
      .post("/v1/intents", { lineage_id: lineage, tip, kind: planned.kind, target, note, ttl_s: ttl, sig: signStatement(this.opts.key, "intent", statement) })
      .catch((e) => ({ status: 0, body: { error: String(e) } }));
    if (r.status >= 300) {
      this.log(`intent not filed (${r.status} ${r.body?.error ?? ""}); authoring anyway, intents are advisory`);
      return null;
    }
    this.log(`intent ${String(r.body.intent_id).slice(0, 10)} filed: ${planned.kind} on ${JSON.stringify(target)}`);
    return r.body.intent_id as string;
  }

  /** `{ team }` for a commit when collab is "team" and every member can sign here, else nothing (SPEC 12.2). */
  teamFor(ctx: { lineage_id: string; parent_gen_id: string; commitment: string; kind: CandidateKind; target: string | string[]; depends_on?: string | null }): { team?: { members: TeamMember[]; sigs: Record<string, string> } } {
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

  private normTarget(p: PlannedTarget): string | string[] {
    return p.kind === "fix" ? [...new Set(Array.isArray(p.target) ? p.target : [p.target])].sort() : p.target;
  }

  // ------------------------------------------------------------------ stacked series (SPEC 12.4)

  /** This agent's newest revealed candidate on the lineage that is still pending, with its patch. */
  async stackTarget(lineage: string): Promise<{ commit_id: string; patch: string } | null> {
    const mine = [...this.mine.entries()].filter(([, m]) => m.lineage_id === lineage).sort((a, b) => b[1].at - a[1].at);
    for (const [id, m] of mine) {
      const r = await this.client.get(`/v1/candidates/${id}`, true).catch(() => null);
      const st = r?.status === 200 ? String(r.body.status) : "";
      if (["waiting", "queued", "replaying", "disputed"].includes(st)) return { commit_id: id, patch: m.patch };
      if (["accepted", "rejected", "expired"].includes(st)) this.mine.delete(id);
    }
    return null;
  }

  // ------------------------------------------------------------------ messages (SPEC 12.3)

  private encKey: EncryptionKey | null = null;
  private inboxAfter = 0;
  private inboxSeen: InboxMessage[] = [];

  /** Publishes this agent's message encryption key (derived from its key seed) if Core does not have it. Never fatal. */
  async ensureEncryptionKey(): Promise<EncryptionKey> {
    if (this.encKey) return this.encKey;
    const k = deriveEncryptionKey(this.opts.key);
    if (this.opts.messenger) {
      await this.opts.messenger.publishKey(k).catch((e) => this.log(`messages: encryption key not published on chain (${(e as Error).message.slice(0, 200)})`));
      return (this.encKey = k);
    }
    const cur = await this.client.get(`/v1/agents/${this.id}/encryption-key`).catch(() => null);
    if (cur?.status === 200 && cur.body.encryption_key === k.public) return (this.encKey = k);
    const seq = cur?.status === 200 ? Number(cur.body.seq) + 1 : 1;
    const r = await this.client
      .put(`/v1/agents/${this.id}/encryption-key`, { encryption_key: k.public, seq, sig: signStatement(this.opts.key, "msgkey", encryptionKeyStatement({ agent: this.id, encryption_key: k.public, seq })) })
      .catch((e) => ({ status: 0, body: { error: String(e) } }));
    if (r.status >= 300) this.log(`messages: encryption key not published (${r.status} ${r.body?.error ?? ""})`);
    return (this.encKey = k);
  }

  /**
   * Sends a signed message to an agent or to `board:<lineage>`. With `encrypt` the body is sealed
   * to the recipient's published key. Returns the message id, or null when Core refused (logged).
   */
  async send(to: string, text: string, o: { encrypt?: boolean; ref?: { kind: string; id: string }; thread?: string } = {}): Promise<string | null> {
    if (this.opts.messenger) return this.opts.messenger.send(to, text, o);
    let body: string | null = text;
    let ciphertext: string | null = null;
    let enc_key: string | null = null;
    if (o.encrypt) {
      const k = await this.client.get(`/v1/agents/${to}/encryption-key`).catch(() => null);
      if (k?.status !== 200) {
        this.log(`messages: ${to.slice(0, 8)} has no encryption key; not sent`);
        return null;
      }
      enc_key = k.body.encryption_key as string;
      ciphertext = seal(text, enc_key);
      body = null;
    }
    const env = messageEnvelope({ from: this.id, to, thread: o.thread ?? null, ref: o.ref ?? null, body, ciphertext, enc_key, sent_at: Date.now(), nonce: randomBytes(12).toString("hex") });
    const r = await this.client.post("/v1/messages", { envelope: env, sig: signStatement(this.opts.key, "msg", env) }).catch((e) => ({ status: 0, body: { error: String(e) } }));
    if (r.status >= 300) {
      this.log(`messages: not sent to ${to.slice(0, 14)} (${r.status} ${r.body?.error ?? ""})`);
      return null;
    }
    return r.body.msg_id as string;
  }

  /** New direct messages since the last read, sealed ones opened; keeps the last 50 for the proposer. */
  async readInbox(): Promise<InboxMessage[]> {
    const k = this.encKey ?? deriveEncryptionKey(this.opts.key);
    const r = await this.client.get(`/v1/messages?after=${this.inboxAfter}`, true).catch(() => null);
    if (r?.status !== 200) return this.inboxSeen;
    for (const m of r.body.received as any[]) {
      const e = m.envelope;
      this.inboxSeen.push({ msg_id: m.msg_id, from: m.from, body: e.ciphertext ? open(e.ciphertext, k) : e.body, sealed: !!e.ciphertext, thread: e.thread, ref: e.ref, received_at: m.received_at });
    }
    this.inboxAfter = Number(r.body.next?.after ?? this.inboxAfter);
    this.inboxSeen = this.inboxSeen.slice(-50);
    return this.inboxSeen;
  }

  /** The lineage board's last notes (public). */
  async boardOf(lineage: string, last = 50): Promise<BoardNote[]> {
    const r = await this.client.get(`/v1/lineages/${lineage}/board?limit=1000`).catch(() => null);
    if (r?.status !== 200) return [];
    return (r.body.messages as any[]).slice(-last).map((m) => ({ from: m.from, body: String(m.envelope.body ?? ""), ref: m.envelope.ref, received_at: m.received_at }));
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
      let acted = await this.replayOnce();
      if (!this.draining) acted += await this.sideWork();
      if (acted === 0 && !this.draining && this.inflight.size === 0) await this.authorOnce();
    } catch (e) {
      this.log(`tick: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Profile and calibration assignments. A Core without these routes (older deploys) answers an
   * error, logged once per kind; they never block replays or authoring.
   */
  private async sideWork(): Promise<number> {
    let acted = 0;
    for (const [kind, f] of [
      ["profile", () => this.profiles.replayOnce()],
      ["calibration", () => this.calibrations.once()],
    ] as const) {
      try {
        acted += await f();
        this.sideErrors.delete(kind);
      } catch (e) {
        if (!this.sideErrors.has(kind)) this.log(`${kind} assignments: ${(e as Error).message.slice(0, 200)}`);
        this.sideErrors.add(kind);
      }
    }
    return acted;
  }

  /** True while a tick (a replay, qualification or authoring step) is running. */
  get running(): boolean {
    return this.busy || this.inflight.size > 0;
  }

  /** Committed replays this worker still has to reveal. */
  get pendingReveals(): number {
    return this.pending.size;
  }

  /**
   * Graceful stop: stop taking assignments, keep revealing committed replays until none are left
   * or `maxMs` passes, so a restart (deploys) never turns into unrevealed or abandoned strikes.
   */
  async drain(intervalMs = 2000, maxMs = 15 * 60_000): Promise<void> {
    this.draining = true;
    // replays running in the background (replaySlots > 1) finish and commit first
    if (this.inflight.size) await Promise.all([...this.inflight.values()]);
    const end = Date.now() + maxMs;
    while (this.pending.size > 0 && Date.now() < end) {
      try {
        await this.replayOnce();
      } catch (e) {
        this.log(`drain: ${(e as Error).message}`);
      }
      if (this.pending.size > 0) await Bun.sleep(intervalMs);
    }
    this.log(this.pending.size ? `drain timed out with ${this.pending.size} unrevealed` : "drained: nothing left to reveal");
  }

  async run(intervalMs = 2000, until?: () => boolean): Promise<void> {
    try {
      await this.declareCapabilities();
    } catch (e) {
      this.log(`capabilities not declared: ${(e as Error).message}`);
    }
    await this.telemetry.start();
    let stopped = false;
    const revealLoop = (async () => {
      while (!stopped) {
        try {
          await this.revealOnce();
        } catch (e) {
          this.log(`reveal loop: ${(e as Error).message}`);
        }
        await Bun.sleep(intervalMs);
      }
    })();
    try {
      while (!until?.()) {
        await this.tick();
        await Bun.sleep(intervalMs);
      }
    } finally {
      stopped = true;
      await revealLoop;
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
export async function selfCheck(w: Worker, recipe_id: string, calibration: Calibration, parentPatches: string[], patch: string, cand: CandidateView, guardRule: GuardRule | null = null): Promise<string> {
  const loaded = w.recipes.get(recipe_id);
  const deps = await w.recipes.depsFor(loaded);
  const { result } = await evaluate({ loaded, deps, parentPatches, candidatePatch: patch, seed: randomBytes(8).toString("hex") });
  const j = judge(loaded.recipe, calibration, cand, [{ replay_id: "self", replayer: "self", seed: "self", result }], { quorum: 1, det_tolerance: 0.001, bootstrap_resamples: 2000, guard_limits: guardRule });
  return j.outcome + (j.reason ? `:${j.reason}` : "");
}

/** Metrics calibration left enabled; disabled ones can never decide a verdict, so they are not run. */
export function enabledMetrics(c: Calibration): string[] {
  return Object.entries(c.metrics)
    .filter(([, m]) => m.enabled)
    .map(([name]) => name);
}
