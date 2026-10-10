// Shared pieces of the mainnet fork rehearsal (M1, M2). Talks to the local fork validator only
// (scripts/mainnet/fork.sh, RPC 127.0.0.1:9690) and refuses any other endpoint for sends. Mainnet is
// read, never written: the rent figures come from mainnet's own getMinimumBalanceForRentExemption.
// Keys are throwaway keypairs in MAINNET_FORK_KEYS (outside the repo); they never hold real SOL and
// are never printed.
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  compileMessageV0,
  computeBudget,
  loadOrCreateKeypair,
  lookupTable,
  signMessageWith,
  wireSize,
  type LookupTable,
  Rpc,
  sendAndConfirm,
  TxError,
  type Ix,
  type SendOptions,
  type SendResult,
  type Signer,
} from "@lineage/chain";

export const FORK_URL = "http://127.0.0.1:9690";
export const MAINNET_URL = process.env.LINEAGE_MAINNET_RPC || "https://api.mainnet-beta.solana.com";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

export const fork = Rpc.http(FORK_URL, "confirmed");
export const mainnet = Rpc.http(MAINNET_URL, "confirmed");

export const KEYS = process.env.MAINNET_FORK_KEYS ?? "";
/** A throwaway key in MAINNET_FORK_KEYS, created (mode 600) on first use. */
export function forkKey(name: string): Signer {
  if (!KEYS || !existsSync(KEYS)) throw new Error("set MAINNET_FORK_KEYS to a directory of throwaway keys outside the repo");
  return loadOrCreateKeypair(join(KEYS, `${name}.json`)).key;
}

/** Refuses to continue unless the send endpoint is the local fork (its genesis is not mainnet's). */
export async function assertFork(): Promise<void> {
  const g = await fork.call<string>("getGenesisHash");
  if (g === MAINNET_GENESIS || !FORK_URL.startsWith("http://127.0.0.1:")) throw new Error("refusing: the send endpoint is not a local fork");
}

export const sol = (l: bigint) => (Number(l) / 1e9).toFixed(9);
export const log = (m: string) => console.log(`[fork] ${m}`);

// ---------------------------------------------------------------- rent at both rates

const rentCache = new Map<string, bigint>();
async function rentOf(rpc: Rpc, tag: string, size: number): Promise<bigint> {
  const k = `${tag}:${size}`;
  if (!rentCache.has(k)) rentCache.set(k, await rpc.getMinimumBalanceForRentExemption(size));
  return rentCache.get(k)!;
}
export const forkRent = (size: number) => rentOf(fork, "fork", size);
/** Mainnet's own rent-exempt minimum for `size` bytes (read-only RPC call). */
export const mainnetRent = (size: number) => rentOf(mainnet, "mainnet", size);

// ---------------------------------------------------------------- the cost ledger

export interface CostRow {
  step: string;
  what: string;
  signature: string;
  payer: string;
  /** Network fee in lamports (base fee per signature; no priority fee is set on the fork). */
  fee: number;
  computeUnits: number | null;
  signatures: number;
  /** Accounts the transaction created: address, data bytes, rent at the fork and at mainnet rates. */
  created: { address: string; bytes: number; forkRent: string; mainnetRent: string }[];
  /** Lamports the payer's balance fell by on the fork. */
  payerDeltaFork: string;
  /** What the same transaction costs the payer on mainnet: fee + its share of the created rent at mainnet rates + other outflows. */
  payerMainnet: string;
  /** Payer outflow that is neither fee nor rent (transfers, program fees), at face value. */
  other: string;
}
export const rows: CostRow[] = [];
export const checks: { name: string; ok: boolean; detail: string }[] = [];

