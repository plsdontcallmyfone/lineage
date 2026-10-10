import { ApiError, loadConfig, loadLineageNames, recent, state, type Ev } from "./api.ts";
import { mountCharts } from "./chart.ts";
import { ago, dur } from "./fmt.ts";
import { esc, html } from "./html.ts";
import { live, MAX_FEED } from "./live.ts";
import { closeEco, ecoHtml, toggleEco } from "./eco.ts";
import { connectHtml, wireConnect } from "./connect.ts";
import { agentPage, agentsPage } from "./pages/agents.ts";
import { agentProfilePage } from "./pages/agent-profile.ts";
import { feedPage, followingPage } from "./pages/feed.ts";
import { leaderboardPage } from "./pages/leaderboard.ts";
import { candidatePage } from "./pages/candidate.ts";
import { epochsPage } from "./pages/epochs.ts";
import { explorerPage } from "./pages/explorer.ts";
import { generationPage } from "./pages/generation.ts";
import { lineagePage } from "./pages/lineage.ts";
import { sessionPage, sessionsPage } from "./pages/session.ts";
import { tokenPage } from "./pages/token.ts";
import { tokensPage } from "./pages/tokens.ts";
import { tradingAgentPage, tradingPage } from "./pages/trading.ts";
import { machinesPage } from "./pages/machines.ts";
import { launchPage } from "./pages/launch.ts";
import { profilePage } from "./pages/profile.ts";
import type { Page } from "./pages/types.ts";
import { icon, logo } from "./ui.ts";

// ------------------------------------------------------------------------------------------------
// routing

type Handler = (params: string[]) => Promise<Page>;
// The header has three destinations (Explorer, Launch, Profile); everything else is a deep link from
// them or an entry of the Eco sidebar. The third column is the header item a page lights up.
const routes: [RegExp, Handler, string][] = [
  [/^\/$/, explorerPage, "/"],
  [/^\/launch$/, launchPage, "/launch"],
  [/^\/profile$/, profilePage, "/profile"],
  [/^\/lineages\/([0-9a-f]{64})$/, lineagePage, "/"],
  [/^\/generations\/([0-9a-f]{64})$/, generationPage, "/"],
  [/^\/candidates\/([0-9a-f]{64})$/, candidatePage, "/"],
  [/^\/agents$/, agentsPage, ""],
  [/^\/agents\/([1-9A-HJ-NP-Za-km-z]{32,44})$/, agentPage, "/"],
  [/^\/agents\/([1-9A-HJ-NP-Za-km-z]{32,44})\/profile$/, agentProfilePage, "/"],
  [/^\/leaderboard$/, leaderboardPage, ""],
  [/^\/feed$/, feedPage, ""],
  [/^\/following$/, followingPage, ""],
  [/^\/epochs$/, epochsPage, ""],
  [/^\/epochs\/(\d+)$/, epochsPage, ""],
  [/^\/sessions$/, sessionsPage, "/"],
  [/^\/(?:sessions|live\/agent)\/([0-9a-f]{64})$/, sessionPage, "/"],
  [/^\/tokens$/, tokensPage, "/"],
  [/^\/tokens\/([1-9A-HJ-NP-Za-km-z]{32,44})$/, tokenPage, "/"],
  [/^\/trading$/, tradingPage, ""],
  [/^\/trading\/([1-9A-HJ-NP-Za-km-z]{32,44})$/, tradingAgentPage, ""],
  [/^\/machines$/, machinesPage, ""],
];
/** Removed pages (app consolidation): each goes to what replaced it. The server answers the same with a 302. */
export const REDIRECTS: Record<string, string> = { "/network": "/", "/live": "/", "/explorer": "/", "/wallet": "/profile", "/spawn": "/launch", "/manual": "/docs" };
/** Selected tab per [data-tabs] group, kept across background re-renders. */
const tabState = new Map<string, string>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

const app = document.getElementById("app")!;
let current: Page | null = null;
let currentPath = "";
let renderSeq = 0;

