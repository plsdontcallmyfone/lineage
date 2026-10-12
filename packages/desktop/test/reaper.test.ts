import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateOpts, DesktopBackend } from "../src/backend.ts";
import { LocalBackend } from "../src/local.ts";
import { DesktopPool } from "../src/pool.ts";

// The desktop reaper (site incident 2026-10-12: a desktop container up 13 hours after its attempt, its
// session file still open). A desktop is removed when its attempt is not running in this process or
// when it is older than the maximum; other runtimes' desktops on the same Docker host are left alone;
// session files left open are closed and stream directories removed.

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "lin-reap-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const NOW = Date.parse("2026-10-12T08:00:00Z");
const id = (c: string) => c.repeat(16);

/** A fake Docker host: containers by name with a creation time and the source of their /stream mount. */
function fakeDocker(containers: Record<string, { created: number; stream: string }>) {
  const removed: string[] = [];
  const run = async (argv: string[]) => {
    const a = argv.slice(1);
    if (a[0] === "ps") {
      if (!a.includes("label=lineage.desktop=1")) throw new Error("the reaper lists only desktop containers");
      return { code: 0, stdout: Object.keys(containers).join("\n") + "\n", stderr: "" };
    }
    if (a[0] === "inspect") {
      const c = containers[a.at(-1)!];
      return c ? { code: 0, stdout: `${new Date(c.created).toISOString()}\t/t ${c.stream} \n`, stderr: "" } : { code: 1, stdout: "", stderr: "no such container" };
    }
    if (a[0] === "rm") {
      removed.push(a.at(-1)!);
      delete containers[a.at(-1)!];
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, removed };
}

test("reap: removes a desktop whose attempt is gone and one over the maximum age; keeps a running one, a starting one and another pool's", async () => {
  const root = tmp();
  const h = 3600_000;
  const d = fakeDocker({
    [`lineage-desk-${id("a")}`]: { created: NOW - 13 * h, stream: `${root}/live/${id("a")}` }, // the 13 hour leak: no attempt
    [`lineage-desk-${id("b")}`]: { created: NOW - 600_000, stream: `${root}/live/${id("b")}` }, // running, young
    [`lineage-desk-${id("c")}`]: { created: NOW - 3 * h, stream: `${root}/live/${id("c")}` }, // running, over the maximum
    [`lineage-desk-${id("d")}`]: { created: NOW - 30_000, stream: `${root}/live/${id("d")}` }, // starting: no attempt yet
    [`lineage-desk-${id("e")}`]: { created: NOW - 13 * h, stream: `/var/lib/other/desktops/live/${id("e")}` }, // another runtime's
    "lineage-desk-proxy": { created: NOW - 40 * h, stream: "" },
  });
  const b = new LocalBackend({ root, run: d.run, docker: "docker" });
  const out = await b.reap({ live: new Set([id("b"), id("c")]), maxAgeS: 7200, now: NOW });
  expect(d.removed.sort()).toEqual([`lineage-desk-${id("a")}`, `lineage-desk-${id("c")}`]);
  expect(out.find((r) => r.id === id("a"))!.why).toBe("its attempt is not running");
  expect(out.find((r) => r.id === id("c"))!.why).toContain("over the 7200 s maximum");
});

class Fake implements DesktopBackend {
  readonly name = "local" as const;
  reaped: { live: string[]; maxAgeS: number }[] = [];
  unavailable() {
    return null;
  }
  async create(_o: CreateOpts): Promise<never> {
    throw new Error("not used");
  }
  async reap(o: { live: ReadonlySet<string>; maxAgeS: number }) {
    this.reaped.push({ live: [...o.live], maxAgeS: o.maxAgeS });
    return [{ id: id("a"), why: "its attempt is not running" }];
  }
}

test("pool reap: closes the session file a dead attempt left open, removes its stream directory, leaves ended and E2B sessions", async () => {
  const root = tmp();
  const local = new Fake();
  const logs: string[] = [];
  const pool = new DesktopPool(
    { root, desktops_max: 2, e2b_max: 0, desktop_usd_per_day: 0, allow: [], max_age_s: 1800 },
    { local, e2b: Object.assign(new Fake(), { name: "e2b" as const, usdPerS: 0 }) as never, now: () => NOW, timers: false, log: (m) => logs.push(m) },
  );
  const live = join(root, "live", id("a"));
  mkdirSync(live, { recursive: true });
  writeFileSync(join(live, "live.m3u8"), "#EXTM3U\n");
  utimesSync(live, new Date(NOW - 13 * 3600_000), new Date(NOW - 13 * 3600_000));
  const s = (name: string, j: object) => writeFileSync(join(root, "sessions", `${name}.json`), JSON.stringify(j));
  s("leaked", { dir: live, backend: "local", agent: "BFPx", started_at: NOW - 13 * 3600_000, ended_at: null });
  s("done", { dir: join(root, "live", id("f")), backend: "local", agent: "x", started_at: NOW - 9000_000, ended_at: NOW - 8000_000 });
  s("cloud", { dir: join(root, "live", "e2b1"), backend: "e2b", agent: "x", started_at: NOW - 9000_000, ended_at: null });
  const r = await pool.reap();
  expect(local.reaped).toEqual([{ live: [], maxAgeS: 1800 }]);
  expect(r.removed.map((x) => x.id)).toEqual([id("a")]);
  expect(r.sessions_closed).toBe(1);
  const leaked = JSON.parse(readFileSync(join(root, "sessions", "leaked.json"), "utf8"));
  expect(leaked.ended_at).toBe(NOW);
  expect(leaked.ended_why).toContain("reaped");
  expect(JSON.parse(readFileSync(join(root, "sessions", "done.json"), "utf8")).ended_at).toBe(NOW - 8000_000);
  expect(JSON.parse(readFileSync(join(root, "sessions", "cloud.json"), "utf8")).ended_at).toBeNull();
  expect(existsSync(live)).toBe(false);
  expect(logs.some((m) => m.includes(`reaped desktop ${id("a")}`))).toBe(true);
  // a second pass finds nothing left to close
  expect((await pool.reap()).sessions_closed).toBe(0);
});
