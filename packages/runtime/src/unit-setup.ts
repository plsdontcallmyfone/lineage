import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { AgentKey, Recipe } from "@units/protocol";
import { materialize, newWorkDir, removeTree } from "@units/sandbox";
import { CoreClient } from "../../core/src/client.ts";
import { SpendLedger, type SpendEntry } from "../../worker/src/discovery.ts";
import { claudeRoute, routedSdk } from "../../worker/src/proposers/claude-route.ts";
import type { Meter } from "../../worker/src/proposers/types.ts";
import { DRAFT_MODEL, FIRST_TRIAL_TURNS, RecipeDrafter, describeUnits, ensureRecipe, submitProposal, type DraftHistory, type MoreContext } from "../../worker/src/recipe-proposer.ts";
import { RecipeBook } from "../../worker/src/recipes.ts";
import { oneLine, reasonLine, type TrialOutcome } from "../../worker/src/trial-reason.ts";

// Unit setup (SPEC 6.2, 3.2): a hosted agent launched on a repository that has no unit yet gets one
// with nobody in the loop. Core keeps such an agent in `setting_up`. For each such repository this
// runtime
//   1. reads the repository (free): its language class and whether it has tests of its own. A
//      repository that cannot have a unit (no toolchain image for its language, no tests) is marked so
//      with one plain sentence; nothing is spent on it;
//   2. has ONE bound, awake agent of that repository draft the recipe with a model (the drafter of
//      packages/worker/src/recipe-proposer.ts: it reads the checkout, writes recipe.yml and the overlay
//      harness, trial-calibrates in the real sandbox and may submit only a stable draft), metered to
//      that agent's compute vault like an authoring attempt. For a repository of several packages the
//      drafter first ranks them for free (packages/worker/src/repo-structure.ts) and is told to write
//      the recipe for ONE small, self-contained package and to reach a first trial early;
//   3. submits the proposal to Core as that agent; the network's verifiers then calibrate it (commit
//      and reveal), and when they agree Core creates the unit and turns every agent of the repository
//      `active`. This runtime only watches.
// A draft that fails is tried again after a backoff, up to `max_drafts` drafts and `repo_max_usd` of
// model spend per repository. Every state has a public reason, served through the spend report
// (GET /v1/agents/:id/spend `waiting`), so an agent never waits without saying why.
// Every trial calibration of a draft is kept with why it failed (the stage, the rule, a short cause
// from the sandbox result: packages/worker/src/trial-reason.ts): in the log line, in the state (the
// next draft starts from the failed draft's files and from "last time this failed because ..."), in
// the public sentence in fixed words ("trial 2 failed at build (compile error)"), and, with the raw
// cause, in the spend report's `setup` field for the agent's Runway panel.

export interface UnitSetupConfig {
  /** false: setting_up agents are left alone (as before this module) */
  enabled?: boolean;
  /** registry id of the model that drafts (routed like every Claude call) */
  model?: string;
  /** the most one draft may spend on model calls, USD */
  draft_max_usd?: number;
  /** drafts per repository (at one head commit) before setup stops with its reason */
  max_drafts?: number;
  /** model spend on drafts per repository before setup stops, USD */
  repo_max_usd?: number;
  /** wait after a failed draft, doubling per draft, at most 6 h */
  retry_s?: number;
  /** how often a repository is read again (new head commit, tests added) */
  recheck_s?: number;
  /** trial calibrations per draft */
  max_trials?: number;
  /** model turns a draft may take before its first trial; after them the loop tells the model to trial what it has (default 12) */
  first_trial_turns?: number;
}

export const UNIT_SETUP_DEFAULTS = { enabled: true, model: DRAFT_MODEL, draft_max_usd: 1.5, max_drafts: 3, repo_max_usd: 4, retry_s: 600, recheck_s: 21_600, max_trials: 4, first_trial_turns: FIRST_TRIAL_TURNS };

