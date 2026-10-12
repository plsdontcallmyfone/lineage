import { get } from "../api.ts";
import { shortHex, shortId, stamp, when } from "../fmt.ts";
import { esc, html, raw, type Raw } from "../html.ts";
import { fmtAmount, fmtInt, market, QUOTE } from "../market.ts";
import { badge, empty, panel, reasonText } from "../ui.ts";
import { agentLabel, chartSlot, chip, hours, injectInsightsStyle, kpis, mountInsightCharts, pct, qs, secs, usd, wireInsights } from "./insights-ui.ts";
import { providerName } from "./social-ui.ts";
import type { Page } from "./types.ts";
import { CHART_CSS, fmtVal, mountCard, shortDay, slotColor, sparkline, tone, type CardDef, type ChartSpec, type TimeSpec, type Unit } from "./analytics-charts.ts";

// Analytics (/analytics, docs/plans/PAGES-PROJECTS-GENERATIONS-ANALYTICS.md section 6): one dashboard.
// Headline figures with the change against the period before and a sparkline, then a small number of
// charts that each answer one question, the network status widgets, and a few tables folded closed.
// Every figure is Core's GET /v1/analytics/dashboard (bucket aggregates of published learnings
// episodes, accepted generations, replays of final candidates, live sessions, the runtime's report and
// the gate's viewer counts), GET /v1/analytics/overview and /ops for the status row, or the market
// indexer. The window (24 h, 7 d, 30 d, all) applies to every figure and chart. A block whose series is
// empty says so in one line; a block that cannot have data yet is not rendered. No fee figure.

type O = any;
const WINDOWS: [string, string][] = [
  ["24h", "24 h"],
  ["7d", "7 d"],
  ["30d", "30 d"],
  ["all", "All time"],
];

// ------------------------------------------------------------------------------------------------ network

