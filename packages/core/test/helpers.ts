import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { FakeClock } from "../src/clock.ts";
import { CoreClient } from "../src/client.ts";
import { parseNetworkConfig, type NetworkConfig } from "../src/config.ts";
import { Core } from "../src/core.ts";
import { serve } from "../src/http.ts";
import {
  calibId,
  generateAgentKey,
  patchCommitment,
  patchHash,
  canonicalizeDiff,
  recipeId,
  resultCommitment,
  sha256Hex,
  signMessage,
  snapshotId,
  repoId,
  type AgentKey,
  type Calibration,
  type Recipe,
  type ReplayResult,
} from "../src/protocol.ts";

export const ROOT = join(import.meta.dir, "../../..");

export const RECIPE: Recipe = {
  name: "fx",
  repo: "https://github.com/example/fx",
  commit: "0123456789abcdef0123456789abcdef01234567",
  image: "lineage/fx@sha256:00",
  workdir: "/work/src",
  prepare: [],
  build: { commands: ["make"], reproducible: true },
  test: { command: "make test", parser: "tap", exclude: ["net_test"], timeout_s: 60 },
  equivalence: { command: "make equiv", output: "stdout-digest" },
  metrics: [
    { name: "ir", kind: "perf", direction: "lower", deterministic: true, command: "c", parser: "p", min_effect: 0.01 },
    { name: "ns", kind: "perf", direction: "lower", deterministic: false, command: "c", parser: "p", min_effect: 0.03, rounds: 15 },
    { name: "size", kind: "slim", direction: "lower", deterministic: true, command: "c", parser: "p", min_effect: 0.005 },
  ],
  patch: { allowed_paths: ["src/**"], protected_paths: ["tests/**"], max_files: 5, max_lines: 200 },
  limits: { cpus: 2, memory_mb: 1024, pids: 128, wall_s: 600, disk_mb: 1024 },
};
export const DEPS = "d".repeat(64);
export const SNAP = snapshotId(repoId(RECIPE.repo), RECIPE.commit, DEPS);
export const CALIB: Calibration = {
  recipe_id: recipeId(RECIPE),
  snapshot_id: SNAP,
  runs: 5,
  stable: ["t1", "t2", "t3"],
  known_failures: ["bug1", "bug2"],
  quarantined: ["flaky"],
  metrics: { ir: { enabled: true, cv: 0 }, ns: { enabled: true, cv: 0.02 }, size: { enabled: false, cv: 0, reason: "fixture" } },
  median_eval_seconds: 120,
};

/** A distinct, valid canonical diff per name. */
export function diff(name: string, file = "src/lib.rs", lines = 1): string {
  const minus = Array.from({ length: lines }, (_, i) => `-    slow_${name}_${i}();`).join("\n");
  const plus = Array.from({ length: lines }, (_, i) => `+    fast_${name}_${i}();`).join("\n");
  return canonicalizeDiff(
    `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,${lines + 2} +1,${lines + 2} @@\n fn ${name}() {\n${minus}\n${plus}\n }\n`,
  );
}

export function result(over: Partial<ReplayResult> = {}, irCand = 900): ReplayResult {
  return {
    apply: "ok",
    guard: "ok",
    build: { base: "ok", cand: "ok", base_digest: "bd", cand_digest: "cd" },
    tests: { base_pass: ["t1", "t2", "t3", "net_test"], cand_pass: ["t1", "t2", "t3"], cand_fail: ["bug1", "bug2"] },
    equivalence: { base_digest: "e1", cand_digest: "e1" },
    metrics: { ir: { base: [1000], cand: [irCand], deterministic: true } },
    env: { image_digest: "img", cpu_model: "x", cores: 2, worker_version: "test" },
    transcript_digest: "0".repeat(64),
    ...over,
  };
}

export interface Agent {
  key: AgentKey;
  c: CoreClient;
  id: string;
}

export interface Env {
  core: Core;
  clock: FakeClock;
  server: Server<undefined>;
  base: string;
  admin: Agent;
  anon: CoreClient;
  dir: string;
  cfg: NetworkConfig;
  verifiers: Agent[];
  reference: Agent | null;
  lineage: string;
  gen0: string;
  close(): void;
}

export function testConfig(over: Record<string, unknown> = {}): NetworkConfig {
  const raw = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
  return parseNetworkConfig({ ...raw, canary_rate: 0, audit_rate: 0, bootstrap_resamples: 400, ...over });
}

