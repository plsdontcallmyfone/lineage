import { endOf, idleStatus, idleSub, idleTitle, lastEndOf, RECORDINGS_SHOWN, type IdleStatus } from "./live-only.ts";
import { mountDevice, type DeviceHandle } from "../../../../packages/embed/src/device.ts";
import { ApiError, get } from "../api.ts";
import { fileAt } from "../code.ts";
import { esc } from "../html.ts";
import { addressOf, C, favicon, repoParts, titleOf, type Place } from "./chrome.ts";
import { ARROW, IBEAM, moveMs, movePath, typingChunks, type CursorKind, type Pt } from "./cursor.ts";
import { ensureStyle } from "./style.ts";
import { playDesktop, type DeskPlayer } from "./desk-player.ts";

// Live agent panel (SPEC 17.3, plans L4 and P): one authoring session shown as a desktop browser
// window in the style of Chrome, by default on the screen of the shared retro desktop machine
// (packages/embed/src/device.ts). The repository opens as a code host's file view; the pointer is a
// system arrow (an I-beam over text) that moves on eased curves in stepped frames, clicks tabs, opens
// new ones, types addresses and searches, scrolls to the lines the agent reads and drag-selects
// them, and types the agent's edits with a human rhythm. Sandbox runs open as an internal "sandbox"
// page. Under the machine: what the agent is doing, replay controls, and the runs and verdict.
//
// Everything shown is read from Core: the session's events (GET /v1/sessions/:id), files at the
// session's parent generation (GET /v1/lineages/:id/file), the candidate and its replays once final.
// Edit contents arrive only when Core's gate opens them; until then an edit shows as a sealed range.
// Addresses are the repository host's own URL shapes for the place the agent is looking.
//
//   import { mount } from "./live-panel/index.ts";
//   const panel = mount(el, { agent });                       // its live session, else its latest
//   const panel = mount(el, { session, mode: "replay", speed: 2, frame: "window", fps: 24 });
//   panel.destroy();
//
// frame: "device" (default: the window on the machine's screen), "window" (the window alone) or
// "none" (the window without its outer shadow and corners, for hosts that draw their own frame).
// fps: pointer, scroll and typing frames per second, 6 to 60 (default 12).
// Outside the dashboard (the embed kit, packages/embed) pass `io`: where Core, blobs and the event
// stream live, how links to Lineage pages are written, and the shadow root to put the styles in.

export type PanelMode = "auto" | "live" | "replay";
export type PanelFrame = "device" | "window" | "none";

export interface LivePanelOptions {
  /** one session by id */
  session?: string;
  /** an agent: its session in progress, else its most recent one, with a list of earlier ones */
  agent?: string;
  /** a lineage: the same, over every agent's sessions on it */
  lineage?: string;
  mode?: PanelMode;
  /** replay speed, 0.5 to 8 (default 1) */
  speed?: number;
  /** show the list of earlier sessions under the window (agent and lineage mounts; default true) */
  list?: boolean;
  /** page area height in px for frame "window" and "none" (default 440, 360 on narrow screens); the device keeps its screen's proportions */
  height?: number;
  /** the machine, the window alone, or no outer frame (default "device") */
  frame?: PanelFrame;
  /** animation frames per second for the pointer, scrolling and typing, 6 to 60 (default 12) */
  fps?: number;
  /** called whenever the shown session changes or its summary updates */
  onSession?: (s: SessionSummary | null) => void;
  /**
   * Past sessions replayed and desktop recordings shown (default RECORDINGS_SHOWN, false: live only).
   * Live only: a live session plays live; with none the window shows the agent's idle state; a session
   * that ended shows its final facts (verdict, metrics, links) without playback.
   */
  recordings?: boolean;
  /** data and link access; defaults to the dashboard's own (/api, /live/events, same-origin links) */
  io?: Partial<PanelIO>;
}

/** Everything the panel reads from outside itself. The dashboard uses DEFAULT_IO; the embed kit its own client. */
export interface PanelIO {
  /** GET a Core path (no /v1 prefix), JSON; throws ApiError (status 404 for a missing record) */
  get<T = any>(path: string): Promise<T>;
  /** a file at a generation: { text } or { error, message } */
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
  /** a Core path such as /v1/blobs/<sha256> as a URL this page can load (the desktop recording) */
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
  /** the desktop's recording, linked once the gate opened */
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
  matches?: number;
  count?: number;
  phase?: string;
  target?: string;
  label?: string;
  eval_kind?: string;
  content_sha256?: string;
  lines_before?: number;
  lines_after?: number;
  sealed?: boolean;
  before?: string;
  after?: string;
  output?: string;
  outcome?: string;
  text?: string;
  reason?: string;
  truncated?: boolean;
  steps?: { step: string; side?: string; exit: number; duration_ms: number; timed_out: boolean; tail: string }[];
}

interface FileState {
  path: string;
  lines: string[] | null;
  note: string | null;
  edited: Set<number>;
  sealed: { start: number; end: number }[];
  touched: number;
}

interface Run {
  target: string;
  kind: string | null;
  at: number;
  phases: { phase: string; at: number }[];
  outcome: string | null;
  sealed: boolean;
  output: string | null;
  steps: SEv["steps"];
  done: boolean;
}

const PHASES = ["prepare", "build", "test", "equivalence", "metrics"];
/** A phase's time: from its first event to the first event of a later phase (a phase repeats once per side). */
function phaseMs(phases: { phase: string; at: number }[], p: string): number | null {
  const first = phases.findIndex((x) => x.phase === p);
  const last = phases.map((x) => x.phase).lastIndexOf(p);
  const next = phases[last + 1];
  return first >= 0 && next ? next.at - phases[first]!.at : null;
}
const SPEEDS = [0.5, 1, 2, 4, 8];
const HOME = "@repo";
const SEARCH = "@search";
const SANDBOX = "@sandbox";
/** the narrowest the window is laid out; a smaller screen shows it scaled down, like a picture of a real window */
const MIN_W = 560;

const base = (p: string) => p.split("/").pop() || p;
const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const secs = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
const range = (e: SEv) => (e.start_line ? (e.end_line && e.end_line !== e.start_line ? `lines ${e.start_line} to ${e.end_line}` : `line ${e.start_line}`) : "");
const who = (p: string) => (p === "anthropic" ? "Claude" : p === "scripted" ? "Scripted author" : p === "routed" ? "Routed model" : p);
const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};

/** Leading whitespace as a fixed-width spacer (columns; a tab is 4), so indentation aligns in a proportional face. */
function lineHtml(text: string, caret = false): string {
  const m = /^[ \t]*/.exec(text)![0];
  let cols = 0;
  for (const ch of m) cols = ch === "\t" ? cols + 4 - (cols % 4) : cols + 1;
  const rest = text.slice(m.length);
  return `${cols ? `<span class="lp-i" style="--w:${cols}"></span>` : ""}${esc(rest)}${caret ? '<span class="lp-caret"></span>' : ""}`;
}

export function mount(el: HTMLElement, opts: LivePanelOptions = {}): LivePanelHandle {
  ensureStyle(opts.io?.styleRoot ?? document);
  const p = new Panel(el, opts);
  void p.init();
  return {
    get session() {
      return p.summary;
    },
    show: (id, mode) => p.load(id, mode ?? opts.mode ?? "auto"),
    setSpeed: (s) => p.setSpeed(s),
    destroy: () => p.destroy(),
  };
}
export { mount as mountLivePanel };

class Panel {
  summary: SessionSummary | null = null;
  private events: SEv[] = [];
  private idx = 0;
  private mode: "live" | "replay" = "replay";
  /** live only: what the window shows (playing a session, an ended session's facts, the agent's idle state) */
  private view: "play" | "facts" | "idle" = "play";
  private idle: IdleStatus | null = null;
  /** live only: the Verified commit of the shown session's accepted generation */
  private verified: { url: string; label: string } | null = null;
  private want: PanelMode;
  private playing = false;
  private speed: number;
  private gen = 0;
  private files = new Map<string, FileState>();
  /** open tabs in order: HOME, file paths, SEARCH, SANDBOX, and "@new" while one is being opened */
  private tabs: string[] = [HOME];
  private active = HOME;
  private loading: string | null = null;
  /** the omnibox while the pointer types into it */
  private omni: { text: string; caret: boolean } | null = null;
  /** the site's search field while the pointer types into it */
  private findText: string | null = null;
  /** the focus ring: what the agent is acting on */
  private ring: "omni" | "find" | "code" | `tab:${string}` | null = null;
  private hl: { path: string; start: number; end: number; cls: string } | null = null;
  /** a text selection being dragged or held (code lines) */
  private sel: { path: string; start: number; end: number } | null = null;
  private typing: { path: string; at: number; lines: string[]; oldCount: number } | null = null;
  private runs: Run[] = [];
  private say: { html: string; at: number } | null = null;
  private search: { q: string; m: number | undefined } | null = null;
  private listing: { path: string; count: number } | null = null;
  private outOpen = new Set<string>();
  private es: EventSource | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private dead = false;
  private refetching: Promise<void> | null = null;
  private unsealedNote = false;
  private others: SessionSummary[] = [];
  private network: { cand: any; transcripts: Map<string, any> } | null = null;
  private reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  private fps: number;
  private frame: PanelFrame;
  private cur: Pt & { kind: CursorKind; on: boolean } = { x: 0, y: 0, kind: "arrow", on: false };
  private scale = 1;
  private device: DeviceHandle | null = null;
  private ro: ResizeObserver | null = null;
  private mo: MutationObserver | null = null;
  private root!: HTMLElement;
  private win!: HTMLElement;
  private io: PanelIO;
  /** agent desktops (SPEC 17.7): what the window shows, the player, and whether the stream went away */
  private desk: { el: HTMLElement; video: HTMLVideoElement; player: DeskPlayer | null; showing: "live" | "rec" | null; key: string; gone: boolean; panel: boolean } | null = null;
  /** live only (opts.recordings, default RECORDINGS_SHOWN false): no replay, no recording */
  private get liveOnly() {
    return (this.opts.recordings ?? RECORDINGS_SHOWN) !== true;
  }
  private a = (path: string) => `href="${esc(this.io.href(path))}"${this.io.linkAttrs ? ` ${this.io.linkAttrs}` : ""}`;
  private q = <T extends HTMLElement = HTMLElement>(sel: string) => this.root.querySelector<T>(sel)!;

  constructor(
    private host: HTMLElement,
    private opts: LivePanelOptions,
  ) {
    this.io = { ...DEFAULT_IO, styleRoot: DEFAULT_IO.styleRoot, ...(opts.io ?? {}) };
    this.want = opts.mode ?? "auto";
    this.speed = SPEEDS.includes(opts.speed ?? 1) ? (opts.speed ?? 1) : 1;
    this.fps = Math.max(6, Math.min(60, Math.round(opts.fps ?? 12)));
    this.frame = opts.frame === "window" || opts.frame === "none" ? opts.frame : "device";
  }

  // ------------------------------------------------------------------------------------------- setup

