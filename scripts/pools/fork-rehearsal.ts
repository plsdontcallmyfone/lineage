#!/usr/bin/env bun
// Mainnet-fork rehearsal of the pools and fee-claims instructions (docs/plans/AGENT-POOLS.md,
// GITHUB-FEE-CLAIMS.md): the pools build of units_launch at its mainnet id beside mainnet's own Pump,
// PumpSwap, Pump Fees and Token-2022 builds and state (scripts/pools/fork.sh). Every key is a
// throwaway, every lamport a fork airdrop; nothing is sent to mainnet. It measures what each new
// instruction costs at mainnet rent, its compute units and its transaction size.
//
//   mkdir -p <keys> && solana-keygen new --no-bip39-passphrase -s -o <keys>/deployer.json   (throwaway)
//   scripts/pools/fork.sh <ledger> <deployer pubkey> &
//   UNITS_NETWORK=mainnet MAINNET_FORK_KEYS=<keys> bun scripts/pools/fork-rehearsal.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ata, claimMessage, claimPdas, claims, crankSplit, createV2, creatorFeeHarvest, decodeAgentLaunch, decodeBondingCurve, decodeLaunchConfig, decodeLookupTable, decodeMint, decodePool,
  decodePoolMember, decodePumpFeeConfig, decodePumpGlobal, decodeTokenAccount, ed25519Ix, FEATURES, IDENTITY_MODE, launch, launchPdas, poolPdas, pools, pump, PUMP, pumpLaunchMain,
  pumpPdas, quoteCurveBuyExactOut, registry, registryPdas, settlementAllocation, signBytes, token, TOKEN_2022_PROGRAM, type Ix, type LookupTable, type Signer,
} from "@units/chain";
import { compileMessageV0, computeBudget, signMessageWith } from "@units/chain";
import { airdrop, assertFork, check, checks, fork, forkKey, rows, send, sendV0 } from "../mainnet/lib.ts";
import { initializeAll, parseLaunchParams, useActiveProfile } from "../mainnet/steps.ts";

const T22 = TOKEN_2022_PROGRAM, ONE = 1_000_000n;
const profile = useActiveProfile();
if (profile.network !== "mainnet") throw new Error("run with UNITS_NETWORK=mainnet: the rehearsal uses the mainnet program ids");
await assertFork();
const dep = forkKey("deployer"), core = forkKey("core"), runtime = forkKey("runtime"), keeper = forkKey("pool-keeper"), attestor = forkKey("claim-attestor");
const launcher = forkKey("launcher"), trader = forkKey("trader"), claimer = forkKey("claimer"), lineMintKey = forkKey(`line-${Date.now()}`);
const LINE = lineMintKey.id;
for (const k of [dep, core, keeper, launcher, trader, claimer]) await airdrop(k.id, 200_000_000_000n);
const bal = async (a: string) => { const i = await fork.getAccountInfo(a); return i ? decodeTokenAccount(i.data).amount : 0n; };
const acct = async <T>(a: string, d: (b: Uint8Array) => T): Promise<T> => d((await fork.getAccountInfo(a))!.data);
const sizes: Record<string, { bytes: number; cu: number | undefined; payer_lamports: string }> = {};
let table: LookupTable | null = null;
async function tx(name: string, payer: Signer, ixs: Ix[], signers: Signer[] = [], cu = 600_000) {
  const r = await sendV0("pools", name, payer, ixs, table ? [table] : [], { signers, computeUnits: cu });
  sizes[name] = { bytes: r.size, cu: r.computeUnits, payer_lamports: r.cost.payerMainnet };
  return r;
}

/** Simulates a v0 transaction that must fail; returns its error and logs as text. */
async function refused(payer: Signer, ixs: Ix[], _o: { computeUnits?: number } = {}): Promise<string> {
  const { blockhash } = await fork.getLatestBlockhash();
  const m = compileMessageV0(payer.id, [computeBudget.limit(600_000), ...ixs], blockhash, table ? [table] : []);
  const sim = await fork.simulate(signMessageWith(m, [payer]).wire);
  if (!sim.err) throw new Error("expected the transaction to be refused, but its simulation passed");
  return `${JSON.stringify(sim.err)} ${(sim.logs ?? []).join(" ")}`;
}

// ---- stand-in $UNITS (a pump.fun coin paired with SOL), programs initialized with admin = the deployer
await send("0", "create the stand-in $UNITS (create_v2, SOL-paired)", dep, [createV2({ mint: LINE, user: dep.id, creator: dep.id, name: "units stand-in (fork)", symbol: "sUNITS",
  uri: "https://units.invalid/fork/line.json", quote: { kind: "sol" } })], { signers: [lineMintKey], computeUnits: 400_000 });
