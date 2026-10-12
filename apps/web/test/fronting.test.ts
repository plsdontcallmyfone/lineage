// Launch fronting (docs/plans/LAUNCH-FRONTING.md): the wizard's cost lines from a launch simulation
// and the venue buy hook (amount and slippage bound checked against Core's config).
import { describe, expect, test } from "bun:test";
import { maxBuyInput, parsePrepayConfig } from "../../../packages/chain/src/browser/index.ts";
import { costBreakdown, fundingBlocked, fundingSummary, initialBuyFor, setInitialBuyBuilder, solCostsFromSims } from "../wallet/fronting.ts";

const acc = (address: string, before: bigint | null, after: bigint | null, dataBefore: Uint8Array | null = null, dataAfter: Uint8Array | null = null) =>
  ({ address, writable: true, signer: false, before, after, owner: null, created: before === null, dataBefore, dataAfter });

const CFG = parsePrepayConfig({ min_usd: "10", default_usd: "10", line_per_usd: "20", rate_status: "test", compute_price_line_per_usd: "20",
  compute_price_line_per_sandbox_s: "0.002", sandbox_reserve_s: 600, attempt_max_usd: 0.5, since: 0 });

describe("SOL cost lines from the simulations (owner direction 2026-10-11)", () => {
  const launchSim = { err: null, logs: [], fee: 10_000n, accounts: [acc("launcher", 1_000_000_000n, 975_000_000n)] };
  // the purchase: fee 10,000, the launcher's $UNITS account created (2,039,280), 3,000,000 lamports of trade
  const purchase = { err: null, logs: [], fee: 10_000n, accounts: [acc("launcher", 975_000_000n, 969_950_720n), acc("launcherUnits", null, 2_039_280n)] };
  test("creation = launch change + purchase fee and rent + later fees and rent; credits and buy split the trade by pump.fun's quote", () => {
    const c = solCostsFromSims({ launch: launchSim, purchase, payer: "launcher", creditsShare: { num: 1n, den: 3n }, hasBuy: true, laterFees: 5_000n, laterRent: 2_074_080n,
      identity: 50_000_000n, headroom: 30_000n })!;
    expect(c.creation).toBe(25_000_000n + 10_000n + 2_039_280n + 5_000n + 2_074_080n);
    expect(c.credits).toBe(1_000_000n);
    expect(c.buy).toBe(2_000_000n);
    expect(c.identity).toBe(50_000_000n);
    expect(c.total).toBe(c.creation + 3_000_000n + 50_000_000n);
    expect(c.needed).toBe(c.total + 30_000n);
  });
  test("a failed simulation gives no figures (launch stays disabled)", () => {
    expect(solCostsFromSims({ launch: { ...launchSim, err: { InstructionError: [0, "x"] } }, purchase, payer: "launcher", creditsShare: { num: 1n, den: 1n }, hasBuy: false, laterFees: 0n, laterRent: 0n, identity: 0n })).toBeNull();
  });
  test("Launch disabled reasons: no SOL price first, then simulation, then balance", () => {
    const costs = solCostsFromSims({ launch: launchSim, purchase, payer: "launcher", creditsShare: { num: 1n, den: 1n }, hasBuy: false, laterFees: 0n, laterRent: 0n, identity: 0n })!;
    expect(fundingBlocked({ costs, solUsd: null, solBalance: 10n ** 12n })).toBe("no SOL price");
    expect(fundingBlocked({ costs: null, solUsd: 112, solBalance: 10n ** 12n })).toMatch(/not simulated/);
    expect(fundingBlocked({ costs, solUsd: 112, solBalance: 1n })).toMatch(/the wallet holds/);
    expect(fundingBlocked({ costs, solUsd: 112, solBalance: 10n ** 12n })).toBeNull();
  });
  test("Funding: one total in US dollars with the SOL small, a one-line breakdown with the units account, one short disabled line", () => {
    const costs = solCostsFromSims({ launch: launchSim, purchase, payer: "launcher", creditsShare: { num: 1n, den: 3n }, hasBuy: true, laterFees: 0n, laterRent: 0n, identity: 50_000_000n })!;
    const v = { costs, creditsUsd: "10", bps: 100, identityChosen: true, solUsd: 100, solBalance: 1n, txCount: 2, blocked: "the wallet holds 0.000000001 SOL", devnet: true, docs: "/docs/x", pending: false };
    const h = fundingSummary(v).s;
    expect(h).toContain("Token creation · Model credits · Initial buy 1% · A units account");
    expect(h).toContain("one signature");
    expect(h).toContain("Launch disabled: the wallet holds");
    expect(h).toContain("Devnet test tokens, no value");
    expect(h).not.toMatch(/\bt?UNITS\b/);
    expect(h).not.toContain("\u2014");
    const r = costBreakdown({ ...v, blocked: null }).s;
    // US dollars lead every cost, through the one formatter; the SOL the wallet pays stays beside it
    expect(r).toContain("for $10.00 of credits");
    expect(r).toMatch(/data-fronting="A units account"[^]*?<b class="num">\$5\.00<\/b> <span class="dim">0\.05 SOL<\/span>/);
    expect(h).toMatch(/data-fronting-total>\$\d/);
    expect(h).toMatch(/data-fronting-sol>[\d.]+ SOL</);
    // no SOL price: the cost reads "$ unavailable" beside the SOL amount, never a number passing as dollars
    expect(costBreakdown({ ...v, solUsd: null }).s).toMatch(/data-fronting="Total"[^]*?<b class="num">\$ unavailable<\/b> <span class="dim">[\d.]+ SOL/);
    expect(r).toContain("2 transactions signed together, sent in order");
    expect(fundingSummary({ ...v, identityChosen: false }).s).not.toContain("A units account");
  });
});

describe("the venue buy hook", () => {
  test("no builder: no buy (today's launches unchanged)", async () => {
    setInitialBuyBuilder(null);
    expect(await initialBuyFor({ launcher: "l", agent: "a", agentMint: "m" }, CFG)).toBeNull();
  });
  test("exactly the configured 1% and slippage bound, else refused", async () => {
    setInitialBuyBuilder({ supply: async () => 10n ** 15n, build: async (c) => ({ ixs: [], amountOut: c.amountOut, quote: 7n, maxIn: maxBuyInput(7n, c.slippageBps), treasuryAccount: "t" }) });
    expect((await initialBuyFor({ launcher: "l", agent: "a", agentMint: "m" }, CFG))!.amountOut).toBe(10n ** 13n);
    setInitialBuyBuilder({ supply: async () => 10n ** 15n, build: async (c) => ({ ixs: [], amountOut: c.amountOut + 1n, quote: 7n, maxIn: 8n, treasuryAccount: "t" }) });
    await expect(initialBuyFor({ launcher: "l", agent: "a", agentMint: "m" }, CFG)).rejects.toThrow(/not the configured/);
    setInitialBuyBuilder({ supply: async () => 10n ** 15n, build: async (c) => ({ ixs: [], amountOut: c.amountOut, quote: 7n, maxIn: 100n, treasuryAccount: "t" }) });
    await expect(initialBuyFor({ launcher: "l", agent: "a", agentMint: "m" }, CFG)).rejects.toThrow(/slippage/);
    setInitialBuyBuilder(null);
  });
});
