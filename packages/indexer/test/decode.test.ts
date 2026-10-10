import { describe, expect, test } from "bun:test";
import { base58Encode } from "@lineage/protocol";
import { PUMP, pumpPdas } from "@lineage/chain";
import { accountKeys, decodeTx, tokenDeltas, type RawTx } from "../src/decode.ts";
import { A1, A2, ctxOf, feesCranked, FX, LINE, pumpGraduated, pumpLaunched, tx, withLog } from "./pumpfx.ts";

// The pump.fun proof's transactions, recorded on the mainnet fork (mainnet's Pump and PumpSwap builds).
// Expected amounts are what the chain recorded: each trader's own token balance deltas in the same
// transaction, the venue vault inflows of multi-hop legs, and the creator PDA's $LINE balance after
// the sweeps and collects that scripts/mainnet/pump-fork-proof.ts measured.

const dec = (step: string, mint = A1) => decodeTx(tx(step), ctxOf(mint));
/** The delta of `owner`'s token accounts of `mint` in the transaction. */
function delta(t: RawTx, mint: string, owner: string): bigint {
  const d = tokenDeltas(t, accountKeys(t));
  return [...d.values()].filter((x) => x.mint === mint && x.owner === owner).reduce((n, x) => n + x.delta, 0n);
}

describe("curve and pool trades", () => {
  test("each trade's amounts equal what the trader's own token accounts moved", () => {
    for (const [step, mint] of [["3a", A1], ["3b", A1], ["3c", A1], ["8b", A2], ["9a", A2], ["9b", A2]] as const) {
      const t = tx(step);
      const [tr] = decodeTx(t, ctxOf(mint)).trades;
      expect(tr).toBeDefined();
      const sign = tr!.side === "buy" ? 1n : -1n;
      expect(delta(t, mint, tr!.trader)).toBe(sign * tr!.baseRaw);
      expect(delta(t, LINE, tr!.trader)).toBe(-sign * tr!.quoteRaw);
    }
  });
  test("venues and sides: v3 curve buys, an exact-quote-in buy, a sell; PumpSwap buy_v2 and sell_v2", () => {
    expect(["3a", "3b", "3c"].map((s) => dec(s).trades.map((t) => `${t.venue}:${t.side}`).join())).toEqual(["curve:buy", "curve:buy", "curve:sell"]);
    expect(["9a", "9b"].map((s) => dec(s, A2).trades.map((t) => `${t.venue}:${t.side}`).join())).toEqual(["pool:buy", "pool:sell"]);
    expect(dec("3b").trades[0]!.quoteRaw).toBe(1_000_000_000_000n); // buy_exact_quote_in_v3 with exactly 1,000,000 $LINE
  });
  test("multi_hop_swap from SOL: only the agent coin's hop counts, priced by the $LINE that entered its curve or pool", () => {
    for (const [step, mint, venue, vault] of [["3d", A1, "curve", ""], ["7b", A2, "curve", ""], ["9c", A2, "pool", ""]] as const) {
      void vault;
      const t = tx(step);
      const d = decodeTx(t, ctxOf(mint));
      expect(d.trades.map((x) => x.venue)).toEqual([venue]);
      const dest = venue === "curve" ? pumpPdas.bondingCurve(mint) : pumpPdas.pool(mint, LINE);
      const inflow = [...tokenDeltas(t, accountKeys(t)).values()].filter((x) => x.mint === LINE && x.owner === dest).reduce((n, x) => n + x.delta, 0n);
      expect(d.trades[0]!.quoteRaw).toBe(inflow);
      expect(delta(t, mint, d.trades[0]!.trader)).toBe(d.trades[0]!.baseRaw);
    }
  });
  test("the completing buy includes its synthetic-migration leg, then completion and migration are events", () => {
    const d = dec("8b", A2);
    expect([d.trades.length, d.trades[0]!.completing, d.events.map((e) => e.kind)]).toEqual([1, true, ["complete"]]);
    expect(dec("8c", A2).events.map((e) => e.kind)).toEqual(["migration"]);
  });
  test("the launch transaction's initial buy (by the launcher, delivered to the treasury) is one curve buy", () => {
    const d = dec("2");
    expect([d.trades.length, d.trades[0]!.side, d.trades[0]!.baseRaw]).toEqual([1, "buy", 10_000_000_000_000n]);
  });
});

