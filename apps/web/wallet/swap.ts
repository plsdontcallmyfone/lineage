// Pay in SOL or USDC where the app needs $LINE (SPEC 14.9): the launch deposit, the trading
// allocation and trade-box buys. On mainnet the wallet asks Jupiter (Swap API V2 /build) for a quote
// with raw instructions, shows the route, price impact, slippage and guaranteed minimum, and signs
// one v0 transaction: Jupiter's swap, then the app's action spending at most that minimum (two
// transactions in one signing request when one does not fit). Jupiter does not run on devnet, so
// there the option is shown as unavailable and the forms use tLINE directly. The target mint and
// every limit come from config/swap.json (a stand-in mint until $LINE exists on mainnet).
import "../../../packages/chain/src/browser/buffer.ts";
import {
  checkSwapTarget,
  compileMessageV0,
  parseSwapConfig,
  parseWire,
  planSwapThen,
  quoteForTarget,
  sameBytes,
  sendWithRebuilds,
  simulateDetailed,
  swapAvailability,
  unsignedWire,
  type Confirmed,
  type Ix,
  type Simulation,
  type LookupTable,
  type PayAsset,
  type Rpc,
  type RouteView,
  type SwapConfig,
  type SwapQuote,
  type SwapThenPlan,
} from "../../../packages/chain/src/browser/index.ts";
import swapJson from "../../../config/swap.json" with { type: "json" };
import { html, type Raw } from "../src/html.ts";
import { loadChainCfg, NET, rpc as pageRpc, units } from "./chain.ts";
import { signTransaction, type StdAccount, type StdWallet } from "./standard.ts";

export const SWAP: { cfg: SwapConfig | null; err: string | null; cluster: string | null } = { cfg: null, err: null, cluster: null };
try {
  SWAP.cfg = parseSwapConfig(swapJson);
} catch (e) {
  SWAP.err = (e as Error).message;
}

let loading: Promise<void> | null = null;
/** Reads the page's cluster once and fills every "pay with" help line. */
export function loadSwap(): Promise<void> {
  loading ??= loadChainCfg()
    .then((c) => void (SWAP.cluster = c.cluster))
    .catch((e) => void (SWAP.err ??= (e as Error).message))
    .then(() => {
      for (const el of document.querySelectorAll<HTMLElement>("[data-swap-help]")) el.innerHTML = swapHelp().s;
      for (const el of document.querySelectorAll<HTMLSelectElement>("select[data-swap-pay]")) for (const o of el.options) if (o.value !== "LINE") o.disabled = !available();
    });
  return loading;
}

/** Swap availability under the page's network profile (SPEC 14.10): the profile must enable it, the RPC must be mainnet, and config/swap.json must target the profile's quote mint. */
export function availability(): { ok: true } | { ok: false; reason: string } {
  if (!SWAP.cluster) return { ok: false, reason: "network not read yet" };
  if (!NET.p.swap) return { ok: false, reason: `Jupiter runs on mainnet only; this is ${NET.p.network}, which uses ${NET.p.quote.symbol} directly` };
  const a = swapAvailability(SWAP.cfg, SWAP.cluster);
  if (!a.ok) return a;
  const bad = checkSwapTarget(NET.p, SWAP.cfg);
  return bad ? { ok: false, reason: bad } : { ok: true };
}
export const available = () => availability().ok;

function swapHelp(): Raw {
  if (!SWAP.cluster) return html`<span class="dim">Checking the network…</span>`;
  const a = availability();
  if (!a.ok) return html`<span class="dim">SOL or USDC through Jupiter: unavailable here (${a.reason}).</span>`;
  const c = SWAP.cfg!;
  return html`SOL or USDC is swapped to ${c.target_symbol}${c.target_status === "stand-in" ? " (stand-in for $LINE)" : ""} through Jupiter in the same transaction; slippage ${c.slippage_bps} bps (limit ${c.max_slippage_bps}), price impact limit ${c.max_price_impact_pct}%. Route and minimum are shown before you sign.`;
}

/** The "pay with" select for a form; `name` is the form field. SOL and USDC are disabled until the network is mainnet. */
export function payWithControl(name: string, nativeLabel: string, selected: PayAsset = "LINE"): Raw {
  void loadSwap();
  const off = !available();
  const sel = (v: PayAsset) => (v === (off ? "LINE" : selected) ? "selected" : "");
  return html`<label class="wl-field"><span class="eyebrow">Pay with</span><select name="${name}" data-swap-pay>
      <option value="LINE" ${sel("LINE")}>${nativeLabel}</option><option value="SOL" ${off ? "disabled" : ""} ${sel("SOL")}>SOL (swap)</option><option value="USDC" ${off ? "disabled" : ""} ${sel("USDC")}>USDC (swap)</option>
    </select><span class="wl-help" data-swap-help>${swapHelp()}</span></label>`;
}

export const payAsset = (v: string | null | undefined): PayAsset => (v === "SOL" || v === "USDC" ? v : "LINE");

export interface PreparedSwap {
  pay: Exclude<PayAsset, "LINE">;
  need: bigint;
  route: RouteView;
  plan: SwapThenPlan;
  build: SwapQuote["build"];
}

