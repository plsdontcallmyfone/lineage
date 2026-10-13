#!/usr/bin/env bun
// Fee crank keeper: moves each launched agent coin's pump.fun creator fees into the agent's compute
// vault (pump.fun's sweep and collect, then units_launch crank_pump_fees, which splits them by the
// chain's fee split). Permissionless: any payer may send it; the payer only pays the network fee
// and, once per agent, the rent of the creator account's $UNITS token account.
//
//   bun scripts/mainnet/crank-fees.ts --core <Core url> --key <payer keypair.json> [--agent <id>] [--min-usd <n>] [--table <address>] [--send]
//
// Dry run by default: it simulates every crank and prints what the vault would gain; --send sends the
// ones whose simulation succeeds and moves at least --min-usd (default 0.25) into the vault. An agent
// whose coin has graduated is cranked on its pool too. An agent with a GitHub fee route or a pool
// membership gets its route accounts after the crank's eight while the chain's feature bit is on (the
// launch program refuses the crank without them, MissingRouteAccounts); an agent with neither, and
// every agent while the bits are off, gets the eight-account crank as before.
//
// Every agent goes through one path (packages/chain/src/crank-tx.ts): the transaction is built as it
// would be sent, priority fee instruction included, and its size decides the form. It is a legacy
// transaction when that fits the 1,232-byte packet, and a version 0 transaction that loads its fixed
// accounts from the launch lookup table (`launch_lookup_table` of the network's state file, or
// --table) when legacy does not fit: a pool member whose coin has graduated, with or without a fee
// route. Each line says which form and how many bytes. The table is the frozen one the launches use;
// this script creates no table and pays no rent for one. A crank that fits neither form is not sent
// and the line states both sizes.
import { ata, buildFitted, ChainReader, claimPdas, claims, decodeAgentLaunch, decodeFeeRoute, decodePool, decodePoolMember, FEATURES, loadKeypair, loadLookupTable, poolPdas, pools, pumpCrankIxs, pumpPdas, Rpc, sendFitted, decodePumpPool,
  TOKEN_2022_PROGRAM, launchPdas, decodeBondingCurve, TxTooLargeError, type AccountMeta, type LookupTable } from "@units/chain";
import { applyNetworkProfile, rpcUrlFor, stateFor } from "../../packages/chain/src/profile-node.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
const SEND = argv.includes("--send");
const log = (m: string) => console.log(`[crank-fees] ${m}`);
const coreUrl = (opt("core") ?? "").replace(/\/+$/, "");
const keyFile = opt("key");
if (!coreUrl || !keyFile) throw new Error("usage: crank-fees.ts --core <url> --key <payer keypair.json> [--agent <id>] [--min-usd <n>] [--table <address>] [--send]");
const minUsd = Number(opt("min-usd") ?? "0.25");

const profile = applyNetworkProfile();
const state = stateFor(profile) as { mint?: string; line_mint?: string; launch_lookup_table?: string };
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
// the lookup table a crank too large for a legacy transaction loads its fixed accounts from; read once per run, never written
const tableAt = opt("table") ?? state.launch_lookup_table;
let tables: LookupTable[] = [];
if (!tableAt) log("lookup table: none named (no launch_lookup_table in the state file, no --table): legacy transactions only");
else {
  const t = await loadLookupTable(rpc, tableAt).catch((e) => ({ table: null, reason: `could not be read: ${(e as Error).message.slice(0, 120)}` }));
  if (t.table) tables = [t.table];
  log(t.table ? `lookup table ${tableAt}: ${t.table.addresses.length} addresses, ${t.reason}` : `lookup table ${tableAt} is not usable (${t.reason}): legacy transactions only`);
}

