import { randomBytes } from "node:crypto";
import type { Address } from "@units/chain";
import { feeBound, MAX_COMPUTE_UNITS, type Chain, type Outcome, type Sim } from "./chain.ts";
import { MAINNET_GENESIS, type KeeperConfig } from "./config.ts";
import { quoteBuyback, refusals, waitingFees, type Snapshot } from "./plans.ts";
import { splitCollected } from "./split.ts";
import { acquireLock, appendLog, loadState, readLog, saveState, type Action, type KeeperState, type RunRecord, type Step } from "./state.ts";

// One run of the $UNITS fee keeper (owner decision 2026-10-12: half of the coin's creator fees funds
// compute, half buys $UNITS and burns it). In order:
//
//   0  a transaction left in flight by an interrupted run is settled first (it landed: book it; its
//      blockhash expired without it landing: forget it; neither yet: resend the same bytes and wait)
//   1  burn   $UNITS bought earlier and not burned yet (only after a buy that could not carry its burn)
//   2  collect  the creator fees waiting on pump.fun, when they are worth a transaction
//   3  compute  everything owed to the compute funding address, as SOL
//   4  buyback  one buy of at most max_buyback_lamports, burned in the same transaction
//
// Money rules. The wallet's own SOL is never spent: a collection is booked at what it brought the
// wallet after its own cost, split into the fee reserve, the compute share and the buyback share, and
// every later transaction takes its principal from what is owed and its fee and rent from the reserve.
// A transaction whose fee and rent the reserve does not cover is not sent.
//
// No double send. Before a transaction is sent, its signed bytes, signature and last valid block
// height are written to the state file. A new transaction is never built while one is recorded: the
// recorded one is resent until it lands or can no longer land. Its result is booked and the record
// cleared in one atomic write.

export interface RunOptions {
  /** False: a dry run. Nothing is signed, sent or written. */
  send: boolean;
  /** The key the chain signs with, when one is loaded (checked against config.creator). */
  signer?: Address | null;
  /** config/profile.json's $UNITS mint: on mainnet config.mint must equal it. */
  mainnetUnitsMint?: Address | null;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (m: string) => void;
  pollMs?: number;
  resendMs?: number;
}

export interface StepReport {
  step: Step | "settle";
  /** "sent": landed and booked. "would": dry run. "skipped": not worth it or not possible now. "failed": landed with an error. "waiting": sent, not confirmed in time. */
  result: "sent" | "would" | "skipped" | "failed" | "waiting";
  detail: string;
  signature?: string;
  simulation?: { ok: boolean; error: string | null; units: number; size: number; wallet_delta_lamports: string; created_rent_lamports: string; logs?: string[] };
  amounts?: Record<string, string>;
}

export interface RunReport {
  mode: "dry-run" | "send";
  cluster: string;
  /** Set when the run stopped before doing anything. */
  refused: string[];
  phase: Snapshot["phase"] | null;
  waiting_lamports: Record<string, string> | null;
  steps: StepReport[];
  /** The line appended to the public log, when the run moved something. */
  record: RunRecord | null;
  owed: { compute_lamports: string; buyback_lamports: string; burn_units: string; reserve_lamports: string } | null;
}

const clusterName = (genesis: string) => (genesis === MAINNET_GENESIS ? "mainnet" : `genesis:${genesis}`);
const simView = (s: Sim, withLogs = false) => ({ ok: s.ok, error: s.error, units: s.units, size: s.size, wallet_delta_lamports: s.walletDelta.toString(),
  created_rent_lamports: s.createdRent.toString(), ...(withLogs || !s.ok ? { logs: s.logs.slice(-12) } : {}) });
const add = (a: string, b: bigint) => (BigInt(a) + b).toString();
const cuLimitFor = (units: number) => Math.min(MAX_COMPUTE_UNITS, Math.ceil(units * 1.2) + 5_000);

