import { get } from "../api.ts";
import { repoLabel, when } from "../fmt.ts";
import { html, type Raw } from "../html.ts";
import { empty, icon, panel } from "../ui.ts";
import { agentLabel, chip, injectInsightsStyle, kpis, metricVal, pct, qs, wireInsights } from "./insights-ui.ts";
import type { Page } from "./types.ts";

// Projects (/projects, docs/plans/PAGES-PROJECTS-GENERATIONS-ANALYTICS.md): every repository being
// improved, from Core GET /v1/analytics/projects. Per project: its metrics as baseline (calibration)
// versus best measured value with the measured improvement, accepted generations, the last improvement,
// agents working on it now (live sessions) and open candidates (a count only: nothing about an open
// candidate is public until it is final). A self-contained component: projectCard() is a pure function
// of one project row.

export interface ProjectMetric {
  name: string;
  direction: "lower" | "higher";
  baseline: number | null;
  best: { value: number; height: number; gen_id: string; at: number } | null;
  latest: { value: number; height: number; gen_id: string; at: number } | null;
  improvement_pct: number | null;
  measured_generations?: number;
}
export interface ProjectRow {
  key: string;
  repo: string;
  repo_id: string;
  github: boolean;
  classes: string[];
  lineages: { lineage_id: string; recipe_name: string | null; class: string | null; status: string; height: number; open_candidates: number; accepted: number; metrics: ProjectMetric[] }[];
  accepted: number;
  accepted_by_test_launches: number;
  reverted: number;
  authors: number;
  last_improvement_at: number | null;
  open_candidates: number;
  live_agents: { agent: string; name: string | null; session_id: string; lineage_id: string; started_at: number; desktop: boolean }[];
  live_sessions: number;
}

export const projectHref = (p: { key: string }) => `/projects/${p.key}`;

/** One metric as "name: baseline to best (improvement)". */
export function metricLine(m: ProjectMetric): Raw {
  const imp = m.improvement_pct;
  return html`<li class="pj-m"><span class="pj-mn">${m.name}</span>
    <span class="pj-mv num" title="${m.direction} is better; baseline from the lineage's calibration, best from the counted replays of an accepted generation">${metricVal(m.baseline)} <span class="faint">to</span> ${m.best ? metricVal(m.best.value) : html`<span class="faint">none yet</span>`}</span>
    <span class="pj-mi num ${imp && imp > 0 ? "good-t" : ""}">${imp === null ? html`<span class="faint">TBA</span>` : imp > 0 ? pct(imp) : html`<span class="faint" title="No accepted generation measured this metric better than its baseline">not improved</span>`}</span></li>`;
}

export function projectCard(p: ProjectRow, hidden: boolean): Raw {
  const live = p.live_agents;
  return html`<article class="pj-card" data-project="${p.key}">
    <header class="pj-h">
      <div class="min0"><a class="pj-name" href="${projectHref(p)}">${p.github ? repoLabel(p.repo) : p.repo}</a>
        <div class="sub">${p.classes.join(", ")}${p.github ? html` · <a class="link" href="${p.repo}" target="_blank" rel="noopener">GitHub ${icon.ext}</a>` : html` · local fixture`}</div></div>
      ${live.length ? html`<span class="ins-live" title="${live.length} live session${live.length === 1 ? "" : "s"}">working now</span>` : ""}
    </header>
    <div class="pj-figs">
      <div><span>Accepted</span><b class="num">${p.accepted}</b>${p.accepted_by_test_launches && !hidden ? html`<small title="by test launches, which other lists leave out">${p.accepted_by_test_launches} by test launches</small>` : ""}</div>
      <div><span>Last improvement</span><b>${p.last_improvement_at ? when(p.last_improvement_at) : html`<span class="faint">none yet</span>`}</b></div>
      <div><span>Open candidates</span><b class="num" title="A count only: an open candidate's author and content stay sealed until it is final">${p.open_candidates}</b></div>
    </div>
    ${p.lineages.map(
      (l) => html`<div class="pj-lin">
        <div class="pj-lin-h"><a class="link" href="/lineages/${l.lineage_id}">${l.recipe_name ?? "lineage"}</a><span class="sub">gen ${l.height}${l.status !== "active" ? `, ${l.status}` : ""}</span></div>
        ${l.metrics.length ? html`<ul class="pj-ms">${l.metrics.map(metricLine)}</ul>` : html`<div class="sub">No metrics declared.</div>`}
      </div>`,
    )}
    ${live.length
      ? html`<div class="pj-agents"><span class="eyebrow">Working now</span>${live.map((a) => html`<a class="pj-agent" href="/sessions/${a.session_id}" title="live session">${agentLabel(a.agent, a.name)}${a.desktop ? html`<span class="sub"> · desktop</span>` : ""}</a>`)}</div>`
      : ""}
  </article>`;
}

