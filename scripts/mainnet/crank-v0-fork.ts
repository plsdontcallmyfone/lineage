#!/usr/bin/env bun
// The agent fee crank keeper (scripts/mainnet/crank-fees.ts) on every kind of agent, on a local fork of
// mainnet that holds the live launch program and the live accounts as they are. The case this proof
// exists for: a ROUTED agent (pool member, with or without a fee route to its repository's owners)
// whose coin has GRADUATED to its PumpSwap pool. Its crank does not fit a legacy transaction; the
// keeper sends it as a version 0 transaction that loads its fixed accounts from the frozen launch
// lookup table. Nothing is sent to mainnet and no real key is read: mainnet is read, every transaction
// goes to 127.0.0.1:9690.
//
// What the fork holds: what scripts/mainnet/pool-join-fork.ts --prepare writes (units_launch as deployed,
// every account of the launch, registry and message programs, $UNITS with its pool, the launch lookup
// table, pump.fun) plus every account the trades, the graduation and the cranks of this run name.
// FOUR fields are replaced by throwaway keys, because the real keys are not used here: the registry
// `owner` of the three agents that take a route (their launchers' wallets on mainnet) and
// PoolConfig.keeper. Every other byte is mainnet's.
//
//   D=<empty dir outside the repo>; mkdir -p $D/keys $D/ledger
//   MAINNET_FORK_KEYS=$D/keys bun scripts/mainnet/crank-v0-fork.ts --prepare $D      # reads mainnet, writes $D/accounts and the validator arguments
//   scripts/mainnet/fork.sh $D/ledger $(cat $D/fork-args) &
//   MAINNET_FORK_KEYS=$D/keys CRANK_V0_FORK_DIR=$D UNITS_NETWORK=mainnet bun scripts/mainnet/crank-v0-fork.ts
//   kill <the validator's PID, after checking what it is>
//
// The run, every crank sent by the keeper script itself and every amount checked to the base unit:
//   0  the fork is mainnet: program code, the frozen launch lookup table, both feature bits
//   1  agents with no route, on their curves, with the fees that wait on mainnet now (legacy)
//   2  routed agents on their curves: a pool member, then the same with a fee route (legacy)
//   3  a pool member's coin graduates (completion, migrate_v2, record_pump_graduation), trades on its
//      PumpSwap pool: the crank is version 0; a dry run, the --min-usd rule, an unusable table, a second
//      run; then a fee route on top (the largest crank), version 0 again
//   4  an agent with no pool graduates: legacy, and legacy again with a fee route (1,225 bytes)
//   5  one keeper run over every agent, then one that finds nothing
// CRANK_V0_OLD_SCRIPT=<a copy of the keeper script before this change> also runs that one on the two
// version 0 cases first and records what it did. Writes scripts/mainnet/CRANK-V0-FORK-LAST.json.
import { spawn, spawnSync } from "bun";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { base58Decode, generateAgentKey } from "@units/protocol";
import {
  addressBytes, ata, ChainReader, claimPdas, claims, crankSplit, decodeAgent, decodeAgentLaunch, decodeBondingCurve, decodeClaimConfig, decodeClaimEscrow, decodeFeeRoute, decodeLookupTable, decodeMint, decodePool,
  decodePoolConfig, decodePoolMember, decodePumpEvent, decodePumpFeeConfig, decodePumpGlobal, decodePumpPool, decodeTokenAccount, FEATURES, launch, launchPdas, launchTableAddresses, maxSolIn, poolPdas, poolRates, pools,
  programDataAddress, pump, PUMP, pumpAmm, pumpCrankIxs, pumpGraduateIxs, pumpPdas, pumpSolToLinePool, quoteCurveBuyExactOut, quotePoolBuyExactOut, registryPdas, rentLamports, token, TOKEN_2022_PROGRAM, TOKEN_ACCOUNT_LEN,
  type Ix, type LookupTable, type Signer,
} from "@units/chain";
import { programIdsNow, useActiveProfile } from "./steps.ts";

const ROOT = join(import.meta.dir, "..", "..");
const STATE = JSON.parse(readFileSync(join(ROOT, "config/mainnet/state.json"), "utf8"));
const LINE = STATE.line_mint as string, POOL = STATE.line_pool as { pool: string; baseVault: string; quoteVault: string }, TABLE = STATE.launch_lookup_table as string;
const T22 = TOKEN_2022_PROGRAM, ONE = 1_000_000n;
/** The two live agents of karpathy/minbpe (pool-join-fork.ts gives them stand-in owners): both join the pool, the second graduates. */
const AGENT_A = "HHxDgMPdYJ5SCXNdsvtaQnng3PAPXrPtZGY2xYc4eDtX", AGENT_B = "CuvvtxbrrWhsqM1uj6ahUvEPTJrb78zfrUr4NVqGUpAo";
/** Stand-in GitHub account ids for the fee routes (the route only names an id; nobody claims here). */
const GH = { a: 900_000_001n, b: 900_000_002n, z: 900_000_003n };
useActiveProfile({ ...process.env, UNITS_NETWORK: "mainnet" });
const IDS = programIdsNow();
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const argv = process.argv.slice(2);
type Rec = { agent: string; mint: string; repo_id: string; repo_url: string };

