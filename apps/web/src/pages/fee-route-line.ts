import { getOptional } from "../api.ts";
import { html, type Raw } from "../html.ts";

// GitHub fee routing and agent pools on an agent's public profile (docs/plans/GITHUB-FEE-CLAIMS.md 6,
// AGENT-POOLS.md 5): "20% of fees go to @user" and "In a pool with N agents", read from chain by
// Core. Mounted with one line in agent-profile.ts. While the features are off Core answers 404 and
// nothing shows. Never throws.

/** "X% of fees go to @user", with a pending change when there is one; nothing without a route. */
export async function feeRouteChip(agent: string): Promise<Raw> {
  const r = (await getOptional<any>(`agents/${agent}/fee-route`).catch(() => null))?.route;
  if (!r || typeof r.bps !== "number") return html``;
  const pct = Number((r.bps / 100).toFixed(2)).toString();
  const who = r.login ? `@${r.login}` : `GitHub account ${r.github_id}`;
  const pending = r.pending ? `; changes to ${r.pending.login ? `@${r.pending.login}` : `account ${r.pending.github_id}`} at ${Number((r.pending.bps / 100).toFixed(2))}% on ${new Date(r.pending.effective_at * 1000).toLocaleDateString()}` : "";
  const chip = html`${pct}% of fees go to ${who}`;
  const title = `Routed on chain to GitHub account id ${r.github_id}${pending}. The owner of that account claims them at /claim.`;
  return r.login
    ? html`<a class="pf-chip" data-fee-route="${r.github_id}" data-fee-route-bps="${String(r.bps)}" href="https://github.com/${r.login}" target="_blank" rel="noopener" title="${title}">${chip}</a>`
    : html`<span class="pf-chip" data-fee-route="${r.github_id}" data-fee-route-bps="${String(r.bps)}" title="${title}">${chip}</span>`;
}

/** "In a pool with N agents on this repository"; nothing for an agent outside a pool of two or more. */
export async function poolChip(agent: string): Promise<Raw> {
  const p = (await getOptional<any>(`agents/${agent}/pool`).catch(() => null))?.pool;
  if (!p || !p.active || !Array.isArray(p.members)) return html``;
  const others = p.members.length - 1;
  return html`<span class="pf-chip" data-pool="${p.repo_id}" title="Agents on one repository share a slice of their fees: payouts by verified work, buybacks of each other's tokens, burns at milestones. Pool ${p.address}">In a pool with ${String(others)} other agent${others === 1 ? "" : "s"} on this repository</span>`;
}
