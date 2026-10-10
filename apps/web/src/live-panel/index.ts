import { endOf, idleHeadline, idleStatus, idleSub, lastEndOf, type IdleStatus } from "./live-only.ts";
import { mountDevice, type DeviceHandle } from "../../../../packages/embed/src/device.ts";
import { describeEvent } from "../../../../packages/embed/src/render.ts";
import { ApiError, get } from "../api.ts";
import { fileAt } from "../code.ts";
import { esc } from "../html.ts";
import { ensureStyle } from "./style.ts";
import { playDesktop, type DeskPlayer, type DeskStatus } from "./desk-player.ts";

// The agent's screen (SPEC 17.3, 17.7; owner direction 2026-10-10: "i just want the screen to be
// honest"). What it shows is only what is true:
//
// - a live session on a desktop: the desktop's own video stream (its real Chromium, editor and
//   terminals; the editor's text area and the run terminal are pixelated on the server until the
//   verdict), filling the machine's screen, with nothing drawn around or over it;
// - before the first frame, after the stream went away, or when frames stop: text saying so
//   ("Connecting to the live desktop", "Stream unavailable: <reason>", "No new frames since <time>");
// - a live session without a desktop: that sentence and the session's real facts, no animation;
// - no live session: the agent's idle state ("Desktop ended: next session starting", "Agent idle
//   since <time>", or the pause the runtime reports);
// - an ended session (session pages): its final facts and the network's verdict.
//
// Nothing is reconstructed or simulated: there is no drawn browser, address bar, tab strip, pointer or
// replay. Under the screen: one caption line of facts and the session's latest public event.
//
//   import { mount } from "./live-panel/index.ts";
//   const panel = mount(el, { agent });            // the agent's live session, else its idle state
//   const panel = mount(el, { session });          // one session
//   panel.destroy();
//
// frame: "device" (default: on the shared machine's screen, packages/embed/src/device.ts), "window"
// (the screen alone with rounded corners) or "none" (the screen alone, for hosts that draw a frame).
// Outside the dashboard (the embed kit) pass `io`: where Core and the stream live, how links are
// written, and the shadow root to put the styles in.

export type PanelMode = "auto" | "live" | "replay";
export type PanelFrame = "device" | "window" | "none";

export interface LivePanelOptions {
  /** one session by id */
  session?: string;
  /** an agent: its session in progress, else its idle state */
  agent?: string;
  /** a lineage: the same, over every agent's sessions on it */
  lineage?: string;
  /** kept for callers; the screen only ever shows live work */
  mode?: PanelMode;
  /** kept for callers; unused */
  speed?: number;
  /** list the other live sessions under the screen (agent and lineage mounts; default true) */
  list?: boolean;
  /** kept for callers: the screen keeps the desktop's 16:10 shape */
  height?: number;
  /** the machine, the screen alone with rounded corners, or no frame (default "device") */
  frame?: PanelFrame;
  /** kept for callers; unused */
  fps?: number;
  /** the agent's name for the caption (the page knows it; default its short address) */
  label?: string;
  /** called whenever the shown session changes or its summary updates */
  onSession?: (s: SessionSummary | null) => void;
  /** kept for callers; past sessions are never replayed */
  recordings?: boolean;
  /** data and link access; defaults to the dashboard's own (/api, /live/events, same-origin links) */
  io?: Partial<PanelIO>;
}

/** Everything the panel reads from outside itself. The dashboard uses DEFAULT_IO; the embed kit its own client. */
export interface PanelIO {
  /** GET a Core path (no /v1 prefix), JSON; throws ApiError (status 404 for a missing record) */
  get<T = any>(path: string): Promise<T>;
  /** a file at a generation (kept for the embed kit's io; the screen does not draw files) */
  fileAt(lineage: string, gen: string, path: string): Promise<{ text: string | null } | { error: string; message: string }>;
  /** a blob's bytes parsed as JSON, or null */
  blob(digest: string): Promise<any>;
  /** a new connection to the event stream (the panel closes it on destroy), or null for none */
  events(): EventSource | null;
  /** the URL of a Lineage page such as /agents/<id> */
  href(path: string): string;
  /** extra attributes on every link (an embed opens the Lineage site in a new tab) */
  linkAttrs: string;
  /** where the panel's stylesheet goes */
  styleRoot: Document | ShadowRoot;
  /** agent desktops (SPEC 17.7): the base URL of a session's live stream (".../desktops/<id>/"), or null for none */
  desktop?: ((session: string) => string) | null;
  /** a Core path as a URL this page can load (kept for the embed kit's io) */
  media?: (corePath: string) => string;
  /** the identity service's public view of an agent (its `published` commits), or null for none */
  identity?: ((agent: string) => Promise<any>) | null;
}

