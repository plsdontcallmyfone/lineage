import { stamp } from "../fmt.ts";
import { html, type Raw } from "../html.ts";
import { fmtInt } from "../market.ts";
import { empty, panel } from "../ui.ts";
import { axisLabels, legend, slot, vizSlot, type Cls } from "./analytics-charts.ts";
import { agentLink, projectLink, table } from "./analytics-ui.ts";
import { agentLabel, kpis, pct, secs } from "./insights-ui.ts";

// Section 2, agent work (GET /v1/analytics/work): attempts by outcome, acceptance over time per agent
// and per project, attempt times, tool calls and turns, lines changed, live-time share and cross-agent
// conflicts. Attempts are published learnings episodes (an attempt counts once its episode is published).

const OUTCOMES: [string, string, Cls][] = [
  ["accepted", "accepted", "ok"],
  ["rejected", "rejected", "bad"],
  ["cap_reached", "cap reached", "warn"],
  ["no_candidate", "no candidate", "mute"],
  ["expired", "expired", "mute2"],
  ["abandoned", "abandoned", "acc"],
];

const fix = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? "TBA" : v.toFixed(d));

function rateLines(rows: any[], axis: any, name: (r: any) => string, label: string): Raw {
  const top = rows.slice(0, 6);
  return html`${vizSlot({
    kind: "lines",
    label,
    fmt: "pct",
    from: axis.t[0],
    to: axis.t[axis.t.length - 1],
    series: top.map((r, i) => ({
      name: name(r),
      cls: slot(i),
      pts: r.series
        .map((s: any, k: number) => (s.attempts ? { t: axis.t[k], v: (s.accepted / s.attempts) * 100, tip: `${name(r)}: ${s.accepted} of ${s.attempts} accepted` } : null))
        .filter(Boolean),
    })),
  }, 150)}${legend(top.map((r, i) => ({ name: name(r), cls: slot(i) })))}`;
}

