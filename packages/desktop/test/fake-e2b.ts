import type { E2BApi, E2BInfo, E2BSandbox } from "../src/e2b.ts";

// A fake E2B account for the per-agent desktop tests: sandboxes with metadata, running or paused,
// with timeouts that pause (onTimeout "pause") or kill, as the real service does (measured 2026-10-12:
// a resume restarts startedAt, a command to a paused sandbox fails with SandboxNotRunningError).

export class NotRunning extends Error {
  override name = "SandboxNotRunningError";
}

interface Box {
  id: string;
  state: "running" | "paused";
  metadata: Record<string, string>;
  startedAt: number;
  endAt: number;
  onTimeout: "pause" | "kill";
  provisioned: boolean;
  cmds: string[];
  /** the desktop session's four windows are up */
  windows: boolean;
  /** what desk-geom prints while they are (a test moves a window by changing it) */
  geom: string;
  /** the live encoder runs; the command that started it */
  encoder: boolean;
  encoderCmd: string;
  encoderStarts: number;
}

export const GEOM = "LineageEditor 0 0 636 795\nLineageRun 640 600 637 195\nLineageTerm 640 400 637 195\nLineageBrowser 640 0 640 400\n";

export class FakeE2B implements E2BApi {
  boxes = new Map<string, Box>();
  calls: string[] = [];
  n = 0;
  /** make the next create fail, or wait for a gate */
  failCreate: string | null = null;
  gate: Promise<void> | null = null;
  failPause: string | null = null;
  constructor(public now: () => number) {}

  /** what E2B does when time passes: a sandbox past its timeout is paused or killed */
  expire() {
    for (const b of this.boxes.values()) {
      if (b.state !== "running" || b.endAt > this.now()) continue;
      if (b.onTimeout === "pause") b.state = "paused";
      else this.boxes.delete(b.id);
    }
  }

