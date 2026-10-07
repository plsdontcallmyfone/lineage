import { loadConfig } from "../api.ts";
import { dur, tokenText, TOKEN } from "../fmt.ts";
import { esc, html, raw, type Raw } from "../html.ts";
import { panel } from "../ui.ts";
import type { Page } from "./types.ts";

// The manual (PARITY "Manual page"): generated from docs/SPEC.md as served by the dashboard, with
// every configuration key the text mentions annotated with its live value from GET /v1/config.

const AMOUNTS = new Set(["register_burn", "min_bond", "bond_cap", "rebate_per_class", "sleep_threshold", "wake_threshold"]);

export function paramValue(k: string, v: unknown): string {
  if (AMOUNTS.has(k)) {
    // exact: every significant decimal, at least two places
    const t = tokenText(String(v), 18);
    return t === null ? "TBA" : `${t.replace(/(\.\d\d\d*?)0+$/, "$1")} ${TOKEN}`;
  }
  if (typeof v !== "number") return String(v);
  if (k.endsWith("_bps")) return `${(v / 100).toFixed(v % 100 ? 2 : 0)}%`;
  if (k.endsWith("_s")) return v >= 60 ? `${dur(v)} (${v} s)` : `${v} s`;
  if (k.endsWith("_rate") && k !== "activity_rate") return `${(v * 100).toFixed(v * 100 < 1 ? 2 : 0)}%`;
  if (k === "activity_rate") return `${v} per agent per minute`;
  return String(v);
}

let specCache: Promise<string> | null = null;
function spec(): Promise<string> {
  specCache ??= fetch("/live/spec").then((r) => {
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("markdown")) throw new Error(`the dashboard server did not serve docs/SPEC.md (status ${r.status}); restart it`);
    return r.text();
  }).catch((e) => {
    specCache = null;
    throw e;
  });
  return specCache;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function inline(s: string, cfg: Record<string, unknown>): string {
  // escape, then code spans (annotated with live config values), bold
  return esc(s)
    .replace(/`([^`]+)`/g, (_, c: string) => {
      const key = c.trim();
      if (Object.prototype.hasOwnProperty.call(cfg, key) && key !== "_note") return `<span class="cfg" title="live value from GET /v1/config"><span class="k">${key}</span><span class="v">${esc(paramValue(key, cfg[key]))}</span></span>`;
      return `<code>${c}</code>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
}

/** A small Markdown subset: the constructs SPEC.md uses. */
export function renderSpec(md: string, cfg: Record<string, unknown>): { body: string; toc: { id: string; text: string; level: number }[] } {
  const lines = md.split("\n");
  const out: string[] = [];
  const toc: { id: string; text: string; level: number }[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith("```")) {
      const buf: string[] = [];
      for (i++; i < lines.length && !lines[i]!.startsWith("```"); i++) buf.push(lines[i]!);
      i++;
      out.push(`<pre class="block">${esc(buf.join("\n"))}</pre>`);
      continue;
    }
    const h = /^(#{1,4}) (.*)$/.exec(l);
    if (h) {
      const level = h[1]!.length;
      const text = h[2]!;
      const id = slug(text);
      if (level >= 2 && level <= 3) toc.push({ id, text, level });
      if (level > 1) out.push(`<h${level + 1} id="${id}">${inline(text, cfg)}</h${level + 1}>`);
      i++;
      continue;
    }
    if (l.startsWith("|")) {
      const rows: string[][] = [];
      for (; i < lines.length && lines[i]!.startsWith("|"); i++) {
        const cells = lines[i]!.replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim());
        if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
        rows.push(cells);
      }
      const [head, ...body] = rows;
      out.push(
        `<div class="tw"><table class="t spec"><thead><tr>${(head ?? []).map((c) => `<th>${inline(c, cfg)}</th>`).join("")}</tr></thead><tbody>${body
          .map((r) => `<tr>${r.map((c) => `<td class="wrap">${inline(c, cfg)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      continue;
    }
    if (/^\s*(- |\d+\. )/.test(l)) {
      const ordered = /^\s*\d+\. /.test(l);
      const items: string[] = [];
      for (; i < lines.length && /^\s*(- |\d+\. )|^\s{2,}\S/.test(lines[i]!); i++) {
        const t = lines[i]!;
        if (/^\s*(- |\d+\. )/.test(t)) items.push(t.replace(/^\s*(- |\d+\. )/, ""));
        else items[items.length - 1] += " " + t.trim();
      }
      out.push(`<${ordered ? "ol" : "ul"}>${items.map((t) => `<li>${inline(t, cfg)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    if (l.trim() === "" || l.trim() === "---") {
      i++;
      continue;
    }
    const para: string[] = [];
    for (; i < lines.length && lines[i]!.trim() !== "" && !/^(#|\||```|\s*- |\s*\d+\. )/.test(lines[i]!); i++) para.push(lines[i]!);
    out.push(`<p>${inline(para.join(" "), cfg)}</p>`);
  }
  return { body: out.join("\n"), toc };
}

export async function manualPage(): Promise<Page> {
  const [cfg, md] = await Promise.all([loadConfig(), spec()]);
  const status = (/^Status: (.*)$/m.exec(md)?.[1] ?? "").split(". ")[0];
  const { body, toc } = renderSpec(md.replace(/^# .*\n/, "").replace(/^Status: .*\n/m, ""), cfg);
  const keys = Object.keys(cfg).filter((k) => k !== "_note").sort();
  const params = html`<div class="params">${keys.map((k) => html`<div><span class="k">${k}</span><span class="v num">${paramValue(k, cfg[k])}</span></div>`)}</div>`;
  const page = html`
    <div class="ph-row"><div class="ph-title"><div class="eyebrow">Manual</div><h1>How the network works</h1>
      <div class="ph-sub"><span>Generated from <span class="num">docs/SPEC.md</span> (${status}). Every configuration key the text names carries its live value from Core (<span class="num">GET /v1/config</span>); values are M1 test values, launch values are TBA.</span></div></div></div>
    <div class="manual">
      <aside class="toc panel"><div class="panel-h"><h2>Contents</h2></div><nav aria-label="Manual sections">${toc.map(
        (t) => html`<a href="#${t.id}" class="${t.level === 3 ? "sub" : ""}" data-anchor>${t.text}</a>`,
      )}</nav></aside>
      <div class="stack min0">
        ${panel("Live parameters", params, { count: keys.length, aside: html`<span>read from Core now</span>` })}
        <article class="panel prose">${raw(body)}</article>
      </div>
    </div>`;
  return { title: "Manual", body: page };
}
