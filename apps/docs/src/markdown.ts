import { FIGURES } from "./figures.ts";

// Markdown renderer of the docs site: headings, paragraphs, lists, tables, block quotes, fenced blocks,
// links, bold, italics, inline code, and the docs' own blocks:
//
//   > summary             the FIRST block quote of a page is its summary (two sentences at most, checked
//                         by the build); it renders as the lead under the title. Later block quotes are callouts.
//   {{cfg:<key>}}         a parameter from Core's GET /v1/config ({{cfg:prepay.min_usd}} for a nested one)
//   {{market:tokens}}     a figure of the market indexer; {{stats:generations}} one of GET /v1/stats;
//                         {{guard:default_max_regression}} one of GET /v1/guard-config
//   {{fig:<name>}}        on a line of its own: a figure (HTML and CSS or SVG) from figures.ts or the build
//   ![caption](shot:name) on a line of its own: a screenshot from apps/docs/public/shots, taken headless by
//                         scripts/docs/capture.ts; the caption gets the capture date from the manifest
//   ![Name](provider:id)  inline: a model provider's mark (apps/web/public/providers, MIT, see its NOTICE.md)
//   ```fold <title>       a fenced block folded behind its title (long captured responses)
//   ```<label>            any other info string is shown as the block's label
//
// The static build cannot know a live figure, so `live` returns null there and the tag renders as a
// TBA span carrying data-live; the page's script (client.ts) fills it when Core or the indexer answers.

const esc = (v: unknown) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export type Live = (kind: string, key: string) => string | null;

export interface Shot {
  file: string;
  width: number;
  height: number;
  url: string;
  what: string;
  captured_at: string;
}

export interface RenderOptions {
  /** the docs base path ("/docs"); image sources are written under it */
  base?: string;
  /** the screenshot manifest (apps/docs/captured/shots.json), by name */
  shots?: Record<string, Shot>;
  /** figures the build makes for this page, beside the static ones of figures.ts */
  figures?: Record<string, string>;
  /** names of things a page asked for that do not exist (the build reports them) */
  missing?: string[];
}

const slug = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, "").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const LIVE_TITLE: Record<string, (key: string) => string> = {
  cfg: (k) => `Core config ${k}`,
  market: (k) => `market ${k}`,
  stats: (k) => `Core stats ${k}`,
  guard: (k) => `guard config ${k}`,
};

export function inlineMd(s: string, live: Live, o: RenderOptions = {}): string {
  const codes: string[] = [];
  let t = s.replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(`<code class="dc-code">${esc(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  t = esc(t)
    .replace(/\{\{(cfg|market|stats|guard):([a-z0-9_.]+)\}\}/g, (_, kind: string, key: string) => {
      const v = live(kind, key);
      return v === null
        ? `<span class="dc-live tba" data-live="${kind}:${key}" title="${LIVE_TITLE[kind]!(key)}: not readable now">TBA</span>`
        : `<span class="dc-live" data-live="${kind}:${key}">${esc(v)}</span>`;
    })
    .replace(/!\[([^\]]*)\]\(provider:([a-z0-9-]+)\)/g, (_, alt: string, id: string) => `<img class="dc-plogo" src="${o.base ?? ""}/providers/${id}.svg" alt="" width="16" height="16" loading="lazy">${alt}`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text: string, href: string) => {
      const ext = /^https?:\/\//.test(href);
      const safe = /^(https?:\/\/|\/|#)/.test(href) ? href : "#";
      return `<a class="dc-a" href="${safe}"${ext ? ` target="_blank" rel="noopener"` : ""}>${text}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<i>$2</i>");
  return t.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]!);
}

const day = (iso: string) => iso.slice(0, 10);

export interface Rendered {
  title: string;
  /** the page summary (the first block quote), as HTML and as plain text */
  summary: string;
  summaryText: string;
  html: string;
  toc: { id: string; text: string }[];
}