  private handle(b: Box): E2BSandbox {
    const alive = () => {
      this.expire();
      const x = this.boxes.get(b.id);
      if (!x || x.state !== "running") throw new NotRunning(`sandbox ${b.id} is not running`);
    };
    return {
      sandboxId: b.id,
      commands: {
        run: async (cmd) => {
          alive();
          b.cmds.push(cmd);
          const fail = () => Object.assign(new Error("exit 1"), { exitCode: 1, stdout: "", stderr: "" });
          if (/^test -f \S*\.provisioned$/.test(cmd) && !b.provisioned) throw fail();
          if (/^touch \S*\.provisioned$/.test(cmd)) b.provisioned = true;
          // the desktop session: closing it takes the windows and the encoder, starting it brings the windows
          if (cmd.includes("pkill -KILL -x xterm")) (b.windows = false), (b.encoder = false);
          if (cmd.includes("desk-bg session")) b.windows = true;
          if (cmd === "test -f /tmp/desk/ready" && !b.windows) throw fail();
          if (cmd.includes("desk-stop live")) b.encoder = false;
          if (cmd.includes("desk-bg live")) (b.encoder = true), (b.encoderCmd = cmd), b.encoderStarts++;
          // the stream guard's one command: the windows, then whether the encoder and the session are there
          if (cmd.includes("echo ---")) return { exitCode: 0, stdout: `${cmd.includes("desk-geom") && b.windows ? b.geom : ""}---\n${b.encoder ? "alive\n" : ""}${b.windows ? "ready\n" : ""}`, stderr: "" };
          if (cmd.endsWith("desk-geom") || cmd.endsWith("desk-geom'")) return { exitCode: 0, stdout: b.windows ? b.geom : "", stderr: "" };
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      files: {
        write: async () => {
          alive();
        },
        read: async (path) => {
          alive();
          // a running encoder's playlist: three 2 s segments numbered by the clock, as ffmpeg's are
          if (!b.encoder) throw new Error("no file");
          const n = Math.floor(this.now() / 2000);
          if (path === "/tmp/stream/live.m3u8") return new TextEncoder().encode(`#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n${[n - 2, n - 1, n].map((i) => `#EXTINF:2,\nseg-${i}.m4s`).join("\n")}\n`);
          if (/^\/tmp\/stream\/(init\.mp4|seg-\d+\.m4s)$/.test(path)) return new TextEncoder().encode(`${b.id}:${path}:${b.encoderStarts}`);
          throw new Error("no file");
        },
      },
      updateNetwork: async () => {
        alive();
        b.cmds.push("<network locked>");
      },
      kill: async () => this.kill(b.id),
    };
  }

  async create(_t: string, opts: Record<string, unknown>): Promise<E2BSandbox> {
    this.calls.push("create");
    if (this.gate) await this.gate;
    if (this.failCreate) throw new Error(this.failCreate);
    const id = `sbx${++this.n}xxxxxxxx`;
    const lc = opts.lifecycle as { onTimeout?: "pause" | "kill" } | undefined;
    const b: Box = { id, state: "running", metadata: { ...(opts.metadata as Record<string, string>) }, startedAt: this.now(), endAt: this.now() + (opts.timeoutMs as number), onTimeout: lc?.onTimeout ?? "kill", provisioned: false, cmds: [], windows: false, geom: GEOM, encoder: false, encoderCmd: "", encoderStarts: 0 };
    this.boxes.set(id, b);
    return this.handle(b);
  }

  async connect(id: string, o: { timeoutMs: number }): Promise<E2BSandbox> {
    this.calls.push(`connect ${id}`);
    this.expire();
    const b = this.boxes.get(id);
    if (!b) throw Object.assign(new Error(`sandbox ${id} not found`), { name: "SandboxNotFoundError" });
    if (b.state === "paused") {
      b.state = "running";
      b.startedAt = this.now();
      b.endAt = this.now() + o.timeoutMs;
    } else b.endAt = Math.max(b.endAt, this.now() + o.timeoutMs);
    return this.handle(b);
  }

  private info1(b: Box): E2BInfo {
    return { sandboxId: b.id, state: b.state, metadata: { ...b.metadata }, startedAt: new Date(b.startedAt), endAt: new Date(b.endAt) };
  }

  async list(metadata: Record<string, string>): Promise<E2BInfo[]> {
    this.calls.push("list");
    this.expire();
    return [...this.boxes.values()].filter((b) => Object.entries(metadata).every(([k, v]) => b.metadata[k] === v)).map((b) => this.info1(b));
  }

  async info(id: string): Promise<E2BInfo> {
    this.expire();
    const b = this.boxes.get(id);
    if (!b) throw Object.assign(new Error(`sandbox ${id} not found`), { name: "SandboxNotFoundError" });
    return this.info1(b);
  }

  async pause(id: string): Promise<boolean> {
    this.calls.push(`pause ${id}`);
    if (this.failPause) throw new Error(this.failPause);
    const b = this.boxes.get(id);
    if (!b) throw Object.assign(new Error(`sandbox ${id} not found`), { name: "SandboxNotFoundError" });
    if (b.state === "paused") return false;
    b.state = "paused";
    return true;
  }

  async kill(id: string): Promise<boolean> {
    this.calls.push(`kill ${id}`);
    return this.boxes.delete(id);
  }

  async setTimeout(id: string, ms: number): Promise<void> {
    this.calls.push(`timeout ${id} ${ms}`);
    this.expire();
    const b = this.boxes.get(id);
    if (!b || b.state !== "running") throw new NotRunning(`sandbox ${id} is not running`);
    b.endAt = this.now() + ms;
  }

  count(what: string) {
    return this.calls.filter((c) => c === what || c.startsWith(`${what} `)).length;
  }
  running() {
    this.expire();
    return [...this.boxes.values()].filter((b) => b.state === "running").length;
  }
  ofAgent(agent: string) {
    return [...this.boxes.values()].filter((b) => b.metadata.agent === agent);
  }
}