export function check(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`[fork] ${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) throw new Error(`check failed: ${name}`);
}

interface TxJson {
  meta: { fee: number; preBalances: number[]; postBalances: number[]; computeUnitsConsumed?: number; loadedAddresses?: { writable: string[]; readonly: string[] } };
  transaction: { message: { accountKeys: string[]; header: { numRequiredSignatures: number } }; signatures: string[] };
}

/** Reads a landed transaction back and records its exact cost (the payer is account index 0). */
export async function measure(step: string, what: string, signature: string): Promise<CostRow> {
  const t = await fork.call<TxJson>("getTransaction", [signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
  const keys = [...t.transaction.message.accountKeys, ...(t.meta.loadedAddresses?.writable ?? []), ...(t.meta.loadedAddresses?.readonly ?? [])];
  const created: CostRow["created"] = [];
  let forkCreated = 0n, mainCreated = 0n;
  for (let i = 0; i < keys.length; i++) {
    if (t.meta.preBalances[i] === 0 && t.meta.postBalances[i]! > 0) {
      const a = await fork.getAccountInfo(keys[i]!);
      const bytes = a?.data.length ?? 0;
      const fr = await forkRent(bytes), mr = await mainnetRent(bytes);
      forkCreated += fr;
      mainCreated += mr;
      created.push({ address: keys[i]!, bytes, forkRent: fr.toString(), mainnetRent: mr.toString() });
    }
  }
  const payerDelta = BigInt(t.meta.preBalances[0]! - t.meta.postBalances[0]!);
  const fee = BigInt(t.meta.fee);
  const rentPaid = payerDelta - fee;
  // The payer's share of the created rent (others, such as DBC's pool authority, may lend some).
  const share = forkCreated === 0n ? 0n : rentPaid < 0n ? 0n : rentPaid > forkCreated ? forkCreated : rentPaid;
  const other = rentPaid - share;
  const payerMainnet = fee + (forkCreated === 0n ? 0n : (mainCreated * share) / forkCreated) + other;
  const row: CostRow = {
    step, what, signature, payer: keys[0]!, fee: t.meta.fee, computeUnits: t.meta.computeUnitsConsumed ?? null,
    signatures: t.transaction.message.header.numRequiredSignatures, created, payerDeltaFork: payerDelta.toString(), payerMainnet: payerMainnet.toString(),
    other: other.toString(),
  };
  rows.push(row);
  return row;
}

/** Sends on the fork, confirms, measures. */
export async function send(step: string, what: string, payer: Signer, ixs: Ix[], o: SendOptions = {}): Promise<SendResult & { cost: CostRow }> {
  try {
    const r = await sendAndConfirm(fork, payer, ixs, { attempts: 2, ...o });
    const cost = await measure(step, what, r.signature);
    log(`${step}: ${what}: fee ${cost.fee}, payer mainnet ${sol(BigInt(cost.payerMainnet))} SOL${r.computeUnits ? `, ${r.computeUnits} CU` : ""}`);
    return { ...r, cost };
  } catch (e) {
    if (e instanceof TxError) {
      console.error(`[fork] ${step}: ${what} FAILED: ${e.message}`);
      for (const l of e.logs.slice(-25)) console.error(`    ${l}`);
    }
    throw e;
  }
}

/** Expects a send to fail (simulation refuses it); returns the error text. */
export async function refused(payer: Signer, ixs: Ix[], o: SendOptions = {}): Promise<string> {
  try {
    await sendAndConfirm(fork, payer, ixs, { attempts: 1, ...o });
  } catch (e) {
    return e instanceof TxError ? `${e.message} ${e.logs.filter((l) => /Error|error|failed/.test(l)).slice(-2).join(" | ")}` : String(e);
  }
  throw new Error("expected the transaction to be refused, but it landed");
}

export async function airdrop(to: string, lamports: bigint): Promise<void> {
  const sig = await fork.call<string>("requestAirdrop", [to, Number(lamports)]);
  for (let i = 0; i < 60; i++) {
    const [s] = await fork.getSignatureStatuses([sig]);
    if (s && !s.err && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`airdrop to ${to} not confirmed`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The fork's clock (unix seconds of the latest block). */
export async function forkNow(): Promise<number> {
  const slot = await fork.getSlot();
  return fork.call<number>("getBlockTime", [slot]);
}

// ---------------------------------------------------------------- v0 transactions (pump.fun launches)

/** Creates and extends an address lookup table on the fork (not frozen) and waits until it is usable. */
export async function forkTable(step: string, payer: Signer, addresses: string[]): Promise<LookupTable> {
  const slot = await fork.getSlot();
  const t = lookupTable.create({ authority: payer.id, payer: payer.id, recentSlot: slot - 1 });
  await send(step, `lookup table (${addresses.length} addresses)`, payer, [t.ix, lookupTable.extend({ table: t.address, authority: payer.id, payer: payer.id, addresses })]);
  const s0 = await fork.getSlot();
  while ((await fork.getSlot()) <= s0 + 1) await sleep(400);
  return { address: t.address, addresses };
}

/** Sends a v0 transaction on the fork (simulated first), confirms, measures. */
export async function sendV0(step: string, what: string, payer: Signer, ixs: Ix[], tables: LookupTable[], o: { signers?: Signer[]; computeUnits?: number } = {}): Promise<SendResult & { cost: CostRow; size: number }> {
  const all = o.computeUnits ? [computeBudget.limit(o.computeUnits), ...ixs] : ixs;
  const { blockhash } = await fork.getLatestBlockhash();
  const msg = compileMessageV0(payer.id, all, blockhash, tables);
  const tx = signMessageWith(msg, [payer, ...(o.signers ?? [])]);
  const size = wireSize(msg);
  if (size > 1232) throw new Error(`${step}: v0 transaction is ${size} bytes`);
  const sim = await fork.simulate(tx.wire);
  if (sim.err) {
    console.error(`[fork] ${step}: ${what} FAILED in simulation: ${JSON.stringify(sim.err)}`);
    for (const l of (sim.logs ?? []).slice(-25)) console.error(`    ${l}`);
    throw new TxError(`simulation failed: ${JSON.stringify(sim.err)}`, sim.logs ?? []);
  }
  await fork.sendRawTransaction(tx.wire, true);
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    if (i % 4 === 3) await fork.sendRawTransaction(tx.wire, true).catch(() => undefined);
    const [st] = await fork.getSignatureStatuses([tx.signature]);
    if (st?.err) throw new TxError(`transaction failed: ${JSON.stringify(st.err)}`, [], tx.signature);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
      const cost = await measure(step, what, tx.signature);
      log(`${step}: ${what}: v0 ${size} bytes, fee ${cost.fee}, payer mainnet ${sol(BigInt(cost.payerMainnet))} SOL, ${cost.computeUnits} CU`);
      return { signature: tx.signature, slot: st.slot, logs: [], cost, size, computeUnits: cost.computeUnits ?? undefined, fee: cost.fee };
    }
  }
  throw new TxError(`${step}: not confirmed`);
}
