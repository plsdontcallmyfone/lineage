// The docs site's only script (<base>/assets/docs.js): the live figures, the search palette (button,
// Cmd or Ctrl+K, or "/"), the page menu drawer at phone width, the "On this page" scroll spy, tabs,
// copy buttons and opening a folded block a link points into. Every {{cfg:...}}, {{market:...}},
// {{stats:...}} and {{guard:...}} tag was rendered as a TBA span with data-live; this fills it from
// Core's GET /v1/config, /v1/stats and /v1/guard-config (through the site's /api proxy) and the market
// indexer's /market/tokens. A figure none of them answers for stays TBA. The site has one theme
// (light, like the main website), so there is no theme switch. Search reads <base>/assets/search.json,
// built with the pages, and runs in the browser. The pages read fully without this script: the side
// menu, every tab panel's first tab and every link work as plain HTML.
import { loadConfig } from "../../web/src/api.ts";
import { paramValue } from "../../web/src/params.ts";

const BASE = document.body.dataset.docsBase ?? "/docs";
const esc = (v: unknown) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

// ---- top bar: a hairline under it once the page scrolls ----
const bar = document.querySelector<HTMLElement>(".dc-top");
const onScroll = () => bar?.classList.toggle("is-scrolled", window.scrollY > 4);
window.addEventListener("scroll", onScroll, { passive: true });
onScroll();

// ---- page menu: a drawer under 1024 px ----
const side = $("dc-side");
const menu = $<HTMLButtonElement>("dc-menu");
const scrim = $("dc-scrim");
function drawer(open: boolean) {
  if (!side || !menu || !scrim) return;
  side.classList.toggle("is-open", open);
  scrim.hidden = !open;
  menu.setAttribute("aria-expanded", String(open));
  document.documentElement.classList.toggle("dc-lock", open);
  if (open) (side.querySelector<HTMLElement>('a[aria-current="page"]') ?? $("dc-menu-x"))?.focus({ preventScroll: true });
  else menu.focus({ preventScroll: true });
}
menu?.addEventListener("click", () => drawer(!side?.classList.contains("is-open")));
$("dc-menu-x")?.addEventListener("click", () => drawer(false));
scrim?.addEventListener("click", () => drawer(false));
// the current page stays in view in a long menu
side?.querySelector<HTMLElement>('a[aria-current="page"]')?.scrollIntoView({ block: "nearest" });
// the section tabs scroll sideways at phone width: bring the current one into view
const tabNow = document.querySelector<HTMLElement>('.dc-tabl[aria-current="true"]');
if (tabNow?.parentElement) tabNow.parentElement.scrollLeft = Math.max(0, tabNow.offsetLeft - 16);

// ---- "On this page": the section being read is marked ----
const tocLinks = [...document.querySelectorAll<HTMLAnchorElement>("#dc-toc a")];
if (tocLinks.length) {
  const heads = tocLinks.map((a) => document.getElementById(decodeURIComponent(a.hash.slice(1)))).filter((h): h is HTMLElement => !!h);
  let cur = -1;
  const spy = () => {
    const line = (bar?.offsetHeight ?? 0) + 24;
    let k = 0;
    for (let i = 0; i < heads.length; i++) if (heads[i]!.getBoundingClientRect().top <= line) k = i;
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) k = heads.length - 1;
    if (k === cur) return;
    cur = k;
    tocLinks.forEach((a, i) => (i === k ? a.setAttribute("aria-current", "location") : a.removeAttribute("aria-current")));
    tocLinks[k]?.scrollIntoView({ block: "nearest" });
  };
  let queued = false;
  window.addEventListener("scroll", () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => ((queued = false), spy()));
  }, { passive: true });
  spy();
}

