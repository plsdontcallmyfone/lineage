import { ApiError, loadConfig, loadLineageNames, recent, state, type Ev } from "./api.ts";
import { mountCharts } from "./chart.ts";
import { feedItem } from "./feed.ts";
import { ago, dur } from "./fmt.ts";
import { esc, html } from "./html.ts";
import { live, MAX_FEED } from "./live.ts";
import { agentPage, agentsPage } from "./pages/agents.ts";
import { candidatePage } from "./pages/candidate.ts";
import { docsPage } from "./pages/docs.ts";
import { epochsPage } from "./pages/epochs.ts";
import { explorerPage } from "./pages/explorer.ts";
import { generationPage } from "./pages/generation.ts";
import { lineagePage } from "./pages/lineage.ts";
import { livePage } from "./pages/live.ts";
import { sessionPage, sessionsPage } from "./pages/session.ts";
import { tokenPage } from "./pages/token.ts";
import { tokensPage } from "./pages/tokens.ts";
import { machinesPage } from "./pages/machines.ts";
import { manualPage } from "./pages/manual.ts";
import { onLaunchInput, spawnPage } from "./pages/spawn.ts";
import { walletPage } from "./pages/wallet.ts";
import { feedAccepts, feedBody, overview } from "./pages/overview.ts";
import type { Page } from "./pages/types.ts";
import { icon, logo } from "./ui.ts";

// ------------------------------------------------------------------------------------------------
// routing

