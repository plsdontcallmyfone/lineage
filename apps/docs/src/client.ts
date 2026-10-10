// The docs site's only script (<base>/assets/docs.js): the theme toggle, the live figures, the search
// box and the phone page menu. Every {{cfg:...}} and {{market:...}} tag was rendered as a TBA span with
// data-live; this fills it from Core's GET /v1/config (through the site's /api proxy) and the market
// indexer's /market/tokens. A figure neither answers for stays TBA. Search reads <base>/assets/search.json,
// built with the pages, and runs in the browser. Nothing else runs on these pages.
import { loadConfig } from "../../web/src/api.ts";
import { paramValue } from "../../web/src/params.ts";

const SUN = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="3"/><path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3 3l1.1 1.1M11.9 11.9L13 13M3 13l1.1-1.1M11.9 4.1L13 3"/></svg>';
const MOON = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 9.8A5.8 5.8 0 016.2 2.5a5.8 5.8 0 107.3 7.3z"/></svg>';
const isDark = () => document.documentElement.getAttribute("data-theme") !== "light";
const themeBtn = document.getElementById("theme");
const paintTheme = () => themeBtn && (themeBtn.innerHTML = isDark() ? SUN : MOON);
paintTheme();
themeBtn?.addEventListener("click", () => {
  const next = isDark() ? "light" : "dark";
  if (next === "light") document.documentElement.setAttribute("data-theme", "light");
  else document.documentElement.removeAttribute("data-theme");
  try {
    localStorage.setItem("lineage-theme", next);
  } catch {
    /* storage blocked */
  }
  paintTheme();
});

const BASE = document.body.dataset.docsBase ?? "/docs";
const esc = (v: unknown) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// ---- header: the app's blur under the bar once the page scrolls (app.css .top.is-scrolled) ----
const bar = document.querySelector<HTMLElement>(".top");
const onScroll = () => bar?.classList.toggle("is-scrolled", window.scrollY > 4);
window.addEventListener("scroll", onScroll, { passive: true });
onScroll();

// ---- phone page menu: the page list folds into one row under 860 px ----
const pages = document.getElementById("dc-pages") as HTMLDetailsElement | null;
if (pages && window.matchMedia("(max-width: 860px)").matches) pages.open = false;

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
  const quote = (pick(cfg, "prepay.rate_status") === "test" ? "tLINE" : "$LINE");
  if (leaf.endsWith("_usd")) return `${v} USD`;
  if (leaf === "line_per_usd" || leaf === "compute_price_line_per_usd") return `${v} ${quote} per USD`;
  if (leaf === "compute_price_line_per_sandbox_s") return `${v} ${quote} per sandbox second`;
  if (Array.isArray(v)) return v.join(" to ");
  if (leaf === "finder_share" && typeof v === "number") return `${Math.round(v * 100)}%`;
  // amounts paramValue does not list (challenge bond and reward) format like any bond amount
  const t = paramValue(leaf === "challenge_bond" || leaf === "challenge_reward" ? "min_bond" : leaf, v);
  return t === "TBA" ? null : t.replace("$LINE", quote);
}

async function fill() {
  const spans = [...document.querySelectorAll<HTMLElement>("[data-live]")];
  if (!spans.length) return;
  const needCfg = spans.some((s) => s.dataset.live!.startsWith("cfg:"));
  const needMarket = spans.some((s) => s.dataset.live!.startsWith("market:"));
  const [cfg, tokens] = await Promise.all([
    needCfg ? loadConfig().catch(() => null) : null,
    needMarket ? fetch("/market/tokens?limit=500", { headers: { accept: "application/json" } }).then((r) => (r.ok ? r.json() : null)).catch(() => null) : null,
  ]);
  for (const s of spans) {
    const [kind, key] = s.dataset.live!.split(":") as [string, string];
    let v: string | null = null;
    if (kind === "cfg" && cfg) v = cfgText(key, pick(cfg as unknown as Record<string, unknown>, key), cfg as unknown as Record<string, unknown>);
    else if (kind === "market" && tokens) {
      if (key === "tokens") v = String(tokens.total ?? tokens.count ?? tokens.tokens.length);
      else if (key === "graduated" && tokens.total === tokens.tokens.length) v = String(tokens.tokens.filter((t: { phase: string }) => t.phase === "graduated").length);
      else if (key === "working" && tokens.total === tokens.tokens.length) v = String(tokens.tokens.filter((t: { state?: string }) => t.state === "working").length);
    }
    if (v === null) continue;
    s.textContent = v;
    s.classList.remove("tba");
    s.title = kind === "cfg" ? `live value of ${key} from GET /v1/config` : "live from the market indexer";
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
  if (!text) {
    res.hidden = true;
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
    : `<div class="dc-none">Nothing found for "${esc(text)}".</div>`;
  res.hidden = false;
}

function move(d: number) {
  if (!res) return;
  const hits = [...res.querySelectorAll<HTMLElement>(".dc-hit")];
  if (!hits.length) return;
  active = (active + d + hits.length) % hits.length;
  hits.forEach((h, i) => h.classList.toggle("on", i === active));
  hits[active]!.scrollIntoView({ block: "nearest" });
}

q?.addEventListener("focus", () => void load());
q?.addEventListener("input", () => void load().then(render));
q?.addEventListener("keydown", (ev) => {
  if (ev.key === "ArrowDown") (ev.preventDefault(), move(1));
  else if (ev.key === "ArrowUp") (ev.preventDefault(), move(-1));
  else if (ev.key === "Enter") {
    const hit = res?.querySelectorAll<HTMLAnchorElement>(".dc-hit")[active];
    if (hit) (ev.preventDefault(), (location.href = hit.href));
  } else if (ev.key === "Escape") {
    q.value = "";
    render();
    q.blur();
  }
});
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "/" || !q || document.activeElement === q) return;
  const t = ev.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  ev.preventDefault();
  q.focus();
});
document.addEventListener("click", (ev) => {
  if (!res || res.hidden) return;
  if (!(ev.target as HTMLElement).closest(".dc-search")) res.hidden = true;
});