export function workSection(w: any, activity: Raw): Raw {
  const lab = axisLabels(w.axis);
  const per = w.axis.unit === "hour" ? "hour" : "day";
  const t = w.outcomes.totals;
  const attempts = Object.values(t).reduce((s: number, x: any) => s + x, 0) as number;
  const head = kpis([
    ["Attempts", fmtInt(attempts), `${fmtInt(t.accepted)} accepted, ${fmtInt(t.cap_reached)} at the spend cap`],
    ["Start to commit", secs(w.times.start_to_commit_s.median), `median of ${w.times.start_to_commit_s.n} committed attempts`],
    ["Commit to verdict", secs(w.times.commit_to_verdict_s.median), `median, mean ${secs(w.times.commit_to_verdict_s.mean)}`],
    ["Tool calls per attempt", fix(w.tools.tool_calls.mean), `mean over ${fmtInt(w.tools.attempts)} model attempts, median ${fix(w.tools.tool_calls.median, 0)}`],
    ["Lines per accepted", w.lines.median === null ? "TBA" : String(w.lines.median), `median added plus removed, ${w.lines.n} generations`],
  ]);
  const outcomes = html`${vizSlot({ kind: "stack", label: `attempts per ${per} by outcome`, x: lab, series: OUTCOMES.map(([k, n, c]) => ({ name: n, cls: c, values: w.outcomes.series.map((s: any) => s[k] ?? 0) })) }, 170)}${legend(OUTCOMES.map(([, n, c]) => ({ name: n, cls: c })))}
    <div class="panel-note">"Cap reached" needs the worker's stop note (from this release on: ${fmtInt(w.outcomes.stop_recorded)} attempts in the window carry one); earlier attempts that stopped at the cap count as "no candidate".</div>`;
  const nm = (r: any) => agentLabel(r.agent, r.name);
  const agentRows = w.rate.by_agent.map((r: any) => [agentLink(r.agent, r.name), fmtInt(r.attempts), fmtInt(r.accepted), r.rate === null ? html`<span class="faint" title="Shown from ${w.rate.min_attempts} attempts">too few</span>` : pct(r.rate * 100, 1)]);
  const projRows = w.rate.by_project.map((r: any) => [projectLink(r.key), fmtInt(r.attempts), fmtInt(r.accepted), r.rate === null ? html`<span class="faint">too few</span>` : pct(r.rate * 100, 1)]);
  const rates = w.rate.by_agent.length
    ? html`<div class="an-pairs">
        <h3>Per agent <span>accepted over attempts per ${per}, the six busiest</span></h3>${rateLines(w.rate.by_agent, w.axis, nm, "acceptance rate per agent")}
        ${table(["Agent", ".Attempts", ".Accepted", ".Rate"], agentRows)}
        <h3>Per project <span>accepted over attempts per ${per}</span></h3>${rateLines(w.rate.by_project, w.axis, (r) => r.key, "acceptance rate per project")}
        ${table(["Project", ".Attempts", ".Accepted", ".Rate"], projRows)}</div>`
    : empty("No published attempt in this window");
  const times = vizSlot({
    kind: "lines", label: `median attempt times per ${per}`, fmt: "s", from: w.axis.t[0], to: w.axis.t[w.axis.t.length - 1],
    series: [
      { name: "start to commit", cls: "c1", pts: w.times.series.map((s: any, k: number) => (s.commit_s === null ? null : { t: w.axis.t[k], v: s.commit_s })).filter(Boolean) },
      { name: "commit to verdict", cls: "c2", pts: w.times.series.map((s: any, k: number) => (s.verdict_s === null ? null : { t: w.axis.t[k], v: s.verdict_s })).filter(Boolean) },
    ],
  }, 150);
  const tl = w.tools;
  const tools = html`${table(["Per attempt", ".Mean", ".Median"], [
      ["Tool calls", fix(tl.tool_calls.mean), fix(tl.tool_calls.median, 0)],
      ["Reads", fix(tl.reads.mean), fix(tl.reads.median, 0)],
      ["Searches", fix(tl.searches.mean), fix(tl.searches.median, 0)],
      ["Directory lists", fix(tl.lists.mean), fix(tl.lists.median, 0)],
      ["Edits", fix(tl.edits.mean), fix(tl.edits.median, 0)],
      ["Evaluations", fix(tl.evals.mean), fix(tl.evals.median, 0)],
      [html`Model turns<div class="an-sub">${tl.turns.n} attempts with a stop note</div>`, fix(tl.turns.mean), fix(tl.turns.median, 0)],
    ])}
    ${tl.stops.length ? html`<div class="ins-pad an-sub">Why the model loop ended: ${tl.stops.map((s: any) => `${s.stop} ${s.n}`).join(", ")}.</div>` : ""}
    <div class="panel-note">${fmtInt(tl.attempts)} model attempts; ${fmtInt(tl.scripted)} scripted attempts (a recipe patch applied without a model) are left out. Tool calls are the episode's recorded actions.</div>`;
  const lines = w.lines.rows.length
    ? table(["Generation", "Project~", ".Added", ".Removed", ".Lines"], w.lines.rows.slice(0, 12).map((l: any) => [html`<a class="link" href="/generations/${l.gen_id}">#${l.height}</a><div class="an-sub">${stamp(l.at)}</div>`, projectLink(l.project), fmtInt(l.added), fmtInt(l.removed), fmtInt(l.lines)]))
    : empty("No accepted generation in this window");
  const ls = w.live_share;
  const live = ls.rows.length
    ? html`${vizSlot({ kind: "heat", label: `minutes live per agent per ${per}`, x: lab, full: w.axis.unit === "hour" ? 60 : 1440, unit: per, rows: ls.rows.map((r: any) => ({ name: agentLabel(r.agent, r.name), values: r.minutes })) }, 60 + ls.rows.length * 21)}
      <div class="panel-note">Shade: the share of each ${per} the agent spent in an attempt (published attempts and live sessions).${ls.others ? ` Other agents: ${fmtInt(ls.others)} minutes.` : ""}</div>`
    : empty("No one was live in this window");
  const conflicts = w.conflicts.length
    ? table(["Project", ".Final candidates", ".Conflicts", "Why~"], w.conflicts.map((c: any) => [projectLink(c.project), fmtInt(c.final), fmtInt(c.conflicts), Object.entries(c.by_reason).map(([k, n]) => `${k.replace(/_/g, " ")} ${n}`).join(", ") || "none"]))
    : empty("No final candidate in this window");
  return html`
    <section class="panel">${head}</section>
    ${activity}
    ${panel(`Attempts per ${per} by outcome`, outcomes, { count: attempts })}
    ${panel("Acceptance over time", rates)}
    <div class="grid-2">${panel("Attempt times", html`${times}${legend([{ name: "start to commit", cls: "c1" }, { name: "commit to verdict", cls: "c2" }])}`)}${panel("Tool calls and turns", tools)}</div>
    <div class="grid-2">${panel("Lines changed per accepted generation", lines, { count: w.lines.n, note: html`Added plus removed lines of the accepted patch; mean ${w.lines.mean === null ? "TBA" : w.lines.mean.toFixed(1)}.` })}${panel("Cross-agent conflicts per project", conflicts, { note: html`Final candidates rejected because another agent's generation landed first (stale conflict, stale parent, apply conflict).` })}</div>
    ${panel("Live-time share", live)}`;
}