// ================================================================ --prepare: read mainnet, write the fork's accounts
if (argv[0] === "--prepare") {
  const DIR = argv[1];
  if (!DIR || !existsSync(DIR)) throw new Error("usage: --prepare <existing empty directory outside the repo>");
  const pj = spawnSync(["bun", join(import.meta.dir, "pool-join-fork.ts"), "--prepare", DIR], { env: { ...process.env, UNITS_NETWORK: "mainnet" } });
  if (pj.exitCode !== 0) throw new Error(`pool-join-fork.ts --prepare failed: ${pj.stderr.toString().slice(-400)}`);
  const { mainnet, forkKey } = await import("./lib.ts");
  const ownerZ = forkKey("owner-z-stand-in");
  const forkSh = readFileSync(join(import.meta.dir, "fork.sh"), "utf8");
  const disc = createHash("sha256").update("account:AgentLaunch").digest().subarray(0, 8).toString("hex");
  const all = (await mainnet.getProgramAccounts(IDS.launch)).filter((a) => Buffer.from(a.data.subarray(0, 8)).toString("hex") === disc).map((a) => decodeAgentLaunch(a.data))
    .filter((a) => a.venue === "pump" && !a.graduated);
  const g = decodePumpGlobal((await mainnet.getAccountInfo(PUMP.global))!.data), fc = decodePumpFeeConfig((await mainnet.getAccountInfo(PUMP.feeConfig))!.data);
  const tok = async (a: string) => { const i = await mainnet.getAccountInfo(a); return i ? decodeTokenAccount(i.data).amount : 0n; };
  const facts: { a: (typeof all)[number]; toComplete: bigint; waiting: bigint }[] = [];
  for (const a of all) {
    const cA = await mainnet.getAccountInfo(pumpPdas.bondingCurve(a.mint));
    if (!cA) continue;
    const c = decodeBondingCurve(cA.data);
    if (c.complete) continue;
    facts.push({ a, toComplete: quoteCurveBuyExactOut(g, fc, c, c.realTokenReserves, await tok(ata(pumpPdas.bondingCurve(a.mint), a.mint, T22))).quoteIn,
      waiting: await tok(ata(pumpPdas.creatorVault(launchPdas.pumpCreator(a.agent)), LINE, T22)) });
  }
  const [A, B] = [AGENT_A, AGENT_B].map((id) => facts.find((f) => f.a.agent === id)?.a);
  // either may already be a member of the repository's pool on mainnet (the second one opened it on 2026-10-13); neither may have a fee route yet
  if (!A || !B || A.repoId !== B.repoId || (A.routes | B.routes) & FEATURES.githubFees) throw new Error("the two agents of the pool are not both live on their curves, on one repository and without a fee route");
  const others = facts.filter((f) => f.a.agent !== AGENT_A && f.a.agent !== AGENT_B && f.a.routes === 0);
  // Z and Y: the two cheapest curves to complete among the rest (Z takes a fee route, Y takes nothing); the plain agents: up to two others with creator fees waiting on mainnet now
  const [zf, yf] = [...others].sort((x, y) => (x.toComplete < y.toComplete ? -1 : 1));
  if (!zf) throw new Error("no third live agent to graduate");
  const plain = others.filter((f) => f !== zf && f !== yf && f.waiting > 0n).slice(0, 2).map((f) => f.a);
  const u = generateAgentKey().id;
  const ixs: Ix[] = [];
  for (const [a, gh] of [[A, GH.a], [B, GH.b], [zf.a, GH.z], ...[...(yf ? [yf.a] : []), ...plain].map((p) => [p, 1n] as const)] as const) {
    const pool = pumpPdas.pool(a.mint, LINE), trade = { pool, mint: a.mint, quoteMint: LINE, quoteTokenProgram: T22, user: u };
    ixs.push(token.createAtaIdempotent(u, u, a.mint, T22), pump.buyV3({ mint: a.mint, quoteMint: LINE, quoteTokenProgram: T22, user: u, amount: 1n, maxQuoteIn: 1n }),
      pump.buyExactQuoteInV3({ mint: a.mint, quoteMint: LINE, quoteTokenProgram: T22, user: u, spendableQuoteIn: 1n, minTokensOut: 1n }),
      pump.sellV3({ mint: a.mint, quoteMint: LINE, quoteTokenProgram: T22, user: u, amount: 1n, minQuoteOut: 1n }),
      ...pumpGraduateIxs({ payer: u, agentMint: a.mint, lineMint: LINE, withdrawAuthority: g.withdrawAuthority, migrated: false, lineTokenProgram: T22 }),
      pumpAmm.buyV2({ ...trade, baseOut: 1n, maxQuoteIn: 1n }), pumpAmm.sellV2({ ...trade, baseIn: 1n, minQuoteOut: 1n }),
      claims.setFeeRoute({ owner: u, agent: a.agent, agentMint: a.mint, lineMint: LINE, githubId: gh, bps: 1, lineTokenProgram: T22 }),
      pools.joinPool({ signer: u, agent: a.agent, agentMint: a.mint, repoId: a.repoId, lineMint: LINE, members: [] }),
      ...pumpCrankIxs({ payer: u, agent: a.agent, agentMint: a.mint, lineMint: LINE, lineTokenProgram: T22, pool,
        routes: [...claims.crankRouteKeys(a.agent, gh), ...pools.crankRouteKeys(a.agent, a.repoId, LINE, T22)] }));
  }
  const accDir = join(DIR, "accounts");
  const BUILTIN = /^(11111111111111111111111111111111|ComputeBudget111111111111111111111111111111|TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA|ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL|AddressLookupTab1e1111111111111111111111111|Ed25519SigVerify1111111111111111111111111111|Sysvar.*|BPFLoader.*|NativeLoader1111111111111111111111111111111)$/;
  const args0 = readFileSync(join(DIR, "fork-args"), "utf8").trim();
  const keys = [...new Set(ixs.flatMap((ix) => [ix.programId, ...ix.keys.map((m) => m.pubkey)]))]
    .filter((a) => a !== u && !forkSh.includes(a) && !BUILTIN.test(a) && !existsSync(join(accDir, `${a}.json`)) && !args0.includes(a));
  const infos: Awaited<ReturnType<typeof mainnet.getMultipleAccounts>> = [];
  for (let i = 0; i < keys.length; i += 100) infos.push(...(await mainnet.getMultipleAccounts(keys.slice(i, i + 100))));
  const more: string[] = [];
  let written = 0;
  const write = (address: string, a: { lamports: bigint; data: Uint8Array; owner: string; executable: boolean }) =>
    writeFileSync(join(accDir, `${address}.json`), JSON.stringify({ pubkey: address, account: { lamports: Number(a.lamports), data: [Buffer.from(a.data).toString("base64"), "base64"], owner: a.owner, executable: a.executable,
      rentEpoch: "RENT_EPOCH", space: a.data.length } }).replace('"RENT_EPOCH"', "18446744073709551615"));
  keys.forEach((address, i) => {
    const a = infos[i];
    if (!a) return;
    if (a.executable && a.owner === LOADER) { more.push("--clone-upgradeable-program", address); return; }
    if (a.executable) { more.push("--clone", address); return; }
    if (a.owner === LOADER) return;
    write(address, a);
    written++;
  });
  // the third stand-in owner: the registry record of Z, as pool-join-fork.ts wrote it for the first two
  const zFile = join(accDir, `${registryPdas.agent(zf.a.agent)}.json`);
  const zJ = JSON.parse(readFileSync(zFile, "utf8").replace("18446744073709551615", '"RENT_EPOCH"'));
  const zData = new Uint8Array(Buffer.from(zJ.account.data[0], "base64"));
  const realOwner = decodeAgent(zData).owner;
  zData.set(addressBytes(ownerZ.id), 40);
  if (decodeAgent(zData).owner !== ownerZ.id) throw new Error("the owner field is not where this script writes it");
  zJ.account.data[0] = Buffer.from(zData).toString("base64");
  writeFileSync(zFile, JSON.stringify(zJ).replace('"RENT_EPOCH"', "18446744073709551615"));
  writeFileSync(join(DIR, "fork-args"), `${more.join(" ")} ${args0}\n`);
  const rec = (a: typeof A): Rec => ({ agent: a.agent, mint: a.mint, repo_id: a.repoId, repo_url: a.repoUrl });
  const pjPrep = JSON.parse(readFileSync(join(DIR, "prepare.json"), "utf8"));
  writeFileSync(join(DIR, "crank-v0-prepare.json"), JSON.stringify({ at: new Date().toISOString(), mainnet_slot: pjPrep.mainnet_slot, program_data_sha256: pjPrep.program_data_sha256,
    patched: { ...pjPrep.patched, [registryPdas.agent(zf.a.agent)]: "registry Agent: owner (bytes 40 to 71) replaced by a stand-in key" },
    replaced_real_values: { ...pjPrep.replaced_real_values, [registryPdas.agent(zf.a.agent)]: realOwner },
    a: rec(A), b: rec(B), z: rec(zf.a), y: yf ? rec(yf.a) : null, plain: plain.map(rec),
    to_complete_units: { b: (facts.find((f) => f.a.agent === AGENT_B)!.toComplete / ONE).toString(), z: (zf.toComplete / ONE).toString() } }, null, 1));
  console.log(`[prepare] pool-join-fork.ts --prepare, then ${written} more accounts and ${more.length / 2} more programs; Z is ${zf.a.agent.slice(0, 6)}, Y is ${yf?.a.agent.slice(0, 6) ?? "nobody"}, ${plain.length} plain agent(s) with fees waiting; validator arguments in ${join(DIR, "fork-args")}`);
  process.exit(0);
}

