// Fees waiting for the owners of a repository (owner 2026-10-13; docs/plans/GITHUB-FEE-CLAIMS.md 12):
// what sits unclaimed in a repository's escrow, which agents route to it, what was claimed so far and
// since when it has been waiting. A public view with no sign-in, read from Core
// (GET /v1/fee-claims/waiting), which reads it from chain. Three places show it: the list on the Claim
// page, a section on the repository's project page, and a page of its own for one repository
// (/claim/<owner>/<name>), the address that is shared. Every figure is Core's: dollars first (the
// amount at the quote coin's current price), the coin amount after it; with no dollar reading the
// dollars say so and the coin amount stays. Nothing is shown that Core did not serve.
//
// The Claim page's look lives here too (owner 2026-10-13, "a more seamless design"): the stat tiles,
// the board of repositories, "How this works" and the style sheet shared by the page shell
// (pages/claim.ts), the claim card the wallet bundle draws (wallet/claim.ts) and the page of one
// repository. The words are a maintainer's: the money is "held for the repository's owners" and
// admin is "checked with GitHub"; where it is held and by what is the plan's business.
import { getOptional } from "./api.ts";
import { ago, shortId, stamp, TOKEN } from "./fmt.ts";
import { html, type Raw } from "./html.ts";
import { REQUIREMENT_CSS } from "./requirement-explain.ts";
import { stat } from "./ui.ts";
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
const pct = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;
const sumBase = (xs: string[]) => xs.reduce((a, x) => a + BigInt(x), 0n).toString();
/** The share every listed agent gives, when it is one figure; null when they differ or none is listed. */
export function oneShare(w: Waiting | null): number | null {
  const all = (w?.repositories ?? []).flatMap((r) => r.agents.map((a) => a.bps)).filter((b) => Number.isFinite(b) && b > 0);
  return all.length && all.every((b) => b === all[0]) ? all[0]! : null;
}
/** The owner's picture as GitHub serves it, or the owner's first letter. */
export const repoAvatar = (r: { owner: { login: string; avatar_url: string | null } }, size = 28): Raw =>
  r.owner.avatar_url && /^https:\/\/avatars\.githubusercontent\.com\//.test(r.owner.avatar_url)
    ? html`<img class="cl-av" src="${r.owner.avatar_url}" alt="" width="${String(size)}" height="${String(size)}" loading="lazy" referrerpolicy="no-referrer">`
    : html`<span class="cl-av cl-av-l" style="width:${String(size)}px;height:${String(size)}px" aria-hidden="true">${(r.owner.login[0] ?? "?").toUpperCase()}</span>`;

/** The facts under the headline: who shares, what was claimed, since when it waits. Only what Core served. */
function facts(r: WaitingRepo, d: number | null): Raw {
  const parts: (Raw | string)[] = [];
  if (r.agents.length) parts.push(html`From ${agentsText(r.agents.length)}: ${r.agents.slice(0, 6).map((a, i) => html`${i ? ", " : ""}<a class="link" href="/agents/${a.agent}/profile">${shortId(a.agent)}</a>`)}${r.agents.length > 6 ? ` and ${r.agents.length - 6} more` : ""}`);
  parts.push(BigInt(r.claimed) > 0n ? html`${money(r.claimed_usd, r.claimed, d)} claimed so far` : "nothing claimed so far");
  if (has(r) && r.waiting_since) parts.push(html`waiting since ${since(r.waiting_since)}`);
  return html`${parts.map((p, i) => html`${i ? html` <span class="faint">·</span> ` : ""}${p}`)}`;
}