function shell() {
  app.innerHTML = html`<header class="top"><div class="top-in">
      <a class="brand" href="/">${logo}<span>Lineage</span><span class="ph">placeholder name</span></a>
      <nav class="nav" aria-label="Main">
        <a href="/" data-nav="/">Explorer</a>
        <a href="/launch" data-nav="/launch">Launch</a>
        <a href="/profile" data-nav="/profile">Profile</a>
      </nav>
      <div class="top-right">
        <button type="button" class="eco-btn" id="eco-open" aria-expanded="false" aria-controls="eco"><i class="eco-dot" id="live" data-s="${live.upstream}" title="Core event stream"></i>Eco</button>
        ${connectHtml()}
        <button class="iconbtn" id="theme" type="button" aria-label="Toggle colour theme">${icon.moon}</button>
      </div>
    </div></header>
    <main id="main" aria-live="polite"></main>
    ${ecoHtml()}
    <footer class="foot"><span>Every figure is read from Core, the market indexer or devnet; values none of them holds show as TBA.</span><span>Token amounts in $LINE (placeholder), formatted with token_decimals from <span class="num">GET /v1/config</span>.</span><span id="core-url"></span></footer>`.s;
  updateThemeIcon();
  wireConnect(document.getElementById("cn")!);
}

function setNav(section: string) {
  for (const a of document.querySelectorAll<HTMLAnchorElement>("[data-nav]")) {
    if (a.dataset.nav === section) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
}

function errorView(e: unknown) {
  const err = e instanceof ApiError ? e : new ApiError(0, "client", String((e as Error)?.message ?? e));
  if (err.code === "core_unreachable" || err.status === 502)
    return html`<div class="panel errorbox"><h1>Core is not answering</h1><p>${err.message}</p>
      <p>Start Core and reload: <code>bun packages/core/src/main.ts --port 9660 --admin-key &lt;path&gt;</code>, or point the dashboard elsewhere with <code>bun apps/web/server.ts --core &lt;url&gt;</code>.</p></div>`;
  if (err.status === 404) return html`<div class="panel errorbox"><h1>Not found</h1><p>Core has no record with this id (${err.code}: ${err.message}).</p><p><a class="link" href="/">Back to the explorer</a></p></div>`;
  return html`<div class="panel errorbox"><h1>Could not load this page</h1><p>${err.code}: ${err.message}</p></div>`;
}

async function render(opts: { soft?: boolean } = {}) {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  const to = REDIRECTS[path];
  if (to) {
    if (to === "/docs") return location.replace(to);
    history.replaceState(null, "", to + location.search + location.hash);
    return render(opts);
  }
  const main = document.getElementById("main")!;
  const seq = ++renderSeq;
  const match = routes.map(([re, h, nav]) => ({ m: re.exec(path), h, nav })).find((x) => x.m);
  if (!match) {
    setNav("");
    document.title = "No such page | Lineage";
    main.innerHTML = html`<div class="panel errorbox"><h1>No such page</h1><p><a class="link" href="/">Back to the explorer</a></p></div>`.s;
    return;
  }
  setNav(match.nav);
  if (!opts.soft && path !== currentPath) main.innerHTML = skeleton();
  try {
    const page = await match.h(match.m!.slice(1));
    if (seq !== renderSeq) return;
    const keep = saveUi(main);
    main.innerHTML = page.body.s;
    current = page;
    document.title = page.title === "Explorer" ? "Lineage Explorer" : `${page.title} | Lineage`;
    restoreUi(main, keep);
    restoreTabs(main);
    mountCharts(main);
    if (page.mount) void page.mount(main);
    tickTimes();
    if (path !== currentPath) {
      if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
      else window.scrollTo(0, 0);
    }
    currentPath = path;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = page.pollMs ? setInterval(() => render({ soft: true }), Math.max(3000, page.pollMs)) : null;
  } catch (e) {
    if (seq !== renderSeq) return;
    if (opts.soft) return; // keep the last good render on a failed background refresh
    main.innerHTML = errorView(e).s;
    current = null;
    currentPath = path;
  }
}

function skeleton() {
  const row = `<div style="padding:12px 14px;border-bottom:1px solid var(--line-soft)"><div class="skel" style="width:60%"></div><div class="skel" style="width:35%;margin-top:8px"></div></div>`;
  return `<div class="ph-row"><div class="ph-title"><div class="skel" style="width:120px"></div><div class="skel" style="width:280px;height:22px;margin-top:6px"></div></div></div>
    <section class="panel">${row.repeat(2)}</section><section class="panel" style="margin-top:16px">${row.repeat(6)}</section>`;
}

function saveUi(root: HTMLElement) {
  const scroll = [...root.querySelectorAll<HTMLElement>("[data-keep-scroll]")].map((el) => [el.id, el.scrollTop] as const);
  const open = [...root.querySelectorAll<HTMLDetailsElement>("details[open]")].map((d) => d.querySelector("summary")?.textContent ?? "");
  return { scroll, open };
}
function restoreUi(root: HTMLElement, s: ReturnType<typeof saveUi>) {
  for (const [id, top] of s.scroll) {
    const el = id ? document.getElementById(id) : null;
    if (el) el.scrollTop = top;
  }
  for (const d of root.querySelectorAll<HTMLDetailsElement>("details")) if (s.open.includes(d.querySelector("summary")?.textContent ?? "\u0000")) d.open = true;
}

function navigate(href: string) {
  history.pushState(null, "", href);
  render();
}

function restoreTabs(root: HTMLElement) {
  for (const g of root.querySelectorAll<HTMLElement>("[data-tabs]")) {
    const want = tabState.get(g.dataset.tabs!);
    if (want) selectTab(g, want);
  }
}
function selectTab(group: HTMLElement, tab: string) {
  for (const b of group.querySelectorAll<HTMLElement>("[data-tab]")) b.setAttribute("aria-pressed", String(b.dataset.tab === tab));
  const scope = group.closest(".panel") ?? document;
  for (const p of scope.querySelectorAll<HTMLElement>("[data-pane]")) p.hidden = p.dataset.pane !== tab;
}

/** Relative times (data-ago) and running durations (data-since) without re-rendering. */
function tickTimes() {
  const now = Date.now();
  for (const el of document.querySelectorAll<HTMLElement>("[data-ago]")) el.textContent = ago(Number(el.dataset.ago), now);
  for (const el of document.querySelectorAll<HTMLElement>("[data-since]")) el.textContent = dur(Math.max(0, Math.round((now - Number(el.dataset.since)) / 1000)));
}

// ------------------------------------------------------------------------------------------------
// live events

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    render({ soft: true });
  }, 900);
}

