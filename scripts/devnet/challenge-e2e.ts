#!/usr/bin/env bun
// Bonded challenges end to end on devnet (SPEC 10.8, finish plan W7): one upheld and one failed
// challenge, each opened on chain by a registered TEST agent with open_challenge and resolved on
// chain by Core's resolve_challenge after fresh random replays in Docker sandboxes.
//
//   1. ChallengeConfig is set on chain with TEST values (window 3600 s, bond 1 tLINE, reward 0.5 tLINE,
//      resolve timeout 7200 s).
//   2. A Core in chain mode (port 9664, the registry's Core authority) calibrates minbpe. Two TEST
//      verifiers that qualify honestly and then fabricate every replay (worker --dishonest
//      fabricate-after-qualify) are the only eligible verifiers when the minbpe TEST agent submits a
//      comment-only "perf" patch: they claim a 10% gain and it is accepted (the f-squared capture case).
//   3. An honest verifier comes online. Challenger 1 opens a verdict challenge on chain. Core mirrors it,
//      draws the honest verifier plus the reference runner (every party excluded), both measure no gain,
//      and the combined judgement puts both liars in the minority: upheld. Core reverts the generation,
//      slashes the liars on chain and records the resolution: the bond comes back with the reward.
//   4. A second honest verifier comes online. Challenger 2 contests liar 1's slash on chain. Core
//      re-judges it with fresh replays (the second honest verifier and the reference runner): the liar
//      is in the minority again, so the challenge fails and its bond goes to the compute reserve.
//   5. A read-only replica recomputes every verdict and challenge judgement of this Core: zero divergence.
//
// It never closes an epoch, so it never posts one (the site's Core owns the epoch sequence; see
// docs/DEPLOY-SITE.md "One Core authority at a time"). Every transaction is logged in onchain/DEVNET.md.
//
// Usage: bun scripts/devnet/challenge-e2e.ts [--port 9664] [--keep]
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, generateAgentKey, H, hashJson, type AgentKey } from "@lineage/protocol";
import { loadRecipe, prepareDeps } from "@lineage/sandbox";
import {
  accountDisc,
  addressBytes,
  ata,
  challenge,
  CHALLENGE_KIND,
  decodeSlashReceipt,
  paramsFromNetworkJson,
  REGISTRY_PROGRAM_ID,
  registry,
  registryPdas,
  token,
  TOKEN_2022_PROGRAM,
  type Signer,
} from "@lineage/chain";
import { CoreClient } from "../../packages/core/src/client.ts";
import { replicate } from "../../packages/core/src/replica.ts";
import { doctor } from "../../packages/worker/src/doctor.ts";
import { loadScript, ScriptedProposer, Worker } from "../../packages/worker/src/index.ts";
import { deployer, key, KEY_DIR, LAMPORTS, loadState, reader, ROOT, rpc, send, sol, topUp } from "./lib.ts";

const argv = process.argv.slice(2);
const PORT = Number(argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : 9664);
const KEEP = argv.includes("--keep");
const CORE = `http://127.0.0.1:${PORT}`;
const T0 = Date.now();
const T22 = TOKEN_2022_PROGRAM;
const STEP = "challenge";
const TEST = { windowS: 3600, bond: 1_000_000n, reward: 500_000n, resolveTimeoutS: 7200 }; // tLINE has 6 decimals