const g = await acct(PUMP.global, decodePumpGlobal), fc = await acct(PUMP.feeConfig, decodePumpFeeConfig);
const HELD = 500_000_000n * ONE;
const q = quoteCurveBuyExactOut(g, fc, await acct(pumpPdas.bondingCurve(LINE), decodeBondingCurve), HELD, g.tokenTotalSupply);
await send("0", "buy stand-in $UNITS with SOL", dep, [token.createAtaIdempotent(dep.id, dep.id, LINE, T22), pump.buyV3({ mint: LINE, quoteMint: PUMP.wsol, user: dep.id, amount: HELD, maxQuoteIn: (q.quoteIn * 101n) / 100n })], { computeUnits: 300_000 });
const forkParams = JSON.parse(readFileSync(join(import.meta.dir, "..", "mainnet", "fork-params.json"), "utf8"));
const P = parseLaunchParams({ ...forkParams, multisig: { ...forkParams.multisig, members: [dep.id] }, core_authority: core.id, runtime_authority: runtime.id, line_mint: LINE });
const init = await initializeAll(fork, (w, p, i, o) => send("0", w, p, i, o), check, dep, P, dep.id);
table = { address: init.lookupTable, addresses: (await acct(init.lookupTable, decodeLookupTable)).addresses };
await send("0", "buyback recipient's $UNITS account", dep, [token.createAtaIdempotent(dep.id, PUMP.buybackRecipients[0]!, LINE, T22)]);
for (const k of [trader]) await send("0", "stand-in $UNITS to the trader", dep, [token.createAtaIdempotent(dep.id, k.id, LINE, T22), token.transferChecked(ata(dep.id, LINE, T22), LINE, ata(k.id, LINE, T22), dep.id, 100_000_000n * ONE, 6, T22)]);
const lc0 = await acct(launchPdas.config(), decodeLaunchConfig);
check("pools build at the mainnet id: features 0 after initialize", lc0.features === 0, launchPdas.config());

// ---- configs and feature bits
const claimArgs = { attestor: attestor.id, minBps: 1000, maxBps: 3000, changeDelayS: 5, rebindDelayS: 5, maxAttestationTtlS: 600, paused: false };
const poolArgs = { keeper: keeper.id, autoJoin: true, paused: false, maxMembers: 8, poolFeeBps: 2000, payoutBps: 4000, buybackBps: 4000, burnBps: 2000, authorBuybackBps: 2000, buybackPerGenBps: 2500,
  burnPerMilestoneBps: 5000, crossHoldQuote: 100n * ONE, maxBuyQuote: 1_000_000n * ONE };
await tx("set_claim_config (creates ClaimConfig)", dep, [claims.setClaimConfig({ admin: dep.id, args: claimArgs })]);
await tx("set_pool_config (creates PoolConfig)", dep, [pools.setPoolConfig({ admin: dep.id, args: poolArgs })]);
await tx("set_features", dep, [claims.setFeatures({ admin: dep.id, features: FEATURES.pools | FEATURES.githubFees })]);

// ---- two agents on one repository
const repoUrl = "https://github.com/units-fork/pool-rehearsal";
const agents = ["a", "b"].map((s) => ({ agent: forkKey(`agent-${s}-${Date.now()}`), mint: forkKey(`mint-${s}-${Date.now()}`), s }));
for (const a of agents) {
  await airdrop(a.agent.id, 1_000_000_000n);
  await tx(`launch agent ${a.s} (create_v2 + register_pump_launch)`, launcher, pumpLaunchMain({ launcher: launcher.id, agent: a.agent.id, agentMint: a.mint.id, line: { mint: LINE, tokenProgram: T22 },
    name: `fork pool ${a.s}`, symbol: `FP${a.s.toUpperCase()}`, uri: "https://units.invalid/fork/agent.json", args: { repoUrl, identityMode: IDENTITY_MODE.app, hosted: false }, creatorFeeBps: 0n }), [a.agent, a.mint]);
}
const [A, B] = agents as [typeof agents[0], typeof agents[0]];
const repoId = (await acct(launchPdas.agentLaunch(A.mint.id), decodeAgentLaunch)).repoId;
const GH_A = 583231, GH_B = 9919;
await tx("set_fee_route (creates FeeRoute, ClaimEscrow and its vault)", launcher, [claims.setFeeRoute({ owner: launcher.id, agent: A.agent.id, agentMint: A.mint.id, lineMint: LINE, githubId: GH_A, bps: 3000 })]);
await tx("set_fee_route (second agent, another account)", launcher, [claims.setFeeRoute({ owner: launcher.id, agent: B.agent.id, agentMint: B.mint.id, lineMint: LINE, githubId: GH_B, bps: 1000 })]);
// auto_join on: the keeper joins both (no owner signature)
await tx("join_pool (first member: creates Pool, its vault and PoolMember)", keeper, [pools.joinPool({ signer: keeper.id, agent: A.agent.id, agentMint: A.mint.id, repoId, lineMint: LINE, members: [] })]);
await tx("join_pool (second member: creates PoolMember)", keeper, [pools.joinPool({ signer: keeper.id, agent: B.agent.id, agentMint: B.mint.id, repoId, lineMint: LINE, members: [A.agent.id] })]);
check("auto-join: the keeper joined both agents of the repository", (await acct(poolPdas.pool(repoId), decodePool)).members.length === 2);

