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
  log?: (m: string) => void;
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
    const envs = { DISPLAY: ":0", HOME, PATH: `${DESK}/bin:/usr/local/bin:/usr/bin:/bin`, DESK_REPO: REPO, DESK_ETC: `${DESK}/etc`, DESK_BIN: `${DESK}/bin`, DESK_NO_X: "1", DESK_HOME_URL: o.homeUrl };
    const sh = async (cmd: string, timeoutMs = 30_000): Promise<ExecResult> => {
      try {
        const r = await sbx.commands.run(cmd, { envs, timeoutMs });
        return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr };
      } catch (e) {
        // the SDK throws on a non-zero exit; it carries the result
        const x = e as { exitCode?: number; stdout?: string; stderr?: string; message?: string };
        return { code: x.exitCode ?? 1, stdout: x.stdout ?? "", stderr: x.stderr ?? x.message ?? String(e) };
      }
    };
    let gone = false;
    const destroy = async () => {
      if (gone) return;
      gone = true;
      await sbx.kill().catch(() => undefined);
    };
    try {
      for (const a of this.assets()) await sbx.files.write(a.path, a.data);
      await sh(`chmod 755 ${DESK}/bin/*`);
      // the tools the session needs; a template without them gets them here while egress is still open
      const missing = (await sh(`for t in ${TOOLS.join(" ")}; do command -v $t >/dev/null || echo $t; done`)).stdout.split(/\s+/).filter(Boolean);
      if (missing.length) {
        this.o.log?.(`e2b desktop: installing ${missing.join(", ")} (use a template with them preinstalled to skip this)`);
        const r = await sh(`sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${missing.map((m) => APT[m]).join(" ")}`, 300_000);
        if (r.code !== 0) throw new Error(`e2b desktop: could not install ${missing.join(", ")}`);
      }
      // from here on only the allowlisted hosts
      if (sbx.updateNetwork) await sbx.updateNetwork({ allowOut: o.allow, denyOut: ["0.0.0.0/0"] });
      // the working tree, with its .git (the navigation terminal searches HEAD)
      const tar = Bun.spawnSync(["tar", "-C", o.tree, "-czf", "-", "."], { stdout: "pipe" });
      if (tar.exitCode !== 0 || tar.stdout.byteLength > 200 * 1024 * 1024) throw new Error("e2b desktop: tree not uploadable");
      await sbx.files.write("/tmp/repo.tgz", tar.stdout.buffer.slice(tar.stdout.byteOffset, tar.stdout.byteOffset + tar.stdout.byteLength) as ArrayBuffer);
      await sh(`mkdir -p ${REPO} /tmp/stream && tar -xzf /tmp/repo.tgz -C ${REPO} && rm -f /tmp/repo.tgz`, 120_000);
      // our own window manager and tiles instead of the template's desktop session
      await sh("pkill -x xfce4-session; pkill -x xfwm4; pkill -x xfdesktop; pkill -x xfce4-panel; true");
      await sh(`${DESK}/bin/desk-bg session ${DESK}/bin/desk-session`);
      const t0 = Date.now();
      while (Date.now() - t0 < 60_000 && (await sh("test -f /tmp/desk/ready")).code !== 0) await Bun.sleep(500);
      if ((await sh("test -f /tmp/desk/ready")).code !== 0) throw new Error("e2b desktop did not come up within 60 s");
    } catch (e) {
      await destroy();
      rmSync(host, { recursive: true, force: true });
      throw e;
    }
    const have = new Set<string>();
    return {
      id,
      backend: "e2b",
      streamDir: "/tmp/stream",
      hostStreamDir: host,
      usdPerS: this.usdPerS,
      exec: (argv, x = {}) => {
        if (x.stdin !== undefined) {
          // stdin goes through a file (the SDK's run takes no stdin)
          const f = `/tmp/desk/in-${randomBytes(4).toString("hex")}`;
          const data = typeof x.stdin === "string" ? x.stdin : new TextDecoder().decode(x.stdin);
          return sbx.files.write(f, data).then(() => sh(`${argv.map(shq).join(" ")} < ${f}; s=$?; rm -f ${f}; exit $s`, x.timeoutMs));
        }
        return sh(argv.map(shq).join(" "), x.timeoutMs);
      },
      read: async (path) => {
        try {
          return await sbx.files.read(path, { format: "bytes" });
        } catch {
          return null;
        }
      },
      push: async (rel, bytes) => {
        await sbx.files.write(`${REPO}/${rel}`, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      },
      sync: async () => {
        // the playlist names what exists; fetch what is new, then publish the playlist last
        let pl: Uint8Array;
        try {
          pl = await sbx.files.read("/tmp/stream/live.m3u8", { format: "bytes" });
        } catch {
          return;
        }
        const text = new TextDecoder().decode(pl);
        const names = playlistFiles(text);
        for (const n of names) {
          if (have.has(n)) continue;
          try {
            const b = await sbx.files.read(`/tmp/stream/${n}`, { format: "bytes" });
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
