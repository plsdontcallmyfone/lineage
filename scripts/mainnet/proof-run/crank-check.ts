#!/usr/bin/env bun
// Proof run step 5: what a fee crank of one agent would move now, read only by default: the crank the keeper sends
// (scripts/mainnet/crank-fees.ts: pumpCrankIxs with the agent's route accounts), simulated, with the balance change of
// every $UNITS account it writes. scripts/mainnet/crank-fees.ts counts only fees already swept out of the curve, so its
// "wait" figure is zero for a coin whose fees still sit in the curve; this simulation shows the real amount.
// With --send the test launcher pays the network fee of one crank (permissionless; only when the keeper has not sent it).
//   bun scripts/mainnet/proof-run/crank-check.ts --agent <id> --mint <mint> [--send]
import { ata, claimPdas, claims, compileMessage, computeBudget, decodeAgentLaunch, decodeFeeRoute, decodePool, decodePoolMember, decodeTokenAccount, FEATURES, ChainReader, launchPdas, poolPdas, pools, pumpCrankIxs, signMessageWith,
  TOKEN_2022_PROGRAM, type AccountMeta } from "@units/chain";
import { chain, saveStep, simulateFor, sol, solscan } from "./lib.ts";
const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1]! : d);
const AGENT = opt("agent")!, MINT = opt("mint")!, SEND = argv.includes("--send"), TAG = opt("tag", "check")!;
const { rpc, wallet, state } = await chain();
const LINE = state.line_mint as string, T22 = TOKEN_2022_PROGRAM;
const cfg = (await new ChainReader(rpc).launchConfig())!;
const [alA, frA, pmA] = await rpc.getMultipleAccounts([launchPdas.agentLaunch(MINT), claimPdas.feeRoute(AGENT), poolPdas.member(AGENT)]);
const la = decodeAgentLaunch(alA!.data);
const active = cfg.features & la.routes;
const routes: AccountMeta[] = [];
const names: Record<string, string> = { [launchPdas.computeVault(AGENT)]: "the agent's compute vault", [ata(launchPdas.pumpCreator(AGENT), LINE, T22)]: "the agent's creator account (swept fees, before the split)" };
if (active & FEATURES.githubFees && frA) { const id = decodeFeeRoute(frA.data).githubId; routes.push(...claims.crankRouteKeys(AGENT, id)); names[claimPdas.vault(id)] = `the claim escrow of GitHub repository ${id}`; }
if (active & FEATURES.pools && pmA) { const pA = await rpc.getAccountInfo(decodePoolMember(pmA.data).pool); if (pA) { const rid = decodePool(pA.data).repoId; routes.push(...pools.crankRouteKeys(AGENT, rid, LINE, T22)); names[poolPdas.vault(rid, LINE, T22)] = "the repository pool's vault"; } }
const ixs = [computeBudget.limit(400_000), computeBudget.price(10_000), ...pumpCrankIxs({ payer: wallet.id, agent: AGENT, agentMint: MINT, lineMint: LINE, lineTokenProgram: T22, routes })];
const writable = [...new Set(ixs.flatMap((ix) => ix.keys.filter((k) => k.isWritable).map((k) => k.pubkey)))];
const before = await rpc.getMultipleAccounts(writable);
const tokenAmount = (d: Uint8Array | undefined, owner: string | undefined) => { try { return d && d.length >= 165 && (owner === T22) ? decodeTokenAccount(d) : null; } catch { return null; } };
const { blockhash } = await rpc.getLatestBlockhash();
const tx = signMessageWith(compileMessage(wallet.id, ixs, blockhash), [wallet]);
const sim = await simulateFor(rpc, Buffer.from(tx.wire).toString("base64"), writable);
const moves: { account: string; what: string; before: string; after: string; delta: string }[] = [];
for (const [i, a] of writable.entries()) {
  const b = tokenAmount(before[i]?.data, (before[i] as any)?.owner), s = sim.accounts?.[i];
  const af = s ? tokenAmount(new Uint8Array(Buffer.from(s.data[0], "base64")), s.owner) : null;
  if ((b && b.mint !== LINE) || (af && af.mint !== LINE) || (!b && !af)) continue;
  const d = (af?.amount ?? 0n) - (b?.amount ?? 0n);
  if (d !== 0n) moves.push({ account: a, what: names[a] ?? (a === ata(state.compute_sink, LINE, T22) || a === state.compute_sink ? "the protocol's account (compute sink)" : "other"), before: (b?.amount ?? 0n).toString(), after: (af?.amount ?? 0n).toString(), delta: d.toString() });
}
const out: Record<string, unknown> = { agent: AGENT, mint: MINT, routes_bits: la.routes, features: cfg.features, route_accounts: routes.length, fees_claimed_so_far: la.feesClaimed.toString(), to_compute_so_far: la.toCompute.toString(), to_protocol_so_far: la.toProtocol.toString(),
  simulation: { err: sim.err, units: sim.unitsConsumed, logs_tail: sim.err ? (sim.logs ?? []).slice(-5) : undefined }, would_move: moves, bytes: tx.wire.length };
console.log(JSON.stringify(out, null, 1));
if (SEND && !sim.err && moves.length) {
  const bal0 = await rpc.getBalance(wallet.id);
  await rpc.sendRawTransaction(tx.wire, true);
  let st: any = null;
  for (let i = 0; i < 90 && !st; i++) { await new Promise((r) => setTimeout(r, 1000)); const [s] = await rpc.getSignatureStatuses([tx.signature]); if (s && (s.err || s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) st = s; else if (i % 3 === 2) await rpc.sendRawTransaction(tx.wire, true).catch(() => undefined); }
  Object.assign(out, { sent: true, signature: tx.signature, solscan: solscan(tx.signature), err: st?.err ?? (st ? null : "not confirmed"), wallet_spent_sol: sol(bal0 - (await rpc.getBalance(wallet.id))) });
  console.log(`sent ${tx.signature} ${JSON.stringify(st?.err ?? null)}`);
}
saveStep(`5_crank_${TAG}`, out);
