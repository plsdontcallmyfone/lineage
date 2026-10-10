import { repoLabel } from "../fmt.ts";
import { html, raw, type Raw } from "../html.ts";
import { NETWORK, QUOTE } from "../market.ts";
import { agentAvatar, agentTitle, buildingLine, injectBuildingStyle, paramCells, type DirToken } from "../building.ts";
import { drawThumb, thumbModel, type Palette, type ThumbModel } from "../../../../packages/embed/src/thumb.ts";
import type { Page } from "./types.ts";
import { mount as mountLivePanel } from "../live-panel/index.ts";
import { endOf, idleCaption, idleStatus, RECORDINGS_SHOWN } from "../live-panel/live-only.ts";

// Explorer: the token directory (docs/plans/FRONTEND-EMBED.md, amendment 2, and APP-CONSOLIDATION.md
// amendment 2026-10-10 (2)). Every listed agent token as a card: a live screen thumbnail of what its
// agent is building, rank, state, name and ticker, then only price, market cap, 24h volume, 24h change
// and what the agent is building (repository, live status, a link to the session). Hidden launches
// are left out by the indexer. Filters by target class, search, sorts and state filters run in the
// market indexer (GET /market/tokens, /market/summary), which joins the chain with Core. Every figure
// is the indexer's or Core's; what neither holds is TBA.
//
// `mountExplorer(el, opts)` renders it into any element (the app's home page, and the embed kit's
// <lineage-explorer>). Styles are injected once, prefixed ex-, on the app's colour tokens with
// fallbacks. Thumbnails use the embed kit's thumbnail drawing (packages/embed/src/thumb.ts) over the
// session's public events and the file at its parent generation, both from Core.

export interface ExplorerOpts {
  /** Market indexer base (default "/market"). */
  market?: string;
  /** Core proxy base for session thumbnails (default "/api"); null leaves screens as patterns. */
  core?: string | null;
  /** Where a card links (default /tokens/:mint). */
  tokenHref?: (mint: string) => string;
  /** Where a card's session link goes (default /sessions/:id). */
  sessionHref?: (id: string) => string;
  /** Cards per page (default 24). */
  pageSize?: number;
  /** Refresh period of counters and cards, ms (default 20000; 0 disables). */
  pollMs?: number;
  /** Hovering a card shows the agent's live desktop in its screen: mounts it and returns a teardown (default none). */
  hoverPanel?: (el: HTMLElement, agent: string) => () => void;
  /** Hand-drawn marks from /doodles/ around the head (the app only; default off). */
  doodles?: boolean;
}

export type { DirToken };
interface DirList {
  tokens: DirToken[];
  count: number;
  total: number;
  offset: number;
  facets: { class: Record<string, number> };
}
interface Summary {
  tokens: number;
  awake: number;
  working: number | null;
  graduated: number;
  verified_generations: number | null;
}

export const CLASS_LABEL: Record<string, string> = {
  rust: "Rust",
  python: "Python",
  solana: "Solana compute",
  zig: "Zig size",
  cuda: "CUDA",
  go: "Go",
  cpp: "C++",
  unknown: "Not set up yet",
};
const CLASS_ORDER = ["rust", "python", "solana", "zig", "cuda", "go", "cpp"];
export const SORTS: [string, string][] = [["market_cap", "Top"], ["newest", "New"], ["volume", "Volume"], ["change", "Gainers"], ["awake", "Working first"]];
export const STATES: [string, string][] = [["", "All"], ["awake", "Awake"], ["asleep", "Asleep"], ["graduated", "Graduated"]];
const BADGE: Record<string, string> = { working: "Working", awake: "Awake", asleep: "Asleep", graduated: "Graduated" };

const searchIcon = raw(`<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.6"/><path d="M10.4 10.4L14 14"/></svg>`);

