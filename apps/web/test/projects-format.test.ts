// The Projects page's formatters are pure functions of Core's rows: what a metric line and a card read.
import { describe, expect, test } from "bun:test";
import { metricLine, type ProjectMetric } from "../src/pages/projects.ts";

const seen = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const m = (over: Partial<ProjectMetric> = {}): ProjectMetric => ({ name: "encode_ir", direction: "lower", baseline: 4103192876, best: null, latest: null, improvement_pct: null, ...over });

describe("metricLine", () => {
  test("no accepted improvement: the baseline alone and a plain no change yet", () => {
    const h = metricLine(m()).s;
    expect(seen(h)).toBe("encode_ir 4,103,192,876 no change yet");
    expect(h).toContain('<span class="faint"');
    expect(h).not.toMatch(/TBA|none yet|\bto\b/);
  });
  test("an accepted improvement: baseline to best and the measured change", () => {
    const best = { value: 315233420, height: 3, gen_id: "g", at: 1 };
    expect(seen(metricLine(m({ baseline: 478799541, best, latest: best, improvement_pct: 34.16 })).s)).toBe("encode_ir 478,799,541 to 315,233,420 34.16%");
  });
});
