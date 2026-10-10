import { avatarSvg, svgDataUri } from "../../../packages/embed/src/pattern.ts";
import { ago, repoLabel } from "./fmt.ts";
import { html, type Raw } from "./html.ts";
import { changeFig, fmtAmount, fmtChange, fmtPrice, QUOTE } from "./market.ts";

// What an agent token shows everywhere (docs/plans/APP-CONSOLIDATION.md, amendment 2026-10-10 (2)):
// price, market cap, 24 h volume, 24 h change, and what the agent is building: its repository, its
// live status ("working on <file> in <repo>" while a session runs, otherwise its last verified
// improvement) and a link to the session. Every figure is the market indexer's row as it is (which
// joins Core); amounts are in the quote token, never USD. Classes are prefixed bd- so a developer can
// restyle them in one place (app.css, "token parameters").

export interface Building {
  repo: string | null;
  live: boolean;
  session_id: string | null;
  file: string | null;
  last: { gen_id: string; lineage_id: string | null; metric: string | null; ratio: number | null; fixed: number | null; at: number | null } | null;
}

/** A token row of GET /market/tokens (the fields the app reads). */
export interface DirToken {
  mint: string;
  agent: string;
  launcher: string;
  name: string | null;
  symbol: string | null;
  phase: "curve" | "graduated";
  price: number | null;
  market_cap: number | null;
  volume_24h: number | null;
  change_24h: number | null;
  created_at: number;
  repo_url: string | null;
  state: "working" | "awake" | "asleep" | "graduated" | null;
  awake: boolean | null;
  class: string | null;
  lineage_id: string | null;
  session: { id: string; state: string; at: number | null } | null;
  agent_name?: string | null;
  tagline?: string | null;
  avatar?: string | null;
  building?: Building | null;
  hidden?: { reason: string; added_at: number | null } | null;
}

const TBA = html`<span class="bd-tba">TBA</span>`;
const num = (text: string, exact: number | null | undefined) => (text === "TBA" ? TBA : html`<span class="bd-num" title="${String(exact)} ${QUOTE}">${text}</span>`);

/** The four market figures as label/value cells (cards, rows, the token page). */
export function paramCells(t: Pick<DirToken, "price" | "market_cap" | "volume_24h" | "change_24h">, opts: { unit?: boolean } = {}): Raw {
  const u = opts.unit ? html`<span class="bd-unit">${QUOTE}</span>` : "";
  return html`<div class="bd-params">
    <div><span>Price</span><b>${num(fmtPrice(t.price), t.price)}${t.price != null ? u : ""}</b></div>
    <div><span>Market cap</span><b>${num(fmtAmount(t.market_cap), t.market_cap)}${t.market_cap != null ? u : ""}</b></div>
    <div><span>24h volume</span><b>${num(fmtAmount(t.volume_24h), t.volume_24h)}${t.volume_24h != null ? u : ""}</b></div>
    <div><span>24h change</span><b>${changeFig(t.change_24h)}</b></div>
  </div>`;
}

/** A verified improvement in words: "encode_ir -3.51%" or "fixed 2 failing tests". */
export function effectText(l: NonNullable<Building["last"]>): string {
  if (l.fixed != null) return `fixed ${l.fixed} failing test${l.fixed === 1 ? "" : "s"}`;
  if (l.ratio != null && Number.isFinite(l.ratio)) return `${l.metric ?? "metric"} ${fmtChange(l.ratio - 1)}`;
  return l.metric ?? "an improvement";
}

const fileName = (p: string) => p.split("/").pop() || p;

/** What the agent is building: the live line, or its last verified improvement, and the repository. */
export function buildingLine(t: Pick<DirToken, "repo_url" | "building" | "session">, opts: { link?: boolean; full?: boolean; sessionHref?: (id: string) => string } = {}): Raw {
  const b = t.building ?? null;
  const repo = b?.repo ?? t.repo_url;
  const repoText = repo ? repoLabel(repo) : null;
  const sid = b?.session_id ?? t.session?.id ?? null;
  let status: Raw;
  if (b?.live) {
    const f = b.file ? (opts.full ? b.file : fileName(b.file)) : null;
    status = html`<span class="bd-live"><i aria-hidden="true"></i>${f ? html`Working on <b title="${b.file ?? ""}">${f}</b>` : "Working"}${repoText ? html` in <b>${repoText}</b>` : ""}</span>`;
  } else if (b?.last) {
    status = html`<span class="bd-last">Last improvement: <b>${effectText(b.last)}</b>${b.last.at ? html`, <time data-ago="${b.last.at}">${ago(b.last.at)}</time>` : ""}</span>`;
  } else if (b) {
    status = html`<span class="bd-last bd-none">No verified improvement yet</span>`;
  } else {
    status = html`<span class="bd-last bd-none">Not in Core yet</span>`;
  }
  const link = opts.link !== false && sid ? html`<a class="bd-sess" href="${(opts.sessionHref ?? ((id: string) => `/sessions/${id}`))(sid)}">${b?.live ? "Watch live" : "Latest session"}</a>` : "";
  return html`<div class="bd-building${b?.live ? " on" : ""}">
    ${status}
    <div class="bd-repo">${repoText ? html`<span title="${repo ?? ""}">${repoText}</span>` : html`<span class="bd-tba">repository TBA</span>`}${link}</div>
  </div>`;
}

