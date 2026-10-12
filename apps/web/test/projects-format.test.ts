// The Projects page's formatters are pure functions of Core's rows: what a metric line and a card read.
import { describe, expect, test } from "bun:test";
import { unitListing } from "../src/pages/lineage.ts";
import { metricLine, projectCard, START_TITLE, unitGens, unlistedLine, type ProjectMetric, type ProjectRow } from "../src/pages/projects.ts";

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

describe("a unit whose chain holds generations by hidden launches", () => {
  const best = { value: 810, height: 2, gen_id: "g2", at: 2 };
  const withStart = m({ baseline: 1000, start: { value: 900, height: 1 }, best, latest: best, improvement_pct: 10 });
  test("metricLine measures from start, with the title that says what the left figure is", () => {
    const h = metricLine(withStart).s;
    expect(seen(h)).toBe("encode_ir 900 to 810 10.00%");
    expect(h).toContain(`title="${START_TITLE}"`);
    expect(START_TITLE).toBe("measured at the code listed agents build on");
    expect(h).not.toContain("1,000");
  });
  test("metricLine with start and no listed generation yet: the start alone", () => {
    expect(seen(metricLine(m({ baseline: 1000, start: { value: 900, height: 1 } })).s)).toBe("encode_ir 900 no change yet");
  });
  test("the unit line counts listed generations instead of the height", () => {
    expect(unitGens({ height: 12, status: "active" })).toBe("gen 12");
    expect(unitGens({ height: 12, status: "active", listed_generations: 12, unlisted_generations: 0 })).toBe("gen 12");
    expect(unitGens({ height: 9, status: "active", listed_generations: 3, unlisted_generations: 6 })).toBe("3 generations");
    expect(unitGens({ height: 7, status: "active", listed_generations: 1, unlisted_generations: 6 })).toBe("1 generation");
    expect(unitGens({ height: 6, status: "active", listed_generations: 0, unlisted_generations: 6 })).toBe("");
    expect(unitGens({ height: 6, status: "retired", listed_generations: 0, unlisted_generations: 6 })).toBe("retired");
  });
  test("the unlisted line states the fact once, with no test wording", () => {
    expect(unlistedLine(6)).toBe("6 generations by unlisted launches are part of this unit's code.");
    expect(unlistedLine(1)).toBe("1 generation by unlisted launches is part of this unit's code.");
    expect(unlistedLine(0)).toBe("");
    expect(unlistedLine(undefined)).toBe("");
  });
  const row = (over: Partial<ProjectRow> = {}): ProjectRow => ({
    key: "keis/base58", repo: "https://github.com/keis/base58", repo_id: "r", github: true, classes: ["python"],
    lineages: [{ lineage_id: "a".repeat(64), recipe_name: "base58-py", class: "python", status: "active", height: 9, open_candidates: 0, accepted: 3, listed_generations: 3, unlisted_generations: 6, metrics: [withStart, m({ name: "decode_ir", start: { value: 950, height: 6 } })] }],
    accepted: 3, reverted: 0, authors: 1, last_improvement_at: null, open_candidates: 0, live_agents: [], live_sessions: 0, ...over,
  });
  test("a project card: listed counts, no test wording, no TBA, no em dash", () => {
    for (const hidden of [false, true]) {
      const h = projectCard(row(hidden ? { accepted: 9, accepted_hidden: 6 } : {}), hidden).s;
      const text = seen(h);
      expect(text).toContain("3 generations");
      expect(text).not.toMatch(/gen 9/);
      expect(h).not.toMatch(/TBA|test launch|by test|\btest\b|\u2014/i);
      expect(text.includes("6 hidden")).toBe(hidden);
    }
  });
});

describe("unitListing (the unit page, given Core's hidden list)", () => {
  const H = "Hidden1111111111111111111111111111111111111", A = "Listed1111111111111111111111111111111111111";
  const d = {
    generations: [
      { gen_id: "g0", entry_type: "genesis", height: 0, author: null },
      { gen_id: "g1", entry_type: "patch", height: 1, author: H, reverted_by: null },
      { gen_id: "g2", entry_type: "patch", height: 2, author: H, reverted_by: "r3" },
      { gen_id: "r3", entry_type: "revert", height: 3, author: null, reverts: "g2" },
      { gen_id: "g4", entry_type: "patch", height: 4, author: A, reverted_by: null },
    ],
    cands: [{ candidate_id: "c1", author: H, status: "accepted" }, { candidate_id: "c2", author: H, status: "rejected" }, { candidate_id: "c3", author: A, status: "accepted" }, { candidate_id: "c4", author: null, status: "replaying" }],
    intents: [{ agent: H, status: "open" }, { agent: A, status: "open" }],
    board: { targets: [{ kind: "perf", target: "ir", holders: [H, A] }], intents: [{ agent: H }, { agent: A }], files: [{ path: "a.py", agents: [{ agent: H, edits: 1 }] }, { path: "b.py", agents: [{ agent: H }, { agent: A }] }] },
    notes: [{ from: H }, { from: A }],
    findings: [{ kind: "known_failure", finder: H, target: "t" }, { kind: "metric", finder: A, target: "ir" }],
  };
  test("a hidden launch's rows are not listed; its unreverted generations are counted for the one line", () => {
    const v = unitListing(d, new Set([H]));
    expect(v.generations.map((g) => g.gen_id)).toEqual(["g0", "g4"]);
    expect(v.unlisted).toBe(1);
    expect(v.cands.map((c) => c.candidate_id)).toEqual(["c3", "c4"]); // an open candidate's author is sealed: it stays
    expect([v.hidden_cands, v.hidden_rejected]).toEqual([2, 1]);
    expect(v.intents).toEqual([{ agent: A, status: "open" }]);
    expect(v.board.targets[0].holders).toEqual([A]);
    expect(v.board.intents).toEqual([{ agent: A }]);
    expect(v.board.files.map((f: any) => [f.path, f.agents.length])).toEqual([["b.py", 1]]);
    expect(v.notes).toEqual([{ from: A }]);
    expect(v.findings.map((f) => f.finder)).toEqual([null, A]);
    expect(JSON.stringify(v)).not.toContain(H);
  });
  test("nobody hidden (or ?hidden=1): everything as Core serves it", () => {
    const v = unitListing(d, new Set());
    expect(v.generations).toEqual(d.generations);
    expect(v.unlisted).toBe(0);
    expect(v.cands).toEqual(d.cands);
    expect(v.board).toEqual(d.board);
    expect(v.findings).toEqual(d.findings);
  });
});
