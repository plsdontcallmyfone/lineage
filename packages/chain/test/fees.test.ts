// Priority fees and the mainnet confirmation strategy (M3, SPEC 14.10), against a scripted mock RPC
// and a fake clock: nothing touches a network.
import { afterEach, describe, expect, test } from "bun:test";
import {
  BlockhashExpiredError,
  firstSignature,
  percentile,
  priorityFee,
  sendAndConfirmWire,
  sendWithRebuilds,
  writableAccounts,
} from "../src/fees.ts";
import { Rpc } from "../src/rpc.ts";
import { setDefaultFeePolicy, withProfileFees } from "../src/sender.ts";
import type { ConfirmPolicy, FeePolicy } from "../src/profile.ts";

const RECENT: FeePolicy = { mode: "recent", percentile: 75, floor_micro_lamports: 1, cap_micro_lamports: 200_000 };
const CONFIRM: ConfirmPolicy = { poll_ms: 800, resend_ms: 2000, rebuilds: 1 };

type Call = { method: string; params: unknown[] };
function mockRpc(handlers: Record<string, (params: unknown[], n: number) => unknown>) {
  const calls: Call[] = [];
  const count: Record<string, number> = {};
  const rpc = new Rpc(async (method, params) => {
    calls.push({ method, params });
    count[method] = (count[method] ?? 0) + 1;
    const h = handlers[method];
    if (!h) throw new Error(`unexpected ${method}`);
    const out = h(params, count[method]!);
    // getSignatureStatuses answers { context, value } like the RPC
    return method === "getSignatureStatuses" ? { value: out } : out;
  }, "confirmed");
  return { rpc, calls, count };
}

/** A wire transaction with one signature slot filled with `b`. */
const wireOf = (b: number) => {
  const w = new Uint8Array(1 + 64 + 10);
  w[0] = 1;
  w.fill(b, 1, 65);
  return w;
};

