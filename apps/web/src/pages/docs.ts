import { loadConfig } from "../api.ts";
import { esc, html, raw } from "../html.ts";
import { paramValue } from "./manual.ts";
import type { Page } from "./types.ts";
import overview from "../../../../docs/site/overview.md" with { type: "text" };
import howItWorks from "../../../../docs/site/how-it-works.md" with { type: "text" };
import launch from "../../../../docs/site/launch-an-agent.md" with { type: "text" };
import verification from "../../../../docs/site/verification.md" with { type: "text" };
import fees from "../../../../docs/site/fees-and-compute.md" with { type: "text" };
import graduation from "../../../../docs/site/graduation.md" with { type: "text" };
import souls from "../../../../docs/site/souls-and-identity.md" with { type: "text" };
import api from "../../../../docs/site/api-and-embed-kit.md" with { type: "text" };
import faq from "../../../../docs/site/faq.md" with { type: "text" };

// Docs (docs/plans/FRONTEND-EMBED.md, docs amendment): plain-language pages rendered from the
// markdown in docs/site/, bundled into the client. Written from docs/SPEC.md with no new claims and
// no invented numbers. Live figures appear only where a page names one:
//   {{cfg:<key>}}       a parameter from Core's GET /v1/config (formatted as the Manual does)
//   {{market:tokens}}   agent tokens the market indexer holds; {{market:graduated}} those graduated
// Anything that cannot be read now renders as TBA.

export const DOCS: { slug: string; title: string; md: string }[] = [
  { slug: "overview", title: "Overview", md: overview },
  { slug: "how-it-works", title: "How it works", md: howItWorks },
  { slug: "launch-an-agent", title: "Launch an agent", md: launch },
  { slug: "verification", title: "Verification", md: verification },
  { slug: "fees-and-compute", title: "Fees and compute", md: fees },
  { slug: "graduation", title: "Graduation", md: graduation },
  { slug: "souls-and-identity", title: "Souls and identity", md: souls },
  { slug: "api-and-embed-kit", title: "API and embed kit", md: api },
  { slug: "faq", title: "FAQ", md: faq },
];

// ------------------------------------------------------------------------------------------------
// a tiny markdown renderer: headings, paragraphs, lists, tables, block quotes, fenced blocks,
// links, bold, italics, inline code, and the live figure tags above

export type Live = (kind: string, key: string) => string | null;

const slug = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function inlineMd(s: string, live: Live): string {
  const codes: string[] = [];
  let t = s.replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(`<code class="dc-code">${esc(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  t = esc(t)
    .replace(/\{\{(cfg|market):([a-z0-9_]+)\}\}/g, (_, kind: string, key: string) => {
      const v = live(kind, key);
      return v === null
        ? `<span class="dc-live tba" title="${kind === "cfg" ? `Core config ${key}` : `market ${key}`}: not readable now">TBA</span>`
        : `<span class="dc-live" data-live="${kind}:${key}" title="${kind === "cfg" ? `live value of ${key} from GET /v1/config` : "live from the market indexer"}">${esc(v)}</span>`;
    })
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text: string, href: string) => {
      const ext = /^https?:\/\//.test(href);
      const safe = /^(https?:\/\/|\/|#)/.test(href) ? href : "#";
      return `<a class="dc-a" href="${safe}"${ext ? ` target="_blank" rel="noopener"` : ""}>${text}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<i>$2</i>");
  return t.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]!);
}

export function renderMarkdown(md: string, live: Live): { title: string; html: string; toc: { id: string; text: string }[] } {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  const toc: { id: string; text: string }[] = [];
  let title = "";
  let i = 0;
  const isBlockStart = (l: string) => /^(#{1,4} |\||```|>|\s*- |\s*\d+\. )/.test(l);
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.trim() === "" || l.trim() === "---") {
      i++;
      continue;
    }
    if (l.startsWith("```")) {
      const buf: string[] = [];
      for (i++; i < lines.length && !lines[i]!.startsWith("```"); i++) buf.push(lines[i]!);
      i++;
      out.push(`<pre class="dc-pre">${esc(buf.join("\n"))}</pre>`);
      continue;
    }
    const h = /^(#{1,4}) (.*)$/.exec(l);
    if (h) {
      const level = h[1]!.length;
      const text = inlineMd(h[2]!, live);
      if (level === 1) title = h[2]!;
      else {
        const id = slug(h[2]!);
        if (level === 2) toc.push({ id, text: h[2]! });
        out.push(`<h${level} id="${id}">${text}</h${level}>`);
      }
      i++;
      continue;
    }
    if (l.startsWith(">")) {
      const buf: string[] = [];
      for (; i < lines.length && lines[i]!.startsWith(">"); i++) buf.push(lines[i]!.replace(/^>\s?/, ""));
      out.push(`<div class="dc-callout">${inlineMd(buf.join(" "), live)}</div>`);
      continue;
    }
    if (l.startsWith("|")) {
      const rows: string[][] = [];
      for (; i < lines.length && lines[i]!.startsWith("|"); i++) {
        const cells = lines[i]!.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
        rows.push(cells);
      }
      const [head, ...body] = rows;
      out.push(`<div class="dc-tw"><table class="dc-t"><thead><tr>${(head ?? []).map((c) => `<th>${inlineMd(c, live)}</th>`).join("")}</tr></thead><tbody>${body
        .map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c, live)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    if (/^\s*(- |\d+\. )/.test(l)) {
      const ordered = /^\s*\d+\. /.test(l);
      const items: string[] = [];
      for (; i < lines.length && (/^\s*(- |\d+\. )/.test(lines[i]!) || /^\s{2,}\S/.test(lines[i]!)); i++) {
        const t = lines[i]!;
        if (/^\s*(- |\d+\. )/.test(t)) items.push(t.replace(/^\s*(- |\d+\. )/, ""));
        else items[items.length - 1] += " " + t.trim();
      }
      out.push(`<${ordered ? "ol" : "ul"} class="dc-list">${items.map((t) => `<li>${inlineMd(t, live)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    const para: string[] = [];
    for (; i < lines.length && lines[i]!.trim() !== "" && !isBlockStart(lines[i]!); i++) para.push(lines[i]!);
    out.push(`<p>${inlineMd(para.join(" "), live)}</p>`);
  }
  return { title, html: out.join("\n"), toc };
}

// ------------------------------------------------------------------------------------------------
// live figures

async function liveSource(md: string): Promise<Live> {
  const needCfg = /\{\{cfg:/.test(md);
  const needMarket = /\{\{market:/.test(md);
  const [cfg, tokens] = await Promise.all([
    needCfg ? loadConfig().catch(() => null) : null,
    needMarket
      ? fetch("/market/tokens", { headers: { accept: "application/json" } }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as Promise<{ tokens: { phase: string }[]; count: number } | null>
      : null,
  ]);
  return (kind, key) => {
    if (kind === "cfg") {
      if (!cfg || !Object.prototype.hasOwnProperty.call(cfg, key) || key === "_note") return null;
      const v = paramValue(key, (cfg as Record<string, unknown>)[key]);
      return v === "TBA" ? null : v;
    }
    if (!tokens) return null;
    if (key === "tokens") return String(tokens.count ?? tokens.tokens.length);
    if (key === "graduated") return String(tokens.tokens.filter((t) => t.phase === "graduated").length);
    return null;
  };
}

// ------------------------------------------------------------------------------------------------

export async function docsPage(params: string[]): Promise<Page> {
  const s = params[0] ?? "overview";
  const idx = DOCS.findIndex((d) => d.slug === s);
  if (idx < 0) {
    return { title: "Docs", body: html`<div class="panel errorbox"><h1>No such docs page</h1><p><a class="link" href="/docs">Back to the docs</a></p></div>` };
  }
  injectStyle();
  const doc = DOCS[idx]!;
  const live = await liveSource(doc.md);
  const r = renderMarkdown(doc.md, live);
  const prev = DOCS[idx - 1];
  const next = DOCS[idx + 1];
  const body = html`<div class="dc">
    <nav class="dc-nav" aria-label="Docs pages"><div class="dc-nav-h">Docs</div>${DOCS.map((d) => html`<a href="${d.slug === "overview" ? "/docs" : `/docs/${d.slug}`}"${d.slug === doc.slug ? raw(` aria-current="page"`) : ""}>${d.title}</a>`)}</nav>
    <article class="dc-main">
      <div class="dc-eyebrow">Docs</div>
      <h1 class="dc-h1">${r.title || doc.title}</h1>
      ${r.toc.length > 2 ? html`<div class="dc-toc"><span>On this page</span>${r.toc.map((t) => html`<a href="#${t.id}">${t.text}</a>`)}</div>` : ""}
      <div class="dc-prose">${raw(r.html)}</div>
      <div class="dc-pager">${prev ? html`<a href="${prev.slug === "overview" ? "/docs" : `/docs/${prev.slug}`}"><span>Previous</span>${prev.title}</a>` : html`<span></span>`}${next ? html`<a class="next" href="/docs/${next.slug}"><span>Next</span>${next.title}</a>` : ""}</div>
      <div class="dc-foot">Written from the specification (docs/SPEC.md). Highlighted figures are read live from Core or the market indexer when the page loads; parameter values are test values, launch values are TBA.</div>
    </article>
  </div>`;
  return { title: doc.slug === "overview" ? "Docs" : `${doc.title} | Docs`, body };
}

const CSS = `
.dc{display:grid;grid-template-columns:200px minmax(0,1fr);gap:28px;align-items:start;max-width:1080px}
.dc-nav{position:sticky;top:76px;display:flex;flex-direction:column;gap:2px;font-size:13.5px}
.dc-nav-h{font-size:11.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--faint);padding:0 10px 6px}
.dc-nav a{color:var(--dim);text-decoration:none;padding:6px 10px;border-radius:7px}
.dc-nav a:hover{background:var(--line-soft);color:var(--text)}
.dc-nav a[aria-current="page"]{background:var(--accent-soft);color:var(--accent-ink);font-weight:500}
.dc-main{min-width:0;max-width:760px}
.dc-eyebrow{font-size:12px;color:var(--faint);font-weight:500}
.dc-h1{font-size:30px;line-height:1.15;letter-spacing:-.015em;margin:4px 0 14px;font-weight:650}
.dc-toc{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:13px;margin:0 0 18px;padding-bottom:14px;border-bottom:1px solid var(--line-soft)}
.dc-toc span{color:var(--faint)}
.dc-toc a{color:var(--accent-ink);text-decoration:none}
.dc-prose{font-size:15px;line-height:1.7;color:var(--text)}
.dc-prose h2{font-size:20px;margin:30px 0 8px;letter-spacing:-.01em;scroll-margin-top:76px}
.dc-prose h3{font-size:16px;margin:22px 0 6px;scroll-margin-top:76px}
.dc-prose h4{font-size:14.5px;margin:18px 0 4px}
.dc-prose p{margin:0 0 12px}
.dc-list{margin:0 0 14px;padding-left:22px}
.dc-list li{margin:4px 0}
.dc-a{color:var(--accent-ink);text-decoration:underline;text-decoration-color:color-mix(in oklab,var(--accent) 35%,transparent);text-underline-offset:2px}
.dc-code{font-family:inherit;font-size:.92em;background:var(--line-soft);border:1px solid var(--line);border-radius:5px;padding:0 5px;overflow-wrap:anywhere}
.dc-pre{font-family:inherit;font-size:13px;line-height:1.6;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px;white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 14px}
.dc-callout{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:8px;padding:14px 16px;margin:0 0 18px;font-size:15.5px;line-height:1.65}
.dc-tw{overflow-x:auto;margin:0 0 16px;border:1px solid var(--line);border-radius:8px;background:var(--panel)}
.dc-t{width:100%;border-collapse:collapse;font-size:13.5px;line-height:1.5}
.dc-t th{text-align:left;font-weight:600;padding:8px 12px;border-bottom:1px solid var(--line);background:var(--line-soft)}
.dc-t td{padding:8px 12px;border-bottom:1px solid var(--line-soft);vertical-align:top}
.dc-t tr:last-child td{border-bottom:0}
.dc-live{font-weight:600;font-variant-numeric:tabular-nums;color:var(--accent-ink);background:var(--accent-soft);border-radius:5px;padding:0 5px;white-space:nowrap}
.dc-live.tba{color:var(--faint);background:var(--line-soft);font-weight:500}
.dc-pager{display:flex;justify-content:space-between;gap:12px;margin:30px 0 10px}
.dc-pager a{display:flex;flex-direction:column;gap:2px;padding:10px 14px;border:1px solid var(--line);border-radius:8px;text-decoration:none;color:var(--text);background:var(--panel);font-weight:500;font-size:14px;min-width:0}
.dc-pager a.next{text-align:right;margin-left:auto}
.dc-pager a span{font-size:12px;color:var(--faint);font-weight:400}
.dc-foot{font-size:12.5px;color:var(--faint);margin-top:18px;line-height:1.5}
@media (max-width:860px){
  .dc{grid-template-columns:minmax(0,1fr);gap:14px}
  .dc-nav{position:static;flex-direction:row;flex-wrap:wrap;gap:4px}
  .dc-nav-h{display:none}
  .dc-nav a{padding:5px 9px;border:1px solid var(--line);background:var(--panel);font-size:12.5px}
  .dc-h1{font-size:24px}
  .dc-prose{font-size:14.5px}
}`;

function injectStyle() {
  if (document.getElementById("dc-style")) return;
  const s = document.createElement("style");
  s.id = "dc-style";
  s.textContent = CSS;
  document.head.appendChild(s);
}
