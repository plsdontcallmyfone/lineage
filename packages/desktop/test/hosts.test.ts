import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateOpts, DesktopBackend, DesktopInstance, ExecResult } from "../src/backend.ts";
import { hostCapacity, noSlotWhy, placementOrder, type Slot } from "../src/placement.ts";
import { DesktopPool } from "../src/pool.ts";
import { pullStream, RemoteBackend, type HostConfig } from "../src/remote.ts";
import { desktopHandler } from "../src/serve.ts";

// Desktop hosts (owner decision 2026-10-10): placement across hosts (least loaded, then this server,
// then E2B), capacity from the measured desktop, health checks, a host going away (new desktops go
// elsewhere, running ones end their stream cleanly), the reserve the runtime's "desktop required"
// gate uses, and the host gateway accepting exactly what the remote backend sends.

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "lin-hosts-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const GEOM = "LineageEditor 0 0 636 795\nLineageRun 640 600 637 195\nLineageTerm 640 400 637 195\nLineageBrowser 640 0 640 400\n";
const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const HEALTH = JSON.stringify({ cpus: 8, mem_mib: 16000, mem_avail_mib: 15000, load1: 0.2, image: "sha256:abc", docker: true, desktops: 0, proxy: true });

/** A fake set of desktop hosts behind ssh: each host answers the gateway's commands, or is down. */
class FakeHosts {
  down = new Set<string>();
  calls: { host: string; cmd: string }[] = [];
  playlist = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:2.0,\nseg-1.m4s\n";
  run = async (argv: string[], stdin?: string | Uint8Array): Promise<ExecResult & { bytes?: Uint8Array }> => {
    const target = argv[argv.indexOf("--") - 1]!;
    const host = target.split("@")[1]!;
    const cmd = argv.at(-1)!;
    this.calls.push({ host, cmd });
    if (this.down.has(host)) return { code: 255, stdout: "", stderr: "ssh: connect to host: Connection refused" };
    if (cmd === "'health'") return ok(HEALTH);
    if (cmd === "'sweep'") return ok('{"removed": 0}');
    if (cmd.includes("desk-geom")) return ok(GEOM);
    if (cmd.includes("'xdotool' 'search'")) return ok("4194305\n");
    if (cmd.includes("/stream/live.m3u8")) return ok(this.playlist);
    if (cmd.includes("/stream/")) return { ...ok("x"), bytes: new Uint8Array([1, 2, 3]) };
    if (cmd.includes("'inspect' '--format'")) return ok("true\nDESK_ALLOW=github.com\n");
    void stdin;
    return ok();
  };
}

function host(name: string, max = 2): HostConfig {
  return { name, address: `${name}.example`, key: "/k", known_hosts: "/kh", desktops_max: max };
}

class Fake implements DesktopBackend {
  made = 0;
  constructor(readonly name: "local" | "e2b", private root: string, readonly usdPerS = 0) {}
  unavailable() {
    return null;
  }
  async create(_o: CreateOpts): Promise<DesktopInstance> {
    const id = `${this.name}${this.made++}`;
    const dir = join(this.root, "live", id);
    mkdirSync(dir, { recursive: true });
    return {
      id, backend: this.name, streamDir: "/stream", hostStreamDir: dir, usdPerS: this.usdPerS,
      exec: async (a) => (a[0] === "desk-geom" ? ok(GEOM) : ok()),
      read: async () => null, sync: async () => {}, destroy: async () => {},
    };
  }
}

function makeTree() {
  const t = tmp();
  writeFileSync(join(t, "a.txt"), "hello\n");
  return t;
}

const begin = (pool: DesktopPool, agent: string, tree: string) => pool.begin({ agent, tree, repo: null, commit: "c", stacked: false, label: agent });

