import { describe, expect, test } from "bun:test";
import { confirmDivergences, type Divergence, type ReplicaReport } from "../src/replica.ts";

const report = (divergences: Divergence[]): ReplicaReport =>
  ({ v: 1, divergences, ok: divergences.length === 0 }) as unknown as ReplicaReport;
const d = (id: string, replica: unknown): Divergence => ({ kind: "verdict", id, field: "outcome", core: "accepted", replica });

describe("replica confirmation pass", () => {
  test("a divergence counts only when the second pass reports it identically", () => {
    const first = report([d("a", "rejected"), d("b", "rejected"), d("c", "rejected")]);
    const second = report([d("a", "rejected"), d("c", "disputed")]); // b was transient; c changed
    const r = confirmDivergences(first, second);
    expect(r.divergences.map((x) => x.id)).toEqual(["a"]);
    expect(r.ok).toBe(false);
    expect(confirmDivergences(first, report([])).ok).toBe(true);
  });
});
