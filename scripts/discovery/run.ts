#!/usr/bin/env bun
// W6 exit run on a local network (SPEC 12.8, 6.2): a private Core on --port (default 9662, inside
// this lane's block) with base58-rs and base58-py calibrated by a reference runner and three
// bonded verifiers that qualify on both. Then:
//   1. hotspot: the base58-rs launched agent profiles its tip with callgrind in the sandbox, Claude
//      reads the profile and the source and names one hotspot, the agent files it; Core draws
//      another qualified worker, which reruns the profile and reveals; the claim becomes a finding.
//   2. resolution: the same agent authors with the Claude proposer (the finding is in its context)
//      or, with --author scripted, with recipes/base58-rs/candidates; verifiers replay; an accepted
//      perf generation that changes the hotspot's file resolves the finding and credits the finder.
//   3. recipe: a launched agent proposes recipes/bech32-py (drafted by Claude, draft-recipe.ts);
//      Core draws two python-qualified verifiers for calibration replays; on agreement the recipe
//      becomes an active lineage and verifiers qualify on it.
// Every model call is priced into scripts/discovery/spend.jsonl (hard lane cap 3 USD). The run
// record goes to scripts/discovery/runs/<date>.json and the consensus calibration to
// recipes/bech32-py/calibration.json. Core is killed by PID at the end.
//
// Usage: bun scripts/discovery/run.ts [--port 9662] [--author anthropic|scripted] [--author-usd 0.8]
//        [--analyst-usd 0.3] [--skip hotspot|recipe]
import { spawn, type Subprocess } from "bun";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey, type AgentKey } from "@lineage/protocol";
import { applyPatch, loadRecipe, materialize, newWorkDir, prepareDeps, removeTree } from "@lineage/sandbox";
import { CoreClient } from "../../packages/core/src/client.ts";
import { AnthropicProposer, ScriptedProposer, Worker, loadScript, type Proposer } from "../../packages/worker/src/index.ts";
import { DiscoveryAgent, SpendLedger, analyseHotspot, anthropicClient, discoverySeed, profileTip } from "../../packages/worker/src/discovery.ts";
import { CalibrationVerifier, submitProposal } from "../../packages/worker/src/recipe-proposer.ts";

const ROOT = join(import.meta.dir, "../..");
const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
const PORT = Number(opt("port") ?? 9662);
if (PORT < 9662 || PORT > 9669) throw new Error("this lane owns ports 9662-9669 only");
const CORE = `http://127.0.0.1:${PORT}`;
const LANE_CAP = 3;
const ledger = new SpendLedger(join(import.meta.dir, "spend.jsonl"), LANE_CAP);
const skip = new Set((opt("skip") ?? "").split(",").filter(Boolean));
const t00 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t00) / 1000).toFixed(0).padStart(5)}s] ${m}`);
const record: Record<string, unknown> = { date: new Date().toISOString(), port: PORT, spend_before_usd: round6(ledger.total()) };
function round6(x: number) {
  return Math.round(x * 1e6) / 1e6;
}

for (const line of readFileSync(`${process.env.HOME}/.config/lineage/model.env`, "utf8").split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}

const busy = Bun.spawnSync(["lsof", "-ti", `:${PORT}`]).stdout.toString().trim();
if (busy) {
  console.error(`port ${PORT} is in use (pid ${busy}); pick another in 9662-9669`);
  process.exit(1);
}

// ------------------------------------------------------------------ Core
const tmp = mkdtempSync(join(tmpdir(), "lineage-w6-"));
const cfg = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
writeFileSync(join(tmp, "net.json"), JSON.stringify({ ...cfg, canary_rate: 0, audit_rate: 0 }));
mkdirSync(join(tmp, "canaries"));
const admin = generateAgentKey();
writeFileSync(join(tmp, "admin.json"), JSON.stringify(Array.from(admin.secret)), { mode: 0o600 });
let core: Subprocess | null = spawn(
  ["bun", join(ROOT, "packages/core/src/main.ts"), "--data", join(tmp, "data"), "--port", String(PORT), "--config", join(tmp, "net.json"), "--admin-key", join(tmp, "admin.json"), "--canaries-dir", join(tmp, "canaries")],
  { stdout: "ignore", stderr: "pipe" },
);
const stop = () => {
  if (core) {
    core.kill(); // our own child, by PID
    core = null;
  }
};
process.on("SIGINT", () => (stop(), process.exit(130)));
for (let i = 0; i < 60 && !(await fetch(`${CORE}/v1/health`).catch(() => null))?.ok; i++) await Bun.sleep(500);
const A = new CoreClient(CORE, admin);
const as = (k: AgentKey) => new CoreClient(CORE, k);
async function ok<T = any>(p: Promise<{ status: number; body: T }>, what: string): Promise<T> {
  const r = await p;
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body).slice(0, 500)}`);
  return r.body;
}
const get = (path: string) => ok(A.get(path), path);