// ---- a link into a folded block (an FAQ answer, an API route, a tab) opens it ----
function reveal() {
  const id = decodeURIComponent(location.hash.slice(1));
  const el = id ? document.getElementById(id) : null;
  if (!el) return;
  let moved = false;
  for (let p: HTMLElement | null = el; p; p = p.parentElement) {
    if (p instanceof HTMLDetailsElement && !p.open) (p.open = true), (moved = true);
    if (p.classList.contains("dc-tab") && p.hidden) (select(document.getElementById(p.getAttribute("aria-labelledby")!) as HTMLButtonElement, false), (moved = true));
  }
  if (moved) el.scrollIntoView();
}
window.addEventListener("hashchange", reveal);

// ---- tabs: arrow keys move, tabs with the same labels on a page switch together ----
function select(tab: HTMLButtonElement, sync: boolean) {
  const list = tab.parentElement!;
  for (const t of list.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    const panel = document.getElementById(t.getAttribute("aria-controls")!);
    if (panel) panel.hidden = !on;
  }
  if (!sync) return;
  const label = tab.textContent;
  for (const other of document.querySelectorAll<HTMLButtonElement>('[data-tabs] [role="tab"]'))
    if (other !== tab && other.textContent === label && other.getAttribute("aria-selected") !== "true") select(other, false);
}
for (const list of document.querySelectorAll<HTMLElement>("[data-tabs] .dc-tabs-l")) {
  const tabs = [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  list.addEventListener("click", (ev) => {
    const t = (ev.target as HTMLElement).closest<HTMLButtonElement>('[role="tab"]');
    if (t) select(t, true);
  });
  list.addEventListener("keydown", (ev) => {
    const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
    const to = ev.key === "ArrowRight" ? i + 1 : ev.key === "ArrowLeft" ? i - 1 : ev.key === "Home" ? 0 : ev.key === "End" ? tabs.length - 1 : null;
    if (i < 0 || to === null) return;
    ev.preventDefault();
    const t = tabs[(to + tabs.length) % tabs.length]!;
    select(t, true);
    t.focus();
  });
}
reveal();

// ---- copy buttons ----
document.addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("[data-copy]");
  if (!b) return;
  const pre = b.closest(".dc-codeb, .dc-fold-b")?.querySelector("pre");
  const label = b.querySelector("span");
  if (!pre || !label) return;
  const done = (ok: boolean) => {
    label.textContent = ok ? "Copied" : "Not copied";
    b.classList.toggle("is-done", ok);
    setTimeout(() => ((label.textContent = "Copy"), b.classList.remove("is-done")), 1600);
  };
  if (!navigator.clipboard) return done(false);
  navigator.clipboard.writeText(pre.textContent ?? "").then(() => done(true), () => done(false));
});

