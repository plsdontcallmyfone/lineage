import { expect, test } from "bun:test";
import { explainRequirement, panelBody, requirementToggle } from "../src/requirement-explain.ts";
import { measureOf, middle, type UnitMeasure } from "../src/unit-measure.ts";

// The explanation beside a bounty's requirement: each kind of metric in its own terms, the rule the
// percentage follows (one change against the unit's best when it is verified; the target moves), and
// the sentences left out when Core served no figure for them.

const ir = { name: "encode_ir", kind: "perf", direction: "lower", deterministic: true };
const M = (over: Partial<UnitMeasure> = {}): UnitMeasure => ({ cls: "python", parser: { encode_ir: "cachegrind-ir" }, deterministic: { encode_ir: true }, equivalence: true, height: 41,
  base: { encode_ir: 4_918_589_416 }, createdAt: Date.UTC(2026, 9, 12), tip: { encode_ir: 2_341_578_267 }, tipAt: Date.UTC(2026, 9, 13), ...over });

test("CPU instructions: where it stands on the best code, and the winning number, which never rounds toward the easy side", () => {
  const e = explainRequirement({ metric: ir, pct: 10 }, M());
  expect(e.what).toBe("What is measured: counts the CPU instructions this unit's encode benchmark executes. Fewer instructions means faster code. The count is exact: the same code on the same input always gives the same number.");
  expect(e.now).toBe("Where it stands: 2,341,578,267 CPU instructions on the unit's best code, measured in the replays of generation 41, accepted Oct 13, 2026.");
  expect(e.win).toBe("What wins: one verified change that brings it from 2,341,578,267 CPU instructions to 2,107,420,440 or fewer, which is 10% better.");
  expect(2_107_420_440).toBe(Math.floor(2_341_578_267 * 0.9));
  expect(e.tests).toBe("The repository's own tests must still pass, and the code must produce the same output as before.");
  expect(e.not).toBe("What it does not mean: not 10% faster on your machine by the clock, and not the whole project being 10% faster. Only this benchmark of this metric.");
  expect(e.who).toBe("Who measures: independent verifiers replay the change in a sandbox and run the same benchmark every time. Their results have to agree.");
});

test("the rule: one change against the unit's best when it is verified, and the target moves with that best", () => {
  const e = explainRequirement({ metric: ir, pct: 2.5 }, M());
  expect(e.one).toBe("It is one change, measured against the unit's best code at the moment that change is verified. It is not the total of several smaller changes, and it is not compared with the repository as it was when the bounty was posted.");
  expect(e.moving).toBe("If another change is accepted first, the unit's best moves: every change still waiting is verified again on top of it, and the 2.5% is counted from the new best. Only a change accepted after the bounty was posted, and before its deadline, counts.");
});

test("a unit nothing was accepted on yet: the value of its setup, said as that", () => {
  const e = explainRequirement({ metric: ir, pct: 5 }, M({ height: 0, tip: null, tipAt: null }));
  expect(e.now).toBe("Where it stands: 4,918,589,416 CPU instructions, measured when the unit was set up on Oct 12, 2026; no change has been accepted yet.");
  expect(e.win).toContain("from 4,918,589,416 CPU instructions to 4,672,659,945 or fewer");
  // changes were accepted but the newest generation's replays carry no value for this metric: the setup value, with how many came since
  expect(explainRequirement({ metric: ir, pct: 5 }, M({ tip: {}, height: 3 })).now).toContain("measured when the unit was set up on Oct 12, 2026; 3 changes have been accepted since");
});

test("missing figures: the sentence that needs one is left out, and no number is made up", () => {
  const none = explainRequirement({ metric: ir, pct: 10 }, null);
  expect(none.now).toBeNull();
  expect(none.win).toBe("What wins: one verified change that makes this number at least 10% lower.");
  expect(none.tests).toBe("The repository's own tests must still pass.");
  const html = panelBody({ metric: ir, pct: 10 }, null).s;
  expect(html).not.toContain('data-rq-line="now"');
  expect(html.match(/\d{4,}/)).toBeNull(); // no measured figure anywhere
  const other = explainRequirement({ metric: ir, pct: 10 }, M({ base: {}, tip: { decode_ir: 5 } }));
  expect(other.now).toBeNull();
  expect(panelBody({ metric: ir, pct: 10 }, null, true).s).toContain("Reading the latest measurement");
});

