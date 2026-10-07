import { describe, expect, test } from "bun:test";
import { doctor, normalizeArch, parseNvidiaSmi } from "../src/doctor.ts";

describe("doctor (SPEC 6.1)", () => {
  test("architecture names map onto the recipe vocabulary", () => {
    expect(normalizeArch("aarch64")).toBe("arm64");
    expect(normalizeArch("x86_64")).toBe("amd64");
    expect(normalizeArch("riscv64")).toBeNull();
  });

  test("nvidia-smi csv rows become gpu capabilities", () => {
    const out = "NVIDIA GeForce RTX 4090, 8.9, 24564 MiB, 550.54.15\nNVIDIA H100 80GB HBM3, 9.0, 81559 MiB, 555.42.02\n";
    expect(parseNvidiaSmi(out)).toEqual([
      { vendor: "nvidia", model: "NVIDIA GeForce RTX 4090", sm: "8.9", mem_gb: 24, driver: "550.54.15" },
      { vendor: "nvidia", model: "NVIDIA H100 80GB HBM3", sm: "9.0", mem_gb: 79.6, driver: "555.42.02" },
    ]);
    expect(parseNvidiaSmi("garbage\n")).toEqual([]);
  });

  test("reads docker, falls back to the host when docker is unreachable", () => {
    const fake = (answers: Record<string, { ok: boolean; out: string; err?: string }>) => (cmd: string[]) => {
      const k = cmd.join(" ");
      const hit = Object.entries(answers).find(([p]) => k.startsWith(p));
      return hit ? { ok: hit[1].ok, out: hit[1].out, err: hit[1].err ?? "" } : { ok: false, out: "", err: "not found" };
    };
    const up = doctor(
      fake({
        "docker info": { ok: true, out: "x86_64|16|34359738368" },
        "sh -c command -v nvidia-smi": { ok: true, out: "/usr/bin/nvidia-smi" },
        "nvidia-smi": { ok: true, out: "NVIDIA L4, 8.9, 23034 MiB, 550.90.07" },
        "docker images": { ok: true, out: "lineage/cuda:m1 abc123\n" },
      }),
    );
    expect(up.capabilities).toEqual({ arch: "amd64", cpus: 16, memory_mb: 32768, gpus: [{ vendor: "nvidia", model: "NVIDIA L4", sm: "8.9", mem_gb: 22.5, driver: "550.90.07" }] });
    expect(up.images).toEqual([{ ref: "lineage/cuda:m1", id: "abc123" }]);
    const down = doctor(fake({ "docker info": { ok: false, out: "", err: "Cannot connect" }, "uname -m": { ok: true, out: "arm64" } }));
    expect(down.docker.reachable).toBe(false);
    expect(down.capabilities.arch).toBe("arm64");
    expect(down.notes.join(" ")).toContain("docker not reachable");
  });
});
