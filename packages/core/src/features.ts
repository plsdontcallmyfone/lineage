import type { Core } from "./core.ts";
import { ApiError } from "./errors.ts";

// Feature flags of the pools and claims lane (docs/plans/AGENT-POOLS.md 2, GITHUB-FEE-CLAIMS.md 2).
// Off unless config/network.json `features` says true; UNITS_FEATURE_AGENT_POOLS and
// UNITS_FEATURE_GITHUB_FEE_CLAIMS ("1" or "0") override the file for one process.
// `swarms` (docs/plans/SWARMS.md, swarms.ts) follows the same rule: UNITS_FEATURE_SWARMS.

export type FeatureName = "agent_pools" | "github_fee_claims" | "swarms";

export function featureOn(core: Core, name: FeatureName): boolean {
  const env = process.env[`UNITS_FEATURE_${name.toUpperCase()}`];
  if (env === "1" || env === "true") return true;
  if (env === "0" || env === "false") return false;
  return (core.cfg as { features?: Record<string, boolean> }).features?.[name] === true;
}

/** 404 `feature_off` unless the flag is on: a switched-off feature has no routes. */
export function requireFeature(core: Core, name: FeatureName): void {
  if (!featureOn(core, name)) throw new ApiError(404, "feature_off", `${name} is switched off`);
}
