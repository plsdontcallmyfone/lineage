import { base58Decode } from "@units/protocol";
import type { Address } from "./codec.ts";
import { launchPdas } from "./launch.ts";
import { SYSTEM_PROGRAM } from "./pda.ts";
import type { Ix } from "./registry.ts";
import type { Rpc } from "./rpc.ts";
import { compileMessage, PACKET_LIMIT } from "./tx.ts";
import { compileMessageV0, wireSize, type LookupTable } from "./v0.ts";

// One approval for the whole deployment (owner direction 2026-10-11): the launch is composed of
// ordered instruction groups (create_v2 + register_pump_launch, the soul, SOL to $UNITS, the initial
// buy, the credits deposit + wake, the units account payment, a Jito tip on mainnet). Measured in
// packages/chain/test/launch-bundle.test.ts: they cannot fit one 1232-byte transaction (create_v2 +
// register alone take 1,025 bytes as v0 with the launch lookup table for typical strings, the whole
// launch about 1,680), so the groups are packed in order, greedily, into the fewest transactions
// (in-order greedy packing is optimal for a fixed order), each legacy when it fits, else v0. The
// wallet signs them all in one request; mainnet sends them as one Jito bundle (all or nothing),
// devnet in order.

export interface BundleGroup {
  name: string;
  ixs: Ix[];
}
export interface BundleTx {
  ixs: Ix[];
  groups: string[];
  /** set when the transaction is a v0 message reading this lookup table */
  table: LookupTable | null;
  size: number;
}

const FAKE_BLOCKHASH = "11111111111111111111111111111111";

/** Packs `groups` in order into the fewest transactions of at most PACKET_LIMIT bytes (each group stays whole), at most `maxTxs`. */
export function planLaunchBundle(o: { payer: Address; groups: BundleGroup[]; budget: Ix[]; table: LookupTable | null; v0: boolean; maxTxs?: number }): BundleTx[] {
  const legacy = (ixs: Ix[]) => {
    const m = compileMessage(o.payer, [...o.budget, ...ixs], FAKE_BLOCKHASH);
    return wireSize({ bytes: m.bytes, numSigners: m.numSigners });
  };
  const fit = (ixs: Ix[]): Omit<BundleTx, "groups"> | null => {
    const l = legacy(ixs);
    if (l <= PACKET_LIMIT) return { ixs, table: null, size: l };
    if (!o.v0 || !o.table) return null;
    const s = wireSize(compileMessageV0(o.payer, [...o.budget, ...ixs], FAKE_BLOCKHASH, [o.table]));
    return s <= PACKET_LIMIT ? { ixs, table: o.table, size: s } : null;
  };
  const out: BundleTx[] = [];
  let cur: { ixs: Ix[]; groups: string[] } = { ixs: [], groups: [] };
  for (const g of o.groups.filter((x) => x.ixs.length)) {
    const joined = [...cur.ixs, ...g.ixs];
    if (cur.groups.length && fit(joined)) {
      cur = { ixs: joined, groups: [...cur.groups, g.name] };
      continue;
    }
    if (cur.groups.length) out.push({ ...fit(cur.ixs)!, groups: cur.groups });
    if (!fit(g.ixs))
      throw new Error(`${g.name} alone is ${legacy(g.ixs)} bytes, over the ${PACKET_LIMIT}-byte packet limit${o.v0 && o.table ? " even as v0 with the lookup table" : " (and no v0 lookup table is usable)"}`);
    cur = { ixs: g.ixs, groups: [g.name] };
  }
  if (cur.groups.length) out.push({ ...fit(cur.ixs)!, groups: cur.groups });
  const max = o.maxTxs ?? 5;
  if (out.length > max) throw new Error(`the launch needs ${out.length} transactions, more than ${max}`);
  return out;
}

// ---------- the SOL a launcher pays ----------

/**
 * Every figure in lamports. `creation`: network fees of every transaction plus the rent deposits the
 * launch pays (accounts it creates); `credits` and `buy`: the SOL spent on $UNITS for the credits
 * deposit and for the 1% initial buy; `identity`: the units account price (0 when not chosen);
 * `tip`: the Jito tip (mainnet). `headroom`: what the SOL purchase may cost above its quote (its
 * slippage bound), held in the wallet but not spent at the quote.
 */
