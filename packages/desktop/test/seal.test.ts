import { describe, expect, test } from "bun:test";
import type { SessionEventInput } from "../../worker/src/session.ts";
import { CELL, GUTTER_CELLS, inside, liveFilter, sealedRects, TEXT_ROWS, TILES, XTERM_BORDER } from "../src/layout.ts";
import { Seal, type Action } from "../src/seal.ts";

// The sealing state machine tries to leak: every test feeds it what an agent's tool loop could
// produce and checks that nothing sealed can reach a place the live stream shows unredacted.

const REPO = "https://github.com/karpathy/minbpe";
const COMMIT = "1acefe89412b20245db5e22d2a02001e547dc602";
const SECRET = "SECRET_after_text_9f3a";
const seal = (stacked = false) => new Seal({ stacked, repo: REPO, commit: COMMIT });

/** Every place shown unredacted: the navigation terminal and the browser. */
const shown = (as: Action[]) => as.filter((a) => a.tile === "term" || a.tile === "browser");

describe("router", () => {
  test("a search goes to the navigation terminal only while the tree is unedited", () => {
    const s = seal();
    expect(s.route({ kind: "search", query: "def encode" })).toEqual([{ tile: "term", op: "search", pattern: "def encode" }]);
    s.route({ kind: "edit", path: "minbpe/basic.py", start_line: 10, end_line: 12, before: "a", after: SECRET });
    expect(s.route({ kind: "search", query: "def encode" })).toEqual([{ tile: "run", op: "search", pattern: "def encode" }]);
    // and check() refuses a navigation-terminal search queued before the edit but run after it
    expect(() => s.check({ tile: "term", op: "search", pattern: "def encode" })).toThrow(/edited tree/);
  });

  test("a stacked attempt starts sealed: its tree holds its own pending patch", () => {
    const s = seal(true);
    expect(s.route({ kind: "search", query: "x" })[0]!.tile).toBe("run");
    expect(() => s.check({ tile: "term", op: "search", pattern: "x" })).toThrow();
  });

  test("an edit marks the tree sealed before the tool writes; even one without a usable path", () => {
    const s = seal();
    expect(s.route({ kind: "edit", path: "../../etc/passwd", start_line: 1, end_line: 1, after: SECRET })).toEqual([]);
    expect(s.treeSealed).toBe(true);
    expect(s.route({ kind: "search", query: "q" })[0]!.tile).toBe("run");
  });

  test("reads open the editor and the code host's page at the snapshot commit; never for an edited file", () => {
    const s = seal();
    const a = s.route({ kind: "read", path: "minbpe/base.py", start_line: 5, end_line: 9 });
    expect(a[0]).toEqual({ tile: "editor", op: "open", path: "minbpe/base.py", line: 5, select: 4 });
    expect(a[1]).toEqual({ tile: "browser", op: "goto", url: `${REPO}/blob/${COMMIT}/minbpe/base.py#L5-L9` });
    s.route({ kind: "write", path: "minbpe/base.py", after: SECRET, lines_after: 3 });
    expect(shown(s.route({ kind: "read", path: "minbpe/base.py", start_line: 1, end_line: 2 }))).toEqual([]);
  });

  test("check() keeps the browser on the code host at the snapshot commit", () => {
    const s = seal();
    for (const url of [`${REPO}/blob/main/x.py`, `https://evil.example/${SECRET}`, `${REPO}/blob/${COMMIT}x/y`, `data:text/html,${SECRET}`])
      expect(() => s.check({ tile: "browser", op: "goto", url })).toThrow();
    expect(() => s.check({ tile: "browser", op: "goto", url: `${REPO}/blob/${COMMIT}/a.py#L1-L2` })).not.toThrow();
    expect(() => new Seal({ stacked: false, repo: "https://gitlab.com/a/b", commit: COMMIT }).check({ tile: "browser", op: "goto", url: "https://gitlab.com/a/b" })).toThrow();
  });

  test("check() refuses anything but listings and searches in the navigation terminal", () => {
    const s = seal();
    expect(() => s.check({ tile: "term", op: "show", title: "x", text: SECRET } as unknown as Action)).toThrow();
    expect(() => s.check({ tile: "term", op: "ls", path: "." })).not.toThrow();
  });

  test("evaluation output, results, notes, submits and give-ups never reach a shown tile", () => {
    const s = seal();
    const evs: SessionEventInput[] = [
      { kind: "evaluate", target: "encode", eval_kind: "perf" },
      { kind: "phase", phase: "build" },
      { kind: "result", outcome: "accepted", output: SECRET, steps: [{ step: "test", exit: 0, duration_ms: 10, timed_out: false, tail: SECRET }] },
      { kind: "note", text: SECRET },
      { kind: "submit", reason: SECRET },
      { kind: "give_up", reason: SECRET },
    ];
    for (const e of evs) for (const a of s.route(e)) expect(a.tile === "run" || a.tile === "editor").toBe(true);
  });

  test("fuzz: no sealed text in a shown tile, no navigation search over an edited tree", () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const paths = ["a.py", "src/b.py", "../c", "/etc/x", "d/../../e", "f g.py", `${SECRET}.py`];
    const kinds = ["list", "read", "search", "edit", "write", "patch", "evaluate", "phase", "result", "note", "submit", "give_up"] as const;
    for (let run = 0; run < 200; run++) {
      const s = seal(rnd(5) === 0);
      for (let i = 0; i < 40; i++) {
        const kind = kinds[rnd(kinds.length)]!;
        const e: SessionEventInput = {
          kind,
          path: paths[rnd(paths.length)],
          start_line: 1 + rnd(50),
          end_line: 60 + rnd(50),
          query: kind === "search" ? `q${rnd(9)}` : undefined,
          before: SECRET,
          after: SECRET,
          output: SECRET,
          text: SECRET,
          reason: SECRET,
          outcome: SECRET,
          phase: "test",
          steps: [{ step: "x", exit: 1, duration_ms: 1, timed_out: false, tail: SECRET }],
        };
        const sealedBefore = s.treeSealed;
        for (const a of s.route(e)) {
          if (a.tile === "term" || a.tile === "browser") {
            // a file named with a secret is a public path (17.3); the sealed fields are what may not show
            const j = JSON.stringify(a).replaceAll(`${SECRET}.py`, "");
            expect(j).not.toContain(SECRET);
          }
          if (a.tile === "term" && a.op === "search") expect(sealedBefore || s.treeSealed).toBe(false);
          if (a.tile !== "run" && a.tile !== "editor") expect(() => s.check(a)).not.toThrow();
        }
      }
    }
  });

  test("nothing is shown after the attempt ended", () => {
    const s = seal();
    s.end(true);
    expect(s.route({ kind: "read", path: "a.py", start_line: 1, end_line: 2 })).toEqual([]);
    expect(s.streamAllowed).toBe(false);
  });
});

