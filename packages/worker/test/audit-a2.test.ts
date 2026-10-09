import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRecipe } from "@lineage/sandbox";
import { materializeProposal } from "../src/recipe-proposer.ts";
import { writeNewSecret, writeSecret } from "../src/secret-file.ts";
import { measureCoalitions } from "../src/split.ts";

// Offchain audit A2 (docs/AUDIT.md, Offchain): what the worker does with values a compromised Core
// sends, and the modes of the files that hold its secrets.

const ROOT = join(import.meta.dir, "../../..");
const tmp: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "lineage-a2-wk-"));
  tmp.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

test("OFF-K1 a recipe id from Core cannot delete or write outside the proposals directory", async () => {
  const d = scratch();
  // join(root, name + "-" + recipe_id.slice(0, 12)) with this id resolves to <d>/v
  const victim = join(d, "v");
  mkdirSync(victim);
  writeFileSync(join(victim, "keep.txt"), "keep");
  const root = join(d, "a", "proposals");
  mkdirSync(root, { recursive: true });
  const client = { request: async () => ({ status: 404, body: null }) } as never;
  const recipe = { ...loadRecipe(join(ROOT, "recipes/fixture-b58")).recipe, name: "ok-name" };
  await expect(materializeProposal(client, { recipe, recipe_id: "/../../../v/" + "0".repeat(52), overlay: {} } as never, root)).rejects.toThrow(/recipe_id/);
  expect(existsSync(join(victim, "keep.txt"))).toBe(true);
  await expect(materializeProposal(client, { recipe: { ...recipe, name: "../../x" }, recipe_id: "0".repeat(64), overlay: {} } as never, root)).rejects.toThrow(/name/);
});

describe("OFF-K2 secret files are 0600 from the first byte", () => {
  test("a new key file is created 0600 even under umask 0, and never overwrites", () => {
    const d = scratch();
    const old = process.umask(0);
    try {
      writeNewSecret(join(d, "key.json"), "[1,2,3]");
    } finally {
      process.umask(old);
    }
    expect(statSync(join(d, "key.json")).mode & 0o777).toBe(0o600);
    expect(() => writeNewSecret(join(d, "key.json"), "[4]")).toThrow();
  });

  test("pending replay state (salts, unrevealed results) is rewritten 0600 even if the old file was 0644", () => {
    const d = scratch();
    const f = join(d, "pending.json");
    writeFileSync(f, "{}", { mode: 0o644 });
    writeSecret(f, JSON.stringify({ r: { salt: "s" } }));
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });
});

test("OFF-K5 a measured split with a huge n from Core is refused before any work", async () => {
  const loaded = { ...loadRecipe(join(ROOT, "recipes/fixture-b58")), recipe: { ...loadRecipe(join(ROOT, "recipes/fixture-b58")).recipe, repo: "fixture:does-not-exist" } };
  const main = { apply: "ok", guard: "ok", build: { base: "ok", cand: "ok" } } as never;
  const logs: string[] = [];
  const r = await measureCoalitions({
    loaded,
    deps: { dir: scratch(), digest: "0".repeat(64) },
    parentPatches: [],
    candidatePatch: "",
    split: { n: 30, metric: "ir", subs: Array(30).fill("x") } as never,
    seed: "5eed",
    main,
    mainSeconds: 1,
    log: (m) => logs.push(m),
  });
  expect(r.compose).toBe("skipped");
  expect(logs.some((l) => l.includes("refusing"))).toBe(true);
});
