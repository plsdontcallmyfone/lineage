import { describe, expect, test } from "bun:test";
import { DRY_KEPT, dryLine, dryLineOf } from "../src/dry-line.ts";

describe("the dry line on the unit and project pages", () => {
  const line = "Most recent attempts found nothing more to improve here: 9 of the last 12 ended without an improvement.";
  test("shown only for a dry unit, as Core wrote it", () => {
    expect(dryLine({ dry: true, line })).toBe(line);
    expect(dryLine({ dry: false, line })).toBe("");
    expect(dryLine({ dry: true, line: null })).toBe("");
    expect(dryLine(null)).toBe("");
    expect(dryLine(undefined)).toBe("");
  });
  test("no em dash, one line, bounded", () => {
    expect(dryLine({ dry: true, line: `a ${String.fromCharCode(0x2014)} b\n c` })).toBe("a , b c");
    expect(dryLine({ dry: true, line: "x".repeat(301) })).toBe("");
    expect(DRY_KEPT).not.toContain(String.fromCharCode(0x2014));
  });
  test("one unit of a list answer; a Core without the route gives nothing", () => {
    const list = { units: [{ lineage_id: "a", dry: true, line }, { lineage_id: "b", dry: false, line: null }] };
    expect(dryLineOf(list, "a")).toBe(line);
    expect(dryLineOf(list, "b")).toBe("");
    expect(dryLineOf(list, "c")).toBe("");
    expect(dryLineOf(null, "a")).toBe("");
  });
});
