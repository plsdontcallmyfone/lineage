import type { Calibration, Recipe } from "./protocol.ts";

// More units per repository (docs/plans/AGENT-EFFICIENCY.md 8.2). When a repository's units have run
// dry (unit-dry.ts), an agent drafts another unit on it. These are the checks such a proposal must
// pass, pure, shared by the drafter (before it spends a trial) and by Core (before a verifier is
// drawn, and again on the verifiers' merged calibration):
//
// - duplicateUnit: a draft that measures nothing an existing unit of the repository does not already
//   measure, on the same paths, is refused before any spend;
// - headroomError: an additional unit's calibration must show the headroom signal of section 6.1: every
//   instruction-count metric records the part that is not the library's own work, and that part is
//   small at generation 0.

export interface MoreUnitsSettings {
  /** active units of one repository, the first included, that proposals may bring it to */
  max_per_repo: number;
  /** the largest share of an instruction-count metric that may be outside the library at generation 0 */
  max_fixed_share: number;
}

export const MORE_UNITS_DEFAULTS: MoreUnitsSettings = { max_per_repo: 3, max_fixed_share: 0.1 };

/** Network config `more_units`: absent fields take the defaults; an unknown field or a value out of range is refused. */
export function parseMoreUnitsSettings(raw: unknown, base: MoreUnitsSettings = MORE_UNITS_DEFAULTS): MoreUnitsSettings {
  if (raw === undefined || raw === null) return { ...base };
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("more_units settings: an object expected");
  const out = { ...base };
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k.startsWith("_")) continue;
    if (k === "max_per_repo") {
      if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 50) throw new Error("more_units settings: max_per_repo must be a whole number from 1 to 50");
      out.max_per_repo = v as number;
    } else if (k === "max_fixed_share") {
      if (typeof v !== "number" || !(v > 0) || v > 1) throw new Error("more_units settings: max_fixed_share must be above 0 and at most 1");
      out.max_fixed_share = v;
    } else throw new Error(`more_units settings: unknown field ${k}`);
  }
  return out;
}

/** The literal directory or file prefix of a path glob (up to its first wildcard). */
function globPrefix(g: string): string {
  const i = g.search(/[*?[{]/);
  return (i < 0 ? g : g.slice(0, i)).replace(/^\.\//, "");
}

/** True when two allowed-path globs can match a common file: one's literal prefix starts the other's. */
export function pathsOverlap(a: string[], b: string[]): boolean {
  for (const x of a)
    for (const y of b) {
      const px = globPrefix(x);
      const py = globPrefix(y);
      if (px.startsWith(py) || py.startsWith(px)) return true;
    }
  return false;
}

const cmd = (s: string) => s.replace(/\s+/g, " ").trim();

/** The draft's metrics that `existing` does not have: another kind and name, and another command. */
export function newTargets(draft: Pick<Recipe, "metrics">, existing: Pick<Recipe, "metrics">): string[] {
  const names = new Set(existing.metrics.map((m) => `${m.kind}:${m.name}`));
  const cmds = new Set(existing.metrics.map((m) => cmd(m.command)));
  return draft.metrics.filter((m) => !names.has(`${m.kind}:${m.name}`) && !cmds.has(cmd(m.command))).map((m) => m.name);
}

type UnitShape = Pick<Recipe, "name" | "repo" | "metrics" | "patch">;

/**
 * Structural, free: null when the draft adds something to the repository's existing units, else which
 * unit it duplicates and why. A draft duplicates a unit of the same repository when their allowed
 * paths overlap and the draft brings no target that unit lacks (same kind and name, or the same
 * command, is the same target). A heavier workload on the same code is welcome as new targets with
 * their own names; another part of the code never overlaps.
 */
export function duplicateUnit(draft: UnitShape, existing: UnitShape[]): { unit: string; why: string } | null {
  for (const e of existing) {
    if (e.repo !== draft.repo || e.name === draft.name) continue;
    if (!pathsOverlap(draft.patch.allowed_paths, e.patch.allowed_paths)) continue;
    if (newTargets(draft, e).length) continue;
    return {
      unit: e.name,
      why: `it measures nothing the unit ${e.name} does not already measure on the same paths (${e.metrics.map((m) => m.name).join(", ")} on ${e.patch.allowed_paths.join(", ")}): add targets with their own names and workloads, or allow another part of the code`,
    };
  }
  return null;
}

/**
 * The headroom an additional unit's calibration must show, or null when it does: every enabled
 * instruction-count metric (parser cachegrind-ir) declares fixed_command, has a recorded fixed_value,
 * and fixed_value / base_value is at most `maxShare`. Size and compute-unit metrics have no start-up
 * share and need none.
 */
export function headroomError(recipe: Pick<Recipe, "metrics">, calibration: Pick<Calibration, "metrics">, maxShare: number): string | null {
  for (const m of recipe.metrics) {
    if (m.parser !== "cachegrind-ir" || !m.deterministic) continue;
    const c = calibration.metrics[m.name];
    if (!c?.enabled) continue;
    if (!m.fixed_command) return `metric ${m.name} declares no fixed_command, so the part of it that is not the library is not recorded`;
    if (typeof c.fixed_value !== "number" || typeof c.base_value !== "number" || !(c.base_value > 0)) return `metric ${m.name}: fixed_command gave no value at calibration`;
    const share = c.fixed_value / c.base_value;
    if (share > maxShare) return `metric ${m.name}: ${(100 * share).toFixed(1)}% of it is not the library's own work at generation 0 (${c.fixed_value} of ${c.base_value}), above ${(100 * maxShare).toFixed(0)}%: the workload is too light`;
  }
  return null;
}
