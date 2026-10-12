#!/usr/bin/env bun
// One E2B desktop per agent, proven on the real E2B account (docs/plans/AGENT-DESKTOPS.md, "one E2B
// desktop per agent"). No chain transaction: a local simulated Core, three hosted TEST agents launched
// on it, and `units-runtime run` as its own process in desktop_mode per_agent. No model call: the
// agents make no attempt (max_candidates_per_agent 0), only their desktops live.
//
//  1. binding the three agents creates three desktops in the background (metadata: agent id, this
//     run's own owner label); Core serves each one's state;
//  2. the runtime is stopped and started again: the same three sandbox ids, no new sandbox;
//  3. the runtime is stopped again and the same state directory is taken over in this process (a
//     third start: the same ids again) to drive the rest directly: a session with a live stream on
//     one desktop, that desktop paused and resumed with the times, a second session on it, one
//     session window renewed, every desktop removed;
//  4. the E2B list call shows none of this run's sandboxes left.
//
// Only sandboxes with this run's owner label are listed, paused or killed. The key is read from
// ~/.config/units/e2b.env by the backend and never printed. Sandbox ids are printed as 6-character
// prefixes. Usage: bun scripts/desktops/proof.ts [--port 9664]
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey, type AgentKey } from "@units/protocol";
import { CoreClient } from "../../packages/core/src/client.ts";
import { E2BBackend, e2bUsdPerS, loadE2BKey, type E2BApi, type E2BInfo } from "../../packages/desktop/src/e2b.ts";
import { parseGeom } from "../../packages/desktop/src/pool.ts";
import { parseConfig } from "../../packages/runtime/src/config.ts";
import { desktopPool } from "../../packages/runtime/src/desktops.ts";
import { check, child, log, ok, results, ROOT, stopAll, waitFor } from "../runtime/lib.ts";

const argv = process.argv.slice(2);
const free = (p: number) => !Bun.spawnSync(["lsof", "-ti", `:${p}`]).stdout.toString().trim();
const PORT = argv.includes("--port") ? Number(argv[argv.indexOf("--port") + 1]) : [9664, 9667, 9663, 9666, 9668, 9669].find(free);
if (!PORT || ![9663, 9664, 9666, 9667, 9668, 9669].includes(PORT) || !free(PORT)) throw new Error("no free port among 9663, 9664, 9666-9669");
const CORE = `http://127.0.0.1:${PORT}`;
if (!loadE2BKey()) throw new Error("no E2B key (~/.config/units/e2b.env)");

const OWNER = `proof-${randomBytes(4).toString("hex")}`;
const RATE = e2bUsdPerS(2, 4);
const tmp = mkdtempSync(join(tmpdir(), "units-desktops-proof-"));
const stateDir = join(tmp, "runtime");
const short = (id: string | null | undefined) => (id ? id.slice(0, 6) : "none");
const writeKey = (name: string, k: AgentKey) => {
  const p = join(tmp, `${name}.json`);
  writeFileSync(p, JSON.stringify(Array.from(k.secret)), { mode: 0o600 });
  return p;
};
const keys = { admin: generateAgentKey(), runtime: generateAgentKey() };
const agents = [generateAgentKey(), generateAgentKey(), generateAgentKey()];
const kp = { admin: writeKey("admin", keys.admin), runtime: writeKey("runtime", keys.runtime) };
const net = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
Object.assign(net, { canary_rate: 0, audit_rate: 0, epoch_length_s: 86400 });
writeFileSync(join(tmp, "network.json"), JSON.stringify(net));
const admin = new CoreClient(CORE, keys.admin);
const anon = new CoreClient(CORE, null);
const ONE = 10n ** BigInt(net.token_decimals);

