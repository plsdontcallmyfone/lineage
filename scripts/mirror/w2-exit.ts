#!/usr/bin/env bun
// W2 exit test (plan FINISH.md W2; SPEC 16), plus the W1 verified-commit and rebuild checks on the
// same run. Owner approval 2026-10-08: test repositories only, every write goes to repositories owned
// by our own pool accounts.
//
//   maintainer  pool account ds56vmr2 (status "reserved" in the pool file) owns three repositories,
//               each described as a Lineage protocol test:
//                 lineage-optin-test   .lineage.yml on main            -> receives exactly one PR
//                 lineage-noopt-test   no opt-in                       -> receives none
//                 lineage-aiban-test   .lineage.yml + CONTRIBUTING.md that bans AI-generated changes -> none
//   agent       pool account owunqwxs, the GitHub identity of the devnet TEST agent 6C8N2z5L... (souls
//               lane provisioning: SSH signing key registered, credential in the runtime-only store).
//               It authors on the opt-in repository; two local agents author on the other two and
//               publish under the same account (a test stand-in), so the only thing that differs
//               between the three repositories is their policy.
//   Core        a local Core on 127.0.0.1:9662 (persistent data dir, so a rerun resumes); replays are
//               synthetic signed results from local verifiers (no sandbox runs), patches are real.
//
// Steps: create the repositories (idempotent) -> calibrate three lineages -> one accepted generation
// each -> mirror cycle (W1: signed commits on owunqwxs's forks, GitHub reports Verified) -> delete the
// opt-in branch and rerun (identical commit) -> PR cycle (Core checks each repository's policy; one PR,
// on the opt-in repository only) -> the maintainer merges it -> Core's scan matches the hunks and
// credits upstream_bonus -> the epoch closes with the bonus in the author's payout leaf.
//
// Tokens are read from the pool file and the credential store programmatically and never printed.
// Results (no secrets) go to scripts/mirror/W2-LAST.json.
//
//   bun scripts/mirror/w2-exit.ts [--state <dir>] [--port 9662]

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CoreClient } from "../../packages/core/src/client.ts";
import { parseNetworkConfig } from "../../packages/core/src/config.ts";
import { Core } from "../../packages/core/src/core.ts";
import { serve } from "../../packages/core/src/http.ts";
import {
  calibId, canonicalizeDiff, generateAgentKey, keyFromSolanaJson, patchCommitment, patchHash, recipeId, repoId, resultCommitment, sha256Hex, signMessage, snapshotId,
  type AgentKey, type Calibration, type Recipe, type ReplayResult,
} from "../../packages/core/src/protocol.ts";
import { upstreamOf } from "../../packages/core/src/upstream.ts";
import { APP_IDENTITY, type CommitIdentity, type Identities } from "../../packages/mirror/src/chain.ts";
import { CoreReader } from "../../packages/mirror/src/coreapi.ts";
import { noreplyEmail } from "../../packages/mirror/src/git.ts";
import { client, deleteBranch } from "../../packages/mirror/src/github.ts";
import { lineageBranch } from "../../packages/mirror/src/message.ts";
import { mirrorOnce } from "../../packages/mirror/src/mirror.ts";
import { prCycle } from "../../packages/mirror/src/prbot.ts";
import { GitHub } from "../../packages/souls/src/github/api.ts";
import { FileCredentialStore } from "../../packages/souls/src/github/credentials.ts";
import { Pool } from "../../packages/souls/src/github/pool.ts";

