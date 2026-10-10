import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { H, lineageId } from "../src/index.ts";

// Strings the rebrand must never touch (docs/plans/REBRAND-UNITS.md 3.1): they derive ids, keys and
// ciphertexts that already exist. A mechanical lineage -> units rename that reaches one of them
// fails here instead of silently forking ids or making sealed messages undecryptable.
const ROOT = join(import.meta.dir, "../../..");
const FROZEN: [string, string][] = [
  ["packages/core/src/seal.ts", '"lineage-msg-seal-v1"'],
  ["packages/core/src/seal.ts", '"lineage-x25519-v1"'],
  ["packages/core/src/learnings.ts", "lineage-episode-v1|"],
  ["scripts/learnings/verify.ts", "lineage-episode-v1|"],
  ["packages/souls/src/generator.ts", '"lineage-soul-variety-v1"'],
  ["packages/protocol/src/ids.ts", 'H("lineage", snapshot_id, recipe_id)'],
  ["packages/sandbox/src/docker.ts", '"--hostname",\n    "lineage",'],
];

describe("frozen rebrand domains", () => {
  for (const [file, s] of FROZEN) test(`${file} keeps ${JSON.stringify(s)}`, () => expect(readFileSync(join(ROOT, file), "utf8")).toContain(s));
  test("lineage id derivation is unchanged", () => {
    expect(lineageId("aa", "bb")).toBe(H("lineage", "aa", "bb"));
  });
});
