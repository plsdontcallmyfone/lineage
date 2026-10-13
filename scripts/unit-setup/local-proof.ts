#!/usr/bin/env bun
// Unit setup proof on a local network (packages/runtime/src/unit-setup.ts, SPEC 6.2): a simulated
// Core with a runtime authority, a reference runner and two bonded verifiers qualified on one Python
// unit (base58-py), and `units-runtime run` as its own process with the real sandbox and the real
// model (routed like every Claude call). Three hosted agents are launched on repositories that have
// no unit here:
//   - two on one small real repository with tests (--repo, default hukkin/tomli), both bound;
//   - one on karpathy/autoresearch, left unbound.
// Nobody drafts, submits or calibrates anything by hand. Checks: exactly one agent drafts and exactly
// one proposal is made for the shared repository, the verifiers calibrate it by commit and reveal,
// Core creates the unit and turns both agents active, the verifiers qualify on the new unit with the
// recipe they read from Core, an agent starts authoring on it, the draft was metered to the drafting
// agent's vault, and every wait had a public reason on GET /v1/agents/:id/spend. For autoresearch: no
// model call, and the one sentence that says why it cannot have a unit.
//
// Prices and caps are TEST values. Model spend is bounded by --draft-usd (default 1.5) per draft,
// --attempt-usd (default 0.6, above the minimum useful attempt of the default model) for the one authoring attempt, and global_max_usd.
// Usage: bun scripts/unit-setup/local-proof.ts [--port 9663] [--repo <url>] [--draft-usd 1.5] [--keep]
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey, type AgentKey } from "@units/protocol";
import { loadRecipe, prepareDeps } from "@units/sandbox";
import { CoreClient } from "../../packages/core/src/client.ts";
import { doctor } from "../../packages/worker/src/doctor.ts";
import { Worker } from "../../packages/worker/src/index.ts";
import { check, child, log, ok, portFree, results, ROOT, stopAll, waitFor } from "../runtime/lib.ts";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1]! : d);
const PORT = Number(opt("port", "9663"));
if (![9663, 9664, 9666, 9667, 9668, 9669].includes(PORT)) throw new Error("use a test port: 9663, 9664, 9666 to 9669");
const KEEP = argv.includes("--keep");
const REPO = opt("repo", "https://github.com/hukkin/tomli");
const GPU_REPO = "https://github.com/karpathy/autoresearch";
const DRAFT_USD = Number(opt("draft-usd", "1.5"));
const ATTEMPT_USD = Number(opt("attempt-usd", "0.6"));
const CORE = `http://127.0.0.1:${PORT}`;
portFree(PORT);

const tmp = mkdtempSync(join(tmpdir(), "units-unit-setup-"));
const writeKey = (name: string, k: AgentKey) => {
  const p = join(tmp, `${name}.json`);
  writeFileSync(p, JSON.stringify(Array.from(k.secret)), { mode: 0o600 });
  return p;
};
const keys = { admin: generateAgentKey(), runtime: generateAgentKey(), ref: generateAgentKey(), v1: generateAgentKey(), v2: generateAgentKey() };
const agents = { a: generateAgentKey(), b: generateAgentKey(), gpu: generateAgentKey() };
const kp = Object.fromEntries(Object.entries(keys).map(([n, k]) => [n, writeKey(n, k)])) as Record<string, string>;
const net = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
Object.assign(net, { canary_rate: 0, audit_rate: 0, reveal_window_s: 900, replay_window_min_s: 900, epoch_length_s: 86400, qualify_retry_s: 30 });
writeFileSync(join(tmp, "network.json"), JSON.stringify(net));
const admin = new CoreClient(CORE, keys.admin);
const anon = new CoreClient(CORE, null);
const as = (k: AgentKey) => new CoreClient(CORE, k);
const ONE = 10n ** BigInt(net.token_decimals);
const stateDir = join(tmp, "runtime");
const lines: string[] = [];
/** every distinct public reason each agent showed, in order */
const reasons: Record<string, string[]> = { a: [], b: [], gpu: [] };

async function watchReasons() {
  for (const [n, k] of Object.entries(agents)) {
    const r = await anon.get(`/v1/agents/${k.id}/spend`).catch(() => null);
    const w = r?.status === 200 ? (r.body?.spend?.waiting as string | null | undefined) : undefined;
    if (typeof w === "string" && reasons[n]!.at(-1) !== w) {
      reasons[n]!.push(w);
      log(`page of agent ${n}: ${w}`);
    }
  }
}

