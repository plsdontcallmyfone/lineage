import { ago } from "../fmt.ts";
import { html, type Raw } from "../html.ts";
import { explorerAddr, fmtAmount, market, NETWORK, QUOTE, shortAddr, type TokenDetail, type Trade } from "../market.ts";
import { icon } from "../ui.ts";

// About the token (token page, under the trade box): its description, the price change over 5 m,
// 1 h, 4 h and 1 d, and for the picked window the buys against the sells, their volumes and the
// distinct buyers against sellers, then its links and facts. Every figure is counted from the
// indexer's trades (GET /market/tokens/:mint/trades, at most 500, newest first): a window that
// reaches past the oldest trade read while more exist shows TBA rather than a partial count.

const WINDOWS: [string, number][] = [
  ["5M", 300],
  ["1H", 3600],
  ["4H", 14400],
  ["1D", 86400],
];
const LIMIT = 500;

interface Stats {
  change: number | null;
  buys: number;
  sells: number;
  buyVol: number;
  sellVol: number;
  buyers: number;
  sellers: number;
  complete: boolean;
}

function stats(t: TokenDetail, trades: Trade[], secs: number, now: number): Stats {
  const start = now - secs;
  const full = trades.length < LIMIT; // every trade of the token was read
  const oldest = trades.length ? (trades[trades.length - 1]!.time ?? 0) : now;
  const complete = full || oldest <= start;
  const inside = trades.filter((r) => (r.time ?? 0) >= start);
  const before = trades.find((r) => (r.time ?? 0) < start);
  const then = before ? (before.price_after ?? before.price) : full ? t.start_price : null;
  const nowPrice = t.price;
  const change = complete && then && nowPrice ? nowPrice / then - 1 : null;
  const buy = inside.filter((r) => r.side === "buy");
  const sell = inside.filter((r) => r.side === "sell");
  return {
    change,
    buys: buy.length,
    sells: sell.length,
    buyVol: buy.reduce((s, r) => s + r.quote_amount, 0),
    sellVol: sell.reduce((s, r) => s + r.quote_amount, 0),
    buyers: new Set(buy.map((r) => r.trader)).size,
    sellers: new Set(sell.map((r) => r.trader)).size,
    complete,
  };
}

const pct = (v: number | null) =>
  v === null ? html`<span class="faint">TBA</span>` : html`<span class="${v > 0 ? "up" : v < 0 ? "down" : ""}">${v > 0 ? "▲" : v < 0 ? "▼" : ""} ${Math.abs(v * 100).toFixed(2)}%</span>`;

function bar(lv: Raw | string, ll: string, rv: Raw | string, rl: string, l: number, r: number, ok: boolean): Raw {
  const share = l + r > 0 ? (l / (l + r)) * 100 : 50;
  return html`<div class="ta-bar">
    <div class="ta-bar-h"><span><b class="num">${ok ? lv : "TBA"}</b> ${ll}</span><span><b class="num">${ok ? rv : "TBA"}</b> ${rl}</span></div>
    <div class="ta-bar-t${l + r > 0 && ok ? "" : " empty"}"><i class="b" style="width:${share.toFixed(2)}%"></i><i class="s" style="width:${(100 - share).toFixed(2)}%"></i></div>
  </div>`;
}

function body(t: TokenDetail, desc: string | null, trades: Trade[] | null, pick: string): Raw {
  const now = Math.floor(Date.now() / 1000);
  const all = trades ? WINDOWS.map(([k, s]) => [k, stats(t, trades, s, now)] as const) : null;
  const cur = all?.find(([k]) => k === pick)?.[1] ?? null;
  const ok = !!cur?.complete;
  const venue = t.venue === "meteora" ? "Meteora (earlier venue)" : "pump.fun";
  return html`<div class="panel-b ta">
    <p class="ta-desc">${desc ?? html`<span class="faint">No description yet</span>`}</p>
    <div class="ta-wins" role="group" aria-label="Window">${WINDOWS.map(([k]) => {
      const s = all?.find(([x]) => x === k)?.[1];
      return html`<button type="button" data-ta-win="${k}" aria-pressed="${String(k === pick)}"><span>${k}</span><b>${s ? pct(s.change) : html`<span class="faint">…</span>`}</b></button>`;
    })}</div>
    ${cur
      ? html`${bar(String(cur.buys), cur.buys === 1 ? "buy" : "buys", String(cur.sells), cur.sells === 1 ? "sell" : "sells", cur.buys, cur.sells, ok)}
        ${bar(fmtAmount(cur.buyVol), `${QUOTE} bought`, fmtAmount(cur.sellVol), `${QUOTE} sold`, cur.buyVol, cur.sellVol, ok)}
        ${bar(String(cur.buyers), cur.buyers === 1 ? "buyer" : "buyers", String(cur.sellers), cur.sellers === 1 ? "seller" : "sellers", cur.buyers, cur.sellers, ok)}`
      : html`<div class="faint ta-wait">Counting trades…</div>`}
    <div class="ta-links">
      ${t.repo_url ? html`<a class="pf-chip" href="${t.repo_url}" target="_blank" rel="noopener">${icon.book} Repository</a>` : ""}
      <a class="pf-chip" href="${explorerAddr(t.mint)}" target="_blank" rel="noopener">${icon.ext} Explorer</a>
      <a class="pf-chip" href="/agents/${t.agent}/profile">${icon.agent} Agent</a>
    </div>
    <dl class="ta-facts">
      <div><dt>Launchpad</dt><dd>${venue}</dd></div>
      <div><dt>Supply</dt><dd class="num">${t.supply === null ? "TBA" : fmtAmount(t.supply)}</dd></div>
      <div><dt>Network</dt><dd>Solana ${NETWORK}</dd></div>
      <div><dt>Created</dt><dd><time data-ago="${t.created_at * 1000}">${ago(t.created_at * 1000)}</time></dd></div>
      <div><dt>Contract address</dt><dd><span class="num" title="${t.mint}">${shortAddr(t.mint)}</span> <button type="button" class="mk-copy" data-copy="${t.mint}" aria-label="Copy the contract address">${icon.copy}</button></dd></div>
    </dl>
  </div>`;
}

/** Mounts the About window into `el`; returns a refresher for the page's poll. */
export function mountAbout(el: HTMLElement, t: TokenDetail, desc: string | null) {
  let pick = "1D";
  let trades: Trade[] | null = null;
  let tok = t;
  const paint = () => {
    if (el.isConnected) el.innerHTML = body(tok, desc, trades, pick).s;
  };
  const load = async () => {
    trades = await market<{ trades: Trade[] }>(`tokens/${tok.mint}/trades?limit=${LIMIT}`)
      .then((r) => r.trades)
      .catch(() => trades);
    paint();
  };
  el.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-ta-win]");
    if (!b) return;
    pick = b.dataset.taWin!;
    paint();
  });
  paint();
  void load();
  return {
    refresh(next: TokenDetail) {
      tok = next;
      void load();
    },
  };
}
