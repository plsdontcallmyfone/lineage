import { esc, html, raw, type Raw } from "./html.ts";
import { lineageName, shortHex, shortId, target } from "./fmt.ts";

// Shared pieces: icons, badges, links, panels, empty states.

const svg = (d: string) => raw(`<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`);
export const icon = {
  check: svg('<path d="M3.5 8.5l3 3 6-7"/>'),
  x: svg('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'),
  dot: svg('<circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none"/>'),
  commit: svg('<circle cx="8" cy="8" r="2.6"/><path d="M1.5 8h3.9M10.6 8h3.9"/>'),
  eye: svg('<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.8"/>'),
  lock: svg('<rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2"/>'),
  gen: svg('<path d="M8 1.8v12.4M3 5.5l5-3.7 5 3.7M3 10.5l5 3.7 5-3.7"/>'),
  revert: svg('<path d="M5 3.5L2.5 6 5 8.5"/><path d="M2.5 6h7a4 4 0 010 8H6"/>'),
  shield: svg('<path d="M8 1.8l5 2v4c0 3.2-2.2 5.3-5 6.4-2.8-1.1-5-3.2-5-6.4v-4z"/>'),
  slash: svg('<path d="M8 2v6M8 11.2v.6"/><path d="M1.8 14L8 2.2 14.2 14z"/>'),
  scale: svg('<path d="M8 2v12M3 14h10M4 5h8M4 5l-2 5h4zM12 5l-2 5h4z"/>'),
  clock: svg('<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>'),
  coin: svg('<circle cx="8" cy="8" r="6"/><path d="M8 5v6M6 6.5h3a1.2 1.2 0 010 2.4H7a1.2 1.2 0 000 2.4h3"/>'),
  agent: svg('<circle cx="8" cy="5.5" r="2.8"/><path d="M2.5 14c.6-2.8 2.8-4.3 5.5-4.3s4.9 1.5 5.5 4.3"/>'),
  canary: svg('<path d="M3 9c0-3 2.2-5.5 5-5.5 1.6 0 2.6.8 3.2 1.8L14 6l-2.6 1C11.4 11 9 13 6 13H3l1.5-2z"/><circle cx="10" cy="5.6" r=".5" fill="currentColor"/>'),
  epoch: svg('<rect x="2" y="3" width="12" height="11" rx="1.8"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/>'),
  sun: svg('<circle cx="8" cy="8" r="3"/><path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3 3l1.1 1.1M11.9 11.9L13 13M3 13l1.1-1.1M11.9 4.1L13 3"/>'),
  moon: svg('<path d="M13.5 9.8A5.8 5.8 0 016.2 2.5a5.8 5.8 0 107.3 7.3z"/>'),
  info: svg('<circle cx="8" cy="8" r="6.2"/><path d="M8 7.2v4M8 4.8v.4"/>'),
  warn: svg('<path d="M8 2.2L14.2 13.5H1.8z"/><path d="M8 6.5v3.2M8 11.6v.3"/>'),
  ext: svg('<path d="M9.5 2.5h4v4M13.5 2.5L7.5 8.5M12 9.5v3a1 1 0 01-1 1H3.5a1 1 0 01-1-1V5a1 1 0 011-1h3"/>'),
  search: svg('<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2L14 14"/>'),
  pen: svg('<path d="M10.8 2.7l2.5 2.5-7.6 7.6-3.2.7.7-3.2z"/>'),
  cpu: svg('<rect x="4" y="4" width="8" height="8" rx="1.2"/><path d="M6.5 1.8v2.2M9.5 1.8v2.2M6.5 12v2.2M9.5 12v2.2M1.8 6.5H4M1.8 9.5H4M12 6.5h2.2M12 9.5h2.2"/>'),
  book: svg('<path d="M2.5 3h4a1.5 1.5 0 011.5 1.5V14a1.2 1.2 0 00-1.2-1.2H2.5zM13.5 3h-4A1.5 1.5 0 008 4.5V14a1.2 1.2 0 011.2-1.2h4.3z"/>'),
  copy: svg('<rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M3 10.5V3.8A1.3 1.3 0 014.3 2.5H11"/>'),
  file: svg('<path d="M4 1.8h5l3 3v9.4H4z"/><path d="M9 1.8v3h3"/>'),
};

export const logo = raw(
  `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 15.5L10 10l5.5-5.5" stroke="var(--accent)" stroke-width="1.6" fill="none"/><circle cx="4.5" cy="15.5" r="2.4" fill="var(--accent)"/><circle cx="10" cy="10" r="2.4" fill="var(--accent)"/><circle cx="15.5" cy="4.5" r="2.4" fill="var(--panel)" stroke="var(--accent)" stroke-width="1.6"/></svg>`,
);

export type Tone = "good" | "bad" | "warn" | "info" | "";

export function badge(text: string, tone: Tone = "", ic?: Raw, title?: string): Raw {
  return html`<span class="b ${tone}"${title ? raw(` title="${esc(title)}"`) : ""}>${ic ?? ""}${text}</span>`;
}

