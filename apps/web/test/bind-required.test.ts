// The required bind and its backup signature in the launch's approval (docs/plans/SEAMLESS-BIND.md
// sections 9 and 10): apps/web/wallet/bind-plan.ts and chain.ts signAndSendAll. Every refusal sends
// nothing. The wallet, the RPC behind /chain/rpc and the runtime are stand-ins; the messages, the
// signatures and the runtime's own checks (checkBindTx with the nonce account) are real.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { base58Encode, generateAgentKey } from "@units/protocol";
import { nonceAccountFor, signBytes, system } from "@units/chain";
import { decodeMessage, missingSigners, parseWire, placeSignature } from "../../../packages/chain/src/browser/wire.ts";
import { cosign } from "../../../packages/chain/src/cosign.ts";
import { isAdvanceOf } from "../../../packages/chain/src/nonce.ts";
import { checkBindTx } from "../../../packages/runtime/src/bind.ts";
import { BACKUP_LABEL, backupPart, BIND_LABEL, BIND_NO_ANSWER, BIND_NO_COSIGN, BIND_NO_KEY, BIND_WAIT_LINE, bindHealth, bindPart, BindUnavailable, cosignRetrying, hasBackup, keepSignedBind, noteBackup, reserveRequired, reserveRuntimeKey, takeSignedBind, withBind } from "../wallet/bind-plan.ts";

const owner = generateAgentKey(), agent = generateAgentKey(), runtime = generateAgentKey(), other = generateAgentKey(), payer = generateAgentKey();
const NONCE = { account: nonceAccountFor(payer.id, runtime.id), value: base58Encode(new Uint8Array(32).fill(9)) };
const LIGHTHOUSE = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
const BLOCKHASH = base58Encode(new Uint8Array(32).fill(7));
type Chain = typeof import("../wallet/chain.ts");
let C: Chain;
const realFetch = globalThis.fetch;
const hadWindow = "window" in globalThis;
const net = { sent: [] as string[], refuse: new Set<string>(), bundle: false, bundles: [] as number[] };
const rpcResult = (method: string, params: any[]): unknown => {
  switch (method) {
    case "getGenesisHash": return C.NET.p.genesis;
    case "getLatestBlockhash": return { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } };
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
    case "sendBundle": {
      if (!net.bundle) throw { code: -32601, message: "sendBundle is not served here" };
      const wires = (params[0] as string[]).map((w) => new Uint8Array(Buffer.from(w, "base64")));
      net.bundles.push(wires.length);
      for (const w of wires) net.sent.push(base58Encode(parseWire(w).signatures[0]!));
      return "bundle1";
    }
    case "getInflightBundleStatuses": return { value: [{ bundle_id: "bundle1", status: "Landed", landed_slot: 5 }] };
    default: throw { code: -32601, message: `${method} is not served here` };
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
  C = (await import("../wallet/chain.ts?bind-required" as string)) as Chain;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  if (!hadWindow) delete (globalThis as any).window;
});