describe("placement", () => {
  test("hosts least loaded first, then this server, then E2B; down or full slots are skipped", () => {
    const s: Slot[] = [
      { key: "host:a", kind: "host", running: 2, max: 4, why: null },
      { key: "host:b", kind: "host", running: 1, max: 4, why: null },
      { key: "host:c", kind: "host", running: 0, max: 4, why: "unreachable" },
      { key: "host:d", kind: "host", running: 3, max: 3, why: null },
      { key: "local", kind: "local", running: 0, max: 2, why: null },
      { key: "e2b", kind: "e2b", running: 0, max: 3, why: null },
    ];
    expect(placementOrder(s).map((x) => x.key)).toEqual(["host:b", "host:a", "local", "e2b"]);
    const full = s.map((x) => ({ ...x, running: x.max }));
    expect(placementOrder(full)).toEqual([]);
    expect(noSlotWhy(full)).toBe("desktop hosts 11 of 11 busy (1 of 4 down); this server 2 of 2 busy; E2B 3 of 3 busy");
    expect(noSlotWhy([{ key: "local", kind: "local", running: 2, max: 2, why: null }, { key: "e2b", kind: "e2b", running: 1, max: 4, why: "day cap reached (16.0000 of 16 USD, UTC day)" }])).toBe("no desktop hosts; this server 2 of 2 busy; E2B: day cap reached (16.0000 of 16 USD, UTC day)");
  });

  test("capacity per host from the measured desktop with headroom", () => {
    // the site's own size: 4 vCPU, 7941 MiB (free -m on 2026-10-10)
    expect(hostCapacity({ cpus: 4, mem_mib: 7941 })).toMatchObject({ by_cpu: 5, by_mem: 8, desktops_max: 5 });
    expect(hostCapacity({ cpus: 8, mem_mib: 16000 })).toMatchObject({ by_cpu: 12, by_mem: 18, desktops_max: 12 });
    expect(hostCapacity({ cpus: 2, mem_mib: 2000 })).toMatchObject({ desktops_max: 1 });
    expect(hostCapacity({ cpus: 1, mem_mib: 1000 }).desktops_max).toBe(0);
  });
});