type Handler = (params: string[]) => Promise<Page>;
const routes: [RegExp, Handler, string][] = [
  [/^\/$/, overview, "/"],
  [/^\/lineages\/([0-9a-f]{64})$/, lineagePage, "/"],
  [/^\/generations\/([0-9a-f]{64})$/, generationPage, "/"],
  [/^\/candidates\/([0-9a-f]{64})$/, candidatePage, "/"],
  [/^\/agents$/, agentsPage, "/agents"],
  [/^\/agents\/([1-9A-HJ-NP-Za-km-z]{32,44})$/, agentPage, "/agents"],
  [/^\/epochs$/, epochsPage, "/epochs"],
  [/^\/epochs\/(\d+)$/, epochsPage, "/epochs"],
  [/^\/live$/, livePage, "/live"],
  [/^\/sessions$/, sessionsPage, "/live"],
  [/^\/(?:sessions|live\/agent)\/([0-9a-f]{64})$/, sessionPage, "/live"],
  [/^\/tokens$/, tokensPage, "/tokens"],
  [/^\/tokens\/([1-9A-HJ-NP-Za-km-z]{32,44})$/, tokenPage, "/tokens"],
  [/^\/machines$/, machinesPage, "/machines"],
  [/^\/spawn$/, spawnPage, "/spawn"],
  [/^\/wallet$/, walletPage, "/wallet"],
  [/^\/manual$/, manualPage, "/manual"],
  [/^\/explorer$/, explorerPage, "/explorer"],
  [/^\/docs$/, docsPage, "/docs"],
  [/^\/docs\/([a-z0-9-]+)$/, docsPage, "/docs"],
];
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
        <a href="/" data-nav="/">Network</a>
        <a href="/live" data-nav="/live">Live</a>
        <a href="/machines" data-nav="/machines">Machines</a>
        <a href="/agents" data-nav="/agents">Agents</a>
        <a href="/tokens" data-nav="/tokens">Tokens</a>
        <a href="/epochs" data-nav="/epochs">Epochs</a>
        <a href="/spawn" data-nav="/spawn">Spawn</a>
        <a href="/wallet" data-nav="/wallet">Wallet</a>
        <a href="/explorer" data-nav="/explorer">Explorer</a>
        <a href="/docs" data-nav="/docs">Docs</a>
        <a href="/manual" data-nav="/manual">Manual</a>
      </nav>
      <div class="top-right">
        <span class="live" id="live" data-s="${live.upstream}" title="Core event stream"><i></i><span id="live-t">connecting</span></span>
        <button class="iconbtn" id="theme" type="button" aria-label="Toggle colour theme">${icon.moon}</button>
      </div>
    </div></header>
    <main id="main" aria-live="polite"></main>
    <footer class="foot"><span>Read-only view of Core. Every figure is read from Core; values Core does not hold show as TBA.</span><span>Token amounts in $LINE (placeholder), formatted with token_decimals from <span class="num">GET /v1/config</span>.</span><span id="core-url"></span></footer>`.s;
  updateThemeIcon();
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
  if (err.status === 404) return html`<div class="panel errorbox"><h1>Not found</h1><p>Core has no record with this id (${err.code}: ${err.message}).</p><p><a class="link" href="/">Back to the network overview</a></p></div>`;
  return html`<div class="panel errorbox"><h1>Could not load this page</h1><p>${err.code}: ${err.message}</p></div>`;
}

async function render(opts: { soft?: boolean } = {}) {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  const main = document.getElementById("main")!;
  const seq = ++renderSeq;
  const match = routes.map(([re, h, nav]) => ({ m: re.exec(path), h, nav })).find((x) => x.m);
  if (!match) {
    main.innerHTML = html`<div class="panel errorbox"><h1>No such page</h1><p><a class="link" href="/">Back to the network overview</a></p></div>`.s;
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
    document.title = page.title === "Network" ? "Lineage Network" : `${page.title} | Lineage`;
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
  const el = document.getElementById("live");
  const t = document.getElementById("live-t");
  if (el) el.dataset.s = s;
  if (t) t.textContent = s === "open" ? "Live" : s === "down" ? "Core offline" : "Connecting";
}

function onEvent(e: Ev) {
  if (e.id <= live.lastId) return;
  live.lastId = e.id;
  live.events.unshift(e);
  if (live.events.length > MAX_FEED) live.events.length = MAX_FEED;
  if (e.type === "lineage.created" || e.type === "recipe.added") loadLineageNames(true).catch(() => {});
  const feed = document.getElementById("feed");
  if (feed && feedAccepts(e)) {
    if (feed.querySelector(".empty")) feed.innerHTML = feedBody().s;
    else {
      feed.insertAdjacentHTML("afterbegin", feedItem(e, true).s);
      const items = feed.querySelectorAll(".feed-item");
      for (let i = 150; i < items.length; i++) items[i]!.remove();
    }
  }
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
    const feed = document.getElementById("feed");
    if (feed) feed.innerHTML = feedBody().s;
    render({ soft: true });
  });
  es.onerror = () => setLive("down");
  es.onopen = () => {
    if (live.upstream === "down") setLive("open");
  };
}

// ------------------------------------------------------------------------------------------------
// theme, tooltips, clicks, timers

function systemDark() {
  return matchMedia("(prefers-color-scheme: dark)").matches;
}
function isDark() {
  const t = document.documentElement.getAttribute("data-theme");
  return t ? t === "dark" : systemDark();
}
function updateThemeIcon() {
  const b = document.getElementById("theme");
  if (b) b.innerHTML = (isDark() ? icon.sun : icon.moon).s;
}

document.addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  if (t.closest("#theme")) {
    const next = isDark() ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
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
  const mode = t.closest<HTMLElement>("[data-feed-mode]");
  if (mode) {
    live.mode = mode.dataset.feedMode as "key" | "all";
    for (const b of document.querySelectorAll<HTMLElement>("[data-feed-mode]")) b.setAttribute("aria-pressed", String(b.dataset.feedMode === live.mode));
    const feed = document.getElementById("feed");
    if (feed) feed.innerHTML = feedBody().s;
    return;
  }
  if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
  const a = t.closest<HTMLAnchorElement>("a[href]");
  if (a) {
    const url = new URL(a.href, location.href);
    if (url.origin === location.origin && !a.target && !url.pathname.startsWith("/api/")) {
      ev.preventDefault();
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

document.addEventListener("input", (ev) => {
  const form = (ev.target as HTMLElement).closest?.<HTMLFormElement>("form[data-launch-form]");
  if (form) onLaunchInput(form);
});
document.addEventListener("change", (ev) => {
  const form = (ev.target as HTMLElement).closest?.<HTMLFormElement>("form[data-launch-form]");
  if (form) onLaunchInput(form);
});
document.addEventListener("submit", (ev) => {
  if ((ev.target as HTMLElement).matches?.("form[data-launch-form]")) ev.preventDefault();
});

let rz: ReturnType<typeof setTimeout> | null = null;
window.addEventListener("resize", () => {
  if (rz) clearTimeout(rz);
  rz = setTimeout(() => mountCharts(document), 120);
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", updateThemeIcon);

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
