import type { CoreClient } from "../../core/src/client.ts";
import type { Meter, PlannedTarget } from "./proposers/types.ts";

// Agent learnings (docs/plans/AGENT-LEARNINGS.md 1.1), worker side. Core builds each attempt's episode
// from what it holds (session events, candidate, replays, verdict, journal, provenance). What only the
// worker sees goes into one small report, sent after the session ended: the plan step's target, the
// model usage and USD of the attempt (also when there was no candidate, so no provenance), sandbox
// seconds, the harness, route and model ids, and the worker's own outcome line. It is collected by
// wrapping the attempt's meter: every call passes through unchanged. Core keeps the report sealed and
// labels everything from it as claimed. Best effort: a refusing Core never fails an attempt.

export interface EpisodeReport {
  v: 1;
  planned: { kind: string; target: string | string[]; note: string | null } | null;
  outcome: string | null;
  usage: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; usd: number } | null;
  sandbox_s: number | null;
  models: string[];
  harness: { name: string; version: string; digest: string; provider: string } | null;
  route: { via: string; model: { provider: string; id: string }; upstream: string[] } | null;
}

const clean = (s: string, n: number) => s.replace(/\u2014/g, "-").replace(/[\u0000-\u0008\u000b-\u001f]/g, " ").slice(0, n);

export class EpisodeCapture {
  private planned: EpisodeReport["planned"] = null;
  private outcomes: string[] = [];
  private usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, usd: 0 };
  private metered = false;
  private sandbox = 0;
  private sandboxed = false;
  private models = new Set<string>();
  private harness: EpisodeReport["harness"] = null;
  private route: EpisodeReport["route"] = null;
  private upstream = new Set<string>();

  /** A meter that records what passes through it and forwards every call to `inner` (if any). */
  wrap(inner?: Meter): Meter {
    const safe = (f: () => void) => {
      try {
        f();
      } catch {
        /* recording must never change the attempt */
      }
    };
    return {
      model: (u) => {
        safe(() => {
          this.metered = true;
          for (const k of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"] as const) if (Number.isFinite(u[k])) this.usage[k] += u[k];
          if (Number.isFinite(u.usd)) this.usage.usd += u.usd;
          if (u.model) this.models.add(u.model.slice(0, 100));
        });
        inner?.model(u);
      },
      sandbox: (s) => {
        safe(() => {
          if (Number.isFinite(s) && s >= 0) {
            this.sandbox += s;
            this.sandboxed = true;
          }
        });
        inner?.sandbox(s);
      },
      harness: (h) => {
        safe(() => (this.harness = { name: h.name, version: h.version, digest: h.digest, provider: h.provider }));
        inner?.harness?.(h);
      },
      upstream: (n) => {
        safe(() => this.upstream.add(n.slice(0, 60)));
        inner?.upstream?.(n);
      },
      route: (r) => {
        safe(() => (this.route = { via: r.via, model: { provider: r.model.provider, id: r.model.id }, upstream: [] }));
        inner?.route?.(r);
      },
    };
  }

  plan(p: PlannedTarget | null | undefined): void {
    if (p) this.planned = { kind: p.kind, target: p.target, note: p.note ? clean(p.note, 500) : null };
  }

  outcome(s: string): void {
    this.outcomes.push(s);
  }

  report(): EpisodeReport {
    const round = (x: number) => Math.round(x * 1e6) / 1e6;
    const route = this.route ? { ...this.route, upstream: [...this.upstream].slice(0, 8) } : null;
    return {
      v: 1,
      planned: this.planned,
      outcome: this.outcomes.length ? clean(this.outcomes.join("; "), 400) : null,
      usage: this.metered ? { ...this.usage, usd: round(this.usage.usd) } : null,
      sandbox_s: this.sandboxed ? round(this.sandbox) : null,
      models: [...this.models].slice(0, 8),
      harness: this.harness,
      route,
    };
  }

  /** Sends the report for an ended session. Never throws. */
  async post(client: CoreClient, sessionId: string, log: (m: string) => void): Promise<boolean> {
    try {
      const r = await client.post(`/v1/sessions/${sessionId}/episode`, this.report());
      if (r.status >= 300) {
        log(`episode: report not stored: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
        return false;
      }
      return true;
    } catch (e) {
      log(`episode: report not stored: ${(e as Error).message.slice(0, 200)}`);
      return false;
    }
  }
}
