// Launch fronting (docs/plans/LAUNCH-FRONTING.md, owner decision 2026-10-10): whoever launches an agent
// fronts three things at creation, all shown in the wizard's Funding and Review steps with figures from
// the launch simulation and Core's config, never estimates:
//   1. the token creation cost: the launcher's SOL change in the simulation (network fee plus every rent
//      deposit the launch pays);
//   2. the prepaid model credits: required, exactly Core's configured amount (prepay.min_usd, admin-
//      editable through POST /v1/admin/launch-fronting) at the configured rate;
//   3. the initial buy of prepay.initial_buy_bps of the supply, delivered to the agent's treasury. The
//      buy instructions belong to the launch venue (the pump.fun launches lane): it registers a builder
//      with `setInitialBuyBuilder`; until one is registered the line says so and the total is lines 1 and 2.
// The launch button stays disabled until the connected wallet covers all of it (frontingShortfall).
// Logic lives here; apps/web/wallet/main.ts only calls these functions (minimal hunks).
import { frontingCosts, frontingShortfall, initialBuyAmount, maxBuyInput, type FrontingCosts, type Ix, type PrepayConfig } from "../../../packages/chain/src/browser/index.ts";
import type { Simulation } from "../../../packages/chain/src/browser/client.ts";
import { html, type Raw } from "../src/html.ts";

/** What a venue's initial buy builder receives: the launch's keys and the exact amount to buy. */
export interface InitialBuyContext {
  launcher: string;
  /** the agent key: its treasury at launch, the owner of the delivered tokens */
  agent: string;
  agentMint: string;
  /** token base units to buy: floor(total supply x initial_buy_bps / 10,000) */
  amountOut: bigint;
  /** the venue's total supply in base units (what amountOut was computed from) */
  supply: bigint;
  slippageBps: number;
}
/**
 * A venue's initial buy: instructions placed after its create instruction (empty when the buy rides
 * inside the create instruction, as pump.fun's create_v2 creator buy may), the curve quote for exactly
 * `amountOut` and the maximum input the instructions allow (maxBuyInput(quote, slippage)).
 */
export interface InitialBuy {
  ixs: Ix[];
  amountOut: bigint;
  quote: bigint;
  maxIn: bigint;
  /** the token account the tokens land in (the agent key's ATA of the agent mint) */
  treasuryAccount: string;
}
export type InitialBuyBuilder = { supply: () => Promise<bigint>; build: (c: InitialBuyContext) => Promise<InitialBuy> };

let builder: InitialBuyBuilder | null = null;
/** The launch venue registers its buy here (pump.fun lane). Null: the venue adds no initial buy yet. */
export function setInitialBuyBuilder(b: InitialBuyBuilder | null) {
  builder = b;
}

/** The venue's initial buy for this launch, or null when no venue builder is registered or the configured bps is 0. */
export async function initialBuyFor(o: { launcher: string; agent: string; agentMint: string }, c: PrepayConfig | null): Promise<InitialBuy | null> {
  if (!builder || !c || c.initial_buy_bps === 0) return null;
  const supply = await builder.supply();
  const amountOut = initialBuyAmount(supply, c.initial_buy_bps);
  const b = await builder.build({ ...o, amountOut, supply, slippageBps: c.initial_buy_slippage_bps });
  if (b.amountOut !== amountOut) throw new Error(`the venue's initial buy delivers ${b.amountOut}, not the configured ${amountOut}`);
  if (b.maxIn !== maxBuyInput(b.quote, c.initial_buy_slippage_bps)) throw new Error("the venue's initial buy maximum input is not the configured slippage bound");
  return b;
}

const amountAt = (d: Uint8Array | null) => (d && d.length >= 72 ? new DataView(d.buffer, d.byteOffset + 64, 8).getBigUint64(0, true) : 0n);