const log = (m: string) => console.log(`[challenge-e2e +${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
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

const state = loadState();
const net = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
const DECIMALS = state.line_decimals!;
const params = paramsFromNetworkJson(net, DECIMALS);
const lineMint = state.line_mint!;
const dep = deployer();
const startSol = await rpc.getBalance(dep.id);
const tmp = mkdtempSync(join(tmpdir(), "lineage-challenge-e2e-"));
const procs: Subprocess[] = [];

async function lineTo(owner: string, min: bigint, label: string) {
  const dest = ata(owner, lineMint, T22);
  const bal = (await reader.tokenBalance(dest)) ?? 0n;
  if (bal >= min) return dest;
  await send(STEP, `send ${min - bal} tLINE base units to ${label} ${owner}`, dep, [
    token.createAtaIdempotent(dep.id, owner, lineMint, T22),
    token.transferChecked(state.line_holder as string, lineMint, dest, dep.id, min - bal, DECIMALS, T22),
  ]);
  return dest;
}

/** Registers (burn) and bonds a verifier on chain unless already done. */
async function onchainVerifier(owner: Signer, agent: Signer, caps: unknown, bond: bigint, label: string) {
  const capsDigest = H("caps", canonicalJson(caps));
  let rec = await reader.agent(agent.id);
  const ownerLine = ata(owner.id, lineMint, T22);
  if (!rec) {
    await lineTo(owner.id, params.registerBurn + bond + 2n * TEST.bond, "verifier owner");
    await send(STEP, `register ${label} ${agent.id}`, owner, [
      registry.register({ owner: owner.id, agent: agent.id, mint: lineMint, ownerToken: ownerLine, operator: "00".repeat(32), capabilities: capsDigest, tokenProgram: T22 }),
    ], { signers: [agent] });
    rec = await reader.agent(agent.id);
  }
  if (rec!.bond < bond) {
    await lineTo(owner.id, bond - rec!.bond, "verifier owner");
    await send(STEP, `bond ${bond - rec!.bond} base units for ${label} ${agent.id}`, owner, [
      registry.bond({ owner: owner.id, agent: agent.id, mint: lineMint, ownerToken: ownerLine, amount: bond - rec!.bond, tokenProgram: T22 }),
    ]);
    rec = await reader.agent(agent.id);
  }
  return rec!;
}

function startWorker(name: string, keyPath: string, extra: string[] = []): Subprocess {
  const stateDir = join(tmp, "workers", name);
  mkdirSync(stateDir, { recursive: true });
  const p = spawn(["bun", join(ROOT, "packages/worker/src/main.ts"), "run", "--core", CORE, "--key", keyPath, "--interval", "1000", ...extra], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, LINEAGE_HOME: stateDir } });
  for (const s of [p.stdout, p.stderr])
    (async () => {
      for await (const c of s) for (const l of new TextDecoder().decode(c).split("\n")) if (l.trim()) console.log(`   ${name.padEnd(4)} ${l}`);
    })();
  procs.push(p);
  return p;
}
async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 1_200_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
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

/** Every SlashReceipt of an agent (getProgramAccounts on the discriminator and the agent field). */
async function slashReceiptsOf(agent: string) {
  const all = await rpc.getProgramAccounts(REGISTRY_PROGRAM_ID, { memcmp: [{ offset: 0, bytes: accountDisc("SlashReceipt") },
    { offset: 40, bytes: addressBytes(agent) }] });
  return all.map((a) => ({ address: a.address, ...decodeSlashReceipt(a.data) }));
}

async function main() {
  // ------------------------------------------------------------ 1. ChallengeConfig (TEST values)
  const cc0 = await reader.challengeConfig();
  if (!cc0 || cc0.windowS !== BigInt(TEST.windowS) || cc0.bond !== TEST.bond || cc0.reward !== TEST.reward || cc0.resolveTimeoutS !== BigInt(TEST.resolveTimeoutS) || cc0.paused) {
    await send(STEP, `set_challenge_config: window ${TEST.windowS} s, bond 1 tLINE, reward 0.5 tLINE, resolve timeout ${TEST.resolveTimeoutS} s (TEST values)`, dep, [
      challenge.setConfig({ admin: dep.id, mint: lineMint, args: { ...TEST, paused: false }, tokenProgram: T22 }),
    ]);
  }
  const cc = (await reader.challengeConfig())!;
  check("ChallengeConfig on chain holds the TEST values", cc.windowS === BigInt(TEST.windowS) && cc.bond === TEST.bond && cc.reward === TEST.reward && !cc.paused,
    `window ${cc.windowS} s, bond ${cc.bond}, reward ${cc.reward}, timeout ${cc.resolveTimeoutS} s, open ${cc.open}`);

  // ------------------------------------------------------------ 2. agents on chain
  const caps = doctor().capabilities;
  const owner = key("verifier-owner");
  await topUp(STEP, dep, owner.id, LAMPORTS / 20n, "verifier owner", LAMPORTS / 10n);
  await topUp(STEP, dep, state.core_authority!, LAMPORTS / 20n, "Core authority", LAMPORTS / 10n);
  const ref = key("verifier-ref");
  const v1 = key("verifier-v1");
  const v2 = key("verifier-v2");
  const l1 = key("chal-liar-1");
  const l2 = key("chal-liar-2");
  const c1 = key("chal-challenger-1");
  const c2 = key("chal-challenger-2");
  await onchainVerifier(owner, ref, caps, 0n, "reference runner");
  for (const [k, n] of [[v1, "honest verifier v1"], [v2, "honest verifier v2"], [l1, "TEST liar 1"], [l2, "TEST liar 2"]] as const) {
    const rec = await onchainVerifier(owner, k, caps, params.minBond, n);
    check(`${n} registered and bonded on chain`, rec.bond >= params.minBond, `${k.id} bond ${rec.bond}`);
  }
  for (const [k, n] of [[c1, "challenger 1"], [c2, "challenger 2"]] as const) {
    const rec = await onchainVerifier(owner, k, caps, 0n, `TEST ${n}`);
    check(`${n} is a registered identity (Agent record, signing key = agent key)`, !!rec && rec.signingKey === k.id, k.id);
  }
  const ownerLine = await lineTo(owner.id, 3n * TEST.bond, "challenger payer");

  // ------------------------------------------------------------ 3. Core in chain mode (never closes an epoch here)
  const admin: AgentKey = generateAgentKey();
  const adminPath = join(tmp, "admin.json");
  writeFileSync(adminPath, JSON.stringify(Array.from(admin.secret)), { mode: 0o600 });
  Object.assign(net, { canary_rate: 0, audit_rate: 0, epoch_length_s: 864_000, reveal_window_s: 900, replay_window_min_s: 900, qualify_retry_s: 30, challenge_replayers: 1 });
  net.chain = { mode: "devnet", rpc_url: state.rpc_url, registry_program: state.registry_program, launch_program: state.launch_program, line_mint: lineMint,
    core_authority_key: state.core_authority_key, poll_ms: 10_000 };
  writeFileSync(join(tmp, "network.json"), JSON.stringify(net));
  const core = spawn(["bun", join(ROOT, "packages/core/src/main.ts"), "--data", join(tmp, "data"), "--port", String(PORT), "--config", join(tmp, "network.json"),
    "--admin-key", adminPath, "--tick-ms", "500", "--no-trees"], { stdout: "inherit", stderr: "inherit" });
  procs.push(core);
  await waitFor("core", async () => (await fetch(`${CORE}/v1/health`).catch(() => null))?.ok);
  const A = new CoreClient(CORE, admin);
  const anon = new CoreClient(CORE, null);
  const chainSync = async (): Promise<any> => {
    for (let i = 0; ; i++) {
      const r = await A.post("/v1/admin/chain/sync", {});
      if (r.status < 300) return r.body;
      if (i >= 8) throw new Error(`chain sync: ${r.status} ${JSON.stringify(r.body)}`);
      await Bun.sleep(2000 * 2 ** Math.min(i, 4));
    }
  };
  await chainSync();
  const health = await ok(anon.get("/v1/health"), "health");
  const reg0 = (await reader.registryConfig())!;
  check("Core's open epoch is the registry's next one (verdicts made now are held by it)", BigInt(health.epoch) === reg0.lastEpoch + 1n, `epoch ${health.epoch}`);
  const ccView = await ok(anon.get("/v1/challenges/config"), "challenge config");
  check("Core reads the challenge parameters from chain", ccView.source === "chain" && ccView.bond === TEST.bond.toString(), JSON.stringify(ccView));

  const loaded = loadRecipe(join(ROOT, "recipes/minbpe"));
  const deps = await prepareDeps(loaded);
  await ok(A.post("/v1/admin/recipes", { recipe: loaded.recipe, recipe_id: loaded.recipe_id }), "recipe");
  const snap = await ok(A.post("/v1/admin/snapshots", { repo: loaded.recipe.repo, commit: loaded.recipe.commit, deps_digest: deps.digest }), "snapshot");
  await ok(A.post(`/v1/admin/agents/${ref.id}/reference`, { reference: true }), "reference");
  const refWorker = new Worker({ core: CORE, key: { id: ref.id, secret: ref.secret }, stateDir: join(tmp, "ref-cal"), log: (x) => console.log(`   ref  ${x}`) });
  await refWorker.declareCapabilities();
  log("reference runner calibrating minbpe in the sandbox");
  await refWorker.submitCalibration(loaded.recipe_id, snap.snapshot_id, 3);
  const L = (await ok<any[]>(anon.get("/v1/lineages"), "lineages"))[0].lineage_id as string;

  startWorker("ref", join(KEY_DIR, "verifier-ref.json"));
  startWorker("l1", join(KEY_DIR, "chal-liar-1.json"), ["--dishonest", "fabricate-after-qualify"]);
  startWorker("l2", join(KEY_DIR, "chal-liar-2.json"), ["--dishonest", "fabricate-after-qualify"]);
  const qualified = (id: string) => waitFor(`${id} qualified`, async () => ((await ok(anon.get(`/v1/agents/${id}`), id)).qualified_lineages as string[]).includes(L));
  await Promise.all([qualified(l1.id), qualified(l2.id)]);
  check("the two TEST liars qualified honestly (and are the only eligible verifiers)", true);

  // ------------------------------------------------------------ the captured candidate
  const m = state.agents!.minbpe!;
  const agentKey = key("agent-minbpe");
  const launcher = key("launcher");
  const rec0 = (await reader.agent(m.agent))!;
  if (rec0.signingKey !== agentKey.id) {
    await topUp(STEP, dep, launcher.id, LAMPORTS / 50n, "launcher", LAMPORTS / 20n);
    await send(STEP, `rotate_agent_key ${m.agent} back to its original key`, launcher, [registry.rotateAgentKey({ owner: launcher.id, agent: m.agent, newKey: agentKey.id })],
      { signers: [agentKey] });
    await chainSync();
  }
  const scriptDir = join(tmp, "candidates");
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(join(scriptDir, "index.json"), JSON.stringify({ noop_comment: { kind: "perf", target: "train_ir" } }));
  writeFileSync(join(scriptDir, "noop_comment.diff"), [
    "diff --git a/minbpe/regex.py b/minbpe/regex.py",
    "--- a/minbpe/regex.py",
    "+++ b/minbpe/regex.py",
    "@@ -40,8 +40,8 @@ class RegexTokenizer(Tokenizer):",
    "         # split the text up into text chunks",
    "         text_chunks = re.findall(self.compiled_pattern, text)",
    " ",
    "-        # input text preprocessing",
    "+        # input text preprocessing: one list of byte ids per regex chunk",
    "         ids = [list(ch.encode(\"utf-8\")) for ch in text_chunks]",
    " ",
    "         # iteratively merge the most common pairs to create new tokens",
    "         merges = {} # (int, int) -> int",
    "",
  ].join("\n"));
  const author = new Worker({ core: CORE, key: { id: agentKey.id, secret: agentKey.secret }, lineages: [L], stateDir: join(tmp, "author"),
    proposer: new ScriptedProposer(loadScript(scriptDir, ["noop_comment"])), log: (x) => console.log(`   auth ${x}`) });
  const candId = await author.authorOnce();
  if (!candId) throw new Error("the author did not submit");
  const cand = await waitFor("candidate final", async () => {
    const r = await anon.get(`/v1/candidates/${candId}`);
    return r.status === 200 && ["accepted", "rejected", "expired"].includes(r.body.status) ? r.body : null;
  });
  const origReplayers = (cand.replays as any[]).filter((r) => !r.audit_id).map((r) => r.replayer).sort();
  check("the two liars accepted a comment-only patch as a 10% gain (captured verdict)", cand.status === "accepted" &&
    JSON.stringify(origReplayers) === JSON.stringify([l1.id, l2.id].sort()), `${cand.status}, gen ${cand.gen_id?.slice(0, 12)}`);

  // ------------------------------------------------------------ 4. upheld verdict challenge
  startWorker("v1", join(KEY_DIR, "verifier-v1.json"));
  await qualified(v1.id);
  const genEpoch = BigInt((await ok(anon.get(`/v1/generations/${cand.gen_id}`), "generation")).epoch);
  const claim1 = { v: 1, says: "the replayers of this verdict did not measure a gain; a fresh run will not show one", candidate_id: cand.candidate_id };
  const tokBefore1 = (await reader.tokenBalance(ownerLine))!;
  const vaultBefore = (await reader.tokenBalance(registryPdas.challengeVault()))!;
  await send(STEP, `open_challenge verdict ${cand.candidate_id.slice(0, 16)}... epoch ${genEpoch} by challenger 1 ${c1.id} (bond 1 tLINE from ${owner.id})`, owner, [
    challenge.open({ challenger: c1.id, signingKey: c1.id, payer: owner.id, payerToken: ownerLine, mint: lineMint, kind: CHALLENGE_KIND.verdict, subject: cand.candidate_id,
      epoch: genEpoch, claim: hashJson(claim1), tokenProgram: T22 }),
  ], { signers: [c1] });
  const ch1 = (await reader.challenge(CHALLENGE_KIND.verdict, cand.candidate_id))!;
  const gate1 = await reader.challengeGate(genEpoch);
  check("open_challenge escrowed the bond and holds the epoch's payouts", ch1.status === "open" && (await reader.tokenBalance(registryPdas.challengeVault()))! - vaultBefore === TEST.bond &&
    gate1?.open === 1, `gate ${genEpoch} open ${gate1?.open}`);
  await chainSync();
  const id1 = H("challenge", "verdict", cand.candidate_id);
  const res1 = await waitFor("challenge 1 resolved by Core", async () => {
    const r = await anon.get(`/v1/challenges/${id1}`);
    return r.status === 200 && ["upheld", "failed", "void"].includes(r.body.status) ? r.body : null;
  });
  const fresh1 = (await ok(anon.get(`/v1/candidates/${cand.candidate_id}`), "cand")).replays.filter((r: any) => r.audit_id === id1);
  check("Core drew fresh replayers excluding every party (the honest verifier and the reference runner)",
    JSON.stringify(fresh1.map((r: any) => r.replayer).sort()) === JSON.stringify([v1.id, ref.id].sort()), fresh1.map((r: any) => `${r.kind}:${r.replayer.slice(0, 6)}`).join(" "));
  check("Core upheld the challenge: both liars in the combined minority, the generation reverted", res1.status === "upheld" && res1.resolution.effect === "reverted" &&
    res1.resolution.combined.minority.length === 2, res1.detail);
  // the bridge sends the liars' slashes and the resolution
  const onchain1 = await waitFor("resolve_challenge 1 on chain", async () => {
    await chainSync();
    const a = await reader.challenge(CHALLENGE_KIND.verdict, cand.candidate_id);
    return a && a.status !== "open" ? a : null;
  }, 300_000);
  const view1 = await ok(anon.get(`/v1/challenges/${id1}`), "challenge 1");
  check("resolve_challenge landed: upheld, evidence = Core's resolution digest, reward 0.5 tLINE", onchain1.status === "upheld" && onchain1.evidence === view1.evidence &&
    onchain1.reward === TEST.reward, `sig ${view1.chain.resolve_signature}`);
  const tokAfter1 = (await reader.tokenBalance(ownerLine))!;
  check("the challenger's payer got its bond back plus the reward", tokAfter1 - tokBefore1 === TEST.reward, `${tokBefore1} -> ${tokAfter1}`);
  check("the epoch is no longer held by the challenge", (await reader.challengeGate(genEpoch))?.open === 0);
  const liarSlashes = await waitFor("liar slashes on chain", async () => {
    await chainSync();
    const a = await slashReceiptsOf(l1.id);
    const b = await slashReceiptsOf(l2.id);
    return a.length && b.length ? { a, b } : null;
  }, 300_000);
  const l1rec = (await reader.agent(l1.id))!;
  check("both liars slashed on chain (minority, 5% of the bond)", liarSlashes.a.some((s) => s.offence === 1) && liarSlashes.b.some((s) => s.offence === 1) &&
    l1rec.bond === params.minBond - (params.minBond * 500n) / 10_000n, `liar 1 bond ${l1rec.bond}`);
  const l1slash = liarSlashes.a.find((s) => s.offence === 1)!;

  // ------------------------------------------------------------ 5. failed slash challenge
  startWorker("v2", join(KEY_DIR, "verifier-v2.json"));
  await qualified(v2.id);
  const reserveBefore = (await reader.tokenBalance(registryPdas.reserve()))!;
  const tokBefore2 = (await reader.tokenBalance(ownerLine))!;
  await send(STEP, `open_challenge slash ${l1slash.slashId.slice(0, 16)}... (liar 1, epoch ${l1slash.epoch}) by challenger 2 ${c2.id}`, owner, [
    challenge.open({ challenger: c2.id, signingKey: c2.id, payer: owner.id, payerToken: ownerLine, mint: lineMint, kind: CHALLENGE_KIND.slash, subject: l1slash.slashId,
      epoch: l1slash.epoch, claim: hashJson({ v: 1, says: "liar 1 was slashed wrongly", slash_id: l1slash.slashId }), tokenProgram: T22 }),
  ], { signers: [c2] });
  await chainSync();
  const id2 = H("challenge", "slash", l1slash.slashId);
  const res2 = await waitFor("challenge 2 resolved by Core", async () => {
    const r = await anon.get(`/v1/challenges/${id2}`);
    return r.status === 200 && ["upheld", "failed", "void"].includes(r.body.status) ? r.body : null;
  });
  check("Core re-judged the slash with fresh replays (v2 and the reference runner): justified, the challenge failed", res2.status === "failed" &&
    res2.resolution.fresh.length === 2, res2.detail);
  const onchain2 = await waitFor("resolve_challenge 2 on chain", async () => {
    await chainSync();
    const a = await reader.challenge(CHALLENGE_KIND.slash, l1slash.slashId);
    return a && a.status !== "open" ? a : null;
  }, 300_000);
  const view2 = await ok(anon.get(`/v1/challenges/${id2}`), "challenge 2");
  check("resolve_challenge landed: failed, evidence = Core's resolution digest", onchain2.status === "failed" && onchain2.evidence === view2.evidence && onchain2.reversed === 0n,
    `sig ${view2.chain.resolve_signature}`);
  // the reserve also moves with other activity (the site's Core shares the registry), so only the payer's side and the slash are exact
  check("the failed bond went to the compute reserve; liar 1's bond unchanged", (await reader.tokenBalance(ownerLine))! === tokBefore2 - TEST.bond &&
    (await reader.agent(l1.id))!.bond === l1rec.bond, `reserve ${reserveBefore} -> ${await reader.tokenBalance(registryPdas.reserve())}`);

  // ------------------------------------------------------------ 6. read-only replica of this Core
  const rep = await replicate(CORE, { log: (x) => log(x) });
  check("a read-only replica recomputes every verdict and challenge judgement of this Core: zero divergence", rep.ok,
    `${rep.verdicts.checked} verdicts, ${rep.challenges.checked} challenges, ${rep.units.checked} unit checks, ${rep.divergences.length} divergences`);
  writeFileSync(join(ROOT, "scripts/devnet/CHALLENGE-E2E-LAST.json"), JSON.stringify({
    at: new Date().toISOString(), core_epoch: health.epoch, candidate: cand.candidate_id, generation: cand.gen_id,
    challenges: [view1, view2].map((v) => ({ challenge_id: v.challenge_id, kind: v.kind, subject: v.subject, status: v.status, evidence: v.evidence, chain: v.chain,
      detail: v.detail })),
    replica: { ...rep, divergences: rep.divergences.slice(0, 20) }, results,
  }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  for (const p of procs) {
    try {
      p.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
  const endSol = await rpc.getBalance(dep.id).catch(() => startSol);
  log(`deployer ${sol(startSol)} -> ${sol(endSol)} SOL`);
  const passed = results.filter((r) => r.ok).length;
  log(`${passed}/${results.length} checks passed${failed ? " (aborted)" : ""}`);
  if (!KEEP) rmSync(tmp, { recursive: true, force: true });
  else log(`kept ${tmp}`);
  process.exit(failed || passed !== results.length ? 1 : 0);
}