/** The agent's face: the launcher's avatar, else the pattern generated from its id. */
export function agentAvatar(agent: string, url: string | null | undefined, size = 32, cls = ""): Raw {
  const src = url ? `/api${url.replace(/^\/v1/, "")}` : svgDataUri(avatarSvg(agent, 64));
  return html`<img class="av ${cls}" src="${src}" width="${size}" height="${size}" alt="" loading="lazy" decoding="async">`;
}

/** A wallet's identicon (the same generated pattern, from the address). */
export const identicon = (address: string) => svgDataUri(avatarSvg(address, 64));

export const agentTitle = (t: Pick<DirToken, "agent_name" | "name" | "mint">) => t.agent_name ?? (t.name ? t.name.replace(/^TEST /, "") : t.mint.slice(0, 6));

/** The hidden list (GET /api/hidden), cached for a minute: Core-backed views drop these agents and mints. */
let hiddenCache: { at: number; mints: Set<string>; agents: Set<string> } | null = null;
export async function loadHidden(): Promise<{ mints: Set<string>; agents: Set<string> }> {
  if (hiddenCache && Date.now() - hiddenCache.at < 60_000) return hiddenCache;
  const r = await fetch("/api/hidden", { headers: { accept: "application/json" } }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
  const rows: { mint: string; agent: string | null }[] = Array.isArray(r?.hidden) ? r.hidden : [];
  hiddenCache = { at: Date.now(), mints: new Set(rows.map((x) => x.mint)), agents: new Set(rows.map((x) => x.agent).filter((x): x is string => !!x)) };
  return hiddenCache;
}

/** The note a hidden token's or agent's own page carries. */
export const hiddenNote = (h: { reason: string } | null | undefined) =>
  h ? html`<div class="bd-hidden" role="note"><b>Hidden from listings</b><span>${h.reason}. This page still resolves by direct link; it is left out of the Explorer, Agents and search.</span></div>` : "";

// ------------------------------------------------------------------------------------------------
// styles: injected once (the app and the embed kit's explorer share them), on the app's colour tokens

const CSS = `
.bd-params{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.bd-params>div{display:flex;flex-direction:column;gap:3px;min-width:0}
.bd-params>div>span{font:500 12px/1.3 var(--sans);letter-spacing:-.01em;color:var(--tt)}
.bd-params b{font-family:var(--display);font-size:15px;letter-spacing:-.02em;font-weight:500;color:var(--tp);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bd-num{font-variant-numeric:tabular-nums}
.bd-unit{margin-left:4px;font-size:11px;font-weight:400;color:var(--tt)}
.bd-tba{color:var(--tt);font-weight:400}
.bd-building{display:flex;flex-direction:column;gap:6px;min-width:0;font-size:12.5px;line-height:1.45;color:var(--ts)}
.bd-building b{font-weight:500;color:var(--tp)}
.bd-live,.bd-last{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bd-live{color:var(--ac-soft)}
.bd-live b{color:var(--tp)}
.bd-live i{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--ac);margin-right:7px;vertical-align:1px;animation:bd-pulse 1.4s ease-in-out infinite}
.bd-none{color:var(--tt)}
.bd-repo{display:flex;justify-content:space-between;align-items:baseline;gap:10px;min-width:0;color:var(--tt)}
.bd-repo>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bd-sess{flex:none;color:var(--ac);text-decoration:none;font-weight:500}
.bd-sess:hover{text-decoration:underline}
.bd-hidden{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline;padding:10px 14px;margin:0 0 16px;border:1px solid var(--border);border-left:2px solid var(--warn,#d29922);border-radius:8px;background:var(--bg2);font-size:13px;color:var(--ts)}
.bd-hidden b{font-weight:500;color:var(--tp)}
@keyframes bd-pulse{50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.bd-live i{animation:none}}
@media (max-width:420px){.bd-params{grid-template-columns:repeat(2,minmax(0,1fr));row-gap:10px}}
:root[data-theme="light"] .bd-live{color:var(--ac)}
`;

/** The same styles for a shadow root (the embed kit's elements map the app's tokens onto theirs). */
export const BUILDING_CSS = CSS;

export function injectBuildingStyle() {
  if (typeof document === "undefined" || document.getElementById("bd-style")) return;
  const s = document.createElement("style");
  s.id = "bd-style";
  s.textContent = CSS;
  document.head.appendChild(s);
}
