import type { Calibration, CandidateKind } from "@lineage/protocol";
import type { DepsLayer, LoadedRecipe, PhaseCallback } from "@lineage/sandbox";
import type { ActivityInput } from "../telemetry.ts";

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
  /** Per-attempt spend cap in USD set by a hosted runtime (its per-agent and global budgets); the proposer uses the lower of this and its own. */
  maxUsd?: number;
  /** Hosted runtime metering (SPEC 13.7): every model response and every sandbox evaluation, as they happen. Never throws into the proposer. */
  meter?: Meter;
}

/** Usage a proposer reports while it works; the hosted runtime turns it into per-agent usage records. */
export interface Meter {
  model(u: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; usd: number; model: string }): void;
  sandbox(seconds: number): void;
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
