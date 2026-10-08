import type { Rpc } from "./rpc.ts";

// Slot hash reads for the M2 assignment beacon (SPEC 10.3). Core anchors a draw at the cluster's
// current slot, waits for the first produced slot at or after `anchor + lag` to be finalized and
// takes that block's hash. Skipped slots have no block, so "the first produced slot at or after the
// target" is one answer for every reader; `blocksBetween` lets a verifier check that nothing was
// produced between the target and the slot Core used.

export interface SlotBlock {
  slot: number;
  /** base58 blockhash of the slot's block. */
  hash: string;
  /** Unix seconds as the cluster recorded it; null when the node does not know it. */
  blockTime: number | null;
}

/** The slot reads the beacon needs; `rpcSlotSource` implements it over JSON-RPC, tests fake it. */
export interface SlotSource {
  /** The cluster's current slot (confirmed): the anchor of a new draw. */
  tip(): Promise<number>;
  /** The first finalized block at or after `slot`, or null when none is finalized yet. */
  firstBlockAtOrAfter(slot: number): Promise<SlotBlock | null>;
}

const FINAL = { commitment: "finalized" } as const;

/** The block at exactly `slot` (finalized), or null if that slot was skipped or is not final yet. */
export async function blockAt(rpc: Rpc, slot: number): Promise<SlotBlock | null> {
  try {
    const b = await rpc.call<{ blockhash: string; blockTime: number | null } | null>("getBlock", [
      slot,
      { ...FINAL, transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0 },
    ]);
    return b ? { slot, hash: b.blockhash, blockTime: b.blockTime ?? null } : null;
  } catch (e) {
    // -32007 skipped slot, -32009 missing in long-term storage: no block at this slot
    const code = (e as { code?: number }).code;
    if (code === -32007 || code === -32009) return null;
    throw e;
  }
}

/** Finalized produced slots in [from, to] (inclusive). */
export async function blocksBetween(rpc: Rpc, from: number, to: number): Promise<number[]> {
  return rpc.call<number[]>("getBlocks", [from, to, FINAL]);
}

export function rpcSlotSource(rpc: Rpc): SlotSource {
  return {
    tip: () => rpc.call<number>("getSlot", [{ commitment: "confirmed" }]),
    async firstBlockAtOrAfter(slot) {
      const next = await rpc.call<number[]>("getBlocksWithLimit", [slot, 1, FINAL]);
      if (!next.length) return null;
      // a finalized slot's block can be briefly unavailable on a load-balanced RPC: null means retry
      return blockAt(rpc, next[0]!);
    },
  };
}
