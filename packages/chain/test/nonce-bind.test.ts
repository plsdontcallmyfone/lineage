// The backup bind signature (docs/plans/SEAMLESS-BIND.md section 10): a rotation signed over the
// reserved key's own nonce account. The co-signer and the firewall each accept exactly one more
// instruction for it, AdvanceNonceAccount of that account with that key as authority, and only as
// instruction 0; and the firewall lets a key give its nonce account's rent back to the payer that
// funded it and to nobody else. Every refusal is here, twice: once per lock.
import { afterEach, describe, expect, test } from "bun:test";
import { generateAgentKey } from "@units/protocol";
import { compileMessage, compileMessageV0, computeBudget, decodeNonceAccount, evaluate, nonce, nonceAccountFor, NONCE_ACCOUNT_LEN, registry, signBytes, system, type FirewallContext, type Ix } from "../src/index.ts";
import { DEVNET_GENESIS } from "../src/browser/client.ts";
import { unsignedWire, placeSignature } from "../src/browser/wire.ts";
import { cosignWire, inspectForCosign } from "../src/cosign.ts";
import { guardKey, installAuthorizer, resetGuardForTest } from "../src/guard.ts";
import { base58Decode } from "@units/protocol";

const owner = generateAgentKey(), agent = generateAgentKey().id, key = generateAgentKey(), payer = generateAgentKey();
const NONCE = nonceAccountFor(payer.id, key.id);
const rot = registry.rotateAgentKey({ owner: owner.id, agent, newKey: key.id });
const adv = nonce.advance(NONCE, key.id);
const budget = [computeBudget.limit(200_000), computeBudget.price(1)];
const LIGHTHOUSE = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
const msg = (ixs: Ix[], feePayer = owner.id, v0 = false) => (v0 ? compileMessageV0(feePayer, ixs, DEVNET_GENESIS, []) : compileMessage(feePayer, ixs, DEVNET_GENESIS));
const signed = (ixs: Ix[], v0 = false) => {
  const m = msg(ixs, owner.id, v0);
  return placeSignature(unsignedWire(m), owner.id, signBytes(owner, m.bytes));
};
const ctx = (c: Partial<FirewallContext> = {}): FirewallContext => ({ key: key.id, agent, tables: new Map(), nonce: { account: NONCE, payer: payer.id }, ...c });
const fw = (ixs: Ix[], c: Partial<FirewallContext> = {}, feePayer = owner.id) => evaluate(msg(ixs, feePayer).bytes, ctx(c));
afterEach(() => resetGuardForTest());

describe("nonce accounts", () => {
  test("one account per key under a payer, 80 bytes, created by the payer alone with the key as authority", () => {
    expect(nonceAccountFor(payer.id, key.id)).toBe(NONCE);
    expect(nonceAccountFor(payer.id, generateAgentKey().id)).not.toBe(NONCE);
    expect(nonceAccountFor(generateAgentKey().id, key.id)).not.toBe(NONCE);
    const [create, init] = nonce.create(payer.id, key.id, 1_447_680n);
    expect(create!.keys.filter((k) => k.isSigner).map((k) => k.pubkey)).toEqual([payer.id]);
    expect(init!.keys.some((k) => k.isSigner)).toBe(false);
    expect(Buffer.from(init!.data.subarray(4)).equals(Buffer.from(base58Decode(key.id)))).toBe(true);
    expect(NONCE_ACCOUNT_LEN).toBe(80);
  });
  test("decodes an initialized account and nothing else", () => {
    const data = new Uint8Array(80);
    new DataView(data.buffer).setUint32(4, 1, true);
    data.set(base58Decode(key.id), 8);
    data.set(base58Decode(DEVNET_GENESIS), 40);
    expect(decodeNonceAccount(data)).toEqual({ authority: key.id, value: DEVNET_GENESIS });
    expect(decodeNonceAccount(new Uint8Array(80))).toBeNull(); // uninitialized
    expect(decodeNonceAccount(new Uint8Array(82))).toBeNull();
    expect(decodeNonceAccount(data, generateAgentKey().id)).toBeNull(); // not the System program's
  });
});

