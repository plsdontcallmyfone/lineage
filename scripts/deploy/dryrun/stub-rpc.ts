#!/usr/bin/env bun
// Dry run only (scripts/deploy/dryrun.sh): a stand-in for a mainnet RPC, so the second instance can be
// started under the mainnet profile before the programs exist on mainnet. It answers getGenesisHash
// with mainnet's genesis and serves DEVNET's chain under the mainnet program ids: a request naming a
// mainnet program id or one of its fixed PDAs (configs, vaults, authorities) is forwarded to devnet
// with the devnet counterpart, and devnet's program ids in the answer are renamed back. Everything
// else is forwarded unchanged. Sends are refused. Nothing here is mainnet data and nothing is sent
// anywhere but devnet reads.
//
//   bun scripts/deploy/dryrun/stub-rpc.ts --port 9799 [--upstream https://api.devnet.solana.com]
import { launchPdas, msgPdas, PROGRAM_IDS, registryPdas, useProfilePrograms } from "@units/chain";

const argv = process.argv.slice(2);
const arg = (k: string, d: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1]! : d);
const PORT = Number(arg("port", "9799"));
const UP = arg("upstream", "https://api.devnet.solana.com");
export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

/** Every address derived from the program ids alone, under one network's ids. */
function fixed(network: "devnet" | "mainnet"): Record<string, string> {
  useProfilePrograms({ network, programs: PROGRAM_IDS[network] });
  const out: Record<string, string> = { "program:registry": PROGRAM_IDS[network].registry, "program:launch": PROGRAM_IDS[network].launch, "program:msg": PROGRAM_IDS[network].msg };
  for (const [ns, o] of Object.entries({ registry: registryPdas, launch: launchPdas, msg: msgPdas }))
    for (const [k, f] of Object.entries(o as Record<string, (...a: unknown[]) => string>)) if (typeof f === "function" && f.length === 0) out[`${ns}:${k}`] = f();
  return out;
}
const dev = fixed("devnet"), main = fixed("mainnet");
const toDev = Object.keys(main).map((k) => [main[k]!, dev[k]!] as const).filter(([a, b]) => a !== b);
const PROGRAM_KEYS = ["program:registry", "program:launch", "program:msg"];
const toMain = PROGRAM_KEYS.map((k) => [dev[k]!, main[k]!] as const);
const swap = (s: string, pairs: readonly (readonly [string, string])[]) => pairs.reduce((acc, [a, b]) => acc.split(a).join(b), s);

const REFUSED = new Set(["sendTransaction", "sendBundle", "requestAirdrop"]);

if (import.meta.main) {
  Bun.serve({
    port: PORT,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method !== "POST") return new Response("stub mainnet RPC (dry run): devnet data under mainnet's genesis and program ids\n");
      const text = await req.text();
      let body: { id?: unknown; method?: string } | null = null;
      try {
        body = JSON.parse(text);
      } catch {
        return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 });
      }
      if (Array.isArray(body)) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "the dry-run stub takes one request at a time" } }, { status: 400 });
      if (body?.method === "getGenesisHash") return Response.json({ jsonrpc: "2.0", id: body.id ?? 1, result: MAINNET_GENESIS });
      if (body?.method && REFUSED.has(body.method)) return Response.json({ jsonrpc: "2.0", id: body.id ?? 1, error: { code: -32000, message: "dry-run stub: nothing is sent" } });
      const r = await fetch(UP, { method: "POST", headers: { "content-type": "application/json" }, body: swap(text, toDev) }).catch((e) => e as Error);
      if (r instanceof Error) return Response.json({ jsonrpc: "2.0", id: body?.id ?? 1, error: { code: -32000, message: `stub upstream: ${r.message}` } }, { status: 502 });
      return new Response(swap(await r.text(), toMain), { status: r.status, headers: { "content-type": "application/json" } });
    },
  });
  console.log(`stub mainnet RPC on 127.0.0.1:${PORT}: devnet reads from ${new URL(UP).host}, mainnet genesis, ${toDev.length} addresses renamed`);
}
