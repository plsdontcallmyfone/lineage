#!/usr/bin/env bun
// More units per repository, proved on a local network (docs/plans/AGENT-EFFICIENCY.md section 8;
// packages/core/src/unit-dry.ts, packages/runtime/src/more-units.ts). Same setup as local-proof.ts: a
// simulated Core with a runtime authority, a reference runner and two bonded verifier processes, the
// real sandbox, and `units-runtime run` as its own process with the real model (routed like every
// Claude call). The repository already has ONE unit, of a class that is not Python (--recipe, default
// base58-rs: debris/base58, class rust). Nobody drafts, submits or calibrates anything by hand.
//
//   1. seeded final attempts make the unit dry by Core's rule with its default settings (9 attempts
//      that ended without a candidate, recorded by two other launched agents through the public
//      session routes: session, end, worker report, journal entry);
//   2. refusals that cost nothing: a duplicate of the existing unit is refused by Core before any
//      verifier is drawn; with only an agent whose vault is empty bound, no draft starts and the reason
//      is kept (network compute is off for drafts);
//   3. the paying agent is bound: it drafts an ADDITIONAL unit, both verifiers calibrate it by commit
//      and reveal, Core checks the headroom and creates the unit;
//   4. the runtime is restarted with authoring on: the agent's unit choice takes the fresh unit (the
//      dry one is last), its first attempt gives a candidate, the verifiers accept it;
//   5. more seeded attempts make the new unit dry too: the runtime refuses another unit for the
//      cool-down; restarted with max_per_repo 2, for the limit.
//
// Prices and caps are TEST values. Model spend is bounded by --draft-usd per draft (2 drafts at most),
// --attempt-usd per authoring attempt and global_max_usd (their sum plus 0.5).
// Usage: bun scripts/unit-setup/more-units-proof.ts [--port 9668] [--recipe base58-rs] [--draft-usd 1.2] [--attempt-usd 0.5] [--keep]
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey, type AgentKey } from "@units/protocol";
import { loadRecipe, prepareDeps } from "@units/sandbox";
import { CoreClient } from "../../packages/core/src/client.ts";
import { duplicateUnit, newTargets } from "../../packages/core/src/more-units.ts";
import { journalStatement, signJournal } from "../../packages/core/src/protocol.ts";
import { doctor } from "../../packages/worker/src/doctor.ts";
import { Worker } from "../../packages/worker/src/index.ts";
import { describeUnits, moreSection, submitProposal } from "../../packages/worker/src/recipe-proposer.ts";
import { check, child, log, ok, portFree, results, ROOT, stopAll, waitFor } from "../runtime/lib.ts";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1]! : d);
const PORT = Number(opt("port", "9668"));
if (![9666, 9667, 9668, 9669].includes(PORT)) throw new Error("use a test port: 9666 to 9669");
const KEEP = argv.includes("--keep");
const RECIPE = opt("recipe", "base58-rs");
const DRAFT_USD = Number(opt("draft-usd", "1.2"));
const ATTEMPT_USD = Number(opt("attempt-usd", "0.5"));
const CORE = `http://127.0.0.1:${PORT}`;
portFree(PORT);

const tmp = mkdtempSync(join(tmpdir(), "units-more-units-"));
const writeKey = (name: string, k: AgentKey) => {
  const p = join(tmp, `${name}.json`);
  writeFileSync(p, JSON.stringify(Array.from(k.secret)), { mode: 0o600 });
  return p;
};
const keys = { admin: generateAgentKey(), runtime: generateAgentKey(), ref: generateAgentKey(), v1: generateAgentKey(), v2: generateAgentKey() };
// a pays; c is hosted with an empty vault; s1 and s2 are other launched agents whose attempts are seeded
const agents = { a: generateAgentKey(), c: generateAgentKey(), s1: generateAgentKey(), s2: generateAgentKey() };
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
const rtLine = (re: RegExp) => lines.find((l) => re.test(l))?.replace(/^.*runtime\] /, "");

