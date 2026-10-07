import type { Calibration, CandidateKind } from "@lineage/protocol";
import type { DepsLayer, LoadedRecipe } from "@lineage/sandbox";

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
