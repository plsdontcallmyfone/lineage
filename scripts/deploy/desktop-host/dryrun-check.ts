#!/usr/bin/env bun
// Part of scripts/deploy/desktop-host/dryrun.sh: the pool against the real dry-run desktop host.
// Placement onto the host; the host going away (its container paused): health marks it down, a new
// desktop is refused with the reason (no other slot here), the running desktop ends its stream cleanly
// (the gate answers 410); the host back: a new desktop starts there again. Appends JSON lines to
// --results. Never touches anything but the dry-run container (DRYRUN_CONTAINER).
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopPool } from "../../../packages/desktop/src/pool.ts";
import { desktopHandler } from "../../../packages/desktop/src/serve.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => argv[argv.indexOf(`--${k}`) + 1]!;
const results = opt("results");
const container = process.env.DRYRUN_CONTAINER!;
if (!/^lineage-deskhost-dryrun$/.test(container ?? "")) throw new Error("DRYRUN_CONTAINER must be the dry-run container");
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) fail++;
  appendFileSync(results, JSON.stringify({ check: name, ok, detail }) + "\n");
};
const root = mkdtempSync(join(tmpdir(), "lin-dh-"));
const logs: string[] = [];
const pool = new DesktopPool(
  { root, desktops_max: 0, e2b_max: 0, desktop_usd_per_day: 0, allow: ["github.com", "githubusercontent.com", "githubassets.com"], hosts_file: opt("hosts-file"), required: true },
  { timers: false, log: (m) => (logs.push(m), console.log(`[pool] ${m}`)) },
);
const begin = (agent: string) => pool.begin({ agent, tree: opt("tree"), repo: null, commit: "c", stacked: false, label: agent });
const docker = (...a: string[]) => Bun.spawnSync(["docker", ...a]).exitCode;
try {
  await pool.checkHosts();
  check("pool: the registered host is up", pool.status().hosts[0]?.up === true, JSON.stringify(pool.status().hosts[0]));
  const t0 = Date.now();
  const a = await begin("agent-one");
  check("placement: a new desktop goes to the desktop host", a?.backend === "host", `up in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (!a) throw new Error("no desktop");
  const sid = "cd".repeat(32);
  a.sessionOpened(sid);
  const gate = desktopHandler(root);
  const get = async (f: string) => (await gate(new Request(`http://x/desktops/${sid}/${f}`)))!.status;
  let s = 0;
  for (let i = 0; i < 30 && s !== 200; i++) {
    await Bun.sleep(1000);
    s = await get("live.m3u8");
  }
  check("the gate serves the host desktop's stream from the site", s === 200);
  // the host goes away
  check("host paused", docker("pause", container) === 0);
  for (let i = 0; i < 3; i++) await pool.checkHosts();
  check("health marks the host down", pool.status().hosts[0]?.up === false, pool.status().hosts[0]?.why ?? "");
  const why = pool.reserve("agent-two");
  check("a new attempt waits with the reason (no other slot configured)", why !== null && /down/.test(why), why ?? "");
  let st = 0;
  for (let i = 0; i < 40 && st !== 410; i++) {
    await Bun.sleep(1000);
    st = await get("live.m3u8");
  }
  check("the running desktop's stream ends cleanly (410)", st === 410, JSON.parse(readFileSync(join(root, "sessions", `${sid}.json`), "utf8")).ended_why ?? "");
  // the agent's attempt ends; its slot frees even though the host cannot be told yet
  docker("unpause", container);
  await a.end();
  check("the slot is freed", pool.status().hosts[0]?.running === 0);
  await pool.checkHosts();
  const b = await begin("agent-three");
  check("the host back: new desktops go there again", b?.backend === "host");
  await b?.end();
} catch (e) {
  check("dry-run pool check", false, (e as Error).message);
  docker("unpause", container);
} finally {
  pool.stop();
  rmSync(root, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