export function unitSetupError(v: unknown): string | null {
  if (v === undefined) return null;
  if (!v || typeof v !== "object" || Array.isArray(v)) return "unit_setup is an object";
  const c = v as Record<string, unknown>;
  if (c.enabled !== undefined && typeof c.enabled !== "boolean") return "unit_setup.enabled is true or false";
  if (c.model !== undefined && !(typeof c.model === "string" && /^[a-z0-9][a-z0-9.-]{1,63}$/.test(c.model))) return "unit_setup.model is a model registry id";
  for (const k of ["draft_max_usd", "repo_max_usd"]) if (c[k] !== undefined && !(typeof c[k] === "number" && (c[k] as number) > 0 && (c[k] as number) <= 50)) return `unit_setup.${k} is above 0 and at most 50 USD`;
  for (const k of ["max_drafts", "max_trials", "first_trial_turns"]) if (c[k] !== undefined && !(Number.isInteger(c[k]) && (c[k] as number) >= 1 && (c[k] as number) <= 20)) return `unit_setup.${k} is a whole number from 1 to 20`;
  for (const k of ["retry_s", "recheck_s"]) if (c[k] !== undefined && !(typeof c[k] === "number" && (c[k] as number) >= 1)) return `unit_setup.${k} is at least 1 second`;
  return null;
}

/** What the runtime keeps per repository (state.json `unit_setup`). */
export interface RepoSetup {
  /** head commit the repository was last read at, its class, and when */
  head: string | null;
  class: Recipe["class"] | null;
  screened_at: number;
  /** why this repository cannot have a unit as it stands (one sentence), and who found that: the free reading or the drafting model */
  impossible: string | null;
  impossible_by?: "reading" | "drafter" | null;
  /** drafts run and their model spend (USD, with the route's fee) */
  drafts: number;
  usd: number;
  /** drafts that could not run at all (model or sandbox down) in a row */
  errors: number;
  /** no new draft before this time */
  next_at: number;
  last_reason: string | null;
  /** the proposal the last passing draft became, and proposals of ours whose rejection was already counted */
  proposal_id: string | null;
  proposed_at?: number;
  rejected: string[];
  /** when a new head commit last gave the repository a fresh set of drafts */
  reset_at?: number;
  /** the trials of the drafts so far with why each failed, oldest first (the last SETUP_TRIALS_KEPT) */
  trials?: SetupTrial[];
  /** where the last draft that did not pass left its files (under the runtime's state directory; never reported) */
  last_dir?: string | null;
}

/** One trial calibration of a draft as the state keeps it. */
export interface SetupTrial extends TrialOutcome {
  draft: number;
  at: number;
}

export const SETUP_TRIALS_KEPT = 12;

/** The last failed trial of a repository's unit setup as the spend report carries it (`setup`), raw cause included. */
export interface SetupDetail {
  draft: number;
  trial: number;
  stage: string;
  kind: string;
  cause: string;
  seconds: number | null;
  at: number;
}

/** The trials kept in the state, grouped by draft, for the next draft's prompt. */
export function historyOf(s: Pick<RepoSetup, "trials">): DraftHistory[] {
  const by = new Map<number, TrialOutcome[]>();
  for (const t of s.trials ?? []) by.set(t.draft, [...(by.get(t.draft) ?? []), { n: t.n, ok: t.ok, seconds: t.seconds, reason: t.reason }]);
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([draft, trials]) => ({ draft, trials }));
}

const emptySetup = (): RepoSetup => ({ head: null, class: null, screened_at: 0, impossible: null, impossible_by: null, drafts: 0, usd: 0, errors: 0, next_at: 0, last_reason: null, proposal_id: null, rejected: [] });

// ---------------------------------------------------------------------------------------------
// Reading a repository (free: no model)

// the rules of the reading live in repo-reading.ts (Core's free repository check reads with the same ones)
import { CLASS_LABEL, REPO_URL, readTree, repoLabel, type TreeReading } from "./repo-reading.ts";
export { CLASS_LABEL, readTree, repoLabel, type TreeReading };

export type Reading = { ok: true; commit: string; class: Recipe["class"] } | { ok: false; commit: string | null; class: Recipe["class"] | null; impossible: string };

