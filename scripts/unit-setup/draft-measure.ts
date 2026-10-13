#!/usr/bin/env bun
// Measures one repository's unit setup on a local network with real model calls (SPEC 6.2): how many
// turns and how much model spend a draft takes before its first trial, what every trial reported and
// why it failed (packages/worker/src/trial-reason.ts), whether a draft reaches a unit the verifiers
// calibrate, and the total spend. Same setup as local-proof.ts: a simulated Core with a runtime
// authority, a reference runner and two bonded verifiers as their own processes, the real sandbox,
// `units-runtime run` as its own process, the model routed like every Claude call. The network holds
// one unit of the repository's class (--reference, a recipe in this tree: the format reference the
// drafter is shown, as on a live network), and one hosted, bound agent is launched on --repo.
// The runtime is stopped as soon as the proposal is decided, so that no authoring attempt is paid for
// (a run on 2026-10-13 that waited 4 s more and stopped gracefully paid 0.3629 USD for one).
//
// Prices and caps are TEST values. Model spend is bounded by --draft-usd per draft (a draft can end
// up to one turn above it) times --drafts.
// Usage: bun scripts/unit-setup/draft-measure.ts --repo <url> --label <name> [--reference gorbagana-chain]
//          [--port 9666] [--draft-usd 1.5] [--drafts 1] [--setup '{"first_trial_turns":8}'] [--keep]
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey, type AgentKey } from "@units/protocol";
import { loadRecipe, prepareDeps } from "@units/sandbox";
import { CoreClient } from "../../packages/core/src/client.ts";
import { doctor } from "../../packages/worker/src/doctor.ts";
import { Worker } from "../../packages/worker/src/index.ts";
import { child, log, ok, portFree, ROOT, stopAll, waitFor } from "../runtime/lib.ts";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1]! : d);
const PORT = Number(opt("port", "9666"));
if (![9666, 9667, 9668, 9669].includes(PORT)) throw new Error("use a test port: 9666 to 9669");
const KEEP = argv.includes("--keep");
const REPO = opt("repo", "");
if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(REPO)) throw new Error("--repo https://github.com/<owner>/<name>");
const LABEL = opt("label", "run").replace(/[^a-z0-9-]/gi, "-");
const REFERENCE = opt("reference", "gorbagana-chain");
const DRAFT_USD = Number(opt("draft-usd", "1.5"));
const DRAFTS = Number(opt("drafts", "1"));
const SETUP = JSON.parse(opt("setup", "{}")) as Record<string, unknown>;
const CORE = `http://127.0.0.1:${PORT}`;
portFree(PORT);

const tmp = mkdtempSync(join(tmpdir(), "units-draft-measure-"));
const writeKey = (name: string, k: AgentKey) => {
  const p = join(tmp, `${name}.json`);
  writeFileSync(p, JSON.stringify(Array.from(k.secret)), { mode: 0o600 });
  return p;
};
const keys = { admin: generateAgentKey(), runtime: generateAgentKey(), ref: generateAgentKey(), v1: generateAgentKey(), v2: generateAgentKey() };
const agent = generateAgentKey();
const kp = Object.fromEntries(Object.entries(keys).map(([n, k]) => [n, writeKey(n, k)])) as Record<string, string>;
const net = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
Object.assign(net, { canary_rate: 0, audit_rate: 0, reveal_window_s: 1800, replay_window_min_s: 1800, epoch_length_s: 86400, qualify_retry_s: 30 });
writeFileSync(join(tmp, "network.json"), JSON.stringify(net));
const admin = new CoreClient(CORE, keys.admin);
const anon = new CoreClient(CORE, null);
const as = (k: AgentKey) => new CoreClient(CORE, k);
const ONE = 10n ** BigInt(net.token_decimals);
const stateDir = join(tmp, "runtime");
const lines: string[] = [];
const sentences: string[] = [];
const out: Record<string, unknown> = { at: new Date().toISOString(), label: LABEL, repo: REPO, reference: REFERENCE, draft_max_usd: DRAFT_USD, max_drafts: DRAFTS, unit_setup: SETUP };

