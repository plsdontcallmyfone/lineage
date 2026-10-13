#!/usr/bin/env bun
// join_pool for a LIVE mainnet agent, simulated on mainnet with nothing sent (docs/plans/AGENT-POOLS.md
// 11). Read-only RPC and simulation only: no key file is read and nothing is signed. The transaction is
// the one the Pools page builds (the same builder, compute limit and cost arithmetic), with the agent's
// owner as read from the registry as its signer and signature checks off.
//
//   set -a; . ~/.config/units/rpc.env; set +a      # UNITS_MAINNET_RPC, never printed
//   bun scripts/mainnet/pool-join-simulate.ts [--agent <agent id>]...
//
// Without --agent: the two live agents on karpathy/minbpe. Each is simulated against the chain as it
// is, so with no pool yet each one is simulated as the pool's first member. Also simulated: the same
// join signed by a wallet that is not the owner (must be refused). Writes POOL-JOIN-SIMULATE-LAST.json.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChainReader, claimPdas, decodeFeeRoute, decodePool, decodePoolConfig, FEATURES, MAX_POOL_FEE_BPS, poolPdas, pools, Rpc, TOKEN_2022_PROGRAM } from "@units/chain";
import { compileMessage, computeBudget, simulateDetailed, unsignedWire } from "../../packages/chain/src/browser/index.ts";
import { applyNetworkProfile, rpcUrlFor } from "../../packages/chain/src/profile-node.ts";
import { joinCost, joinFacts, joinState, joinUnits, networkFee, rentFromSimulation } from "../../apps/web/wallet/pool-join-plan.ts";

const argv = process.argv.slice(2);
const wanted = argv.flatMap((a, i) => (a === "--agent" && argv[i + 1] ? [argv[i + 1]!] : []));
const AGENTS = wanted.length ? wanted : ["HHxDgMPdYJ5SCXNdsvtaQnng3PAPXrPtZGY2xYc4eDtX", "CuvvtxbrrWhsqM1uj6ahUvEPTJrb78zfrUr4NVqGUpAo"];
process.env.UNITS_NETWORK = "mainnet";
const profile = applyNetworkProfile();
const rpc = Rpc.http(rpcUrlFor(profile), "confirmed");
if ((await rpc.call<string>("getGenesisHash")) !== "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d") throw new Error("the endpoint is not mainnet");
const reader = new ChainReader(rpc);
const log = (m: string) => console.log(`[pool-join-sim] ${m}`);
const sol = (l: bigint) => (Number(l) / 1e9).toFixed(9);
const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push({ check: name, ok, detail }); log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); };

const lc = await reader.launchConfig();
const pcA = await rpc.getAccountInfo(poolPdas.config());
if (!lc || !pcA) throw new Error("no LaunchConfig or PoolConfig on mainnet");
const cfg = decodePoolConfig(pcA.data);
const featureOn = !lc.paused && !!(lc.features & FEATURES.pools);
check("the chain's pools bit is on and PoolConfig is not paused", featureOn && !cfg.paused, `features ${lc.features}, pool fee ${cfg.poolFeeBps} bps, split ${cfg.payoutBps}/${cfg.buybackBps}/${cfg.burnBps}, cross holding ${cfg.crossHoldQuote} base units, auto join ${cfg.autoJoin}, at most ${cfg.maxMembers} members`);
const priceJ = await fetch("https://main-157-245-71-188.sslip.io/market/quote-usd", { signal: AbortSignal.timeout(15_000) }).then((r) => r.json()).catch(() => null) as { ok?: boolean; usd?: number } | null;
const usdPer = priceJ?.ok && typeof priceJ.usd === "number" ? priceJ.usd : null;
const launches = await reader.launches();
const out: any = { at: new Date().toISOString(), network: "mainnet", sent: 0, pool_config: { ...cfg, crossHoldQuote: cfg.crossHoldQuote.toString(), maxBuyQuote: cfg.maxBuyQuote.toString() }, features: lc.features,
  quote_usd: usdPer, agents: [] as unknown[] };

