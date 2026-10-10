#!/usr/bin/env bun
// Agent desktops proof (SPEC 17.7): one scripted attempt on a real desktop, without a model or Core.
//
//   bun packages/desktop/scripts/proof.ts --tree <git checkout> --out <dir> [--backend local|e2b] [--hold 20]
//
// Opens a desktop (our own container, or an E2B desktop with --backend e2b), plays a session the way
// the toolbox records one (list, read, search, edit then the file write, a search over the edited tree,
// an evaluation with output), keeps a copy of the live stream as it was served, ends the attempt and
// keeps the recording. Writes <out>/live/ (the HLS files), <out>/recording.mp4 and <out>/proof.json
// (actions, refusals, CPU samples of the desktop container for the local backend). Frames are checked
// by scripts/frames.ts. Never prints a key.
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DesktopPool } from "../src/pool.ts";

const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1]! : d);
const tree = resolve(opt("tree")!);
const out = resolve(opt("out")!);
const backend = opt("backend", "local")!;
const hold = Number(opt("hold", "20"));
mkdirSync(out, { recursive: true });
const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: tree }).stdout.toString().trim();
const repo = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: tree }).stdout.toString().trim() || null;
const logs: string[] = [];
const log = (m: string) => (logs.push(m), console.log(`[proof] ${m}`));

const pool = new DesktopPool(
  { root: join(out, "state"), desktops_max: backend === "local" ? 1 : 0, e2b_max: backend === "e2b" ? 1 : 0, desktop_usd_per_day: 5, allow: ["github.com", "githubusercontent.com", "githubassets.com"], e2b: { session_max_s: 900 } },
  { log },
);
const t0 = Date.now();
const a = await pool.begin({ agent: "Proof11111111111111111111111111111111111111", tree, repo, commit, stacked: false, label: "proof" });
if (!a) throw new Error("no desktop slot: " + logs.join("; "));
log(`desktop up in ${((Date.now() - t0) / 1000).toFixed(1)} s on ${a.backend}`);
const sid = "a".repeat(64);
a.sessionOpened(sid);

const cpu: { t: number; cpu: string; mem: string }[] = [];
const sampler = backend === "local"
  ? setInterval(() => {
      const r = Bun.spawnSync(["docker", "stats", "--no-stream", "--format", "{{.Name}} {{.CPUPerc}} {{.MemUsage}}"]);
      for (const l of r.stdout.toString().split("\n")) if (l.startsWith("lineage-desk-") && !l.startsWith("lineage-desk-proxy")) {
        const [, c, ...m] = l.split(" ");
        cpu.push({ t: Math.round((Date.now() - t0) / 1000), cpu: c!, mem: m.join(" ") });
      }
    }, 3000)
  : null;

const step = (ms: number) => Bun.sleep(ms);
const file = "minbpe/basic.py";
const src = readFileSync(join(tree, file), "utf8");
const lines = src.split("\n");
const anchor = lines.findIndex((l) => l.includes("def train")) + 1 || 10;
await step(3000);
a.event({ kind: "list", path: ".", count: 9 });
await step(2500);
a.event({ kind: "read", path: file, start_line: anchor, end_line: anchor + 12 });
await step(5000);
a.event({ kind: "search", query: "def get_stats", matches: 2 });
await step(4000);
// the toolbox records the edit, then writes it
const SECRET = "SEALED_EDIT_MARKER = 'do not leak before the verdict'";
const target = lines[anchor]!;
a.event({ kind: "edit", path: file, start_line: anchor + 1, end_line: anchor + 1, lines_before: 1, lines_after: 2, before: target, after: `${target}\n        ${SECRET}` });
writeFileSync(join(tree, file), src.replace(target, `${target}\n        ${SECRET}`));
await step(5000);
a.event({ kind: "search", query: "SEALED_EDIT_MARKER", matches: 1 });
await step(4000);
a.event({ kind: "evaluate", target: "train", eval_kind: "perf" });
for (const p of ["prepare", "build", "test", "metrics"] as const) {
  await step(1200);
  a.event({ kind: "phase", phase: p });
}
a.event({ kind: "result", outcome: "accepted", output: `outcome: accepted\nmetric train_ms: parent 812, candidate 640, ratio 0.7882\n${SECRET}` });
await step(hold * 1000);
// the live stream as served, before the attempt ends (the gate's directory goes away at the end)
const sessionMeta = JSON.parse(readFileSync(pool.sessionFile(sid), "utf8")) as { dir: string };
if (existsSync(sessionMeta.dir)) cpSync(sessionMeta.dir, join(out, "live"), { recursive: true });
const tEnd = Date.now();
await a.end();
if (sampler) clearInterval(sampler);
log(`attempt ended in ${((Date.now() - tEnd) / 1000).toFixed(1)} s`);
const held = pool.pending().find((p) => p.session_id === sid);
if (held) renameSync(held.file, join(out, "recording.mp4"));
// restore the tree
writeFileSync(join(tree, file), src);
writeFileSync(join(out, "proof.json"), JSON.stringify({ backend, commit, repo, seconds: Math.round((Date.now() - t0) / 1000), recording_bytes: held?.bytes ?? 0, cpu, logs, e2b_spent_today_usd: pool.spentToday() }, null, 2));
console.log(`[proof] wrote ${out}`);
process.exit(0);
