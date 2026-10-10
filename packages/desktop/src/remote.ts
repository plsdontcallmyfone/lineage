import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { CreateOpts, DesktopBackend, DesktopInstance, ExecResult } from "./backend.ts";
import { playlistFiles, shq } from "./e2b.ts";
import { NETWORK, PROXY, setupDeskNet, spawnRun } from "./local.ts";

// Desktop hosts (owner decision 2026-10-10: every working agent has its own live desktop, on dedicated
// desktop servers we run, E2B as overflow). A desktop host is a plain Linux server with Docker and the
// lineage/desktop image (scripts/deploy/desktop-host/provision.sh). The site drives its Docker over
// ssh: one multiplexed connection per host (ControlMaster), and on the host the key may run only
// lineage-desk-gw (authorized_keys command=), which accepts exactly the docker invocations this file
// sends, so a leaked site key cannot get root on the host through Docker.
//
// Same image, same isolation as local.ts: non-root, read-only root, every capability dropped,
// no-new-privileges, CPU, memory and pid limits, no Docker socket, an internal network whose only way
// out is the host's own allowlist proxy. The differences: the agent's tree is copied into a tmpfs in
// the desktop (the site's tree is not on the host), files the toolbox writes are pushed like E2B's, and
// the live HLS files stay in a tmpfs in the desktop; the site pulls them (sync) into hostStreamDir,
// where the gate serves them exactly like a local desktop's. Viewers only ever reach the site's gate.

export interface HostConfig {
  /** short name for logs and status (a-z, 0-9, -) */
  name: string;
  /** IP or DNS name the site reaches it at */
  address: string;
  port?: number;
  /** ssh user whose authorized_keys runs lineage-desk-gw (provision.sh: lineage-desk) */
  user?: string;
  /** the site's private key for this host (never printed) */
  key: string;
  /** known_hosts file holding the host's key (provision.sh writes it from the host itself) */
  known_hosts: string;
  /** desktops at once (provision.sh: hostCapacity of the measured host) */
  desktops_max: number;
  /** per desktop limits (default as local: 1.5 CPUs, 1536m) */
  cpus?: number;
  memory?: string;
}

export interface HostHealth {
  cpus: number;
  mem_mib: number;
  mem_avail_mib: number;
  load1: number;
  image: string | null;
  docker: boolean;
  desktops: number | null;
  proxy: boolean;
}

type Run = (argv: string[], stdin?: string | Uint8Array, timeoutMs?: number) => Promise<ExecResult & { bytes?: Uint8Array }>;

export interface RemoteOpts {
  /** host directory for live streams on the site: <root>/live/<id> */
  root: string;
  host: HostConfig;
  image?: string;
  log?: (m: string) => void;
  /** test hook: runs an ssh command line (argv[0] is ssh) */
  run?: Run;
  now?: () => number;
}

/** ssh exits 255 when the connection itself failed (the remote command never ran). */
const SSH_FAILED = 255;
/** Health older than this counts as unknown: no new desktops on the host. */
export const HEALTH_STALE_MS = 45_000;
/** A running desktop whose host failed this many calls in a row (or whose host is down) is lost. */
const LOST_AFTER = 3;

export class RemoteBackend implements DesktopBackend {
  readonly name = "host" as const;
  readonly host: HostConfig;
  private image: string;
  private run: Run;
  private now: () => number;
  private log: (m: string) => void;
  health: { at: number; ok: boolean; why: string | null; h: HostHealth | null; failures: number } = { at: 0, ok: false, why: "not checked yet", h: null, failures: 0 };
  /** the first good health check after start removes desktops a previous process left behind */
  private swept = false;
  private checking: Promise<void> | null = null;
  /** set when this host was removed from the config: running desktops finish, no new ones start */
  retired = false;

