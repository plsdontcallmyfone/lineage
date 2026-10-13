import type { Recipe } from "@units/protocol";
import { hhmm, plain, repoLabel, type DraftJob, type DraftResult, type SetupHost, type UnitSetupWork } from "./unit-setup.ts";

// More units per repository (docs/plans/AGENT-EFFICIENCY.md 8.2). A repository's first unit comes from
// unit setup (unit-setup.ts). Once every active unit of a repository has run dry (Core's signal,
// GET /v1/units/dry: most recent attempts found nothing more to improve), this runtime has ONE bound
// agent of the repository draft another unit on it: the same drafter, told what the existing units
// measure and what attempts already achieved, on the same commit and image as the repository's own
// units, metered to that agent's compute vault like an attempt. The proposal goes through the same
// verifier calibration; Core refuses a duplicate before any verifier is drawn and rejects a
// calibration that does not show headroom.
//
// Nothing is drafted, and the reason is kept, when: a unit of the repository is not dry; the
// repository is at max_per_repo units; its newest unit, or its last used-up set of drafts, is younger
// than cooldown_days; a proposal for it is with the verifiers; no agent of it can pay (an empty vault
// drafts on network compute only with on_network_compute, off by default).

export interface MoreUnitsConfig {
  /** true: additional units are drafted. Off unless set (default false): a draft spends an agent's vault, so a deployment turns it on by name */
  enabled?: boolean;
  /** active units of one repository, the first included */
  max_per_repo?: number;
  /** drafts per additional unit before the repository cools down */
  max_drafts?: number;
  /** the most one draft may spend on model calls, USD */
  draft_max_usd?: number;
  /** model spend on drafts per repository per cool-down, USD */
  repo_max_usd?: number;
  /** days from the creation of the repository's newest unit, and from a set of drafts that ran out, to the next draft */
  cooldown_days?: number;
  /** wait after a draft that did not pass, doubling per draft, at most 6 h */
  retry_s?: number;
  /** true: an agent whose vault cannot pay may draft on network compute (the platform's balance, under the global cap) */
  on_network_compute?: boolean;
  /** how often the dry signal is read, seconds */
  check_s?: number;
  /** trial calibrations per draft */
  max_trials?: number;
}

export const MORE_UNITS_DEFAULTS = { enabled: false, max_per_repo: 3, max_drafts: 2, draft_max_usd: 1.5, repo_max_usd: 3, cooldown_days: 7, retry_s: 1800, on_network_compute: false, check_s: 300, max_trials: 4 };

export function moreUnitsError(v: unknown): string | null {
  if (v === undefined) return null;
  if (!v || typeof v !== "object" || Array.isArray(v)) return "more_units is an object";
  const c = v as Record<string, unknown>;
  for (const k of Object.keys(c)) if (!k.startsWith("_") && !(k in MORE_UNITS_DEFAULTS)) return `more_units.${k} is not a setting`;
  for (const k of ["enabled", "on_network_compute"]) if (c[k] !== undefined && typeof c[k] !== "boolean") return `more_units.${k} is true or false`;
  for (const k of ["draft_max_usd", "repo_max_usd"]) if (c[k] !== undefined && !(typeof c[k] === "number" && (c[k] as number) > 0 && (c[k] as number) <= 50)) return `more_units.${k} is above 0 and at most 50 USD`;
  for (const k of ["max_per_repo", "max_drafts", "max_trials"]) if (c[k] !== undefined && !(Number.isInteger(c[k]) && (c[k] as number) >= 1 && (c[k] as number) <= 20)) return `more_units.${k} is a whole number from 1 to 20`;
  if (c.cooldown_days !== undefined && !(typeof c.cooldown_days === "number" && c.cooldown_days >= 0 && c.cooldown_days <= 365)) return "more_units.cooldown_days is from 0 to 365 days";
  for (const k of ["retry_s", "check_s"]) if (c[k] !== undefined && !(typeof c[k] === "number" && (c[k] as number) >= 1)) return `more_units.${k} is at least 1 second`;
  return null;
}

/** What the runtime keeps per repository (state.json `more_units`). */
export interface RepoMore {
  /** drafts run in the current set and their model spend (USD, with the route's fee) */
  drafts: number;
  usd: number;
  /** drafts that could not run at all in a row */
  errors: number;
  /** no new draft before this time */
  next_at: number;
  /** when the current set of drafts ran out (the cool-down counts from it) */
  done_at: number | null;
  last_reason: string | null;
  proposal_id: string | null;
  proposed_at?: number;
  rejected: string[];
  /** additional units this runtime's agents got accepted for the repository */
  created: number;
}

