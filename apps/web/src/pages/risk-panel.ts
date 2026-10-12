import { get } from "../api.ts";
import { ago } from "../fmt.ts";
import { html, type Raw } from "../html.ts";
import { QUOTE, shortAddr } from "../market.ts";
import { panel } from "../ui.ts";

// Risk panel of an agent's public profile (docs/plans/AGENT-WALLET-SAFETY.md "Risk management"): the
// limits in force, the agent's exposure as Core last recorded it, its halt and why, and its recent
// refusals. Everything is Core's GET /v1/agents/:id/risk; nothing is computed here beyond turning
// basis points into percent and base units into the quote token. Mounted with one line in
// agent-profile.ts; an agent Core has no trading record for shows its limits and says so.

interface Risk {
  hosted: boolean;
  trading: boolean;
  reduce_only: boolean;
  reduce_only_reason: string | null;
  excluded: string | null;
  halt: { rule: string; since: number; until: number | null } | null;
  limits: Record<string, number | string>;
  exposure: { recorded_at: number | null; equity: string | null; cash: string | null; deployed: string | null; deployed_bps: number | null; positions: { mint: string; amount: string }[]; trades_today: number };
  refusals: { at: number; rule: string | null; detail: string | null }[];
}

const pct = (bps: number | string | undefined) => (typeof bps === "number" ? `${Number((bps / 100).toFixed(2))}%` : "TBA");
const mins = (s: number | string | undefined) => (typeof s !== "number" ? "TBA" : s % 3600 === 0 && s >= 3600 ? `${s / 3600} h` : `${Number((s / 60).toFixed(1))} min`);
const quote = (base: string | number | null | undefined) => {
  if (base === null || base === undefined) return null;
  const n = Number(base) / 1e6;
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
};
const HALT: Record<string, string> = {
  daily_loss: "Daily loss limit reached: no trading until the next UTC day",
  max_drawdown: "Drawdown limit reached: halted until the launcher or the admin resets it",
  breaker: "Circuit breaker: repeated failed or refused transactions; halted until the launcher or the admin resets it",
};

/** The Risk panel. Never throws: when Core cannot be read, or the agent is not hosted, nothing is shown. */
export async function riskPanel(agent: string): Promise<Raw> {
  const r = await get<Risk>(`agents/${agent}/risk`).catch(() => null);
  if (!r || !r.hosted) return html``;
  ensureCss();
  const L = r.limits;
  const x = r.exposure;
  const state = r.excluded
    ? html`<div class="rk-state rk-off" data-risk-state="excluded"><b>Excluded from trading</b><span>${r.excluded}</span></div>`
    : !r.trading
      ? html`<div class="rk-state rk-off" data-risk-state="off"><b>Trading is off</b><span>These are the limits that apply when it is on.</span></div>`
      : r.halt
        ? html`<div class="rk-state rk-halt" data-risk-state="halted"><b>Halted</b><span>${HALT[r.halt.rule] ?? r.halt.rule}, since ${ago(r.halt.since)}${r.halt.until ? html`, until ${new Date(r.halt.until).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}.</span></div>`
        : r.reduce_only
          ? html`<div class="rk-state rk-halt" data-risk-state="reduce-only"><b>Reduce only</b><span>No agent buys right now; sells still go.${r.reduce_only_reason ? ` ${r.reduce_only_reason}.` : ""}</span></div>`
          : html`<div class="rk-state" data-risk-state="on"><b>Trading within limits</b><span>No halt in force.</span></div>`;
  const use = (label: string, now: Raw | string, cap: string, field: string) => html`<li data-risk="${field}"><span>${label}</span><span class="rk-v"><b>${now}</b> <i>of ${cap}</i></span></li>`;
  const exposure =
    x.recorded_at === null
      ? html`<p class="rk-none" data-risk="none">No trade recorded for this agent yet, so there is no exposure to show.</p>`
      : html`<ul class="rk-list">
          ${use("In positions", x.deployed_bps === null ? "unavailable" : pct(x.deployed_bps), `${pct(L.max_deployed_bps)} of equity`, "deployed")}
          ${use("Open positions", String(x.positions.length), String(L.max_open_positions), "positions")}
          ${use("Trades today", String(x.trades_today), String(L.max_trades_per_day), "trades")}
          <li data-risk="equity"><span>Equity <em>as of its last trade, ${ago(x.recorded_at)}</em></span><span class="rk-v"><b>${quote(x.equity) ?? "unavailable"}</b> <i>${QUOTE}</i></span></li>
          <li data-risk="cash"><span>Held in ${QUOTE}</span><span class="rk-v"><b>${quote(x.cash) ?? "unavailable"}</b> <i>${QUOTE}</i></span></li>
        </ul>`;
  const row = (label: string, value: string, key: string) => html`<li data-limit="${key}"><span>${label}</span><span class="rk-v"><b>${value}</b></span></li>`;
  const limits = html`<ul class="rk-list">
      ${row("Per trade", `${pct(L.max_trade_bps)} of equity`, "max_trade_bps")}
      ${row("Per token", `${pct(L.max_position_bps)} of equity`, "max_position_bps")}
      ${row("In positions, total", `${pct(L.max_deployed_bps)} of equity`, "max_deployed_bps")}
      ${row("Daily loss halt", pct(L.daily_loss_bps), "daily_loss_bps")}
      ${row("Drawdown halt", `${pct(L.max_drawdown_bps)} from the peak`, "max_drawdown_bps")}
      ${row("Stop-loss", `${pct(L.stop_loss_bps)} per position`, "stop_loss_bps")}
    </ul>
    <details class="rk-more"><summary>All limits</summary><ul class="rk-list">
      ${row("Open positions", String(L.max_open_positions), "max_open_positions")}
      ${row("Take-profit", `at ${pct(L.take_profit_bps)}, sells ${pct(L.take_profit_sell_bps)}`, "take_profit_bps")}
      ${row("Slippage", pct(L.max_slippage_bps), "max_slippage_bps")}
      ${row("Price impact", pct(L.max_impact_bps), "max_impact_bps")}
      ${row("Trades per day", String(L.max_trades_per_day), "max_trades_per_day")}
      ${row("Same token again after", mins(L.cooldown_s), "cooldown_s")}
      ${row("Opposite side after", mins(L.min_hold_s), "min_hold_s")}
      ${row("A token it may buy has", `${L.eligibility_min_generations} accepted generation${L.eligibility_min_generations === 1 ? "" : "s"}, ${mins(L.eligibility_min_age_s)} since launch, ${L.eligibility_min_holders} holders`, "eligibility")}
      ${row("and reserves of at least", `${quote(L.eligibility_min_liquidity_line) ?? "TBA"} ${QUOTE}`, "eligibility_min_liquidity_line")}
      ${row("No buy after a move of", `${pct(L.eligibility_max_move_1h_bps)} in an hour`, "eligibility_max_move_1h_bps")}
      ${row("All agents in one token", `${pct(L.network_max_exposure_bps)} of its supply`, "network_max_exposure_bps")}
      ${row("Agents buying one token", `${L.herd_max_agents} within ${mins(L.herd_window_s)}`, "herd_max_agents")}
      ${row("Never opposite another agent within", mins(L.wash_window_s), "wash_window_s")}
      ${row("Circuit breaker", `${L.breaker_failures} failures within ${mins(L.breaker_window_s)}`, "breaker_failures")}
      ${row("Network reduce-only at", `${pct(L.network_drawdown_bps)} drawdown`, "network_drawdown_bps")}
    </ul></details>`;
  const refusals = r.refusals.length
    ? html`<div class="rk-h">Recent refusals</div><ul class="rk-list rk-ref">${r.refusals.map((f) => html`<li><span>${(f.rule ?? "refused").replace(/_/g, " ")}</span><span class="rk-v"><i data-ago="${f.at}">${ago(f.at)}</i></span></li>`)}</ul>`
    : "";
  const held = x.positions.length ? html`<div class="rk-h">Positions</div><ul class="rk-list">${x.positions.map((p) => html`<li><span><a class="link" href="/tokens/${p.mint}">${shortAddr(p.mint)}</a></span><span class="rk-v"><b>${quote(p.amount)}</b> <i>tokens</i></span></li>`)}</ul>` : "";
  return panel("Risk", html`<div class="rk" data-risk-panel="${agent}">${state}<div class="rk-h">Exposure</div>${exposure}${held}<div class="rk-h">Limits</div>${limits}${refusals}</div>`, {
    cls: "rk-panel",
    note: html`Limits are set by the network admin and enforced twice: by the trading engine, and again when the agent's key is asked to sign.`,
  });
}

