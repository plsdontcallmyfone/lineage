#!/usr/bin/env bun
// Hosted runtime proof, simulated mode, with real Claude (SPEC 17.2). A real Core with a runtime
// authority, a real reference runner and two bonded verifiers on the calibrated minbpe lineage, one
// hosted TEST agent launched with token fees in its compute vault, and `lineage-runtime run` as its
// own process. The script plays the launcher: it holds the agent's launch key (as the browser does)
// and binds the agent to the key the runtime generated; the runtime never sees the launch key.
// Checks: a Claude candidate that the verifiers accept, its provenance published once final and
// signed by the runtime, usage posted to Core with the exact amounts, the vault drained below
// sleep_threshold puts the agent to sleep, and new fees wake it.
//
// Prices and caps are TEST values. Spend is bounded by the vault: at most
// (vault - sandbox reserve) / compute_price_line_per_usd USD, and by global_max_usd.
// Usage: bun scripts/runtime/sim-run.ts [--port 9663] [--keep]
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey, type AgentKey } from "@lineage/protocol";
import { loadRecipe, prepareDeps } from "@lineage/sandbox";
import { CoreClient } from "../../packages/core/src/client.ts";
import { doctor } from "../../packages/worker/src/doctor.ts";
import { Worker } from "../../packages/worker/src/index.ts";
import { check, child, LANE_CAP_USD, laneSpent, log, logRun, ok, portFree, results, ROOT, stopAll, waitFor } from "./lib.ts";

const argv = process.argv.slice(2);
const PORT = Number(argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : 9663);
const KEEP = argv.includes("--keep");
const CORE = `http://127.0.0.1:${PORT}`;
portFree(PORT);

const spentBefore = laneSpent();
const RUN_CAP = Math.min(0.6, LANE_CAP_USD - spentBefore);
if (RUN_CAP < 0.2) throw new Error(`lane Claude spend is ${spentBefore.toFixed(4)} USD of ${LANE_CAP_USD}; not enough left for a run`);

const tmp = mkdtempSync(join(tmpdir(), "lineage-runtime-sim-"));
const writeKey = (name: string, k: AgentKey) => {
  const p = join(tmp, `${name}.json`);
  writeFileSync(p, JSON.stringify(Array.from(k.secret)), { mode: 0o600 });
  return p;
};
const keys = { admin: generateAgentKey(), runtime: generateAgentKey(), ref: generateAgentKey(), v1: generateAgentKey(), v2: generateAgentKey(), agent: generateAgentKey() };
const kp = Object.fromEntries(Object.entries(keys).filter(([n]) => n !== "agent").map(([n, k]) => [n, writeKey(n, k)])) as Record<string, string>;
const net = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
Object.assign(net, { canary_rate: 0, audit_rate: 0, reveal_window_s: 900, replay_window_min_s: 900, epoch_length_s: 86400, qualify_retry_s: 60 });
writeFileSync(join(tmp, "network.json"), JSON.stringify(net));
const admin = new CoreClient(CORE, keys.admin);
const anon = new CoreClient(CORE, null);
const as = (k: AgentKey) => new CoreClient(CORE, k);
const ONE = 10n ** BigInt(net.token_decimals);
const stateDir = join(tmp, "runtime");
let runNote = "incomplete";