export function renderMarkdown(md: string, live: Live, o: RenderOptions = {}): Rendered {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  const toc: { id: string; text: string }[] = [];
  let title = "";
  let summary = "";
  let summaryText = "";
  let i = 0;
  const seen = new Map<string, number>();
  const uniq = (base: string) => {
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n + 1}` : base;
  };
  const isBlockStart = (l: string) => /^(#{1,4} |\||```|>|\s*- |\s*\d+\. |\{\{fig:|!\[[^\]]*\]\(shot:)/.test(l);
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.trim() === "" || l.trim() === "---") {
      i++;
      continue;
    }
    const fig = /^\{\{fig:([a-z0-9-]+)\}\}$/.exec(l.trim());
    if (fig) {
      const f = o.figures?.[fig[1]!] ?? FIGURES[fig[1]!];
      if (!f) o.missing?.push(`figure ${fig[1]}`);
      out.push(f ?? `<p>Figure ${esc(fig[1])} is missing (TBA).</p>`);
      i++;
      continue;
    }
    const shot = /^!\[([^\]]*)\]\(shot:([a-z0-9-]+)\)$/.exec(l.trim());
    if (shot) {
      const s = o.shots?.[shot[2]!];
      if (!s) {
        o.missing?.push(`screenshot ${shot[2]}`);
        out.push(`<p class="dc-shot-missing">Screenshot not captured in this build: ${esc(shot[1])}.</p>`);
      } else {
        const cap = `${inlineMd(shot[1]!, live, o)} <span class="dc-shot-at">Captured from the devnet site on ${day(s.captured_at)}.</span>`;
        out.push(
          `<figure class="dc-shot"><a href="${o.base ?? ""}/shots/${s.file}" target="_blank" rel="noopener" aria-label="Open the screenshot at full size"><img src="${o.base ?? ""}/shots/${s.file}" alt="${esc(shot[1]!.replace(/[*`]/g, ""))}" width="${s.width}" height="${s.height}" loading="lazy" decoding="async"></a><figcaption>${cap}</figcaption></figure>`,
        );
      }
      i++;
      continue;
    }
    if (l.startsWith("```")) {
      const info = l.slice(3).trim();
      const buf: string[] = [];
      for (i++; i < lines.length && !lines[i]!.startsWith("```"); i++) buf.push(lines[i]!);
      i++;
      const pre = `<pre class="dc-pre">${esc(buf.join("\n"))}</pre>`;
      const fold = /^fold\s+(.+)$/.exec(info);
      if (fold) out.push(`<details class="dc-fold"><summary>${inlineMd(fold[1]!, live, o)}</summary>${pre}</details>`);
      else if (info) out.push(`<div class="dc-block"><div class="dc-block-h">${inlineMd(info, live, o)}</div>${pre}</div>`);
      else out.push(pre);
      continue;
    }
    const h = /^(#{1,4}) (.*)$/.exec(l);
    if (h) {
      const level = h[1]!.length;
      const text = inlineMd(h[2]!, live, o);
      if (level === 1) title = h[2]!;
      else {
        const id = uniq(slug(h[2]!) || "section");
        if (level === 2) toc.push({ id, text: h[2]!.replace(/`/g, "") });
        out.push(`<h${level} id="${id}">${text}</h${level}>`);
      }
      i++;
      continue;
    }
    if (l.startsWith(">")) {
      const buf: string[] = [];
      for (; i < lines.length && lines[i]!.startsWith(">"); i++) buf.push(lines[i]!.replace(/^>\s?/, ""));
      const html = inlineMd(buf.join(" "), live, o);
      if (!summary && !out.length) {
        summary = html;
        summaryText = buf.join(" ");
      } else out.push(`<div class="dc-callout">${html}</div>`);
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
      out.push(`<div class="dc-tw"><table class="dc-t"><thead><tr>${(head ?? []).map((c) => `<th>${inlineMd(c, live, o)}</th>`).join("")}</tr></thead><tbody>${body
        .map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c, live, o)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
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
      out.push(`<${ordered ? "ol" : "ul"} class="dc-list">${items.map((t) => `<li>${inlineMd(t, live, o)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    const para: string[] = [];
    for (; i < lines.length && lines[i]!.trim() !== "" && !isBlockStart(lines[i]!); i++) para.push(lines[i]!);
    out.push(`<p>${inlineMd(para.join(" "), live, o)}</p>`);
  }
  return { title, summary, summaryText, html: out.join("\n"), toc };
}

/** Sentences in a summary: ends of sentences followed by a space or the end (so "0.05 SOL" and `a.json` count as none). */
export function sentenceCount(text: string): number {
  const plain = text.replace(/`[^`]*`/g, "x").replace(/\*\*/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  return (plain.match(/[.!?](?=\s|$)/g) ?? []).length;
}
