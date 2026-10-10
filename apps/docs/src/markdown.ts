// Markdown renderer of the docs site (moved from the dashboard's former /docs page): headings,
// paragraphs, lists, tables, block quotes, fenced blocks, links, bold, italics, inline code, and the
// live figure tags
//   {{cfg:<key>}}       a parameter from Core's GET /v1/config
//   {{market:tokens}}   agent tokens the market indexer holds; {{market:graduated}} those graduated
// The static build cannot know a live figure, so `live` returns null there and the tag renders as a
// TBA span carrying data-live; the page's script (client.ts) fills it when Core or the indexer answers.

const esc = (v: unknown) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

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
        ? `<span class="dc-live tba" data-live="${kind}:${key}" title="${kind === "cfg" ? `Core config ${key}` : `market ${key}`}: not readable now">TBA</span>`
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

