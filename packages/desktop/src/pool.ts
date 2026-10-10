import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEventInput } from "../../worker/src/session.ts";
import type { BackendName, DesktopBackend, DesktopInstance } from "./backend.ts";
import { Driver } from "./driver.ts";
import { E2BBackend } from "./e2b.ts";
import { liveArgs, recordArgs, RECORDING_MAX_BYTES, type Rect } from "./layout.ts";
import { LocalBackend } from "./local.ts";
import { noSlotWhy, placementOrder, type Slot } from "./placement.ts";
import { RemoteBackend, type HostConfig } from "./remote.ts";
import { Seal } from "./seal.ts";

// Desktop slots for the hosted runtime (SPEC 17.7): an attempt gets a desktop when a slot is free
// (desktop hosts first, least loaded, each at most its `desktops_max` (remote.ts, placement.ts); then
// our server, `desktops_max`; then E2B, `e2b_max`, while the day's E2B spend stays under
// `desktop_usd_per_day`). With `required` (owner decision 2026-10-10: every working agent has its own
// live desktop) the runtime reserves a slot before an attempt and waits when none is free; without it
// an attempt with no free slot keeps the reconstructed panel. Recordings wait here until
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
  /** desktop hosts (remote.ts), in config order */
  hosts?: HostConfig[];
  /** a JSON file {hosts: HostConfig[]} written by scripts/deploy/desktop-host/register.ts, re-read every minute */
  hosts_file?: string;
  /** every attempt needs a desktop (the runtime reserves one first and waits when none is free) */
  required?: boolean;
  /**
   * Full-quality recordings (SPEC 17.7). Default false (owner direction 2026-10-10: live only):
   * no recorder runs, nothing is held, nothing is published. The live stream and its sealing and
   * redaction are the same either way. true turns the recorder and publishPending back on.
   */
  recordings?: boolean;
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
  readonly backend: BackendName;
  /** one session event, in order, as the toolbox records it (before it writes) */
  event(e: SessionEventInput): void;
  /** Core opened the session: the stream is served under its id */
  sessionOpened(id: string): void;
  /** the attempt ended (after the session ended at Core) */
  end(): Promise<void>;
}

export interface DesktopProvider {
  begin(o: BeginOpts): Promise<DesktopAttempt | null>;
  /** attempts may not run without a desktop (desktop hosts lane) */
  readonly required?: boolean;
  /** holds a free slot for this agent's next begin (HOLD_MS); null when held, else why none is free */
  reserve?(agent: string): string | null;
  /** drops the agent's hold (the attempt did not start) */
  release?(agent: string): void;
}

