// Optional trading allocation at launch (plan T): the quote token (tLINE on devnet) from the launcher's wallet to the allocation
// escrow the network publishes (GET /v1/trading/config, allocation_escrow), with a memo naming the
// agent. The hosted runtime forwards it to the agent's trading treasury once the agent is bound, and
// publishes the deposit and the forward as a funding record. A second transaction after the launch,
// so the launch transaction keeps its size; skipped when the field is empty or no escrow is published.
// Mainnet (SPEC 14.9, 14.10): it may be paid in SOL or USDC, Jupiter's swap and the transfer in one
// transaction (the transfer spends at most the swap's guaranteed minimum).
import { ata, token, TOKEN_2022_PROGRAM, type Ix } from "../../../packages/chain/src/browser/index.ts";
import { html, type Raw } from "../src/html.ts";
import { parseUnits, qsym, rpc, signAndSend } from "./chain.ts";
import { payAsset, payWithControl, prepareSwapThen, sendSwapPlan } from "./swap.ts";
import type { StdAccount, StdWallet } from "./standard.ts";

export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const ALLOCATION_MEMO = "lineage-trade-alloc:";

let escrow: string | null = null;
let read = false;

/** Reads the published escrow (once per page). */
export async function loadTradingEscrow(): Promise<string | null> {
  if (read) return escrow;
  try {
    const r = await fetch("/api/trading/config");
    const c = r.ok ? await r.json() : null;
    escrow = c?.enabled && typeof c.allocation_escrow === "string" ? c.allocation_escrow : null;
  } catch {
    escrow = null;
  }
  read = true;
  const help = document.getElementById("w-alloc");
  if (help) help.textContent = escrow ? `Sent to the allocation escrow ${escrow.slice(0, 6)}… after the launch, in a second transaction; the hosted runtime forwards it to the agent's trading treasury once the agent is bound. Separate from the compute vault.` : "No allocation escrow is published on this network; leave empty.";
  return escrow;
}

export function allocationFieldset(): Raw {
  return html`<fieldset><legend class="eyebrow">Trading allocation (plan T, optional)</legend>
      <label><span class="eyebrow">Allocation (${qsym()})</span><input name="l_alloc" inputmode="decimal" autocomplete="off" placeholder="0"><span class="wl-help" id="w-alloc">Hosted agents trade other agents' tokens from a treasury separate from their compute vault. Reading the trading config…</span></label>
      ${payWithControl("l_alloc_pay", qsym())}
    </fieldset>`;
}

export function allocationIxs(o: { launcher: string; agent: string; lineMint: string; amount: bigint; decimals: number; escrow: string }): Ix[] {
  const src = ata(o.launcher, o.lineMint, TOKEN_2022_PROGRAM);
  return [
    token.transferChecked(src, o.lineMint, o.escrow, o.launcher, o.amount, o.decimals, TOKEN_2022_PROGRAM),
    { programId: MEMO_PROGRAM, keys: [], data: new TextEncoder().encode(`${ALLOCATION_MEMO}${o.agent}`) },
  ];
}

/** After a confirmed launch: sends the allocation typed in the form, if any. Returns the signature or null. */
export async function sendAllocation(o: { wallet: StdWallet; account: StdAccount; agent: string; lineMint: string; decimals: number; typed: string; pay?: string; onStatus: (s: string) => void }): Promise<string | null> {
  const typed = o.typed.trim();
  if (!typed || typed === "0") return null;
  const to = await loadTradingEscrow();
  if (!to) return null;
  const amount = parseUnits(typed, o.decimals);
  if (!amount || amount <= 0n) throw new Error(`Trading allocation: a positive ${qsym()} amount`);
  o.onStatus("launched; now sign the trading allocation");
  const ixs = allocationIxs({ launcher: o.account.address, agent: o.agent, lineMint: o.lineMint, amount, decimals: o.decimals, escrow: to });
  const pay = payAsset(o.pay);
  if (pay !== "LINE") {
    // swap SOL or USDC to exactly `amount`, then the transfer and memo (mainnet only; prepareSwapThen refuses elsewhere)
    const prepared = await prepareSwapThen({ pay, need: amount, taker: o.account.address, action: ixs, cuLimit: 400_000 });
    const cs = await sendSwapPlan({ rpc, wallet: o.wallet, account: o.account, prepared, onStatus: o.onStatus });
    return cs[cs.length - 1]!.signature;
  }
  const r = await signAndSend({ wallet: o.wallet, account: o.account, ixs, units: 60_000, onStatus: o.onStatus });
  const c = r.confirmed!;
  if (c.err) throw new Error(`trading allocation failed on chain: ${JSON.stringify(c.err)} (the agent is launched; send it again from a later launch step)`);
  return c.signature;
}
