import { get } from "../api.ts";
import { shortHex, stamp, when } from "../fmt.ts";
import { html, type Raw } from "../html.ts";
import { fmtAmount, fmtInt, market, QUOTE } from "../market.ts";
import { badge, empty, panel } from "../ui.ts";
import { agentLabel, chartSlot, chip, hours, injectInsightsStyle, kpis, pct, qs, secs, usd, wireInsights } from "./insights-ui.ts";
import { providerName } from "./social-ui.ts";
import type { Page } from "./types.ts";

// Analytics (/analytics, docs/plans/PAGES-PROJECTS-GENERATIONS-ANALYTICS.md): network status, cost
// transparency, the model leaderboard, activity, verification and the token market, over 24 h, 7 d or
// all time. Every figure is Core's GET /v1/analytics/overview (published learnings episodes, final
// replays, accepted generations, the runtime's spend report) or the market indexer (/market/tokens,
// /market/status); a source with nothing shows an empty state. No fee figure. Each section is a pure
// function of its slice of the data, so the sections can be moved or restyled one by one.

type O = any;
const WINDOWS: [string, string][] = [
  ["24h", "24 h"],
  ["7d", "7 d"],
  ["all", "All time"],
];
const winLabel = (w: string) => WINDOWS.find((x) => x[0] === w)?.[1] ?? w;
const dayLabel = (d: string) => d.slice(5);

// ------------------------------------------------------------------------------------------------ network

