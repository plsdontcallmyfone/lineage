import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { calibrate, evaluate, imageDigest, loadRecipe, prepareDeps, readLocalImageMap, runContainer, runnableImage } from "../src/index.ts";

// Real Docker integration tests. Skipped when Docker is not reachable.
const dockerUp = Bun.spawnSync(["docker", "info"]).exitCode === 0;
const ROOT = join(import.meta.dir, "../../..");
const PATCHES = join(ROOT, "fixtures/b58-patches");
const d = dockerUp ? describe : describe.skip;

d("sandbox (docker)", () => {
  const loaded = loadRecipe(join(ROOT, "recipes/fixture-b58"));
  const limits = loaded.recipe.limits;

  test("no network, read-only root, non-root user, timeout kills", async () => {
    const image = runnableImage(loaded.recipe.image);
    const r = await runContainer({
      image,
      cmd: "id -u; (touch /etc/x 2>/dev/null && echo rw) || echo ro; (getent hosts github.com >/dev/null 2>&1 && echo net) || echo nonet",
      cwd: "/tmp",
      mounts: [],
      network: false,
      env: {},
      limits,
      timeout_s: 60,
      job: "test-iso",
    });
    expect(r.stdout.trim().split("\n")).toEqual(["10001", "ro", "nonet"]);
    const t = await runContainer({ image, cmd: "sleep 30", cwd: "/tmp", mounts: [], network: false, env: {}, limits, timeout_s: 2, job: "test-timeout" });
    expect(t.timed_out).toBe(true);
    expect(t.exit).toBe(124);
  }, 60_000);

  test("image is pinned to the recipe digest (or its explicit local rebuild)", async () => {
    // committed id when Docker has it; on a fresh clone, the rebuild named by the local pin map
    expect(await imageDigest(loaded.recipe.image)).toBe(runnableImage(loaded.recipe.image));
    const pinned = loaded.recipe.image.split("@")[1]!;
    if (runnableImage(loaded.recipe.image) !== pinned) {
      const entry = readLocalImageMap().images[pinned.replace(/^sha256:/, "")];
      expect(entry && `sha256:${entry.local}`).toBe(runnableImage(loaded.recipe.image));
    }
  });

  test("calibration and a full replay are deterministic across runs", async () => {
    const deps = await prepareDeps(loaded);
    const c = await calibrate({ loaded, deps, seed: "aa", runs: 2 });
    expect(c.calibration.stable).toHaveLength(4);
    expect(c.calibration.known_failures).toEqual(["tests/basic.rs::decode_leading_ones_are_zero_bytes"]);
    expect(c.calibration.metrics.encode_ir!.enabled).toBe(true);
    const patch = readFileSync(join(PATCHES, "perf_encode.diff"), "utf8");
    const a = await evaluate({ loaded, deps, parentPatches: [], candidatePatch: patch, seed: "bb" });
    const b = await evaluate({ loaded, deps, parentPatches: [], candidatePatch: patch, seed: "bb" });
    expect(a.result.metrics.encode_ir).toEqual(b.result.metrics.encode_ir);
    expect(a.result.build.cand_digest).toBe(b.result.build.cand_digest!);
    expect(a.result.equivalence).toEqual(b.result.equivalence);
    expect(a.result.metrics.encode_ir!.cand[0]!).toBeLessThan(a.result.metrics.encode_ir!.base[0]!);
    // holdout: a different seed gives different instruction counts
    const c2 = await evaluate({ loaded, deps, parentPatches: [], candidatePatch: patch, seed: "cc" });
    expect(c2.result.metrics.encode_ir!.base[0]).not.toBe(a.result.metrics.encode_ir!.base[0]);
  }, 300_000);

  test("parent series is applied before the candidate; conflicts are reported", async () => {
    const deps = await prepareDeps(loaded);
    const perf = readFileSync(join(PATCHES, "perf_encode.diff"), "utf8");
    const stale = readFileSync(join(PATCHES, "stale_conflict.diff"), "utf8");
    const dec = readFileSync(join(PATCHES, "perf_decode.diff"), "utf8");
    const conflict = await evaluate({ loaded, deps, parentPatches: [perf], candidatePatch: stale, seed: "dd" });
    expect(conflict.result.apply).toBe("conflict");
    expect(conflict.result.build.base).toBe("ok");
    const rebased = await evaluate({ loaded, deps, parentPatches: [perf], candidatePatch: dec, seed: "dd" });
    expect(rebased.result.apply).toBe("ok");
    expect(rebased.result.metrics.decode_ir!.cand[0]!).toBeLessThan(rebased.result.metrics.decode_ir!.base[0]!);
  }, 300_000);
});
