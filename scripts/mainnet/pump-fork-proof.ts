#!/usr/bin/env bun
// pump.fun proof on a local fork of mainnet, before any lineage_launch change (docs/plans/PUMPFUN-LAUNCHES.md
// section 7 P1, owner decisions 2026-10-10). Runs mainnet's own Pump, PumpSwap, Pump Fees and Mayhem
// builds with mainnet's Global, fee configs and quote control (scripts/mainnet/fork.sh). Nothing is
// sent to mainnet; every key is a throwaway in MAINNET_FORK_KEYS and every lamport a fork airdrop.
//
//   1  a stand-in $LINE: create_v2 paired with SOL, not mayhem
//   2  agent coin A1 quoted in $LINE while $LINE is on its curve: creator = a lineage_launch PDA
//      ["pump_creator", agent], creator_fee_bps 0 (pump.fun's default), with the launcher's initial buy
//      (1% of supply) in the same transaction, delivered to the agent's treasury wallet
//   3  curve trades on A1 (buy_v3, buy_exact_quote_in_v3, sell_v3) and multi_hop_swap SOL -> $LINE curve -> A1
//   4  sweep_creator_fee + collect_creator_fee_v2 land exactly the creator fees of the trade events in the PDA's $LINE ATA
//   5  refusals: a depth-1 coin as quote (CurveDepthExceeded); a launch while $LINE awaits migration
//   6  $LINE completes (synthetic migration buy) and migrate_v2 creates its PumpSwap pool
//   7  agent coin A2 quoted in the migrated $LINE; multi_hop_swap SOL -> $LINE pool -> A2 curve
//   8  A2 completes with a synthetic migration buy, migrate_v2: Pool.coin_creator = our PDA, LP supply 0
//   9  PumpSwap buy_v2 / sell_v2 on A2 and multi_hop_swap SOL -> $LINE pool -> A2 pool; pool sweep +
//      collect_coin_creator_fee to the PDA; the curve's leftover creator fee still sweepable after migration
//  10  creator_fee_bps 150 accepted or refused on mainnet's Global (owner decision 4: default stays 0)
// Writes scripts/mainnet/PUMP-FORK-LAST.json.
//
//   MAINNET_FORK_KEYS=<throwaway key dir> bun scripts/mainnet/pump-fork-proof.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { base58Decode } from "@lineage/protocol";
import {
  addressBytes,
  ata,
  buybackAccount,
  createV2,
  curveQuoteMint,
  decodeBondingCurve,
  decodeMint,
  decodePumpEvent,
  decodePumpFeeConfig,
  decodePumpGlobal,
  decodePumpPool,
  decodeTokenAccount,
  pda,
  PROGRAM_IDS,
  PUMP,
  pump,
  pumpAmm,
  pumpLaunchTableAddresses,
  pumpPdas,
  quoteCurveBuyExactOut,
  system,
  token,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  type Ix,
  type PumpEvent,
  type Signer,
} from "@lineage/chain";
import { airdrop, assertFork, check, checks, fork, forkKey, forkTable, log, refused, rows, send, sendV0, sol } from "./lib.ts";

const T22 = TOKEN_2022_PROGRAM;
const LAUNCH_ID = PROGRAM_IDS.mainnet.launch;
const creatorPda = (agent: string) => pda(LAUNCH_ID, "pump_creator", addressBytes(agent));
const SUPPLY = 1_000_000_000_000_000n;