const sign = (wire: Uint8Array) => placeSignature(wire, owner.id, signBytes(owner, parseWire(wire).message));
function wallet(o: { batch?: () => never; one?: (wire: Uint8Array, i: number) => Uint8Array; all?: (wire: Uint8Array, i: number) => Uint8Array } = {}) {
  const requests: number[] = [];
  let n = 0;
  const w: any = {
    name: "test", requests,
    features: {
      "standard:connect": { connect: async () => ({ accounts: [account] }) },
      "solana:signTransaction": {
        signTransaction: async (...inputs: { transaction: Uint8Array }[]) => {
          requests.push(inputs.length);
          if (inputs.length > 1 && o.batch) o.batch();
          return inputs.map((i, k) => ({ signedTransaction: inputs.length === 1 && o.one ? o.one(i.transaction, n++) : o.all ? o.all(i.transaction, k) : sign(i.transaction) }));
        },
      },
    },
  };
  return w;
}
const account: any = { address: owner.id, publicKey: new Uint8Array(32), chains: ["solana:mainnet"] };
const launchParts = (n = 2) => Array.from({ length: n }, (_, i) => ({ ixs: [system.transfer(owner.id, other.id, BigInt(i + 1))], units: 1000, price: 1, label: i ? `part ${i + 1}` : "launch" }));
/** The runtime's co-signer as it really checks: the bind, or the backup over this key's nonce account. */
const runtimeSigns = (seen: Uint8Array[] = []) => async (a: string, wire: Uint8Array) => {
  expect(a).toBe(agent.id);
  checkBindTx(wire, runtime.id, agent.id, NONCE.account);
  seen.push(wire);
  return cosign(wire, runtime);
};
const required = (cosigner: (agent: string, wire: Uint8Array) => Promise<Uint8Array>) => ({ ...bindPart({ owner: owner.id, agent: agent.id, newKey: runtime.id, cosign: cosigner, required: true }), price: 1 });
const backup = (cosigner: (agent: string, wire: Uint8Array) => Promise<Uint8Array>) => backupPart({ owner: owner.id, agent: agent.id, newKey: runtime.id, nonce: NONCE, price: 1, cosign: cosigner });
const run = (w: any, parts: any[]) => {
  net.sent = [];
  net.bundles = [];
  return C.signAndSendAll({ wallet: w, account, parts });
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
};

describe("the reservation is required", () => {
  test("slow, then it answers: waited for, said once in a plain line", async () => {
    const said: string[] = [];
    let n = 0;
    const c = clock();
    const k = await reserveRequired(agent.id, { ...c, say: (l) => void said.push(l), f: async () => (++n < 4 ? json(503, { error: "upstream_unreachable" }) : json(200, { agent: agent.id, new_key: runtime.id, status: "reserved", nonce: NONCE })) });
    expect(k).toEqual({ agent: agent.id, new_key: runtime.id, status: "reserved", nonce: NONCE });
    expect(n).toBe(4);
    expect(said).toEqual([BIND_WAIT_LINE]);
    expect(BIND_WAIT_LINE).toBe("Getting the agent's runtime key…");
  });
  test("it never answers: refused in one sentence after the time it is given, and the fetch that throws counts the same", async () => {
    for (const f of [async () => json(502, {}), async () => { throw new TypeError("network"); }, async () => json(429, { error: "reservations_full" })]) {
      const c = clock();
      let n = 0;
      const e = await reserveRequired(agent.id, { ...c, totalMs: 20_000, f: async () => (n++, f()) }).catch((x) => x);
      expect(e).toBeInstanceOf(BindUnavailable);
      expect(e.message).toBe(BIND_NO_KEY);
      expect(n).toBeGreaterThanOrEqual(8);
      expect(c.now()).toBeLessThanOrEqual(20_000);
    }
    expect(BIND_NO_KEY).toBe("The hosted runtime did not give this agent its key, so the launch was not built. Nothing was signed or sent.");
  });
  test("the check right before the wallet is asked says its own sentence", async () => {
    const e = await reserveRequired(agent.id, { ...clock(), totalMs: 12_000, message: BIND_NO_ANSWER, f: async () => json(503, {}) }).catch((x) => x);
    expect(e.message).toBe("The hosted runtime is not answering, so nothing was signed. Try again.");
  });
  test("a reservation without a nonce account is a key with no backup; a malformed nonce is ignored", async () => {
    expect((await reserveRuntimeKey(agent.id, async () => json(200, { new_key: runtime.id, status: "reserved" })))?.nonce).toBeNull();
    expect((await reserveRuntimeKey(agent.id, async () => json(200, { new_key: runtime.id, status: "reserved", nonce: { account: 1, value: "x" } })))?.nonce).toBeNull();
  });
  test("health: ok or not as the service says, 503 bodies read too, no answer is null", async () => {
    expect(await bindHealth(async () => json(200, { ok: true, backup: { ok: true } }))).toEqual({ ok: true, backup: true });
    expect(await bindHealth(async () => json(503, { ok: false, backup: { ok: false } }))).toEqual({ ok: false, backup: false });
    expect(await bindHealth(async () => json(502, { error: "upstream_unreachable" }))).toBeNull();
    expect(await bindHealth(async () => { throw new TypeError("x"); })).toBeNull();
  });
});

