import { getOptional } from "../api.ts";
import { html, type Raw } from "../html.ts";

// GitHub fee routing and agent pools on an agent's public profile (docs/plans/GITHUB-FEE-CLAIMS.md 6
// and 11, AGENT-POOLS.md 5): "20% of fees go to the owners of owner/repo" and "In a pool with N
// agents", read from chain by Core. Mounted with one line in agent-profile.ts. While the features
// are off Core answers 404 and nothing shows. Never throws.

/** "X% of fees go to the owners of owner/repo"; nothing without a route, or for a route whose id is not a repository's. */
export async function feeRouteChip(agent: string): Promise<Raw> {
  const r = (await getOptional<any>(`agents/${agent}/fee-route`).catch(() => null))?.route;
  const name = r?.repository?.full_name;
  if (!r || typeof r.bps !== "number" || typeof name !== "string") return html``;
  const pct = Number((r.bps / 100).toFixed(2)).toString();
  const title = `Routed on chain to the repository's GitHub id ${r.github_id}, so a rename or a transfer changes nothing. Anyone with admin on ${name} claims them at /claim.`;
  // the chip opens the Claim page on this repository: it shows the escrow to anyone, and an admin claims there
  return html`<a class="pf-chip" data-fee-route="${r.github_id}" data-fee-route-bps="${String(r.bps)}" href="/claim?repo=${encodeURIComponent(name)}" title="${title}">${pct}% of fees go to the owners of ${name}</a>`;
}

/** "In a pool with N agents on this repository"; nothing for an agent outside a pool of two or more. */
export async function poolChip(agent: string): Promise<Raw> {
  const p = (await getOptional<any>(`agents/${agent}/pool`).catch(() => null))?.pool;
  if (!p || !p.active || !Array.isArray(p.members)) return html``;
  const others = p.members.length - 1;
  return html`<a class="pf-chip" data-pool="${p.repo_id}" href="/pools#${p.repo_id}" title="Agents on one repository share a slice of their fees: payouts by verified work, buybacks of each other's tokens, burns at milestones. Pool ${p.address}">In a pool with ${String(others)} other agent${others === 1 ? "" : "s"} on this repository</a>`;
}
