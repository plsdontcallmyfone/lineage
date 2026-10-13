#!/usr/bin/env bun
// units_bounty on devnet, end to end (docs/plans/OPEN-BOUNTIES.md option A): a wallet that owns no
// agent posts bounties from its own test UNITS; a launched agent's candidate is replayed by two
// onchain-bonded verifiers in Docker sandboxes and accepted; Core (chain mode, feature open_bounties
// on) writes its result leaf into the epoch's record root; the root is posted on the registry; Core
// mirrors the bounty, names the winner and serves the claim proof; the claim, the payout into the
// agent's compute vault and the refund of an expired bounty to its funder are sent on chain and read
// back exactly. Forged and early instructions are sent too and must be refused. The program has no
// cancel: the instruction an earlier build had is sent as that build's client sent it and must be unknown,
// and a refund before the refund time must be refused, for the funder as for anyone.
//
// The devnet registry is shared with the devnet site's Core, which posts the registry's next epoch
// number. This run must not take that number: its Core runs with --first-epoch at a number far above
// the registry's, and its one epoch is posted by ONE transaction signed by the registry admin and the
// Core authority: set_epoch_cursor to just below the number, post_epoch (pool 0, rebate 0, so no
// payout of it is claimable and no vault moves), set_epoch_cursor back to what it was. The cursor is
// never seen moved by anyone else, and the site's next epoch posts as before.
//
// The run takes about five minutes and its waits are wall-clock ones: run it on a machine that stays awake
// (`caffeinate -i -s bun scripts/devnet/open-bounty-e2e.ts` on a Mac). On a machine that sleeps in the
// middle, waits end early and the run stops; what it had sent stays valid and the next run tidies it up.
//
// First run with --init once after the program is deployed (the upgrade authority initializes).
// Usage: bun scripts/devnet/open-bounty-e2e.ts [--init] [--port 9663] [--keep]
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, generateAgentKey, H, hashJson, type AgentKey } from "@units/protocol";
import { loadRecipe, prepareDeps } from "@units/sandbox";
import {
  ata, BOUNTY_PROGRAM_ID, bountyTargetDigest, buildTransaction, claimFromResult, computeBudget, IDENTITY_MODE, ixDisc, launch, launchPdas, openBounty, openBountyPdas, paramsFromNetworkJson, registry, registryPdas,
  token, TOKEN_2022_PROGRAM, type BountyResult, type Ix, type OpenBountySettings, type Signer,
} from "@units/chain";
import { CoreClient } from "../../packages/core/src/client.ts";
import { doctor } from "../../packages/worker/src/doctor.ts";
import { loadScript, ScriptedProposer, Worker } from "../../packages/worker/src/index.ts";
import { deployer, key, KEY_DIR, LAMPORTS, loadState, logTx, reader, ROOT, RPC_URL, rpc, send, sol, topUp } from "./lib.ts";
import { launchTable, pumpLaunchTx } from "./pump-lib.ts";

const argv = process.argv.slice(2);
const PORT = Number(argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : 9663);
const KEEP = argv.includes("--keep");
const CORE = `http://127.0.0.1:${PORT}`;
const T0 = Date.now();
const T22 = TOKEN_2022_PROGRAM;
const STEP = "open-bounty";
const OUT = join(import.meta.dir, "OPEN-BOUNTY-E2E-LAST.json");

