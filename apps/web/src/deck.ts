// The deck (/deck): the Machines, Agents, Leaderboard and Feed pages open side by side as horizontal
// columns on one canvas, after the column deck in the owner's test project. Each column renders the
// page's own body (its renderer, mount, event refresh and poll), has a title bar (close, title menu to
// swap the page, drag stripes to reorder, filters and density toggles, an options menu) and the canvas
// ends in an "Add column" rail. The layout persists in localStorage. Opening a page from the nav
// (/deck?open=agents) adds its column once and scrolls to it with a zoom flourish.
import { mountCharts } from "./chart.ts";
import type { Ev } from "./api.ts";
import { esc, html, raw, type Raw } from "./html.ts";
import { directoryPage } from "./pages/directory.ts";
import { feedPage, followingPage } from "./pages/feed.ts";
import { leaderboardPage } from "./pages/leaderboard.ts";
import { machinesPage } from "./pages/machines.ts";
import type { Page } from "./pages/types.ts";

export const DECK_TYPES = ["machines", "agents", "leaderboard", "feed", "following"] as const;
export type DeckType = (typeof DECK_TYPES)[number];
const LABELS: Record<DeckType, string> = { machines: "Machines", agents: "Agents", leaderboard: "Leaderboard", feed: "Feed", following: "Following" };
const PAGES: Record<DeckType, () => Promise<Page>> = { machines: machinesPage, agents: directoryPage, leaderboard: leaderboardPage, feed: feedPage, following: followingPage };
/** Pages whose body depends on the URL query (their filter chips push a new query). */
const QUERY_PAGES = new Set<DeckType>(["leaderboard", "feed", "following"]);
const MAX_COLUMNS = 10;
const KEY = "lineage.deck.v1";

interface Col {
  id: string;
  type: DeckType;
  compact: boolean;
  filtersHidden: boolean;
}
interface Live {
  page: Page | null;
  timer: ReturnType<typeof setInterval> | null;
  refresh: ReturnType<typeof setTimeout> | null;
}

export const isDeckType = (x: unknown): x is DeckType => typeof x === "string" && (DECK_TYPES as readonly string[]).includes(x);

let cols: Col[] = [];
const live = new Map<string, Live>();
let canvas: HTMLElement | null = null;
let menu: string | null = null;
let drag: { id: string; x: number } | null = null;
let wired = false;

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

function load(): Col[] {
  try {
    const data = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (Array.isArray(data) && data.every((c) => c && typeof c.id === "string" && isDeckType(c.type)))
      return data.map((c) => ({ id: c.id, type: c.type, compact: !!c.compact, filtersHidden: !!c.filtersHidden }));
  } catch {
    /* no storage */
  }
  return [];
}
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(cols));
  } catch {
    /* no storage */
  }
}

// ------------------------------------------------------------------------------------------------
// markup

const svg = (d: string) => raw(`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`);
const ICON: Record<string, Raw> = {
  machines: svg("M4 4h16v10H4zM2 18h20M8 22h8M12 14v8"),
  agents: svg("M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"),
  leaderboard: svg("M10 14.66V17M14 14.66V17M4 22h16M6 9a6 6 0 0 0 12 0V3H6zM6 5H2v3a3 3 0 0 0 4 3M18 5h4v3a3 3 0 0 1-4 3"),
  feed: svg("M15 18h-5M18 14h-8M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-4 0v-9a2 2 0 0 1 2-2h2"),
  following: svg("M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M19 8v6M22 11h-6"),
  filters: svg("M12 19H3M14 3v4M16 17v4M21 12h-9M21 19h-5M21 5h-7M8 10v4M8 12H3"),
  chevron: svg("m6 9 6 6 6-6"),
  plus: svg("M5 12h14M12 5v14"),
  density: svg("M3 6h18M3 12h18M3 18h18"),
  options: raw('<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>'),
  close: raw('<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'),
};

const typeMenu = (act: string, id: string) => html`<div class="deck-menu">${DECK_TYPES.map((t) => html`<button type="button" data-act="${act}" data-id="${id}" data-type="${t}">${LABELS[t]}</button>`)}</div>`;

