import { describe, expect, test } from "bun:test";
import { tradeDecimals } from "../wallet/decimals.ts";

// Audit A2 OFF-W1: the trade box scales the typed amount by the mint's decimals read from chain,
// never by the decimals a (possibly lying) indexer answer carries.
const mintData = (decimals: number) => {
  const d = new Uint8Array(82);
  d[44] = decimals;
  return d;
};

describe("trade box decimals come from the mint account", () => {
  test("the chain value wins over the indexer's", () => {
    expect(tradeDecimals(mintData(6), 9)).toBe(6);
  });
  test("no mint account or a short one: refuse rather than guess", () => {
    expect(() => tradeDecimals(null, 6)).toThrow(/mint/);
    expect(() => tradeDecimals(new Uint8Array(10), 6)).toThrow(/mint/);
  });
});