// ================================================================ the run
const DIR = process.env.CRANK_V0_FORK_DIR ?? "";
if (!DIR || !existsSync(join(DIR, "crank-v0-prepare.json"))) throw new Error("set CRANK_V0_FORK_DIR to the directory --prepare filled");
const PREP = JSON.parse(readFileSync(join(DIR, "crank-v0-prepare.json"), "utf8")) as { mainnet_slot: number; patched: Record<string, string>; program_data_sha256: string; a: Rec; b: Rec; z: Rec; y: Rec | null; plain: Rec[] };
const { airdrop, assertFork, check: check0, checks, fork, FORK_URL, forkKey, KEYS, log, mainnet, measure, sendV0, sol } = await import("./lib.ts");
await assertFork();
const reader = new ChainReader(fork);
const OUT_FILE = join(import.meta.dir, "CRANK-V0-FORK-LAST.json");
let section = "0 fork";
const sections: Record<string, { passed: number; total: number }> = {};
const check = (name: string, ok: boolean, detail = "") => {
  const s = (sections[section] ??= { passed: 0, total: 0 });
  s.total++;
  if (ok) s.passed++;
  try { check0(`${section}: ${name}`, ok, detail); } catch { /* recorded in `checks`, the run goes on */ }
};
const ownerA = forkKey("owner-a-stand-in"), ownerB = forkKey("owner-b-stand-in"), ownerZ = forkKey("owner-z-stand-in"), trader = forkKey("trader"), cranker = forkKey("cranker"), helper = forkKey("helper");
const { a: A, b: B, z: Z, y: Y } = PREP;
const NO_ROUTE = [...PREP.plain, ...(Y ? [Y] : [])];
const acct = async <T>(a: string, d: (b: Uint8Array) => T): Promise<T> => d((await fork.getAccountInfo(a))!.data);
const bal = async (a: string) => { const i = await fork.getAccountInfo(a); return i ? decodeTokenAccount(i.data).amount : 0n; };
const tableAcc = await fork.getAccountInfo(TABLE);
if (!tableAcc) throw new Error("the launch lookup table is not on the fork");
const table: LookupTable = { address: TABLE, addresses: decodeLookupTable(tableAcc.data).addresses };
const tx = (name: string, payer: Signer, ixs: Ix[], cu = 600_000) => sendV0(section, name, payer, ixs, [table], { computeUnits: cu });
const out: Record<string, any> = { started: new Date().toISOString(), fork: FORK_URL, program: IDS.launch, mainnet_slot_of_the_copy: PREP.mainnet_slot, replaced_on_the_fork: PREP.patched,
  agents: { pool_member_on_its_curve: A, pool_member_that_graduates: B, fee_route_only_that_graduates: Z, no_route_that_graduates: Y, no_route: PREP.plain } };
let outcome = "PASS";
const stubState: { served: { agent_id: string; mint: string }[] } = { served: [] };
const stub = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
  const p = new URL(req.url).pathname;
  if (p === "/v1/agents") return Response.json(stubState.served);
  if (p === "/market/quote-usd") return Response.json({ ok: true, usd: 0.001 });
  return new Response("not served by the stand-in", { status: 404 });
} });