const emptyMore = (): RepoMore => ({ drafts: 0, usd: 0, errors: 0, next_at: 0, done_at: null, last_reason: null, proposal_id: null, rejected: [], created: 0 });

/** One unit of Core's dry signal (GET /v1/units/dry). */
export interface DryUnit {
  lineage_id: string;
  recipe_name: string;
  repo: string;
  created_at: number;
  dry: boolean;
  fresh: boolean;
  line: string | null;
}

interface ProposalView {
  proposal_id: string;
  repo: string;
  status: string;
  reason: string | null;
}

export interface MoreHost extends Omit<SetupHost, "store" | "run" | "budget"> {
  /** state.json `more_units` (created on first use) */
  store(): Record<string, RepoMore>;
  /** true while Core has the agent setting up (its repository has no unit): unit setup works for it, not this */
  settingUp(agent: string): boolean;
  /** what a draft for `agent` may spend from its vault, at most `cap` USD; or why not (`vault`: the vault is the reason) */
  budget(agent: string, cap: number): { usd: number } | { usd: null; why: string; vault?: boolean };
  /** true while the network pays for the agent's attempts (platform funding on, and only its vault stands in the way) */
  covered(agent: string): boolean;
  /** what a draft on network compute may spend, at most `cap` USD; or why not */
  networkBudget(agent: string, cap: number): { usd: number } | { usd: null; why: string };
  /** runs `job` as an attempt of `agent`: holds a slot, meters to its vault (or to the network when `network`) */
  run(agent: string, maxUsd: number, job: (meter: DraftJob["meter"]) => Promise<void>, network: boolean): void;
}

export type MoreState = "idle" | "not_dry" | "limit" | "cooldown" | "used_up" | "waiting" | "calibrating" | "no_payer" | "no_slot" | "drafting";

export class MoreUnits {
  private cfg: typeof MORE_UNITS_DEFAULTS;
  private readAt = -Infinity;
  private units: DryUnit[] | null = null;
  private proposals: ProposalView[] = [];
  /** repository -> the agent drafting for it now */
  private jobs = new Map<string, string>();
  private states = new Map<string, { state: MoreState; why: string }>();
  private told = false;

  constructor(cfg: MoreUnitsConfig | undefined, private host: MoreHost, private work: UnitSetupWork) {
    this.cfg = { ...MORE_UNITS_DEFAULTS, ...(cfg ?? {}) };
  }

  /** Where each repository of this runtime's agents stands, with the reason in one sentence. */
  status(): Record<string, { state: MoreState; why: string }> {
    return Object.fromEntries(this.states);
  }

  private entry(repo: string): RepoMore {
    const s = this.host.store();
    return (s[repo] ??= emptyMore());
  }

  async tick(): Promise<void> {
    if (!this.cfg.enabled) return;
    const now = this.host.now();
    if (now - this.readAt >= this.cfg.check_s * 1000 || this.readAt > now) {
      this.readAt = now;
      const d = await this.host.core.get("/v1/units/dry").catch(() => null);
      if (d?.status === 200 && Array.isArray(d.body?.units)) this.units = d.body.units as DryUnit[];
      else {
        // a Core without the signal (an older release): nothing is drafted, said once
        this.units = null;
        if (!this.told) this.host.log(`more units: Core does not serve the dry signal (GET /v1/units/dry: ${d ? `HTTP ${d.status}` : "not reachable"}); no additional unit is drafted`);
        this.told = true;
        return;
      }
      this.told = false;
      const p = await this.host.core.get("/v1/recipe-proposals").catch(() => null);
      if (p?.status === 200 && Array.isArray(p.body)) this.proposals = p.body as ProposalView[];
    }
    if (!this.units) return;
    const byRepo = new Map<string, string[]>();
    for (const a of this.host.agents()) {
      if (a.status !== "bound" || !a.target_repo || this.host.settingUp(a.agent)) continue;
      byRepo.set(a.target_repo, [...(byRepo.get(a.target_repo) ?? []), a.agent]);
    }
    for (const repo of [...this.states.keys()]) if (!byRepo.has(repo)) this.states.delete(repo);
    for (const [repo, agents] of byRepo) {
      const units = this.units.filter((u) => u.repo === repo);
      if (!units.length) continue;
      try {
        this.step(repo, agents.sort(), units);
      } catch (e) {
        this.host.log(`more units for ${repoLabel(repo)}: ${(e as Error).message}`);
      }
    }
  }

  private say(repo: string, state: MoreState, why: string): void {
    const w = plain(why);
    const was = this.states.get(repo);
    this.states.set(repo, { state, why: w });
    // logged when it changes; "not dry" is the ordinary case and is not news
    if (state !== "not_dry" && state !== "idle" && (!was || was.state !== state || was.why !== w)) this.host.log(`more units for ${repoLabel(repo)}: ${w}`);
  }

