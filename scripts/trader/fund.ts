#!/usr/bin/env bun
// Funding for the devnet trading run (plan T exit), every transfer logged in onchain/DEVNET.md:
//   prep      the deployer sends the runtime authority SOL for treasury gas top-ups, and each TEST
//             launcher the tLINE of its allocation (a launcher's own wallet, as at launch);
//   allocate  each TEST launcher sends its allocation to the published allocation escrow with the memo
//             `lineage-trade-alloc:<agent>` (what the launch form's optional field sends); the site
//             runtime forwards it to the agent's treasury once the agent is bound.
// Keys are passed explicitly (the deployer at ~/.config/lineage/devnet-deployer.json, launchers under
// ~/.config/lineage/devnet/); the global solana config is never read.
// Usage: bun scripts/trader/fund.ts prep|allocate --site https://157-245-71-188.sslip.io --agent <id>=<launcher key file> [...]
//        [--line 1000] [--sol 0.5]
import { homedir } from "node:os";
import { join } from "node:path";
import { ata, loadKeypair, Rpc, sendAndConfirm, system, token, TOKEN_2022_PROGRAM } from "@lineage/chain";
import { devnetRpcUrl } from "../../packages/chain/src/endpoint.ts";
import { assertDevnet } from "../../packages/chain/src/browser/client.ts";
import { ALLOCATION_MEMO, memoIx } from "../../packages/trader/src/funding.ts";
import { logTx } from "./devnet-log.ts";

const argv = process.argv.slice(2);
const mode = argv[0];
const arg = (n: string, d?: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1]! : d);
const SITE = arg("site", "https://157-245-71-188.sslip.io")!;
const pairs = argv.flatMap((a, i) => (argv[i - 1] === "--agent" ? [a] : []));
const rpc = Rpc.http(devnetRpcUrl(), "confirmed");
await assertDevnet(rpc);
const state = (await (await fetch(`${SITE}/chain/config`)).json()).state;
const LINE = state.line_mint as string;
const DEC = Number(state.line_decimals);
const amount = BigInt(Math.round(Number(arg("line", "1000")) * 10 ** DEC));
const dep = loadKeypair(join(homedir(), ".config/lineage/devnet-deployer.json"));
const key = (f: string) => loadKeypair(f.startsWith("/") ? f : join(homedir(), ".config/lineage/devnet", f));

if (mode === "prep") {
  const runtime = state.runtime_authority as string;
  const sol = BigInt(Math.round(Number(arg("sol", "0.5")) * 1e9));
  const r = await sendAndConfirm(rpc, dep, [system.transfer(dep.id, runtime, sol)]);
  logTx(`prep: ${Number(sol) / 1e9} SOL from the deployer to the runtime authority ${runtime} (treasury gas top-ups)`, r.signature, r.fee);
  console.log(`runtime authority +${Number(sol) / 1e9} SOL: ${r.signature}`);
  for (const p of pairs) {
    const [agent, f] = p.split("=");
    const l = key(f!);
    const have = (await rpc.getMultipleAccounts([ata(l.id, LINE, TOKEN_2022_PROGRAM)]))[0];
    const r2 = await sendAndConfirm(rpc, dep, [
      token.createAtaIdempotent(dep.id, l.id, LINE, TOKEN_2022_PROGRAM),
      token.transferChecked(ata(dep.id, LINE, TOKEN_2022_PROGRAM), LINE, ata(l.id, LINE, TOKEN_2022_PROGRAM), dep.id, amount, DEC, TOKEN_2022_PROGRAM),
    ]);
    logTx(`prep: ${amount} tLINE base units from the deployer to TEST launcher ${l.id} (allocation for agent ${agent})${have ? "" : ", its tLINE account created"}`, r2.signature, r2.fee);
    console.log(`launcher ${l.id} +${amount}: ${r2.signature}`);
  }
} else if (mode === "allocate") {
  const tc = await (await fetch(`${SITE}/api/trading/config`)).json();
  const escrow = tc.allocation_escrow as string | null;
  if (!escrow) throw new Error("the site publishes no allocation_escrow yet (GET /v1/trading/config)");
  for (const p of pairs) {
    const [agent, f] = p.split("=");
    const l = key(f!);
    const r = await sendAndConfirm(rpc, l, [token.transferChecked(ata(l.id, LINE, TOKEN_2022_PROGRAM), LINE, escrow, l.id, amount, DEC, TOKEN_2022_PROGRAM), memoIx(`${ALLOCATION_MEMO}${agent}`)]);
    logTx(`allocate: TEST launcher ${l.id} sends ${amount} tLINE base units to the allocation escrow ${escrow} for agent ${agent} (memo)`, r.signature, r.fee);
    console.log(`allocation for ${agent}: ${r.signature}`);
  }
} else throw new Error("usage: fund.ts prep|allocate ...");