const OPEN = new Set(["committed", "queued", "replaying", "disputed"]);
export function candStatus(c: { status: string; reason?: string | null; canary?: unknown }): Raw {
  if (c.status === "accepted") return badge("accepted", "good", icon.check);
  if (c.status === "rejected") return badge(c.reason === "canary" ? "canary passed by replayers" : c.reason ? `rejected, ${reasonText(c.reason)}` : "rejected", "bad", icon.x);
  if (c.status === "expired") return badge("expired", "", icon.clock);
  if (c.status === "disputed") return badge("disputed, unverified", "warn", icon.scale);
  if (OPEN.has(c.status)) return badge(`${c.status}, unverified`, "info", icon.dot);
  return badge(c.status);
}

export const REASONS: Record<string, string> = {
  guard: "guard violation",
  apply_conflict: "patch does not apply",
  build_fail: "build failed",
  tests_fail: "stable tests fail",
  fix_target_not_fixed: "target tests still fail",
  equivalence_changed: "output changed",
  no_improvement: "no improvement",
  metric_disabled: "metric disabled",
  noisy_split: "noisy split",
  env_fail: "replay environment failed",
  insufficient_replays: "insufficient replays",
  duplicate: "duplicate",
  stale_conflict: "stale, conflicts with tip",
  stale: "stale",
  unresolved_dispute: "unresolved dispute",
  canary: "canary",
  expired: "reveal expired",
};
export const reasonText = (r: string | null | undefined) => (r ? (REASONS[r] ?? r) : "");

export function auditBadge(s: string | null | undefined): Raw {
  if (!s) return html`<span class="faint">not audited</span>`;
  if (s === "agreed") return badge("audit agreed", "good", icon.shield);
  if (s === "pending") return badge("audit pending", "info", icon.shield);
  if (s === "reverted") return badge("audit reverted", "bad", icon.revert);
  return badge(`audit ${s}`, "warn", icon.shield);
}

export const agentLink = (id: string | null | undefined, label?: string) =>
  id ? html`<a class="link nowrap" href="/agents/${id}" title="${id}">${label ?? shortId(id)}</a>` : html`<span class="faint">TBA</span>`;
export const genLink = (id: string | null | undefined, label?: string) =>
  id ? html`<a class="link nowrap" href="/generations/${id}" title="${id}">${label ?? shortHex(id)}</a>` : html`<span class="faint">none</span>`;
export const candLink = (id: string | null | undefined, label?: string) =>
  id ? html`<a class="link nowrap" href="/candidates/${id}" title="${id}">${label ?? shortHex(id)}</a>` : html`<span class="faint">TBA</span>`;
export const linLink = (id: string | null | undefined, label?: string) =>
  id ? html`<a class="link nowrap" href="/lineages/${id}" title="${id}">${label ?? lineageName(id)}</a>` : html`<span class="faint">TBA</span>`;
export const epochLink = (n: number | null | undefined) => (n === null || n === undefined ? html`<span class="faint">TBA</span>` : html`<a class="link" href="/epochs/${n}">${n}</a>`);
export const blobLink = (sha: string | null | undefined, label = "transcript") =>
  sha ? html`<a class="link nowrap" href="/api/blobs/${sha}" target="_blank" rel="noopener" title="GET /v1/blobs/${sha}">${icon.file} ${label}</a>` : html`<span class="faint">no transcript</span>`;

export function kindBadge(kind: string | null | undefined, t?: unknown): Raw {
  if (!kind) return html``;
  return html`<span class="b kind">${kind}${t !== undefined ? html` <span class="dim">${target(t)}</span>` : ""}</span>`;
}

export function panel(title: string | Raw, body: Raw, opts: { count?: number | string; aside?: Raw; cls?: string; id?: string; note?: Raw } = {}): Raw {
  return html`<section class="panel ${opts.cls ?? ""}"${opts.id ? raw(` id="${esc(opts.id)}"`) : ""}>
    <div class="panel-h"><h2>${title}${opts.count !== undefined ? html` <span class="count num">${opts.count}</span>` : ""}</h2>${opts.aside ? html`<div class="aside">${opts.aside}</div>` : ""}</div>
    ${body}
    ${opts.note ? html`<div class="panel-note">${opts.note}</div>` : ""}
  </section>`;
}

export function empty(t1: string, t2?: Raw | string): Raw {
  return html`<div class="empty"><div class="t1">${t1}</div>${t2 ? html`<div style="margin-top:4px">${t2}</div>` : ""}</div>`;
}

export function banner(tone: "warn" | "bad" | "info", t1: string | Raw, t2?: string | Raw): Raw {
  const ic = tone === "info" ? icon.info : tone === "bad" ? icon.x : icon.warn;
  return html`<div class="banner ${tone}">${ic}<div><div class="t1">${t1}</div>${t2 ? html`<div class="t2">${t2}</div>` : ""}</div></div>`;
}

export function kv(rows: [string, unknown][]): Raw {
  return html`<div class="kv">${rows.map(([k, v]) => html`<div>${k}</div><div>${v === null || v === undefined || v === "" ? html`<span class="faint">TBA</span>` : v}</div>`)}</div>`;
}

export function stat(label: string, value: Raw | string, sub?: Raw | string, cls = ""): Raw {
  return html`<div class="stat"><div class="eyebrow">${label}</div><div class="v ${cls}">${value}</div>${sub !== undefined ? html`<div class="s">${sub}</div>` : ""}</div>`;
}
