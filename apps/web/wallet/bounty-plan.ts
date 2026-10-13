// The post form's rules as one pure function (docs/plans/OPEN-BOUNTIES.md 4.1, 5): what the wallet
// would sign and what it costs, or the reason in words. Every limit is the onchain BountyConfig, read
// by the caller; nothing here is a default.
import { hashJson } from "../../../packages/chain/src/browser/index.ts";

/** Account sizes of `units_launch` (8 byte discriminator plus the struct; bounty-plan.test.ts recounts them from bounty.rs). */
export const BOUNTY_ACCOUNT_LEN = 332;
export const BOUNTY_LEDGER_LEN = 97;

export interface PlanCfg { maxBountyOutBps: number; windowS: number; minTtlS: number; maxTtlS: number; refundGraceS: number; minAmount: bigint; paused: boolean }
export interface PlanInput {
  /** the reward in US dollars, with `priceUsd` per coin; or null and `unitsText` in the coin */
  usd: number | null;
  unitsText: string | null;
  priceUsd: number | null;
  decimals: number;
  hours: number;
  nowS: number;
  lineageId: string;
  metric: { name: string; min_improvement_bps: number };
  /** required improvement in percent */
  pct: number;
  note: string;
  cfg: PlanCfg;
  /** the paying agent's compute vault balance and its bounty ledger (null before its first bounty) */
  vaultBalance: bigint;
  ledger: { outWindow: bigint; outBase: bigint; outAmount: bigint } | null;
  /** rent-exempt lamports of the three accounts the transaction creates, read from the cluster */
  rent: { bounty: bigint; vault: bigint; ledger: bigint };
}
export interface Terms { v: 1; kind: "improvement"; lineage_id: string; metric: string; min_improvement_bps: number; note: string | null }
export type Plan =
  | { ok: true; amount: bigint; deadline: bigint; minImprovementBps: number; terms: Terms; termsDigest: string; conditionValue: string;
      /** SOL the signer pays for new accounts, and the part that returns when the bounty is paid or returned (the escrow account's) */
      rentLamports: bigint; rentReturned: bigint }
  | { ok: false; error: string };

const pct = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;
const group = (n: bigint, decimals: number) => {
  const s = (n / 10n ** BigInt(decimals)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return s;
};

function parseCoin(s: string, decimals: number): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s.trim().replace(/,/g, ""));
  if (!m || (m[2]?.length ?? 0) > decimals) return null;
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").padEnd(decimals, "0") || "0");
}

export function planBounty(i: PlanInput): Plan {
  const no = (error: string): Plan => ({ ok: false, error });
  const c = i.cfg;
  if (c.paused) return no("Bounties are paused.");
  let amount: bigint | null = null;
  if (i.usd !== null) {
    if (!(i.usd > 0) || !Number.isFinite(i.usd)) return no("Enter the reward in US dollars.");
    if (i.priceUsd === null || !(i.priceUsd > 0)) return no("Enter the reward in the coin: there is no dollar price right now.");
    // whole base units; the dollar figure is at this price only, the escrow holds the coin
    amount = BigInt(Math.floor((i.usd / i.priceUsd) * 10 ** i.decimals));
  } else if (i.unitsText !== null) {
    amount = parseCoin(i.unitsText, i.decimals);
  }
  if (amount === null || amount <= 0n) return no("Enter the reward.");
  if (amount < c.minAmount) return no(`The smallest reward is ${group(c.minAmount, i.decimals)} coins.`);
  if (amount > i.vaultBalance) return no(`The agent's compute balance holds ${group(i.vaultBalance, i.decimals)} coins, less than this reward.`);
  // the program's window cap: what one agent escrows in a window, against its balance at the window's first open
  const w = BigInt(Math.floor(i.nowS / Math.max(1, c.windowS)));
  const fresh = !i.ledger || i.ledger.outWindow !== w || (i.ledger.outBase === 0n && i.ledger.outAmount === 0n);
  const capBase = fresh ? i.vaultBalance : i.ledger!.outBase;
  const out = (fresh ? 0n : i.ledger!.outAmount) + amount;
  if (out * 10_000n > capBase * BigInt(c.maxBountyOutBps))
    return no(`An agent escrows at most ${pct(c.maxBountyOutBps)} of its compute balance in one window: ${group((capBase * BigInt(c.maxBountyOutBps)) / 10_000n - (out - amount), i.decimals)} coins are left in this one.`);
  const ttl = Math.floor(i.hours * 3600);
  if (!Number.isFinite(ttl) || ttl < c.minTtlS || ttl > c.maxTtlS) return no(`The deadline is between ${Math.ceil(c.minTtlS / 60)} minutes and ${Math.floor(c.maxTtlS / 86400)} days away.`);
  if (!Number.isFinite(i.pct)) return no("Enter the improvement required, in percent.");
  const bps = Math.round(i.pct * 100);
  if (bps < i.metric.min_improvement_bps) return no(`This metric counts an improvement of at least ${pct(i.metric.min_improvement_bps)}; require that or more.`);
  if (bps >= 10_000) return no("The improvement required is below 100%.");
  const terms: Terms = { v: 1, kind: "improvement", lineage_id: i.lineageId, metric: i.metric.name, min_improvement_bps: bps, note: i.note.trim() ? i.note.trim().slice(0, 280) : null };
  return { ok: true, amount, deadline: BigInt(i.nowS + ttl), minImprovementBps: bps, terms, termsDigest: hashJson(terms), conditionValue: hashJson(i.metric.name),
    rentLamports: i.rent.bounty + i.rent.vault + (i.ledger ? 0n : i.rent.ledger), rentReturned: i.rent.vault };
}