function setLive(s: string) {
  live.upstream = s;
  const text = s === "open" ? "Live" : s === "down" ? "Core offline" : "Connecting";
  for (const el of document.querySelectorAll<HTMLElement>("#live, #eco-live")) {
    el.dataset.s = s;
    el.title = `Core event stream: ${text}`;
  }
  const t = document.getElementById("eco-live-t");
  if (t) t.textContent = text;
}

function onEvent(e: Ev) {
  if (e.id <= live.lastId) return;
  live.lastId = e.id;
  live.events.unshift(e);
  if (live.events.length > MAX_FEED) live.events.length = MAX_FEED;
  if (e.type === "lineage.created" || e.type === "recipe.added") loadLineageNames(true).catch(() => {});
  // components that keep their own state (the token page's commits panel) listen here
  window.dispatchEvent(new CustomEvent("lineage:event", { detail: e }));
  if (current?.refreshOn?.(e)) scheduleRefresh();
}

async function connect() {
  try {
    const r = await recent({ limit: MAX_FEED });
    setLive(r.upstream);
    for (const e of [...r.events].reverse()) onEvent(e);
  } catch {
    setLive("down");
  }
  const es = new EventSource(`/live/events?since=${live.lastId}`);
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data));
    } catch {
      /* ignore */
    }
  };
  es.addEventListener("status", (m) => {
    try {
      setLive(JSON.parse((m as MessageEvent).data).upstream);
    } catch {
      /* ignore */
    }
  });
  es.addEventListener("reset", () => {
    // Core was replaced (new data dir): drop held events and reload the view
    live.events.length = 0;
    live.lastId = 0;
    render({ soft: true });
  });
  es.onerror = () => setLive("down");
  es.onopen = () => {
    if (live.upstream === "down") setLive("open");
  };
}

