// Fees waiting for the owners of a repository (owner 2026-10-13; docs/plans/GITHUB-FEE-CLAIMS.md 12):
// what sits unclaimed in a repository's escrow, which agents route to it, what was claimed so far and
// since when it has been waiting. A public view with no sign-in, read from Core
// (GET /v1/fee-claims/waiting), which reads it from chain. Three places show it: the list on the Claim
// page, a section on the repository's project page, and a page of its own for one repository
// (/claim/<owner>/<name>), the address that is shared. Every figure is Core's: dollars first (the
// amount at the quote coin's current price), the coin amount after it; with no dollar reading the
// dollars say so and the coin amount stays. Nothing is shown that Core did not serve.
import { getOptional } from "./api.ts";
import { ago, shortId, stamp, TOKEN } from "./fmt.ts";
import { html, type Raw } from "./html.ts";
import { fmtUsd } from "./usd.ts";

export interface WaitingRepo {
  github_id: string;
  repository: { id: string; full_name: string; html_url: string; owner: { login: string; type: string; avatar_url: string | null } };
  waiting: string;
  waiting_usd: number | null;
  claimed: string;
  claimed_usd: number | null;
  routed_total: string;
  agents: { agent: string; bps: number; routed_total: string; set_at: number }[];
  routed_since: number | null;
  waiting_since: number | null;
}
export interface Waiting {
  repositories: WaitingRepo[];
  total_waiting: string;
  total_waiting_usd: number | null;
  usd: { quote_usd: number; read_at: number; decimals: number } | null;
  usd_reason: string | null;
}

export const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const BASE = /^\d{1,30}$/;

/** Core's answer, checked: a list this page can show, or null (the feature is off here, Core is away, or the answer is not one). */
export function readWaiting(j: unknown): Waiting | null {
  const o = j as Partial<Waiting> | null;
  if (!o || typeof o !== "object" || !Array.isArray(o.repositories)) return null;
  const usdOk = (n: unknown): n is number | null => n === null || (typeof n === "number" && Number.isFinite(n) && n >= 0);
  const rows = o.repositories.filter((r): r is WaitingRepo =>
    !!r && typeof r === "object" && typeof r.repository?.full_name === "string" && REPO_NAME.test(r.repository.full_name) && BASE.test(String(r.waiting)) && BASE.test(String(r.claimed))
    && usdOk(r.waiting_usd) && usdOk(r.claimed_usd) && Array.isArray(r.agents));
  const decimals = o.usd && Number.isInteger(o.usd.decimals) ? o.usd.decimals : null;
  return { repositories: rows, total_waiting: BASE.test(String(o.total_waiting)) ? String(o.total_waiting) : "0", total_waiting_usd: usdOk(o.total_waiting_usd) ? o.total_waiting_usd : null,
    usd: o.usd && decimals !== null ? o.usd : null, usd_reason: typeof o.usd_reason === "string" ? o.usd_reason : null };
}

/** The list, or one repository's row when `repo` is given. Null where the feature is off or Core did not answer; never throws. */
export async function loadWaiting(repo?: string): Promise<Waiting | null> {
  try {
    return readWaiting(await getOptional(`fee-claims/waiting${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`));
  } catch {
    return null;
  }
}

const coinDecimals = (w: Waiting | null) => w?.usd?.decimals ?? null;
/** The coin amount: "1,234.5 $UNITS". Without the coin's decimals (no reading from the indexer) the amount cannot be written and is left out. */
export function coins(base: string, decimals: number | null): string {
  if (decimals === null) return "";
  const n = Number(BigInt(base)) / 10 ** decimals;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 0 : n >= 1 ? 2 : 6 })} ${TOKEN}`;
}
/** Dollars first, the coin amount after it in a quieter weight. */
export const money = (usd: number | null, base: string, decimals: number | null): Raw =>
  html`<span class="num" data-usd="${usd === null ? "" : String(usd)}">${fmtUsd(usd)}</span>${coins(base, decimals) ? html` <span class="fw-coins dim num" data-base="${base}">${coins(base, decimals)}</span>` : ""}`;

const since = (s: number | null): Raw | string => (s ? html`<time datetime="${new Date(s * 1000).toISOString()}" title="${stamp(s * 1000)}">${ago(s * 1000)}</time>` : "");
const agentsText = (n: number) => `${n} agent${n === 1 ? "" : "s"}`;
export const claimHref = (name: string) => `/claim?repo=${encodeURIComponent(name)}`;
export const shareHref = (name: string) => `/claim/${name}`;
const projectHref = (name: string) => `/projects/${name.toLowerCase()}#fees-waiting`;
const has = (r: WaitingRepo) => BigInt(r.waiting) > 0n;