describe("pool across hosts", () => {
  test("least-loaded host first, then this server, then E2B; reserve holds a slot and says why when none is free", async () => {
    const root = tmp();
    const tree = makeTree();
    const hosts = new FakeHosts();
    const pool = new DesktopPool(
      { root, desktops_max: 1, e2b_max: 1, desktop_usd_per_day: 100, allow: ["github.com"], hosts: [host("h1", 2), host("h2", 1)], required: true },
      { local: new Fake("local", root), e2b: new Fake("e2b", root, 0.000046), hostRun: hosts.run, timers: false },
    );
    await pool.checkHosts();
    const a = await begin(pool, "a1", tree);
    const b = await begin(pool, "a2", tree);
    const c = await begin(pool, "a3", tree);
    expect([a?.backend, b?.backend, c?.backend]).toEqual(["host", "host", "host"]);
    expect(pool.status().hosts.map((h) => [h.name, h.running])).toEqual([["h1", 2], ["h2", 1]]);
    // the first two went to different hosts (both empty, h1 first in config), the third to h1 (1/2 < 1/1)
    const runs = hosts.calls.filter((x) => x.cmd.includes("'lineage.desktop=1'")).map((x) => x.host);
    expect(runs).toEqual(["h1.example", "h2.example", "h1.example"]);
    // a reserve holds this server's slot; a begin by someone else then goes to E2B
    expect(pool.reserve("a4")).toBeNull();
    expect((await begin(pool, "a5", tree))?.backend).toBe("e2b");
    expect((await begin(pool, "a4", tree))?.backend).toBe("local");
    // everything busy: the reason names every kind
    expect(pool.reserve("a6")).toBe("desktop hosts 3 of 3 busy; this server 1 of 1 busy; E2B 1 of 1 busy");
    expect(await begin(pool, "a6", tree)).toBeNull();
    await a!.end();
    expect(pool.reserve("a6")).toBeNull();
    for (const x of [b, c]) await x!.end();
    pool.stop();
  });

  test("isolation on a desktop host: same flags as this server's desktops, tree copied (no bind mounts), stream in a tmpfs", async () => {
    const root = tmp();
    const hosts = new FakeHosts();
    const b = new RemoteBackend({ root, host: host("h1"), run: hosts.run });
    await b.check();
    const inst = await b.create({ tree: makeTree(), homeUrl: "about:blank", allow: ["github.com"], label: "x" });
    const run = hosts.calls.find((x) => x.cmd.includes("'lineage.desktop=1'"))!.cmd;
    for (const f of ["'--read-only'", "'--cap-drop' 'ALL'", "'--security-opt' 'no-new-privileges'", "'--network' 'lineage-desk'", "'--user' '1000:1000'", "'--pids-limit'", "'/work/repo:size=512m,uid=1000,gid=1000,mode=0755'", "'/stream:size=64m,uid=1000,gid=1000,mode=0755'"]) expect(run).toContain(f);
    expect(run).not.toMatch(/'-v'|--volume|--mount|docker\.sock|--privileged/);
    expect(hosts.calls.some((x) => x.cmd.includes("'tar' '-xzf' '-' '-C' '/work/repo'"))).toBe(true);
    // the ssh command: our key and known_hosts only, strict host key checking, multiplexed
    const argv = b.sshArgv("health");
    for (const f of ["StrictHostKeyChecking=yes", "UserKnownHostsFile=/kh", "BatchMode=yes", "IdentitiesOnly=yes", "ControlMaster=auto"]) expect(argv).toContain(f);
    await inst.destroy();
  });

  test("a host going away: new desktops go elsewhere; a running desktop on it ends its stream cleanly (410)", async () => {
    const root = tmp();
    const tree = makeTree();
    const hosts = new FakeHosts();
    const logs: string[] = [];
    const pool = new DesktopPool(
      { root, desktops_max: 1, e2b_max: 0, desktop_usd_per_day: 0, allow: ["github.com"], hosts: [host("h1", 2)], required: true },
      { local: new Fake("local", root), hostRun: hosts.run, timers: false, log: (m) => logs.push(m) },
    );
    await pool.checkHosts();
    const a = (await begin(pool, "a1", tree))!;
    expect(a.backend).toBe("host");
    const sid = "ab".repeat(32);
    a.sessionOpened(sid);
    const gate = desktopHandler(root);
    const get = (f: string) => gate(new Request(`http://x/desktops/${sid}/${f}`));
    // the stream reaches the site's directory and the gate serves it
    await Bun.sleep(1300);
    expect((await get("live.m3u8"))!.status).toBe(200);
    expect((await get("seg-1.m4s"))!.status).toBe(200);
    // the host goes away
    hosts.down.add("h1.example");
    await pool.checkHosts();
    await pool.checkHosts();
    expect(pool.status().hosts[0]!.up).toBe(false);
    expect(logs.some((m) => /host h1 down: unreachable/.test(m))).toBe(true);
    // the next desktop goes to this server
    const b = (await begin(pool, "a2", tree))!;
    expect(b.backend).toBe("local");
    // the running one notices on its next guard tick and ends its stream
    await Bun.sleep(1300);
    expect((await get("live.m3u8"))!.status).toBe(410);
    expect(JSON.parse(readFileSync(join(root, "sessions", `${sid}.json`), "utf8")).ended_why).toBe("desktop host lost");
    expect(logs.some((m) => /lost; live stream ended/.test(m))).toBe(true);
    // the attempt still ends normally and frees its slot
    await a.end();
    await b.end();
    expect(pool.status().hosts[0]!.running).toBe(0);
    // the host comes back: new desktops go there again
    hosts.down.delete("h1.example");
    await pool.checkHosts();
    expect((await begin(pool, "a3", tree))?.backend).toBe("host");
    pool.stop();
  });

  test("hosts file: added, changed and removed hosts are picked up; a removed host takes no new desktops", async () => {
    const root = tmp();
    const file = join(root, "hosts.json");
    const hosts = new FakeHosts();
    writeFileSync(file, JSON.stringify({ hosts: [host("h1", 1)] }));
    const pool = new DesktopPool({ root, desktops_max: 0, e2b_max: 0, desktop_usd_per_day: 0, allow: ["github.com"], hosts_file: file }, { hostRun: hosts.run, timers: false });
    expect([...pool.hosts.keys()]).toEqual(["h1"]);
    writeFileSync(file, JSON.stringify({ hosts: [host("h1", 3), host("h2", 1), { name: "BAD NAME" }] }));
    pool.loadHosts();
    expect([...pool.hosts.entries()].map(([n, b]) => [n, b.host.desktops_max])).toEqual([["h1", 3], ["h2", 1]]);
    const old = pool.hosts.get("h2")!;
    writeFileSync(file, JSON.stringify({ hosts: [host("h1", 3)] }));
    pool.loadHosts();
    expect(old.retired).toBe(true);
    expect(old.unavailable()).toMatch(/removed/);
    pool.stop();
  });
});