// ---- trades and routed cranks
const routes = (a: typeof A, gh: number) => [...claims.crankRouteKeys(a.agent.id, gh), ...pools.crankRouteKeys(a.agent.id, repoId, LINE, T22)];
const crank = (a: typeof A, gh: number, withRoutes = true): Ix[] => {
  const creator = launchPdas.pumpCreator(a.agent.id);
  return [token.createAtaIdempotent(keeper.id, creator, LINE, T22), ...creatorFeeHarvest({ payer: keeper.id, mint: a.mint.id, creator, quoteMint: LINE, quoteTokenProgram: T22 }),
    launch.crankPumpFees({ agent: a.agent.id, agentMint: a.mint.id, lineMint: LINE, lineTokenProgram: T22, routes: withRoutes ? routes(a, gh) : [] })];
};
for (const [a, gh, bps] of [[A, GH_A, 3000], [B, GH_B, 1000]] as const) {
  const c = await acct(pumpPdas.bondingCurve(a.mint.id), decodeBondingCurve);
  await tx(`trader buys ${a.s}`, trader, [token.createAtaIdempotent(trader.id, trader.id, a.mint.id, T22),
    pump.buyExactQuoteInV3({ mint: a.mint.id, quoteMint: LINE, quoteTokenProgram: T22, user: trader.id, spendableQuoteIn: c.virtualQuoteReserves / 6n, minTokensOut: 1n })], [], 400_000);
  const fees = (await acct(pumpPdas.bondingCurve(a.mint.id), decodeBondingCurve)).creatorFee;
  const b0 = [await bal(launchPdas.computeVault(a.agent.id)), await bal(registryPdas.treasury()), await bal(claimPdas.vault(gh)), await bal(poolPdas.vault(repoId, LINE, T22))];
  check(`refused: the eight-account crank of routed agent ${a.s}`, (await refused(keeper, crank(a, gh, false), { computeUnits: 600_000 })).includes("MissingRouteAccounts"));
  await tx(`crank_pump_fees with route accounts (${a.s})`, keeper, crank(a, gh));
  const b1 = [await bal(launchPdas.computeVault(a.agent.id)), await bal(registryPdas.treasury()), await bal(claimPdas.vault(gh)), await bal(poolPdas.vault(repoId, LINE, T22))];
  const w = crankSplit(fees, lc0.agentComputeBps, bps, poolArgs.poolFeeBps);
  check(`crank of ${a.s}: compute, protocol, GitHub and pool slices exact; protocol share as today`, b1[0]! - b0[0]! === w.toCompute && b1[1]! - b0[1]! === w.toProtocol && b1[2]! - b0[2]! === w.toGithub
    && b1[3]! - b0[3]! === w.toPool && w.toProtocol === fees - (fees * BigInt(lc0.agentComputeBps)) / 10_000n, `fees ${fees}: ${w.toCompute} / ${w.toProtocol} / ${w.toGithub} / ${w.toPool}`);
}

// ---- settlement for a posted registry epoch, payout, cross-holdings, buyback, burn
await send("pools", "post registry epoch 1 (empty roots)", core, [registry.postEpoch({ coreAuthority: core.id, mint: LINE, epoch: 1, payoutRoot: "00".repeat(32), lineageRoot: "00".repeat(32),
  recordRoot: "00".repeat(32), totalUnitsMicro: 0n, poolAmount: 0n, rebateAmount: 0n, tokenProgram: T22 })]);