/** One final attempt of `k` on `unit` that ended without a candidate, through the routes a worker uses. */
async function fruitless(k: AgentKey, unit: string, n: number): Promise<void> {
  const c = as(k);
  const lv = await ok(anon.get(`/v1/lineages/${unit}`), "unit");
  const s = await ok(c.post("/v1/sessions", { lineage_id: unit, gen_id: lv.tip, commit: lv.snapshot.commit_sha, proposer: "seeded" }), "session");
  const sid = s.session_id as string;
  await ok(c.post(`/v1/sessions/${sid}/events`, { events: [{ kind: "read", path: "src/lib.rs", start_line: 1, end_line: 40 }, { kind: "note", text: `seeded attempt ${n}: nothing measured faster` }] }), "events");
  await ok(c.post(`/v1/sessions/${sid}/end`, {}), "end");
  await ok(c.post(`/v1/sessions/${sid}/episode`, { v: 1, planned: null, outcome: "no change found", usage: { input_tokens: 1000, output_tokens: 200, cache_read_tokens: 0, cache_write_tokens: 0, usd: 0.01 }, sandbox_s: 1, models: ["seeded"], harness: null, route: null }), "report");
  const st = journalStatement({ agent: k.id, session_id: sid, lineage_id: unit, created_at: Date.now(), text: `Seeded attempt ${n} of the local proof: nothing I tried measured faster.` });
  await ok(c.post(`/v1/agents/${k.id}/journal`, { statement: st, sig: signJournal(k, st) }), "journal");
}

const dryOf = async (unit: string) => ok(anon.get(`/v1/units/${unit}/dry`), "dry");

function runtimeConfig(over: Record<string, unknown>) {
  const cfg = {
    _note: "TEST values (prices, caps)",
    mode: "sim",
    core: CORE,
    state_dir: stateDir,
    runtime_key: kp.runtime,
    effort: "medium",
    attempt_max_usd: ATTEMPT_USD,
    agent_epoch_max_usd: DRAFT_USD * 2 + ATTEMPT_USD * 2 + 0.2,
    global_max_usd: DRAFT_USD * 2 + ATTEMPT_USD * 2 + 0.5,
    min_attempt_usd: 0.1,
    compute_price_line_per_usd: "5",
    compute_price_line_per_sandbox_s: "0.001",
    sandbox_reserve_s: 300,
    usage_epoch_s: 3600,
    close_when_exhausted: false,
    poll_ms: 3000,
    max_concurrent: 1,
    spend_report_s: 3,
    efficiency: { spread: true },
    more_units: { enabled: true, draft_max_usd: DRAFT_USD, max_drafts: 2, repo_max_usd: DRAFT_USD * 2, retry_s: 5, check_s: 5 },
    ...over,
  };
  const f = join(tmp, `runtime-config-${Object.keys(over).join("-") || "base"}.json`);
  writeFileSync(f, JSON.stringify(cfg, null, 2));
  return f;
}

async function stopRuntime(rt: ReturnType<typeof child>) {
  rt.kill("SIGTERM"); // graceful: closes and posts the usage epoch
  await rt.exited;
}

