import { when } from "../fmt.ts";
import { html, type Raw } from "../html.ts";
import { fmtAmount, fmtInt, market, QUOTE } from "../market.ts";
import { fmtUsd, USD_NA } from "../usd.ts";
import { slotColor, tone } from "./analytics-charts.ts";

// The Supply section of Analytics (owner 2026-10-13: "a dashboard that show token supply and dev burns
// and stuff"). Every figure is the market indexer's GET /market/supply* (packages/indexer/src/supply.ts):
// the supply read from the coin's mint, what was burned, where the rest sits and who holds it. Dollars
// lead and the coin amount follows; a dollar figure comes from the indexer's "_usd" fields (a balance
// at the current price, an event at the price stored for its own time) and reads "$ unavailable" or is
// left out with the reason when there is no reading. Nothing here is computed from a number the chain
// did not give, and nothing is called "circulating".

type O = any;

export const SOLSCAN_TX = (sig: string) => `https://solscan.io/tx/${sig}`;
export const SOLSCAN_ACCOUNT = (a: string) => `https://solscan.io/account/${a}`;
export const shortAddr = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
export const acctLink = (a: string, label?: string): Raw => html`<a class="link nowrap" href="${SOLSCAN_ACCOUNT(a)}" target="_blank" rel="noopener" title="${a}">${label ?? shortAddr(a)}</a>`;
export const txLink = (sig: string, label = "view"): Raw => html`<a class="link nowrap" href="${SOLSCAN_TX(sig)}" target="_blank" rel="noopener" title="${sig}">${label}</a>`;
/** A share of a whole (0.0669 is "6.69%"); three places below a tenth of a percent, "0%" for nothing. */
export function share(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "not read";
  const p = x * 100;
  return p === 0 ? "0%" : p < 0.001 ? "under 0.001%" : `${p.toFixed(p < 0.1 ? 3 : 2)}%`;
}
/** A coin amount with its symbol. */
export const coins = (n: number | null | undefined, unit: string = QUOTE) => `${fmtAmount(n)} ${unit}`;
const compactN = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
/** A coin amount short enough for a tile ("66.91M UNITS"); the exact amount goes in the line under it. */
export const coinsC = (n: number | null | undefined, unit: string = QUOTE) => (n === null || n === undefined || !Number.isFinite(n) ? coins(n, unit) : Math.abs(n) >= 100_000 ? `${compactN.format(n)} ${unit}` : coins(n, unit));
const usdC = (v: number | null | undefined) => fmtUsd(v, { compact: true });
/** Dollars first, the coin amount under it. */
export const money = (usd: number | null | undefined, amount: number | null | undefined, unit: string = QUOTE): Raw =>
  html`<b>${fmtUsd(usd)}</b><em>${coins(amount, unit)}</em>`;

/** Fixed colour per place the supply sits (a category keeps its colour whatever its size). */
const PLACE_COLOR: Record<string, () => string> = {
  liquidity_pool: () => slotColor(0), wallets: () => tone.mute(), developer_wallet: () => slotColor(1), compute_vaults: () => slotColor(2), creator_fees: () => slotColor(3),
  verifier_bonds: () => slotColor(6), protocol_accounts: () => slotColor(4), bounty_escrows: () => slotColor(5), claims_and_pools: () => slotColor(7),
};

export function tile(id: string, label: string, value: string, sub: string | Raw, chip?: string): Raw {
  return html`<section class="an-tile" data-supply="${id}"><span class="an-tile-l">${label}</span><div class="an-tile-v"><b>${value}</b>${chip ? html`<span class="sup-chip">${chip}</span>` : ""}</div><small>${sub}</small></section>`;
}

/** The burned figure in words when the two counts do not agree yet. */
export function burnNote(o: O): string {
  const b = o.burned;
  if (!b || b.agree) return "";
  if (b.state === "reading") return `The coin's history is still being read: ${coins(b.unmatched)} of this is not matched to a burn transaction yet.`;
  return `${coins(Math.abs(b.unmatched))} ${b.unmatched > 0 ? "left the supply without a burn transaction in the coin's history" : "more is recorded in burn transactions than the supply lost"}.`;
}

