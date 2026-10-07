import { loadavg, freemem } from "node:os";
import { canonicalJson, H, type Capabilities } from "@lineage/protocol";
import type { CoreClient } from "../../core/src/client.ts";

// Live telemetry (SPEC 17.1): heartbeats every heartbeat_s with the real job and phase, and batched
// activity events from the proposers. Telemetry is best effort by design: every call here swallows
// its own errors, so a slow or refusing Core can never fail a replay or an authoring attempt.

export type Job = "replay" | "qualify" | "author" | "idle";
export type Phase = "prepare" | "build" | "test" | "equivalence" | "metrics" | "commit" | "reveal" | "propose";

/** What a proposer reports. Lineage, generation and commit are added by the worker. */
export interface ActivityInput {
  kind: "read" | "search" | "edit" | "evaluate" | "propose" | "submit" | "give_up";
  path?: string;
  start_line?: number;
  end_line?: number;
  query?: string;
  target?: string;
  content_sha256?: string;
}

interface Where {
  lineage_id: string;
  gen_id: string;
  commit: string;
}

interface State {
  job: Job;
  phase: Phase | null;
  replay_id: string | null;
  lineage_id: string | null;
  gen_id: string | null;
  job_started_at: number | null;
  container_started_at: number | null;
}

const IDLE: State = { job: "idle", phase: null, replay_id: null, lineage_id: null, gen_id: null, job_started_at: null, container_started_at: null };

export class Telemetry {
  private state: State = { ...IDLE };
  private queue: (ActivityInput & Where & { at: number })[] = [];
  private timers: ReturnType<typeof setInterval>[] = [];
  private lastBeat = 0;
  private pendingBeat: ReturnType<typeof setTimeout> | null = null;
  private beating: Promise<void> | null = null;
  private flushing: Promise<void> | null = null;
  private lastWarn = new Map<string, number>();
  private capsDigest: string | null = null;
  heartbeatS = 10;
  /** counters for tests and logs */
  readonly sent = { heartbeats: 0, activity: 0, refused: 0, failed: 0 };

  constructor(
    private client: CoreClient,
    private log: (m: string) => void = () => {},
    private opts: { enabled?: boolean; flushMs?: number } = {},
  ) {}

  get enabled() {
    return this.opts.enabled !== false;
  }

  setCapabilities(caps: Capabilities) {
    this.capsDigest = capsDigest(caps);
  }

  /** Reads heartbeat_s from Core and starts the heartbeat and flush timers. */
  async start(): Promise<void> {
    if (!this.enabled || this.timers.length) return;
    try {
      const r = await this.client.get("/v1/config");
      const hb = Number(r.body?.network?.heartbeat_s);
      if (r.status === 200 && Number.isFinite(hb) && hb >= 1) this.heartbeatS = hb;
    } catch (e) {
      this.warn("config", e);
    }
    this.timers.push(setInterval(() => void this.beat(), this.heartbeatS * 1000));
    this.timers.push(setInterval(() => void this.flush(), this.opts.flushMs ?? 2000));
    void this.beat();
  }

