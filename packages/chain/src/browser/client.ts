// What a page needs from the RPC beyond packages/chain's Rpc: the cluster gate (genesis hash), a
// simulation that returns the post-state of chosen accounts (so the rent a wallet pays is read from
// the simulation, not estimated), the network fee of a message, and send-and-confirm of a wire
// transaction someone else signed.
import type { Address } from "../codec.ts";
import type { Rpc } from "../rpc.ts";
import { base64Decode, base64Encode } from "./buffer.ts";
import { decodeMessage, parseWire, wireSignature } from "./wire.ts";

/** Genesis hash of Solana devnet. This milestone builds transactions for devnet only. */
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const KNOWN_GENESIS: Record<string, string> = {
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: "devnet",
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d": "mainnet-beta",
  "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY": "testnet",
};

export class ClusterError extends Error {}

/** Throws unless the RPC answers with devnet's genesis hash. Returns the cluster name. */
export async function assertDevnet(rpc: Rpc): Promise<string> {
  const g = await rpc.call<string>("getGenesisHash", []);
  if (g !== DEVNET_GENESIS) throw new ClusterError(`RPC genesis ${g} is ${KNOWN_GENESIS[g] ?? "an unknown cluster"}, not devnet: refusing to build transactions`);
  return "devnet";
}

export interface SimAccount {
  address: Address;
  writable: boolean;
  signer: boolean;
  before: bigint | null;
  after: bigint | null;
  owner: Address | null;
  /** Account did not exist before and does after: its lamports are the rent deposit. */
  created: boolean;
  /** Account data before and after the simulated transaction. */
  dataBefore: Uint8Array | null;
  dataAfter: Uint8Array | null;
}
export interface Simulation {
  err: unknown;
  logs: string[];
  unitsConsumed?: number;
  accounts: SimAccount[];
  /** Network fee of the message in lamports (getFeeForMessage). */
  fee: bigint | null;
}

/** Simulates `wire` (signatures not verified) and reads every account of the message before and after. */
export async function simulateDetailed(rpc: Rpc, wire: Uint8Array, tables?: Map<string, string[]>): Promise<Simulation> {
  const { message } = parseWire(wire);
  // a v0 message lists its lookup-table accounts too, resolved from `tables` (read from chain by the caller)
  const d = decodeMessage(message, tables);
  if (d.keys.some((k) => k.includes("#"))) throw new Error("a lookup table this message reads was not supplied");
  const meta = d.keys.map((k, i) => ({ address: k, signer: i < d.numSigners, writable: d.writable[i]! }));
  const before = await rpc.getMultipleAccounts(d.keys);
  const r = await rpc.call<{ value: { err: unknown; logs: string[] | null; unitsConsumed?: number; accounts: ({ lamports: number; owner: string; data: [string, string] } | null)[] | null } }>(
    "simulateTransaction",
    [base64Encode(wire), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: false, commitment: rpc.commitment, accounts: { encoding: "base64", addresses: d.keys } }],
  );
  const fee = await rpc
    .call<{ value: number | null }>("getFeeForMessage", [base64Encode(message), { commitment: rpc.commitment }])
    .then((x) => (x.value === null ? null : BigInt(x.value)))
    .catch(() => null);
  const after = r.value.accounts ?? [];
  return {
    err: r.value.err,
    logs: r.value.logs ?? [],
    unitsConsumed: r.value.unitsConsumed,
    fee,
    accounts: meta.map((m, i) => {
      const b = before[i] ? before[i]!.lamports : null;
      const a = after[i] ? BigInt(after[i]!.lamports) : null;
      return { ...m, before: b, after: a, owner: after[i]?.owner ?? before[i]?.owner ?? null, created: b === null && a !== null && a > 0n,
        dataBefore: before[i]?.data ?? null, dataAfter: after[i] ? base64Decode(after[i]!.data[0]) : null };
    }),
  };
}

export interface Confirmed {
  signature: string;
  slot: number;
  fee?: number;
  err: unknown;
  logs: string[];
}

/**
 * Sends a fully signed wire transaction and polls until it is confirmed, fails, or its blockhash
 * expires (rebroadcasting meanwhile). A transaction that lands with an error is reported, never resent.
 */
export async function sendWire(rpc: Rpc, wire: Uint8Array, lastValidBlockHeight: number, onStatus?: (s: string) => void): Promise<Confirmed> {
  const signature = wireSignature(wire);
  const b64 = base64Encode(wire);
  const send = () => rpc.call<string>("sendTransaction", [b64, { encoding: "base64", skipPreflight: true, maxRetries: 0 }]);
  await send();
  onStatus?.(`sent ${signature}`);
  let last = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 900));
    const [st] = await rpc.getSignatureStatuses([signature]);
    if (st && (st.err || st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
      const t = await rpc.getTransaction(signature).catch(() => null);
      return { signature, slot: st.slot, fee: t?.meta?.fee, err: st.err, logs: t?.meta?.logMessages ?? [] };
    }
    if ((await rpc.getBlockHeight()) > lastValidBlockHeight) {
      const [late] = await rpc.getSignatureStatuses([signature]);
      if (late) continue;
      throw new Error(`blockhash expired before ${signature} landed; nothing was charged. Build and sign again.`);
    }
    if (Date.now() - last > 2500) {
      await send().catch(() => undefined);
      last = Date.now();
      onStatus?.(`waiting for confirmation of ${signature}`);
    }
  }
}

export const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const explorerAddress = (a: Address) => `https://explorer.solana.com/address/${a}?cluster=devnet`;
