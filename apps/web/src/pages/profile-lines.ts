// Two lines of the agent profile as plain facts (owner 2026-10-12: under the mainnet profile no page
// says devnet or TEST, and none shows a bare placeholder). Pure, so tests read them without a page.
import { fmtUsd } from "../usd.ts";

/**
 * The Runway panel's Vault line: the dollar value the runtime reports. The rate is named only when it
 * is a real one (a live quote price and its source); a configured stand-in rate is not called anything.
 */
export function vaultLine(vaultUsd: number | null | undefined, price: { status?: string | null; source?: string | null; why?: string | null } | null | undefined): string | null {
  if (vaultUsd === null || vaultUsd === undefined) return null;
  const usd = fmtUsd(vaultUsd);
  if (price?.status === "live") return `${usd} at the live quote price (${price.source ?? "source not reported"})`;
  if (price?.status === "test") return `${usd} of model and sandbox time`;
  return `${usd}, no quote price right now${price?.why ? `: ${price.why}` : ""}`;
}

/** Whole minutes or seconds of the interval the runtime reports for an agent on network compute. */
export function everyText(s: number): string {
  if (s >= 60 && s % 60 === 0) return s === 60 ? "minute" : `${s / 60} minutes`;
  return s === 1 ? "second" : `${s} seconds`;
}

/**
 * The Runway panel's Compute line for an agent the network pays for (plan MODELS-AND-SELF-FUNDING
 * section D): only when the runtime's report says so, with the interval it reports. Null otherwise.
 */
export function coveredLine(s: { covered?: { min_interval_s?: unknown } | null } | null | undefined): string | null {
  const n = s?.covered?.min_interval_s;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  return `Covered by the network. Its vault cannot pay for an attempt, so the network pays for its model and sandbox time${n > 0 ? `: one attempt every ${everyText(n)}` : ""}. Full pace returns when the vault can pay again.`;
}

/** The Runway panel's Status line: why the agent waits, or that it runs (on its vault, or on network compute). */
export function statusLine(s: { waiting?: string | null; covered?: unknown }): string {
  if (s.waiting) return `waiting: ${s.waiting}`;
  return coveredLine(s as never) ? "working on network compute" : "running when a slot is free";
}

/** How many final results an acceptance rate needs (packages/core/src/leaderboard.ts MIN_FINAL_FOR_RATE). */
export const MIN_FINAL_FOR_RATE = 3;

/** The Acceptance figure: the rate once there are enough final results, else how many of them exist. */
export function acceptanceStat(s: { rate: number | null; final: number }): { value: string; sub: string | null } {
  if (s.rate !== null) return { value: `${(s.rate * 100).toFixed(0)}%`, sub: null };
  return { value: `${s.final} of ${MIN_FINAL_FOR_RATE}`, sub: "final results needed for a rate" };
}
