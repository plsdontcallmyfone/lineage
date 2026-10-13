// The launch wizard's fee route, as pure rules (docs/plans/GITHUB-FEE-CLAIMS.md 11): one tick, the
// recipient is the repository the agent works on and nothing else, and the share is the one number
// in the chain's ClaimConfig. No DOM and no network here, so the rules are testable
// (apps/web/test/fee-route-plan.test.ts); fee-route-step.ts renders them.

/** A repository as Core's lookup returns it (`GET /v1/github/repos/:owner/:repo`): the numeric id is the escrow key. */
export interface LookedUpRepo {
  /** owner/name the lookup was asked for, lower case (GitHub may answer with another spelling or a newer name) */
  asked: string;
  id: string;
  full_name: string;
}

/** owner/name of a GitHub repository URL, lower case; null for anything else. */
export function repoNameOf(url: string): string | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/**
 * The share every agent routes, in bps: `ClaimConfig.min_bps`. The admin keeps `min_bps` equal to
 * `max_bps`, so the program itself refuses any other share; the wizard never offers a choice and
 * never carries a figure of its own. Null when the chain has no usable config.
 */
export function fixedShareBps(cfg: { minBps: number; maxBps: number } | null): number | null {
  return cfg && Number.isInteger(cfg.minBps) && cfg.minBps >= 1 && cfg.minBps <= cfg.maxBps ? cfg.minBps : null;
}

export const sharePct = (bps: number) => Number((bps / 100).toFixed(2)).toString();

/** The tick's sentence; without a repository yet it names none. */
export function tickText(bps: number, fullName: string | null): string {
  return `Route ${sharePct(bps)}% of this agent's fees to the owners of ${fullName ?? "the repository it works on"}`;
}

export interface FeeRoutePlan {
  githubId: bigint;
  bps: number;
  line: string;
}

/**
 * What the launch adds for the fee route: nothing when the box is not ticked, else `set_fee_route`
 * for the id of the repository named by `repoUrl` at the configured share. Throws, with a sentence
 * the wizard shows, when the ticked route cannot be built for exactly that repository.
 */
export function planFeeRoute(a: { ticked: boolean; cfg: { minBps: number; maxBps: number } | null; repoUrl: string; looked: LookedUpRepo | null }): FeeRoutePlan | null {
  if (!a.ticked) return null;
  const bps = fixedShareBps(a.cfg);
  if (bps === null) throw new Error("The work: the fee share is not set on chain. Untick the share to launch without it.");
  const name = repoNameOf(a.repoUrl);
  // the id must be the one looked up for THIS repository: a lookup left over from an earlier value of the field is refused
  if (!name || !a.looked || a.looked.asked !== name || !/^[1-9]\d{0,15}$/.test(a.looked.id))
    throw new Error("The work: GitHub has not confirmed the repository yet. Wait a moment, or untick the share.");
  return { githubId: BigInt(a.looked.id), bps, line: `${sharePct(bps)}% of fees go to the owners of ${a.looked.full_name}` };
}
