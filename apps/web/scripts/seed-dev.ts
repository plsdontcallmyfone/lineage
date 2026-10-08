// Dev seed for the dashboard. Starts its own Core (in process, real Core class and HTTP API) on a
// temp data dir and drives it ONLY through the public HTTP API with signed requests: launches,
// verifier registration and bonds, calibrations, candidate commit-reveal, replay commit-reveal with
// synthetic ReplayResults, canaries, epoch close. Every number the dashboard then shows is computed
// by Core's own logic from those inputs. Replay results here are synthetic test inputs, not real
// sandbox runs; the dashboard has no way to tell and does not need to.
//
//   bun apps/web/scripts/seed-dev.ts [--port 9664] [--live] [--data <dir>]
//
// --live keeps submitting candidates every ~20 s so the event feed moves.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Core, CoreClient, parseNetworkConfig, serve, systemClock } from "../../../packages/core/src/index.ts";
import {
  calibId,
  canonicalizeDiff,
  generateAgentKey,
  patchCommitment,
  patchHash,
  recipeId,
  repoId,
  resultCommitment,
  sha256Hex,
  signMessage,
  signStatement,
  snapshotId,
  type AgentKey,
  type Calibration,
  type Recipe,
  type ReplayResult,
} from "../../../packages/core/src/protocol.ts";
import { loadRecipe } from "../../../packages/sandbox/src/recipe.ts";

const ROOT = join(import.meta.dir, "../../..");
const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const PORT = Number(arg("port", "9664"));
const LIVE = process.argv.includes("--live");
if (PORT < 9662 || PORT > 9669) throw new Error("use a test port in 9662-9669");
try {
  const busy = execFileSync("lsof", ["-ti", `:${PORT}`], { encoding: "utf8" }).trim();
  if (busy) {
    console.error(`port ${PORT} is in use by pid ${busy}; not binding`);
    process.exit(1);
  }
} catch {
  /* lsof exits 1 when nothing listens */
}

const dataDir = arg("data") ?? mkdtempSync(join(tmpdir(), "lineage-web-seed-"));
const raw = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
// candidates of the scripted scenario stay open while canaries are injected on later ticks, so the cap is raised
const cfg = parseNetworkConfig({ ...raw, canary_rate: 1, audit_rate: 1, bootstrap_resamples: 2000, max_open_candidates_per_agent: 20 });
const adminKey = generateAgentKey();
const core = new Core({ dataDir, network: cfg, adminId: adminKey.id, clock: systemClock });
const server = serve(core, { port: PORT });
const tick = setInterval(() => {
  try {
    core.tick();
  } catch (e) {
    console.error("tick", e);
  }
}, 1000);
const BASE = `http://127.0.0.1:${server.port}`;
console.log(`seed core on ${BASE} (data ${dataDir}, pid ${process.pid})`);

// ------------------------------------------------------------------------------------------------
// clients

interface A {
  key: AgentKey;
  id: string;
  c: CoreClient;
  name: string;
}
const mk = (name: string, key = generateAgentKey()): A => ({ key, id: key.id, c: new CoreClient(BASE, key), name });
const admin = mk("admin", adminKey);
const anon = new CoreClient(BASE, null);

