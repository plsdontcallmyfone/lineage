// Recipes Core admitted from a proposal (SPEC 6.2) are in no release: a worker reads them from Core
// (ensureRecipe), and an evaluation sent to a sandbox host carries them (EvalJob.proposal).
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@units/protocol";
import { evalJobOf, loadRecipe, type LoadedRecipe } from "@units/sandbox";
import { jobError, writeProposal } from "../src/eval-job.ts";
import { ensureRecipe } from "../src/recipe-proposer.ts";

const ROOT = join(import.meta.dir, "../../..");
const tmp: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "units-proposal-"));
  tmp.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

const src = loadRecipe(join(ROOT, "recipes/base58-py"));
const blobs = new Map<string, Buffer>();
const overlay: Record<string, string> = {};
for (const f of src.overlayFiles) {
  const b = readFileSync(join(src.overlayDir!, f));
  overlay[f] = sha256Hex(b);
  blobs.set(overlay[f]!, b);
}
const accepted = [{ recipe_id: src.recipe_id, recipe: src.recipe, overlay }];

function core(o: { tamper?: boolean } = {}) {
  const calls: string[] = [];
  const client = {
    request: async (_m: string, path: string) => {
      calls.push(path);
      if (path.startsWith("/v1/recipe-proposals")) return { status: 200, body: accepted };
      const b = blobs.get(path.split("/").pop()!);
      if (!b) return { status: 404, body: null };
      const bytes = o.tamper ? Buffer.concat([b, Buffer.from("#")]) : b;
      return { status: 200, body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    },
  } as never;
  return { client, calls };
}
const book = () => {
  const m = new Map<string, LoadedRecipe>();
  return { has: (id: string) => m.has(id), add: (l: LoadedRecipe) => void m.set(l.recipe_id, l), get: (id: string) => m.get(id)! };
};

test("a recipe from an accepted proposal is read from Core once, checked against its id, and kept", async () => {
  const root = scratch();
  const b = book();
  const c = core();
  expect(await ensureRecipe(b, c.client, src.recipe_id, root)).toBe(true);
  const got = b.get(src.recipe_id);
  expect(got.recipe_id).toBe(src.recipe_id);
  expect(got.dir.startsWith(root)).toBe(true);
  expect(got.overlayFiles.sort()).toEqual([...src.overlayFiles].sort());
  // already in the book: nothing is asked again
  const n = c.calls.length;
  expect(await ensureRecipe(b, c.client, src.recipe_id, root)).toBe(true);
  expect(c.calls.length).toBe(n);
  // another process of the same home finds the directory and reads no blob
  const c2 = core();
  expect(await ensureRecipe(book(), c2.client, src.recipe_id, root)).toBe(true);
  expect(c2.calls.filter((p) => p.startsWith("/v1/blobs/")).length).toBe(0);
});

test("an id Core has no accepted proposal for, and a blob that is not what its digest says", async () => {
  expect(await ensureRecipe(book(), core().client, "ab".repeat(32), scratch())).toBe(false);
  expect(await ensureRecipe(book(), core().client, "../../x", scratch())).toBe(false);
  await expect(ensureRecipe(book(), core({ tamper: true }).client, src.recipe_id, scratch())).rejects.toThrow(/digest mismatch/);
});

test("an evaluation of a proposal recipe carries it to the sandbox host; the host uses it only if it recomputes to the job's id", async () => {
  const home = scratch();
  const b = book();
  await ensureRecipe(b, core().client, src.recipe_id, join(home, "proposals"));
  const input = { deps: { digest: "cd".repeat(32) } as never, parentPatches: [], candidatePatch: "", seed: "0123456789abcdef" };
  const job = evalJobOf({ ...input, loaded: b.get(src.recipe_id) });
  expect(Object.keys(job.proposal!.overlay).sort()).toEqual([...src.overlayFiles].sort());
  expect(jobError(job)).toBeNull();
  // a recipe of the release travels without its files, as before
  expect(evalJobOf({ ...input, loaded: src }).proposal).toBeUndefined();
  const host = join(scratch(), "proposals");
  const there = writeProposal(job, host);
  expect(there.recipe_id).toBe(src.recipe_id);
  expect(there.dir.startsWith(host)).toBe(true);
  // a changed harness file is another recipe: refused, nothing left behind
  const first = Object.keys(job.proposal!.overlay)[0]!;
  const bad = { ...job, proposal: { recipe: job.proposal!.recipe, overlay: { ...job.proposal!.overlay, [first]: Buffer.from("print(1)\n").toString("base64") } } };
  const host2 = join(scratch(), "proposals");
  expect(() => writeProposal(bad, host2)).toThrow(/recomputes/);
  expect(existsSync(join(host2, `${src.recipe.name}-${src.recipe_id.slice(0, 12)}`))).toBe(false);
  expect(() => writeProposal({ ...job, proposal: { recipe: job.proposal!.recipe, overlay: { "../x": "" } } }, join(scratch(), "proposals"))).toThrow();
  expect(jobError({ ...job, proposal: { recipe: "x", overlay: {} } })).toMatch(/proposal/);
});
