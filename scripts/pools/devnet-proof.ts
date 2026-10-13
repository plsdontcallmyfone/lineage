#!/usr/bin/env bun
// Devnet proof of agent pools and GitHub fee claims (docs/plans/AGENT-POOLS.md, GITHUB-FEE-CLAIMS.md)
// against the upgraded units_launch, with the onchain feature bits on for the run and off again at
// the end, and a staging Core (scripts/pools/staging.ts) with both Core flags on. The public devnet
// site is not redeployed and keeps its flags off.
//
// Two fresh TEST agents are launched on one repository URL made for this run. They are self-hosted
// and never author: the one settlement this script posts uses TEST inputs (one generation, all of
// agent A's; one milestone), stated as such in the record. Everything after it is the staging
// Core's own keeper: payouts, cross-holdings, the buyback, the milestone burn.
//
//   bun scripts/pools/devnet-proof.ts            (writes scripts/pools/DEVNET-PROOF-LAST.json)
//
// Nothing reads or changes `solana config`; every key is passed explicitly; no key is printed.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ata, claimMessage, claimPdas, claims, crankSplit, creatorFeeHarvest, decodeAgentLaunch, decodeBondingCurve, decodeClaimEscrow, decodeConfig, decodeCrossHolding, decodeFeeRoute, decodeLaunchConfig,
  decodeMint, decodePool, decodePoolMember, decodeTokenAccount, ed25519Ix, FEATURES, IDENTITY_MODE, launch, launchPdas, poolPdas, pools, pumpPdas, registryPdas,
  settlementAllocation, token, TOKEN_2022_PROGRAM, type Ix, type Signer,
} from "@units/chain";
import { base58Decode, canonicalJson, generateAgentKey, hashJson, signMessage } from "@units/protocol";
import { assertDevnet } from "../../packages/chain/src/browser/client.ts";
import { CoreClient } from "../../packages/core/src/client.ts";
import { feeClaimDigest, feeClaimGistText, feeClaimStatement } from "../../packages/core/src/fee-claims.ts";
import { deployer, key, loadState, log, rpc, sol, topUp } from "../devnet/lib.ts";
import { creatorLineAccount, launchTable, pumpLaunchTx, pumpTrade, sendTx } from "../devnet/pump-lib.ts";
import { claimThroughPage, startWeb } from "../claims/page-proof.ts";
import { startStaging } from "./staging.ts";

