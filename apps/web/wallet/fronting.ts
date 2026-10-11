// Launch fronting (docs/plans/LAUNCH-FRONTING.md; owner directions 2026-10-10 and 2026-10-11): the
// launcher pays everything in SOL with one approval. The cost lines, all in lamports:
//   1. token creation: network fees of every transaction plus every rent deposit (the launch
//      transaction's simulation, the SOL purchase's simulation, and the funding transaction's fee and
//      the agent treasury account's rent read from the RPC);
//   2. model credits: the SOL that buys the credits' $UNITS (at least prepay.min_usd USD at
//      prepay.line_per_usd, admin-editable in Core), from the purchase's simulation;
//   3. the initial buy of prepay.initial_buy_bps of the supply (pump.fun's arithmetic on the new curve,
//      in $UNITS bought with SOL in the same purchase);
//   4. A units account: Core's identity_account_price_lamports, when chosen.
// Funding shows one compact total with a one-line breakdown that expands; Review shows every line once.
// Logic lives here; apps/web/wallet/main.ts only calls these functions (minimal hunks).
import { initialBuyAmount, launchSolCosts, maxBuyInput, solShortfall, type Ix, type LaunchSolCosts, type PrepayConfig } from "../../../packages/chain/src/browser/index.ts";
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


/** Lamports the payer spent in a simulation (null when it failed or the payer is missing), and the rent of the accounts it created. */
export function simSpend(sim: Simulation, payer: string): { spent: bigint; rent: bigint; fee: bigint } | null {
  const p = sim.accounts.find((a) => a.address === payer);
  if (sim.err || !p || p.before === null || p.after === null) return null;
  const rent = sim.accounts.filter((a) => a.created && a.address !== payer).reduce((n, a) => n + (a.after ?? 0n), 0n);
  return { spent: p.before - p.after, rent, fee: sim.fee ?? 0n };
}

/**
 * The SOL cost lines from the simulations. `launch`: the first transaction (create + register, the
 * soul); `purchase`: SOL to $UNITS for credits and the initial buy, simulated on its own (it reads
 * only state that exists before the launch); `creditsShare`: the credits' part of the purchase, from
 * pump.fun's arithmetic (credits quote / whole quote); `laterFees` and `laterRent`: the funding
 * transactions' network fees beyond the purchase's and the rent of the accounts they create (the
 * agent treasury's token account), read from the RPC. Null until every simulation succeeded.
 */
export function solCostsFromSims(o: {
  launch: Simulation;
  purchase: Simulation | null;
  payer: string;
  creditsShare: { num: bigint; den: bigint };
  hasBuy: boolean;
  laterFees: bigint;
  laterRent: bigint;
  identity: bigint;
  tip?: bigint;
  headroom?: bigint;
}): LaunchSolCosts | null {
  const a = simSpend(o.launch, o.payer);
  const b = o.purchase ? simSpend(o.purchase, o.payer) : { spent: 0n, rent: 0n, fee: 0n };
  if (!a || !b) return null;
  const trade = b.spent - b.fee - b.rent;
  const credits = o.creditsShare.den > 0n ? (trade * o.creditsShare.num) / o.creditsShare.den : trade;
  return launchSolCosts({ creation: a.spent + b.fee + b.rent + o.laterFees + o.laterRent, credits, buy: o.hasBuy ? trade - credits : null, identity: o.identity, tip: o.tip,
    headroom: o.headroom });
}

const SOL = (l: bigint) => {
  const s = (Number(l) / 1e9).toFixed(l < 1_000_000n ? 6 : 4);
  return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
};
const usdOf = (l: bigint, solUsd: number | null) => (solUsd === null ? null : (Number(l) / 1e9) * solUsd);
const money = (n: number | null) => (n === null ? "" : `${n < 0.01 && n > 0 ? "<0.01" : n.toFixed(2)} USD`);

export interface FundingView {
  costs: LaunchSolCosts | null;
  /** the credits typed, USD (decimal string) */
  creditsUsd: string | null;
  bps: number | null;
  identityChosen: boolean;
  solUsd: number | null;
  solBalance: bigint | null;
  txCount: number | null;
  /** why the launch cannot go yet (no price, not simulated, balance), or null */
  blocked: string | null;
  devnet: boolean;
  docs: string;
  pending: boolean;
}

