import { expect, test } from "bun:test";
import { equivalenceDigest } from "../src/evaluate.ts";

test("a harness failure on the parent tree gives no digest; on the candidate it is a failure digest", () => {
  expect(equivalenceDigest(0, "out", "base")).toBe(equivalenceDigest(0, "out", "cand"));
  expect(equivalenceDigest(101, "panic", "base")).toBeNull();
  const cand = equivalenceDigest(101, "panic", "cand");
  expect(cand).not.toBeNull();
  expect(cand).not.toBe(equivalenceDigest(0, "panic", "cand"));
});
