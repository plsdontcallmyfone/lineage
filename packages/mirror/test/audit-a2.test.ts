import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChain } from "../src/chain.ts";
import { git } from "../src/git.ts";
import { SAFE_REF } from "../src/prbot.ts";

// Offchain audit A2 (docs/AUDIT.md, Offchain): values from Core never reach git argv as options,
// and git never echoes the auth header.

const tmp = mkdtempSync(join(tmpdir(), "lineage-a2-mirror-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test("OFF-G3 a snapshot commit from Core that is not a sha never reaches git (no --upload-pack injection)", async () => {
  const marker = join(tmp, "pwned");
  const lineage = { lineage_id: "l", repo: "r", snapshot: { commit_sha: `--upload-pack=touch ${marker}` }, recipe: { name: "x" }, status: "active", tip: "t", height: 0, generations: [] };
  await expect(buildChain({ core: {} as never, lineage, identities: {} as never, repoGitUrl: join(tmp, "nope"), site: "s", dir: join(tmp, "chain") } as never)).rejects.toThrow(/40-hex/);
  expect(existsSync(marker)).toBe(false);
});

test("OFF-G3 default branch names from Core are plain refs", () => {
  for (const ok of ["main", "master", "release/1.2", "dev_x"]) expect(SAFE_REF.test(ok)).toBe(true);
  for (const bad of ["--upload-pack=x", "-x", "a..b", "a b", "a//b", ""]) expect(SAFE_REF.test(bad)).toBe(false);
});

test("OFF-G1 git runs with tracing off even when the parent environment turned it on", () => {
  process.env.GIT_TRACE = "1";
  process.env.GIT_CURL_VERBOSE = "1";
  try {
    const r = git(tmp, ["--version"]);
    expect(r.err).not.toContain("trace:");
  } finally {
    delete process.env.GIT_TRACE;
    delete process.env.GIT_CURL_VERBOSE;
  }
});