function columnHtml(c: Col): Raw {
  const label = LABELS[c.type];
  return html`<section class="deck-column${c.compact ? " is-compact" : ""}${c.filtersHidden ? " filters-hidden" : ""}" data-column-id="${c.id}" aria-label="${label}">
    <header class="deck-titlebar">
      <button type="button" class="deck-close" data-act="close" data-id="${c.id}" aria-label="Close ${label} column">${ICON.close}</button>
      <div class="deck-menu-wrap">
        <button type="button" class="deck-title" data-act="type-menu" data-id="${c.id}" aria-haspopup="menu">${ICON[c.type]}<span>${label}</span>${ICON.chevron}</button>
        ${menu === c.id + ":type" ? typeMenu("set-type", c.id) : ""}
      </div>
      <button type="button" class="deck-stripes" data-act="stripes" data-id="${c.id}" aria-label="Reorder ${label} column"></button>
      <button type="button" class="deck-icon" data-act="filters" data-id="${c.id}" title="${c.filtersHidden ? "Show header" : "Hide header"}" aria-pressed="${c.filtersHidden}">${ICON.filters}</button>
      <button type="button" class="deck-icon" data-act="density" data-id="${c.id}" title="${c.compact ? "Comfortable rows" : "Compact rows"}" aria-pressed="${c.compact}">${ICON.density}</button>
      <div class="deck-menu-wrap">
        <button type="button" class="deck-icon" data-act="options-menu" data-id="${c.id}" aria-label="Column options" aria-haspopup="menu">${ICON.options}</button>
        ${menu === c.id
          ? html`<div class="deck-menu right">
              <button type="button" data-act="filters" data-id="${c.id}">${c.filtersHidden ? "Show header" : "Hide header"}</button>
              <button type="button" data-act="density" data-id="${c.id}">${c.compact ? "Comfortable rows" : "Compact rows"}</button>
              <button type="button" data-act="move" data-id="${c.id}" data-delta="-1">Move left</button>
              <button type="button" data-act="move" data-id="${c.id}" data-delta="1">Move right</button>
              <button type="button" data-act="duplicate" data-id="${c.id}">Duplicate column</button>
              <button type="button" data-act="close" data-id="${c.id}">Close column</button>
              <button type="button" data-act="reset">Reset deck layout</button>
            </div>`
          : ""}
      </div>
    </header>
    <div class="deck-body" data-keep-scroll><div class="deck-loading"><div class="skel" style="width:60%"></div><div class="skel" style="width:35%;margin-top:8px"></div></div></div>
  </section>`;
}

function canvasHtml(): Raw {
  return html`${cols.map(columnHtml)}
    <div class="deck-add-wrap">
      <button type="button" class="deck-add" data-act="add-menu" ${cols.length >= MAX_COLUMNS ? "disabled" : ""}>${ICON.plus}<span>Add column</span></button>
      ${menu === "add" ? html`<div class="deck-menu right">${DECK_TYPES.map((t) => html`<button type="button" data-act="add" data-type="${t}">${LABELS[t]}</button>`)}</div>` : ""}
    </div>
    ${cols.length ? "" : html`<div class="deck-empty"><div class="t1">Nothing open</div><div>Open Machines, Agents, Leaderboard or Feed from the nav, or add a column.</div></div>`}`;
}

// ------------------------------------------------------------------------------------------------
// column lifecycle

function stop(id: string) {
  const l = live.get(id);
  if (!l) return;
  if (l.timer) clearInterval(l.timer);
  if (l.refresh) clearTimeout(l.refresh);
  live.delete(id);
}

async function loadColumn(c: Col, opts: { soft?: boolean } = {}) {
  if (!canvas) return;
  const el = canvas.querySelector<HTMLElement>(`[data-column-id="${c.id}"] .deck-body`);
  if (!el) return;
  let page: Page;
  try {
    page = await PAGES[c.type]();
  } catch (e) {
    if (opts.soft) return; // keep the last good render on a failed background refresh
    el.innerHTML = html`<div class="deck-empty"><div class="t1">Could not load ${LABELS[c.type]}</div><div>${String((e as Error)?.message ?? e)}</div></div>`.s;
    return;
  }
  // the column may have been closed or swapped while loading
  if (!el.isConnected || cols.find((x) => x.id === c.id)?.type !== c.type) return;
  const top = el.scrollTop;
  el.innerHTML = page.body.s;
  el.scrollTop = top;
  mountCharts(el);
  if (page.mount) void page.mount(el);
  const l: Live = live.get(c.id) ?? { page: null, timer: null, refresh: null };
  l.page = page;
  if (l.timer) clearInterval(l.timer);
  l.timer = page.pollMs ? setInterval(() => (canvas?.isConnected ? loadColumn(c, { soft: true }) : stop(c.id)), Math.max(3000, page.pollMs)) : null;
  live.set(c.id, l);
}

function renderAll(reload = true) {
  if (!canvas) return;
  const keep = new Map<string, number>();
  for (const el of canvas.querySelectorAll<HTMLElement>("[data-column-id]")) keep.set(el.dataset.columnId!, el.querySelector(".deck-body")?.scrollTop ?? 0);
  const x = canvas.scrollLeft;
  canvas.innerHTML = canvasHtml().s;
  canvas.scrollLeft = x;
  for (const id of [...live.keys()]) if (!cols.some((c) => c.id === id)) stop(id);
  if (reload) for (const c of cols) void loadColumn(c);
  for (const [id, top] of keep) {
    const el = canvas.querySelector<HTMLElement>(`[data-column-id="${id}"] .deck-body`);
    if (el) el.scrollTop = top;
  }
}

