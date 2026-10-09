#!/usr/bin/env bun
// End-to-end check for MILESTONES M1 exit item 2. Starts a real Core and real verifier processes
// (separate keys), runs every replay in real Docker sandboxes on the fixture lineage, and asserts
// the network reaches the right outcome for each planted patch.
//
// Usage: bun scripts/e2e.ts [--port 9662] [--keep]
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeDiff, generateAgentKey, H, patchCommitment, patchHash, sha256Hex, signStatement, type AgentKey } from "@lineage/protocol";
import { loadRecipe, prepareDeps } from "@lineage/sandbox";
import { CoreClient } from "../packages/core/src/client.ts";
import { doctor } from "../packages/worker/src/doctor.ts";
import { loadScript, ScriptedProposer, Worker } from "../packages/worker/src/index.ts";
import { teamStatement } from "../packages/core/src/collab.ts";
import { encryptionKeyStatement, messageEnvelope } from "../packages/core/src/messages.ts";
import { deriveEncryptionKey, seal } from "../packages/core/src/seal.ts";
// measured split and cross-lineage ports (plan W4); importing it registers the second fixture recipe
import { collabExtras, EXTRA_RECIPES } from "./e2e-collab-extras.ts";

const ROOT = join(import.meta.dir, "..");
const PATCHES = join(ROOT, "fixtures", "b58-patches");
const argv = process.argv.slice(2);
const PORT = Number(argv[argv.indexOf("--port") + 1] || 9662);
const KEEP = argv.includes("--keep");
const CORE = `http://127.0.0.1:${PORT}`;
const T0 = Date.now();

