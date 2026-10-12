import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DesktopPool } from "../../desktop/src/pool.ts";
import type { RuntimeConfig } from "./config.ts";

// Agent desktops in the hosted runtime (SPEC 17.7): the slot pool (our server first, then E2B). The
// stream files for the gate and the recording publisher are in packages/desktop/src/publish.ts.

export { startRecordingPublisher, withDesktops } from "../../desktop/src/publish.ts";

const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * One E2B day budget across several runtimes on one server (config `desktop_shared`): what is left of
 * `cap` for this runtime after the peers' published spend of the UTC day. Each runtime publishes its
 * own spend as <dir>/<name>.json ({ day, usd, at }) and reads the peers' files. A peer's file of
 * another day counts 0. A file that is missing, unreadable, malformed, negative or (strict) published
 * more than stale_s ago: strict leaves no budget (0), otherwise the peer counts 0. What a peer's desktops running
 * right now will cost is not in its file until they end, so the instances together can pass the cap by
 * at most the peers' running E2B desktops times one session lifetime.
 */
export class SharedDesktopBudget {
  private lastWhy = "";
  constructor(
    private s: NonNullable<RuntimeConfig["desktop_shared"]>,
    private cap: number,
    private o: { now?: () => number; log?: (m: string) => void } = {},
  ) {}
  private now() {
    return (this.o.now ?? Date.now)();
  }
  /** Writes this runtime's spend of the UTC day (atomic; world-readable, the directory is not). */
  publish(usd: number): boolean {
    try {
      mkdirSync(this.s.dir, { recursive: true });
      const f = join(this.s.dir, `${this.s.name}.json`);
      writeFileSync(`${f}.tmp`, JSON.stringify({ day: utcDay(this.now()), usd, at: this.now() }), { mode: 0o644 });
      renameSync(`${f}.tmp`, f);
      return true;
    } catch (e) {
      this.note(`cannot publish E2B spend to ${this.s.dir}: ${(e as Error).message}`);
      return false;
    }
  }
  /** The peers' spend today, or null when a peer cannot be counted (strict only). */
  peers(): number | null {
    let sum = 0;
    for (const p of this.s.peers) {
      const f = join(this.s.dir, `${p}.json`);
      try {
        const j = JSON.parse(readFileSync(f, "utf8")) as { day?: unknown; usd?: unknown; at?: unknown };
        if (typeof j.usd !== "number" || !Number.isFinite(j.usd) || j.usd < 0 || typeof j.day !== "string") throw new Error("malformed");
        // the peer's own publish time (it writes every 30 s while it runs)
        if (this.s.strict && !(typeof j.at === "number" && Math.abs(this.now() - j.at) <= (this.s.stale_s ?? 600) * 1000)) throw new Error(`not updated within ${this.s.stale_s ?? 600} s`);
        if (j.day === utcDay(this.now())) sum += j.usd;
      } catch (e) {
        if (!this.s.strict) continue;
        this.note(`shared E2B budget: peer ${p} cannot be counted (${(e as Error).message}); no E2B budget until it can`);
        return null;
      }
    }
    return sum;
  }
  /** This runtime's cap now: the shared cap less the peers' spend today (never below 0). */
  left(): number {
    const p = this.peers();
    if (p === null) return 0;
    this.lastWhy = "";
    return Math.max(0, this.cap - p);
  }
  private note(m: string) {
    if (m !== this.lastWhy) this.o.log?.(m);
    this.lastWhy = m;
  }
}

export function desktopPool(cfg: RuntimeConfig, log: (m: string) => void): DesktopPool | null {
  const local = cfg.desktops_max ?? 0;
  const e2b = cfg.e2b_max ?? 0;
  if (local <= 0 && e2b <= 0 && !cfg.desktop_hosts_file) return null;
  const cap = cfg.desktop_usd_per_day ?? 5;
  const shared = cfg.desktop_shared ? new SharedDesktopBudget(cfg.desktop_shared, cap, { log }) : null;
  let pool: DesktopPool | null = null;
  const dcfg = {
    root: join(cfg.state_dir, "desktops"),
    desktops_max: local,
    e2b_max: e2b,
    desktop_usd_per_day: cap,
    allow: cfg.desktop_allow ?? ["github.com", "githubusercontent.com", "githubassets.com"],
    e2b: cfg.e2b,
    recordings: cfg.recordings === true,
    // desktop hosts lane: hosts first (least loaded), every attempt waits for a desktop unless turned off
    hosts_file: cfg.desktop_hosts_file,
    required: cfg.desktop_required !== false,
  };
  if (shared) {
    // the pool reads its cap at every check: with a shared budget it is what the peers have left of it
    // (this runtime's own spend is published first, so the peers see it at their next check)
    Object.defineProperty(dcfg, "desktop_usd_per_day", {
      enumerable: true,
      get: () => {
        if (pool) shared.publish(pool.spentToday());
        return shared.left();
      },
    });
  }
  pool = new DesktopPool(dcfg, { log });
  if (shared) {
    const p = pool;
    shared.publish(p.spentToday());
    setInterval(() => shared.publish(p.spentToday()), 30_000).unref();
  }
  const s = pool.status();
  log(`desktops: ${pool.hosts.size} desktop host(s) with ${[...pool.hosts.values()].reduce((n, b) => n + b.host.desktops_max, 0)} slots, ${local} on this server${pool.local.unavailable() ? ` (${pool.local.unavailable()})` : ""}, ${e2b} on E2B${pool.e2b.unavailable() ? ` (${pool.e2b.unavailable()})` : ""}; E2B spend today ${s.e2b.spent_today_usd.toFixed(4)} of ${s.e2b.cap_usd} USD${shared ? ` left of the ${cap} USD shared with ${cfg.desktop_shared!.peers.join(", ")}` : ""}; recordings ${pool.recording ? "on" : "off (live only)"}; desktop ${pool.required ? "required for every attempt" : "optional"}`);
  return pool;
}