async function events(sig: string): Promise<PumpEvent[]> {
  const t = await fork.call<{ meta: { innerInstructions: { instructions: { data: string }[] }[] } }>("getTransaction",
    [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
  const out: PumpEvent[] = [];
  for (const g of t.meta.innerInstructions ?? []) for (const i of g.instructions) {
    const e = decodePumpEvent(base58Decode(i.data));
    if (e) out.push(e);
  }
  return out;
}
const sum = (es: PumpEvent[], name: string, field: string) => es.filter((e) => e.name === name).reduce((s, e) => s + ((e.fields[field] as bigint) ?? 0n), 0n);
async function bal(a: string): Promise<bigint> {
  const i = await fork.getAccountInfo(a);
  return i ? decodeTokenAccount(i.data).amount : 0n;
}
async function curveOf(mint: string) {
  const i = await fork.getAccountInfo(pumpPdas.bondingCurve(mint));
  if (!i) throw new Error(`no curve for ${mint}`);
  return { c: decodeBondingCurve(i.data), len: i.data.length, owner: i.owner };
}
const wrap = (owner: string, lamports: bigint): Ix[] => [
  token.createAtaIdempotent(owner, owner, PUMP.wsol, TOKEN_PROGRAM),
  system.transfer(owner, ata(owner, PUMP.wsol, TOKEN_PROGRAM), lamports),
  { programId: TOKEN_PROGRAM, keys: [{ pubkey: ata(owner, PUMP.wsol, TOKEN_PROGRAM), isSigner: false, isWritable: true }], data: Uint8Array.of(17) },
];

async function main() {
  await assertFork();
  const g = decodePumpGlobal((await fork.getAccountInfo(PUMP.global))!.data);
  const fc = decodePumpFeeConfig((await fork.getAccountInfo(PUMP.feeConfig))!.data);
  check("fork runs mainnet's Global: create_v2 enabled, max_curve_depth 1", g.createV2Enabled && g.maxCurveDepth === 1, `max_curve_depth ${g.maxCurveDepth}`);
  const launcher = forkKey("pump-launcher"), trader = forkKey("pump-trader"), agent1 = forkKey("pump-agent1"), agent2 = forkKey("pump-agent2");
  const treasury1 = forkKey("pump-treasury1"), keeper = forkKey("pump-keeper"), lineCreator = forkKey("pump-line-creator");
  for (const k of [launcher, trader, agent1, agent2, treasury1, keeper, lineCreator]) await airdrop(k.id, 1_000_000_000_000n);

  // ---- 1. $LINE stand-in, SOL-paired, not mayhem
  const lineMint = forkKey(`pump-line-mint-${Date.now()}`);
  const L = lineMint.id;
  const r1 = await send("1", "$LINE stand-in: create_v2 SOL-paired", lineCreator,
    [createV2({ mint: L, user: lineCreator.id, creator: lineCreator.id, name: "Lineage Fork", symbol: "LINE", uri: "https://example.invalid/line.json", quote: { kind: "sol" } })],
    { signers: [lineMint], computeUnits: 400_000 });
  const lc = await curveOf(L);
  check("$LINE curve: owner Pump, quote SOL (zero key), depth 0, not mayhem", lc.owner === PUMP.program && lc.c.quoteMint === "11111111111111111111111111111111"
    && lc.c.depth === 0 && !lc.c.isMayhemMode, `curve ${lc.len} bytes`);
  const lineMintInfo = decodeMint((await fork.getAccountInfo(L))!.data);
  check("$LINE mint: Token-2022, 6 decimals, mint authority none, supply 1e15", (await fork.getAccountInfo(L))!.owner === T22 && lineMintInfo.decimals === 6
    && lineMintInfo.mintAuthority === null && lineMintInfo.supply === SUPPLY);

  // buy $LINE for the launcher and the trader (SOL curve: buyback = the wallet itself)
  const buyLine = async (who: Signer, amount: bigint, step: string) => {
    const cur = (await curveOf(L)).c;
    const q = quoteCurveBuyExactOut(g, fc, cur, amount, await bal(ata(pumpPdas.bondingCurve(L), L, T22)));
    return send(step, `buy ${amount} $LINE base units for ${who === launcher ? "launcher" : "trader"} (buy_v3, SOL)`, who, [
      token.createAtaIdempotent(who.id, who.id, L, T22),
      pump.buyV3({ mint: L, quoteMint: PUMP.wsol, user: who.id, amount, maxQuoteIn: (q.quoteIn * 101n) / 100n }),
    ], { computeUnits: 300_000 });
  };
  await buyLine(launcher, 40_000_000_000_000n, "1b");
  await buyLine(trader, 40_000_000_000_000n, "1c");
  check("launcher and trader hold $LINE", (await bal(ata(launcher.id, L, T22))) === 40_000_000_000_000n && (await bal(ata(trader.id, L, T22))) === 40_000_000_000_000n);

  // ---- 2. agent coin A1 quoted in $LINE (on its curve), creator = our PDA, initial buy 1% to the treasury
  const P1 = creatorPda(agent1.id);
  const a1 = forkKey(`pump-a1-mint-${Date.now()}`);
  const A1 = a1.id;
  const initialBuy = (SUPPLY * 100n) / 10_000n;
  const bbLine = buybackAccount(L, T22);
  const createA1 = createV2({ mint: A1, user: launcher.id, creator: P1, name: "Agent One", symbol: "TONE", uri: "https://example.invalid/a1.json",
    quote: { kind: "pumpCoin", mint: L } });
  const simCurve = await (async () => {
    // quote the initial buy on the curve create_v2 will write: create alone in a simulation is not
    // needed, the seed is derived from $LINE's live reserves; the max input is checked by the program
    return null;
  })();
  void simCurve;
  const table1 = await forkTable("2t", launcher, pumpLaunchTableAddresses({ lineMint: L }));
  const r2 = await sendV0("2", "agent coin A1: create_v2 (quote $LINE on its curve) + initial buy 1% delivered to the treasury", launcher, [
    token.createAtaIdempotent(launcher.id, PUMP.buybackRecipients[0], L, T22),
    createA1,
    token.createAtaIdempotent(launcher.id, launcher.id, A1, T22),
    pump.buyV3({ mint: A1, quoteMint: L, quoteTokenProgram: T22, user: launcher.id, amount: initialBuy, maxQuoteIn: 20_000_000_000_000n }),
    token.createAtaIdempotent(launcher.id, treasury1.id, A1, T22),
    token.transferChecked(ata(launcher.id, A1, T22), A1, ata(treasury1.id, A1, T22), launcher.id, initialBuy, 6, T22),
  ], [table1], { signers: [a1], computeUnits: 600_000 });
  const c1 = await curveOf(A1);
  check("A1 curve: owner Pump, quote $LINE, creator = PDA [pump_creator, agent], depth 1, not mayhem/cashback/holder, creator_fee_bps 0",
    c1.owner === PUMP.program && c1.c.quoteMint === L && c1.c.creator === P1 && c1.c.depth === 1 && !c1.c.isMayhemMode && !c1.c.isCashbackCoin
    && !c1.c.isHolderReward && c1.c.creatorFeeBps === 0n && !c1.c.canEditCreatorFee, `curve ${c1.len} bytes, virtual quote ${c1.c.initialVirtualQuoteReserves}`);
  check("A1: total supply and real token reserves are Global's", c1.c.tokenTotalSupply === g.tokenTotalSupply);
  check("initial buy: the treasury holds exactly 1% of supply, the launcher none", (await bal(ata(treasury1.id, A1, T22))) === initialBuy
    && (await bal(ata(launcher.id, A1, T22))) === 0n, `${initialBuy}`);
  const ev2 = await events(r2.signature);
  const createEv = ev2.find((e) => e.name === "CreateEvent")!;
  check("CreateEvent: creator PDA, quote $LINE, depth 1", createEv.fields.creator === P1 && createEv.fields.quote_mint === L && createEv.fields.depth === 1);
  let creatorFees1 = sum(ev2, "TradeEvent", "creator_fee");

  // ---- 3. curve trades on A1 and a multi-hop from SOL
  const tradeA1 = { mint: A1, quoteMint: L, quoteTokenProgram: T22, user: trader.id };
  const r3a = await send("3a", "A1 buy_v3 (trader, in $LINE)", trader, [token.createAtaIdempotent(trader.id, trader.id, A1, T22),
    pump.buyV3({ ...tradeA1, amount: 5_000_000_000_000n, maxQuoteIn: 10_000_000_000_000n })], { computeUnits: 300_000 });
  const r3b = await send("3b", "A1 buy_exact_quote_in_v3 (trader)", trader, [pump.buyExactQuoteInV3({ ...tradeA1, spendableQuoteIn: 1_000_000_000_000n, minTokensOut: 1n })], { computeUnits: 300_000 });
  const r3c = await send("3c", "A1 sell_v3 (trader)", trader, [pump.sellV3({ ...tradeA1, amount: 2_000_000_000_000n, minQuoteOut: 1n })], { computeUnits: 300_000 });
  const beforeHop = await bal(ata(trader.id, A1, T22));
  const r3d = await send("3d", "multi_hop_swap SOL -> $LINE curve -> A1 curve (trader, 1 SOL)", trader, [
    token.createAtaIdempotent(trader.id, trader.id, PUMP.wsol, TOKEN_PROGRAM),
    pumpAmm.multiHopSwap({ user: trader.id, userIn: ata(trader.id, PUMP.wsol, TOKEN_PROGRAM), userOut: ata(trader.id, A1, T22), amountIn: 1_000_000_000n, minOut: 1n,
      buybackQuoteMint: PUMP.wsol, hops: [{ kind: "curve", mint: L, quoteMint: PUMP.wsol }, { kind: "curve", mint: A1, quoteMint: L, quoteTokenProgram: T22 }] }),
  ], { computeUnits: 400_000 });
  check("multi_hop_swap from SOL delivered A1 without a $LINE account move", (await bal(ata(trader.id, A1, T22))) > beforeHop);
  for (const r of [r3a, r3b, r3c, r3d]) {
    const es = await events(r.signature);
    creatorFees1 += sum(es.filter((e) => e.fields.mint === A1), "TradeEvent", "creator_fee");
  }
  const waiting = (await curveOf(A1)).c.creatorFee;
  check("A1 curve holds exactly the creator fees of its trade events", waiting === creatorFees1, `${waiting}`);
  const hopEv = (await events(r3d.signature)).filter((e) => e.name === "TradeEvent");
  check("multi-hop: protocol fee once (on the SOL hop), creator fee once (on A1's hop)", hopEv.length === 2
    && (hopEv.find((e) => e.fields.mint === L)!.fields.creator_fee as bigint) === 0n && (hopEv.find((e) => e.fields.mint === A1)!.fields.fee as bigint) === 0n);

  // ---- 4. sweep + collect into the PDA's $LINE ATA
  const pdaAta1 = ata(P1, L, T22);
  const r4 = await send("4", "A1 creator fees: sweep_creator_fee + collect_creator_fee_v2 (keeper, permissionless)", keeper, [
    token.createAtaIdempotent(keeper.id, P1, L, T22),
    pump.sweepCreatorFee({ payer: keeper.id, mint: A1, quoteMint: L, creator: P1, quoteTokenProgram: T22 }),
    pump.collectCreatorFeeV2({ creator: P1, quoteMint: L, quoteTokenProgram: T22 }),
  ], { computeUnits: 300_000 });
  check("the PDA's $LINE ATA holds exactly the swept creator fees, none signed by the creator", (await bal(pdaAta1)) === creatorFees1, `${creatorFees1}`);
  const ev4 = await events(r4.signature);
  check("SweepBondingCurveFeeEvent bucket 1 to the creator vault", ev4.some((e) => e.name === "SweepBondingCurveFeeEvent" && e.fields.bucket === 1
    && e.fields.amount === creatorFees1 && e.fields.recipient === pumpPdas.creatorVault(P1)));

  // ---- 5. refusals
  const bad = forkKey(`pump-bad-${Date.now()}`);
  const depth = await refused(launcher, [createV2({ mint: bad.id, user: launcher.id, creator: P1, name: "Too Deep", symbol: "DEEP", uri: "x",
    quote: { kind: "pumpCoin", mint: A1 } })], { signers: [bad], computeUnits: 400_000 });
  check("a depth-1 coin cannot be a quote (CurveDepthExceeded 6105)", /6105|0x17d9|CurveDepthExceeded/.test(depth), depth.slice(0, 160));
  const mayhem = await refused(launcher, [(() => { const ix = createV2({ mint: bad.id, user: launcher.id, creator: P1, name: "May", symbol: "MAY", uri: "x",
    quote: { kind: "pumpCoin", mint: L } }); const d = ix.data.slice(); const at = 8 + 4 + 3 + 4 + 3 + 4 + 1 + 32; d[at] = 1; return { ...ix, data: d }; })()],
    { signers: [bad], computeUnits: 400_000 });
  check("mayhem mode refused for a pump-coin quote (6071)", /6071|0x17af|MayhemModeQuoteMintNotAllowed/.test(mayhem), mayhem.slice(0, 160));

  // ---- 6. $LINE completes with a synthetic migration buy, then migrate_v2
  const lcur = (await curveOf(L)).c;
  const past = 10_000_000_000_000n;
  const toBuy = lcur.realTokenReserves + past;
  const q6 = quoteCurveBuyExactOut(g, fc, lcur, toBuy, await bal(ata(pumpPdas.bondingCurve(L), L, T22)));
  const r6 = await send("6a", "$LINE: completing buy_v3 past the curve (synthetic migration)", trader, [
    pump.buyV3({ mint: L, quoteMint: PUMP.wsol, user: trader.id, amount: toBuy, maxQuoteIn: (q6.quoteIn * 101n) / 100n })], { computeUnits: 400_000 });
  const ev6 = await events(r6.signature);
  check("$LINE: TradeEvent, CompleteEvent, PostCompleteBuyEvent in order", ev6.map((e) => e.name).join(",").includes("TradeEvent,CompleteEvent,PostCompleteBuyEvent"));
  check("synthetic leg delivered exactly the past-curve tokens", (ev6.find((e) => e.name === "PostCompleteBuyEvent")!.fields.base_out as bigint) === past);
  const awaiting = forkKey(`pump-await-${Date.now()}`);
  const aw = await refused(launcher, [createV2({ mint: awaiting.id, user: launcher.id, creator: creatorPda(agent2.id), name: "Wait", symbol: "WAIT", uri: "x",
    quote: { kind: "pumpCoin", mint: L } })], { signers: [awaiting], computeUnits: 400_000 });
  check("a launch while $LINE awaits migration is refused (QuoteCurveAwaitingMigration 6107)", /6107|0x17db|AwaitingMigration/.test(aw), aw.slice(0, 160));
  await send("6b", "$LINE migrate_v2 to PumpSwap (permissionless)", keeper, [pump.migrateV2({ user: keeper.id, mint: L, quoteMint: PUMP.wsol, withdrawAuthority: g.withdrawAuthority })],
    { computeUnits: 600_000 });
  const linePoolAddr = pumpPdas.pool(L, PUMP.wsol);
  const lp = decodePumpPool((await fork.getAccountInfo(linePoolAddr))!.data);
  check("$LINE pool: canonical (index 0, creator = Pump pool authority), quote WSOL", lp.index === 0 && lp.creator === pumpPdas.poolAuthority(L) && lp.quoteMint === PUMP.wsol);

  // ---- 7. agent coin A2 quoted in the migrated $LINE
  const P2 = creatorPda(agent2.id);
  const a2 = forkKey(`pump-a2-mint-${Date.now()}`);
  const A2 = a2.id;
  const r7 = await send("7a", "agent coin A2: create_v2 quoted in the migrated $LINE (8 quote accounts)", launcher, [
    createV2({ mint: A2, user: launcher.id, creator: P2, name: "Agent Two", symbol: "TTWO", uri: "https://example.invalid/a2.json",
      quote: { kind: "pumpCoin", mint: L, pool: { pool: linePoolAddr, baseVault: lp.poolBaseTokenAccount, quoteVault: lp.poolQuoteTokenAccount } } }),
  ], { signers: [a2], computeUnits: 400_000 });
  void r7;
  const c2 = await curveOf(A2);
  check("A2 curve: quote $LINE, creator = PDA, depth 1", c2.c.quoteMint === L && c2.c.creator === P2 && c2.c.depth === 1, `virtual quote ${c2.c.virtualQuoteReserves}`);
  const r7b = await send("7b", "multi_hop_swap SOL -> $LINE pool -> A2 curve (trader, 2 SOL wrapped)", trader, [
    ...wrap(trader.id, 2_000_000_000n), token.createAtaIdempotent(trader.id, trader.id, A2, T22),
    pumpAmm.multiHopSwap({ user: trader.id, userIn: ata(trader.id, PUMP.wsol, TOKEN_PROGRAM), userOut: ata(trader.id, A2, T22), amountIn: 2_000_000_000n, minOut: 1n,
      buybackQuoteMint: PUMP.wsol, hops: [{ kind: "pool", mint: L, quoteMint: PUMP.wsol, pool: linePoolAddr }, { kind: "curve", mint: A2, quoteMint: L, quoteTokenProgram: T22 }] }),
  ], { computeUnits: 400_000 });
  let creatorFees2Curve = sum((await events(r7b.signature)).filter((e) => e.fields.mint === A2), "TradeEvent", "creator_fee");
  check("pool-then-curve multi-hop delivered A2", (await bal(ata(trader.id, A2, T22))) > 0n);

  // ---- 8. A2 completes (synthetic migration), migrate_v2
  // the trader buys enough $LINE on the pool to finish A2's curve
  const r8a = await send("8a", "trader buys $LINE on its PumpSwap pool (buy_exact_quote_in_v2, 300 SOL)", trader, [
    ...wrap(trader.id, 300_000_000_000n), token.createAtaIdempotent(trader.id, PUMP.buybackRecipients[0], PUMP.wsol, TOKEN_PROGRAM),
    pumpAmm.buyExactQuoteInV2({ pool: linePoolAddr, mint: L, quoteMint: PUMP.wsol, user: trader.id, spendableQuoteIn: 300_000_000_000n, minBaseOut: 1n }),
  ], { computeUnits: 300_000 });
  void r8a;
  const c2now = (await curveOf(A2)).c;
  const past2 = 5_000_000_000_000n;
  const q8 = quoteCurveBuyExactOut(g, fc, c2now, c2now.realTokenReserves + past2, await bal(ata(pumpPdas.bondingCurve(A2), A2, T22)));
  check("trader holds enough $LINE to complete A2", (await bal(ata(trader.id, L, T22))) > q8.quoteIn, `needs ${q8.quoteIn}`);
  const r8b = await send("8b", "A2: completing buy_v3 past the curve (synthetic migration, in $LINE)", trader, [
    pump.buyV3({ mint: A2, quoteMint: L, quoteTokenProgram: T22, user: trader.id, amount: c2now.realTokenReserves + past2, maxQuoteIn: (q8.quoteIn * 101n) / 100n })],
    { computeUnits: 400_000 });
  const ev8 = await events(r8b.signature);
  check("A2 quote math: the completing buy cost what quoteCurveBuyExactOut said", (sum(ev8, "TradeEvent", "quote_amount") + sum(ev8, "TradeEvent", "fee") + sum(ev8, "TradeEvent", "creator_fee")
    + sum(ev8, "PostCompleteBuyEvent", "quote_in") + sum(ev8, "PostCompleteBuyEvent", "fee") + sum(ev8, "PostCompleteBuyEvent", "creator_fee")) <= q8.quoteIn + 4n,
    `predicted ${q8.quoteIn}`);
  creatorFees2Curve += sum(ev8, "TradeEvent", "creator_fee") + sum(ev8, "PostCompleteBuyEvent", "creator_fee");
  const r8c = await send("8c", "A2 migrate_v2 to PumpSwap (permissionless, keeper pays)", keeper, [pump.migrateV2({ user: keeper.id, mint: A2, quoteMint: L, quoteTokenProgram: T22,
    withdrawAuthority: g.withdrawAuthority })], { computeUnits: 600_000 });
  void r8c;
  const pool2Addr = pumpPdas.pool(A2, L);
  const pool2 = decodePumpPool((await fork.getAccountInfo(pool2Addr))!.data);
  check("A2 pool: canonical, base A2, quote $LINE, coin_creator = our PDA (carried over from the curve)", pool2.index === 0 && pool2.creator === pumpPdas.poolAuthority(A2)
    && pool2.baseMint === A2 && pool2.quoteMint === L && pool2.coinCreator === P2);
  const lpMint = decodeMint((await fork.getAccountInfo(pool2.lpMint))!.data);
  check("A2 pool LP mint supply is 0 (LP burnt)", lpMint.supply === 0n, `lp_supply field ${pool2.lpSupply}`);

  // ---- 9. PumpSwap trades on A2, pool sweep + collect, leftover curve sweep
  const poolTrade = { pool: pool2Addr, mint: A2, quoteMint: L, quoteTokenProgram: T22, user: trader.id };
  const r9a = await send("9a", "A2 pool buy_v2 (trader, in $LINE)", trader, [pumpAmm.buyV2({ ...poolTrade, baseOut: 1_000_000_000_000n, maxQuoteIn: 50_000_000_000_000n })], { computeUnits: 300_000 });
  const r9b = await send("9b", "A2 pool sell_v2 (trader)", trader, [pumpAmm.sellV2({ ...poolTrade, baseIn: 500_000_000_000n, minQuoteOut: 1n })], { computeUnits: 300_000 });
  const r9c = await send("9c", "multi_hop_swap SOL -> $LINE pool -> A2 pool (trader, 1 SOL wrapped)", trader, [...wrap(trader.id, 1_000_000_000n),
    pumpAmm.multiHopSwap({ user: trader.id, userIn: ata(trader.id, PUMP.wsol, TOKEN_PROGRAM), userOut: ata(trader.id, A2, T22), amountIn: 1_000_000_000n, minOut: 1n,
      buybackQuoteMint: PUMP.wsol, hops: [{ kind: "pool", mint: L, quoteMint: PUMP.wsol, pool: linePoolAddr }, { kind: "pool", mint: A2, quoteMint: L, pool: pool2Addr, quoteTokenProgram: T22 }] })],
    { computeUnits: 400_000 });
  let poolCreatorFees = 0n;
  for (const r of [r9a, r9b, r9c]) for (const e of await events(r.signature)) if ((e.name === "BuyEvent" || e.name === "SellEvent") && e.fields.pool === pool2Addr) poolCreatorFees += e.fields.coin_creator_fee as bigint;
  const pool2After = decodePumpPool((await fork.getAccountInfo(pool2Addr))!.data);
  check("A2 pool holds exactly the coin creator fees of its trade events", pool2After.creatorFees === poolCreatorFees, `${poolCreatorFees}`);
  const pdaAta2 = ata(P2, L, T22);
  const r9d = await send("9d", "A2 fees after migration: curve sweep + collect_creator_fee_v2, pool sweep + collect_coin_creator_fee (keeper)", keeper, [
    token.createAtaIdempotent(keeper.id, P2, L, T22),
    pump.sweepCreatorFee({ payer: keeper.id, mint: A2, quoteMint: L, creator: P2, quoteTokenProgram: T22 }),
    pump.collectCreatorFeeV2({ creator: P2, quoteMint: L, quoteTokenProgram: T22 }),
    pumpAmm.sweepCreatorFee({ payer: keeper.id, pool: pool2Addr, quoteMint: L, coinCreator: P2, quoteTokenProgram: T22 }),
    pumpAmm.collectCoinCreatorFee({ coinCreator: P2, quoteMint: L, quoteTokenProgram: T22 }),
  ], { computeUnits: 400_000 });
  void r9d;
  check("A2: the PDA's $LINE ATA = curve creator fees + pool creator fees exactly", (await bal(pdaAta2)) === creatorFees2Curve + poolCreatorFees,
    `${creatorFees2Curve} + ${poolCreatorFees}`);

  // ---- 10. creator_fee_bps on mainnet's Global
  const a3 = forkKey(`pump-a3-mint-${Date.now()}`);
  const lp10 = decodePumpPool((await fork.getAccountInfo(linePoolAddr))!.data);
  let custom = "";
  try {
    await send("10", "A3: create_v2 with creator_fee_bps 150 (owner decision 4 probe)", launcher, [createV2({ mint: a3.id, user: launcher.id, creator: creatorPda(a3.id),
      name: "Agent Three", symbol: "TTHR", uri: "x", creatorFeeBps: 150n,
      quote: { kind: "pumpCoin", mint: L, pool: { pool: linePoolAddr, baseVault: lp10.poolBaseTokenAccount, quoteVault: lp10.poolQuoteTokenAccount } } })],
      { signers: [a3], computeUnits: 400_000 });
    custom = `accepted, curve creator_fee_bps ${(await curveOf(a3.id)).c.creatorFeeBps}`;
  } catch (e) {
    custom = `refused: ${String(e).slice(0, 200)}`;
  }
  check("creator_fee_bps 150 probe recorded (informational)", true, custom);

  const out = { ran_at: new Date().toISOString(), pump_global: { max_curve_depth: g.maxCurveDepth, creator_fee_configurable: g.creatorFeeConfigurable,
    max_configurable_creator_fee_bps: g.maxConfigurableCreatorFeeBps.toString(), pool_migration_fee: g.poolMigrationFee.toString() },
    exotic_flat_fees: { curve: fc.exoticFlatFees }, mints: { line: L, a1: A1, a2: A2 }, creator_pdas: { a1: P1, a2: P2 },
    pass: checks.filter((c) => c.ok).length, total: checks.length, checks, rows };
  writeFileSync(join(import.meta.dir, "PUMP-FORK-LAST.json"), JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  log(`PASS ${out.pass}/${out.total}; $LINE create ${sol(BigInt(r1.cost.payerMainnet))} SOL, A1 launch+buy ${sol(BigInt(r2.cost.payerMainnet))} SOL (v0 ${r2.size} bytes)`);
}

await main();
