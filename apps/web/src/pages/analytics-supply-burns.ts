import { ago, stamp, when } from "../fmt.ts";
import { html, type Raw } from "../html.ts";
import { fmtAmount, fmtInt, market, QUOTE } from "../market.ts";
import { fmtUsd, USD_NA } from "../usd.ts";
import { mountCard, slotColor, tone, type CardDef, type ChartSpec } from "./analytics-charts.ts";
import { acctLink, addSupplyPart, coins, coinsC, money, share, shortAddr, tile, txLink } from "./analytics-supply.ts";

// Burns over time and the developer wallet, inside the Supply section (analytics-supply.ts). Figures:
// GET /market/supply/burns (every burn instruction of the coin on record, per UTC day and one by one,
// with who signed it) and GET /market/supply/developer (the developer wallet's own coins: its balance
// after each of its transactions and what it bought, sold, sent, received and burned). A burn's dollars
// are at the price stored for its own time; a burn older than the first stored price has none, and the
// page says so instead of using today's price. With no burn there is no chart, only the sentence.

type O = any;
const usdC = (v: number | null | undefined) => fmtUsd(v, { compact: true });
const FILTERS: [string, string][] = [["all", "All"], ["developer", "Developer wallet"], ["fee_keeper", "Fee keeper"], ["agent_pool", "Agent pools"], ["liquidity_pool", "Liquidity pool"], ["other", "Other wallets"]];
const WHOSE: Record<string, string> = { all: "", developer: "The developer wallet has", fee_keeper: "The fee keeper has", agent_pool: "No agent pool has", liquidity_pool: "pump.fun has", other: "No other wallet has" };

/** The sentence a block shows instead of a chart or a table when it has no burn to show. */
export function noBurns(o: O, signer: string): string {
  if (o.burned && o.burned.raw === "0") return `Nothing has been burned yet. The supply is still the ${fmtAmount(o.initial_supply)} ${QUOTE} the coin was created with.`;
  if (signer === "agent_pool" || signer === "other") return `${WHOSE[signer]} burned ${QUOTE} so far.`;
  if (signer !== "all") return `${WHOSE[signer]} not burned any ${QUOTE} so far.`;
  return `No burn transaction of ${QUOTE} is on record yet.`;
}

export function burnTiles(o: O, d: O | null): Raw {
  const b = o.burned, dv = o.developer;
  const db = dv?.burned;
  const groups: O[] = b?.by_signer ?? [];
  return html`
    ${dv
      ? tile("dev-burned", "Burned by the developer wallet", db.raw === "0" ? `0 ${QUOTE}` : db.usd_at_burn !== null ? usdC(db.usd_at_burn) : coinsC(db.amount),
          db.raw === "0" ? "The developer wallet has not burned any of its coins."
            : `${db.usd_at_burn !== null ? `${coins(db.amount)} at the price of each burn's own time` : `${coins(db.amount)}; no dollar price of ${QUOTE} is on record for the time of some of these burns`}, in ${fmtInt(db.events)} ${db.events === 1 ? "transaction" : "transactions"} it signed`,
          db.raw === "0" ? undefined : `${share(db.share_of_initial)} of created`)
      : tile("dev-burned", "Burned by the developer wallet", "not set", "No developer wallet is set on this instance.")}
    ${dv
      ? tile("dev-balance", "Developer wallet holds", o.usd?.ok ? usdC(dv.balance_usd) : USD_NA, `${coins(dv.balance)} now${d?.ok ? `, after ${fmtInt(d.transactions)} transactions of its ${QUOTE} accounts` : ""}`, share(dv.share))
      : tile("dev-balance", "Developer wallet holds", "not set", "No developer wallet is set on this instance.")}
    ${tile("burn-count", "Burn transactions", b ? fmtInt(b.indexed_events) : "not read", groups.length ? groups.map((g) => `${g.label} ${fmtInt(g.events)}`).join(", ") : "none on record")}
    ${tile("burn-last", "Last burn", b?.last_at ? ago(b.last_at * 1000) : "none yet", b?.first_at ? `${stamp(b.last_at * 1000)}; first burn ${stamp(b.first_at * 1000)}` : `no ${QUOTE} has been burned`)}`;
}