  private step(repo: string, agents: string[], units: DryUnit[]): void {
    const now = this.host.now();
    const s = this.entry(repo);
    const label = repoLabel(repo);
    const mine = this.proposals.filter((p) => p.repo === repo);
    const open = mine.find((p) => p.status === "waiting" || p.status === "calibrating");
    if (open) return this.say(repo, open.status === "waiting" ? "waiting" : "calibrating", `the additional unit drafted for ${label} is with the verifiers`);
    for (const p of mine) {
      if (p.proposal_id !== s.proposal_id || s.rejected.includes(p.proposal_id)) continue;
      if (p.status === "rejected") {
        s.rejected.push(p.proposal_id);
        if (s.rejected.length > 20) s.rejected.splice(0, s.rejected.length - 20);
        this.failed(s, label, `the verifiers' calibrations of draft ${s.drafts} did not pass (${p.reason ?? "no reason given"})`);
      } else if (p.status === "accepted") {
        // the unit exists: the set of drafts is closed, and the cool-down now counts from the new unit's creation
        Object.assign(s, { ...emptyMore(), created: s.created + 1, rejected: s.rejected });
        this.readAt = -Infinity;
        this.host.save();
        this.host.log(`more units for ${label}: the additional unit was created; agents pick it by its headroom`);
        return this.say(repo, "idle", `an additional unit for ${label} was created`);
      }
    }
    // our proposal is not in the list read last: no second draft on top of it
    if (s.proposal_id && !mine.some((p) => p.proposal_id === s.proposal_id) && now - (s.proposed_at ?? 0) < 600_000) {
      this.readAt = -Infinity;
      return this.say(repo, "waiting", `the additional unit drafted for ${label} was proposed and goes to the verifiers`);
    }
    const drafter = this.jobs.get(repo);
    if (drafter) return this.say(repo, "drafting", `agent ${drafter.slice(0, 6)} is drafting an additional unit for ${label} (draft ${s.drafts + 1} of ${this.cfg.max_drafts})`);
    const wet = units.filter((u) => !u.dry);
    if (wet.length) return this.say(repo, "not_dry", `${wet.length} of ${units.length} unit${units.length === 1 ? "" : "s"} of ${label} still ${wet.length === 1 ? "has" : "have"} gains to find (${wet.map((u) => u.recipe_name).join(", ")})`);
    if (units.length >= this.cfg.max_per_repo)
      return this.say(repo, "limit", `every unit of ${label} has run dry, and it has ${units.length} units, the most a repository may have (more_units.max_per_repo ${this.cfg.max_per_repo}); no additional unit is drafted`);
    const cool = this.cfg.cooldown_days * 86_400_000;
    const newest = Math.max(...units.map((u) => u.created_at));
    // between additional units: the repository's first unit may run dry within days, and is not made to wait
    if (units.length > 1 && now - newest < cool)
      return this.say(repo, "cooldown", `every unit of ${label} has run dry, but its newest unit is ${((now - newest) / 86_400_000).toFixed(1)} days old; another is drafted ${this.cfg.cooldown_days} days after it (more_units.cooldown_days), from ${new Date(newest + cool).toISOString().slice(0, 16).replace("T", " ")} UTC`);
    if (s.done_at !== null) {
      if (now - s.done_at < cool)
        return this.say(repo, "used_up", `the drafts of an additional unit for ${label} are used up (${s.drafts} draft${s.drafts === 1 ? "" : "s"}, ${s.usd.toFixed(2)} USD: ${s.last_reason ?? "no draft passed"}); a new set starts ${new Date(s.done_at + cool).toISOString().slice(0, 16).replace("T", " ")} UTC`);
      Object.assign(s, { drafts: 0, usd: 0, errors: 0, next_at: 0, done_at: null, last_reason: null });
      this.host.save();
    }
    if (s.drafts >= this.cfg.max_drafts || s.usd >= this.cfg.repo_max_usd) {
      s.done_at = now;
      this.host.save();
      return this.say(repo, "used_up", `the drafts of an additional unit for ${label} are used up (${s.drafts} draft${s.drafts === 1 ? "" : "s"}, ${s.usd.toFixed(2)} USD: ${s.last_reason ?? "no draft passed"})`);
    }
    if (s.next_at > now) return this.say(repo, "waiting", `${s.last_reason ?? "the last draft of an additional unit did not pass"}; next try ${hhmm(s.next_at)}`);
    const cap = Math.min(this.cfg.draft_max_usd, this.cfg.repo_max_usd - s.usd);
    let why = "no agent of the repository is free";
    let vault = false;
    for (const a of agents) {
      if (this.host.busy(a)) continue;
      const b = this.host.budget(a, cap);
      let usd: number;
      let network = false;
      if (b.usd === null) {
        why = b.why;
        vault ||= b.vault === true;
        // an empty vault spends the platform's money on a draft only when the setting says so
        if (!(b.vault === true && this.cfg.on_network_compute && this.host.covered(a))) continue;
        const nb = this.host.networkBudget(a, cap);
        if (nb.usd === null) {
          why = nb.why;
          continue;
        }
        usd = nb.usd;
        network = true;
      } else usd = b.usd;
      if (!this.host.freeSlot()) return this.say(repo, "no_slot", `the draft of an additional unit for ${label} starts when a slot is free`);
      return this.start(repo, s, label, a, usd, network, units);
    }
    this.say(repo, "no_payer", `every unit of ${label} has run dry, but no agent of it can pay for the draft of an additional unit now (${why})${vault && !this.cfg.on_network_compute ? "; a draft is not paid from network compute (more_units.on_network_compute is off)" : ""}`);
  }

