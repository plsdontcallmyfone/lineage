#!/usr/bin/env bun
// "It should keep running all time" (owner 2026-10-12), proven on the real E2B account: in
// desktop_mode per_agent the live stream is the agent's own and goes on across attempts and between
// them. One agent desktop, the runtime's desktop pool in this process, and the stream read over HTTP
// through the same handler the gate forwards to (/desktops/<id>/live.m3u8).
//
//  1. the desktop is created; its stream answers under the agent's stream id before any attempt;
//  2. attempt 1 opens a session: the session id serves the same playlist; the playlist advances;
//  3. attempt 1 ends: the session id answers 410, the agent's stream keeps advancing; same sandbox,
//     same encoder process;
//  4. attempt 2 starts on the same desktop: still the same encoder process, the playlist never stops;
//  5. the agent sleeps: desktop paused, the stream answers 410; its next attempt resumes it and the
//     stream is back under the same id;
//  6. everything removed; the E2B list shows none of this run's sandboxes.
//
// No chain, no Core, no model call. Only sandboxes with this run's owner label are touched; the key is
// never printed; sandbox ids are printed as prefixes. Usage: bun scripts/desktops/stream-proof.ts [--mask]
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey } from "@units/protocol";
import { streamIdOf } from "../../packages/desktop/src/agent-desktops.ts";
import { E2BBackend, e2bUsdPerS, loadE2BKey, type E2BApi } from "../../packages/desktop/src/e2b.ts";
import { withDesktops } from "../../packages/desktop/src/publish.ts";
import { parseConfig } from "../../packages/runtime/src/config.ts";
import { desktopPool } from "../../packages/runtime/src/desktops.ts";
import { check, log, results, ROOT, waitFor } from "../runtime/lib.ts";

const MASK = process.argv.includes("--mask");
const free = (p: number) => !Bun.spawnSync(["lsof", "-ti", `:${p}`]).stdout.toString().trim();
const PORT = [9664, 9667, 9663, 9666, 9668, 9669].find(free);
if (!PORT) throw new Error("no free port among 9663, 9664, 9666-9669");
if (!loadE2BKey()) throw new Error("no E2B key (~/.config/units/e2b.env)");
const OWNER = `proof-${randomBytes(4).toString("hex")}`;
const RATE = e2bUsdPerS(2, 4);
const tmp = mkdtempSync(join(tmpdir(), "units-stream-proof-"));
const short = (id: string | null | undefined) => (id ? id.slice(0, 6) : "none");
const agent = generateAgentKey().id;
const out: Record<string, unknown> = { at: new Date().toISOString(), owner: OWNER, mask: MASK };
const tStart = Date.now();
let api: E2BApi | null = null;
const mine = async () => api!.list({ units_desktop: "agent", owner: OWNER });

const cfg = parseConfig({
  mode: "sim", core: "http://127.0.0.1:9", runtime_key: "k", state_dir: join(tmp, "runtime"), compute_price_line_per_usd: "1", compute_price_line_per_sandbox_s: "0", attempt_max_usd: 1, sandbox_reserve_s: 0, min_attempt_usd: 0.05,
  desktops_max: 0, e2b_max: 1, desktop_usd_per_day: 1, desktop_required: true, desktop_mode: "per_agent", desktop_owner: OWNER, desktop_idle_pause: false, desktop_keepalive_s: 300, desktop_remove_after_s: 0, desktop_mask: MASK,
  e2b: { template: "lineage-desktop", vcpu: 2, ram_gib: 4, session_max_s: 3600 },
});