export function networkSection(o: O, idx: any | null): Raw {
  const n = o.network;
  const rt = n.runtime;
  const rel = n.core.release;
  const services: [string, Raw | string, Raw | string][] = [
    ["Core", html`<span class="good-t">up</span>`, html`since ${when(n.core.started_at)}${rel ? html`, release <span class="num">${shortHex(rel.current, 7)}</span>` : ""}`],
    ["Market indexer", idx ? html`<span class="${idx.ok ? "good-t" : ""}">${idx.ok ? "up" : "degraded"}</span>` : html`<span class="faint">not answering</span>`, idx ? html`last cycle ${when((idx.last_cycle_at ?? 0) * 1000)}, ${fmtInt(idx.rpc_stats?.errors ?? null)} RPC errors` : "GET /market/status"],
    ["Hosted runtime", rt ? html`<span class="${Date.now() - rt.reported_at < 5 * 60_000 ? "good-t" : ""}">${Date.now() - rt.reported_at < 5 * 60_000 ? "reporting" : "quiet"}</span>` : html`<span class="faint">no report</span>`, rt ? html`last spend report ${when(rt.reported_at)}` : "the runtime posts about once a minute"],
    ["Machines awake", html`${fmtInt(n.machines.awake)}<span class="faint"> of ${fmtInt(n.machines.total)}</span>`, `heartbeat every ${n.machines.heartbeat_s}s`],
    ["Live sessions", String(n.sessions.live), `${n.sessions.with_desktop} with a desktop, ${n.sessions.agents} agents`],
    ["Epochs", n.epochs.current === null ? "TBA" : `${n.epochs.current}`, html`${n.epochs.closed} closed${n.epochs.chain ? html`, ${n.epochs.chain.epochs_posted ?? "TBA"} posted on chain` : html`, ${n.epochs.posted} posted`}`],
  ];
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
      ${cap.past_windows?.length ? chartSlot({ type: "bar", label: "platform cap spend per past window, USD", bars: cap.past_windows.map((w: any) => ({ label: w.start ? new Date(w.start).toISOString().slice(5, 10) : "", v: w.usd ?? 0, tip: `${w.start ? stamp(w.start) : ""}: ${usd(w.usd)} of ${usd(cap.max_usd)}` })) }, 96) : ""}`
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
  // every item is its own widget, all the same size in one grid (the platform cap, with its chart, takes two)
  const kpiWidget = ([l, v, sub]: [string, Raw | string, Raw | string]) =>
    html`<section class="panel an-w an-kpi"><span class="eyebrow">${l}</span><b>${v}</b><small>${sub}</small></section>`;
  return html`<section class="an-sec" id="an-network" aria-labelledby="an-network-h"><h2 class="an-h" id="an-network-h">Network status</h2>
    <div class="an-grid">
      ${services.map(kpiWidget)}
      ${panel("Waiting agents", waiting, { count: n.waiting.length, cls: "an-w" })}
      ${panel("Desktops", desk, { cls: "an-w" })}
      ${panel("Platform cap (hosted runtime)", capBody, { cls: "an-w an-w2" })}
      ${panel("Epochs", epochs, { cls: "an-w" })}
      ${panel("Deploys", html`${releases}${deps ? html`<div class="ins-pad" style="padding-top:0"><div class="eyebrow">Chain deployments</div>${deps}</div>` : ""}`, { cls: "an-w" })}
    </div>
  </section>`;
}

// ------------------------------------------------------------------------------------------------ site checks

/** Compact infrastructure widgets beside the network status: the monitor's checks, backups, measured deploy downtime. */
function opsWidgets(x: O): Raw {
  const m = x.monitor;
  const checks: any[] = m?.checks ?? [];
  const notOk = checks.filter((c) => c.level !== "ok");
  const backups = checks.filter((c) => String(c.id).startsWith("backup"));
  const rt = x.restore_tests?.[0];
  const iw = x.deploys?.in_window;
  const w = (l: string, v: Raw | string, sub: Raw | string) => html`<section class="panel an-w an-kpi an-kpi-s"><span class="eyebrow">${l}</span><b>${v}</b><small>${sub}</small></section>`;
  return html`<div class="an-grid an-grid-s">
    ${m ? w("Site checks", html`${checks.length - notOk.length}<span class="faint"> of ${checks.length} ok</span>`, notOk.length ? notOk.map((c) => `${c.id}: ${c.msg}`).join("; ") : html`all passing, last run ${when(m.at)}`) : ""}
    ${backups.length ? w("Backups", backups.every((c) => c.level === "ok") ? "fresh" : backups.some((c) => c.level === "fail") ? "stale" : "warning", rt ? html`restore test ${rt.result ?? "TBA"} ${when(rt.ended_at)}` : backups.map((c) => c.msg).join("; ")) : ""}
    ${iw && iw.probes ? w("Deploy downtime", secs(iw.longest_gap_ms / 1000), `longest gap between two 200 answers over ${iw.deploys} deploys in the window; ${fmtInt(iw.non_200)} of ${fmtInt(iw.probes)} probes not 200`) : ""}
  </div>`;
}

// ------------------------------------------------------------------------------------------------ headline figures

interface Kpi {
  id: string;
  label: string;
  value: string;
  cur: number | null;
  prev: number | null | undefined;
  /** which direction is good news; "none" for figures that are neither (spend) */
  good: "up" | "down" | "none";
  /** the change in points instead of percent (a rate) */
  points?: boolean;
  series: (number | null)[];
  color: string;
  sub: string;
  prevText?: (v: number) => string;
}

function deltaChip(k: Kpi, win: string): Raw {
  const span = win === "24h" ? "24 h" : win === "7d" ? "7 d" : "30 d";
  if (win === "all") return html`<span class="an-delta" title="All time has no period before it">all time</span>`;
  if (k.cur === null || k.prev === null || k.prev === undefined) return html`<span class="an-delta" title="Nothing recorded in the ${span} before this window">no earlier figure</span>`;
  const d = k.points ? (k.cur - k.prev) * 100 : k.prev === 0 ? null : ((k.cur - k.prev) / Math.abs(k.prev)) * 100;
  const was = `${k.prevText ? k.prevText(k.prev) : fmtVal(k.prev)} in the ${span} before`;
  if (d === null) return html`<span class="an-delta" title="${was}">from 0 before</span>`;
  if (Math.abs(d) < 0.05) return html`<span class="an-delta" title="${was}">no change</span>`;
  const up = d > 0;
  const cls = k.good === "none" ? "" : (k.good === "up") === up ? "good" : "bad";
  return html`<span class="an-delta ${cls}" title="${was}"><i>${up ? "▲" : "▼"}</i>${Math.abs(d).toFixed(Math.abs(d) >= 100 ? 0 : 1)}${k.points ? " pts" : "%"}</span>`;
}

function kpiTile(k: Kpi, win: string): Raw {
  return html`<section class="an-tile" data-kpi="${k.id}"><span class="an-tile-l">${k.label}</span><div class="an-tile-v"><b>${k.value}</b>${deltaChip(k, win)}</div>${raw(sparkline(k.series, k.color))}<small>${k.sub}</small></section>`;
}

const compactAmount = (v: number) => (Math.abs(v) >= 10_000 ? fmtVal(v, "amount") : fmtAmount(v));

interface Market {
  series: number[];
  value: number;
  prev: number | null;
  tokens: number;
  capped: boolean;
  candles: Map<string, any[]>;
  list: any[];
}

/** Quote volume per bucket summed over the listed tokens' candles (the indexer leaves test launches out). */
async function loadMarket(d: O): Promise<Market | null> {
  const list = await market<{ tokens: any[] }>("tokens?limit=500").then((r) => r.tokens).catch(() => null);
  if (!list) return null;
  const pick = [...list].sort((a, b) => (b.market_cap ?? 0) - (a.market_cap ?? 0)).slice(0, 20);
  const tf = d.axis.unit === "hour" ? "1h" : "1d";
  const size = d.axis.unit === "hour" ? 3_600_000 : 86_400_000;
  const from = Math.floor((d.prev?.from ?? d.range.from) / 1000), to = Math.ceil(d.range.to / 1000);
  const candles = new Map<string, any[]>();
  await Promise.all(pick.map(async (t) => candles.set(t.mint, ((await market<any>(`tokens/${t.mint}/candles?tf=${tf}&from=${from}&to=${to}`).catch(() => null))?.candles ?? []) as any[])));
  const series = d.axis.t.map(() => 0) as number[];
  let prev = 0;
  for (const cs of candles.values())
    for (const c of cs) {
      const ms = c.t * 1000;
      const i = Math.floor((ms - d.range.from) / size);
      if (i >= 0 && i < series.length) series[i]! += c.volume ?? 0;
      else if (d.prev && ms >= d.prev.from && ms < d.prev.to) prev += c.volume ?? 0;
    }
  return { series, value: series.reduce((s, x) => s + x, 0), prev: d.prev ? prev : null, tokens: pick.length, capped: list.length > pick.length, candles, list };
}

function kpiRow(d: O, m: Market | null, win: string): Raw {
  const k = d.kpis;
  const acc = k.acceptance;
  const v = k.viewers;
  const tiles: Kpi[] = [
    { id: "improvements", label: "Verified improvements", value: fmtInt(k.improvements.value), cur: k.improvements.value, prev: k.improvements.prev, good: "up", series: k.improvements.series, color: tone.good(), sub: `accepted generations, ${pct(k.improvements.gain_pct, 1)} verified gain summed` },
    { id: "acceptance", label: "Acceptance rate", value: acc.value === null ? "no attempts" : pct(acc.value * 100, 1), cur: acc.value, prev: acc.prev, good: "up", points: true, series: acc.series.map((x: number | null) => (x === null ? null : x * 100)), color: slotColor(0), sub: `${fmtInt(acc.accepted)} of ${fmtInt(acc.attempts)} model attempts`, prevText: (x) => pct(x * 100, 1) },
    { id: "spend", label: "Model spend", value: k.spend.value === null ? "none priced" : usd(k.spend.value), cur: k.spend.value, prev: k.spend.prev, good: "none", series: k.spend.series, color: slotColor(1), sub: `${fmtInt(k.spend.priced)} priced attempts`, prevText: (x) => usd(x) },
    { id: "cost", label: "Cost per accepted", value: k.cost_per_accepted.value === null ? "none accepted" : usd(k.cost_per_accepted.value), cur: k.cost_per_accepted.value, prev: k.cost_per_accepted.prev, good: "down", series: k.cost_per_accepted.series, color: slotColor(6), sub: `model spend over ${fmtInt(k.cost_per_accepted.accepted)} accepted improvements`, prevText: (x) => usd(x) },
    { id: "agents", label: "Live agents", value: fmtInt(k.agents.value), cur: k.agents.value, prev: k.agents.prev, good: "up", series: k.agents.series, color: tone.accent(), sub: `in an attempt in the window; ${fmtInt(k.agents.live_now)} live right now` },
    { id: "viewers", label: "Viewers now", value: v.value === null ? "not sampled" : fmtInt(v.value), cur: v.peak, prev: v.prev_peak, good: "up", series: v.series, color: slotColor(4), sub: v.since === null ? "the gate's counts are sampled from this release on" : `watching live desktops; peak ${v.peak === null ? "not sampled" : fmtInt(v.peak)} in the window`, prevText: (x) => `peak ${fmtInt(x)}` },
    { id: "volume", label: "Market volume", value: m ? compactAmount(m.value) : "no answer", cur: m ? m.value : null, prev: m ? m.prev : null, good: "up", series: m ? m.series : [], color: slotColor(2), sub: m ? `${QUOTE} traded over ${m.tokens} listed tokens${m.capped ? " (the 20 largest)" : ""}` : "the market indexer did not answer", prevText: (x) => `${compactAmount(x)} ${QUOTE}` },
  ];
  return html`${tiles.map((t) => kpiTile(t, win))}`;
}

// ------------------------------------------------------------------------------------------------ charts

interface CardShell {
  id: string;
  title: string;
  sub: string;
  h: number;
  wide?: boolean;
}
const CARDS: CardShell[] = [
  { id: "improvements", title: "How much verified work has landed, and where?", sub: "Accepted generations, cumulative, stacked by project. Each step is one generation whose replays confirmed it.", h: 300, wide: true },
  { id: "attempts", title: "How do attempts end?", sub: "Attempts by outcome per hour or day, from published learnings episodes. Scripted test attempts (a recipe patch, no model) are left out unless added.", h: 250 },
  { id: "spend", title: "What does the spend buy?", sub: "Model spend and the accepted improvements of the same attempts, on one time axis.", h: 280 },
  { id: "cost", title: "What does one accepted improvement cost?", sub: "Model spend over accepted improvements: running through the window, and each hour or day on its own.", h: 250 },
  { id: "models", title: "Which model earns its cost?", sub: "Acceptance rate and verified gain per USD, with the sample behind each bar.", h: 200 },
  { id: "heat", title: "When is each agent working?", sub: "Minutes in an attempt per agent, from published model attempts and live sessions.", h: 170, wide: true },
  { id: "verification", title: "Are verifiers keeping up and agreeing?", sub: "Replays of final candidates by role, and the share of counted replays that agreed with the verdict.", h: 280 },
  { id: "viewers", title: "Is anyone watching?", sub: "Peak of distinct viewers on live desktop streams, from the gate's counts sampled once a minute.", h: 220 },
  { id: "runway", title: "How long can each agent keep going?", sub: "Compute vault over the burn of the last 24 h, as the hosted runtime reports it.", h: 200 },
  { id: "price", title: "Does the price follow the work?", sub: "Token price with a mark at each accepted generation of its agent.", h: 200, wide: true },
];

function cardShell(c: CardShell): Raw {
  return html`<section class="panel an-card${c.wide ? " an-wide" : ""}" data-card="${c.id}"><div class="an-card-h"><div><h2>${c.title}</h2><p>${c.sub}</p></div><div class="seg an-card-seg" role="group" aria-label="View"></div></div><div class="an-card-legend" hidden></div><div class="an-card-body an-skel" style="--h:${c.h}px"></div></section>`;
}

const OUTCOMES: [string, string, () => string][] = [
  ["accepted", "Accepted", tone.good],
  ["rejected", "Rejected", tone.bad],
  ["cap_reached", "Spend cap reached", tone.warn],
  ["no_candidate", "No candidate", tone.mute],
  ["expired", "Expired", () => "#8a877f"],
  ["abandoned", "Abandoned", () => "#5f5c56"],
];

function cardDefs(d: O, m: Market | null): Map<string, CardDef | null> {
  const unit: Unit = d.axis.unit === "hour" ? "hour" : "day";
  const per = unit;
  const t: number[] = d.axis.t;
  const since = `since ${shortDay(d.range.from)} (UTC)`;
  const starts = d.first_record_at && d.first_record_at > d.range.from ? ` Records start ${shortDay(d.first_record_at)}.` : "";
  const pts = (f: (i: number) => number | null) => t.map((x, i) => ({ t: x, v: f(i) }));
  const out = new Map<string, CardDef | null>();

  // cumulative verified improvements per project, at the time of each generation
  const projects: any[] = d.improvements.projects;
  const shown = projects.slice(0, 7);
  const rest = projects.slice(7);
  const events: any[] = d.improvements.events;
  // a uniform grid of instants (the chart's time axis is one slot per point): the cumulative figure at
  // each instant is exact, the count of generations accepted up to it
  const end = Math.min(d.now, d.range.to - 1);
  const step = d.axis.unit === "hour" ? 600_000 : 3_600_000;
  const times: number[] = [];
  for (let x = d.range.from; x < end; x += step) times.push(x);
  times.push(Math.floor(end / 1000) * 1000);
  out.set("improvements", {
    id: "improvements",
    variants: [["count", "Generations"], ["gain", "Summed gain"]],
    build: (variant): ChartSpec => {
      const gain = variant === "gain";
      const cum = (names: Set<string>, base: number) => {
        let v = base;
        let k = 0;
        return times.map((x) => {
          while (k < events.length && events[k].at <= x) {
            if (names.has(events[k].project)) v += gain ? events[k].gain_pct : 1;
            k++;
          }
          return { t: x, v: gain ? Math.round(v * 10_000) / 10_000 : v };
        });
      };
      const series = shown.map((p, i) => ({ key: p.project, name: p.project, color: slotColor(i), kind: "step" as const, fmt: gain ? ("pct" as const) : ("num" as const), stack: true, points: cum(new Set([p.project]), gain ? p.before_gain_pct : p.before) }));
      if (rest.length) series.push({ key: "other", name: `${rest.length} other projects`, color: tone.mute(), kind: "step", fmt: gain ? "pct" : "num", stack: true, points: cum(new Set(rest.map((p) => p.project)), rest.reduce((s, p) => s + (gain ? p.before_gain_pct : p.before), 0)) });
      const any = projects.some((p) => p.before + p.generations > 0);
      return {
        kind: "time", unit: "event", height: 300, series: any ? series : [],
        panes: [gain ? "Verified gain summed over accepted generations, %" : "Accepted generations, cumulative"],
        totalLabel: "All projects",
        empty: `No accepted generation ${since}.${starts}`,
        note: (x) => {
          const i = times.indexOf(x);
          const at = i > 0 ? events.filter((e) => e.at > times[i - 1]! && e.at <= x) : [];
          return at.length ? `Since the point before: ${at.map((e) => `#${e.height} ${e.project}${e.gain_pct > 0 ? ` +${e.gain_pct.toFixed(2)}%` : e.fixed ? ` ${e.fixed} tests fixed` : ""}`).join(", ")}` : i === 0 ? "the start of the window" : null;
        },
      };
    },
  });

  const scriptedTotal = Object.values(d.attempts.totals.scripted as Record<string, number>).reduce((s, x) => s + x, 0);
  out.set("attempts", {
    id: "attempts",
    variants: scriptedTotal ? [["model", "Model attempts"], ["all", `With scripted (${fmtInt(scriptedTotal)})`]] : undefined,
    build: (variant): ChartSpec => ({
      kind: "stack", unit, t, fmt: "num", height: 250, yLabel: `Attempts per ${per}`,
      series: [
        ...OUTCOMES.map(([k, name, c]) => ({ key: k, name, color: c(), values: d.attempts.model.map((x: any) => x[k] ?? 0) as number[] })),
        ...(variant === "all" ? [{ key: "scripted", name: "Scripted (no model)", color: tone.mute2(), values: d.attempts.scripted.map((x: any) => Object.values(x as Record<string, number>).reduce((s, n) => s + n, 0)) as number[] }] : []),
      ],
      empty: `No published attempt ${since}.${starts}`,
    }),
  });

  out.set("spend", {
    id: "spend",
    build: (): ChartSpec => ({
      kind: "time", unit, height: 280, panes: [`Model spend per ${per}, USD`, `Accepted improvements per ${per}`],
      series: [
        { key: "usd", name: "Model spend", color: slotColor(1), kind: "columns", fmt: "usd", pane: 0, points: pts((i) => d.spend[i].usd) },
        { key: "accepted", name: "Accepted improvements", color: tone.good(), kind: "line", fmt: "num", pane: 1, fromZero: true, points: pts((i) => (d.spend[i].priced ? d.spend[i].accepted : null)) },
      ],
      empty: `No priced attempt ${since}.${starts}`,
      note: (x) => {
        const i = t.indexOf(x);
        return i >= 0 && d.spend[i].priced ? `${d.spend[i].priced} priced attempts, ${d.spend[i].gain_pct.toFixed(2)}% verified gain` : null;
      },
    }),
  });

  out.set("cost", {
    id: "cost",
    build: (): ChartSpec => ({
      kind: "time", unit, height: 250, panes: ["USD per accepted improvement"],
      series: [
        { key: "running", name: "Running through the window", color: slotColor(6), kind: "area", fmt: "usd", fromZero: true, points: pts((i) => d.kpis.cost_per_accepted.running[i]) },
        { key: "bucket", name: `Each ${per} on its own`, color: slotColor(1), kind: "line", fmt: "usd", dashed: true, fromZero: true, points: pts((i) => d.kpis.cost_per_accepted.series[i]) },
      ],
      empty: `No accepted improvement with a cost record ${since}.${starts}`,
      note: (x) => {
        const i = t.indexOf(x);
        return i >= 0 && d.spend[i].priced && !d.spend[i].accepted ? `${usd(d.spend[i].usd)} spent this ${per}, nothing accepted` : null;
      },
    }),
  });

  const th = d.thresholds;
  const models: any[] = d.models;
  out.set("models", {
    id: "models",
    build: (): ChartSpec => ({
      kind: "bars",
      empty: `No model attempt ${since}.${starts}`,
      groups: models.length
        ? [
            { title: `Acceptance rate (shown from ${th.min_attempts_for_rate} attempts)`, fmt: "pct", color: slotColor(0), none: "too few", rows: models.map((x) => ({ label: x.model, sub: providerName(x.provider) ?? "provider not reported", v: x.rate === null ? null : x.rate * 100, note: `${fmtInt(x.accepted)} of ${fmtInt(x.attempts)} attempts`, tip: [`Attempts: ${fmtInt(x.attempts)}`, `Accepted: ${fmtInt(x.accepted)}`, `Model spend: ${usd(x.usd)}`, `Per accepted: ${usd(x.usd_per_accepted)}`, `Median attempt: ${secs(x.median_duration_s)}`] })) },
            { title: `Verified gain per USD (shown from ${th.min_accepted_for_means} accepted)`, fmt: "pct", color: slotColor(2), none: "too few", rows: models.map((x) => ({ label: x.model, sub: providerName(x.provider) ?? "provider not reported", v: x.gain_per_usd, note: x.usd === null ? "no cost record" : `${pct(x.gain_pct, 1)} over ${usd(x.usd)}`, tip: [`Verified gain summed: ${pct(x.gain_pct)}`, `Model spend: ${usd(x.usd)}`, `Priced attempts: ${fmtInt(x.priced)}`, `Accepted: ${fmtInt(x.accepted)}`] })) },
          ]
        : [],
    }),
  });

  const agents: any[] = d.agents;
  const working = agents.filter((a) => a.live_minutes > 0 || a.minutes.some((x: number) => x > 0)).slice(0, 12);
  out.set("heat", {
    id: "heat",
    build: (): ChartSpec => ({ kind: "heat", unit, t, full: unit === "hour" ? 60 : 1440, rows: working.map((a) => ({ label: agentLabel(a.agent, a.name), values: a.minutes })), empty: `No agent was in an attempt ${since}.${starts}` }),
  });

  const vs: any[] = d.verification.series;
  out.set("verification", {
    id: "verification",
    build: (): ChartSpec => ({
      kind: "time", unit, height: 280, panes: [`Replays per ${per}`, "Agreement with the verdict, %"],
      series: [
        { key: "counted", name: "Counted replays", color: slotColor(0), kind: "columns", fmt: "num", pane: 0, points: pts((i) => (vs[i].counted + vs[i].minority + vs[i].env_failed + vs[i].other > 0 ? vs[i].counted : null)) },
        { key: "minority", name: "In the minority", color: tone.bad(), kind: "line", fmt: "num", pane: 0, points: pts((i) => (vs[i].counted + vs[i].minority > 0 ? vs[i].minority : null)) },
        { key: "env", name: "Environment failures", color: tone.warn(), kind: "line", fmt: "num", pane: 0, dashed: true, points: pts((i) => (vs[i].counted + vs[i].minority + vs[i].env_failed > 0 ? vs[i].env_failed : null)) },
        { key: "agree", name: "Agreement", color: tone.good(), kind: "line", fmt: "pct", pane: 1, range: [0, 100], points: pts((i) => (d.verification.agreement_series[i] === null ? null : d.verification.agreement_series[i] * 100)) },
      ],
      empty: `No replay of a final candidate ${since}.${starts}`,
    }),
  });

  const v = d.kpis.viewers;
  out.set("viewers", v.since === null ? null : {
    id: "viewers",
    build: (): ChartSpec => ({
      kind: "time", unit, height: 220, panes: [`Peak distinct viewers per ${per}`],
      series: [{ key: "peak", name: "Peak viewers", color: slotColor(4), kind: "area", fmt: "num", fromZero: true, points: pts((i) => v.series[i]) }],
      empty: `No viewer sample ${since}. Sampling started ${shortDay(v.since)}.`,
    }),
  });

  const hosted = agents.filter((a) => a.runway);
  out.set("runway", hosted.length ? {
    id: "runway",
    build: (): ChartSpec => ({
      kind: "bars", empty: "",
      groups: [{ title: "Runway at the last 24 h burn", fmt: "min", color: tone.accent(), none: "not burning", rows: hosted.map((a) => ({ label: agentLabel(a.agent, a.name), sub: a.runway.waiting ? `waiting: ${a.runway.waiting}` : a.live ? "live now" : undefined, v: a.runway.runway_h === null ? null : a.runway.runway_h * 60, note: `${usd(a.runway.vault_usd)} vault, ${usd(a.runway.burn_usd_per_h)}/h`, tip: [`Runway: ${hours(a.runway.runway_h)}`, `Vault: ${usd(a.runway.vault_usd)}`, `Burn: ${usd(a.runway.burn_usd_per_h)} per hour`, `Reported: ${stamp(a.runway.reported_at)}`] })) }],
    }),
  } : null);

  // price against verified work: only tokens whose candles span two or more buckets of the window
  const charts: { title: string; sub: string; spec: TimeSpec }[] = [];
  if (m)
    for (const tk of m.list) {
      const cs = (m.candles.get(tk.mint) ?? []).filter((c) => c.t * 1000 >= d.range.from && c.t * 1000 < d.range.to);
      if (cs.length < 2) continue;
      const size = unit === "hour" ? 3_600_000 : 86_400_000;
      const marks = new Map<number, number>();
      for (const e of events) if (e.agent === tk.agent) marks.set(Math.floor(e.at / size) * size, (marks.get(Math.floor(e.at / size) * size) ?? 0) + 1);
      const have = new Set(cs.map((c) => c.t * 1000));
      charts.push({
        title: `${tk.agent_name ?? shortId(tk.agent)} ${tk.symbol ?? ""}`.trim(),
        sub: `${[...marks.values()].reduce((s, n) => s + n, 0)} accepted generations in the window`,
        spec: { kind: "time", unit, height: 170, panes: [`Close, ${QUOTE}`], empty: "", series: [{ key: "close", name: `Close per ${per}`, color: slotColor(0), kind: "area", fmt: "amount", points: t.map((x) => ({ t: x, v: cs.find((c) => c.t * 1000 === x)?.close ?? null })), marks: [...marks.entries()].filter(([x]) => have.has(x)).map(([x, n]) => ({ t: x, text: String(n) })) }] },
      });
    }
  out.set("price", charts.length ? { id: "price", build: (): ChartSpec => ({ kind: "multi", charts: charts.slice(0, 8), empty: "" }) } : null);
  return out;
}

// ------------------------------------------------------------------------------------------------ live now and tables

function liveNow(d: O): Raw {
  const rows: any[] = d.live;
  const body = rows.length
    ? html`<ul class="an-live">${rows.map(
        (s) => html`<li data-session="${s.session_id}"><span class="ins-live"></span><a class="link" href="/agents/${s.agent}/profile">${agentLabel(s.agent, s.name)}</a><span class="an-live-p">${s.project ?? "project not listed"}</span>
          <span class="an-live-t">started ${when(s.started_at)}</span>
          <a class="an-live-w link" href="/sessions/${s.session_id}" title="${s.viewers === null ? "The gate's viewer counts have not been sampled in the last minutes" : "Distinct viewers of this session's live desktop stream, sampled within the last minute"}">${s.viewers === null ? "watch" : `${fmtInt(s.viewers)} watching`}</a></li>`,
      )}</ul>`
    : html`<p class="an-line">No agent is in a session right now.</p>`;
  return html`<section class="panel an-card" id="an-live"><div class="an-card-h"><div><h2>Who is live right now?</h2><p>Live sessions with the distinct viewers of each desktop stream.</p></div><span class="an-count">${rows.length}</span></div>${body}</section>`;
}

function tbl(head: string[], rows: (Raw | string)[][]): Raw {
  const h = head.map((x) => ({ right: x.startsWith("."), hide: x.endsWith("~"), label: x.replace(/^\./, "").replace(/~$/, "") }));
  const c = (k: number) => `${h[k]?.right ? "right num" : ""}${h[k]?.hide ? " hide-sm" : ""}`.trim();
  return html`<div class="tw"><table class="t"><thead><tr>${h.map((x, k) => html`<th class="${c(k)}">${x.label}</th>`)}</tr></thead><tbody>${rows.map((r) => html`<tr>${r.map((v, k) => html`<td class="${c(k)}">${v}</td>`)}</tr>`)}</tbody></table></div>`;
}
const fold = (id: string, title: string, count: number, body: Raw, note?: string): Raw | "" =>
  count ? html`<details class="panel an-fold" id="${id}"><summary><span>${title}</span><span class="an-count">${count}</span></summary>${body}${note ? html`<div class="panel-note">${note}</div>` : ""}</details>` : "";

function tables(d: O, ops: O | null): Raw {
  const agents: any[] = d.agents.filter((a: any) => a.attempts || a.scripted || a.runway || a.generations);
  const aRows = agents.map((a) => [
    html`<a class="link" href="/agents/${a.agent}/profile">${agentLabel(a.agent, a.name)}</a>${a.test_launch ? html` ${badge("test launch")}` : ""}${a.live ? html` <span class="ins-live">live</span>` : ""}`,
    html`${fmtInt(a.attempts)}${a.scripted ? html`<div class="an-sub">${fmtInt(a.scripted)} scripted apart</div>` : ""}`,
    fmtInt(a.accepted),
    a.rate === null ? html`<span class="faint">too few</span>` : pct(a.rate * 100, 1),
    a.usd === null ? html`<span class="faint">none priced</span>` : usd(a.usd),
    a.usd_per_accepted === null ? html`<span class="faint">none</span>` : usd(a.usd_per_accepted),
    a.runway ? html`${hours(a.runway.runway_h)}<div class="an-sub">${usd(a.runway.vault_usd)} vault</div>` : html`<span class="faint">not hosted</span>`,
  ]);
  const wins: any[] = d.improvements.wins;
  const wRows = wins.map((g) => [html`<a class="link" href="/generations/${g.gen_id}">#${g.height}</a> <a class="link" href="/projects/${g.project}">${g.project}</a>`, g.metric ?? (g.fixed ? `${g.fixed} tests fixed` : "not named"), g.gain_pct > 0 ? pct(g.gain_pct) : "fix", html`<a class="link" href="/agents/${g.agent}/profile">${agentLabel(g.agent, g.name)}</a>`, stamp(g.at)]);
  const reasons: any[] = d.reasons;
  const rRows = reasons.map((r) => [String(r.outcome).replace(/_/g, " "), reasonText(r.reason) || String(r.reason).replace(/_/g, " "), fmtInt(r.n), r.usd === null ? html`<span class="faint">none priced</span>` : usd(r.usd)]);
  const ver: any[] = d.verification.verifiers;
  const vRows = ver.map((r) => [html`<span title="${r.verifier}">${shortId(r.verifier)}</span>`, fmtInt(r.replays), fmtInt(r.counted), fmtInt(r.minority), r.disagreement === null ? "no counted replay" : pct(r.disagreement * 100, 1), secs(r.median_replay_s)]);
  const log: any[] = ops?.deploys?.log ?? [];
  const dRows = log.map((e) => [html`${String(e.sha ?? "").slice(0, 7) || "unknown"}${e.kind === "rollback" ? html` ${badge("rollback")}` : ""}`, badge(e.result ?? "unknown", e.result === "ok" ? "good" : e.result === "rolled_back" ? "warn" : "bad"), stamp(e.started_at), e.probe ? html`${fmtInt(e.probe.non_200)} of ${fmtInt(e.probe.probes)}` : "not probed", e.probe ? secs(e.probe.longest_gap_ms / 1000) : "not probed"]);
  const checks: any[] = ops?.monitor?.checks ?? [];
  const cRows = checks.map((c) => [c.id, badge(c.level ?? "unknown", c.level === "ok" ? "good" : c.level === "warn" ? "warn" : "bad"), html`<span class="wrap">${c.msg}</span>`]);
  const f = d.verification.commit_to_first_replay_s;
  return html`
    ${fold("an-t-agents", "Agents: attempts, spend and runway", aRows.length, tbl(["Agent", ".Model attempts", ".Accepted", ".Rate", ".Spend", ".Per accepted~", ".Runway~"], aRows), `Attempts are published learnings episodes in the window. A rate is shown from ${d.thresholds.min_attempts_for_rate} attempts. Runway is the hosted runtime's last report.`)}
    ${fold("an-t-wins", "Biggest verified gains in the window", wRows.length, tbl(["Generation", "Metric", ".Gain", "Agent~", "Accepted~"], wRows))}
    ${fold("an-t-reasons", "Why model attempts ended without a generation", rRows.length, tbl(["Outcome", "Reason", ".Attempts", ".Spend"], rRows), "Model attempts only. A verdict's reason for rejected candidates, the worker's stop note otherwise.")}
    ${fold("an-t-verifiers", "Verifiers", vRows.length, tbl(["Verifier", ".Replays", ".Counted", ".Minority~", ".Disagreement", ".Median replay~"], vRows), f.n ? `Median time from a candidate's commit to its first replay: ${secs(f.median)} over ${f.n} candidates.` : undefined)}
    ${fold("an-t-deploys", "Deploys and measured downtime", dRows.length, tbl(["Release", "Result", "Started~", ".Probes not 200", ".Longest gap"], dRows), "The public health path is probed once a second while public units restart.")}
    ${fold("an-t-checks", "Site checks", cRows.length, tbl(["Check", "State", "What it saw"], cRows))}`;
}

const CSS = `
.an-sec{display:grid;grid-template-columns:minmax(0,1fr);gap:20px}
.an-sec>.panel+.panel{margin-top:0}
.an-h{font-family:var(--display);font-weight:500;font-size:28px;letter-spacing:-.03em;margin-top:8px}
.an-rel{list-style:none;margin:0;padding:10px 16px;display:grid;gap:6px;font-size:13px}
.an-rel li{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center}
.an-rel .sub{color:var(--tt);font-size:12px}
.an-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));grid-auto-rows:240px;gap:16px}
.an-grid>.panel{margin:0;display:flex;flex-direction:column;min-height:0;overflow:auto}
.an-grid>.panel>.panel-h{position:sticky;top:0;z-index:1;background:var(--bg2)}
.an-grid>.panel>*{flex:none}
.an-grid>.panel>.empty{flex:1}
.an-grid .t td,.an-grid .t th{white-space:nowrap}
.an-w2{grid-column:span 2}
.an-kpi{justify-content:space-between;padding:16px 18px}
.an-kpi b{font-family:var(--display);font-weight:500;font-size:40px;letter-spacing:-.04em;line-height:1;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.an-kpi b .faint{font-size:18px;letter-spacing:-.01em}
.an-kpi small{color:var(--tt);font-size:12.5px;line-height:1.45}
@media (max-width:1280px){.an-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:1000px){.an-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:640px){.an-grid{grid-template-columns:minmax(0,1fr);grid-auto-rows:auto}.an-grid>.panel{max-height:340px}.an-w2{grid-column:auto}.an-kpi{gap:10px}}
`;

// ------------------------------------------------------------------------------------------------ page

const PAGE_CSS = `
.an-page{gap:20px}
.an-kpis{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:1px;background:var(--border);border-radius:22px;corner-shape:squircle;overflow:hidden;box-shadow:var(--card-glow)}
.an-tile{background:var(--bg2);padding:14px 16px 12px;min-width:0;display:flex;flex-direction:column;gap:6px}
.an-tile-l{font:500 12px/1.2 var(--sans);letter-spacing:-.01em;color:var(--tt);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.an-tile-v{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;min-height:30px}
.an-tile-v>b{font-family:var(--display);font-weight:500;font-size:28px;line-height:1.05;letter-spacing:-.035em;font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--tp)}
.an-tile>small{color:var(--tt);font-size:11.5px;line-height:1.35;min-height:31px}
.an-delta{flex:none;display:inline-flex;align-items:center;gap:3px;font:500 11px/1 var(--sans);font-variant-numeric:tabular-nums;color:var(--ts);background:var(--bg3);padding:3px 6px;border-radius:7px;white-space:nowrap}
.an-delta i{font-style:normal;font-size:8px;color:var(--tt)}
.an-delta.good i{color:var(--good)}
.an-delta.bad i{color:var(--bad)}
.an-tile.an-skel-t>*{visibility:hidden}
.an-tile.an-skel-t{background:linear-gradient(90deg,var(--bg2),var(--bg3),var(--bg2));background-size:200% 100%;animation:sk 1.2s linear infinite;min-height:132px}
.an-charts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}
.an-charts>.panel+.panel{margin-top:0}
.an-wide{grid-column:1 / -1}
.an-card[hidden]{display:none}
#an-live-slot{min-width:0;display:grid}
#an-missing:empty,#an-live-slot:empty{display:none}
.an-line{padding:6px 18px 16px;color:var(--tt);font-size:13px;line-height:1.45}
.an-count{flex:none;color:var(--tt);font:500 12px/1 var(--sans);font-variant-numeric:tabular-nums;background:var(--bg3);padding:4px 8px;border-radius:8px}
.an-live{list-style:none;margin:0;padding:2px 8px 10px;display:grid}
.an-live li{display:grid;grid-template-columns:auto minmax(0,auto) minmax(0,1fr) auto auto;align-items:center;gap:6px 12px;padding:9px 10px;border-radius:10px;font-size:13px}
.an-live li+li{box-shadow:0 -1px 0 var(--border)}
.an-live-p,.an-live-t{color:var(--tt);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.an-live-w{font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap}
.an-sec-h{display:flex;align-items:baseline;gap:10px;margin-top:8px}
.an-fold{margin:0}
.an-fold>summary{display:flex;align-items:center;gap:10px;padding:14px 18px;cursor:pointer;font:500 13px/1.3 var(--sans);color:var(--tp);list-style:none}
.an-fold>summary::-webkit-details-marker{display:none}
.an-fold>summary::before{content:"";width:7px;height:7px;border-right:1.5px solid var(--tt);border-bottom:1.5px solid var(--tt);transform:rotate(-45deg);transition:transform .15s var(--ease-soft);flex:none}
.an-fold[open]>summary::before{transform:rotate(45deg)}
.an-fold[open]>summary{border-bottom:1px solid var(--border)}
.an-fold>summary:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.an-folds{display:grid;gap:10px}
.an-sub{color:var(--tt);font-size:12px}
.an-grid-s{grid-auto-rows:auto;margin-top:16px}
.an-kpi-s{min-height:150px}
.an-kpi-s b{font-size:30px}
.an-err{padding:18px}
@media (max-width:1180px){.an-kpis{grid-template-columns:repeat(4,minmax(0,1fr))}.an-tile:first-child{grid-column:span 2}}
@media (max-width:900px){.an-charts{grid-template-columns:minmax(0,1fr)}}
@media (max-width:640px){
  .an-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}
  .an-tile-v>b{font-size:24px}
  .an-live li{grid-template-columns:auto minmax(0,1fr) auto}
  .an-live-p,.an-live-t{display:none}
}
`;
function injectStyle() {
  injectInsightsStyle();
  if (typeof document === "undefined" || document.getElementById("an-style")) return;
  const s = document.createElement("style");
  s.id = "an-style";
  s.textContent = CSS + PAGE_CSS + CHART_CSS;
  document.head.appendChild(s);
}

/** The dashboard in view: its charts are removed when the page renders again or the reader leaves. */
let active: { stop(): void } | null = null;

function start(root: HTMLElement, win: string, hidden: boolean) {
  active?.stop();
  const page = root.querySelector<HTMLElement>(".an-page");
  if (!page) return;
  const q = `window=${win}${hidden ? "&hidden=1" : ""}`;
  let cards: (() => void)[] = [];
  let last = "";
  let stopped = false;
  const $ = (sel: string) => page.querySelector<HTMLElement>(sel);

  const paint = (d: O, o: O | null, ops: O | null, idx: O | null, m: Market | null) => {
    for (const c of cards) c();
    cards = [];
    $("#an-kpis")!.innerHTML = kpiRow(d, m, win).s;
    $("#an-updated")!.innerHTML = html`Updated ${when(d.now)}. Window: ${shortDay(d.range.from)} to ${shortDay(Math.min(d.now, d.range.to - 1))} (UTC)${d.prev ? "" : ", from the first record"}.`.s;
    const defs = cardDefs(d, m);
    const missing: string[] = [];
    for (const shell of CARDS) {
      const el = $(`[data-card="${shell.id}"]`);
      if (!el) continue;
      const def = defs.get(shell.id);
      el.hidden = !def;
      if (!def) el.querySelector(".an-card-body")?.classList.remove("an-skel");
      if (def) cards.push(mountCard(el, def));
      else if (shell.id === "price") missing.push(`Price against verified work appears once a listed token has trades in two or more ${d.axis.unit}s of the window.`);
    }
    $("#an-live-slot")!.innerHTML = liveNow(d).s;
    $("#an-missing")!.innerHTML = missing.map((x) => html`<p class="an-line">${x}</p>`.s).join("");
    $("#an-network-slot")!.innerHTML = o ? html`${networkSection(o, idx)}${ops ? opsWidgets(ops) : ""}`.s : html`<section class="panel an-err">${empty("Core did not answer the network status", "It loads again with the page.")}</section>`.s;
    $("#an-tables")!.innerHTML = tables(d, ops).s;
    mountInsightCharts(page);
  };

  const load = async () => {
    const opt = <T,>(p: Promise<T>) => p.catch(() => null);
    const [d, o, ops, idx] = await Promise.all([get<O>(`analytics/dashboard?${q}`), opt(get<O>(`analytics/overview?${q}`)), opt(get<O>(`analytics/ops?${q}`)), opt(market<any>("status"))]);
    const m = await loadMarket(d).catch(() => null);
    if (stopped || !page.isConnected) return;
    // redraw only when a figure changed (the clock and relative times are not figures)
    const sig = JSON.stringify([{ ...d, now: 0 }, o ? { ...o, now: 0, network: { ...o.network, runtime: { ...o.network.runtime, reported_at: 0 } } } : null, ops ? { ...ops, now: 0 } : null, m ? [m.series, m.prev] : null]);
    if (sig === last) return;
    last = sig;
    paint(d, o, ops, idx, m);
  };
  const fail = (e: unknown) => {
    if (stopped || last) return; // keep the last good render on a failed background refresh
    for (const el of page.querySelectorAll(".an-skel, .an-skel-t")) el.classList.remove("an-skel", "an-skel-t");
    $("#an-kpis")!.innerHTML = html`<section class="an-tile" style="grid-column:1 / -1">${empty("Core did not answer the analytics route", e instanceof Error ? e.message : "It is tried again every minute.")}</section>`.s;
    for (const el of page.querySelectorAll<HTMLElement>("[data-card]")) el.hidden = true;
  };
  void load().catch(fail);
  const timer = setInterval(() => {
    if (stopped || !page.isConnected) return stop();
    // a reader with the pointer on a chart keeps the tooltip; the next minute refreshes
    if (document.hidden || page.querySelector(".an-card:hover")) return;
    void load().catch(fail);
  }, 60_000);
  let ev: ReturnType<typeof setTimeout> | null = null;
  const onEvent = (e: Event) => {
    const type = (e as CustomEvent<{ type?: string }>).detail?.type ?? "";
    if (!/^(generation\.|epoch\.|candidate\.(judged|expired))/.test(type) || ev) return;
    ev = setTimeout(() => ((ev = null), void load().catch(fail)), 4000);
  };
  window.addEventListener("units:event", onEvent);
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    if (ev) clearTimeout(ev);
    window.removeEventListener("units:event", onEvent);
    for (const c of cards) c();
    cards = [];
    if (active?.stop === stop) active = null;
  };
  active = { stop };
}

export async function analyticsPage(): Promise<Page> {
  injectStyle();
  const p = qs();
  const win = WINDOWS.some((w) => w[0] === p.get("window")) ? p.get("window")! : "7d";
  const hidden = p.get("hidden") === "1";
  // the frame renders at once with skeletons; the figures load in mount and refresh in place
  const body = html`<div class="ins-page an-page" data-window="${win}">
    <div class="ph-row"><div class="ph-title"><div class="eyebrow">Analytics</div><h1>How the network is doing</h1>
      <div class="ph-sub"><span>Aggregates of public records: published attempts, accepted generations, final replays, live sessions, the runtime's reports and the market indexer${hidden ? ", test launches included" : ""}. <span id="an-updated">Loading.</span></span></div></div>
      <div class="seg" role="group" aria-label="Time window">${WINDOWS.map(([k, l]) => chip("window", k === "7d" ? "" : k, l, win === "7d" ? "" : win))}</div></div>
    <div class="an-kpis" id="an-kpis" aria-label="Headline figures">${[0, 1, 2, 3, 4, 5, 6].map(() => html`<section class="an-tile an-skel-t"><span>.</span></section>`)}</div>
    <div class="an-charts" id="an-charts">${CARDS.slice(0, 8).map(cardShell)}<div id="an-live-slot"></div>${CARDS.slice(8).map(cardShell)}</div>
    <div id="an-missing"></div>
    <div id="an-network-slot"></div>
    <div class="an-folds" id="an-tables"></div>
  </div>`;
  return {
    title: "Analytics",
    body,
    mount: (root) => {
      wireInsights(root);
      start(root, win, hidden);
    },
  };
}
