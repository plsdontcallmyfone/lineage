import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { b64, type CreateOpts, type DesktopBackend, type DesktopInstance, type ExecResult } from "./backend.ts";

// E2B Desktop overflow backend (owner decision 2026-10-10): used only when our own server's desktop
// slots are full, at most `e2b_max` at once, and only while the day's E2B spend (UTC) is under
// `desktop_usd_per_day`. The key comes from ~/.config/lineage/e2b.env (E2B_API_KEY); a missing or
// empty key disables the backend.
//
// The desktop runs the same session scripts as lineage/desktop (uploaded at start), the same
// encoder with the same redaction, and its HLS files are copied to this host, where the gate serves
// them like a local desktop's. E2B's own noVNC viewer is never started or linked. Its egress is
// restricted with E2B's network rules to the allowlisted hosts once the tools are in place.
//
// Pricing (read from https://e2b.dev/pricing on 2026-10-10): $0.000014 per vCPU second and
// $0.0000045 per GiB of RAM per second; storage free. The sandbox size is the template's (the default
// desktop template is 2 vCPU, 4 GiB unless configured otherwise); set e2b_vcpu and e2b_ram_gib to it.

export const E2B_RATES = { usd_per_vcpu_s: 0.000014, usd_per_gib_s: 0.0000045, read_at: "2026-10-10", source: "https://e2b.dev/pricing" } as const;

export function e2bUsdPerS(vcpu: number, ramGib: number): number {
  return vcpu * E2B_RATES.usd_per_vcpu_s + ramGib * E2B_RATES.usd_per_gib_s;
}

