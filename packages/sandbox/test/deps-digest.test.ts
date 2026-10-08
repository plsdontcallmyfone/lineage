import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirDigest, VOLATILE_DEPS } from "../src/evaluate.ts";

// Cargo's bookkeeping files in the deps layer differ per machine and run; the layer digest ignores them (W9b).
test("deps layer digest ignores cargo's last-use cache and lock files, not dependency content", () => {
  const dirs = [0, 1].map(() => mkdtempSync(join(tmpdir(), "lineage-deps-digest-")));
  try {
    for (const [i, d] of dirs.entries()) {
      mkdirSync(join(d, "cargo/registry/cache"), { recursive: true });
      writeFileSync(join(d, "cargo/registry/cache/base58-0.2.0.crate"), "crate bytes");
      writeFileSync(join(d, "cargo/.global-cache"), `sqlite last-use ${i}`);
      writeFileSync(join(d, "cargo/.package-cache"), i ? "x" : "");
      writeFileSync(join(d, "cargo/.package-cache-mutate"), "");
    }
    const keep = (rel: string) => !VOLATILE_DEPS.test(rel);
    expect(dirDigest(dirs[0]!)).not.toBe(dirDigest(dirs[1]!));
    expect(dirDigest(dirs[0]!, keep)).toBe(dirDigest(dirs[1]!, keep));
    writeFileSync(join(dirs[1]!, "cargo/registry/cache/base58-0.2.0.crate"), "other bytes");
    expect(dirDigest(dirs[0]!, keep)).not.toBe(dirDigest(dirs[1]!, keep));
    expect(VOLATILE_DEPS.test("cargo/registry/.global-cache-x")).toBe(false);
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
});