async function main() {
  api = await new E2BBackend({ root: tmp }).api();
  const plog: string[] = [];
  const pool = desktopPool(cfg, (m) => (plog.push(m), console.log(`   pool ${m}`)))!;
  const man = pool.agents!;
  const server = Bun.serve({ port: PORT, hostname: "127.0.0.1", fetch: withDesktops(pool) });
  const base = `http://127.0.0.1:${PORT}/desktops`;
  const stream = streamIdOf(agent);
  const get = async (id: string) => {
    const r = await fetch(`${base}/${id}/live.m3u8`);
    const text = r.status === 200 ? await r.text() : "";
    const segs = [...text.matchAll(/seg-(\d+)\.m4s/g)].map((x) => Number(x[1]));
    return { status: r.status, text, last: segs.at(-1) ?? null, error: r.status === 200 ? null : ((await r.json().catch(() => ({}))) as { error?: string }).error ?? null };
  };
  // every second, what a viewer of the agent's stream gets: the newest segment's number
  const samples: { t: number; status: number; last: number | null; mark: string }[] = [];
  let mark = "before any attempt";
  const sampler = setInterval(() => void get(stream).then((g) => samples.push({ t: Date.now(), status: g.status, last: g.last, mark })).catch(() => undefined), 1000);
  const sync = (o: { working?: boolean; asleep?: boolean } = {}) => pool.syncAgents([{ agent, working: false, asleep: false, ...o }]);
  const pidOf = async () => {
    const id = man.sandboxOf(agent)!;
    const sbx = await api!.connect(id, { timeoutMs: 300_000 });
    const r = await sbx.commands.run("p=$(cat /tmp/desk/live.pid); echo $p; tr '\\0' ' ' < /proc/$p/cmdline", { timeoutMs: 10_000 });
    const [pid, cmd = ""] = r.stdout.split("\n");
    return { pid: pid!.trim(), cmd };
  };

  try {
    // ---------------------------------------------------------------- 1. created: live before any attempt
    await man.settle();
    sync();
    await waitFor("the desktop", async () => (pool.agentDesktop(agent)?.state === "running" ? true : (sync(), null)), 180_000, 500);
    const id0 = man.sandboxOf(agent);
    out.sandbox = short(id0);
    check("the agent's desktop runs and its state names the stream id (64 hex, the desktop route's own shape)", pool.agentDesktop(agent)!.stream === stream && /^[0-9a-f]{64}$/.test(stream), short(id0));
    const t1 = Date.now();
    const first = await waitFor("the stream before any attempt", async () => ((await get(stream)).status === 200 ? get(stream) : null), 60_000, 500);
    out.first_playlist_after_create_ms = Date.now() - t1;
    check("the stream answers under the agent's id before any attempt (the desktop session with nothing in it)", first.status === 200 && first.last !== null, `first playlist ${out.first_playlist_after_create_ms} ms after the desktop was running`);
    const enc0 = await pidOf();
    check(MASK ? "mask on: the encoder runs the pixelation filter" : "mask off: the encoder's filter is the plain screen, no crop, no pixelation", MASK ? enc0.cmd.includes("flags=neighbor") : enc0.cmd.includes("[0:v]format=yuv420p[v]") && !enc0.cmd.includes("crop=") && !enc0.cmd.includes("scale="), `filter: ${(/-filter_complex (\S+)/.exec(enc0.cmd)?.[1] ?? "?").slice(0, 60)}`);

    // a small repository for the attempts
    const tree = join(tmp, "tree");
    Bun.spawnSync(["git", "init", "-q", tree]);
    writeFileSync(join(tree, "hello.py"), "print('hello')\n");
    Bun.spawnSync(["git", "-C", tree, "add", "."]);
    Bun.spawnSync(["git", "-C", tree, "-c", "user.name=proof", "-c", "user.email=proof@example.invalid", "commit", "-q", "-m", "one"]);
    const commit = Bun.spawnSync(["git", "-C", tree, "rev-parse", "HEAD"]).stdout.toString().trim();
    const attempt = async (n: number) => {
      mark = `attempt ${n} starting`;
      if (pool.reserve(agent)) throw new Error(`no desktop: ${pool.status().waiting_why}`);
      sync({ working: true });
      const t0 = Date.now();
      const at = await pool.begin({ agent, tree, repo: null, commit, stacked: false, label: `stream-proof-${n}` });
      if (!at) throw new Error(`attempt ${n} got no desktop: ${pool.status().waiting_why}`);
      const sid = randomBytes(32).toString("hex");
      at.sessionOpened(sid);
      mark = `attempt ${n}`;
      return { at, sid, ready_ms: Date.now() - t0 };
    };

    // ---------------------------------------------------------------- 2. attempt 1
    const a1 = await attempt(1);
    at_event(a1.at);
    await Bun.sleep(6000);
    const s1 = await get(a1.sid);
    const g1 = await get(stream);
    check("attempt 1: its session id serves the agent's stream (the same playlist under both names)", s1.status === 200 && g1.status === 200 && s1.last !== null && Math.abs(s1.last - g1.last!) <= 1, `session ready ${a1.ready_ms} ms after the reserve; newest segment ${s1.last} by session id, ${g1.last} by agent id`);
    const enc1 = await pidOf();
    // ---------------------------------------------------------------- 3. attempt 1 ends
    await a1.at.end();
    mark = "between attempts 1 and 2";
    sync();
    await Bun.sleep(1500);
    const ended = await get(a1.sid);
    check("attempt 1 ended: its session id answers 410", ended.status === 410, `${ended.status} ${ended.error}`);
    const b0 = await get(stream);
    await Bun.sleep(10_000);
    const b1 = await get(stream);
    check("between attempts the agent's stream keeps advancing", b0.status === 200 && b1.status === 200 && b1.last! > b0.last!, `newest segment ${b0.last} -> ${b1.last} in 10 s with no attempt running`);
    check("same sandbox", man.sandboxOf(agent) === id0 && (await mine()).length === 1, short(man.sandboxOf(agent)));

    // ---------------------------------------------------------------- 4. attempt 2 on the same desktop
    const a2 = await attempt(2);
    at_event(a2.at);
    await Bun.sleep(6000);
    const enc2 = await pidOf();
    const s2 = await get(a2.sid);
    check("attempt 2 started on the same desktop without restarting its windows or its encoder", enc2.pid === enc0.pid && enc1.pid === enc0.pid && s2.status === 200, `encoder pid ${enc0.pid} before attempt 1, ${enc1.pid} in it, ${enc2.pid} in attempt 2; session ready ${a2.ready_ms} ms after the reserve`);
    await a2.at.end();
    mark = "after attempt 2";
    sync();
    await Bun.sleep(4000);
    // the whole run so far, as a viewer saw it second by second
    const seen = samples.filter((x) => x.t > t1 + (out.first_playlist_after_create_ms as number) + 1500);
    const not200 = seen.filter((x) => x.status !== 200);
    let back = 0;
    let maxStall = 0;
    let run = 0;
    for (let i = 1; i < seen.length; i++) {
      if (seen[i]!.last !== null && seen[i - 1]!.last !== null && seen[i]!.last! < seen[i - 1]!.last!) back++;
      run = seen[i]!.last === seen[i - 1]!.last ? run + (seen[i]!.t - seen[i - 1]!.t) : 0;
      maxStall = Math.max(maxStall, run);
    }
    out.viewer = { samples: seen.length, not_200: not200.length, went_back: back, longest_without_a_new_segment_ms: maxStall, first_segment: seen[0]?.last, last_segment: seen.at(-1)?.last, by_phase: Object.fromEntries([...new Set(seen.map((x) => x.mark))].map((m) => [m, seen.filter((x) => x.mark === m).length])) };
    check("a viewer polling every second across both attempts and the gaps: always 200, the playlist never went back and never stopped for 8 s", seen.length > 20 && not200.length === 0 && back === 0 && maxStall < 8000, `${seen.length} polls, ${not200.length} not 200, longest time without a new segment ${maxStall} ms (segments are 2 s), segments ${seen[0]?.last} to ${seen.at(-1)?.last}`);
    check("one encoder start for the whole run so far", plog.filter((l) => l.includes("blackout")).length === 0 && enc2.pid === enc0.pid);

    // ---------------------------------------------------------------- 5. asleep: paused, 410; then back
    mark = "asleep";
    const tp = Date.now();
    sync({ asleep: true });
    await man.settle();
    const paused = await get(stream);
    check("the agent sleeps: desktop paused, the stream answers 410 and the state says why", (await mine())[0]?.state === "paused" && paused.status === 410 && pool.agentDesktop(agent)!.state === "paused" && pool.agentDesktop(agent)!.stream === null, `paused in ${Date.now() - tp} ms; "${pool.agentDesktop(agent)!.why}"`);
    sync();
    const tr = Date.now();
    const a3 = await attempt(3);
    const back3 = await waitFor("the stream after the resume", async () => ((await get(stream)).status === 200 ? get(stream) : null), 60_000, 300);
    out.stream_back_after_resume_ms = Date.now() - tr;
    check("its next attempt resumes it: the stream is back under the same id, same sandbox", back3.status === 200 && man.sandboxOf(agent) === id0 && back3.last! > b1.last!, `first playlist ${out.stream_back_after_resume_ms} ms after the attempt asked for its desktop`);
    await a3.at.end();
  } finally {
    clearInterval(sampler);
    // ---------------------------------------------------------------- 6. removal
    pool.syncAgents([]);
    await man.settle();
    pool.syncAgents([]);
    await man.settle();
    out.spent_usd_own_count = +pool.spentToday().toFixed(4);
    pool.stop();
    server.stop(true);
  }
  check("removed: the E2B list shows none of this run's sandboxes", (await mine()).length === 0);
}
function at_event(at: { event(e: never): void }) {
  // one real action on the desktop per attempt: a listing in the navigation terminal
  at.event({ kind: "list", path: "." } as never);
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  check("the proof ran to its end", false, String((e as Error).message ?? e).slice(0, 300));
} finally {
  try {
    api ??= await new E2BBackend({ root: tmp }).api();
    for (const i of await mine()) await api.kill(i.sandboxId).catch(() => false);
    out.left_at_e2b = (await mine()).length;
  } catch (e) {
    out.cleanup_error = String((e as Error).message ?? e).slice(0, 200);
  }
  const wall = (Date.now() - tStart) / 1000;
  out.wall_s = Math.round(wall);
  out.spent_usd_upper_bound = +(RATE * wall).toFixed(4);
  out.checks = results;
  out.pass = results.filter((r) => r.ok).length;
  out.total = results.length;
  writeFileSync(join(ROOT, `scripts/desktops/STREAM-PROOF-LAST${MASK ? "-MASK" : ""}.json`), JSON.stringify(out, null, 2) + "\n");
  rmSync(tmp, { recursive: true, force: true });
  log(`${out.pass}/${out.total} checks; E2B spend by the runtime's own count ${out.spent_usd_own_count ?? "?"} USD, upper bound ${out.spent_usd_upper_bound} USD (1 desktop x ${out.wall_s} s)`);
  process.exit(!failed && results.every((r) => r.ok) ? 0 : 1);
}
