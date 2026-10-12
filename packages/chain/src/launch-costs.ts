// What a launch costs in SOL, computed without simulating anything (owner 2026-10-12: "remove the
// simulate tx when launching"). Every figure is arithmetic on values that are fixed by the programs or
// read from chain with ordinary reads:
//   network fee of a transaction  = 5,000 lamports a signature + ceil(compute unit limit x unit price / 1e6)
//                                   (the priority fee is charged on the LIMIT, so it is known before sending);
//   rent of an account            = the cluster's rate x (128 + its size), the rate read once with
//                                   getMinimumBalanceForRentExemption(0); the sizes are the programs' own;
//   the SOL that buys $UNITS      = pump.fun's curve arithmetic on the curve as read (pump.ts);
//   the units account, the tip    = Core's price and the tip as built.
// The compute unit limits live here, in one place. They are measured, with headroom: the simulation
// used to be what sized them.
//
// Measured (compute units consumed):
//   mainnet, 2026-10-12, the TEST launch TBASALT: transaction 1 (launch + soul) 252,060; transaction 2
//     (SOL to $UNITS + initial buy + credits + tip) 187,338. Per instruction, from its logs: create_v2
//     138,314, register_pump_launch 99,259, set_profile 14,187; create account 17,116, buy_v3 50,631;
//     two create accounts 17,215 and 24,717, buy_v3 60,593; transfer 2,441, refresh_awake 14,175;
//     a system transfer 150; the two compute budget instructions 300.
//   mainnet fork, scripts/mainnet/GOLIVE-FORK-LAST.json: 247,862 and 193,348.
//   mainnet, 2026-10-12, a launch built by the page and simulated by scripts/mainnet/live-launch.ts
//     (dry, never sent; a 75 byte metadata URI): transaction 1 274,328.
// A program derived address search costs more or less by the address, and the strings are copied
// into accounts, so the same instruction moved by 26,000 units between these launches: each
// transaction's limit is about 1.6 times the largest measurement.
import type { Address } from "./codec.ts";
import { launchSolCosts, type LaunchSolCosts, type LaunchUnitsCosts } from "./launch-bundle.ts";

/** Compute unit limit of each instruction group of a launch (apps/web/wallet/main.ts names the groups). */
export const LAUNCH_CU: Record<string, number> = {
  launch: 420_000, // create_v2 + register_pump_launch: 237,573 measured on the launch that landed, about 260,000 on the largest
  soul: 28_000, // set_profile: 14,187
  "sol-to-units": 120_000, // create account + buy_v3: 67,747
  "initial-buy": 190_000, // two create accounts + buy_v3: 102,525
  credits: 35_000, // transfer + refresh_awake: 16,616
  "units-account": 1_000, // a system transfer: 150
  tip: 1_000, // a system transfer: 150
  // not measured on mainnet (both features are off there): an allowance, not a measurement
  "fee-route": 150_000,
  pool: 150_000,
};
/**
 * The SOL purchase on $UNITS's PumpSwap pool (create the $UNITS account, a temporary wrapped SOL account,
 * buy_v2, close): 93,807 measured on the mainnet fork with the real $UNITS pool cloned, both the $UNITS
 * account and the PumpSwap volume account made (scripts/mainnet/POOL-LAUNCH-FORK-LAST.json, 2026-10-12).
 */
export const LAUNCH_CU_POOL_PURCHASE = 160_000;
const CU_UNKNOWN_GROUP = 150_000;
const CU_BUDGET_IXS = 1_000;
export const CU_MAX = 1_400_000;

/** The compute unit limit of a transaction carrying these groups. `purchase`: where the SOL purchase runs ($UNITS's curve, or its PumpSwap pool once migrated). */
export function launchTxUnits(groups: string[], purchase: "curve" | "pool" = "curve"): number {
  const of = (g: string) => (g === "sol-to-units" && purchase === "pool" ? LAUNCH_CU_POOL_PURCHASE : (LAUNCH_CU[g] ?? CU_UNKNOWN_GROUP));
  return Math.min(CU_MAX, CU_BUDGET_IXS + groups.reduce((n, g) => n + of(g), 0));
}

