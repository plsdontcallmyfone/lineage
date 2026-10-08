#!/usr/bin/env bun
// A short real network on devnet: Core in chain mode (registrations, bonds, compute vaults and the
// registry vaults read from the programs), three verifiers registered and bonded ON CHAIN running
// as separate worker processes with Docker sandboxes, and the minbpe TEST agent launched on chain
// by scripts/devnet/setup.ts authoring one scripted candidate on its target repo. Fresh agent
// token trades refill the epoch pool (crank_fees, split), Core closes the epoch, the bridge posts
// its root with post_epoch, every leaf is claimed on chain, and Core mirrors the claims back.
//
// Identity (plan I1, I2): before authoring, the minbpe agent's owner (its launcher) rotates the agent
// to a runtime-generated key with rotate_agent_key (owner and new key sign); Core then refuses the
// old key (401) and the new key commits the candidate under the unchanged agent id; afterwards the
// owner revokes the key (every key 401) and rotates back to the original. The closed epoch's
// record_root on chain equals Core's, a verifier's credential verifies from chain alone and fails
// once a record is altered, and a two-step owner transfer is mirrored with controller_since.
//
// Bounties (plan C6): before the candidate, the runtime authority opens three bounties from the
// hosted bounty payer agent's compute vault (setup step i): one on the lineage's encode_ir target
// naming the minbpe agent, one with a short deadline (refunded at the end), one cancelled at once.
// After the epoch is posted, Core mirrors them and serves the contribution proof; release_bounty
// pays the minbpe agent's compute vault exactly, a second release is refused, and Core mirrors it.
//
// The recipe is minbpe, not fixture-b58: a fixture repo (`fixture:b58`) has no https URL, so no
// agent can be launched on it on chain, and in chain mode only onchain launches author.
//
// Usage: bun scripts/devnet/e2e-devnet.ts [--port 9663] [--keep]
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, generateAgentKey, H, type AgentKey } from "@lineage/protocol";
import { loadRecipe, prepareDeps } from "@lineage/sandbox";
import {
  ata,
  bounty,
  bountyPdas,
  claimFromCoreProof,
  COND,
  termsDigest,
  releaseFromContribution,
  targetDigest,
  dbc,
  decodeDbcPool,
  launch,
  launchPdas,
  paramsFromNetworkJson,
  registry,
  registryPdas,
  token,
  TOKEN_2022_PROGRAM,
  type Signer,
} from "@lineage/chain";
import { CoreClient } from "../../packages/core/src/client.ts";
import { verifyCredential } from "../../packages/core/src/records.ts";
import { doctor } from "../../packages/worker/src/doctor.ts";
import { loadScript, ScriptedProposer, Worker } from "../../packages/worker/src/index.ts";
import { deployer, key, KEY_DIR, LAMPORTS, loadState, logTx, reader, ROOT, rpc, send, sol, topUp } from "./lib.ts";

const argv = process.argv.slice(2);
const PORT = Number(argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : 9663);
const KEEP = argv.includes("--keep");
const CORE = `http://127.0.0.1:${PORT}`;
const T0 = Date.now();
const T22 = TOKEN_2022_PROGRAM;
const STEP = "e2e";

