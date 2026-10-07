import { sha256, toAddress, Writer, type Address } from "./codec.ts";
import { ASSOCIATED_TOKEN_PROGRAM, ata, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./pda.ts";
import { r, w, type Ix } from "./registry.ts";

// System, SPL Token / Token-2022 and associated-token instructions used by the devnet scripts, and
// token account and mint decoders. Encodings follow the programs' instruction packers.

export const system = {
  transfer(from: Address, to: Address, lamports: bigint): Ix {
    return { programId: SYSTEM_PROGRAM, keys: [w(from, true), w(to)], data: new Writer().u32(2).u64(lamports).done() };
  },
  createAccount(from: Address, account: Address, lamports: bigint, space: number, owner: Address): Ix {
    return {
      programId: SYSTEM_PROGRAM,
      keys: [w(from, true), w(account, true)],
      data: new Writer().u32(0).u64(lamports).u64(space).address(owner).done(),
    };
  },
};

export const token = {
  /** Create the ATA if it does not exist (CreateIdempotent). */
  createAtaIdempotent(payer: Address, owner: Address, mint: Address, tokenProgram: Address = TOKEN_PROGRAM): Ix {
    return {
      programId: ASSOCIATED_TOKEN_PROGRAM,
      keys: [w(payer, true), w(ata(owner, mint, tokenProgram)), r(owner), r(mint), r(SYSTEM_PROGRAM), r(tokenProgram)],
      data: Uint8Array.of(1),
    };
  },
  initializeMint2(mint: Address, decimals: number, mintAuthority: Address, tokenProgram: Address = TOKEN_PROGRAM): Ix {
    return { programId: tokenProgram, keys: [w(mint)], data: new Writer().u8(20).u8(decimals).address(mintAuthority).u8(0).done() };
  },
  /** Token-2022 MetadataPointer::Initialize (must precede InitializeMint2). */
  initializeMetadataPointer(mint: Address, authority: Address, metadataAddress: Address): Ix {
    return { programId: TOKEN_2022_PROGRAM, keys: [w(mint)], data: new Writer().u8(39).u8(0).address(authority).address(metadataAddress).done() };
  },
  /** spl-token-metadata-interface Initialize on a Token-2022 mint that points at itself. */
  initializeTokenMetadata(mint: Address, updateAuthority: Address, mintAuthority: Address, name: string, symbol: string, uri: string): Ix {
    return {
      programId: TOKEN_2022_PROGRAM,
      keys: [w(mint), r(updateAuthority), r(mint), r(mintAuthority, true)],
      data: new Writer().bytes(sha256("spl_token_metadata_interface:initialize_account").subarray(0, 8)).string(name).string(symbol).string(uri).done(),
    };
  },
  mintTo(mint: Address, dest: Address, authority: Address, amount: bigint, tokenProgram: Address = TOKEN_PROGRAM): Ix {
    return { programId: tokenProgram, keys: [w(mint), w(dest), r(authority, true)], data: new Writer().u8(7).u64(amount).done() };
  },
  /** SetAuthority(MintTokens) to none: the supply is fixed for good. */
  revokeMintAuthority(mint: Address, current: Address, tokenProgram: Address = TOKEN_PROGRAM): Ix {
    return { programId: tokenProgram, keys: [w(mint), r(current, true)], data: new Writer().u8(6).u8(0).u8(0).done() };
  },
  transferChecked(source: Address, mint: Address, dest: Address, owner: Address, amount: bigint, decimals: number, tokenProgram: Address = TOKEN_PROGRAM): Ix {
    return { programId: tokenProgram, keys: [w(source), r(mint), w(dest), r(owner, true)], data: new Writer().u8(12).u64(amount).u8(decimals).done() };
  },
};

/** Size of a Token-2022 mint with only the MetadataPointer extension (before metadata is written). */
export const T22_MINT_WITH_POINTER = 234;
/** Bytes the TokenMetadata TLV entry adds (type, length, update authority, mint, three strings, empty additional fields). */
export const tokenMetadataLen = (name: string, symbol: string, uri: string) =>
  4 + 32 + 32 + 4 + Buffer.byteLength(name) + 4 + Buffer.byteLength(symbol) + 4 + Buffer.byteLength(uri) + 4;

export interface TokenAccount {
  mint: Address;
  owner: Address;
  amount: bigint;
}
/** Base layout shared by SPL Token and Token-2022 accounts. */
export function decodeTokenAccount(d: Uint8Array): TokenAccount {
  if (d.length < 165) throw new Error("not a token account");
  const amount = new DataView(d.buffer, d.byteOffset + 64, 8).getBigUint64(0, true);
  return { mint: toAddress(d.subarray(0, 32)), owner: toAddress(d.subarray(32, 64)), amount };
}

export interface MintInfo {
  mintAuthority: Address | null;
  supply: bigint;
  decimals: number;
  freezeAuthority: Address | null;
}
export function decodeMint(d: Uint8Array): MintInfo {
  if (d.length < 82) throw new Error("not a mint");
  const dv = new DataView(d.buffer, d.byteOffset, d.length);
  return {
    mintAuthority: dv.getUint32(0, true) ? toAddress(d.subarray(4, 36)) : null,
    supply: dv.getBigUint64(36, true),
    decimals: d[44]!,
    freezeAuthority: dv.getUint32(46, true) ? toAddress(d.subarray(50, 82)) : null,
  };
}

/** Name, symbol and uri from a Token-2022 mint's TokenMetadata extension, if present. */
export function decodeT22Metadata(d: Uint8Array): { name: string; symbol: string; uri: string } | null {
  // TLV entries start after the 165-byte account-sized base plus the 1-byte account type.
  let o = 166;
  const dv = new DataView(d.buffer, d.byteOffset, d.length);
  while (o + 4 <= d.length) {
    const type = dv.getUint16(o, true);
    const len = dv.getUint16(o + 2, true);
    if (type === 19) {
      let p = o + 4 + 64;
      const str = () => {
        const n = dv.getUint32(p, true);
        const s = new TextDecoder().decode(d.subarray(p + 4, p + 4 + n));
        p += 4 + n;
        return s;
      };
      return { name: str(), symbol: str(), uri: str() };
    }
    if (type === 0) break;
    o += 4 + len;
  }
  return null;
}