const p1 = await acct(poolPdas.pool(repoId), decodePool);
const members = [A.agent.id, B.agent.id];
check("refused: pool_settle by the admin (not the keeper)", (await refused(dep, [pools.poolSettle({ keeper: dep.id, repoId, members, epoch: 1, gens: 1, weights: [10_000, 0], milestones: 1, evidence: "11".repeat(32) })])).includes("Unauthorized"));
await tx("pool_settle", keeper, [pools.poolSettle({ keeper: keeper.id, repoId, members, epoch: 1, gens: 1, weights: [10_000, 0], milestones: 1, evidence: "11".repeat(32) })]);
const alloc = settlementAllocation(poolArgs, { payout: p1.bucketPayout, buyback: p1.bucketBuyback, burn: p1.bucketBurn }, { gens: 1, weights: [10_000, 0], milestones: 1 });
const sA = await acct(poolPdas.member(A.agent.id), decodePoolMember), sB = await acct(poolPdas.member(B.agent.id), decodePoolMember);
check("allocation equals the offchain recomputation", sA.payoutDue === alloc[0]!.payout && sA.buybackDue === alloc[0]!.buyback && sB.buybackDue === alloc[1]!.buyback && sA.burnDue === alloc[0]!.burn && sB.burnDue === alloc[1]!.burn,
  `A ${sA.payoutDue}/${sA.buybackDue}/${sA.burnDue}, B 0/${sB.buybackDue}/${sB.burnDue}`);
const cv0 = await bal(launchPdas.computeVault(A.agent.id));
await tx("pool_pay", trader, [pools.poolPay({ repoId, agent: A.agent.id, agentMint: A.mint.id, lineMint: LINE })], [], 200_000);
check("payout in the author's compute vault", (await bal(launchPdas.computeVault(A.agent.id))) - cv0 === sA.payoutDue);
await airdrop(poolPdas.auth(repoId), 100_000_000n);
await tx("pool token accounts (one per member mint)", keeper, [token.createAtaIdempotent(keeper.id, poolPdas.auth(repoId), A.mint.id, T22), token.createAtaIdempotent(keeper.id, poolPdas.auth(repoId), B.mint.id, T22)], [], 200_000);
const size = async (mint: string, budget: bigint) => {
  const c = await acct(pumpPdas.bondingCurve(mint), decodeBondingCurve);
  const net = (budget * 96n) / 100n;
  return (net * c.virtualTokenReserves) / (c.virtualQuoteReserves + net);
};
const buy = (target: typeof A, kind: number, tokenAmount: bigint, maxQuote: bigint, by = keeper.id) =>
  pools.poolBuy({ keeper: by, repoId, target: target.agent.id, targetMint: target.mint.id, lineMint: LINE, kind, venue: 0, tokenAmount, maxQuote });
for (const [h, t] of [[A, B], [B, A]] as const) {
  await tx(`the holder agent's token account for its cross-holding (${h.s} of ${t.s})`, keeper, [token.createAtaIdempotent(keeper.id, h.agent.id, t.mint.id, T22)], [], 100_000);
  await tx(`pool_cross_buy (${h.s} buys ${t.s}; creates CrossHolding)`, keeper, [pools.poolCrossBuy({ keeper: keeper.id, repoId, holder: h.agent.id, target: t.agent.id, targetMint: t.mint.id, lineMint: LINE, venue: 0,
    tokenAmount: await size(t.mint.id, poolArgs.crossHoldQuote), maxQuote: poolArgs.crossHoldQuote })]);
}
check("cross-holdings are in the holder agents' own token accounts, none with the pool", (await bal(poolPdas.heldBy(A.agent.id, B.mint.id))) > 0n && (await bal(poolPdas.heldBy(B.agent.id, A.mint.id))) > 0n
  && (await bal(poolPdas.holding(repoId, A.mint.id))) === 0n && (await bal(poolPdas.holding(repoId, B.mint.id))) === 0n);
check("refused: pool_buy by a key that is not the keeper", (await refused(trader, [buy(B, 1, 1n, 1n, trader.id)], { computeUnits: 600_000 })).includes("Unauthorized"));
check("refused: a buy past the member's budget", (await refused(keeper, [buy(B, 1, (await size(B.mint.id, sB.buybackDue)) * 3n, sB.buybackDue * 3n)], { computeUnits: 600_000 })).length > 0);
const v0 = await bal(poolPdas.vault(repoId, LINE, T22));
await tx("pool_buy (buyback, held)", keeper, [buy(B, 1, await size(B.mint.id, sB.buybackDue), sB.buybackDue)]);
const spentB = v0 - (await bal(poolPdas.vault(repoId, LINE, T22)));
check("buyback: spent within the due amount, tokens in the pool's account", spentB > 0n && spentB <= sB.buybackDue && (await bal(poolPdas.holding(repoId, B.mint.id))) === (await acct(poolPdas.member(B.agent.id), decodePoolMember)).tokensHeld);
const supply0 = (await acct(A.mint.id, decodeMint)).supply;
await tx("pool_buy (milestone burn)", keeper, [buy(A, 2, await size(A.mint.id, sA.burnDue), sA.burnDue)]);
const burned = (await acct(poolPdas.member(A.agent.id), decodePoolMember)).tokensBurned;
check("milestone burn: supply fell by the tokens bought", supply0 - (await acct(A.mint.id, decodeMint)).supply === burned && burned > 0n, `${burned}`);