describe("stream pull", () => {
  test("segments land whole before the playlist that lists them; dropped segments are removed", async () => {
    const dir = tmp();
    const files: Record<string, string> = { "/s/live.m3u8": "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\nseg-1.m4s\nseg-2.m4s\n", "/s/init.mp4": "I", "/s/seg-1.m4s": "1", "/s/seg-2.m4s": "2" };
    const order: string[] = [];
    const exec = async (a: string[]) => {
      order.push(a[1]!);
      const v = files[a[1]!];
      return v === undefined ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: v, stderr: "", bytes: new TextEncoder().encode(v) };
    };
    const have = new Set<string>();
    await pullStream(exec, "/s", dir, have);
    expect(readFileSync(join(dir, "seg-2.m4s"), "utf8")).toBe("2");
    expect(readFileSync(join(dir, "live.m3u8"), "utf8")).toContain("seg-2.m4s");
    // next round: seg-1 dropped, seg-3 not yet written: the old playlist stays
    files["/s/live.m3u8"] = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\nseg-2.m4s\nseg-3.m4s\n";
    order.length = 0;
    await pullStream(exec, "/s", dir, have);
    expect(order).toEqual(["/s/live.m3u8", "/s/seg-3.m4s"]);
    expect(readFileSync(join(dir, "live.m3u8"), "utf8")).not.toContain("seg-3");
    files["/s/seg-3.m4s"] = "3";
    await pullStream(exec, "/s", dir, have);
    expect(existsSync(join(dir, "seg-1.m4s"))).toBe(false);
    expect(readFileSync(join(dir, "seg-3.m4s"), "utf8")).toBe("3");
  });
});

describe("host gateway (lineage-desk-gw)", () => {
  const GW = join(import.meta.dir, "../../../scripts/deploy/desktop-host/lineage-desk-gw");
  const hasPy = Bun.spawnSync(["python3", "-c", "1"]).exitCode === 0;

  function gw(cmd: string) {
    const bin = tmp();
    // a stand-in docker that prints its argv, so an accepted command shows exactly what would run
    writeFileSync(join(bin, "docker"), "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
    chmodSync(join(bin, "docker"), 0o755);
    const p = Bun.spawnSync(["python3", GW], { env: { PATH: `${bin}:/usr/bin:/bin`, SSH_ORIGINAL_COMMAND: cmd }, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  }

  test.skipIf(!hasPy)("accepts every command the remote backend sends", async () => {
    const root = tmp();
    const hosts = new FakeHosts();
    const b = new RemoteBackend({ root, host: host("h1"), run: hosts.run });
    await b.check();
    const inst = await b.create({ tree: makeTree(), homeUrl: "https://github.com/a/b/tree/c", allow: ["github.com", "githubusercontent.com"], label: "agent-x" });
    await inst.exec(["desk-geom"]);
    await inst.exec(["desk-put", "out-1"], { stdin: "text" });
    await inst.push!("src/a.rs", new Uint8Array([1]));
    await inst.sync();
    await inst.destroy();
    const seen = new Set<string>();
    for (const c of hosts.calls) {
      if (c.cmd === "'health'" || c.cmd === "'sweep'" || seen.has(c.cmd)) continue;
      seen.add(c.cmd);
      const r = gw(c.cmd);
      if (r.code !== 0) throw new Error(`gateway refused ${c.cmd}: ${r.err}`);
    }
    expect(seen.size).toBeGreaterThan(8);
  }, 60_000);

  test.skipIf(!hasPy)("refuses what would reach the host: privileged, mounts, host network, root exec, other containers, other commands", () => {
    const base = "docker run -d --name lineage-desk-0123456789abcdef --label lineage=1 --label lineage.desktop=1 --network lineage-desk --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000";
    expect(gw(`${base} lineage/desktop`).code).toBe(0);
    for (const bad of [
      `${base} --privileged lineage/desktop`,
      `${base} -v /:/host lineage/desktop`,
      `${base} --mount type=bind,src=/,dst=/h lineage/desktop`,
      `${base} --cap-add SYS_ADMIN lineage/desktop`,
      `${base} -p 80:80 lineage/desktop`,
      `${base} lineage/desktop sh -c id`,
      `${base} ubuntu`,
      base.replace("--user 1000:1000", "--user 0:0") + " lineage/desktop",
      base.replace("--network lineage-desk", "--network host") + " lineage/desktop",
      base.replace(" --read-only", "") + " lineage/desktop",
      "docker exec -u 0:0 lineage-desk-0123456789abcdef id",
      "docker exec -u root lineage-desk-0123456789abcdef id",
      "docker exec --privileged lineage-desk-0123456789abcdef id",
      "docker exec some-other id",
      "docker rm -f some-other",
      "docker ps",
      "docker run -d --name x ubuntu",
      "bash -c id",
      "docker image inspect ubuntu",
    ]) {
      const r = gw(bad);
      if (r.code !== 126) throw new Error(`gateway accepted: ${bad}`);
    }
  });
});