/** Quotes and composes "swap, then `action`" for `need` of the target. Mainnet only. */
export async function prepareSwapThen(o: { pay: Exclude<PayAsset, "LINE">; need: bigint; taker: string; action: Ix[]; cuLimit?: number; slippageBps?: number; extraTables?: LookupTable[] }): Promise<PreparedSwap> {
  await loadSwap();
  const a = availability();
  if (!a.ok) throw new Error(`Pay with ${o.pay}: ${a.reason}`);
  const cfg = SWAP.cfg!;
  const q = await quoteForTarget({ cfg, pay: o.pay, need: o.need, taker: o.taker, slippageBps: o.slippageBps, pause: () => new Promise((r) => setTimeout(r, 2100)) });
  const plan = planSwapThen({ payer: o.taker, build: q.build, action: o.action, cuLimit: o.cuLimit ?? 600_000, maxCuPrice: maxCuPrice(), extraTables: o.extraTables });
  return { pay: o.pay, need: o.need, route: q.route, plan, build: q.build };
}

/** Jupiter's unit price is used as quoted, never above the lower of the swap config's and the profile's cap. */
export function maxCuPrice(): number {
  const c = SWAP.cfg!.max_cu_price_micro_lamports;
  const f = NET.p.fees;
  return f.mode === "recent" ? Math.min(c, f.cap_micro_lamports) : c;
}

/** Recomposes a prepared swap with a new action (e.g. a trade's minimum out after the simulation); same quote, same checks. */
export function withAction(p: PreparedSwap, taker: string, action: Ix[], cuLimit = 600_000, extraTables?: LookupTable[]): PreparedSwap {
  return { ...p, plan: planSwapThen({ payer: taker, build: p.build, action, cuLimit, maxCuPrice: maxCuPrice(), extraTables }) };
}

/** Simulates the first transaction of a plan (signatures not verified, the RPC's recent blockhash). Nothing is signed. */
export async function simulatePlan(p: PreparedSwap, taker: string): Promise<Simulation> {
  const t = p.plan.txs[0]!;
  const { blockhash } = await pageRpc.getLatestBlockhash();
  const msg = compileMessageV0(taker, t.ixs, blockhash, t.tables);
  return simulateDetailed(pageRpc, unsignedWire(msg), new Map(t.tables.map((x) => [x.address, x.addresses])));
}

/** Route, amounts, price impact and slippage for the review step. */
export function routeLines(p: PreparedSwap): Raw {
  const c = SWAP.cfg!;
  const inD = p.pay === "SOL" ? 9 : 6;
  const r = p.route;
  return html`<div class="mk-tb-quote" data-swap-route="${r.path}">
    <div><span>You pay</span><b class="num">${units(r.inAmount, inD)} ${p.pay}</b></div>
    <div><span>Route (Jupiter)</span><b>${r.path}</b></div>
    <div><span>Quoted out</span><b class="num">${units(r.outAmount, c.target_decimals)} ${c.target_symbol}</b></div>
    <div><span>Minimum at ${r.slippageBps} bps</span><b class="num">${units(r.minOut, c.target_decimals)} ${c.target_symbol}</b></div>
    <div><span>Used by this action</span><b class="num">${units(p.need, c.target_decimals)} ${c.target_symbol}</b></div>
    <div><span>Price impact</span><b class="num">${r.priceImpactPct.toFixed(3)}%</b></div>
    <div><span>Transactions</span><b>${p.plan.mode === "one" ? "one" : "two, in one signing request"}</b></div>
  </div>`;
}

/**
 * Signs and sends a prepared plan in order (fresh blockhash per transaction); refuses a wallet that
 * changes the message. Mainnet confirmation (profile `confirm`): preflighted first send, resends of
 * the same bytes, and on blockhash expiry a fresh signing round.
 */
export async function sendSwapPlan(o: { rpc: Rpc; wallet: StdWallet; account: StdAccount; prepared: PreparedSwap; onStatus?: (s: string) => void }): Promise<Confirmed[]> {
  const out: Confirmed[] = [];
  const n = o.prepared.plan.txs.length;
  for (const [i, t] of o.prepared.plan.txs.entries()) {
    const c = await sendWithRebuilds(o.rpc, async () => {
      const { blockhash, lastValidBlockHeight } = await o.rpc.getLatestBlockhash();
      const msg = compileMessageV0(o.account.address, t.ixs, blockhash, t.tables);
      o.onStatus?.(`waiting for the wallet to sign${n > 1 ? ` (${i + 1} of ${n})` : ""}`);
      const signed = await signTransaction(o.wallet, o.account, unsignedWire(msg));
      if (!sameBytes(parseWire(signed).message, msg.bytes)) throw new Error("the wallet changed the transaction; nothing was sent");
      return { wire: signed, lastValidBlockHeight };
    }, NET.p.confirm, { onStatus: o.onStatus });
    out.push({ signature: c.signature, slot: c.slot, fee: c.fee, err: c.err, logs: c.logs });
    if (c.err) throw new Error(`transaction ${i + 1} failed on chain: ${JSON.stringify(c.err)}`);
  }
  return out;
}
