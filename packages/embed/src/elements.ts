import { mount as mountPanel, type LivePanelHandle, type PanelIO } from "../../../apps/web/src/live-panel/index.ts";
import { scriptBase } from "./config.ts";
import { defaultTf, renderCandles } from "../../../apps/web/src/market.ts";
import type { Card, LineageClient, SessionView } from "./client.ts";
import { pool } from "./client.ts";
import { getClient, onConfigure, ourMints } from "./config.ts";
import { cardHtml, esc, howSteps, feesHtml, holdersHtml, howHtml, linkFor, statsHtml, timelineLayout, tokenHeadHtml, tradesHtml, STAT_ITEMS } from "./render.ts";
import { BASE, HOW, PALETTE, REEL, SCREEN, STATS, TERMINAL, TOKEN } from "./styles.ts";
import { COMMANDS, complete, FACTS, run, stepHtml, TUBES, type TermEnv } from "./terminal.ts";
import { dither, drawThumb, thumbModel, type Palette } from "./thumb.ts";
import type { Stats } from "./client.ts";

// The six custom elements (plus the optional palette). Each renders into its own shadow root, reads
// through the shared client (config.ts) and restarts when its attributes or the configuration change.

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

abstract class LineageElement extends HTMLElement {
  protected root!: ShadowRoot;
  protected box!: HTMLElement;
  protected alive = 0;
  private offCfg: (() => void) | null = null;
  protected abstract css: string;

  get client(): LineageClient {
    return getClient();
  }

  connectedCallback() {
    if (!this.root) {
      this.root = this.attachShadow({ mode: "open" });
      this.root.innerHTML = `<style>${BASE}${this.css}</style><div class="wrap" part="root"></div>`;
      this.box = this.root.querySelector(".wrap")!;
    }
    this.offCfg = onConfigure(() => this.restart());
    this.restart();
  }

  disconnectedCallback() {
    this.alive++;
    this.offCfg?.();
    this.stop();
  }

  attributeChangedCallback(_n: string, a: string | null, b: string | null) {
    if (a !== b && this.isConnected && this.root) this.restart();
  }

  protected restart() {
    this.alive++;
    this.stop();
    const g = this.alive;
    this.start(g).catch((e) => {
      if (g === this.alive) this.box.innerHTML = `<div class="err"><b>Lineage data did not load.</b> ${esc((e as Error).message ?? e)}</div>`;
    });
  }

  protected abstract start(g: number): Promise<void>;
  protected stop() {}
}

// ------------------------------------------------------------------------------------------- screen

function panelIO(c: LineageClient, root: ShadowRoot): Partial<PanelIO> {
  return {
    get: (p) => c.core(p, 0),
    fileAt: (l, g, p) => c.fileAt(l, g, p),
    blob: (d) => c.blob(d),
    events: () => c.openEvents(),
    href: (p) => c.href(p),
    linkAttrs: 'target="_blank" rel="noopener"',
    styleRoot: root,
  };
}

/** <lineage-screen agent= | mint= | session= mode= frame=window|crt|none height= compact list> */
export class LineageScreen extends LineageElement {
  static observedAttributes = ["agent", "mint", "session", "lineage", "mode", "frame", "height", "speed"];
  protected css = SCREEN;
  private panel: LivePanelHandle | null = null;

  /** Switches the screen to an agent (the terminal's `watch`). */
  watch(agent: string) {
    this.removeAttribute("session");
    this.removeAttribute("mint");
    this.setAttribute("agent", agent);
  }

  get session() {
    return this.panel?.session ?? null;
  }

  protected async start(g: number) {
    let agent = this.getAttribute("agent") ?? undefined;
    const mint = this.getAttribute("mint");
    if (!agent && mint) agent = (await this.client.token(mint)).agent;
    if (g !== this.alive) return;
    this.box.innerHTML = `<div class="host"></div>${this.getAttribute("frame") === "crt" && this.hasAttribute("scanlines") ? '<div class="scan"></div>' : ""}`;
    const h = Number(this.getAttribute("height")) || undefined;
    this.panel = mountPanel(this.box.querySelector<HTMLElement>(".host")!, {
      agent,
      session: this.getAttribute("session") ?? undefined,
      lineage: this.getAttribute("lineage") ?? undefined,
      mode: (this.getAttribute("mode") as any) ?? "auto",
      speed: Number(this.getAttribute("speed")) || 1,
      list: this.hasAttribute("list"),
      height: h ?? (matchMedia("(max-width: 760px)").matches ? 320 : 400),
      io: panelIO(this.client, this.root),
      onSession: (s) => this.dispatchEvent(new CustomEvent("lineage-session", { detail: s, bubbles: true, composed: true })),
    });
  }