/** Why the launch is disabled, one short line, or null. */
export function fundingBlocked(v: { costs: LaunchSolCosts | null; solUsd: number | null; solBalance: bigint | null; simErr?: string | null }): string | null {
  if (v.solUsd === null) return "no SOL price";
  if (v.simErr) return v.simErr;
  if (!v.costs) return "the launch is not simulated yet";
  return solShortfall(v.costs, v.solBalance);
}

function lines(v: FundingView): [string, string, string][] {
  const c = v.costs;
  const out: [string, string, string][] = [];
  out.push(["Token creation", c ? `${SOL(c.creation)} SOL` : "simulating", c ? money(usdOf(c.creation, v.solUsd)) : ""]);
  out.push(["Model credits", c ? `${SOL(c.credits)} SOL` : "simulating", v.creditsUsd ? `${v.creditsUsd} USD of credits` : ""]);
  if (!c || c.buy !== null) out.push([`Initial buy${v.bps !== null ? ` ${v.bps / 100}%` : ""}`, c?.buy != null ? `${SOL(c.buy)} SOL` : "simulating", c?.buy != null ? money(usdOf(c.buy, v.solUsd)) : ""]);
  if (v.identityChosen) out.push(["A units account", c ? `${SOL(c.identity)} SOL` : "simulating", c ? money(usdOf(c.identity, v.solUsd)) : ""]);
  if (c && c.tip > 0n) out.push(["Jito tip", `${SOL(c.tip)} SOL`, money(usdOf(c.tip, v.solUsd))]);
  return out;
}

/** Funding: one compact total (SOL, USD small), a one-line breakdown that expands, one short line when disabled. */
export function fundingSummary(v: FundingView): Raw {
  const c = v.costs;
  const ls = lines(v);
  const one = ls.map(([k]) => k).join(" · ");
  return html`<div class="lz-sum" data-fronting-ok="${String(!v.blocked)}">
    <div class="lz-sum-top"><span class="eyebrow">Total</span> <b class="num lz-sum-total" data-fronting-total>${c ? `${SOL(c.total)} SOL` : v.pending ? "simulating…" : "after the simulation"}</b>
      ${c && v.solUsd !== null ? html`<span class="dim lz-sum-usd">${money(usdOf(c.total, v.solUsd))}</span>` : ""}
      <span class="dim">one signature</span></div>
    <details class="lz-sum-more"><summary>${one}</summary>
      <div class="lz-sum-lines">${ls.map(([k, a, u]) => html`<div class="lz-rr" data-fronting="${k}"><span class="eyebrow">${k}</span><span class="lz-rv"><b class="num">${a}</b> <span class="dim">${u}</span></span></div>`)}</div>
    </details>
    ${v.blocked ? html`<div class="wl-fine" data-fronting-short><span class="mark warn">Launch disabled: ${v.blocked}.</span></div>` : ""}
    <div class="wl-fine dim">${v.devnet ? "Devnet test tokens, no value. " : ""}<a class="link" href="${v.docs}">details</a></div>
  </div>`;
}

/** Review: every cost line once, the total and the one approval. */
export function costBreakdown(v: FundingView): Raw {
  const c = v.costs;
  return html`<div class="lz-review lz-fronting" data-fronting-ok="${String(!v.blocked)}">
    ${lines(v).map(([k, a, u]) => html`<div class="lz-rr" data-fronting="${k}"><span class="eyebrow">${k}</span><span class="lz-rv"><b class="num">${a}</b> <span class="dim">${u}</span></span></div>`)}
    <div class="lz-rr" data-fronting="Total"><span class="eyebrow">Total</span><span class="lz-rv"><b class="num">${c ? `${SOL(c.total)} SOL` : "simulating"}</b> <span class="dim">${c ? money(usdOf(c.total, v.solUsd)) : ""}${c && c.headroom > 0n ? `; the wallet must hold ${SOL(c.needed)} SOL (the purchase at its slippage bound)` : ""}</span></span></div>
    <div class="lz-rr"><span class="eyebrow">Approval</span><span class="lz-rv"><b>one signature</b> <span class="dim">${v.txCount ? `${v.txCount} transaction${v.txCount === 1 ? "" : "s"} signed together${v.devnet ? ", sent in order" : ", sent as one Jito bundle (all or nothing)"}` : ""}</span></span></div>
    ${v.blocked ? html`<div class="wl-fine" data-fronting-short><span class="mark warn">Launch disabled: ${v.blocked}.</span></div>` : html`<div class="wl-fine"><span class="mark good">your wallet covers all of it</span></div>`}
  </div>`;
}