describe("the co-signature is required", () => {
  test("asked for again while the runtime does not answer; the same bytes each time", async () => {
    const bodies: string[] = [];
    let n = 0;
    const wire = sign((await import("../../../packages/chain/src/browser/wire.ts")).unsignedWire((await import("@units/chain")).compileMessage(owner.id, [(await import("@units/chain")).registry.rotateAgentKey({ owner: owner.id, agent: agent.id, newKey: runtime.id })], BLOCKHASH)));
    const back = await cosignRetrying(agent.id, wire, { ...clock(), f: async (_u, init) => {
      bodies.push(String(init!.body));
      return ++n < 3 ? json(502, {}) : json(200, { tx: Buffer.from(cosign(wire, runtime)).toString("base64") });
    } });
    expect(missingSigners(back)).toEqual([]);
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toMatchObject({ sign_only: true });
  });
  test("never an answer: its own sentence; a refusal of the transaction (400) is not retried", async () => {
    const wire = new Uint8Array(200);
    const e = await cosignRetrying(agent.id, wire, { ...clock(), f: async () => json(503, {}) }).catch((x) => x);
    expect(e).toBeInstanceOf(BindUnavailable);
    expect(e.message).toBe("The hosted runtime did not co-sign the agent's binding, so nothing was sent. Try again.");
    expect(e.message).toBe(BIND_NO_COSIGN);
    let n = 0;
    const r = await cosignRetrying(agent.id, wire, { ...clock(), f: async () => (n++, json(400, { error: "refused", message: "refusing to co-sign: only rotate_agent_key binds a hosted agent" })) }).catch((x) => x);
    expect(n).toBe(1);
    expect(r.message).toContain("refused the agent's binding");
    expect(r.message).toContain("nothing was sent");
  });
});

