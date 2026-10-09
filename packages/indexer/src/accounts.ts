import { toAddress, type Address } from "@lineage/chain";

// Account readers the indexer needs beyond packages/chain: Meteora pool prices, DBC config curve
// numbers, Token-2022 mints (supply, decimals, the metadata extension's name and symbol) and token
// account amounts. Offsets include the 8-byte discriminator and follow Meteora's official IDLs (DBC
// PoolState / PoolConfig, DAMM v2 Pool), the same offsets onchain/programs/lineage-launch/src/meteora.rs
// reads and the LiteSVM suite checks.

const dv = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.length);
const u64 = (d: Uint8Array, o: number) => dv(d).getBigUint64(o, true);
const u128 = (d: Uint8Array, o: number) => u64(d, o) | (u64(d, o + 8) << 64n);
const key = (d: Uint8Array, o: number) => toAddress(d.subarray(o, o + 32));

export interface DbcPoolState {
  config: Address;
  baseMint: Address;
  baseVault: Address;
  quoteVault: Address;
  baseReserve: bigint;
  quoteReserve: bigint;
  sqrtPrice: bigint;
  isMigrated: boolean;
  migrationProgress: number;
}
export function readDbcPool(d: Uint8Array): DbcPoolState {
  if (d.length < 424) throw new Error("not a DBC VirtualPool");
  return {
    config: key(d, 72), baseMint: key(d, 136), baseVault: key(d, 168), quoteVault: key(d, 200), baseReserve: u64(d, 232), quoteReserve: u64(d, 240),
    sqrtPrice: u128(d, 280), isMigrated: d[305] === 1, migrationProgress: d[308]!,
  };
}

export interface DbcConfigState {
  quoteMint: Address;
  migrationQuoteThreshold: bigint;
  sqrtStartPrice: bigint;
}
export function readDbcConfig(d: Uint8Array): DbcConfigState {
  if (d.length < 408) throw new Error("not a DBC PoolConfig");
  return { quoteMint: key(d, 8), migrationQuoteThreshold: u64(d, 264), sqrtStartPrice: u128(d, 392) };
}

export interface DammPoolState {
  tokenAMint: Address;
  tokenBMint: Address;
  tokenAVault: Address;
  tokenBVault: Address;
  liquidity: bigint;
  sqrtPrice: bigint;
}
export function readDammPool(d: Uint8Array): DammPoolState {
  if (d.length < 680) throw new Error("not a DAMM v2 Pool");
  return { tokenAMint: key(d, 168), tokenBMint: key(d, 200), tokenAVault: key(d, 232), tokenBVault: key(d, 264), liquidity: u128(d, 360),
    sqrtPrice: u128(d, 456) };
}

export interface MintState {
  supply: bigint;
  decimals: number;
  name: string | null;
  symbol: string | null;
  uri: string | null;
}
/** SPL Token or Token-2022 mint; name, symbol and URI from the Token-2022 TokenMetadata extension (type 19). */
export function readMint(d: Uint8Array): MintState {
  if (d.length < 82) throw new Error("not a mint");
  const out: MintState = { supply: u64(d, 36), decimals: d[44]!, name: null, symbol: null, uri: null };
  if (d.length > 166 && d[165] === 1) {
    let o = 166;
    while (o + 4 <= d.length) {
      const type = dv(d).getUint16(o, true);
      const len = dv(d).getUint16(o + 2, true);
      const v = d.subarray(o + 4, o + 4 + len);
      if (type === 19 && v.length >= 64 + 12) {
        let p = 64;
        const str = () => {
          const n = dv(v).getUint32(p, true);
          const s = new TextDecoder().decode(v.subarray(p + 4, p + 4 + n));
          p += 4 + n;
          return s;
        };
        try {
          out.name = str();
          out.symbol = str();
          out.uri = str();
        } catch {
          /* truncated metadata */
        }
      }
      if (type === 0 && len === 0) break;
      o += 4 + len;
    }
  }
  return out;
}

/** Token account: mint, owner, amount (SPL Token and Token-2022 share the first 72 bytes). */
export function readTokenAccount(d: Uint8Array): { mint: Address; owner: Address; amount: bigint } {
  if (d.length < 72) throw new Error("not a token account");
  return { mint: key(d, 0), owner: key(d, 32), amount: u64(d, 64) };
}
