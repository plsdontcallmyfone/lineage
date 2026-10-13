// Launch fronting (docs/plans/LAUNCH-FRONTING.md): the wizard's cost lines, computed without a
// simulation (packages/chain/src/launch-costs.ts), and the venue buy hook (amount and slippage bound
// checked against Core's config).
import { describe, expect, test } from "bun:test";
import { launchSolCosts, launchUnitsCosts, maxBuyInput, parsePrepayConfig } from "../../../packages/chain/src/browser/index.ts";
import { costBreakdown, fundingBlocked, fundingSummary, initialBuyFor, setInitialBuyBuilder } from "../wallet/fronting.ts";

const CFG = parsePrepayConfig({ min_usd: "10", default_usd: "10", line_per_usd: "20", rate_status: "test", compute_price_line_per_usd: "20",
  compute_price_line_per_sandbox_s: "0.002", sandbox_reserve_s: 600, attempt_max_usd: 0.5, since: 0 });

describe("Funding and Review without a simulation (owner 2026-10-12)", () => {
  const costs = launchSolCosts({ creation: 25_000_000n, credits: 1_000_000n, buy: 2_000_000n, identity: 30_000_000n, headroom: 30_000n });
  test("Launch disabled reasons: no SOL price first, then a failed read, then balance; nothing while the prices are being read", () => {
    expect(fundingBlocked({ costs, solUsd: null, solBalance: 10n ** 12n })).toBe("no SOL price");
    expect(fundingBlocked({ costs: null, solUsd: 112, solBalance: 10n ** 12n, why: "the server did not answer" })).toBe("the server did not answer");
    expect(fundingBlocked({ costs: null, solUsd: 112, solBalance: 10n ** 12n, pending: true })).toBeNull();
    expect(fundingBlocked({ costs: null, solUsd: 112, solBalance: 10n ** 12n })).toBe("the prices are not read yet");
    expect(fundingBlocked({ costs, solUsd: 112, solBalance: 1n })).toMatch(/the wallet holds/);
    expect(fundingBlocked({ costs, solUsd: 112, solBalance: 10n ** 12n })).toBeNull();
  });
  test("no simulation wording in any state, and no warning while the prices are read", () => {
    const base = { costs: null, creditsUsd: "10", bps: 100, identityChosen: false, solUsd: 100, solBalance: 10n ** 12n, txCount: null, blocked: null, devnet: false, docs: "/docs/x" };
    const reading = fundingSummary({ ...base, pending: true }).s;
    expect(reading).toContain("reading prices");
    expect(reading).not.toContain("data-fronting-short");
    const failed = fundingSummary({ ...base, pending: false, blocked: "the server or the chain did not answer within 25 seconds", retry: true }).s;
    expect(failed).toContain("Launch disabled: the server or the chain did not answer within 25 seconds.");
    expect(failed).toMatch(/data-act="launch-review"[^>]*>Try again</);
    for (const h of [reading, failed, fundingSummary({ ...base, costs, pending: false }).s, costBreakdown({ ...base, pending: true }).s, costBreakdown({ ...base, costs, pending: false }).s]) expect(h).not.toMatch(/simulat/i);
  });
  test("a launch that takes its UNITS from the wallet: no purchase lines, one From your UNITS line, the total is the SOL part, both balances checked", () => {
    const u = launchUnitsCosts({ deposit: 200_000_000n, buy: { quote: 2_178_000_000n, maxIn: 2_199_780_000n } });
    const c2 = launchSolCosts({ creation: 25_000_000n, credits: 0n, buy: null, identity: 30_000_000n, tip: 10_000n, units: u });
    expect(c2.total).toBe(55_010_000n);
    const fmt = (b: bigint) => `${Number(b) / 1e6} UNITS`;
    const v = { costs: c2, creditsUsd: "10", bps: 100, identityChosen: true, solUsd: 100, solBalance: 10n ** 12n, txCount: 2, blocked: null, devnet: false, docs: "/docs/x", pending: false,
      unitsFmt: fmt, unitsUsd: (b: bigint) => Number(b) / 1e6 / 20, unitsName: "UNITS" };
    const h = fundingSummary(v).s;
    expect(h).toContain("Token creation · A units account · Jito tip · From your UNITS");
    expect(h).not.toContain("Model credits ·");
    expect(h).toContain('data-lamports="55010000"');
    expect(h).toContain("0.055 SOL in SOL, plus 2378 UNITS from your wallet");
    expect(h).toContain("2378 UNITS: model credits 200 UNITS, initial buy 1% 2178 UNITS; the wallet must hold 2399.78 UNITS (the buy at its slippage bound)");
    expect(h).toContain("$118.90");
    const r = costBreakdown(v).s;
    expect(r).toContain('data-fronting="From your UNITS"');
    expect(r).not.toContain('data-fronting="Model credits"');
    expect(fundingBlocked({ costs: c2, solUsd: 100, solBalance: 10n ** 12n, unitsBalance: 1_000_000n, unitsFmt: fmt })).toBe("this launch needs 2399.78 UNITS in your wallet; you hold 1 UNITS");
    expect(fundingBlocked({ costs: c2, solUsd: 100, solBalance: 10n ** 12n, unitsBalance: u.needed, unitsFmt: fmt })).toBeNull();
    expect(fundingBlocked({ costs: c2, solUsd: 100, solBalance: 1n, unitsBalance: u.needed, unitsFmt: fmt })).toMatch(/the wallet holds/);
    const short = fundingSummary({ ...v, costs: null, blocked: "This launch needs 2399.78 UNITS ($119.99) in your wallet; you hold 0 UNITS ($0.00). Get UNITS on pump.fun, then press Try again", retry: true,
      getUnitsUrl: "https://pump.fun/coin/GQdEL4MhL4v8bsmMvyBvjh6BdbWqasgkDnJGfaAHpump" }).s;
    expect(short).toContain('href="https://pump.fun/coin/GQdEL4MhL4v8bsmMvyBvjh6BdbWqasgkDnJGfaAHpump"');
    expect(short).toMatch(/data-act="launch-review"[^>]*>Try again</);
    for (const x of [h, r, short]) expect(x).not.toContain("\u2014");
  });
  test("Funding: one total in US dollars with the SOL small, a one-line breakdown with the units account, one short disabled line", () => {
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
    expect(r).toMatch(/data-fronting="A units account"[^]*?<b class="num">\$3\.00<\/b> <span class="dim">0\.03 SOL<\/span>/);
    expect(h).toMatch(/data-fronting-total data-lamports="58000000">\$\d/);
    expect(h).toMatch(/data-fronting-sol>[\d.]+ SOL</);
    // no SOL price: the cost reads "$ unavailable" beside the SOL amount, never a number passing as dollars
    expect(costBreakdown({ ...v, solUsd: null }).s).toMatch(/data-fronting="Total"[^]*?<b class="num">\$ unavailable<\/b> <span class="dim">[\d.]+ SOL/);
    expect(r).toContain("2 transactions signed together, sent in order");
    expect(fundingSummary({ ...v, identityChosen: false }).s).not.toContain("A units account");
    // only a Jupiter quote is labelled as one
    expect(r).not.toContain("quote");
    expect(costBreakdown({ ...v, blocked: null, quoted: true }).s).toContain("a Jupiter quote");
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

describe("Review states the most the wallet can be charged (mainnet proof run 2026-10-13)", () => {
  // a purchase quoted 95,000,000 lamports with a 5% bound: 4,750,000 of room, plus 2,039,280 of rent that comes back
  const c = launchSolCosts({ creation: 25_000_000n, credits: 90_000_000n, buy: 5_000_000n, identity: 0n, tip: 10_000n, headroom: 4_750_000n + 2_039_280n, slippage: 4_750_000n });
  const v = { costs: c, creditsUsd: "10", bps: 100, identityChosen: false, solUsd: 100, solBalance: 10n ** 12n, txCount: 3, blocked: null, devnet: false, docs: "/docs/x", pending: false, unitsName: "UNITS" };
  test("maxCharge is the total plus the purchase's room, without the rent that returns", () => {
    expect(c.total).toBe(120_010_000n);
    expect(c.maxCharge).toBe(124_760_000n);
    expect(c.needed).toBe(126_799_280n);
    expect(() => launchSolCosts({ creation: 1n, credits: 1n, buy: null, identity: 0n, headroom: 1n, slippage: 2n })).toThrow(/slippage room/);
    // callers that give no split keep the conservative figure
    expect(launchSolCosts({ creation: 1n, credits: 1n, buy: null, identity: 0n, headroom: 7n }).maxCharge).toBe(9n);
  });
  test("an At most row in US dollars first, and the approval line states that maximum, not the quote", () => {
    const r = costBreakdown(v).s;
    expect(r).toContain('data-fronting="Maximum" data-lamports="124760000"');
    expect(r).toMatch(/At most<\/span><span class="lz-rv"><b class="num">\$12\.48<\/b> <span class="dim">0\.1248 SOL: the UNITS purchase may cost up to 5% more/);
    expect(r).toMatch(/one signature, for at most \$12\.48<\/b> <span class="dim">0\.1248 SOL; 3 transactions signed together/);
    expect(r).not.toContain("\u2014");
  });
  test("no purchase inside the launch: no At most row, the approval states the total", () => {
    const flat = launchSolCosts({ creation: 25_000_000n, credits: 0n, buy: null, identity: 0n });
    const r = costBreakdown({ ...v, costs: flat }).s;
    expect(r).not.toContain('data-fronting="Maximum"');
    expect(r).toContain("one signature, for at most $2.50");
  });
});
