// The launch's SOL costs without a simulation (src/launch-costs.ts), checked against the one real
// launch on mainnet: the TEST launch TBASALT of 2026-10-12 (transactions nxxUtfKr... and 5NCfFmJ8...,
// read back with getTransaction: fees, balances before and after, and the size of each new account).
import { describe, expect, test } from "bun:test";
import { CU_MAX, LAUNCH_CU, launchCostDetail, launchCreates, launchTxUnits, mintSize, rentLamports, txFeeLamports } from "../src/launch-costs.ts";

// getMinimumBalanceForRentExemption(0) on mainnet and devnet, 2026-10-12
const RENT0 = 650_240n;
const NAME = "Test Basalt", SYMBOL = "TBASALT", URI = "x".repeat(64); // that launch's URI was 64 bytes long

describe("fees", () => {
  test("a signature costs 5,000 lamports and the priority fee is charged on the limit, rounded up: the two real transactions", () => {
    // transaction 1: 3 signatures, limit 450,000 at 199,975 micro-lamports; transaction 2: 1 signature, 400,000 at 8,252
    expect(txFeeLamports(3, 450_000, 199_975)).toBe(104_989n);
    expect(txFeeLamports(1, 400_000, 8_252)).toBe(8_301n);
    expect(txFeeLamports(1, 200_000, 0)).toBe(5_000n);
  });
});

describe("rent", () => {
  test("the cluster's rate times 128 + size: the seven accounts transaction 1 created, to the lamport", () => {
    expect(mintSize(NAME, SYMBOL, URI)).toBe(400);
    const got = launchCreates({ name: NAME, symbol: SYMBOL, uri: URI }).map((c) => rentLamports(c.size, RENT0));
    expect(got).toEqual([2_682_240n, 1_493_520n, 1_513_840n, 1_513_840n, 3_464_560n, 1_488_440n, 2_687_320n]);
  });
  test("the name, symbol and URI are in the mint account: a longer URI costs its bytes", () => {
    expect(rentLamports(mintSize(NAME, SYMBOL, URI + "?i=" + "h".repeat(44)), RENT0) - rentLamports(mintSize(NAME, SYMBOL, URI), RENT0)).toBe(47n * 5_080n);
  });
});

describe("the whole launch", () => {
  const txs = [
    { groups: ["launch", "soul"], signatures: 3, units: 450_000, price: 199_975 },
    { groups: ["sol-to-units", "initial-buy", "credits", "tip"], signatures: 1, units: 400_000, price: 8_252 },
  ];
  const creates = launchCreates({ name: NAME, symbol: SYMBOL, uri: URI, purchase: { launcherLine: "LINE", launcherVolume: "VOL" }, buy: { createsBuyback: true } });
  test("equals what the launcher's wallet paid on mainnet, to the lamport", () => {
    // transaction 2 paid 76,150,645 to the $UNITS curve and 358,934 to pump.fun's fee account for the $UNITS it bought, and a 9,685 lamport tip
    const whole = 76_150_645n + 358_934n;
    const d = launchCostDetail({ txs, rent0: RENT0, creates, existing: new Set(), purchase: { whole, credits: 6_000n }, hasBuy: true, identity: 0n, tip: 9_685n });
    expect(d.fees).toEqual([104_989n, 8_301n]);
    expect(d.rents.length).toBe(11);
    // the wallet went from 400,000,000 to 385,051,251 and then to 302,635,966 lamports
    expect(d.costs.total).toBe(400_000_000n - 302_635_966n);
    expect(d.costs.creation).toBe(14_948_749n + 8_301n + 5_887_720n);
    expect(d.costs.credits + d.costs.buy!).toBe(whole);
    expect(d.costs.tip).toBe(9_685n);
  });
  test("an account that exists already is not paid for again (a returning launcher), and a group that is not in the plan creates nothing", () => {
    const first = launchCostDetail({ txs, rent0: RENT0, creates, existing: new Set(), purchase: null, hasBuy: true, identity: 0n });
    const again = launchCostDetail({ txs, rent0: RENT0, creates, existing: new Set(["LINE", "VOL"]), purchase: null, hasBuy: true, identity: 0n });
    expect(first.rent - again.rent).toBe(rentLamports(170, RENT0) + rentLamports(137, RENT0));
    const noBuy = launchCostDetail({ txs: [txs[0]!], rent0: RENT0, creates, existing: new Set(), purchase: null, hasBuy: false, identity: 30_000_000n });
    expect(noBuy.rents.length).toBe(7);
    expect(noBuy.costs.identity).toBe(30_000_000n);
    expect(noBuy.costs.buy).toBeNull();
  });
  test("the optional groups charge their own accounts, the shared ones only when absent", () => {
    const c = launchCreates({ name: NAME, symbol: SYMBOL, uri: URI, feeRoute: { escrow: "E", vault: "V" }, pool: { pool: "P", vault: "PV" } });
    const t = [{ groups: ["launch", "fee-route", "pool"], signatures: 3, units: 660_000, price: 1 }];
    expect(launchCostDetail({ txs: t, rent0: RENT0, creates: c, existing: new Set(), purchase: null, hasBuy: false, identity: 0n }).rents.length).toBe(7 + 3 + 3);
    expect(launchCostDetail({ txs: t, rent0: RENT0, creates: c, existing: new Set(["E", "V", "P", "PV"]), purchase: null, hasBuy: false, identity: 0n }).rents.length).toBe(7 + 1 + 1);
  });
});

describe("compute unit limits, set in one place", () => {
  test("each transaction's limit covers every recorded run with at least 60% to spare, and is no larger than the limits the page used before", () => {
    const one = launchTxUnits(["launch", "soul"]), two = launchTxUnits(["sol-to-units", "initial-buy", "credits", "tip"]);
    // transaction 1: 252,060 (mainnet, landed), 247,862 (fork), 274,328 (mainnet, simulated by live-launch.ts); transaction 2: 187,338 and 193,348
    expect(one).toBeGreaterThanOrEqual(Math.ceil(274_328 * 1.6));
    expect(two).toBeGreaterThanOrEqual(Math.ceil(193_348 * 1.6));
    expect(one).toBeLessThanOrEqual(450_000);
    expect(two).toBeLessThanOrEqual(400_000);
  });
  test("a units account payment adds its own allowance; an unknown group gets one; never over the network's maximum", () => {
    expect(launchTxUnits(["credits", "units-account"]) - launchTxUnits(["credits"])).toBe(LAUNCH_CU["units-account"]!);
    expect(launchTxUnits(["something-new"])).toBeGreaterThan(100_000);
    expect(launchTxUnits(Array(40).fill("launch"))).toBe(CU_MAX);
  });
});