const log = (m: string) => console.log(`[e2e-devnet +${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
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
const ONE = 10n ** BigInt(DECIMALS);
const params = paramsFromNetworkJson(net, DECIMALS);
const lineMint = state.line_mint!;
const dep = deployer();
const startSol = await rpc.getBalance(dep.id);
const tmp = mkdtempSync(join(tmpdir(), "lineage-e2e-devnet-"));
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

/** Registers (burn) and bonds a verifier on chain unless already done; the capabilities digest is Core's caps digest. */
async function onchainVerifier(owner: Signer, agent: Signer, caps: unknown, bond: bigint) {
  const capsDigest = H("caps", canonicalJson(caps));
  let rec = await reader.agent(agent.id);
  const ownerLine = ata(owner.id, lineMint, T22);
  if (!rec) {
    await lineTo(owner.id, params.registerBurn + bond, "verifier owner");
    await send(STEP, `register verifier ${agent.id} (caps digest ${capsDigest.slice(0, 12)}...)`, owner, [
      registry.register({ owner: owner.id, agent: agent.id, mint: lineMint, ownerToken: ownerLine, operator: "00".repeat(32), capabilities: capsDigest, tokenProgram: T22 }),
    ], { signers: [agent] });
    rec = await reader.agent(agent.id);
  }
  if (rec!.bond < bond) {
    await lineTo(owner.id, bond - rec!.bond, "verifier owner");
    await send(STEP, `bond ${bond - rec!.bond} base units for ${agent.id}`, owner, [
      registry.bond({ owner: owner.id, agent: agent.id, mint: lineMint, ownerToken: ownerLine, amount: bond - rec!.bond, tokenProgram: T22 }),
    ]);
    rec = await reader.agent(agent.id);
  }
  return rec!;
}

/** Fresh trades on the minbpe agent's curve, crank_fees, split: refills the epoch pool from real fees. */
async function refillPool() {
  const m = state.agents!.minbpe!;
  const trader = key("trader");
  const pool = launchPdas.dbcPool(state.dbc_config!, m.mint!, lineMint);
  const traderLine = ata(trader.id, lineMint, T22);
  const traderAgent = ata(trader.id, m.mint!, T22);
  await topUp(STEP, dep, trader.id, LAMPORTS / 50n, "trader", LAMPORTS / 20n);
  const swap = (buy: boolean, amountIn: bigint) =>
    dbc.swap({ config: state.dbc_config!, pool, agentMint: m.mint!, lineMint, trader: trader.id, lineAccount: traderLine, agentAccount: traderAgent, buy, amountIn, minOut: 1n,
      lineTokenProgram: T22 });
  await send(STEP, "trade: trader buys with 20,000 tLINE", trader, [swap(true, 20_000n * ONE)], { computeUnits: 300_000 });
  const held = (await reader.tokenBalance(traderAgent))!;
  await send(STEP, `trade: trader sells ${held / 4n} agent-token base units`, trader, [swap(false, held / 4n)], { computeUnits: 300_000 });
  const fees = decodeDbcPool((await rpc.getAccountInfo(pool))!.data).partnerQuoteFee;
  const [c0, t0] = await reader.tokenBalances([launchPdas.computeVault(m.agent), registryPdas.treasury()]);
  await send(STEP, `crank_fees: ${fees} partner fee base units`, dep, [
    launch.crankFees({ agent: m.agent, agentMint: m.mint!, lineMint, dbcConfig: state.dbc_config!, lineTokenProgram: T22 }),
  ], { computeUnits: 400_000 });
  const [c1, t1] = await reader.tokenBalances([launchPdas.computeVault(m.agent), registryPdas.treasury()]);
  const wantC = (fees * 7000n) / 10_000n;
  check("crank_fees split exactly 7000/3000 bps on chain", c1! - c0! === wantC && t1! - t0! === fees - wantC, `fees ${fees}: compute +${c1! - c0!}, treasury +${t1! - t0!}`);
  const tBal = t1!;
  const [r0, p0] = await reader.tokenBalances([registryPdas.reserve(), registryPdas.pool()]);
  await send(STEP, `split: treasury ${tBal} to reserve and pool`, dep, [registry.split({ mint: lineMint, tokenProgram: T22 })]);
  const [r1, p1] = await reader.tokenBalances([registryPdas.reserve(), registryPdas.pool()]);
  const wantR = (tBal * 8000n) / 10_000n;
  check("split moved exactly 8000 bps to the reserve and the rest to the pool", r1! - r0! === wantR && p1! - p0! === tBal - wantR, `reserve +${r1! - r0!}, pool +${p1! - p0!}`);
}

function startWorker(name: string, keyPath: string, extra: string[] = []): Subprocess {
  const p = spawn(["bun", join(ROOT, "packages/worker/src/main.ts"), "run", "--core", CORE, "--key", keyPath, "--interval", "1000", ...extra], { stdout: "pipe", stderr: "pipe", env: process.env });
  for (const s of [p.stdout, p.stderr])
    (async () => {
      for await (const c of s) for (const l of new TextDecoder().decode(c).split("\n")) if (l.trim()) console.log(`   ${name.padEnd(4)} ${l}`);
    })();
  procs.push(p);
  return p;
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 900_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v as T;
    await Bun.sleep(1500);
  }
  throw new Error(`timed out waiting for ${what}`);
}
async function ok<T = any>(p: Promise<{ status: number; body: T }>, what: string): Promise<T> {
  const r = await p;
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

async function main() {
  // ------------------------------------------------------------ onchain verifiers
  const caps = doctor().capabilities;
  const owner = key("verifier-owner");
  await topUp(STEP, dep, owner.id, LAMPORTS / 20n, "verifier owner", LAMPORTS / 10n);
  await topUp(STEP, dep, state.core_authority!, LAMPORTS / 50n, "Core authority", LAMPORTS / 10n);
  const names = ["ref", "v1", "v2"] as const;
  const vkeys = Object.fromEntries(names.map((n) => [n, key(`verifier-${n}`)])) as Record<(typeof names)[number], Signer>;
  for (const n of names) {
    const rec = await onchainVerifier(owner, vkeys[n], caps, n === "ref" ? 0n : params.minBond);
    check(`verifier ${n} registered on chain${n === "ref" ? "" : " and bonded"}`, rec.kind === "verifier" && rec.bond === (n === "ref" ? 0n : params.minBond), `${vkeys[n].id} bond ${rec.bond}`);
  }
  await refillPool();

  // ------------------------------------------------------------ Core in chain mode
  const admin: AgentKey = generateAgentKey();
  const adminPath = join(tmp, "admin.json");
  writeFileSync(adminPath, JSON.stringify(Array.from(admin.secret)), { mode: 0o600 });
  Object.assign(net, { canary_rate: 0, audit_rate: 0, epoch_length_s: 86400, reveal_window_s: 600, replay_window_min_s: 600, qualify_retry_s: 60 });
  net.chain = {
    mode: "devnet", rpc_url: state.rpc_url, registry_program: state.registry_program, launch_program: state.launch_program, line_mint: lineMint,
    core_authority_key: state.core_authority_key, poll_ms: 10000,
  };
  writeFileSync(join(tmp, "network.json"), JSON.stringify(net));
  const core = spawn(["bun", join(ROOT, "packages/core/src/main.ts"), "--data", join(tmp, "data"), "--port", String(PORT), "--config", join(tmp, "network.json"), "--admin-key", adminPath,
    "--tick-ms", "500"], { stdout: "inherit", stderr: "inherit" });
  procs.push(core);
  await waitFor("core", async () => (await fetch(`${CORE}/v1/health`).catch(() => null))?.ok);
  const A = new CoreClient(CORE, admin);
  const anon = new CoreClient(CORE, null);
  /** POST /v1/admin/chain/sync, retried while the public devnet RPC rate limits (HTTP 429). */
  const chainSync = async (): Promise<any> => {
    for (let i = 0; ; i++) {
      const r = await A.post("/v1/admin/chain/sync", {});
      if (r.status < 300) return r.body;
      if (i >= 8 || !/429|Too Many|rate/i.test(JSON.stringify(r.body))) throw new Error(`chain sync: ${r.status} ${JSON.stringify(r.body)}`);
      log(`chain sync rate limited (${r.status}); retrying`);
      await Bun.sleep(2000 * 2 ** Math.min(i, 4));
    }
  };
  const chain0 = await chainSync();
  const cfgView = await ok(anon.get("/v1/config"), "config");
  check("Core in chain mode takes amounts from the registry (6-decimal tLINE)", cfgView.network.min_bond === params.minBond.toString() && cfgView.network.token_decimals === DECIMALS,
    `min_bond ${cfgView.network.min_bond}, first epoch ${(await ok(anon.get("/v1/health"), "health")).epoch}`);
  for (const n of names) {
    const v = await ok(anon.get(`/v1/agents/${vkeys[n].id}`), n);
    check(`Core registered ${n} from its Agent PDA with the onchain bond`, v.kind === "verifier" && v.bond === (n === "ref" ? "0" : params.minBond.toString()), `bond ${v.bond}`);
  }
  const m = state.agents!.minbpe!;
  const author0 = await ok(anon.get(`/v1/agents/${m.agent}`), "minbpe agent");
  check("the onchain-launched minbpe agent is in Core with its compute vault balance read from chain", author0.kind === "launched" && author0.compute === chain0.compute[m.agent].balance,
    `compute ${author0.compute}, setting up: ${author0.lifecycle}`);
  const sim = await new CoreClient(CORE, { id: vkeys.v1.id, secret: vkeys.v1.secret }).post(`/v1/agents/${vkeys.v1.id}/bond`, { amount: "1" });
  check("simulated bonding is refused in chain mode (409 on_chain)", sim.status === 409 && sim.body.error === "on_chain", `${sim.status} ${JSON.stringify(sim.body).slice(0, 80)}`);

  // ------------------------------------------------------------ lineage: minbpe
  const loaded = loadRecipe(join(ROOT, "recipes/minbpe"));
  const deps = await prepareDeps(loaded);
  await ok(A.post("/v1/admin/recipes", { recipe: loaded.recipe, recipe_id: loaded.recipe_id }), "recipe");
  const snap = await ok(A.post("/v1/admin/snapshots", { repo: loaded.recipe.repo, commit: loaded.recipe.commit, deps_digest: deps.digest }), "snapshot");
  await ok(A.post(`/v1/admin/agents/${vkeys.ref.id}/reference`, { reference: true }), "reference");
  const refKey = { id: vkeys.ref.id, secret: vkeys.ref.secret };
  const refWorker = new Worker({ core: CORE, key: refKey, log: (x) => console.log(`   ref  ${x}`) });
  await refWorker.declareCapabilities();
  log("reference runner calibrating minbpe in the sandbox");
  await refWorker.submitCalibration(loaded.recipe_id, snap.snapshot_id, 3);
  const L = (await ok<any[]>(anon.get("/v1/lineages"), "lineages"))[0].lineage_id as string;
  const author1 = await ok(anon.get(`/v1/agents/${m.agent}`), "minbpe agent");
  check("calibration created the lineage; the launched agent is active and awake", author1.lifecycle === "active" && author1.awake === true, `lineage ${L.slice(0, 12)}`);

  startWorker("ref", join(KEY_DIR, "verifier-ref.json"));
  startWorker("v1", join(KEY_DIR, "verifier-v1.json"));
  startWorker("v2", join(KEY_DIR, "verifier-v2.json"));
  await waitFor("verifiers qualified", async () => {
    const vs = await Promise.all((["v1", "v2"] as const).map((n) => ok(anon.get(`/v1/agents/${vkeys[n].id}`), n)));
    return vs.every((v) => v.qualified_lineages.includes(L)) ? vs : null;
  });
  check("onchain verifiers declared capabilities matching their onchain digest and qualified", true);

  // ------------------------------------------------------------ C6: bounties opened before the work
  const payerA = state.agents!["bounty-payer"];
  if (!payerA?.mint) throw new Error("no bounty payer agent: run scripts/devnet/setup.ts (step i)");
  const runtimeAuth = key("runtime-authority");
  await topUp(STEP, dep, runtimeAuth.id, LAMPORTS / 50n, "runtime authority", LAMPORTS / 10n);
  const bcfg = await reader.bountyConfig();
  check("BountyConfig is set on chain (setup step h)", !!bcfg && !bcfg.paused, JSON.stringify(bcfg, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  const payerVault = launchPdas.computeVault(payerA.agent);
  const pv0 = (await reader.tokenBalance(payerVault))!;
  const nowS = () => BigInt(Math.floor(Date.now() / 1000));
  const base = BigInt(Date.now());
  const mkBounty = (id: bigint, o: { payee: string | null; amount: bigint; kind: number; value: string | null; ttl: bigint; note: string }) => {
    const terms = { v: 1, note: o.note, lineage_id: L, payee: o.payee, amount: o.amount.toString() };
    return { id, terms, ix: bounty.open({ opener: runtimeAuth.id, payer: payerA.agent, payerMint: payerA.mint!, lineMint, lineTokenProgram: T22,
      args: { bountyId: id, payee: o.payee, amount: o.amount, termsDigest: termsDigest(terms), conditionKind: o.kind, lineageId: L, conditionValue: o.value,
        deadline: nowS() + o.ttl } }) };
  };
  const b1 = mkBounty(base, { payee: m.agent, amount: 2n * ONE, kind: COND.target, value: targetDigest("encode_ir"), ttl: 86_400n, note: "e2e-devnet: faster encode on minbpe" });
  const b2 = mkBounty(base + 1n, { payee: null, amount: ONE, kind: COND.target, value: null, ttl: 70n, note: "e2e-devnet: short deadline, refunded" });
  const b3 = mkBounty(base + 2n, { payee: null, amount: ONE / 2n, kind: COND.target, value: null, ttl: 3_600n, note: "e2e-devnet: cancelled before the next epoch" });
  for (const [b, what] of [[b1, `open_bounty ${base}: 2 tLINE on encode_ir of lineage ${L.slice(0, 12)}... for ${m.agent}`],
    [b2, `open_bounty ${base + 1n}: 1 tLINE, any author, 70 s deadline (to refund)`], [b3, `open_bounty ${base + 2n}: 0.5 tLINE (to cancel)`]] as const)
    await send(STEP, `${what} (runtime authority for the hosted payer ${payerA.agent.slice(0, 8)})`, runtimeAuth, [b.ix], { computeUnits: 300_000 });
  const addr1 = bountyPdas.bounty(payerA.agent, b1.id);
  const addr2 = bountyPdas.bounty(payerA.agent, b2.id);
  const addr3 = bountyPdas.bounty(payerA.agent, b3.id);
  const pv1 = (await reader.tokenBalance(payerVault))!;
  const ob1 = (await reader.bounty(addr1))!;
  const reg1 = (await reader.registryConfig())!;
  check("open_bounty escrowed exactly 3.5 tLINE from the payer's compute vault", pv0 - pv1 === 3n * ONE + ONE / 2n && (await reader.tokenBalance(bountyPdas.vault(addr1))) === 2n * ONE,
    `${pv0} -> ${pv1}`);
  check("the bounty qualifies only generations from the registry's next epoch on", ob1.minEpoch === (reg1.epochsPosted === 0n ? 0n : reg1.lastEpoch + 1n) && ob1.status === "open",
    `min_epoch ${ob1.minEpoch}`);
  const pvc0 = (await reader.tokenBalance(payerVault))!;
  await send(STEP, `cancel_bounty ${b3.id} (runtime authority, before the next epoch)`, runtimeAuth, [bounty.cancel({ signer: runtimeAuth.id, payer: payerA.agent,
    payerMint: payerA.mint!, bountyId: b3.id, opener: runtimeAuth.id, lineMint, lineTokenProgram: T22 })]);
  check("cancel_bounty returned the escrow to the payer's compute vault", (await reader.tokenBalance(payerVault))! - pvc0 === ONE / 2n && (await reader.bounty(addr3))!.status === "cancelled");
  await chainSync();
  const mirrored = await ok<any[]>(anon.get(`/v1/bounties?lineage=${L}&status=all`), "bounties");
  check("Core mirrored the three bounties with their open signatures", [addr1, addr2, addr3].every((a) => mirrored.some((x) => x.bounty_id === a && !!x.chain_sig)) &&
    mirrored.find((x) => x.bounty_id === addr3)?.status === "cancelled", `${mirrored.length} on the lineage`);
  const t1 = await anon.put(`/v1/bounties/${addr1}/terms`, b1.terms);
  const tBad = await anon.put(`/v1/bounties/${addr1}/terms`, { ...b1.terms, note: "changed" });
  check("Core keeps the terms only when sha256 equals the onchain terms_digest", t1.status === 200 && tBad.status === 409, `${t1.status} / ${tBad.status}`);
  const hints = await ok<any[]>(anon.get(`/v1/lineages/${L}/bounties`), "hints");
  check("workboard hint: GET /v1/lineages/:id/bounties lists the open bounties", hints.some((h) => h.bounty_id === addr1), `${hints.length} open`);

  // ------------------------------------------------------------ I1: rotate the agent to a runtime key
  const agentKey = key("agent-minbpe");
  const launcher = key("launcher");
  const runtimeKey = key("agent-minbpe-runtime"); // the hosted runtime's own key: the launch key never reaches it
  await topUp(STEP, dep, launcher.id, LAMPORTS / 50n, "launcher", LAMPORTS / 20n);
  let rec0 = (await reader.agent(m.agent))!;
  if (rec0.signingKey !== agentKey.id) {
    // a previous run stopped mid-way: start from the original key
    await send(STEP, `rotate_agent_key ${m.agent} back to its original key (owner and key sign)`, launcher, [registry.rotateAgentKey({ owner: launcher.id, agent: m.agent, newKey: agentKey.id })], { signers: [agentKey] });
    rec0 = (await reader.agent(m.agent))!;
  }
  check("the minbpe Agent record is v2, owned by its launcher, signing with its own key", rec0.version === 2 && rec0.owner === launcher.id && rec0.signingKey === agentKey.id,
    `key_seq ${rec0.keySeq}`);
  await send(STEP, `rotate_agent_key ${m.agent} to runtime key ${runtimeKey.id} (owner and new key sign)`, launcher, [
    registry.rotateAgentKey({ owner: launcher.id, agent: m.agent, newKey: runtimeKey.id }),
  ], { signers: [runtimeKey] });
  const rec1 = (await reader.agent(m.agent))!;
  check("rotate_agent_key landed: signing_key is the runtime key, key_seq advanced", rec1.signingKey === runtimeKey.id && rec1.keySeq === rec0.keySeq + 1,
    `seq ${rec0.keySeq} -> ${rec1.keySeq}`);
  await chainSync();
  const keys1 = await ok(anon.get(`/v1/agents/${m.agent}/keys`), "keys");
  check("Core mirrored the rotation from the registry", keys1.signing_key === runtimeKey.id && keys1.seq === rec1.keySeq, `seq ${keys1.seq}`);
  const oldTry = await new CoreClient(CORE, { id: agentKey.id, secret: agentKey.secret }).get("/v1/assignments", true);
  check("the old agent key gets 401", oldTry.status === 401, `${oldTry.status} ${oldTry.body.error}`);

  // ------------------------------------------------------------ one candidate by the onchain agent, signed by the runtime key
  const w = new Worker({ core: CORE, key: { id: runtimeKey.id, secret: runtimeKey.secret, agent: m.agent } as never, lineages: [L],
    proposer: new ScriptedProposer(loadScript(join(ROOT, "recipes/minbpe/candidates"), ["encode_chunk_cache"])), log: (x) => console.log(`   auth ${x}`) });
  const id = await w.authorOnce();
  if (!id) throw new Error("the author did not submit");
  const final = await waitFor("candidate final", async () => {
    const r = await anon.get(`/v1/candidates/${id}`);
    return r.status === 200 && ["accepted", "rejected", "expired"].includes(r.body.status) ? r.body : null;
  });
  check("encode_chunk_cache accepted by two onchain-bonded verifiers", final.status === "accepted", `${final.status} ${final.reason ?? ""} ${final.effect ? `ratio ${final.effect.ratio}` : ""}`);
  check("the runtime key committed it under the unchanged agent id", final.author === m.agent, `author ${final.author}`);

  // ------------------------------------------------------------ I1: revoke, then rotate back
  await send(STEP, `revoke_agent_key ${m.agent} (owner)`, launcher, [registry.revokeAgentKey({ owner: launcher.id, agent: m.agent })]);
  await chainSync();
  const revRt = await new CoreClient(CORE, { id: runtimeKey.id, secret: runtimeKey.secret, agent: m.agent }).get("/v1/assignments", true);
  const revOld = await new CoreClient(CORE, { id: agentKey.id, secret: agentKey.secret }).get("/v1/assignments", true);
  check("revoked: Core refuses every key (401 key_revoked)", revRt.status === 401 && revRt.body.error === "key_revoked" && revOld.body.error === "key_revoked",
    `${revRt.status} ${revRt.body.error} / ${revOld.status} ${revOld.body.error}`);
  await send(STEP, `rotate_agent_key ${m.agent} back to its original key (owner and key sign)`, launcher, [
    registry.rotateAgentKey({ owner: launcher.id, agent: m.agent, newKey: agentKey.id }),
  ], { signers: [agentKey] });
  await chainSync();
  const back = await new CoreClient(CORE, { id: agentKey.id, secret: agentKey.secret }).get("/v1/assignments", true);
  const hist = await ok(anon.get(`/v1/agents/${m.agent}/keys`), "keys");
  check("rotated back: the original key works again, the key history is public", back.status === 200 && hist.signing_key === agentKey.id && hist.keys.length >= 3,
    hist.keys.map((k: any) => `${k.seq}:${k.signing_key ? k.signing_key.slice(0, 6) : "revoked"}`).join(" "));

  // ------------------------------------------------------------ close the epoch on chain
  const before = await chainSync();
  const closed = await ok(A.post("/v1/admin/epochs/close", {}), "close");
  check("epoch closed with payouts from the onchain pool", BigInt(closed.pool_amount) > 0n && BigInt(closed.pool_amount) <= BigInt(before.balances.pool),
    `epoch ${closed.n}: pool ${closed.pool_amount} of ${before.balances.pool} on chain, rebate ${closed.rebate_amount}, ${closed.payouts.length} leaves`);
  const after = await chainSync();
  const post = (after.posted_epochs as any[]).find((p) => p.n === closed.n);
  check("the bridge posted the epoch root with post_epoch", !!post?.signature, post?.signature ?? post?.error ?? "missing");
  const onchain = await reader.epoch(closed.n);
  check("onchain Epoch equals Core's root, pool and rebate", !!onchain && onchain.payoutRoot === closed.root && onchain.poolAmount === BigInt(closed.pool_amount) && onchain.rebateAmount === BigInt(closed.rebate_amount),
    onchain ? `root ${onchain.payoutRoot.slice(0, 16)}..., payable ${onchain.totalPayable}` : "missing");
  check("onchain Epoch.record_root equals Core's record root (identity plan I2)", !!onchain && onchain.recordRoot === closed.record_root,
    `${String(closed.record_root).slice(0, 16)}...`);
  // the post is a Core transaction: record it in the devnet log too
  if (post?.signature) {
    const t = await rpc.getTransaction(post.signature);
    logTx(STEP, `Core bridge post_epoch ${closed.n} (root ${String(closed.root).slice(0, 16)}...)`, { signature: post.signature, slot: t?.slot ?? 0, fee: t?.meta?.fee, logs: [] });
  }

  // ------------------------------------------------------------ claims on chain
  const agentsPaid = [...new Set((closed.payouts as any[]).map((l) => l.agent as string))];
  for (const a of agentsPaid) {
    for (const p of await ok<any[]>(anon.get(`/v1/epochs/${closed.n}/proofs/${a}`), "proofs")) {
      const c = claimFromCoreProof(p);
      const destToken = p.dest.endsWith(":compute") ? launchPdas.computeVault(a) : ata(owner.id, lineMint, T22);
      const b0 = (await reader.tokenBalance(destToken))!;
      await send(STEP, `claim epoch ${closed.n} ${p.dest} ${p.amount}`, dep, [registry.claim({ payer: dep.id, mint: lineMint, ...c, destToken, tokenProgram: T22 })]);
      const b1 = (await reader.tokenBalance(destToken))!;
      check(`claim paid ${p.dest.split(":").slice(-1)[0]} of ${a.slice(0, 8)} exactly`, b1 - b0 === BigInt(p.amount), `${b1 - b0}`);
    }
  }
  const ep = (await reader.epoch(closed.n))!;
  check("every leaf claimed on chain; claimed equals payable", ep.claims === closed.payouts.length && ep.claimedAmount === ep.totalPayable, `${ep.claimedAmount} / ${ep.totalPayable}`);
  await chainSync();
  const claimedViews = await Promise.all(agentsPaid.map((a) => ok<any[]>(anon.get(`/v1/epochs/${closed.n}/proofs/${a}`), "proofs")));
  check("Core mirrored every onchain claim", claimedViews.flat().every((p) => p.claimed === true));
  const rec = await ok(anon.get("/v1/ledger/reconcile"), "reconcile");
  check("Core ledger reconciles with the chain mirror", rec.ok === true, rec.errors?.slice(0, 2).join("; "));
  const chainView = await ok(anon.get("/v1/chain"), "chain view");
  const stats = await ok(anon.get("/v1/stats"), "stats");
  check("dashboard reads: /v1/chain and /v1/stats carry the vault balances read at a slot", chainView.slot > 0 && stats.chain?.balances?.pool === chainView.balances.pool,
    JSON.stringify(chainView.balances));

  // ------------------------------------------------------------ C6: release the bounty with Core's contribution proof
  await chainSync();
  const rel = await ok(anon.get(`/v1/bounties/${addr1}/release`), "release");
  const cand = (rel.candidates as any[]).find((c) => c.epoch === closed.n && c.payees.includes(m.agent));
  const ep1 = (await reader.epoch(closed.n))!;
  check("Core offers the accepted generation as the release, its proof verifies against the onchain record root", !!cand && cand.record_root === ep1.recordRoot &&
    releaseFromContribution(cand.contribution, cand.proof, ep1.recordRoot!).leaf === cand.leaf, cand ? `gen ${String(cand.gen_id).slice(0, 12)}..., leaf ${String(cand.leaf).slice(0, 12)}...` : "none");
  const mv0 = (await reader.tokenBalance(launchPdas.computeVault(m.agent)))!;
  const relIx = bounty.release({ caller: dep.id, payer: payerA.agent, bountyId: b1.id, opener: runtimeAuth.id, payee: m.agent, payeeMint: m.mint!, lineMint,
    contribution: cand.contribution, proof: cand.proof, lineTokenProgram: T22 });
  const relTx = await send(STEP, `release_bounty ${b1.id}: 2 tLINE to ${m.agent} for gen ${String(cand.gen_id).slice(0, 12)}... (epoch ${closed.n} record root)`, dep, [relIx],
    { computeUnits: 400_000 });
  const mv1 = (await reader.tokenBalance(launchPdas.computeVault(m.agent)))!;
  const after1 = (await reader.bounty(addr1))!;
  const rcpt = await rpc.getAccountInfo(bountyPdas.receipt(payerA.agent, cand.leaf));
  check("release_bounty paid exactly 2 tLINE into the payee's compute vault, with a receipt", mv1 - mv0 === 2n * ONE && after1.status === "released" &&
    after1.releasedTo === m.agent && after1.leaf === cand.leaf && !!rcpt, `${relTx.signature} (${relTx.computeUnits ?? "?"} CU)`);
  let again = "";
  try {
    await send(STEP, `release_bounty ${b1.id} again (must fail)`, dep, [relIx], { computeUnits: 400_000 });
    again = "landed";
  } catch (e) {
    again = (e as Error).message.slice(0, 80);
  }
  check("a second release of the same bounty is refused", again !== "landed", again);
  await chainSync();
  const v1 = await ok(anon.get(`/v1/bounties/${addr1}`), "bounty");
  check("Core mirrored the release", v1.status === "released" && v1.released_to === m.agent && v1.leaf === cand.leaf);

  // ------------------------------------------------------------ I2: credentials verify from chain alone
  const credV = await ok(anon.get(`/v1/agents/${vkeys.v1.id}/credential`), "credential");
  const roots = new Map<number, string | null>();
  for (const e of credV.epochs as { epoch: number }[]) roots.set(e.epoch, (await reader.epoch(e.epoch))?.recordRoot ?? null);
  const vres = verifyCredential(credV, roots);
  check("verifier v1's credential verifies against the onchain record roots alone", vres.ok && vres.checked > 0,
    `${vres.checked} leaves, totals ${JSON.stringify({ replays: vres.totals.replays, counted: vres.totals.replays_counted })}, issuer ${credV.issuer}`);
  const credFile = join(tmp, "credential-v1.json");
  writeFileSync(credFile, JSON.stringify(credV));
  const script = (extra: string[]) => Bun.spawnSync(["bun", join(ROOT, "scripts/verify-credential.ts"), "--file", credFile, ...extra], { env: process.env });
  const sOk = script([]);
  const sTamper = script(["--tamper"]);
  check("scripts/verify-credential.ts: the credential verifies; altering one record fails", sOk.exitCode === 0 && sTamper.exitCode === 0 && /"ok": false/.test(sTamper.stdout.toString()),
    `exit ${sOk.exitCode} / tamper exit ${sTamper.exitCode}`);
  const credA = await ok(anon.get(`/v1/agents/${m.agent}/credential`), "credential");
  const ares = verifyCredential(credA, roots);
  check("the minbpe agent's credential carries its accepted generation and verifies", ares.ok && credA.totals.accepted >= 1 && credA.totals.contributions >= 1,
    `accepted ${credA.totals.accepted}, contributions ${credA.totals.contributions}`);

  // ------------------------------------------------------------ two-step public owner transfer (and back)
  const ref = vkeys.ref;
  const newOwner = key("owner-transfer-test");
  await send(STEP, `propose_owner ${ref.id} to ${newOwner.id}`, owner, [registry.proposeOwner({ owner: owner.id, agent: ref.id, newOwner: newOwner.id })]);
  await send(STEP, `accept_owner ${ref.id} by ${newOwner.id} (deployer pays the fee)`, dep, [registry.acceptOwner({ newOwner: newOwner.id, agent: ref.id })], { signers: [newOwner] });
  const rref = (await reader.agent(ref.id))!;
  await chainSync();
  const refView = await ok(anon.get(`/v1/agents/${ref.id}`), "ref");
  const refCred = await ok(anon.get(`/v1/agents/${ref.id}/credential`), "credential");
  check("owner transfer: chain owner and owner_since mirrored as controller_since", rref.owner === newOwner.id && refView.identity.owner === newOwner.id &&
    refView.identity.controller_since === Number(rref.ownerSince) * 1000 && refCred.controller_since === Number(rref.ownerSince) * 1000, `owner_since ${rref.ownerSince}`);
  await send(STEP, `propose_owner ${ref.id} back to ${owner.id} (deployer pays the fee)`, dep, [registry.proposeOwner({ owner: newOwner.id, agent: ref.id, newOwner: owner.id })], { signers: [newOwner] });
  await send(STEP, `accept_owner ${ref.id} by ${owner.id}`, owner, [registry.acceptOwner({ newOwner: owner.id, agent: ref.id })]);
  check("owner transferred back", (await reader.agent(ref.id))!.owner === owner.id);

  // ------------------------------------------------------------ C6: refund after the deadline plus grace
  const b2acct = (await reader.bounty(addr2))!;
  const due = Number(b2acct.deadline) + (bcfg?.refundGraceS ?? 0) + 2;
  let early = "";
  if (Math.floor(Date.now() / 1000) <= due - 4) {
    try {
      await send(STEP, `refund_bounty ${b2.id} before the deadline plus grace (must fail)`, dep, [bounty.refund({ payer: payerA.agent, payerMint: payerA.mint!, bountyId: b2.id,
        opener: runtimeAuth.id, lineMint, lineTokenProgram: T22 })]);
      early = "landed";
    } catch (e) {
      early = (e as Error).message.slice(0, 80);
    }
    check("an early refund is refused", early !== "landed", early);
  }
  while (Math.floor(Date.now() / 1000) < due) await Bun.sleep(2000);
  const pr0 = (await reader.tokenBalance(payerVault))!;
  await send(STEP, `refund_bounty ${b2.id} after the deadline plus grace (anyone; deployer pays the fee)`, dep, [bounty.refund({ payer: payerA.agent, payerMint: payerA.mint!,
    bountyId: b2.id, opener: runtimeAuth.id, lineMint, lineTokenProgram: T22 })]);
  check("refund_bounty returned exactly 1 tLINE to the payer's compute vault", (await reader.tokenBalance(payerVault))! - pr0 === ONE && (await reader.bounty(addr2))!.status === "refunded");

  writeFileSync(join(ROOT, "scripts/devnet/E2E-DEVNET-LAST.json"), JSON.stringify({ at: new Date().toISOString(), seconds: Math.round((Date.now() - T0) / 1000), epoch: closed.n,
    post_epoch: post?.signature ?? null, payouts: closed.payouts, chain: chainView, results }, null, 2) + "\n");
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
  const endSol = await rpc.getBalance(dep.id);
  log(`${results.length - bad.length}/${results.length} checks passed in ${((Date.now() - T0) / 1000).toFixed(0)}s; deployer spent or moved ${sol(startSol - endSol)} SOL`);
  if (!KEEP) rmSync(tmp, { recursive: true, force: true });
  else log(`kept ${tmp}`);
  process.exit(failed || bad.length ? 1 : 0);
}
