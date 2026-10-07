import { createHash } from "node:crypto";
import { base58Decode, base58Encode } from "@lineage/protocol";

// Borsh encoding as Anchor writes it, with no dependency: u64/i64/u128 are bigint, keys base58.

export type Address = string;

export function sha256(...parts: (Uint8Array | string)[]): Uint8Array {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

/** 32 bytes of a base58 address (left-padded, as Solana keys are). */
export function addressBytes(a: Address): Uint8Array {
  const raw = base58Decode(a);
  if (raw.length > 32) throw new Error(`not a 32-byte address: ${a}`);
  const out = new Uint8Array(32);
  out.set(raw, 32 - raw.length);
  return out;
}
export const toAddress = (b: Uint8Array): Address => base58Encode(b);

export const hexToBytes = (h: string): Uint8Array => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
export const bytesToHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** Anchor instruction discriminator: sha256("global:<name>")[..8]. */
export const ixDisc = (name: string): Uint8Array => sha256(`global:${name}`).subarray(0, 8);
/** Anchor account discriminator: sha256("account:<Name>")[..8]. */
export const accountDisc = (name: string): Uint8Array => sha256(`account:${name}`).subarray(0, 8);

export class Writer {
  private parts: number[] = [];
  bytes(b: Uint8Array): this {
    for (const x of b) this.parts.push(x);
    return this;
  }
  u8(n: number): this {
    this.parts.push(n & 0xff);
    return this;
  }
  bool(b: boolean): this {
    return this.u8(b ? 1 : 0);
  }
  private uint(n: bigint, size: number): this {
    if (n < 0n || n >= 1n << BigInt(size * 8)) throw new Error(`u${size * 8} out of range: ${n}`);
    for (let i = 0; i < size; i++) this.parts.push(Number((n >> BigInt(8 * i)) & 0xffn));
    return this;
  }
  u16(n: number): this {
    return this.uint(BigInt(n), 2);
  }
  u32(n: number): this {
    return this.uint(BigInt(n), 4);
  }
  u64(n: bigint | number): this {
    return this.uint(BigInt(n), 8);
  }
  i64(n: bigint | number): this {
    return this.uint(BigInt.asUintN(64, BigInt(n)), 8);
  }
  u128(n: bigint): this {
    return this.uint(n, 16);
  }
  address(a: Address): this {
    return this.bytes(addressBytes(a));
  }
  fixed32(b: Uint8Array | string): this {
    const v = typeof b === "string" ? hexToBytes(b) : b;
    if (v.length !== 32) throw new Error("expected 32 bytes");
    return this.bytes(v);
  }
  string(s: string): this {
    const b = new TextEncoder().encode(s);
    return this.u32(b.length).bytes(b);
  }
  vec32(items: (Uint8Array | string)[]): this {
    this.u32(items.length);
    for (const i of items) this.fixed32(i);
    return this;
  }
  done(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

export class Reader {
  private o = 0;
  constructor(private d: Uint8Array) {}
  private take(n: number): Uint8Array {
    if (this.o + n > this.d.length) throw new Error("account data too short");
    const v = this.d.subarray(this.o, this.o + n);
    this.o += n;
    return v;
  }
  private uint(size: number): bigint {
    const b = this.take(size);
    let n = 0n;
    for (let i = size - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]!);
    return n;
  }
  u8 = () => Number(this.uint(1));
  bool = () => this.u8() !== 0;
  u16 = () => Number(this.uint(2));
  u32 = () => Number(this.uint(4));
  u64 = () => this.uint(8);
  i64 = () => BigInt.asIntN(64, this.uint(8));
  u128 = () => this.uint(16);
  address = () => toAddress(this.take(32));
  hex32 = () => bytesToHex(this.take(32));
  string = () => new TextDecoder().decode(this.take(this.u32()));
  /** Bytes left to read (an account written by an older, shorter layout has fewer). */
  remaining = () => this.d.length - this.o;
  /** Checks and skips the 8-byte Anchor account discriminator. */
  expect(name: string): this {
    const got = this.take(8);
    const want = accountDisc(name);
    if (!got.every((x, i) => x === want[i])) throw new Error(`not a ${name} account`);
    return this;
  }
}
