import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { base58Decode } from "@lineage/protocol";
import { decodeSwapEvent, decodeTx, DAMM_V2_PROGRAM, DBC_PROGRAM, EVENT_IX_TAG, type RawTx, type TokenCtx } from "../src/decode.ts";

// Real devnet transactions recorded once by scripts/record-fixtures.ts. Expected amounts are the
// ones onchain/DEVNET.md records for those transactions (sent amounts, crank splits, vault balances).

const fx = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", `${name}.json`), "utf8")) as { ctx: TokenCtx; tx: RawTx };
const dec = (name: string) => {
  const f = fx(name);
  return decodeTx(f.tx, f.ctx);
};
const DEPLOYER = "CVEZWyUBoNb6Zkte3qa7JDu5TBV4wTH6wMw4pLodnDih";
const TRADER = "4UwBL8x8sDsBKsZGDSAU1J2ed63UgsNG92bQonLSe1au";

/** Every Meteora swap event in a transaction, decoded straight from the inner instructions. */
function events(name: string) {
  const { tx } = fx(name);
  const keys = tx.transaction.message.accountKeys;
  return (tx.meta!.innerInstructions ?? []).flatMap((g) => g.instructions).map((ix) => ({ p: keys[ix.programIdIndex]!, d: base58Decode(ix.data) }))
    .filter((x) => (x.p === DBC_PROGRAM || x.p === DAMM_V2_PROGRAM) && Buffer.from(x.d.subarray(0, 8)).toString("hex") === EVENT_IX_TAG)
    .map((x) => decodeSwapEvent(x.p, x.d.subarray(8))).filter((e) => e && e.kind === "v2");
}

describe("decode recorded devnet transactions", () => {
  test("DBC buy: 100,000 tLINE in (DEVNET.md trade 1)", () => {
    const d = dec("dbc-buy");
    expect(d.trades).toHaveLength(1);
    const t = d.trades[0]!;
    expect([t.venue, t.side, t.trader, t.source]).toEqual(["dbc", "buy", TRADER, "deltas"]);
    expect(t.quoteRaw).toBe(100_000_000_000n);
    expect(t.baseRaw).toBe(1_905_346_510_342n);
    expect(t.price).toBeCloseTo(100_000 / 1_905_346.510342, 12);
    expect(t.spotAfter!).toBeGreaterThan(0);
    expect(d.fees).toHaveLength(0);
  });
  test("DBC sell", () => {
    const t = dec("dbc-sell").trades;
    expect(t).toHaveLength(1);
    expect([t[0]!.venue, t[0]!.side, t[0]!.baseRaw, t[0]!.quoteRaw]).toEqual(["dbc", "sell", 1_416_359_930_641n, 71_517_131_240n]);
  });
  test("curve fill (PartialFill buy) quote equals DEVNET.md's 16494845360611", () => {
    const t = dec("curve-fill").trades;
    expect(t).toHaveLength(1);
    expect([t[0]!.side, t[0]!.quoteRaw, t[0]!.trader]).toEqual(["buy", 16_494_845_360_611n, DEPLOYER]);
  });
  test("balance deltas agree with Meteora's own swap events (EvtSwap2)", () => {
    for (const n of ["dbc-buy", "dbc-sell", "curve-fill", "damm-buy", "damm-sell"]) {
      const t = dec(n).trades[0]!;
      const e = events(n);
      expect(e).toHaveLength(1);
      const [base, quote] = e[0]!.buy ? [e[0]!.outputRaw, e[0]!.inputRaw] : [e[0]!.inputRaw, e[0]!.outputRaw];
      expect([n, base, quote]).toEqual([n, t.baseRaw, t.quoteRaw]);
    }
  });
  test("launch_agent: launch event, no trade", () => {
    const d = dec("launch");
    expect(d.trades).toHaveLength(0);
    expect(d.events.map((e) => [e.kind, e.detail.agent])).toEqual([["launch", "BFPxdave7NVSXztGEZA5iZ7FiBDKRsuZmS9wZn2J1WBV"]]);
  });
  test("crank_fees: curve partner fee 395876288656 split 7000/3000", () => {
    const f = dec("crank-fees").fees;
    expect(f).toHaveLength(1);
    expect([f[0]!.feesRaw, f[0]!.toComputeRaw, f[0]!.toProtocolRaw, f[0]!.poolFees, f[0]!.balanceRaw]).toEqual([
      395_876_288_656n, 277_113_402_059n, 118_762_886_597n, false, 277_113_402_059n]);
  });
  test("migration_damm_v2: migration event naming the DAMM v2 pool, no trade", () => {
    const d = dec("migration");
    expect(d.trades).toHaveLength(0);
    expect(d.events.map((e) => [e.kind, e.detail.damm_pool])).toEqual([["migration", "6mNHiH2MzGD4bHFMkB8R6aGTLAR2D1ovcFRVMqUFfvkp"]]);
  });
  test("graduate and repoint_position", () => {
    expect(dec("graduate").events.map((e) => [e.kind, e.detail.position])).toEqual([["graduated", "CC4ZQFcsDBKfCqNXipEnvTy77EGQjkERWmpNU1qaZoM2"]]);
    expect(dec("repoint").events.map((e) => [e.kind, e.detail.position])).toEqual([["repointed", "4nd5ej1p3VqGv4FxMUQM3cuh45zQbDFjwUant75b5Tsk"]]);
  });
  test("DAMM v2 buy with 200,000 tLINE and sell of 4011979457935", () => {
    const b = dec("damm-buy").trades;
    expect([b.length, b[0]!.venue, b[0]!.side, b[0]!.quoteRaw, b[0]!.trader]).toEqual([1, "damm", "buy", 200_000_000_000n, DEPLOYER]);
    const s = dec("damm-sell").trades;
    expect([s.length, s[0]!.venue, s[0]!.side, s[0]!.baseRaw]).toEqual([1, "damm", "sell", 4_011_979_457_935n]);
    expect(s[0]!.spotAfter!).toBeLessThan(b[0]!.spotAfter!);
  });
  test("crank_pool_fees: vault ends at 340117655127", () => {
    const f = dec("crank-pool-fees").fees;
    expect([f.length, f[0]!.poolFees, f[0]!.toComputeRaw, f[0]!.toProtocolRaw, f[0]!.balanceRaw]).toEqual([
      1, true, 13_743_310_604n, 5_889_990_259n, 340_117_655_127n]);
  });
  test("a DAMM trade is not seen when the token context has no DAMM pool yet", () => {
    const f = fx("damm-buy");
    expect(decodeTx(f.tx, { ...f.ctx, dammPool: null }).trades).toHaveLength(0);
  });
  test("failed transactions decode to nothing", () => {
    const f = fx("dbc-buy");
    const d = decodeTx({ ...f.tx, meta: { ...f.tx.meta!, err: { InstructionError: [1, "Custom"] } } }, f.ctx);
    expect([d.failed, d.trades.length]).toEqual([true, 0]);
  });
});