  private failed(s: RepoMore, label: string, reason: string): void {
    s.last_reason = plain(reason, 200);
    s.next_at = this.host.now() + Math.min(this.cfg.retry_s * 2 ** Math.max(0, s.drafts - 1), 21_600) * 1000;
    this.host.save();
    this.host.log(`more units for ${label}: ${s.last_reason}; ${s.drafts >= this.cfg.max_drafts ? "no draft left in this set" : `next draft ${hhmm(s.next_at)}`}`);
  }

  private start(repo: string, s: RepoMore, label: string, agent: string, maxUsd: number, network: boolean, units: DryUnit[]): void {
    this.jobs.set(repo, agent);
    this.say(repo, "drafting", `agent ${agent.slice(0, 6)} is drafting an additional unit for ${label} (draft ${s.drafts + 1} of ${this.cfg.max_drafts}, cap ${maxUsd.toFixed(4)} USD${network ? ", on network compute" : ""}): every one of its ${units.length} unit${units.length === 1 ? "" : "s"} has run dry`);
    this.host.run(agent, maxUsd, async (meter) => {
      let spent = 0;
      const counted: DraftJob["meter"] = { model: (u) => ((spent += u.usd), meter.model(u)), sandbox: (sec) => meter.sandbox(sec) };
      let r: DraftResult | { kind: "error"; reason: string };
      try {
        // commit and class are the existing units' own: the drafter's work reads them from Core
        r = await this.work.draft({ repo, commit: "", class: "" as Recipe["class"], agent, key: this.host.keyOf(agent), capUsd: maxUsd, meter: counted, more: { units: units.map((u) => u.lineage_id) }, log: (m) => this.host.log(`${agent.slice(0, 6)} ${m.split("\n")[0]!.slice(0, 300)}`) });
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
        s.proposal_id = r.proposal_id;
        s.proposed_at = now;
        s.last_reason = null;
        this.readAt = -Infinity; // read the proposal on the next tick
        this.host.log(`${agent.slice(0, 6)} proposed the additional unit ${r.name} for ${label} (proposal ${r.proposal_id.slice(0, 12)}, ${spent.toFixed(4)} USD); the verifiers calibrate it now`);
      } else if (r.kind === "impossible") {
        // the drafter found nothing more to measure: the set is closed, and the cool-down runs before another look
        s.drafts++;
        s.errors = 0;
        s.done_at = now;
        s.last_reason = plain(`the drafter found nothing more to measure: ${r.reason}`, 200);
        this.host.log(`more units for ${label}: ${s.last_reason} (${spent.toFixed(4)} USD)`);
      } else if (r.kind === "failed") {
        s.drafts++;
        s.errors = 0;
        this.failed(s, label, `draft ${s.drafts} of ${this.cfg.max_drafts} of an additional unit did not pass: ${r.reason}`);
      } else if (r.kind === "blocked") {
        s.last_reason = plain(r.reason, 200);
        s.next_at = now + 21_600_000;
        this.host.log(`more units for ${label}: ${s.last_reason}; checked again ${hhmm(s.next_at)}`);
      } else {
        // the draft could not run (model or sandbox down): not a draft, a doubling wait up to an hour
        s.errors++;
        s.last_reason = plain(`the draft could not run (${r.reason})`, 200);
        s.next_at = now + Math.min(60 * 2 ** (s.errors - 1), 3600) * 1000;
        this.host.log(`more units for ${label}: ${s.last_reason}; next try ${hhmm(s.next_at)}`);
      }
      this.host.save();
    }, network);
  }
}
