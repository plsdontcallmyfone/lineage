import { get } from "../api.ts";
import { effect, repoLabel, stamp, when } from "../fmt.ts";
import { html, type Raw } from "../html.ts";
import { auditBadge, badge, empty, icon, kindBadge, panel } from "../ui.ts";
import { githubLink, type GithubField } from "./generation-github.ts";
import { agentLabel, chartSlot, kpis, metricVal, pct, qs, wireInsights } from "./insights-ui.ts";
import { injectProjectsStyle, type ProjectMetric, type ProjectRow } from "./projects.ts";
import { providerName } from "./social-ui.ts";
import type { Page } from "./types.ts";

// One project (/projects/:owner/:name, or /projects/<repo id> for a repository not on GitHub), from
// Core GET /v1/analytics/project: per lineage a chart of each metric over generations (values measured
// by the counted replays of each accepted generation, the calibration baseline as a dashed rule), the
// metric table, the generation timeline with each GitHub commit and its Verified state, live sessions
// (links to the live page; recordings are off, so ended sessions are facts only) and the number of open
// candidates. Test launches' generations stay in the timeline with their author withheld unless ?hidden=1.

interface Point { height: number; gen_id: string; value: number; parent: number | null; replays: number; at: number; targeted: boolean }
interface Gen {
  gen_id: string; height: number; kind: string | null; target: unknown; metric: string | null; effect: any; gain_pct: number; fixed: number;
  author: string | null; author_name: string | null; author_hidden: boolean; model: string | null; provider: string | null;
  accepted_at: number; reverted_by: string | null; audit_status: string | null; github: GithubField;
}
interface Session { session_id: string; state: string; agent: string | null; name: string | null; started_at: number; last_at: number; ended_at: number | null; desktop: boolean; events: number; height: number | null }
interface Lineage { lineage_id: string; recipe_name: string | null; class: string | null; status: string; height: number; open_candidates: number; accepted: number; metrics: (ProjectMetric & { points: Point[]; latest_change_pct: number | null })[]; timeline: Gen[]; sessions: Session[] }
type Project = Omit<ProjectRow, "lineages"> & { lineages: Lineage[] };

function metricCharts(l: Lineage): Raw {
  const ms = l.metrics.filter((m) => m.points.length || m.baseline !== null);
  if (!ms.length) return empty("No measured values yet", "Values appear with the lineage's first accepted generation.");
  return html`<div class="ins-grid">${ms.map(
    (m) => html`<div class="ins-mini" data-metric="${m.name}"><h3>${m.name}<span>${m.direction} is better${m.improvement_pct ? `, ${pct(m.improvement_pct)} from baseline` : ""}</span></h3>
      ${chartSlot({
        type: "line", label: m.name, xLabel: "generation", baseline: m.baseline,
        points: m.points.map((p) => ({ x: p.height, y: p.value, hit: p.targeted, tip: `gen ${p.height}: ${p.value.toLocaleString("en-US")}${p.parent !== null ? `\nparent measured ${p.parent.toLocaleString("en-US")}` : ""}\nmedian of ${p.replays} counted replay${p.replays === 1 ? "" : "s"}${p.targeted ? "\nthis generation targeted this metric" : ""}\n${stamp(p.at)}` })),
      }, 150)}</div>`,
  )}</div>
  <div class="ins-legend"><span><i class="dash"></i>baseline (calibration)</span><span><i></i>measured after each accepted generation (filled: the generation targeted this metric)</span></div>`;
}

function metricTable(l: Lineage): Raw {
  return html`<div class="tw"><table class="t">
    <thead><tr><th>Metric</th><th class="right">Baseline</th><th class="right">Best</th><th class="right">Improvement</th><th class="right hide-sm">Latest</th><th class="right hide-sm">Measured</th></tr></thead>
    <tbody>${l.metrics.map(
      (m) => html`<tr><td>${m.name}<div class="sub">${m.direction} is better</div></td>
        <td class="right num">${metricVal(m.baseline)}</td>
        <td class="right num">${m.best ? html`${metricVal(m.best.value)}<div class="sub"><a class="link" href="/generations/${m.best.gen_id}">gen ${m.best.height}</a></div>` : html`<span class="faint">none yet</span>`}</td>
        <td class="right num ${m.improvement_pct && m.improvement_pct > 0 ? "good-t" : ""}">${m.improvement_pct === null ? html`<span class="faint">TBA</span>` : pct(m.improvement_pct)}</td>
        <td class="right num hide-sm">${m.latest ? html`${metricVal(m.latest.value)}<div class="sub">gen ${m.latest.height}</div>` : html`<span class="faint">TBA</span>`}</td>
        <td class="right num hide-sm">${m.points.length}</td></tr>`,
    )}</tbody></table></div>`;
}

