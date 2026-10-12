// Launch fronting (docs/plans/LAUNCH-FRONTING.md; owner directions 2026-10-10 and 2026-10-11): the
// launcher pays everything in SOL with one approval. The cost lines, all in lamports:
//   1. token creation: network fees of every transaction plus every rent deposit, computed without a
//      simulation (packages/chain/src/launch-costs.ts: signatures, the priority fee on the compute
//      limit, account sizes at the cluster's rent rate);
//   2. model credits: the SOL that buys the credits' $UNITS (at least prepay.min_usd USD, at the
//      configured rate or the live price), from pump.fun's arithmetic on the $UNITS curve as read;
//   3. the initial buy of prepay.initial_buy_bps of the supply (pump.fun's arithmetic on the new curve,
//      in $UNITS bought with SOL in the same purchase);
//   4. A units account: Core's identity_account_price_lamports, when chosen.
// Funding shows one compact total with a one-line breakdown that expands; Review shows every line once.
// Logic lives here; apps/web/wallet/main.ts only calls these functions (minimal hunks).
import { fmtUsd } from "../src/usd.ts";
import { initialBuyAmount, launchSolCosts, maxBuyInput, solShortfall, type Ix, type LaunchSolCosts, type PrepayConfig } from "../../../packages/chain/src/browser/index.ts";
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


const SOL = (l: bigint) => {
  const s = (Number(l) / 1e9).toFixed(l < 1_000_000n ? 6 : 4);
  return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
};
const usdOf = (l: bigint, solUsd: number | null) => (solUsd === null ? null : (Number(l) / 1e9) * solUsd);
// US dollars lead every cost (owner 2026-10-12), through the app's one formatter (src/usd.ts); the wallet
// pays in SOL, so the SOL amount stays beside it. No SOL price: "$ unavailable" (and the launch is disabled).
const money = (n: number | null) => fmtUsd(n);
const sol = (l: bigint) => `${SOL(l)} SOL`;

export interface FundingView {
  costs: LaunchSolCosts | null;
  /** the credits typed, USD (decimal string) */
  creditsUsd: string | null;
  bps: number | null;
  identityChosen: boolean;
  solUsd: number | null;
  solBalance: bigint | null;
  txCount: number | null;
  /** why the launch cannot go yet (no price, a failed read, balance), or null */
  blocked: string | null;
  devnet: boolean;
  docs: string;
  /** the chain reads behind the figures are in flight */
  pending: boolean;
  /** the SOL purchase is a Jupiter quote: those two lines are labelled as one */
  quoted?: boolean;
  /** the last build stopped with a reason: offer to read again */
  retry?: boolean;
}

/** Why the launch is disabled, one short line, or null (also null while the figures are being read: nothing is wrong yet). */
export function fundingBlocked(v: { costs: LaunchSolCosts | null; solUsd: number | null; solBalance: bigint | null; why?: string | null; pending?: boolean }): string | null {
  if (v.solUsd === null) return "no SOL price";
  if (v.why) return v.why;
  if (!v.costs) return v.pending ? null : "the prices are not read yet";
  return solShortfall(v.costs, v.solBalance);
}

// before the reads answer a cost has no figure yet
const WAIT = "…";

function lines(v: FundingView): [string, string, string][] {
  const c = v.costs;
  const out: [string, string, string][] = [];
  const q = v.quoted ? ", a Jupiter quote" : "";
  // [label, the cost in US dollars, the SOL the wallet pays for it]
  out.push(["Token creation", c ? money(usdOf(c.creation, v.solUsd)) : WAIT, c ? `${sol(c.creation)}${v.quoted ? "; the swap transaction pays its network fee on top" : ""}` : ""]);
  out.push(["Model credits", c ? money(usdOf(c.credits, v.solUsd)) : WAIT, `${c ? `${sol(c.credits)}` : ""}${v.creditsUsd ? `${c ? " for " : ""}${fmtUsd(Number(v.creditsUsd))} of credits` : ""}${c ? q : ""}`]);
  if (!c || c.buy !== null) out.push([`Initial buy${v.bps !== null ? ` ${v.bps / 100}%` : ""}`, c?.buy != null ? money(usdOf(c.buy, v.solUsd)) : WAIT, c?.buy != null ? `${sol(c.buy)}${q}` : ""]);
  if (v.identityChosen) out.push(["A units account", c ? money(usdOf(c.identity, v.solUsd)) : WAIT, c ? sol(c.identity) : ""]);
  if (c && c.tip > 0n) out.push(["Jito tip", money(usdOf(c.tip, v.solUsd)), sol(c.tip)]);
  return out;
}

