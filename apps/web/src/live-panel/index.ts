import { ApiError, get } from "../api.ts";
import { fileAt } from "../code.ts";
import { esc } from "../html.ts";
import { ensureStyle } from "./style.ts";

// Live agent panel (SPEC 17.3, plan L4): a browser-style window with an orange glow and an orange
// cursor that shows one authoring session: a tab for the repository and one per file the agent
// touched, a code view where the cursor moves to the lines it reads and its edits type in, and a run
// strip with its own sandbox runs and the network's verdict.
//
// Everything shown is read from Core: the session's events (GET /v1/sessions/:id), files at the
// session's generation (GET /v1/lineages/:id/file), the candidate and its replays once final.
// Edit contents arrive only when Core's gate opens them; until then an edit shows as a sealed range.
//
// Embedding (the token page, L3):
//
//   import { mount } from "./live-panel/index.ts";
//   const panel = mount(el, { agent });            // the agent's live session, else its latest in replay
//   const panel = mount(el, { session, mode: "replay", speed: 2 });
//   panel.destroy();
//
// mode "auto" (default) follows a live session and replays a finished one; it switches to the newest
// session of the mounted agent or lineage when one starts, and replays a session from the start
// with its edits once its gate opens.

export type PanelMode = "auto" | "live" | "replay";

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
  /** code view height in px (default 440, 360 on narrow screens) */
  height?: number;
  /** called whenever the shown session changes or its summary updates */
  onSession?: (s: SessionSummary | null) => void;
}

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
const SPEEDS = [0.5, 1, 2, 4, 8];
const HOME = "@repo";