async function main() {
  child("core", ["bun", join(ROOT, "packages/core/src/main.ts"), "--data", join(tmp, "data"), "--port", String(PORT), "--config", join(tmp, "network.json"), "--admin-key", kp.admin!, "--runtime-key", kp.runtime!, "--tick-ms", "500", "--no-trees"]);
  await waitFor("core", async () => (await fetch(`${CORE}/v1/health`).catch(() => null))?.ok);

  // ---------------------------------------------------------------- the repository's one unit and its verifiers
  const loaded = loadRecipe(join(ROOT, "recipes", RECIPE));
  const REPO = loaded.recipe.repo;
  const deps = await prepareDeps(loaded);
  await ok(admin.post("/v1/admin/recipes", { recipe: loaded.recipe, recipe_id: loaded.recipe_id }), "recipe");
  const snap = await ok(admin.post("/v1/admin/snapshots", { repo: REPO, commit: loaded.recipe.commit, deps_digest: deps.digest }), "snapshot");
  const caps = doctor().capabilities;
  for (const n of ["ref", "v1", "v2"] as const) {
    await ok(admin.post("/v1/admin/faucet", { agent: keys[n].id, amount: (BigInt(net.register_burn) + BigInt(net.min_bond) * 2n).toString() }), "faucet");
    await ok(as(keys[n]).post("/v1/agents", { capabilities: caps }), `register ${n}`);
    if (n !== "ref") await ok(as(keys[n]).post(`/v1/agents/${keys[n].id}/bond`, { amount: String(net.min_bond) }), `bond ${n}`);
  }
  await ok(admin.post(`/v1/admin/agents/${keys.ref.id}/reference`, { reference: true }), "reference");
  log(`reference runner calibrating ${RECIPE} in the sandbox (3 runs)`);
  await new Worker({ core: CORE, key: keys.ref, log: (m) => console.log(`   ref  ${m}`) }).submitCalibration(loaded.recipe_id, snap.snapshot_id, 3);
  const L1 = (await ok<any[]>(anon.get("/v1/lineages"), "lineages"))[0].lineage_id as string;
  for (const n of ["v1", "v2"]) child(n, ["bun", join(ROOT, "packages/worker/src/main.ts"), "run", "--core", CORE, "--key", kp[n]!, "--interval", "1500"]);
  await waitFor("verifiers qualified", async () => {
    const vs = await Promise.all(["v1", "v2"].map((n) => ok(anon.get(`/v1/agents/${keys[n as "v1"].id}`), n)));
    return vs.every((v) => v.qualified_lineages.includes(L1));
  });
  check(`the repository has one unit of class ${loaded.recipe.class}, with two bonded verifiers qualified on it`, loaded.recipe.class !== "python", `${RECIPE} ${L1.slice(0, 12)} on ${REPO.replace("https://github.com/", "")}; targets ${loaded.recipe.metrics.filter((m) => m.deterministic).map((m) => m.name).join(", ")}`);

  // ---------------------------------------------------------------- agents
  const fees = (30n * ONE * 10_000n + 6999n) / 7000n; // 30 test $UNITS in the paying agent's compute vault
  for (const [n, k] of Object.entries(agents)) {
    await ok(admin.post("/v1/admin/launches", { agent: k.id, mint: generateAgentKey().id, launcher: generateAgentKey().id, target_repo: REPO, hosted: n === "a" || n === "c", identity_mode: "app" }), `launch ${n}`);
    if (n === "a") await ok(admin.post("/v1/admin/agent-fees", { agent: k.id, amount: fees.toString() }), "fees");
  }
  const vaultBefore = BigInt((await ok(anon.get(`/v1/agents/${agents.a.id}`), "agent")).compute);

  // ---------------------------------------------------------------- 1. the dry signal, forced with seeded attempts
  const before = await dryOf(L1);
  check("a unit nobody attempted is fresh, not dry", before.dry === false && before.fresh === true && before.line === null, `${before.facts.attempts} final attempts`);
  for (let i = 0; i < 9; i++) await fruitless(i % 2 ? agents.s2 : agents.s1, L1, i + 1);
  const dry1 = await waitFor("the dry signal", async () => {
    const d = await dryOf(L1);
    return d.dry ? d : null;
  }, 120_000, 3000).catch(async () => dryOf(L1));
  check("nine final attempts by two agents that ended without a candidate: Core says the unit has run dry, with its default settings", dry1.dry === true && dry1.rule === "fruitless" && dry1.settings.window === 12 && dry1.settings.min_attempts === 8, `${dry1.line} (rule ${dry1.rule}; window ${dry1.facts.attempts}, fruitless share ${dry1.facts.fruitless_share})`);
  check("the dry unit is not closed: still active, its generations kept", (await ok(anon.get(`/v1/lineages/${L1}`), "unit")).status === "active", "status active");

  // ---------------------------------------------------------------- 2a. refusal: a duplicate, before any verifier is drawn
  const dupDir = join(tmp, "dup");
  cpSync(join(ROOT, "recipes", RECIPE), dupDir, { recursive: true });
  writeFileSync(join(dupDir, "recipe.yml"), readFileSync(join(dupDir, "recipe.yml"), "utf8").replace(/^name: .*$/m, `name: ${RECIPE}-again`));
  const dup = await submitProposal(as(agents.s1), dupDir, "the same targets again").then(() => "accepted for calibration", (e) => String((e as Error).message));
  const propsAfterDup = await ok<any[]>(anon.get("/v1/recipe-proposals"), "proposals");
  check("refusal: a draft with the existing unit's targets on its paths is refused by Core before any verifier is drawn", /409/.test(dup) && dup.includes("duplicate_unit") && propsAfterDup.length === 0, dup.replace(/^proposal: /, "").slice(0, 260));

  // what the drafter will be given (the same text the runtime's drafter gets; read here only to record it)
  const given = moreSection({ units: await describeUnits(anon, [L1]), maxFixedShare: 0.1 });

  // ---------------------------------------------------------------- 2b. refusal: no agent can pay
  let rt = child("rt", ["bun", join(ROOT, "packages/runtime/src/main.ts"), "run", "--config", runtimeConfig({ max_candidates_per_agent: 0 })], (l) => lines.push(l));
  const bind = async (n: "a" | "c") => {
    const reqFile = join(stateDir, "bind-requests", `${agents[n].id}.json`);
    const req = await waitFor("bind request", async () => (existsSync(reqFile) ? JSON.parse(readFileSync(reqFile, "utf8")) : null), 60_000, 500);
    await ok(as(agents[n]).post(`/v1/agents/${agents[n].id}/keys/rotate`, req.body), "rotate");
  };
  await bind("c");
  const broke = await waitFor("the vault refusal", async () => rtLine(/more units for .*no agent of it can pay/), 120_000, 1000).catch(() => null);
  check("refusal: with only an agent whose vault is empty bound, no draft starts; network compute is not spent on drafting (the default)", !!broke && broke.includes("more_units.on_network_compute is off") && !lines.some((l) => /is drafting an additional unit/.test(l)), broke ?? lines.filter((l) => l.includes("more units")).slice(-1)[0] ?? "nothing said");
  const spent0 = existsSync(join(stateDir, "state.json")) ? (JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8")).spent_usd_total as number) : 0;
  check("nothing was spent so far", spent0 === 0, `${spent0} USD`);

  // ---------------------------------------------------------------- 3. the additional unit: drafted, calibrated, created
  await bind("a");
  const proposal = await waitFor("a proposal or the end of the drafts", async () => {
    if (rt.exitCode !== null) throw new Error(`runtime exited with ${rt.exitCode}`);
    const ps = await ok<any[]>(anon.get("/v1/recipe-proposals"), "proposals");
    if (ps.length) return ps[0];
    return lines.some((l) => /more units for .*(are used up|found nothing more to measure)/.test(l)) ? { none: true } : null;
  }, 60 * 60_000, 3000);
  const started = rtLine(/is drafting an additional unit/);
  check("with the paying agent bound, it drafts an additional unit because every unit of the repository has run dry", !!started && started.includes(agents.a.id.slice(0, 6)), started ?? "no draft started");
  check("a model drafted a recipe that passed its trial calibration and the agent proposed it", !proposal.none, proposal.none ? lines.filter((l) => l.includes("more units for")).slice(-2).join(" | ") : `${proposal.name} ${proposal.recipe_id.slice(0, 12)} by ${proposal.proposer.slice(0, 6)}`);
  if (proposal.none) throw new Error("no draft passed; see the runtime's lines above");
  const draft = proposal.recipe;
  const fresh = newTargets(draft, loaded.recipe);
  check("the draft adds headroom: targets the existing unit does not have, on the same commit and image", duplicateUnit(draft, [loaded.recipe]) === null && fresh.length > 0 && draft.commit === loaded.recipe.commit && draft.image === loaded.recipe.image && draft.class === loaded.recipe.class, `new targets ${fresh.join(", ")}; allowed paths ${draft.patch.allowed_paths.join(", ")}`);
  check("every instruction-count metric of the draft declares fixed_command", draft.metrics.filter((m: any) => m.parser === "cachegrind-ir").every((m: any) => typeof m.fixed_command === "string"), draft.metrics.filter((m: any) => m.fixed_command).map((m: any) => m.name).join(", "));

  const decided = await waitFor("the verifiers' calibration", async () => {
    const p = (await ok<any[]>(anon.get("/v1/recipe-proposals"), "proposals")).find((x) => x.proposal_id === proposal.proposal_id);
    return p && (p.status === "accepted" || p.status === "rejected") ? p : null;
  }, 60 * 60_000, 3000);
  check("both verifiers calibrated the proposal by commit and reveal and agreed: Core created the unit", decided.status === "accepted" && !!decided.lineage_id, decided.status === "accepted" ? `unit ${decided.lineage_id.slice(0, 12)}, replays ${decided.replays.map((r: any) => `${r.replayer.slice(0, 6)} ${r.status}`).join(", ")}` : `rejected: ${decided.reason}`);
  if (decided.status !== "accepted") throw new Error(`proposal rejected: ${decided.reason}`);
  const L2 = decided.lineage_id as string;
  const unit2 = await ok(anon.get(`/v1/lineages/${L2}`), "unit");
  const shares = Object.entries<any>(unit2.calibration.metrics).filter(([, v]) => typeof v.fixed_value === "number").map(([k, v]) => [k, v.fixed_value / v.base_value] as const);
  check("the merged calibration shows the headroom signal: the part that is not the library is recorded and at most 10% of every instruction-count metric", shares.length > 0 && shares.every(([, s]) => s <= 0.1) && unit2.status === "active", shares.map(([k, s]) => `${k} ${(100 * s).toFixed(2)}%`).join(", "));
  await waitFor("verifiers qualified on the new unit", async () => {
    const vs = await Promise.all(["v1", "v2"].map((n) => ok(anon.get(`/v1/agents/${keys[n as "v1"].id}`), n)));
    return vs.every((v) => v.qualified_lineages.includes(L2));
  }, 30 * 60_000, 3000).then(() => check("both verifiers qualified on the new unit with the recipe they read from Core", true, L2.slice(0, 12)), (e) => check("both verifiers qualified on the new unit with the recipe they read from Core", false, String(e.message)));
  const drafts = lines.filter((l) => /unit draft done/.test(l)).map((l) => l.replace(/^.*runtime\] /, ""));
  await stopRuntime(rt);
  const state1 = JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8"));
  const draftUsd = state1.spent_usd_total as number;

  // ---------------------------------------------------------------- 4. the agent picks the fresh unit; its first attempt is accepted
  const at4 = lines.length;
  rt = child("rt", ["bun", join(ROOT, "packages/runtime/src/main.ts"), "run", "--config", runtimeConfig({ max_candidates_per_agent: 1 })], (l) => lines.push(l));
  const done = await waitFor("an authoring attempt", async () => (rt.exitCode !== null ? "exit" : lines.slice(at4).find((l) => /attempt done:.*candidate [0-9a-f]{12}/.test(l))), 60 * 60_000, 2000).catch(() => null);
  const choice = lines.slice(at4).find((l) => /unit choice:/.test(l))?.replace(/^.*unit choice: /, "") ?? "";
  check("the worker's unit choice takes the fresh unit and puts the dry one last", choice.startsWith(L2.slice(0, 10)) && choice.includes("1 dry unit last"), choice || "no unit choice logged");
  check("the agent's attempt on the additional unit gave a candidate", !!done && done !== "exit", done ? String(done).replace(/^.*runtime\] /, "") : "no candidate in time");
  const cands = await waitFor("the candidate's verdict", async () => {
    const c = await ok<any[]>(admin.get(`/v1/candidates?lineage=${L2}&limit=100`, true), "candidates");
    return c.length && c.every((x) => !["committed", "waiting", "queued", "replaying", "disputed"].includes(x.status)) ? c : null;
  }, 60 * 60_000, 4000).catch(() => [] as any[]);
  const view2 = await ok(anon.get(`/v1/lineages/${L2}`), "unit");
  const gen1 = (view2.generations as any[]).find((g) => g.entry_type === "patch");
  check("a first accepted change on the additional unit, replayed by both verifiers", cands.some((c) => c.status === "accepted") && !!gen1, cands.map((c) => `${c.commit_id.slice(0, 10)} ${c.status}${c.reason ? ` ${c.reason}` : ""}`).join(", ") + (gen1 ? `; ${gen1.effect?.metric} ratio ${Number(gen1.effect?.ratio).toFixed(4)}` : ""));
  check("no candidate went to the dry unit", (await ok<any[]>(admin.get(`/v1/candidates?lineage=${L1}&limit=100`, true), "candidates")).length === 0, "0 candidates on the first unit");

  // ---------------------------------------------------------------- 5a. refusal: the cool-down
  const at5 = lines.length;
  for (let i = 0; i < 12; i++) await fruitless(i % 2 ? agents.s2 : agents.s1, L2, 100 + i);
  const dry2 = await waitFor("the new unit dry", async () => {
    const d = await dryOf(L2);
    return d.dry ? d : null;
  }, 180_000, 3000).catch(async () => dryOf(L2));
  check("twelve more attempts without a candidate make the new unit dry too (its accepted change is out of the window)", dry2.dry === true, `${dry2.line}`);
  const cool = await waitFor("the cool-down refusal", async () => lines.slice(at5).find((l) => /more units for .*days old; another is drafted/.test(l))?.replace(/^.*runtime\] /, ""), 120_000, 1000).catch(() => null);
  check("refusal: every unit dry again, but the newest unit is inside the cool-down: no draft", !!cool && !lines.slice(at5).some((l) => /is drafting an additional unit/.test(l)), cool ?? lines.slice(at5).filter((l) => l.includes("more units")).slice(-1)[0] ?? "nothing said");
  await stopRuntime(rt);

  // ---------------------------------------------------------------- 5b. refusal: the limit
  const at6 = lines.length;
  rt = child("rt", ["bun", join(ROOT, "packages/runtime/src/main.ts"), "run", "--config", runtimeConfig({ max_candidates_per_agent: 1, more_units: { enabled: true, max_per_repo: 2, check_s: 5 } })], (l) => lines.push(l));
  const limit = await waitFor("the limit refusal", async () => lines.slice(at6).find((l) => /more units for .*the most a repository may have/.test(l))?.replace(/^.*runtime\] /, ""), 120_000, 1000).catch(() => null);
  check("refusal: at max_per_repo units no additional unit is drafted", !!limit && !lines.slice(at6).some((l) => /is drafting an additional unit/.test(l)), limit ?? "nothing said");
  await stopRuntime(rt);

  // ---------------------------------------------------------------- metering and the record
  const all = await ok<any[]>(anon.get("/v1/recipe-proposals"), "proposals");
  check("exactly one proposal was ever admitted for calibration", all.length === 1, `${all.length}`);
  const state = JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8"));
  const usage = await ok(anon.get(`/v1/agents/${agents.a.id}/usage`), "usage");
  const after = await ok(anon.get(`/v1/agents/${agents.a.id}`), "agent");
  const debited = usage.records.reduce((s: bigint, r: any) => s + BigInt(r.amount), 0n);
  check("the draft and the attempt were metered to the paying agent's vault", debited > 0n && vaultBefore - BigInt(after.compute) === debited, `vault ${vaultBefore} -> ${after.compute}, debited ${debited}; model spend ${Number(state.spent_usd_total).toFixed(4)} USD (drafting ${draftUsd.toFixed(4)})`);
  const cUsage = await ok(anon.get(`/v1/agents/${agents.c.id}/usage`), "usage");
  check("the agent with the empty vault was charged nothing", cUsage.records.length === 0, `${cUsage.records.length} usage records`);
  check("no secrets in the runtime's output", !lines.some((l) => /sk-(ant|or)-/.test(l)), `${lines.length} lines`);
  writeFileSync(join(import.meta.dir, "PROOF-MORE-UNITS.json"), JSON.stringify({
    at: new Date().toISOString(), repo: REPO, class: loaded.recipe.class, model_usd: state.spent_usd_total, draft_usd: draftUsd, drafts,
    existing_unit: { name: RECIPE, unit: L1, targets: loaded.recipe.metrics.map((m) => m.name), dry: { rule: dry1.rule, line: dry1.line, facts: dry1.facts, settings: dry1.settings } },
    given_to_the_drafter: given,
    proposal: { proposal_id: decided.proposal_id, name: decided.name, recipe_id: decided.recipe_id, unit: L2, note: decided.note, recipe: draft, overlay_files: Object.keys(decided.overlay), calibration: unit2.calibration.metrics, stable_tests: unit2.calibration.stable.length, median_eval_seconds: unit2.calibration.median_eval_seconds },
    first_accepted: gen1 ? { gen_id: gen1.gen_id, effect: gen1.effect } : null,
    unit_choice: choice, refusals: { duplicate: dup, vault: broke, cooldown: cool, limit }, more_units_state: state.more_units?.[REPO] ?? null, results,
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