const ROOT = join(import.meta.dir, "../..");
const arg = (n: string, d?: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const PORT = Number(arg("port", "9662"));
const STATE = arg("state", join(tmpdir(), "lineage-w2-exit"))!;
const LAST = join(import.meta.dir, "W2-LAST.json");
const MAINTAINER = "ds56vmr2";
const TEST_AGENT = "6C8N2z5LwktukWEP6g8sUnf9ky1L9rxyngBLbdomUzHc";
const SITE = "https://157-245-71-188.sslip.io";

if (PORT < 9662 || PORT > 9669) throw new Error("use a test port in 9662-9669");
try {
  const busy = execFileSync("lsof", ["-ti", `:${PORT}`], { encoding: "utf8" }).trim();
  if (busy) throw new Error(`port ${PORT} is in use by pid ${busy}; not binding`);
} catch (e) {
  if ((e as Error).message.startsWith("port")) throw e;
}

const checks: { check: string; ok: boolean; detail: string }[] = [];
const evidence: Record<string, unknown> = {};
const check = (c: string, ok: boolean, detail = "") => {
  checks.push({ check: c, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${c}${detail ? `: ${detail}` : ""}`);
};
const log = (m: string) => console.log(`[w2] ${m}`);
const save = () => writeFileSync(LAST, JSON.stringify({ at: new Date().toISOString(), core: `http://127.0.0.1:${PORT}`, passed: checks.filter((c) => c.ok).length, total: checks.length, checks, evidence }, null, 2) + "\n");

// ------------------------------------------------------------------------------------------------
// accounts (tokens stay in memory)

const maint = new Pool().read().accounts.find((a) => a.login === MAINTAINER);
if (!maint || maint.status !== "reserved") throw new Error(`${MAINTAINER} must be reserved in the pool for this test`);
const mgh = new GitHub({ token: maint.token });
const cred = new FileCredentialStore().get(TEST_AGENT);
if (!cred) throw new Error("the TEST agent has no credential in the runtime store");
const agentIdentity: CommitIdentity = { kind: "account", name: cred.login, email: noreplyEmail(cred.github_id, cred.login), signingKey: cred.ssh_private_key_path, login: cred.login, token: cred.token };

// ------------------------------------------------------------------------------------------------
// 1. test repositories under the maintainer

const CODEC = `"""Lineage protocol test fixture: a tiny hex codec. Not a real project."""


def encode(data: bytes) -> str:
    out = ""
    for b in data:
        out = out + "%02x" % b
    return out


def decode(text: str) -> bytes:
    return bytes(int(text[i:i + 2], 16) for i in range(0, len(text), 2))
`;
const CODEC_FAST = CODEC.replace(`    out = ""\n    for b in data:\n        out = out + "%02x" % b\n    return out\n`, "    return data.hex()\n");
const OPTIN_YML = `# Lineage protocol test repository: this file opts the repository in to Lineage pull requests (SPEC 16).
lineage:
  max_prs_per_week: 2
  kinds: [perf]
  contact: https://github.com/${MAINTAINER}
`;
const readme = (name: string, what: string) => `# ${name}\n\nLineage protocol test repository (upstream policy, plan W2). Not a real project: it exists to test that Lineage agents open pull requests only for repositories that opt in.\n\n${what}\n`;
const REPOS: { name: string; description: string; files: Record<string, string>; expect: string }[] = [
  {
    name: "lineage-optin-test",
    description: "Lineage protocol test repository: opts in with .lineage.yml, so it may receive one PR per accepted generation. Not a real project.",
    files: { "README.md": readme("lineage-optin-test", "This repository opts in with `.lineage.yml`."), "src/codec.py": CODEC, ".lineage.yml": OPTIN_YML },
    expect: "opted_in",
  },
  {
    name: "lineage-noopt-test",
    description: "Lineage protocol test repository: no opt-in, so it must never receive a Lineage PR. Not a real project.",
    files: { "README.md": readme("lineage-noopt-test", "This repository has no `.lineage.yml` and must receive no PR."), "src/codec.py": CODEC },
    expect: "not_opted_in",
  },
  {
    name: "lineage-aiban-test",
    description: "Lineage protocol test repository: its contribution policy bans AI-generated changes, so it must never receive a Lineage PR. Not a real project.",
    files: {
      "README.md": readme("lineage-aiban-test", "This repository has a `.lineage.yml`, but its CONTRIBUTING.md bans AI-generated changes, which blocks the opt-in."),
      "src/codec.py": CODEC,
      ".lineage.yml": OPTIN_YML,
      "CONTRIBUTING.md": "# Contributing\n\nThis is a Lineage protocol test repository.\n\nAI-generated contributions are not accepted here. Pull requests written by AI tools or LLM agents will be closed.\n",
    },
    expect: "ai_banned",
  },
];

async function ensureRepo(r: (typeof REPOS)[number]): Promise<string> {
  const full = `${MAINTAINER}/${r.name}`;
  const have = await mgh.get<any>(`/repos/${full}`, [404]);
  if (!have || have.message) {
    await mgh.request("POST", "/user/repos", { name: r.name, description: r.description, private: false, auto_init: false, has_issues: false, has_wiki: false, has_projects: false });
    log(`created ${full}`);
  }
  for (const [path, body] of Object.entries(r.files)) {
    const f = await mgh.get<any>(`/repos/${full}/contents/${path}`, [404]);
    if (f && f.sha) continue;
    await mgh.request("PUT", `/repos/${full}/contents/${path}`, { message: `Add ${path} (Lineage protocol test fixture)`, content: Buffer.from(body).toString("base64") });
  }
  // head of the default branch (the lineage snapshot): the first commit that has every file
  for (let i = 0; i < 10; i++) {
    const br = await mgh.get<any>(`/repos/${full}/branches/main`, [404]);
    if (br?.commit?.sha) return String(br.commit.sha);
    await Bun.sleep(1500);
  }
  throw new Error(`${full} has no main branch`);
}

// ------------------------------------------------------------------------------------------------
// 2. local Core (persistent state so a rerun resumes)

mkdirSync(STATE, { recursive: true, mode: 0o700 });
const keysFile = join(STATE, "keys.json");
const keys: Record<string, AgentKey> = existsSync(keysFile)
  ? Object.fromEntries(Object.entries(JSON.parse(readFileSync(keysFile, "utf8")) as Record<string, { id: string; secret: string }>).map(([k, v]) => [k, { id: v.id, secret: new Uint8Array(Buffer.from(v.secret, "hex")) } as AgentKey]))
  : {};
const saveKeys = () => writeFileSync(keysFile, JSON.stringify(Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, { id: v.id, secret: Buffer.from(v.secret).toString("hex") }]))), { mode: 0o600 });
const keyOf = (name: string) => (keys[name] ??= generateAgentKey());
const admin = keyOf("admin");
const raw = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
const cfg = parseNetworkConfig({ ...raw, canary_rate: 0, audit_rate: 0, bootstrap_resamples: 400 });
const core = new Core({ dataDir: join(STATE, "core"), network: cfg, adminId: admin.id, clock: { now: () => Date.now() } });
upstreamOf(core).configure({ githubToken: maint.token });
const server = serve(core, { port: PORT });
const BASE = `http://127.0.0.1:${PORT}`;
const tick = setInterval(() => {
  try {
    core.tick();
  } catch (e) {
    console.error("tick", e);
  }
}, 1000);
const cc = (k: AgentKey) => new CoreClient(BASE, k);
const anon = new CoreClient(BASE, null);
const A = cc(admin);
async function ok<T = any>(p: Promise<{ status: number; body: any }>, what: string): Promise<T> {
  const r = await p;
  if (r.status >= 300) throw new Error(`${what} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as T;
}

const DEPS = "d".repeat(64);
const CAPS = { arch: "arm64", cpus: 8, memory_mb: 16384, gpus: [] };
const recipeFor = (name: string, repo: string, commit: string): Recipe => ({
  class: "python", requires: { arch: "arm64" }, name, repo, commit, image: "lineage/python@sha256:00", workdir: "/work/src", prepare: [],
  build: { commands: ["python -c 'import src.codec'"], reproducible: true },
  test: { command: "python -m pytest", parser: "tap", exclude: [], timeout_s: 60 },
  equivalence: { command: "python equiv.py", output: "stdout-digest" },
  metrics: [{ name: "encode_ir", kind: "perf", direction: "lower", deterministic: true, command: "c", parser: "p", min_effect: 0.01 }],
  patch: { allowed_paths: ["src/**"], protected_paths: ["tests/**"], max_files: 5, max_lines: 200 },
  limits: { cpus: 2, memory_mb: 1024, pids: 128, wall_s: 600, disk_mb: 1024 },
} as unknown as Recipe);
const qualifyResult = (): ReplayResult => ({
  apply: "ok", guard: "ok", build: { base: "ok", cand: "skipped", base_digest: "bd" }, tests: { base_pass: ["t1", "t2"], cand_pass: [], cand_fail: [] }, equivalence: null,
  metrics: { encode_ir: { base: [1000], cand: [], deterministic: true } }, env: { image_digest: "img", cpu_model: "w2 synthetic", cores: 2, worker_version: "w2" }, transcript_digest: "0".repeat(64),
});
const candResult = (): ReplayResult => ({
  apply: "ok", guard: "ok", build: { base: "ok", cand: "ok", base_digest: "bd", cand_digest: "cd" }, tests: { base_pass: ["t1", "t2"], cand_pass: ["t1", "t2"], cand_fail: [] },
  equivalence: { base_digest: "e1", cand_digest: "e1" }, metrics: { encode_ir: { base: [1000], cand: [620], deterministic: true } },
  env: { image_digest: "img", cpu_model: "w2 synthetic", cores: 2, worker_version: "w2" }, transcript_digest: "0".repeat(64),
});
const pending = new Map<string, { res: ReplayResult; salt: string }>();
async function commitReplay(k: AgentKey, asg: any, res: ReplayResult) {
  const bytes = new TextEncoder().encode(`w2 synthetic transcript ${asg.replay_id} ${k.id} (signed synthetic result, no sandbox run)\n`);
  const sha = sha256Hex(bytes);
  await ok(cc(k).putBlob(sha, bytes), "blob");
  const full = { ...res, transcript_digest: sha };
  const salt = sha256Hex(Math.random().toString()).slice(0, 32);
  await ok(cc(k).post(`/v1/replays/${asg.replay_id}/commit`, { commitment: resultCommitment(full, salt) }), "replay commit");
  pending.set(asg.replay_id, { res: full, salt });
}
/** Every verifier commits, then reveals, every open assignment (qualifications and candidate replays). */
async function drive(verifiers: AgentKey[], rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    let moved = false;
    for (const v of verifiers) {
      for (const asg of await ok<any[]>(cc(v).get("/v1/assignments", true), "assignments")) {
        if (asg.status === "assigned" && !pending.has(asg.replay_id)) {
          await commitReplay(v, asg, asg.kind === "qualify" || !asg.candidate ? qualifyResult() : candResult());
          moved = true;
        }
      }
    }
    for (const v of verifiers) {
      for (const asg of await ok<any[]>(cc(v).get("/v1/assignments", true), "assignments")) {
        const p = pending.get(asg.replay_id);
        if (asg.reveal_open && p) {
          pending.delete(asg.replay_id);
          await ok(cc(v).post(`/v1/replays/${asg.replay_id}/reveal`, { result: p.res, salt: p.salt }), "reveal");
          moved = true;
        }
      }
    }
    if (!moved) return;
  }
}

function patchFor(): string {
  const d = mkdtempSync(join(tmpdir(), "lineage-w2-diff-"));
  try {
    mkdirSync(join(d, "src"), { recursive: true });
    writeFileSync(join(d, "src/codec.py"), CODEC);
    spawnSync("git", ["init", "-q"], { cwd: d });
    spawnSync("git", ["add", "-A"], { cwd: d });
    writeFileSync(join(d, "src/codec.py"), CODEC_FAST);
    const r = spawnSync("git", ["diff", "--no-color"], { cwd: d, encoding: "utf8" });
    return canonicalizeDiff(r.stdout);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

async function main() {
  // repositories
  const heads: Record<string, string> = {};
  for (const r of REPOS) heads[r.name] = await ensureRepo(r);
  evidence.repos = REPOS.map((r) => ({ url: `https://github.com/${MAINTAINER}/${r.name}`, head: heads[r.name], expect: r.expect }));
  check("three test repositories exist under the maintainer pool account", REPOS.every((r) => /^[0-9a-f]{40}$/.test(heads[r.name]!)), (evidence.repos as any[]).map((x) => x.url).join(", "));

  // lineages, calibrated by a reference runner; three bonded verifiers
  const ref = keyOf("reference");
  const verifiers = [keyOf("v1"), keyOf("v2"), keyOf("v3")];
  saveKeys();
  const lineages: Record<string, string> = {};
  const existing = await ok<any[]>(anon.get("/v1/lineages"), "lineages");
  const refRow = await anon.get(`/v1/agents/${ref.id}`);
  if (refRow.status === 404) {
    await ok(A.post("/v1/admin/faucet", { agent: ref.id, amount: (cfg.register_burn + 1n).toString() }), "faucet");
    await ok(cc(ref).post("/v1/agents", { capabilities: CAPS }), "register reference");
    await ok(A.post(`/v1/admin/agents/${ref.id}/reference`, { reference: true }), "reference");
  }
  for (const r of REPOS) {
    const url = `https://github.com/${MAINTAINER}/${r.name}`;
    const have = existing.find((l) => l.repo === url && l.status === "active");
    if (have) {
      lineages[r.name] = have.lineage_id;
      continue;
    }
    const recipe = recipeFor(r.name, url, heads[r.name]!);
    await ok(A.post("/v1/admin/recipes", { recipe, recipe_id: recipeId(recipe) }), "recipe");
    await ok(A.post("/v1/admin/snapshots", { repo: url, commit: heads[r.name], deps_digest: DEPS }), "snapshot");
    const c: Calibration = {
      recipe_id: recipeId(recipe), snapshot_id: snapshotId(repoId(url), heads[r.name]!, DEPS), runs: 5, stable: ["t1", "t2"], known_failures: [], quarantined: [],
      metrics: { encode_ir: { enabled: true, cv: 0, base_value: 1000 } }, median_eval_seconds: 120, seed: "5".repeat(64),
    } as Calibration;
    const l = await ok(cc(ref).post("/v1/calibrations", { calibration: c, sig: signMessage(ref, calibId(c.recipe_id, c.snapshot_id, c)) }), "calibration");
    lineages[r.name] = l.lineage_id;
  }
  for (const v of verifiers) {
    if ((await anon.get(`/v1/agents/${v.id}`)).status !== 404) continue;
    await ok(A.post("/v1/admin/faucet", { agent: v.id, amount: (cfg.register_burn + cfg.min_bond).toString() }), "faucet");
    await ok(cc(v).post("/v1/agents", { capabilities: CAPS }), "register");
    await ok(cc(v).post(`/v1/agents/${v.id}/bond`, { amount: cfg.min_bond.toString() }), "bond");
  }
  await drive(verifiers);
  evidence.lineages = lineages;

  // authors: the TEST agent (its real devnet signing key) on the opt-in repository, two local agents on the others
  const testKey = keyFromSolanaJson(JSON.parse(readFileSync(join(homedir(), ".config/lineage/devnet/souls-test-agent.json"), "utf8")));
  if (testKey.id !== TEST_AGENT) throw new Error("souls-test-agent key does not match the TEST agent id");
  const authors: Record<string, AgentKey> = { "lineage-optin-test": testKey, "lineage-noopt-test": keyOf("author-noopt"), "lineage-aiban-test": keyOf("author-aiban") };
  saveKeys();
  const fees = (cfg.wake_threshold * 10_000n) / BigInt(cfg.agent_compute_bps) + 1n;
  const gens: Record<string, string> = {};
  const patch = patchFor();
  for (const r of REPOS) {
    const a = authors[r.name]!;
    if ((await anon.get(`/v1/agents/${a.id}`)).status === 404) {
      await ok(A.post("/v1/admin/launches", { agent: a.id, mint: generateAgentKey().id, launcher: generateAgentKey().id, target_repo: `https://github.com/${MAINTAINER}/${r.name}`, hosted: true, identity_mode: "purchased" }), "launch");
      await ok(A.post("/v1/admin/agent-fees", { agent: a.id, amount: fees.toString() }), "fees");
    }
    const lv = await ok<any>(anon.get(`/v1/lineages/${lineages[r.name]}`), "lineage");
    const done = lv.generations.find((g: any) => g.entry_type === "patch" && g.author === a.id);
    if (done) {
      gens[r.name] = done.gen_id;
      continue;
    }
    const salt = sha256Hex(Math.random().toString()).slice(0, 32);
    const c = await ok(cc(a).post("/v1/candidates", { lineage_id: lineages[r.name], parent_gen_id: lv.tip, kind: "perf", target: "encode_ir", commitment: patchCommitment(patchHash(patch), salt), claimed_effect: 0.3 }), "commit");
    const v = await ok(cc(a).post(`/v1/candidates/${c.commit_id}/reveal`, { patch, salt }), "reveal");
    await drive(verifiers);
    const fin = await ok<any>(anon.get(`/v1/candidates/${v.candidate_id}`), "candidate");
    if (fin.status !== "accepted") throw new Error(`candidate on ${r.name} ended ${fin.status} ${fin.reason}`);
    gens[r.name] = fin.gen_id;
  }
  evidence.generations = gens;
  check("one accepted generation per test lineage (real patch, synthetic signed replays)", Object.keys(gens).length === 3, JSON.stringify(gens));

  // ----------------------------------------------------------------------------------------------
  // W1 on this Core: mirror cycle under the agent account
  const authorIds = new Set(Object.values(authors).map((k) => k.id));
  const ids: Identities = { forAgent: (x) => (authorIds.has(x) ? agentIdentity : null), app: () => APP_IDENTITY };
  const reader = new CoreReader(BASE);
  const m1 = await mirrorOnce({ core: reader, identities: ids, site: SITE, log });
  const published = m1.generations.filter((g) => Object.values(gens).includes(g.gen_id));
  evidence.mirror = published.map((g) => ({ repo: g.lineage_id, gen_id: g.gen_id, fork: g.fork, branch: g.branch, sha: g.sha, verified: g.verified, reason: g.verification_reason, url: g.html_url }));
  check("mirror: every generation is one signed commit on the agent's fork", published.length === 3 && published.every((g) => g.status === "published" && g.signed && g.fork?.startsWith(`${cred!.login}/`)), published.map((g) => `${g.fork}@${g.sha?.slice(0, 12)}`).join(", "));
  check("mirror: GitHub reports every commit Verified", published.every((g) => g.verified === true), published.map((g) => `${g.verification_reason} ${g.html_url}`).join(", "));
  const optLin = lineages["lineage-optin-test"]!;
  const optGen = published.find((g) => g.gen_id === gens["lineage-optin-test"])!;
  const branch = lineageBranch("lineage-optin-test", optLin);
  const agh = client(cred!.token, {});
  await deleteBranch(agh, optGen.fork!, branch);
  const gone = await agh.get<any>(`/repos/${optGen.fork}/git/ref/heads/${branch}`, [404]);
  const m2 = await mirrorOnce({ core: reader, identities: ids, site: SITE, lineages: [optLin], log });
  const again = m2.generations.find((g) => g.gen_id === optGen.gen_id)!;
  const pushed = m2.lineages[0]!.pushes[0];
  check("mirror: deleting the branch and rerunning rebuilds it identically", (!gone || !!gone.message) && pushed?.action === "pushed" && again.sha === optGen.sha && again.verified === true, `${branch}: ${optGen.sha} -> deleted -> ${again.sha} (${pushed?.detail})`);
  const m3 = await mirrorOnce({ core: reader, identities: ids, site: SITE, lineages: [optLin], log });
  check("mirror: a further cycle pushes nothing (idempotent)", m3.lineages[0]!.pushes.every((p) => p.action === "unchanged"), m3.lineages[0]!.pushes.map((p) => `${p.login} ${p.action}`).join(", "));

  // ----------------------------------------------------------------------------------------------
  // W2: PR cycle
  const prs = await prCycle({ core: reader, coreUrl: BASE, runtimeKey: admin, identities: ids, mirror: m1, site: SITE, log });
  evidence.pr_cycle = prs.map((p) => ({ gen_id: p.gen_id, repo: p.repo, action: p.action, reason: p.reason, url: p.url }));
  const statuses: Record<string, string> = {};
  for (const r of REPOS) statuses[r.name] = (await ok<any>(anon.get(`/v1/upstream/repo?url=${encodeURIComponent(`https://github.com/${MAINTAINER}/${r.name}`)}`), "repo")).status;
  evidence.policy = statuses;
  check("Core reads each repository's policy from GitHub", REPOS.every((r) => statuses[r.name] === r.expect), JSON.stringify(statuses));
  const pullsOf = async (name: string) => (await mgh.get<any[]>(`/repos/${MAINTAINER}/${name}/pulls?state=all`)) ?? [];
  const optPulls = await pullsOf("lineage-optin-test");
  const pr = optPulls.find((p) => String(p.body ?? "").includes(gens["lineage-optin-test"]!));
  evidence.pr = pr ? { url: pr.html_url, number: pr.number, user: pr.user?.login, head: pr.head?.label, state: pr.state } : null;
  check("the opt-in repository received exactly one real PR from the agent account", optPulls.length === 1 && !!pr && pr.user?.login === cred!.login, pr ? `${pr.html_url} by ${pr.user?.login}` : "none");
  const noopt = await pullsOf("lineage-noopt-test");
  const aiban = await pullsOf("lineage-aiban-test");
  check("the repository without opt-in received no PR", noopt.length === 0, `PR bot reason: ${prs.find((p) => p.gen_id === gens["lineage-noopt-test"])?.reason}`);
  check("the repository with an AI-ban policy received no PR", aiban.length === 0, `PR bot reason: ${prs.find((p) => p.gen_id === gens["lineage-aiban-test"])?.reason}`);
  const second = await prCycle({ core: reader, coreUrl: BASE, runtimeKey: admin, identities: ids, mirror: m1, site: SITE, log });
  check("a second PR cycle opens nothing more", second.every((p) => p.action === "none") && (await pullsOf("lineage-optin-test")).length === 1, second.map((p) => p.reason).join(", "));
  if (!pr) return;

  // the maintainer merges; Core detects it by hunk matching and credits the bonus
  if (pr.state === "open") {
    await mgh.request("PUT", `/repos/${MAINTAINER}/lineage-optin-test/pulls/${pr.number}/merge`, { merge_method: "merge", commit_title: `Merge Lineage protocol test PR #${pr.number}` });
    log(`maintainer merged ${pr.html_url}`);
  }
  const epoch = (await ok<any>(anon.get("/v1/epochs/current"), "epoch")).n;
  let merged: any[] = [];
  for (let i = 0; i < 10 && !merged.some((x) => x.gen_id === gens["lineage-optin-test"]); i++) {
    await ok(A.post("/v1/admin/upstream/scan", {}), "scan");
    merged = await ok<any[]>(anon.get("/v1/upstream/merges"), "merges");
    if (!merged.length) await Bun.sleep(3000);
  }
  const mr = merged.find((x) => x.gen_id === gens["lineage-optin-test"]);
  evidence.merge = mr ?? null;
  check("merge detected by hunk matching in an upstream commit", !!mr, mr ? `upstream ${mr.upstream_sha}, credited ${JSON.stringify(mr.credited)}` : "none");
  const prState = (await ok<any[]>(anon.get(`/v1/upstream/prs?gen=${gens["lineage-optin-test"]}`), "prs"))[0];
  check("Core records the PR as merged", prState?.state === "merged", JSON.stringify(prState));
  const closed = await ok<any>(A.post("/v1/admin/epochs/close", {}), "close");
  const leaf = closed.payouts.find((p: any) => p.agent === TEST_AGENT);
  const units = core.db.query<{ u: number }, [string, number]>("SELECT SUM(units) AS u FROM units WHERE agent_id = ? AND epoch = ? AND voided = 0 AND kind = 'upstream'").get(TEST_AGENT, closed.n)!.u ?? 0;
  evidence.epoch = { n: closed.n, status: closed.status, root: closed.root, author_leaf: leaf, upstream_units: units };
  check("upstream_bonus credited to the TEST agent in a closed epoch", closed.status === "closed" && closed.n >= epoch && units === cfg.upstream_bonus && !!leaf && leaf.units >= cfg.upstream_bonus, `epoch ${closed.n} closed, upstream units ${units} (upstream_bonus ${cfg.upstream_bonus}), leaf units ${leaf?.units}, amount ${leaf?.amount}`);
}

try {
  await main();
} catch (e) {
  check("run completed", false, (e as Error).message);
} finally {
  save();
  clearInterval(tick);
  server.stop(true);
  core.close();
  console.log(`${checks.filter((c) => c.ok).length}/${checks.length} passed; ${LAST}`);
}