/** A fake clock: sleep advances time instead of waiting. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

describe("priority fee", () => {
  test("percentile is nearest rank", () => {
    expect(percentile([], 75)).toBe(0);
    expect(percentile([5], 75)).toBe(5);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([4, 1, 3, 2], 75)).toBe(3);
    expect(percentile([1, 2, 3, 4], 100)).toBe(4);
  });

  test("fixed (devnet) reads nothing and returns the configured price", async () => {
    const m = mockRpc({});
    expect(await priorityFee(m.rpc, ["a"], { mode: "fixed", cu_price_micro_lamports: 1 })).toEqual({ microLamports: 1, source: "fixed", samples: 0 });
    expect(m.calls.length).toBe(0);
  });

  test("recent: the percentile of getRecentPrioritizationFees over the writable accounts", async () => {
    const m = mockRpc({ getRecentPrioritizationFees: () => [10, 20, 30, 40, 0, 0, 5000, 100].map((f, i) => ({ slot: i, prioritizationFee: f })) });
    const f = await priorityFee(m.rpc, ["w1", "w2"], RECENT);
    expect(f).toEqual({ microLamports: 40, source: "recent", samples: 8 }); // sorted 0,0,10,20,30,40,100,5000: rank 6
    expect(m.calls[0]).toEqual({ method: "getRecentPrioritizationFees", params: [["w1", "w2"]] });
  });

  test("recent: capped by config", async () => {
    const m = mockRpc({ getRecentPrioritizationFees: () => [1e6, 2e6, 3e6, 4e6].map((f, i) => ({ slot: i, prioritizationFee: f })) });
    expect(await priorityFee(m.rpc, ["w"], RECENT)).toEqual({ microLamports: 200_000, source: "recent", samples: 4, cappedFrom: 3e6 });
  });

  test("recent: no samples or all zero gives the floor", async () => {
    const m = mockRpc({ getRecentPrioritizationFees: (_p, n) => (n === 1 ? [] : [{ slot: 1, prioritizationFee: 0 }]) });
    expect(await priorityFee(m.rpc, ["w"], RECENT)).toEqual({ microLamports: 1, source: "floor", samples: 0 });
    expect(await priorityFee(m.rpc, ["w"], RECENT)).toEqual({ microLamports: 1, source: "floor", samples: 1 });
  });

  test("writable accounts: payer first, deduplicated, read-only left out, at most 128", () => {
    const ixs = [
      { programId: "P", keys: [{ pubkey: "a", isSigner: false, isWritable: true }, { pubkey: "r", isSigner: false, isWritable: false }], data: new Uint8Array() },
      { programId: "P", keys: [{ pubkey: "a", isSigner: false, isWritable: true }, { pubkey: "b", isSigner: true, isWritable: true }], data: new Uint8Array() },
    ];
    expect(writableAccounts(ixs, "payer")).toEqual(["payer", "a", "b"]);
    const many = [{ programId: "P", keys: Array.from({ length: 200 }, (_, i) => ({ pubkey: `k${i}`, isSigner: false, isWritable: true })), data: new Uint8Array() }];
    expect(writableAccounts(many).length).toBe(128);
  });
});

describe("server sends follow the profile's fee policy", () => {
  afterEach(() => setDefaultFeePolicy(null));
  const ixs = [{ programId: "P", keys: [{ pubkey: "w", isSigner: false, isWritable: true }], data: new Uint8Array() }];

  test("devnet (no default policy): options unchanged, no RPC read", async () => {
    const m = mockRpc({});
    const o = { computeUnits: 100 };
    expect(await withProfileFees(m.rpc, "payer", ixs, o)).toBe(o);
    expect(m.calls.length).toBe(0);
  });

  test("mainnet: the recent-fee price is added, the caller's own price wins", async () => {
    setDefaultFeePolicy(RECENT as Extract<FeePolicy, { mode: "recent" }>, CONFIRM);
    const m = mockRpc({ getRecentPrioritizationFees: () => [{ slot: 1, prioritizationFee: 1234 }] });
    expect(await withProfileFees(m.rpc, "payer", ixs, {})).toEqual({ priorityMicroLamports: 1234, rebroadcastMs: 2000 });
    expect(m.calls[0]!.params).toEqual([["payer", "w"]]);
    expect(await withProfileFees(m.rpc, "payer", ixs, { priorityMicroLamports: 7 })).toEqual({ priorityMicroLamports: 7 });
  });
});

describe("confirmation strategy", () => {
  test("first send with preflight, resends of the same bytes without, until confirmed", async () => {
    const c = clock();
    const sends: unknown[] = [];
    const m = mockRpc({
      sendTransaction: (p) => (sends.push(p), "sig"),
      getSignatureStatuses: (_p, n) => [n < 7 ? null : { slot: 99, err: null, confirmationStatus: "confirmed" }],
      getBlockHeight: () => 100,
      getTransaction: () => ({ slot: 99, meta: { err: null, fee: 5000, logMessages: ["ok"] } }),
    });
    const w = wireOf(7);
    const r = await sendAndConfirmWire(m.rpc, w, 150, CONFIRM, c);
    expect(r).toMatchObject({ signature: firstSignature(w), slot: 99, fee: 5000, err: null, logs: ["ok"] });
    // polls every 800 ms, resends every 2000 ms: sent at 0, then at 2400 and 4800 (6 polls before the confirming one)
    expect(sends.length).toBe(3);
    expect(r.sends).toBe(3);
    const opts = sends.map((s) => (s as [string, { skipPreflight: boolean; maxRetries: number }])[1]);
    expect(opts[0]).toMatchObject({ skipPreflight: false, maxRetries: 0 });
    expect(opts.slice(1).every((o) => o.skipPreflight === true && o.maxRetries === 0)).toBe(true);
    expect(new Set(sends.map((s) => (s as [string])[0])).size).toBe(1);
  });

  test("a transaction that lands with an error is returned, never resent", async () => {
    const c = clock();
    const m = mockRpc({
      sendTransaction: () => "sig",
      getSignatureStatuses: () => [{ slot: 5, err: { InstructionError: [0, "Custom"] }, confirmationStatus: "processed" }],
      getTransaction: () => ({ slot: 5, meta: { err: {}, fee: 5000, logMessages: ["fail"] } }),
    });
    const r = await sendAndConfirmWire(m.rpc, wireOf(1), 150, CONFIRM, c);
    expect(r.err).toEqual({ InstructionError: [0, "Custom"] });
    expect(m.count.sendTransaction).toBe(1);
  });

  test("blockhash expiry: one last look, then BlockhashExpiredError (safe to rebuild)", async () => {
    const c = clock();
    let height = 140;
    const m = mockRpc({
      sendTransaction: () => "sig",
      getSignatureStatuses: () => [null],
      getBlockHeight: () => (height += 3),
    });
    await expect(sendAndConfirmWire(m.rpc, wireOf(2), 150, CONFIRM, c)).rejects.toBeInstanceOf(BlockhashExpiredError);
    // 140 -> 143, 146, 149, 152 (> 150): a final status read after the height passed
    expect(m.count.getBlockHeight).toBe(4);
    expect(m.count.getSignatureStatuses).toBe(5);
  });

  test("seen in the last blocks after expiry: keeps polling until it confirms", async () => {
    const c = clock();
    const m = mockRpc({
      sendTransaction: () => "sig",
      getSignatureStatuses: (_p, n) => [n === 1 ? null : n === 2 ? { slot: 9, err: null, confirmationStatus: "processed" } : { slot: 9, err: null, confirmationStatus: "confirmed" }],
      getBlockHeight: () => 200,
      getTransaction: () => null,
    });
    const r = await sendAndConfirmWire(m.rpc, wireOf(3), 150, CONFIRM, c);
    expect(r).toMatchObject({ slot: 9, err: null, logs: [] });
  });

  test("rebuilds: expiry signs again with a fresh blockhash, at most confirm.rebuilds times", async () => {
    const c = clock();
    let attempt = 0;
    const m = mockRpc({
      sendTransaction: () => "sig",
      // the first wire never lands; the second confirms
      getSignatureStatuses: (p) => [((p[0] as string[])[0] === firstSignature(wireOf(20)) ? { slot: 1, err: null, confirmationStatus: "confirmed" } : null)],
      getBlockHeight: () => 1_000,
      getTransaction: () => null,
    });
    const statuses: string[] = [];
    const r = await sendWithRebuilds(m.rpc, async (n) => (attempt++, { wire: wireOf(10 + n * 10), lastValidBlockHeight: 150 }), CONFIRM, { ...c, onStatus: (s) => statuses.push(s) });
    expect(attempt).toBe(2);
    expect(r.signature).toBe(firstSignature(wireOf(20)));
    expect(statuses.some((s) => s.includes("fresh blockhash (1 of 1)"))).toBe(true);
  });

  test("rebuilds 0 (devnet policy) reports the expiry", async () => {
    const c = clock();
    const m = mockRpc({ sendTransaction: () => "sig", getSignatureStatuses: () => [null], getBlockHeight: () => 1_000 });
    await expect(sendWithRebuilds(m.rpc, async () => ({ wire: wireOf(4), lastValidBlockHeight: 150 }), { ...CONFIRM, rebuilds: 0 }, c)).rejects.toThrow(/blockhash expired/);
  });

  test("other errors are not retried", async () => {
    const c = clock();
    const m = mockRpc({ sendTransaction: () => { throw new Error("preflight: insufficient funds"); } });
    let n = 0;
    await expect(sendWithRebuilds(m.rpc, async () => (n++, { wire: wireOf(5), lastValidBlockHeight: 150 }), CONFIRM, c)).rejects.toThrow(/insufficient funds/);
    expect(n).toBe(1);
  });
});
