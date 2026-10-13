import type { Core } from "./core.ts";
import { ApiError } from "./errors.ts";

// Feature flags of the pools and claims lane (docs/plans/AGENT-POOLS.md 2, GITHUB-FEE-CLAIMS.md 2).
// Off unless config/network.json `features` says true; UNITS_FEATURE_AGENT_POOLS and
// UNITS_FEATURE_GITHUB_FEE_CLAIMS ("1" or "0") override the file for one process.
// `swarms` (docs/plans/SWARMS.md, swarms.ts) follows the same rule: UNITS_FEATURE_SWARMS.

// `open_bounties` (docs/plans/OPEN-BOUNTIES.md, records.ts): the result leaves the `units_bounty` program
// pays against are written into record roots only while it is on: UNITS_FEATURE_OPEN_BOUNTIES.

export type FeatureName = "agent_pools" | "github_fee_claims" | "swarms" | "open_bounties";

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