  protected stop() {
    this.panel?.destroy();
    this.panel = null;
  }
}

// ------------------------------------------------------------------------------------------- reel

function colorOf(el: Element, v: string): [number, number, number] {
  const probe = document.createElement("span");
  probe.style.color = v;
  probe.style.display = "none";
  el.appendChild(probe);
  const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(probe).color);
  probe.remove();
  const p = (m?.[1] ?? "0,0,0").split(/[\s,/]+/).map(Number);
  return [p[0] || 0, p[1] || 0, p[2] || 0];
}

function paletteOf(el: Element): Palette {
  return { bg: colorOf(el, "var(--_bg)"), fg: colorOf(el, "var(--_fg)"), muted: colorOf(el, "var(--_muted)"), accent: colorOf(el, "var(--_accent)"), panel: colorOf(el, "var(--panel-3)") };
}

/** <lineage-reel sort= limit= look=plain|dither layout=strip|timeline|grid link=> */
export class LineageReel extends LineageElement {
  static observedAttributes = ["sort", "limit", "look", "layout", "link"];
  protected css = REEL;
  private io: IntersectionObserver | null = null;
  private unsub: (() => void)[] = [];
  private cards: Card[] = [];
  private queue: (() => Promise<void>)[] = [];
  private running = 0;
  private redraw = new Map<string, number>();

  protected async start(g: number) {
    if (!this.box.innerHTML) this.box.innerHTML = `<div class="ph" style="position:static;padding:24px">Loading agent tokens</div>`;
    const cards = await this.client.cards({ sort: this.getAttribute("sort") ?? "newest", limit: Number(this.getAttribute("limit")) || 12 });
    if (g !== this.alive) return;
    this.cards = cards;
    this.render();
    // live: a session starting, ending or moving changes a card's state and screen
    const refresh = debounce(() => g === this.alive && this.reload(g), 1500);
    this.unsub.push(this.client.subscribe("session.started", refresh), this.client.subscribe("session.ended", refresh));
    this.unsub.push(
      this.client.subscribe("session.events", (e) => {
        const c = this.cards.find((x) => x.session?.session_id === e.data?.session_id);
        if (!c) return;
        const last = this.redraw.get(c.mint) ?? 0;
        if (Date.now() - last < 5000) return;
        this.redraw.set(c.mint, Date.now());
        const el = this.root.querySelector<HTMLElement>(`.card[data-mint="${c.mint}"] .thumb`);
        if (el) this.enqueue(() => this.paint(el, c, g));
      }),
    );
  }

  private async reload(g: number) {
    const cards = await this.client.cards({ sort: this.getAttribute("sort") ?? "newest", limit: Number(this.getAttribute("limit")) || 12 }).catch(() => null);
    if (!cards || g !== this.alive) return;
    const changed = cards.map((c) => `${c.mint}:${c.state}:${c.session?.session_id}`).join() !== this.cards.map((c) => `${c.mint}:${c.state}:${c.session?.session_id}`).join();
    this.cards = cards;
    if (changed) this.render();
  }