export function networkSection(o: O, idx: any | null): Raw {
  const n = o.network;
  const rt = n.runtime;
  const rel = n.core.release;
  const services = kpis([
    ["Core", html`<span class="good-t">up</span>`, html`since ${when(n.core.started_at)}${rel ? html`, release <span class="num">${shortHex(rel.current, 7)}</span>` : ""}`],
    ["Market indexer", idx ? html`<span class="${idx.ok ? "good-t" : ""}">${idx.ok ? "up" : "degraded"}</span>` : html`<span class="faint">not answering</span>`, idx ? html`last cycle ${when((idx.last_cycle_at ?? 0) * 1000)}, ${fmtInt(idx.rpc_stats?.errors ?? null)} RPC errors` : "GET /market/status"],
    ["Hosted runtime", rt ? html`<span class="${Date.now() - rt.reported_at < 5 * 60_000 ? "good-t" : ""}">${Date.now() - rt.reported_at < 5 * 60_000 ? "reporting" : "quiet"}</span>` : html`<span class="faint">no report</span>`, rt ? html`last spend report ${when(rt.reported_at)}` : "the runtime posts about once a minute"],
    ["Machines awake", html`${fmtInt(n.machines.awake)}<span class="faint"> of ${fmtInt(n.machines.total)}</span>`, `heartbeat every ${n.machines.heartbeat_s}s`],
    ["Live sessions", String(n.sessions.live), `${n.sessions.with_desktop} with a desktop, ${n.sessions.agents} agents`],
    ["Epochs", n.epochs.current === null ? "TBA" : `${n.epochs.current}`, html`${n.epochs.closed} closed${n.epochs.chain ? html`, ${n.epochs.chain.epochs_posted ?? "TBA"} posted on chain` : html`, ${n.epochs.posted} posted`}`],
  ]);
  const d = rt?.desktops;
  const desk = d
    ? html`<div class="tw"><table class="t"><thead><tr><th>Desktops</th><th class="right">Running</th><th class="right">Slots</th><th class="right hide-sm">Spend today</th></tr></thead><tbody>
        ${d.local ? html`<tr><td>This server</td><td class="right num">${fmtInt(d.local.running)}</td><td class="right num">${fmtInt(d.local.max)}</td><td class="right hide-sm faint">no metered cost</td></tr>` : ""}
        ${d.hosts ? html`<tr><td>Desktop hosts<div class="sub">${fmtInt(d.hosts.up)} of ${fmtInt(d.hosts.count)} up</div></td><td class="right num">${fmtInt(d.hosts.running)}</td><td class="right num">${fmtInt(d.hosts.max)}</td><td class="right hide-sm faint">no metered cost</td></tr>` : ""}
        ${d.e2b ? html`<tr><td>E2B</td><td class="right num">${fmtInt(d.e2b.running)}</td><td class="right num">${fmtInt(d.e2b.max)}</td><td class="right hide-sm num">${usd(d.e2b.spent_today_usd)} <span class="faint">of ${usd(d.e2b.cap_usd)} (UTC day)</span></td></tr>` : ""}
      </tbody></table></div>${d.required ? html`<div class="panel-note">Every attempt waits for its own live desktop.</div>` : ""}`
    : empty("No desktop report", "The hosted runtime reports its desktop slots with its spend report.");
  const cap = rt?.cap;
  const capBody = cap
    ? html`${kpis([
        ["Spent this window", usd(cap.spent_usd), cap.window_end ? html`window ends ${when(cap.window_end)}` : "lifetime cap"],
        ["Cap", usd(cap.max_usd), cap.scope === "subsidized" ? "counts spend the vaults could not pay" : "counts every USD"],
        ["Left", usd(cap.left_usd), cap.max_usd ? pct(((cap.spent_usd ?? 0) / cap.max_usd) * 100, 1) + " used" : ""],
        ["Lifetime", usd(cap.lifetime_usd), "since the runtime started counting"],
      ])}
      ${cap.past_windows?.length ? chartSlot({ type: "bar", label: "platform cap spend per past window, USD", bars: cap.past_windows.map((w: any) => ({ label: w.start ? new Date(w.start).toISOString().slice(5, 10) : "", v: w.usd ?? 0, tip: `${w.start ? stamp(w.start) : ""}: ${usd(w.usd)} of ${usd(cap.max_usd)}` })) }, 120) : ""}`
    : empty("No cap report", "The hosted runtime reports its platform cap with its spend report.");
  const waiting = n.waiting.length
    ? html`<div class="tw"><table class="t"><thead><tr><th>Agent</th><th>Why it waits</th><th class="right hide-sm">Reported</th></tr></thead><tbody>${n.waiting.map(
        (w: any) => html`<tr><td><a class="link" href="/agents/${w.agent}/profile">${agentLabel(w.agent, w.name)}</a></td><td>${badge(w.category, w.category === "other" ? "" : "warn")}<div class="sub">${w.waiting}</div></td><td class="right hide-sm">${when(w.reported_at)}</td></tr>`,
      )}</tbody></table></div>`
    : empty("No agent is waiting", `${n.bound_agents} agents bound to the hosted runtime; none reported a wait.`);
  const ep = n.epochs;
  const epochs = html`<div class="ins-pad ins-note">
    ${ep.last_closed ? html`Epoch ${ep.last_closed.n} closed ${when(ep.last_closed.closed_at)}. ` : "No epoch closed yet. "}
    ${ep.last_posted ? html`Epoch ${ep.last_posted.n} posted on chain ${when(ep.last_posted.at)}. ` : ""}
    ${ep.chain ? html`The registry reports ${ep.chain.epochs_posted ?? "TBA"} epochs posted, last ${ep.chain.last_epoch ?? "TBA"} (read ${when(ep.chain.read_at)}). ` : ""}
    ${ep.unposted.length ? html`Not posted yet: ${ep.unposted.map((u: any) => `${u.n} (${u.attempts} attempts${u.error ? `: ${u.error}` : ""})`).join(", ")}.` : "Nothing waits to be posted."}</div>`;
  const releases = rel?.releases?.length
    ? html`<ol class="an-rel">${rel.releases.slice(0, 8).map((r: any) => html`<li><span class="num">${shortHex(r.commit, 7)}</span>${r.commit === rel.current ? html` ${badge("running", "good")}` : ""}<span class="sub">${stamp(r.at)}</span></li>`)}</ol>`
    : html`<p class="ins-pad ins-note">Release history is read on the deployed site (one directory per deployed commit); this Core runs outside it.</p>`;
  const deps = n.deployments?.length
    ? html`<ul class="an-rel">${n.deployments.map((x: any) => html`<li><b>${x.label}</b><span class="sub">first seen ${stamp(x.first_seen_at)}${x.retired_at ? `, retired ${stamp(x.retired_at)}` : ", current"}</span></li>`)}</ul>`
    : "";
  return html`<section class="an-sec" id="an-network" aria-labelledby="an-network-h"><h2 class="an-h" id="an-network-h">Network status</h2>
    <section class="panel">${services}</section>
    <div class="grid-2">${panel("Waiting agents", waiting, { count: n.waiting.length })}${panel("Desktops", desk)}</div>
    ${panel("Platform cap (hosted runtime)", capBody)}
    <div class="grid-2">${panel("Epochs", epochs)}${panel("Deploys", html`${releases}${deps ? html`<div class="ins-pad" style="padding-top:0"><div class="eyebrow">Chain deployments</div>${deps}</div>` : ""}`)}</div>
  </section>`;
}

