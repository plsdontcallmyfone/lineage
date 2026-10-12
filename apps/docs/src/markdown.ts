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
//   ```bash               a known language name is shown as the block's language label; a file name may
//   ```ts title="a.ts"    follow as title="..."; every block gets a copy button
//   ```<label>            any other info string is shown as the block's label (Request, Output: exit code 0)
//
// Components (Mintlify-style). A component is a container: a line of three or more colons and its name
// opens it, a line of the same number of colons closes it. A container that holds other containers
// uses one more colon than they do. The body is markdown.
//
//   :::note [title]       a callout; also :::tip, :::warning and :::info. A plain block quote after the
//   text                  summary is a note without a title
//   :::
//
//   ::::cards 2           a card group in 2 columns (1 to 3; default 2)
//   :::card [Title](doc:slug) {tag="5 steps"}
//   One or two sentences. The whole card is the link; the tag is a small label above the title.
//   :::
//   ::::
//
//   ::::steps             a numbered procedure; each step title is a heading (it gets an anchor and a
//   :::step Title         line in "On this page")
//   text, lists, screenshots, code
//   :::
//   ::::
//
//   ::::tabs              tabs; the first is shown. Tabs with the same labels on one page switch together
//   :::tab Devnet
//   text
//   :::
//   ::::
//
//   :::accordion Title    a folded section (the title gets an anchor; {open} after it starts it opened)
//   text
//   :::
//
//   :::api `GET /v1/stats` {access="public" open}
//   text, a request block, a folded response      an API reference block: method badge, path, access,
//   :::                                            folded unless {open}
//
// A trailing {key="value" flag} on a container's opening line sets its options.
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
  /** h2 headings (level 2) and, under them, h3 headings and step titles (level 3) */
  toc: { id: string; text: string; level: 2 | 3 }[];
}

const LANGS: Record<string, string> = {
  bash: "Bash", sh: "Shell", shell: "Shell", ts: "TypeScript", typescript: "TypeScript", js: "JavaScript", javascript: "JavaScript",
  json: "JSON", jsonl: "JSON Lines", toml: "TOML", yaml: "YAML", yml: "YAML", rust: "Rust", python: "Python", py: "Python",
  http: "HTTP", html: "HTML", css: "CSS", diff: "Diff", text: "Text", curl: "curl", env: "Environment", ini: "INI",
};

const ICON: Record<string, string> = {
  note: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 2.5h7l3 3v8H3z"/><path d="M5.5 7h5M5.5 9.5h5M5.5 12h3"/></svg>`,
  info: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 7.2v4M8 4.8v.2"/></svg>`,
  tip: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.6 10.4a4.2 4.2 0 1 1 4.8 0V12H5.6z"/><path d="M6.4 14h3.2"/></svg>`,
  warning: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.2 14.2 13H1.8z"/><path d="M8 6.4v3.2M8 11.3v.2"/></svg>`,
};
const CALLOUT_NAME: Record<string, string> = { note: "Note", info: "Info", tip: "Tip", warning: "Warning" };
const COPY = `<button class="dc-copy" type="button" data-copy aria-label="Copy to the clipboard"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg><span>Copy</span></button>`;

