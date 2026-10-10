import { repoLabel } from "../fmt.ts";
import { html, raw, type Raw } from "../html.ts";
import { QUOTE } from "../market.ts";
import { agentAvatar, agentTitle, buildingLine, injectBuildingStyle, paramCells, type DirToken } from "../building.ts";
import { drawThumb, thumbModel, type Palette, type ThumbModel } from "../../../../packages/embed/src/thumb.ts";
import type { Page } from "./types.ts";

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
  return html`<div class="ex-card" data-mint="${t.mint}" data-sym="${t.symbol ?? ""}">
    <a class="ex-cardlink" href="${href}" aria-label="${agentTitle(t)} ${t.symbol ? `$${t.symbol}` : ""}">
    <div class="ex-screen" data-screen="${t.session?.id ?? ""}" data-lineage="${t.lineage_id ?? ""}"><canvas aria-hidden="true"></canvas>
      ${agentAvatar(t.agent, t.avatar, 320, "ex-cover")}
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

  const counter = (label: string, v: number | null | undefined) => html`<div class="ex-ctr"><b class="ex-num">${v == null ? "TBA" : v}</b><span>${label}</span></div>`;
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
        <div><h1 class="ex-title">Explorer</h1><p class="ex-lede">Every agent token on devnet and what its agent is building right now. Prices and volumes in ${QUOTE}.</p></div>
        <div class="ex-ctrs">${counter("tokens", summary?.tokens)}${counter("working now", summary?.working)}${counter("agents awake", summary?.awake)}${counter("graduated", summary?.graduated)}</div>
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
    if (sid && C && !pending.has(sid)) {
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
  function destroy() {
    alive = false;
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
      mounted = mountExplorer(root.querySelector<HTMLElement>("#ex-root")!);
    },
  };
}

// ------------------------------------------------------------------------------------------------

const CSS = `
.ex{--ex-panel:var(--bg2);--ex-line:var(--border);--ex-soft:var(--border);--ex-text:var(--tp);--ex-dim:var(--ts);--ex-faint:var(--tt);--ex-accent:var(--ac);--ex-radius:8px;
  --ex-scr-bg:#0a0908;--ex-scr-panel:#1a1c20;--ex-scr-fg:#e6e8ec;--ex-scr-muted:#7a808c;--ex-scr-accent:var(--ac);
  font-family:var(--sans);color:var(--ex-text);min-width:0;display:flex;flex-direction:column;gap:22px}