/** Re-render the chrome only (menus, flags); the bodies are moved over, not reloaded. */
function rechrome() {
  if (!canvas) return;
  const bodies = new Map<string, HTMLElement>();
  for (const el of canvas.querySelectorAll<HTMLElement>("[data-column-id]")) {
    const b = el.querySelector<HTMLElement>(".deck-body");
    if (b) bodies.set(el.dataset.columnId!, b);
  }
  const x = canvas.scrollLeft;
  canvas.innerHTML = canvasHtml().s;
  canvas.scrollLeft = x;
  for (const el of canvas.querySelectorAll<HTMLElement>("[data-column-id]")) {
    const old = bodies.get(el.dataset.columnId!);
    const placeholder = el.querySelector(".deck-body");
    if (old && placeholder) {
      const top = old.scrollTop;
      placeholder.replaceWith(old);
      old.scrollTop = top;
    } else {
      const c = cols.find((k) => k.id === el.dataset.columnId);
      if (c) void loadColumn(c);
    }
  }
  for (const id of [...live.keys()]) if (!cols.some((c) => c.id === id)) stop(id);
}

function update(id: string, patch: Partial<Col>) {
  cols = cols.map((c) => (c.id === id ? { ...c, ...patch } : c));
  save();
}
function move(id: string, delta: number) {
  const i = cols.findIndex((c) => c.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= cols.length) return;
  const next = [...cols];
  const [c] = next.splice(i, 1);
  next.splice(j, 0, c!);
  cols = next;
  save();
  rechrome();
}

async function focus(id: string, origin?: DOMRect) {
  const node = canvas?.querySelector<HTMLElement>(`[data-column-id="${id}"]`);
  if (!node) return;
  node.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
  await new Promise((r) => setTimeout(r, 180));
  await zoomRects(node.getBoundingClientRect(), origin);
  node.dataset.active = "true";
  setTimeout(() => delete node.dataset.active, 1200);
}

/** Open a page as a column (once) and bring it into view. */
export function openColumn(type: DeckType, origin?: DOMRect) {
  const found = cols.find((c) => c.type === type);
  if (found) {
    void focus(found.id, origin);
    return;
  }
  if (cols.length >= MAX_COLUMNS) return;
  const c: Col = { id: uid(), type, compact: false, filtersHidden: false };
  cols = [...cols, c];
  save();
  rechrome();
  void focus(c.id, origin);
}

// ------------------------------------------------------------------------------------------------
// interaction (one delegated handler on the canvas)

function onClick(ev: MouseEvent) {
  const t = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]");
  if (!t || !canvas?.contains(t)) {
    if (menu) {
      menu = null;
      rechrome();
    }
    return;
  }
  const id = t.dataset.id ?? "";
  const act = t.dataset.act;
  ev.preventDefault();
  ev.stopPropagation();
  if (act === "type-menu") menu = menu === id + ":type" ? null : id + ":type";
  else if (act === "options-menu") menu = menu === id ? null : id;
  else if (act === "add-menu") menu = menu === "add" ? null : "add";
  else if (act === "stripes") return;
  else {
    menu = null;
    if (act === "close") {
      stop(id);
      cols = cols.filter((c) => c.id !== id);
      save();
    } else if (act === "set-type") {
      const type = t.dataset.type;
      if (isDeckType(type)) {
        update(id, { type });
        stop(id);
        const c = cols.find((x) => x.id === id)!;
        rechrome();
        const body = canvas.querySelector<HTMLElement>(`[data-column-id="${id}"] .deck-body`);
        if (body) body.innerHTML = html`<div class="deck-loading"><div class="skel" style="width:60%"></div></div>`.s;
        void loadColumn(c);
        return;
      }
    } else if (act === "filters") update(id, { filtersHidden: !cols.find((c) => c.id === id)?.filtersHidden });
    else if (act === "density") update(id, { compact: !cols.find((c) => c.id === id)?.compact });
    else if (act === "move") {
      move(id, Number(t.dataset.delta));
      return;
    } else if (act === "duplicate") {
      const i = cols.findIndex((c) => c.id === id);
      if (i >= 0 && cols.length < MAX_COLUMNS) {
        const copy = { ...cols[i]!, id: uid() };
        cols = [...cols.slice(0, i + 1), copy, ...cols.slice(i + 1)];
        save();
        rechrome();
        void focus(copy.id);
        return;
      }
    } else if (act === "reset") {
      for (const id of [...live.keys()]) stop(id);
      cols = [];
      save();
    } else if (act === "add") {
      const type = t.dataset.type;
      if (isDeckType(type)) {
        openColumn(type, t.getBoundingClientRect());
        return;
      }
    }
  }
  rechrome();
}