export interface LaunchSolCosts {
  creation: bigint;
  credits: bigint;
  buy: bigint | null;
  identity: bigint;
  tip: bigint;
  headroom: bigint;
  total: bigint;
  /** what the wallet must hold: total plus headroom */
  needed: bigint;
}
export function launchSolCosts(o: { creation: bigint; credits: bigint; buy: bigint | null; identity: bigint; tip?: bigint; headroom?: bigint }): LaunchSolCosts {
  const tip = o.tip ?? 0n, headroom = o.headroom ?? 0n;
  const total = o.creation + o.credits + (o.buy ?? 0n) + o.identity + tip;
  return { creation: o.creation, credits: o.credits, buy: o.buy, identity: o.identity, tip, headroom, total, needed: total + headroom };
}
/** Why the wallet cannot pay, or null. */
export function solShortfall(c: LaunchSolCosts, lamports: bigint | null): string | null {
  if (lamports === null) return "the wallet's SOL balance is not read yet";
  if (lamports < c.needed) return `the wallet holds ${fmtSol(lamports)} SOL; the launch needs ${fmtSol(c.needed)} SOL`;
  return null;
}
const fmtSol = (l: bigint) => {
  const f = (l % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return `${l / 1_000_000_000n}${f ? `.${f}` : ""}`;
};

/** The SOL a curve buy of an exact amount costs at most: ceil(quote x (10,000 + bps) / 10,000). */
export const maxSolIn = (quote: bigint, bps: number) => (quote * BigInt(10_000 + bps) + 9_999n) / 10_000n;

// ---------- the units account payment ----------

/** One transaction as the identity service and Core read it (getTransaction, json encoding, v0 lookups resolved into `keys`). */
export interface LaunchTxView {
  signature: string;
  /** account keys in message order, then the loaded writable and read-only addresses */
  keys: Address[];
  instructions: { programIdIndex: number; accounts: number[]; data: Uint8Array }[];
  err: unknown;
}

/** The lamports `payer` sent `recipient` by top-level System transfers in these transactions (fee payer must be `payer`). */
export function identityPaymentIn(txs: LaunchTxView[], o: { payer: Address; recipient: Address }): { lamports: bigint; signatures: string[] } {
  let lamports = 0n;
  const signatures: string[] = [];
  for (const t of txs) {
    if (t.err || t.keys[0] !== o.payer) continue;
    for (const ix of t.instructions) {
      if (t.keys[ix.programIdIndex] !== SYSTEM_PROGRAM || ix.data.length !== 12) continue;
      const v = new DataView(ix.data.buffer, ix.data.byteOffset, 12);
      if (v.getUint32(0, true) !== 2) continue;
      if (t.keys[ix.accounts[0]!] !== o.payer || t.keys[ix.accounts[1]!] !== o.recipient) continue;
      lamports += v.getBigUint64(4, true);
      if (!signatures.includes(t.signature)) signatures.push(t.signature);
    }
  }
  return { lamports, signatures };
}

interface TxJson {
  transaction: { message: { accountKeys: string[]; instructions: { programIdIndex: number; accounts: number[]; data: string }[] } };
  meta: { err: unknown; postTokenBalances?: { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }[]; loadedAddresses?: { writable: string[]; readonly: string[] } } | null;
}

/**
 * The launch's transactions: the oldest successful transactions naming its AgentLaunch account, paid
 * by the launcher, at most `max` (a launch is sent as up to five transactions in one approval). Oldest
 * first, with the raw JSON for callers that read token balances.
 */
export async function launchBundleTxs(rpc: Rpc, o: { mint: Address; launcher: Address; max?: number }): Promise<(LaunchTxView & { json: TxJson })[]> {
  const sigs = await rpc.call<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [launchPdas.agentLaunch(o.mint), { limit: 1000, commitment: "confirmed" }]);
  const ok = sigs.filter((s) => !s.err).reverse().slice(0, o.max ?? 5);
  const out: (LaunchTxView & { json: TxJson })[] = [];
  for (const s of ok) {
    const t = await rpc.call<TxJson | null>("getTransaction", [s.signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
    if (!t?.meta || t.meta.err) continue;
    const keys = [...t.transaction.message.accountKeys, ...(t.meta.loadedAddresses?.writable ?? []), ...(t.meta.loadedAddresses?.readonly ?? [])];
    if (keys[0] !== o.launcher) continue;
    out.push({ signature: s.signature, keys, err: null, json: t,
      instructions: t.transaction.message.instructions.map((ix) => ({ programIdIndex: ix.programIdIndex, accounts: ix.accounts, data: base58Decode(ix.data) })) });
  }
  return out;
}

/** Groups of a launch with no marker of their own on chain: they count as done with the other groups of their transaction. */
export const UNMARKED_GROUPS = ["sol-to-units", "units-account", "tip"];

/**
 * The transactions of a launch plan that still have to be sent (pressing Launch again after a launch
 * that stopped half way, for example the first transaction landed and the second did not): a
 * transaction is left out when what it carries is on chain. `onChain(group)` reads the chain for a
 * group that leaves a marker (the AgentLaunch, the soul digest, the vault's credits, the initial buy);
 * a transaction made only of unmarked groups is done when this page saw it land (`landed`).
 */
export async function partsToSend<T extends { groups: string[] }>(plan: T[], onChain: (group: string) => Promise<boolean>, landed: string[]): Promise<T[]> {
  const todo: T[] = [];
  for (const t of plan) {
    const marked = t.groups.filter((g) => !UNMARKED_GROUPS.includes(g));
    const done = marked.length ? (await Promise.all(marked.map(onChain))).every(Boolean) : t.groups.every((g) => landed.includes(g));
    if (!done) todo.push(t);
  }
  return todo;
}