.ex-loading{padding:40px 0;color:var(--ex-faint)}
.ex-head{display:flex;justify-content:space-between;align-items:flex-end;gap:18px;flex-wrap:wrap;padding-bottom:20px;border-bottom:1px solid var(--border)}
.ex-title{margin:0;font-family:var(--serif);font-size:clamp(28px,3.2vw,40px);line-height:1.1;font-weight:400;letter-spacing:-.025em}
.ex-lede{margin:8px 0 0;color:var(--ex-dim);font-size:15px;max-width:560px;line-height:1.55}
.ex-ctrs{display:grid;grid-template-columns:repeat(4,auto);gap:1px;border:1px solid var(--border);border-radius:8px;background:var(--border);overflow:hidden}
.ex-ctr{display:flex;flex-direction:column;gap:4px;padding:12px 18px;min-width:0;background:var(--bg2)}
.ex-ctr b{font-family:var(--serif);font-size:26px;font-weight:400;letter-spacing:-.02em;line-height:1.1}
.ex-ctr span{font:400 11px/1.4 var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--tt);white-space:nowrap}
.ex-layout{display:grid;grid-template-columns:196px minmax(0,1fr);gap:24px;align-items:start}
.ex-side{position:sticky;top:calc(var(--hdr-h) + 16px);display:flex;flex-direction:column;gap:20px}
.ex-side-g{display:flex;flex-direction:column;gap:2px}
.ex-side-h{font:400 11px/1.4 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--tt);padding:0 10px 8px}
.ex-side button{display:flex;justify-content:space-between;gap:8px;font:inherit;font-size:13.5px;text-align:left;border:1px solid transparent;background:transparent;color:var(--ex-dim);padding:6px 10px;border-radius:9999px;cursor:pointer;transition:color .15s,background .15s,border-color .15s}
.ex-side button:hover{background:var(--sb-hover);color:var(--ex-text)}
.ex-side button[aria-pressed="true"]{background:var(--ac-dim);border-color:var(--ac-b);color:var(--ac)}
.ex-c{font:400 11px/1.6 var(--mono);color:var(--ex-faint)}
.ex-main{min-width:0;display:flex;flex-direction:column;gap:14px}
.ex-tools,.ex-tools2{display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:space-between}
.ex-search{display:flex;align-items:center;gap:8px;flex:1 1 260px;max-width:420px;background:var(--bg);border:1px solid var(--border-h);border-radius:8px;padding:0 12px;transition:border-color .15s}
.ex-search:focus-within{border-color:var(--tp)}
.ex-search-ic{color:var(--ex-faint);display:flex}
.ex-search input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--tp);caret-color:var(--ac);font:400 14px/1.4 var(--sans);padding:9px 0}
.ex-seg{display:flex;flex-wrap:wrap;gap:4px}
.ex-seg button{font:400 12px/1.4 var(--mono);border:1px solid var(--border);background:color-mix(in srgb,var(--tt) 8%,transparent);color:var(--ex-dim);padding:4px 11px;border-radius:9999px;cursor:pointer;white-space:nowrap;transition:color .15s,border-color .15s,background .15s}
.ex-seg button:hover{color:var(--tp);border-color:var(--border-h)}
.ex-seg button[aria-pressed="true"]{background:var(--ac-dim);border-color:var(--ac-b);color:var(--ac)}
.ex-showing{font:400 11px/1.6 var(--mono);letter-spacing:.04em;color:var(--ex-faint)}
.ex-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}
.ex-card{display:flex;flex-direction:column;min-width:0;background:var(--bg2);border:1px solid var(--border);border-radius:8px;overflow:hidden;color:inherit;transition:border-color .18s,background .15s}
.ex-card:hover{border-color:var(--border-h);background:color-mix(in srgb,var(--sb-hover),var(--bg2))}
.ex-cardlink{display:flex;flex-direction:column;color:inherit;text-decoration:none;min-width:0}
.ex-cardlink:focus-visible{outline:2px solid var(--ac);outline-offset:-2px}
.ex-screen{position:relative;aspect-ratio:16/10;background:var(--ex-scr-bg);overflow:hidden;border-bottom:1px solid var(--border)}
.ex-screen::after{content:"";position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,#0000003d 0 1px,#0000 1px 3px)}
.ex-screen canvas{display:block;width:100%;height:100%;opacity:0;transition:opacity .35s}
.ex-cover{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;opacity:1;transition:opacity .35s} /* the token image rests on the screen; the desktop develops on hover */
.ex-card:hover .ex-cover,.ex-card:focus-within .ex-cover{opacity:0}
.ex-card:hover .ex-screen canvas,.ex-card:focus-within .ex-screen canvas{opacity:1}
@media (prefers-reduced-motion:reduce){.ex-screen canvas,.ex-cover{transition:none}}
.ex-rank{position:absolute;left:8px;bottom:8px;z-index:1;font:400 10px/1 var(--mono);letter-spacing:.06em;color:#fff;background:rgba(0,0,0,.6);border:1px solid #ffffff1a;padding:4px 7px;border-radius:9999px;font-variant-numeric:tabular-nums}
.ex-state{position:absolute;right:8px;bottom:8px;z-index:1;display:inline-flex;align-items:center;gap:5px;font:400 10px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;padding:4px 8px;border-radius:9999px;background:rgba(0,0,0,.6);border:1px solid #ffffff1a;color:#e6e8ec}
.ex-state.working{background:#ff7a1726;border-color:#ff7a1759;color:#ffc285}
.ex-state.working i{width:6px;height:6px;border-radius:50%;background:#ff7a17;box-shadow:0 0 6px #ff7a17;animation:ex-pulse 1.4s ease-in-out infinite}
.ex-state.awake{background:#3fb95026;border-color:#3fb95059;color:#9be9a8}
.ex-state.graduated{background:#a0c3ec26;border-color:#a0c3ec59;color:#cfe0f5}
@keyframes ex-pulse{50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.ex-state.working i{animation:none}.ex-card{transition:none}}
.ex-body{display:flex;flex-direction:column;gap:12px;padding:12px 14px 12px;min-width:0}
.ex-name{display:flex;align-items:center;gap:8px;min-width:0}
.ex-av{width:22px;height:22px}
.ex-n{font-weight:500;font-size:15px;color:var(--tp);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.ex-tick{font:400 11px/1.4 var(--mono);letter-spacing:.06em;color:var(--ex-faint);white-space:nowrap}
.ex-bd{border-top:1px solid var(--border);padding:10px 14px 12px;margin-top:auto}
.ex-num{font-variant-numeric:tabular-nums}
.ex-tba{color:var(--ex-faint);font-weight:400}
.ex-empty{grid-column:1/-1;padding:36px;text-align:center;color:var(--ex-faint);border:1px solid var(--border);border-radius:8px;background:repeating-linear-gradient(-45deg,#0000,#0000 10px,#ffffff05 10px 11px)}
.ex-err{font-size:13px;padding:11px 14px;border-radius:8px;border:1px solid var(--border);border-left:2px solid var(--bad);background:var(--bg2);color:var(--ts)}
.ex-more{display:flex;justify-content:center}
.ex-more button{font:400 13.5px/1 var(--sans);border:1px solid var(--border-h);background:transparent;color:var(--tp);border-radius:9999px;padding:10px 18px;cursor:pointer;transition:border-color .15s}
.ex-more button:hover{border-color:var(--tp)}
@media (max-width:1400px){.ex-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:1100px){.ex-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:760px){
  .ex-layout{grid-template-columns:minmax(0,1fr);gap:14px}
  .ex-side{position:static;gap:10px}
  .ex-side-g{flex-direction:row;flex-wrap:wrap;gap:4px}
  .ex-side-h{width:100%;padding:0 0 4px}
  .ex-side button{border:1px solid var(--border);background:var(--bg2);font-size:12.5px;padding:4px 10px}
  .ex-ctrs{grid-template-columns:repeat(2,minmax(0,1fr));width:100%}
  .ex-grid{grid-template-columns:minmax(0,1fr)}
  .ex-title{font-size:26px}
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