/** How long a reserved slot waits for its attempt's begin. */
export const HOLD_MS = 120_000;
const HEALTH_EVERY_MS = 15_000;
const HOSTS_EVERY_MS = 60_000;

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
  /** desktop hosts by name (retired ones stay until their desktops ended) */
  readonly hosts = new Map<string, RemoteBackend>();
  /** running desktops per slot key ("local", "e2b", "host:<name>") */
  private used = new Map<string, number>();
  /** slots held for an agent's next begin */
  private holds = new Map<string, { key: string; until: number }>();
  private hostsText = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private hostRun?: ConstructorParameters<typeof RemoteBackend>[0]["run"];
  /** why the last reserve or begin found no slot */
  lastWhy: string | null = null;
  /** USD per second of the E2B desktops running now, each reserved for its full lifetime */
  private reserved = new Map<string, number>();
  private warned = new Set<string>();
  private log: (m: string) => void;

  constructor(
    readonly cfg: DesktopConfig,
    o: {
      log?: (m: string) => void;
      local?: DesktopBackend;
      e2b?: DesktopBackend & { usdPerS: number };
      now?: () => number;
      /** test hook: the ssh runner of every desktop host */
      hostRun?: ConstructorParameters<typeof RemoteBackend>[0]["run"];
      /** false: no background health checks (tests call checkHosts) */
      timers?: boolean;
    } = {},
  ) {
    this.log = o.log ?? (() => {});
    this.now = o.now ?? Date.now;
    for (const d of ["live", "sessions", "recordings"]) mkdirSync(join(cfg.root, d), { recursive: true });
    this.local = o.local ?? new LocalBackend({ root: cfg.root, image: cfg.image, log: this.log });
    this.e2b = o.e2b ?? new E2BBackend({ root: cfg.root, ...(cfg.e2b ?? {}), log: this.log });
    this.hostRun = o.hostRun;
    this.loadHosts();
    if (this.hosts.size || cfg.hosts_file) {
      void this.checkHosts();
      if (o.timers !== false) {
        let n = 0;
        this.timer = setInterval(() => {
          if ((++n * HEALTH_EVERY_MS) % HOSTS_EVERY_MS === 0) this.loadHosts();
          void this.checkHosts();
        }, HEALTH_EVERY_MS);
        (this.timer as { unref?: () => void }).unref?.();
      }
    }
  }

  get required(): boolean {
    return this.cfg.required === true;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // -------------------------------------------------------------------------------------------- hosts

  /** cfg.hosts plus the hosts file; a host whose entry changed or went away is retired (no new desktops). */
  loadHosts(): void {
    let fromFile: HostConfig[] = [];
    if (this.cfg.hosts_file) {
      try {
        fromFile = (JSON.parse(readFileSync(this.cfg.hosts_file, "utf8")) as { hosts?: HostConfig[] }).hosts ?? [];
      } catch (e) {
        if (existsSync(this.cfg.hosts_file)) this.once(`hostsfile:${(e as Error).message}`, `desktops: hosts file unreadable: ${(e as Error).message}`);
      }
    }
    const all = [...(this.cfg.hosts ?? []), ...fromFile].filter(validHost);
    const text = JSON.stringify(all);
    if (text === this.hostsText) return;
    this.hostsText = text;
    const want = new Map(all.map((h) => [h.name, h]));
    for (const [name, b] of this.hosts) {
      const h = want.get(name);
      if (h && JSON.stringify(h) === JSON.stringify(b.host)) continue;
      b.retired = true;
      this.hosts.delete(name);
      this.log(`desktops: host ${name} ${h ? "changed" : "removed"}; its running desktops finish, new ones go elsewhere`);
    }
    for (const h of all) {
      if (this.hosts.has(h.name)) continue;
      this.hosts.set(h.name, new RemoteBackend({ root: this.cfg.root, host: h, image: this.cfg.image, log: this.log, run: this.hostRun, now: this.now }));
      this.log(`desktops: host ${h.name} (${h.address}) added, at most ${h.desktops_max} desktops`);
    }
  }

  /** Health of every desktop host (every 15 s). */
  async checkHosts(): Promise<void> {
    await Promise.all([...this.hosts.values()].map((b) => b.check().catch(() => undefined)));
  }

  /** Every slot with its load and whether it can take a desktop now (holds count as running). */
  slots(): Slot[] {
    const t = this.now();
    for (const [a, h] of this.holds) if (h.until <= t) this.holds.delete(a);
    const held = (key: string) => [...this.holds.values()].filter((h) => h.key === key).length;
    const run = (key: string) => (this.used.get(key) ?? 0) + held(key);
    const out: Slot[] = [];
    for (const [name, b] of this.hosts) out.push({ key: `host:${name}`, kind: "host", running: run(`host:${name}`), max: b.host.desktops_max, why: b.unavailable() });
    out.push({ key: "local", kind: "local", running: run("local"), max: this.cfg.desktops_max, why: this.cfg.desktops_max > 0 ? this.local.unavailable() : "none configured" });
    const e2bWhy = this.cfg.e2b_max > 0 ? this.e2b.unavailable() ?? (this.e2bBudgetOk(held("e2b")) ? null : `day cap reached (${this.spentToday().toFixed(4)} of ${this.cfg.desktop_usd_per_day} USD, UTC day)`) : "none configured";
    out.push({ key: "e2b", kind: "e2b", running: run("e2b"), max: this.cfg.e2b_max, why: e2bWhy });
    return out;
  }

  reserve(agent: string): string | null {
    const t = this.now();
    const h = this.holds.get(agent);
    if (h && h.until > t) return null;
    this.holds.delete(agent);
    const slots = this.slots();
    const s = placementOrder(slots)[0];
    if (!s) return (this.lastWhy = noSlotWhy(slots));
    this.holds.set(agent, { key: s.key, until: t + HOLD_MS });
    this.lastWhy = null;
    return null;
  }

  release(agent: string): void {
    this.holds.delete(agent);
  }

  private use(key: string, d: number) {
    this.used.set(key, Math.max(0, (this.used.get(key) ?? 0) + d));
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
  e2bBudgetOk(held = 0): boolean {
    const life = this.cfg.e2b?.session_max_s ?? 3600;
    const reserved = [...this.reserved.values()].reduce((a, x) => a + x, 0);
    return this.spentToday() + reserved + this.e2b.usdPerS * life * (1 + held) <= this.cfg.desktop_usd_per_day + 1e-9;
  }

  status() {
    return {
      required: this.required,
      hosts: [...this.hosts.values()].map((b) => ({ name: b.host.name, running: this.used.get(`host:${b.host.name}`) ?? 0, max: b.host.desktops_max, up: b.unavailable() === null, why: b.unavailable(), load1: b.health.h?.load1 ?? null })),
      local: { running: this.used.get("local") ?? 0, max: this.cfg.desktops_max },
      e2b: { running: this.used.get("e2b") ?? 0, max: this.cfg.e2b_max, spent_today_usd: this.spentToday(), cap_usd: this.cfg.desktop_usd_per_day },
      waiting_why: this.lastWhy,
    };
  }

  private once(k: string, m: string) {
    if (this.warned.has(k)) return;
    this.warned.add(k);
    this.log(m);
  }

  // -------------------------------------------------------------------------------------------- slots

  async begin(o: BeginOpts): Promise<DesktopAttempt | null> {
    const opts = { tree: o.tree, homeUrl: homeUrl(o.repo, o.commit), allow: this.cfg.allow, label: o.label };
    const held = this.holds.get(o.agent);
    this.holds.delete(o.agent);
    const slots = this.slots();
    for (const s of slots) {
      if (!s.why || s.why === "none configured") continue;
      const m = s.kind === "e2b" && s.why.startsWith("day cap") ? `desktops: E2B ${s.why}; no new E2B desktops today` : `desktops: ${s.kind === "e2b" ? "E2B" : s.kind} backend unavailable: ${s.why}`;
      this.once(`${s.key}:${s.why.startsWith("day cap") ? `cap:${utcDay(this.now())}` : s.why}`, m);
    }
    const order = placementOrder(slots);
    // the held slot first when it is still free
    const i = held ? order.findIndex((s) => s.key === held.key) : -1;
    if (i > 0) order.unshift(...order.splice(i, 1));
    for (const s of order) {
      const a = s.kind === "e2b" ? await this.startE2B(opts, o) : await this.start(s.key, s.kind === "local" ? this.local : this.hosts.get(s.key.slice(5)), opts, o);
      if (a) {
        this.lastWhy = null;
        return a;
      }
    }
    this.lastWhy = order.length ? "every free slot failed to start a desktop" : noSlotWhy(this.slots());
    return null;
  }

  private async start(key: string, b: DesktopBackend | undefined, opts: Parameters<DesktopBackend["create"]>[0], o: BeginOpts): Promise<DesktopAttempt | null> {
    if (!b) return null;
    this.use(key, 1);
    try {
      const inst = await b.create(opts);
      return this.attempt(inst, o, () => this.use(key, -1));
    } catch (e) {
      this.use(key, -1);
      this.log(`desktops: ${key} desktop failed to start: ${(e as Error).message}`);
      return null;
    }
  }

  private async startE2B(opts: Parameters<DesktopBackend["create"]>[0], o: BeginOpts): Promise<DesktopAttempt | null> {
    if (!this.e2bBudgetOk()) return null;
    this.use("e2b", 1);
    const key = `${o.label}:${this.now()}`;
    this.reserved.set(key, this.e2b.usdPerS * (this.cfg.e2b?.session_max_s ?? 3600));
    const started = this.now();
    try {
      const inst = await this.e2b.create(opts);
      return this.attempt(inst, o, () => {
        this.use("e2b", -1);
        this.reserved.delete(key);
      }, started);
    } catch (e) {
      // a sandbox that was created and then failed to come up still ran (and billed) until it was killed
      this.addSpend(this.e2b.usdPerS * ((this.now() - started) / 1000));
      this.use("e2b", -1);
      this.reserved.delete(key);
      this.log(`desktops: E2B desktop failed to start: ${(e as Error).message}`);
      return null;
    }
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

  /** Whether this pool records and publishes recordings (cfg.recordings, default false). */
  get recording(): boolean {
    return this.cfg.recordings === true;
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
    // recordings off: nothing is uploaded or linked; anything held from before stays on disk
    if (!this.recording) return { published, held: this.pending().length };
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
  readonly backend: BackendName;
  private seal: Seal;
  private driver: Driver;
  private session: string | null = null;
  private liveOn = false;
  /** the full-quality recorder runs for this attempt (pool.recording at start) */
  private recording: boolean;
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
    this.recording = pool.recording;
    if (this.recording) void inst.exec(["desk-bg", "rec", ...recordArgs("/tmp/desk/rec.mp4")]).then((r) => r.code !== 0 && log(`desktop: recording did not start: ${r.stderr.slice(0, 160)}`));
    else this.seal.recording = "none";
    this.guard = setInterval(() => void this.tick(), GUARD_MS);
    void this.tick();
    log(`desktop ${inst.backend} ${inst.id} up for ${o.agent.slice(0, 6)}`);
  }

  get stats() {
    return { ...this.driver.done, phase: this.seal.phase, why: this.seal.why };
  }

  /** The geometry guard, the live encoder that follows it, and (E2B) the stream copy. */
  private async tick() {
    if (this.guarding || this.seal.phase === "ended" || this.lost) return;
    this.guarding = true;
    try {
      if (this.inst.lost?.()) return this.hostLost();
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

  /** Set once the desktop's host went away: the live stream ended, the attempt goes on without it. */
  private lost = false;

  /** The desktop host went away mid-attempt: end the live stream cleanly (the gate answers 410). */
  private hostLost() {
    this.lost = true;
    this.liveOn = false;
    if (this.guard) clearInterval(this.guard);
    this.guard = null;
    this.driver.stop();
    if (this.session) {
      try {
        const f = this.pool.sessionFile(this.session);
        writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), ended_at: this.now(), ended_why: "desktop host lost" }));
      } catch {
        /* ignore */
      }
    }
    this.log(`desktop ${this.inst.id}: host ${this.inst.host ?? "?"} lost; live stream ended, the attempt continues without its desktop`);
  }

  event(e: SessionEventInput): void {
    if (this.lost) return;
    try {
      this.driver.enqueue(this.seal.route(e));
    } catch (err) {
      this.log(`desktop: event ${e.kind}: ${(err as Error).message}`);
    }
  }

  sessionOpened(id: string): void {
    if (!/^[0-9a-f]{64}$/.test(id)) return;
    this.session = id;
    writeFileSync(this.pool.sessionFile(id), JSON.stringify({ dir: this.inst.hostStreamDir, backend: this.inst.backend, ...(this.inst.host ? { host: this.inst.host } : {}), agent: this.o.agent, started_at: this.now(), ended_at: null }));
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
      if (!this.recording) return;
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

function validHost(h: HostConfig): boolean {
  return (
    !!h &&
    typeof h.name === "string" && /^[a-z0-9-]{1,32}$/.test(h.name) &&
    typeof h.address === "string" && /^[A-Za-z0-9.:-]{1,253}$/.test(h.address) &&
    typeof h.key === "string" && typeof h.known_hosts === "string" &&
    Number.isInteger(h.desktops_max) && h.desktops_max >= 0 && h.desktops_max <= 32
  );
}
