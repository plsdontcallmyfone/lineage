#!/usr/bin/env bun
// GPU BOX ONLY. Proves the cuda sandbox works with the EXACT flags replays use (packages/sandbox
// dockerArgs: uid 10001, --cap-drop ALL, no-new-privileges, read-only root, no network) plus
// `--gpus device=N`, and that Nsight Compute can read performance counters in it.
// Usage: bun scripts/gpu/doctor-gpu.ts <image ref or id> [--out results/doctor-gpu.json]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gpuDeviceRequest, hostGpus, parseNcuInst, runContainer } from "@lineage/sandbox";

const image = process.argv[2];
if (!image) {
  console.error("usage: bun scripts/gpu/doctor-gpu.ts <image> [--out file]");
  process.exit(2);
}
const outIdx = process.argv.indexOf("--out");
const OUT = outIdx > 0 ? process.argv[outIdx + 1]! : join(import.meta.dir, "..", "..", "results", "doctor-gpu.json");
const report: Record<string, unknown> = { at: new Date().toISOString(), image };
const checks: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  checks.push({ check: name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

const gpus = hostGpus();
report.host_gpus = gpus;
check("nvidia-smi sees a GPU on the host", gpus.length > 0, gpus.map((g) => `${g.index}: ${g.name} sm ${g.sm} driver ${g.driver}`).join("; "));
const drv = gpus[0]?.driver.split(".").map(Number) ?? [0];
check("driver >= 560.35 (CUDA 12.6.3 toolkit in the image)", drv[0]! > 560 || (drv[0] === 560 && (drv[1] ?? 0) >= 35), gpus[0]?.driver ?? "none");
const params = Bun.spawnSync(["sh", "-c", "grep -i -E \"RestrictProfiling|RmProfilingAdminOnly\" /proc/driver/nvidia/params || true"]).stdout.toString().trim();
report.profiling_param = params;
check("host opens GPU performance counters to non-admin users", /(RestrictProfilingToAdminUsers|RmProfilingAdminOnly):\s*0/.test(params), params || "param not found (R610+ capability nodes may still grant access; the ncu run below decides)");

const dir = mkdtempSync(join(tmpdir(), "lineage-doctor-gpu-"));
chmodSync(dir, 0o777);
writeFileSync(
  join(dir, "probe.cu"),
  `#include <cstdio>
__global__ void lineage_probe(int* x, int n) { int i = blockIdx.x * blockDim.x + threadIdx.x; if (i < n) x[i] = x[i] * 3 + i; }
int main() { int* d; int n = 1 << 20; cudaMalloc(&d, n * sizeof(int)); cudaMemset(d, 0, n * sizeof(int));
  lineage_probe<<<(n + 255) / 256, 256>>>(d, n); cudaError_t e = cudaDeviceSynchronize(); printf("%s\\n", cudaGetErrorString(e)); return e != cudaSuccess; }
`,
);
const limits = { cpus: 2, memory_mb: 4096, pids: 256, wall_s: 600, disk_mb: 4096 };
const gpusFlag = gpuDeviceRequest();
const base = { image, cwd: "/work/src", mounts: [{ host: dir, container: "/work/src" }], network: false, env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" }, limits, timeout_s: 600, job: "doctor-gpu", gpus: gpusFlag };
try {
  const who = await runContainer({ ...base, cmd: "id -u; nvidia-smi --query-gpu=name,compute_cap --format=csv,noheader; (touch /etc/x 2>/dev/null && echo rw) || echo ro" });
  report.container_identity = who;
  check("GPU visible inside the hardened sandbox (uid 10001, read-only root)", who.exit === 0 && who.stdout.startsWith("10001") && /\bro$/.test(who.stdout.trim()), who.stdout.trim().replace(/\n/g, " | ") + who.stderr.slice(0, 300));
  const sm = gpus[0]?.sm.replace(".", "") ?? "86";
  const build = await runContainer({ ...base, cmd: `nvcc -O3 -arch=sm_${sm} -o probe probe.cu && ./probe` });
  check("nvcc builds and a kernel runs in the sandbox", build.exit === 0 && build.stdout.includes("no error"), (build.stdout + build.stderr).slice(-400));
  const counts: number[] = [];
  for (let i = 0; i < 2; i++) {
    const r = await runContainer({ ...base, cmd: "ncu --csv --print-units base --clock-control none --metrics smsp__inst_executed.sum -k regex:lineage_probe ./probe" });
    report[`ncu_run_${i}`] = { exit: r.exit, stdout: r.stdout.slice(-3000), stderr: r.stderr.slice(-2000) };
    try {
      counts.push(parseNcuInst(r.stdout + "\n" + r.stderr, "lineage_probe"));
    } catch (e) {
      check(`ncu run ${i} produced a warp instruction count`, false, `${(e as Error).message}; ${(r.stdout + r.stderr).match(/==ERROR==.*$/m)?.[0] ?? (r.stdout + r.stderr).slice(-300)}`);
    }
  }
  if (counts.length === 2) {
    check("ncu reads smsp__inst_executed.sum without extra capabilities", counts[0]! > 0, `${counts[0]} warp instructions`);
    check("the count is identical across two runs", counts[0] === counts[1], counts.join(" vs "));
  }
  report.counts = counts;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
report.checks = checks;
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
const bad = checks.filter((c) => !c.ok && !c.check.startsWith("host opens"));
console.log(`${checks.length - checks.filter((c) => !c.ok).length}/${checks.length} checks passed; wrote ${OUT}`);
process.exit(bad.length ? 1 : 0);