  private render() {
    const look = this.getAttribute("look") === "dither" ? "dither" : "plain";
    const layout = this.getAttribute("layout") ?? "strip";
    const site = this.client.bases.site;
    const link = this.getAttribute("link");
    const one = (c: Card, style?: string) => cardHtml(c, { href: linkFor(link, site, c), look, style });
    if (!this.cards.length) {
      this.box.innerHTML = `<p class="none">No agent tokens yet.</p>`;
      return;
    }
    if (layout === "timeline") {
      const { xs, width, ticks } = timelineLayout(this.cards.map((c) => c.created_at));
      this.box.innerHTML = `<div class="tl" part="timeline"><div class="tl-track" style="width:${width}px">${this.cards
        .map((c, i) => one(c, `left:${xs[i]}px;top:${i % 2 ? 64 : 16}px`))
        .join("")}<div class="axis"></div>${ticks.map((t) => `<span class="tick" style="left:${t.x + 118}px">${esc(t.label)}</span>`).join("")}</div></div>`;
    } else this.box.innerHTML = `<div class="track" part="track">${this.cards.map((c) => one(c)).join("")}</div>`;
    this.io?.disconnect();
    const g = this.alive;
    this.io =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(
            (es) => {
              for (const e of es) {
                if (!e.isIntersecting) continue;
                this.io?.unobserve(e.target);
                const el = e.target as HTMLElement;
                const c = this.cards.find((x) => x.mint === el.closest<HTMLElement>(".card")?.dataset.mint);
                if (c) this.enqueue(() => this.paint(el, c, g));
              }
            },
            { rootMargin: "200px" },
          )
        : null;
    for (const el of this.root.querySelectorAll<HTMLElement>(".thumb")) {
      if (this.io) this.io.observe(el);
      else {
        const c = this.cards.find((x) => x.mint === el.closest<HTMLElement>(".card")?.dataset.mint);
        if (c) this.enqueue(() => this.paint(el, c, g));
      }
    }
  }

  private enqueue(f: () => Promise<void>) {
    this.queue.push(f);
    this.pump();
  }

  private pump() {
    while (this.running < 3 && this.queue.length) {
      const f = this.queue.shift()!;
      this.running++;
      void f()
        .catch(() => {})
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }

  /** Draws a card's screen: the session's latest file view, clean and (look=dither) dithered on top. */
  private async paint(el: HTMLElement, c: Card, g: number) {
    let view: SessionView | null = null;
    let text: string | null = null;
    if (c.session) {
      view = await this.client.session(c.session.session_id);
      const ev = [...view.event_list].reverse().find((e) => ["read", "edit", "write", "patch"].includes(e.kind) && e.path);
      if (ev) {
        const f = await this.client.fileAt(view.lineage_id, view.gen_id, ev.path!);
        text = "text" in f ? f.text : null;
      }
    }
    if (g !== this.alive || !el.isConnected) return;
    const m = view ? thumbModel(view, text) : { repo: "", file: null, lines: [], cursor: -1, caption: c.sessions_known ? "No authoring session yet" : "Sessions did not load", live: false };
    if (!m.lines.length) m.title = c.symbol ?? undefined;
    const w = Math.max(160, Math.round(el.clientWidth || 236));
    const h = Math.max(100, Math.round(el.clientHeight || 148));
    const pal = paletteOf(el);
    const font = getComputedStyle(this).getPropertyValue("--_font").trim() || "sans-serif";
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const clean = document.createElement("canvas");
    clean.width = w * dpr;
    clean.height = h * dpr;
    const ctx = clean.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    drawThumb(ctx, m, w, h, pal, font);
    clean.setAttribute("aria-hidden", "true");
    const nodes: HTMLCanvasElement[] = [clean];
    if (this.getAttribute("look") === "dither") {
      // one dither cell per CSS pixel: coarse enough to read as dithered, fine enough to keep the code legible
      const dw = w;
      const dh = h;
      const d = document.createElement("canvas");
      d.width = dw;
      d.height = dh;
      const dc = d.getContext("2d", { willReadFrequently: true });
      if (dc) {
        dc.drawImage(clean, 0, 0, dw, dh);
        const img = dc.getImageData(0, 0, dw, dh);
        dither(img.data, dw, dh, pal);
        dc.putImageData(img, 0, 0);
        d.className = "dith";
        d.setAttribute("aria-hidden", "true");
        nodes.push(d);
      }
    }
    el.replaceChildren(...nodes);
    const cap = el.closest(".card")?.querySelector(".cap");
    if (cap && view) cap.textContent = m.caption;
  }

  protected stop() {
    this.io?.disconnect();
    this.io = null;
    for (const u of this.unsub) u();
    this.unsub = [];
    this.queue = [];
  }
}

function debounce(f: () => unknown, ms: number) {
  let t: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => ((t = null), f()), ms);
  };
}

// ------------------------------------------------------------------------------------------- token