function newRecord(cfg: KeeperConfig, s: Snapshot, now: Date): RunRecord {
  return {
    v: 1, run_id: `${now.toISOString()}-${randomBytes(4).toString("hex")}`, time: now.toISOString(), cluster: clusterName(s.genesis), mint: cfg.mint, creator: cfg.creator,
    venue: s.phase, collected_lamports: "0", collect_cost_lamports: "0", collect_signature: null, reserve_lamports: "0", compute_share_lamports: "0", burn_share_lamports: "0",
    compute_lamports: "0", compute_address: cfg.compute_address, compute_signature: null, buyback_lamports: "0", units_bought: "0", buyback_signature: null, units_burned: "0",
    burn_signature: null, overhead_lamports: "0", owed: { compute_lamports: "0", buyback_lamports: "0", burn_units: "0", reserve_lamports: "0" }, notes: [],
  };
}
const owedOf = (st: KeeperState) => ({ compute_lamports: st.compute_owed.toString(), buyback_lamports: st.buyback_owed.toString(), burn_units: st.burn_owed.toString(),
  reserve_lamports: st.reserve.toString() });

/** Takes fees and rent out of the reserve; the reserve never goes below zero. */
function payOverhead(st: KeeperState, rec: RunRecord, lamports: bigint) {
  if (lamports <= 0n) return;
  rec.overhead_lamports = add(rec.overhead_lamports, lamports);
  if (lamports > st.reserve) {
    rec.notes.push(`overhead of ${lamports} lamports exceeded the reserve by ${lamports - st.reserve}`);
    st.reserve = 0n;
  } else st.reserve -= lamports;
}

/** Books a landed transaction into the ledger and the run's record. Pure on (state, record). */
export function book(cfg: KeeperConfig, st: KeeperState, rec: RunRecord, a: Action, signature: string, o: Outcome): string {
  if (o.err) {
    payOverhead(st, rec, -o.walletDelta);
    rec.notes.push(`${a.kind} transaction ${signature} landed with an error (${o.err}); only its fee was paid`);
    return `landed with an error: ${o.err}`;
  }
  if (a.kind === "collect") {
    const net = o.walletDelta;
    rec.collect_signature = signature;
    rec.collected_lamports = add(rec.collected_lamports, o.collected);
    rec.collect_cost_lamports = add(rec.collect_cost_lamports, o.collected - net);
    if (net <= 0n) {
      payOverhead(st, rec, -net);
      rec.notes.push("the collection brought nothing (someone else collected first, or its cost ate it)");
      return `collected ${o.collected}, net ${net}`;
    }
    const sp = splitCollected(net, { computeBps: cfg.compute_bps, burnBps: cfg.burn_bps, reserveTarget: cfg.fee_reserve_lamports, reserveNow: st.reserve });
    st.reserve += sp.reserve;
    st.compute_owed += sp.compute;
    st.buyback_owed += sp.burn;
    rec.reserve_lamports = add(rec.reserve_lamports, sp.reserve);
    rec.compute_share_lamports = add(rec.compute_share_lamports, sp.compute);
    rec.burn_share_lamports = add(rec.burn_share_lamports, sp.burn);
    return `collected ${o.collected} (net ${net}): reserve ${sp.reserve}, compute ${sp.compute}, buyback ${sp.burn}`;
  }
  if (a.kind === "compute") {
    st.compute_owed = st.compute_owed > a.lamports ? st.compute_owed - a.lamports : 0n;
    rec.compute_lamports = add(rec.compute_lamports, a.lamports);
    rec.compute_signature = signature;
    payOverhead(st, rec, -o.walletDelta - a.lamports);
    return `sent ${a.lamports} lamports to ${cfg.compute_address}`;
  }
  if (a.kind === "buyback") {
    const overhead = o.fee + o.createdRent;
    const spent = -o.walletDelta - overhead;
    st.buyback_owed = st.buyback_owed > spent ? st.buyback_owed - spent : 0n;
    rec.buyback_lamports = add(rec.buyback_lamports, spent);
    rec.units_bought = add(rec.units_bought, a.tokens);
    rec.buyback_signature = signature;
    if (a.burn) {
      rec.units_burned = add(rec.units_burned, a.tokens);
      rec.burn_signature = signature;
    } else st.burn_owed += a.tokens;
    payOverhead(st, rec, overhead);
    return `bought ${a.tokens} base units for ${spent} lamports on the ${a.venue}${a.burn ? " and burned them" : "; the burn follows"}`;
  }
  st.burn_owed = st.burn_owed > a.tokens ? st.burn_owed - a.tokens : 0n;
  rec.units_burned = add(rec.units_burned, a.tokens);
  rec.burn_signature = signature;
  payOverhead(st, rec, -o.walletDelta);
  return `burned ${a.tokens} base units`;
}

