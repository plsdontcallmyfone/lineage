// signAndSendAll with the bind as an optional, co-signed last part (apps/web/wallet/chain.ts,
// docs/plans/SEAMLESS-BIND.md): one approval, the runtime's signature fetched before anything is sent,
// and a bind that cannot be had or fails never fails or delays the launch's own transactions.
// The wallet, the RPC behind /chain/rpc and the co-signer are stand-ins; the messages and signatures are real.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateAgentKey } from "@units/protocol";
import { base58Encode } from "@units/protocol";
import { signBytes, system } from "@units/chain";
import { decodeMessage, missingSigners, parseWire, placeSignature } from "../../../packages/chain/src/browser/wire.ts";
import { cosign } from "../../../packages/chain/src/cosign.ts";
import { checkBindTx } from "../../../packages/runtime/src/bind.ts";
import { BIND_LABEL, bindPart, keepSignedBind, takeSignedBind } from "../wallet/bind-plan.ts";

const owner = generateAgentKey(), agent = generateAgentKey(), runtime = generateAgentKey(), other = generateAgentKey();
const LIGHTHOUSE = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
type Chain = typeof import("../wallet/chain.ts");
let C: Chain;
const realFetch = globalThis.fetch;
const hadWindow = "window" in globalThis;

/** What the stand-in chain saw and how it answers. */
const net = { sent: [] as string[], refuse: new Set<string>(), labels: new Map<string, string>() };
const rpcResult = (method: string, params: any[]): unknown => {
  switch (method) {
    case "getGenesisHash": return C.NET.p.genesis;
    case "getLatestBlockhash": return { value: { blockhash: base58Encode(new Uint8Array(32).fill(7)), lastValidBlockHeight: 100 } };
    case "getRecentPrioritizationFees": return [];
    case "getBlockHeight": return 1;
    case "getTransaction": return null;
    case "getSignatureStatuses": return { value: (params[0] as string[]).map((s) => (net.sent.includes(s) ? { slot: 5, err: null, confirmationStatus: "confirmed" } : null)) };
    case "sendTransaction": {
      const wire = new Uint8Array(Buffer.from(params[0], "base64"));
      const sig = base58Encode(parseWire(wire).signatures[0]!);
      const programs = decodeMessage(parseWire(wire).message).instructions.map((i) => i.programId);
      if ([...net.refuse].some((p) => programs.includes(p))) throw { code: -32002, message: "preflight", data: { err: "Custom(1)", logs: [] } };
      if (!net.sent.includes(sig)) net.sent.push(sig);
      return sig;
    }
    default: throw { code: -32601, message: `${method} is not served here` }; // sendBundle and friends: the bundle is not taken, ordered sends follow
  }
};

beforeAll(async () => {
  if (!hadWindow) (globalThis as any).window = globalThis;
  globalThis.fetch = (async (url: any, init?: any) => {
    if (String(url) !== "/chain/rpc") return new Response("{}", { status: 500 });
    const q = JSON.parse(init.body);
    try {
      return Response.json({ jsonrpc: "2.0", id: q.id, result: rpcResult(q.method, q.params) });
    } catch (e) {
      return Response.json({ jsonrpc: "2.0", id: q.id, error: e });
    }
  }) as any;
  // its own instance of the module: the page transport keeps the fetch it was created with, and another test file may have loaded it first
  C = (await import("../wallet/chain.ts?bind-bundle" as string)) as Chain;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  if (!hadWindow) delete (globalThis as any).window;
});

const sign = (wire: Uint8Array) => placeSignature(wire, owner.id, signBytes(owner, parseWire(wire).message));
/** A wallet that approves everything in one request, counting the requests. */
function wallet(o: { batch?: () => never; one?: (wire: Uint8Array, i: number) => Uint8Array } = {}) {
  const requests: number[] = [];
  let n = 0;
  const w: any = {
    name: "test",
    requests,
    features: {
      "standard:connect": { connect: async () => ({ accounts: [account] }) },
      "solana:signTransaction": {
        signTransaction: async (...inputs: { transaction: Uint8Array }[]) => {
          requests.push(inputs.length);
          if (inputs.length > 1 && o.batch) o.batch();
          return inputs.map((i) => ({ signedTransaction: inputs.length === 1 && o.one ? o.one(i.transaction, n++) : sign(i.transaction) }));
        },
      },
    },
  };
  return w;
}
const account: any = { address: owner.id, publicKey: new Uint8Array(32), chains: ["solana:mainnet"] };
const launchParts = () => [
  { ixs: [system.transfer(owner.id, other.id, 1n)], units: 1000, price: 1, label: "launch" },
  { ixs: [system.transfer(owner.id, other.id, 2n)], units: 1000, price: 1, label: "credits" },
];
const bind = (cosigner: (agent: string, wire: Uint8Array) => Promise<Uint8Array>) => ({ ...bindPart({ owner: owner.id, agent: agent.id, newKey: runtime.id, cosign: cosigner }), price: 1 });
const run = (w: any, parts: any[]) => {
  net.sent = [];
  return C.signAndSendAll({ wallet: w, account, parts });
};

