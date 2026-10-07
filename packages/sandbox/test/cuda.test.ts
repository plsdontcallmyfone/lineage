import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerArgs, gpuDeviceRequest, withHostLock, loadRecipe, parseCsvLine, parseMetric, parseNcuInst, parseNvidiaSmiGpus } from "../src/index.ts";

// cuda class support (SPEC 6.1). The ncu texts below are FORMAT SAMPLES written by hand from the
// documented `ncu --csv` layout (Nsight Compute CLI, "details" page and "--page raw"); the numbers
// are made up to exercise the parser and are NOT measurements of anything.

const ROOT = join(import.meta.dir, "../../..");

const LONG = `==PROF== Connected to process 4242 (/work/base/build/lineage_harness)
==PROF== Profiling "reduce_sum_kernel" - 0: 0%....50%....100% - 1 pass
==PROF== Profiling "reduce_sum_kernel" - 1: 0%....50%....100% - 1 pass
==PROF== Profiling "row_scale_kernel(int *, const int *, int, int)" - 2: 0%....50%....100% - 1 pass
==PROF== Disconnected from process 4242
"ID","Process ID","Process Name","Host Name","Kernel Name","Context","Stream","Block Size","Grid Size","Device","CC","Section Name","Metric Name","Metric Unit","Metric Value"
"0","4242","lineage_harness","127.0.0.1","reduce_sum_kernel(const int *, unsigned long long *, int)","1","7","(256, 1, 1)","(16385, 1, 1)","0","8.9","Command line profiler metrics","smsp__inst_executed.sum","inst","1,234,567"
"1","4242","lineage_harness","127.0.0.1","reduce_sum_kernel(const int *, unsigned long long *, int)","1","7","(256, 1, 1)","(16385, 1, 1)","0","8.9","Command line profiler metrics","smsp__inst_executed.sum","inst","1,000"
"2","4242","lineage_harness","127.0.0.1","row_scale_kernel(int *, const int *, int, int)","1","7","(128, 1, 1)","(17, 1, 1)","0","8.9","Command line profiler metrics","smsp__inst_executed.sum","inst","98765"
"2","4242","lineage_harness","127.0.0.1","row_scale_kernel(int *, const int *, int, int)","1","7","(128, 1, 1)","(17, 1, 1)","0","8.9","Command line profiler metrics","gpu__time_duration.sum","nsecond","5,120"
`;

const RAW = `==PROF== Connected to process 77 (/work/cand/build/lineage_harness)
"ID","Process ID","Process Name","Host Name","Kernel Name","Context","Stream","Block Size","Grid Size","Device","CC","smsp__inst_executed.sum"
"","","","","","","","","","","","inst"
"0","77","lineage_harness","127.0.0.1","reduce_sum_kernel(const int *, unsigned long long *, int)","1","7","(256, 1, 1)","(16385, 1, 1)","0","8.9","2,000"
"1","77","lineage_harness","127.0.0.1","row_scale_kernel(int *, const int *, int, int)","1","7","(128, 1, 1)","(17, 1, 1)","0","8.9","300"
`;

describe("ncu-inst parser (format samples, not measurements)", () => {
  test("csv quoting keeps commas inside kernel signatures", () => {
    expect(parseCsvLine(`"a","f(int *, int)","1,000",""`)).toEqual(["a", "f(int *, int)", "1,000", ""]);
    expect(parseCsvLine(`"say ""hi""",x`)).toEqual([`say "hi"`, "x"]);
  });

  test("long format: sums the metric over matching launches, ignores other metrics and ==PROF== lines", () => {
    expect(parseNcuInst(LONG)).toBe(1_234_567 + 1_000 + 98_765);
    expect(parseNcuInst(LONG, "^reduce_sum_kernel")).toBe(1_235_567);
    expect(parseNcuInst(LONG, "row_scale")).toBe(98_765);
  });

  test("auto-scaled units are converted back to instructions", () => {
    const scaled = LONG.replace(`"inst","1,234,567"`, `"Minst","1.234567"`);
    expect(parseNcuInst(scaled, "^reduce_sum_kernel")).toBe(1_235_567);
    expect(() => parseNcuInst(LONG.replace(`"inst","98765"`, `"byte","98765"`), "row_scale")).toThrow(/unexpected ncu unit/);
  });

  test("raw page format with a units row", () => {
    expect(parseNcuInst(RAW)).toBe(2_300);
    expect(parseNcuInst(RAW, "reduce")).toBe(2_000);
  });

  test("parseMetric dispatches ncu-inst and ncu-inst:<regex>, reading stdout then stderr", () => {
    expect(parseMetric("ncu-inst", LONG, "")).toBe(1_334_332);
    expect(parseMetric("ncu-inst:row_scale_kernel", "", LONG)).toBe(98_765);
  });

  test("failures are errors, never zero", () => {
    expect(() => parseNcuInst("==ERROR== ERR_NVGPUCTRPERM - The user does not have permission to access NVIDIA GPU Performance Counters")).toThrow(/header not found/);
    expect(() => parseNcuInst(LONG, "no_such_kernel")).toThrow(/no smsp__inst_executed.sum rows/);
    const bad = LONG.replace(`"98765"`, `"n/a"`);
    expect(() => parseNcuInst(bad, "row_scale")).toThrow(/not a number/);
  });
});

