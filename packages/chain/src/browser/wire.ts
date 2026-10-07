// Legacy transaction wire format for a page: an unsigned transaction (zeroed signature slots) for
// the wallet, signatures placed by signer address, the message decoded back for inspection, and
// WebCrypto Ed25519 keys for the fresh keypairs a launch needs (agent key, agent mint). No secret
// ever leaves the page except as a file the person chooses to download.
import { base58Decode, base58Encode } from "@lineage/protocol";
import { toAddress, type Address } from "../codec.ts";
import type { CompiledMessage } from "../tx.ts";

const readCompact = (b: Uint8Array, o: number): [number, number] => {
  let v = 0;
  for (let s = 0; ; s += 7) {
    const x = b[o++]!;
    v |= (x & 0x7f) << s;
    if (!(x & 0x80)) return [v, o];
  }
};
const compact = (n: number): number[] => {
  const out: number[] = [];
  let v = n;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
};

/** Wire bytes with `numSigners` zeroed signature slots in front of the message. */
export function unsignedWire(msg: CompiledMessage): Uint8Array {
  const head = compact(msg.numSigners);
  const out = new Uint8Array(head.length + 64 * msg.numSigners + msg.bytes.length);
  out.set(head, 0);
  out.set(msg.bytes, head.length + 64 * msg.numSigners);
  return out;
}

export interface ParsedWire {
  signatures: Uint8Array[];
  message: Uint8Array;
}
export function parseWire(wire: Uint8Array): ParsedWire {
  const [n, o] = readCompact(wire, 0);
  const signatures: Uint8Array[] = [];
  for (let i = 0; i < n; i++) signatures.push(wire.slice(o + 64 * i, o + 64 * (i + 1)));
  return { signatures, message: wire.slice(o + 64 * n) };
}
export function assembleWire(p: ParsedWire): Uint8Array {
  const head = compact(p.signatures.length);
  const out = new Uint8Array(head.length + 64 * p.signatures.length + p.message.length);
  out.set(head, 0);
  p.signatures.forEach((s, i) => out.set(s, head.length + 64 * i));
  out.set(p.message, head.length + 64 * p.signatures.length);
  return out;
}

export interface DecodedIx {
  programId: Address;
  accounts: { pubkey: Address; isSigner: boolean; isWritable: boolean }[];
  data: Uint8Array;
}
export interface DecodedMessage {
  numSigners: number;
  numReadonlySigned: number;
  numReadonlyUnsigned: number;
  keys: Address[];
  blockhash: string;
  instructions: DecodedIx[];
}
/** Decodes a legacy message (a v0 message is refused: the builders never make one). */
export function decodeMessage(m: Uint8Array): DecodedMessage {
  if (m[0]! & 0x80) throw new Error("versioned messages are not used here");
  const [numSigners, numReadonlySigned, numReadonlyUnsigned] = [m[0]!, m[1]!, m[2]!];
  let [nk, o] = readCompact(m, 3);
  const keys: Address[] = [];
  for (let i = 0; i < nk; i++, o += 32) keys.push(toAddress(m.subarray(o, o + 32)));
  const blockhash = toAddress(m.subarray(o, o + 32));
  o += 32;
  const writable = (i: number) => (i < numSigners ? i < numSigners - numReadonlySigned : i < keys.length - numReadonlyUnsigned);
  let ni: number;
  [ni, o] = readCompact(m, o);
  const instructions: DecodedIx[] = [];
  for (let k = 0; k < ni; k++) {
    const programId = keys[m[o++]!]!;
    let na: number;
    [na, o] = readCompact(m, o);
    const accounts = [];
    for (let j = 0; j < na; j++) {
      const idx = m[o++]!;
      accounts.push({ pubkey: keys[idx]!, isSigner: idx < numSigners, isWritable: writable(idx) });
    }
    let nd: number;
    [nd, o] = readCompact(m, o);
    instructions.push({ programId, accounts, data: m.slice(o, o + nd) });
    o += nd;
  }
  return { numSigners, numReadonlySigned, numReadonlyUnsigned, keys, blockhash, instructions };
}

/** Puts `sig` into the slot of `signer` (an address among the message's signers). */
export function placeSignature(wire: Uint8Array, signer: Address, sig: Uint8Array): Uint8Array {
  const p = parseWire(wire);
  const d = decodeMessage(p.message);
  const i = d.keys.slice(0, d.numSigners).indexOf(signer);
  if (i < 0) throw new Error(`${signer} is not a signer of this message`);
  p.signatures[i] = sig;
  return assembleWire(p);
}

/** Signers whose slot is still all zeros. */
export function missingSigners(wire: Uint8Array): Address[] {
  const p = parseWire(wire);
  const d = decodeMessage(p.message);
  return d.keys.slice(0, d.numSigners).filter((_, i) => p.signatures[i]!.every((x) => x === 0));
}

/** The transaction id: base58 of the first (fee payer's) signature. */
export const wireSignature = (wire: Uint8Array): string => base58Encode(parseWire(wire).signatures[0]!);

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
export { sameBytes };

// ---------- WebCrypto Ed25519 keys ----------

export interface WebKey {
  id: Address;
  sign(message: Uint8Array): Promise<Uint8Array>;
  /** Solana CLI keypair JSON (seed then public key), for a download the person asks for. */
  exportSolanaJson(): Promise<number[]>;
}

export async function generateWebKey(): Promise<WebKey> {
  const k = (await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", k.publicKey));
  return {
    id: base58Encode(pub),
    sign: async (m) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" } as any, k.privateKey, m as BufferSource)),
    exportSolanaJson: async () => {
      const p8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", k.privateKey));
      return [...p8.slice(p8.length - 32), ...pub];
    },
  };
}

export async function verifyEd25519(signer: Address, message: Uint8Array, sig: Uint8Array): Promise<boolean> {
  const pub = await crypto.subtle.importKey("raw", base58Decode(signer) as BufferSource, { name: "Ed25519" } as any, false, ["verify"]);
  return crypto.subtle.verify({ name: "Ed25519" } as any, pub, sig as BufferSource, message as BufferSource);
}
