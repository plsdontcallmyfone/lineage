import { html, type Raw } from "../html.ts";
import { fmtAmount, fmtInt, market } from "../market.ts";
import { fmtUsd } from "../usd.ts";
import { acctLink, addSupplyPart, share } from "./analytics-supply.ts";

// Agent coins in the Supply section (analytics-supply.ts): GET /market/supply/coins. One row per launched
// coin: its supply read from its mint, what was burned (the supply its pump.fun curve was created with
// minus the supply now), and the share held by the agent itself, by its curve and pool, and by its
// largest holder. Dollars are the coin's market value at the current price; a figure the chain has not
// given yet says so in words.

type O = any;
const none = (text: string) => html`<span class="faint">${text}</span>`;

export function coinsBody(c: O | null): Raw {
  if (!c) return html`<p class="an-line">The market indexer did not answer the agent coins.</p>`;
  const rows: O[] = c.coins ?? [];
  if (!rows.length) return html`<p class="an-line">No agent coin has been launched yet.</p>`;
  const t = c.totals;
  const burned = (r: O) => (r.burned === null ? none("not read") : r.burned === 0 ? none("none") : html`${fmtAmount(r.burned)}<div class="an-sub">${share(r.burned_share)} of created${r.burned_agree ? "" : ", history still being read"}</div>`);
  return html`<div class="tw"><table class="t sup-t"><thead><tr><th>Coin</th><th class="right">Market value</th><th class="right">Supply</th><th class="right">Burned</th><th class="right hide-sm">Held by its agent</th><th class="right hide-sm">In its curve and pool</th><th class="right hide-sm">Largest holder</th></tr></thead><tbody>${rows.map(
    (r) => html`<tr data-mint="${r.mint}"><td><a class="link" href="/tokens/${r.mint}"><b>${r.symbol ? `$${r.symbol}` : "unnamed"}</b></a><div class="an-sub">${r.agent_name ?? r.name ?? ""}</div></td>
      <td class="right num">${r.market_cap_usd === null ? none(r.market_cap === null ? "no price yet" : "$ unavailable") : fmtUsd(r.market_cap_usd)}</td>
      <td class="right num">${r.supply === null ? none("not read") : fmtAmount(r.supply)}</td>
      <td class="right num">${burned(r)}</td>
      <td class="right num hide-sm">${r.agent_share === null ? none("not read") : html`<span title="${fmtAmount(r.agent_amount)} coins">${share(r.agent_share)}</span>`}</td>
      <td class="right num hide-sm">${r.pool_share === null ? none("not read") : html`<span title="${fmtAmount(r.pool_amount)} coins">${share(r.pool_share)}</span>`}</td>
      <td class="right num hide-sm">${r.top_holder ? html`${share(r.top_holder.share)}<div class="an-sub">${acctLink(r.top_holder.owner, r.top_holder.label)}</div>` : none("no holder read")}</td></tr>`,
  )}</tbody><tfoot><tr><td><b>${fmtInt(t.coins)} ${t.coins === 1 ? "coin" : "coins"}</b></td><td class="right num"><b>${t.market_cap_usd === null ? none("not summed") : fmtUsd(t.market_cap_usd)}</b></td>
    <td class="right num">${t.supply === null ? none("not summed") : fmtAmount(t.supply)}</td><td class="right num">${t.burned === null ? none("not summed") : t.burned === 0 ? none("none") : fmtAmount(t.burned)}</td><td class="hide-sm" colspan="3"></td></tr></tfoot></table></div>
    <div class="panel-note">${t.with_burns ? `${fmtInt(t.with_burns)} of ${fmtInt(t.coins)} coins have had coins burned.` : "No agent coin has had coins burned yet."} Market value is the pool price times the supply, in dollars at the current price. "Held by its agent" is the agent's own token account of its coin; the largest holder leaves out the curve and the pool. A total is left out when one coin's figure is missing.</div>`;
}

addSupplyPart({
  shell: () => html`<section class="panel an-card" id="sup-coins"><div class="an-card-h"><div><h2>What is the supply of each agent coin?</h2><p>Every launched coin: supply, burns, and who holds it.</p></div><span class="an-count" id="sup-coins-n" hidden></span></div><div id="sup-coins-rows"><div class="an-card-body an-skel" style="--h:160px"></div></div></section>`,
  mount: (root) => {
    let last = "";
    let stopped = false;
    return {
      refresh: async () => {
        const c = await market<O>("supply/coins").catch(() => null);
        if (stopped || !root.isConnected) return;
        const sig = JSON.stringify(c ? { ...c, usd: 0 } : null);
        if (sig === last) return;
        last = sig;
        root.querySelector<HTMLElement>("#sup-coins-rows")!.innerHTML = coinsBody(c).s;
        const n = root.querySelector<HTMLElement>("#sup-coins-n")!;
        n.hidden = !c?.coins?.length;
        n.textContent = c?.coins?.length ? fmtInt(c.coins.length) : "";
      },
      stop: () => { stopped = true; },
    };
  },
});
