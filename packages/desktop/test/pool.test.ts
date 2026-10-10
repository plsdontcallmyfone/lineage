import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateOpts, DesktopBackend, DesktopInstance, ExecResult } from "../src/backend.ts";
import { Driver } from "../src/driver.ts";
import { E2BBackend, e2bUsdPerS, E2B_RATES, loadE2BKey, playlistFiles, type E2BSandbox } from "../src/e2b.ts";
import { DesktopPool, homeUrl, parseGeom } from "../src/pool.ts";
import { Seal } from "../src/seal.ts";
import { desktopHandler } from "../src/serve.ts";

// The desktop pool against mock backends and a mock E2B: slot order (our server, then E2B), the E2B
// day cap, recording publication only after the gate opens, the stream handler, and the E2B backend's
// start-up order (tools, then egress locked, then the session).

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "lin-desk-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const GEOM = "LineageEditor 0 0 636 795\nLineageRun 640 600 637 195\nLineageTerm 640 400 637 195\nLineageBrowser 640 0 640 400\n";

class FakeInst implements DesktopInstance {
  calls: string[][] = [];
  destroyed = false;
  files = new Map<string, Uint8Array>();
  constructor(readonly id: string, readonly backend: "local" | "e2b", readonly hostStreamDir: string, readonly usdPerS = 0, private geom = GEOM) {}
  streamDir = "/stream";
  async exec(argv: string[], o: { stdin?: string | Uint8Array } = {}): Promise<ExecResult> {
    this.calls.push(o.stdin !== undefined ? [...argv, `<stdin:${typeof o.stdin === "string" ? o.stdin : "bytes"}>`] : argv);
    if (argv[0] === "desk-geom") return { code: 0, stdout: this.geom, stderr: "" };
    if (argv[0] === "xdotool" && argv[1] === "search") return { code: 0, stdout: "4194305\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }
  async read(p: string) {
    return this.files.get(p) ?? null;
  }
  async sync() {}
  async destroy() {
    this.destroyed = true;
  }
}

class FakeBackend implements DesktopBackend {
  made: FakeInst[] = [];
  constructor(readonly name: "local" | "e2b", private root: string, public why: string | null = null, readonly usdPerS = 0, public fail = false) {}
  unavailable() {
    return this.why;
  }
  async create(o: CreateOpts) {
    if (this.fail) throw new Error("boom");
    const d = join(this.root, "live", `${this.name}${this.made.length}`);
    mkdirSync(d, { recursive: true });
    const i = new FakeInst(`${this.name}${this.made.length}`, this.name, d, this.usdPerS);
    i.files.set("/tmp/desk/rec.mp4", new Uint8Array(4096).fill(7));
    this.made.push(i);
    return i;
  }
}

const begin = { agent: "A".repeat(44), tree: "/tmp/none", repo: "https://github.com/karpathy/minbpe", commit: "c".repeat(40), stacked: false, label: "t" };

function pool(o: { localMax?: number; e2bMax?: number; cap?: number; now?: () => number; e2bWhy?: string | null; localWhy?: string | null } = {}) {
  const root = tmp();
  const local = new FakeBackend("local", root, o.localWhy ?? null);
  const e2b = new FakeBackend("e2b", root, o.e2bWhy ?? null, e2bUsdPerS(2, 4));
  const logs: string[] = [];
  const p = new DesktopPool(
    { root, desktops_max: o.localMax ?? 2, e2b_max: o.e2bMax ?? 3, desktop_usd_per_day: o.cap ?? 5, allow: ["github.com"], e2b: { session_max_s: 3600 } },
    { local, e2b, log: (m) => logs.push(m), now: o.now },
  );
  return { p, local, e2b, logs, root };
}

describe("slots", () => {
  test("our server first, then E2B, then none (the reconstructed panel)", async () => {
    const { p, local, e2b } = pool({ localMax: 1, e2bMax: 1 });
    const a = await p.begin(begin);
    const b = await p.begin(begin);
    const c = await p.begin(begin);
    expect(a?.backend).toBe("local");
    expect(b?.backend).toBe("e2b");
    expect(c).toBeNull();
    expect(local.made.length).toBe(1);
    expect(e2b.made.length).toBe(1);
    await a!.end();
    expect((await p.begin(begin))?.backend).toBe("local");
  });

  test("a disabled E2B backend (no key) never starts one; a failing local one falls through", async () => {
    const x = pool({ localMax: 0, e2bWhy: "no E2B_API_KEY" });
    expect(await x.p.begin(begin)).toBeNull();
    expect(x.logs.join("\n")).toContain("no E2B_API_KEY");
    const y = pool({ localMax: 1 });
    y.local.fail = true;
    expect((await y.p.begin(begin))?.backend).toBe("e2b");
  });

  test("E2B day cap: a desktop counts at its full lifetime while it runs; spend per UTC day", async () => {
    let now = Date.parse("2026-10-10T10:00:00Z");
    // one hour of 2 vCPU + 4 GiB = 0.1656 USD; a cap of 0.3 fits one running, not two
    const { p, root, logs } = pool({ localMax: 0, e2bMax: 3, cap: 0.3, now: () => now });
    const a = await p.begin(begin);
    expect(a?.backend).toBe("e2b");
    expect(await p.begin(begin)).toBeNull();
    expect(logs.join("\n")).toContain("E2B day cap reached");
    now += 600_000; // ten minutes
    await a!.end();
    const spent = JSON.parse(readFileSync(join(root, "e2b-spend.json"), "utf8"));
    expect(spent.day).toBe("2026-10-10");
    expect(spent.usd).toBeCloseTo(600 * e2bUsdPerS(2, 4), 6);
    // 0.0276 spent + 0.1656 reserved for a new one <= 0.3
    expect((await p.begin(begin))?.backend).toBe("e2b");
    now = Date.parse("2026-10-11T00:00:01Z");
    expect(p.spentToday()).toBe(0);
  });

  test("published rates", () => {
    expect(E2B_RATES.usd_per_vcpu_s).toBe(0.000014);
    expect(E2B_RATES.usd_per_gib_s).toBe(0.0000045);
    expect(e2bUsdPerS(2, 4)).toBeCloseTo(0.000046, 9);
  });
});

describe("an attempt on a desktop", () => {
  test("events become desktop actions; the live encoder starts only after the geometry check; the recording is held under the session id", async () => {
    const { p, local, root } = pool();
    const a = (await p.begin(begin))!;
    const inst = local.made[0]!;
    await Bun.sleep(50);
    expect(inst.calls.some((c) => c[0] === "desk-bg" && c[1] === "rec")).toBe(true);
    expect(inst.calls.some((c) => c[0] === "desk-bg" && c[1] === "live")).toBe(true);
    const iGeom = inst.calls.findIndex((c) => c[0] === "desk-geom");
    const iLive = inst.calls.findIndex((c) => c[0] === "desk-bg" && c[1] === "live");
    expect(iGeom).toBeLessThan(iLive);
    const sid = "f".repeat(64);
    a.sessionOpened(sid);
    a.event({ kind: "read", path: "minbpe/base.py", start_line: 3, end_line: 6 });
    a.event({ kind: "edit", path: "minbpe/base.py", start_line: 4, end_line: 4, after: "SECRET" });
    a.event({ kind: "search", query: "merge" });
    a.event({ kind: "result", outcome: "accepted", output: "SECRET OUT" });
    await a.end();
    const flat = inst.calls.map((c) => c.join(" "));
    expect(flat.some((c) => c.startsWith("desk-cmd editor open"))).toBe(true);
    expect(flat.some((c) => c.startsWith("desk-cmd run search"))).toBe(true);
    expect(flat.some((c) => c.startsWith("desk-cmd term search"))).toBe(false);
    // the result text went to the run tile's file, never on a command line
    expect(flat.some((c) => c.startsWith("desk-put") && c.includes("SECRET OUT"))).toBe(true);
    expect(flat.filter((c) => !c.startsWith("desk-put")).some((c) => c.includes("SECRET"))).toBe(false);
    expect(inst.destroyed).toBe(true);
    expect(p.pending().map((x) => x.session_id)).toEqual([sid]);
    expect(existsSync(join(root, "recordings", `${sid}.mp4`))).toBe(true);
    expect(JSON.parse(readFileSync(p.sessionFile(sid), "utf8")).ended_at).toBeGreaterThan(0);
  });

  test("blackout: a moved editor window stops the live encoder and drops its unfinished segment", async () => {
    const root = tmp();
    const inst = new FakeInst("x", "local", join(root, "live", "x"), 0, GEOM.replace("LineageEditor 0 0", "LineageEditor 700 0"));
    const backend = new FakeBackend("local", root);
    backend.create = async () => inst;
    const p = new DesktopPool({ root, desktops_max: 1, e2b_max: 0, desktop_usd_per_day: 0, allow: [] }, { local: backend, e2b: new FakeBackend("e2b", root, "off") });
    const a = (await p.begin(begin))!;
    await Bun.sleep(1300);
    expect(inst.calls.some((c) => c[0] === "desk-bg" && c[1] === "live")).toBe(false);
    await a.end();
  });

  test("an attempt whose session never opened keeps no recording", async () => {
    const { p } = pool();
    const a = (await p.begin(begin))!;
    await a.end();
    expect(p.pending()).toEqual([]);
  });
});

describe("recording publication", () => {
  test("held while live or sealed; published once open; a failed upload stays held", async () => {
    const { p, root } = pool();
    const f = join(root, "recordings", "s.mp4");
    writeFileSync(f, new Uint8Array(100).fill(1));
    p.hold({ session_id: "s", agent: "A", file: f, bytes: 100, held_at: 0 });
    let gate = "sealed";
    const puts: string[] = [];
    let linkStatus = 200;
    const c = {
      gateState: async () => gate,
      putBlob: async (_a: string, sha: string) => (puts.push(sha), 200),
      link: async () => linkStatus,
    };
    expect((await p.publishPending(c)).held).toBe(1);
    expect(puts).toEqual([]);
    gate = "live";
    await p.publishPending(c);
    expect(puts).toEqual([]);
    gate = "final";
    linkStatus = 500;
    expect((await p.publishPending(c)).held).toBe(1);
    linkStatus = 200;
    const r = await p.publishPending(c);
    expect(r.published).toEqual(["s"]);
    expect(existsSync(f)).toBe(false);
    expect(p.pending()).toEqual([]);
  });
});

describe("stream handler", () => {
  test("serves only what the current playlist lists, and nothing once the attempt ended", async () => {
    const root = tmp();
    const dir = join(root, "live", "i");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(root, "sessions"));
    const sid = "e".repeat(64);
    writeFileSync(join(root, "sessions", `${sid}.json`), JSON.stringify({ dir, ended_at: null }));
    writeFileSync(join(dir, "live.m3u8"), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2.0,\nseg-5.m4s\n');
    writeFileSync(join(dir, "init.mp4"), "init");
    writeFileSync(join(dir, "seg-5.m4s"), "five");
    writeFileSync(join(dir, "seg-6.m4s"), "unfinished");
    const h = desktopHandler(root);
    const get = async (p: string) => (await h(new Request(`http://x${p}`)))!;
    expect((await get(`/desktops/${sid}/live.m3u8`)).status).toBe(200);
    expect(await (await get(`/desktops/${sid}/seg-5.m4s`)).text()).toBe("five");
    expect((await get(`/desktops/${sid}/seg-6.m4s`)).status).toBe(404);
    expect((await get(`/desktops/${sid}/init.mp4`)).status).toBe(200);
    expect((await get(`/desktops/${sid}/../sessions/${sid}.json`)).status).toBe(404);
    expect((await get(`/desktops/${"d".repeat(64)}/live.m3u8`)).status).toBe(404);
    expect(await h(new Request("http://x/runtime/bind/x"))).toBeNull();
    writeFileSync(join(root, "sessions", `${sid}.json`), JSON.stringify({ dir, ended_at: 1 }));
    expect((await get(`/desktops/${sid}/seg-5.m4s`)).status).toBe(410);
  });

  test("playlist parsing keeps only stream file names", () => {
    expect(playlistFiles('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\nseg-1.m4s\n../x\n/etc/passwd\nseg-2.m4s\n')).toEqual(["init.mp4", "seg-1.m4s", "seg-2.m4s"]);
  });
});

describe("E2B backend (mock SDK)", () => {
  function mock(opts: { missing?: string[] } = {}) {
    const order: string[] = [];
    const files = new Map<string, string | ArrayBuffer>();
    let killed = false;
    let createOpts: Record<string, unknown> = {};
    const sbx: E2BSandbox = {
      sandboxId: "sbx1",
      commands: {
        async run(cmd) {
          order.push(`run ${cmd.slice(0, 300)}`);
          if (cmd.includes("command -v $t")) return { exitCode: 0, stdout: (opts.missing ?? []).join("\n"), stderr: "" };
          if (cmd.includes("test -f /tmp/desk/ready")) return { exitCode: 0, stdout: "", stderr: "" };
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      files: {
        async write(p, d) {
          files.set(p, d);
          order.push(`write ${p}`);
        },
        async read(p) {
          if (p === "/tmp/stream/live.m3u8") return new TextEncoder().encode('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\nseg-9.m4s\n');
          if (p === "/tmp/stream/init.mp4" || p === "/tmp/stream/seg-9.m4s") return new TextEncoder().encode(p);
          throw new Error("no such file");
        },
      },
      async updateNetwork(n) {
        order.push(`network ${JSON.stringify(n)}`);
      },
      async kill() {
        killed = true;
      },
    };
    return { sbx, order, files, killed: () => killed, create: async (_t: string, o: Record<string, unknown>) => ((createOpts = o), sbx), opts: () => createOpts };
  }

  test("no key: disabled; the key file's empty placeholder counts as no key", () => {
    const d = tmp();
    writeFileSync(join(d, "e2b.env"), "# placeholder\nE2B_API_KEY=\n");
    const saved = process.env.E2B_API_KEY;
    delete process.env.E2B_API_KEY;
    try {
      expect(loadE2BKey(join(d, "e2b.env"))).toBeNull();
      expect(loadE2BKey(join(d, "missing.env"))).toBeNull();
      writeFileSync(join(d, "k.env"), "E2B_API_KEY=e2b_test_value\n");
      expect(loadE2BKey(join(d, "k.env"))).toBe("e2b_test_value");
    } finally {
      if (saved !== undefined) process.env.E2B_API_KEY = saved;
    }
    expect(new E2BBackend({ root: d, key: null }).unavailable()).toMatch(/E2B_API_KEY/);
  });

  test("start-up order: assets, tools, egress locked to the allowlist, tree, then the session; no viewer URL", async () => {
    const root = tmp();
    const tree = tmp();
    writeFileSync(join(tree, "a.py"), "print(1)\n");
    const m = mock({ missing: ["micro"] });
    const b = new E2BBackend({ root, key: "k", create: m.create, session_max_s: 900 });
    const inst = await b.create({ tree, homeUrl: "https://github.com/a/b", allow: ["github.com"], label: "t" });
    const iInstall = m.order.findIndex((x) => x.includes("apt-get install"));
    const iNet = m.order.findIndex((x) => x.startsWith("network"));
    const iTree = m.order.indexOf("write /tmp/repo.tgz");
    const iSession = m.order.findIndex((x) => x.includes("desk-bg session"));
    expect(iInstall).toBeGreaterThanOrEqual(0);
    expect(iInstall).toBeLessThan(iNet);
    expect(iNet).toBeLessThan(iTree);
    expect(iTree).toBeLessThan(iSession);
    expect(m.order[iNet]).toContain('"denyOut":["0.0.0.0/0"]');
    expect(m.order[iNet]).toContain('"allowOut":["github.com"]');
    expect(m.opts().timeoutMs).toBe(900_000);
    expect(m.order.some((x) => /vnc|stream\.start/i.test(x))).toBe(false);
    expect([...m.files.keys()].some((k) => k.endsWith("/bin/desk-session"))).toBe(true);
    expect(inst.usdPerS).toBeCloseTo(e2bUsdPerS(2, 4), 9);
    await inst.sync();
    expect(readFileSync(join(inst.hostStreamDir, "seg-9.m4s"), "utf8")).toBe("/tmp/stream/seg-9.m4s");
    expect(readFileSync(join(inst.hostStreamDir, "live.m3u8"), "utf8")).toContain("seg-9.m4s");
    await inst.destroy();
    expect(m.killed()).toBe(true);
  });

  test("a failed start kills the sandbox", async () => {
    const root = tmp();
    const m = mock();
    m.sbx.commands.run = async (cmd) => ({ exitCode: cmd.includes("ready") ? 1 : 0, stdout: "", stderr: "" });
    const b = new E2BBackend({ root, key: "k", create: m.create });
    const orig = Date.now;
    let t = orig();
    Date.now = () => (t += 30_000);
    try {
      await expect(b.create({ tree: tmp(), homeUrl: "about:blank", allow: [], label: "t" })).rejects.toThrow(/did not come up/);
    } finally {
      Date.now = orig;
    }
    expect(m.killed()).toBe(true);
  });
});

describe("driver", () => {
  test("refused actions never reach the desktop", async () => {
    const root = tmp();
    const inst = new FakeInst("x", "local", root);
    const s = new Seal({ stacked: false, repo: "https://github.com/a/b", commit: "c" });
    const d = new Driver(inst, s, root);
    s.route({ kind: "edit", path: "a.py", start_line: 1, end_line: 1 });
    d.enqueue([{ tile: "term", op: "search", pattern: "x" }, { tile: "browser", op: "goto", url: "https://evil.example/" }]);
    await d.idle();
    expect(d.done.refused).toBe(2);
    expect(inst.calls).toEqual([]);
  });

  test("helpers", () => {
    expect(homeUrl("https://github.com/karpathy/minbpe.git", "abc")).toBe("https://github.com/karpathy/minbpe/tree/abc");
    expect(homeUrl(null, "abc")).toBe("about:blank");
    expect(parseGeom("LineageEditor 0 0 10 10\ngarbage\nLineageRun -1 2 3 4")).toEqual([
      { cls: "LineageEditor", rect: { x: 0, y: 0, w: 10, h: 10 } },
      { cls: "LineageRun", rect: { x: -1, y: 2, w: 3, h: 4 } },
    ]);
  });
});