// ---- live figures ----
/** A nested config value: "prepay.min_usd" reads cfg.prepay.min_usd. */
function pick(cfg: Record<string, unknown>, key: string): unknown {
  let v: unknown = cfg;
  for (const k of key.split(".")) {
    if (!v || typeof v !== "object" || !Object.prototype.hasOwnProperty.call(v, k)) return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

function cfgText(key: string, v: unknown, cfg: Record<string, unknown>): string | null {
  if (v === undefined || v === null || key === "_note") return null;
  const leaf = key.split(".").pop()!;
  const quote = (pick(cfg, "prepay.rate_status") === "test" ? "tUNITS" : "$UNITS");
  if (leaf.endsWith("_usd")) return `${v} USD`;
  if (leaf.endsWith("_lamports") && /^\d+$/.test(String(v))) return `${Number(v) / 1e9} SOL`;
  if (leaf === "line_per_usd" || leaf === "compute_price_line_per_usd") return `${v} ${quote} per USD`;
  if (leaf === "compute_price_line_per_sandbox_s") return `${v} ${quote} per sandbox second`;
  if (Array.isArray(v)) return v.join(" to ");
  if (leaf === "finder_share" && typeof v === "number") return `${Math.round(v * 100)}%`;
  // amounts paramValue does not list (challenge bond and reward) format like any bond amount
  const t = paramValue(leaf === "challenge_bond" || leaf === "challenge_reward" ? "min_bond" : leaf, v);
  return t === "TBA" ? null : t.replace("$UNITS", quote);
}

const json = (path: string) => fetch(path, { headers: { accept: "application/json" } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : null);
const percent = (f: unknown) => (typeof f === "number" && Number.isFinite(f) ? `${+(f * 100).toFixed(4)}%` : null);
const utc = (ms: unknown) => (typeof ms === "number" && ms > 0 ? `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC` : null);

/** A figure of GET /v1/stats: counters as they are ("units" reads the stored field `lineages`). */
function statsText(key: string, st: Record<string, unknown>): string | null {
  return count(st[key === "units" ? "lineages" : key]);
}

/** A figure of GET /v1/guard-config: the version in force. */
function guardText(key: string, g: { activation_ms?: number; current?: Record<string, unknown> | null }): string | null {
  const cur = g.current;
  if (key === "activation") return utc(g.activation_ms);
  if (!cur) return null;
  if (key === "default_max_regression") return percent(cur.default_max_regression);
  if (key === "version") return count(cur.version);
  if (key === "kinds" && Array.isArray(cur.kinds)) return cur.kinds.join(", ");
  if (key === "overrides" && cur.overrides && typeof cur.overrides === "object") return count(Object.keys(cur.overrides).length);
  return null;
}

async function fill() {
  const spans = [...document.querySelectorAll<HTMLElement>("[data-live]")];
  if (!spans.length) return;
  const need = (kind: string) => spans.some((s) => s.dataset.live!.startsWith(`${kind}:`));
  const [cfg, tokens, stats, guard] = await Promise.all([
    need("cfg") ? loadConfig().catch(() => null) : null,
    need("market") ? json("/market/tokens?limit=500") : null,
    need("stats") ? json("/api/stats") : null,
    need("guard") ? json("/api/guard-config") : null,
  ]);
  const SOURCE: Record<string, string> = { cfg: "GET /v1/config", market: "the market indexer", stats: "GET /v1/stats", guard: "GET /v1/guard-config" };
  for (const s of spans) {
    const [kind, key] = s.dataset.live!.split(":") as [string, string];
    let v: string | null = null;
    if (kind === "cfg" && cfg) v = cfgText(key, pick(cfg as unknown as Record<string, unknown>, key), cfg as unknown as Record<string, unknown>);
    else if (kind === "stats" && stats) v = statsText(key, stats);
    else if (kind === "guard" && guard) v = guardText(key, guard);
    else if (kind === "market" && tokens) {
      if (key === "tokens") v = String(tokens.total ?? tokens.count ?? tokens.tokens.length);
      else if (key === "graduated" && tokens.total === tokens.tokens.length) v = String(tokens.tokens.filter((t: { phase: string }) => t.phase === "graduated").length);
      else if (key === "working" && tokens.total === tokens.tokens.length) v = String(tokens.tokens.filter((t: { state?: string }) => t.state === "working").length);
    }
    if (v === null) continue;
    s.textContent = v;
    s.classList.remove("tba");
    s.title = `read live from ${SOURCE[kind]}${kind === "cfg" ? ` (${key})` : ""}`;
  }
}
void fill();

// ---- search ----
interface Entry {
  p: string;
  h: string;
  u: string;
  x: string;
}
const q = document.getElementById("dc-q") as HTMLInputElement | null;
const res = document.getElementById("dc-res");
let index: Entry[] | null = null;
let loading: Promise<void> | null = null;
let active = -1;
const load = () =>
  (loading ??= fetch(`${BASE}/assets/search.json`)
    .then((r) => (r.ok ? r.json() : []))
    .then((j: Entry[]) => void (index = j))
    .catch(() => void (index = [])));

function snippet(x: string, terms: string[]): string {
  const low = x.toLowerCase();
  const at = Math.max(0, Math.min(...terms.map((t) => low.indexOf(t)).filter((i) => i >= 0), x.length) - 40);
  let s = (at ? "..." : "") + x.slice(at, at + 160) + (at + 160 < x.length ? "..." : "");
  s = esc(s);
  for (const t of terms) if (t.length > 1) s = s.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "<mark>$1</mark>");
  return s;
}

function search(text: string): { e: Entry; score: number }[] {
  const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length || !index) return [];
  const out: { e: Entry; score: number }[] = [];
  for (const e of index) {
    const hp = `${e.p} ${e.h}`.toLowerCase();
    const x = e.x.toLowerCase();
    let score = 0;
    let all = true;
    for (const t of terms) {
      const inH = hp.includes(t);
      const inX = x.includes(t);
      if (!inH && !inX) {
        all = false;
        break;
      }
      score += (inH ? 5 : 0) + (inX ? 1 + Math.min(3, x.split(t).length - 2) * 0.25 : 0);
    }
    if (all) out.push({ e, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 12);
}

function render() {
  if (!q || !res) return;
  const text = q.value.trim();
  q.setAttribute("aria-expanded", String(!!text));
  if (!text) {
    res.innerHTML = "";
    return;
  }
  const hits = search(text);
  const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
  active = hits.length ? 0 : -1;
  res.innerHTML = hits.length
    ? hits
        .map(
          (h, i) =>
            `<a class="dc-hit${i === 0 ? " on" : ""}" role="option" href="${esc(h.e.u)}"><span class="dc-hit-t">${esc(h.e.p)}${h.e.h ? ` <span class="dc-hit-h">${esc(h.e.h)}</span>` : ""}</span><span class="dc-hit-x">${snippet(h.e.x, terms)}</span></a>`,
        )
        .join("")
    : `<div class="dc-none">Nothing found for "${esc(text)}". Try one word, or a route such as /v1/stats.</div>`;
}

function move(d: number) {
  if (!res) return;
  const hits = [...res.querySelectorAll<HTMLElement>(".dc-hit")];
  if (!hits.length) return;
  active = (active + d + hits.length) % hits.length;
  hits.forEach((h, i) => h.classList.toggle("on", i === active));
  hits[active]!.scrollIntoView({ block: "nearest" });
}

// the palette: a modal dialog, so focus stays inside it and Escape closes it
const palette = $<HTMLDialogElement>("dc-palette");
function openSearch() {
  if (!palette || !q || palette.open) return;
  if (side?.classList.contains("is-open")) drawer(false);
  palette.showModal();
  void load();
  q.focus();
  q.select();
}
function closeSearch() {
  if (palette?.open) palette.close();
}
$("dc-search-open")?.addEventListener("click", openSearch);
$("dc-palette-x")?.addEventListener("click", closeSearch);
palette?.addEventListener("click", (ev) => ev.target === palette && closeSearch()); // a click on the backdrop
const mac = /Mac|iPhone|iPad/.test(navigator.platform);
const k = $("dc-k");
if (k && mac) k.textContent = "\u2318 K";

q?.addEventListener("input", () => void load().then(render));
q?.addEventListener("keydown", (ev) => {
  if (ev.key === "ArrowDown") (ev.preventDefault(), move(1));
  else if (ev.key === "ArrowUp") (ev.preventDefault(), move(-1));
  else if (ev.key === "Enter") {
    const hit = res?.querySelectorAll<HTMLAnchorElement>(".dc-hit")[active];
    if (hit) (ev.preventDefault(), closeSearch(), (location.href = hit.href));
  } else if (ev.key === "Escape") {
    // a search field would only clear itself on the first Escape
    ev.preventDefault();
    closeSearch();
  }
});
res?.addEventListener("click", (ev) => (ev.target as HTMLElement).closest(".dc-hit") && closeSearch());
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && side?.classList.contains("is-open")) return drawer(false);
  if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && ev.key.toLowerCase() === "k") {
    ev.preventDefault();
    return palette?.open ? closeSearch() : openSearch();
  }
  if (ev.key !== "/" || palette?.open) return;
  const t = ev.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  ev.preventDefault();
  openSearch();
});
