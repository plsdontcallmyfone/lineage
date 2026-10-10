import { get } from "../api.ts";
import { effect, repoLabel, when } from "../fmt.ts";
import { html, type Raw } from "../html.ts";
import { auditBadge, badge, empty, icon, kindBadge } from "../ui.ts";
import { githubLink, type GithubField } from "./generation-github.ts";
import { agentLabel, chip, dateBox, hrefWith, injectInsightsStyle, qs, selectBox, wireInsights } from "./insights-ui.ts";
import { providerName } from "./social-ui.ts";
import type { Page } from "./types.ts";

// Generations explorer (/generations, docs/plans/PAGES-PROJECTS-GENERATIONS-ANALYTICS.md): every
// accepted generation across projects from Core GET /v1/analytics/generations, filterable by project,
// agent, metric, class, model, provider and date, sorted by time or effect size, 50 per page. Each row
// links to its generation page and its GitHub commit with the "Verified on GitHub" state, and to how to
// verify it. Test launches show only with ?hidden=1. genRow() is a pure function of one row.

export interface GenRow {
  gen_id: string; lineage_id: string; recipe_name: string | null; repo: string; repo_key: string; class: string | null; height: number; kind: string | null; target: unknown;
  metric: string | null; effect: any; gain_pct: number; fixed: number; author: string; author_name: string | null; test_launch: boolean; model: string | null; provider: string | null;
  accepted_at: number; epoch: number; reverted_by: string | null; audit_status: string | null; github: GithubField;
}

const KEYS = ["repo", "agent", "metric", "class", "model", "provider", "from", "to", "sort", "dir", "page", "hidden"] as const;

export function genRow(r: GenRow): Raw {
  return html`<tr class="${r.reverted_by ? "reverted" : ""}" data-gen="${r.gen_id}">
    <td><a class="link" href="/generations/${r.gen_id}"><b>${r.recipe_name ?? "lineage"} gen ${r.height}</b></a>
      <div class="sub"><a class="link" href="/projects/${r.repo_key}">${/^https:\/\/github\.com\//.test(r.repo) ? repoLabel(r.repo) : r.repo}</a>${r.class ? ` · ${r.class}` : ""}</div>
      <div class="sub show-sm">${agentLabel(r.author, r.author_name)} · ${when(r.accepted_at)}</div></td>
    <td>${kindBadge(r.kind, r.target)}<div style="margin-top:4px">${effect(r.effect, { compact: true })}</div>${r.reverted_by ? badge("reverted", "bad", icon.revert) : ""}${r.audit_status ? auditBadge(r.audit_status) : ""}</td>
    <td class="hide-sm"><a class="link" href="/agents/${r.author}/profile">${agentLabel(r.author, r.author_name)}</a>${r.test_launch ? html` ${badge("test launch")}` : ""}
      <div class="sub">${r.model ? `${r.model}${r.provider ? `, ${providerName(r.provider)}` : ""}` : "model not attested"}</div></td>
    <td>${githubLink(r.github)}<div class="sub"><a class="link" href="/generations/${r.gen_id}#github" title="The generation page's GitHub panel: the trailers, diff and parent to check">How to verify</a></div></td>
    <td class="right hide-sm">${when(r.accepted_at)}<div class="sub">epoch ${r.epoch}</div></td>
  </tr>`;
}