/** The options a container's opening line ends with: {key="value" flag}. */
function attrs(head: string): { text: string; a: Record<string, string> } {
  const m = /(?:^|\s)\{([^{}]*)\}\s*$/.exec(head);
  if (!m || head.slice(0, m.index).endsWith("{")) return { text: head.trim(), a: {} };
  const a: Record<string, string> = {};
  for (const x of m[1]!.matchAll(/([a-z-]+)(?:="([^"]*)")?/g)) a[x[1]!] = x[2] ?? "true";
  return { text: head.slice(0, m.index).trim(), a };
}

/** "GET /v1/agents/:id" with the path parameters marked. */
const apiPath = (path: string) => esc(path).replace(/(:[a-z_0-9]+)/gi, '<i class="dc-api-v">$1</i>');

export function renderMarkdown(md: string, live: Live, o: RenderOptions = {}): Rendered {
  const toc: Rendered["toc"] = [];
  let title = "";
  let summary = "";
  let summaryText = "";
  const seen = new Map<string, number>();
  const uniq = (base: string) => {
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n + 1}` : base;
  };
  const anchor = (id: string) => `<a class="dc-anchor" href="#${id}" aria-label="Link to this section"></a>`;
  const isBlockStart = (l: string) => /^(#{1,4} |\||```|>|:{3,}[a-z]|\s*- |\s*\d+\. |\{\{fig:|!\[[^\]]*\]\(shot:)/.test(l);
  const code = (info: string, body: string): string => {
    const pre = `<pre class="dc-pre" tabindex="0">${esc(body)}</pre>`;
    const fold = /^fold\s+(.+)$/.exec(info);
    if (fold) return `<details class="dc-fold"><summary>${inlineMd(fold[1]!, live, o)}</summary><div class="dc-fold-b">${COPY}${pre}</div></details>`;
    const lang = /^([a-z]+)(?:\s+title="([^"]+)")?$/.exec(info);
    const label = lang && LANGS[lang[1]!] ? `<span class="dc-codeb-l">${LANGS[lang[1]!]}</span>${lang[2] ? `<span class="dc-codeb-f">${esc(lang[2])}</span>` : ""}` : info ? `<span class="dc-codeb-l">${inlineMd(info, live, o)}</span>` : "";
    return `<div class="dc-codeb${label ? "" : " is-bare"}">${label ? `<div class="dc-codeb-h">${label}${COPY}</div>` : COPY}${pre}</div>`;
  };
  /** The lines of a container opened at `at` with `n` colons, and the index after its closing line. */
  const container = (lines: string[], at: number, n: number): { body: string[]; next: number } => {
    const close = ":".repeat(n);
    let fence = false;
    let j = at + 1;
    for (; j < lines.length; j++) {
      if (lines[j]!.startsWith("```")) fence = !fence;
      else if (!fence && lines[j]!.trim() === close) break;
    }
    return { body: lines.slice(at + 1, j), next: j + 1 };
  };
  /** The direct child containers of a group (cards, steps, tabs), by name. */
  const children = (lines: string[], name: string): { head: string; body: string[] }[] => {
    const out: { head: string; body: string[] }[] = [];
    for (let j = 0; j < lines.length; ) {
      const m = /^(:{3,})([a-z]+)\b(.*)$/.exec(lines[j]!);
      if (!m || m[2] !== name) {
        if (lines[j]!.trim() !== "") o.missing?.push(`a ${name} container (found "${lines[j]!.slice(0, 40)}" in a ${name}s group)`);
        j++;
        continue;
      }
      const c = container(lines, j, m[1]!.length);
      out.push({ head: m[3]!.trim(), body: c.body });
      j = c.next;
    }
    return out;
  };
  const component = (name: string, headRaw: string, body: string[], depth: number): string => {
    const { text: head, a } = attrs(headRaw);
    if (name in CALLOUT_NAME)
      return `<aside class="dc-callout is-${name}" role="note" aria-label="${CALLOUT_NAME[name]}"><span class="dc-callout-i">${ICON[name]}</span><div class="dc-callout-b">${head ? `<p class="dc-callout-t">${inlineMd(head, live, o)}</p>` : ""}${blocks(body, depth + 1)}</div></aside>`;
    if (name === "cards") {
      const cols = Math.min(3, Math.max(1, Number(head) || 2));
      const cards = children(body, "card").map((c) => {
        const { text: h, a: ca } = attrs(c.head);
        const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(h);
        const t = `${ca.tag ? `<span class="dc-card-tag">${esc(ca.tag)}</span>` : ""}<b class="dc-card-t">${inlineMd(link ? link[1]! : h, live, o)}</b>`;
        const text = c.body.join(" ").trim().replace(/\[([^\]]+)\]\([^)\s]+\)/g, "$1");
        const b = text ? `<span class="dc-card-b">${inlineMd(text, live, o)}</span>` : "";
        if (!link) return `<div class="dc-card">${t}${b}</div>`;
        const ext = /^https?:\/\//.test(link[2]!);
        const safe = /^(https?:\/\/|\/|#)/.test(link[2]!) ? link[2]! : "#";
        return `<a class="dc-card is-link" href="${safe}"${ext ? ` target="_blank" rel="noopener"` : ""}>${t}${b}<span class="dc-card-go" aria-hidden="true"></span></a>`;
      });
      return `<div class="dc-cards" data-cols="${cols}">${cards.join("")}</div>`;
    }
    if (name === "steps") {
      const steps = children(body, "step").map((c) => {
        const { text: h } = attrs(c.head);
        const id = uniq(slug(h) || "step");
        if (depth === 0) toc.push({ id, text: h.replace(/[`*]/g, ""), level: 3 });
        return `<li class="dc-stp"><h3 id="${id}">${inlineMd(h, live, o)}${anchor(id)}</h3><div class="dc-stp-b">${blocks(c.body, depth + 1)}</div></li>`;
      });
      return `<ol class="dc-stepper">${steps.join("")}</ol>`;
    }
    if (name === "tabs") {
      const tabs = children(body, "tab").map((c) => ({ label: attrs(c.head).text, id: uniq("tab"), body: c.body }));
      return `<div class="dc-tabs" data-tabs><div class="dc-tabs-l" role="tablist">${tabs
        .map((t, k) => `<button type="button" role="tab" id="${t.id}" aria-controls="${t.id}-p" aria-selected="${k === 0}"${k ? ` tabindex="-1"` : ""}>${esc(t.label)}</button>`)
        .join("")}</div>${tabs.map((t, k) => `<div class="dc-tab" role="tabpanel" id="${t.id}-p" aria-labelledby="${t.id}"${k ? " hidden" : ""}>${blocks(t.body, depth + 1)}</div>`).join("")}</div>`;
    }
    if (name === "accordion") {
      const id = uniq(slug(head) || "more");
      return `<details class="dc-acc" id="${id}"${a.open ? " open" : ""}><summary><span class="dc-acc-t">${inlineMd(head, live, o)}</span></summary><div class="dc-acc-b">${blocks(body, depth + 1)}</div></details>`;
    }
    if (name === "api") {
      const m = /^`(GET|POST|PUT|DELETE|PATCH) ([^`]+)`(.*)$/.exec(head);
      if (!m) {
        o.missing?.push(`an api block's method and path (":::api \`GET /v1/x\`", found "${head.slice(0, 40)}")`);
        return blocks(body, depth + 1);
      }
      const id = uniq(slug(`${m[1]} ${m[2]}`));
      return `<details class="dc-api" id="${id}"${a.open ? " open" : ""}><summary><span class="dc-m is-${m[1]!.toLowerCase()}">${m[1]}</span><span class="dc-api-p">${apiPath(m[2]!)}</span>${m[3]!.trim() ? `<span class="dc-api-x">${inlineMd(m[3]!.trim(), live, o)}</span>` : ""}${a.access ? `<span class="dc-api-a">${esc(a.access)}</span>` : ""}</summary><div class="dc-api-b">${blocks(body, depth + 1)}</div></details>`;
    }
    o.missing?.push(`component "${name}" (known: note, tip, warning, info, cards, steps, tabs, accordion, api)`);
    return blocks(body, depth + 1);
  };
  function blocks(lines: string[], depth: number): string {
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.trim() === "" || l.trim() === "---") {
        i++;
        continue;
      }
      const box = /^(:{3,})([a-z]+)\b(.*)$/.exec(l);
      if (box) {
        const c = container(lines, i, box[1]!.length);
        out.push(component(box[2]!, box[3]!, c.body, depth));
        i = c.next;
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
        out.push(code(info, buf.join("\n")));
        continue;
      }
      const h = /^(#{1,4}) (.*)$/.exec(l);
      if (h) {
        const level = h[1]!.length;
        const text = inlineMd(h[2]!, live, o);
        if (level === 1 && depth === 0) title = h[2]!;
        else {
          const id = uniq(slug(h[2]!) || "section");
          if (depth === 0 && (level === 2 || level === 3)) toc.push({ id, text: h[2]!.replace(/[`*]/g, ""), level });
          out.push(`<h${level} id="${id}">${text}${level < 4 ? anchor(id) : ""}</h${level}>`);
        }
        i++;
        continue;
      }
      if (l.startsWith(">")) {
        const buf: string[] = [];
        for (; i < lines.length && lines[i]!.startsWith(">"); i++) buf.push(lines[i]!.replace(/^>\s?/, ""));
        const html = inlineMd(buf.join(" "), live, o);
        if (depth === 0 && !summary && !out.length) {
          summary = html;
          summaryText = buf.join(" ");
        } else out.push(`<aside class="dc-callout is-note" role="note" aria-label="Note"><span class="dc-callout-i">${ICON.note}</span><div class="dc-callout-b"><p>${html}</p></div></aside>`);
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
        out.push(`<div class="dc-tw" tabindex="0" role="region" aria-label="Table"><table class="dc-t"><thead><tr>${(head ?? []).map((c) => `<th scope="col">${inlineMd(c, live, o)}</th>`).join("")}</tr></thead><tbody>${body
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
    return out.join("\n");
  }
  const html = blocks(md.replace(/\r\n/g, "\n").split("\n"), 0);
  return { title, summary, summaryText, html, toc };
}

/** Sentences in a summary: ends of sentences followed by a space or the end (so "0.05 SOL" and `a.json` count as none). */
export function sentenceCount(text: string): number {
  const plain = text.replace(/`[^`]*`/g, "x").replace(/\*\*/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  return (plain.match(/[.!?](?=\s|$)/g) ?? []).length;
}
