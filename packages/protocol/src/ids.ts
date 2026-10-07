import { canonicalJson, H, hashJson } from "./hash.ts";
import type { CandidateKind, Hex, Recipe } from "./types.ts";

// Identifier derivations, SPEC section 4.

export function canonicalUrl(url: string): string {
  let u = url.trim().toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
  u = u.replace(/^git@github\.com:/, "https://github.com/").replace(/^http:\/\//, "https://");
  return u;
}

export const repoId = (url: string): Hex => H("repo", canonicalUrl(url));
export const snapshotId = (repo_id: Hex, commit: string, deps_digest: Hex): Hex =>
  H("snap", repo_id, commit.toLowerCase(), deps_digest);
export const recipeId = (recipe: Recipe): Hex => H("recipe", hashJson(recipe));
export const calibId = (recipe_id: Hex, snapshot_id: Hex, result: unknown): Hex =>
  H("calib", recipe_id, snapshot_id, hashJson(result));
export const lineageId = (snapshot_id: Hex, recipe_id: Hex): Hex => H("lineage", snapshot_id, recipe_id);
export const gen0 = (lineage_id: Hex): Hex => H("gen", lineage_id);
export const genId = (parent_gen_id: Hex, patch_hash: Hex, verdict_digest: Hex): Hex =>
  H("gen", parent_gen_id, patch_hash, verdict_digest);

export function candidateId(p: {
  lineage_id: Hex;
  parent_gen_id: Hex;
  patch_hash: Hex;
  author: string;
  kind: CandidateKind;
  target: string | string[];
}): Hex {
  // canonical JSON of the sorted list: joining with "," would let ["a,b"] collide with ["a","b"]
  const target = Array.isArray(p.target) ? canonicalJson([...p.target].sort()) : p.target;
  return H("cand", p.lineage_id, p.parent_gen_id, p.patch_hash, p.author, p.kind, target);
}

/** Candidate commitment: binds the patch before it is revealed. */
export const patchCommitment = (patch_hash: Hex, salt: Hex): Hex => H("commit-patch", patch_hash, salt);
/** Replay commitment: binds a result before any other replay is visible. */
export const resultCommitment = (result: unknown, salt: Hex): Hex => H("commit-result", hashJson(result), salt);

export const assignmentSeed = (beacon: Hex, candidate_id: Hex): Hex => H("assign", beacon, candidate_id);
export const replaySeed = (assignment_seed: Hex, replayer: string): Hex => H("replay-seed", assignment_seed, replayer);
export const findingKey = (lineage_id: Hex, tip: Hex, kind: string, target: string): Hex =>
  H("finding", lineage_id, tip, kind, target);
export const commitBeacon = (epoch_secret: Hex): Hex => H("beacon-commit", epoch_secret);