/** <lineage-token mint= tf=> the token page block: header, screen, chart, trades, holders, fees. */
export class LineageToken extends LineageElement {
  static observedAttributes = ["mint", "tf", "link"];
  protected css = SCREEN + TOKEN;
  private panel: LivePanelHandle | null = null;
  private ro: ResizeObserver | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  protected async start(g: number) {
    const mint = this.getAttribute("mint");
    if (!mint) {
      this.box.innerHTML = `<p class="none">Set the mint attribute to a token mint.</p>`;
      return;
    }
    const c = this.client;
    const t = await c.token(mint);
    const tf = this.getAttribute("tf") ?? defaultTf(t.created_at);
    const [soul, candles, trades, holders, fees] = await Promise.all([
      c.soul(t.agent).catch(() => null),
      c.candles(mint, tf).catch(() => ({ tf, candles: [] })),
      c.trades(mint, 15).catch(() => ({ trades: [] })),
      c.holders(mint, 10).catch(() => null),
      c.fees(mint).catch(() => null),
    ]);
    if (g !== this.alive) return;
    const trade = linkFor(this.getAttribute("link"), c.bases.site, { mint, agent: t.agent, symbol: t.symbol });
    this.box.innerHTML = `${tokenHeadHtml(t, soul?.tagline ?? null, trade)}
      <div class="grid">
        <section><h3>What the agent is building</h3><div class="screen"></div></section>
        <section><h3>Price in tLINE, ${esc(tf)} candles</h3><div class="chart" part="chart"></div>
          <h3>Recent trades</h3>${tradesHtml(trades.trades)}</section>
      </div>
      <div class="grid">
        <section><h3>Fees to compute</h3>${fees ? feesHtml(fees) : '<p class="none">Fee history did not load.</p>'}</section>
        <section><h3>Holders</h3>${holders ? holdersHtml(holders) : '<p class="none">Holders did not load.</p>'}</section>
      </div>`;
    this.panel = mountPanel(this.box.querySelector<HTMLElement>(".screen")!, { agent: t.agent, height: matchMedia("(max-width: 760px)").matches ? 320 : 400, io: panelIO(c, this.root) });
    const chart = this.box.querySelector<HTMLElement>(".chart")!;
    const draw = () => (chart.innerHTML = renderCandles({ tf, candles: candles.candles, start: t.start_price }, chart.clientWidth, chart.clientHeight));
    draw();
    this.ro = new ResizeObserver(() => draw());
    this.ro.observe(chart);
    this.timer = setInterval(() => {
      if (!this.isConnected) return;
      c.market(`tokens/${mint}`, 0).then((d) => d.trades !== t.trades && g === this.alive && this.restart()).catch(() => {});
    }, 30_000);
  }

  protected stop() {
    this.panel?.destroy();
    this.panel = null;
    this.ro?.disconnect();
    if (this.timer) clearInterval(this.timer);
  }
}

// ------------------------------------------------------------------------------------------- how, stats

/** <lineage-how> the mechanism in six steps with live figures. */
export class LineageHow extends LineageElement {
  protected css = HOW;
  private timer: ReturnType<typeof setInterval> | null = null;
  protected async start(g: number) {
    const draw = async () => {
      const s = await this.client.stats({ fees: true });
      if (g === this.alive) this.box.innerHTML = howHtml(s);
    };
    await draw();
    this.timer = setInterval(() => void draw().catch(() => {}), 60_000);
  }
  protected stop() {
    if (this.timer) clearInterval(this.timer);
  }
}

/** <lineage-stats keys="tokens,agents_working,generations,fees_to_compute" layout=row|ticker> */
export class LineageStats extends LineageElement {
  static observedAttributes = ["keys", "layout"];
  protected css = STATS;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsub: (() => void) | null = null;
  protected async start(g: number) {
    const keys = (this.getAttribute("keys") ?? STAT_ITEMS.map((x) => x.key).join(",")).split(",").map((s) => s.trim()).filter(Boolean) as (keyof Stats)[];
    const fees = keys.includes("fees_to_compute");
    const draw = async () => {
      const s = await this.client.stats({ fees });
      if (g === this.alive) this.box.innerHTML = statsHtml(s, keys);
    };
    await draw();
    this.timer = setInterval(() => void draw().catch(() => {}), 30_000);
    this.unsub = this.client.subscribe("generation.accepted", debounce(() => void draw().catch(() => {}), 2000));
  }
  protected stop() {
    if (this.timer) clearInterval(this.timer);
    this.unsub?.();
  }
}

// ------------------------------------------------------------------------------------------- terminal

