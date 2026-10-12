// The mainnet launch's bundle path with a stubbed block engine (packages/chain/src/jito.ts). The first
// mainnet test launch read "Invalid" 2 s after sendBundle, took it for a refusal and fell back to
// ordered sends, which landed 14 slots apart. Invalid means "not in Jito's system (yet)": it is waited
// out for a bounded time, the chain is asked by signature at every step, and the ordered fallback never
// sends or fails a transaction that a late bundle already put on chain.
import { describe, expect, test } from "bun:test";
import { JITO_INVALID_GRACE_MS, sendInOrder, sendJitoBundle, type SigStatus } from "../src/jito.ts";
import { partsToSend } from "../src/launch-bundle.ts";
import type { Rpc } from "../src/rpc.ts";

const SIGS = ["sigLaunch", "sigFunding"];
const WIRES = ["AA==", "AQ=="];
const ok = (slot: number): SigStatus => ({ slot, err: null, confirmationStatus: "confirmed" });

/** A block engine and a chain on one fake clock: `engine(t)` is the bundle status t ms after sendBundle (null: no answer), `chain(t)` the signature statuses. */
function world(o: { engine: (t: number) => string | null; chain?: (t: number) => (SigStatus | null)[] }) {
  let t = 0;
  const calls: string[] = [];
  const rpc = {
    call: async (m: string) => {
      calls.push(m);
      if (m === "sendBundle") return "b".repeat(64);
      if (m === "getInflightBundleStatuses") {
        const s = o.engine(t);
        if (s === null) throw new Error("HTTP 429");
        return { value: [{ bundle_id: "b".repeat(64), status: s, landed_slot: s === "Landed" ? 4242 : null }] };
      }
      if (m === "getSignatureStatuses") return { value: o.chain ? o.chain(t) : [null, null] };
      throw new Error(`unexpected ${m}`);
    },
  } as unknown as Rpc;
  const status: string[] = [];
  const opts = { signatures: SIGS, sleep: async (ms: number) => void (t += ms), now: () => t, onStatus: (s: string) => void status.push(s) };
  return { rpc, calls, opts, status, at: () => t, sends: () => calls.filter((c) => c === "sendBundle").length, polls: () => calls.filter((c) => c === "getInflightBundleStatuses").length };
}

/** The ordered fallback over a chain stub; counts what it actually sends. */
function ordered(o: { afterBundle: boolean; statuses: (i: number, asked: number) => SigStatus | null; simErr?: (i: number) => unknown; send?: (i: number) => { err: unknown } }) {
  const sent: number[] = [];
  const asked = [0, 0];
  const run = sendInOrder<{ signature: string; slot: number; err: unknown; logs: string[] }>({
    count: 2,
    signature: (i) => SIGS[i]!,
    label: (i) => ["launch + soul", "sol-to-units + initial-buy + credits + tip"][i]!,
    afterBundle: o.afterBundle,
    statuses: async (sigs) => sigs.map((s) => o.statuses(SIGS.indexOf(s), asked[SIGS.indexOf(s)]!++)),
    simulate: async (i) => ({ err: o.simErr?.(i) ?? null, logs: [] }),
    send: async (i) => {
      sent.push(i);
      const r = o.send?.(i) ?? { err: null };
      if (r.err === "throw") throw new Error("Transaction simulation failed: This transaction has already been processed");
      return { signature: SIGS[i]!, slot: 900 + i, err: r.err, logs: [] };
    },
    found: (i, s) => ({ signature: SIGS[i]!, slot: s.slot, err: null, logs: [] }),
  });
  return { run, sent };
}

