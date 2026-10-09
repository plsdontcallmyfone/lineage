import { ApiError } from "../api.ts";
import { when } from "../fmt.ts";
import { html } from "../html.ts";
import { amountFig, changeFig, fmtInt, market, phaseBadge, priceFig, progressBar, QUOTE, shortAddr, tokenLabel, type TokenSummary } from "../market.ts";
import { empty, panel } from "../ui.ts";
import type { Page } from "./types.ts";

// Launchpad token list (plan L3): every agent token the market indexer has found on devnet, sorted
// by the indexer (market cap, 24h volume, newest or curve progress). Read from GET /market/tokens.

export const SORTS = [
  ["market_cap", "Market cap"],
  ["volume", "24h volume"],
  ["newest", "Newest"],
  ["progress", "Graduation"],
] as const;
type Sort = (typeof SORTS)[number][0];

let sort: Sort = "market_cap";
function sortFromUrl(): Sort {
  const s = new URLSearchParams(location.search).get("sort");
  return SORTS.some(([k]) => k === s) ? (s as Sort) : sort;
}

export function tokenRow(t: TokenSummary) {
  return html`<tr class="rowlink" data-href="/tokens/${t.mint}" data-mint="${t.mint}">
    <td><a href="/tokens/${t.mint}" class="mk-rowlink">${tokenLabel(t)}</a><div class="sub" title="${t.mint}">${shortAddr(t.mint)}${t.phase === "graduated" ? html`, <span class="mk-gradtag">graduated</span>` : t.migrated ? ", migrated" : ""}</div></td>
    <td class="hide-sm hide-md">${phaseBadge(t)}</td>
    <td class="right nowrap">${priceFig(t.price, "price")}</td>
    <td class="right nowrap">${amountFig(t.market_cap, QUOTE, "market_cap")}</td>
    <td class="right nowrap hide-sm">${amountFig(t.volume_24h, QUOTE, "volume_24h")}</td>
    <td class="right nowrap hide-sm">${changeFig(t.change_24h, "change_24h")}</td>
    <td class="mk-progcell">${progressBar(t.curve_progress, "curve_progress")}</td>
    <td class="right num hide-sm" data-f="holders">${t.holders === null ? html`<span class="faint" title="The indexer has not counted holders yet">TBA</span>` : fmtInt(t.holders)}</td>
    <td class="right nowrap hide-sm">${when(t.created_at * 1000)}</td>
  </tr>`;
}

function table(list: TokenSummary[]) {
  if (!list.length) return empty("No agent tokens yet", "A token appears here when an agent is launched on devnet (Wallet, Launch an agent).");
  return html`<div class="tw"><table class="t mk-list"><thead><tr>
      <th>Token</th><th class="hide-sm hide-md">Phase</th><th class="right">Price</th><th class="right">Market cap</th><th class="right hide-sm">24h volume</th>
      <th class="right hide-sm">24h change</th><th>Curve progress</th><th class="right hide-sm">Holders</th><th class="right hide-sm">Launched</th>
    </tr></thead><tbody>${list.map(tokenRow)}</tbody></table></div>`;
}

export async function tokensPage(): Promise<Page> {
  sort = sortFromUrl();
  let r: { tokens: TokenSummary[]; count: number; sort: string };
  try {
    r = await market(`tokens?sort=${sort}`);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 502 || e.status === 503)) return unreachable(e);
    throw e;
  }
  const grad = r.tokens.filter((t) => t.phase === "graduated").length;
  const body = html`
    <div class="ph-row"><div class="ph-title"><div class="eyebrow">Launchpad, devnet</div><h1>Agent tokens</h1>
      <div class="ph-sub"><span>Every launched agent's token: a Meteora bonding curve until it fills, then a DAMM v2 pool. Prices are ${QUOTE} per token, read by the market indexer from devnet; there is no USD price.</span></div></div>
      <div class="seg mk-sort" role="group" aria-label="Sort by">${SORTS.map(([k, label]) => html`<button type="button" data-sort="${k}" aria-pressed="${String(k === sort)}">${label}</button>`)}</div>
    </div>
    ${panel("Tokens", html`<div id="mk-list">${table(r.tokens)}</div>`, {
      count: r.count,
      aside: html`<span><span class="num">${grad}</span> graduated</span>`,
      note: html`Curve progress is the pool's ${QUOTE} reserve over its migration threshold. Market cap is price times total supply. 24h figures are summed from indexed trades.`,
    })}`;
  return {
    title: "Tokens",
    body,
    pollMs: 15_000,
    mount: (root) => {
      root.querySelector(".mk-sort")?.addEventListener("click", async (ev) => {
        const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-sort]");
        if (!b) return;
        sort = b.dataset.sort as Sort;
        for (const x of root.querySelectorAll<HTMLElement>("[data-sort]")) x.setAttribute("aria-pressed", String(x === b));
        history.replaceState(null, "", `/tokens?sort=${sort}`);
        try {
          const n = await market<{ tokens: TokenSummary[] }>(`tokens?sort=${sort}`);
          const el = root.querySelector("#mk-list");
          if (el) el.innerHTML = table(n.tokens).s;
        } catch {
          /* the next poll re-renders */
        }
      });
    },
  };
}

export function unreachable(e: ApiError): Page {
  return {
    title: "Tokens",
    body: html`<div class="panel errorbox"><h1>The market indexer is not answering</h1><p>${e.message}</p>
      <p>Start it with <code>bun packages/indexer/src/main.ts</code> (port 9668), or point the dashboard at another one with <code>bun apps/web/server.ts --market &lt;url&gt;</code>.</p></div>`,
    pollMs: 15_000,
  };
}