const ICON_FULL = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/></svg>`;

/** Terminals on the page, for Lineage.terminal.openAndRun. */
export const terminals = new Set<LineageTerminal>();

/**
 * <lineage-terminal for="screen-id" frame=window|crt|none height= title= autorun= guide
 *   href-tokens= href-ours= href-launch= href-docs= href-explorer=>
 */
export class LineageTerminal extends LineageElement {
  static observedAttributes = ["frame"];
  protected css = TERMINAL;
  private hist: string[] = [];
  private hi = 0;
  private how = -1;
  private guideAt = -1;
  private tickers: string[] = [];
  private stats: Stats | null = null;
  private built = false;

  connectedCallback() {
    super.connectedCallback();
    terminals.add(this);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    terminals.delete(this);
  }

  private links() {
    const site = this.client.bases.site;
    const at = (k: string, d: string) => this.getAttribute(`href-${k}`) ?? `${site}${d}`;
    return { tokens: at("tokens", "/tokens"), ours: at("ours", "/tokens?ours=1"), launch: at("launch", "/spawn"), docs: at("docs", "/docs"), explorer: at("explorer", "/explorer"), token: (m: string) => `${site}/tokens/${m}`, site };
  }

  private async env(): Promise<TermEnv> {
    return { client: this.client, links: this.links(), ours: await ourMints() };
  }

  protected async start(g: number) {
    if (!this.built) {
      this.built = true;
      const h = Number(this.getAttribute("height"));
      const title = this.getAttribute("title") ?? "Lineage CLI";
      this.box.innerHTML = `<div class="term" part="terminal"${h ? ` style="--h:${h}px"` : ""}>
        ${this.getAttribute("frame") === "none" ? "" : `<div class="bar" part="titlebar"><button type="button" class="knob" data-act="tube" title="Recolor the tube" aria-label="Recolor the tube"></button><span class="title">${esc(title)} <span>devnet</span></span><span class="sp"></span><button type="button" class="ib" data-act="full" title="Full screen" aria-label="Full screen">${ICON_FULL}</button></div>`}
        <div class="out" role="log" aria-live="polite" aria-label="Terminal output"></div>
        <div class="next" hidden><button type="button" class="q" data-act="next">Next</button><button type="button" class="q" data-act="done">Done</button></div>
        <form class="prompt"><label for="in">lineage %</label><input id="in" autocomplete="off" spellcheck="false" aria-label="Command" placeholder="type help, or ask a question"></form>
        <div class="quick" part="quick">
          <button type="button" class="q" data-run="how">How it works</button>
          <a class="q" data-go="tokens">Explore tokens</a><a class="q" data-go="ours">Our tokens</a><a class="q" data-go="launch">Launch</a><a class="q" data-go="docs">Docs</a><a class="q" data-go="explorer">Explorer</a>
        </div>
        <div class="guide" hidden role="dialog" aria-label="Guide"><b class="gt"></b><p class="gb"></p><div class="row"><span class="gn"></span><button type="button" class="q" data-act="gnext">Next</button><button type="button" class="q" data-act="gok">Got it</button></div></div>
        <div class="scan"></div>
      </div>`;
      this.wire();
      this.print([`<span class="dim">Lineage on Solana devnet. Type ${'<button type="button" class="run" data-run="help">help</button>'}, or ask a question with ask.</span>`]);
      const auto = this.getAttribute("autorun");
      if (auto) void this.exec(auto, false);
      if (this.hasAttribute("guide")) void this.guide(0);
    }
    for (const a of this.box.querySelectorAll<HTMLAnchorElement>("a[data-go]")) {
      a.href = (this.links() as any)[a.dataset.go!];
      a.target = "_blank";
      a.rel = "noopener";
    }
    this.client.tokens().then((ts) => (this.tickers = ts.map((t) => t.symbol ?? "").filter(Boolean))).catch(() => {});
    void g;
  }

  private q<T extends HTMLElement>(s: string) {
    return this.box.querySelector<T>(s)!;
  }

  private wire() {
    const input = this.q<HTMLInputElement>("input");
    this.q("form").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const v = input.value;
      input.value = "";
      if (!v.trim() && this.how >= 0) return void this.stepHow();
      void this.exec(v);
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowUp" && this.hist.length) {
        ev.preventDefault();
        this.hi = Math.max(0, this.hi - 1);
        input.value = this.hist[this.hi] ?? "";
      } else if (ev.key === "ArrowDown" && this.hist.length) {
        ev.preventDefault();
        this.hi = Math.min(this.hist.length, this.hi + 1);
        input.value = this.hist[this.hi] ?? "";
      } else if (ev.key === "Tab") {
        ev.preventDefault();
        const r = complete(input.value, this.tickers);
        input.value = r.line;
        if (r.options.length > 1) this.print([`<span class="dim">${r.options.map(esc).join("  ")}</span>`]);
      }
    });
    this.box.addEventListener("click", async (ev) => {
      const t = ev.target as HTMLElement;
      const r = t.closest<HTMLElement>("[data-run]");
      if (r) return void this.exec(r.dataset.run!);
      const go = t.closest<HTMLAnchorElement>("a[data-go]");
      if (go) {
        // a one line preview with live numbers before the page opens
        const k = go.dataset.go!;
        const s = await this.client.stats().catch(() => null);
        const n = (v: number | null | undefined) => (v == null ? "TBA" : String(v));
        const line =
          k === "tokens" ? `Opening the token list: ${n(s?.tokens)} agent tokens, ${n(s?.agents_working)} agents working now.`
          : k === "ours" ? `Opening the project's own tokens.`
          : k === "launch" ? `Opening the launch page: ${n(s?.tokens)} agents launched so far.`
          : k === "docs" ? "Opening the docs."
          : `Opening the explorer: ${n(s?.generations)} verified generations to look through.`;
        this.print([`<span class="dim">${esc(line)}</span>`]);
        return;
      }
      const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act === "tube") this.cycleTube();
      else if (act === "full") this.q(".term").classList.toggle("full");
      else if (act === "next") void this.stepHow();
      else if (act === "done") this.endHow();
      else if (act === "gnext") void this.guide(this.guideAt + 1);
      else if (act === "gok") this.q(".guide").hidden = true;
    });
  }

  private print(html: string[], echo?: string) {
    const out = this.q(".out");
    if (echo !== undefined) out.insertAdjacentHTML("beforeend", `<div class="echo">${esc(echo)}</div>`);
    for (const h of html) out.insertAdjacentHTML("beforeend", `<div>${h}</div>`);
    while (out.children.length > 400) out.firstElementChild!.remove();
    out.scrollTop = out.scrollHeight;
  }

  private cycleTube() {
    const keys = Object.keys(TUBES);
    const cur = this.q(".term").style.getPropertyValue("--tube");
    const i = keys.findIndex((k) => TUBES[k] === cur);
    this.q(".term").style.setProperty("--tube", TUBES[keys[(i + 1) % keys.length]!]!);
  }

  /** Runs a command line as if typed. */
  async exec(line: string, echo = true) {
    const v = line.trim();
    if (v) {
      this.hist.push(v);
      this.hi = this.hist.length;
    }
    if (this.how >= 0 && v) this.endHow(false);
    try {
      const o = await run(v, await this.env());
      if (o.clear) this.q(".out").innerHTML = "";
      this.print(o.html, echo ? v : undefined);
      if (o.tube) this.q(".term").style.setProperty("--tube", o.tube);
      if (o.fullscreen) this.q(".term").classList.toggle("full");
      if (o.nav) window.open(o.nav, "_blank", "noopener");
      if (o.watch) this.watch(o.watch.agent, o.watch.label);
      if (o.how !== undefined) {
        this.how = o.how - 1;
        this.stats = await this.client.stats({ fees: true });
        await this.stepHow();
      }
      if (o.guide) await this.guide(0);
    } catch (e) {
      this.print([`<span class="dim">That did not load: ${esc((e as Error).message ?? e)}</span>`], echo ? v : undefined);
    }
  }

  private async stepHow() {
    if (!this.stats) this.stats = await this.client.stats({ fees: true });
    this.how++;
    this.print([stepHtml(this.stats, this.how)]);
    if (this.how >= 5) return this.endHow();
    this.q(".next").hidden = false;
    this.q<HTMLInputElement>("input").placeholder = "press Enter for the next step";
  }

  private endHow(note = true) {
    if (this.how < 0) return;
    this.how = -1;
    this.q(".next").hidden = true;
    this.q<HTMLInputElement>("input").placeholder = "type help, or ask a question";
    if (note) this.print([`<span class="dim">That is the loop. Try <button type="button" class="run" data-run="tokens">tokens</button> or <button type="button" class="run" data-run="ask how is a change verified">ask how is a change verified</button>.</span>`]);
  }

  private async guide(i: number) {
    const s = this.stats ?? (this.stats = await this.client.stats({ fees: true }).catch(() => null));
    const steps = s ? howSteps(s) : [];
    const box = this.q(".guide");
    if (!steps.length || i >= steps.length) {
      box.hidden = true;
      return;
    }
    this.guideAt = i;
    const st = steps[i]!;
    box.querySelector(".gt")!.textContent = `${st.n}. ${st.title}`;
    box.querySelector(".gb")!.textContent = `${st.body}${st.figure ? ` Right now: ${st.figure.value}${st.figure.unit && st.figure.value !== "TBA" ? ` ${st.figure.unit}` : ""} ${st.figure.label}.` : ""}`;
    box.querySelector(".gn")!.textContent = `${i + 1} of ${steps.length}`;
    box.querySelector<HTMLElement>('[data-act="gnext"]')!.hidden = i === steps.length - 1;
    box.hidden = false;
  }

  private watch(agent: string, label: string) {
    const id = this.getAttribute("for");
    const target = (id ? document.getElementById(id) : document.querySelector("lineage-screen")) as LineageScreen | null;
    if (target && typeof (target as any).watch === "function") target.watch(agent);
    else this.print([`<span class="dim">No lineage-screen on this page to show ${esc(label)}.</span>`]);
  }

  focusInput() {
    this.q<HTMLInputElement>("input")?.focus();
  }
}

