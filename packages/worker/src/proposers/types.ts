import type { Calibration, CandidateKind, GuardRule } from "@units/protocol";
import type { GuardRegression } from "../guard-limits.ts";
import type { DepsLayer, LoadedRecipe, PhaseCallback } from "@units/sandbox";
import type { ActivityInput } from "../telemetry.ts";
import type { SessionEventInput } from "../session.ts";

export interface Finding {
  key: string;
  kind: "known_failure" | "metric_target" | string;
  target: string;
}

/** A public intent (SPEC 12.1): who says it works on which target of this lineage, advisory only. */
export interface IntentView {
  intent_id: string;
  agent: string;
  kind: CandidateKind;
  target: string | string[];
  note: string | null;
  expires_at: number;
  status: string;
}

/** The target a proposer means to work on, chosen before it edits so its intent is filed first. */
export interface PlannedTarget {
  kind: CandidateKind;
  target: string | string[];
  note?: string;
}

/** A public board message (SPEC 12.3). */
export interface BoardNote {
  from: string;
  body: string;
  ref: { kind: string; id: string } | null;
  received_at: number;
}

/** A direct message as the recipient reads it; `body` is null when it could not be opened. */
export interface InboxMessage {
  msg_id: string;
  from: string;
  body: string | null;
  sealed: boolean;
  thread: string | null;
  ref: { kind: string; id: string } | null;
  received_at: number;
}

export interface ProposeContext {
  loaded: LoadedRecipe;
  deps: DepsLayer;
  calibration: Calibration;
  /** canonical diffs gen_1..parent, applied in order */
  parentPatches: string[];
  findings: Finding[];
  /** a writable checkout of the parent generation; the proposer edits files here */
  tree: string;
  /** seed for the author's own measurements (never the replay seed) */
  seed: string;
  log: (msg: string) => void;
  /** Live activity (SPEC 17.1): what the proposer actually reads, searches, edits and evaluates. Best effort, never throws. */
  activity?: (e: ActivityInput) => void;
  /** Authoring session (SPEC 17.3): every tool call with its contents; Core seals the contents until the candidate is final. Never throws. */
  session?: (e: SessionEventInput) => void;
  /** Sandbox phases of the proposer's own evaluations, for heartbeats. */
  onPhase?: PhaseCallback;
  /** Live intents on this lineage (worker --collab advisory or team), the worker's own included. */
  intents?: IntentView[];
  /** This worker's agent id, to tell its own intents from others'. */
  self?: string;
  /** advisory: prefer targets nobody else holds an intent on (SPEC 12.1). */
  collab?: "off" | "advisory" | "team";
  /** What plan() chose, if the proposer has a plan step. */
  planned?: PlannedTarget | null;
  /** Recent public notes on this lineage's board (SPEC 12.3), oldest first. Never patch text. */
  board?: BoardNote[];
  /** Direct messages delivered to this agent, sealed ones opened with its encryption key (SPEC 12.3). */
  inbox?: InboxMessage[];
  /** Stacked series (SPEC 12.4): the commit this attempt builds on; its patch is the last of parentPatches. */
  dependsOn?: string | null;
  /** Soul block (SPEC 14.8) appended to the system prompt after the rules; taste and voice only. */
  soul?: string | null;
  /** Agent journal (SPEC 17.6): the agent's own recent notes, labelled, appended to the system prompt after the soul. */
  notes?: string | null;
  /** Shared findings (docs/plans/AGENT-LEARNINGS.md 12.4): other agents' published outcomes on this unit, labelled, after the notes. */
  shared?: string | null;
  /** Target spread (agent productivity lane): one labelled line of the opening message naming the target the worker suggests for this attempt and why (counts only). */
  suggested?: string | null;
  /** USD the proposer keeps back from the attempt's cap for the journal call at the end (SPEC 17.6). */
  journalReserveUsd?: number;
  /** Running model spend of this attempt in USD; the proposer adds every metered response to it. */
  spent?: { usd: number };
  /** Why the proposer's model loop ended and how many model calls it made (set by the proposer; the worker notes it on its outcome line for the Analytics page). */
  stop?: { why: string; calls: number };
  /** Per-attempt spend cap in USD set by a hosted runtime (its per-agent and global budgets); the proposer uses the lower of this and its own. */
  maxUsd?: number;
  /** Hosted runtime metering (SPEC 13.7): every model response and every sandbox evaluation, as they happen. Never throws into the proposer. */
  meter?: Meter;
  /** Guard limits (SPEC 10.1 rule 6): the rule a candidate committed now is judged with (GET /v1/guard-config); null = none in force. Absent: self-evaluation judges without guards. */
  guardRule?: () => Promise<GuardRule | null>;
  /** Set by the proposer's evaluate: the guarded metric the last evaluation regressed beyond its limit, or null. The worker never submits while it is set. */
  guardRegression?: GuardRegression | null;
}

/** Usage a proposer reports while it works; the hosted runtime turns it into per-agent usage records. */
export interface Meter {
  model(u: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; usd: number; model: string }): void;
  sandbox(seconds: number): void;
  /** Which harness and provider ran the attempt (plan M); provenance attests it. Optional. */
  harness?(h: { name: string; version: string; digest: string; provider: string }): void;
  /** A router's upstream host for a response (OpenRouter's `provider`); provenance lists them. Optional. */
  upstream?(name: string): void;
  /** The route the attempt runs on (plan MODELS-AND-SELF-FUNDING): direct or OpenRouter, for the soul's model. Optional. */
  route?(r: { via: "direct" | "openrouter"; model: { provider: string; id: string }; requested: string }): void;
}

export interface Proposal {
  kind: CandidateKind;
  target: string | string[];
  rationale: string;
  /** author's own measured effect, informational only (SPEC 4.2) */
  claimed_effect?: number;
  /** model spend for this attempt, if any */
  usage?: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; usd: number };
}

export interface Proposer {
  readonly name: string;
  /** Edits ctx.tree in place and describes the change, or returns null when it has nothing. */
  propose(ctx: ProposeContext): Promise<Proposal | null>;
  /**
   * Optional: names the target before any edit, so the worker can file an intent for it first.
   * With ctx.collab "advisory" it should prefer a target nobody else holds an intent on.
   */
  plan?(ctx: ProposeContext): Promise<PlannedTarget | null>;
  /**
   * Optional (SPEC 17.6): writes the session's journal entry with one small, metered model call
   * inside what is left of the attempt's cap (ctx.maxUsd minus ctx.spent). Returns the text, or null.
   */
  journal?(ctx: ProposeContext, req: { system: string; user: string }): Promise<string | null>;
  /**
   * Optional: true once this proposer can never propose again (a scripted proposer whose script is
   * used up). The worker then starts no attempt at all: on the site 18 scripted authors with nothing
   * left kept materializing their unit's tree every 5 seconds, a third of the server's CPU.
   */
  exhausted?(): boolean;
}

/** Targets other agents hold a live intent on (canonical JSON keys). */
export function heldByOthers(ctx: ProposeContext): Set<string> {
  const out = new Set<string>();
  for (const i of ctx.intents ?? []) if (i.agent !== ctx.self && i.status === "open") out.add(targetKey(i.kind, i.target));
  return out;
}

export function targetKey(kind: string, target: string | string[]): string {
  return JSON.stringify([kind, Array.isArray(target) ? [...new Set(target)].sort() : target]);
}