async function main() {
  child("core", ["bun", join(ROOT, "packages/core/src/main.ts"), "--data", join(tmp, "data"), "--port", String(PORT), "--config", join(tmp, "network.json"), "--admin-key", kp.admin!, "--runtime-key", kp.runtime!, "--tick-ms", "500", "--no-trees"]);
  await waitFor("core", async () => (await fetch(`${CORE}/v1/health`).catch(() => null))?.ok);

  // one unit of the class and its two verifiers
  const loaded = loadRecipe(join(ROOT, "recipes", REFERENCE));
  log(`preparing the dependency layer of ${REFERENCE}`);
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
  log(`reference runner calibrating ${REFERENCE} in the sandbox (3 runs)`);
  await new Worker({ core: CORE, key: keys.ref, log: (m) => console.log(`   ref  ${m}`) }).submitCalibration(loaded.recipe_id, snap.snapshot_id, 3);
  const L0 = (await ok<any[]>(anon.get("/v1/lineages"), "lineages"))[0].lineage_id as string;
  for (const n of ["v1", "v2"]) child(n, ["bun", join(ROOT, "packages/worker/src/main.ts"), "run", "--core", CORE, "--key", kp[n]!, "--interval", "1500"]);
  await waitFor("verifiers qualified", async () => {
    const vs = await Promise.all(["v1", "v2"].map((n) => ok(anon.get(`/v1/agents/${keys[n as "v1"].id}`), n)));
    return vs.every((v) => v.qualified_lineages.includes(L0));
  }, 30 * 60_000);
  log(`two verifiers qualified on ${REFERENCE}`);

  // one hosted agent on the repository
  const fees = (60n * ONE * 10_000n + 6999n) / 7000n;
  await ok(admin.post("/v1/admin/launches", { agent: agent.id, mint: generateAgentKey().id, launcher: generateAgentKey().id, target_repo: REPO, hosted: true, identity_mode: "app" }), "launch");
  await ok(admin.post("/v1/admin/agent-fees", { agent: agent.id, amount: fees.toString() }), "fees");
  const cfg = {
    _note: "TEST values (prices, caps)",
    mode: "sim",
    core: CORE,
    state_dir: stateDir,
    runtime_key: kp.runtime,
    effort: "medium",
    attempt_max_usd: 0.6,
    agent_epoch_max_usd: DRAFT_USD * DRAFTS + 1.5,
    global_max_usd: DRAFT_USD * DRAFTS + 1.5,
    min_attempt_usd: 0.1,
    compute_price_line_per_usd: "5",
    compute_price_line_per_sandbox_s: "0.001",
    sandbox_reserve_s: 300,
    usage_epoch_s: 7200,
    close_when_exhausted: false,
    poll_ms: 3000,
    max_concurrent: 1,
    spend_report_s: 3,
    max_candidates_per_agent: 1,
    unit_setup: { draft_max_usd: DRAFT_USD, max_drafts: DRAFTS, repo_max_usd: DRAFT_USD * DRAFTS, retry_s: 5, ...SETUP },
  };
  writeFileSync(join(tmp, "runtime-config.json"), JSON.stringify(cfg, null, 2));
  const t0 = Date.now();
  const rt = child("rt", ["bun", join(ROOT, "packages/runtime/src/main.ts"), "run", "--config", join(tmp, "runtime-config.json")], (l) => lines.push(`${((Date.now() - t0) / 1000).toFixed(0)}s ${l}`));
  const reqFile = join(stateDir, "bind-requests", `${agent.id}.json`);
  const req = await waitFor("bind request", async () => (existsSync(reqFile) ? JSON.parse(readFileSync(reqFile, "utf8")) : null), 60_000, 500);
  await ok(as(agent).post(`/v1/agents/${agent.id}/keys/rotate`, req.body), "rotate");
  let detail: unknown = null;
  const watcher = setInterval(async () => {
    const r = await anon.get(`/v1/agents/${agent.id}/spend`).catch(() => null);
    const w = r?.status === 200 ? (r.body?.spend?.waiting as string | null | undefined) : undefined;
    if (typeof w === "string" && sentences.at(-1) !== w) {
      sentences.push(w);
      log(`public sentence: ${w}`);
    }
    if (r?.status === 200 && r.body?.spend?.setup) detail = r.body.spend.setup;
  }, 1500);

  const label = REPO.replace("https://github.com/", "");
  const end = await waitFor("a proposal or the end of the drafts", async () => {
    const ps = await ok<any[]>(anon.get("/v1/recipe-proposals"), "proposals");
    if (ps.length) return { proposal: ps[0] };
    if (rt.exitCode !== null) return { proposal: null, died: rt.exitCode };
    return lines.some((l) => /no draft left|no unit possible: /.test(l) && l.toLowerCase().includes(label.toLowerCase())) ? { proposal: null } : null;
  }, 3 * 60 * 60_000, 3000);
  if ("died" in end) out.runtime_exited = end.died;
  let decided: any = null;
  if (end.proposal) {
    log(`proposed: ${end.proposal.name}; waiting for the verifiers' calibration`);
    decided = await waitFor("the verifiers' calibration", async () => {
      const p = (await ok<any[]>(anon.get("/v1/recipe-proposals"), "proposals")).find((x) => x.proposal_id === end.proposal.proposal_id);
      return p && (p.status === "accepted" || p.status === "rejected") ? p : null;
    }, 2 * 60 * 60_000, 2000).catch((e) => ({ status: "timeout", reason: String(e.message) }));
  }
  // stopped at once and hard: a unit that was just created turns the agent active, and a graceful stop would
  // wait for (and pay for) the authoring attempt the runtime starts on it. The state file is written as it changes.
  clearInterval(watcher);
  rt.kill("SIGKILL");
  await rt.exited;

  const state = JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8"));
  // Core keeps a repository's address in lower case, and the runtime's state is keyed by Core's form
  const setup = (Object.entries(state.unit_setup ?? {}).find(([k]) => k.toLowerCase() === REPO.toLowerCase())?.[1] ?? null) as any;
  const first = lines.filter((l) => /recipe-drafter: trial 1\/\d+/.test(l)).map((l) => /trial 1\/\d+ \(after (\d+) turns?, ([\d.]+) USD\)/.exec(l)).map((m) => (m ? { turns: Number(m[1]), usd_before_fee: Number(m[2]) } : null));
  const ended = lines.filter((l) => /recipe-drafter: draft ended/.test(l)).map((l) => /draft ended after (\d+) turns and (\d+) trials?; (\d+) turns and ([\d.]+) USD before the first trial/.exec(l)).map((m) => (m ? { turns: Number(m[1]), trials: Number(m[2]), turns_before_first_trial: Number(m[3]), usd_before_first_trial: Number(m[4]) } : null));
  const unit = decided?.status === "accepted" ? await ok(anon.get(`/v1/lineages/${decided.lineage_id}`), "unit") : null;
  Object.assign(out, {
    seconds: Math.round((Date.now() - t0) / 1000),
    model_usd: state.spent_usd_total,
    drafts: setup?.drafts ?? 0,
    drafts_usd: setup?.usd ?? 0,
    per_draft: ended,
    first_trial_logged: first,
    trials: setup?.trials ?? [],
    last_reason: setup?.last_reason ?? null,
    impossible: setup?.impossible ?? null,
    public_sentences: sentences,
    runway_detail: detail,
    proposal: end.proposal ? { name: end.proposal.name, recipe_id: end.proposal.recipe_id, allowed_paths: end.proposal.recipe.patch.allowed_paths, prepare: end.proposal.recipe.prepare, build: end.proposal.recipe.build.commands, test: end.proposal.recipe.test.command, metrics: end.proposal.recipe.metrics.map((m: any) => m.name), note: end.proposal.note } : null,
    calibration: decided ? { status: decided.status, reason: decided.reason ?? null, unit: decided.lineage_id ?? null, stable_tests: unit?.calibration.stable.length ?? null, metrics: unit?.calibration.metrics ?? null } : null,
    log: lines.filter((l) => /recipe-drafter: (trial|draft ended|spend cap|turn limit)|unit setup for|drafts the unit|proposed the unit|unit draft done/.test(l)).map((l) => l.replace(/\[[\d:]+ runtime\] /, "")),
    secrets_in_output: lines.some((l) => /sk-(ant|or)-/.test(l)),
  });
  writeFileSync(join(import.meta.dir, `MEASURE-${LABEL}.json`), JSON.stringify(out, null, 2) + "\n");
  log(`wrote scripts/unit-setup/MEASURE-${LABEL}.json`);
}

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    void stopAll().finally(() => process.exit(130));
  });

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopAll();
    const sf = join(stateDir, "state.json");
    const spent = existsSync(sf) ? (JSON.parse(readFileSync(sf, "utf8")).spent_usd_total as number) : 0;
    if (!KEEP) rmSync(tmp, { recursive: true, force: true });
    else log(`kept ${tmp}`);
    log(`model spend of this run ${spent.toFixed(4)} USD (metered by the runtime, with the route's fee)`);
    process.exit(process.exitCode ?? 0);
  });
