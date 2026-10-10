import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { CreateOpts, DesktopBackend, DesktopInstance, ExecResult } from "./backend.ts";

// Our own server's desktops: one lineage/desktop container per attempt (images/desktop).
//
// Isolation: the host's uid (never root), read-only root filesystem with a private /tmp, every
// capability dropped, no-new-privileges, CPU, memory and pid limits, no Docker socket, the agent's
// tree read only. The only network is `lineage-desk`, an internal Docker network with no route out;
// Chromium reaches the allowlisted hosts through `lineage-desk-proxy` (tinyproxy from the same image,
// on that network and the default bridge). Everything we create carries the label lineage=1.

export const NETWORK = "lineage-desk";
export const PROXY = "lineage-desk-proxy";

export interface LocalOpts {
  image?: string;
  /** host directory for live streams: <root>/live/<id> */
  root: string;
  docker?: string;
  cpus?: number;
  memory?: string;
  log?: (m: string) => void;
  /** test hook: run a docker command */
  run?: (argv: string[], stdin?: string | Uint8Array, timeoutMs?: number) => Promise<ExecResult & { bytes?: Uint8Array }>;
}

export async function spawnRun(argv: string[], stdin?: string | Uint8Array, timeoutMs = 60_000): Promise<ExecResult & { bytes: Uint8Array }> {
  const p = Bun.spawn(argv, { stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  if (stdin !== undefined) {
    p.stdin!.write(stdin);
    await p.stdin!.end();
  }
  const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
  const [bytes, err] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  const u = new Uint8Array(bytes);
  return { code, stdout: new TextDecoder().decode(u), stderr: err, bytes: u };
}

export class LocalBackend implements DesktopBackend {
  readonly name = "local" as const;
  private image: string;
  private docker: string;
  private run: NonNullable<LocalOpts["run"]>;
  private imageOk: { at: number; ok: boolean } | null = null;
  private proxyAllow: string | null = null;

  constructor(private o: LocalOpts) {
    this.image = o.image ?? "lineage/desktop";
    this.docker = o.docker ?? "docker";
    this.run = o.run ?? spawnRun;
  }

  private uid(): string {
    const u = process.getuid?.() ?? 1000;
    const g = process.getgid?.() ?? 1000;
    // never root inside the desktop, even when the runtime itself runs as root
    return u === 0 ? "1000:1000" : `${u}:${g}`;
  }

  unavailable(): string | null {
    if (this.imageOk && Date.now() - this.imageOk.at < 60_000) return this.imageOk.ok ? null : `image ${this.image} is not built`;
    const p = Bun.spawnSync([this.docker, "image", "inspect", "--format", "{{.Id}}", this.image], { stdout: "ignore", stderr: "ignore" });
    this.imageOk = { at: Date.now(), ok: p.exitCode === 0 };
    return this.imageOk.ok ? null : `image ${this.image} is not built`;
  }

  private async d(args: string[], stdin?: string | Uint8Array, timeoutMs?: number) {
    return this.run([this.docker, ...args], stdin, timeoutMs);
  }

  private netReady: Promise<void> | null = null;

  /** One setup at a time in this process; another process racing us is handled in setupNet. */
  private ensureNet(allow: string[]): Promise<void> {
    const p = (this.netReady ?? Promise.resolve()).catch(() => undefined).then(() => this.setupNet(allow));
    this.netReady = p;
    return p;
  }

  /** The internal network and the allowlist proxy; recreated when the allowlist changed. */
  private async setupNet(allow: string[]): Promise<void> {
    await setupDeskNet((a) => this.d(a), this.image, allow);
    this.proxyAllow = allow.join(",");
  }

  async create(o: CreateOpts): Promise<DesktopInstance> {
    const why = this.unavailable();
    if (why) throw new Error(why);
    await this.ensureNet(o.allow);
    const id = randomBytes(8).toString("hex");
    const name = `lineage-desk-${id}`;
    const host = join(this.o.root, "live", id);
    mkdirSync(host, { recursive: true, mode: 0o755 });
    const user = this.uid();
    const r = await this.d([
      "run", "-d", "--name", name, "--label", "lineage=1", "--label", "units=1", "--label", "lineage.desktop=1", "--label", `lineage.attempt=${o.label.slice(0, 60)}`,
      "--network", NETWORK, "--read-only", "--tmpfs", "/tmp:size=768m", "--shm-size", "256m",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "768",
      "--cpus", String(this.o.cpus ?? 1.5), "--memory", this.o.memory ?? "1536m",
      "--user", user, "-e", "HOME=/tmp/home", "-e", "DISPLAY=:0",
      "-e", `DESK_PROXY=http://${PROXY}:8888`, "-e", `DESK_HOME_URL=${o.homeUrl}`,
      "-v", `${o.tree}:/work/repo:ro`, "-v", `${host}:/stream`,
      this.image,
    ]);
    if (r.code !== 0) {
      rmSync(host, { recursive: true, force: true });
      throw new Error(`desktop container: ${r.stderr.trim().slice(0, 300)}`);
    }
    const exec = async (argv: string[], x: { stdin?: string | Uint8Array; timeoutMs?: number } = {}) =>
      this.d(["exec", ...(x.stdin !== undefined ? ["-i"] : []), "-u", user, "-e", "DISPLAY=:0", "-e", "HOME=/tmp/home", name, ...argv], x.stdin, x.timeoutMs ?? 30_000);
    let gone = false;
    const inst: DesktopInstance = {
      id,
      backend: "local",
      streamDir: "/stream",
      hostStreamDir: host,
      usdPerS: 0,
      exec,
      read: async (path) => {
        const x = await exec(["cat", "--", path], { timeoutMs: 60_000 });
        return x.code === 0 ? (x as { bytes?: Uint8Array }).bytes ?? new TextEncoder().encode(x.stdout) : null;
      },
      sync: async () => {},
      destroy: async () => {
        if (gone) return;
        gone = true;
        await this.d(["rm", "-f", name]).catch(() => undefined);
      },
    };
    // the session is ready when every window is up (desk-session writes /tmp/desk/ready)
    const t0 = Date.now();
    while (Date.now() - t0 < 45_000) {
      if ((await exec(["test", "-f", "/tmp/desk/ready"])).code === 0) return inst;
      await Bun.sleep(300);
    }
    await inst.destroy();
    throw new Error("desktop did not come up within 45 s");
  }
}

type Docker = (args: string[]) => Promise<ExecResult>;

/**
 * The internal desktop network and the allowlist proxy on a Docker host (this one, or a desktop host
 * over ssh: remote.ts); the proxy is recreated when the allowlist changed, and a racing start by another
 * process is accepted when it runs with this allowlist.
 */
export async function setupDeskNet(d: Docker, image: string, allow: string[]): Promise<void> {
  if ((await d(["network", "inspect", NETWORK])).code !== 0) {
    const r = await d(["network", "create", "--internal", "--label", "lineage=1", "--label", "units=1", NETWORK]);
    if (r.code !== 0 && !/already exists/.test(r.stderr)) throw new Error(`desktop network: ${r.stderr.trim()}`);
  }
  const want = allow.join(",");
  const st = await d(["inspect", "--format", "{{println .State.Running}}{{range .Config.Env}}{{println .}}{{end}}", PROXY]);
  const running = st.code === 0 && st.stdout.startsWith("true");
  const has = st.stdout.split("\n").find((l) => l.startsWith("DESK_ALLOW="))?.slice("DESK_ALLOW=".length) ?? null;
  if (running && has === want) return;
  if (st.code === 0) await d(["rm", "-f", PROXY]);
  const r = await d([
    "run", "-d", "--name", PROXY, "--label", "lineage=1", "--label", "units=1", "--restart", "unless-stopped",
    "--read-only", "--tmpfs", "/tmp:size=16m", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--user", "1000:1000", "--memory", "128m", "--pids-limit", "128",
    "-e", `DESK_ALLOW=${want}`, "--entrypoint", "/usr/local/bin/desk-proxy", image,
  ]);
  if (r.code !== 0) {
    const again = await d(["inspect", "--format", "{{println .State.Running}}{{range .Config.Env}}{{println .}}{{end}}", PROXY]);
    const ok = again.code === 0 && again.stdout.startsWith("true") && again.stdout.split("\n").includes(`DESK_ALLOW=${want}`);
    if (!ok) throw new Error(`desktop proxy: ${r.stderr.trim()}`);
  }
  const c = await d(["network", "connect", NETWORK, PROXY]);
  if (c.code !== 0 && !/already exists/.test(c.stderr)) throw new Error(`desktop proxy network: ${c.stderr.trim()}`);
}