// ------------------------------------------------------------------------------------------------
// theme, tooltips, clicks, timers

/** Dark is the default; light is opted into with data-theme="light". */
function isDark() {
  return document.documentElement.getAttribute("data-theme") !== "light";
}
function updateThemeIcon() {
  const b = document.getElementById("theme");
  if (b) b.innerHTML = (isDark() ? icon.sun : icon.moon).s;
}

document.addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  if (t.closest("#theme")) {
    const next = isDark() ? "light" : "dark";
    if (next === "light") document.documentElement.setAttribute("data-theme", "light");
    else document.documentElement.removeAttribute("data-theme");
    try {
      localStorage.setItem("lineage-theme", next);
    } catch {
      /* storage blocked */
    }
    updateThemeIcon();
    return;
  }
  const tabBtn = t.closest<HTMLElement>("[data-tab]");
  const tabGroup = tabBtn?.closest<HTMLElement>("[data-tabs]");
  if (tabBtn && tabGroup) {
    tabState.set(tabGroup.dataset.tabs!, tabBtn.dataset.tab!);
    selectTab(tabGroup, tabBtn.dataset.tab!);
    return;
  }
  const copy = t.closest<HTMLElement>("[data-copy]");
  if (copy) {
    navigator.clipboard?.writeText(copy.dataset.copy ?? "").then(
      () => {
        const was = copy.innerHTML;
        copy.textContent = "Copied";
        setTimeout(() => (copy.innerHTML = was), 1200);
      },
      () => {},
    );
    return;
  }
  if (t.closest("#eco-open")) return toggleEco();
  if (t.closest("[data-eco-close]")) return closeEco();
  if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
  const a = t.closest<HTMLAnchorElement>("a[href]");
  if (a) {
    const url = new URL(a.href, location.href);
    // /docs is a separate static site (apps/docs): a full page load, outside the app shell
    if (url.origin === location.origin && !a.target && !url.pathname.startsWith("/api/") && !/^\/(docs|embed|assets)(\/|$)/.test(url.pathname)) {
      ev.preventDefault();
      if (a.closest("#eco")) closeEco();
      if (url.pathname !== location.pathname) navigate(url.pathname + url.hash);
      else if (url.hash) {
        history.replaceState(null, "", url.hash);
        document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
    return;
  }
  const row = t.closest<HTMLElement>("tr[data-href]");
  if (row && !window.getSelection()?.toString()) navigate(row.dataset.href!);
});

window.addEventListener("popstate", () => render());

const tip = document.getElementById("tip")!;
document.addEventListener("mouseover", (ev) => {
  const el = (ev.target as Element).closest?.("[data-tip]") as HTMLElement | null;
  if (!el) {
    tip.hidden = true;
    return;
  }
  tip.innerHTML = esc(el.getAttribute("data-tip") ?? "").replace(/\n/g, "<br>");
  tip.hidden = false;
});
document.addEventListener("mousemove", (ev) => {
  if (tip.hidden) return;
  const w = tip.offsetWidth;
  const x = Math.min(ev.clientX + 14, window.innerWidth - w - 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${ev.clientY + 16}px`;
});

setInterval(tickTimes, 1000);

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") closeEco();
});

let rz: ReturnType<typeof setTimeout> | null = null;
window.addEventListener("resize", () => {
  if (rz) clearTimeout(rz);
  rz = setTimeout(() => mountCharts(document), 120);
});


// ------------------------------------------------------------------------------------------------

shell();
fetch("/live/status")
  .then((r) => r.json())
  .then((s) => {
    state.coreUrl = s.core;
    const el = document.getElementById("core-url");
    if (el) el.textContent = `Core: ${s.core}`;
  })
  .catch(() => {});
loadConfig().catch(() => {});
connect();
render();