/** One card; `rank` is its 1-based place in the current sort. Pure markup (the screen is painted after mount). */
export function cardHtml(t: DirToken, rank: number, href: string, sessionHref?: (id: string) => string): Raw {
  const st = t.state;
  return html`<div class="ex-card" data-mint="${t.mint}" data-sym="${t.symbol ?? ""}" data-agent="${t.agent}">
    <a class="ex-cardlink" href="${href}" aria-label="${agentTitle(t)} ${t.symbol ? `$${t.symbol}` : ""}">
    <div class="ex-screen" data-screen="${t.session?.id ?? ""}" data-lineage="${t.lineage_id ?? ""}"><canvas aria-hidden="true"></canvas>
      <span class="ex-rank">#${String(rank).padStart(2, "0")}</span>
      ${st ? html`<span class="ex-state ${st}">${st === "working" ? html`<i></i>` : ""}${BADGE[st]}</span>` : ""}
    </div>
    <div class="ex-body">
      <div class="ex-name">${agentAvatar(t.agent, t.avatar, 22, "ex-av")}<span class="ex-n">${agentTitle(t)}</span><span class="ex-tick">${t.symbol ? `$${t.symbol}` : ""}</span></div>
      ${paramCells(t)}
    </div>
    </a>
    <div class="ex-bd">${buildingLine(t, { sessionHref })}</div>
  </div>`;
}