try {
  for (const k of [ownerA, ownerB, ownerZ, cranker, helper]) await airdrop(k.id, 5_000_000_000n);
  await airdrop(trader.id, 5_000_000_000_000n);
  const g = await acct(PUMP.global, decodePumpGlobal), fc = await acct(PUMP.feeConfig, decodePumpFeeConfig);
  const lc = (await reader.launchConfig())!, pc = await acct(poolPdas.config(), decodePoolConfig), cc = await acct(claimPdas.config(), decodeClaimConfig);
  const rent0 = BigInt(await fork.getMinimumBalanceForRentExemption(0)), rentToken = rentLamports(TOKEN_ACCOUNT_LEN, rent0);

  // ---------------------------------------------------------------- 0 the fork is mainnet
  const pdFork = (await fork.getAccountInfo(programDataAddress(IDS.launch)))!, pdMain = (await mainnet.getAccountInfo(programDataAddress(IDS.launch)))!;
  check("the launch program on the fork is the code deployed on mainnet, byte for byte", pdFork.data.length === pdMain.data.length && sha(pdFork.data.subarray(45)) === sha(pdMain.data.subarray(45)),
    `${pdFork.data.length - 45} bytes of code, sha256 ${sha(pdFork.data.subarray(45)).slice(0, 16)}`);
  const tMain = await mainnet.getAccountInfo(TABLE), tDec = decodeLookupTable(tableAcc.data);
  const wantTable = launchTableAddresses({ lineMint: LINE, lineTokenProgram: T22, linePool: POOL });
  check("the launch lookup table on the fork is mainnet's, byte for byte: frozen (no authority, so nobody can extend it), never deactivated, the 24 launch addresses",
    !!tMain && sha(tMain.data) === sha(tableAcc.data) && tDec.authority === null && tDec.deactivationSlot === 0xffff_ffff_ffff_ffffn && tDec.addresses.join() === wantTable.join() && tDec.addresses.length === 24,
    `${TABLE}, ${tableAcc.data.length} bytes, ${tableAcc.lamports} lamports of rent paid at the launch setup`);
  check("both feature bits are on, the fee route share and the pool share are mainnet's", (lc.features & FEATURES.pools) !== 0 && (lc.features & FEATURES.githubFees) !== 0 && cc.minBps <= cc.maxBps && pc.poolFeeBps > 0,
    `agent share ${lc.agentComputeBps} bps of the fees; a fee route takes ${cc.minBps} to ${cc.maxBps} bps of it, a pool ${pc.poolFeeBps} bps`);
  const owners = await Promise.all([A, B, Z].map((m) => acct(registryPdas.agent(m.agent), decodeAgent)));
  const launches = await Promise.all([A, B, Z, ...NO_ROUTE].map((m) => reader.agentLaunch(m.mint)));
  const live = { a: launches[0]!.routes, b: launches[1]!.routes };
  check("the agents are live launches on their curves, none with a fee route, and only the pool memberships mainnet has now; the three that take a route have stand-in owners here",
    launches.every((l, i) => !!l && !l.graduated && (i < 2 ? (l.routes & FEATURES.githubFees) === 0 : l.routes === 0))
    && owners[0]!.owner === ownerA.id && owners[1]!.owner === ownerB.id && owners[2]!.owner === ownerZ.id && A.repo_id === B.repo_id && Z.repo_id !== A.repo_id,
    `${[A, B, Z, ...NO_ROUTE].map((m) => m.agent.slice(0, 6)).join(", ")}; pool member on mainnet already: ${[live.a & FEATURES.pools ? A.agent.slice(0, 6) : "", live.b & FEATURES.pools ? B.agent.slice(0, 6) : ""].filter(Boolean).join(", ") || "none"}`);

  // ---------------------------------------------------------------- helpers: trades, the keeper, one exact crank
  const unitsPool = async () => {
    const [ammFcA, pA, bA, qA, mA] = await fork.getMultipleAccounts([PUMP.ammFeeConfig, POOL.pool, POOL.baseVault, POOL.quoteVault, LINE]);
    const pool = decodePumpPool(pA!.data), base = decodeTokenAccount(bA!.data).amount, quote = decodeTokenAccount(qA!.data).amount;
    const rates = poolRates({ creatorFeeConfigurable: g.creatorFeeConfigurable }, decodePumpFeeConfig(ammFcA!.data), pool, decodeMint(mA!.data).supply, quote + pool.virtualQuoteReserves, base);
    return (o: bigint) => quotePoolBuyExactOut(rates, pool, base, quote, o);
  };
  const needUnits = async (amount: bigint) => {
    const have = await bal(ata(trader.id, LINE, T22));
    if (have >= amount) return;
    const buy = amount - have + ONE, q = (await unitsPool())(buy);
    await tx(`trader buys ${buy / ONE} $UNITS on its pool`, trader, pumpSolToLinePool({ launcher: trader.id, lineMint: LINE, pool: POOL.pool, amountOut: buy, maxSolIn: maxSolIn(q.quoteIn, 500), rentToken, lineTokenProgram: T22 }), 300_000);
  };
  /** A round trip on a coin's curve: buy with a tenth of the curve's virtual $UNITS, sell what was bought. Creator fees accrue on both legs. */
  const curveTrip = async (m: Rec) => {
    const c = await acct(pumpPdas.bondingCurve(m.mint), decodeBondingCurve), spend = c.virtualQuoteReserves / 10n;
    await needUnits(spend);
    const h0 = await bal(ata(trader.id, m.mint, T22));
    await tx(`trader buys ${m.agent.slice(0, 6)}'s coin on its curve`, trader, [token.createAtaIdempotent(trader.id, trader.id, m.mint, T22),
      pump.buyExactQuoteInV3({ mint: m.mint, quoteMint: LINE, quoteTokenProgram: T22, user: trader.id, spendableQuoteIn: spend, minTokensOut: 1n })], 400_000);
    await tx(`trader sells ${m.agent.slice(0, 6)}'s coin on its curve`, trader, [pump.sellV3({ mint: m.mint, quoteMint: LINE, quoteTokenProgram: T22, user: trader.id, amount: (await bal(ata(trader.id, m.mint, T22))) - h0, minQuoteOut: 1n })], 400_000);
  };
  const events = async (sig: string) => {
    const t = await fork.call<{ meta: { innerInstructions: { instructions: { data: string }[] }[] } }>("getTransaction", [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
    return (t.meta.innerInstructions ?? []).flatMap((gr) => gr.instructions).map((i) => decodePumpEvent(base58Decode(i.data))).filter((e) => !!e);
  };
  /** A sell and a buy on a graduated coin's PumpSwap pool; returns the coin creator fees its trade events state. */
  const poolTrip = async (m: Rec) => {
    const pool = pumpPdas.pool(m.mint, LINE), trade = { pool, mint: m.mint, quoteMint: LINE, quoteTokenProgram: T22, user: trader.id };
    const held = await bal(ata(trader.id, m.mint, T22)), u0 = await bal(ata(trader.id, LINE, T22));
    const s = await tx(`trader sells ${m.agent.slice(0, 6)}'s coin on its PumpSwap pool`, trader, [pumpAmm.sellV2({ ...trade, baseIn: held / 20n, minQuoteOut: 1n })], 400_000);
    const got = (await bal(ata(trader.id, LINE, T22))) - u0;
    const b = await tx(`trader buys ${m.agent.slice(0, 6)}'s coin on its PumpSwap pool`, trader, [pumpAmm.buyExactQuoteInV2({ ...trade, spendableQuoteIn: got, minBaseOut: 1n })], 400_000);
    let fees = 0n;
    for (const r of [s, b]) for (const e of await events(r.signature)) if ((e.name === "BuyEvent" || e.name === "SellEvent") && e.fields.pool === pool) fees += e.fields.coin_creator_fee as bigint;
    return fees;
  };
  const crankScript = join(import.meta.dir, "crank-fees.ts");
  const keeperRun = async (served: Rec[], extra: string[] = ["--send"], minUsd = "0", script = crankScript) => {
    stubState.served = served.map((m) => ({ agent_id: m.agent, mint: m.mint }));
    const p = spawn(["bun", script, "--core", `http://127.0.0.1:${stub.port}`, "--key", join(KEYS, "cranker.json"), "--min-usd", minUsd, ...extra], { cwd: ROOT, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, UNITS_NETWORK: "mainnet", UNITS_MAINNET_RPC: FORK_URL } });
    const t = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
    await p.exited;
    return t;
  };
  type Routes = { gh?: bigint; pool?: boolean };
  /** Everything one crank of `m` reads and moves. */
  const snap = async (m: Rec, r: Routes) => {
    const creator = launchPdas.pumpCreator(m.agent), poolAt = pumpPdas.pool(m.mint, LINE);
    const [curveA, poolA] = await fork.getMultipleAccounts([pumpPdas.bondingCurve(m.mint), poolAt]);
    const l = (await reader.agentLaunch(m.mint))!;
    return {
      // every place creator fees wait before a crank: inside the curve and the pool, pump.fun's two creator vaults, the creator account's own token account
      waiting: decodeBondingCurve(curveA!.data).creatorFee + (poolA ? decodePumpPool(poolA.data).creatorFees : 0n) + (await bal(ata(pumpPdas.creatorVault(creator), LINE, T22)))
        + (await bal(ata(pumpPdas.ammCreatorVault(creator), LINE, T22))) + (await bal(ata(creator, LINE, T22))),
      fees: l.feesClaimed, toCompute: l.toCompute, toProtocol: l.toProtocol, compute: await bal(launchPdas.computeVault(m.agent)), treasury: await bal(registryPdas.treasury()),
      ghVault: r.gh ? await bal(claimPdas.vault(r.gh)) : 0n, ghRoute: r.gh ? (await acct(claimPdas.feeRoute(m.agent), decodeFeeRoute)).accrued : 0n, ghEscrow: r.gh ? (await acct(claimPdas.escrow(r.gh), decodeClaimEscrow)).accrued : 0n,
      poolVault: r.pool ? await bal(poolPdas.vault(m.repo_id, LINE, T22)) : 0n, member: r.pool ? await acct(poolPdas.member(m.agent), decodePoolMember) : null,
      pool: r.pool ? await acct(poolPdas.pool(m.repo_id), decodePool) : null, payer: await fork.getBalance(cranker.id),
    };
  };
  const cranks: Record<string, unknown>[] = [];
  const counts = { legacy: 0, v0: 0 };
  out.cranks = cranks;
  out.counts = counts;
  let spentOnCranks = 0n;
  /** One keeper run for one agent, sent; checks the form, the size and every amount. */
  const crankCase = async (what: string, m: Rec, r: Routes, want: { form: "legacy" | "v0"; size: number }) => {
    const b = await snap(m, r);
    const t = await keeperRun([m]);
    const a = await snap(m, r);
    const sent = /cranked (\S+) \((legacy|v0), (\d+) bytes/.exec(t), said = /: (\d+) base units of creator fees wait/.exec(t);
    const fees = a.fees - b.fees, routeBps = r.gh ? (await acct(claimPdas.feeRoute(m.agent), decodeFeeRoute)).bps : 0, poolBps = r.pool && b.pool!.members.length >= 2 ? pc.poolFeeBps : 0;
    const w = crankSplit(fees, lc.agentComputeBps, routeBps, poolBps);
    // inside the pool (pool-join-fork.ts's own check): the member's share covers its cross holding first, the rest goes to the three buckets by the configured split
    const cross = b.member && w.toPool > b.member.crossDue ? b.member.crossDue : w.toPool, rest = w.toPool - cross;
    const inPool = !r.pool || (a.member!.contributed - b.member!.contributed === w.toPool && a.member!.crossFunded - b.member!.crossFunded === cross && b.member!.crossDue - a.member!.crossDue === cross
      && a.pool!.bucketPayout - b.pool!.bucketPayout === (rest * BigInt(pc.payoutBps)) / 10_000n && a.pool!.bucketBuyback - b.pool!.bucketBuyback === (rest * BigInt(pc.buybackBps)) / 10_000n
      && a.pool!.bucketBurn - b.pool!.bucketBurn === rest - (rest * BigInt(pc.payoutBps)) / 10_000n - (rest * BigInt(pc.buybackBps)) / 10_000n);
    const exact = inPool && fees > 0n && fees === b.waiting && a.waiting === 0n && a.compute - b.compute === w.toCompute && a.treasury - b.treasury === w.toProtocol && a.toCompute - b.toCompute === w.toCompute
      && a.toProtocol - b.toProtocol === w.toProtocol && a.ghVault - b.ghVault === w.toGithub && a.ghRoute - b.ghRoute === w.toGithub && a.ghEscrow - b.ghEscrow === w.toGithub
      && a.poolVault - b.poolVault === w.toPool && w.toCompute + w.toProtocol + w.toGithub + w.toPool === fees
      && (!r.gh || w.toGithub > 0n) && (!r.pool || b.pool!.members.length < 2 || w.toPool > 0n);
    const cost = sent ? await measure(section, `keeper crank: ${what}`, sent[1]!) : null;
    if (sent) counts[sent[2] as "legacy" | "v0"]++;
    spentOnCranks += b.payer - a.payer;
    const row = { case: what, agent: m.agent, form: sent?.[2] ?? null, bytes: sent ? Number(sent[3]) : null, fees: fees.toString(), keeper_said_waiting: said?.[1] ?? null, to_compute: w.toCompute.toString(), to_protocol: w.toProtocol.toString(),
      to_repository_owners: w.toGithub.toString(), to_pool: w.toPool.toString(), ...(r.pool ? { pool_share_to_its_cross_holding: cross.toString(), pool_share_to_buckets: rest.toString() } : {}), exact, fee_lamports: cost?.fee ?? null, compute_units: cost?.computeUnits ?? null, payer_lamports_on_the_fork: (b.payer - a.payer).toString(),
      // what the payer paid here beyond the fee and the rent of accounts it created: pump.fun tops an existing account up to THIS validator's rent minimum, which is higher than mainnet's; on mainnet those accounts hold their minimum already
      fork_rent_top_up_lamports: cost?.other ?? null,
      created: cost?.created.map((c) => ({ bytes: c.bytes, rent_mainnet: c.mainnetRent })) ?? [], signature: sent?.[1] ?? null };
    cranks.push(row);
    check(`${what}: sent by the keeper as a ${want.form} transaction of ${want.size} bytes; the fees it said wait are the fees it moved; compute, protocol${r.gh ? ", repository owners" : ""}${r.pool ? ", pool" : ""} exact to the base unit; nothing left behind`,
      exact && !!sent && sent[2] === want.form && Number(sent[3]) === want.size && said?.[1] === fees.toString() && /done: 1 crank\(s\) sent/.test(t),
      `fees ${fees}: compute ${w.toCompute}, protocol ${w.toProtocol}${r.gh ? `, repository owners ${w.toGithub}` : ""}${r.pool ? `, pool ${w.toPool}` : ""}; ${sent ? `${sent[2]} ${sent[3]} bytes, ${cost!.computeUnits} CU, fee ${cost!.fee} lamports` : t.trim().split("\n").slice(-2).join(" | ").slice(0, 300)}`);
    return { text: t, fees, row };
  };
  /** A keeper run that must send nothing and move nothing for `m`. */
  const nothing = async (what: string, m: Rec, r: Routes, extra: string[], minUsd: string, says: RegExp, script = crankScript) => {
    const b = await snap(m, r), t = await keeperRun([m], extra, minUsd, script), a = await snap(m, r);
    const same = a.fees === b.fees && a.waiting === b.waiting && a.compute === b.compute && a.payer === b.payer;
    check(what, same && says.test(t) && !/cranked /.test(t), t.trim().split("\n").filter((l) => !/launched agent|lookup table 6dj2/.test(l)).slice(-2).map((l) => l.replace(/^\[crank-fees\] /, "")).join(" | ").slice(0, 330));
    return t;
  };
  /** Completion with a synthetic migration buy, pump.fun's migrate_v2 and the launch program's graduation record (pump-fork-proof.ts steps 8a to 8c, on a live coin). */
  const graduate = async (m: Rec, r: Routes, between?: () => Promise<void>) => {
    const c = await acct(pumpPdas.bondingCurve(m.mint), decodeBondingCurve), past = 5_000_000_000_000n;
    const q = quoteCurveBuyExactOut(g, fc, c, c.realTokenReserves + past, await bal(ata(pumpPdas.bondingCurve(m.mint), m.mint, T22)));
    await needUnits((q.quoteIn * 102n) / 100n);
    await tx(`${m.agent.slice(0, 6)}'s coin: the completing buy past its curve (${q.quoteIn / ONE} $UNITS)`, trader, [token.createAtaIdempotent(trader.id, trader.id, m.mint, T22),
      pump.buyV3({ mint: m.mint, quoteMint: LINE, quoteTokenProgram: T22, user: trader.id, amount: c.realTokenReserves + past, maxQuoteIn: (q.quoteIn * 101n) / 100n })], 600_000);
    const done = await acct(pumpPdas.bondingCurve(m.mint), decodeBondingCurve);
    if (between) await between();
    await tx(`${m.agent.slice(0, 6)}'s coin: migrate_v2 and record_pump_graduation (anyone)`, helper, pumpGraduateIxs({ payer: helper.id, agentMint: m.mint, lineMint: LINE, withdrawAuthority: g.withdrawAuthority, migrated: false, lineTokenProgram: T22 }), 800_000);
    const l = (await reader.agentLaunch(m.mint))!, pool = await acct(pumpPdas.pool(m.mint, LINE), decodePumpPool);
    check(`${m.agent.slice(0, 6)}'s coin graduated: its curve is complete, pump.fun's migrate_v2 made the canonical PumpSwap pool quoted in $UNITS whose coin creator is the agent's creator account, and the launch program recorded it`,
      done.complete && l.graduated && l.pumpPool === pumpPdas.pool(m.mint, LINE) && pool.baseMint === m.mint && pool.quoteMint === LINE && pool.coinCreator === launchPdas.pumpCreator(m.agent) && l.routes === (r.pool ? FEATURES.pools : 0) + (r.gh ? FEATURES.githubFees : 0),
      `pool ${l.pumpPool}`);
  };
  const setRoute = async (m: Rec, owner: Signer, gh: bigint) => {
    await tx(`${m.agent.slice(0, 6)}: set_fee_route to GitHub account ${gh} (a stand-in id), signed by its owner here`, owner, [claims.setFeeRoute({ owner: owner.id, agent: m.agent, agentMint: m.mint, lineMint: LINE, githubId: gh, bps: cc.minBps, lineTokenProgram: T22 })]);
    const fr = await acct(claimPdas.feeRoute(m.agent), decodeFeeRoute);
    if (fr.githubId !== gh || fr.bps !== cc.minBps) throw new Error("the fee route was not set");
  };

  // ---------------------------------------------------------------- 1 no route, on the curve
  section = "1 no route";
  for (const p of PREP.plain) {
    const w0 = (await snap(p, {})).waiting;
    if (p === PREP.plain[0]) await nothing(`a dry run (no --send) of ${p.agent.slice(0, 6)} simulates, says what it would do and sends nothing`, p, {}, [], "0", /simulation ok, would crank \(legacy\)/);
    await crankCase(`no route, on its curve (${p.agent.slice(0, 6)}, the ${w0} base units that wait on mainnet now)`, p, {}, { form: "legacy", size: 860 });
  }
  if (!PREP.plain.length) { await curveTrip(Z); await crankCase(`no route, on its curve (${Z.agent.slice(0, 6)})`, Z, {}, { form: "legacy", size: 860 }); }

  // ---------------------------------------------------------------- 2 routed, on the curve
  section = "2 routed on the curve";
  // both agents of the repository end up in its pool (a pool routes once it has two members); one that is a member on mainnet already stays as it is
  for (const [m, owner] of [[A, ownerA], [B, ownerB]] as const) {
    const poolA = await fork.getAccountInfo(poolPdas.pool(m.repo_id)), members = poolA ? decodePool(poolA.data).members : [];
    if (members.includes(m.agent)) continue;
    // a fork-only step: this validator's rent is higher than mainnet's (0 bytes: 890,880 lamports here, 650,240 there), so the pool's accounts copied from mainnet are under
    // this validator's minimum and join_pool's rent checks on them fail here; they are topped up. On mainnet they hold mainnet's minimum already.
    if (poolA) {
      const copied = [poolPdas.pool(m.repo_id), poolPdas.vault(m.repo_id, LINE, T22), ...members.map((x) => poolPdas.member(x))];
      for (const x of copied) await airdrop(x, 10_000_000n);
      out.fork_only_top_up = `${copied.length} accounts of the pool copied from mainnet (the pool, its vault, its member): 0.01 SOL each, for this validator's higher rent`;
    }
    await tx(`${m.agent.slice(0, 6)} ${members.length ? "joins" : "opens"} the pool of its repository (join_pool, its owner here)`, owner, [pools.joinPool({ signer: owner.id, agent: m.agent, agentMint: m.mint, repoId: m.repo_id, lineMint: LINE, members })]);
  }
  const joined = await acct(poolPdas.pool(A.repo_id), decodePool);
  if (joined.members.length !== 2) throw new Error("the pool does not have its two members");
  await curveTrip(A);
  await crankCase(`pool member, on its curve (${A.agent.slice(0, 6)})`, A, { pool: true }, { form: "legacy", size: 992 });
  await setRoute(A, ownerA, GH.a);
  await curveTrip(A);
  await crankCase(`fee route and pool member, on its curve (${A.agent.slice(0, 6)})`, A, { gh: GH.a, pool: true }, { form: "legacy", size: 1091 });
  await setRoute(Z, ownerZ, GH.z);
  await curveTrip(Z);
  await crankCase(`fee route, on its curve (${Z.agent.slice(0, 6)})`, Z, { gh: GH.z }, { form: "legacy", size: 959 });

  // ---------------------------------------------------------------- 3 a pool member graduates: version 0
  section = "3 routed and graduated";
  const OLD = process.env.CRANK_V0_OLD_SCRIPT ?? "";
  await graduate(B, { pool: true }, async () => {
    await crankCase(`pool member whose curve is complete and not migrated yet: cranked on its curve, the first crank of this agent (${B.agent.slice(0, 6)})`, B, { pool: true }, { form: "legacy", size: 992 });
  });
  {
    const stated = await poolTrip(B), w = await snap(B, { pool: true }), p = await acct(pumpPdas.pool(B.mint, LINE), decodePumpPool);
    check("trades on the PumpSwap pool leave the coin creator fees inside the pool until pump.fun's sweep: what waits is what the trade events state", p.creatorFees === stated && w.waiting === stated && stated > 0n, `${stated} base units`);
    if (OLD) out.before_this_change_pool_member_graduated = (await nothing("the keeper script before this change does not crank a pool member whose coin graduated: the fees wait", B, { pool: true }, ["--send"], "0", /bytes|not sent/, OLD)).trim().split("\n").slice(-2);
    await nothing("a dry run of the graduated pool member says version 0 and sends nothing", B, { pool: true }, [], "0", /v0 transaction, 1108 bytes \(1258 as legacy\), 6 accounts from the lookup table[\s\S]*simulation ok, would crank \(v0\)/);
    await nothing("the --min-usd rule holds for it: below the threshold nothing is simulated or sent", B, { pool: true }, ["--send"], "1000000000", /done: 0 crank\(s\) sent/);
    await nothing("with a lookup table that cannot be used (an address that holds no table) the crank is not sent and says both sizes; the fees wait, nothing is lost", B, { pool: true }, ["--send", "--table", generateAgentKey().id],
      "0", /is not usable \(no account at that address\): legacy transactions only[\s\S]*not sent, transaction does not fit the 1232-byte packet: 1258 bytes as a legacy transaction, no usable lookup table/);
    await crankCase(`pool member, graduated (${B.agent.slice(0, 6)})`, B, { pool: true }, { form: "v0", size: 1108 });
    await nothing("a second run right after finds nothing to do", B, { pool: true }, ["--send"], "0", /0 base units of creator fees wait[\s\S]*done: 0 crank\(s\) sent/);
  }
  await setRoute(B, ownerB, GH.b);
  {
    const stated = await poolTrip(B);
    if (OLD) out.before_this_change_route_and_pool_graduated = (await nothing("the keeper script before this change does not crank a routed pool member whose coin graduated: the fees wait", B, { gh: GH.b, pool: true }, ["--send"], "0", /bytes|not sent/, OLD)).trim().split("\n").slice(-2);
    const first = await crankCase(`fee route and pool member, graduated: the largest crank (${B.agent.slice(0, 6)})`, B, { gh: GH.b, pool: true }, { form: "v0", size: 1207 });
    check("that crank moved exactly the coin creator fees the pool's trade events state", first.fees === stated, `${stated}`);
    await nothing("a second run right after finds nothing to do", B, { gh: GH.b, pool: true }, ["--send"], "0", /done: 0 crank\(s\) sent/);
    for (let i = 0; i < 2; i++) { await poolTrip(B); await crankCase(`fee route and pool member, graduated, again (${i + 2} of 3)`, B, { gh: GH.b, pool: true }, { form: "v0", size: 1207 }); }
  }

  // the trader sells most of what the completing buy left it, so the next completions need less of the $UNITS pool (its fees are cranked in section 5)
  await tx(`trader sells ${B.agent.slice(0, 6)}'s coin on its PumpSwap pool`, trader, [pumpAmm.sellV2({ pool: pumpPdas.pool(B.mint, LINE), mint: B.mint, quoteMint: LINE, quoteTokenProgram: T22, user: trader.id,
    baseIn: ((await bal(ata(trader.id, B.mint, T22))) * 6n) / 10n, minQuoteOut: 1n })], 400_000);

  // ---------------------------------------------------------------- 4 no pool, graduated: legacy
  section = "4 graduated without a pool";
  await graduate(Z, { gh: GH.z });
  await poolTrip(Z);
  await crankCase(`fee route, graduated: the largest legacy crank (${Z.agent.slice(0, 6)})`, Z, { gh: GH.z }, { form: "legacy", size: 1225 });
  if (Y) {
    await graduate(Y, {});
    await poolTrip(Y);
    await crankCase(`no route, graduated (${Y.agent.slice(0, 6)})`, Y, {}, { form: "legacy", size: 1126 });
  }

  // ---------------------------------------------------------------- 5 one run over every agent
  section = "5 every agent in one run";
  const everyone = [...NO_ROUTE, A, B, Z];
  await curveTrip(A);
  await poolTrip(B);
  await poolTrip(Z);
  {
    const routesOf = (m: Rec): Routes => (m === A ? { gh: GH.a, pool: true } : m === B ? { gh: GH.b, pool: true } : m === Z ? { gh: GH.z } : {});
    const b = await Promise.all(everyone.map((m) => snap(m, routesOf(m))));
    const t = await keeperRun(everyone);
    const a = await Promise.all(everyone.map((m) => snap(m, routesOf(m))));
    const moved = everyone.map((_, i) => a[i]!.fees - b[i]!.fees);
    const busy = b.filter((x) => x.waiting > 0n).length;
    const forms = [...t.matchAll(/cranked \S+ \((legacy|v0), (\d+) bytes/g)].map((x) => `${x[1]} ${x[2]}`);
    for (const f of forms) counts[f.startsWith("v0") ? "v0" : "legacy"]++;
    spentOnCranks += b[0]!.payer - a[0]!.payer;
    check(`one keeper run over ${everyone.length} agents cranks each one that has fees in the form its size needs, moves exactly what waited for each and leaves nothing`,
      moved.every((f, i) => f === b[i]!.waiting) && a.every((x) => x.waiting === 0n) && forms.length === busy && forms.includes("v0 1207") && forms.includes("legacy 1225") && forms.includes("legacy 1091")
      && new RegExp(`done: ${busy} crank\\(s\\) sent \\(${busy - 1} legacy, 1 v0\\)`).test(t), `${forms.join(", ")}; ${t.trim().split("\n").at(-1)!.replace(/^\[crank-fees\] /, "")}`);
    const again = await keeperRun(everyone);
    check("the run after it finds nothing to do for any agent", /done: 0 crank\(s\) sent/.test(again) && !/cranked /.test(again));
  }
  // what the keeper's payer paid over the whole run: the cranks' fees and the one token account, nothing for a table
  const paid = 5_000_000_000n - (await fork.getBalance(cranker.id));
  const createdRows = cranks.flatMap((c) => c.created as { bytes: number; rent_mainnet: string }[]);
  check("the keeper's payer paid for its cranks and nothing else: no lookup table was created or extended; the only accounts it paid rent for are token accounts, one on an agent's first crank (its creator account's) and one on the first crank after its coin graduated (pump.fun's pool creator vault)",
    paid === spentOnCranks && createdRows.length >= 1 && createdRows.every((c) => c.bytes === 170) && (await fork.getProgramAccounts("AddressLookupTab1e1111111111111111111111111", { memcmp: [{ offset: 22, bytes: addressBytes(cranker.id) }] })).length === 0,
    `${sol(paid)} SOL over ${counts.legacy + counts.v0} cranks (${counts.legacy} legacy, ${counts.v0} v0); accounts it paid rent for: ${createdRows.map((c) => `${c.bytes} bytes, ${c.rent_mainnet} lamports at mainnet rent`).join("; ")}`);
  const perForm = (f: string) => cranks.filter((c) => c.form === f && (c.created as unknown[]).length === 0);
  out.cost = {
    lookup_table: "none created: the keeper reads the frozen launch lookup table and pays no rent for a table",
    fee_per_crank_lamports: { legacy: [...new Set(perForm("legacy").map((c) => c.fee_lamports))], v0: [...new Set(perForm("v0").map((c) => c.fee_lamports))] },
    compute_units: { legacy_max: Math.max(...cranks.filter((c) => c.form === "legacy").map((c) => c.compute_units as number)), v0_max: Math.max(...cranks.filter((c) => c.form === "v0").map((c) => c.compute_units as number)) },
    accounts_the_payer_paid_rent_for: cranks.filter((c) => (c.created as unknown[]).length > 0).map((c) => ({ case: c.case, created: c.created })),
    note: "the fork charges the base fee per signature (5,000 lamports) plus the priority fee at the profile's floor of 1 micro-lamport per compute unit; on mainnet the priority fee follows recent fees up to the profile's cap, on the default compute limit (no limit instruction is sent: 200,000 units per instruction that is not a budget instruction). fork_rent_top_up_lamports of a crank is not a mainnet cost",
  };
} catch (e) {
  outcome = `FAILED: ${String((e as Error)?.stack ?? e).slice(0, 600)}`;
  console.error(e);
} finally {
  stub.stop(true);
}
const passed = checks.filter((c) => c.ok).length;
if (passed !== checks.length && outcome === "PASS") outcome = "FAILED: a check did not hold";
out.finished = new Date().toISOString();
out.outcome = outcome;
out.pass = passed;
out.total = checks.length;
out.sections = sections;
out.checks = checks;
writeFileSync(OUT_FILE, JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 1) + "\n");
log(`${outcome}: ${passed}/${checks.length}; ${OUT_FILE}`);
process.exit(outcome === "PASS" ? 0 : 1);
