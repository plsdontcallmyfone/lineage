import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CreateOpts, DesktopInstance, ExecResult } from "./backend.ts";
import { liveArgs, parseGeom } from "./layout.ts";
import { tilesOk } from "./e2b.ts";
import { sandboxGone, type E2BApi, type E2BInfo, type E2BSandbox, type SessionHooks } from "./e2b.ts";

// One E2B desktop per agent (owner decision 2026-10-12, docs/plans/AGENT-DESKTOPS.md "one E2B desktop
// per agent"; config desktop_mode "per_agent"). Every bound hosted agent has its own sandbox for its
// whole life, named by the agent id in the sandbox's metadata:
//
//   units_desktop=agent, agent=<agent id>, owner=<this runtime's label>
//
// - made in the background when the agent is bound (the launch never waits on E2B);
// - found again by that metadata after a restart, never made twice (nothing is created before the
//   account's list was read; a second sandbox for one agent is killed);
// - paused when its agent is asleep, or idle for idle_s, or the day's budget is used up, and resumed
//   inside the next attempt's start (E2B: a paused sandbox is not billed and, measured 2026-10-12,
//   does not count toward the sandboxes running at once);
// - its session window (E2B's session length) restarted by a pause and resume between attempts;
// - kept alive by a short timeout this runtime pushes forward, with E2B pausing (not killing) it when
//   the timeout runs out: a runtime that dies leaves nothing running for long and loses nothing;
// - killed when its agent is not bound to this runtime any more.
//
// The live stream is the agent's, not an attempt's (owner decision 2026-10-12, "it should keep running
// all time"): while the desktop runs, its encoder runs, across attempts and between them, and the
// stream is served under a fixed id per agent (streamIdOf: 64 hex, so the existing
// /desktops/<id>/live.m3u8 route and the gate carry it unchanged). An attempt's session id is a second
// name for the same files while the attempt lasts. The files are copied to this host only while an
// attempt runs or someone watches. With the mask on, the geometry guard runs here for the stream's
// whole life; with it off there is nothing to guard.
//
// Only sandboxes with this runtime's own `owner` label are ever listed, paused or killed.

export type AgentDesktopState = "starting" | "running" | "paused" | "none";

/** What a page may say about an agent's desktop: state, the reason in words, since when. */
export interface AgentDesktopView {
  state: AgentDesktopState;
  why: string | null;
  since: number;
  /** the id its live stream is served under (/desktops/<stream>/live.m3u8) while it runs, else null */
  stream: string | null;
}

/**
 * Swarms (docs/plans/SWARMS.md): every seat of a swarm has its own desktop. A desktop is keyed by the
 * agent id for seat 1 (and for every solo agent, as before) and by `<agent>.s<k>` for seat k; a base58
 * id holds no dot. Everything in this file treats the key as opaque.
 */
export const desktopKeyOf = (agent: string, seat: number): string => (seat <= 1 ? agent : `${agent}.s${seat}`);
export function seatOfDesktopKey(key: string): { agent: string; seat: number } {
  const m = /^(.+)\.s(\d{1,2})$/.exec(key);
  return m ? { agent: m[1]!, seat: Number(m[2]) } : { agent: key, seat: 1 };
}

/** The fixed stream id of an agent's own desktop: 64 hex, the shape of a session id, and never one. */
export function streamIdOf(agent: string): string {
  // a swarm's seat k (docs/plans/SWARMS.md 6) adds its number; seat 1 and every solo agent keep the id above
  const s = seatOfDesktopKey(agent);
  return createHash("sha256").update(`units-desktop-stream\n${s.seat > 1 ? `${s.agent}\n${s.seat}` : agent}`).digest("hex");
}

interface Stream {
  id: string;
  /** this host's copy of the stream files */
  dir: string;
  have: Set<string>;
  /** the encoder runs on the desktop */
  on: boolean;
  /** the desktop session is being started afresh: no encoder until it is up */
  hold: boolean;
  ticking: boolean;
  last_tick: number;
  watched_until: number;
  why: string | null;
}

interface Rec {
  sandbox_id: string | null;
  state: AgentDesktopState;
  why: string | null;
  since: number;
  /** the last create or resume: E2B's session window counts from here */
  run_started_at: number | null;
  /** the end of the agent's last attempt on it (or its creation) */
  last_used_at: number;
  /** running time up to here is in the day's spend */
  metered_to: number | null;
  /** when E2B pauses it unless the timeout is pushed forward */
  expires_at: number | null;
  /** since when no bound agent wants it */
  unwanted_since: number | null;
  fails: number;
  retry_at: number;
}

/** The part of the E2B backend the per-agent desktops use (e2b.ts E2BBackend; tests pass it a fake API). */
export interface AgentBackend {
  readonly usdPerS: number;
  unavailable(): string | null;
  api(): Promise<E2BApi>;
  createAgent(o: { metadata: Record<string, string>; timeoutMs: number; allow: string[]; onId?: (id: string) => void }): Promise<E2BSandbox>;
  openSession(o: CreateOpts, hooks: SessionHooks): Promise<DesktopInstance>;
  /** the desktop session with nothing in it: what the screen shows until the first attempt */
  idleSession(sbx: E2BSandbox): Promise<void>;
  run(sbx: E2BSandbox, argv: string[], timeoutMs?: number): Promise<ExecResult>;
  syncStream(sbx: E2BSandbox, host: string, have: Set<string>): Promise<void>;
}