// the runtime's config: desktops per agent, nothing else of note; TEST values
const cfg = {
  _note: "agent desktops proof: TEST values; no attempts (max_candidates_per_agent 0), no model call",
  mode: "sim",
  core: CORE,
  state_dir: stateDir,
  runtime_key: kp.runtime,
  attempt_max_usd: 0.5,
  global_max_usd: 0.01,
  min_attempt_usd: 0.1,
  compute_price_line_per_usd: "5",
  compute_price_line_per_sandbox_s: "0.001",
  sandbox_reserve_s: 300,
  usage_epoch_s: 3600,
  poll_ms: 2000,
  max_concurrent: 1,
  max_candidates_per_agent: 0,
  spend_report_s: 4,
  lineages: [],
  desktops_max: 0,
  e2b_max: 3,
  desktop_usd_per_day: 1,
  desktop_required: true,
  desktop_mode: "per_agent",
  desktop_owner: OWNER,
  desktop_idle_s: 1800,
  desktop_keepalive_s: 300,
  desktop_remove_after_s: 300,
  desktop_start_parallel: 3,
  e2b: { template: "lineage-desktop", vcpu: 2, ram_gib: 4, session_max_s: 3600 },
};
const cfgFile = join(tmp, "runtime-config.json");
writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));

const out: Record<string, unknown> = { at: new Date().toISOString(), owner: OWNER, template: "lineage-desktop (2 vCPU, 4 GiB)", usd_per_desktop_hour: +(RATE * 3600).toFixed(4) };
let api: E2BApi | null = null;
const mine = async (): Promise<E2BInfo[]> => (await api!.list({ units_desktop: "agent", owner: OWNER })).sort((a, b) => a.metadata.agent!.localeCompare(b.metadata.agent!));
const idsOf = (l: E2BInfo[]) => agents.map((a) => l.find((i) => i.metadata.agent === a.id)?.sandboxId ?? null);
const tStart = Date.now();

async function startRuntime(lines: string[]) {
  const rt = child("rt", ["bun", join(ROOT, "packages/runtime/src/main.ts"), "run", "--config", cfgFile], (l) => lines.push(l));
  return rt;
}
async function stopRuntime(rt: ReturnType<typeof child>) {
  // our own child, by its handle
  rt.kill("SIGTERM");
  const t = setTimeout(() => rt.exitCode === null && rt.kill("SIGKILL"), 30_000);
  await rt.exited;
  clearTimeout(t);
}

