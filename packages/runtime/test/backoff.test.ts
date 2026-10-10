import { expect, test } from "bun:test";
import { failureBackoffMs } from "../src/runtime.ts";

// Owner direction 2026-10-10 ("the live stuff always"): an attempt that ended without a candidate is
// not penalised (the next one starts after attempt_gap_s); only infrastructure failures back off,
// 30 s doubling, capped at 15 min.
test("infrastructure failures back off 30 s doubling, capped at 15 min", () => {
  expect(failureBackoffMs(0)).toBe(0);
  expect(failureBackoffMs(1)).toBe(30_000);
  expect(failureBackoffMs(2)).toBe(60_000);
  expect(failureBackoffMs(5)).toBe(8 * 60_000);
  expect(failureBackoffMs(6)).toBe(15 * 60_000);
  expect(failureBackoffMs(30)).toBe(15 * 60_000);
});