/** Reads a public repository at its head commit. Throws when it cannot be read now (network, not public): the caller tries again later. */
export async function readRepo(repo: string): Promise<Reading> {
  if (!REPO_URL.test(repo)) return { ok: false, commit: null, class: null, impossible: "its address is not a public GitHub, GitLab or Codeberg repository" };
  const p = Bun.spawn(["git", "ls-remote", repo, "HEAD"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const timer = setTimeout(() => p.kill(), 60_000);
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  clearTimeout(timer);
  const commit = /^([0-9a-f]{40})\s+HEAD$/m.exec(out)?.[1];
  if (code !== 0 || !commit) throw new Error("the repository could not be read (it must be public and have a default branch)");
  const work = newWorkDir("unit-setup-read");
  try {
    const tree = join(work, "src");
    materialize(repo, commit, null, tree);
    const r = readTree(tree);
    return r.impossible === null ? { ok: true, commit, class: r.class } : { ok: false, commit, class: r.class, impossible: r.impossible };
  } finally {
    removeTree(work);
  }
}

// ---------------------------------------------------------------------------------------------
// Drafting (one model job)

export interface DraftJob {
  repo: string;
  commit: string;
  class: Recipe["class"];
  agent: string;
  key: AgentKey;
  capUsd: number;
  meter: Pick<Meter, "model" | "sandbox">;
  /** set for an ADDITIONAL unit (more-units.ts): the repository's active units; commit, class and image are theirs */
  more?: { units: string[] };
  /** earlier drafts' trials with why each failed, and the directory of the last draft that did not pass */
  history?: DraftHistory[];
  resume?: string | null;
  log: (m: string) => void;
}

/** What a draft measured about itself: every trial with its reason, and the turns and USD before the first one. */
export interface DraftFacts {
  trials?: TrialOutcome[];
  before_trial?: { turns: number; usd: number };
  /** where the draft's files are (recipe.yml, overlay/) */
  dir?: string;
}

export type DraftResult =
  | ({ kind: "proposed"; proposal_id: string; name: string } & DraftFacts)
  /** the model found that the repository cannot have a unit as it stands */
  | ({ kind: "impossible"; reason: string } & DraftFacts)
  /** this draft did not pass; another may */
  | ({ kind: "failed"; reason: string } & DraftFacts)
  /** nothing was spent: something outside the repository is missing (no unit of the class on this network) */
  | { kind: "blocked"; reason: string };

export interface UnitSetupWork {
  read(repo: string): Promise<Reading>;
  draft(job: DraftJob): Promise<DraftResult>;
}

/** A spend ledger that also meters every priced call, with the route's fee, to the agent's vault. */
class MeterLedger extends SpendLedger {
  constructor(file: string, private meter: DraftJob["meter"], private fee: number) {
    super(file, Infinity);
  }
  override remaining(): number {
    return Infinity;
  }
  override record(who: string, model: string, u: Anthropic.Beta.BetaUsage): SpendEntry {
    const e = super.record(who, model, u);
    this.meter.model({ model: e.model, input_tokens: e.input_tokens, output_tokens: e.output_tokens, cache_read_tokens: e.cache_read_tokens, cache_write_tokens: e.cache_write_tokens, usd: e.usd * this.fee });
    return e;
  }
}

const kebab = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const hostArch = (): "amd64" | "arm64" => (process.arch === "arm64" ? "arm64" : "amd64");

/** A free recipe name for a repository: its own name, then owner-name, then a numbered one. */
export function recipeName(repo: string, taken: Set<string>): string {
  const m = REPO_URL.exec(repo);
  const base = kebab(m?.[3] ?? "unit") || "unit";
  const owner = kebab(m?.[2] ?? "");
  const fit = (s: string) => (s.length < 2 ? `${s}-unit` : s).slice(0, 60).replace(/-+$/, "");
  for (const c of [fit(base), fit(`${owner}-${base}`)]) if (!taken.has(c)) return c;
  for (let i = 2; ; i++) if (!taken.has(`${fit(base).slice(0, 56)}-${i}`)) return `${fit(base).slice(0, 56)}-${i}`;
}

/** The production work: git for reading, the recipe drafter with the routed model for drafting. */
export function unitSetupWork(o: { core: string; state_dir: string; model?: string; max_trials?: number; first_trial_turns?: number; client?: Anthropic; book?: RecipeBook }): UnitSetupWork {
  const anon = new CoreClient(o.core, null);
  const model = o.model ?? UNIT_SETUP_DEFAULTS.model;
  return {
    read: readRepo,
    async draft(job) {
      const label = repoLabel(job.repo);
      const arch = hostArch();
      // the image and the format reference: an active unit of the same class and arch on this Core
      // (Core admits a proposal only on an image an active unit of its class already uses)
      const list = await anon.get("/v1/lineages");
      if (list.status !== 200 || !Array.isArray(list.body)) throw new Error(`units: HTTP ${list.status}`);
      const book = o.book ?? new RecipeBook();
      const taken = new Set<string>();
      const same: { recipe_id: string; recipe: Recipe }[] = [];
      for (const u of list.body as { lineage_id: string; status: string; recipe_name?: string }[]) {
        if (u.recipe_name) taken.add(u.recipe_name);
        if (u.status !== "active") continue;
        const v = await anon.get(`/v1/lineages/${u.lineage_id}`);
        const r = v.status === 200 ? (v.body.recipe as Recipe | undefined) : undefined;
        if (r && r.class === job.class && r.requires?.arch === arch && !String(r.repo).startsWith("fixture:")) same.push({ recipe_id: v.body.recipe_id as string, recipe: r });
      }
      const props = await anon.get("/v1/recipe-proposals");
      if (props.status === 200 && Array.isArray(props.body)) for (const p of props.body as { name: string; status: string }[]) if (p.status !== "rejected") taken.add(p.name);
      let withFiles = same.filter((s) => book.has(s.recipe_id)).sort((a, b) => a.recipe.name.length - b.recipe.name.length || a.recipe.name.localeCompare(b.recipe.name));
      // an additional unit (more-units.ts): the format reference, the commit, the class and the image are those of
      // the repository's own units, whatever the class; the drafter is told what they measure and what was achieved
      let more: MoreContext | undefined;
      if (job.more) {
        const existing = await describeUnits(anon, job.more.units);
        const own: typeof same = [];
        for (const id of job.more.units) {
          const v = await anon.get(`/v1/lineages/${id}`);
          if (v.status === 200 && (await ensureRecipe(book, anon, v.body.recipe_id as string).catch(() => false))) own.push({ recipe_id: v.body.recipe_id as string, recipe: v.body.recipe as Recipe });
        }
        if (!existing.length || !own.length) return { kind: "blocked", reason: `the recipes of the units of ${label} could not be read from this network` };
        const r0 = own[0]!.recipe;
        if (r0.requires?.arch !== arch) return { kind: "blocked", reason: `the units of ${label} are measured on ${r0.requires?.arch}, and this runtime's sandbox is ${arch}` };
        job = { ...job, commit: r0.commit, class: r0.class };
        withFiles = own;
        const cfg = await anon.get("/v1/config").catch(() => null);
        const share = Number(cfg?.body?.network?.more_units?.max_fixed_share);
        more = { units: existing, maxFixedShare: share > 0 && share <= 1 ? share : 0.1 };
      }
      if (!withFiles.length)
        return { kind: "blocked", reason: `this network has no ${CLASS_LABEL[job.class] ?? job.class} unit yet, so no verifier is qualified to calibrate one for ${label}` };
      const ex = book.get(withFiles[0]!.recipe_id);
      const overlay: Record<string, string> = {};
      for (const f of ex.overlayFiles) overlay[f] = readFileSync(join(ex.overlayDir!, f), "utf8");
      const name = recipeName(job.repo, taken);
      const root = join(o.state_dir, "unit-setup");
      const dir = join(root, `${name}-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      const route = claudeRoute(model);
      const fee = route?.gateway?.fee_factor ?? 1;
      const drafter = new RecipeDrafter({
        client: o.client ?? routedSdk(),
        model,
        ledger: new MeterLedger(join(root, "spend.jsonl"), job.meter, fee),
        capUsd: job.capUsd / fee,
        dir,
        target: { name, repo: job.repo, commit: job.commit, class: job.class, arch, image: withFiles[0]!.recipe.image },
        example: { recipe_yml: readFileSync(join(ex.dir, "recipe.yml"), "utf8"), overlay },
        more,
        seedOverlay: more ? ex.overlayDir : null,
        history: job.history,
        resume: job.resume && job.resume.startsWith(root) ? job.resume : null,
        maxTrials: o.max_trials ?? UNIT_SETUP_DEFAULTS.max_trials,
        firstTrialTurns: job.resume ? undefined : o.first_trial_turns,
        onSandbox: (s) => job.meter.sandbox(s),
        log: job.log,
      });
      const out = await drafter.draft();
      const facts: DraftFacts = { trials: out.outcomes, before_trial: out.before_trial, dir };
      job.log(`recipe-drafter: draft ended after ${out.turns} turns and ${out.trials} trial${out.trials === 1 ? "" : "s"}; ${out.before_trial.turns} turns and ${(out.before_trial.usd * fee).toFixed(4)} USD before the first trial`);
      if (!out.submitted) return out.impossible ? { kind: "impossible", reason: out.reason ?? "the drafter found no way to measure it", ...facts } : { kind: "failed", reason: out.reason ?? "no draft", ...facts };
      if (!existsSync(join(dir, "recipe.yml"))) return { kind: "failed", reason: "the draft had no recipe", ...facts };
      try {
        const p = await submitProposal(new CoreClient(o.core, { ...job.key, agent: job.agent } as AgentKey), dir, out.note ?? "");
        return { kind: "proposed", proposal_id: p.proposal_id, name, ...facts };
      } catch (e) {
        return { kind: "failed", reason: `Core refused the draft (${(e as Error).message.replace(/^proposal: /, "").slice(0, 160)})`, ...facts };
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The state machine

/** One public sentence: no em dash, one line, short enough for the spend report (Core refuses more than 300 characters). */
export function plain(s: string, max = 280): string {
  const t = s.replace(/\u2014/g, ", ").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 3).trimEnd()}...`;
}

export const hhmm = (ms: number) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

export interface SetupHost {
  core: CoreClient;
  log(m: string): void;
  now(): number;
  save(): void;
  /** state.json `unit_setup` (created on first use) */
  store(): Record<string, RepoSetup>;
  agents(): { agent: string; status: string; target_repo: string | null }[];
  keyOf(agent: string): AgentKey;
  awake(agent: string): boolean;
  busy(agent: string): boolean;
  freeSlot(): boolean;
  /** what a draft for `agent` may spend, at most `cap` USD; or why not */
  budget(agent: string, cap: number): { usd: number } | { usd: null; why: string };
  /** runs `job` as an attempt of `agent`: holds a slot, meters to its vault; resolves when it ended */
  run(agent: string, maxUsd: number, job: (meter: DraftJob["meter"]) => Promise<void>): void;
}

interface ProposalView {
  proposal_id: string;
  repo: string;
  class: string;
  status: string;
  reason: string | null;
  replays: { status: string; round: number }[];
  round: number;
}

export class UnitSetup {
  private cfg: Required<UnitSetupConfig>;
  private life = new Map<string, string>();
  private readAt = -Infinity;
  private proposals: ProposalView[] = [];
  private reasons = new Map<string, string>();
  private final = new Set<string>();
  /** agent -> its repository, as of the last tick */
  private repoOf = new Map<string, string>();
  /** repository -> the agent drafting for it now */
  private jobs = new Map<string, string>();
  private reading = new Set<string>();

  constructor(cfg: UnitSetupConfig | undefined, private host: SetupHost, private work: UnitSetupWork) {
    this.cfg = { ...UNIT_SETUP_DEFAULTS, ...(cfg ?? {}) };
  }

  /** True while Core has the agent in `setting_up`: it has no unit to author on. */
  settingUp(agent: string): boolean {
    return this.cfg.enabled && this.life.get(agent) === "setting_up";
  }

  /** Why the agent is not working yet; `final` when its repository cannot have a unit as it stands. */
  reason(agent: string): { why: string; final: boolean } | null {
    const why = this.reasons.get(agent);
    return why ? { why, final: this.final.has(agent) } : null;
  }

  /**
   * The last trial that failed for the agent's repository, raw cause included, while its setup is not
   * done: for the spend report's `setup` field (the agent's Runway panel). Null when no trial failed.
   */
  detail(agent: string): SetupDetail | null {
    const repo = this.repoOf.get(agent);
    const t = repo ? (this.host.store()[repo]?.trials ?? []).filter((x) => !x.ok && x.reason).at(-1) : undefined;
    return t ? { draft: t.draft, trial: t.n, stage: t.reason!.stage, kind: t.reason!.kind, cause: oneLine(t.reason!.cause), seconds: t.reason!.seconds ?? t.seconds ?? null, at: t.at } : null;
  }

  private entry(repo: string): RepoSetup {
    const s = this.host.store();
    return (s[repo] ??= emptySetup());
  }

  async tick(): Promise<void> {
    if (!this.cfg.enabled) return;
    const now = this.host.now();
    if (now - this.readAt >= 30_000 || this.readAt > now) {
      const r = await this.host.core.get("/v1/agents?hidden=1").catch(() => null);
      if (r?.status === 200 && Array.isArray(r.body)) {
        const next = new Map<string, string>();
        for (const a of r.body as { agent_id?: unknown; lifecycle?: unknown }[]) if (typeof a.agent_id === "string" && typeof a.lifecycle === "string") next.set(a.agent_id, a.lifecycle);
        for (const [agent, was] of this.life) if (was === "setting_up" && next.get(agent) === "active") this.host.log(`${agent.slice(0, 6)} is active: its repository has a unit now`);
        this.life = next;
        this.readAt = now;
        if ([...next.values()].includes("setting_up")) {
          const p = await this.host.core.get("/v1/recipe-proposals").catch(() => null);
          if (p?.status === 200 && Array.isArray(p.body)) this.proposals = p.body as ProposalView[];
        }
      }
    }
    const byRepo = new Map<string, string[]>();
    for (const a of this.host.agents()) {
      if (this.life.get(a.agent) !== "setting_up" || !a.target_repo) continue;
      byRepo.set(a.target_repo, [...(byRepo.get(a.target_repo) ?? []), a.agent]);
    }
    this.reasons.clear();
    this.final.clear();
    this.repoOf.clear();
    for (const [repo, agents] of byRepo) for (const a of agents) this.repoOf.set(a, repo);
    for (const [repo, agents] of byRepo) {
      try {
        this.step(repo, agents.sort());
      } catch (e) {
        this.host.log(`unit setup for ${repoLabel(repo)}: ${(e as Error).message}`);
      }
    }
  }

  private say(agents: string[], why: string, final = false) {
    for (const a of agents) {
      this.reasons.set(a, plain(why));
      if (final) this.final.add(a);
    }
  }

  private step(repo: string, agents: string[]): void {
    const now = this.host.now();
    const s = this.entry(repo);
    const label = repoLabel(repo);
    const mine = this.proposals.filter((p) => p.repo === repo);
    const open = mine.find((p) => p.status === "waiting" || p.status === "calibrating");
    if (open) {
      const round = open.replays.filter((r) => r.round === open.round);
      const done = round.filter((r) => r.status === "revealed" || r.status === "committed").length;
      return this.say(agents, open.status === "waiting"
        ? `setting up: the unit drafted for ${label} waits for enough verifiers qualified for ${CLASS_LABEL[open.class] ?? open.class} units to calibrate it`
        : `setting up: verifiers are calibrating the unit drafted for ${label} (${done} of ${round.length} measured)`);
    }
    for (const p of mine) {
      if (p.status !== "rejected" || p.proposal_id !== s.proposal_id || s.rejected.includes(p.proposal_id)) continue;
      s.rejected.push(p.proposal_id);
      if (s.rejected.length > 20) s.rejected.splice(0, s.rejected.length - 20);
      this.failed(s, label, `the verifiers' calibrations of draft ${s.drafts} did not agree (${p.reason ?? "no reason given"})`);
    }
    if (mine.some((p) => p.status === "accepted")) return this.say(agents, `setting up: the unit for ${label} was created; work starts shortly`);
    // our proposal is not in the list read last (Core was not reachable since): no second draft on top of it
    if (s.proposal_id && !mine.some((p) => p.proposal_id === s.proposal_id) && now - (s.proposed_at ?? 0) < 600_000) {
      this.readAt = -Infinity;
      return this.say(agents, `setting up: the unit drafted for ${label} was proposed and goes to the verifiers`);
    }
    const drafter = this.jobs.get(repo);
    if (drafter) {
      this.say(agents.filter((a) => a !== drafter), `setting up: agent ${drafter.slice(0, 6)} is drafting the unit for ${label}; one draft serves every agent of the repository`);
      return this.say([drafter], `setting up: drafting the unit for ${label} (draft ${s.drafts + 1} of ${this.cfg.max_drafts})`);
    }
    // the free reading: at first sight, then every recheck_s (a new head commit, tests added)
    if ((!s.screened_at || now - s.screened_at >= this.cfg.recheck_s * 1000) && !this.reading.has(repo) && s.next_at <= now) void this.readNow(repo, s, label);
    if (!s.screened_at) return this.say(agents, s.last_reason ? `setting up: ${s.last_reason}; next try ${hhmm(s.next_at)}` : `setting up: reading ${label}`);
    if (s.impossible) return this.say(agents, `no unit possible for ${label}: ${s.impossible}`, true);
    if (s.drafts >= this.cfg.max_drafts || s.usd >= this.cfg.repo_max_usd)
      return this.say(agents, `unit setup for ${label} stopped after ${s.drafts} draft${s.drafts === 1 ? "" : "s"} and ${s.usd.toFixed(2)} USD: ${s.last_reason ?? "no draft passed"}`, true);
    if (s.next_at > now) return this.say(agents, `setting up: ${s.last_reason ?? "the last draft did not pass"}; next try ${hhmm(s.next_at)}`);
    const bound = agents.filter((a) => this.host.agents().find((x) => x.agent === a)?.status === "bound");
    if (!bound.length) return this.say(agents, `setting up: waiting for the launcher to bind the agent to the hosted runtime; its first job is then to draft the unit for ${label}`);
    const cap = Math.min(this.cfg.draft_max_usd, this.cfg.repo_max_usd - s.usd);
    let why = "asleep (vault below the wake threshold)";
    for (const a of bound) {
      if (!this.host.awake(a) || this.host.busy(a)) continue;
      const b = this.host.budget(a, cap);
      if (b.usd === null) {
        why = b.why;
        continue;
      }
      if (!this.host.freeSlot()) return this.say(agents, `setting up: the draft of the unit for ${label} starts when a slot is free`);
      return this.start(repo, s, label, a, b.usd, agents);
    }
    this.say(agents, `setting up: no agent of ${label} can pay for the draft of its unit now (${why})`);
  }

  /** `reason` is the public one (fixed words); `raw` is the sandbox's own cause, for the log only. */
  private failed(s: RepoSetup, label: string, reason: string, raw?: string): void {
    s.last_reason = plain(reason, 200);
    s.next_at = this.host.now() + Math.min(this.cfg.retry_s * 2 ** Math.max(0, s.drafts - 1), 21_600) * 1000;
    this.host.save();
    this.host.log(`unit setup for ${label}: ${s.last_reason}${raw ? ` [${raw}]` : ""}; ${s.drafts >= this.cfg.max_drafts ? "no draft left" : `next draft ${hhmm(s.next_at)}`}`);
  }

  /** Keeps a draft's trials (with why each failed) and where its files are. */
  private keep(s: RepoSetup, draft: number, r: DraftFacts, now: number): void {
    const add = (r.trials ?? []).map((t): SetupTrial => ({ draft, at: now, n: t.n, ok: t.ok, seconds: t.seconds, reason: t.reason ? { ...t.reason, cause: oneLine(t.reason.cause) } : null }));
    if (add.length) s.trials = [...(s.trials ?? []), ...add].slice(-SETUP_TRIALS_KEPT);
    if (r.dir) s.last_dir = r.dir;
  }

  private async readNow(repo: string, s: RepoSetup, label: string): Promise<void> {
    this.reading.add(repo);
    const now = () => this.host.now();
    try {
      const r = await this.work.read(repo);
      // a new head commit gives a stopped or impossible repository a fresh set of drafts, at most once a week
      if (s.head && r.commit && r.commit !== s.head && (s.impossible || s.drafts >= this.cfg.max_drafts || s.usd >= this.cfg.repo_max_usd) && now() - (s.reset_at ?? 0) >= 7 * 86_400_000) {
        Object.assign(s, { drafts: 0, usd: 0, errors: 0, next_at: 0, last_reason: null, impossible: null, impossible_by: null, reset_at: now(), trials: [], last_dir: null });
        this.host.log(`unit setup for ${label}: new head commit ${r.commit.slice(0, 7)}; starting over`);
      }
      s.head = r.commit;
      s.class = r.class;
      s.screened_at = now();
      if (!r.ok) {
        if (s.impossible !== r.impossible) this.host.log(`unit setup for ${label}: no unit possible: ${r.impossible}`);
        s.impossible = plain(r.impossible, 230);
        s.impossible_by = "reading";
      } else if (s.impossible_by === "reading") {
        s.impossible = null;
        s.impossible_by = null;
      }
      if (s.screened_at && !s.drafts) s.last_reason = null;
      s.errors = 0;
    } catch (e) {
      s.errors++;
      s.last_reason = plain((e as Error).message, 160);
      s.next_at = now() + Math.min(60 * 2 ** (s.errors - 1), 3600) * 1000;
      this.host.log(`unit setup for ${label}: ${s.last_reason}; next try ${hhmm(s.next_at)}`);
    } finally {
      this.reading.delete(repo);
      this.host.save();
    }
  }

  private start(repo: string, s: RepoSetup, label: string, agent: string, maxUsd: number, agents: string[]): void {
    this.jobs.set(repo, agent);
    this.say(agents.filter((a) => a !== agent), `setting up: agent ${agent.slice(0, 6)} is drafting the unit for ${label}; one draft serves every agent of the repository`);
    this.say([agent], `setting up: drafting the unit for ${label} (draft ${s.drafts + 1} of ${this.cfg.max_drafts})`);
    this.host.log(`${agent.slice(0, 6)} drafts the unit for ${label} at ${s.head!.slice(0, 7)} (${s.class}; draft ${s.drafts + 1} of ${this.cfg.max_drafts}, cap ${maxUsd.toFixed(4)} USD)`);
    this.host.run(agent, maxUsd, async (meter) => {
      let spent = 0;
      const counted: DraftJob["meter"] = { model: (u) => ((spent += u.usd), meter.model(u)), sandbox: (sec) => meter.sandbox(sec) };
      let r: DraftResult | { kind: "error"; reason: string };
      try {
        r = await this.work.draft({ repo, commit: s.head!, class: s.class!, agent, key: this.host.keyOf(agent), capUsd: maxUsd, meter: counted, history: historyOf(s), resume: s.last_dir ?? null, log: (m) => this.host.log(`${agent.slice(0, 6)} ${m.split("\n")[0]!.slice(0, 300)}`) });
      } catch (e) {
        r = { kind: "error", reason: (e as Error).message };
      } finally {
        this.jobs.delete(repo);
      }
      s.usd += spent;
      const now = this.host.now();
      if (r.kind === "proposed") {
        s.drafts++;
        s.errors = 0;
        this.keep(s, s.drafts, r, now);
        s.proposal_id = r.proposal_id;
        s.proposed_at = now;
        s.last_reason = null;
        this.readAt = -Infinity; // read the proposal on the next tick
        this.host.log(`${agent.slice(0, 6)} proposed the unit ${r.name} for ${label} (proposal ${r.proposal_id.slice(0, 12)}, ${spent.toFixed(4)} USD); the verifiers calibrate it now`);
      } else if (r.kind === "impossible") {
        s.drafts++;
        s.errors = 0;
        s.impossible = plain(r.reason, 230);
        s.impossible_by = "drafter";
        this.host.log(`unit setup for ${label}: no unit possible: ${s.impossible} (${spent.toFixed(4)} USD)`);
      } else if (r.kind === "failed") {
        s.drafts++;
        s.errors = 0;
        this.keep(s, s.drafts, r, now);
        const last = (r.trials ?? []).filter((t) => !t.ok && t.reason).at(-1);
        this.failed(s, label, `draft ${s.drafts} of ${this.cfg.max_drafts} did not pass: ${r.reason}`, last ? reasonLine(last.reason!) : undefined);
      } else if (r.kind === "blocked") {
        s.last_reason = plain(r.reason, 200);
        s.next_at = now + this.cfg.recheck_s * 1000;
        this.host.log(`unit setup for ${label}: ${s.last_reason}; checked again ${hhmm(s.next_at)}`);
      } else {
        // the draft could not run (model or sandbox down): not a draft, a doubling wait up to an hour
        s.errors++;
        s.last_reason = plain(`the draft could not run (${r.reason})`, 200);
        s.next_at = now + Math.min(60 * 2 ** (s.errors - 1), 3600) * 1000;
        this.host.log(`unit setup for ${label}: ${s.last_reason}; next try ${hhmm(s.next_at)}`);
      }
      this.host.save();
    });
  }
}