export function supplyTiles(o: O): Raw {
  const b = o.burned;
  const pool = o.breakdown?.find((r: O) => r.key === "liquidity_pool");
  const h = o.holders;
  const priced = !!o.usd?.ok;
  return html`
    ${tile("supply", `${QUOTE} supply now`, priced ? usdC(o.supply_usd) : USD_NA, html`${coins(o.supply)}${o.initial_supply !== null ? ` of ${fmtAmount(o.initial_supply)} created` : ""}. ${o.mint_authority === null ? "Nobody can mint more." : "The mint still has a mint authority."}`)}
    ${b
      ? tile("burned", "Burned so far", b.raw === "0" ? `0 ${QUOTE}` : b.usd_at_burn !== null ? usdC(b.usd_at_burn) : coinsC(b.amount),
          b.raw === "0" ? "Nothing has been burned: the supply is what the coin was created with."
            : html`${b.usd_at_burn !== null ? `${coins(b.amount)}, in dollars at the price of each burn's own time. ` : `${coins(b.amount)}. No dollar price of ${QUOTE} is on record for the time of some of these burns. `}Created supply minus supply now${b.agree ? `, equal to the ${fmtInt(b.indexed_events)} burn transactions on record` : ""}.`,
          b.raw === "0" ? undefined : `${share(b.share_of_initial)} of created`)
      : tile("burned", "Burned so far", "not read", "The supply the coin was created with could not be read from its pump.fun curve.")}
    ${pool
      ? tile("pool", "In the liquidity pool", priced ? usdC(pool.usd) : USD_NA, `${coins(pool.amount)}: the coin side of its PumpSwap pool`, share(pool.share))
      : tile("pool", "In the liquidity pool", "not read", o.breakdown_reason ?? "The coin's token accounts have not been read yet.")}
    ${h
      ? tile("top10", "Top 10 wallets hold", share(h.top10_wallets_share), `of the supply, across ${fmtInt(h.wallets)} wallets holding ${QUOTE}. The pool and program accounts are left out of the ten.`)
      : tile("top10", "Top 10 wallets hold", "not read", o.breakdown_reason ?? "The coin's token accounts have not been read yet.")}`;
}

/** Where the supply sits: one stacked bar and a row per place, the rows adding up to the supply. */
export function breakdownCard(o: O): Raw {
  const rows: O[] = o.breakdown ?? [];
  const live = rows.filter((r) => r.amount > 0);
  const body = !o.breakdown
    ? html`<p class="an-line">${o.breakdown_reason ?? "The coin's token accounts have not been read yet"}. The supply and the burns above do not depend on it.</p>`
    : html`<div class="an-split-b"><div class="an-split" role="img" aria-label="${QUOTE} supply by where it sits: ${live.map((r) => `${r.label} ${share(r.share)}`).join(", ")}">${live.map((r) => html`<i style="flex:${r.amount} 1 0;--k:${PLACE_COLOR[r.key]!()}" title="${r.label}: ${fmtUsd(r.usd)} (${share(r.share)})"></i>`)}</div>
        <ul class="an-split-l sup-l">${rows.map((r) => html`<li data-place="${r.key}" class="${r.amount > 0 ? "" : "sup-zero"}" title="${r.what}"><i style="--k:${PLACE_COLOR[r.key]!()}"></i><span>${r.label}<small>${r.accounts === 1 ? "1 account" : `${fmtInt(r.accounts)} accounts`}</small></span><div class="sup-v">${money(r.usd, r.amount)}</div><small>${share(r.share)}</small></li>`)}</ul></div>`;
  return html`<section class="panel an-card" id="sup-places"><div class="an-card-h"><div><h2>Where does the supply sit?</h2><p>Every token account of ${QUOTE}, grouped by who controls it. The rows add up to the supply read from the mint${o.usd?.ok ? ", in dollars at the current price" : ""}.</p></div>${o.holders ? html`<span class="an-count">${fmtInt(o.holders.token_accounts)} accounts</span>` : ""}</div>${body}</section>`;
}

/** The largest holders, program accounts and the developer wallet named, the rest as short addresses. */
export function holdersCard(h: O | null): Raw {
  const body = !h
    ? html`<p class="an-line">The market indexer did not answer the holders.</p>`
    : !h.ok
      ? html`<p class="an-line">${h.reason}.</p>`
      : html`<div class="tw"><table class="t sup-t"><thead><tr><th class="right">#</th><th>Holder</th><th class="right">Share</th><th class="right">Value</th></tr></thead><tbody>${h.top.map(
          (r: O) => html`<tr data-kind="${r.kind}"><td class="right num faint">${r.rank}</td><td>${r.owner ? (r.kind === "developer_wallet" ? acctLink(r.owner, "Developer wallet") : acctLink(r.owner)) : html`<b>${r.label}</b>`}${r.accounts > 1 ? html`<div class="an-sub">${fmtInt(r.accounts)} accounts</div>` : ""}</td><td class="right num">${share(r.share)}</td><td class="right num sup-v">${money(r.usd, r.amount)}</td></tr>`,
        )}</tbody></table></div>
        <div class="panel-note">Top 10 wallets: ${share(h.concentration.top10_wallets_share)} of the supply. Top 10 holders of any kind, the pool and program accounts included: ${share(h.concentration.top10_share)}. A wallet with several token accounts counts once.</div>`;
  return html`<section class="panel an-card" id="sup-holders"><div class="an-card-h"><div><h2>Who holds the most?</h2><p>The 20 largest holders of ${QUOTE} and their share of the supply.</p></div>${h?.ok ? html`<span class="an-count">${fmtInt(h.wallets)} wallets</span>` : ""}</div>${body}</section>`;
}

/** A further block of the section: its markup, and what fills it and keeps it filled. */
export interface SupplyPart {
  shell: () => Raw;
  mount: (root: HTMLElement) => { refresh: (overview: O) => Promise<void> | void; stop: () => void };
}
const PARTS: SupplyPart[] = [];
export const addSupplyPart = (p: SupplyPart) => void PARTS.push(p);

