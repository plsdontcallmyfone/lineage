import { describe, expect, test } from "bun:test";
import { dockerArgs, dockerRuntime } from "../src/docker.ts";

describe("LINEAGE_DOCKER_RUNTIME", () => {
  test("unset means the default runtime; a name is passed as --runtime; junk is refused", () => {
    expect(dockerRuntime({})).toBeNull();
    expect(dockerRuntime({ LINEAGE_DOCKER_RUNTIME: " " })).toBeNull();
    expect(dockerRuntime({ LINEAGE_DOCKER_RUNTIME: "runsc" })).toBe("runsc");
    expect(() => dockerRuntime({ LINEAGE_DOCKER_RUNTIME: "runsc --privileged" })).toThrow(/runtime name/);
    const prev = process.env.LINEAGE_DOCKER_RUNTIME;
    try {
      process.env.LINEAGE_DOCKER_RUNTIME = "runsc";
      const spec = { job: "t", image: "x", cwd: "/work", command: "true", mounts: [], network: false, limits: { cpus: 1, memory_mb: 256, pids: 64, wall_s: 10 } } as any;
      const args = dockerArgs(spec, "n");
      expect(args[args.indexOf("--runtime") + 1]).toBe("runsc");
    } finally {
      if (prev === undefined) delete process.env.LINEAGE_DOCKER_RUNTIME;
      else process.env.LINEAGE_DOCKER_RUNTIME = prev;
    }
  });
});
