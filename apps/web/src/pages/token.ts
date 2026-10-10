import { ApiError, get, getOptional } from "../api.ts";
import { repoLink, when } from "../fmt.ts";
import { html, type Raw } from "../html.ts";
import { mount as mountLivePanel, type LivePanelHandle } from "../live-panel/index.ts";
import { mountCommits } from "./commits.ts";
import { genesisLink, loadGenesis } from "./genesis-proof.ts";
import { feedPanel } from "./feed.ts";
import { agentAvatar, agentTitle, buildingLine, hiddenNote, injectBuildingStyle, type DirToken } from "../building.ts";
import {
  addrLink,
  amountFig,
  candleSlot,
  changeFig,
  defaultTf,
  fig,
  fmtAmount,
  fmtInt,
  fmtPrice,
  market,
  mountCandles,
  phaseBadge,
  priceFig,
  progressBar,
  QUOTE,
  shortAddr,
  txLink,
  explorerTx,
  type Candle,
  type Holders,
  type TokenDetail,
  type Trade,
} from "../market.ts";
import { agentLink, empty, icon, kv, panel, stat } from "../ui.ts";
import { unreachable } from "./tokens.ts";
import type { Page } from "./types.ts";

// One agent token (plan L3; APP-CONSOLIDATION.md amendment 2026-10-10 (2)). Its figures are price,
// market cap, 24 h volume and 24 h change, then what the agent is building (repository, live status,
// a link to the session). The agent's live panel (L4) is the main element: its session in progress,
// else its idle state (live only, live-panel/live-only.ts). Around it, from the market indexer: price candles in tLINE, recent
// trades, holders, curve progress and graduation; from Core: the agent and the lineages on its
// repository. No fee figures are shown. A hidden launch still resolves here, marked as hidden. The
// trade box is part of the wallet bundle (apps/web/wallet/trade.ts), loaded on demand: it signs in
// the browser wallet and swaps on Meteora DBC before graduation and DAMM v2 after.
//
// Sections refresh in place every 15 s (and right after a trade) so the panel and the trade box keep
// their state; nothing is re-rendered around them.

const TFS = ["1m", "5m", "1h", "1d"] as const;
const tfByMint = new Map<string, string>();

interface Data {
  t: TokenDetail;
  candles: Candle[];
  tf: string;
  trades: Trade[];
  holders: Holders;
}

async function load(mint: string, tf?: string): Promise<Data> {
  const t = await market<TokenDetail>(`tokens/${mint}`);
  const f = tf ?? tfByMint.get(mint) ?? defaultTf(t.created_at);
  const sec = { "1m": 60, "5m": 300, "1h": 3600, "1d": 86400 }[f] ?? 3600;
  const [c, tr, h] = await Promise.all([
    market<{ candles: Candle[] }>(`tokens/${mint}/candles?tf=${f}&from=${t.created_at - sec}`),
    market<{ trades: Trade[] }>(`tokens/${mint}/trades?limit=25`),
    market<Holders>(`tokens/${mint}/holders?limit=20`),
  ]);
  return { t, candles: c.candles, tf: f, trades: tr.trades, holders: h };
}

const sym = (t: TokenDetail) => t.symbol ?? "token";

// ------------------------------------------------------------------------------------------------
// sections (each a plain function of the indexer's data)

function statsRow(t: TokenDetail): Raw {
  return html`<div class="stats mk-stats" style="--n:4">
    ${stat("Price", priceFig(t.price, "price"), `${QUOTE} per ${sym(t)}`)}
    ${stat("Market cap", amountFig(t.market_cap, QUOTE, "market_cap"), html`supply ${fig(fmtAmount(t.supply), t.supply, undefined, "supply")}`)}
    ${stat("24h volume", amountFig(t.volume_24h, QUOTE, "volume_24h"), html`${fig(fmtInt(t.trades_24h), t.trades_24h, undefined, "trades_24h")} trades`)}
    ${stat("24h change", changeFig(t.change_24h, "change_24h"), "vs the price 24h ago")}
  </div>`;
}

function chartBody(d: Data): Raw {
  return candleSlot({ tf: d.tf, candles: d.candles, start: d.t.start_price }, 280);
}

function tradesTable(d: Data): Raw {
  if (!d.trades.length) return empty("No trades yet", `The first buy on the curve shows here once the indexer has read it.`);
  return html`<div class="tw"><table class="t mk-trades"><thead><tr><th>Side</th><th class="right hide-sm">${sym(d.t)}</th><th class="right">${QUOTE}</th><th class="right">Price</th><th class="hide-sm">Trader</th><th class="hide-sm">Venue</th><th class="right">When</th></tr></thead><tbody>${d.trades.map(
    (r) => html`<tr data-sig="${r.signature}"><td><span class="mk-side ${r.side}">${r.side === "buy" ? "Buy" : "Sell"}</span></td>
      <td class="right nowrap hide-sm">${fig(fmtAmount(r.base_amount), r.base_amount)}</td>
      <td class="right nowrap">${fig(fmtAmount(r.quote_amount), r.quote_amount)}</td>
      <td class="right nowrap">${fig(fmtPrice(r.price), r.price)}</td>
      <td class="hide-sm">${addrLink(r.trader)}</td>
      <td class="hide-sm dim">${r.venue === "damm" ? "DAMM v2" : r.venue === "dbc" ? "DBC" : r.venue}</td>
      <td class="right nowrap">${r.time ? html`<a class="link" href="${explorerTx(r.signature)}" target="_blank" rel="noopener" title="${r.signature}"><time data-ago="${r.time * 1000}"></time></a>` : txLink(r.signature)}</td></tr>`,
  )}</tbody></table></div>`;
}

function holdersTable(d: Data): Raw {
  const h = d.holders;
  if (!h.top.length) return empty(h.holders === null ? "Holders not counted yet" : "No holders outside the pool", h.holders === null ? "The indexer counts holders from the token's accounts; it has not done so for this token yet." : undefined);
  return html`<div class="tw"><table class="t mk-holders"><thead><tr><th>#</th><th>Holder</th><th class="right">${sym(d.t)}</th><th class="right">Share of supply</th></tr></thead><tbody>${h.top.map(
    (x, i) => html`<tr data-owner="${x.owner}"><td class="num faint">${i + 1}</td><td>${addrLink(x.owner)}${x.owner === d.t.launcher ? html` <span class="b outline">launcher</span>` : ""}</td>
      <td class="right nowrap">${fig(fmtAmount(x.amount), x.amount)}</td>
      <td class="right nowrap">${x.share === null ? html`<span class="faint">TBA</span>` : html`<span class="num" data-v="${x.share}">${(x.share * 100).toFixed(2)}%</span>`}</td></tr>`,
  )}</tbody></table></div>
  <div class="panel-note">${h.holders === null ? "Holder count TBA" : html`${fmtInt(h.holders)} holder${h.holders === 1 ? "" : "s"}`}, ${h.excludes} excluded${h.source ? `, counted from ${h.source}` : ""}${h.as_of ? html`, as of ${when(h.as_of * 1000)}` : ""}.</div>`;
}

const EVENT: Record<string, string> = { launch: "Launched on the DBC curve", migration: "Migrated to DAMM v2 by Meteora", graduated: "Graduated (lineage_launch)", repointed: "Pool position repointed to the agent" };

function curveBody(t: TokenDetail): Raw {
  const grad = t.phase === "graduated";
  const steps = [
    { k: "launch", done: true },
    { k: "migration", done: t.migrated || grad },
    { k: "graduated", done: grad },
  ];
  const evs = new Map(t.events.map((e) => [e.kind, e]));
  return html`<div class="panel-b mk-curve">
      <div class="mk-curve-h"><span class="eyebrow">Curve progress</span>${phaseBadge(t)}</div>
      <div class="mk-curve-bar">${progressBar(t.curve_progress, "curve_progress")}</div>
      <div class="mk-curve-n dim">${grad ? html`The curve filled at ${amountFig(t.migration_threshold, QUOTE, "migration_threshold")}; trading continues on the DAMM v2 pool.` : html`${amountFig(t.quote_reserve, QUOTE, "quote_reserve")} of ${amountFig(t.migration_threshold, QUOTE, "migration_threshold")} raised; at the threshold Meteora migrates the pool to DAMM v2.`}</div>
      <ol class="mk-steps">${steps.map((s) => {
        const e = evs.get(s.k);
        return html`<li class="${s.done ? "done" : ""}"><i>${s.done ? icon.check : ""}</i><div><div>${EVENT[s.k]}</div><div class="sub faint">${e ? html`${e.time ? when(e.time * 1000) : ""} ${txLink(e.signature)}` : s.done ? "transaction not indexed" : "not yet"}</div></div></li>`;
      })}</ol>
    </div>`;
}

/** What the agent is building: its live status or last verified improvement, the repository and the session link. */
function buildingBody(t: TokenDetail): Raw {
  return html`<div class="panel-b mk-building">${buildingLine(t as unknown as DirToken, { full: true })}</div>`;
}

function agentBody(t: TokenDetail, lineages: { lineage_id: string; recipe_name: string; height: number; status: string }[] | null, known: boolean): Raw {
  return html`${kv([
    ["Agent", html`${agentLink(t.agent)}${known ? "" : html` <span class="faint" title="This Core has no record of the agent yet">not in Core</span>`}`],
    ["Lineages", lineages === null ? html`<span class="faint">Core not reachable</span>` : lineages.length ? html`<span class="mk-lins">${lineages.map((l) => html`<a class="link" href="/lineages/${l.lineage_id}">${l.recipe_name}</a> <span class="faint">gen ${l.height}${l.status !== "active" ? `, ${l.status}` : ""}</span>`)}</span>` : html`<span class="faint">none on this repository yet</span>`],
    ["Repository", t.repo_url ? repoLink(t.repo_url) : null],
    ["Launcher", addrLink(t.launcher)],
    ["Mint", html`${addrLink(t.mint)} <button type="button" class="mk-copy" data-copy="${t.mint}" aria-label="Copy the mint address">${icon.copy}</button>`],
    ["Curve pool", addrLink(t.pools.dbc_pool)],
    ["DAMM v2 pool", t.pools.damm_pool ? addrLink(t.pools.damm_pool) : html`<span class="faint">after graduation</span>`],
  ])}`;
}

// ------------------------------------------------------------------------------------------------

const norm = (u: string | null | undefined) => (u ?? "").toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");

async function agentLineages(t: TokenDetail) {
  const [a, ls] = await Promise.all([getOptional<any>(`agents/${t.agent}`).catch(() => null), get<any[]>("lineages").catch(() => null)]);
  const repo = norm(a?.target_repo ?? t.repo_url);
  return { known: !!a, lineages: ls ? ls.filter((l) => norm(l.repo) === repo) : null };
}

export async function tokenPage([mint]: string[]): Promise<Page> {
  let d: Data;
  try {
    d = await load(mint!);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 502 || e.status === 503)) return unreachable(e);
    if (e instanceof ApiError && e.status === 404)
      return {
        title: "Token",
        body: html`<div class="panel errorbox"><h1>Not an indexed agent token</h1><p>The market indexer has no agent token with the mint <span class="hash">${mint}</span>. A token launched a moment ago appears after the indexer's next pass.</p><p><a class="link" href="/">All agent tokens</a></p></div>`,
      };
    throw e;
  }
  const t = d.t;
  const dt = t as unknown as DirToken;
  injectBuildingStyle();
  const ag = await agentLineages(t);
  const genesis = await loadGenesis(t.agent);
  const body = html`
    <div class="ph-row"><div class="ph-title"><div class="crumbs"><a href="/">Explorer</a><span>/</span><span>${t.symbol ?? shortAddr(t.mint)}</span></div>
      <h1 class="mk-h1">${agentAvatar(t.agent, dt.avatar, 36, "mk-av")}${t.name ?? shortAddr(t.mint)} <span class="mk-h1sym">${t.symbol ?? ""}</span></h1>
      <div class="ph-sub"><span id="mk-phase">${phaseBadge(t)}</span><span>launched ${when(t.created_at * 1000)}</span><span>agent <a class="link" href="/agents/${t.agent}/profile">${agentTitle(dt)}</a></span>${genesis ? html`<span>${genesisLink(genesis)}</span>` : ""}${t.repo_url ? html`<span>${repoLink(t.repo_url)}</span>` : ""}</div></div></div>
    ${hiddenNote(dt.hidden)}
    <section class="panel mk-statspanel" id="mk-stats">${statsRow(t)}</section>
    ${panel("What the agent is building", html`<div id="mk-building">${buildingBody(t)}</div>`, { cls: "mk-buildpanel", aside: html`<a class="link" href="/agents/${t.agent}/profile">Agent profile</a>` })}
    <div class="grid-main mk-grid" style="margin-top:16px">
      <div class="mk-main">
        ${panel(html`Agent at work`, html`<div id="mk-live" class="mk-live"></div>`, { cls: "mk-livepanel", aside: html`<a class="link" href="/agents/${t.agent}">Agent page</a>`, note: html`What this token's agent is doing: its authoring session live while it works, otherwise when its next session starts (or why it is paused). Past sessions are not replayed. Edit text stays sealed until the candidate is final (SPEC 17.3).` })}
        ${panel(
          "Price",
          html`<div class="panel-b mk-chartwrap" id="mk-chart">${chartBody(d)}</div>`,
          { cls: "mk-pricepanel", aside: html`<span class="faint hide-xs">${QUOTE} per ${sym(t)}</span><div class="seg mk-tf" role="group" aria-label="Candle width">${TFS.map((f) => html`<button type="button" data-tf="${f}" aria-pressed="${String(f === d.tf)}">${f}</button>`)}</div>` },
        )}
        <section class="panel mk-activity">
          <div class="panel-h"><div class="seg" data-tabs="mk-${t.mint}" role="group" aria-label="Activity"><button type="button" data-tab="trades" aria-pressed="true">Trades</button><button type="button" data-tab="holders" aria-pressed="false">Holders</button></div><div class="aside hide-xs"><span class="faint">from the market indexer</span></div></div>
          <div data-pane="trades" id="mk-trades">${tradesTable(d)}</div>
          <div data-pane="holders" id="mk-holders" hidden>${holdersTable(d)}</div>
        </section>
        <div id="mk-commits"></div>
      </div>
      <div class="mk-col">
        ${panel(html`Trade ${t.symbol ?? ""}`, html`<div id="mk-trade" class="mk-trade"><div class="panel-b dim">Loading the wallet module…</div></div>`, { cls: "mk-tradepanel" })}
        <div id="mk-feed"></div>
        ${panel("Curve and graduation", html`<div id="mk-curve">${curveBody(t)}</div>`, { cls: "mk-curvepanel" })}
        ${panel("Agent", html`<div id="mk-agent">${agentBody(t, ag.lineages, ag.known)}</div>`, { cls: "mk-agentpanel" })}
      </div>
    </div>`;

  return {
    title: `${t.symbol ?? "Token"} ${t.name ?? ""}`.trim(),
    body,
    mount: (root) => {
      let cur = d;
      let tradeBox: { update?: (t: TokenDetail) => void; destroy?: () => void } | null = null;
      const liveEl = root.querySelector<HTMLElement>("#mk-live")!;
      // the agent chat feed next to the live panel (plan F), refreshed while the page is open
      const feedEl = root.querySelector<HTMLElement>("#mk-feed");
      // the agent's commits to its own GitHub fork, live (identity service + GitHub)
      mountCommits(root.querySelector<HTMLElement>("#mk-commits")!, { agent: t.agent, repoUrl: t.repo_url ?? null });
      const paintFeed = () => void feedPanel({ agent: t.agent, title: "Agent chat" }).then((r) => feedEl?.isConnected && (feedEl.innerHTML = r.s));
      paintFeed();
      const feedTimer = setInterval(() => (feedEl?.isConnected ? paintFeed() : clearInterval(feedTimer)), 20_000);
      const set = (id: string, r: Raw) => {
        const el = root.querySelector(`#${id}`);
        if (el) el.innerHTML = r.s;
      };
      const paint = (x: Data) => {
        if (!liveEl.isConnected) return;
        cur = x;
        set("mk-stats", statsRow(x.t));
        set("mk-phase", phaseBadge(x.t));
        set("mk-chart", chartBody(x));
        set("mk-trades", tradesTable(x));
        set("mk-holders", holdersTable(x));
        set("mk-curve", curveBody(x.t));
        set("mk-building", buildingBody(x.t));
        for (const b of root.querySelectorAll<HTMLElement>("[data-tf]")) b.setAttribute("aria-pressed", String(b.dataset.tf === x.tf));
        mountCandles(root);
        tradeBox?.update?.(x.t);
      };
      let busy = false;
      const refresh = async (tf?: string) => {
        if (busy) return;
        busy = true;
        try {
          paint(await load(t.mint, tf ?? cur.tf));
        } catch {
          /* keep the last good figures; the next pass retries */
        } finally {
          busy = false;
        }
      };
      mountCandles(root);
      root.querySelector(".mk-tf")?.addEventListener("click", (ev) => {
        const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-tf]");
        if (!b) return;
        tfByMint.set(t.mint, b.dataset.tf!);
        void refresh(b.dataset.tf!);
      });
      const onResize = () => mountCandles(root);
      window.addEventListener("resize", onResize);

      // the live panel (L4) in agent mode
      const live: LivePanelHandle = mountLivePanel(liveEl, { agent: t.agent, height: matchMedia("(max-width: 760px)").matches ? 340 : 420 });

      // the trade box (wallet bundle)
      const tradeEl = root.querySelector<HTMLElement>("#mk-trade")!;
      const url = "/assets/wallet.js";
      import(/* @vite-ignore */ url)
        .then((m) => {
          tradeBox = m.mountTradeBox(tradeEl, {
            token: t,
            onTrade: () => {
              // the indexer polls every few seconds and also subscribes to the pools' logs
              for (const ms of [2500, 8000, 16000, 30000]) setTimeout(() => void refresh(), ms);
            },
          });
        })
        .catch((e) => {
          tradeEl.innerHTML = html`<div class="panel-b">${empty("The wallet module did not load", String((e as Error)?.message ?? e))}</div>`.s;
        });

      const timer = setInterval(() => {
        if (!liveEl.isConnected) {
          clearInterval(timer);
          window.removeEventListener("resize", onResize);
          live.destroy();
          tradeBox?.destroy?.();
          return;
        }
        void refresh();
      }, 15_000);
    },
  };
}