async function main() {
  api = await new E2BBackend({ root: tmp }).api();
  const before = await api.list({ units_desktop: "agent", owner: OWNER });
  check("this run's owner label is unused before the run", before.length === 0, OWNER);

  child("core", ["bun", join(ROOT, "packages/core/src/main.ts"), "--data", join(tmp, "data"), "--port", String(PORT), "--config", join(tmp, "network.json"), "--admin-key", kp.admin, "--runtime-key", kp.runtime, "--tick-ms", "500", "--no-trees"], () => {});
  await waitFor("core", async () => (await fetch(`${CORE}/v1/health`).catch(() => null))?.ok);
  for (const a of agents) {
    await ok(admin.post("/v1/admin/launches", { agent: a.id, mint: generateAgentKey().id, launcher: generateAgentKey().id, target_repo: "https://github.com/karpathy/minbpe", hosted: true, identity_mode: "app" }), "launch");
    await ok(admin.post("/v1/admin/agent-fees", { agent: a.id, amount: ((3n * ONE * 10_000n + 6999n) / 7000n).toString() }), "fees");
  }
  const v0 = await ok(anon.get(`/v1/agents/${agents[0]!.id}`), "agent");
  check("three hosted TEST agents launched on the local simulated Core, awake (no chain)", v0.awake === true && v0.hosted === true, agents.map((a) => a.id.slice(0, 6)).join(", "));

  // ---------------------------------------------------------------- 1. binding creates the desktops
  const lines1: string[] = [];
  let rt = await startRuntime(lines1);
  const reqs = await waitFor("bind requests", async () => {
    const fs = agents.map((a) => join(stateDir, "bind-requests", `${a.id}.json`));
    return fs.every((f) => existsSync(f)) ? fs.map((f) => JSON.parse(readFileSync(f, "utf8"))) : null;
  }, 90_000, 500);
  check("no desktop before any agent is bound", (await mine()).length === 0);
  const tBind = Date.now();
  for (const [i, a] of agents.entries()) await ok(new CoreClient(CORE, a).post(`/v1/agents/${a.id}/keys/rotate`, reqs[i].body), "bind");
  const bindMs = Date.now() - tBind;
  const bound = await waitFor("bound in the runtime", async () => lines1.filter((l) => l.includes("is bound to runtime key")).length === 3, 60_000, 250);
  const tBound = Date.now();
  check("the three binds went through without waiting on E2B", !!bound && (await mine()).filter((i) => i.state === "running").length < 3, `3 key rotations at Core took ${bindMs} ms; the runtime saw them bound ${tBound - tBind} ms after the first`);
  const first = await waitFor("three desktops", async () => (lines1.filter((l) => /agent desktops: \w+ desktop \w+ created in/.test(l)).length === 3 ? mine() : null), 300_000, 1000);
  const ids = idsOf(first);
  out.created = lines1.filter((l) => l.includes("created in")).map((l) => Number(/created in ([\d.]+) s/.exec(l)![1]));
  out.all_three_running_after_bind_s = +((Date.now() - tBound) / 1000).toFixed(1);
  out.sandboxes = ids.map(short);
  check("three desktops, one per agent, each named by its agent id in the sandbox metadata", first.length === 3 && ids.every(Boolean) && new Set(ids).size === 3 && first.every((i) => i.state === "running"), `${ids.map(short).join(", ")}; created in ${(out.created as number[]).join(", ")} s; all running ${out.all_three_running_after_bind_s} s after the binds`);
  const spend = await waitFor("Core serves the desktop state", async () => {
    const r = await Promise.all(agents.map((a) => anon.get(`/v1/agents/${a.id}/spend`)));
    return r.every((x) => x.body?.spend?.desktop?.state === "running") ? r.map((x) => x.body.spend.desktop) : null;
  }, 60_000, 1000);
  check("GET /v1/agents/:id/spend serves each agent's desktop state", spend.length === 3, JSON.stringify(spend[0]));
  check("no sandbox id reaches the page", !JSON.stringify(spend).includes(ids[0]!.slice(0, 10)));

  // ---------------------------------------------------------------- 2. restart: the same sandboxes
  await stopRuntime(rt);
  const afterStop = await mine();
  check("a stopped runtime leaves its desktops (E2B pauses them when their short timeout runs out)", afterStop.length === 3, afterStop.map((i) => `${short(i.sandboxId)} ${i.state}, timeout in ${Math.round((i.endAt.getTime() - Date.now()) / 1000)} s`).join("; "));
  const lines2: string[] = [];
  rt = await startRuntime(lines2);
  await waitFor("desktops taken back", async () => lines2.filter((l) => l.includes("has its desktop")).length === 3, 90_000, 500);
  await Bun.sleep(6000); // a few ticks: a runtime that would create a second one has done it by now
  const second = await mine();
  check("after the restart: the same three sandbox ids, no new sandbox", second.length === 3 && JSON.stringify(idsOf(second)) === JSON.stringify(ids) && !lines2.some((l) => l.includes("created in")), `${idsOf(second).map(short).join(", ")}; 0 creates in the second run`);
  await stopRuntime(rt);

  // ---------------------------------------------------------------- 3. the same state, driven here
  const plog: string[] = [];
  const pcfg = parseConfig(JSON.parse(readFileSync(cfgFile, "utf8")));
  const pool = desktopPool(pcfg, (m) => (plog.push(m), console.log(`   pool ${m}`)), { timers: false })!;
  const man = pool.agents!;
  const all = (o: Partial<Record<number, { working?: boolean; asleep?: boolean }>> = {}) => agents.map((a, i) => ({ agent: a.id, working: false, asleep: false, ...(o[i] ?? {}) }));
  await man.settle();
  pool.syncAgents(all());
  await man.settle();
  check("a third start (this process, same state directory): the same ids again", JSON.stringify(agents.map((a) => man.sandboxOf(a.id))) === JSON.stringify(ids) && (await mine()).length === 3);

  // a small repository for the sessions
  const tree = join(tmp, "tree");
  Bun.spawnSync(["git", "init", "-q", tree]);
  writeFileSync(join(tree, "hello.py"), "print('hello')\n");
  Bun.spawnSync(["git", "-C", tree, "add", "."]);
  Bun.spawnSync(["git", "-C", tree, "-c", "user.name=proof", "-c", "user.email=proof@example.invalid", "commit", "-q", "-m", "one"]);
  const commit = Bun.spawnSync(["git", "-C", tree, "rev-parse", "HEAD"]).stdout.toString().trim();
  const A = agents[0]!.id;

  const session = async (label: string) => {
    const t0 = Date.now();
    const why = pool.reserve(A);
    if (why) throw new Error(`no desktop for the session: ${why}`);
    const at = await pool.begin({ agent: A, tree, repo: null, commit, stacked: false, label });
    if (!at) throw new Error(`session not started: ${pool.status().waiting_why}`);
    const ready = Date.now() - t0;
    const sid = randomBytes(32).toString("hex");
    at.sessionOpened(sid);
    const dir = JSON.parse(readFileSync(join(pcfg.state_dir, "desktops", "sessions", `${sid}.json`), "utf8")).dir as string;
    const live = await waitFor("live stream", async () => (existsSync(join(dir, "live.m3u8")) && readdirSync(dir).some((f) => f.startsWith("seg-")) ? readdirSync(dir) : null), 90_000, 500).catch(() => null);
    const firstVideo = Date.now() - t0;
    await at.end();
    return { ready_ms: ready, first_video_ms: live ? firstVideo : null, files: live?.length ?? 0, backend: at.backend };
  };

  const s1 = await session("proof-1");
  out.session_1 = s1;
  check("a session on the agent's own desktop streams live video to this host", s1.backend === "e2b" && s1.first_video_ms !== null, `session ready ${s1.ready_ms} ms after the reserve, first segment on this host after ${s1.first_video_ms} ms`);
  const afterS1 = (await mine()).find((i) => i.metadata.agent === A)!;
  check("the session's end leaves the sandbox running", afterS1.sandboxId === ids[0] && afterS1.state === "running");

  // pause it (its agent sleeps), then resume it for the next attempt
  let t0 = Date.now();
  pool.syncAgents(all({ 0: { asleep: true } }));
  await man.settle();
  const pauseMs = Date.now() - t0;
  const paused = (await mine()).find((i) => i.metadata.agent === A)!;
  out.pause_ms = pauseMs;
  check("the desktop is paused when its agent sleeps", paused.state === "paused" && pool.agentDesktop(A)!.state === "paused", `paused in ${pauseMs} ms after a session (browser, editor and terminals had run); state "${pool.agentDesktop(A)!.why}"`);
  const runningWhilePaused = (await mine()).filter((i) => i.state === "running").length;
  check("E2B lists it as paused, not running (two of three running)", runningWhilePaused === 2);
  const spentAtPause = pool.spentToday();
  await Bun.sleep(20_000);
  pool.syncAgents(all({ 0: { asleep: true } }));
  await man.settle();
  const spentAfterWait = pool.spentToday();
  out.own_meter = { note: "this runtime's own count (seconds running x the listed rate), not E2B's bill", per_desktop_s_usd: RATE };
  check("the runtime's own spend count stops for the paused desktop (two running for 20 s)", Math.abs(spentAfterWait - spentAtPause - 2 * RATE * 20) < 2 * RATE * 6, `${(spentAfterWait - spentAtPause).toFixed(5)} USD in about 20 s; two desktops for 20 s are ${(2 * RATE * 20).toFixed(5)}`);

  t0 = Date.now();
  pool.syncAgents(all());
  const s2 = await session("proof-2");
  const resumeLine = plog.filter((l) => l.includes("resumed in")).pop() ?? "";
  out.resume_s = Number(/resumed in ([\d.]+) s/.exec(resumeLine)?.[1] ?? NaN);
  out.session_2 = s2;
  const resumed = (await mine()).find((i) => i.metadata.agent === A)!;
  check("resumed before its next attempt: the same sandbox, a second session with live video", resumed.sandboxId === ids[0] && resumed.state === "running" && s2.first_video_ms !== null, `resume (E2B connect) ${out.resume_s} s; session ready ${s2.ready_ms} ms after the reserve, resume included; first segment after ${s2.first_video_ms} ms`);
  // a command on the desktop after the resume
  const inst = await man.open(A, { tree, homeUrl: "about:blank", allow: pcfg.desktop_allow ?? ["github.com", "githubusercontent.com", "githubassets.com"], label: "proof-3" });
  const geom = inst ? parseGeom((await inst.exec(["desk-geom"])).stdout) : [];
  await inst?.destroy();
  check("the desktop's four windows are in place in a third session", geom.length === 4, geom.map((g) => g.cls).join(", "));

  // renew: the session window of a desktop that ran longer than the window less the margin
  const B = agents[1]!.id;
  const bBefore = (await mine()).find((i) => i.metadata.agent === B)!;
  const ranS = Math.round((Date.now() - bBefore.startedAt.getTime()) / 1000);
  pool.cfg.e2b!.session_max_s = ranS + 60;
  pool.cfg.renew_before_s = 120;
  t0 = Date.now();
  pool.syncAgents(all());
  await man.settle();
  const renewMs = Date.now() - t0;
  pool.cfg.e2b!.session_max_s = 3600;
  pool.cfg.renew_before_s = 1800;
  const bAfter = (await mine()).find((i) => i.metadata.agent === B)!;
  const renewLine = plog.filter((l) => l.includes("session window renewed") && l.includes(B.slice(0, 6))).pop() ?? "";
  out.renew = { ran_s_before: ranS, away_s: Number(/away for ([\d.]+) s/.exec(renewLine)?.[1] ?? NaN), wall_ms: renewMs };
  check("a session window is renewed between attempts by a pause and a resume: same sandbox, E2B's start time moves to the resume", !!renewLine && bAfter.sandboxId === ids[1] && bAfter.state === "running" && bAfter.startedAt.getTime() > bBefore.startedAt.getTime(), `after ${ranS} s running; desktop away ${(out.renew as { away_s: number }).away_s} s; E2B startedAt ${bBefore.startedAt.toISOString().slice(11, 19)} -> ${bAfter.startedAt.toISOString().slice(11, 19)}`);
  // the timeout push: every running desktop's timeout is ahead of now
  pool.syncAgents(all());
  await man.settle();
  const ends = (await mine()).filter((i) => i.state === "running").map((i) => Math.round((i.endAt.getTime() - Date.now()) / 1000));
  check("every running desktop's timeout is ahead of now and E2B pauses (not kills) at it", ends.length === 3 && ends.every((s) => s > 0 && s <= 300), `timeouts in ${ends.join(", ")} s (desktop_keepalive_s 300)`);

  // ---------------------------------------------------------------- 4. removal
  pool.cfg.remove_after_s = 0;
  pool.syncAgents([agents[1]!, agents[2]!].map((a) => ({ agent: a.id, working: false, asleep: false })));
  await man.settle();
  pool.syncAgents([agents[1]!, agents[2]!].map((a) => ({ agent: a.id, working: false, asleep: false })));
  await man.settle();
  const two = await mine();
  check("an agent that is not bound any more loses its desktop; the others keep theirs", two.length === 2 && !two.some((i) => i.metadata.agent === A), two.map((i) => short(i.sandboxId)).join(", "));
  for (let i = 0; i < 3 && (await mine()).length; i++) {
    pool.syncAgents([]);
    await man.settle();
  }
  out.spent_usd_own_count = +pool.spentToday().toFixed(4);
  pool.stop();
  const left = await mine();
  check("every desktop removed: the E2B list shows none of this run's sandboxes", left.length === 0, `0 of 3 left under owner ${OWNER}`);
}

