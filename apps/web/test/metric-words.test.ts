import { expect, test } from "bun:test";
import { daysLabel, deadlineChoices, improvementExample, metricValue, metricWords, publicRepo } from "../src/metric-words.ts";

const perf = (name: string, extra = {}) => ({ name, kind: "perf", direction: "lower", deterministic: true, ...extra });

test("labels come from the metric's own facts, with the raw name after them", () => {
  expect(metricWords(perf("encode_ir")).label).toBe("Encode speed, in CPU instructions (encode_ir)");
  expect(metricWords(perf("train_basic_ir", { parser: "cachegrind-ir" })).label).toBe("Train basic speed, in CPU instructions (train_basic_ir)");
  expect(metricWords({ name: "rlib_bytes", kind: "slim", direction: "lower", deterministic: true }).label).toBe("Library size, in bytes (rlib_bytes)");
  expect(metricWords(perf("write_cu")).label).toBe("Write cost, in Solana compute units (write_cu)");
  expect(metricWords(perf("admin", { parser: "number", cls: "solana" })).sort).toBe("compute_units");
  expect(metricWords({ name: "encode_ns", kind: "perf", direction: "lower" }).label).toBe("Encode time, in nanoseconds (encode_ns)");
  // the parser decides when the name says nothing
  expect(metricWords(perf("hot_path", { parser: "cachegrind-ir" })).noun).toBe("CPU instructions");
});
test("a metric nothing can be derived for keeps its raw name with its kind", () => {
  const w = metricWords({ name: "score", kind: "perf", direction: "higher" });
  expect(w).toMatchObject({ sort: "other", noun: "", label: "score (perf, higher is better)" });
});
test("what is measured: instructions are exact only when the metric is deterministic", () => {
  expect(metricWords(perf("decode_ir")).what).toContain("every replay gets the same number");
  expect(metricWords({ ...perf("decode_ir"), deterministic: false }).what).not.toContain("exact");
});
test("an improvement in the metric's own terms never rounds toward the easy side", () => {
  const m = perf("encode_ir"), w = metricWords(m);
  expect(metricValue(149_988_301, w)).toBe("149,988,301 CPU instructions");
  expect(improvementExample(149_988_301, 5, m, w)).toBe("from 149,988,301 CPU instructions to 142,488,885 or fewer");
  const up = { name: "score", kind: "perf", direction: "higher" };
  expect(improvementExample(1000, 2.55, up, metricWords(up))).toBe("from 1,000 to 1,026 or more");
  const b = { name: "so_bytes", kind: "slim", direction: "lower" };
  expect(improvementExample(24_720, 0.5, b, metricWords(b))).toBe("from 24,720 bytes to 24,596 or less");
  for (const bad of [null, undefined, 0, Number.NaN]) expect(improvementExample(bad as number, 5, m, w)).toBeNull();
  for (const pct of [0, -1, 100, Number.NaN]) expect(improvementExample(1000, pct, m, w)).toBeNull();
});
test("a repository reads owner/repo; a fixture has no public repository", () => {
  expect(publicRepo("https://github.com/karpathy/minbpe")).toBe("karpathy/minbpe");
  expect(publicRepo("https://github.com/keis/base58.git")).toBe("keis/base58");
  expect(publicRepo("fixture:b58")).toBeNull();
  expect(publicRepo(null)).toBeNull();
});
test("deadline choices stay inside the on-chain limits, a week first where allowed", () => {
  expect(deadlineChoices(3600, 2_592_000)).toEqual({ days: [1, 3, 7, 14, 30], first: 7 });
  expect(deadlineChoices(3600, 5 * 86_400)).toEqual({ days: [1, 3], first: 3 });
  expect(deadlineChoices(10 * 86_400, 20 * 86_400)).toEqual({ days: [14], first: 14 });
  expect(deadlineChoices(60, 3600)).toEqual({ days: [], first: null });
  expect([1, 3, 7, 14, 30].map(daysLabel)).toEqual(["1 day", "3 days", "1 week", "2 weeks", "30 days"]);
});