/** Daily bars and the running total. Drawn in the coin: dollars are added as a second view only when every day has them. */
export function burnChart(o: O, b: O, signer: string): CardDef {
  const days: O[] = b.days ?? [];
  const priced = days.length > 0 && days.every((x) => x.usd !== null);
  return {
    id: "supply-burns",
    variants: priced ? [["amount", QUOTE], ["usd", "US dollars"]] : undefined,
    build: (variant): ChartSpec => {
      const usd = variant === "usd" && priced;
      let run = 0;
      const cum = days.map((x) => ({ t: x.t * 1000, v: usd ? (run += x.usd) : x.cumulative }));
      return {
        kind: "time", unit: "day", height: 260, empty: noBurns(o, signer),
        panes: [usd ? "Burned per day, US dollars at the price of the time" : `Burned per day, ${QUOTE}`, usd ? "Burned in total, US dollars" : `Burned in total, ${QUOTE}`],
        series: [
          { key: "day", name: "Burned that day", color: slotColor(1), kind: "columns", fmt: usd ? "usd" : "amount", pane: 0, points: days.map((x) => ({ t: x.t * 1000, v: usd ? x.usd : x.amount })) },
          { key: "total", name: "Burned in total", color: tone.accent(), kind: "line", fmt: usd ? "usd" : "amount", pane: 1, fromZero: true, points: cum },
        ],
        note: (t) => {
          const x = days.find((y) => y.t * 1000 === t);
          return x ? `${fmtInt(x.events)} burn ${x.events === 1 ? "transaction" : "transactions"}` : null;
        },
      };
    },
  };
}

export function burnTable(o: O, b: O, signer: string): Raw {
  const ev: O[] = b.events ?? [];
  if (!ev.length) return html`<p class="an-line">${noBurns(o, signer)}</p>`;
  const who = (e: O) => (e.signer.kind === "address" ? acctLink(e.signer.address) : acctLink(e.signer.address, e.signer.label));
  const row = (e: O) => html`<tr data-signer="${e.signer.kind}"><td>${e.time ? html`<span title="${stamp(e.time * 1000)}">${when(e.time * 1000)}</span>` : html`<span class="faint">time not recorded</span>`}</td>
      <td class="right num sup-v">${e.usd !== null ? money(e.usd, e.amount) : html`<b>${coins(e.amount)}</b><em>no dollar price on record then</em>`}</td>
      <td>${who(e)}<div class="an-sub">${e.via_label ? `through the ${e.via_label}, ` : ""}${txLink(e.signature, "Solscan")}</div></td></tr>`;
  const table = (rows: O[]) => html`<div class="tw"><table class="t sup-t"><thead><tr><th>Time</th><th class="right">Burned</th><th>Signed by</th></tr></thead><tbody>${rows.map(row)}</tbody></table></div>`;
  // the newest in view, the earlier ones folded closed like the page's other long tables
  const older = ev.slice(BURNS_IN_VIEW);
  return html`${table(ev.slice(0, BURNS_IN_VIEW))}${older.length ? html`<details class="an-fold an-fold-in" id="sup-burn-older"><summary><span>Earlier burns</span><span class="an-count">${older.length}</span></summary>${table(older)}</details>` : ""}${b.count > ev.length ? html`<div class="panel-note">The ${fmtInt(ev.length)} most recent of ${fmtInt(b.count)}.</div>` : ""}`;
}
const BURNS_IN_VIEW = 8;

const MOVES: [string, string, string][] = [
  ["bought", "Bought", "coins that came in through a pump.fun or PumpSwap trade"],
  ["sold", "Sold", "coins that went out through a pump.fun or PumpSwap trade"],
  ["received", "Received", "coins that came in any other way, such as what agents paid for compute"],
  ["sent", "Sent", "coins that went out any other way"],
  ["burned", "Burned", "coins destroyed by a burn it signed"],
];

