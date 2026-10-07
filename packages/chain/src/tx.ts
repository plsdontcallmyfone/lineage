import { createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { base58Encode, generateAgentKey, keyFromSolanaJson, type AgentKey } from "@lineage/protocol";
import { addressBytes, Writer, type Address } from "./codec.ts";
import type { AccountMeta, Ix } from "./registry.ts";

// Legacy Solana transactions without an SDK: message compilation, ed25519 signing and the wire
// format (https://solana.com/docs/core/transactions). Keypairs are Solana CLI JSON files.

export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
export const PACKET_LIMIT = 1232;

/** A local signer: the Solana keypair layout (32-byte seed, then the public key). */
export type Signer = AgentKey;

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function signBytes(key: Signer, message: Uint8Array): Uint8Array {
  const k = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(key.secret.subarray(0, 32))]), format: "der", type: "pkcs8" });
  return new Uint8Array(edSign(null, Buffer.from(message), k));
}

/** Reads a Solana CLI keypair file and checks that its public half matches its seed. */
export function loadKeypair(path: string): Signer {
  const key = keyFromSolanaJson(JSON.parse(readFileSync(path, "utf8")));
  const k = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(key.secret.subarray(0, 32))]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(k).export({ format: "der", type: "spki" });
  if (base58Encode(new Uint8Array(spki.subarray(spki.length - 32))) !== key.id) throw new Error(`${path}: public key does not match the seed`);
  return key;
}

/** Loads `path`, or creates a fresh keypair there (mode 600, parent 700). Returns it and whether it was created. */
export function loadOrCreateKeypair(path: string): { key: Signer; created: boolean } {
  if (existsSync(path)) return { key: loadKeypair(path), created: false };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const key = generateAgentKey();
  writeFileSync(path, JSON.stringify(Array.from(key.secret)), { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  return { key, created: true };
}

const compactU16 = (w: Writer, n: number) => {
  let v = n;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      w.u8(b);
      return;
    }
    w.u8(b | 0x80);
  }
};

export interface CompiledMessage {
  bytes: Uint8Array;
  /** Account keys in message order; the first `numSigners` sign. */
  keys: Address[];
  numSigners: number;
}

/** Compiles a legacy message: payer first, then writable signers, readonly signers, writable, readonly. */
export function compileMessage(payer: Address, ixs: Ix[], recentBlockhash: string): CompiledMessage {
  const metas = new Map<Address, { signer: boolean; writable: boolean; order: number }>();
  let order = 0;
  const add = (m: AccountMeta) => {
    const cur = metas.get(m.pubkey);
    if (cur) {
      cur.signer ||= m.isSigner;
      cur.writable ||= m.isWritable;
    } else metas.set(m.pubkey, { signer: m.isSigner, writable: m.isWritable, order: order++ });
  };
  add({ pubkey: payer, isSigner: true, isWritable: true });
  for (const ix of ixs) {
    for (const k of ix.keys) add(k);
    add({ pubkey: ix.programId, isSigner: false, isWritable: false });
  }
  const all = [...metas.entries()];
  const group = (s: boolean, wr: boolean) =>
    all.filter(([k, m]) => m.signer === s && m.writable === wr && k !== payer).sort((a, b) => a[1].order - b[1].order).map(([k]) => k);
  const ws = [payer, ...group(true, true)];
  const rs = group(true, false);
  const wu = group(false, true);
  const ru = group(false, false);
  const keys = [...ws, ...rs, ...wu, ...ru];
  const index = new Map(keys.map((k, i) => [k, i]));
  const w = new Writer();
  w.u8(ws.length + rs.length).u8(rs.length).u8(ru.length);
  compactU16(w, keys.length);
  for (const k of keys) w.address(k);
  w.bytes(addressBytes(recentBlockhash));
  compactU16(w, ixs.length);
  for (const ix of ixs) {
    w.u8(index.get(ix.programId)!);
    compactU16(w, ix.keys.length);
    for (const k of ix.keys) w.u8(index.get(k.pubkey)!);
    compactU16(w, ix.data.length);
    w.bytes(ix.data);
  }
  return { bytes: w.done(), keys, numSigners: ws.length + rs.length };
}

export interface SignedTx {
  wire: Uint8Array;
  /** base58 of the first signature (the payer's): the transaction id. */
  signature: string;
}

/** Signs a compiled message with every required signer (extra signers are ignored). */
export function signMessageWith(msg: CompiledMessage, signers: Signer[]): SignedTx {
  const byId = new Map(signers.map((s) => [s.id, s]));
  const sigs: Uint8Array[] = [];
  for (const k of msg.keys.slice(0, msg.numSigners)) {
    const s = byId.get(k);
    if (!s) throw new Error(`missing signer ${k}`);
    sigs.push(signBytes(s, msg.bytes));
  }
  const w = new Writer();
  compactU16(w, sigs.length);
  for (const s of sigs) w.bytes(s);
  w.bytes(msg.bytes);
  const wire = w.done();
  return { wire, signature: base58Encode(sigs[0]!) };
}

export function buildTransaction(payer: Signer, ixs: Ix[], recentBlockhash: string, extra: Signer[] = []): SignedTx {
  const tx = signMessageWith(compileMessage(payer.id, ixs, recentBlockhash), [payer, ...extra]);
  if (tx.wire.length > PACKET_LIMIT) throw new Error(`transaction is ${tx.wire.length} bytes, over the ${PACKET_LIMIT}-byte packet limit`);
  return tx;
}

// ---------- compute budget ----------

export const computeBudget = {
  limit: (units: number): Ix => ({ programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: new Writer().u8(2).u32(units).done() }),
  price: (microLamports: bigint | number): Ix => ({ programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: new Writer().u8(3).u64(microLamports).done() }),
};
