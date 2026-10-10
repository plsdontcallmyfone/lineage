// The docs site's only script (/docs/assets/docs.js): the theme toggle and the live figures. Every
// {{cfg:...}} and {{market:...}} tag was rendered as a TBA span with data-live; this fills it from
// Core's GET /v1/config (through the site's /api proxy) and the market indexer's /market/tokens. A
// figure neither answers for stays TBA. Nothing else runs on these pages.
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

async function fill() {
  const spans = [...document.querySelectorAll<HTMLElement>("[data-live]")];
  if (!spans.length) return;
  const needCfg = spans.some((s) => s.dataset.live!.startsWith("cfg:"));
  const needMarket = spans.some((s) => s.dataset.live!.startsWith("market:"));
  const [cfg, tokens] = await Promise.all([
    needCfg ? loadConfig().catch(() => null) : null,
    needMarket ? fetch("/market/tokens?limit=200", { headers: { accept: "application/json" } }).then((r) => (r.ok ? r.json() : null)).catch(() => null) : null,
  ]);
  for (const s of spans) {
    const [kind, key] = s.dataset.live!.split(":") as [string, string];
    let v: string | null = null;
    if (kind === "cfg" && cfg && Object.prototype.hasOwnProperty.call(cfg, key) && key !== "_note") {
      v = paramValue(key, (cfg as Record<string, unknown>)[key]);
      if (v === "TBA") v = null;
    } else if (kind === "market" && tokens) {
      if (key === "tokens") v = String(tokens.total ?? tokens.count ?? tokens.tokens.length);
      else if (key === "graduated" && tokens.total === tokens.tokens.length) v = String(tokens.tokens.filter((t: { phase: string }) => t.phase === "graduated").length);
    }
    if (v === null) continue;
    s.textContent = v;
    s.classList.remove("tba");
    s.title = kind === "cfg" ? `live value of ${key} from GET /v1/config` : "live from the market indexer";
  }
}
void fill();
