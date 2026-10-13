// The wizard's bind transaction (apps/web/wallet/bind-plan.ts, docs/plans/SEAMLESS-BIND.md): what the
// wallet is asked to approve with the launch, that the runtime's co-signer accepts exactly it (and the
// same with a wallet's guard instruction added), where it rides, and what is kept when it did not go.
import { describe, expect, test } from "bun:test";
import { generateAgentKey } from "@units/protocol";
import { compileMessage, compileMessageV0, computeBudget, JITO_MAX_TXS, registryPdas, signBytes } from "@units/chain";
import { DEVNET_GENESIS } from "../../../packages/chain/src/browser/client.ts";
import { decodeMessage, missingSigners, parseWire, placeSignature, unsignedWire } from "../../../packages/chain/src/browser/wire.ts";
import { cosign } from "../../../packages/chain/src/cosign.ts";
import { checkBindTx } from "../../../packages/runtime/src/bind.ts";
import { BIND_LABEL, BIND_UNITS, bindPart, declined, keepSignedBind, reserveRuntimeKey, runtimeCosign, runtimeKeyOf, runtimeSend, takeSignedBind, withBind } from "../wallet/bind-plan.ts";
import type { BundlePart } from "../wallet/chain.ts";

const owner = generateAgentKey(), agent = generateAgentKey(), runtime = generateAgentKey();
const LIGHTHOUSE = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
/** The message signAndSendAll compiles for a part (budget first), signed by the launcher's wallet. */
function walletSigned(p: BundlePart, extra: Parameters<typeof compileMessage>[1] = []) {
  const ixs = [computeBudget.limit(p.units), computeBudget.price(p.price ?? 1), ...p.ixs, ...extra];
  const m = p.v0 ? compileMessageV0(owner.id, ixs, DEVNET_GENESIS, []) : compileMessage(owner.id, ixs, DEVNET_GENESIS);
  return placeSignature(unsignedWire(m as any), owner.id, signBytes(owner, m.bytes));
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the bind transaction of a launch", () => {
  for (const v0 of [false, true]) {
    test(`${v0 ? "v0 (no lookup table)" : "legacy"}: one rotate_agent_key, the launcher pays, the runtime's key is a read-only signer; the co-signer accepts it`, () => {
      const p = bindPart({ owner: owner.id, agent: agent.id, newKey: runtime.id, v0 });
      expect(p).toMatchObject({ label: BIND_LABEL, units: BIND_UNITS, optional: true, v0 });
      expect(p.cosign?.signer).toBe(runtime.id);
      expect(p.local ?? []).toEqual([]); // the launcher's agent key does not sign a rotation
      const wire = walletSigned(p);
      const m = decodeMessage(parseWire(wire).message);
      expect(m.version).toBe(v0 ? 0 : "legacy");
      expect(m.lookups).toEqual([]);
      expect(m.keys[0]).toBe(owner.id);
      expect(m.keys.slice(0, m.numSigners)).toEqual([owner.id, runtime.id]);
      expect(m.numReadonlySigned).toBe(1);
      expect(m.instructions.at(-1)!.accounts[3]!.pubkey).toBe(registryPdas.agent(agent.id));
      expect(missingSigners(wire)).toEqual([runtime.id]);
      expect(checkBindTx(wire, runtime.id, agent.id).join(" ")).toContain(`to new key ${runtime.id}`);
      expect(missingSigners(cosign(wire, runtime))).toEqual([]);
      // a wallet that adds its own guard instruction: still accepted, still only the rotation
      const guard = { programId: LIGHTHOUSE, keys: [{ pubkey: owner.id, isSigner: false, isWritable: false }], data: Uint8Array.of(9) };
      expect(checkBindTx(walletSigned(p, [guard]), runtime.id, agent.id)).toHaveLength(4);
      // and nothing else may ride with it
      expect(() => checkBindTx(walletSigned(p, [bindPart({ owner: owner.id, agent: generateAgentKey().id, newKey: runtime.id }).ixs[0]!]), runtime.id, agent.id)).toThrow(/refusing/);
    });
  }

  test("it rides last; a mainnet bundle that is already full keeps the launch whole and holds the bind back", () => {
    const part = (label: string): BundlePart => ({ ixs: [], units: 1, label });
    const bind = bindPart({ owner: owner.id, agent: agent.id, newKey: runtime.id });
    const two = withBind([part("launch"), part("credits + tip")], bind, { mainnet: true });
    expect(two.map((p) => p.label)).toEqual(["launch", "credits + tip", BIND_LABEL]);
    expect(two[2]!.hold).toBeUndefined();
    expect(two[2]!.cosign).toBeDefined();
    const full = withBind(Array.from({ length: JITO_MAX_TXS }, (_, i) => part(`t${i}`)), bind, { mainnet: true });
    expect(full).toHaveLength(JITO_MAX_TXS + 1);
    expect(full.at(-1)).toMatchObject({ label: BIND_LABEL, hold: true, optional: true });
    expect(full.at(-1)!.cosign).toBeUndefined();
    // devnet sends in order: no limit
    expect(withBind(Array.from({ length: JITO_MAX_TXS }, (_, i) => part(`t${i}`)), bind, { mainnet: false }).at(-1)!.hold).toBeUndefined();
  });
});

