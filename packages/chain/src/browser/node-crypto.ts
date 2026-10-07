// Browser stand-in for `node:crypto`, used only by the browser build (plugin.ts). It provides
// createHash("sha256") synchronously; private-key operations are not available in a page: the
// wallet signs, and fresh keys (agent, mint) are WebCrypto Ed25519 keys (wire.ts).
import { Sha256 } from "./sha256.ts";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function createHash(alg: string) {
  if (alg !== "sha256") throw new Error(`createHash(${alg}) is not available in the browser build`);
  const h = new Sha256();
  const api = {
    update(d: Uint8Array | string) {
      h.update(d);
      return api;
    },
    digest(enc?: "hex") {
      const out = h.digest();
      return (enc === "hex" ? hex(out) : globalThis.Buffer ? globalThis.Buffer.from(out) : out) as any;
    },
  };
  return api;
}

const unavailable = (name: string) => () => {
  throw new Error(`${name} is not available in the browser: the wallet signs, local keys are WebCrypto keys`);
};
export const createPrivateKey = unavailable("createPrivateKey");
export const createPublicKey = unavailable("createPublicKey");
export const generateKeyPairSync = unavailable("generateKeyPairSync");
export const sign = unavailable("crypto.sign");
export const verify = unavailable("crypto.verify");
export type KeyObject = never;
export default { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify };
