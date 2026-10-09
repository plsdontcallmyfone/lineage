import { esc } from "../../../apps/web/src/html.ts";
import { fmtAmount, fmtChange, fmtInt, fmtPrice, fmtProgress, QUOTE, shortAddr } from "../../../apps/web/src/market.ts";
import type { Card, SessionEvent, Stats, TokenDetail } from "./client.ts";
import type { FeeCrank, Holders, Trade } from "./client.ts";

// Pure render functions (strings in, strings out) for the elements, so they can be tested without a
// DOM. Every figure is the API's own value through the dashboard's formatters (apps/web/src/market.ts);
// a figure that does not exist renders as TBA, never as a guess.

export { esc };

export const repoLabel = (u: string | null | undefined) => (u ? u.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "") : "");

export function linkFor(template: string | null | undefined, site: string, c: { mint: string; agent: string; symbol: string | null }): string {
  const t = template || `${site}/tokens/{mint}`;
  return t.replace(/\{mint\}/g, encodeURIComponent(c.mint)).replace(/\{agent\}/g, encodeURIComponent(c.agent)).replace(/\{symbol\}/g, encodeURIComponent(c.symbol ?? ""));
}

const STATE_LABEL: Record<string, string> = { working: "Working", idle: "Idle", graduated: "Graduated", unknown: "Status TBA" };

export function stateChip(state: string): string {
  return `<span class="chip" part="state" data-s="${esc(state)}"><i></i>${esc(STATE_LABEL[state] ?? state)}</span>`;
}

export function progressHtml(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return `<span class="faint">curve TBA</span>`;
  const pct = Math.min(1, Math.max(0, p)) * 100;
  return `<span class="prog" part="progress" title="Curve progress: quote reserve over the migration threshold"><span class="bar"><i style="width:${pct.toFixed(2)}%"></i></span><span class="num">${esc(fmtProgress(p))}</span></span>`;
}

/** One line saying what a session event is, for captions and the terminal. */
export function describeEvent(e: SessionEvent | null | undefined): string {
  if (!e) return "";
  const rng = e.start_line ? (e.end_line && e.end_line !== e.start_line ? `, lines ${e.start_line} to ${e.end_line}` : `, line ${e.start_line}`) : "";
  switch (e.kind) {
    case "read":
      return `Reading ${e.path}${rng}`;
    case "edit":
    case "write":
    case "patch":
      return `${e.kind === "write" ? "Writing" : e.kind === "patch" ? "Applying a patch to" : "Editing"} ${e.path}${rng}${e.after === undefined ? ", text sealed until the verdict" : ""}`;
    case "search":
      return `Searching for ${e.query ?? ""}`;
    case "list":
      return `Listing ${e.path === "." || !e.path ? "the repository" : e.path}`;
    case "evaluate":
      return `Measuring the change${e.target ? `, target ${e.target}` : ""}`;
    case "phase":
      return `Sandbox: ${e.phase}`;
    case "result":
      return e.sealed ? "Sandbox run finished, output sealed" : `Sandbox run finished: ${e.outcome ?? "done"}`;
    case "submit":
      return "Submitted a candidate";
    case "give_up":
      return "Stopped without submitting";
    case "note":
      return e.text ? `"${e.text.replace(/\s+/g, " ").slice(0, 120)}"` : "Thinking";
  }
  return e.kind;
}

export function sessionLine(c: Card): string {
  const s = c.session;
  if (!s) return c.sessions_known ? "No authoring session yet" : "Sessions did not load";
  if (s.state === "live") return `Live on ${s.recipe_name ?? "a lineage"}`;
  return `Last session on ${s.recipe_name ?? "a lineage"}, ${s.state}`;
}

export interface CardOpts {
  href: string;
  look: "plain" | "dither";
  /** absolute position in a timeline */
  style?: string;
}

export function cardHtml(c: Card, o: CardOpts): string {
  const label = c.symbol ?? shortAddr(c.mint);
  return `<article class="card" part="card" data-mint="${esc(c.mint)}" data-state="${esc(c.state)}" data-look="${esc(o.look)}"${o.style ? ` style="${esc(o.style)}"` : ""}>
  <a class="shot" part="screen" href="${esc(o.href)}" target="_blank" rel="noopener" aria-label="${esc(`${label}: ${sessionLine(c)}`)}">
    <span class="thumb" data-thumb="${esc(c.session?.session_id ?? "")}"><span class="ph">${esc(c.session ? "Loading the screen" : c.sessions_known ? "No session yet" : "Screen TBA")}</span></span>
    ${stateChip(c.state)}
  </a>
  <div class="meta" part="meta">
    <div class="id"><span class="sym" part="ticker">${esc(label)}</span><span class="name" part="name">${esc(c.name ?? "")}</span></div>
    ${c.tagline ? `<p class="tag" part="description">${esc(c.tagline)}</p>` : ""}
    <div class="line"><span class="repo" title="${esc(c.repo ?? "")}">${esc(repoLabel(c.repo) || "repository TBA")}</span></div>
    <div class="line figs"><span class="mc"><span class="k">Mcap</span> <b class="num">${esc(fmtAmount(c.market_cap))}</b>${c.market_cap == null ? "" : ` <span class="u">${QUOTE}</span>`}</span>${progressHtml(c.curve_progress)}</div>
    <div class="cap" part="caption">${esc(sessionLine(c))}</div>
  </div>
</article>`;
}

/** Day ticks and x positions for a launch-time axis. */
export function timelineLayout(times: number[], o: { pad?: number; step?: number; min?: number } = {}) {
  const pad = o.pad ?? 24;
  const step = o.step ?? 236;
  if (!times.length) return { xs: [] as number[], width: 0, ticks: [] as { x: number; label: string }[] };
  const sorted = [...times].sort((a, b) => a - b);
  const t0 = sorted[0]!;
  const t1 = sorted[sorted.length - 1]!;
  const span = Math.max(1, t1 - t0);
  // cards never overlap: a card's x is the larger of its time position and the previous card's x plus a step
  const width0 = Math.max(o.min ?? 0, step * times.length);
  const pos = (t: number) => pad + ((t - t0) / span) * (width0 - step);
  const order = times.map((t, i) => ({ t, i })).sort((a, b) => a.t - b.t || a.i - b.i);
  const xs = new Array<number>(times.length);
  let last = -Infinity;
  for (const { t, i } of order) {
    const x = Math.max(pos(t), last + step);
    xs[i] = Math.round(x);
    last = x;
  }
  const width = Math.round(last + step + pad);
  const ticks: { x: number; label: string }[] = [];
  const day = 86400;
  const first = Math.ceil(t0 / day) * day;
  const nDays = Math.floor((t1 - first) / day) + 1;
  const every = Math.max(1, Math.ceil(nDays / 12));
  for (let t = first, k = 0; t <= t1; t += day, k++) {
    if (k % every) continue;
    const d = new Date(t * 1000);
    ticks.push({ x: Math.round(pos(t)), label: `${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()}` });
  }
  return { xs, width, ticks };
}

// --------------------------------------------------------------------------------------- stats, how

const fig = (v: number | null | undefined, f: (n: number) => string = (n) => fmtInt(n)) => (v === null || v === undefined || !Number.isFinite(v) ? "TBA" : f(v));

export const STAT_ITEMS: { key: keyof Stats; label: string; unit?: string; fmt?: (n: number) => string }[] = [
  { key: "tokens", label: "Agent tokens" },
  { key: "agents_working", label: "Agents working now" },
  { key: "generations", label: "Verified generations" },
  { key: "fees_to_compute", label: "Fees to compute", unit: QUOTE, fmt: fmtAmount },
];

export function statsHtml(s: Stats, keys: (keyof Stats)[] = STAT_ITEMS.map((x) => x.key)): string {
  return `<dl class="stats" part="stats">${keys
    .map((k) => {
      const it = STAT_ITEMS.find((x) => x.key === k) ?? { key: k, label: String(k).replace(/_/g, " ") };
      const v = fig(s[k], it.fmt);
      return `<div class="stat" part="stat" data-k="${esc(k)}"><dt>${esc(it.label)}</dt><dd><b class="num">${esc(v)}</b>${it.unit && v !== "TBA" ? `<span class="u">${esc(it.unit)}</span>` : ""}</dd></div>`;
    })
    .join("")}</dl>`;
}

export interface Step {
  n: number;
  title: string;
  body: string;
  figure: { label: string; value: string; unit?: string } | null;
}

/** The mechanism in six steps, each with a live figure from the network. */
export function howSteps(s: Stats): Step[] {
  return [
    { n: 1, title: "Launch", body: "Anyone launches an agent token on a Meteora bonding curve quoted in tLINE, and names the public repository the agent will improve.", figure: { label: "tokens launched", value: fig(s.tokens) } },
    { n: 2, title: "Fees fund compute", body: "Trades pay fees. A permissionless crank sends the agent's share of them into its compute vault, the rest to the treasury.", figure: { label: "routed to compute vaults", value: fig(s.fees_to_compute, fmtAmount), unit: QUOTE } },
    { n: 3, title: "The agent works", body: "The vault pays for model tokens and sandbox time. The agent reads the repository, edits it and measures the change, live on its screen.", figure: { label: "agents working now", value: fig(s.agents_working) } },
    { n: 4, title: "Blind replay", body: "Independent verifiers rebuild, test and measure every candidate without knowing who wrote it, and commit their results before revealing them.", figure: { label: "candidates submitted", value: fig(s.candidates) } },
    { n: 5, title: "Accepted generation", body: "A change the replays agree on, that passes the tests and beats the metric by the recipe's minimum, becomes the lineage's next generation.", figure: { label: "verified generations", value: fig(s.generations) } },
    { n: 6, title: "Graduation", body: "When the curve fills, the token migrates to a Meteora DAMM v2 pool with its liquidity locked, and that pool's fees keep flowing to the agent's vault.", figure: { label: "graduated to DAMM v2", value: fig(s.graduated) } },
  ];
}

export function howHtml(s: Stats): string {
  return `<ol class="how" part="how">${howSteps(s)
    .map(
      (st) =>
        `<li class="step" part="step"><span class="n">${st.n}</span><div><h4>${esc(st.title)}</h4><p>${esc(st.body)}</p>${st.figure ? `<div class="f"><b class="num">${esc(st.figure.value)}</b>${st.figure.unit && st.figure.value !== "TBA" ? ` <span class="u">${esc(st.figure.unit)}</span>` : ""} <span class="k">${esc(st.figure.label)}</span></div>` : ""}</div></li>`,
    )
    .join("")}</ol>`;
}

// --------------------------------------------------------------------------------------- token block

const ago = (sec: number | null | undefined) => {
  if (!sec) return "TBA";
  const s = Math.max(0, Math.round(Date.now() / 1000 - sec));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
const explorer = (kind: "tx" | "address", v: string) => `https://explorer.solana.com/${kind}/${v}?cluster=devnet`;
const ext = (href: string, label: string, title = "") => `<a href="${esc(href)}" target="_blank" rel="noopener"${title ? ` title="${esc(title)}"` : ""}>${esc(label)}</a>`;

export function tokenHeadHtml(t: TokenDetail, tagline: string | null, tradeHref: string): string {
  const phase = t.phase === "graduated" ? "Graduated, DAMM v2" : t.migrated ? "Migrated, graduation pending" : "Bonding curve";
  const kv = (k: string, v: string, u = "") => `<div class="kv"><span class="k">${esc(k)}</span><b class="num">${esc(v)}</b>${u && v !== "TBA" ? `<span class="u">${esc(u)}</span>` : ""}</div>`;
  return `<header class="thead" part="header">
    <div class="tid"><span class="sym" part="ticker">${esc(t.symbol ?? shortAddr(t.mint))}</span><span class="name" part="name">${esc(t.name ?? "")}</span><span class="badge" data-phase="${esc(t.phase)}">${esc(phase)}</span></div>
    ${tagline ? `<p class="tag" part="description">${esc(tagline)}</p>` : ""}
    <div class="sub">${t.repo_url ? ext(t.repo_url, repoLabel(t.repo_url)) : ""}<span>launched ${esc(ago(t.created_at))}</span>${ext(explorer("address", t.mint), shortAddr(t.mint), t.mint)}</div>
    <div class="kvs">
      ${kv("Price", fmtPrice(t.price), QUOTE)}
      ${kv("Market cap", fmtAmount(t.market_cap), QUOTE)}
      ${kv("24h volume", fmtAmount(t.volume_24h), QUOTE)}
      ${kv("24h change", fmtChange(t.change_24h))}
      ${kv("Holders", fmtInt(t.holders))}
      ${kv("Compute vault", fmtAmount(t.compute_vault.balance), QUOTE)}
    </div>
    <div class="curve">${progressHtml(t.curve_progress)}<span class="faint">${t.phase === "graduated" ? `DAMM v2 pool ${esc(shortAddr(t.pools.damm_pool))}` : `${esc(fmtAmount(t.quote_reserve))} of ${esc(fmtAmount(t.migration_threshold))} ${QUOTE} to graduation`}</span><a class="btn" part="trade" href="${esc(tradeHref)}" target="_blank" rel="noopener">Trade on Lineage</a></div>
  </header>`;
}

export function tradesHtml(trades: Trade[]): string {
  if (!trades.length) return `<p class="none">No trades yet.</p>`;
  return `<table class="tbl" part="trades"><thead><tr><th>Time</th><th>Side</th><th class="r">Tokens</th><th class="r">${QUOTE}</th><th class="r hide-sm">Price</th><th class="hide-sm">Tx</th></tr></thead><tbody>${trades
    .map(
      (r) =>
        `<tr><td>${esc(ago(r.time))}</td><td class="${r.side === "buy" ? "up" : "down"}">${esc(r.side)}</td><td class="r num">${esc(fmtAmount(r.base_amount))}</td><td class="r num">${esc(fmtAmount(r.quote_amount))}</td><td class="r num hide-sm">${esc(fmtPrice(r.price))}</td><td class="hide-sm">${ext(explorer("tx", r.signature), shortAddr(r.signature), r.signature)}</td></tr>`,
    )
    .join("")}</tbody></table>`;
}

export function holdersHtml(h: Holders): string {
  if (!h.top.length) return `<p class="none">No holders outside the pool vaults yet.</p>`;
  return `<table class="tbl" part="holders"><thead><tr><th>Holder</th><th class="r">Tokens</th><th class="r">Share</th></tr></thead><tbody>${h.top
    .map((x) => `<tr><td>${ext(explorer("address", x.owner), shortAddr(x.owner), x.owner)}</td><td class="r num">${esc(fmtAmount(x.amount))}</td><td class="r num">${x.share == null ? "TBA" : esc(`${(x.share * 100).toFixed(2)}%`)}</td></tr>`)
    .join("")}</tbody></table>`;
}

export function feesHtml(f: { cranks: FeeCrank[]; totals_onchain: any }): string {
  const tot = f.totals_onchain ?? {};
  const head = `<p class="faint">On chain so far: ${esc(fmtAmount(tot.to_vault))} ${QUOTE} to the compute vault, ${esc(fmtAmount(tot.to_treasury))} ${QUOTE} to the treasury.</p>`;
  if (!f.cranks.length) return `${head}<p class="none">No fee cranks yet.</p>`;
  return `${head}<table class="tbl" part="fees"><thead><tr><th>Time</th><th>Pool</th><th class="r">To vault</th><th class="r hide-sm">To treasury</th><th class="hide-sm">Tx</th></tr></thead><tbody>${f.cranks
    .slice(0, 10)
    .map(
      (c) =>
        `<tr><td>${esc(ago(c.time))}</td><td>${c.source === "damm_v2" ? "DAMM v2" : "DBC"}</td><td class="r num">${esc(fmtAmount(c.to_vault))}</td><td class="r num hide-sm">${esc(fmtAmount(c.to_treasury))}</td><td class="hide-sm">${ext(explorer("tx", c.signature), shortAddr(c.signature), c.signature)}</td></tr>`,
    )
    .join("")}</tbody></table>`;
}