const svg = (d: string, vb = "0 0 16 16") => `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const I = {
  file: svg('<path d="M4 1.8h5l3 3v9.4H4z"/><path d="M9 1.8v3h3"/>'),
  branch: svg('<circle cx="4.5" cy="3.5" r="1.7"/><circle cx="4.5" cy="12.5" r="1.7"/><circle cx="11.5" cy="5.5" r="1.7"/><path d="M4.5 5.2v5.6M11.5 7.2c0 2.5-2.2 3-5 3.6"/>'),
  lock: svg('<rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2"/>'),
  play: svg('<path d="M5 3.2v9.6l7.5-4.8z" fill="currentColor" stroke="none"/>'),
  pause: svg('<path d="M5 3.5v9M11 3.5v9" stroke-width="2.2"/>'),
  restart: svg('<path d="M3 3v4h4"/><path d="M3.4 9.5A5 5 0 103.9 5"/>'),
  eye: svg('<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.8"/>'),
  search: svg('<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2L14 14"/>'),
  pen: svg('<path d="M10.8 2.7l2.5 2.5-7.6 7.6-3.2.7.7-3.2z"/>'),
  list: svg('<path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01"/>'),
  scale: svg('<path d="M8 2v12M3 14h10M4 5h8M4 5l-2 5h4zM12 5l-2 5h4z"/>'),
  check: svg('<path d="M3.5 8.5l3 3 6-7"/>'),
  x: svg('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'),
  chat: svg('<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/>'),
  live: svg('<circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none"/>'),
  info: svg('<circle cx="8" cy="8" r="6.2"/><path d="M8 7.2v4M8 4.8v.4"/>'),
};
const POINTER = `<svg viewBox="0 0 20 22" aria-hidden="true"><path d="M2 1.5l15 8.2-6.6 1.6-3.3 6.6z" fill="var(--lp-o)" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>`;

const base = (p: string) => p.split("/").pop() || p;
const repoLabel = (u: string | null) => (u ? u.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "") : "repository");
const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const secs = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
const range = (e: SEv) => (e.start_line ? (e.end_line && e.end_line !== e.start_line ? `lines ${e.start_line} to ${e.end_line}` : `line ${e.start_line}`) : "");
const who = (p: string) => (p === "anthropic" ? "Claude" : p === "scripted" ? "Scripted author" : p);
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
  ensureStyle();
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
  private want: PanelMode;
  private playing = false;
  private speed: number;
  private gen = 0;
  private files = new Map<string, FileState>();
  private tabs: string[] = [];
  private active = HOME;
  private hl: { path: string; start: number; end: number; cls: string } | null = null;
  private typing: { path: string; at: number; lines: string[]; oldCount: number } | null = null;
  private cursorAt: { path: string; line: number; caret?: boolean } | null = null;
  private runs: Run[] = [];
  private say: { html: string; at: number; icon: string } | null = null;
  private search: { q: string; m: number | undefined } | null = null;
  private outOpen = new Set<string>();
  private es: EventSource | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private dead = false;
  private refetching: Promise<void> | null = null;
  private unsealedNote = false;
  private others: SessionSummary[] = [];
  private network: { cand: any; transcripts: Map<string, any> } | null = null;
  private reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  private root!: HTMLElement;
  private q = <T extends HTMLElement = HTMLElement>(sel: string) => this.root.querySelector<T>(sel)!;

  constructor(
    private host: HTMLElement,
    private opts: LivePanelOptions,
  ) {
    this.want = opts.mode ?? "auto";
    this.speed = SPEEDS.includes(opts.speed ?? 1) ? (opts.speed ?? 1) : 1;
  }

  // ------------------------------------------------------------------------------------------- setup

  async init() {
    this.host.innerHTML = `<div class="lp" data-active="0" role="region" aria-label="Agent session">
      <div class="lp-tabs"><div class="lp-dots" aria-hidden="true"><i></i><i></i><i></i></div><div class="lp-tabrow" role="tablist" aria-label="Files"></div><span class="lp-state" data-s="idle"><i></i><span>Loading</span></span></div>
      <div class="lp-bar"><div class="lp-addr">${I.branch}<span class="p"></span><span class="rng"></span></div><div class="lp-find" role="status">${I.search}<span class="q"></span><span class="m"></span></div><div class="lp-ctl"></div></div>
      <div class="lp-prog" role="slider" tabindex="0" aria-label="Replay position" aria-valuemin="0" hidden><i></i></div>
      <div class="lp-banner" hidden>${I.info}<span></span></div>
      <div class="lp-view" style="${this.opts.height ? `--lp-h:${this.opts.height}px` : ""}"><div class="lp-code" tabindex="0" aria-label="Code"><div class="lp-lines"></div><div class="lp-cursor" aria-hidden="true">${POINTER}<span class="tag"></span></div></div><div class="lp-home" hidden></div><div class="lp-msg" hidden></div></div>
      <div class="lp-say" aria-live="polite"><span class="ic">${I.eye}</span><span class="t"></span><span class="tm"></span></div>
      <div class="lp-run"></div>
    </div>${this.opts.list === false || this.opts.session ? "" : '<div class="lp-list" aria-label="Sessions"></div>'}`;
    this.root = this.host.querySelector(".lp")!;
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
    this.connect();
    this.poll = setInterval(() => {
      if (!this.host.isConnected) return this.destroy();
      if (this.summary && (this.summary.state === "live" || this.summary.state === "sealed")) void this.refresh();
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
    if (this.poll) clearInterval(this.poll);
  }

  private listQuery() {
    return this.opts.agent ? `agent=${this.opts.agent}` : this.opts.lineage ? `lineage=${this.opts.lineage}` : "";
  }

  private async pickFromList() {
    const q = this.listQuery();
    const all = await get<SessionSummary[]>(`sessions?${q}${q ? "&" : ""}limit=24`);
    // sessions that recorded nothing (older workers opened one per idle attempt) are left out, unless
    // one is live right now
    this.others = all.filter((s) => s.events > 0 || s.state === "live").slice(0, 12);
    const pick = this.others.find((s) => s.state === "live" && s.events > 0) ?? this.others.find((s) => s.events > 0) ?? this.others[0];
    if (!pick) {
      this.setState("idle", "No sessions");
      this.message(
        this.opts.agent
          ? "<b>This agent has no authoring session yet.</b> The panel goes live as soon as it starts working on a lineage."
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
    const v = await get<SessionSummary & { event_list: SEv[] }>(`sessions/${id}`);
    if (this.dead) return;
    const { event_list, ...summary } = v;
    this.summary = summary;
    this.events = event_list;
    this.unsealedNote = false;
    this.network = null;
    this.mode = want === "live" || (want === "auto" && summary.state === "live") ? "live" : "replay";
    this.reset();
    this.opts.onSession?.(this.summary);
    this.renderList();
    this.renderAll();
    if (summary.state === "final" && summary.candidate) void this.loadNetwork();
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
        const v = await get<SessionSummary & { event_list: SEv[] }>(`sessions/${id}`);
        if (this.dead || this.summary?.session_id !== id) return;
        const { event_list, ...summary } = v;
        const wasOpen = this.summary.open;
        this.summary = summary;
        this.opts.onSession?.(summary);
        if (!wasOpen && summary.open) {
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
        this.renderHome();
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
      const cand = await get(`candidates/${c.commit_id}`);
      const transcripts = new Map<string, any>();
      this.network = { cand, transcripts };
      this.renderRun();
      // the first revealed replay's transcript: real build, test and metrics output
      const r = (cand.replays ?? []).find((x: any) => x.result?.transcript_digest && x.status === "revealed");
      if (r) {
        const res = await fetch(`/api/blobs/${r.result.transcript_digest}`);
        if (res.ok) transcripts.set(r.replay_id, JSON.parse(await res.text()));
        this.renderRun();
      }
    } catch {
      /* the verdict row says what is known */
    }
  }

  private connect() {
    if (typeof EventSource === "undefined") return;
    const es = new EventSource("/live/events");
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
      else if (e.type === "session.started") {
        const mine = (this.opts.agent && e.data?.agent === this.opts.agent) || (this.opts.lineage && e.data?.lineage_id === this.opts.lineage);
        if (mine && !this.opts.session) {
          if (this.want === "auto" && (!this.summary || this.summary.state !== "live" || !this.playing)) void this.load(e.data.session_id, "auto").then(() => this.refreshList());
          else void this.refreshList();
        }
      } else if (/^(candidate|generation|replay|epoch)\./.test(e.type) && (this.summary?.state === "sealed" || this.summary?.state === "live")) later();
    };
  }

  private async refreshList() {
    if (this.opts.session || this.opts.list === false) return;
    const q = this.listQuery();
    try {
      this.others = await get<SessionSummary[]>(`sessions?${q}${q ? "&" : ""}limit=12`);
      this.renderList();
    } catch {
      /* keep */
    }
  }

  // ------------------------------------------------------------------------------------------- playback

  private reset() {
    this.idx = 0;
    this.files.clear();
    this.tabs = [];
    this.active = HOME;
    this.hl = null;
    this.typing = null;
    this.cursorAt = null;
    this.runs = [];
    this.say = null;
    this.search = null;
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

  private async pump(g: number) {
    while (!this.dead && g === this.gen && this.playing && this.idx < this.events.length) {
      const e = this.events[this.idx++]!;
      await this.apply(e, true, g);
      if (g !== this.gen) return;
      this.renderProgress();
      const next = this.events[this.idx];
      // replay keeps the session's rhythm with idle gaps compressed; live catches up when behind
      const backlog = this.events.length - this.idx;
      const gap = next ? Math.min(Math.max(next.at - e.at, 120), 1600) : 0;
      const pace = this.mode === "live" ? (backlog > 20 ? 6 : backlog > 6 ? 2.5 : 1) : this.speed;
      await this.wait(this.mode === "live" ? Math.min(gap, 600) / pace : gap / pace, g);
    }
    if (g !== this.gen || this.dead) return;
    if (this.mode === "replay" && this.idx >= this.events.length) {
      this.playing = false;
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
    if (!this.tabs.includes(path)) this.tabs.push(path);
    return f;
  }

  private async loadFile(f: FileState, allowMissing: boolean) {
    if (f.lines || f.note) return;
    const s = this.summary!;
    const r = await fileAt(s.lineage_id, s.gen_id, f.path);
    if ("error" in r) {
      if (allowMissing && r.error === "not_found") f.lines = [];
      else f.note = r.error === "tree_unavailable" ? "Core has no snapshot mirror for this repository on its host, so it cannot rebuild this file." : r.error === "not_found" ? "This file is not in the parent generation; the agent created it." : r.message;
      if (allowMissing && r.error === "not_found") f.note = null;
      return;
    }
    if (r.text === null) f.note = "This file is generated by the recipe's prepare step; Core holds no bytes for it.";
    else f.lines = r.text.replace(/\n$/, "").split("\n");
  }

  private async apply(e: SEv, animate: boolean, g: number) {
    const anim = animate && !this.reduced;
    const slow = (ms: number) => (animate ? this.wait(ms / (this.mode === "live" ? 1 : this.speed), g) : Promise.resolve());
    if (e.kind !== "search") this.search = null;
    const sayAt = e.at;
    switch (e.kind) {
      case "list":
        this.say = { icon: I.list, at: sayAt, html: `Listed <b>${esc(e.count ?? 0)}</b> files under <b>${esc(e.path === "." ? "the repository root" : e.path)}</b>` };
        if (animate) this.renderSay();
        return;
      case "search":
        this.search = { q: e.query ?? "", m: e.matches };
        this.say = { icon: I.search, at: sayAt, html: `Searched the repository for <b>${esc(e.query)}</b>${e.matches !== undefined ? `, ${esc(e.matches)} matching lines` : ""}` };
        if (animate) (this.renderBar(), this.renderSay(), await slow(500));
        return;
      case "read": {
        const f = this.file(e.path!);
        f.touched++;
        await this.loadFile(f, false);
        if (g !== this.gen) return;
        this.active = f.path;
        this.hl = { path: f.path, start: e.start_line ?? 1, end: e.end_line ?? e.start_line ?? 1, cls: "hl" };
        this.cursorAt = { path: f.path, line: e.start_line ?? 1 };
        this.say = { icon: I.eye, at: sayAt, html: `Reading <b>${esc(e.path)}</b>${range(e) ? `, ${esc(range(e))}` : ""}` };
        if (animate) (this.renderAll(), await slow(700));
        return;
      }
      case "edit":
      case "write":
      case "patch": {
        const f = this.file(e.path!);
        f.touched++;
        await this.loadFile(f, e.kind !== "edit");
        if (g !== this.gen) return;
        this.active = f.path;
        const start = e.start_line ?? 1;
        const label = e.kind === "patch" ? (e.label ?? "Applying a patch") : e.kind === "write" ? "Writing" : "Editing";
        if (e.after === undefined) {
          // sealed: the range is public, the text is not
          const end = e.end_line ?? start;
          f.sealed.push({ start, end });
          this.hl = { path: f.path, start, end, cls: "sealed" };
          this.cursorAt = { path: f.path, line: start };
          this.say = { icon: I.lock, at: sayAt, html: `${esc(label)} <b>${esc(e.path)}</b>${range(e) ? `, ${esc(range(e))}` : ""}. New text sealed until the candidate is final` };
          if (animate) (this.renderAll(), await slow(800));
          return;
        }
        this.say = { icon: I.pen, at: sayAt, html: `${esc(label)} <b>${esc(e.path)}</b>${range(e) ? `, ${esc(range(e))}` : ""}${e.truncated ? " (text truncated by the worker)" : ""}` };
        await this.edit(f, e, anim, animate, g);
        return;
      }
      case "evaluate":
        this.runs.push({ target: e.target ?? "", kind: e.eval_kind ?? null, at: e.at, phases: [], outcome: null, sealed: false, output: null, steps: undefined, done: false });
        this.say = { icon: I.scale, at: sayAt, html: `Measuring the change in the sandbox${e.target ? `, target <b>${esc(e.target)}</b>` : ""}` };
        if (animate) (this.renderRun(), this.renderSay(), await slow(400));
        return;
      case "phase": {
        const r = this.runs.at(-1);
        if (r) r.phases.push({ phase: e.phase!, at: e.at });
        this.say = { icon: I.scale, at: sayAt, html: `Sandbox: <b>${esc(e.phase)}</b>` };
        if (animate) (this.renderRun(), this.renderSay(), await slow(250));
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
        this.say = { icon: I.scale, at: sayAt, html: e.sealed ? "Sandbox run finished. Its output is sealed until the candidate is final" : `Sandbox run finished: <b>${esc(e.outcome ?? "done")}</b>` };
        if (animate) (this.renderRun(), this.renderSay(), await slow(500));
        return;
      }
      case "note":
        if (e.text) {
          this.say = { icon: I.chat, at: sayAt, html: `<q>${esc(e.text.replace(/\s+/g, " ").slice(0, 400))}</q>` };
          if (animate) (this.renderSay(), await slow(Math.min(2200, 500 + e.text.length * 8)));
        }
        return;
      case "submit":
        this.say = { icon: I.check, at: sayAt, html: `Submitted the change as a candidate${e.reason ? `: <q>${esc(e.reason.slice(0, 300))}</q>` : ""}` };
        if (animate) this.renderSay();
        return;
      case "give_up":
        this.say = { icon: I.x, at: sayAt, html: `Stopped without submitting${e.reason ? `: <q>${esc(e.reason.slice(0, 300))}</q>` : ""}` };
        if (animate) this.renderSay();
        return;
    }
  }

  /** Applies an open edit to the file, typing the new text in when animating. */
  private async edit(f: FileState, e: SEv, anim: boolean, animate: boolean, g: number) {
    if (!f.lines) f.lines = f.note ? null : [];
    if (!f.lines) {
      this.cursorAt = { path: f.path, line: e.start_line ?? 1 };
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
      this.hl = { path: f.path, start: at, end: at + Math.max(oldCount, 1) - 1, cls: "del" };
      this.cursorAt = { path: f.path, line: at };
      this.renderAll();
      await this.wait(oldCount ? 420 / (this.mode === "live" ? 1 : this.speed) : 120, g);
      if (g !== this.gen) return;
      this.hl = null;
      // type the new text in, in chunks, at most about 2.4 s per edit at 1x
      const total = after.length;
      const frames = Math.max(1, Math.min(60, Math.ceil(total / 3)));
      for (let k = 1; k <= frames; k++) {
        const n = Math.round((total * k) / frames);
        this.typing = { path: f.path, at, lines: (prefix + after.slice(0, n)).split("\n"), oldCount };
        this.cursorAt = { path: f.path, line: at + this.typing.lines.length - 1, caret: true };
        this.renderCode();
        await this.wait(Math.min(40, 2400 / frames) / (this.mode === "live" ? 1 : this.speed), g);
        if (g !== this.gen) return;
      }
      this.typing = null;
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
    this.cursorAt = { path: f.path, line: Math.max(1, at + pre, at + replaceWith.length - 1 - suf) };
    if (animate) this.renderAll();
  }

  // ------------------------------------------------------------------------------------------- view

  private onClick(ev: Event) {
    const t = ev.target as HTMLElement;
    const tab = t.closest<HTMLElement>("[data-tab]");
    if (tab) {
      this.active = tab.dataset.tab!;
      this.renderTabs();
      this.renderCode();
      this.renderBar();
      return;
    }
    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
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
    const m = this.q(".lp-msg");
    m.hidden = !h;
    m.innerHTML = h ? `<div>${h}</div>` : "";
  }

  private renderAll() {
    this.renderState();
    this.renderTabs();
    this.renderBar();
    this.renderControls();
    this.renderProgress();
    this.renderCode();
    this.renderSay();
    this.renderRun();
  }

  private setState(s: string, text: string) {
    const el = this.q(".lp-state");
    el.dataset.s = s;
    el.querySelector("span")!.textContent = text;
  }

  private renderState() {
    const s = this.summary;
    if (!s) return;
    const live = this.mode === "live" && s.state === "live";
    this.setState(live ? "live" : "replay", live ? "Live" : this.mode === "live" ? (s.state === "sealed" ? "Ended, sealed" : "Ended") : this.playing ? "Replay" : "Paused");
    this.root.dataset.active = live || this.playing ? "1" : "0";
    const banner = this.q(".lp-banner");
    let text = "";
    if (this.unsealedNote) text = s.state === "final" ? "The candidate is final, so its edits are public. Replaying the session with them." : "The attempt ended without a candidate, so its edits are public. Replaying the session with them.";
    else if (!s.open && s.state === "sealed") text = "This session committed a candidate that is still being replayed. Its edits stay sealed until the verdict.";
    else if (!s.open && s.state === "live") text = "Live: reads, searches, edited line ranges and sandbox phases show as they happen. Edit text is sealed until the attempt's candidate is final.";
    banner.hidden = !text;
    banner.querySelector("span")!.textContent = text;
  }

  private renderTabs() {
    const s = this.summary;
    const row = this.q(".lp-tabrow");
    const tab = (id: string, label: string, icon: string, extra = "") =>
      `<button type="button" class="lp-tab" role="tab" data-tab="${esc(id)}" aria-selected="${this.active === id}" title="${esc(id === HOME ? repoLabel(s?.repo ?? null) : id)}">${icon}<span class="n">${esc(label)}</span>${extra}</button>`;
    row.innerHTML =
      tab(HOME, s ? `${repoLabel(s.repo).split("/").pop()} @ gen ${s.height ?? "?"}` : "repository", I.branch) +
      this.tabs
        .map((p) => {
          const f = this.files.get(p)!;
          const mark = f.sealed.length ? `<span style="color:var(--lp-o-ink);display:inline-flex">${I.lock}</span>` : f.edited.size ? '<span class="dot" title="edited"></span>' : "";
          return tab(p, base(p), I.file, mark);
        })
        .join("");
    row.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  private renderBar() {
    const s = this.summary;
    const addr = this.q(".lp-addr .p");
    const rng = this.q(".lp-addr .rng");
    const repo = repoLabel(s?.repo ?? null);
    if (this.active === HOME) {
      addr.innerHTML = `<b>${esc(repo)}</b> <span>lineage/${esc(s?.recipe_name ?? "")}</span>`;
      rng.textContent = "";
    } else {
      addr.innerHTML = `${esc(repo)} / <b>${esc(this.active)}</b>`;
      const h = this.hl && this.hl.path === this.active ? this.hl : null;
      rng.textContent = h ? (h.end > h.start ? `${h.start} to ${h.end}` : `${h.start}`) : "";
    }
    const find = this.q(".lp-find");
    find.dataset.on = this.search ? "1" : "0";
    if (this.search) {
      find.querySelector(".q")!.textContent = this.search.q;
      find.querySelector(".m")!.textContent = this.search.m !== undefined ? `${this.search.m} lines` : "";
    }
  }

  private renderControls() {
    const ctl = this.q(".lp-ctl");
    const s = this.summary;
    if (!s) {
      ctl.innerHTML = "";
      return;
    }
    if (this.mode === "live") {
      ctl.innerHTML = `<span class="lp-none">${esc(who(s.proposer))}${s.state === "live" ? ", following live" : ""}</span><button type="button" class="lp-btn" data-act="replay">${I.restart} Replay</button>`;
      return;
    }
    const playBtn = this.playing ? `<button type="button" class="lp-btn" data-act="pause" aria-label="Pause">${I.pause}</button>` : `<button type="button" class="lp-btn" data-act="play" aria-label="Play"${this.idx >= this.events.length && this.events.length ? " disabled title=\"At the end; restart to replay\"" : ""}>${I.play}</button>`;
    ctl.innerHTML = `${playBtn}<button type="button" class="lp-btn" data-act="restart" aria-label="Restart">${I.restart}</button><span class="lp-seg" role="group" aria-label="Speed">${SPEEDS.map((x) => `<button type="button" data-speed="${x}" aria-pressed="${x === this.speed}">${x}x</button>`).join("")}</span>${s.state === "live" ? `<button type="button" class="lp-btn" data-act="live">${I.live} Live</button>` : ""}`;
  }

  private renderProgress() {
    const prog = this.q(".lp-prog");
    prog.hidden = this.mode === "live" || !this.events.length;
    const pct = this.events.length ? (this.idx / this.events.length) * 100 : 0;
    prog.querySelector("i")!.style.width = `${pct}%`;
    prog.setAttribute("aria-valuemax", String(this.events.length));
    prog.setAttribute("aria-valuenow", String(this.idx));
    prog.setAttribute("aria-valuetext", `event ${this.idx} of ${this.events.length}`);
  }

  private renderSay() {
    const say = this.q(".lp-say");
    const s = this.summary;
    if (!this.say || !s) {
      say.querySelector(".ic")!.innerHTML = I.eye;
      say.querySelector(".t")!.innerHTML = s ? (this.events.length ? "Starting" : s.state === "live" ? "Waiting for the agent's first tool call" : "This session recorded no events") : "";
      say.querySelector(".tm")!.textContent = "";
      return;
    }
    say.querySelector(".ic")!.innerHTML = this.say.icon;
    say.querySelector(".t")!.innerHTML = this.say.html;
    say.querySelector(".tm")!.textContent = `+${mmss(this.say.at - s.started_at)}`;
  }

  private renderHome() {
    const home = this.q(".lp-home");
    const s = this.summary;
    if (!s || this.active !== HOME) {
      home.hidden = true;
      return;
    }
    home.hidden = false;
    const kv = (k: string, v: string, title = "") => `<div><div class="k">${esc(k)}</div><div class="v"${title ? ` title="${esc(title)}"` : ""}>${v}</div></div>`;
    const files = this.tabs
      .map((p) => {
        const f = this.files.get(p)!;
        const what = f.sealed.length ? `${f.sealed.length} sealed edits` : f.edited.size ? `${f.edited.size} lines changed` : `${f.touched} reads`;
        return `<button type="button" data-tab="${esc(p)}">${I.file}<span class="p">${esc(p)}</span><span class="c">${esc(what)}</span></button>`;
      })
      .join("");
    const agent = s.agent ? `<a class="link" href="/agents/${esc(s.agent)}">${esc(s.agent.slice(0, 6))}...${esc(s.agent.slice(-4))}</a>` : `<span title="Hidden while the session's candidate is open (SPEC 10.7)">withheld</span>`;
    home.innerHTML = `<h3>${esc(who(s.proposer))} on ${esc(s.recipe_name ?? "lineage")}</h3>
      <div class="sub">${esc(s.repo ?? "")} at commit ${esc(s.commit.slice(0, 10))}, generation ${esc(s.height ?? "?")}</div>
      <div class="lp-kv">
        ${kv("Agent", agent)}
        ${kv("Lineage", `<a class="link" href="/lineages/${esc(s.lineage_id)}">${esc(s.recipe_name ?? s.lineage_id.slice(0, 8))}</a>`)}
        ${kv("Parent", `<a class="link" href="/generations/${esc(s.gen_id)}" title="${esc(s.gen_id)}">gen ${esc(s.height ?? "?")}</a>`)}
        ${kv("Started", esc(new Date(s.started_at).toLocaleString()))}
        ${kv("Events", esc(this.events.length))}
        ${kv("Duration", esc(mmss((s.ended_at ?? s.last_at) - s.started_at)))}
      </div>
      ${files ? `<div class="lp-files">${files}</div>` : `<div class="lp-none" style="margin-top:14px">No file opened yet.</div>`}`;
  }

  private renderCode() {
    const home = this.q(".lp-home");
    const code = this.q(".lp-code");
    const box = this.q(".lp-lines");
    const cursor = this.q(".lp-cursor");
    if (!this.summary) return;
    this.message(null);
    if (this.active === HOME) {
      code.hidden = true;
      this.renderHome();
      return;
    }
    home.hidden = true;
    code.hidden = false;
    const f = this.files.get(this.active);
    if (!f) return;
    if (!f.lines) {
      box.innerHTML = "";
      cursor.dataset.on = "0";
      if (f.note) this.message(`<b>${esc(f.path)}</b>: ${esc(f.note)}`);
      else {
        // apply() without animation skips loading; load now and redraw
        void this.loadFile(f, false).then(() => this.active === f.path && this.renderCode());
      }
      return;
    }
    let view = f.lines.map((t, i) => ({ t, n: i + 1, cls: f.edited.has(i + 1) ? "edited" : "", caret: false }));
    for (const r of f.sealed) for (let n = r.start; n <= r.end && n <= view.length; n++) view[n - 1]!.cls = "sealed";
    const ty = this.typing && this.typing.path === f.path ? this.typing : null;
    if (ty) {
      const typed = ty.lines.map((t, i) => ({ t, n: ty.at + i, cls: "typing", caret: i === ty.lines.length - 1 }));
      view = [...view.slice(0, ty.at - 1), ...typed, ...view.slice(ty.at - 1 + ty.oldCount).map((x) => ({ ...x, n: x.n - ty.oldCount + typed.length }))];
    }
    const h = this.hl && this.hl.path === f.path ? this.hl : null;
    const html: string[] = [];
    for (const v of view) {
      const cls = h && v.n >= h.start && v.n <= h.end ? h.cls : v.cls;
      html.push(`<div class="lp-l${cls ? " " + cls : ""}" data-n="${v.n}"><span class="lp-n">${v.n}</span><span class="lp-c">${lineHtml(v.t, v.caret)}</span></div>`);
    }
    if (h && h.cls === "sealed") {
      // a sealed range past the parent's end still gets its label
      for (let n = view.length + 1; n <= Math.min(h.end, view.length + 3); n++) html.push(`<div class="lp-l sealed" data-n="${n}"><span class="lp-n">${n}</span><span class="lp-c"></span></div>`);
    }
    box.innerHTML = html.join("");
    if (h?.cls === "sealed") {
      const first = box.querySelector<HTMLElement>(`[data-n="${h.start}"]`);
      if (first) first.insertAdjacentHTML("beforeend", `<span class="lp-seal">${I.lock} edit sealed until the candidate is final</span>`);
    }
    this.placeCursor();
  }

  private placeCursor() {
    const code = this.q(".lp-code");
    const cursor = this.q(".lp-cursor");
    const c = this.cursorAt;
    const tag = cursor.querySelector(".tag")!;
    tag.textContent = this.summary ? who(this.summary.proposer) : "";
    if (!c || c.path !== this.active) {
      cursor.dataset.on = "0";
      return;
    }
    const line = this.q(".lp-lines").querySelector<HTMLElement>(`[data-n="${c.line}"]`) ?? this.q(".lp-lines").querySelector<HTMLElement>(".lp-l:last-child");
    if (!line) return;
    const caret = c.caret ? line.querySelector<HTMLElement>(".lp-caret") : null;
    const target = caret ?? line.querySelector<HTMLElement>(".lp-c")!;
    const lr = line.getBoundingClientRect();
    const tr = target.getBoundingClientRect();
    const ind = line.querySelector<HTMLElement>(".lp-i")?.getBoundingClientRect().width ?? 0;
    const x = line.offsetLeft + (tr.left - lr.left) + (caret ? 0 : ind) + 2;
    const y = line.offsetTop + 4;
    cursor.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    cursor.dataset.on = "1";
    // keep the line in view, about a third from the top
    const top = line.offsetTop - code.clientHeight / 3;
    if (line.offsetTop < code.scrollTop + 30 || line.offsetTop > code.scrollTop + code.clientHeight - 60) code.scrollTo({ top: Math.max(0, top), behavior: this.reduced || c.caret ? "auto" : "smooth" });
    const left = x - code.clientWidth + 160;
    if (left > code.scrollLeft) code.scrollLeft = left;
    else if (x < code.scrollLeft + 40) code.scrollLeft = Math.max(0, x - 80);
  }

  private renderRun() {
    const box = this.q(".lp-run");
    const s = this.summary;
    if (!s) {
      box.innerHTML = "";
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
          const idx = r.phases.findIndex((x) => x.phase === p);
          const nextAt = r.phases[idx + 1]?.at;
          const t = idx >= 0 && nextAt ? ` ${secs(nextAt - r.phases[idx]!.at)}` : "";
          return `<span data-s="${st}">${st === "done" ? I.check : st === "on" ? "<i></i>" : ""}${p}${esc(t)}</span>`;
        })
        .join("");
      const verdict = r.done
        ? r.sealed
          ? `<span class="lp-none" style="display:inline-flex;gap:4px;align-items:center">${I.lock} output sealed</span>`
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
      `<div class="lp-row"><b class="${cls}">${esc(c.status)}</b>${c.reason ? `<span>${esc(c.reason.replace(/_/g, " "))}</span>` : ""}${ratio ? `<span class="lbl"><span>${esc(ratio)}</span></span>` : ""}<a class="link" href="/candidates/${esc(c.candidate_id ?? c.commit_id)}">candidate</a>${c.gen_id ? `<a class="link" href="/generations/${esc(c.gen_id)}">generation</a>` : ""}</div>`,
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