  async init() {
    this.host.innerHTML = `<div class="lp" data-frame="${this.frame}" data-active="0" role="region" aria-label="Agent session">
      <div class="lp-stage"></div>
      <div class="lp-deck">
        <div class="lp-say" aria-live="polite"><span class="lp-state" data-s="idle"><i></i><span>Loading</span></span><span class="t"></span><span class="tm"></span></div>
        <div class="lp-prog" role="slider" tabindex="0" aria-label="Replay position" aria-valuemin="0" hidden><i></i></div>
        <div class="lp-ctlrow"><div class="lp-banner" hidden></div><div class="lp-ctl"></div></div>
      </div>
      <div class="lp-run"></div>
    </div>${this.opts.list === false || this.opts.session ? "" : '<div class="lp-list" aria-label="Sessions"></div>'}`;
    this.root = this.host.querySelector(".lp")!;
    const fit = document.createElement("div");
    fit.className = "lp-fit";
    fit.innerHTML = `<div class="cr" data-scheme="light">
      <div class="cr-strip"><span class="cr-lights" aria-hidden="true"><i></i><i></i><i></i></span><div class="cr-tabs" role="tablist" aria-label="Tabs"></div><span class="cr-ib cr-tsearch" aria-hidden="true">${C.chevron}</span></div>
      <div class="cr-tool"><span class="cr-ib" aria-hidden="true">${C.back}</span><span class="cr-ib off" aria-hidden="true">${C.fwd}</span><span class="cr-ib" aria-hidden="true">${C.reload}</span>
        <div class="cr-omni" role="status" aria-label="Address"><span class="cr-site">${C.tune}</span><span class="cr-url"></span><span class="cr-star" aria-hidden="true">${C.star}</span></div>
        <span class="cr-ib" aria-hidden="true">${C.puzzle}</span><span class="cr-avatar" aria-hidden="true"></span><span class="cr-ib" aria-hidden="true">${C.kebab}</span></div>
      <div class="cr-page"><div class="cr-doc"></div></div>
      <div class="cr-desk" hidden><video class="cr-desk-v" muted playsinline></video><div class="cr-desk-bar"><span class="cr-desk-tag"></span><button type="button" class="cr-desk-sw"></button></div></div>
      <div class="cr-cursor" aria-hidden="true" data-on="0"></div>
    </div>`;
    this.win = fit.querySelector(".cr")!;
    const deskEl = fit.querySelector<HTMLElement>(".cr-desk")!;
    this.desk = { el: deskEl, video: deskEl.querySelector("video")!, player: null, showing: null, key: "", gone: false, panel: false };
    deskEl.querySelector(".cr-desk-sw")!.addEventListener("click", () => {
      this.desk!.panel = !this.desk!.panel;
      this.syncDesk();
    });
    const stage = this.q(".lp-stage");
    if (this.frame === "device") {
      this.device = mountDevice(stage, { screen: fit, glass: "clear", lights: PHASES.length });
    } else stage.appendChild(fit);
    this.root.addEventListener("click", (ev) => this.onClick(ev));
    this.host.addEventListener("click", (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-sess]");
      if (b) void this.load(b.dataset.sess!, "auto");
    });
    const prog = this.q(".lp-prog");
    prog.addEventListener("click", (ev) => {
      const r = prog.getBoundingClientRect();
      void this.seek(Math.round(((ev.clientX - r.left) / r.width) * this.events.length));
    });
    prog.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowRight") void this.seek(Math.min(this.events.length, this.idx + 5));
      else if (ev.key === "ArrowLeft") void this.seek(Math.max(0, this.idx - 5));
    });
    this.layout();
    this.theme();
    if (typeof ResizeObserver === "function") {
      this.ro = new ResizeObserver(() => this.layout());
      this.ro.observe(stage);
    }
    if (typeof MutationObserver === "function") {
      this.mo = new MutationObserver(() => this.theme());
      this.mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
      const shadowHost = (this.io.styleRoot as ShadowRoot).host;
      if (shadowHost) this.mo.observe(shadowHost, { attributes: true, attributeFilter: ["scheme"] });
    }
    if (typeof matchMedia === "function") matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => this.theme());
    this.connect();
    this.poll = setInterval(() => {
      if (!this.host.isConnected) return this.destroy();
      const s = this.summary;
      // a desktop recording is linked a little after the gate opens: keep asking for ten minutes
      const awaitingRec = !!s?.desktop && s.open && !s.recording && Date.now() - (s.ended_at ?? s.last_at) < 600_000;
      if (this.liveOnly && this.view === "idle") void this.pickFromList(true);
      else if (s && (s.state === "live" || s.state === "sealed" || (!this.liveOnly && awaitingRec))) void this.refresh();
    }, 10_000);
    try {
      if (this.opts.session) await this.load(this.opts.session, this.want);
      else await this.pickFromList();
    } catch (e) {
      this.message(e instanceof ApiError && e.status === 404 ? "<b>No such session.</b> Core has no session with this id." : `<b>Could not load the session.</b> ${esc((e as Error).message)}`);
    }
  }

  destroy() {
    if (this.dead) return;
    this.dead = true;
    this.gen++;
    this.es?.close();
    this.ro?.disconnect();
    this.mo?.disconnect();
    if (this.poll) clearInterval(this.poll);
    this.desk?.player?.stop();
  }

  /** Sizes the window: laid out at least MIN_W wide and scaled down to the space it has. */
  private layout() {
    const fit = this.win.parentElement as HTMLElement;
    const avail = Math.max(1, (this.frame === "device" ? (this.device?.screen ?? fit) : this.q(".lp-stage")).clientWidth || fit.clientWidth || 640);
    const w = Math.max(avail, MIN_W);
    const k = avail / w;
    const narrow = typeof matchMedia === "function" && matchMedia("(max-width: 760px)").matches;
    // the machine's screen keeps a fixed shape (about 4:3 on a wide page, a little taller when narrow)
    const h = this.frame === "device" ? Math.round(w * (narrow ? 0.86 : 0.7)) : 84 + (this.opts.height ?? (narrow ? 360 : 440)) / (narrow ? k : 1);
    this.scale = k;
    this.win.style.width = `${w}px`;
    this.win.style.height = `${Math.round(h)}px`;
    this.win.style.transform = k < 1 ? `scale(${k})` : "";
    fit.style.height = `${Math.round(h * k)}px`;
  }

  /** Light or dark, from the text color the panel inherits (the dashboard theme or the embed's scheme). */
  private theme() {
    const c = getComputedStyle(this.host).color;
    const m = /rgba?\(([^)]+)\)/.exec(c);
    const [r, g, b] = (m?.[1] ?? "0,0,0").split(/[\s,/]+/).map(Number) as [number, number, number];
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    this.win.dataset.scheme = lum > 0.5 ? "dark" : "light";
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
    if (this.liveOnly) {
      // live only: the session in progress, else the idle state (never a past session)
      this.others = all.filter((s) => s.state === "live");
      const live = this.others[0];
      if (live) {
        if (this.summary?.session_id !== live.session_id || this.view !== "play") await this.load(live.session_id, "auto");
        else this.renderList();
        return;
      }
      await this.showIdle(lastEndOf(all));
      return;
    }
    // sessions that recorded nothing (older workers opened one per idle attempt) are left out, unless
    // one is live right now
    this.others = all.filter((s) => s.events > 0 || s.state === "live").slice(0, 12);
    const pick = this.others.find((s) => s.state === "live" && s.events > 0) ?? this.others.find((s) => s.events > 0) ?? this.others[0];
    if (!pick) {
      this.setState("idle", "No sessions");
      this.message(
        this.opts.agent
          ? "<b>This agent has no authoring session yet.</b> The window goes live as soon as it starts working on a lineage."
          : "<b>No authoring sessions yet.</b> A session appears here as soon as an agent starts working.",
      );
      this.renderList();
      return;
    }
    await this.load(pick.session_id, this.want);
  }

  setSpeed(s: number) {
    this.speed = SPEEDS.includes(s) ? s : 1;
    this.renderControls();
  }

  // ------------------------------------------------------------------------------------------- data

  async load(id: string, want: PanelMode) {
    this.gen++;
    this.want = want;
    const v = await this.io.get<SessionSummary & { event_list: SEv[] }>(`sessions/${id}`);
    if (this.dead) return;
    const { event_list, ...summary } = v;
    this.summary = summary;
    this.events = event_list;
    this.unsealedNote = false;
    this.network = null;
    this.verified = null;
    this.idle = null;
    this.mode = want === "live" || (want === "auto" && summary.state === "live") ? "live" : "replay";
    if (this.liveOnly) {
      this.mode = summary.state === "live" ? "live" : "replay";
      this.view = summary.state === "live" ? "play" : "facts";
    } else this.view = "play";
    this.reset();
    this.opts.onSession?.(this.summary);
    this.renderList();
    this.renderAll();
    if (this.desk) this.desk.gone = false;
    this.syncDesk();
    if (summary.state === "final" && summary.candidate) void this.loadNetwork();
    if (this.view === "facts") {
      // live only: an ended session shows its final facts, never a playback
      if (this.opts.session) return;
      // an agent or lineage mount shows live work: the idle state instead
      return this.showIdle(endOf(summary));
    }
    if (this.mode === "live") {
      // a live session opens where the agent is now: earlier events apply instantly, then it follows
      const tail = Math.max(0, this.events.length - 3);
      await this.fastForward(tail);
      this.play();
    } else this.play();
  }

  /** Re-reads the summary; new events, a closed gate that opened, a final verdict. */
  private async refresh() {
    if (!this.summary || this.refetching) return this.refetching ?? undefined;
    const id = this.summary.session_id;
    this.refetching = (async () => {
      try {
        const v = await this.io.get<SessionSummary & { event_list: SEv[] }>(`sessions/${id}`);
        if (this.dead || this.summary?.session_id !== id) return;
        const { event_list, ...summary } = v;
        const wasOpen = this.summary.open;
        const wasLive = this.summary.state === "live";
        this.summary = summary;
        this.opts.onSession?.(summary);
        this.syncDesk();
        if (this.liveOnly && wasLive && summary.state !== "live") {
          // live only: the session ended; a session mount shows its facts, an agent mount goes idle
          // (or to the next live session)
          this.gen++;
          this.playing = false;
          if (!this.opts.session) {
            await this.pickFromList(true);
            return;
          }
          this.view = "facts";
          this.mode = "replay";
          this.reset();
          this.renderAll();
          if (summary.state === "final" && summary.candidate) void this.loadNetwork();
          return;
        }
        if (this.liveOnly && this.view === "facts") {
          if (summary.state === "final" && summary.candidate && !this.network) void this.loadNetwork();
          this.renderAll();
          return;
        }
        if (!wasOpen && summary.open && !this.liveOnly) {
          // the gate opened: replay from the start, now with the edits
          this.events = event_list;
          this.unsealedNote = true;
          this.mode = "replay";
          this.gen++;
          this.reset();
          this.renderAll();
          if (summary.candidate) void this.loadNetwork();
          this.play();
          return;
        }
        const last = this.events.at(-1)?.seq ?? 0;
        const fresh = event_list.filter((e) => e.seq > last);
        if (fresh.length) this.append(fresh);
        if (summary.state === "final" && summary.candidate && !this.network) void this.loadNetwork();
        this.renderState();
        this.renderRun();
        if (this.active === HOME) this.renderDoc();
      } catch {
        /* keep the last good state; the next poll retries */
      } finally {
        this.refetching = null;
      }
    })();
    return this.refetching;
  }

  private append(evs: SEv[]) {
    const last = this.events.at(-1)?.seq ?? 0;
    const fresh = evs.filter((e) => e.seq > last).sort((a, b) => a.seq - b.seq);
    if (!fresh.length) return;
    if (fresh[0]!.seq !== last + 1) {
      void this.refresh();
      return;
    }
    this.events.push(...fresh);
    if (this.summary) this.summary.events = this.events.length;
    this.renderProgress();
    if (this.mode === "live" && !this.playing) this.play();
  }

  private async loadNetwork() {
    const c = this.summary?.candidate;
    if (!c) return;
    try {
      const cand = await this.io.get(`candidates/${c.commit_id}`);
      const transcripts = new Map<string, any>();
      this.network = { cand, transcripts };
      this.renderRun();
      if (this.view === "facts") void this.loadVerified();
      // the first revealed replay's transcript: real build, test and metrics output
      const r = (cand.replays ?? []).find((x: any) => x.result?.transcript_digest && x.status === "revealed");
      if (r) {
        const tx = await this.io.blob(r.result.transcript_digest);
        if (tx) transcripts.set(r.replay_id, tx);
        this.renderRun();
      }
    } catch {
      /* the verdict row says what is known */
    }
  }

  /** Live only: the Verified commit the agent's mirror pushed for this session's accepted generation. */
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
    this.renderDoc();
  }

  /** Live only: no session in progress. The window shows the agent's idle state. */
  private async showIdle(lastEnd: number | null) {
    if (this.view === "idle" && this.idle && this.idle.last_end === lastEnd) {
      // already idle: only re-read the runtime's pause
      const st = await idleStatus((p) => this.io.get(p), this.opts.agent, lastEnd);
      if (this.dead || this.view !== "idle" || st.kind === this.idle?.kind) return;
      this.idle = st;
      this.renderAll();
      this.renderDoc();
      return;
    }
    this.gen++;
    this.playing = false;
    this.summary = null;
    this.events = [];
    this.network = null;
    this.verified = null;
    this.view = "idle";
    this.mode = "replay";
    this.reset();
    this.tabs = ["@new"];
    this.active = "@new";
    this.idle = { kind: "next", last_end: lastEnd };
    this.syncDesk();
    this.opts.onSession?.(null);
    this.renderList();
    this.renderAll();
    this.renderDoc();
    const agent = this.opts.agent;
    const st = await idleStatus((p) => this.io.get(p), agent, lastEnd);
    if (this.dead || this.view !== "idle") return;
    this.idle = st;
    this.renderAll();
    this.renderDoc();
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
      if (e.type === "session.events" && e.data?.session_id === cur) this.append(e.data.events as SEv[]);
      else if (e.type === "session.ended" && e.data?.session_id === cur) later();
      else if (this.liveOnly && this.view === "idle" && e.type === "session.ended") void this.pickFromList(true);
      else if (e.type === "session.started") {
        const mine = (this.opts.agent && e.data?.agent === this.opts.agent) || (this.opts.lineage && e.data?.lineage_id === this.opts.lineage);
        if (mine && !this.opts.session) {
          if ((this.want === "auto" || this.liveOnly) && (!this.summary || this.summary.state !== "live" || !this.playing)) void this.load(e.data.session_id, "auto").then(() => this.refreshList());
          else void this.refreshList();
        }
      } else if (/^(candidate|generation|replay|epoch)\./.test(e.type) && (this.summary?.state === "sealed" || this.summary?.state === "live")) later();
    };
  }

  private async refreshList() {
    if (this.opts.session || this.opts.list === false) return;
    const q = this.listQuery();
    try {
      const all = await this.io.get<SessionSummary[]>(`sessions?${q}${q ? "&" : ""}limit=12`);
      this.others = this.liveOnly ? all.filter((s) => s.state === "live") : all;
      this.renderList();
    } catch {
      /* keep */
    }
  }

  // ------------------------------------------------------------------------------------------- playback

  private reset() {
    this.idx = 0;
    this.files.clear();
    this.tabs = [HOME];
    this.active = HOME;
    this.loading = null;
    this.omni = null;
    this.findText = null;
    this.ring = null;
    this.hl = null;
    this.sel = null;
    this.typing = null;
    this.runs = [];
    this.say = null;
    this.search = null;
    this.listing = null;
    this.cur.on = false;
    this.drawCursor();
    this.device?.setLights([]);
  }

  private play() {
    if (this.dead) return;
    this.playing = true;
    this.renderControls();
    void this.pump(this.gen);
  }

  private pause() {
    this.playing = false;
    this.gen++;
    this.renderControls();
    this.renderState();
  }

  /** How much faster than real time animations run: the replay speed, or catch-up in live mode. */
  private pace() {
    if (this.mode !== "live") return this.speed;
    const backlog = this.events.length - this.idx;
    return backlog > 20 ? 6 : backlog > 6 ? 2.5 : 1;
  }

  private async pump(g: number) {
    while (!this.dead && g === this.gen && this.playing && this.idx < this.events.length) {
      const e = this.events[this.idx++]!;
      await this.apply(e, true, g);
      if (g !== this.gen) return;
      this.renderProgress();
      const next = this.events[this.idx];
      // replay keeps the session's rhythm with idle gaps compressed; live catches up when behind
      const gap = next ? Math.min(Math.max(next.at - e.at, 120), 1600) : 0;
      await this.wait(this.mode === "live" ? Math.min(gap, 600) / this.pace() : gap / this.pace(), g);
    }
    if (g !== this.gen || this.dead) return;
    if (this.mode === "replay" && this.idx >= this.events.length) {
      this.playing = false;
      this.ring = null;
      this.renderChrome();
      this.renderControls();
    }
    this.renderState();
  }

  private wait(ms: number, g: number) {
    return new Promise<void>((res) => setTimeout(res, g === this.gen ? Math.max(0, ms) : 0));
  }

  private async fastForward(to: number) {
    const g = ++this.gen;
    this.reset();
    for (let i = 0; i < to && i < this.events.length; i++) {
      await this.apply(this.events[i]!, false, g);
      if (g !== this.gen) return;
      this.idx = i + 1;
    }
    this.renderAll();
    this.reveal();
    this.settleCursor();
  }

  private async seek(to: number) {
    if (!this.events.length) return;
    const wasPlaying = this.playing || this.mode === "live";
    this.mode = "replay";
    this.playing = false;
    await this.fastForward(Math.max(0, Math.min(to, this.events.length)));
    if (wasPlaying) this.play();
    else this.renderControls();
  }

  private file(path: string): FileState {
    let f = this.files.get(path);
    if (!f) {
      f = { path, lines: null, note: null, edited: new Set(), sealed: [], touched: 0 };
      this.files.set(path, f);
    }
    return f;
  }

  private async loadFile(f: FileState, allowMissing: boolean) {
    if (f.lines || f.note) return;
    const s = this.summary!;
    const r = await this.io.fileAt(s.lineage_id, s.gen_id, f.path);
    if ("error" in r) {
      if (allowMissing && r.error === "not_found") f.lines = [];
      else f.note = r.error === "tree_unavailable" ? "Core has no snapshot mirror for this repository on its host, so it cannot rebuild this file." : r.error === "not_found" ? "This file is not in the parent generation; the agent created it." : r.message;
      if (allowMissing && r.error === "not_found") f.note = null;
      return;
    }
    if (r.text === null) f.note = "This file is generated by the recipe's prepare step; Core holds no bytes for it.";
    else f.lines = r.text.replace(/\n$/, "").split("\n");
  }

  // ------------------------------------------------------------------------------------------- pointer

  /** One animation frame (real time; the replay speed changes how many frames a motion takes). */
  private tick(g: number) {
    return this.wait(1000 / this.fps, g);
  }

  /** A point on an element, in the window's own coordinates. */
  private pt(el: Element | null, fx = 0.5, fy = 0.5): Pt | null {
    if (!el) return null;
    const w = this.win.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return { x: (r.left - w.left + r.width * fx) / this.scale, y: (r.top - w.top + r.height * fy) / this.scale };
  }

  private drawCursor(pressed = false) {
    const el = this.win?.querySelector<HTMLElement>(".cr-cursor");
    if (!el) return;
    if (el.dataset.kind !== this.cur.kind) {
      el.innerHTML = this.cur.kind === "ibeam" ? IBEAM : ARROW;
      el.dataset.kind = this.cur.kind;
    }
    el.dataset.on = this.cur.on ? "1" : "0";
    el.dataset.pressed = pressed ? "1" : "0";
    // hot spots: the arrow's tip, the I-beam's middle
    const [ox, oy] = this.cur.kind === "ibeam" ? [5.5, 10] : [1.5, 1.5];
    el.style.transform = `translate(${Math.round(this.cur.x - ox)}px, ${Math.round(this.cur.y - oy)}px)`;
  }

  /** Moves the pointer to p on a bowed, eased path in stepped frames; instant without animation. */
  private async moveTo(p: Pt | null, kind: CursorKind, anim: boolean, g: number) {
    if (!p) return;
    if (!this.cur.on) {
      // the pointer comes in from where it last rested, or from the lower right of the window
      this.cur.x = this.cur.x || this.win.clientWidth * 0.82;
      this.cur.y = this.cur.y || this.win.clientHeight * 0.9;
      this.cur.on = true;
    }
    if (!anim) {
      Object.assign(this.cur, p, { kind });
      this.drawCursor();
      return;
    }
    const from = { x: this.cur.x, y: this.cur.y };
    const bow = ((Math.round(from.x + p.y) % 7) - 3) / 26; // a different, stable curve per move
    const path = movePath(from, p, moveMs(from, p) / this.pace(), this.fps, bow);
    for (let i = 0; i < path.length; i++) {
      Object.assign(this.cur, path[i]!);
      // the shape changes as it crosses onto text, near the end of the move
      if (i >= path.length - 2) this.cur.kind = kind;
      this.drawCursor();
      await this.tick(g);
      if (g !== this.gen) return;
    }
  }

  private async click(target: HTMLElement | null, anim: boolean, g: number) {
    if (!anim || !target) return;
    target.classList.add("pressed");
    this.drawCursor(true);
    await this.tick(g);
    target.classList.remove("pressed");
    this.drawCursor(false);
    await this.tick(g);
  }

  /** Scrolls the page so line n sits about a third down, in stepped frames. */
  private async scrollToLine(n: number, anim: boolean, g: number) {
    const page = this.win.querySelector<HTMLElement>(".cr-page")!;
    const line = page.querySelector<HTMLElement>(`.lp-l[data-n="${n}"]`);
    if (!line) return;
    const p = page.getBoundingClientRect();
    const l = line.getBoundingClientRect();
    const rel = (l.top - p.top) / this.scale;
    // already comfortably in view: leave the page where it is
    if (rel > 40 && rel < page.clientHeight * 0.6) return;
    const y = rel + page.scrollTop;
    const top = Math.max(0, Math.min(page.scrollHeight - page.clientHeight, y - page.clientHeight / 3));
    if (Math.abs(top - page.scrollTop) < 4) return;
    if (!anim) {
      page.scrollTop = top;
      return;
    }
    const from = page.scrollTop;
    const frames = Math.max(2, Math.round((Math.min(700, 260 + Math.abs(top - from) * 0.25) / 1000 / this.pace()) * this.fps));
    for (let i = 1; i <= frames; i++) {
      const t = i / frames;
      page.scrollTop = from + (top - from) * (1 - Math.pow(1 - t, 3));
      await this.tick(g);
      if (g !== this.gen) return;
    }
  }

  /** Types text into a field with a human rhythm, calling set with each prefix. */
  private async typeText(text: string, set: (s: string) => void, anim: boolean, g: number, capMs = 1100) {
    if (!anim) return set(text);
    let n = 0;
    for (const k of typingChunks(text, this.fps, capMs / this.pace(), text.length)) {
      n += k;
      set(text.slice(0, n));
      await this.tick(g);
      if (g !== this.gen) return;
    }
  }

  /** Scrolls the open file to what matters in it: the selection, else the first changed or sealed line. */
  private reveal() {
    const f = this.files.get(this.active);
    if (!f?.lines) return;
    const s = this.sel?.path === f.path ? this.sel : this.hl?.path === f.path ? this.hl : null;
    const n = s?.start ?? (f.edited.size ? Math.min(...f.edited) : f.sealed[0]?.start);
    if (n) void this.scrollToLine(n, false, this.gen);
  }

  /** Where the pointer rests after a jump (seek, live catch-up): on the selection or the hidden. */
  private settleCursor() {
    const s = this.sel ?? (this.hl ? { path: this.hl.path, start: this.hl.start, end: this.hl.end } : null);
    if (s && s.path === this.active) {
      const p = this.pt(this.win.querySelector(`.lp-l[data-n="${s.start}"] .lp-c`), 0, 0.5);
      if (p) {
        Object.assign(this.cur, p, { kind: "ibeam" as CursorKind, on: true });
        this.drawCursor();
        return;
      }
    }
    this.cur.on = false;
    this.drawCursor();
  }

  // ------------------------------------------------------------------------------------------- browsing

  /**
   * Brings a tab to the front the way a person does: clicks it if it is open, else opens a new tab
   * and types the address (or, for a search, types into the site's search field).
   */
  private async openTab(id: string, anim: boolean, g: number) {
    if (this.active === id && this.tabs.includes(id)) return;
    if (this.tabs.includes(id)) {
      if (anim) {
        const tab = this.tabEl(id);
        this.ring = `tab:${id}`;
        this.renderTabs();
        await this.moveTo(this.pt(this.tabEl(id), 0.35, 0.5), "arrow", anim, g);
        if (g !== this.gen) return;
        await this.click(this.tabEl(id) ?? tab, anim, g);
      }
      this.active = id;
      this.ring = null;
      if (anim) this.renderChrome();
      return;
    }
    if (!anim) {
      this.tabs.push(id);
      this.active = id;
      return;
    }
    if (id === SEARCH) {
      // the site's own search field, on a page of the site
      if (this.active === SANDBOX || this.active === "@new") await this.openTab(HOME, anim, g);
      if (g !== this.gen) return;
      const field = this.win.querySelector<HTMLElement>(".gh-find");
      await this.moveTo(this.pt(field, 0.3, 0.5), "ibeam", anim, g);
      if (g !== this.gen) return;
      await this.click(field, anim, g);
      this.ring = "find";
      this.findText = "";
      this.renderDoc();
      await this.typeText(this.search?.q ?? "", (s) => ((this.findText = s), this.paintFind()), anim, g);
      if (g !== this.gen) return;
      await this.tick(g);
      this.findText = null;
      this.ring = null;
      this.tabs.push(id);
      this.active = id;
      await this.loadingBeat(id, g);
      return;
    }
    // a new tab, then the address
    const plus = this.win.querySelector<HTMLElement>(".cr-new");
    await this.moveTo(this.pt(plus), "arrow", anim, g);
    if (g !== this.gen) return;
    await this.click(plus, anim, g);
    this.tabs.push("@new");
    this.active = "@new";
    this.ring = "omni";
    this.omni = { text: "", caret: true };
    this.renderChrome();
    const place = this.placeOf(id);
    const addr = addressOf(this.summary?.repo ?? null, this.summary?.commit ?? "", place);
    await this.typeText(`${addr.host}${addr.rest}`, (s) => ((this.omni = { text: s, caret: true }), this.renderOmni()), anim, g, 850);
    if (g !== this.gen) return;
    await this.tick(g);
    this.tabs[this.tabs.indexOf("@new")] = id;
    this.active = id;
    this.omni = null;
    this.ring = null;
    await this.loadingBeat(id, g);
  }

  /** The spinner in the tab for a moment while the page "loads". */
  private async loadingBeat(id: string, g: number) {
    this.loading = id;
    this.renderChrome();
    for (let i = 0; i < Math.max(2, Math.round((0.32 / this.pace()) * this.fps)); i++) {
      await this.tick(g);
      if (g !== this.gen) return;
    }
    this.loading = null;
    this.renderChrome();
  }

  /** Drag-selects lines a to b of the active file with the I-beam, extending the selection frame by frame. */
  private async dragSelect(path: string, a: number, b: number, anim: boolean, g: number) {
    if (!anim) {
      this.sel = { path, start: a, end: b };
      return;
    }
    await this.scrollToLine(a, anim, g);
    if (g !== this.gen) return;
    const startEl = this.win.querySelector(`.lp-l[data-n="${a}"] .lp-c`);
    await this.moveTo(this.pt(startEl, 0, 0.5), "ibeam", anim, g);
    if (g !== this.gen) return;
    this.ring = "code";
    // drag over the lines that fit on the page; a longer range finishes as the page auto-scrolls
    const page = this.win.querySelector<HTMLElement>(".cr-page")!;
    const lh = this.win.querySelector<HTMLElement>(".lp-l")?.offsetHeight || 20;
    const fits = Math.max(1, Math.floor(page.clientHeight / lh) - 6);
    const last = Math.min(b, a + fits);
    const frames = Math.max(2, Math.round((Math.min(900, 180 + (last - a) * 35) / 1000 / this.pace()) * this.fps));
    const startPt = { x: this.cur.x, y: this.cur.y };
    for (let i = 1; i <= frames; i++) {
      const t = 1 - Math.pow(1 - i / frames, 2);
      const n = Math.round(a + (last - a) * t);
      this.sel = { path, start: a, end: n };
      this.paintMarks();
      const endEl = this.win.querySelector(`.lp-l[data-n="${n}"] .lp-c`);
      const p = this.pt(endEl, 1, 0.5);
      if (p) {
        this.cur.x = startPt.x + (Math.min(p.x, startPt.x + 420) - startPt.x) * t;
        this.cur.y = p.y;
        this.drawCursor(true);
      }
      await this.tick(g);
      if (g !== this.gen) return;
    }
    this.sel = { path, start: a, end: b };
    this.drawCursor(false);
    this.paintMarks();
  }

  private placeOf(id: string): Place {
    if (id === HOME) return { kind: "home" };
    if (id === "@new") return { kind: "new" };
    if (id === SEARCH) return { kind: "search", q: this.search?.q ?? "" };
    if (id === SANDBOX) return { kind: "sandbox", run: Math.max(1, this.runs.length) };
    const h = this.sel && this.sel.path === id ? this.sel : this.hl && this.hl.path === id ? this.hl : null;
    return { kind: "file", path: id, start: h?.start, end: h?.end };
  }

  // ------------------------------------------------------------------------------------------- events

  private async apply(e: SEv, animate: boolean, g: number) {
    const anim = animate && !this.reduced;
    const slow = (ms: number) => (animate ? this.wait(ms / this.pace(), g) : Promise.resolve());
    const sayAt = e.at;
    const show = () => animate && this.renderAll();
    switch (e.kind) {
      case "list":
        this.listing = { path: e.path ?? ".", count: e.count ?? 0 };
        this.say = { at: sayAt, html: `Listed <b>${esc(e.count ?? 0)}</b> files under <b>${esc(e.path === "." ? "the repository root" : e.path)}</b>` };
        if (animate) this.renderSay();
        await this.openTab(HOME, anim, g);
        if (g !== this.gen) return;
        show();
        if (anim) await this.moveTo(this.pt(this.win.querySelector(".gh-files"), 0.4, 0.3), "arrow", anim, g);
        await slow(400);
        return;
      case "search":
        this.search = { q: e.query ?? "", m: e.matches };
        this.say = { at: sayAt, html: `Searched the repository for <b>${esc(e.query)}</b>${e.matches !== undefined ? `, ${esc(e.matches)} matching lines` : ""}` };
        if (animate) this.renderSay();
        if (this.tabs.includes(SEARCH) && anim) {
          // a new query in the open results page's own search field
          await this.openTab(SEARCH, anim, g);
          if (g !== this.gen) return;
          const field = this.win.querySelector<HTMLElement>(".gh-find");
          await this.moveTo(this.pt(field, 0.3, 0.5), "ibeam", anim, g);
          await this.click(field, anim, g);
          this.ring = "find";
          this.findText = "";
          this.paintFind();
          await this.typeText(e.query ?? "", (s) => ((this.findText = s), this.paintFind()), anim, g);
          if (g !== this.gen) return;
          this.findText = null;
          this.ring = null;
          await this.loadingBeat(SEARCH, g);
        } else await this.openTab(SEARCH, anim, g);
        if (g !== this.gen) return;
        show();
        await slow(600);
        return;
      case "read": {
        const f = this.file(e.path!);
        f.touched++;
        await this.loadFile(f, false);
        if (g !== this.gen) return;
        this.say = { at: sayAt, html: `Reading <b>${esc(e.path)}</b>${range(e) ? `, ${esc(range(e))}` : ""}` };
        if (animate) this.renderSay();
        this.sel = null;
        this.hl = null;
        await this.openTab(f.path, anim, g);
        if (g !== this.gen) return;
        const a = e.start_line ?? 1;
        const b = e.end_line ?? a;
        show();
        if (f.lines) await this.dragSelect(f.path, a, b, anim, g);
        if (g !== this.gen) return;
        this.hl = { path: f.path, start: a, end: b, cls: "hl" };
        if (animate) (this.renderOmni(), this.renderTabs(), this.paintMarks());
        if (this.reduced && animate) this.settleCursor();
        await slow(650);
        return;
      }
      case "edit":
      case "write":
      case "patch": {
        const f = this.file(e.path!);
        f.touched++;
        await this.loadFile(f, e.kind !== "edit");
        if (g !== this.gen) return;
        const start = e.start_line ?? 1;
        const label = e.kind === "patch" ? (e.label ?? "Applying a patch") : e.kind === "write" ? "Writing" : "Editing";
        this.sel = null;
        this.hl = null;
        if (e.after === undefined) {
          // sealed: the range is public, the text is not
          const end = e.end_line ?? start;
          this.say = { at: sayAt, html: `${esc(label)} <b>${esc(e.path)}</b>${range(e) ? `, ${esc(range(e))}` : ""}. The new text is sealed until the candidate is final` };
          if (animate) this.renderSay();
          await this.openTab(f.path, anim, g);
          if (g !== this.gen) return;
          show();
          if (f.lines) await this.dragSelect(f.path, start, end, anim, g);
          if (g !== this.gen) return;
          f.sealed.push({ start, end });
          this.sel = null;
          this.hl = { path: f.path, start, end, cls: "sealed" };
          if (animate) (this.renderTabs(), this.renderDoc());
          if (this.reduced && animate) this.settleCursor();
          await slow(800);
          return;
        }
        this.say = { at: sayAt, html: `${esc(label)} <b>${esc(e.path)}</b>${range(e) ? `, ${esc(range(e))}` : ""}${e.truncated ? " (text truncated by the worker)" : ""}` };
        if (animate) this.renderSay();
        await this.openTab(f.path, anim, g);
        if (g !== this.gen) return;
        if (animate) show();
        await this.edit(f, e, anim, animate, g);
        return;
      }
      case "evaluate":
        this.runs.push({ target: e.target ?? "", kind: e.eval_kind ?? null, at: e.at, phases: [], outcome: null, sealed: false, output: null, steps: undefined, done: false });
        this.say = { at: sayAt, html: `Measuring the change in the sandbox${e.target ? `, target <b>${esc(e.target)}</b>` : ""}` };
        this.lights();
        if (animate) (this.renderSay(), this.renderRun());
        await this.openTab(SANDBOX, anim, g);
        if (g !== this.gen) return;
        show();
        await slow(400);
        return;
      case "phase": {
        const r = this.runs.at(-1);
        if (r) r.phases.push({ phase: e.phase!, at: e.at });
        this.say = { at: sayAt, html: `Sandbox: <b>${esc(e.phase)}</b>` };
        this.lights();
        if (animate) (this.renderRun(), this.renderSay(), this.active === SANDBOX && this.renderDoc(), await slow(250));
        return;
      }
      case "result": {
        const r = this.runs.at(-1);
        if (r) {
          r.done = true;
          r.sealed = !!e.sealed;
          r.outcome = e.outcome ?? null;
          r.output = e.output ?? null;
          r.steps = e.steps;
        }
        this.say = { at: sayAt, html: e.sealed ? "Sandbox run finished. Its output is sealed until the candidate is final" : `Sandbox run finished: <b>${esc(e.outcome ?? "done")}</b>` };
        this.lights();
        if (animate) (this.renderRun(), this.renderSay(), this.active === SANDBOX && this.renderDoc(), await slow(500));
        return;
      }
      case "note":
        if (e.text) {
          this.say = { at: sayAt, html: `<q>${esc(e.text.replace(/\s+/g, " ").slice(0, 400))}</q>` };
          if (animate) (this.renderSay(), await slow(Math.min(2200, 500 + e.text.length * 8)));
        }
        return;
      case "submit":
        this.say = { at: sayAt, html: `Submitted the change as a candidate${e.reason ? `: <q>${esc(e.reason.slice(0, 300))}</q>` : ""}` };
        if (animate) this.renderSay();
        return;
      case "give_up":
        this.say = { at: sayAt, html: `Stopped without submitting${e.reason ? `: <q>${esc(e.reason.slice(0, 300))}</q>` : ""}` };
        if (animate) this.renderSay();
        return;
    }
  }

  /** The machine's indicator lights: the sandbox phases the current run has reached. */
  private lights() {
    const r = this.runs.at(-1);
    const seen = new Set(r?.phases.map((p) => p.phase) ?? []);
    this.device?.setLights(r ? PHASES.map((p) => seen.has(p) || (r.done && !r.sealed && r.outcome === "accepted")) : []);
  }

  /** Applies an open edit to the file, selecting the old text and typing the new text in when animating. */
  private async edit(f: FileState, e: SEv, anim: boolean, animate: boolean, g: number) {
    if (!f.lines) f.lines = f.note ? null : [];
    if (!f.lines) {
      if (animate) this.renderAll();
      return;
    }
    const lines = f.lines;
    const before = e.before ?? "";
    const after = e.after ?? "";
    const start = Math.max(1, Math.min(e.start_line ?? 1, lines.length + 1));
    let at = start; // 1-based first line of the region
    let oldCount: number;
    let prefix = "";
    let suffix = "";
    if (e.kind === "write") {
      at = 1;
      oldCount = lines.length;
    } else if (e.kind === "patch") {
      oldCount = e.lines_before ?? (before === "" ? 0 : before.split("\n").length);
    } else {
      // edit_file replaces one occurrence of `before`: find it at or after its reported line
      const text = lines.join("\n");
      let off = 0;
      for (let i = 0; i < start - 1; i++) off += lines[i]!.length + 1;
      let i = before ? text.indexOf(before, Math.max(0, off - 1)) : off;
      if (i < 0) i = text.indexOf(before);
      if (i < 0) i = off;
      const lineStart = text.lastIndexOf("\n", i - 1) + 1;
      at = text.slice(0, lineStart).split("\n").length;
      prefix = text.slice(lineStart, i);
      const endIdx = i + before.length;
      const lineEnd = text.indexOf("\n", endIdx);
      suffix = text.slice(endIdx, lineEnd < 0 ? text.length : lineEnd);
      oldCount = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd).split("\n").length;
    }
    const newRegion = (prefix + after + suffix).split("\n");
    const replaceWith = e.kind !== "edit" && after === "" && (e.lines_after ?? 0) === 0 ? [] : newRegion;
    if (anim) {
      // select what goes, then type over it
      if (oldCount && at <= lines.length) await this.dragSelect(f.path, at, Math.min(lines.length, at + oldCount - 1), anim, g);
      else await this.scrollToLine(Math.min(at, Math.max(1, lines.length)), anim, g);
      if (g !== this.gen) return;
      this.sel = null;
      this.hl = { path: f.path, start: at, end: at + Math.max(oldCount, 1) - 1, cls: "del" };
      this.paintMarks();
      await this.wait(oldCount ? 300 / this.pace() : 80, g);
      if (g !== this.gen) return;
      this.hl = null;
      // the pointer hides while typing, as it does on a desktop
      this.cur.on = false;
      this.drawCursor();
      this.ring = "code";
      await this.typeText(
        after,
        (s) => {
          this.typing = { path: f.path, at, lines: (prefix + s).split("\n"), oldCount };
          this.renderDoc();
          this.keepCaretInView();
        },
        anim,
        g,
        2600,
      );
      if (g !== this.gen) return;
      this.typing = null;
      this.ring = null;
    }
    const oldRegion = lines.slice(at - 1, at - 1 + oldCount);
    lines.splice(at - 1, oldCount, ...replaceWith);
    // shift earlier edit marks below the region, then mark the lines that changed (context lines of a hunk stay plain)
    const delta = replaceWith.length - oldCount;
    const moved = new Set<number>();
    for (const n of f.edited) moved.add(n >= at + oldCount ? n + delta : n);
    f.edited = moved;
    let pre = 0;
    while (pre < oldRegion.length && pre < replaceWith.length && oldRegion[pre] === replaceWith[pre]) pre++;
    let suf = 0;
    while (suf < oldRegion.length - pre && suf < replaceWith.length - pre && oldRegion[oldRegion.length - 1 - suf] === replaceWith[replaceWith.length - 1 - suf]) suf++;
    for (let n = at + pre; n < at + replaceWith.length - suf; n++) f.edited.add(n);
    if (pre + suf >= replaceWith.length && oldRegion.length > replaceWith.length) f.edited.add(Math.min(at + pre, Math.max(1, lines.length)));
    if (animate) {
      this.renderAll();
      if (this.reduced) await this.scrollToLine(at, false, g);
    }
  }

  private keepCaretInView() {
    const caret = this.win.querySelector<HTMLElement>(".lp-caret");
    const page = this.win.querySelector<HTMLElement>(".cr-page")!;
    if (!caret) return;
    const c = caret.getBoundingClientRect();
    const p = page.getBoundingClientRect();
    const y = (c.top - p.top) / this.scale;
    if (y > page.clientHeight - 60) page.scrollTop += y - page.clientHeight + 120;
    const code = caret.closest<HTMLElement>(".gh-code");
    if (code) {
      const cx = (c.left - code.getBoundingClientRect().left) / this.scale;
      if (cx > code.clientWidth - 40) code.scrollLeft += cx - code.clientWidth + 120;
    }
  }

  // ------------------------------------------------------------------------------------------- view

  private onClick(ev: Event) {
    const t = ev.target as HTMLElement;
    const tab = t.closest<HTMLElement>("[data-tab]");
    if (tab && this.tabs.includes(tab.dataset.tab!)) {
      this.active = tab.dataset.tab!;
      this.renderChrome();
      this.reveal();
      this.settleCursor();
      return;
    }
    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (this.liveOnly && act && act !== "live" && act !== "pause") return; // no playback of past work
    if (act === "play") this.play();
    else if (act === "pause") this.pause();
    else if (act === "restart") void this.seek(0);
    else if (act === "live" && this.summary) void this.load(this.summary.session_id, "live");
    else if (act === "replay" && this.summary) void this.load(this.summary.session_id, "replay");
    const sp = t.closest<HTMLElement>("[data-speed]");
    if (sp) this.setSpeed(Number(sp.dataset.speed));
    const out = t.closest<HTMLElement>("[data-out]");
    if (out) {
      const k = out.dataset.out!;
      if (this.outOpen.has(k)) this.outOpen.delete(k);
      else this.outOpen.add(k);
      this.renderRun();
    }
  }

  private message(h: string | null) {
    if (!h) return;
    this.win.querySelector(".cr-doc")!.innerHTML = `<div class="pg-msg"><div>${h}</div></div>`;
  }

  private renderAll() {
    this.renderState();
    this.renderChrome();
    this.renderControls();
    this.renderProgress();
    this.renderSay();
    this.renderRun();
  }

  /** The window: tabs, toolbar and the page. */
  private renderChrome() {
    this.renderTabs();
    this.renderOmni();
    this.renderDoc();
  }

  /**
   * Agent desktops (SPEC 17.7): while the session is live on a desktop the window shows its stream
   * (redacted on the server: the editor and run terminal stay pixelated until the verdict); once the
   * gate opened and the recording is linked, the recording. Otherwise, or when the viewer switches,
   * the reconstructed page.
   */
  private syncDesk() {
    const d = this.desk;
    const s = this.summary;
    if (!d) return;
    const base = s && this.io.desktop ? this.io.desktop(s.session_id) : null;
    let want: "live" | "rec" | null = null;
    if (s?.desktop && s.state === "live" && this.mode === "live" && base && !d.gone) want = "live";
    else if (!this.liveOnly && s?.desktop && s.open && s.recording && this.io.media) want = "rec";
    const key = want ? `${want}:${s!.session_id}` : "";
    if (key !== d.key) {
      d.player?.stop();
      d.player = null;
      d.video.removeAttribute("src");
      d.video.controls = false;
      d.key = key;
      if (want === "live") {
        d.player = playDesktop(d.video, base!, () => {
          d.gone = true;
          this.syncDesk();
        });
      } else if (want === "rec") {
        d.video.src = this.io.media!(s!.recording!.url);
        d.video.controls = true;
        d.video.preload = "metadata";
      }
    }
    const show = !!want && !d.panel;
    d.el.hidden = !show;
    this.win.dataset.desk = show ? "1" : "0";
    if (want === "rec" && !show) d.video.pause();
    d.el.querySelector(".cr-desk-tag")!.textContent =
      want === "live" ? "Live desktop. The editor and the run terminal stay pixelated until the verdict." : want === "rec" ? "Recording of the desktop, published after the verdict." : "";
    const sw = d.el.querySelector<HTMLButtonElement>(".cr-desk-sw")!;
    sw.textContent = "Show the reconstruction";
    // the way back lives in the deck while the reconstruction shows
    let back = this.root.querySelector<HTMLButtonElement>(".lp-deskback");
    if (want && d.panel) {
      if (!back) {
        back = document.createElement("button");
        back.type = "button";
        back.className = "lp-btn lp-deskback";
        back.addEventListener("click", () => {
          d.panel = false;
          this.syncDesk();
        });
        this.q(".lp-ctlrow").prepend(back);
      }
      back.textContent = want === "live" ? "Show the live desktop" : "Show the recording";
    } else back?.remove();
  }

  private setState(s: string, text: string) {
    const el = this.q(".lp-state");
    el.dataset.s = s;
    el.querySelector("span")!.textContent = text;
  }

  private renderState() {
    if (this.view === "idle" && this.idle) {
      this.setState(this.idle.kind === "next" ? "idle" : "paused", this.idle.kind === "next" ? "Idle" : "Paused");
      this.root.dataset.active = "0";
      this.q(".lp-banner").hidden = true;
      return;
    }
    const s = this.summary;
    if (!s) return;
    if (this.view === "facts") {
      this.setState("ended", s.state === "final" ? `Ended, ${s.candidate?.status ?? "final"}` : s.state === "sealed" ? "Ended, verdict pending" : "Ended");
      this.root.dataset.active = "0";
      const banner = this.q(".lp-banner");
      banner.hidden = true;
      banner.textContent = "";
      return;
    }
    const live = this.mode === "live" && s.state === "live";
    this.setState(live ? "live" : "replay", live ? "Live" : this.mode === "live" ? (s.state === "sealed" ? "Ended, sealed" : "Ended") : this.playing ? "Replay" : "Paused");
    this.root.dataset.active = live || this.playing ? "1" : "0";
    const banner = this.q(".lp-banner");
    let text = "";
    if (this.unsealedNote) text = s.state === "final" ? "The candidate is final, so its edits are public. Replaying the session with them." : "The attempt ended without a candidate, so its edits are public. Replaying the session with them.";
    else if (!s.open && s.state === "sealed") text = "This session committed a candidate that is still being replayed. Its edits stay sealed until the verdict.";
    else if (!s.open && s.state === "live") text = "Reads, searches, edited line ranges and sandbox phases show as they happen. Edit text is sealed until the attempt's candidate is final.";
    banner.hidden = !text;
    banner.textContent = text;
    const av = this.win.querySelector<HTMLElement>(".cr-avatar")!;
    av.textContent = who(s.proposer).slice(0, 1).toUpperCase();
    av.title = who(s.proposer);
  }

  private tabEl(id: string) {
    return this.win.querySelector<HTMLElement>(`.cr-tab[data-tab="${CSS.escape(id)}"]`);
  }

  private renderTabs() {
    const s = this.summary;
    const row = this.win.querySelector<HTMLElement>(".cr-tabs")!;
    const host = repoParts(s?.repo ?? null).host;
    const parts: string[] = [];
    this.tabs.forEach((id, i) => {
      const place = this.placeOf(id);
      const title = s ? titleOf(s.repo, s.commit, place) : this.view === "idle" ? "New Tab" : "Loading";
      const sel = id === this.active;
      const prevSel = this.tabs[i - 1] === this.active;
      if (i > 0 && !sel && !prevSel) parts.push('<span class="cr-sep" aria-hidden="true"></span>');
      else if (i > 0) parts.push('<span class="cr-sep off" aria-hidden="true"></span>');
      const f = this.files.get(id);
      const mark = f?.sealed.length ? `<span class="cr-mark" title="sealed edits">${C.lock}</span>` : f?.edited.size ? '<span class="cr-dot" title="edited"></span>' : "";
      const fav = this.loading === id ? '<span class="cr-fav cr-spin" aria-hidden="true"></span>' : favicon(id === SANDBOX ? "sandbox" : id === "@new" ? "new" : "site", host || "r");
      parts.push(
        `<button type="button" class="cr-tab${this.ring === `tab:${id}` ? " ring" : ""}" role="tab" data-tab="${esc(id)}" aria-selected="${sel}" title="${esc(title)}">${fav}<span class="cr-t">${esc(id === HOME || id === SEARCH || id === SANDBOX || id === "@new" ? title : base(id))}</span>${mark}<span class="cr-x" aria-hidden="true">${C.close}</span></button>`,
      );
    });
    parts.push(`<span class="cr-ib cr-new" aria-hidden="true">${C.plus}</span>`);
    row.innerHTML = parts.join("");
    // narrow tabs keep their close button only on the active one, as the browser does
    row.dataset.many = this.tabs.length > 4 ? "1" : "0";
  }

  private renderOmni() {
    const s = this.summary;
    const box = this.win.querySelector<HTMLElement>(".cr-omni")!;
    const url = box.querySelector<HTMLElement>(".cr-url")!;
    box.classList.toggle("ring", this.ring === "omni");
    if (this.omni) {
      box.dataset.edit = "1";
      url.innerHTML = this.omni.text ? `<span class="h">${esc(this.omni.text)}</span><span class="cr-caret"></span>` : `<span class="cr-caret"></span><span class="ph">Search or type a URL</span>`;
      return;
    }
    box.dataset.edit = "0";
    if (!s || this.active === "@new") {
      url.innerHTML = `<span class="ph">Search or type a URL</span>`;
      return;
    }
    const a = addressOf(s.repo, s.commit, this.placeOf(this.active));
    box.querySelector(".cr-site")!.innerHTML = a.secure ? C.tune : C.term;
    url.innerHTML = `<span class="h">${esc(a.host)}</span><span class="r">${esc(a.rest)}</span>`;
  }

  /** The site's search field, repainted alone while the pointer types into it. */
  private paintFind() {
    const f = this.win.querySelector<HTMLElement>(".gh-find");
    if (!f) return;
    f.classList.toggle("ring", this.ring === "find");
    const v = this.findText ?? (this.active === SEARCH ? (this.search?.q ?? "") : "");
    f.querySelector(".v")!.innerHTML = this.findText !== null ? `${esc(v)}<span class="cr-caret"></span>` : v ? esc(v) : `<span class="ph">Type / to search</span>`;
  }

  /** The page in the active tab. */
  private renderDoc() {
    const s = this.summary;
    const doc = this.win.querySelector<HTMLElement>(".cr-doc")!;
    const page = this.win.querySelector<HTMLElement>(".cr-page")!;
    if (this.view === "idle") {
      page.dataset.k = "idle";
      page.dataset.kind = "new";
      doc.innerHTML = this.idleHtml();
      return;
    }
    if (!s) return;
    if (this.view === "facts") {
      page.dataset.k = "facts";
      page.dataset.kind = "site";
      doc.innerHTML = this.siteHead() + this.factsHtml();
      return;
    }
    const key = `${this.active}`;
    const keepScroll = page.dataset.k === key;
    const top = page.scrollTop;
    const codeLeft = doc.querySelector<HTMLElement>(".gh-code")?.scrollLeft ?? 0;
    page.dataset.k = key;
    page.dataset.kind = this.active === SANDBOX ? "sandbox" : this.active === "@new" ? "new" : "site";
    if (this.active === "@new") doc.innerHTML = `<div class="pg-new"></div>`;
    else if (this.active === SANDBOX) doc.innerHTML = this.sandboxHtml();
    else if (this.active === SEARCH) doc.innerHTML = this.siteHead() + this.searchHtml();
    else if (this.active === HOME) doc.innerHTML = this.siteHead() + this.homeHtml();
    else doc.innerHTML = this.siteHead() + this.fileHtml(this.active);
    if (keepScroll) page.scrollTop = top;
    else page.scrollTop = 0;
    const code = doc.querySelector<HTMLElement>(".gh-code");
    if (code && keepScroll) code.scrollLeft = codeLeft;
    this.paintFind();
    // a file still loading (after a jump): load and redraw
    const f = this.files.get(this.active);
    if (f && !f.lines && !f.note) void this.loadFile(f, false).then(() => this.active === f.path && (this.renderDoc(), this.settleCursor()));
  }

  /** The code host's page header: repository, the search field and the section tabs. */
  private siteHead() {
    const s = this.summary!;
    const r = repoParts(s.repo);
    const [owner, name] = r.path.includes("/") ? [r.path.slice(0, r.path.lastIndexOf("/")), r.path.slice(r.path.lastIndexOf("/") + 1)] : ["", r.path];
    return `<header class="gh-top"><span class="gh-menu" aria-hidden="true"><i></i><i></i><i></i></span><span class="gh-repo">${owner ? `<span>${esc(owner)}</span><span class="sl">/</span>` : ""}<b>${esc(name)}</b></span>
      <span class="gh-find${this.ring === "find" ? " ring" : ""}">${C.search}<span class="v"></span></span></header>
      <nav class="gh-nav"><span aria-current="page">${C.repo}Code</span><span>Issues</span><span>Pull requests</span><span>Actions</span></nav>`;
  }

  /** Live only: the agent has no session in progress. */
  private idleHtml() {
    const st = this.idle ?? { kind: "next" as const, last_end: null };
    return `<div class="pg-msg lp-idle" data-idle="${st.kind}"><div><b>${esc(idleTitle(st))}</b><div class="lp-idle-sub">${esc(idleSub(st))}</div>${
      st.kind === "next" ? `<div class="lp-idle-sub">The window goes live as soon as the agent starts its next session.</div>` : `<div class="lp-idle-sub">The agent starts again once the runtime can pay for its next session.</div>`
    }</div></div>`;
  }

  /** Live only: an ended session's final facts (no playback). */
  private factsHtml() {
    const s = this.summary!;
    const kv = (k: string, v: string) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`;
    const c = s.candidate;
    const eff = c?.verdict?.effect;
    const ratio = eff && typeof eff.ratio === "number" ? `${esc(eff.metric)} ratio ${esc(eff.ratio.toFixed(4))} (${esc((Math.abs(1 - eff.ratio) * 100).toFixed(1))}% ${eff.ratio < 1 ? "better" : "worse"})` : eff?.fixed ? `fixed ${esc(eff.fixed.join(", "))}` : "";
    const verdict =
      s.state === "final" && c
        ? `<b class="${c.status === "accepted" ? "lp-ok" : "lp-bad"}">${esc(c.status)}</b>${c.reason ? ` <span class="dim">${esc(c.reason.replace(/_/g, " "))}</span>` : ""}`
        : s.state === "sealed"
          ? `<span class="dim">being replayed by independent verifiers</span>`
          : `<span class="dim">ended without a candidate</span>`;
    const links = [
      c ? `<a ${this.a(`/candidates/${c.candidate_id ?? c.commit_id}`)}>Candidate</a>` : "",
      c?.gen_id ? `<a ${this.a(`/generations/${c.gen_id}`)}>Generation</a>` : "",
      this.verified ? `<a href="${esc(this.verified.url)}" target="_blank" rel="noopener">${esc(this.verified.label)}</a>` : "",
    ].filter(Boolean);
    const agent = s.agent ? `<a ${this.a(`/agents/${s.agent}`)}>${esc(s.agent.slice(0, 6))}...${esc(s.agent.slice(-4))}</a>` : `<span title="Hidden while the session's candidate is open (SPEC 10.7)">withheld</span>`;
    const end = endOf(s);
    return `<div class="gh-wrap gh-home lp-facts" data-facts="${esc(s.state)}">
      <div class="gh-box"><div class="gh-bh"><span class="gh-av">${esc(who(s.proposer).slice(0, 1))}</span><b>Session ended</b><span class="dim">${end ? esc(new Date(end).toLocaleString()) : ""}</span></div>
        <div class="gh-row gh-note"><span class="p">Verdict: ${verdict}</span>${ratio ? `<span class="c">${ratio}</span>` : ""}</div>
        ${links.length ? `<div class="gh-row gh-note lp-facts-links">${links.join("")}</div>` : ""}</div>
      <dl class="gh-about">
        ${kv("Agent", agent)}
        ${kv("Lineage", `<a ${this.a(`/lineages/${s.lineage_id}`)}>${esc(s.recipe_name ?? s.lineage_id.slice(0, 8))}</a>`)}
        ${kv("Parent", `<a ${this.a(`/generations/${s.gen_id}`)} title="${esc(s.gen_id)}">gen ${esc(s.height ?? "?")}</a>`)}
        ${kv("Started", esc(new Date(s.started_at).toLocaleString()))}
        ${kv("Duration", esc(mmss((s.ended_at ?? s.last_at) - s.started_at)))}
        ${kv("Events", esc(s.events))}
      </dl>
      <div class="lp-idle-sub">Lineage shows live work only; past sessions are not replayed.</div></div>`;
  }

  private homeHtml() {
    const s = this.summary!;
    const r = repoParts(s.repo);
    const kv = (k: string, v: string) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`;
    const files = this.tabs
      .filter((p) => this.files.has(p))
      .map((p) => {
        const f = this.files.get(p)!;
        const what = f.sealed.length ? `${f.sealed.length} sealed ${f.sealed.length === 1 ? "edit" : "edits"}` : f.edited.size ? `${f.edited.size} lines changed` : `${f.touched} ${f.touched === 1 ? "read" : "reads"}`;
        return `<button type="button" class="gh-row" data-tab="${esc(p)}">${C.file}<span class="p">${esc(p)}</span><span class="c">${esc(what)}</span></button>`;
      })
      .join("");
    const agent = s.agent ? `<a ${this.a(`/agents/${s.agent}`)}>${esc(s.agent.slice(0, 6))}...${esc(s.agent.slice(-4))}</a>` : `<span title="Hidden while the session's candidate is open (SPEC 10.7)">withheld</span>`;
    const listed = this.listing ? `<div class="gh-row gh-note">${C.folder}<span class="p">${esc(this.listing.path === "." ? r.path.split("/").pop() : this.listing.path)}</span><span class="c">${esc(this.listing.count)} files listed by the agent</span></div>` : "";
    return `<div class="gh-wrap gh-home">
      <div class="gh-bar"><span class="gh-btn">${C.branch}<b>${esc(s.commit.slice(0, 7))}</b></span><span class="dim">generation ${esc(s.height ?? "?")} of lineage ${esc(s.recipe_name ?? "")}</span></div>
      <div class="gh-box gh-files"><div class="gh-bh"><span class="gh-av">${esc(who(s.proposer).slice(0, 1))}</span><b>${esc(who(s.proposer))}</b><span class="dim">authoring session, ${esc(this.events.length)} events</span></div>
        ${listed}${files || (listed ? "" : `<div class="gh-row gh-note"><span class="p dim">No file opened yet.</span></div>`)}</div>
      <dl class="gh-about">
        ${kv("Agent", agent)}
        ${kv("Lineage", `<a ${this.a(`/lineages/${s.lineage_id}`)}>${esc(s.recipe_name ?? s.lineage_id.slice(0, 8))}</a>`)}
        ${kv("Parent", `<a ${this.a(`/generations/${s.gen_id}`)} title="${esc(s.gen_id)}">gen ${esc(s.height ?? "?")}</a>`)}
        ${kv("Started", esc(new Date(s.started_at).toLocaleString()))}
        ${kv("Duration", esc(mmss((s.ended_at ?? s.last_at) - s.started_at)))}
      </dl></div>`;
  }

  private fileHtml(path: string) {
    const s = this.summary!;
    const f = this.files.get(path);
    const r = repoParts(s.repo);
    const segs = path.split("/");
    const crumbs = `<span>${esc(r.path.split("/").pop())}</span>${segs.map((x, i) => `<span class="sl">/</span>${i === segs.length - 1 ? `<b>${esc(x)}</b>` : `<span>${esc(x)}</span>`}`).join("")}`;
    let body: string;
    let count = "";
    if (!f || (!f.lines && !f.note)) body = `<div class="pg-msg"><div>Loading ${esc(path)}</div></div>`;
    else if (!f.lines) body = `<div class="pg-msg"><div><b>${esc(f.path)}</b>: ${esc(f.note)}</div></div>`;
    else {
      count = `${f.lines.length} lines`;
      body = `<div class="gh-code${this.ring === "code" ? " ring" : ""}"><div class="lp-lines">${this.linesHtml(f)}</div></div>`;
    }
    return `<div class="gh-wrap"><div class="gh-crumbs">${crumbs}</div>
      <div class="gh-box gh-file"><div class="gh-bh"><span class="gh-seg"><span aria-pressed="true">Code</span><span>Blame</span></span><span class="dim">${esc(count)}</span><span class="sp"></span><span class="gh-btn">Raw</span><span class="gh-btn gh-ico">${C.copy}</span></div>${body}</div></div>`;
  }

  private linesHtml(f: FileState) {
    let view = f.lines!.map((t, i) => ({ t, n: i + 1, cls: f.edited.has(i + 1) ? "edited" : "", caret: false }));
    for (const r of f.sealed) for (let n = r.start; n <= r.end && n <= view.length; n++) view[n - 1]!.cls = "sealed";
    const ty = this.typing && this.typing.path === f.path ? this.typing : null;
    if (ty) {
      const typed = ty.lines.map((t, i) => ({ t, n: ty.at + i, cls: "typing", caret: i === ty.lines.length - 1 }));
      view = [...view.slice(0, ty.at - 1), ...typed, ...view.slice(ty.at - 1 + ty.oldCount).map((x) => ({ ...x, n: x.n - ty.oldCount + typed.length }))];
    }
    const h = this.hl && this.hl.path === f.path ? this.hl : null;
    const sel = this.sel && this.sel.path === f.path ? this.sel : null;
    const html: string[] = [];
    for (const v of view) {
      let cls = h && v.n >= h.start && v.n <= h.end ? h.cls : v.cls;
      if (sel && v.n >= sel.start && v.n <= sel.end) cls += " sel";
      html.push(`<div class="lp-l${cls ? " " + cls.trim() : ""}" data-n="${v.n}"><span class="lp-n">${v.n}</span><span class="lp-c">${lineHtml(v.t, v.caret)}</span></div>`);
    }
    if (h && h.cls === "sealed") {
      // a sealed range past the parent's end still shows
      for (let n = view.length + 1; n <= Math.min(h.end, view.length + 3); n++) html.push(`<div class="lp-l sealed" data-n="${n}"><span class="lp-n">${n}</span><span class="lp-c"></span></div>`);
      const i = html.findIndex((x) => x.includes(`data-n="${h.start}"`));
      if (i >= 0) html[i] = html[i]!.replace(/<\/div>$/, `<span class="lp-seal">${C.lock} sealed until the candidate is final</span></div>`);
    }
    return html.join("");
  }

  /** Repaints only the line marks (selection, highlight) of the open file: cheap enough for every drag frame. */
  private paintMarks() {
    const box = this.win.querySelector<HTMLElement>(".lp-lines");
    const f = this.files.get(this.active);
    if (!box || !f?.lines) return;
    const h = this.hl && this.hl.path === f.path ? this.hl : null;
    const sel = this.sel && this.sel.path === f.path ? this.sel : null;
    for (const el of box.children as HTMLCollectionOf<HTMLElement>) {
      const n = Number(el.dataset.n);
      el.classList.toggle("sel", !!sel && n >= sel.start && n <= sel.end);
      el.classList.toggle("hl", !!h && h.cls === "hl" && n >= h.start && n <= h.end);
      el.classList.toggle("del", !!h && h.cls === "del" && n >= h.start && n <= h.end);
    }
    this.win.querySelector(".gh-code")?.classList.toggle("ring", this.ring === "code");
  }

  private searchHtml() {
    const q = this.search?.q ?? "";
    // matches in the files this session has opened, so the page shows real lines; the agent's count covers the whole repository
    let re: RegExp | null = null;
    try {
      re = q ? new RegExp(q, "i") : null;
    } catch {
      re = null;
    }
    const groups: string[] = [];
    let shown = 0;
    for (const [path, f] of this.files) {
      if (!f.lines || shown >= 12) continue;
      const hits: string[] = [];
      f.lines.forEach((t, i) => {
        if (shown >= 12 || !(re ? re.test(t) : t.includes(q))) return;
        shown++;
        hits.push(`<div class="lp-l"><span class="lp-n">${i + 1}</span><span class="lp-c">${lineHtml(t)}</span></div>`);
      });
      if (hits.length) groups.push(`<div class="gh-box gh-hit"><div class="gh-bh">${C.file}<b>${esc(path)}</b></div><div class="gh-code"><div class="lp-lines">${hits.join("")}</div></div></div>`);
    }
    const m = this.search?.m;
    return `<div class="gh-wrap"><div class="gh-sr"><b>${m !== undefined ? `${esc(m)} matching lines` : "Results"}</b><span class="dim">for ${esc(q)} in this repository</span></div>
      ${groups.length ? `<div class="dim gh-sub">In the files this session has opened:</div>${groups.join("")}` : `<div class="pg-msg sm"><div>The matching lines are in files this session has not opened.</div></div>`}</div>`;
  }

  private sandboxHtml() {
    const runs = this.runs;
    if (!runs.length) return `<div class="pg-msg"><div>No sandbox run yet.</div></div>`;
    const r = runs.at(-1)!;
    const n = runs.length;
    const rows = PHASES.filter((p) => p !== "equivalence" || r.phases.some((x) => x.phase === p))
      .map((p) => {
        const idx = r.phases.findIndex((x) => x.phase === p);
        const cur = !r.done && r.phases.at(-1)?.phase === p;
        const st = idx < 0 ? "wait" : cur ? "on" : "done";
        const ms = phaseMs(r.phases, p);
        const t = ms !== null ? secs(ms) : "";
        return `<div class="sb-l" data-s="${st}"><span class="sb-i">${st === "done" ? C.check : st === "on" ? '<i class="sb-spin"></i>' : ""}</span><span class="sb-p">${esc(p)}</span><span class="sb-t">${esc(t)}</span></div>`;
      })
      .join("");
    const out = r.done
      ? r.sealed
        ? `<div class="sb-out sealed">${C.lock}<span>Output sealed until the candidate is final</span></div>`
        : `<div class="sb-res ${r.outcome === "accepted" ? "ok" : "bad"}">${r.outcome === "accepted" ? C.check : C.x}<b>${esc(r.outcome ?? "done")}</b></div>${r.output ? `<pre class="sb-out">${esc(r.output)}</pre>` : ""}`
      : "";
    return `<div class="sb"><div class="sb-h"><span class="sb-ic">${C.term}</span><div><b>Sandbox</b><div class="dim">Run ${n}${n > 1 ? ` of ${n}` : ""}, ${esc(r.kind ?? "")} ${esc(r.target)}</div></div></div>
      <div class="sb-term">${rows}${out}</div></div>`;
  }

  private renderControls() {
    const ctl = this.q(".lp-ctl");
    const s = this.summary;
    if (!s) {
      ctl.innerHTML = "";
      return;
    }
    if (this.view === "facts") {
      ctl.innerHTML = "";
      return;
    }
    if (this.mode === "live") {
      ctl.innerHTML = `<span class="lp-none">${esc(who(s.proposer))}${s.state === "live" ? ", following live" : ""}</span>${this.liveOnly ? "" : `<button type="button" class="lp-btn" data-act="replay">${C.restart} Replay</button>`}`;
      return;
    }
    const playBtn = this.playing ? `<button type="button" class="lp-btn" data-act="pause" aria-label="Pause">${C.pause}</button>` : `<button type="button" class="lp-btn" data-act="play" aria-label="Play"${this.idx >= this.events.length && this.events.length ? ' disabled title="At the end; restart to replay"' : ""}>${C.play}</button>`;
    ctl.innerHTML = `${playBtn}<button type="button" class="lp-btn" data-act="restart" aria-label="Restart">${C.restart}</button><span class="lp-seg" role="group" aria-label="Speed">${SPEEDS.map((x) => `<button type="button" data-speed="${x}" aria-pressed="${x === this.speed}">${x}x</button>`).join("")}</span>${s.state === "live" ? `<button type="button" class="lp-btn" data-act="live"><i class="lp-livedot"></i> Live</button>` : ""}`;
  }

  private renderProgress() {
    const prog = this.q(".lp-prog");
    prog.hidden = this.mode === "live" || this.view !== "play" || !this.events.length;
    const pct = this.events.length ? (this.idx / this.events.length) * 100 : 0;
    prog.querySelector("i")!.style.width = `${pct}%`;
    prog.setAttribute("aria-valuemax", String(this.events.length));
    prog.setAttribute("aria-valuenow", String(this.idx));
    prog.setAttribute("aria-valuetext", `event ${this.idx} of ${this.events.length}`);
  }

  private renderSay() {
    const say = this.q(".lp-say");
    const s = this.summary;
    if (this.view === "idle" || (this.view === "facts" && s)) {
      say.querySelector(".t")!.innerHTML = this.view === "idle" ? esc(this.idle ? idleTitle(this.idle) : "Starting next session") : "Session ended";
      say.querySelector(".tm")!.textContent = "";
      return;
    }
    if (!this.say || !s) {
      say.querySelector(".t")!.innerHTML = s ? (this.events.length ? "Starting" : s.state === "live" ? "Waiting for the agent's first tool call" : "This session recorded no events") : "";
      say.querySelector(".tm")!.textContent = "";
      return;
    }
    say.querySelector(".t")!.innerHTML = this.say.html;
    say.querySelector(".tm")!.textContent = `+${mmss(this.say.at - s.started_at)}`;
  }

  private renderRun() {
    const box = this.q(".lp-run");
    const s = this.summary;
    if (!s) {
      box.innerHTML = "";
      return;
    }
    if (this.view === "facts") {
      // final facts only: the network's verdict, no reconstruction of the author's runs
      box.innerHTML = this.networkHtml();
      return;
    }
    const out: string[] = [];
    const runs = this.runs.slice(-3);
    const first = this.runs.length - runs.length;
    out.push(`<div class="lp-run-h">Sandbox runs<span class="aside">${this.runs.length ? `${this.runs.length} by the author` : ""}</span></div>`);
    if (!runs.length) out.push(`<div class="lp-none">${s.proposer === "scripted" ? "Scripted authors submit without measuring first; the network's replays below are this change's run." : "No sandbox run yet. Build, test and metrics phases appear here when the agent measures its change."}</div>`);
    runs.forEach((r, i) => {
      const n = first + i + 1;
      const seen = new Set(r.phases.map((p) => p.phase));
      const cur = r.done ? null : r.phases.at(-1)?.phase;
      const chips = PHASES.filter((p) => p !== "equivalence" || seen.has(p))
        .map((p) => {
          const st = p === cur ? "on" : seen.has(p) ? "done" : "wait";
          const ms = phaseMs(r.phases, p);
          const t = ms !== null ? ` ${secs(ms)}` : "";
          return `<span data-s="${st}">${st === "done" ? C.check : st === "on" ? "<i></i>" : ""}${p}${esc(t)}</span>`;
        })
        .join("");
      const verdict = r.done
        ? r.sealed
          ? `<span class="lp-none" style="display:inline-flex;gap:4px;align-items:center">${C.lock} output sealed</span>`
          : `<b class="${r.outcome === "accepted" ? "lp-ok" : "lp-bad"}">${esc(r.outcome ?? "done")}</b>`
        : `<span class="lp-none">running</span>`;
      const key = `run${n}`;
      const canOpen = r.done && !r.sealed && (r.output || r.steps?.length);
      out.push(`<div class="lp-row"><span class="lbl">Run ${n} <span>${esc(r.kind ?? "")} ${esc(r.target)}</span></span><span class="lp-ph">${chips}</span>${verdict}${canOpen ? `<button type="button" class="lp-out-t" data-out="${key}" aria-expanded="${this.outOpen.has(key)}">${this.outOpen.has(key) ? "Hide output" : "Output"}</button>` : ""}</div>`);
      if (canOpen && this.outOpen.has(key)) out.push(this.outputHtml(r.output, r.steps));
    });
    out.push(this.networkHtml());
    box.innerHTML = out.join("");
  }

  private outputHtml(output: string | null | undefined, steps: SEv["steps"]): string {
    const st = (steps ?? [])
      .map(
        (x) =>
          `<div><div class="st">${esc(x.step)}${x.side ? ` (${esc(x.side === "cand" ? "candidate" : x.side)})` : ""} <span>exit ${esc(x.exit)}, ${esc(secs(x.duration_ms))}${x.timed_out ? ", timed out" : ""}</span></div>${x.tail?.trim() ? `<pre>${esc(x.tail.trim())}</pre>` : ""}</div>`,
      )
      .join("");
    return `<div class="lp-out">${output ? `<pre>${esc(output)}</pre>` : ""}${st}</div>`;
  }

  private networkHtml(): string {
    const s = this.summary!;
    const head = `<div class="lp-run-h" style="margin-top:4px">Network verdict</div>`;
    if (s.state === "live") return `${head}<div class="lp-none">Nothing committed yet.</div>`;
    if (s.state === "ended" || s.state === "abandoned") return `${head}<div class="lp-none">The attempt ended without a candidate.</div>`;
    if (!s.candidate) return `${head}<div class="lp-none">A candidate from this session is being replayed by independent verifiers. The verdict and the candidate's link appear once it is final.</div>`;
    const c = s.candidate;
    const eff = c.verdict?.effect;
    const ratio = eff && typeof eff.ratio === "number" ? `${eff.metric} ratio ${eff.ratio.toFixed(4)} (${(Math.abs(1 - eff.ratio) * 100).toFixed(1)}% ${eff.ratio < 1 ? "better" : "worse"})` : eff?.fixed ? `fixed ${eff.fixed.join(", ")}` : "";
    const cls = c.status === "accepted" ? "lp-ok" : "lp-bad";
    const rows = [
      `<div class="lp-row"><b class="${cls}">${esc(c.status)}</b>${c.reason ? `<span>${esc(c.reason.replace(/_/g, " "))}</span>` : ""}${ratio ? `<span class="lbl"><span>${esc(ratio)}</span></span>` : ""}<a class="link" ${this.a(`/candidates/${c.candidate_id ?? c.commit_id}`)}>candidate</a>${c.gen_id ? `<a class="link" ${this.a(`/generations/${c.gen_id}`)}>generation</a>` : ""}</div>`,
    ];
    const cand = this.network?.cand;
    if (cand?.replays?.length) {
      for (const r of cand.replays.filter((x: any) => x.result)) {
        const res = r.result;
        const m = Object.entries(res.metrics ?? {})
          .map(([k, v]: [string, any]) => {
            const b = v.base?.length ? v.base.reduce((a: number, x: number) => a + x, 0) / v.base.length : null;
            const cc = v.cand?.length ? v.cand.reduce((a: number, x: number) => a + x, 0) / v.cand.length : null;
            return b && cc ? `${k} ${(cc / b).toFixed(4)}` : null;
          })
          .filter(Boolean)
          .join(", ");
        const key = `tx${r.replay_id}`;
        const tx = this.network!.transcripts.get(r.replay_id);
        rows.push(
          `<div class="lp-row"><span class="lbl">${esc(r.kind === "reference" ? "Reference replay" : r.kind === "audit" ? "Audit replay" : "Replay")} <span>build ${esc(res.build?.cand)}, tests ${esc(res.tests?.cand_pass?.length ?? 0)} pass, ${esc(res.tests?.cand_fail?.length ?? 0)} fail${res.equivalence ? `, outputs ${res.equivalence.base_digest === res.equivalence.cand_digest ? "identical" : "differ"}` : ""}${m ? `, ${esc(m)}` : ""}</span></span>${tx ? `<button type="button" class="lp-out-t" data-out="${key}" aria-expanded="${this.outOpen.has(key)}">${this.outOpen.has(key) ? "Hide transcript" : "Transcript"}</button>` : ""}</div>`,
        );
        if (tx && this.outOpen.has(key))
          rows.push(this.outputHtml(null, (tx.steps ?? []).map((x: any) => ({ step: x.step, side: x.side, exit: x.exit, duration_ms: x.duration_ms, timed_out: x.timed_out, tail: [x.stdout_tail, x.stderr_tail].filter((t: string) => t && t.trim()).join("\n").slice(-1500) }))));
      }
    }
    return head + rows.join("");
  }

  private renderList() {
    const box = this.host.querySelector<HTMLElement>(".lp-list");
    if (!box) return;
    if (!this.others.length) {
      box.innerHTML = "";
      return;
    }
    box.innerHTML = this.others
      .map(
        (s) =>
          `<button type="button" class="lp-sess" data-sess="${esc(s.session_id)}" aria-current="${s.session_id === this.summary?.session_id}"><i data-s="${esc(s.state)}"></i>${esc(s.state === "live" ? "Live now" : ago(s.started_at))}<span style="color:var(--faint)">${esc(s.recipe_name ?? "")}, ${esc(s.events)} events</span></button>`,
      )
      .join("");
  }
}
