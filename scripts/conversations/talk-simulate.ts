#!/usr/bin/env bun
// Simulates, on mainnet, the exact transaction the Talk page builds for one live agent: a System
// transfer of the minimum to the agent's wallet plus the SPL Memo that carries the text, with the
// compute budget the page asks for. READ ONLY: simulateTransaction with sigVerify off and a replaced
// blockhash; nothing is signed and nothing is sent. The sender is a public address that holds SOL
// (--from; any funded address works, it signs nothing here). The RPC comes from the network profile
// (never printed).
//   bun scripts/conversations/talk-simulate.ts --agent <agent id> --from <funded address> [--site https://...] [--text "..."]
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileMessage, computeBudget, Rpc, type Ix } from "@units/chain";
import { simulateDetailed } from "../../packages/chain/src/browser/client.ts";
import { unsignedWire } from "../../packages/chain/src/browser/wire.ts";
import { priorityFee, writableAccounts } from "../../packages/chain/src/fees.ts";
import { applyNetworkProfile, rpcUrlFor } from "../../packages/chain/src/profile-node.ts";
import { talkIxs } from "../../apps/web/wallet/talk-tx.ts";
import { TALK_PREFIX } from "../../packages/core/src/talk.ts";

const arg = (k: string, d?: string) => (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1]! : d);
const SITE = arg("site", "https://main-157-245-71-188.sslip.io")!;
const agent = arg("agent");
const from = arg("from");
if (!agent || !from) throw new Error("--agent and --from are required");
const text = arg("text", "What are you working on right now, and what did the last accepted change improve? ".repeat(4).slice(0, 280))!;
const LAMPORTS = BigInt(arg("lamports", "1000000")!);

const profile = applyNetworkProfile();
if (profile.network !== "mainnet") throw new Error("the active profile is not mainnet");
const rpc = Rpc.http(rpcUrlFor(profile), "confirmed");
if ((await rpc.call<string>("getGenesisHash")) !== "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d") throw new Error("the RPC endpoint is not mainnet");
const w = (await (await fetch(`${SITE}/api/agents/${agent}/wallet`)).json()) as { treasury: { address: string | null } };
if (!w.treasury?.address) throw new Error("the agent has no wallet address");
const ixs: Ix[] = talkIxs({ from, agent, wallet: w.treasury.address, lamports: LAMPORTS, prefix: TALK_PREFIX, text });
const price = (await priorityFee(rpc, writableAccounts(ixs, from), profile.fees)).microLamports;
const build = async (units: number) => {
  const { blockhash } = await rpc.getLatestBlockhash();
  const msg = compileMessage(from, [computeBudget.limit(units), computeBudget.price(price), ...ixs], blockhash);
  const wire = unsignedWire(msg);
  return { wire, sim: await simulateDetailed(rpc, wire) };
};
const first = await build(400_000);
const units = Math.ceil((first.sim.unitsConsumed ?? 400_000) * 1.2) + 2_000;
const exact = await build(units);
const out = {
  at: new Date().toISOString(),
  network: "mainnet",
  sent: false,
  agent,
  agent_wallet: w.treasury.address,
  from,
  memo_bytes: new TextEncoder().encode(`${TALK_PREFIX}${agent}:${text}`).length,
  text_bytes: new TextEncoder().encode(text).length,
  transaction_bytes: exact.wire.length,
  would_land: exact.sim.err === null,
  err: exact.sim.err,
  compute_units_used: exact.sim.unitsConsumed ?? null,
  compute_unit_limit: units,
  micro_lamports_per_unit: price,
  transfer_lamports: Number(LAMPORTS),
  fee_lamports: exact.sim.fee === null ? null : Number(exact.sim.fee),
  total_lamports: exact.sim.fee === null ? null : Number(LAMPORTS + exact.sim.fee),
  logs: exact.sim.logs.slice(0, 12),
};
writeFileSync(join(import.meta.dir, "TALK-SIMULATION-LAST.json"), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
