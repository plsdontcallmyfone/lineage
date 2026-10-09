import {
  ata,
  ChainReader,
  compileMessage,
  computeBudget,
  damm,
  dbc,
  decodeDbcPool,
  launchPdas,
  Rpc,
  sendAndConfirm,
  token,
  TOKEN_2022_PROGRAM,
  type Ix,
  type LaunchConfig,
  type Signer,
} from "@lineage/chain";
import { simulateDetailed } from "../../chain/src/browser/client.ts";
import { unsignedWire } from "../../chain/src/browser/wire.ts";
import { decodeTokenAccount } from "../../chain/src/spl.ts";
import type { TokenView } from "./policy.ts";
import type { Balances, Fill, Quote, TraderKey, Venue } from "./venue.ts";

// Trades on devnet through packages/chain: Meteora DBC swap2 while the agent's curve runs, DAMM v2
// swap2 once it graduated. The venue is read from chain (AgentLaunch.graduated and the DBC pool's
// migration flag), never from the indexer. Every quote is a simulation of the exact transaction the
// treasury key will sign (the same as the token page's trade box), and sendAndConfirm simulates it
// again before sending. The treasury key is the fee payer: gas comes from the treasury.

const UNITS = 300_000;
type Route = { kind: "dbc"; pool: string; config: string } | { kind: "damm_v2"; pool: string };

export class ChainVenue implements Venue {
  readonly kind = "chain" as const;
  readonly reader: ChainReader;
  private lc: LaunchConfig | null = null;
  private routes = new Map<string, { at: number; route: Route }>();
  constructor(
    readonly rpc: Rpc,
    private o: { log?: (m: string) => void; onTx?: (what: string, sig: string, fee?: number) => void } = {},
  ) {
    this.reader = new ChainReader(rpc);
  }

  private async config(): Promise<LaunchConfig> {
    if (!this.lc) {
      this.lc = await this.reader.launchConfig();
      if (!this.lc) throw new Error("lineage_launch is not initialized on this cluster");
    }
    return this.lc;
  }

  get lineMintCached() {
    return this.lc?.lineMint ?? null;
  }

  async lineMint() {
    return (await this.config()).lineMint;
  }

  /** The venue a mint trades on now, read from chain (cached for a minute). */
  async route(mint: string): Promise<Route> {
    const c = this.routes.get(mint);
    if (c && Date.now() - c.at < 60_000) return c.route;
    const la = await this.reader.agentLaunch(mint);
    if (!la) throw new Error(`no AgentLaunch for ${mint}`);
    let route: Route;
    if (la.graduated) route = { kind: "damm_v2", pool: la.dammPool };
    else {
      const p = await this.rpc.getAccountInfo(la.dbcPool);
      const pool = p ? decodeDbcPool(p.data) : null;
      route = pool?.isMigrated ? { kind: "damm_v2", pool: launchPdas.dammPool(la.mint, (await this.config()).lineMint) } : { kind: "dbc", pool: la.dbcPool, config: la.dbcConfig };
    }
    this.routes.set(mint, { at: Date.now(), route });
    return route;
  }

  async balances(owner: string, mints: string[]): Promise<Balances> {
    const lm = await this.lineMint();
    const accs = [ata(owner, lm, TOKEN_2022_PROGRAM), ...mints.map((m) => ata(owner, m, TOKEN_2022_PROGRAM))];
    const [sol, infos] = await Promise.all([this.rpc.getBalance(owner), this.rpc.getMultipleAccounts(accs)]);
    const amt = (i: number) => (infos[i] ? decodeTokenAccount(infos[i]!.data).amount : 0n);
    return { line: amt(0), sol, tokens: new Map(mints.map((m, i) => [m, amt(i + 1)])) };
  }