export async function runKeeper(cfg: KeeperConfig, chain: Chain, opts: RunOptions): Promise<RunReport> {
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const say = opts.log ?? (() => undefined);
  const clock = () => now().getTime();
  const report: RunReport = { mode: opts.send ? "send" : "dry-run", cluster: "", refused: [], phase: null, waiting_lamports: null, steps: [], record: null, owed: null };

  let snap = await chain.read();
  const mainnet = snap.genesis === MAINNET_GENESIS;
  report.cluster = clusterName(snap.genesis);
  report.phase = snap.phase;
  const w0 = waitingFees(snap);
  report.waiting_lamports = { curve: w0.curve.toString(), vault: w0.vault.toString(), pool: w0.pool.toString(), pool_vault: w0.poolVault.toString(), total: w0.total.toString() };
  report.refused = refusals(cfg, snap, { signer: opts.signer, mainnetUnitsMint: opts.mainnetUnitsMint, mainnet });
  if (opts.send && mainnet && !cfg.enabled) report.refused.push("mainnet: config.enabled is not true (sending on mainnet needs enabled: true and --send)");
  if (opts.send && !opts.signer) report.refused.push("no key loaded: config.key_path is needed to send");
  if (report.refused.length) return report;

  const release = opts.send ? acquireLock(cfg.state_path) : () => undefined;
  try {
    const st = loadState(cfg.state_path, cfg.mint, cfg.creator);
    const save = () => {
      if (opts.send) saveState(cfg.state_path, st);
    };
    // a run whose line is already in the log was interrupted between the append and its close: close it
    if (opts.send && st.run && readLog(cfg.log_path).some((x) => x.run_id === st.run!.record.run_id)) {
      st.run = null;
      save();
    }
    // the run's record: the interrupted run's when there is one, else a new one (kept in the state from the first send on)
    let rec = st.run?.record ?? newRecord(cfg, snap, now());
    const done = new Set<Step>(st.run?.done ?? []);
    const keepRun = () => {
      st.run = { record: rec, done: [...done], logged: false };
    };

    // what the rest of the run plans on: the ledger, or in a dry run the ledger plus the predicted collection
    let owedCompute = st.compute_owed, owedBuyback = st.buyback_owed, reserve = st.reserve;

    /** Waits for the recorded transaction. True when it is settled (booked or forgotten), false when still unknown at the timeout. */
    const settle = async (): Promise<boolean> => {
      const p = st.pending!;
      const wire = Uint8Array.from(Buffer.from(p.wire, "base64"));
      const deadline = clock() + cfg.confirm_timeout_s * 1000;
      let lastSend = clock();
      for (;;) {
        if ((await chain.status(p.signature)) === "landed") {
          const o = await chain.outcome(p.signature);
          const detail = book(cfg, st, rec, p.action, p.signature, o);
          done.add(p.action.kind); // landed, with or without an error: not sent again in this run
          st.pending = null;
          keepRun();
          save();
          say(`${p.action.kind}: ${p.signature}: ${detail}`);
          report.steps.push({ step: p.action.kind, result: o.err ? "failed" : "sent", detail, signature: p.signature,
            amounts: { wallet_delta_lamports: o.walletDelta.toString(), fee_lamports: o.fee.toString(), created_rent_lamports: o.createdRent.toString(), compute_units: String(o.units ?? "") } });
          return true;
        }
        if ((await chain.blockHeight()) > p.last_valid_block_height) {
          // one last look: it may have landed in the final blocks
          if ((await chain.status(p.signature)) === "landed") continue;
          st.pending = null;
          keepRun();
          save();
          say(`${p.action.kind}: ${p.signature} expired without landing; nothing was paid`);
          report.steps.push({ step: p.action.kind, result: "skipped", detail: "the transaction's blockhash expired before it landed; nothing was paid, the next run tries again", signature: p.signature });
          return true;
        }
        if (clock() >= deadline) {
          report.steps.push({ step: p.action.kind, result: "waiting", detail: "sent and not confirmed in time; the next run settles it before anything else", signature: p.signature });
          return false;
        }
        if (clock() - lastSend >= (opts.resendMs ?? 2500)) {
          await chain.submit(wire).catch(() => undefined);
          lastSend = clock();
        }
        await sleep(opts.pollMs ?? 800);
      }
    };

    if (st.pending) {
      if (!opts.send) {
        report.steps.push({ step: "settle", result: "would", detail: `a ${st.pending.action.kind} transaction from an interrupted run is recorded (${st.pending.signature}); a run with --send settles it first`, signature: st.pending.signature });
        report.owed = owedOf(st);
        return report;
      }
      if (!(await settle())) {
        report.owed = owedOf(st);
        return report;
      }
    }

    /** Simulates, checks, and (with --send) signs, records, sends and settles one action. False: stop the run here. */
    const act = async (a: Action, check: (sim: Sim, fee: bigint) => string | null, amounts: Record<string, string>): Promise<boolean> => {
      const sim = await chain.simulate(a, snap);
      if (!sim.ok) {
        report.steps.push({ step: a.kind, result: "skipped", detail: `the simulation failed (${sim.error}); nothing sent`, simulation: simView(sim, true), amounts });
        if (opts.send) rec.notes.push(`${a.kind}: simulation failed (${sim.error})`);
        return true;
      }
      const price = await chain.price(a, snap);
      const limit = cuLimitFor(sim.units);
      const fee = feeBound(limit, price);
      const why = check(sim, fee);
      const withFee = { ...amounts, fee_bound_lamports: fee.toString(), cu_limit: String(limit), cu_price_micro_lamports: String(price) };
      if (why) {
        report.steps.push({ step: a.kind, result: "skipped", detail: why, simulation: simView(sim), amounts: withFee });
        if (opts.send && a.kind !== "collect") rec.notes.push(`${a.kind}: ${why}`);
        return true;
      }
      if (!opts.send) {
        report.steps.push({ step: a.kind, result: "would", detail: "simulated; a run with --send sends it", simulation: simView(sim), amounts: withFee });
        return true;
      }
      const p = await chain.sign(a, snap, limit, price);
      st.pending = { action: a, signature: p.signature, last_valid_block_height: p.lastValidBlockHeight, wire: Buffer.from(p.wire).toString("base64"), sent_at: now().toISOString() };
      keepRun();
      save();
      await chain.submit(p.wire);
      return settle();
    };
    const reserveCovers = (sim: Sim, fee: bigint) =>
      fee + sim.createdRent <= st.reserve ? null : `the fee reserve holds ${st.reserve} lamports and this transaction needs up to ${fee + sim.createdRent} (fee ${fee}, rent ${sim.createdRent}): left for a later run`;

    // ---- 1. burn what an earlier buy left unburned
    const burnOwed = async (): Promise<boolean> => {
      if (st.burn_owed === 0n) return true;
      snap = await chain.read();
      if (snap.tokenAta.amount < st.burn_owed) {
        const why = `${st.burn_owed} base units are owed to the burn and the wallet's token account holds ${snap.tokenAta.amount}: not burning, check the wallet`;
        report.steps.push({ step: "burn", result: "skipped", detail: why });
        if (opts.send) rec.notes.push(`burn: ${why}`);
        return true;
      }
      return act({ kind: "burn", tokens: st.burn_owed }, reserveCovers, { units: st.burn_owed.toString() });
    };
    if (!(await burnOwed())) return finish(false);

    // ---- 2. collect
    let predictedNet = 0n;
    if (!done.has("collect")) {
      snap = await chain.read();
      const wt = waitingFees(snap);
      const amounts = { waiting_lamports: wt.total.toString(), min_collect_lamports: cfg.min_collect_lamports.toString() };
      if (wt.total < cfg.min_collect_lamports) {
        report.steps.push({ step: "collect", result: "skipped", detail: `${wt.total} lamports wait, under min_collect_lamports ${cfg.min_collect_lamports}`, amounts });
      } else {
        const ok = await act({ kind: "collect" }, (sim, fee) => {
          // the lower bound of what the wallet gains, whether or not the simulation already took the fee
          predictedNet = sim.walletDelta - fee;
          return predictedNet >= cfg.min_collect_lamports ? null : `the collection would bring ${predictedNet} lamports after its cost, under min_collect_lamports ${cfg.min_collect_lamports}`;
        }, amounts);
        if (!ok) return finish(false);
      }
    }

    // a dry run plans the rest on what the collection is predicted to bring
    [owedCompute, owedBuyback, reserve] = [st.compute_owed, st.buyback_owed, st.reserve];
    if (!opts.send && report.steps.some((x) => x.step === "collect" && x.result === "would")) {
      const sp = splitCollected(predictedNet, { computeBps: cfg.compute_bps, burnBps: cfg.burn_bps, reserveTarget: cfg.fee_reserve_lamports, reserveNow: st.reserve });
      owedCompute += sp.compute;
      owedBuyback += sp.burn;
      reserve += sp.reserve;
      const c = report.steps.find((x) => x.step === "collect")!;
      c.amounts = { ...c.amounts, predicted_net_lamports: predictedNet.toString(), reserve_lamports: sp.reserve.toString(), compute_share_lamports: sp.compute.toString(), burn_share_lamports: sp.burn.toString() };
    }
    const covers = (sim: Sim, fee: bigint) => (opts.send ? reserveCovers(sim, fee)
      : fee + sim.createdRent <= reserve ? null : `the fee reserve would hold ${reserve} lamports and this transaction needs up to ${fee + sim.createdRent}: left for a later run`);

    // ---- 3. compute
    if (owedCompute > 0n && !done.has("compute")) {
      snap = await chain.read();
      const amounts = { compute_lamports: owedCompute.toString(), compute_address: cfg.compute_address };
      if (snap.compute.lamports === 0n && owedCompute < snap.rent0) {
        const why = `the compute address holds nothing and ${owedCompute} lamports are under the rent-exempt minimum ${snap.rent0}: a transfer would be refused, carried to a later run`;
        report.steps.push({ step: "compute", result: "skipped", detail: why, amounts });
        if (opts.send) rec.notes.push(`compute: ${why}`);
      } else if (!(await act({ kind: "compute", lamports: owedCompute }, covers, amounts))) return finish(false);
    }

    // ---- 4. buyback (one buy per run) and its burn
    if (opts.send) owedBuyback = st.buyback_owed;
    if (owedBuyback > 0n && !done.has("buyback")) {
      snap = await chain.read();
      const budget = owedBuyback < cfg.max_buyback_lamports ? owedBuyback : cfg.max_buyback_lamports;
      const amounts: Record<string, string> = { buyback_owed_lamports: owedBuyback.toString(), budget_lamports: budget.toString(), slippage_bps: String(cfg.slippage_bps) };
      if (budget < cfg.min_buyback_lamports) {
        report.steps.push({ step: "buyback", result: "skipped", detail: `${budget} lamports are under min_buyback_lamports ${cfg.min_buyback_lamports}: carried to a later run`, amounts });
      } else {
        const q = quoteBuyback(snap, budget, cfg.slippage_bps);
        if (!q.ok) {
          report.steps.push({ step: "buyback", result: "skipped", detail: q.reason, amounts });
          if (opts.send) rec.notes.push(`buyback: ${q.reason}`);
        } else {
          const one: Action = { kind: "buyback", tokens: q.tokens, maxLamports: budget, burn: true, venue: q.venue };
          const a: Action = chain.fits(one, snap) ? one : { ...one, burn: false };
          if (!(await act(a, covers, { ...amounts, units: q.tokens.toString(), venue: q.venue, burn_in_same_transaction: String(a.burn) }))) return finish(false);
        }
      }
    }
    if (opts.send && !(await burnOwed())) return finish(false);
    return finish(true);

    function finish(complete: boolean): RunReport {
      report.owed = opts.send ? owedOf(st) : { compute_lamports: owedCompute.toString(), buyback_lamports: owedBuyback.toString(), burn_units: st.burn_owed.toString(), reserve_lamports: reserve.toString() };
      if (!opts.send || !complete) return report;
      if (st.run) {
        rec.owed = owedOf(st);
        const moved = rec.collect_signature || rec.compute_signature || rec.buyback_signature || rec.burn_signature;
        if (moved) {
          // the log line first, then the run is closed: a crash between the two finds the line already there
          st.run = { record: rec, done: [...done], logged: false };
          save();
          appendLog(cfg.log_path, rec);
          report.record = rec;
        }
        st.run = null;
        save();
      }
      return report;
    }
  } finally {
    release();
  }
}