const T22 = TOKEN_2022_PROGRAM;
const ONE = 1_000_000n;
const OUT = join(import.meta.dir, "DEVNET-PROOF-LAST.json");
const checks: { name: string; ok: boolean; detail: string }[] = [];
const txs: { step: string; signature: string; fee: number | null; cu: number | null; bytes: number }[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`[proof] ${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) throw new Error(`check failed: ${name}`);
}
const state = loadState();
const LINE = state.line_mint!;
const table = await launchTable(rpc, state as never);
async function send(step: string, payer: Signer, ixs: Ix[], o: { signers?: Signer[]; computeUnits?: number } = {}) {
  const r = await sendTx(rpc, payer, ixs, { computeUnits: 400_000, table, ...o });
  txs.push({ step, signature: r.signature, fee: r.fee, cu: r.computeUnits, bytes: r.size });
  log(`${step}: ${r.signature} (${r.computeUnits} CU, ${r.size} bytes)`);
  return r;
}
async function refuses(what: string, payer: Signer, ixs: Ix[], expect: string, signers: Signer[] = []) {
  try {
    await sendTx(rpc, payer, ixs, { computeUnits: 400_000, table, signers });
  } catch (e) {
    const text = `${(e as Error).message} ${((e as { logs?: string[] }).logs ?? []).join(" ")}`;
    check(`refused: ${what}`, text.includes(expect), expect);
    return;
  }
  check(`refused: ${what}`, false, "the transaction went through");
}
const bal = async (a: string) => {
  const i = await rpc.getAccountInfo(a);
  return i ? decodeTokenAccount(i.data).amount : 0n;
};
const acct = async <T>(a: string, d: (b: Uint8Array) => T): Promise<T> => d((await rpc.getAccountInfo(a))!.data);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const fmt = (n: bigint) => `${n / ONE}.${(n % ONE).toString().padStart(6, "0")}`;

// The claim steps of this proof (section 7) were written when a fee route named a GitHub ACCOUNT. Since 2026-10-12 Core keys routes by
// the REPOSITORY the agent works on and attests only for a repository admin (docs/plans/GITHUB-FEE-CLAIMS.md section 11), so
// those steps cannot pass any more: two agents on one repository route to one escrow, and the lookup by login is gone. This run
// spends devnet SOL and changes devnet's ClaimConfig before it reaches them, so it stops before sending anything until section 7 is rewritten for
// the repository model. The pages and Core under that model are proven by scripts/claims/repo-page-proof.ts and
// packages/core/test/fee-claims.test.ts; the program is unchanged.
if (process.env.PROOF_ACCOUNT_MODEL_CLAIMS !== "1") throw new Error("scripts/pools/devnet-proof.ts: its claim steps predate repository-keyed fee routes (GITHUB-FEE-CLAIMS.md section 11) and would fail after spending; nothing was sent");

await assertDevnet(rpc);
const run = Date.now().toString(36);
const dep = deployer();
const keeper = key("pools-keeper"), attestor = key("claims-attestor"), launcher = key("pools-proof-launcher"), trader = key("pools-proof-trader");
const treasury = key("tline-pump-treasury");
key("pools-proof-core-admin"); // the staging Core's admin key file
const sol0 = await rpc.getBalance(dep.id);
const lc0 = await acct(launchPdas.config(), decodeLaunchConfig);
check("upgraded program, flags off before the run", lc0.features === 0 && lc0.admin === dep.id, `features ${lc0.features}, admin ${lc0.admin}`);

// ---- 0. funding (devnet SOL from the deployer, UNITS from the devnet treasury)
await topUp("0", dep, keeper.id, 300_000_000n, "pool keeper", 500_000_000n);
await topUp("0", dep, launcher.id, 300_000_000n, "proof launcher", 500_000_000n);
await topUp("0", dep, trader.id, 200_000_000n, "proof trader", 300_000_000n);
const traderLine = ata(trader.id, LINE, T22);
if ((await bal(traderLine)) < 200_000n * ONE)
  await send("0: UNITS to the proof trader", dep, [token.createAtaIdempotent(dep.id, trader.id, LINE, T22),
    token.transferChecked(ata(treasury.id, LINE, T22), LINE, traderLine, treasury.id, 400_000n * ONE, 6, T22)], { signers: [treasury] });

// ---- 1. configs (TEST values of the plans; the route delay short for this run) and the feature bits
const mockUsers = [{ id: 880_000_000 + (Date.now() % 100_000), login: `units-proof-a-${run}`, name: "TEST recipient A" }, { id: 990_000_000 + (Date.now() % 100_000), login: `units-proof-b-${run}`, name: "TEST recipient B" }];
const [ghA, ghB] = mockUsers as [typeof mockUsers[0], typeof mockUsers[0]];
const claimArgs = { attestor: attestor.id, minBps: 1000, maxBps: 3000, changeDelayS: 20, rebindDelayS: 20, maxAttestationTtlS: 600, paused: false };
const poolArgs = { keeper: keeper.id, autoJoin: false, paused: false, maxMembers: 8, poolFeeBps: 2000, payoutBps: 4000, buybackBps: 4000, burnBps: 2000, authorBuybackBps: 2000,
  buybackPerGenBps: 2500, burnPerMilestoneBps: 5000, crossHoldQuote: ONE / 2n, maxBuyQuote: 1_000n * ONE };
await send("1: set_claim_config, set_pool_config, set_features(pools + github fees)", dep, [claims.setClaimConfig({ admin: dep.id, args: claimArgs }),
  pools.setPoolConfig({ admin: dep.id, args: poolArgs }), claims.setFeatures({ admin: dep.id, features: FEATURES.pools | FEATURES.githubFees })]);
let failed: unknown = null;
const result: Record<string, unknown> = { run, network: "devnet", program: launchPdas.config(), keeper: keeper.id, attestor: attestor.id };
let staging: Awaited<ReturnType<typeof startStaging>> | null = null;
let web: Awaited<ReturnType<typeof startWeb>> | null = null;
const WEB_PORT = Number(process.env.PROOF_WEB_PORT ?? 9668);
try {
  check("feature bits on", (await acct(launchPdas.config(), decodeLaunchConfig)).features === 3);
  // the staging Core first, so a start failure costs no launches
  const scratch = process.env.PROOF_SCRATCH ?? join(process.env.TMPDIR ?? "/tmp", `units-pools-proof-${run}`);
  // the mock signs in as its first user unless told otherwise: recipient B, who claims through the page's Sign in button
  staging = await startStaging({ corePort: Number(process.env.PROOF_CORE_PORT ?? 9664), mockPort: Number(process.env.PROOF_MOCK_PORT ?? 9665), users: [ghB, ghA], dataDir: scratch,
    claimPage: `http://127.0.0.1:${WEB_PORT}/claim`, log });

  // ---- 2. two TEST agents on one repository
  const repoUrl = `https://github.com/units-pool-proof/run-${run}`;
  const agents: { agent: Signer; mint: Signer; sym: string }[] = [];
  for (const s of ["A", "B"]) {
    const agent = key(`pools-proof-${run}-agent-${s.toLowerCase()}`), mint = key(`pools-proof-${run}-mint-${s.toLowerCase()}`);
    const r = await pumpLaunchTx(rpc, { launcher, agent, mint, lineMint: LINE, name: `TEST pool proof ${s} ${run}`, symbol: `TPOOL${s}`, uri: "https://units.invalid/devnet/pool-proof.json",
      args: { repoUrl, identityMode: IDENTITY_MODE.app, hosted: false }, table });
    for (const t of r.sent) txs.push({ step: `2: launch TEST agent ${s}`, signature: t.signature, fee: t.fee, cu: t.computeUnits, bytes: t.size });
    agents.push({ agent, mint, sym: s });
    log(`2: launched TEST agent ${s} ${agent.id} mint ${mint.id}`);
  }
  const [A, B] = agents as [typeof agents[0], typeof agents[0]];
  const repoId = (await acct(launchPdas.agentLaunch(A.mint.id), decodeAgentLaunch)).repoId;
  check("both launches name the same repository id", (await acct(launchPdas.agentLaunch(B.mint.id), decodeAgentLaunch)).repoId === repoId, repoId);
  result.repo = { url: repoUrl, id: repoId };
  result.agents = agents.map((a) => ({ name: a.sym, agent: a.agent.id, mint: a.mint.id }));

  // ---- 3. fee routes (the launcher is the registry owner) and the pool
  const stranger = generateAgentKey();
  await refuses("set_fee_route by someone who is not the agent's owner", trader, [claims.setFeeRoute({ owner: trader.id, agent: A.agent.id, agentMint: A.mint.id, lineMint: LINE, githubId: ghA.id, bps: 2000 })], "Unauthorized");
  await refuses("a route above the admin's maximum", launcher, [claims.setFeeRoute({ owner: launcher.id, agent: A.agent.id, agentMint: A.mint.id, lineMint: LINE, githubId: ghA.id, bps: 3001 })], "RouteBounds");
  await send("3: set_fee_route A (20%) and B (10%), join_pool A then B", launcher, [
    claims.setFeeRoute({ owner: launcher.id, agent: A.agent.id, agentMint: A.mint.id, lineMint: LINE, githubId: ghA.id, bps: 2000 }),
    claims.setFeeRoute({ owner: launcher.id, agent: B.agent.id, agentMint: B.mint.id, lineMint: LINE, githubId: ghB.id, bps: 1000 }),
  ], { computeUnits: 400_000 });
  await refuses("join_pool by someone who is not the agent's owner (auto_join off)", trader, [pools.joinPool({ signer: trader.id, agent: A.agent.id, agentMint: A.mint.id, repoId, lineMint: LINE, members: [] })], "Unauthorized");
  await send("3: join_pool A", launcher, [pools.joinPool({ signer: launcher.id, agent: A.agent.id, agentMint: A.mint.id, repoId, lineMint: LINE, members: [] })]);
  await send("3: join_pool B", launcher, [pools.joinPool({ signer: launcher.id, agent: B.agent.id, agentMint: B.mint.id, repoId, lineMint: LINE, members: [A.agent.id] })]);
  const pool0 = await acct(poolPdas.pool(repoId), decodePool);
  check("pool PDA keyed by the repository id holds both members", pool0.members.join() === [A.agent.id, B.agent.id].join(), poolPdas.pool(repoId));
  const la = await acct(launchPdas.agentLaunch(A.mint.id), decodeAgentLaunch);
  check("AgentLaunch.routes: pool member and GitHub route", la.routes === 3);
  result.pool = { address: poolPdas.pool(repoId), authority: poolPdas.auth(repoId), vault: pool0.vault };
  result.recipients = [{ agent: "A", github_id: ghA.id, login: ghA.login, bps: 2000 }, { agent: "B", github_id: ghB.id, login: ghB.login, bps: 1000 }];
  void stranger;

  // ---- 4. trades, then the crank with each agent's route accounts: exact splits
  const routeKeys = (a: typeof A, gh: number) => [...claims.crankRouteKeys(a.agent.id, gh), ...pools.crankRouteKeys(a.agent.id, repoId, LINE, T22)];
  const crankIxs = (a: typeof A, gh: number, routes = true): Ix[] => {
    const creator = launchPdas.pumpCreator(a.agent.id);
    return [token.createAtaIdempotent(keeper.id, creator, LINE, T22),
      ...harvest(a.mint.id, creator),
      launch.crankPumpFees({ agent: a.agent.id, agentMint: a.mint.id, lineMint: LINE, lineTokenProgram: T22, routes: routes ? routeKeys(a, gh) : [] })];
  };
  function harvest(mint: string, creator: string): Ix[] {
    return creatorFeeHarvest({ payer: keeper.id, mint, creator, quoteMint: LINE, quoteTokenProgram: T22 });
  }
  const splits: unknown[] = [];
  const tradeAndCrank = async (a: typeof A, gh: number, bps: number, label: string) => {
    const curve = await acct(pumpPdas.bondingCurve(a.mint.id), decodeBondingCurve);
    const spend = min(curve.virtualQuoteReserves / 8n, 20_000n * ONE);
    const t = await pumpTrade(rpc, { trader, mint: a.mint.id, lineMint: LINE, buy: true, amountIn: spend });
    txs.push({ step: `4: ${label} trader buys ${a.sym} with ${fmt(spend)} UNITS`, signature: t.signature, fee: t.fee, cu: t.computeUnits, bytes: t.size });
    const fees = (await acct(pumpPdas.bondingCurve(a.mint.id), decodeBondingCurve)).creatorFee + (await bal(creatorLineAccount(a.agent.id, LINE)));
    const before = { compute: await bal(launchPdas.computeVault(a.agent.id)), treasury: await bal(registryPdas.treasury()), gh: await bal(claimPdas.vault(gh)), pool: await bal(poolPdas.vault(repoId, LINE, T22)) };
    await send(`4: ${label} crank ${a.sym} (sweep, collect, crank_pump_fees with route accounts)`, keeper, crankIxs(a, gh), { computeUnits: 600_000 });
    const after = { compute: await bal(launchPdas.computeVault(a.agent.id)), treasury: await bal(registryPdas.treasury()), gh: await bal(claimPdas.vault(gh)), pool: await bal(poolPdas.vault(repoId, LINE, T22)) };
    const want = crankSplit(fees, lc0.agentComputeBps, bps, poolArgs.poolFeeBps);
    const got = { toCompute: after.compute - before.compute, toProtocol: after.treasury - before.treasury, toGithub: after.gh - before.gh, toPool: after.pool - before.pool };
    check(`${label} crank of ${a.sym}: compute, protocol, GitHub and pool slices exact`, canonicalJson(strs(got)) === canonicalJson(strs(want)),
      `fees ${fmt(fees)}: compute ${fmt(got.toCompute)}, protocol ${fmt(got.toProtocol)}, GitHub ${fmt(got.toGithub)}, pool ${fmt(got.toPool)}`);
    check(`${label} crank of ${a.sym}: the protocol share equals today's split`, got.toProtocol === fees - (fees * BigInt(lc0.agentComputeBps)) / 10_000n);
    splits.push({ agent: a.sym, label, fees: fees.toString(), ...strs(got) });
  };
  function strs(o: Record<string, bigint>) {
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.toString()]));
  }
  // the eight-account crank no longer serves a routed agent while the bits are on
  {
    const curve = await acct(pumpPdas.bondingCurve(A.mint.id), decodeBondingCurve);
    const t = await pumpTrade(rpc, { trader, mint: A.mint.id, lineMint: LINE, buy: true, amountIn: min(curve.virtualQuoteReserves / 50n, 2_000n * ONE) });
    txs.push({ step: "4: a first small buy of A", signature: t.signature, fee: t.fee, cu: t.computeUnits, bytes: t.size });
    await refuses("the eight-account crank for an agent with routes", keeper, crankIxs(A, ghA.id, false), "MissingRouteAccounts");
    const other = [...claims.crankRouteKeys(B.agent.id, ghB.id), ...pools.crankRouteKeys(A.agent.id, repoId, LINE, T22)];
    await refuses("a crank of A with B's fee route (the smaller share)", keeper, [...crankIxs(A, ghA.id, false).slice(0, -1),
      launch.crankPumpFees({ agent: A.agent.id, agentMint: A.mint.id, lineMint: LINE, lineTokenProgram: T22, routes: other })], "WrongRouteAccount");
  }
  await tradeAndCrank(A, ghA.id, 2000, "first");
  await tradeAndCrank(B, ghB.id, 1000, "first");
  result.splits = splits;
  const mA = await acct(poolPdas.member(A.agent.id), decodePoolMember), mB = await acct(poolPdas.member(B.agent.id), decodePoolMember);
  check("each member's slice funded its cross-holding first", mA.crossFunded === poolArgs.crossHoldQuote && mB.crossFunded === poolArgs.crossHoldQuote && mA.crossDue === 0n,
    `funded ${fmt(mA.crossFunded)} each`);
  const pool1 = await acct(poolPdas.pool(repoId), decodePool);
  check("buckets hold the rest by payout / buyback / burn bps", pool1.bucketPayout > 0n && pool1.bucketBuyback === pool1.bucketPayout && pool1.bucketBurn > 0n,
    `payout ${fmt(pool1.bucketPayout)}, buyback ${fmt(pool1.bucketBuyback)}, burn ${fmt(pool1.bucketBurn)}`);

  // ---- 5. the settlement (TEST inputs, see the header), by the keeper key only
  const rc = await acct(registryPdas.config(), decodeConfig);
  const epoch = Number(rc.lastEpoch);
  const record = { v: 1, kind: "units-pool-settlement-test", note: "TEST inputs for the devnet proof: these agents never authored; one generation credited to A, one milestone", repo_id: repoId, epoch,
    members: [{ agent: A.agent.id, weight_bps: 10_000 }, { agent: B.agent.id, weight_bps: 0 }], gens: 1, milestones: 1 };
  const settleArgs = { repoId, members: [A.agent.id, B.agent.id], epoch, gens: 1, weights: [10_000, 0], milestones: 1, evidence: hashJson(record) };
  await refuses("pool_settle by a key that is not the keeper", launcher, [pools.poolSettle({ keeper: launcher.id, ...settleArgs })], "Unauthorized");
  await refuses("pool_settle for an epoch the registry has not posted", keeper, [pools.poolSettle({ keeper: keeper.id, ...settleArgs, epoch: epoch + 5 })], "PoolEpoch");
  await refuses("pool_settle with weights that do not sum to 10,000", keeper, [pools.poolSettle({ keeper: keeper.id, ...settleArgs, weights: [6000, 3000] })], "PoolWeights");
  await send(`5: pool_settle for registry epoch ${epoch}`, keeper, [pools.poolSettle({ keeper: keeper.id, ...settleArgs })]);
  await refuses("the same epoch settled twice", keeper, [pools.poolSettle({ keeper: keeper.id, ...settleArgs })], "PoolEpoch");
  const alloc = settlementAllocation(poolArgs, { payout: pool1.bucketPayout, buyback: pool1.bucketBuyback, burn: pool1.bucketBurn }, { gens: 1, weights: [10_000, 0], milestones: 1 });
  const sA = await acct(poolPdas.member(A.agent.id), decodePoolMember), sB = await acct(poolPdas.member(B.agent.id), decodePoolMember);
  check("allocation equals the offchain recomputation", sA.payoutDue === alloc[0]!.payout && sA.buybackDue === alloc[0]!.buyback && sB.buybackDue === alloc[1]!.buyback && sA.burnDue === alloc[0]!.burn
    && sB.burnDue === alloc[1]!.burn && sB.payoutDue === 0n,
    `A: payout ${fmt(sA.payoutDue)}, buyback ${fmt(sA.buybackDue)}, burn ${fmt(sA.burnDue)}; B: buyback ${fmt(sB.buybackDue)}, burn ${fmt(sB.burnDue)}`);
  check("the non-author's token gets the larger buyback", sB.buybackDue > sA.buybackDue);
  result.settlement = { epoch, record, evidence: hashJson(record), allocation: alloc.map((m) => strs(m)) };
  await refuses("pool_buy by a key that is not the keeper", launcher, [token.createAtaIdempotent(launcher.id, poolPdas.auth(repoId), B.mint.id, T22),
    pools.poolBuy({ keeper: launcher.id, repoId, target: B.agent.id, targetMint: B.mint.id, lineMint: LINE, kind: 1, venue: 0, tokenAmount: 1n, maxQuote: 1n })], "Unauthorized");

  // ---- 6. the staging Core: views, then its keeper pays and buys
  const core = staging.core;
  const get = async (p: string) => (await fetch(core + p)).json() as Promise<any>;
  const post = async (p: string, body: unknown) => {
    const r = await fetch(core + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const view0 = await get(`/v1/pools/${repoId}`);
  check("staging Core serves the pool from chain", view0.members?.length === 2 && view0.active === true && view0.members[0].payout_due === sA.payoutDue.toString(), `vault ${view0.vault_balance}`);
  const admin = new CoreClient(core, key("pools-proof-core-admin"), () => Date.now());
  const supplyA0 = (await acct(A.mint.id, decodeMint)).supply, supplyB0 = (await acct(B.mint.id, decodeMint)).supply;
  const cvA0 = await bal(launchPdas.computeVault(A.agent.id));
  const step = await admin.post("/v1/admin/pools/run", {});
  check("keeper pass ran", step.status === 200, JSON.stringify((step.body.actions ?? []).map((a: any) => `${a.kind}${a.error ? " ERROR " + a.error : ""}`)));
  const acts = step.body.actions as { kind: string; signature?: string; error?: string }[];
  for (const a of acts) if (a.signature) txs.push({ step: `6: staging Core keeper: ${a.kind}`, signature: a.signature, fee: null, cu: null, bytes: 0 });
  check("no keeper action failed", acts.every((a) => !a.error), acts.filter((a) => a.error).map((a) => `${a.kind}: ${a.error}`).join("; "));
  check("payout reached the author's compute vault", (await bal(launchPdas.computeVault(A.agent.id))) - cvA0 === sA.payoutDue, fmt(sA.payoutDue));
  const xAB = await acct(poolPdas.cross(A.agent.id, B.agent.id), decodeCrossHolding), xBA = await acct(poolPdas.cross(B.agent.id, A.agent.id), decodeCrossHolding);
  check("cross-holdings: A holds B and B holds A, once each, bought with the holder's own slice and delivered to the holder agent's own token account",
    xAB.tokens > 0n && xBA.tokens > 0n && xAB.quoteSpent <= poolArgs.crossHoldQuote && xBA.quoteSpent <= poolArgs.crossHoldQuote
    && (await bal(poolPdas.heldBy(A.agent.id, B.mint.id))) === xAB.tokens && (await bal(poolPdas.heldBy(B.agent.id, A.mint.id))) === xBA.tokens,
    `A bought ${xAB.tokens} of B for ${fmt(xAB.quoteSpent)}; B bought ${xBA.tokens} of A for ${fmt(xBA.quoteSpent)}`);
  const eA = await acct(poolPdas.member(A.agent.id), decodePoolMember), eB = await acct(poolPdas.member(B.agent.id), decodePoolMember);
  check("buybacks: both members' tokens bought and held by the pool", eB.tokensHeld > 0n && eA.tokensHeld > 0n && eB.buybackDue < sB.buybackDue,
    `pool holds ${eA.tokensHeld} of A and ${eB.tokensHeld} of B`);
  check("the pool's token accounts hold exactly what the records say", (await bal(poolPdas.holding(repoId, A.mint.id))) === eA.tokensHeld && (await bal(poolPdas.holding(repoId, B.mint.id))) === eB.tokensHeld);
  const supplyA1 = (await acct(A.mint.id, decodeMint)).supply, supplyB1 = (await acct(B.mint.id, decodeMint)).supply;
  check("milestone burn: both members' supply fell by the tokens burned", supplyA0 - supplyA1 === eA.tokensBurned && supplyB0 - supplyB1 === eB.tokensBurned && eA.tokensBurned > 0n && eB.tokensBurned > 0n,
    `burned ${eA.tokensBurned} of A and ${eB.tokensBurned} of B`);
  const pool2 = await acct(poolPdas.pool(repoId), decodePool);
  const owed = [eA, eB].reduce((s, m) => s + m.crossFunded + m.payoutDue + m.buybackDue + m.burnDue, 0n);
  check("vault balance = buckets + what members are still owed", (await bal(pool2.vault)) === pool2.bucketPayout + pool2.bucketBuyback + pool2.bucketBurn + owed, fmt(await bal(pool2.vault)));
  result.pool_after = await get(`/v1/pools/${repoId}`);
  result.keeper_actions = acts;

  // ---- 7. GitHub fee claims through the staging Core: mock OAuth for A's recipient, a gist for B's
  const lookup = await get(`/v1/github/users/${ghA.login}`);
  check("wizard lookup: login to numeric id", lookup.id === ghA.id, `${lookup.login} -> ${lookup.id}`);
  const routeView = await get(`/v1/agents/${A.agent.id}/fee-route`);
  check("route view names the recipient and the share", routeView.route?.login === ghA.login && routeView.route?.bps === 2000, `${routeView.route?.bps / 100}% of fees go to @${routeView.route?.login}`);
  const claimWith = async (session: string, wallet: Signer, gh: number, label: string) => {
    const before = await bal(ata(wallet.id, LINE, T22));
    const att = await post("/v1/fee-claims/attest", { session });
    check(`${label}: Core attests`, att.status === 200 && att.body.attestor === attestor.id, `ceiling ${att.body.ceiling}, seq ${att.body.claim_seq}`);
    const a = att.body;
    const msg = claimMessage({ githubId: BigInt(a.github_id), wallet: a.wallet, ceiling: BigInt(a.ceiling), claimSeq: BigInt(a.claim_seq), expiresAt: a.expires_at });
    const ixs = [token.createAtaIdempotent(wallet.id, wallet.id, LINE, T22), ed25519Ix(a.attestor, base58Decode(a.signature), msg),
      claims.claimGithubFees({ wallet: wallet.id, walletToken: ata(wallet.id, LINE, T22), githubId: gh, lineMint: LINE, ceiling: BigInt(a.ceiling), expiresAt: a.expires_at })];
    await send(`7: ${label}: claim_github_fees`, wallet, ixs);
    const got = (await bal(ata(wallet.id, LINE, T22))) - before;
    check(`${label}: the wallet received the escrow's balance`, got === BigInt(a.ceiling) && got > 0n, `${fmt(got)} UNITS`);
    // the same attestation again
    await refuses(`${label}: the same attestation replayed`, wallet, ixs.slice(1), "BadAttestation");
    return { att: a, ixs, got };
  };
  // mock OAuth
  const walletA = key(`pools-proof-${run}-claimer-a`), walletB = key(`pools-proof-${run}-claimer-b`);
  await topUp("7", dep, walletA.id, 30_000_000n, "claimer A", 50_000_000n);
  await topUp("7", dep, walletB.id, 30_000_000n, "claimer B", 50_000_000n);
  const start = await fetch(`${core}/v1/fee-claims/oauth/start`, { redirect: "manual" });
  const authorize = new URL(start.headers.get("location")!);
  authorize.searchParams.set("login", ghA.login);
  const cb = (await fetch(authorize, { redirect: "manual" })).headers.get("location")!;
  const back = new URL((await fetch(cb, { redirect: "manual" })).headers.get("location")!);
  const sessionA0 = back.hash.replace(/^#session=/, "");
  const sess = await get(`/v1/fee-claims/session?session=${sessionA0}`);
  check("mock OAuth: a session for recipient A's numeric id", sess.github_id === String(ghA.id) && sess.method === "mock");
  const stA = feeClaimStatement(ghA.login, walletA.id, Date.now() / 1000);
  const bound = await post("/v1/fee-claims/wallet", { session: sessionA0, statement: stA, sig: signMessage(walletA, feeClaimDigest(stA)) });
  check("wallet bound by its signed statement", bound.status === 200 && bound.body.wallet === walletA.id);
  // a spoofed attestation first: signed by the claimant instead of the attestor
  const vaultA = await bal(claimPdas.vault(ghA.id));
  const escA = await acct(claimPdas.escrow(ghA.id), decodeClaimEscrow);
  const fakeMsg = claimMessage({ githubId: ghA.id, wallet: walletA.id, ceiling: vaultA, claimSeq: escA.claimSeq, expiresAt: Math.floor(Date.now() / 1000) + 120 });
  await refuses("a claim attested by the claimant's own key", walletA, [token.createAtaIdempotent(walletA.id, walletA.id, LINE, T22),
    ed25519Ix(walletA.id, base58Decode(signMessageBytes(walletA, fakeMsg)), fakeMsg),
    claims.claimGithubFees({ wallet: walletA.id, walletToken: ata(walletA.id, LINE, T22), githubId: ghA.id, lineMint: LINE, ceiling: vaultA, expiresAt: Math.floor(Date.now() / 1000) + 120 })], "BadAttestation");
  const cA = await claimWith(bound.body.session, walletA, ghA.id, "mock OAuth claim (recipient A)");
  // the attestation for A's escrow cannot open B's
  await refuses("A's attestation against B's escrow (wrong GitHub id)", walletA, [cA.ixs[1]!,
    claims.claimGithubFees({ wallet: walletA.id, walletToken: ata(walletA.id, LINE, T22), githubId: ghB.id, lineMint: LINE, ceiling: BigInt(cA.att.ceiling), expiresAt: cA.att.expires_at })], "BadAttestation");
  // gist proof (the mock GitHub's gist API; a real gist needs a real account, see the plan)
  const stB = feeClaimStatement(ghB.login, walletB.id, Date.now() / 1000);
  const gistUrl = staging.mock.addGist(ghB.login, feeClaimGistText(stB, signMessage(walletB, feeClaimDigest(stB))));
  const gp = await post("/v1/fee-claims/proofs/gist", { gist_url: gistUrl });
  check("gist proof: a session for recipient B bound to the wallet in the gist", gp.status === 200 && gp.body.github_id === String(ghB.id) && gp.body.wallet === walletB.id && gp.body.method === "gist");
  await claimWith(gp.body.session, walletB, ghB.id, "gist claim (recipient B)");
  // unclaimed balances keep accruing: another trade and crank, a fresh attestation
  await tradeAndCrank(A, ghA.id, 2000, "second");
  await new Promise((r) => setTimeout(r, 2500));
  const c2 = await claimWith(bound.body.session, walletA, ghA.id, "second claim after more fees (recipient A)");
  const escA2 = await acct(claimPdas.escrow(ghA.id), decodeClaimEscrow);
  check("escrow A: pinned wallet, two claims, claimed = accrued", escA2.wallet === walletA.id && escA2.claimSeq === 2n && escA2.claimed === escA2.accrued, `claimed ${fmt(escA2.claimed)}`);
  // ---- 7b. the Claim page itself, headless, with a test wallet that signs: B by the Sign in button, A by a gist
  await tradeAndCrank(A, ghA.id, 2000, "third");
  await tradeAndCrank(B, ghB.id, 1000, "second");
  web = await startWeb(WEB_PORT, core);
  const shots = join(scratch, "shots");
  (await import("node:fs")).mkdirSync(shots, { recursive: true });
  const pages: unknown[] = [];
  for (const [who, wallet, gh, mode] of [["B", walletB, ghB, "oauth"], ["A", walletA, ghA, "gist"]] as const) {
    const vault0 = await bal(claimPdas.vault(gh.id)), w0 = await bal(ata(wallet.id, LINE, T22));
    const r = await claimThroughPage({ base: web.base, wallet, mode, login: gh.login, mock: staging.mock, shots });
    const got = (await bal(ata(wallet.id, LINE, T22))) - w0;
    check(`Claim page, recipient ${who} (${mode === "oauth" ? "mock sign-in" : "gist"}): shows the escrow's balance and per-agent accruals, then claims it`,
      r.claimable_before === vault0.toString() && BigInt(r.claimed) === got && got === vault0 && got > 0n && r.claimable_after === "0" && r.per_agent.length >= 1,
      `${fmt(got)} UNITS, tx ${r.signature.slice(0, 12)}; rows ${r.per_agent.map((x) => `${x.agent.slice(0, 6)} ${x.share} ${x.accrued}`).join(", ")}`);
    check(`Claim page, recipient ${who}: no console error, no monospace, no em dash, no horizontal scroll`, r.console_errors.length === 0, r.console_errors.join(" | ").slice(0, 200));
    txs.push({ step: `7b: claim through the Claim page (recipient ${who}, ${mode})`, signature: r.signature, fee: null, cu: null, bytes: 0 });
    pages.push({ recipient: who, mode, login: r.login, claimed: r.claimed, signature: r.signature, per_agent: r.per_agent, screenshots: r.screenshots.map((x) => x.split("/").pop()) });
  }
  result.page_claims = pages;
  // another wallet cannot take over at once: its valid attestation only starts the delay
  const st2 = feeClaimStatement(ghA.login, walletB.id, Date.now() / 1000);
  const rebound = await post("/v1/fee-claims/wallet", { session: sessionA0, statement: st2, sig: signMessage(walletB, feeClaimDigest(st2)) });
  await new Promise((r) => setTimeout(r, 2500));
  const att2 = await post("/v1/fee-claims/attest", { session: rebound.body.session });
  check("Core flags an attestation for another wallet as a rebind", att2.status === 200 && att2.body.rebind?.pinned_wallet === walletA.id, `delay ${att2.body.rebind?.delay_s} s`);
  // route change: pending, refused early, applied after the delay; the old escrow keeps what it accrued
  await send("7: set_fee_route A to recipient B's account (pending)", launcher, [claims.setFeeRoute({ owner: launcher.id, agent: A.agent.id, agentMint: A.mint.id, lineMint: LINE, githubId: ghB.id, bps: 1500 })]);
  const pending = await acct(claimPdas.feeRoute(A.agent.id), decodeFeeRoute);
  check("the change is pending, the route unchanged", pending.githubId === BigInt(ghA.id) && pending.pendingGithubId === BigInt(ghB.id) && pending.pendingEffectiveAt > 0n);
  await refuses("apply_fee_route inside the delay", trader, [claims.applyFeeRoute({ agent: A.agent.id })], "RouteTimelock");
  log(`waiting ${claimArgs.changeDelayS + 8} s for the route delay`);
  await new Promise((r) => setTimeout(r, (claimArgs.changeDelayS + 8) * 1000));
  await send("7: apply_fee_route (anyone)", trader, [claims.applyFeeRoute({ agent: A.agent.id })]);
  const applied = await acct(claimPdas.feeRoute(A.agent.id), decodeFeeRoute);
  check("route now names the new account at the new share", applied.githubId === BigInt(ghB.id) && applied.bps === 1500 && applied.changes === 1);
  result.claims = { recipient_a: { wallet: walletA.id, first: cA.got.toString(), second: c2.got.toString() }, recipient_b: { wallet: walletB.id }, route_change: { to: ghB.id, bps: 1500, delay_s: claimArgs.changeDelayS } };

  // ---- 8. flags off: the eight-account crank works again for the routed members, with today's split
  await send("8: set_features(0)", dep, [claims.setFeatures({ admin: dep.id, features: 0 })]);
  {
    const curve = await acct(pumpPdas.bondingCurve(B.mint.id), decodeBondingCurve);
    const t = await pumpTrade(rpc, { trader, mint: B.mint.id, lineMint: LINE, buy: true, amountIn: min(curve.virtualQuoteReserves / 50n, 2_000n * ONE) });
    txs.push({ step: "8: a buy of B with the bits off", signature: t.signature, fee: t.fee, cu: t.computeUnits, bytes: t.size });
    const fees = (await acct(pumpPdas.bondingCurve(B.mint.id), decodeBondingCurve)).creatorFee + (await bal(creatorLineAccount(B.agent.id, LINE)));
    const before = { compute: await bal(launchPdas.computeVault(B.agent.id)), treasury: await bal(registryPdas.treasury()), gh: await bal(claimPdas.vault(ghB.id)), pool: await bal(pool2.vault) };
    await send("8: the eight-account crank of B (no route accounts)", keeper, crankIxs(B, ghB.id, false), { computeUnits: 600_000 });
    const toCompute = (fees * BigInt(lc0.agentComputeBps)) / 10_000n;
    check("flags off: today's split to the unit, nothing to the escrow or the pool",
      (await bal(launchPdas.computeVault(B.agent.id))) - before.compute === toCompute && (await bal(registryPdas.treasury())) - before.treasury === fees - toCompute
      && (await bal(claimPdas.vault(ghB.id))) === before.gh && (await bal(pool2.vault)) === before.pool, `fees ${fmt(fees)}: compute ${fmt(toCompute)}, protocol ${fmt(fees - toCompute)}`);
    await refuses("set_fee_route with the bit off", launcher, [claims.setFeeRoute({ owner: launcher.id, agent: B.agent.id, agentMint: B.mint.id, lineMint: LINE, githubId: ghB.id, bps: 1200 })], "FeatureOff");
    await refuses("pool_settle with the bit off", keeper, [pools.poolSettle({ keeper: keeper.id, repoId, members: [A.agent.id, B.agent.id], epoch: Number(rc.lastEpoch) + 1, gens: 0, weights: [0, 0], milestones: 0, evidence: "00".repeat(32) })], "FeatureOff");
  }
} catch (e) {
  failed = e;
} finally {
  web?.stop();
  staging?.stop();
  // the bits never stay on after the run, whatever happened
  const lc = await acct(launchPdas.config(), decodeLaunchConfig);
  if (lc.features !== 0) await send("cleanup: set_features(0)", dep, [claims.setFeatures({ admin: dep.id, features: 0 })]);
  // the plans' TEST delays back in the config (the run used short ones)
  await send("cleanup: set_claim_config with the plan's TEST delays (600 s, 120 s)", dep, [claims.setClaimConfig({ admin: dep.id, args: { ...claimArgs, changeDelayS: 600, rebindDelayS: 120 } })]);
}
const lcEnd = await acct(launchPdas.config(), decodeLaunchConfig);
check("feature bits off after the run", lcEnd.features === 0);
const sol1 = await rpc.getBalance(dep.id);
const passed = checks.filter((c) => c.ok).length;
writeFileSync(OUT, JSON.stringify({ ...result, at: new Date().toISOString(), result: failed ? "FAIL" : "PASS", passed, total: checks.length, deployer_sol_spent: sol(sol0 - sol1),
  error: failed ? String((failed as Error).message ?? failed) : null, checks, transactions: txs }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
console.log(`[proof] ${failed ? "FAIL" : "PASS"} ${passed}/${checks.length}; deployer spent ${sol(sol0 - sol1)} SOL; ${OUT}`);
if (failed) {
  console.error(failed);
  for (const l of ((failed as { logs?: string[] }).logs ?? []).slice(-20)) console.error(`    ${l}`);
  process.exit(1);
}

/** A raw ed25519 signature over bytes (base58), for the spoofed attestation. */
function signMessageBytes(k: Signer, msg: Uint8Array): string {
  const { createPrivateKey, sign } = require("node:crypto") as typeof import("node:crypto");
  const pk = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(k.secret.subarray(0, 32))]), format: "der", type: "pkcs8" });
  const { base58Encode } = require("@units/protocol") as typeof import("@units/protocol");
  return base58Encode(new Uint8Array(sign(null, Buffer.from(msg), pk)));
}
