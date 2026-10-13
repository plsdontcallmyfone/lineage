import { describe, expect, test } from "bun:test";
import { burnChart, burnTable, burnTiles, devBody, devChart, noBurns } from "../src/pages/analytics-supply-burns.ts";

// Burns over time and the developer wallet (Supply section): the honest empty state, the dollars of a
// burn's own time or none, who signed, and the developer wallet's own movements.

const DEV = "6UhUBoVpywefyPoMtQEuwngkPjzFRork4L3dgCVr4jh3";
const o = (burned: Record<string, unknown> = {}, developer: Record<string, unknown> | null = {}) => ({
  ok: true, usd: { ok: true, usd: 0.00025 }, initial_supply: 1_000_000_000,
  burned: { raw: "28588231366686", amount: 28_588_231.37, indexed_events: 4, first_at: 1_791_849_282, last_at: 1_791_896_732, by_signer: [{ label: "Developer wallet", events: 3 }, { label: "Other wallets", events: 1 }], ...burned },
  developer: developer === null ? null : { wallet: DEV, balance: 0, balance_usd: 0, share: 0, burned: { events: 3, amount: 28_588_231.37, raw: "28588231366686", share_of_initial: 0.028588231, usd_at_burn: null }, ...developer },
});
const NONE = { raw: "0", amount: 0, indexed_events: 0, first_at: null, last_at: null, by_signer: [] };

describe("burns over time", () => {
  test("no burn yet: plain words, no chart, no zero dressed as data", () => {
    const ov = o(NONE, { burned: { events: 0, amount: 0, raw: "0", share_of_initial: 0, usd_at_burn: 0 } });
    expect(noBurns(ov, "all")).toBe("Nothing has been burned yet. The supply is still the 1,000,000,000 UNITS the coin was created with.");
    const b = { count: 0, events: [], days: [], signers: { all: 0 } };
    expect(burnTable(ov, b, "all").s).toBe(`<p class="an-line">${noBurns(ov, "all")}</p>`);
    // the chart's own empty text is the same sentence (the page does not mount a chart at all without a day to draw)
    const spec = burnChart(ov, b, "all").build("amount");
    expect(spec.kind === "time" && spec.empty).toBe(noBurns(ov, "all"));
    expect(spec.kind === "time" && spec.series.every((s) => s.points.length === 0)).toBe(true);
    const t = burnTiles(ov, null).s;
    expect(t).toContain("The developer wallet has not burned any of its coins.");
    expect(t).toContain("none yet");
    expect(t).toContain("none on record");
  });

  test("a filter with nothing in it says whose burns are missing", () => {
    expect(noBurns(o(), "developer")).toBe("The developer wallet has not burned any UNITS so far.");
    expect(noBurns(o(), "fee_keeper")).toBe("The fee keeper has not burned any UNITS so far.");
    expect(noBurns(o(), "agent_pool")).toBe("No agent pool has burned UNITS so far.");
  });

  test("the developer tile: amount, share of created supply, dollars only at the price of the time", () => {
    const t = burnTiles(o(), { ok: true, transactions: 32 }).s;
    expect(t).toContain("28.59M UNITS");
    expect(t).toContain("2.86% of created");
    expect(t).toContain("28,588,231 UNITS; no dollar price of UNITS is on record for the time of some of these burns, in 3 transactions it signed");
    expect(t).toContain("Developer wallet 3, Other wallets 1");
    const priced = burnTiles(o({}, { burned: { events: 1, amount: 4_595_544, raw: "4595544000000", share_of_initial: 0.0045955, usd_at_burn: 1108.4 } }), null).s;
    expect(priced).toContain("$1.1K");
    expect(priced).toContain("own time, in 1 transaction it signed");
    expect(burnTiles(o({}, null), null).s).toContain("No developer wallet is set on this instance.");
  });

  test("the table: time, dollars of the time or none, who signed, a Solscan link", () => {
    const b = { count: 3, signers: { all: 3 }, days: [], events: [
      { signature: "SigA", time: 1_791_896_732, amount: 4_595_544, usd: 1108.4, signer: { kind: "developer", label: "Developer wallet", address: DEV }, via_label: null },
      { signature: "SigB", time: 1_791_895_000, amount: 105.31, usd: null, signer: { kind: "address", label: "7NNz…a6KL", address: "7NNz1111111111111111111111111111111111a6KL" }, via_label: "registry program" },
      { signature: "SigC", time: 1_791_894_000, amount: 9, usd: 0.002, signer: { kind: "agent_pool", label: "Agent pool karpathy/minbpe", address: "Pool111111111111111111111111111111111111111" }, via_label: "launch program" },
    ] };
    const s = burnTable(o(), b, "all").s;
    expect(s).toContain("<b>$1,108</b><em>4,595,544 UNITS</em>");
    expect(s).toContain("<b>105.31 UNITS</b><em>no dollar price on record then</em>");
    expect(s).toContain(">Developer wallet</a>");
    expect(s).toContain(">7NNz…a6KL</a>");
    expect(s).toContain(">Agent pool karpathy/minbpe</a>");
    expect(s).toContain("through the registry program, ");
    expect(s).toContain('href="https://solscan.io/tx/SigA"');
    expect(burnTable(o(), { ...b, count: 240 }, "all").s).toContain("The 3 most recent of 240.");
  });

  test("the chart: a bar per UTC day and the running total; dollars offered only when every day has them", () => {
    const days = [{ t: 1_791_763_200, amount: 17_438_543, usd: null, events: 1, cumulative: 17_438_543 }, { t: 1_791_849_600, amount: 11_149_793, usd: 2000, events: 3, cumulative: 28_588_336 }];
    const c = burnChart(o(), { days }, "all");
    expect(c.variants).toBeUndefined();
    const spec = c.build("usd");
    if (spec.kind !== "time") throw new Error("a time chart");
    expect(spec.series.map((s) => [s.kind, s.pane, s.points.map((p) => p.v)])).toEqual([["columns", 0, [17_438_543, 11_149_793]], ["line", 1, [17_438_543, 28_588_336]]]);
    expect(spec.note?.(1_791_849_600_000)).toBe("3 burn transactions");
    const priced = burnChart(o(), { days: days.map((d) => ({ ...d, usd: 1000 })) }, "all");
    expect(priced.variants).toEqual([["amount", "UNITS"], ["usd", "US dollars"]]);
    const usd = priced.build("usd");
    expect(usd.kind === "time" && usd.series[1]!.points.map((p) => p.v)).toEqual([1000, 2000]);
  });
});

