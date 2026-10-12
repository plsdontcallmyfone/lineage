// A sandbox that cannot be started at all is an error of the machine, never a result (cap-nyc1,
// 2026-10-12: a verifier whose working directory had been removed could not spawn docker and reported
// "base build failed" on three units).
import { expect, test } from "bun:test";
import { runContainer, SandboxUnavailable } from "../src/index.ts";

const spec = { image: "lineage/none:none", cmd: "true", cwd: "/", mounts: [], network: false, env: {}, limits: { cpus: 1, memory_mb: 256, pids: 64, wall_s: 5, disk_mb: 64 }, timeout_s: 5, job: "unavailable-test" };

test("docker not on the PATH: SandboxUnavailable, not a failed run", async () => {
  const path = process.env.PATH;
  const slots = process.env.UNITS_SANDBOX_SLOTS;
  process.env.PATH = "/nonexistent";
  delete process.env.UNITS_SANDBOX_SLOTS;
  try {
    await expect(runContainer(spec as never)).rejects.toBeInstanceOf(SandboxUnavailable);
  } finally {
    process.env.PATH = path;
    if (slots !== undefined) process.env.UNITS_SANDBOX_SLOTS = slots;
  }
});

const dockerUp = Bun.spawnSync(["docker", "info"]).exitCode === 0;
test.skipIf(!dockerUp)("an image that does not exist (docker exit 125): SandboxUnavailable", async () => {
  await expect(runContainer(spec as never)).rejects.toThrow(/could not be started/);
});
