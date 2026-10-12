import { describe, expect, test } from "bun:test";
import { budgetBeforeSlippage, splitCollected } from "../src/index.ts";

const half = { computeBps: 5000, burnBps: 5000, reserveTarget: 0n, reserveNow: 0n };

describe("split of a collection", () => {
  test("5000 / 5000: the two shares are equal to the lamport; an odd lamport stays in the reserve", () => {
    expect(splitCollected(1_000_000n, half)).toEqual({ net: 1_000_000n, reserve: 0n, compute: 500_000n, burn: 500_000n, dust: 0n });
    expect(splitCollected(1_000_001n, half)).toEqual({ net: 1_000_001n, reserve: 1n, compute: 500_000n, burn: 500_000n, dust: 1n });
    expect(splitCollected(1n, half)).toEqual({ net: 1n, reserve: 1n, compute: 0n, burn: 0n, dust: 1n });
  });
  test("reserve + compute + burn = net for every amount and every split, and no share is rounded up", () => {
    let x = 7n;
    for (let i = 0; i < 4000; i++) {
      x = (x * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
      const net = x % 50_000_000_000n, bps = Number((x >> 20n) % 10_001n), target = (x >> 8n) % 20_000_000n, nowR = (x >> 4n) % 20_000_000n;
      const s = splitCollected(net, { computeBps: bps, burnBps: 10_000 - bps, reserveTarget: target, reserveNow: nowR });
      expect(s.reserve + s.compute + s.burn).toBe(net);
      const rest = net - (s.reserve - s.dust);
      expect(s.compute).toBe((rest * BigInt(bps)) / 10_000n);
      expect(s.burn).toBe((rest * BigInt(10_000 - bps)) / 10_000n);
      expect(s.dust >= 0n && s.dust < 2n).toBe(true);
      expect(s.reserve - s.dust).toBe(target > nowR ? (target - nowR < net ? target - nowR : net) : 0n);
    }
  });
  test("the reserve is refilled to its level first, never past it, and never with more than was collected", () => {
    expect(splitCollected(30_000_000n, { ...half, reserveTarget: 10_000_000n, reserveNow: 4_000_000n })).toEqual({ net: 30_000_000n, reserve: 6_000_000n, compute: 12_000_000n, burn: 12_000_000n, dust: 0n });
    expect(splitCollected(30_000_000n, { ...half, reserveTarget: 10_000_000n, reserveNow: 10_000_000n }).reserve).toBe(0n);
    expect(splitCollected(30_000_000n, { ...half, reserveTarget: 10_000_000n, reserveNow: 25_000_000n }).reserve).toBe(0n);
    expect(splitCollected(3_000_000n, { ...half, reserveTarget: 10_000_000n, reserveNow: 0n })).toEqual({ net: 3_000_000n, reserve: 3_000_000n, compute: 0n, burn: 0n, dust: 0n });
  });
  test("nothing or less than nothing collected splits to nothing", () => {
    for (const n of [0n, -5_000n]) expect(splitCollected(n, half)).toEqual({ net: n, reserve: 0n, compute: 0n, burn: 0n, dust: 0n });
  });
  test("other splits follow their basis points; the edges send everything one way", () => {
    expect(splitCollected(10_000n, { ...half, computeBps: 7000, burnBps: 3000 })).toMatchObject({ compute: 7_000n, burn: 3_000n });
    expect(splitCollected(10_001n, { ...half, computeBps: 10_000, burnBps: 0 })).toMatchObject({ compute: 10_001n, burn: 0n, dust: 0n });
    expect(splitCollected(10_001n, { ...half, computeBps: 0, burnBps: 10_000 })).toMatchObject({ compute: 0n, burn: 10_001n });
  });
  test("basis points that do not sum to 10000 are refused", () => {
    expect(() => splitCollected(1n, { ...half, computeBps: 5000, burnBps: 4999 })).toThrow("10000");
    expect(() => splitCollected(1n, { ...half, computeBps: 10_001, burnBps: -1 })).toThrow("10000");
  });
  test("the budget before slippage: paying slippage_bps more than it still fits the budget", () => {
    for (const [b, s] of [[60_000_000n, 100], [3_000_000n, 100], [1_000_003n, 37], [5n, 1000]] as const) {
      const spend = budgetBeforeSlippage(b, s);
      expect((spend * (10_000n + BigInt(s))) / 10_000n <= b).toBe(true);
    }
    expect(budgetBeforeSlippage(60_000_000n, 100)).toBe(59_405_940n);
    expect(budgetBeforeSlippage(60_000_000n, 0)).toBe(60_000_000n);
  });
});