/** The facts under the headline: who routes, what was claimed, since when it waits. Only what Core served. */
function facts(r: WaitingRepo, d: number | null): Raw {
  const parts: (Raw | string)[] = [];
  if (r.agents.length) parts.push(html`From ${agentsText(r.agents.length)}: ${r.agents.slice(0, 6).map((a, i) => html`${i ? ", " : ""}<a class="link" href="/agents/${a.agent}/profile">${shortId(a.agent)}</a>`)}${r.agents.length > 6 ? ` and ${r.agents.length - 6} more` : ""}`);
  parts.push(BigInt(r.claimed) > 0n ? html`${money(r.claimed_usd, r.claimed, d)} claimed so far` : "nothing claimed so far");
  if (has(r) && r.waiting_since) parts.push(html`waiting since ${since(r.waiting_since)}`);
  return html`${parts.map((p, i) => html`${i ? html` <span class="faint">·</span> ` : ""}${p}`)}`;
}

/** The section on a repository's project page; nothing when no agent routes fees to the repository. */
export function waitingSection(w: Waiting | null, name: string): Raw {
  const r = w?.repositories.find((x) => x.repository.full_name.toLowerCase() === name.toLowerCase()) ?? null;
  if (!w || !r) return html``;
  const d = coinDecimals(w);
  const full = r.repository.full_name;
  return html`<section class="panel fw-sec" id="fees-waiting" data-fees-waiting="${r.github_id}" data-waiting="${r.waiting}">
    <div class="panel-b fw-row">
      <div class="fw-main">${has(r)
        ? html`<p class="fw-line"><b>${money(r.waiting_usd, r.waiting, d)}</b> is waiting for the owners of ${full}. Anyone with admin on the repository can claim it.</p>`
        : html`<p class="fw-line">Nothing is waiting for the owners of ${full} right now. ${r.agents.length ? `${agentsText(r.agents.length)} route${r.agents.length === 1 ? "s" : ""} a share of fees to it; what arrives can be claimed by anyone with admin on the repository.` : "No agent routes fees to it now."}</p>`}
        <p class="fw-facts sub">${facts(r, d)}</p>
        ${w.usd ? "" : html`<p class="fw-facts sub" data-usd-why>No US dollar price: ${w.usd_reason ?? "none is served"}</p>`}</div>
      <div class="fw-act"><a class="wl-btn${has(r) ? " primary" : ""}" href="${claimHref(full)}" data-fees-claim>Claim</a><a class="link" href="${shareHref(full)}" data-fees-share>Link to share</a></div>
    </div></section>`;
}

/** The list on the Claim page, largest first (Core's order). */
export function waitingList(w: Waiting | null): Raw {
  if (!w) return html``;
  const d = coinDecimals(w);
  const rows = w.repositories.filter(has);
  const quiet = w.repositories.length - rows.length;
  return html`<section class="panel fw-list" data-fees-list="${String(rows.length)}">
    <div class="panel-h"><h2>Repositories with fees waiting</h2>${rows.length ? html`<span class="count">${String(rows.length)}</span>` : ""}</div>
    ${rows.length
      ? html`<ul class="fw-ul">${rows.map((r) => html`<li class="fw-li" data-fees-repo="${r.repository.full_name}" data-waiting="${r.waiting}">
          <a class="fw-name link" href="${projectHref(r.repository.full_name)}">${r.repository.full_name}</a>
          <span class="fw-amt"><b>${money(r.waiting_usd, r.waiting, d)}</b></span>
          <span class="fw-meta sub">${agentsText(r.agents.length)}${r.waiting_since ? html`, waiting since ${since(r.waiting_since)}` : ""}</span>
          <a class="link fw-go" href="${shareHref(r.repository.full_name)}">Open</a></li>`)}</ul>`
      : html`<div class="panel-b" data-fees-empty><p>No repository has fees waiting.</p><p class="sub" style="margin-top:6px">${w.repositories.length
          ? `${agentsText(w.repositories.reduce((n, r) => n + r.agents.length, 0))} route a share of fees to ${w.repositories.length === 1 ? "a repository" : `${w.repositories.length} repositories`}; nothing has arrived, or everything was claimed.`
          : "No agent routes fees to a repository yet. A launcher can route a share of an agent's fees to the owners of the repository it works on; it shows here as it arrives."}</p></div>`}
    <div class="panel-note">Read from chain by Core. ${rows.length && quiet ? `${quiet} more with a route and nothing waiting. ` : ""}Anyone with admin on a repository can claim its balance; the amounts are US dollars at the current price${w.usd ? "" : ` (no US dollar price: ${w.usd_reason ?? "none is served"})`}.</div>
  </section>`;
}