for (const agent of AGENTS) {
  const l = launches.find((x) => x.agent === agent);
  const rec = await reader.agent(agent);
  if (!l || !rec) { check(`${agent.slice(0, 6)}: launched and registered`, false); continue; }
  const tag = `${agent.slice(0, 6)} (${l.repoUrl.replace("https://github.com/", "")})`;
  const [poolA, memberA, routeA] = await rpc.getMultipleAccounts([poolPdas.pool(l.repoId), poolPdas.member(agent), claimPdas.feeRoute(agent)]);
  const pool = poolA ? decodePool(poolA.data) : null;
  const state = joinState({ featureOn, cfg, venue: l.venue, agent, isMember: !!memberA, pool });
  const members = pool?.members ?? [];
  const owner = rec.owner;
  log(`${tag}: owner ${owner}, launcher ${l.launcher}, signing key ${rec.signingKey === agent ? "the agent key" : `rotated to ${rec.signingKey}`}, hosted ${rec.hosted}, routes ${l.routes}, page state "${state.kind}"`);
  check(`${tag}: the page would offer a join (state open or join)`, state.kind === "open" || state.kind === "join", state.kind);
  const ixs = [pools.joinPool({ signer: owner, agent, agentMint: l.mint, repoId: l.repoId, lineMint: lc.lineMint, members, lineTokenProgram: TOKEN_2022_PROGRAM })];
  const cu = joinUnits(members.length);
  const { blockhash } = await rpc.getLatestBlockhash();
  const msg = compileMessage(owner, [computeBudget.limit(cu), computeBudget.price(1), ...ixs], blockhash);
  const sim = await simulateDetailed(rpc, unsignedWire(msg));
  const own = (sim.logs ?? []).filter((x) => /consumed \d+ of/.test(x)).pop() ?? "";
  check(`${tag}: join_pool signed by the owner's wallet alone would land on mainnet now (one signature required, sigVerify off)`, !sim.err && msg.numSigners === 1,
    sim.err ? `${JSON.stringify(sim.err)} ${(sim.logs ?? []).slice(-3).join(" | ")}` : `${sim.unitsConsumed ?? "?"} compute units of a ${cu} limit; ${1 + 64 + msg.bytes.length} bytes`);
  check(`${tag}: it stays within 62.5% of its compute limit`, (sim.unitsConsumed ?? Infinity) * 1.6 <= cu, `${sim.unitsConsumed} of ${cu}`);
  // the same transaction from a wallet that is not the owner
  const other = l.launcher !== owner ? l.launcher : lc.admin !== owner ? lc.admin : cfg.keeper;
  const bad = await simulateDetailed(rpc, unsignedWire(compileMessage(other, [computeBudget.limit(cu), pools.joinPool({ signer: other, agent, agentMint: l.mint, repoId: l.repoId, lineMint: lc.lineMint, members,
    lineTokenProgram: TOKEN_2022_PROGRAM })], blockhash)));
  check(`${tag}: the same join from a wallet that is not the agent's owner is refused`, !!bad.err && (bad.logs ?? []).some((x) => /Unauthorized/.test(x)), (bad.logs ?? []).filter((x) => /Error/.test(x)).pop()?.slice(0, 160) ?? JSON.stringify(bad.err));
  // the cost as the page states it: what the simulation charged for each account it created, and the fee
  const charged = rentFromSimulation(sim.accounts, { pool: poolPdas.pool(l.repoId), vault: poolPdas.vault(l.repoId, lc.lineMint, TOKEN_2022_PROGRAM), member: poolPdas.member(agent) });
  if (!charged) { check(`${tag}: the simulation created the membership`, false); continue; }
  const balance = await rpc.getBalance(owner);
  const cost = joinCost({ ...charged, fee: networkFee(cu, 1) });
  const payer = sim.accounts.find((a) => a.address === owner)!;
  check(`${tag}: the page's cost (rent of the new accounts and the fee) equals what the simulation took from the wallet, to the lamport`, payer.before !== null && payer.after !== null && BigInt(payer.before) - payer.after === cost.total,
    `${cost.total} lamports; wallet ${payer.before} to ${payer.after}`);
  log(`${tag}: cost ${sol(cost.total)} SOL (${cost.lines.map((c) => `${c.label} ${sol(c.lamports)}`).join(", ")}); the owner's wallet holds ${sol(BigInt(balance))} SOL`);
  check(`${tag}: the owner's wallet holds enough SOL for it`, BigInt(balance) >= cost.total, `${sol(BigInt(balance))} SOL held, ${sol(cost.total)} needed`);
  const routeBps = routeA && l.routes & FEATURES.githubFees ? decodeFeeRoute(routeA.data).bps : null;
  const facts = joinFacts({ cfg, others: members.length, routeBps, agentName: agent.slice(0, 6), coin: (b) => `${(Number(b) / 1e6).toLocaleString("en-US")} UNITS`,
    usd: (b) => (usdPer === null ? null : `$${((Number(b) / 1e6) * usdPer).toFixed(2)}`), maxFeeBps: MAX_POOL_FEE_BPS });
  out.agents.push({ agent, mint: l.mint, repo: l.repoUrl, repo_id: l.repoId, owner, launcher: l.launcher, owner_is_launcher: owner === l.launcher, hosted: rec.hosted, signing_key_rotated: rec.signingKey !== agent,
    routes: l.routes, pool_exists: !!pool, members, page_state: state.kind, signers_required: msg.numSigners, wire_bytes: 1 + 64 + msg.bytes.length, compute_limit: cu, simulated: { err: sim.err ?? null, units: sim.unitsConsumed ?? null, last: own },
    non_owner_refused: !!bad.err, cost_lamports: { total: cost.total.toString(), ...Object.fromEntries(cost.lines.map((c) => [c.key, c.lamports.toString()])) }, owner_balance_lamports: String(balance), review: facts });
}
out.checks = results;
out.outcome = results.every((r) => r.ok) ? "PASS" : "FAIL";
writeFileSync(join(import.meta.dir, "POOL-JOIN-SIMULATE-LAST.json"), JSON.stringify(out, null, 1) + "\n");
log(`${out.outcome} ${results.filter((r) => r.ok).length}/${results.length}; nothing was signed or sent`);
process.exit(out.outcome === "PASS" ? 0 : 1);