describe("the launch's approval with the bind in it", () => {
  test("one request to the wallet for every transaction; the runtime co-signs what the wallet signed; all of it lands", async () => {
    const w = wallet();
    const seen: Uint8Array[] = [];
    const r = await run(w, [...launchParts(), bind(async (a, wire) => (expect(a).toBe(agent.id), seen.push(wire), checkBindTx(wire, runtime.id, agent.id), cosign(wire, runtime)))]);
    expect(w.requests).toEqual([3]);
    expect(seen).toHaveLength(1);
    expect(missingSigners(seen[0]!)).toEqual([runtime.id]);
    expect(r.failed).toBeNull();
    expect(r.left).toEqual([]);
    expect(r.landed.map((x) => x.label)).toEqual(["launch", "credits", BIND_LABEL]);
    expect(net.sent).toHaveLength(3);
  }, 30_000);

  test("the runtime does not answer: the launch goes out without the bind, and the wallet-signed bind is kept for sending after it", async () => {
    const w = wallet();
    const r = await run(w, [...launchParts(), bind(async () => { throw new Error("the hosted runtime answered HTTP 503."); })]);
    expect(w.requests).toEqual([3]);
    expect(r.failed).toBeNull();
    expect(r.landed.map((x) => x.label)).toEqual(["launch", "credits"]);
    expect(r.left).toHaveLength(1);
    expect(r.left[0]).toMatchObject({ label: BIND_LABEL, why: "the hosted runtime answered HTTP 503", lastValidBlockHeight: 100 });
    // what is kept is exactly what the runtime's sender accepts: no second approval is needed while the blockhash lives
    expect(keepSignedBind(agent.id, runtime.id, r.left)).toBe("the hosted runtime answered HTTP 503");
    const kept = takeSignedBind(agent.id, runtime.id)!;
    expect(checkBindTx(kept.wire, runtime.id, agent.id).length).toBeGreaterThan(0);
    expect(missingSigners(cosign(kept.wire, runtime))).toEqual([]);
  }, 30_000);

  test("held back (a full mainnet bundle): signed in the same request, never sent from the page, kept", async () => {
    const w = wallet();
    let asked = 0;
    const r = await run(w, [...launchParts(), { ...bind(async () => (asked++, new Uint8Array())), cosign: undefined, hold: true }]);
    expect(w.requests).toEqual([3]);
    expect(asked).toBe(0);
    expect(r.landed.map((x) => x.label)).toEqual(["launch", "credits"]);
    expect(r.left[0]!.partial && missingSigners(r.left[0]!.partial)).toEqual([runtime.id]);
  }, 30_000);

  test("a co-signer that hands back another transaction is not believed", async () => {
    const r = await run(wallet(), [...launchParts(), bind(async () => sign(new Uint8Array(parseWire(await otherWire()).message.length ? await otherWire() : [])))]);
    expect(r.landed.map((x) => x.label)).toEqual(["launch", "credits"]);
    expect(r.left[0]!.why).toMatch(/another transaction/);
  }, 30_000);

  test("the wallet adds its own guard instruction to the bind: accepted, co-signed with it; anything else added: left out, nothing of it kept", async () => {
    const { compileMessage, computeBudget } = await import("@units/chain");
    const rebuilt = (wire: Uint8Array, extra: any) => {
      const m = decodeMessage(parseWire(wire).message);
      const ixs = m.instructions.map((ix) => ({ programId: ix.programId, keys: ix.accounts, data: ix.data }));
      const out = compileMessage(owner.id, [...ixs, extra], m.blockhash);
      void computeBudget;
      const w2 = new Uint8Array(1 + 64 * out.numSigners + out.bytes.length);
      w2[0] = out.numSigners;
      w2.set(out.bytes, 1 + 64 * out.numSigners);
      return sign(w2);
    };
    const guard = { programId: LIGHTHOUSE, keys: [{ pubkey: owner.id, isSigner: false, isWritable: false }], data: Uint8Array.of(1) };
    const sneak = system.transfer(owner.id, other.id, 5n);
    for (const [extra, ok] of [[guard, true], [sneak, false]] as const) {
      // a wallet that refuses the batch for a reason of its own, then signs one by one and alters only the third
      const w = wallet({ batch: () => { throw new Error("Batch signing is not supported."); }, one: (wire, i) => (i === 2 ? rebuilt(wire, extra) : sign(wire)) });
      let got: Uint8Array | null = null;
      const r = await run(w, [...launchParts(), bind(async (_a, wire) => ((got = wire), checkBindTx(wire, runtime.id, agent.id), cosign(wire, runtime)))]);
      expect(w.requests).toEqual([3, 1, 1, 1]);
      if (ok) {
        expect(r.left).toEqual([]);
        expect(r.landed.map((x) => x.label)).toEqual(["launch", "credits", BIND_LABEL]);
        expect(decodeMessage(parseWire(got!).message).instructions.some((i) => i.programId === LIGHTHOUSE)).toBe(true);
      } else {
        expect(got).toBeNull();
        expect(r.landed.map((x) => x.label)).toEqual(["launch", "credits"]);
        expect(r.left[0]).toMatchObject({ label: BIND_LABEL, partial: null });
        expect(r.left[0]!.why).toMatch(/the wallet changed transaction 3/);
      }
    }
  }, 60_000);

  test("asked one by one, declining only the bind leaves only the bind out; declining a launch transaction stops everything", async () => {
    const decline = () => { throw Object.assign(new Error("User rejected the request."), { code: 4001 }); };
    const w = wallet({ batch: () => { throw new Error("Batch signing is not supported."); }, one: (wire, i) => (i === 2 ? decline() : sign(wire)) });
    const r = await run(w, [...launchParts(), bind(async (_a, wire) => cosign(wire, runtime))]);
    expect(r.landed.map((x) => x.label)).toEqual(["launch", "credits"]);
    expect(r.left).toEqual([{ label: BIND_LABEL, why: "User rejected the request", partial: null, lastValidBlockHeight: 100 }]);
    const w2 = wallet({ batch: () => { throw new Error("Batch signing is not supported."); }, one: (wire, i) => (i === 1 ? decline() : sign(wire)) });
    await expect(run(w2, [...launchParts(), bind(async (_a, wire) => cosign(wire, runtime))])).rejects.toThrow(/rejected/);
    expect(net.sent).toEqual([]);
    // declining the one approval for all of them: nothing is sent either
    const w3 = wallet({ batch: decline });
    await expect(run(w3, [...launchParts(), bind(async (_a, wire) => cosign(wire, runtime))])).rejects.toThrow(/rejected/);
    expect(net.sent).toEqual([]);
  }, 60_000);

  test("a bind the chain refuses does not fail the launch; a launch transaction it refuses still does", async () => {
    const { REGISTRY_PROGRAM_ID } = await import("@units/chain");
    net.refuse = new Set([REGISTRY_PROGRAM_ID]);
    try {
      const r = await run(wallet(), [...launchParts(), bind(async (_a, wire) => cosign(wire, runtime))]);
      expect(r.failed).toBeNull();
      expect(r.landed.map((x) => x.label)).toEqual(["launch", "credits"]);
      expect(r.left).toHaveLength(1);
      expect(r.left[0]!.label).toBe(BIND_LABEL);
      // not optional: reported as the failure it is
      const strict = { ...bind(async (_a, wire) => cosign(wire, runtime)), optional: false };
      const r2 = await run(wallet(), [...launchParts(), strict]);
      expect(r2.failed?.label).toBe(BIND_LABEL);
      expect(r2.left).toEqual([]);
    } finally {
      net.refuse = new Set();
    }
  }, 60_000);
});

async function otherWire(): Promise<Uint8Array> {
  const { compileMessage } = await import("@units/chain");
  const m = compileMessage(owner.id, [system.transfer(owner.id, other.id, 9n)], base58Encode(new Uint8Array(32).fill(7)));
  const w = new Uint8Array(1 + 64 * m.numSigners + m.bytes.length);
  w[0] = m.numSigners;
  w.set(m.bytes, 1 + 64 * m.numSigners);
  return w;
}
