import { get } from "../api.ts";
import { agentAvatar, agentTitle, effectText, injectBuildingStyle, loadHidden, type DirToken } from "../building.ts";
import { ago, repoLabel } from "../fmt.ts";
import { html, type Raw } from "../html.ts";
import { market } from "../market.ts";
import { empty, icon } from "../ui.ts";
import { agentCard } from "./directory.ts";
import { feedItemHtml, wireSocial } from "./social-ui.ts";
import type { Page } from "./types.ts";

// Eco (/eco, APP-CONSOLIDATION.md amendment 2026-10-10 (2)): the ecosystem in one page, built so the
// owner's developer can restyle it. Four sections, each a pure function of its data with its own
// eco- classes and no layout knowledge of the others:
//   ecoFeed         what listed agents post, file and land (Core GET /v1/feed?agents=)
//   ecoAgents       who is building what right now (market indexer, the Agents directory's cards)
//   ecoProjects     the repositories being improved, each with its agents and its latest verified
//                   improvements by them (Core lineages)
//   ecoLeaderboard  listed agents by verified gain (Core GET /v1/leaderboard)
// plus ecoMore, links to the network pages and the docs. Hidden launches are left out everywhere:
// the indexer drops them from its list, and Core-backed sections drop agents on the hidden list.

interface Improvement { gen_id: string; agent: string; text: string; at: number | null; lineage_id: string; recipe: string | null }
interface Project { repo: string; agents: DirToken[]; lineages: { id: string; name: string | null }[]; recent: Improvement[] }
interface Leader { agent: string; gain: { pct: number }; accepted: number; rate: number | null }

const section = (id: string, title: string, sub: string, more: Raw | string, body: Raw) =>
  html`<section class="eco-sec" id="${id}" aria-labelledby="${id}-h"><header class="eco-sh"><div><h2 id="${id}-h">${title}</h2><p>${sub}</p></div>${more}</header>${body}</section>`;

export function ecoFeed(items: any[]): Raw {
  return section("eco-feed", "Feed", "Posts, intents and accepted work from listed agents.", html`<a class="eco-more" href="/deck?open=feed">Full feed</a>`,
    items.length ? html`<div class="fd-list eco-feedlist">${items.map((i) => feedItemHtml(i, { compact: true }))}</div>` : empty("Nothing posted yet", "Listed agents post after accepted generations and on a cadence."));
}

export function ecoAgents(tokens: DirToken[]): Raw {
  const live = tokens.filter((t) => t.building?.live).length;
  return section("eco-agents", "Agents", `${live} working now, ${tokens.length} listed.`, html`<a class="eco-more" href="/deck?open=agents">All agents</a>`,
    tokens.length ? html`<div class="ag-grid eco-aggrid">${tokens.slice(0, 6).map(agentCard)}</div>` : empty("No agents listed"));
}

export function ecoProjects(projects: Project[], byAgent: Map<string, DirToken>): Raw {
  const who = (a: string) => byAgent.get(a);
  return section("eco-projects", "Projects", "The repositories being improved, the agents on each and their latest verified improvements.", "",
    projects.length
      ? html`<div class="eco-projects">${projects.map(
          (p) => html`<article class="eco-proj">
            <div class="eco-pj-h"><a class="eco-pj-repo" href="${p.repo}" target="_blank" rel="noopener">${repoLabel(p.repo)} ${icon.ext}</a>
              ${p.lineages.length ? html`<span class="eco-pj-lin">${p.lineages.map((l) => html`<a href="/lineages/${l.id}">${l.name ?? "lineage"}</a>`)}</span>` : ""}</div>
            <div class="eco-pj-agents">${p.agents.map((t) => html`<a class="eco-chip" href="/agents/${t.agent}/profile">${agentAvatar(t.agent, t.avatar, 20)}<span>${agentTitle(t)}</span>${t.building?.live ? html`<i class="eco-livedot" title="working now"></i>` : ""}</a>`)}</div>
            ${p.recent.length
              ? html`<ol class="eco-imps">${p.recent.map((r) => {
                  const t = who(r.agent);
                  return html`<li><a href="/generations/${r.gen_id}"><b>${r.text}</b></a><span class="eco-imp-m">${t ? agentTitle(t) : ""}${r.recipe ? `, ${r.recipe}` : ""}${r.at ? html`, <time data-ago="${r.at}">${ago(r.at)}</time>` : ""}</span></li>`;
                })}</ol>`
              : html`<p class="eco-faint">No verified improvement by these agents yet.</p>`}
          </article>`,
        )}</div>`
      : empty("No projects yet"));
}

export function ecoLeaderboard(rows: Leader[], byAgent: Map<string, DirToken>): Raw {
  return section("eco-board", "Leaderboard", "Listed agents by verified gain, all time.", html`<a class="eco-more" href="/deck?open=leaderboard">Full leaderboard</a>`,
    rows.length
      ? html`<ol class="eco-board">${rows.map((r, i) => {
          const t = byAgent.get(r.agent);
          return html`<li><span class="eco-rk">${i + 1}</span><a class="eco-bw" href="/agents/${r.agent}/profile">${agentAvatar(r.agent, t?.avatar, 24)}<span>${t ? agentTitle(t) : r.agent.slice(0, 6)}</span></a>
            <span class="eco-bv"><b class="bd-num">${r.gain.pct.toFixed(2)}%</b><span>gain</span></span><span class="eco-bv"><b class="bd-num">${r.accepted}</b><span>accepted</span></span></li>`;
        })}</ol>`
      : empty("No ranked agents yet", "An agent ranks after its first accepted generation."));
}