export const LAMPORTS_PER_SIGNATURE = 5_000n;
/** The network fee of a transaction: known before it is sent, since the priority fee is charged on the limit. */
export function txFeeLamports(signatures: number, units: number, microLamportsPerUnit: number): bigint {
  const micro = BigInt(units) * BigInt(Math.max(0, Math.trunc(microLamportsPerUnit)));
  return LAMPORTS_PER_SIGNATURE * BigInt(signatures) + (micro + 999_999n) / 1_000_000n;
}

/** Account sizes in bytes (read from mainnet and devnet accounts on 2026-10-12; the programs fix them). */
export const LAUNCH_SIZES = {
  /** a Token-2022 mint with the metadata pointer and the metadata itself, before the name, symbol and URI */
  mintFixed: 318,
  /** pump.fun's bonding curve */
  pumpCurve: 166,
  /** pump.fun's per-wallet volume account, made on a wallet's first buy */
  pumpUserVolume: 137,
  /** PumpSwap's per-wallet volume account, made on a wallet's first pool trade (read on the mainnet fork, 2026-10-12) */
  pumpAmmUserVolume: 137,
  /** an associated Token-2022 account (with the immutable owner extension) */
  ata: 170,
  /** a Token-2022 account a program creates at its own address */
  tokenAccount: 165,
  agentLaunch: 554,
  agentRecord: 401,
  feeRoute: 97,
  claimEscrow: 114,
  pool: 675,
  poolMember: 195,
} as const;

const bytes = (s: string) => new TextEncoder().encode(s).length;
/** The size of the coin's mint account: pump.fun's create_v2 writes the name, symbol and URI into it. */
export const mintSize = (name: string, symbol: string, uri: string) => LAUNCH_SIZES.mintFixed + bytes(name) + bytes(symbol) + bytes(uri);

/** Rent-exempt lamports of an account of `size` bytes; `rent0` is getMinimumBalanceForRentExemption(0) (128 bytes of account header). */
export const rentLamports = (size: number, rent0: bigint) => (rent0 * BigInt(128 + size)) / 128n;

/** An account a launch pays the rent of. `address` set: created only when it does not exist yet (the caller reads it). */
export interface LaunchCreate {
  what: string;
  size: number;
  group: string;
  address?: Address;
}

/**
 * Every account the launch creates, by instruction group. Accounts keyed by the new agent or the new
 * mint are always new; the rest carry their address and are charged only when absent.
 */
