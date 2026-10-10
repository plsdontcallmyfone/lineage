// pump.fun helpers for the node scripts (owner decisions 2026-10-10, docs/plans/PUMPFUN-LAUNCHES.md):
// an agent launch (create_v2 + register_pump_launch, the optional initial buy, the prepaid deposit
// and wake, the optional soul) sent as one v0 transaction with the launch lookup table when it fits,
// else exactly two transactions as planLaunch places them; a trade on the agent's curve or PumpSwap
// pool; the fee crank (pump.fun's sweeps and collects, then crank_pump_fees). Every send is simulated
// first. Nothing here reads or changes `solana config`; keys are passed explicitly.
import {
  ata,
  computeBudget,
  compileMessageV0,
  curveMigrated,
  decodeBondingCurve,
  decodeLookupTable,
  launch,
  launchPdas,
  launchTableAddresses,
  planLaunch,
  pump,
  PUMP,
  pumpAmm,
  pumpCrankIxs,
  pumpInitialBuy,
  pumpLaunchMain,
  pumpPdas,
  signMessageWith,
  token,
  TOKEN_2022_PROGRAM,
  TxError,
  wireSize,
  type Ix,
  type LaunchPlan,
  type LookupTable,
  type PumpLaunchArgs,
  type Rpc,
  type Signer,
} from "@lineage/chain";

const T22 = TOKEN_2022_PROGRAM;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SentTx {
  signature: string;
  fee: number | null;
  computeUnits: number | null;
  size: number;
  v0: boolean;
}

/** Sends one v0 transaction (reading `table` when given) after a simulation, rebroadcasting until it confirms. */
export async function sendTx(rpc: Rpc, payer: Signer, ixs: Ix[], o: { signers?: Signer[]; computeUnits?: number; table?: LookupTable | null } = {}): Promise<SentTx> {
  const all = o.computeUnits ? [computeBudget.limit(o.computeUnits), ...ixs] : ixs;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
    const msg = compileMessageV0(payer.id, all, blockhash, o.table ? [o.table] : []);
    const size = wireSize(msg);
    if (size > 1232) throw new Error(`transaction is ${size} bytes, over the 1232-byte packet limit`);
    const tx = signMessageWith(msg, [payer, ...(o.signers ?? [])]);
    const sim = await rpc.simulate(tx.wire);
    if (sim.err) throw new TxError(`simulation failed: ${JSON.stringify(sim.err)}`, sim.logs ?? []);
    await rpc.sendRawTransaction(tx.wire, true);
    let last = Date.now();
    for (;;) {
      await sleep(800);
      const [st] = await rpc.getSignatureStatuses([tx.signature]);
      if (st?.err) {
        const t = await rpc.getTransaction(tx.signature).catch(() => null);
        throw new TxError(`transaction failed: ${JSON.stringify(st.err)}`, t?.meta?.logMessages ?? [], tx.signature);
      }
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
        const t = await rpc.getTransaction(tx.signature).catch(() => null);
        return { signature: tx.signature, fee: t?.meta?.fee ?? null, computeUnits: t?.meta?.computeUnitsConsumed ?? null, size, v0: true };
      }
      if ((await rpc.getBlockHeight()) > lastValidBlockHeight) break;
      if (Date.now() - last > 2500) {
        await rpc.sendRawTransaction(tx.wire, true).catch(() => undefined);
        last = Date.now();
      }
    }
  }
  throw new TxError("not confirmed after 3 blockhashes");
}

/** The launch lookup table named in the state, checked frozen and equal to launchTableAddresses; null when absent. */
export async function launchTable(rpc: Rpc, state: { launch_lookup_table?: unknown; line_mint?: string; line_token_program?: string;
  line_pool?: { pool: string; baseVault: string; quoteVault: string } }): Promise<LookupTable | null> {
  const at = typeof state.launch_lookup_table === "string" ? state.launch_lookup_table : null;
  if (!at || !state.line_mint) return null;
  const acc = await rpc.getAccountInfo(at);
  if (!acc) throw new Error(`launch lookup table ${at} not found`);
  const t = decodeLookupTable(acc.data);
  const want = launchTableAddresses({ lineMint: state.line_mint, lineTokenProgram: state.line_token_program ?? T22, linePool: state.line_pool });
  if (t.addresses.length !== want.length || t.addresses.some((a, i) => a !== want[i])) throw new Error(`launch lookup table ${at} differs from the expected launch accounts`);
  return { address: at, addresses: t.addresses };
}

export interface PumpLaunch {
  launcher: Signer;
  agent: Signer;
  mint: Signer;
  lineMint: string;
  linePool?: { pool: string; baseVault: string; quoteVault: string };
  name: string;
  symbol: string;
  uri: string;
  args: PumpLaunchArgs;
  creatorFeeBps?: bigint;
  /** prepaid credits into the compute vault (with refresh_awake), base units; 0 or absent: none */
  deposit?: { amount: bigint; decimals: number };
  /** the launcher's initial buy, delivered to the agent key */
  buy?: { amountOut: bigint; maxIn: bigint; createBuyback?: boolean };
  /** the optional set_profile, signed by the agent key */
  soul?: Ix | null;
  table: LookupTable | null;
}

