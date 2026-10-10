import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEventInput } from "../../worker/src/session.ts";
import type { DesktopBackend, DesktopInstance } from "./backend.ts";
import { Driver } from "./driver.ts";
import { E2BBackend } from "./e2b.ts";
import { liveArgs, recordArgs, RECORDING_MAX_BYTES, type Rect } from "./layout.ts";
import { LocalBackend } from "./local.ts";
import { Seal } from "./seal.ts";

// Desktop slots for the hosted runtime (SPEC 17.7): an attempt gets a desktop when a slot is free
// (our server first, `desktops_max`; then E2B, `e2b_max`, while the day's E2B spend stays under
// `desktop_usd_per_day`), otherwise it keeps the reconstructed panel. Recordings wait here until
// Core's gate opens and are then published to Core's blob store (publishPending).

export interface DesktopConfig {
  /** state: live streams, the session map, held recordings, the E2B spend record */
  root: string;
  desktops_max: number;
  e2b_max: number;
  desktop_usd_per_day: number;
  /** hosts a desktop's browser may reach */
  allow: string[];
  image?: string;
  e2b?: { template?: string; vcpu?: number; ram_gib?: number; session_max_s?: number; key?: string | null };
}

export interface BeginOpts {
  agent: string;
  tree: string;
  repo: string | null;
  commit: string;
  /** the attempt builds on its own pending candidate (SPEC 12.4) */
  stacked: boolean;
  label: string;
}

export interface DesktopAttempt {
  readonly backend: "local" | "e2b";
  /** one session event, in order, as the toolbox records it (before it writes) */
  event(e: SessionEventInput): void;
  /** Core opened the session: the stream is served under its id */
  sessionOpened(id: string): void;
  /** the attempt ended (after the session ended at Core) */
  end(): Promise<void>;
}

export interface DesktopProvider {
  begin(o: BeginOpts): Promise<DesktopAttempt | null>;
}

export interface PendingRecording {
  session_id: string;
  agent: string;
  file: string;
  bytes: number;
  held_at: number;
}

const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

export function parseGeom(text: string): { cls: string; rect: Rect }[] {
  const out: { cls: string; rect: Rect }[] = [];
  for (const l of text.split("\n")) {
    const m = /^(\w+) (-?\d+) (-?\d+) (\d+) (\d+)$/.exec(l.trim());
    if (m) out.push({ cls: m[1]!, rect: { x: +m[2]!, y: +m[3]!, w: +m[4]!, h: +m[5]! } });
  }
  return out;
}

export class DesktopPool implements DesktopProvider {
  readonly local: DesktopBackend;
  readonly e2b: DesktopBackend & { usdPerS: number };
  private inUse = { local: 0, e2b: 0 };
  /** USD per second of the E2B desktops running now, each reserved for its full lifetime */
  private reserved = new Map<string, number>();
  private warned = new Set<string>();
  private log: (m: string) => void;

  constructor(
    readonly cfg: DesktopConfig,
    o: { log?: (m: string) => void; local?: DesktopBackend; e2b?: DesktopBackend & { usdPerS: number }; now?: () => number } = {},
  ) {
    this.log = o.log ?? (() => {});
    this.now = o.now ?? Date.now;
    for (const d of ["live", "sessions", "recordings"]) mkdirSync(join(cfg.root, d), { recursive: true });
    this.local = o.local ?? new LocalBackend({ root: cfg.root, image: cfg.image, log: this.log });
    this.e2b = o.e2b ?? new E2BBackend({ root: cfg.root, ...(cfg.e2b ?? {}), log: this.log });
  }
  private now: () => number;

  // -------------------------------------------------------------------------------------------- spend

  private spendFile() {
    return join(this.cfg.root, "e2b-spend.json");
  }

  /** E2B USD spent today (UTC), from the record (a record of another day reads as 0). */
  spentToday(): number {
    try {
      const j = JSON.parse(readFileSync(this.spendFile(), "utf8")) as { day: string; usd: number };
      return j.day === utcDay(this.now()) && Number.isFinite(j.usd) ? j.usd : 0;
    } catch {
      return 0;
    }
  }