/** The body of the page for one repository (/claim/<owner>/<name>): the same facts with the empty states said plainly. */
export function waitingRepoBody(w: Waiting | null, name: string): Raw {
  const r = w?.repositories.find((x) => x.repository.full_name.toLowerCase() === name.toLowerCase()) ?? null;
  const d = coinDecimals(w);
  const full = r?.repository.full_name ?? name;
  const gh = html`<a class="link" href="https://github.com/${full}" target="_blank" rel="noopener">${full}</a>`;
  const head = (h: Raw | string, sub: Raw | string) => html`<div class="ph-row"><div class="ph-title"><div class="eyebrow"><a class="link" href="/claim">Claim</a></div><h1 data-fees-h>${h}</h1><div class="ph-sub"><span>${sub}</span></div></div></div>`;
  if (!w) return html`<div class="fw-page" data-fees-page="off">${head(`Fees for the owners of ${full}`, html`Fee claims are not served here, so there is nothing to read for ${gh}.`)}</div>`;
  if (!r) return html`<div class="fw-page" data-fees-page="none">${head(`No fees are routed to ${full}`, html`No agent routes a share of its fees to ${gh}. When one does, that share waits on chain for the repository's owners and shows here.`)}
    <div class="wl-row"><a class="wl-btn" href="/claim">The Claim page</a><a class="wl-btn" href="/launch?repo=${encodeURIComponent(full)}">Launch an agent on it</a></div></div>`;
  return html`<div class="fw-page" data-fees-page="${has(r) ? "waiting" : "empty"}" data-waiting="${r.waiting}">
    ${has(r)
      ? head(html`${fmtUsd(r.waiting_usd)} is waiting for the owners of ${full}`, html`Fees from agents working on ${gh}. Anyone with admin on the repository can claim them: sign in with GitHub, bind a wallet, claim.`)
      : head(`Nothing is waiting for the owners of ${full}`, html`${r.agents.length ? `${agentsText(r.agents.length)} route${r.agents.length === 1 ? "s" : ""} a share of fees to` : "No agent routes fees to"} ${gh} now. What arrives can be claimed by anyone with admin on the repository.`)}
    <section class="panel"><div class="fw-kv">
      <div><span class="eyebrow">Waiting</span><b>${money(r.waiting_usd, r.waiting, d)}</b>${has(r) && r.waiting_since ? html`<span class="sub">since ${since(r.waiting_since)}</span>` : ""}</div>
      <div><span class="eyebrow">Claimed so far</span><b>${BigInt(r.claimed) > 0n ? money(r.claimed_usd, r.claimed, d) : "nothing yet"}</b></div>
      <div><span class="eyebrow">Agents routing to it</span><b>${String(r.agents.length)}</b>${r.routed_since ? html`<span class="sub">first route ${since(r.routed_since)}</span>` : ""}</div>
    </div>
    ${r.agents.length ? html`<ul class="fw-ul">${r.agents.map((a) => html`<li class="fw-li"><a class="link fw-name" href="/agents/${a.agent}/profile">${shortId(a.agent)}</a>
      <span class="fw-meta sub">${Number((a.bps / 100).toFixed(2))}% of its fees, route set ${since(a.set_at)}</span></li>`)}</ul>` : ""}
    <div class="panel-note">Read from chain by Core${w.usd ? "; US dollars at the current price" : `. No US dollar price: ${w.usd_reason ?? "none is served"}`}. The escrow is keyed to the repository on GitHub, so a rename or a transfer changes nothing.</div></section>
    <div class="wl-row"><a class="wl-btn primary" href="${claimHref(full)}" data-fees-claim>Claim</a><a class="wl-btn" href="${projectHref(full)}">The project page</a></div></div>`;
}

export const WAITING_CSS = `
.fw-sec{margin-top:16px}
.fw-row{display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.fw-main{min-width:0;flex:1 1 320px}
.fw-line{margin:0;font-size:16px;line-height:1.45;overflow-wrap:anywhere}
.fw-facts{margin:6px 0 0;overflow-wrap:anywhere}
.fw-coins{font-size:.86em;font-weight:400}
.fw-act{display:flex;gap:14px;align-items:center;flex-wrap:wrap}
.fw-ul{list-style:none;margin:0;padding:0}
.fw-li{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr) minmax(0,1.2fr) auto;gap:6px 14px;align-items:baseline;padding:10px 14px;border-top:1px solid var(--border)}
.fw-li:first-child{border-top:0}
.fw-name{overflow-wrap:anywhere;font-weight:550}
.fw-page{max-width:calc(1440px - 2 * var(--pad-x));margin:0 auto;display:grid;gap:16px}
.fw-page .panel{margin:0}
.fw-kv{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0;border-bottom:1px solid var(--border)}
.fw-kv>div{display:grid;gap:4px;padding:14px;border-left:1px solid var(--border);min-width:0}
.fw-kv>div:first-child{border-left:0}
.fw-kv b{font-size:18px;font-weight:550;overflow-wrap:anywhere}
.fw-list{margin-top:16px}
@media (max-width:720px){
  .fw-li{grid-template-columns:minmax(0,1fr) auto}
  .fw-li .fw-meta{grid-column:1 / -1}
  .fw-kv{grid-template-columns:minmax(0,1fr)}
  .fw-kv>div{border-left:0;border-top:1px solid var(--border)}
  .fw-kv>div:first-child{border-top:0}
}
`;
export function injectWaitingStyle() {
  if (typeof document === "undefined" || document.getElementById("fw-style")) return;
  const s = document.createElement("style");
  s.id = "fw-style";
  s.textContent = WAITING_CSS;
  document.head.appendChild(s);
}