  constructor(private o: RemoteOpts) {
    this.host = o.host;
    this.image = o.image ?? "lineage/desktop";
    this.run = o.run ?? spawnRun;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => {});
  }

  /** ssh options: our key and known_hosts only, one multiplexed connection, fail fast. */
  sshArgv(cmd: string): string[] {
    const h = this.host;
    return [
      "ssh", "-i", h.key, "-p", String(h.port ?? 22),
      "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${h.known_hosts}`,
      "-o", "ControlMaster=auto", "-o", `ControlPath=${controlDir()}/%C`, "-o", "ControlPersist=120",
      "-o", "ConnectTimeout=5", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=3", "-o", "LogLevel=ERROR",
      `${h.user ?? "lineage-desk"}@${h.address}`, "--", cmd,
    ];
  }

  /** One gateway command on the host (argv quoted for the gateway's shlex). */
  async call(argv: string[], stdin?: string | Uint8Array, timeoutMs = 30_000): Promise<ExecResult & { bytes?: Uint8Array }> {
    return this.run(this.sshArgv(argv.map(shq).join(" ")), stdin, timeoutMs);
  }

  private d = (args: string[], stdin?: string | Uint8Array, timeoutMs?: number) => this.call(["docker", ...args], stdin, timeoutMs);

  /** Health check (pool timer, every 15 s): reachable, Docker answers, image present. */
  check(): Promise<void> {
    return (this.checking ??= this.doCheck().finally(() => (this.checking = null)));
  }

  private async doCheck(): Promise<void> {
    const r = await this.call(["health"], undefined, 20_000).catch((e) => ({ code: SSH_FAILED, stdout: "", stderr: (e as Error).message }));
    let h: HostHealth | null = null;
    try {
      h = r.code === 0 ? (JSON.parse(r.stdout.trim().split("\n").pop()!) as HostHealth) : null;
    } catch {
      h = null;
    }
    const why = !h ? (r.code === SSH_FAILED ? `unreachable (${r.stderr.trim().slice(0, 120) || "ssh failed"})` : `health refused (${r.code}: ${r.stderr.trim().slice(0, 120)})`) : !h.docker ? "docker not answering" : !h.image ? `image ${this.image} not on the host` : null;
    const was = this.health.ok;
    this.health = { at: this.now(), ok: why === null, why, h, failures: why ? this.health.failures + 1 : 0 };
    if (was && why) this.log(`desktops: host ${this.host.name} down: ${why}; new desktops go elsewhere`);
    if (!was && !why) this.log(`desktops: host ${this.host.name} up (${h!.cpus} cpus, ${h!.mem_mib} MiB, load ${h!.load1}, ${h!.desktops} desktops)`);
    if (!why && !this.swept) {
      this.swept = true;
      const s = await this.call(["sweep"]).catch(() => null);
      const n = s && s.code === 0 ? (JSON.parse(s.stdout.trim() || "{}").removed ?? 0) : 0;
      if (n) this.log(`desktops: host ${this.host.name}: removed ${n} desktop(s) left by an earlier runtime`);
    }
  }

  /** Down: the last check failed, or is older than HEALTH_STALE_MS. */
  down(): boolean {
    return !this.health.ok || this.now() - this.health.at > HEALTH_STALE_MS;
  }

  unavailable(): string | null {
    if (this.retired) return `host ${this.host.name} removed from the config`;
    if (!this.health.ok) return `host ${this.host.name}: ${this.health.why}`;
    if (this.now() - this.health.at > HEALTH_STALE_MS) return `host ${this.host.name}: no health check for ${Math.round((this.now() - this.health.at) / 1000)} s`;
    return null;
  }

  private netReady: Promise<void> | null = null;
  private ensureNet(allow: string[]): Promise<void> {
    const p = (this.netReady ?? Promise.resolve()).catch(() => undefined).then(() => setupDeskNet((a) => this.d(a), this.image, allow));
    this.netReady = p;
    return p;
  }

  async create(o: CreateOpts): Promise<DesktopInstance> {
    const why = this.unavailable();
    if (why) throw new Error(why);
    // the tree first: a tree we cannot copy never starts a desktop
    const tar = Bun.spawnSync(["tar", "-C", o.tree, "-czf", "-", "."], { stdout: "pipe", stderr: "ignore" });
    if (tar.exitCode !== 0 || tar.stdout.byteLength > 200 * 1024 * 1024) throw new Error(`host ${this.host.name}: tree not copyable`);
    await this.ensureNet(o.allow);
    const id = randomBytes(8).toString("hex");
    const name = `lineage-desk-${id}`;
    const host = join(this.o.root, "live", id);
    mkdirSync(host, { recursive: true, mode: 0o755 });
    const user = "1000:1000";
    const r = await this.d([
      "run", "-d", "--name", name, "--label", "lineage=1", "--label", "lineage.desktop=1", "--label", `lineage.attempt=${o.label.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 60)}`,
      "--network", NETWORK, "--read-only", "--tmpfs", "/tmp:size=768m", "--shm-size", "256m",
      "--tmpfs", "/work/repo:size=512m,uid=1000,gid=1000,mode=0755", "--tmpfs", "/stream:size=64m,uid=1000,gid=1000,mode=0755",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "768",
      "--cpus", String(this.host.cpus ?? 1.5), "--memory", this.host.memory ?? "1536m",
      "--user", user, "-e", "HOME=/tmp/home", "-e", "DISPLAY=:0",
      "-e", `DESK_PROXY=http://${PROXY}:8888`, "-e", `DESK_HOME_URL=${o.homeUrl}`,
      this.image,
    ]);
    if (r.code !== 0) {
      rmSync(host, { recursive: true, force: true });
      if (r.code === SSH_FAILED) this.health = { ...this.health, ok: false, why: "unreachable", failures: this.health.failures + 1 };
      throw new Error(`host ${this.host.name}: desktop container: ${r.stderr.trim().slice(0, 300)}`);
    }
    let fails = 0;
    const exec = async (argv: string[], x: { stdin?: string | Uint8Array; timeoutMs?: number } = {}) => {
      const res = await this.d(["exec", ...(x.stdin !== undefined ? ["-i"] : []), "-u", user, "-e", "DISPLAY=:0", "-e", "HOME=/tmp/home", name, ...argv], x.stdin, x.timeoutMs ?? 30_000);
      fails = res.code === SSH_FAILED ? fails + 1 : 0;
      return res;
    };
    let gone = false;
    const have = new Set<string>();
    const inst: DesktopInstance = {
      id,
      backend: "host",
      host: this.host.name,
      streamDir: "/stream",
      hostStreamDir: host,
      usdPerS: 0,
      exec,
      read: async (path) => {
        const x = await exec(["cat", "--", path], { timeoutMs: 60_000 });
        return x.code === 0 ? x.bytes ?? new TextEncoder().encode(x.stdout) : null;
      },
      push: async (rel, bytes) => {
        if (rel.split("/").some((p) => p === ".." || p === "") || rel.startsWith("/")) return;
        await exec(["sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "sh", `/work/repo/${rel}`], { stdin: bytes });
      },
      sync: () => pullStream(exec, "/stream", host, have),
      lost: () => fails >= LOST_AFTER || (this.down() && this.health.failures >= 2),
      destroy: async () => {
        if (gone) return;
        gone = true;
        await this.d(["rm", "-f", name]).catch(() => undefined);
      },
    };
    try {
      // the tree into the desktop's tmpfs (with its .git: the navigation terminal searches HEAD)
      const t = await exec(["tar", "-xzf", "-", "-C", "/work/repo"], { stdin: tar.stdout, timeoutMs: 120_000 });
      if (t.code !== 0) throw new Error(`tree copy failed: ${t.stderr.trim().slice(0, 200)}`);
      const t0 = this.now();
      while (this.now() - t0 < 45_000) {
        if ((await exec(["test", "-f", "/tmp/desk/ready"])).code === 0) return inst;
        await Bun.sleep(300);
      }
      throw new Error("desktop did not come up within 45 s");
    } catch (e) {
      await inst.destroy();
      rmSync(host, { recursive: true, force: true });
      throw new Error(`host ${this.host.name}: ${(e as Error).message}`);
    }
  }
}

/**
 * Pulls new live files from a desktop into the site's stream directory: the playlist names what
 * exists; each new segment is written whole (part file, then rename) before the playlist that lists it,
 * and segments the playlist dropped are removed. Same order as the E2B copy.
 */
export async function pullStream(exec: (argv: string[], x?: { timeoutMs?: number }) => Promise<ExecResult & { bytes?: Uint8Array }>, dir: string, host: string, have: Set<string>): Promise<void> {
  const pl = await exec(["cat", `${dir}/live.m3u8`], { timeoutMs: 10_000 });
  if (pl.code !== 0) return;
  const text = pl.stdout;
  const names = playlistFiles(text);
  for (const n of names) {
    if (have.has(n)) continue;
    const b = await exec(["cat", `${dir}/${n}`], { timeoutMs: 15_000 });
    if (b.code !== 0) return; // not there yet; next round
    writeFileSync(join(host, `${n}.part`), b.bytes ?? new TextEncoder().encode(b.stdout));
    renameSync(join(host, `${n}.part`), join(host, n));
    have.add(n);
  }
  writeFileSync(join(host, "live.m3u8.part"), text);
  renameSync(join(host, "live.m3u8.part"), join(host, "live.m3u8"));
  for (const f of readdirSync(host)) if (f.startsWith("seg-") && !names.includes(f)) rmSync(join(host, f), { force: true }), have.delete(f);
}

/** Directory for ssh control sockets (short: a unix socket path is at most 104 bytes on some systems). */
export function controlDir(): string {
  // ssh appends "/<40 hex>" (%C) and a temporary ".<16 chars>" while it binds: keep the base short
  const base = process.env.LINEAGE_DESK_SSH_DIR ?? (tmpdir().length < 30 ? tmpdir() : "/tmp");
  const d = base.length + 24 <= 46 ? join(base, `lineage-desk-ssh-${process.getuid?.() ?? 0}`) : join("/tmp", `ldssh-${process.getuid?.() ?? 0}`);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}
