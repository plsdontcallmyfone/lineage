#!/usr/bin/env bun
// pump.fun on devnet (owner decision 2026-10-10: devnet moves to pump.fun): creates the new devnet tLINE
// as a pump.fun coin paired with SOL (never mayhem) with the devnet deployer, buys tLINE on its own
// curve for the devnet treasury, then proves devnet's Pump build (which differs from mainnet's,
// docs/plans/PUMPFUN-LAUNCHES.md 4.5) with an agent-shaped coin quoted in tLINE: creator = a
// units_launch "pump_creator" PDA, curve trades, multi_hop_swap from SOL, and the permissionless
// sweep + collect landing exactly the trade events' creator fees in the PDA's tLINE account. It does
// not call units_launch (devnet's registry and launch config are bound to the earlier tLINE). Idempotent:
// the tLINE mint and treasury holding are reused when they exist. Writes scripts/devnet/PUMP-DEVNET-LAST.json
// and the `pump_tline` block of scripts/devnet/devnet.json.
//
//   bun scripts/devnet/pump-devnet-proof.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { base58Decode } from "@lineage/protocol";
import {
  addressBytes,
  ata,
  createV2,
  decodeBondingCurve,
  decodeMint,
  decodePumpEvent,
  decodePumpFeeConfig,
  decodePumpGlobal,
  decodeTokenAccount,
  pda,
  PROGRAM_IDS,
  pump,
  PUMP,
  pumpAmm,
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
import { assertDevnet } from "../../packages/chain/src/browser/client.ts";
import { deployer, key, log, rpc, sol, STATE_PATH } from "./lib.ts";
import { sendTx } from "./pump-lib.ts";

const T22 = TOKEN_2022_PROGRAM;
const checks: { name: string; ok: boolean; detail: string }[] = [];
const txs: { step: string; signature: string; fee: number | null; cu: number | null; payer_delta_lamports: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`[devnet] ${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) throw new Error(`check failed: ${name}`);
}
async function send(step: string, payer: Signer, ixs: Ix[], o: { signers?: Signer[]; computeUnits?: number } = {}) {
  const b0 = await rpc.getBalance(payer.id);
  const r = await sendTx(rpc, payer, ixs, o);
  const d = b0 - (await rpc.getBalance(payer.id));
  txs.push({ step, signature: r.signature, fee: r.fee, cu: r.computeUnits, payer_delta_lamports: d.toString() });
  log(`${step}: ${r.signature} (${sol(d)} SOL, ${r.computeUnits} CU)`);
  return r;
}
async function events(sig: string): Promise<PumpEvent[]> {
  const t = await rpc.call<{ meta: { innerInstructions: { instructions: { data: string }[] }[] } }>("getTransaction",
    [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
  return (t.meta.innerInstructions ?? []).flatMap((g) => g.instructions.map((i) => decodePumpEvent(base58Decode(i.data)))).filter((e): e is PumpEvent => e !== null);
}
const bal = async (a: string) => {
  const i = await rpc.getAccountInfo(a);
  return i ? decodeTokenAccount(i.data).amount : 0n;
};

await assertDevnet(rpc);
const dep = deployer();
const state = JSON.parse(readFileSync(STATE_PATH, "utf8"));
const g = decodePumpGlobal((await rpc.getAccountInfo(PUMP.global))!.data);
const fc = decodePumpFeeConfig((await rpc.getAccountInfo(PUMP.feeConfig))!.data);
check("devnet Pump Global: create_v2 enabled, max_curve_depth >= 1", g.createV2Enabled && g.maxCurveDepth >= 1,
  `max_curve_depth ${g.maxCurveDepth}, creator_fee_configurable ${g.creatorFeeConfigurable}, total supply ${g.tokenTotalSupply}`);

// ---- 1. devnet tLINE: a pump.fun coin paired with SOL, never mayhem
const lineKey = key("tline-pump-mint");
const L = lineKey.id;
if (!(await rpc.getAccountInfo(L)))
  await send("1: create devnet tLINE (create_v2, paired with SOL, not mayhem; deployer is user and creator)", dep, [
    createV2({ mint: L, user: dep.id, creator: dep.id, name: "Lineage devnet TEST LINE", symbol: "tLINE", uri: "https://lineage.invalid/devnet/tline.json", quote: { kind: "sol" } }),
  ], { signers: [lineKey], computeUnits: 400_000 });
const lc0 = decodeBondingCurve((await rpc.getAccountInfo(pumpPdas.bondingCurve(L)))!.data);
const m = decodeMint((await rpc.getAccountInfo(L))!.data);
check("tLINE: pump.fun coin quoted in SOL (zero key), depth 0, not mayhem; Token-2022, no mint or freeze authority",
  lc0.quoteMint === "11111111111111111111111111111111" && lc0.depth === 0 && !lc0.isMayhemMode && m.mintAuthority === null && m.freezeAuthority === null
  && (await rpc.getAccountInfo(L))!.owner === T22, `mint ${L}, supply ${m.supply}`);

// ---- 2. the devnet treasury buys tLINE on its own curve (the faucet's source once devnet runs on it).
// Devnet's Pump build (not mainnet's) refused the first coin quoted in a fresh tLINE with
// QuoteReservesOutOfRange, logging "Left: 1000000000000000 Right: 2872724285989114" (2026-10-10): our
// reading is that it compares the derived graduation raise with tLINE's supply (mainnet's docs say the
// raise is priced through the curve and has no supply bound). With 460,000,000 tLINE bought on its
// curve the same create_v2 was accepted.
const treasury = key("tline-pump-treasury");
const WANT = 460_000_000n * 10n ** 6n;
const tAta = ata(treasury.id, L, T22);
if ((await bal(tAta)) < WANT) {
  const c = decodeBondingCurve((await rpc.getAccountInfo(pumpPdas.bondingCurve(L)))!.data);
  const need = WANT - (await bal(tAta));
  const q = quoteCurveBuyExactOut(g, fc, c, need, await bal(ata(pumpPdas.bondingCurve(L), L, T22)));
  if ((await rpc.getBalance(dep.id)) - q.quoteIn < 25n * 10n ** 9n) throw new Error(`the buy costs ${sol(q.quoteIn)} SOL and would leave the deployer under 25 SOL`);
  await send(`2: the devnet treasury ${treasury.id} buys ${need / 10n ** 6n} tLINE on its curve with ${sol(q.quoteIn)} devnet SOL (buy_v3; the deployer pays)`, dep, [
    token.createAtaIdempotent(dep.id, treasury.id, L, T22),
    pump.buyV3({ mint: L, quoteMint: PUMP.wsol, user: dep.id, userBase: tAta, amount: need, maxQuoteIn: (q.quoteIn * 101n) / 100n }),
  ], { computeUnits: 300_000 });
}
check("devnet treasury holds the tLINE it bought", (await bal(tAta)) >= WANT, `${await bal(tAta)}`);

// ---- 3. an agent-shaped coin quoted in tLINE, creator = a units_launch pump_creator PDA (devnet launch id)
const agent = key(`pump-proof-agent-${Date.now()}`);
const P = pda(PROGRAM_IDS.devnet.launch, "pump_creator", addressBytes(agent.id));
const coin = key(`pump-proof-coin-${Date.now()}`);
const C = coin.id;
await send("3: buyback recipient 0's tLINE account (anyone may create it) and the deployer's tLINE account", dep, [
  token.createAtaIdempotent(dep.id, PUMP.buybackRecipients[0], L, T22), token.createAtaIdempotent(dep.id, dep.id, L, T22)]);
await send("3: create an agent-shaped coin quoted in tLINE (create_v2, pump-coin quote, creator = PDA)", dep, [
  createV2({ mint: C, user: dep.id, creator: P, name: "TEST pump proof", symbol: "TPUMP", uri: "https://lineage.invalid/devnet/tpump.json", quote: { kind: "pumpCoin", mint: L } }),
], { signers: [coin], computeUnits: 400_000 });
const cc = decodeBondingCurve((await rpc.getAccountInfo(pumpPdas.bondingCurve(C)))!.data);
check("coin: quoted in tLINE, creator = the PDA, depth 1, not mayhem, creator_fee_bps 0", cc.quoteMint === L && cc.creator === P && cc.depth === 1 && !cc.isMayhemMode
  && cc.creatorFeeBps === 0n, `virtual quote ${cc.virtualQuoteReserves}`);

// ---- 4. trades: tLINE in, a sell, SOL straight in through multi_hop_swap
const depLine = (await bal(ata(dep.id, L, T22)));
if (depLine < 2_000_000n * 10n ** 6n) {
  const c = decodeBondingCurve((await rpc.getAccountInfo(pumpPdas.bondingCurve(L)))!.data);
  const amt = 2_000_000n * 10n ** 6n;
  const q = quoteCurveBuyExactOut(g, fc, c, amt, await bal(ata(pumpPdas.bondingCurve(L), L, T22)));
  await send("4: the deployer buys 2,000,000 tLINE to trade with", dep, [pump.buyV3({ mint: L, quoteMint: PUMP.wsol, user: dep.id, amount: amt, maxQuoteIn: (q.quoteIn * 101n) / 100n })],
    { computeUnits: 300_000 });
}
const t = { mint: C, quoteMint: L, quoteTokenProgram: T22, user: dep.id };
const a = await send("4: buy_exact_quote_in_v3 (500,000 tLINE)", dep, [token.createAtaIdempotent(dep.id, dep.id, C, T22),
  pump.buyExactQuoteInV3({ ...t, spendableQuoteIn: 500_000n * 10n ** 6n, minTokensOut: 1n })], { computeUnits: 300_000 });
const held = await bal(ata(dep.id, C, T22));
const b = await send("4: sell_v3 (half)", dep, [pump.sellV3({ ...t, amount: held / 2n, minQuoteOut: 1n })], { computeUnits: 300_000 });
const h = await send("4: multi_hop_swap SOL -> tLINE curve -> coin curve (0.05 SOL)", dep, [token.createAtaIdempotent(dep.id, dep.id, PUMP.wsol, TOKEN_PROGRAM),
  token.createAtaIdempotent(dep.id, PUMP.buybackRecipients[0], PUMP.wsol, TOKEN_PROGRAM),
  pumpAmm.multiHopSwap({ user: dep.id, userIn: ata(dep.id, PUMP.wsol, TOKEN_PROGRAM), userOut: ata(dep.id, C, T22), amountIn: 50_000_000n, minOut: 1n, buybackQuoteMint: PUMP.wsol,
    hops: [{ kind: "curve", mint: L, quoteMint: PUMP.wsol }, { kind: "curve", mint: C, quoteMint: L, quoteTokenProgram: T22 }] })], { computeUnits: 400_000 });
let fees = 0n;
for (const r of [a, b, h]) for (const e of await events(r.signature)) if (e.name === "TradeEvent" && e.fields.mint === C) fees += e.fields.creator_fee as bigint;
const waiting = decodeBondingCurve((await rpc.getAccountInfo(pumpPdas.bondingCurve(C)))!.data).creatorFee;
check("the curve holds exactly the creator fees of its trade events", waiting === fees && fees > 0n, `${fees} tLINE base units`);

// ---- 5. permissionless sweep + collect to the PDA's tLINE account
const k = key("pump-proof-keeper");
if ((await rpc.getBalance(k.id)) < 20_000_000n) await send("5: fund a keeper key (0.03 devnet SOL)", dep, [system.transfer(dep.id, k.id, 30_000_000n)]);
await send("5: keeper: create the PDA's tLINE account, sweep_creator_fee, collect_creator_fee_v2", k, [token.createAtaIdempotent(k.id, P, L, T22),
  pump.sweepCreatorFee({ payer: k.id, mint: C, quoteMint: L, creator: P, quoteTokenProgram: T22 }), pump.collectCreatorFeeV2({ creator: P, quoteMint: L, quoteTokenProgram: T22 })],
  { computeUnits: 300_000 });
check("the PDA's tLINE account holds exactly the swept creator fees (no creator signature)", (await bal(ata(P, L, T22))) === fees, `${fees}`);

const out = { ran_at: new Date().toISOString(), cluster: "devnet", tline: { mint: L, curve: pumpPdas.bondingCurve(L), treasury: treasury.id, treasury_account: tAta },
  pump_global: { max_curve_depth: g.maxCurveDepth, creator_fee_configurable: g.creatorFeeConfigurable, token_total_supply: g.tokenTotalSupply.toString() },
  proof_coin: { mint: C, creator_pda: P, agent: agent.id }, pass: checks.length, checks, txs };
writeFileSync(join(import.meta.dir, "PUMP-DEVNET-LAST.json"), JSON.stringify(out, null, 2) + "\n");
state.pump_tline = { mint: L, token_program: T22, decimals: 6, curve: pumpPdas.bondingCurve(L), treasury: treasury.id, treasury_account: tAta,
  note: "devnet tLINE as a pump.fun coin (owner decision 2026-10-10); not yet the registry's or launch config's mint: that needs the devnet program decision" };
writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
log(`PASS ${checks.length}/${checks.length}`);