  private async ixs(owner: string, mint: string, buy: boolean, amountIn: bigint, minOut: bigint): Promise<Ix[]> {
    const c = await this.config();
    const lm = c.lineMint;
    const v = await this.route(mint);
    const lineAccount = ata(owner, lm, TOKEN_2022_PROGRAM);
    const agentAccount = ata(owner, mint, TOKEN_2022_PROGRAM);
    const pre = [token.createAtaIdempotent(owner, owner, lm, TOKEN_2022_PROGRAM), token.createAtaIdempotent(owner, owner, mint, TOKEN_2022_PROGRAM)];
    const tp = c.lineTokenProgram;
    const swap =
      v.kind === "dbc"
        ? dbc.swap({ config: v.config, pool: v.pool, agentMint: mint, lineMint: lm, trader: owner, lineAccount, agentAccount, buy, amountIn, minOut, lineTokenProgram: tp })
        : damm.swap({ pool: v.pool, agentMint: mint, lineMint: lm, trader: owner, lineAccount, agentAccount, buy, amountIn, minOut, lineTokenProgram: tp });
    return [...pre, swap];
  }

  /** Simulates the exact transaction and reads the output account's change. */
  private async simulateOut(owner: string, mint: string, buy: boolean, amountIn: bigint): Promise<bigint> {
    const ixs = [computeBudget.limit(UNITS), ...(await this.ixs(owner, mint, buy, amountIn, 1n))];
    const { blockhash } = await this.rpc.getLatestBlockhash();
    const wire = unsignedWire(compileMessage(owner, ixs, blockhash));
    const sim = await simulateDetailed(this.rpc, wire);
    if (sim.err) throw new Error(`simulation failed: ${JSON.stringify(sim.err)} ${sim.logs.slice(-3).join(" | ")}`);
    const lm = await this.lineMint();
    const outAcc = buy ? ata(owner, mint, TOKEN_2022_PROGRAM) : ata(owner, lm, TOKEN_2022_PROGRAM);
    const row = sim.accounts.find((x) => x.address === outAcc);
    const before = row?.dataBefore && row.dataBefore.length >= 165 ? decodeTokenAccount(row.dataBefore).amount : 0n;
    const after = row?.dataAfter && row.dataAfter.length >= 165 ? decodeTokenAccount(row.dataAfter).amount : before;
    return after - before;
  }

  async quote(owner: TraderKey, t: TokenView, side: "buy" | "sell", amountIn: bigint): Promise<Quote> {
    const buy = side === "buy";
    const out = await this.simulateOut(owner.id, t.mint, buy, amountIn);
    // the marginal price from a probe of 1% of the size (fees are flat, so the ratio isolates impact)
    const probeIn = amountIn / 100n > 0n ? amountIn / 100n : 1n;
    const probe = await this.simulateOut(owner.id, t.mint, buy, probeIn);
    const impact = probe > 0n && amountIn > 0n ? 1 - Number(out) / Number(amountIn) / (Number(probe) / Number(probeIn)) : 1;
    const v = await this.route(t.mint);
    return { out, impact_bps: Math.max(0, Math.round(impact * 10_000)), venue: v.kind };
  }

  async execute(owner: TraderKey, t: TokenView, side: "buy" | "sell", amountIn: bigint, minOut: bigint): Promise<Fill> {
    const buy = side === "buy";
    const lm = await this.lineMint();
    const before = await this.balances(owner.id, [t.mint]);
    const ixs = await this.ixs(owner.id, t.mint, buy, amountIn, minOut);
    const r = await sendAndConfirm(this.rpc, owner as Signer, ixs, { computeUnits: UNITS, log: this.o.log });
    const v = await this.route(t.mint);
    this.o.onTx?.(`${side} ${t.mint} on ${v.kind} by treasury ${owner.id} in ${amountIn} min out ${minOut}`, r.signature, r.fee);
    const after = await this.balances(owner.id, [t.mint]);
    const dLine = after.line - before.line;
    const dTok = (after.tokens.get(t.mint) ?? 0n) - (before.tokens.get(t.mint) ?? 0n);
    void lm;
    return {
      signature: r.signature,
      amount_in: buy ? -dLine : -dTok,
      amount_out: buy ? dTok : dLine,
      fee_lamports: r.fee ?? 0,
      venue: v.kind,
    };
  }
}
