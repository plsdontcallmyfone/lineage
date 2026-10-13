#!/usr/bin/env bun
// Fee crank keeper: moves each launched agent coin's pump.fun creator fees into the agent's compute
// vault (pump.fun's sweep and collect, then units_launch crank_pump_fees, which splits them by the
// chain's fee split). Permissionless: any payer may send it; the payer only pays the network fee
// and, once per agent, the rent of the creator account's $UNITS token account.
//
//   bun scripts/mainnet/crank-fees.ts --core <Core url> --key <payer keypair.json> [--agent <id>] [--min-usd <n>] [--send]
//
// Dry run by default: it simulates every crank and prints what the vault would gain; --send sends the
// ones whose simulation succeeds and moves at least --min-usd (default 0.25) into the vault. An agent
// whose coin has graduated is cranked on its pool too. Agents with a fee route or a pool membership
// are skipped here (their crank needs the route accounts; the launch program refuses it otherwise).
import { ata, ChainReader, loadKeypair, pumpCrankIxs, pumpPdas, Rpc, sendAndConfirm, compileMessage, signBytes, TOKEN_2022_PROGRAM, launchPdas, decodeBondingCurve } from "@units/chain";
import { applyNetworkProfile, rpcUrlFor, stateFor } from "../../packages/chain/src/profile-node.ts";
import { COMPUTE_BUDGET_PROGRAM } from "../../packages/chain/src/tx.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
const SEND = argv.includes("--send");
const log = (m: string) => console.log(`[crank-fees] ${m}`);
const coreUrl = (opt("core") ?? "").replace(/\/+$/, "");
const keyFile = opt("key");
if (!coreUrl || !keyFile) throw new Error("usage: crank-fees.ts --core <url> --key <payer keypair.json> [--agent <id>] [--min-usd <n>] [--send]");
const minUsd = Number(opt("min-usd") ?? "0.25");

const profile = applyNetworkProfile();
const state = stateFor(profile) as { mint?: string; line_mint?: string };
const rpc = Rpc.http(rpcUrlFor(profile), "confirmed");
const reader = new ChainReader(rpc);
const payer = loadKeypair(keyFile);
const j = async (p: string) => (await fetch(`${coreUrl}${p}`, { signal: AbortSignal.timeout(20_000) })).json() as Promise<any>;

const cfg = await reader.launchConfig();
if (!cfg) throw new Error("the launch program is not initialized on this network");
const lineMint = cfg.lineMint ?? state.mint ?? state.line_mint;
if (!lineMint) throw new Error("no quote mint known");
const priceJ = await fetch(`${coreUrl}/market/quote-usd`, { signal: AbortSignal.timeout(20_000) }).then((r) => r.json()).catch(() => null) as any;
const usdPer = typeof priceJ?.usd === "number" && priceJ.ok ? priceJ.usd : null;
if (usdPer === null) throw new Error("no fresh quote price from the site: nothing is cranked without it");
const decimals = 6;
const usd = (base: bigint) => (Number(base) / 10 ** decimals) * usdPer;

const only = opt("agent");
const agents = ((await j("/v1/agents?hidden=1")) as any[]).filter((a) => a.mint && (!only || a.agent_id === only));
log(`${profile.network}: ${agents.length} launched agent(s), quote ${lineMint}, ${usdPer} USD per coin, payer ${payer.id}${SEND ? "" : " (dry run)"}`);

let sent = 0;
for (const a of agents) {
  const agent = a.agent_id as string, mint = a.mint as string, tag = `${agent.slice(0, 6)} (${mint.slice(0, 6)})`;
  try {
    const curveA = await rpc.getAccountInfo(pumpPdas.bondingCurve(mint));
    const complete = curveA ? decodeBondingCurve(curveA.data).complete : true;
    const pool = complete ? pumpPdas.pool(mint, lineMint) : undefined;
    // what waits: pump.fun's creator vault of the agent's creator account (curve fees) and what was collected but not cranked
    const creator = launchPdas.pumpCreator(agent);
    const waiting = ((await reader.tokenBalance(ata(pumpPdas.creatorVault(creator), lineMint, TOKEN_2022_PROGRAM))) ?? 0n) + ((await reader.tokenBalance(ata(creator, lineMint, TOKEN_2022_PROGRAM))) ?? 0n)
      + (pool ? ((await reader.tokenBalance(ata(pumpPdas.ammCreatorVault(creator), lineMint, TOKEN_2022_PROGRAM))) ?? 0n) : 0n);
    const ixs = pumpCrankIxs({ payer: payer.id, agent, agentMint: mint, lineMint, lineTokenProgram: TOKEN_2022_PROGRAM, pool });
    const { blockhash } = await rpc.getLatestBlockhash();
    const msg = compileMessage(payer.id, ixs, blockhash);
    const wire = new Uint8Array(1 + 64 + msg.bytes.length);
    wire[0] = 1;
    wire.set(await signBytes(payer, msg.bytes), 1);
    wire.set(msg.bytes, 65);
    log(`${tag}: ${waiting} base units of creator fees wait (${usd(waiting).toFixed(4)} USD before the fee split)`);
    if (usd(waiting) < minUsd) continue;
    const sim = await rpc.simulate(wire);
    if (sim.err) {
      log(`${tag}: skipped, simulation failed: ${JSON.stringify(sim.err).slice(0, 160)} ${(sim.logs ?? []).slice(-2).join(" | ").slice(0, 200)}`);
      continue;
    }
    if (!SEND) { log(`${tag}: simulation ok, would crank`); continue; }
    const r = await sendAndConfirm(rpc, payer, ixs, { log: (m: string) => log(`  ${m}`) });
    sent++;
    log(`${tag}: cranked ${r.signature}`);
  } catch (e) {
    log(`${tag}: ${(e as Error).message.slice(0, 220)}`);
  }
}
log(`done: ${sent} crank(s) sent`);
void COMPUTE_BUDGET_PROGRAM;
