import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopInstance, ExecResult } from "../src/backend.ts";
import { Driver, isErrorPageTitle, RELOAD_WAITS_MS } from "../src/driver.ts";
import { Seal } from "../src/seal.ts";

// The browser tile shows the code host's page. GitHub sometimes answers with its own error page
// (the "Unicorn!" 502/504 page, "Server Error"): the driver reloads it a bounded number of times,
// waiting longer each time, and never reloads a page that is not an error page.

const REPO = "https://github.com/a/b";
const URL1 = `${REPO}/blob/c/src/x.py#L1-L9`;
const URL2 = `${REPO}/blob/c/src/y.py#L1-L9`;

/** A desktop whose browser window title is whatever `titles` says for each successive read. */
class TitleInst implements DesktopInstance {
  readonly id = "t";
  readonly backend = "local" as const;
  readonly streamDir = "/stream";
  readonly hostStreamDir: string;
  readonly usdPerS = 0;
  calls: string[][] = [];
  reads = 0;
  constructor(private titles: (n: number) => string, private browser = true) {
    this.hostStreamDir = mkdtempSync(join(tmpdir(), "units-drv-"));
  }
  async exec(argv: string[]): Promise<ExecResult> {
    this.calls.push(argv);
    if (argv[1] === "search") return { code: 0, stdout: this.browser ? "77\n" : "", stderr: "" };
    if (argv[1] === "getwindowname") return { code: 0, stdout: `${this.titles(this.reads++)}\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }
  async read() {
    return null;
  }
  async sync() {}
  async destroy() {}
  reloads() {
    return this.calls.filter((c) => c.at(-1) === "F5").length;
  }
}

/** A clock the driver's waits move, so backoff is asserted exactly and the test does not wait. */
function clock() {
  let t = 1_000_000;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    at: () => t,
  };
}

const mk = (inst: TitleInst, waits = RELOAD_WAITS_MS) => {
  const c = clock();
  const lines: string[] = [];
  const seal = new Seal({ stacked: false, repo: REPO, commit: "c" });
  const d = new Driver(inst, seal, inst.hostStreamDir, (m) => lines.push(m), { reloadWaitsMs: waits, now: c.now, sleep: c.sleep });
  return { d, c, lines, seal };
};

describe("driver: the code host's error pages", () => {
  test("which titles are error pages", () => {
    for (const t of ["Unicorn! · GitHub - Chromium", "Unicorn! · GitHub", "Server Error · GitHub - Chromium", "504 Gateway Time-out - Chromium", "502 Bad Gateway", "503 Service Temporarily Unavailable", "Bad Gateway", "Gateway Timeout", "500 Internal Server Error"]) expect([t, isErrorPageTitle(t)]).toEqual([t, true]);
    // real pages, a missing page and the rate limit page are left alone; so is a file whose name merely starts with digits
    for (const t of ["minbpe/basic.py at 1acefe8 · karpathy/minbpe - Chromium", "Page not found · GitHub", "Rate limit · GitHub", "unicorn.py at abc · a/b", "5040_notes.md at abc · a/b", "server_errors.py at abc · a/b", "New Tab - Chromium", ""]) expect([t, isErrorPageTitle(t)]).toEqual([t, false]);
  });

  test("a good page is looked at once and never reloaded", async () => {
    const inst = new TitleInst(() => "x.py at c · a/b - Chromium");
    const { d, c } = mk(inst);
    const t0 = c.at();
    d.enqueue([{ tile: "browser", op: "goto", url: URL1 }]);
    await d.settled();
    expect(inst.reads).toBe(1);
    expect(inst.reloads()).toBe(0);
    expect(d.done).toMatchObject({ actions: 1, reloads: 0, failed: 0 });
    expect(c.at() - t0).toBe(RELOAD_WAITS_MS[0]!);
  });

  test("an error page is reloaded until the page loads, waiting longer each time", async () => {
    const inst = new TitleInst((n) => (n < 2 ? "Unicorn! · GitHub - Chromium" : "x.py at c · a/b - Chromium"));
    const { d, c, lines } = mk(inst);
    const t0 = c.at();
    d.enqueue([{ tile: "browser", op: "goto", url: URL1 }]);
    await d.settled();
    expect(inst.reads).toBe(3);
    expect(inst.reloads()).toBe(2);
    expect(d.done.reloads).toBe(2);
    // the load, then the first two backoff steps; the third is never reached
    expect(c.at() - t0).toBe(RELOAD_WAITS_MS[0]! + RELOAD_WAITS_MS[1]! + RELOAD_WAITS_MS[2]!);
    expect(RELOAD_WAITS_MS[2]!).toBeGreaterThan(RELOAD_WAITS_MS[1]!);
    expect(RELOAD_WAITS_MS[3]!).toBeGreaterThan(RELOAD_WAITS_MS[2]!);
    // the reload is one key in the browser window, nothing typed
    const f5 = inst.calls.filter((x) => x.at(-1) === "F5");
    expect(f5[0]).toEqual(["xdotool", "windowactivate", "--sync", "77", "key", "--clearmodifiers", "F5"]);
    expect(lines.filter((l) => l.includes("reload 1 of 3") || l.includes("reload 2 of 3"))).toHaveLength(2);
  });

  test("bounded: an error page that stays is left after the last reload", async () => {
    const inst = new TitleInst(() => "504 Gateway Time-out - Chromium");
    const { d, c, lines } = mk(inst);
    const t0 = c.at();
    d.enqueue([{ tile: "browser", op: "goto", url: URL1 }]);
    await d.settled();
    expect(inst.reloads()).toBe(RELOAD_WAITS_MS.length - 1);
    expect(inst.reads).toBe(RELOAD_WAITS_MS.length);
    expect(c.at() - t0).toBe(RELOAD_WAITS_MS.reduce((a, b) => a + b, 0));
    expect(lines.at(-1)).toContain("still answers with an error page after 3 reloads");
    // nothing more happens afterwards
    const n = inst.calls.length;
    await d.settled(200);
    expect(inst.calls.length).toBe(n);
  });

  test("a new navigation replaces the page being watched; actions are not held back by it", async () => {
    let page = 1;
    const inst = new TitleInst(() => (page === 1 ? "Unicorn! · GitHub" : "y.py at c · a/b"));
    // real time here: the first look comes 400 ms after the address is typed
    const d = new Driver(inst, new Seal({ stacked: false, repo: REPO, commit: "c" }), inst.hostStreamDir, () => {}, { reloadWaitsMs: [400, 50, 50] });
    d.enqueue([{ tile: "browser", op: "goto", url: URL1 }]);
    await d.idle(); // returns once the address is typed, while the page is still being watched
    expect(inst.reads).toBe(0);
    page = 2;
    d.enqueue([{ tile: "browser", op: "goto", url: URL2 }, { tile: "run", op: "ls", path: "." }]);
    await d.settled();
    expect(inst.reloads()).toBe(0);
    expect(inst.calls.some((x) => x[0] === "desk-cmd" && x[1] === "run")).toBe(true);
    expect(d.done).toMatchObject({ actions: 3, reloads: 0 });
  });

  test("the desktop's first page is watched too; stop and a desktop without a browser end the watch", async () => {
    const inst = new TitleInst((n) => (n === 0 ? "Unicorn! · GitHub" : "a/b at c"));
    const { d } = mk(inst);
    d.watchPage(`${REPO}/tree/c`);
    await d.settled();
    expect(inst.reloads()).toBe(1);

    const stays = new TitleInst(() => "Unicorn! · GitHub");
    const b = mk(stays);
    b.d.watchPage(`${REPO}/tree/c`);
    b.d.stop();
    await b.d.settled();
    expect(stays.reloads()).toBe(0);

    const none = new TitleInst(() => "Unicorn! · GitHub", false);
    const n = mk(none);
    n.d.watchPage(`${REPO}/tree/c`);
    await n.d.settled();
    expect(none.reloads()).toBe(0);
    expect(none.reads).toBe(0);
  });
});