function timeline(l: Lineage, hidden: boolean): Raw {
  if (!l.timeline.length) return empty("No accepted generation yet");
  return html`<div class="tw"><table class="t">
    <thead><tr><th>Gen</th><th>Change</th><th class="hide-sm">Author</th><th>GitHub</th><th class="right hide-sm">Accepted</th></tr></thead>
    <tbody>${l.timeline.map(
      (g) => html`<tr class="${g.reverted_by ? "reverted" : ""}" data-gen="${g.gen_id}">
        <td><a class="link" href="/generations/${g.gen_id}">${g.height}</a></td>
        <td>${kindBadge(g.kind, g.target)} ${effect(g.effect, { compact: true })}${g.reverted_by ? html` ${badge("reverted", "bad", icon.revert)}` : ""}${g.audit_status ? html` ${auditBadge(g.audit_status)}` : ""}
          <div class="sub show-sm">${g.author_hidden ? "test launch" : agentLabel(g.author, g.author_name)}</div></td>
        <td class="hide-sm">${g.author_hidden ? html`<span class="faint" title="A test launch: listed with ?hidden=1">test launch</span>` : html`<a class="link" href="/agents/${g.author}/profile">${agentLabel(g.author, g.author_name)}</a>`}
          <div class="sub">${g.model ? `${g.model}${g.provider ? `, ${providerName(g.provider)}` : ""}` : g.author_hidden ? "" : "model not attested"}</div></td>
        <td>${githubLink(g.github)}</td>
        <td class="right hide-sm">${when(g.accepted_at)}</td></tr>`,
    )}</tbody></table></div>
    ${hidden ? "" : l.timeline.some((g) => g.author_hidden) ? html`<div class="panel-note">Generations by test launches keep their place in the lineage; <a class="link" href="?hidden=1" data-q>show their authors</a>.</div>` : ""}`;
}

function sessions(l: Lineage): Raw {
  const live = l.sessions.filter((s) => s.state === "live");
  const recent = l.sessions.filter((s) => s.state !== "live").slice(0, 8);
  const row = (s: Session) => html`<li class="pjd-s">
    ${s.state === "live" ? html`<a class="link" href="/sessions/${s.session_id}"><span class="ins-live">live</span></a>` : badge(s.state === "sealed" ? "sealed until final" : s.state, s.state === "final" ? "good" : "")}
    <span>${s.agent ? html`<a class="link" href="/agents/${s.agent}/profile">${agentLabel(s.agent, s.name)}</a>` : html`<span class="faint" title="The session's candidate is open: who wrote it stays private until it is final">author sealed</span>`}</span>
    <span class="sub">${s.desktop ? "desktop, " : ""}${s.events} events, started ${when(s.started_at)}${s.ended_at ? html`, ended ${when(s.ended_at)}` : ""}</span></li>`;
  return html`<div class="ins-pad pjd-sess">
    <div class="eyebrow">Live now</div>
    ${live.length ? html`<ul class="pjd-sl">${live.map(row)}</ul>` : html`<p class="ins-note">No live session on this lineage right now.</p>`}
    <div class="eyebrow" style="margin-top:10px">Recent</div>
    ${recent.length ? html`<ul class="pjd-sl">${recent.map(row)}</ul>` : html`<p class="ins-note">No ended session yet.</p>`}
    <p class="ins-note">Sessions are watched live; ended sessions keep their facts, with no replay of the screen.</p></div>`;
}

