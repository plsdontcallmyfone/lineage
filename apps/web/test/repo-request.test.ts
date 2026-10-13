import { expect, test } from "bun:test";
import { pledgeUsd } from "../src/metric-words.ts";

// The pledge field of "Request a repository": US dollars to the cent, empty means none, and anything
// that is not a plain figure is refused before the wallet is asked to sign.
test("a pledge is US dollars to the cent; empty is none; anything else is refused", () => {
  expect(pledgeUsd("")).toBe(0);
  expect(pledgeUsd("  ")).toBe(0);
  expect(pledgeUsd("250")).toBe(250);
  expect(pledgeUsd("$1,250.129")).toBe(1250.13);
  expect(pledgeUsd("0.004")).toBe(0);
  expect(pledgeUsd("100000")).toBe(100_000);
  for (const bad of ["100001", "-5", "1e3", "ten", "5 dollars", "1.2.3", "Infinity"]) expect(pledgeUsd(bad)).toBeNull();
  expect(pledgeUsd("50", 20)).toBeNull();
});