describe("signAndSendAll: a required bind never lets an unbound launch out", () => {
  test("normal: one request, the bind co-signed before the send, all of it lands", async () => {
    const w = wallet();
    const r = await run(w, [...launchParts(), required(runtimeSigns())]);
    expect(w.requests).toEqual([3]);
    expect(r.landed.map((x) => x.label)).toEqual(["launch", "part 2", BIND_LABEL]);
    expect(r.left).toEqual([]);
    expect(r.kept).toEqual([]);
  }, 30_000);

  test("no co-signature: the whole call throws and NOTHING was sent", async () => {
    const w = wallet();
    await expect(run(w, [...launchParts(), required(async () => { throw new BindUnavailable(BIND_NO_COSIGN); })])).rejects.toThrow(/did not co-sign the agent's binding, so nothing was sent/);
    expect(w.requests).toEqual([3]);
    expect(net.sent).toEqual([]);
  }, 30_000);

  test("the wallet changed the bind: nothing was sent", async () => {
    const w = wallet({ all: (wire, i) => (i === 2 ? sign(Uint8Array.from(swapProgram(wire))) : sign(wire)) });
    await expect(run(w, [...launchParts(), required(runtimeSigns())])).rejects.toThrow(/Nothing was sent/);
    expect(net.sent).toEqual([]);
  }, 30_000);

  test("a wallet that wants them one by one and declines the bind: nothing was sent, though the others were approved", async () => {
    const w = wallet({ batch: () => { throw new Error("Unexpected error"); }, one: (wire, i) => { if (i === 2) throw Object.assign(new Error("User rejected the request."), { code: 4001 }); return sign(wire); } });
    const e = await run(w, [...launchParts(), required(runtimeSigns())]).catch((x) => x);
    expect(w.requests).toEqual([3, 1, 1, 1]);
    expect(String(e.message)).toMatch(/^bind: User rejected the request\. Nothing was sent\.$/);
    expect(e.code).toBe(4001);
    expect(net.sent).toEqual([]);
  }, 30_000);

  test("one by one and every one approved: bound like the batch", async () => {
    const w = wallet({ batch: () => { throw new Error("Unexpected error"); } });
    const r = await run(w, [...launchParts(), required(runtimeSigns()), backup(runtimeSigns())]);
    expect(w.requests).toEqual([4, 1, 1, 1, 1]);
    expect(r.landed.map((x) => x.label)).toEqual(["launch", "part 2", BIND_LABEL]);
    expect(r.kept).toEqual([BACKUP_LABEL]);
  }, 30_000);

  test("the bind fails when it is SENT, after the launch landed (ordered sends): the launch stands, and the fully signed bind is kept for the screen and the server", async () => {
    const w = wallet();
    net.refuse.add((await import("@units/chain")).REGISTRY_PROGRAM_ID);
    try {
      const r = await run(w, [...launchParts(), required(runtimeSigns())]);
      expect(r.failed).toBeNull();
      expect(r.landed.map((x) => x.label)).toEqual(["launch", "part 2"]);
      expect(r.left).toHaveLength(1);
      expect(r.left[0]!.label).toBe(BIND_LABEL);
      expect(missingSigners(r.left[0]!.partial!)).toEqual([]);
      keepSignedBind(agent.id, runtime.id, r.left);
      expect(checkBindTx(takeSignedBind(agent.id, runtime.id)!.wire, runtime.id, agent.id).length).toBeGreaterThan(0);
    } finally {
      net.refuse.clear();
    }
  }, 30_000);

  test("a full bundle: the bind is co-signed BEFORE anything is sent, stays out of the bundle, and goes out by itself right after the launch", async () => {
    const order: string[] = [];
    const parts = withBind(launchParts(5), required(async (a, wire) => (order.push(`cosign:${net.sent.length}`), runtimeSigns()(a, wire))), { mainnet: true });
    expect(parts[5]).toMatchObject({ hold: true, mustSign: true });
    expect(parts[5]!.cosign).toBeDefined();
    const w = wallet();
    const r = await run(w, parts);
    expect(w.requests).toEqual([6]);
    expect(order).toEqual(["cosign:0"]); // nothing had been sent when the runtime co-signed
    expect(r.landed.map((x) => x.label)).toEqual(["launch", "part 2", "part 3", "part 4", "part 5", BIND_LABEL]);
    expect(r.left).toEqual([]);
    expect(net.sent).toHaveLength(6);
  }, 30_000);

  test("a full bundle and no co-signature: nothing was sent", async () => {
    const parts = withBind(launchParts(5), required(async () => { throw new BindUnavailable(BIND_NO_COSIGN); }), { mainnet: true });
    await expect(run(wallet(), parts)).rejects.toThrow(/nothing was sent/i);
    expect(net.sent).toEqual([]);
  }, 30_000);

  test("the escape hatch (not required): as before, the launch goes out and the wallet-signed bind is kept", async () => {
    const optional = { ...bindPart({ owner: owner.id, agent: agent.id, newKey: runtime.id, cosign: async () => { throw new Error("the hosted runtime answered HTTP 503."); } }), price: 1 };
    expect(optional.mustSign).toBe(false);
    const r = await run(wallet(), [...launchParts(), optional]);
    expect(r.landed.map((x) => x.label)).toEqual(["launch", "part 2"]);
    expect(r.left[0]).toMatchObject({ label: BIND_LABEL });
    expect(withBind(launchParts(5), optional, { mainnet: true })[5]!.cosign).toBeUndefined();
  }, 30_000);
});

describe("the backup signature in the same approval", () => {
  test("signed over the nonce value with the advance first; co-signed and kept; never sent from the page", async () => {
    const seen: Uint8Array[] = [];
    const w = wallet();
    const r = await run(w, [...launchParts(), required(runtimeSigns()), backup(runtimeSigns(seen))]);
    expect(w.requests).toEqual([4]);
    expect(r.landed.map((x) => x.label)).toEqual(["launch", "part 2", BIND_LABEL]);
    expect(r.kept).toEqual([BACKUP_LABEL]);
    expect(net.sent).toHaveLength(3);
    const m = decodeMessage(parseWire(seen[0]!).message);
    expect(m.blockhash).toBe(NONCE.value);
    expect(m.blockhash).not.toBe(BLOCKHASH);
    expect(isAdvanceOf(m.instructions[0]!, NONCE.account, runtime.id)).toBe(true);
    expect(m.instructions.map((i) => i.programId.slice(0, 7))).toEqual(["1111111", "Compute", "Compute", m.instructions[3]!.programId.slice(0, 7)]);
    // the launcher pays if it is ever used; the runtime key only signs
    expect(m.keys[0]).toBe(owner.id);
    noteBackup(agent.id, r.kept);
    expect(hasBackup(agent.id)).toBe(true);
    expect(hasBackup(other.id)).toBe(false);
  }, 30_000);

  test("a wallet that puts anything before the advance: the runtime refuses the backup, only the backup is left out, the launch is still bound in its bundle", async () => {
    // what a wallet adding its own instruction ahead would produce is stood in by a cosigner that sees such a message
    const r = await run(wallet(), [...launchParts(), required(runtimeSigns()), backup(async () => { throw new Error("refusing to co-sign: a System program instruction that is not the first instruction"); })]);
    expect(r.landed.map((x) => x.label)).toEqual(["launch", "part 2", BIND_LABEL]);
    expect(r.kept).toEqual([]);
    expect(r.left.map((l) => l.label)).toEqual([BACKUP_LABEL]);
  }, 30_000);

  test("a wallet that will not sign the backup at all (one by one, declined): the launch proceeds bound in its bundle", async () => {
    const w = wallet({ batch: () => { throw new Error("Unexpected error"); }, one: (wire, i) => { if (i === 3) throw Object.assign(new Error("User rejected the request."), { code: 4001 }); return sign(wire); } });
    const r = await run(w, [...launchParts(), required(runtimeSigns()), backup(runtimeSigns())]);
    expect(r.landed.map((x) => x.label)).toEqual(["launch", "part 2", BIND_LABEL]);
    expect(r.kept).toEqual([]);
  }, 30_000);

  test("the backup is no way around the required bind: without the bind's co-signature nothing is sent even when the backup was kept", async () => {
    await expect(run(wallet(), [...launchParts(), required(async () => { throw new BindUnavailable(BIND_NO_COSIGN); }), backup(runtimeSigns())])).rejects.toThrow(/nothing was sent/i);
    expect(net.sent).toEqual([]);
  }, 30_000);

  test("mainnet bundle: the backup is not in it (launch and bind land together; the bundle holds one fewer than the approval)", async () => {
    const profile = C.NET.p;
    C.NET.p = { ...profile, network: "mainnet" } as typeof profile;
    net.bundle = true;
    try {
      const w = wallet();
      const r = await run(w, [...launchParts(3), required(runtimeSigns()), backup(runtimeSigns())]);
      expect(w.requests).toEqual([5]);
      expect(net.bundles).toEqual([4]);
      expect(r.bundleId).toBe("bundle1");
      expect(r.landed.map((x) => x.label)).toEqual(["launch", "part 2", "part 3", BIND_LABEL]);
      expect(r.kept).toEqual([BACKUP_LABEL]);
    } finally {
      net.bundle = false;
      C.NET.p = profile;
    }
  }, 30_000);
});

/** A signed-over message with one account key replaced: what a wallet that altered the transaction would hand back. */
function swapProgram(wire: Uint8Array): number[] {
  const out = [...wire];
  // the last 40 bytes hold instruction data and indexes: flipping one byte there changes an instruction
  out[out.length - 3] = out[out.length - 3]! ^ 1;
  return out;
}