// ---- an attested claim, a replay, a spoof
const ceiling = await bal(claimPdas.vault(GH_A));
const now = await fork.call<number>("getBlockTime", [await fork.getSlot()]);
const exp = now + 300;
const msg = claimMessage({ githubId: GH_A, wallet: claimer.id, ceiling, claimSeq: 0, expiresAt: exp });
const claimIx = claims.claimGithubFees({ wallet: claimer.id, walletToken: ata(claimer.id, LINE, T22), githubId: GH_A, lineMint: LINE, ceiling, expiresAt: exp });
await tx("claimer's $UNITS account", claimer, [token.createAtaIdempotent(claimer.id, claimer.id, LINE, T22)], [], 100_000);
check("refused: a claim attested by the claimant's own key", (await refused(claimer, [ed25519Ix(claimer.id, signBytes(claimer, msg), msg), claimIx])).includes("BadAttestation"));
check("refused: the attestation used for another GitHub id's escrow", (await refused(claimer, [ed25519Ix(attestor.id, signBytes(attestor, msg), msg),
  claims.claimGithubFees({ wallet: claimer.id, walletToken: ata(claimer.id, LINE, T22), githubId: GH_B, lineMint: LINE, ceiling, expiresAt: exp })])).includes("BadAttestation"));
await tx("claim_github_fees (Ed25519 attestation + claim)", claimer, [ed25519Ix(attestor.id, signBytes(attestor, msg), msg), claimIx], [], 200_000);
check("claim paid the escrow's balance to the attested wallet", (await bal(ata(claimer.id, LINE, T22))) === ceiling && ceiling > 0n, `${ceiling}`);
check("refused: the same attestation again", (await refused(claimer, [ed25519Ix(attestor.id, signBytes(attestor, msg), msg), claimIx])).includes("BadAttestation"));

// ---- bits off: the eight-account crank and today's split
await tx("set_features(0)", dep, [claims.setFeatures({ admin: dep.id, features: 0 })]);
{
  const c = await acct(pumpPdas.bondingCurve(B.mint.id), decodeBondingCurve);
  await tx("trader buys b again", trader, [pump.buyExactQuoteInV3({ mint: B.mint.id, quoteMint: LINE, quoteTokenProgram: T22, user: trader.id, spendableQuoteIn: c.virtualQuoteReserves / 20n, minTokensOut: 1n })], [], 400_000);
  const fees = (await acct(pumpPdas.bondingCurve(B.mint.id), decodeBondingCurve)).creatorFee;
  const b0 = [await bal(launchPdas.computeVault(B.agent.id)), await bal(registryPdas.treasury()), await bal(claimPdas.vault(GH_B)), await bal(poolPdas.vault(repoId, LINE, T22))];
  await tx("crank_pump_fees, eight accounts, bits off", keeper, crank(B, GH_B, false));
  const toCompute = (fees * BigInt(lc0.agentComputeBps)) / 10_000n;
  check("bits off: today's two amounts to the unit, nothing routed", (await bal(launchPdas.computeVault(B.agent.id))) - b0[0]! === toCompute && (await bal(registryPdas.treasury())) - b0[1]! === fees - toCompute
    && (await bal(claimPdas.vault(GH_B))) === b0[2] && (await bal(poolPdas.vault(repoId, LINE, T22))) === b0[3], `fees ${fees}`);
}
const passed = checks.filter((c) => c.ok).length;
writeFileSync(join(import.meta.dir, "FORK-REHEARSAL-LAST.json"), JSON.stringify({ at: new Date().toISOString(), profile: profile.network, result: passed === checks.length ? "PASS" : "FAIL", passed, total: checks.length,
  launch_build_sha256: new Bun.CryptoHasher("sha256").update(readFileSync(join(import.meta.dir, "..", "..", "onchain", "target", "pools-mainnet", "units_launch.so"))).digest("hex"),
  note: "payer_lamports: what the transaction's fee payer paid at mainnet rent (network fee plus the rent of the accounts it creates)", instructions: sizes, checks, rows: rows.length }, null, 2) + "\n");
console.log(`[fork] ${passed === checks.length ? "PASS" : "FAIL"} ${passed}/${checks.length}`);