/** One launch, one or two transactions (planLaunch); returns the plan and the signatures in order. */
export async function pumpLaunchTx(rpc: Rpc, l: PumpLaunch): Promise<{ plan: LaunchPlan; sent: SentTx[] }> {
  const main = pumpLaunchMain({ launcher: l.launcher.id, agent: l.agent.id, agentMint: l.mint.id, line: { mint: l.lineMint, tokenProgram: T22, pool: l.linePool },
    name: l.name, symbol: l.symbol, uri: l.uri, args: l.args, creatorFeeBps: l.creatorFeeBps });
  const buy = l.buy ? pumpInitialBuy({ launcher: l.launcher.id, agent: l.agent.id, agentMint: l.mint.id, lineMint: l.lineMint, amountOut: l.buy.amountOut,
    maxIn: l.buy.maxIn, lineTokenProgram: T22, createBuyback: l.buy.createBuyback }) : [];
  const rest = l.deposit && l.deposit.amount > 0n ? launch.prepay({ launcher: l.launcher.id, agent: l.agent.id, agentMint: l.mint.id, lineMint: l.lineMint,
    amount: l.deposit.amount, decimals: l.deposit.decimals, lineTokenProgram: T22 }) : [];
  const budget = [computeBudget.limit(600_000)];
  const plan = planLaunch({ payer: l.launcher.id, main, buy, rest, soul: l.soul ?? null, budget, table: l.table, v0: true });
  const sent: SentTx[] = [];
  for (const [i, t] of plan.txs.entries()) {
    const signers = i === 0 ? [l.agent, l.mint] : [l.agent];
    // only the signers the transaction names sign it
    const named = new Set(t.ixs.flatMap((x) => x.keys.filter((k) => k.isSigner).map((k) => k.pubkey)));
    sent.push(await sendTx(rpc, l.launcher, t.ixs, { signers: signers.filter((s) => named.has(s.id)), computeUnits: 600_000, table: t.table }));
  }
  return { plan, sent };
}

/** Where an agent coin trades now: its curve, its PumpSwap pool, or waiting for pump.fun's migration. */
export async function pumpVenue(rpc: Rpc, mint: string, lineMint: string): Promise<{ kind: "curve" | "pool" | "waiting"; pool: string }> {
  const pool = pumpPdas.pool(mint, lineMint);
  const [c, p] = await rpc.getMultipleAccounts([pumpPdas.bondingCurve(mint), pool]);
  if (p) return { kind: "pool", pool };
  const curve = c ? decodeBondingCurve(c.data) : null;
  if (curve && curveMigrated(curve)) return { kind: "pool", pool };
  if (curve?.complete) return { kind: "waiting", pool };
  return { kind: "curve", pool };
}

/**
 * A trade in $LINE: on the curve buy_exact_quote_in_v3 / sell_v3, on the pool buy_exact_quote_in_v2 /
 * sell_v2. The trader's $LINE and agent-token ATAs and the buyback recipient's $LINE ATA are created
 * idempotently first. `amountIn` is $LINE for a buy and agent tokens for a sell.
 */
export async function pumpTrade(rpc: Rpc, o: { trader: Signer; mint: string; lineMint: string; buy: boolean; amountIn: bigint; minOut?: bigint }): Promise<SentTx & { venue: string }> {
  const v = await pumpVenue(rpc, o.mint, o.lineMint);
  if (v.kind === "waiting") throw new Error(`${o.mint}: the curve is complete; trading resumes on PumpSwap after migrate_v2`);
  const a = o.trader.id, min = o.minOut ?? 1n;
  const pre = [token.createAtaIdempotent(a, a, o.lineMint, T22), token.createAtaIdempotent(a, a, o.mint, T22),
    token.createAtaIdempotent(a, PUMP.buybackRecipients[0], o.lineMint, T22)];
  const t = { mint: o.mint, quoteMint: o.lineMint, quoteTokenProgram: T22, user: a };
  const ix = v.kind === "curve"
    ? o.buy ? pump.buyExactQuoteInV3({ ...t, spendableQuoteIn: o.amountIn, minTokensOut: min }) : pump.sellV3({ ...t, amount: o.amountIn, minQuoteOut: min })
    : o.buy ? pumpAmm.buyExactQuoteInV2({ ...t, pool: v.pool, spendableQuoteIn: o.amountIn, minBaseOut: min })
    : pumpAmm.sellV2({ ...t, pool: v.pool, baseIn: o.amountIn, minQuoteOut: min });
  return { ...(await sendTx(rpc, o.trader, [...pre, ix], { computeUnits: 300_000 })), venue: v.kind === "curve" ? "pump_curve" : "pump_pool" };
}

/** The creator fee waiting on the agent's curve (v3 trades keep it there until a sweep). */
export async function curveCreatorFee(rpc: Rpc, mint: string): Promise<bigint> {
  const c = await rpc.getAccountInfo(pumpPdas.bondingCurve(mint));
  return c ? decodeBondingCurve(c.data).creatorFee : 0n;
}

/** The keeper's crank: pump.fun's sweep + collect (and the pool's once it exists), then crank_pump_fees. Permissionless. */
export async function pumpCrank(rpc: Rpc, o: { payer: Signer; agent: string; mint: string; lineMint: string }): Promise<SentTx> {
  const v = await pumpVenue(rpc, o.mint, o.lineMint);
  const ixs = pumpCrankIxs({ payer: o.payer.id, agent: o.agent, agentMint: o.mint, lineMint: o.lineMint, lineTokenProgram: T22, pool: v.kind === "pool" ? v.pool : undefined });
  return sendTx(rpc, o.payer, ixs, { computeUnits: 400_000 });
}

/** The creator PDA's $LINE account, where pump.fun's collects pay and crank_pump_fees reads. */
export const creatorLineAccount = (agent: string, lineMint: string) => ata(launchPdas.pumpCreator(agent), lineMint, T22);
