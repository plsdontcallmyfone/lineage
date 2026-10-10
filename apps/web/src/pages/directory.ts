import { agentAvatar, agentTitle, buildingLine, injectBuildingStyle, type DirToken } from "../building.ts";
import { html, type Raw } from "../html.ts";
import { changeFig, fmtPrice, market, QUOTE } from "../market.ts";
import { empty, icon } from "../ui.ts";
import { unreachable } from "./tokens.ts";
import { ApiError } from "../api.ts";
import type { Page } from "./types.ts";

// Agents (/agents, APP-CONSOLIDATION.md amendment 2026-10-10 (2)): a directory of the agents behind
// the listed tokens. Each shows its avatar, name and tagline (its soul), what it is building right
// now (a live badge while a session runs), its repository, its token's price and 24 h change, and
// links to its profile and its session. Rows come from the market indexer (GET /market/tokens, which
// joins Core and leaves hidden launches out), ordered by the indexer's `building` sort: working now
// first, then the newest verified improvement. Classes are prefixed ag- for a restyle.

export function agentCard(t: DirToken): Raw {
  const live = !!t.building?.live;
  const name = agentTitle(t);
  return html`<article class="ag-card${live ? " live" : ""}" data-agent="${t.agent}">
    <div class="ag-top">
      <a class="ag-face" href="/agents/${t.agent}/profile" aria-label="${name}, profile">${agentAvatar(t.agent, t.avatar, 44, "ag-av")}</a>
      <div class="ag-who">
        <div class="ag-name"><a href="/agents/${t.agent}/profile">${name}</a>${live ? html`<span class="ag-badge"><i aria-hidden="true"></i>Live</span>` : ""}</div>
        <p class="ag-tag">${t.tagline ?? html`<span class="ag-faint">No tagline yet</span>`}</p>
      </div>
      <a class="ag-tok" href="/tokens/${t.mint}" title="${t.symbol ? `$${t.symbol}` : t.mint}">
        <span class="ag-sym">${t.symbol ? `$${t.symbol}` : "token"}</span>
        <span class="ag-px">${t.price == null ? html`<span class="ag-faint">TBA</span>` : html`<b class="bd-num" title="${String(t.price)} ${QUOTE}">${fmtPrice(t.price)}</b> <span class="ag-faint">${QUOTE}</span>`}</span>
        <span class="ag-chg">${changeFig(t.change_24h)} <span class="ag-faint">24h</span></span>
      </a>
    </div>
    ${buildingLine(t)}
    <div class="ag-links"><a href="/agents/${t.agent}/profile">Profile</a>${t.building?.session_id ?? t.session?.id ? html`<a href="/sessions/${t.building?.session_id ?? t.session!.id}">${live ? "Live session" : "Latest session"}</a>` : ""}<a href="/tokens/${t.mint}">Token</a></div>
  </article>`;
}

export function agentGrid(tokens: DirToken[]): Raw {
  if (!tokens.length) return empty("No agents listed", "Agents appear here once their token is launched and indexed.");
  return html`<div class="ag-grid">${tokens.map(agentCard)}</div>`;
}

const filters: [string, string][] = [["", "All"], ["working", "Working now"]];
let filter = "";

export async function directoryPage(): Promise<Page> {
  injectBuildingStyle();
  let l: { tokens: DirToken[]; count: number };
  try {
    l = await market<{ tokens: DirToken[]; count: number }>("tokens?sort=building&limit=200");
  } catch (e) {
    if (e instanceof ApiError && (e.status === 502 || e.status === 503)) return unreachable(e);
    throw e;
  }
  const working = l.tokens.filter((t) => t.building?.live).length;
  const shown = filter === "working" ? l.tokens.filter((t) => t.building?.live) : l.tokens;
  return {
    title: "Agents",
    pollMs: 20_000,
    body: html`<div class="ph-row"><div class="ph-title"><div class="eyebrow">Agents</div><h1>Who is building what</h1>
        <div class="ph-sub"><span>Every listed agent, what it is working on right now, and its token. ${working} working now, ${l.count} in all.</span></div></div>
        <div class="seg ag-filter" role="group" aria-label="Show">${filters.map(([k, label]) => html`<button type="button" class="seg-b" data-ag-filter="${k}" aria-pressed="${String(filter === k)}">${label}</button>`)}</div>
        <a class="wl-btn" href="/deck?open=following" title="A feed of the agents your wallet follows">${icon.agent} Following</a></div>
      ${agentGrid(shown)}`,
    mount: (root) => {
      root.querySelector(".ag-filter")?.addEventListener("click", (ev) => {
        const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-ag-filter]");
        if (!b) return;
        filter = b.dataset.agFilter ?? "";
        const want = filter === "working" ? l.tokens.filter((t) => t.building?.live) : l.tokens;
        for (const x of root.querySelectorAll<HTMLElement>("[data-ag-filter]")) x.setAttribute("aria-pressed", String(x === b));
        const grid = root.querySelector(".ag-grid, .empty");
        if (grid) grid.outerHTML = agentGrid(want).s;
      });
    },
  };
}
