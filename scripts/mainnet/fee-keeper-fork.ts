#!/usr/bin/env bun
// The $UNITS fee keeper (packages/fee-keeper) end to end on a local fork of mainnet: mainnet's own
// Pump, PumpSwap and Pump Fees builds with mainnet's Global and fee configs (scripts/mainnet/fork.sh).
// Nothing is sent to mainnet; every key is a throwaway in MAINNET_FORK_KEYS, every lamport an airdrop.
//
//   1  a throwaway SOL-paired pump.fun coin (create_v2), created by the wallet the keeper signs with;
//      a trader buys and sells so creator fees wait in the curve
//   2  refusals and the dry run: a config naming another creator, another key, a compute address that
//      is a program; the dry run (the CLI) prints its plan and changes nothing
//   3  the keeper with --send: collect (sweep_creator_fee + collect_creator_fee), the compute share
//      to the compute address, a buy on the curve burned in the same transaction; the buyback is
//      capped per transaction, so the next runs finish it; then a run that sends nothing
//   4  interruptions on real transactions: the process dies after the transaction was recorded and
//      before it was sent, and after it was sent and before its result was booked; the next run
//      settles it and nothing is sent twice
//   5  graduation: the curve completes, migrate_v2; pool trades; the keeper collects what the curve
//      still held and the pool's fee (wrapped SOL, unwrapped in the same transaction) and buys on the
//      PumpSwap pool, burned in the same transaction
// Writes scripts/mainnet/FEE-KEEPER-FORK-LAST.json and packages/fee-keeper/test/fixtures/fork.json
// (the snapshots the keeper read and the transactions mainnet's programs accepted).
//
//   MAINNET_FORK_KEYS=<throwaway key dir> bun scripts/mainnet/fee-keeper-fork.ts
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey } from "@units/protocol";
import {
  ata, createV2, decodeBondingCurve, decodeMint, decodePumpFeeConfig, decodePumpGlobal, decodePumpPool, decodeTokenAccount, PUMP, pump, pumpAmm, pumpPdas,
  quoteCurveBuyExactOut, system, token, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, type Ix, type Signer,
} from "@units/chain";
import {
  parseConfig, readLog, RpcChain, runKeeper, loadState, type Action, type Chain, type KeeperConfig, type RunReport, type Snapshot,
} from "../../packages/fee-keeper/src/index.ts";
import { airdrop, assertFork, check, checks, fork, forkKey, FORK_URL, KEYS, log, send, sol } from "./lib.ts";

const T22 = TOKEN_2022_PROGRAM;
const json = (o: unknown) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? `${v}n` : v), 2);
const bal = async (a: string) => { const i = await fork.getAccountInfo(a); return i ? decodeTokenAccount(i.data).amount : 0n; };
const curveOf = async (m: string) => decodeBondingCurve((await fork.getAccountInfo(pumpPdas.bondingCurve(m)))!.data);
const supplyOf = async (m: string) => decodeMint((await fork.getAccountInfo(m))!.data).supply;
const wrap = (owner: string, lamports: bigint): Ix[] => [
  token.createAtaIdempotent(owner, owner, PUMP.wsol, TOKEN_PROGRAM), system.transfer(owner, ata(owner, PUMP.wsol, TOKEN_PROGRAM), lamports),
  { programId: TOKEN_PROGRAM, keys: [{ pubkey: ata(owner, PUMP.wsol, TOKEN_PROGRAM), isSigner: false, isWritable: true }], data: Uint8Array.of(17) },
];

/** Records what the keeper read and signed, for the unit tests' fixture. */
class Recording implements Chain {
  readonly seen: { action: Action; snapshot: Snapshot; signature: string; cuLimit: number; price: number }[] = [];
  constructor(readonly inner: Chain) {}
  read = () => this.inner.read();
  price = (a: Action, s: Snapshot) => this.inner.price(a, s);
  simulate = (a: Action, s: Snapshot) => this.inner.simulate(a, s);
  fits = (a: Action, s: Snapshot) => this.inner.fits(a, s);
  async sign(a: Action, s: Snapshot, cuLimit: number, price: number) {
    const p = await this.inner.sign(a, s, cuLimit, price);
    this.seen.push({ action: a, snapshot: s, signature: p.signature, cuLimit, price });
    return p;
  }
  submit = (w: Uint8Array) => this.inner.submit(w);
  status = (sig: string) => this.inner.status(sig);
  blockHeight = () => this.inner.blockHeight();
  outcome = (sig: string) => this.inner.outcome(sig);
}
/** The process dies at a chosen point of the next send. */
class Dying extends Recording {
  at: "before-submit" | "after-submit" | null = null;
  override submit = async (w: Uint8Array) => {
    if (this.at === "before-submit") { this.at = null; throw new Error("killed before the transaction was sent"); }
    await this.inner.submit(w);
    if (this.at === "after-submit") { this.at = null; throw new Error("killed after the transaction was sent"); }
  };
}