  /** Flushes activity and says goodbye with an idle heartbeat, so the wall does not show a stale job. */
  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.pendingBeat) clearTimeout(this.pendingBeat);
    this.pendingBeat = null;
    await this.flush();
    if (!this.enabled) return;
    this.state = { ...IDLE };
    const wait = 1000 - (Date.now() - this.lastBeat);
    if (wait > 0) await Bun.sleep(wait);
    await this.beat();
    if (this.pendingBeat) clearTimeout(this.pendingBeat);
    this.pendingBeat = null;
  }

  // ------------------------------------------------------------------ state

  job(job: Exclude<Job, "idle">, w: { replay_id?: string; lineage_id?: string; gen_id?: string }) {
    this.state = {
      job,
      phase: null,
      replay_id: w.replay_id ?? null,
      lineage_id: job === "author" ? (w.lineage_id ?? null) : null,
      gen_id: job === "author" ? (w.gen_id ?? null) : null,
      job_started_at: Date.now(),
      container_started_at: null,
    };
    this.soon();
  }

  phase(p: Phase, containerStartedAt?: number) {
    if (this.state.job === "idle") return;
    this.state.phase = p;
    this.state.container_started_at = containerStartedAt ?? null;
    this.soon();
  }

  /** A callback for sandbox evaluate()/calibrate() (their onPhase option). */
  readonly onPhase = (p: "prepare" | "build" | "test" | "equivalence" | "metrics", at: number) => this.phase(p, at);

  idle() {
    if (this.state.job === "idle") return;
    this.state = { ...IDLE };
    this.soon();
  }

  /** Queues activity at a lineage generation; sent in batches. */
  activity(w: Where, e: ActivityInput) {
    if (!this.enabled) return;
    this.queue.push({ ...w, ...e, at: Date.now() });
    if (this.queue.length > 2000) this.queue.splice(0, this.queue.length - 2000);
  }

  // ------------------------------------------------------------------ sending

  /** Sends a heartbeat now, or as soon as Core's one-per-second rule allows. */
  private soon() {
    if (!this.enabled || this.pendingBeat) return;
    const wait = Math.max(0, 1100 - (Date.now() - this.lastBeat));
    this.pendingBeat = setTimeout(() => {
      this.pendingBeat = null;
      void this.beat();
    }, wait);
  }

  async beat(): Promise<void> {
    if (!this.enabled) return;
    if (this.beating) return this.beating;
    if (Date.now() - this.lastBeat < 1000) return this.soon();
    this.beating = (async () => {
      const s = this.state;
      const body: Record<string, unknown> = { job: s.job, at: Date.now(), load: hostLoad() };
      if (this.capsDigest) body.caps_digest = this.capsDigest;
      if (s.job !== "idle") {
        if (s.phase) body.phase = s.phase;
        if (s.job_started_at) body.job_started_at = s.job_started_at;
        if (s.container_started_at) body.container_started_at = s.container_started_at;
        if (s.replay_id) body.replay_id = s.replay_id;
        if (s.job === "author") {
          body.lineage_id = s.lineage_id;
          body.gen_id = s.gen_id;
        }
      }
      try {
        this.lastBeat = Date.now();
        const r = await this.client.post("/v1/heartbeat", body);
        if (r.status < 300) this.sent.heartbeats++;
        else if (r.status !== 429) {
          this.sent.failed++;
          this.warn("heartbeat", `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
        }
      } catch (e) {
        this.sent.failed++;
        this.warn("heartbeat", e);
      }
    })();
    try {
      await this.beating;
    } finally {
      this.beating = null;
    }
  }

  async flush(): Promise<void> {
    if (!this.enabled) return;
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      while (this.queue.length) {
        const batch = this.queue.splice(0, 100);
        try {
          const r = await this.client.post("/v1/activity", { events: batch });
          if (r.status < 300) {
            this.sent.activity += r.body.accepted ?? 0;
            this.sent.refused += r.body.refused?.length ?? 0;
            for (const x of r.body.refused ?? []) this.warn(`activity-${x.error}`, `refused ${batch[x.index]?.kind} ${batch[x.index]?.path ?? ""}: ${x.error}`);
          } else {
            this.sent.refused += batch.length;
            this.warn("activity", `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
            // nothing is retried: a refused batch would be refused again, a rate limit means drop
          }
        } catch (e) {
          this.sent.failed += batch.length;
          this.warn("activity", e);
          break;
        }
      }
    })();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }

  /** At most one log line per kind of problem per minute. */
  private warn(what: string, e: unknown) {
    const now = Date.now();
    if (now - (this.lastWarn.get(what) ?? 0) < 60_000) return;
    this.lastWarn.set(what, now);
    this.log(`telemetry ${what}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The digest Core compares with the declared capabilities: H("caps", canonical json). */
export function capsDigest(caps: unknown): string {
  return H("caps", canonicalJson(caps));
}

function hostLoad() {
  const [l1, l5, l15] = loadavg();
  return { load1: l1 ?? 0, load5: l5 ?? 0, load15: l15 ?? 0, mem_free_mb: Math.floor(freemem() / 1024 / 1024) };
}