  private addSpend(usd: number) {
    const day = utcDay(this.now());
    const usdNow = this.spentToday() + usd;
    writeFileSync(this.spendFile() + ".tmp", JSON.stringify({ day, usd: usdNow, rates: "e2b.ts E2B_RATES" }));
    renameSync(this.spendFile() + ".tmp", this.spendFile());
  }

  /** Whether one more E2B desktop fits under the day's cap, counting each running one at its full lifetime. */
  e2bBudgetOk(): boolean {
    const life = this.cfg.e2b?.session_max_s ?? 3600;
    const reserved = [...this.reserved.values()].reduce((a, x) => a + x, 0);
    return this.spentToday() + reserved + this.e2b.usdPerS * life <= this.cfg.desktop_usd_per_day + 1e-9;
  }

  status() {
    return { local: { running: this.inUse.local, max: this.cfg.desktops_max }, e2b: { running: this.inUse.e2b, max: this.cfg.e2b_max, spent_today_usd: this.spentToday(), cap_usd: this.cfg.desktop_usd_per_day } };
  }

  private once(k: string, m: string) {
    if (this.warned.has(k)) return;
    this.warned.add(k);
    this.log(m);
  }

  // -------------------------------------------------------------------------------------------- slots

  async begin(o: BeginOpts): Promise<DesktopAttempt | null> {
    const opts = { tree: o.tree, homeUrl: homeUrl(o.repo, o.commit), allow: this.cfg.allow, label: o.label };
    if (this.inUse.local < this.cfg.desktops_max) {
      const why = this.local.unavailable();
      if (why) this.once(`local:${why}`, `desktops: local backend unavailable: ${why}`);
      else {
        this.inUse.local++;
        try {
          const inst = await this.local.create(opts);
          return this.attempt(inst, o, () => this.inUse.local--);
        } catch (e) {
          this.inUse.local--;
          this.log(`desktops: local desktop failed to start: ${(e as Error).message}`);
        }
      }
    }
    if (this.inUse.e2b < this.cfg.e2b_max) {
      const why = this.e2b.unavailable();
      if (why) this.once(`e2b:${why}`, `desktops: E2B backend unavailable: ${why}`);
      else if (!this.e2bBudgetOk()) this.once(`e2b:cap:${utcDay(this.now())}`, `desktops: E2B day cap reached (${this.spentToday().toFixed(4)} of ${this.cfg.desktop_usd_per_day} USD, UTC day); no new E2B desktops today`);
      else {
        this.inUse.e2b++;
        const key = `${o.label}:${this.now()}`;
        this.reserved.set(key, this.e2b.usdPerS * (this.cfg.e2b?.session_max_s ?? 3600));
        const started = this.now();
        try {
          const inst = await this.e2b.create(opts);
          return this.attempt(inst, o, () => {
            this.inUse.e2b--;
            this.reserved.delete(key);
          }, started);
        } catch (e) {
          // a sandbox that was created and then failed to come up still ran (and billed) until it was killed
          this.addSpend(this.e2b.usdPerS * ((this.now() - started) / 1000));
          this.inUse.e2b--;
          this.reserved.delete(key);
          this.log(`desktops: E2B desktop failed to start: ${(e as Error).message}`);
        }
      }
    }
    return null;
  }

  private attempt(inst: DesktopInstance, o: BeginOpts, release: () => void, started = this.now()): DesktopAttempt {
    return new Attempt(this, inst, o, release, this.log, this.now, started);
  }

  /** E2B time is metered per second of a desktop's life (create to destroy). */
  meter(inst: DesktopInstance, seconds: number) {
    if (inst.usdPerS > 0) this.addSpend(inst.usdPerS * Math.max(0, seconds));
  }

  // ---------------------------------------------------------------------------------------- sessions

  sessionFile(id: string) {
    return join(this.cfg.root, "sessions", `${id}.json`);
  }

  // -------------------------------------------------------------------------------------- recordings

  private pendingFile() {
    return join(this.cfg.root, "recordings", "pending.json");
  }

