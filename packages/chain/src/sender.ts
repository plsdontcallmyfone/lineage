import type { Ix } from "./registry.ts";
import type { Rpc } from "./rpc.ts";
import { buildTransaction, computeBudget, type Signer } from "./tx.ts";

// Sign, send, confirm. A transaction is simulated first (so a program error comes back with its
// logs and nothing is paid), then sent and rebroadcast until it lands or its blockhash expires; on
// expiry it is rebuilt with a fresh blockhash, at most `attempts` times. A signature that is seen
// with an error is never resent.

export interface SendOptions {
  /** Signers besides the payer (agent keys, fresh mints, config keypairs). */
  signers?: Signer[];
  /** Compute unit limit; adds a ComputeBudget instruction. */
  computeUnits?: number;
  /** Priority fee in micro-lamports per compute unit. */
  priorityMicroLamports?: number;
  /** Blockhash rebuilds after expiry. */
  attempts?: number;
  /** Skip the preflight simulation. */
  skipSimulation?: boolean;
  rebroadcastMs?: number;
  log?: (m: string) => void;
}

export class TxError extends Error {
  constructor(
    message: string,
    readonly logs: string[] = [],
    readonly signature?: string,
  ) {
    super(message);
  }
}

export interface SendResult {
  signature: string;
  slot: number;
  /** Fee paid in lamports, when the RPC returned the transaction. */
  fee?: number;
  computeUnits?: number;
  logs: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function withBudget(ixs: Ix[], o: SendOptions): Ix[] {
  const pre: Ix[] = [];
  if (o.computeUnits) pre.push(computeBudget.limit(o.computeUnits));
  if (o.priorityMicroLamports) pre.push(computeBudget.price(o.priorityMicroLamports));
  return [...pre, ...ixs];
}

export async function sendAndConfirm(rpc: Rpc, payer: Signer, ixs: Ix[], o: SendOptions = {}): Promise<SendResult> {
  const all = withBudget(ixs, o);
  const attempts = o.attempts ?? 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
    const tx = buildTransaction(payer, all, blockhash, o.signers ?? []);
    if (!o.skipSimulation) {
      const sim = await rpc.simulate(tx.wire);
      if (sim.err) throw new TxError(`simulation failed: ${JSON.stringify(sim.err)}`, sim.logs ?? []);
    }
    await rpc.sendRawTransaction(tx.wire, true);
    o.log?.(`sent ${tx.signature} (attempt ${attempt})`);
    let lastSend = Date.now();
    for (;;) {
      await sleep(800);
      const [st] = await rpc.getSignatureStatuses([tx.signature]);
      if (st?.err) {
        const t = await rpc.getTransaction(tx.signature).catch(() => null);
        throw new TxError(`transaction failed: ${JSON.stringify(st.err)}`, t?.meta?.logMessages ?? [], tx.signature);
      }
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
        const t = await rpc.getTransaction(tx.signature).catch(() => null);
        return { signature: tx.signature, slot: st.slot, fee: t?.meta?.fee, computeUnits: t?.meta?.computeUnitsConsumed, logs: t?.meta?.logMessages ?? [] };
      }
      if ((await rpc.getBlockHeight()) > lastValidBlockHeight) {
        // one last look: it may have landed in the final blocks
        const [late] = await rpc.getSignatureStatuses([tx.signature]);
        if (late && !late.err) continue;
        o.log?.(`blockhash expired for ${tx.signature}; rebuilding`);
        break;
      }
      if (Date.now() - lastSend > (o.rebroadcastMs ?? 2500)) {
        await rpc.sendRawTransaction(tx.wire, true).catch(() => undefined);
        lastSend = Date.now();
      }
    }
  }
  throw new TxError(`not confirmed after ${attempts} blockhashes`);
}