export function mountExplorer(el: HTMLElement, opts: ExplorerOpts = {}) {
  injectStyle();
  const M = (opts.market ?? "/market").replace(/\/+$/, "");
  const C = opts.core === undefined ? "/api" : opts.core === null ? null : opts.core.replace(/\/+$/, "");
  const tokenHref = opts.tokenHref ?? ((m: string) => `/tokens/${m}`);
  const size = opts.pageSize ?? 24;
  const sessionHref = opts.sessionHref;
  const st = { sort: "market_cap", state: "", cls: "", q: "", shown: size };
  let alive = true;
  let seq = 0;
  let last: DirList | null = null;
  let summary: Summary | null = null;
  let err: string | null = null;

  const getJson = async <T,>(url: string): Promise<T> => {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`${url.split("?")[0]}: HTTP ${r.status}`);
    return (await r.json()) as T;
  };
  const query = () => {
    const p = new URLSearchParams({ sort: st.sort, limit: String(st.shown) });
    if (st.state) p.set("state", st.state);
    if (st.cls) p.set("class", st.cls);
    if (st.q.trim()) p.set("q", st.q.trim());
    return p;
  };

  async function load() {
    const my = ++seq;
    try {
      const [l, s] = await Promise.all([getJson<DirList>(`${M}/tokens?${query()}`), getJson<Summary>(`${M}/summary`).catch(() => summary)]);
      if (my !== seq || !alive) return;
      last = l;
      summary = s;
      err = null;
    } catch (e) {
      if (my !== seq || !alive) return;
      err = (e as Error).message;
    }
    paint();
  }

  const counter = (label: string, v: number | null | undefined, hot = false) =>
    html`<div class="ex-ctr${hot && v ? " hot" : ""}"><span>${hot ? html`<i class="ex-pulse"></i>` : ""}${label}</span><b class="ex-num">${v == null ? "TBA" : v}</b></div>`;
  const side = (title: string, key: "cls", facets: Record<string, number>, labels: (k: string) => string, order: string[]) => {
    const keys = [...new Set([...order.filter((k) => facets[k] !== undefined), ...Object.keys(facets).sort()])];
    const total = Object.values(facets).reduce((a, b) => a + b, 0);
    return html`<div class="ex-side-g"><div class="ex-side-h">${title}</div>
      <button type="button" data-ex-${key}="" aria-pressed="${String(st[key] === "")}"><span>All</span><span class="ex-c">${total}</span></button>
      ${keys.map((k) => html`<button type="button" data-ex-${key}="${k}" aria-pressed="${String(st[key] === k)}"><span>${labels(k)}</span><span class="ex-c">${facets[k] ?? 0}</span></button>`)}
    </div>`;
  };

  function paint() {
    if (!alive) return;
    const l = last;
    const focus = document.activeElement as HTMLInputElement | null;
    const hadFocus = focus?.matches?.("[data-ex-q]") ? { s: focus.selectionStart, e: focus.selectionEnd } : null;
    const body = html`<div class="ex">
      <header class="ex-head">
        <div class="ex-hero">
          <div class="ex-eyebrow"><i class="ex-pulse"></i>Token directory <span>·</span> ${NETWORK}</div>
          <h1 class="ex-title">${opts.doodles ? html`<span class="ex-tw">Explorer<img class="ex-dd ex-dd-wow" src="/doodles/wow.svg" alt="" aria-hidden="true"></span>` : "Explorer"}</h1>
          <p class="ex-lede">Every agent token and what its agent is building right now. Prices and volumes in ${QUOTE}.</p>
        </div>
        <div class="ex-ctrs">${opts.doodles ? html`<img class="ex-dd ex-dd-arrow" src="/doodles/arrow.svg" alt="" aria-hidden="true">` : ""}${counter("Tokens", summary?.tokens)}${counter("Working now", summary?.working, true)}${counter("Agents awake", summary?.awake)}${counter("Graduated", summary?.graduated)}</div>
      </header>
      <div class="ex-layout">
        <aside class="ex-side" aria-label="Filters">
          ${side("Works on", "cls", l?.facets.class ?? {}, (k) => CLASS_LABEL[k] ?? k, CLASS_ORDER)}
        </aside>
        <section class="ex-main">
          <div class="ex-tools">
            <form class="ex-search" role="search" data-ex-search><span class="ex-search-ic">${searchIcon}</span>
              <input data-ex-q name="q" type="search" value="${st.q}" placeholder="Search name, ticker or mint" aria-label="Search tokens" autocomplete="off" spellcheck="false"></form>
            <div class="ex-seg" role="group" aria-label="Sort">${SORTS.map(([k, label]) => html`<button type="button" data-ex-sort="${k}" aria-pressed="${String(st.sort === k)}">${label}</button>`)}</div>
          </div>
          <div class="ex-tools2">
            <div class="ex-seg ex-states" role="group" aria-label="State">${STATES.map(([k, label]) => html`<button type="button" data-ex-state="${k}" aria-pressed="${String(st.state === k)}">${label}</button>`)}</div>
            <div class="ex-showing">${l ? html`Showing <b class="ex-num">${Math.min(l.tokens.length, l.count)}</b> of <b class="ex-num">${l.count}</b> token${l.count === 1 ? "" : "s"}${l.count !== l.total ? html` (${l.total} in all)` : ""}` : err ? "" : "Loading"}</div>
          </div>
          ${err ? html`<div class="ex-err">The market indexer did not answer: ${err}</div>` : ""}
          <div class="ex-grid">${l ? (l.tokens.length ? l.tokens.map((t, i) => cardHtml(t, i + 1, tokenHref(t.mint), sessionHref)) : html`<div class="ex-empty">No token matches these filters.</div>`) : ""}</div>
          ${l && l.tokens.length < l.count ? html`<div class="ex-more"><button type="button" data-ex-more>Show more</button></div>` : ""}
        </section>
      </div>
    </div>`;
    el.innerHTML = body.s;
    if (hadFocus) {
      const inp = el.querySelector<HTMLInputElement>("[data-ex-q]");
      inp?.focus();
      try {
        inp?.setSelectionRange(hadFocus.s, hadFocus.e);
      } catch {
        /* search inputs may refuse */
      }
    }
    paintScreens();
  }

  // ---- screens: painted lazily, a few at a time, cached per session and its last activity
  const cache = new Map<string, ThumbModel>();
  const pending = new Set<string>();
  let io: IntersectionObserver | null = null;
  function paintScreens() {
    io?.disconnect();
    const screens = [...el.querySelectorAll<HTMLElement>(".ex-screen")];
    const go = (s: HTMLElement) => void paintOne(s);
    if (typeof IntersectionObserver === "undefined") return screens.forEach(go);
    io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && (io?.unobserve(e.target), go(e.target as HTMLElement))), { rootMargin: "200px" });
    screens.forEach((s) => io!.observe(s));
  }
  async function modelFor(card: HTMLElement, sid: string): Promise<ThumbModel> {
    const t = last?.tokens.find((x) => x.mint === card.dataset.mint);
    const key = `${sid}:${t?.session?.at ?? ""}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const view = await getJson<any>(`${C}/sessions/${sid}`);
    const ev = [...(view.event_list ?? [])].reverse().find((e: any) => ["read", "edit", "write", "patch"].includes(e.kind) && e.path);
    let text: string | null = null;
    if (ev) {
      const f = await getJson<any>(`${C}/lineages/${view.lineage_id}/file?gen=${view.gen_id}&path=${encodeURIComponent(ev.path)}`).catch(() => null);
      text = typeof f?.text === "string" ? f.text : null;
    }
    const m = thumbModel(view, text);
    cache.set(key, m);
    return m;
  }
  async function paintOne(screen: HTMLElement) {
    const card = screen.closest<HTMLElement>(".ex-card");
    const canvas = screen.querySelector("canvas");
    if (!card || !canvas) return;
    const sid = screen.dataset.screen ?? "";
    const sym = card.dataset.sym || "";
    const tok = last?.tokens.find((x) => x.mint === card.dataset.mint);
    let m: ThumbModel = { repo: tok?.repo_url ? repoLabel(tok.repo_url) : "repository TBA", file: null, lines: [], cursor: -1, caption: sid ? "Loading the session" : "No authoring session yet", live: false, title: sym ? `$${sym}` : undefined };
    if (!RECORDINGS_SHOWN && tok?.session?.state !== "live") {
      // live only: a card whose agent is not working shows its idle state, not a still of a past session
      const st = await idleStatus((p) => (C ? getJson<any>(`${C}/${p}`) : Promise.reject(new Error("no core"))), card.dataset.agent, endOf(tok?.session ?? null));
      m = { ...m, caption: idleCaption(st) };
    } else if (sid && C && !pending.has(sid)) {
      pending.add(sid);
      try {
        m = await modelFor(card, sid);
        if (!m.lines.length) m = { ...m, title: sym ? `$${sym}` : undefined };
      } catch {
        m = { ...m, caption: "Session not readable now" };
      } finally {
        pending.delete(sid);
      }
    }
    if (!screen.isConnected) return;
    const w = Math.max(160, Math.round(screen.clientWidth || 260));
    const h = Math.max(100, Math.round(screen.clientHeight || 150));
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    const cs = getComputedStyle(screen);
    const pal = palette(cs);
    drawThumb(ctx, m, w, h, pal, cs.fontFamily || "sans-serif");
    if (!m.lines.length) pattern(ctx, card.dataset.mint ?? "", w, h, pal);
  }

  // ---- events
  let typing: ReturnType<typeof setTimeout> | null = null;
  const refilter = () => {
    st.shown = size;
    void load();
  };
  el.addEventListener("input", (ev) => {
    const t = ev.target as HTMLInputElement;
    if (!t.matches("[data-ex-q]")) return;
    st.q = t.value;
    if (typing) clearTimeout(typing);
    typing = setTimeout(refilter, 220);
  });
  el.addEventListener("submit", async (ev) => {
    if (!(ev.target as HTMLElement).matches("[data-ex-search]")) return;
    ev.preventDefault();
    // Enter: a search that names exactly one token opens its page
    const q = String(new FormData(ev.target as HTMLFormElement).get("q") ?? "").trim();
    st.q = q;
    if (!q) return refilter();
    try {
      const r = await getJson<DirList>(`${M}/tokens?q=${encodeURIComponent(q)}&limit=2`);
      if (r.count === 1) return openHref(tokenHref(r.tokens[0]!.mint));
    } catch {
      /* fall through to the filtered grid */
    }
    refilter();
  });
  el.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>("button");
    if (!b || !el.contains(b)) return;
    if (b.dataset.exSort !== undefined) st.sort = b.dataset.exSort;
    else if (b.dataset.exState !== undefined) st.state = b.dataset.exState;
    else if (b.dataset.exCls !== undefined) st.cls = b.dataset.exCls;
    else if (b.dataset.exMore !== undefined) {
      st.shown += size;
      return void load();
    } else return;
    refilter();
  });
  const openHref = (href: string) => {
    const a = document.createElement("a");
    a.href = href;
    el.appendChild(a);
    a.click(); // the host app routes it (or the browser follows it)
    a.remove();
  };

  const timer = opts.pollMs === 0 ? null : setInterval(() => {
    if (!el.isConnected) return destroy();
    if (!document.hidden && !el.contains(document.activeElement)) void load();
  }, opts.pollMs ?? 20_000);
  // ---- hover: the agent's live desktop over the card's screen (pointer devices only, one at a time)
  let hover: { card: HTMLElement; down: () => void } | null = null;
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  const unhover = () => {
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = null;
    if (!hover) return;
    hover.down();
    hover.card.querySelector(".ex-livewrap")?.remove();
    hover.card.classList.remove("is-live");
    hover = null;
  };
  if (opts.hoverPanel && typeof matchMedia === "function" && matchMedia("(hover: hover)").matches) {
    el.addEventListener("pointerover", (ev) => {
      const card = (ev.target as HTMLElement).closest<HTMLElement>(".ex-card");
      if (!card || !card.dataset.agent || hover?.card === card) return;
      unhover();
      hoverTimer = setTimeout(() => {
        hoverTimer = null;
        const screen = card.querySelector<HTMLElement>(".ex-screen");
        if (!screen || !card.isConnected) return;
        const wrap = document.createElement("div");
        wrap.className = "ex-livewrap";
        screen.appendChild(wrap);
        card.classList.add("is-live");
        hover = { card, down: opts.hoverPanel!(wrap, card.dataset.agent!) };
      }, 220);
    });
    el.addEventListener("pointerout", (ev) => {
      const card = (ev.target as HTMLElement).closest<HTMLElement>(".ex-card");
      const to = ev.relatedTarget as HTMLElement | null;
      if (card && (!to || !card.contains(to))) unhover();
    });
  }
  function destroy() {
    alive = false;
    unhover();
    if (timer) clearInterval(timer);
    io?.disconnect();
  }

  el.innerHTML = `<div class="ex"><div class="ex-loading">Loading the token directory</div></div>`;
  void load();
  return {
    reload: load,
    setFilter: (f: Partial<Pick<typeof st, "sort" | "state" | "cls" | "q">>) => {
      Object.assign(st, f);
      refilter();
    },
    destroy,
  };
}

/** A screen with no session: a pattern generated from the mint (a 12 x 6 field of cells), screened over the frame. */
function pattern(ctx: CanvasRenderingContext2D, seed: string, w: number, h: number, p: Palette) {
  let x = 2166136261;
  for (const ch of seed) x = Math.imul(x ^ ch.charCodeAt(0), 16777619) >>> 0;
  const rnd = () => ((x = Math.imul(x ^ (x >>> 15), 2246822519) >>> 0), (x = (x ^ (x >>> 13)) >>> 0), x / 4294967296);
  const top = 22;
  const cols = 12, rows = 6;
  const cw = w / cols, ch = (h - top) / rows;
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols / 2; c++) {
      const v = rnd();
      if (v < 0.45) continue;
      const a = v > 0.85 ? 0.22 : 0.09;
      ctx.fillStyle = `rgba(${p.accent[0]},${p.accent[1]},${p.accent[2]},${a})`;
      // mirrored, like an identicon
      ctx.fillRect(c * cw + 1, top + r * ch + 1, cw - 2, ch - 2);
      ctx.fillRect((cols - 1 - c) * cw + 1, top + r * ch + 1, cw - 2, ch - 2);
    }
  ctx.restore();
}

function rgb(c: string, fb: [number, number, number]): [number, number, number] {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : fb;
}
function palette(cs: CSSStyleDeclaration): Palette {
  const v = (k: string) => cs.getPropertyValue(k).trim();
  // resolve the custom properties through a probe so color-mix and named colours become rgb()
  const probe = (k: string, fb: [number, number, number]) => {
    const raw = v(k);
    if (!raw) return fb;
    const d = document.createElement("span");
    d.style.color = raw;
    document.body.appendChild(d);
    const out = rgb(getComputedStyle(d).color, fb);
    d.remove();
    return out;
  };
  return {
    bg: probe("--ex-scr-bg", [18, 20, 24]),
    panel: probe("--ex-scr-panel", [28, 31, 38]),
    fg: probe("--ex-scr-fg", [230, 232, 236]),
    muted: probe("--ex-scr-muted", [120, 126, 138]),
    accent: probe("--ex-scr-accent", [255, 138, 40]),
  };
}

// ------------------------------------------------------------------------------------------------
// the app's /explorer page

let mounted: ReturnType<typeof mountExplorer> | null = null;

export async function explorerPage(): Promise<Page> {
  return {
    title: "Explorer",
    body: html`<div id="ex-root"></div>`,
    mount: (root) => {
      mounted?.destroy();
      mounted = mountExplorer(root.querySelector<HTMLElement>("#ex-root")!, {
        doodles: true,
        // hovering a card: the agent's desktop (its session live, else its idle state: live only) in the machine frame
        hoverPanel: (wrap, agent) => {
          // the machine renders at its natural width in a box, and the box is scaled to fit the card's screen
          const box = document.createElement("div");
          box.className = "ex-livebox";
          wrap.appendChild(box);
          // the window alone (no machine, no controls), scaled to cover the card's screen edge to edge
          const h = mountLivePanel(box, { agent, frame: "none", list: false, fps: 12, height: 266 });
          const fit = () => {
            const W = wrap.clientWidth, H = wrap.clientHeight;
            const stage = box.querySelector<HTMLElement>(".lp-stage") ?? box;
            const bw = stage.offsetWidth || 1, bh = stage.offsetHeight || 1;
            const k = Math.max(W / bw, H / bh);
            box.style.transform = `translate(-50%, -50%) scale(${k.toFixed(4)})`;
          };
          fit();
          const t = setInterval(() => (wrap.isConnected ? fit() : clearInterval(t)), 250); // the panel's height settles as its session loads
          return () => {
            clearInterval(t);
            h.destroy();
          };
        },
      });
    },
  };
}

// ------------------------------------------------------------------------------------------------

const CSS = `
.ex{--ex-panel:var(--bg2);--ex-line:var(--border);--ex-soft:var(--border);--ex-text:var(--tp);--ex-dim:var(--ts);--ex-faint:var(--tt);--ex-accent:var(--ac);--ex-radius:20px;
  --ex-scr-bg:#0a0908;--ex-scr-panel:#1a1c20;--ex-scr-fg:#e6e8ec;--ex-scr-muted:#7a808c;--ex-scr-accent:var(--ac);
  font-family:var(--sans);color:var(--ex-text);min-width:0;display:flex;flex-direction:column;gap:22px}
.ex-loading{padding:40px 0;color:var(--ex-faint)}
.ex-head{position:relative;display:flex;justify-content:space-between;align-items:flex-end;gap:24px 40px;flex-wrap:wrap;padding:36px 32px 32px;border-radius:22px;corner-shape:squircle;background:var(--bg2);box-shadow:var(--card-glow)}
.ex-hero{position:relative;z-index:1;min-width:0;max-width:620px}
.ex-eyebrow{display:inline-flex;align-items:center;gap:8px;font:500 12px/1 var(--sans);letter-spacing:-.01em;color:var(--tt);margin-bottom:14px}
.ex-eyebrow span{opacity:.6}
.ex-pulse{width:6px;height:6px;border-radius:50%;background:var(--good);flex:none;animation:ex-pulse 2.4s ease-in-out infinite}
.ex-title{margin:0;font-family:var(--display);font-size:clamp(44px,5.6vw,80px);line-height:1;font-weight:500;letter-spacing:-.04em}
.ex-lede{margin:18px 0 0;color:var(--tt);font-size:18px;max-width:560px;line-height:26px}
.ex-ctrs{position:relative;z-index:1;display:grid;grid-template-columns:repeat(4,minmax(0,auto));gap:0}
.ex-tw{position:relative;display:inline-block}
.ex-dd{position:absolute;z-index:4;display:block;height:auto;max-width:none;pointer-events:none;user-select:none} /* plnty's doodles: the wow by the title, the arrow at the live counter */
.ex-dd-wow{width:140px;left:calc(100% + 14px);top:-38px}
.ex-dd-arrow{width:40px;left:calc(25% + 8px);top:-66px}
.ex-ctr{display:flex;flex-direction:column;gap:10px;padding:2px 26px;min-width:0;border-left:1px solid var(--border)}
.ex-ctr:first-child{border-left:0;padding-left:0}
.ex-ctr span{display:inline-flex;align-items:center;gap:7px;font:500 12px/1 var(--sans);letter-spacing:-.01em;color:var(--tt);white-space:nowrap}
.ex-ctr span .ex-pulse{width:5px;height:5px;background:var(--tt);box-shadow:none;animation:none}
.ex-ctr.hot span{color:var(--tp)}
.ex-ctr.hot span .ex-pulse{background:var(--good);animation:ex-pulse 1.6s ease-in-out infinite}
.ex-ctr b{font-family:var(--display);font-size:40px;font-weight:500;letter-spacing:-.04em;line-height:1;color:var(--tp)}
.ex-ctr.hot b{color:var(--tp)}
.ex-ctr span{font:500 12px/1.4 var(--sans);letter-spacing:-.01em;color:var(--tt);white-space:nowrap}
.ex-layout{display:grid;grid-template-columns:196px minmax(0,1fr);gap:24px;align-items:start}
.ex-side{position:sticky;top:calc(var(--hdr-h) + 16px);display:flex;flex-direction:column;gap:20px}
.ex-side-g{display:flex;flex-direction:column;gap:2px}
.ex-side-h{font:500 12px/1.4 var(--sans);letter-spacing:-.01em;color:var(--tt);padding:0 10px 8px}
.ex-side button{display:flex;justify-content:space-between;gap:8px;font:500 14px/1.3 var(--sans);letter-spacing:-.01em;text-align:left;border:0;background:transparent;color:var(--ex-dim);padding:7px 10px;border-radius:16px;corner-shape:squircle;cursor:pointer;transition:color .15s,background .15s,border-color .15s}
.ex-side button:hover{background:var(--pill);color:var(--ex-text)}
.ex-side button[aria-pressed="true"]{background:var(--tp);color:var(--bg)}
.ex-side button[aria-pressed="true"] .ex-c{color:inherit;opacity:.7}
.ex-c{font:500 12px/1.6 var(--sans);letter-spacing:-.01em;color:var(--ex-faint)}
.ex-main{min-width:0;display:flex;flex-direction:column;gap:14px}
.ex-tools,.ex-tools2{display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:space-between}
.ex-search{display:flex;align-items:center;gap:8px;flex:1 1 260px;max-width:420px;height:44px;background:var(--bg);border:2px solid var(--tp);border-radius:20px;corner-shape:squircle;padding:0 14px;transition:border-color .15s}
.ex-search:focus-within{border-color:var(--ac)}
.ex-search-ic{color:var(--ex-faint);display:flex}
.ex-search input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--tp);caret-color:var(--ac);font:400 16px/1.4 var(--sans);letter-spacing:-.01em;padding:0}
.ex-seg{display:flex;flex-wrap:wrap;gap:2px;padding:4px;background:var(--pill);border-radius:16px;corner-shape:squircle}
.ex-seg button{font:500 13px/1.4 var(--sans);letter-spacing:-.01em;border:0;background:transparent;color:var(--tt);padding:5px 12px;border-radius:12px;corner-shape:squircle;cursor:pointer;white-space:nowrap;transition:color .15s,border-color .15s,background .15s}
.ex-seg button:hover{color:var(--tp)}
.ex-seg button[aria-pressed="true"]{background:var(--tp);color:var(--bg)}
.ex-showing{font:500 12px/1.6 var(--sans);letter-spacing:-.01em;color:var(--ex-faint)}
.ex-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}
.ex-card{display:flex;flex-direction:column;min-width:0;padding:8px;background:var(--bg2);border-radius:22px;corner-shape:squircle;box-shadow:var(--card-glow);overflow:hidden;color:inherit;transition:transform .18s var(--ease-soft)}
.ex-card:hover{transform:translateY(-4px);transition:transform .28s var(--ease-back)}
.ex-cardlink{display:flex;flex-direction:column;color:inherit;text-decoration:none;min-width:0}
.ex-cardlink:focus-visible{outline:2px solid var(--ac);outline-offset:-2px}
.ex-screen{position:relative;aspect-ratio:16/10;background:var(--ex-scr-bg);overflow:hidden;border-radius:16px;corner-shape:squircle}
.ex-screen canvas{display:block;width:100%;height:100%}
.ex-livewrap{position:absolute;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;overflow:hidden;background:var(--ex-scr-bg);animation:ex-fade .3s ease-out} /* the agent's live desktop, over the still */
.ex-livebox{position:absolute;left:50%;top:50%;width:560px;transform:translate(-50%,-50%);transform-origin:center}
.ex-livewrap .lp{border-radius:0;border:0;box-shadow:none}
.ex-livewrap .lp-list,.ex-livewrap .lp-run,.ex-livewrap .lp-deck{display:none} /* the playing window only */
.ex-livewrap .lp-stage{display:block}
@keyframes ex-fade{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.ex-livewrap{animation:none}}
.ex-rank{position:absolute;left:8px;bottom:8px;z-index:1;font:500 12px/1 var(--sans);letter-spacing:-.01em;color:#f8f8f8;background:#1a1a19;padding:5px 8px;border-radius:12px;corner-shape:squircle;font-variant-numeric:tabular-nums}
.ex-state{position:absolute;right:8px;bottom:8px;z-index:1;display:inline-flex;align-items:center;gap:5px;font:500 12px/1 var(--sans);letter-spacing:-.01em;padding:5px 8px;border-radius:12px;corner-shape:squircle;background:#e6e3dc;color:#1a1a19}
.ex-state.working{background:#a68aff;color:#47146e}
.ex-state.working i{width:6px;height:6px;border-radius:50%;background:#47146e;animation:ex-pulse 1.4s ease-in-out infinite}
.ex-state.awake{background:#b9d98a;color:#243a07}
.ex-state.graduated{background:#76c1f5;color:#092538}
@keyframes ex-pulse{50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.ex-state.working i{animation:none}.ex-card{transition:none}}
.ex-body{display:flex;flex-direction:column;gap:12px;padding:14px 8px 10px;min-width:0}
.ex-name{display:flex;align-items:center;gap:8px;min-width:0}
.ex-av{width:22px;height:22px}
.ex-n{font-family:var(--display);font-weight:500;font-size:18px;letter-spacing:-.03em;color:var(--tp);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.ex-tick{font:500 12px/1.4 var(--sans);letter-spacing:-.01em;color:var(--ex-faint);white-space:nowrap}
.ex-bd{border-top:1px solid var(--border);padding:10px 8px 6px;margin-top:auto}
.ex-num{font-variant-numeric:tabular-nums}
.ex-tba{color:var(--ex-faint);font-weight:400}
.ex-empty{grid-column:1/-1;padding:36px;text-align:center;color:var(--ex-faint);border-radius:22px;corner-shape:squircle;background:var(--bg2);box-shadow:var(--card-glow)}
.ex-err{font-size:13px;padding:11px 14px;border-radius:14px;border:1px solid var(--border);border-left:2px solid var(--bad);background:var(--bg2);color:var(--ts)}
.ex-more{display:flex;justify-content:center}
.ex-more button{font:500 16px/1 var(--sans);letter-spacing:-.01em;height:44px;border:2px solid var(--tp);background:transparent;color:var(--tp);border-radius:20px;corner-shape:squircle;padding:0 16px;cursor:pointer;transition:background .18s,color .18s}
.ex-more button:hover{background:var(--tp);color:var(--bg)}
@media (max-width:1400px){.ex-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:1100px){.ex-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:760px){
  .ex-layout{grid-template-columns:minmax(0,1fr);gap:14px}
  .ex-side{position:static;gap:10px}
  .ex-side-g{flex-direction:row;flex-wrap:wrap;gap:4px}
  .ex-side-h{width:100%;padding:0 0 4px}
  .ex-side button{background:var(--pill);font-size:13px;padding:6px 10px}
  .ex-head{padding:22px 18px}
  .ex-dd{display:none}
  .ex-ctrs{grid-template-columns:repeat(2,minmax(0,1fr));width:100%;row-gap:18px}
  .ex-ctr{padding:2px 14px}
  .ex-ctr:nth-child(odd){border-left:0;padding-left:0}
  .ex-ctr b{font-size:32px}
  .ex-grid{grid-template-columns:minmax(0,1fr)}
  .ex-title{font-size:42px}
  .ex-search{max-width:none}
}`;

function injectStyle() {
  injectBuildingStyle();
  if (typeof document === "undefined" || document.getElementById("ex-style")) return;
  const s = document.createElement("style");
  s.id = "ex-style";
  s.textContent = CSS;
  document.head.appendChild(s);
}