/** Read at every use, so an edited limit applies without a restart of the manager. */
export interface AgentDesktopLimits {
  /** the most desktops running at once */
  e2b_max: number;
  /** the day's E2B budget left to this runtime, USD (with a shared budget: after the peers' spend) */
  desktop_usd_per_day: number;
  /** pause a desktop whose agent has not been in an attempt for this long, s (default 600) */
  idle_s?: number;
  /** E2B's session length on the plan, s */
  session_max_s?: number;
  /** restart the session window (pause, resume) between attempts when less than this is left of it, s (default 1800, at most half the session length) */
  renew_before_s?: number;
  /** the sandbox timeout the runtime pushes forward, s (default 900): E2B pauses the desktop this long after the runtime's last sign of life */
  keepalive_s?: number;
  /** the longest a desktop paused under a running attempt may take to come back, s (default 60); after it the stream ends and the attempt goes on without */
  resume_gap_max_s?: number;
  /** a desktop whose agent is not bound to this runtime is killed after this long, s (default 300) */
  remove_after_s?: number;
  /** creates at once (default 4) */
  start_parallel?: number;
  /** false: an awake agent's desktop is never paused for idleness, however long it waits for its next attempt (default true) */
  idle_pause?: boolean;
  /** the stream's mask and its geometry guard (default true); false: the video as it is, no guard */
  mask?: boolean;
}

export const AGENT_DESKTOP_DEFAULTS = { idle_s: 600, session_max_s: 3600, renew_before_s: 1800, keepalive_s: 900, resume_gap_max_s: 60, remove_after_s: 300, start_parallel: 4 } as const;

export interface AgentInfo {
  agent: string;
  /** in an attempt now */
  working: boolean;
  /** it cannot work now: asleep (vault empty), or its vault cannot pay for an attempt */
  asleep: boolean;
  /** why, in words for its page (default "agent asleep (vault empty)") */
  asleep_why?: string;
}

const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const short = (id: string | null) => (id ? id.slice(0, 6) : "none");
const msg = (e: unknown) => String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 160);

export class AgentDesktops {
  private recs = new Map<string, Rec>();
  private handles = new Map<string, E2BSandbox>();
  private busy = new Set<string>();
  private chains = new Map<string, Promise<unknown>>();
  /** agents with a step requested or in flight */
  private ops = new Map<string, number>();
  private wanted = new Map<string, AgentInfo>();
  /** slots held for an agent's next open */
  private holds = new Map<string, number>();
  private listed = false;
  private listing: Promise<void> | null = null;
  private lastList = 0;
  private listWhy: string | null = null;
  private starting = 0;
  private startQueue: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private streamTimer: ReturnType<typeof setInterval> | null = null;
  private streams = new Map<string, Stream>();
  /** agents whose attempt is opening its session on the desktop right now */
  private opening = new Set<string>();
  private warned = new Set<string>();
  private now: () => number;
  private log: (m: string) => void;
  private file: string;

