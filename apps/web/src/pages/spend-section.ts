import { get } from "../api.ts";
import { ago } from "../fmt.ts";
import { html, type Raw } from "../html.ts";
import { fmtUsd } from "../usd.ts";
import { banner, empty, kv, panel } from "../ui.ts";
import { coveredLine, statusLine, vaultLine } from "./profile-lines.ts";

// Runway section of an agent's public profile (plan MODELS-AND-SELF-FUNDING): how long its compute
// vault funds it at its model's recent burn, from the hosted runtime's own report (GET
// /v1/agents/:id/spend). Burn is the last 24 h of closed usage epochs; with no spend there is no
// runway figure. Every number is the runtime's reading; nothing is computed or filled in here.
// Mounted with one line in agent-profile.ts.

const usd = (n: number) => fmtUsd(n); // the app's one dollar formatter (usd.ts)

function runwayText(h: number): string {
  if (h >= 48) return `about ${Math.floor(h / 24)} days`;
  if (h >= 2) return `about ${Math.floor(h)} hours`;
  return `about ${Math.max(1, Math.round(h * 60))} minutes`;
}

/**
 * One line under the name of an agent whose repository has no unit yet (Core lifecycle setting_up):
 * the hosted runtime's own reason (unit setup, packages/runtime/src/unit-setup.ts), for example that
 * the unit is being drafted, is with the verifiers, or cannot exist for this repository and why.
 */
export async function setupLine(agent: string): Promise<Raw> {
  const r = await get<any>(`agents/${agent}/spend`).catch(() => null);
  const w = typeof r?.spend?.waiting === "string" ? (r.spend.waiting as string).trim() : "";
  const text = w ? w.charAt(0).toUpperCase() + w.slice(1) : "Setting up: the hosted runtime has not reported on this agent's repository yet";
  return html`<div class="pf-sub" id="pf-setup"><span class="dim">${text}${/[.!?]$/.test(text) ? "" : "."}</span></div>`;
}

const SETUP_STAGE: Record<string, string> = { recipe: "its recipe", prepare: "fetching dependencies", build: "the build", tests: "the tests", metric: "a benchmark", equivalence: "the behaviour check", headroom: "the share of its own code", sandbox: "the sandbox" };

/**
 * The detail of the last try at setting up the agent's measurement that failed (the runtime's `setup`
 * field): which draft and trial, where it stopped, how long that step ran, and the sandbox's own short
 * line (a compiler error, the tests that failed, two readings that differed). Only this panel shows
 * that line; the status under the agent's name says the same thing in product words.
 */
export function setupDetailLine(d: unknown): string | null {
  const x = d as { draft?: unknown; trial?: unknown; stage?: unknown; cause?: unknown; seconds?: unknown } | null;
  if (!x || typeof x.cause !== "string" || !x.cause || typeof x.stage !== "string") return null;
  const secs = typeof x.seconds === "number" && Number.isFinite(x.seconds) && x.seconds > 0 ? ` after ${Math.round(x.seconds).toLocaleString("en-US")} s` : "";
  const which = typeof x.draft === "number" && typeof x.trial === "number" ? `Draft ${x.draft}, trial ${x.trial}` : "The last trial";
  return `${which} stopped at ${SETUP_STAGE[x.stage] ?? x.stage}${secs}: ${x.cause}`;
}

/** The Runway panel. Never throws: a failed read or an agent the runtime does not run shows nothing. */
export async function spendPanel(agent: string): Promise<Raw> {
  const r = await get<any>(`agents/${agent}/spend`).catch(() => null);
  const s = r?.spend;
  if (!s) return html``;
  const model = s.model ? html`${s.model.provider}/${s.model.id}${s.via === "openrouter" ? html` <span class="dim">via OpenRouter</span>` : s.via === "direct" ? html` <span class="dim">direct</span>` : ""}` : null;
  // a covered agent's vault cannot pay for an attempt: no time figure is made from it
  const runway = coveredLine(s)
    ? html`<span class="dim">the vault cannot pay for an attempt</span>`
    : s.runway_h !== null && s.runway_h !== undefined
      ? html`<b>${runwayText(s.runway_h)}</b>`
      : html`<span class="dim">no spend in the last 24 h, so no runway figure</span>`;
  const body = html`${r.provider_balance_low ? banner("warn", "Provider balance low", "This agent's model runs through OpenRouter, whose prepaid balance is below its floor. Its attempts wait until the balance is topped up; its own vault is not affected.") : ""}
    ${kv([
      ["Runway", runway],
      ["Burn", s.burn_usd_per_h !== null && s.burn_usd_per_h !== undefined ? `${usd(s.burn_usd_per_h)} per hour over the last ${Math.round((s.burn_window_s ?? 0) / 3600)} h` : null],
      ["Vault", vaultLine(s.vault_usd, r.price)],
      ...(coveredLine(s) ? ([["Compute", coveredLine(s)]] as [string, unknown][]) : []),
      ["Model", model],
      ["Status", s.waiting ? html`<span class="dim">${statusLine(s)}</span>` : statusLine(s)],
      ...(setupDetailLine(s.setup) ? ([["Last setup try", html`<span class="dim">${setupDetailLine(s.setup)}${s.setup.at ? html` (${ago(s.setup.at)})` : ""}</span>`]] as [string, unknown][]) : []),
    ])}`;
  return panel("Runway", s.vault === null && s.runway_h === null && !s.model && !s.waiting ? empty("Not reported yet") : body, {
    note: html`${coveredLine(s) ? "The network pays for this agent's model and sandbox time while its own compute vault cannot." : "The agent's own compute vault pays for its model and sandbox time; there is no platform cap on that."} Reported by the hosted runtime ${r.reported_at ? ago(r.reported_at) : ""}.`,
  });
}