describe("co-signer: the durable rotation", () => {
  test("accepted: advance first, compute budget, one rotation; legacy and v0", () => {
    for (const v0 of [false, true]) {
      const plan = inspectForCosign(signed([adv, ...budget, rot], v0), key.id, { expectAgent: agent, nonce: NONCE });
      expect(plan.durable).toBe(true);
      expect(plan.summary[0]).toBe(`durable nonce: advances ${NONCE}`);
    }
    // an ordinary bind is still an ordinary bind, with or without a nonce account known
    expect(inspectForCosign(signed([...budget, rot]), key.id, { expectAgent: agent, nonce: NONCE }).durable).toBe(false);
  });
  test("a wallet's own guard after it is passed over; anything put BEFORE the advance is refused", () => {
    const guard: Ix = { programId: LIGHTHOUSE, keys: [], data: new Uint8Array([1]) };
    expect(inspectForCosign(signed([adv, ...budget, rot, guard]), key.id, { expectAgent: agent, nonce: NONCE }).durable).toBe(true);
    expect(() => inspectForCosign(signed([computeBudget.limit(200_000), adv, rot]), key.id, { expectAgent: agent, nonce: NONCE })).toThrow(/not the first instruction/);
    expect(() => inspectForCosign(signed([guard, adv, rot]), key.id, { expectAgent: agent, nonce: NONCE })).toThrow(/not the first instruction/);
  });
  test("refused: another nonce account, another authority, no nonce account known for the key", () => {
    const other = nonceAccountFor(payer.id, generateAgentKey().id);
    expect(() => inspectForCosign(signed([nonce.advance(other, key.id), rot]), key.id, { expectAgent: agent, nonce: NONCE })).toThrow(/not AdvanceNonceAccount of this key's nonce account/);
    expect(() => inspectForCosign(signed([adv, rot]), key.id, { expectAgent: agent, nonce: other })).toThrow(/not AdvanceNonceAccount of this key's nonce account/);
    expect(() => inspectForCosign(signed([nonce.advance(NONCE, owner.id), rot]), key.id, { expectAgent: agent, nonce: NONCE })).toThrow(/not AdvanceNonceAccount/);
    expect(() => inspectForCosign(signed([adv, rot]), key.id, { expectAgent: agent })).toThrow(/only units_registry and compute budget/);
  });
  test("refused: any other instruction beside it, any other System instruction, a second rotation, another agent", () => {
    const o = { expectAgent: agent, nonce: NONCE };
    expect(() => inspectForCosign(signed([adv, rot, system.transfer(owner.id, agent, 1n)]), key.id, o)).toThrow(/not the first instruction/);
    expect(() => inspectForCosign(signed([adv, rot, nonce.advance(NONCE, key.id)]), key.id, o)).toThrow(/not the first instruction/);
    expect(() => inspectForCosign(signed([nonce.withdraw(NONCE, owner.id, key.id, 1n), rot]), key.id, o)).toThrow(/not AdvanceNonceAccount/);
    expect(() => inspectForCosign(signed([system.transfer(owner.id, agent, 1n), rot]), key.id, o)).toThrow(/not AdvanceNonceAccount/);
    expect(() => inspectForCosign(signed([adv, rot, rot]), key.id, o)).toThrow(/exactly one rotate_agent_key/);
    expect(() => inspectForCosign(signed([adv, registry.rotateAgentKey({ owner: owner.id, agent: generateAgentKey().id, newKey: key.id })]), key.id, o)).toThrow(/not the record of/);
    expect(() => inspectForCosign(signed([adv]), key.id, o)).toThrow(/no register or rotate_agent_key/);
    // an advance with an extra account or extra data is not the advance
    expect(() => inspectForCosign(signed([{ ...adv, keys: [...adv.keys, { pubkey: owner.id, isSigner: false, isWritable: true }] }, rot]), key.id, o)).toThrow(/not AdvanceNonceAccount/);
    expect(() => inspectForCosign(signed([{ ...adv, data: new Uint8Array([4, 0, 0, 0, 0]) }, rot]), key.id, o)).toThrow(/not AdvanceNonceAccount/);
  });
  test("cosignWire signs it through the firewall and only with the nonce account it was told", async () => {
    const seen: string[] = [];
    installAuthorizer(async (k, m) => {
      seen.push(k);
      const v = evaluate(m, ctx());
      if (!v.ok) throw new Error(v.rule);
    });
    guardKey(key.id);
    const tx = Buffer.from(signed([adv, ...budget, rot])).toString("base64");
    const r = await cosignWire({ key, tx, expectAgent: agent, nonce: NONCE });
    expect(r.summary[0]).toContain("durable nonce");
    expect(seen).toEqual([key.id]);
    await expect(cosignWire({ key, tx, expectAgent: agent })).rejects.toThrow(/only units_registry/);
  });
});

describe("firewall: the durable rotation and the nonce close", () => {
  test("allowed: advance of the key's own nonce account first, then its agent's one rotation", () => {
    expect(fw([adv, ...budget, rot])).toMatchObject({ ok: true, kind: "registry" });
    expect(fw([adv, rot])).toMatchObject({ ok: true, kind: "registry" });
  });
  test("refused: no nonce account for the key, another account, another authority, the advance not first", () => {
    expect(fw([adv, rot], { nonce: null })).toMatchObject({ ok: false, rule: "program_not_allowed" });
    expect(fw([nonce.advance(nonceAccountFor(payer.id, generateAgentKey().id), key.id), rot])).toMatchObject({ ok: false, rule: "nonce" });
    expect(fw([nonce.advance(NONCE, owner.id), rot])).toMatchObject({ ok: false, rule: "nonce" });
    expect(fw([computeBudget.limit(200_000), adv, rot])).toMatchObject({ ok: false, rule: "program_not_allowed" });
  });
  test("refused: anything but one rotation of its own agent after the advance", () => {
    expect(fw([adv, rot, rot])).toMatchObject({ ok: false, rule: "nonce" });
    expect(fw([adv])).toMatchObject({ ok: false, rule: "nothing_to_sign" });
    expect(fw([adv, rot, system.transfer(owner.id, agent, 1n)])).toMatchObject({ ok: false, rule: "program_not_allowed" });
    expect(fw([adv, rot, adv])).toMatchObject({ ok: false, rule: "program_not_allowed" });
    expect(fw([adv, registry.rotateAgentKey({ owner: owner.id, agent: generateAgentKey().id, newKey: key.id })])).toMatchObject({ ok: false, rule: "registry_accounts" });
    expect(fw([adv, rot], { agent: null })).toMatchObject({ ok: false, rule: "unknown_agent" });
    // the key as fee payer of its own bind
    expect(evaluate(msg([adv, registry.rotateAgentKey({ owner: owner.id, agent, newKey: key.id })], key.id).bytes, ctx())).toMatchObject({ ok: false, rule: "key_pays" });
  });
  test("nonce close: the whole transaction is the withdrawal of its own account to the payer that funded it", () => {
    const close = nonce.withdraw(NONCE, payer.id, key.id, 1_447_680n);
    expect(fw([close], {}, payer.id)).toMatchObject({ ok: true, kind: "nonce_close" });
    expect(fw([...budget, close], {}, payer.id)).toMatchObject({ ok: true, kind: "nonce_close" });
    // a pool or retired key (no agent) may close its account and do nothing else
    expect(fw([close], { agent: null }, payer.id)).toMatchObject({ ok: true, kind: "nonce_close" });
    expect(fw([adv, rot], { agent: null })).toMatchObject({ ok: false, rule: "unknown_agent" });
  });
  test("nonce close refused: to anyone else, of another account, with anything beside it, with the key paying, with no nonce account known", () => {
    const thief = generateAgentKey().id;
    expect(fw([nonce.withdraw(NONCE, thief, key.id, 1n)], {}, payer.id)).toMatchObject({ ok: false, rule: "nonce" });
    expect(fw([nonce.withdraw(nonceAccountFor(payer.id, thief), payer.id, key.id, 1n)], {}, payer.id)).toMatchObject({ ok: false, rule: "nonce" });
    expect(fw([nonce.withdraw(NONCE, payer.id, key.id, 1n), system.transfer(payer.id, thief, 1n)], {}, payer.id)).toMatchObject({ ok: false, rule: "nonce_close" });
    expect(fw([nonce.withdraw(NONCE, payer.id, key.id, 1n), rot], {}, payer.id)).toMatchObject({ ok: false, rule: "nonce_close" });
    expect(fw([nonce.withdraw(NONCE, payer.id, key.id, 1n)], {}, key.id)).toMatchObject({ ok: false, rule: "key_pays" });
    expect(fw([nonce.withdraw(NONCE, payer.id, key.id, 1n)], { nonce: null }, payer.id)).toMatchObject({ ok: false });
    // a System transfer signed by the key is never a nonce instruction
    expect(fw([system.transfer(key.id, thief, 1n)], {}, payer.id)).toMatchObject({ ok: false, rule: "nonce" });
  });
});
