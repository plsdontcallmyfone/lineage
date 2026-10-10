// Launch fronting (docs/plans/LAUNCH-FRONTING.md): the venue-agnostic parts. The config (required
// credits, initial buy bps, slippage bound), the exact 1% amount, the maximum input, the three cost
// lines and the wallet check, and how the planner composes main + buy + soul into one legacy, one v0 or
// exactly two transactions. main and buy are the pump.fun venue's real builders (pump-launch.ts:
// create_v2 + register_pump_launch, and the launcher's buy_v3 delivered to the agent key).
import { describe, expect, test } from "bun:test";
import { generateAgentKey } from "@lineage/protocol";
import * as c from "../src/index.ts";

const k = () => generateAgentKey().id;
const LINE = "3PLqpwWokAbpxZgBVLAzMAeLSvzfoDvjkhH9YydwVXmU";
const T22 = c.TOKEN_2022_PROGRAM;
const budget = [c.computeBudget.limit(450_000), c.computeBudget.price(1)];
const table = () => ({ address: k(), addresses: c.launchTableAddresses({ lineMint: LINE, lineTokenProgram: T22 }) });

const CFG = {
  min_usd: "10", default_usd: "10", line_per_usd: "20", rate_status: "test", compute_price_line_per_usd: "20", compute_price_line_per_sandbox_s: "0.002",
  sandbox_reserve_s: 600, attempt_max_usd: 0.5, since: 0,
};

function launch(o: { strings?: number; soul?: boolean; buy?: boolean } = {}) {
  const launcher = k(), agent = k(), mint = k();
  const base = { name: "TEST fronting", symbol: "TFRONT", uri: "https://lineage.invalid/devnet/agents/tfront.json?class=python", repo: "https://github.com/keis/base58" };
  const used = base.name.length + base.symbol.length + base.uri.length + base.repo.length;
  const pad = Math.max(0, (o.strings ?? used) - used), toUri = Math.min(pad, 200 - base.uri.length);
  const main = c.pumpLaunchMain({ launcher, agent, agentMint: mint, line: { mint: LINE, tokenProgram: T22 }, name: base.name, symbol: base.symbol,
    uri: base.uri + "x".repeat(toUri), args: { repoUrl: base.repo + "x".repeat(pad - toUri), identityMode: 2, hosted: true } });
  const rest = c.launch.prepay({ launcher, agent, agentMint: mint, lineMint: LINE, amount: 200_000_000n, decimals: 6, lineTokenProgram: T22 });
  const buy = o.buy === false ? [] : c.pumpInitialBuy({ launcher, agent, agentMint: mint, lineMint: LINE, amountOut: 10_000_000_000_000n, maxIn: 5_000_000_000n,
    lineTokenProgram: T22 });
  const soul = o.soul ? c.registry.setProfile({ signingKey: agent, agent, digest: new Uint8Array(32).fill(7), seq: 1 }) : null;
  return { launcher, agent, mint, main, rest, buy, soul };
}

describe("fronting config", () => {
  test("defaults: 1% initial buy, 1% slippage bound; required credits are exactly min_usd at the rate", () => {
    const p = c.parsePrepayConfig(CFG);
    expect(p.initial_buy_bps).toBe(100);
    expect(p.initial_buy_slippage_bps).toBe(100);
    expect(c.requiredCredits(p, 6)).toBe(200_000_000n); // 10 USD x 20 tLINE per USD x 10^6
  });
  test("admin values are checked: integers 0 to 10000", () => {
    expect(c.parsePrepayConfig({ ...CFG, initial_buy_bps: 250 }).initial_buy_bps).toBe(250);
    expect(c.parsePrepayConfig({ ...CFG, initial_buy_bps: 0 }).initial_buy_bps).toBe(0);
    expect(() => c.parsePrepayConfig({ ...CFG, initial_buy_bps: 10_001 })).toThrow(/initial_buy_bps/);
    expect(() => c.parsePrepayConfig({ ...CFG, initial_buy_bps: 1.5 })).toThrow(/initial_buy_bps/);
    expect(() => c.parsePrepayConfig({ ...CFG, initial_buy_slippage_bps: -1 })).toThrow(/initial_buy_slippage_bps/);
  });
});

describe("initial buy amount and bound", () => {
  test("exactly 1% of the supply: 100M tokens at 6 decimals give 1,000,000 tokens", () => {
    expect(c.initialBuyAmount(100_000_000_000_000n, 100)).toBe(1_000_000_000_000n);
    // floor, never above the bps
    expect(c.initialBuyAmount(999n, 100)).toBe(9n);
    expect(c.initialBuyAmount(1_000_000_000_000_000n, 100)).toBe(10_000_000_000_000n); // pump.fun: 1B at 6 decimals
    expect(c.initialBuyAmount(123n, 0)).toBe(0n);
    expect(() => c.initialBuyAmount(1n, 10_001)).toThrow();
  });
  test("maximum input: ceil(quote x (1 + slippage)), never below the quote", () => {
    expect(c.maxBuyInput(1_000_000n, 100)).toBe(1_010_000n);
    expect(c.maxBuyInput(1n, 100)).toBe(2n); // rounds up
    expect(c.maxBuyInput(12_345n, 0)).toBe(12_345n);
    for (const q of [1n, 7n, 999_999n, 31_234_567_891n]) for (const s of [0, 1, 50, 100, 500]) {
      const m = c.maxBuyInput(q, s);
      expect(m >= q).toBe(true);
      expect(m * 10_000n >= q * BigInt(10_000 + s)).toBe(true);
      expect((m - 1n) * 10_000n < q * BigInt(10_000 + s)).toBe(true);
    }
  });
});