  constructor(
    private o: {
      root: string;
      /** this runtime's label on its sandboxes */
      owner: string;
      limits: AgentDesktopLimits;
      allow: string[];
      backend: AgentBackend;
      spentToday(): number;
      addSpend(usd: number): void;
      log?: (m: string) => void;
      now?: () => number;
      /** false: no background timer (tests call sync and settle) */
      timers?: boolean;
      /** how long a held slot waits for its open, ms */
      holdMs?: number;
    },
  ) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => {});
    this.file = join(o.root, "agent-desktops.json");
    this.load();
    void this.reconcile();
    if (o.timers !== false) {
      this.timer = setInterval(() => this.maintain(), 30_000);
      (this.timer as { unref?: () => void }).unref?.();
      this.streamTimer = setInterval(() => void this.streamPass(), 1000);
      (this.streamTimer as { unref?: () => void }).unref?.();
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.streamTimer) clearInterval(this.streamTimer);
    this.streamTimer = null;
  }

  // ------------------------------------------------------------------ the agent's live stream

  private get mask() {
    return this.o.limits.mask !== false;
  }

  private streamOf(agent: string): Stream {
    let s = this.streams.get(agent);
    if (!s) {
      const id = streamIdOf(agent);
      s = { id, dir: join(this.o.root, "live", `agent-${id.slice(0, 24)}`), have: new Set(), on: false, hold: false, ticking: false, last_tick: 0, watched_until: 0, why: null };
      this.streams.set(agent, s);
    }
    return s;
  }

  private streamFile(s: Stream) {
    return join(this.o.root, "sessions", `${s.id}.json`);
  }

  /** The stream directories on this host (the pool's sweep leaves them). */
  streamDirs(): string[] {
    return [...this.streams.values()].map((s) => s.dir.split("/").pop()!);
  }

  /** The desktop runs: its stream is served under the agent's stream id from now on. */
  private streamUp(agent: string) {
    const s = this.streamOf(agent);
    try {
      mkdirSync(s.dir, { recursive: true, mode: 0o755 });
      mkdirSync(join(this.o.root, "sessions"), { recursive: true });
      let started = this.now();
      try {
        const j = JSON.parse(readFileSync(this.streamFile(s), "utf8"));
        if (!j.ended_at && typeof j.started_at === "number") started = j.started_at;
      } catch {
        /* first time */
      }
      writeFileSync(this.streamFile(s), JSON.stringify({ dir: s.dir, backend: "e2b", agent, agent_stream: true, started_at: started, ended_at: null }));
    } catch (e) {
      this.once(`streamup:${msg(e)}`, `agent desktops: stream record not written: ${msg(e)}`);
    }
  }

  /** The desktop stops running (paused, removed, gone): the stream ends (410) and this host's copy is dropped. `sbx`: stop the encoder first. */
  private async streamDown(agent: string, why: string, sbx?: E2BSandbox | null) {
    const s = this.streams.get(agent);
    if (!s) return;
    if (sbx && s.on) await this.o.backend.run(sbx, ["desk-stop", "live", "KILL", "2"], 10_000).catch(() => undefined);
    s.on = false;
    s.have.clear();
    try {
      const f = this.streamFile(s);
      if (existsSync(f)) writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), ended_at: this.now(), ended_why: why }));
      rmSync(s.dir, { recursive: true, force: true });
    } catch {
      /* nothing to end */
    }
  }

  /** A viewer asked for a file of the stream in `dir` (serve.ts): keep this host's copy fresh for the next 30 s. */
  watched(dir: string): void {
    for (const s of this.streams.values()) if (s.dir === dir) s.watched_until = this.now() + 30_000;
  }

  /**
   * One pass over the running desktops (every second): keeps each one's encoder running (with the mask
   * on: only while every window is inside its tile, as an attempt's guard did), and copies the stream
   * to this host while an attempt runs on the desktop or someone watches. A desktop that is neither
   * is looked at every 5 s.
   */
  async streamPass(): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const [agent, r] of this.recs) {
      // a create, pause or resume in flight settles first; an attempt's start on windows that stay does not stop the stream
      if (r.state !== "running" || (this.ops.has(agent) && !this.opening.has(agent))) continue;
      const s = this.streamOf(agent);
      const t = this.now();
      const active = this.busy.has(agent) || s.watched_until > t;
      if (s.ticking || s.hold || t - s.last_tick < (active ? 1000 : 5000) - 50) continue;
      const sbx = this.handles.get(agent);
      if (!sbx) {
        // found again after a restart: a handle first (connect only extends the timeout)
        void this.chain(agent, () => this.resume(agent));
        continue;
      }
      s.ticking = true;
      s.last_tick = t;
      jobs.push(this.streamTick(agent, s, sbx, active).catch(() => undefined).finally(() => (s.ticking = false)));
    }
    await Promise.all(jobs);
  }

  private async streamTick(agent: string, s: Stream, sbx: E2BSandbox, active: boolean): Promise<void> {
    const b = this.o.backend;
    // the windows (the mask is by position) and whether the encoder is still there, in one command
    const g = await b.run(sbx, ["sh", "-c", `${this.mask ? "desk-geom; " : ""}echo ---; p=$(cat /tmp/desk/live.pid 2>/dev/null); [ -n "$p" ] && kill -0 "$p" 2>/dev/null && echo alive; test -f /tmp/desk/ready && echo ready`], 8000);
    if (this.handles.get(agent) !== sbx || s.hold || this.recs.get(agent)?.state !== "running") return;
    if (g.code !== 0) return; // not reachable now: the attempt's own recovery, or the next read of the list, settles it
    const [geom = "", rest = ""] = g.stdout.split("---");
    const alive = /\balive\b/.test(rest);
    const ready = /\bready\b/.test(rest);
    let ok = ready;
    let why: string | null = ready ? null : "the desktop session is not up";
    if (ok && this.mask) {
      const wins = parseGeom(geom);
      const missing = ["LineageEditor", "LineageRun"].find((c) => !wins.some((w) => w.cls === c));
      why = missing ? `${missing === "LineageEditor" ? "editor" : "run"} window missing` : tilesOk(wins) ? null : "a window is outside its tile";
      ok = !why;
    }
    if (s.on && !alive) s.on = false;
    if (!ok && (s.on || alive)) {
      await b.run(sbx, ["sh", "-c", "desk-stop live KILL 2; rm -f /tmp/stream/*.tmp"], 10_000);
      s.on = false;
      this.log(`agent desktops: ${agent.slice(0, 6)} blackout (${why}); live stream stopped`);
    } else if (ok && !s.on) {
      // a stale encoder (the desktop was paused under it) goes first
      const r = await b.run(sbx, ["sh", "-c", `desk-stop live KILL 2; mkdir -p /tmp/stream; rm -f /tmp/stream/*; desk-bg live ${liveArgs("/tmp/stream", ":0", this.mask).map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ")}`], 15_000);
      s.on = r.code === 0;
      s.have.clear();
      if (s.why && !why) this.log(`agent desktops: ${agent.slice(0, 6)} live stream back`);
    }
    s.why = why;
    if (s.on && active) {
      mkdirSync(s.dir, { recursive: true, mode: 0o755 });
      await b.syncStream(sbx, s.dir, s.have).catch(() => undefined);
    } else if (!active && s.have.size) {
      // nobody watches: this host's copy would go stale, so it is dropped (a new viewer is told "starting" for a second)
      s.have.clear();
      rmSync(s.dir, { recursive: true, force: true });
    }
  }

  // ------------------------------------------------------------------ settings

  private lim<K extends keyof typeof AGENT_DESKTOP_DEFAULTS>(k: K): number {
    const v = this.o.limits[k];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : AGENT_DESKTOP_DEFAULTS[k];
  }
  private get sessionMs() {
    return Math.max(60, this.lim("session_max_s")) * 1000;
  }
  /** never more than half the window, so a renewed desktop is not due again at once */
  private get renewBeforeMs() {
    return Math.min(this.lim("renew_before_s") * 1000, this.sessionMs / 2);
  }
  private get keepaliveMs() {
    return Math.min(Math.max(60, this.lim("keepalive_s")) * 1000, this.sessionMs);
  }
  private get metadata() {
    return { units_desktop: "agent", owner: this.o.owner };
  }

  // ------------------------------------------------------------------ state file

  private load() {
    try {
      if (!existsSync(this.file)) return;
      const j = JSON.parse(readFileSync(this.file, "utf8")) as { owner?: string; agents?: Record<string, Rec> };
      // another runtime's record (a copied state directory): its sandboxes are not ours
      if (j.owner !== this.o.owner) return;
      for (const [a, r] of Object.entries(j.agents ?? {})) this.recs.set(a, { ...r, state: r.state === "starting" ? "none" : r.state, unwanted_since: null });
    } catch (e) {
      this.log(`agent desktops: record unreadable (${msg(e)}); the account's list decides`);
    }
  }

  private save() {
    this.book();
    try {
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ owner: this.o.owner, agents: Object.fromEntries(this.recs) }, null, 1), { mode: 0o600 });
      renameSync(`${this.file}.tmp`, this.file);
    } catch (e) {
      this.once(`save:${msg(e)}`, `agent desktops: record not written: ${msg(e)}`);
    }
  }

  private once(k: string, m: string) {
    if (this.warned.has(k)) return;
    this.warned.add(k);
    this.log(m);
  }

  private rec(agent: string): Rec {
    let r = this.recs.get(agent);
    if (!r) {
      r = { sandbox_id: null, state: "none", why: "not created yet", since: this.now(), run_started_at: null, last_used_at: this.now(), metered_to: null, expires_at: null, unwanted_since: null, fails: 0, retry_at: 0 };
      this.recs.set(agent, r);
    }
    return r;
  }

  private set(r: Rec, state: AgentDesktopState, why: string | null) {
    if (r.state !== state) r.since = this.now();
    r.state = state;
    r.why = why;
  }

  /** One thing at a time per agent. */
  private chain<T>(agent: string, f: () => Promise<T>): Promise<T> {
    const p = (this.chains.get(agent) ?? Promise.resolve()).catch(() => undefined).then(f);
    // counted from the request to its end, and released before whoever waits on it goes on
    this.ops.set(agent, (this.ops.get(agent) ?? 0) + 1);
    void p
      .finally(() => {
        const n = (this.ops.get(agent) ?? 1) - 1;
        if (n > 0) this.ops.set(agent, n);
        else this.ops.delete(agent);
      })
      .catch(() => undefined);
    const tail = p.catch(() => undefined);
    this.chains.set(agent, tail);
    void tail.then(() => {
      if (this.chains.get(agent) === tail) this.chains.delete(agent);
    });
    return p;
  }

  /** Waits until nothing is in flight (tests, proofs, a clean stop). */
  async settle(): Promise<void> {
    for (;;) {
      const all = [...this.chains.values(), ...(this.listing ? [this.listing] : [])];
      if (!all.length) return;
      await Promise.all(all);
      await Promise.resolve();
    }
  }

  // ------------------------------------------------------------------ spend

  /** Running time since the last count goes into the day's spend. */
  private meter(r: Rec, upTo = this.now()) {
    if (r.metered_to === null) return;
    const s = (upTo - r.metered_to) / 1000;
    if (s > 0) {
      this.unbooked += this.o.backend.usdPerS * s;
      r.metered_to = upTo;
      const t = this.ran.get(r) ?? { seconds: 0, usd: 0 };
      t.seconds += s;
      t.usd += this.o.backend.usdPerS * s;
      this.ran.set(r, t);
    }
  }
  /** running time counted per desktop since it was last taken (takeRun) */
  private ran = new Map<Rec, { seconds: number; usd: number }>();
  /**
   * The running time of one desktop since the last call, and what the desktop service charges for it:
   * the runtime bills a swarm's vault for the screens of its seats past the free ones. Taking it
   * changes nothing in the day's spend above.
   */
  takeRun(key: string): { seconds: number; usd: number } {
    const r = this.recs.get(key);
    if (!r) return { seconds: 0, usd: 0 };
    if (r.state === "running") this.meter(r);
    const t = this.ran.get(r) ?? { seconds: 0, usd: 0 };
    this.ran.delete(r);
    return t;
  }
  /** counted and not yet written to the day's spend (one write per pass, not one per desktop) */
  private unbooked = 0;
  private book() {
    if (this.unbooked > 0) this.o.addSpend(this.unbooked);
    this.unbooked = 0;
  }

  private runningCount(except?: string): number {
    let n = this.starting;
    for (const [a, r] of this.recs) if (a !== except && r.state === "running") n++;
    const t = this.now();
    for (const [a, until] of this.holds) {
      if (until <= t) this.holds.delete(a);
      else if (a !== except && this.recs.get(a)?.state !== "running") n++;
    }
    return n;
  }

  /** Whether one more desktop may run: each running one is counted for one more idle time (the least it runs before it can be paused). */
  private budgetWhy(forAgent: string): string | null {
    const cap = this.o.limits.desktop_usd_per_day;
    const spent = this.o.spentToday() + this.unbooked;
    const ahead = this.o.backend.usdPerS * this.lim("idle_s") * (this.runningCount(forAgent) + 1);
    return spent + ahead <= cap + 1e-9 ? null : `day cap reached (${spent.toFixed(4)} of ${cap} USD, UTC day ${utcDay(this.now())})`;
  }

  private budgetUsedUp(): boolean {
    return this.o.spentToday() + this.unbooked >= this.o.limits.desktop_usd_per_day - 1e-9;
  }

  // ------------------------------------------------------------------ the account's list

  /**
   * Reads this runtime's sandboxes from E2B and makes the record agree with them: each agent's own
   * sandbox is taken back (same id as before a restart), a second one for the same agent is killed,
   * one that is gone is forgotten, one E2B paused meanwhile is marked paused. Nothing is created
   * before the first successful read.
   */
  reconcile(): Promise<void> {
    return (this.listing ??= this.reconcileOnce().finally(() => (this.listing = null)));
  }

  private async reconcileOnce(): Promise<void> {
    const why = this.o.backend.unavailable();
    if (why) {
      this.listWhy = why;
      return;
    }
    let list: E2BInfo[];
    let api: E2BApi;
    try {
      api = await this.o.backend.api();
      list = await api.list(this.metadata);
    } catch (e) {
      this.listWhy = `E2B list not read: ${msg(e)}`;
      this.once(`list:${msg(e)}`, `agent desktops: ${this.listWhy}; no desktop is created until it is`);
      return;
    }
    const first = !this.listed;
    this.lastList = this.now();
    this.listWhy = null;
    const by = new Map<string, E2BInfo[]>();
    for (const i of list) {
      // the query already filtered; checked again here because a kill follows
      if (i.metadata.units_desktop !== "agent" || i.metadata.owner !== this.o.owner || !i.metadata.agent) continue;
      (by.get(i.metadata.agent) ?? by.set(i.metadata.agent, []).get(i.metadata.agent)!).push(i);
    }
    for (const [agent, infos] of by) {
      // an agent in the middle of a create or a resume: its own step settles its record
      if (this.ops.has(agent)) continue;
      const r = this.rec(agent);
      const keep = infos.find((i) => i.sandboxId === r.sandbox_id) ?? infos.slice().sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())[0]!;
      for (const i of infos) {
        if (i === keep) continue;
        const ok = await api.kill(i.sandboxId).catch(() => false);
        this.log(`agent desktops: ${agent.slice(0, 6)} had a second sandbox ${short(i.sandboxId)}; ${ok ? "killed" : "kill failed, tried again at the next read"}`);
      }
      const adopted = r.sandbox_id !== keep.sandboxId;
      if (adopted) this.handles.delete(agent);
      r.sandbox_id = keep.sandboxId;
      if (keep.state === "running") {
        // it ran while this runtime was away (or was never counted): its time since then is spent
        if (r.metered_to === null || adopted) r.metered_to = keep.startedAt.getTime();
        this.meter(r);
        r.run_started_at = keep.startedAt.getTime();
        r.expires_at = keep.endAt.getTime();
        if (r.state !== "running") this.set(r, "running", null);
        this.streamUp(agent);
      } else {
        if (r.state === "running") void this.streamDown(agent, "desktop paused by E2B");
        if (r.state === "running") {
          // E2B paused it (its timeout ran out): it ran until then
          this.meter(r, Math.min(this.now(), r.expires_at ?? r.metered_to ?? this.now()));
          this.log(`agent desktops: ${agent.slice(0, 6)} desktop ${short(keep.sandboxId)} was paused by E2B (its timeout ran out)`);
          this.set(r, "paused", "paused by E2B when its timeout ran out");
        } else if (r.state !== "paused") this.set(r, "paused", "paused");
        r.metered_to = null;
        r.run_started_at = null;
        this.handles.delete(agent);
      }
      if (first || adopted) this.log(`agent desktops: ${agent.slice(0, 6)} has its desktop ${short(keep.sandboxId)} back (${keep.state})`);
    }
    for (const [agent, r] of this.recs) {
      if (!r.sandbox_id || by.has(agent) || this.ops.has(agent)) continue;
      if (r.state === "running") this.meter(r, Math.min(this.now(), r.expires_at ?? this.now()));
      this.log(`agent desktops: ${agent.slice(0, 6)} desktop ${short(r.sandbox_id)} is no longer at E2B`);
      r.sandbox_id = null;
      r.metered_to = null;
      r.run_started_at = null;
      this.handles.delete(agent);
      this.set(r, "none", "its sandbox is no longer at E2B; a new one is made");
      void this.streamDown(agent, "desktop gone");
    }
    this.listed = true;
    this.save();
  }

  // ------------------------------------------------------------------ the runtime's side

  /**
   * The bound agents now (every runtime tick). Never waits on E2B: creates, pauses, renewals and
   * removals run in the background, one at a time per agent.
   */
  sync(agents: AgentInfo[]): void {
    this.wanted = new Map(agents.map((a) => [a.agent, a]));
    for (const a of agents) this.rec(a.agent).unwanted_since = null;
    this.synced = true;
    this.maintain(true);
  }
  private synced = false;

  /**
   * Pushes timeouts forward, counts spend, pauses the idle, renews, starts the missing. A desktop is
   * removed only on the runtime's own word (`fromSync`: the bound agents were just read), never by the
   * timer: a runtime that cannot read its agents for a while removes nothing.
   */
  maintain(fromSync = false): void {
    const t = this.now();
    if (!this.listed || t - this.lastList >= Math.max(60_000, this.keepaliveMs / 3)) void this.reconcile();
    if (!this.listed || !this.synced) return;
    let dirty = false;
    for (const [agent, r] of this.recs) {
      const w = this.wanted.get(agent);
      // a running desktop's time is counted every 10 s at least (and exactly at every pause and removal)
      if (r.state === "running" && r.metered_to !== null && t - r.metered_to >= 10_000) {
        this.meter(r, t);
        dirty = true;
      }
      if (this.ops.has(agent)) continue;
      if (!w) {
        if (!fromSync) continue;
        r.unwanted_since ??= t;
        if (!this.busy.has(agent) && t - r.unwanted_since >= this.lim("remove_after_s") * 1000) void this.chain(agent, () => this.remove(agent, "its agent is not bound to this runtime"));
        else if (r.state === "running" && !this.busy.has(agent)) void this.chain(agent, () => this.pause(agent, "its agent is not bound to this runtime"));
        continue;
      }
      if (r.state === "none") {
        if (t >= r.retry_at) void this.chain(agent, () => this.create(agent));
        continue;
      }
      if (r.state !== "running") continue;
      if (this.busy.has(agent) || w.working) {
        this.keepalive(agent, r);
        continue;
      }
      const why = w.asleep ? (w.asleep_why ?? "agent asleep (vault empty)") : this.budgetUsedUp() ? `day cap reached (${this.o.spentToday().toFixed(4)} of ${this.o.limits.desktop_usd_per_day} USD, UTC day ${utcDay(t)})` : this.o.limits.idle_pause !== false && t - r.last_used_at >= this.lim("idle_s") * 1000 ? "agent idle" : null;
      if (why) void this.chain(agent, () => this.pause(agent, why));
      else if (r.run_started_at !== null && t - r.run_started_at >= this.sessionMs - this.renewBeforeMs) void this.chain(agent, () => this.renew(agent));
      else this.keepalive(agent, r);
    }
    if (dirty) this.save();
  }

  private keepalive(agent: string, r: Rec) {
    const t = this.now();
    if (!r.sandbox_id || (r.expires_at !== null && r.expires_at - t > this.keepaliveMs / 2)) return;
    const id = r.sandbox_id;
    void this.chain(agent, async () => {
      if (r.sandbox_id !== id || r.state !== "running") return;
      try {
        await (await this.o.backend.api()).setTimeout(id, this.keepaliveMs);
        r.expires_at = this.now() + this.keepaliveMs;
        this.save();
      } catch (e) {
        this.once(`keep:${agent}:${msg(e)}`, `agent desktops: ${agent.slice(0, 6)} timeout not pushed forward: ${msg(e)}`);
        if (sandboxGone(e)) void this.reconcile();
      }
    });
  }

  /** At most start_parallel creates at once. */
  private async startSlot<T>(f: () => Promise<T>): Promise<T> {
    while (this.startActive >= Math.max(1, this.lim("start_parallel"))) await new Promise<void>((r) => this.startQueue.push(r));
    this.startActive++;
    try {
      return await f();
    } finally {
      this.startActive--;
      this.startQueue.shift()?.();
    }
  }
  private startActive = 0;

  /** Makes room for one more running desktop: under e2b_max already, or the longest-idle running one is paused. */
  private async room(forAgent: string): Promise<string | null> {
    const max = this.o.limits.e2b_max;
    if (this.runningCount(forAgent) < max) return null;
    let pick: string | null = null;
    for (const [a, r] of this.recs) {
      if (a === forAgent || r.state !== "running" || this.busy.has(a) || this.holds.has(a) || this.ops.has(a)) continue;
      if (!pick || r.last_used_at < this.recs.get(pick)!.last_used_at) pick = a;
    }
    if (pick) {
      const p = pick;
      await this.chain(p, () => this.pause(p, "paused to make room: the limit of desktops running at once was reached"));
      if (this.runningCount(forAgent) < max) return null;
    }
    return `E2B desktop limit reached: ${this.runningCount(forAgent)} of ${max} running`;
  }

  /**
   * Takes one of the e2b_max running slots for `agent` (counted in `starting` until its desktop runs),
   * pausing the longest-idle desktop when none is free. The check and the take happen without a wait
   * between them, so two agents never take the last slot. Returns why not, or null with the slot taken.
   */
  private async takeSlot(agent: string): Promise<string | null> {
    for (;;) {
      const b = this.budgetWhy(agent);
      if (b) return b;
      if (this.runningCount(agent) < this.o.limits.e2b_max) {
        this.starting++;
        return null;
      }
      const full = await this.room(agent);
      if (full) return full;
    }
  }

  private refuse(r: Rec, why: string, state: AgentDesktopState = r.sandbox_id ? "paused" : "none") {
    this.set(r, state, why);
    this.save();
    return why;
  }

  /** The agent's sandbox, made once. Returns why not, or null when it runs. */
  private async create(agent: string): Promise<string | null> {
    const r = this.rec(agent);
    if (r.sandbox_id) return null;
    if (!this.listed) return this.refuse(r, this.listWhy ?? "E2B list not read yet");
    const off = this.o.backend.unavailable();
    if (off) return this.refuse(r, off);
    const no = await this.takeSlot(agent);
    if (no) return this.refuse(r, no);
    this.set(r, "starting", null);
    this.save();
    const t0 = this.now();
    try {
      const sbx = await this.startSlot(() =>
        this.o.backend.createAgent({
          metadata: { ...this.metadata, agent },
          timeoutMs: this.keepaliveMs,
          allow: this.o.allow,
          onId: (id) => {
            // on record before anything else is done to it: a crash from here on finds it by its metadata anyway
            r.sandbox_id = id;
            r.metered_to = this.now();
            this.save();
          },
        }),
      );
      const t = this.now();
      r.sandbox_id = sbx.sandboxId;
      r.run_started_at = r.metered_to ?? t;
      r.metered_to ??= t;
      r.expires_at = (r.run_started_at ?? t) + this.keepaliveMs;
      r.last_used_at = t;
      r.fails = 0;
      r.retry_at = 0;
      this.handles.set(agent, sbx);
      // its screen is live from here on: the desktop session with nothing in it yet
      await this.o.backend.idleSession(sbx).catch((e) => this.log(`agent desktops: ${agent.slice(0, 6)} first desktop session not started (${msg(e)}); the first attempt starts it`));
      this.set(r, "running", null);
      this.streamUp(agent);
      this.log(`agent desktops: ${agent.slice(0, 6)} desktop ${short(sbx.sandboxId)} created in ${((t - t0) / 1000).toFixed(1)} s`);
      return null;
    } catch (e) {
      // what ran before the failure was billed
      if (r.metered_to !== null) this.meter(r);
      r.metered_to = null;
      r.fails++;
      const wait = Math.min(30_000 * 2 ** (r.fails - 1), 15 * 60_000);
      r.retry_at = this.now() + wait;
      // the backend kills a sandbox it could not make ready; one whose kill is not confirmed stays this
      // agent's (never a second one): it is made ready when it is next used
      const left = r.sandbox_id ? await this.o.backend.api().then((a) => a.kill(r.sandbox_id!)).then(() => false, () => true) : false;
      if (left) {
        this.set(r, "paused", `create failed: ${msg(e)}; its sandbox is kept and made ready at the next use`);
        await this.o.backend.api().then((a) => a.pause(r.sandbox_id!)).catch(() => undefined);
      } else {
        r.sandbox_id = null;
        this.set(r, "none", `create failed: ${msg(e)}; next try in ${Math.round(wait / 1000)} s`);
      }
      this.log(`agent desktops: ${agent.slice(0, 6)} desktop not created: ${msg(e)}; ${left ? "its sandbox could not be removed and is kept" : `next try in ${Math.round(wait / 1000)} s`}`);
      return r.why;
    } finally {
      this.starting--;
      this.save();
    }
  }

  private async pause(agent: string, why: string): Promise<boolean> {
    const r = this.recs.get(agent);
    if (!r?.sandbox_id || r.state !== "running" || this.busy.has(agent)) return false;
    const t0 = this.now();
    // the encoder stops cleanly first: a paused encoder would wake into a gap in its own clock
    const h = this.handles.get(agent);
    if (h && this.streams.get(agent)?.on) await this.o.backend.run(h, ["desk-stop", "live", "KILL", "2"], 10_000).catch(() => undefined);
    try {
      await (await this.o.backend.api()).pause(r.sandbox_id);
    } catch (e) {
      const st = this.streams.get(agent);
      if (st) st.on = false; // the next pass starts it again
      // E2B may refuse a pause when its node is busy (503): the desktop keeps running and the next pass tries again
      this.once(`pause:${agent}:${msg(e)}`, `agent desktops: ${agent.slice(0, 6)} not paused (${msg(e)}); tried again at the next pass`);
      if (sandboxGone(e)) void this.reconcile();
      return false;
    }
    this.meter(r);
    r.metered_to = null;
    r.run_started_at = null;
    r.expires_at = null;
    this.handles.delete(agent);
    this.set(r, "paused", why);
    await this.streamDown(agent, `desktop paused: ${why}`);
    this.save();
    this.log(`agent desktops: ${agent.slice(0, 6)} desktop ${short(r.sandbox_id)} paused in ${((this.now() - t0) / 1000).toFixed(1)} s: ${why}`);
    return true;
  }

  /** Resumes a paused desktop. Returns why not, or null when it runs. */
  private async resume(agent: string, o: { checkLimits?: boolean } = {}): Promise<string | null> {
    const r = this.rec(agent);
    if (!r.sandbox_id) return "no sandbox";
    if (r.state === "running" && this.handles.has(agent)) return null;
    const was = r.state;
    let slot = false;
    if (was !== "running" && o.checkLimits !== false) {
      const no = await this.takeSlot(agent);
      if (no) return this.refuse(r, no);
      slot = true;
    }
    const t0 = this.now();
    try {
      const sbx = await (await this.o.backend.api()).connect(r.sandbox_id, { timeoutMs: this.keepaliveMs });
      const t = this.now();
      this.handles.set(agent, sbx);
      if (was !== "running") {
        r.run_started_at = t;
        r.metered_to = t;
        this.log(`agent desktops: ${agent.slice(0, 6)} desktop ${short(r.sandbox_id)} resumed in ${((t - t0) / 1000).toFixed(1)} s`);
      }
      // connect only ever extends the timeout
      r.expires_at = Math.max(r.expires_at ?? 0, t + this.keepaliveMs);
      this.set(r, "running", null);
      const st = this.streamOf(agent);
      if (was !== "running") st.on = false;
      this.streamUp(agent);
      this.save();
      return null;
    } catch (e) {
      if (sandboxGone(e)) {
        this.log(`agent desktops: ${agent.slice(0, 6)} desktop ${short(r.sandbox_id)} is gone (${msg(e)}); a new one is made`);
        r.sandbox_id = null;
        r.metered_to = null;
        r.run_started_at = null;
        this.handles.delete(agent);
        return this.refuse(r, "its sandbox is no longer at E2B; a new one is made", "none");
      }
      return this.refuse(r, `resume failed: ${msg(e)}`);
    } finally {
      if (slot) this.starting--;
    }
  }

  /** Restarts E2B's session window between attempts: pause, then resume (documented and measured: the window counts from the resume). */
  private async renew(agent: string): Promise<boolean> {
    const r = this.recs.get(agent);
    if (!r?.sandbox_id || r.state !== "running" || this.busy.has(agent)) return false;
    const ran = r.run_started_at === null ? null : Math.round((this.now() - r.run_started_at) / 1000);
    const t0 = this.now();
    if (!(await this.pause(agent, "renewing its session window"))) return false;
    // its own slot and budget: it was running a moment ago
    const why = await this.resume(agent, { checkLimits: false });
    if (why) {
      this.log(`agent desktops: ${agent.slice(0, 6)} session window not renewed: ${why}`);
      return false;
    }
    this.log(`agent desktops: ${agent.slice(0, 6)} session window renewed after ${ran ?? "?"} s of ${Math.round(this.sessionMs / 1000)} s; desktop away for ${((this.now() - t0) / 1000).toFixed(1)} s`);
    return true;
  }

  private async remove(agent: string, why: string): Promise<boolean> {
    const r = this.recs.get(agent);
    if (!r || this.busy.has(agent) || this.wanted.has(agent)) return false;
    if (r.sandbox_id) {
      try {
        await (await this.o.backend.api()).kill(r.sandbox_id);
      } catch (e) {
        this.once(`kill:${agent}:${msg(e)}`, `agent desktops: ${agent.slice(0, 6)} desktop ${short(r.sandbox_id)} not removed (${msg(e)}); tried again at the next pass`);
        return false;
      }
      if (r.state === "running") this.meter(r);
      this.log(`agent desktops: ${agent.slice(0, 6)} desktop ${short(r.sandbox_id)} removed: ${why}`);
    }
    await this.streamDown(agent, "desktop removed");
    this.streams.delete(agent);
    this.recs.delete(agent);
    this.handles.delete(agent);
    this.holds.delete(agent);
    this.save();
    return true;
  }

  // ------------------------------------------------------------------ attempts

  /** Before an attempt: null when the agent's desktop runs or can be started now (a slot is held for its open), else why not. */
  ready(agent: string): string | null {
    const r = this.rec(agent);
    if (r.state === "running" || r.state === "starting") return null;
    if (!this.listed) return this.listWhy ?? "E2B list not read yet";
    const off = this.o.backend.unavailable();
    if (off) return off;
    if (r.state === "none" && this.now() < r.retry_at) return r.why ?? "create failed";
    const b = this.budgetWhy(agent);
    if (b) return this.refuse(r, b);
    const max = this.o.limits.e2b_max;
    if (this.runningCount(agent) >= max) {
      const idle = [...this.recs].some(([a, x]) => a !== agent && x.state === "running" && !this.busy.has(a) && !this.holds.has(a));
      if (!idle) return this.refuse(r, `E2B desktop limit reached: ${this.runningCount(agent)} of ${max} running`);
    }
    this.holds.set(agent, this.now() + (this.o.holdMs ?? 120_000));
    return null;
  }

  release(agent: string): void {
    this.holds.delete(agent);
  }

  /**
   * The agent's desktop for one attempt: created if it never was, resumed if paused, its session
   * window renewed if little is left of it, then the session opened on it. null when it cannot run
   * now (the state says why). The returned instance's destroy ends the session and leaves the sandbox.
   */
  open(agent: string, o: CreateOpts): Promise<DesktopInstance | null> {
    return this.chain(agent, async () => {
      if (!this.listed) await this.reconcile();
      const r = this.rec(agent);
      try {
        if (!r.sandbox_id && (await this.create(agent))) return null;
        if ((r.state !== "running" || !this.handles.has(agent)) && (await this.resume(agent))) {
          // gone at E2B: made again, once
          if (r.sandbox_id || (await this.create(agent))) return null;
        }
        if (r.run_started_at !== null && this.now() - r.run_started_at >= this.sessionMs - this.renewBeforeMs) await this.renew(agent);
        const sbx = this.handles.get(agent);
        if (!sbx || r.state !== "running") return null;
        this.busy.add(agent);
        const box = { sbx };
        let lost = false;
        let recovering: Promise<boolean> | null = null;
        try {
          const st = this.streamOf(agent);
          this.opening.add(agent);
          const inst = await this.o.backend.openSession(o, {
            box,
            hostDir: st.dir,
            restarting: async () => {
              st.hold = true;
              if (st.on) await this.o.backend.run(box.sbx, ["desk-stop", "live", "KILL", "2"], 10_000).catch(() => undefined);
              st.on = false;
            },
            recover: (e) => (lost ? Promise.resolve(false) : (recovering ??= this.recover(agent, box, e).then((ok) => ((lost = !ok), (recovering = null), ok)))),
            closed: () => {
              this.busy.delete(agent);
              r.last_used_at = this.now();
              this.save();
            },
          });
          this.opening.delete(agent);
          st.hold = false;
          st.last_tick = 0;
          return { ...inst, lost: () => lost };
        } catch (e) {
          this.opening.delete(agent);
          this.streamOf(agent).hold = false;
          this.busy.delete(agent);
          this.log(`agent desktops: ${agent.slice(0, 6)} session not opened on ${short(r.sandbox_id)}: ${msg(e)}`);
          if (sandboxGone(e)) void this.reconcile();
          return null;
        }
      } finally {
        this.holds.delete(agent);
      }
    });
  }

  /** E2B paused the desktop under a running attempt (its session window ran out): bring it back within the bound, or give it up for this attempt. */
  private async recover(agent: string, box: { sbx: E2BSandbox }, e: unknown): Promise<boolean> {
    const r = this.recs.get(agent);
    if (!r?.sandbox_id) return false;
    const t0 = this.now();
    const bound = this.lim("resume_gap_max_s") * 1000;
    const id = r.sandbox_id;
    const work = (async () => {
      const api = await this.o.backend.api();
      const info = await api.info(id);
      const sbx = await api.connect(id, { timeoutMs: this.keepaliveMs });
      return { info, sbx };
    })();
    const res = await Promise.race([work.then((v) => v, () => null), new Promise<null>((ok) => setTimeout(() => ok(null), bound))]);
    if (!res) {
      this.log(`agent desktops: ${agent.slice(0, 6)} desktop ${short(id)} did not come back within ${Math.round(bound / 1000)} s (${msg(e)}); the attempt goes on without it`);
      void this.reconcile();
      return false;
    }
    const t = this.now();
    box.sbx = res.sbx;
    this.handles.set(agent, res.sbx);
    if (res.info.state === "paused") {
      // it stood still from its expiry to now
      this.meter(r, Math.min(t, r.expires_at ?? t));
      r.metered_to = t;
      r.run_started_at = t;
      // its encoder slept through the pause: the next stream pass starts a fresh one
      this.streamOf(agent).on = false;
      this.streamUp(agent);
      this.log(`agent desktops: ${agent.slice(0, 6)} desktop ${short(id)} was paused by E2B under a running attempt; back after ${((t - t0) / 1000).toFixed(1)} s`);
    }
    r.expires_at = Math.max(r.expires_at ?? 0, t + this.keepaliveMs);
    this.set(r, "running", null);
    this.save();
    return true;
  }

  // ------------------------------------------------------------------ views

  /** The agent's desktop for its pages; null when this runtime has no record of it. */
  view(agent: string): AgentDesktopView | null {
    const r = this.recs.get(agent);
    // a service's own error text stays in the log: the page gets the reason without it
    return r ? { state: r.state, why: r.why ? r.why.replace(/^(create failed|resume failed): .*?(; next try|; its sandbox|$)/, "$1$2") : null, since: r.since, stream: r.state === "running" ? streamIdOf(agent) : null } : null;
  }

  /** The sandbox id of an agent's desktop (proofs and logs; never on a page). */
  sandboxOf(agent: string): string | null {
    return this.recs.get(agent)?.sandbox_id ?? null;
  }

  counts() {
    const c = { running: 0, paused: 0, starting: 0, none: 0 };
    for (const r of this.recs.values()) c[r.state]++;
    return c;
  }
}