export function agentClient(env: { base: string; clock: FakeClock }, key = generateAgentKey()): Agent {
  return { key, id: key.id, c: new CoreClient(env.base, key, () => env.clock.now()) };
}

export async function expectOk<T = any>(p: Promise<{ status: number; body: any }>): Promise<T> {
  const r = await p;
  if (r.status >= 300) throw new Error(`expected success, got ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as T;
}

/** Core plus server on an ephemeral port, a fake clock, an admin key and no lineage yet. */
export function bare(over: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lineage-core-test-"));
  const clock = new FakeClock();
  const adminKey = generateAgentKey();
  const cfg = testConfig(over);
  const core = new Core({ dataDir: dir, network: cfg, adminId: adminKey.id, clock });
  const server = serve(core, { port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  const admin = { key: adminKey, id: adminKey.id, c: new CoreClient(base, adminKey, () => clock.now()) };
  return {
    core,
    clock,
    server,
    base,
    admin,
    dir,
    cfg,
    anon: new CoreClient(base, null),
    close() {
      server.stop(true);
      core.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function fund(env: { admin: Agent }, id: string, amount: bigint) {
  return expectOk(env.admin.c.post("/v1/admin/faucet", { agent: id, amount: amount.toString() }));
}

export async function makeVerifier(env: Omit<Env, "verifiers" | "reference" | "lineage" | "gen0"> | Env, opts: { operator?: string; bond?: bigint } = {}): Promise<Agent> {
  const a = agentClient(env);
  const bond = opts.bond ?? env.cfg.min_bond;
  await fund(env, a.id, env.cfg.register_burn + bond);
  await expectOk(a.c.post("/v1/agents", opts.operator ? { operator: opts.operator } : {}));
  if (bond > 0n) await expectOk(a.c.post(`/v1/agents/${a.id}/bond`, { amount: bond.toString() }));
  return a;
}

export async function makeAuthor(env: { admin: Agent; base: string; clock: FakeClock; cfg: NetworkConfig }, opts: { hosted?: boolean; operator?: string; repo?: string; fees?: bigint } = {}): Promise<Agent> {
  const a = agentClient(env);
  await expectOk(
    env.admin.c.post("/v1/admin/launches", {
      agent: a.id,
      mint: generateAgentKey().id,
      launcher: generateAgentKey().id,
      target_repo: opts.repo ?? RECIPE.repo,
      hosted: opts.hosted ?? true,
      identity_mode: "app",
      operator: opts.operator,
    }),
  );
  const fees = opts.fees ?? ((env.cfg.wake_threshold * 10_000n) / BigInt(env.cfg.agent_compute_bps) + 1n);
  if (fees > 0n) await expectOk(env.admin.c.post("/v1/admin/agent-fees", { agent: a.id, amount: fees.toString() }));
  return a;
}

/** Full environment: lineage calibrated by a reference runner and `verifiers` bonded verifiers. */
export async function setup(opts: { verifiers?: number; over?: Record<string, unknown>; reference?: boolean } = {}): Promise<Env> {
  const b = bare(opts.over);
  await expectOk(b.admin.c.post("/v1/admin/recipes", { recipe: RECIPE, recipe_id: recipeId(RECIPE) }));
  await expectOk(b.admin.c.post("/v1/admin/snapshots", { repo: RECIPE.repo, commit: RECIPE.commit, deps_digest: DEPS }));
  const ref = await makeVerifier(b, { bond: 0n });
  await expectOk(b.admin.c.post(`/v1/admin/agents/${ref.id}/reference`, { reference: true }));
  const cid = calibId(CALIB.recipe_id, CALIB.snapshot_id, CALIB);
  const lin = await expectOk(ref.c.post("/v1/calibrations", { calibration: CALIB, sig: signMessage(ref.key, cid) }));
  if (opts.reference === false) await expectOk(b.admin.c.post(`/v1/admin/agents/${ref.id}/reference`, { reference: false }));
  const verifiers: Agent[] = [];
  for (let i = 0; i < (opts.verifiers ?? 4); i++) verifiers.push(await makeVerifier(b));
  return { ...b, verifiers, reference: opts.reference === false ? null : ref, lineage: lin.lineage_id, gen0: lin.gen0 };
}

export interface Submitted {
  commit_id: string;
  candidate_id: string;
  status: string;
  reason: string | null;
  [k: string]: any;
}

export async function submit(
  env: Env,
  author: Agent,
  patch: string,
  o: { kind?: string; target?: string | string[]; parent?: string; salt?: string; claimed_effect?: number } = {},
): Promise<Submitted> {
  const salt = o.salt ?? sha256Hex(Math.random().toString()).slice(0, 32);
  let canonical: string;
  try {
    canonical = canonicalizeDiff(patch);
  } catch {
    canonical = patch;
  }
  const commitment = patchCommitment(patchHash(canonical), salt);
  const c = await expectOk(
    author.c.post("/v1/candidates", {
      lineage_id: env.lineage,
      parent_gen_id: o.parent ?? (await env.anon.get(`/v1/lineages/${env.lineage}`)).body.tip,
      kind: o.kind ?? "perf",
      target: o.target ?? "ir",
      commitment,
      claimed_effect: o.claimed_effect ?? 0.1,
    }),
  );
  return expectOk(author.c.post(`/v1/candidates/${c.commit_id}/reveal`, { patch, salt }));
}

export async function candidate(env: Env, id: string) {
  return expectOk(env.anon.get(`/v1/candidates/${id}`));
}

export function allAgents(env: Env): Agent[] {
  return [...env.verifiers, ...(env.reference ? [env.reference] : [])];
}

export async function assignmentsFor(a: Agent, candidateId?: string): Promise<any[]> {
  const list = await expectOk<any[]>(a.c.get("/v1/assignments", true));
  return candidateId ? list.filter((x) => x.candidate.candidate_id === candidateId) : list;
}

/** Uploads the transcript, binds it into the result and commits. Returns what is needed to reveal. */
export async function commitReplay(a: Agent, asg: any, res: ReplayResult) {
  const bytes = new TextEncoder().encode(`transcript ${asg.replay_id} ${a.id} ${Math.random()}`);
  const sha = sha256Hex(bytes);
  await expectOk(a.c.putBlob(sha, bytes));
  const full = { ...res, transcript_digest: sha };
  const salt = sha256Hex(Math.random().toString()).slice(0, 32);
  await expectOk(a.c.post(`/v1/replays/${asg.replay_id}/commit`, { commitment: resultCommitment(full, salt) }));
  return { a, asg, result: full, salt };
}

export async function revealReplay(x: { a: Agent; asg: any; result: ReplayResult; salt: string }) {
  return expectOk(x.a.c.post(`/v1/replays/${x.asg.replay_id}/reveal`, { result: x.result, salt: x.salt }));
}

export type Behaviour = (agent: Agent, asg: any) => ReplayResult | "skip" | "commit-only";

/**
 * Drives every open assignment of a candidate (and its audits) until nothing is outstanding:
 * all assigned agents commit, then all reveal. Behaviour decides each agent's result.
 */
const committed = new Map<string, Awaited<ReturnType<typeof commitReplay>>>();

export async function runReplays(env: Env, candidateId: string, behave: Behaviour, maxRounds = 10) {
  for (let round = 0; round < maxRounds; round++) {
    let progressed = false;
    for (const a of allAgents(env)) {
      for (const asg of await assignmentsFor(a, candidateId)) {
        if (asg.status !== "assigned") continue;
        const r = behave(a, asg);
        if (r === "skip") continue;
        progressed = true;
        if (r === "commit-only") {
          await commitReplay(a, asg, result());
          continue;
        }
        committed.set(asg.replay_id, await commitReplay(a, asg, r));
      }
    }
    for (const a of allAgents(env)) {
      for (const asg of await assignmentsFor(a, candidateId)) {
        const p = committed.get(asg.replay_id);
        if (asg.reveal_open && p) {
          committed.delete(asg.replay_id);
          await revealReplay(p);
          progressed = true;
        }
      }
    }
    if (!progressed) return;
  }
}

export const honest = (res: ReplayResult = result()): Behaviour => () => res;

export async function balance(env: Env, account: string): Promise<bigint> {
  const b = await expectOk<Record<string, string>>(env.anon.get(`/v1/ledger/balances?prefix=${encodeURIComponent(account)}`));
  return BigInt(b[account] ?? "0");
}

export async function agent(env: Env, id: string) {
  return expectOk(env.anon.get(`/v1/agents/${id}`));
}

export async function reconcileOk(env: Env) {
  const r = await expectOk(env.anon.get("/v1/ledger/reconcile"));
  if (!r.ok) throw new Error("ledger does not reconcile: " + r.errors.join("; "));
  return r;
}