describe("creator fees: income at the trades, payouts at the sweeps", () => {
  test("the trades' creator fees sum to exactly what the sweeps and collects paid into the creator PDA", () => {
    for (const [mint, want] of [[A1, FX.pda_line_after_sweeps.a1], [A2, FX.pda_line_after_sweeps.a2]] as const) {
      const income = FX.txs.flatMap((t) => decodeTx(t.tx, ctxOf(mint)).trades).reduce((n, t) => n + t.creatorFeeRaw, 0n);
      const swept = FX.txs.flatMap((t) => decodeTx(t.tx, ctxOf(mint)).sweeps).reduce((n, s) => n + s.amountRaw, 0n);
      expect(income.toString()).toBe(want);
      expect(swept.toString()).toBe(want);
    }
  });
  test("sweeps by venue: the curve's after the curve trades, the curve's and the pool's after migration", () => {
    expect(dec("4").sweeps.map((s) => `${s.venue}:${s.amountRaw}`)).toEqual(["curve:103289391468"]);
    expect(dec("9d", A2).sweeps.map((s) => s.venue)).toEqual(["curve", "pool"]);
    expect(dec("9d", A2).sweeps[0]!.recipient).toBe(pumpPdas.creatorVault(FX.creator_pdas.a2));
  });
});

describe("lineage_launch events", () => {
  test("FeesCranked, PumpGraduated and PumpLaunched from lineage_launch's own frame", () => {
    const t = withLog(withLog(withLog(tx("9d"), feesCranked(A2, A2, 100n, 70n, true, 1234n)), pumpGraduated(A2, A2, pumpPdas.pool(A2, LINE), FX.creator_pdas.a2,
      true)), pumpLaunched(A2, A2, LINE, pumpPdas.bondingCurve(A2), FX.creator_pdas.a2));
    const d = decodeTx(t, ctxOf(A2));
    expect(d.fees.map((f) => [f.feesRaw, f.toComputeRaw, f.toProtocolRaw, f.poolFees, f.balanceRaw])).toEqual([[100n, 70n, 30n, true, 1234n]]);
    expect(d.events.find((e) => e.kind === "graduated")!.detail).toEqual({ pool: pumpPdas.pool(A2, LINE), coin_creator: FX.creator_pdas.a2, creator_is_ours: "true" });
    expect(d.events.find((e) => e.kind === "launch")!.detail.pump_creator).toBe(FX.creator_pdas.a2);
    // another mint's crank is not this token's
    expect(decodeTx(t, ctxOf(A1)).fees).toHaveLength(0);
  });
  test("failed transactions decode to nothing", () => {
    const t = tx("3a");
    const d = decodeTx({ ...t, meta: { ...t.meta!, err: { InstructionError: [1, "Custom"] } } }, ctxOf(A1));
    expect([d.failed, d.trades.length]).toEqual([true, 0]);
  });
});

// Audit A2 OFF-I1 carried over: events count only from the emitting program's own frame or event-CPI self call.
describe("audit: forged events", () => {
  const FOREIGN = "Fake1111111111111111111111111111111111111111";
  test("a FeesCranked log line emitted by another program is ignored", () => {
    expect(decodeTx(withLog(tx("3a"), feesCranked(A1, A1, 9n, 6n, false, 9n), FOREIGN), ctxOf(A1)).fees).toHaveLength(0);
  });
  test("pump.fun event bytes in an instruction to another program, or without Pump's event authority, are ignored", () => {
    const t = tx("3a");
    const keys = t.transaction.message.accountKeys;
    const g = t.meta!.innerInstructions!.find((x) => x.instructions.some((i) => keys[i.programIdIndex] === PUMP.program && i.accounts.length === 1))!;
    const ev = g.instructions.find((i) => keys[i.programIdIndex] === PUMP.program && i.accounts.length === 1)!;
    // retarget the event instruction to the system program (index of any non-pump key)
    const other = keys.findIndex((k) => k === "11111111111111111111111111111111");
    const forged = structuredClone(t);
    const fg = forged.meta!.innerInstructions!.find((x) => x.index === g.index)!;
    fg.instructions = fg.instructions.map((i) => (i.data === ev.data ? { ...i, programIdIndex: other } : i));
    expect(decodeTx(forged, ctxOf(A1)).trades).toHaveLength(0);
    const wrongAuth = structuredClone(t);
    const wg = wrongAuth.meta!.innerInstructions!.find((x) => x.index === g.index)!;
    wg.instructions = wg.instructions.map((i) => (i.data === ev.data ? { ...i, accounts: [0] } : i));
    expect(decodeTx(wrongAuth, ctxOf(A1)).trades).toHaveLength(0);
    expect(base58Encode(new Uint8Array(32))).toBe("11111111111111111111111111111111");
  });
});
