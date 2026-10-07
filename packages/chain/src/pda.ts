import { addressBytes, sha256, toAddress, type Address } from "./codec.ts";

// Program-derived addresses without a Solana SDK. An address is a PDA only if it is not a valid
// ed25519 point, checked the way curve25519-dalek's decompress does: y = bytes (top bit cleared)
// reduced mod p, on the curve iff (y^2 - 1) / (d y^2 + 1) is a square mod p.

const P = 2n ** 255n - 19n;
const D = (-121665n * modInv(121666n)) % P;
function mod(a: bigint): bigint {
  const r = a % P;
  return r < 0n ? r + P : r;
}
function modPow(b: bigint, e: bigint): bigint {
  let r = 1n;
  b = mod(b);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}
function modInv(a: bigint): bigint {
  return modPow(a, P - 2n);
}

export function isOnCurve(bytes: Uint8Array): boolean {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i]! & 0x7f : bytes[i]!);
  y = mod(y);
  const y2 = (y * y) % P;
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const x2 = (u * modInv(v)) % P;
  if (x2 === 0n) return true;
  return modPow(x2, (P - 1n) / 2n) === 1n;
}

const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

export function createProgramAddress(seeds: Uint8Array[], programId: Address): Address {
  const h = sha256(...seeds, addressBytes(programId), PDA_MARKER);
  if (isOnCurve(h)) throw new Error("seeds produce an on-curve address");
  return toAddress(h);
}

export function findProgramAddress(seeds: Uint8Array[], programId: Address): [Address, number] {
  for (let bump = 255; bump >= 0; bump--) {
    try {
      return [createProgramAddress([...seeds, Uint8Array.of(bump)], programId), bump];
    } catch {
      // next bump
    }
  }
  throw new Error("no viable bump");
}

export const pda = (programId: Address, ...seeds: (Uint8Array | string)[]): Address =>
  findProgramAddress(seeds.map((s) => (typeof s === "string" ? new TextEncoder().encode(s) : s)), programId)[0];

export const u64le = (n: bigint | number): Uint8Array => {
  const out = new Uint8Array(8);
  let v = BigInt(n);
  for (let i = 0; i < 8; i++, v >>= 8n) out[i] = Number(v & 0xffn);
  return out;
};

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const BPF_LOADER_UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111";

/** Associated token account of `owner` for `mint` under `tokenProgram`. */
export const ata = (owner: Address, mint: Address, tokenProgram: Address = TOKEN_PROGRAM): Address =>
  pda(ASSOCIATED_TOKEN_PROGRAM, addressBytes(owner), addressBytes(tokenProgram), addressBytes(mint));