  pending(): PendingRecording[] {
    try {
      return JSON.parse(readFileSync(this.pendingFile(), "utf8"));
    } catch {
      return [];
    }
  }

  private savePending(p: PendingRecording[]) {
    writeFileSync(this.pendingFile() + ".tmp", JSON.stringify(p, null, 2), { mode: 0o600 });
    renameSync(this.pendingFile() + ".tmp", this.pendingFile());
  }

  hold(r: PendingRecording) {
    this.savePending([...this.pending().filter((x) => x.session_id !== r.session_id), r]);
  }

  /**
   * Publishes held recordings whose session gate is open (SPEC 17.3): the blob first, then the
   * session's recording link, both signed by the session's agent. A recording stays held while the
   * candidate is open, however long that takes.
   */
  async publishPending(c: {
    gateState(session: string): Promise<string | null>;
    putBlob(agent: string, sha: string, bytes: Uint8Array): Promise<number>;
    link(agent: string, session: string, rec: { sha256: string; bytes: number }): Promise<number>;
  }): Promise<{ published: string[]; held: number }> {
    const published: string[] = [];
    const left: PendingRecording[] = [];
    for (const p of this.pending()) {
      const keep = () => left.push(p);
      if (!existsSync(p.file)) continue;
      const gate = await c.gateState(p.session_id).catch(() => null);
      const seal = new Seal({ stacked: false, repo: null, commit: "" });
      seal.end(true);
      if (!seal.publishable(gate)) {
        keep();
        continue;
      }
      const bytes = new Uint8Array(readFileSync(p.file));
      const sha = createHash("sha256").update(bytes).digest("hex");
      const b = await c.putBlob(p.agent, sha, bytes).catch(() => 0);
      if (b >= 300 || b === 0) {
        this.log(`desktops: recording of ${p.session_id.slice(0, 10)} not uploaded (${b}); retrying later`);
        keep();
        continue;
      }
      const l = await c.link(p.agent, p.session_id, { sha256: sha, bytes: bytes.length }).catch(() => 0);
      if (l >= 300 || l === 0) {
        this.log(`desktops: recording link of ${p.session_id.slice(0, 10)} refused (${l}); retrying later`);
        keep();
        continue;
      }
      rmSync(p.file, { force: true });
      published.push(p.session_id);
      this.log(`desktops: recording of session ${p.session_id.slice(0, 10)} published (${bytes.length} bytes, ${sha.slice(0, 12)})`);
    }
    this.savePending(left);
    return { published, held: left.length };
  }