/** Lineage.terminal.openAndRun: scrolls the first terminal into view and runs a command there. */
export async function openAndRun(cmd: string) {
  const t = [...terminals][0];
  if (!t) return false;
  t.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "center" });
  await t.exec(cmd);
  t.focusInput();
  return true;
}

// ------------------------------------------------------------------------------------------- palette

/** <lineage-palette> Cmd K (or Ctrl K): pages, commands and tokens; commands run in the page's terminal. */
export class LineagePalette extends LineageElement {
  protected css = PALETTE;
  private items: { kind: string; label: string; detail: string; act: () => void }[] = [];
  private sel = 0;
  private onKey = (ev: KeyboardEvent) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") {
      ev.preventDefault();
      this.open();
    } else if (ev.key === "Escape") this.close();
  };

  protected async start() {
    this.box.innerHTML = `${this.hasAttribute("trigger") ? `<button type="button" class="trig" data-open>Jump to <kbd>Cmd K</kbd></button>` : ""}<div class="ov" hidden><div class="box" role="dialog" aria-label="Jump to"><input placeholder="Search pages, commands and tokens" aria-label="Search"><div class="list" role="listbox"></div></div></div>`;
    document.addEventListener("keydown", this.onKey);
    this.box.querySelector("[data-open]")?.addEventListener("click", () => this.open());
    const ov = this.box.querySelector<HTMLElement>(".ov")!;
    ov.addEventListener("click", (ev) => {
      if (ev.target === ov) this.close();
      const it = (ev.target as HTMLElement).closest<HTMLElement>("[data-i]");
      if (it) this.pickItem(Number(it.dataset.i));
    });
    const input = this.box.querySelector<HTMLInputElement>("input")!;
    input.addEventListener("input", () => ((this.sel = 0), this.draw()));
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowDown") (ev.preventDefault(), (this.sel++), this.draw());
      else if (ev.key === "ArrowUp") (ev.preventDefault(), (this.sel = Math.max(0, this.sel - 1)), this.draw());
      else if (ev.key === "Enter") {
        const hit = this.filtered()[this.sel];
        if (hit) this.pickItem(hit.i);
      }
    });
  }

  protected stop() {
    document.removeEventListener("keydown", this.onKey);
  }

  async open() {
    const site = this.client.bases.site;
    const go = (u: string) => () => window.open(u, "_blank", "noopener");
    const runIt = (c: string) => () => void openAndRun(c);
    this.items = [
      { kind: "Page", label: "Tokens", detail: "every agent token", act: go(`${site}/tokens`) },
      { kind: "Page", label: "Launch an agent", detail: "", act: go(`${site}/spawn`) },
      { kind: "Page", label: "Explorer", detail: "", act: go(`${site}/explorer`) },
      { kind: "Page", label: "Docs", detail: "", act: go(`${site}/docs`) },
      ...COMMANDS.map((c) => ({ kind: "Command", label: c.usage, detail: c.blurb, act: runIt(c.name) })),
      ...FACTS.map((f) => ({ kind: "Ask", label: f.q, detail: "", act: runIt(`ask ${f.q}`) })),
    ];
    const ov = this.box.querySelector<HTMLElement>(".ov")!;
    ov.hidden = false;
    this.draw();
    this.box.querySelector<HTMLInputElement>("input")!.focus();
    const ts = await this.client.tokens({ sort: "market_cap" }).catch(() => []);
    this.items.push(...ts.map((t) => ({ kind: "Token", label: t.symbol ?? t.mint, detail: t.name ?? "", act: go(`${site}/tokens/${t.mint}`) })));
    this.draw();
  }

  close() {
    const ov = this.box?.querySelector<HTMLElement>(".ov");
    if (ov) ov.hidden = true;
  }

  private filtered() {
    const q = (this.box.querySelector<HTMLInputElement>("input")?.value ?? "").toLowerCase().trim();
    return this.items.map((x, i) => ({ x, i })).filter(({ x }) => !q || `${x.kind} ${x.label} ${x.detail}`.toLowerCase().includes(q)).slice(0, 40);
  }

  private draw() {
    const f = this.filtered();
    this.sel = Math.min(this.sel, Math.max(0, f.length - 1));
    this.box.querySelector(".list")!.innerHTML = f.length
      ? f.map(({ x, i }, k) => `<button type="button" class="it" role="option" data-i="${i}" aria-selected="${k === this.sel}"><span class="k">${esc(x.kind)}</span><span>${esc(x.label)}</span><span class="d">${esc(x.detail)}</span></button>`).join("")
      : `<p class="none" style="padding:8px 10px">Nothing matches.</p>`;
  }

  private pickItem(idx: number) {
    const hit = this.items[idx];
    if (!hit) return;
    this.close();
    hit.act();
  }
}