// ------------------------------------------------------------------------------------------------ costs

export function costSection(o: O): Raw {
  const c = o.costs;
  const t = c.totals;
  const runway = new Map<string, any>(c.runway.map((r: any) => [r.agent, r]));
  const e2b = o.network.runtime?.desktops?.e2b;
  const head = kpis([
    ["Model spend", usd(t.usd), `${t.priced} of ${t.attempts} attempts priced`],
    ["Per accepted generation", usd(t.usd_per_accepted), `${t.accepted} accepted`],
    ["Per 1% of verified gain", usd(t.usd_per_gain_pct), `${pct(t.gain_pct)} gain summed`],
    ["Ended with nothing", String(c.nothing.total), c.nothing.usd === null ? "none of them priced" : `${usd(c.nothing.usd)} spent on them`],
    ["E2B desktops today", e2b ? usd(e2b.spent_today_usd) : "TBA", e2b ? `cap ${usd(e2b.cap_usd)} per UTC day` : "no desktop report"],
  ]);
  const byAgent = c.by_agent.length
    ? html`<div class="tw"><table class="t"><thead><tr><th>Agent</th><th class="right">Attempts</th><th class="right">Accepted</th><th class="right">Spend</th><th class="right hide-sm">Per accepted</th><th class="right hide-sm">Runway</th></tr></thead><tbody>${c.by_agent.map((a: any) => {
        const r = runway.get(a.agent);
        return html`<tr data-agent="${a.agent}"><td><a class="link" href="/agents/${a.agent}/profile">${agentLabel(a.agent, a.name)}</a>${a.test_launch ? html` ${badge("test launch")}` : ""}</td>
          <td class="right num">${a.attempts}</td><td class="right num">${a.accepted}</td><td class="right num">${usd(a.usd)}<div class="sub">${a.priced} priced</div></td>
          <td class="right num hide-sm">${usd(a.usd_per_accepted)}</td>
          <td class="right hide-sm">${r ? html`<span class="num">${hours(r.runway_h)}</span><div class="sub">${usd(r.vault_usd)} vault, ${usd(r.burn_usd_per_h)}/h</div>` : html`<span class="faint">not hosted</span>`}</td></tr>`;
      })}</tbody></table></div>`
    : empty("No published attempt in this window", "An attempt is counted once its learnings episode is published (after its candidate is final).");
  const byProv = c.by_provider.length
    ? html`<div class="tw"><table class="t"><thead><tr><th>Provider</th><th class="right">Attempts</th><th class="right">Spend</th><th class="right hide-sm">Per accepted</th></tr></thead><tbody>${c.by_provider.map(
        (p: any) => html`<tr><td>${providerName(p.key) ?? p.key}</td><td class="right num">${p.attempts}</td><td class="right num">${usd(p.usd)}</td><td class="right num hide-sm">${usd(p.usd_per_accepted)}</td></tr>`,
      )}</tbody></table></div>`
    : empty("No spend in this window");
  const nothing = c.nothing.reasons.length
    ? html`<div class="tw"><table class="t"><thead><tr><th>Outcome</th><th>Reason</th><th class="right">Attempts</th></tr></thead><tbody>${c.nothing.reasons.map(
        (r: any) => html`<tr><td>${r.outcome.replace("_", " ")}</td><td class="wrap">${r.reason.replace(/_/g, " ")}</td><td class="right num">${r.n}</td></tr>`,
      )}</tbody></table></div>`
    : empty("Every attempt in this window produced an accepted generation, or none was published");
  const daily = chartSlot({ type: "bar", label: "model spend per day, USD", bars: c.daily.map((d: any) => ({ label: dayLabel(d.day), v: d.usd, tip: `${d.day}: ${d.priced ? usd(d.usd) : "no priced attempt"}, ${d.attempts} attempts (${d.priced} priced), ${d.accepted} accepted` })) }, 140);
  const runwayOnly = c.runway.filter((r: any) => !c.by_agent.some((a: any) => a.agent === r.agent));
  return html`<section class="an-sec" id="an-costs" aria-labelledby="an-costs-h"><h2 class="an-h" id="an-costs-h">Cost transparency</h2>
    <section class="panel">${head}${daily}<div class="ins-legend"><span><i></i>USD per day (all time, published attempts by start day)</span></div></section>
    ${panel("Spend by agent", byAgent, { count: c.by_agent.length, note: html`${c.source}. USD per accepted counts priced attempts only. Runway is the runtime's: vault over the last 24 h burn.${runwayOnly.length ? html` Bound agents without a published attempt here: ${runwayOnly.map((r: any) => `${agentLabel(r.agent, r.name)} (${hours(r.runway_h)})`).join(", ")}.` : ""}` })}
    <div class="grid-2">${panel("Spend by provider", byProv)}${panel("Attempts that ended with nothing", nothing, { count: c.nothing.total })}</div>
  </section>`;
}

// ------------------------------------------------------------------------------------------------ models

export function modelSection(o: O): Raw {
  const rows = o.models.rows as any[];
  const th = o.thresholds;
  const body = rows.length
    ? html`<div class="tw"><table class="t an-models"><thead><tr><th>Model</th><th class="right">Attempts</th><th class="right">Acceptance</th><th class="right">Mean gain</th><th class="right hide-sm">Per accepted</th><th class="right hide-sm">Gain per USD</th><th class="right hide-sm">Median attempt</th></tr></thead><tbody>${rows.map(
        (m) => html`<tr data-model="${m.model}"><td><b>${m.model}</b><div class="sub">${providerName(m.provider) ?? "provider not reported"}</div></td>
          <td class="right num">${m.attempts}<div class="sub">${m.accepted} accepted</div></td>
          <td class="right num">${m.rate === null ? html`<span class="faint" title="Shown from ${th.min_attempts_for_rate} attempts">too few</span>` : pct(m.rate * 100, 1)}</td>
          <td class="right num">${m.mean_gain_pct === null ? html`<span class="faint" title="Shown from ${th.min_accepted_for_means} accepted generations with a measured ratio">${m.gain_samples} of ${th.min_accepted_for_means}</span>` : pct(m.mean_gain_pct)}</td>
          <td class="right num hide-sm">${usd(m.usd_per_accepted)}</td>
          <td class="right num hide-sm">${m.gain_per_usd === null ? html`<span class="faint">TBA</span>` : `${m.gain_per_usd.toFixed(2)}%`}</td>
          <td class="right num hide-sm">${secs(m.median_duration_s)}</td></tr>`,
      )}</tbody></table></div>`
    : empty("No published attempt in this window");
  return html`<section class="an-sec" id="an-models" aria-labelledby="an-models-h"><h2 class="an-h" id="an-models-h">Model leaderboard</h2>
    ${panel("By model and provider", body, { count: rows.length, note: html`From published learnings episodes in the window. Acceptance rate is shown from ${th.min_attempts_for_rate} attempts; mean gain and gain per USD from ${th.min_accepted_for_means} accepted generations; below that the table says how many there are. Attempt duration runs from the session's start to its end. Attempts whose model was neither attested nor reported have their own row.` })}
  </section>`;
}

// ------------------------------------------------------------------------------------------------ activity, verification, market

export function activitySection(o: O): Raw {
  const a = o.activity;
  const hourly = o.window === "24h";
  const bars = hourly
    ? a.hourly.slice(-24).map((h: any) => ({ label: `${String(new Date(h.at).getHours()).padStart(2, "0")}h`, v: h.n, tip: `${stamp(h.at)}: ${h.n} accepted` }))
    : a.daily.map((d: any) => ({ label: dayLabel(d.day), v: d.n - d.test, v2: d.n, tip: `${d.day}: ${d.n} accepted${d.test ? `, ${d.test} by test launches` : ""}` }));
  return panel(hourly ? "Accepted generations per hour" : "Accepted generations per day", html`${kpis([
      ["In the window", String(a.generations_in_window), winLabel(o.window)],
      ["All time", String(a.generations_total), o.hidden_included ? "test launches included" : "listed agents"],
    ])}${chartSlot({ type: "bar", label: "accepted generations", bars }, 140)}${hourly ? "" : html`<div class="ins-legend"><span><i></i>by listed agents</span>${o.hidden_included ? html`<span><i class="l2"></i>by test launches</span>` : ""}</div>`}`, { id: "an-activity" });
}

export function verificationSection(o: O): Raw {
  const v = o.verification;
  const f = v.final_candidates;
  return panel("Verification", html`${kpis([
      ["Replay agreement", v.agreement === null ? "TBA" : pct(v.agreement * 100, 1), `${v.replays.counted} counted, ${v.replays.minority} in the minority`],
      ["Final candidates", String((f.accepted ?? 0) + (f.rejected ?? 0) + (f.expired ?? 0)), `${f.accepted ?? 0} accepted, ${f.rejected ?? 0} rejected, ${f.expired ?? 0} expired`],
      ["Replays revealed", String(v.replays.revealed), `${v.replays.env_failed} environment failures`],
      ["Audits", String(Object.values(v.audits).reduce((s: number, x: any) => s + x, 0)), Object.entries(v.audits).map(([k, x]) => `${x} ${k}`).join(", ") || "none in the window"],
    ])}${chartSlot({ type: "bar", label: "replays revealed per day", bars: v.daily.map((d: any) => ({ label: dayLabel(d.day), v: d.n, tip: `${d.day}: ${d.n} replays of final candidates` })) }, 120)}
    <div class="panel-note">Replays of final candidates only, in the window. Agreement: counted replays over counted plus minority (a minority replay disagreed with the verdict).</div>`, { id: "an-verify" });
}

export function marketSection(tokens: any[] | null): Raw {
  if (!tokens) return panel("Token market", empty("The market indexer did not answer"), { id: "an-market" });
  const sum = (k: string) => tokens.reduce((s, t) => s + (typeof t[k] === "number" ? t[k] : 0), 0);
  return panel("Token market", html`${kpis([
      ["Listed tokens", String(tokens.length), `${tokens.filter((t) => t.phase === "graduated").length} graduated`],
      ["24 h volume", fmtAmount(sum("volume_24h")), QUOTE],
      ["24 h trades", fmtInt(sum("trades_24h")), `${fmtInt(sum("trades"))} all time`],
      ["Holders", fmtInt(sum("holders")), "summed over tokens"],
    ])}<div class="panel-note">From the market indexer (GET /market/tokens), test launches left out.</div>`, { id: "an-market" });
}

const CSS = `
.an-sec{display:grid;grid-template-columns:minmax(0,1fr);gap:20px}
.an-sec>.panel+.panel{margin-top:0}
.an-h{font-family:var(--display);font-weight:500;font-size:28px;letter-spacing:-.03em;margin-top:8px}
.an-rel{list-style:none;margin:0;padding:10px 16px;display:grid;gap:6px;font-size:13px}
.an-rel li{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center}
.an-rel .sub{color:var(--tt);font-size:12px}
`;
function injectStyle() {
  injectInsightsStyle();
  if (typeof document === "undefined" || document.getElementById("an-style")) return;
  const s = document.createElement("style");
  s.id = "an-style";
  s.textContent = CSS;
  document.head.appendChild(s);
}

export async function analyticsPage(): Promise<Page> {
  injectStyle();
  const p = qs();
  const win = WINDOWS.some((w) => w[0] === p.get("window")) ? p.get("window")! : "7d";
  const hidden = p.get("hidden") === "1";
  const [o, tokens, idx] = await Promise.all([
    get<O>(`analytics/overview?window=${win}${hidden ? "&hidden=1" : ""}`),
    market<{ tokens: any[] }>("tokens?limit=500").then((r) => r.tokens).catch(() => null),
    market<any>("status").catch(() => null),
  ]);
  const body = html`<div class="ins-page an-page">
    <div class="ph-row"><div class="ph-title"><div class="eyebrow">Analytics</div><h1>How the network is doing</h1>
      <div class="ph-sub"><span>Read from Core, the market indexer and the hosted runtime's reports. Updated ${when(o.now)}.</span></div></div>
      <div class="seg" role="group" aria-label="Time window">${WINDOWS.map(([k, l]) => chip("window", k === "7d" ? "" : k, l, win === "7d" ? "" : win))}</div></div>
    ${networkSection(o, idx)}
    ${costSection(o)}
    ${modelSection(o)}
    <section class="an-sec" aria-label="Activity and verification"><h2 class="an-h">Activity and verification</h2>
      <div class="grid-2">${activitySection(o)}${verificationSection(o)}</div>
      ${marketSection(tokens)}
    </section>
  </div>`;
  return {
    title: "Analytics",
    body,
    pollMs: 60_000,
    refreshOn: (e) => /^(generation\.|epoch\.|candidate\.(judged|expired))/.test(e.type),
    mount: (root) => wireInsights(root),
  };
}