/** Funding: one compact total (US dollars, the SOL the wallet pays small), a one-line breakdown that expands, one short line when disabled. */
export function fundingSummary(v: FundingView): Raw {
  const c = v.costs;
  const ls = lines(v);
  const one = ls.map(([k]) => k).join(" · ");
  return html`<div class="lz-sum" data-fronting-ok="${String(!v.blocked)}">
    <div class="lz-sum-top"><span class="eyebrow">Total</span> <b class="num lz-sum-total" data-fronting-total data-lamports="${c ? c.total.toString() : ""}">${c ? money(usdOf(c.total, v.solUsd)) : v.pending ? "reading prices…" : WAIT}</b>
      ${c ? html`<span class="dim lz-sum-usd" data-fronting-sol>${sol(c.total)}</span>` : ""}
      <span class="dim">one signature</span></div>
    <details class="lz-sum-more"><summary>${one}</summary>
      <div class="lz-sum-lines">${ls.map(([k, a, u]) => html`<div class="lz-rr" data-fronting="${k}"><span class="eyebrow">${k}</span><span class="lz-rv"><b class="num">${a}</b> <span class="dim">${u}</span></span></div>`)}</div>
    </details>
    ${v.blocked ? html`<div class="wl-fine" data-fronting-short><span class="mark warn">Launch disabled: ${v.blocked.replace(/\.$/, "")}.</span>${v.retry ? html` <button type="button" class="wl-btn" data-act="launch-review" data-fronting-retry>Try again</button>` : ""}</div>` : ""}
    <div class="wl-fine dim">${v.devnet ? "Devnet test tokens, no value. " : ""}<a class="link" href="${v.docs}">details</a></div>
  </div>`;
}

/** Review: every cost line once, the total and the one approval. */
export function costBreakdown(v: FundingView): Raw {
  const c = v.costs;
  return html`<div class="lz-review lz-fronting" data-fronting-ok="${String(!v.blocked)}">
    ${lines(v).map(([k, a, u]) => html`<div class="lz-rr" data-fronting="${k}"><span class="eyebrow">${k}</span><span class="lz-rv"><b class="num">${a}</b> <span class="dim">${u}</span></span></div>`)}
    <div class="lz-rr" data-fronting="Total"><span class="eyebrow">Total</span><span class="lz-rv"><b class="num">${c ? money(usdOf(c.total, v.solUsd)) : WAIT}</b> <span class="dim">${c ? sol(c.total) : ""}${c && c.headroom > 0n ? `; the wallet must hold ${SOL(c.needed)} SOL (the purchase at its slippage bound)` : ""}</span></span></div>
    <div class="lz-rr"><span class="eyebrow">Approval</span><span class="lz-rv"><b>one signature</b> <span class="dim">${v.txCount ? `${v.txCount} transaction${v.txCount === 1 ? "" : "s"} signed together${v.devnet ? ", sent in order" : ", sent as one Jito bundle (all or nothing)"}` : ""}</span></span></div>
    ${v.blocked ? html`<div class="wl-fine" data-fronting-short><span class="mark warn">Launch disabled: ${v.blocked.replace(/\.$/, "")}.</span></div>` : html`<div class="wl-fine"><span class="mark good">your wallet covers all of it</span></div>`}
  </div>`;
}
