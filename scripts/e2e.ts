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
import { generateAgentKey, H, patchCommitment, patchHash, sha256Hex, type AgentKey } from "@lineage/protocol";
import { loadRecipe, prepareDeps } from "@lineage/sandbox";
import { CoreClient } from "../packages/core/src/client.ts";
import { doctor } from "../packages/worker/src/doctor.ts";
import { loadScript, ScriptedProposer, Worker } from "../packages/worker/src/index.ts";

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
  liar: generateAgentKey(),
  faker: generateAgentKey(),
  wrongarch: generateAgentKey(),
  author: generateAgentKey(),
  launcher: generateAgentKey(),
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
  for (const n of ["ref", "v1", "v2", "v3", "v4", "liar", "faker", "wrongarch"] as const) {
    await fund(keys[n], BURN + MIN_BOND * 20n);
    await ok(as(keys[n]).post("/v1/agents", { capabilities: n === "wrongarch" ? wrongCaps : caps }), `register ${n}`);
  }
  await ok(admin.post(`/v1/admin/agents/${keys.ref.id}/reference`, { reference: true }), "mark reference");
  for (const n of ["v1", "v2", "v3", "v4", "faker", "wrongarch"] as const) await ok(as(keys[n]).post(`/v1/agents/${keys[n].id}/bond`, { amount: MIN_BOND.toString() }), `bond ${n}`);

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
  const watch = { samples: 0, sealedSeen: 0, violations: [] as string[], phases: new Set<string>(), jobs: new Set<string>(), stop: false };
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

  // ---------------------------------------------------------------- phase 1: accepted generations
  const p1 = await submit("perf_encode");
  check("perf_encode accepted (deterministic instruction count)", p1.status === "accepted", p1.effect ? `ratio ${p1.effect.ratio}` : "");
  const p2 = await submit("fix_leading_ones");
  check("fix_leading_ones accepted (known failure fixed)", p2.status === "accepted");

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
  const replayPhases = [...watch.phases].filter((p) => p.startsWith("replay:")).map((p) => p.slice(7));
  check("heartbeats carry real replay phases from the sandbox", ["build", "test", "metrics"].every((p) => replayPhases.includes(p)), `observed ${[...watch.phases].sort().join(", ")}`);
  const machines = await ok<any[]>(admin.get("/v1/heartbeats"), "heartbeats");
  const beating = ["ref", "v1", "v2", "v3", "v4", "faker"].filter((n) => machines.some((m) => m.agent_id === keys[n as keyof typeof keys].id));
  check("every worker process sends heartbeats with its declared capabilities", beating.length === 6 && machines.filter((m) => beating.some((n) => keys[n as keyof typeof keys].id === m.agent_id)).every((m) => m.caps_match === true), `${beating.join(",")} of ref,v1,v2,v3,v4,faker`);
  const st = await ok(admin.get("/v1/stats"), "stats");
  check("stats count machines awake and verified gains", st.machines_awake >= 6 && st.verified_gains === 2, `awake ${st.machines_awake} of ${st.machines}, gains ${st.verified_gains}`);
  const acts = await ok<any[]>(admin.get(`/v1/activity?agent=${keys.author.id}&limit=1000`), "activity");
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

  // audits of the honest phase settle before the liar exists, so they test honest re-measurement
  const auditsDone = async () => {
    const v = await ok(admin.get(`/v1/lineages/${L}`), "lineage");
    return v.generations.filter((g: any) => g.entry_type === "patch").every((g: any) => g.audit_status && g.audit_status !== "pending");
  };
  await waitFor("honest-phase audits", auditsDone);

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
  check("lineage height is 3 (encode, fix, decode)", lv2.height === 3, `height ${lv2.height}`);

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
  if (!KEEP) rmSync(tmp, { recursive: true, force: true });
  else log(`kept ${tmp}`);
  process.exit(failed || bad.length ? 1 : 0);
}
