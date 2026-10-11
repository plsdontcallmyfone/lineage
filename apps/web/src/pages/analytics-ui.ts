import { html, type Raw } from "../html.ts";
import { badge } from "../ui.ts";
import { agentLabel } from "./insights-ui.ts";
import { VIZ_CSS } from "./analytics-charts.ts";

// Small shared pieces of the Analytics sections (analytics-*.ts): the section frame with its heading,
// the sticky section nav, agent links and the page's own `an-` styles on the app's tokens. Each
// section module is a pure function of its Core route's answer, so it can be restyled or moved alone.

export const SECTIONS: [string, string][] = [
  ["an-network", "Network"],
  ["an-work", "Agent work"],
  ["an-results", "Results"],
  ["an-costs", "Cost"],
  ["an-models", "Models"],
  ["an-verification", "Verification"],
  ["an-market-sec", "Market"],
  ["an-social", "Social and GitHub"],
  ["an-launches", "Launches and funding"],
];

export function sectionNav(): Raw {
  return html`<nav class="an-nav" aria-label="Analytics sections"><div class="an-nav-in">${SECTIONS.map(([id, l]) => html`<a href="#${id}" data-an-nav="${id}">${l}</a>`)}</div></nav>`;
}

export function section(id: string, title: string, lead: Raw | string, body: Raw): Raw {
  return html`<section class="an-sec" id="${id}" aria-labelledby="${id}-h"><div class="an-head"><h2 class="an-h" id="${id}-h">${title}</h2>${lead ? html`<p class="an-lead">${lead}</p>` : ""}</div>${body}</section>`;
}

export const agentLink = (agent: string | null | undefined, name: string | null | undefined): Raw =>
  agent ? html`<a class="link" href="/agents/${agent}/profile">${agentLabel(agent, name)}</a>` : html`<span class="faint">withheld</span>`;

export const projectLink = (key: string | null | undefined): Raw => (key ? html`<a class="link" href="/projects/${key}">${key}</a>` : html`<span class="faint">TBA</span>`);

export const levelBadge = (l: string | null | undefined): Raw => badge(l ?? "TBA", l === "ok" ? "good" : l === "warn" ? "warn" : l === "fail" ? "bad" : "");

export const shortSha = (s: string | null | undefined) => (s ? s.slice(0, 7) : "TBA");

/** A plain table: header cells (a leading "." right-aligns, a trailing "~" hides it on phones) and rows of cells. */
export function table(head: string[], rows: (Raw | string)[][], cls = ""): Raw {
  const h = head.map((x) => ({ right: x.startsWith("."), hide: x.endsWith("~"), label: x.replace(/^\./, "").replace(/~$/, "") }));
  const c = (k: number) => `${h[k]?.right ? "right num" : ""}${h[k]?.hide ? " hide-sm" : ""}`.trim();
  return html`<div class="tw"><table class="t ${cls}"><thead><tr>${h.map((x, k) => html`<th class="${c(k)}">${x.label}</th>`)}</tr></thead><tbody>${rows.map((r) => html`<tr>${r.map((v, k) => html`<td class="${c(k)}">${v}</td>`)}</tr>`)}</tbody></table></div>`;
}

export const AN_CSS = `
.an-page{scroll-padding-top:calc(var(--hdr-h) + 60px)}
.an-sec{display:grid;grid-template-columns:minmax(0,1fr);gap:20px;scroll-margin-top:calc(var(--hdr-h) + 64px)}
.an-sec>*{min-width:0}
.an-sec>.panel+.panel{margin-top:0}
.an-head{display:grid;gap:4px;margin-top:12px}
.an-h{font-family:var(--display);font-weight:500;font-size:28px;letter-spacing:-.03em}
.an-lead{color:var(--tt);font-size:13px;line-height:1.45;max-width:760px}
.an-nav{position:sticky;top:calc(var(--hdr-h) + 4px);z-index:20;min-width:0}
.an-nav-in{display:flex;gap:4px;overflow-x:auto;scrollbar-width:none;padding:4px;background:color-mix(in srgb,var(--bg2) 92%,transparent);border-radius:16px;corner-shape:squircle;box-shadow:0 0 0 .5px var(--border),0 8px 24px -16px #1a1a1933;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.an-nav-in::-webkit-scrollbar{display:none}
.an-nav a{flex:none;padding:6px 12px;border-radius:12px;corner-shape:squircle;color:var(--tt);font:500 13px/1.3 var(--sans);letter-spacing:-.01em;text-decoration:none;white-space:nowrap}
.an-nav a:hover{color:var(--tp)}
.an-nav a[aria-current="true"]{background:var(--tp);color:var(--bg)}
.an-rel{list-style:none;margin:0;padding:10px 16px;display:grid;gap:6px;font-size:13px}
.an-rel li{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center}
.an-rel .sub{color:var(--tt);font-size:12px}
.an-sub{color:var(--tt);font-size:12px}
.an-cap{padding:12px 16px 0;font:500 13px/1.3 var(--sans);color:var(--tp)}
.an-cap span{color:var(--tt);font-weight:400}
.an-pair{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1px;background:var(--border)}
.an-pair>div{background:var(--bg2);min-width:0}
.an-pairs{display:grid;grid-template-columns:minmax(0,1fr)}
.an-pairs>*{min-width:0}
.an-pairs h3{font:500 13px/1.3 var(--sans);padding:14px 16px 0;display:flex;gap:4px 8px;flex-wrap:wrap;align-items:baseline}
.an-pairs h3:not(:first-child){border-top:1px solid var(--line-soft);margin-top:6px}
.an-pairs h3 span{color:var(--tt);font-weight:400}
.an-more summary{padding:10px 16px;cursor:pointer;color:var(--tt);font-size:13px}
.an-chips{display:flex;flex-wrap:wrap;gap:6px;padding:12px 16px}
@media (max-width:760px){.an-pair{grid-template-columns:minmax(0,1fr)}.an-h{font-size:24px}}
${VIZ_CSS}`;

export { agentLabel };