let failed: unknown = null;
try {
  await main();
} catch (e) {
  failed = e;
  check("the proof ran to its end", false, String((e as Error).message ?? e).slice(0, 300));
} finally {
  await stopAll().catch(() => undefined);
  // whatever happened: nothing of this run stays at E2B
  try {
    api ??= await new E2BBackend({ root: tmp }).api();
    for (const i of await mine()) await api.kill(i.sandboxId).catch(() => false);
    const left = await mine();
    out.left_at_e2b = left.length;
    if (failed) check("cleanup after the failure: none of this run's sandboxes left", left.length === 0);
  } catch (e) {
    out.cleanup_error = String((e as Error).message ?? e).slice(0, 200);
  }
  const wall = (Date.now() - tStart) / 1000;
  out.wall_s = Math.round(wall);
  // never more than three desktops of this run existed: an upper bound on what E2B can have billed
  out.spent_usd_upper_bound = +(3 * RATE * wall).toFixed(4);
  out.checks = results;
  out.pass = results.filter((r) => r.ok).length;
  out.total = results.length;
  writeFileSync(join(ROOT, "scripts/desktops/PROOF-LAST.json"), JSON.stringify(out, null, 2) + "\n");
  rmSync(tmp, { recursive: true, force: true });
  log(`${out.pass}/${out.total} checks; E2B spend by the runtime's own count ${out.spent_usd_own_count ?? "?"} USD, upper bound ${out.spent_usd_upper_bound} USD (3 desktops x ${out.wall_s} s)`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