describe("talking to the runtime", () => {
  test("a reservation is asked for with { reserve: true }; any failure is no key, never an error", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const ok = await reserveRuntimeKey(agent.id, async (url, init) => (seen.push({ url, body: JSON.parse(String(init!.body)) }), json(200, { agent: agent.id, new_key: runtime.id, status: "reserved", expires_at: 1 })));
    expect(ok).toEqual({ agent: agent.id, new_key: runtime.id, status: "reserved", nonce: null });
    expect(seen).toEqual([{ url: `/runtime/bind/${agent.id}`, body: { reserve: true } }]);
    expect(await reserveRuntimeKey(agent.id, async () => json(429, { error: "reservations_full" }))).toBeNull();
    expect(await reserveRuntimeKey(agent.id, async () => json(400, { error: "bad_body" }))).toBeNull(); // a runtime that predates reservations
    expect(await reserveRuntimeKey(agent.id, async () => json(200, { nothing: true }))).toBeNull();
    expect(await reserveRuntimeKey(agent.id, async () => { throw new TypeError("network"); })).toBeNull();
    expect(await runtimeKeyOf(agent.id, async () => json(404, { error: "not_hosted" }))).toBeNull();
    expect(await runtimeKeyOf(agent.id, async () => json(200, { agent: agent.id, new_key: runtime.id, status: "awaiting_owner" }))).toMatchObject({ status: "awaiting_owner" });
  });

  test("the co-sign request carries the wallet-signed wire and sign_only; a refusal is thrown with the runtime's words", async () => {
    const p = bindPart({ owner: owner.id, agent: agent.id, newKey: runtime.id });
    const wire = walletSigned(p);
    let body: any = null;
    const back = await runtimeCosign(agent.id, wire, async (_u, init) => {
      body = JSON.parse(String(init!.body));
      return json(200, { tx: Buffer.from(cosign(new Uint8Array(Buffer.from(body.tx, "base64")), runtime)).toString("base64") });
    });
    expect(body.sign_only).toBe(true);
    expect(missingSigners(back)).toEqual([]);
    await expect(runtimeCosign(agent.id, wire, async () => json(429, { error: "too_many_signs", message: "co-signed as often as it may be" }))).rejects.toThrow(/as often as it may be/);
    await expect(runtimeCosign(agent.id, wire, async () => json(200, {}))).rejects.toThrow(/no transaction/);
    // the part's own co-signer is the same request for this agent
    const viaPart = bindPart({ owner: owner.id, agent: agent.id, newKey: runtime.id, cosign: async (a, w) => (expect(a).toBe(agent.id), cosign(w, runtime)) });
    expect(missingSigners(await viaPart.cosign!.sign(wire))).toEqual([]);
  });

  test("sending through the runtime: its signature, already bound as success, a refusal with its status", async () => {
    const wire = walletSigned(bindPart({ owner: owner.id, agent: agent.id, newKey: runtime.id }));
    expect(await runtimeSend(agent.id, wire, async () => json(200, { agent: agent.id, new_key: runtime.id, signature: "sig" }))).toMatchObject({ signature: "sig" });
    expect(await runtimeSend(agent.id, wire, async () => json(409, { error: "already_bound" }))).toEqual({ signature: "", bound: true });
    await expect(runtimeSend(agent.id, wire, async () => json(404, { error: "not_hosted", message: "not a hosted launched agent" }))).rejects.toMatchObject({ status: 404 });
  });
});

describe("what is kept when the bind did not go with the launch", () => {
  test("a wallet-signed bind is kept once for its agent and key; nothing is kept when the wallet did not sign it", () => {
    const wire = Uint8Array.of(1, 2, 3);
    expect(keepSignedBind(agent.id, runtime.id, [])).toBeNull();
    expect(keepSignedBind(agent.id, runtime.id, [{ label: "credits", why: "x", partial: wire, lastValidBlockHeight: 1 }])).toBeNull();
    expect(keepSignedBind(agent.id, runtime.id, [{ label: BIND_LABEL, why: "the hosted runtime did not answer", partial: wire, lastValidBlockHeight: 77 }])).toBe("the hosted runtime did not answer");
    expect(takeSignedBind(agent.id, generateAgentKey().id)).toBeNull(); // another key: not used, and gone
    expect(takeSignedBind(agent.id, runtime.id)).toBeNull();
    keepSignedBind(agent.id, runtime.id, [{ label: BIND_LABEL, why: "held", partial: wire, lastValidBlockHeight: 77 }]);
    expect(takeSignedBind(agent.id, runtime.id)).toEqual({ wire, newKey: runtime.id, lastValidBlockHeight: 77 } as any);
    expect(takeSignedBind(agent.id, runtime.id)).toBeNull();
    expect(keepSignedBind(agent.id, runtime.id, [{ label: BIND_LABEL, why: "declined", partial: null, lastValidBlockHeight: 0 }])).toBe("declined");
    expect(takeSignedBind(agent.id, runtime.id)).toBeNull();
  });
  test("a refusal in the wallet is told apart from everything else", () => {
    expect(declined(Object.assign(new Error("x"), { code: 4001 }))).toBe(true);
    expect(declined(new Error("User rejected the request."))).toBe(true);
    expect(declined(new Error("BlockhashNotFound"))).toBe(false);
  });
});
