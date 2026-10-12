#!/usr/bin/env bun
// Scale-out proof (docs/plans/SCALE-OUT.md section 7): a hosted runtime against a local simulated Core
// with its evaluations on two machines and a verifier on one of them.
//
//   bun scripts/scale/proof.ts --hosts-file <hosts.json> --core-port <p> --kill <container of one machine>
//     --verifier-host 127.0.0.1:<ssh port> --root-key <key> [--agents 6] [--cap-usd 1.5] --out <json>
//
// The machines are the two containers scripts/deploy/capacity-host/dryrun.sh provisioned with the real
// provision.sh (each with its own Docker); the hosts file is the one the kit wrote. This process is
// the site: a real Core (simulated ledger) as a child process, the hosted runtime in this process
// with every agent key, one verifier as a child process here (UNITS_REPLAY_SLOTS=2) and the machine's
// own verifier started on the machine. The model is a scripted stand-in (no network, fixed usage per
// call); everything else is real: ssh, the gateway, eval-job.ts, Docker sandboxes, Core.
//
// Checks: both machines take evaluations; never more at once than a machine's slots; one machine is
// killed in mid-evaluation and that evaluation is finished elsewhere, its attempt completes, the dead
// machine gets nothing more; the day cap is one counter and is respected; no agent has two attempts
// at once; the machine's verifier qualifies and replays a candidate to a verdict; no agent key and no
// patch is left on a machine.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey, type AgentKey } from "@units/protocol";
import { applyPatch, installSandboxHosts, loadRecipe, materialize, newWorkDir, parseHostsFile, prepareDeps, removeTree, spawnRun, uninstallSandboxHosts, type RunCommand } from "@units/sandbox";
import { CoreClient } from "../../packages/core/src/client.ts";
import { AnthropicProposer } from "../../packages/worker/src/proposers/anthropic.ts";
import { Worker } from "../../packages/worker/src/index.ts";
import { parseConfig, Runtime, SimBackend } from "../../packages/runtime/src/index.ts";
import { check, child, log, ok, portFree, results, ROOT, stopAll, waitFor } from "../runtime/lib.ts";

/** the model client the proposer takes (the Anthropic SDK's client type, not importable from scripts/) */
type Anthropic = NonNullable<ConstructorParameters<typeof AnthropicProposer>[1]>;

const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1]! : d);
const HOSTS_FILE = opt("hosts-file")!;
const PORT = Number(opt("core-port", "9666"));
const KILL = opt("kill")!;
const [VHOST, VPORT] = opt("verifier-host", "127.0.0.1:9663")!.split(":") as [string, string];
const ROOT_KEY = opt("root-key")!;
const AGENTS = Number(opt("agents", "6"));
const CAP = Number(opt("cap-usd", "1.5"));
const OUT = opt("out", join(ROOT, "scripts/scale/PROOF-LAST.json"))!;
if (!HOSTS_FILE || !KILL || !ROOT_KEY) throw new Error("--hosts-file, --kill and --root-key are required");
const CORE = `http://127.0.0.1:${PORT}`;
const CORE_FROM_MACHINE = `http://host.docker.internal:${PORT}`;
portFree(PORT);

const tmp = mkdtempSync(join(tmpdir(), "units-scale-proof-"));
const writeKey = (name: string, k: AgentKey) => {
  const p = join(tmp, `${name}.json`);
  writeFileSync(p, JSON.stringify(Array.from(k.secret)), { mode: 0o600 });
  return p;
};
const keys = { admin: generateAgentKey(), runtime: generateAgentKey(), ref: generateAgentKey(), vlocal: generateAgentKey() };
const kp = Object.fromEntries(Object.entries(keys).map(([n, k]) => [n, writeKey(n, k)])) as Record<string, string>;
const net = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
Object.assign(net, { canary_rate: 0, audit_rate: 0, reveal_window_s: 20, replay_window_min_s: 900, epoch_length_s: 86400, qualify_retry_s: 30, max_open_replays: 4 });
writeFileSync(join(tmp, "network.json"), JSON.stringify(net));
const admin = new CoreClient(CORE, keys.admin);
const anon = new CoreClient(CORE, null);
const as = (k: AgentKey) => new CoreClient(CORE, k);

