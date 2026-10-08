#!/usr/bin/env bun
// W9a devnet run: a LOCAL Core in chain mode whose assignment draws use real devnet slot hashes
// (SPEC 10.3, M2). The Core reads the devnet programs (agents, bonds, compute vaults) but holds NO
// Core authority key, so it never posts an epoch or a slash and sends nothing; this script sends
// nothing either (0 SOL). Agents are existing devnet registrations used read-only: the reference
// runner, three bonded verifiers whose capabilities match this machine (wallet-ui-verifier has a
// pending unbond on chain, so it is cooling and never eligible), and the launched TEST author
// agent-base58-py (repo keis/base58), which authors one hand-written candidate.
//
// Checks: draws wait for a finalized slot at or after anchor + lag; the candidate is accepted and
// audited (audit_rate 1), both drawn from slot hashes; after the local epoch close the secret and
// the slot record are published and scripts/verify.ts recomputes every draw and the audit decision,
// and reads each slot back from devnet (block hash, no block between target and slot, block time not
// before the request).
//
// Usage: bun scripts/devnet/beacon-devnet.ts [--port 9665] [--lag 32] [--keep]
import { spawn, spawnSync, type Subprocess } from "bun";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey, type AgentKey } from "@lineage/protocol";
import { loadRecipe, prepareDeps } from "@lineage/sandbox";
import { redactRpc } from "../../packages/chain/src/endpoint.ts";
import { CoreClient } from "../../packages/core/src/client.ts";
import { loadScript, ScriptedProposer, Worker } from "../../packages/worker/src/index.ts";
import { key, KEY_DIR, loadState, reader, ROOT, RPC_URL } from "./lib.ts";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1]! : d);
const PORT = Number(opt("port", "9665"));
const LAG = Number(opt("lag", "32"));
const KEEP = argv.includes("--keep");
const CORE = `http://127.0.0.1:${PORT}`;
const T0 = Date.now();
const log = (m: string) => console.log(`[beacon-devnet +${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ check: name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

if (spawnSync(["lsof", "-ti", `:${PORT}`]).stdout.toString().trim()) {
  console.error(`port ${PORT} busy; pick another in 9662-9669`);
  process.exit(1);
}

const state = loadState();
const tmp = mkdtempSync(join(tmpdir(), "lineage-beacon-devnet-"));
const procs: Subprocess[] = [];
const VERIFIERS = ["verifier-v1", "verifier-v2", "verifier-test"] as const;
const AUTHOR = "agent-base58-py";
const RECIPE = "base58-py";
const PATCH = "encode_chunked";

function startWorker(name: string) {
  const p = spawn(["bun", join(ROOT, "packages/worker/src/main.ts"), "run", "--core", CORE, "--key", join(KEY_DIR, `${name}.json`), "--interval", "1500"],
    { stdout: "pipe", stderr: "pipe", env: process.env });
  for (const s of [p.stdout, p.stderr])
    (async () => {
      for await (const c of s) for (const l of new TextDecoder().decode(c).split("\n")) if (l.trim()) console.log(`   ${name.slice(0, 10).padEnd(10)} ${l}`);
    })();
  procs.push(p);
}
async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 1_200_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v as T;
    await Bun.sleep(2000);
  }
  throw new Error(`timed out waiting for ${what}`);
}
async function ok<T = any>(p: Promise<{ status: number; body: T }>, what: string): Promise<T> {
  const r = await p;
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

async function main() {
  const reg = (await reader.registryConfig())!;
  log(`rpc ${redactRpc(RPC_URL)}; registry ${state.registry_program}, Core authority on chain ${reg.coreAuthority}, last posted epoch ${reg.lastEpoch}`);
  const admin: AgentKey = generateAgentKey();
  writeFileSync(join(tmp, "admin.json"), JSON.stringify(Array.from(admin.secret)), { mode: 0o600 });
  const net = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
  // one auditor beside the reference runner: the candidate's two replayers may not audit it
  Object.assign(net, { canary_rate: 0, audit_rate: 1, audit_replayers: 1, epoch_length_s: 86400, reveal_window_s: 600, replay_window_min_s: 600, qualify_retry_s: 60 });
  // no core_authority_key: the bridge only reads, so this Core can never post an epoch or a slash
  net.chain = { mode: "devnet", rpc_url: RPC_URL, registry_program: state.registry_program, launch_program: state.launch_program, line_mint: state.line_mint,
    poll_ms: 20_000, beacon_lag_slots: LAG };
  writeFileSync(join(tmp, "network.json"), JSON.stringify(net));
  const core = spawn(["bun", join(ROOT, "packages/core/src/main.ts"), "--data", join(tmp, "data"), "--port", String(PORT), "--config", join(tmp, "network.json"),
    "--admin-key", join(tmp, "admin.json"), "--tick-ms", "500"], { stdout: "inherit", stderr: "inherit" });
  procs.push(core);
  await waitFor("core", async () => (await fetch(`${CORE}/v1/health`).catch(() => null))?.ok);
  const A = new CoreClient(CORE, admin);
  const anon = new CoreClient(CORE, null);
  const chainSync = async (): Promise<any> => {
    for (let i = 0; ; i++) {
      const r = await A.post("/v1/admin/chain/sync", {});
      if (r.status < 300) return r.body;
      if (i >= 8) throw new Error(`chain sync: ${r.status} ${JSON.stringify(r.body)}`);
      log(`chain sync failed (${r.status}); backing off`);
      await Bun.sleep(3000 * 2 ** Math.min(i, 4));
    }
  };
  const view = await chainSync();
  check("local Core in chain mode reads devnet without signing (core_signing false)", view.core_signing === false && view.mode === "devnet", `slot ${view.slot}`);

  const ref = key("verifier-ref");
  const vkeys = VERIFIERS.map((n) => key(n));
  const authorKey = key(AUTHOR);
  for (const [n, k] of [["verifier-ref", ref], ...VERIFIERS.map((n, i) => [n, vkeys[i]!] as const)] as const) {
    const v = await ok(anon.get(`/v1/agents/${k.id}`), n);
    if (v.kind !== "verifier") throw new Error(`${n} is not a mirrored verifier`);
  }
  const a0 = await ok(anon.get(`/v1/agents/${authorKey.id}`), AUTHOR);
  check(`${AUTHOR} mirrored from its AgentLaunch, awake`, a0.kind === "launched" && a0.awake === true, `compute ${a0.compute}`);

  const loaded = loadRecipe(join(ROOT, "recipes", RECIPE));
  const deps = await prepareDeps(loaded);
  await ok(A.post("/v1/admin/recipes", { recipe: loaded.recipe, recipe_id: loaded.recipe_id }), "recipe");
  const snap = await ok(A.post("/v1/admin/snapshots", { repo: loaded.recipe.repo, commit: loaded.recipe.commit, deps_digest: deps.digest }), "snapshot");
  await ok(A.post(`/v1/admin/agents/${ref.id}/reference`, { reference: true }), "reference");
  const refW = new Worker({ core: CORE, key: { id: ref.id, secret: ref.secret }, log: (m) => console.log(`   ref        ${m}`) });
  await refW.declareCapabilities();
  log(`reference runner calibrating ${RECIPE}`);
  await refW.submitCalibration(loaded.recipe_id, snap.snapshot_id, 3);
  const L = (await ok<any[]>(anon.get("/v1/lineages"), "lineages"))[0].lineage_id as string;

  startWorker("verifier-ref");
  for (const n of VERIFIERS) startWorker(n);
  await waitFor("verifiers qualified", async () => {
    const vs = await Promise.all(vkeys.map((k) => ok(anon.get(`/v1/agents/${k.id}`), k.id)));
    return vs.every((v) => v.qualified_lineages.includes(L)) ? vs : null;
  });
  check("three devnet-bonded verifiers qualified", true);

  const w = new Worker({ core: CORE, key: { id: authorKey.id, secret: authorKey.secret }, lineages: [L],
    proposer: new ScriptedProposer(loadScript(join(ROOT, "recipes", RECIPE, "candidates"), [PATCH])), log: (m) => console.log(`   author     ${m}`) });
  const id = await w.authorOnce();
  if (!id) throw new Error("the author did not submit");
  const revealedAt = Date.now();
  const firstAssigned = await waitFor("first assignment", async () => {
    const r = await A.get(`/v1/candidates/${id}`, true);
    return r.status === 200 && (r.body.replays ?? []).length ? Date.now() : null;
  });
  log(`first replay assigned ${((firstAssigned - revealedAt) / 1000).toFixed(1)} s after the reveal (lag ${LAG} slots + finalization)`);
  const final = await waitFor("candidate final", async () => {
    const r = await anon.get(`/v1/candidates/${id}`);
    return r.status === 200 && ["accepted", "rejected", "expired"].includes(r.body.status) ? r.body : null;
  });
  check(`${PATCH} accepted`, final.status === "accepted", `${final.status} ${final.reason ?? ""} ratio ${final.effect?.ratio ?? "-"}`);
  const gen = (await ok(anon.get(`/v1/lineages/${L}`), "lineage")).tip as string;
  const audited = await waitFor("audit resolved", async () => {
    const g = await ok(anon.get(`/v1/generations/${gen}`), "generation");
    const st = g.audit?.status ?? g.audit_status;
    return st && st !== "pending" ? g : null;
  });
  check("the generation was audited (audit_rate 1) and the audit resolved", true, `audit ${audited.audit?.status ?? audited.audit_status}`);

  const n = (await ok(anon.get("/v1/health"), "health")).epoch as number;
  await ok(A.post("/v1/admin/epochs/close", {}), "close");
  const ep = await ok(anon.get(`/v1/epochs/${n}`), "epoch");
  const sb = ep.slot_beacon;
  check("closed epoch publishes its secret and the slot record", !!ep.secret && !!sb && sb.draws.length >= 2 && sb.lag_slots === LAG,
    `${ep.assignment_rounds.length} rounds, ${sb?.draws.length ?? 0} slot draws, ${sb?.decisions.length ?? 0} decisions`);
  check("every assignment round was drawn from a slot hash (bucket -1)", ep.assignment_rounds.length > 0 && ep.assignment_rounds.every((r: any) => r.bucket === -1));
  for (const d of sb?.draws ?? []) log(`draw ${String(d.subject).slice(0, 12)} r${d.round}: anchor ${d.anchor_slot} + ${d.lag_slots} -> target ${d.target_slot}, slot ${d.slot} hash ${d.hash} (block time ${d.block_time}, ${((d.resolved_at - d.requested_at) / 1000).toFixed(1)} s after the request)`);
  const view2 = await chainSync();
  check("nothing was posted: the registry's last epoch is unchanged", BigInt(view2.last_epoch ?? -1) === reg.lastEpoch, `last epoch ${view2.last_epoch}`);

  const ver = spawnSync(["bun", join(ROOT, "scripts/verify.ts"), "--core", CORE, "--chain"], { env: process.env });
  const out = ver.stdout.toString().trim().split("\n");
  for (const l of out) console.log(`   verify     ${l}`);
  const drawLine = out.find((l) => l.startsWith("draws:")) ?? "";
  check("scripts/verify.ts recomputes every verdict and draw and checks each slot on devnet", ver.exitCode === 0 && /slots checked on the cluster/.test(drawLine) && !/FAIL/.test(drawLine), drawLine);

  writeFileSync(join(ROOT, "scripts/devnet/BEACON-DEVNET-LAST.json"), JSON.stringify({ at: new Date().toISOString(), rpc: redactRpc(RPC_URL), lag_slots: LAG,
    candidate: id, epoch: n, beacon_commit: ep.beacon_commit, slot_beacon: sb, verify: out, results }, null, 2) + "\n");
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  console.error(e);
}
for (const p of procs) p.kill(); // by handle (PID), never by pattern
await Bun.sleep(500);
if (!KEEP) rmSync(tmp, { recursive: true, force: true });
else log(`kept ${tmp}`);
const pass = results.filter((r) => r.ok).length;
console.log(`\nbeacon-devnet: ${pass}/${results.length} checks passed${failed ? " (aborted)" : ""}`);
process.exit(failed || pass !== results.length ? 1 : 0);