try {
  const MIN_BOND = BigInt(cfg.min_bond);
  const BURN = BigInt(cfg.register_burn);
  const ref = generateAgentKey();
  const vkeys = [generateAgentKey(), generateAgentKey(), generateAgentKey()];
  for (const k of [ref, ...vkeys]) {
    await ok(A.post("/v1/admin/faucet", { agent: k.id, amount: (BURN + MIN_BOND * 4n).toString() }), "faucet");
    await ok(as(k).post("/v1/agents", {}), "register");
    if (k !== ref) await ok(as(k).post(`/v1/agents/${k.id}/bond`, { amount: MIN_BOND.toString() }), "bond");
  }
  await ok(A.post(`/v1/admin/agents/${ref.id}/reference`, { reference: true }), "reference");
  const quiet = (tag: string) => (m: string) => log(`${tag} ${m}`);
  const refWorker = new Worker({ core: CORE, key: ref, telemetry: false, collab: "off", log: quiet("ref") });
  const vs = vkeys.map((k, i) => ({
    key: k,
    worker: new Worker({ core: CORE, key: k, telemetry: false, collab: "off", log: quiet(`v${i + 1}`) }),
    discovery: new DiscoveryAgent(CORE, k, undefined, quiet(`v${i + 1}`)),
    calib: new CalibrationVerifier(CORE, k, quiet(`v${i + 1}`)),
  }));
  for (const v of vs) await v.worker.declareCapabilities();

  // ------------------------------------------------------------------ lineages
  const lineages: Record<string, string> = {};
  for (const name of ["base58-rs", "base58-py"]) {
    const loaded = loadRecipe(join(ROOT, "recipes", name));
    const deps = await prepareDeps(loaded);
    await ok(A.post("/v1/admin/recipes", { recipe: loaded.recipe, recipe_id: loaded.recipe_id }), "recipe");
    const snap = await ok(A.post("/v1/admin/snapshots", { repo: loaded.recipe.repo, commit: loaded.recipe.commit, deps_digest: deps.digest }), "snapshot");
    log(`${name}: calibrating (reference runner)`);
    const lin = (await refWorker.submitCalibration(loaded.recipe_id, snap.snapshot_id, 5)) as { lineage_id: string };
    lineages[name] = lin.lineage_id;
    log(`${name}: lineage ${lin.lineage_id.slice(0, 12)}`);
  }

  /** Drives every verifier's replays, profile replays and calibration replays until `done` or timeout. */
  async function pump(what: string, done: () => Promise<boolean>, maxS = 1800) {
    const end = Date.now() + maxS * 1000;
    while (Date.now() < end) {
      if (await done()) return;
      let acted = 0;
      for (const v of vs) {
        acted += await v.worker.replayOnce().catch((e) => (log(`replay: ${e.message}`), 0));
        acted += await v.discovery.replayOnce().catch((e) => (log(`profile: ${e.message}`), 0));
        acted += await v.calib.once().catch((e) => (log(`calibrate: ${e.message}`), 0));
      }
      acted += await refWorker.replayOnce().catch(() => 0);
      if (!acted) await Bun.sleep(1000);
    }
    throw new Error(`timed out waiting for ${what}`);
  }
  const qualifiedOn = async (lineage: string) => (await Promise.all(vs.map(async (v) => ((await get(`/v1/agents/${v.key.id}`)).qualified_lineages as string[]).includes(lineage)))).every(Boolean);
  await pump("qualifications", async () => (await qualifiedOn(lineages["base58-rs"]!)) && (await qualifiedOn(lineages["base58-py"]!)));
  log("all three verifiers qualified on base58-rs and base58-py");

  // ------------------------------------------------------------------ 1. hotspot
  const agentKey = generateAgentKey();
  const rs = loadRecipe(join(ROOT, "recipes/base58-rs"));
  await ok(A.post("/v1/admin/launches", { agent: agentKey.id, mint: generateAgentKey().id, launcher: generateAgentKey().id, target_repo: rs.recipe.repo, hosted: false, identity_mode: "token" }), "launch");
  await ok(A.post("/v1/admin/agent-fees", { agent: agentKey.id, amount: (BigInt(cfg.wake_threshold) * 4n).toString() }), "fees");
  if (!skip.has("hotspot")) {
    const finder = new DiscoveryAgent(CORE, agentKey, undefined, quiet("finder"));
    const lid = lineages["base58-rs"]!;
    const { tree, loaded, deps, patches } = await finder.tipOf(lid);
    const metric = "encode_ir";
    const seed = discoverySeed();
    const t0 = Date.now();
    const prof = await profileTip({ loaded, deps, parentPatches: patches, metric, seed });
    log(`finder: profiled ${metric} at ${tree.gen_id.slice(0, 10)}: total ${prof.profile.total} (callgrind summary ${prof.summary}), ${prof.profile.functions.length} functions, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const work = newWorkDir("analyst");
    const src = join(work, "src");
    materialize(loaded.recipe.repo, loaded.recipe.commit, loaded.overlayDir, src);
    for (const p of patches) applyPatch(src, p);
    const a = await analyseHotspot({ client: anthropicClient(), ledger, capUsd: Math.min(Number(opt("analyst-usd") ?? 0.3), ledger.remaining()), loaded, tree: src, metric, tool: prof.tool, profile: prof.profile, log: quiet("") });
    removeTree(work);
    if (!a.choice) throw new Error(`Claude filed no hotspot: ${a.reason}`);
    log(`Claude chose ${a.choice.fn.fn} in ${a.choice.fn.file} (${a.usd.toFixed(4)} USD, ${a.turns} turns): ${a.choice.rationale}`);
    const claim = await finder.file({ lineage_id: lid, tip: tree.gen_id, metric, tool: prof.tool, seed, profile: prof.profile, choice: a.choice });
    log(`claim ${claim.claim_id.slice(0, 12)} filed: ${claim.status}`);
    await pump("hotspot reproduction", async () => !["waiting", "reproducing"].includes((await get(`/v1/findings/hotspots/${claim.claim_id}`)).status));
    const decided = await get(`/v1/findings/hotspots/${claim.claim_id}`);
    log(`claim ${decided.status}: ${decided.reason}`);
    record.hotspot = { analyst_usd: round6(a.usd), analyst_turns: a.turns, profile_seconds: Math.round((Date.now() - t0) / 1000), claim: decided };
    if (decided.status !== "verified") throw new Error("hotspot was not reproduced");
    const finding = (await get(`/v1/findings?lineage=${lid}`)).find((f: any) => f.finding_id === decided.finding_id);
    log(`finding open for proposers: ${finding.kind}: ${finding.target}`);

    // ------------------------------------------------------------------ 2. resolution
    const mode = opt("author") ?? "anthropic";
    let proposer: Proposer;
    if (mode === "anthropic") {
      const cap = Math.min(Number(opt("author-usd") ?? 0.8), ledger.remaining());
      proposer = new AnthropicProposer({ max_usd: cap, effort: "medium", max_evals: 3, max_turns: 25 });
      log(`author: Claude proposer, cap ${cap.toFixed(2)} USD`);
    } else proposer = new ScriptedProposer(loadScript(join(ROOT, "recipes/base58-rs/candidates")));
    const author = new Worker({
      core: CORE,
      key: agentKey,
      proposer,
      lineages: [lid],
      maxCandidates: 1,
      telemetry: false,
      collab: "off",
      soul: false,
      log: quiet("author"),
      attempt: () => ({ meter: { model: (u) => void ledger.add("author-proposer", u), sandbox: () => {} } }),
    });
    const commit = await author.authorOnce();
    if (!commit) throw new Error("the author submitted no candidate");
    log(`author committed ${commit.slice(0, 12)}`);
    const cand = async () => (await A.get(`/v1/candidates/${commit}`, true)).body;
    await pump("verdict", async () => ["accepted", "rejected", "expired"].includes((await cand()).status));
    const c = await cand();
    log(`candidate ${c.status}${c.reason ? ` (${c.reason})` : ""}${c.gen_id ? `, generation ${c.gen_id.slice(0, 12)}` : ""}`);
    const gen = c.gen_id ? await get(`/v1/generations/${c.gen_id}`) : null;
    const after = await get(`/v1/findings/hotspots/${claim.claim_id}`);
    log(`hotspot after the verdict: ${after.status}${after.resolved_by ? ` by ${after.resolved_by.slice(0, 12)}` : ""}`);
    record.resolution = { author: mode, candidate: { commit_id: commit, status: c.status, reason: c.reason, gen_id: c.gen_id }, generation: gen && { gen_id: gen.gen_id, effect: gen.effect, target: gen.target, patch_files: (gen.patch as string).split("\n").filter((l: string) => l.startsWith("diff --git")) }, claim_after: { status: after.status, resolved_by: after.resolved_by } };
  }

  // ------------------------------------------------------------------ 3. agent-proposed recipe
  if (!skip.has("recipe")) {
    const dir = join(ROOT, "recipes/bech32-py");
    const draft = JSON.parse(readFileSync(join(dir, "proposal.json"), "utf8"));
    const pk = generateAgentKey();
    const loaded = loadRecipe(dir);
    await ok(A.post("/v1/admin/launches", { agent: pk.id, mint: generateAgentKey().id, launcher: generateAgentKey().id, target_repo: loaded.recipe.repo, hosted: false, identity_mode: "token" }), "launch proposer");
    const p = await submitProposal(as(pk), dir, draft.note ?? "");
    log(`proposal ${p.proposal_id.slice(0, 12)} for ${loaded.recipe.name} (${loaded.recipe_id.slice(0, 12)}): ${p.status}`);
    await pump("calibration replays", async () => ["accepted", "rejected"].includes((await get(`/v1/recipe-proposals/${p.proposal_id}`)).status), 3600);
    const view = await get(`/v1/recipe-proposals/${p.proposal_id}`);
    log(`proposal ${view.status}${view.reason ? `: ${view.reason}` : ""}${view.lineage_id ? `, lineage ${view.lineage_id.slice(0, 12)}` : ""}`);
    record.recipe = { proposal: view };
    if (view.status !== "accepted") throw new Error("the proposal was not accepted");
    await pump("qualification on the new lineage", async () => {
      const q = await Promise.all(vs.map(async (v) => ((await get(`/v1/agents/${v.key.id}`)).qualified_lineages as string[]).includes(view.lineage_id)));
      return q.filter(Boolean).length >= 2;
    });
    const lin = await get(`/v1/lineages/${view.lineage_id}`);
    const quals = await Promise.all(vs.map(async (v) => ({ agent: v.key.id, qualified: ((await get(`/v1/agents/${v.key.id}`)).qualified_lineages as string[]).includes(view.lineage_id) })));
    log(`lineage ${lin.status}, ${quals.filter((q) => q.qualified).length} verifiers qualified on it; proposer agent ${(await get(`/v1/agents/${pk.id}`)).lifecycle}`);
    (record.recipe as Record<string, unknown>).lineage = { lineage_id: lin.lineage_id, status: lin.status, recipe_id: lin.recipe_id, calibration: lin.calibration, qualifications: quals };
    writeFileSync(
      join(dir, "calibration.json"),
      JSON.stringify({ ...lin.calibration, recipe_name: loaded.recipe.name, repo: loaded.recipe.repo, commit: loaded.recipe.commit, deps_digest: view.replays[0]?.result?.deps_digest, source: "consensus of calibration replays (scripts/discovery/run.ts)", proposal_id: view.proposal_id, date: new Date().toISOString() }, null, 2) + "\n",
    );
  }
} finally {
  record.spend_after_usd = round6(ledger.total());
  record.spend_this_run_usd = round6(ledger.total() - (record.spend_before_usd as number));
  record.wall_seconds = Math.round((Date.now() - t00) / 1000);
  mkdirSync(join(import.meta.dir, "runs"), { recursive: true });
  const out = join(import.meta.dir, "runs", `${(record.date as string).replace(/[:.]/g, "-")}.json`);
  writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
  log(`run record ${out}; spend this run ${(record.spend_this_run_usd as number).toFixed(4)} USD, lane total ${(record.spend_after_usd as number).toFixed(4)} of ${LANE_CAP}`);
  stop();
  rmSync(tmp, { recursive: true, force: true });
}