/** The section on a repository's project page; nothing when no agent shares fees with the repository. */
export function waitingSection(w: Waiting | null, name: string): Raw {
  const r = w?.repositories.find((x) => x.repository.full_name.toLowerCase() === name.toLowerCase()) ?? null;
  if (!w || !r) return html``;
  const d = coinDecimals(w);
  const full = r.repository.full_name;
  return html`<section class="fw-sec" id="fees-waiting" data-fees-waiting="${r.github_id}" data-waiting="${r.waiting}">
    <div class="fw-row">
      <div class="fw-main"><div class="eyebrow">Fees for the repository's owners</div>${has(r)
        ? html`<p class="fw-line"><b>${money(r.waiting_usd, r.waiting, d)}</b> is waiting for the owners of ${full}. Anyone with admin on the repository can claim it.</p>`
        : html`<p class="fw-line">Nothing is waiting for the owners of ${full} right now. ${r.agents.length ? `${agentsText(r.agents.length)} share${r.agents.length === 1 ? "s" : ""} fees with it; what arrives can be claimed by anyone with admin on the repository.` : "No agent shares fees with it now."}</p>`}
        <p class="fw-facts sub">${facts(r, d)}</p>
        ${w.usd ? "" : html`<p class="fw-facts sub" data-usd-why>No US dollar price: ${w.usd_reason ?? "none is served"}</p>`}</div>
      <div class="fw-act"><a class="wl-btn${has(r) ? " primary" : ""}" href="${claimHref(full)}" data-fees-claim>${has(r) && r.waiting_usd !== null ? `Claim ${fmtUsd(r.waiting_usd)}` : "Claim"}</a><a class="link" href="${shareHref(full)}" data-fees-share>Link to share</a></div>
    </div></section>`;
}