async function main() {
  await assertFork();
  const dir = mkdtempSync(join(tmpdir(), "units-fee-keeper-fork-"));
  const g = decodePumpGlobal((await fork.getAccountInfo(PUMP.global))!.data);
  const fc = decodePumpFeeConfig((await fork.getAccountInfo(PUMP.feeConfig))!.data);
  const tag = Date.now();
  const creator = forkKey(`fk-creator-${tag}`), trader = forkKey(`fk-trader-${tag}`), mintKey = forkKey(`fk-mint-${tag}`), other = forkKey(`fk-other-${tag}`);
  const computeAddr = generateAgentKey().id; // only its address is used: nothing ever signs for it here
  const M = mintKey.id;
  const OWN = 2_000_000_000n; // the creator wallet's own SOL, which the keeper must never spend
  await airdrop(creator.id, OWN);
  await airdrop(trader.id, 2_000_000_000_000n);
  await airdrop(other.id, 1_000_000_000n);

  // ---- 1. the coin and its first fees
  await send("1", "throwaway coin: create_v2 SOL-paired, creator = the keeper's wallet", creator,
    [createV2({ mint: M, user: creator.id, creator: creator.id, name: "Fee Keeper Fork", symbol: "FKF", uri: "https://example.invalid/fkf.json", quote: { kind: "sol" } })],
    { signers: [mintKey], computeUnits: 400_000 });
  const buy = async (amount: bigint, step: string) => {
    const cur = await curveOf(M);
    const q = quoteCurveBuyExactOut(g, fc, cur, amount, await bal(ata(pumpPdas.bondingCurve(M), M, T22)));
    return send(step, `trader buys ${amount} base units (buy_v3)`, trader, [token.createAtaIdempotent(trader.id, trader.id, M, T22),
      pump.buyV3({ mint: M, quoteMint: PUMP.wsol, user: trader.id, amount, maxQuoteIn: (q.quoteIn * 101n) / 100n })], { computeUnits: 300_000 });
  };
  const sell = (amount: bigint, step: string) => send(step, `trader sells ${amount} base units (sell_v3)`, trader,
    [pump.sellV3({ mint: M, quoteMint: PUMP.wsol, user: trader.id, amount, minQuoteOut: 1n })], { computeUnits: 300_000 });
  await buy(200_000_000_000_000n, "1b");
  await sell(60_000_000_000_000n, "1c");
  const waiting1 = (await curveOf(M)).creatorFee;
  check("1: creator fees wait in the bonding curve; the creator vault does not exist yet", waiting1 > 0n && (await fork.getBalance(pumpPdas.creatorVault(creator.id))) === 0n, `${waiting1} lamports`);

  const raw = {
    enabled: false, rpc_url: FORK_URL, mint: M, creator: creator.id, key_path: join(KEYS, `fk-creator-${tag}.json`), compute_address: computeAddr, compute_bps: 5000, burn_bps: 5000,
    fee_reserve_lamports: "10000000", min_collect_lamports: "5000000", min_buyback_lamports: "1000000", max_buyback_lamports: "3000000", slippage_bps: 100,
    priority_fee: { percentile: 75, floor_micro_lamports: 1, cap_micro_lamports: 50000 }, confirm_timeout_s: 60, state_path: join(dir, "state.json"), log_path: join(dir, "runs.jsonl"),
  };
  const cfg: KeeperConfig = parseConfig(raw);
  writeFileSync(join(dir, "config.json"), JSON.stringify(raw, null, 2));
  const chain = new Dying(new RpcChain(fork, cfg, creator));
  const run = (c: KeeperConfig = cfg, ch: Chain = chain, signer: Signer | null = creator) => runKeeper(c, ch, { send: true, signer: signer?.id ?? null, pollMs: 400 });
  const ownBefore = await fork.getBalance(creator.id);

  // ---- 2. refusals and the dry run
  const wrongCreator = parseConfig({ ...raw, creator: other.id, state_path: join(dir, "x-state.json"), log_path: join(dir, "x-runs.jsonl") });
  const r2a = await runKeeper(wrongCreator, new RpcChain(fork, wrongCreator, other), { send: true, signer: other.id });
  check("2: a config naming another creator is refused", r2a.refused.some((x) => x.includes("not config.creator")) && r2a.steps.length === 0, r2a.refused[0] ?? "");
  const r2b = await runKeeper(cfg, new RpcChain(fork, cfg, other), { send: true, signer: other.id });
  check("2: a key that is not the creator's is refused", r2b.refused.some((x) => x.includes("key at config.key_path")) && r2b.steps.length === 0, r2b.refused[0] ?? "");
  const toProgram = parseConfig({ ...raw, compute_address: PUMP.program });
  const r2c = await runKeeper(toProgram, new RpcChain(fork, toProgram, creator), { send: true, signer: creator.id });
  check("2: a compute address that is a program is refused", r2c.refused.some((x) => x.includes("is a program")), r2c.refused[0] ?? "");
  const noCoin = parseConfig({ ...raw, mint: other.id });
  let noCoinErr = "";
  try { await runKeeper(noCoin, new RpcChain(fork, noCoin, creator), { send: true, signer: creator.id }); } catch (e) { noCoinErr = String(e); }
  check("2: a mint that is not a pump.fun coin is refused", /no pump\.fun bonding curve|does not exist/.test(noCoinErr), noCoinErr.slice(0, 120));
  const cli = Bun.spawnSync(["bun", join(import.meta.dir, "../../packages/fee-keeper/src/main.ts"), "--config", join(dir, "config.json"), "--json"], { stdout: "pipe", stderr: "pipe" });
  const dry = JSON.parse(cli.stdout.toString()) as RunReport;
  const dryCollect = dry.steps.find((s) => s.step === "collect"), dryCompute = dry.steps.find((s) => s.step === "compute"), dryBuy = dry.steps.find((s) => s.step === "buyback");
  check("2: the dry run (CLI, no --send) plans collect, compute and buyback, each simulated", cli.exitCode === 0 && dry.mode === "dry-run" && dryCollect?.result === "would" && dryCompute?.result === "would"
    && dryBuy?.result === "would" && !!dryCollect.simulation?.ok && !!dryBuy.simulation?.ok,
    `collect ${dryCollect?.amounts?.predicted_net_lamports} net, compute ${dryCompute?.amounts?.compute_lamports}, buyback budget ${dryBuy?.amounts?.budget_lamports}`);
  check("2: the dry run sent nothing and wrote nothing", (await fork.getBalance(creator.id)) === ownBefore && !existsSync(cfg.state_path) && !existsSync(cfg.log_path)
    && (await curveOf(M)).creatorFee === waiting1 && (await fork.getBalance(computeAddr)) === 0n);

  // ---- 3. the keeper sends
  const measured: Record<string, { size: number; compute_units: string; fee_lamports: string }> = {};
  const note = (name: string, rep: RunReport, step: string) => {
    const s = rep.steps.find((x) => x.step === step && x.result === "sent");
    const rec = chain.seen.find((x) => x.signature === s?.signature);
    if (s && rec) measured[name] = { size: 0, compute_units: s.amounts!.compute_units!, fee_lamports: s.amounts!.fee_lamports! };
    return s;
  };
  const supply0 = await supplyOf(M);
  const rep1 = await run();
  const rec1 = rep1.record!;
  const st1 = loadState(cfg.state_path, M, creator.id);
  const B = (s: string) => BigInt(s);
  check("3: run 1 collected exactly what waited in the curve", B(rec1.collected_lamports) === waiting1 && !!rec1.collect_signature, `${rec1.collected_lamports} lamports`);
  const rent0 = await fork.getMinimumBalanceForRentExemption(0);
  const net1 = B(rec1.collected_lamports) - B(rec1.collect_cost_lamports);
  check("3: the collection's cost is its fee plus the creator vault's rent-exempt minimum (first sweep only)", B(rec1.collect_cost_lamports) === rent0 + BigInt(note("collect on the curve (first: tops up the vault)", rep1, "collect")!.amounts!.fee_lamports!),
    `${rec1.collect_cost_lamports} lamports, of which ${rent0} vault rent`);
  check("3: collected = collection cost + reserve + compute share + buyback share", B(rec1.collected_lamports) === B(rec1.collect_cost_lamports) + B(rec1.reserve_lamports) + B(rec1.compute_share_lamports) + B(rec1.burn_share_lamports),
    `${rec1.collected_lamports} = ${rec1.collect_cost_lamports} + ${rec1.reserve_lamports} + ${rec1.compute_share_lamports} + ${rec1.burn_share_lamports}`);
  check("3: the two shares are equal (5000 / 5000) and the reserve was filled to its level first", rec1.compute_share_lamports === rec1.burn_share_lamports
    && B(rec1.reserve_lamports) - (net1 - 10_000_000n) % 2n === 10_000_000n, `each ${rec1.compute_share_lamports} lamports of net ${net1}`);
  check("3: the compute address received exactly its share", (await fork.getBalance(computeAddr)) === B(rec1.compute_share_lamports) && rec1.compute_lamports === rec1.compute_share_lamports, `${rec1.compute_lamports} lamports`);
  note("compute transfer", rep1, "compute");
  note("buy on the curve + burn (first: creates the token account and the volume account)", rep1, "buyback");
  const supply1 = await supplyOf(M);
  check("3: the supply fell by exactly the amount bought, burned in the buy's own transaction", supply0 - supply1 === B(rec1.units_bought) && rec1.units_bought === rec1.units_burned
    && B(rec1.units_bought) > 0n && rec1.burn_signature === rec1.buyback_signature && (await bal(ata(creator.id, M, T22))) === 0n, `${rec1.units_bought} base units`);
  check("3: the buy spent at most the per-transaction cap and within the slippage cap of its quote", B(rec1.buyback_lamports) <= 3_000_000n && B(rec1.buyback_lamports) >= (3_000_000n * 10_000n) / 10_100n - 2n,
    `${rec1.buyback_lamports} of a 3000000 budget`);
  const ledger = (s: typeof st1) => s.compute_owed + s.buyback_owed + s.reserve;
  check("3: the wallet holds its own SOL plus exactly what the ledger says (owed + reserve): none of its own was spent", (await fork.getBalance(creator.id)) === ownBefore + ledger(st1),
    `own ${ownBefore}, buyback owed ${st1.buyback_owed}, reserve ${st1.reserve}`);
  check("3: overhead (fees, the token account and volume account rent) came out of the reserve", st1.reserve === B(rec1.reserve_lamports) - B(rec1.overhead_lamports), `overhead ${rec1.overhead_lamports} lamports`);

  let runs = 1, lastBuy = rep1;
  for (; runs < 12; runs++) {
    const before = { supply: await supplyOf(M), owed: loadState(cfg.state_path, M, creator.id).buyback_owed };
    const rep = await run();
    if (!rep.record) break;
    lastBuy = rep;
    const rec = rep.record;
    const st = loadState(cfg.state_path, M, creator.id);
    if (!(rec.collect_signature === null && rec.compute_signature === null && before.supply - (await supplyOf(M)) === B(rec.units_bought) && rec.units_bought === rec.units_burned
      && before.owed - st.buyback_owed === B(rec.buyback_lamports) && B(rec.buyback_lamports) <= 3_000_000n && (await fork.getBalance(creator.id)) === ownBefore + ledger(st)))
      check(`3: run ${runs + 1} only continued the buyback`, false, json(rec));
  }
  note("buy on the curve + burn", lastBuy, "buyback");
  const stEnd = loadState(cfg.state_path, M, creator.id);
  const log1 = readLog(cfg.log_path);
  const spent = log1.reduce((s, r) => s + B(r.buyback_lamports), 0n), burned = log1.reduce((s, r) => s + B(r.units_burned), 0n);
  check("3: the buyback share was spent over several capped runs; what is left is under the minimum", log1.length === runs && runs >= 3 && stEnd.buyback_owed < 1_000_000n
    && spent + stEnd.buyback_owed === B(rec1.burn_share_lamports), `${runs} runs, ${spent} lamports spent, ${stEnd.buyback_owed} carried`);
  check("3: total supply burned = the sum of the log", supply0 - (await supplyOf(M)) === burned, `${burned} base units`);
  const idleBefore = { wallet: await fork.getBalance(creator.id), compute: await fork.getBalance(computeAddr), supply: await supplyOf(M), state: readFileSync(cfg.state_path, "utf8") };
  const idle = await run();
  check("3: a run with nothing new sends nothing", idle.record === null && idle.steps.every((s) => s.result === "skipped") && (await fork.getBalance(creator.id)) === idleBefore.wallet
    && (await fork.getBalance(computeAddr)) === idleBefore.compute && (await supplyOf(M)) === idleBefore.supply && readLog(cfg.log_path).length === runs
    && readFileSync(cfg.state_path, "utf8") === idleBefore.state, idle.steps.map((s) => `${s.step}: ${s.detail}`).join(" | ").slice(0, 300));

  // ---- 4. interruptions on real transactions
  await buy(150_000_000_000_000n, "4a");
  const waiting4 = (await curveOf(M)).creatorFee;
  const c4 = await fork.getBalance(computeAddr);
  chain.at = "after-submit"; // dies after the collect was sent
  let died = "";
  try { await run(); } catch (e) { died = String(e); }
  const stMid = loadState(cfg.state_path, M, creator.id);
  check("4: killed after the collect was sent: the transaction is recorded, nothing booked yet", /killed after/.test(died) && stMid.pending?.action.kind === "collect" && stMid.compute_owed === 0n);
  chain.at = "before-submit"; // the resumed run settles the collect, then dies with the compute transfer recorded and not sent
  died = "";
  try { await run(); } catch (e) { died = String(e); }
  const stMid2 = loadState(cfg.state_path, M, creator.id);
  check("4: the next run booked the collect once, then was killed with the compute transfer recorded and unsent", /killed before/.test(died) && stMid2.pending?.action.kind === "compute"
    && stMid2.compute_owed > 0n && (await fork.getBalance(computeAddr)) === c4 && (await curveOf(M)).creatorFee < waiting4, `compute owed ${stMid2.compute_owed}`);
  const sigCompute = stMid2.pending!.signature;
  const rep4 = await run();
  const rec4 = rep4.record!;
  check("4: the run after that sent the recorded transfer (same signature) and finished the run: one log line", rec4.compute_signature === sigCompute && B(rec4.collected_lamports) === waiting4
    && readLog(cfg.log_path).filter((r) => r.run_id === rec4.run_id).length === 1, `collected ${rec4.collected_lamports}`);
  check("4: the compute address received this collection's share exactly once", (await fork.getBalance(computeAddr)) - c4 === B(rec4.compute_share_lamports) && rec4.compute_lamports === rec4.compute_share_lamports
    && rec4.compute_share_lamports === rec4.burn_share_lamports, `${rec4.compute_lamports} lamports`);
  note("collect on the curve", rep4, "collect");
  const st4 = loadState(cfg.state_path, M, creator.id);
  check("4: after the interruptions the wallet still holds its own SOL plus exactly the ledger", (await fork.getBalance(creator.id)) === ownBefore + ledger(st4) && st4.pending === null && st4.run === null);
  for (let i = 0; i < 12 && (await run()).record; i++);

  // ---- 5. graduation
  const cur = await curveOf(M);
  const past = 10_000_000_000_000n;
  const q5 = quoteCurveBuyExactOut(g, fc, cur, cur.realTokenReserves + past, await bal(ata(pumpPdas.bondingCurve(M), M, T22)));
  await send("5a", "trader completes the curve (synthetic migration buy)", trader, [pump.buyV3({ mint: M, quoteMint: PUMP.wsol, user: trader.id, amount: cur.realTokenReserves + past, maxQuoteIn: (q5.quoteIn * 101n) / 100n })], { computeUnits: 400_000 });
  const await5 = await runKeeper(cfg, chain, { send: false });
  check("5: while the curve awaits migration the keeper plans the collect and holds the buyback", await5.phase === "awaiting_migration" && await5.steps.find((s) => s.step === "collect")?.result === "would"
    && /not migrated yet/.test(await5.steps.find((s) => s.step === "buyback")?.detail ?? ""));
  await send("5b", "migrate_v2 to PumpSwap", trader, [pump.migrateV2({ user: trader.id, mint: M, quoteMint: PUMP.wsol, withdrawAuthority: g.withdrawAuthority })], { computeUnits: 600_000 });
  const poolAddr = pumpPdas.pool(M, PUMP.wsol);
  await send("5c", "trader buys on the pool (buy_exact_quote_in_v2, 5 SOL)", trader, [...wrap(trader.id, 5_000_000_000n), token.createAtaIdempotent(trader.id, PUMP.buybackRecipients[0], PUMP.wsol, TOKEN_PROGRAM),
    pumpAmm.buyExactQuoteInV2({ pool: poolAddr, mint: M, quoteMint: PUMP.wsol, user: trader.id, spendableQuoteIn: 5_000_000_000n, minBaseOut: 1n })], { computeUnits: 300_000 });
  await send("5d", "trader sells on the pool (sell_v2)", trader, [pumpAmm.sellV2({ pool: poolAddr, mint: M, quoteMint: PUMP.wsol, user: trader.id, baseIn: 1_000_000_000_000n, minQuoteOut: 1n })], { computeUnits: 300_000 });
  const left = (await curveOf(M)).creatorFee, inPool = decodePumpPool((await fork.getAccountInfo(poolAddr))!.data).creatorFees;
  check("5: after graduation fees wait in two places: what the curve still held, and the pool (wrapped SOL)", left > 0n && inPool > 0n, `curve ${left}, pool ${inPool} lamports`);
  const wsolAta = ata(creator.id, PUMP.wsol, TOKEN_PROGRAM);
  const before5 = { st: loadState(cfg.state_path, M, creator.id), compute: await fork.getBalance(computeAddr), supply: await supplyOf(M) };
  const big = parseConfig({ ...raw, max_buyback_lamports: "60000000" });
  const chain5 = new Dying(new RpcChain(fork, big, creator));
  const rep5 = await run(big, chain5);
  const rec5 = rep5.record!;
  const st5 = loadState(cfg.state_path, M, creator.id);
  const s5 = (step: string) => rep5.steps.find((x) => x.step === step && x.result === "sent")!;
  check("5: one transaction collected both: the curve's leftover and the pool's fee, unwrapped to SOL", B(rec5.collected_lamports) === left + inPool && rec5.venue === "pool" && !(await fork.getAccountInfo(wsolAta)),
    `${rec5.collected_lamports} lamports; the creator has no wrapped SOL account`);
  const rentToken = await fork.getMinimumBalanceForRentExemption(165);
  check("5: its cost is its fee plus the PumpSwap creator vault's token account (first pool sweep only)", B(rec5.collect_cost_lamports) === rentToken + B(s5("collect").amounts!.fee_lamports!), `${rec5.collect_cost_lamports} lamports, of which ${rentToken} rent`);
  check("5: collected = collection cost + reserve + compute share + buyback share; the shares are equal", B(rec5.collected_lamports) === B(rec5.collect_cost_lamports) + B(rec5.reserve_lamports) + B(rec5.compute_share_lamports) + B(rec5.burn_share_lamports)
    && rec5.compute_share_lamports === rec5.burn_share_lamports, `each ${rec5.compute_share_lamports} lamports`);
  check("5: the compute address received exactly what was owed to it", (await fork.getBalance(computeAddr)) - before5.compute === B(rec5.compute_lamports) && B(rec5.compute_lamports) === before5.st.compute_owed + B(rec5.compute_share_lamports));
  check("5: the pool buy burned what it bought in its own transaction; the supply fell by exactly that", before5.supply - (await supplyOf(M)) === B(rec5.units_bought) && rec5.units_bought === rec5.units_burned && B(rec5.units_bought) > 0n
    && rec5.buyback_signature === rec5.burn_signature && B(rec5.buyback_lamports) <= 60_000_000n && B(rec5.buyback_lamports) >= (60_000_000n * 10_000n) / 10_100n - 2n, `${rec5.units_bought} base units for ${rec5.buyback_lamports} lamports`);
  check("5: the wallet holds its own SOL plus exactly the ledger; no temporary account is left", (await fork.getBalance(creator.id)) === ownBefore + ledger(st5) && st5.pending === null);
  for (const [name, step] of [["collect after graduation (curve leftover + pool, first: creates the vault token account)", "collect"], ["buy on the pool + burn (first: creates the volume account)", "buyback"]] as const) {
    const s = s5(step);
    measured[name] = { size: 0, compute_units: s.amounts!.compute_units!, fee_lamports: s.amounts!.fee_lamports! };
  }

  // sizes of the landed transactions, and the fixture for the unit tests
  const all = [...chain.seen, ...chain5.seen];
  const txs: unknown[] = [];
  const sizeBySig = new Map<string, number>();
  for (const x of all) {
    const t = await fork.call<{ meta: { err: unknown; computeUnitsConsumed: number }; transaction: [string, string] } | null>("getTransaction", [x.signature, { encoding: "base64", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
    if (!t || t.meta.err) continue;
    sizeBySig.set(x.signature, Buffer.from(t.transaction[0], "base64").length);
    const j = await fork.call<{ transaction: { message: { accountKeys: string[]; instructions: { programIdIndex: number; accounts: number[]; data: string }[] } } }>("getTransaction", [x.signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
    const m = j.transaction.message;
    txs.push({ action: x.action, snapshot: x.snapshot, cu_limit: x.cuLimit, cu_price: x.price, size: sizeBySig.get(x.signature), compute_units: t.meta.computeUnitsConsumed,
      instructions: m.instructions.map((i) => ({ program: m.accountKeys[i.programIdIndex], accounts: i.accounts.map((k) => m.accountKeys[k]), data: i.data })) });
  }
  for (const rep of [rep1, lastBuy, rep4, rep5]) for (const s of rep.steps) for (const k of Object.keys(measured)) {
    if (s.result === "sent" && measured[k]!.compute_units === s.amounts?.compute_units && measured[k]!.fee_lamports === s.amounts?.fee_lamports && sizeBySig.has(s.signature!)) measured[k]!.size ||= sizeBySig.get(s.signature!)!;
  }
  const kinds = new Set(txs.map((t) => { const a = (t as { action: Action }).action; return a.kind === "buyback" ? `buyback-${a.venue}` : a.kind; }));
  check("the fixture holds an accepted transaction of every kind", ["collect", "compute", "buyback-curve", "buyback-pool"].every((k) => kinds.has(k)), [...kinds].join(", "));
  const first = (pred: (t: { action: Action; snapshot: Snapshot }) => boolean) => txs.filter((t) => pred(t as { action: Action; snapshot: Snapshot }));
  const fixture = {
    _note: "Recorded by scripts/mainnet/fee-keeper-fork.ts on a local fork of mainnet: what the keeper read (snapshot) and the instructions mainnet's Pump and PumpSwap builds accepted for it. Throwaway keys and coin.",
    config: { ...raw, key_path: null, state_path: "/nonexistent/state.json", log_path: "/nonexistent/runs.jsonl" },
    transactions: [
      ...first((t) => t.action.kind === "collect" && t.snapshot.phase === "curve").slice(0, 2), ...first((t) => t.action.kind === "collect" && t.snapshot.phase === "pool").slice(0, 1),
      ...first((t) => t.action.kind === "compute").slice(0, 1), ...first((t) => t.action.kind === "buyback" && t.action.venue === "curve").slice(0, 2),
      ...first((t) => t.action.kind === "buyback" && t.action.venue === "pool").slice(0, 1),
    ],
  };
  writeFileSync(join(import.meta.dir, "../../packages/fee-keeper/test/fixtures/fork.json"), json(fixture) + "\n");
  const out = { ran_at: new Date().toISOString(), mint: M, creator: creator.id, compute_address: computeAddr, config: fixture.config, measured,
    log_lines: readLog(cfg.log_path).length, pass: checks.filter((c) => c.ok).length, total: checks.length, checks, log: readLog(cfg.log_path) };
  writeFileSync(join(import.meta.dir, "FEE-KEEPER-FORK-LAST.json"), JSON.stringify(out, null, 2) + "\n");
  rmSync(dir, { recursive: true, force: true });
  log(`fee keeper fork proof PASS ${out.pass}/${out.total}; ${out.log_lines} log lines`);
  for (const [k, v] of Object.entries(measured)) log(`  ${k}: ${v.size} bytes, ${v.compute_units} CU, fee ${v.fee_lamports} lamports`);
  void sol;
}

await main();