/** The developer wallet's balance over time: one point after each transaction of its token accounts. */
export function devChart(d: O): CardDef {
  // one point per second (the chart's time axis takes one value per instant): the last balance of that second
  const by = new Map<number, number>();
  for (const p of d.history ?? []) if (p.time != null) by.set(p.time * 1000, p.balance);
  const points = [...by.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));
  return { id: "supply-dev", build: (): ChartSpec => ({ kind: "time", unit: "event", height: 170, panes: [`Balance after each transaction, ${QUOTE}`], empty: `No transaction of the developer wallet's ${QUOTE} accounts is on record.`,
    series: [{ key: "bal", name: "Developer wallet balance", color: slotColor(1), kind: "step", fmt: "amount", fromZero: true, points }] }) };
}

export function devBody(d: O | null): Raw {
  if (!d) return html`<p class="an-line">The market indexer did not answer the developer wallet.</p>`;
  if (!d.ok) return html`<p class="an-line">${d.reason}.</p>`;
  const rows = MOVES.map(([k, label, what]) => ({ k, label, what, a: d.activity[k] }));
  const mv: O[] = d.moves ?? [];
  return html`<p class="sup-note">${acctLink(d.wallet, shortAddr(d.wallet))} is the project's developer wallet, and the admin of the network's programs. What follows is what the chain shows of its own ${QUOTE}, nothing else.${d.synced ? "" : " Its history is still being read."}</p>
    <ul class="an-split-l sup-l sup-moves">${rows.map((r) => html`<li data-move="${r.k}" class="${r.a.count ? "" : "sup-zero"}" title="${r.what}"><i style="--k:${r.k === "burned" ? slotColor(1) : r.k === "bought" || r.k === "received" ? tone.good() : tone.mute()}"></i><span>${r.label}<small>${r.a.count === 1 ? "1 transaction" : `${fmtInt(r.a.count)} transactions`}</small></span>
      <div class="sup-v">${r.a.count === 0 ? html`<b>none</b>` : r.a.usd_at_time !== null ? money(r.a.usd_at_time, r.a.amount) : html`<b>${coins(r.a.amount)}</b><em>no dollar price on record then</em>`}</div><small></small></li>`)}</ul>
    ${mv.length ? html`<details class="an-fold an-fold-in" id="sup-dev-moves"><summary><span>Every movement, with its transaction</span><span class="an-count">${mv.length}</span></summary><div class="tw"><table class="t sup-t"><thead><tr><th>Time</th><th>What</th><th class="right">Amount</th></tr></thead><tbody>${mv.map(
      (m) => html`<tr><td>${m.time ? html`<span title="${stamp(m.time * 1000)}">${when(m.time * 1000)}</span>` : html`<span class="faint">time not recorded</span>`}</td><td>${MOVES.find((x) => x[0] === m.kind)?.[1] ?? m.kind}<div class="an-sub">${txLink(m.signature, "Solscan")}</div></td>
        <td class="right num sup-v">${m.usd !== null ? money(m.usd, m.amount) : html`<b>${coins(m.amount)}</b>`}</td></tr>`,
    )}</tbody></table></div></details>` : ""}`;
}

const cardShell = (id: string, title: string, sub: string, h: number, wide: boolean, extra: Raw | "" = ""): Raw =>
  html`<section class="panel an-card${wide ? " an-wide" : ""}" id="${id}"><div class="an-card-h"><div><h2>${title}</h2><p>${sub}</p></div>${extra}<div class="seg an-card-seg" role="group" aria-label="View"></div></div><div class="an-card-legend" hidden></div><div class="an-card-body an-skel" style="--h:${h}px"></div><div class="sup-after"></div></section>`;

export const BURNS_CSS = `
.sup-filter{flex:none}
.sup-filter .seg-b{border:0;cursor:pointer;font:500 12px/1 var(--sans);background:transparent}
.sup-filter .seg-b[aria-pressed="true"]{background:var(--tp);color:var(--bg)}
.sup-moves{margin:0;padding:0 18px 8px}
.sup-plain .an-card-body{display:none}
#sup-dev .an-card-body{flex:none}
@media (max-width:640px){.sup-t .sup-v em{white-space:normal;text-align:right;max-width:132px}.sup-t td .link{white-space:normal}.sup-t th,.sup-t td{padding-left:10px;padding-right:10px}}
`;