/** E2B_API_KEY from ~/.config/lineage/e2b.env (or the environment); null when absent or empty. Never printed. */
export function loadE2BKey(path = join(homedir(), ".config/lineage/e2b.env")): string | null {
  if (process.env.E2B_API_KEY?.trim()) return process.env.E2B_API_KEY.trim();
  if (!existsSync(path)) return null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*E2B_API_KEY\s*=\s*(.*?)\s*$/.exec(line);
    if (m) {
      const v = m[1]!.replace(/^["']|["']$/g, "");
      return v ? v : null;
    }
  }
  return null;
}

/** The part of the E2B SDK this backend uses (the real one is @e2b/desktop's Sandbox; tests pass a mock). */
export interface E2BSandbox {
  sandboxId: string;
  commands: { run(cmd: string, opts?: { envs?: Record<string, string>; timeoutMs?: number; user?: string }): Promise<{ exitCode: number; stdout: string; stderr: string }> };
  files: {
    write(path: string, data: string | ArrayBuffer): Promise<unknown>;
    read(path: string, opts: { format: "bytes" }): Promise<Uint8Array>;
  };
  updateNetwork?(n: { allowOut?: string[]; denyOut?: string[] }): Promise<void>;
  kill(): Promise<unknown>;
}
export type E2BCreate = (template: string, opts: Record<string, unknown>) => Promise<E2BSandbox>;

export async function sdkCreate(): Promise<E2BCreate> {
  const { Sandbox } = (await import("@e2b/desktop")) as unknown as { Sandbox: { create(t: string, o: Record<string, unknown>): Promise<E2BSandbox> } };
  return (t, o) => Sandbox.create(t, o);
}

/** One sandbox as E2B lists it. */
export interface E2BInfo {
  sandboxId: string;
  state: "running" | "paused";
  metadata: Record<string, string>;
  /** the last create or resume (E2B restarts it on a resume; measured 2026-10-12) */
  startedAt: Date;
  /** when its timeout runs out */
  endAt: Date;
}

/**
 * The account-level calls the per-agent desktops use (agent-desktops.ts). The real one is the installed
 * SDK (@e2b/desktop 2.4.0 on e2b 2.55.0: Sandbox.create, connect, list, getInfo, pause, kill,
 * setTimeout); tests pass a fake. `connect` resumes a paused sandbox.
 */
export interface E2BApi {
  create(template: string, opts: Record<string, unknown>): Promise<E2BSandbox>;
  connect(id: string, opts: { timeoutMs: number }): Promise<E2BSandbox>;
  /** every sandbox, running or paused, whose metadata has all of these pairs */
  list(metadata: Record<string, string>): Promise<E2BInfo[]>;
  info(id: string): Promise<E2BInfo>;
  /** true: paused now; false: it already was */
  pause(id: string): Promise<boolean>;
  /** true: killed; false: not found */
  kill(id: string): Promise<boolean>;
  /** the timeout is this long from now (E2B clamps it to the plan's session length) */
  setTimeout(id: string, ms: number): Promise<void>;
}

export async function sdkApi(apiKey: string): Promise<E2BApi> {
  type Info = E2BInfo;
  const { Sandbox } = (await import("@e2b/desktop")) as unknown as {
    Sandbox: {
      create(t: string, o: Record<string, unknown>): Promise<E2BSandbox>;
      connect(id: string, o: Record<string, unknown>): Promise<E2BSandbox>;
      list(o: Record<string, unknown>): { hasNext: boolean; nextItems(): Promise<Info[]> };
      getInfo(id: string, o: Record<string, unknown>): Promise<Info>;
      pause(id: string, o: Record<string, unknown>): Promise<boolean>;
      kill(id: string, o: Record<string, unknown>): Promise<boolean>;
      setTimeout(id: string, ms: number, o: Record<string, unknown>): Promise<void>;
    };
  };
  const pick = (i: Info): Info => ({ sandboxId: i.sandboxId, state: i.state, metadata: i.metadata ?? {}, startedAt: i.startedAt, endAt: i.endAt });
  return {
    create: (t, o) => Sandbox.create(t, { ...o, apiKey }),
    connect: (id, o) => Sandbox.connect(id, { ...o, apiKey }),
    list: async (metadata) => {
      const p = Sandbox.list({ apiKey, query: { metadata, state: ["running", "paused"] } });
      const all: Info[] = [];
      while (p.hasNext) all.push(...(await p.nextItems()));
      return all.map(pick);
    },
    info: async (id) => pick(await Sandbox.getInfo(id, { apiKey })),
    pause: (id) => Sandbox.pause(id, { apiKey }),
    kill: (id) => Sandbox.kill(id, { apiKey }),
    setTimeout: (id, ms) => Sandbox.setTimeout(id, ms, { apiKey }),
  };
}

/** A sandbox is not there to take a command: paused, killed or timed out (the SDK's error names, e2b 2.55.0). */
export function sandboxGone(e: unknown): boolean {
  const x = e as { name?: string; message?: string } | null;
  return /^(SandboxNotRunningError|SandboxNotFoundError|NotFoundError|SandboxError)$/.test(x?.name ?? "") || /sandbox\b.*\b(not running|not found|was killed|is paused)/i.test(x?.message ?? "");
}

export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export interface E2BOpts {
  /** host directory for live streams: <root>/live/<id> */
  root: string;
  key?: string | null;
  template?: string;
  vcpu?: number;
  ram_gib?: number;
  /** hard lifetime of one E2B desktop (its sandbox timeout), s */
  session_max_s?: number;
  /** images/desktop/rootfs, uploaded at start */
  rootfs?: string;
  create?: E2BCreate;
  /** the account calls of the per-agent desktops (default: the SDK with this backend's key) */
  api?: E2BApi;
  log?: (m: string) => void;
}

/** What the per-agent desktops (agent-desktops.ts) ask of a session on an agent's own sandbox. */
export interface SessionHooks {
  /** the sandbox handle in use now (replaced after a resume) */
  box: { sbx: E2BSandbox };
  /** a command could not reach the sandbox: true when it is back (try once more), false when it is lost */
  recover?(e: unknown): Promise<boolean>;
  /** the session closed (the sandbox stays) */
  closed(): void;
}

const TOOLS = ["xdotool", "ffmpeg", "openbox", "xterm", "micro", "rg", "git", "xdpyinfo"];
const APT: Record<string, string> = { xdotool: "xdotool", ffmpeg: "ffmpeg", openbox: "openbox", xterm: "xterm", micro: "micro", rg: "ripgrep", git: "git", xdpyinfo: "x11-utils" };
const HOME = "/home/user";
const DESK = `${HOME}/desk`;
const REPO = `${HOME}/repo`;

export class E2BBackend implements DesktopBackend {
  readonly name = "e2b" as const;
  readonly usdPerS: number;
  private key: string | null;

  constructor(private o: E2BOpts) {
    this.key = o.key === undefined ? loadE2BKey() : o.key;
    this.usdPerS = e2bUsdPerS(o.vcpu ?? 2, o.ram_gib ?? 4);
  }

  unavailable(): string | null {
    return this.key ? null : "no E2B_API_KEY (~/.config/lineage/e2b.env)";
  }

  /** Files of images/desktop/rootfs to upload (scripts and config). */
  private assets(): { path: string; data: string }[] {
    const root = this.o.rootfs ?? join(import.meta.dir, "../../../images/desktop/rootfs");
    const out: { path: string; data: string }[] = [];
    for (const f of readdirSync(join(root, "usr/local/bin"))) out.push({ path: `${DESK}/bin/${f}`, data: readFileSync(join(root, "usr/local/bin", f), "utf8") });
    for (const f of readdirSync(join(root, "etc/lineage-desktop"))) out.push({ path: `${DESK}/etc/${f}`, data: readFileSync(join(root, "etc/lineage-desktop", f), "utf8") });
    return out;
  }

  private envs(homeUrl: string) {
    return { DISPLAY: ":0", HOME, PATH: `${DESK}/bin:/usr/local/bin:/usr/bin:/bin`, DESK_REPO: REPO, DESK_ETC: `${DESK}/etc`, DESK_BIN: `${DESK}/bin`, DESK_NO_X: "1", DESK_HOME_URL: homeUrl };
  }

  /** Runs a shell line in the sandbox of `box` as the desktop user; a command that could not reach the sandbox goes through `recover` once. */
  private shell(box: { sbx: E2BSandbox }, homeUrl: string, recover?: (e: unknown) => Promise<boolean>) {
    const envs = this.envs(homeUrl);
    const sh = async (cmd: string, timeoutMs = 30_000, again = true): Promise<ExecResult> => {
      try {
        const r = await box.sbx.commands.run(cmd, { envs, timeoutMs });
        return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr };
      } catch (e) {
        // the SDK throws on a non-zero exit; it carries the result
        const x = e as { exitCode?: number; stdout?: string; stderr?: string; message?: string };
        if (x.exitCode === undefined && again && recover && sandboxGone(e) && (await recover(e))) return sh(cmd, timeoutMs, false);
        return { code: x.exitCode ?? 1, stdout: x.stdout ?? "", stderr: x.stderr ?? x.message ?? String(e) };
      }
    };
    return sh;
  }

  /** The session scripts and the tools they need (installed while egress is still open on a template without them). */
  private async provision(sbx: E2BSandbox, sh: (cmd: string, timeoutMs?: number) => Promise<ExecResult>) {
    for (const a of this.assets()) await sbx.files.write(a.path, a.data);
    await sh(`chmod 755 ${DESK}/bin/*`);
    // the tools the session needs; a template without them gets them here while egress is still open
    const missing = (await sh(`for t in ${TOOLS.join(" ")}; do command -v $t >/dev/null || echo $t; done`)).stdout.split(/\s+/).filter(Boolean);
    if (missing.length) {
      this.o.log?.(`e2b desktop: installing ${missing.join(", ")} (use a template with them preinstalled to skip this)`);
      const r = await sh(`sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${missing.map((m) => APT[m]).join(" ")}`, 300_000);
      if (r.code !== 0) throw new Error(`e2b desktop: could not install ${missing.join(", ")}`);
    }
  }

  /** From here on only the allowlisted hosts: each host with its subdomains (E2B takes "*.host"; checked on a real desktop 2026-10-10). */
  private async lockNetwork(sbx: E2BSandbox, allow: string[]) {
    if (sbx.updateNetwork) await sbx.updateNetwork({ allowOut: allow.flatMap((h) => [h, `*.${h}`]), denyOut: ["0.0.0.0/0"] });
  }

  /** The working tree, with its .git (the navigation terminal searches HEAD). */
  private async uploadTree(sbx: E2BSandbox, sh: (cmd: string, timeoutMs?: number) => Promise<ExecResult>, tree: string) {
    const tar = Bun.spawnSync(["tar", "-C", tree, "-czf", "-", "."], { stdout: "pipe" });
    if (tar.exitCode !== 0 || tar.stdout.byteLength > 200 * 1024 * 1024) throw new Error("e2b desktop: tree not uploadable");
    await sbx.files.write("/tmp/repo.tgz", tar.stdout.buffer.slice(tar.stdout.byteOffset, tar.stdout.byteOffset + tar.stdout.byteLength) as ArrayBuffer);
    const r = await sh(`mkdir -p ${REPO} /tmp/stream && tar -xzf /tmp/repo.tgz -C ${REPO} && rm -f /tmp/repo.tgz`, 120_000);
    return r;
  }

  /** Our own window manager and tiles instead of the template's desktop session. */
  private async stopTemplateDesktop(sh: (cmd: string, timeoutMs?: number) => Promise<ExecResult>) {
    // the session manager first (it respawns the panel), then the panel (its strut moved every window
    // 27 px down, off its tile, which the geometry guard caught), the window manager and the desktop
    await sh("pkill -x xfce4-session; sleep 0.5; pkill -x xfce4-panel; pkill -f '^panel-'; pkill -x xfwm4; pkill -x xfdesktop; pkill -x xfce4-notifyd; sleep 0.5; true");
  }

  private async startSession(sh: (cmd: string, timeoutMs?: number) => Promise<ExecResult>) {
    await sh(`${DESK}/bin/desk-bg session ${DESK}/bin/desk-session`);
    const t0 = Date.now();
    while (Date.now() - t0 < 60_000 && (await sh("test -f /tmp/desk/ready")).code !== 0) await Bun.sleep(500);
    if ((await sh("test -f /tmp/desk/ready")).code !== 0) throw new Error("e2b desktop did not come up within 60 s");
  }

  async create(o: CreateOpts): Promise<DesktopInstance> {
    if (!this.key) throw new Error("E2B backend disabled: no key");
    const create = this.o.create ?? (await sdkCreate());
    const sbx = await create(this.o.template ?? "desktop", {
      apiKey: this.key,
      resolution: [1280, 800],
      dpi: 96,
      timeoutMs: (this.o.session_max_s ?? 3600) * 1000,
      metadata: { lineage: "1", attempt: o.label.slice(0, 60) },
    });
    const id = randomBytes(8).toString("hex");
    const host = join(this.o.root, "live", id);
    mkdirSync(host, { recursive: true, mode: 0o755 });
    const box = { sbx };
    const sh = this.shell(box, o.homeUrl);
    let gone = false;
    const destroy = async () => {
      if (gone) return;
      gone = true;
      await sbx.kill().catch(() => undefined);
    };
    try {
      await this.provision(sbx, sh);
      await this.lockNetwork(sbx, o.allow);
      await this.uploadTree(sbx, sh, o.tree);
      await this.stopTemplateDesktop(sh);
      await this.startSession(sh);
    } catch (e) {
      await destroy();
      rmSync(host, { recursive: true, force: true });
      throw e;
    }
    return this.instance(box, sh, id, host, destroy, this.usdPerS);
  }

  // ------------------------------------------------------------------ per-agent desktops (agent-desktops.ts)

  /** The account calls (list, connect, pause, kill, timeouts) with this backend's key. */
  async api(): Promise<E2BApi> {
    if (this.o.api) return this.o.api;
    if (!this.key) throw new Error("E2B backend disabled: no key");
    return (this.apiP ??= sdkApi(this.key));
  }
  private apiP: Promise<E2BApi> | null = null;

  /**
   * A sandbox that stays an agent's own desktop: E2B pauses it instead of killing it when its timeout
   * runs out (`onTimeout: "pause"`), the session scripts are in place and egress is locked to `allow`.
   * `onId` is called as soon as E2B named the sandbox, before anything else is done to it. A sandbox
   * that could not be made ready is killed.
   */
  async createAgent(o: { metadata: Record<string, string>; timeoutMs: number; allow: string[]; onId?: (id: string) => void }): Promise<E2BSandbox> {
    const api = await this.api();
    const sbx = await api.create(this.o.template ?? "desktop", {
      resolution: [1280, 800],
      dpi: 96,
      timeoutMs: o.timeoutMs,
      metadata: o.metadata,
      lifecycle: { onTimeout: "pause", autoResume: false },
    });
    o.onId?.(sbx.sandboxId);
    try {
      await this.prepareAgent(sbx, o.allow);
    } catch (e) {
      await api.kill(sbx.sandboxId).catch(() => false);
      throw e;
    }
    return sbx;
  }

  /** Scripts, tools, egress and the template's own desktop session, once per sandbox (a marker file says it was done). */
  async prepareAgent(sbx: E2BSandbox, allow: string[]): Promise<void> {
    const sh = this.shell({ sbx }, "about:blank");
    if ((await sh(`test -f ${DESK}/.provisioned`)).code === 0) return;
    await this.provision(sbx, sh);
    await this.lockNetwork(sbx, allow);
    await this.stopTemplateDesktop(sh);
    const r = await sh(`touch ${DESK}/.provisioned`);
    if (r.code !== 0) throw new Error(`e2b desktop: not provisioned: ${r.stderr.slice(0, 160)}`);
  }

  /** Stops what a session left on an agent's desktop: the encoder, the windows, the tree copy, the browser profile. */
  private closeLine() {
    return [
      `for n in live rec; do [ -x ${DESK}/bin/desk-stop ] && ${DESK}/bin/desk-stop $n KILL 2; done`,
      `p=$(cat /tmp/desk/session.pid 2>/dev/null); [ -n "$p" ] && kill -KILL -- -"$p" 2>/dev/null`,
      // the bracket keeps this line's own shell out of the match
      `pkill -KILL -f -- '--class=[L]ineageBrowser'; pkill -KILL -x xterm; pkill -KILL -x openbox; pkill -KILL -x micro`,
      `rm -rf /tmp/desk /tmp/stream /tmp/repo.tgz ${REPO} ${HOME}/chromium`,
      "true",
    ].join("; ");
  }

  /**
   * One attempt's session on an agent's own desktop: what the last session left is cleared, the
   * runtime's working tree is copied in and the desktop session starts. `destroy` ends the session and
   * leaves the sandbox; it bills nothing here (the per-agent desktops count the sandbox's running time).
   */
  async openSession(o: CreateOpts, hooks: SessionHooks): Promise<DesktopInstance> {
    const box = hooks.box;
    const id = randomBytes(8).toString("hex");
    const host = join(this.o.root, "live", id);
    mkdirSync(host, { recursive: true, mode: 0o755 });
    const sh = this.shell(box, o.homeUrl, hooks.recover);
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      // no recovery here: a sandbox that is gone has nothing left to stop
      await this.shell(box, o.homeUrl)(this.closeLine(), 30_000).catch(() => undefined);
      hooks.closed();
    };
    try {
      await this.prepareAgent(box.sbx, o.allow);
      const c = await sh(this.closeLine(), 30_000);
      if (c.code !== 0) throw new Error(`e2b desktop: could not clear the last session: ${c.stderr.slice(0, 160)}`);
      const u = await this.uploadTree(box.sbx, sh, o.tree);
      if (u.code !== 0) throw new Error(`e2b desktop: tree not unpacked: ${u.stderr.slice(0, 160)}`);
      await this.startSession(sh);
    } catch (e) {
      await close();
      rmSync(host, { recursive: true, force: true });
      throw e;
    }
    return this.instance(box, sh, id, host, close, 0);
  }

  private instance(box: { sbx: E2BSandbox }, sh: (cmd: string, timeoutMs?: number) => Promise<ExecResult>, id: string, host: string, destroy: () => Promise<void>, usdPerS: number): DesktopInstance {
    const have = new Set<string>();
    return {
      id,
      backend: "e2b",
      streamDir: "/tmp/stream",
      hostStreamDir: host,
      usdPerS,
      exec: (argv, x = {}) => {
        if (x.stdin !== undefined) {
          // stdin goes through a file (the SDK's run takes no stdin)
          const f = `/tmp/desk/in-${randomBytes(4).toString("hex")}`;
          const data = typeof x.stdin === "string" ? x.stdin : new TextDecoder().decode(x.stdin);
          return box.sbx.files.write(f, data).then(() => sh(`${argv.map(shq).join(" ")} < ${f}; s=$?; rm -f ${f}; exit $s`, x.timeoutMs));
        }
        return sh(argv.map(shq).join(" "), x.timeoutMs);
      },
      read: async (path) => {
        try {
          return await box.sbx.files.read(path, { format: "bytes" });
        } catch {
          return null;
        }
      },
      push: async (rel, bytes) => {
        await box.sbx.files.write(`${REPO}/${rel}`, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      },
      sync: async () => {
        // the playlist names what exists; fetch what is new, then publish the playlist last
        let pl: Uint8Array;
        try {
          pl = await box.sbx.files.read("/tmp/stream/live.m3u8", { format: "bytes" });
        } catch {
          return;
        }
        const text = new TextDecoder().decode(pl);
        const names = playlistFiles(text);
        for (const n of names) {
          if (have.has(n)) continue;
          try {
            const b = await box.sbx.files.read(`/tmp/stream/${n}`, { format: "bytes" });
            writeFileSync(join(host, `${n}.part`), b);
            renameSync(join(host, `${n}.part`), join(host, n));
            have.add(n);
          } catch {
            return; // not there yet; next round
          }
        }
        writeFileSync(join(host, "live.m3u8.part"), text);
        renameSync(join(host, "live.m3u8.part"), join(host, "live.m3u8"));
        for (const f of readdirSync(host)) if (f.startsWith("seg-") && !names.includes(f)) rmSync(join(host, f), { force: true }), have.delete(f);
      },
      destroy,
    };
  }
}

/** Files an HLS media playlist references (its map and segments), names only. */
export function playlistFiles(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const l = line.trim();
    const map = /^#EXT-X-MAP:URI="([^"]+)"/.exec(l);
    if (map) out.push(map[1]!);
    else if (l && !l.startsWith("#")) out.push(l);
  }
  return out.filter((n) => /^(init\.mp4|seg-\d{1,20}\.m4s)$/.test(n));
}