describe("cost lines and the wallet check", () => {
  const costs = c.frontingCosts({ creationLamports: 15_996_680n, credits: 200_000_000n, buy: { amountOut: 1_000_000_000_000n, cost: 31_000_000n, maxIn: 31_310_000n } });
  test("totals: needed counts the buy's maximum input, spent its simulated cost", () => {
    expect(costs.quoteNeeded).toBe(231_310_000n);
    expect(costs.quoteSpent).toBe(231_000_000n);
  });
  test("launch refused until the wallet covers all of it", () => {
    expect(c.frontingShortfall(costs, 15_996_680n, 231_310_000n)).toBeNull();
    expect(c.frontingShortfall(costs, 15_996_679n, 10n ** 12n)).toMatch(/token creation/);
    expect(c.frontingShortfall(costs, 10n ** 9n, 231_309_999n)).toMatch(/initial buy/);
    expect(c.frontingShortfall(costs, null, 1n)).toMatch(/not read/);
    expect(c.frontingShortfall({ ...costs, creationLamports: null }, 10n ** 9n, 10n ** 12n)).toMatch(/not simulated/);
  });
  test("without a venue buy the total is the credits", () => {
    const x = c.frontingCosts({ creationLamports: 1n, credits: 5n, buy: null });
    expect(x.quoteNeeded).toBe(5n);
    expect(x.quoteSpent).toBe(5n);
  });
});

describe("planner with the pump.fun initial buy", () => {
  // measured (typical strings, both compute budget instructions, the launch table): create_v2 +
  // register_pump_launch 1,016 bytes v0, + the buy 1,200, + deposit and wake 1,262; legacy is over the
  // packet from create + register alone (1,507), so pump.fun launches need a v0 wallet.
  test("typical strings: the buy rides with create + register (anti-snipe), deposit + wake go second", () => {
    const l = launch();
    const p = c.planLaunch({ payer: l.launcher, main: l.main, buy: l.buy, rest: l.rest, soul: null, budget, table: table(), v0: true });
    expect(p.mode).toBe("split");
    expect(p.buyTx).toBe(0);
    expect(p.txs[0]!.ixs).toEqual([...l.main, ...l.buy]);
    expect(p.txs[1]!.ixs).toEqual(l.rest);
    for (const t of p.txs) expect(t.size).toBeLessThanOrEqual(c.PACKET_LIMIT);
  });
  test("typical strings with a soul: still two transactions, never three", () => {
    const l = launch({ soul: true });
    const p = c.planLaunch({ payer: l.launcher, main: l.main, buy: l.buy, rest: l.rest, soul: l.soul, budget, table: table(), v0: true });
    expect(p.txs.length).toBe(2);
    expect(p.buyTx).toBe(0);
    expect(p.txs[1]!.ixs).toEqual([...l.rest, l.soul!]);
  });
  test("strings at MAX_LAUNCH_STRINGS: create + register fill the first transaction, the buy goes second with the rest", () => {
    const l = launch({ strings: c.MAX_LAUNCH_STRINGS, soul: true });
    const p = c.planLaunch({ payer: l.launcher, main: l.main, buy: l.buy, rest: l.rest, soul: l.soul, budget, table: table(), v0: true });
    expect(p.mode).toBe("split");
    expect(p.buyTx).toBe(1);
    expect(p.txs[0]!.ixs).toEqual(l.main);
    expect(p.txs[1]!.ixs).toEqual([...l.buy, ...l.rest, l.soul!]);
    for (const t of p.txs) expect(t.size).toBeLessThanOrEqual(c.PACKET_LIMIT);
  });
  test("a legacy-only wallet: refused with a clear error (pump.fun launches need v0)", () => {
    const l = launch({ soul: true });
    expect(() => c.planLaunch({ payer: l.launcher, main: l.main, buy: l.buy, rest: l.rest, soul: l.soul, budget, table: table(), v0: false })).toThrow(/packet limit/);
  });
  test("no buy: create + register + deposit + wake in one v0 transaction (buyTx null)", () => {
    const l = launch({ buy: false });
    const p = c.planLaunch({ payer: l.launcher, main: l.main, buy: [], rest: l.rest, soul: null, budget, table: table(), v0: true });
    expect(p.buyTx).toBeNull();
    expect(p.txs.length).toBe(1);
    expect(p.txs[0]!.ixs).toEqual([...l.main, ...l.rest]);
  });
  test("the buy delivers to the agent key's token account, after register_pump_launch", () => {
    const l = launch();
    const buy = l.buy.find((x) => x.programId === c.PUMP.program)!;
    expect(buy.keys[9]!.pubkey).toBe(c.ata(l.agent, l.mint, T22));
    expect(buy.keys[8]).toEqual({ pubkey: l.launcher, isSigner: true, isWritable: true });
    expect(l.main[1]!.programId).toBe(c.LAUNCH_PROGRAM_ID);
  });
});