describe("geometry guard", () => {
  const ok = [
    { cls: "LineageEditor", rect: { x: 0, y: 0, w: 636, h: 795 } },
    { cls: "LineageRun", rect: { x: 640, y: 600, w: 637, h: 195 } },
    { cls: "LineageTerm", rect: { x: 640, y: 400, w: 640, h: 200 } },
    { cls: "LineageBrowser", rect: { x: 640, y: 0, w: 640, h: 400 } },
  ];
  test("windows inside their tiles: live; any sealed window off its tile, missing, or unreadable: blackout", () => {
    const s = seal();
    expect(s.geometry(ok)).toBe(true);
    expect(s.streamAllowed).toBe(true);
    const moved = ok.map((w) => (w.cls === "LineageEditor" ? { ...w, rect: { ...w.rect, x: 641 } } : w));
    expect(s.geometry(moved)).toBe(false);
    expect(s.why).toMatch(/editor/);
    expect(s.streamAllowed).toBe(false);
    const grown = ok.map((w) => (w.cls === "LineageRun" ? { ...w, rect: { ...w.rect, y: 590 } } : w));
    expect(s.geometry(grown)).toBe(false);
    expect(s.geometry(ok.filter((w) => w.cls !== "LineageRun"))).toBe(false);
    expect(s.geometry(null)).toBe(false);
    // a second editor window (a dialog of the editor) anywhere else
    expect(s.geometry([...ok, { cls: "LineageEditor", rect: { x: 700, y: 10, w: 100, h: 100 } }])).toBe(false);
    // a browser window over the run tile
    expect(s.geometry([...ok, { cls: "LineageBrowser", rect: { x: 640, y: 0, w: 640, h: 800 } }])).toBe(false);
    expect(s.geometry(ok)).toBe(true);
    s.end(false);
    expect(s.geometry(ok)).toBe(false);
  });
});

describe("recording publication", () => {
  test("held until the gate is open for everyone", () => {
    const s = seal();
    expect(s.publishable("ended")).toBe(false); // still recording
    s.end(true);
    for (const st of ["live", "sealed", null, undefined, "", "open"]) expect(s.publishable(st as string)).toBe(false);
    for (const st of ["final", "ended", "abandoned"]) expect(s.publishable(st)).toBe(true);
    const none = seal();
    none.end(false);
    expect(none.publishable("final")).toBe(false);
  });
});

describe("redaction rectangles", () => {
  test("cover the editor's text area and the whole run tile; the gutter and status line stay out", () => {
    const [ed, run] = sealedRects() as [ReturnType<typeof sealedRects>[0], ReturnType<typeof sealedRects>[0]];
    const gutter = XTERM_BORDER + GUTTER_CELLS * CELL.w;
    expect(ed.x).toBeLessThanOrEqual(gutter);
    expect(ed.x + ed.w).toBeGreaterThanOrEqual(TILES.editor.w);
    expect(ed.y).toBe(0);
    // every text row, down to micro's status line (row TEXT_ROWS), which stays readable
    expect(ed.h).toBe(XTERM_BORDER + TEXT_ROWS * CELL.h);
    expect(ed.x).toBe(XTERM_BORDER + 2 * CELL.w);
    expect(inside(run, TILES.run) || (run.x <= TILES.run.x && run.y <= TILES.run.y && run.w >= TILES.run.w && run.h >= TILES.run.h)).toBe(true);
    expect(run).toEqual(TILES.run);
    for (const r of [ed, run]) for (const v of [r.x, r.y, r.w, r.h]) expect(v % 2).toBe(0);
    const f = liveFilter();
    expect(f).toContain(`crop=${ed.w}:${ed.h}:${ed.x}:${ed.y}`);
    expect(f).toContain(`crop=${run.w}:${run.h}:${run.x}:${run.y}`);
    expect(f.endsWith("[v]")).toBe(true);
  });
});