export function launchCreates(o: {
  name: string;
  symbol: string;
  uri: string;
  /** the launcher's $UNITS account and pump.fun volume account (the SOL purchase creates them when missing); omitted when no purchase runs on the curve */
  purchase?: { launcherLine: Address; launcherVolume: Address; venue?: "curve" | "pool" };
  /**
   * the initial buy: the agent treasury's account is always new; the buyback recipient's account only when the builder adds its create;
   * `launcherVolume`: the launcher's pump.fun volume account, named when no SOL purchase runs before the buy (the buy is then the
   * wallet's first pump.fun curve trade of the launch and creates it when missing)
   */
  buy?: { createsBuyback: boolean; launcherVolume?: Address };
  feeRoute?: { escrow: Address; vault: Address };
  pool?: { pool: Address; vault: Address };
}): LaunchCreate[] {
  const S = LAUNCH_SIZES;
  const out: LaunchCreate[] = [
    { what: "the coin's mint", size: mintSize(o.name, o.symbol, o.uri), group: "launch" },
    { what: "pump.fun's curve", size: S.pumpCurve, group: "launch" },
    { what: "the curve's coin account", size: S.ata, group: "launch" },
    { what: "the curve's $UNITS account", size: S.ata, group: "launch" },
    { what: "the launch record", size: S.agentLaunch, group: "launch" },
    { what: "the agent's compute vault", size: S.tokenAccount, group: "launch" },
    { what: "the agent's registry record", size: S.agentRecord, group: "launch" },
  ];
  if (o.purchase) {
    out.push({ what: "your $UNITS account", size: S.ata, group: "sol-to-units", address: o.purchase.launcherLine });
    out.push(o.purchase.venue === "pool"
      ? { what: "your PumpSwap volume account", size: S.pumpAmmUserVolume, group: "sol-to-units", address: o.purchase.launcherVolume }
      : { what: "your pump.fun volume account", size: S.pumpUserVolume, group: "sol-to-units", address: o.purchase.launcherVolume });
  }
  if (o.buy) {
    out.push({ what: "the agent's coin account", size: S.ata, group: "initial-buy" });
    if (o.buy.createsBuyback) out.push({ what: "pump.fun's buyback $UNITS account", size: S.ata, group: "initial-buy" });
    if (o.buy.launcherVolume && (!o.purchase || o.purchase.venue === "pool")) out.push({ what: "your pump.fun volume account", size: S.pumpUserVolume, group: "initial-buy", address: o.buy.launcherVolume });
  }
  if (o.feeRoute) {
    out.push({ what: "the fee route", size: S.feeRoute, group: "fee-route" });
    out.push({ what: "the GitHub account's escrow", size: S.claimEscrow, group: "fee-route", address: o.feeRoute.escrow });
    out.push({ what: "the escrow's $UNITS account", size: S.tokenAccount, group: "fee-route", address: o.feeRoute.vault });
  }
  if (o.pool) {
    out.push({ what: "the pool membership", size: S.poolMember, group: "pool" });
    out.push({ what: "the repository pool", size: S.pool, group: "pool", address: o.pool.pool });
    out.push({ what: "the pool's $UNITS account", size: S.ata, group: "pool", address: o.pool.vault });
  }
  return out;
}

export interface LaunchCostTx {
  groups: string[];
  signatures: number;
  units: number;
  /** micro-lamports a compute unit, the price the transaction is sent with */
  price: number;
}
export interface LaunchCostDetail {
  costs: LaunchSolCosts;
  /** network fee of each transaction, in order */
  fees: bigint[];
  /** the accounts whose rent the launcher pays, with the lamports */
  rents: { what: string; group: string; size: number; lamports: bigint }[];
  rent: bigint;
}

/**
 * The cost lines. `existing`: the addresses among the conditional creates that already exist.
 * `purchase`: the SOL the curve asks for the whole $UNITS amount and for the credits' part of it
 * (pump.fun's arithmetic); `headroom`: what the purchase may cost above that (its slippage bound).
 */
export function launchCostDetail(o: {
  txs: LaunchCostTx[];
  rent0: bigint;
  creates: LaunchCreate[];
  existing: Set<Address>;
  purchase: { whole: bigint; credits: bigint } | null;
  hasBuy: boolean;
  identity: bigint;
  tip?: bigint;
  headroom?: bigint;
  /** the launch buys no $UNITS: the credits and the initial buy come from the launcher's own $UNITS (no SOL line for either) */
  units?: LaunchUnitsCosts;
}): LaunchCostDetail {
  const present = new Set(o.txs.flatMap((t) => t.groups));
  const rents = o.creates
    .filter((c) => present.has(c.group) && !(c.address && o.existing.has(c.address)))
    .map((c) => ({ what: c.what, group: c.group, size: c.size, lamports: rentLamports(c.size, o.rent0) }));
  const rent = rents.reduce((n, r) => n + r.lamports, 0n);
  const fees = o.txs.map((t) => txFeeLamports(t.signatures, t.units, t.price));
  if (o.units && o.purchase) throw new Error("a launch either buys $UNITS with SOL or takes it from the wallet, not both");
  const whole = o.purchase?.whole ?? 0n;
  const credits = o.hasBuy ? (o.purchase?.credits ?? 0n) : whole;
  const costs = launchSolCosts({ creation: fees.reduce((n, f) => n + f, 0n) + rent, credits, buy: o.units ? null : o.hasBuy ? whole - credits : null, identity: o.identity, tip: o.tip,
    headroom: o.headroom, units: o.units });
  return { costs, fees, rents, rent };
}
