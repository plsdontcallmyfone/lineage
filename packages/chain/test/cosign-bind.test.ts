// The co-signer's one extension for the seamless bind (docs/plans/SEAMLESS-BIND.md): a v0 message that
// reads no lookup table is checked exactly like a legacy one; one that reads a table is still refused.
// And `cosignWire`: the same checks as the sending path, the signature placed, nothing sent.
import { afterEach, describe, expect, test } from "bun:test";
import { generateAgentKey } from "@units/protocol";
import { compileMessage, compileMessageV0, computeBudget, registry, signBytes, system } from "../src/index.ts";
import { DEVNET_GENESIS } from "../src/browser/client.ts";
import { decodeMessage, missingSigners, parseWire, placeSignature, unsignedWire } from "../src/browser/wire.ts";
import { COSIGN_MAX_CU_LIMIT, cosignWire, inspectForCosign } from "../src/cosign.ts";
import { guardKey, installAuthorizer, resetGuardForTest } from "../src/guard.ts";

const owner = generateAgentKey(), agent = generateAgentKey(), key = generateAgentKey();
const rot = registry.rotateAgentKey({ owner: owner.id, agent: agent.id, newKey: key.id });
const LIGHTHOUSE = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
const signed = (m: { bytes: Uint8Array }) => placeSignature(unsignedWire(m as any), owner.id, signBytes(owner, m.bytes));
const b64 = (w: Uint8Array) => Buffer.from(w).toString("base64");
afterEach(() => resetGuardForTest());

describe("inspectForCosign and message versions", () => {
  test("a v0 message with no lookup table is read like a legacy one", () => {
    const m = compileMessageV0(owner.id, [computeBudget.limit(200_000), computeBudget.price(1), rot], DEVNET_GENESIS, []);
    expect(decodeMessage(m.bytes).version).toBe(0);
    const plan = inspectForCosign(signed(m), key.id, { expectAgent: agent.id });
    expect(plan.payer).toBe(owner.id);
    expect(plan.summary.join(" ")).toContain(`to new key ${key.id}`);
  });
  test("a v0 message that reads a lookup table is refused, whatever the table holds", () => {
    const table = { address: generateAgentKey().id, addresses: [rot.keys[0]!.pubkey, rot.keys[3]!.pubkey] };
    const m = compileMessageV0(owner.id, [rot], DEVNET_GENESIS, [table]);
    expect(decodeMessage(m.bytes).lookups.length).toBe(1);
    expect(() => inspectForCosign(signed(m), key.id, { expectAgent: agent.id })).toThrow(/lookup table/);
  });
  test("v0 changes nothing else: the key never pays, is never writable, only the rotation of the expected agent, bounded compute budget", () => {
    const v0 = (payer: string, ixs: Parameters<typeof compileMessage>[1]) => compileMessageV0(payer, ixs, DEVNET_GENESIS, []);
    expect(() => inspectForCosign(unsignedWire(v0(key.id, [registry.rotateAgentKey({ owner: key.id, agent: agent.id, newKey: key.id })])), key.id)).toThrow(/fee payer/);
    expect(() => inspectForCosign(signed(v0(owner.id, [rot, system.transfer(key.id, owner.id, 1n)])), key.id)).toThrow(/writable/);
    expect(() => inspectForCosign(signed(v0(owner.id, [rot, system.transfer(owner.id, agent.id, 1n)])), key.id)).toThrow(/only units_registry and compute budget/);
    expect(() => inspectForCosign(signed(v0(owner.id, [rot])), key.id, { expectAgent: generateAgentKey().id })).toThrow(/not the record of/);
    expect(() => inspectForCosign(signed(v0(owner.id, [computeBudget.limit(COSIGN_MAX_CU_LIMIT + 1), rot])), key.id)).toThrow(/compute budget/);
    expect(() => inspectForCosign(unsignedWire(v0(owner.id, [rot])), key.id)).toThrow(/has not signed/);
    // a wallet's own guard instruction is passed over, in v0 as in legacy
    const guard = { programId: LIGHTHOUSE, keys: [{ pubkey: owner.id, isSigner: false, isWritable: false }], data: Uint8Array.of(1, 2, 3) };
    expect(inspectForCosign(signed(v0(owner.id, [rot, guard])), key.id, { expectAgent: agent.id }).summary).toHaveLength(1);
  });
});

describe("cosignWire", () => {
  test("checks, signs and returns the wire: every signature present, the message untouched", async () => {
    const m = compileMessage(owner.id, [rot], DEVNET_GENESIS);
    const r = await cosignWire({ key, tx: b64(signed(m)), expectAgent: agent.id });
    expect(missingSigners(r.wire)).toEqual([]);
    expect(Buffer.from(parseWire(r.wire).message).equals(Buffer.from(m.bytes))).toBe(true);
    expect(r.payer).toBe(owner.id);
  });
  test("refuses what inspectForCosign refuses, and signs nothing for a guarded key the firewall refuses", async () => {
    const other = generateAgentKey().id;
    const m = compileMessage(owner.id, [rot], DEVNET_GENESIS);
    await expect(cosignWire({ key, tx: b64(signed(m)), expectAgent: other })).rejects.toThrow(/not the record of/);
    await expect(cosignWire({ key, tx: b64(unsignedWire(m)), expectAgent: agent.id })).rejects.toThrow(/has not signed/);
    guardKey(key.id);
    await expect(cosignWire({ key, tx: b64(signed(m)), expectAgent: agent.id })).rejects.toThrow(/no firewall/);
    installAuthorizer(async () => {
      throw new Error("firewall: refused");
    });
    await expect(cosignWire({ key, tx: b64(signed(m)), expectAgent: agent.id })).rejects.toThrow(/firewall: refused/);
    installAuthorizer(async () => {});
    expect(missingSigners((await cosignWire({ key, tx: b64(signed(m)), expectAgent: agent.id })).wire)).toEqual([]);
  });
});