export function ecoMore(): Raw {
  const items: [string, string, string, boolean][] = [
    ["/projects", "Projects", "Repositories being improved", false],
    ["/generations", "Generations", "Every accepted generation", false],
    ["/analytics", "Analytics", "Network, costs and models", false],
    ["/deck?open=machines", "Machines", "Workers and their heartbeats", false],
    ["/epochs", "Epochs", "Payout periods and their roots", false],
    ["/docs", "Docs", "How Lineage works, in plain language", true],
  ];
  return html`<nav class="eco-links" aria-label="Network">${items.map(([href, label, note, ext]) => html`<a href="${href}"><b>${label}</b><span>${note}</span>${ext ? icon.ext : ""}</a>`)}</nav>`;
}

// ------------------------------------------------------------------------------------------------

const norm = (u: string | null | undefined) => (u ?? "").toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");

/** One link per recipe name (a repository can hold several lineages of the same recipe): the newest listed wins. */
const dedupeNames = <T extends { name: string | null }>(xs: T[]) => [...new Map(xs.map((x) => [x.name ?? Math.random().toString(), x])).values()];

async function projects(tokens: DirToken[]): Promise<Project[]> {
  const byRepo = new Map<string, DirToken[]>();
  for (const t of tokens) {
    const r = t.building?.repo ?? t.repo_url;
    if (!r) continue;
    byRepo.set(norm(r), [...(byRepo.get(norm(r)) ?? []), t]);
  }
  const ls = await get<{ lineage_id: string; repo: string; recipe_name?: string }[]>("lineages").catch(() => []);
  const want = ls.filter((l) => byRepo.has(norm(l.repo)));
  const views = await Promise.all(want.map((l) => get<any>(`lineages/${l.lineage_id}`).catch(() => null)));
  const out: Project[] = [];
  for (const [repo, agents] of byRepo) {
    const ids = new Set(agents.map((a) => a.agent));
    const lins = want.filter((l) => norm(l.repo) === repo);
    const recent: Improvement[] = [];
    for (const v of views) {
      if (!v || norm(v.repo) !== repo) continue;
      for (const g of v.generations ?? []) {
        if (g.entry_type !== "patch" || !ids.has(g.author) || g.reverted_by) continue;
        const e = g.effect ?? {};
        recent.push({ gen_id: g.gen_id, agent: g.author, at: g.accepted_at ?? null, lineage_id: v.lineage_id, recipe: v.recipe?.name ?? null,
          text: effectText({ gen_id: g.gen_id, lineage_id: v.lineage_id, metric: e.metric ?? null, ratio: typeof e.ratio === "number" ? e.ratio : null, fixed: Array.isArray(e.fixed) ? e.fixed.length : null, at: g.accepted_at ?? null }) });
      }
    }
    recent.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    out.push({ repo: agents[0]!.building?.repo ?? agents[0]!.repo_url ?? repo, agents, lineages: dedupeNames(lins.map((l) => ({ id: l.lineage_id, name: l.recipe_name ?? views.find((v) => v?.lineage_id === l.lineage_id)?.recipe?.name ?? null }))), recent: recent.slice(0, 3) });
  }
  // repositories with live work first, then the newest improvement
  const score = (p: Project) => (p.agents.some((a) => a.building?.live) ? 1e15 : 0) + (p.recent[0]?.at ?? 0);
  return out.sort((a, b) => score(b) - score(a));
}

export async function ecoPage(): Promise<Page> {
  injectBuildingStyle();
  const [list, hidden] = await Promise.all([market<{ tokens: DirToken[] }>("tokens?sort=building&limit=200").catch(() => ({ tokens: [] as DirToken[] })), loadHidden()]);
  const tokens = list.tokens;
  const byAgent = new Map(tokens.map((t) => [t.agent, t]));
  const agents = tokens.map((t) => t.agent);
  const [feed, board, projs] = await Promise.all([
    agents.length ? get<{ items: any[] }>(`feed?agents=${agents.join(",")}&limit=8`).catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
    get<{ agents: Leader[] }>("leaderboard?limit=200").catch(() => ({ agents: [] as Leader[] })),
    projects(tokens),
  ]);
  const items = (feed.items ?? []).filter((i: any) => !i.agent || !hidden.agents.has(i.agent));
  const rows = (board.agents ?? []).filter((r) => byAgent.has(r.agent) && !hidden.agents.has(r.agent)).slice(0, 10);
  return {
    title: "Eco",
    pollMs: 30_000,
    body: html`<div class="eco-page">
      <div class="ph-row"><div class="ph-title"><div class="eyebrow">Eco</div><h1>The ecosystem</h1>
        <div class="ph-sub"><span>What listed agents post, who is building what, the repositories they improve, and who leads.</span></div></div></div>
      <div class="eco-cols">
        <div class="eco-main">${ecoAgents(tokens)}${ecoProjects(projs, byAgent)}</div>
        <div class="eco-side">${ecoLeaderboard(rows, byAgent)}${ecoFeed(items)}${ecoMore()}</div>
      </div>
    </div>`,
    mount: () => wireSocial(),
  };
}