/** The three costs from one launch simulation: SOL change of the launcher, credits, and the buy's simulated cost (quote spent minus credits). */
export function costsFromSim(o: { sim: Simulation; launcher: string; launcherQuoteAccount: string; credits: bigint; buy: InitialBuy | null }): FrontingCosts {
  const payer = o.sim.accounts.find((a) => a.address === o.launcher);
  const creation = !o.sim.err && payer && payer.before !== null && payer.after !== null ? payer.before - payer.after : null;
  let buy: FrontingCosts["buy"] = null;
  if (o.buy) {
    const q = o.sim.accounts.find((a) => a.address === o.launcherQuoteAccount);
    const spent = q ? amountAt(q.dataBefore) - amountAt(q.dataAfter) : null;
    buy = { amountOut: o.buy.amountOut, cost: !o.sim.err && spent !== null ? spent - o.credits : o.buy.quote, maxIn: o.buy.maxIn };
  }
  return frontingCosts({ creationLamports: creation, credits: o.credits, buy });
}

/** The Funding/Review block: the three lines, the total, and whether the wallet covers it. */
export function frontingBlock(o: {
  cfg: PrepayConfig | null;
  costs: FrontingCosts | null;
  buyPending?: boolean;
  credits: bigint | null;
  creditsUsd: string | null;
  decimals: number;
  sym: string;
  solBalance: bigint | null;
  quoteBalance: bigint | null;
  fmtSol: (l: bigint) => string;
  fmtQuote: (b: bigint) => string;
}): Raw {
  const c = o.cfg;
  const pct = c ? `${(c.initial_buy_bps / 100).toString()}%` : "TBA";
  const x = o.costs;
  const short = x ? frontingShortfall(x, o.solBalance, o.quoteBalance) : "the launch is not simulated yet";
  const line = (k: string, v: Raw | string, note: Raw | string) => html`<div class="lz-rr" data-fronting="${k}"><span class="eyebrow">${k}</span><span class="lz-rv"><b class="num">${v}</b> <span class="dim">${note}</span></span></div>`;
  const buyLine = x?.buy
    ? line("Initial buy", `${o.fmtQuote(x.buy.cost)} ${o.sym}`, html`${pct} of the supply (${o.fmtQuote(x.buy.amountOut)} tokens) to the agent's treasury, from the simulation; at most ${o.fmtQuote(x.buy.maxIn)} ${o.sym} (${c?.initial_buy_slippage_bps ?? "TBA"} bps above the curve quote)`)
    : line("Initial buy", builder ? "TBA" : "not in this launch yet", builder ? "simulated in the Review step" : html`${pct} of the supply to the agent's treasury; the launch venue adds it with the pump.fun launches`);
  return html`<div class="lz-review lz-fronting" data-fronting-ok="${String(short === null)}">
    ${line("Token creation", x?.creationLamports != null ? `${o.fmtSol(x.creationLamports)} SOL` : "TBA", x?.creationLamports != null ? "rent and network fees, the launcher's SOL change in the launch simulation" : "from the launch simulation (Review step)")}
    ${line("Model credits", o.credits !== null ? `${o.fmtQuote(o.credits)} ${o.sym}` : "TBA", html`${o.creditsUsd ? `${o.creditsUsd} USD at ${c?.line_per_usd ?? "TBA"} ${o.sym} per USD${c?.rate_status === "test" ? " (TEST rate)" : ""}` : ""}, required, into the agent's compute vault`)}
    ${buyLine}
    ${line("Total", x ? html`${x.creationLamports != null ? `${o.fmtSol(x.creationLamports)} SOL + ` : ""}${o.fmtQuote(x.quoteSpent)} ${o.sym}` : o.credits !== null ? `${o.fmtQuote(o.credits)} ${o.sym} + token creation` : "TBA", x?.buy ? html`the wallet must hold ${o.fmtQuote(x.quoteNeeded)} ${o.sym} (the buy at its maximum)` : "")}
    <div class="wl-fine" data-fronting-short>${short === null ? html`<span class="mark good">your wallet covers all of it</span>` : html`<span class="mark warn">Launch is disabled: ${short}.</span>`}</div>
  </div>`;
}
