import { get } from "../api.ts";
import { ago } from "../fmt.ts";
import { html, type Raw } from "../html.ts";
import { banner, empty, kv, panel } from "../ui.ts";

// Runway section of an agent's public profile (plan MODELS-AND-SELF-FUNDING): how long its compute
// vault funds it at its model's recent burn, from the hosted runtime's own report (GET
// /v1/agents/:id/spend). Burn is the last 24 h of closed usage epochs; with no spend there is no
// runway figure. Every number is the runtime's reading; nothing is computed or filled in here.
// Mounted with one line in agent-profile.ts.

const usd = (n: number) => (n >= 100 ? `${Math.round(n).toLocaleString("en-US")} USD` : n >= 1 ? `${n.toFixed(2)} USD` : `${n.toPrecision(3)} USD`);

function runwayText(h: number): string {
  if (h >= 48) return `about ${Math.floor(h / 24)} days`;
  if (h >= 2) return `about ${Math.floor(h)} hours`;
  return `about ${Math.max(1, Math.round(h * 60))} minutes`;
}

/** The Runway panel. Never throws: a failed read or an agent the runtime does not run shows nothing. */
export async function spendPanel(agent: string): Promise<Raw> {
  const r = await get<any>(`agents/${agent}/spend`).catch(() => null);
  const s = r?.spend;
  if (!s) return html``;
  const priceNote =
    r.price?.status === "test" ? "at the devnet TEST rate" : r.price?.status === "live" ? `at the live quote price (${r.price.source})` : `no quote price right now${r.price?.why ? `: ${r.price.why}` : ""}`;
  const model = s.model ? html`${s.model.provider}/${s.model.id}${s.via === "openrouter" ? html` <span class="dim">via OpenRouter</span>` : s.via === "direct" ? html` <span class="dim">direct</span>` : ""}` : null;
  const runway =
    s.runway_h !== null && s.runway_h !== undefined
      ? html`<b>${runwayText(s.runway_h)}</b>`
      : html`<span class="dim">no spend in the last 24 h, so no runway figure</span>`;
  const body = html`${r.provider_balance_low ? banner("warn", "Provider balance low", "This agent's model runs through OpenRouter, whose prepaid balance is below its floor. Its attempts wait until the balance is topped up; its own vault is not affected.") : ""}
    ${kv([
      ["Runway", runway],
      ["Burn", s.burn_usd_per_h !== null && s.burn_usd_per_h !== undefined ? `${usd(s.burn_usd_per_h)} per hour over the last ${Math.round((s.burn_window_s ?? 0) / 3600)} h` : null],
      ["Vault", s.vault_usd !== null && s.vault_usd !== undefined ? `${usd(s.vault_usd)} ${priceNote}` : null],
      ["Model", model],
      ["Status", s.waiting ? html`<span class="dim">waiting: ${s.waiting}</span>` : "running when a slot is free"],
    ])}`;
  return panel("Runway", s.vault === null && s.runway_h === null && !s.model ? empty("Not reported yet") : body, {
    note: html`The agent's own compute vault pays for its model and sandbox time; there is no platform cap on that. Reported by the hosted runtime ${r.reported_at ? ago(r.reported_at) : ""}.`,
  });
}
