import { cpus, totalmem } from "node:os";
import type { Capabilities } from "@lineage/protocol";

// `lineage-worker doctor`: what this machine can replay (SPEC 6.1). Capabilities are read from the
// Docker engine where possible (on macOS the sandboxes run in Docker Desktop's VM, whose CPU and
// memory are what a replay actually gets), falling back to the host.

export interface DoctorReport {
  capabilities: Capabilities;
  docker: { reachable: boolean; arch_raw: string | null; error?: string };
  /** lineage images present locally: repository:tag and image id */
  images: { ref: string; id: string }[];
  nvidia_smi: "found" | "absent" | "error";
  notes: string[];
}

type Run = (cmd: string[]) => { ok: boolean; out: string; err: string };

const defaultRun: Run = (cmd) => {
  try {
    const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
  } catch (e) {
    return { ok: false, out: "", err: String((e as Error).message ?? e) };
  }
};

/** Maps Docker's and uname's architecture names onto the recipe vocabulary. */
export function normalizeArch(raw: string): "amd64" | "arm64" | null {
  const a = raw.trim().toLowerCase();
  if (["x86_64", "amd64", "x64"].includes(a)) return "amd64";
  if (["aarch64", "arm64", "arm64v8"].includes(a)) return "arm64";
  return null;
}

/** Parses `nvidia-smi --query-gpu=name,compute_cap,memory.total,driver_version --format=csv,noheader`. */
export function parseNvidiaSmi(out: string): Capabilities["gpus"] {
  const gpus: Capabilities["gpus"] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [name, cap, mem, driver] = line.split(",").map((s) => s.trim());
    if (!name || !cap || !mem || !driver) continue;
    const mib = Number(/([\d.]+)/.exec(mem)?.[1] ?? NaN);
    const unitGb = /gib|gb/i.test(mem) ? mib : mib / 1024;
    if (!/^\d{1,2}\.\d{1,2}$/.test(cap) || !Number.isFinite(unitGb) || unitGb <= 0) continue;
    gpus.push({ vendor: "nvidia", model: name.slice(0, 128), sm: cap, mem_gb: Math.round(unitGb * 10) / 10, driver });
  }
  return gpus;
}

export function doctor(run: Run = defaultRun): DoctorReport {
  const notes: string[] = [];
  const info = run(["docker", "info", "--format", "{{.Architecture}}|{{.NCPU}}|{{.MemTotal}}"]);
  let arch: "amd64" | "arm64" | null = null;
  let cpuCount = cpus().length;
  let memMb = Math.floor(totalmem() / 1024 / 1024);
  let archRaw: string | null = null;
  if (info.ok && info.out) {
    const [a, n, m] = info.out.split("|");
    archRaw = a ?? null;
    arch = normalizeArch(a ?? "");
    if (Number(n) > 0) cpuCount = Number(n);
    if (Number(m) > 0) memMb = Math.floor(Number(m) / 1024 / 1024);
  } else {
    notes.push(`docker not reachable: ${info.err.split("\n")[0] || "no output"}`);
  }
  if (!arch) {
    const u = run(["uname", "-m"]);
    arch = normalizeArch(u.out) ?? "amd64";
    notes.push(`architecture from uname (${u.out || "unknown"}); sandboxes need Docker`);
  }
  let gpus: Capabilities["gpus"] = [];
  let smi: DoctorReport["nvidia_smi"] = "absent";
  const which = run(["sh", "-c", "command -v nvidia-smi"]);
  if (which.ok && which.out) {
    const q = run(["nvidia-smi", "--query-gpu=name,compute_cap,memory.total,driver_version", "--format=csv,noheader"]);
    if (q.ok) {
      smi = "found";
      gpus = parseNvidiaSmi(q.out);
    } else {
      smi = "error";
      notes.push(`nvidia-smi failed: ${q.err.split("\n")[0]}`);
    }
  }
  const images: DoctorReport["images"] = [];
  if (info.ok) {
    const im = run(["docker", "images", "--filter", "reference=lineage/*", "--format", "{{.Repository}}:{{.Tag}} {{.ID}}"]);
    for (const l of im.out.split("\n")) {
      const [ref, id] = l.trim().split(/\s+/);
      if (ref && id) images.push({ ref, id });
    }
    if (!images.length) notes.push("no lineage/* images present; build them from images/ before replaying");
  }
  return {
    capabilities: { arch, cpus: Math.max(1, Math.floor(cpuCount)), memory_mb: Math.max(64, memMb), gpus },
    docker: { reachable: info.ok, arch_raw: archRaw, ...(info.ok ? {} : { error: info.err.split("\n")[0] }) },
    images,
    nvidia_smi: smi,
    notes,
  };
}