export const SUPPLY_CSS = `
.sup-h{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;margin-top:10px;scroll-margin-top:84px}
.sup-h h2{font:500 20px/1.2 var(--display);letter-spacing:-.02em;color:var(--tp)}
.sup-h p{color:var(--tt);font-size:13px;line-height:1.4}
.sup-jump{font:500 12px/1 var(--sans);color:var(--ts);background:var(--bg3);padding:6px 10px;border-radius:9px;text-decoration:none;white-space:nowrap}
.sup-jump:hover{color:var(--tp)}
.sup-chip{flex:none;display:inline-flex;align-items:center;font:500 11px/1 var(--sans);font-variant-numeric:tabular-nums;color:var(--ts);background:var(--bg3);padding:3px 6px;border-radius:7px;white-space:nowrap}
.sup-top{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
.sup-l li{grid-template-columns:10px minmax(0,1fr) auto 64px}
.sup-l li>span{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px;white-space:normal}
.sup-l li>span>small{color:var(--tt);font-size:11.5px;text-align:left}
.sup-l li.sup-zero{opacity:.55}
.sup-v{display:grid;justify-items:end;gap:1px;font-variant-numeric:tabular-nums;white-space:nowrap}
.sup-v b{font-weight:500;color:var(--tp)}
.sup-v em{font-style:normal;color:var(--tt);font-size:11.5px}
.sup-t td{vertical-align:middle;padding-top:8px;padding-bottom:8px}
.sup-note{padding:0 18px 14px;color:var(--tt);font-size:12.5px;line-height:1.45}
#an-supply{display:grid;grid-template-columns:minmax(0,1fr);gap:20px}
#an-supply:empty{display:none}
@media (max-width:640px){.sup-l li{grid-template-columns:10px minmax(0,1fr) auto}.sup-l li>small{display:none}.sup-h h2{font-size:18px}}
`;

/** The section's frame: the anchor a link to /analytics#supply lands on, and skeletons until the figures arrive. */
export function supplyShell(): Raw {
  return html`<div class="sup-h" id="supply"><h2>Supply</h2><p id="sup-updated">Loading the supply of ${QUOTE} from the chain.</p></div>
    <div class="an-kpis" id="sup-tiles" aria-label="Supply figures">${[0, 1, 2, 3].map(() => html`<section class="an-tile an-skel-t"><span>.</span></section>`)}</div>
    <div class="an-charts" id="sup-cards"><div id="sup-places-slot"></div><div id="sup-holders-slot"></div></div>
    ${PARTS.map((p) => p.shell())}`;
}

/** Fills the section and refreshes it every minute. Returns what stops it. */
export function mountSupply(root: HTMLElement): () => void {
  if (typeof document !== "undefined" && !document.getElementById("sup-style")) {
    const s = document.createElement("style");
    s.id = "sup-style";
    s.textContent = SUPPLY_CSS;
    document.head.appendChild(s);
  }
  root.innerHTML = supplyShell().s;
  const $ = (sel: string) => root.querySelector<HTMLElement>(sel)!;
  const parts = PARTS.map((p) => p.mount(root));
  let stopped = false;
  let last = "";
  const load = async () => {
    const [o, h] = await Promise.all([market<O>("supply"), market<O>("supply/holders?limit=20").catch(() => null)]);
    if (stopped || !root.isConnected) return;
    // redraw only when a figure changed (the reading's age is not a figure)
    const sig = JSON.stringify([{ ...o, usd: o.usd?.ok ? o.usd.usd : o.usd?.reason }, h ? { ...h, usd: 0 } : null]);
    if (sig !== last) {
      last = sig;
      if (!o.ok) {
        $("#sup-updated").textContent = `Not read yet: ${o.reason}. It is tried again every minute.`;
        $("#sup-tiles").innerHTML = "";
        $("#sup-places-slot").innerHTML = "";
        $("#sup-holders-slot").innerHTML = "";
      } else {
        $("#sup-updated").innerHTML = html`Read from the chain ${when(o.as_of * 1000)}${o.usd?.ok ? "" : html`. ${USD_NA}: ${o.usd?.reason ?? "no price reading"}`}. ${burnNote(o)}`.s;
        $("#sup-tiles").innerHTML = supplyTiles(o).s;
        $("#sup-places-slot").innerHTML = breakdownCard(o).s;
        $("#sup-holders-slot").innerHTML = holdersCard(h).s;
      }
    }
    if (o.ok) await Promise.all(parts.map((p) => p.refresh(o)));
  };
  const fail = () => {
    if (stopped || last) return; // keep the last good render on a failed background refresh
    $("#sup-updated").textContent = "The market indexer did not answer the supply. It is tried again every minute.";
    $("#sup-tiles").innerHTML = "";
  };
  void load().catch(fail);
  const timer = setInterval(() => {
    if (stopped || !root.isConnected) return stop();
    if (document.hidden || root.querySelector(".an-card:hover")) return;
    void load().catch(fail);
  }, 60_000);
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    for (const p of parts) p.stop();
  };
  return stop;
}
