import { describe, expect, test } from "bun:test";
import { breakdownCard, burnNote, coinsC, holdersCard, share, supplyShell, supplyTiles } from "../src/pages/analytics-supply.ts";

// The Supply section of Analytics: what the page writes for the indexer's GET /market/supply and
// /market/supply/holders. Dollars lead, the coin amount follows, and a figure that is missing says why.

const USD = { ok: true, usd: 0.00025 };
const overview = (o: Record<string, unknown> = {}) => ({
  ok: true, quote: "UNITS", as_of: 1_791_897_625, usd: USD, initial_supply: 1_000_000_000, supply: 933_093_236.584125, supply_usd: 233_273.3, mint_authority: null,
  burned: { amount: 66_906_763.415875, raw: "66906763415875", share_of_initial: 0.066906763, indexed_events: 5, unmatched: 0, agree: true, state: "agree", usd_at_burn: null },
  breakdown: [
    { key: "liquidity_pool", label: "Liquidity pool", what: "w", accounts: 1, amount: 89_440_050.9, share: 0.0958, usd: 22_360 },
    { key: "wallets", label: "Held by wallets", what: "w", accounts: 495, amount: 837_568_015.6, share: 0.8976, usd: 209_392 },
    { key: "developer_wallet", label: "Developer wallet", what: "w", accounts: 0, amount: 0, share: 0, usd: 0 },
  ],
  breakdown_reason: null, holders: { wallets: 493, token_accounts: 1478, top10_share: 0.2766, top10_wallets_share: 0.1923 }, ...o,
});

describe("Supply section", () => {
  test("the frame carries the anchor /analytics#supply lands on", () => {
    expect(supplyShell().s).toContain('id="supply"');
  });

  test("shares and short amounts", () => {
    expect(share(0.066906763)).toBe("6.69%");
    expect(share(0.00044)).toBe("0.044%");
    expect(share(0)).toBe("0%");
    expect(share(1e-9)).toBe("under 0.001%");
    expect(share(null)).toBe("not read");
    expect(coinsC(66_906_763.4)).toBe("66.91M UNITS");
    expect(coinsC(105.31)).toBe("105.31 UNITS");
  });

  test("tiles: dollars first, the coin amount second; burned has no dollars when the price of the time is not on record", () => {
    const s = supplyTiles(overview()).s;
    expect(s).toContain("$233.3K");
    expect(s).toContain("933,093,237 UNITS of 1,000,000,000 created");
    expect(s).toContain("Nobody can mint more.");
    expect(s).toContain("66.91M UNITS");
    expect(s).toContain("No dollar price of UNITS is on record for the time of some of these burns.");
    expect(s).toContain("equal to the 5 burn transactions on record");
    expect(s).toContain("6.69% of created");
    expect(s).toContain("19.23%");
    expect(s).not.toMatch(/circulating/i);
  });

  test("burned with a dollar figure of its own time leads with dollars", () => {
    const o = overview();
    const s = supplyTiles({ ...o, burned: { ...o.burned, usd_at_burn: 15_432.1 } }).s;
    expect(s).toContain("$15.4K");
    expect(s).toContain("66,906,763 UNITS, in dollars at the price of each burn");
  });

  test("nothing burned: the sentence, and no share chip", () => {
    const s = supplyTiles(overview({ burned: { amount: 0, raw: "0", share_of_initial: 0, indexed_events: 0, unmatched: 0, agree: true, state: "agree", usd_at_burn: 0 } })).s;
    expect(s).toContain("Nothing has been burned: the supply is what the coin was created with.");
    expect(s).toContain("<b>0 UNITS</b>");
    expect(s).not.toContain("of created</span>");
  });

  test("without a dollar reading the money tiles say so; the amounts stay", () => {
    const s = supplyTiles(overview({ usd: { ok: false, reason: "the last USD price reading is too old" }, supply_usd: null })).s;
    expect(s).toContain("$ unavailable");
    expect(s).toContain("933,093,237 UNITS");
  });

  test("the two burn counts not agreeing is said in words", () => {
    const o = overview();
    expect(burnNote(o)).toBe("");
    expect(burnNote({ ...o, burned: { ...o.burned, agree: false, state: "reading", unmatched: 38_318_426.7 } })).toBe("The coin's history is still being read: 38,318,427 UNITS of this is not matched to a burn transaction yet.");
    expect(burnNote({ ...o, burned: { ...o.burned, agree: false, state: "unmatched", unmatched: 12.5 } })).toBe("12.5 UNITS left the supply without a burn transaction in the coin's history.");
  });

  test("where the supply sits: a row per place with dollars, amount and share; a place holding nothing is still listed", () => {
    const s = breakdownCard(overview()).s;
    expect(s).toContain('data-place="liquidity_pool"');
    expect(s).toContain("<b>$22,360</b><em>89,440,051 UNITS</em>");
    expect(s).toContain("9.58%");
    expect(s).toContain('data-place="developer_wallet" class="sup-zero"');
    expect(s).toContain("1,478 accounts");
    const none = breakdownCard(overview({ breakdown: null, holders: null, breakdown_reason: "the RPC of this instance does not list the coin's token accounts" })).s;
    expect(none).toContain("token accounts. The supply and the burns above do not depend on it.");
    expect(none).not.toContain("an-split-l");
  });

  test("top holders: program accounts by name, the developer wallet named, wallets as short addresses linked to Solscan", () => {
    const h = { ok: true, wallets: 493, concentration: { top10_share: 0.2766, top10_wallets_share: 0.1923 }, top: [
      { rank: 1, kind: "liquidity_pool", owner: null, label: "Liquidity pool", accounts: 1, amount: 89_440_050.9, share: 0.0958, usd: 22_360 },
      { rank: 2, kind: "wallets", owner: "AjkT1111111111111111111111111111111111m4qi", label: "AjkT…m4qi", accounts: 2, amount: 30_799_913, share: 0.033, usd: 7_700 },
      { rank: 3, kind: "developer_wallet", owner: "6UhUBoVpywefyPoMtQEuwngkPjzFRork4L3dgCVr4jh3", label: "Developer wallet", accounts: 1, amount: 5, share: 0.000000005, usd: 0.00125 },
    ] };
    const s = holdersCard(h).s;
    expect(s).toContain("<b>Liquidity pool</b>");
    expect(s).toContain('href="https://solscan.io/account/AjkT1111111111111111111111111111111111m4qi"');
    expect(s).toContain("AjkT…m4qi");
    expect(s).toContain("2 accounts");
    expect(s).toContain(">Developer wallet</a>");
    expect(s).toContain("Top 10 wallets: 19.23% of the supply.");
    expect(holdersCard({ ok: false, reason: "the supply has not been read yet", top: [] }).s).toContain("the supply has not been read yet.");
    expect(holdersCard(null).s).toContain("did not answer");
  });
});