function onPointerDown(ev: PointerEvent) {
  const t = (ev.target as HTMLElement).closest<HTMLElement>('[data-act="stripes"]');
  if (!t) return;
  drag = { id: t.dataset.id!, x: ev.clientX };
  t.setPointerCapture(ev.pointerId);
}
function onPointerUp(ev: PointerEvent) {
  const t = (ev.target as HTMLElement).closest<HTMLElement>('[data-act="stripes"]');
  if (!t || !drag || drag.id !== t.dataset.id) {
    drag = null;
    return;
  }
  if (Math.abs(ev.clientX - drag.x) > 4) move(drag.id, ev.clientX > drag.x ? 1 : -1);
  drag = null;
}

function onLiveEvent(ev: Event) {
  if (!canvas?.isConnected) return;
  const e = (ev as CustomEvent<Ev>).detail;
  for (const c of cols) {
    const l = live.get(c.id);
    if (!l?.page?.refreshOn?.(e) || l.refresh) continue;
    l.refresh = setTimeout(() => {
      l.refresh = null;
      void loadColumn(c, { soft: true });
    }, 900);
  }
}

function wire() {
  if (wired) return;
  wired = true;
  document.addEventListener("click", onClick, true);
  document.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("pointerup", onPointerUp);
  window.addEventListener("lineage:event", onLiveEvent);
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && menu) {
      menu = null;
      rechrome();
    }
  });
}

// ------------------------------------------------------------------------------------------------
// the page

export async function deckPage(): Promise<Page> {
  const body = html`<div class="deck-shell"><div class="deck-canvas" id="deck-canvas" aria-label="Deck"></div></div>`;
  return {
    title: "Deck",
    body,
    mount: (root) => {
      canvas = root.querySelector<HTMLElement>("#deck-canvas");
      for (const id of [...live.keys()]) stop(id);
      cols = load();
      menu = null;
      wire();
      const open = new URLSearchParams(location.search).get("open");
      if (isDeckType(open) && !cols.some((c) => c.type === open)) {
        cols = [...cols, { id: uid(), type: open, compact: false, filtersHidden: false }];
        save();
      }
      renderAll();
      if (isDeckType(open)) {
        const c = cols.find((x) => x.type === open);
        if (c) void focus(c.id);
      }
    },
  };
}

/**
 * Called by the router when the URL changes while the deck is already on screen (a nav click on one
 * of the four pages, or a column's filter chips pushing a new query). Returns false when the deck is
 * not mounted, so the router renders normally.
 */
export function deckSync(): boolean {
  if (!canvas?.isConnected) return false;
  const open = new URLSearchParams(location.search).get("open");
  if (isDeckType(open)) openColumn(open);
  for (const c of cols) if (QUERY_PAGES.has(c.type)) void loadColumn(c, { soft: true });
  return true;
}

// ------------------------------------------------------------------------------------------------
// the zoom flourish: seven dotted rectangles stepping from the origin (a clicked control or the
// column's own centre) out to the column, 40 ms apart

type Rect = Pick<DOMRect, "left" | "top" | "width" | "height">;
async function zoomRects(target: Rect, origin?: Rect) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const start = origin ?? { left: target.left + target.width / 2 - 8, top: target.top + target.height / 2 - 8, width: 16, height: 16 };
  const layer = document.createElement("div");
  layer.setAttribute("aria-hidden", "true");
  layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
  document.body.appendChild(layer);
  const anims: Promise<unknown>[] = [];
  for (let step = 1; step <= 7; step++) {
    const p = 1 - Math.pow(1 - step / 7, 2.2);
    const box = document.createElement("div");
    box.style.cssText = `position:absolute;border:1px dotted var(--tp);left:${start.left + (target.left - start.left) * p}px;top:${start.top + (target.top - start.top) * p}px;width:${start.width + (target.width - start.width) * p}px;height:${start.height + (target.height - start.height) * p}px;opacity:0`;
    layer.appendChild(box);
    anims.push(box.animate([{ opacity: 0 }, { opacity: 1, offset: 0.01 }, { opacity: 1, offset: 0.99 }, { opacity: 0 }], { delay: (step - 1) * 40, duration: 88, fill: "both" }).finished);
  }
  try {
    await Promise.all(anims);
  } finally {
    layer.remove();
  }
}

export const deckLabel = (t: DeckType) => esc(LABELS[t]);
