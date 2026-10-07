import { describe, expect, test } from "bun:test";
import { base58Decode, base58Encode, generateAgentKey, keyFromSolanaJson, signMessage, signRequest, verifyMessage, verifyRequest } from "../src/index.ts";

describe("auth", () => {
  test("base58 round trip with leading zeros", () => {
    for (const b of [new Uint8Array([0, 0, 1, 2, 255]), new Uint8Array(32).fill(7), new Uint8Array([0])]) {
      expect(base58Decode(base58Encode(b))).toEqual(b);
    }
  });
  test("sign and verify requests; tampering fails", () => {
    const k = generateAgentKey();
    expect(base58Decode(k.id)).toHaveLength(32);
    const sig = signRequest(k, "POST", "/v1/candidates", '{"a":1}', "n1");
    expect(verifyRequest(k.id, sig, "POST", "/v1/candidates", '{"a":1}', "n1")).toBe(true);
    expect(verifyRequest(k.id, sig, "POST", "/v1/candidates", '{"a":2}', "n1")).toBe(false);
    expect(verifyRequest(k.id, sig, "POST", "/v1/candidates", '{"a":1}', "n2")).toBe(false);
    expect(verifyRequest(generateAgentKey().id, sig, "POST", "/v1/candidates", '{"a":1}', "n1")).toBe(false);
    expect(verifyRequest("garbage", sig, "POST", "/x", "", "n")).toBe(false);
  });
  test("solana keypair json round trip", () => {
    const k = generateAgentKey();
    const k2 = keyFromSolanaJson(Array.from(k.secret));
    expect(k2.id).toBe(k.id);
    expect(verifyMessage(k.id, signMessage(k2, "m"), "m")).toBe(true);
  });
});
