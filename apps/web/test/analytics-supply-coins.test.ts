import { describe, expect, test } from "bun:test";
import { coinsBody } from "../src/pages/analytics-supply-coins.ts";

// The agent coins table of the Supply section: supply, burned, who holds it, market value in dollars,
// and the totals; a figure the chain has not given says so in words.

const coin = (o: Record<string, unknown> = {}) => ({ mint: "AFixtuZr34wHT5JaMb4hQ2147NZuu32b1FtX9oNeUmLV", symbol: "TEST", name: "Test", agent_name: "Pimnotch", supply: 1_000_000_000, burned: 0, burned_share: 0, burned_agree: true,
  agent_amount: 10_000_000, agent_share: 0.01, pool_amount: 990_000_000, pool_share: 0.99, top_holder: { owner: "Agent11111111111111111111111111111111111111", label: "the agent", share: 0.01 }, market_cap: 5.6e7, market_cap_usd: 13_981, ...o });

describe("agent coins", () => {
  test("a row per coin and the totals", () => {
    const s = coinsBody({ coins: [coin(), coin({ mint: "B", symbol: "MBPE", burned: 2_500_000, burned_share: 0.0025, market_cap_usd: 7_331, supply: 997_500_000 })],
      totals: { coins: 2, supply: 1_997_500_000, burned: 2_500_000, with_burns: 1, market_cap_usd: 21_312 } }).s;
    expect(s).toContain('href="/tokens/AFixtuZr34wHT5JaMb4hQ2147NZuu32b1FtX9oNeUmLV"');
    expect(s).toContain("<b>$TEST</b>");
    expect(s).toContain("$13,981");
    expect(s).toContain("1,000,000,000");
    expect(s).toContain("2,500,000<div class=\"an-sub\">0.25% of created</div>");
    expect(s).toContain("99.00%");
    expect(s).toContain(">the agent</a>");
    expect(s).toContain("<b>2 coins</b>");
    expect(s).toContain("<b>$21,312</b>");
    expect(s).toContain("1 of 2 coins have had coins burned.");
  });

  test("missing figures are words, never zeros", () => {
    const s = coinsBody({ coins: [coin({ supply: null, burned: null, agent_share: null, pool_share: null, top_holder: null, market_cap: null, market_cap_usd: null })],
      totals: { coins: 1, supply: null, burned: null, with_burns: 0, market_cap_usd: null } }).s;
    expect(s).toContain("no price yet");
    expect(s).toContain("no holder read");
    expect(s.match(/not read/g)!.length).toBe(4);
    expect(s.match(/not summed/g)!.length).toBe(3);
    expect(s).toContain("No agent coin has had coins burned yet.");
    expect(coinsBody({ coins: [coin({ market_cap_usd: null })], totals: { coins: 1, supply: 1, burned: 0, with_burns: 0, market_cap_usd: null } }).s).toContain("$ unavailable");
  });

  test("no coin, or no answer", () => {
    expect(coinsBody({ coins: [], totals: { coins: 0 } }).s).toBe('<p class="an-line">No agent coin has been launched yet.</p>');
    expect(coinsBody(null).s).toContain("did not answer");
  });
});