async function ok<T = any>(p: Promise<{ status: number; body: any }>, what = ""): Promise<T> {
  const r = await p;
  if (r.status >= 300) throw new Error(`${what} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as T;
}

const big = (n: number | bigint) => BigInt(n);
const UNIT = 10n ** BigInt(cfg.token_decimals);

async function verifier(name: string, bond: bigint, operator?: string): Promise<A> {
  const a = mk(name);
  await ok(admin.c.post("/v1/admin/faucet", { agent: a.id, amount: (cfg.register_burn + bond + 3n * UNIT).toString() }), "faucet");
  await ok(a.c.post("/v1/agents", operator ? { operator } : {}), "register");
  if (bond > 0n) await ok(a.c.post(`/v1/agents/${a.id}/bond`, { amount: bond.toString() }), "bond");
  return a;
}

async function launch(name: string, repo: string, hosted: boolean, fees: bigint, mode = "app"): Promise<A> {
  const a = mk(name);
  await ok(
    admin.c.post("/v1/admin/launches", { agent: a.id, mint: generateAgentKey().id, launcher: generateAgentKey().id, target_repo: repo, hosted, identity_mode: mode }),
    "launch",
  );
  if (fees > 0n) await ok(admin.c.post("/v1/admin/agent-fees", { agent: a.id, amount: fees.toString() }), "fees");
  return a;
}

// ------------------------------------------------------------------------------------------------
// lineages

interface Lin {
  id: string;
  gen0: string;
  recipe: Recipe;
  calib: Calibration;
  base: Record<string, number>; // current tip value per deterministic metric (synthetic input)
  fixed: Set<string>;
}

async function lineage(ref: A, recipe: Recipe, deps: string, calib: Omit<Calibration, "recipe_id" | "snapshot_id">, base: Record<string, number>): Promise<Lin> {
  const rid = recipeId(recipe);
  await ok(admin.c.post("/v1/admin/recipes", { recipe, recipe_id: rid }), "recipe");
  await ok(admin.c.post("/v1/admin/snapshots", { repo: recipe.repo, commit: recipe.commit, deps_digest: deps }), "snapshot");
  const c: Calibration = { ...calib, recipe_id: rid, snapshot_id: snapshotId(repoId(recipe.repo), recipe.commit, deps) };
  const cid = calibId(c.recipe_id, c.snapshot_id, c);
  const l = await ok(ref.c.post("/v1/calibrations", { calibration: c, sig: signMessage(ref.key, cid) }), "calibration");
  return { id: l.lineage_id, gen0: l.gen0, recipe, calib: c, base: { ...base }, fixed: new Set() };
}

// ------------------------------------------------------------------------------------------------
// candidates and replays

type Outcome =
  | { kind: "improve"; metric: string; ratio: number }
  | { kind: "noisy"; metric: string; ratio: number; spread: number }
  | { kind: "fix"; tests: string[] }
  | { kind: "break"; test: string }
  | { kind: "regress"; metric: string; ratio: number }
  | { kind: "equiv" };

interface Spec {
  lin: Lin;
  outcome: Outcome;
  claimed: number;
  conflictOnRebase?: boolean;
  parent: string;
}
const specs = new Map<string, Spec>(); // candidate_id -> what an honest replay measures
const canaryOutcome: Outcome = { kind: "regress", metric: "encode_ir", ratio: 1.07 };
const results = new Map<string, ReplayResult>(); // candidate_id|parent -> honest result (deterministic)

let rngState = 0x9e3779b9;
const rnd = () => {
  rngState ^= rngState << 13;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  return ((rngState >>> 0) % 1_000_000) / 1_000_000;
};

function honestResult(lin: Lin, o: Outcome, asg: any, conflict: boolean): ReplayResult {
  const cal = lin.calib;
  const excluded = new Set([...(lin.recipe.test.exclude ?? []), ...cal.quarantined]);
  // the assignment carries the calibration as seen at the eval parent (fixed tests join the stable set)
  const stable: string[] = asg.calibration?.stable ?? cal.stable;
  const known: string[] = asg.calibration?.known_failures ?? cal.known_failures;
  const metrics: ReplayResult["metrics"] = {};
  for (const m of lin.recipe.metrics) {
    if (!m.deterministic) continue;
    const b = lin.base[m.name];
    if (b === undefined) continue;
    let r = 1;
    if ((o.kind === "improve" || o.kind === "regress") && o.metric === m.name) r = o.ratio;
    metrics[m.name] = { base: [b], cand: [Math.round(b * r)], deterministic: true };
  }
  for (const m of lin.recipe.metrics) {
    if (m.deterministic || lin.base[m.name] === undefined) continue;
    const b = lin.base[m.name]!;
    const ratio = o.kind === "noisy" && o.metric === m.name ? o.ratio : 1;
    const spread = o.kind === "noisy" ? o.spread : 0.03;
    const rounds = m.rounds ?? 10;
    const base = Array.from({ length: rounds }, () => Math.round(b * (1 + (rnd() - 0.5) * 2 * spread)));
    const cand = Array.from({ length: rounds }, () => Math.round(b * ratio * (1 + (rnd() - 0.5) * 2 * spread)));
    metrics[m.name] = { base, cand, deterministic: false };
  }
  let candPass = [...stable];
  let candFail = [...known];
  if (o.kind === "fix") {
    candPass = [...stable, ...o.tests];
    candFail = known.filter((t) => !o.tests.includes(t));
  }
  if (o.kind === "break") {
    candPass = stable.filter((t) => t !== o.test);
    candFail = [...known, o.test];
  }
  void excluded;
  const eq = o.kind === "equiv" ? { base_digest: sha256Hex("equiv-base"), cand_digest: sha256Hex("equiv-cand-truncated") } : { base_digest: sha256Hex("equiv-base"), cand_digest: sha256Hex("equiv-base") };
  return {
    apply: conflict ? "conflict" : "ok",
    guard: "ok",
    build: conflict
      ? { base: "ok", cand: "fail", base_digest: sha256Hex("base-" + asg.parent_gen_id), cand_digest: "" }
      : { base: "ok", cand: "ok", base_digest: sha256Hex("base-" + asg.parent_gen_id), cand_digest: sha256Hex("cand-" + asg.candidate.patch_hash) },
    tests: conflict ? { base_pass: [...stable], cand_pass: [], cand_fail: [] } : { base_pass: [...stable], cand_pass: candPass, cand_fail: candFail },
    equivalence: lin.recipe.equivalence && !conflict ? eq : null,
    metrics: conflict ? {} : metrics,
    env: { image_digest: lin.recipe.image.split("@")[1]!, cpu_model: "seed-dev synthetic", cores: 2, worker_version: "seed-dev" },
    transcript_digest: "0".repeat(64),
  } as ReplayResult;
}

/** A lazy replayer that copies the author's claim instead of running anything. */
function copyClaim(lin: Lin, claimed: number, asg: any): ReplayResult {
  const r = honestResult(lin, { kind: "improve", metric: typeof asg.candidate.target === "string" ? asg.candidate.target : "encode_ir", ratio: 1 - claimed }, asg, false);
  return r;
}

const lins = new Map<string, Lin>();

/** A signed advisory intent (SPEC 12.1) on the lineage's current tip. */
async function intent(lin: Lin, a: A, kind: string, target: string | string[], note: string, ttl_s = 1800) {
  const tip = (await ok(anon.get(`/v1/lineages/${lin.id}`))).tip;
  const st = { v: 1, agent: a.id, lineage_id: lin.id, tip, kind, target, finding_id: null, note, ttl_s };
  return ok(a.c.post("/v1/intents", { lineage_id: lin.id, tip, kind, target, note, ttl_s, sig: signStatement(a.key, "intent", st) }), "intent");
}

async function submit(lin: Lin, author: A, patch: string, kind: string, target: string | string[], outcome: Outcome, claimed: number, opts: { conflictOnRebase?: boolean; reveal?: boolean } = {}) {
  const salt = sha256Hex(Math.random().toString()).slice(0, 32);
  let canonical = patch;
  try {
    canonical = canonicalizeDiff(patch);
  } catch {
    /* malformed patches are rejected by Core at reveal */
  }
  const tip = (await ok(anon.get(`/v1/lineages/${lin.id}`))).tip;
  const c = await ok(
    author.c.post("/v1/candidates", { lineage_id: lin.id, parent_gen_id: tip, kind, target, commitment: patchCommitment(patchHash(canonical), salt), claimed_effect: claimed }),
    "commit",
  );
  if (opts.reveal === false) return c;
  const v = await ok(author.c.post(`/v1/candidates/${c.commit_id}/reveal`, { patch, salt }), "reveal");
  if (v.candidate_id) specs.set(v.candidate_id, { lin, outcome, claimed, conflictOnRebase: opts.conflictOnRebase, parent: tip });
  return v;
}

type Mode = "honest" | "copy-claim" | "accept-all";
const modes = new Map<string, Mode>();

function behave(a: A, asg: any): ReplayResult {
  const cid = asg.candidate.candidate_id;
  const spec = specs.get(cid);
  const mode = modes.get(a.id) ?? "honest";
  const lin = spec?.lin ?? lins.get(asg.lineage.lineage_id)!;
  if (!spec) {
    // a canary (Core injected it; we never submitted this candidate)
    if (mode !== "honest") return copyClaim(lin, 0.06, asg);
    const key = `${cid}|${asg.parent_gen_id}`;
    const o: Outcome = String(asg.candidate.patch).includes("black_box") ? canaryOutcome : { kind: "equiv" };
    if (!results.has(key)) results.set(key, honestResult(lin, o, asg, false));
    return results.get(key)!;
  }
  if (mode === "copy-claim" || mode === "accept-all") {
    if (spec.outcome.kind === "fix") return honestResult(lin, spec.outcome, asg, false);
    return copyClaim(lin, spec.claimed, asg);
  }
  const conflict = !!spec.conflictOnRebase && asg.parent_gen_id !== spec.parent;
  const key = `${cid}|${asg.parent_gen_id}`;
  if (spec.outcome.kind === "noisy") return honestResult(lin, spec.outcome, asg, conflict); // fresh samples each replay
  if (!results.has(key)) results.set(key, honestResult(lin, spec.outcome, asg, conflict));
  return results.get(key)!;
}

let everyone: A[] = [];

async function commitOne(a: A, asg: any) {
  const res = behave(a, asg);
  const log = [
    `lineage seed-dev transcript (synthetic, not a sandbox run)`,
    `replay ${asg.replay_id}`,
    `replayer ${a.id} (${a.name}, ${modes.get(a.id) ?? "honest"})`,
    `kind ${asg.kind} candidate ${asg.candidate.candidate_id}`,
    `parent ${asg.parent_gen_id}`,
    `seed ${asg.seed}`,
    `apply ${res.apply} build base=${res.build.base} cand=${res.build.cand}`,
    `tests base_pass=${res.tests.base_pass.length} cand_pass=${res.tests.cand_pass.length} cand_fail=${res.tests.cand_fail.join(",") || "none"}`,
    ...Object.entries(res.metrics).map(([k, m]) => `metric ${k} base=${m.base.join(",")} cand=${m.cand.join(",")}`),
    `equivalence ${res.equivalence ? `${res.equivalence.base_digest} ${res.equivalence.cand_digest}` : "n/a"}`,
    "",
  ].join("\n");
  const bytes = new TextEncoder().encode(log);
  const sha = sha256Hex(bytes);
  await ok(a.c.putBlob(sha, bytes), "blob");
  const full = { ...res, transcript_digest: sha };
  const salt = sha256Hex(Math.random().toString()).slice(0, 32);
  await ok(a.c.post(`/v1/replays/${asg.replay_id}/commit`, { commitment: resultCommitment(full, salt) }), "replay commit");
  return { a, asg, full, salt };
}

/** Drives every open assignment on the network until nothing is outstanding. */
async function drive(opts: { pause?: number; maxRounds?: number; only?: string } = {}) {
  for (let round = 0; round < (opts.maxRounds ?? 20); round++) {
    const pending: Awaited<ReturnType<typeof commitOne>>[] = [];
    let any = false;
    for (const a of everyone) {
      const list = await ok<any[]>(a.c.get("/v1/assignments", true), "assignments");
      for (const asg of list) {
        if (opts.only && asg.candidate.candidate_id !== opts.only) continue;
        any = true;
        if (asg.status === "assigned") pending.push(await commitOne(a, asg));
      }
    }
    if (!any) return;
    if (opts.pause) await Bun.sleep(opts.pause);
    let revealed = 0;
    for (const a of everyone) {
      const list = await ok<any[]>(a.c.get("/v1/assignments", true), "assignments");
      for (const asg of list) {
        if (!asg.reveal_open) continue;
        const p = pending.find((x) => x.asg.replay_id === asg.replay_id) ?? stash.get(asg.replay_id);
        if (!p) continue;
        await ok(a.c.post(`/v1/replays/${asg.replay_id}/reveal`, { result: p.full, salt: p.salt }), "replay reveal");
        stash.delete(asg.replay_id);
        revealed++;
      }
    }
    for (const p of pending) stash.set(p.asg.replay_id, p);
    if (!pending.length && !revealed) return;
  }
}
const stash = new Map<string, Awaited<ReturnType<typeof commitOne>>>();

async function refreshBases(lin: Lin) {
  // after an accepted perf generation the new tip is the measurement base
  const l = await ok(anon.get(`/v1/lineages/${lin.id}`));
  const tip = l.generations.find((g: any) => g.gen_id === l.tip);
  if (!tip || tip.entry_type !== "patch") return;
  const c = await ok(anon.get(`/v1/candidates/${tip.candidate_id}`));
  const counted = c.replays.find((r: any) => r.role === "counted" && r.result);
  if (!counted) return;
  for (const [k, m] of Object.entries(counted.result.metrics as ReplayResult["metrics"])) if (m.deterministic) lin.base[k] = m.cand[0]!;
  if (tip.kind === "fix" && tip.effect?.fixed) for (const t of tip.effect.fixed) lin.fixed.add(t);
}

const patchFile = (n: string) => readFileSync(join(ROOT, "fixtures/b58-patches", `${n}.diff`), "utf8");
function synthPatch(file: string, fn: string, before: string, after: string, at = 40) {
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -${at},3 +${at},3 @@ ${fn}\n     let n = input.len();\n-    ${before}\n+    ${after}\n     n\n`;
}

// ------------------------------------------------------------------------------------------------
// scenario

async function main() {
  const ref = await verifier("reference", 0n);
  await ok(admin.c.post(`/v1/admin/agents/${ref.id}/reference`, { reference: true }));
  const v = [
    await verifier("v-honest-1", cfg.min_bond * 2n, "op-a"),
    await verifier("v-honest-2", cfg.min_bond, "op-b"),
    await verifier("v-honest-3", cfg.min_bond * 3n, "op-c"),
    await verifier("v-lazy", cfg.min_bond * 2n, "op-d"),
  ];
  modes.set(v[3]!.id, "copy-claim");
  everyone = [ref, ...v];

  await ok(admin.c.post("/v1/admin/creator-rewards", { amount: (40n * UNIT).toString() }));

  const fx = loadRecipe(join(ROOT, "recipes/fixture-b58")).recipe;
  const T = (n: string) => `tests/basic.rs::${n}`;
  const fxLin = await lineage(
    ref,
    fx,
    sha256Hex("fixture-b58 deps"),
    {
      runs: 5,
      stable: [T("encode_known_vectors"), T("decode_known_vectors"), T("decode_rejects_invalid"), T("roundtrip_short_inputs")],
      known_failures: [T("decode_leading_ones_are_zero_bytes")],
      quarantined: [],
      metrics: {
        encode_ir: { enabled: true, cv: 0, base_value: 1_284_310 },
        decode_ir: { enabled: true, cv: 0, base_value: 1_502_977 },
        encode_ns: { enabled: true, cv: 0.021 },
        rlib_bytes: { enabled: false, cv: 0.004, reason: "rlib embeds build paths, digest not stable across runs" },
      },
      median_eval_seconds: 140,
    },
    { encode_ir: 1_284_310, decode_ir: 1_502_977, encode_ns: 418_000 },
  );
  lins.set(fxLin.id, fxLin);

  const b58 = loadRecipe(join(ROOT, "recipes/base58-py")).recipe;
  const b58cal = JSON.parse(readFileSync(join(ROOT, "recipes/base58-py/calibration.json"), "utf8"));
  const pyLin = await lineage(
    ref,
    b58,
    b58cal.deps_digest,
    { runs: b58cal.runs, stable: b58cal.stable, known_failures: b58cal.known_failures, quarantined: b58cal.quarantined, metrics: b58cal.metrics, median_eval_seconds: b58cal.median_eval_seconds },
    Object.fromEntries(Object.entries(b58cal.metrics as Record<string, { base_value: number }>).map(([k, m]) => [k, Math.round(m.base_value)])),
  );
  lins.set(pyLin.id, pyLin);

  const a1 = await launch("agent-encode", fx.repo, true, 14n * UNIT);
  const a2 = await launch("agent-fixer", fx.repo, true, 6n * UNIT, "purchased");
  const a3 = await launch("agent-py", b58.repo, false, 3n * UNIT, "token");
  const a4 = await launch("agent-sleepy", b58.repo, true, 3n * UNIT);
  await launch("agent-new-target", "https://github.com/karpathy/minbpe", true, 0n);

  // hosted runtime usage (drains agent-sleepy below the sleep threshold)
  await ok(admin.c.post("/v1/admin/usage", { agent: a1.id, amount: (UNIT / 4n).toString(), model_tokens: 182_400, sandbox_seconds: 1_260 }));
  await ok(admin.c.post("/v1/admin/usage", { agent: a4.id, amount: ((3n * UNIT * 7n) / 10n - UNIT / 2n).toString(), model_tokens: 640_100, sandbox_seconds: 3_900 }));

  // 1. a stale-conflicting candidate committed against gen_0 before perf_encode lands
  const stale = await submit(fxLin, a2, patchFile("stale_conflict"), "perf", "encode_ir", { kind: "improve", metric: "encode_ir", ratio: 0.9 }, 0.1, { conflictOnRebase: true });
  // 2. perf_encode: accepted
  const pe = await submit(fxLin, a1, patchFile("perf_encode"), "perf", "encode_ir", { kind: "improve", metric: "encode_ir", ratio: 0.8143 }, 0.1857);
  await drive({ only: pe.candidate_id });
  await refreshBases(fxLin);
  await drive();
  await refreshBases(fxLin);
  void stale;
  // 3. duplicate of perf_encode (whitespace differs): Core rejects on semantic hash
  await submit(fxLin, a2, patchFile("perf_encode_dup"), "perf", "encode_ir", { kind: "improve", metric: "encode_ir", ratio: 0.8143 }, 0.1857);
  // 4. fix
  await submit(fxLin, a2, patchFile("fix_leading_ones"), "fix", [T("decode_leading_ones_are_zero_bytes")], { kind: "fix", tests: [T("decode_leading_ones_are_zero_bytes")] }, 0);
  await drive();
  await refreshBases(fxLin);
  // 5. test-breaking patch
  await submit(fxLin, a1, patchFile("break_tests"), "perf", "encode_ir", { kind: "break", test: T("roundtrip_short_inputs") }, 0.04);
  // 6. protected path: guard rejects at reveal
  await submit(fxLin, a2, patchFile("protected_test_edit"), "fix", [T("decode_known_vectors")], { kind: "fix", tests: [] }, 0);
  // 7. regression claimed as a win
  await submit(fxLin, a1, patchFile("regress"), "perf", "encode_ir", { kind: "regress", metric: "encode_ir", ratio: 1.031 }, 0.08);
  await drive();
  // 8. equivalence change
  await submit(fxLin, a1, patchFile("equiv_change"), "perf", "encode_ir", { kind: "equiv" }, 0.12);
  await drive();
  // 9. perf_decode: accepted
  await submit(fxLin, a1, patchFile("perf_decode"), "perf", "decode_ir", { kind: "improve", metric: "decode_ir", ratio: 0.7712 }, 0.2288);
  await drive();
  await refreshBases(fxLin);

  // canaries become available; every new candidate now pulls one in
  for (const n of ["canary_regress", "canary_equiv"]) {
    await ok(
      admin.c.post("/v1/admin/canaries", { lineage_id: fxLin.id, kind: "perf", target: "encode_ir", patch: patchFile(n), expected_reason: n === "canary_equiv" ? "equivalence_changed" : "no_improvement" }),
      "canary",
    );
  }
  modes.set(v[3]!.id, "accept-all");
  // 10. noisy wall-clock metric with a bootstrap CI
  await submit(fxLin, a1, synthPatch("src/lib.rs", "pub fn encode(input: &[u8]) -> String {", "let mut digits: Vec<u8> = Vec::new();", "let mut digits: Vec<u8> = Vec::with_capacity(n * 138 / 100 + 1);"), "perf", "encode_ns", { kind: "noisy", metric: "encode_ns", ratio: 0.88, spread: 0.02 }, 0.12);
  await drive();

  // keep submitting regressions dressed as wins until the dishonest replayer has been caught both
  // by a canary and by a dispute (assignment is random, so this takes a variable number of rounds)
  const slashReasons = async () => {
    const evs = await ok<any[]>(anon.get("/v1/events/log?limit=5000"));
    return new Set(evs.filter((e) => e.type === "agent.slashed" && e.data.agent === v[3]!.id).map((e) => e.data.reason as string));
  };
  for (let i = 0; i < 10; i++) {
    const got = await slashReasons();
    if (got.has("canary") && [...got].some((r) => r !== "canary")) break;
    await submit(fxLin, i % 2 ? a2 : a1, synthPatch("src/lib.rs", `fn hot_loop_${i}() {`, `let mut acc = 0u64;`, `let mut acc: u64 = ${i};`, 80 + i * 7), "perf", "decode_ir", { kind: "regress", metric: "decode_ir", ratio: 1.012 }, 0.09);
    await drive();
  }

  // base58-py lineage
  await submit(pyLin, a3, synthPatch("base58/__init__.py", "def b58decode_int(", "decimal = decimal * base + alphabet.index(char)", "decimal = decimal * base + map_[char]"), "perf", "decode_ir", { kind: "improve", metric: "decode_ir", ratio: 0.6231 }, 0.3769);
  await drive();
  await refreshBases(pyLin);
  await submit(pyLin, a3, synthPatch("base58/__init__.py", "def b58encode_int(", "string = alphabet[idx:idx + 1] + string", "string = alphabet[idx:idx + 1]"), "perf", "encode_ir", { kind: "break", test: "test_base58::test_simple_encode" }, 0.3);
  await drive();

  // close epoch 0: units, payouts, Merkle root, canary list and epoch secret become public
  await ok(admin.c.post("/v1/admin/epochs/close"), "close");
  console.log("epoch 0 closed");

  // epoch 1: some work in flight, left unfinished so the dashboard shows open candidates
  modes.set(v[3]!.id, "honest");
  await ok(admin.c.post("/v1/admin/agent-fees", { agent: a1.id, amount: (2n * UNIT).toString() }));
  await submit(pyLin, a3, synthPatch("base58/__init__.py", "def b58encode_check(", "digest = sha256(sha256(v).digest()).digest()", "digest = _dsha(v)"), "perf", "check_ir", { kind: "improve", metric: "check_ir", ratio: 0.9512 }, 0.05);
  await drive();
  await refreshBases(pyLin);
  // intents on the fixture lineage (advisory): one leads to the candidate below, one is just held
  await intent(fxLin, a2, "perf", "decode_ir", "Preallocating the decode buffer from the input length");
  await intent(fxLin, a1, "perf", "encode_ir", "Counting leading zeros with position() instead of take_while");
  await submit(fxLin, a2, synthPatch("src/lib.rs", "pub fn decode(input: &str) -> Result<Vec<u8>, Error> {", "let mut bytes: Vec<u8> = Vec::new();", "let mut bytes: Vec<u8> = Vec::with_capacity(n);"), "perf", "decode_ir", { kind: "improve", metric: "decode_ir", ratio: 0.97 }, 0.03);
  // committed and assigned, replays committed but not revealed
  for (const a of everyone) for (const asg of await ok<any[]>(a.c.get("/v1/assignments", true))) if (asg.status === "assigned") stash.set(asg.replay_id, await commitOne(a, asg));
  await submit(fxLin, a1, synthPatch("src/lib.rs", "pub fn encode(input: &[u8]) -> String {", "let zeros = input.iter().take_while(|&&b| b == 0).count();", "let zeros = input.iter().position(|&b| b != 0).unwrap_or(n);"), "perf", "encode_ir", { kind: "improve", metric: "encode_ir", ratio: 0.99 }, 0.01, { reveal: false });

  console.log("seed scenario done");
  const st = await ok(anon.get("/v1/stats"));
  console.log(JSON.stringify(st));
  const rec = await ok(anon.get("/v1/ledger/reconcile"));
  console.log("ledger reconcile ok:", rec.ok);

  if (LIVE) {
    // the scenario needed a canary on every candidate; the ongoing loop only needs the occasional one
    (core.cfg as { canary_rate: number }).canary_rate = 0.15;
    liveLoop(fxLin, a1).catch((e) => console.error("live loop", e));
  }
}

async function liveLoop(lin: Lin, author: A) {
  let i = 0;
  for (;;) {
    await Bun.sleep(20_000);
    i++;
    const good = i % 3 !== 0;
    try {
      await submit(
        lin,
        author,
        synthPatch("src/lib.rs", `fn live_${i}() {`, `slow_path_${i}(input);`, `fast_path_${i}(input);`, 60 + i),
        "perf",
        "encode_ir",
        good ? { kind: "improve", metric: "encode_ir", ratio: 0.985 } : { kind: "regress", metric: "encode_ir", ratio: 1.004 },
        0.015,
      );
      await drive({ pause: 4000 });
      await refreshBases(lin);
    } catch (e) {
      console.error("live", (e as Error).message);
    }
  }
}

main().catch((e) => {
  console.error(e);
  stop();
});

function stop() {
  clearInterval(tick);
  server.stop(true);
  core.close();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