describe("sendJitoBundle", () => {
  test("lands after two Invalid polls: not a refusal, the bundle is sent once", async () => {
    const w = world({ engine: (t) => (t <= 4_000 ? "Invalid" : "Landed") });
    expect(await sendJitoBundle(w.rpc, WIRES, w.opts)).toEqual({ bundleId: "b".repeat(64), slot: 4242 });
    expect([w.sends(), w.polls(), w.at()]).toEqual([1, 3, 6_000]);
  });

  test("Jito keeps saying Invalid but the transactions are on chain: landed, read from the chain", async () => {
    const w = world({ engine: () => "Invalid", chain: (t) => (t >= 4_000 ? [ok(777), ok(777)] : [null, null]) });
    expect(await sendJitoBundle(w.rpc, WIRES, w.opts)).toEqual({ bundleId: "b".repeat(64), slot: 777 });
    expect(w.at()).toBe(4_000);
  });

  test("no status answer at all (rate limited) is waited out the same way", async () => {
    const w = world({ engine: (t) => (t < 8_000 ? null : "Landed") });
    expect((await sendJitoBundle(w.rpc, WIRES, w.opts)).slot).toBe(4242);
  });

  test("never lands: Invalid is tolerated for the grace time and no longer, then it throws once", async () => {
    const w = world({ engine: () => "Invalid" });
    await expect(sendJitoBundle(w.rpc, WIRES, w.opts)).rejects.toThrow(/still does not know the bundle 16 s after it was sent; none of its transactions is on chain/);
    expect(w.at()).toBeGreaterThanOrEqual(JITO_INVALID_GRACE_MS);
    expect(w.at()).toBeLessThan(JITO_INVALID_GRACE_MS + 2_000);
    expect(w.sends()).toBe(1);
    // the old behaviour gave up at the first poll
    expect(w.polls()).toBe(8);
    // the grace time is a setting
    const quick = world({ engine: () => "Invalid" });
    await expect(sendJitoBundle(quick.rpc, WIRES, { ...quick.opts, invalidGraceMs: 4_000 })).rejects.toThrow(/4 s after/);
  });

  test("Pending is known to Jito: it outlives the grace time and ends at the timeout or when it lands", async () => {
    const lands = world({ engine: (t) => (t < 30_000 ? "Pending" : "Landed") });
    expect((await sendJitoBundle(lands.rpc, WIRES, lands.opts)).slot).toBe(4242);
    expect(lands.status.filter((s) => /pending at Jito/.test(s))).toHaveLength(1);
    const never = world({ engine: () => "Pending" });
    await expect(sendJitoBundle(never.rpc, WIRES, { ...never.opts, timeoutMs: 20_000 })).rejects.toThrow(/has not landed in time/);
    expect(never.at()).toBe(20_000);
  });

  test("Failed throws, unless the chain already holds every transaction (the last word is the chain's)", async () => {
    const f = world({ engine: () => "Failed" });
    await expect(sendJitoBundle(f.rpc, WIRES, f.opts)).rejects.toThrow(/failed; nothing was committed/);
    const w = world({ engine: () => "Failed", chain: () => [ok(5), ok(5)] });
    expect((await sendJitoBundle(w.rpc, WIRES, w.opts)).slot).toBe(5);
    // one of two on chain is not a landed bundle; a transaction that failed on chain is not either
    const half = world({ engine: () => "Invalid", chain: () => [ok(5), null] });
    await expect(sendJitoBundle(half.rpc, WIRES, half.opts)).rejects.toThrow(/still does not know/);
    const bad = world({ engine: () => "Invalid", chain: () => [ok(5), { slot: 5, err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" }] });
    await expect(sendJitoBundle(bad.rpc, WIRES, bad.opts)).rejects.toThrow(/still does not know/);
  });
});

describe("the ordered sends after a bundle that did not land", () => {
  test("never landed: each transaction is sent exactly once, in order", async () => {
    const w = world({ engine: () => "Invalid" });
    await expect(sendJitoBundle(w.rpc, WIRES, w.opts)).rejects.toThrow();
    const o = ordered({ afterBundle: true, statuses: () => null });
    const r = await o.run;
    expect(o.sent).toEqual([0, 1]);
    expect(r.failed).toBeNull();
    expect(r.landed.map((x) => [x.index, x.confirmed.slot])).toEqual([[0, 900], [1, 901]]);
    expect(w.sends()).toBe(1);
  });

  test("the bundle landed while the fallback was being decided: both are found by signature, nothing is sent", async () => {
    const o = ordered({ afterBundle: true, statuses: () => ok(1234) });
    const r = await o.run;
    expect(o.sent).toEqual([]);
    expect(r.failed).toBeNull();
    expect(r.landed.map((x) => x.confirmed.slot)).toEqual([1234, 1234]);
  });

  test("the bundle lands between the look-up and the send: the refused send and the failed simulation are read as landed, not as failures", async () => {
    // transaction 1: not on chain when first asked, the send is refused as already processed, then it is there;
    // transaction 2: not on chain when first asked, its simulation fails (already processed), then it is there
    const o = ordered({ afterBundle: true, statuses: (_i, asked) => (asked === 0 ? null : ok(1300)), send: () => ({ err: "throw" }), simErr: (i) => (i === 1 ? "AlreadyProcessed" : null) });
    const r = await o.run;
    expect(r.failed).toBeNull();
    expect(r.landed.map((x) => [x.index, x.confirmed.slot])).toEqual([[0, 1300], [1, 1300]]);
    expect(o.sent).toEqual([0]);
  });

  test("a real failure is still a failure, with what landed before it", async () => {
    const sim = ordered({ afterBundle: true, statuses: () => null, simErr: (i) => (i === 1 ? { InstructionError: [2, { Custom: 6001 }] } : null) });
    const r = await sim.run;
    expect(sim.sent).toEqual([0]);
    expect(r.landed.map((x) => x.index)).toEqual([0]);
    expect(r.failed).toMatchObject({ index: 1, error: expect.stringMatching(/simulation failed.*not sent/) });
    const send = ordered({ afterBundle: true, statuses: () => null, send: (i) => ({ err: i === 0 ? { InstructionError: [0, "x"] } : null }) });
    expect((await send.run).failed).toMatchObject({ index: 0, error: expect.stringMatching(/failed on chain/) });
    expect(send.sent).toEqual([0]);
    // on chain with an error (the bundle cannot have landed it: bundles are all or nothing, but an earlier ordered send can)
    const errd = ordered({ afterBundle: true, statuses: (i) => (i === 0 ? { slot: 9, err: { InstructionError: [0, "y"] }, confirmationStatus: "finalized" } : null) });
    expect((await errd.run).failed).toMatchObject({ index: 0 });
    expect(errd.sent).toEqual([]);
  });

  test("devnet (no bundle before): nothing is looked up by signature", async () => {
    let asked = 0;
    const o = ordered({ afterBundle: false, statuses: () => (asked++, ok(1)) });
    const r = await o.run;
    expect([o.sent, asked, r.failed]).toEqual([[0, 1], 0, null]);
  });
});

describe("Launch pressed again after a launch that stopped half way", () => {
  const plan = [{ groups: ["launch", "soul"] }, { groups: ["sol-to-units", "initial-buy", "credits", "tip"] }];
  const chain = (done: string[]) => {
    const asked: string[] = [];
    return { asked, onChain: async (g: string) => (asked.push(g), done.includes(g)) };
  };

  test("transaction 1 landed and transaction 2 did not: only transaction 2 is built and signed again", async () => {
    const c = chain(["launch", "soul"]);
    expect(await partsToSend(plan, c.onChain, ["launch", "soul"])).toEqual([plan[1]!]);
    // the SOL purchase and the tip leave no marker: the chain is asked only about what does
    expect(c.asked.sort()).toEqual(["credits", "initial-buy", "launch", "soul"]);
    // a reloaded page state (nothing remembered as landed) decides the same from the chain alone
    expect(await partsToSend(plan, chain(["launch", "soul"]).onChain, [])).toEqual([plan[1]!]);
  });

  test("nothing landed: both; everything landed: nothing is sent; half of transaction 2 on chain does not count as done", async () => {
    expect(await partsToSend(plan, chain([]).onChain, [])).toEqual(plan);
    expect(await partsToSend(plan, chain(["launch", "soul", "initial-buy", "credits"]).onChain, [])).toEqual([]);
    expect(await partsToSend(plan, chain(["launch", "soul", "credits"]).onChain, [])).toEqual([plan[1]!]);
    expect(await partsToSend(plan, chain(["launch"]).onChain, [])).toEqual(plan);
  });

  test("a transaction with no marker on chain (a units account payment alone) is done only when this page saw it land", async () => {
    const three = [...plan, { groups: ["units-account", "tip"] }];
    const all = ["launch", "soul", "initial-buy", "credits"];
    expect(await partsToSend(three, chain(all).onChain, [])).toEqual([three[2]!]);
    expect(await partsToSend(three, chain(all).onChain, ["units-account", "tip"])).toEqual([]);
  });
});

describe("ordered sends without a page simulation (owner 2026-10-12: the launch simulates nothing)", () => {
  const base = (send: (i: number) => Promise<{ signature: string; slot: number; err: unknown; logs: string[] }>, afterBundle = false, statuses: (i: number) => SigStatus | null = () => null) =>
    sendInOrder<{ signature: string; slot: number; err: unknown; logs: string[] }>({
      count: 2,
      signature: (i) => SIGS[i]!,
      label: (i) => ["launch + soul", "sol-to-units + initial-buy + credits + tip"][i]!,
      afterBundle,
      statuses: async (sigs) => sigs.map((s) => statuses(SIGS.indexOf(s))),
      send,
      found: (i, s) => ({ signature: SIGS[i]!, slot: s.slot, err: null, logs: [] }),
    });
  const refused = () => Object.assign(new Error("the network refused this transaction before it was sent ({\"InstructionError\":[3,{\"Custom\":6002}]}); it was not sent and nothing was charged for it"), { unsent: true, logs: ["Program log: TooMuchSolRequired"] });

  test("no simulate callback: both transactions are sent in order", async () => {
    const sent: number[] = [];
    const r = await base(async (i) => (sent.push(i), { signature: SIGS[i]!, slot: 900 + i, err: null, logs: [] }));
    expect(sent).toEqual([0, 1]);
    expect(r.failed).toBeNull();
    expect(r.landed.map((x) => x.label)).toEqual(["launch + soul", "sol-to-units + initial-buy + credits + tip"]);
  });

  test("the node refuses the second transaction at preflight: the first stays landed, the second is reported unsent with the node's logs", async () => {
    const r = await base(async (i) => {
      if (i === 1) throw refused();
      return { signature: SIGS[i]!, slot: 900, err: null, logs: [] };
    });
    expect(r.landed.map((x) => x.index)).toEqual([0]);
    expect(r.failed?.index).toBe(1);
    expect(r.failed?.error).toContain("was not sent and nothing was charged");
    expect(r.failed?.error).not.toContain("failed on chain");
    expect(r.failed?.logs).toEqual(["Program log: TooMuchSolRequired"]);
  });

  test("after a bundle, a refusal of a transaction the late bundle already landed counts as landed, never as failed", async () => {
    const r = await base(async () => { throw refused(); }, true, (i) => (i === 0 ? null : null));
    expect(r.failed?.index).toBe(0);
    let asked = 0;
    const late = await base(async () => { throw refused(); }, true, () => (asked++ >= 1 ? ok(55) : null));
    expect(late.failed).toBeNull();
    expect(late.landed.length).toBe(2);
  });
});