async function main() {
  child("core", ["bun", join(ROOT, "packages/core/src/main.ts"), "--data", join(tmp, "data"), "--port", String(PORT), "--config", join(tmp, "network.json"), "--admin-key", kp.admin!, "--runtime-key", kp.runtime!, "--tick-ms", "500", "--no-trees"]);
  await waitFor("core", async () => (await fetch(`${CORE}/v1/health`).catch(() => null))?.ok);

  // ---------------------------------------------------------------- one Python unit and its verifiers
  const loaded = loadRecipe(join(ROOT, "recipes/base58-py"));
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
  log("reference runner calibrating base58-py in the sandbox (3 runs)");
  await new Worker({ core: CORE, key: keys.ref, log: (m) => console.log(`   ref  ${m}`) }).submitCalibration(loaded.recipe_id, snap.snapshot_id, 3);
  const L0 = (await ok<any[]>(anon.get("/v1/lineages"), "lineages"))[0].lineage_id as string;
  // only the two bonded verifiers run: the same shape as the site (calib_replayers 2, two verifiers)
  for (const n of ["v1", "v2"]) child(n, ["bun", join(ROOT, "packages/worker/src/main.ts"), "run", "--core", CORE, "--key", kp[n]!, "--interval", "1500"]);
  await waitFor("verifiers qualified", async () => {
    const vs = await Promise.all(["v1", "v2"].map((n) => ok(anon.get(`/v1/agents/${keys[n as "v1"].id}`), n)));
    return vs.every((v) => v.qualified_lineages.includes(L0));
  });
  check("two bonded verifiers qualified on the one existing Python unit", true, `base58-py ${L0.slice(0, 12)}`);

  // ---------------------------------------------------------------- three hosted agents on repositories with no unit
  const fees = (30n * ONE * 10_000n + 6999n) / 7000n; // 30 test $UNITS in each compute vault
  for (const [n, k] of Object.entries(agents)) {
    await ok(admin.post("/v1/admin/launches", { agent: k.id, mint: generateAgentKey().id, launcher: generateAgentKey().id, target_repo: n === "gpu" ? GPU_REPO : REPO, hosted: true, identity_mode: "app" }), `launch ${n}`);
    await ok(admin.post("/v1/admin/agent-fees", { agent: k.id, amount: fees.toString() }), "fees");
  }
  const v0 = await Promise.all(Object.values(agents).map((k) => ok(anon.get(`/v1/agents/${k.id}`), "agent")));
  check("three hosted agents launched on repositories with no unit: Core holds them in setting_up", v0.every((v) => v.lifecycle === "setting_up" && v.awake === true && v.hosted === true), v0.map((v) => `${v.target_repo.replace("https://github.com/", "")} ${v.lifecycle}`).join(", "));
  const vaultBefore = BigInt(v0[0].compute);

  const cfg = {
    _note: "TEST values (prices, caps)",
    mode: "sim",
    core: CORE,
    state_dir: stateDir,
    runtime_key: kp.runtime,
    effort: "medium",
    attempt_max_usd: ATTEMPT_USD,
    agent_epoch_max_usd: DRAFT_USD + ATTEMPT_USD + 0.2,
    global_max_usd: DRAFT_USD * 2 + ATTEMPT_USD + 0.5,
    min_attempt_usd: 0.1,
    compute_price_line_per_usd: "5",
    compute_price_line_per_sandbox_s: "0.001",
    sandbox_reserve_s: 300,
    usage_epoch_s: 3600,
    close_when_exhausted: false,
    poll_ms: 3000,
    max_concurrent: 1,
    spend_report_s: 3,
    max_candidates_per_agent: 1,
    unit_setup: { draft_max_usd: DRAFT_USD, max_drafts: 2, repo_max_usd: DRAFT_USD * 2, retry_s: 5 },
  };
  writeFileSync(join(tmp, "runtime-config.json"), JSON.stringify(cfg, null, 2));
  const rt = child("rt", ["bun", join(ROOT, "packages/runtime/src/main.ts"), "run", "--config", join(tmp, "runtime-config.json")], (l) => lines.push(l));
  // the launchers of the two agents on the shared repository bind them; the autoresearch agent stays unbound
  for (const n of ["a", "b"] as const) {
    const reqFile = join(stateDir, "bind-requests", `${agents[n].id}.json`);
    const req = await waitFor("bind request", async () => (existsSync(reqFile) ? JSON.parse(readFileSync(reqFile, "utf8")) : null), 60_000, 500);
    await ok(as(agents[n]).post(`/v1/agents/${agents[n].id}/keys/rotate`, req.body), "rotate");
  }
  const watcher = setInterval(() => void watchReasons(), 1500);

  // ---------------------------------------------------------------- the repository that cannot have a unit
  const gpuWhy = await waitFor("the autoresearch reason", async () => reasons.gpu!.find((w) => w.startsWith("no unit possible")), 180_000, 1000).catch(() => null);
  check("karpathy/autoresearch: its page says in one sentence why it cannot have a unit", !!gpuWhy && !gpuWhy.includes("\n") && gpuWhy.length <= 300, gpuWhy ?? reasons.gpu!.join(" | "));

  // ---------------------------------------------------------------- the draft, the proposal, the calibration, the unit
  const proposal = await waitFor("a recipe proposal or the end of the drafts", async () => {
    if (rt.exitCode !== null) throw new Error(`runtime exited with ${rt.exitCode}`);
    const ps = await ok<any[]>(anon.get("/v1/recipe-proposals"), "proposals");
    if (ps.length) return ps[0];
    return lines.some((l) => /no draft left|no unit possible: (?!it has no tests)/.test(l) && l.includes(REPO.replace("https://github.com/", ""))) ? { none: true } : null;
  }, 60 * 60_000, 3000);
  const drafters = [...new Set(lines.filter((l) => l.includes("drafts the unit for")).map((l) => / runtime\] (\w{6}) drafts/.exec(l)?.[1]))];
  check("a model drafted a recipe that passed its trial calibration and the agent proposed it", !proposal.none, proposal.none ? lines.filter((l) => l.includes("unit setup for")).slice(-2).join(" | ") : `${proposal.name} ${proposal.recipe_id.slice(0, 12)} by ${proposal.proposer.slice(0, 6)}, metrics ${proposal.recipe.metrics.map((m: any) => m.name).join(", ")}`);
  if (proposal.none) throw new Error("no draft passed; see the runtime's lines above");
  check("one agent drafted for both (one proposal for the repository, not one per agent)", drafters.length === 1, `drafter ${drafters.join(", ")}; the other showed: ${(drafters[0] === agents.a.id.slice(0, 6) ? reasons.b : reasons.a)!.find((w) => w.includes("is drafting")) ?? "nothing"}`);

  const decided = await waitFor("the verifiers' calibration", async () => {
    const p = (await ok<any[]>(anon.get("/v1/recipe-proposals"), "proposals")).find((x) => x.proposal_id === proposal.proposal_id);
    return p && (p.status === "accepted" || p.status === "rejected") ? p : null;
  }, 60 * 60_000, 3000);
  check("the two verifiers calibrated the proposal by commit and reveal and agreed: Core created the unit", decided.status === "accepted" && !!decided.lineage_id, decided.status === "accepted" ? `unit ${decided.lineage_id.slice(0, 12)}, replays ${decided.replays.map((r: any) => `${r.replayer.slice(0, 6)} ${r.status}`).join(", ")}` : `rejected: ${decided.reason}`);
  if (decided.status !== "accepted") throw new Error(`proposal rejected: ${decided.reason}`);
  const L1 = decided.lineage_id as string;
  const unit = await ok(anon.get(`/v1/lineages/${L1}`), "unit");
  check("the unit is active with stable tests and every deterministic metric enabled", unit.status === "active" && unit.calibration.stable.length > 0 && unit.recipe.metrics.filter((m: any) => m.deterministic).every((m: any) => unit.calibration.metrics[m.name]?.enabled), `${unit.calibration.stable.length} stable tests; ${Object.entries(unit.calibration.metrics).map(([k, v]: any) => `${k}=${v.base_value}`).join(", ")}`);
  const v1 = await Promise.all([agents.a, agents.b].map((k) => ok(anon.get(`/v1/agents/${k.id}`), "agent")));
  check("both agents of the repository are active", v1.every((v) => v.lifecycle === "active"), v1.map((v) => v.lifecycle).join(", "));
  const all = await ok<any[]>(anon.get("/v1/recipe-proposals"), "proposals");
  check("exactly one proposal was ever made", all.length === 1, `${all.length}`);

  // ---------------------------------------------------------------- work on the new unit
  await waitFor("verifiers qualified on the new unit", async () => {
    const vs = await Promise.all(["v1", "v2"].map((n) => ok(anon.get(`/v1/agents/${keys[n as "v1"].id}`), n)));
    return vs.every((v) => v.qualified_lineages.includes(L1));
  }, 30 * 60_000, 3000).then(() => check("both verifiers qualified on the new unit with the recipe they read from Core", true, L1.slice(0, 12)), (e) => check("both verifiers qualified on the new unit with the recipe they read from Core", false, String(e.message)));
  const started = await waitFor("an authoring attempt on the new unit", async () => (rt.exitCode !== null ? "exit" : lines.find((l) => /attempt done:/.test(l))), 40 * 60_000, 2000).catch(() => null);
  check("an agent ran an authoring attempt on the new unit by itself", !!started && started !== "exit" && lines.some((l) => /attempt starts/.test(l)), started ? String(started).replace(/^.*runtime\] /, "") : "no attempt ended in time");
  const mine = await ok<any[]>(admin.get(`/v1/candidates?lineage=${L1}&limit=100`, true), "candidates");
  if (mine.length) {
    const fin = await waitFor("the candidate's verdict", async () => {
      const c = await ok<any[]>(admin.get(`/v1/candidates?lineage=${L1}&limit=100`, true), "candidates");
      return c.every((x) => !["committed", "waiting", "queued", "replaying", "disputed"].includes(x.status)) ? c : null;
    }, 40 * 60_000, 4000).catch(() => null);
    check("its candidate was replayed by the verifiers to a verdict", !!fin, (fin ?? mine).map((c: any) => `${c.commit_id.slice(0, 10)} ${c.status}${c.reason ? ` ${c.reason}` : ""}`).join(", "));
  } else log("the attempt ended without a candidate (nothing to replay)");

  // ---------------------------------------------------------------- reasons and metering
  clearInterval(watcher);
  rt.kill("SIGTERM"); // graceful: closes and posts the usage epoch
  await rt.exited;
  const drafter = drafters[0] === agents.a.id.slice(0, 6) ? "a" : "b";
  const other = drafter === "a" ? "b" : "a";
  const seq = (n: string) => reasons[n]!.map((w) => w.replace(/\(draft.*|\(\d of \d.*/, "").slice(0, 60)).join(" > ");
  check("the drafting agent's page said why at every step", reasons[drafter]!.some((w) => w.includes("drafting the unit for")) && reasons[drafter]!.some((w) => /verifiers are calibrating|waits for enough verifiers/.test(w)), seq(drafter));
  check("the other agent's page said why it waited", reasons[other]!.some((w) => /is drafting the unit|verifiers are calibrating|waits for enough verifiers/.test(w)), seq(other));
  const state = JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8"));
  const usage = await ok(anon.get(`/v1/agents/${agents[drafter as "a"].id}/usage`), "usage");
  const after = await ok(anon.get(`/v1/agents/${agents[drafter as "a"].id}`), "agent");
  const debited = usage.records.reduce((s: bigint, r: any) => s + BigInt(r.amount), 0n);
  const setup = state.unit_setup?.[REPO];
  check("the draft was metered to the drafting agent's vault like an attempt", !!setup && setup.usd > 0 && debited > 0n && vaultBefore - BigInt(after.compute) === debited, `draft ${setup?.usd?.toFixed(4)} USD in ${setup?.drafts} draft(s); vault ${vaultBefore} -> ${after.compute}, debited ${debited}`);
  const gpuUsage = await ok(anon.get(`/v1/agents/${agents.gpu.id}/usage`), "usage");
  check("nothing was spent for karpathy/autoresearch and nothing was proposed for it", gpuUsage.records.length === 0 && !state.open.usage[agents.gpu.id] && all.every((p) => p.repo !== GPU_REPO), `setup state ${JSON.stringify({ impossible_by: state.unit_setup?.[GPU_REPO]?.impossible_by, drafts: state.unit_setup?.[GPU_REPO]?.drafts, usd: state.unit_setup?.[GPU_REPO]?.usd })}`);
  check("no secrets in the runtime's output", !lines.some((l) => /sk-(ant|or)-/.test(l)), `${lines.length} lines`);
  writeFileSync(join(import.meta.dir, "PROOF-LAST.json"), JSON.stringify({
    at: new Date().toISOString(), repo: REPO, model_usd: state.spent_usd_total, draft: setup, proposal: { proposal_id: decided.proposal_id, name: decided.name, recipe_id: decided.recipe_id, unit: L1, metrics: unit.calibration.metrics, stable_tests: unit.calibration.stable.length },
    reasons, autoresearch: state.unit_setup?.[GPU_REPO] ?? null, results,
  }, null, 2) + "\n");
}

// stopped from outside: every child is ours and is stopped by PID, none is left behind
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    void stopAll().finally(() => process.exit(130));
  });

main()
  .catch((e) => {
    console.error(e);
    check("run completed", false, String(e?.message ?? e));
  })
  .finally(async () => {
    await stopAll();
    const sf = join(stateDir, "state.json");
    const spent = existsSync(sf) ? (JSON.parse(readFileSync(sf, "utf8")).spent_usd_total as number) : 0;
    if (!KEEP) rmSync(tmp, { recursive: true, force: true });
    else log(`kept ${tmp}`);
    const failed = results.filter((r) => !r.ok);
    log(`${results.length - failed.length}/${results.length} checks passed; model spend of this run ${spent.toFixed(4)} USD (metered by the runtime, with the route's fee)`);
    process.exit(failed.length ? 1 : 0);
  });