const log = (m: string) => console.log(`[e2e +${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
const results: { check: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ check: name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
}

const busy = Bun.spawnSync(["lsof", "-ti", `:${PORT}`]).stdout.toString().trim();
if (busy) {
  console.error(`port ${PORT} busy (pid ${busy}); pick another in 9662-9669`);
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "lineage-e2e-"));
const procs: Subprocess[] = [];
function writeKey(name: string, k: AgentKey): string {
  const p = join(tmp, `${name}.json`);
  writeFileSync(p, JSON.stringify(Array.from(k.secret)));
  return p;
}

const keys = {
  admin: generateAgentKey(),
  ref: generateAgentKey(),
  v1: generateAgentKey(),
  v2: generateAgentKey(),
  v3: generateAgentKey(),
  v4: generateAgentKey(),
  // a fifth honest verifier that co-authors a team candidate as a reviewer (SPEC 12.2)
  v5: generateAgentKey(),
  liar: generateAgentKey(),
  faker: generateAgentKey(),
  wrongarch: generateAgentKey(),
  author: generateAgentKey(),
  launcher: generateAgentKey(),
  // a second launched author on the same lineage (collaboration checks, SPEC 12)
  author2: generateAgentKey(),
  launcher2: generateAgentKey(),
};
const kp = Object.fromEntries(Object.entries(keys).map(([n, k]) => [n, writeKey(n, k)])) as Record<keyof typeof keys, string>;
const net = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
Object.assign(net, {
  canary_rate: 1,
  audit_rate: 1,
  reveal_window_s: 600,
  replay_window_min_s: 300,
  max_open_candidates_per_agent: 20,
  epoch_length_s: 86400,
  qualify_retry_s: 60,
  // canary scheduling compressed for the run (SPEC 10.5; network defaults are minutes to an hour)
  shadow_launch_spread_s: 20,
  shadow_min_age_s: 5,
  canary_inject_delay_s: [2, 10],
  canary_reveal_delay_s: [1, 5],
  // collaboration caps (SPEC 12.1), test values
  max_intents_per_agent: 3,
  intent_max_ttl_s: 1800,
  intent_rate_per_hour: 20,
});
writeFileSync(join(tmp, "network.json"), JSON.stringify(net));

const admin = new CoreClient(CORE, keys.admin);
async function ok<T = any>(p: Promise<{ status: number; body: T }>, what: string): Promise<T> {
  const r = await p;
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
const as = (k: AgentKey) => new CoreClient(CORE, k);

function startVerifier(name: string, extra: string[] = []): Subprocess {
  const p = spawn(["bun", join(ROOT, "packages/worker/src/main.ts"), "run", "--core", CORE, "--key", kp[name as keyof typeof kp], "--interval", "1000", ...extra], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  (async () => {
    for await (const chunk of p.stdout) for (const l of new TextDecoder().decode(chunk).split("\n")) if (l.trim()) console.log(`   ${name.padEnd(4)} ${l}`);
  })();
  (async () => {
    for await (const chunk of p.stderr) for (const l of new TextDecoder().decode(chunk).split("\n")) if (l.trim()) console.log(`   ${name.padEnd(4)} ! ${l}`);
  })();
  procs.push(p);
  return p;
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 600_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v as T;
    await Bun.sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const FINAL = new Set(["accepted", "rejected", "expired"]);
async function candidateFinal(id: string) {
  return waitFor(`candidate ${id.slice(0, 10)}`, async () => {
    const r = await admin.get(`/v1/candidates/${id}`);
    return r.status === 200 && FINAL.has(r.body.status) ? r.body : null;
  });
}

async function main() {
  // ---------------------------------------------------------------- core
  const core = spawn(
    ["bun", join(ROOT, "packages/core/src/main.ts"), "--data", join(tmp, "data"), "--port", String(PORT), "--config", join(tmp, "network.json"), "--admin-key", kp.admin, "--tick-ms", "500"],
    { stdout: "inherit", stderr: "inherit" },
  );
  procs.push(core);
  await waitFor("core", async () => (await fetch(`${CORE}/v1/health`).catch(() => null))?.ok);
  log(`core up on ${CORE}, data ${tmp}`);

  // ---------------------------------------------------------------- lineage setup
  const loaded = loadRecipe(join(ROOT, "recipes/fixture-b58"));
  const deps = await prepareDeps(loaded);
  const rec = await ok(admin.post("/v1/admin/recipes", { recipe: loaded.recipe, recipe_id: loaded.recipe_id }), "recipe");
  check("recipe id recomputed by Core matches the worker's", (rec.recipe_id ?? loaded.recipe_id) === loaded.recipe_id);
  const snap = await ok(admin.post("/v1/admin/snapshots", { repo: loaded.recipe.repo, commit: loaded.recipe.commit, deps_digest: deps.digest }), "snapshot");

  const fund = (k: AgentKey, amount: bigint) => ok(admin.post("/v1/admin/faucet", { agent: k.id, amount: amount.toString() }), "faucet");
  const MIN_BOND = BigInt(net.min_bond);
  const BURN = BigInt(net.register_burn);
  // real capabilities from this machine (what `lineage-worker doctor` prints); workers re-declare on start
  const caps = doctor().capabilities;
  const wrongCaps = { ...caps, arch: caps.arch === "arm64" ? "amd64" : "arm64" };
  for (const n of ["ref", "v1", "v2", "v3", "v4", "v5", "liar", "faker", "wrongarch"] as const) {
    await fund(keys[n], BURN + MIN_BOND * 20n);
    await ok(as(keys[n]).post("/v1/agents", { capabilities: n === "wrongarch" ? wrongCaps : caps, ...(n === "v5" ? { operator: "team-op" } : {}) }), `register ${n}`);
  }
  await ok(admin.post(`/v1/admin/agents/${keys.ref.id}/reference`, { reference: true }), "mark reference");
  for (const n of ["v1", "v2", "v3", "v4", "v5", "faker", "wrongarch"] as const) await ok(as(keys[n]).post(`/v1/agents/${keys[n].id}/bond`, { amount: MIN_BOND.toString() }), `bond ${n}`);

  log("reference runner calibrating the fixture in the sandbox");
  const refWorker = new Worker({ core: CORE, key: keys.ref, log: (m) => console.log(`   ref  ${m}`) });
  const cal = await refWorker.submitCalibration(loaded.recipe_id, snap.snapshot_id, 3);
  const lineages = await ok<any[]>(admin.get("/v1/lineages"), "lineages");
  check("calibration accepted, lineage created", lineages.length === 1, JSON.stringify(cal).slice(0, 120));
  const lineage = await ok(admin.get(`/v1/lineages/${lineages[0].lineage_id}`), "lineage");
  const L = lineage.lineage_id as string;
  check("stable set and known failure from real calibration", lineage.calibration.stable.length === 4 && lineage.calibration.known_failures.length === 1);
  const findings = await ok<any[]>(admin.get(`/v1/findings?lineage=${L}`), "findings");
  check("findings created from calibration", findings.length >= 2, `${findings.length} open`);

  await ok(
    admin.post("/v1/admin/launches", { agent: keys.author.id, mint: generateAgentKey().id, launcher: keys.launcher.id, target_repo: loaded.recipe.repo, hosted: false, identity_mode: "token" }),
    "launch author",
  );
  await ok(admin.post("/v1/admin/agent-fees", { agent: keys.author.id, amount: (BigInt(net.wake_threshold) * 10n).toString() }), "agent fees");
  const authorView = await ok(admin.get(`/v1/agents/${keys.author.id}`), "author");
  check("launched agent is active and awake after its token fees arrive", authorView.lifecycle === "active" && authorView.awake === true, `compute ${authorView.compute}`);

  // reference runner process (answers reference and tie-break assignments) and honest verifiers
  startVerifier("ref");
  startVerifier("v1");
  startVerifier("v2");
  startVerifier("v3");
  // a fourth honest verifier: audits draw audit_replayers (2) auditors outside the accepted stage's pair
  startVerifier("v4");
  startVerifier("v5");
  // a verifier that fabricates everything, qualification included
  startVerifier("faker", ["--dishonest", "fabricate"]);

  // ---------------------------------------------------------------- qualification (SPEC 6.1)
  const agentView = (n: keyof typeof keys) => ok(admin.get(`/v1/agents/${keys[n].id}`), n);
  const lastQual = (v: any) => (v.qualifications as any[]).filter((q) => q.lineage_id === L).at(-1);
  const quals = await waitFor("honest verifiers qualified", async () => {
    const vs = await Promise.all((["v1", "v2", "v3", "v4"] as const).map(agentView));
    return vs.every((v) => v.qualified_lineages.includes(L)) ? vs : null;
  });
  check("honest verifiers pass qualification on real hardware", quals.every((v) => lastQual(v)?.status === "passed"), quals.map((v) => lastQual(v)?.reason).join(" | ").slice(0, 200));
  const faker = await waitFor("faker qualification resolved", async () => {
    const v = await agentView("faker");
    return lastQual(v) && ["failed", "expired"].includes(lastQual(v).status) ? v : null;
  });
  check(
    "fabricated qualification fails against calibration; no slash, no strike",
    lastQual(faker).status === "failed" && faker.qualified_lineages.length === 0 && faker.slashed_total === "0" && faker.strikes_total === 0,
    String(lastQual(faker).reason).slice(0, 160),
  );
  const wrong = await agentView("wrongarch");
  check("a verifier declaring the wrong arch gets no qualification", wrong.qualifications.length === 0 && wrong.qualified_lineages.length === 0, `declared ${wrong.capabilities?.arch}`);

  const index = JSON.parse(readFileSync(join(PATCHES, "index.json"), "utf8"));
  const author = (names: string[]) =>
    new Worker({ core: CORE, key: keys.author, proposer: new ScriptedProposer(loadScript(PATCHES, names)), lineages: [L], log: (m) => console.log(`   auth ${m}`) });

  async function submit(name: string): Promise<any> {
    const w = author([name]);
    const id = await w.authorOnce();
    if (!id) throw new Error(`author did not submit ${name}`);
    const final = await candidateFinal(id);
    log(`${name}: ${final.status}${final.reason ? ` (${final.reason})` : ""}`);
    return final;
  }

  // ---------------------------------------------------------------- live telemetry watcher (SPEC 17.1)
  // Samples every public live surface while candidates are open. A candidate that is still open
  // AFTER a sample was open DURING it, so its ids must not appear in that sample.
  const watch = { samples: 0, sealedSeen: 0, violations: [] as string[], blindSeen: 0, blindLeaks: [] as string[], phases: new Set<string>(), jobs: new Set<string>(), stop: false };
  const watcher = (async () => {
    const anon = new CoreClient(CORE, null);
    while (!watch.stop) {
      try {
        const [lv, hb, act, evs, full] = await Promise.all([
          anon.get("/v1/live"),
          anon.get("/v1/heartbeats"),
          anon.get("/v1/activity?limit=1000"),
          anon.get("/v1/events/log?since=0&limit=5000"),
          admin.get("/v1/admin/heartbeats", true),
        ]);
        const liveEvents = (evs.body as any[]).filter((e) => e.type === "activity" || e.type === "machine.heartbeat");
        const text = JSON.stringify([lv.body, hb.body, act.body, liveEvents]);
        const open = ((await anon.get(`/v1/candidates?limit=1000`)).body as any[]).filter((c) => !FINAL.has(c.status));
        for (const c of open) for (const id of [c.candidate_id, c.commit_id]) if (id && text.includes(id)) watch.violations.push(`${id.slice(0, 10)} (${c.status})`);
        // author-blind replay (SPEC 10.7): an open candidate's public view, its committed event and the public
        // activity never name its author; the author's submit is not public
        for (const c of open) {
          watch.blindSeen++;
          if (c.author !== null || c.commitment !== null) watch.blindLeaks.push(`${String(c.commit_id).slice(0, 10)} view`);
          const ev = (evs.body as any[]).find((e) => e.type === "candidate.committed" && e.data?.commit_id === c.commit_id);
          if (ev && "author" in ev.data) watch.blindLeaks.push(`${String(c.commit_id).slice(0, 10)} event`);
        }
        if ((act.body as any[]).some((a) => a.kind === "submit")) watch.blindLeaks.push("public submit activity");
        // public verifier machines never show a replay job, phase, timing or load (SPEC 17.1)
        for (const m of hb.body as any[]) if (m.kind === "verifier" && (m.job === "replay" || (m.job !== "qualify" && (m.phase || m.load || m.job_started_at)))) watch.violations.push(`public ${m.agent_id.slice(0, 8)} job ${m.job}`);
        for (const m of full.body as any[]) {
          if (!m.awake) continue;
          watch.jobs.add(m.job);
          if (m.phase) watch.phases.add(`${m.job}:${m.phase}`);
          if (m.sealed) watch.sealedSeen++;
        }
        watch.samples++;
      } catch {
        /* Core busy; next sample */
      }
      await Bun.sleep(400);
    }
  })();

  // ---------------------------------------------------------------- phase 1: intents (SPEC 12.1), then accepted generations
  await ok(
    admin.post("/v1/admin/launches", { agent: keys.author2.id, mint: generateAgentKey().id, launcher: keys.launcher2.id, target_repo: loaded.recipe.repo, hosted: false, identity_mode: "token" }),
    "launch author2",
  );
  const author2 = as(keys.author2);
  const fileIntent2 = async (kind: string, target: string | string[]) => {
    const tip = (await ok(admin.get(`/v1/lineages/${L}`), "lineage")).tip;
    const st = { v: 1, agent: keys.author2.id, lineage_id: L, tip, kind, target, finding_id: null, note: null, ttl_s: 1200 };
    return author2.post("/v1/intents", { lineage_id: L, tip, kind, target, ttl_s: 1200, sig: signStatement(keys.author2, "intent", st) });
  };
  const held = await fileIntent2("perf", "encode_ir");
  check("a second author files a signed intent on encode_ir", held.status === 200 && held.body.status === "open", `${held.status} ${JSON.stringify(held.body).slice(0, 120)}`);
  // the advisory worker plans around the held target: it files its own intent and authors the fix first
  const advisory = author(["perf_encode", "fix_leading_ones"]);
  const firstId = await advisory.authorOnce();
  const firstMine = await ok<any>(as(keys.author).get(`/v1/candidates/${firstId}`, true), "first candidate");
  check("the advisory worker picks a target nobody holds an intent on", firstMine.kind === "fix", `${firstMine.kind} ${JSON.stringify(firstMine.target)}`);
  const myIntents = await ok<any[]>(as(keys.author).get(`/v1/intents?lineage=${L}&agent=${keys.author.id}&status=all`, true), "own intents");
  check(
    "its intent closes on commit for the author at once, linked to the candidate",
    myIntents.some((i) => i.status === "committed" && i.candidate?.commit_id === firstMine.commit_id && i.kind === "fix"),
    myIntents.map((i) => `${i.kind}:${i.status}`).join(", "),
  );
  const pubOpen = await ok<any[]>(admin.get(`/v1/intents?lineage=${L}&status=all`), "intents");
  check("two authors' intents are public on the lineage board", new Set(pubOpen.map((i) => i.agent)).size === 2, `${pubOpen.length} intents`);
  const wb = await ok(admin.get(`/v1/lineages/${L}/workboard`), "workboard");
  check("workboard names who holds an intent on each target", wb.targets.some((t: any) => t.target === "encode_ir" && t.holders.includes(keys.author2.id)), `${wb.targets.length} targets`);
  const p2 = await candidateFinal(firstMine.commit_id);
  log(`fix_leading_ones: ${p2.status}${p2.reason ? ` (${p2.reason})` : ""}`);
  check("fix_leading_ones accepted (known failure fixed)", p2.status === "accepted");
  const closedPub = await waitFor("intent publicly committed", async () => {
    const xs = await ok<any[]>(admin.get(`/v1/intents?lineage=${L}&agent=${keys.author.id}&status=committed`), "intents");
    return xs.find((i) => i.candidate?.candidate_id === p2.candidate_id) ?? null;
  }, 30_000).catch(() => null);
  check("once the candidate is final the public board shows the intent led to it", !!closedPub && closedPub.candidate.status === "accepted");
  const wb2 = await waitFor("workboard files", async () => {
    const x = await ok(admin.get(`/v1/lineages/${L}/workboard`), "workboard");
    return x.files.length > 0 ? x : null;
  }, 30_000).catch(() => null);
  check("workboard lists the files authors touched in its window", !!wb2 && wb2.files.some((f: any) => f.agents.some((a: any) => a.agent === keys.author.id)), `${wb2?.files.length ?? 0} files`);
  const heldNow = await ok<any[]>(admin.get(`/v1/intents?lineage=${L}&agent=${keys.author2.id}&status=all`), "intents");
  check("an intent on a tip that moved is stale", heldNow.some((i) => i.intent_id === held.body.intent_id && i.status === "stale"), heldNow.map((i) => i.status).join(","));
  // ---------------------------------------------------------------- teams with declared shares (SPEC 12.2)
  await waitFor("v5 qualified", async () => ((await agentView("v5")).qualified_lineages.includes(L) ? true : null));
  const team = [
    { agent: keys.author.id, role: "author" as const, share_bps: 7000 },
    { agent: keys.v5.id, role: "reviewer" as const, share_bps: 3000 },
  ];
  const teamTry = async (members: { agent: string; role: string; share_bps: number }[], signers: AgentKey[]) => {
    const tip = (await ok(admin.get(`/v1/lineages/${L}`), "lineage")).tip;
    const commitment = H("e2e-team-try", String(Math.random()));
    const st = teamStatement({ lineage_id: L, parent_gen_id: tip, commitment, kind: "perf", target: "decode_ir", members: members as any });
    const sigs = Object.fromEntries(signers.map((k) => [k.id, signStatement(k, "team", st)]));
    return as(keys.author).post("/v1/candidates", { lineage_id: L, parent_gen_id: tip, kind: "perf", target: "decode_ir", commitment, team: { members, sigs } });
  };
  const unsignedTry = await teamTry(team, [keys.author]);
  check("a team candidate with an unsigned member is refused", unsignedTry.status === 403 && unsignedTry.body.error === "unsigned_member", `${unsignedTry.status} ${unsignedTry.body?.error}`);
  const steerMembers = [
    { agent: keys.author.id, role: "author", share_bps: 7000 },
    { agent: keys.v5.id, role: "reviewer", share_bps: 1000 },
    { agent: keys.v3.id, role: "reviewer", share_bps: 1000 },
    { agent: keys.v4.id, role: "reviewer", share_bps: 1000 },
  ];
  const steerTry = await teamTry(steerMembers, [keys.author, keys.v5, keys.v3, keys.v4]);
  check("exclusion steering (consenting zero-weight reviewers) is refused at max_team_excluded_bond_bps", steerTry.status === 409 && steerTry.body.error === "team_excludes_too_much", `${steerTry.status} ${steerTry.body?.message ?? ""}`);
  const teamWorker = new Worker({
    core: CORE,
    key: keys.author,
    proposer: new ScriptedProposer(loadScript(PATCHES, ["perf_encode"])),
    lineages: [L],
    collab: "team",
    team: { members: team, keys: [keys.v5] },
    log: (m) => console.log(`   team ${m}`),
  });
  const teamId = await teamWorker.authorOnce();
  if (!teamId) throw new Error("team worker did not submit perf_encode");
  const teamOpen = await ok<any>(admin.get(`/v1/candidates/${teamId}`), "team candidate");
  check("a team candidate's team and author are withheld while open", teamOpen.author === null && teamOpen.team === null);
  const p1 = await candidateFinal(teamId);
  log(`perf_encode (team): ${p1.status}${p1.reason ? ` (${p1.reason})` : ""}`);
  check("perf_encode accepted as a two-agent team candidate (deterministic instruction count)", p1.status === "accepted" && p1.team?.members?.length === 2, p1.effect ? `ratio ${p1.effect.ratio}` : "");
  const teamGen = p1.gen_id as string;
  const evLog = await ok<any[]>(admin.get("/v1/events/log?since=0&limit=5000"), "events");
  const tu = evLog.filter((e) => e.type === "units.awarded" && e.data.kind === "author" && e.data.ref === teamGen).map((e) => e.data);
  const mu = (a: string) => Math.round((tu.find((u) => u.agent === a)?.units ?? 0) * 1e6);
  const totalMu = mu(keys.author.id) + mu(keys.v5.id);
  check("author units split exactly by the declared shares (70/30)", tu.length === 2 && totalMu > 0 && Math.abs(mu(keys.author.id) - totalMu * 0.7) <= 1, `${mu(keys.author.id)} + ${mu(keys.v5.id)} micro-units`);
  // spam caps: max_intents_per_agent open intents, then 429
  // identical intents get distinct ids only across milliseconds (collab.ts duplicate_intent), so space them
  for (let k = 0; k < 3; k++) {
    await ok(fileIntent2("perf", "decode_ir"), `intent ${k}`);
    await Bun.sleep(5);
  }
  const spam = await fileIntent2("perf", "decode_ir");
  check("an agent past max_intents_per_agent gets 429", spam.status === 429 && spam.body.error === "too_many_intents", `${spam.status} ${spam.body?.error}`);

  // ---------------------------------------------------------------- phase 2: rejections
  const expectReason: [string, string][] = [
    ["break_tests", "tests_fail"],
    ["regress", "no_improvement"],
    ["equiv_change", "equivalence_changed"],
    ["protected_test_edit", "guard"],
  ];
  for (const [name, reason] of expectReason) {
    const w = author([name]);
    const id = await w.authorOnce();
    if (!id) {
      // a scripted patch that no longer applies to the tip is skipped by the author
      check(`${name} rejected with ${reason}`, false, "author could not apply it to the tip");
      continue;
    }
    const f = await candidateFinal(id);
    check(`${name} rejected with ${reason}`, f.status === "rejected" && String(f.reason).includes(reason), `${f.status} ${f.reason ?? ""}`);
  }

  // ---------------------------------------------------------------- live telemetry checks
  watch.stop = true;
  await watcher;
  check(
    "sealed replays never expose a candidate id or a replaying verifier via public live endpoints before final",
    watch.violations.length === 0 && watch.sealedSeen > 0,
    `${watch.samples} samples, ${watch.sealedSeen} sealed replay heartbeats seen, ${watch.violations.length} leaks ${watch.violations.slice(0, 3).join(" ")}`,
  );
  check(
    "author-blind replay: no public candidate view, event or activity names the author of an open candidate",
    watch.blindLeaks.length === 0 && watch.blindSeen > 0,
    `${watch.blindSeen} open-candidate samples, ${watch.blindLeaks.length} leaks ${watch.blindLeaks.slice(0, 3).join(" ")}`,
  );
  const replayPhases = [...watch.phases].filter((p) => p.startsWith("replay:")).map((p) => p.slice(7));
  check("heartbeats carry real replay phases from the sandbox", ["build", "test", "metrics"].every((p) => replayPhases.includes(p)), `observed ${[...watch.phases].sort().join(", ")}`);
  const machines = await ok<any[]>(admin.get("/v1/heartbeats"), "heartbeats");
  const beating = ["ref", "v1", "v2", "v3", "v4", "faker"].filter((n) => machines.some((m) => m.agent_id === keys[n as keyof typeof keys].id));
  check("every worker process sends heartbeats with its declared capabilities", beating.length === 6 && machines.filter((m) => beating.some((n) => keys[n as keyof typeof keys].id === m.agent_id)).every((m) => m.caps_match === true), `${beating.join(",")} of ref,v1,v2,v3,v4,faker`);
  const st = await ok(admin.get("/v1/stats"), "stats");
  check("stats count machines awake and verified gains", st.machines_awake >= 6 && st.verified_gains === 2, `awake ${st.machines_awake} of ${st.machines}, gains ${st.verified_gains}`);
  // signed: the admin (and the author itself) also sees submits, which the public list withholds (SPEC 10.7)
  const acts = await ok<any[]>(admin.get(`/v1/activity?agent=${keys.author.id}&limit=1000`, true), "activity");
  const edits = acts.filter((a) => a.kind === "edit");
  check(
    "author activity arrives: edits with path and parent range checked against the generation tree, then propose and submit",
    edits.length > 0 && edits.every((a) => a.path_checked && a.start_line >= 1) && acts.some((a) => a.kind === "propose") && acts.some((a) => a.kind === "submit"),
    `${acts.length} events: ${[...new Set(acts.map((a) => a.kind))].join(", ")}`,
  );
  const allowed = new Set(["id", "agent", "kind", "lineage_id", "gen_id", "commit", "path", "start_line", "end_line", "query", "target", "content_sha256", "path_checked", "at", "received_at"]);
  check("activity events carry no file content or patch text", acts.every((a) => Object.keys(a).every((k) => allowed.has(k))) && !JSON.stringify(acts).includes("with_capacity"));
  const g0 = await ok(admin.get(`/v1/lineages/${L}/file?gen=${lineage.gen0}&path=src/lib.rs`), "file gen0");
  const tipNow = (await ok(admin.get(`/v1/lineages/${L}`), "lineage")).tip;
  const gTip = await ok(admin.get(`/v1/lineages/${L}/file?gen=${tipNow}&path=src/lib.rs`), "file tip");
  check(
    "file endpoint rebuilds the tree: gen 0 equals the snapshot bytes, the tip carries the accepted patches",
    g0.sha256 === sha256Hex(readFileSync(join(ROOT, "fixtures/b58/src/lib.rs"))) && gTip.source === "patched" && String(gTip.text).includes("with_capacity"),
    `gen0 ${String(g0.sha256).slice(0, 10)}, tip ${gTip.source} at height ${gTip.height}`,
  );
  const bogus = await as(keys.author).post("/v1/activity", { events: [{ kind: "read", lineage_id: L, gen_id: tipNow, commit: lineage.snapshot.commit_sha, path: "src/not_there.rs" }] });
  check("activity naming a path outside the generation tree is refused", bogus.status === 400, `${bogus.status} ${JSON.stringify(bogus.body).slice(0, 120)}`);

  // ---------------------------------------------------------------- phase 3: stale candidates
  // A slow author commits against gen_0 after the tip moved. One patch conflicts, one rebases.
  const authorClient = as(keys.author);
  async function submitStale(name: string): Promise<any> {
    const patch = readFileSync(join(PATCHES, `${name}.diff`), "utf8");
    const salt = H("salt", name, String(Date.now()));
    const meta = index[name];
    const c = await ok(
      authorClient.post("/v1/candidates", { lineage_id: L, parent_gen_id: lineage.gen0, kind: meta.kind, target: meta.target, commitment: patchCommitment(patchHash(patch), salt) }),
      `commit ${name}`,
    );
    await ok(authorClient.post(`/v1/candidates/${c.commit_id}/reveal`, { patch, salt }), `reveal ${name}`);
    return candidateFinal(c.commit_id);
  }
  const dup = await submitStale("perf_encode_dup");
  check("re-skinned copy of an accepted patch rejected as duplicate", dup.status === "rejected" && /duplicate/.test(String(dup.reason)), `${dup.status} ${dup.reason ?? ""}`);
  const s1 = await submitStale("stale_conflict");
  check("stale patch touching changed lines rejected as stale conflict", s1.status === "rejected" && /stale|conflict/.test(String(s1.reason)), `${s1.status} ${s1.reason ?? ""}`);
  const s2 = await submitStale("perf_decode");
  check("stale patch on untouched lines rebased onto the tip and accepted", s2.status === "accepted", `${s2.status} ${s2.reason ?? ""}`);

  // ---------------------------------------------------------------- phase 3b: stacked series (SPEC 12.4) and messages (SPEC 12.3)
  await seriesAndMessages(L);

  // audits of the honest phase settle before the liar exists, so they test honest re-measurement
  const auditsDone = async () => {
    const v = await ok(admin.get(`/v1/lineages/${L}`), "lineage");
    return v.generations.filter((g: any) => g.entry_type === "patch").every((g: any) => g.audit_status && g.audit_status !== "pending");
  };
  await waitFor("honest-phase audits", auditsDone);

  // ---------------------------------------------------------------- phase 3c: measured split (SPEC 12.6) and ports (SPEC 12.7) on a second lineage
  await collabExtras({ core: CORE, admin, as, keys, ok, check, waitFor, candidateFinal, log, L, teamGen, libDiff, DECODE_LOOP, A_LOOP, net });

  // ---------------------------------------------------------------- phase 4: liar, canaries, disputes
  for (const name of ["canary_roundtrip", "canary_equiv", "canary_regress"]) {
    const m = index[name];
    await ok(
      admin.post("/v1/admin/canaries", { lineage_id: L, kind: m.kind, target: m.target, patch: readFileSync(join(PATCHES, `${name}.diff`), "utf8"), expected_reason: m.expect }),
      `canary ${name}`,
    );
  }
  // the liar bonds heavily so it is drawn for nearly every assignment
  await ok(as(keys.liar).post(`/v1/agents/${keys.liar.id}/bond`, { amount: (MIN_BOND * 10n).toString() }), "bond liar");
  startVerifier("liar", ["--dishonest", "fabricate-after-qualify"]);
  const liarQ = await waitFor("liar qualified", async () => {
    const v = await agentView("liar");
    return v.qualified_lineages.includes(L) ? v : null;
  });
  check("the later liar qualifies honestly before it starts fabricating", lastQual(liarQ).status === "passed");
  const before = await ok(admin.get(`/v1/admin/agents/${keys.liar.id}`, true), "liar");
  // triggers: real candidates that should be rejected; each injects one canary (canary_rate 1)
  const triggers = ["break_tests", "regress", "equiv_change"];
  for (const name of triggers) {
    const w = author([name]);
    const id = await w.authorOnce();
    if (id) {
      const f = await candidateFinal(id);
      check(`${name} still rejected with a liar among replayers`, f.status === "rejected", `${f.status} ${f.reason ?? ""}`);
    }
  }
  // canaries are committed and revealed by shadows on later ticks (SPEC 10.5), so wait for them too
  await waitFor("canaries injected and settled", async () => {
    const cs = await ok<any[]>(admin.get(`/v1/candidates?lineage=${L}`), "candidates");
    const canaries = cs.filter((c) => c.author !== keys.author.id);
    return canaries.length >= triggers.length && cs.every((c) => FINAL.has(c.status));
  });
  {
    // shadow parity (SPEC 10.7): shadows file intents on their canary's target at the rate real authors do
    const cs = await ok<any[]>(admin.get(`/v1/candidates?lineage=${L}&limit=1000`, true), "candidates");
    const canaries = cs.filter((c) => c.author !== keys.author.id && c.author !== keys.author2.id);
    const its = await ok<any[]>(admin.get(`/v1/intents?lineage=${L}&status=all&limit=1000`, true), "intents");
    const linked = canaries.map((c) => its.find((i) => i.agent === c.author && i.candidate?.commit_id === c.commit_id)).filter(Boolean);
    const ok2 = linked.every((i: any) => i.created_at < canaries.find((c) => c.commit_id === i.candidate.commit_id).committed_at);
    check("shadow intents precede their canary's commit and link to it like a real author's", ok2, `${linked.length} of ${canaries.length} canaries preceded by a shadow intent`);
  }
  const after = await ok(admin.get(`/v1/admin/agents/${keys.liar.id}`, true), "liar");
  const slashed = BigInt(after.slashed_total) - BigInt(before.slashed_total);
  check("fabricating verifier slashed and struck", slashed > 0n && after.strikes_total > 0, `slashed ${slashed}, strikes ${after.strikes_total}`);
  const honest = await Promise.all((["v1", "v2", "v3", "v4"] as const).map((n) => ok(admin.get(`/v1/agents/${keys[n].id}`), n)));
  check("no honest verifier slashed", honest.every((h) => h.slashed_total === "0"), honest.map((h) => h.slashed_total).join(","));
  const events = await ok<any>(admin.get("/v1/events/log?since=0&limit=5000"), "events");
  const evs: any[] = Array.isArray(events) ? events : events.events ?? [];
  const liarSlashes = evs.filter((e) => e.type === "agent.slashed" && (e.data ?? e.payload ?? e).agent === keys.liar.id).map((e) => (e.data ?? e.payload ?? e).reason);
  check("the fabricating verifier was caught by a canary", liarSlashes.includes("canary"), `slash reasons: ${liarSlashes.join(", ")}`);
  check("the fabricating verifier was caught as a dispute minority", liarSlashes.some((r: string) => /minority/.test(r)), `slash reasons: ${liarSlashes.join(", ")}`);

  // ---------------------------------------------------------------- phase 5: audits, epoch
  const lv = await ok(admin.get(`/v1/lineages/${L}`), "lineage");
  const audited = lv.generations.filter((g: any) => g.entry_type === "patch");
  await waitFor("audits", async () => {
    const v = await ok(admin.get(`/v1/lineages/${L}`), "lineage");
    return v.generations.filter((g: any) => g.entry_type === "patch").every((g: any) => g.audit_status && g.audit_status !== "pending" && g.audit_status !== "running");
  });
  const lv2 = await ok(admin.get(`/v1/lineages/${L}`), "lineage");
  const statuses = lv2.generations.filter((g: any) => g.entry_type === "patch").map((g: any) => g.audit_status);
  const details = await Promise.all(
    lv2.generations.filter((g: any) => g.entry_type === "patch").map(async (g: any) => (await ok(admin.get(`/v1/generations/${g.gen_id}`), "generation")).audit?.detail ?? ""),
  );
  check("audit replays agree with every accepted generation", statuses.length === audited.length && statuses.every((s: string) => s === "agreed"), `${statuses.join(",")} | ${details.join(" | ")}`.slice(0, 400));
  check("lineage height is 5 (encode, fix, decode, then the stacked series A and B)", lv2.height === 5, `height ${lv2.height}`);
  const tg = await ok(admin.get(`/v1/generations/${teamGen}`), "team generation");
  const drawnForTeam = (tg.replays as any[]).map((r) => r.replayer);
  check(
    "no team member (nor the reviewer's operator group) was drawn to replay or audit the team candidate",
    drawnForTeam.length >= 3 && !drawnForTeam.includes(keys.author.id) && !drawnForTeam.includes(keys.v5.id) && tg.team?.members?.length === 2,
    `${drawnForTeam.length} replays and audit replays`,
  );

  await ok(admin.post("/v1/admin/creator-rewards", { amount: (10n ** 12n).toString() }), "creator rewards");
  const closed = await ok(admin.post("/v1/admin/epochs/close", {}), "close epoch");
  const ep = await ok(admin.get(`/v1/epochs/${closed.n ?? 0}`), "epoch");
  check("epoch closed with a payout root", !!ep.root && Array.isArray(ep.payouts) && ep.payouts.length > 0, `${ep.payouts?.length ?? 0} payouts`);
  const rec2 = await ok(admin.get("/v1/ledger/reconcile"), "reconcile");
  check("ledger reconciles to zero with no negative balances", rec2.ok === true || rec2.balanced === true, JSON.stringify(rec2).slice(0, 160));
  const v1Proof = await admin.get(`/v1/epochs/${ep.n}/proofs/${keys.v1.id}`);
  if (v1Proof.status === 200 && Array.isArray(v1Proof.body) && v1Proof.body.length) {
    const leaf = v1Proof.body[0];
    const claim = await as(keys.v1).post(`/v1/epochs/${ep.n}/claim`, { dest: leaf.dest, amount: leaf.amount, proof: leaf.proof });
    check("verifier claims its epoch payout with a Merkle proof", claim.status < 300, JSON.stringify(claim.body).slice(0, 160));
    const forged = await as(keys.v2).post(`/v1/epochs/${ep.n}/claim`, { dest: leaf.dest, amount: leaf.amount, proof: leaf.proof });
    check("another agent cannot claim that leaf", forged.status >= 400, `${forged.status}`);
    const twice = await as(keys.v1).post(`/v1/epochs/${ep.n}/claim`, { dest: leaf.dest, amount: leaf.amount, proof: leaf.proof });
    check("a leaf cannot be claimed twice", twice.status >= 400, `${twice.status}`);
  } else check("verifier claims its epoch payout with a Merkle proof", false, `proof ${v1Proof.status}`);
  const ver = Bun.spawnSync(["bun", join(ROOT, "scripts/verify.ts"), "--core", CORE]);
  const vout = ver.stdout.toString().trim().split("\n");
  check("every verdict independently recomputed from public data (scripts/verify.ts)", ver.exitCode === 0, vout.at(-1) ?? ver.stderr.toString().slice(0, 200));
  if (ver.exitCode !== 0) for (const l of vout) if (l.startsWith("FAIL")) log(`   ${l}`);
  const pools = (ep.assignment_rounds ?? []) as any[];
  const inPool = (id: string) => pools.some((r) => (r.pool as any[]).some((p) => p.agent === id) || (r.chosen as string[]).includes(id));
  check("unqualified verifiers (fabricated qualification, wrong arch) never enter an assignment draw", pools.length > 0 && !inPool(keys.faker.id) && !inPool(keys.wrongarch.id), `${pools.length} rounds`);
  const canaryList = ep.canaries ?? [];
  check("canary list revealed at epoch close", Array.isArray(canaryList) && canaryList.length > 0, `${canaryList.length} canaries`);
}

// ---------------------------------------------------------------- stacked series and messages
// Two real improvements to decode on the fixture, written against the tip at run time:
//   A: base 2^32 limbs instead of bytes in decode's inner loop;
//   B: two base58 digits per pass of that loop. B's diff context is A's code, so B applies only on A.
// A_bad is A multiplying by 57 instead of 58 (breaks tests); B_bad is B written on A_bad, so it
// removes A_bad's lines and applies to nothing else.
const DECODE_LOOP = `    let mut bytes: Vec<u8> = Vec::new();
    for (index, c) in input.bytes().enumerate() {
        let value = digit_value(c).ok_or(DecodeError::InvalidCharacter { character: c as char, index })?;
        let mut carry = value as u32;
        for b in bytes.iter_mut() {
            carry += (*b as u32) * 58;
            *b = (carry & 0xff) as u8;
            carry >>= 8;
        }
        while carry > 0 {
            bytes.push((carry & 0xff) as u8);
            carry >>= 8;
        }
    }
`;
const A_CHARS = `    for (index, c) in input.bytes().enumerate() {
        let value = digit_value(c).ok_or(DecodeError::InvalidCharacter { character: c as char, index })?;
        let mut carry = value as u64;
        for l in limbs.iter_mut() {
            carry += (*l as u64) * 58;
            *l = carry as u32;
            carry >>= 32;
        }
        if carry > 0 {
            limbs.push(carry as u32);
        }
    }
`;
const A_LOOP = `    let mut limbs: Vec<u32> = Vec::with_capacity(input.len() / 5 + 1);
${A_CHARS}    let mut bytes: Vec<u8> = Vec::with_capacity(limbs.len() * 4 + input.len());
    for l in &limbs {
        bytes.extend_from_slice(&l.to_le_bytes());
    }
    while bytes.last() == Some(&0) {
        bytes.pop();
    }
`;
const B_CHARS = `    let digits = input.as_bytes();
    let mut i = 0;
    while i < digits.len() {
        let hi = digit_value(digits[i]).ok_or(DecodeError::InvalidCharacter { character: digits[i] as char, index: i })?;
        let (value, scale) = if i + 1 < digits.len() {
            let lo = digit_value(digits[i + 1]).ok_or(DecodeError::InvalidCharacter { character: digits[i + 1] as char, index: i + 1 })?;
            (hi as u64 * 58 + lo as u64, 58 * 58)
        } else {
            (hi as u64, 58)
        };
        let mut carry = value;
        for l in limbs.iter_mut() {
            carry += (*l as u64) * scale;
            *l = carry as u32;
            carry >>= 32;
        }
        if carry > 0 {
            limbs.push(carry as u32);
        }
        i += 2;
    }
`;

/** Canonical diff of src/lib.rs from `before` to `after` (a throwaway git repo, like an author's tree). */
function libDiff(before: string, after: string): string {
  const d = mkdtempSync(join(tmpdir(), "lineage-e2e-diff-"));
  const g = (args: string[]) => Bun.spawnSync(["git", "-c", "user.name=e2e", "-c", "user.email=e2e@lineage", ...args], { cwd: d });
  g(["init", "-q"]);
  Bun.spawnSync(["mkdir", "-p", join(d, "src")]);
  writeFileSync(join(d, "src/lib.rs"), before);
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "base"]);
  writeFileSync(join(d, "src/lib.rs"), after);
  const out = g(["diff", "--no-color", "-U3", "--full-index"]).stdout.toString();
  rmSync(d, { recursive: true, force: true });
  return canonicalizeDiff(out);
}

async function seriesAndMessages(L: string) {
  const authorC = as(keys.author);
  const tip0 = (await ok(admin.get(`/v1/lineages/${L}`), "lineage")).tip as string;
  const file = await ok(admin.get(`/v1/lineages/${L}/file?gen=${tip0}&path=src/lib.rs`), "tip file");
  const text = String(file.text ?? "");
  if (!text.includes(DECODE_LOOP)) {
    check("stacked series: the tip's decode loop is the one the series patches expect", false, "decode loop not found at the tip");
    return;
  }
  const textA = text.replace(DECODE_LOOP, A_LOOP);
  const A_CHARS_BAD = A_CHARS.replace("carry += (*l as u64) * 58;", "carry += (*l as u64) * 57;");
  const textAbad = textA.replace(A_CHARS, A_CHARS_BAD);
  const dA = libDiff(text, textA);
  const dB = libDiff(textA, textA.replace(A_CHARS, B_CHARS));
  const dAbad = libDiff(text, textAbad);
  const dBbad = libDiff(textAbad, textAbad.replace(A_CHARS_BAD, B_CHARS));

  // ---- A_bad fails: B_bad, built on it, cannot reveal first, waits, then fails with it
  const commitRaw = async (patch: string, dependsOn?: string) => {
    const salt = H("series-salt", patch, String(Date.now()));
    const c = await ok(
      authorC.post("/v1/candidates", { lineage_id: L, parent_gen_id: tip0, kind: "perf", target: "decode_ir", commitment: patchCommitment(patchHash(patch), salt), ...(dependsOn ? { depends_on: dependsOn } : {}) }),
      "commit series candidate",
    );
    return { commit_id: c.commit_id as string, patch, salt };
  };
  const aBad = await commitRaw(dAbad);
  const bBad = await commitRaw(dBbad, aBad.commit_id);
  const early = await authorC.post(`/v1/candidates/${bBad.commit_id}/reveal`, { patch: bBad.patch, salt: bBad.salt });
  check("a stacked candidate cannot reveal before the candidate it depends on (its diff context would leak it)", early.status === 409 && early.body.error === "dependency_unrevealed", `${early.status} ${early.body?.error}`);
  await ok(authorC.post(`/v1/candidates/${aBad.commit_id}/reveal`, { patch: aBad.patch, salt: aBad.salt }), "reveal A_bad");
  const wb = await ok(authorC.post(`/v1/candidates/${bBad.commit_id}/reveal`, { patch: bBad.patch, salt: bBad.salt }), "reveal B_bad");
  const pubWaiting = await ok(admin.get(`/v1/candidates/${bBad.commit_id}`), "public B_bad");
  check(
    "after its dependency reveals, the stacked candidate reveals and waits; the public view names no author and no link",
    wb.status === "waiting" && wb.series?.depends_on === aBad.commit_id && pubWaiting.status === "waiting" && pubWaiting.author === null && pubWaiting.series === null,
    `${wb.status}, public ${pubWaiting.status} author ${pubWaiting.author} series ${JSON.stringify(pubWaiting.series)}`,
  );
  const fAbad = await candidateFinal(aBad.commit_id);
  const fBbad = await candidateFinal(bBad.commit_id);
  check("A_bad rejected (tests fail); B_bad, queued alone on the tip, fails as dependency_failed", fAbad.status === "rejected" && fBbad.status === "rejected" && fBbad.reason === "dependency_failed", `A_bad ${fAbad.reason}, B_bad ${fBbad.status} ${fBbad.reason}`);

  // ---- the worker stacks B on its own pending A; A accepted, B measured on the tip that includes A
  const dir = mkdtempSync(join(tmpdir(), "lineage-e2e-series-"));
  writeFileSync(join(dir, "index.json"), JSON.stringify({ series_a: { kind: "perf", target: "decode_ir" }, series_b: { kind: "perf", target: "decode_ir" } }));
  writeFileSync(join(dir, "series_a.diff"), dA);
  writeFileSync(join(dir, "series_b.diff"), dB);
  const w = new Worker({ core: CORE, key: keys.author, proposer: new ScriptedProposer(loadScript(dir, ["series_a", "series_b"])), lineages: [L], series: true, log: (m) => console.log(`   ser  ${m}`) });
  const idA = await w.authorOnce();
  if (!idA) throw new Error("series worker did not submit A");
  const idB = await w.authorOnce();
  if (!idB) throw new Error("series worker did not submit B on top of A");
  const mineB = await ok(authorC.get(`/v1/candidates/${idB}`, true), "B");
  const mineA = await ok(authorC.get(`/v1/candidates/${idA}`, true), "A");
  check("the --series worker commits B on top of its own pending A, and B waits", mineB.series?.depends_on === idA && (mineB.status === "waiting" || FINAL.has(mineA.status)), `B ${mineB.status}, depends_on ${String(mineB.series?.depends_on).slice(0, 10)}`);

  // ---- messages while A is replaying (SPEC 12.3)
  const VS = ["v1", "v2", "v3", "v4", "v5"] as const;
  const replayersOfA = async () => {
    const out: (typeof VS)[number][] = [];
    for (const n of VS) {
      const r = await as(keys[n]).get("/v1/assignments", true);
      if (r.status === 200 && (r.body as any[]).some((x) => x.candidate?.candidate_id === mineA.candidate_id)) out.push(n);
    }
    return out;
  };
  let busyA: (typeof VS)[number][] = [];
  const replayingA = await waitFor("a replayer of A", async () => {
    busyA = await replayersOfA();
    if (busyA.length) return busyA[0]!;
    const a = await ok(admin.get(`/v1/candidates/${idA}`), "A");
    return FINAL.has(a.status) ? "none" : null;
  }, 120_000);
  const send = (from: AgentKey, to: string, o: { body?: string; sealTo?: string; ref?: { kind: string; id: string } } = {}) => {
    const env = messageEnvelope({
      from: from.id,
      to,
      ref: o.ref ?? null,
      body: o.sealTo ? null : (o.body ?? "hello"),
      ciphertext: o.sealTo ? seal(o.body ?? "hello", o.sealTo) : null,
      enc_key: o.sealTo ?? null,
      sent_at: Date.now(),
      nonce: H("e2e-msg", from.id, to, String(Math.random())).slice(0, 32),
    });
    return as(from).post("/v1/messages", { envelope: env, sig: signStatement(from, "msg", env) });
  };
  if (replayingA !== "none") {
    const r = await send(keys[replayingA], keys.author.id, { body: "about your candidate" });
    check("replay firewall: a verifier replaying A cannot message A's author (403 replaying, to it alone)", r.status === 403 && r.body.error === "replaying", `${replayingA}: ${r.status} ${r.body?.error}`);
    const other = VS.find((n) => !busyA.includes(n))!;
    const toAuthor = await send(keys[other], keys.author.id);
    const toAuthor2 = await send(keys[other], keys.author2.id);
    check(
      "a non-replayer gets the same answer whether or not its recipient authors an open candidate",
      toAuthor.status === toAuthor2.status && toAuthor.body?.error === toAuthor2.body?.error,
      `${toAuthor.status} ${toAuthor.body?.error ?? ""} | ${toAuthor2.status} ${toAuthor2.body?.error ?? ""}`,
    );
  } else check("replay firewall: a verifier replaying A cannot message A's author (403 replaying, to it alone)", false, "A was final before a replayer was seen");
  // sealed direct message between the two authors of the repository (the worker published the author's key)
  const authorKey = await ok(admin.get(`/v1/agents/${keys.author.id}/encryption-key`), "author encryption key");
  const secret = "B builds on the limb loop; leave decode to me";
  const dm = await send(keys.author2, keys.author.id, { body: secret, sealTo: authorKey.encryption_key });
  const inbox = await w.readInbox();
  const mine2 = await ok(as(keys.author2).get("/v1/messages", true), "author2 messages");
  const stored = mine2.sent.find((m: any) => m.msg_id === dm.body?.msg_id);
  check(
    "a sealed direct message round trips: only the recipient opens it, Core holds ciphertext",
    dm.status === 200 && inbox.some((m) => m.from === keys.author2.id && m.sealed && m.body === secret) && !!stored && stored.envelope.body === null && !JSON.stringify(stored).includes("limb loop"),
    `${dm.status}, inbox ${inbox.length}`,
  );
  const k2 = deriveEncryptionKey(keys.author2);
  await ok(as(keys.author2).put(`/v1/agents/${keys.author2.id}/encryption-key`, { encryption_key: k2.public, seq: 1, sig: signStatement(keys.author2, "msgkey", encryptionKeyStatement({ agent: keys.author2.id, encryption_key: k2.public, seq: 1 })) }), "author2 key");
  const board = await ok(admin.get(`/v1/lineages/${L}/board?limit=1000`), "board");
  const notes = (board.messages as any[]).filter((m) => m.from === keys.author.id && m.envelope.ref?.kind === "intent");
  check("the advisory worker posts a public board note for each intent it files", notes.length > 0 && notes.every((m) => /^intent: /.test(m.envelope.body)), `${notes.length} notes on the board`);
  const refOpen = await send(keys.author, `board:${L}`, { ref: { kind: "candidate", id: idB } });
  check("a board message cannot reference an open candidate (it would name its author)", refOpen.status === 409 && refOpen.body.error === "candidate_open", `${refOpen.status} ${refOpen.body?.error}`);

  const fA = await candidateFinal(idA);
  const fB = await candidateFinal(idB);
  log(`series A: ${fA.status}${fA.reason ? ` (${fA.reason})` : ""}; B: ${fB.status}${fB.reason ? ` (${fB.reason})` : ""}`);
  check("series A (limbs) accepted", fA.status === "accepted", fA.effect ? `ratio ${fA.effect.ratio}` : `${fA.reason ?? ""} ${fA.detail ?? ""}`);
  const gB = fB.gen_id ? await ok(admin.get(`/v1/generations/${fB.gen_id}`), "B generation") : null;
  check(
    "B, held until A was final, is measured on the tip that includes A and accepted with its original commit time",
    fB.status === "accepted" && fB.series?.outcome === "on_tip" && fB.eval_parent_gen_id === fA.gen_id && gB?.parent_gen_id === fA.gen_id && fB.committed_at === mineB.committed_at && fB.committed_at < fA.finalized_at,
    `${fB.status} ${fB.reason ?? ""}, eval parent ${String(fB.eval_parent_gen_id).slice(0, 10)}, A gen ${String(fA.gen_id).slice(0, 10)}${fB.effect ? `, ratio ${fB.effect.ratio}` : ""}`,
  );
  check("once both are final the series link is public", fB.series?.depends_on === idA && (await ok(admin.get(`/v1/candidates/${idA}`), "A")).series?.dependents?.includes(idB));
  const evs = await ok<any[]>(admin.get("/v1/events/log?since=0&limit=5000"), "events");
  const unitsB = evs.filter((x) => x.type === "units.awarded" && x.data.kind === "author" && x.data.ref === fB.gen_id).map((x) => x.data.agent);
  check("B's author units go to B's own author", unitsB.length === 1 && unitsB[0] === keys.author.id, unitsB.join(","));
  rmSync(dir, { recursive: true, force: true });
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  log(`ERROR ${(e as Error).stack ?? e}`);
} finally {
  for (const p of procs) p.kill();
  const bad = results.filter((r) => !r.ok);
  log(`${results.length - bad.length}/${results.length} checks passed in ${((Date.now() - T0) / 1000).toFixed(0)}s`);
  writeFileSync(join(ROOT, "docs", "E2E-LAST.json"), JSON.stringify({ at: new Date().toISOString(), seconds: Math.round((Date.now() - T0) / 1000), results }, null, 2) + "\n");
  if (!KEEP) {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(EXTRA_RECIPES, { recursive: true, force: true });
  } else {
    log(`kept ${tmp}`);
    // the second lineage's recipe lives here; replay.ts finds it with LINEAGE_RECIPES_EXTRA
    log(`kept recipes ${EXTRA_RECIPES} (LINEAGE_RECIPES_EXTRA=${EXTRA_RECIPES} bun scripts/replay.ts ...)`);
  }
  process.exit(failed || bad.length ? 1 : 0);
}