/** The four tiles at the top of the Claim page, from the list Core served; nothing where it served none. */
export function waitingStats(w: Waiting | null): Raw {
  if (!w) return html``;
  const d = coinDecimals(w);
  const rows = w.repositories;
  const claimed = sumBase(rows.map((r) => r.claimed));
  const claimedUsd = w.usd ? rows.reduce((s, r) => s + (r.claimed_usd ?? 0), 0) : null;
  const waitingN = rows.filter(has).length;
  const agents = rows.reduce((n, r) => n + r.agents.length, 0);
  const share = oneShare(w);
  const why = w.usd ? undefined : `No US dollar price: ${w.usd_reason ?? "none is served"}`;
  return html`<div class="cl-top"><div class="stats" style="--n:4" data-claim-stats>
    ${stat("Waiting now", html`<span data-usd="${w.total_waiting_usd === null ? "" : String(w.total_waiting_usd)}">${fmtUsd(w.total_waiting_usd)}</span>`, coins(w.total_waiting, d) || why || "")}
    ${stat("Claimed so far", fmtUsd(claimedUsd), coins(claimed, d) ? `${coins(claimed, d)}, at today's price` : why || "")}
    ${stat("Repositories receiving fees", String(rows.length), rows.length ? `${waitingN} with fees waiting` : "none yet")}
    ${stat("Agents sharing fees", String(agents), agents && share !== null ? `${pct(share)} of their fees each` : agents ? "with a repository's owners" : "none yet")}
  </div></div>`;
}

/** The board on the Claim page, largest first (Core's order): one row a repository with something waiting. */
export function waitingList(w: Waiting | null): Raw {
  if (!w) return html``;
  const d = coinDecimals(w);
  const rows = w.repositories.filter(has);
  const quiet = w.repositories.length - rows.length;
  return html`<section class="cl-sec fw-list" data-fees-list="${String(rows.length)}">
    <div class="cl-sec-h"><h2>Repositories with fees waiting</h2>${rows.length ? html`<span class="cl-count num">${String(rows.length)}</span>` : ""}</div>
    ${rows.length
      ? html`<ul class="fw-ul">${rows.map((r) => html`<li class="fw-li" data-fees-repo="${r.repository.full_name}" data-waiting="${r.waiting}">
          <span class="fw-id">${repoAvatar(r.repository)}<span class="min0"><a class="fw-name" href="${projectHref(r.repository.full_name)}">${r.repository.full_name}</a>
            <span class="fw-meta">${agentsText(r.agents.length)}${r.waiting_since ? html`, waiting since ${since(r.waiting_since)}` : ""}</span></span></span>
          <span class="fw-amt"><b>${money(r.waiting_usd, r.waiting, d)}</b></span>
          <span class="fw-go"><a class="link" href="${shareHref(r.repository.full_name)}">Details</a><a class="wl-btn fw-claim" href="${claimHref(r.repository.full_name)}" data-fees-claim>Claim</a></span></li>`)}</ul>`
      : html`<div class="cl-empty" data-fees-empty><p>No repository has fees waiting right now.</p>
          <p class="sub">${w.repositories.length
            ? `${agentsText(w.repositories.reduce((n, r) => n + r.agents.length, 0))} ${w.repositories.reduce((n, r) => n + r.agents.length, 0) === 1 ? "shares" : "share"} fees with ${w.repositories.length === 1 ? "a repository" : `${w.repositories.length} repositories`}; nothing has arrived yet, or all of it was claimed.`
            : html`This fills when an agent earns fees for a repository. <a class="link" href="/launch">Launch an agent with fees shared to its repository's owners</a>.`}</p></div>`}
    ${rows.length && quiet || !w.usd ? html`<div class="cl-sec-f">${rows.length && quiet ? `${quiet} more ${quiet === 1 ? "receives" : "receive"} fees and ${quiet === 1 ? "has" : "have"} nothing waiting. ` : ""}${w.usd ? "" : `No US dollar price: ${w.usd_reason ?? "none is served"}.`}</div>` : ""}
  </section>`;
}

let howSeq = 0;
/**
 * "Good to know" and the longer "How this works" (the bounty explanation's toggle: requirement-explain.ts draws
 * the same button and panel, and its one click handler opens this one). Each sentence states what the code does:
 * `scope` is the sign-in's scope as Core serves it ("" asks GitHub for no access; null when Core named none or
 * offers no sign-in), `share` the one share agents give when it is one figure.
 */
export function claimHow(o: { scope?: string | null; share?: number | null; repo?: string | null } = {}): Raw {
  const id = `cl-how-${++howSeq}`;
  const noAccess = o.scope === "";
  const whose = o.repo ? `${o.repo}` : "the repository";
  return html`<section class="cl-how" data-claim-how><h2>Good to know</h2>
    <ul class="cl-facts">
      ${noAccess ? html`<li>The GitHub sign-in asks for no access to your code.</li>` : ""}
      <li>No GitHub token is kept.</li>
      <li>Only someone with admin on ${whose} can claim.</li>
      <li>units takes nothing from a claim.</li>
    </ul>
    <div class="rq" data-rq><button type="button" class="rq-btn" aria-expanded="false" aria-controls="${id}" data-rq-toggle>How this works</button>
      <div class="rq-panel" id="${id}" role="region" aria-label="How claiming works" hidden>
        <p data-how="source"><b>Where the money comes from.</b> Whoever launches an agent on units can choose to share ${o.share ? `${pct(o.share)} of the agent's fees` : "part of the agent's fees"} with the owners of the repository it works on. That share is held for the repository's owners until one of them claims it.</p>
        <p data-how="who"><b>Who can claim.</b> Anyone GitHub says has admin on the repository: the owner of a personal repository, the admins of an organisation's.</p>
        <p data-how="proof"><b>What proving it involves.</b> You sign in with GitHub, and the site asks GitHub who you are and whether you have admin on the repositories that receive fees. ${noAccess ? "The sign-in asks for no access to your code, and the " : "The "}answer is used once: no token is kept. Then your wallet signs one short message saying that your GitHub account claims with it, which is free and moves nothing.</p>
        <p data-how="cost"><b>What it costs.</b> A claim is one transaction that pays everything waiting to your wallet in ${TOKEN}. You pay the network fee and, the first time, the small deposit Solana asks for to open the wallet's ${TOKEN} account.</p>
        <p data-how="team"><b>Several admins.</b> Any one admin can claim all of it, first come. The wallet of the first claim becomes the repository's wallet, and moving to another one later takes a waiting period, so a team should agree on one wallet before anyone claims.</p>
        <p data-how="later"><b>No deadline.</b> Fees that arrive after a claim wait for the next one. The money follows the repository itself, so renaming or transferring it changes nothing.</p>
      </div></div></section>`;
}

/** The body of the page for one repository (/claim/<owner>/<name>): the same facts with the empty states said plainly. */
export function waitingRepoBody(w: Waiting | null, name: string, o: { scope?: string | null } = {}): Raw {
  const r = w?.repositories.find((x) => x.repository.full_name.toLowerCase() === name.toLowerCase()) ?? null;
  const d = coinDecimals(w);
  const full = r?.repository.full_name ?? name;
  const gh = html`<a class="link" href="https://github.com/${full}" target="_blank" rel="noopener">${full}</a>`;
  const head = (h: Raw | string, sub: Raw | string) => html`<div class="ph-row"><div class="ph-title"><div class="crumbs"><a href="/claim">Claim</a><span>${full}</span></div><h1 class="cl-h1" data-fees-h>${h}</h1><div class="ph-sub"><span>${sub}</span></div></div></div>`;
  const page = (state: string, attrs: Raw, h: Raw, main: Raw, side: Raw) => html`<div class="fw-page cl-page" data-fees-page="${state}"${attrs}>${h}<div class="cl-cols"><div class="cl-main">${main}</div><aside class="cl-side">${side}</aside></div></div>`;
  const how = claimHow({ scope: o.scope ?? null, share: r && r.agents.length && r.agents.every((a) => a.bps === r.agents[0]!.bps) ? r.agents[0]!.bps : null, repo: full });
  if (!w) return html`<div class="fw-page cl-page" data-fees-page="off">${head(`Fees for the owners of ${full}`, html`Fee claims are not served here, so there is nothing to read for ${gh}.`)}</div>`;
  if (!r) return page("none", html``, head(`No fees are shared with ${full}`, html`No agent shares its fees with the owners of ${gh}. When one does, that share is held for them and shows here.`),
    html`<section class="cl-sec"><div class="cl-empty"><p>Nothing to claim for ${full}.</p><p class="sub">That changes when someone launches an agent on it and shares its fees with the owners.</p>
      <div class="wl-row"><a class="wl-btn primary" href="/launch?repo=${encodeURIComponent(full)}">Launch an agent on it</a><a class="wl-btn" href="/claim">The Claim page</a></div></div></section>`, how);
  const label = has(r) && r.waiting_usd !== null ? `Claim ${fmtUsd(r.waiting_usd)}` : "Claim";
  return page(has(r) ? "waiting" : "empty", html` data-waiting="${r.waiting}"`,
    has(r)
      ? head(html`${fmtUsd(r.waiting_usd)} is waiting for the owners of ${full}`, html`Fees from agents working on ${gh}. Anyone with admin on the repository can claim them.`)
      : head(`Nothing is waiting for the owners of ${full}`, html`${r.agents.length ? `${agentsText(r.agents.length)} share${r.agents.length === 1 ? "s" : ""} fees with` : "No agent shares fees with"} ${gh} now. What arrives can be claimed by anyone with admin on the repository.`),
    html`<section class="cl-sec"><div class="cl-figs">
      <div><span>Waiting</span><b>${money(r.waiting_usd, r.waiting, d)}</b>${has(r) && r.waiting_since ? html`<i>since ${since(r.waiting_since)}</i>` : ""}</div>
      <div><span>Claimed so far</span><b>${BigInt(r.claimed) > 0n ? money(r.claimed_usd, r.claimed, d) : "nothing yet"}</b></div>
      <div><span>Agents sharing fees</span><b>${String(r.agents.length)}</b>${r.routed_since ? html`<i>the first since ${since(r.routed_since)}</i>` : ""}</div>
    </div>
    ${r.agents.length ? html`<ul class="fw-ul">${r.agents.map((a) => html`<li class="fw-li fw-li-a"><a class="fw-name" href="/agents/${a.agent}/profile" title="${a.agent}">${shortId(a.agent)}</a>
      <span class="fw-meta">${pct(a.bps)} of its fees, shared since ${since(a.set_at)}</span></li>`)}</ul>` : ""}
    ${w.usd ? "" : html`<div class="cl-sec-f">No US dollar price: ${w.usd_reason ?? "none is served"}.</div>`}</section>`,
    html`<section class="cl-how cl-cta"><h2>${has(r) ? "Have admin on this repository?" : "For the repository's owners"}</h2>
      <p>${has(r) ? "Sign in with GitHub, connect a wallet and claim. It takes a minute." : "When fees arrive, anyone with admin on the repository claims them with a GitHub sign-in and a wallet."}</p>
      <div class="wl-row"><a class="wl-btn primary" href="${claimHref(full)}" data-fees-claim>${label}</a><a class="link" href="${projectHref(full)}">The project page</a></div></section>${how}`);
}

export const WAITING_CSS = `
.cl-page{display:grid;gap:20px;max-width:calc(1440px - 2 * var(--pad-x));margin-left:auto;margin-right:auto;min-width:0}
.cl-page>.ph-row{margin-bottom:8px;align-items:flex-end}
.cl-page>.ph-row>.ph-title{flex:1 1 420px}
.cl-h1{font-size:clamp(30px,3.6vw,48px) !important;line-height:1.05;letter-spacing:-.035em;max-width:22ch}
.cl-search{display:grid;gap:6px;flex:0 1 360px;min-width:min(100%,260px);padding-bottom:4px}
.cl-search-row{display:flex;gap:8px;min-width:0}
.cl-search input{flex:1 1 auto;min-width:0;width:100%;height:40px;padding:0 14px;border:1px solid var(--border-h);border-radius:16px;corner-shape:squircle;background:var(--bg2);color:var(--tp);font:400 15px/1 var(--sans);letter-spacing:-.01em}
.cl-search input:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.cl-search .wl-btn{height:40px;flex:none}
.cl-top{border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
.cl-cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,380px);gap:24px;align-items:start}
.cl-main,.cl-side{display:grid;gap:16px;min-width:0}
.cl-slot:empty{display:none}
.cl-av{flex:none;border-radius:8px;background:var(--bg3);object-fit:cover}
.cl-av-l{display:inline-grid;place-items:center;font:500 12px/1 var(--sans);color:var(--ts)}
.cl-card,.cl-sec,.cl-how,.cl-result{border:1px solid var(--border);border-radius:var(--radius);background:var(--bg2);min-width:0;overflow:hidden}
.cl-card-h{display:flex;justify-content:space-between;align-items:flex-start;gap:12px 24px;flex-wrap:wrap;padding:20px 20px 0}
.cl-card-h h2{margin:0;font-family:var(--display);font-size:24px;font-weight:500;letter-spacing:-.03em;line-height:1.15;color:var(--tp)}
.cl-steps{display:flex;align-items:center;gap:8px;list-style:none;margin:5px 0 0;padding:0;font-size:12.5px}
.cl-steps li{display:inline-flex;align-items:center;gap:6px;color:var(--tt);white-space:nowrap}
.cl-steps li+li::before{content:"";width:16px;height:1px;background:var(--border-h);margin-right:2px}
.cl-dot{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;box-shadow:inset 0 0 0 1px var(--border-h);font:500 10.5px/1 var(--sans);font-variant-numeric:tabular-nums}
.cl-steps li[data-s="now"]{color:var(--tp);font-weight:500}
.cl-steps li[data-s="now"] .cl-dot{background:var(--tp);color:var(--bg);box-shadow:none}
.cl-steps li[data-s="done"]{color:var(--ts)}
.cl-steps li[data-s="done"] .cl-dot{background:var(--accent);color:var(--bg2);box-shadow:none}
.cl-steps svg{width:10px;height:10px}
.cl-card-b{display:grid;gap:12px;padding:10px 20px 20px}
.cl-lead{margin:0;font-size:15.5px;line-height:1.45;color:var(--ts);max-width:62ch;overflow-wrap:anywhere}
.cl-act{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;margin-top:4px}
.cl-act .wl-btn{height:44px;padding:0 20px;font-size:15px}
.cl-fine{margin:0;font-size:12.5px;line-height:1.5;color:var(--tt);max-width:70ch;overflow-wrap:anywhere}
.cl-linkbtn{border:0;background:none;padding:0;font:inherit;color:var(--tp);text-decoration:underline;text-decoration-color:var(--border-h);text-underline-offset:.18em;cursor:pointer}
.cl-linkbtn:hover{text-decoration-color:var(--tp)}
.cl-linkbtn:focus-visible,.cl-gist>summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
.cl-who{display:flex;flex-wrap:wrap;gap:6px 22px;align-items:center;padding:11px 20px;border-top:1px solid var(--border);background:var(--bg);font-size:13px;color:var(--ts)}
.cl-who b{font-weight:500;color:var(--tp)}
.cl-who>span{display:inline-flex;flex-wrap:wrap;gap:4px 8px;align-items:center;min-width:0}
.cl-who .cl-linkbtn{font-size:12.5px;color:var(--tt)}
.cl-status:empty{display:none}
.cl-msg{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:12px;border-left:3px solid var(--border-h);background:var(--bg);font-size:13.5px;line-height:1.45;color:var(--tp);overflow-wrap:anywhere}
.cl-msg.bad{border-left-color:var(--bad)}
.cl-msg.warn{border-left-color:var(--warn)}
.cl-msg p{margin:0}
.cl-msg p+p{margin-top:2px;color:var(--ts);font-size:12.5px}
.cl-rows{display:grid}
.cl-r{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:10px 20px;align-items:center;padding:14px 20px;border-top:1px solid var(--border);scroll-margin-top:90px}
.cl-r[data-focus]{box-shadow:inset 3px 0 0 var(--accent)}
.cl-r-id{display:flex;gap:10px;align-items:center;min-width:0}
.cl-r-name{display:block;font-family:var(--display);font-size:17px;font-weight:500;letter-spacing:-.02em;color:var(--tp);text-decoration:none;overflow-wrap:anywhere}
a.cl-r-name:hover{text-decoration:underline}
.cl-r-meta{display:block;margin-top:2px;font-size:12.5px;color:var(--tt)}
.cl-r-amt{display:grid;gap:1px;text-align:right;white-space:nowrap}
.cl-r-amt b{font-family:var(--display);font-size:20px;font-weight:500;letter-spacing:-.02em;font-variant-numeric:tabular-nums;color:var(--tp)}
.cl-r-amt b .num{font:inherit;letter-spacing:inherit}
.cl-r-amt i{font-style:normal;font-size:12px;color:var(--tt);font-variant-numeric:tabular-nums}
.cl-r[data-state="empty"] .cl-r-amt b,.cl-r[data-state="done"] .cl-r-amt b,.cl-r[data-state="loading"] .cl-r-amt b,.cl-r[data-state="error"] .cl-r-amt b{font-family:var(--sans);font-size:13px;font-weight:400;letter-spacing:0;color:var(--tt)}
.cl-r-x{grid-column:1 / -1;min-width:0}
.cl-r-x:empty{display:none}
.cl-from{font-size:12.5px;color:var(--tt)}
.cl-from>summary{cursor:pointer;display:inline}
.cl-from>summary::marker{content:""}
.cl-from>summary::-webkit-details-marker{display:none}
.cl-from>summary span{text-decoration:underline;text-decoration-color:var(--border-h);text-underline-offset:.18em}
.cl-from table{width:100%;margin:8px 0 0;border-collapse:collapse;font-size:12.5px}
.cl-from th{font-weight:500;color:var(--tt);text-align:left;padding:4px 0}
.cl-from td{padding:5px 0;border-top:1px solid var(--border);color:var(--ts)}
.cl-from .right{text-align:right}
.cl-prog{display:grid;gap:8px;padding:12px 14px;border-radius:12px;background:var(--bg)}
.cl-prog ol{display:flex;flex-wrap:wrap;gap:6px 18px;list-style:none;margin:0;padding:0;font-size:13.5px}
.cl-prog li{display:inline-flex;align-items:center;gap:8px;color:var(--tt)}
.cl-prog li[data-s="now"]{color:var(--tp);font-weight:500}
.cl-prog li[data-s="done"]{color:var(--ts)}
.cl-prog li[data-s="done"] .cl-dot{background:var(--accent);color:var(--bg2);box-shadow:none}
.cl-prog li[data-s="now"] .cl-dot{box-shadow:none;border:2px solid var(--border-h);border-top-color:var(--tp);animation:cl-spin .8s linear infinite}
.cl-prog svg{width:10px;height:10px}
.cl-prog p{margin:0;font-size:12.5px;color:var(--ts);line-height:1.45}
@keyframes cl-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.cl-prog li[data-s="now"] .cl-dot{animation:none}}
.cl-ok{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border-radius:12px;background:var(--bg)}
.cl-ok>svg{flex:none;width:18px;height:18px;margin-top:1px;color:var(--accent)}
.cl-ok p{margin:0;font-size:14px;color:var(--tp);line-height:1.45;overflow-wrap:anywhere}
.cl-ok p+p{margin-top:2px;font-size:12.5px;color:var(--ts)}
.cl-none{padding:0 20px 20px;display:grid;gap:8px}
.cl-none p{margin:0}
.cl-card-f{padding:12px 20px;border-top:1px solid var(--border);font-size:12.5px;color:var(--tt)}
.cl-gist>summary{cursor:pointer;display:inline;color:var(--ts);text-decoration:underline;text-decoration-color:var(--border-h);text-underline-offset:.18em}
.cl-gist>summary::marker{content:""}
.cl-gist>summary::-webkit-details-marker{display:none}
.cl-gist[open]>summary{color:var(--tp)}
.cl-gist-b{display:grid;gap:10px;margin-top:12px;max-width:560px}
.cl-gist-b p{margin:0;font-size:13px;line-height:1.5;color:var(--ts)}
.cl-gist-b label{display:grid;gap:5px;min-width:0}
.cl-gist-b input,.cl-gist-b textarea{width:100%;min-width:0;padding:9px 12px;border:1px solid var(--border-h);border-radius:12px;background:var(--bg);color:var(--tp);font:400 14px/1.45 var(--sans)}
.cl-gist-b textarea{resize:vertical;font-size:12.5px}
.cl-sec-h{display:flex;align-items:baseline;gap:10px;padding:13px 20px 12px;border-bottom:1px solid var(--border)}
.cl-sec-h h2,.cl-how h2{margin:0;font-family:var(--display);font-size:16px;font-weight:500;letter-spacing:-.02em;color:var(--tp)}
.cl-count{font-size:12.5px;color:var(--tt)}
.cl-sec-f{padding:10px 20px;border-top:1px solid var(--border);font-size:12px;color:var(--tt)}
.cl-empty{padding:18px 20px 20px;display:grid;gap:6px}
.cl-empty p{margin:0}
.cl-empty .wl-row{margin-top:8px}
.cl-figs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--border)}
.cl-figs>div{background:var(--bg2);padding:12px 20px 14px;min-width:0}
.cl-figs>div>span{display:block;font-size:11.5px;color:var(--tt)}
.cl-figs b{display:block;margin-top:4px;color:var(--tp);font-family:var(--display);font-size:19px;font-weight:500;letter-spacing:-.02em;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.cl-figs b .num{font:inherit;letter-spacing:inherit}
.cl-figs b .fw-coins{display:block;margin-top:2px;font-family:var(--sans);font-size:12px;font-weight:400;letter-spacing:0;color:var(--tt)}
.cl-figs i{display:block;margin-top:2px;font-style:normal;font-size:12px;color:var(--tt)}
.cl-figs+.fw-ul{border-top:1px solid var(--border)}
.cl-how{padding:16px 18px;display:grid;gap:10px}
.cl-how p{margin:0;font-size:13px;color:var(--ts);line-height:1.5}
.cl-facts{list-style:none;margin:0;padding:0;display:grid;gap:7px;font-size:13px;color:var(--ts);line-height:1.4}
.cl-facts li{display:flex;gap:8px;align-items:flex-start}
.cl-facts li::before{content:"";flex:none;width:6px;height:6px;margin-top:6px;border-radius:50%;background:var(--accent)}
.cl-how .rq-btn{margin-top:2px}
.cl-result{display:grid}
.cl-result-h{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;padding:14px 18px 12px}
.cl-result-h .cl-r-name{font-size:16px}
.cl-pill{flex:none;font-size:12px;color:var(--ts);border:1px solid var(--border);border-radius:9999px;padding:2px 10px;white-space:nowrap}
.cl-pill.on{color:var(--tp);border-color:var(--tp)}
.cl-result .cl-figs{grid-template-columns:repeat(2,minmax(0,1fr));border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
.cl-result .cl-figs>div{padding:10px 18px 12px}
.cl-result-b{display:grid;gap:10px;padding:12px 18px 16px;font-size:13px;color:var(--ts);line-height:1.45}
.cl-result-b p{margin:0;overflow-wrap:anywhere}
.cl-result-b .wl-row{gap:8px 14px}
.fw-sec{margin-top:16px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg2);overflow:hidden}
.fw-row{display:flex;gap:16px 24px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:16px 20px}
.fw-main{min-width:0;flex:1 1 320px}
.fw-line{margin:6px 0 0;font-size:16px;line-height:1.45;overflow-wrap:anywhere}
.fw-line b{font-weight:500}
.fw-facts{margin:6px 0 0;overflow-wrap:anywhere}
.fw-coins{font-size:.82em;font-weight:400}
.fw-act{display:flex;gap:14px;align-items:center;flex-wrap:wrap}
.fw-ul{list-style:none;margin:0;padding:0}
.fw-li{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr) auto;gap:6px 18px;align-items:center;padding:12px 20px;border-top:1px solid var(--border)}
.fw-li:first-child{border-top:0}
.fw-li-a{grid-template-columns:minmax(0,1fr) auto;align-items:baseline}
.fw-id{display:flex;gap:10px;align-items:center;min-width:0}
.fw-name{display:block;font-family:var(--display);font-size:16px;font-weight:500;letter-spacing:-.02em;color:var(--tp);text-decoration:none;overflow-wrap:anywhere}
.fw-name:hover{text-decoration:underline}
.fw-meta{display:block;margin-top:1px;font-size:12.5px;color:var(--tt)}
.fw-amt{text-align:right}
.fw-amt b{font-family:var(--display);font-size:18px;font-weight:500;letter-spacing:-.02em;font-variant-numeric:tabular-nums;white-space:nowrap}
.fw-amt b .num{font:inherit;letter-spacing:inherit}
.fw-amt b .fw-coins{display:block;margin-top:1px;font-family:var(--sans);font-size:12px;font-weight:400;letter-spacing:0;color:var(--tt)}
.fw-go{display:flex;gap:14px;align-items:center;justify-content:flex-end;font-size:13px}
.fw-claim{height:32px;padding:0 14px;font-size:13.5px;border-width:1px}
.fw-page .panel{margin:0}
@media (max-width:1100px){
  .cl-cols{grid-template-columns:minmax(0,1fr);gap:16px}
  .cl-main,.cl-side{display:contents}
  .cl-slot[data-cl-slot="result"]{order:1}
  .cl-slot[data-cl-slot="card"],.cl-cta{order:2}
  .cl-main>*{order:3}
  .cl-side>*{order:4}
  .cl-search{flex:1 1 100%}
}
@media (max-width:720px){
  .fw-li{grid-template-columns:minmax(0,1fr) auto}
  .fw-li .fw-go{grid-column:1 / -1;justify-content:flex-start}
  .fw-li-a{grid-template-columns:minmax(0,1fr)}
  .cl-figs{grid-template-columns:minmax(0,1fr)}
  .cl-result .cl-figs{grid-template-columns:repeat(2,minmax(0,1fr))}
  .cl-r{grid-template-columns:minmax(0,1fr) auto;padding:14px 16px}
  .cl-r>.wl-btn{grid-column:1 / -1;justify-content:center}
  .cl-card-h{padding:16px 16px 0}
  .cl-card-h h2{font-size:21px}
  .cl-card-b{padding:10px 16px 16px}
  .cl-who,.cl-card-f,.cl-sec-h,.cl-sec-f,.fw-li,.fw-row{padding-left:16px;padding-right:16px}
  .cl-none{padding:0 16px 16px}
  .cl-act .wl-btn{flex:1 1 100%;justify-content:center}
  .cl-top .stat .v{font-size:24px}
}
${REQUIREMENT_CSS}`;
export function injectWaitingStyle() {
  if (typeof document === "undefined" || document.getElementById("fw-style")) return;
  const s = document.createElement("style");
  s.id = "fw-style";
  s.textContent = WAITING_CSS;
  document.head.appendChild(s);
}