const CSS = `
.pjd-sl{list-style:none;margin:6px 0 0;padding:0;display:grid;gap:8px}
.pjd-s{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center;font-size:13px}
.pjd-s .sub{color:var(--tt);font-size:12px}
.pjd-lin-h{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:baseline}
.pjd-lin-h h2{font-family:var(--display);font-weight:500;font-size:24px;letter-spacing:-.03em}
`;
function injectStyle() {
  injectProjectsStyle();
  if (typeof document === "undefined" || document.getElementById("pjd-style")) return;
  const s = document.createElement("style");
  s.id = "pjd-style";
  s.textContent = CSS;
  document.head.appendChild(s);
}

export async function projectPage(params: string[]): Promise<Page> {
  injectStyle();
  const key = decodeURIComponent(params[0] ?? "");
  const hidden = qs().get("hidden") === "1";
  const p = await get<Project>(`analytics/project?repo=${encodeURIComponent(key)}${hidden ? "&hidden=1" : ""}`);
  const title = p.github ? repoLabel(p.repo) : p.repo;
  // retired lineages that never accepted a generation say nothing here; they stay on their own pages
  const shown = p.lineages.filter((l) => l.status === "active" || l.timeline.length);
  const quiet = p.lineages.length - shown.length;
  const body = html`<div class="ins-page pjd-page" data-project="${p.key}">
    <div class="ph-row"><div class="ph-title"><div class="eyebrow"><a class="link" href="/projects">Projects</a></div><h1>${title}</h1>
      <div class="ph-sub"><span>${p.classes.join(", ")}</span>${p.github ? html`<a class="link" href="${p.repo}" target="_blank" rel="noopener">GitHub ${icon.ext}</a>` : ""}
        ${p.live_agents.length ? html`<span class="ins-live">${p.live_agents.length} working now</span>` : ""}
        <a class="link" href="/generations?repo=${encodeURIComponent(p.key)}" data-q>All its generations</a></div></div></div>
    <section class="panel">${kpis([
      ["Accepted generations", String(p.accepted), p.reverted ? `${p.reverted} reverted` : "none reverted"],
      ["Last improvement", p.last_improvement_at ? when(p.last_improvement_at) : html`<span class="faint">none yet</span>`],
      ["Agents working now", String(p.live_agents.length), p.live_agents.map((a) => agentLabel(a.agent, a.name)).join(", ") || "none"],
      ["Open candidates", String(p.open_candidates), "a count only until final"],
    ])}</section>
    ${shown.sort((a, b) => Number(b.status === "active") - Number(a.status === "active") || b.timeline.length - a.timeline.length).map(
      (l) => html`<section class="pjd-lin" data-lineage="${l.lineage_id}">
        <div class="pjd-lin-h"><h2>${l.recipe_name ?? "lineage"}</h2><span class="sub">gen ${l.height}${l.status !== "active" ? `, ${l.status}` : ""}, ${l.open_candidates} open candidate${l.open_candidates === 1 ? "" : "s"}</span>
          <a class="link" href="/lineages/${l.lineage_id}">Lineage page</a></div>
        <div class="grid-2" style="margin-top:12px">
          ${panel("Metrics over generations", metricCharts(l), { count: l.metrics.length })}
          ${panel("Sessions", sessions(l), { count: l.sessions.filter((s) => s.state === "live").length ? `${l.sessions.filter((s) => s.state === "live").length} live` : undefined })}
        </div>
        <div style="margin-top:20px">${panel("Baseline and best", metricTable(l))}</div>
        <div style="margin-top:20px">${panel("Generation timeline", timeline(l, hidden), { count: l.timeline.length })}</div>
      </section>`,
    )}
    ${quiet ? html`<p class="ins-note">${quiet} retired lineage${quiet === 1 ? "" : "s"} of this repository without an accepted generation ${quiet === 1 ? "is" : "are"} left out (see the <a class="link" href="/projects?all=1" data-q>full list</a>).</p>` : ""}
  </div>`;
  return {
    title: title,
    body,
    pollMs: 30_000,
    refreshOn: (e) => /^(generation\.|candidate\.(committed|judged|expired)|session\.)/.test(e.type),
    mount: (root) => wireInsights(root),
  };
}
