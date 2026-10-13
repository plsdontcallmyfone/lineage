// A verifier restarted between the commit and the reveal of a calibration (a deploy) still reveals:
// the salt and the result are kept on disk, not only in memory.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CalibrationVerifier } from "../src/recipe-proposer.ts";

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

function verifier(file: string, assignments: unknown[]) {
  const v = new CalibrationVerifier("http://127.0.0.1:1", { id: "v" } as never, () => {}, undefined, file);
  const posts: { path: string; body: any }[] = [];
  const c = v.client as any;
  c.get = async () => ({ status: 200, body: assignments });
  c.post = async (path: string, body: unknown) => {
    posts.push({ path, body });
    return { status: 200, body: { proposal: "accepted" } };
  };
  return { v, posts };
}

test("a calibration committed before a restart is revealed after it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "units-calib-"));
  tmp.push(dir);
  const file = join(dir, "calibrations.json");
  const kept = { calibration: { stable: ["t"], known_failures: [], metrics: {} }, deps_digest: "d", salt: "5a17" };
  writeFileSync(file, JSON.stringify({ r1: kept, gone: kept }));

  const { v, posts } = verifier(file, [{ replay_id: "r1", status: "committed", reveal_open: true }]);
  expect(v.pendingReveals).toBe(2);
  expect(await v.once()).toBe(1);
  expect(posts).toEqual([{ path: "/v1/recipe-proposals/replays/r1/reveal", body: kept }]);
  // revealed, and the one Core no longer lists was dropped
  expect(v.pendingReveals).toBe(0);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("a kept calibration waits while the other verifier has not committed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "units-calib-"));
  tmp.push(dir);
  const file = join(dir, "calibrations.json");
  const kept = { calibration: { stable: [], known_failures: [], metrics: {} }, deps_digest: "d", salt: "aa" };
  writeFileSync(file, JSON.stringify({ r1: kept }));
  const { v, posts } = verifier(file, [{ replay_id: "r1", status: "committed", reveal_open: false }]);
  expect(await v.once()).toBe(0);
  expect(posts).toEqual([]);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ r1: kept });
});
