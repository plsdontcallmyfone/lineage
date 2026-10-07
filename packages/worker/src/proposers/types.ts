import type { Calibration, CandidateKind } from "@lineage/protocol";
import type { DepsLayer, LoadedRecipe, PhaseCallback } from "@lineage/sandbox";
import type { ActivityInput } from "../telemetry.ts";

export interface Finding {
  key: string;
  kind: "known_failure" | "metric_target" | string;
  target: string;
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
}