async function main() {
  child("core", ["bun", join(ROOT, "packages/core/src/main.ts"), "--data", join(tmp, "data"), "--port", String(PORT), "--config", join(tmp, "network.json"), "--admin-key", kp.admin!, "--runtime-key", kp.runtime!, "--tick-ms", "500", "--no-trees"]);
  await waitFor("core", async () => (await fetch(`${CORE}/v1/health`).catch(() => null))?.ok);

  // ---------------------------------------------------------------- lineage and verifiers
  const loaded = loadRecipe(join(ROOT, "recipes/minbpe"));
  const deps = await prepareDeps(loaded);
  await ok(admin.post("/v1/admin/recipes", { recipe: loaded.recipe, recipe_id: loaded.recipe_id }), "recipe");
  const snap = await ok(admin.post("/v1/admin/snapshots", { repo: loaded.recipe.repo, commit: loaded.recipe.commit, deps_digest: deps.digest }), "snapshot");
  const caps = doctor().capabilities;
  for (const n of ["ref", "v1", "v2"] as const) {
    await ok(admin.post("/v1/admin/faucet", { agent: keys[n].id, amount: (BigInt(net.register_burn) + BigInt(net.min_bond) * 2n).toString() }), "faucet");
    await ok(as(keys[n]).post("/v1/agents", { capabilities: caps }), `register ${n}`);
    if (n !== "ref") await ok(as(keys[n]).post(`/v1/agents/${keys[n].id}/bond`, { amount: String(net.min_bond) }), `bond ${n}`);
  }
  await ok(admin.post(`/v1/admin/agents/${keys.ref.id}/reference`, { reference: true }), "reference");
  log("reference runner calibrating minbpe in the sandbox (3 runs)");
  await new Worker({ core: CORE, key: keys.ref, log: (m) => console.log(`   ref  ${m}`) }).submitCalibration(loaded.recipe_id, snap.snapshot_id, 3);
  const L = (await ok<any[]>(anon.get("/v1/lineages"), "lineages"))[0].lineage_id as string;
  for (const n of ["ref", "v1", "v2"]) child(n, ["bun", join(ROOT, "packages/worker/src/main.ts"), "run", "--core", CORE, "--key", kp[n]!, "--interval", "1500"]);
  await waitFor("verifiers qualified", async () => {
    const vs = await Promise.all(["v1", "v2"].map((n) => ok(anon.get(`/v1/agents/${keys[n as "v1"].id}`), n)));
    return vs.every((v) => v.qualified_lineages.includes(L));
  });
  check("verifiers qualified on minbpe", true, L.slice(0, 12));

  // ---------------------------------------------------------------- the hosted agent
  await ok(admin.post("/v1/admin/launches", { agent: keys.agent.id, mint: generateAgentKey().id, launcher: generateAgentKey().id, target_repo: loaded.recipe.repo, hosted: true, identity_mode: "app" }), "launch");
  // 3 $LINE in the compute vault (agent_compute_bps 7000 of the fees), TEST
  const fees = (3n * ONE * 10_000n + 6999n) / 7000n;
  await ok(admin.post("/v1/admin/agent-fees", { agent: keys.agent.id, amount: fees.toString() }), "fees");
  const v0 = await ok(anon.get(`/v1/agents/${keys.agent.id}`), "agent");
  check("hosted agent launched, active and awake with its vault", v0.awake === true && v0.lifecycle === "active" && v0.hosted === true, `compute ${v0.compute}`);

  const cfg = {
    _note: "TEST values (prices, caps); launch values are TBA",
    mode: "sim",
    core: CORE,
    state_dir: stateDir,
    runtime_key: kp.runtime,
    effort: "high",
    attempt_max_usd: 0.5,
    agent_epoch_max_usd: RUN_CAP,
    global_max_usd: RUN_CAP,
    min_attempt_usd: 0.1,
    compute_price_line_per_usd: "5",
    compute_price_line_per_sandbox_s: "0.001",
    sandbox_reserve_s: 300,
    usage_epoch_s: 3600,
    close_when_exhausted: true,
    poll_ms: 3000,
    max_concurrent: 1,
    lineages: [L],
  };
  writeFileSync(join(tmp, "runtime-config.json"), JSON.stringify(cfg, null, 2));
  const lines: string[] = [];
  const rt = child("rt", ["bun", join(ROOT, "packages/runtime/src/main.ts"), "run", "--config", join(tmp, "runtime-config.json")], (l) => lines.push(l));
  const reqFile = join(stateDir, "bind-requests", `${keys.agent.id}.json`);
  const req = await waitFor("bind request", async () => (existsSync(reqFile) ? JSON.parse(readFileSync(reqFile, "utf8")) : null), 60_000, 500);
  check("the runtime generated its own key and asks the owner to bind it", req.body.new_key !== keys.agent.id, `runtime key ${req.body.new_key}`);
  // the launcher (this script, holding the launch key as the browser does) binds the agent
  await ok(as(keys.agent).post(`/v1/agents/${keys.agent.id}/keys/rotate`, req.body), "rotate");
  const keysView = await ok(anon.get(`/v1/agents/${keys.agent.id}/keys`), "keys");
  check("agent bound: Core authenticates the runtime key for the unchanged agent id", keysView.signing_key === req.body.new_key, `seq ${keysView.seq}`);

  // ---------------------------------------------------------------- authoring until the vault is spent
  let accepted: { a: any; mine: any[] } | null = null;
  accepted = await waitFor(
    "the vault spent and posted, and an accepted candidate or every candidate final",
    async () => {
      const a = await ok(anon.get(`/v1/agents/${keys.agent.id}`), "agent");
      const mine = await ok<any[]>(admin.get(`/v1/candidates?lineage=${L}&author=${keys.agent.id}&limit=100`, true), "candidates");
      // a runtime that stopped (graceful stop posts the open usage) ends the wait once its candidates are final
      const open = mine.filter((c) => ["committed", "queued", "replaying", "disputed"].includes(c.status));
      if (rt.exitCode !== null) log(`runtime exited with ${rt.exitCode}`);
      return (!a.awake || rt.exitCode !== null) && open.length === 0 ? { a, mine } : null;
    },
    90 * 60_000,
    5000,
  ).catch((e) => {
    log(String(e));
    return null;
  });
  if (!accepted) accepted = { a: null, mine: await ok<any[]>(admin.get(`/v1/candidates?lineage=${L}&author=${keys.agent.id}&limit=100`, true), "candidates") };
  const mine: any[] = accepted?.mine ?? [];
  const acc = mine.find((c) => c.status === "accepted");
  check("Claude authored a candidate that the real verifiers accepted", !!acc, mine.map((c) => `${c.commit_id.slice(0, 10)} ${c.status}${c.reason ? ` ${c.reason}` : ""}`).join(", "));
  const usage = await ok(anon.get(`/v1/agents/${keys.agent.id}/usage`), "usage");
  const after = await ok(anon.get(`/v1/agents/${keys.agent.id}`), "agent");
  const debited = usage.records.reduce((s: bigint, r: any) => s + BigInt(r.amount), 0n);
  check("usage posted: the vault paid exactly the posted amounts", BigInt(v0.compute) - BigInt(after.compute) === debited && debited > 0n, `vault ${v0.compute} -> ${after.compute}, debited ${debited} in ${usage.records.length} record(s)`);
  check("vault below sleep_threshold: the agent sleeps", after.awake === false && BigInt(after.compute) < BigInt(net.sleep_threshold), `compute ${after.compute} < ${net.sleep_threshold}`);
  for (const c of mine.filter((c) => ["accepted", "rejected"].includes(c.status))) {
    const p = await anon.get(`/v1/candidates/${c.commit_id}/provenance`);
    check(`provenance of ${c.commit_id.slice(0, 10)} (${c.status}) public once final, attested by the runtime`, p.status === 200 && p.body.signer === keys.runtime.id && p.body.record.agent === keys.agent.id,
      p.status === 200 ? `models ${p.body.record.models.join(",")}, ${p.body.record.spend.usd} USD, ${p.body.record.spend.amount} base units, sandbox ${p.body.record.sandbox_s} s, harness ${p.body.record.harness_digest.slice(0, 12)}` : `${p.status} ${JSON.stringify(p.body)}`);
  }
  const state = JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8"));
  const provUsd = state.closed.flatMap((e: any) => e.leaves).filter((l: any) => l.agent === keys.agent.id).reduce((s: number, l: any) => s + l.usd, 0);
  check("posted usage records match the runtime's meter", usage.records.every((r: any) => state.closed.some((e: any) => e.leaves.some((l: any) => l.amount === r.amount))), `${provUsd.toFixed(4)} USD metered`);

  // ---------------------------------------------------------------- graceful stop, restart, new fees wake it
  rt.kill("SIGTERM");
  await rt.exited;
  check("graceful stop released the lock", !existsSync(join(stateDir, "runtime.lock")));
  // restart from the persisted state with the global cap at what was spent, so waking costs nothing more
  const spentNow = JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8")).spent_usd_total as number;
  writeFileSync(join(tmp, "runtime-config.json"), JSON.stringify({ ...cfg, global_max_usd: spentNow }, null, 2));
  const lines2: string[] = [];
  const rt2 = child("rt2", ["bun", join(ROOT, "packages/runtime/src/main.ts"), "run", "--config", join(tmp, "runtime-config.json")], (l) => lines2.push(l));
  await Bun.sleep(12_000);
  check("restart recovered the binding from state (no new key, no new bind request)", lines2.every((l) => !l.includes("discovered hosted agent")) && !lines2.some((l) => /locked/.test(l)), `${lines2.length} lines`);
  await ok(admin.post("/v1/admin/agent-fees", { agent: keys.agent.id, amount: fees.toString() }), "fees");
  const woke = await ok(anon.get(`/v1/agents/${keys.agent.id}`), "agent");
  await waitFor("runtime sees the agent awake", async () => lines2.some((l) => l.includes(`agent ${keys.agent.id} is awake`)), 60_000, 1000).catch(() => null);
  check("new fees wake the agent and the runtime sees it awake", woke.awake === true && lines2.some((l) => l.includes(`agent ${keys.agent.id} is awake`)), `compute ${woke.compute}`);
  rt2.kill("SIGTERM");
  await rt2.exited;
  lines.push(...lines2);
  const final = JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8"));
  const spent = final.spent_usd_total as number;
  check("spend within the run cap", spent <= RUN_CAP + 1e-9, `${spent.toFixed(4)} of ${RUN_CAP.toFixed(4)} USD`);
  check("no secrets in the runtime's output", !lines.some((l) => /sk-ant-/.test(l)), `${lines.length} lines`);
  runNote = `minbpe, ${mine.length} candidate(s): ${mine.map((c) => c.status).join(", ")}`;
  writeFileSync(join(ROOT, "scripts/runtime/SIM-LAST.json"), JSON.stringify({ at: new Date().toISOString(), claude_usd: spent, candidates: mine.map((c) => ({ commit_id: c.commit_id, status: c.status, reason: c.reason })), usage: usage.records, results }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    check("run completed", false, String(e?.message ?? e));
  })
  .finally(async () => {
    await stopAll();
    // the run's Claude spend as the runtime metered it, logged even when the run failed
    const sf = join(stateDir, "state.json");
    if (existsSync(sf)) logRun("sim", JSON.parse(readFileSync(sf, "utf8")).spent_usd_total, `${runNote}; ${results.filter((r) => !r.ok).length} failed checks`);
    if (!KEEP) rmSync(tmp, { recursive: true, force: true });
    const failed = results.filter((r) => !r.ok);
    log(`${results.length - failed.length}/${results.length} checks passed; lane Claude spend now ${laneSpent().toFixed(4)} USD`);
    process.exit(failed.length ? 1 : 0);
  });