  /** Removes live stream directories of desktops that are gone (after a crash). */
  sweep(activeIds: Set<string>) {
    const live = join(this.cfg.root, "live");
    for (const d of readdirSync(live)) {
      if (activeIds.has(d)) continue;
      try {
        if (this.now() - statSync(join(live, d)).mtimeMs > 120_000) rmSync(join(live, d), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

export function homeUrl(repo: string | null, commit: string): string {
  const m = repo ? /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(repo) : null;
  return m ? `https://github.com/${m[1]}/${m[2]}/tree/${commit}` : "about:blank";
}

const GUARD_MS = 1000;

class Attempt implements DesktopAttempt {
  readonly backend: "local" | "e2b";
  private seal: Seal;
  private driver: Driver;
  private session: string | null = null;
  private liveOn = false;
  private guard: ReturnType<typeof setInterval> | null = null;
  private guarding = false;
  private ending: Promise<void> | null = null;
  private t0: number;

  constructor(
    private pool: DesktopPool,
    private inst: DesktopInstance,
    private o: BeginOpts,
    private release: () => void,
    private log: (m: string) => void,
    private now: () => number,
    started: number,
  ) {
    this.backend = inst.backend;
    this.t0 = started;
    this.seal = new Seal({ stacked: o.stacked, repo: o.repo, commit: o.commit });
    this.driver = new Driver(inst, this.seal, o.tree, log);
    void inst.exec(["desk-bg", "rec", ...recordArgs("/tmp/desk/rec.mp4")]).then((r) => r.code !== 0 && log(`desktop: recording did not start: ${r.stderr.slice(0, 160)}`));
    this.guard = setInterval(() => void this.tick(), GUARD_MS);
    void this.tick();
    log(`desktop ${inst.backend} ${inst.id} up for ${o.agent.slice(0, 6)}`);
  }

  get stats() {
    return { ...this.driver.done, phase: this.seal.phase, why: this.seal.why };
  }

  /** The geometry guard, the live encoder that follows it, and (E2B) the stream copy. */
  private async tick() {
    if (this.guarding || this.seal.phase === "ended") return;
    this.guarding = true;
    try {
      const g = await this.inst.exec(["desk-geom"], { timeoutMs: 8000 }).catch(() => null);
      const ok = this.seal.geometry(g && g.code === 0 ? parseGeom(g.stdout) : null);
      if (!ok && this.liveOn) {
        this.liveOn = false;
        await this.inst.exec(["desk-stop", "live", "KILL", "2"]);
        await this.inst.exec(["sh", "-c", `rm -f ${this.inst.streamDir}/*.tmp`]);
        this.log(`desktop ${this.inst.id}: blackout (${this.seal.why}); live stream stopped`);
      } else if (ok && !this.liveOn && this.seal.phase === "live") {
        const r = await this.inst.exec(["desk-bg", "live", ...liveArgs(this.inst.streamDir)]);
        this.liveOn = r.code === 0;
      }
      if (this.liveOn) await this.inst.sync().catch(() => undefined);
    } finally {
      this.guarding = false;
    }
  }

  event(e: SessionEventInput): void {
    try {
      this.driver.enqueue(this.seal.route(e));
    } catch (err) {
      this.log(`desktop: event ${e.kind}: ${(err as Error).message}`);
    }
  }

  sessionOpened(id: string): void {
    if (!/^[0-9a-f]{64}$/.test(id)) return;
    this.session = id;
    writeFileSync(this.pool.sessionFile(id), JSON.stringify({ dir: this.inst.hostStreamDir, backend: this.inst.backend, agent: this.o.agent, started_at: this.now(), ended_at: null }));
  }

  end(): Promise<void> {
    return (this.ending ??= this.doEnd());
  }

  private async doEnd(): Promise<void> {
    // let the last few actions show (bounded), then close everything
    await this.driver.idle(8000);
    this.driver.stop();
    const hadLive = this.liveOn;
    this.seal.end(false);
    if (this.guard) clearInterval(this.guard);
    this.liveOn = false;
    try {
      if (hadLive) await this.inst.exec(["desk-stop", "live", "INT", "5"]).catch(() => undefined);
      await this.inst.exec(["desk-stop", "rec", "INT", "30"], { timeoutMs: 40_000 }).catch(() => undefined);
      const bytes = await this.inst.read("/tmp/desk/rec.mp4");
      if (this.session && bytes && bytes.length > 1000 && bytes.length <= RECORDING_MAX_BYTES + 2_000_000) {
        const file = join(this.pool.cfg.root, "recordings", `${this.session}.mp4`);
        writeFileSync(file, bytes, { mode: 0o600 });
        this.seal.recording = "held";
        this.pool.hold({ session_id: this.session, agent: this.o.agent, file, bytes: bytes.length, held_at: this.now() });
        this.log(`desktop ${this.inst.id}: recording held for session ${this.session.slice(0, 10)} (${bytes.length} bytes) until its gate opens`);
      }
    } catch (e) {
      this.log(`desktop ${this.inst.id}: recording not kept: ${(e as Error).message}`);
    } finally {
      if (this.session) {
        try {
          const f = this.pool.sessionFile(this.session);
          const j = JSON.parse(readFileSync(f, "utf8"));
          writeFileSync(f, JSON.stringify({ ...j, ended_at: this.now() }));
        } catch {
          /* ignore */
        }
      }
      await this.inst.destroy();
      this.pool.meter(this.inst, (this.now() - this.t0) / 1000);
      rmSync(this.inst.hostStreamDir, { recursive: true, force: true });
      this.release();
      this.log(`desktop ${this.inst.id} closed (${this.driver.done.actions} actions, ${this.driver.done.refused} refused, ${this.driver.done.dropped} dropped)`);
    }
  }
}