describe("the developer wallet", () => {
  const d = { ok: true, wallet: DEV, synced: true, transactions: 32,
    activity: { bought: { count: 5, amount: 58_647_189, usd_at_time: null }, sold: { count: 0, amount: 0, usd_at_time: 0 }, received: { count: 7, amount: 392_124, usd_at_time: 97.5 },
      sent: { count: 3, amount: 30_451_081, usd_at_time: null }, burned: { count: 3, amount: 28_588_231, usd_at_time: null } },
    history: [{ time: 100, balance: 5 }, { time: 100, balance: 7 }, { time: 160, balance: 0 }, { time: null, balance: 3 }],
    moves: [{ signature: "SigA", time: 1_791_896_732, kind: "burned", amount: 4_595_544, usd: 1108.4 }] };

  test("says plainly whose wallet it is, and lists what it bought, sold, sent, received and burned", () => {
    const s = devBody(d).s;
    expect(s).toContain("is the project's developer wallet, and the admin of the network's programs.");
    expect(s).toContain(`href="https://solscan.io/account/${DEV}"`);
    expect(s).toContain('data-move="bought"');
    expect(s).toContain("5 transactions");
    expect(s).toContain("<b>58,647,189 UNITS</b><em>no dollar price on record then</em>");
    expect(s).toContain('data-move="sold" class="sup-zero"');
    expect(s).toContain("<b>none</b>");
    expect(s).toContain("<b>$97.50</b><em>392,124 UNITS</em>");
    expect(s).toContain('href="https://solscan.io/tx/SigA"');
    expect(s).not.toContain("still being read");
    expect(devBody({ ...d, synced: false }).s).toContain("Its history is still being read.");
  });

  test("not set, or not answered: the reason", () => {
    expect(devBody({ ok: false, reason: "no developer wallet is set on this instance" }).s).toContain("no developer wallet is set on this instance.");
    expect(devBody(null).s).toContain("did not answer");
  });

  test("the balance line: one point per instant, the last balance of that second, untimed points left out", () => {
    const spec = devChart(d).build("");
    expect(spec.kind === "time" && spec.series[0]!.points).toEqual([{ t: 100_000, v: 7 }, { t: 160_000, v: 0 }]);
  });
});
