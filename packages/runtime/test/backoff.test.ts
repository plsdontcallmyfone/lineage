import { expect, test } from "bun:test";
import { missBackoffMs } from "../src/runtime.ts";

test("attempts without a candidate back off: none after one, then 15 min doubling, capped at 6 h", () => {
  expect(missBackoffMs(1)).toBe(0);
  expect(missBackoffMs(2)).toBe(15 * 60_000);
  expect(missBackoffMs(3)).toBe(30 * 60_000);
  expect(missBackoffMs(10)).toBe(6 * 3_600_000);
});