describe("GPU device requests", () => {
  const base = {
    image: "x",
    cmd: "true",
    cwd: "/w",
    mounts: [],
    network: false,
    env: {},
    limits: { cpus: 1, memory_mb: 512, pids: 64, wall_s: 10, disk_mb: 100 },
    timeout_s: 10,
    job: "j",
  };

  test("--gpus only when requested, and no capability is added back", () => {
    const off = dockerArgs(base, "n");
    expect(off).not.toContain("--gpus");
    const on = dockerArgs({ ...base, gpus: "device=0" }, "n");
    const i = on.indexOf("--gpus");
    expect(on[i + 1]).toBe("device=0");
    const joined = on.join(" ");
    for (const flag of ["--cap-drop ALL", "no-new-privileges", "--read-only", "--network none", "--user 10001:10001"]) expect(joined).toContain(flag);
    expect(joined).not.toContain("--cap-add");
    expect(joined).not.toContain("--privileged");
    expect(i).toBeLessThan(on.indexOf("x")); // before the image
  });

  test("LINEAGE_GPU_DEVICE selects one GPU index", () => {
    const prev = process.env.LINEAGE_GPU_DEVICE;
    try {
      delete process.env.LINEAGE_GPU_DEVICE;
      expect(gpuDeviceRequest()).toBe("device=0");
      process.env.LINEAGE_GPU_DEVICE = "3";
      expect(gpuDeviceRequest()).toBe("device=3");
      process.env.LINEAGE_GPU_DEVICE = "all";
      expect(() => gpuDeviceRequest()).toThrow();
    } finally {
      if (prev === undefined) delete process.env.LINEAGE_GPU_DEVICE;
      else process.env.LINEAGE_GPU_DEVICE = prev;
    }
  });

  test("nvidia-smi query output (format sample)", () => {
    const out = "0, NVIDIA L4, 8.9, 570.172.08, 23034\n1, NVIDIA A10G, 8.6, 570.172.08, 23028\n";
    expect(parseNvidiaSmiGpus(out)).toEqual([
      { index: 0, name: "NVIDIA L4", sm: "8.9", driver: "570.172.08", mem_mb: 23034 },
      { index: 1, name: "NVIDIA A10G", sm: "8.6", driver: "570.172.08", mem_mb: 23028 },
    ]);
    expect(parseNvidiaSmiGpus("NVIDIA-SMI has failed")).toEqual([]);
  });
});

describe("cuda recipes load and validate", () => {
  for (const name of ["fixture-cuda", "llmc-cuda"]) {
    test(name, () => {
      const l = loadRecipe(join(ROOT, "recipes", name));
      expect(l.recipe.class).toBe("cuda");
      expect(l.recipe.requires.arch).toBe("amd64");
      expect(l.recipe.requires.gpu?.vendor).toBe("nvidia");
      expect(l.overlayFiles.length).toBeGreaterThan(0);
      for (const m of l.recipe.metrics.filter((m) => m.deterministic)) expect(m.parser.startsWith("ncu-inst")).toBe(true);
      // every build/metric command targets the recipe's compute capability
      const sm = l.recipe.requires.gpu!.sm.replace(".", "");
      for (const c of l.recipe.build.commands) if (/nvcc|make/.test(c)) expect(c).toContain(sm);
    });
  }
});

describe("host GPU lock", () => {
  test("serialises holders and takes over a lock whose owner is gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lineage-lock-"));
    try {
      const log: string[] = [];
      const job = (n: string) =>
        withHostLock(dir, "gpu-0", async () => {
          log.push(`${n}+`);
          await Bun.sleep(30);
          log.push(`${n}-`);
        }, 5);
      await Promise.all([job("a"), job("b"), job("c")]);
      for (let i = 0; i < log.length; i += 2) expect(log[i + 1]).toBe(log[i]!.replace("+", "-"));
      // stale: a pid that cannot exist
      mkdirSync(join(dir, "gpu-1.lock"));
      writeFileSync(join(dir, "gpu-1.lock", "pid"), "999999999");
      expect(await withHostLock(dir, "gpu-1", async () => 7, 5)).toBe(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
