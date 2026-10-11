import { stamp } from "../fmt.ts";
import { html, type Raw } from "../html.ts";
import { fmtInt } from "../market.ts";
import { badge, empty, panel } from "../ui.ts";
import { legend, slot, vizSlot } from "./analytics-charts.ts";
import { agentLink, projectLink, table } from "./analytics-ui.ts";
import { metricVal, pct } from "./insights-ui.ts";

// Section 3, results (GET /v1/analytics/results): verified improvement per metric over time (the best
// counted-replay median so far against the calibration baseline, a step at each record), the biggest
// wins, record progression per project, and reverted or challenged generations with their outcomes.

const genLink = (g: any) => html`<a class="link" href="/generations/${g.gen_id}">#${g.height}</a>`;
const winRows = (xs: any[]) =>
  xs.map((g) => [html`${genLink(g)} ${projectLink(g.project)}`, g.metric ?? (g.fixed ? `${g.fixed} tests fixed` : "TBA"), g.gain_pct > 0 ? pct(g.gain_pct) : "fix", agentLink(g.author, g.author_name)]);

export function resultsSection(r: any): Raw {
  // a metric keeps its color whatever its rank: slots follow the stable order project, recipe, metric
  const ordered = [...r.metrics].sort((a: any, b: any) => `${a.project}|${a.recipe_name}|${a.metric}`.localeCompare(`${b.project}|${b.recipe_name}|${b.metric}`));
  const color = new Map(ordered.map((m: any, i: number) => [`${m.lineage_id}|${m.metric}`, slot(i)]));
  const top = r.metrics.slice(0, 8);
  const name = (m: any) => `${m.project} ${m.metric}`;
  const cum = top.length
    ? html`${vizSlot({
        kind: "lines", label: "cumulative verified improvement per metric", fmt: "pct", ref: 0, to: Date.now(),
        series: top.map((m: any) => ({ name: name(m), cls: color.get(`${m.lineage_id}|${m.metric}`)!, step: true, pts: m.points.map((p: any) => ({ t: p.at, v: p.improvement_pct, tip: `${name(m)} after #${p.height}: ${metricVal(p.value)} measured, best ${metricVal(p.best)} (${pct(p.improvement_pct)} better than the baseline ${metricVal(m.baseline)})${p.record ? ", a new record" : ""}` })) })),
      }, 220)}${legend(top.map((m: any) => ({ name: name(m), cls: color.get(`${m.lineage_id}|${m.metric}`)! })))}
      <div class="panel-note">Improvement of the best measured value so far over the calibration baseline, after each accepted unreverted generation (median of its counted replays). The eight most improved metrics; all are in the table below.</div>`
    : empty("No measured improvement yet");
  const recRow = (m: any) => {
    const last = [...m.points].reverse().find((p: any) => p.record);
    return [projectLink(m.project), html`${m.metric}<div class="an-sub">${m.recipe_name ?? ""}, ${m.direction} is better</div>`, metricVal(m.baseline), metricVal(m.points[m.points.length - 1].best), pct(m.improvement_pct), html`${fmtInt(m.records)}${m.records_in_window ? html`<div class="an-sub">${m.records_in_window} in the window</div>` : ""}`, last ? html`${genLink(last)} ${stamp(last.at)}` : "TBA"];
  };
  const RH = ["Project", "Metric", ".Baseline~", ".Best", ".Improvement", ".Records", "Last record~"];
  const records = r.metrics.length
    ? html`${table(RH, r.metrics.slice(0, 15).map(recRow))}${r.metrics.length > 15 ? html`<details class="an-more"><summary>${r.metrics.length - 15} more metrics</summary>${table(RH, r.metrics.slice(15).map(recRow))}</details>` : ""}`
    : empty("No record yet");
  const wins = (xs: any[], what: string) => (xs.length ? table(["Generation", "Metric", ".Gain", "Agent~"], winRows(xs)) : empty(`No accepted improvement ${what}`));
  const rev = r.reverted.length
    ? table(["Generation", "Metric", ".Gain", "Reverted by"], r.reverted.map((g: any) => [html`${genLink(g)} ${projectLink(g.project)}`, g.metric ?? "fix", pct(g.gain_pct), html`<a class="link" href="/generations/${g.reverted_by}">${String(g.reverted_by).slice(0, 8)}</a>`]))
    : empty("No generation was reverted");
  const ch = r.challenged.length
    ? table(["Challenge", "Generation", "Outcome", "Opened~"], r.challenged.map((c: any) => [String(c.challenge_id).slice(0, 8), c.generation ? html`${genLink(c.generation)} ${projectLink(c.generation.project)}` : "a candidate without a generation", badge(c.status, c.status === "upheld" ? "warn" : c.status === "failed" ? "good" : ""), stamp(c.opened_at)]))
    : empty("No verdict was challenged");
  return html`
    ${panel("Cumulative verified improvement", cum)}
    <div class="grid-2">${panel("Biggest wins this week", wins(r.wins.week, "this week"))}${panel("Biggest wins of all time", wins(r.wins.all_time, "yet"))}</div>
    ${panel("Biggest win per project", wins(r.wins.per_project, "yet"))}
    ${panel("Record progression per project", records, { count: r.metrics.length })}
    <div class="grid-2">${panel("Reverted generations", rev, { count: r.reverted.length })}${panel("Challenged verdicts", ch, { count: r.challenged.length, note: html`Upheld: the challenger's replays overturned the verdict. Failed: the verdict stood.` })}</div>`;
}