// ------------------------------------------------------------------------------------------- explorer

type MountExplorer = (el: HTMLElement, o: any) => { destroy(): void };
let explorerLoad: Promise<MountExplorer> | null = null;

/** Loads lineage-explorer.js (next to lineage-embed.js) once; it is kept out of the main file for size. */
function loadExplorer(): Promise<MountExplorer> {
  const w = window as any;
  if (w.__lineageMountExplorer) return Promise.resolve(w.__lineageMountExplorer);
  return (explorerLoad ??= new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = `${scriptBase()}/lineage-explorer.js`;
    s.onload = () => (w.__lineageMountExplorer ? res(w.__lineageMountExplorer) : rej(new Error("lineage-explorer.js did not register")));
    s.onerror = () => rej(new Error(`${s.src} did not load`));
    document.head.appendChild(s);
  }));
}

/**
 * <lineage-explorer link=> a thin wrapper over the explorer+docs lane's mountExplorer
 * (apps/web/src/pages/explorer.ts), loaded on demand from lineage-explorer.js. It renders in the
 * light DOM because that module styles itself through one document stylesheet (ex- prefixed).
 */
export class LineageExplorer extends HTMLElement {
  static observedAttributes = ["link"];
  private h: { destroy(): void } | null = null;
  private gen = 0;
  async connectedCallback() {
    const g = ++this.gen;
    const mountExplorer = await loadExplorer().catch((e) => {
      this.innerHTML = `<p style="opacity:.7">The explorer did not load: ${esc(e.message)}</p>`;
      return null;
    });
    if (!mountExplorer || g !== this.gen || !this.isConnected) return;
    const c = getClient();
    const link = this.getAttribute("link");
    this.h = mountExplorer(this, {
      market: c.bases.market,
      core: c.bases.core,
      tokenHref: (mint: string) => linkFor(link, c.bases.site, { mint, agent: "", symbol: null }),
    });
  }
  disconnectedCallback() {
    this.gen++;
    this.h?.destroy();
    this.h = null;
  }
  attributeChangedCallback() {
    if (!this.isConnected) return;
    this.disconnectedCallback();
    void this.connectedCallback();
  }
}

export const ELEMENTS: [string, CustomElementConstructor][] = [
  ["lineage-explorer", LineageExplorer],
  ["lineage-screen", LineageScreen],
  ["lineage-reel", LineageReel],
  ["lineage-token", LineageToken],
  ["lineage-how", LineageHow],
  ["lineage-stats", LineageStats],
  ["lineage-terminal", LineageTerminal],
  ["lineage-palette", LineagePalette],
];

export { pool };