let sent = 0, sentV0 = 0;
for (const a of agents) {
  const agent = a.agent_id as string, mint = a.mint as string, tag = `${agent.slice(0, 6)} (${mint.slice(0, 6)})`;
  try {
    // the pool's accounts join the crank once pump.fun has migrated the coin (a complete curve whose pool does not exist yet is cranked on its curve)
    const [curveA, poolA, alA, frA, pmA] = await rpc.getMultipleAccounts([pumpPdas.bondingCurve(mint), pumpPdas.pool(mint, lineMint), launchPdas.agentLaunch(mint), claimPdas.feeRoute(agent), poolPdas.member(agent)]);
    const complete = curveA ? decodeBondingCurve(curveA.data).complete : true;
    const pool = complete && poolA ? poolA.address : undefined;
    // what waits: fees still inside the curve and the pool (pump.fun's sweep moves them out), pump.fun's creator vaults of the agent's creator account, and what was collected but not cranked
    const creator = launchPdas.pumpCreator(agent);
    const held = await reader.tokenBalances([ata(pumpPdas.creatorVault(creator), lineMint, TOKEN_2022_PROGRAM), ata(creator, lineMint, TOKEN_2022_PROGRAM), ...(pool ? [ata(pumpPdas.ammCreatorVault(creator), lineMint, TOKEN_2022_PROGRAM)] : [])]);
    const waiting = held.reduce<bigint>((s, b) => s + (b ?? 0n), 0n) + (curveA ? decodeBondingCurve(curveA.data).creatorFee : 0n) + (pool ? decodePumpPool(poolA!.data).creatorFees : 0n);
    // the route accounts, in the program's order (GitHub route first, then the pool), only for what is switched on and set for this agent
    const routes: AccountMeta[] = [];
    const active = alA ? cfg.features & decodeAgentLaunch(alA.data).routes : 0;
    if (active & FEATURES.githubFees && frA) routes.push(...claims.crankRouteKeys(agent, decodeFeeRoute(frA.data).githubId));
    if (active & FEATURES.pools && pmA) {
      const memberPoolA = await rpc.getAccountInfo(decodePoolMember(pmA.data).pool);
      if (memberPoolA) routes.push(...pools.crankRouteKeys(agent, decodePool(memberPoolA.data).repoId, lineMint, TOKEN_2022_PROGRAM));
    }
    const ixs = pumpCrankIxs({ payer: payer.id, agent, agentMint: mint, lineMint, lineTokenProgram: TOKEN_2022_PROGRAM, pool, routes });
    // the transaction as it would be sent (fee policy applied), in the form its size allows
    const built = await buildFitted(rpc, payer, ixs, { tables }).catch((e) => {
      if (!(e instanceof TxTooLargeError)) throw e;
      log(`${tag}: not sent, ${e.message}`);
      return null;
    });
    if (!built) continue;
    const { fit } = built;
    const form = fit.form === "legacy" ? `legacy transaction, ${fit.size} bytes` : `v0 transaction, ${fit.size} bytes (${fit.legacySize} as legacy), ${fit.loaded} accounts from the lookup table`;
    log(`${tag}: ${waiting} base units of creator fees wait (${usd(waiting).toFixed(4)} USD before the fee split)${pool ? "; graduated, pool fees included" : ""}${routes.length ? `; ${routes.length} route accounts follow the crank's` : ""}; ${form}`);
    if (usd(waiting) < minUsd) continue;
    const sim = await rpc.simulate(built.tx.wire);
    if (sim.err) {
      log(`${tag}: skipped, simulation failed: ${JSON.stringify(sim.err).slice(0, 160)} ${(sim.logs ?? []).slice(-2).join(" | ").slice(0, 200)}`);
      continue;
    }
    if (!SEND) { log(`${tag}: simulation ok, would crank (${fit.form})`); continue; }
    const r = await sendFitted(rpc, payer, ixs, { ...built.options, log: (m: string) => log(`  ${m}`) });
    sent++;
    if (r.form === "v0") sentV0++;
    log(`${tag}: cranked ${r.signature} (${r.form}, ${r.size} bytes${r.fee !== undefined ? `, fee ${r.fee} lamports` : ""})`);
  } catch (e) {
    log(`${tag}: ${(e as Error).message.slice(0, 220)}`);
  }
}
log(`done: ${sent} crank(s) sent (${sent - sentV0} legacy, ${sentV0} v0)`);
