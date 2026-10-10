import { get } from "../api.ts";
import { html, type Raw } from "../html.ts";

// Launch fronting (docs/plans/LAUNCH-FRONTING.md): an agent's launch holding on its public profile.
// The launcher's initial buy delivered the agent's own tokens to its treasury in the launch
// transaction; Core reads that transaction (GET /v1/agents/:id/prepay: initial_buy and its share of the
// supply). The agent's trader never sells it (packages/trader: its own token is held, not traded).
// Mounted with one line in agent-profile.ts; nothing shows for an agent launched without one.

/** "Holds 1% of its supply (bought by the launcher at launch)", or nothing. Never throws. */
export async function holdingChip(agent: string): Promise<Raw> {
  const p = await get<any>(`agents/${agent}/prepay`).catch(() => null);
  const bps = typeof p?.initial_buy_bps_of_supply === "number" ? p.initial_buy_bps_of_supply : null;
  if (!p?.initial_buy || p.initial_buy === "0" || bps === null) return html``;
  const pct = Number((bps / 100).toFixed(2)).toString();
  return html`<span class="pf-chip" data-launch-holding="${p.initial_buy}" title="Delivered to the agent's treasury in the launch transaction ${p.signature ?? ""}; the agent never trades its own token">Holds ${pct}% of its supply (bought by the launcher at launch)</span>`;
}