addSupplyPart({
  shell: () => html`<div class="an-kpis" id="sup-burn-tiles" aria-label="Burn figures">${[0, 1, 2, 3].map(() => html`<section class="an-tile an-skel-t"><span>.</span></section>`)}</div>
    <div class="an-charts" id="sup-burn-cards">
      ${cardShell("sup-burns", `How much ${QUOTE} has been burned, and when?`, "Every burn of the coin on record: bars per UTC day, and the running total under them.", 260, true, html`<div class="seg sup-filter" id="sup-filter" role="group" aria-label="Who signed"></div>`)}
      <section class="panel an-card" id="sup-burn-list"><div class="an-card-h"><div><h2>Every burn</h2><p>Newest first, with who signed it and its transaction.</p></div><span class="an-count" id="sup-burn-n"></span></div><div id="sup-burn-rows"></div></section>
      ${cardShell("sup-dev", "What has the developer wallet done with its coins?", `Its ${QUOTE} balance after each of its transactions, and what it bought, sold, sent, received and burned.`, 170, false)}
    </div>`,
  mount: (root) => {
    if (typeof document !== "undefined" && !document.getElementById("sup-burn-style")) {
      const s = document.createElement("style");
      s.id = "sup-burn-style";
      s.textContent = BURNS_CSS;
      document.head.appendChild(s);
    }
    const $ = (sel: string) => root.querySelector<HTMLElement>(sel)!;
    let signer = "all";
    let cards: (() => void)[] = [];
    let last = "";
    let overview: O = null;
    let stopped = false;
    const paint = async () => {
      const o = overview;
      const [b, d] = await Promise.all([market<O>(`supply/burns?signer=${signer}&limit=100`), market<O>("supply/developer?limit=200").catch(() => null)]);
      if (stopped || !root.isConnected) return;
      const sig = JSON.stringify([signer, o.burned, o.developer, { ...b, usd: 0 }, d ? { ...d, usd: 0, as_of: 0 } : null]);
      if (sig === last) return;
      last = sig;
      for (const c of cards) c();
      cards = [];
      $("#sup-burn-tiles").innerHTML = burnTiles(o, d).s;
      const any = b.signers?.all > 0;
      $("#sup-filter").innerHTML = any ? FILTERS.filter(([k]) => k === "all" || k === "developer" || b.signers[k] > 0).map(([k, l]) => html`<button type="button" class="seg-b" data-signer="${k}" aria-pressed="${k === signer}">${l}${k === "all" ? "" : ` ${fmtInt(b.signers[k])}`}</button>`.s).join("") : "";
      $("#sup-filter").hidden = !any;
      // no burn to draw: the sentence, never an empty chart
      const burns = $("#sup-burns");
      burns.classList.toggle("sup-plain", !b.days?.length);
      burns.querySelector<HTMLElement>(".sup-after")!.innerHTML = b.days?.length ? "" : html`<p class="an-line">${noBurns(o, signer)}</p>`.s;
      if (b.days?.length) cards.push(mountCard(burns, burnChart(o, b, signer)));
      else burns.querySelector(".an-card-body")?.classList.remove("an-skel");
      $("#sup-burn-n").textContent = b.count ? `${fmtInt(b.count)}${signer === "all" ? "" : ` of ${fmtInt(b.signers.all)}`}` : "";
      $("#sup-burn-n").hidden = !b.count;
      $("#sup-burn-rows").innerHTML = burnTable(o, b, signer).s;
      const dev = $("#sup-dev");
      const hasHistory = !!d?.ok && (d.history ?? []).some((p: O) => p.time != null);
      dev.classList.toggle("sup-plain", !hasHistory);
      if (hasHistory) cards.push(mountCard(dev, devChart(d)));
      else dev.querySelector(".an-card-body")?.classList.remove("an-skel");
      dev.querySelector<HTMLElement>(".sup-after")!.innerHTML = devBody(d).s;
    };
    const click = (ev: Event) => {
      const b = (ev.target as Element).closest?.<HTMLElement>("[data-signer]");
      if (!b || !overview) return;
      signer = b.dataset.signer ?? "all";
      void paint().catch(() => undefined);
    };
    root.addEventListener("click", click);
    return {
      refresh: (o) => { overview = o; return paint(); },
      stop: () => { stopped = true; root.removeEventListener("click", click); for (const c of cards) c(); cards = []; },
    };
  },
});
