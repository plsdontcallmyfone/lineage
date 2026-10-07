// Shared protocol types. Field names follow docs/SPEC.md section 4.

export type Hex = string;

export type CandidateKind = "perf" | "fix" | "slim";
export type Direction = "lower" | "higher";

export interface MetricSpec {
  name: string;
  kind: "perf" | "slim";
  direction: Direction;
  deterministic: boolean;
  command: string;
  parser: string;
  holdout?: boolean;
  min_effect: number;
  rounds?: number;
  /** Relative tolerance for deterministic agreement across replays. Defaults to config det_tolerance. */
  tolerance?: number;
}

export interface PatchRules {
  allowed_paths: string[];
  protected_paths: string[];
  /**
   * Blocks inside allowed files that a patch may not change (SPEC 7.1), e.g. inline test modules:
   * a block starts at a line matching `start` (a regular expression) and ends at the line where its
   * braces balance again. Enforced by the sandbox on the applied tree.
   */
  protected_blocks?: { glob: string; start: string }[];
  max_files: number;
  max_lines: number;
}

export interface Limits {
  cpus: number;
  memory_mb: number;
  pids: number;
  wall_s: number;
  disk_mb: number;
}

export type TargetClass = "rust" | "solana" | "zig" | "cuda" | "python" | "go" | "cpp";

/** Hardware a verifier must have to replay a recipe (SPEC 6.1). */
export interface Requires {
  arch: "amd64" | "arm64";
  gpu?: { vendor: "nvidia"; sm: string; min_mem_gb?: number };
  min_cpus?: number;
  min_memory_mb?: number;
}

/** What a verifier declares about itself (SPEC 6.1). */
export interface Capabilities {
  arch: "amd64" | "arm64";
  cpus: number;
  memory_mb: number;
  gpus: { vendor: "nvidia"; model: string; sm: string; mem_gb: number; driver: string }[];
}

export interface Recipe {
  name: string;
  class: TargetClass;
  requires: Requires;
  repo: string;
  commit: string;
  image: string;
  workdir: string;
  prepare: string[];
  /** Files produced by prepare (for example a generated lockfile) copied into every tree. */
  prepare_outputs?: string[];
  build: { commands: string[]; artifacts?: string[]; reproducible?: boolean };
  test: { command: string; parser: string; exclude?: string[]; timeout_s: number };
  equivalence?: { command: string; output: "stdout-digest" };
  metrics: MetricSpec[];
  patch: PatchRules;
  limits: Limits;
  /** Digest of the overlay directory (harness files), part of the recipe identity. */
  overlay_digest?: Hex;
}

export interface Calibration {
  recipe_id: Hex;
  snapshot_id: Hex;
  runs: number;
  stable: string[];
  known_failures: string[];
  quarantined: string[];
  metrics: Record<string, { enabled: boolean; cv: number; base_value?: number; reason?: string }>;
  median_eval_seconds: number;
  /** LINEAGE_SEED the calibration measured with (SPEC 6.1 qualification replays reuse it). */
  seed?: Hex;
}

export type GuardViolation =
  | "PROTECTED_PATH"
  | "OUTSIDE_ALLOWED"
  | "TOO_MANY_FILES"
  | "TOO_MANY_LINES"
  | "BINARY"
  | "SYMLINK"
  | "MODE_CHANGE"
  | "SUBMODULE"
  | "RENAME"
  | "APPLY_CONFLICT"
  | "PROTECTED_REGION"
  | "EMPTY"
  | "MALFORMED";

export interface MetricSamples {
  base: number[];
  cand: number[];
  deterministic: boolean;
}

export interface ReplayResult {
  apply: "ok" | "conflict";
  guard: "ok" | GuardViolation;
  build: { base: "ok" | "fail"; cand: "ok" | "fail" | "skipped"; base_digest?: Hex; cand_digest?: Hex };
  tests: { base_pass: string[]; cand_pass: string[]; cand_fail: string[] };
  equivalence: { base_digest: Hex; cand_digest: Hex } | null;
  metrics: Record<string, MetricSamples>;
  env: { image_digest: string; cpu_model: string; cores: number; worker_version: string };
  transcript_digest: Hex;
}

export interface RevealedReplay {
  replay_id: Hex;
  replayer: string;
  seed: Hex;
  result: ReplayResult;
  /** True when this replayer is the Core reference runner. */
  reference?: boolean;
}

export interface CandidateView {
  candidate_id: Hex;
  author: string;
  kind: CandidateKind;
  /** metric name for perf/slim, test ids for fix */
  target: string | string[];
}

export type RejectReason =
  | "guard"
  | "apply_conflict"
  | "build_fail"
  | "tests_fail"
  | "fix_target_not_fixed"
  | "equivalence_changed"
  | "no_improvement"
  | "metric_disabled"
  | "noisy_split"
  | "env_fail"
  | "insufficient_replays";

export interface MetricEffect {
  metric: string;
  /** cand / base for direction lower, base / cand for higher. Below 1 is an improvement. */
  ratio: number;
  ci_low: number;
  ci_high: number;
  per_replay: { replay_id: Hex; ratio: number; ci_low: number; ci_high: number; pass: boolean }[];
}

export type Verdict =
  | { outcome: "accepted"; effect: MetricEffect | { fixed: string[] }; counted: Hex[]; digest: Hex }
  | { outcome: "rejected"; reason: RejectReason; detail: string; counted: Hex[]; digest: Hex }
  | {
      outcome: "disputed";
      fields: string[];
      /** replay ids that disagree with the per-field majority (empty when there is no majority yet) */
      minority: Hex[];
      counted: Hex[];
      digest: Hex;
    };