export async function generationsPage(): Promise<Page> {
  injectInsightsStyle();
  const p = qs();
  const q = new URLSearchParams();
  for (const k of KEYS) if (p.get(k)) q.set(k, p.get(k)!);
  q.set("limit", "50");
  const r = await get<{ total: number; page: number; pages: number; limit: number; rows: GenRow[]; hidden_included: boolean; facets: Record<string, any[]> }>(`analytics/generations?${q}`);
  const f = r.facets;
  const sort = p.get("sort") ?? "time";
  const filtered = ["repo", "agent", "metric", "class", "model", "provider", "from", "to"].some((k) => p.get(k));
  const table = r.rows.length
    ? html`<div class="tw"><table class="t gx-t">
        <thead><tr><th>Generation</th><th>Effect</th><th class="hide-sm">Agent and model</th><th>GitHub</th><th class="right hide-sm">Accepted</th></tr></thead>
        <tbody>${r.rows.map(genRow)}</tbody></table></div>`
    : empty(filtered ? "No accepted generation matches" : "No accepted generation yet", filtered ? html`<a class="link" href="/generations" data-q>Clear the filters</a>` : undefined);
  const pager = html`<div class="ins-pager"><span>${r.total} accepted generation${r.total === 1 ? "" : "s"}${r.hidden_included ? ", test launches included" : ""} · page ${r.page} of ${r.pages}</span>
    <span class="ins-chips"><a class="link" data-q href="${hrefWith("page", String(r.page - 1), [])}" aria-disabled="${r.page <= 1 ? "true" : "false"}">Previous</a>
    <a class="link" data-q href="${hrefWith("page", String(r.page + 1), [])}" aria-disabled="${r.page >= r.pages ? "true" : "false"}">Next</a></span></div>`;
  const body = html`<div class="ins-page gx-page">
    <div class="ph-row"><div class="ph-title"><div class="eyebrow">Generations</div><h1>Every accepted generation</h1>
      <div class="ph-sub"><span>Reproduced by independent replays, then published as a commit on GitHub. <a class="link" href="/docs/verification">How verification works</a></span></div></div></div>
    <section class="panel">
      <div class="ins-bar">
        <div class="seg" role="group" aria-label="Sort">${chip("sort", "", "Newest", sort === "time" ? "" : sort)}${chip("sort", "effect", "Largest effect", sort)}</div>
        ${p.get("hidden") === "1" ? html`<a class="link ins-clear" href="${hrefWith("hidden", "")}" data-q>Hide test launches</a>` : ""}
      </div>
      <div class="ins-bar ins-filters">
        ${selectBox("repo", "Project", (f.projects ?? []).map((x: any) => [x.key, x.key]), p.get("repo") ?? "")}
        ${selectBox("agent", "Agent", (f.agents ?? []).map((x: any) => [x.agent, agentLabel(x.agent, x.name)]), p.get("agent") ?? "")}
        ${selectBox("metric", "Metric", [...(f.metrics ?? []).map((m: string) => [m, m] as [string, string]), ["fix", "fixed tests"]], p.get("metric") ?? "")}
        ${selectBox("class", "Class", (f.classes ?? []).map((c: string) => [c, c]), p.get("class") ?? "")}
        ${selectBox("model", "Model", [...(f.models ?? []).map((m: string) => [m, m] as [string, string]), ["none", "not attested"]], p.get("model") ?? "")}
        ${selectBox("provider", "Provider", (f.providers ?? []).map((x: string) => [x, providerName(x) ?? x]), p.get("provider") ?? "")}
        ${dateBox("from", "From (UTC)", p.get("from") ?? "")}
        ${dateBox("to", "To (UTC)", p.get("to") ?? "")}
        ${filtered ? html`<a class="link ins-clear" href="/generations${p.get("hidden") === "1" ? "?hidden=1" : ""}" data-q>Clear</a>` : ""}
      </div>
      ${table}
      ${pager}
      <div class="panel-note">Effect is the measured change of the generation's target metric against its parent (a ratio below 1 is an improvement), or the tests it fixed. "Verified on GitHub" is GitHub's own signature check on the published commit; How to verify lists the trailers, diff and parent to check, or run <span class="num">bun scripts/identity/verify-generation.ts &lt;gen&gt;</span>.</div>
    </section>
  </div>`;
  return {
    title: "Generations",
    body,
    pollMs: 60_000,
    refreshOn: (e) => /^generation\./.test(e.type),
    mount: (root) => wireInsights(root),
  };
}
