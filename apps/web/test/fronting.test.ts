// Launch fronting (docs/plans/LAUNCH-FRONTING.md): the wizard's cost lines from a launch simulation
// and the venue buy hook (amount and slippage bound checked against Core's config).
import { describe, expect, test } from "bun:test";
import { maxBuyInput, parsePrepayConfig } from "../../../packages/chain/src/browser/index.ts";
import { costsFromSim, initialBuyFor, setInitialBuyBuilder } from "../wallet/fronting.ts";

const tokenData = (amount: bigint) => {
  const d = new Uint8Array(165);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  return d;
};
const acc = (address: string, before: bigint | null, after: bigint | null, dataBefore: Uint8Array | null = null, dataAfter: Uint8Array | null = null) =>
  ({ address, writable: true, signer: false, before, after, owner: null, created: before === null, dataBefore, dataAfter });

const CFG = parsePrepayConfig({ min_usd: "10", default_usd: "10", line_per_usd: "20", rate_status: "test", compute_price_line_per_usd: "20",
  compute_price_line_per_sandbox_s: "0.002", sandbox_reserve_s: 600, attempt_max_usd: 0.5, since: 0 });

describe("costs from the launch simulation", () => {
  const sim = { err: null, logs: [], fee: 15_000n, accounts: [acc("launcher", 1_000_000_000n, 983_000_000n), acc("launcherLine", 3_000_000n, 3_000_000n, tokenData(900_000_000n), tokenData(668_000_000n))] };
  test("creation = launcher SOL change; buy cost = quote spent minus credits", () => {
    const c = costsFromSim({ sim, launcher: "launcher", launcherQuoteAccount: "launcherLine", credits: 200_000_000n,
      buy: { ixs: [], amountOut: 10n ** 13n, quote: 31_500_000n, maxIn: maxBuyInput(31_500_000n, 100), treasuryAccount: "t" } });
    expect(c.creationLamports).toBe(17_000_000n);
    expect(c.buy).toEqual({ amountOut: 10n ** 13n, cost: 32_000_000n, maxIn: 31_815_000n });
    expect(c.quoteSpent).toBe(232_000_000n);
  });
  test("a failed simulation gives no creation figure (launch stays disabled)", () => {
    expect(costsFromSim({ sim: { ...sim, err: { InstructionError: [0, "x"] } }, launcher: "launcher", launcherQuoteAccount: "launcherLine", credits: 1n, buy: null }).creationLamports).toBeNull();
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