/** root ssh to the machine that runs the verifier (the dry run's own key; these containers are ours). */
function machine(cmd: string): { code: number; out: string } {
  const p = Bun.spawnSync(["ssh", "-i", ROOT_KEY, "-p", VPORT, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", `root@${VHOST}`, cmd]);
  return { code: p.exitCode ?? 1, out: (p.stdout.toString() + p.stderr.toString()).trim() };
}
const asCap = (cmd: string) => machine(`cd /opt/units-cap/current && runuser -u units-cap -- env HOME=/home/units-cap UNITS_HOME=/var/lib/units-cap UNITS_NETWORK=devnet ${cmd}`);

// ---------------------------------------------------------------------------------------------- model
// A scripted stand-in for the model: every attempt writes the file, evaluates and stops; the first
// attempt of the first agent submits instead of stopping. Fixed usage per call, so spend is exact.
const USAGE = { input_tokens: 2000, output_tokens: 1000, cache_read_input_tokens: 5000, cache_creation_input_tokens: 1000 };
const USD_PER_CALL = (2000 * 4 + 1000 * 20 + 5000 * 0.2 + 1000 * 5) / 1e6; // the test prices of packages/runtime/test/attempt.test.ts: 0.034
const MARK = "units-scale-proof";
function scriptedClient(patched: string, submitFirst: boolean): Anthropic {
  let call = 0;
  let attempt = 0;
  return {
    beta: {
      messages: {
        stream: () => {
          const step = call % 3;
          call++;
          if (step === 0) attempt++;
          const submit = submitFirst && attempt === 1;
          // later attempts add a comment line, so the change is never empty once the first candidate is the tip
          const contents = submit ? patched : `${patched}\n// ${MARK} attempt ${attempt}\n`;
          const tools =
            step === 0 ? [{ name: "write_file", input: { path: "src/lib.rs", contents } }]
            : step === 1 ? [{ name: "evaluate", input: { kind: "perf", target: "encode_ir" } }]
            : submit ? [{ name: "submit", input: { kind: "perf", target: "encode_ir", rationale: "build the string once" } }]
            : [];
          const content = tools.map((x, k) => ({ type: "tool_use", id: `tu_${call}_${k}`, name: x.name, input: x.input }));
          return {
            finalMessage: async () => ({ id: `msg_${call}`, type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason: content.length ? "tool_use" : "end_turn", stop_details: null, usage: USAGE }),
          };
        },
      },
    },
  } as unknown as Anthropic;
}

// ------------------------------------------------------------------------------------------ transport
// The real transport, observed: which machine each evaluation went to, when, and how it ended.
interface Call { host: string; start: number; end: number | null; code: number | null }
const hostsDoc = parseHostsFile(readFileSync(HOSTS_FILE, "utf8"));
const byPort = new Map(hostsDoc.hosts.map((h) => [String(h.port ?? 22), h.name]));
const killName = hostsDoc.hosts.find((h) => KILL.endsWith(h.name.replace(/^cap-/, "")))?.name ?? hostsDoc.hosts[hostsDoc.hosts.length - 1]!.name;
const calls: Call[] = [];
const run: RunCommand = async (a, stdin, timeoutMs, onLine) => {
  const host = byPort.get(a[a.indexOf("-p") + 1]!) ?? "?";
  const isEval = a[a.length - 1] === "eval";
  const c: Call = { host, start: Date.now(), end: null, code: null };
  if (isEval) calls.push(c);
  const r = await spawnRun(a, stdin, timeoutMs, onLine);
  c.end = Date.now();
  c.code = r.code;
  return r;
};
const peakOf = (host: string) => {
  const ev = calls.filter((c) => c.host === host).flatMap((c) => [[c.start, 1], [c.end ?? Date.now(), -1]] as [number, number][]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let n = 0;
  let peak = 0;
  for (const [, d] of ev) peak = Math.max(peak, (n += d));
  return peak;
};

const rtLogs: { at: number; m: string }[] = [];
let killedAt: number | null = null;
let note = "incomplete";

async function main() {
  child("core", ["bun", join(ROOT, "packages/core/src/main.ts"), "--data", join(tmp, "data"), "--port", String(PORT), "--config", join(tmp, "network.json"), "--admin-key", kp.admin!, "--runtime-key", kp.runtime!, "--tick-ms", "500", "--no-trees"]);
  await waitFor("core", async () => (await fetch(`${CORE}/v1/health`).catch(() => null))?.ok);

  // -------------------------------------------------------------------- unit, calibration, verifiers
  const loaded = loadRecipe(join(ROOT, "recipes/fixture-b58"));
  const deps = await prepareDeps(loaded);
  await ok(admin.post("/v1/admin/recipes", { recipe: loaded.recipe, recipe_id: loaded.recipe_id }), "recipe");
  const snap = await ok(admin.post("/v1/admin/snapshots", { repo: loaded.recipe.repo, commit: loaded.recipe.commit, deps_digest: deps.digest }), "snapshot");
  await ok(admin.post("/v1/admin/faucet", { agent: keys.ref.id, amount: String(net.register_burn) }), "faucet ref");
  await ok(as(keys.ref).post("/v1/agents", {}), "register ref");
  await ok(admin.post(`/v1/admin/agents/${keys.ref.id}/reference`, { reference: true }), "reference");
  // a real calibration on this machine's image (the committed one belongs to the committed image id)
  log("reference runner calibrating the fixture in the sandbox (3 runs)");
  await new Worker({ core: CORE, key: keys.ref, telemetry: false, log: () => {} }).submitCalibration(loaded.recipe_id, snap.snapshot_id, 3);
  // the fixture's perf_encode patch grows rlib_bytes past the 1% guard default: unguarded for the fixture, as scripts/e2e.ts does
  await ok(admin.post("/v1/admin/guard-config", { overrides: { [loaded.recipe_id]: { rlib_bytes: null } } }), "guard config");
  const L = (await ok<any[]>(anon.get("/v1/lineages"), "lineages"))[0].lineage_id as string;

  // the site's own verifier (a child process here, two replays at once)
  const fund = (BigInt(net.register_burn) + BigInt(net.min_bond) * 2n).toString();
  await ok(admin.post("/v1/admin/faucet", { agent: keys.vlocal.id, amount: fund }), "faucet vlocal");
  await ok(as(keys.vlocal).post("/v1/agents", {}), "register vlocal");
  await ok(as(keys.vlocal).post(`/v1/agents/${keys.vlocal.id}/bond`, { amount: String(net.min_bond) }), "bond vlocal");
  process.env.UNITS_REPLAY_SLOTS = "2";
  child("vloc", ["bun", join(ROOT, "packages/worker/src/main.ts"), "run", "--core", CORE, "--key", kp.vlocal!, "--interval", "1500"]);
  delete process.env.UNITS_REPLAY_SLOTS;

  // the machine's verifier: its key was made on the machine by provision.sh and stays there
  const ids = asCap("bun scripts/deploy/capacity-host/verifier-id.ts /etc/units-cap/verifier.json /etc/units-cap/caps.json");
  const vremote = ids.out.split("\n")[0]!.trim();
  check("the machine's verifier has its own key (its id read on the machine, the key never copied)", ids.code === 0 && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(vremote), vremote);
  await ok(admin.post("/v1/admin/faucet", { agent: vremote, amount: fund }), "faucet vremote");
  // simulated Core: the two steps the kit prints for the owner, run with the worker CLI on the machine
  const reg = asCap(`bun packages/worker/src/main.ts register --core ${CORE_FROM_MACHINE} --key /etc/units-cap/verifier.json --capabilities /etc/units-cap/caps.json`);
  const bond = asCap(`bun packages/worker/src/main.ts bond --core ${CORE_FROM_MACHINE} --key /etc/units-cap/verifier.json --amount ${net.min_bond}`);
  check("the machine's verifier registered and bonded through Core's HTTP API from the machine", reg.code === 0 && bond.code === 0, `${reg.out.split("\n").pop()?.slice(0, 80)} / ${bond.out.split("\n").pop()?.slice(0, 80)}`);
  const started = machine("systemctl enable -q --now units-cap-verifier; sleep 2; systemctl is-active units-cap-verifier");
  check("the machine's verifier unit starts (what START=1 does)", started.out.endsWith("active"), started.out.split("\n").pop());
  log("both verifiers qualify on the unit (a base run each; the machine prepares its own dependency layer first)");
  await waitFor("verifiers qualified", async () => {
    const vs = await Promise.all([keys.vlocal.id, vremote].map((id) => ok(anon.get(`/v1/agents/${id}`), id)));
    return vs.every((v) => v.qualified_lineages.includes(L));
  }, 1_500_000, 5000);
  check("both verifiers qualified on the unit, one of them on the machine", true, `unit ${L.slice(0, 12)}`);

  // ------------------------------------------------------------------------------------ hosted agents
  const work = newWorkDir("scale-proof");
  materialize(loaded.recipe.repo, loaded.recipe.commit, loaded.overlayDir, join(work, "src"));
  if (!applyPatch(join(work, "src"), readFileSync(join(ROOT, "fixtures/b58-patches/perf_encode.diff"), "utf8"))) throw new Error("the fixture patch does not apply");
  const patched = readFileSync(join(work, "src/src/lib.rs"), "utf8");
  removeTree(work);
  const agents = Array.from({ length: AGENTS }, () => generateAgentKey());
  for (const a of agents) {
    await ok(admin.post("/v1/admin/launches", { agent: a.id, mint: generateAgentKey().id, launcher: generateAgentKey().id, target_repo: loaded.recipe.repo, hosted: true, identity_mode: "app" }), "launch");
    await ok(admin.post("/v1/admin/agent-fees", { agent: a.id, amount: "100000000000" }), "fees");
  }

  // ------------------------------------------------------------- the runtime, with the sandbox hosts
  const poolLogs: string[] = [];
  const pool = installSandboxHosts({ file: HOSTS_FILE, run, reload_s: 5, log: (m) => (poolLogs.push(m), log(m)) });
  for (const h of pool.hosts()) {
    const r = await pool.health(h);
    check(`machine ${h.name} answers health over the runtime's key`, r.ok && (r.health as { docker?: boolean }).docker === true, r.ok ? JSON.stringify(r.health) : r.why);
  }
  const cfg = parseConfig({
    mode: "sim", core: CORE, state_dir: join(tmp, "rt"), runtime_key: "unused",
    compute_price_line_per_usd: "4", compute_price_line_per_sandbox_s: "0.001", // TEST values
    poll_ms: 500, max_concurrent: 1, max_concurrent_ceiling: AGENTS, attempt_gap_s: 2,
    attempt_max_usd: 0.2, min_attempt_usd: 0.11, min_useful_attempt: null,
    global_max_usd: CAP, global_cap_scope: "all", global_window_s: 86400,
  });
  const clients = new Map(agents.map((a, i) => [a.id, scriptedClient(patched, i === 0)]));
  const rt = new Runtime(cfg, {
    backend: new SimBackend(CORE, keys.runtime), runtimeKey: keys.runtime, telemetry: false,
    proposer: (agent) => new AnthropicProposer({ max_usd: 0.2 }, clients.get(agent)!),
    log: (m) => (rtLogs.push({ at: Date.now(), m }), /attempt (starts|done|failed|not started)|cap|bound/.test(m) && log(`rt ${m}`)),
  });
  await rt.start();
  await rt.tick();
  for (const a of agents) {
    const req = JSON.parse(readFileSync(join(cfg.state_dir, "bind-requests", `${a.id}.json`), "utf8"));
    await ok(as(a).post(`/v1/agents/${a.id}/keys/rotate`, req.body), "bind");
  }
  let stop = false;
  const loop = rt.run(() => stop);

  // one machine dies in the middle of an evaluation, once both have finished at least one
  const doneOn = (h: string) => calls.filter((c) => c.host === h && c.code === 0).length;
  await waitFor("an evaluation finished on each machine", async () => hostsDoc.hosts.every((h) => doneOn(h.name) >= 1), 1_500_000, 1000);
  const victim = await waitFor("an evaluation running on the machine to kill", async () => calls.find((c) => c.host === killName && c.end === null && Date.now() - c.start > 4000), 600_000, 500);
  const attemptsBeforeKill = rtLogs.filter((l) => / attempt done:/.test(l.m)).length;
  killedAt = Date.now();
  const k = Bun.spawnSync(["docker", "kill", KILL]);
  log(`killed machine ${killName} (docker kill ${KILL}: exit ${k.exitCode}) with an evaluation ${((killedAt - victim.start) / 1000).toFixed(1)} s in`);

  // run until the day cap stops the runtime: nothing running and every agent refused
  await waitFor("the cap to stop every agent", async () => {
    const capped = rtLogs.filter((l) => /global runtime cap/.test(l.m)).length;
    const running = rtLogs.filter((l) => / attempt starts/.test(l.m)).length - rtLogs.filter((l) => / attempt (done|failed)/.test(l.m)).length;
    return capped >= 1 && running === 0 && rt.capStatus().left_usd < 0.11;
  }, 2_400_000, 2000);
  stop = true;
  await loop;
  await rt.stop({ flush: false });

  // ------------------------------------------------------------------------------------------ checks
  const st = pool.status();
  const per = Object.fromEntries(hostsDoc.hosts.map((h) => [h.name, doneOn(h.name)]));
  check("evaluations ran on both machines", hostsDoc.hosts.every((h) => per[h.name]! >= 1), `${JSON.stringify(per)}, on the site ${st.local_done}`);
  for (const h of hostsDoc.hosts) check(`machine ${h.name}: never more evaluations at once than its slots`, peakOf(h.name) <= h.slots, `peak ${peakOf(h.name)} of ${h.slots}`);

  const failed = calls.filter((c) => c.host === killName && c.code !== 0 && c.end !== null && c.end >= killedAt!);
  const afterKillOk = calls.filter((c) => c.host === killName && c.code === 0 && (c.end ?? 0) > killedAt! + 1000).length;
  check("the killed machine's running evaluation failed there and was reported", failed.length >= 1 && poolLogs.some((m) => m.includes(`sandbox host ${killName} failed an evaluation`)), poolLogs.find((m) => m.includes(`sandbox host ${killName} failed`))?.slice(0, 160));
  const attemptsDone = rtLogs.filter((l) => / attempt done:/.test(l.m));
  const failedAttempts = rtLogs.filter((l) => / attempt failed/.test(l.m));
  check("that evaluation was finished elsewhere: no attempt failed, attempts went on after the kill", failedAttempts.length === 0 && attemptsDone.length > attemptsBeforeKill, `${attemptsBeforeKill} attempts had finished before the kill, ${attemptsDone.length - attemptsBeforeKill} finished after it, ${failedAttempts.length} failed`);
  check("nothing more succeeded on the dead machine", afterKillOk === 0, `${calls.filter((c) => c.host === killName && c.start > killedAt!).length} tries after the kill, all refused`);

  // the cap: one counter in the one runtime
  const spent = rt.capStatus().spent_usd;
  const modelCalls = Math.round(spent / USD_PER_CALL);
  check("the day cap is respected", spent <= CAP + 1e-9, `spent ${spent.toFixed(4)} of ${CAP} USD (${modelCalls} model calls at ${USD_PER_CALL} USD)`);
  check("at the cap attempts are refused with the reason", rtLogs.some((l) => /global runtime cap/.test(l.m)), rtLogs.find((l) => /global runtime cap/.test(l.m))?.m.slice(0, 140));

  // no agent twice at once, and every agent worked
  let overlap = 0;
  let peakAttempts = 0;
  const open = new Set<string>();
  const perAgent = new Map<string, number>();
  for (const l of rtLogs) {
    const m = /^(\w{6}) attempt (starts|done|failed)/.exec(l.m);
    if (!m) continue;
    if (m[2] === "starts") {
      if (open.has(m[1]!)) overlap++;
      open.add(m[1]!);
      perAgent.set(m[1]!, (perAgent.get(m[1]!) ?? 0) + 1);
      peakAttempts = Math.max(peakAttempts, open.size);
    } else open.delete(m[1]!);
  }
  check("no agent had two attempts at once", overlap === 0, `${[...perAgent.values()].reduce((a, b) => a + b, 0)} attempts, at most ${peakAttempts} at once`);
  check("every agent worked", perAgent.size === AGENTS, `${perAgent.size} of ${AGENTS} agents, attempts each: ${[...perAgent.values()].join(", ")}`);

  // the candidate: replayed by the machine's verifier and the site's, to a verdict
  const cands = Object.values(rt.state.open.usage).flatMap((u) => u.candidates);
  let verdict: any = null;
  if (cands[0]) {
    verdict = await waitFor("the candidate's verdict", async () => {
      const c = await ok(anon.get(`/v1/candidates/${cands[0]}`), "candidate");
      return ["accepted", "rejected"].includes(c.status) ? c : null;
    }, 900_000, 3000).catch(() => null);
  }
  const replayers = new Set<string>((verdict?.replays ?? []).map((r: { replayer: string }) => r.replayer));
  check("a candidate was replayed by the machine's verifier and the site's and accepted", verdict?.status === "accepted" && replayers.has(vremote) && replayers.has(keys.vlocal.id), verdict ? `candidate ${cands[0]!.slice(0, 12)} ${verdict.status}, ${replayers.size} verifiers` : `no verdict (candidates: ${cands.length})`);

  // what is on the surviving machine afterwards
  // a runtime key file is named <agent id>.json: none of the agents' may exist anywhere on the machine,
  // and the only keypair there is the machine's own verifier key
  const names = agents.map((a) => `-name '${a.id}.json'`).join(" -o ");
  const left = machine(`grep -rIl '${MARK}' /var/lib/units-cap --exclude-dir=deps 2>/dev/null | wc -l; find / -xdev \\( -path /proc -o -path /sys -o -path /var/lib/docker \\) -prune -o -type f \\( ${names} \\) -print 2>/dev/null | wc -l; ls /etc/units-cap | tr '\\n' ' '`);
  const [patchFiles, keyFiles, etc] = left.out.split("\n");
  check("no patch and no agent key is left on the machine", patchFiles?.trim() === "0" && keyFiles?.trim() === "0", `files holding an attempt's patch: ${patchFiles?.trim()}, agent key files: ${keyFiles?.trim()}; /etc/units-cap holds: ${etc?.trim()}`);
  const siteKeys = Bun.spawnSync(["ls", join(cfg.state_dir, "keys")]).stdout.toString().trim().split("\n").length;
  check("every agent key is in the one runtime's state on the site", siteKeys === AGENTS, `${siteKeys} key files`);

  machine("systemctl disable -q --now units-cap-verifier");
  note = `${AGENTS} agents, cap ${CAP} USD, ${attemptsDone.length} attempts, evaluations ${JSON.stringify(per)} + ${st.local_done} on the site`;
  writeFileSync(OUT, JSON.stringify({
    at: new Date().toISOString(), passed: results.filter((r) => r.ok).length, total: results.length, note,
    agents: AGENTS, cap_usd: CAP, spent_usd: spent, usd_per_model_call: USD_PER_CALL,
    machines: hostsDoc.hosts.map((h) => ({ name: h.name, slots: h.slots, evaluations_finished: per[h.name], peak_at_once: peakOf(h.name), killed: h.name === killName })),
    evaluations_on_the_site: st.local_done, attempts: attemptsDone.length, attempts_after_the_kill: attemptsDone.length - attemptsBeforeKill,
    checks: results,
  }, null, 2) + "\n");
}

let failedRun = false;
try {
  await main();
} catch (e) {
  failedRun = true;
  check("proof ran to the end", false, (e as Error).message.slice(0, 300));
} finally {
  uninstallSandboxHosts();
  await stopAll();
  rmSync(tmp, { recursive: true, force: true });
}
const bad = results.filter((r) => !r.ok).length;
console.log(`proof: ${results.length - bad}/${results.length} passed${failedRun ? " (stopped early)" : ""}; ${note}`);
process.exit(bad ? 1 : 0);
