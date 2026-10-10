import { describe, expect, test } from "bun:test";
import { brandNeutralTrailers } from "../src/index.ts";

describe("commit trailer brands", () => {
  test("Lineage-* trailers pass through unchanged", () => {
    const t = { "Lineage-Generation": "g", "Lineage-Height": "3", "Co-Authored-By": "x" };
    expect(brandNeutralTrailers(t)).toEqual(t);
  });
  test("Units-* trailers read as Lineage-*", () => {
    expect(brandNeutralTrailers({ "Units-Generation": "g", "Units-Lineage": "l", Other: "o" })).toEqual({ "Lineage-Generation": "g", "Lineage-Lineage": "l", Other: "o" });
  });
  test("a commit mixing both prefixes keeps no branded trailer", () => {
    expect(brandNeutralTrailers({ "Units-Generation": "g", "Lineage-Height": "3", Other: "o" })).toEqual({ Other: "o" });
  });
});
