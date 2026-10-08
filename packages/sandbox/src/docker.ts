import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  /**
   * GPU device request for cuda-class recipes (SPEC 6.1, 8), passed as `docker run --gpus <value>`,
   * for example "device=0". Unset for every other recipe. Nothing else is added for GPUs: no
   * capabilities, no extra devices (performance counters are opened on the host, see images/cuda).
   */
  gpus?: string;
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
    // fixed hostname: Docker otherwise injects a random HOSTNAME, and environment size shifts instruction counts
    "--hostname",
    "lineage",
    "--label",
    "lineage=1",
    "--label",
    `lineage.job=${spec.job}`,
    "--user",
    containerUser(),
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
  if (spec.gpus) args.push("--gpus", spec.gpus);
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

/** Architecture of a local image ("amd64" or "arm64"), as Docker reports it. */
export function imageArch(image: string): string {
  const ref = image.includes("@") ? image.slice(image.indexOf("@") + 1) : image;
  const p = Bun.spawnSync(["docker", "image", "inspect", "--format", "{{.Architecture}}", ref]);
  if (p.exitCode !== 0) throw new Error(`image not available: ${image}`);
  return p.stdout.toString().trim();
}

export interface HostGpu {
  index: number;
  name: string;
  /** compute capability, "8.9" */
  sm: string;
  driver: string;
  mem_mb: number;
}

/** GPUs visible on the host per nvidia-smi; empty when there is no NVIDIA driver. */
export function hostGpus(): HostGpu[] {
  let p;
  try {
    p = Bun.spawnSync(["nvidia-smi", "--query-gpu=index,name,compute_cap,driver_version,memory.total", "--format=csv,noheader,nounits"]);
  } catch {
    return [];
  }
  if (p.exitCode !== 0) return [];
  return parseNvidiaSmiGpus(p.stdout.toString());
}

export function parseNvidiaSmiGpus(out: string): HostGpu[] {
  return out
    .split("\n")
    .map((l) => l.split(",").map((x) => x.trim()))
    .filter((f) => f.length >= 5 && /^\d+$/.test(f[0]!))
    .map((f) => ({ index: Number(f[0]), name: f[1]!, sm: f[2]!, driver: f[3]!, mem_mb: Number(f[4]) }));
}

/**
 * The `--gpus` value for a recipe: LINEAGE_GPU_DEVICE (default "0") selects one host GPU, so a
 * multi-GPU worker measures base and candidate on the same device.
 */
export function gpuDeviceRequest(): string {
  const dev = (process.env.LINEAGE_GPU_DEVICE ?? "0").trim();
  if (!/^\d+$/.test(dev)) throw new Error(`LINEAGE_GPU_DEVICE must be a single GPU index, got ${dev}`);
  return `device=${dev}`;
}

/**
 * Runs `fn` while holding a host-wide lock (a directory under `dir` holding the owner's pid), so
 * that every worker process on one machine takes turns on a shared resource. Used for GPUs: two
 * Nsight Compute sessions, or a profiled kernel next to another process's kernels, on the same GPU
 * would collide or disturb the counters. A lock whose owner pid is gone is taken over.
 */
export async function withHostLock<T>(dir: string, name: string, fn: () => Promise<T>, pollMs = 250): Promise<T> {
  const lock = `${dir}/${name}.lock`;
  mkdirSync(dir, { recursive: true });
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(`${lock}/pid`, String(process.pid));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let owner = 0;
      try {
        owner = Number(readFileSync(`${lock}/pid`, "utf8"));
      } catch {
        // being created right now; wait
      }
      let alive = true;
      if (owner > 0) {
        try {
          process.kill(owner, 0);
        } catch {
          alive = false;
        }
      }
      if (!alive) rmSync(lock, { recursive: true, force: true });
      else await Bun.sleep(pollMs);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * The uid:gid sandbox containers run as. On Linux, files a container writes into bind-mounted work
 * trees keep that owner on the host, so running as a fixed 10001 leaves build outputs (Rust
 * `target/`) the worker cannot delete (found on the first Linux site deploy, 2026-10-08). There the
 * container runs as the worker's own non-root user. Never root: a worker running as root still
 * uses 10001. On macOS, Docker Desktop maps ownership, so 10001 is kept.
 */
export function containerUser(platform: string = process.platform, uid: number | null = process.getuid?.() ?? null, gid: number | null = process.getgid?.() ?? null): string {
  if (platform === "linux" && uid !== null && gid !== null && uid !== 0) return `${uid}:${gid}`;
  return "10001:10001";
}
