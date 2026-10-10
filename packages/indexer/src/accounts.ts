import { toAddress, type Address } from "@lineage/chain";

// Account readers the indexer needs beyond packages/chain (whose pump.ts decodes pump.fun's Global,
// BondingCurve, Pool and fee configs): Token-2022 mints (supply, decimals, the metadata extension's
// name and symbol) and token account amounts.

const dv = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.length);
const u64 = (d: Uint8Array, o: number) => dv(d).getBigUint64(o, true);
const key = (d: Uint8Array, o: number) => toAddress(d.subarray(o, o + 32));

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
