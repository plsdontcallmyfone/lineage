import { state } from "./api.ts";
import { esc, html, raw, type Raw } from "./html.ts";

// Formatting. Every figure passed in here comes from Core; nothing is computed into a new claim
// except presentation (percent of a measured ratio, token decimals from config).

export const TOKEN = "$LINE";

const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** Base units (decimal string) to a display amount using token_decimals from GET /v1/config. */
export function tokenText(base: string | null | undefined, places = 4): string | null {
  if (base === null || base === undefined || !/^-?\d+$/.test(String(base))) return null;
  const d = state.cfg?.token_decimals;
  if (d === undefined) return null;
  let v = BigInt(base);
  const neg = v < 0n;
  if (neg) v = -v;
  const scale = 10n ** BigInt(d);
  const int = v / scale;
  const frac = (v % scale).toString().padStart(d, "0").slice(0, places);
  return `${neg ? "-" : ""}${group(int.toString())}${places > 0 && d > 0 ? "." + frac.padEnd(places, "0") : ""}`;
}

export function token(base: string | null | undefined, opts: { places?: number; unit?: boolean } = {}): Raw {
  const t = tokenText(base, opts.places ?? 4);
  if (t === null) return html`<span class="faint">TBA</span>`;
  const exact = tokenText(base, state.cfg?.token_decimals ?? 0);
  return html`<span class="num" title="${exact} ${TOKEN} (${base} base units)">${t}</span>${opts.unit === false ? "" : html`<span class="unit">${TOKEN}</span>`}`;
}

export function int(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "TBA";
  return group(Math.round(n).toString());
}

export function units(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "TBA";
  return n.toFixed(2);
}

export function shortHex(h: string | null | undefined, n = 8): string {
  if (!h) return "";
  return h.length > n + 2 ? h.slice(0, n) : h;
}

export function shortId(id: string | null | undefined): string {
  if (!id) return "";
  return id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}

export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return "";
  const s = Math.round((now - ms) / 1000);
  if (s < 0) return `in ${dur(-s)}`;
  if (s < 5) return "just now";
  return `${dur(s)} ago`;
}

export function dur(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

export function when(ms: number | null | undefined): Raw {
  if (!ms) return html`<span class="faint">TBA</span>`;
  return html`<time class="nowrap" datetime="${new Date(ms).toISOString()}" title="${stamp(ms)}" data-ago="${ms}">${ago(ms)}</time>`;
}

export function stamp(ms: number | null | undefined): string {
  if (!ms) return "TBA";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** A measured ratio below 1 is an improvement (SPEC 4.4: ratio oriented so lower is better). */
export function gainPct(ratio: number): string {
  const g = (1 - ratio) * 100;
  const sign = g > 0 ? "−" : g < 0 ? "+" : "";
  return `${sign}${Math.abs(g).toFixed(2)}%`;
}

export function effect(e: any, opts: { perReplay?: boolean; compact?: boolean; perOnly?: boolean } = {}): Raw {
  if (!e) return html`<span class="faint">TBA</span>`;
  if (Array.isArray(e.fixed)) {
    return html`<span class="eff good">fixed ${e.fixed.length} test${e.fixed.length === 1 ? "" : "s"}</span>${opts.compact ? "" : html`<div class="sub">${e.fixed.join(", ")}</div>`}`;
  }
  if (typeof e.ratio !== "number") return html`<span class="faint">TBA</span>`;
  const good = e.ratio < 1;
  const noisy = e.ci_low !== e.ci_high;
  const head = html`<span class="eff ${good ? "good" : "bad"}" title="cost change of ${esc(e.metric)} relative to the parent">${gainPct(e.ratio)}</span> <span class="ratio num">ratio ${e.ratio.toFixed(4)}</span>`;
  if (opts.compact) return head;
  const ci = noisy ? html`<span>CI ${e.ci_low.toFixed(4)} to ${e.ci_high.toFixed(4)}</span>` : html`<span>deterministic</span>`;
  const per =
    opts.perReplay !== false && Array.isArray(e.per_replay)
      ? e.per_replay.map(
          (p: any, i: number) =>
            html`<span title="replay ${esc(p.replay_id)}">r${i + 1} ${p.ratio.toFixed(4)}${p.ci_low !== p.ci_high ? html` [${p.ci_low.toFixed(3)}, ${p.ci_high.toFixed(3)}]` : ""} ${p.pass ? "pass" : "fail"}</span>`,
        )
      : [];
  if (opts.perOnly) return html`<div class="pr num" style="margin-top:0"><span>per replay</span>${per}</div>`;
  return html`${head}<div class="pr num"><span>${e.metric}</span>${ci}${per}</div>`;
}

export function lineageName(id: string | null | undefined): string {
  if (!id) return "";
  return state.lineageNames.get(id) ?? shortHex(id);
}

export function target(t: unknown): string {
  if (Array.isArray(t)) return t.length === 1 ? String(t[0]) : `${t.length} tests`;
  return t === null || t === undefined ? "" : String(t);
}

export function repoLabel(url: string | null | undefined): string {
  if (!url) return "";
  return url.replace(/^https:\/\/github\.com\//, "");
}

export function repoLink(url: string | null | undefined): Raw {
  if (!url) return html`<span class="faint">TBA</span>`;
  if (/^https?:\/\//.test(url)) return html`<a class="link" href="${url}" target="_blank" rel="noopener">${repoLabel(url)}</a>`;
  return html`<span>${url}</span>`;
}

export const nbsp = raw("&nbsp;");

/** Launch GitHub identity modes (SPEC 13.9). Old names are aliases Core may still return. */
export function identityLabel(m: string | null | undefined): string {
  if (!m) return "TBA";
  if (m === "token" || m === "import") return "Own GitHub token";
  if (m === "purchased" || m === "provided") return "Purchased account";
  if (m === "app") return "App identity";
  return m;
}