// styles: injected once, on the app's own tokens (no new colours, no monospace)
const CSS = `
.rk{display:grid;grid-template-columns:minmax(0,1fr);min-width:0;padding-bottom:6px}
.rk-panel{min-width:0}
.rk-state{margin:12px 16px 4px;padding:10px 12px;border-radius:12px;background:var(--bg3);display:grid;gap:2px;font-size:12.5px;line-height:1.45;color:var(--ts)}
.rk-state b{font-weight:500;color:var(--tp);font-size:13px}
.rk-state.rk-halt b{color:var(--bad, var(--tp))}
.rk-h{padding:12px 16px 2px;font:500 12px/1.3 var(--sans);letter-spacing:-.01em;color:var(--tt)}
.rk-list{list-style:none;margin:0;padding:0 16px}
.rk-list li{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:7px 0;border-top:1px solid var(--border);font-size:12.5px;color:var(--ts);min-width:0}
.rk-list li:first-child{border-top:0}
.rk-list li>span:first-child{min-width:0}
.rk-list em{font-style:normal;color:var(--tt);font-size:12px;margin-left:4px}
.rk-v{flex:none;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.rk-v b{font-family:var(--display);font-weight:500;font-size:13.5px;letter-spacing:-.02em;color:var(--tp)}
.rk-v i{font-style:normal;font-size:11.5px;color:var(--tt)}
.rk-more{margin-top:2px}
.rk-more summary{padding:8px 16px;font:500 12px/1.3 var(--sans);color:var(--ts);cursor:pointer;list-style:none}
.rk-more summary::-webkit-details-marker{display:none}
.rk-more summary::after{content:" +";color:var(--tt)}
.rk-more[open] summary::after{content:" -"}
.rk-more summary:focus-visible{outline:2px solid var(--ac);outline-offset:-2px}
.rk-more .rk-list li{white-space:normal}
.rk-more .rk-v{white-space:normal;max-width:60%}
.rk-none{margin:0;padding:6px 16px 4px;font-size:12.5px;color:var(--tt)}
.rk-ref li>span:first-child::first-letter{text-transform:uppercase}
`;
let cssDone = false;
function ensureCss() {
  if (cssDone || typeof document === "undefined") return;
  cssDone = true;
  const s = document.createElement("style");
  s.dataset.rk = "1";
  s.textContent = CSS;
  document.head.appendChild(s);
}
