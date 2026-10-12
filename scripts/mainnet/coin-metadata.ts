#!/usr/bin/env bun
// A coin's metadata, as wallets and pump.fun see it. Read only: prints, for each mint, the name, symbol
// and metadata URI recorded on chain (the Token-2022 metadata extension that pump.fun's create_v2
// writes, or the Metaplex metadata account of an older SPL Token coin) and whether that URI resolves
// to usable metadata JSON with an image that loads. Sends nothing; prints no endpoint.
//
//   bun scripts/mainnet/coin-metadata.ts <mint> [<mint> ...] [--devnet] [--json]
//
// Exits 0 only when every mint's URI resolves. Reads through UNITS_MAINNET_RPC when set (environment
// or ~/.config/units/rpc.env), else the public endpoint.
import { addressBytes, checkMetadataUri, pda, Rpc, TOKEN_2022_PROGRAM, type UriCheck } from "@units/chain";
import { readMint } from "../../packages/indexer/src/accounts.ts";
import { loadNetworkProfile, rpcUrlFor } from "../../packages/chain/src/profile-node.ts";
import { devnetRpcUrl } from "../../packages/chain/src/endpoint.ts";

const METAPLEX = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

/** Name, symbol and URI of a Metaplex metadata account (key, update authority, mint, then three borsh strings). */
export function readMetaplex(d: Uint8Array): { name: string; symbol: string; uri: string } | null {
  if (d.length < 69 || d[0] !== 4) return null;
  const dv = new DataView(d.buffer, d.byteOffset, d.length);
  let p = 65;
  const str = () => {
    const n = dv.getUint32(p, true);
    const s = new TextDecoder().decode(d.subarray(p + 4, p + 4 + n)).replace(/\0+$/, "");
    p += 4 + n;
    return s;
  };
  try {
    return { name: str(), symbol: str(), uri: str() };
  } catch {
    return null;
  }
}

export interface CoinReport { mint: string; exists: boolean; standard: string | null; name: string | null; symbol: string | null; uri: string | null; check: UriCheck | null }

export async function coinReport(rpc: Rpc, mint: string, f: typeof fetch = fetch): Promise<CoinReport> {
  const acct = await rpc.getAccountInfo(mint);
  if (!acct) return { mint, exists: false, standard: null, name: null, symbol: null, uri: null, check: null };
  let meta: { name: string | null; symbol: string | null; uri: string | null } | null = null;
  let standard: string | null = null;
  if (acct.owner === TOKEN_2022_PROGRAM) {
    const m = readMint(acct.data);
    if (m.uri !== null) (meta = m), (standard = "Token-2022 metadata extension");
  }
  if (!meta) {
    const mp = await rpc.getAccountInfo(pda(METAPLEX, "metadata", addressBytes(METAPLEX), addressBytes(mint)));
    const m = mp ? readMetaplex(mp.data) : null;
    if (m) (meta = m), (standard = "Metaplex metadata account");
  }
  if (!meta?.uri) return { mint, exists: true, standard, name: meta?.name ?? null, symbol: meta?.symbol ?? null, uri: null, check: null };
  return { mint, exists: true, standard, name: meta.name, symbol: meta.symbol, uri: meta.uri, check: await checkMetadataUri(meta.uri, { fetch: f }) };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const mints = argv.filter((a) => !a.startsWith("--"));
  if (!mints.length) {
    console.error("usage: bun scripts/mainnet/coin-metadata.ts <mint> [<mint> ...] [--devnet] [--json]");
    process.exit(2);
  }
  let url = argv.includes("--devnet") ? devnetRpcUrl() : "https://api.mainnet-beta.solana.com";
  if (!argv.includes("--devnet"))
    try {
      url = rpcUrlFor(loadNetworkProfile({ env: { ...process.env, UNITS_NETWORK: "mainnet", UNITS_PROFILE_LOCAL: undefined } }));
    } catch { /* no keyed endpoint: the public one, for reads */ }
  const rpc = Rpc.http(url, "confirmed");
  let bad = 0;
  const out: CoinReport[] = [];
  for (const mint of mints) {
    const r = await coinReport(rpc, mint);
    out.push(r);
    if (!r.check?.ok) bad++;
    if (argv.includes("--json")) continue;
    console.log(`[coin] ${mint}`);
    if (!r.exists) {
      console.log("[coin]   NO   no account at this address");
      continue;
    }
    console.log(`[coin]        on chain: ${r.name ?? "no name"} (${r.symbol ?? "no symbol"}), ${r.standard ?? "no metadata found"}`);
    console.log(`[coin]        URI: ${r.uri ?? "none"}`);
    if (!r.check) continue;
    console.log(`[coin]   ${r.check.ok ? "ok  " : "NO  "} ${r.check.ok ? "the URI resolves to metadata with an image that loads" : `the URI does not resolve: ${r.check.problem}`}`);
    if (r.check.metadata) console.log(`[coin]        ${JSON.stringify(r.check.metadata)}`);
    if (r.check.image) console.log(`[coin]        image ${r.check.image.type}, ${r.check.image.bytes} bytes`);
  }
  if (argv.includes("--json")) console.log(JSON.stringify(out, null, 2));
  process.exit(bad ? 1 : 0);
}