export const DEFAULT_IO: PanelIO = {
  get,
  fileAt,
  async blob(digest) {
    const res = await fetch(`/api/blobs/${digest}`);
    return res.ok ? JSON.parse(await res.text()) : null;
  },
  events: () => (typeof EventSource === "undefined" ? null : new EventSource("/live/events")),
  href: (p) => p,
  desktop: (id) => `/desktops/${id}/`,
  media: (p) => p.replace(/^\/v1\//, "/api/"),
  identity: (agent) =>
    fetch(`/identity/agents/${agent}`, { headers: { accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  linkAttrs: "",
  get styleRoot() {
    return document;
  },
};

export interface LivePanelHandle {
  readonly session: SessionSummary | null;
  /** shows another session */
  show(sessionId: string, mode?: PanelMode): Promise<void>;
  setSpeed(speed: number): void;
  destroy(): void;
}

export interface SessionSummary {
  session_id: string;
  state: "live" | "sealed" | "final" | "ended" | "abandoned";
  open: boolean;
  agent: string | null;
  lineage_id: string;
  recipe_name: string | null;
  class: string | null;
  repo: string | null;
  commit: string;
  gen_id: string;
  height: number | null;
  proposer: string;
  started_at: number;
  last_at: number;
  ended_at: number | null;
  events: number;
  /** the session ran on a live desktop (SPEC 17.7) */
  desktop?: boolean;
  /** the desktop's recording, linked once the gate opened (not shown: live only) */
  recording?: { sha256: string; bytes: number; url: string } | null;
  candidate: null | { commit_id: string; candidate_id: string | null; status: string; reason: string | null; kind: string; target: unknown; gen_id: string | null; committed_at: number; finalized_at: number | null; verdict: any };
}

interface SEv {
  seq: number;
  kind: string;
  at: number;
  path?: string;
  start_line?: number;
  end_line?: number;
  query?: string;
  phase?: string;
  target?: string;
  sealed?: boolean;
  after?: string;
  outcome?: string;
  text?: string;
  reason?: string;
}

/** how often a stream that went away is asked for again while Core still lists the session live */
const RETRY_MS = 15_000;

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const when = (t: number) => {
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : `${Math.floor(s / 60)} min ${s % 60} s`;
};
const repoName = (u: string | null) => (u ? u.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "").replace(/^https?:\/\//, "") : "its repository");
const short = (a: string) => `${a.slice(0, 4)}...${a.slice(-4)}`;

export function mount(el: HTMLElement, opts: LivePanelOptions = {}): LivePanelHandle {
  ensureStyle(opts.io?.styleRoot ?? document);
  const p = new Panel(el, opts);
  void p.init();
  return {
    get session() {
      return p.summary;
    },
    show: (id) => p.load(id),
    setSpeed: () => undefined,
    destroy: () => p.destroy(),
  };
}
export { mount as mountLivePanel };

class Panel {
  summary: SessionSummary | null = null;
  private latest: SEv | null = null;
  /** what the screen shows */
  private view: "loading" | "live" | "facts" | "idle" | "error" = "loading";
  private idle: IdleStatus | null = null;
  private error = "";
  private stream: DeskStatus | null = null;
  private player: DeskPlayer | null = null;
  private playerKey = "";
  private retry: ReturnType<typeof setTimeout> | null = null;
  private others: SessionSummary[] = [];
  private network: any = null;
  private verified: { url: string; label: string } | null = null;
  private es: EventSource | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private dead = false;
  private gen = 0;
  private device: DeviceHandle | null = null;
  private root!: HTMLElement;
  private scr!: HTMLElement;
  private video!: HTMLVideoElement;
  private msg!: HTMLElement;
  private io: PanelIO;
  private frame: PanelFrame;
  private a = (path: string) => `href="${esc(this.io.href(path))}"${this.io.linkAttrs ? ` ${this.io.linkAttrs}` : ""}`;
  private q = <T extends HTMLElement = HTMLElement>(sel: string) => this.root.querySelector<T>(sel)!;

  constructor(
    private host: HTMLElement,
    private opts: LivePanelOptions,
  ) {
    this.io = { ...DEFAULT_IO, styleRoot: DEFAULT_IO.styleRoot, ...(opts.io ?? {}) };
    this.frame = opts.frame === "window" || opts.frame === "none" ? opts.frame : "device";
  }

  async init() {
    this.host.innerHTML = `<div class="lp" data-frame="${this.frame}" data-view="loading" role="region" aria-label="Agent screen">
      <div class="lp-stage"></div>
      <div class="lp-deck">
        <div class="lp-say" aria-live="polite"><span class="lp-state" data-s="idle"><i></i><span>Loading</span></span><span class="t"></span><span class="tm"></span></div>
        <div class="lp-note" hidden></div>
        <div class="lp-latest" hidden></div>
      </div>
      <div class="lp-run" hidden></div>
    </div>${this.opts.list === false || this.opts.session ? "" : '<div class="lp-list" aria-label="Live sessions"></div>'}`;
    this.root = this.host.querySelector(".lp")!;
    const scr = document.createElement("div");
    scr.className = "lp-scr";
    scr.dataset.show = "msg";
    scr.innerHTML = `<video class="lp-video" muted playsinline autoplay disablepictureinpicture aria-label="The agent's live desktop"></video><div class="lp-stall" hidden></div><div class="lp-msg" role="status"></div>`;
    this.scr = scr;
    this.video = scr.querySelector("video")!;
    this.msg = scr.querySelector(".lp-msg")!;
    this.scr.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).closest("[data-act=play]")) this.player?.resume();
    });
    const stage = this.q(".lp-stage");
    if (this.frame === "device") this.device = mountDevice(stage, { screen: scr, glass: "clear", lights: 0 });
    else stage.appendChild(scr);
    this.host.addEventListener("click", (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-sess]");
      if (b) void this.load(b.dataset.sess!);
    });
    this.paint();
    this.connect();
    this.poll = setInterval(() => {
      if (!this.host.isConnected) return this.destroy();
      if (this.view === "idle" || this.view === "error") void this.pickFromList(true);
      else if (this.summary && (this.summary.state === "live" || this.summary.state === "sealed")) void this.refresh();
    }, 10_000);
    try {
      if (this.opts.session) await this.load(this.opts.session);
      else await this.pickFromList();
    } catch (e) {
      this.view = "error";
      this.error = e instanceof ApiError && e.status === 404 ? "Core has no session with this id." : `Core did not answer: ${(e as Error).message}`;
      this.paint();
    }
  }

  destroy() {
    if (this.dead) return;
    this.dead = true;
    this.gen++;
    this.es?.close();
    if (this.poll) clearInterval(this.poll);
    if (this.retry) clearTimeout(this.retry);
    this.player?.stop();
  }

  private listQuery() {
    return this.opts.agent ? `agent=${this.opts.agent}` : this.opts.lineage ? `lineage=${this.opts.lineage}` : "";
  }

  private async pickFromList(quiet = false) {
    const q = this.listQuery();
    const all = await this.io.get<SessionSummary[]>(`sessions?${q}${q ? "&" : ""}limit=24`).catch((e) => {
      if (quiet) return null;
      throw e;
    });
    if (!all || this.dead) return;
    this.others = all.filter((s) => s.state === "live");
    const live = this.others[0];
    if (live) {
      if (this.summary?.session_id !== live.session_id || this.view !== "live") await this.load(live.session_id);
      else this.renderList();
      return;
    }
    await this.showIdle(lastEndOf(all));
  }

  async load(id: string) {
    const g = ++this.gen;
    const v = await this.io.get<SessionSummary & { event_list?: SEv[] }>(`sessions/${id}`);
    if (this.dead || g !== this.gen) return;
    const { event_list, ...summary } = v;
    this.summary = summary;
    this.latest = event_list?.at(-1) ?? null;
    this.network = null;
    this.verified = null;
    this.idle = null;
    this.opts.onSession?.(summary);
    if (summary.state !== "live") {
      // an ended session: its facts on a session page; an agent or lineage mount shows the idle state
      if (!this.opts.session) return this.showIdle(endOf(summary));
      this.view = "facts";
      if (summary.state === "final" && summary.candidate) void this.loadNetwork();
    } else this.view = "live";
    this.syncStream();
    this.renderList();
    this.paint();
  }

  /** Re-reads the session: new events, the end of the session, a final verdict. */
  private async refresh() {
    const s = this.summary;
    if (!s) return;
    const id = s.session_id;
    try {
      const v = await this.io.get<SessionSummary & { event_list?: SEv[] }>(`sessions/${id}`);
      if (this.dead || this.summary?.session_id !== id) return;
      const { event_list, ...summary } = v;
      const wasLive = this.summary.state === "live";
      this.summary = summary;
      this.latest = event_list?.at(-1) ?? this.latest;
      this.opts.onSession?.(summary);
      if (wasLive && summary.state !== "live") {
        if (!this.opts.session) return void (await this.pickFromList(true));
        this.view = "facts";
        if (summary.state === "final" && summary.candidate) void this.loadNetwork();
      }
      if (this.view === "facts" && summary.state === "final" && summary.candidate && !this.network) void this.loadNetwork();
      this.syncStream();
      this.paint();
    } catch {
      /* keep the last good state; the next poll retries */
    }
  }

  private async loadNetwork() {
    const c = this.summary?.candidate;
    if (!c) return;
    try {
      this.network = await this.io.get(`candidates/${c.commit_id}`);
      this.paint();
      void this.loadVerified();
    } catch {
      /* the verdict row says what is known */
    }
  }

  /** The Verified commit the agent's mirror pushed for this session's accepted generation. */
  private async loadVerified() {
    const s = this.summary;
    const gen = s?.candidate?.gen_id;
    if (!s?.agent || !gen || !this.io.identity) return;
    const id = s.session_id;
    const v = await this.io.identity(s.agent).catch(() => null);
    if (this.dead || this.summary?.session_id !== id) return;
    const row = (v?.published ?? []).find((r: any) => r?.gen_id === gen);
    if (!row?.sha || !row?.fork) return;
    const url = typeof row.html_url === "string" && /^https:\/\/github\.com\//.test(row.html_url) ? row.html_url : `https://github.com/${row.fork}/commit/${row.sha}`;
    this.verified = { url, label: `${row.verified === true ? "Verified commit" : "Commit"} ${String(row.sha).slice(0, 7)} on ${row.fork}` };
    this.paint();
  }

  /** No session in progress: the agent's idle state. */
  private async showIdle(lastEnd: number | null) {
    const already = this.view === "idle" && this.idle?.last_end === lastEnd;
    this.view = "idle";
    if (!already) {
      this.gen++;
      this.summary = null;
      this.latest = null;
      this.network = null;
      this.idle = this.idle && this.idle.last_end === lastEnd ? this.idle : { kind: "next", last_end: lastEnd };
      this.opts.onSession?.(null);
      this.syncStream();
      this.renderList();
      this.paint();
    }
    const st = await idleStatus((p) => this.io.get(p), this.opts.agent, lastEnd);
    if (this.dead || this.view !== "idle") return;
    this.idle = st;
    this.paint();
  }

  private connect() {
    const es = this.io.events();
    if (!es) return;
    this.es = es;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const later = () => {
      if (debounce) return;
      debounce = setTimeout(() => ((debounce = null), void this.refresh()), 800);
    };
    es.onmessage = (m) => {
      if (this.dead) return;
      let e: { type: string; data: any };
      try {
        e = JSON.parse(m.data);
      } catch {
        return;
      }
      const cur = this.summary?.session_id;
      if (e.type === "session.events" && e.data?.session_id === cur) {
        const evs = (e.data.events ?? []) as SEv[];
        const last = evs.at(-1);
        if (last && (!this.latest || last.seq > this.latest.seq)) {
          this.latest = last;
          this.paintDeck();
        }
      } else if (e.type === "session.ended" && e.data?.session_id === cur) later();
      else if (this.view === "idle" && e.type === "session.ended") void this.pickFromList(true);
      else if (e.type === "session.started" && !this.opts.session) {
        const mine = (this.opts.agent && e.data?.agent === this.opts.agent) || (this.opts.lineage && e.data?.lineage_id === this.opts.lineage);
        if (mine && this.summary?.state !== "live") void this.load(e.data.session_id);
      } else if (/^(candidate|generation|replay)\./.test(e.type) && this.summary?.state === "sealed") later();
    };
  }

  // ------------------------------------------------------------------------------------------- the stream

  /** Starts, keeps or stops the desktop stream for what the screen shows now. */
  private syncStream() {
    const s = this.summary;
    const base = s && this.io.desktop ? this.io.desktop(s.session_id) : null;
    const want = this.view === "live" && s?.state === "live" && s.desktop && base ? `${s.session_id}` : "";
    if (want === this.playerKey && (this.player || this.retry)) return;
    if (want === this.playerKey && this.stream?.kind === "gone") return; // waiting for the retry
    this.player?.stop();
    this.player = null;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.playerKey = want;
    this.stream = null;
    if (!want) return;
    const start = () => {
      this.retry = null;
      if (this.dead || this.playerKey !== want) return;
      this.player = playDesktop(this.video, base!, (st) => {
        if (this.dead || this.playerKey !== want) return;
        this.stream = st;
        if (st.kind === "gone") {
          this.player = null;
          // Core still lists the session live: ask again later (a desktop that restarts comes back)
          if (st.code !== "codec") this.retry = setTimeout(start, RETRY_MS);
        }
        this.paint();
      });
    };
    start();
  }

  // ------------------------------------------------------------------------------------------- view

  private paint() {
    if (!this.root) return;
    this.root.dataset.view = this.view;
    this.paintScreen();
    this.paintDeck();
    this.paintRun();
  }

  private setState(s: string, text: string) {
    const el = this.q(".lp-state");
    el.dataset.s = s;
    el.querySelector("span")!.textContent = text;
  }

  private screenMsg(kind: string, title: string, body = "") {
    this.scr.dataset.show = "msg";
    this.scr.dataset.kind = kind;
    this.msg.innerHTML = `<div class="lp-msg-in" data-msg="${esc(kind)}"><b class="lp-msg-t">${esc(title)}</b>${body}</div>`;
  }

  /** The session's real facts, as a short list on the screen. */
  private factsList(s: SessionSummary, extra: [string, string][] = []) {
    const rows: [string, string][] = [
      ["Repository", esc(repoName(s.repo))],
      ["Started", esc(when(s.started_at))],
      ["Status", esc(s.state === "live" ? "live in Core" : s.state)],
      ["Last event", s.events ? esc(when(s.last_at)) : "none yet"],
      ...extra,
    ];
    return `<dl class="lp-kv">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
  }

  private paintScreen() {
    const s = this.summary;
    const stall = this.scr.querySelector<HTMLElement>(".lp-stall")!;
    stall.hidden = true;
    this.scr.dataset.kind = "";
    if (this.view === "loading") return this.screenMsg("loading", "Loading the agent's screen", `<span class="lp-msg-s">Reading the session list from Core.</span>`);
    if (this.view === "error") return this.screenMsg("error", "Screen unavailable", `<span class="lp-msg-s">${esc(this.error)}</span>`);
    if (this.view === "idle") {
      const st = this.idle ?? { kind: "next" as const, last_end: null };
      this.msg.innerHTML = "";
      this.scr.dataset.show = "msg";
      this.scr.dataset.kind = "idle";
      const sub = st.kind === "next" ? (st.last_end === null ? "The screen goes live as soon as the agent starts a session." : `${idleSub(st)} The screen goes live as soon as the agent starts its next session.`) : `${idleSub(st)} The agent starts again once the runtime can pay for its next session.`;
      this.msg.innerHTML = `<div class="lp-msg-in lp-idle" data-idle="${st.kind}"><b class="lp-msg-t">${esc(idleHeadline(st))}</b><span class="lp-msg-s lp-idle-sub">${esc(sub)}</span></div>`;
      return;
    }
    if (!s) return;
    if (this.view === "facts") {
      this.scr.dataset.show = "msg";
      this.scr.dataset.kind = "facts";
      this.msg.innerHTML = this.factsHtml();
      return;
    }
    // live
    if (!s.desktop) {
      return this.screenMsg(
        "nodesk",
        "Live session, no desktop stream",
        `<span class="lp-msg-s">This session is running without a desktop: no desktop was assigned to it, so there is no video to show. What Core reports about it:</span>${this.factsList(s)}`,
      );
    }
    const st = this.stream;
    if (!st || st.kind === "connecting") {
      return this.screenMsg("connecting", "Connecting to the live desktop", `<span class="lp-msg-s">${esc(st?.kind === "connecting" && st.detail ? st.detail : `Loading the video stream of ${repoName(s.repo)}.`)}</span>`);
    }
    if (st.kind === "blocked") {
      return this.screenMsg("blocked", "The live desktop is ready", `<span class="lp-msg-s">This browser did not start the video on its own.</span><button type="button" class="lp-btn" data-act="play">Play the live desktop</button>`);
    }
    if (st.kind === "gone") {
      const retry = st.code === "codec" ? "" : " Asking again every 15 s while Core lists the session as live.";
      return this.screenMsg("unavailable", `Stream unavailable: ${st.reason}`, `<span class="lp-msg-s">The session is still live in Core.${esc(retry)}</span>${this.factsList(s)}`);
    }
    // frames: the video itself, nothing over it but a stall note
    this.scr.dataset.show = "video";
    this.scr.dataset.kind = "live";
    this.msg.innerHTML = "";
    if (st.kind === "stalled") {
      stall.hidden = false;
      stall.textContent = `No new frames since ${clock(st.since)}. The last frame stays on screen.`;
    }
  }

  private paintDeck() {
    const s = this.summary;
    const t = this.q(".lp-say .t");
    const tm = this.q(".lp-say .tm");
    const note = this.q(".lp-note");
    const latest = this.q(".lp-latest");
    note.hidden = true;
    latest.hidden = true;
    tm.textContent = "";
    if (this.view === "idle") {
      const st = this.idle;
      this.setState(st && st.kind !== "next" ? "paused" : "idle", st && st.kind !== "next" ? "Paused" : "Idle");
      t.textContent = st ? idleHeadline(st) : "Waiting for the agent's next session";
      return;
    }
    if (this.view === "loading" || this.view === "error" || !s) {
      this.setState("idle", this.view === "error" ? "Unavailable" : "Loading");
      t.textContent = "";
      return;
    }
    const name = this.opts.label || (s.agent ? short(s.agent) : "An agent");
    if (this.view === "facts") {
      this.setState("ended", s.state === "final" ? `Ended, ${s.candidate?.status ?? "final"}` : s.state === "sealed" ? "Ended, verdict pending" : "Ended");
      t.textContent = `${name} worked on ${repoName(s.repo)}`;
      const end = endOf(s);
      tm.textContent = end ? `ended ${when(end)}` : "";
      return;
    }
    this.setState("live", "Live");
    t.textContent = `Live: ${name} working on ${repoName(s.repo)}`;
    tm.textContent = `started ${when(s.started_at)}`;
    if (s.desktop) {
      note.hidden = false;
      note.textContent = "The agent's real desktop. Its editor and run terminal are pixelated on the server until the verdict.";
    }
    const d = describeEvent(this.latest as any);
    if (d) {
      latest.hidden = false;
      latest.innerHTML = `<span class="k">Latest event</span> ${esc(d)}<span class="tm">${esc(clock(this.latest!.at))}</span>`;
    }
  }

  /** An ended session's final facts (no playback). */
  private factsHtml() {
    const s = this.summary!;
    const c = s.candidate;
    const eff = c?.verdict?.effect;
    const ratio = eff && typeof eff.ratio === "number" ? `${esc(eff.metric)} ratio ${esc(eff.ratio.toFixed(4))}` : eff?.fixed ? `fixed ${esc(eff.fixed.join(", "))}` : "";
    const verdict =
      s.state === "final" && c
        ? `<b class="${c.status === "accepted" ? "lp-ok" : "lp-bad"}">${esc(c.status)}</b>${c.reason ? ` ${esc(c.reason.replace(/_/g, " "))}` : ""}${ratio ? `, ${ratio}` : ""}`
        : s.state === "sealed"
          ? "being replayed by independent verifiers"
          : "ended without a candidate";
    const links = [
      c ? `<a ${this.a(`/candidates/${c.candidate_id ?? c.commit_id}`)}>Candidate</a>` : "",
      c?.gen_id ? `<a ${this.a(`/generations/${c.gen_id}`)}>Generation</a>` : "",
      this.verified ? `<a href="${esc(this.verified.url)}" target="_blank" rel="noopener">${esc(this.verified.label)}</a>` : "",
    ].filter(Boolean);
    const end = endOf(s);
    const agent = s.agent ? `<a ${this.a(`/agents/${s.agent}`)}>${esc(short(s.agent))}</a>` : `<span title="Hidden while the session's candidate is open (SPEC 10.7)">withheld</span>`;
    return `<div class="lp-msg-in lp-facts" data-facts="${esc(s.state)}"><b class="lp-msg-t">Session ended${end ? ` ${esc(when(end))}` : ""}</b>
      <span class="lp-msg-s">Verdict: ${verdict}</span>
      <dl class="lp-kv">
        <div><dt>Agent</dt><dd>${agent}</dd></div>
        <div><dt>Repository</dt><dd>${esc(repoName(s.repo))}</dd></div>
        <div><dt>Lineage</dt><dd><a ${this.a(`/lineages/${s.lineage_id}`)}>${esc(s.recipe_name ?? s.lineage_id.slice(0, 8))}</a>, parent <a ${this.a(`/generations/${s.gen_id}`)}>gen ${esc(s.height ?? "?")}</a></dd></div>
        <div><dt>Ran</dt><dd>${esc(when(s.started_at))}, ${esc(mmss((s.ended_at ?? s.last_at) - s.started_at))}, ${esc(s.events)} events</dd></div>
      </dl>
      ${links.length ? `<div class="lp-facts-links">${links.join("")}</div>` : ""}
      <span class="lp-msg-s lp-idle-sub">Lineage shows live work only; past sessions are not replayed.</span></div>`;
  }

  /** Under the screen of an ended session: the network's verdict and its replays. */
  private paintRun() {
    const box = this.q(".lp-run");
    const s = this.summary;
    if (this.view !== "facts" || !s?.candidate || this.opts.list === false) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    box.hidden = false;
    const rows: string[] = [`<div class="lp-run-h">Network verdict</div>`];
    const reps = (this.network?.replays ?? []).filter((x: any) => x.result);
    if (!reps.length) rows.push(`<div class="lp-none">${s.state === "final" ? "The replays behind the verdict load from Core." : "A candidate from this session is being replayed by independent verifiers."}</div>`);
    for (const r of reps) {
      const res = r.result;
      const m = Object.entries(res.metrics ?? {})
        .map(([k, v]: [string, any]) => {
          const b = v.base?.length ? v.base.reduce((a: number, x: number) => a + x, 0) / v.base.length : null;
          const cc = v.cand?.length ? v.cand.reduce((a: number, x: number) => a + x, 0) / v.cand.length : null;
          return b && cc ? `${k} ${(cc / b).toFixed(4)}` : null;
        })
        .filter(Boolean)
        .join(", ");
      rows.push(
        `<div class="lp-row"><span class="lbl">${esc(r.kind === "reference" ? "Reference replay" : r.kind === "audit" ? "Audit replay" : "Replay")} <span>build ${esc(res.build?.cand)}, tests ${esc(res.tests?.cand_pass?.length ?? 0)} pass, ${esc(res.tests?.cand_fail?.length ?? 0)} fail${res.equivalence ? `, outputs ${res.equivalence.base_digest === res.equivalence.cand_digest ? "identical" : "differ"}` : ""}${m ? `, ${esc(m)}` : ""}</span></span></div>`,
      );
    }
    box.innerHTML = rows.join("");
  }

  private renderList() {
    const box = this.host.querySelector<HTMLElement>(".lp-list");
    if (!box) return;
    const rest = this.others.filter((s) => s.session_id !== this.summary?.session_id);
    box.innerHTML = rest.length
      ? rest
          .map((s) => `<button type="button" class="lp-sess" data-sess="${esc(s.session_id)}"><i data-s="live"></i>Also live: ${esc(repoName(s.repo))}<span>${esc(s.recipe_name ?? "")}, started ${esc(when(s.started_at))}</span></button>`)
          .join("")
      : "";
  }
}