test("size, compute units, time and an unknown metric follow their kind", () => {
  const bytes = { name: "rlib_bytes", kind: "slim", direction: "lower", deterministic: true };
  const b = explainRequirement({ metric: bytes, pct: 0.5 }, M({ parser: {}, deterministic: { rlib_bytes: true }, tip: { rlib_bytes: 24_720 }, equivalence: false }));
  expect(b.what).toContain("The size of the built library, in bytes".toLowerCase().replace("the size", "the size"));
  expect(b.win).toBe("What wins: one verified change that brings it from 24,720 bytes to 24,596 or less, which is 0.5% better.");
  expect(b.not).toBe("What it does not mean: not everything the project ships being 0.5% smaller. Only the size of this one built file.");
  expect(b.who).toContain("run the same measurement every time");
  expect(b.tests).toBe("The repository's own tests must still pass.");
  const cu = explainRequirement({ metric: { name: "write_cu", kind: "perf", direction: "lower", deterministic: true }, pct: 3 }, M({ cls: "solana", parser: { write_cu: "number" }, deterministic: { write_cu: true }, tip: { write_cu: 17_195 } }));
  expect(cu.win).toContain("from 17,195 compute units to 16,679 or fewer");
  expect(cu.not).toContain("Only the compute units this one path uses.");
  const ns = explainRequirement({ metric: { name: "encode_ns", kind: "perf", direction: "lower", deterministic: false }, pct: 10 }, M({ parser: { encode_ns: "time" }, deterministic: { encode_ns: false }, tip: { encode_ns: 1000 } }));
  expect(ns.who).toContain("where runs differ the least favourable reading is the one that counts");
  expect(ns.win).toContain("from 1,000 nanoseconds to 900 or less");
  const up = explainRequirement({ metric: { name: "score", kind: "perf", direction: "higher" }, pct: 10 }, M({ parser: {}, deterministic: {}, tip: { score: 200 } }));
  expect(up.win).toBe("What wins: one verified change that brings it from 200 to 223 or more, which is 10% better."); // 200 / 0.9, rounded up
  expect(explainRequirement({ metric: { name: "score", kind: "perf", direction: "higher" }, pct: 10 }, null).win).toContain("at least 10% higher");
});

test("the toggle is closed, names its panel, and carries only the bounty's own requirement", () => {
  const t = requirementToggle({ metric: ir, pct: 10 }, "ab".repeat(32)).s;
  expect(t).toContain('aria-expanded="false"');
  expect(t).toMatch(/aria-controls="(rq-[\w-]+)"[\s\S]*id="\1"[^>]*hidden/);
  expect(t).toContain(">What does this mean?</button>");
  const g = requirementToggle({ metric: ir, pct: 10, unit: "karpathy/minbpe (minbpe-heavy)" }, null, { general: true, label: "How improvement is measured" }).s;
  expect(g).toContain("An example from a unit that is live now:");
  expect(g).toContain("karpathy/minbpe (minbpe-heavy), Encode speed, in CPU instructions (encode_ir), asked to get 10% better.");
});

test("the measure is built from what Core serves, and the middle measurement is one that was measured", () => {
  expect(middle([5, 1, 9])).toBe(5);
  expect(middle([4, 2])).toBe(2);
  const u = { height: 2, tip: "t", created_at: 1000, recipe: { class: "rust", equivalence: { command: "x" }, metrics: [{ name: "a_ir", parser: "cachegrind-ir", deterministic: true }, { name: "b_ns", parser: "time" }] },
    calibration: { metrics: { a_ir: { base_value: 100 }, b_ns: { base_value: "x" } } } };
  const g = { accepted_at: 2000, replays: [{ result: { metrics: { a_ir: { cand: [90] }, b_ns: { cand: [7, 9, 8] } } } }, { result: { metrics: { a_ir: { cand: [90] }, b_ns: { cand: [10] } } } }, { result: null }] };
  expect(measureOf(u, g)).toEqual({ cls: "rust", equivalence: true, height: 2, createdAt: 1000, tipAt: 2000, parser: { a_ir: "cachegrind-ir", b_ns: "time" }, deterministic: { a_ir: true, b_ns: false }, base: { a_ir: 100 }, tip: { a_ir: 90, b_ns: 8 } });
  expect(measureOf({ ...u, height: 0 }, null)).toMatchObject({ tip: null, tipAt: null, base: { a_ir: 100 } });
  expect(measureOf({}, null)).toBeNull();
});