const log = (m: string) => console.log(`[open-bounty +${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
const results: { check: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ check: name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
}
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

const state = loadState();
const net = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
const DECIMALS = state.line_decimals!;
const ONE = 10n ** BigInt(DECIMALS);
const params = paramsFromNetworkJson(net, DECIMALS);
const lineMint = state.line_mint!;
const dep = deployer();
const nowS = () => BigInt(Math.floor(Date.now() / 1000));
/** The cluster's own clock (the newest block's time): deadlines and waits are measured on it, since it drifts from this machine's. */
async function chainNow(): Promise<bigint> {
  for (let i = 0; ; i++) {
    const t = await rpc.call<number | null>("getBlockTime", [await rpc.call<number>("getSlot", [{ commitment: "confirmed" }])]).catch(() => null);
    if (t) return BigInt(t);
    if (i > 10) return nowS();
    await Bun.sleep(400);
  }
}

/** What the program runs with on devnet after the proof (every value is an admin setting). */
const FINAL: OpenBountySettings = { minAmount: ONE, minTtlS: 3_600, maxTtlS: 30 * 86_400, refundGraceS: 86_400, contestS: 3_600, feeBps: 0, paused: false };
/** Short times for the proof: a bounty that expires and refunds inside the run. */
const PROOF: OpenBountySettings = { ...FINAL, minTtlS: 60, refundGraceS: 60, contestS: 45 };

async function lineTo(owner: string, min: bigint, label: string) {
  const dest = ata(owner, lineMint, T22);
  const bal = (await reader.tokenBalance(dest)) ?? 0n;
  if (bal >= min) return dest;
  await send(STEP, `send ${min - bal} UNITS base units to ${label} ${owner}`, dep, [
    token.createAtaIdempotent(dep.id, owner, lineMint, T22),
    token.transferChecked(ata(dep.id, lineMint, T22), lineMint, dest, dep.id, min - bal, DECIMALS, T22), // the deployer's own test UNITS
  ]);
  return dest;
}
/** A transaction that must be refused: simulated only, so nothing is sent and no fee is paid. The program's error name, or null if it would succeed. */
async function refused(payer: Signer, ixs: Ix[], signers: Signer[] = []): Promise<string | null> {
  const { blockhash } = await rpc.getLatestBlockhash();
  const sim = await rpc.simulate(buildTransaction(payer, [computeBudget.limit(400_000), ...ixs], blockhash, signers).wire);
  if (!sim.err) return null;
  const logs = (sim.logs ?? []).join("\n");
  return /Error Code: (\w+)/.exec(logs)?.[1] ?? JSON.stringify(sim.err);
}
/** The `cancel` instruction of the build before 2026-10-13, as its client sent it: the refund accounts, the registry's Config, the funder as signer. */
const oldCancel = (bounty: string, funder: string): Ix => ({ programId: BOUNTY_PROGRAM_ID, data: ixDisc("cancel"),
  keys: [...openBounty.refund({ bounty, funder, mint: lineMint, tokenProgram: T22 }).keys, { pubkey: registryPdas.config(), isSigner: false, isWritable: false },
    { pubkey: funder, isSigner: true, isWritable: false }] });
/** An instruction with its last account (a signer slot) replaced. */
const lastKey = (ix: Ix, pubkey: string): Ix => ({ ...ix, keys: ix.keys.map((k, i, all) => (i === all.length - 1 ? { ...k, pubkey } : k)) });

if (argv.includes("--init")) {
  const have = await reader.openBountyConfig();
  if (have) console.log(`units_bounty ${BOUNTY_PROGRAM_ID} is already initialized: ${JSON.stringify(have, big)}`);
  else {
    const r = await send(STEP, `initialize units_bounty ${BOUNTY_PROGRAM_ID} (admin ${dep.id}, mint ${lineMint})`, dep,
      [openBounty.initialize({ upgradeAuthority: dep.id, admin: dep.id, mint: lineMint, settings: FINAL, tokenProgram: T22 })], { computeUnits: 200_000 });
    console.log(`initialized: ${r.signature}\n${JSON.stringify(await reader.openBountyConfig(), big, 1)}`);
  }
  process.exit(0);
}

const busy = Bun.spawnSync(["lsof", "-ti", `:${PORT}`]).stdout.toString().trim();
if (busy) {
  console.error(`port ${PORT} busy (pid ${busy}); pick another of 9663, 9666-9669`);
  process.exit(1);
}
const tmp = mkdtempSync(join(tmpdir(), "units-open-bounty-"));
const procs: Subprocess[] = [];
const watched: string[] = [];
const balances = async () => Object.fromEntries(await Promise.all(watched.map(async (a) => [a, await rpc.getBalance(a)] as const)));

function startWorker(name: string, keyPath: string): Subprocess {
  const p = spawn(["bun", join(ROOT, "packages/worker/src/main.ts"), "run", "--core", CORE, "--key", keyPath, "--interval", "1000"], { stdout: "pipe", stderr: "pipe", env: process.env });
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

async function onchainVerifier(owner: Signer, agent: Signer, caps: unknown, bond: bigint) {
  const capsDigest = H("caps", canonicalJson(caps));
  let rec = await reader.agent(agent.id);
  const ownerLine = ata(owner.id, lineMint, T22);
  if (!rec) {
    await lineTo(owner.id, params.registerBurn + bond, "verifier owner");
    await send(STEP, `register verifier ${agent.id}`, owner, [
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

async function main() {
  // ------------------------------------------------------------ preflight
  const cfg0 = await reader.openBountyConfig();
  if (!cfg0) throw new Error(`units_bounty ${BOUNTY_PROGRAM_ID} is not initialized: run with --init`);
  const reg0 = (await reader.registryConfig())!;
  check("units_bounty is initialized on the registry's mint and launch program", cfg0.mint === reg0.mint && cfg0.launchProgram === reg0.launchProgram && cfg0.admin === dep.id,
    `program ${BOUNTY_PROGRAM_ID}, mint ${cfg0.mint}`);
  const openCh = (await reader.challenges()).filter((c) => c.status === "open");
  if (openCh.length) throw new Error(`${openCh.length} challenge(s) open on the devnet registry: a local Core holding the Core authority key would act on them; not starting`);
  if (reg0.coreAuthority !== state.core_authority) throw new Error("the registry's Core authority is not the one in scripts/devnet/devnet.json");
  const coreAuth = key("core-authority");
  if (coreAuth.id !== reg0.coreAuthority || dep.id !== reg0.admin) throw new Error("the local Core authority or deployer key is not the registry's");

  // escrows an earlier, stopped run left behind: anyone returns an expired one to its funder
  const t0 = await chainNow();
  for (const b of await reader.openBounties()) {
    if (b.status !== "open") continue;
    if (b.winner && t0 >= b.contestUntil) await send(STEP, `pay ${b.address} of an earlier run to its named winner ${b.winner}`, dep,
      [openBounty.pay({ bounty: b.address, funder: b.funder, winner: b.winner, mint: lineMint, tokenProgram: T22 })]).catch(() => undefined);
    else if (!b.winner && t0 > b.refundAfter) await send(STEP, `refund ${b.address} of an earlier run to its funder ${b.funder}`, dep,
      [openBounty.refund({ bounty: b.address, funder: b.funder, mint: lineMint, tokenProgram: T22 })]).catch(() => undefined);
  }
  const funder = key("bounty-funder"); // owns no agent
  const caller = key("bounty-caller"); // sends the permissionless instructions
  const launcher = key("bounty-proof-launcher");
  const agentKey = key("bounty-proof-agent");
  const mintKey = key("bounty-proof-mint");
  const owner = key("verifier-owner");
  const names = ["ref", "v1", "v2"] as const;
  const vkeys = Object.fromEntries(names.map((n) => [n, key(`verifier-${n}`)])) as Record<(typeof names)[number], Signer>;
  watched.push(dep.id, funder.id, caller.id, launcher.id, owner.id, coreAuth.id);
  const sol0 = await balances();
  await topUp(STEP, dep, funder.id, LAMPORTS / 20n, "bounty funder", LAMPORTS / 10n);
  await topUp(STEP, dep, caller.id, LAMPORTS / 50n, "caller", LAMPORTS / 20n);
  await topUp(STEP, dep, launcher.id, LAMPORTS / 10n, "launcher", LAMPORTS / 5n);
  await topUp(STEP, dep, owner.id, LAMPORTS / 20n, "verifier owner", LAMPORTS / 10n);
  await topUp(STEP, dep, coreAuth.id, LAMPORTS / 50n, "Core authority", LAMPORTS / 10n);
  check("the funder owns no agent", !(await reader.agents()).some((a) => a.owner === funder.id || a.agent === funder.id), funder.id);

  // ------------------------------------------------------------ verifiers and the agent, on chain
  const caps = doctor().capabilities;
  for (const n of names) {
    const rec = await onchainVerifier(owner, vkeys[n], caps, n === "ref" ? 0n : params.minBond);
    check(`verifier ${n} registered on chain${n === "ref" ? "" : " and bonded"}`, rec.kind === "verifier" && rec.bond >= (n === "ref" ? 0n : params.minBond), `${vkeys[n].id} bond ${rec.bond}`);
  }
  const loaded = loadRecipe(join(ROOT, "recipes/minbpe"));
  const lcfg = (await reader.launchConfig())!;
  if (!(await reader.agent(agentKey.id))) {
    const credits = lcfg.wakeThreshold > 50n * ONE ? lcfg.wakeThreshold : 50n * ONE;
    await lineTo(launcher.id, credits, "launcher");
    const r = await pumpLaunchTx(rpc, { launcher, agent: agentKey, mint: mintKey, lineMint, name: "TEST Bounty Proof", symbol: "TBNTY", uri: "https://units.gg/test/tbnty.json",
      args: { repoUrl: loaded.recipe.repo, identityMode: IDENTITY_MODE.app, hosted: false }, deposit: { amount: credits, decimals: DECIMALS }, table: await launchTable(rpc, state as never) });
    for (const t of r.sent) logTx(STEP, `launch TEST agent TBNTY ${agentKey.id} on ${loaded.recipe.repo} (${r.plan.mode})`, { signature: t.signature, fee: t.fee ?? undefined, slot: 0, logs: [] });
  }
  const rec = (await reader.agent(agentKey.id))!;
  const vault = launchPdas.computeVault(agentKey.id);
  // Core wakes a launch only at its prepaid minimum (config prepay: 10 USD of credits at the test rate): the vault is topped up to 400 test UNITS
  const need = 400n * ONE - ((await reader.tokenBalance(vault)) ?? 0n);
  if (need > 0n) await send(STEP, `top up the TEST agent's compute vault with ${need} base units, then refresh_awake`, dep, [
    token.transferChecked(ata(dep.id, lineMint, T22), lineMint, vault, dep.id, need, DECIMALS, T22), launch.refreshAwake({ agent: agentKey.id, agentMint: mintKey.id })]);
  check("a TEST agent is launched on chain on the unit's repository, with a compute vault", rec.kind === "launched" && rec.mint === mintKey.id && (await reader.tokenBalance(vault)) !== null,
    `agent ${agentKey.id}, coin ${mintKey.id}`);

  // ------------------------------------------------------------ Core in chain mode, epochs far above the registry's
  const first = 1_000_000_000 + (Math.floor(Date.now() / 1000) % 1_000_000_000); // below 2^31, far above the registry's, new on every run
  const admin: AgentKey = generateAgentKey();
  const adminPath = join(tmp, "admin.json");
  writeFileSync(adminPath, JSON.stringify(Array.from(admin.secret)), { mode: 0o600 });
  Object.assign(net, { canary_rate: 0, audit_rate: 0, epoch_length_s: 86400, reveal_window_s: 600, replay_window_min_s: 600, qualify_retry_s: 60 });
  // the same endpoint as this script (a keyed one when ~/.config/units/rpc.env names it): Core's first chain read is hundreds of calls
  net.chain = { mode: "devnet", rpc_url: RPC_URL, registry_program: state.registry_program, launch_program: state.launch_program, line_mint: lineMint,
    core_authority_key: state.core_authority_key, poll_ms: 10000 };
  writeFileSync(join(tmp, "network.json"), JSON.stringify(net), { mode: 0o600 });
  const env = { ...process.env, UNITS_NETWORK: "devnet", UNITS_FEATURE_OPEN_BOUNTIES: "1" };
  const core = spawn(["bun", join(ROOT, "packages/core/src/main.ts"), "--data", join(tmp, "data"), "--port", String(PORT), "--config", join(tmp, "network.json"), "--admin-key", adminPath,
    "--tick-ms", "500", "--first-epoch", String(first)], { stdout: "inherit", stderr: "inherit", env });
  procs.push(core);
  await waitFor("core", async () => (await fetch(`${CORE}/v1/health`).catch(() => null))?.ok); // its first chain read is hundreds of RPC calls (about 40 s)
  const A = new CoreClient(CORE, admin);
  const anon = new CoreClient(CORE, null);
  const chainSync = async (): Promise<any> => {
    for (let i = 0; ; i++) {
      const r = await A.post("/v1/admin/chain/sync", {});
      if (r.status < 300) return r.body;
      if (i >= 8 || !/429|Too Many|rate/i.test(JSON.stringify(r.body))) throw new Error(`chain sync: ${r.status} ${JSON.stringify(r.body)}`);
      await Bun.sleep(2000 * 2 ** Math.min(i, 4));
    }
  };
  const chain0 = await chainSync();
  check("Core reads the escrow program from chain and offers posting to any wallet", chain0.open_bounties?.configured === true && chain0.open_bounties.program === BOUNTY_PROGRAM_ID,
    JSON.stringify(chain0.open_bounties?.settings));
  check("this Core's epochs start far above the registry's", (await ok(anon.get("/v1/health"), "health")).epoch === first && BigInt(first) > reg0.lastEpoch + 1_000_000n,
    `first epoch ${first}; registry last ${reg0.lastEpoch}`);

  // ------------------------------------------------------------ the unit: minbpe
  const deps = await prepareDeps(loaded);
  await ok(A.post("/v1/admin/recipes", { recipe: loaded.recipe, recipe_id: loaded.recipe_id }), "recipe");
  const snap = await ok(A.post("/v1/admin/snapshots", { repo: loaded.recipe.repo, commit: loaded.recipe.commit, deps_digest: deps.digest }), "snapshot");
  await ok(A.post(`/v1/admin/agents/${vkeys.ref.id}/reference`, { reference: true }), "reference");
  const refWorker = new Worker({ core: CORE, key: { id: vkeys.ref.id, secret: vkeys.ref.secret }, log: (x) => console.log(`   ref  ${x}`) });
  await refWorker.declareCapabilities();
  log("reference runner calibrating minbpe in the sandbox");
  await refWorker.submitCalibration(loaded.recipe_id, snap.snapshot_id, 3);
  const L = ((await ok<any[]>(anon.get("/v1/lineages"), "units")).find((l) => l.recipe_id === loaded.recipe_id) ?? (await ok<any[]>(anon.get("/v1/lineages"), "units"))[0]).lineage_id as string;
  startWorker("ref", join(KEY_DIR, "verifier-ref.json"));
  startWorker("v1", join(KEY_DIR, "verifier-v1.json"));
  startWorker("v2", join(KEY_DIR, "verifier-v2.json"));
  await waitFor("verifiers qualified", async () => {
    const vs = await Promise.all((["v1", "v2"] as const).map((n) => ok(anon.get(`/v1/agents/${vkeys[n].id}`), n)));
    return vs.every((v) => v.qualified_lineages.includes(L)) ? vs : null;
  });
  const author0 = await ok(anon.get(`/v1/agents/${agentKey.id}`), "agent");
  check("the unit exists, two bonded verifiers are qualified, the agent is active and awake", author0.lifecycle === "active" && author0.kind === "launched" && author0.awake === true, `unit ${L.slice(0, 12)}`);

  // ------------------------------------------------------------ the admin shortens the times for this run
  await send(STEP, "set_settings: proof values (deadline from 60 s, grace 60 s, contest 45 s)", dep, [openBounty.setSettings({ admin: dep.id, settings: PROOF })]);
  const notAdmin = await refused(caller, [openBounty.setSettings({ admin: caller.id, settings: { ...PROOF, feeBps: 9_000 } })]);
  check("settings are the admin's: another signer is refused", notAdmin === "Unauthorized", String(notAdmin));

  // ------------------------------------------------------------ a wallet with no agent posts
  const METRIC = "train_ir";
  const funderToken = await lineTo(funder.id, 20n * ONE, "bounty funder");
  const tOpen = await chainNow();
  const f0 = (await reader.tokenBalance(funderToken))!;
  const base = BigInt(Date.now());
  const mk = (id: bigint, o: { amount: bigint; bps: number; ttl: bigint; note: string }) => {
    const terms = { v: 1, kind: "improvement", lineage_id: L, metric: METRIC, min_improvement_bps: o.bps, note: o.note };
    const args = { bountyId: id, amount: o.amount, termsDigest: hashJson(terms), lineageId: L, targetDigest: bountyTargetDigest(METRIC), minImprovementBps: o.bps, deadline: tOpen + o.ttl };
    return { id, terms, args, address: openBountyPdas.bounty(funder.id, id), ix: openBounty.open({ funder: funder.id, mint: lineMint, tokenProgram: T22, args }) };
  };
  const b1 = mk(base, { amount: 5n * ONE, bps: 1_000, ttl: 3_600n, note: "Train at least 10% faster" });
  const b2 = mk(base + 1n, { amount: 2n * ONE, bps: 9_500, ttl: 3_600n, note: "A result nothing reaches: stays open" });
  const b3 = mk(base + 2n, { amount: ONE, bps: 9_600, ttl: 3_600n, note: "Its poster tries to take it back: stays escrowed" });
  const fSol0 = await rpc.getBalance(funder.id);
  for (const b of [b1, b2, b3]) await send(STEP, `open_bounty ${b.id}: ${b.args.amount} base units on ${METRIC} of unit ${L.slice(0, 12)}, at least ${b.args.minImprovementBps} bps (funder ${funder.id})`, funder, [b.ix], { computeUnits: 200_000 });
  const fSol1 = await rpc.getBalance(funder.id);
  const f1 = (await reader.tokenBalance(funderToken))!;
  const acct1 = (await reader.openBountyAccount(b1.address))!;
  check("three bounties escrowed exactly 8 test UNITS from the funder's own token account", f0 - f1 === 8n * ONE && (await reader.tokenBalance(openBountyPdas.vault(b1.address))) === 5n * ONE,
    `${f0} -> ${f1}; the three opens cost the funder ${sol(fSol0 - fSol1)} SOL (rent of 3 bounty and 3 escrow accounts, fees)`);
  check("the bounty holds its terms and the settings in force at the open", acct1.funder === funder.id && acct1.minImprovementBps === 1_000 && acct1.contestS === PROOF.contestS &&
    acct1.refundAfter === acct1.deadline + BigInt(PROOF.refundGraceS) && acct1.minEpoch === reg0.lastEpoch + 1n && acct1.feeBps === 0, `min_epoch ${acct1.minEpoch}, deadline ${acct1.deadline}`);
  const dust = await refused(funder, [openBounty.open({ funder: funder.id, mint: lineMint, tokenProgram: T22, args: { ...b1.args, bountyId: base + 9n, amount: ONE - 1n } })]);
  const stolen = await refused(caller, [openBounty.open({ funder: caller.id, mint: lineMint, tokenProgram: T22, funderToken, args: { ...b1.args, bountyId: base + 9n } })]);
  check("an open below the minimum, and an open from somebody else's token account, are refused", dust === "InvalidArgs" && stolen === "ConstraintTokenOwner", `${dust} / ${stolen}`);
  // no cancel: before any epoch is posted since the open (when the earlier build let the funder take the reward back)
  const takeBack = await refused(funder, [oldCancel(b3.address, funder.id)]);
  const takeBackOther = await refused(caller, [lastKey(oldCancel(b3.address, funder.id), caller.id)]);
  const earlyRefund = await refused(funder, [openBounty.refund({ bounty: b3.address, funder: funder.id, mint: lineMint, tokenProgram: T22 })]);
  const acct3 = (await reader.openBountyAccount(b3.address))!;
  check("a posted reward cannot be taken back: the program has no cancel instruction, and a refund before the refund time is refused for its funder too",
    takeBack === "InstructionFallbackNotFound" && takeBackOther === "InstructionFallbackNotFound" && earlyRefund === "NotExpired" && acct3.status === "open" &&
    (await reader.tokenBalance(openBountyPdas.vault(b3.address))) === ONE && (await reader.tokenBalance(funderToken))! === f1,
    `cancel by the funder: ${takeBack}; by another wallet: ${takeBackOther}; refund now: ${earlyRefund}; escrow still ${ONE} base units, refund time ${acct3.refundAfter}`);
  await chainSync();
  for (const b of [b1, b2, b3]) await ok(anon.put(`/v1/bounties/${b.address}/terms`, b.terms), "terms");
  const board0 = await ok(anon.get("/v1/bounties/board"), "board");
  const row0 = board0.bounties.find((x: any) => x.bounty_id === b1.address);
  check("Core's board: posting open to any wallet, the bounty listed with its unit, metric and requirement", board0.posting.any_wallet === true && row0?.kind === "escrow" &&
    row0.funder === funder.id && row0.metric?.name === METRIC && row0.required.bps === 1_000 && row0.state === "open" && !!row0.chain_sig, `${board0.bounties.length} bounties; ${row0?.repo}`);
  const hints = await ok<any[]>(anon.get(`/v1/lineages/${L}/bounties`), "hints");
  check("agents see it as a workboard hint of the unit", hints.some((h) => h.bounty_id === b1.address && h.metric === METRIC && h.min_improvement_bps === 1_000), `${hints.length} hints`);

  // ------------------------------------------------------------ the agent's work, replayed and accepted
  const w = new Worker({ core: CORE, key: { id: agentKey.id, secret: agentKey.secret }, lineages: [L],
    proposer: new ScriptedProposer(loadScript(join(ROOT, "recipes/minbpe/candidates"), ["train_dedupe_chunks"])), log: (x) => console.log(`   auth ${x}`) });
  const id = await w.authorOnce();
  if (!id) throw new Error("the author did not submit");
  const final = await waitFor("candidate final", async () => {
    const r = await anon.get(`/v1/candidates/${id}`);
    return r.status === 200 && ["accepted", "rejected", "expired"].includes(r.body.status) ? r.body : null;
  });
  check("the agent's candidate is accepted by two onchain-bonded verifiers' replays", final.status === "accepted" && final.author === agentKey.id,
    `${final.status} ${final.reason ?? ""} ${final.effect ? `${final.effect.metric} ratio ${final.effect.ratio}` : ""}`);

  // ------------------------------------------------------------ the epoch: closed by Core, posted in one transaction
  const closed = await ok(A.post("/v1/admin/epochs/close", {}), "close");
  const regA = (await reader.registryConfig())!;
  const post = await send(STEP, `post_epoch ${closed.n} between two set_epoch_cursor (registry admin + Core authority, one transaction; pool 0, rebate 0)`, dep, [
    registry.setEpochCursor({ admin: dep.id, epochsPosted: regA.epochsPosted, lastEpoch: BigInt(closed.n) - 1n, anchor: BigInt(closed.n) - 1n, anchorTs: nowS() - 3_600n }), // an hour back: the chain's clock may trail this machine's
    registry.postEpoch({ coreAuthority: coreAuth.id, mint: regA.mint, epoch: closed.n, payoutRoot: closed.root, lineageRoot: closed.lineage_root, recordRoot: closed.record_root,
      totalUnitsMicro: 0n, poolAmount: 0n, rebateAmount: 0n, tokenProgram: T22 }),
    registry.setEpochCursor({ admin: dep.id, epochsPosted: regA.epochsPosted, lastEpoch: regA.lastEpoch, anchor: regA.epochAnchor!, anchorTs: regA.epochAnchorTs! }),
  ], { signers: [coreAuth], computeUnits: 300_000 });
  const regB = (await reader.registryConfig())!;
  const ep = (await reader.epoch(closed.n))!;
  check("the epoch's record root is on the registry, and the registry's cursor is exactly what it was", ep.recordRoot === closed.record_root && regB.epochsPosted === regA.epochsPosted &&
    regB.lastEpoch === regA.lastEpoch && regB.epochAnchor === regA.epochAnchor && regB.epochAnchorTs === regA.epochAnchorTs && ep.totalPayable === 0n,
    `epoch ${closed.n} ${post.signature}; cursor ${regB.epochsPosted} posted, last ${regB.lastEpoch}`);
  await waitFor("Core records the epoch as posted", async () => ((await chainSync()).posted_epochs as any[]).some((p) => p.n === closed.n && p.signature), 180_000);

  // ------------------------------------------------------------ Core names the winner and serves the proof
  const view = await ok(anon.get(`/v1/bounties/${b1.address}/view`), "view");
  const claim = await ok(anon.get(`/v1/bounties/${b1.address}/claim`), "claim");
  const cand = (claim.candidates as { result: BountyResult; proof: string[]; record_root: string; winner: boolean }[])[0];
  check("Core names the agent's generation as the winner by the program's rule", view.bounty.state === "decided" && view.bounty.winner?.author === agentKey.id && view.next.action === "claim" &&
    !!cand && cand.winner && cand.result.gen_id === final.gen_id && cand.record_root === ep.recordRoot,
    cand ? `generation ${cand.result.gen_id.slice(0, 12)} height ${cand.result.height}, ${cand.result.improvement_bps} bps (required 1000)` : "no candidate");
  const c = claimFromResult(cand!.result, cand!.proof, ep.recordRoot!);
  const view2 = await ok(anon.get(`/v1/bounties/${b2.address}/view`), "view 2");
  check("the 95% bounty has no winner: the same generation does not meet it", view2.bounty.winner === null && view2.generations.some((g: any) => g.gen_id === final.gen_id && g.meets === false));

  // ------------------------------------------------------------ forged claims are refused, the real one stands
  const forge = async (edit: (r: BountyResult) => BountyResult, bounty = b1.address) => refused(caller, [openBounty.claim({ bounty, result: edit(cand!.result), proof: c.proof })]);
  const fBetter = await forge((r) => ({ ...r, improvement_bps: 9_900 }), b2.address);
  const fAuthor = await forge((r) => ({ ...r, author: vkeys.v1.id }));
  const fThief = await refused(caller, [lastKey(openBounty.claim({ bounty: b1.address, result: cand!.result, proof: c.proof }), funderToken)]);
  const fLow = await forge((r) => r, b2.address);
  const fEpoch = await forge((r) => ({ ...r, epoch: Number(regA.lastEpoch) }));
  check("forged claims are refused: a better result than measured, another author, another account to pay, a result below the terms, an epoch posted before the bounty",
    fBetter === "BadProof" && (fAuthor === "BadProof" || fAuthor === "AccountNotInitialized") && fThief === "ConstraintSeeds" && fLow === "ImprovementTooLow" && fEpoch === "BeforeOpen",
    [fBetter, fAuthor, fThief, fLow, fEpoch].join(" / "));
  const early = await refused(caller, [openBounty.pay({ bounty: b1.address, funder: funder.id, winner: agentKey.id, mint: lineMint, tokenProgram: T22 })]);
  await send(STEP, `claim ${b1.id}: generation ${c.result.gen_id.slice(0, 12)} of ${agentKey.id}, proof of ${c.proof.length} nodes (sent by ${caller.id})`, caller,
    [openBounty.claim({ bounty: b1.address, result: c.result, proof: c.proof })], { computeUnits: 400_000 });
  const claimed = (await reader.openBountyAccount(b1.address))!;
  check("the claim stands on chain for the agent, payable after the contest time", claimed.winner === agentKey.id && claimed.winLeaf === c.leaf && claimed.winHeight === BigInt(c.result.height) &&
    claimed.contestUntil === claimed.claimedAt + BigInt(PROOF.contestS) && early !== null, `contest until ${claimed.contestUntil}; a payout before any claim: ${early}`);
  const again = await refused(caller, [openBounty.claim({ bounty: b1.address, result: c.result, proof: c.proof })]);
  const tooSoon = await refused(caller, [openBounty.pay({ bounty: b1.address, funder: funder.id, winner: agentKey.id, mint: lineMint, tokenProgram: T22 })]);
  const grab = await refused(caller, [openBounty.refund({ bounty: b1.address, funder: funder.id, mint: lineMint, tokenProgram: T22 })]);
  check("a replayed claim, a payout inside the contest time and a refund over a standing claim are refused", again === "NotEarlier" && tooSoon === "ContestOpen" && (grab === "NotExpired" || grab === "ClaimStanding"),
    `${again} / ${tooSoon} / ${grab}`);

  // ------------------------------------------------------------ the payout lands in the agent's compute vault
  await waitFor("contest time", async () => (await chainNow()) > claimed.contestUntil + 2n);
  const v0 = (await reader.tokenBalance(vault))!;
  const fundSol = await rpc.getBalance(funder.id);
  await send(STEP, `pay ${b1.id} into the compute vault of ${agentKey.id}, then refresh_awake (sent by ${caller.id})`, caller, [
    openBounty.pay({ bounty: b1.address, funder: funder.id, winner: agentKey.id, mint: lineMint, tokenProgram: T22 }),
    launch.refreshAwake({ agent: agentKey.id, agentMint: mintKey.id }),
  ], { computeUnits: 300_000 });
  const v1 = (await reader.tokenBalance(vault))!;
  const paid = (await reader.openBountyAccount(b1.address))!;
  check("the payout landed: the agent's compute vault gained exactly the reward, the escrow account is closed and its rent is back with the funder",
    v1 - v0 === 5n * ONE && paid.status === "paid" && paid.paid === 5n * ONE && paid.feePaid === 0n && (await rpc.getAccountInfo(openBountyPdas.vault(b1.address))) === null &&
    (await rpc.getBalance(funder.id)) > fundSol, `${v0} -> ${v1}`);
  const twice = await refused(caller, [openBounty.pay({ bounty: b1.address, funder: funder.id, winner: agentKey.id, mint: lineMint, tokenProgram: T22 })]);
  check("a second payout is refused", twice !== null, String(twice));
  await chainSync();
  const viewPaid = await ok(anon.get(`/v1/bounties/${b1.address}/view`), "view");
  check("Core mirrors the payout", viewPaid.bounty.state === "paid" && viewPaid.bounty.released_to === agentKey.id && viewPaid.bounty.paid === (5n * ONE).toString());

  // ------------------------------------------------------------ an expired bounty refunds its funder
  // a fourth bounty with the shortest deadline the settings allow: nothing can win it in time
  const tShort = await chainNow();
  const b4args = { bountyId: base + 3n, amount: 2n * ONE, termsDigest: hashJson({ v: 1, note: "Expires and is returned" }), lineageId: L, targetDigest: bountyTargetDigest(METRIC),
    minImprovementBps: 1_000, deadline: tShort + BigInt(PROOF.minTtlS) + 20n };
  const b4 = openBountyPdas.bounty(funder.id, b4args.bountyId);
  const r0 = (await reader.tokenBalance(funderToken))!;
  await send(STEP, `open_bounty ${b4args.bountyId}: 2 test UNITS, deadline in ${PROOF.minTtlS + 20} s (to expire)`, funder, [openBounty.open({ funder: funder.id, mint: lineMint, tokenProgram: T22, args: b4args })], { computeUnits: 200_000 });
  const acct4 = (await reader.openBountyAccount(b4))!;
  const before = await refused(caller, [openBounty.refund({ bounty: b4, funder: funder.id, mint: lineMint, tokenProgram: T22 })]);
  await waitFor("the short bounty's deadline", async () => (await chainNow()) > acct4.deadline + 2n);
  // past the deadline, inside the grace: the generation's epoch was posted before this bounty existed, and no refund yet
  const inGrace = await refused(caller, [openBounty.refund({ bounty: b4, funder: funder.id, mint: lineMint, tokenProgram: T22 })]);
  await waitFor("the short bounty's refund time", async () => (await chainNow()) > acct4.refundAfter + 2n);
  const late = await refused(caller, [openBounty.claim({ bounty: b4, result: cand!.result, proof: c.proof })]);
  const callerToken = await lineTo(caller.id, 1n, "caller");
  const steal = await refused(caller, [openBounty.refund({ bounty: b4, funder: funder.id, mint: lineMint, tokenProgram: T22, funderToken: callerToken })]);
  // the refund is sent while the program is paused: a pause stops open, claim and pay, never the return of an expired reward
  await send(STEP, "set_settings: paused (for the refund that follows)", dep, [openBounty.setSettings({ admin: dep.id, settings: { ...PROOF, paused: true } })]);
  const pausedOpen = await refused(funder, [openBounty.open({ funder: funder.id, mint: lineMint, tokenProgram: T22, args: { ...b4args, bountyId: base + 8n, deadline: (await chainNow()) + BigInt(PROOF.minTtlS) + 60n } })]);
  const pausedCancel = await refused(funder, [oldCancel(b3.address, funder.id)]);
  const fSolB = await rpc.getBalance(funder.id);
  await send(STEP, `refund ${b4args.bountyId} to its funder ${funder.id} (sent by ${caller.id}, program paused)`, caller, [openBounty.refund({ bounty: b4, funder: funder.id, mint: lineMint, tokenProgram: T22 })]);
  const refundedPaused = (await reader.openBountyConfig())!.settings.paused && (await reader.openBountyAccount(b4))!.status === "refunded";
  await send(STEP, "set_settings: not paused", dep, [openBounty.setSettings({ admin: dep.id, settings: PROOF })]);
  check("a paused program still returns an expired reward, while it refuses a new bounty", refundedPaused && pausedOpen === "Paused" && pausedCancel === "InstructionFallbackNotFound",
    `open while paused: ${pausedOpen}; cancel while paused: ${pausedCancel}`);
  const r1 = (await reader.tokenBalance(funderToken))!;
  check("the expired bounty refunded its funder exactly; before expiry, inside the grace, and into another wallet's account, the refund is refused; a claim after expiry is refused",
    r1 === r0 && (await reader.openBountyAccount(b4))!.status === "refunded" && before === "NotExpired" && inGrace === "NotExpired" && steal === "ConstraintTokenOwner" && late === "Expired" &&
    (await rpc.getBalance(funder.id)) > fSolB,
    `2000000 base units out and back (${r0} before the open, ${r1} after the refund); before expiry ${before}; in the grace ${inGrace}; to another account ${steal}; a claim after expiry ${late}`);
  const again2 = await refused(caller, [openBounty.refund({ bounty: b4, funder: funder.id, mint: lineMint, tokenProgram: T22 })]);
  check("a second refund is refused", again2 !== null, String(again2));
  await chainSync();
  const board1 = await ok(anon.get("/v1/bounties/board"), "board");
  const st = (a: string) => board1.bounties.find((x: any) => x.bounty_id === a)?.state;
  check("Core's board shows the outcomes: paid, returned, and the two bounties nobody could take back still held", st(b1.address) === "paid" && st(b4) === "refunded" && st(b3.address) === "open" && st(b2.address) === "open",
    [b1.address, b4, b3.address, b2.address].map((x) => st(x)).join(", "));
  check("the funder holds what it started with, less the reward that was won and the 3 test UNITS still escrowed (the 95% bounty and the one it tried to take back)", (await reader.tokenBalance(funderToken))! === f0 - 5n * ONE - 3n * ONE);

  // ------------------------------------------------------------ the admin restores the settings
  await send(STEP, "set_settings: the devnet values (deadline 1 hour to 30 days, grace 24 hours, contest 1 hour, no fee)", dep, [openBounty.setSettings({ admin: dep.id, settings: FINAL })]);
  const cfg1 = (await reader.openBountyConfig())!;
  check("the settings are restored; open bounties kept the ones they were opened with", cfg1.settings.contestS === FINAL.contestS && cfg1.settings.refundGraceS === FINAL.refundGraceS && paid.contestS === PROOF.contestS,
    JSON.stringify(cfg1.settings, big));

  const sol1 = await balances();
  const spent = watched.reduce((t, a) => t + (sol0[a]! - sol1[a]!), 0n);
  const passed = results.filter((r) => r.ok).length;
  writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), seconds: Math.round((Date.now() - T0) / 1000), program: BOUNTY_PROGRAM_ID, unit: L, metric: METRIC,
    funder: funder.id, agent: agentKey.id, agent_coin: mintKey.id, epoch: closed.n, post_epoch: post.signature, generation: final.gen_id,
    result: cand!.result, bounties: { paid: b1.address, refunded: b4, held: b3.address, open: b2.address }, sol_spent_by_all_keys: sol(spent), passed, of: results.length, results }, null, 2) + "\n");
  log(`${passed}/${results.length} checks passed; SOL spent by every key of the run: ${sol(spent)}; wrote ${OUT}`);
  if (passed !== results.length) process.exitCode = 1;
}

try {
  await main();
} catch (e) {
  console.error(`[open-bounty] stopped: ${(e as Error).stack ?? e}`);
  // never leave the short proof times in force
  const c = await reader.openBountyConfig().catch(() => null);
  if (c && c.settings.contestS !== FINAL.contestS) await send(STEP, "set_settings: the devnet values (after a stopped run)", dep, [openBounty.setSettings({ admin: dep.id, settings: FINAL })]).catch(() => undefined);
  for (const r of results.filter((x) => !x.ok)) console.error(`  FAIL ${r.check}: ${r.detail}`);
  process.exitCode = 1;
} finally {
  for (const p of procs) p.kill();
  if (!KEEP) rmSync(tmp, { recursive: true, force: true });
}
