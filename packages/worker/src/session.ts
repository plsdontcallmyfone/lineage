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

  /** Where and with which proposer the attempt runs; the session itself opens on the first event. */
  private spec: { w: { lineage_id: string; gen_id: string; commit: string }; proposer: string; desktop?: boolean } | null = null;
  /** Called once Core opened the session (agent desktops, SPEC 17.7: the live stream is served under its id). */
  onOpen: ((id: string) => void) | null = null;

  /**
   * Prepares a session at a lineage generation. It is opened at Core only when the attempt records
   * its first event, so an author with nothing to try (a scripted author past its last patch) leaves
   * no empty sessions behind. Never throws; push() is a no-op when sessions are disabled.
   */
  async start(w: { lineage_id: string; gen_id: string; commit: string }, proposer: string, o: { desktop?: boolean } = {}): Promise<void> {
    if (this.opts.enabled === false) return;
    this.spec = { w, proposer, ...(o.desktop ? { desktop: true } : {}) };
    this.timer = setInterval(() => void this.flush(), this.opts.flushMs ?? 2000);
  }

  private async open(): Promise<boolean> {
    if (this.id) return true;
    if (!this.spec) return false;
    try {
      const r = await this.client.post("/v1/sessions", { ...this.spec.w, proposer: this.spec.proposer, ...(this.spec.desktop ? { desktop: true } : {}) });
      if (r.status >= 300) {
        this.warn(`session not opened: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
        this.spec = null;
        this.queue = [];
        return false;
      }
      this.id = r.body.session_id as string;
      try {
        this.onOpen?.(this.id);
      } catch {
        /* ignore */
      }
      return true;
    } catch (e) {
      this.warn(`session not opened: ${(e as Error).message}`);
      return false;
    }
  }

  /** The attempt runs on a live desktop (SPEC 17.7); said when the session opens at Core. */
  setDesktop(on: boolean): void {
    if (this.spec) this.spec.desktop = on || undefined;
  }

  push(e: SessionEventInput): void {
    if (!this.id && !this.spec) return;
    this.queue.push({ ...e, at: Date.now() });
  }

  async flush(): Promise<void> {
    if (!this.id && !(this.spec && this.queue.length)) return;
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      if (!(await this.open())) return;
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
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
    this.spec = null;
    if (!this.id) return; // nothing was recorded: no session was ever opened
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
