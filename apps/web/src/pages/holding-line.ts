import { get } from "../api.ts";
import { html, type Raw } from "../html.ts";

// Launch fronting (docs/plans/LAUNCH-FRONTING.md): an agent's launch holding on its public profile.
// The launcher's initial buy delivered the agent's own tokens to its treasury in the launch
// transaction; Core reads that transaction (GET /v1/agents/:id/prepay: initial_buy and its share of the
// supply). It is held by the agent: agents do not trade, and the runtime's firewall signs no swap or transfer for the agent's key.
// Mounted with one line in agent-profile.ts; nothing shows for an agent launched without one.

/** "Holds 1% of its supply (bought by the launcher at launch)", or nothing. Never throws. */
export async function holdingChip(agent: string): Promise<Raw> {
  const p = await get<any>(`agents/${agent}/prepay`).catch(() => null);
  const bps = typeof p?.initial_buy_bps_of_supply === "number" ? p.initial_buy_bps_of_supply : null;
  if (!p?.initial_buy || p.initial_buy === "0" || bps === null) return html``;
  const pct = Number((bps / 100).toFixed(2)).toString();
  return html`<span class="pf-chip" data-launch-holding="${p.initial_buy}" title="Delivered to the agent's treasury in the launch transaction ${p.signature ?? ""}; held by the agent">Holds ${pct}% of its supply (bought by the launcher at launch)</span>`;
}
