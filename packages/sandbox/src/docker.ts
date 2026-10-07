import { randomBytes } from "node:crypto";
import type { Limits } from "@lineage/protocol";

// Docker runner, SPEC section 8. Every container is labelled lineage=1 so cleanup never touches
// anything else on the machine.

export interface Mount {
  host: string;
  container: string;
  readonly?: boolean;
}

export interface RunSpec {
  image: string;
  cmd: string;
  cwd: string;
  mounts: Mount[];
  network: boolean;
  env: Record<string, string>;
  limits: Limits;
  timeout_s: number;
  job: string;
  /** cap on captured stdout and stderr each, bytes */
  capture_limit?: number;
}

export interface RunResult {
  exit: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
  truncated: boolean;
}

const CAPTURE = 4 * 1024 * 1024;

async function readCapped(stream: ReadableStream<Uint8Array>, limit: number): Promise<{ text: string; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of stream) {
    if (size < limit) {
      const take = chunk.subarray(0, Math.max(0, limit - size));
      chunks.push(take);
      size += take.length;
      if (take.length < chunk.length) truncated = true;
    } else truncated = true;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

export function dockerArgs(spec: RunSpec, name: string): string[] {
  const l = spec.limits;
  const args = [
    "run",
    "--rm",
    "--name",
    name,
    "--label",
    "lineage=1",
    "--label",
    `lineage.job=${spec.job}`,
    "--user",
    "10001:10001",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,exec,size=512m",
    "--cpus",
    String(l.cpus),
    "--memory",
    `${l.memory_mb}m`,
    "--memory-swap",
    `${l.memory_mb}m`,
    "--pids-limit",
    String(l.pids),
    "--workdir",
    spec.cwd,
  ];
  if (!spec.network) args.push("--network", "none");
  for (const m of spec.mounts) args.push("--volume", `${m.host}:${m.container}${m.readonly ? ":ro" : ""}`);
  const env = {
    TZ: "UTC",
    LANG: "C.UTF-8",
    CI: "1",
    HOME: "/tmp",
    PYTHONHASHSEED: "0",
    CARGO_INCREMENTAL: "0",
    ...spec.env,
  };
  for (const [k, v] of Object.entries(env)) args.push("--env", `${k}=${v}`);
  args.push(spec.image, "sh", "-c", spec.cmd);
  return args;
}

export async function runContainer(spec: RunSpec): Promise<RunResult> {
  const name = `lineage-${spec.job.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 40)}-${randomBytes(4).toString("hex")}`;
  const started = performance.now();
  const proc = Bun.spawn(["docker", ...dockerArgs(spec, name)], { stdout: "pipe", stderr: "pipe" });
  let timed_out = false;
  const timer = setTimeout(() => {
    timed_out = true;
    Bun.spawn(["docker", "kill", name], { stdout: "ignore", stderr: "ignore" });
  }, spec.timeout_s * 1000);
  const limit = spec.capture_limit ?? CAPTURE;
  const [out, err] = await Promise.all([readCapped(proc.stdout, limit), readCapped(proc.stderr, limit)]);
  const exit = await proc.exited;
  clearTimeout(timer);
  return {
    exit: timed_out ? 124 : exit,
    stdout: out.text,
    stderr: err.text,
    duration_ms: Math.round(performance.now() - started),
    timed_out,
    truncated: out.truncated || err.truncated,
  };
}

export async function imageDigest(image: string): Promise<string> {
  const ref = image.includes("@") ? image.slice(image.indexOf("@") + 1) : image;
  const p = Bun.spawnSync(["docker", "image", "inspect", "--format", "{{.Id}}", ref]);
  if (p.exitCode === 0) return p.stdout.toString().trim();
  if (image.includes("@")) {
    const pull = Bun.spawnSync(["docker", "pull", image]);
    if (pull.exitCode === 0) return imageDigest(image.slice(0, image.indexOf("@")) + "@" + ref);
  }
  throw new Error(`image not available: ${image}`);
}

/** The image reference to run: the pinned id when the recipe carries one. */
export function runnableImage(image: string): string {
  return image.includes("@") ? image.slice(image.indexOf("@") + 1) : image;
}

/** Removes leftover containers of ours only (crashed runs). */
export function cleanupLineageContainers(): void {
  const ps = Bun.spawnSync(["docker", "ps", "-aq", "--filter", "label=lineage=1"]);
  const ids = ps.stdout.toString().split("\n").filter(Boolean);
  if (ids.length) Bun.spawnSync(["docker", "rm", "-f", ...ids]);
}