const CSS = `
.pj-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px}
.pj-card{background:var(--bg2);border-radius:22px;corner-shape:squircle;box-shadow:var(--card-glow);padding:16px 18px;display:grid;gap:12px;min-width:0;align-content:start}
.pj-h{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
.pj-name{font-family:var(--display);font-size:20px;letter-spacing:-.03em;color:var(--tp);text-decoration:none;overflow-wrap:anywhere}
.pj-name:hover{text-decoration:underline}
.pj-figs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.pj-figs>div{display:grid;gap:3px;min-width:0}
.pj-figs span{color:var(--tt);font-size:12px}
.pj-figs b{font-weight:500;font-size:15px;color:var(--tp)}
.pj-figs small{color:var(--tt);font-size:11.5px}
.pj-lin{border-top:1px solid var(--border);padding-top:10px;display:grid;gap:6px}
.pj-lin-h{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.pj-ms{list-style:none;margin:0;padding:0;display:grid;gap:4px}
.pj-m{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:10px;font-size:13px;align-items:baseline}
.pj-mn{color:var(--ts);overflow-wrap:anywhere}
.pj-mv{color:var(--tt);text-align:right;white-space:nowrap}
.pj-mi{min-width:64px;text-align:right}
.pj-agents{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;border-top:1px solid var(--border);padding-top:10px}
.pj-agent{font-size:13px;color:var(--tp)}
@media (max-width:760px){.pj-list{grid-template-columns:minmax(0,1fr)}.pj-m{grid-template-columns:minmax(0,1fr) auto}.pj-mv{grid-column:1/-1;text-align:left;white-space:normal}}
`;
export function injectProjectsStyle() {
  injectInsightsStyle();
  if (typeof document === "undefined" || document.getElementById("pj-style")) return;
  const s = document.createElement("style");
  s.id = "pj-style";
  s.textContent = CSS;
  document.head.appendChild(s);
}

export async function projectsPage(): Promise<Page> {
  injectProjectsStyle();
  const p = qs();
  const all = p.get("all") === "1";
  const hidden = p.get("hidden") === "1";
  const q = new URLSearchParams();
  if (all) q.set("all", "1");
  if (hidden) q.set("hidden", "1");
  const r = await get<{ projects: ProjectRow[] }>(`analytics/projects${q.size ? `?${q}` : ""}`);
  const ps = r.projects;
  const liveN = ps.filter((x) => x.live_agents.length).length;
  const acc = ps.reduce((n, x) => n + x.accepted, 0);
  const body = html`<div class="ins-page pj-page">
    <div class="ph-row"><div class="ph-title"><div class="eyebrow">Projects</div><h1>Repositories being improved</h1>
      <div class="ph-sub"><span>Each metric shows its baseline from the calibration and the best value an accepted generation measured, with the improvement between them.</span></div></div></div>
    <section class="panel">
      ${kpis([
        ["Projects", String(ps.length), all ? "including retired lineages and fixtures" : "active, on GitHub"],
        ["Working now", String(liveN), "projects with a live session"],
        ["Accepted generations", String(acc), "unreverted, all projects"],
        ["Open candidates", String(ps.reduce((n, x) => n + x.open_candidates, 0)), "counts only until final"],
      ])}
      <div class="ins-bar"><div class="seg" role="group" aria-label="Scope">${chip("all", "", "Active on GitHub", all ? "1" : "")}${chip("all", "1", "Include retired and fixtures", all ? "1" : "")}</div>
        <a class="link ins-clear" href="/generations" data-q>Every accepted generation</a></div>
    </section>
    ${ps.length ? html`<div class="pj-list">${ps.map((x) => projectCard(x, hidden))}</div>` : panel("Projects", empty("No project yet", "A project appears once a recipe for its repository is calibrated into an active lineage."))}
  </div>`;
  return {
    title: "Projects",
    body,
    pollMs: 30_000,
    refreshOn: (e) => /^(generation\.|lineage\.|session\.)/.test(e.type),
    mount: (root) => wireInsights(root),
  };
}
