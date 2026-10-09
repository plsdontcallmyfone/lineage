import type { CoreClient } from "../../core/src/client.ts";

// Authoring sessions (SPEC 17.3): every tool call of one authoring attempt, recorded for the live
// agent panel. Best effort like the rest of telemetry: a refusing or slow Core never fails an
// attempt. Edit contents, evaluation output and notes are sent too; Core seals them until the
// attempt's candidate is final (or the attempt ended without one) and never puts them in its
// event log.

export interface SessionEventInput {
  kind: "list" | "read" | "search" | "edit" | "write" | "patch" | "evaluate" | "phase" | "result" | "note" | "submit" | "give_up";
  path?: string;
  start_line?: number;
  end_line?: number;
  query?: string;
  matches?: number;
  count?: number;
  phase?: "prepare" | "build" | "test" | "equivalence" | "metrics";
  target?: string;
  label?: string;
  eval_kind?: string;
  content_sha256?: string;
  lines_before?: number;
  lines_after?: number;
  before?: string;
  after?: string;
  output?: string;
  outcome?: string;
  text?: string;
  reason?: string;
  truncated?: boolean;
  steps?: { step: string; side?: string; exit: number; duration_ms: number; timed_out: boolean; tail: string }[];
}

/** Bounds a sealed text field so one event stays under Core's per-event limit. */
export function clip(s: string, max = 40_000): { text: string; truncated: boolean } {
  return s.length <= max ? { text: s, truncated: false } : { text: s.slice(0, max), truncated: true };
}

export class SessionRecorder {
  id: string | null = null;
  private queue: (SessionEventInput & { at: number })[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;
  private warned = false;
  readonly sent = { events: 0, failed: 0 };

  constructor(
    private client: CoreClient,
    private log: (m: string) => void = () => {},
    private opts: { enabled?: boolean; flushMs?: number } = {},
  ) {}

  /** Opens a session at a lineage generation. Never throws; without a session, push() is a no-op. */
  async start(w: { lineage_id: string; gen_id: string; commit: string }, proposer: string): Promise<string | null> {
    if (this.opts.enabled === false) return null;
    try {
      const r = await this.client.post("/v1/sessions", { ...w, proposer });
      if (r.status >= 300) {
        this.warn(`session not opened: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
        return null;
      }
      this.id = r.body.session_id as string;
      this.timer = setInterval(() => void this.flush(), this.opts.flushMs ?? 2000);
      return this.id;
    } catch (e) {
      this.warn(`session not opened: ${(e as Error).message}`);
      return null;
    }
  }

  push(e: SessionEventInput): void {
    if (!this.id) return;
    this.queue.push({ ...e, at: Date.now() });
  }

  async flush(): Promise<void> {
    if (!this.id) return;
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      while (this.queue.length && this.id) {
        const batch = this.queue.splice(0, 100);
        try {
          const r = await this.client.post(`/v1/sessions/${this.id}/events`, { events: batch });
          if (r.status < 300) this.sent.events += batch.length;
          else {
            this.sent.failed += batch.length;
            this.warn(`session events refused: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
          }
        } catch (e) {
          this.sent.failed += batch.length;
          this.warn(`session events: ${(e as Error).message}`);
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

  /** Flushes and ends the session; commit_id names the candidate this attempt committed, if any. */
  async end(commitId: string | null): Promise<void> {
    if (!this.id) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
    try {
      const r = await this.client.post(`/v1/sessions/${this.id}/end`, commitId ? { commit_id: commitId } : {});
      if (r.status >= 300) this.warn(`session end refused: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    } catch (e) {
      this.warn(`session end: ${(e as Error).message}`);
    }
    this.id = null;
  }

  private warn(m: string) {
    if (this.warned) return;
    this.warned = true;
    this.log(`telemetry ${m}`);
  }
}
